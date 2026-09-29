import { el, clear, mount, toast, modal } from '../dom.js';
import { t, languageList } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { statusPill } from './dashboard.js';
import { sortedByName } from '../patientSort.js';
import { openExitSurvey, surveyStatus } from '../components/exitSurvey.js';
import { QUESTIONS as SURVEY_QUESTIONS } from '../../i18n/exitSurvey.js';
import { scanBox } from '../components/wristband.js';

const fmtWhen = (ts) => { if (!ts) return '—'; const d = new Date(ts); return isNaN(d) ? String(ts) : d.toLocaleString(); };

// Check-Out view (F16): verify the provider finished their notes before
// dismissing the patient; upload/clear the USB drive at checkout (F19).
export function renderCheckout(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else queue();
  return root;

  async function usbBar() {
    return el('div', { class: 'inline-row' }, [
      el('button', { class: 'btn btn--ghost btn--sm', onClick: async () => {
        try { const r = await api.usbUploadCheckout(); if (r.uploaded != null) toast(`Uploaded ${r.uploaded} patient file(s) from USB`, 'success'); queue(); } catch (e) { toast(e.message, 'error'); }
      } }, [icon('usb', { size: 15 }), 'Upload USB to database']),
      el('button', { class: 'btn btn--ghost btn--sm', onClick: async () => {
        const ok = await modal({ title: 'Clear USB drive?', body: 'This deletes the Mission Minded patient folder(s) on the chosen drive so it can be reused.', confirmText: 'Clear drive', cancelText: 'Cancel', danger: true });
        if (!ok) return;
        try { const r = await api.usbClear(); toast(`Cleared ${r.cleared} folder(s)`, 'success'); } catch (e) { toast(e.message, 'error'); }
      } }, [icon('trash', { size: 15 }), 'Clear USB']),
    ]);
  }

  async function queue() {
    ctx.setDetail && ctx.setDetail(false);
    // listPatients returns the queue rows; the survey lives on the full record,
    // so fetch it for the ones that can still be checked out. Done together
    // rather than one at a time, so a queue of thirty is one round trip's worth
    // of waiting rather than thirty.
    const patients = await api.listPatients({});
    const ready = sortedByName(patients.filter((p) => p.status === 'completed'));
    const done = sortedByName(patients.filter((p) => p.status === 'dismissed'));
    (await Promise.all(ready.map((p) => api.getPatient(p.id).catch(() => null))))
      .forEach((full, i) => { if (full) ready[i].exit_survey = full.exit_survey; });
    const rowFor = (p) => {
      const isDone = p.status === 'dismissed';
      // One-tap tick: check a patient out straight from the list. Opening the
      // record to review first is still there, but a desk working through a
      // queue of finished patients shouldn't have to open each one.
      // The one-tap tick opens the survey first when it has not been taken,
      // rather than being disabled — the desk's next action is the same either
      // way, and a dead button with no explanation is how this gets worked
      // around instead of used.
      const needsSurvey = !(p.exit_survey && p.exit_survey.exit_status);
      const tickBtn = el('button', {
        class: 'btn btn--sm tick-btn ' + (needsSurvey ? 'btn--primary' : 'btn--success'),
        title: needsSurvey ? `Exit survey for ${p.first_name}` : `Check ${p.first_name} out`,
        onClick: async (e) => {
          e.stopPropagation();
          if (needsSurvey) { const r = await takeSurvey(p); if (!r) return; }
          await dismiss(p);
        },
      }, [icon(needsSurvey ? 'clipboard' : 'checkCircle', { size: 15 }), needsSurvey ? 'Survey' : 'Check out']);
      return el('tr', { class: isDone ? 'row--done' : '', style: 'cursor:pointer', onClick: () => detail(p.id) }, [
        el('td', {}, [
          isDone ? el('span', { class: 'tick-done', title: 'Checked out' }, [icon('checkCircle', { size: 16 })]) : null,
          el('strong', {}, [`${p.last_name}, ${p.first_name}`]),
        ]),
        el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
        el('td', {}, [p.complaint || '—']),
        el('td', {}, [statusPill(p.status),
          // Green "Left" tag once the patient has actually been checked out.
          isDone ? el('span', { class: 'pill pill--success', style: 'margin-left:6px', title: 'Checked out — the patient has left' }, [el('span', { class: 'pill-dot' }), 'Left']) : null]),
        el('td', {}, [el('div', { class: 'inline-row', style: 'margin:0; justify-content:flex-end' }, [
          isDone ? null : tickBtn,
          el('button', { class: 'btn btn--ghost btn--sm', onClick: (e) => { e.stopPropagation(); detail(p.id); } }, ['Review', icon('chevron', { size: 15 })]),
        ])]),
      ]);
    };
    clear(root);
    mount(root,
      el('div', { class: 'view-head' }, [
        el('div', {}, [el('h1', {}, ['Check-Out']), el('p', { class: 'view-sub' }, [`${ready.length} ready to check out · ${done.length} checked out`])]),
        el('div', { class: 'view-head-actions' }, [el('button', { class: 'btn btn--ghost btn--sm', onClick: queue }, [icon('refresh', { size: 15 }), 'Refresh'])]),
      ]),
      // Scanning the band is the intended way in, the same as the station
      // screens: the patient is standing there holding it, and the queue at the
      // end of the day is the longest one in the building.
      el('div', { style: 'margin-bottom:var(--space-4)' }, [scanBox({ onFound: (pt) => onScan(pt) })]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, [icon('checkCircle', { size: 15 }), 'Ready to check out']),
        el('div', { class: 'data-table-wrap' }, [el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Patient', 'Age', 'Complaint', 'Status', ''].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, ready.length ? ready.map(rowFor) : [el('tr', {}, [el('td', { colspan: 5, class: 'empty' }, ['No patients waiting for check-out.'])])]),
        ])]),
      ]),
      done.length ? el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, ['Checked out today']),
        el('div', { class: 'data-table-wrap' }, [el('table', { class: 'data-table data-table--mini' }, [
          el('tbody', {}, done.map(rowFor)),
        ])]),
      ]) : null,
      // USB tools live below the queue so the dismiss list leads. Collapsed by
      // default to declutter; upload/clear stay fully available inside.
      el('details', { class: 'collapse' }, [
        el('summary', {}, [el('span', { style: 'display:flex; align-items:center; gap:9px;' }, [icon('usb', { size: 15 }), 'USB tools'])]),
        el('div', { class: 'collapse-body' }, [await usbBar()]),
      ]),
    );
  }

  // A scanned band opens that patient's check-out record. The lists above only
  // hold patients whose visit is over, so a band belonging to someone still in
  // the clinic would otherwise scan to nothing at all — the record opens either
  // way, and the toast says which case it is rather than leaving the desk to
  // work it out from a greyed-out button.
  function onScan(p) {
    if (p.status === 'dismissed') {
      toast(`${p.first_name} ${p.last_name} has already been checked out.`, 'info');
    } else if (p.status === 'checked_in') {
      toast(`${p.first_name} ${p.last_name} has not been through the clinic yet — they cannot be checked out.`, 'error');
    }
    detail(p.id);
  }

  async function detail(id) {
    ctx.setDetail && ctx.setDetail(true);
    const p = await api.getPatient(id);
    const tx = p.treatment || {};
    // v1.2.1: locking is optional now — a patient can be checked out once their
    // visit is complete (or even in progress), no forced sign-off/lock required.
    const locked = !!tx.locked;
    const visitComplete = p.status === 'completed' || locked;
    const sv = p.exit_survey;
    const st = surveyStatus(sv);
    // The survey is asked before the patient leaves — once they are out of the
    // door there is no second chance, which is exactly why it has never been
    // collected reliably on paper. Answered or explicitly declined both count;
    // what is blocked is dismissing someone who was never asked.
    const surveyDone = st.key !== 'none';
    const canDismiss = p.status !== 'dismissed' && p.status !== 'checked_in' && surveyDone;
    // One after-care lookup for the whole screen: the block lists it, and the
    // summary button and the email say they carry it only when the summary
    // does (a patient checked out before a chair, or with nothing recorded,
    // gets a summary with no after-care page).
    const acParts = aftercareParts(p);
    const summaryLabel = document.createTextNode('Visit summary PDF');
    acParts.result.then((ac) => { if (ac && ac.appendToRecord) summaryLabel.textContent = 'Visit summary + after-care PDF'; });

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: () => queue() }, [icon('back', { size: 15 }), t('common.back')]),
          el('h1', {}, [`${p.first_name} ${p.last_name}`]),
          el('p', { class: 'view-sub' }, [p.event ? p.event.name : '']),
        ]),
        statusPill(p.status),
      ]),
      el('div', { class: 'split' }, [
        el('div', { class: 'col col--wide' }, [
          el('div', { class: `card ${visitComplete ? '' : 'card--alert'}` }, [
            el('div', { class: 'card-title' }, [icon('clipboard', { size: 15 }), 'Visit review']),
            locked
              ? el('div', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Provider signed off — record locked'])
              : visitComplete
                ? el('div', { class: 'pill pill--success' }, [el('span', { class: 'pill-dot' }), 'Visit marked complete'])
                : el('div', { class: 'pill pill--warning' }, [el('span', { class: 'pill-dot' }), 'Visit still in progress — you can still check the patient out']),
            el('div', { class: 'kv-grid', style: 'margin-top:12px' }, [
              kv('Provider', tx.provider_name), kv('Completed', tx.completed_at ? fmtWhen(tx.completed_at) : '—'),
              kv('Completed by', p.completed_by_name), kv('Dental notes', tx.clinical_notes ? 'Present' : '—'),
            ]),
            tx.clinical_notes ? el('div', { class: 'box', style: 'margin-top:8px' }, [el('span', { class: 'field-label' }, ['Dental notes']), el('p', {}, [tx.clinical_notes])]) : null,
            tx.provider_signature ? el('img', { class: 'sig-locked', src: tx.provider_signature }) : null,
          ]),
        ]),
        el('div', { class: 'col' }, [
          el('div', { class: 'card' }, [
            el('div', { class: 'card-title' }, [icon('checkCircle', { size: 15 }), 'Actions']),
            el('div', { class: 'action-stack' }, [
              // The survey, above the optional artefacts: it is the one thing
              // here that cannot be done after the patient leaves.
              el('div', { class: 'action-stack' }, [
                el('span', { class: 'field-label' }, ['Exit survey']),
                el('div', { class: `pill ${st.pill}` }, [el('span', { class: 'pill-dot' }), st.label]),
                el('button', {
                  class: 'btn btn--block ' + (surveyDone ? 'btn--ghost' : 'btn--primary'),
                  onClick: () => takeSurvey(p),
                }, [icon('clipboard', { size: 16 }), surveyDone ? 'Review or change answers' : 'Hand tablet to patient']),
                // The count comes from the survey itself, so this line cannot
                // go stale again the way "12 questions" did when the survey
                // moved back to check-out in one piece.
                surveyDone ? null : el('p', { class: 'view-sub', style: 'margin-top:6px' }, [`${SURVEY_QUESTIONS.length} questions for MMW\u2019s grant reporting. Anything the patient already answered at registration is filled in for them to check. The patient can decline inside.`]),
              ]),
              aftercareBlock(p, acParts),
              // Optional artefacts, grouped and de-emphasised so they read as
              // secondary to the single primary action below.
              el('div', { class: 'action-stack' }, [
                el('span', { class: 'field-label' }, ['Before dismissing (optional)']),
                // The summary ends with the after-care page once there is care
                // to describe (appendToRecord), so saving or emailing it then
                // hands the patient their instructions too — and the button
                // says so only then.
                el('button', { class: 'btn btn--ghost btn--block', onClick: async () => { try { const r = await api.pdfGenerate(id, 'summary'); if (r && r.saved) toast('Saved: ' + r.path, 'success'); } catch (e) { toast(e.message, 'error'); } } }, [icon('save', { size: 16 }), summaryLabel]),
                p.email
                  ? el('button', { class: 'btn btn--ghost btn--block', onClick: () => emailSummary(p, acParts.result) }, [icon('mail', { size: 16 }), 'Email summary to patient'])
                  : el('div', {}, [
                      el('button', { class: 'btn btn--ghost btn--block', disabled: 'disabled' }, [icon('mail', { size: 16 }), 'Email summary to patient']),
                      el('p', { class: 'view-sub', style: 'margin-top:6px' }, ['No email on file.']),
                    ]),
              ]),
              // Primary action — the climax: last, prominent, on its own.
              p.status === 'dismissed'
                ? el('div', { class: 'pill pill--neutral', style: 'margin-top:8px' }, [`Dismissed by ${p.dismissed_by_name || '—'} · ${fmtWhen(p.dismissed_at)}`])
                : el('button', { class: 'btn btn--primary btn--block', style: 'margin-top:8px', disabled: canDismiss ? null : 'disabled', title: p.status === 'checked_in' ? 'This patient has not been through the clinic yet — there is nothing to check them out of' : surveyDone ? null : 'Take the exit survey first — the patient may decline it', onClick: () => dismiss(p) }, [icon('checkCircle', { size: 16 }), 'Verify & dismiss patient']),
            ]),
          ]),
        ]),
      ]),
    );
  }

  // After-care: the instructions the patient takes home, chosen from what was
  // done at the chair (src/main/aftercare.js), printed in the patient's own
  // language when there is a version in it. Printing is optional and never
  // stands between the desk and "Verify & dismiss": the survey already holds
  // the desk, and a printer out of paper must not hold a patient.
  //
  // The list of sections is fetched after the card is drawn and a failure only
  // says so, so a slow or refused lookup can never blank the check-out screen.
  // Shared by the Actions card and the dismiss confirmation, so the one-tap
  // tick in the queue shows the desk the same instructions the record does.
  function aftercareParts(p) {
    const lang = p.language || 'en';
    const langName = (code) => ((languageList().find((l) => l.code === code) || {}).label || code);
    const chips = el('div', { class: 'chip-row aftercare-chips' }, [el('span', { class: 'view-sub' }, ['Checking what was done…'])]);
    const note = el('p', { class: 'view-sub aftercare-note', style: 'margin-top:2px' });
    const printBtn = el('button', { class: 'btn btn--ghost btn--block', type: 'button', onClick: () => printAftercare(p, lang) }, [icon('print', { size: 16 }), 'Print after-care']);
    // Offered only when the sheet would otherwise print in another language —
    // for a patient whose language has no version yet it prints in English
    // anyway, and a second button doing the same would only confuse.
    const englishBtn = el('button', { class: 'btn btn--ghost btn--block', type: 'button', style: lang === 'en' ? 'display:none' : null, onClick: () => printAftercare(p, 'en') }, [icon('print', { size: 16 }), 'Print in English']);
    // `result` is the after-care as looked up (null if the lookup failed), for
    // anything else on the screen that has to say whether it carries it.
    const result = api.aftercareGet(p.id, lang).then((ac) => {
      chips.replaceChildren(...ac.sections.map((x) => el('span', { class: 'pill pill--info', dataset: { key: x.key } }, [x.title_en])));
      note.textContent = [
        stageNote(p, ac),
        ac.fellBack ? `Prints in English: there is no ${langName(ac.requested)} version yet.` : ac.lang !== 'en' ? `Prints in ${langName(ac.lang)}, the patient’s language.` : '',
        ac.status === 'draft' ? `Draft wording (${ac.version}) until MMW’s own templates replace it.` : '',
      ].filter(Boolean).join(' ');
      englishBtn.style.display = ac.lang !== 'en' ? '' : 'none';
      return ac;
    }).catch(() => {
      chips.replaceChildren(el('span', { class: 'view-sub' }, ['Could not list the instructions here — Preview shows the sheet.']));
      return null;
    });
    return { lang, chips, note, printBtn, englishBtn, result };
  }

  // Why the list is what it is. A patient examined at Dental Triage and parked
  // for a chair has a chart of PLANNED work, which the sheet leaves out; a
  // patient still at a chair has what is charted so far.
  function stageNote(p, ac) {
    if (ac.stage === 'not_treated') {
      if (p.status === 'treatment_waiting') return 'Examined at Dental Triage and still waiting for a treatment chair — the treatment is not done yet, so only the general advice will print.';
      if (p.status === 'dismissed') return 'Checked out before reaching a treatment chair — nothing charted was done, so the sheet carries only the general advice.';
      return 'Not yet at a treatment chair, so only the general advice will print.';
    }
    if (!ac.keys.length) return 'No procedure is recorded for this visit, so the sheet carries only the general advice.';
    if (ac.stage === 'in_progress') return 'Visit still in progress: these are the procedures charted so far — check with the dentist that they were done before printing.';
    return '';
  }

  function aftercareBlock(p, a) {
    return el('div', { class: 'action-stack' }, [
      el('span', { class: 'field-label' }, ['After-care instructions']),
      a.chips,
      a.note,
      a.printBtn,
      a.englishBtn,
      el('button', { class: 'btn btn--ghost btn--block', onClick: () => previewAftercare(p, a.lang) }, [icon('eye', { size: 16 }), 'Preview']),
    ]);
  }

  async function printAftercare(p, lang) {
    try { const r = await api.pdfPrint(p.id, 'aftercare', lang); if (r && r.printed) toast('After-care sent to the printer', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function previewAftercare(p, lang) {
    try {
      const dataUrl = await api.pdfPreview(p.id, 'aftercare', lang);
      await modal({ title: 'After-care instructions', body: el('iframe', { class: 'pdf-frame', src: dataUrl }), confirmText: t('common.close') });
    } catch (e) { toast(e.message, 'error'); }
  }

  // Hand the device over. Resolves to the saved survey, or null if it was
  // closed without finishing — in which case nothing was written and the desk
  // can try again.
  async function takeSurvey(p) {
    const full = p.exit_survey !== undefined ? p : await api.getPatient(p.id);
    const saved = await openExitSurvey(full, {
      // Open in the language the patient registered in, so the common case
      // needs no switching; the patient can still change it themselves.
      lang: full.language === 'es' ? 'es' : 'en',
      existing: full.exit_survey,
      stage: 'exit',
    });
    if (saved) { if (params.id) detail(p.id); else queue(); }
    return saved;
  }

  // The last moment before the patient leaves — and, from the one-tap tick in
  // the queue, the only one: that path never opens the record. So the
  // confirmation lists the after-care that applies and offers to print it,
  // without waiting on it: confirming dismisses whether or not anything was
  // printed. Built from text nodes, never markup, since it carries the name.
  async function dismiss(p) {
    const a = aftercareParts(p);
    const body = el('div', { class: 'dismiss-confirm' }, [
      el('p', {}, [`Confirm that ${p.first_name} ${p.last_name}’s treatment and notes are complete, and dismiss them.`]),
      el('div', { class: 'action-stack', style: 'margin-top:12px' }, [
        el('span', { class: 'field-label' }, ['After-care instructions (optional)']),
        a.chips,
        a.note,
        a.printBtn,
        a.englishBtn,
      ]),
    ]);
    const ok = await modal({ title: 'Dismiss patient?', body, confirmText: 'Verify & dismiss', cancelText: 'Cancel' });
    if (!ok) return;
    try { await api.dismissPatient(p.id); toast('Patient dismissed', 'success'); queue(); } catch (e) { toast(e.message, 'error'); }
  }

  // Email the visit summary to the patient. mailto cannot auto-attach a file
  // cross-platform, so we save the summary PDF first and the user attaches it in
  // their email program — same offline flow as records.js emailRecord.
  async function emailSummary(p, acResult) {
    if (!p.email) return;
    const ok = await modal({
      title: 'Email summary to patient', cancelText: 'Cancel', confirmText: 'Open email',
      body: `This saves the summary PDF and opens your email program addressed to <b>${p.email}</b>. Attach the saved PDF before sending.`,
    });
    if (!ok) return;
    // The message goes to the patient, so it is in their language where the
    // after-care sheet is (the same rule as the survey); the PDF carries the
    // instructions themselves — when it does. The summary has an after-care
    // page only once there is care to describe (appendToRecord), so the
    // message promises one only then.
    const ac = acResult ? await acResult.catch(() => null) : null;
    const withCare = !!(ac && ac.appendToRecord);
    const es = p.language === 'es';
    const subject = es ? 'Su resumen de la visita a Mission Minded' : 'Your Mission Minded visit summary';
    const body = es
      ? `Adjunto está el resumen de su visita a Mission Minded Worldwide${withCare ? ', con sus instrucciones de cuidado' : ''}.`
      : `Your visit summary from Mission Minded Worldwide is attached${withCare ? ', with your after-care instructions' : ''}.`;
    try {
      const r = await api.pdfGenerate(p.id, 'summary');
      if (r && r.saved) {
        await api.openExternal(`mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
        toast('Summary saved — attach it in your email program.', 'success');
      }
    } catch (e) { toast(e.message, 'error'); }
  }

  function kv(label, val) { return el('div', { class: 'kv' }, [el('span', { class: 'kv-label' }, [label]), el('span', { class: 'kv-val' }, [val || '—'])]); }
}
