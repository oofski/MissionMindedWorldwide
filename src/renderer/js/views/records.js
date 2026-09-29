import { el, clear, toast, modal } from '../dom.js';
import { t, languageList } from '../i18n.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { statusPill } from './dashboard.js';
import { incompleteBanner, patientInfoCards, historyReviewText } from '../components/patientHistory.js';
import { lockBanner, adminLockButtons, lockHistoryList, lockedByText } from '../components/recordLock.js';
import { bloodThinnerText, bpStatus } from '../medFlags.js';
import { sortedByName } from '../patientSort.js';
import { hasReferralOut } from '../../i18n/dentalLists.js';

// Reconciled vitals + blood-thinner shown ON-SCREEN in the record, the same way
// the EMT/dentist screens and the PDF do — so the record can't silently disagree
// with the report it exports.
function recVitals(p) {
  const tr = p.triage || {};
  if (tr.bp_systolic == null && tr.bp_diastolic == null && tr.heart_rate == null && tr.glucose == null && tr.respiration == null) return el('span', { class: 'muted' }, ['Not recorded']);
  const parts = [];
  const bp = bpStatus(tr.bp_systolic, tr.bp_diastolic);
  if (tr.bp_systolic != null || tr.bp_diastolic != null) {
    parts.push(el('span', { class: bp.high ? 'pill pill--red' : 'small' }, [`BP ${tr.bp_systolic != null ? tr.bp_systolic : '—'}/${tr.bp_diastolic != null ? tr.bp_diastolic : '—'}${bp.high ? ' — HIGH' : ''}`]));
  }
  (Array.isArray(tr.bp_rechecks) ? tr.bp_rechecks : []).forEach((r) => {
    const st = bpStatus(r.bp_systolic, r.bp_diastolic);
    parts.push(el('span', { class: st.high ? 'pill pill--red' : 'small' }, [`re-check ${r.bp_systolic != null ? r.bp_systolic : '—'}/${r.bp_diastolic != null ? r.bp_diastolic : '—'}${st.high ? ' — HIGH' : ''}`]));
  });
  if (tr.heart_rate != null) parts.push(el('span', { class: 'small' }, [`HR ${tr.heart_rate}`]));
  // Blood sugar and respiration, which Vitals has recorded all along.
  if (tr.glucose != null) parts.push(el('span', { class: 'small' }, [`BS ${tr.glucose} mg/dL`]));
  if (tr.respiration != null) parts.push(el('span', { class: 'small' }, [`RESP ${tr.respiration}/min`]));
  return el('div', { class: 'chip-row' }, parts);
}
function recThinner(p) {
  const bt = bloodThinnerText(p);
  const cls = bt.level === 'danger' ? 'pill pill--red' : (bt.level === 'ok' ? 'pill pill--success' : 'muted');
  return el('span', { class: cls }, [bt.text]);
}

export function renderRecords(ctx, params = {}) {
  const root = el('div', { class: 'view' });
  if (params.id) detail(params.id); else list();
  return root;

  async function list() {
    ctx.setDetail && ctx.setDetail(false);
    const events = await api.listEvents();
    const searchInput = el('input', { class: 'input search-input', placeholder: 'Search by name, DOB, phone…' });
    const allInput = el('input', { class: 'input search-input', placeholder: 'Returning patient lookup (all events)…' });
    // Default to ALL events so records are always visible regardless of which
    // event is currently active.
    const eventSel = el('select', { class: 'input select' });
    eventSel.append(el('option', { value: 'all' }, ['All events']));
    events.forEach((e) => eventSel.append(el('option', { value: String(e.id) }, [`${e.name} (${e.patient_count})`])));
    const tbody = el('tbody', {});

    async function refresh() {
      const eventId = eventSel.value === 'all' ? 'all' : Number(eventSel.value);
      const patients = sortedByName(await api.listPatients({ eventId, search: searchInput.value.trim() }));
      clear(tbody);
      if (!patients.length) tbody.append(el('tr', {}, [el('td', { colspan: 6, class: 'empty' }, ['No matching records.'])]));
      patients.forEach((p) => tbody.append(el('tr', {}, [
        el('td', {}, [el('strong', {}, [`${p.last_name}, ${p.first_name}`])]),
        el('td', {}, [p.dob || '—']),
        el('td', { class: 'num' }, [p.age != null ? String(p.age) : '—']),
        el('td', { class: 'subtle small' }, [p.event_name || '—']),
        el('td', {}, [statusPill(p.status)]),
        el('td', {}, [el('button', { class: 'btn btn--ghost btn--sm', onClick: () => detail(p.id) }, ['Open'])]),
      ])));
    }
    searchInput.addEventListener('input', debounce(refresh, 200));
    eventSel.addEventListener('change', refresh);

    const allResults = el('div', { class: 'lookup-results' });
    allInput.addEventListener('input', debounce(async () => {
      const term = allInput.value.trim();
      clear(allResults);
      if (term.length < 2) return;
      const res = await api.searchAll(term);
      if (!res.length) { allResults.append(el('div', { class: 'muted' }, ['No prior records found.'])); return; }
      res.forEach((r) => allResults.append(el('button', { class: 'lookup-item', onClick: () => detail(r.id) }, [
        el('strong', {}, [`${r.last_name}, ${r.first_name}`]),
        el('span', { class: 'muted' }, [` ${r.dob || ''} · ${r.event_name}`]),
      ])));
    }, 250));

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [el('div', {}, [el('h1', {}, [t('nav.records')]), el('p', { class: 'view-sub' }, ['All patient records across events'])])]),
      el('div', { class: 'card' }, [
        el('div', { class: 'lookup-row' }, [
          el('div', {}, [el('span', { class: 'field-label' }, ['Event']), eventSel]),
          el('div', {}, [el('span', { class: 'field-label' }, ['Search']), searchInput]),
        ]),
        el('div', { style: 'margin-bottom:12px' }, [el('span', { class: 'field-label' }, ['Returning patient lookup (all events)']), allInput, allResults]),
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [el('tr', {}, ['Patient', 'DOB', 'Age', 'Event', 'Status', ''].map((h) => el('th', {}, [h])))]),
            tbody,
          ]),
        ]),
      ]),
    );
    refresh();
  }

  async function detail(id) {
    ctx.setDetail && ctx.setDetail(true);
    const p = await api.getPatient(id);
    const tr = p.triage || {};
    const lk = p.lock || {};

    const kv = (label, val) => el('div', { class: 'kv' }, [el('span', { class: 'kv-label' }, [label]), el('span', { class: 'kv-val' }, [val || '—'])]);

    // F20 — History / accountability. By-name fields come from getPatient; the
    // detailed audit log is fetched lazily into the table below.
    const when = (w) => (w ? ' · ' + new Date(w).toLocaleString() : '');
    const accountabilityRows = [
      ['Triaged by', p.triaged_by_name],
      ['Vitals by', p.vitals_by_name],
      // Who went through the medical history with the patient at this visit.
      ['History reviewed by', historyReviewText(p) ? `${tr.history_reviewed_by_name || '—'}${when(tr.history_reviewed_at)}` : null],
      ['Completed by', p.completed_by_name],
      ['Locked by', lk.locked ? lockedByText(p).replace(/^Locked by /, '') : null],
      ['Unlocked by', lk.unlocked_at ? `${lk.unlocked_by_name || '—'}${when(lk.unlocked_at)}${lk.unlock_reason ? ' — ' + lk.unlock_reason : ''}` : null],
      ['Checked out by', p.dismissed_by_name ? `${p.dismissed_by_name}${when(p.dismissed_at)}` : null],
    ].filter(([, v]) => v);
    const auditBody = el('tbody', {}, [el('tr', {}, [el('td', { colspan: 4, class: 'subtle small' }, ['Loading history…'])])]);
    const auditCard = el('div', { class: 'card' }, [
      el('h3', { class: 'card-title' }, [icon('clipboard', { size: 16 }), 'History / accountability']),
      accountabilityRows.length ? el('div', { class: 'kv-grid' }, accountabilityRows.map(([l, v]) => kv(l, v))) : null,
      el('div', { class: 'data-table-wrap', style: 'margin-top:10px' }, [
        el('table', { class: 'data-table data-table--mini' }, [
          el('thead', {}, [el('tr', {}, ['Who', 'Action', 'Detail', 'When'].map((h) => el('th', {}, [h])))]),
          auditBody,
        ]),
      ]),
    ]);
    api.patientAudit(id).then((rows) => {
      clear(auditBody);
      if (!rows || !rows.length) {
        auditBody.append(el('tr', {}, [el('td', { colspan: 4, class: 'subtle small' }, ['No history recorded.'])]));
        return;
      }
      rows.forEach((r) => auditBody.append(el('tr', {}, [
        el('td', {}, [r.user_name || '—']),
        el('td', {}, [el('span', { class: 'pill pill--info' }, [`${r.action || '—'}${r.entity ? ' · ' + r.entity : ''}`])]),
        el('td', { class: 'subtle small' }, [r.detail || '—']),
        el('td', { class: 'subtle small' }, [r.created_at ? new Date(r.created_at).toLocaleString() : '—']),
      ])));
    }).catch((e) => {
      clear(auditBody);
      auditBody.append(el('tr', {}, [el('td', { colspan: 4, class: 'subtle small' }, [e.message || 'Could not load history.'])]));
    });

    clear(root);
    root.append(
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: () => ctx.navigate('records') }, [icon('back', { size: 15 }), t('common.back')]),
          el('h1', {}, [`${p.first_name} ${p.last_name}`]),
          el('p', { class: 'view-sub' }, [`${p.event ? p.event.name : ''} · ${languageLabel(p.language)}`]),
        ]),
        statusPill(p.status),
      ]),
      incompleteBanner(p, {
        isAdmin: store.is('admin'),
        onDelete: () => deletePatient(p),
        onNewCheckin: () => ctx.navigate('kiosk'),
      }),
      lockBanner(p, { onChanged: () => detail(id) }),
      el('div', { class: 'split' }, [
        el('div', { class: 'col col--wide' }, [
          // The patient's information, medical and dental history and consents
          // are the chart's own cards (components/patientHistory.js), so Records
          // cannot show a patient differently from the screens they were
          // treated on — and they are edited here the way they are everywhere,
          // one section at a time by the roles allowed to (this replaces the
          // administrator-only "Edit patient details", which could not reach
          // City, State, race, services or either history).
          patientInfoCards(p, {
            stack: true,
            emptyConsents: true,
            // Records adds what Vitals measured to the medical card.
            medicalExtras: (cp) => [
              el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Vitals']), recVitals(cp)]),
              el('div', { class: 'field' }, [el('span', { class: 'field-label' }, ['Blood thinner']), recThinner(cp)]),
            ],
            onSaved: () => detail(id),
          }),
          auditCard,
        ]),
        el('div', { class: 'col' }, [
          el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Export & deliver']),
            exportCard(id, p),
          ]),
          store.is('admin') ? el('div', { class: 'card' }, [
            el('h3', { class: 'card-title' }, ['Admin']),
            // Unlock a signed-off record to amend it (reason required), or lock
            // a finished one; the lock trail below syncs to every station.
            adminLockButtons(p, { onChanged: () => detail(id), size: 'sm', block: true }),
            lockHistoryList(p),
            el('button', { class: 'btn btn--danger btn--block', style: 'margin-top:8px', onClick: () => deletePatient(p) }, [icon('trash', { size: 16 }), 'Delete patient record']),
          ]) : null,
        ]),
      ]),
    );
  }

  async function deletePatient(p) {
    const ok = await modal({
      title: 'Delete patient record?',
      body: `This permanently deletes <b>${p.first_name} ${p.last_name}</b> and all of their intake, triage, treatment, x-rays, and consents. This cannot be undone.`,
      confirmText: 'Delete permanently', cancelText: 'Cancel', danger: true,
    });
    if (!ok) return;
    try { await api.deletePatient(p.id); toast('Patient record deleted', 'success'); ctx.navigate('records'); }
    catch (e) { toast(e.message, 'error'); }
  }

  // Streamlined export/deliver block. ONE obvious primary action (save the full
  // record PDF) plus the most common delivery (email, when we have an address);
  // every other format/tool is tucked under "More options" so the panel isn't a
  // wall of near-identical buttons.
  function exportCard(id, p) {
    const run = async (fn) => {
      try { const r = await fn(); if (r && r.saved) toast(`Saved: ${r.path}`, 'success'); else if (r && r.printed) toast('Sent to printer', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    };
    const canUsb = store.can('admin', 'doctor'); // patient-USB export is admin/doctor only (IPC)
    return el('div', { class: 'action-stack' }, [
      el('button', { class: 'btn btn--primary btn--block', onClick: () => run(() => api.pdfGenerate(id, 'full')) }, [icon('save', { size: 16 }), 'Save record PDF']),
      p.email ? el('button', { class: 'btn btn--ghost btn--block', onClick: () => emailRecord(p) }, [icon('mail', { size: 16 }), 'Email to patient']) : null,
      el('details', { class: 'collapse', style: 'margin-top:4px' }, [
        el('summary', { style: 'font-size:var(--fs-base)' }, ['More options']),
        el('div', { class: 'collapse-body action-stack' }, [
          el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfGenerate(id, 'progress')) }, [icon('clipboard', { size: 16 }), 'Progress note PDF']),
          el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfGenerate(id, 'summary')) }, [icon('user', { size: 16 }), 'Patient summary PDF']),
          // The after-care sheet on its own, in the patient's language — for a
          // patient who lost theirs, or a record amended after they left.
          el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfGenerate(id, 'aftercare')) }, [icon('clipboard', { size: 16 }), 'After-care instructions PDF']),
          el('button', { class: 'btn btn--ghost btn--block', onClick: () => preview(id) }, [icon('eye', { size: 16 }), 'Preview PDF']),
          el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.pdfPrint(id, 'full')) }, [icon('print', { size: 16 }), 'Print']),
          el('button', { class: 'btn btn--ghost btn--block', onClick: () => screenDisplay(p) }, [icon('phone', { size: 16 }), 'Screen display for photo']),
          canUsb ? el('button', { class: 'btn btn--ghost btn--block', onClick: () => run(() => api.exportRecordUsb(id)) }, [icon('upload', { size: 16 }), 'Save to patient USB']) : null,
        ]),
      ]),
    ]);
  }

  async function preview(id) {
    try {
      const dataUrl = await api.pdfPreview(id, 'full');
      const frame = el('iframe', { class: 'pdf-frame', src: dataUrl });
      await modal({ title: 'Record preview', body: frame, confirmText: t('common.close') });
    } catch (e) { toast(e.message, 'error'); }
  }

  async function screenDisplay(p) {
    // Whether the chart is care done is the printed record's rule
    // (aftercare.careStage), read through the one channel that carries it, so
    // this screen and the patient's Visit Summary say the same thing. Should
    // that fail, only a completed visit is taken as treated.
    const stage = await api.aftercareGet(p.id, 'en').then((ac) => ac.stage)
      .catch(() => (p.status === 'completed' || (p.treatment && p.treatment.completed_at) ? 'treated' : 'not_treated'));
    const big = el('div', { class: 'screen-display' }, [
      el('div', { class: 'sd-name' }, [`${p.first_name} ${p.last_name}`]),
      el('div', { class: 'sd-row' }, [el('span', {}, ['DOB']), el('b', {}, [p.dob || '—'])]),
      el('div', { class: 'sd-row' }, [el('span', {}, ['Event']), el('b', {}, [p.event ? p.event.name : '—'])]),
      el('div', { class: 'sd-row' }, [el('span', {}, ['Treatment']), el('b', {}, [treatmentSummary(p, stage)])]),
      // MMW's number — the one the after-care sheet prints (src/main/aftercare.js
      // CONTACT) and the harness pins. Until v0.0.15 this showed an Oregon
      // number left over from the clinic the app was first built for. It is a
      // message line, not an emergency service, so it is labelled for what it
      // is; the after-care sheet sends a true emergency to the ER.
      el('div', { class: 'sd-row' }, [el('span', {}, ['Problems after your visit']), el('b', {}, ['(951) 317-4968'])]),
      el('div', { class: 'sd-hint' }, ['Take a photo of this screen with your phone']),
    ]);
    modal({ title: '', body: big, confirmText: t('common.close') });
  }

  async function emailRecord(p) {
    const ok = await modal({
      title: 'Email record', cancelText: 'Cancel', confirmText: 'Open email',
      body: `This will save a PDF and open your email program addressed to <b>${p.email}</b>. Attach the saved PDF before sending. (Email requires brief internet access.)`,
    });
    if (!ok) return;
    try {
      const r = await api.pdfGenerate(p.id, 'full');
      if (r.saved) {
        await api.openExternal(`mailto:${p.email}?subject=${encodeURIComponent('Your Mission Minded dental record')}&body=${encodeURIComponent('Your dental record from Mission Minded Worldwide is attached.')}`);
        toast('PDF saved — attach it in your email program.', 'success');
      }
    } catch (e) { toast(e.message, 'error'); }
  }
}

// F18 — resolve a stored language code to its native name (en/es/ru/bzj/nya).
function languageLabel(code) {
  const l = languageList().find((x) => x.code === code);
  return l ? l.native : (code || 'English');
}

// What the patient photographs as their treatment. A visit not completed at a
// treatment chair (stage 'not_treated': waiting for one, or checked out while
// the record placed them before one) lists its chart as not confirmed, as the
// Visit Summary heads it and the Previous visits table lists it
// (db.patientHistory) — never as treatment given, and never as "not done",
// which the record cannot know either.
function treatmentSummary(p, stage) {
  const tx = p.treatment || {};
  const parts = [];
  if ((tx.fillings || []).length) parts.push(`${tx.fillings.length} filling(s)`);
  if ((tx.extractions || []).length) parts.push(`${tx.extractions.length} extraction(s)`);
  // The teeth tapped on the chart and the quadrant note are not a cleaning —
  // every dentist save stores teeth: [], which used to read as one here.
  if (Object.entries(tx.cleaning || {}).some(([k, v]) => v && k !== 'teeth' && k !== 'quad_detail')) parts.push('cleaning');
  const referred = hasReferralOut(tx.referral_out);
  // A referral is written at Dental Triage when it is made, so it is not part
  // of what the chart leaves unconfirmed.
  if (stage === 'not_treated' && parts.length) {
    return `Charted, not confirmed as done: ${parts.join(', ')}${referred ? '; referred' : ''}`;
  }
  if (referred) parts.push('referred');
  return parts.join(', ') || 'See provider';
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
