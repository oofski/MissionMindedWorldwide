import { el } from '../dom.js';
import { t } from '../i18n.js';

// A signature pad backed by a <canvas>. Works with mouse, touch, and stylus
// via pointer events. Exposes getDataUrl() / isEmpty() / clear().
export function SignaturePad({ onChange } = {}) {
  const canvas = el('canvas', { class: 'sigpad-canvas', width: 600, height: 180 });
  const ctx = canvas.getContext('2d');
  let drawing = false;
  let dirty = false;
  let last = null;
  // A signature put back on the pad (the patient went Back and returned). It
  // is returned exactly as it was given until the patient draws on it or
  // clears it — re-encoding the canvas would not give back the same image.
  let loaded = null;

  function resize() {
    // Keep the backing store crisp on HiDPI while preserving drawn content.
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const snapshot = canvas.toDataURL();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(180 * ratio);
    ctx.scale(ratio, ratio);
    setStroke();
    if (dirty) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, 180);
      img.src = snapshot;
    }
  }
  function setStroke() {
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1f3a4d';
  }
  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function start(e) { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); }
  function move(e) {
    if (!drawing) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    loaded = null;
    if (!dirty) { dirty = true; if (onChange) onChange(); }
  }
  function end() { drawing = false; last = null; }

  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointerleave', end);

  const clearBtn = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button',
    onClick: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; loaded = null; if (onChange) onChange(); },
  }, [t('common.clearSignature')]);

  const wrap = el('div', { class: 'sigpad' }, [
    el('div', { class: 'sigpad-hint' }, [t('common.signHere')]),
    canvas,
    el('div', { class: 'sigpad-actions' }, [clearBtn]),
  ]);

  setTimeout(resize, 0);
  // Self-removing resize listener: once the pad's canvas is detached (the view
  // re-rendered), the handler unbinds itself instead of leaking across renders.
  const onResize = () => {
    if (!canvas.isConnected) { window.removeEventListener('resize', onResize); return; }
    resize();
  };
  window.addEventListener('resize', onResize);

  return {
    node: wrap,
    isEmpty: () => !dirty,
    clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; loaded = null; },
    getDataUrl: () => (dirty ? loaded || canvas.toDataURL('image/png') : null),
    /** Put a signature back on the pad. */
    load: (url) => {
      if (!url) return;
      loaded = url;
      dirty = true;
      const img = new Image();
      img.onload = () => { const r = canvas.getBoundingClientRect(); ctx.drawImage(img, 0, 0, r.width || canvas.width, 180); };
      img.src = url;
    },
    destroy: () => window.removeEventListener('resize', onResize),
  };
}
