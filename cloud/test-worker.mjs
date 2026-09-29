// Self-contained Node test for worker.js — no external deps.
// Exercises the Worker's default export against a tiny in-memory fake D1 that
// implements prepare().bind().run()/.all()/.first() over an array.
//
// Run: node test-worker.mjs   (exits non-zero on any failed check)

import worker from './worker.js';
// The walk-in form's own definition of a complete medical history. The online
// form must store exactly what it would, so the checks below compare the two.
import { normalizeMedical, INTAKE_CONDITIONS } from '../src/renderer/js/medicalHistory.js';

const CLINIC_KEY = 'super-secret-clinic-key';

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log('PASS: ' + name);
  } else {
    console.log('FAIL: ' + name);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Tiny fake D1 — recognizes exactly the SQL that worker.js issues.
// ---------------------------------------------------------------------------
function makeFakeD1() {
  const store = new Map(); // uid -> row object
  let seq = 0; // the server's delivery counter (sync_seq table)

  function prepare(sql) {
    return {
      _sql: sql,
      _binds: [],
      bind(...args) {
        this._binds = args;
        return this;
      },
      async first() {
        const s = this._sql;
        if (/SELECT updated_at(, deleted)? FROM sync_rows WHERE uid = \?/.test(s)) {
          const uid = this._binds[0];
          const row = store.get(uid);
          return row ? { updated_at: row.updated_at, deleted: row.deleted ? 1 : 0 } : null;
        }
        // Pre-registration: look up an event row by uid (must exist, not deleted).
        if (/SELECT data FROM sync_rows WHERE uid = \? AND entity = 'event' AND deleted = 0/.test(s)) {
          const uid = this._binds[0];
          const row = store.get(uid);
          return row && row.entity === 'event' && !row.deleted ? { data: row.data } : null;
        }
        // v1.5.0 delivery counter: reserve the next sequence number.
        if (/INSERT INTO sync_seq .*ON CONFLICT\(id\) DO UPDATE SET v = v \+ 1 RETURNING v/.test(s)) {
          seq += 1;
          return { v: seq };
        }
        throw new Error('fake D1: unsupported first() SQL: ' + s);
      },
      async run() {
        const s = this._sql;
        // Self-initializing schema DDL (CREATE TABLE/INDEX IF NOT EXISTS) — the
        // in-memory store needs no schema, so these are no-ops. The v1.5.0
        // migrations (ADD COLUMN / backfill / counter seed) are likewise a no-op
        // here: the in-memory rows carry seq directly.
        if (/^\s*CREATE\s+(TABLE|INDEX)/i.test(s)) {
          return { success: true, meta: { changes: 0 } };
        }
        if (/^\s*ALTER TABLE sync_rows ADD COLUMN seq/.test(s)) {
          return { success: true, meta: { changes: 0 } };
        }
        if (/^\s*UPDATE sync_rows SET seq = rowid/.test(s)) {
          return { success: true, meta: { changes: 0 } };
        }
        if (/^\s*INSERT INTO sync_seq \(id, v\) SELECT 1/.test(s)) {
          return { success: true, meta: { changes: 0 } };
        }
        if (/INSERT OR REPLACE INTO sync_rows/.test(s)) {
          const [uid, entity, event_uid, patient_uid, deleted, updated_at, data, rowSeq] =
            this._binds;
          store.set(uid, {
            uid,
            entity,
            event_uid,
            patient_uid,
            deleted,
            updated_at,
            data,
            seq: rowSeq != null ? rowSeq : null,
          });
          return { success: true, meta: { changes: 1 } };
        }
        throw new Error('fake D1: unsupported run() SQL: ' + s);
      },
      async all() {
        const s = this._sql;
        const bySeq = /IFNULL\(seq, 0\) > \?/.test(s);
        if (bySeq || /SELECT .* FROM sync_rows WHERE updated_at > \?/.test(s)) {
          const hasEvent = /event_uid = \?/.test(s);
          let since, eventUid, limit;
          if (hasEvent) {
            [since, eventUid, limit] = this._binds;
          } else {
            [since, limit] = this._binds;
          }
          let rows = Array.from(store.values()).filter((r) =>
            bySeq
              ? Number(r.seq || 0) > Number(since)
              : String(r.updated_at) > String(since)
          );
          if (hasEvent) rows = rows.filter((r) => r.event_uid === eventUid);
          const key = (r) => (bySeq ? Number(r.seq || 0) : r.updated_at);
          rows.sort((a, b) => {
            const ka = key(a), kb = key(b);
            if (ka < kb) return -1;
            if (ka > kb) return 1;
            return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
          });
          rows = rows.slice(0, limit);
          return { results: rows.map((r) => ({ ...r })) };
        }
        throw new Error('fake D1: unsupported all() SQL: ' + s);
      },
    };
  }

  return { prepare, _store: store };
}

// ---------------------------------------------------------------------------
// Helper to invoke the worker like a real HTTP request.
// ---------------------------------------------------------------------------
async function call(env, method, path, { auth, body } = {}) {
  const headers = {};
  if (auth) headers['Authorization'] = 'Bearer ' + auth;
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const req = new Request('https://sync.example.com' + path, init);
  const res = await worker.fetch(req, env, {});
  let data = null;
  try {
    data = await res.json();
  } catch (_e) {
    data = null;
  }
  return { status: res.status, data, res };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function main() {
  const env = { CLINIC_KEY, DB: makeFakeD1() };

  // --- /health (no auth) ---
  const h = await call(env, 'GET', '/health');
  check(
    '/health ok',
    h.status === 200 &&
      h.data &&
      h.data.ok === true &&
      h.data.service === 'mmw-sync' &&
      h.data.version === '1.7.0' &&
      h.data.seq === true &&
      typeof h.data.time === 'string'
  );

  // --- push without auth -> 401 ---
  const noAuth = await call(env, 'POST', '/v1/push', {
    body: { device_id: 'd1', rows: [] },
  });
  check(
    'push without auth -> 401',
    noAuth.status === 401 && noAuth.data && noAuth.data.ok === false
  );

  // --- push with wrong bearer -> 401 ---
  const badAuth = await call(env, 'POST', '/v1/push', {
    auth: 'not-the-key',
    body: { device_id: 'd1', rows: [] },
  });
  check('push with wrong bearer -> 401', badAuth.status === 401);

  // --- push with correct bearer -> applied count (+ 1 invalid row skipped) ---
  const rows1 = [
    {
      entity: 'event',
      uid: 'evt-1',
      event_uid: null,
      updated_at: '2026-07-04T03:00:00.000Z',
      data: { name: 'Field Day Clinic' },
    },
    {
      entity: 'patient',
      uid: 'pat-1',
      event_uid: 'evt-1',
      updated_at: '2026-07-04T03:05:00.000Z',
      data: { name: 'Alice', vitals_by_name: 'Nurse Joy' },
    },
    {
      entity: 'patient',
      uid: 'pat-2',
      event_uid: 'evt-2',
      updated_at: '2026-07-04T03:06:00.000Z',
      data: { name: 'Bob' },
    },
    // invalid: missing updated_at + data -> must be skipped
    { uid: 'bad-row', entity: 'patient' },
  ];
  const push1 = await call(env, 'POST', '/v1/push', {
    auth: CLINIC_KEY,
    body: { device_id: 'd1', rows: rows1 },
  });
  check(
    'push applied=3 skipped=1 (invalid skipped)',
    push1.status === 200 &&
      push1.data.ok === true &&
      push1.data.applied === 3 &&
      push1.data.skipped === 1 &&
      typeof push1.data.time === 'string'
  );

  // --- LWW: older updated_at is skipped ---
  const older = await call(env, 'POST', '/v1/push', {
    auth: CLINIC_KEY,
    body: {
      device_id: 'd1',
      rows: [
        {
          entity: 'patient',
          uid: 'pat-1',
          event_uid: 'evt-1',
          updated_at: '2026-07-04T02:00:00.000Z', // older than stored 03:05
          data: { name: 'Alice STALE' },
        },
      ],
    },
  });
  check(
    'LWW older updated_at skipped',
    older.data.applied === 0 && older.data.skipped === 1
  );

  // --- LWW: newer updated_at is applied ---
  const newer = await call(env, 'POST', '/v1/push', {
    auth: CLINIC_KEY,
    body: {
      device_id: 'd1',
      rows: [
        {
          entity: 'patient',
          uid: 'pat-1',
          event_uid: 'evt-1',
          updated_at: '2026-07-04T04:00:00.000Z', // newer than stored
          data: { name: 'Alice FRESH' },
        },
      ],
    },
  });
  check(
    'LWW newer updated_at applied',
    newer.data.applied === 1 && newer.data.skipped === 0
  );

  // --- pull since returns rows in asc order with a cursor ---
  const pull = await call(
    env,
    'GET',
    '/v1/pull?since=2026-07-04T00:00:00.000Z&limit=500',
    { auth: CLINIC_KEY }
  );
  const uats = pull.data.rows.map((r) => r.updated_at);
  const ascending = uats.every((v, i, a) => i === 0 || a[i - 1] <= v);
  check(
    'pull ok + 3 rows + ascending order',
    pull.status === 200 &&
      pull.data.ok === true &&
      pull.data.rows.length === 3 &&
      ascending
  );
  check(
    'pull data parsed back to objects',
    pull.data.rows.every(
      (r) => r.data && typeof r.data === 'object' && !Array.isArray(r.data)
    )
  );
  const lastUat = pull.data.rows[pull.data.rows.length - 1].updated_at;
  check(
    'pull cursor = last updated_at',
    pull.data.cursor === lastUat && lastUat === '2026-07-04T04:00:00.000Z'
  );
  check('pull more=false when limit not hit', pull.data.more === false);
  check(
    'pull reflects LWW winner (Alice FRESH)',
    pull.data.rows.find((r) => r.uid === 'pat-1').data.name === 'Alice FRESH'
  );

  // --- pull with event_uid filters ---
  const pullEvt = await call(
    env,
    'GET',
    '/v1/pull?since=2026-07-04T00:00:00.000Z&event_uid=evt-1',
    { auth: CLINIC_KEY }
  );
  check(
    'pull event_uid=evt-1 only returns that event\'s rows',
    pullEvt.data.rows.length === 1 &&
      pullEvt.data.rows[0].uid === 'pat-1' &&
      pullEvt.data.rows.every((r) => r.event_uid === 'evt-1')
  );
  check(
    'pull event_uid filter excludes evt-2 patient',
    pullEvt.data.rows.every((r) => r.uid !== 'pat-2')
  );

  // --- pull with empty result: cursor = incoming since ---
  const pullEmpty = await call(
    env,
    'GET',
    '/v1/pull?since=2030-01-01T00:00:00.000Z',
    { auth: CLINIC_KEY }
  );
  check(
    'pull empty -> cursor = since, more=false',
    pullEmpty.data.rows.length === 0 &&
      pullEmpty.data.cursor === '2030-01-01T00:00:00.000Z' &&
      pullEmpty.data.more === false
  );

  // --- pull with limit hit -> more=true ---
  const pullLim = await call(
    env,
    'GET',
    '/v1/pull?since=2026-07-04T00:00:00.000Z&limit=1',
    { auth: CLINIC_KEY }
  );
  check(
    'pull more=true when limit hit',
    pullLim.data.rows.length === 1 && pullLim.data.more === true
  );

  // --- unknown /v1 route -> 404 ---
  const notFound = await call(env, 'GET', '/v1/nope', { auth: CLINIC_KEY });
  check('unknown /v1 route -> 404', notFound.status === 404);

  // --- unknown top-level route -> 404 ---
  const notFound2 = await call(env, 'GET', '/whatever');
  check('unknown top-level route -> 404', notFound2.status === 404);

  // --- wrong method on push -> 405 ---
  const wrongMethod = await call(env, 'GET', '/v1/push', { auth: CLINIC_KEY });
  check('GET /v1/push -> 405', wrongMethod.status === 405);

  // --- wrong method on health -> 405 ---
  const healthPost = await call(env, 'POST', '/health');
  check('POST /health -> 405', healthPost.status === 405);

  // --- OPTIONS preflight -> 204 with CORS headers ---
  const opt = await call(env, 'OPTIONS', '/v1/push');
  check(
    'OPTIONS preflight -> 204 + CORS',
    opt.status === 204 &&
      opt.res.headers.get('Access-Control-Allow-Origin') === '*'
  );

  // --- CORS header present on a normal JSON response ---
  check(
    'CORS header on /health response',
    h.res.headers.get('Access-Control-Allow-Origin') === '*'
  );

  // --- push accepts data already given as a JSON string ---
  const strData = await call(env, 'POST', '/v1/push', {
    auth: CLINIC_KEY,
    body: {
      device_id: 'd1',
      rows: [
        {
          entity: 'triage',
          uid: 'tri-1',
          patient_uid: 'pat-1',
          updated_at: '2026-07-04T05:00:00.000Z',
          data: JSON.stringify({ bp: '120/80' }),
        },
      ],
    },
  });
  const pullStr = await call(
    env,
    'GET',
    '/v1/pull?since=2026-07-04T04:30:00.000Z',
    { auth: CLINIC_KEY }
  );
  const triRow = pullStr.data.rows.find((r) => r.uid === 'tri-1');
  check(
    'push string data round-trips to an object on pull',
    strData.data.applied === 1 &&
      triRow &&
      typeof triRow.data === 'object' &&
      triRow.data.bp === '120/80'
  );

  // --- Pre-registration (public /checkin) — event 'evt-1' was pushed above ---
  // v1.6.2 requires an emergency contact and an answer to every history
  // question, so every submission below carries them unless it is the one
  // deliberately leaving something out. v0.0.15: the history is Dr. Trinh's
  // form — 25 conditions answered, the allergy gate, medications (or none),
  // major surgery, "Do you smoke?" — and Step 3 is his eight questions.
  const NO_CONDITIONS = Object.fromEntries(INTAKE_CONDITIONS.map((k) => [k, k === 'pregnant' ? 'na' : 'no']));
  const REQ = {
    form_version: 2,
    // Required online since v0.0.15, as it always was at the kiosk.
    phone: '5550002222',
    emergency_name: 'Kin Contact', emergency_phone: '5550001111',
    under_treatment: 'no', condition_answers: NO_CONDITIONS, medications_none: true,
    major_surgery: 'no', tobacco: 'no', allergy_status: 'nkda',
    pain_cold: 'no', pain_hot: 'no', pain_eating: 'no', toothache_night: 'no',
    pain_touch: 'no', grinding_night: 'no', jaw_pain_waking: 'no', sores: 'no',
    // Required since the last-dental-visit question became a closed dropdown.
    prior_dentist: 'about_2_years',
    // Required since the online form started asking which clinics to queue for.
    services: ['dental'],
  };
  async function getText(path) {
    const res = await worker.fetch(new Request('https://sync.example.com' + path, { method: 'GET' }), env, {});
    return { status: res.status, ctype: res.headers.get('content-type') || '', text: await res.text() };
  }
  const formGet = await getText('/checkin/evt-1');
  check('GET /checkin/<event> serves the HTML form for that event',
    formGet.status === 200 && /text\/html/.test(formGet.ctype) && formGet.text.includes('Field Day Clinic') && /Pre-registration/i.test(formGet.text));

  const badGet = await getText('/checkin/does-not-exist');
  check('GET /checkin/<unknown> -> 404 error page', badGet.status === 404 && /not valid|not found/i.test(badGet.text));

  // Full check-in-parity submission WITH a signed general consent.
  const preReg = await call(env, 'POST', '/checkin/evt-1', {
    body: { ...REQ,
      first_name: 'Pre', last_name: 'Reg', dob: '1990-01-02', gender: 'female', phone: '(555) 123-4567', language: 'es',
      address: '1 Main St', city: 'Sandy', state: 'OR', emergency_name: 'Kin', emergency_phone: '5550001111',
      visit_type: 'filling', allergy_status: 'yes', allergies: ['penicillin', 'other', 'made_up'], allergies_other: 'shellfish',
      condition_answers: { ...NO_CONDITIONS, diabetes: 'yes', bleeding: 'unsure' }, conditions_other: 'Gout',
      medications_none: false, med_keys: ['metformin', 'warfarin', 'not_a_drug'], medications_other: ['Fish oil'],
      major_surgery: 'yes', surgery_sites: ['knee', 'spleen'],
      under_treatment: 'yes', tobacco: 'no', pain_cold: 'yes', prior_dentist: 'about_2_years',
      // A retired Step 3 question posted straight to the endpoint.
      gum_bleeding: 'yes',
      consent_agree: true, signer_name: 'Pre Reg', relationship: 'Self', signature_png: 'data:image/png;base64,AAAA',
    },
  });
  check('POST /checkin/<event> accepts a full submission with a signed consent', preReg.status === 200 && preReg.data && preReg.data.ok === true);

  const stored = Array.from(env.DB._store.values()).find((r) => r.entity === 'patient' && r.event_uid === 'evt-1' && /@prereg$/.test(String(r.updated_at)));
  const pd = stored ? JSON.parse(stored.data) : null;
  check('pre-registration is stored as a checked-in patient row scoped to the event',
    !!pd && pd.status === 'checked_in' && pd.first_name === 'Pre' && pd.last_name === 'Reg');
  const demo = pd ? JSON.parse(pd.demographics) : null;
  const mh = pd ? JSON.parse(pd.medical_history) : null;
  const dh = pd ? JSON.parse(pd.dental_history) : null;
  check('pre-registration maps ALL the in-person options natively (parity)',
    !!demo && demo.preregistered === true && demo.address === '1 Main St' && demo.city === 'Sandy' && demo.state === 'OR' && demo.emergency_name === 'Kin' && pd.phone === '5551234567' &&
    !!mh && mh.history_version === 2 && mh.allergy_status === 'yes' && mh.allergies.includes('penicillin') && mh.allergies_other === 'shellfish' &&
    mh.condition_answers.diabetes === 'yes' && mh.condition_answers.bleeding === 'unsure' && mh.under_treatment === 'yes' && mh.tobacco === 'no' &&
    !!dh && dh.visit_type === 'filling' && dh.pain_cold === 'yes' && dh.prior_dentist === 'about_2_years');
  // The walk-in form's own normaliser, run over the same answers, must produce
  // the very history the online form stored — derived fields and all. This is
  // what makes the blood-thinner rules, the report counts and the flags read a
  // pre-registration exactly as they read a walk-in.
  {
    const expected = normalizeMedical({
      under_treatment: 'yes', condition_answers: { ...NO_CONDITIONS, diabetes: 'yes', bleeding: 'unsure' }, conditions_other: 'Gout',
      medications: [{ key: 'metformin', name: 'Metformin (Glucophage)' }, { key: 'warfarin', name: 'Warfarin (Coumadin)' }, { key: 'other', name: 'Fish oil' }],
      major_surgery: 'yes', surgery_sites: ['knee'], tobacco: 'no',
      allergy_status: 'yes', allergies: ['penicillin', 'other'], allergies_other: 'shellfish',
    });
    // Key order is not meaning, so both sides are compared with their keys
    // sorted at EVERY depth. (A replacer array would not do: it filters nested
    // keys too, and condition_answers and each medication row compared as {}.)
    const stable = (v) => (Array.isArray(v) ? v.map(stable)
      : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
    const sorted = (o) => JSON.stringify(stable(o));
    check('the comparison below sees the answers and the medications themselves',
      sorted({ a: { x: 1 }, m: [{ key: 'warfarin' }] }) !== sorted({ a: { x: 2 }, m: [{ key: 'aspirin' }] }));
    check('the online history is exactly what the walk-in form would store for the same answers', !!mh && sorted(mh) === sorted(expected));
    check('derived for the report and the flags: conditions = the Yes answers plus the typed one',
      !!mh && JSON.stringify(mh.conditions) === JSON.stringify(['diabetes', 'other']) && mh.conditions_other === 'Gout');
    check('checklist medications are stored by key with the canonical name the blood-thinner rules recognise',
      !!mh && mh.medications.some((x) => x.key === 'warfarin' && x.name === 'Warfarin (Coumadin)') && mh.medications.some((x) => x.key === 'other' && x.name === 'Fish oil'));
    check('only keys the form offers are stored (an invented allergy, drug or body site is dropped)',
      !!mh && !mh.allergies.includes('made_up') && !mh.medications.some((x) => x.key === 'not_a_drug') && JSON.stringify(mh.surgery_sites) === '["knee"]');
    check('a retired Step 3 answer posted straight to the endpoint is not stored', !!dh && dh.gum_bleeding === undefined);
  }
  // The free-text reason is gone from BOTH forms. If the online one kept posting
  // it, pre-registrations would be the only records carrying it and the report
  // would show a split nobody could see.
  check('C2: pre-registration no longer stores a free-text reason', !!dh && dh.reason === undefined);
  // And a free-text value posted directly to the endpoint must not be stored.
  const junkDent = await call(env, 'POST', '/checkin/evt-1', {
    body: { ...REQ, first_name: 'Junk', last_name: 'Dent', dob: '1990-01-02', gender: 'male', phone: '5551112222',
      city: 'Sandy', state: 'OR', visit_type: 'cleaning', prior_dentist: 'a while ago',
      consent_agree: true, signer_name: 'Junk Dent', signature_png: 'data:image/png;base64,AAAA' },
  });
  check('C2: a free-text last-dental-visit posted straight to the endpoint is rejected, naming the question',
    junkDent.status === 400 && /When did you last see a dentist\?/.test(junkDent.data.error));

  // The general consent must be written as a consent row bound to that patient.
  const gConsent = Array.from(env.DB._store.values()).find((r) => r.entity === 'consent' && r.patient_uid === stored.uid && JSON.parse(r.data).type === 'general');
  const gc = gConsent ? JSON.parse(gConsent.data) : null;
  check('a SIGNED general consent is filed with the patient (routes into the chart)',
    !!gc && gc.type === 'general' && gc.signer_name === 'Pre Reg' && gc.relationship === 'Self' && typeof gc.signature_png === 'string' && /^general-oregon-es/.test(gc.version) && gConsent.event_uid === 'evt-1');

  // Birthdate and gender are REQUIRED (Sandy Oregon clinic request).
  const noDob = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, first_name: 'No', last_name: 'Dob', gender: 'male', visit_type: 'cleaning', consent_agree: true } });
  check('POST /checkin without a date of birth -> 400', noDob.status === 400 && /date of birth/i.test(noDob.data.error));
  const noGender = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, first_name: 'No', last_name: 'Gender', dob: '1990-01-01', visit_type: 'cleaning', consent_agree: true } });
  check('POST /checkin without a gender -> 400', noGender.status === 400 && /gender/i.test(noGender.data.error));
  // City + state are REQUIRED too — grant-funded clinics report town of origin.
  const noCity = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, first_name: 'No', last_name: 'City', dob: '1990-01-01', gender: 'male', state: 'OR', visit_type: 'cleaning', consent_agree: true } });
  check('POST /checkin without a city -> 400', noCity.status === 400 && /city/i.test(noCity.data.error));
  const noState = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, first_name: 'No', last_name: 'State', dob: '1990-01-01', gender: 'male', city: 'Sandy', visit_type: 'cleaning', consent_agree: true } });
  check('POST /checkin without a state -> 400', noState.status === 400 && /state/i.test(noState.data.error));
  const noCityEs = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, first_name: 'Sin', last_name: 'Ciudad', dob: '1990-01-01', gender: 'male', state: 'OR', language: 'es', consent_agree: true } });
  check('POST /checkin (es) without a city -> Spanish 400', noCityEs.status === 400 && /ciudad/i.test(noCityEs.data.error));

  // A Spanish submission gets Spanish validation errors.
  const noDobEs = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, first_name: 'Sin', last_name: 'Fecha', gender: 'male', language: 'es', consent_agree: true } });
  check('POST /checkin (es) without a date of birth -> Spanish 400', noDobEs.status === 400 && /fecha de nacimiento/i.test(noDobEs.data.error));

  // General consent is REQUIRED — a submission without it is rejected.
  const noConsent = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, first_name: 'No', last_name: 'Consent', dob: '1990-01-01', gender: 'male', city: 'Sandy', state: 'OR', visit_type: 'cleaning' } });
  check('POST /checkin without agreeing to the consent -> 400', noConsent.status === 400 && /consent/i.test(noConsent.data.error));

  // v1.6.0: consent must be SIGNED, not just ticked. A pre-registration without
  // a signature would reach the clinic looking complete while the dentist still
  // has to stop and capture consent at the chair.
  const base = { first_name: 'Un', last_name: 'Signed', dob: '1990-01-01', gender: 'male', city: 'Sandy', state: 'OR', visit_type: 'cleaning' };
  const noSig = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, ...base, consent_agree: true, signer_name: 'Un Signed' } });
  check('POST /checkin agreed but NOT signed -> 400', noSig.status === 400 && /sign the consent/i.test(noSig.data.error));
  const noSigner = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, ...base, consent_agree: true, signature_png: 'data:image/png;base64,AAAA' } });
  check('POST /checkin signed but no name typed -> 400', noSigner.status === 400 && /type your name/i.test(noSigner.data.error));
  const noSigEs = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, ...base, language: 'es', consent_agree: true, signer_name: 'Sin Firma' } });
  check('POST /checkin (es) not signed -> Spanish 400', noSigEs.status === 400 && /firme el consentimiento/i.test(noSigEs.data.error));

  // An extraction ALSO needs the Oral Surgery consent signed — a general
  // signature alone is not enough.
  const exNoSurgerySig = await call(env, 'POST', '/checkin/evt-1', {
    body: { ...REQ, ...base, last_name: 'Extraction', visit_type: 'extraction_pain', consent_agree: true, signer_name: 'Un Signed',
      signature_png: 'data:image/png;base64,AAAA', surgery_agree: true },
  });
  check('POST /checkin extraction agreed but surgery NOT signed -> 400',
    exNoSurgerySig.status === 400 && /sign the oral surgery/i.test(exNoSurgerySig.data.error));

  // A NON-extraction visit must NOT be asked for the surgery consent.
  const cleaningOk = await call(env, 'POST', '/checkin/evt-1', {
    body: { ...REQ, ...base, last_name: 'Cleaning', consent_agree: true, signer_name: 'Un Signed', signature_png: 'data:image/png;base64,AAAA' },
  });
  check('POST /checkin cleaning needs only the general consent -> 200', cleaningOk.status === 200 && cleaningOk.data.ok === true);
  const cleanRow = Array.from(env.DB._store.values()).find((r) => r.entity === 'patient' && JSON.parse(r.data).last_name === 'Cleaning');
  const cleanConsents = Array.from(env.DB._store.values()).filter((r) => r.entity === 'consent' && r.patient_uid === cleanRow.uid);
  check('a cleaning files exactly one consent, and it carries a signature',
    cleanConsents.length === 1 && JSON.parse(cleanConsents[0].data).type === 'general' &&
    /^data:image\//.test(JSON.parse(cleanConsents[0].data).signature_png || ''));

  // The form itself marks both signatures required.
  const sigForm = await getText('/checkin/evt-1');
  check('the form marks the signature required and blocks submit until it is drawn',
    /Signature <span class="req">\*<\/span>/.test(sigForm.text) &&
    sigForm.text.includes('T.errSign') && sigForm.text.includes('T.errSignSurgery') &&
    !/Signature \(optional\)/.test(sigForm.text));

  // An extraction visit also requires (and files) the Oral Surgery consent.
  const noSurgery = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, first_name: 'Ex', last_name: 'Tract', dob: '1990-01-01', gender: 'male', city: 'Sandy', state: 'OR', visit_type: 'extraction_pain', consent_agree: true, signer_name: 'Ex Tract', signature_png: 'data:image/png;base64,BBBB' } });
  check('POST /checkin extraction without surgery consent -> 400', noSurgery.status === 400 && /surgery/i.test(noSurgery.data.error));
  const withSurgery = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, first_name: 'Ex', last_name: 'Tract', dob: '1990-01-01', gender: 'male', city: 'Sandy', state: 'OR', visit_type: 'extraction_pain', consent_agree: true, surgery_agree: true, surgery_teeth: '14, 15', signer_name: 'Ex Tract', signature_png: 'data:image/png;base64,BBBB', surgery_signature_png: 'data:image/png;base64,CCCC' } });
  check('POST /checkin extraction WITH surgery consent -> 200', withSurgery.status === 200 && withSurgery.data.ok === true);
  const exPatient = Array.from(env.DB._store.values()).find((r) => r.entity === 'patient' && JSON.parse(r.data).last_name === 'Tract');
  const surgeryRow = Array.from(env.DB._store.values()).find((r) => r.entity === 'consent' && r.patient_uid === exPatient.uid && JSON.parse(r.data).type === 'oral_surgery');
  const sc = surgeryRow ? JSON.parse(surgeryRow.data) : null;
  check('the Oral Surgery consent is filed with tooth numbers + signature',
    !!sc && sc.type === 'oral_surgery' && sc.tooth_numbers === '14, 15' && typeof sc.signature_png === 'string');

  const noName = await call(env, 'POST', '/checkin/evt-1', { body: { ...REQ, ...REQ, first_name: '', last_name: '', consent_agree: true } });
  check('POST /checkin with no name -> 400', noName.status === 400 && noName.data.ok === false);

  const postBadEvent = await call(env, 'POST', '/checkin/does-not-exist', { body: { ...REQ, ...REQ, first_name: 'A', last_name: 'B', consent_agree: true } });
  check('POST /checkin/<unknown> -> 404 (only real events accept submissions)', postBadEvent.status === 404 && postBadEvent.data.ok === false);

  // The GET form now carries the FULL option set + consent text.
  const fullForm = await getText('/checkin/evt-1');
  check('the pre-registration form carries the full check-in options + consent to sign',
    /Azithromycin \/ Erythromycin \/ Clarithromycin/.test(fullForm.text) && /Osteoporosis \/ Bone Disease/.test(fullForm.text) && /Sleep Apnea/.test(fullForm.text) &&
    /Warfarin \(Coumadin\)/.test(fullForm.text) && /name="surgery_site" value="knee"/.test(fullForm.text) &&
    /Hold Harmless/.test(fullForm.text) && /Consent for Oral Surgery/.test(fullForm.text) && /id="gsig"/.test(fullForm.text));
  check('the 25 conditions are each a dropdown with a namespaced id (kidney and liver are surgery sites too)',
    (fullForm.text.match(/<select id="cond_[a-z_]+">/g) || []).length === 25 && !/id="kidney"|id="liver"/.test(fullForm.text));
  check('the retired conditions are no longer asked online',
    !/Rheumatic fever|Weight management program|Heart murmur/.test(fullForm.text));
  // The question wording must match the app's in-person check-in EXACTLY.
  check('the pre-registration questions use the app\'s exact wording',
    fullForm.text.includes('What do you need today?') &&
    !fullForm.text.includes('Reason for today’s visit') &&   // C2: removed from both forms
    fullForm.text.includes('Within the past 6 months') &&    // C2: the dropdown, not a text box
    fullForm.text.includes('Never') &&
    fullForm.text.includes('Are you currently under a doctor’s care?') &&
    fullForm.text.includes('Major surgery within the past 6 months?') &&
    fullForm.text.includes('Do you smoke?') &&
    fullForm.text.includes('Do you have an allergy or serious reaction to any medication?') &&
    fullForm.text.includes('No known drug allergies (NKDA)') &&
    fullForm.text.includes('When did you last see a dentist?') &&
    fullForm.text.includes('Does the toothache wake you up at night?') &&
    !fullForm.text.includes('Hospitalized in the last 2 years?') &&
    !fullForm.text.includes('History of bleeding after a tooth was pulled?') &&
    fullForm.text.includes('Extraction — no pain') &&
    fullForm.text.includes('Check all that apply') &&
    fullForm.text.includes('I have read and understand the above, and I consent.'));

  // City + State fields are collected on the pre-registration form (Sandy Oregon grant reporting).
  check('the pre-registration form collects City and State',
    /id="city"/.test(fullForm.text) && /id="state"/.test(fullForm.text) &&
    fullForm.text.includes('City') && fullForm.text.includes('State'));
  // ...and they are marked required, with the browser blocking submit.
  check('the pre-registration form marks City and State required',
    fullForm.text.includes("if(!val('city'))") && fullForm.text.includes("if(!val('state'))") &&
    /City <span class="req">\*<\/span>/.test(fullForm.text) && /State <span class="req">\*<\/span>/.test(fullForm.text));
  // DOB and gender are marked required on the form (asterisk + client-side validation).
  check('the pre-registration form marks date of birth and gender required',
    /id="dob"/.test(fullForm.text) && /id="gender"/.test(fullForm.text) &&
    fullForm.text.includes("if(!val('dob'))") && fullForm.text.includes("if(!val('gender'))"));
  // The clinic's own medication list, on the rendered form. A datalist rather
  // than a select: it suggests, but a patient on a drug outside the hundred must
  // still be recordable — the provider reads this before deciding what is safe.
  check('the form suggests the clinic medication list',
    /<datalist id="medlist">/.test(fullForm.text) &&
    /value="Atorvastatin"/.test(fullForm.text) && /value="Metformin"/.test(fullForm.text) &&
    (fullForm.text.match(/<option value="[^"]*"><\/option>/g) || []).length >= 100);
  // Dr. Trinh's allergy list, and none of the retired items.
  check('the form offers Dr. Trinh\'s allergy list',
    /name="allergy" value="sulfa">Sulfa antibiotics/.test(fullForm.text) && /Cephalosporins/.test(fullForm.text) &&
    /Lidocaine \/ local anesthetic/.test(fullForm.text) && /General anesthetic/.test(fullForm.text) && /Clindamycin/.test(fullForm.text) &&
    (fullForm.text.match(/name="allergy" value=/g) || []).length === 25);
  check('the retired allergies (Mepivacaine, Articaine…) are no longer offered online',
    !/Mepivacaine|Articaine|Bupivacaine|Prilocaine|Amoxicillin \+ clavulanate/.test(fullForm.text));

  // The two forms must agree about what a COMPLETE medical history is. The
  // walk-in form gives pregnancy a third answer, because making a man or a child
  // tap "No" makes their answer indistinguishable from the clinically loaded No
  // the dentist reads. This form has to accept the same, and only on that
  // question.
  const selectBody = (id) => ((fullForm.text.match(new RegExp('<select id="' + id + '">([\\s\\S]*?)</select>')) || [])[1] || '');
  check('the form offers "Not applicable" on the pregnancy row only',
    /value="na"/.test(selectBody('cond_pregnant')) && !/value="na"/.test(selectBody('cond_autoimmune')) &&
    !/value="na"/.test(selectBody('tobacco')) && /value="unsure"/.test(selectBody('cond_diabetes')));
  const naPreg = await call(env, 'POST', '/checkin/evt-1', {
    body: { ...REQ, first_name: 'Not', last_name: 'Applicable', dob: '1970-01-02', gender: 'male',
      phone: '5551234567', city: 'Sandy', state: 'OR', visit_type: 'cleaning',
      condition_answers: { ...NO_CONDITIONS, pregnant: 'na' },
      consent_agree: true, signer_name: 'Not Applicable', signature_png: 'data:image/png;base64,AAAA' },
  });
  check('a pregnancy answer of "Not applicable" is accepted, not refused as unanswered', naPreg.status === 200);
  const naRow = Array.from(env.DB._store.values())
    .filter((r) => r.entity === 'patient').map((r) => JSON.parse(r.data))
    .find((x) => x.last_name === 'Applicable');
  check('and it is stored as "na", the same code the walk-in form uses',
    !!naRow && JSON.parse(naRow.medical_history).condition_answers.pregnant === 'na');
  const junkPreg = await call(env, 'POST', '/checkin/evt-1', {
    body: { ...REQ, first_name: 'Junk', last_name: 'Preg', dob: '1970-01-02', gender: 'male',
      phone: '5551234567', city: 'Sandy', state: 'OR', visit_type: 'cleaning',
      condition_answers: { ...NO_CONDITIONS, pregnant: 'maybe' },
      consent_agree: true, signer_name: 'Junk Preg', signature_png: 'data:image/png;base64,AAAA' },
  });
  check('a value that is not yes/no/unsure/na is still refused', junkPreg.status === 400);
  const naElsewhere = await call(env, 'POST', '/checkin/evt-1', {
    body: { ...REQ, first_name: 'Na', last_name: 'Diabetes', dob: '1970-01-02', gender: 'male',
      phone: '5551234567', city: 'Sandy', state: 'OR', visit_type: 'cleaning',
      condition_answers: { ...NO_CONDITIONS, diabetes: 'na' },
      consent_agree: true, signer_name: 'Na Diabetes', signature_png: 'data:image/png;base64,AAAA' },
  });
  check('"Not applicable" is refused on any row but pregnancy, naming the question',
    naElsewhere.status === 400 && /Diabetes – Type 1 or Type 2/.test(naElsewhere.data.error));

  // The English form offers a link to switch to Spanish.
  check('the English form links to the Spanish version',
    /\?lang=es/.test(fullForm.text) && fullForm.text.includes('Español'));

  // --- Spanish pre-registration (?lang=es) — full parity in Spanish ---
  const esForm = await getText('/checkin/evt-1?lang=es');
  check('GET /checkin/<event>?lang=es serves the Spanish form',
    esForm.status === 200 && /text\/html/.test(esForm.ctype) &&
    esForm.text.includes('Sobre usted') &&
    esForm.text.includes('¿Qué necesita hoy?') &&
    !esForm.text.includes('Motivo de la visita de hoy') &&
    esForm.text.includes('En los últimos 6 meses') &&        // C2: Spanish dropdown options
    esForm.text.includes('Nunca') &&
    esForm.text.includes('Ciudad') && esForm.text.includes('Estado'));
  check('the Spanish form offers "No aplica" on the pregnancy question',
    /value="na">No aplica/.test(esForm.text));
  check('the Spanish form carries the Spanish consent + agree text',
    esForm.text.includes('Consentimiento General para Tratamiento Dental') &&
    esForm.text.includes('He leído y entiendo lo anterior, y doy mi consentimiento.'));
  check('the Spanish form links back to English',
    /\?lang=en/.test(esForm.text) && esForm.text.includes('English'));
  // A Spanish submission still round-trips (writes a checked-in patient + Spanish-versioned consent).
  const esSubmit = await call(env, 'POST', '/checkin/evt-1', {
    body: { ...REQ, first_name: 'Ana', last_name: 'Ruiz', dob: '1988-05-05', gender: 'female', language: 'es', city: 'Sandy', state: 'OR',
      visit_type: 'cleaning', consent_agree: true, signer_name: 'Ana Ruiz', relationship: 'Self', signature_png: 'data:image/png;base64,DDDD' },
  });
  check('POST /checkin (es) full submission -> 200', esSubmit.status === 200 && esSubmit.data.ok === true);
  const esStored = Array.from(env.DB._store.values()).find((r) => r.entity === 'patient' && JSON.parse(r.data).last_name === 'Ruiz');
  const esPat = esStored ? JSON.parse(esStored.data) : null;
  const esDemo = esPat ? JSON.parse(esPat.demographics) : null;
  check('Spanish pre-registration saves language, city, and state',
    !!esPat && esPat.language === 'es' && !!esDemo && esDemo.city === 'Sandy' && esDemo.state === 'OR');

  // --- v1.5.0: delivery is ordered by the SERVER's counter, never by a clock ---
  // Regression for the bug where patients registered on one laptop never
  // appeared on another. Rows used to be handed out in timestamp order against a
  // high-water-mark cursor, so any row that arrived with an older stamp — an
  // offline check-in, or anything written by a laptop whose clock ran slow — fell
  // below another laptop's cursor and was skipped forever.
  {
    const env2 = { CLINIC_KEY, DB: makeFakeD1() };
    const T = (min, dev) => new Date(Date.parse('2026-07-30T17:00:00.000Z') + min * 60000).toISOString() + '@' + dev;
    const pushRows = (device, rows) => call(env2, 'POST', '/v1/push', { auth: CLINIC_KEY, body: { device_id: device, rows } });
    const pullFrom = (since) => call(env2, 'GET', '/v1/pull?since=' + encodeURIComponent(since) + '&limit=400', { auth: CLINIC_KEY });
    const pat = (uid, name, stamp) => ({
      entity: 'patient', uid, event_uid: 'evt-c', patient_uid: null, deleted: 0, updated_at: stamp,
      data: { first_name: name, last_name: 'X', status: 'checked_in', created_at: stamp.split('@')[0] },
    });
    const namesIn = (r) => (r.data.rows || []).filter((x) => x.entity === 'patient').map((x) => x.data.first_name);

    await pushRows('laptopA', [{ entity: 'event', uid: 'evt-c', event_uid: null, patient_uid: null, deleted: 0, updated_at: T(0, 'laptopA'), data: { name: 'Clinic', active: 1 } }]);

    // Laptop B's clock is 10 minutes FAST. It checks someone in and syncs, so its
    // cursor is now built from its own future-dated row.
    await pushRows('laptopB', [pat('p-fast', 'Bianca', T(10, 'laptopB'))]);
    const bFirst = await pullFrom('');
    const cursorB = bFirst.data.cursor;
    check('v1.5.0: the pull cursor is the server counter, not a timestamp', /^\d+$/.test(String(cursorB)) && bFirst.data.mode === 'seq');

    // Now a walk-in on the correctly-clocked laptop, and an online pre-registration.
    await pushRows('laptopA', [pat('p-walkin', 'Alberto', T(2, 'laptopA'))]);
    await pushRows('prereg', [pat('p-prereg', 'Ana', T(3, 'prereg'))]);

    const bAgain = await pullFrom(cursorB);
    const bSees = namesIn(bAgain);
    check('v1.5.0: a fast-clock laptop still receives patients registered on the others',
      bSees.includes('Alberto') && bSees.includes('Ana'));

    // The offline case: a laptop that was off the network all morning finally
    // pushes a patient whose stamp is HOURS older than everything already synced.
    const cursorAfter = bAgain.data.cursor;
    await pushRows('laptopC', [pat('p-offline', 'Olivia', T(-360, 'laptopC'))]);
    const afterOffline = await pullFrom(cursorAfter);
    check('v1.5.0: a back-dated offline check-in is still delivered (not skipped)',
      namesIn(afterOffline).includes('Olivia'));

    // And it is delivered exactly once — the cursor still advances normally.
    const settled = await pullFrom(afterOffline.data.cursor);
    check('v1.5.0: the cursor still advances (no repeat delivery loop)', settled.data.rows.length === 0);

    // An un-updated laptop (legacy timestamp cursor) keeps working unchanged, so
    // a clinic can update its stations one at a time.
    const legacy = await pullFrom('2026-07-30T17:01:00.000Z@old');
    check('v1.5.0: an older app\'s timestamp cursor is still served (rolling update)',
      legacy.data.mode === 'time' && String(legacy.data.cursor).includes('T') && namesIn(legacy).includes('Bianca'));
  }

  // --- v1.6.2: emergency contact + every history question are required ---
  {
    const full = {
      ...REQ, first_name: 'All', last_name: 'Answers', dob: '1990-01-01', gender: 'female',
      city: 'Sandy', state: 'OR', visit_type: 'cleaning', consent_agree: true,
      signer_name: 'All Answers', signature_png: 'data:image/png;base64,AAAA',
    };
    const post = (body) => call(env, 'POST', '/checkin/evt-1', { body });

    const okAll = await post(full);
    check('POST /checkin with every answer -> 200', okAll.status === 200 && okAll.data.ok === true);

    const noKin = await post({ ...full, emergency_name: '' });
    check('POST /checkin without an emergency contact name -> 400',
      noKin.status === 400 && /emergency contact name/i.test(noKin.data.error));
    const noKinPhone = await post({ ...full, emergency_phone: '' });
    check('POST /checkin without an emergency contact phone -> 400',
      noKinPhone.status === 400 && /emergency contact phone/i.test(noKinPhone.data.error));
    // v0.0.15: the phone number is required online, as it always was at the
    // kiosk — refused by name, in the kiosk's order (after City and State).
    const noPhone = await post({ ...full, phone: '' });
    check('POST /checkin without a phone number -> 400, naming it (required at the kiosk, so here)',
      noPhone.status === 400 && /phone number/i.test(noPhone.data.error) && !/emergency/i.test(noPhone.data.error));
    const noPhoneEs = await post({ ...full, language: 'es', phone: '(---)' });
    check('... in Spanish, and punctuation alone is not a phone number',
      noPhoneEs.status === 400 && /número de teléfono/.test(noPhoneEs.data.error));
    const noKinEs = await post({ ...full, language: 'es', emergency_name: '' });
    check('POST /checkin (es) without an emergency contact -> Spanish 400',
      noKinEs.status === 400 && /contacto de emergencia/i.test(noKinEs.data.error));

    // A blank history answer is not "no" — it has to be asked. Each refusal
    // names the question, as the walk-in form's does.
    const noMed = await post({ ...full, tobacco: '' });
    check('POST /checkin with an unanswered medical question -> 400, naming it',
      noMed.status === 400 && /every medical and dental history question/i.test(noMed.data.error) && /Do you smoke\?/.test(noMed.data.error));
    const noDent = await post({ ...full, pain_eating: '' });
    check('POST /checkin with an unanswered dental question -> 400, naming it',
      noDent.status === 400 && /every medical and dental history question/i.test(noDent.data.error) && /Any pain when eating\?/.test(noDent.data.error));
    const noMedEs = await post({ ...full, language: 'es', major_surgery: '' });
    check('POST /checkin (es) with an unanswered question -> Spanish 400, naming it',
      noMedEs.status === 400 && /historial médico y dental/i.test(noMedEs.data.error) && /Cirugía mayor/.test(noMedEs.data.error));
    // v0.0.15 closes the gap: allergies, conditions and medications were
    // optional online while the walk-in form required them.
    const needs = async (body, re, name) => { const r = await post(body); check(name, r.status === 400 && re.test(r.data.error)); };
    const noCond = { ...NO_CONDITIONS }; delete noCond.stroke;
    await needs({ ...full, condition_answers: noCond }, /Stroke \/ TIA/, 'a condition left unanswered is refused by name');
    await needs({ ...full, allergy_status: '' }, /allergy or serious reaction/, 'the allergy question is required online');
    await needs({ ...full, allergy_status: 'yes', allergies: [] }, /Medication allergies/, 'an allergy answer of Yes requires one ticked');
    await needs({ ...full, allergy_status: 'yes', allergies: ['other'], allergies_other: '' }, /Other allergy/, 'an Other allergy requires its name');
    await needs({ ...full, medications_none: false }, /Current medications/, 'medications are required online (a medication, or "No medications")');
    await needs({ ...full, major_surgery: 'yes', surgery_sites: [] }, /If so, where\?/, 'a Yes to major surgery requires where');
    await needs({ ...full, visit_type: '' }, /what you need today/i, 'what the patient needs today is required online, as at the kiosk');
    const unsureOk = await post({ ...full, first_name: 'Unsure', last_name: 'Allergy', allergy_status: 'unsure' });
    const unsureRow = Array.from(env.DB._store.values()).filter((r) => r.entity === 'patient').map((r) => JSON.parse(r.data)).find((x) => x.last_name === 'Allergy');
    check('an allergy answer of Unsure is accepted and stored as unsure, never as "none"',
      unsureOk.status === 200 && !!unsureRow && JSON.parse(unsureRow.medical_history).allergy_status === 'unsure' &&
      JSON.stringify(JSON.parse(unsureRow.medical_history).allergies) === '[]' && !JSON.parse(unsureRow.medical_history).allergies_none);

    // The form itself marks them required and blocks submit.
    const f = await getText('/checkin/evt-1');
    check('the form marks the phone number required and blocks submit without one',
      /Phone number <span class="req">\*<\/span><\/label><input type="tel" id="phone"/.test(f.text) && f.text.includes('T.errPhone'));
    check('the page says which form it is, from the one constant the server checks', f.text.includes('var payload={form_version:2,'));
    check('the form marks the emergency contact required',
      /id="emergency_name"/.test(f.text) && /Emergency contact name <span class="req">\*<\/span>/.test(f.text) &&
      f.text.includes("if(!val('emergency_name')"));
    check('the form marks every history question required and blocks submit',
      /Do you smoke\? <span class="req">\*<\/span>/.test(f.text) &&
      /Any pain when drinking cold water\? <span class="req">\*<\/span>/.test(f.text) &&
      /var CONDQ=/.test(f.text) && /var DENTQ=/.test(f.text) && f.text.includes('function missingHistory') && f.text.includes('T.errMedical'));
    // The page posts Step 3 from the same list it renders and the server checks,
    // so the three can never name different questions.
    check('the Step 3 answers are posted from the list the page renders, not a hand-kept copy',
      f.text.includes('DENTQ.forEach(function(k){payload[k]=val(k);})') && !/gum_bleeding|post_extraction_bleeding/.test(f.text));
    // A page opened before v0.0.15 posts the old shape; it is told to reload.
    const oldPage = await post({ first_name: 'Old', last_name: 'Page', dob: '1990-01-01', gender: 'female', city: 'Sandy', state: 'OR',
      emergency_name: 'K', emergency_phone: '5550001111', services: ['dental'], visit_type: 'cleaning',
      under_treatment: 'no', hospitalized: 'no', tobacco: 'no', pregnancy: 'no', allergies: ['none'], conditions: ['none'], medications_none: true,
      gum_bleeding: 'no', sores: 'no', jaw_injury: 'no', grinding: 'no', post_extraction_bleeding: 'no', ortho: 'no', prior_dentist: 'never',
      survey: { first_time: 'yes' }, survey_declined: false,
      consent_agree: true, signer_name: 'Old Page', signature_png: 'data:image/png;base64,AAAA' });
    check('a page opened before v0.0.15 is refused with "reload the page", not a list of questions it never showed',
      oldPage.status === 400 && /reload the page/i.test(oldPage.data.error));
    const oldPageEs = await post({ first_name: 'Vieja', last_name: 'Pagina', language: 'es', hospitalized: 'no', gum_bleeding: 'no' });
    check('... in Spanish too', oldPageEs.status === 400 && /cargar la página/i.test(oldPageEs.data.error));
    // From v0.0.15 a page says which form it is; one that is not this form is
    // told to reload however complete its answers look.
    const otherForm = await post({ ...full, first_name: 'Other', last_name: 'Version', form_version: 3 });
    check('a page that says it is a different form is told to reload the page',
      otherForm.status === 400 && /reload the page/i.test(otherForm.data.error));
  }

  // --- Online parity: services, referral, no survey, the City list ---
  // Everything the online form fails to ask has to be asked again at the desk,
  // which is the whole point of pre-registering.
  {
    const post = (body) => call(env, 'POST', '/checkin/evt-1', { body });
    const base = {
      ...REQ, dob: '1990-01-01', gender: 'female', city: 'Sandy', state: 'OR',
      visit_type: 'cleaning', consent_agree: true, signer_name: 'Pre Registrant', signature_png: 'data:image/png;base64,AAAA',
    };
    const patientNamed = (last) => Array.from(env.DB._store.values())
      .find((r) => r.entity === 'patient' && JSON.parse(r.data).last_name === last);
    const demoOf = (last) => { const p = patientNamed(last); return p ? JSON.parse(JSON.parse(p.data).demographics) : null; };
    const surveyOf = (last) => {
      const p = patientNamed(last);
      const row = p && Array.from(env.DB._store.values()).find((r) => r.entity === 'survey' && r.patient_uid === p.uid);
      return row ? { row, data: JSON.parse(row.data) } : null;
    };
    const en = await getText('/checkin/evt-1');
    const es = await getText('/checkin/evt-1?lang=es');

    // --- GAP 2: which services the patient needs ---
    check('the online form asks which services are needed, in both languages',
      /id="services"/.test(en.text) && en.text.includes('Services needed today') &&
      /name="service" value="dental"/.test(en.text) && /name="service" value="medical"/.test(en.text) && /name="service" value="vision"/.test(en.text) &&
      es.text.includes('Servicios que necesita hoy') && es.text.includes('Médico') && es.text.includes('Visión'));
    check('the online form marks the services question required and blocks submit',
      /Services needed today <span class="req">\*<\/span>/.test(en.text) && en.text.includes("checked('service').length") && en.text.includes('T.errServices'));
    const svcOk = await post({ ...base, first_name: 'Multi', last_name: 'Service', services: ['dental', 'vision'] });
    check('a submission stores every service the patient chose (it prints on the wristband)',
      svcOk.status === 200 && JSON.stringify((demoOf('Service') || {}).services) === JSON.stringify(['dental', 'vision']));
    const noSvc = await post({ ...base, first_name: 'No', last_name: 'Service', services: [] });
    check('POST /checkin with no service chosen -> 400', noSvc.status === 400 && /at least one service/i.test(noSvc.data.error));
    const noSvcEs = await post({ ...base, first_name: 'Sin', last_name: 'Servicio', language: 'es', services: [] });
    check('POST /checkin (es) with no service chosen -> Spanish 400', noSvcEs.status === 400 && /al menos un servicio/i.test(noSvcEs.data.error));
    const junkSvc = await post({ ...base, first_name: 'Junk', last_name: 'Service', services: ['dental-ish', 'podiatry'] });
    check('a junk service posted straight to the endpoint is rejected',
      junkSvc.status === 400 && /at least one service/i.test(junkSvc.data.error));

    // --- GAP 3: how they heard about us ---
    check('the online form asks how the patient heard about us, in both languages',
      /id="referral"/.test(en.text) && en.text.includes('How did you hear about us?') &&
      /<option value="friend_referral">Friend \/ referral<\/option>/.test(en.text) && /<option value="sign">/.test(en.text) &&
      es.text.includes('¿Cómo se enteró de nosotros?') && es.text.includes('Amigo / referencia'));
    check('the referral question reveals a free-text box for "Other", as the walk-in form does',
      /id="referral_other"/.test(en.text) && en.text.includes('Please specify') && es.text.includes('Por favor especifique') &&
      en.text.includes("val('referral')==='other'"));
    const refOk = await post({ ...base, first_name: 'Heard', last_name: 'Flyer', referral: 'flyer' });
    check('a submission stores the referral source as a countable key',
      refOk.status === 200 && (demoOf('Flyer') || {}).referral === 'flyer');
    const refOther = await post({ ...base, first_name: 'Heard', last_name: 'Other', referral: 'other', referral_other: 'Saw the bus' });
    check('"Other" keeps its free text in its own field',
      refOther.status === 200 && (demoOf('Other') || {}).referral === 'other' && (demoOf('Other') || {}).referral_other === 'Saw the bus');
    const refJunk = await post({ ...base, first_name: 'Heard', last_name: 'Dream', referral: 'from a dream' });
    check('a junk referral posted straight to the endpoint is rejected (never stored as prose)',
      refJunk.status === 200 && (demoOf('Dream') || {}).referral === '');

    // --- v0.0.15: the survey moved to check-out ("Step 5 — remove entire step") ---
    // Registration asks no survey question, online or at the kiosk: the whole
    // grant survey is asked in one sitting at check-out, which files the row.
    check('the online form no longer carries the survey card, its copy or its script',
      !/class="svq"/.test(en.text) && !/id="survey_skip"/.test(en.text) && !/var SVQ=/.test(en.text) &&
      !en.text.includes('skipBox') && !en.text.includes('function survey()') && !en.text.includes('A few last questions') &&
      !/class="svq"/.test(es.text) && !es.text.includes('Unas últimas preguntas'));
    const withSurvey = await post({ ...base, first_name: 'Survey', last_name: 'Posted',
      survey: { first_time: 'yes', household_size: '4' }, survey_declined: true });
    check('survey answers posted by an old cached page are ignored — the registration still succeeds',
      withSurvey.status === 200 && !!patientNamed('Posted'));
    check('a pre-registration files NO survey row (check-out creates it)',
      !surveyOf('Posted') && !Array.from(env.DB._store.values()).some((r) => r.entity === 'survey'));
    const postedP = patientNamed('Posted');
    check('the patient and its consent are still filed',
      !!postedP && Array.from(env.DB._store.values()).some((r) => r.entity === 'consent' && r.patient_uid === postedP.uid));

    // --- v0.0.15: City from the event's own list ---
    // The admin sets the towns on the event; the list travels to the server in
    // the event row, and the online form offers exactly the kiosk's list.
    await call(env, 'POST', '/v1/push', {
      auth: CLINIC_KEY,
      body: { device_id: 'd1', rows: [{ entity: 'event', uid: 'evt-cities', event_uid: null, updated_at: '2026-08-05T00:00:00.000Z',
        data: { name: 'Towns Clinic', active: 1, cities: JSON.stringify(['Sandy', 'Boring', ' sandy ', 'Other', '']) } }] },
    });
    const cityForm = await getText('/checkin/evt-cities');
    check('an event with a city list serves City as a dropdown of those towns, plus Other',
      /<select id="city"[^>]*>/.test(cityForm.text) && /<option value="Sandy">Sandy<\/option>/.test(cityForm.text) &&
      /<option value="Boring">Boring<\/option>/.test(cityForm.text) && /<option value="other">Other<\/option>/.test(cityForm.text) &&
      (cityForm.text.match(/<option value="Sandy">/g) || []).length === 1 && /id="city_other"/.test(cityForm.text) &&
      /City <span class="req">\*<\/span>/.test(cityForm.text) && cityForm.text.includes("if(!val('city'))"));
    check('without a list, City stays the text box it always was', /<input type="text" id="city"/.test(en.text) && !/id="city_other"/.test(en.text));
    const cityPost = (body) => call(env, 'POST', '/checkin/evt-cities', { body: { ...base, ...body } });
    const cityOf = (last) => { const r = Array.from(env.DB._store.values()).find((x) => x.entity === 'patient' && x.event_uid === 'evt-cities' && JSON.parse(x.data).last_name === last); return r ? JSON.parse(JSON.parse(r.data).demographics).city : null; };
    await cityPost({ first_name: 'Listed', last_name: 'Town', city: 'Boring' });
    check('a listed town is stored by its name', cityOf('Town') === 'Boring');
    await cityPost({ first_name: 'Typed', last_name: 'Elsewhere', city: 'other', city_other: '  Estacada ' });
    check('"Other" stores the typed town in the same field (never the word "other")', cityOf('Elsewhere') === 'Estacada');
    await cityPost({ first_name: 'Typed', last_name: 'Listed', city: 'other', city_other: 'sandy' });
    check('a typed town that is really a listed one is stored in the listed spelling', cityOf('Listed') === 'Sandy');
    await cityPost({ first_name: 'Direct', last_name: 'Cased', city: 'BORING' });
    check('a differently-cased listed town posted straight to the endpoint is canonicalised', cityOf('Cased') === 'Boring');
    // The admin cleared the list while a patient had the page open: "Other"
    // with a typed town still stores the town, never the word "other".
    const staleOther = await post({ ...base, first_name: 'Stale', last_name: 'Page', city: 'other', city_other: 'Gresham' });
    check('"Other" posted to an event whose list was since cleared stores the typed town',
      staleOther.status === 200 && (demoOf('Page') || {}).city === 'Gresham');
    const typedOther = await post({ ...base, first_name: 'Typed', last_name: 'Word', city: 'other' });
    check('with no list, whatever is typed in the City box is kept, as at the kiosk',
      typedOther.status === 200 && (demoOf('Word') || {}).city === 'other');
    const blankOther = await cityPost({ first_name: 'Blank', last_name: 'Other', city: 'other', city_other: '' });
    check('"Other" with nothing typed is refused as a missing city', blankOther.status === 400 && /city/i.test(blankOther.data.error));
    const longTown = '  Far   Away ' + 'x'.repeat(100);
    await cityPost({ first_name: 'Long', last_name: 'Townname', city: 'other', city_other: longTown });
    check('a typed town is stored cleaned as the kiosk cleans it (one space, trimmed, 80 characters)',
      cityOf('Townname') === ('Far Away ' + 'x'.repeat(100)).slice(0, 80));
    check('the online City boxes stop at 80 characters, as the kiosk\'s do',
      /id="city_other" maxlength="80"/.test(cityForm.text) && /id="city" autocomplete="address-level2" maxlength="80"/.test(en.text));

    // A laptop still on v0.0.14 knows nothing of the City list: when it saves
    // the event, its row simply leaves the list out. That must not take the
    // list off the online form (every station is meant to be upgraded first,
    // but a straggler must not be able to undo an admin's list).
    const pushEvent = (stamp, data) => call(env, 'POST', '/v1/push', { auth: CLINIC_KEY,
      body: { device_id: 'old', rows: [{ entity: 'event', uid: 'evt-cities', event_uid: null, updated_at: stamp, data }] } });
    const oldBuild = await pushEvent('2026-08-06T00:00:00.000Z', { name: 'Towns Clinic (renamed)', active: 1 });
    const afterOld = await getText('/checkin/evt-cities');
    check('an older laptop re-saving the event keeps the City list online, and its own change still lands',
      oldBuild.data.applied === 1 && /<select id="city"/.test(afterOld.text) && /<option value="Boring">Boring<\/option>/.test(afterOld.text)
      && afterOld.text.includes('Towns Clinic (renamed)'));
    await pushEvent('2026-08-07T00:00:00.000Z', { name: 'Towns Clinic', active: 1, cities: null });
    const cleared = await getText('/checkin/evt-cities');
    check('an admin clearing the list (an explicit empty value) still clears it online',
      /<input type="text" id="city"/.test(cleared.text) && !/id="city_other"/.test(cleared.text));
  }

  // --- v1.6.1: a deletion is sticky in the cloud ---
  // Plain last-write-wins let a station that had been offline push its old copy
  // back over the tombstone, clearing `deleted` and resurrecting the patient on
  // every station — as a shell, because the chart rows stayed deleted.
  {
    const envD = { CLINIC_KEY, DB: makeFakeD1() };
    const push = (rows) => call(envD, 'POST', '/v1/push', { auth: CLINIC_KEY, body: { device_id: 'd', rows } });
    const pull = () => call(envD, 'GET', '/v1/pull?since=0&limit=100', { auth: CLINIC_KEY });
    const live = (stamp, extra = {}) => ({
      entity: 'patient', uid: 'p-sticky', event_uid: 'e1', patient_uid: null, deleted: 0,
      updated_at: stamp, data: { first_name: 'Back', last_name: 'Again' }, ...extra,
    });

    await push([live('2026-01-01T00:00:00.000Z@a')]);
    await push([{ entity: 'patient', uid: 'p-sticky', event_uid: 'e1', deleted: 1, updated_at: '2026-01-02T00:00:00.000Z@a', data: {} }]);
    let rows = (await pull()).data.rows.filter((r) => r.uid === 'p-sticky');
    check('v1.6.1: a deletion is stored in the cloud', rows.length === 1 && rows[0].deleted === 1);

    // The offline station catches up and pushes its NEWER copy.
    const late = await push([live('2026-01-03T00:00:00.000Z@b')]);
    rows = (await pull()).data.rows.filter((r) => r.uid === 'p-sticky');
    check('v1.6.1: a newer copy from a station that missed the deletion does NOT undo it',
      late.data.skipped === 1 && rows[0].deleted === 1);

    // A deliberate restore says so, and is allowed through.
    const revive = await push([live('2026-01-04T00:00:00.000Z@a', { undelete: true })]);
    rows = (await pull()).data.rows.filter((r) => r.uid === 'p-sticky');
    check('v1.6.1: a deliberate restore is allowed to bring the record back',
      revive.data.applied === 1 && rows[0].deleted === 0 && rows[0].data.last_name === 'Again');
  }

  // --- v1.6.6: finishing a clinic must close its public pre-registration link ---
  {
    const closedUid = 'evt-closed';
    const openPush = await call(env, 'POST', '/v1/push', {
      auth: CLINIC_KEY,
      body: { device_id: 'd1', rows: [{ entity: 'event', uid: closedUid, event_uid: null,
        updated_at: '2026-08-01T00:00:00.000Z', data: { name: 'Closing Clinic', active: 1 } }] },
    });
    const openGet = await worker.fetch(new Request('https://sync.example.com/checkin/' + closedUid), env, {});
    check('v1.6.6: an open clinic still serves its pre-registration form',
      openPush.data.applied === 1 && openGet.status === 200);

    // "Finish clinic" in the app sets active = 0 and syncs the event row up.
    await call(env, 'POST', '/v1/push', {
      auth: CLINIC_KEY,
      body: { device_id: 'd1', rows: [{ entity: 'event', uid: closedUid, event_uid: null,
        updated_at: '2026-08-02T00:00:00.000Z', data: { name: 'Closing Clinic', active: 0 } }] },
    });
    const closedGet = await worker.fetch(new Request('https://sync.example.com/checkin/' + closedUid), env, {});
    const closedText = await closedGet.text();
    check('v1.6.6: a finished clinic no longer serves the pre-registration form',
      closedGet.status === 410 && /has closed/i.test(closedText));

    const closedPost = await call(env, 'POST', '/checkin/' + closedUid, {
      body: { ...REQ, first_name: 'Too', last_name: 'Late', dob: '1990-01-02', gender: 'male',
        city: 'Sandy', state: 'OR', visit_type: 'cleaning',
        consent_general: true, consent_general_name: 'Too Late',
        consent_general_signature: 'data:image/png;base64,AAAA' },
    });
    check('v1.6.6: a finished clinic refuses new pre-registrations',
      closedPost.status === 410 && closedPost.data.ok === false && /closed/i.test(closedPost.data.error));
  }

  // --- summary ---
  console.log('');
  if (failures) {
    console.log(failures + ' check(s) FAILED');
    process.exit(1);
  } else {
    console.log('All checks passed');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('Test harness crashed:', e);
  process.exit(1);
});
