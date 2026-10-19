'use strict';

// Cloud sync engine (main process). Drives the row-level sync in db.js against
// a Cloudflare Worker the clinic deploys itself (see cloud/SYNC_CONTRACT.md).
//
// Offline-first, and now actually so: nothing runs unless an administrator has
// entered BOTH a URL and a key and left sync switched on. That was the stated
// contract from v1.1.0 but it stopped being true in v1.2.3, which baked in a
// server and key and connected every install at boot; getSyncMeta() fails
// closed again, and this module never invents an endpoint. All network failures
// are swallowed into a status field so the app keeps working.
//
// v0.0.17: the same client, and the same push / pull / cursor / deletion
// rules, serve the clinic network (no internet) — one laptop hosts the real
// cloud/worker.js (hub.js) and every laptop syncs with it here. Only how a
// request travels differs: to a clinic network host it goes over a pinned
// connection (lan.request) instead of fetch(), because the host's certificate
// is its own and is trusted by its fingerprint, carried in a saved pin.

const os = require('os');
const db = require('./db');
const lan = require('./lan');

const INTERVAL_MS = 4000;
const HTTP_TIMEOUT_MS = 12000;
const PULL_LIMIT = 400;

let timer = null;
let running = false;      // a sync cycle is in flight
let getWindow = () => null;
let lastResult = { pushed: 0, pulled: 0, applied: 0 };

// Normalize whatever the admin pasted into a usable base URL. Handles the common
// mistakes: no scheme (workers.dev address pasted bare), a trailing slash, or an
// accidentally-included path like /health or /v1/pull. Returns the bare origin
// (e.g. https://mmw-sync.acme.workers.dev).
function trimUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s; // add https:// when missing
  try { return new URL(s).origin; } catch { return s.replace(/\/+$/, ''); }
}

// The clinic key goes in a request header, and a header can only carry
// characters up to U+00FF and no line break. A phone or a Mac turns a typed '
// into ’ and -- into –, and with one of those in the key every request failed
// on this laptop before anything was sent — reported as "Could not reach
// <host>. Check this laptop is online", wrong on both counts. Said plainly
// instead, wherever a key is tested, saved or used.
function keyProblem(key) {
  const bad = [...String(key || '')].find((c) => c.codePointAt(0) > 0xff || /[\0\r\n]/.test(c));
  if (bad === undefined) return '';
  const shown = bad.codePointAt(0) > 0xff ? ` (“${bad}”)` : '';
  return `The clinic key has a character this app cannot send${shown}, such as a curly quote or a long dash that a phone or Mac puts in by itself. In Cloudflare, change CLINIC_KEY to plain letters, numbers and spaces, Deploy, then type the new key here.`;
}

// pin: the clinic network host's certificate fingerprint. With one, the
// request goes over the pinned connection; the answer is read the same way.
async function httpJson(method, url, key, body, pin) {
  if (key && keyProblem(key)) throw new Error(keyProblem(key));
  if (pin) return lanJson(method, url, key, body, pin);
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = 'Bearer ' + key;
    let res;
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    } catch (e) {
      // Nothing answered at all (no internet, a mistyped host, a timeout) —
      // marked so explain() can say so, and never confused with an error
      // raised later by applying what a server sent.
      if (e && typeof e === 'object') e.network = true;
      throw e;
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    if (!res.ok) {
      const msg = (json && json.error) || `HTTP ${res.status}`;
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return json || {};
  } finally { clearTimeout(to); }
}

// The same request to a clinic network host. Every request also says which
// laptop it is from (its device id and computer name — no secret), so the
// host's screen can list the laptops connected now.
async function lanJson(method, url, key, body, pin) {
  const headers = { 'content-type': 'application/json', 'x-mmw-device': db.ensureDeviceId(), 'x-mmw-computer': String(os.hostname() || '').slice(0, 64) };
  if (key) headers.authorization = 'Bearer ' + key;
  const r = await lan.request(url, { method, headers, body: body ? JSON.stringify(body) : undefined, pin, timeoutMs: HTTP_TIMEOUT_MS });
  let json = null;
  try { json = JSON.parse(r.text); } catch { /* non-json */ }
  if (r.status < 200 || r.status >= 300) {
    const err = new Error((json && json.error) || `HTTP ${r.status}`); err.status = r.status; throw err;
  }
  return json || {};
}

// What a failed request means, in words a clinic director can act on. The raw
// messages ("fetch failed", "unauthorized", "This operation was aborted") were
// shown as they came, and none of them says whether to check the wifi, the
// address or the key. Used for the connection test and for the reason the
// Cloud tab shows while sync is retrying.
function explain(err, base, pin) {
  let host = base;
  try { host = new URL(base).host; } catch { /* keep what was typed */ }
  // On the clinic network the reasons, and what to do, are the Wi-Fi's and
  // the host laptop's — never "check this laptop is online".
  if (pin) return lan.explain(err, host);
  if (err && err.status === 401) {
    return 'The server answered, but refused the clinic key. Type it exactly as it was set on the server (CLINIC_KEY) — capital letters and spaces count.';
  }
  // A Worker with no D1 database bound as DB fails on its first query with
  // JavaScript's own wording, which names nothing a person could fix.
  if (err && err.status === 500 && /reading 'prepare'/.test(err.message || '')) {
    return 'The server has no database connected. In Cloudflare, add a D1 database binding to the Worker with the variable name DB, then Deploy.';
  }
  if (err && err.network && err.name === 'AbortError') {
    return `${host} did not answer in time. Check this laptop is online, then try again.`;
  }
  if (err && err.network) {
    return `Could not reach ${host}. Check this laptop is online and the address is typed correctly.`;
  }
  return (err && err.message) || String(err);
}

// A plain http:// address sends the clinic key, and every record, readable to
// anyone on the same wifi. trimUrl() only adds https:// when no scheme was
// typed, so an explicit http:// used to be kept and saved. Refused wherever an
// address is entered; this computer itself is the one exception, so a
// developer can still try the server locally with `wrangler dev`.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
function isPlainHttp(base) {
  try { const u = new URL(base); return u.protocol === 'http:' && !LOOPBACK.has(u.hostname); } catch { return false; }
}
const PLAIN_HTTP = 'Use the https:// address Cloudflare gives you. A plain http:// address would send the clinic key unprotected.';
const isLoopbackUrl = (base) => { try { return LOOPBACK.has(new URL(base).hostname); } catch { return false; } };

// A clinic network host's address as it is saved: https://, and the port the
// host uses when none was typed ("192.168.1.23" is 192.168.1.23:47800).
function lanUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  try {
    const x = new URL(s);
    if (x.protocol === 'https:' && !x.port && !/:443(\/|$)/.test(s)) x.port = String(lan.DEFAULT_PORT);
    return x.origin;
  } catch { return s.replace(/\/+$/, ''); }
}

// Which server a laptop is on. An internet server is its address; a clinic
// network host is its certificate, whatever address it has today — so a host
// whose address changed (the router handed out another) is the same server,
// and a host set up again at the same address (erased, a new certificate) is
// not. applyConfig moves a laptop only when this changes.
const identityOf = (url, pin) => (lan.normPin(pin) ? 'lan:' + lan.normPin(pin) : trimUrl(url));
const savedIdentity = (m) => identityOf(m.url, m.lanPin);

// Verify a URL + key: /health must be reachable, and the key must authorize a pull.
// opts.lan: the address is a clinic network host (see testClinicNetwork).
async function testConnection(url, key, opts = {}) {
  if (opts && opts.lan) return testClinicNetwork(url, key, opts.lan);
  const base = trimUrl(url);
  if (!base) throw new Error('Enter the Cloud URL first.');
  try { new URL(base); } catch {
    throw new Error('That does not look like a web address. It should look like https://mmw-sync.<your-subdomain>.workers.dev');
  }
  if (isPlainHttp(base)) throw new Error(PLAIN_HTTP);
  if (keyProblem(key)) throw new Error(keyProblem(key));
  let health;
  try {
    health = await httpJson('GET', base + '/health', null);
  } catch (e) {
    // Something answered, but not a sync server: a typo in the subdomain that
    // lands on another site, or a Worker still holding Cloudflare's sample code.
    if (!e.network) throw new Error('That address did not return a Mission Minded sync server.');
    throw new Error(explain(e, base));
  }
  if (!health || health.ok !== true) throw new Error('That URL did not return a Mission Minded sync server.');
  // Key check — a bad key returns 401.
  try {
    await httpJson('GET', base + '/v1/pull?since=&limit=1', key);
  } catch (e) { throw new Error(explain(e, base)); }
  return { ok: true, service: health.service, version: health.version, time: health.time };
}

// The same test on the clinic network — "Test the clinic network" on a
// joined laptop, and the check before joining. It says which of the local
// network's own failures this is (lan.diagnose): host not found, its firewall
// blocking, a certificate that does not match, the wrong key. With no pin yet
// (a host picked from the list found, or a typed address), the host first
// proves it holds the clinic key (lan.learnPin), so the key is only ever sent
// to the clinic's own host. Returns the pin, for the saving that follows.
async function testClinicNetwork(url, key, t) {
  const base = lanUrl(url);
  if (!base) throw new Error('Enter the host laptop\'s address first — it looks like 192.168.1.23:47800.');
  let host;
  try { host = new URL(base).host; } catch {
    throw new Error('That does not look like a clinic network address. It looks like 192.168.1.23:47800, as the host laptop\'s Cloud tab shows it.');
  }
  if (!/^https:/.test(base)) throw new Error(PLAIN_HTTP);
  if (!String(key || '').trim()) throw new Error('Enter the clinic key shown on the host laptop\'s Cloud tab, or paste its connection code.');
  if (keyProblem(key)) throw new Error(keyProblem(key));
  let pin = lan.normPin(t.pin);
  let hostId = String(t.hostId || '');
  let name = String(t.name || '');
  const refuse = (e, at) => { let h = at; try { h = new URL(at).host; } catch { /* as given */ } return Object.assign(new Error(lan.explain(e, h)), { code: lan.classify(e) || 'not_mmw' }); };
  const notAnswering = (code) => code === 'timeout' || code === 'not_found' || code === 'not_hosting';
  let at = base;
  if (!pin) {
    const learn = (u) => lan.learnPin(u, key, { expectPrefix: t.fp || '', expectHost: hostId });
    let learned = null;
    try { learned = await learn(at); } catch (e) {
      if (!notAnswering(lan.classify(e))) throw refuse(e, at);
      // Not answering here: why — or where it is now. Nothing is sent but
      // a request for /health; the key goes nowhere until the host proves it.
      const d0 = await lan.diagnose({ url: at, hostId });
      if (!d0.movedTo) throw Object.assign(new Error(d0.message || lan.explain(e, host)), { code: d0.code });
      at = d0.movedTo;
      try { learned = await learn(at); } catch (e2) { throw refuse(e2, at); }
    }
    pin = learned.pin; hostId = learned.hostId || hostId; name = learned.name || name;
  }
  let d = await lan.diagnose({ url: at, key, pin, hostId });
  // Heard somewhere else — a code made before the host's port or address
  // changed, or a joined laptop's saved address gone stale: followed, once
  // the certificate there is the pinned one.
  if (!d.ok && d.movedTo) {
    let presented = '';
    try { presented = await lan.peerPin(d.movedTo); } catch (e) { throw refuse(e, d.movedTo); }
    if (presented !== pin) throw refuse({ pinMismatch: true }, d.movedTo);
    at = d.movedTo;
    d = await lan.diagnose({ url: at, key, pin, hostId });
  }
  if (!d.ok) throw Object.assign(new Error(d.message), { code: d.code });
  // A laptop joined to this host keeps it at the address it answers at now.
  if (at !== base) repointLan(at, pin);
  return { ok: true, service: d.health.service, version: d.health.version, time: d.health.time, lan: { pin, hostId, name }, url: at };
}

// The key saved for this server, when the address given is the one already
// saved — so "leave blank to keep the saved key" can be tested before it is
// saved. A different server never inherits it (see applyConfig).
function savedKeyFor(url, lanT) {
  const m = db.getSyncMeta();
  if (!m.url) return '';
  const same = lanT ? lanUrl(url) === trimUrl(m.url) && lan.normPin(lanT.pin) === m.lanPin : trimUrl(url) === trimUrl(m.url) && !m.lanPin;
  return same ? m.key : '';
}

// The connection code: the server address and clinic key as ONE string, so
// the next laptop is connected by pasting it rather than retyping both (a
// workers.dev address and a long passphrase are exactly what gets mistyped).
//
// It is not encryption and does not pretend to be. The code IS the clinic key
// in another spelling, which is why it is made here, handed out only over an
// administrator-only channel when one asks to see it, and called a password on
// every screen that shows it. src/renderer/js/connectionCode.js reads it; the
// harness holds the two to the same format. The number is the format's
// version, so a later change can be told apart instead of misread.
//
// v0.0.17: a clinic network's code also carries the host's certificate
// fingerprint (p), its id (h) and its name (n), so a pasted code is pinned
// from the first request. Same format version: a reader that knows only
// u and k (v0.0.16) would try the address as an internet server, and the
// host's own certificate stops that connection before anything is sent.
const CODE_PREFIX = 'MMW1-';
function encodeConnectionCode(url, key, lanT) {
  const pin = lanT ? lan.normPin(lanT.pin) : '';
  const payload = { u: pin ? lanUrl(url) : trimUrl(url), k: String(key) };
  if (pin) Object.assign(payload, { p: pin, h: String(lanT.hostId || ''), n: String(lanT.name || '') });
  return CODE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
function connectionCode() {
  const m = db.getSyncMeta();
  if (!m.configured) throw new Error('This computer is not connected to a sync server, so there is no code to share.');
  if (m.lanPin) {
    let url = trimUrl(m.url);
    // The host syncs with itself over 127.0.0.1, which on any other laptop
    // means that laptop: the code carries the address the others reach it at.
    if (isLoopbackUrl(url)) {
      url = require('./hub').shareUrl();
      if (!url) throw new Error('This laptop is not on a network, so no other laptop can reach it. Connect it to the clinic\'s Wi-Fi first.');
    }
    const lanT = { pin: m.lanPin, hostId: m.lanHost, name: m.lanName };
    // The key itself rides along for the dialog: a laptop that picks this
    // host from the list found types it instead of pasting the code.
    return { code: encodeConnectionCode(url, m.key, lanT), url, lan: true, key: m.key, name: m.lanName };
  }
  return { code: encodeConnectionCode(m.url, m.key), url: trimUrl(m.url) };
}

// Whether `base` is still the server this laptop is connected to. A cycle can
// be waiting on the network when an administrator saves a different server (or
// disconnects); what that cycle then hears from the old one — rows it accepted,
// rows and a cursor it handed back — is about the old server, and recording it
// would mark rows as sent that the new one never got (see applyConfig).
//
// conn is { base, key, pin }: the address, key and (on the clinic network)
// the pinned certificate the cycle started with. A host that moved address
// is the same server (see refind), but a cycle still talking to the old
// address is superseded like any other.
const stillOn = (conn) => { const m = db.getSyncMeta(); return trimUrl(m.url) === conn.base && (m.lanPin || '') === (conn.pin || ''); };

async function pushOnce(conn, deviceId) {
  const { rows, mark } = db.collectSyncRows(PULL_LIMIT);
  if (!rows.length) return 0;
  const r = await httpJson('POST', conn.base + '/v1/push', conn.key, { device_id: deviceId, rows }, conn.pin);
  if (r && r.ok && stillOn(conn)) { db.markSynced(mark); db.setSyncMeta({ lastPush: new Date().toISOString() }); }
  return rows.length;
}

// A cursor is either the server's delivery counter (a plain number, v1.5.0+
// servers) or the old timestamp stamp. Only the counter is safe: it cannot skip
// a row that reaches the cloud late (an offline check-in, or a laptop whose
// clock is behind).
const isSeqCursor = (c) => /^\d+$/.test(String(c || ''));

async function pullOnce(conn) {
  const { base, key, pin } = conn;
  let cursor = db.getSyncMeta().cursor || '';
  // Still on a timestamp cursor? Ask whether this server now delivers by
  // counter, and if so restart from the beginning ONCE. That both switches this
  // station over and re-reads anything the old timestamp cursor stepped past.
  if (cursor && !isSeqCursor(cursor)) {
    let health = null;
    try { health = await httpJson('GET', base + '/health', null, undefined, pin); } catch { /* offline / older server */ }
    if (!stillOn(conn)) return { pulled: 0, applied: 0, deleted: 0 };
    if (health && health.seq === true) { cursor = ''; db.setSyncMeta({ cursor }); }
  }
  let pulled = 0, applied = 0, removed = 0, guard = 0;
  // Retry any previously-orphaned rows first — their parent may have arrived
  // since (e.g. a treatment that was pulled before its patient).
  let carry = db.getSyncPending();
  // A DELETION parked by an earlier pull is retried only with the last page of
  // this one. What brings a parked deletion's record back is a newer copy of
  // it, somewhere in what has reached the server since (an account a laptop
  // sends back after an older version recorded its deletion by mistake — see
  // reviveRefusedUserDeletions in db.js — or a restore). applyRemoteRows lets
  // the older deletion go when that copy is in the same batch, or already
  // applied here; retried with the FIRST page, it was carried out whenever the
  // copy was further on — more than one page (PULL_LIMIT) away, a laptop off
  // for a clinic day — and the copy then re-created the record: an account
  // under a new id, with nothing it had done here pointing at it, and signed
  // out; a patient without the chart the deletion took with it.
  let held = carry.filter((r) => r && r.deleted);
  carry = carry.filter((r) => !(r && r.deleted));
  // Follow `more` pages so a first sync catches up fully. A child whose parent
  // lands in a later page is carried forward within the loop. The server hands
  // rows out in its own counter order, so no row is ever skipped at a page
  // boundary, so the cursor can always advance — orphans that outlive the whole
  // delta are parked in the persistent pending buffer and retried next cycle
  // (never dropped, never wedging the cursor).
  for (;;) {
    if (guard++ > 500) break;
    const qs = `?since=${encodeURIComponent(cursor)}&limit=${PULL_LIMIT}`;
    const r = await httpJson('GET', base + '/v1/pull' + qs, key, undefined, pin);
    if (!stillOn(conn)) return { pulled, applied, deleted: removed };
    const rows = (r && r.rows) || [];
    const last = !r || !r.more;
    let batch = carry.length ? carry.concat(rows) : rows;
    if (last && held.length) { batch = batch.concat(held); held = []; }
    if (batch.length) {
      const res = db.applyRemoteRows(batch);
      applied += res.applied; removed += (res.deleted || 0); pulled += rows.length;
      carry = res.deferredRows || [];
    }
    // What is still waiting for its parent is saved with every page, BEFORE
    // that page's cursor. Saved only after the last page, a pull cut short by
    // the network — the next page timing out — kept the cursor past every row
    // deferred so far and lost the rows: patients and staff arriving ahead of
    // an event edited after they were added, on a laptop joining the clinic,
    // until someone pressed Re-sync everything.
    db.setSyncPending(carry.concat(held));
    // Accept "0" as a real cursor value (a counter can legitimately be 0).
    const pageCursor = (r && r.cursor != null && r.cursor !== '') ? String(r.cursor) : cursor;
    if (pageCursor !== cursor) { cursor = pageCursor; db.setSyncMeta({ cursor }); }
    if (last) break;
  }
  // Park still-unresolved orphans for the next cycle (bounded, persisted) —
  // and any parked deletion a cut-short pull never reached the end with.
  db.setSyncPending(carry.concat(held));
  return { pulled, applied, deleted: removed };
}

// One full push+pull cycle. Never throws — records status instead.
// The Worker this app was forked from. Blocked outright: an install that still
// carries it in settings must not resume talking to another clinic's database.
const SEVERED_HOSTS = ['little-block-222a.randy-982.workers.dev'];
function isSeveredEndpoint(url) {
  try { return SEVERED_HOSTS.includes(new URL(String(url)).host); } catch { return false; }
}

async function syncOnce() {
  const meta = db.getSyncMeta();
  if (!meta.enabled || !meta.url || !meta.key) return { ok: false, skipped: true };
  if (isSeveredEndpoint(meta.url)) {
    db.setSyncMeta({ lastError: 'This server belongs to another organisation and is no longer used.' });
    return { ok: false, skipped: true };
  }
  if (running) return { ok: false, busy: true };
  running = true;
  inflight = cycle(meta).finally(() => { running = false; inflight = null; });
  return inflight;
}

let inflight = null;      // the cycle in flight, for syncSettled()
async function cycle(meta) {
  const base = trimUrl(meta.url);
  const conn = { base, key: meta.key, pin: meta.lanPin || '' };
  const deviceId = db.ensureDeviceId();
  try {
    const pushed = await pushOnce(conn, deviceId);
    const { pulled, applied, deleted } = await pullOnce(conn);
    if (!stillOn(conn)) return { ok: false, superseded: true };
    db.setSyncMeta({ lastOk: new Date().toISOString(), lastError: '' });
    lastResult = { pushed, pulled, applied, deleted };
    if (applied > 0) notifyRenderer();
    return { ok: true, pushed, pulled, applied, deleted };
  } catch (e) {
    const msg = explain(e, base, conn.pin);
    if (!stillOn(conn)) return { ok: false, superseded: true };
    db.setSyncMeta({ lastError: msg });
    // The clinic network host may simply have a new address (the router
    // handed it another, or its port was taken): look for it by its id.
    if (conn.pin && !e.status) scheduleRefind();
    return { ok: false, error: msg };
  }
}

// Finding the host again. The laptops joined to a clinic network know it by
// its id and certificate, not by its address, so when it stops answering
// they listen for its beacon (and ask "who is there?"), and follow it to the
// address it is heard at — once a handshake there shows the pinned
// certificate, so a beacon from anyone else moves nothing. Nobody re-enters
// anything. Not on the host itself, which reaches its own hub at 127.0.0.1.
// At most one look every ten seconds (each listens for two); the harness sets
// it to 0 so a probe need not wait.
const refindTiming = { everyMs: 10000 };
let lastRefind = 0;
let refinding = null;
// Asked again while a look is under way — which may have started before the
// host came back — it looks once more when that one ends, rather than not
// at all.
let refindAgain = false;
function scheduleRefind() {
  if (refinding) { refindAgain = true; return; }
  if (Date.now() - lastRefind < refindTiming.everyMs) return;
  lastRefind = Date.now();
  refinding = refind().then((moved) => { if (moved) syncOnce(); }).catch(() => {}).finally(() => {
    refinding = null;
    if (refindAgain) { refindAgain = false; scheduleRefind(); }
  });
}
async function refind({ scan = lan.scan } = {}) {
  const m = db.getSyncMeta();
  if (!m.configured || !m.lanPin || !m.lanHost) return '';
  if (require('./hub').runningHostId() === m.lanHost) return '';
  const hosts = await scan({ ms: 2000 });
  const here = hosts.find((h) => h.hostId === m.lanHost && m.lanPin.startsWith(h.fp));
  if (!here) return '';
  for (const url of here.urls) {
    if (url === trimUrl(m.url)) continue;
    let presented = '';
    try { presented = await lan.peerPin(url); } catch { continue; }
    if (presented === m.lanPin && repointLan(url, m.lanPin)) return url;
  }
  return '';
}

// The same clinic network host, at another address: saved without the move
// a new server makes (no cursor reset, nothing re-sent) — it IS the same
// server. Refused unless the pin is still the one this laptop is joined with.
function repointLan(url, pin, name) {
  const m = db.getSyncMeta();
  const next = lanUrl(url);
  if (!m.configured || !m.lanPin || lan.normPin(pin) !== m.lanPin || !next) return false;
  const patch = {};
  if (next !== trimUrl(m.url)) patch.url = next;
  if (name && name !== m.lanName) patch.lanName = String(name).slice(0, 80);
  if (Object.keys(patch).length) db.setSyncMeta(patch);
  if (patch.url) db.setSetting('cloud_last_url', next);
  return true;
}

// A full cycle the caller can wait for. syncOnce() answers "busy" while the
// timer's own cycle is running — and saving a new server always starts one —
// so a caller that has to know the clinic has ARRIVED (joining from the
// sign-in screen, where the next step is signing in with an account that only
// exists once it has synced down) waits that one out and then runs its own.
async function syncSettled() {
  if (inflight) { try { await inflight; } catch { /* its outcome is in status() */ } }
  return syncOnce();
}

// Tell the renderer fresh data arrived so open views can refresh.
function notifyRenderer() {
  try {
    const win = getWindow && getWindow();
    if (win && win.webContents) win.webContents.send('cloud:changed', { at: new Date().toISOString(), ...lastResult });
  } catch { /* ignore */ }
}

function status() {
  const m = db.getSyncMeta();
  // kind: 'internet' or 'lan' (the clinic network), for the screens; isHost:
  // this laptop is the clinic network's host, syncing with itself.
  const kind = !m.configured ? '' : (m.lanPin ? 'lan' : 'internet');
  let isHost = false;
  if (kind === 'lan') { try { isHost = require('./hub').ownHostId() === m.lanHost; } catch { isHost = false; } }
  return {
    enabled: m.enabled, mode: m.mode, online: m.mode === 'online',
    url: m.url, hasKey: !!m.key, configured: m.configured,
    kind, lanPin: m.lanPin, lanPinShown: lan.showPin(m.lanPin, 4), lanHost: m.lanHost, lanName: m.lanName, isHost,
    deviceId: m.deviceId, cursor: m.cursor,
    lastOk: m.lastOk, lastPush: m.lastPush, lastError: m.lastError,
    running, ...lastResult,
  };
}

// lan: { pin, hostId, name } — the address is a clinic network host, with the
// pin its test returned (testConnection). Without it, an address is an
// internet server, and any clinic network details saved before are dropped.
function applyConfig({ url, key, enabled, mode, online, lan: lanIn }) {
  const patch = {};
  const lanT = lanIn && typeof lanIn === 'object'
    ? { pin: lan.normPin(lanIn.pin), hostId: String(lanIn.hostId || '').slice(0, 64), name: String(lanIn.name || '').slice(0, 80) } : null;
  if (lanT && (url === undefined || !lanT.pin)) throw new Error('Test the clinic network connection before saving it.');
  const base = url === undefined ? undefined : (lanT ? lanUrl(url) : trimUrl(url));
  if (url !== undefined && isPlainHttp(base)) throw new Error(PLAIN_HTTP);
  if (url !== undefined) {
    patch.url = base;
    patch.lanPin = lanT ? lanT.pin : '';
    patch.lanHost = lanT ? lanT.hostId : '';
    patch.lanName = lanT ? lanT.name : '';
  }
  const prior = savedIdentity(db.getSyncMeta());
  // A server is new when its identity is: a different internet address, a
  // different clinic network host (a different certificate), or a switch
  // between the internet and the clinic network. The same host at a new
  // address is not (repointLan).
  const next = url !== undefined ? identityOf(base, lanT && lanT.pin) : prior;
  const newServer = url !== undefined && next !== prior;
  // A key must travel with a server change. Letting a new URL inherit the
  // stored key is how a clinic could end up pointing at its own server while
  // still authenticating with somebody else's credential.
  if (newServer && !key) {
    throw new Error('Enter the clinic key for this server as well as its address.');
  }
  if (key && keyProblem(key)) throw new Error(keyProblem(key));
  if (key !== undefined) patch.key = key;
  // Accept mode ('online'|'offline'), an `online` boolean, or legacy `enabled`.
  if (mode !== undefined) patch.mode = mode === 'offline' ? 'offline' : 'online';
  else if (online !== undefined) patch.mode = online ? 'online' : 'offline';
  else if (enabled !== undefined) patch.mode = enabled ? 'online' : 'offline';
  db.ensureDeviceId();
  // A different server — or any server after a Disconnect, which leaves no
  // address saved — starts from nothing on both sides. The old server's
  // cursor skipped every row the new one numbered below it, and the rows
  // already sent to the old one stayed marked as sent, so nothing went to the
  // new one: a laptop moved from a test server to the clinic's exchanged
  // nothing while Join reported success. Everything here goes, each row with
  // its own stamp, and everything there comes back — but not the deletions
  // this laptop only heard from the old server (see db.markAllUnsent). The
  // accounts here now are noted, so Join can tell which came from the server.
  // Reconnected after a Disconnect to the server it was last on, nothing there
  // is another server's: its own deletions of the shared admin and event go as
  // they would have had it stayed connected (see db.markAllUnsent).
  // A clinic network host is the same server by its certificate, as above.
  const sameServer = newServer && !prior && next === identityOf(db.getSetting('cloud_last_url'), db.getSetting('cloud_last_pin'));
  if (newServer) { db.resetSyncCursor(); db.markAllUnsent({ sameServer }); db.noteAccountsHere(); }
  db.setSyncMeta(patch);
  // The address alone, kept through a Disconnect (never the key) — and on
  // the clinic network the host's pin with it, since the address is not
  // what identifies that server there.
  if (patch.url) { db.setSetting('cloud_last_url', patch.url); db.setSetting('cloud_last_pin', patch.lanPin || ''); }
  restartTimer();
  return status();
}

function restartTimer() {
  if (timer) { clearInterval(timer); timer = null; }
  const m = db.getSyncMeta();
  if (m.enabled && m.url && m.key) {
    // Kick one immediately, then on an interval.
    syncOnce();
    timer = setInterval(syncOnce, INTERVAL_MS);
    if (timer.unref) timer.unref();
  }
}

function start(windowGetter) {
  getWindow = windowGetter || (() => null);
  restartTimer();
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

// Forget this station's place in the queue and re-read everything on the next
// sync — the fix when a laptop is missing patients the other laptops can see.
async function resyncAll() {
  db.resetSyncCursor();
  const r = await syncOnce();
  return { ok: true, ...r };
}

module.exports = {
  start, stop, syncOnce, syncSettled, resyncAll, testConnection, savedKeyFor, status, applyConfig, normalizeUrl: trimUrl,
  connectionCode, encodeConnectionCode, CODE_PREFIX,
  // v0.0.17: the clinic network.
  lanUrl, identityOf, repointLan, refind, refindTiming, explain,
};
