// The medical and dental history as DATA — no DOM, no current-language state.
//
// One place decides what the stored answers mean, so the kiosk, the online
// form's twin (cloud/worker.js), every clinical screen, the printed record and
// the spreadsheet cannot disagree about it. src/main/medicalLabels.js is the
// CommonJS mirror the main process uses (pdf.js and clinicSheets.js cannot
// import this module); the harness runs both over the same records and fails
// on any difference.
//
// Two shapes live side by side in patients.medical_history:
//
//   history_version 2 (v0.0.15, Dr. Trinh's form) — every one of the 25
//   conditions answered Yes / No / Unsure in `condition_answers`, an allergy
//   gate (NKDA / Yes / Unsure), a medication checklist, major surgery in the
//   last six months with body sites, "Do you smoke?".
//
//   Everything older — a CHECKLIST. An unticked condition there means "not
//   reported", never "No", and no display may render it as No.
//
// The v2 form still writes the old derived arrays (`conditions`, `allergies`,
// the *_none flags) alongside its answers, so the blood-thinner rules, the
// report counts and a station still on an older build keep working unchanged.

import { CONDITIONS, ALLERGIES, MED_CHECKLIST, SURGERY_SITES, DENTAL_QUESTIONS, DENTAL_LEGACY, VISIT_TYPES, PRIOR_DENTIST } from '../i18n/strings.js';

export const HISTORY_VERSION = 2;
// The 25 conditions asked at check-in, in the order they are asked.
export const INTAKE_CONDITIONS = CONDITIONS.filter((c) => c.intake !== false).map((c) => c.key);
export const INTAKE_ALLERGIES = ALLERGIES.filter((a) => a.intake !== false).map((a) => a.key);
export const ALLERGY_STATUSES = ['nkda', 'yes', 'unsure'];
// Only the pregnancy row also accepts "Not applicable" — his form says "(when
// applicable)", and a man or a child must be able to answer it truthfully.
export function conditionAnswers(key) {
  return key === 'pregnant' ? ['yes', 'no', 'unsure', 'na'] : ['yes', 'no', 'unsure'];
}

const COND_BY = new Map(CONDITIONS.map((c) => [c.key, c]));
const ALLERGY_BY = new Map(ALLERGIES.map((a) => [a.key, a]));
const SITE_BY = new Map(SURGERY_SITES.map((s) => [s.key, s]));
const SENTINELS = new Set(['none', 'other']);

const asArray = (v) => (Array.isArray(v) ? v : []);
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const uniq = (arr) => Array.from(new Set(arr));
const text = (v) => String(v == null ? '' : v).trim();
const titleCase = (k) => String(k || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const pick = (item, lang) => (item ? (item[lang] || item.en) : '');
// Known keys in catalogue order, then anything unknown in the order stored —
// so two screens listing the same record list it the same way.
function catalogOrder(keys, catalog) {
  const set = new Set(keys);
  const known = catalog.map((x) => x.key).filter((k) => set.has(k));
  return [...known, ...keys.filter((k) => !known.includes(k))];
}

export function conditionLabel(key, lang = 'en') {
  return pick(COND_BY.get(key), lang) || titleCase(key);
}
export function allergyLabel(key, lang = 'en') {
  return pick(ALLERGY_BY.get(key), lang) || titleCase(key);
}
export function surgerySiteLabel(key, lang = 'en') {
  return pick(SITE_BY.get(key), lang) || titleCase(key);
}

/** True for a record answered on Dr. Trinh's form (explicit answers, not a checklist). */
export function isHistoryV2(mh) {
  const m = mh || {};
  return m.history_version === HISTORY_VERSION || Object.keys(asObject(m.condition_answers)).length > 0;
}

/**
 * Fill in the derived fields of a v2 medical history, returning a NEW object.
 *
 * Every key the caller passed survives — a legacy answer (`hospitalized`,
 * `pregnancy`) or a key this build does not know is carried, never dropped —
 * and only the derived ones are recomputed:
 *   allergies / allergies_none / allergies_other   from allergy_status
 *   conditions / conditions_none / conditions_other from condition_answers
 *   medications / medications_none                  from the rows
 *   surgery_sites                                   emptied unless major_surgery is yes
 * history_version is stamped only when the answers it promises are present, so
 * running this over an old checklist can never make it read as answered-No.
 */
export function normalizeMedical(input) {
  const m = { ...(input || {}) };

  if (ALLERGY_STATUSES.includes(m.allergy_status)) {
    if (m.allergy_status === 'yes') {
      m.allergies = uniq(asArray(m.allergies).filter((k) => typeof k === 'string' && k && k !== 'none'));
      m.allergies_other = m.allergies.includes('other') ? text(m.allergies_other) : '';
      delete m.allergies_none;
    } else if (m.allergy_status === 'nkda') {
      m.allergies = ['none'];
      m.allergies_other = '';
      m.allergies_none = true;
    } else {
      // Unsure is not "none": nothing is listed, and the flag says ask.
      m.allergies = [];
      m.allergies_other = '';
      delete m.allergies_none;
    }
  }

  const answers = asObject(m.condition_answers);
  if (Object.keys(answers).length) {
    m.condition_answers = { ...answers };
    const yes = catalogOrder(Object.keys(answers).filter((k) => answers[k] === 'yes'), CONDITIONS);
    const other = text(m.conditions_other);
    m.conditions_other = other;
    // "None" only when every condition asked was actually answered No (or Not
    // applicable) — an Unsure is not a None, and neither is a gap.
    const allNo = INTAKE_CONDITIONS.every((k) => answers[k] === 'no' || answers[k] === 'na');
    if (yes.length || other) m.conditions = [...yes, ...(other ? ['other'] : [])];
    else m.conditions = allNo ? ['none'] : [];
    if (m.conditions.length === 1 && m.conditions[0] === 'none') m.conditions_none = true;
    else delete m.conditions_none;
  }

  if (m.medications_none === true) {
    m.medications = [];
  } else {
    delete m.medications_none;
    const seen = new Set();
    m.medications = asArray(m.medications)
      .map((r) => (typeof r === 'string' ? { name: r } : r))
      .filter((r) => r && text(r.name))
      .map((r) => ({ ...r, key: r.key || 'other', name: text(r.name), dose: r.dose || '', reason: r.reason || '' }))
      .filter((r) => {
        // A checklist item ticked twice is one medication, not two.
        if (r.key === 'other') return true;
        if (seen.has(r.key)) return false;
        seen.add(r.key);
        return true;
      });
  }

  if (m.major_surgery !== undefined) {
    m.surgery_sites = m.major_surgery === 'yes' ? uniq(asArray(m.surgery_sites).filter((k) => typeof k === 'string' && k)) : [];
  }

  if (Object.keys(answers).length && ALLERGY_STATUSES.includes(m.allergy_status)) m.history_version = HISTORY_VERSION;
  return m;
}

/**
 * The first required answer a v2 history is missing, as a stable id, or null.
 * Ids, in the order the form asks them:
 *   under_treatment, condition:<key>, medications, major_surgery,
 *   surgery_sites, tobacco, allergy_status, allergies, allergies_other
 * The form turns the id into the question's own wording, so a refusal names
 * what it wants rather than "please complete this step".
 */
export function firstMissingMedical(mh) {
  const m = mh || {};
  const yn = (v) => v === 'yes' || v === 'no';
  if (!yn(m.under_treatment)) return 'under_treatment';
  const answers = asObject(m.condition_answers);
  for (const k of INTAKE_CONDITIONS) {
    if (!conditionAnswers(k).includes(answers[k])) return 'condition:' + k;
  }
  const meds = asArray(m.medications).filter((r) => r && text(typeof r === 'string' ? r : r.name));
  if (m.medications_none !== true && !meds.length) return 'medications';
  if (!yn(m.major_surgery)) return 'major_surgery';
  if (m.major_surgery === 'yes' && !asArray(m.surgery_sites).length) return 'surgery_sites';
  if (!yn(m.tobacco)) return 'tobacco';
  if (!ALLERGY_STATUSES.includes(m.allergy_status)) return 'allergy_status';
  if (m.allergy_status === 'yes') {
    const picked = asArray(m.allergies).filter((k) => k && k !== 'none');
    if (!picked.length) return 'allergies';
    if (picked.includes('other') && !text(m.allergies_other)) return 'allergies_other';
  }
  return null;
}

/**
 * Everything a screen or a printout shows about a medical history, resolved to
 * labels. Unknown keys get a fallback label and are never dropped.
 *
 *   version        2 or 1
 *   allergyStatus  'nkda' | 'yes' | 'unsure' | null (an older record: no gate)
 *   allergies      [{ key, label }] — ticked items plus any typed-in "Other"
 *   allergiesNone  reviewed and there are none (NKDA, or the old "None" chip)
 *   allergySummary one line for a clinician: never "None" for an Unsure
 *   yes / unsure   [{ key, label, flag }] conditions; typed-in text rides in yes
 *   conditionsNone reviewed and there are none
 *   meds           [{ key, name, dose, reason }]; medsNone
 *   surgery        'yes' | 'no' | '' and surgerySites [labels]
 *   smoke, underTreatment   'yes' | 'no' | ''
 *   pregnancy      the v2 pregnancy row's answer ('yes'|'no'|'unsure'|'na'|'')
 *   legacyRows     [{ key, label, value }] — only for answers this record HAS
 */
export function medicalDisplay(mh, lang = 'en') {
  const m = mh || {};
  const v2 = isHistoryV2(m);
  const answers = asObject(m.condition_answers);
  const cond = (key) => ({ key, label: conditionLabel(key, lang), flag: !!(COND_BY.get(key) && COND_BY.get(key).flag) });

  const yesKeys = catalogOrder(uniq([
    ...asArray(m.conditions).filter((k) => typeof k === 'string' && k && !SENTINELS.has(k)),
    ...Object.keys(answers).filter((k) => answers[k] === 'yes'),
  ]), CONDITIONS);
  const yes = yesKeys.map(cond);
  // Typed-in text shows whenever it exists, ticked or not — written-in
  // history must never be invisible because of a missing box.
  if (text(m.conditions_other)) yes.push({ key: 'other', label: text(m.conditions_other), flag: false });
  const unsure = catalogOrder(Object.keys(answers).filter((k) => answers[k] === 'unsure'), CONDITIONS).map(cond);
  const conditionsNone = !yes.length && !unsure.length && (m.conditions_none === true || asArray(m.conditions).includes('none'));

  const allergyStatus = ALLERGY_STATUSES.includes(m.allergy_status) ? m.allergy_status : null;
  const allergyKeys = catalogOrder(uniq(asArray(m.allergies).filter((k) => typeof k === 'string' && k && !SENTINELS.has(k))), ALLERGIES);
  const allergies = allergyKeys.map((key) => ({ key, label: allergyLabel(key, lang) }));
  if (text(m.allergies_other)) allergies.push({ key: 'other', label: text(m.allergies_other) });
  const allergiesNone = !allergies.length && (allergyStatus === 'nkda' || m.allergies_none === true || asArray(m.allergies).includes('none'));
  let allergySummary;
  if (allergies.length) allergySummary = allergies.map((a) => a.label).join(', ');
  else if (allergyStatus === 'unsure') allergySummary = 'Unsure — ask the patient';
  else if (allergyStatus === 'yes') allergySummary = 'Yes — none named';
  else if (allergyStatus === 'nkda') allergySummary = 'No known drug allergies (NKDA)';
  else allergySummary = allergiesNone ? 'None (reviewed)' : 'None reported';

  const meds = asArray(m.medications)
    .map((x) => (typeof x === 'string' ? { name: x } : x))
    .filter((x) => x && text(x.name))
    .map((x) => ({ key: x.key || '', name: text(x.name), dose: x.dose || '', reason: x.reason || '' }));
  const medsNone = !meds.length && m.medications_none === true;

  const legacyRows = [];
  if (m.hospitalized != null && m.hospitalized !== '') legacyRows.push({ key: 'hospitalized', label: 'Hospitalized (2 yrs)', value: m.hospitalized });
  if (m.pregnancy != null && m.pregnancy !== '') legacyRows.push({ key: 'pregnancy', label: 'Pregnant / nursing', value: m.pregnancy });

  return {
    version: v2 ? HISTORY_VERSION : 1,
    allergyStatus,
    allergies,
    allergiesNone,
    allergySummary,
    yes,
    unsure,
    conditionsNone,
    meds,
    medsNone,
    surgery: m.major_surgery === 'yes' || m.major_surgery === 'no' ? m.major_surgery : '',
    surgerySites: asArray(m.surgery_sites).map((k) => surgerySiteLabel(k, lang)),
    smoke: m.tobacco || '',
    underTreatment: m.under_treatment || '',
    pregnancy: answers.pregnant || '',
    legacyRows,
  };
}

/**
 * The red flags the dentist sees, as the label strings saved to triage.flags.
 *
 * - every flag:true condition the patient has (blood thinners excepted: it has
 *   its own banner), and "Unsure: <condition>" for one answered Unsure;
 * - "Pregnant" from the pregnancy row or an older record's pregnancy question,
 *   "Possibly pregnant" when the answer was Unsure;
 * - "Allergy: <name>" for every allergy, a typed-in one included (it was never
 *   flagged before, which is how "Sulfa" could be missed), and "Allergy status
 *   unsure" when the patient could not say.
 */
export function clinicalFlags(mh) {
  const m = mh || {};
  const answers = asObject(m.condition_answers);
  const has = new Set(asArray(m.conditions).filter((k) => typeof k === 'string' && !SENTINELS.has(k)));
  Object.keys(answers).forEach((k) => { if (answers[k] === 'yes') has.add(k); });
  const flags = [];
  for (const c of CONDITIONS) {
    if (!c.flag || c.key === 'blood_thinners' || c.key === 'pregnant') continue;
    if (has.has(c.key)) flags.push(c.en);
    else if (answers[c.key] === 'unsure') flags.push('Unsure: ' + c.en);
  }
  // An answer on the pregnancy row is the patient's word for THIS form and
  // wins; only a record without one falls back to the retired question.
  if (answers.pregnant) {
    if (answers.pregnant === 'yes') flags.push('Pregnant');
    else if (answers.pregnant === 'unsure') flags.push('Possibly pregnant');
  } else if (has.has('pregnant') || m.pregnancy === 'yes') flags.push('Pregnant');
  const allergyKeys = catalogOrder(uniq(asArray(m.allergies).filter((k) => typeof k === 'string' && k && !SENTINELS.has(k))), ALLERGIES);
  allergyKeys.forEach((k) => flags.push('Allergy: ' + allergyLabel(k, 'en')));
  if (text(m.allergies_other)) flags.push('Allergy: ' + text(m.allergies_other));
  if (m.allergy_status === 'unsure') flags.push('Allergy status unsure');
  return uniq(flags);
}

/**
 * The dental history for display.
 *   questions  Dr. Trinh's eight, always listed (an older record reads "—" on
 *              them: they were not asked, which is the truth)
 *   legacy     the questions asked before v0.0.15 — ONLY those this record has
 */
export function dentalDisplay(dh, lang = 'en') {
  const d = dh || {};
  const questions = DENTAL_QUESTIONS.map((q) => ({ key: q.key, label: pick(q, lang), short: q.short, value: d[q.key] || '' }));
  const legacy = DENTAL_LEGACY.filter((l) => d[l.key] != null && d[l.key] !== '').map((l) => ({ key: l.key, label: l.label, value: d[l.key] }));
  const visit = VISIT_TYPES.find((v) => v.key === d.visit_type);
  const prior = PRIOR_DENTIST.find((o) => o.key === d.prior_dentist);
  return {
    questions,
    legacy,
    need: visit ? pick(visit, lang) : '',
    priorDentist: prior ? pick(prior, lang) : (d.prior_dentist ? String(d.prior_dentist) : ''),
    reason: d.reason || '',
  };
}
