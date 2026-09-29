'use strict';

/**
 * The Dental Triage lists, for the main process.
 *
 * pdf.js and clinicSheets.js are CommonJS and cannot import the renderer's ES
 * modules, so this file MIRRORS src/renderer/i18n/dentalLists.js (surfaces,
 * injection sites, referral destinations and urgency, patient status) and the
 * ANESTHETICS list in src/renderer/i18n/strings.js. The harness compares them
 * key by key and label by label; change one without the other and it fails,
 * rather than a patient's record printing "mepivacaine" or "ianb".
 *
 * It also holds the few printing rules the PDF and the spreadsheet must share —
 * how a filling's surfaces read, what an anaesthetic row says, which cleaning
 * keys are notes rather than work done — so the two can never disagree.
 */

/* ---------------- mirrored lists ---------------- */

const SURFACES = [
  { key: 'M', en: 'Mesial' },
  { key: 'F', en: 'Facial' },
  { key: 'L', en: 'Lingual' },
  { key: 'O', en: 'Occlusal' },
  { key: 'B', en: 'Buccal' },
];
const LEGACY_SURFACE_COUNTS = ['1', '2', '3', '4'];

// Mirrors ANESTHETICS in strings.js — EVERY key, retired ones included, because
// a retired agent still has to print by name on the records that used it.
const ANESTHETICS = [
  { key: 'lidocaine', en: 'Lidocaine 2%' },
  { key: 'articaine', en: 'Articaine 4%' },
  { key: 'mepivacaine', en: 'Mepivacaine 3%' },
  { key: 'bupivacaine', en: 'Bupivacaine 0.5%' },
  { key: 'prilocaine', en: 'Prilocaine 4%' },
];

// Retire, never delete (see dentalLists.js): a retired entry keeps its label
// here so every record that used it still prints it by name.
const ANES_SITES = [
  { key: 'buccal_infiltration', en: 'Buccal infiltration' },
  { key: 'lingual_palatal_infiltration', en: 'Lingual / palatal infiltration' },
  { key: 'ianb', en: 'Inferior alveolar nerve block (IANB)' },
  { key: 'lingual_block', en: 'Lingual nerve block' },
  { key: 'long_buccal', en: 'Long buccal nerve block' },
  { key: 'psa', en: 'Posterior superior alveolar block (PSA)' },
  { key: 'msa', en: 'Middle superior alveolar block (MSA)' },
  { key: 'asa', en: 'Anterior superior alveolar block (ASA)' },
  { key: 'infraorbital', en: 'Infraorbital nerve block' },
  { key: 'greater_palatine', en: 'Greater palatine nerve block' },
  { key: 'nasopalatine', en: 'Nasopalatine nerve block' },
  { key: 'mental', en: 'Mental / incisive nerve block' },
  { key: 'pdl', en: 'Periodontal ligament (PDL) injection' },
  { key: 'intraosseous', en: 'Intraosseous injection' },
  { key: 'other', en: 'Other' },
];

const DENTAL_REFERRAL_TO = [
  { key: 'oral_surgeon', en: 'Oral surgeon', es: 'Cirujano oral' },
  { key: 'endodontist', en: 'Endodontist (root canal)', es: 'Endodoncista (tratamiento de conducto)' },
  { key: 'periodontist', en: 'Periodontist (gums)', es: 'Periodoncista (encías)' },
  { key: 'orthodontist', en: 'Orthodontist', es: 'Ortodoncista' },
  { key: 'pediatric_dentist', en: 'Pediatric dentist', es: 'Dentista pediátrico' },
  { key: 'prosthodontist', en: 'Prosthodontist (dentures, crowns)', es: 'Prostodoncista (dentaduras, coronas)' },
  { key: 'general_dentist', en: 'General dentist', es: 'Dentista general' },
  { key: 'physician', en: 'Physician / primary care', es: 'Médico / atención primaria' },
  { key: 'emergency_room', en: 'Emergency room', es: 'Sala de emergencias' },
  { key: 'mmw_next_clinic', en: 'Next MMW clinic', es: 'Próxima clínica de MMW' },
  { key: 'other', en: 'Other', es: 'Otro' },
];

const REFERRAL_URGENCY = [
  { key: 'routine', en: 'Routine', es: 'De rutina' },
  { key: 'soon', en: 'Soon', es: 'Pronto' },
  { key: 'urgent', en: 'Urgent', es: 'Urgente' },
];

const STATUS_LABELS = {
  checked_in: 'Checked in',
  triaged: 'Waiting for provider',
  treatment_waiting: 'Treatment waiting',
  in_treatment: 'In treatment',
  completed: 'Completed',
  dismissed: 'Checked out',
};

/* ---------------- printing rules ---------------- */

// Same rules as surfaceList/formatSurfaces in dentalLists.js; the harness runs
// both over the same inputs.
function surfaceList(value) {
  if (value == null || value === '') return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[\s,;/]+/);
  const out = [];
  for (const item of raw) {
    const tok = String(item == null ? '' : item).trim();
    if (!tok) continue;
    if (/^[A-Z]{2,}$/.test(tok)) out.push(...tok.split(''));
    else out.push(/^[a-z]$/.test(tok) ? tok.toUpperCase() : tok);
  }
  return Array.from(new Set(out));
}
function formatSurfaces(value) {
  const toks = surfaceList(value);
  const order = SURFACES.map((s) => s.key);
  const letters = toks.filter((t) => /^[A-Z]$/.test(t));
  const known = order.filter((k) => letters.includes(k));
  const unknown = letters.filter((k) => !order.includes(k));
  const parts = [];
  if (known.length || unknown.length) parts.push(known.join('') + unknown.join(''));
  toks.filter((t) => LEGACY_SURFACE_COUNTS.includes(t)).sort().forEach((d) => parts.push(`${d}-surface`));
  toks.filter((t) => !/^[A-Z]$/.test(t) && !LEGACY_SURFACE_COUNTS.includes(t)).forEach((t) => parts.push(t));
  return parts.join(', ');
}

// 'supplemental' is a key from an early build's object-shaped anaesthetic.
const ANES_LABELS = Object.assign(
  Object.fromEntries(ANESTHETICS.map((a) => [a.key, a.en])),
  { other: 'Other', supplemental: 'Supplemental' },
);
const ANES_SITE_LABELS = Object.fromEntries(ANES_SITES.map((s) => [s.key, s.en]));

/** The agent as printed: its label, the typed name for "Other", else the stored text. */
function anesAgentLabel(a) {
  if (!a) return '';
  if (a.agent === 'other') return a.name ? String(a.name) : 'Other';
  return ANES_LABELS[a.agent] || String(a.agent || a.name || '');
}
/** The injection site as printed; legacy free text is shown as it was typed. */
function anesSiteText(a) {
  const loc = a && a.location;
  if (!loc) return '';
  if (loc === 'other') return (a.location_other && String(a.location_other).trim()) || 'Other';
  return ANES_SITE_LABELS[loc] || String(loc);
}
/**
 * Anaesthetic administrations as a flat list, whichever shape was stored: the
 * array of rows, or the early object keyed by agent.
 */
function anesRows(stored) {
  if (Array.isArray(stored)) return stored.filter(Boolean);
  return Object.entries(stored || {}).map(([k, v]) => ({ ...(v || {}), agent: k }));
}

const pickLabel = (list, key, lang) => {
  const hit = list.find((x) => x.key === key);
  return hit ? (hit[lang] || hit.en) : String(key || '');
};
function hasReferralOut(r) {
  return !!(r && ((Array.isArray(r.to) && r.to.length) || (r.to_other && String(r.to_other).trim())));
}
function referralDestinations(r, lang = 'en') {
  if (!r) return '';
  const to = (Array.isArray(r.to) ? r.to : []).filter((k) => k !== 'other').map((k) => pickLabel(DENTAL_REFERRAL_TO, k, lang));
  const other = r.to_other && String(r.to_other).trim();
  if (other) to.push(other);
  else if ((r.to || []).includes('other')) to.push(pickLabel(DENTAL_REFERRAL_TO, 'other', lang));
  return to.join(', ');
}
const referralUrgencyLabel = (key, lang = 'en') => (key ? pickLabel(REFERRAL_URGENCY, key, lang) : '');

/**
 * The Restorative block (core build-up, re-cement, denture, bridge) as readable
 * items. Printed nowhere before v0.0.15, so a denture or a crown recorded at
 * the chair never reached the patient's record.
 */
function restorativeItems(r) {
  const x = r || {};
  const out = [];
  const tooth = (o) => (o && o.tooth ? ` #${o.tooth}` : '');
  if (x.core_buildup && x.core_buildup.on) out.push('Core build-up for crown' + tooth(x.core_buildup));
  if (x.recement && x.recement.on) out.push('Re-cement crown' + tooth(x.recement));
  if (x.denture && x.denture.on) {
    const d = [x.denture.kind, x.denture.action].filter(Boolean).join(', ').toLowerCase();
    out.push('Denture' + (d ? ` — ${d}` : ''));
  }
  if (x.bridge && x.bridge.on) out.push('Bridge' + (x.bridge.action ? ` — ${String(x.bridge.action).toLowerCase()}` : ''));
  return out;
}
/**
 * The retired Services counts (alveoplasty, IRM, buccal, pulpotomy). The card
 * was replaced by Referral in v0.0.15; records that carry counts still print
 * them, because what was done to a patient does not stop being true.
 */
const SERVICE_LABELS = { alveoplasty: 'Alveoplasty', irm: 'IRM', buccal: 'Buccal', pulpotomy: 'Pulpotomy' };
function servicesItems(s) {
  const src = s || {};
  // The paper form's order, then anything this build does not know.
  const keys = [...Object.keys(SERVICE_LABELS), ...Object.keys(src).filter((k) => !SERVICE_LABELS[k])];
  return keys.filter((k) => Number(src[k]) > 0).map((k) => `${SERVICE_LABELS[k] || k} × ${Number(src[k])}`);
}
/**
 * Cleaning keys that record work done. 'teeth' (which teeth were tapped on the
 * chart) and 'quad_detail' (which quadrants) are notes about a cleaning, not a
 * cleaning — the report counters (db.didCleaning) have always said so, and the
 * printed record printed a bogus "teeth" chip for every dentist-saved visit.
 */
function cleaningDone(cleaning) {
  return Object.entries(cleaning || {}).filter(([k, v]) => v && k !== 'quad_detail' && k !== 'teeth').map(([k]) => k);
}

const statusLabel = (s) => STATUS_LABELS[s] || String(s || '');

module.exports = {
  SURFACES, LEGACY_SURFACE_COUNTS, ANESTHETICS, ANES_SITES, DENTAL_REFERRAL_TO, REFERRAL_URGENCY, STATUS_LABELS,
  ANES_LABELS, ANES_SITE_LABELS, SERVICE_LABELS,
  surfaceList, formatSurfaces, anesAgentLabel, anesSiteText, anesRows,
  hasReferralOut, referralDestinations, referralUrgencyLabel,
  restorativeItems, servicesItems, cleaningDone, statusLabel,
};
