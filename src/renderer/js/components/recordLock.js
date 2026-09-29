// The record lock, as every station shows it and as an administrator works it.
//
// A locked record is the one a provider signed as final. Until v0.0.15 a lock
// said nothing about who locked it, and the only way back out was an admin
// MOVE that unlocked it as a side effect, with no trace. Now an administrator
// unlocks a record on purpose, with a reason, without moving the patient, and
// re-locks it when the correction is made — and every station says who did
// what (getPatient's `lock`, synced on the treatment row).

import { el, toast, modal } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { store } from '../store.js';

const fmtWhen = (w) => { if (!w) return ''; const d = new Date(w); return isNaN(d.getTime()) ? String(w) : d.toLocaleString(); };
const isAdmin = () => !!(store.user && store.user.role === 'admin');

// A full record (getPatient) carries `lock`; a list row (listPatients) carries
// only `locked` / `amending` / `lockable`. Both read the same here.
function lockOf(p) {
  if (p && p.lock) return p.lock;
  return { locked: !!(p && p.locked), amending: !!(p && p.amending), lockable: !!(p && p.lockable), history: [] };
}

/** "Locked by Dr. X · 10/18/2026, 3:04 PM", or '' for an unlocked record. */
export function lockedByText(p) {
  const l = lockOf(p);
  if (!l.locked) return '';
  const when = fmtWhen(l.locked_at);
  return `Locked by ${l.locked_by_name || '—'}${when ? ' · ' + when : ''}`;
}

/** "Unlocked by X on <date>: <reason>" for a record being amended, else ''. */
export function amendingText(p) {
  const l = lockOf(p);
  if (!l.amending) return '';
  return `Amending a signed-off record — unlocked by ${l.unlocked_by_name || '—'}${l.unlocked_at ? ' on ' + fmtWhen(l.unlocked_at) : ''}${l.unlock_reason ? ': ' + l.unlock_reason : ''}`;
}

/**
 * Ask an administrator why a record is being unlocked, then unlock it.
 * A dialog of its own rather than dom.modal, which closes on confirm and so
 * cannot refuse an empty reason and stay open. Resolves to the updated record,
 * or null when cancelled.
 */
export function unlockRecord(p) {
  return new Promise((resolve) => {
    const reason = el('textarea', { class: 'input textarea', rows: 3, placeholder: 'e.g. Wrong tooth number recorded for the extraction' });
    const overlay = el('div', { class: 'modal-overlay unlock-dialog' });
    const done = (v) => { overlay.remove(); resolve(v); };
    const go = el('button', { class: 'btn btn--primary', type: 'button' }, [icon('unlock', { size: 15 }), 'Unlock to amend']);
    go.addEventListener('click', async () => {
      const why = reason.value.trim();
      if (!why) { toast('Required: say why the record is being unlocked — the reason is kept with the record.', 'error'); reason.focus(); return; }
      go.disabled = true;
      try {
        const np = await api.unlockRecord(p.id, why);
        toast('Record unlocked for amendment', 'success');
        done(np);
      } catch (e) { toast(e.message, 'error'); go.disabled = false; }
    });
    overlay.append(el('div', { class: 'modal-card' }, [
      el('h3', { class: 'modal-title' }, ['Unlock this signed-off record?']),
      el('div', { class: 'modal-body' }, [
        el('p', {}, ['The record becomes editable again so it can be corrected. The patient stays where they are, and the unlock — who, when and why — is kept with the record. Lock it again once the correction is made.']),
        el('label', { class: 'field', style: 'margin-top:10px' }, [
          el('span', { class: 'field-label' }, ['Reason for unlocking', el('em', { class: 'req' }, [' *'])]), reason,
        ]),
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => done(null) }, ['Cancel']),
        go,
      ]),
    ]));
    document.body.append(overlay);
    reason.focus();
  });
}

/** Lock (or re-lock) a finished record, after a confirmation. */
export async function lockRecord(p) {
  const ok = await modal({
    title: 'Lock this record?',
    body: 'Locking makes the treatment record read-only at every station until an administrator unlocks it.',
    confirmText: 'Lock record', cancelText: 'Cancel',
  });
  if (!ok) return null;
  try {
    const np = await api.lockRecord(p.id);
    toast('Record locked', 'success');
    return np;
  } catch (e) { toast(e.message, 'error'); return null; }
}

// Whether a Lock would be accepted: the data layer's own answer (lockable —
// a treatment row, a finished visit, a provider named), carried on the full
// record and on a list row alike. Deciding from the status here offered every
// finished patient a Lock, walk-outs with no treatment and unsigned records
// included, and each ended in a refusal after the confirmation. A record from
// a caller that did not say is not offered one.
function lockable(p) {
  const l = lockOf(p);
  return !l.locked && l.lockable === true;
}

/**
 * The administrator's Unlock / Lock buttons for a record, or null for anyone
 * else (or when neither applies). onChanged(record) after either succeeds.
 */
export function adminLockButtons(p, { onChanged, size = 'sm', block = false } = {}) {
  if (!isAdmin()) return null;
  const l = lockOf(p);
  const cls = `btn btn--${size}${block ? ' btn--block' : ''}`;
  if (l.locked) {
    return el('button', { class: `${cls} btn--soft`, type: 'button', onClick: async () => { const np = await unlockRecord(p); if (np && onChanged) onChanged(np); } },
      [icon('unlock', { size: 14 }), 'Unlock to amend']);
  }
  if (lockable(p)) {
    return el('button', { class: `${cls} btn--ghost`, type: 'button', onClick: async () => { const np = await lockRecord(p); if (np && onChanged) onChanged(np); } },
      [icon('lock', { size: 14 }), 'Lock record']);
  }
  return null;
}

/**
 * The banner a station shows for a locked record ("Locked by X · date", with
 * Unlock for an administrator) or for one being amended (who unlocked it, when
 * and why, with Lock). `lockedText` is the station's own first sentence.
 */
export function lockBanner(p, { onChanged, lockedText = 'This record is signed off and locked.' } = {}) {
  const l = lockOf(p);
  if (l.locked) {
    return el('div', { class: 'banner banner--locked lock-banner' }, [
      icon('lock', { size: 16 }),
      el('div', {}, [el('div', {}, [lockedText]), el('div', { class: 'subtle small' }, [lockedByText(p)])]),
      adminLockButtons(p, { onChanged }),
    ]);
  }
  if (l.amending) {
    return el('div', { class: 'banner banner--warn lock-banner' }, [
      icon('unlock', { size: 16 }),
      el('div', {}, [amendingText(p)]),
      adminLockButtons(p, { onChanged }),
    ]);
  }
  return null;
}

/** Every lock and unlock of the record, newest first, or null when none. */
export function lockHistoryList(p) {
  const hist = (lockOf(p).history || []).slice().reverse();
  if (!hist.length) return null;
  const ACTION = { lock: 'Locked', relock: 'Re-locked', unlock: 'Unlocked' };
  return el('div', { class: 'field lock-history' }, [
    el('span', { class: 'field-label' }, ['Lock history']),
    el('ul', { class: 'plain-list small' }, hist.map((h) => el('li', {}, [
      `${ACTION[h.action] || h.action} by ${h.by || '—'}${h.at ? ' · ' + fmtWhen(h.at) : ''}${h.reason ? ' — ' + h.reason : ''}`,
    ]))),
  ]);
}
