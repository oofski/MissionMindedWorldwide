import { CATALOG, LANGUAGES, CONDITIONS, ALLERGIES, REFERRALS, VISIT_TYPES, PRIOR_DENTIST, routeForVisitType, RACE, US_STATES, MEDICATIONS, ANESTHETICS, MED_CHECKLIST, SURGERY_SITES, DENTAL_QUESTIONS } from '../i18n/strings.js';

let lang = 'en';

export function setLang(code) {
  lang = CATALOG[code] ? code : 'en';
  document.documentElement.lang = lang;
}
export function getLang() {
  return lang;
}

// Translate a dotted path, e.g. t('intake.firstName'). Falls back to English,
// then to the raw key if nothing is found.
export function t(path) {
  const lookup = (obj) =>
    path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const val = lookup(CATALOG[lang]);
  if (val != null) return val;
  const fallback = lookup(CATALOG.en);
  return fallback != null ? fallback : path;
}

// Like t(), but WITHOUT the English fallback: returns the value only if the
// CURRENT language defines it, else undefined. Used for consent bodies so English
// can show the full authoritative wording while other languages keep their own
// translated consent text (rather than falling back to English legalese).
export function tRaw(path) {
  const lookup = (obj) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  return lookup(CATALOG[lang]);
}

export function raceOptions() {
  return RACE.map((o) => ({ key: o.key, label: o[lang] || o.en }));
}

/** Display text for one stored race key; unknown keys pass through verbatim. */
export function raceLabel(key) {
  const hit = RACE.find((o) => o.key === key);
  return hit ? (hit[lang] || hit.en) : String(key || '');
}

export function priorDentistOptions() {
  return PRIOR_DENTIST.map((o) => ({ key: o.key, label: o[lang] || o.en }));
}

/**
 * Display text for a stored prior_dentist value.
 *
 * Records created before this became a dropdown hold free text ("2 yrs ago",
 * "?"). Those are shown back verbatim rather than blanked or coerced into a
 * bucket they may not belong in — the answer the patient actually gave is the
 * honest thing to print on their record.
 */
export function priorDentistLabel(value) {
  if (!value) return '';
  const hit = PRIOR_DENTIST.find((o) => o.key === value);
  return hit ? (hit[lang] || hit.en) : String(value);
}

// `intake` (default true) marks what is ASKED at check-in; an entry with
// intake:false is retired but still resolves for DISPLAY on existing records, so
// every screen that reads these lists sees the whole catalogue and only the
// forms filter it down.
export function conditions() {
  return CONDITIONS.map((c) => ({ key: c.key, flag: c.flag, label: c[lang] || c.en, intake: c.intake !== false }));
}
export function allergies() {
  return ALLERGIES.map((a) => ({ key: a.key, label: a[lang] || a.en, intake: a.intake !== false }));
}
// A stored key the catalogue does not know — written by a newer build, or by an
// older one before a rename — is shown title-cased rather than dropped. A logged
// allergy that silently vanished from the screen is the one failure this list
// must never have.
const titleCase = (k) => String(k || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export function conditionLabel(key) {
  const c = CONDITIONS.find((x) => x.key === key);
  return c ? (c[lang] || c.en) : titleCase(key);
}
export function allergyLabel(key) {
  const a = ALLERGIES.find((x) => x.key === key);
  return a ? (a[lang] || a.en) : titleCase(key);
}
// Dr. Trinh's medication checklist. `name` is the canonical English name that is
// STORED (the blood-thinner rules match on it); `label` is what the patient reads.
export function medChecklist() {
  return MED_CHECKLIST.map((m) => ({ key: m.key, name: m.en, label: m[lang] || m.en }));
}
export function surgerySites() {
  return SURGERY_SITES.map((s) => ({ key: s.key, label: s[lang] || s.en }));
}
export function dentalQuestions() {
  return DENTAL_QUESTIONS.map((q) => ({ key: q.key, label: q[lang] || q.en, short: q.short }));
}
// Yes / No / Unsure / Not applicable in the current language, for any answer
// the intake forms store. Anything else passes through as given.
export function answerLabel(v) {
  if (v === 'yes') return t('common.yes');
  if (v === 'no') return t('common.no');
  if (v === 'unsure') return t('intake.unsure');
  if (v === 'na') return t('intake.pregnancyNA');
  return v == null ? '' : String(v);
}
export function referrals() {
  return REFERRALS.map((r) => ({ key: r.key, label: r[lang] || r.en }));
}
// Resolve a stored referral key to a localized label (passes through legacy free text).
export function referralLabel(key) {
  const r = REFERRALS.find((x) => x.key === key);
  return r ? (r[lang] || r.en) : (key || '');
}
// Visit-type options for the check-in scale (localized), and a single-key resolver
// for clinician screens. `surgery` marks the options that trigger oral-surgery consent.
export function visitTypes() {
  return VISIT_TYPES.map((v) => ({ key: v.key, label: v[lang] || v.en, surgery: !!v.surgery }));
}
export function visitTypeLabel(key) {
  const v = VISIT_TYPES.find((x) => x.key === key);
  return v ? (v[lang] || v.en) : '';
}
// All known languages, or only those enabled for an event (CSV string of codes).
export function languageList(enabledCsv) {
  if (!enabledCsv) return LANGUAGES;
  const codes = String(enabledCsv).split(',').map((s) => s.trim()).filter(Boolean);
  const filtered = LANGUAGES.filter((l) => codes.includes(l.code));
  return filtered.length ? filtered : LANGUAGES.filter((l) => l.code === 'en');
}

// Read-aloud using the browser speech engine (offline, built into Chromium).
let speaking = false;
export function speak(text, onEnd) {
  if (!('speechSynthesis' in window)) return false;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  // Map each pack to the closest available TTS voice (Kriol/Nyanja fall back to English).
  const ttsLang = { en: 'en-US', es: 'es-ES', ru: 'ru-RU', bzj: 'en-US', nya: 'en-US' };
  u.lang = ttsLang[lang] || 'en-US';
  u.rate = 0.95;
  u.onend = () => { speaking = false; if (onEnd) onEnd(); };
  speaking = true;
  window.speechSynthesis.speak(u);
  return true;
}
export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  speaking = false;
}
export function isSpeaking() {
  return speaking;
}

// Re-exported so views import route derivation from the same place as labels.
export { routeForVisitType, US_STATES, MEDICATIONS, ANESTHETICS };
