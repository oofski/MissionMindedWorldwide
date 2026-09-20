// Mission Minded Worldwide — Cloud Sync Worker (v1.6.6)
// =============================================================================
// NO INSTALLS NEEDED. To deploy: create a Worker in the Cloudflare dashboard,
// paste THIS ENTIRE FILE into its code editor, then:
//   1. bind a D1 database with the variable name  DB   (Settings -> Bindings)
//   2. add a Secret named  CLINIC_KEY  = your shared clinic password
//   3. click Deploy.
// The database table is created automatically on first use (see ensureSchema),
// so there is no migration/CLI step. Full walkthrough: docs/CLOUD_SETUP.md.
// =============================================================================
// Cloudflare Worker + D1, implementing the shared "queue brain" sync API.
// Offline-first: the Electron app pushes locally-changed rows and pulls deltas.
// Dependency-free: pure Worker + D1 SQL via env.DB.
//
// See ./SYNC_CONTRACT.md for the exact API + schema this implements.

const SERVICE = 'mmw-sync';
const VERSION = '1.6.6';
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type',
};

// Self-initializing schema — so setup needs ZERO command-line tools. The Worker
// creates its own table on first use; the admin just pastes this file into the
// Cloudflare dashboard, binds a D1 database as "DB", sets CLINIC_KEY, and deploys.
const SCHEMA_STATEMENTS = [
  'CREATE TABLE IF NOT EXISTS sync_rows (' +
    'uid TEXT PRIMARY KEY, entity TEXT NOT NULL, event_uid TEXT, patient_uid TEXT, ' +
    'deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_sync_updated ON sync_rows(updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_sync_event ON sync_rows(event_uid, updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_sync_entity ON sync_rows(entity)',
  // v1.5.0 — the delivery counter. Row delivery must NOT depend on anybody's
  // clock: a laptop that was offline (or whose clock is off) writes rows with an
  // older updated_at, and a timestamp-ordered cursor would step straight over
  // them and never hand them to the other laptops. Every write now takes the
  // NEXT value of this counter, and pulls page by that instead.
  'CREATE TABLE IF NOT EXISTS sync_seq (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)',
];
// Best-effort migrations for a database created by an earlier version. Each is
// expected to fail harmlessly once it has already been applied (SQLite has no
// ADD COLUMN IF NOT EXISTS), so they run individually and swallow their error.
const MIGRATION_STATEMENTS = [
  'ALTER TABLE sync_rows ADD COLUMN seq INTEGER',
  // Existing rows keep their insertion order (rowid) as their seq, so nothing
  // already in the cloud is stranded below a client's first seq cursor.
  'UPDATE sync_rows SET seq = rowid WHERE seq IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_sync_seq ON sync_rows(seq)',
  // Start the counter above every backfilled row.
  'INSERT INTO sync_seq (id, v) SELECT 1, IFNULL((SELECT MAX(seq) FROM sync_rows), 0) ' +
    'WHERE NOT EXISTS (SELECT 1 FROM sync_seq WHERE id = 1)',
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady || !env || !env.DB) return;
  for (const sql of SCHEMA_STATEMENTS) {
    await env.DB.prepare(sql).run();
  }
  for (const sql of MIGRATION_STATEMENTS) {
    try { await env.DB.prepare(sql).run(); } catch (_e) { /* already applied */ }
  }
  schemaReady = true;
}

// Reserve the next delivery number. A single atomic upsert, so two laptops
// pushing at the same moment can never be handed the same value.
async function nextSeq(env) {
  const row = await env.DB
    .prepare('INSERT INTO sync_seq (id, v) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET v = v + 1 RETURNING v')
    .first();
  return row && row.v != null ? Number(row.v) : null;
}

export default {
  async fetch(request, env, ctx) {
    // CORS preflight — the Electron app calls from a file:// origin.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Friendly landing at the root so visiting the bare URL isn't alarming.
      // (The app never calls this — it uses /health and /v1/*.)
      if (path === '/' || path === '') {
        return json({
          ok: true,
          service: SERVICE,
          version: VERSION,
          message: 'Mission Minded sync server is running. There is no web page here — connect from the app under Admin -> Cloud. Health check: /health',
        });
      }

      // Health check — no auth (used by the app's "Test connection").
      if (path === '/health') {
        if (request.method !== 'GET') return methodNotAllowed();
        return json({
          ok: true,
          service: SERVICE,
          version: VERSION,
          // Tells the app this server delivers rows by counter, not by clock —
          // so it can switch to the cursor that can't skip a late arrival.
          seq: true,
          time: nowIso(),
        });
      }

      // Public patient PRE-REGISTRATION form (no clinic key — patients don't
      // have one). GET serves a form for a specific event; POST files it as a
      // checked-in patient row scoped to that event, which the clinic's app
      // pulls in on its next sync. The event_uid in the path is a random,
      // unguessable id, and we only accept submissions for events that exist.
      if (path === '/checkin' || path.startsWith('/checkin/')) {
        await ensureSchema(env);
        const eventUid = decodeURIComponent((path.replace(/^\/checkin\/?/, '').split('/')[0] || '').trim());
        if (request.method === 'GET') return await handleCheckinGet(eventUid, env, url);
        if (request.method === 'POST') return await handleCheckinPost(eventUid, request, env);
        return methodNotAllowed();
      }

      // Everything under /v1/* requires a valid Bearer clinic key.
      if (path === '/v1/' || path.startsWith('/v1/')) {
        if (!isAuthorized(request, env)) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }

        // Create the table on first authorized call — no CLI migration needed.
        await ensureSchema(env);

        if (path === '/v1/push') {
          if (request.method !== 'POST') return methodNotAllowed();
          return await handlePush(request, env);
        }

        if (path === '/v1/pull') {
          if (request.method !== 'GET') return methodNotAllowed();
          return await handlePull(url, env);
        }

        return json({ ok: false, error: 'not found' }, 404);
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: errMessage(err) }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handlePush(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_e) {
    return json({ ok: false, error: 'invalid json body' }, 400);
  }

  const rows = body && Array.isArray(body.rows) ? body.rows : [];
  let applied = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!isValidRow(row)) {
      skipped++;
      continue;
    }

    // Last-Write-Wins: read the stored updated_at first, and only overwrite
    // only when the incoming updated_at is STRICTLY newer than the stored one.
    // updated_at is a globally-unique, totally-ordered stamp (monotonic ISO time
    // + device id), so this tie-break ("skip on <=") is identical to the client's
    // apply rule ("apply only when env > local") — server and client can never
    // diverge on an equal-timestamp tie.
    const existing = await env.DB
      .prepare('SELECT updated_at, deleted FROM sync_rows WHERE uid = ?')
      .bind(row.uid)
      .first();

    if (existing && String(row.updated_at) <= String(existing.updated_at)) {
      skipped++;
      continue;
    }

    // A deletion is sticky. Plain last-write-wins let a station that had been
    // offline push its old copy back over the tombstone — the row's `deleted`
    // flag was cleared and the patient reappeared on every station, as a shell
    // with no chart (the children stayed deleted). A record only comes back when
    // someone deliberately restores it, which says so explicitly.
    if (existing && existing.deleted && !row.deleted && !isUndelete(row)) {
      skipped++;
      continue;
    }

    const dataStr =
      typeof row.data === 'string' ? row.data : JSON.stringify(row.data);

    // Take the next delivery number. A row that is written LATE (a laptop that
    // was offline, or one whose clock is behind) still lands at the END of the
    // delivery order, so every device that hasn't reached it yet still gets it.
    const seq = await nextSeq(env);

    await env.DB
      .prepare(
        'INSERT OR REPLACE INTO sync_rows ' +
          '(uid, entity, event_uid, patient_uid, deleted, updated_at, data, seq) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        row.uid,
        row.entity,
        row.event_uid != null ? row.event_uid : null,
        row.patient_uid != null ? row.patient_uid : null,
        row.deleted ? 1 : 0,
        row.updated_at,
        dataStr,
        seq
      )
      .run();

    applied++;
  }

  return json({ ok: true, applied, skipped, time: nowIso() });
}

async function handlePull(url, env) {
  const since = url.searchParams.get('since') || '';
  const eventUid = url.searchParams.get('event_uid');
  const limit = clampLimit(url.searchParams.get('limit'));

  // Two cursor dialects, so a clinic can update its laptops one at a time:
  //   seq  (v1.5.0+ app) — a plain number, the server's delivery counter.
  //   time (older app)   — the legacy "<ISO>@<device>" stamp. Served exactly as
  //                        before so an un-updated laptop keeps working.
  const seqMode = since === '' || /^\d+$/.test(since);
  const columns =
    'uid, entity, event_uid, patient_uid, deleted, updated_at, data, seq';

  const orderCol = seqMode ? 'seq' : 'updated_at';
  const sinceVal = seqMode ? Number(since || 0) : since;
  let sql =
    'SELECT ' + columns + ' FROM sync_rows WHERE ' +
    // A row written before this column existed and never re-pushed would have a
    // NULL seq; the backfill fills them, and IFNULL keeps it safe regardless.
    (seqMode ? 'IFNULL(seq, 0) > ?' : 'updated_at > ?');
  const binds = [sinceVal];
  if (eventUid) { sql += ' AND event_uid = ?'; binds.push(eventUid); }
  sql += ' ORDER BY ' + orderCol + ' ASC, uid ASC LIMIT ?';
  binds.push(limit);

  const result = await env.DB.prepare(sql).bind(...binds).all();
  const dbRows = result && Array.isArray(result.results) ? result.results : [];

  const rows = dbRows.map((r) => ({
    entity: r.entity,
    uid: r.uid,
    event_uid: r.event_uid != null ? r.event_uid : null,
    patient_uid: r.patient_uid != null ? r.patient_uid : null,
    deleted: r.deleted ? 1 : 0,
    updated_at: r.updated_at,
    data: parseData(r.data),
  }));

  const last = dbRows.length ? dbRows[dbRows.length - 1] : null;
  const cursor = !last
    ? (seqMode ? String(sinceVal) : since)
    : (seqMode ? String(last.seq != null ? last.seq : sinceVal) : last.updated_at);
  const more = rows.length === limit;

  // `mode` tells the app which dialect this server speaks, so a v1.5.0+ app can
  // tell a seq-capable server from an older deployment and store the right kind
  // of cursor either way.
  return json({ ok: true, rows, cursor, more, mode: seqMode ? 'seq' : 'time' });
}

// ---------------------------------------------------------------------------
// Patient pre-registration (public)
// ---------------------------------------------------------------------------

// Look up an event by its sync uid. Returns { name } or null. Events are stored
// as ordinary sync rows (entity='event'); the app pushes them up on sync.
async function getEventRow(env, uid) {
  if (!uid) return null;
  try {
    const row = await env.DB
      .prepare("SELECT data FROM sync_rows WHERE uid = ? AND entity = 'event' AND deleted = 0")
      .bind(uid)
      .first();
    if (!row) return null;
    const data = parseData(row.data) || {};
    // 'active' travels with the event row, so finishing a clinic in the app
    // closes its public link too. Without this the pre-registration form stayed
    // open after "Finish clinic" and kept taking sign-ups into a clinic that had
    // already been closed and had its records removed.
    const active = !(data.active === 0 || data.active === false || data.active === '0');
    return { name: typeof data.name === 'string' && data.name ? data.name : 'the clinic', active };
  } catch (_e) {
    return null;
  }
}

async function handleCheckinGet(eventUid, env, url) {
  const ev = await getEventRow(env, eventUid);
  if (!ev) return htmlResponse(checkinErrorPage(), 404);
  if (!ev.active) return htmlResponse(checkinClosedPage(ev.name), 410);
  const lang = (url && url.searchParams && url.searchParams.get('lang') === 'es') ? 'es' : 'en';
  return htmlResponse(checkinFormPage(eventUid, ev.name, lang));
}

async function handleCheckinPost(eventUid, request, env) {
  const ev = await getEventRow(env, eventUid);
  if (!ev) return json({ ok: false, error: 'This pre-registration link is not valid.' }, 404);
  if (!ev.active) {
    return json({ ok: false, error: 'This clinic has closed and is no longer taking pre-registrations. / Esta clínica ha cerrado y ya no acepta pre-registros.' }, 410);
  }

  let body;
  try { body = await request.json(); } catch (_e) { return json({ ok: false, error: 'Invalid submission.' }, 400); }

  const clean = buildPreregPatient(body);
  const esErr = body && body.language === 'es';
  if (!clean) return json({ ok: false, error: esErr ? 'Por favor ingrese su nombre y apellido.' : 'Please enter your first and last name.' }, 400);
  // Date of birth, gender, city and state are required (per the clinics'
  // reporting needs — grant-funded clinics report patients' town of origin).
  if (!clean.dob) return json({ ok: false, error: esErr ? 'Por favor ingrese su fecha de nacimiento.' : 'Please enter your date of birth.' }, 400);
  if (!clean.gender) return json({ ok: false, error: esErr ? 'Por favor elija un género.' : 'Please choose a gender.' }, 400);
  if (!clean.demographics.city) return json({ ok: false, error: esErr ? 'Por favor ingrese su ciudad.' : 'Please enter your city.' }, 400);
  if (!clean.demographics.state) return json({ ok: false, error: esErr ? 'Por favor ingrese su estado.' : 'Please enter your state.' }, 400);
  // An emergency contact is who the clinic calls if something goes wrong during
  // a procedure, so it is not optional.
  if (!clean.demographics.emergency_name) return json({ ok: false, error: esErr ? 'Por favor ingrese el nombre de un contacto de emergencia.' : 'Please enter an emergency contact name.' }, 400);
  if (!clean.demographics.emergency_phone) return json({ ok: false, error: esErr ? 'Por favor ingrese el teléfono del contacto de emergencia.' : 'Please enter an emergency contact phone number.' }, 400);
  // At least one service, exactly as the walk-in form requires: it decides which
  // clinics the patient is queued for, so a blank strands them in no queue.
  if (!clean.demographics.services.length) return json({ ok: false, error: esErr ? 'Elija al menos un servicio.' : 'Please choose at least one service.' }, 400);
  // Every medical and dental history question must carry an answer. A blank is
  // not "no" — the dentist reads these before deciding whether it is safe to
  // treat, and an unanswered question has to be asked in person.
  {
    // 'na' counts as answered for pregnancy. The walk-in form offers "Not
    // applicable" on that question because making a man or a child tap "No"
    // makes their answer indistinguishable from the clinically loaded No the
    // dentist needs. The online form has to offer the same, or the two forms
    // disagree about what a complete history is.
    const answered = (v) => v === 'yes' || v === 'no' || v === 'na';
    const missingMed = FORM_MED_YESNO.map(([k]) => k).find((k) => !answered(clean.medical_history[k]));
    const missingDent = FORM_DENTAL_YESNO.map(([k]) => k).find((k) => !answered(clean.dental_history[k]));
    if (missingMed || missingDent) {
      return json({ ok: false, error: esErr ? 'Por favor responda todas las preguntas del historial médico y dental.' : 'Please answer every medical and dental history question.' }, 400);
    }
    // Same gate as the walk-in form. Without it a blank stores as '' and lands
    // in the report as an uncountable row, which is the thing making this a
    // dropdown was meant to stop.
    if (!clean.dental_history.prior_dentist) {
      return json({ ok: false, error: esErr ? 'Por favor indique cuándo visitó al dentista por última vez.' : 'Please choose when you last saw a dentist.' }, 400);
    }
  }

  const iso = nowIso();
  const lang = clean.language;
  const surveyAnswers = sanitizeSurveyAnswers(body.survey);
  // Skipping is a first-class answer, not an absence: "asked and declined" is a
  // different — and more honest — figure than "never asked". Answering anything
  // overrides the skip, so the two can never disagree.
  const surveyDeclined = (body.survey_declined === true || body.survey_declined === 'on' || body.survey_declined === 'true')
    && Object.keys(surveyAnswers).length === 0;
  const sig = (v) => { const t = String(v == null ? '' : v); return (/^data:image\/(png|jpe?g);base64,/.test(t) && t.length < 700000) ? t : null; };

  // Consent must be SIGNED, not merely ticked. A pre-registration that arrives
  // without a signature would land in the clinic looking complete while the
  // dentist still has to stop and capture consent at the chair — so the form is
  // refused here, exactly as the in-person check-in refuses to continue.
  const agreed = (v) => v === true || v === 'on' || v === 'true';
  const generalSig = sig(body.signature_png);
  if (!agreed(body.consent_agree)) return json({ ok: false, error: esErr ? 'Por favor lea y acepte el consentimiento para terminar.' : 'Please read and agree to the consent to finish.' }, 400);
  if (!generalSig) return json({ ok: false, error: esErr ? 'Por favor firme el consentimiento para terminar.' : 'Please sign the consent to finish.' }, 400);
  if (!String(body.signer_name || '').trim()) return json({ ok: false, error: esErr ? 'Por favor escriba su nombre para la firma.' : 'Please type your name for the signature.' }, 400);

  // The Oral Surgery consent is required ONLY when an extraction was chosen —
  // and then it must be signed too.
  const extraction = clean.dental_history.may_need_extraction === 'yes';
  const surgerySig = sig(body.surgery_signature_png);
  if (extraction) {
    if (!agreed(body.surgery_agree)) {
      return json({ ok: false, error: esErr ? 'Se seleccionó una extracción — por favor lea y acepte también el consentimiento de cirugía oral.' : 'An extraction was selected — please read and agree to the Oral Surgery consent too.' }, 400);
    }
    if (!surgerySig) {
      return json({ ok: false, error: esErr ? 'Por favor firme el consentimiento de cirugía oral.' : 'Please sign the Oral Surgery consent.' }, 400);
    }
  }
  const signer = String(body.signer_name || (clean.first_name + ' ' + clean.last_name)).trim().slice(0, 120);
  const relationship = String(body.relationship || '').trim().slice(0, 60);

  const patientUid = crypto.randomUUID();
  const patientData = {
    language: lang, first_name: clean.first_name, last_name: clean.last_name,
    dob: clean.dob || null, gender: clean.gender || null, phone: clean.phone || null, email: clean.email || null,
    // demographics / *_history travel as JSON STRINGS (the patients table stores
    // them as TEXT), matching how the app itself pushes patient rows.
    demographics: JSON.stringify(Object.assign({ preregistered: true, prereg_at: iso }, clean.demographics)),
    medical_history: JSON.stringify(clean.medical_history),
    dental_history: JSON.stringify(clean.dental_history),
    status: 'checked_in', created_at: iso, dismissed_at: null, dismissed_by_name: null,
  };

  // The patient row + one or two SIGNED consent rows, all scoped to the event.
  // Consents reference the patient by uid; the app applies patients before
  // consents (APPLY_ORDER), so a remotely-signed consent attaches on sync.
  const rows = [
    { entity: 'patient', uid: patientUid, patient_uid: null, stamp: iso + '@prereg', data: patientData },
    { entity: 'consent', uid: crypto.randomUUID(), patient_uid: patientUid, stamp: iso + '@prereg-c1', data: {
      type: 'general', version: 'general-oregon-' + lang + '-v1+covid', language: lang,
      signer_name: signer, relationship: relationship, signature_png: generalSig, signed_at: iso,
      tooth_numbers: null, amended_by: null, amended_at: null,
    } },
  ];
  if (extraction) {
    rows.push({ entity: 'consent', uid: crypto.randomUUID(), patient_uid: patientUid, stamp: iso + '@prereg-c2', data: {
      type: 'oral_surgery', version: 'oral_surgery-' + lang + '-v1', language: lang,
      signer_name: signer, relationship: relationship, signature_png: surgerySig, signed_at: iso,
      tooth_numbers: String(body.surgery_teeth || '').trim().slice(0, 60) || null, amended_by: null, amended_at: null,
    } });
  }

  // The end-of-registration half of the grant survey, as the 'survey' entity the
  // app syncs (src/main/db.js SYNC_COLS.survey -> exit_surveys). `answers`
  // travels as a JSON STRING because the column is TEXT, the same way the
  // patient's demographics do above. Only the registration half is answered
  // here, so exit_status stays unset and check-out still asks its twelve.
  rows.push({ entity: 'survey', uid: crypto.randomUUID(), patient_uid: patientUid, stamp: iso + '@prereg-s', data: {
    version: SURVEY_VERSION, language: lang, answers: JSON.stringify(surveyAnswers),
    // `declined` is the CHECK-OUT answer in the app's schema — it is what
    // check-out gates on — so skipping these questions must not set it.
    // registration_status carries this half's outcome instead.
    declined: 0, completed_at: iso, completed_by_name: null, created_at: iso,
    registration_status: surveyDeclined ? 'declined' : 'completed', exit_status: null,
  } });

  for (const r of rows) {
    // Same delivery-number rule as a push: a pre-registration is queued at the
    // end of the order, so every laptop picks it up regardless of its clock.
    const seq = await nextSeq(env);
    await env.DB.prepare(
      'INSERT OR REPLACE INTO sync_rows (uid, entity, event_uid, patient_uid, deleted, updated_at, data, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(r.uid, r.entity, eventUid, r.patient_uid, 0, r.stamp, JSON.stringify(r.data), seq).run();
  }

  return json({ ok: true });
}

// Sanitize + shape a submission into the patient structure the app understands.
// Everything is length-capped; unknown fields are ignored. Returns null if the
// name is missing.
function buildPreregPatient(b) {
  b = b || {};
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 120);
  const yn = (v) => (v === 'yes' ? 'yes' : v === 'no' ? 'no' : '');
  const first = s(b.first_name, 60);
  const last = s(b.last_name, 60);
  if (!first || !last) return null;
  const keys = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 60).map((x) => s(x, 40)) : []);
  const meds = Array.isArray(b.medications)
    ? b.medications.map((m) => s(m, 80)).filter(Boolean).slice(0, 30).map((name) => ({ name, dose: '', reason: '' }))
    : [];

  const allergies = keys(b.allergies);
  const conditions = keys(b.conditions);
  const medical_history = {
    allergies,
    allergies_other: allergies.includes('other') ? s(b.allergies_other, 200) : '',
    conditions,
    conditions_other: conditions.includes('other') ? s(b.conditions_other, 200) : '',
    medications: meds,
    under_treatment: yn(b.under_treatment), hospitalized: yn(b.hospitalized),
    tobacco: yn(b.tobacco), pregnancy: ynNa(b.pregnancy),
  };
  if (allergies.includes('none')) medical_history.allergies_none = true;
  if (conditions.includes('none')) medical_history.conditions_none = true;
  if (!meds.length && (b.medications_none === true || b.medications_none === 'on')) medical_history.medications_none = true;

  // Mirrors PRIOR_DENTIST in src/renderer/i18n/strings.js. Validated here, not
  // just presented as a dropdown in the page: this endpoint is reachable
  // directly, and a free-text value arriving from it would land in the report as
  // a bucket of one that no funder figure can use.
  //
  // 'reason' is deliberately NOT read any more. The walk-in form dropped it, and
  // if this form kept posting prose the online sign-ups would be the only
  // records carrying it — a split the Reports tab cannot show.
  const PRIOR_DENTIST = ['within_6_months', 'about_1_year', 'about_2_years', 'over_3_years', 'never'];
  const dental_history = {
    prior_dentist: PRIOR_DENTIST.includes(b.prior_dentist) ? b.prior_dentist : '',
    gum_bleeding: yn(b.gum_bleeding), sores: yn(b.sores), jaw_injury: yn(b.jaw_injury),
    grinding: yn(b.grinding), post_extraction_bleeding: yn(b.post_extraction_bleeding), ortho: yn(b.ortho),
  };
  const VISITS = ['extraction_pain', 'extraction_no_pain', 'filling', 'cleaning'];
  if (VISITS.includes(b.visit_type)) {
    dental_history.visit_type = b.visit_type;
    if (b.visit_type === 'extraction_pain' || b.visit_type === 'extraction_no_pain') dental_history.may_need_extraction = 'yes';
  }

  return {
    first_name: first,
    last_name: last,
    dob: s(b.dob, 20),
    gender: s(b.gender, 20),
    phone: s(b.phone, 20).replace(/\D/g, '').slice(0, 10),
    email: s(b.email, 120),
    language: b.language === 'es' ? 'es' : 'en',
    demographics: {
      address: s(b.address, 200), city: s(b.city, 80),
      state: US_STATE_CODES.includes(String(b.state || '').toUpperCase()) ? String(b.state).toUpperCase() : '',
      emergency_name: s(b.emergency_name, 120), emergency_phone: s(b.emergency_phone, 20),
      // Which clinics to queue the patient for, and what prints on the
      // wristband. Required, so it is filtered to the known keys here and the
      // emptiness checked by the caller.
      services: Array.from(new Set(Array.isArray(b.services) ? b.services.filter((x) => SERVICE_KEYS.includes(x)) : [])),
      // A KEY, not the prose the page displayed: the report counts these, and a
      // typed-in value would be a bucket of one. 'other' keeps its free text in
      // its own field, exactly as the walk-in form stores it.
      referral: REFERRAL_KEYS.includes(b.referral) ? b.referral : '',
      referral_other: b.referral === 'other' ? s(b.referral_other, 200) : '',
      // Mirrors RACE in src/renderer/i18n/strings.js. Without this the online
      // sign-ups would be permanently "Not recorded" in the race breakdown while
      // walk-ins were counted — a split invisible on the Reports page.
      // "Prefer not to answer" is about the list, so it replaces it.
      race: (function () {
        const ok = ['american_indian_alaska_native', 'asian', 'black_african_american', 'hispanic_latino',
          'middle_eastern_north_african', 'native_hawaiian_pacific_islander', 'white', 'prefer_not'];
        const picked = Array.isArray(b.race) ? b.race.filter((r) => ok.includes(r)) : [];
        const uniq = Array.from(new Set(picked));
        return uniq.includes('prefer_not') ? ['prefer_not'] : uniq;
      })(),
    },
    medical_history,
    dental_history,
  };
}

// The check-in questions offered on the public form — the SAME options a patient
// gets in person. Keys MUST match the app's i18n keys (renderer/i18n/strings.js)
// so selections render natively in the clinic app.
// Mirrors MEDICATIONS in src/renderer/i18n/strings.js, in the same order (most
// commonly prescribed first). A datalist, not a select: it behaves as a picker
// but still accepts anything typed, because a patient on a drug outside this
// hundred must still be recordable.
const MED_OPTIONS = '<option value="Atorvastatin"></option><option value="Levothyroxine"></option><option value="Metformin"></option><option value="Amlodipine"></option><option value="Lisinopril"></option><option value="Albuterol"></option><option value="Losartan"></option><option value="Metoprolol"></option><option value="Rosuvastatin"></option><option value="Omeprazole"></option><option value="Gabapentin"></option><option value="Sertraline"></option><option value="Escitalopram"></option><option value="Semaglutide"></option><option value="Amphetamine/dextroamphetamine"></option><option value="Pantoprazole"></option><option value="Bupropion"></option><option value="Hydrochlorothiazide"></option><option value="Fluoxetine"></option><option value="Trazodone"></option><option value="Montelukast"></option><option value="Amoxicillin"></option><option value="Fluticasone"></option><option value="Tamsulosin"></option><option value="Apixaban"></option><option value="Simvastatin"></option><option value="Insulin glargine"></option><option value="Empagliflozin"></option><option value="Furosemide"></option><option value="Meloxicam"></option><option value="Hydrocodone/acetaminophen"></option><option value="Tirzepatide"></option><option value="Methylphenidate"></option><option value="Duloxetine"></option><option value="Prednisone"></option><option value="Carvedilol"></option><option value="Famotidine"></option><option value="Ibuprofen"></option><option value="Buspirone"></option><option value="Venlafaxine"></option><option value="Tramadol"></option><option value="Potassium chloride"></option><option value="Hydroxyzine"></option><option value="Allopurinol"></option><option value="Clopidogrel"></option><option value="Ergocalciferol (Vitamin D2)"></option><option value="Cetirizine"></option><option value="Ondansetron"></option><option value="Cyclobenzaprine"></option><option value="Spironolactone"></option><option value="Oxycodone"></option><option value="Estradiol"></option><option value="Aspirin"></option><option value="Glipizide"></option><option value="Zolpidem"></option><option value="Lamotrigine"></option><option value="Alprazolam"></option><option value="Citalopram"></option><option value="Pregabalin"></option><option value="Cholecalciferol (Vitamin D3)"></option><option value="Clonazepam"></option><option value="Azithromycin"></option><option value="Pravastatin"></option><option value="Valsartan"></option><option value="Ezetimibe"></option><option value="Diclofenac"></option><option value="Insulin lispro"></option><option value="Ethinyl estradiol/norethindrone"></option><option value="Propranolol"></option><option value="Latanoprost"></option><option value="Atenolol"></option><option value="Lisdexamfetamine"></option><option value="Doxycycline"></option><option value="Amoxicillin/clavulanate"></option><option value="Dulaglutide"></option><option value="Hydrochlorothiazide/lisinopril"></option><option value="Lorazepam"></option><option value="Fluticasone/salmeterol"></option><option value="Insulin aspart"></option><option value="Celecoxib"></option><option value="Finasteride"></option><option value="Quetiapine"></option><option value="Clonidine"></option><option value="Aripiprazole"></option><option value="Cephalexin"></option><option value="Alendronate"></option><option value="Topiramate"></option><option value="Tizanidine"></option><option value="Dapagliflozin"></option><option value="Oxycodone/acetaminophen"></option><option value="Hydrochlorothiazide/losartan"></option><option value="Olmesartan"></option><option value="Testosterone"></option><option value="Amitriptyline"></option><option value="Folic acid"></option><option value="Rivaroxaban"></option><option value="Fenofibrate"></option><option value="Triamcinolone"></option><option value="Paroxetine"></option><option value="Ferrous sulfate"></option>';

// Mirrors US_STATES in src/renderer/i18n/strings.js. A dropdown here as well as
// on the walk-in form, and validated server-side: this endpoint is reachable
// directly, and free text was putting "OR", "Oregon" and "ore" into the
// city/state report as three different places.
const US_STATE_CODES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR', 'VI', 'GU', 'AS', 'MP'];
const US_STATE_OPTIONS = '<option value="AL">Alabama (AL)</option><option value="AK">Alaska (AK)</option><option value="AZ">Arizona (AZ)</option><option value="AR">Arkansas (AR)</option><option value="CA">California (CA)</option><option value="CO">Colorado (CO)</option><option value="CT">Connecticut (CT)</option><option value="DE">Delaware (DE)</option><option value="DC">District of Columbia (DC)</option><option value="FL">Florida (FL)</option><option value="GA">Georgia (GA)</option><option value="HI">Hawaii (HI)</option><option value="ID">Idaho (ID)</option><option value="IL">Illinois (IL)</option><option value="IN">Indiana (IN)</option><option value="IA">Iowa (IA)</option><option value="KS">Kansas (KS)</option><option value="KY">Kentucky (KY)</option><option value="LA">Louisiana (LA)</option><option value="ME">Maine (ME)</option><option value="MD">Maryland (MD)</option><option value="MA">Massachusetts (MA)</option><option value="MI">Michigan (MI)</option><option value="MN">Minnesota (MN)</option><option value="MS">Mississippi (MS)</option><option value="MO">Missouri (MO)</option><option value="MT">Montana (MT)</option><option value="NE">Nebraska (NE)</option><option value="NV">Nevada (NV)</option><option value="NH">New Hampshire (NH)</option><option value="NJ">New Jersey (NJ)</option><option value="NM">New Mexico (NM)</option><option value="NY">New York (NY)</option><option value="NC">North Carolina (NC)</option><option value="ND">North Dakota (ND)</option><option value="OH">Ohio (OH)</option><option value="OK">Oklahoma (OK)</option><option value="OR">Oregon (OR)</option><option value="PA">Pennsylvania (PA)</option><option value="RI">Rhode Island (RI)</option><option value="SC">South Carolina (SC)</option><option value="SD">South Dakota (SD)</option><option value="TN">Tennessee (TN)</option><option value="TX">Texas (TX)</option><option value="UT">Utah (UT)</option><option value="VT">Vermont (VT)</option><option value="VA">Virginia (VA)</option><option value="WA">Washington (WA)</option><option value="WV">West Virginia (WV)</option><option value="WI">Wisconsin (WI)</option><option value="WY">Wyoming (WY)</option><option value="PR">Puerto Rico (PR)</option><option value="VI">U.S. Virgin Islands (VI)</option><option value="GU">Guam (GU)</option><option value="AS">American Samoa (AS)</option><option value="MP">Northern Mariana Islands (MP)</option>';

const FORM_ALLERGIES = [
  ['lidocaine', 'Lidocaine'], ['articaine', 'Articaine'], ['mepivacaine', 'Mepivacaine'], ['bupivacaine', 'Bupivacaine'],
  ['prilocaine', 'Prilocaine'], ['penicillin', 'Penicillin'], ['amoxicillin', 'Amoxicillin'], ['amoxicillin_clavulanate', 'Amoxicillin + clavulanate'],
  ['clindamycin', 'Clindamycin'], ['azithromycin', 'Azithromycin'], ['codeine', 'Codeine'], ['erythromycin', 'Erythromycin'],
  ['nsaids', 'NSAIDs (Ibuprofen, Aspirin)'], ['tylenol', 'Tylenol (Acetaminophen)'],
];
const FORM_CONDITIONS = [
  ['heart_disease', 'Heart disease'], ['high_bp', 'High blood pressure'], ['heart_murmur', 'Heart murmur'], ['pacemaker', 'Pacemaker'],
  ['artificial_valve', 'Artificial heart valve'], ['rheumatic_fever', 'Rheumatic fever'], ['diabetes', 'Diabetes'], ['asthma', 'Asthma'],
  ['tuberculosis', 'Tuberculosis'], ['hepatitis', 'Hepatitis'], ['hiv', 'HIV / AIDS'], ['kidney', 'Kidney disease'], ['liver', 'Liver disease'],
  ['thyroid', 'Thyroid problems'], ['cancer', 'Cancer'], ['epilepsy', 'Epilepsy / seizures'], ['stroke', 'Stroke'], ['anemia', 'Anemia'],
  ['bleeding', 'Bleeding disorder / bleeds easily'], ['blood_thinners', 'Takes blood thinners'], ['arthritis', 'Arthritis'], ['glaucoma', 'Glaucoma'],
  ['ulcers', 'Stomach ulcers'], ['respiratory', 'Respiratory problems'], ['mental_health', 'Mental health condition'], ['latex', 'Latex allergy'],
  ['anesthesia_reaction', 'Reaction to anesthesia'], ['pregnant', 'Currently pregnant'], ['pain_mgmt', 'Pain management program'], ['weight_mgmt', 'Weight management program'],
];
// Exact wording matches the in-person check-in (renderer/i18n/strings.js).
const FORM_VISITS = [
  ['extraction_pain', 'Extraction — in pain'], ['extraction_no_pain', 'Extraction — no pain'],
  ['filling', 'Filling'], ['cleaning', 'Dental cleaning'],
];
// MMW runs dental, medical and vision under one roof, and the walk-in form asks
// which the patient is here for (SERVICES in renderer/js/views/kiosk.js). It
// decides which clinics they queue for and it prints on the wristband, so at
// least one has to be chosen here too — a blank strands them in no queue.
const FORM_SERVICES = [
  ['dental', 'Dental'], ['medical', 'Medical'], ['vision', 'Vision'],
];
// Mirrors REFERRALS in src/renderer/i18n/strings.js. Stored as keys, never the
// prose: the report counts them, and 'other' carries the free text separately.
const FORM_REFERRALS = [
  ['email', 'Email'], ['text', 'Text message'], ['sign', 'Sign / banner'], ['friend_referral', 'Friend / referral'],
  ['flyer', 'Flyer'], ['church', 'Church / community'], ['social_media', 'Social media'], ['other', 'Other'],
];
const SERVICE_KEYS = FORM_SERVICES.map(([k]) => k);
const REFERRAL_KEYS = FORM_REFERRALS.map(([k]) => k);
// Extra yes/no medical + dental questions — verbatim from the app's check-in.
// Pregnancy alone accepts a third answer — see the gate in handleCheckinPost.
const ynNa = (v) => (v === 'yes' || v === 'no' || v === 'na' ? v : '');

const FORM_MED_YESNO = [
  ['under_treatment', 'Are you currently under a doctor’s care?'], ['hospitalized', 'Hospitalized in the last 2 years?'],
  ['tobacco', 'Do you use tobacco?'], ['pregnancy', 'Pregnant, nursing, or taking contraceptives?'],
];
const FORM_DENTAL_YESNO = [
  ['gum_bleeding', 'Do your gums bleed?'], ['sores', 'Any sores or lumps in your mouth?'], ['jaw_injury', 'Any head, neck, or jaw injury?'],
  ['grinding', 'Do you clench or grind your teeth?'], ['post_extraction_bleeding', 'History of bleeding after a tooth was pulled?'], ['ortho', 'Have you had braces or orthodontics?'],
];
// Consent wording (English authoritative) — mirrors renderer/i18n/strings.js so a
// patient can read and sign remotely the SAME forms they would in person.
const GENERAL_CONSENT_TITLE = 'Consent to Dental Procedures, Administration of Anesthetics, Sedatives, Rendering of Other Services, and Hold Harmless Clause';
const GENERAL_CONSENT = [
  'I hereby authorize Mission Minded Worldwide or Associate Dentist and/or such assistants as may be selected, to perform Routine Dental Care upon the above named and/or any other therapeutic procedure that his/her/their judgment may dictate to be advisable for the patient’s well-being.',
  'The nature and purpose of the procedure and anesthetic, the risks involved, and the possibility of complications has been explained to me. I acknowledge that no guarantee or assurance has been made as to the results that may be obtained. The advantages and inherent risks of anesthesia and sedation have been explained to me and I authorize the administration of such anesthesia and sedation as may be considered necessary or desirable.',
  'I authorize that any specimens, tissue or parts removed from the patient may be disposed of in accordance with established practice.',
  'I further authorize the performance by any qualified person of any other services which are deemed to be necessary or advisable.',
  'If in Mission Minded Worldwide/Associate Dentist’s opinion, further observation of the above named is indicated after an anesthetic or procedure, the above named agrees to be transported by ambulance at his/her personal expense to a mutually satisfactory hospital in the local area, and to be admitted for observation and any necessary treatment. Any and all medical treatment required after a dental procedure will be the financial responsibility of the patient or his/her family. Free services are limited to the services provided at the free dental clinic.',
  'If in Mission Minded Worldwide/Associate Dentist’s opinion, the above named requires the services of a specialist, he/she agrees to accept the referral and will be responsible for any expense that may be incurred.',
  'I certify that I have read this Consent, or that it has been read to me, and that I understand the above. The nature and purpose of such operation(s), procedure(s), treatment(s), and/or services and the reasons why the same is (are) considered necessary or advisable has been explained to me. I hereby hold Mission Minded Worldwide, Associate Dentist and/or such assistants harmless for the free dental care provided. Services are provided without compensation, and the provider’s liability is limited and the provider may not be held liable for any injury, death or other loss arising out of the provision of these services, unless the injury, death or other loss results from gross negligence. I am also aware of the risk of exposure to COVID during a dental procedure and I consent to participate in this clinic at my own risk.',
];
const ORAL_SURGERY_TITLE = 'Consent for Oral Surgery';
const ORAL_SURGERY_CONSENT = [
  'The surgery procedure that is to be performed has been explained to me and I understand the nature of my condition and of the proposed treatment. I also understand what health risks exist if the procedure is not done, such as pain, infection, decay, damage to other teeth and a more difficult surgery as I get older.',
  'I agree to the administration of local anesthesia and other therapeutic measures as discussed that may be necessary for my comfort, safety and well-being.',
  'I realize that occasionally there are complications with this surgery and the medications. The more common complications include pain, swelling, bleeding, dry sockets, limited mouth opening, infection, bruising and discoloration of the skin, and temporary numbness and/or tingling of the lip, chin, teeth, or tongue.',
  'In some cases, even with the utmost care, there can be referred pain to the ear or neck; stiffness of the neck and facial muscles; changes in the bite and temporomandibular joint (TMJ); nausea; allergic reactions; bone fractures; injury to adjacent teeth; delayed healing; and permanent numbness of nerves in the facial area. Sinus complications, which may occur from the removal of upper teeth, include a root tip or tooth in the sinus or the development of a lingering opening into the sinus from the mouth, which could require sinus treatments following surgery. I understand Mission Minded Worldwide does not provide or pay for any of these additional treatments.',
  'Medications given during or after surgery may cause drowsiness and a lack of awareness and coordination, which could be increased by the use of alcohol or other drugs. I am aware that I should not operate any vehicle or hazardous device while taking such medications for at least 24 hours after taking them, or until recovered from their effects.',
  'I know that some of the above-mentioned complications can be avoided or reduced by carefully following dentist instructions. I have had an opportunity to ask questions about the procedure and aspects related to it and have had them answered to my satisfaction. This is my consent to surgery on the tooth number(s) recorded on this form.',
  'For prolonged swelling (growing bigger in 24–48 hrs) or no relief from pain: Call MISSION MINDED WORLDWIDE at (951) 317-4968 and leave a message. Someone will call you back and tell you how to get attention for your problem. If you have had to leave a message, be patient and wait until someone calls back and gives you instructions. This post-op attention is only for treatment received and is not for continuing treatment on other teeth. If you experience difficulty breathing or swallowing, you should go to the Emergency Room for immediate treatment. Mission Minded Worldwide does not pay for any emergency room treatment, only for follow-up consultation with an approved local dentist to treat infection, pain, or swelling associated with treatment received at the free clinic.',
  'I hereby hold Mission Minded Worldwide, Associate Dentist and/or such assistants harmless for the free dental care provided. Services are provided without compensation, and the provider’s liability is limited and the provider may not be held liable for any injury, death or other loss arising out of the provision of these services, unless the injury, death or other loss results from gross negligence.',
];
const CONSENT_AGREE_TEXT = 'I have read and understand the above, and I consent.';

// ---- Spanish (es) option labels + consent, mirroring the app's translations ----
const FORM_ALLERGIES_ES = [
  ['lidocaine', 'Lidocaína'], ['articaine', 'Articaína'], ['mepivacaine', 'Mepivacaína'], ['bupivacaine', 'Bupivacaína'],
  ['prilocaine', 'Prilocaína'], ['penicillin', 'Penicilina'], ['amoxicillin', 'Amoxicilina'], ['amoxicillin_clavulanate', 'Amoxicilina + clavulanato'],
  ['clindamycin', 'Clindamicina'], ['azithromycin', 'Azitromicina'], ['codeine', 'Codeína'], ['erythromycin', 'Eritromicina'],
  ['nsaids', 'AINEs (Ibuprofeno, Aspirina)'], ['tylenol', 'Tylenol (Acetaminofén)'],
];
const FORM_CONDITIONS_ES = [
  ['heart_disease', 'Enfermedad del corazón'], ['high_bp', 'Presión arterial alta'], ['heart_murmur', 'Soplo cardíaco'], ['pacemaker', 'Marcapasos'],
  ['artificial_valve', 'Válvula cardíaca artificial'], ['rheumatic_fever', 'Fiebre reumática'], ['diabetes', 'Diabetes'], ['asthma', 'Asma'],
  ['tuberculosis', 'Tuberculosis'], ['hepatitis', 'Hepatitis'], ['hiv', 'VIH / SIDA'], ['kidney', 'Enfermedad renal'], ['liver', 'Enfermedad del hígado'],
  ['thyroid', 'Problemas de tiroides'], ['cancer', 'Cáncer'], ['epilepsy', 'Epilepsia / convulsiones'], ['stroke', 'Derrame cerebral'], ['anemia', 'Anemia'],
  ['bleeding', 'Trastorno hemorrágico / sangra fácilmente'], ['blood_thinners', 'Toma anticoagulantes'], ['arthritis', 'Artritis'], ['glaucoma', 'Glaucoma'],
  ['ulcers', 'Úlceras estomacales'], ['respiratory', 'Problemas respiratorios'], ['mental_health', 'Condición de salud mental'], ['latex', 'Alergia al látex'],
  ['anesthesia_reaction', 'Reacción a la anestesia'], ['pregnant', 'Actualmente embarazada'], ['pain_mgmt', 'Programa de manejo del dolor'], ['weight_mgmt', 'Programa de manejo de peso'],
];
const FORM_VISITS_ES = [
  ['extraction_pain', 'Extracción — con dolor'], ['extraction_no_pain', 'Extracción — sin dolor'], ['filling', 'Empaste'], ['cleaning', 'Limpieza dental'],
];
const FORM_SERVICES_ES = [
  ['dental', 'Dental'], ['medical', 'Médico'], ['vision', 'Visión'],
];
const FORM_REFERRALS_ES = [
  ['email', 'Correo electrónico'], ['text', 'Mensaje de texto'], ['sign', 'Letrero / pancarta'], ['friend_referral', 'Amigo / referencia'],
  ['flyer', 'Volante'], ['church', 'Iglesia / comunidad'], ['social_media', 'Redes sociales'], ['other', 'Otro'],
];
const FORM_MED_YESNO_ES = [
  ['under_treatment', '¿Está bajo el cuidado de un médico actualmente?'], ['hospitalized', '¿Hospitalizado en los últimos 2 años?'],
  ['tobacco', '¿Usa tabaco?'], ['pregnancy', '¿Embarazada, amamantando o usando anticonceptivos?'],
];
const FORM_DENTAL_YESNO_ES = [
  ['gum_bleeding', '¿Le sangran las encías?'], ['sores', '¿Llagas o bultos en la boca?'], ['jaw_injury', '¿Lesión en cabeza, cuello o mandíbula?'],
  ['grinding', '¿Aprieta o rechina los dientes?'], ['post_extraction_bleeding', '¿Historial de sangrado después de una extracción?'], ['ortho', '¿Ha usado frenos u ortodoncia?'],
];
const GENERAL_CONSENT_ES = ['Certifico que he leído este Consentimiento, o que me ha sido leído, y que entiendo lo anterior. Se me ha explicado la naturaleza y el propósito de tales operación(es), procedimiento(s), tratamiento(s) y/o servicios y las razones por las que se consideran necesarios o aconsejables. Por la presente eximo de responsabilidad a Mission Minded Worldwide, al Dentista Asociado y/o a dichos asistentes por la atención dental gratuita brindada. Los servicios se prestan sin compensación y la responsabilidad del proveedor es limitada y el proveedor no puede ser considerado responsable por ninguna lesión, muerte u otra pérdida que surja de la prestación de estos servicios, a menos que la lesión, muerte u otra pérdida resulte de negligencia grave. También soy consciente del riesgo de exposición al COVID durante un procedimiento dental y consiento participar en esta clínica bajo mi propio riesgo. (La versión en inglés es la versión legal autoritativa.)'];
const ORAL_SURGERY_ES = [
  'Este consentimiento adicional es necesario porque hoy podría realizarse una extracción.',
  'Consiento la extracción de uno o más dientes y el uso de anestesia local.',
  'Entiendo que las complicaciones pueden incluir dolor, hinchazón, moretones, infección, alvéolo seco, sangrado, apertura limitada de la mandíbula, lesión a dientes u obturaciones cercanas, y entumecimiento del labio, lengua o mentón que suele ser temporal pero rara vez puede ser permanente.',
  'Entiendo que un diente o la punta de la raíz puede romperse durante la extracción y que un pequeño fragmento puede quedar si extraerlo causara mayor daño.',
  'He informado al equipo de todos los medicamentos y condiciones de salud que puedan afectar la cirugía o la recuperación.',
];

// ---- The end-of-registration half of the MMW grant survey ----
// The SAME 22 questions the walk-in kiosk asks (the sections marked stage
// 'registration' in src/renderer/i18n/exitSurvey.js). Both languages live in one
// structure, as they do there: with 22 questions and 130-odd options, parallel
// EN/ES lists would drift the first time one of them was edited, and a question
// that exists in one place and not another is how a grant return ends up unable
// to explain its own numbers.
//
// `value` is what gets stored and reported, so it must never be renamed.
const SURVEY_VERSION = 'mmw-exit-v1';
const SV_YES_NO_UNSURE_PNA = [
  { value: 'yes', en: 'Yes', es: 'Sí' },
  { value: 'no', en: 'No', es: 'No' },
  { value: 'unsure', en: 'Unsure', es: 'No estoy seguro/a' },
  { value: 'pna', en: 'Prefer not to answer', es: 'Prefiero no responder' },
];
const SV_YES_NO_PNA = [
  { value: 'yes', en: 'Yes', es: 'Sí' },
  { value: 'no', en: 'No', es: 'No' },
  { value: 'pna', en: 'Prefer not to answer', es: 'Prefiero no responder' },
];
const SV_PNA = { value: 'pna', en: 'Prefer not to answer', es: 'Prefiero no responder' };
const SURVEY_REGISTRATION = [
  {
    key: 'about', en: 'About your visit', es: 'Sobre su visita',
    questions: [
      {
        key: 'first_time', type: 'single',
        en: 'Is this your first time receiving services from a free community health clinic?',
        es: '¿Es esta la primera vez que recibe servicios en una clínica comunitaria gratuita?',
        options: [
          { value: 'yes', en: 'Yes', es: 'Sí' },
          { value: 'no', en: 'No', es: 'No' },
          { value: 'not_sure', en: 'Not sure', es: 'No estoy seguro/a' },
        ],
      },
      {
        key: 'heard_about', type: 'single',
        en: 'How did you hear about this clinic?',
        es: '¿Cómo se enteró de esta clínica?',
        options: [
          { value: 'friend_family', en: 'Friend or family member', es: 'Un amigo o familiar' },
          { value: 'church', en: 'Church', es: 'La iglesia' },
          { value: 'social_media', en: 'Social media', es: 'Redes sociales' },
          { value: 'flyer', en: 'Flyer or poster', es: 'Un volante o cartel' },
          { value: 'community_org', en: 'Community organization', es: 'Una organización comunitaria' },
          { value: 'healthcare_provider', en: 'Healthcare provider', es: 'Un proveedor de salud' },
          { value: 'previous_mmw', en: 'Previous MMW clinic', es: 'Una clínica anterior de MMW' },
        ],
      },
    ],
  },
  {
    key: 'household', en: 'Your household', es: 'Su hogar',
    questions: [
      {
        key: 'household_size', type: 'single',
        en: 'How many people live in your household, including yourself?',
        es: '¿Cuántas personas viven en su hogar, incluyéndose a usted?',
        options: [
          { value: '1', en: '1', es: '1' },
          { value: '2', en: '2', es: '2' },
          { value: '3', en: '3', es: '3' },
          { value: '4', en: '4', es: '4' },
          { value: '5', en: '5', es: '5' },
          { value: '6_or_more', en: '6 or more', es: '6 o más' },
        ],
      },
      {
        key: 'children_under_18', type: 'single',
        en: 'How many children under 18 live in your household?',
        es: '¿Cuántos niños menores de 18 años viven en su hogar?',
        options: [
          { value: 'none', en: 'None', es: 'Ninguno' },
          { value: '1', en: '1', es: '1' },
          { value: '2', en: '2', es: '2' },
          { value: '3', en: '3', es: '3' },
          { value: '4_or_more', en: '4 or more', es: '4 o más' },
          SV_PNA,
        ],
      },
      {
        key: 'disability', type: 'single',
        en: 'Do you or anyone in your household have a disability?',
        es: '¿Usted o alguien en su hogar tiene una discapacidad?',
        options: SV_YES_NO_UNSURE_PNA,
      },
      {
        key: 'living_situation', type: 'single',
        en: 'What is your current living situation?',
        es: '¿Cuál es su situación de vivienda actual?',
        options: [
          { value: 'own', en: 'Own my home', es: 'Soy dueño/a de mi casa' },
          { value: 'rent', en: 'Rent my home or apartment', es: 'Rento mi casa o apartamento' },
          { value: 'with_family', en: 'Live with family or friends', es: 'Vivo con familiares o amigos' },
          { value: 'temporary', en: 'Temporary housing', es: 'Vivienda temporal' },
          { value: 'shelter', en: 'Shelter', es: 'Un albergue' },
          { value: 'homeless', en: 'Homeless or without stable housing', es: 'Sin hogar o sin vivienda estable' },
          SV_PNA,
        ],
      },
      {
        key: 'education', type: 'single',
        en: 'What is the highest level of education you have completed?',
        es: '¿Cuál es el nivel de estudios más alto que ha completado?',
        options: [
          { value: 'none', en: 'No formal education', es: 'Sin educación formal' },
          { value: 'elementary', en: 'Elementary school', es: 'Escuela primaria' },
          { value: 'some_high_school', en: 'Some high school', es: 'Algo de escuela secundaria' },
          { value: 'high_school', en: 'High school diploma or GED', es: 'Diploma de secundaria o GED' },
          { value: 'some_college', en: 'Some college', es: 'Algo de universidad' },
          { value: 'associate', en: 'Associate degree', es: 'Título asociado' },
          { value: 'bachelor', en: 'Bachelor\'s degree', es: 'Licenciatura' },
          { value: 'graduate', en: 'Graduate or professional degree', es: 'Posgrado o título profesional' },
          SV_PNA,
        ],
      },
      {
        key: 'household_in_school', type: 'single',
        en: 'Does anyone in your household currently attend school or a training program?',
        es: '¿Alguien en su hogar asiste actualmente a la escuela o a un programa de capacitación?',
        options: SV_YES_NO_PNA,
      },
    ],
  },
  {
    key: 'work', en: 'Work and income', es: 'Trabajo e ingresos',
    questions: [
      {
        key: 'employment', type: 'single',
        en: 'What is your current employment status?',
        es: '¿Cuál es su situación laboral actual?',
        options: [
          { value: 'full_time', en: 'Employed full-time', es: 'Empleado/a a tiempo completo' },
          { value: 'part_time', en: 'Employed part-time', es: 'Empleado/a a tiempo parcial' },
          { value: 'self_employed', en: 'Self-employed', es: 'Trabajo por cuenta propia' },
          { value: 'unable_to_work', en: 'Temporarily unable to work', es: 'Temporalmente sin poder trabajar' },
          { value: 'unemployed_looking', en: 'Unemployed and looking for work', es: 'Desempleado/a y buscando trabajo' },
          { value: 'unemployed_not_looking', en: 'Unemployed and not currently looking for work', es: 'Desempleado/a y no buscando trabajo actualmente' },
          { value: 'retired', en: 'Retired', es: 'Jubilado/a' },
          { value: 'student', en: 'Student', es: 'Estudiante' },
          { value: 'homemaker', en: 'Homemaker or caregiver', es: 'Ama/o de casa o cuidador/a' },
          SV_PNA,
        ],
      },
      {
        key: 'work_type', type: 'single',
        en: 'If employed, what type of work do you do?',
        es: 'Si trabaja, ¿qué tipo de trabajo hace?',
        options: [
          { value: 'healthcare', en: 'Healthcare', es: 'Salud' },
          { value: 'education', en: 'Education', es: 'Educación' },
          { value: 'construction', en: 'Construction or skilled trades', es: 'Construcción u oficios especializados' },
          { value: 'retail', en: 'Retail or customer service', es: 'Ventas o servicio al cliente' },
          { value: 'food_service', en: 'Food service or hospitality', es: 'Servicio de alimentos u hotelería' },
          { value: 'transportation', en: 'Transportation', es: 'Transporte' },
          { value: 'agriculture', en: 'Agriculture', es: 'Agricultura' },
          { value: 'office', en: 'Office or professional services', es: 'Oficina o servicios profesionales' },
          SV_PNA,
        ],
      },
      {
        key: 'income', type: 'single',
        en: 'What is your approximate annual household income before taxes?',
        es: '¿Cuál es aproximadamente el ingreso anual de su hogar antes de impuestos?',
        options: [
          { value: '0_15k', en: '$0–$15,000', es: '$0–$15,000' },
          { value: '15k_25k', en: '$15,001–$25,000', es: '$15,001–$25,000' },
          { value: '25k_35k', en: '$25,001–$35,000', es: '$25,001–$35,000' },
          { value: '35k_50k', en: '$35,001–$50,000', es: '$35,001–$50,000' },
          { value: '50k_75k', en: '$50,001–$75,000', es: '$50,001–$75,000' },
          { value: '75k_100k', en: '$75,001–$100,000', es: '$75,001–$100,000' },
          { value: 'over_100k', en: 'More than $100,000', es: 'Más de $100,000' },
          SV_PNA,
        ],
      },
      {
        key: 'assistance', type: 'multi',
        en: 'Does your household currently receive any of the following forms of assistance?',
        es: '¿Su hogar recibe actualmente alguna de las siguientes formas de asistencia?',
        hintEn: 'Select all that apply.', hintEs: 'Seleccione todas las que correspondan.',
        options: [
          { value: 'snap', en: 'SNAP or food assistance', es: 'SNAP o asistencia alimentaria' },
          { value: 'medicaid', en: 'Medicaid', es: 'Medicaid' },
          { value: 'ssi', en: 'Supplemental Security Income (SSI)', es: 'Seguridad de Ingreso Suplementario (SSI)' },
          { value: 'ssdi', en: 'Social Security Disability Insurance (SSDI)', es: 'Seguro de Incapacidad del Seguro Social (SSDI)' },
          { value: 'housing', en: 'Housing assistance', es: 'Asistencia de vivienda' },
          { value: 'wic', en: 'WIC', es: 'WIC' },
          { value: 'other_public', en: 'Other public assistance', es: 'Otra asistencia pública' },
          { value: 'none', en: 'No assistance', es: 'Ninguna asistencia' },
          SV_PNA,
        ],
      },
    ],
  },
  {
    key: 'coverage', en: 'Insurance and access to care', es: 'Seguro y acceso a la atención',
    questions: [
      {
        key: 'health_insurance', type: 'single',
        en: 'Do you currently have health insurance?',
        es: '¿Tiene actualmente seguro médico?',
        options: SV_YES_NO_UNSURE_PNA,
      },
      {
        key: 'health_insurance_type', type: 'single',
        en: 'If you have health insurance, what type is it?',
        es: 'Si tiene seguro médico, ¿de qué tipo es?',
        options: [
          { value: 'employer', en: 'Employer-sponsored insurance', es: 'Seguro a través del empleador' },
          { value: 'medicaid', en: 'Medicaid', es: 'Medicaid' },
          { value: 'medicare', en: 'Medicare', es: 'Medicare' },
          { value: 'private', en: 'Private', es: 'Privado' },
          { value: 'military_va', en: 'Military or Veterans Affairs coverage', es: 'Cobertura militar o de Asuntos de Veteranos' },
          SV_PNA,
          { value: 'na', en: 'Not applicable', es: 'No aplica' },
        ],
      },
      {
        key: 'dental_insurance', type: 'single',
        en: 'Do you currently have dental insurance?',
        es: '¿Tiene actualmente seguro dental?',
        options: SV_YES_NO_UNSURE_PNA,
      },
      {
        key: 'vision_insurance', type: 'single',
        en: 'Do you currently have vision insurance?',
        es: '¿Tiene actualmente seguro de la vista?',
        options: SV_YES_NO_UNSURE_PNA,
      },
      {
        key: 'last_checkup', type: 'single',
        en: 'When was the last time you received a medical checkup?',
        es: '¿Cuándo fue la última vez que tuvo un chequeo médico?',
        options: [
          { value: 'under_6m', en: 'Within the past 6 months', es: 'En los últimos 6 meses' },
          { value: '6_12m', en: '6–12 months ago', es: 'Hace 6–12 meses' },
          { value: '1_2y', en: '1–2 years ago', es: 'Hace 1–2 años' },
          { value: 'over_2y', en: 'More than 2 years ago', es: 'Hace más de 2 años' },
          { value: 'never', en: 'I have never received a medical checkup', es: 'Nunca he tenido un chequeo médico' },
          SV_PNA,
        ],
      },
      {
        key: 'last_eye_exam', type: 'single',
        en: 'When was the last time you had an eye examination?',
        es: '¿Cuándo fue la última vez que tuvo un examen de la vista?',
        options: [
          { value: 'under_6m', en: 'Within the past 6 months', es: 'En los últimos 6 meses' },
          { value: '6_12m', en: '6–12 months ago', es: 'Hace 6–12 meses' },
          { value: '1_2y', en: '1–2 years ago', es: 'Hace 1–2 años' },
          { value: 'over_2y', en: 'More than 2 years ago', es: 'Hace más de 2 años' },
          { value: 'never', en: 'I have never had an eye examination', es: 'Nunca he tenido un examen de la vista' },
          SV_PNA,
        ],
      },
      {
        key: 'delayed_care_cost', type: 'single',
        en: 'In the past 12 months, have you delayed or avoided healthcare because of cost?',
        es: 'En los últimos 12 meses, ¿ha retrasado o evitado atención médica por el costo?',
        options: SV_YES_NO_PNA,
      },
      {
        key: 'access_barriers', type: 'multi',
        en: 'What are the main reasons you have difficulty accessing healthcare?',
        es: '¿Cuáles son las razones principales por las que tiene dificultad para acceder a atención médica?',
        hintEn: 'Select all that apply.', hintEs: 'Seleccione todas las que correspondan.',
        options: [
          { value: 'cost', en: 'Cost of services', es: 'El costo de los servicios' },
          { value: 'no_insurance', en: 'No insurance', es: 'No tengo seguro' },
          { value: 'high_deductible', en: 'High insurance deductible or copay', es: 'Deducible o copago alto del seguro' },
          { value: 'transportation', en: 'Lack of transportation', es: 'Falta de transporte' },
          { value: 'no_providers', en: 'Lack of nearby providers', es: 'Falta de proveedores cercanos' },
          { value: 'wait_times', en: 'Long waiting times', es: 'Tiempos de espera largos' },
          { value: 'work_schedule', en: 'Work schedule', es: 'Mi horario de trabajo' },
          { value: 'childcare', en: 'Childcare responsibilities', es: 'Responsabilidades de cuidado de niños' },
          { value: 'language', en: 'Language barriers', es: 'Barreras de idioma' },
          { value: 'no_new_patients', en: 'Difficulty finding a provider accepting new patients', es: 'Dificultad para encontrar un proveedor que acepte pacientes nuevos' },
          { value: 'none', en: 'No difficulty accessing healthcare', es: 'Ninguna dificultad para acceder a atención médica' },
          SV_PNA,
        ],
      },
      {
        key: 'unmet_need', type: 'single',
        en: 'Before today\'s clinic, did you have an unmet dental, medical, or vision need?',
        es: 'Antes de la clínica de hoy, ¿tenía una necesidad dental, médica o de la vista sin atender?',
        options: SV_YES_NO_UNSURE_PNA,
      },
      {
        key: 'food_insecurity', type: 'single',
        en: 'In the past 12 months, have you had difficulty obtaining enough food for yourself or your household?',
        es: 'En los últimos 12 meses, ¿ha tenido dificultad para conseguir suficiente comida para usted o su hogar?',
        options: SV_YES_NO_PNA,
      },
    ],
  },
];

const SURVEY_QUESTIONS = SURVEY_REGISTRATION.reduce((all, s) => all.concat(s.questions), []);
// The validator is DERIVED from the very list the page renders, so what is
// offered and what is accepted cannot drift apart. Mirrors SURVEY_SCHEMA /
// SURVEY_MULTI in src/main/db.js, which guards the same blob on arrival.
const SURVEY_ALLOWED = {};
const SURVEY_MULTI = new Set();
for (const q of SURVEY_QUESTIONS) {
  SURVEY_ALLOWED[q.key] = q.options.map((o) => o.value);
  if (q.type === 'multi') SURVEY_MULTI.add(q.key);
}

// Keep only questions the survey defines and only values those questions offer.
// This endpoint is reachable directly, and an invented value would land in the
// report as a bucket nothing can explain. An unrecognised answer is dropped
// rather than failing the whole registration: every question here is optional,
// so "not answered" is an honest record of it, and losing a patient's entire
// pre-registration over one bad optional field would not be.
function sanitizeSurveyAnswers(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [key, allowed] of Object.entries(SURVEY_ALLOWED)) {
    const v = src[key];
    if (v == null || v === '') continue;
    if (SURVEY_MULTI.has(key)) {
      const picked = Array.from(new Set((Array.isArray(v) ? v : [v]).map(String).filter((x) => allowed.includes(x))));
      // 'None' and 'Prefer not to answer' are answers ABOUT the list, so they
      // replace it rather than joining it — as they do on the walk-in form. A
      // row must not say both "receives SNAP" and "receives no assistance".
      const exclusive = picked.find((x) => x === 'none' || x === 'pna');
      if (exclusive) out[key] = [exclusive];
      else if (picked.length) out[key] = picked;
    } else if (allowed.includes(String(v))) {
      out[key] = String(v);
    }
  }
  return out;
}

// Bilingual dictionary — keys stay identical (they map to the app's data); only
// the DISPLAY text differs. Spanish uses the app's own translations verbatim.
const I18N = {
  en: {
    switchLabel: 'Español', switchLang: 'es',
    heroSub: 'Fill this out ahead of time and sign your consent to save time at the clinic. Your answers go straight to the front desk.',
    about: 'About You', first: 'First name', last: 'Last name', dob: 'Date of birth', gender: 'Gender',
    gOpt: [['', '—'], ['male', 'Male'], ['female', 'Female'], ['other', 'Other']],
    phone: 'Phone number', email: 'Email', address: 'Home address', city: 'City', state: 'State',
    emName: 'Emergency contact name', emPhone: 'Emergency contact phone',
    need: 'What do you need today?',
    services: 'Services needed today', servicesList: FORM_SERVICES, serviceHint: 'Choose every clinic you need to be seen at.',
    referral: 'How did you hear about us?', referralOther: 'Please specify', referralList: FORM_REFERRALS,
    surveyTitle: 'A few last questions',
    surveyLede: 'These last questions help Mission Minded Worldwide show what this clinic did for the community, and apply for the funding that keeps it free.',
    surveyPrivacy: 'Every question is optional, your answers are reported as totals only, and none of this changes the care you receive today.',
    optional: 'Optional', surveySkip: 'I would rather not answer these', surveySkipped: 'Skipped — tap any answer to change your mind',
    raceTitle: 'Race and ethnicity', raceHint: 'Optional. Choose any that apply — used only for reporting how the clinic served the community.',
    raceList: [['american_indian_alaska_native', 'American Indian or Alaska Native'], ['asian', 'Asian'], ['black_african_american', 'Black or African American'], ['hispanic_latino', 'Hispanic or Latino'], ['middle_eastern_north_african', 'Middle Eastern or North African'], ['native_hawaiian_pacific_islander', 'Native Hawaiian or Pacific Islander'], ['white', 'White'], ['prefer_not', 'Prefer not to answer']],
    allergies: 'Medication allergies', selectAll: 'Select all that apply', allergyOther: 'Other allergy (specify)',
    conditions: 'Do you have any of these conditions?', conditionOther: 'Other condition (specify)', none: 'None of the above', otherOpt: 'Other (type below)',
    meds: 'Current medications', addMed: '+ Add medication', noMeds: 'No medications', medNamePh: 'Medication',
    medHist: 'Medical History', dentHist: 'Dental History', priorDentist: 'When did you last see a dentist?', yes: 'Yes', no: 'No', notApplicable: 'Not applicable', dash: '—',
    priorDentistOpts: [['within_6_months', 'Within the past 6 months'], ['about_1_year', 'About 1 year ago'], ['about_2_years', 'About 2 years ago'], ['over_3_years', '3 or more years ago'], ['never', 'Never']],
    consent: 'Consent', signName: 'Your name (for the signature)', relationship: 'Relationship (if for a minor)', relPh: 'Self / Parent / Guardian',
    agree: CONSENT_AGREE_TEXT, sigOpt: 'Signature', sigHint: 'Sign with your finger or a stylus.', clear: 'Clear',
    surgery: 'Surgery Consent', surgeryIntro: 'Because an extraction may be done, please also read and sign this.', teeth: 'Tooth number(s), if known',
    submit: 'Submit pre-registration', submitting: 'Submitting…', footer: 'Mission Minded Worldwide — free dental care. Your information is shared only with the clinic team.',
    thankYou: 'Thank you, ', done: 'Your pre-registration and consent are complete. Please bring a photo ID — the front desk already has your information.',
    errName: 'Please enter your first and last name.', errDob: 'Please enter your date of birth.', errGender: 'Please choose a gender.',
    errCity: 'Please enter your city.', errState: 'Please enter your state.',
    errEmName: 'Please enter an emergency contact name.', errEmPhone: 'Please enter an emergency contact phone number.',
    errServices: 'Please choose at least one service.',
    errMedical: 'Please answer every medical and dental history question.',
    errConsent: 'Please read and agree to the consent to finish.', errSurgery: 'An extraction was selected — please read and agree to the Oral Surgery consent too.',
    errSign: 'Please sign the consent to finish.', errSignSurgery: 'Please sign the Oral Surgery consent.', errSigner: 'Please type your name for the signature.',
    netErr: 'Network error. Please try again.', genErr: 'Something went wrong. Please try again.',
    visits: FORM_VISITS, allergyList: FORM_ALLERGIES, conditionList: FORM_CONDITIONS, medYesNo: FORM_MED_YESNO, dentalYesNo: FORM_DENTAL_YESNO,
    generalTitle: GENERAL_CONSENT_TITLE, generalMode: 'ol', general: GENERAL_CONSENT, surgeryTitle: ORAL_SURGERY_TITLE, surgeryText: ORAL_SURGERY_CONSENT,
  },
  es: {
    switchLabel: 'English', switchLang: 'en',
    heroSub: 'Complete esto con anticipación y firme su consentimiento para ahorrar tiempo en la clínica. Sus respuestas van directamente a la recepción.',
    about: 'Sobre usted', first: 'Nombre', last: 'Apellido', dob: 'Fecha de nacimiento', gender: 'Género',
    gOpt: [['', '—'], ['male', 'Masculino'], ['female', 'Femenino'], ['other', 'Otro']],
    phone: 'Teléfono', email: 'Correo electrónico', address: 'Dirección', city: 'Ciudad', state: 'Estado',
    emName: 'Nombre de contacto de emergencia', emPhone: 'Teléfono de contacto de emergencia',
    need: '¿Qué necesita hoy?',
    services: 'Servicios que necesita hoy', servicesList: FORM_SERVICES_ES, serviceHint: 'Elija todas las clínicas donde necesita ser atendido.',
    referral: '¿Cómo se enteró de nosotros?', referralOther: 'Por favor especifique', referralList: FORM_REFERRALS_ES,
    surveyTitle: 'Unas últimas preguntas',
    surveyLede: 'Estas últimas preguntas ayudan a Mission Minded Worldwide a mostrar lo que esta clínica hizo por la comunidad y a solicitar los fondos que la mantienen gratuita.',
    surveyPrivacy: 'Cada pregunta es opcional, sus respuestas se reportan solo como totales y nada de esto cambia la atención que recibe hoy.',
    optional: 'Opcional', surveySkip: 'Prefiero no responder estas preguntas', surveySkipped: 'Omitida — toque cualquier respuesta para cambiar',
    raceTitle: 'Raza y origen étnico', raceHint: 'Opcional. Elija todas las que correspondan — solo se usa para informar cómo la clínica sirvió a la comunidad.',
    raceList: [['american_indian_alaska_native', 'Indígena de América o nativo de Alaska'], ['asian', 'Asiático'], ['black_african_american', 'Negro o afroamericano'], ['hispanic_latino', 'Hispano o latino'], ['middle_eastern_north_african', 'De Medio Oriente o del norte de África'], ['native_hawaiian_pacific_islander', 'Nativo de Hawái o de las islas del Pacífico'], ['white', 'Blanco'], ['prefer_not', 'Prefiero no responder']],
    allergies: 'Alergias a medicamentos', selectAll: 'Seleccione todas las que apliquen', allergyOther: 'Otra alergia (especifique)',
    conditions: '¿Tiene alguna de estas condiciones?', conditionOther: 'Otra condición (especifique)', none: 'Ninguna de las anteriores', otherOpt: 'Otra (escriba abajo)',
    meds: 'Medicamentos actuales', addMed: '+ Agregar medicamento', noMeds: 'Sin medicamentos', medNamePh: 'Medicamento',
    medHist: 'Historial médico', dentHist: 'Historial dental', priorDentist: '¿Cuándo visitó al dentista por última vez?', yes: 'Sí', no: 'No', notApplicable: 'No aplica', dash: '—',
    priorDentistOpts: [['within_6_months', 'En los últimos 6 meses'], ['about_1_year', 'Hace aproximadamente 1 año'], ['about_2_years', 'Hace aproximadamente 2 años'], ['over_3_years', 'Hace 3 años o más'], ['never', 'Nunca']],
    consent: 'Consentimiento', signName: 'Su nombre (para la firma)', relationship: 'Parentesco (si es para un menor)', relPh: 'Yo mismo / Padre / Tutor',
    agree: 'He leído y entiendo lo anterior, y doy mi consentimiento.', sigOpt: 'Firma', sigHint: 'Firme con su dedo o un lápiz óptico.', clear: 'Borrar',
    surgery: 'Consentimiento de Cirugía', surgeryIntro: 'Como podría realizarse una extracción, lea y firme esto también.', teeth: 'Número(s) de diente, si los sabe',
    submit: 'Enviar pre-registro', submitting: 'Enviando…', footer: 'Mission Minded Worldwide — atención dental gratuita. Su información se comparte solo con el equipo de la clínica.',
    thankYou: 'Gracias, ', done: 'Su pre-registro y consentimiento están completos. Por favor traiga una identificación con foto — la recepción ya tiene su información.',
    errName: 'Por favor ingrese su nombre y apellido.', errDob: 'Por favor ingrese su fecha de nacimiento.', errGender: 'Por favor elija un género.',
    errCity: 'Por favor ingrese su ciudad.', errState: 'Por favor ingrese su estado.',
    errEmName: 'Por favor ingrese el nombre de un contacto de emergencia.', errEmPhone: 'Por favor ingrese el teléfono del contacto de emergencia.',
    errServices: 'Elija al menos un servicio.',
    errMedical: 'Por favor responda todas las preguntas del historial médico y dental.',
    errConsent: 'Por favor lea y acepte el consentimiento para terminar.', errSurgery: 'Se seleccionó una extracción — por favor lea y acepte también el consentimiento de cirugía oral.',
    errSign: 'Por favor firme el consentimiento para terminar.', errSignSurgery: 'Por favor firme el consentimiento de cirugía oral.', errSigner: 'Por favor escriba su nombre para la firma.',
    netErr: 'Error de red. Por favor intente de nuevo.', genErr: 'Algo salió mal. Por favor intente de nuevo.',
    visits: FORM_VISITS_ES, allergyList: FORM_ALLERGIES_ES, conditionList: FORM_CONDITIONS_ES, medYesNo: FORM_MED_YESNO_ES, dentalYesNo: FORM_DENTAL_YESNO_ES,
    generalTitle: 'Consentimiento General para Tratamiento Dental', generalMode: 'p', general: GENERAL_CONSENT_ES, surgeryTitle: 'Consentimiento de Cirugía Oral / Extracción', surgeryText: ORAL_SURGERY_ES,
  },
};


function htmlEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function htmlResponse(html, status) {
  return new Response(html, {
    status: status || 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...CORS_HEADERS },
  });
}
// A clinic that has been closed in the app. Distinct from a bad link — the
// person followed a real link, it is just over.
function checkinClosedPage(name) {
  return checkinShell('Clinic closed',
    '<h1>' + htmlEscape(name || 'This clinic') + ' has closed</h1>' +
    '<p>This clinic is no longer taking pre-registrations online. Please contact the clinic if you need care.</p>' +
    '<p lang="es">Esta clínica ya no acepta pre-registros en línea. Comuníquese con la clínica si necesita atención.</p>');
}
function checkinErrorPage() {
  return checkinShell('Link not found', '<h1>Pre-registration link not found</h1><p>This link is not valid or the clinic event has ended. Please check the link with your clinic.</p>');
}
function checkinShell(title, inner) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + htmlEscape(title) + ' · Mission Minded</title>' +
    '<style>' +
    ':root{--g:#2f8f66;--ink:#12303f;--mut:#5b6b74;--line:#e2e8ec;--bg:#f4f6f7}' +
    '*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}' +
    '.wrap{max-width:560px;margin:0 auto;padding:20px 16px 60px}' +
    '.hero{background:var(--g);color:#fff;border-radius:14px;padding:20px;margin-bottom:18px}' +
    '.hero .ey{font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85}' +
    '.hero h1{margin:6px 0 2px;font-size:22px}.hero p{margin:0;opacity:.9;font-size:14px}' +
    '.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}' +
    'h2{font-size:15px;margin:0 0 12px}label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}' +
    'input[type=text],input[type=tel],input[type=email],input[type=date],select,textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:16px;background:#fff;color:var(--ink)}' +
    'textarea{min-height:64px;resize:vertical}.row{display:flex;gap:10px}.row>*{flex:1}' +
    '.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}' +
    '.chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;padding:8px 12px;font-size:14px;cursor:pointer;background:#fff}' +
    '.chip input{width:auto;margin:0}.chip.on{border-color:var(--g);background:#eaf5ef;color:var(--g);font-weight:600}' +
    '.hint{font-size:12px;color:var(--mut);margin:2px 0 0}' +
    '.btn{width:100%;padding:14px;border:0;border-radius:12px;background:var(--g);color:#fff;font-size:16px;font-weight:700;cursor:pointer;margin-top:8px}' +
    '.btn:disabled{opacity:.6}.req{color:#c0392b}' +
    '.med-row{display:flex;gap:8px;margin-top:8px}.med-row input{flex:1}.med-row button{border:1px solid var(--line);background:#fff;border-radius:10px;padding:0 12px;cursor:pointer}' +
    '.addbtn{border:1px dashed var(--line);background:#fff;border-radius:10px;padding:9px 12px;font-size:14px;cursor:pointer;margin-top:8px}' +
    '.ok{text-align:center;padding:30px 10px}.ok .big{font-size:44px}.err{color:#c0392b;font-size:14px;margin-top:8px}' +
    '.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
    '.yn{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}.yn:last-child{border-bottom:0}.yn span{font-size:13px;font-weight:600}.yn select{width:120px}' +
    '.consent{max-height:230px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:#fbfcfc;font-size:12.5px;line-height:1.55;color:#33454f}' +
    '.consent h3{font-size:13px;margin:0 0 8px;color:var(--ink)}.consent ol{margin:0;padding-left:18px}.consent li{margin:0 0 8px}.consent p{margin:0 0 9px}' +
    '.agree{display:flex;gap:9px;align-items:flex-start;margin-top:12px;font-size:14px;font-weight:600}.agree input{width:auto;margin:2px 0 0}' +
    '.sig{border:1px dashed var(--line);border-radius:10px;background:#fff;touch-action:none;width:100%;height:150px;display:block;margin-top:6px}' +
    '.sigbar{display:flex;justify-content:space-between;align-items:center;margin-top:6px}.sigbar a{font-size:13px;color:var(--g);text-decoration:underline;cursor:pointer}' +
    '.svs{font-size:12px;margin:18px 0 0;color:var(--g);letter-spacing:.06em;text-transform:uppercase}.svs:first-child{margin-top:0}' +
    '.svq{padding:11px 0;border-bottom:1px solid var(--line)}.svq:last-child{border-bottom:0}' +
    '.svq-h{display:flex;justify-content:space-between;align-items:baseline;gap:10px}.svq-h .q{font-size:13px;font-weight:600}' +
    '.svq-h .opt{font-size:11px;font-weight:600;color:var(--mut);letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}' +
    '</style></head><body><div class="wrap">' + inner + '</div></body></html>';
}
function checkinFormPage(eventUid, eventName, lang) {
  const L = I18N[lang] || I18N.en;
  const chip = (name, k, label) => '<label class="chip"><input type="checkbox" name="' + name + '" value="' + htmlEscape(k) + '">' + htmlEscape(label) + '</label>';
  const allergyChips = L.allergyList.map(([k, l]) => chip('allergy', k, l)).join('') + chip('allergy', 'none', L.none) + chip('allergy', 'other', L.otherOpt);
  const condChips = L.conditionList.map(([k, l]) => chip('condition', k, l)).join('') + chip('condition', 'none', L.none) + chip('condition', 'other', L.otherOpt);
  const raceChips = L.raceList.map(([k, l]) => chip('race', k, l)).join('');
  const visitOpts = L.visits.map(([k, l]) => '<label class="chip"><input type="radio" name="visit" value="' + htmlEscape(k) + '">' + htmlEscape(l) + '</label>').join('');
  const serviceChips = L.servicesList.map(([k, l]) => chip('service', k, l)).join('');
  const referralOpts = '<option value="">' + htmlEscape(L.dash) + '</option>' +
    L.referralList.map(([k, l]) => '<option value="' + htmlEscape(k) + '">' + htmlEscape(l) + '</option>').join('');
  // Choice-only by design: nothing free-text, so the aggregate carries no
  // sentence a patient could be identified by and can outlive the clinic's own
  // records.
  const svQuestion = (q) => {
    const multi = q.type === 'multi';
    const hint = lang === 'es' ? q.hintEs : q.hintEn;
    return '<div class="svq"><div class="svq-h"><span class="q">' + htmlEscape(q[lang] || q.en) + '</span>' +
      '<span class="opt">' + htmlEscape(L.optional) + '</span></div>' +
      (hint ? '<p class="hint">' + htmlEscape(hint) + '</p>' : '') +
      '<div class="chips">' + q.options.map((o) =>
        '<label class="chip"><input type="' + (multi ? 'checkbox' : 'radio') + '" name="' + (multi ? 'svm_' : 'sv_') + q.key +
        '" value="' + htmlEscape(o.value) + '">' + htmlEscape(o[lang] || o.en) + '</label>').join('') +
      '</div></div>';
  };
  const surveyBody = SURVEY_REGISTRATION.map((sec) =>
    '<h3 class="svs">' + htmlEscape(sec[lang] || sec.en) + '</h3>' + sec.questions.map(svQuestion).join('')).join('');
  // Every history question is required: a blank is not the same as "no", and the
  // dentist reads these before deciding whether it is safe to treat.
  // Pregnancy alone carries a third answer. It is a compound question —
  // pregnant, nursing, or taking contraceptives — and for a man, a child or a
  // post-menopausal patient, being made to tap "No" makes their answer
  // indistinguishable from the clinically loaded No the dentist reads before
  // deciding what is safe to give. The walk-in form offers it; so must this.
  const ynRow = (id, label) => '<div class="yn"><span>' + htmlEscape(label) + ' <span class="req">*</span></span><select id="' + id + '"><option value="">' + htmlEscape(L.dash) + '</option><option value="yes">' + htmlEscape(L.yes) + '</option><option value="no">' + htmlEscape(L.no) + '</option>' + (id === 'pregnancy' ? '<option value="na">' + htmlEscape(L.notApplicable) + '</option>' : '') + '</select></div>';
  const medYesNo = L.medYesNo.map(([k, l]) => ynRow(k, l)).join('');
  const dentalYesNo = L.dentalYesNo.map(([k, l]) => ynRow(k, l)).join('');
  const genConsent = '<h3>' + htmlEscape(L.generalTitle) + '</h3>' + (L.generalMode === 'ol' ? ('<ol>' + L.general.map((c) => '<li>' + htmlEscape(c) + '</li>').join('') + '</ol>') : L.general.map((c) => '<p>' + htmlEscape(c) + '</p>').join(''));
  const surConsent = '<h3>' + htmlEscape(L.surgeryTitle) + '</h3>' + L.surgeryText.map((c) => '<p>' + htmlEscape(c) + '</p>').join('');
  const T = { errName: L.errName, errDob: L.errDob, errGender: L.errGender, errCity: L.errCity, errState: L.errState, errEmName: L.errEmName, errEmPhone: L.errEmPhone, errServices: L.errServices, errMedical: L.errMedical, errConsent: L.errConsent, errSurgery: L.errSurgery, errSign: L.errSign, errSignSurgery: L.errSignSurgery, errSigner: L.errSigner, submitting: L.submitting, submitLabel: L.submit, thankYou: L.thankYou, done: L.done, netErr: L.netErr, genErr: L.genErr, medNamePh: L.medNamePh, surveySkip: L.surveySkip, surveySkipped: L.surveySkipped };

  const inner =
    '<div class="hero"><div style="display:flex;justify-content:space-between;align-items:center"><div class="ey">Mission Minded · Pre-registration</div>' +
    '<a href="?lang=' + L.switchLang + '" style="color:#fff;font-size:13px;text-decoration:underline">' + htmlEscape(L.switchLabel) + '</a></div>' +
    '<h1>' + htmlEscape(eventName) + '</h1><p>' + htmlEscape(L.heroSub) + '</p></div>' +
    '<form id="f">' +

    '<div class="card"><h2>' + htmlEscape(L.about) + '</h2>' +
    '<div class="row"><div><label>' + htmlEscape(L.first) + ' <span class="req">*</span></label><input type="text" id="first_name" autocomplete="given-name"></div>' +
    '<div><label>' + htmlEscape(L.last) + ' <span class="req">*</span></label><input type="text" id="last_name" autocomplete="family-name"></div></div>' +
    '<div class="row"><div><label>' + htmlEscape(L.dob) + ' <span class="req">*</span></label><input type="date" id="dob"></div>' +
    '<div><label>' + htmlEscape(L.gender) + ' <span class="req">*</span></label><select id="gender">' + L.gOpt.map(([v, t2]) => '<option value="' + htmlEscape(v) + '">' + htmlEscape(t2) + '</option>').join('') + '</select></div></div>' +
    '<div class="row"><div><label>' + htmlEscape(L.phone) + '</label><input type="tel" id="phone" inputmode="numeric" autocomplete="tel"></div>' +
    '<div><label>' + htmlEscape(L.email) + '</label><input type="email" id="email" autocomplete="email"></div></div>' +
    '<label>' + htmlEscape(L.address) + '</label><input type="text" id="address" autocomplete="street-address">' +
    '<div class="row"><div><label>' + htmlEscape(L.city) + ' <span class="req">*</span></label><input type="text" id="city" autocomplete="address-level2"></div>' +
    '<div><label>' + htmlEscape(L.state) + ' <span class="req">*</span></label><select id="state" autocomplete="address-level1"><option value="">' + htmlEscape(L.dash) + '</option>' + US_STATE_OPTIONS + '</select></div></div>' +
    '<div class="row"><div><label>' + htmlEscape(L.emName) + ' <span class="req">*</span></label><input type="text" id="emergency_name"></div>' +
    '<div><label>' + htmlEscape(L.emPhone) + ' <span class="req">*</span></label><input type="tel" id="emergency_phone" inputmode="numeric"></div></div>' +
    '<label>' + htmlEscape(L.referral) + '</label><select id="referral">' + referralOpts + '</select>' +
    '<div id="referralOtherWrap" style="display:none"><label>' + htmlEscape(L.referralOther) + '</label><input type="text" id="referral_other"></div>' +
    '</div>' +

    '<div class="card"><h2>' + htmlEscape(L.services) + ' <span class="req">*</span></h2><p class="hint" style="margin:0 0 6px">' + htmlEscape(L.serviceHint) + '</p>' +
    '<div class="chips" id="services">' + serviceChips + '</div></div>' +

    '<div class="card"><h2>' + htmlEscape(L.need) + '</h2><div class="chips">' + visitOpts + '</div>' +
    '</div>' +

    '<div class="card"><h2>' + htmlEscape(L.raceTitle) + '</h2><p class="hint" style="margin:0 0 6px">' + htmlEscape(L.raceHint) + '</p><div class="chips" id="race">' + raceChips + '</div></div>' +

    '<div class="card"><h2>' + htmlEscape(L.allergies) + '</h2><p class="hint" style="margin:0 0 6px">' + htmlEscape(L.selectAll) + '</p><div class="chips" id="allergies">' + allergyChips + '</div>' +
    '<input type="text" id="allergies_other" placeholder="' + htmlEscape(L.allergyOther) + '" style="margin-top:8px"></div>' +

    '<div class="card"><h2>' + htmlEscape(L.conditions) + '</h2><p class="hint" style="margin:0 0 6px">' + htmlEscape(L.selectAll) + '</p><div class="chips" id="conditions">' + condChips + '</div>' +
    '<input type="text" id="conditions_other" placeholder="' + htmlEscape(L.conditionOther) + '" style="margin-top:8px"></div>' +

    '<div class="card"><h2>' + htmlEscape(L.meds) + '</h2><datalist id="medlist">' + MED_OPTIONS + '</datalist><div id="meds"></div>' +
    '<button type="button" class="addbtn" id="addmed">' + htmlEscape(L.addMed) + '</button>' +
    '<label class="chip" style="margin-top:10px"><input type="checkbox" id="medications_none">' + htmlEscape(L.noMeds) + '</label></div>' +

    '<div class="card"><h2>' + htmlEscape(L.medHist) + '</h2>' + medYesNo + '</div>' +

    '<div class="card"><h2>' + htmlEscape(L.dentHist) + '</h2><label>' + htmlEscape(L.priorDentist) + '</label>' +
      '<select id="prior_dentist"><option value="">' + htmlEscape(L.dash) + '</option>' +
      L.priorDentistOpts.map(function (o) { return '<option value="' + o[0] + '">' + htmlEscape(o[1]) + '</option>'; }).join('') +
      '</select>' + dentalYesNo + '</div>' +

    '<div class="card"><h2>' + htmlEscape(L.consent) + '</h2><div class="consent">' + genConsent + '</div>' +
    '<div class="row" style="margin-top:10px"><div><label>' + htmlEscape(L.signName) + '</label><input type="text" id="signer"></div>' +
    '<div><label>' + htmlEscape(L.relationship) + '</label><input type="text" id="relationship" placeholder="' + htmlEscape(L.relPh) + '"></div></div>' +
    '<label class="agree"><input type="checkbox" id="cagree"><span>' + htmlEscape(L.agree) + '</span></label>' +
    '<label style="margin-top:10px">' + htmlEscape(L.sigOpt) + ' <span class="req">*</span></label><canvas id="gsig" class="sig"></canvas>' +
    '<div class="sigbar"><span class="hint">' + htmlEscape(L.sigHint) + '</span><a id="gclear">' + htmlEscape(L.clear) + '</a></div></div>' +

    '<div class="card" id="surgeryCard" style="display:none"><h2>' + htmlEscape(L.surgery) + '</h2>' +
    '<p class="hint" style="margin:0 0 8px">' + htmlEscape(L.surgeryIntro) + '</p><div class="consent">' + surConsent + '</div>' +
    '<label style="margin-top:10px">' + htmlEscape(L.teeth) + '</label><input type="text" id="steeth" placeholder="e.g. 14, 15">' +
    '<label class="agree"><input type="checkbox" id="sagree"><span>' + htmlEscape(L.agree) + '</span></label>' +
    '<label style="margin-top:10px">' + htmlEscape(L.sigOpt) + ' <span class="req">*</span></label><canvas id="ssig" class="sig"></canvas>' +
    '<div class="sigbar"><span class="hint">' + htmlEscape(L.sigHint) + '</span><a id="sclear">' + htmlEscape(L.clear) + '</a></div></div>' +

    '<div class="card"><h2>' + htmlEscape(L.surveyTitle) + '</h2>' +
    '<p class="hint" style="margin:0 0 6px">' + htmlEscape(L.surveyLede) + '</p>' +
    '<p class="hint" style="margin:0 0 6px">' + htmlEscape(L.surveyPrivacy) + '</p>' +
    '<div id="survey">' + surveyBody + '</div>' +
    '<label class="chip" style="margin-top:12px"><input type="checkbox" id="survey_skip"><span id="skipText">' + htmlEscape(L.surveySkip) + '</span></label></div>' +

    '<div class="err" id="err"></div>' +
    '<button class="btn" id="submit" type="submit">' + htmlEscape(L.submit) + '</button>' +
    '<p class="hint" style="text-align:center;margin-top:14px">' + htmlEscape(L.footer) + '</p>' +
    '</form>' +

    '<script>' +
    'var T=' + JSON.stringify(T) + ';var LANG=' + JSON.stringify(lang) + ';' +
    'var MEDQ=' + JSON.stringify(L.medYesNo.map(([k]) => k)) + ';' +
    'var DENTQ=' + JSON.stringify(L.dentalYesNo.map(([k]) => k)) + ';' +
    'var SVQ=' + JSON.stringify(SURVEY_QUESTIONS.map((q) => [q.key, q.type])) + ';' +
    "function el(id){return document.getElementById(id);}function val(id){var e=el(id);return e?e.value:'';}" +
    "function chipwire(id){document.querySelectorAll('#'+id+' .chip input').forEach(function(i){i.addEventListener('change',function(){i.closest('.chip').classList.toggle('on',i.checked);});});}" +
    "chipwire('allergies');chipwire('conditions');chipwire('services');" +
    "function syncRefOther(){el('referralOtherWrap').style.display=val('referral')==='other'?'':'none';}el('referral').addEventListener('change',syncRefOther);syncRefOther();" +
    "function checked(name){return Array.prototype.slice.call(document.querySelectorAll('input[name='+name+']:checked')).map(function(i){return i.value;});}" +
    "function mkpad(id){var c=el(id);if(!c)return null;var ctx=c.getContext('2d');var drawing=false,empty=true;function fit(){var r=c.getBoundingClientRect();if(!r.width)return;c.width=r.width;c.height=150;ctx.lineWidth=2.2;ctx.lineCap='round';ctx.strokeStyle='#12303f';}fit();window.addEventListener('resize',fit);function pt(e){var r=c.getBoundingClientRect();var t=(e.touches&&e.touches[0])?e.touches[0]:e;return{x:t.clientX-r.left,y:t.clientY-r.top};}function down(e){drawing=true;empty=false;var p=pt(e);ctx.beginPath();ctx.moveTo(p.x,p.y);e.preventDefault();}function mv(e){if(!drawing)return;var p=pt(e);ctx.lineTo(p.x,p.y);ctx.stroke();e.preventDefault();}function up(){drawing=false;}c.addEventListener('pointerdown',down);c.addEventListener('pointermove',mv);window.addEventListener('pointerup',up);return{data:function(){return empty?null:c.toDataURL('image/png');},clear:function(){ctx.clearRect(0,0,c.width,c.height);empty=true;},fit:fit};}" +
    "var gpad=mkpad('gsig');var spad=mkpad('ssig');el('gclear').onclick=function(){if(gpad)gpad.clear();};if(el('sclear'))el('sclear').onclick=function(){if(spad)spad.clear();};" +
    "document.querySelectorAll('input[name=visit]').forEach(function(i){i.addEventListener('change',function(){document.querySelectorAll('input[name=visit]').forEach(function(r){r.closest('.chip').classList.toggle('on',r.checked);});var v=(document.querySelector('input[name=visit]:checked')||{}).value||'';var ex=(v==='extraction_pain'||v==='extraction_no_pain');el('surgeryCard').style.display=ex?'block':'none';if(ex&&spad)setTimeout(function(){spad.fit();},0);});});" +
    "function svgroup(name){document.querySelectorAll('input[name='+name+']').forEach(function(r){r.closest('.chip').classList.toggle('on',r.checked);});}" +
    // 'None' and 'Prefer not to answer' are answers ABOUT the list, so they
    // replace it rather than joining it — the same rule the walk-in form applies.
    "function svexclusive(i){if(!i.checked)return;var ex=(i.value==='none'||i.value==='pna');document.querySelectorAll('input[name='+i.name+']').forEach(function(o){if(o!==i&&(ex||o.value==='none'||o.value==='pna'))o.checked=false;});}" +
    "var skipBox=el('survey_skip');function setSkip(on){skipBox.checked=on;skipBox.closest('.chip').classList.toggle('on',on);el('skipText').textContent=on?T.surveySkipped:T.surveySkip;if(on)document.querySelectorAll('#survey .chip input').forEach(function(i){i.checked=false;i.closest('.chip').classList.remove('on');});}" +
    "skipBox.addEventListener('change',function(){setSkip(skipBox.checked);});" +
    // Answering anything overrides a skip, so the two can never both be true.
    "document.querySelectorAll('#survey .chip input').forEach(function(i){i.addEventListener('change',function(){if(i.type==='checkbox')svexclusive(i);svgroup(i.name);if(i.checked)setSkip(false);});});" +
    "function survey(){var out={};SVQ.forEach(function(q){if(q[1]==='multi'){var v=checked('svm_'+q[0]);if(v.length)out[q[0]]=v;}else{var r=document.querySelector('input[name=sv_'+q[0]+']:checked');if(r)out[q[0]]=r.value;}});return out;}" +
    "var meds=el('meds');function addmed(){var d=document.createElement('div');d.className='med-row';d.innerHTML='<input type=\"text\" list=\"medlist\" autocomplete=\"off\" placeholder=\"'+T.medNamePh+'\"><button type=\"button\">✕</button>';d.querySelector('button').onclick=function(){d.remove();};meds.appendChild(d);}el('addmed').onclick=addmed;" +
    "el('f').addEventListener('submit',function(e){e.preventDefault();var err=el('err');err.textContent='';" +
    "var fn=val('first_name').trim(),ln=val('last_name').trim();if(!fn||!ln){err.textContent=T.errName;window.scrollTo(0,0);return;}" +
    "if(!val('dob')){err.textContent=T.errDob;return;}if(!val('gender')){err.textContent=T.errGender;return;}" +
    "if(!val('city')){err.textContent=T.errCity;return;}if(!val('state')){err.textContent=T.errState;return;}" +
    "if(!val('emergency_name').trim()){err.textContent=T.errEmName;el('emergency_name').focus();return;}" +
    "if(!val('emergency_phone').trim()){err.textContent=T.errEmPhone;el('emergency_phone').focus();return;}" +
    "if(!checked('service').length){err.textContent=T.errServices;el('services').scrollIntoView({block:'center'});return;}" +
    // Every medical and dental history question must be answered — a blank is
    // not the same as "no", and the dentist reads these before treating.
    "var unanswered=null;" +
    "MEDQ.concat(DENTQ).forEach(function(k){if(!unanswered&&!val(k))unanswered=k;});" +
    "if(unanswered){err.textContent=T.errMedical;var e2=el(unanswered);if(e2){e2.scrollIntoView({block:'center'});e2.focus();}return;}" +
    "if(!el('cagree').checked){err.textContent=T.errConsent;return;}" +
    "if(!val('signer').trim()){err.textContent=T.errSigner;return;}" +
    "if(!gpad||!gpad.data()){err.textContent=T.errSign;el('gsig').scrollIntoView({block:'center'});return;}" +
    "var visit=(document.querySelector('input[name=visit]:checked')||{}).value||'';var extraction=(visit==='extraction_pain'||visit==='extraction_no_pain');" +
    "if(extraction&&!el('sagree').checked){err.textContent=T.errSurgery;return;}" +
    "if(extraction&&(!spad||!spad.data())){err.textContent=T.errSignSurgery;el('ssig').scrollIntoView({block:'center'});return;}" +
    "var payload={first_name:fn,last_name:ln,dob:val('dob'),gender:val('gender'),phone:val('phone'),email:val('email'),language:LANG,address:val('address'),city:val('city'),state:val('state'),emergency_name:val('emergency_name'),emergency_phone:val('emergency_phone')," +
    "services:checked('service'),referral:val('referral'),referral_other:val('referral_other'),survey:survey(),survey_declined:skipBox.checked," +
    "visit_type:visit,race:checked('race'),allergies:checked('allergy'),allergies_other:val('allergies_other'),conditions:checked('condition'),conditions_other:val('conditions_other')," +
    "medications:Array.prototype.slice.call(meds.querySelectorAll('input')).map(function(i){return i.value.trim();}).filter(Boolean),medications_none:el('medications_none').checked," +
    "under_treatment:val('under_treatment'),hospitalized:val('hospitalized'),tobacco:val('tobacco'),pregnancy:val('pregnancy')," +
    "prior_dentist:val('prior_dentist'),gum_bleeding:val('gum_bleeding'),sores:val('sores'),jaw_injury:val('jaw_injury'),grinding:val('grinding'),post_extraction_bleeding:val('post_extraction_bleeding'),ortho:val('ortho')," +
    "consent_agree:el('cagree').checked,signer_name:val('signer'),relationship:val('relationship'),signature_png:gpad?gpad.data():null," +
    "surgery_agree:el('sagree')?el('sagree').checked:false,surgery_teeth:val('steeth'),surgery_signature_png:spad?spad.data():null};" +
    "var b=el('submit');b.disabled=true;b.textContent=T.submitting;" +
    "fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}).then(function(r){return r.json();}).then(function(j){if(j&&j.ok){document.querySelector('.wrap').innerHTML='<div class=\"hero\"><div class=\"ey\">Mission Minded</div><h1>'+T.thankYou+fn.replace(/[<>&]/g,'')+'!</h1></div><div class=\"card ok\"><div class=\"big\">✅</div><p>'+T.done+'</p></div>';window.scrollTo(0,0);}else{err.textContent=(j&&j.error)||T.genErr;b.disabled=false;b.textContent=T.submitLabel;}}).catch(function(){err.textContent=T.netErr;b.disabled=false;b.textContent=T.submitLabel;});});" +
    '</script>';
  return checkinShell('Pre-register · ' + eventName, inner);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// The clinic key comes from the CLINIC_KEY secret and nowhere else.
//
// This used to fall back to a built-in default so a freshly-pasted Worker was
// online with zero setup. That default was a single shared bearer token, the
// same one compiled into the desktop app, guarding an untenanted table — so
// anyone holding it could read and write every clinic's records. A sync server
// with no key configured now serves nobody rather than serving everybody.
function isAuthorized(request, env) {
  const expected = (env && typeof env.CLINIC_KEY === 'string') ? env.CLINIC_KEY : '';
  if (!expected.length) return false;   // fail closed: no secret, no access

  const provided = extractBearer(request);
  if (provided == null) return false;

  return constantTimeEqual(provided, expected);
}

function extractBearer(request) {
  const header =
    request.headers.get('Authorization') ||
    request.headers.get('authorization') ||
    '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

// Constant-time string comparison: guard length, then accumulate XOR over the
// char codes so the compare time does not depend on where the first mismatch is.
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aLen = a.length;
  const bLen = b.length;
  // Seed the accumulator with the length difference so unequal lengths never
  // pass, without early-returning (which would leak length via timing).
  let diff = aLen ^ bLen;
  const max = Math.max(aLen, bLen) || 1;
  for (let i = 0; i < max; i++) {
    const ca = i < aLen ? a.charCodeAt(i) : 0;
    const cb = i < bLen ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Validation & helpers
// ---------------------------------------------------------------------------

// A restore is the one legitimate way to bring a deleted record back, and it
// says so on the row rather than relying on being "newer than the deletion".
function isUndelete(row) {
  return row && (row.undelete === true || row.undelete === 1 || row.undelete === 'true');
}

function isValidRow(row) {
  return (
    !!row &&
    typeof row === 'object' &&
    typeof row.uid === 'string' &&
    row.uid.length > 0 &&
    typeof row.entity === 'string' &&
    row.entity.length > 0 &&
    typeof row.updated_at === 'string' &&
    row.updated_at.length > 0 &&
    row.data != null
  );
}

function clampLimit(raw) {
  let limit = parseInt(raw, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  return limit;
}

function parseData(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_e) {
    return value;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function errMessage(err) {
  if (err && err.message) return String(err.message);
  return String(err);
}

function methodNotAllowed() {
  return json({ ok: false, error: 'method not allowed' }, 405);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}
