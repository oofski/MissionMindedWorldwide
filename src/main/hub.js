'use strict';

// Hosting the clinic network (v0.0.17): this laptop becomes the clinic's sync
// server, for a clinic with a Wi-Fi router and no internet.
//
// It is not a second implementation of the server. It runs the REAL
// cloud/worker.js — the file a clinic pastes into Cloudflare — behind a small
// HTTPS server, over a D1-shaped wrapper around better-sqlite3 (the handful of
// calls worker.js makes: prepare, bind, run, all, first — the same contract
// cloud/test-worker.mjs's fake holds it to). Every laptop, this one included
// (over 127.0.0.1), syncs with it through the same cloud.js client and the
// same push / pull / cursor / deletion rules as online. So the clinic network
// and the internet server behave the same by construction: there is one sync
// protocol, served from two places.
//
// The server's rows live in their own file (clinic-network.db) beside, never
// inside, this laptop's clinic database: the host is a meeting point like the
// Cloudflare one, and this laptop's own records reach it the way every other
// laptop's do. The same file holds the host's identity — its id, its
// certificate and the clinic key — so stopping keeps all of it (hosting again
// carries on, codes and all), and erasing it makes a new clinic network that
// no laptop is joined to yet.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const dgram = require('dgram');
const Database = require('better-sqlite3');
const lan = require('./lan');

const HUB_FILE = 'clinic-network.db';
const WORKER_PATH = path.join(__dirname, '..', '..', 'cloud', 'worker.js');
// Cloudflare's own request limit, so a push the internet server would refuse
// is refused here too, and one it takes is taken.
const MAX_BODY = 100 * 1024 * 1024;
// What a request without the clinic key may send. Cloudflare's edge takes a
// 100 MB body from anyone at no cost to the clinic; here the host laptop held
// every one in memory before worker.js looked at the key, so anyone on the
// Wi-Fi could exhaust a 4 GB laptop with a few dozen of them and take the app,
// and every laptop's sync, down with it. Nothing the app sends without the key
// has a body at all.
const PRE_AUTH_BODY = 64 * 1024;
// Connections at once from one address. A laptop uses one at a time, a few
// while it tests the network. A cap on all connections together (Node's
// maxConnections) let anyone on the Wi-Fi, without the key, stop every
// laptop syncing — this one's own included — by holding that many
// connections open without ever starting TLS: Node drops every connection
// over the cap. Counted per address, the most one address takes is its own
// share, and this laptop's own connection (127.0.0.1) is never counted.
const PER_ADDRESS = 8;
// And from every other address together, only so the number of open
// sockets has a bound: far above any clinic's laptops.
const MAX_CONNECTIONS = 1024;
// A connection that has not finished its TLS handshake by then is let go.
// A laptop's takes milliseconds; a silent one held its place for 20 seconds.
const HANDSHAKE_MS = 5000;
// A laptop counts as connected while it has synced within this long (they
// sync every 4 seconds while open).
const SEEN_MS = 60 * 1000;
// At most this many remembered at once: the ones seen longest ago go first.
const MAX_LAPTOPS = 200;

const state = {
  dir: null, sqlite: null, server: null, port: 0, error: '',
  beacon: null, beaconTimer: null, beaconError: '',
  // Hosting is on, but this laptop is not on the clinic's Wi-Fi: it waits
  // for it (see resume) instead of hosting here.
  paused: false, watch: null,
  laptops: new Map(),
  // This laptop's own device id (its sync client's), so the list of laptops
  // connected can say which one is this laptop — by who it is, not by its
  // address: any laptop could reach the host at 127.0.0.1.
  selfDevice: '',
};

/* ---------------- D1, over better-sqlite3 ---------------- */

// The calls worker.js makes, with D1's answers: first() is a row or null,
// all() is { results }, run() is { success, meta }. Statements are prepared
// when first run, as D1 does, so a statement the database refuses fails where
// worker.js expects it to (its migrations rely on that, inside try/catch).
function d1(sqlite) {
  return {
    prepare(sql) {
      let binds = [];
      let stmt = null;
      const s = () => stmt || (stmt = sqlite.prepare(sql));
      const api = {
        bind(...args) {
          binds = args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
          return api;
        },
        async first(col) {
          const st = s();
          let row;
          if (st.reader) row = st.get(...binds);
          else { st.run(...binds); row = undefined; }
          if (row === undefined) return null;
          return col ? row[col] : row;
        },
        async all() {
          const st = s();
          if (st.reader) return { results: st.all(...binds), success: true, meta: {} };
          const info = st.run(...binds);
          return { results: [], success: true, meta: { changes: info.changes } };
        },
        async run() {
          const st = s();
          if (st.reader) return { results: st.all(...binds), success: true, meta: {} };
          const info = st.run(...binds);
          return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
        },
      };
      return api;
    },
  };
}

/* ---------------- The real worker.js ---------------- */

// Loaded from its source text as a data: URL rather than by path. Inside the
// installed app the file is in the app.asar archive, which require() can read
// but the ES-module loader cannot be relied on to; the text reads the same
// either way. And each hosting session gets its own copy of the module:
// worker.js remembers at module level that it has created its tables, so
// after an erase the next hub would otherwise never create them.
let workerGen = 0;
async function loadWorker() {
  const src = fs.readFileSync(WORKER_PATH, 'utf8');
  workerGen += 1;
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src + '\n// clinic network hub ' + workerGen + '\n', 'utf8').toString('base64'));
  return mod.default;
}

/* ---------------- Identity: id, certificate, key ---------------- */

// The key every laptop uses to sync with this host, made here. Long enough
// that the join proof (lan.learnPin) gives nothing to guess from, and typed
// easily from the host's screen: no 0/O or 1/I to confuse.
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeClinicKey() {
  const group = () => Array.from({ length: 5 }, () => KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)]).join('');
  return [group(), group(), group(), group(), group()].join('-');
}

// A self-signed certificate, made once per clinic network. No authority signs
// it — there is no internet to ask — and none needs to: the joining laptops
// pin its fingerprint. node-forge writes the certificate; Node makes the key.
function makeCertificate() {
  const forge = require('node-forge');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }));
  cert.serialNumber = '01' + crypto.randomBytes(15).toString('hex');
  const now = Date.now();
  cert.validity.notBefore = new Date(now - 24 * 3600 * 1000);
  // Twenty years: a pinned certificate is trusted by its fingerprint, and one
  // that expired mid-clinic would only be a reason for some client to refuse it.
  cert.validity.notAfter = new Date(now + 20 * 365 * 24 * 3600 * 1000);
  const attrs = [{ name: 'commonName', value: 'Mission Minded clinic network' }, { name: 'organizationName', value: 'Mission Minded Worldwide' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: keyPem };
}
const pinOf = (certPem) => lan.normPin(new crypto.X509Certificate(certPem).fingerprint256);

/* ---------------- The hub file ---------------- */

const hubFile = () => (state.dir ? path.join(state.dir, HUB_FILE) : '');
function init(dir) { state.dir = dir; }

function getMeta(k) {
  const r = state.sqlite.prepare('SELECT v FROM hub_meta WHERE k = ?').get(k);
  return r ? r.v : '';
}
function setMeta(k, v) {
  state.sqlite.prepare('INSERT INTO hub_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v == null ? '' : v));
}

// Open (and on first use create) the hub file and its identity. Hosting is
// not started; this is also how the Cloud tab learns which clinic network
// this laptop would host, to tell it apart from the one it is joined to.
function open() {
  if (!state.dir) throw new Error('The clinic network is not ready yet.');
  if (state.sqlite) return;
  const s = new Database(hubFile());
  s.pragma('journal_mode = WAL');
  s.exec('CREATE TABLE IF NOT EXISTS hub_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  state.sqlite = s;
  if (!getMeta('host_id')) {
    const { cert, key } = makeCertificate();
    s.transaction(() => {
      setMeta('host_id', crypto.randomUUID());
      setMeta('cert', cert);
      setMeta('private_key', key);
      setMeta('key', makeClinicKey());
      setMeta('created_at', new Date().toISOString());
    })();
  }
}
function closeFile() {
  if (state.sqlite) { try { state.sqlite.close(); } catch (_) { /* closed */ } }
  state.sqlite = null;
}

function identity() {
  open();
  return {
    hostId: getMeta('host_id'), pin: pinOf(getMeta('cert')), key: getMeta('key'),
    name: getMeta('name') || 'Clinic network', port: Number(getMeta('port')) || 0,
  };
}

/* ---------------- Serving ---------------- */

// The request body, up to `limit`. Past it, a laptop's push (it has the key)
// is read to its end and thrown away, then answered 413: cut off mid-way, the
// laptop heard only a reset, which reads as "no host answered" — it went
// looking for the host by its beacon while the host was up, and retried the
// same push for ever. Anything else past its limit is cut off at once.
function readBody(req, limit, { drain = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    const tooLarge = () => Object.assign(new Error('Request too large.'), { status: 413 });
    req.on('data', (c) => {
      size += c.length;
      if (over) return;
      if (size > limit) {
        over = true; chunks.length = 0;
        if (!drain) { reject(tooLarge()); req.destroy(); }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

// Answered before the body is read. A small rest of one is read and thrown
// away, so the answer arrives whole rather than as a reset; a large one is
// cut off.
function refuse(req, res, status, obj) {
  let seen = 0;
  req.on('data', (c) => { seen += c.length; if (seen > PRE_AUTH_BODY) req.destroy(); });
  req.on('error', () => { /* cut off: nothing more to say */ });
  sendJson(res, status, obj);
}

// The clinic key, checked by the host itself before it reads a body — the
// same check worker.js makes (its extractBearer and constant-time compare),
// which still makes it again.
function keyOk(header, key) {
  const m = /^Bearer\s+(.+)$/i.exec(String(Array.isArray(header) ? header[0] : (header || '')).trim());
  if (!m || !key) return false;
  const a = Buffer.from(m[1], 'utf8'), b = Buffer.from(String(key), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const headerText = (v, max) => String(Array.isArray(v) ? v[0] : (v || '')).replace(/[^\x20-\x7e]/g, '').trim().slice(0, max);
// A laptop's computer name, which it sends percent-encoded: a header can only
// carry Latin-1, and a name in Cyrillic or Chinese made every request from
// that laptop fail before it was sent (cloud.lanJson).
function computerName(v) {
  const raw = headerText(v, 400);
  let s = raw;
  try { s = decodeURIComponent(raw); } catch (_) { /* not encoded: as sent */ }
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 64);
}

// Which laptops are syncing: only requests the clinic key let through, so
// nobody on the Wi-Fi can add made-up laptops to the host's screen — and only
// the recent ones, at most MAX_LAPTOPS, so the list cannot grow without end.
function noteLaptop(req) {
  const device = headerText(req.headers['x-mmw-device'], 64);
  if (!device) return;
  const now = Date.now();
  for (const [k, l] of state.laptops) if (now - l.lastSeen >= SEEN_MS) state.laptops.delete(k);
  const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  // Taken out and put back, so the map stays in the order laptops were last seen.
  state.laptops.delete(device);
  state.laptops.set(device, { device, computer: computerName(req.headers['x-mmw-computer']) || 'A laptop', address, lastSeen: now });
  while (state.laptops.size > MAX_LAPTOPS) state.laptops.delete(state.laptops.keys().next().value);
}

async function onRequest(req, res, worker, env) {
  try {
    // A fixed origin: worker.js reads only the path and query, and the Host a
    // client sends is not this laptop's business.
    const u = new URL(req.url || '/', 'https://clinic-network.local');
    // The online pre-registration form is for patients on the internet, on
    // their own phones. The clinic network is the clinic's own laptops, and a
    // patient form served on it would be an unauthenticated way in to the
    // clinic's server for anyone on the Wi-Fi. Refused here, by the host,
    // before worker.js sees it.
    if (u.pathname === '/checkin' || u.pathname.startsWith('/checkin/')) {
      return refuse(req, res, 404, { ok: false, error: 'Online pre-registration is not available on the clinic network. Patients pre-register from the internet server\'s link; here, check them in at the front desk.' });
    }
    // The join proof (lan.learnPin): answers only with an HMAC under the key.
    if (u.pathname === '/lan/hello') {
      const nonce = u.searchParams.get('nonce') || '';
      if (req.method !== 'GET' || !/^[0-9a-f]{16,128}$/.test(nonce)) return refuse(req, res, 400, { ok: false, error: 'bad request' });
      const id = identity();
      return sendJson(res, 200, { ok: true, app: lan.APP_ID, host: id.hostId, name: id.name, proof: lan.helloProof(id.key, nonce, id.pin, id.hostId) });
    }
    const method = String(req.method || 'GET').toUpperCase();
    // Everything under /v1/ needs the clinic key (worker.js answers OPTIONS
    // before it looks). Without it, refused here, before a byte of the body
    // is kept.
    const api = u.pathname === '/v1/' || u.pathname.startsWith('/v1/');
    const authed = api && keyOk(req.headers.authorization, env.CLINIC_KEY);
    if (api && method !== 'OPTIONS' && !authed) return refuse(req, res, 401, { ok: false, error: 'unauthorized' });
    const body = (method === 'GET' || method === 'HEAD') ? null
      : await readBody(req, authed ? MAX_BODY : PRE_AUTH_BODY, { drain: authed });
    const headers = {};
    if (req.headers.authorization) headers.authorization = String(req.headers.authorization);
    if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
    const response = await worker.fetch(new Request(u.href, { method, headers, body }), env, { waitUntil() {}, passThroughOnException() {} });
    if (authed && method !== 'OPTIONS' && response.status !== 401) noteLaptop(req);
    const out = Buffer.from(await response.arrayBuffer());
    const h = {};
    response.headers.forEach((v, k) => { h[k] = v; });
    h['content-length'] = out.length;
    res.writeHead(response.status, h);
    res.end(out);
  } catch (e) {
    if (!res.headersSent) sendJson(res, e && e.status ? e.status : 500, { ok: false, error: (e && e.message) || 'error' });
    else res.destroy();
  }
}

// The limits above, applied as each connection arrives — before TLS starts
// on it (prepended, so the TLS server's own listener runs only for the ones
// let in). A connection over a limit is closed at once.
const isLoopback = (a) => a === '127.0.0.1' || a === '::1';
function limitConnections(server) {
  const byAddress = new Map();
  let others = 0;
  server.prependListener('connection', (sock) => {
    const a = String(sock.remoteAddress || '').replace(/^::ffff:/, '');
    if (isLoopback(a)) return;
    const n = byAddress.get(a) || 0;
    if (n >= PER_ADDRESS || others >= MAX_CONNECTIONS) { sock.destroy(); return; }
    byAddress.set(a, n + 1);
    others += 1;
    sock.once('close', () => {
      others -= 1;
      const left = (byAddress.get(a) || 1) - 1;
      if (left > 0) byAddress.set(a, left); else byAddress.delete(a);
    });
  });
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
}

/* ---------------- Announcing ---------------- */

// Every few seconds, to the private networks this laptop is on (see
// lan.hostBroadcastTargets): who it is, where, and the start of its
// fingerprint — never the key. And an answer to anyone asking "who is
// there?", sent straight back to them.
function startBeacon({ beaconPort, announce, version }) {
  stopBeacon();
  state.beaconError = '';
  const message = () => { const id = identity(); return lan.beaconMessage({ name: id.name, port: state.port, hostId: id.hostId, pin: id.pin, version }); };
  const targets = () => announce || lan.hostBroadcastTargets().map((address) => ({ address, port: beaconPort }));
  let sock;
  try {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  } catch (e) { state.beaconError = e.message; return; }
  sock.on('error', (e) => { state.beaconError = e.message; });
  sock.on('message', (buf, rinfo) => {
    if (!state.server || !lan.isQuery(buf)) return;
    sock.send(message(), rinfo.port, rinfo.address, () => { /* gone: ignore */ });
  });
  const send = () => {
    if (!state.server) return;
    const m = message();
    for (const t of targets()) sock.send(m, t.port, t.address, () => { /* a network without broadcast: ignore */ });
  };
  sock.bind(beaconPort, () => {
    try { sock.setBroadcast(true); } catch (e) { state.beaconError = e.message; }
    send();
  });
  state.beacon = sock;
  state.beaconTimer = setInterval(send, lan.BEACON_MS);
  if (state.beaconTimer.unref) state.beaconTimer.unref();
}
function stopBeacon() {
  if (state.beaconTimer) { clearInterval(state.beaconTimer); state.beaconTimer = null; }
  if (state.beacon) { try { state.beacon.close(); } catch (_) { /* closed */ } state.beacon = null; }
}

/* ---------------- The clinic's own Wi-Fi ---------------- */

// Hosting resumes by itself when the app opens — and a host laptop opened at
// a hotel, a café or on a phone's hotspot announced the clinic network's
// name and id there every few seconds, and took connections there. Those
// networks are private ones too (10.x, 192.168.x, 172.20.10.x), so "private"
// could not tell them from the clinic's router. So hosting remembers the
// networks it was hosted on — each by its range: 192.168.1.23 with
// 255.255.255.0 is 192.168.1.0/24, whatever address the router hands out
// next — and resumes by itself only on one of them. Elsewhere it waits,
// paused, and starts when the laptop is back on the clinic's Wi-Fi (also
// when the app opened before the Wi-Fi had connected); "Host here anyway"
// hosts where it is, and remembers that network too.
const MAX_NETWORKS = 8;
function networkOf(a) {
  const ip = String(a.address || '').split('.').map(Number), mask = String(a.netmask || '').split('.').map(Number);
  if (ip.length !== 4 || mask.length !== 4 || ![...ip, ...mask].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return '';
  const bits = mask.reduce((n, m) => n + m.toString(2).replace(/0/g, '').length, 0);
  return ip.map((n, i) => n & mask[i]).join('.') + '/' + bits;
}
// The clinic-kind networks this laptop is on now (lan.lanAddresses: private,
// not a virtual machine's or a VPN's).
const networksHere = () => [...new Set(lan.lanAddresses().filter((a) => a.preferred).map(networkOf).filter(Boolean))];
function savedNetworks() {
  try { const v = JSON.parse(getMeta('networks') || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch (_) { return []; }
}
function rememberNetworks() {
  const here = networksHere();
  if (here.length) setMeta('networks', JSON.stringify([...new Set([...here, ...savedNetworks()])].slice(0, MAX_NETWORKS)));
}
// None remembered (it was first hosted on no network of that kind): any.
function onClinicWifi() {
  const saved = savedNetworks();
  return !saved.length || networksHere().some((n) => saved.includes(n));
}
function stopWatch() {
  if (state.watch) { clearInterval(state.watch); state.watch = null; }
  state.paused = false;
}

/* ---------------- Start, stop, erase ---------------- */

function plainListenError(e, port) {
  if (e && e.code === 'EADDRINUSE') return `Port ${port} is already in use on this laptop by another program, so the clinic network cannot start. Close that program, or restart the laptop, and try again.`;
  if (e && (e.code === 'EACCES' || e.code === 'EPERM')) return 'This laptop did not let Mission Minded open its network port. Allow Mission Minded through the firewall, then try again.';
  return (e && e.message) || String(e);
}

// Overridable for tests only, like lan.defaults: the harness hosts on
// 127.0.0.1, takes any free port the first time, and announces to its own
// listeners instead of broadcasting.
const defaults = { bindHost: '0.0.0.0', firstPort: lan.DEFAULT_PORT, beaconPort: lan.BEACON_PORT, announce: null, shareAddress: '', networkCheckMs: 5000 };

// Start hosting, on every network this laptop is on. A clinic network keeps
// the port it was given the first time (47800 when free).
// selfDevice: this laptop's sync device id (db.ensureDeviceId), see state.
async function start({ name, port, bindHost = defaults.bindHost, beaconPort = defaults.beaconPort, announce = defaults.announce, version = '', selfDevice } = {}) {
  open();
  if (selfDevice) state.selfDevice = String(selfDevice);
  const cleanName = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  if (cleanName) setMeta('name', cleanName);
  if (state.server) return status();
  const id = identity();
  const worker = await loadWorker();
  const env = { DB: d1(state.sqlite), CLINIC_KEY: id.key };
  // Limits set here rather than left to Node's defaults, which change
  // between versions: a connection that never finishes its handshake or its
  // headers is let go, and a request has five minutes — a full 100 MB push
  // over a slow Wi-Fi fits. How many connections, by address: see
  // limitConnections.
  const server = https.createServer({
    key: getMeta('private_key'), cert: getMeta('cert'), minVersion: 'TLSv1.2',
    handshakeTimeout: HANDSHAKE_MS, headersTimeout: 30000, requestTimeout: 300000,
  }, (req, res) => { onRequest(req, res, worker, env); });
  limitConnections(server);
  const want = port != null ? port : (id.port || defaults.firstPort);
  let bound;
  try {
    bound = await listenOn(server, want, bindHost);
  } catch (e) {
    // The port it had is taken now: take another. The laptops that joined
    // find it again by its beacon (cloud.refind), so nobody re-enters anything.
    if (e && e.code === 'EADDRINUSE' && port == null) {
      try { bound = await listenOn(server, 0, bindHost); } catch (e2) { state.error = plainListenError(e2, want); throw new Error(state.error); }
    } else { state.error = plainListenError(e, want); throw new Error(state.error); }
  }
  server.on('error', (e) => { state.error = plainListenError(e, bound); });
  state.server = server;
  state.port = bound;
  state.error = '';
  stopWatch();
  setMeta('port', bound);
  setMeta('hosting', '1');
  rememberNetworks();
  startBeacon({ beaconPort, announce, version });
  return status();
}

// keepHosting: the app is quitting, not the administrator stopping — so the
// next start of the app hosts again by itself (see resume).
async function stop({ keepHosting = false } = {}) {
  stopWatch();
  stopBeacon();
  const server = state.server;
  state.server = null;
  state.laptops.clear();
  if (server) {
    await new Promise((r) => {
      server.close(() => r());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }
  if (!keepHosting && fs.existsSync(hubFile())) { open(); setMeta('hosting', '0'); }
  return status();
}

// Hosting survives a restart: if this laptop was hosting when the app
// closed (or the laptop went to sleep and was restarted), it hosts again —
// on the clinic's Wi-Fi (see onClinicWifi). Anywhere else it is paused, and
// starts by itself once the laptop is back there. onStarted(status): called
// whenever it does start, now or later, so the caller can point this
// laptop's own sync at the port it got.
async function resume(opts = {}) {
  if (!state.dir || !fs.existsSync(hubFile())) return null;
  open();
  if (getMeta('hosting') !== '1') return null;
  if (!state.server && !onClinicWifi()) { waitForClinicWifi(opts); return null; }
  let st;
  try { st = await start(opts); } catch (e) { state.error = e.message; return null; }
  if (opts.onStarted) { try { opts.onStarted(st); } catch (_) { /* the caller's own problem */ } }
  return st;
}
function waitForClinicWifi(opts) {
  stopWatch();
  state.paused = true;
  state.watch = setInterval(() => {
    if (state.server || !state.sqlite) { stopWatch(); return; }
    if (!onClinicWifi()) return;
    stopWatch();
    resume(opts).catch((e) => { state.error = (e && e.message) || String(e); });
  }, defaults.networkCheckMs);
  if (state.watch.unref) state.watch.unref();
}

// The clinic network's data and identity, gone. The laptops keep their own
// records; what they were joined to no longer exists, and a clinic network
// hosted here afterwards is a new one, with a new certificate and key.
async function erase() {
  if (state.server) throw new Error('Stop hosting first.');
  stopWatch();
  closeFile();
  if (state.dir) for (const suffix of ['', '-wal', '-shm']) fs.rmSync(hubFile() + suffix, { force: true });
  return status();
}

// The app is quitting: everything closed at once (Electron does not wait for
// a promise here), and the hosting flag left as it was, so the next start of
// the app hosts again.
function shutdown() {
  stopWatch();
  stopBeacon();
  const server = state.server;
  state.server = null;
  state.laptops.clear();
  if (server) {
    try { server.close(); if (server.closeAllConnections) server.closeAllConnections(); } catch (_) { /* closing anyway */ }
  }
  closeFile();
}

/* ---------------- The Windows firewall ---------------- */

// The installer is per-user (nsis perMachine: false), so it cannot add a
// firewall rule; Windows asks instead, the first time this laptop hosts
// ("Windows Defender Firewall has blocked some features of this app"). For a
// host where that was missed or cancelled, this adds the same rule ticking
// "Private networks" adds: inbound, this program, Private networks only —
// never Public. A cancelled dialog leaves rules that BLOCK this program, and
// a block rule wins over any allow, so this program's inbound block rules go
// first. It runs behind Windows' own permission prompt (UAC), and the
// elevated copy is handed its whole script on the command line, encoded — no
// file is written that anything could change before it runs.
const FIREWALL_RULE = 'Mission Minded clinic network';
function firewallScript(exePath) {
  const p = String(exePath).replace(/'/g, "''");
  return [
    `$p = '${p}'`,
    "Get-NetFirewallApplicationFilter -Program $p -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue"
      + " | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule -ErrorAction SilentlyContinue",
    `Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue`,
    `New-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -Description 'Lets the other clinic laptops sync with this one on a Private network.'`
      + ' -Direction Inbound -Action Allow -Program $p -Profile Private -ErrorAction Stop | Out-Null',
  ].join('; ');
}
function firewallCommand(exePath) {
  const inner = Buffer.from(firewallScript(exePath), 'utf16le').toString('base64');
  const outer = "$r = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden"
    + ` -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${inner}'; exit $r.ExitCode`;
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', outer] };
}
function allowThroughFirewall(exePath, run = require('child_process').execFile) {
  const { file, args } = firewallCommand(exePath);
  return new Promise((resolve, reject) => {
    run(file, args, { windowsHide: true, timeout: 180000 }, (err) => {
      if (err) reject(new Error('Windows did not change the firewall — the permission prompt was cancelled, or this account may not change it. Follow the steps on this screen instead, or ask whoever looks after this laptop.'));
      else resolve({ done: true });
    });
  });
}

/* ---------------- What the Cloud tab shows ---------------- */

// The address other laptops reach this one at, for the connection code: the
// first real Wi-Fi or Ethernet address. '' when this laptop is on no network.
function shareUrl() {
  const a = defaults.shareAddress ? { address: defaults.shareAddress } : lan.lanAddresses()[0];
  return a && state.port ? `https://${a.address}:${state.port}` : '';
}
// What this laptop's own sync client connects to while it hosts.
function ownTarget() {
  const id = identity();
  return { url: `https://127.0.0.1:${state.port || id.port}`, key: id.key, lan: { pin: id.pin, hostId: id.hostId, name: id.name } };
}
// The host id this laptop has (or would have) — '' while there is no hub file.
function ownHostId() {
  if (state.sqlite) return getMeta('host_id');
  if (!state.dir || !fs.existsSync(hubFile())) return '';
  open();
  return getMeta('host_id');
}
const runningHostId = () => (state.server ? ownHostId() : '');

function status() {
  const hasData = !!state.dir && fs.existsSync(hubFile());
  if (!hasData) {
    return { running: false, hasData: false, name: '', port: 0, hostId: '', pin: '', addresses: [], laptops: [], error: state.error, beaconError: '' };
  }
  const id = identity();
  const now = Date.now();
  const laptops = [...state.laptops.values()].filter((l) => now - l.lastSeen < SEEN_MS)
    .sort((a, b) => Number(b.device === state.selfDevice) - Number(a.device === state.selfDevice) || a.computer.localeCompare(b.computer))
    .map((l) => ({ computer: l.computer, address: l.address, self: !!state.selfDevice && l.device === state.selfDevice, lastSeen: new Date(l.lastSeen).toISOString() }));
  const port = state.port || id.port;
  return {
    running: !!state.server, hasData, hosting: getMeta('hosting') === '1',
    name: id.name, port, hostId: id.hostId, pin: id.pin, pinShown: lan.showPin(id.pin),
    addresses: lan.lanAddresses().map((a) => ({ address: a.address, iface: a.iface, preferred: a.preferred, url: port ? `https://${a.address}:${port}` : '' })),
    laptops, error: state.error, beaconError: state.beaconError, computer: os.hostname(),
    // Waiting for the clinic's Wi-Fi (see resume): the networks it hosts on,
    // and the ones this laptop is on now.
    paused: !state.server && state.paused, networks: savedNetworks(), networksHere: networksHere(),
  };
}

module.exports = {
  HUB_FILE, defaults, init, open, identity, start, stop, resume, erase, shutdown,
  status, shareUrl, ownTarget, ownHostId, runningHostId, networkOf,
  makeClinicKey, makeCertificate, d1, loadWorker, keyOk, computerName, MAX_LAPTOPS, PRE_AUTH_BODY, MAX_CONNECTIONS, PER_ADDRESS, HANDSHAKE_MS,
  firewallScript, firewallCommand, allowThroughFirewall, FIREWALL_RULE,
};
