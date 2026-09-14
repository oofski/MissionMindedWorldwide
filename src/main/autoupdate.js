'use strict';

/**
 * Online auto-update via electron-updater (GitHub Releases provider).
 *
 * The app checks the project's GitHub releases for a newer version, downloads
 * the installer in the background, and installs on restart — so the team does
 * not have to re-download the .exe by hand. (Online; the offline USB updater in
 * updater.js remains as a no-internet fallback.)
 */

const { app } = require('electron');

// In-place update is Windows-only here.
//
// Updating a macOS app goes through Squirrel.Mac, which verifies the new build's
// code signature against the running app's before it will swap them. These
// builds are ad-hoc signed (enough for macOS to launch them, nothing more), so
// that check can never pass — electron-updater would download the whole update
// and then fail at the last step with a signature error that looks like a bug.
//
// So macOS is told plainly that it updates by downloading, rather than being
// walked into a failure. Signing with an Apple Developer ID is what would change
// this, and nothing in the app can substitute for it.
const UPDATES_SUPPORTED = process.platform !== 'darwin';
const MAC_REASON = 'Automatic updates are not available on macOS for this build. '
  + 'Download the latest version from the Mission Minded releases page and drag it '
  + 'to Applications, replacing the old copy. Your patient records are kept '
  + 'separately and are not affected.';

let autoUpdater = null;
let getWin = () => null;
const state = { status: 'idle', currentVersion: null, version: null, percent: 0, error: null };

function load() {
  if (autoUpdater) return autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;          // ask the user before downloading
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => emit('checking'));
    autoUpdater.on('update-available', (info) => { state.version = info.version; emit('available'); });
    autoUpdater.on('update-not-available', () => emit('none'));
    autoUpdater.on('error', (e) => { state.error = (e && e.message) || String(e || 'Update error'); emit('error'); });
    autoUpdater.on('download-progress', (p) => { state.percent = Math.round(p.percent || 0); emit('downloading'); });
    autoUpdater.on('update-downloaded', (info) => { state.version = info.version; emit('downloaded'); });
  } catch (e) {
    autoUpdater = null;
  }
  return autoUpdater;
}

// GitHub's release-download edge intermittently returns 504 Gateway Time-out
// (and networks throw timeouts/resets). electron-updater does NOT retry — it
// surfaces the first failure. These helpers retry transient network errors with
// backoff so a momentary 504 doesn't break the update check/download.
const TRANSIENT_RE = /\b5\d\d\b|gateway time|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|aborted/i;
function isTransient(e) { return TRANSIENT_RE.test((e && (e.message || String(e))) || ''); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, attempts = 4, baseMs = 1500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (!isTransient(e) || i === attempts - 1) throw e;
      await sleep(baseMs * Math.pow(2, i)); // 1.5s, 3s, 6s
    }
  }
  throw lastErr;
}

function emit(status) {
  state.status = status;
  state.currentVersion = app.getVersion();
  const w = getWin();
  if (w && !w.isDestroyed()) {
    try { w.webContents.send('update:event', { ...state }); } catch (e) { /* ignore */ }
  }
}

function init(winGetter) {
  getWin = winGetter || getWin;
  if (!UPDATES_SUPPORTED) return;   // never wire up a updater that cannot finish
  load();
}

function available() {
  // Online updates require the packaged app + internet.
  return UPDATES_SUPPORTED && app.isPackaged && !!load();
}

async function check() {
  if (!UPDATES_SUPPORTED) return { supported: false, reason: MAC_REASON };
  if (!app.isPackaged) return { supported: false, reason: 'Online updates work in the installed app only (not in dev / portable run).' };
  const u = load();
  if (!u) return { supported: false, reason: 'Updater unavailable.' };
  try {
    const r = await withRetry(() => u.checkForUpdates());
    const latest = r && r.updateInfo ? r.updateInfo.version : null;
    const cur = app.getVersion();
    return { supported: true, currentVersion: cur, latestVersion: latest, hasUpdate: !!latest && latest !== cur };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    // Give a plain-language hint for the common GitHub 504 so staff aren't alarmed.
    const friendly = isTransient(e) ? 'Could not reach the update server (it timed out after several tries). This is usually a brief network hiccup — try again in a minute, or install the latest version manually from the release page.' : msg;
    return { supported: true, error: friendly, raw: msg };
  }
}

async function download() {
  if (!UPDATES_SUPPORTED) throw new Error(MAC_REASON);
  const u = load();
  if (!u) throw new Error('Updater unavailable.');
  await withRetry(() => u.downloadUpdate());
  return { downloading: true };
}

function quitAndInstall() {
  if (!UPDATES_SUPPORTED) throw new Error(MAC_REASON);
  const u = load();
  if (!u) throw new Error('Updater unavailable.');
  setImmediate(() => u.quitAndInstall(false, true));
  return { installing: true };
}

// Silent check shortly after launch; result is pushed to the renderer.
function checkSilently() {
  if (!UPDATES_SUPPORTED) return;
  if (!app.isPackaged) return;
  const u = load();
  if (u) { try { withRetry(() => u.checkForUpdates(), 5, 4000).catch(() => {}); } catch (e) { /* ignore */ } }
}

module.exports = { init, available, check, download, quitAndInstall, checkSilently, state: () => state, withRetry, isTransient };
