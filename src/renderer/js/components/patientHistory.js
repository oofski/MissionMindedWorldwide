import { el } from '../dom.js';
import { icon } from '../icons.js';
import { referralLabel } from '../i18n.js';
import { medicalDisplay, dentalDisplay } from '../medicalHistory.js';

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

// Full patient history (demographics + medical + dental + consents + prior
// visits) rendered as a set of cards. Shared by Records, Provider, and Triage
// so clinicians always see the complete intake history.
export function patientHistoryCards(p, priorVisits = []) {
  const card = (ic, title, ...kids) => el('div', { class: 'card' }, [el('div', { class: 'card-title' }, [icon(ic, { size: 15 }), title]), ...kids]);

  const out = [];

  out.push(card('user', 'Patient information', el('div', { class: 'kv-grid' }, demographicsRows(p))));

  const med = medicalHistoryParts(p.medical_history);
  out.push(card('clipboard', 'Medical history', med.kvGrid, ...med.parts));

  const dent = dentalHistoryParts(p);
  out.push(card('tooth', 'Dental history', dent.kvGrid, dent.legacy));

  if ((p.consents || []).length) {
    out.push(card('pen', 'Consents & signatures',
      el('div', { class: 'consent-grid' }, p.consents.map((c) => el('div', { class: 'consent-card' }, [
        el('div', { class: 'consent-card-title' }, [c.type === 'oral_surgery' ? 'Oral Surgery Consent' : 'General Consent']),
        el('div', { class: 'muted' }, [`${c.signer_name}${c.relationship ? ' (' + c.relationship + ')' : ''}`]),
        el('div', { class: 'muted small' }, [`${c.version} · ${new Date(c.signed_at).toLocaleString()}`]),
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
    out.push(card('calendar', `Previous visits (${priorVisits.length})`,
      el('div', { class: 'data-table-wrap' }, [el('table', { class: 'data-table data-table--mini' }, [
        el('thead', {}, [el('tr', {}, ['Date', 'Event', 'Treatment', 'Status'].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, priorVisits.map((v) => el('tr', {}, [
          el('td', {}, [new Date(v.created_at).toLocaleDateString()]),
          el('td', {}, [v.event_name]),
          el('td', {}, [v.summary]),
          el('td', {}, [v.status]),
        ]))),
      ])])));
  }

  return out;
}

// Collapsible wrapper around patientHistoryCards. Keeps dense clinical screens
// tidy — the full intake history stays one click away instead of always open.
// Pass { open:true } to expand by default.
export function patientHistoryPanel(p, priorVisits = [], { open = false, title = 'Patient health history' } = {}) {
  const cards = patientHistoryCards(p, priorVisits);
  const body = el('div', { class: 'collapse-body' }, [el('div', { class: 'history-grid' }, cards)]);
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
