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

const db = require('./db');

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

async function httpJson(method, url, key, body) {
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

// What a failed request means, in words a clinic director can act on. The raw
// messages ("fetch failed", "unauthorized", "This operation was aborted") were
// shown as they came, and none of them says whether to check the wifi, the
// address or the key. Used for the connection test and for the reason the
// Cloud tab shows while sync is retrying.
function explain(err, base) {
  let host = base;
  try { host = new URL(base).host; } catch { /* keep what was typed */ }
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

// Verify a URL + key: /health must be reachable, and the key must authorize a pull.
async function testConnection(url, key) {
  const base = trimUrl(url);
  if (!base) throw new Error('Enter the Cloud URL first.');
  try { new URL(base); } catch {
    throw new Error('That does not look like a web address. It should look like https://mmw-sync.<your-subdomain>.workers.dev');
  }
  if (isPlainHttp(base)) throw new Error(PLAIN_HTTP);
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

// The key saved for this server, when the address given is the one already
// saved — so "leave blank to keep the saved key" can be tested before it is
// saved. A different server never inherits it (see applyConfig).
function savedKeyFor(url) {
  const m = db.getSyncMeta();
  return m.url && trimUrl(url) === trimUrl(m.url) ? m.key : '';
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
const CODE_PREFIX = 'MMW1-';
function encodeConnectionCode(url, key) {
  return CODE_PREFIX + Buffer.from(JSON.stringify({ u: trimUrl(url), k: String(key) }), 'utf8').toString('base64url');
}
function connectionCode() {
  const m = db.getSyncMeta();
  if (!m.configured) throw new Error('This computer is not connected to a sync server, so there is no code to share.');
  return { code: encodeConnectionCode(m.url, m.key), url: trimUrl(m.url) };
}

// Whether `base` is still the server this laptop is connected to. A cycle can
// be waiting on the network when an administrator saves a different server (or
// disconnects); what that cycle then hears from the old one — rows it accepted,
// rows and a cursor it handed back — is about the old server, and recording it
// would mark rows as sent that the new one never got (see applyConfig).
const stillOn = (base) => trimUrl(db.getSyncMeta().url) === base;

async function pushOnce(base, key, deviceId) {
  const { rows, mark } = db.collectSyncRows(PULL_LIMIT);
  if (!rows.length) return 0;
  const r = await httpJson('POST', base + '/v1/push', key, { device_id: deviceId, rows });
  if (r && r.ok && stillOn(base)) { db.markSynced(mark); db.setSyncMeta({ lastPush: new Date().toISOString() }); }
  return rows.length;
}

// A cursor is either the server's delivery counter (a plain number, v1.5.0+
// servers) or the old timestamp stamp. Only the counter is safe: it cannot skip
// a row that reaches the cloud late (an offline check-in, or a laptop whose
// clock is behind).
const isSeqCursor = (c) => /^\d+$/.test(String(c || ''));

async function pullOnce(base, key) {
  let cursor = db.getSyncMeta().cursor || '';
  // Still on a timestamp cursor? Ask whether this server now delivers by
  // counter, and if so restart from the beginning ONCE. That both switches this
  // station over and re-reads anything the old timestamp cursor stepped past.
  if (cursor && !isSeqCursor(cursor)) {
    let health = null;
    try { health = await httpJson('GET', base + '/health', null); } catch { /* offline / older server */ }
    if (!stillOn(base)) return { pulled: 0, applied: 0, deleted: 0 };
    if (health && health.seq === true) { cursor = ''; db.setSyncMeta({ cursor }); }
  }
  let pulled = 0, applied = 0, removed = 0, guard = 0;
  // Retry any previously-orphaned rows first — their parent may have arrived
  // since (e.g. a treatment that was pulled before its patient).
  let carry = db.getSyncPending();
  // Follow `more` pages so a first sync catches up fully. A child whose parent
  // lands in a later page is carried forward within the loop. The server hands
  // rows out in its own counter order, so no row is ever skipped at a page
  // boundary, so the cursor can always advance — orphans that outlive the whole
  // delta are parked in the persistent pending buffer and retried next cycle
  // (never dropped, never wedging the cursor).
  for (;;) {
    if (guard++ > 500) break;
    const qs = `?since=${encodeURIComponent(cursor)}&limit=${PULL_LIMIT}`;
    const r = await httpJson('GET', base + '/v1/pull' + qs, key);
    if (!stillOn(base)) return { pulled, applied, deleted: removed };
    const rows = (r && r.rows) || [];
    const batch = carry.length ? carry.concat(rows) : rows;
    if (batch.length) {
      const res = db.applyRemoteRows(batch);
      applied += res.applied; removed += (res.deleted || 0); pulled += rows.length;
      carry = res.deferredRows || [];
    }
    // Accept "0" as a real cursor value (a counter can legitimately be 0).
    const pageCursor = (r && r.cursor != null && r.cursor !== '') ? String(r.cursor) : cursor;
    if (pageCursor !== cursor) { cursor = pageCursor; db.setSyncMeta({ cursor }); }
    if (!r || !r.more) break;
  }
  // Park still-unresolved orphans for the next cycle (bounded, persisted).
  db.setSyncPending(carry);
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
  const deviceId = db.ensureDeviceId();
  try {
    const pushed = await pushOnce(base, meta.key, deviceId);
    const { pulled, applied, deleted } = await pullOnce(base, meta.key);
    if (!stillOn(base)) return { ok: false, superseded: true };
    db.setSyncMeta({ lastOk: new Date().toISOString(), lastError: '' });
    lastResult = { pushed, pulled, applied, deleted };
    if (applied > 0) notifyRenderer();
    return { ok: true, pushed, pulled, applied, deleted };
  } catch (e) {
    const msg = explain(e, base);
    if (!stillOn(base)) return { ok: false, superseded: true };
    db.setSyncMeta({ lastError: msg });
    return { ok: false, error: msg };
  }
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
  return {
    enabled: m.enabled, mode: m.mode, online: m.mode === 'online',
    url: m.url, hasKey: !!m.key, configured: m.configured,
    deviceId: m.deviceId, cursor: m.cursor,
    lastOk: m.lastOk, lastPush: m.lastPush, lastError: m.lastError,
    running, ...lastResult,
  };
}

function applyConfig({ url, key, enabled, mode, online }) {
  const patch = {};
  if (url !== undefined && isPlainHttp(trimUrl(url))) throw new Error(PLAIN_HTTP);
  if (url !== undefined) patch.url = trimUrl(url);
  const newServer = url !== undefined && trimUrl(url) !== trimUrl(db.getSyncMeta().url);
  // A key must travel with a server change. Letting a new URL inherit the
  // stored key is how a clinic could end up pointing at its own server while
  // still authenticating with somebody else's credential.
  if (newServer && !key) {
    throw new Error('Enter the clinic key for this server as well as its address.');
  }
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
  // its own stamp, and everything there comes back.
  if (newServer) { db.resetSyncCursor(); db.markAllUnsent(); }
  db.setSyncMeta(patch);
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
};
