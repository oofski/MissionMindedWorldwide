// v0.0.24: the pre-registration link as a QR code — on the Events screen, and
// on a sign printed for the clinic's door or a flyer. The grid comes from the
// main process (src/main/qr.js); it is drawn here as SVG, one path, so it is
// sharp at any size and on any printer.

import { el } from '../dom.js';
import { api } from '../api.js';

const NS = 'http://www.w3.org/2000/svg';

/** An <svg> of a QR grid ({ size, rows }), with the 4-module quiet zone a scanner needs. */
export function qrSvg(m, { px = 220, quiet = 4, label = 'QR code' } = {}) {
  const n = m.size + quiet * 2;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('width', String(px));
  svg.setAttribute('height', String(px));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', 'qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(n));
  bg.setAttribute('height', String(n));
  bg.setAttribute('fill', '#fff');
  svg.append(bg);
  let d = '';
  m.rows.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (row[c] !== '1') { c++; continue; }
      let len = 1;
      while (c + len < row.length && row[c + len] === '1') len++;
      d += `M${c + quiet} ${r + quiet}h${len}v1h-${len}z`;
      c += len;
    }
  });
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(path);
  return svg;
}

/** The QR code for `text`, drawn. */
export async function qrFor(text, opts = {}) {
  return qrSvg(await api.qrMake(text), { label: `QR code for ${text}`, ...opts });
}

/** A sign to print: scan to pre-register, in English and Spanish. */
export async function preregSign(event) {
  const when = [event.start_date, event.location].filter(Boolean).join(' · ');
  return el('div', { class: 'prereg-sign' }, [
    el('img', { class: 'prereg-sign-logo', src: '../../assets/mmw-logo.png', alt: 'Mission Minded Free Clinics' }),
    el('h1', {}, ['Register before your visit']),
    el('h2', {}, ['Regístrese antes de su visita']),
    el('div', { class: 'prereg-sign-event' }, [event.name || '']),
    when ? el('div', { class: 'prereg-sign-when' }, [when]) : null,
    el('div', { class: 'prereg-sign-qr' }, [await qrFor(event.prereg_url, { px: 420 })]),
    el('p', { class: 'prereg-sign-how' }, ['Scan with your phone’s camera and answer the check-in questions at home.']),
    el('p', { class: 'prereg-sign-how' }, ['Escanee con la cámara de su teléfono y conteste las preguntas de registro en casa.']),
    el('p', { class: 'prereg-sign-link' }, [event.prereg_url]),
  ]);
}

/** Print a node on its own, the way the wristband prints (only it reaches paper). */
export function printNode(node) {
  let root = document.getElementById('print-root');
  if (!root) { root = el('div', { id: 'print-root' }); document.body.append(root); }
  // An ordinary page: a wristband print may have left its label size behind.
  const page = document.getElementById('wb-page-size');
  if (page) page.textContent = '';
  root.replaceChildren(node);
  document.body.classList.add('printing');
  const cleanup = () => {
    document.body.classList.remove('printing');
    root.replaceChildren();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(() => { if (document.body.classList.contains('printing')) cleanup(); }, 6000);
}
