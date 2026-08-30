// Code 128 barcode rendering, for the patient wristband label.
//
// The EMR flow has providers scan a wristband at Clearance and at Triage to
// pull the patient up, so the code has to survive a cheap laser scanner and a
// crumpled paper band. Code 128 is the right family for that: it is what
// wristband printers and hospital scanners already speak, it self-checks, and
// in subset C it packs two digits into one symbol, which keeps a 6-digit code
// physically short enough to wrap a child's wrist.
//
// Rendered as inline SVG rather than a canvas so the bars stay crisp at any
// printer DPI — a rasterised barcode at 96dpi is the classic reason a scanner
// refuses to read a printed band. No dependency: the pattern table below is
// the Code 128 standard, and shipping it beats adding a library to an app that
// has to install offline.

/* Code 128 symbol patterns, values 0…106. Each digit is an element width in
   modules, alternating bar/space starting with a bar. Value 106 is the stop
   pattern and is 13 modules (7 elements) rather than 11. */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const START_B = 104;
const START_C = 105;
const STOP = 106;

/**
 * Symbol values for `text`, including start and checksum.
 * All-digit even-length payloads use subset C (two digits per symbol); anything
 * else uses subset B, which covers printable ASCII 32…126.
 */
function symbolValues(text) {
  const useC = /^\d+$/.test(text) && text.length % 2 === 0;
  const values = [useC ? START_C : START_B];

  if (useC) {
    for (let i = 0; i < text.length; i += 2) values.push(Number(text.slice(i, i + 2)));
  } else {
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      // Subset B maps ASCII 32…126 onto values 0…94.
      if (code < 32 || code > 126) throw new Error(`Cannot encode character ${JSON.stringify(ch)} in a barcode.`);
      values.push(code - 32);
    }
  }

  // Modulo-103 weighted checksum: the start value plus each data value times
  // its 1-based position. This is what lets a scanner reject a misread.
  let sum = values[0];
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  values.push(STOP);
  return values;
}

/** Element widths in modules, alternating bar/space and starting with a bar. */
export function code128Modules(text) {
  return symbolValues(text)
    .map((v) => PATTERNS[v])
    .join('')
    .split('')
    .map(Number);
}

/**
 * An <svg> of `text` as a Code 128 barcode.
 *
 * `moduleWidth` is the narrowest bar. At 1px on a 96dpi screen a scanner is
 * unreliable, so callers that print use 2 — the print stylesheet scales it up
 * again. A quiet zone of 10 modules each side is part of the spec, not padding:
 * without it many scanners will not read the code at all.
 */
export function barcodeSVG(text, opts = {}) {
  const { moduleWidth = 2, height = 56, showText = true, quietZone = 10 } = opts;
  const modules = code128Modules(String(text));
  const totalModules = modules.reduce((a, b) => a + b, 0) + quietZone * 2;

  const textH = showText ? 16 : 0;
  const w = totalModules * moduleWidth;
  const h = height + textH;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('class', 'barcode');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Barcode ${text}`);

  // White ground: the quiet zone only works if it is actually white, which
  // matters when this is dropped onto a tinted panel.
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(w));
  bg.setAttribute('height', String(h));
  bg.setAttribute('fill', '#fff');
  svg.append(bg);

  let x = quietZone * moduleWidth;
  let isBar = true;
  for (const width of modules) {
    if (isBar) {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', String(x));
      r.setAttribute('y', '0');
      r.setAttribute('width', String(width * moduleWidth));
      r.setAttribute('height', String(height));
      r.setAttribute('fill', '#000');
      svg.append(r);
    }
    x += width * moduleWidth;
    isBar = !isBar;
  }

  if (showText) {
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('x', String(w / 2));
    label.setAttribute('y', String(height + 13));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-family', 'ui-monospace, Consolas, monospace');
    label.setAttribute('font-size', '14');
    label.setAttribute('letter-spacing', '2');
    label.setAttribute('fill', '#000');
    label.textContent = String(text);
    svg.append(label);
  }

  return svg;
}
