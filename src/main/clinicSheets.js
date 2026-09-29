'use strict';
/**
 * Turns a clinic bundle into readable spreadsheet sheets.
 *
 * This is the half a human reads, so it is flattened, labelled in plain English
 * and free of internal codes. It deliberately does NOT carry signatures or x-ray
 * images — those cannot live in a spreadsheet, which is why the export also
 * writes a .chbak.json backup alongside it.
 */
// The medical and dental history are read through the same labels and rules as
// the printed record (medicalLabels.js), so the spreadsheet and the PDF never
// disagree about a patient.
const medicalLabels = require('./medicalLabels');
// Mirrors PRIOR_DENTIST in src/renderer/i18n/strings.js; the harness pins them
// together. Unknown values fall through to the raw text so pre-dropdown records
// still export the answer they recorded.
const PRIOR_DENTIST_LABELS = {
  within_6_months: 'Within the past 6 months',
  about_1_year: 'About 1 year ago',
  about_2_years: 'About 2 years ago',
  over_3_years: '3 or more years ago',
  never: 'Never',
};

const VISIT_TYPES = {
  extraction_pain: 'Extraction — in pain', extraction_no_pain: 'Extraction — not in pain',
  filling: 'Filling', cleaning: 'Dental cleaning',
};

const j = (v, fallback) => {
  if (v == null || v === '') return fallback;
  if (typeof v === 'object') return v;
  try { const p = JSON.parse(v); return p == null ? fallback : p; } catch { return fallback; }
};
// 'na' and 'unsure' are real answers, not missing ones — a man or a child
// answering "Not applicable" is saying something, and printing the raw code in
// an export a funder or a clinician reads is just a leak.
const yn = (v) => medicalLabels.answerLabel(v);
const GENDER = { male: 'Male', female: 'Female', other: 'Other' };
// The allergy answer in the words the kiosk offers it (medicalLabels.js).
const ALLERGY_STATUS = medicalLabels.ALLERGY_STATUS_LABELS;

function ageFrom(dob) {
  if (!dob) return '';
  const d = new Date(dob);
  if (isNaN(d)) return '';
  return Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000));
}

// The Dental Triage lists and the printing rules the PDF shares (surfaces,
// anaesthetic agent and site, restorative, referral, status) — one copy, so the
// spreadsheet and the printed record cannot disagree.
const DL = require('./dentalLabels');

// The record lock in four columns: its state ("Locked", or "Unlocked" with the
// administrator's reason while it is being amended), who locked it and when —
// which, for a record locked before v0.0.15, is its completion, the sign-off
// that locked it — and every unlock of it, which is what an amendment after
// sign-off leaves behind.
function lockColumns(t) {
  const hist = j(t.lock_history, []);
  const unlocks = (Array.isArray(hist) ? hist : []).filter((h) => h && h.action === 'unlock');
  const state = t.locked ? 'Locked' : (t.unlocked_at ? `Unlocked${t.unlock_reason ? ' — ' + t.unlock_reason : ''}` : '');
  return [
    state,
    t.locked ? (t.locked_by_name || t.completed_by_name || '') : '',
    t.locked ? (t.locked_at || t.completed_at || '') : '',
    unlocks.map((h) => [h.at, h.by && 'by ' + h.by, h.reason].filter(Boolean).join(' ')).join('; '),
  ];
}

function clinicSheets(bundle) {
  const b = bundle || {};
  const patients = b.patients || [];
  const triageBy = new Map((b.triage || []).map((r) => [r.patient_id, r]));
  const txBy = new Map((b.treatments || []).map((r) => [r.patient_id, r]));
  const consentsBy = new Map();
  (b.consents || []).forEach((c) => {
    if (!consentsBy.has(c.patient_id)) consentsBy.set(c.patient_id, []);
    consentsBy.get(c.patient_id).push(c);
  });
  const xraysBy = new Map();
  (b.xrays || []).forEach((x) => {
    if (!xraysBy.has(x.patient_id)) xraysBy.set(x.patient_id, []);
    xraysBy.get(x.patient_id).push(x);
  });

  const STATUS = {
    // The shared status map (src/main/dentalLabels.js).
    ...DL.STATUS_LABELS,
  };

  const patientRows = patients.map((p) => {
    const d = j(p.demographics, {}), m = j(p.medical_history, {}), dh = j(p.dental_history, {});
    const tr = triageBy.get(p.id) || {};
    const md = medicalLabels.medicalDisplay(m);
    const dd = medicalLabels.dentalDisplay(dh);
    // Typed-in "other" text is always included, ticked or not — a written
    // allergy must never be missing from an exported record.
    const allergies = md.allergies.map((a) => a.label).join(', ') || (md.allergiesNone ? 'None' : '');
    const conds = md.yes.map((c) => c.label).join(', ') || (md.conditionsNone ? 'None' : '');
    const meds = md.meds.map((x) => [x.name, x.dose].filter(Boolean).join(' '));
    // Retired questions only for a record that has them, so an empty cell
    // there means "not asked", never "answered blank".
    const legacy = Object.fromEntries(md.legacyRows.map((r) => [r.key, r.value]));
    return [
      p.last_name, p.first_name, p.dob, ageFrom(p.dob), GENDER[p.gender] || p.gender, p.language,
      p.phone, p.email, d.address, d.city, d.state,
      d.emergency_name, d.emergency_phone,
      d.preregistered ? 'Online' : 'At the desk',
      VISIT_TYPES[dh.visit_type] || dh.visit_type || '',
      // Was 'Reason' — a free-text box that has been removed from intake. The
      // column now carries the countable answer the dropdown collects; records
      // taken before that keep printing whatever text they hold.
      PRIOR_DENTIST_LABELS[dh.prior_dentist] || dh.prior_dentist || '',
      // Step 3, one column per question, after the last-dental-visit answer.
      ...dd.questions.map((q) => yn(q.value)),
      ALLERGY_STATUS[md.allergyStatus] || '',
      allergies,
      conds,
      md.unsure.map((c) => c.label).join(', '),
      meds.length ? meds.join('; ') : (md.medsNone ? 'None' : ''),
      yn(md.underTreatment), yn(md.surgery), md.surgerySites.join(', '), yn(md.smoke), yn(md.pregnancy),
      yn(legacy.hospitalized), yn(legacy.pregnancy),
      tr.bp_systolic != null && tr.bp_diastolic != null ? `${tr.bp_systolic}/${tr.bp_diastolic}` : '',
      tr.heart_rate == null ? '' : tr.heart_rate,
      // Recorded at Vitals since v0.0.4; exported from v0.0.15.
      tr.glucose == null ? '' : tr.glucose,
      tr.respiration == null ? '' : tr.respiration,
      // Who went through the medical history with the patient at this visit.
      tr.history_reviewed_by_name || (tr.history_reviewed_at ? '—' : ''),
      tr.history_reviewed_at || '',
      // 'dentist' is the Dental Triage station; the stored key never changed.
      tr.route === 'dentist' ? 'Dental Triage' : tr.route === 'hygienist' ? 'Hygienist' : tr.route === 'both' ? 'Dental Triage + Hygienist' : '',
      STATUS[p.status] || p.status,
      p.created_at, p.arrived_at, p.dismissed_at,
    ];
  });

  const treatmentRows = [];
  patients.forEach((p) => {
    const tr = triageBy.get(p.id) || {};
    // Someone x-rayed at Dental Triage and not yet treated still belongs here:
    // the count taken is a Dental Triage figure, recorded before any treatment.
    if (!txBy.has(p.id) && tr.xrays_taken == null) return;
    const t = txBy.get(p.id) || {};
    const fillings = j(t.fillings, []), extractions = j(t.extractions, []), cleaning = j(t.cleaning, {});
    const anes = DL.anesRows(j(t.anesthetic, []));
    // Only a referral that sends the patient somewhere is one (the rule the
    // printed record and every count use); details stored without a
    // destination fill none of its three columns.
    const refRaw = j(t.referral_out, null);
    const ref = DL.hasReferralOut(refRaw) ? refRaw : null;
    const images = (xraysBy.get(p.id) || []).length;
    treatmentRows.push([
      p.last_name, p.first_name,
      extractions.length, extractions.map((e) => e.tooth).filter(Boolean).join(', '),
      // "14 MO"; a filling recorded before v0.0.15 reads "14 2-surface". A
      // legacy string of surfaces used to throw here and stop the export.
      fillings.length, fillings.map((f) => [f.tooth, DL.formatSurfaces(f.surfaces)].filter(Boolean).join(' ')).filter(Boolean).join(', '),
      // 'teeth' and 'quad_detail' are notes on a cleaning, not one.
      DL.cleaningDone(cleaning).length ? 'Yes' : '',
      // Agent by name (never "mepivacaine"), and the injection site, which the
      // spreadsheet did not carry at all before.
      anes.map((x) => [
        DL.anesAgentLabel(x) + (x.carps ? ` × ${x.carps} carp(s)` : ''),
        x.tooth && 'tooth ' + x.tooth,
        DL.anesSiteText(x),
      ].filter(Boolean).join(', ')).join('; '),
      DL.restorativeItems(j(t.restorative, {})).join('; '),
      DL.servicesItems(j(t.services, {})).join('; '),
      ref ? DL.referralDestinations(ref) : '',
      ref && ref.urgency ? DL.referralUrgencyLabel(ref.urgency) : '',
      ref ? [ref.tooth && '#' + ref.tooth, ref.reason].filter(Boolean).join(' — ') : '',
      // Typed at Dental Triage; a visit without the count (every one before
      // v0.0.15) reads its images, as the printed record and the report do.
      tr.xrays_taken == null ? images : tr.xrays_taken,
      images,
      t.other_procedures, t.clinical_notes, t.provider_name, t.completed_at,
      ...lockColumns(t),
    ]);
  });

  const consentRows = [];
  patients.forEach((p) => {
    (consentsBy.get(p.id) || []).forEach((c) => consentRows.push([
      p.last_name, p.first_name,
      c.type === 'oral_surgery' ? 'Oral Surgery' : 'General',
      c.signer_name, c.relationship, c.tooth_numbers,
      String(c.signature_png || '').startsWith('data:image') ? 'Signed' : 'Not signed',
      c.signed_at, c.language, c.version,
    ]));
  });

  const xrayRows = [];
  patients.forEach((p) => {
    (xraysBy.get(p.id) || []).forEach((x) => xrayRows.push([
      p.last_name, p.first_name, x.note, x.tooth, x.station, x.created_at,
    ]));
  });

  return [
    {
      name: 'Patients',
      columns: ['Last name', 'First name', 'Date of birth', 'Age', 'Gender', 'Language',
        'Phone', 'Email', 'Address', 'City', 'State', 'Emergency contact', 'Emergency phone',
        'Registered', 'Needed today', 'Last saw a dentist',
        ...Object.values(medicalLabels.DENTAL_Q_LABELS),
        'Allergy status', 'Allergies', 'Conditions', 'Conditions (unsure)', 'Medications',
        'Under doctor’s care', 'Major surgery (6 mo)', 'Surgery sites', 'Smokes / tobacco', 'Pregnancy',
        'Hospitalized (2 yrs)', 'Pregnant/nursing',
        'Blood pressure', 'Pulse', 'Blood sugar (mg/dL)', 'Respiration (/min)', 'History reviewed by', 'History reviewed at',
        'Sent to', 'Status', 'Checked in at', 'Arrived at', 'Checked out at'],
      rows: patientRows,
    },
    {
      name: 'Treatment',
      columns: ['Last name', 'First name', 'Extractions', 'Teeth extracted', 'Fillings',
        'Teeth filled', 'Cleaning', 'Anaesthetic', 'Restorative', 'Services (recorded before v0.0.15)',
        'Referred to', 'Referral urgency', 'Referral details', 'X-rays taken', 'X-rays uploaded',
        'Other procedures', 'Clinical notes', 'Provider', 'Completed at',
        'Record lock', 'Locked by', 'Locked at', 'Amended after sign-off'],
      rows: treatmentRows,
    },
    {
      name: 'Consents',
      columns: ['Last name', 'First name', 'Consent', 'Signed by', 'Relationship',
        'Tooth numbers', 'Signature', 'Signed at', 'Language', 'Version'],
      rows: consentRows,
    },
    {
      name: 'X-rays',
      columns: ['Last name', 'First name', 'Image name', 'Tooth', 'Station', 'Taken at'],
      rows: xrayRows,
    },
  ];
}

// Summary sheet for a finished clinic — counts only, no patients.
function summarySheets(summary) {
  const s = summary || {};
  const breakdown = (title, obj) => ({
    name: title,
    columns: [title, 'Patients'],
    rows: Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]),
  });
  return [
    {
      name: 'Summary',
      columns: ['Measure', 'Value'],
      rows: [
        ['Clinic', s.event_name], ['Location', s.event_location], ['Start date', s.event_start],
        ['Patients seen', s.patients_seen], ['Visits completed', s.visits_completed],
        ['Extractions', s.extractions], ['Fillings', s.fillings],
        // Taken (typed at Dental Triage) and uploaded are different figures; a
        // summary from before v0.0.15 has only the images, which is what it
        // meant by "taken" then.
        ['Cleanings', s.cleanings], ['X-rays taken', s.xrays_taken != null ? s.xrays_taken : s.xrays],
        ['X-rays uploaded', s.xrays], ['Referred elsewhere for care', s.referrals || 0],
        ['Report generated', s.generated_at],
      ],
    },
    breakdown('By city', s.by_city),
    breakdown('By age', s.by_age),
    breakdown('By gender', s.by_gender),
    breakdown('By language', s.by_language),
    breakdown('By day', s.by_day),
  ];
}

module.exports = { clinicSheets, summarySheets };
