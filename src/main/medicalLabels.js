'use strict';

/**
 * The medical and dental history, for the main process.
 *
 * CommonJS mirror of src/renderer/js/medicalHistory.js and the catalogues in
 * src/renderer/i18n/strings.js, which are ES modules the main process cannot
 * import. pdf.js and clinicSheets.js print through this so the printed record,
 * the spreadsheet and the screens say the same thing about a patient.
 *
 * Duplicated, so pinned: the harness compares every label here with
 * strings.js, and runs medicalDisplay / dentalDisplay / clinicalFlags /
 * firstMissingMedical from BOTH modules over the same legacy and v0.0.15
 * records and fails on any difference. Change one, change the other.
 *
 * English only — everything that prints from here is read by clinic staff or a
 * funder. Map order is catalogue order, and it is the order things are listed.
 */

// Every condition key a record can hold: Dr. Trinh's 25, then the retired ones
// with their OLD wording so an older record still names what it recorded.
const CONDITION_LABELS = {
  high_bp: 'High Blood Pressure (Hypertension)',
  diabetes: 'Diabetes – Type 1 or Type 2',
  heart_disease: 'Heart Disease / Coronary Artery Disease',
  heart_attack: 'Heart Attack / Myocardial Infarction',
  stroke: 'Stroke / TIA',
  high_cholesterol: 'High Cholesterol',
  asthma: 'Asthma',
  copd: 'COPD / Emphysema / Chronic Lung Disease',
  kidney: 'Kidney Disease / Kidney Failure',
  liver: 'Liver Disease / Hepatitis',
  thyroid: 'Thyroid Disease',
  cancer: 'Cancer / History of Cancer',
  epilepsy: 'Seizures / Epilepsy',
  bleeding: 'Bleeding Disorder / Excessive Bleeding',
  blood_clot: 'Blood Clot / DVT / Pulmonary Embolism',
  anemia: 'Anemia / Blood Disorder',
  arthritis: 'Arthritis / Rheumatoid Arthritis',
  osteoporosis: 'Osteoporosis / Bone Disease',
  ulcers: 'GERD / Acid Reflux / Stomach Ulcers',
  mental_health: 'Depression / Anxiety / Other Mental Health Condition',
  sleep_apnea: 'Sleep Apnea',
  tuberculosis: 'Tuberculosis (TB) / History of TB',
  hiv: 'HIV/AIDS',
  autoimmune: 'Autoimmune / Immune System Disorder',
  pregnant: 'Pregnancy / Possible Pregnancy (when applicable)',
  heart_murmur: 'Heart murmur',
  pacemaker: 'Pacemaker',
  artificial_valve: 'Artificial heart valve',
  rheumatic_fever: 'Rheumatic fever',
  hepatitis: 'Hepatitis',
  blood_thinners: 'Takes blood thinners',
  glaucoma: 'Glaucoma',
  respiratory: 'Respiratory problems',
  latex: 'Latex allergy',
  anesthesia_reaction: 'Reaction to anesthesia',
  pain_mgmt: 'Pain management program',
  weight_mgmt: 'Weight management program',
};
// The conditions that raise a red flag for the dentist (`flag: true`).
const FLAG_CONDITIONS = ['high_bp', 'diabetes', 'heart_disease', 'heart_attack', 'stroke', 'liver', 'epilepsy',
  'bleeding', 'blood_clot', 'osteoporosis', 'tuberculosis', 'hiv', 'pregnant', 'heart_murmur', 'pacemaker',
  'artificial_valve', 'hepatitis', 'blood_thinners', 'latex', 'anesthesia_reaction'];
// The 25 asked at check-in, in the order they are asked.
const INTAKE_CONDITIONS = ['high_bp', 'diabetes', 'heart_disease', 'heart_attack', 'stroke', 'high_cholesterol',
  'asthma', 'copd', 'kidney', 'liver', 'thyroid', 'cancer', 'epilepsy', 'bleeding', 'blood_clot', 'anemia',
  'arthritis', 'osteoporosis', 'ulcers', 'mental_health', 'sleep_apnea', 'tuberculosis', 'hiv', 'autoimmune',
  'pregnant'];

const ALLERGY_LABELS = {
  penicillin: 'Penicillin',
  amoxicillin: 'Amoxicillin',
  ampicillin: 'Ampicillin',
  cephalosporins: 'Cephalosporins',
  sulfa: 'Sulfa antibiotics',
  azithromycin: 'Azithromycin / Erythromycin / Clarithromycin',
  clindamycin: 'Clindamycin',
  metronidazole: 'Metronidazole',
  doxycycline: 'Doxycycline / tetracyclines',
  fluoroquinolones: 'Ciprofloxacin / Levofloxacin',
  aspirin: 'Aspirin',
  ibuprofen_nsaids: 'Ibuprofen / Naproxen / NSAIDs',
  tylenol: 'Acetaminophen / Tylenol',
  codeine: 'Codeine',
  hydrocodone: 'Hydrocodone',
  oxycodone: 'Oxycodone',
  morphine: 'Morphine',
  lidocaine: 'Lidocaine / local anesthetic',
  general_anesthetic: 'General anesthetic',
  anticonvulsant: 'Anticonvulsant',
  bp_medication: 'Blood pressure medication',
  diuretic: 'Diuretic',
  diabetes_medication: 'Insulin / diabetes medication',
  steroid: 'Steroid / corticosteroid',
  articaine: 'Articaine',
  mepivacaine: 'Mepivacaine',
  bupivacaine: 'Bupivacaine',
  prilocaine: 'Prilocaine',
  amoxicillin_clavulanate: 'Amoxicillin + clavulanate',
  erythromycin: 'Erythromycin',
  nsaids: 'NSAIDs (Ibuprofen, Aspirin)',
  novocain: 'Novocain',
};

// Canonical names — what the checklist STORES as medications[].name.
const MED_CHECKLIST_LABELS = {
  atorvastatin: 'Atorvastatin (Lipitor)',
  amlodipine: 'Amlodipine (Norvasc)',
  lisinopril: 'Lisinopril (Zestril/Prinivil)',
  losartan: 'Losartan (Cozaar)',
  metformin: 'Metformin (Glucophage)',
  levothyroxine: 'Levothyroxine (Synthroid)',
  omeprazole: 'Omeprazole (Prilosec)',
  gabapentin: 'Gabapentin (Neurontin)',
  hydrochlorothiazide: 'Hydrochlorothiazide (HCTZ)',
  metoprolol: 'Metoprolol',
  rosuvastatin: 'Rosuvastatin (Crestor)',
  aspirin: 'Aspirin',
  ibuprofen: 'Ibuprofen (Advil/Motrin)',
  acetaminophen: 'Acetaminophen (Tylenol)',
  albuterol: 'Albuterol (Ventolin/ProAir)',
  insulin: 'Insulin',
  glipizide: 'Glipizide',
  furosemide: 'Furosemide (Lasix)',
  pantoprazole: 'Pantoprazole (Protonix)',
  sertraline: 'Sertraline (Zoloft)',
  escitalopram: 'Escitalopram (Lexapro)',
  prednisone: 'Prednisone',
  warfarin: 'Warfarin (Coumadin)',
  apixaban: 'Apixaban (Eliquis)',
  clopidogrel: 'Clopidogrel (Plavix)',
};

const SURGERY_SITE_LABELS = {
  knee: 'Knee',
  elbow: 'Elbow',
  hip: 'Hip',
  neck: 'Neck',
  heart: 'Heart',
  leg: 'Leg',
  arm: 'Arm',
  lung: 'Lung',
  kidney: 'Kidney',
  liver: 'Liver',
};

// Step 3's eight questions, by their short chart label (DENTAL_QUESTIONS.short).
const DENTAL_Q_LABELS = {
  pain_cold: 'Pain with cold water',
  pain_hot: 'Pain with hot water',
  pain_eating: 'Pain when eating',
  toothache_night: 'Toothache wakes them at night',
  pain_touch: 'Pain on touch',
  grinding_night: 'Clenches / grinds at night',
  jaw_pain_waking: 'Wakes with jaw pain',
  sores: 'Lump or sores in mouth',
};
// Asked before v0.0.15; printed only for a record that has them.
const DENTAL_LEGACY_LABELS = {
  gum_bleeding: 'Gums bleed',
  jaw_injury: 'Head/neck/jaw injury',
  grinding: 'Clenching / grinding',
  post_extraction_bleeding: 'Bleeding after extraction',
  ortho: 'Orthodontic history',
};

const ANSWER_LABELS = { yes: 'Yes', no: 'No', unsure: 'Unsure', na: 'Not applicable' };
const ALLERGY_STATUS_LABELS = { nkda: 'No known drug allergies (NKDA)', yes: 'Yes', unsure: 'Unsure' };

const HISTORY_VERSION = 2;
const ALLERGY_STATUSES = ['nkda', 'yes', 'unsure'];
const SENTINELS = new Set(['none', 'other']);
const CONDITION_ORDER = Object.keys(CONDITION_LABELS);
const ALLERGY_ORDER = Object.keys(ALLERGY_LABELS);

const asArray = (v) => (Array.isArray(v) ? v : []);
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const uniq = (arr) => Array.from(new Set(arr));
const text = (v) => String(v == null ? '' : v).trim();
const titleCase = (k) => String(k || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function catalogOrder(keys, order) {
  const set = new Set(keys);
  const known = order.filter((k) => set.has(k));
  return [...known, ...keys.filter((k) => !known.includes(k))];
}
function conditionAnswers(key) {
  return key === 'pregnant' ? ['yes', 'no', 'unsure', 'na'] : ['yes', 'no', 'unsure'];
}

const conditionLabel = (key) => CONDITION_LABELS[key] || titleCase(key);
const allergyLabel = (key) => ALLERGY_LABELS[key] || titleCase(key);
const surgerySiteLabel = (key) => SURGERY_SITE_LABELS[key] || titleCase(key);
// A stored answer in words. Anything unrecognised passes through as given
// rather than being blanked — it is what the record says.
const answerLabel = (v) => (ANSWER_LABELS[v] || (v == null ? '' : String(v)));

function isHistoryV2(mh) {
  const m = mh || {};
  return m.history_version === HISTORY_VERSION || Object.keys(asObject(m.condition_answers)).length > 0;
}

// Mirrors medicalHistory.js firstMissingMedical, for a main-process check of a
// history arriving from an editor. (createPatient does not enforce it: a record
// may legitimately be created with an empty history — a desk walk-in, a test.)
function firstMissingMedical(mh) {
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

// Mirrors medicalHistory.js medicalDisplay(mh, 'en').
function medicalDisplay(mh) {
  const m = mh || {};
  const v2 = isHistoryV2(m);
  const answers = asObject(m.condition_answers);
  const cond = (key) => ({ key, label: conditionLabel(key), flag: FLAG_CONDITIONS.includes(key) });

  const yesKeys = catalogOrder(uniq([
    ...asArray(m.conditions).filter((k) => typeof k === 'string' && k && !SENTINELS.has(k)),
    ...Object.keys(answers).filter((k) => answers[k] === 'yes'),
  ]), CONDITION_ORDER);
  const yes = yesKeys.map(cond);
  if (text(m.conditions_other)) yes.push({ key: 'other', label: text(m.conditions_other), flag: false });
  const unsure = catalogOrder(Object.keys(answers).filter((k) => answers[k] === 'unsure'), CONDITION_ORDER).map(cond);
  const conditionsNone = !yes.length && !unsure.length && (m.conditions_none === true || asArray(m.conditions).includes('none'));

  const allergyStatus = ALLERGY_STATUSES.includes(m.allergy_status) ? m.allergy_status : null;
  const allergyKeys = catalogOrder(uniq(asArray(m.allergies).filter((k) => typeof k === 'string' && k && !SENTINELS.has(k))), ALLERGY_ORDER);
  const allergies = allergyKeys.map((key) => ({ key, label: allergyLabel(key) }));
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
    surgerySites: asArray(m.surgery_sites).map(surgerySiteLabel),
    smoke: m.tobacco || '',
    underTreatment: m.under_treatment || '',
    pregnancy: answers.pregnant || '',
    legacyRows,
  };
}

// Mirrors medicalHistory.js clinicalFlags — the label strings triage.flags holds.
function clinicalFlags(mh) {
  const m = mh || {};
  const answers = asObject(m.condition_answers);
  const has = new Set(asArray(m.conditions).filter((k) => typeof k === 'string' && !SENTINELS.has(k)));
  Object.keys(answers).forEach((k) => { if (answers[k] === 'yes') has.add(k); });
  const flags = [];
  for (const key of CONDITION_ORDER) {
    if (!FLAG_CONDITIONS.includes(key) || key === 'blood_thinners' || key === 'pregnant') continue;
    if (has.has(key)) flags.push(CONDITION_LABELS[key]);
    else if (answers[key] === 'unsure') flags.push('Unsure: ' + CONDITION_LABELS[key]);
  }
  // An answer on the pregnancy row is the patient's word for THIS form and
  // wins; only a record without one falls back to the retired question.
  if (answers.pregnant) {
    if (answers.pregnant === 'yes') flags.push('Pregnant');
    else if (answers.pregnant === 'unsure') flags.push('Possibly pregnant');
  } else if (has.has('pregnant') || m.pregnancy === 'yes') flags.push('Pregnant');
  const allergyKeys = catalogOrder(uniq(asArray(m.allergies).filter((k) => typeof k === 'string' && k && !SENTINELS.has(k))), ALLERGY_ORDER);
  allergyKeys.forEach((k) => flags.push('Allergy: ' + allergyLabel(k)));
  if (text(m.allergies_other)) flags.push('Allergy: ' + text(m.allergies_other));
  if (m.allergy_status === 'unsure') flags.push('Allergy status unsure');
  return uniq(flags);
}

// Mirrors the questions / legacy / symptoms parts of medicalHistory.js
// dentalDisplay, by the short chart labels.
function dentalDisplay(dh) {
  const d = dh || {};
  const questions = Object.keys(DENTAL_Q_LABELS).map((key) => ({ key, short: DENTAL_Q_LABELS[key], value: d[key] || '' }));
  const legacy = Object.keys(DENTAL_LEGACY_LABELS).filter((k) => d[k] != null && d[k] !== '')
    .map((key) => ({ key, label: DENTAL_LEGACY_LABELS[key], value: d[key] }));
  return { questions, legacy, symptoms: questions.filter((q) => q.value === 'yes').map((q) => q.short) };
}

module.exports = {
  CONDITION_LABELS, FLAG_CONDITIONS, INTAKE_CONDITIONS, ALLERGY_LABELS, MED_CHECKLIST_LABELS,
  SURGERY_SITE_LABELS, DENTAL_Q_LABELS, DENTAL_LEGACY_LABELS, ANSWER_LABELS, ALLERGY_STATUS_LABELS,
  HISTORY_VERSION,
  conditionLabel, allergyLabel, surgerySiteLabel, answerLabel, isHistoryV2,
  firstMissingMedical, medicalDisplay, clinicalFlags, dentalDisplay,
};
