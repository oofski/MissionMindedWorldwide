// Signing a consent, three ways, because the clinic runs on mixed hardware.
//
// The canvas pad alone assumed a touchscreen. On a laptop with no touch a
// patient cannot produce a signature with a trackpad that looks anything like
// their own, so in practice the field was left blank and the consent carried no
// mark at all. These three all produce a record of assent:
//
//   draw      the existing pad — finger, stylus or mouse
//   type      the patient types their name; the TYPED NAME is the record
//   generate  the patient types their name and the app renders it in a script
//             hand, which they then accept
//
// The method is stored alongside the image, and a generated or typed signature
// is labelled as such in the image itself. That matters: a script-font rendering
// of a typed name must never be mistaken later for something the patient drew
// with their own hand. Anyone reading the record — or the printed consent — can
// see which of the three happened.
//
// Everything is drawn locally on a canvas. The clinic is offline in a field
// building, so nothing may depend on a webfont being fetched.

import { el } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { icon } from '../icons.js';
import { SignaturePad } from './signature.js';

const L = (map) => map[getLang()] || map.en;

/** Script faces that ship with Windows and macOS, in preference order. */
const SCRIPT_STACK = '"Segoe Script", "Bradley Hand", "Snell Roundhand", "Apple Chancery", cursive';

/**
 * Render `name` as a signature-style PNG.
 *
 * The caption underneath is deliberate and not decoration: it is what keeps a
 * generated mark honest when the consent is printed months later.
 */
export function renderTypedSignature(name, { width = 600, height = 180, method = 'generate' } = {}) {
  const canvas = el('canvas', { width, height });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const text = String(name || '').trim();
  if (!text) return null;

  ctx.fillStyle = '#1f3a4d';
  ctx.textBaseline = 'middle';
  // Shrink to fit rather than overflow: long names are common and a clipped
  // signature looks like a rendering bug on a legal document.
  let size = method === 'generate' ? 64 : 40;
  const font = (px) => (method === 'generate' ? `${px}px ${SCRIPT_STACK}` : `${px}px Arial, Helvetica, sans-serif`);
  ctx.font = font(size);
  while (size > 16 && ctx.measureText(text).width > width - 60) {
    size -= 2;
    ctx.font = font(size);
  }
  ctx.textAlign = 'center';
  ctx.fillText(text, width / 2, height / 2 - 12);

  // The audit caption.
  ctx.font = '13px Arial, Helvetica, sans-serif';
  ctx.fillStyle = '#5b6b75';
  ctx.fillText(
    method === 'generate' ? 'Signature generated from typed name' : 'Signed by typed name',
    width / 2, height - 26,
  );

  // A rule under the name, so it reads as a signature line on paper.
  ctx.strokeStyle = '#c9d2d8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, height - 44);
  ctx.lineTo(width - 40, height - 44);
  ctx.stroke();

  return canvas.toDataURL('image/png');
}

/**
 * A signature control offering all three methods.
 *
 * `getName()` supplies the current typed name from the signer field, so Type and
 * Generate do not ask the patient to write their name a second time.
 *
 * Returns { node, getMethod(), getDataUrl(), isEmpty() }.
 */
export function SignatureField({ getName = () => '', onChange = () => {} } = {}) {
  let method = 'draw';
  const pad = SignaturePad({ onChange });

  const METHODS = [
    { key: 'draw', ic: 'pen', label: L({ en: 'Draw it', es: 'Dibujarla' }) },
    { key: 'type', ic: 'user', label: L({ en: 'Type my name', es: 'Escribir mi nombre' }) },
    { key: 'generate', ic: 'sparkle', label: L({ en: 'Generate for me', es: 'Generarla por mí' }) },
  ];

  const preview = el('div', { class: 'sigfield-preview' });
  const drawWrap = el('div', {}, [pad.node]);
  const tabs = new Map();

  function hint() {
    return {
      draw: L({ en: 'Sign with a finger, stylus or mouse.', es: 'Firme con el dedo, un lápiz óptico o el ratón.' }),
      type: L({ en: 'Your typed name above is your signature. It is recorded as typed, not drawn.', es: 'Su nombre escrito arriba es su firma. Se registra como escrita, no dibujada.' }),
      generate: L({ en: 'We will write your typed name for you. It is recorded as generated, not drawn.', es: 'Escribiremos su nombre por usted. Se registra como generada, no dibujada.' }),
    }[method];
  }

  const hintNode = el('p', { class: 'field-hint' }, []);

  function paint() {
    tabs.forEach((btn, k) => {
      const on = k === method;
      btn.classList.toggle('chip-btn--on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    drawWrap.style.display = method === 'draw' ? '' : 'none';
    preview.style.display = method === 'draw' ? 'none' : '';
    hintNode.replaceChildren(hint());
    if (method !== 'draw') refreshPreview();
    onChange();
  }

  function refreshPreview() {
    const url = renderTypedSignature(getName(), { method });
    preview.replaceChildren(
      url
        ? el('img', { class: 'sigfield-img', src: url, alt: '' })
        : el('p', { class: 'muted small' }, [L({
            en: 'Type your name in the box above and it will appear here.',
            es: 'Escriba su nombre en el cuadro de arriba y aparecerá aquí.',
          })]),
    );
  }

  const tabRow = el('div', { class: 'chip-row sigfield-tabs' }, METHODS.map((m) => {
    const btn = el('button', {
      type: 'button', class: 'chip-btn', 'aria-pressed': 'false',
      onClick: () => { method = m.key; paint(); },
    }, [icon(m.ic, { size: 15 }), el('span', {}, [m.label])]);
    tabs.set(m.key, btn);
    return btn;
  }));

  const node = el('div', { class: 'sigfield' }, [
    el('span', { class: 'field-label' }, [t('common.signHere')]),
    tabRow,
    drawWrap,
    preview,
    hintNode,
  ]);

  paint();

  return {
    node,
    /** Keep the typed/generated preview in step with the name field. */
    refresh: () => { if (method !== 'draw') refreshPreview(); },
    getMethod: () => method,
    isEmpty: () => (method === 'draw' ? pad.isEmpty() : !String(getName() || '').trim()),
    getDataUrl: () => (method === 'draw' ? pad.getDataUrl() : renderTypedSignature(getName(), { method })),
    destroy: () => pad.destroy && pad.destroy(),
  };
}
