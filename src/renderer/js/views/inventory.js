// Supplies — what the clinic has, what it is running out of, what it used.
//
// Built around a LEDGER rather than an editable count. "On hand" is the sum of
// everything that has moved, so a wrong number is fixed by recording the
// correction and the history of how it got there survives. A clinic that packs a
// van the night before needs to answer "did we actually use 40 boxes or did we
// leave them behind", and an editable number cannot answer that.
//
// Three questions this screen exists to answer, in the order a clinic asks them:
//   What are we out of RIGHT NOW          -> the alert band, first thing on screen
//   What do we need to restock            -> the low list and the par levels
//   What did this clinic consume          -> used-here, per event

import { el, clear, mount, toast, modal, withBusy } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { textField, selectField } from '../forms.js';
import { ANESTHETICS, ANTIBIOTICS } from '../../i18n/strings.js';

const REASONS = [
  { key: 'received', label: 'Received', sign: +1, hint: 'Stock arriving — a delivery or a donation.' },
  { key: 'used', label: 'Used', sign: -1, hint: 'Consumed at the clinic.' },
  { key: 'wasted', label: 'Wasted / expired', sign: -1, hint: 'Dropped, contaminated or out of date.' },
  { key: 'adjusted', label: 'Correction', sign: 0, hint: 'A recount. Enter the difference, + or −.' },
];

/**
 * A starting list, offered rather than seeded.
 *
 * The anaesthetics and antibiotics are MMW's own drug list, so those rows are
 * the clinic's real formulary rather than a guess. The consumables are the
 * ordinary contents of a portable dental setup and are meant to be edited —
 * every par level here is a placeholder until somebody who packs the van says
 * otherwise.
 */
const STARTER = [
  ...ANESTHETICS.map((a) => ({ name: a.en, category: 'Anaesthetic', unit: 'carpule', par_level: 50 })),
  ...ANTIBIOTICS.map((a) => ({ name: a.en, category: 'Antibiotic', unit: 'course', par_level: 10 })),
  { name: 'Exam gloves — small', category: 'PPE', unit: 'box', par_level: 5 },
  { name: 'Exam gloves — medium', category: 'PPE', unit: 'box', par_level: 8 },
  { name: 'Exam gloves — large', category: 'PPE', unit: 'box', par_level: 5 },
  { name: 'Face masks', category: 'PPE', unit: 'box', par_level: 4 },
  { name: 'Face shields', category: 'PPE', unit: 'each', par_level: 10 },
  { name: 'Gowns', category: 'PPE', unit: 'each', par_level: 20 },
  { name: 'Anaesthetic needles — short', category: 'Anaesthetic', unit: 'box', par_level: 3 },
  { name: 'Anaesthetic needles — long', category: 'Anaesthetic', unit: 'box', par_level: 3 },
  { name: 'Topical anaesthetic gel', category: 'Anaesthetic', unit: 'tube', par_level: 4 },
  { name: 'Gauze 2x2', category: 'Consumable', unit: 'pack', par_level: 10 },
  { name: 'Cotton rolls', category: 'Consumable', unit: 'pack', par_level: 8 },
  { name: 'Saliva ejectors', category: 'Consumable', unit: 'bag', par_level: 4 },
  { name: 'Prophy paste', category: 'Hygiene', unit: 'box', par_level: 3 },
  { name: 'Prophy angles', category: 'Hygiene', unit: 'box', par_level: 3 },
  { name: 'Fluoride varnish', category: 'Hygiene', unit: 'box', par_level: 2 },
  { name: 'Composite — A2', category: 'Restorative', unit: 'syringe', par_level: 4 },
  { name: 'Composite — A3', category: 'Restorative', unit: 'syringe', par_level: 4 },
  { name: 'Bonding agent', category: 'Restorative', unit: 'bottle', par_level: 2 },
  { name: 'Etchant gel', category: 'Restorative', unit: 'syringe', par_level: 3 },
  { name: 'IRM / temporary filling', category: 'Restorative', unit: 'kit', par_level: 2 },
  { name: 'Burs — assorted', category: 'Instrument', unit: 'pack', par_level: 5 },
  { name: 'Extraction forceps set', category: 'Instrument', unit: 'set', par_level: 2 },
  { name: 'Sutures', category: 'Oral surgery', unit: 'box', par_level: 3 },
  { name: 'Sterilisation pouches', category: 'Instrument', unit: 'box', par_level: 4 },
  { name: 'Surface disinfectant wipes', category: 'Consumable', unit: 'tub', par_level: 6 },
  { name: 'Toothbrushes', category: 'Giveaway', unit: 'each', par_level: 100 },
  { name: 'Toothpaste', category: 'Giveaway', unit: 'each', par_level: 100 },
];

/**
 * Plural of a unit of stock.
 *
 * "box" -> "boxes", not "boxs"; "each" is already both. The list of units a
 * clinic actually uses is short, so this handles the real English rather than
 * appending an s and hoping.
 */
// "1 item" / "2 items" — the banner and the subtitle both read as sentences, so
// neither may fall back on "item(s)".
function items_(n) { return n === 1 ? '1 item' : `${n} items`; }

function plural(unit, n) {
  const u = String(unit || '').trim();
  if (!u || Math.abs(n) === 1) return u;
  if (/^(each|gauze|tape)$/i.test(u)) return u;          // already mass or invariant
  if (/(s|x|z|ch|sh)$/i.test(u)) return u + 'es';         // box -> boxes, patch -> patches
  if (/[^aeiou]y$/i.test(u)) return u.slice(0, -1) + 'ies'; // tray -> trays is handled above
  return u + 's';
}

const STATUS = {
  out: { pill: 'pill--danger', label: 'Out' },
  low: { pill: 'pill--warning', label: 'Low' },
  ok: { pill: 'pill--success', label: 'In stock' },
};

export function renderInventory(ctx) {
  const root = el('div', { class: 'view' });
  const isAdmin = store.is('admin');
  let items = [];
  let filter = 'all';   // all | low | out
  let query = '';

  load();
  return root;

  async function load() {
    try {
      items = await api.inventoryList();
    } catch (e) {
      clear(root);
      mount(root, el('div', { class: 'card' }, [el('p', { class: 'muted' }, [e.message || 'Could not load supplies.'])]));
      return;
    }
    paint();
  }

  function visible() {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (filter === 'low' && i.status === 'ok') return false;
      if (filter === 'out' && i.status !== 'out') return false;
      if (q && !(`${i.name} ${i.category || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  /* ---------------- rows ---------------- */

  function row(item) {
    const st = STATUS[item.status];
    // +/- inline, because the moment stock actually moves is while somebody is
    // standing at the supply table, not later at a desk.
    const quick = (delta, reason, title) => el('button', {
      class: 'btn btn--ghost btn--sm', title,
      onClick: async (e) => {
        e.stopPropagation();
        try { await api.inventoryMove({ item_id: item.id, delta, reason }); await load(); }
        catch (err) { toast(err.message, 'error'); }
      },
    }, [delta > 0 ? '+1' : '−1']);

    return el('tr', { class: item.active ? '' : 'row--done', style: 'cursor:pointer', onClick: () => openItem(item) }, [
      el('td', {}, [
        el('strong', {}, [item.name]),
        item.category ? el('div', { class: 'subtle small' }, [item.category]) : null,
      ]),
      el('td', { class: 'num' }, [
        el('strong', { class: 'inv-count' }, [String(item.on_hand)]),
        item.unit ? el('span', { class: 'subtle small' }, [' ' + plural(item.unit, item.on_hand)]) : null,
      ]),
      el('td', { class: 'num subtle small' }, [item.par_level ? String(item.par_level) : '—']),
      el('td', { class: 'num subtle small' }, [item.used_here ? String(item.used_here) : '—']),
      el('td', { class: 'inv-status' }, [el('span', { class: `pill ${st.pill}` }, [el('span', { class: 'pill-dot' }), st.label])]),
      el('td', { class: 'inv-actions' }, [el('div', { class: 'inline-row', style: 'margin:0; justify-content:flex-end; flex-wrap:nowrap' }, [
        quick(-1, 'used', `Record one ${item.unit || 'unit'} used`),
        quick(+1, 'received', `Record one ${item.unit || 'unit'} received`),
        el('button', { class: 'btn btn--ghost btn--sm', onClick: (e) => { e.stopPropagation(); openItem(item); } },
          ['Open', icon('chevron', { size: 15 })]),
      ])]),
    ]);
  }

  /* ---------------- the screen ---------------- */

  function paint() {
    const low = items.filter((i) => i.status === 'low');
    const out = items.filter((i) => i.status === 'out');
    const rows = visible();

    const search = el('input', {
      class: 'input input--sm', placeholder: 'Search supplies…', value: query,
      onInput: (e) => { query = e.target.value; paintBody(); },
    });

    const chip = (key, label, n) => el('button', {
      class: 'chip-btn' + (filter === key ? ' chip-btn--on' : ''),
      onClick: () => { filter = key; paint(); },
    }, [label + (n != null ? ` (${n})` : '')]);

    clear(root);
    mount(root,
      el('div', { class: 'view-head' }, [
        el('div', {}, [
          el('h1', {}, ['Supplies']),
          el('p', { class: 'view-sub' }, [`${items_(items.length)} tracked · counts are the running total of everything recorded`]),
        ]),
        el('div', { class: 'view-head-actions' }, [
          el('button', { class: 'btn btn--ghost btn--sm', onClick: load }, [icon('refresh', { size: 15 }), 'Refresh']),
          isAdmin ? el('button', { class: 'btn btn--primary btn--sm', onClick: () => openItem(null) }, [icon('plus', { size: 15 }), 'Add item']) : null,
        ]),
      ]),

      // What is wrong right now, before anything else on the screen.
      (out.length || low.length) ? el('div', { class: `banner ${out.length ? 'banner--alert' : 'banner--warn'}` }, [
        icon('alert', { size: 16 }),
        el('span', {}, [
          out.length ? `${items_(out.length)} ${out.length === 1 ? 'has' : 'have'} run out` : '',
          out.length && low.length ? ' · ' : '',
          low.length ? `${items_(low.length)} at or below ${low.length === 1 ? 'its' : 'their'} reorder level` : '',
        ]),
        el('button', { class: 'btn btn--sm', onClick: () => { filter = out.length ? 'out' : 'low'; paint(); } }, ['Show them']),
      ]) : null,

      el('div', { class: 'card' }, [
        el('div', { class: 'inline-row', style: 'margin:0 0 12px' }, [
          chip('all', 'All', items.length),
          chip('low', 'Needs restocking', low.length + out.length),
          chip('out', 'Out', out.length),
          el('div', { style: 'flex:1' }),
          search,
        ]),
        el('div', { class: 'data-table-wrap', id: 'inv-body' }, [table(rows)]),
      ]),

      items.length ? null : emptyState(),
    );
  }

  function paintBody() {
    const host = root.querySelector('#inv-body');
    if (host) host.replaceChildren(table(visible()));
  }

  function table(rows) {
    return el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {}, ['Item', 'On hand', 'Reorder at', 'Used this clinic', 'Status', ''].map((h) =>
        el('th', { class: /On hand|Reorder|Used/.test(h) ? 'num' : '' }, [h])))]),
      el('tbody', {}, rows.length ? rows.map(row)
        : [el('tr', {}, [el('td', { colspan: 6, class: 'empty' }, ['Nothing matches.'])])]),
    ]);
  }

  function emptyState() {
    return el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, [icon('pill', { size: 15 }), 'Nothing tracked yet']),
      el('p', {}, ['Add items one at a time, or start from a standard list you can then edit or delete.']),
      el('p', { class: 'subtle small' }, ['The anaesthetics and antibiotics in that list are MMW’s own drug list. The rest is an ordinary portable dental setup — every reorder level in it is a placeholder until somebody who packs the van says otherwise.']),
      isAdmin ? el('button', { class: 'btn btn--ghost', onClick: addStarter }, [icon('plus', { size: 16 }), `Add ${STARTER.length} starter items`]) : null,
    ]);
  }

  async function addStarter() {
    const ok = await modal({
      title: 'Add the starter list?',
      body: `This adds ${STARTER.length} common items with placeholder reorder levels and a count of zero. Nothing is stocked until you record what you actually have. You can edit or delete any of them.`,
      confirmText: 'Add them', cancelText: 'Cancel',
    });
    if (!ok) return;
    try {
      for (const it of STARTER) await api.inventorySave(it);
      toast(`${STARTER.length} items added — now record what you have on hand.`, 'success');
      await load();
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ---------------- one item ---------------- */

  async function openItem(item) {
    const full = item ? await api.inventoryGet(item.id) : null;
    const name = textField('Item', { value: full ? full.name : '', required: true });
    const category = textField('Category', { value: full ? full.category || '' : '', hint: 'e.g. PPE, Anaesthetic, Consumable' });
    const unit = textField('Counted in', { value: full ? full.unit || '' : '', hint: 'box, carpule, each' });
    const par = textField('Reorder at', { value: full ? String(full.par_level || '') : '', type: 'number', hint: 'Flag as low at or below this. 0 to never flag.' });

    const body = el('div', {}, [
      el('div', { class: 'form-grid' }, [name.node, category.node, unit.node, par.node]),
      full ? ledger(full) : null,
    ]);

    const ok = await modal({
      title: full ? full.name : 'Add an item',
      body,
      confirmText: full ? 'Save changes' : 'Add item',
      cancelText: 'Close',
    });
    if (!ok) return;
    try {
      await api.inventorySave({
        id: full ? full.id : undefined,
        name: name.get(), category: category.get(), unit: unit.get(), par_level: Number(par.get()) || 0,
      });
      await load();
    } catch (e) { toast(e.message, 'error'); }
  }

  /** The item's history, and the form for adding to it. */
  function ledger(full) {
    const qty = textField('How many', { type: 'number', value: '1' });
    const reason = selectField('What happened', REASONS.map((r) => ({ value: r.key, label: r.label })), { value: 'used' });
    const note = textField('Note (optional)', { value: '' });
    const hint = el('p', { class: 'field-hint' }, []);
    const syncHint = () => {
      const r = REASONS.find((x) => x.key === reason.get());
      hint.replaceChildren(r ? r.hint : '');
    };
    reason.input.addEventListener('change', syncHint);
    syncHint();

    const addBtn = el('button', { class: 'btn btn--primary btn--sm' }, [icon('save', { size: 15 }), 'Record']);
    addBtn.addEventListener('click', async () => {
      const r = REASONS.find((x) => x.key === reason.get());
      const n = Math.round(Number(qty.get()) || 0);
      if (!n) { toast('Enter how many.', 'error'); return; }
      // The sign comes from what happened, not from what was typed — nobody
      // should have to remember to type a minus to record using something. A
      // correction is the exception and keeps whatever sign was entered.
      const delta = r.sign === 0 ? n : Math.abs(n) * r.sign;
      try {
        await withBusy(addBtn, () => api.inventoryMove({ item_id: full.id, delta, reason: r.key, note: note.get() }));
        const fresh = await api.inventoryGet(full.id);
        full.moves = fresh.moves; full.on_hand = fresh.on_hand;
        onHand.replaceChildren(String(fresh.on_hand));
        history.replaceChildren(...historyRows(full));
        qty.set(''); note.set('');
        await load();
      } catch (e) { toast(e.message, 'error'); }
    });

    const onHand = el('strong', { class: 'inv-onhand' }, [String(full.on_hand)]);
    const history = el('div', { class: 'inv-history' }, historyRows(full));

    return el('div', { style: 'margin-top:16px' }, [
      el('div', { class: 'inv-onhand-row' }, [
        el('span', { class: 'field-label' }, ['On hand']),
        onHand,
        el('span', { class: 'subtle small' }, [plural(full.unit, full.on_hand)]),
      ]),
      el('div', { class: 'form-grid' }, [qty.node, reason.node]),
      hint,
      note.node,
      el('div', { class: 'inline-row', style: 'margin:8px 0 0' }, [
        addBtn,
        isAdmin ? el('button', { class: 'btn btn--ghost btn--sm', onClick: () => removeItem(full) }, [icon('trash', { size: 15 }), 'Delete item']) : null,
      ]),
      el('div', { class: 'field-label', style: 'margin-top:16px' }, ['History']),
      history,
    ]);
  }

  function historyRows(full) {
    if (!full.moves.length) return [el('p', { class: 'muted small' }, ['Nothing recorded yet.'])];
    return full.moves.map((m) => el('div', { class: 'inv-move' }, [
      el('span', { class: 'inv-move-delta ' + (m.delta > 0 ? 'is-in' : 'is-out') }, [(m.delta > 0 ? '+' : '') + m.delta]),
      el('span', {}, [REASONS.find((r) => r.key === m.reason) ? REASONS.find((r) => r.key === m.reason).label : m.reason]),
      el('span', { class: 'subtle small' }, [
        [m.created_by_name, m.event_name, fmtWhen(m.created_at)].filter(Boolean).join(' · '),
      ]),
      m.note ? el('span', { class: 'subtle small' }, [m.note]) : null,
    ]));
  }

  async function removeItem(full) {
    const ok = await modal({
      title: `Delete ${full.name}?`,
      body: 'This removes the item and its whole history. Deactivating it instead keeps the record — ask if you are not sure.',
      confirmText: 'Delete', cancelText: 'Cancel', danger: true,
    });
    if (!ok) return;
    try { await api.inventoryDelete(full.id); toast('Item deleted', 'success'); await load(); }
    catch (e) { toast(e.message, 'error'); }
  }
}

function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}
