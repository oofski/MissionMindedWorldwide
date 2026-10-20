// What a vitals reading can be.
//
// Outside VITAL_LIMITS a number is a typo, not a reading — a systolic of 400, a
// pulse of 0, a respiration of 99 — and it is refused: here as the EMT saves,
// and again by the data layer (db.js VITAL_LIMITS holds the same numbers; the
// harness pins the two equal). Such a number used to save as "Vitals recorded"
// and reach the dentist as a real reading before anaesthetic or an extraction.
//
// Inside the limits but outside VITAL_USUAL a reading is possible but rare, so
// the EMT is asked to re-check it before it is saved, and may save it.

export const VITAL_LIMITS = {
  bp_systolic: { min: 50, max: 300, label: 'Systolic' },
  bp_diastolic: { min: 20, max: 200, label: 'Diastolic' },
  heart_rate: { min: 20, max: 250, label: 'Pulse' },
  glucose: { min: 10, max: 900, label: 'Blood sugar' },
  respiration: { min: 4, max: 60, label: 'Respiration' },
};

export const VITAL_USUAL = {
  bp_systolic: { min: 80, max: 220 },
  bp_diastolic: { min: 40, max: 130 },
  heart_rate: { min: 40, max: 150 },
  glucose: { min: 50, max: 400 },
  respiration: { min: 8, max: 40 },
};

const num = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * The problems with one set of readings ({ bp_systolic, bp_diastolic,
 * heart_rate, glucose, respiration }, any blank). `prefix` names the set
 * ("Re-check #1: "). Returns { impossible: [{ key, msg }], unusual: [{ key, msg }] }.
 */
export function vitalsProblems(v, prefix = '') {
  const impossible = [];
  const unusual = [];
  const val = {};
  for (const [key, lim] of Object.entries(VITAL_LIMITS)) {
    const n = num(v && v[key]);
    if (n == null) continue;
    val[key] = n;
    if (Number.isNaN(n) || n < lim.min || n > lim.max) {
      impossible.push({ key, msg: `${prefix}${lim.label} ${Number.isNaN(n) ? String(v[key]).trim() : n} is not a possible reading (${lim.min}–${lim.max}). Re-enter it.` });
    } else if (n < VITAL_USUAL[key].min || n > VITAL_USUAL[key].max) {
      unusual.push({ key, msg: `${prefix}${lim.label} ${n} is unusual (usually ${VITAL_USUAL[key].min}–${VITAL_USUAL[key].max}).` });
    }
  }
  if (val.bp_systolic != null && val.bp_diastolic != null && !impossible.some((x) => x.key.startsWith('bp_'))
    && val.bp_diastolic >= val.bp_systolic) {
    impossible.push({ key: 'bp_diastolic', msg: `${prefix}Diastolic ${val.bp_diastolic} is not lower than systolic ${val.bp_systolic} — check the two numbers (they may be swapped).` });
  }
  return { impossible, unusual };
}
