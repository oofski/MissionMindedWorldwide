'use strict';

/**
 * USB per-patient transfer workflow (offline).
 *
 * A patient's record is written to a USB drive at check-in, carried station to
 * station, loaded at each station, uploaded to the local database at checkout,
 * and the drive is cleared for reuse. All filesystem-only; no network.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FOLDER_RE = /_MMW$/i;
const sanitize = (s) => String(s || '').replace(/[^a-z0-9_]/gi, '');

function baseName(patient) {
  return `${sanitize(patient.last_name)}_${sanitize(patient.first_name)}_MMW`;
}

// Candidate removable roots + common folders. Windows exposes removable media
// as drive letters; macOS mounts them under /Volumes, where the startup disk
// also appears and is deliberately skipped so it is not offered as a "drive".
function listDrives() {
  const out = [];
  if (process.platform === 'win32') {
    for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      try { if (fs.existsSync(root)) out.push({ path: root, label: `${String.fromCharCode(c)}: drive` }); } catch (e) { /* ignore */ }
    }
  } else if (process.platform === 'darwin') {
    try {
      // /Volumes/Macintosh HD is a symlink to /, i.e. the startup disk — a
      // patient export written there would go on the clinic's own laptop
      // rather than the stick they meant to hand over.
      for (const name of fs.readdirSync('/Volumes')) {
        const root = path.join('/Volumes', name);
        try {
          if (fs.realpathSync(root) === '/') continue;
          if (fs.statSync(root).isDirectory()) out.push({ path: root, label: name });
        } catch (e) { /* unreadable mount — skip */ }
      }
    } catch (e) { /* no /Volumes — skip */ }
  }
  try { const d = app.getPath('downloads'); out.push({ path: d, label: 'Downloads' }); } catch (e) { /* ignore */ }
  return out;
}

// Write a per-patient folder ( <base>.json + <base>.pdf ) onto the drive.
function writePatientFile(driveDir, patient, jsonStr, pdfBuffer) {
  if (!driveDir || !fs.existsSync(driveDir)) throw new Error('Drive / folder not found.');
  const base = baseName(patient);
  const folder = path.join(driveDir, base);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${base}.json`), jsonStr);
  if (pdfBuffer) fs.writeFileSync(path.join(folder, `${base}.pdf`), pdfBuffer);
  return { saved: true, path: folder };
}

// Find and parse every MMW patient file on the drive.
function loadPatientFiles(driveDir) {
  if (!driveDir || !fs.existsSync(driveDir)) throw new Error('Drive / folder not found.');
  const found = [];
  let entries;
  try { entries = fs.readdirSync(driveDir, { withFileTypes: true }); } catch (e) { return found; }
  for (const e of entries) {
    if (!e.isDirectory() || !FOLDER_RE.test(e.name)) continue;
    const folder = path.join(driveDir, e.name);
    let files;
    try { files = fs.readdirSync(folder); } catch (err) { continue; }
    const jsonFile = files.find((f) => f.toLowerCase().endsWith('.json'));
    if (!jsonFile) continue;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(folder, jsonFile), 'utf8'));
      found.push({ folder, name: e.name, patient: json });
    } catch (err) { /* skip corrupt */ }
  }
  return found;
}

// Delete ONLY the MMW per-patient subfolders (never the drive root).
function clearDrive(driveDir) {
  if (!driveDir || !fs.existsSync(driveDir)) throw new Error('Drive / folder not found.');
  let entries;
  try { entries = fs.readdirSync(driveDir, { withFileTypes: true }); } catch (e) { return { cleared: 0 }; }
  let cleared = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !FOLDER_RE.test(e.name)) continue;
    const folder = path.join(driveDir, e.name);
    // Safety: only remove a folder that is directly inside the chosen drive and
    // matches the MMW naming.
    if (path.dirname(folder) !== path.resolve(driveDir)) continue;
    try { fs.rmSync(folder, { recursive: true, force: true }); cleared++; } catch (err) { /* ignore */ }
  }
  return { cleared };
}

module.exports = { listDrives, writePatientFile, loadPatientFiles, clearDrive, baseName };
