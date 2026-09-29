// The patient exit survey, as the patient sees it.
//
// Opened at check-out and handed to the patient — so it is built like the kiosk
// rather than like a staff form: its own full-screen surface, big touch targets,
// and its own language switch, because the person answering may not read the
// language the volunteer has the app set to.
//
// All 34 questions, in one sitting (v0.0.15). A question with one answer is a
// dropdown and a select-all-that-apply question is a set of chips — the same
// two controls the rest of the intake uses — which keeps thirty-four questions
// to a form a patient can get through at the desk.
//
// It is voluntary. Every question can be left blank, and the whole thing can be
// declined, because it is attached to free care and a patient who does not want
// to disclose their income must still be able to walk out. "Declined" is
// recorded as an answer in its own right so the clinic can tell the difference
// between a patient who refused and one nobody asked.

import { el, toast, modal, withBusy } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { selectField, chipGrid } from '../forms.js';
import { SECTIONS, SURVEY_VERSION, SURVEY_TITLE, EXIT_SECTIONS, questionsForStage } from '../../i18n/exitSurvey.js';

const UI = {
  en: {
    title: SURVEY_TITLE.en,
    kicker: 'Before you go',
    lede: 'These questions help Mission Minded Worldwide show what this clinic did for the community, and apply for the funding that keeps it free. Everything is optional, and nothing here changes the care you received today.',
    privacy: 'Your answers are reported as totals only — never with your name.',
    progress: (a, b) => `${a} of ${b} answered`,
    done: 'Finish',
    decline: 'I would rather not answer',
    declineConfirm: 'Skip the survey?',
    declineWarn: 'Declining removes every answer on this form, including the ones that were already filled in. Nothing about your care changes.',
    declineKeep: 'Keep answering',
    declineYes: 'Yes, skip the survey',
    prefilled: 'Some answers are already filled in from what you told us when you registered. Please check them and change anything that is not right.',
    clear: 'Clear',
    langLabel: 'English',
    saved: 'Thank you — your answers are recorded.',
    declined: 'No problem. Thank you for visiting.',
    close: 'Close',
    optional: 'Optional',
  },
  es: {
    title: SURVEY_TITLE.es,
    kicker: 'Antes de irse',
    lede: 'Estas preguntas ayudan a Mission Minded Worldwide a mostrar lo que esta clínica hizo por la comunidad y a solicitar los fondos que la mantienen gratuita. Todo es opcional y nada de esto cambia la atención que recibió hoy.',
    privacy: 'Sus respuestas se reportan solo como totales — nunca con su nombre.',
    progress: (a, b) => `${a} de ${b} respondidas`,
    done: 'Terminar',
    decline: 'Prefiero no responder',
    declineConfirm: '¿Omitir la encuesta?',
    declineWarn: 'Si no desea responder, se borrarán todas las respuestas de este formulario, incluidas las que ya estaban completadas. Nada de su atención cambia.',
    declineKeep: 'Seguir respondiendo',
    declineYes: 'Sí, omitir la encuesta',
    prefilled: 'Algunas respuestas ya están completadas con lo que nos dijo al registrarse. Revíselas y cambie lo que no sea correcto.',
    clear: 'Borrar',
    langLabel: 'Español',
    saved: 'Gracias — sus respuestas quedaron registradas.',
    declined: 'No hay problema. Gracias por su visita.',
    close: 'Cerrar',
    optional: 'Opcional',
  },
};

/**
 * Open the survey for `patient`. Resolves with the saved survey row, or null if
 * the volunteer closed it without finishing (which records nothing, so it can
 * be picked up again).
 */
export function openExitSurvey(patient, { lang = 'en', existing = null, stage = 'exit' } = {}) {
  // Every question is asked at check-out since v0.0.15. The stage is still
  // passed through to the save, because the data layer decides from it which
  // answers a save replaces and which status it records.
  const MY_SECTIONS = stage === 'exit' ? EXIT_SECTIONS : SECTIONS.filter((x) => x.stage === stage);
  const MY_QUESTIONS = questionsForStage(stage);
  return new Promise((resolve) => {
    let L = UI[lang] ? lang : 'en';
    // Seeded from an existing response so reopening corrects rather than
    // retypes. For a patient registered by v0.0.10–v0.0.14 (or through an online
    // form still on the old worker) this is also the household half they gave
    // at registration: it is shown filled in for them to confirm, never asked a
    // second time and never silently kept.
    const answers = { ...((existing && existing.answers) || {}) };
    const isAnswered = (v) => (Array.isArray(v) ? v.length > 0 : v != null && v !== '');
    const fromRegistration = !!(existing && existing.registration_status && existing.exit_status !== 'completed'
      && MY_QUESTIONS.some((q) => isAnswered(answers[q.key])));

    const overlay = el('div', { class: 'survey-overlay' });
    const close = (val) => { overlay.remove(); document.body.classList.remove('survey-open'); resolve(val); };

    const body = el('div', { class: 'survey-body' });
    const progress = el('div', { class: 'survey-progress' });
    const titleNode = el('h2', {}, ['']);
    const kickerNode = el('span', { class: 'survey-kicker' }, ['']);
    const finishBtn = el('button', { class: 'btn btn--primary btn--lg' }, [icon('checkCircle', { size: 18 }), '']);
    const declineBtn = el('button', { class: 'btn btn--ghost' }, ['']);

    const answeredCount = () => MY_QUESTIONS.filter((q) => isAnswered(answers[q.key])).length;

    function refreshProgress() {
      const t = UI[L];
      progress.replaceChildren(
        el('div', { class: 'survey-progress-bar' }, [
          el('span', { style: `width:${Math.round((answeredCount() / MY_QUESTIONS.length) * 100)}%` }),
        ]),
        el('span', { class: 'survey-progress-text' }, [t.progress(answeredCount(), MY_QUESTIONS.length)]),
      );
    }

    // "None" and "Prefer not to answer" are answers ABOUT a select-all list, so
    // they replace it rather than joining it — otherwise a record can say both
    // "no assistance" and "SNAP".
    const EXCLUSIVE = new Set(['none', 'pna']);

    /** One question: its text, then a dropdown (one answer) or chips (several). */
    function questionNode(q) {
      const t = UI[L];
      let control;
      if (q.type === 'multi') {
        const chips = chipGrid(null, q.options.map((o) => ({ key: o.value, label: o[L] || o.en })),
          { selected: answers[q.key] || [] });
        // The chip has already toggled itself by the time the click reaches
        // the grid; this applies the exclusive rule and records the result.
        chips.node.addEventListener('click', (e) => {
          const chip = e.target.closest('[data-key]');
          if (!chip) return;
          const k = chip.dataset.key;
          const cur = chips.get();
          if (cur.includes(k)) chips.set(EXCLUSIVE.has(k) ? [k] : cur.filter((x) => !EXCLUSIVE.has(x)));
          const now = chips.get();
          if (now.length) answers[q.key] = now; else delete answers[q.key];
          refreshProgress();
        });
        control = chips.node;
      } else {
        // A blank first choice is how a question is left unanswered — or put
        // back to unanswered, by a patient who would rather not say.
        const sel = selectField('', [{ value: '', label: '—' }, ...q.options.map((o) => ({ value: o.value, label: o[L] || o.en }))],
          { value: answers[q.key] || '' });
        sel.input.setAttribute('aria-label', q[L] || q.en);
        sel.input.addEventListener('change', () => {
          if (sel.get()) answers[q.key] = sel.get(); else delete answers[q.key];
          refreshProgress();
        });
        control = sel.input;
      }

      return el('div', { class: 'survey-q', id: `q-${q.key}`, dataset: { type: q.type } }, [
        el('div', { class: 'survey-q-head' }, [
          el('span', { class: 'survey-q-text' }, [q[L] || q.en]),
          el('span', { class: 'survey-q-opt' }, [t.optional]),
        ]),
        (L === 'es' ? q.hintEs : q.hintEn)
          ? el('p', { class: 'survey-q-hint' }, [L === 'es' ? q.hintEs : q.hintEn]) : null,
        control,
      ]);
    }

    function paint() {
      const t = UI[L];
      titleNode.textContent = t.title;
      kickerNode.textContent = t.kicker;
      finishBtn.replaceChildren(icon('checkCircle', { size: 18 }), el('span', {}, [t.done]));
      declineBtn.replaceChildren(el('span', {}, [t.decline]));
      body.replaceChildren(
        el('div', { class: 'survey-lede' }, [
          el('p', {}, [t.lede]),
          el('p', { class: 'survey-privacy' }, [icon('lock', { size: 14 }), el('span', {}, [t.privacy])]),
          fromRegistration ? el('p', { class: 'survey-prefilled' }, [icon('info', { size: 14 }), el('span', {}, [t.prefilled])]) : null,
        ]),
        ...MY_SECTIONS.map((sec) => el('section', { class: 'survey-section' }, [
          el('h3', { class: 'survey-section-title' }, [sec[L] || sec.en]),
          ...sec.questions.map(questionNode),
        ])),
      );
      refreshProgress();
    }

    const langBtn = el('button', { class: 'btn btn--ghost btn--sm' }, []);
    function paintLang() {
      langBtn.replaceChildren(icon('globe', { size: 15 }), el('span', {}, [UI[L].langLabel]));
    }
    langBtn.addEventListener('click', () => {
      L = L === 'en' ? 'es' : 'en';
      paintLang(); paint();
      body.scrollTop = 0;
    });

    finishBtn.addEventListener('click', async () => {
      try {
        const saved = await withBusy(finishBtn, () =>
          api.saveExitSurvey(patient.id, { version: SURVEY_VERSION, language: L, answers, declined: false, stage }));
        toast(UI[L].saved, 'success');
        close(saved);
      } catch (e) { toast(e.message || 'Could not save the survey.', 'error'); }
    });

    declineBtn.addEventListener('click', async () => {
      // A decline at check-out clears every answer on the form, the pre-filled
      // registration ones included (the patient is saying "I would rather not
      // answer" to what they can see). So when there is anything on the form,
      // say that before it goes.
      if (answeredCount() > 0) {
        const t = UI[L];
        const ok = await modal({ title: t.declineConfirm, body: el('p', {}, [t.declineWarn]), confirmText: t.declineYes, cancelText: t.declineKeep });
        if (!ok) return;
      }
      try {
        const saved = await withBusy(declineBtn, () =>
          api.saveExitSurvey(patient.id, { version: SURVEY_VERSION, language: L, declined: true, stage }));
        toast(UI[L].declined, 'success');
        close(saved);
      } catch (e) { toast(e.message || 'Could not save the survey.', 'error'); }
    });

    overlay.append(
      el('div', { class: 'survey-card' }, [
        el('header', { class: 'survey-head' }, [
          el('div', {}, [
            el('img', { class: 'survey-logo', src: '../../assets/mmw-logo.png', alt: 'Mission Minded Free Clinics' }),
            kickerNode,
            titleNode,
          ]),
          el('div', { class: 'survey-head-actions' }, [
            langBtn,
            // Closing without answering records NOTHING, so the desk can hand the
            // tablet over again. Only Finish or Decline write a row.
            el('button', { class: 'btn btn--ghost btn--sm', title: UI[L].close, onClick: () => close(null) }, [icon('x', { size: 16 })]),
          ]),
        ]),
        body,
        el('footer', { class: 'survey-foot' }, [progress, el('div', { class: 'survey-foot-actions' }, [declineBtn, finishBtn])]),
      ]),
    );

    paintLang(); paint();
    document.body.classList.add('survey-open');
    document.body.append(overlay);
    body.focus();
  });
}

/** A short line describing where a patient's survey stands, for the desk. */
export function surveyStatus(sv) {
  // About CHECK-OUT only — that is what this desk is being asked for, and since
  // v0.0.15 it is the whole survey. A row that registration filed on an older
  // build (exit_status still empty) has NOT been taken: its answers are the
  // household half, which check-out shows the patient to confirm.
  const mine = questionsForStage('exit');
  const n = mine.filter((q) => {
    const v = ((sv && sv.answers) || {})[q.key];
    return Array.isArray(v) ? v.length > 0 : v != null && v !== '';
  }).length;
  if (!sv || !sv.exit_status) {
    return n
      ? { key: 'none', label: `Not yet taken · ${n} answered at registration`, pill: 'pill--warning' }
      : { key: 'none', label: 'Not yet taken', pill: 'pill--warning' };
  }
  if (sv.exit_status === 'declined') return { key: 'declined', label: 'Patient declined', pill: 'pill--neutral' };
  return { key: 'done', label: `Completed · ${n} of ${mine.length} answered`, pill: 'pill--success' };
}
