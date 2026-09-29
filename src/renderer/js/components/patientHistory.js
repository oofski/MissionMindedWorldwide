import { el, clear, toast, modal } from '../dom.js';
import { statusLabel } from '../../i18n/dentalLists.js';
import { icon } from '../icons.js';
import { referralLabel, raceLabel } from '../i18n.js';
import { medicalDisplay, dentalDisplay, firstMissingMedical, normalizeMedical } from '../medicalHistory.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { demographicsSection, medicalHistorySection, dentalHistorySection, eventCities } from './intakeSections.js';

// A history answer as the clinician should read it. 'na' (the pregnancy row's
// fourth answer) and 'unsure' must not surface as raw codes — "na" next to
// "Pregnant" is exactly the kind of thing a reader resolves by guessing.
export function historyAnswer(v) {
  if (v === 'yes') return 'Yes';
  if (v === 'no') return 'No';
  if (v === 'unsure') return 'Unsure';
  if (v === 'na') return 'Not applicable';
  return v;
}

// Stored demographic codes in words. Anything else — a record typed before
// these were dropdowns — is shown as it was typed rather than hidden.
const GENDER_LABELS = { male: 'Male', female: 'Female', other: 'Other' };
const MARITAL_LABELS = { single: 'Single', married: 'Married', divorced: 'Divorced', widowed: 'Widowed' };
export function genderLabel(v) { return GENDER_LABELS[v] || (v || ''); }
export function maritalLabel(v) { return MARITAL_LABELS[v] || (v || ''); }
// "How did you hear about us?", with the typed detail when the answer is Other.
export function referralDisplay(demographics = {}) {
  const key = demographics.referral;
  if (!key) return '';
  const label = referralLabel(key);
  if (key === 'other' && demographics.referral_other) return `${label}: ${demographics.referral_other}`;
  return label;
}

const kv = (label, val) => el('div', { class: 'kv' }, [el('span', { class: 'kv-label' }, [label]), el('span', { class: 'kv-val' }, [val == null || val === '' ? '—' : String(val)])]);
const field = (label, ...kids) => el('div', { class: 'field' }, [el('span', { class: 'field-label' }, [label]), ...kids]);
const pill = (cls, label, dot) => el('span', { class: `pill ${cls}` }, [dot ? el('span', { class: 'pill-dot' }) : null, label]);
const muted = (txt) => el('span', { class: 'muted' }, [txt]);

// The services asked at registration, in words; a key a newer build added is
// shown as stored rather than hidden.
const SERVICE_LABELS = { dental: 'Dental', medical: 'Medical', vision: 'Vision' };
const listText = (arr, label) => (Array.isArray(arr) ? arr.filter(Boolean).map(label).join(', ') : '');

/** The "Patient information" rows, shared by every screen that shows them. */
export function demographicsRows(p) {
  const d = p.demographics || {};
  return [
    kv('Date of birth', p.dob), kv('Age', p.age != null ? p.age : '—'),
    kv('Gender', genderLabel(p.gender)), kv('Marital status', maritalLabel(d.marital_status)),
    kv('Phone', p.phone), kv('Email', p.email),
    kv('Address', d.address), kv('City', d.city), kv('State', d.state),
    kv('Mailing address', d.mailing_address),
    kv('Heard about us', referralDisplay(d)),
    kv('Emergency contact', d.emergency_name), kv('Emergency phone', d.emergency_phone),
    // Asked at registration and until now shown nowhere after it.
    kv('Services needed', listText(d.services, (k) => SERVICE_LABELS[k] || k)),
    kv('Race / ethnicity', listText(d.race, raceLabel)),
    // The band's number, so a torn band can be matched to the record by eye.
    kv('Wristband ID', p.patient_code),
  ];
}

/**
 * The medical history as a clinician reads it — one definition for the chart,
 * the hygienist, Vitals and Records, so no screen can show less than another.
 *
 * A record answered on Dr. Trinh's form (v0.0.15) shows its allergy answer
 * (NKDA / the list / "Unsure — ask"), the conditions answered Yes, a separate
 * Unsure group, major surgery with its sites and the pregnancy answer. An older
 * checklist record shows what it ticked; nothing it did not tick is shown as
 * "No", and its retired questions (hospitalized, pregnant / nursing) appear
 * only because it has them. Returns { kvGrid, parts } so a screen can slot
 * its own rows (vitals, blood thinner) between them.
 */
export function medicalHistoryParts(m) {
  const md = medicalDisplay(m || {}, 'en');
  const rows = [kv('Under doctor\u2019s care', historyAnswer(md.underTreatment))];
  if (md.version === 2 || md.surgery) {
    rows.push(kv('Major surgery (6 mo)', md.surgery === 'yes' && md.surgerySites.length
      ? `Yes — ${md.surgerySites.join(', ')}` : historyAnswer(md.surgery)));
  }
  rows.push(kv('Smokes / tobacco', historyAnswer(md.smoke)));
  if (md.version === 2) rows.push(kv('Pregnancy', historyAnswer(md.pregnancy)));
  // A retired answer carried into a record answered on the new form is marked
  // as the earlier form's, so it cannot be read against today's answer.
  md.legacyRows.forEach((r) => rows.push(kv(md.version === 2 ? r.label + ' (earlier form)' : r.label, historyAnswer(r.value))));

  // SAFETY: a typed "Other" allergy (e.g. "Sulfa") is in the list with the
  // ticked ones — a written allergy must never be invisible on screen.
  let allergyKids;
  if (md.allergies.length) allergyKids = md.allergies.map((a) => pill('pill--danger', a.label, true));
  else if (md.allergyStatus === 'unsure') allergyKids = [pill('pill--warning', 'Unsure — ask the patient', true)];
  else if (md.allergyStatus === 'yes') allergyKids = [pill('pill--warning', 'Yes — none named; ask the patient', true)];
  else allergyKids = [muted(md.allergySummary)];
  const condKids = md.yes.length
    ? md.yes.map((c) => pill(c.flag ? 'pill--danger' : 'pill--info', c.label, c.flag))
    : [muted(md.conditionsNone ? 'None (reviewed)' : md.unsure.length ? 'None answered Yes' : 'None reported')];
  // A medication checklist has no dose; the columns appear only when a row
  // (usually an older record) actually has one.
  const withDose = md.meds.some((x) => x.dose || x.reason);
  const medTable = md.meds.length ? el('div', { class: 'data-table-wrap' }, [el('table', { class: 'data-table data-table--mini' }, [
    el('thead', {}, [el('tr', {}, (withDose ? ['Medication', 'Dose', 'Reason'] : ['Medication']).map((h) => el('th', {}, [h])))]),
    el('tbody', {}, md.meds.map((x) => el('tr', {}, withDose
      ? [el('td', {}, [x.name]), el('td', {}, [x.dose || '—']), el('td', {}, [x.reason || '—'])]
      : [el('td', {}, [x.name])]))),
  ])]) : null;

  return {
    display: md,
    kvGrid: el('div', { class: 'kv-grid' }, rows),
    parts: [
      field('Allergies', el('div', { class: 'chip-row' }, allergyKids)),
      field('Conditions', el('div', { class: 'chip-row' }, condKids)),
      md.unsure.length ? field('Unsure — ask the patient', el('div', { class: 'chip-row' }, md.unsure.map((c) => pill('pill--warning', c.label, c.flag)))) : null,
      field('Current medications', medTable || muted(md.medsNone ? 'None (reviewed)' : 'None reported')),
    ],
  };
}

/**
 * The dental history rows: what the patient needs and when they last saw a
 * dentist, Dr. Trinh's eight Step 3 answers, then — only for a record that has
 * them — the questions asked before v0.0.15, labelled as an earlier form.
 */
export function dentalHistoryParts(p) {
  const dh = p.dental_history || {};
  const dd = dentalDisplay(dh, 'en');
  const complaint = (p.triage && p.triage.complaint) || dd.reason;
  return {
    display: dd,
    kvGrid: el('div', { class: 'kv-grid' }, [
      kv('What patient needs', dd.need),
      // "Reason for today's visit" is no longer asked — "What patient needs"
      // above is the countable version of the same question. Records taken
      // before that change still hold the prose, and it is still shown for them:
      // it is a real thing the patient said, and hiding it would lose it.
      complaint ? kv('Reason for visit', complaint) : null,
      kv('Last saw a dentist', dd.priorDentist),
      ...dd.questions.map((q) => kv(q.short, historyAnswer(q.value))),
    ]),
    legacy: dd.legacy.length ? el('div', { class: 'field' }, [
      el('span', { class: 'field-label' }, ['Earlier intake questions']),
      el('div', { class: 'kv-grid' }, dd.legacy.map((l) => kv(l.label, historyAnswer(l.value)))),
    ]) : null,
  };
}

// A record created by the old (v1.0) intake bug has no name / empty histories.
export function isIncompleteRecord(p) {
  const noName = !(p.first_name || '').trim() || !(p.last_name || '').trim();
  const d = p.demographics || {}, m = p.medical_history || {}, dh = p.dental_history || {};
  const emptyData = !Object.keys(d).length && !Object.keys(m).length && !Object.keys(dh).length;
  // BOTH, not either. A patient whose name simply wasn't captured can still have
  // vitals, a signed consent and x-rays on file, and "delete this empty record"
  // cascades all of it. Only a record that is genuinely empty qualifies.
  return noName && emptyData;
}

// A clear banner explaining an incomplete legacy record, with optional actions.
export function incompleteBanner(p, { isAdmin, onDelete, onNewCheckin } = {}) {
  if (!isIncompleteRecord(p)) return null;
  const acts = el('div', { class: 'inline-row', style: 'margin-top:10px' });
  if (onNewCheckin) acts.append(el('button', { class: 'btn btn--primary btn--sm', onClick: onNewCheckin }, [icon('clipboard', { size: 14 }), 'Start a new check-in']));
  if (isAdmin && onDelete) acts.append(el('button', { class: 'btn btn--danger btn--sm', onClick: onDelete }, [icon('trash', { size: 14 }), 'Delete this empty record']));
  return el('div', { class: 'banner banner--alert', style: 'flex-direction:column;align-items:flex-start' }, [
    el('div', { style: 'display:flex;gap:9px;align-items:center' }, [
      icon('alert', { size: 16 }),
      el('span', {}, ['This record is missing its intake data. It was created on an older version of the app, before the intake fix. New check-ins capture everything correctly — this empty record can be removed.']),
    ]),
    acts,
  ]);
}

/* ------------------------------------------------------------------ */
/*  Who may change what                                                */
/* ------------------------------------------------------------------ */

// Which staff role may correct which part of the intake. Mirrors db.js
// SECTION_ROLES, which db.updatePatientSection enforces on every save (and
// ipc.js before it); the harness pins the two together. Everyone who meets
// the patient can fix their phone number; the health history is the clinical
// roles'.
export const SECTION_ROLES = {
  demographics: ['admin', 'registration', 'emt', 'triage', 'doctor', 'hygienist', 'checkout'],
  medical_history: ['admin', 'emt', 'triage', 'doctor', 'hygienist'],
  dental_history: ['admin', 'emt', 'triage', 'doctor', 'hygienist'],
};
const SECTION_TITLES = { demographics: 'Patient information', medical_history: 'Medical history', dental_history: 'Dental history' };

/**
 * What the signed-in role may do with each section of this patient's record:
 *   'edit'            may change it
 *   'identity-locked' (patient information only) contact details yes; name,
 *                     date of birth and gender are an administrator's once the
 *                     record is signed off and locked
 *   'locked'          signed off and locked — an administrator unlocks it first
 *   null              not this role's to change
 * The same rule the data layer applies, so a button is never offered for a
 * save that would be refused.
 */
export function editableSections(p, role = store.user && store.user.role) {
  const locked = !!(p && p.treatment && p.treatment.locked);
  const admin = role === 'admin';
  const out = {};
  for (const [section, roles] of Object.entries(SECTION_ROLES)) {
    if (!role || !roles.includes(role)) { out[section] = null; continue; }
    if (!locked || admin) out[section] = 'edit';
    else out[section] = section === 'demographics' ? 'identity-locked' : 'locked';
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Lines shown with the medical history                               */
/* ------------------------------------------------------------------ */

// The four yes/no questions the Vitals station asked before v0.0.15 (the "EMT
// review" card). The card is gone; what it recorded is still part of the
// patient's record, said to be the earlier confirmations, and never merged into
// the history — the patient's form and the EMT's question are two statements.
const EMT_REVIEW_LABELS = {
  pregnant: 'Pregnant', recent_surgery: 'Recent surgery / hospitalization',
  diabetic: 'Diabetic', allergies_meds: 'Medication allergies',
};
export function emtConfirmationsText(tr) {
  const r = tr && tr.emt_review && typeof tr.emt_review === 'object' ? tr.emt_review : {};
  const parts = Object.entries(r).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${EMT_REVIEW_LABELS[k] || k.replace(/_/g, ' ')}: ${historyAnswer(v)}`);
  return parts.length ? 'Earlier EMT confirmations: ' + parts.join(' · ') : '';
}
const fmtWhen = (w) => { if (!w) return ''; const d = new Date(w); return isNaN(d.getTime()) ? String(w) : d.toLocaleString(); };

/** "Reviewed by X · time", or null when this visit's history was not reviewed. */
export function historyReviewText(p) {
  const tr = (p && p.triage) || {};
  if (!tr.history_reviewed_at && !tr.history_reviewed_by_name) return null;
  return `Reviewed by ${tr.history_reviewed_by_name || '—'}${tr.history_reviewed_at ? ' · ' + fmtWhen(tr.history_reviewed_at) : ''}`;
}

// Full patient history (demographics + medical + dental + consents + prior
// visits) rendered as a set of cards. Shared by Records, Provider, Vitals,
// the hygienist, check-out and the front desk, so every station reads the
// same intake the same way.
//
// opts (all optional — without them the cards are read-only, as they were):
//   editable      editableSections() for the signed-in role
//   onEdit(sec)   opens that section's editor
//   review        { onReviewed } — the Vitals review: the "reviewed" stamp and
//                 a "Reviewed with patient — no changes" button
//   medicalExtras nodes a screen adds to the medical card (Records: vitals and
//                 the blood-thinner line)
export function patientHistoryCards(p, priorVisits = [], { editable = null, onEdit = null, review = null, medicalExtras = [] } = {}) {
  const editBtn = (section) => {
    const mode = editable && editable[section];
    if (!mode || mode === 'locked' || !onEdit) return null;
    return el('button', {
      class: 'btn btn--ghost btn--sm card-edit', type: 'button', title: `Edit ${SECTION_TITLES[section].toLowerCase()}`,
      onClick: () => onEdit(section),
    }, [icon('pen', { size: 13 }), 'Edit']);
  };
  const lockNote = (section) => (editable && editable[section] === 'locked'
    ? el('p', { class: 'subtle small card-lock-note' }, [icon('lock', { size: 12 }), ' Signed off and locked — an administrator can unlock it to change this.'])
    : null);
  const card = (ic, title, section, ...kids) => el('div', { class: 'card', dataset: section ? { section } : {} }, [
    el('div', { class: 'card-title' }, [icon(ic, { size: 15 }), title, section ? editBtn(section) : null]),
    section ? lockNote(section) : null,
    ...kids,
  ]);

  const out = [];

  out.push(card('user', 'Patient information', 'demographics', el('div', { class: 'kv-grid' }, demographicsRows(p))));

  const med = medicalHistoryParts(p.medical_history);
  const tr = p.triage || {};
  const emtLine = emtConfirmationsText(tr);
  const reviewed = historyReviewText(p);
  let reviewBlock = null;
  if (review) {
    // The Vitals review. Not a gate on sending the patient on — vitals already
    // are one — but the station says plainly when it has not been done.
    const canReview = editable && editable.medical_history === 'edit';
    const gap = firstMissingMedical(p.medical_history || {});
    reviewBlock = el('div', { class: 'history-review' }, [
      reviewed
        ? el('p', { class: 'small history-review-stamp' }, [icon('checkCircle', { size: 13 }), ' ', reviewed])
        : el('p', { class: 'small history-review-stamp history-review-stamp--none' }, [icon('alert', { size: 13 }), ' Not yet reviewed at this visit']),
      canReview && !gap && review.onReviewed
        ? el('button', { class: 'btn btn--soft btn--sm', type: 'button', onClick: review.onReviewed }, [icon('check', { size: 14 }), 'Reviewed with patient — no changes'])
        : null,
      // A history with a question unanswered at this visit (a returning
      // patient's pregnancy and recent surgery, an older record's new
      // questions) is gone through with Edit, not ticked as reviewed.
      canReview && gap
        ? el('p', { class: 'subtle small' }, ['Some questions have not been answered at this visit — use Edit to go through them with the patient.'])
        : null,
    ]);
  }
  out.push(card('clipboard', 'Medical history', 'medical_history',
    reviewBlock,
    med.kvGrid,
    ...(medicalExtras || []),
    ...med.parts,
    // Outside the Vitals review, the stamp is a line of the history like any other.
    !review && reviewed ? el('p', { class: 'subtle small' }, [reviewed]) : null,
    emtLine ? el('p', { class: 'muted small emt-confirmations' }, [emtLine]) : null));

  const dent = dentalHistoryParts(p);
  out.push(card('tooth', 'Dental history', 'dental_history', dent.kvGrid, dent.legacy));

  if ((p.consents || []).length) {
    out.push(card('pen', 'Consents & signatures', null,
      el('div', { class: 'consent-grid' }, p.consents.map((c) => el('div', { class: 'consent-card' }, [
        el('div', { class: 'consent-card-title' }, [c.type === 'oral_surgery' ? 'Oral Surgery Consent' : 'General Consent']),
        el('div', { class: 'muted' }, [`${c.signer_name}${c.relationship ? ' (' + c.relationship + ')' : ''}`]),
        el('div', { class: 'muted small' }, [`${c.version} · ${new Date(c.signed_at).toLocaleString()}`]),
        // The teeth an oral-surgery consent covers, and who added them after
        // the patient signed — what Records has always shown.
        c.tooth_numbers ? el('div', { class: 'field', style: 'margin-top:6px' }, [
          el('span', { class: 'field-label' }, ['Teeth']),
          el('div', { class: 'chip-row' }, [el('span', { class: 'pill pill--info' }, [c.tooth_numbers])]),
          c.amended_by ? el('div', { class: 'muted small' }, [`(added by ${c.amended_by}${c.amended_at ? ' on ' + new Date(c.amended_at).toLocaleString() : ''})`]) : null,
        ]) : null,
        c.signature_png ? el('img', { class: 'sig-thumb', src: c.signature_png }) : null,
        // Say how it was signed. A typed or generated mark is a valid record of
        // assent, but it is not a drawn signature and the chart should not imply
        // that it is.
        c.signature_method && c.signature_method !== 'draw'
          ? el('span', { class: 'subtle small' }, [c.signature_method === 'type' ? 'Signed by typed name' : 'Signature generated from typed name'])
          : null,
      ])))));
  }

  if (priorVisits && priorVisits.length) {
    out.push(card('calendar', `Previous visits (${priorVisits.length})`, null,
      el('div', { class: 'data-table-wrap' }, [el('table', { class: 'data-table data-table--mini' }, [
        el('thead', {}, [el('tr', {}, ['Date', 'Event', 'Treatment', 'Status'].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, priorVisits.map((v) => el('tr', {}, [
          el('td', {}, [new Date(v.created_at).toLocaleDateString()]),
          el('td', {}, [v.event_name]),
          el('td', {}, [v.summary]),
          // Labelled, never the stored code ("treatment_waiting").
          el('td', {}, [statusLabel(v.status)]),
        ]))),
      ])])));
  }

  return out;
}

// Collapsible wrapper around patientHistoryCards. Keeps dense clinical screens
// tidy — the full intake history stays one click away instead of always open.
// Pass { open:true } to expand by default. Read-only; patientInfoPanel is the
// same panel with the editing wired in.
export function patientHistoryPanel(p, priorVisits = [], { open = false, title = 'Patient health history' } = {}) {
  return collapsePanel(title, open, el('div', { class: 'history-grid' }, patientHistoryCards(p, priorVisits)));
}

function collapsePanel(title, open, content) {
  const body = el('div', { class: 'collapse-body' }, [content]);
  const state = el('span', { class: 'subtle small' }, [open ? 'Hide' : 'Show']);
  const summary = el('summary', {}, [
    el('span', { style: 'display:flex;align-items:center;gap:9px' }, [icon('records', { size: 16 }), title]),
    state,
  ]);
  const details = el('details', { class: 'collapse' }, [summary, body]);
  if (open) details.setAttribute('open', '');
  details.addEventListener('toggle', () => { state.textContent = details.open ? 'Hide' : 'Show'; });
  return details;
}

/* ------------------------------------------------------------------ */
/*  The patient-info panel: view for all, edit by role and lock        */
/* ------------------------------------------------------------------ */

/**
 * The patient's intake — who they are, their medical and dental history, their
 * consents — with an Edit button on each section the signed-in role may
 * change. Used at every station.
 *
 * After a save the panel repaints ITSELF with the saved record and hands it to
 * onSaved(p); the station around it is not re-rendered, so vitals typed but
 * not yet saved, or a chart half filled in, are never lost to an edit made
 * alongside them. `review: true` adds the Vitals review stamp and button.
 * `medicalExtras(p)` returns nodes for the medical card (Records' vitals).
 */
export function patientInfoPanel(p, { open = false, title = 'Patient health history', ...opts } = {}) {
  const details = collapsePanel(title, open, patientInfoCards(p, opts));
  details.classList.add('patient-info');
  return details;
}

/**
 * The same cards and editing as patientInfoPanel, without the collapsible
 * wrapper — for a screen that IS the record (Records). `stack: true` lays the
 * cards out full width, one under another, instead of the compact grid;
 * `emptyConsents: true` says "No consents on file" rather than leaving the card
 * out.
 */
export function patientInfoCards(p, { priorVisits = [], onSaved = null, review = false, medicalExtras = null, stack = false, emptyConsents = false } = {}) {
  let current = p;
  const grid = el('div', { class: stack ? 'patient-info-stack' : 'history-grid' });
  const saved = (np) => { current = np; paint(); if (onSaved) onSaved(np); };
  function paint() {
    clear(grid);
    patientHistoryCards(current, priorVisits, {
      editable: editableSections(current),
      onEdit: (section) => openSectionEditor(current, section, { onSaved: saved }),
      review: review ? { onReviewed: () => markReviewed(current, saved) } : null,
      medicalExtras: typeof medicalExtras === 'function' ? medicalExtras(current) : (medicalExtras || []),
    }).forEach((c) => grid.append(c));
    if (emptyConsents && !(current.consents || []).length) {
      grid.append(el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('pen', { size: 15 }), 'Consents & signatures']),
        el('span', { class: 'muted' }, ['No consents on file']),
      ]));
    }
  }
  paint();
  return grid;
}

// "Reviewed with patient — no changes": stamps this visit's review.
async function markReviewed(p, done) {
  try {
    const np = await api.updatePatientSection(p.id, 'medical_history', {}, { reviewedOnly: true });
    toast('Medical history marked reviewed', 'success');
    done(np);
  } catch (e) { toast(e.message, 'error'); }
}

// A value that is nothing: absent, null, blank text or an empty list. Two
// nothings are the same answer, so opening and saving a record does not
// report a field as changed because the form writes '' where it held nothing.
const isNothing = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
// The CHANGES between two readings of a section — the form as it opened and
// the form as it is saved — in the shape the data layer merges: a changed key
// with its new value, a removed key as null, everything unchanged left out —
// so a key this screen never showed can never be overwritten by it.
export function sectionPatch(before = {}, after = {}) {
  const out = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  keys.forEach((k) => {
    const a = (after || {})[k];
    const b = (before || {})[k];
    if (isNothing(a) && isNothing(b)) return;
    if (a === undefined) { out[k] = null; return; }
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = a;
  });
  return out;
}
// A patch merged into a stored blob the way the data layer merges it
// (db.mergePatch): a key sent as null is removed, every other key replaced.
function applyPatch(stored = {}, patch = {}) {
  const out = { ...(stored || {}) };
  Object.entries(patch || {}).forEach(([k, v]) => {
    if (v === undefined) return;
    if (v === null) delete out[k]; else out[k] = v;
  });
  return out;
}

/**
 * The medical history's changes, such that what the data layer stores is what
 * the form showed when it was saved.
 *
 * The data layer merges the changes into the STORED record and normalises it,
 * while the form reads an older checklist record in today's terms: a listed
 * allergy is a "Yes" to the allergy question, an allergy typed in without the
 * "Other" tick is ticked as Other. Those readings are answers on the screen the
 * patient is taken through, so the save carries them too. Sent as changes only,
 * the stored record never gained them: the save was refused for a question the
 * form showed answered ("Required: Do you have an allergy…" beside a "Yes"), and
 * the one answer that did save, Unsure, wiped the allergies.
 *
 * Each key the merged-and-normalised result would still have different from the
 * form is added, until none is; readings the data layer makes anyway (an empty
 * dose, a derived condition list) are never sent. An unchanged save of a record
 * that already stands complete stays empty — the review of it with the patient.
 */
export function medicalPatch(stored = {}, start = {}, out = {}) {
  const patch = sectionPatch(start, out);
  if (!Object.keys(patch).length && !firstMissingMedical(stored)) return patch;
  const keys = new Set([...Object.keys(stored || {}), ...Object.keys(out || {})]);
  for (let pass = 0; pass <= keys.size; pass++) {
    const gap = sectionPatch(normalizeMedical(applyPatch(stored, patch)), out);
    const add = Object.keys(gap).filter((k) => !Object.prototype.hasOwnProperty.call(patch, k));
    if (!add.length) break;
    add.forEach((k) => { patch[k] = gap[k]; });
  }
  return patch;
}

const PERSON_KEYS = ['first_name', 'last_name', 'dob', 'gender', 'phone', 'email'];
const IDENTITY_KEYS = ['first_name', 'last_name', 'dob', 'gender'];
function personOf(p) {
  const o = {};
  PERSON_KEYS.forEach((k) => { o[k] = p[k]; });
  return o;
}

/**
 * Edit one section of the patient's intake in an overlay on top of the page.
 *
 * The form is the intake's own (intakeSections.js): the same questions and the
 * same required answers as check-in, pre-filled from the record. The overlay
 * is a body-level .modal-overlay, so neither the front desk's 15-second
 * repaint nor a cloud refresh can wipe a half-made edit, and a refused Save
 * leaves it open with what was typed. Only the CHANGES are sent.
 */
export function openSectionEditor(p, section, { onSaved } = {}) {
  const mode = editableSections(p)[section];
  if (!mode || mode === 'locked') { toast('Your role cannot change this part of the record.', 'error'); return null; }
  const lockIdentity = mode === 'identity-locked';
  let sec;
  let before;
  if (section === 'demographics') {
    before = { ...personOf(p), demographics: p.demographics || {} };
    sec = demographicsSection(before, { staff: true, cities: eventCities(p.event), lockIdentity });
  } else if (section === 'medical_history') {
    before = p.medical_history || {};
    sec = medicalHistorySection(before, { staff: true });
  } else {
    before = p.dental_history || {};
    sec = dentalHistorySection(before, { staff: true, includeVisitType: true });
  }

  const overlay = el('div', { class: 'modal-overlay section-editor', dataset: { section } });
  const close = () => overlay.remove();
  const saveBtn = el('button', { class: 'btn btn--primary', type: 'button' }, [icon('save', { size: 15 }), 'Save']);
  const cancel = async () => {
    if (sec.isDirty()) {
      const ok = await modal({ title: 'Discard your changes?', body: 'What you changed here has not been saved.', confirmText: 'Discard', cancelText: 'Keep editing', danger: true });
      if (!ok) return;
    }
    close();
  };
  // The changes are measured from the form as it opened (initial()), not from
  // the stored blob: the form reads an older record in today's terms — a
  // state as its code, a town in the list's spelling, "prefer not to say"
  // alone — and diffing against the raw record sent those readings as edits
  // nobody made, audited as a patient edit, riding along with a phone fix.
  const start = sec.initial();
  saveBtn.addEventListener('click', async () => {
    const out = sec.collect();
    if (!out) return; // the form has said which answer it needs
    let patch;
    if (section === 'demographics') {
      patch = sectionPatch(personOf(start), personOf(out));
      if (lockIdentity) IDENTITY_KEYS.forEach((k) => { delete patch[k]; });
      const dm = sectionPatch(start.demographics || {}, out.demographics || {});
      if (Object.keys(dm).length) patch.demographics = dm;
    } else if (section === 'medical_history') {
      // The history's answers are saved as the form shows them, including an
      // older record's answers read in today's terms (medicalPatch).
      patch = medicalPatch(before, start, out);
    } else {
      patch = sectionPatch(start, out);
    }
    // Saving an unchanged medical history is still a review of it with the
    // patient; any other unchanged section simply closes.
    if (!Object.keys(patch).length && section !== 'medical_history') { toast('No changes to save.', 'info'); close(); return; }
    saveBtn.disabled = true;
    try {
      const np = await api.updatePatientSection(p.id, section, patch);
      toast(section === 'medical_history' && !Object.keys(patch).length ? 'Medical history marked reviewed' : `${SECTION_TITLES[section]} saved`, 'success');
      close();
      if (onSaved) onSaved(np);
    } catch (e) {
      toast(e.message, 'error');
      saveBtn.disabled = false;
    }
  });
  const who = `${p.first_name || ''} ${p.last_name || ''}`.trim();
  overlay.append(el('div', { class: 'modal-card modal-card--wide' }, [
    el('h3', { class: 'modal-title' }, [`${SECTION_TITLES[section]}${who ? ' — ' + who : ''}`]),
    el('div', { class: 'modal-body' }, [
      lockIdentity ? el('p', { class: 'banner banner--locked' }, [icon('lock', { size: 14 }),
        'This record is signed off and locked. Name, date of birth and gender can only be changed by an administrator; contact details can still be updated.']) : null,
      sec.node,
    ]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn--ghost', type: 'button', onClick: cancel }, ['Cancel']),
      saveBtn,
    ]),
  ]));
  document.body.append(overlay);
  return overlay;
}

/**
 * The patient's information in an overlay of its own, for a screen whose rows
 * are a list rather than a chart (the front desk's Arrivals, the dashboard).
 * View for every role, Edit per section by role; onChanged(p) after a save so
 * the list behind it can refresh.
 */
export async function openPatientInfo(idOrPatient, { onChanged } = {}) {
  let p;
  try {
    p = typeof idOrPatient === 'object' && idOrPatient ? idOrPatient : await api.getPatient(idOrPatient);
  } catch (e) { toast(e.message, 'error'); return null; }
  const overlay = el('div', { class: 'modal-overlay patient-info-overlay' });
  const panel = patientInfoPanel(p, {
    open: true,
    title: 'Patient information',
    onSaved: (np) => { if (onChanged) onChanged(np); },
  });
  overlay.append(el('div', { class: 'modal-card modal-card--wide' }, [
    el('h3', { class: 'modal-title' }, [`${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Patient']),
    el('div', { class: 'modal-body' }, [panel]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn--primary', type: 'button', onClick: () => overlay.remove() }, ['Close']),
    ]),
  ]));
  document.body.append(overlay);
  return overlay;
}
