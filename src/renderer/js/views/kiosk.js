import { el, clear, toast } from '../dom.js';
import { icon } from '../icons.js';
import { t, tRaw, getLang, setLang, languageList, visitTypeLabel, speak, stopSpeaking, priorDentistLabel, routeForVisitType, answerLabel } from '../i18n.js';
import { textField } from '../forms.js';
import { SignatureField } from '../components/signatureField.js';
import { demographicsSection, medicalHistorySection, dentalHistorySection, eventCities, matchCity } from '../components/intakeSections.js';
import { medicalDisplay } from '../medicalHistory.js';
import { api } from '../api.js';
import { store } from '../store.js';

export function renderKiosk(ctx) {
  // Where check-in returns to. Patient self-service is launched from the sign-in
  // screen (nobody signed in) → lock back to sign-in. A staff member running a
  // registration desk stays signed in → drop them back on the dashboard so they
  // can start the next check-in without re-entering their password.
  const backTo = () => { setLang('en'); ctx.navigate(store.user ? 'dashboard' : 'login'); };
  const data = {
    language: 'en',
    demographics: {}, medical_history: {}, dental_history: {}, consents: [],
  };
  const root = el('div', { class: 'kiosk' });
  let started = false;
  let eventLangs = null; // CSV of language codes enabled for the active event
  let eventCityList = []; // the active event's City dropdown; empty = a text box

  // Step builders return { title, node, collect } — collect() validates and
  // writes into `data`, returning false to block navigation.
  let steps = [];
  let idx = 0;
  let current = null; // the step object built for the CURRENTLY displayed inputs

  function computeSteps() {
    const list = [stepDemographics, stepMedical, stepDental, stepGeneralConsent];
    if (data.dental_history.may_need_extraction === 'yes') list.push(stepSurgeryConsent);
    // No "who would you like to see?" step any more: the answer is already
    // implied by what the patient said they need on the dental step, and asking
    // twice let the two disagree — a patient could ask for a cleaning and then
    // pick the dentist, and the queue believed the second answer.
    //
    // And no survey step (v0.0.15, "Step 5 — remove entire step"): the whole
    // grant survey is asked at check-out now, in one sitting.
    list.push(stepReview);
    return list;
  }

  // Localised string helper: pick the current language, fall back to English.
  const L = (map) => map[getLang()] || map.en;

  // Pre-start language gate: the patient picks a language BEFORE any form chrome
  // renders, so the whole wizard appears in their language (no English flash).
  function renderGate() {
    stopSpeaking();
    clear(root);
    root.append(
      el('div', { class: 'kiosk-gate' }, [
        el('img', { class: 'kiosk-gate-logo', src: '../../assets/mmw-logo.png', alt: 'Mission Minded Free Clinics' }),
        el('div', { class: 'kiosk-welcome' }, [t('intake.welcome')]),
        el('div', { class: 'kiosk-choose' }, [t('intake.chooseLanguage')]),
        el('div', { class: 'lang-grid' }, languageList(eventLangs).map((l) =>
          el('button', { class: 'lang-card', onClick: () => chooseLanguage(l.code) }, [
            el('span', { class: 'lang-native' }, [l.native]),
            el('span', { class: 'lang-en' }, [l.label]),
          ])
        )),
        el('button', { class: 'btn btn--ghost btn--sm kiosk-gate-exit', onClick: backTo }, [icon('x', { size: 16 }), t('common.cancel')]),
      ])
    );
  }

  function chooseLanguage(code) {
    data.language = code;
    setLang(code);
    started = true;
    // The first step needs the event's city list. It has normally long
    // arrived by the time a patient taps a language; waiting for it (briefly)
    // keeps step 1 from being built as a text box and then becoming a dropdown.
    eventLoaded.then(() => {
      steps = computeSteps();
      idx = 0;
      paint();
    });
  }

  function go(n) {
    stopSpeaking();
    if (n > idx) {
      // Collect from the inputs currently on screen (not a fresh rebuild).
      const ok = current && current.collect ? current.collect() : true;
      if (ok === false) return;
      steps = computeSteps(); // surgery step may appear/disappear
    }
    idx = Math.max(0, Math.min(steps.length - 1, n));
    paint();
  }

  function paint() {
    const step = steps[idx]();
    current = step;
    const total = steps.length;
    clear(root);

    const progress = el('div', { class: 'kiosk-progress' },
      steps.map((_, i) => el('span', { class: 'kp-dot' + (i === idx ? ' kp-dot--on' : i < idx ? ' kp-dot--done' : '') }))
    );

    const header = el('div', { class: 'kiosk-header' }, [
      el('img', { class: 'kiosk-logo', src: '../../assets/mmw-logo.png', alt: 'Mission Minded Free Clinics' }),
      el('div', { class: 'kiosk-step-label' }, [`${t('intake.step')} ${idx + 1} ${t('intake.of')} ${total} · ${step.title}`]),
      el('button', { class: 'btn btn--ghost btn--sm btn--icon kiosk-exit', onClick: backTo }, [icon('x', { size: 16 })]),
    ]);

    const body = el('div', { class: 'kiosk-body' }, [step.node]);

    const nav = el('div', { class: 'kiosk-nav' }, [
      idx > 0 ? el('button', { class: 'btn btn--ghost btn--lg', onClick: () => go(idx - 1) }, [icon('back', { size: 18 }), t('common.back')]) : el('span'),
      idx < total - 1
        ? el('button', { class: 'btn btn--primary btn--lg', onClick: () => go(idx + 1) }, [t('common.next'), icon('chevron', { size: 18 })])
        : el('button', { class: 'btn btn--primary btn--lg', onClick: submit }, [icon('check', { size: 18 }), t('common.submit')]),
    ]);

    root.append(progress, header, body, nav);
  }

  /* ---------------- Steps ---------------- */

  // The three question steps are the shared intake builders — the same ones a
  // station mounts to correct an answer later — so the kiosk only decides
  // where each answer lands in `data`.
  function stepDemographics() {
    const sec = demographicsSection({
      first_name: data.first_name, last_name: data.last_name, dob: data.dob, gender: data.gender,
      phone: data.phone, email: data.email, demographics: data.demographics,
    }, { cities: eventCityList });
    return {
      title: t('intake.s_demographics'),
      node: sec.node,
      collect: () => {
        const out = sec.collect();
        if (!out) return false;
        ['first_name', 'last_name', 'dob', 'gender', 'phone', 'email'].forEach((k) => { data[k] = out[k]; });
        // A slow start can build this step before the event's list arrives
        // (a text box); a town typed there is still stored in the listed
        // spelling, so it lands in the same report row as everyone else's.
        data.demographics = { ...out.demographics, city: matchCity(out.demographics.city, eventCityList) || out.demographics.city };
        return true;
      },
    };
  }

  function stepMedical() {
    // A2: vitals are no longer collected at check-in — the EMT records them.
    const sec = medicalHistorySection(data.medical_history);
    return {
      title: t('intake.s_medical'),
      node: sec.node,
      collect: () => {
        const out = sec.collect();
        if (!out) return false;
        data.medical_history = out;
        return true;
      },
    };
  }

  function stepDental() {
    const sec = dentalHistorySection(data.dental_history, { includeVisitType: true });
    return {
      title: t('intake.s_dental'),
      node: sec.node,
      collect: () => {
        const out = sec.collect();
        if (!out) return false;
        data.dental_history = out;
        return true;
      },
    };
  }

  function age() {
    if (!data.dob) return null;
    const d = new Date(data.dob);
    if (isNaN(d)) return null;
    return Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000));
  }

  // Shared consent-section builder with per-section read-aloud. `paras` renders as
  // plain paragraphs (unnumbered), `clauses` as a numbered list.
  function consentSection({ title, intro, paras, clauses, extra }) {
    const wrap = el('div', { class: 'consent-block' });
    const fullText = [title, intro, ...(paras || []), ...(clauses || []), ...(extra ? [extra] : [])].filter(Boolean).join('. ');
    const readLabel = el('span', {}, [t('common.readAloud')]);
    const readBtn = el('button', { class: 'btn btn--read', type: 'button' }, [icon('speaker', { size: 16 }), readLabel]);
    let reading = false;
    const setReading = (on) => { reading = on; readLabel.textContent = on ? t('common.stopReading') : t('common.readAloud'); };
    readBtn.addEventListener('click', () => {
      if (reading) { stopSpeaking(); setReading(false); return; }
      setReading(true);
      speak(fullText, () => setReading(false));
    });
    wrap.append(el('div', { class: 'consent-head' }, [el('h3', {}, [title]), readBtn]));
    if (intro) wrap.append(el('p', { class: 'consent-intro' }, [intro]));
    if (paras) paras.forEach((p) => wrap.append(el('p', { class: 'consent-intro' }, [p])));
    if (clauses) wrap.append(el('ol', { class: 'consent-list' }, clauses.map((c) => el('li', {}, [c]))));
    if (extra) wrap.append(el('p', { class: 'consent-extra' }, [extra]));
    return wrap;
  }

  function stepGeneralConsent() {
    const minor = age() != null && age() < 18;
    const agree = el('input', { class: 'big-check', type: 'checkbox' });
    const signer = textField(t('intake.signerName'), { value: '', required: true });
    const rel = textField(t('intake.relationship'), { value: minor ? '' : '' });
    const sigPad = SignatureField({ getName: () => signer.get() });
    // Typing the name is what Type and Generate render from, so the preview has
    // to follow the field rather than only refresh when the tab is switched.
    signer.input.addEventListener('input', () => sigPad.refresh());

    // Render the complete general-consent wording. English shows the full
    // numbered clauses (consent.generalFull); other languages keep their existing
    // translated paragraph (consent.oregon) — tRaw returns the full list only when
    // the CURRENT language defines it, so no locale falls back to English legalese.
    const generalFull = tRaw('consent.generalFull');
    const sections = el('div', {}, [
      consentSection({
        title: t('consent.generalTitle'),
        intro: generalFull ? '' : t('consent.oregon'),
        clauses: generalFull || null,
      }),
    ]);

    const sigHelp = L({
      en: 'Signature optional — you may sign with a stylus/touchscreen or leave blank.',
      es: 'Firma opcional — puede firmar con un lápiz óptico/pantalla táctil o dejarlo en blanco.',
      ru: 'Подпись необязательна — вы можете расписаться стилусом/на сенсорном экране или оставить поле пустым.',
    });

    /* The MMW consent carries an explicit YES/NO the patient must answer before
       signing — highlighted on the paper form. Ticking "I agree" is not the same
       answer, so it is asked separately and is required. */
    let deemed = '';
    const deemedBtns = ['yes', 'no'].map((v) => el('button', {
      type: 'button', class: 'chip-btn', 'aria-pressed': 'false',
      onClick: () => {
        deemed = v;
        deemedRow.querySelectorAll('.chip-btn').forEach((b, i) => {
          const on = ['yes', 'no'][i] === deemed;
          b.classList.toggle('chip-btn--on', on);
          b.setAttribute('aria-pressed', String(on));
        });
      },
    }, [v === 'yes' ? t('common.yes') : t('common.no')]));
    const deemedRow = el('div', { class: 'chip-row' }, deemedBtns);
    const deemedField = el('div', { class: 'deemed-field' }, [
      el('span', { class: 'field-label' }, [L({
        en: 'The deemed notice for HIV, Covid-19, Hepatitis B and C exposure has been explained to me and I understand it.',
        es: 'Se me ha explicado el aviso de consentimiento presunto para la exposición al VIH, Covid-19 y Hepatitis B y C, y lo entiendo.',
        ru: 'Мне разъяснено уведомление о предполагаемом согласии на тестирование на ВИЧ, Covid-19 и гепатит B и C, и я это понимаю.',
      })]),
      deemedRow,
    ]);

    const node = el('div', { class: 'consent-screen' }, [
      minor ? el('div', { class: 'minor-banner' }, [icon('alert', { size: 16 }), ' ' + t('intake.minorNotice')]) : null,
      sections,
      deemedField,
      el('label', { class: 'agree-row' }, [agree, el('span', {}, [t('consent.agree')])]),
      el('div', { class: 'form-grid' }, [signer.node, rel.node]),
      sigPad.node,
      el('p', { class: 'field-hint' }, [sigHelp]),
    ]);

    return {
      title: t('intake.s_consent'),
      node,
      collect: () => {
        if (!agree.checked) { toast(t('consent.agree'), 'error'); return false; }
        if (!deemed) {
          toast(L({
            en: 'Please answer Yes or No to the HIV / Hepatitis notice.',
            es: 'Responda Sí o No al aviso sobre VIH / Hepatitis.',
            ru: 'Ответьте «Да» или «Нет» на уведомление о ВИЧ / гепатите.',
          }), 'error');
          return false;
        }
        if (!signer.get()) { toast(t('common.required') + ': ' + t('intake.signerName'), 'error'); return false; }
        // A5: signature is optional — a missing signature does not block submission.
        upsertConsent('general', {
          signer_name: signer.get(), relationship: rel.get(),
          signature_png: sigPad.isEmpty() ? null : sigPad.getDataUrl(),
          signature_method: sigPad.isEmpty() ? null : sigPad.getMethod(),
          deemed_consent: deemed,
          version: `mmw-general-${getLang()}-v1`,
        });
        return true;
      },
    };
  }

  function stepSurgeryConsent() {
    const agree = el('input', { class: 'big-check', type: 'checkbox' });
    const signer = textField(t('intake.signerName'), { value: signerFromGeneral() });
    const sigPad = SignatureField({ getName: () => signer.get() });
    signer.input.addEventListener('input', () => sigPad.refresh());

    // F10: tooth numbers are NOT collected from the patient — the provider
    // records them chairside. Show a read-only note instead of an input.
    const toothNote = {
      es: 'Número(s) de diente: lo completará el proveedor en el sillón dental.',
      ru: 'Номер(а) зуба: заполняется врачом у кресла.',
    }[getLang()] || 'Tooth number(s): to be completed at chairside by the provider.';

    const sigHelp = L({
      en: 'Signature optional — you may sign with a stylus/touchscreen or leave blank.',
      es: 'Firma opcional — puede firmar con un lápiz óptico/pantalla táctil o dejarlo en blanco.',
      ru: 'Подпись необязательна — вы можете расписаться стилусом/на сенсорном экране или оставить поле пустым.',
    });

    // English shows the complete oral-surgery wording (consent.oralSurgeryFull,
    // rendered as paragraphs — it already includes the post-op / emergency call
    // instructions and hold-harmless). Other languages keep their existing sections.
    const surgeryFull = tRaw('consent.oralSurgeryFull');
    const surgerySections = surgeryFull
      ? [consentSection({ title: t('consent.surgeryTitle'), paras: surgeryFull })]
      : [
          consentSection({ title: t('consent.surgeryTitle'), intro: t('consent.surgeryIntro'), clauses: t('consent.surgeryClauses') }),
          consentSection({ title: t('consent.postOpTitle'), clauses: [t('consent.postOp')], extra: t('consent.emergency') }),
        ];
    const node = el('div', { class: 'consent-screen' }, [
      ...surgerySections,
      el('div', { class: 'banner banner--info' }, [icon('flag', { size: 16 }), ' ' + toothNote]),
      el('label', { class: 'agree-row' }, [agree, el('span', {}, [t('consent.agree')])]),
      signer.node,
      sigPad.node,
      el('p', { class: 'field-hint' }, [sigHelp]),
    ]);

    return {
      title: t('intake.s_surgery'),
      node,
      collect: () => {
        if (!agree.checked) { toast(t('consent.agree'), 'error'); return false; }
        // A5: signature is optional — a missing signature does not block submission.
        upsertConsent('oral_surgery', {
          signer_name: signer.get() || signerFromGeneral(),
          signature_png: sigPad.isEmpty() ? null : sigPad.getDataUrl(),
          signature_method: sigPad.isEmpty() ? null : sigPad.getMethod(),
          version: `oral_surgery-${getLang()}-v1`,
        });
        return true;
      },
    };
  }

  function stepReview() {
    const dh = data.dental_history;
    // What the patient told us, read back in their language before they sign:
    // the allergy answer (with anything typed), the conditions answered Yes and
    // those they were unsure of, and every medication — the things a dentist
    // acts on, so the things worth a second look.
    const md = medicalDisplay(data.medical_history, getLang());
    const allergyText = md.allergyStatus === 'nkda' ? t('intake.nkda')
      : md.allergyStatus === 'unsure' ? t('intake.unsure')
        : md.allergies.map((a) => a.label).join(', ');
    const row = (label, val) => el('div', { class: 'review-row' }, [
      el('span', { class: 'review-label' }, [label]), el('span', { class: 'review-val' }, [val || '—']),
    ]);
    const node = el('div', { class: 'review' }, [
      el('h3', {}, [t('intake.reviewTitle')]),
      el('p', { class: 'muted' }, [t('intake.reviewHint')]),
      el('div', { class: 'review-card' }, [
        row(t('intake.firstName') + ' / ' + t('intake.lastName'), `${data.first_name} ${data.last_name}`),
        row(t('intake.dob'), data.dob),
        row(t('intake.phone'), data.phone),
        row(t('intake.city'), [data.demographics.city, data.demographics.state].filter(Boolean).join(', ')),
        row(t('intake.allergiesTitle'), allergyText),
        row(t('intake.conditionsTitle'), md.yes.map((c) => c.label).join(', ') || (md.conditionsNone ? t('common.none') : '')),
        md.unsure.length ? row(t('intake.unsure'), md.unsure.map((c) => c.label).join(', ')) : null,
        row(t('intake.medsTitle'), md.medsNone ? t('intake.noMeds') : md.meds.map((x) => x.name).join(', ')),
        row(t('intake.majorSurgery'), md.surgery === 'yes' && md.surgerySites.length
          ? `${answerLabel('yes')} — ${md.surgerySites.join(', ')}` : answerLabel(md.surgery)),
        row(t('intake.tobacco'), answerLabel(md.smoke)),
        row(L({ en: 'What you need today', es: 'Qué necesita hoy', ru: 'Что вам нужно сегодня' }), visitTypeLabel(dh.visit_type)),
        row(t('intake.priorDentist'), priorDentistLabel(dh.prior_dentist)),
        row(
          L({ en: 'Who you will see', es: 'A quién verá', ru: 'К кому вы обратитесь' }),
          routeForVisitType(dh.visit_type) === 'hygienist' ? L({ en: 'Hygienist', es: 'Higienista', ru: 'Гигиенист' })
            : routeForVisitType(dh.visit_type) === 'dentist' ? L({ en: 'Dentist', es: 'Dentista', ru: 'Стоматолог' })
            : ''
        ),
        row(t('intake.s_consent'), data.consents.map((c) => c.type === 'general' ? 'General — signed' : 'Oral Surgery — signed').join(' · ')),
      ]),
    ]);
    return { title: t('intake.s_review'), node, collect: () => true };
  }

  /* ---------------- helpers ---------------- */

  function upsertConsent(type, fields) {
    const now = new Date().toISOString();
    const existing = data.consents.find((c) => c.type === type);
    const base = { type, language: getLang(), signed_at: now, relationship: '', ...fields };
    if (existing) Object.assign(existing, base);
    else data.consents.push(base);
  }
  function signerFromGeneral() {
    const g = data.consents.find((c) => c.type === 'general');
    return g ? g.signer_name : `${data.first_name} ${data.last_name}`.trim();
  }

  async function submit() {
    // Capture the step the patient is sitting on before submitting (the final
    // "Submit" tap bypasses forward-nav collect()).
    const ok = current && current.collect ? current.collect() : true;
    if (ok === false) return;
    try {
      const patient = await api.createPatient(data);
      showThankYou(patient);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function showThankYou(patient) {
    stopSpeaking();
    clear(root);

    // F19: optional offline transfer of this check-in to a USB drive. Does not
    // block the thank-you flow — the patient can simply tap Done.
    const usbLabel = { es: 'Guardar en unidad USB', ru: 'Сохранить на USB-накопитель' }[getLang()] || 'Save to USB drive';
    const usbBtn = el('button', { class: 'btn btn--soft btn--lg', type: 'button' }, [icon('usb', { size: 18 }), usbLabel]);
    usbBtn.addEventListener('click', async () => {
      usbBtn.disabled = true;
      try {
        const res = await api.usbWriteCheckin(patient.id);
        toast((res && res.message) || (typeof res === 'string' ? res : t('common.saved')), 'success');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        usbBtn.disabled = false;
      }
    });

    root.append(el('div', { class: 'kiosk-thanks' }, [
      el('div', { class: 'thanks-check' }, [icon('check', { size: 44, stroke: 2.2 })]),
      el('h1', {}, [t('intake.thanks')]),
      el('p', {}, [t('intake.thanksSub')]),
      el('div', { class: 'thanks-name' }, [`${patient.first_name} ${patient.last_name}`]),
      el('div', { class: 'thanks-actions' }, [
        usbBtn,
        el('button', { class: 'btn btn--primary btn--lg', onClick: backTo }, [t('intake.done')]),
      ]),
    ]));
  }

  // Boot: show the language gate, then refine it with the active event's
  // enabled language packs (and its City list) once they load. Never waits more
  // than a moment: a patient must not be stranded on the gate because the
  // event could not be read — the City box simply stays a text box.
  setLang('en');
  renderGate();
  const eventLoaded = Promise.race([
    api.activeEvent().then((ev) => {
      eventCityList = eventCities(ev);
      if (ev && ev.languages) { eventLangs = ev.languages; if (!started) renderGate(); }
    }).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  return root;
}
