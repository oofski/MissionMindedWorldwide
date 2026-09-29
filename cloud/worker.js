// Mission Minded Worldwide — Cloud Sync Worker (v1.7.0)
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
const VERSION = '1.7.0';
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
    // For an entity an older build may push without some columns, the stored
    // copy's data comes back in the same read, for keepOmittedKeys below.
    const existing = await env.DB
      .prepare(KEEPS_OMITTED_KEYS.has(row.entity)
        ? 'SELECT updated_at, deleted, entity, data FROM sync_rows WHERE uid = ?'
        : 'SELECT updated_at, deleted FROM sync_rows WHERE uid = ?')
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

    // A row pushed by a laptop on an older build leaves out the columns that
    // build does not know — v0.0.14 has no check-in City list on the event, no
    // x-ray count, Treatment Waiting stamp, glucose or breathing rate on the
    // triage row, and no referral, lock trail or review stamps on the treatment
    // row. Stored whole, that push dropped them from the cloud copy, so a laptop
    // set up fresh or restored from the cloud never received them (and the
    // online form lost the City list). So what the stored live copy has and the
    // incoming row does not carry is kept. An explicit null (an admin clearing
    // the list) still clears it. A deletion is never merged: a tombstone is
    // pushed with empty data precisely so the patient's details leave the
    // server, and a row coming back from deletion has nothing stored to keep.
    const data = existing && !existing.deleted && !row.deleted && KEEPS_OMITTED_KEYS.has(row.entity)
      ? keepOmittedKeys(existing, row.entity, row.data) : row.data;
    const dataStr =
      typeof data === 'string' ? data : JSON.stringify(data);

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

// The entities a newer build has added columns to, so that a push from an
// older one can leave some out: the event (its City list), the triage row and
// the treatment row, all in v0.0.15. Only these pay for reading the stored
// copy back — every other entity's rows (x-ray images and consent signatures
// among them) are stored as sent, as before. When a column is added to another
// entity's SYNC_COLS in the app, that entity joins this list.
const KEEPS_OMITTED_KEYS = new Set(['event', 'triage', 'treatment']);

// The incoming data with every key it omits filled from the stored live copy
// of the same row (as read by the push's own lookup). The app always sends
// every column it knows (a column it has no value for goes as null), so an
// omitted key only ever means "this build does not have that column", never
// "remove it".
function keepOmittedKeys(stored, entity, incoming) {
  const next = parseData(incoming);
  if (!next || typeof next !== 'object' || Array.isArray(next)) return incoming;
  const prev = stored && stored.entity === entity ? parseData(stored.data) : null;
  if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return incoming;
  const missing = Object.keys(prev).filter((k) => !(k in next));
  if (!missing.length) return incoming;
  const merged = { ...next };
  missing.forEach((k) => { merged[k] = prev[k]; });
  return merged;
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

// One town name as every copy stores it: runs of spaces made one, trimmed, at
// most 80 characters. Mirrors cleanCityName in the app's intakeSections.js and
// db.js sanitizeCities; the harness runs all three over the same names.
function cleanCityName(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 80);
}

// The event's check-in City list (events.cities in the app: a JSON array of
// names, travelling in the event row as a JSON string). Cleaned the way the app
// cleans it — trimmed, "Other" dropped (the form adds its own), duplicates
// ignoring case removed, at most 100 names of 80 characters — because this row
// came over the network. Empty means no list: City stays a text box.
function eventCities(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) list = parsed; } catch (_e) { list = raw.split(/\r?\n/); }
  }
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const name = cleanCityName(c);
    const fold = name.toLowerCase();
    if (!name || fold === 'other' || seen.has(fold)) continue;
    seen.add(fold);
    out.push(name);
    if (out.length >= 100) break;
  }
  return out;
}
// The listed spelling of a typed city, ignoring case and spacing, or null —
// "sandy" is Sandy, and storing it as Sandy keeps one town one report bucket.
function matchCity(value, cities) {
  const fold = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!fold) return null;
  return (cities || []).find((c) => c.toLowerCase() === fold) || null;
}

// Look up an event by its sync uid. Returns { name, active, cities } or null.
// Events are stored as ordinary sync rows (entity='event'); the app pushes them
// up on sync.
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
    return { name: typeof data.name === 'string' && data.name ? data.name : 'the clinic', active, cities: eventCities(data.cities) };
  } catch (_e) {
    return null;
  }
}

async function handleCheckinGet(eventUid, env, url) {
  const ev = await getEventRow(env, eventUid);
  if (!ev) return htmlResponse(checkinErrorPage(), 404);
  if (!ev.active) return htmlResponse(checkinClosedPage(ev.name), 410);
  const lang = (url && url.searchParams && url.searchParams.get('lang') === 'es') ? 'es' : 'en';
  return htmlResponse(checkinFormPage(eventUid, ev.name, lang, ev.cities));
}

async function handleCheckinPost(eventUid, request, env) {
  const ev = await getEventRow(env, eventUid);
  if (!ev) return json({ ok: false, error: 'This pre-registration link is not valid.' }, 404);
  if (!ev.active) {
    return json({ ok: false, error: 'This clinic has closed and is no longer taking pre-registrations. / Esta clínica ha cerrado y ya no acepta pre-registros.' }, 410);
  }

  let body;
  try { body = await request.json(); } catch (_e) { return json({ ok: false, error: 'Invalid submission.' }, 400); }
  const esErr = body && body.language === 'es';
  const L = I18N[esErr ? 'es' : 'en'];

  // A page opened before this form changed (v0.0.15) still posts the old
  // history — the checklist, the hospitalization and pregnancy questions, the
  // six old dental questions — and none of the new required answers. Refusing
  // it with "please answer every question" would name questions that page
  // never showed, so it is told plainly to reload instead. (Survey answers such
  // a page posts are simply ignored; the survey is asked at check-out now.)
  //
  // Pages from v0.0.15 on say which form they are (form_version), so the next
  // change to the form can tell them apart by that alone. Older pages never
  // sent one and are recognised by the questions only they posted.
  if (body && typeof body === 'object') {
    const stale = body.form_version != null
      ? Number(body.form_version) !== FORM_VERSION
      : (!body.condition_answers && ('hospitalized' in body || 'pregnancy' in body || 'gum_bleeding' in body));
    if (stale) return json({ ok: false, error: L.errReload }, 400);
  }

  const clean = buildPreregPatient(body, ev.cities);
  if (!clean) return json({ ok: false, error: esErr ? 'Por favor ingrese su nombre y apellido.' : 'Please enter your first and last name.' }, 400);
  // Date of birth, gender, city and state are required (per the clinics'
  // reporting needs — grant-funded clinics report patients' town of origin).
  if (!clean.dob) return json({ ok: false, error: esErr ? 'Por favor ingrese su fecha de nacimiento.' : 'Please enter your date of birth.' }, 400);
  if (!clean.gender) return json({ ok: false, error: esErr ? 'Por favor elija un género.' : 'Please choose a gender.' }, 400);
  if (!clean.demographics.city) return json({ ok: false, error: esErr ? 'Por favor ingrese su ciudad.' : 'Please enter your city.' }, 400);
  if (!clean.demographics.state) return json({ ok: false, error: esErr ? 'Por favor ingrese su estado.' : 'Please enter your state.' }, 400);
  // Required at the kiosk, so required here: the phone number is how the
  // clinic reaches a patient about a result or a follow-up.
  if (!clean.phone) return json({ ok: false, error: L.errPhone }, 400);
  // An emergency contact is who the clinic calls if something goes wrong during
  // a procedure, so it is not optional.
  if (!clean.demographics.emergency_name) return json({ ok: false, error: esErr ? 'Por favor ingrese el nombre de un contacto de emergencia.' : 'Please enter an emergency contact name.' }, 400);
  if (!clean.demographics.emergency_phone) return json({ ok: false, error: esErr ? 'Por favor ingrese el teléfono del contacto de emergencia.' : 'Please enter an emergency contact phone number.' }, 400);
  // At least one service, exactly as the walk-in form requires: it decides which
  // clinics the patient is queued for, so a blank strands them in no queue.
  if (!clean.demographics.services.length) return json({ ok: false, error: esErr ? 'Elija al menos un servicio.' : 'Please choose at least one service.' }, 400);
  // Every medical and dental history question must carry an answer, by the
  // walk-in form's rules exactly — a blank is not "no", and the dentist reads
  // these before deciding whether it is safe to treat. The refusal names the
  // question, as the walk-in form's does.
  {
    const missing = firstMissingHistory(clean.medical_history, clean.dental_history);
    if (missing) {
      return json({ ok: false, error: L.errMedical.replace(/\.$/, '') + ': ' + historyQuestion(missing, L) }, 400);
    }
    // Required at the kiosk, so required here: it decides who the patient sees
    // and whether the oral-surgery consent is needed.
    if (!clean.dental_history.visit_type) return json({ ok: false, error: L.errVisit }, 400);
  }

  const iso = nowIso();
  const lang = clean.language;
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

  // No survey row: registration asks no survey question since v0.0.15. The
  // whole grant survey is asked at check-out, which files the row itself.

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
// Everything is length-capped; unknown fields are ignored and every list is
// filtered to the keys the form offers. Returns null if the name is missing.
//
// The medical history is built in the shape the walk-in form stores
// (history_version 2 — src/renderer/js/medicalHistory.js normalizeMedical),
// derived fields included: `conditions` (the Yes answers, or ['none'] when
// every one was No), `allergies` (['none'] for NKDA), the *_none flags. Those
// derived fields are what the blood-thinner rules, the report counts and a
// station still on an older build read. Checklist medications are stored by
// key with their canonical name ("Warfarin (Coumadin)"), which is the name the
// blood-thinner rules recognise.
function buildPreregPatient(b, cities) {
  b = b || {};
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 120);
  const yn = (v) => (v === 'yes' ? 'yes' : v === 'no' ? 'no' : '');
  const first = s(b.first_name, 60);
  const last = s(b.last_name, 60);
  if (!first || !last) return null;
  const strs = (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n || 60) : []);
  const uniq = (a) => Array.from(new Set(a));

  const ALLERGY_KEYS = FORM_ALLERGIES.map(([k]) => k);
  const COND_KEYS = FORM_CONDITIONS.map(([k]) => k);
  const MED_NAME = Object.fromEntries(FORM_MED_CHECKLIST);
  const SITE_KEYS = FORM_SURGERY_SITES.map(([k]) => k);

  const answersIn = b.condition_answers && typeof b.condition_answers === 'object' && !Array.isArray(b.condition_answers) ? b.condition_answers : {};
  const condition_answers = {};
  COND_KEYS.forEach((k) => { if (conditionAnswerOk(k, answersIn[k])) condition_answers[k] = answersIn[k]; });
  const conditionsOther = s(b.conditions_other, 200);
  const yesKeys = COND_KEYS.filter((k) => condition_answers[k] === 'yes');
  const allNo = COND_KEYS.every((k) => condition_answers[k] === 'no' || condition_answers[k] === 'na');
  const conditions = yesKeys.length || conditionsOther ? [...yesKeys, ...(conditionsOther ? ['other'] : [])] : (allNo ? ['none'] : []);

  const allergyStatus = ALLERGY_STATUSES.includes(b.allergy_status) ? b.allergy_status : '';
  const allergies = allergyStatus === 'yes' ? uniq(strs(b.allergies).filter((k) => k === 'other' || ALLERGY_KEYS.includes(k)))
    : allergyStatus === 'nkda' ? ['none'] : [];

  const medsNone = b.medications_none === true || b.medications_none === 'on' || b.medications_none === 'true';
  const medications = medsNone ? [] : [
    ...uniq(strs(b.med_keys)).filter((k) => MED_NAME[k]).map((k) => ({ key: k, name: MED_NAME[k], dose: '', reason: '' })),
    ...strs(b.medications_other, 30).map((m) => s(m, 80)).filter(Boolean).map((name) => ({ key: 'other', name, dose: '', reason: '' })),
  ];
  const major = yn(b.major_surgery);

  const medical_history = {
    under_treatment: yn(b.under_treatment),
    condition_answers,
    conditions,
    conditions_other: conditionsOther,
    medications,
    major_surgery: major,
    surgery_sites: major === 'yes' ? uniq(strs(b.surgery_sites).filter((k) => SITE_KEYS.includes(k))) : [],
    tobacco: yn(b.tobacco),
    allergy_status: allergyStatus,
    allergies,
    allergies_other: allergies.includes('other') ? s(b.allergies_other, 200) : '',
  };
  if (conditions.length === 1 && conditions[0] === 'none') medical_history.conditions_none = true;
  if (allergyStatus === 'nkda') medical_history.allergies_none = true;
  if (medsNone) medical_history.medications_none = true;
  if (Object.keys(condition_answers).length && allergyStatus) medical_history.history_version = 2;

  // Mirrors PRIOR_DENTIST in src/renderer/i18n/strings.js. Validated here, not
  // just presented as a dropdown in the page: this endpoint is reachable
  // directly, and a free-text value arriving from it would land in the report as
  // a bucket of one that no funder figure can use.
  //
  // 'reason' is deliberately NOT read any more. The walk-in form dropped it, and
  // if this form kept posting prose the online sign-ups would be the only
  // records carrying it — a split the Reports tab cannot show. Nor are the six
  // Step 3 questions v0.0.15 replaced: only the eight it asks are stored.
  const PRIOR_DENTIST = ['within_6_months', 'about_1_year', 'about_2_years', 'over_3_years', 'never'];
  const dental_history = {
    prior_dentist: PRIOR_DENTIST.includes(b.prior_dentist) ? b.prior_dentist : '',
  };
  FORM_DENTAL_YESNO.forEach(([k]) => { dental_history[k] = yn(b[k]); });
  const VISITS = ['extraction_pain', 'extraction_no_pain', 'filling', 'cleaning'];
  if (VISITS.includes(b.visit_type)) {
    dental_history.visit_type = b.visit_type;
    if (b.visit_type === 'extraction_pain' || b.visit_type === 'extraction_no_pain') dental_history.may_need_extraction = 'yes';
  }

  // The city, resolved exactly as the walk-in form resolves it: a listed town
  // in its listed spelling, "Other" as the typed name (canonicalised if it is
  // really a listed town), or — with no list — whatever was typed.
  const cityList = Array.isArray(cities) ? cities : [];
  // "other" is the dropdown's Other when the event has a list, or when a name
  // was typed beside it (the admin may have cleared the list while the page
  // was open) — then the typed name is the town, never the word "other". In a
  // plain text box it is simply what the patient typed, as at the kiosk.
  const otherPicked = b.city === 'other' && (cityList.length > 0 || !!cleanCityName(b.city_other));
  const cityTyped = cleanCityName(otherPicked ? b.city_other : b.city);
  const city = matchCity(cityTyped, cityList) || cityTyped;

  return {
    first_name: first,
    last_name: last,
    dob: s(b.dob, 20),
    gender: s(b.gender, 20),
    phone: s(b.phone, 20).replace(/\D/g, '').slice(0, 10),
    email: s(b.email, 120),
    language: b.language === 'es' ? 'es' : 'en',
    demographics: {
      address: s(b.address, 200), city,
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
        const uniqRace = Array.from(new Set(picked));
        return uniqRace.includes('prefer_not') ? ['prefer_not'] : uniqRace;
      })(),
    },
    medical_history,
    dental_history,
  };
}

// The pregnancy row alone also accepts Not applicable ("when applicable" on
// Dr. Trinh's form) — a man or a child has to be able to answer it truthfully.
const ALLERGY_STATUSES = ['nkda', 'yes', 'unsure'];
function conditionAnswerOk(k, v) {
  return v === 'yes' || v === 'no' || v === 'unsure' || (k === 'pregnant' && v === 'na');
}

// The first required answer a history is missing, in the order the form asks
// them, or null. Mirrors firstMissingMedical in src/renderer/js/medicalHistory.js
// (ids included), then Step 3: 'prior_dentist' and 'dental:<key>'.
function firstMissingHistory(mh, dh) {
  const m = mh || {};
  const yesNo = (v) => v === 'yes' || v === 'no';
  if (!yesNo(m.under_treatment)) return 'under_treatment';
  const answers = m.condition_answers || {};
  for (const [k] of FORM_CONDITIONS) if (!conditionAnswerOk(k, answers[k])) return 'condition:' + k;
  if (m.medications_none !== true && !(m.medications || []).length) return 'medications';
  if (!yesNo(m.major_surgery)) return 'major_surgery';
  if (m.major_surgery === 'yes' && !(m.surgery_sites || []).length) return 'surgery_sites';
  if (!yesNo(m.tobacco)) return 'tobacco';
  if (!ALLERGY_STATUSES.includes(m.allergy_status)) return 'allergy_status';
  if (m.allergy_status === 'yes') {
    const picked = (m.allergies || []).filter((k) => k !== 'none');
    if (!picked.length) return 'allergies';
    if (picked.includes('other') && !m.allergies_other) return 'allergies_other';
  }
  // Then Step 3 in its order: when they last saw a dentist (a blank, or a
  // free-text value posted straight to the endpoint, stores as '' and would be
  // a report row nothing can count), then the eight questions.
  const d = dh || {};
  if (!d.prior_dentist) return 'prior_dentist';
  for (const [k] of FORM_DENTAL_YESNO) if (!yesNo(d[k])) return 'dental:' + k;
  return null;
}
// That question's own wording, in the patient's language.
function historyQuestion(id, L) {
  const find = (list, key) => ((list.find(([k]) => k === key) || [])[1] || key);
  if (id.startsWith('condition:')) return find(L.conditionList, id.slice(10));
  if (id.startsWith('dental:')) return find(L.dentalYesNo, id.slice(7));
  const plain = { medications: L.meds, surgery_sites: L.surgerySites, allergy_status: L.allergyQ, allergies: L.allergies, allergies_other: L.allergyOther, prior_dentist: L.priorDentist };
  return plain[id] || find(L.medYesNo, id);
}

// The check-in questions offered on the public form — the SAME options a patient
// gets in person. Keys MUST match the app's i18n keys (renderer/i18n/strings.js)
// so selections render natively in the clinic app.
// Mirrors MEDICATIONS in src/renderer/i18n/strings.js, in the same order (most
// commonly prescribed first). A datalist, not a select: it behaves as a picker
// but still accepts anything typed, because a patient on a drug outside this
// hundred must still be recordable.
const MED_OPTIONS = '<option value="Atorvastatin"></option><option value="Levothyroxine"></option><option value="Metformin"></option><option value="Amlodipine"></option><option value="Lisinopril"></option><option value="Albuterol"></option><option value="Losartan"></option><option value="Metoprolol"></option><option value="Rosuvastatin"></option><option value="Omeprazole"></option><option value="Gabapentin"></option><option value="Sertraline"></option><option value="Escitalopram"></option><option value="Semaglutide"></option><option value="Amphetamine/dextroamphetamine"></option><option value="Pantoprazole"></option><option value="Bupropion"></option><option value="Hydrochlorothiazide"></option><option value="Fluoxetine"></option><option value="Trazodone"></option><option value="Montelukast"></option><option value="Amoxicillin"></option><option value="Fluticasone"></option><option value="Tamsulosin"></option><option value="Apixaban"></option><option value="Simvastatin"></option><option value="Insulin glargine"></option><option value="Empagliflozin"></option><option value="Furosemide"></option><option value="Meloxicam"></option><option value="Hydrocodone/acetaminophen"></option><option value="Tirzepatide"></option><option value="Methylphenidate"></option><option value="Duloxetine"></option><option value="Prednisone"></option><option value="Carvedilol"></option><option value="Famotidine"></option><option value="Ibuprofen"></option><option value="Buspirone"></option><option value="Venlafaxine"></option><option value="Tramadol"></option><option value="Potassium chloride"></option><option value="Hydroxyzine"></option><option value="Allopurinol"></option><option value="Clopidogrel"></option><option value="Ergocalciferol (Vitamin D2)"></option><option value="Cetirizine"></option><option value="Ondansetron"></option><option value="Cyclobenzaprine"></option><option value="Spironolactone"></option><option value="Oxycodone"></option><option value="Estradiol"></option><option value="Aspirin"></option><option value="Glipizide"></option><option value="Zolpidem"></option><option value="Lamotrigine"></option><option value="Alprazolam"></option><option value="Citalopram"></option><option value="Pregabalin"></option><option value="Cholecalciferol (Vitamin D3)"></option><option value="Clonazepam"></option><option value="Azithromycin"></option><option value="Pravastatin"></option><option value="Valsartan"></option><option value="Ezetimibe"></option><option value="Diclofenac"></option><option value="Insulin lispro"></option><option value="Ethinyl estradiol/norethindrone"></option><option value="Propranolol"></option><option value="Latanoprost"></option><option value="Atenolol"></option><option value="Lisdexamfetamine"></option><option value="Doxycycline"></option><option value="Amoxicillin/clavulanate"></option><option value="Dulaglutide"></option><option value="Hydrochlorothiazide/lisinopril"></option><option value="Lorazepam"></option><option value="Fluticasone/salmeterol"></option><option value="Insulin aspart"></option><option value="Celecoxib"></option><option value="Finasteride"></option><option value="Quetiapine"></option><option value="Clonidine"></option><option value="Aripiprazole"></option><option value="Cephalexin"></option><option value="Alendronate"></option><option value="Topiramate"></option><option value="Tizanidine"></option><option value="Dapagliflozin"></option><option value="Oxycodone/acetaminophen"></option><option value="Hydrochlorothiazide/losartan"></option><option value="Olmesartan"></option><option value="Testosterone"></option><option value="Amitriptyline"></option><option value="Folic acid"></option><option value="Rivaroxaban"></option><option value="Fenofibrate"></option><option value="Triamcinolone"></option><option value="Paroxetine"></option><option value="Ferrous sulfate"></option>';

// Which form the page is (posted as form_version). v0.0.15 is 2: Dr. Trinh's
// medical history and Step 3. Change it whenever the questions change shape, so
// a page opened before the change is told to reload rather than refused for
// answers it never asked.
const FORM_VERSION = 2;

// Mirrors US_STATES in src/renderer/i18n/strings.js. A dropdown here as well as
// on the walk-in form, and validated server-side: this endpoint is reachable
// directly, and free text was putting "OR", "Oregon" and "ore" into the
// city/state report as three different places.
const US_STATE_CODES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR', 'VI', 'GU', 'AS', 'MP'];
const US_STATE_OPTIONS = '<option value="AL">Alabama (AL)</option><option value="AK">Alaska (AK)</option><option value="AZ">Arizona (AZ)</option><option value="AR">Arkansas (AR)</option><option value="CA">California (CA)</option><option value="CO">Colorado (CO)</option><option value="CT">Connecticut (CT)</option><option value="DE">Delaware (DE)</option><option value="DC">District of Columbia (DC)</option><option value="FL">Florida (FL)</option><option value="GA">Georgia (GA)</option><option value="HI">Hawaii (HI)</option><option value="ID">Idaho (ID)</option><option value="IL">Illinois (IL)</option><option value="IN">Indiana (IN)</option><option value="IA">Iowa (IA)</option><option value="KS">Kansas (KS)</option><option value="KY">Kentucky (KY)</option><option value="LA">Louisiana (LA)</option><option value="ME">Maine (ME)</option><option value="MD">Maryland (MD)</option><option value="MA">Massachusetts (MA)</option><option value="MI">Michigan (MI)</option><option value="MN">Minnesota (MN)</option><option value="MS">Mississippi (MS)</option><option value="MO">Missouri (MO)</option><option value="MT">Montana (MT)</option><option value="NE">Nebraska (NE)</option><option value="NV">Nevada (NV)</option><option value="NH">New Hampshire (NH)</option><option value="NJ">New Jersey (NJ)</option><option value="NM">New Mexico (NM)</option><option value="NY">New York (NY)</option><option value="NC">North Carolina (NC)</option><option value="ND">North Dakota (ND)</option><option value="OH">Ohio (OH)</option><option value="OK">Oklahoma (OK)</option><option value="OR">Oregon (OR)</option><option value="PA">Pennsylvania (PA)</option><option value="RI">Rhode Island (RI)</option><option value="SC">South Carolina (SC)</option><option value="SD">South Dakota (SD)</option><option value="TN">Tennessee (TN)</option><option value="TX">Texas (TX)</option><option value="UT">Utah (UT)</option><option value="VT">Vermont (VT)</option><option value="VA">Virginia (VA)</option><option value="WA">Washington (WA)</option><option value="WV">West Virginia (WV)</option><option value="WI">Wisconsin (WI)</option><option value="WY">Wyoming (WY)</option><option value="PR">Puerto Rico (PR)</option><option value="VI">U.S. Virgin Islands (VI)</option><option value="GU">Guam (GU)</option><option value="AS">American Samoa (AS)</option><option value="MP">Northern Mariana Islands (MP)</option>';

// Dr. Trinh's medication-allergy list (v0.0.15), asked only when the answer to
// "Do you have an allergy or serious reaction to any medication?" is Yes.
// Mirrors the intake ALLERGIES in src/renderer/i18n/strings.js — same keys,
// same order, same words (the harness pins them).
const FORM_ALLERGIES = [
  ['penicillin', 'Penicillin'], ['amoxicillin', 'Amoxicillin'], ['ampicillin', 'Ampicillin'],
  ['cephalosporins', 'Cephalosporins'], ['sulfa', 'Sulfa antibiotics'], ['azithromycin', 'Azithromycin / Erythromycin / Clarithromycin'],
  ['clindamycin', 'Clindamycin'], ['metronidazole', 'Metronidazole'], ['doxycycline', 'Doxycycline / tetracyclines'],
  ['fluoroquinolones', 'Ciprofloxacin / Levofloxacin'], ['aspirin', 'Aspirin'], ['ibuprofen_nsaids', 'Ibuprofen / Naproxen / NSAIDs'],
  ['tylenol', 'Acetaminophen / Tylenol'], ['codeine', 'Codeine'], ['hydrocodone', 'Hydrocodone'],
  ['oxycodone', 'Oxycodone'], ['morphine', 'Morphine'], ['lidocaine', 'Lidocaine / local anesthetic'],
  ['general_anesthetic', 'General anesthetic'], ['anticonvulsant', 'Anticonvulsant'], ['bp_medication', 'Blood pressure medication'],
  ['diuretic', 'Diuretic'], ['diabetes_medication', 'Insulin / diabetes medication'], ['steroid', 'Steroid / corticosteroid'],
];
// Dr. Trinh's 25 conditions, each answered Yes / No / Unsure (pregnancy also Not
// applicable). Mirrors the intake CONDITIONS in strings.js (pinned).
const FORM_CONDITIONS = [
  ['high_bp', 'High Blood Pressure (Hypertension)'], ['diabetes', 'Diabetes – Type 1 or Type 2'],
  ['heart_disease', 'Heart Disease / Coronary Artery Disease'], ['heart_attack', 'Heart Attack / Myocardial Infarction'],
  ['stroke', 'Stroke / TIA'], ['high_cholesterol', 'High Cholesterol'],
  ['asthma', 'Asthma'], ['copd', 'COPD / Emphysema / Chronic Lung Disease'],
  ['kidney', 'Kidney Disease / Kidney Failure'], ['liver', 'Liver Disease / Hepatitis'],
  ['thyroid', 'Thyroid Disease'], ['cancer', 'Cancer / History of Cancer'],
  ['epilepsy', 'Seizures / Epilepsy'], ['bleeding', 'Bleeding Disorder / Excessive Bleeding'],
  ['blood_clot', 'Blood Clot / DVT / Pulmonary Embolism'], ['anemia', 'Anemia / Blood Disorder'],
  ['arthritis', 'Arthritis / Rheumatoid Arthritis'], ['osteoporosis', 'Osteoporosis / Bone Disease'],
  ['ulcers', 'GERD / Acid Reflux / Stomach Ulcers'], ['mental_health', 'Depression / Anxiety / Other Mental Health Condition'],
  ['sleep_apnea', 'Sleep Apnea'], ['tuberculosis', 'Tuberculosis (TB) / History of TB'],
  ['hiv', 'HIV/AIDS'], ['autoimmune', 'Autoimmune / Immune System Disorder'],
  ['pregnant', 'Pregnancy / Possible Pregnancy (when applicable)'],
];
// His medication checklist. The label IS the stored name — canonical English
// whatever the page language — because the blood-thinner rules match on it.
// Mirrors MED_CHECKLIST in strings.js (pinned).
const FORM_MED_CHECKLIST = [
  ['atorvastatin', 'Atorvastatin (Lipitor)'], ['amlodipine', 'Amlodipine (Norvasc)'], ['lisinopril', 'Lisinopril (Zestril/Prinivil)'],
  ['losartan', 'Losartan (Cozaar)'], ['metformin', 'Metformin (Glucophage)'], ['levothyroxine', 'Levothyroxine (Synthroid)'],
  ['omeprazole', 'Omeprazole (Prilosec)'], ['gabapentin', 'Gabapentin (Neurontin)'], ['hydrochlorothiazide', 'Hydrochlorothiazide (HCTZ)'],
  ['metoprolol', 'Metoprolol'], ['rosuvastatin', 'Rosuvastatin (Crestor)'], ['aspirin', 'Aspirin'],
  ['ibuprofen', 'Ibuprofen (Advil/Motrin)'], ['acetaminophen', 'Acetaminophen (Tylenol)'], ['albuterol', 'Albuterol (Ventolin/ProAir)'],
  ['insulin', 'Insulin'], ['glipizide', 'Glipizide'], ['furosemide', 'Furosemide (Lasix)'],
  ['pantoprazole', 'Pantoprazole (Protonix)'], ['sertraline', 'Sertraline (Zoloft)'], ['escitalopram', 'Escitalopram (Lexapro)'],
  ['prednisone', 'Prednisone'], ['warfarin', 'Warfarin (Coumadin)'], ['apixaban', 'Apixaban (Eliquis)'],
  ['clopidogrel', 'Clopidogrel (Plavix)'],
];
// "Major surgery in the past 6 months? If so, where". Mirrors SURGERY_SITES.
const FORM_SURGERY_SITES = [
  ['knee', 'Knee'], ['elbow', 'Elbow'], ['hip', 'Hip'], ['neck', 'Neck'], ['heart', 'Heart'],
  ['leg', 'Leg'], ['arm', 'Arm'], ['lung', 'Lung'], ['kidney', 'Kidney'], ['liver', 'Liver'],
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
// The yes/no medical questions — verbatim from the app's check-in. "Do you
// smoke?" is stored under the old `tobacco` key; "major surgery" replaces the
// retired hospitalization question.
const FORM_MED_YESNO = [
  ['under_treatment', 'Are you currently under a doctor’s care?'], ['major_surgery', 'Major surgery within the past 6 months?'],
  ['tobacco', 'Do you smoke?'],
];
// Step 3: Dr. Trinh's eight questions. Mirrors DENTAL_QUESTIONS in strings.js
// (pinned); the stored keys are these and only these.
const FORM_DENTAL_YESNO = [
  ['pain_cold', 'Any pain when drinking cold water?'], ['pain_hot', 'Any pain when drinking hot water?'],
  ['pain_eating', 'Any pain when eating?'], ['toothache_night', 'Does the toothache wake you up at night?'],
  ['pain_touch', 'Any pain upon touching?'], ['grinding_night', 'Do you clench or grind your teeth at night?'],
  ['jaw_pain_waking', 'Do you wake up with jaw pain?'], ['sores', 'Do you notice any lump or sores in your mouth?'],
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
  ['penicillin', 'Penicilina'], ['amoxicillin', 'Amoxicilina'], ['ampicillin', 'Ampicilina'],
  ['cephalosporins', 'Cefalosporinas'], ['sulfa', 'Antibióticos de sulfa'], ['azithromycin', 'Azitromicina / eritromicina / claritromicina'],
  ['clindamycin', 'Clindamicina'], ['metronidazole', 'Metronidazol'], ['doxycycline', 'Doxiciclina / tetraciclinas'],
  ['fluoroquinolones', 'Ciprofloxacino / levofloxacino'], ['aspirin', 'Aspirina'], ['ibuprofen_nsaids', 'Ibuprofeno / naproxeno / AINEs'],
  ['tylenol', 'Acetaminofén / Tylenol'], ['codeine', 'Codeína'], ['hydrocodone', 'Hidrocodona'],
  ['oxycodone', 'Oxicodona'], ['morphine', 'Morfina'], ['lidocaine', 'Lidocaína / anestésico local'],
  ['general_anesthetic', 'Anestesia general'], ['anticonvulsant', 'Anticonvulsivo'], ['bp_medication', 'Medicamento para la presión arterial'],
  ['diuretic', 'Diurético'], ['diabetes_medication', 'Insulina / medicamento para la diabetes'], ['steroid', 'Esteroide / corticosteroide'],
];
const FORM_CONDITIONS_ES = [
  ['high_bp', 'Presión arterial alta (hipertensión)'], ['diabetes', 'Diabetes – tipo 1 o tipo 2'],
  ['heart_disease', 'Enfermedad del corazón / enfermedad de las arterias coronarias'], ['heart_attack', 'Ataque al corazón / infarto de miocardio'],
  ['stroke', 'Derrame cerebral / accidente isquémico transitorio (AIT)'], ['high_cholesterol', 'Colesterol alto'],
  ['asthma', 'Asma'], ['copd', 'EPOC / enfisema / enfermedad pulmonar crónica'],
  ['kidney', 'Enfermedad renal / insuficiencia renal'], ['liver', 'Enfermedad del hígado / hepatitis'],
  ['thyroid', 'Enfermedad de la tiroides'], ['cancer', 'Cáncer / antecedentes de cáncer'],
  ['epilepsy', 'Convulsiones / epilepsia'], ['bleeding', 'Trastorno de sangrado / sangrado excesivo'],
  ['blood_clot', 'Coágulo de sangre / TVP / embolia pulmonar'], ['anemia', 'Anemia / trastorno de la sangre'],
  ['arthritis', 'Artritis / artritis reumatoide'], ['osteoporosis', 'Osteoporosis / enfermedad de los huesos'],
  ['ulcers', 'ERGE / reflujo ácido / úlceras estomacales'], ['mental_health', 'Depresión / ansiedad / otra condición de salud mental'],
  ['sleep_apnea', 'Apnea del sueño'], ['tuberculosis', 'Tuberculosis (TB) / antecedentes de TB'],
  ['hiv', 'VIH/SIDA'], ['autoimmune', 'Enfermedad autoinmune / trastorno del sistema inmunitario'],
  ['pregnant', 'Embarazo / posible embarazo (cuando aplique)'],
];
// What a Spanish-speaking patient reads while ticking; the STORED name is still
// the canonical English one from FORM_MED_CHECKLIST.
const FORM_MED_CHECKLIST_ES = [
  ['atorvastatin', 'Atorvastatina (Lipitor)'], ['amlodipine', 'Amlodipino (Norvasc)'], ['lisinopril', 'Lisinopril (Zestril/Prinivil)'],
  ['losartan', 'Losartán (Cozaar)'], ['metformin', 'Metformina (Glucophage)'], ['levothyroxine', 'Levotiroxina (Synthroid)'],
  ['omeprazole', 'Omeprazol (Prilosec)'], ['gabapentin', 'Gabapentina (Neurontin)'], ['hydrochlorothiazide', 'Hidroclorotiazida (HCTZ)'],
  ['metoprolol', 'Metoprolol'], ['rosuvastatin', 'Rosuvastatina (Crestor)'], ['aspirin', 'Aspirina'],
  ['ibuprofen', 'Ibuprofeno (Advil/Motrin)'], ['acetaminophen', 'Acetaminofén (Tylenol)'], ['albuterol', 'Albuterol / salbutamol (Ventolin/ProAir)'],
  ['insulin', 'Insulina'], ['glipizide', 'Glipizida'], ['furosemide', 'Furosemida (Lasix)'],
  ['pantoprazole', 'Pantoprazol (Protonix)'], ['sertraline', 'Sertralina (Zoloft)'], ['escitalopram', 'Escitalopram (Lexapro)'],
  ['prednisone', 'Prednisona'], ['warfarin', 'Warfarina (Coumadin)'], ['apixaban', 'Apixabán (Eliquis)'],
  ['clopidogrel', 'Clopidogrel (Plavix)'],
];
const FORM_SURGERY_SITES_ES = [
  ['knee', 'Rodilla'], ['elbow', 'Codo'], ['hip', 'Cadera'], ['neck', 'Cuello'], ['heart', 'Corazón'],
  ['leg', 'Pierna'], ['arm', 'Brazo'], ['lung', 'Pulmón'], ['kidney', 'Riñón'], ['liver', 'Hígado'],
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
  ['under_treatment', '¿Está bajo el cuidado de un médico actualmente?'], ['major_surgery', '¿Cirugía mayor en los últimos 6 meses?'],
  ['tobacco', '¿Fuma?'],
];
const FORM_DENTAL_YESNO_ES = [
  ['pain_cold', '¿Siente dolor al tomar agua fría?'], ['pain_hot', '¿Siente dolor al tomar agua caliente?'],
  ['pain_eating', '¿Siente dolor al comer?'], ['toothache_night', '¿El dolor de muelas lo despierta por la noche?'],
  ['pain_touch', '¿Siente dolor al tocar la zona?'], ['grinding_night', '¿Aprieta o rechina los dientes por la noche?'],
  ['jaw_pain_waking', '¿Se despierta con dolor de mandíbula?'], ['sores', '¿Nota algún bulto o llaga en la boca?'],
];
const GENERAL_CONSENT_ES = ['Certifico que he leído este Consentimiento, o que me ha sido leído, y que entiendo lo anterior. Se me ha explicado la naturaleza y el propósito de tales operación(es), procedimiento(s), tratamiento(s) y/o servicios y las razones por las que se consideran necesarios o aconsejables. Por la presente eximo de responsabilidad a Mission Minded Worldwide, al Dentista Asociado y/o a dichos asistentes por la atención dental gratuita brindada. Los servicios se prestan sin compensación y la responsabilidad del proveedor es limitada y el proveedor no puede ser considerado responsable por ninguna lesión, muerte u otra pérdida que surja de la prestación de estos servicios, a menos que la lesión, muerte u otra pérdida resulte de negligencia grave. También soy consciente del riesgo de exposición al COVID durante un procedimiento dental y consiento participar en esta clínica bajo mi propio riesgo. (La versión en inglés es la versión legal autoritativa.)'];
const ORAL_SURGERY_ES = [
  'Este consentimiento adicional es necesario porque hoy podría realizarse una extracción.',
  'Consiento la extracción de uno o más dientes y el uso de anestesia local.',
  'Entiendo que las complicaciones pueden incluir dolor, hinchazón, moretones, infección, alvéolo seco, sangrado, apertura limitada de la mandíbula, lesión a dientes u obturaciones cercanas, y entumecimiento del labio, lengua o mentón que suele ser temporal pero rara vez puede ser permanente.',
  'Entiendo que un diente o la punta de la raíz puede romperse durante la extracción y que un pequeño fragmento puede quedar si extraerlo causara mayor daño.',
  'He informado al equipo de todos los medicamentos y condiciones de salud que puedan afectar la cirugía o la recuperación.',
];

// Bilingual dictionary — keys stay identical (they map to the app's data); only
// the DISPLAY text differs. Spanish uses the app's own translations verbatim.
const I18N = {
  en: {
    switchLabel: 'Español', switchLang: 'es',
    heroSub: 'Fill this out ahead of time and sign your consent to save time at the clinic. Your answers go straight to the front desk.',
    about: 'About You', first: 'First name', last: 'Last name', dob: 'Date of birth', gender: 'Gender',
    gOpt: [['', '—'], ['male', 'Male'], ['female', 'Female'], ['other', 'Other']],
    phone: 'Phone number', email: 'Email', address: 'Home address', city: 'City', state: 'State',
    cityOther: 'Please type your city', otherCity: 'Other',
    emName: 'Emergency contact name', emPhone: 'Emergency contact phone',
    need: 'What do you need today?',
    services: 'Services needed today', servicesList: FORM_SERVICES, serviceHint: 'Choose every clinic you need to be seen at.',
    referral: 'How did you hear about us?', referralOther: 'Please specify', referralList: FORM_REFERRALS,
    raceTitle: 'Race and ethnicity', raceHint: 'Optional. Choose any that apply — used only for reporting how the clinic served the community.',
    raceList: [['american_indian_alaska_native', 'American Indian or Alaska Native'], ['asian', 'Asian'], ['black_african_american', 'Black or African American'], ['hispanic_latino', 'Hispanic or Latino'], ['middle_eastern_north_african', 'Middle Eastern or North African'], ['native_hawaiian_pacific_islander', 'Native Hawaiian or Pacific Islander'], ['white', 'White'], ['prefer_not', 'Prefer not to answer']],
    allergies: 'Medication allergies', allergiesHint: 'Check all that apply', allergyOther: 'Other allergy (specify)',
    allergyQ: 'Do you have an allergy or serious reaction to any medication?', nkda: 'No known drug allergies (NKDA)',
    conditions: 'Do you have any of these conditions?', condHint: 'Answer Yes, No or Unsure for each', conditionOther: 'Other condition (optional)', otherOpt: 'Other',
    meds: 'Current medications', medsHint: 'Check every medication you take', medOther: 'Other medication (type the name)', addMed: '+ Add medication', noMeds: 'No medications', medNamePh: 'Medication',
    surgerySites: 'If so, where?',
    medHist: 'Medical History', dentHist: 'Dental History', priorDentist: 'When did you last see a dentist?', yes: 'Yes', no: 'No', unsure: 'Unsure', notApplicable: 'Not applicable', dash: '—',
    priorDentistOpts: [['within_6_months', 'Within the past 6 months'], ['about_1_year', 'About 1 year ago'], ['about_2_years', 'About 2 years ago'], ['over_3_years', '3 or more years ago'], ['never', 'Never']],
    consent: 'Consent', signName: 'Your name (for the signature)', relationship: 'Relationship (if for a minor)', relPh: 'Self / Parent / Guardian',
    agree: CONSENT_AGREE_TEXT, sigOpt: 'Signature', sigHint: 'Sign with your finger or a stylus.', clear: 'Clear',
    surgery: 'Surgery Consent', surgeryIntro: 'Because an extraction may be done, please also read and sign this.', teeth: 'Tooth number(s), if known',
    submit: 'Submit pre-registration', submitting: 'Submitting…', footer: 'Mission Minded Worldwide — free dental care. Your information is shared only with the clinic team.',
    thankYou: 'Thank you, ', done: 'Your pre-registration and consent are complete. Please bring a photo ID — the front desk already has your information.',
    errName: 'Please enter your first and last name.', errDob: 'Please enter your date of birth.', errGender: 'Please choose a gender.',
    errCity: 'Please enter your city.', errState: 'Please enter your state.', errPhone: 'Please enter a phone number.',
    errEmName: 'Please enter an emergency contact name.', errEmPhone: 'Please enter an emergency contact phone number.',
    errServices: 'Please choose at least one service.',
    errMedical: 'Please answer every medical and dental history question.',
    errVisit: 'Please choose what you need today.',
    errReload: 'This form was updated after you opened it. Please reload the page and fill it in again.',
    errConsent: 'Please read and agree to the consent to finish.', errSurgery: 'An extraction was selected — please read and agree to the Oral Surgery consent too.',
    errSign: 'Please sign the consent to finish.', errSignSurgery: 'Please sign the Oral Surgery consent.', errSigner: 'Please type your name for the signature.',
    netErr: 'Network error. Please try again.', genErr: 'Something went wrong. Please try again.',
    visits: FORM_VISITS, allergyList: FORM_ALLERGIES, conditionList: FORM_CONDITIONS, medYesNo: FORM_MED_YESNO, dentalYesNo: FORM_DENTAL_YESNO,
    medChecklist: FORM_MED_CHECKLIST, surgerySiteList: FORM_SURGERY_SITES,
    generalTitle: GENERAL_CONSENT_TITLE, generalMode: 'ol', general: GENERAL_CONSENT, surgeryTitle: ORAL_SURGERY_TITLE, surgeryText: ORAL_SURGERY_CONSENT,
  },
  es: {
    switchLabel: 'English', switchLang: 'en',
    heroSub: 'Complete esto con anticipación y firme su consentimiento para ahorrar tiempo en la clínica. Sus respuestas van directamente a la recepción.',
    about: 'Sobre usted', first: 'Nombre', last: 'Apellido', dob: 'Fecha de nacimiento', gender: 'Género',
    gOpt: [['', '—'], ['male', 'Masculino'], ['female', 'Femenino'], ['other', 'Otro']],
    phone: 'Teléfono', email: 'Correo electrónico', address: 'Dirección', city: 'Ciudad', state: 'Estado',
    cityOther: 'Escriba su ciudad', otherCity: 'Otra',
    emName: 'Nombre de contacto de emergencia', emPhone: 'Teléfono de contacto de emergencia',
    need: '¿Qué necesita hoy?',
    services: 'Servicios que necesita hoy', servicesList: FORM_SERVICES_ES, serviceHint: 'Elija todas las clínicas donde necesita ser atendido.',
    referral: '¿Cómo se enteró de nosotros?', referralOther: 'Por favor especifique', referralList: FORM_REFERRALS_ES,
    raceTitle: 'Raza y origen étnico', raceHint: 'Opcional. Elija todas las que correspondan — solo se usa para informar cómo la clínica sirvió a la comunidad.',
    raceList: [['american_indian_alaska_native', 'Indígena de América o nativo de Alaska'], ['asian', 'Asiático'], ['black_african_american', 'Negro o afroamericano'], ['hispanic_latino', 'Hispano o latino'], ['middle_eastern_north_african', 'De Medio Oriente o del norte de África'], ['native_hawaiian_pacific_islander', 'Nativo de Hawái o de las islas del Pacífico'], ['white', 'Blanco'], ['prefer_not', 'Prefiero no responder']],
    allergies: 'Alergias a medicamentos', allergiesHint: 'Marque todas las que apliquen', allergyOther: 'Otra alergia (especifique)',
    allergyQ: '¿Tiene alergia o una reacción grave a algún medicamento?', nkda: 'Sin alergias conocidas a medicamentos (NKDA)',
    conditions: '¿Tiene alguna de estas condiciones?', condHint: 'Responda Sí, No o No estoy seguro/a para cada una', conditionOther: 'Otra condición (opcional)', otherOpt: 'Otro',
    meds: 'Medicamentos actuales', medsHint: 'Marque todos los medicamentos que toma', medOther: 'Otro medicamento (escriba el nombre)', addMed: '+ Agregar medicamento', noMeds: 'Sin medicamentos', medNamePh: 'Medicamento',
    surgerySites: 'Si es así, ¿dónde?',
    medHist: 'Historial médico', dentHist: 'Historial dental', priorDentist: '¿Cuándo visitó al dentista por última vez?', yes: 'Sí', no: 'No', unsure: 'No estoy seguro/a', notApplicable: 'No aplica', dash: '—',
    priorDentistOpts: [['within_6_months', 'En los últimos 6 meses'], ['about_1_year', 'Hace aproximadamente 1 año'], ['about_2_years', 'Hace aproximadamente 2 años'], ['over_3_years', 'Hace 3 años o más'], ['never', 'Nunca']],
    consent: 'Consentimiento', signName: 'Su nombre (para la firma)', relationship: 'Parentesco (si es para un menor)', relPh: 'Yo mismo / Padre / Tutor',
    agree: 'He leído y entiendo lo anterior, y doy mi consentimiento.', sigOpt: 'Firma', sigHint: 'Firme con su dedo o un lápiz óptico.', clear: 'Borrar',
    surgery: 'Consentimiento de Cirugía', surgeryIntro: 'Como podría realizarse una extracción, lea y firme esto también.', teeth: 'Número(s) de diente, si los sabe',
    submit: 'Enviar pre-registro', submitting: 'Enviando…', footer: 'Mission Minded Worldwide — atención dental gratuita. Su información se comparte solo con el equipo de la clínica.',
    thankYou: 'Gracias, ', done: 'Su pre-registro y consentimiento están completos. Por favor traiga una identificación con foto — la recepción ya tiene su información.',
    errName: 'Por favor ingrese su nombre y apellido.', errDob: 'Por favor ingrese su fecha de nacimiento.', errGender: 'Por favor elija un género.',
    errCity: 'Por favor ingrese su ciudad.', errState: 'Por favor ingrese su estado.', errPhone: 'Por favor ingrese un número de teléfono.',
    errEmName: 'Por favor ingrese el nombre de un contacto de emergencia.', errEmPhone: 'Por favor ingrese el teléfono del contacto de emergencia.',
    errServices: 'Elija al menos un servicio.',
    errMedical: 'Por favor responda todas las preguntas del historial médico y dental.',
    errVisit: 'Por favor elija qué necesita hoy.',
    errReload: 'Este formulario se actualizó después de que lo abrió. Vuelva a cargar la página y complételo de nuevo.',
    errConsent: 'Por favor lea y acepte el consentimiento para terminar.', errSurgery: 'Se seleccionó una extracción — por favor lea y acepte también el consentimiento de cirugía oral.',
    errSign: 'Por favor firme el consentimiento para terminar.', errSignSurgery: 'Por favor firme el consentimiento de cirugía oral.', errSigner: 'Por favor escriba su nombre para la firma.',
    netErr: 'Error de red. Por favor intente de nuevo.', genErr: 'Algo salió mal. Por favor intente de nuevo.',
    visits: FORM_VISITS_ES, allergyList: FORM_ALLERGIES_ES, conditionList: FORM_CONDITIONS_ES, medYesNo: FORM_MED_YESNO_ES, dentalYesNo: FORM_DENTAL_YESNO_ES,
    medChecklist: FORM_MED_CHECKLIST_ES, surgerySiteList: FORM_SURGERY_SITES_ES,
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
    '.yn{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}.yn:last-child{border-bottom:0}.yn span{font-size:13px;font-weight:600}.yn select{width:150px;flex:none}' +
    'h3.sub{font-size:14px;margin:18px 0 4px}' +
    '.consent{max-height:230px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:#fbfcfc;font-size:12.5px;line-height:1.55;color:#33454f}' +
    '.consent h3{font-size:13px;margin:0 0 8px;color:var(--ink)}.consent ol{margin:0;padding-left:18px}.consent li{margin:0 0 8px}.consent p{margin:0 0 9px}' +
    '.agree{display:flex;gap:9px;align-items:flex-start;margin-top:12px;font-size:14px;font-weight:600}.agree input{width:auto;margin:2px 0 0}' +
    '.sig{border:1px dashed var(--line);border-radius:10px;background:#fff;touch-action:none;width:100%;height:150px;display:block;margin-top:6px}' +
    '.sigbar{display:flex;justify-content:space-between;align-items:center;margin-top:6px}.sigbar a{font-size:13px;color:var(--g);text-decoration:underline;cursor:pointer}' +
    '</style></head><body><div class="wrap">' + inner + '</div></body></html>';
}
function checkinFormPage(eventUid, eventName, lang, cities) {
  const L = I18N[lang] || I18N.en;
  const chip = (name, k, label) => '<label class="chip"><input type="checkbox" name="' + name + '" value="' + htmlEscape(k) + '">' + htmlEscape(label) + '</label>';
  const raceChips = L.raceList.map(([k, l]) => chip('race', k, l)).join('');
  const visitOpts = L.visits.map(([k, l]) => '<label class="chip"><input type="radio" name="visit" value="' + htmlEscape(k) + '">' + htmlEscape(l) + '</label>').join('');
  const serviceChips = L.servicesList.map(([k, l]) => chip('service', k, l)).join('');
  const referralOpts = '<option value="">' + htmlEscape(L.dash) + '</option>' +
    L.referralList.map(([k, l]) => '<option value="' + htmlEscape(k) + '">' + htmlEscape(l) + '</option>').join('');
  // City: the event's towns as a dropdown with "Other" and a typed name — the
  // same list the kiosk offers — or, with no list, the text box it has always
  // been. The field keeps id="city" either way.
  const cityList = Array.isArray(cities) ? cities : [];
  const cityControl = cityList.length
    ? '<select id="city" autocomplete="address-level2"><option value="">' + htmlEscape(L.dash) + '</option>' +
      cityList.map((c) => '<option value="' + htmlEscape(c) + '">' + htmlEscape(c) + '</option>').join('') +
      '<option value="other">' + htmlEscape(L.otherCity) + '</option></select>'
    : '<input type="text" id="city" autocomplete="address-level2" maxlength="80">';
  const cityOther = cityList.length
    ? '<div id="cityOtherWrap" style="display:none"><label>' + htmlEscape(L.cityOther) + ' <span class="req">*</span></label><input type="text" id="city_other" maxlength="80"></div>'
    : '';

  // Every single-choice history question is a dropdown with a blank first
  // option, and every one is required: a blank is not the same as "no", and the
  // dentist reads these before deciding whether it is safe to treat.
  const answer = { yes: L.yes, no: L.no, unsure: L.unsure, na: L.notApplicable };
  const selRow = (id, label, values) => '<div class="yn"><span>' + htmlEscape(label) + ' <span class="req">*</span></span><select id="' + id + '">' +
    '<option value="">' + htmlEscape(L.dash) + '</option>' +
    values.map((v) => '<option value="' + v + '">' + htmlEscape(answer[v]) + '</option>').join('') + '</select></div>';
  const medQ = (k) => (L.medYesNo.find(([key]) => key === k) || [])[1];
  // Condition ids are namespaced (cond_<key>): kidney and liver are also body
  // sites for the surgery question, and two elements must never share an id.
  // Pregnancy alone adds "Not applicable" — "(when applicable)" on his form.
  const condRows = L.conditionList.map(([k, l]) => selRow('cond_' + k, l, ['yes', 'no', 'unsure', ...(k === 'pregnant' ? ['na'] : [])])).join('');
  const medChips = L.medChecklist.map(([k, l]) => chip('med', k, l)).join('') + chip('med', 'other', L.otherOpt) +
    '<label class="chip"><input type="checkbox" id="medications_none">' + htmlEscape(L.noMeds) + '</label>';
  const siteChips = L.surgerySiteList.map(([k, l]) => chip('surgery_site', k, l)).join('');
  const allergyChips = L.allergyList.map(([k, l]) => chip('allergy', k, l)).join('') + chip('allergy', 'other', L.otherOpt);
  const dentalYesNo = L.dentalYesNo.map(([k, l]) => selRow(k, l, ['yes', 'no'])).join('');
  const genConsent = '<h3>' + htmlEscape(L.generalTitle) + '</h3>' + (L.generalMode === 'ol' ? ('<ol>' + L.general.map((c) => '<li>' + htmlEscape(c) + '</li>').join('') + '</ol>') : L.general.map((c) => '<p>' + htmlEscape(c) + '</p>').join(''));
  const surConsent = '<h3>' + htmlEscape(L.surgeryTitle) + '</h3>' + L.surgeryText.map((c) => '<p>' + htmlEscape(c) + '</p>').join('');
  const T = { errName: L.errName, errDob: L.errDob, errGender: L.errGender, errCity: L.errCity, errState: L.errState, errPhone: L.errPhone, errEmName: L.errEmName, errEmPhone: L.errEmPhone, errServices: L.errServices, errMedical: L.errMedical, errVisit: L.errVisit, errConsent: L.errConsent, errSurgery: L.errSurgery, errSign: L.errSign, errSignSurgery: L.errSignSurgery, errSigner: L.errSigner, submitting: L.submitting, submitLabel: L.submit, thankYou: L.thankYou, done: L.done, netErr: L.netErr, genErr: L.genErr, medNamePh: L.medNamePh };
  // The wording each refusal quotes, keyed like firstMissingHistory's ids, so
  // the page names the question it wants exactly as the server would.
  const Q = { under_treatment: medQ('under_treatment'), major_surgery: medQ('major_surgery'), tobacco: medQ('tobacco'),
    medications: L.meds, medications_other: L.medOther, surgery_sites: L.surgerySites, allergy_status: L.allergyQ,
    allergies: L.allergies, allergies_other: L.allergyOther, prior_dentist: L.priorDentist };
  L.conditionList.forEach(([k, l]) => { Q['condition:' + k] = l; });
  L.dentalYesNo.forEach(([k, l]) => { Q['dental:' + k] = l; });

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
    '<div class="row"><div><label>' + htmlEscape(L.phone) + ' <span class="req">*</span></label><input type="tel" id="phone" inputmode="numeric" autocomplete="tel"></div>' +
    '<div><label>' + htmlEscape(L.email) + '</label><input type="email" id="email" autocomplete="email"></div></div>' +
    '<label>' + htmlEscape(L.address) + '</label><input type="text" id="address" autocomplete="street-address">' +
    '<div class="row"><div><label>' + htmlEscape(L.city) + ' <span class="req">*</span></label>' + cityControl + '</div>' +
    '<div><label>' + htmlEscape(L.state) + ' <span class="req">*</span></label><select id="state" autocomplete="address-level1"><option value="">' + htmlEscape(L.dash) + '</option>' + US_STATE_OPTIONS + '</select></div></div>' +
    cityOther +
    '<div class="row"><div><label>' + htmlEscape(L.emName) + ' <span class="req">*</span></label><input type="text" id="emergency_name"></div>' +
    '<div><label>' + htmlEscape(L.emPhone) + ' <span class="req">*</span></label><input type="tel" id="emergency_phone" inputmode="numeric"></div></div>' +
    '<label>' + htmlEscape(L.referral) + '</label><select id="referral">' + referralOpts + '</select>' +
    '<div id="referralOtherWrap" style="display:none"><label>' + htmlEscape(L.referralOther) + '</label><input type="text" id="referral_other"></div>' +
    '</div>' +

    '<div class="card"><h2>' + htmlEscape(L.services) + ' <span class="req">*</span></h2><p class="hint" style="margin:0 0 6px">' + htmlEscape(L.serviceHint) + '</p>' +
    '<div class="chips" id="services">' + serviceChips + '</div></div>' +

    '<div class="card"><h2>' + htmlEscape(L.need) + ' <span class="req">*</span></h2><div class="chips">' + visitOpts + '</div>' +
    '</div>' +

    '<div class="card"><h2>' + htmlEscape(L.raceTitle) + '</h2><p class="hint" style="margin:0 0 6px">' + htmlEscape(L.raceHint) + '</p><div class="chips" id="race">' + raceChips + '</div></div>' +

    // The medical history, in the order the walk-in form asks it (Dr. Trinh's
    // form, v0.0.15).
    '<div class="card"><h2>' + htmlEscape(L.medHist) + '</h2>' +
    selRow('under_treatment', medQ('under_treatment'), ['yes', 'no']) +
    '<h3 class="sub">' + htmlEscape(L.conditions) + ' <span class="req">*</span></h3><p class="hint" style="margin:0 0 4px">' + htmlEscape(L.condHint) + '</p>' +
    '<div id="conditions">' + condRows + '</div>' +
    '<label>' + htmlEscape(L.conditionOther) + '</label><input type="text" id="conditions_other">' +
    '<h3 class="sub">' + htmlEscape(L.meds) + ' <span class="req">*</span></h3><p class="hint" style="margin:0 0 4px">' + htmlEscape(L.medsHint) + '</p>' +
    '<div class="chips" id="medchips">' + medChips + '</div>' +
    '<div id="medOtherWrap" style="display:none"><label>' + htmlEscape(L.medOther) + ' <span class="req">*</span></label>' +
    '<datalist id="medlist">' + MED_OPTIONS + '</datalist><div id="meds"></div>' +
    '<button type="button" class="addbtn" id="addmed">' + htmlEscape(L.addMed) + '</button></div>' +
    selRow('major_surgery', medQ('major_surgery'), ['yes', 'no']) +
    '<div id="surgerySitesWrap" style="display:none"><label>' + htmlEscape(L.surgerySites) + ' <span class="req">*</span></label><div class="chips" id="sites">' + siteChips + '</div></div>' +
    selRow('tobacco', medQ('tobacco'), ['yes', 'no']) +
    '<h3 class="sub">' + htmlEscape(L.allergies) + ' <span class="req">*</span></h3>' +
    '<div class="yn"><span>' + htmlEscape(L.allergyQ) + ' <span class="req">*</span></span><select id="allergy_status">' +
    '<option value="">' + htmlEscape(L.dash) + '</option><option value="nkda">' + htmlEscape(L.nkda) + '</option>' +
    '<option value="yes">' + htmlEscape(L.yes) + '</option><option value="unsure">' + htmlEscape(L.unsure) + '</option></select></div>' +
    '<div id="allergyListWrap" style="display:none"><p class="hint" style="margin:6px 0 4px">' + htmlEscape(L.allergiesHint) + '</p><div class="chips" id="allergies">' + allergyChips + '</div>' +
    '<div id="allergyOtherWrap" style="display:none"><label for="allergies_other">' + htmlEscape(L.allergyOther) + ' <span class="req">*</span></label><input type="text" id="allergies_other"></div></div>' +
    '</div>' +

    '<div class="card"><h2>' + htmlEscape(L.dentHist) + '</h2><label>' + htmlEscape(L.priorDentist) + ' <span class="req">*</span></label>' +
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

    '<div class="err" id="err"></div>' +
    '<button class="btn" id="submit" type="submit">' + htmlEscape(L.submit) + '</button>' +
    '<p class="hint" style="text-align:center;margin-top:14px">' + htmlEscape(L.footer) + '</p>' +
    '</form>' +

    '<script>' +
    'var T=' + JSON.stringify(T) + ';var LANG=' + JSON.stringify(lang) + ';' +
    'var Q=' + JSON.stringify(Q) + ';' +
    'var CONDQ=' + JSON.stringify(L.conditionList.map(([k]) => k)) + ';' +
    'var DENTQ=' + JSON.stringify(L.dentalYesNo.map(([k]) => k)) + ';' +
    "function el(id){return document.getElementById(id);}function val(id){var e=el(id);return e?e.value:'';}" +
    "function chipwire(id){document.querySelectorAll('#'+id+' .chip input').forEach(function(i){i.addEventListener('change',function(){i.closest('.chip').classList.toggle('on',i.checked);});});}" +
    "chipwire('services');chipwire('race');chipwire('sites');chipwire('allergies');" +
    // "Prefer not to answer" is about the race list, so it replaces it — shown
    // on the page as the walk-in form shows it, not reconciled silently on save.
    "document.querySelectorAll('#race input').forEach(function(i){i.addEventListener('change',function(){if(!i.checked)return;var pna=i.value==='prefer_not';document.querySelectorAll('#race input').forEach(function(o){if(o!==i&&(pna||o.value==='prefer_not'))o.checked=false;o.closest('.chip').classList.toggle('on',o.checked);});});});" +
    "function syncRefOther(){el('referralOtherWrap').style.display=val('referral')==='other'?'':'none';}el('referral').addEventListener('change',syncRefOther);syncRefOther();" +
    // "Other" reveals a typed city, exactly as the referral question does.
    "function syncCityOther(){var w=el('cityOtherWrap');if(w)w.style.display=val('city')==='other'?'':'none';}el('city').addEventListener('change',syncCityOther);syncCityOther();" +
    "function checked(name){return Array.prototype.slice.call(document.querySelectorAll('input[name='+name+']:checked')).map(function(i){return i.value;});}" +
    "function mkpad(id){var c=el(id);if(!c)return null;var ctx=c.getContext('2d');var drawing=false,empty=true;function fit(){var r=c.getBoundingClientRect();if(!r.width)return;c.width=r.width;c.height=150;ctx.lineWidth=2.2;ctx.lineCap='round';ctx.strokeStyle='#12303f';}fit();window.addEventListener('resize',fit);function pt(e){var r=c.getBoundingClientRect();var t=(e.touches&&e.touches[0])?e.touches[0]:e;return{x:t.clientX-r.left,y:t.clientY-r.top};}function down(e){drawing=true;empty=false;var p=pt(e);ctx.beginPath();ctx.moveTo(p.x,p.y);e.preventDefault();}function mv(e){if(!drawing)return;var p=pt(e);ctx.lineTo(p.x,p.y);ctx.stroke();e.preventDefault();}function up(){drawing=false;}c.addEventListener('pointerdown',down);c.addEventListener('pointermove',mv);window.addEventListener('pointerup',up);return{data:function(){return empty?null:c.toDataURL('image/png');},clear:function(){ctx.clearRect(0,0,c.width,c.height);empty=true;},fit:fit};}" +
    "var gpad=mkpad('gsig');var spad=mkpad('ssig');el('gclear').onclick=function(){if(gpad)gpad.clear();};if(el('sclear'))el('sclear').onclick=function(){if(spad)spad.clear();};" +
    "function syncVisit(){document.querySelectorAll('input[name=visit]').forEach(function(r){r.closest('.chip').classList.toggle('on',r.checked);});var v=(document.querySelector('input[name=visit]:checked')||{}).value||'';var ex=(v==='extraction_pain'||v==='extraction_no_pain');el('surgeryCard').style.display=ex?'block':'none';if(ex&&spad)setTimeout(function(){spad.fit();},0);}" +
    "document.querySelectorAll('input[name=visit]').forEach(function(i){i.addEventListener('change',syncVisit);});" +
    "var meds=el('meds');function addmed(){var d=document.createElement('div');d.className='med-row';d.innerHTML='<input type=\"text\" list=\"medlist\" autocomplete=\"off\" placeholder=\"'+T.medNamePh+'\"><button type=\"button\">✕</button>';d.querySelector('button').onclick=function(){d.remove();};meds.appendChild(d);}el('addmed').onclick=addmed;" +
    // "Other" reveals typed medications; "No medications" is an answer ABOUT the
    // list, so it clears the ticks and any tick clears it.
    "function syncMedOther(){var on=checked('med').indexOf('other')>=0;el('medOtherWrap').style.display=on?'':'none';if(on&&!meds.children.length)addmed();}" +
    "document.querySelectorAll('#medchips input').forEach(function(i){i.addEventListener('change',function(){if(i.checked){if(i.id==='medications_none'){document.querySelectorAll('#medchips input[name=med]').forEach(function(o){o.checked=false;});}else{el('medications_none').checked=false;}}document.querySelectorAll('#medchips .chip').forEach(function(c){c.classList.toggle('on',c.querySelector('input').checked);});syncMedOther();});});" +
    "function syncSites(){el('surgerySitesWrap').style.display=val('major_surgery')==='yes'?'':'none';}el('major_surgery').addEventListener('change',syncSites);" +
    "function syncAllergy(){el('allergyListWrap').style.display=val('allergy_status')==='yes'?'':'none';el('allergyOtherWrap').style.display=checked('allergy').indexOf('other')>=0?'':'none';}" +
    "el('allergy_status').addEventListener('change',syncAllergy);document.querySelectorAll('#allergies input').forEach(function(i){i.addEventListener('change',syncAllergy);});" +
    // A browser that puts the patient's earlier answers back (a reload, Back,
    // a restored tab) sets them without any change event. Each section that
    // follows an answer is therefore set once from the page as it loads, as
    // the referral and City boxes are, and every chip lit from its tick — or a
    // restored "Yes" or "Other" hid the very list or box that submitting then
    // asked for, and the page scrolled to a question the patient could not see.
    "document.querySelectorAll('.chip input').forEach(function(i){i.closest('.chip').classList.toggle('on',i.checked);});syncVisit();syncMedOther();syncSites();syncAllergy();" +
    "function otherMeds(){return Array.prototype.slice.call(meds.querySelectorAll('input')).map(function(i){return i.value.trim();}).filter(Boolean);}" +
    // The first unanswered history question, in the order the form asks it —
    // the walk-in form's order and rules exactly — as [question id, element id].
    "function missingHistory(){" +
    "if(!val('under_treatment'))return['under_treatment'];" +
    "for(var c=0;c<CONDQ.length;c++){if(!val('cond_'+CONDQ[c]))return['condition:'+CONDQ[c],'cond_'+CONDQ[c]];}" +
    "var mk=checked('med'),other=mk.indexOf('other')>=0,none=el('medications_none').checked;" +
    "if(!none&&other&&!otherMeds().length)return['medications_other','medOtherWrap'];" +
    "if(!none&&!mk.filter(function(k){return k!=='other';}).length&&!(other&&otherMeds().length))return['medications','medchips'];" +
    "if(!val('major_surgery'))return['major_surgery'];" +
    "if(val('major_surgery')==='yes'&&!checked('surgery_site').length)return['surgery_sites','sites'];" +
    "if(!val('tobacco'))return['tobacco'];" +
    "if(!val('allergy_status'))return['allergy_status'];" +
    "if(val('allergy_status')==='yes'){var al=checked('allergy');if(!al.length)return['allergies','allergies'];if(al.indexOf('other')>=0&&!val('allergies_other').trim())return['allergies_other'];}" +
    "if(!val('prior_dentist'))return['prior_dentist'];" +
    "for(var d=0;d<DENTQ.length;d++){if(!val(DENTQ[d]))return['dental:'+DENTQ[d],DENTQ[d]];}" +
    "return null;}" +
    "el('f').addEventListener('submit',function(e){e.preventDefault();var err=el('err');err.textContent='';" +
    "var fn=val('first_name').trim(),ln=val('last_name').trim();if(!fn||!ln){err.textContent=T.errName;window.scrollTo(0,0);return;}" +
    "if(!val('dob')){err.textContent=T.errDob;return;}if(!val('gender')){err.textContent=T.errGender;return;}" +
    "if(!val('city')){err.textContent=T.errCity;return;}if(val('city')==='other'&&!val('city_other').trim()){err.textContent=T.errCity;el('city_other').focus();return;}if(!val('state')){err.textContent=T.errState;return;}" +
    "if(!val('phone').replace(/\\D/g,'')){err.textContent=T.errPhone;el('phone').focus();return;}" +
    "if(!val('emergency_name').trim()){err.textContent=T.errEmName;el('emergency_name').focus();return;}" +
    "if(!val('emergency_phone').trim()){err.textContent=T.errEmPhone;el('emergency_phone').focus();return;}" +
    "if(!checked('service').length){err.textContent=T.errServices;el('services').scrollIntoView({block:'center'});return;}" +
    "var visit=(document.querySelector('input[name=visit]:checked')||{}).value||'';var extraction=(visit==='extraction_pain'||visit==='extraction_no_pain');" +
    "if(!visit){err.textContent=T.errVisit;return;}" +
    // Every medical and dental history question must be answered — a blank is
    // not the same as "no", and the dentist reads these before treating. The
    // message names the question, as the walk-in form's refusal does.
    "var miss=missingHistory();" +
    "if(miss){err.textContent=T.errMedical.replace(/\\.$/,'')+': '+Q[miss[0]];var e2=el(miss[1]||miss[0]);if(e2){e2.scrollIntoView({block:'center'});if(e2.focus)e2.focus();}return;}" +
    "if(!el('cagree').checked){err.textContent=T.errConsent;return;}" +
    "if(!val('signer').trim()){err.textContent=T.errSigner;return;}" +
    "if(!gpad||!gpad.data()){err.textContent=T.errSign;el('gsig').scrollIntoView({block:'center'});return;}" +
    "if(extraction&&!el('sagree').checked){err.textContent=T.errSurgery;return;}" +
    "if(extraction&&(!spad||!spad.data())){err.textContent=T.errSignSurgery;el('ssig').scrollIntoView({block:'center'});return;}" +
    "var ca={};CONDQ.forEach(function(k){ca[k]=val('cond_'+k);});var mk=checked('med'),none=el('medications_none').checked;" +
    "var payload={form_version:" + FORM_VERSION + ",first_name:fn,last_name:ln,dob:val('dob'),gender:val('gender'),phone:val('phone'),email:val('email'),language:LANG,address:val('address'),city:val('city'),city_other:val('city_other'),state:val('state'),emergency_name:val('emergency_name'),emergency_phone:val('emergency_phone')," +
    "services:checked('service'),referral:val('referral'),referral_other:val('referral_other')," +
    "visit_type:visit,race:checked('race')," +
    "under_treatment:val('under_treatment'),condition_answers:ca,conditions_other:val('conditions_other')," +
    "med_keys:none?[]:mk.filter(function(k){return k!=='other';}),medications_other:none||mk.indexOf('other')<0?[]:otherMeds(),medications_none:none," +
    "major_surgery:val('major_surgery'),surgery_sites:checked('surgery_site'),tobacco:val('tobacco')," +
    "allergy_status:val('allergy_status'),allergies:checked('allergy'),allergies_other:val('allergies_other')," +
    "prior_dentist:val('prior_dentist')," +
    "consent_agree:el('cagree').checked,signer_name:val('signer'),relationship:val('relationship'),signature_png:gpad?gpad.data():null," +
    "surgery_agree:el('sagree')?el('sagree').checked:false,surgery_teeth:val('steeth'),surgery_signature_png:spad?spad.data():null};" +
    // The Step 3 answers are posted from the same list the page renders and
    // the server validates, so the three can never name different questions.
    "DENTQ.forEach(function(k){payload[k]=val(k);});" +
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
