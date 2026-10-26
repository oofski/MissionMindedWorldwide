// Patient wristband: the printed band, and the scan box that reads it back.
//
// The band is the spine of the MMW flow — Clearance and Triage both start by
// scanning it rather than searching by name, which is what makes the queue work
// when half the room shares three surnames and the staff are volunteers who
// have never met anyone here.

import { el, toast } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { barcodeSVG } from './barcode.js';

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
export function wristbandLabel(patient, { forPrint = false } = {}) {
  if (!patient || !patient.patient_code) {
    return el('div', { class: 'wristband wristband--empty' }, ['No wristband ID has been issued for this patient yet.']);
  }
  // Registration stores the chosen clinics on the demographics blob.
  const demo = patient.demographics || {};
  const services = Array.isArray(demo.services) ? demo.services : [];
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
  root.replaceChildren(wristbandLabel(patient, { forPrint: true }));
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
    inputmode: 'numeric',
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
    if (hits.length === 1) { onFound(await api.getPatient(hits[0].id)); return; }
    picks.replaceChildren(
      el('div', { class: 'scan-picks-head' }, [`${hits.length} patients match “${text}” — choose one:`]),
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
