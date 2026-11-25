'use strict';
// v0.0.24: a QR code for the online pre-registration link, so a flyer or a
// sign at the door can be scanned instead of typed. Made here, in the main
// process, by qrcode-generator (MIT, no dependencies); the screen gets only
// the grid of squares and draws it itself (components/qr.js) — nothing is
// handed to it as markup.
const qrcode = require('qrcode-generator');

// Medium error correction: still readable with a fold or a smudge on a
// printed sign, and small enough for a long workers.dev link.
function qrMatrix(text) {
  const t = String(text == null ? '' : text);
  if (!t) throw new Error('There is nothing to put in the QR code.');
  if (t.length > 1000) throw new Error('That is too long for a QR code.');
  const q = qrcode(0, 'M');
  q.addData(t, 'Byte');
  q.make();
  const size = q.getModuleCount();
  const rows = [];
  for (let r = 0; r < size; r++) {
    let line = '';
    for (let c = 0; c < size; c++) line += q.isDark(r, c) ? '1' : '0';
    rows.push(line);
  }
  return { size, rows };
}

module.exports = { qrMatrix };
