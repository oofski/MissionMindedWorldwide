// The consent the patient signs, in pieces both places that take it share: the
// kiosk's consent steps and the front desk's "Sign consent".
//
// The desk exists for the patient who reaches Arrivals without a signed
// consent. The kiosk used to say "Signature optional — … or leave blank" while
// the desk refused anyone whose consent carried no signature, and nobody at the
// desk could add one, so such a patient was stuck there. The kiosk now requires
// the signature; this lets the desk take it for anyone already through without
// one, in the patient's own language, stored exactly as the kiosk stores it.
import { el, toast } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { CATALOG } from '../../i18n/strings.js';
import { languageList } from '../i18n.js';
import { SignatureField } from './signatureField.js';

const pick = (map, lang) => map[lang] || map.en;

/** Under the signature: what counts as signing. Typing the name is a signature. */
export const SIGN_HELP = {
  en: 'Sign above — draw your signature, or choose "Type my name".',
  es: 'Firme arriba: dibuje su firma o elija «Escribir mi nombre».',
  ru: 'Подпишитесь выше — нарисуйте подпись или выберите «Type my name».',
};
/** The refusal when nothing was signed, naming the way out. */
export const SIGN_REQUIRED = {
  en: 'Please sign the consent — draw your signature, or tap "Type my name".',
  es: 'Por favor firme el consentimiento: dibuje su firma o toque «Escribir mi nombre».',
  ru: 'Пожалуйста, подпишите согласие — нарисуйте подпись или нажмите «Type my name».',
};
/** The HIV / Hepatitis deemed notice the MMW consent asks Yes or No to. */
export const DEEMED_NOTICE = {
  en: 'The deemed notice for HIV, Covid-19, Hepatitis B and C exposure has been explained to me and I understand it.',
  es: 'Se me ha explicado el aviso de consentimiento presunto para la exposición al VIH, Covid-19 y Hepatitis B y C, y lo entiendo.',
  ru: 'Мне разъяснено уведомление о предполагаемом согласии на тестирование на ВИЧ, Covid-19 и гепатит B и C, и я это понимаю.',
};
export const DEEMED_REQUIRED = {
  en: 'Please answer Yes or No to the HIV / Hepatitis notice.',
  es: 'Responda Sí o No al aviso sobre VIH / Hepatitis.',
  ru: 'Ответьте «Да» или «Нет» на уведомление о ВИЧ / гепатите.',
};

// A catalog value in THIS language only (tRaw), or with the English fallback
// (t) — the desk is in English while the consent is read in the patient's.
const raw = (lang, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), CATALOG[lang]);
const txt = (lang, path) => { const v = raw(lang, path); return v != null ? v : raw('en', path); };

/**
 * Which text was signed — a version names one wording, so a version whose
 * wording changes gets a new number and is never reused:
 *   general       v1 everywhere, but Spanish v2: since v0.0.20 the full MMW
 *                 consent, translated (v1 was the shorter hold-harmless text).
 *   oral_surgery  English v1 (the full wording). Spanish v3: the full wording,
 *                 translated, since v0.0.20. Every other language v2: the
 *                 sections ending with consent.emergency, whose number changed
 *                 in v0.0.15 (v1 was the Oregon number).
 * cloud/worker.js consentVersion mirrors this for the online form.
 */
export function consentVersion(type, lang) {
  if (type === 'general') return `mmw-general-${lang}-${lang === 'es' ? 'v2' : 'v1'}`;
  if (lang === 'es') return 'oral_surgery-es-v3';
  return `oral_surgery-${lang}-${raw(lang, 'consent.oralSurgeryFull') ? 'v1' : 'v2'}`;
}

/** The consent's sections in `lang`, as the kiosk shows them. */
export function consentSections(type, lang) {
  if (type === 'general') {
    const full = raw(lang, 'consent.generalFull');
    return [{ title: txt(lang, 'consent.generalTitle'), intro: full ? '' : txt(lang, 'consent.oregon'), clauses: full || null }];
  }
  const full = raw(lang, 'consent.oralSurgeryFull');
  return full
    ? [{ title: txt(lang, 'consent.surgeryTitle'), paras: full }]
    : [
        { title: txt(lang, 'consent.surgeryTitle'), intro: txt(lang, 'consent.surgeryIntro'), clauses: txt(lang, 'consent.surgeryClauses') },
        { title: txt(lang, 'consent.postOpTitle'), clauses: [txt(lang, 'consent.postOp')], extra: txt(lang, 'consent.emergency') },
      ];
}

function sectionNode({ title, intro, paras, clauses, extra }) {
  return el('div', { class: 'consent-block' }, [
    el('div', { class: 'consent-head' }, [el('h3', {}, [title])]),
    intro ? el('p', { class: 'consent-intro' }, [intro]) : null,
    ...(paras || []).map((p) => el('p', { class: 'consent-intro' }, [p])),
    clauses ? el('ol', { class: 'consent-list' }, clauses.map((c) => el('li', {}, [c]))) : null,
    extra ? el('p', { class: 'consent-extra' }, [extra]) : null,
  ]);
}

/**
 * The front desk takes a missing consent: the text in the patient's language,
 * the HIV / Hepatitis Yes/No (general), "I agree", and a signature per consent.
 * `types` lists what is missing ('general', 'oral_surgery'). The overlay stays
 * open until every consent is signed and saved; onSigned() then lets the list
 * refresh, after which "They're here" goes through.
 */
export function openDeskConsent(p, types, { onSigned } = {}) {
  const lang = CATALOG[p.language] ? p.language : 'en';
  const langName = (languageList().find((l) => l.code === lang) || { label: 'English' }).label;
  const name = `${p.first_name || ''} ${p.last_name || ''}`.trim();
  const signer = el('input', { class: 'input', value: name });
  const rel = el('input', { class: 'input', placeholder: 'Self / Parent / Guardian' });

  const blocks = types.filter((x) => x === 'general' || x === 'oral_surgery').map((type) => {
    const agree = el('input', { class: 'big-check', type: 'checkbox' });
    const sig = SignatureField({ getName: () => signer.value, lang, label: txt(lang, 'common.signHere') });
    let deemed = '';
    let deemedRow = null;
    if (type === 'general') {
      deemedRow = el('div', { class: 'chip-row' }, ['yes', 'no'].map((v) => el('button', {
        type: 'button', class: 'chip-btn', 'aria-pressed': 'false',
        onClick: () => {
          deemed = v;
          deemedRow.querySelectorAll('.chip-btn').forEach((b, i) => {
            b.classList.toggle('chip-btn--on', ['yes', 'no'][i] === v);
            b.setAttribute('aria-pressed', String(['yes', 'no'][i] === v));
          });
        },
      }, [txt(lang, v === 'yes' ? 'common.yes' : 'common.no')])));
    }
    const node = el('div', { class: 'desk-consent', dataset: { type } }, [
      ...consentSections(type, lang).map(sectionNode),
      deemedRow ? el('div', { class: 'deemed-field' }, [el('span', { class: 'field-label' }, [pick(DEEMED_NOTICE, lang)]), deemedRow]) : null,
      el('label', { class: 'agree-row' }, [agree, el('span', {}, [txt(lang, 'consent.agree')])]),
      sig.node,
      el('p', { class: 'field-hint' }, [pick(SIGN_HELP, lang)]),
    ]);
    return { type, node, agree, sig, deemed: () => deemed };
  });
  signer.addEventListener('input', () => blocks.forEach((b) => b.sig.refresh()));

  const overlay = el('div', { class: 'modal-overlay desk-consent-overlay' });
  const close = () => overlay.remove();
  const saveBtn = el('button', { class: 'btn btn--primary', type: 'button' }, [icon('pen', { size: 15 }), 'Save signed consent']);
  saveBtn.addEventListener('click', async () => {
    if (!signer.value.trim()) { toast('Required: printed name of the person signing.', 'error'); return; }
    for (const b of blocks) {
      if (b.type === 'general' && !b.deemed()) { toast(pick(DEEMED_REQUIRED, lang), 'error'); return; }
      if (!b.agree.checked) { toast(`${b.type === 'general' ? 'General' : 'Oral surgery'} consent: tick "${txt(lang, 'consent.agree')}" to continue.`, 'error'); return; }
      if (b.sig.isEmpty()) { toast(pick(SIGN_REQUIRED, lang), 'error'); return; }
    }
    saveBtn.disabled = true;
    try {
      const at = new Date().toISOString();
      for (const b of blocks) {
        await api.addConsent(p.id, {
          type: b.type, language: lang, version: consentVersion(b.type, lang), signed_at: at,
          signer_name: signer.value.trim(), relationship: rel.value.trim(),
          signature_png: b.sig.getDataUrl(), signature_method: b.sig.getMethod(),
          ...(b.type === 'general' ? { deemed_consent: b.deemed() } : {}),
        });
      }
      toast(`Consent signed for ${name} — press "They're here" to send them through.`, 'success');
      close();
      if (onSigned) onSigned();
    } catch (e) {
      toast(e.message, 'error');
      saveBtn.disabled = false;
    }
  });

  overlay.append(el('div', { class: 'modal-card modal-card--wide' }, [
    el('h3', { class: 'modal-title' }, [`Sign the consent — ${name}`]),
    el('div', { class: 'modal-body' }, [
      el('p', { class: 'muted small', style: 'margin:0 0 var(--space-3);' }, [
        `Shown in ${langName}, the patient's language. Read it with the patient, then have them sign — drawn, or with their typed name.`,
      ]),
      ...blocks.map((b) => b.node),
      el('div', { class: 'form-grid' }, [
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Printed name of person signing']), signer]),
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['Relationship (if signing for a minor)']), rel]),
      ]),
    ]),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn--ghost', type: 'button', onClick: close }, ['Cancel']),
      saveBtn,
    ]),
  ]));
  document.body.append(overlay);
  return overlay;
}
