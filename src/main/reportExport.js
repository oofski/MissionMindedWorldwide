'use strict';

/**
 * The clinic report, as something a funder can open.
 *
 * ONE definition of the report's sections drives all three formats. Three
 * exports that disagree about the same clinic is worse than having one — a grant
 * return quoting the spreadsheet and a board paper quoting the PDF must never
 * give different numbers for the same question. So reportSections() is the
 * single source and CSV, Excel and PDF are three renderings of it.
 *
 * Everything here comes from the de-identified summary, which is the same object
 * the Reports tab draws and the same one kept when a clinic is finished. No
 * patient row is read, so a report can still be exported after the records have
 * been purged — which is the case this data exists for.
 */

const { buildWorkbook } = require('./xlsx');

/* ---------- labels, applied here so the stored summary stays language-neutral ---------- */

const GENDER = { male: 'Male', female: 'Female', other: 'Other' };
const LANG = { en: 'English', es: 'Spanish', ru: 'Russian', bzj: 'Belize Kriol', nya: 'Chichewa' };
const RACE = {
  american_indian_alaska_native: 'American Indian or Alaska Native',
  asian: 'Asian',
  black_african_american: 'Black or African American',
  hispanic_latino: 'Hispanic or Latino',
  middle_eastern_north_african: 'Middle Eastern or North African',
  native_hawaiian_pacific_islander: 'Native Hawaiian or Pacific Islander',
  white: 'White',
  prefer_not: 'Prefer not to answer',
};
const STATUS = {
  checked_in: 'Checked in', triaged: 'Cleared', in_treatment: 'In treatment',
  completed: 'Treatment complete', dismissed: 'Checked out',
};
const relabel = (obj, map) => Object.fromEntries(
  Object.entries(obj || {}).map(([k, v]) => [k === 'Not recorded' ? k : ((map && map[k]) || k), v]),
);

/** A date a person can read, from the ISO stamp the summary carries. */
function readableDate(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return iso || '';
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')} ${M[d.getMonth()]} ${d.getFullYear()}`;
}

/** A breakdown, biggest first — the order somebody reads it in. */
function ranked(title, obj, total) {
  const rows = Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [k, v, total ? `${Math.round((v / total) * 100)}%` : '']);
  return { title, columns: [title, 'Patients', 'Share'], rows };
}

/**
 * The report, as titled tables.
 *
 * @param {object} summary   a summary from db.buildEventSummary / reportRollup
 * @param {string} scopeLabel  what this covers, e.g. "This clinic" or "All clinics"
 */
function reportSections(summary, scopeLabel, labels) {
  const s = summary || {};
  // Condition and survey names live in the renderer's i18n catalogue, which this
  // CommonJS process cannot import. Rather than keep a second copy here — which
  // would drift, and drift silently, into a grant report reading "high_bp" — the
  // Reports tab sends its labels with the request. Missing ones fall through to
  // the raw code, so a number is never withheld for want of a name.
  const L = labels || {};
  const total = s.patients_seen || 0;
  const pct = (n) => (total ? `${Math.round(((n || 0) / total) * 100)}%` : '');
  const meanAge = s.age_known ? Math.round((s.age_sum / s.age_known) * 10) / 10 : null;

  const sections = [];

  sections.push({
    title: 'Clinic',
    columns: ['Measure', 'Value'],
    rows: [
      ['Report covers', scopeLabel || 'This clinic'],
      // Omitted when empty rather than printed blank: on an all-clinics report
      // there is no single clinic name, and a row of empty cells reads as
      // missing data rather than as not applicable.
      ...(s.event_name ? [['Clinic', s.event_name]] : []),
      ...(s.event_location ? [['Location', s.event_location]] : []),
      ...(s.event_start ? [['Start date', s.event_start]] : []),
      ['Report generated', readableDate(s.generated_at)],
    ],
  });

  sections.push({
    title: 'Patient counts',
    columns: ['Measure', 'Patients', 'Share'],
    rows: [
      ['Patients seen', total, ''],
      ['Visits completed', s.visits_completed || 0, pct(s.visits_completed)],
      ['Checked out', s.checked_out || 0, pct(s.checked_out)],
      ['Flagged for a medical condition', s.flagged || 0, pct(s.flagged)],
      ['Had an x-ray', s.patients_with_xray || 0, pct(s.patients_with_xray)],
    ],
  });

  // Pre-registered online vs registered at the desk, and how many of each
  // actually made it through — the figure that shows whether the online form is
  // bringing people in or just collecting sign-ups.
  const pre = s.pre_signups || 0;
  const onsite = s.onsite_signups || 0;
  sections.push({
    title: 'How patients registered',
    columns: ['Route', 'Signed up', 'Checked out', 'Completion'],
    rows: [
      ['Pre-registered online', pre, s.pre_checked_out || 0, pre ? `${Math.round(((s.pre_checked_out || 0) / pre) * 100)}%` : ''],
      ['Registered at the clinic', onsite, s.onsite_checked_out || 0, onsite ? `${Math.round(((s.onsite_checked_out || 0) / onsite) * 100)}%` : ''],
    ],
  });

  sections.push(ranked('Gender', relabel(s.by_gender, GENDER), total));

  const ageSec = ranked('Age band', s.by_age, total);
  if (meanAge != null) {
    ageSec.note = `Average age ${meanAge} years, across ${s.age_known} patient(s) with a date of birth on file.`;
  }
  sections.push(ageSec);

  // Race counts SELECTIONS: one patient may choose several categories, so these
  // deliberately sum past the patient count and the note says so. A funder
  // reading a demographic table that exceeds 100% with no explanation is worse
  // off than one with no table.
  const raceAnswered = s.race_answered || 0;
  const raceSec = ranked('Race and ethnicity', relabel(s.by_race, RACE), raceAnswered || total);
  raceSec.note = `${raceAnswered} patient(s) gave one or more categories; ${s.race_declined || 0} preferred not to answer. `
    + 'A patient may choose more than one, so shares are of patients who answered and can total more than 100%.';
  sections.push(raceSec);

  sections.push(ranked('Language', relabel(s.by_language, LANG), total));
  sections.push(ranked('City', s.by_city, total));
  sections.push(ranked('Most common conditions', relabel(s.conditions, L.conditions), total));
  sections.push(ranked('Where patients were in the clinic', relabel(s.by_status, STATUS), total));

  sections.push({
    title: 'Procedures and imaging',
    columns: ['Procedure', 'Count'],
    rows: [
      ['Fillings', s.fillings || 0],
      ['Extractions', s.extractions || 0],
      ['Cleanings', s.cleanings || 0],
      ['X-rays taken', s.xrays || 0],
    ],
  });

  const days = (s.days || []).filter((d) => d.date && d.date !== 'Not recorded');
  if (days.length) {
    sections.push({
      title: 'Activity by day',
      columns: ['Date', 'Seen', 'Completed', 'Fillings', 'Extractions', 'Cleanings'],
      rows: days.map((d) => [d.date, d.seen, d.completed, d.fillings, d.extractions, d.cleanings]),
    });
  }

  // The exit survey, which is what a grant return is actually written from.
  const sv = s.survey;
  if (sv && (sv.registration || sv.exit)) {
    const reg = sv.registration || {};
    const ex = sv.exit || {};
    sections.push({
      title: 'Survey responses',
      columns: ['Asked', 'Answered', 'Declined', 'Not asked'],
      rows: [
        ['At registration', reg.completed || 0, reg.declined || 0, reg.not_asked || 0],
        ['At check-out', ex.completed || 0, ex.declined || 0, ex.not_asked || 0],
      ],
    });
    // Survey questions are labelled by the renderer's catalogue, which this
    // process cannot import. The raw codes are still exported so the numbers are
    // never withheld for want of a label.
    const answers = sv.answers || {};
    const qLabels = L.surveyQuestions || {};
    const oLabels = L.surveyOptions || {};
    const rows = [];
    for (const [q, opts] of Object.entries(answers)) {
      for (const [opt, n] of Object.entries(opts || {})) {
        rows.push([qLabels[q] || q, (oLabels[q] && oLabels[q][opt]) || opt, n]);
      }
    }
    if (rows.length) {
      sections.push({ title: 'Survey answers', columns: ['Question', 'Answer', 'Patients'], rows });
    }
  }

  return sections;
}

/* ---------- the three renderings ---------- */

/** RFC 4180: quote anything containing a comma, quote or newline. */
function csvCell(v) {
  const t = v == null ? '' : String(v);
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

/**
 * One CSV holding every section, separated by a blank line and a title row.
 *
 * Not one file per table: a clinic emailing a report to a funder sends a file,
 * not a folder, and every spreadsheet program opens this shape without asking
 * any questions. A leading BOM so Excel on Windows reads the accents in a city
 * or a patient's language rather than showing mojibake.
 */
function reportCsv(summary, scopeLabel, labels) {
  const out = [];
  for (const sec of reportSections(summary, scopeLabel, labels)) {
    out.push(csvCell(sec.title));
    if (sec.note) out.push(csvCell(sec.note));
    out.push(sec.columns.map(csvCell).join(','));
    for (const r of sec.rows) out.push(r.map(csvCell).join(','));
    out.push('');
  }
  return '﻿' + out.join('\r\n');
}

/** One worksheet per section — what a spreadsheet is actually good at. */
function reportWorkbook(summary, scopeLabel, labels) {
  const sheets = reportSections(summary, scopeLabel, labels).map((sec) => ({
    name: sec.title,
    columns: sec.columns,
    // The note rides as a trailing row rather than being dropped: it is the
    // sentence that stops the race percentages being misread.
    rows: sec.note ? [...sec.rows, [], [sec.note]] : sec.rows,
  }));
  return buildWorkbook(sheets);
}

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Printable report — the same tables, laid out for Letter paper. */
function reportHtml(summary, scopeLabel, labels) {
  const s = summary || {};
  const sections = reportSections(summary, scopeLabel, labels);
  const body = sections.map((sec) => `
    <section>
      <h2>${esc(sec.title)}</h2>
      ${sec.note ? `<p class="note">${esc(sec.note)}</p>` : ''}
      <table>
        <thead><tr>${sec.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${sec.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')
          || '<tr><td class="muted">No data</td></tr>'}</tbody>
      </table>
    </section>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Mission Minded clinic report</title>
  <style>
    @page { size: Letter; margin: 14mm; }
    body { font: 11px Arial, Helvetica, sans-serif; color: #141719; }
    h1 { font-size: 19px; margin: 0 0 2px; }
    .sub { color: #5b6b75; margin: 0 0 16px; font-size: 11px; }
    section { margin-bottom: 16px; break-inside: avoid; }
    h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: #00707d;
         margin: 0 0 6px; border-bottom: 1px solid #d7dde1; padding-bottom: 3px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
         color: #5b6b75; border-bottom: 1px solid #d7dde1; padding: 3px 6px 3px 0; }
    td { padding: 3px 6px 3px 0; border-bottom: 1px solid #eef1f3; }
    td.num { text-align: right; width: 90px; font-variant-numeric: tabular-nums; }
    .note { color: #5b6b75; font-size: 10px; margin: 0 0 6px; }
    .muted { color: #8a979f; }
  </style></head><body>
    <h1>Mission Minded Worldwide — Clinic report</h1>
    <p class="sub">${esc(s.event_name || '')}${s.event_location ? ' · ' + esc(s.event_location) : ''}
      · Generated ${esc(readableDate(s.generated_at))}</p>
    ${body}
  </body></html>`;
}

module.exports = { reportSections, reportCsv, reportWorkbook, reportHtml };
