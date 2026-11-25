// Patient wristband: the printed band, and the scan box that reads it back.
//
// The band is the spine of the MMW flow — Clearance and Triage both start by
// scanning it rather than searching by name, which is what makes the queue work
// when half the room shares three surnames and the staff are volunteers who
// have never met anyone here.

import { el, toast } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { barcodeSVG, code128Width } from './barcode.js';

/* ---------------- v0.0.24: the label stock this laptop prints on ----------------
   Each laptop has its own printer, so the size is kept on the laptop (Admin →
   Events → Wristband labels). Printed, the page is exactly the label — no
   margins, no scaling to fit — and the barcode is drawn in millimetres, each
   bar a whole number of the printer's dots, so a thermal printer prints the
   bars at the width a scanner expects. */
export const LABEL_SIZES = [
  { key: 'sheet', label: 'Letter or A4 paper (cut it out)' },
  { key: 'band-1x11', label: 'Wristband 1 × 11 in (25 × 279 mm)', w: 279.4, h: 25.4 },
  { key: 'band-1x10', label: 'Wristband 1 × 10 in (25 × 254 mm)', w: 254, h: 25.4 },
  { key: 'band-1x7', label: 'Wristband 1 × 7 in, child (25 × 178 mm)', w: 177.8, h: 25.4 },
  { key: 'label-2x1', label: 'Label 2 × 1 in (51 × 25 mm)', w: 50.8, h: 25.4 },
  { key: 'label-3x1', label: 'Label 3 × 1 in (76 × 25 mm)', w: 76.2, h: 25.4 },
  { key: 'label-4x2', label: 'Label 4 × 2 in (102 × 51 mm)', w: 101.6, h: 50.8 },
  { key: 'label-4x6', label: 'Label 4 × 6 in (102 × 152 mm)', w: 101.6, h: 152.4 },
  { key: 'custom', label: 'Another size — type it in millimetres' },
];
export const PRINTER_DPI = [
  { key: 203, label: 'Thermal label printer, 203 dpi (most wristband printers)' },
  { key: 300, label: 'Thermal label printer, 300 dpi' },
  { key: 600, label: 'Office laser or inkjet printer' },
];
const LABEL_KEY = 'mmw.wristband.label';
export function labelSetting() {
  let v = null;
  try { v = JSON.parse(window.localStorage.getItem(LABEL_KEY) || 'null'); } catch (_) { v = null; }
  const size = LABEL_SIZES.find((x) => v && x.key === v.key) || LABEL_SIZES[0];
  const num = (n, lo, hi, d) => { const x = Number(n); return Number.isFinite(x) && x >= lo && x <= hi ? x : d; };
  const dpi = PRINTER_DPI.some((d) => v && d.key === Number(v.dpi)) ? Number(v.dpi) : 203;
  const out = { key: size.key, dpi, offset: num(v && v.offset, 0, 150, 0) };
  if (size.key === 'custom') { out.w = num(v && v.w, 20, 600, 101.6); out.h = num(v && v.h, 10, 600, 50.8); }
  else if (size.w) { out.w = size.w; out.h = size.h; }
  return out;
}
export function saveLabelSetting(v) {
  try { window.localStorage.setItem(LABEL_KEY, JSON.stringify(v || {})); return true; } catch (_) { return false; }
}
// The widest bar a whole number of the printer's dots that fits `widthMm` —
// the narrowest bar (one module) at 2 to 6 dots, never below a quarter
// millimetre, which cheap laser scanners stop reading.
export function moduleFor(code, widthMm, dpi = 203) {
  const modules = code128Width(code);
  const dot = 25.4 / (Number(dpi) || 203);
  const maxDots = dpi >= 600 ? 12 : dpi >= 300 ? 6 : 4;
  for (let n = maxDots; n >= 1; n--) {
    const m = n * dot;
    if (m < 0.25 && n < maxDots) break;
    if (modules * m <= widthMm) return m;
  }
  return Math.max(0.25, widthMm / modules);
}
// How the band is laid out on a label: a long band as one row, a small label
// stacked tight, anything bigger as the screen shows it.
export function labelLayout(setting) {
  if (!setting || !setting.w) return 'sheet';
  if (setting.h <= 32 && setting.w >= 120) return 'band';
  if (setting.h <= 32) return 'small';
  return 'large';
}

/** Full name as printed on the band. */
function fullName(p) {
  return [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');
}

/** dd Mon yyyy — unambiguous for a bilingual clinic, unlike a numeric date. */
function formatDob(dob) {
  if (!dob) return '—';
  const d = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dob;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * The label itself. `forPrint` swaps in a wider module so the bars survive a
 * cheap thermal printer — a screen-width barcode often will not scan on paper.
 */
export function wristbandLabel(patient, { forPrint = false, label = null } = {}) {
  if (!patient || !patient.patient_code) {
    return el('div', { class: 'wristband wristband--empty' }, ['No wristband ID has been issued for this patient yet.']);
  }
  // Registration stores the chosen clinics on the demographics blob.
  const demo = patient.demographics || {};
  const services = Array.isArray(demo.services) ? demo.services : [];
  const setting = forPrint ? (label || labelSetting()) : null;
  const layout = forPrint ? labelLayout(setting) : 'screen';
  if (layout === 'band' || layout === 'small') return stockLabel(patient, setting, layout, services);
  if (forPrint) {
    // A sheet, or a label big enough for the full band: the barcode in mm.
    const width = layout === 'large' ? Math.min(setting.w - 8, 80) : 60;
    const m = moduleFor(patient.patient_code, width, setting ? setting.dpi : 203);
    return el('div', { class: 'wristband wristband--print wristband--' + layout,
      style: layout === 'large' ? `width:${setting.w}mm;height:${setting.h}mm;` : '' }, [
      el('div', { class: 'wb-head' }, [
        el('img', { class: 'wb-logo', src: '../../assets/mmw-logo.png', alt: 'Mission Minded Free Clinics' }),
        el('div', { class: 'wb-id' }, [patient.patient_code]),
      ]),
      el('div', { class: 'wb-name' }, [fullName(patient)]),
      el('div', { class: 'wb-meta' }, [
        el('span', {}, ['DOB ', el('strong', {}, [formatDob(patient.dob)])]),
        patient.gender ? el('span', {}, [patient.gender]) : null,
        services.length ? el('span', { class: 'wb-svc' }, [services.join(' · ')]) : null,
      ]),
      el('div', { class: 'wb-code' }, [barcodeSVG(patient.patient_code, { moduleMm: m, heightMm: layout === 'large' ? Math.min(18, setting.h / 4) : 18 })]),
    ]);
  }
  return el('div', { class: 'wristband' + (forPrint ? ' wristband--print' : '') }, [
    el('div', { class: 'wb-head' }, [
      el('img', { class: 'wb-logo', src: '../../assets/mmw-logo.png', alt: 'Mission Minded Free Clinics' }),
      el('div', { class: 'wb-id' }, [patient.patient_code]),
    ]),
    el('div', { class: 'wb-name' }, [fullName(patient)]),
    el('div', { class: 'wb-meta' }, [
      el('span', {}, ['DOB ', el('strong', {}, [formatDob(patient.dob)])]),
      patient.gender ? el('span', {}, [patient.gender]) : null,
      services.length ? el('span', { class: 'wb-svc' }, [services.join(' · ')]) : null,
    ]),
    el('div', { class: 'wb-code' }, [barcodeSVG(patient.patient_code, {
      moduleWidth: forPrint ? 3 : 2,
      height: forPrint ? 70 : 52,
    })]),
  ]);
}

// A wristband or a small label: the whole label is the page.
function stockLabel(patient, setting, layout, services) {
  const pad = 1.5;
  const w = setting.w, h = setting.h, off = Math.min(setting.offset || 0, w / 2);
  if (layout === 'band') {
    // ID and name on the left, the barcode on the right, all on one row.
    const codeW = Math.min(70, (w - off) * 0.45);
    const m = moduleFor(patient.patient_code, codeW, setting.dpi);
    return el('div', { class: 'wristband wristband--stock wristband--band', style: `width:${w}mm;height:${h}mm;padding:${pad}mm ${pad + 1}mm ${pad}mm ${pad + off}mm;` }, [
      el('div', { class: 'wb-text' }, [
        el('div', { class: 'wb-name' }, [fullName(patient)]),
        el('div', { class: 'wb-meta' }, [
          el('span', { class: 'wb-id' }, [patient.patient_code]),
          el('span', {}, ['DOB ', el('strong', {}, [formatDob(patient.dob)])]),
          patient.gender ? el('span', {}, [patient.gender]) : null,
          services.length ? el('span', { class: 'wb-svc' }, [services.join(' · ')]) : null,
        ]),
      ]),
      el('div', { class: 'wb-code' }, [barcodeSVG(patient.patient_code, { moduleMm: m, heightMm: Math.max(8, h - 2 * pad - 4.5) })]),
    ]);
  }
  const m = moduleFor(patient.patient_code, w - 2 * pad - off, setting.dpi);
  return el('div', { class: 'wristband wristband--stock wristband--small', style: `width:${w}mm;height:${h}mm;padding:${pad}mm ${pad}mm ${pad}mm ${pad + off}mm;` }, [
    el('div', { class: 'wb-name' }, [fullName(patient)]),
    el('div', { class: 'wb-code' }, [barcodeSVG(patient.patient_code, { moduleMm: m, heightMm: Math.max(6, h - 2 * pad - 8) })]),
  ]);
}

// The page, for this print: exactly the label, with no margin.
function pageStyle(setting) {
  let tag = document.getElementById('wb-page-size');
  if (!tag) { tag = el('style', { id: 'wb-page-size' }); document.head.append(tag); }
  tag.textContent = setting && setting.w
    ? `@media print{ @page{ size:${setting.w}mm ${setting.h}mm; margin:0; } }`
    : '';
}

/**
 * Print the band.
 *
 * Everything except a dedicated print root is hidden for the duration rather
 * than opening a second window: an Electron child window loses the bundled
 * fonts and the barcode's exact geometry, and geometry is the whole point.
 */
export function printWristband(patient) {
  if (!patient || !patient.patient_code) { toast('This patient has no wristband ID.', 'error'); return; }
  let root = document.getElementById('print-root');
  if (!root) {
    root = el('div', { id: 'print-root' });
    document.body.append(root);
  }
  const setting = labelSetting();
  pageStyle(setting);
  root.replaceChildren(wristbandLabel(patient, { forPrint: true, label: setting }));
  document.body.classList.add('printing');

  const cleanup = () => {
    document.body.classList.remove('printing');
    root.replaceChildren();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  // Some Chromium builds never fire afterprint when the dialog is dismissed;
  // this keeps the app from being left in the hidden print state.
  setTimeout(() => { if (document.body.classList.contains('printing')) cleanup(); }, 6000);
}

// Every word typed appears in the patient's name: "lopez mar" finds Maria Lopez.
function nameMatches(p, text) {
  const hay = `${p.first_name || ''} ${p.last_name || ''}`.toLowerCase();
  return text.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/**
 * Scan box for the station screens.
 *
 * A handheld barcode scanner is a keyboard: it types the digits fast and sends
 * Enter. So this is a plain text input that submits on Enter — no driver, no
 * pairing, and it still works when someone types the number by hand because the
 * band is torn or the scanner is missing.
 *
 * A name typed here (anything that is not a band number) is looked up by name
 * rather than refused as an unknown wristband — the box looks like a search
 * box, and that is how it gets used. `onName(text)` lets a screen with a list
 * of its own filter that; otherwise the matches in this clinic are offered to
 * pick from (one match opens directly).
 *
 * `onFound(patient)` receives the resolved patient.
 */
export function scanBox({ onFound, onName = null, label = 'Scan wristband', autofocus = true } = {}) {
  const input = el('input', {
    class: 'input scan-input',
    type: 'text',
    // No numeric keypad: a name can be typed here too.
    placeholder: 'Scan band, type ID or name…',
    'aria-label': label,
  });
  const picks = el('div', { class: 'scan-picks', style: 'display:none' });
  const hidePicks = () => { picks.replaceChildren(); picks.style.display = 'none'; };

  async function byName(text) {
    if (onName) { input.value = ''; onName(text); return; }
    const hits = (await api.listPatients({})).filter((p) => nameMatches(p, text));
    if (!hits.length) { toast(`No patient named “${text}” in this clinic.`, 'error'); input.select(); return; }
    input.value = '';
    // A chart opens straight away only for the patient's whole name, typed
    // exactly. A part of a name ("lee" for Ashlee Ruiz) is offered to pick
    // from, with the birth date — opening the wrong chart at a clinical
    // station is worse than one more tap.
    const exact = (p) => `${p.first_name || ''} ${p.last_name || ''}`.toLowerCase().replace(/\s+/g, ' ').trim()
      === text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (hits.length === 1 && exact(hits[0])) { onFound(await api.getPatient(hits[0].id)); return; }
    picks.replaceChildren(
      el('div', { class: 'scan-picks-head' }, [hits.length === 1 ? `1 patient matches “${text}” — is this them?` : `${hits.length} patients match “${text}” — choose one:`]),
      ...hits.slice(0, 12).map((p) => el('button', {
        class: 'scan-pick', type: 'button',
        onClick: async () => { hidePicks(); try { onFound(await api.getPatient(p.id)); } catch (e) { toast(e.message, 'error'); } },
      }, [
        el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
        el('span', { class: 'subtle small' }, [[p.dob, p.age != null ? `${p.age} yrs` : null].filter(Boolean).join(' · ')]),
      ])),
    );
    picks.style.display = '';
  }

  let busy = false;
  async function submit() {
    const raw = input.value.trim();
    if (!raw || busy) return;
    hidePicks();
    busy = true;
    input.disabled = true;
    try {
      if (/[^\d\s-]/.test(raw)) await byName(raw);
      else {
        const patient = await api.findByCode(raw);
        input.value = '';
        onFound(patient);
      }
    } catch (e) {
      toast(e.message || 'That wristband was not recognised.', 'error');
      input.select();
    } finally {
      busy = false;
      input.disabled = false;
      // Keep focus so the next band can be scanned without touching the mouse.
      input.focus();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  const bar = el('div', { class: 'scan-box' }, [
    el('span', { class: 'scan-icon' }, [icon('scan', { size: 18 })]),
    input,
    el('button', { class: 'btn btn--ghost btn--sm', onClick: submit }, ['Find']),
  ]);
  const box = el('div', { class: 'scan-wrap' }, [bar, picks]);

  if (autofocus) setTimeout(() => input.focus(), 30);
  box.focusInput = () => input.focus();
  return box;
}
