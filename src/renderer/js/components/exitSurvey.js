// The patient exit survey, as the patient sees it.
//
// Opened at check-out and handed to the patient — so it is built like the kiosk
// rather than like a staff form: its own full-screen surface, big touch targets,
// and its own language switch, because the person answering may not read the
// language the volunteer has the app set to.
//
// It is voluntary. Every question can be left blank, and the whole thing can be
// declined, because it is attached to free care and a patient who does not want
// to disclose their income must still be able to walk out. "Declined" is
// recorded as an answer in its own right so the clinic can tell the difference
// between a patient who refused and one nobody asked.

import { el, toast, withBusy } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { SECTIONS, SURVEY_VERSION, EXIT_SECTIONS, questionsForStage } from '../../i18n/exitSurvey.js';

const UI = {
  en: {
    title: 'Before you go',
    lede: 'These questions help Mission Minded Worldwide show what this clinic did for the community, and apply for the funding that keeps it free. Everything is optional, and nothing here changes the care you received today.',
    privacy: 'Your answers are reported as totals only — never with your name.',
    progress: (a, b) => `${a} of ${b} answered`,
    done: 'Finish',
    decline: 'I would rather not answer',
    declineConfirm: 'Skip the survey?',
    clear: 'Clear',
    langLabel: 'English',
    saved: 'Thank you — your answers are recorded.',
    declined: 'No problem. Thank you for visiting.',
    close: 'Close',
    optional: 'Optional',
  },
  es: {
    title: 'Antes de irse',
    lede: 'Estas preguntas ayudan a Mission Minded Worldwide a mostrar lo que esta clínica hizo por la comunidad y a solicitar los fondos que la mantienen gratuita. Todo es opcional y nada de esto cambia la atención que recibió hoy.',
    privacy: 'Sus respuestas se reportan solo como totales — nunca con su nombre.',
    progress: (a, b) => `${a} de ${b} respondidas`,
    done: 'Terminar',
    decline: 'Prefiero no responder',
    declineConfirm: '¿Omitir la encuesta?',
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
  // Only this stage's sections, so check-out is a twelve-question ask rather
  // than re-presenting the twenty-two already answered at registration.
  const MY_SECTIONS = stage === 'exit' ? EXIT_SECTIONS : SECTIONS.filter((x) => x.stage === stage);
  const MY_QUESTIONS = questionsForStage(stage);
  return new Promise((resolve) => {
    let L = UI[lang] ? lang : 'en';
    // Seeded from an existing response so reopening corrects rather than retypes.
    const answers = { ...((existing && existing.answers) || {}) };

    const overlay = el('div', { class: 'survey-overlay' });
    const close = (val) => { overlay.remove(); document.body.classList.remove('survey-open'); resolve(val); };

    const body = el('div', { class: 'survey-body' });
    const progress = el('div', { class: 'survey-progress' });
    const finishBtn = el('button', { class: 'btn btn--primary btn--lg' }, [icon('checkCircle', { size: 18 }), '']);
    const declineBtn = el('button', { class: 'btn btn--ghost' }, ['']);

    const answeredCount = () =>
      MY_QUESTIONS.filter((q) => {
        const v = answers[q.key];
        return Array.isArray(v) ? v.length > 0 : v != null && v !== '';
      }).length;

    function refreshProgress() {
      const t = UI[L];
      progress.replaceChildren(
        el('div', { class: 'survey-progress-bar' }, [
          el('span', { style: `width:${Math.round((answeredCount() / MY_QUESTIONS.length) * 100)}%` }),
        ]),
        el('span', { class: 'survey-progress-text' }, [t.progress(answeredCount(), MY_QUESTIONS.length)]),
      );
    }

    /** One question: its text and its options as big tap targets. */
    function questionNode(q) {
      const t = UI[L];
      const isMulti = q.type === 'multi';
      const group = el('div', { class: 'survey-options' + (q.options.length > 6 ? ' survey-options--dense' : '') });

      const isChosen = (v) => (isMulti ? (answers[q.key] || []).includes(v) : answers[q.key] === v);

      q.options.forEach((o) => {
        const btn = el('button', {
          type: 'button',
          class: 'survey-opt' + (isChosen(o.value) ? ' is-on' : ''),
          'aria-pressed': isChosen(o.value) ? 'true' : 'false',
          onClick: () => {
            if (isMulti) {
              const cur = new Set(answers[q.key] || []);
              // "None" and "Prefer not to answer" are answers ABOUT the list, so
              // they replace it rather than joining it — otherwise a record can
              // say both "no assistance" and "SNAP".
              const exclusive = o.value === 'none' || o.value === 'pna';
              if (cur.has(o.value)) cur.delete(o.value);
              else if (exclusive) { cur.clear(); cur.add(o.value); }
              else { cur.delete('none'); cur.delete('pna'); cur.add(o.value); }
              if (cur.size) answers[q.key] = [...cur]; else delete answers[q.key];
            } else {
              // Tapping the chosen answer again clears it: the only way back to
              // "no answer" on a question somebody would rather leave blank.
              if (answers[q.key] === o.value) delete answers[q.key];
              else answers[q.key] = o.value;
            }
            paintQuestion(q, group);
            refreshProgress();
          },
        }, [el('span', { class: 'survey-opt-box' }), el('span', {}, [o[L] || o.en])]);
        group.append(btn);
      });

      return el('div', { class: 'survey-q', id: `q-${q.key}` }, [
        el('div', { class: 'survey-q-head' }, [
          el('span', { class: 'survey-q-text' }, [q[L] || q.en]),
          el('span', { class: 'survey-q-opt' }, [t.optional]),
        ]),
        (L === 'es' ? q.hintEs : q.hintEn)
          ? el('p', { class: 'survey-q-hint' }, [L === 'es' ? q.hintEs : q.hintEn]) : null,
        group,
      ]);
    }

    /** Repaint one question's buttons in place — never the whole form, which
        would scroll the patient back to the top on every tap. */
    function paintQuestion(q, group) {
      const isMulti = q.type === 'multi';
      const isChosen = (v) => (isMulti ? (answers[q.key] || []).includes(v) : answers[q.key] === v);
      [...group.children].forEach((btn, i) => {
        const on = isChosen(q.options[i].value);
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    function paint() {
      const t = UI[L];
      finishBtn.replaceChildren(icon('checkCircle', { size: 18 }), el('span', {}, [t.done]));
      declineBtn.replaceChildren(el('span', {}, [t.decline]));
      body.replaceChildren(
        el('div', { class: 'survey-lede' }, [
          el('p', {}, [t.lede]),
          el('p', { class: 'survey-privacy' }, [icon('lock', { size: 14 }), el('span', {}, [t.privacy])]),
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
            el('h2', {}, [UI[L].title]),
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
  // About the CHECK-OUT half only — that is what this desk is being asked for.
  // The registration half was taken hours earlier by a different person.
  if (!sv || !sv.exit_status) return { key: 'none', label: 'Not yet taken', pill: 'pill--warning' };
  if (sv.exit_status === 'declined') return { key: 'declined', label: 'Patient declined', pill: 'pill--neutral' };
  const mine = questionsForStage('exit');
  const n = mine.filter((q) => {
    const v = (sv.answers || {})[q.key];
    return Array.isArray(v) ? v.length > 0 : v != null && v !== '';
  }).length;
  return { key: 'done', label: `Completed · ${n} of ${mine.length} answered`, pill: 'pill--success' };
}
