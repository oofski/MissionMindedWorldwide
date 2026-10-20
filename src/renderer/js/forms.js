import { el } from './dom.js';

// Constrain an input to digits only, at most `max` (e.g. a 10-digit phone number).
// Strips anything non-numeric on input and caps the length.
export function limitDigits(inputEl, max = 10) {
  if (!inputEl) return;
  inputEl.setAttribute('inputmode', 'numeric');
  inputEl.setAttribute('maxlength', String(max));
  const clean = () => { const d = (inputEl.value || '').replace(/\D/g, '').slice(0, max); if (d !== inputEl.value) inputEl.value = d; };
  inputEl.addEventListener('input', clean);
  clean();
}

// Reusable labelled form controls. Each returns { node, get, set }.

export function textField(label, { value = '', type = 'text', placeholder = '', required = false, hint = '' } = {}) {
  const input = el('input', { class: 'input', type, value, placeholder });
  const node = el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, [label, required ? el('em', { class: 'req' }, [' *']) : null]),
    input,
    hint ? el('span', { class: 'field-hint' }, [hint]) : null,
  ]);
  return { node, get: () => input.value.trim(), set: (v) => { input.value = v || ''; }, input };
}

export function textArea(label, { value = '', rows = 3, placeholder = '' } = {}) {
  const ta = el('textarea', { class: 'input textarea', rows, placeholder }, [value || '']);
  const node = el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, [label]),
    ta,
  ]);
  return { node, get: () => ta.value.trim(), set: (v) => { ta.value = v || ''; }, input: ta };
}

export function selectField(label, options, { value = '', required = false } = {}) {
  const sel = el('select', { class: 'input select' });
  options.forEach((o) => {
    const opt = el('option', { value: o.value }, [o.label]);
    if (o.value === value) opt.selected = true;
    sel.append(opt);
  });
  const node = el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, [label, required ? el('em', { class: 'req' }, [' *']) : null]),
    sel,
  ]);
  return { node, get: () => sel.value, set: (v) => { sel.value = v; }, input: sel };
}

// One answer from a short list, as a row of buttons: one tap each, where a
// dropdown is two (open, then choose) and opens a native picker on a touch
// screen. `options` is [{value,label}]; a '' option (the "—" of a dropdown) is
// left out, since an untouched row is already unanswered. Picking dispatches
// 'change' on `input` (the row), so callers listen exactly as on a <select>.
// `allowClear`: tapping the chosen answer again takes it off, for a question
// that may be left unanswered (the "—" a dropdown could be put back to).
export function choiceRow(options, { value = '', onPick = null, allowClear = false } = {}) {
  let current = value == null ? '' : String(value);
  const row = el('div', { class: 'chip-row choice-row', role: 'radiogroup' });
  const btns = options.filter((o) => o.value !== '').map((o) => {
    const b = el('button', {
      type: 'button', class: 'chip-btn choice-btn', role: 'radio', dataset: { value: o.value },
      onClick: () => {
        set(allowClear && current === o.value ? '' : o.value);
        if (onPick) onPick(current);
        row.dispatchEvent(new window.Event('change', { bubbles: true }));
      },
    }, [o.label]);
    row.append(b);
    return b;
  });
  function set(v) {
    current = v == null ? '' : String(v);
    btns.forEach((b) => {
      const on = b.dataset.value === current;
      b.classList.toggle('chip-btn--on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  set(current);
  return { node: row, get: () => current, set, input: row };
}

// choiceRow as a labelled field — the drop-in for selectField on a question
// the patient answers with one tap.
export function choiceField(label, options, { value = '', required = false } = {}) {
  const row = choiceRow(options, { value });
  const node = el('div', { class: 'field choice-field' }, [
    el('span', { class: 'field-label' }, [label, required ? el('em', { class: 'req' }, [' *']) : null]),
    row.node,
  ]);
  return { node, get: row.get, set: row.set, input: row.input };
}

// Multi-select chip grid from [{key,label,flag?}].
//
// `set()` repaints the chips as well as the selection, so a caller enforcing a
// rule ("No medications" clears the rest) cannot leave a chip lit that is no
// longer selected. Each chip carries its key in data-key for the same reason.
export function chipGrid(label, items, { selected = [], hint = '' } = {}) {
  const sel = new Set(selected);
  const grid = el('div', { class: 'chip-grid' });
  const btns = [];
  items.forEach((it) => {
    const btn = el('button', {
      type: 'button',
      class: 'chip-select' + (sel.has(it.key) ? ' chip-select--on' : '') + (it.flag ? ' chip-select--flag' : ''),
      dataset: { key: it.key },
      onClick: () => { if (sel.has(it.key)) sel.delete(it.key); else sel.add(it.key); btn.classList.toggle('chip-select--on'); },
    }, [it.label]);
    btns.push([it.key, btn]);
    grid.append(btn);
  });
  const node = el('div', { class: 'field' }, [
    label ? el('span', { class: 'field-label' }, [label]) : null,
    hint ? el('span', { class: 'field-hint' }, [hint]) : null,
    grid,
  ]);
  const set = (arr) => {
    sel.clear();
    (arr || []).forEach((k) => sel.add(k));
    btns.forEach(([k, b]) => b.classList.toggle('chip-select--on', sel.has(k)));
  };
  return { node, get: () => Array.from(sel), set };
}
