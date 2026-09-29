// The Dental Triage station's own picklists, and the labels every screen and
// export prints for what they store.
//
// Kept apart from strings.js because these are chairside clinical lists, not
// patient-facing intake wording. The main process cannot import an ES module,
// so pdf.js and clinicSheets.js read a CommonJS copy in src/main/dentalLabels.js;
// the harness pins the two together, so a list changed here and not there fails
// the build instead of printing raw codes on a patient's record.

/* ---------------- Tooth surfaces ---------------- */

// The five surfaces MMW asked for, in the order a note writes them — "MO", never
// "OM". Distal (D) and incisal (I) are not on MMW's list; adding one is a single
// line here and in the mirror, and formatSurfaces already prints any letter it
// is handed, so a record made after that change still reads correctly on a
// laptop that has not been updated.
export const SURFACES = [
  { key: 'M', en: 'Mesial' },
  { key: 'F', en: 'Facial' },
  { key: 'L', en: 'Lingual' },
  { key: 'O', en: 'Occlusal' },
  { key: 'B', en: 'Buccal' },
];

// Before v0.0.15 the surface pills were 1, 2, 3 and 4: the NUMBER of surfaces a
// filling covered (the CDT composite coding, read together with Ant/Post), not
// which ones. A count cannot be turned into letters, so those records keep their
// digits and every display prints them as "2-surface". Letters and digits never
// collide, so both can live in the same stored array.
export const LEGACY_SURFACE_COUNTS = ['1', '2', '3', '4'];

/**
 * A stored surfaces value as a list of tokens. Tolerates the shapes older
 * records hold: an array, a comma/space separated string ("1,2"), or a run of
 * capital letters ("MO").
 */
export function surfaceList(value) {
  if (value == null || value === '') return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[\s,;/]+/);
  const out = [];
  for (const item of raw) {
    const tok = String(item == null ? '' : item).trim();
    if (!tok) continue;
    // "MO" typed as one token is two surfaces; a lower-case word is not.
    if (/^[A-Z]{2,}$/.test(tok)) out.push(...tok.split(''));
    else out.push(/^[a-z]$/.test(tok) ? tok.toUpperCase() : tok);
  }
  return Array.from(new Set(out));
}

/**
 * A stored list of teeth (a cleaning's teeth above all) as tooth ids. Older
 * records hold it as a string ("1,2"), which broke Dental Triage's chart and
 * was split into characters — the comma a "tooth" — by the hygienist's.
 */
export function toothList(value) {
  if (value == null || value === '') return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[\s,;/]+/);
  return Array.from(new Set(raw.map((v) => String(v == null ? '' : v).trim()).filter(Boolean)));
}

/**
 * Surfaces as a clinician writes them: letters joined in canonical order ("MO"),
 * a legacy count as "2-surface", anything else verbatim so nothing recorded is
 * ever hidden.
 */
export function formatSurfaces(value) {
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

/* ---------------- Anaesthetic injection site ---------------- */

// PROVISIONAL. MMW's own list has been promised and not yet received; this is
// the standard set of infiltrations and blocks so the field can be a dropdown
// now. When the clinic's list arrives, retire rather than delete: mark a site
// the clinic drops `retired: true` (here and in the mirror). It is then no
// longer offered for a new administration, but a row that records it still
// shows it by name, saves it back, and prints it — a key deleted from here
// would print as its raw code on every old record.
export const ANES_SITES = [
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

/* ---------------- Referral out ---------------- */

// Where the dentist sends a patient for care this clinic cannot give. Stored in
// treatments.referral_out — deliberately NOT "referral", which has always meant
// "how did you hear about us" (demographics.referral). PROVISIONAL list until
// Dr. Trinh confirms it — and retired, never deleted, when it changes, exactly
// as ANES_SITES above: `retired: true` keeps the label for the records that
// use it and offers it only on those. Spanish is kept because the patient's
// own after-care sheet prints where they were referred.
export const DENTAL_REFERRAL_TO = [
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

export const REFERRAL_URGENCY = [
  { key: 'routine', en: 'Routine', es: 'De rutina' },
  { key: 'soon', en: 'Soon', es: 'Pronto' },
  { key: 'urgent', en: 'Urgent', es: 'Urgente' },
];

// How a referral or an injection site READS is decided in one place, the
// CommonJS copy in src/main/dentalLabels.js that the printed record and the
// spreadsheet use; no screen prints them yet, so no second copy lives here to
// drift from it.

/** True when a stored referral_out actually sends the patient somewhere. */
export function hasReferralOut(r) {
  return !!(r && ((Array.isArray(r.to) && r.to.length) || (r.to_other && String(r.to_other).trim())));
}

/* ---------------- Patient status ---------------- */

// Where a patient is in the visit, as every screen and export names it. One map
// so the board, the queues, the Reports tab and the spreadsheet never disagree.
// 'triaged' is the legacy key for "signed off by Vitals, waiting for a provider";
// it covers the hygienist's queue as well as Dental Triage, so it is not called
// "waiting for dental triage". 'treatment_waiting' is new in v0.0.15: examined
// at Dental Triage and waiting for a treatment chair.
export const STATUS_LABELS = {
  checked_in: 'Checked in',
  triaged: 'Waiting for provider',
  treatment_waiting: 'Treatment waiting',
  in_treatment: 'In treatment',
  completed: 'Completed',
  dismissed: 'Checked out',
};
export const statusLabel = (s) => STATUS_LABELS[s] || String(s || '—');
