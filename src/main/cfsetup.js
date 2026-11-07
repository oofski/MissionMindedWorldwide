'use strict';

// v0.0.22: the clinic's sync server, set up on Cloudflare from the app.
//
// By hand it was ten steps in Cloudflare's dashboard — make a database, make
// a Worker, paste worker.js into it, bind the database as DB, add CLINIC_KEY,
// copy the address — then the address and the key to type on every laptop.
// Now an administrator makes one token in Cloudflare (tokenUrl opens the token
// page with its three permissions already chosen), pastes it into Admin →
// Cloud, and the app does the rest with Cloudflare's API: the database, the
// Worker running this app's own worker.js, a clinic key it makes, the
// workers.dev address. ipc.js then connects the laptop.
//
// The token is used for that and not kept. It could delete the clinic's
// database, and nothing needs it again until the server is updated — which
// asks for a token the same way (updateServer).
//
// The calls are the ones Cloudflare's own wrangler makes for `wrangler d1
// create` and `wrangler deploy`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeClinicKey } = require('./hub');

const API = 'https://api.cloudflare.com/client/v4';
const SCRIPT = 'mmw-sync';
const DB_NAME = 'mmw';
// The date the server is written against, as in cloud/wrangler.toml.
const COMPATIBILITY_DATE = '2024-11-01';
const WORKER_PATH = path.join(__dirname, '..', '..', 'cloud', 'worker.js');

// The token: edit Workers and D1 databases, and read the account's settings
// (to find the account). Nothing about the clinic's domains or billing.
// Keys as Cloudflare's token template URLs take them; a key it does not know
// is dropped from the form without a word, so these are the documented ones.
const TOKEN_PERMISSIONS = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'd1', type: 'edit' },
  { key: 'account_settings', type: 'read' },
];
const TOKEN_NAME = 'Mission Minded sync server';
function tokenUrl() {
  return 'https://dash.cloudflare.com/profile/api-tokens'
    + '?permissionGroupKeys=' + encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS))
    + '&accountId=%2A&zoneId=all&name=' + encodeURIComponent(TOKEN_NAME);
}

function workerSource() { return fs.readFileSync(WORKER_PATH, 'utf8'); }
function bundledVersion() {
  const m = /const VERSION = '([^']+)'/.exec(workerSource());
  return m ? m[1] : '';
}
// 1.10.0 is newer than 1.9.2; a missing part counts as 0.
function newer(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

class CfError extends Error {
  constructor(message, { code, status, network } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.network = !!network;
  }
}

// One call to Cloudflare's API: its { success, errors, result } answer, the
// result returned and the first error thrown with its code.
async function cf(token, method, p, opts = {}) {
  const url = API + p + (opts.query ? '?' + new URLSearchParams(opts.query).toString() : '');
  const headers = { authorization: 'Bearer ' + token, ...(opts.headers || {}) };
  let body;
  if (opts.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.json); }
  else if (opts.form) body = opts.form;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 30000);
  let res;
  let data = null;
  try {
    try {
      res = await fetch(url, { method, headers, body, signal: ctl.signal });
    } catch (_e) {
      throw new CfError('Could not reach Cloudflare. Check this laptop is online, then try again.', { network: true });
    }
    try { data = await res.json(); } catch (_e) { data = null; }
  } finally { clearTimeout(timer); }
  if (!res.ok || !data || data.success === false) {
    const first = (data && Array.isArray(data.errors) && data.errors[0]) || {};
    throw new CfError(String(first.message || `Cloudflare answered ${res.status}`), { code: first.code, status: res.status });
  }
  return data.result;
}

const deniedCodes = new Set([10000, 9109, 9106]);
const isDenied = (e) => e && !e.network && (e.status === 401 || e.status === 403 || deniedCodes.has(e.code));
// What a refusal means at each step, in words that say what to do.
function explainStep(e, what, permission) {
  if (e && e.network) return e;
  if (isDenied(e)) {
    return new CfError(`This token is not allowed to ${what}: it needs “${permission}”. Make a new token with Open Cloudflare above — it asks for every permission the setup needs — and paste that one.`, { code: e.code, status: e.status });
  }
  return new CfError(`Cloudflare could not ${what}: ${e.message}`, { code: e.code, status: e.status });
}

async function checkToken(token) {
  const t = String(token || '').trim();
  if (!t) throw new CfError('Paste the token Cloudflare showed after Create Token.');
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(t)) throw new CfError('That does not look like a Cloudflare token — it is one line of letters and numbers, shown once after Create Token. Copy it again.');
  let r;
  try { r = await cf(t, 'GET', '/user/tokens/verify'); } catch (e) {
    if (e.network) throw e;
    throw new CfError('Cloudflare did not accept that token. Copy it again (Cloudflare shows it once, right after Create Token), or make a new one with Open Cloudflare.');
  }
  if (!r || r.status !== 'active') throw new CfError('That token is not active any more. Make a new one with Open Cloudflare.');
  return t;
}

async function listAccounts(token) {
  let list;
  try { list = await cf(token, 'GET', '/accounts', { query: { per_page: '50' } }); } catch (e) { throw explainStep(e, 'see your Cloudflare account', 'Account Settings · Read'); }
  return (Array.isArray(list) ? list : []).map((a) => ({ id: String(a.id), name: String(a.name || a.id) }));
}

// The account to use: the only one, or the one chosen. Several and none
// chosen: the caller asks which.
async function pickAccount(token, accountId) {
  const accounts = await listAccounts(token);
  if (!accounts.length) throw new CfError('This token is not allowed into any Cloudflare account. Make a new token with Open Cloudflare, and keep "All accounts" (or the clinic\'s account) under Account Resources.');
  if (accountId) {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) throw new CfError('That Cloudflare account is not one this token can use.');
    return { account: a };
  }
  if (accounts.length === 1) return { account: accounts[0] };
  return { chooseAccount: accounts };
}

async function findOrCreateDatabase(token, accountId) {
  const find = async () => {
    const list = await cf(token, 'GET', `/accounts/${accountId}/d1/database`, { query: { name: DB_NAME, per_page: '100' } });
    const db = (Array.isArray(list) ? list : []).find((d) => d && d.name === DB_NAME);
    return db ? String(db.uuid) : '';
  };
  try {
    const have = await find();
    if (have) return have;
    try {
      const made = await cf(token, 'POST', `/accounts/${accountId}/d1/database`, { json: { name: DB_NAME } });
      if (made && made.uuid) return String(made.uuid);
    } catch (e) {
      if (e.code !== 7502) throw e; // made a moment ago: find it
    }
    const now = await find();
    if (now) return now;
    throw new CfError('the database was not there after it was made');
  } catch (e) { throw explainStep(e, 'create the clinic\'s database', 'D1 · Edit'); }
}

async function scriptExists(token, accountId, name) {
  try {
    const list = await cf(token, 'GET', `/accounts/${accountId}/workers/scripts`);
    return (Array.isArray(list) ? list : []).some((s) => s && s.id === name);
  } catch (e) { throw explainStep(e, 'look at the account\'s Workers', 'Workers Scripts · Edit'); }
}

// Installs this app's worker.js as the Worker. New: with the database bound
// as DB and the clinic key as the CLINIC_KEY secret. A new key for a server
// that is there already: the key, and the database it has kept as it is
// (keep_bindings) — whatever it is called, so its records stay. An update
// keeps both, so the key every laptop holds stays the same.
async function uploadWorker(token, accountId, name, { databaseId, key } = {}) {
  const metadata = { main_module: 'worker.js', compatibility_date: COMPATIBILITY_DATE, bindings: [] };
  if (key && databaseId) {
    metadata.bindings = [
      { type: 'd1', name: 'DB', id: databaseId },
      { type: 'secret_text', name: 'CLINIC_KEY', text: key },
    ];
  } else if (key) {
    metadata.bindings = [{ type: 'secret_text', name: 'CLINIC_KEY', text: key }];
    metadata.keep_bindings = ['d1'];
  } else {
    metadata.keep_bindings = ['d1', 'secret_text'];
  }
  const form = new FormData();
  form.set('metadata', JSON.stringify(metadata));
  form.set('worker.js', new Blob([workerSource()], { type: 'application/javascript+module' }), 'worker.js');
  try {
    await cf(token, 'PUT', `/accounts/${accountId}/workers/scripts/${name}`, { form, query: { excludeScript: 'true' }, timeoutMs: 60000 });
  } catch (e) { throw explainStep(e, 'install the sync server', 'Workers Scripts · Edit'); }
}

// The account's workers.dev subdomain — registered here if it has none yet,
// as `wrangler deploy` does — and the Worker's address on it.
async function turnOnAddress(token, accountId, name) {
  try {
    let sub = '';
    try {
      const r = await cf(token, 'GET', `/accounts/${accountId}/workers/subdomain`);
      sub = r && r.subdomain ? String(r.subdomain) : '';
    } catch (e) {
      if (e.code !== 10007) throw e; // 10007: the account has none yet
    }
    for (let i = 0; !sub && i < 5; i++) {
      const wanted = 'mmw-' + crypto.randomBytes(5).toString('hex');
      try {
        const r = await cf(token, 'PUT', `/accounts/${accountId}/workers/subdomain`, { json: { subdomain: wanted } });
        sub = r && r.subdomain ? String(r.subdomain) : wanted;
      } catch (e) {
        if (e.code !== 10031 || i === 4) throw e; // 10031: that name is taken
      }
    }
    await cf(token, 'POST', `/accounts/${accountId}/workers/scripts/${name}/subdomain`, {
      json: { enabled: true, previews_enabled: false },
      headers: { 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' },
    });
    return `https://${name}.${sub}.workers.dev`;
  } catch (e) { throw explainStep(e, 'turn on the server\'s address', 'Workers Scripts · Edit'); }
}

async function health(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/health', { signal: ctl.signal });
    if (!res.ok) return null;
    const h = await res.json();
    return h && h.ok === true && h.service === 'mmw-sync' ? h : null;
  } catch (_e) {
    return null;
  } finally { clearTimeout(timer); }
}

// A new workers.dev address can take a few minutes to start answering.
// Resolves the answer once the server says it runs `version`, or null.
async function waitForServer(url, version, { timeoutMs = 180000, everyMs = 4000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const h = await health(url);
    if (h && (!version || h.version === version)) return h;
    if (Date.now() + everyMs > until) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// Sets up the clinic's sync server. Answers one of:
//   { chooseAccount: [{ id, name }] } — the token reaches several accounts;
//   { exists: true, account } — the account already has the sync server, and
//     replaceKey was not given (connecting to it takes its connection code);
//   { url, key, answered, version } — set up; `answered` false when the new
//     address had not started answering yet.
async function setupServer({ token, accountId, replaceKey = false, onStep = () => {}, waitMs } = {}) {
  onStep('token');
  const t = await checkToken(token);
  const picked = await pickAccount(t, accountId);
  if (picked.chooseAccount) return { chooseAccount: picked.chooseAccount };
  const account = picked.account;
  const exists = await scriptExists(t, account.id, SCRIPT);
  if (exists && !replaceKey) return { exists: true, account };
  onStep('database');
  // A server there already keeps its own database (see uploadWorker).
  const databaseId = exists ? null : await findOrCreateDatabase(t, account.id);
  onStep('server');
  const key = makeClinicKey();
  await uploadWorker(t, account.id, SCRIPT, { databaseId, key });
  onStep('address');
  const url = await turnOnAddress(t, account.id, SCRIPT);
  onStep('answer');
  const version = bundledVersion();
  const h = await waitForServer(url, version, waitMs !== undefined ? { timeoutMs: waitMs } : {});
  return { url, key, answered: !!h, version, account };
}

// The server this laptop is connected to, by its workers.dev address: the
// Worker's name and the account's subdomain. Another kind of address (a
// domain of the clinic's own) cannot be updated from here.
function parseServerUrl(url) {
  let host = '';
  try { host = new URL(String(url || '')).host.toLowerCase(); } catch (_e) { return null; }
  const m = /^([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev$/.exec(host);
  return m ? { name: m[1], subdomain: m[2] } : null;
}

// Puts this app's worker.js on the server this laptop is connected to,
// keeping its database and clinic key. Answers { version } — or
// { chooseAccount } as setupServer does.
async function updateServer({ token, url, accountId, onStep = () => {}, waitMs } = {}) {
  const at = parseServerUrl(url);
  if (!at) throw new CfError('This laptop\'s sync server is not at a Cloudflare workers.dev address, so the app cannot update it. Update it by hand: in Cloudflare, Edit code, paste the new worker.js, Deploy.');
  onStep('token');
  const t = await checkToken(token);
  let account = null;
  if (accountId) {
    const picked = await pickAccount(t, accountId);
    account = picked.account;
  } else {
    // The account whose workers.dev subdomain the address is on.
    for (const a of await listAccounts(t)) {
      try {
        const r = await cf(t, 'GET', `/accounts/${a.id}/workers/subdomain`);
        if (r && String(r.subdomain).toLowerCase() === at.subdomain) { account = a; break; }
      } catch (_e) { /* not this one */ }
    }
  }
  if (!account) throw new CfError(`This token cannot reach the Cloudflare account that holds ${at.name}.${at.subdomain}.workers.dev. Sign in to that account, then make the token with Open Cloudflare.`);
  if (!(await scriptExists(t, account.id, at.name))) throw new CfError(`The Cloudflare account has no Worker named ${at.name} any more.`);
  onStep('server');
  await uploadWorker(t, account.id, at.name, {});
  onStep('answer');
  const version = bundledVersion();
  const h = await waitForServer(`https://${at.name}.${at.subdomain}.workers.dev`, version, waitMs !== undefined ? { timeoutMs: waitMs } : { timeoutMs: 90000 });
  if (!h) throw new CfError(`The new version was installed, but the server has not said so yet. Check again in a minute.`);
  return { version: h.version };
}

module.exports = {
  tokenUrl, bundledVersion, newer, parseServerUrl, health,
  setupServer, updateServer, TOKEN_PERMISSIONS, SCRIPT, DB_NAME, COMPATIBILITY_DATE, API,
};
