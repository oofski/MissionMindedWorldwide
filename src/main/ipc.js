'use strict';

/**
 * IPC handlers — the bridge between the renderer UI and the local data layer.
 *
 * Role-based access control mirrors the permission matrix in the product map
 * (Admin / Doctor / Triage). Every protected channel checks the signed-in
 * user's role before touching data.
 */

const { ipcMain, dialog, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const pdf = require('./pdf');
const aftercare = require('./aftercare');
const updater = require('./updater');
const autoupdate = require('./autoupdate');
const cloud = require('./cloud');
const hub = require('./hub');
const lan = require('./lan');
const usb = require('./usb');
const xrayFolder = require('./xrayFolder');
const zipStore = require('./zipStore');
const xlsx = require('./xlsx');
const { clinicSheets } = require('./clinicSheets');
const reportExport = require('./reportExport');
const os = require('os');

let currentUser = null;
// Why the session was ended from outside it (see liveSession), so every call a
// screen still open on it makes says that, rather than "Please sign in first."
// Cleared by the next sign-in or sign-out.
let endedBecause = null;

// Role matrix — keys are IPC channels, values are roles allowed to call them.
const PERMS = {
  'users:list': ['admin'],
  'users:create': ['admin'],
  'users:update': ['admin'],
  'users:delete': ['admin'],
  'users:clearEventStaff': ['admin'],
  'cloud:disconnect': ['admin'],
  'data:reset': ['admin'],
  'events:create': ['admin'],
  'events:update': ['admin'],
  'events:setActive': ['admin'],
  'events:setState': ['admin'],
  'events:delete': ['admin'],
  'patients:delete': ['admin'],
  // 'registration' is a front-desk check-in role. patients:create is registered
  // raw (ungated, like the kiosk) so it can start check-ins; this list is the
  // documented intent.
  'patients:create': ['admin', 'doctor', 'triage', 'emt', 'registration'],
  'patients:newVisit': ['admin', 'doctor', 'triage', 'emt', 'registration'],
  // v0.0.15: 'patients:update' is gone. It replaced the whole medical and
  // dental history and the patient's name with no lock check, no validation
  // and no merge, and once Records stopped calling it, it served only as a way
  // around the section save below. The USB import calls db.updatePatient
  // directly, in this process; nothing in the renderer needs it.
  // v0.0.15: view and correct the patient's own answers at every station. Open
  // to every staff role here; which SECTION a role may change is checked in
  // the handler (db.SECTION_ROLES): the patient's details for all seven, the
  // medical and dental history for the clinical roles.
  'patients:updateSection': ['admin', 'registration', 'emt', 'triage', 'doctor', 'hygienist', 'checkout'],
  // registration opens the record from Arrivals to view and correct it.
  'patients:get': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  // A scanned wristband resolves to the same full record patients:get returns,
  // so it is gated the same way. Unlisted, ensure() let any caller through —
  // a signed-out kiosk session included — to the medical history, consents
  // and signatures. Every station that scans a band is one of these roles.
  'patients:findByCode': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'patients:list': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'patients:searchAll': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'],
  'patients:history': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'],
  'patients:incomplete': ['admin'],
  'patients:cleanupIncomplete': ['admin'],
  'patients:dismiss': ['admin', 'checkout'],
  'patients:move': ['admin'],
  'patients:audit': ['admin', 'doctor', 'checkout', 'hygienist'],
  'patients:records': ['admin', 'doctor'],
  'triage:save': ['admin', 'doctor', 'triage'],
  // The exit survey is taken at the desk as the patient leaves, so the
  // check-out role is the one that needs it. Admins and the clinical roles
  // can too, since a patient sometimes answers it at the chair. The front-desk
  // 'registration' role had it only for the household half registration used
  // to ask; since v0.0.15 registration asks no survey question (the kiosk's
  // legacy path saves inside db.createPatient, not over this channel).
  'survey:save': ['admin', 'checkout', 'doctor', 'triage', 'emt', 'hygienist'],
  'vitals:save': ['admin', 'doctor', 'triage', 'emt'],
  'patients:route': ['admin', 'doctor', 'triage', 'emt'],
  'treatment:save': ['admin', 'doctor', 'hygienist'],
  // Unlocking a signed-off record (reason required) and locking one are the
  // administrator's, like every other override of the flow.
  'treatment:unlock': ['admin'],
  'treatment:lock': ['admin'],
  'consent:setTeeth': ['admin', 'doctor'],
  'consent:add': ['admin', 'doctor'],
  'xray:add': ['admin', 'doctor', 'triage', 'emt'],
  'xray:setTooth': ['admin', 'doctor'],
  'xray:folderList': ['admin', 'doctor'],
  'xray:folderConfig': ['admin', 'doctor'],
  'xray:folderChoose': ['admin', 'doctor'],
  'xray:folderLock': ['admin', 'doctor'],
  'xray:folderDelete': ['admin', 'doctor'],
  'xray:deleteFile': ['admin', 'doctor'],
  'xray:get': ['admin', 'doctor', 'triage', 'emt', 'hygienist'],
  'xray:list': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'],
  'xray:delete': ['admin', 'doctor', 'triage', 'emt'],
  'report:export': ['admin', 'doctor'],
  // Supplies are clinic operations, not patient data. Admins manage the list;
  // anyone working a station can record what they took, because a count only
  // stays true if the person who used the last box can say so without hunting
  // for an administrator.
  'inventory:list': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'inventory:get': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'inventory:move': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'inventory:save': ['admin'],
  'inventory:delete': ['admin'],
  'inventory:chairUsage': ['admin', 'doctor'],
  'pdf:generate': ['admin', 'doctor', 'checkout'],
  'pdf:preview': ['admin', 'doctor', 'checkout'],
  'pdf:print': ['admin', 'doctor', 'checkout'],
  // The after-care sections for one patient, listed on the check-out screen
  // before printing — the same roles that can print them (pdf:*). No
  // hygienist screen asks for them, and the hygienist cannot print them.
  'aftercare:get': ['admin', 'doctor', 'checkout'],
  'record:exportUsb': ['admin', 'doctor'],
  'usb:list': ['admin', 'doctor', 'triage', 'emt', 'checkout'],
  'usb:load': ['admin', 'doctor', 'triage', 'checkout'],
  'usb:uploadCheckout': ['admin', 'doctor', 'triage', 'checkout'],
  'usb:clear': ['admin', 'doctor', 'triage', 'checkout'],
  'backup:run': ['admin'],
  'export:zip': ['admin'],
  'export:clinic': ['admin'],
  'import:clinic': ['admin'],
  'event:finish': ['admin'],
  'event:purge': ['admin'],
  'reports:archived': ['admin', 'doctor'],
  'reports:rollup': ['admin', 'doctor'],
  'reports:rebuild': ['admin'],
  'export:event': ['admin'],
  'audit:list': ['admin'],
  'cloud:config': ['admin'],
  'cloud:test': ['admin'],
  'cloud:status': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'cloud:syncNow': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'cloud:resync': ['admin'],
  // The connection code carries the clinic key, so it is the administrator's,
  // like the key itself. 'cloud:join' is deliberately NOT listed: it is the
  // sign-in screen's, used before anyone has signed in, and checks for itself
  // whether this computer may join without one (see its handler).
  'cloud:connectionCode': ['admin'],
  // v0.0.17, the clinic network: hosting it on this laptop — starting,
  // stopping, erasing, the firewall helper, and its status (its addresses,
  // the laptops connected) — is the administrator's, like connecting a
  // server. lan:scan is not listed, for the same reason as cloud:join — the
  // sign-in screen's Join lists the hosts it hears before anyone has signed
  // in — and its handler applies Join's own rule.
  'hub:status': ['admin'],
  'hub:start': ['admin'],
  'hub:stop': ['admin'],
  'hub:firewall': ['admin'],
  'patients:arrivalCheck': ['admin', 'registration', 'emt', 'triage', 'doctor', 'hygienist'],
  'patients:confirmArrival': ['admin', 'registration', 'emt', 'triage'],
  // update:* and app:version are open to any signed-in user (available in any view).
};

// The signed-in account can be deleted or turned off on another laptop, and
// that synced in, while somebody is still signed in to it here — Start fresh at
// the end of a clinic, with people still finishing charts. The session kept
// the old id, so their next save pointed at an account that no longer exists
// and failed with a bare "FOREIGN KEY constraint failed", and the edit was
// lost without a word of why (signing out failed the same way, on its audit
// line). So the account is looked up before each call, and if it is gone or
// turned off the session ends, and every gated call says why (ensure()).
// Its ROLE as well: the session kept the role it signed in with, so an
// administrator made a check-out volunteer on another laptop kept every
// administrator's power here — the staff list, making administrators, copying
// a password — until she signed out. A changed role ends the session too: the
// screens on show were built for the old one, and signing in again builds the
// new one's. A changed name is simply taken, for the audit lines that follow.
function liveSession() {
  if (!currentUser) return;
  const acct = db.sessionAccount(currentUser.id);
  if (acct && acct.active && acct.role === currentUser.role) { currentUser = acct; return; }
  currentUser = null;
  endedBecause = !acct
    ? 'Your account was removed on another computer — sign in again.'
    : !acct.active
      ? 'Your account was turned off — sign in again, or ask an administrator.'
      : 'Your role was changed — sign in again.';
}

function ensure(channel) {
  const allowed = PERMS[channel];
  if (!allowed) return; // open to any authenticated user
  if (!currentUser) throw new Error(endedBecause || 'Please sign in first.');
  if (!allowed.includes(currentUser.role)) {
    throw new Error('Your role does not have permission for this action.');
  }
}

// Wrap a handler so thrown errors return a clean { ok:false, error } shape.
function handle(channel, fn, { requireAuth = true } = {}) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      if (requireAuth && channel !== 'auth:login' && !currentUser && PERMS[channel] !== undefined) {
        // protected channels need a user
      }
      liveSession();
      ensure(channel);
      const result = await fn(...args);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function register(getMainWindow) {
  /* ---- Auth ---- */
  // First-run setup. These two are reachable without signing in — by
  // definition there is no account yet — so they are left out of PERMS. The
  // real protection is in db.createFirstAdmin, which refuses outright once any
  // account exists, so this can never become a way to add a second admin.
  // defaultAdmin rides along so the sign-in screen can name the shipped
  // credential while it is still live, and stop naming it the moment the
  // password is changed. Safe to answer before sign-in: it reveals only
  // whether a documented default is still in place, which is exactly what
  // anyone standing at the machine could discover by typing it in.
  handle('auth:needsSetup', () => ({
    needsSetup: db.needsSetup(),
    defaultAdmin: db.defaultAdminActive() ? { username: db.DEFAULT_ADMIN_USERNAME, password: db.DEFAULT_ADMIN_PASSWORD } : null,
    // Whether a server is saved, never which: Join a clinic, on the sign-in
    // screen, tells "already connected" apart from "closed" (setup.js).
    connected: db.getSyncMeta().configured,
  }));
  handle('auth:setupAdmin', (payload) => {
    const user = db.createFirstAdmin(payload || {});
    currentUser = user;   // sign the new administrator straight in
    endedBecause = null;
    return user;
  });

  ipcMain.handle('auth:login', async (_e, { username, password }) => {
    try {
      const user = db.login(username, password);
      if (!user) return { ok: false, error: 'Invalid username or password.' };
      currentUser = user;
      endedBecause = null;
      return { ok: true, data: user };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('auth:logout', async () => {
    liveSession();   // an account removed elsewhere has no audit line to write
    if (currentUser) db.audit(currentUser, 'logout', 'user', currentUser.id, null);
    currentUser = null;
    endedBecause = null;
    return { ok: true };
  });
  ipcMain.handle('auth:current', async () => { liveSession(); return { ok: true, data: currentUser }; });

  /* ---- Users ---- */
  handle('users:list', () => db.listUsers());
  handle('users:create', (payload) => db.createUser(currentUser, payload));
  handle('users:update', ({ id, ...rest }) => db.updateUser(currentUser, id, rest));
  handle('users:delete', (id) => db.deleteUser(currentUser, id));
  handle('users:clearEventStaff', (eventId) => db.clearEventStaff(currentUser, eventId));

  // v1.1.0 cloud sync
  handle('cloud:config', async (payload) => {
    const before = db.getSyncMeta();
    const r = cloud.applyConfig(payload || {});
    await leaveOwnHub(before);
    return r;
  });
  // A blank key means "keep the saved one", as the Cloud tab says — but only
  // for the server it was saved for.
  // lan: the address is a clinic network host ({ pin, hostId, fp, name } as
  // far as known) — "Test the clinic network", and the test before joining.
  handle('cloud:test', ({ url, key, lan: lanT } = {}) => cloud.testConnection(url, key || cloud.savedKeyFor(url, lanT), lanT ? { lan: lanT } : {}));
  handle('cloud:status', () => cloud.status());
  handle('cloud:syncNow', () => cloud.syncOnce());
  handle('cloud:resync', () => cloud.resyncAll());

  // Unhook this station from any sync server: endpoint, key and cursor all go.
  // Records are untouched — disconnecting is not erasing.
  handle('cloud:disconnect', async () => {
    const before = db.getSyncMeta();
    const r = db.disconnectCloud();
    cloud.applyConfig({});          // stops the timer via restartTimer()
    await leaveOwnHub(before);
    db.audit(currentUser, 'cloud.disconnect', 'settings', null, 'Cloud sync disconnected');
    return r;
  });

  // The server address and clinic key as one code, for connecting the next
  // laptop. Only on an administrator's explicit request, and audited, because
  // whoever holds it can read and change every record the clinic syncs.
  handle('cloud:connectionCode', () => {
    const r = cloud.connectionCode();
    db.audit(currentUser, 'cloud.code', 'settings', null, 'Connection code shown');
    return r;
  });

  // "Join a clinic already set up", from the sign-in screen. It runs before
  // anyone has signed in, so it cannot go through cloud:test / cloud:config:
  // both are the administrator's, and signed out they refused with "Please
  // sign in first" — Join never connected anything in the installed app.
  //
  // Signed out, it is allowed only while anyone at this keyboard could become
  // the administrator anyway: no account exists yet, or the shipped admin /
  // admin still works (the sign-in screen prints it). That grants nothing new.
  // Once the clinic has set its own administrator password, pointing this
  // laptop at a server — which would send it every record here and take back
  // whatever accounts that server holds — is that administrator's, in Admin →
  // Cloud. Same test first as typing the address there, then the first full
  // sync is waited for, because the next step is signing in with an account
  // that only exists here once it has synced down.
  //
  // Pressed again for the server and key this laptop already has — what Join
  // tells someone to do when no accounts had come down yet — it repoints
  // nothing, so it is not refused even though the clinic's own administrator
  // password has arrived meanwhile (that arrival is what closed the computer,
  // and it used to answer "connect it under Admin → Cloud" on a laptop already
  // connected, whose staff could already sign in). It changes nothing either —
  // not even a paused laptop's pause, which is the administrator's — and only
  // waits for a sync and says what is here now.
  //
  // v0.0.17: lan — joining the clinic network: a host picked from the list
  // found ({ hostId, fp, name }) or from a pasted code ({ pin, hostId, name }).
  // The same rules, by the host's certificate rather than its address.
  handle('cloud:join', async ({ url, key, move, lan: lanT } = {}) => {
    if (currentUser && currentUser.role !== 'admin') throw new Error('Your role does not have permission for this action.');
    const saved = db.getSyncMeta();
    const pinIn = lanT ? lan.normPin(lanT.pin) : '';
    const already = saved.configured && !!String(url || '').trim() && String(key || '') === saved.key
      && (lanT ? !!pinIn && pinIn === saved.lanPin : cloud.normalizeUrl(url) === cloud.normalizeUrl(saved.url) && !saved.lanPin);
    if (!currentUser && !already && !joinOpen()) {
      throw new Error('This computer already has its own administrator password. Sign in as an administrator and connect it under Admin → Cloud.');
    }
    if (!String(key || '').trim()) throw new Error('Enter the clinic key as well as the address.');
    const health = await cloud.testConnection(url, key, lanT ? { lan: lanT } : {});
    const target = lanT ? health.lan : null;
    const joinUrl = target ? health.url : url;
    const same = already || (!!target && saved.configured && target.pin === saved.lanPin && String(key) === saved.key);
    const elsewhere = saved.configured && cloud.identityOf(joinUrl, target && target.pin) !== cloud.identityOf(saved.url, saved.lanPin);
    // A DIFFERENT server, for a laptop already connected — one tried on a
    // trial server, joining the clinic's — moves every record here to it.
    // Admin → Cloud asks first ("Move this laptop to a different server?");
    // Join moved it without a word, a pasted code for another server
    // included. So the first press only answers with the question (moveTo),
    // and the laptop moves on the confirmed one (move).
    if (!currentUser && !same && !move && elsewhere) {
      // stopsHosting: this laptop hosts the clinic network it is on — its
      // server up or not at the moment — and moving stops that (leaveOwnHub),
      // said in the question.
      const ownId = hub.ownHostId();
      const h = ownId && saved.lanHost === ownId ? hub.status() : null;
      return { moveTo: target ? networkLabel(target.name, joinUrl) : new URL(cloud.normalizeUrl(url)).host,
        stopsHosting: !!h && (h.running || h.hosting) };
    }
    if (!same) {
      cloud.applyConfig({ url: joinUrl, key, online: true, ...(target ? { lan: target } : {}) });
      await leaveOwnHub(saved);
      db.audit(currentUser, 'cloud.join', 'settings', null, 'Joined ' + (target ? networkLabel(target.name, joinUrl) : cloud.normalizeUrl(url)));
    } else if (target && cloud.lanUrl(health.url) !== cloud.normalizeUrl(saved.url)) {
      // The same host at the address a fresh code or a typed address gives —
      // what this screen tells someone to do when the router stops beacons,
      // so the laptop cannot find the host's new address by itself. Kept, as
      // Admin → Cloud keeps it. Not a move: the same server.
      cloud.repointLan(health.url, target.pin, target.name);
    }
    const sync = await cloud.syncSettled();
    return { ...health, sync, needsSetup: db.needsSetup(), accounts: ownAccounts() };
  });

  // How many accounts the clinic's server brought here, besides the shipped
  // admin / admin — Join's answer to "did the clinic arrive?". needsSetup()
  // cannot answer it: every install comes with admin / admin, so it is false
  // on a new laptop whether or not anything came down, and Join reported
  // "Clinic downloaded" off an empty server. A count of what the last sync
  // applied cannot either: the timer's own cycle, started by saving the
  // server, usually takes everything before syncSettled() runs its one. Nor
  // can a count of every account here: a used laptop's own staff accounts are
  // not the clinic arriving. So only accounts that came from the server count
  // (db.accountsFromServer).
  function ownAccounts() {
    return db.accountsFromServer();
  }

  // Join's rule for a signed-out caller: open while anyone at this keyboard
  // could become the administrator anyway (see cloud:join).
  function joinOpen() { return db.needsSetup() || db.defaultAdminActive(); }

  // This laptop hosts the clinic network and has just been moved off it — to
  // the internet server, to another clinic network, or disconnected. It
  // stops hosting, as part of the move it was asked about. Left hosting, the
  // other laptops went on showing "synced" with it while its own new records
  // never reached them nor theirs it — the clinic split in two without a
  // word — and it hosted again at every start. They now see the host is not
  // hosting, as when it is switched off, and join the next one.
  //
  // Whether or not its server is up at the moment: one that did not start
  // when the app opened (its port taken, say) still had hosting on, and
  // hosted again at the next start while this laptop synced elsewhere — the
  // same split, a day later. So it is this laptop's own clinic network by its
  // hub file's id, and stopping it turns hosting off either way.
  async function leaveOwnHub(before) {
    const ownId = hub.ownHostId();
    if (!ownId || !before || !before.configured || before.lanHost !== ownId) return false;
    const now = db.getSyncMeta();
    if (now.configured && now.lanPin === before.lanPin) return false;
    const was = hub.status();
    if (!was.running && !was.hosting) return false;
    await hub.stop();
    db.audit(currentUser, 'hub.stop', 'settings', null, 'Clinic network stopped: this laptop moved to another server');
    return true;
  }

  // How a server is named in a question: a clinic network by its name, an
  // internet server by its address.
  function networkLabel(name, url) {
    if (name) return `the clinic network “${name}”`;
    try { return new URL(url).host; } catch (_) { return String(url || ''); }
  }
  const savedLabel = (m) => (m.lanPin ? networkLabel(m.lanName || 'Clinic network', m.url) : (() => { try { return new URL(m.url).host; } catch (_) { return m.url; } })());
  const appVersion = () => { try { return require('electron').app.getVersion(); } catch (_) { return ''; } };

  /* ---- The clinic network (v0.0.17) ---- */
  // Which hosts this laptop hears on its Wi-Fi: their names and addresses,
  // what their beacons say — never a key. For Join (Admin → Cloud, and the
  // sign-in screen), under Join's rule.
  handle('lan:scan', async ({ ms } = {}) => {
    if (currentUser && currentUser.role !== 'admin') throw new Error('Your role does not have permission for this action.');
    if (!currentUser && !joinOpen()) {
      throw new Error('This computer already has its own administrator password. Sign in as an administrator and connect it under Admin → Cloud.');
    }
    const own = hub.ownHostId();
    const hosts = await lan.scan({ ms: Math.min(Math.max(Number(ms) || 2500, 500), 6000) });
    return hosts.map((h) => ({ ...h, self: !!own && h.hostId === own }));
  });

  handle('hub:status', () => ({ ...hub.status(), platform: process.platform, firewallHelper: process.platform === 'win32' }));

  // Host the clinic network here, and sync this laptop with it like every
  // other laptop (over 127.0.0.1). A laptop on another server moves to it —
  // asked first (moveFrom), as Save server and Join ask, and then the
  // existing move: the cursor starts again and everything here is sent.
  handle('hub:start', async ({ name, move } = {}) => {
    const saved = db.getSyncMeta();
    // Which clinic network this laptop hosts, if it ever has — asked without
    // making one, so a move that is not confirmed leaves nothing behind.
    const ownId = hub.ownHostId();
    const onOwn = saved.configured && !!ownId && saved.lanHost === ownId;
    if (saved.configured && !onOwn && !move) return { moveFrom: savedLabel(saved) };
    await hub.start({ name, version: appVersion(), selfDevice: db.ensureDeviceId() });
    const t = hub.ownTarget();
    // Already joined to it (hosting again, or after a restart on a new
    // port): the same server, at whatever port it has now.
    if (onOwn) cloud.repointLan(t.url, t.lan.pin, t.lan.name);
    else cloud.applyConfig({ url: t.url, key: t.key, online: true, lan: t.lan });
    db.audit(currentUser, 'hub.start', 'settings', null, 'Hosting the clinic network ' + t.lan.name);
    return hub.status();
  });

  // Stop hosting. The other laptops carry on by themselves and catch up when
  // a laptop hosts again. This laptop was syncing with its own hub, so it is
  // disconnected — its records kept, as Disconnect keeps them; hosting again
  // here reconnects it to the same clinic network. The hub file stays unless
  // erase is asked for.
  handle('hub:stop', async ({ erase } = {}) => {
    const saved = db.getSyncMeta();
    const ownId = hub.ownHostId();
    await hub.stop();
    if (saved.configured && ownId && saved.lanHost === ownId) { db.disconnectCloud(); cloud.applyConfig({}); }
    if (erase) await hub.erase();
    db.audit(currentUser, erase ? 'hub.erase' : 'hub.stop', 'settings', null, erase ? 'Clinic network stopped and erased' : 'Clinic network stopped');
    return hub.status();
  });

  // Windows only: add the firewall rule Windows' own "blocked some features"
  // dialog adds when Private networks is ticked, for a host where that
  // dialog was missed or cancelled — behind Windows' own permission prompt.
  handle('hub:firewall', async () => {
    if (process.platform !== 'win32') throw new Error('Only Windows needs this. On a Mac, allow incoming connections when macOS asks.');
    const r = await hub.allowThroughFirewall(process.execPath);
    db.audit(currentUser, 'hub.firewall', 'settings', null, 'Allowed through the Windows firewall (Private networks)');
    return r;
  });

  // Erase every clinic record on this computer and return it to first-run setup.
  // Destructive and irreversible, so the renderer confirms by typed phrase; the
  // audit line is written before the wipe because the log is cleared too.
  handle('data:reset', async () => {
    db.audit(currentUser, 'data.reset', null, null, 'Full reset of this computer');
    cloud.applyConfig({});          // stop syncing before deleting anything
    // A clinic network hosted here holds a copy of every record the clinic
    // synced — staff password hashes too — so it goes with the rest.
    await hub.stop();
    await hub.erase();
    const r = db.resetClinicData();
    currentUser = null;             // the account that asked no longer exists
    return r;
  });
  /**
   * Export the clinic report as CSV, Excel or PDF.
   *
   * All three are rendered from ONE set of section definitions, so a grant
   * return quoting the spreadsheet and a board paper quoting the PDF can never
   * give different numbers for the same clinic.
   *
   * Built from the de-identified summary, never from patient rows — which means
   * a report is still exportable after the records have been purged, and that is
   * the case these totals exist for.
   */
  handle('report:export', async ({ scope, format, labels } = {}) => {
    const fmt = ['csv', 'xlsx', 'pdf'].includes(format) ? format : 'csv';
    // Same scope the tab is showing: 'all', or an event id. reportRollup treats
    // null/'all' as every clinic, so it is passed straight through.
    const rollup = db.reportRollup(scope === 'all' ? 'all' : scope);
    const summary = (rollup && rollup.summary) || {};
    const scopeLabel = rollup && rollup.all
      ? 'All clinics'
      : ((rollup.event && rollup.event.name) || summary.event_name || 'This clinic');
    const evName = String(scopeLabel).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'clinic';
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `MMW-Report-${evName}-${stamp}`;
    const FILTERS = {
      csv: { name: 'CSV spreadsheet', extensions: ['csv'] },
      xlsx: { name: 'Excel workbook', extensions: ['xlsx'] },
      pdf: { name: 'PDF document', extensions: ['pdf'] },
    };
    const res = await dialog.showSaveDialog({
      title: 'Save clinic report',
      defaultPath: path.join(os.homedir(), `${base}.${fmt}`),
      filters: [FILTERS[fmt]],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    const out = res.filePath.toLowerCase().endsWith('.' + fmt) ? res.filePath : res.filePath + '.' + fmt;
    if (fmt === 'csv') fs.writeFileSync(out, reportExport.reportCsv(summary, scopeLabel, labels));
    else if (fmt === 'xlsx') fs.writeFileSync(out, reportExport.reportWorkbook(summary, scopeLabel, labels));
    else fs.writeFileSync(out, await pdf.renderHtmlPdf(reportExport.reportHtml(summary, scopeLabel, labels)));
    return { saved: true, path: out, format: fmt };
  });

  /* ---- Clinic export / restore / purge (v1.6.0) ---- */
  // Two files: a readable workbook, and the backup that can actually put the
  // clinic back (signatures and x-ray images cannot live in a spreadsheet).
  handle('export:clinic', async ({ eventId } = {}) => {
    const bundle = db.exportClinicBundle(eventId);
    const evName = String((bundle.event && bundle.event.name) || 'clinic').replace(/[^a-z0-9]+/gi, '-');
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `Clinic-${evName}-${stamp}`;
    const res = await dialog.showSaveDialog({
      title: 'Save clinic export',
      defaultPath: path.join(os.homedir(), base + '.xlsx'),
      filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    const xlsxPath = res.filePath.endsWith('.xlsx') ? res.filePath : res.filePath + '.xlsx';
    const backupPath = xlsxPath.replace(/\.xlsx$/i, '') + '.chbak.json';
    fs.writeFileSync(xlsxPath, xlsx.buildWorkbook(clinicSheets(bundle)));
    fs.writeFileSync(backupPath, JSON.stringify(bundle));
    return { saved: true, xlsxPath, backupPath, patients: bundle.patients.length };
  });

  handle('import:clinic', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose a clinic backup file',
      properties: ['openFile'],
      filters: [{ name: 'Mission Minded backup', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { imported: false };
    let bundle;
    try { bundle = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')); }
    catch (_e) { throw new Error('That file could not be read. Choose the .chbak.json file saved with the export.'); }
    return { imported: true, ...db.importClinicBundle(currentUser, bundle) };
  });

  // Pull everything in before the records go. The kept totals are counted from
  // what is on THIS computer, so finishing a clinic while another station still
  // held unsynced check-ins used to record a number lower than the clinic
  // actually saw — and the patients were gone, so it could never be corrected.
  const syncBeforeRemoving = async () => {
    try { if (cloud.status().enabled) await cloud.syncOnce(); } catch (_e) { /* offline: proceed with local totals */ }
  };
  handle('event:finish', async ({ eventId } = {}) => {
    await syncBeforeRemoving();
    return db.finishEvent(currentUser, eventId);
  });
  handle('event:purge', async ({ eventId } = {}) => {
    await syncBeforeRemoving();
    return db.purgeEventPatients(currentUser, eventId);
  });
  handle('reports:archived', () => db.listEventReports());
  // The Reports tab's numbers, for one event or all of them — live records and
  // the kept totals of finished clinics counted the same way.
  handle('reports:rollup', ({ eventId } = {}) => db.reportRollup(eventId));

  // Recovery: recompute an event's reporting totals from an exported backup
  // WITHOUT restoring any patients — for a clinic whose figures were lost.
  handle('reports:rebuild', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose the clinic backup file to rebuild a report from',
      properties: ['openFile'],
      filters: [{ name: 'Mission Minded backup', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { rebuilt: false };
    let bundle;
    try { bundle = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')); }
    catch (_e) { throw new Error('That file could not be read. Choose the .chbak.json file saved with the export.'); }
    return { rebuilt: true, ...db.rebuildSummaryFromBundle(currentUser, bundle) };
  });

  /* ---- Front-desk arrivals (v1.5.24) ---- */
  handle('patients:arrivalCheck', (id) => db.arrivalReadiness(id));
  handle('patients:confirmArrival', ({ id, route }) => db.confirmArrival(currentUser, id, { route }));

  /* ---- Events ---- */
  handle('events:list', () => db.listEvents(), { });
  ipcMain.handle('events:active', async () => ({ ok: true, data: db.getActiveEvent() }));
  handle('events:create', (payload) => db.createEvent(currentUser, payload));
  handle('events:update', ({ id, ...rest }) => db.updateEvent(currentUser, id, rest));
  handle('events:setActive', (id) => db.setActiveEvent(currentUser, id));
  handle('events:setState', ({ id, active }) => db.setEventActive(currentUser, id, active));
  handle('events:delete', ({ id, force }) => db.deleteEvent(currentUser, id, { force }));

  /* ---- Patient delete (admin) ---- */
  handle('patients:delete', (id) => db.deletePatient(currentUser, id));

  /* ---- Patients ---- */
  // Check-in is the patient-facing intake: a dedicated kiosk (no signed-in
  // user) may create patients, and so may ANY signed-in staff member
  // (admin / doctor / triage). It is intentionally not role-gated.
  ipcMain.handle('patients:create', async (_e, payload) => {
    try {
      // A check-in is never refused over the account it was started under:
      // if that account has gone, the patient is checked in as at the kiosk.
      liveSession();
      return { ok: true, data: db.createPatient(currentUser, payload) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  handle('patients:updateSection', ({ id, section, values, reviewedOnly } = {}) => {
    const roles = db.SECTION_ROLES[section];
    if (!roles) throw new Error('Unknown section.');
    if (!roles.includes(currentUser.role)) throw new Error('Your role does not have permission for this action.');
    return db.updatePatientSection(currentUser, id, section, values, { reviewedOnly: !!reviewedOnly });
  });
  handle('patients:get', (id) => db.getPatient(id));
  // MMW: resolve a scanned wristband. A handheld scanner types the digits and
  // presses Enter, so the code arrives with stray whitespace/CR — normalising
  // lives in the data layer, and an unknown band returns a clear error rather
  // than a null the caller has to guess at. Signed-in staff only (PERMS).
  handle('patients:findByCode', (code) => {
    const found = db.findPatientByCode(code);
    if (!found) throw new Error('No patient found for that wristband.');
    return found;
  });
  handle('patients:list', (opts) => db.listPatients(opts || {}));
  handle('patients:records', (opts) => db.listPatients(opts || {}));
  handle('patients:searchAll', (term) => db.searchAllPatients(term));
  handle('patients:newVisit', (sourceId) => db.startVisitFromExisting(currentUser, sourceId));
  handle('patients:history', (id) => db.patientHistory(id));
  handle('patients:incomplete', () => db.listIncompletePatients());
  handle('patients:cleanupIncomplete', () => db.deleteIncompletePatients(currentUser));

  /* ---- Triage & treatment ---- */
  handle('triage:save', ({ patientId, data }) => db.saveTriage(currentUser, patientId, data));
  // Always the check-out stage. 'registration' is a legacy stage that only
  // merges answers in; nothing in this build asks it (db.createPatient's
  // in-process path is the only writer), and split-era rows from an old kiosk
  // or the old online form arrive by sync, not here. Accepting it over IPC let
  // any survey role add answers to a row the patient DECLINED at check-out.
  handle('survey:save', ({ patientId, data }) => db.saveExitSurvey(currentUser, patientId, { ...(data || {}), stage: 'exit' }));

  /* ---- Supplies ---- */
  handle('inventory:list', ({ eventId } = {}) => db.listInventory({ eventId }));
  handle('inventory:get', ({ id }) => db.getInventoryItem(id));
  handle('inventory:save', ({ data }) => db.saveInventoryItem(currentUser, data));
  handle('inventory:move', ({ data }) => db.recordInventoryMove(currentUser, data));
  handle('inventory:delete', ({ id }) => db.deleteInventoryItem(currentUser, id));
  handle('inventory:chairUsage', ({ eventId } = {}) => db.inventoryChairUsage(eventId));
  // finalize may be false, 'waiting' (v0.0.15: move to Treatment Waiting),
  // 'cleaning' / 'cleaning_complete' / 'cleaning_lock' / 'cleaning_waiting'
  // (v0.0.15: the hygienist's save, complete, sign-off, and save for a patient
  // waiting for a chair), 'complete' (mark done, no lock),
  // or 'lock'/true — pass it through so each mode reaches the data layer. Same
  // roles, so no new channel was needed. data.opened (the chart the station
  // opened) travels inside data, untouched (see db.saveTreatment).
  handle('treatment:save', ({ patientId, data, finalize }) =>
    db.saveTreatment(currentUser, patientId, data, finalize));
  handle('treatment:unlock', ({ patientId, reason } = {}) => db.unlockRecord(currentUser, patientId, reason));
  handle('treatment:lock', ({ patientId } = {}) => db.lockRecord(currentUser, patientId));

  /* ---- v1.0.6: vitals, consent teeth, dismissal, per-patient audit ---- */
  handle('vitals:save', ({ patientId, data }) => db.saveVitals(currentUser, patientId, data));
  handle('patients:route', ({ patientId, route }) => db.routePatient(currentUser, patientId, route));
  handle('consent:setTeeth', ({ consentId, tooth_numbers }) => db.updateConsentTeeth(currentUser, consentId, tooth_numbers));
  handle('consent:add', ({ patientId, consent }) => db.addPatientConsent(currentUser, patientId, consent));
  handle('patients:dismiss', (id) => db.dismissPatient(currentUser, id));
  handle('patients:move', ({ id, target }) => db.adminMovePatient(currentUser, id, target));
  handle('patients:audit', (id) => db.patientAudit(id));

  /* ---- X-rays ---- */
  handle('xray:add', ({ patientId, station, image_png, note, tooth }) =>
    db.addXray(currentUser, patientId, { station, image_png, note, tooth }));
  handle('xray:setTooth', ({ id, tooth }) => db.updateXrayTooth(currentUser, id, tooth));
  handle('xray:get', (id) => db.getXray(id));
  handle('xray:list', (patientId) => db.listXrays(patientId));
  handle('xray:delete', (id) => db.deleteXray(currentUser, id));

  // ---- X-ray import from the imaging software's export folder (DEXIS) ----
  // The folder is chosen ONCE (start of day) and can be LOCKED so the dentist
  // only ever taps a single "Import X-ray" button. We read the images the
  // software saved there, convert DEXIS ".dex" files to a viewable image when a
  // standard image is embedded, and (optionally) clear each file from the folder
  // once it's filed to a chart so the next patient's captures are unambiguous.
  const { XRAY_RENDER_EXT, XRAY_CONVERT_EXT, extractStandardImage, resolveFolderTarget } = xrayFolder;
  const xrayDir = () => db.getSetting('xray_import_dir') || '';
  const xrayLocked = () => db.getSetting('xray_folder_locked') === '1';
  const xrayClearAfter = () => db.getSetting('xray_clear_after_import') !== '0'; // default ON
  const xrayCfg = (extra) => Object.assign({ dir: xrayDir(), locked: xrayLocked(), clearAfter: xrayClearAfter() }, extra || {});

  handle('xray:folderConfig', async () => xrayCfg());

  // Choose the folder (start-of-day setup). Remembered per PC.
  handle('xray:folderChoose', async () => {
    const cur = xrayDir();
    const res = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Choose the folder where the X-ray images are saved',
      properties: ['openDirectory'],
      defaultPath: cur || undefined,
    });
    if (res.canceled || !res.filePaths.length) return xrayCfg({ canceled: true });
    db.setSetting('xray_import_dir', res.filePaths[0]);
    return xrayCfg();
  });

  // Lock/hide the folder controls and/or set the "clear after import" preference.
  handle('xray:folderLock', async ({ locked, clearAfter } = {}) => {
    if (locked !== undefined) db.setSetting('xray_folder_locked', locked ? '1' : '0');
    if (clearAfter !== undefined) db.setSetting('xray_clear_after_import', clearAfter ? '1' : '0');
    return xrayCfg();
  });

  handle('xray:folderList', async () => {
    const d = xrayDir();
    if (!d) return xrayCfg({ needsSetup: true, images: [] });
    if (!fs.existsSync(d)) return xrayCfg({ error: 'That folder was not found on this computer.', images: [] });
    let files;
    try {
      files = fs.readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const ext = path.extname(e.name).toLowerCase();
          if (!XRAY_RENDER_EXT[ext] && !XRAY_CONVERT_EXT[ext]) return null;
          const fp = path.join(d, e.name);
          let st = null; try { st = fs.statSync(fp); } catch (_) { /* skip */ }
          return st ? { name: e.name, ext, fp, mt: st.mtimeMs, size: st.size } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.mt - a.mt)
        .slice(0, 40);
    } catch (e) { return xrayCfg({ error: e.message, images: [] }); }
    const images = files.map((f) => {
      if (f.size > 40 * 1024 * 1024) return { name: f.name, mtime: f.mt, kind: 'unreadable', from: f.ext, reason: 'File is too large to import.' };
      let buf; try { buf = fs.readFileSync(f.fp); } catch (_) { return null; }
      if (XRAY_RENDER_EXT[f.ext]) {
        return { name: f.name, mtime: f.mt, kind: 'image', from: f.ext, dataUrl: `data:${XRAY_RENDER_EXT[f.ext]};base64,${buf.toString('base64')}` };
      }
      const ex = extractStandardImage(buf);
      if (ex) return { name: f.name, mtime: f.mt, kind: 'converted', from: f.ext, dataUrl: `data:${ex.mime};base64,${ex.buf.toString('base64')}` };
      return { name: f.name, mtime: f.mt, kind: 'unreadable', from: f.ext, reason: 'This DEXIS file has no embedded standard image. In DEXIS, use Export/Save as JPEG, then import that.' };
    }).filter(Boolean);
    return xrayCfg({ images });
  });

  // Delete a source file from the import folder AFTER it's filed to a chart, so
  // the folder stays clean for the next patient. Guard hard: only unlink a
  // regular image file whose basename resolves DIRECTLY inside the folder.
  handle('xray:folderDelete', async ({ name } = {}) => {
    const target = resolveFolderTarget(xrayDir(), name);
    try { if (!fs.statSync(target).isFile()) throw new Error('Not a file.'); }
    catch (_) { return { ok: true, alreadyGone: true }; }
    fs.unlinkSync(target);
    return { ok: true };
  });

  // Delete a source image file from the computer's drive by its absolute path,
  // AFTER the doctor's uploaded X-ray has been filed to the chart. Guard to real
  // image files that exist; a missing file is treated as already done.
  const XRAY_DISK_EXT = { '.jpg': 1, '.jpeg': 1, '.png': 1, '.gif': 1, '.bmp': 1, '.webp': 1, '.tif': 1, '.tiff': 1, '.dex': 1, '.dexis': 1 };
  handle('xray:deleteFile', async ({ path: p } = {}) => {
    if (!p || typeof p !== 'string') throw new Error('No file specified.');
    if (!XRAY_DISK_EXT[path.extname(p).toLowerCase()]) throw new Error('Refusing to delete a non-image file.');
    try { if (!fs.statSync(p).isFile()) throw new Error('Not a file.'); }
    catch (_) { return { ok: true, alreadyGone: true }; }
    fs.unlinkSync(p);
    return { ok: true };
  });

  /* ---- Dashboard / audit ---- */
  ipcMain.handle('stats:dashboard', async () => {
    try {
      liveSession();
      if (!currentUser) throw new Error(endedBecause || 'Please sign in first.');
      return { ok: true, data: db.dashboardStats() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  handle('audit:list', (limit) => db.listAudit(limit));

  /* ---- PDF: preview, save, print ---- */
  // Attach x-ray images so the summary/full PDF can embed them.
  const patientForPdf = (id) => { const p = db.getPatient(id); if (p) p._xrays = db.listXrays(id); return p; };
  // The saved file's name says what is in it. Everything that was not the full
  // record used to be named "ProgressNote", so the visit summary a patient was
  // emailed arrived as ..._ProgressNote.pdf.
  const PDF_FILE_NAMES = { full: 'FullRecord', summary: 'VisitSummary', aftercare: 'AfterCare', progress: 'ProgressNote' };
  // The after-care page's language, when the desk asks for one other than the
  // patient's ("Print in English"). A code, nothing else, or it is ignored.
  const pdfLang = (lang) => (typeof lang === 'string' && /^[a-z]{2,3}$/.test(lang) ? lang : undefined);
  const pdfDetail = (format, lang) => (pdfLang(lang) ? `${format} (${lang})` : format);

  handle('pdf:preview', async ({ patientId, format, lang }) => {
    const patient = patientForPdf(patientId);
    if (!patient) throw new Error('Patient not found.');
    const buf = await pdf.renderPdf(patient, format, { lang: pdfLang(lang) });
    db.audit(currentUser, 'export_preview', 'patient', patientId, pdfDetail(format, lang));
    return 'data:application/pdf;base64,' + buf.toString('base64');
  });

  handle('pdf:generate', async ({ patientId, format, lang }) => {
    const patient = patientForPdf(patientId);
    if (!patient) throw new Error('Patient not found.');
    const buf = await pdf.renderPdf(patient, format, { lang: pdfLang(lang) });
    const suggested = `${patient.last_name}_${patient.first_name}_${PDF_FILE_NAMES[format] || 'ProgressNote'}${format === 'aftercare' && pdfLang(lang) ? '_' + lang : ''}.pdf`
      .replace(/[^a-z0-9_.-]/gi, '');
    const res = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Save patient record',
      defaultPath: suggested,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    fs.writeFileSync(res.filePath, buf);
    db.audit(currentUser, 'export_pdf', 'patient', patientId, path.basename(res.filePath));
    return { saved: true, path: res.filePath };
  });

  // The audit row ('print', with the format as its detail) is the record that
  // after-care instructions were printed for a patient; no column is needed.
  handle('pdf:print', async ({ patientId, format, lang }) => {
    const patient = patientForPdf(patientId);
    if (!patient) throw new Error('Patient not found.');
    const html = pdf.buildHtml(patient, format || 'progress', { lang: pdfLang(lang) });
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((resolve, reject) => {
      win.webContents.print({ silent: false, printBackground: true }, (success, reason) => {
        win.destroy();
        if (!success && reason && reason !== 'cancelled') reject(new Error(reason));
        else resolve();
      });
    });
    db.audit(currentUser, 'print', 'patient', patientId, pdfDetail(format, lang));
    return { printed: true };
  });

  // Which after-care sections apply to this patient, for the check-out screen
  // to list before anything is printed. The same function builds the page.
  handle('aftercare:get', ({ patientId, lang } = {}) => {
    const patient = db.getPatient(patientId);
    if (!patient) throw new Error('Patient not found.');
    return aftercare.aftercareSections(patient, pdfLang(lang));
  });

  /* ---- Backup & export ---- */
  handle('backup:run', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const res = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Back up clinic database to USB / drive',
      defaultPath: `mmw-backup-${stamp}.db`,
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    await db.backupTo(res.filePath);
    db.audit(currentUser, 'backup', 'event', null, path.basename(res.filePath));
    return { saved: true, path: res.filePath };
  });

  handle('export:event', async ({ eventId } = {}) => {
    // Export the event the report is actually SHOWING, not whichever one happens
    // to be active — those are different the moment an admin changes the scope.
    const data = db.exportEventJson(eventId && eventId !== 'all' ? Number(eventId) : undefined);
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = (data.event ? data.event.name : 'event').replace(/[^a-z0-9]+/gi, '-');
    const res = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Export event records (JSON)',
      defaultPath: `${safe}-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2));
    db.audit(currentUser, 'export_event', 'event', data.event ? data.event.id : null, path.basename(res.filePath));
    return { saved: true, path: res.filePath, count: data.patients.length };
  });

  // Offload the whole clinic as ONE .zip for a hard drive: the full SQLite
  // database (restorable) + a human-readable records JSON + a README.
  handle('export:zip', async () => {
    const data = db.exportEventJson();
    const evName = (data.event ? data.event.name : 'clinic').replace(/[^a-z0-9]+/gi, '-');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const res = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Export clinic data as a ZIP (for a hard drive)',
      defaultPath: `mmw-${evName}-${stamp}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    // Consistent DB snapshot into a temp file, then fold it into the zip.
    const tmp = path.join(os.tmpdir(), `ch-backup-${Date.now()}.db`);
    let dbBuf;
    try { await db.backupTo(tmp); dbBuf = fs.readFileSync(tmp); }
    finally { try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ } }
    const readme = [
      'Mission Minded Worldwide — clinic data export',
      'Event: ' + (data.event ? data.event.name : '(none)'),
      'Exported: ' + new Date().toISOString(),
      'Patients in this event: ' + (data.patients ? data.patients.length : 0),
      '',
      'Contents:',
      '  database.db   full SQLite database — the complete clinic (open in Mission Minded or any SQLite tool)',
      '  records.json  all patient records for this event, human-readable',
      '',
      'This archive contains protected health information. Store it securely.',
    ].join('\r\n');
    const buf = zipStore.zip([
      { name: 'database.db', data: dbBuf },
      { name: 'records.json', data: Buffer.from(JSON.stringify(data, null, 2), 'utf8') },
      { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
    ]);
    fs.writeFileSync(res.filePath, buf);
    db.audit(currentUser, 'export_zip', 'event', data.event ? data.event.id : null, path.basename(res.filePath));
    return { saved: true, path: res.filePath, count: data.patients ? data.patients.length : 0 };
  });

  /* ---- Patient-portable record (USB the patient carries) ---- */
  handle('record:exportUsb', async ({ patientId }) => {
    const patient = db.getPatient(patientId);
    if (!patient) throw new Error('Patient not found.');
    const res = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Choose USB drive / folder for the patient record',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { saved: false };
    const destDir = res.filePaths[0];
    const base = `${patient.last_name}_${patient.first_name}_MMW`.replace(/[^a-z0-9_]/gi, '');
    const folder = path.join(destDir, base);
    fs.mkdirSync(folder, { recursive: true });
    // Full clinical PDF + portable JSON (with x-ray images) for continuity of care.
    const pdfBuf = await pdf.renderPdf(patient, 'full');
    fs.writeFileSync(path.join(folder, `${base}.pdf`), pdfBuf);
    const portable = { ...patient, xrays: db.listXrays(patientId), exported_at: new Date().toISOString() };
    fs.writeFileSync(path.join(folder, `${base}.json`), JSON.stringify(portable, null, 2));
    db.audit(currentUser, 'export_usb', 'patient', patientId, folder);
    return { saved: true, path: folder };
  });

  /* ---- v1.0.6: USB per-patient transfer workflow ---- */
  async function pickDir(title) {
    const res = await dialog.showOpenDialog(getMainWindow(), { title, properties: ['openDirectory'] });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  }
  handle('usb:list', () => usb.listDrives());

  // Write the patient's file to the drive at check-in. OPEN (kiosk may be
  // unauthenticated) — registered raw, like patients:create.
  ipcMain.handle('usb:writeCheckin', async (_e, { patientId, choose } = {}) => {
    try {
      liveSession();   // as patients:create: the file is written, under the kiosk if need be
      const patient = db.getPatient(patientId);
      if (!patient) throw new Error('Patient not found.');
      const dir = await pickDir('Insert/choose the USB drive for this patient');
      if (!dir) return { ok: true, data: { saved: false } };
      const portable = { ...patient, xrays: db.listXrays(patientId), exported_at: new Date().toISOString() };
      let pdfBuf = null;
      try { pdfBuf = await pdf.renderPdf({ ...patient, _xrays: portable.xrays }, 'full'); } catch (e) { /* pdf optional */ }
      const r = usb.writePatientFile(dir, patient, JSON.stringify(portable, null, 2), pdfBuf);
      db.audit(currentUser, 'usb_write', 'patient', patientId, r.path);
      return { ok: true, data: r };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  handle('usb:load', async () => {
    const dir = await pickDir('Choose the USB drive to load the patient from');
    if (!dir) return { loaded: [] };
    const files = usb.loadPatientFiles(dir);
    return { dir, loaded: files.map((f) => ({ name: f.name, first_name: f.patient.first_name, last_name: f.patient.last_name, dob: f.patient.dob })) };
  });

  // Upload every patient file on the drive into the local DB (checkout).
  handle('usb:uploadCheckout', async () => {
    const dir = await pickDir('Choose the USB drive to upload to the local database');
    if (!dir) return { uploaded: 0 };
    const files = usb.loadPatientFiles(dir);
    // A file older than the record here (signed off, or unlocked, since it was
    // written) is skipped by the import — counted as such, so the desk is told
    // rather than shown it among the uploads.
    let uploaded = 0;
    let skipped = 0;
    for (const f of files) {
      try {
        const r = db.importPatientFromPortable(currentUser, f.patient);
        if (r && r.import_skipped) skipped++; else uploaded++;
      } catch (e) { /* skip bad file */ }
    }
    return { dir, uploaded, skipped };
  });

  handle('usb:clear', async ({ dir, choose } = {}) => {
    let d = dir;
    if (!d || choose) d = await pickDir('Choose the USB drive to clear');
    if (!d) return { cleared: 0 };
    const r = usb.clearDrive(d);
    db.audit(currentUser, 'usb_clear', 'patient', null, `${r.cleared} folder(s)`);
    return r;
  });

  /* ---- Version & offline updates (available from any view) ---- */
  ipcMain.handle('app:version', async () => {
    try {
      return { ok: true, data: { version: updater.currentVersion(), platform: process.platform, name: 'Mission Minded' } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('update:check', async (_e, payload) => {
    try {
      if (!currentUser) throw new Error('Please sign in first.');
      let dir = payload && payload.dir;
      if (payload && payload.choose) {
        const res = await dialog.showOpenDialog(getMainWindow(), {
          title: 'Select the USB drive / folder that has the update',
          properties: ['openDirectory'],
        });
        if (!res.canceled && res.filePaths.length) dir = res.filePaths[0];
      }
      const result = updater.checkForUpdates(dir);
      db.setSetting('update_last_checked', result.checkedAt);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // Online auto-update (electron-updater / GitHub releases).
  ipcMain.handle('update:onlineAvailable', async () => {
    try { return { ok: true, data: { available: autoupdate.available() } }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('update:checkOnline', async () => {
    try { if (!currentUser) throw new Error('Please sign in first.'); return { ok: true, data: await autoupdate.check() }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('update:downloadOnline', async () => {
    try { if (!currentUser) throw new Error('Please sign in first.'); return { ok: true, data: await autoupdate.download() }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('update:installOnline', async () => {
    try {
      if (!currentUser || currentUser.role !== 'admin') throw new Error('Only an administrator can install updates.');
      return { ok: true, data: autoupdate.quitAndInstall() };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('update:install', async (_e, { path: installerPath }) => {
    try {
      if (!currentUser || currentUser.role !== 'admin') throw new Error('Only an administrator can install updates.');
      const r = await updater.openInstaller(installerPath);
      db.audit(currentUser, 'update_install', 'app', null, installerPath);
      return { ok: true, data: r };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ---- Misc ---- */
  ipcMain.handle('app:openExternal', async (_e, url) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
    return { ok: true };
  });
}

module.exports = { register, getCurrentUser: () => currentUser };
