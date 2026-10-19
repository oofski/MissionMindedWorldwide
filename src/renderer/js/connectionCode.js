// Reading a connection code: the one string that carries a clinic's sync-server
// address and clinic key, so the next laptop is connected by pasting it instead
// of retyping a workers.dev address and a long passphrase.
//
// The code is made in the main process (src/main/cloud.js connectionCode), on
// a laptop that is already connected, and only for an administrator who asks
// to see it. It is read here by Admin → Cloud and by the sign-in screen's
// "Join a clinic". Reading gives back exactly what typing would have — an
// address and a key — and both screens then connect the way they always have,
// so a code can never connect anything the two boxes could not.
//
// Not encryption: the code IS the key in another spelling, which is why the
// screens that show it call it a password. The harness pins this reader to the
// main-process writer, so the two cannot drift apart.

export const CODE_PREFIX = 'MMW1-';

// Each refusal says what the thing pasted actually is, and what to do instead,
// because the person pasting it is usually not the person who made it.
const DAMAGED = 'That connection code is incomplete or damaged. Copy the whole code again from the laptop that is already connected.';

/**
 * The address and key a pasted connection code carries, or an Error whose
 * message can be shown as it is.
 *
 * Forgiving about what copying adds — line breaks and spaces from a chat
 * window, surrounding quotes, a lower-case prefix — and strict about the rest:
 * a code from another program, another format version, or a code that has
 * lost characters is refused rather than half-read.
 */
export function readConnectionCode(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, '').replace(/^["'`<]+|["'`>]+$/g, '');
  if (!s) throw new Error('Paste the connection code first.');
  const m = /^MMW(\d+)-(.*)$/i.exec(s);
  if (!m) {
    if (/^https?:\/\//i.test(s) || /\.workers\.dev/i.test(s)) {
      throw new Error('That is a server address, not a connection code. Type it in the address box instead, with the clinic key.');
    }
    throw new Error('That is not a connection code. A connection code starts with ' + CODE_PREFIX + ' and is copied from Admin → Cloud on a laptop that is already connected.');
  }
  if (m[1] !== '1') {
    throw new Error('That connection code was made by a different version of the app. Update both laptops to the same version, then copy the code again.');
  }
  const body = m[2];
  if (!body || body.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(body)) throw new Error(DAMAGED);
  let payload;
  try {
    const b64 = body.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_) {
    throw new Error(DAMAGED);
  }
  if (!payload || typeof payload !== 'object' || typeof payload.u !== 'string' || typeof payload.k !== 'string' || !payload.k.trim()) {
    throw new Error(DAMAGED);
  }
  let url;
  try { url = new URL(payload.u); } catch (_) { throw new Error(DAMAGED); }
  // https only, as main's testConnection insists, apart from this computer
  // itself (a developer's `wrangler dev`): a code naming a plain http:// server
  // would hand the key over unprotected, so it is refused before anything is sent.
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'http:' && !loopback) {
    throw new Error('That connection code names a plain http:// server, which would send the clinic key unprotected. Connect the first laptop to the https:// address, then copy the code again.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(DAMAGED);
  return { url: url.origin, key: payload.k };
}
