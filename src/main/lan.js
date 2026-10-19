'use strict';

// The clinic network (v0.0.17): what a laptop needs to find the laptop that
// hosts the clinic's sync server on a plain Wi-Fi router, and to talk to it
// safely with no internet at all.
//
// Dr. Trinh tried exactly that — one router, no internet — and "the laptops
// saw each other, but the software did not": the only way to sync was an
// internet server. Now one laptop hosts the same sync server (src/main/hub.js
// runs the real cloud/worker.js), and every laptop, the host included, syncs
// with it through the same cloud.js client as online. This module is only the
// part that differs on a local network:
//
//   - finding the host: it announces itself by UDP broadcast (a "beacon"),
//     and answers a "who is there?" sent the same way;
//   - trusting the host: its certificate is self-signed, so no browser-style
//     authority vouches for it. Laptops pin it by its SHA-256 fingerprint
//     instead, and refuse a connection whose certificate does not match
//     BEFORE anything — the clinic key included — is sent;
//   - saying what went wrong in words a clinic director can act on: host not
//     found, its firewall blocking, the wrong certificate, the wrong key.
//
// No Electron here, so the harness exercises it as it is.

const tls = require('tls');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

const APP_ID = 'mmw-clinic-network';
const DEFAULT_PORT = 47800;   // TCP: the host's HTTPS sync server
const BEACON_PORT = 47801;    // UDP: the host's announcements, and "who is there?"
const BEACON_MS = 3000;
// How much of the fingerprint a beacon carries: enough to tell two hosts on
// one Wi-Fi apart, and to skip a look-alike before connecting. The full
// fingerprint is checked on every connection; a beacon is never trusted alone.
const FP_PREFIX = 16;

/* ---------------- Fingerprints ---------------- */

// Lower-case hex with no separators, however it was written ("AB:CD…" from
// Node, "AB12 CD34…" from the host screen). '' when it is not a SHA-256.
function normPin(v) {
  const s = String(v == null ? '' : v).replace(/[^0-9a-f]/gi, '').toLowerCase();
  return s.length === 64 ? s : '';
}
const isPin = (v) => normPin(v) !== '';
// As the host screen shows it: sixteen groups of four, to read out or compare.
function showPin(pin, groups = 16) {
  const p = normPin(pin).toUpperCase();
  return p ? p.match(/.{4}/g).slice(0, groups).join(' ') : '';
}

/* ---------------- Beacons ---------------- */

const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

// What a host announces: who it is and where, never how to get in. The clinic
// key is not in it, and neither is the whole fingerprint.
function beaconMessage({ name, port, hostId, pin, version }) {
  return Buffer.from(JSON.stringify({
    app: APP_ID, v: 1, name: cleanText(name, 80), port: Number(port), host: String(hostId || ''),
    fp: normPin(pin).slice(0, FP_PREFIX), ver: cleanText(version, 20),
  }), 'utf8');
}
const QUERY = Buffer.from(JSON.stringify({ app: APP_ID, v: 1, q: 1 }), 'utf8');

function parseJson(buf) {
  if (!buf || buf.length > 2048) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { return null; }
}
function isQuery(buf) {
  const m = parseJson(buf);
  return !!m && m.app === APP_ID && m.q === 1;
}
// A beacon as a joining laptop uses it, or null for anything else on the port.
// The address is where the datagram came from, not anything it claims.
function readBeacon(buf, rinfo) {
  const m = parseJson(buf);
  if (!m || m.app !== APP_ID || m.v !== 1 || m.q) return null;
  const port = Number(m.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof m.host !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(m.host)) return null;
  if (typeof m.fp !== 'string' || !/^[0-9a-f]{16}$/.test(m.fp)) return null;
  const address = rinfo && rinfo.address;
  if (!net.isIPv4(address)) return null;
  return {
    hostId: m.host, name: cleanText(m.name, 80) || 'Clinic network', port, fp: m.fp,
    address, url: `https://${address}:${port}`, version: cleanText(m.ver, 20),
  };
}

/* ---------------- This laptop's addresses ---------------- */

// Adapters a clinic's laptops do not meet on: virtual machines, containers,
// VPNs. Listed after the real Wi-Fi or Ethernet address, not hidden — a
// clinic could have a reason.
const VIRTUAL = /vethernet|virtualbox|vmware|vbox|docker|wsl|hyper-v|tailscale|zerotier|utun|^br-|^veth|^virbr/i;
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
function lanAddresses() {
  const out = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces() || {})) {
    for (const a of list || []) {
      if (!(a.family === 'IPv4' || a.family === 4) || a.internal || /^169\.254\./.test(a.address)) continue;
      out.push({ address: a.address, netmask: a.netmask, iface, preferred: PRIVATE.test(a.address) && !VIRTUAL.test(iface) });
    }
  }
  return out.sort((x, y) => Number(y.preferred) - Number(x.preferred));
}
// Where a broadcast goes: everywhere this laptop's default route reaches, and
// each network's own broadcast address. Windows sends 255.255.255.255 out of
// one adapter only, so a laptop with Wi-Fi and a cable would otherwise be
// heard on just one of them.
function broadcastTargets() {
  const set = new Set(['255.255.255.255']);
  for (const a of lanAddresses()) {
    const ip = a.address.split('.').map(Number), mask = String(a.netmask || '').split('.').map(Number);
    if (ip.length === 4 && mask.length === 4 && mask.every((n) => n >= 0 && n <= 255)) set.add(ip.map((n, i) => (n | (~mask[i] & 255))).join('.'));
  }
  return [...set];
}

/* ---------------- Finding hosts ---------------- */

// Overridable for tests only (the harness runs hosts on 127.0.0.1 and private
// ports, so nothing it does is broadcast).
const defaults = { beaconPort: BEACON_PORT, queryPort: BEACON_PORT, targets: null };

// One listener per port, shared by everything in this process that wants to
// hear beacons, so a joined laptop's re-find and an open Join screen never
// fight over the port.
const listeners = new Map();
function listen(onBeacon, { port = defaults.beaconPort } = {}) {
  let L = listeners.get(port);
  if (!L) {
    L = { subs: new Set(), sock: null, error: '' };
    listeners.set(port, L);
    try {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('message', (buf, rinfo) => {
        const b = readBeacon(buf, rinfo);
        if (b) for (const f of [...L.subs]) { try { f(b); } catch (_) { /* a listener's own problem */ } }
      });
      // Port taken without sharing, or not allowed: hosts are still found by
      // the answers to "who is there?" (see scan), which come to another port.
      sock.on('error', (e) => {
        L.error = e.message; L.sock = null;
        try { sock.close(); } catch (_) { /* closed */ }
        // The next one to listen tries the port afresh.
        if (listeners.get(port) === L) listeners.delete(port);
      });
      sock.bind(port, () => { try { sock.setBroadcast(true); } catch (_) { /* receiving only */ } });
      if (sock.unref) sock.unref();
      L.sock = sock;
    } catch (e) { L.error = e.message; }
  }
  L.subs.add(onBeacon);
  return () => {
    L.subs.delete(onBeacon);
    if (!L.subs.size && listeners.get(port) === L) {
      listeners.delete(port);
      if (L.sock) { try { L.sock.close(); } catch (_) { /* closed */ } }
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The hosts on this network, heard within `ms`: their beacons, and their
// answers to a "who is there?" broadcast from this laptop. The answers come
// back to the port the question went from, which is what lets a laptop whose
// firewall drops unasked-for broadcasts still find the host (Windows lets a
// reply to its own broadcast in). One entry per host, with every address it
// was heard at — a host on Wi-Fi and a cable is one host.
async function scan({ ms = 2500, port = defaults.beaconPort, queryPort = defaults.queryPort, targets = defaults.targets } = {}) {
  const found = new Map();
  const add = (b) => {
    const had = found.get(b.hostId);
    if (!had) { found.set(b.hostId, { ...b, urls: [b.url] }); return; }
    if (!had.urls.includes(b.url)) had.urls.push(b.url);
  };
  const stop = listen(add, { port });
  const q = dgram.createSocket('udp4');
  q.on('message', (buf, rinfo) => { const b = readBeacon(buf, rinfo); if (b) add(b); });
  const bound = await new Promise((res) => { q.once('error', () => res(false)); q.bind(0, () => res(true)); });
  if (bound) {
    try { q.setBroadcast(true); } catch (_) { /* unicast targets still work */ }
    for (const t of targets || broadcastTargets()) q.send(QUERY, queryPort, t, () => { /* unreachable network: ignore */ });
  }
  await sleep(ms);
  stop();
  try { q.close(); } catch (_) { /* closed */ }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address));
}

/* ---------------- Talking to the host, pinned ---------------- */

// fetch() cannot be told which certificate to accept, so the clinic network
// does its own TLS: connect, read the certificate the host presents, and
// compare its fingerprint with the pin BEFORE the HTTP request is even
// created. A mismatch closes the connection with nothing sent — no clinic
// key, no record. Chain checks are off because there is no chain (the host
// signs its own certificate); the pin is the check, and it is stricter.
function timeoutError() { return Object.assign(new Error('The operation was aborted due to timeout'), { name: 'AbortError', code: 'ETIMEDOUT', network: true }); }

function tlsConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = tls.connect({ host, port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], ...(net.isIP(host) ? {} : { servername: host }) });
    const fail = (e) => {
      if (done) return; done = true; clearTimeout(to);
      if (e && typeof e === 'object') e.network = true;
      sock.destroy(); reject(e);
    };
    const to = setTimeout(() => fail(timeoutError()), timeoutMs);
    sock.once('secureConnect', () => { if (done) return; done = true; clearTimeout(to); resolve(sock); });
    sock.once('error', fail);
  });
}
const presentedPin = (sock) => { const c = sock.getPeerCertificate(); return normPin(c && c.fingerprint256); };

function hostPort(url) {
  const u = new URL(url);
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 443), path: (u.pathname || '/') + (u.search || '') };
}

// One request: { status, text, pin } — pin being the fingerprint the host
// presented. Without a pin, nothing is checked (used only by learnPin, which
// sends no key, and by peerPin).
async function request(url, { method = 'GET', headers = {}, body, pin, timeoutMs = 12000 } = {}) {
  const { host, port, path } = hostPort(url);
  const deadline = Date.now() + timeoutMs;
  const sock = await tlsConnect(host, port, timeoutMs);
  const presented = presentedPin(sock);
  if (pin && presented !== normPin(pin)) {
    sock.destroy();
    throw Object.assign(new Error('The host\'s certificate does not match.'), { pinMismatch: true, presented });
  }
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
    const h = { ...headers, connection: 'close' };
    if (payload) h['content-length'] = String(payload.length);
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(to); sock.destroy(); fn(v); };
    // No agent: the request runs on the socket just checked, and on no other.
    const req = http.request({ host, port, path, method, headers: h, createConnection: () => sock });
    const to = setTimeout(() => { req.destroy(); finish(reject, timeoutError()); }, Math.max(1, deadline - Date.now()));
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), pin: presented }));
      res.on('error', (e) => { e.network = true; finish(reject, e); });
    });
    req.on('error', (e) => { if (e && typeof e === 'object') e.network = true; finish(reject, e); });
    if (payload) req.end(payload); else req.end();
  });
}

// The fingerprint a host at `url` presents. Only a TLS handshake: nothing is
// sent. Used before following a host to a new address (see cloud.refind).
async function peerPin(url, timeoutMs = 4000) {
  const { host, port } = hostPort(url);
  const sock = await tlsConnect(host, port, timeoutMs);
  const p = presentedPin(sock);
  sock.destroy();
  return p;
}

/* ---------------- Joining without a code ---------------- */

// Picked from the list of hosts found, or typed as an address, a host comes
// with no pin — and a beacon proves nothing, since anyone on the Wi-Fi can
// send one. So before this laptop sends the clinic key, the host proves it
// already has it: this laptop sends a random challenge, and the host answers
// with an HMAC of it under the key, bound to the certificate it is presenting
// and its host id. Only a laptop holding the key can answer, so a look-alike
// learns nothing — not even a wrong key. The host's key is made by the app
// (see hub.makeClinicKey) and is far too long to guess from an answer.
function helloProof(key, nonce, pin, hostId) {
  return crypto.createHmac('sha256', String(key)).update(`${APP_ID} hello|${nonce}|${normPin(pin)}|${hostId || ''}`).digest('hex');
}
function sameHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function learnPin(url, key, { expectPrefix = '', expectHost = '', timeoutMs = 8000 } = {}) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const r = await request(new URL('/lan/hello?nonce=' + nonce, url).href, { timeoutMs });
  if (expectPrefix && !r.pin.startsWith(String(expectPrefix).toLowerCase())) {
    throw Object.assign(new Error('The host\'s certificate does not match.'), { pinMismatch: true, presented: r.pin });
  }
  let j = null;
  try { j = JSON.parse(r.text); } catch (_) { /* not ours */ }
  if (!j || j.app !== APP_ID || typeof j.proof !== 'string') throw Object.assign(new Error('Not a clinic network host.'), { notHub: true });
  if (expectHost && j.host !== expectHost) {
    throw Object.assign(new Error('The host\'s certificate does not match.'), { pinMismatch: true, presented: r.pin });
  }
  if (!sameHex(j.proof, helloProof(key, nonce, r.pin, j.host))) {
    throw Object.assign(new Error('unauthorized'), { status: 401 });
  }
  return { pin: r.pin, hostId: typeof j.host === 'string' ? j.host : '', name: cleanText(j.name, 80) };
}

/* ---------------- What went wrong, in plain words ---------------- */

const MESSAGES = {
  not_found: (a) => `No clinic network host answered at ${a}. Check the host laptop is on, has Mission Minded open and its Cloud tab says it is hosting — and that this laptop is on the same Wi-Fi.`,
  blocked: (a) => `The host laptop is on this Wi-Fi, but its firewall is blocking the connection to ${a}. On the host laptop, allow Mission Minded through the firewall for Private networks, and set its Wi-Fi to a Private network (its Cloud tab says how).`,
  not_hosting: (a) => `A computer answered at ${a}, but Mission Minded is not hosting there. Check the host laptop has the app open and its Cloud tab says it is hosting.`,
  timeout: (a) => `The clinic network host at ${a} did not answer in time. Check this laptop is on the clinic's Wi-Fi, then try again.`,
  pin_mismatch: (a) => `The laptop at ${a} is not this clinic's host: its security certificate does not match, so nothing was sent to it. If the clinic network was set up again on the host, copy a new connection code from it.`,
  wrong_key: () => 'The host answered, but refused the clinic key. Copy the connection code again from the host laptop, or type the key exactly as its Cloud tab shows it.',
  not_mmw: (a) => `Something answered at ${a}, but it is not a Mission Minded clinic network host.`,
};
const say = (code, addr) => MESSAGES[code](addr);

// The code for a failed request — what explain() and the network test say.
function classify(err) {
  if (!err) return 'not_mmw';
  if (err.pinMismatch) return 'pin_mismatch';
  if (err.status === 401) return 'wrong_key';
  if (err.notHub) return 'not_mmw';
  if (err.network && err.code === 'ECONNREFUSED') return 'not_hosting';
  if (err.network && (err.name === 'AbortError' || err.code === 'ETIMEDOUT')) return 'timeout';
  if (err.network) return 'not_found';
  return '';
}
function explain(err, addr) {
  const code = classify(err);
  return code ? say(code, addr) : ((err && err.message) || String(err));
}

// "Test the clinic network": which of the things that go wrong on a local
// network this is. Two of them look the same from here — a host that is off
// and a host whose firewall drops the connection both just never answer — so
// the host's beacon tells them apart: heard, the host is on this Wi-Fi and
// something is stopping the connection; not heard, it is not here at all.
// Heard at ANOTHER address, it moved (the router gave it another, or its port
// was taken): movedTo says where, for the caller to follow once the
// certificate there is checked (cloud.testClinicNetwork).
//
// The key is sent only to a pinned host. Without a pin this says only why
// the host does not answer, or that it does ('unpinned').
async function diagnose({ url, key, pin, hostId, listenMs = 3500, timeoutMs = 6000, scanOpts = {} }) {
  const addr = (() => { try { return new URL(url).host; } catch (_) { return String(url); } })();
  const origin = (() => { try { return new URL(url).origin; } catch (_) { return String(url); } })();
  const heard = scan({ ms: listenMs, ...scanOpts });
  const result = (code, extra = {}) => ({ ok: code === 'ok', code, message: code === 'ok' || code === 'unpinned' ? '' : say(code, addr), ...extra });
  let health;
  try {
    const r = await request(new URL('/health', url).href, { pin, timeoutMs });
    try { health = JSON.parse(r.text); } catch (_) { health = null; }
    if (r.status !== 200 || !health || health.ok !== true || health.service !== 'mmw-sync') { heard.catch(() => {}); return result('not_mmw'); }
  } catch (e) {
    const code = classify(e);
    if (code === 'timeout' || code === 'not_found' || code === 'not_hosting') {
      const hosts = await heard.catch(() => []);
      const here = hosts.find((h) => (hostId ? h.hostId === hostId : h.address === hostPort(url).host));
      if (here && !here.urls.includes(origin)) return result(code, { movedTo: here.urls[0] });
      if (code === 'not_hosting') return result('not_hosting');
      return result(here ? 'blocked' : 'not_found');
    }
    heard.catch(() => {});
    return result(code || 'not_mmw');
  }
  heard.catch(() => {});
  if (!normPin(pin) || !key) return result('unpinned', { health });
  try {
    const r = await request(new URL('/v1/pull?since=&limit=1', url).href, { pin, timeoutMs, headers: { authorization: 'Bearer ' + key } });
    if (r.status === 401) return result('wrong_key');
    if (r.status !== 200) return result('not_mmw');
  } catch (e) { return result(classify(e) || 'not_mmw'); }
  return result('ok', { health });
}

module.exports = {
  APP_ID, DEFAULT_PORT, BEACON_PORT, BEACON_MS, FP_PREFIX, defaults,
  normPin, isPin, showPin,
  beaconMessage, readBeacon, isQuery, QUERY,
  lanAddresses, broadcastTargets, listen, scan,
  request, peerPin, helloProof, learnPin,
  classify, explain, diagnose, MESSAGES,
};
