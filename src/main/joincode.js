'use strict';
/*
 * v0.0.24 — the clinic key people type to join a clinic network: short
 * (six digits by default, "482-913"), and safe to be short.
 *
 * Before 0.0.24 the key typed in WAS the network's password: every laptop
 * sent it with each sync, and the host proved it held it by answering a
 * challenge with a proof made from it. Anyone on the Wi-Fi can ask for that
 * proof, and from it a short key is guessed offline in minutes — so the key
 * had to be 25 characters long, and directors could not type it.
 *
 * Now the short key only lets a laptop JOIN. The laptop and the host run a
 * password-authenticated key exchange (SPAKE2, RFC 9382, here over the 2048-
 * bit MODP group of RFC 3526): each learns whether the other typed the same
 * key, and nobody watching — or pretending to be either side — learns
 * anything that lets them test a guess offline. Each try is one guess, made
 * against the host, which counts and limits them (hub.js). Once both have
 * shown they hold the key, the host sends the network's real password — long
 * and random, never typed — sealed under the key the exchange agreed.
 *
 * The exchange is bound to the host's id and to the fingerprint of the
 * certificate the laptop saw, so a look-alike host, or one in the middle,
 * cannot pass a real host's answer off as its own.
 */
const crypto = require('crypto');

const VERSION = 'mmw-join-1';
const dh = crypto.getDiffieHellman('modp14');
const P = BigInt('0x' + dh.getPrime('hex'));
const Q = (P - 1n) / 2n;          // P is a safe prime; g = 2 generates the subgroup of order Q
const G = 2n;
const BYTES = 256;                // 2048 bits

function modPow(b, e, m) {
  let r = 1n;
  b %= m; if (b < 0n) b += m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    e >>= 1n;
    b = (b * b) % m;
  }
  return r;
}
const toHex = (n) => n.toString(16).padStart(BYTES * 2, '0');
const toBuf = (n) => Buffer.from(toHex(n), 'hex');
function fromHex(h) {
  if (typeof h !== 'string' || !/^[0-9a-f]{1,512}$/i.test(h)) return null;
  return BigInt('0x' + h);
}
// The Jacobi symbol (a | n), n odd. For the safe prime P, (v | P) = 1 says v
// is a square mod P — exactly the subgroup of order Q — in a fraction of a
// millisecond, where v^Q mod P takes some 25 ms: a host answering anyone on
// the Wi-Fi must not spend that before it has counted the try.
function jacobi(a, n) {
  a %= n; if (a < 0n) a += n;
  let t = 1;
  while (a !== 0n) {
    while ((a & 1n) === 0n) { a >>= 1n; const r = n & 7n; if (r === 3n || r === 5n) t = -t; }
    [a, n] = [n, a];
    if ((a & 3n) === 3n && (n & 3n) === 3n) t = -t;
    a %= n;
  }
  return n === 1n ? t : 0;
}
// The inverse mod P (extended Euclid), so M^-w is (M^w)^-1 rather than a
// full-size power.
function modInv(a, m) {
  let [r0, r1] = [((a % m) + m) % m, m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return ((s0 % m) + m) % m;
}
// In the group: 1 < v < P-1 and of order Q. A value outside it (a small-
// subgroup element above all) is refused before anything is made from it.
const inGroup = (v) => typeof v === 'bigint' && v > 1n && v < P - 1n && jacobi(v, P) === 1;

// M and N: fixed group elements nobody knows the logarithm of — the hash of a
// label, squared into the subgroup.
function hashToGroup(label) {
  const parts = [];
  for (let i = 0; i < 9; i++) parts.push(crypto.createHash('sha256').update(`${VERSION}|${label}|${i}`).digest());
  const v = BigInt('0x' + Buffer.concat(parts).toString('hex')) % P;
  return modPow(v, 2n, P);
}
const M = hashToGroup('M');
const N = hashToGroup('N');

/* ---------------- The code itself ---------------- */

// As typed, the way both sides read it: spaces, dashes, dots and capitals do
// not matter — "482-913", "482 913" and "482913" are one code.
function canonCode(code) {
  return String(code == null ? '' : code).replace(/[\s\-‐-―_.]+/g, '').toLowerCase();
}
// A new code: six digits, shown as "482-913".
function makeCode() {
  const d = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  return d.slice(0, 3) + '-' + d.slice(3);
}
// How a code is shown: six digits in two groups of three, anything else as kept.
function showCode(code) {
  const c = canonCode(code);
  return /^\d{6}$/.test(c) ? c.slice(0, 3) + '-' + c.slice(3) : String(code == null ? '' : code).trim().replace(/\s+/g, ' ');
}
// What is wrong with a code the clinic chooses, or '' when nothing is.
function codeProblem(code) {
  const c = canonCode(code);
  if (c.length < 4) return 'Choose a clinic key of at least 4 numbers or letters — 6 or more is safer. Or leave it blank, and the app makes one.';
  // 100, as a key chosen in 0.0.23 could be — it is kept as the clinic key.
  if (c.length > 100) return 'That clinic key is too long — 100 characters at most.';
  if (!/^[\x21-\x7e]+$/.test(c)) return 'Use plain numbers and letters in the clinic key — no accented letters or symbols another laptop\'s keyboard may not type the same way.';
  return '';
}

/* ---------------- The exchange ---------------- */

// The code as a number, bound to the host it is for.
function wOf(code, hostId) {
  const k = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(canonCode(code), 'utf8'), Buffer.from(VERSION + ' w'), Buffer.from(String(hostId || '')), 32));
  const w = BigInt('0x' + k.toString('hex')) % Q;
  return w === 0n ? 1n : w;
}
const randomExp = () => {
  const x = BigInt('0x' + crypto.randomBytes(32).toString('hex')) % Q;
  return x === 0n ? 1n : x;
};
function lp(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(b.length));
  return Buffer.concat([len, b]);
}
// The transcript: everything both sides saw, in one order. The pin is the
// certificate fingerprint the laptop was shown — the host puts its own.
function keys({ hostId, pin, X, Y, Z, w }) {
  const tt = Buffer.concat([
    lp(VERSION), lp('laptop'), lp(String(hostId || '')), lp(String(pin || '').toLowerCase()),
    lp(toBuf(M)), lp(toBuf(N)), lp(toBuf(X)), lp(toBuf(Y)), lp(toBuf(Z)), lp(toBuf(w)),
  ]);
  const K = crypto.createHash('sha256').update(tt).digest();
  const d = (info) => Buffer.from(crypto.hkdfSync('sha256', K, Buffer.alloc(0), Buffer.from(VERSION + ' ' + info), 32));
  const kcA = d('confirm laptop'), kcB = d('confirm host'), ke = d('seal');
  return {
    ke,
    cA: crypto.createHmac('sha256', kcA).update(tt).digest('hex'),
    cB: crypto.createHmac('sha256', kcB).update(tt).digest('hex'),
  };
}
function sameHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The laptop's first message.
function laptopStart(code, hostId) {
  const w = wOf(code, hostId);
  const x = randomExp();
  const X = (modPow(G, x, P) * modPow(M, w, P)) % P;
  return { state: { w, x, X, hostId: String(hostId || '') }, X: toHex(X) };
}
// The host's answer to it: Y and the host's confirmation, and what it keeps
// to check the laptop's. null when X is not a group element.
function hostAnswer(code, hostId, pin, Xhex) {
  const X = fromHex(Xhex);
  if (!inGroup(X)) return null;
  const w = wOf(code, hostId);
  const y = randomExp();
  const Y = (modPow(G, y, P) * modPow(N, w, P)) % P;
  const Z = modPow((X * modInv(modPow(M, w, P), P)) % P, y, P);
  const k = keys({ hostId, pin, X, Y, Z, w });
  return { Y: toHex(Y), cB: k.cB, expectA: k.cA, ke: k.ke };
}
// The laptop's check of the host's answer: { cA, ke } when the host holds
// the same code, null when it does not (or the answer is not well formed).
function laptopFinish(state, pin, Yhex, cB) {
  const Y = fromHex(Yhex);
  if (!state || !inGroup(Y)) return null;
  const Z = modPow((Y * modInv(modPow(N, state.w, P), P)) % P, state.x, P);
  const k = keys({ hostId: state.hostId, pin, X: state.X, Y, Z, w: state.w });
  if (!sameHex(cB, k.cB)) return null;
  return { cA: k.cA, ke: k.ke };
}

// The network's password, sealed for the laptop under the agreed key.
function seal(ke, sid, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ke, iv);
  c.setAAD(Buffer.from(VERSION + '|' + sid));
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function unseal(ke, sid, text) {
  try {
    const b = Buffer.from(String(text || ''), 'base64');
    if (b.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', ke, b.subarray(0, 12));
    d.setAAD(Buffer.from(VERSION + '|' + sid));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch (_) { return null; }
}

module.exports = {
  VERSION, canonCode, makeCode, showCode, codeProblem,
  laptopStart, hostAnswer, laptopFinish, sameHex, seal, unseal,
  // for the tests
  _group: { P, Q, G, M, N, modPow, inGroup, jacobi, modInv },
};
