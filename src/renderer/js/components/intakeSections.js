// The three halves of the intake a patient answers about themselves — who they
// are, their medical history, their dental history — each built ONCE, here.
//
// The kiosk steps are thin wrappers around these, and any screen that lets
// staff correct an answer later mounts the very same builder, so a question
// cannot be worded one way at check-in and another at the chair, or be required
// in one place and optional in the other.
//
// Every builder returns { node, collect(), isDirty() }:
//   collect()  validates exactly as check-in does — a refusal is a toast that
//              NAMES the question it wants — and returns a NEW object, the
//              caller's record with the answers merged over it, so a key this
//              form does not ask (an older record's answer, a newer build's
//              field) survives the save. Returns false when refused.
//   isDirty()  whether anything on screen differs from what it was built with.
//
// `staff: true` is for a screen run by clinic staff rather than the patient;
// the questions and the rules are the same either way.

import { el, clear, toast } from '../dom.js';
import { icon } from '../icons.js';
import {
  t, getLang, conditions, allergies, conditionLabel, allergyLabel, medChecklist, surgerySites, dentalQuestions, answerLabel,
  visitTypes, priorDentistOptions, referrals, raceOptions, US_STATES, MEDICATIONS,
} from '../i18n.js';
import { textField, selectField, chipGrid, limitDigits } from '../forms.js';
import { normalizeMedical, firstMissingMedical, conditionAnswers, INTAKE_CONDITIONS, INTAKE_ALLERGIES } from '../medicalHistory.js';

// Localised string helper: pick the current language, fall back to English.
const L = (map) => map[getLang()] || map.en;
const req = () => t('common.required') + ': ';
const dash = { value: '', label: '—' };
const answerOpts = (values) => [dash, ...values.map((v) => ({ value: v, label: answerLabel(v) }))];
const text = (v) => String(v == null ? '' : v).trim();
// Datalist ids must be unique in the document, and two of these forms can be
// open at once (a desk editing one patient while the chart shows another).
let instanceSeq = 0;

function showWhen(node, on) { node.style.display = on ? '' : 'none'; }

// A stored answer the dropdown does not offer — typed before the question was a
// dropdown ("Facebook group", "Dr. Prior"), or a key from a newer build's list —
// becomes an option of its own, labelled as recorded and selected. forms.js
// selectField otherwise lands on "—" for a value it does not know, and the next
// save quietly erases an optional answer, or demands a required one again
// without ever showing what the record said. Leaving it keeps it exactly as
// stored; choosing a listed answer replaces it, knowingly.
function withRecorded(options, stored) {
  const value = stored == null ? '' : String(stored);
  if (!value.trim() || options.some((o) => o.value === value)) return { options, value };
  const note = L({ en: '(as recorded)', es: '(según el registro)' });
  return { options: [...options, { value, label: `${value.trim()} ${note}` }], value };
}
function recordedSelect(label, options, stored, { required = false } = {}) {
  const r = withRecorded(options, stored);
  return selectField(label, r.options, { value: r.value, required });
}

/* ------------------------------------------------------------------ */
/*  City                                                               */
/* ------------------------------------------------------------------ */

// One town name as every copy stores it — the admin's list (db.js
// sanitizeCities), the Worker's, and a name typed at either form: runs of
// spaces made one, trimmed, at most 80 characters.
export function cleanCityName(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 80);
}

// The cities an event offers at check-in (events.cities: a JSON array of names
// as the admin typed them). Tolerates the column arriving as a JSON string, an
// array, or — from a hand-edited backup — one name per line. Empty means no
// list, which keeps the plain text box.
export function eventCities(ev) {
  const raw = ev && ev.cities;
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { const parsed = JSON.parse(raw); list = Array.isArray(parsed) ? parsed : []; }
    catch (_) { list = raw.split(/\r?\n/); }
  }
  const seen = new Set();
  const out = [];
  // Cleaned exactly as db.js sanitizeCities and the Worker clean it, so the
  // kiosk and the online form can never offer two spellings of one list.
  for (const c of list) {
    const name = cleanCityName(c);
    const fold = name.toLowerCase();
    if (!name || fold === 'other' || seen.has(fold)) continue;
    seen.add(fold);
    out.push(name);
    if (out.length >= 100) break;
  }
  return out;
}

// The listed spelling of a typed city, matched ignoring case and spacing, or
// null. "sandy" and "Sandy " are the same place as "Sandy"; storing the listed
// spelling is what keeps them one bucket in the by-city report.
export function matchCity(value, cities) {
  const fold = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!fold) return null;
  return (cities || []).find((c) => c.toLowerCase() === fold) || null;
}

/* ------------------------------------------------------------------ */
/*  About you                                                          */
/* ------------------------------------------------------------------ */

// Records taken before the dropdown hold free text — "Oregon", "or", "Ore.".
// Match them to a code where it is unambiguous so opening an old record does
// not silently blank the field; anything unrecognised falls back to no
// selection rather than a wrong one.
export function normalizeState(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  const up = raw.toUpperCase().replace(/\.$/, '');
  if (US_STATES.some(([c]) => c === up)) return up;
  const byName = US_STATES.find(([, n]) => n.toUpperCase() === up);
  return byName ? byName[0] : '';
}

/**
 * Demographics. `initial` is patient-shaped: { first_name, last_name, dob,
 * gender, phone, email, demographics: {...} }. `cities` is the event's list;
 * empty keeps City a text box, exactly as before any list was configured.
 */
export function demographicsSection(initial = {}, { staff = false, cities = [] } = {}) {
  void staff;
  const base = initial || {};
  const d = base.demographics || {};
  const first = textField(t('intake.firstName'), { value: base.first_name, required: true });
  const last = textField(t('intake.lastName'), { value: base.last_name, required: true });
  const dob = textField(t('intake.dob'), { value: base.dob, type: 'date', required: true });
  const gender = recordedSelect(t('intake.gender'), [
    dash,
    { value: 'male', label: t('intake.genderM') },
    { value: 'female', label: t('intake.genderF') },
    { value: 'other', label: t('intake.genderO') },
  ], base.gender, { required: true });
  const phone = textField(t('intake.phone'), { value: base.phone, type: 'tel', required: true });
  const email = textField(t('intake.email'), { value: base.email, type: 'email' });
  const address = textField(t('intake.address'), { value: d.address });

  // City. Required: grant-funded clinics report how many patients came from
  // their town. With a list, a dropdown of the event's towns plus "Other" and a
  // typed name — the State problem again ("Sandy", "sandy", "Sandy OR" were
  // three places in the report). A stored value that is not on the list is
  // shown as Other with its text, never silently blanked: a select given an
  // unknown value quietly selects its first option and the next save wipes it.
  // A typed name is cleaned the way the online form and the admin's list clean
  // one (cleanCityName), so the same town typed at either form is one report row.
  const cityList = eventCities({ cities });
  let city; let cityOther = null; let cityOtherWrap = null; let getCity;
  if (!cityList.length) {
    city = textField(t('intake.city'), { value: d.city, required: true });
    city.input.maxLength = 80;
    getCity = () => cleanCityName(city.get());
  } else {
    const listed = matchCity(d.city, cityList);
    city = selectField(t('intake.city'), [
      dash, ...cityList.map((c) => ({ value: c, label: c })), { value: 'other', label: t('intake.otherCity') },
    ], { value: listed || (text(d.city) ? 'other' : ''), required: true });
    cityOther = textField(t('intake.cityOther'), { value: listed ? '' : text(d.city), required: true });
    cityOther.input.maxLength = 80;
    cityOtherWrap = el('div', { class: 'span-2' }, [cityOther.node]);
    const sync = () => showWhen(cityOtherWrap, city.get() === 'other');
    city.input.addEventListener('change', sync);
    sync();
    // A typed name that is really a listed town is stored in the listed
    // spelling, so "Other: sandy" still counts toward Sandy.
    getCity = () => (city.get() === 'other' ? (matchCity(cityOther.get(), cityList) || cleanCityName(cityOther.get())) : city.get());
  }

  // A dropdown, not a text box: "OR", "Oregon" and "ore" were landing in the
  // city/state report as three different places. An old answer that cannot be
  // matched to a state unambiguously is shown as recorded rather than hidden.
  const stateF = recordedSelect(
    t('intake.state'),
    [dash, ...US_STATES.map(([code, name]) => ({ value: code, label: `${name} (${code})` }))],
    normalizeState(d.state) || d.state, { required: true },
  );
  const mailing = textField(t('intake.mailing'), { value: d.mailing_address });
  const marital = recordedSelect(t('intake.marital'), [
    dash,
    { value: 'single', label: t('intake.single') },
    { value: 'married', label: t('intake.married') },
    { value: 'divorced', label: t('intake.divorced') },
    { value: 'widowed', label: t('intake.widowed') },
  ], d.marital_status);
  const emName = textField(t('intake.emergencyName'), { value: d.emergency_name, required: true });
  const emPhone = textField(t('intake.emergencyPhone'), { value: d.emergency_phone, type: 'tel', required: true });
  // Phone numbers accept digits only, max 10.
  limitDigits(phone.input, 10);
  limitDigits(emPhone.input, 10);

  // MMW runs dental, medical and vision under one roof, and the registration
  // form asks which the patient is here for. It drives who they queue for, so
  // at least one has to be chosen — a blank would strand them in no queue.
  const SERVICES = [
    { key: 'dental', label: L({ en: 'Dental', es: 'Dental', ru: 'Стоматология' }) },
    { key: 'medical', label: L({ en: 'Medical', es: 'Médico', ru: 'Медицина' }) },
    { key: 'vision', label: L({ en: 'Vision', es: 'Visión', ru: 'Зрение' }) },
  ];
  const chosenServices = new Set(Array.isArray(d.services) && d.services.length ? d.services : ['dental']);
  const serviceBtns = SERVICES.map((svc) => {
    const btn = el('button', {
      type: 'button',
      class: 'chip-btn' + (chosenServices.has(svc.key) ? ' chip-btn--on' : ''),
      onClick: () => {
        if (chosenServices.has(svc.key)) chosenServices.delete(svc.key); else chosenServices.add(svc.key);
        btn.classList.toggle('chip-btn--on', chosenServices.has(svc.key));
        btn.setAttribute('aria-pressed', String(chosenServices.has(svc.key)));
      },
      'aria-pressed': String(chosenServices.has(svc.key)),
    }, [svc.label]);
    return btn;
  });
  const servicesField = el('div', { class: 'span-2' }, [
    el('span', { class: 'field-label' }, [L({ en: 'Services needed today', es: 'Servicios que necesita hoy', ru: 'Необходимые услуги' })]),
    el('div', { class: 'chip-row' }, serviceBtns),
  ]);

  // F4: referral as a dropdown of known sources; "Other" reveals a free-text field.
  // The online form stored this question's answer as prose until v0.0.13, so
  // an older record's "Facebook group" is kept on screen as recorded.
  const referral = recordedSelect(t('intake.referral'), [
    dash,
    ...referrals().map((r) => ({ value: r.key, label: r.label })),
  ], d.referral);
  // Race and ethnicity as ONE optional select-all question. Optional on
  // purpose and labelled as such: it is asked for grant reporting, and a
  // patient who does not want to answer must still get care.
  const RACE_OPTS = raceOptions();
  const race = chipGrid(
    L({ en: 'Race and ethnicity', es: 'Raza y origen étnico', ru: 'Раса и этническая принадлежность' }),
    RACE_OPTS.map((o) => ({ key: o.key, label: o.label })),
    {
      selected: Array.isArray(d.race) ? d.race : [],
      hint: L({
        en: 'Optional. Choose any that apply — this is only used for reporting how the clinic served the community.',
        es: 'Opcional. Elija todas las que correspondan — solo se usa para informar cómo la clínica sirvió a la comunidad.',
        ru: 'Необязательно. Выберите все подходящие — используется только для отчётности.',
      }),
    },
  );
  const raceField = el('div', { class: 'span-2' }, [race.node]);
  // Make the exclusivity visible rather than reconciling it silently on save:
  // a patient could light up "White" AND "Prefer not to answer" and only one of
  // them survives, with no indication which.
  race.node.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.chip-select');
    if (!btn) return;
    const chosen = race.get();
    const isPna = btn.dataset.key === 'prefer_not';
    if (isPna && chosen.includes('prefer_not')) race.set(['prefer_not']);
    else if (!isPna && chosen.includes('prefer_not')) race.set(chosen.filter((k) => k !== 'prefer_not'));
  });

  const referralOther = textField(t('intake.referralOther'), { value: d.referral_other });
  const referralOtherWrap = el('div', { class: 'span-2' }, [referralOther.node]);
  const syncReferralOther = () => showWhen(referralOtherWrap, referral.get() === 'other');
  referral.input.addEventListener('change', syncReferralOther);
  syncReferralOther();

  // First and last name stay the first two text inputs of the step.
  const node = el('div', { class: 'form-grid' }, [
    first.node, last.node, dob.node, gender.node, phone.node, email.node,
    el('div', { class: 'span-2' }, [address.node]),
    city.node, stateF.node,
    cityOtherWrap,
    el('div', { class: 'span-2' }, [mailing.node]),
    marital.node, emName.node, emPhone.node,
    raceField,
    servicesField,
    el('div', { class: 'span-2' }, [referral.node]),
    referralOtherWrap,
  ]);

  const peek = () => ({
    ...base,
    first_name: first.get(), last_name: last.get(), dob: dob.get(), gender: gender.get(),
    phone: phone.get(), email: email.get(),
    demographics: {
      ...d,
      address: address.get(), city: getCity(), state: stateF.get(), mailing_address: mailing.get(), marital_status: marital.get(),
      emergency_name: emName.get(), emergency_phone: emPhone.get(),
      services: SERVICES.map((x) => x.key).filter((k) => chosenServices.has(k)),
      // "Prefer not to answer" is about the list, so it replaces it rather
      // than joining it — a record must not say both "white" and "declined".
      race: race.get().includes('prefer_not') ? ['prefer_not'] : race.get(),
      referral: referral.get(),
      referral_other: referral.get() === 'other' ? referralOther.get() : '',
    },
  });
  const baseline = JSON.stringify(peek());

  return {
    node,
    isDirty: () => JSON.stringify(peek()) !== baseline,
    collect: () => {
      const out = peek();
      const dm = out.demographics;
      if (!out.first_name || !out.last_name) { toast(req() + t('intake.firstName') + ' / ' + t('intake.lastName'), 'error'); return false; }
      if (!out.dob) { toast(req() + t('intake.dob'), 'error'); return false; }
      if (!out.gender) { toast(req() + t('intake.gender'), 'error'); return false; }
      if (cityOther && city.get() === 'other' && !cityOther.get()) { toast(req() + t('intake.cityOther'), 'error'); return false; }
      if (!dm.city) { toast(req() + t('intake.city'), 'error'); return false; }
      if (!dm.state) { toast(req() + t('intake.state'), 'error'); return false; }
      if (!out.phone) { toast(req() + t('intake.phone'), 'error'); return false; }
      if (!dm.emergency_name) { toast(req() + t('intake.emergencyName'), 'error'); return false; }
      if (!dm.emergency_phone) { toast(req() + t('intake.emergencyPhone'), 'error'); return false; }
      if (!dm.services.length) { toast(L({ en: 'Please choose at least one service.', es: 'Elija al menos un servicio.', ru: 'Выберите хотя бы одну услугу.' }), 'error'); return false; }
      return out;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Medical history                                                    */
/* ------------------------------------------------------------------ */

// A "none of these" chip is an answer ABOUT the list, so it replaces it:
// choosing it clears the real chips, and picking any real chip clears it.
function wireExclusive(grid, noneKey, after) {
  grid.node.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.chip-select');
    if (!btn) return;
    const cur = grid.get();
    if (btn.dataset.key === noneKey) {
      if (cur.includes(noneKey)) grid.set([noneKey]);
    } else if (cur.includes(noneKey)) {
      grid.set(cur.filter((k) => k !== noneKey));
    }
    if (after) after();
  });
}

/**
 * Dr. Trinh's medical history (history_version 2). `initial` is the stored
 * medical_history; an older checklist-shaped record opens with what it can
 * truthfully pre-fill (a ticked condition is a Yes; an unticked one is left
 * unanswered, never assumed No) and with any retired item it recorded kept on
 * screen, selected, so saving cannot quietly drop it.
 */
export function medicalHistorySection(initial = {}, { staff = false } = {}) {
  void staff;
  const m = initial || {};
  const seq = ++instanceSeq;
  const v2 = m.condition_answers && typeof m.condition_answers === 'object';
  const legacyConds = Array.isArray(m.conditions) ? m.conditions.filter((k) => k && k !== 'none' && k !== 'other') : [];
  const legacyAllergies = Array.isArray(m.allergies) ? m.allergies.filter((k) => k && k !== 'none' && k !== 'other') : [];
  const ynOpts = answerOpts(['yes', 'no']);

  // --- Under a doctor's care (MMW's own question; his form does not ask it) ---
  const underTx = selectField(t('intake.underTreatment'), ynOpts, { value: m.under_treatment || '', required: true });

  // --- The 25 conditions, one dropdown each ---
  const CONDS = conditions();
  const condByKey = new Map(CONDS.map((c) => [c.key, c]));
  const startAnswer = (k) => {
    if (v2) return m.condition_answers[k] || '';
    return legacyConds.includes(k) ? 'yes' : '';
  };
  // Retired or unknown conditions this record holds get a row of their own
  // below the 25, pre-set to Yes, so the history they record is still in front
  // of whoever is editing it.
  const extraCondKeys = [
    ...legacyConds,
    ...(v2 ? Object.keys(m.condition_answers).filter((k) => m.condition_answers[k] === 'yes') : []),
  ].filter((k, i, a) => a.indexOf(k) === i && !INTAKE_CONDITIONS.includes(k));
  const condRows = [...INTAKE_CONDITIONS, ...extraCondKeys].map((key) => {
    const c = condByKey.get(key);
    const label = conditionLabel(key);
    const retired = !INTAKE_CONDITIONS.includes(key);
    const sel = el('select', { class: 'input select' });
    const values = retired ? ['yes', 'no'] : conditionAnswers(key);
    answerOpts(values).forEach((o) => {
      const opt = el('option', { value: o.value }, [o.label]);
      if (o.value === startAnswer(key) || (retired && o.value === 'yes')) opt.selected = true;
      sel.append(opt);
    });
    const node = el('label', { class: 'tri-row' + (c && c.flag ? ' tri-row--flag' : ''), dataset: { key } }, [
      el('span', { class: 'tri-label' }, [label, retired ? el('span', { class: 'subtle small' }, [' ' + L({ en: '(earlier form)', es: '(formulario anterior)' })]) : null]),
      sel,
    ]);
    return { key, label, node, get: () => sel.value };
  });
  const condOther = textField(t('intake.conditionOther'), { value: m.conditions_other });
  const condField = el('div', { class: 'field intake-block' }, [
    el('span', { class: 'field-label' }, [t('intake.conditionsTitle'), el('em', { class: 'req' }, [' *'])]),
    el('span', { class: 'field-hint' }, [t('intake.conditionsHint')]),
    el('div', { class: 'tri-grid' }, condRows.map((r) => r.node)),
    condOther.node,
  ]);

  // --- Medications: his checklist, "Other" (typed), or "No medications" ---
  const CHECK = medChecklist();
  const checkKeys = new Set(CHECK.map((x) => x.key));
  const startMeds = Array.isArray(m.medications) ? m.medications.map((r) => (typeof r === 'string' ? { name: r } : r)).filter((r) => r && text(r.name)) : [];
  // What a checklist row carried before (an older dose or reason) rides along
  // unseen rather than being wiped by re-saving.
  const priorByKey = new Map(startMeds.filter((r) => checkKeys.has(r.key)).map((r) => [r.key, r]));
  const startOthers = startMeds.filter((r) => !checkKeys.has(r.key));
  const medSelected = [...priorByKey.keys()];
  if (startOthers.length) medSelected.push('other');
  if (m.medications_none === true && !startMeds.length) medSelected.push('none');
  const medGrid = chipGrid(t('intake.medsTitle') + ' *', [
    ...CHECK.map((x) => ({ key: x.key, label: x.label })),
    { key: 'other', label: t('common.other') },
    { key: 'none', label: t('intake.noMeds') },
  ], { selected: medSelected, hint: t('intake.medsHint') });
  // One shared <datalist> for the typed rows: the 100 medications MMW listed,
  // commonest first. A datalist rather than a <select>, deliberately — it
  // suggests, but a patient on a drug outside the hundred must still be
  // recordable, because the provider reads this before deciding what is safe.
  const listId = `mmw-med-list-${seq}`;
  const medDatalist = el('datalist', { id: listId }, MEDICATIONS.map((x) => el('option', { value: x.name })));
  const medRows = el('div', { class: 'med-rows' });
  function addMedRow(med = {}) {
    const name = el('input', { class: 'input', placeholder: t('intake.medName'), value: med.name || '', list: listId, autocomplete: 'off' });
    const row = el('div', { class: 'med-row med-row--name' }, [name,
      el('button', { class: 'btn btn--ghost btn--sm btn--icon', type: 'button', onClick: () => row.remove() }, [icon('x', { size: 15 })])]);
    // A key this build does not know (a newer list's) is kept, not turned into 'other'.
    row._get = () => ({ ...med, key: med.key && !checkKeys.has(med.key) ? med.key : 'other', name: name.value.trim(), dose: med.dose || '', reason: med.reason || '' });
    medRows.append(row);
    return name;
  }
  startOthers.forEach((r) => addMedRow(r));
  const addBtn = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => { const inp = addMedRow(); inp.focus(); } }, ['+ ' + t('intake.addMed')]);
  const medOtherWrap = el('div', { class: 'field' }, [
    el('span', { class: 'field-label' }, [t('intake.medOther')]), medDatalist, medRows, addBtn,
  ]);
  const syncMedOther = () => {
    const on = medGrid.get().includes('other');
    if (on && !medRows.children.length) addMedRow();
    showWhen(medOtherWrap, on);
  };
  wireExclusive(medGrid, 'none', syncMedOther);
  syncMedOther();
  const medField = el('div', { class: 'intake-block' }, [medGrid.node, medOtherWrap]);

  // --- Major surgery in the past six months, and where ---
  const surgery = selectField(t('intake.majorSurgery'), ynOpts, { value: m.major_surgery || '', required: true });
  const siteGrid = chipGrid(t('intake.surgerySites') + ' *', surgerySites(), { selected: Array.isArray(m.surgery_sites) ? m.surgery_sites : [] });
  const siteWrap = el('div', { class: 'span-2' }, [siteGrid.node]);
  const syncSites = () => showWhen(siteWrap, surgery.get() === 'yes');
  surgery.input.addEventListener('change', syncSites);
  syncSites();

  // --- Do you smoke? (stored under the old `tobacco` key; shown to staff as
  // "Smokes / tobacco" so an older record's chewing-tobacco Yes stays true) ---
  const smoke = selectField(t('intake.tobacco'), ynOpts, { value: m.tobacco || '', required: true });

  // --- Medication allergies: NKDA / Yes / Unsure, the checklist only on Yes ---
  const startStatus = m.allergy_status || (legacyAllergies.length || text(m.allergies_other) ? 'yes' : '');
  const gate = selectField(t('intake.allergyQuestion'), [
    dash,
    { value: 'nkda', label: t('intake.nkda') },
    { value: 'yes', label: t('common.yes') },
    { value: 'unsure', label: t('intake.unsure') },
  ], { value: startStatus, required: true });
  const ALL = allergies();
  const extraAllergies = legacyAllergies.filter((k, i, a) => a.indexOf(k) === i && !INTAKE_ALLERGIES.includes(k));
  const allergyItems = [
    ...ALL.filter((a) => a.intake).map((a) => ({ key: a.key, label: a.label, flag: true })),
    ...extraAllergies.map((k) => ({ key: k, label: allergyLabel(k) + ' ' + L({ en: '(earlier form)', es: '(formulario anterior)' }), flag: true })),
    { key: 'other', label: t('common.other'), flag: true },
  ];
  const startAllergies = [...legacyAllergies];
  if ((Array.isArray(m.allergies) && m.allergies.includes('other')) || text(m.allergies_other)) startAllergies.push('other');
  const allergyGrid = chipGrid(t('intake.allergiesTitle') + ' *', allergyItems, { selected: startAllergies, hint: t('intake.allergiesHint') });
  const allergyOther = textField(t('intake.allergyOther'), { value: m.allergies_other, required: true });
  const allergyOtherWrap = el('div', {}, [allergyOther.node]);
  const allergyListWrap = el('div', {}, [allergyGrid.node, allergyOtherWrap]);
  const syncAllergies = () => {
    showWhen(allergyListWrap, gate.get() === 'yes');
    showWhen(allergyOtherWrap, allergyGrid.get().includes('other'));
  };
  gate.input.addEventListener('change', syncAllergies);
  allergyGrid.node.addEventListener('click', syncAllergies);
  syncAllergies();
  const allergyField = el('div', { class: 'field intake-block' }, [
    el('span', { class: 'field-label intake-block-title' }, [t('intake.allergiesTitle'), el('em', { class: 'req' }, [' *'])]),
    gate.node,
    allergyListWrap,
  ]);

  // Order on screen is the order his form asks it, and the order refusals come in.
  const node = el('div', { class: 'medical-form' }, [
    el('div', { class: 'form-grid' }, [el('div', { class: 'span-2' }, [underTx.node])]),
    condField,
    medField,
    el('div', { class: 'form-grid' }, [surgery.node, smoke.node, siteWrap]),
    allergyField,
  ]);

  const medsPicked = () => medGrid.get();
  const otherRows = () => Array.from(medRows.children).map((r) => r._get()).filter((x) => x.name);
  const peek = () => {
    const picked = medsPicked();
    const none = picked.includes('none');
    const meds = none ? [] : [
      ...CHECK.filter((x) => picked.includes(x.key)).map((x) => {
        const prior = priorByKey.get(x.key) || {};
        return { ...prior, key: x.key, name: x.name, dose: prior.dose || '', reason: prior.reason || '' };
      }),
      ...(picked.includes('other') ? otherRows() : []),
    ];
    // Start from what was stored so an answer to a question this form does not
    // show survives, then let every row on screen speak for itself — a row put
    // back to "—" is unanswered again, not silently still its old answer.
    const answers = { ...(v2 ? m.condition_answers : {}) };
    condRows.forEach((r) => { if (r.get()) answers[r.key] = r.get(); else delete answers[r.key]; });
    const status = gate.get();
    const out = {
      ...m,
      under_treatment: underTx.get(),
      condition_answers: answers,
      conditions_other: condOther.get(),
      medications: meds,
      major_surgery: surgery.get(),
      surgery_sites: siteGrid.get(),
      tobacco: smoke.get(),
      allergy_status: status,
      allergies: status === 'yes' ? allergyGrid.get() : [],
      allergies_other: status === 'yes' && allergyGrid.get().includes('other') ? allergyOther.get() : '',
    };
    if (none) out.medications_none = true; else delete out.medications_none;
    return normalizeMedical(out);
  };
  const baseline = JSON.stringify(peek());

  const ORDER = ['under_treatment', ...INTAKE_CONDITIONS.map((k) => 'condition:' + k), 'medications', 'medications_other',
    'major_surgery', 'surgery_sites', 'tobacco', 'allergy_status', 'allergies', 'allergies_other'];
  const QUESTION = {
    under_treatment: () => t('intake.underTreatment'),
    medications: () => t('intake.medsTitle'),
    medications_other: () => t('intake.medOther'),
    major_surgery: () => t('intake.majorSurgery'),
    surgery_sites: () => t('intake.surgerySites'),
    tobacco: () => t('intake.tobacco'),
    allergy_status: () => t('intake.allergyQuestion'),
    allergies: () => t('intake.allergiesTitle'),
    allergies_other: () => t('intake.allergyOther'),
  };

  return {
    node,
    isDirty: () => JSON.stringify(peek()) !== baseline,
    collect: () => {
      const out = peek();
      let missing = firstMissingMedical(out);
      // "Other" ticked with nothing typed is a gap the stored shape cannot see
      // (an empty row is dropped), so it is checked here, in its place.
      const otherEmpty = medsPicked().includes('other') && !otherRows().length;
      if (otherEmpty && (!missing || ORDER.indexOf(missing) >= ORDER.indexOf('medications'))) missing = 'medications_other';
      if (missing) {
        const name = missing.startsWith('condition:')
          ? (condRows.find((r) => r.key === missing.slice(10)) || {}).label
          : QUESTION[missing]();
        toast(req() + name, 'error');
        return false;
      }
      return out;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Dental history (Step 3)                                            */
/* ------------------------------------------------------------------ */

/**
 * Step 3: when the patient last saw a dentist, Dr. Trinh's eight symptom
 * questions, and — with includeVisitType — the "What do you need today?" 1–4
 * scale that decides routing and whether the oral-surgery consent is added.
 * Keys this step does not ask (an older record's gum_bleeding, ortho…) survive.
 */
export function dentalHistorySection(initial = {}, { staff = false, includeVisitType = false } = {}) {
  void staff;
  const dh = initial || {};
  // "Reason for today's visit" is gone: "What do you need today?" asks the
  // same thing as a countable choice, and the free-text box duplicated it in
  // prose nothing could report on.
  // A record from before this was a dropdown holds prose ("Dr. Prior", "2 yrs
  // ago"); it opens as recorded, so whoever edits it sees what it says.
  const prior = recordedSelect(
    t('intake.priorDentist'),
    [dash, ...priorDentistOptions().map((o) => ({ value: o.key, label: o.label }))],
    dh.prior_dentist, { required: true },
  );
  const ynOpts = answerOpts(['yes', 'no']);
  const QUESTIONS = dentalQuestions().map((q) => ({
    key: q.key, label: q.label,
    field: selectField(q.label, ynOpts, { value: dh[q.key] || '', required: true }),
  }));

  let visit = null;
  if (includeVisitType) visit = visitScale(dh.visit_type);

  const node = el('div', {}, [
    el('div', { class: 'form-grid' }, [prior.node, ...QUESTIONS.map((q) => q.field.node)]),
    visit ? visit.node : null,
  ]);

  const peek = () => {
    const out = { ...dh, prior_dentist: prior.get() };
    QUESTIONS.forEach((q) => { out[q.key] = q.field.get(); });
    if (visit && visit.get()) {
      const vopt = visit.get();
      out.visit_type = vopt.key;
      out.may_need_extraction = vopt.surgery ? 'yes' : 'no';
    }
    return out;
  };
  const baseline = JSON.stringify(peek());

  return {
    node,
    isDirty: () => JSON.stringify(peek()) !== baseline,
    collect: () => {
      // Every dental question is required. Each refusal names the question it
      // is about — a bare "please complete this step" on a screen of
      // near-identical rows is the reason people give up on a form.
      if (!prior.get()) { toast(req() + t('intake.priorDentist'), 'error'); return false; }
      const missing = QUESTIONS.find((q) => !q.field.get());
      if (missing) { toast(req() + missing.label, 'error'); return false; }
      if (visit && !visit.get()) { toast(L({ en: 'Please choose what you need today.', es: 'Por favor elija qué necesita hoy.', ru: 'Пожалуйста, выберите, что вам нужно сегодня.' }), 'error'); return false; }
      return peek();
    },
  };
}

// "What do you need today?" on a 1–4 slider. Options 1 & 2 (extraction) add the
// oral-surgery consent (may_need_extraction='yes').
function visitScale(storedKey) {
  const VOPTS = visitTypes();
  const storedIdx = VOPTS.findIndex((o) => o.key === storedKey);
  let visitNum = storedIdx >= 0 ? storedIdx + 1 : null; // 1..4, null = not chosen
  const visitQ = L({ en: 'What do you need today?', es: '¿Qué necesita hoy?', ru: 'Что вам нужно сегодня?' });
  const slidePrompt = L({ en: 'Slide or tap a number to choose.', es: 'Deslice o toque un número para elegir.', ru: 'Проведите или коснитесь номера, чтобы выбрать.' });
  const surgeryNote = L({ en: 'An oral surgery consent will be added.', es: 'Se agregará un consentimiento de cirugía oral.', ru: 'Будет добавлено согласие на операцию.' });
  const visitRange = el('input', { type: 'range', min: '1', max: '4', step: '1', value: String(visitNum || 1), class: 'visit-range', style: 'width:100%;accent-color:var(--accent);height:28px' });
  const visitDesc = el('div', { class: 'visit-desc', style: 'min-height:26px;margin-top:6px;font-weight:var(--fw-semibold)' });
  const visitTicks = VOPTS.map((o, i) => el('button', {
    type: 'button',
    style: 'flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 4px;border:var(--border-line);border-radius:var(--radius-sm);background:var(--surface);cursor:pointer',
    onClick: () => setVisit(i + 1),
  }, [
    el('span', { style: 'font-size:var(--fs-h3);font-weight:var(--fw-bold)' }, [String(i + 1)]),
    el('span', { style: 'font-size:var(--fs-2xs);text-align:center;line-height:1.15' }, [o.label]),
  ]));
  function paintVisit() {
    // Dim the track until a choice is actually made, so the thumb parked at 1
    // doesn't read as "option 1 is selected".
    visitRange.style.opacity = visitNum ? '1' : '0.45';
    visitTicks.forEach((tk, i) => {
      const on = visitNum === i + 1;
      tk.style.borderColor = on ? 'var(--accent)' : '';
      tk.style.background = on ? 'var(--accent-soft, rgba(20,150,140,0.12))' : 'var(--surface)';
      tk.style.boxShadow = on ? 'inset 0 0 0 1px var(--accent)' : '';
    });
    clear(visitDesc);
    if (visitNum) {
      const o = VOPTS[visitNum - 1];
      visitDesc.append(el('span', {}, [`${visitNum}. ${o.label}`]));
      if (o.surgery) visitDesc.append(el('span', { class: 'subtle small', style: 'display:block;font-weight:var(--fw-medium);margin-top:2px' }, [surgeryNote]));
    } else {
      visitDesc.append(el('span', { class: 'subtle' }, [slidePrompt]));
    }
  }
  function setVisit(n) { visitNum = n; visitRange.value = String(n); paintVisit(); }
  // A range input only fires `input` when the value CHANGES. With nothing
  // chosen the thumb already sits at 1, so a patient who wants option 1 and
  // slides/taps there produces no event at all — and is then refused at Next
  // with "please choose what you need today", which reads as the form kicking
  // them back for an answer they did give. Commit on any interaction.
  const commitVisit = () => setVisit(Number(visitRange.value));
  visitRange.addEventListener('input', commitVisit);
  visitRange.addEventListener('change', commitVisit);
  visitRange.addEventListener('click', commitVisit);
  visitRange.addEventListener('keyup', commitVisit);
  paintVisit();
  const node = el('div', { class: 'highlight-field' }, [
    el('span', { class: 'field-label' }, [visitQ]),
    visitDesc,
    visitRange,
    el('div', { style: 'display:flex;gap:8px;margin-top:10px' }, visitTicks),
  ]);
  return { node, get: () => (visitNum ? VOPTS[visitNum - 1] : null) };
}
