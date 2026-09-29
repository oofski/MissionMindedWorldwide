// Headless harness: runs the REAL renderer code under jsdom against the real
// SQLite data layer, to verify the intake -> patient-history -> views flow.
import { JSDOM } from 'jsdom';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ---- electron stub so db/pdf can be required ----
const ep = require.resolve('electron');
require.cache[ep] = { id: ep, filename: ep, loaded: true, exports: { BrowserWindow: class {} } };
const db = require('../src/main/db.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uih-'));
const DB_PATH = db.init(tmp);

// v0.0.5: the bootstrap administrator is seeded again, so the harness signs in
// with the shipped credential rather than creating one — which means every run
// proves an installer's out-of-the-box sign-in actually works. The first-run
// setup path is still covered, in the child-process probe further down.
const fileURLToPathSev = (u) => decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1');
const SETUP_ADMIN = { full_name: 'Administrator', username: 'admin', password: 'admin' };
const signInAdmin = () => db.login(SETUP_ADMIN.username, SETUP_ADMIN.password);
// A second handle on the same file, for the handful of checks that have to
// forge history (back-date a visit) or read a column the API does not expose.
const rawDb = () => new (require('better-sqlite3'))(DB_PATH);

// ---- jsdom env ----
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Event = window.Event;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.FileReader = window.FileReader;
globalThis.File = window.File;
globalThis.Blob = window.Blob;
globalThis.Image = window.Image;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.devicePixelRatio = 1;
window.speechSynthesis = { cancel() {}, speak() {} };
globalThis.SpeechSynthesisUtterance = class { constructor() {} };
window.SpeechSynthesisUtterance = globalThis.SpeechSynthesisUtterance;
// canvas stub (signature pad)
const fakeCtx = new Proxy({}, { get: () => () => {} });
window.HTMLCanvasElement.prototype.getContext = () => fakeCtx;
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,SIG';
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};
window.HTMLElement.prototype.scrollIntoView = function () {};

// ---- mock window.api delegating to the real db, ENFORCING the IPC permission
// matrix (mirrors src/main/ipc.js) so permission regressions are caught here. ----
let currentUser = null;
const PERMS = {
  'usersList': ['admin'], 'usersCreate': ['admin'], 'usersUpdate': ['admin'], 'usersDelete': ['admin'],
  'usersClearEventStaff': ['admin'],
  'eventsCreate': ['admin'], 'eventsUpdate': ['admin'], 'eventsSetActive': ['admin'], 'eventsSetState': ['admin'], 'eventsDelete': ['admin'],
  'patientsUpdate': ['admin', 'triage', 'doctor'], 'patientsGet': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'patientsList': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'], 'patientsRecords': ['admin', 'doctor'],
  'patientsSearchAll': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'], 'patientsHistory': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'],
  'patientsIncomplete': ['admin'], 'patientsCleanupIncomplete': ['admin'], 'patientsDelete': ['admin'],
  'patientsDismiss': ['admin', 'checkout'], 'patientsMove': ['admin'], 'patientsAudit': ['admin', 'doctor', 'checkout', 'hygienist'],
  'vitalsSave': ['admin', 'doctor', 'triage', 'emt'], 'patientsRoute': ['admin', 'doctor', 'triage', 'emt'], 'consentSetTeeth': ['admin', 'doctor'], 'consentAdd': ['admin', 'doctor'],
  'usbLoad': ['admin', 'doctor', 'triage', 'checkout'], 'usbUploadCheckout': ['admin', 'doctor', 'triage', 'checkout'], 'usbClear': ['admin', 'doctor', 'triage', 'checkout'],
  'triageSave': ['admin', 'doctor', 'triage'], 'treatmentSave': ['admin', 'doctor', 'hygienist'],
  'surveySave': ['admin', 'checkout', 'doctor', 'triage', 'emt', 'hygienist', 'registration'],
  'inventoryList': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'inventoryGet': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'inventoryMove': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
  'inventorySave': ['admin'], 'inventoryDelete': ['admin'],
  'xrayAdd': ['admin', 'doctor', 'triage', 'emt'], 'xraySetTooth': ['admin', 'doctor'], 'xrayGet': ['admin', 'doctor', 'triage', 'emt', 'hygienist'], 'xrayList': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist'], 'xrayDelete': ['admin', 'doctor', 'triage', 'emt'],
  'xrayFolderConfig': ['admin', 'doctor'], 'xrayFolderChoose': ['admin', 'doctor'], 'xrayFolderLock': ['admin', 'doctor'], 'xrayFolderDelete': ['admin', 'doctor'], 'xrayDeleteFile': ['admin', 'doctor'],
  'pdfPreview': ['admin', 'doctor', 'checkout'], 'pdfGenerate': ['admin', 'doctor', 'checkout'], 'pdfPrint': ['admin', 'doctor', 'checkout'],
  'recordExportUsb': ['admin', 'doctor'], 'backupRun': ['admin'], 'exportEvent': ['admin'], 'auditList': ['admin'],
  'reportsArchived': ['admin', 'doctor'], 'reportsRollup': ['admin', 'doctor'],
  // v0.0.15: the rest of ipc.js PERMS, so this is the WHOLE matrix and the
  // parity check (at the C anchor) can hold it to ipc.js entry for entry.
  // patientsCreate / patientsNewVisit are listed as ipc.js lists them; the
  // create channel itself is registered ungated there, and so is its mock.
  'patientsCreate': ['admin', 'doctor', 'triage', 'emt', 'registration'], 'patientsNewVisit': ['admin', 'doctor', 'triage', 'emt', 'registration'],
  'patientsUpdateSection': ['admin', 'registration', 'emt', 'triage', 'doctor', 'hygienist', 'checkout'],
  'treatmentUnlock': ['admin'], 'treatmentLock': ['admin'],
  'patientsArrivalCheck': ['admin', 'registration', 'emt', 'triage', 'doctor', 'hygienist'], 'patientsConfirmArrival': ['admin', 'registration', 'emt', 'triage'],
  'xrayFolderList': ['admin', 'doctor'], 'usbList': ['admin', 'doctor', 'triage', 'emt', 'checkout'],
  'reportExport': ['admin', 'doctor'], 'inventoryChairUsage': ['admin', 'doctor'],
  'exportZip': ['admin'], 'exportClinic': ['admin'], 'importClinic': ['admin'], 'eventFinish': ['admin'], 'eventPurge': ['admin'], 'reportsRebuild': ['admin'],
  'cloudConfig': ['admin'], 'cloudTest': ['admin'], 'cloudResync': ['admin'], 'cloudDisconnect': ['admin'], 'dataReset': ['admin'],
  'cloudStatus': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'], 'cloudSyncNow': ['admin', 'doctor', 'triage', 'emt', 'checkout', 'hygienist', 'registration'],
};
// patientsCreate is intentionally UNGATED (kiosk + any role); statsDashboard needs a user.
function guard(name) {
  const allowed = PERMS[name];
  if (!allowed) return;
  if (!currentUser) throw new Error('Please sign in first.');
  if (!allowed.includes(currentUser.role)) throw new Error('Your role does not have permission for this action.');
}
const okWrap = (fn, name) => async (payload) => { try { if (name) guard(name); return { ok: true, data: await fn(payload) }; } catch (e) { return { ok: false, error: e.message }; } };
// Mutable stand-in for the DEXIS export folder used by the X-ray import wizard.
let mockFolder = { dir: '', locked: false, clearAfter: true, images: [] };
// Records absolute paths the renderer asked to delete from the computer's drive.
const mockDeletedFromDrive = [];
window.api = {
  invoke: async () => ({ ok: true }),
  authLogin: okWrap(({ username, password }) => { const u = db.login(username, password); if (!u) throw new Error('Invalid username or password.'); currentUser = u; return u; }),
  authLogout: async () => { currentUser = null; return { ok: true }; },
  authCurrent: okWrap(() => currentUser),
  usersList: okWrap(() => db.listUsers(), 'usersList'),
  usersCreate: okWrap((p) => db.createUser(currentUser, p), 'usersCreate'),
  usersUpdate: okWrap(({ id, ...r }) => db.updateUser(currentUser, id, r), 'usersUpdate'),
  usersDelete: okWrap((id) => db.deleteUser(currentUser, id), 'usersDelete'),
  usersClearEventStaff: okWrap((eventId) => db.clearEventStaff(currentUser, eventId), 'usersClearEventStaff'),
  eventsList: okWrap(() => db.listEvents()),
  eventsActive: okWrap(() => db.getActiveEvent()),
  eventsCreate: okWrap((p) => db.createEvent(currentUser, p), 'eventsCreate'),
  eventsUpdate: okWrap(({ id, ...r }) => db.updateEvent(currentUser, id, r), 'eventsUpdate'),
  eventsSetActive: okWrap((id) => db.setActiveEvent(currentUser, id), 'eventsSetActive'),
  eventsSetState: okWrap(({ id, active }) => db.setEventActive(currentUser, id, active), 'eventsSetState'),
  eventsDelete: okWrap(({ id, force }) => db.deleteEvent(currentUser, id, { force }), 'eventsDelete'),
  patientsCreate: okWrap((p) => db.createPatient(currentUser, p)), // ungated (kiosk + any role)
  patientsUpdate: okWrap(({ id, ...d }) => db.updatePatient(currentUser, id, d), 'patientsUpdate'),
  // Mirrors the ipc.js handler: the channel is open to every staff role, and
  // which SECTION a role may change is checked against db.SECTION_ROLES.
  patientsUpdateSection: okWrap(({ id, section, values, reviewedOnly } = {}) => {
    const roles = db.SECTION_ROLES[section];
    if (!roles) throw new Error('Unknown section.');
    if (!roles.includes(currentUser.role)) throw new Error('Your role does not have permission for this action.');
    return db.updatePatientSection(currentUser, id, section, values, { reviewedOnly: !!reviewedOnly });
  }, 'patientsUpdateSection'),
  patientsDelete: okWrap((id) => db.deletePatient(currentUser, id), 'patientsDelete'),
  patientsGet: okWrap((id) => db.getPatient(id), 'patientsGet'),
  patientsList: okWrap((o) => db.listPatients(o || {}), 'patientsList'),
  patientsRecords: okWrap((o) => db.listPatients(o || {}), 'patientsRecords'),
  patientsSearchAll: okWrap((t) => db.searchAllPatients(t), 'patientsSearchAll'),
  // Ungated in ipc.js, like the real channel: any signed-in station may resolve a
  // scanned band, and an unknown code errors rather than returning a null the
  // caller has to guess at.
  patientsFindByCode: okWrap((code) => {
    const found = db.findPatientByCode(code);
    if (!found) throw new Error('No patient found for that wristband.');
    return found;
  }),
  patientsHistory: okWrap((id) => db.patientHistory(id), 'patientsHistory'),
  patientsIncomplete: okWrap(() => db.listIncompletePatients(), 'patientsIncomplete'),
  patientsCleanupIncomplete: okWrap(() => db.deleteIncompletePatients(currentUser), 'patientsCleanupIncomplete'),
  triageSave: okWrap(({ patientId, data }) => db.saveTriage(currentUser, patientId, data), 'triageSave'),
  surveySave: okWrap(({ patientId, data }) => db.saveExitSurvey(currentUser, patientId, data), 'surveySave'),
  inventoryList: okWrap(({ eventId } = {}) => db.listInventory({ eventId }), 'inventoryList'),
  inventoryGet: okWrap(({ id }) => db.getInventoryItem(id), 'inventoryGet'),
  inventorySave: okWrap(({ data }) => db.saveInventoryItem(currentUser, data), 'inventorySave'),
  inventoryMove: okWrap(({ data }) => db.recordInventoryMove(currentUser, data), 'inventoryMove'),
  inventoryDelete: okWrap(({ id }) => db.deleteInventoryItem(currentUser, id), 'inventoryDelete'),
  treatmentSave: okWrap(({ patientId, data, finalize }) => db.saveTreatment(currentUser, patientId, data, finalize), 'treatmentSave'),
  treatmentUnlock: okWrap(({ patientId, reason } = {}) => db.unlockRecord(currentUser, patientId, reason), 'treatmentUnlock'),
  treatmentLock: okWrap(({ patientId } = {}) => db.lockRecord(currentUser, patientId), 'treatmentLock'),
  vitalsSave: okWrap(({ patientId, data }) => db.saveVitals(currentUser, patientId, data), 'vitalsSave'),
  patientsRoute: okWrap(({ patientId, route }) => db.routePatient(currentUser, patientId, route), 'patientsRoute'),
  consentSetTeeth: okWrap(({ consentId, tooth_numbers }) => db.updateConsentTeeth(currentUser, consentId, tooth_numbers), 'consentSetTeeth'),
  consentAdd: okWrap(({ patientId, consent }) => db.addPatientConsent(currentUser, patientId, consent), 'consentAdd'),
  patientsDismiss: okWrap((id) => db.dismissPatient(currentUser, id), 'patientsDismiss'),
  patientsMove: okWrap(({ id, target }) => db.adminMovePatient(currentUser, id, target), 'patientsMove'),
  patientsAudit: okWrap((id) => db.patientAudit(id), 'patientsAudit'),
  usbList: async () => ({ ok: true, data: [] }),
  usbWriteCheckin: async () => ({ ok: true, data: { saved: false } }),
  usbLoad: okWrap(() => ({ loaded: [] }), 'usbLoad'),
  usbUploadCheckout: okWrap(() => ({ uploaded: 0 }), 'usbUploadCheckout'),
  usbClear: okWrap(() => ({ cleared: 0 }), 'usbClear'),
  xrayAdd: okWrap((p) => db.addXray(currentUser, p.patientId, p), 'xrayAdd'),
  xraySetTooth: okWrap(({ id, tooth }) => db.updateXrayTooth(currentUser, id, tooth), 'xraySetTooth'),
  // In-memory stand-in for the DEXIS export folder (the real one lives in main).
  xrayFolderList: async () => ({ ok: true, data: { dir: mockFolder.dir, locked: mockFolder.locked, clearAfter: mockFolder.clearAfter, needsSetup: !mockFolder.dir, images: mockFolder.images.slice() } }),
  xrayFolderConfig: okWrap(() => ({ dir: mockFolder.dir, locked: mockFolder.locked, clearAfter: mockFolder.clearAfter }), 'xrayFolderConfig'),
  xrayFolderChoose: okWrap(() => { mockFolder.dir = 'C:/DEXIS/Images'; return { dir: mockFolder.dir, locked: mockFolder.locked, clearAfter: mockFolder.clearAfter }; }, 'xrayFolderChoose'),
  xrayFolderLock: okWrap((o) => { if (o.locked !== undefined) mockFolder.locked = !!o.locked; if (o.clearAfter !== undefined) mockFolder.clearAfter = !!o.clearAfter; return { dir: mockFolder.dir, locked: mockFolder.locked, clearAfter: mockFolder.clearAfter }; }, 'xrayFolderLock'),
  xrayFolderDelete: okWrap(({ name }) => { mockFolder.images = mockFolder.images.filter((im) => im.name !== name); return { ok: true }; }, 'xrayFolderDelete'),
  xrayDeleteFile: okWrap(({ path }) => { mockDeletedFromDrive.push(path); return { ok: true }; }, 'xrayDeleteFile'),
  xrayGet: okWrap((id) => db.getXray(id), 'xrayGet'),
  xrayList: okWrap((id) => db.listXrays(id), 'xrayList'),
  xrayDelete: okWrap((id) => db.deleteXray(currentUser, id), 'xrayDelete'),
  statsDashboard: okWrap(() => { if (!currentUser) throw new Error('Please sign in first.'); return db.dashboardStats(); }),
  auditList: okWrap((l) => db.listAudit(l), 'auditList'),
  // v1.6.5: the kept totals a purged clinic leaves behind.
  reportsArchived: okWrap(() => db.listEventReports(), 'reportsArchived'),
  // v1.6.6: the Reports tab's numbers — live records AND kept totals, counted once.
  reportsRollup: okWrap(({ eventId } = {}) => db.reportRollup(eventId), 'reportsRollup'),
  // Gated like the real channels (v0.0.15): ungated, these hid that the Vitals
  // queue offered emt and triage a PDF button the IPC always refused.
  pdfPreview: okWrap(() => 'data:application/pdf;base64,', 'pdfPreview'),
  pdfGenerate: okWrap(() => ({ saved: false }), 'pdfGenerate'),
  pdfPrint: okWrap(() => ({ printed: true }), 'pdfPrint'),
  recordExportUsb: async () => ({ ok: true, data: { saved: false } }),
  backupRun: async () => ({ ok: true, data: { saved: false } }),
  exportEvent: async () => ({ ok: true, data: { saved: false, count: 0 } }),
  appVersion: async () => ({ ok: true, data: { version: '1.0.2', platform: 'test', name: 'Caring Hands' } }),
  updateCheck: async () => ({ ok: true, data: { current: '1.0.2', hasUpdate: false, latest: null, checkedAt: '' } }),
  updateInstall: async () => ({ ok: true, data: { launched: true } }),
  appOpenExternal: async () => ({ ok: true }),
  // v1.2.3 cloud sync — always-online by default
  cloudStatus: async () => ({ ok: true, data: { enabled: true, mode: 'online', online: true, url: 'https://example.invalid/mmw-sync', hasKey: true, configured: true, deviceId: 'test-device', cursor: '', lastOk: '', lastPush: '', lastError: '', running: false, pushed: 0, pulled: 0, applied: 0 } }),
  cloudConfig: async () => ({ ok: true, data: { enabled: true, mode: 'online', online: true, url: 'https://example.invalid/mmw-sync', hasKey: true, configured: true } }),
  cloudTest: async () => ({ ok: true, data: { service: 'mmw-sync', version: '1.1.0' } }),
  cloudSyncNow: async () => ({ ok: true, data: { ok: true, pushed: 0, pulled: 0, applied: 0 } }),
  onCloudChanged: () => () => {},
};

const tick = () => new Promise((r) => setTimeout(r, 5));
const errors = [];
window.addEventListener('error', (e) => errors.push('window error: ' + (e.error && e.error.message)));
process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e && e.message)));

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function clickText(text, root = document) {
  const b = $all('button', root).find((x) => x.textContent.trim().includes(text));
  if (!b) throw new Error('button not found: ' + text);
  b.click(); return b;
}
function setInput(inp, val) {
  inp.value = val;
  inp.dispatchEvent(new window.Event('input', { bubbles: true }));
  inp.dispatchEvent(new window.Event('change', { bubbles: true }));
}
function drawSig(root = document) {
  const c = $('.sigpad-canvas', root);
  if (!c) return false;
  const down = new window.Event('pointerdown', { bubbles: true }); down.clientX = 10; down.clientY = 10; down.pointerId = 1; c.dispatchEvent(down);
  const mv = new window.Event('pointermove', { bubbles: true }); mv.clientX = 30; mv.clientY = 30; mv.pointerId = 1; c.dispatchEvent(mv);
  const up = new window.Event('pointerup', { bubbles: true }); up.pointerId = 1; c.dispatchEvent(up);
  return true;
}

const results = [];
const log = (ok, msg) => { results.push([ok, msg]); console.log((ok ? 'PASS ' : 'FAIL ') + msg); };

async function main() {
  // Boot the real app
  await import('../src/renderer/js/app.js');
  await tick();
  log(!!$('.auth-split') && !!$('.auth-form'), 'app boots to the two-panel sign-in screen');

  // ---- Drive the kiosk wizard (unauthenticated, like a real kiosk) ----
  currentUser = null;
  clickText('Start patient check-in'); // login.js kiosk button
  await tick();
  const gate = $('.kiosk-gate');
  log(!!gate, 'kiosk language gate renders');
  // choose English
  const enCard = $all('.lang-card').find((c) => /English/i.test(c.textContent));
  enCard.click();
  await tick();
  log(!!$('.kiosk-body'), 'wizard renders after language choice');

  // Step: Demographics — fill name + a couple fields
  let inputs = $all('.kiosk-body input');
  log(inputs.length > 0, 'demographics step has inputs (' + inputs.length + ')');
  log(!/Children by age group/i.test($('.kiosk-body').textContent), 'v1.4.9: demographics no longer asks about children');
  // first two text inputs are first/last name
  const textInputs = inputs.filter((i) => i.type === 'text' || !i.type);
  setInput(textInputs[0], 'Maria');
  setInput(textInputs[1], 'Lopez');
  // dob (v1.5.20: now required to advance)
  const dob = $all('.kiosk-body input').find((i) => i.type === 'date'); if (dob) setInput(dob, '1985-04-12');
  // v1.5.20: gender is now required to advance — select it.
  const genderSel = $all('.kiosk-body label.field').find((l) => /^Gender/i.test(((l.querySelector('.field-label') || {}).textContent || '').trim()));
  log(!!(genderSel && genderSel.querySelector('select')), 'v1.5.20: gender field present');
  if (genderSel) { const g = genderSel.querySelector('select'); if (g && g.options.length > 1) { g.value = g.options[1].value; g.dispatchEvent(new window.Event('change', { bubbles: true })); } }
  // v1.5.20: City + State collected at check-in (Sandy Oregon grant reporting).
  const bodyTxt = $('.kiosk-body').textContent;
  const fieldLabels = $all('.kiosk-body .field-label').map((s) => s.textContent.trim());
  log(fieldLabels.some((l) => /^City/.test(l)) && fieldLabels.some((l) => /^State/.test(l)), 'v1.5.20: check-in collects City and State');
  const setCityState = (re, val) => {
    const lbl = $all('.kiosk-body label.field').find((l) => re.test(((l.querySelector('.field-label') || {}).textContent || '').trim()));
    const inp = lbl && lbl.querySelector('input'); if (inp) setInput(inp, val); return !!inp;
  };
  // v1.5.22: City + State are required to advance — check the guard fires when
  // they are blank, before filling them in.
  const cityLbl = $all('.kiosk-body .field-label').map((s) => s.textContent.trim());
  log(cityLbl.some((l) => /^City\s*\*/.test(l)) && cityLbl.some((l) => /^State\s*\*/.test(l)),
    'v1.5.22: City + State marked required (*) at check-in');
  const stepsBefore = $('.kiosk-step-label').textContent;
  clickText('Next'); await tick();
  log($('.kiosk-step-label').textContent === stepsBefore, 'v1.5.22: check-in will not advance with City/State blank');
  setCityState(/^City/i, 'Sandy'); setCityState(/^State/i, 'OR');
  // v1.5.20: date of birth is marked required (*).
  log(/Date of birth\s*\*/.test(bodyTxt) && /Gender\s*\*/.test(bodyTxt), 'v1.5.20: date of birth + gender marked required (*)');
  // v1.0.6 F1-F3: phone + emergency contact name + phone are now required to advance.
  const fillField = (re, val) => {
    const lbl = $all('.kiosk-body label.field').find((l) => re.test(((l.querySelector('.field-label') || {}).textContent || '').trim()));
    const inp = lbl && lbl.querySelector('input');
    if (inp) setInput(inp, val);
    return !!inp;
  };
  log(fillField(/^Phone/i, '503-555-0100'), 'F1 phone field present (required)');
  log(fillField(/Emergency contact name/i, 'Jose Lopez'), 'F2 emergency contact name present (required)');
  log(fillField(/Emergency contact phone/i, '503-555-0199'), 'F3 emergency contact phone present (required)');
  // State is a dropdown now, not a text box — "OR" / "Oregon" / "ore" used to
  // land in the city/state report as three different places.
  const stateSel = $all('.kiosk-body label.field').find((l) => /^State/i.test(((l.querySelector('.field-label') || {}).textContent || '').trim()));
  const stateInput = stateSel && stateSel.querySelector('select');
  log(!!stateInput, 'state is a dropdown, not a typed field');
  log(!!stateInput && Array.from(stateInput.options).some((o) => o.value === 'OR' && /Oregon/.test(o.textContent)),
    'the state dropdown offers every state by name and code');
  if (stateInput) { stateInput.value = 'OR'; stateInput.dispatchEvent(new window.Event('change', { bubbles: true })); }

  // F4: referral dropdown
  const refSel = $all('.kiosk-body label.field').find((l) => /How did you hear/i.test(((l.querySelector('.field-label') || {}).textContent || '')));
  log(!!(refSel && refSel.querySelector('select')), 'F4 referral dropdown present');
  if (refSel) { const s = refSel.querySelector('select'); if (s && s.options.length > 1) { s.value = s.options[1].value; s.dispatchEvent(new window.Event('change', { bubbles: true })); } }
  clickText('Next');
  await tick();

  // Step: Medical history — Dr. Trinh's form (v0.0.15): every single-choice
  // question a dropdown, every list a set of chips, all of it required.
  log(/Medical|Historia/i.test($('.kiosk-step-label').textContent), 'on medical history step');
  const selIn = (re) => {
    const lbl = $all('.kiosk-body label.field').find((l) => re.test(((l.querySelector('.field-label') || {}).textContent || '').trim()));
    return lbl ? lbl.querySelector('select') : null;
  };
  const setSel = (sel, v) => { sel.value = v; sel.dispatchEvent(new window.Event('change', { bubbles: true })); };
  const condSel = (k) => $(`.kiosk-body .tri-row[data-key="${k}"] select`);
  // A chip grid is found by its own label, because the allergy and medication
  // lists share keys (aspirin, other) and a bare data-key would hit the wrong one.
  const gridBy = (re) => $all('.kiosk-body .field').find((f) => {
    const kids = Array.from(f.children);
    return kids.some((c) => c.classList.contains('chip-grid')) && kids.some((c) => c.classList.contains('field-label') && re.test(c.textContent));
  });
  const chipOf = (grid, key) => grid && grid.querySelector(`.chip-select[data-key="${key}"]`);
  const lastToast = () => { const all = $all('#toast-host .toast'); return all.length ? all[all.length - 1].textContent : ''; };
  const escRe = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const stillMedical = () => /Medical|Historia/i.test($('.kiosk-step-label').textContent);
  const refusedFor = async (name) => { clickText('Next'); await tick(); return stillMedical() && escRe(name).test(lastToast()); };

  const triRows = $all('.kiosk-body .tri-row');
  log(triRows.length === 25 && triRows.every((r) => r.querySelector('select')),
    'the 25 conditions are each a dropdown (' + triRows.length + ')');
  log(triRows.map((r) => r.dataset.key).join(',') === 'high_bp,diabetes,heart_disease,heart_attack,stroke,high_cholesterol,asthma,copd,kidney,liver,thyroid,cancer,epilepsy,bleeding,blood_clot,anemia,arthritis,osteoporosis,ulcers,mental_health,sleep_apnea,tuberculosis,hiv,autoimmune,pregnant',
    'the conditions are asked in Dr. Trinh\'s order');
  const optsOf = (sel) => Array.from(sel.options).map((o) => o.textContent).join('|');
  log(optsOf(condSel('diabetes')) === '—|Yes|No|Unsure', 'each condition offers —, Yes, No, Unsure');
  log(optsOf(condSel('pregnant')) === '—|Yes|No|Unsure|Not applicable',
    'only the pregnancy row adds Not applicable (a man or a child can answer it truthfully)');
  log(/Pregnancy \/ Possible Pregnancy/.test(triRows[24].textContent) && /Seizures \/ Epilepsy/.test(triRows[12].textContent),
    'the conditions carry Dr. Trinh\'s own wording');
  // v1.4.9: allergies / conditions / medications are required (labels marked *).
  log(/Medication allergies\s*\*/.test($('.kiosk-body').textContent), 'v1.4.9: allergies marked required (*)');
  const gateSel = selIn(/allergy or serious reaction/i);
  log(!!gateSel && optsOf(gateSel) === '—|No known drug allergies (NKDA)|Yes|Unsure',
    'the allergy question is a dropdown: NKDA, Yes or Unsure');
  const allergyGrid = gridBy(/^Medication allergies/);
  log(!!allergyGrid && allergyGrid.parentElement.style.display === 'none', 'the allergy checklist waits for a Yes');
  const allergyChipText = allergyGrid ? allergyGrid.textContent : '';
  log(/Sulfa antibiotics/.test(allergyChipText) && /Lidocaine \/ local anesthetic/.test(allergyChipText) && /Ibuprofen \/ Naproxen \/ NSAIDs/.test(allergyChipText)
    && allergyGrid.querySelectorAll('.chip-select').length === 25,
    'the allergy checklist is Dr. Trinh\'s 24 plus Other');
  log(!/Articaine|Novocain/i.test(allergyChipText), 'retired allergies (Articaine, Novocain) are no longer offered at check-in');
  const medGrid = gridBy(/^Current medications/);
  log(!!medGrid && medGrid.querySelectorAll('.chip-select').length === 27 && !!chipOf(medGrid, 'warfarin') && !!chipOf(medGrid, 'none'),
    'medications are his 25 as chips, plus Other and No medications');
  log(!!selIn(/^Major surgery within the past 6 months/) && !!selIn(/^Do you smoke\?/) && !!selIn(/under a doctor/),
    'major surgery, smoking and doctor\'s care are dropdowns');
  log(!selIn(/Hospitalized/i) && !/Hospitalized in the last 2 years/.test($('.kiosk-body').textContent),
    'the hospitalization question is gone (major surgery replaces it)');

  // Refused one question at a time, in the order the form asks them, and each
  // refusal names the question it wants.
  log(await refusedFor('Are you currently under a doctor’s care?'), 'medical step refuses Next by name: under a doctor’s care');
  setSel(selIn(/under a doctor/), 'no');
  log(await refusedFor('High Blood Pressure (Hypertension)'), 'medical step refuses Next by name: the first unanswered condition');
  triRows.forEach((r) => setSel(r.querySelector('select'), 'no'));
  setSel(condSel('diabetes'), 'yes');
  setSel(condSel('bleeding'), 'unsure');
  setSel(condSel('pregnant'), '');
  log(await refusedFor('Pregnancy / Possible Pregnancy'), 'medical step refuses Next by name: the pregnancy row');
  setSel(condSel('pregnant'), 'na');
  log(await refusedFor('Current medications'), 'medical step refuses Next by name: medications');
  // "No medications" is an answer ABOUT the list: it clears what is ticked,
  // and ticking a medication clears it — on screen, not silently at save.
  const litMeds = () => JSON.stringify($all('.chip-select--on', medGrid).map((b) => b.dataset.key));
  chipOf(medGrid, 'warfarin').click();
  chipOf(medGrid, 'none').click();
  log(litMeds() === '["none"]', '"No medications" clears a medication already ticked, on screen');
  chipOf(medGrid, 'aspirin').click();
  log(litMeds() === '["aspirin"]', 'ticking a medication clears "No medications", on screen');
  chipOf(medGrid, 'aspirin').click();
  chipOf(medGrid, 'warfarin').click();
  chipOf(medGrid, 'other').click();
  await tick();
  log(await refusedFor('Other medication'), 'ticking Other without typing a name is refused, by name');
  const otherMedInput = $('.kiosk-body .med-row input');
  log(!!otherMedInput && /^mmw-med-list-\d+$/.test(otherMedInput.getAttribute('list') || ''),
    'a typed medication still suggests from the clinic\'s 100 (per-form datalist)');
  setInput(otherMedInput, 'Fish oil');
  log(await refusedFor('Major surgery within the past 6 months?'), 'medical step refuses Next by name: major surgery');
  setSel(selIn(/^Major surgery/), 'yes');
  log(await refusedFor('If so, where?'), 'a Yes to major surgery requires where');
  chipOf(gridBy(/^If so, where/), 'knee').click();
  log(await refusedFor('Do you smoke?'), 'medical step refuses Next by name: Do you smoke?');
  setSel(selIn(/^Do you smoke/), 'no');
  log(await refusedFor('Do you have an allergy or serious reaction to any medication?'), 'medical step refuses Next by name: the allergy question');
  setSel(gateSel, 'yes');
  log(allergyGrid.parentElement.style.display !== 'none', 'a Yes reveals the allergy checklist');
  log(await refusedFor('Medication allergies'), 'a Yes to allergies requires at least one ticked');
  chipOf(allergyGrid, 'penicillin').click();
  chipOf(allergyGrid, 'other').click();
  log(await refusedFor('Other allergy'), 'an Other allergy requires the name typed');
  const allergyOtherInput = $all('.kiosk-body label.field').find((l) => /Other allergy/.test(l.textContent)).querySelector('input');
  setInput(allergyOtherInput, 'Latex gloves');
  clickText('Next');
  await tick();

  // Step: Dental history
  log(/Dental/i.test($('.kiosk-step-label').textContent), 'on dental history step');
  log(!/long-term dental goals/i.test($('.kiosk-body').textContent) && !/cosmetic/i.test($('.kiosk-body').textContent), 'v1.4.9: dental step no longer asks long-term goals / cosmetic interest');
  // C2: the free-text "Reason for today's visit" box is gone — "What do you need
  // today?" below asks the same thing in a form a report can count.
  log(!$('.kiosk-body textarea'), 'C2: dental step no longer has a free-text reason box');
  log(!/Reason for today/i.test($('.kiosk-body').textContent), 'C2: "Reason for today\'s visit" is not asked anywhere on the step');
  // C2: "when did you last see a dentist" is a closed dropdown, not free text.
  const priorSel = $all('.kiosk-body select').find((x) => Array.from(x.options).some((o) => /6 months|1 year|Never/i.test(o.textContent)));
  log(!!priorSel, 'C2: last-dental-visit is a dropdown');
  log(!!priorSel && Array.from(priorSel.options).some((o) => /Never/i.test(o.textContent)),
    'C2: the dropdown can record a patient who has never seen a dentist');
  // C2: every dental question is required, and the refusal names which one.
  clickText('Next');
  await tick();
  log(/Dental/i.test($('.kiosk-step-label').textContent), 'C2: Next is refused while a dental answer is missing');
  if (priorSel) { priorSel.value = 'about_2_years'; priorSel.dispatchEvent(new window.Event('change', { bubbles: true })); }
  // Step 3 is Dr. Trinh's eight questions, each a Yes / No dropdown.
  const DENT_Q = ['Any pain when drinking cold water?', 'Any pain when drinking hot water?', 'Any pain when eating?',
    'Does the toothache wake you up at night?', 'Any pain upon touching?', 'Do you clench or grind your teeth at night?',
    'Do you wake up with jaw pain?', 'Do you notice any lump or sores in your mouth?'];
  const dentSels = DENT_Q.map((q) => selIn(escRe(q)));
  log(dentSels.every((x) => x && optsOf(x) === '—|Yes|No'), 'Step 3 asks Dr. Trinh\'s eight questions, each a Yes / No dropdown');
  log(!/Do your gums bleed|braces or orthodontics|History of bleeding after a tooth/i.test($('.kiosk-body').textContent),
    'Step 3 no longer asks the six questions it replaced');
  for (let i = 0; i < DENT_Q.length; i++) {
    clickText('Next'); await tick();
    log(/Dental/i.test($('.kiosk-step-label').textContent) && escRe(DENT_Q[i]).test(lastToast()), 'dental step refuses Next by name: ' + DENT_Q[i]);
    setSel(dentSels[i], i === 0 ? 'yes' : 'no');
  }
  // v1.4.9: choose a visit type on the required 1–4 scale. Pick 3 = Filling so no
  // surgery consent is added (keeps this drive on the existing review path).
  const vrange = $('.visit-range');
  log(!!vrange, 'dental step has the 1–4 visit-type scale');
  const vticks = $all('.kiosk-body .highlight-field button');
  log(vticks.length === 4, 'visit-type scale offers 4 options (' + vticks.length + ')');
  // v1.5.26: the slider parks on 1 before anything is chosen, so sliding TO 1
  // changes nothing and fires no 'input' event. The patient was then refused at
  // Next for an answer they thought they had given. Any interaction now commits.
  log(vrange.style.opacity === '0.45', 'v1.5.26: the scale looks unset until a choice is made');
  vrange.value = '1';
  vrange.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  log(/1\./.test($('.visit-desc').textContent) && vrange.style.opacity === '1',
    'v1.5.26: tapping the scale on option 1 registers the choice (no silent rejection)');
  if (vrange) { vrange.value = '3'; vrange.dispatchEvent(new window.Event('input', { bubbles: true })); }
  clickText('Next');
  await tick();

  // Step: General consent — agree + signer + signature
  log(/Consent|Consentimiento/i.test($('.kiosk-step-label').textContent), 'on consent step');
  log(/Mission Minded Worldwide \(MMW\)/i.test($('.kiosk-body').textContent) && /patient waiver/i.test($('.kiosk-body').textContent) && /501\(c\)3/i.test($('.kiosk-body').textContent), 'general consent shows the full MMW wording at check-in');
  const agree = $('.big-check'); if (agree) { agree.checked = true; agree.dispatchEvent(new window.Event('change', { bubbles: true })); }
  // v0.0.4: the consent carries a required YES/NO for the HIV / Hepatitis
  // deemed notice, exactly as the printed MMW consent does. Answer it.
  const deemedYes = $('.deemed-field .chip-btn'); if (deemedYes) deemedYes.click();
  const signer = $all('.kiosk-body input').find((i) => /name/i.test(i.placeholder || '') || true);
  // signer is the first text input on consent step
  const consentInputs = $all('.kiosk-body input').filter((i) => i.type === 'text' || !i.type);
  if (consentInputs[0]) setInput(consentInputs[0], 'Maria Lopez');
  drawSig();
  clickText('Next');
  await tick();

  // C3: there is no "who would you like to see?" step any more — the station is
  // derived from what the patient said they need on the dental step.
  log(!$('.route-card'), 'C3: the standalone dentist/hygienist chooser is gone from intake');

  // "Step 5 — remove entire step" (v0.0.15): registration asks no survey
  // question any more; the whole grant survey is asked at check-out. So the
  // consent step leads straight to Sign & Submit, and a Filling visit is five
  // steps: About You, Medical, Dental, Consent, Sign & Submit.
  log(!$('.survey-inline') && !$('.kiosk-body .survey-q'), 'registration no longer carries a survey step');
  // Now should be Review (may_need_extraction was not 'yes')
  const onReview = /Sign|Review|Firmar|Send|Submit/i.test($('.kiosk-step-label') ? $('.kiosk-step-label').textContent : '');
  log(!!$('.review') || onReview, 'reached review/sign step');
  log(/Step 5 of 5/.test($('.kiosk-step-label').textContent), 'the consent step leads straight to Sign & Submit (5 steps on a filling visit)');
  const reviewTxt = $('.review') ? $('.review').textContent : '';
  log(!/Community questions/.test(reviewTxt), 'the review no longer reports "community questions"');
  log(/Penicillin/.test(reviewTxt) && /Latex gloves/.test(reviewTxt), 'the review reads back the allergies, a typed-in one included');
  log(/Diabetes/.test(reviewTxt) && /Unsure/.test(reviewTxt) && /Bleeding Disorder/.test(reviewTxt),
    'the review reads back the conditions answered Yes and those the patient was unsure of');
  log(/Warfarin \(Coumadin\)/.test(reviewTxt) && /Fish oil/.test(reviewTxt), 'the review reads back every medication');
  log(/Knee/.test(reviewTxt) && /Sandy, OR/.test(reviewTxt), 'the review reads back the surgery site and the town');
  // Submit
  const submitBtn = $all('.kiosk-nav button').find((b) => /Submit|Send|Enviar/i.test(b.textContent)) || $all('.kiosk-nav button').pop();
  submitBtn.click();
  await tick(); await tick();

  log(!!$('.kiosk-thanks'), 'thank-you screen shown after submit');

  // ---- Verify the patient persisted with full history ----
  const all = db.listPatients({ eventId: 'all' });
  const created = all.find((p) => p.last_name === 'Lopez');
  log(!!created, 'patient persisted (' + (created ? created.first_name + ' ' + created.last_name : 'NONE') + ')');
  if (created) {
    const full = db.getPatient(created.id);
    const mhK = full.medical_history;
    log(full.first_name === 'Maria', 'demographics captured: first_name=' + full.first_name);
    log(mhK.history_version === 2 && mhK.allergy_status === 'yes', 'the history is stored as Dr. Trinh\'s form (history_version 2)');
    log((mhK.allergies || []).includes('penicillin') && (mhK.allergies || []).includes('other') && mhK.allergies_other === 'Latex gloves',
      'medical allergies captured: ' + JSON.stringify(mhK.allergies) + ' + ' + mhK.allergies_other);
    log((mhK.conditions || []).includes('diabetes') && !(mhK.conditions || []).includes('none'),
      'medical conditions captured (derived from the Yes answers): ' + JSON.stringify(mhK.conditions));
    log(Object.keys(mhK.condition_answers || {}).length === 25 && mhK.condition_answers.bleeding === 'unsure',
      'every one of the 25 conditions carries its own answer, Unsure included');
    log(JSON.stringify((mhK.medications || []).map((x) => [x.key, x.name])) === JSON.stringify([['warfarin', 'Warfarin (Coumadin)'], ['other', 'Fish oil']]),
      'medications are stored by checklist key with the canonical name, a typed one as Other');
    log(mhK.major_surgery === 'yes' && JSON.stringify(mhK.surgery_sites) === '["knee"]', 'major surgery and its site are stored');
    // C2: reason is no longer collected; the closed last-dental-visit answer is
    // what the step now has to capture.
    log(full.dental_history.reason === undefined, 'C2: no reason is stored for a new patient');
    // Registration files no survey row at all: check-out creates it, asking
    // all 34 questions.
    log(db.getExitSurvey(created.id) == null, 'survey: registration files no survey row (check-out asks the whole survey)');
    log(full.dental_history.prior_dentist === 'about_2_years',
      'C2: the last-dental-visit answer is stored as a code, not prose (' + full.dental_history.prior_dentist + ')');
    log(['pain_cold', 'pain_hot', 'pain_eating', 'toothache_night', 'pain_touch', 'grinding_night', 'jaw_pain_waking', 'sores']
      .every((k) => full.dental_history[k] === 'yes' || full.dental_history[k] === 'no') && full.dental_history.pain_cold === 'yes',
      'every Step 3 question is answered on a submitted record');
    log(['gum_bleeding', 'jaw_injury', 'grinding', 'post_extraction_bleeding', 'ortho'].every((k) => full.dental_history[k] === undefined),
      'the retired Step 3 questions are not written for a new patient');
    // The walk-in record now carries the same complete history the online form
    // has always insisted on — a blank is not a "no", and the dentist reads
    // these before deciding whether it is safe to treat.
    log(['under_treatment', 'major_surgery', 'tobacco']
      .every((k) => mhK[k] === 'yes' || mhK[k] === 'no') && mhK.hospitalized === undefined && mhK.pregnancy === undefined,
      'every medical yes/no question is answered on a submitted record (and the retired ones are not written)');
    log(mhK.condition_answers.pregnant === 'na',
      'a "Not applicable" pregnancy answer is stored as an answer, not left blank (' + mhK.condition_answers.pregnant + ')');
    log(full.demographics.city === 'Sandy', 'the town is stored as typed when the event has no city list');
    // C3: the station was derived from the visit type, with nobody asked.
    log(full.triage && full.triage.route === 'dentist',
      'C3: choosing Filling routed the patient to the dentist automatically');
    log(full.dental_history.visit_type === 'filling' && full.dental_history.may_need_extraction === 'no', 'v1.4.9: visit-type scale captured (filling → no surgery consent)');
    log((full.consents || []).length > 0, 'consent captured: ' + (full.consents || []).length + ' consent(s)');
    // v1.2.0: patient chose a provider at check-in; vitals are NOT collected here.
    log(full.triage && full.triage.route === 'dentist', 'A4: check-in provider choice stored (route=' + (full.triage && full.triage.route) + ')');
    log(full.status === 'checked_in', 'B1: new check-in stays checked_in (EMT queue only)');
    log(mhK.bp_systolic == null, 'A2: vitals NOT collected at patient check-in');

    // ---- Render the clinician views and check history appears ----
    currentUser = signInAdmin();
    const { renderRecords } = await import('../src/renderer/js/views/records.js');
    const ctx = { navigate: () => {}, toast: () => {}, store: (await import('../src/renderer/js/store.js')).store };
    ctx.store.setUser(currentUser);
    const recRoot = renderRecords(ctx, { id: created.id });
    document.body.append(recRoot);
    await tick(); await tick();
    const recText = recRoot.textContent;
    log(/About 2 years ago/i.test(recText), 'C2: the records view shows the last-dental-visit answer as a readable label');
    log(/Pregnancy[^]*Not applicable/i.test(recText) && !/>na</.test(recRoot.innerHTML),
      'records view reads a not-applicable pregnancy answer back in words, not as the stored code');
    log(/Diabetes/i.test(recText), 'records view shows condition');
    log(/Penicillin/i.test(recText) && /Latex gloves/.test(recText), 'records view shows allergy, a typed-in one included');
    log(/Pain with cold water/.test(recText), 'records view shows the Step 3 answers by their chart labels');
  }

  // ---- Smoke render the other views to catch runtime errors ----
  // Always run authenticated so a kiosk regression can't mask real view errors.
  currentUser = signInAdmin();
  // v1.0.9: the triage view is unregistered from the app shell (station removed).
  const views = ['dashboard', 'provider', 'reports', 'admin', 'emt', 'checkout', 'hygienist', 'management'];
  for (const v of views) {
    try {
      const mod = await import('../src/renderer/js/views/' + v + '.js');
      const fn = mod['render' + v[0].toUpperCase() + v.slice(1)];
      const store = (await import('../src/renderer/js/store.js')).store;
      store.setUser(currentUser);
      const ctx = { navigate: () => {}, toast: () => {}, store };
      const node = fn(ctx, {});
      document.body.append(node);
      await tick(); await tick();
      log(true, 'view renders without throwing: ' + v);
    } catch (e) {
      log(false, 'view THREW: ' + v + ' -> ' + e.message);
    }
  }

  // ---- Permission tests (the role-gate that broke check-in) ----
  currentUser = signInAdmin();
  db.createUser(currentUser, { username: 'docx', full_name: 'Dr X', role: 'doctor', password: 'x' });
  let pr = await window.api.authLogin({ username: 'docx', password: 'x' });
  log(pr.ok && pr.data.role === 'doctor', 'can sign in as a doctor');
  pr = await window.api.patientsCreate({ first_name: 'Walkin', last_name: 'Patient', demographics: {}, medical_history: {}, dental_history: { reason: 'pain' }, consents: [] });
  log(pr.ok, 'DOCTOR can complete a check-in (the reported bug): ' + (pr.ok ? 'allowed' : pr.error));
  pr = await window.api.usersList();
  log(!pr.ok && /permission/i.test(pr.error || ''), 'permission guard works: doctor blocked from staff list');
  // triage role can also check in
  currentUser = signInAdmin(); db.createUser(currentUser, { username: 'trix', full_name: 'Front', role: 'triage', password: 'x' });
  await window.api.authLogin({ username: 'trix', password: 'x' });
  pr = await window.api.patientsCreate({ first_name: 'Tri', last_name: 'Age', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
  log(pr.ok, 'TRIAGE can complete a check-in: ' + (pr.ok ? 'allowed' : pr.error));
  // v1.0.6 roles: EMT records vitals; CHECKOUT dismisses a signed-off patient.
  currentUser = signInAdmin(); db.createUser(currentUser, { username: 'emtx', full_name: 'EMT One', role: 'emt', password: 'x' });
  db.createUser(currentUser, { username: 'cox', full_name: 'Checkout One', role: 'checkout', password: 'x' });
  const vp = db.createPatient(currentUser, { first_name: 'Vital', last_name: 'Test', demographics: {}, medical_history: {}, dental_history: {} });
  await window.api.authLogin({ username: 'emtx', password: 'x' });
  pr = await window.api.vitalsSave({ patientId: vp.id, data: { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' } });
  log(pr.ok, 'EMT can record vitals: ' + (pr.ok ? 'allowed' : pr.error));
  // v1.0.8: EMT confirms blood thinners after vitals; a plain re-save must not wipe it.
  pr = await window.api.vitalsSave({ patientId: vp.id, data: { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70', blood_thinner: 'yes', blood_thinner_detail: 'Eliquis' } });
  log(pr.ok && pr.data.triage.blood_thinner === 'yes' && pr.data.triage.blood_thinner_detail === 'Eliquis', 'EMT records blood-thinner answer (persists): ' + (pr.ok ? pr.data.triage.blood_thinner : pr.error));
  pr = await window.api.vitalsSave({ patientId: vp.id, data: { bp_systolic: '118', bp_diastolic: '78', heart_rate: '66' } });
  log(pr.ok && pr.data.triage.blood_thinner === 'yes', 'plain vitals re-save keeps the blood-thinner answer');

  // ---- v1.0.9: EMT routes the patient after vitals (triage station removed) ----
  pr = await window.api.patientsRoute({ patientId: vp.id, route: 'dentist' });
  log(pr.ok && pr.data.status === 'triaged' && pr.data.triage.route === 'dentist', 'EMT routes to dentist -> patient enters dentist queue (triaged): ' + (pr.ok ? 'ok' : pr.error));
  let listed = db.listPatients({}).find((x) => x.id === vp.id);
  log(listed && listed.route === 'dentist' && ['triaged', 'in_treatment'].includes(listed.status), 'routed patient appears in the dentist queue filter with route exposed');
  const hp = db.createPatient(signInAdmin(), { first_name: 'Clean', last_name: 'Route', demographics: {}, medical_history: {}, dental_history: {} });
  await window.api.authLogin({ username: 'emtx', password: 'x' });
  // v1.5.24: vitals are a hard gate — routing without them is refused.
  const noVitalsRoute = await window.api.patientsRoute({ patientId: hp.id, route: 'hygienist' });
  log(!noVitalsRoute.ok && /vitals/i.test(noVitalsRoute.error), 'v1.5.24: routing a patient with no vitals is refused');
  await window.api.vitalsSave({ patientId: hp.id, data: { bp_systolic: '118', bp_diastolic: '74', heart_rate: '66' } });
  pr = await window.api.patientsRoute({ patientId: hp.id, route: 'hygienist' });
  log(pr.ok && pr.data.triage.route === 'hygienist', 'EMT routes a second patient to the hygienist');
  pr = await window.api.patientsRoute({ patientId: hp.id, route: 'nowhere' });
  log(!pr.ok, 'invalid route rejected: ' + (pr.ok ? 'NOT REJECTED' : 'rejected'));
  // hygienist role cannot route (routing is the EMT/doctor station's job)
  currentUser = signInAdmin();
  db.createUser(currentUser, { username: 'hygroute', full_name: 'Hyg Route', role: 'hygienist', password: 'x' });
  await window.api.authLogin({ username: 'hygroute', password: 'x' });
  pr = await window.api.patientsRoute({ patientId: hp.id, route: 'dentist' });
  log(!pr.ok && /permission/i.test(pr.error || ''), 'HYGIENIST blocked from routing (guard): ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));
  pr = await window.api.usersList();
  log(!pr.ok, 'EMT blocked from staff list (guard): ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));
  // checkout dismiss: a locked (signed-off) patient can be dismissed
  currentUser = signInAdmin(); db.saveTreatment(currentUser, vp.id, { provider_name: 'Dr', provider_signature: 'data:,s' }, true);
  await window.api.authLogin({ username: 'cox', password: 'x' });
  pr = await window.api.patientsDismiss(vp.id);
  log(pr.ok && pr.data.status === 'dismissed', 'CHECKOUT can dismiss a signed-off patient: ' + (pr.ok ? 'allowed' : pr.error));

  // ---- v1.2.1: patients move through WITHOUT a forced sign-off/lock ----
  currentUser = signInAdmin();
  const flowP = db.createPatient(currentUser, { first_name: 'Flow', last_name: 'Through', demographics: {}, medical_history: {}, dental_history: {}, route: 'dentist' });
  db.saveVitals(currentUser, flowP.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
  db.routePatient(currentUser, flowP.id, 'dentist');
  // provider marks the visit COMPLETE without locking (mode 'complete')
  let mc = db.saveTreatment(currentUser, flowP.id, { fillings: [{ tooth: '14' }], provider_name: 'Dr A' }, 'complete');
  log(mc.status === 'completed' && !mc.treatment.locked, 'v1.2.1: "Mark visit complete" completes the visit WITHOUT locking (record stays editable)');
  // the still-unlocked record can still be edited (no lock throw)
  let ed = db.saveTreatment(currentUser, flowP.id, { fillings: [{ tooth: '14' }, { tooth: '19' }], provider_name: 'Dr A' }, 'complete');
  log(ed.treatment.fillings.length === 2, 'v1.2.1: a completed-but-unlocked record is still editable between stations');
  // checkout can dismiss the completed (unlocked) patient — no lock required
  await window.api.authLogin({ username: 'cox', password: 'x' });
  pr = await window.api.patientsDismiss(flowP.id);
  log(pr.ok && pr.data.status === 'dismissed', 'v1.2.1: CHECKOUT dismisses a completed patient with NO lock required: ' + (pr.ok ? 'allowed' : pr.error));
  // v1.2.1: the optional lock still works and makes the record read-only
  currentUser = signInAdmin();
  const lockP = db.createPatient(currentUser, { first_name: 'Lock', last_name: 'Opt', demographics: {}, medical_history: {}, dental_history: {}, route: 'dentist' });
  db.saveVitals(currentUser, lockP.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '66' });
  db.routePatient(currentUser, lockP.id, 'dentist');
  let lk = db.saveTreatment(currentUser, lockP.id, { provider_name: 'Dr B', provider_signature: 'data:,s' }, 'lock');
  let lockedThrew = false; try { db.saveTreatment(currentUser, lockP.id, { provider_name: 'Dr B' }, 'complete'); } catch (e) { lockedThrew = /locked/i.test(e.message); }
  log(lk.treatment.locked && lockedThrew, 'v1.2.1: optional lock still finalizes a read-only record when chosen');
  // guard: a patient still at check-in (not seen by EMT) cannot be dismissed
  currentUser = signInAdmin();
  const rawP = db.createPatient(currentUser, { first_name: 'Not', last_name: 'Seen', demographics: {}, medical_history: {}, dental_history: {} });
  await window.api.authLogin({ username: 'cox', password: 'x' });
  pr = await window.api.patientsDismiss(rawP.id);
  log(!pr.ok && /EMT|nurse|vitals/i.test(pr.error || ''), 'v1.2.1: a checked-in (unseen) patient still cannot be dismissed: ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));

  // ---- REGISTRATION role: front-desk check-in only, into the queue ----
  currentUser = signInAdmin();
  const reg = db.createUser(currentUser, { username: 'regx', full_name: 'Reg One', role: 'registration', password: 'x' });
  log(reg.role === 'registration', 'registration role can be created (CHECK widened, existing accounts intact)');
  await window.api.authLogin({ username: 'regx', password: 'x' });
  pr = await window.api.patientsCreate({ first_name: 'Front', last_name: 'Desk', demographics: {}, medical_history: {}, dental_history: { reason: 'checkup' }, consents: [] });
  log(pr.ok, 'REGISTRATION can complete a check-in: ' + (pr.ok ? 'allowed' : pr.error));
  const regMade = pr.ok ? db.getPatient(pr.data.id) : null;
  log(!!regMade && regMade.status === 'checked_in', 'REGISTRATION check-in enters the queue (status=checked_in)');
  pr = await window.api.patientsList({});
  log(pr.ok, 'REGISTRATION can see the patient list (dashboard queue): ' + (pr.ok ? 'allowed' : pr.error));
  pr = await window.api.usersList();
  log(!pr.ok && /permission/i.test(pr.error || ''), 'REGISTRATION blocked from staff list (guard): ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));
  pr = await window.api.patientsDismiss(regMade ? regMade.id : 0);
  log(!pr.ok && /permission/i.test(pr.error || ''), 'REGISTRATION cannot dismiss patients (guard): ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));

  // ---- v1.0.7: HYGIENIST role + event-scoped staff ----
  currentUser = signInAdmin();
  const hyg = db.createUser(currentUser, { username: 'hygx', full_name: 'Hyg One', role: 'hygienist', password: 'x' });
  log(hyg.role === 'hygienist', 'hygienist role can be created (CHECK widened, existing accounts intact)');
  const activeEv = await window.api.eventsActive();
  log(hyg.event_id === (activeEv.data ? activeEv.data.id : null), 'new clinical staff scoped to the active event');
  const cp = db.createPatient(currentUser, { first_name: 'Clean', last_name: 'Only', demographics: {}, medical_history: {}, dental_history: {} });
  await window.api.authLogin({ username: 'hygx', password: 'x' });
  pr = await window.api.treatmentSave({ patientId: cp.id, data: { cleaning: { adult_prophy: true, teeth: ['3', '14'] } }, finalize: false });
  log(pr.ok, 'HYGIENIST can save a cleaning: ' + (pr.ok ? 'allowed' : pr.error));
  pr = await window.api.usersList();
  log(!pr.ok && /permission/i.test(pr.error || ''), 'HYGIENIST blocked from staff list (guard): ' + (pr.ok ? 'NOT BLOCKED' : 'blocked'));
  // Clear-event-staff removes scoped clinical staff but keeps the admin.
  currentUser = signInAdmin();
  const evId = (activeEv.data ? activeEv.data.id : Number(db.getSetting('active_event_id')));
  const before = db.listUsers().length;
  pr = await window.api.usersClearEventStaff(evId);
  const remaining = db.listUsers();
  log(pr.ok && pr.data.deleted > 0, 'ADMIN can clear event staff: removed ' + (pr.ok ? pr.data.deleted : '?'));
  log(remaining.some((u) => u.role === 'admin') && !remaining.some((u) => u.username === 'hygx'), 'clear keeps admin, removes scoped staff');

  // ---- BP alert: the reading turns red when systolic > 180 OR diastolic > 100 ----
  {
    const { bpStatus } = await import('../src/renderer/js/medFlags.js');
    log(bpStatus(181, 80).high && bpStatus(181, 80).sysHigh, 'BP: systolic 181 flags high');
    log(!bpStatus(180, 80).high, 'BP: systolic exactly 180 is NOT high (strictly over)');
    log(bpStatus(120, 101).high && bpStatus(120, 101).diaHigh, 'BP: diastolic 101 flags high');
    log(!bpStatus(120, 100).high, 'BP: diastolic exactly 100 is NOT high (strictly over)');
    log(!bpStatus(120, 80).high, 'BP: a normal 120/80 reading is not high');
    log(bpStatus('190', '70').high, 'BP: string values are coerced (190/70 → high)');
    log(!bpStatus('', null).high && !bpStatus(null, null).high && !bpStatus('abc', 'x').high, 'BP: blank / omitted / non-numeric reading is never high');
  }
  {
    currentUser = signInAdmin();
    const store2 = (await import('../src/renderer/js/store.js')).store; store2.setUser(currentUser);
    const ctx2 = { navigate: () => {}, toast: () => {}, store: store2, setDetail: () => {} };
    const hiP = db.createPatient(currentUser, { first_name: 'High', last_name: 'Pressure', demographics: {}, medical_history: {}, dental_history: { reason: 'x' }, route: 'dentist' });
    db.saveVitals(currentUser, hiP.id, { bp_systolic: '190', bp_diastolic: '105', heart_rate: '88' });
    db.routePatient(currentUser, hiP.id, 'dentist');
    const okP = db.createPatient(currentUser, { first_name: 'Normal', last_name: 'Pressure', demographics: {}, medical_history: {}, dental_history: { reason: 'x' }, route: 'dentist' });
    db.saveVitals(currentUser, okP.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '70' });
    db.routePatient(currentUser, okP.id, 'dentist');

    const { renderEmt } = await import('../src/renderer/js/views/emt.js');
    const emtHi = renderEmt(ctx2, { id: hiP.id }); document.body.append(emtHi); await tick(); await tick();
    log(/High blood pressure/i.test(emtHi.textContent), 'BP/EMT: high-BP patient shows the red high-BP warning');
    const emtOk = renderEmt(ctx2, { id: okP.id }); document.body.append(emtOk); await tick(); await tick();
    const okWarn = $all('.banner--alert', emtOk).find((n) => /High blood pressure/i.test(n.textContent));
    log(!okWarn || okWarn.style.display === 'none', 'BP/EMT: normal-BP patient does NOT show the high-BP warning');

    const { renderProvider } = await import('../src/renderer/js/views/provider.js');
    const provHi = renderProvider(ctx2, { id: hiP.id }); document.body.append(provHi); await tick(); await tick();
    log(/BP 190\/105 — HIGH/.test(provHi.textContent), 'BP/Dentist: high-BP handoff shows "BP 190/105 — HIGH"');
    log(!!$all('.pill--danger', provHi).find((n) => /BP 190\/105/.test(n.textContent)), 'BP/Dentist: high BP is rendered as a red danger pill');
    const provOk = renderProvider(ctx2, { id: okP.id }); document.body.append(provOk); await tick(); await tick();
    log(/BP 118\/76/.test(provOk.textContent) && !/BP 118\/76 — HIGH/.test(provOk.textContent), 'BP/Dentist: normal BP is shown without a HIGH marker');

    const pdf = require('../src/main/pdf.js');
    const htmlHiFull = pdf.buildHtml(db.getPatient(hiP.id), 'full');
    const htmlHiProg = pdf.buildHtml(db.getPatient(hiP.id), 'progress');
    log(/color:#c0392b/.test(htmlHiFull) && /HIGH/.test(htmlHiFull), 'BP/PDF: full record colours a high reading red');
    log(/color:#c0392b/.test(htmlHiProg), 'BP/PDF: progress note colours a high reading red');
    const htmlOkFull = pdf.buildHtml(db.getPatient(okP.id), 'full');
    log(!/color:#c0392b/.test(htmlOkFull) && /BP 118\/76/.test(htmlOkFull), 'BP/PDF: a normal reading is not coloured red');
  }

  // ---- v1.4.4: staff accounts are SYNCED so a team created on one laptop shows
  //               up on every laptop. Guard that 'user' is a syncable entity. ----
  currentUser = signInAdmin();
  db.createUser(currentUser, { username: 'syncme', full_name: 'Sync Me', role: 'doctor', password: 'x' });
  const syncRows = db.collectSyncRows(1000).rows;
  const userRow = syncRows.find((r) => r.entity === 'user' && r.data && r.data.username === 'syncme');
  log(!!userRow, 'v1.4.4: staff accounts are collected as syncable rows (user entity present)');
  log(!!userRow && userRow.data.role === 'doctor' && !!userRow.data.hash, 'v1.4.4: synced staff carry role + password hash so the account works on other laptops');
  log(!!userRow && userRow.event_uid != null, 'v1.4.4: event-scoped staff carry their event so scoping survives the sync');
  const adminRow = syncRows.find((r) => r.entity === 'user' && r.data && r.data.username === 'admin');
  log(!adminRow || adminRow.uid === '00000000-0000-4000-8000-000000000002', 'v1.4.4: bootstrap admin uses the shared cloud identity (converges, no per-laptop duplicate)');

  // ---- v1.4.6: the active-event SELECTION syncs (stamped on the event row) so a
  //               "Set active" on one laptop reaches every laptop. ----
  currentUser = signInAdmin();
  const evSel = db.createEvent(currentUser, { name: 'Sync Event', location: 'X', languages: 'en' });
  db.setActiveEvent(currentUser, evSel.id);
  log(db.getActiveEvent().id === evSel.id, 'v1.4.6: Set active selects the event on this device');
  const evRow = db.collectSyncRows(2000).rows.find((r) => r.entity === 'event' && r.data && r.data.name === 'Sync Event');
  log(!!evRow && !!evRow.data.selected_at, 'v1.4.6: the active-event selection (selected_at) is a synced field so it reaches other laptops');

  // ---- v1.4.7: consent wording, chairside consent capture, treatment gate,
  //               phone digits, and BP re-checks. ----
  {
    const { CATALOG } = await import('../src/renderer/i18n/strings.js');
    const i18nMod = await import('../src/renderer/js/i18n.js');
    // MMW's printed consents: 7 clauses in the health-care application and 7
    // paragraphs of oral surgery. Also assert the two details that make them
    // MMW's rather than a generic consent — the org name and the post-op number.
    log((CATALOG.en.consent.generalFull || []).length === 7
      && (CATALOG.en.consent.oralSurgeryFull || []).length === 7
      && CATALOG.en.consent.oralSurgeryFull.join(' ').includes('Mission Minded Worldwide (MMW)')
      && CATALOG.en.consent.oralSurgeryFull.join(' ').includes('(951) 317-4968'),
      'MMW general (7) + oral-surgery (7) consent wording present in English');
    i18nMod.setLang('en');
    log(Array.isArray(i18nMod.tRaw('consent.generalFull')), 'v1.4.7: English defines the full consent text (tRaw)');
    i18nMod.setLang('es');
    log(i18nMod.tRaw('consent.generalFull') === undefined && Array.isArray(i18nMod.t('consent.generalFull')), 'v1.4.7: other languages keep their own consent (tRaw undefined; t falls back to English)');
    i18nMod.setLang('en');

    currentUser = signInAdmin();
    // Chairside oral-surgery consent with tooth numbers (dentist station).
    const cp = db.createPatient(currentUser, { first_name: 'Chair', last_name: 'Side', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
    const afterAdd = db.addPatientConsent(currentUser, cp.id, { type: 'oral_surgery', signer_name: 'Chair Side', tooth_numbers: '18, 19', signature_png: 'data:,sig' });
    const os = (afterAdd.consents || []).find((c) => c.type === 'oral_surgery');
    log(!!os && os.tooth_numbers === '18, 19', 'v1.4.7: dentist can capture an oral-surgery consent chairside WITH tooth numbers');
    log(db.collectSyncRows(3000).rows.some((r) => r.entity === 'consent' && r.data && r.data.tooth_numbers === '18, 19'), 'v1.4.7: a chairside consent is a syncable row (reaches other laptops)');

    // BP re-checks: stored, capped at 2, preserved by a plain re-save.
    const bpp = db.createPatient(currentUser, { first_name: 'Re', last_name: 'Check', demographics: {}, medical_history: {}, dental_history: {} });
    db.saveVitals(currentUser, bpp.id, { bp_systolic: '190', bp_diastolic: '110', heart_rate: '88', bp_rechecks: [{ bp_systolic: '185', bp_diastolic: '105', heart_rate: '84' }, { bp_systolic: '176', bp_diastolic: '98', heart_rate: '80' }, { bp_systolic: '170', bp_diastolic: '95' }] });
    let bpFull = db.getPatient(bpp.id);
    log((bpFull.triage.bp_rechecks || []).length === 2, 'v1.4.7: up to 2 BP re-checks stored (extra dropped)');
    db.saveVitals(currentUser, bpp.id, { bp_systolic: '188', bp_diastolic: '108', heart_rate: '90' }); // plain re-save, no rechecks key
    log((db.getPatient(bpp.id).triage.bp_rechecks || []).length === 2, 'v1.4.7: a plain vitals re-save keeps the re-checks');
    // Synced JSON triage fields travel as JSON strings (like flags/emt_review).
    log(db.collectSyncRows(3000).rows.some((r) => {
      if (r.entity !== 'triage' || !r.data || r.data.bp_rechecks == null) return false;
      try { return JSON.parse(r.data.bp_rechecks).length === 2; } catch { return false; }
    }), 'v1.4.7: BP re-checks are a synced triage field');
    const rcPdf = require('../src/main/pdf.js').buildHtml(db.getPatient(bpp.id), 'full');
    log(/re-check/i.test(rcPdf), 'v1.4.7: BP re-checks appear in the record PDF');

    // Renders: EMT re-check affordance + provider consent panel + treatment gate.
    const store3 = (await import('../src/renderer/js/store.js')).store; store3.setUser(currentUser);
    const ctx3 = { navigate: () => {}, toast: () => {}, store: store3, setDetail: () => {} };
    const emtHi2 = (await import('../src/renderer/js/views/emt.js')).renderEmt(ctx3, { id: bpp.id }); document.body.append(emtHi2); await tick(); await tick();
    log(/Add another BP reading/i.test(emtHi2.textContent), 'v1.4.7: EMT offers extra BP readings when the reading is high');

    // Provider consent panel + gate: patient with NO general consent cannot be documented.
    db.saveVitals(currentUser, cp.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
    db.routePatient(currentUser, cp.id, 'dentist');
    const { renderProvider } = await import('../src/renderer/js/views/provider.js');
    const provNoConsent = renderProvider(ctx3, { id: cp.id }); document.body.append(provNoConsent); await tick(); await tick();
    log(/Consents/.test(provNoConsent.textContent) && /Complete now/i.test(provNoConsent.textContent), 'v1.4.7: dentist sees a Consents panel with a "Complete now" action for the missing general consent');
    const completeBtn = $all('button', provNoConsent).find((b) => /Mark visit complete/i.test(b.textContent));
    if (completeBtn) completeBtn.click();
    await tick(); await tick();
    log(db.getPatient(cp.id).status !== 'completed', 'v1.4.7: treatment is BLOCKED until the general consent is signed');
    // Now capture the general consent and confirm treatment can proceed.
    db.addPatientConsent(currentUser, cp.id, { type: 'general', signer_name: 'Chair Side', signature_png: 'data:,g' });
    const provWithConsent = renderProvider(ctx3, { id: cp.id }); document.body.append(provWithConsent); await tick(); await tick();
    const completeBtn2 = $all('button', provWithConsent).find((b) => /Mark visit complete/i.test(b.textContent));
    if (completeBtn2) completeBtn2.click();
    await tick(); await tick();
    log(db.getPatient(cp.id).status === 'completed', 'v1.4.7: once the general consent is signed, the dentist can document + complete the visit');
  }

  // ---- v1.4.8: allergy list — Novocain out (but a legacy Novocain allergy
  //               still shows on old records). v0.0.15: Dr. Trinh's list
  //               replaces it; Lidocaine stays (as "local anesthetic"),
  //               Articaine is retired the same way Novocain was. ----
  {
    const al = (await import('../src/renderer/js/i18n.js')).allergies();
    const art = al.find((a) => a.key === 'articaine');
    log(al.some((a) => a.key === 'lidocaine' && a.intake && /local anesthetic/i.test(a.label)) && !!art && art.intake === false && art.label === 'Articaine',
      'v0.0.15: Lidocaine (local anesthetic) is offered at check-in; a logged Articaine allergy still resolves by its old name');
    const nov = al.find((a) => a.key === 'novocain');
    log(!!nov && nov.intake === false && /Novocain/i.test(nov.label), 'v1.4.8: a legacy Novocain allergy still resolves for display but is not offered at check-in');
  }

  // ---- Health History: pain-management + weight-management program checkboxes ----
  {
    const cs = (await import('../src/renderer/js/i18n.js')).conditions();
    const pain = cs.find((c) => c.key === 'pain_mgmt');
    const weight = cs.find((c) => c.key === 'weight_mgmt');
    // v0.0.15: no longer asked (Dr. Trinh's 25 replace the checklist), but a
    // record that ticked them must still name them.
    log(!!pain && /pain management/i.test(pain.label) && pain.flag !== true && pain.intake === false, 'health history: "Pain management program" still resolves for display on an older record (retired, not a red flag)');
    log(!!weight && /weight management/i.test(weight.label) && weight.flag !== true && weight.intake === false, 'health history: "Weight management program" still resolves for display on an older record (retired, not a red flag)');
    // A patient can check them and they persist on the record.
    currentUser = signInAdmin();
    const hp = db.createPatient(currentUser, { first_name: 'Pat', last_name: 'Hh', demographics: {}, medical_history: { conditions: ['pain_mgmt', 'weight_mgmt'] }, dental_history: {}, consents: [] });
    log((db.getPatient(hp.id).medical_history.conditions || []).includes('pain_mgmt') && (db.getPatient(hp.id).medical_history.conditions || []).includes('weight_mgmt'), 'health history: the two program selections save on the patient record');
  }

  // ---- v1.5.14: dashboard live CRM board + clickable KPIs; reports dashboard ----
  {
    currentUser = signInAdmin();
    const store14 = (await import('../src/renderer/js/store.js')).store; store14.setUser(currentUser);
    let navTo = null;
    const ctx14 = { navigate: (v) => { navTo = v; }, toast: () => {}, store: store14, setDetail: () => {} };

    // Patients spread across the pipeline stages.
    const a = db.createPatient(currentUser, { first_name: 'Al', last_name: 'Aa', demographics: {}, medical_history: {}, dental_history: {}, consents: [] }); // checked in, no vitals
    const b = db.createPatient(currentUser, { first_name: 'Bo', last_name: 'Bb', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
    db.saveVitals(currentUser, b.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' }); // vitals in, not routed
    const c = db.createPatient(currentUser, { first_name: 'Cy', last_name: 'Cc', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
    db.saveVitals(currentUser, c.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '66' }); db.routePatient(currentUser, c.id, 'dentist'); // ready

    const dash = (await import('../src/renderer/js/views/dashboard.js')).renderDashboard(ctx14);
    document.body.append(dash); await tick(); await tick();
    const txt = dash.textContent;
    // v0.0.15: the dentist's station is Dental Triage, 'triaged' reads "Waiting
    // for provider", and the queue for a treatment chair has its own columns.
    const boardCols = Array.from(dash.querySelectorAll('.crm-col-label')).map((n) => n.textContent);
    log(JSON.stringify(boardCols) === JSON.stringify(['Checked in', 'Vitals', 'Waiting for provider', 'Hygienist', 'Dental Triage', 'Treatment waiting', 'In treatment', 'Checked out']),
      'v1.5.14: dashboard shows the live stage board with every stage as a column, Dental Triage and Treatment waiting included');
    log(/Aa, Al/.test(txt) && /Bb, Bo/.test(txt) && /Cc, Cy/.test(txt), 'v1.5.14: patients appear as cards on the board');
    log(/Start patient check-in/i.test(txt) && /Live/.test(txt), 'v1.5.14: check-in moved to the header and the board is marked Live');
    log(!/Quick actions/i.test(txt) && !/Back up to USB/i.test(txt), 'v1.5.14: the old Quick Actions grid and dashboard USB backup are gone');
    // A KPI card is clickable and navigates.
    const linkCard = dash.querySelector('.stat-card--link');
    log(!!linkCard, 'v1.5.14: KPI stat cards are clickable');
    linkCard.click(); await tick();
    log(!!navTo, 'v1.5.14: clicking a KPI card navigates to its station');

    // Reports dashboard renders its KPIs + demographics.
    navTo = null;
    const rep = (await import('../src/renderer/js/views/reports.js')).renderReports(ctx14);
    document.body.append(rep); await tick(); await tick();
    const rtxt = rep.textContent;
    log(/Patients seen/i.test(rtxt) && /X-rays uploaded/i.test(rtxt), 'v1.5.14: reports shows KPI cards (patients, X-ray uploads, procedures)');
    log(/Patient demographics/i.test(rtxt) && /By gender/i.test(rtxt) && /By age/i.test(rtxt), 'v1.5.14: reports breaks patients down by demographics');
    log(!!rep.querySelector('.ring-track') && !!rep.querySelector('.kpi-grid'), 'v1.5.14: reports renders the completion ring + KPI grid');
  }

  // ---- v1.5.15: patient pre-registration (public link → routed into the event) ----
  {
    currentUser = signInAdmin();
    // The pre-registration link is built from the configured sync server, so it
    // only exists once a clinic has connected one. It used to be published
    // unconditionally because a server was baked in — which meant every event
    // advertised a public URL pointing at another organisation's Worker.
    let evs = db.listEvents();
    let activeEv = evs.find((e) => e.active) || evs[0];
    log(!!activeEv && activeEv.prereg_url === null,
      'MMW: no pre-registration link is published while no sync server is configured');

    // With a server configured, each event gets its own /checkin/<uid> link.
    db.setSetting('cloud_url', 'https://example.invalid/mmw-sync');
    db.setSetting('cloud_key', 'test-key');
    evs = db.listEvents();
    activeEv = evs.find((e) => e.active) || evs[0];
    log(!!activeEv && typeof activeEv.prereg_url === 'string' && /\/checkin\//.test(activeEv.prereg_url) && activeEv.prereg_url.includes(activeEv.uid),
      'v1.5.15: each event exposes a unique /checkin/<event-uid> pre-registration link');
    db.setSetting('cloud_url', ''); db.setSetting('cloud_key', '');

    // Simulate what the Worker writes when a patient pre-registers: a checked-in
    // patient row scoped to the event, applied through the normal sync path.
    const iso = '2099-01-01T00:00:00.000Z';
    const remoteRow = {
      entity: 'patient', uid: 'prereg-test-uid-1', event_uid: activeEv.uid, patient_uid: null, deleted: 0,
      updated_at: iso + '@prereg',
      data: {
        language: 'es', first_name: 'Pilar', last_name: 'Nuevo', dob: '1988-03-03', gender: 'female', phone: '5551234567', email: null,
        demographics: JSON.stringify({ preregistered: true, prereg_at: iso }),
        medical_history: JSON.stringify({ allergies: ['penicillin'], conditions: ['diabetes'], medications: [{ name: 'Metformin', dose: '', reason: '' }] }),
        dental_history: JSON.stringify({ reason: 'broken tooth', visit_type: 'filling' }),
        status: 'checked_in', created_at: iso, dismissed_at: null, dismissed_by_name: null,
      },
    };
    const res15 = db.applyRemoteRows([remoteRow]);
    log(res15.applied === 1, 'v1.5.15: a pre-registration row applies through the normal sync path');
    const pre = db.listPatients({}).find((p) => p.first_name === 'Pilar' && p.last_name === 'Nuevo');
    log(!!pre && pre.status === 'checked_in' && pre.preregistered === true, 'v1.5.15: it lands as a checked-in patient in that event, tagged preregistered');
    const full15 = db.getPatient(pre.id);
    log((full15.medical_history.allergies || []).includes('penicillin') && (full15.medical_history.conditions || []).includes('diabetes') && full15.dental_history.reason === 'broken tooth', 'v1.5.15: the pre-registered answers render natively (allergies, conditions, reason)');

    // The dashboard board shows the pre-registered patient with a "Pre-reg" tag.
    const store15 = (await import('../src/renderer/js/store.js')).store; store15.setUser(currentUser);
    const ctx15 = { navigate: () => {}, toast: () => {}, store: store15, setDetail: () => {} };
    const dash15 = (await import('../src/renderer/js/views/dashboard.js')).renderDashboard(ctx15);
    document.body.append(dash15); await tick(); await tick();
    const card = Array.from(dash15.querySelectorAll('.crm-card')).find((c) => /Nuevo, Pilar/.test(c.textContent));
    log(!!card && /Pre-reg/.test(card.textContent), 'v1.5.15: the pre-registered patient shows on the live board with a “Pre-reg” tag');

    // v1.5.20: a pre-registered patient hasn't physically arrived until Vitals,
    // so their clinic clock is NOT running — the board shows NO time chips yet.
    log(!!card && !/total/.test(card.textContent) && !/\bhere\b/.test(card.textContent),
      'v1.5.20: a pre-registered patient shows no total/stage timer until they reach Vitals');
    // Once vitals are recorded the clock starts and both time chips appear.
    db.saveVitals(currentUser, pre.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '70' });
    const dash15b = (await import('../src/renderer/js/views/dashboard.js')).renderDashboard(ctx15);
    document.body.append(dash15b); await tick(); await tick();
    const card15b = Array.from(dash15b.querySelectorAll('.crm-card')).find((c) => /Nuevo, Pilar/.test(c.textContent));
    log(!!card15b && /total/.test(card15b.textContent) && /\bhere\b/.test(card15b.textContent),
      'v1.5.20: once the pre-registered patient reaches Vitals, the total + stage timers start');
  }

  // ---- v1.5.16: consistency fixes (bleeding=thinner, Left tag, time tags, tile) ----
  {
    currentUser = signInAdmin();
    // #1: a "Bleeding disorder" condition now raises the thinner flag on the
    // EMT/dentist screens (medFlags), matching the queues (db on_thinner).
    const mf = await import('../src/renderer/js/medFlags.js');
    log(mf.bloodThinnerStatus({ triage: {}, medical_history: { conditions: ['bleeding'] } }).onThinner === true, 'v1.5.16: a "Bleeding disorder" condition raises the blood-thinner flag on the EMT/dentist screens');
    const bpat = db.createPatient(currentUser, { first_name: 'Bl', last_name: 'Eed', demographics: {}, medical_history: { conditions: ['bleeding'] }, dental_history: {}, consents: [] });
    const bRow = db.listPatients({}).find((x) => x.id === bpat.id);
    log(!!bRow && bRow.on_thinner === true, 'v1.5.16: the same bleeding patient is flagged in the queues (db) — screens + queues + PDF now agree');

    // #5 + time tags: a dismissed patient → green "Left" tag, and both time tags.
    const ev16 = db.listEvents().find((e) => e.active) || db.listEvents()[0];
    db.applyRemoteRows([{
      entity: 'patient', uid: 'dismissed-test-1', event_uid: ev16.uid, patient_uid: null, deleted: 0, updated_at: '2099-01-01T02:00:00.000Z@t',
      data: {
        language: 'en', first_name: 'Do', last_name: 'Ne', dob: null, gender: null, phone: null, email: null,
        demographics: '{}', medical_history: '{}', dental_history: '{}',
        status: 'dismissed', created_at: '2099-01-01T00:00:00.000Z', dismissed_at: '2099-01-01T00:30:00.000Z', dismissed_by_name: 'Admin',
      },
    }]);
    const store16 = (await import('../src/renderer/js/store.js')).store; store16.setUser(currentUser);
    const ctx16 = { navigate: () => {}, toast: () => {}, store: store16, setDetail: () => {} };
    const dash16 = (await import('../src/renderer/js/views/dashboard.js')).renderDashboard(ctx16);
    document.body.append(dash16); await tick(); await tick();
    log(/Checked out/.test(dash16.textContent) && !/>Completed</.test(dash16.textContent), 'v1.5.16: the dashboard KPI tile reads "Checked out" (not "Completed")');
    const doneCard = Array.from(dash16.querySelectorAll('.crm-card')).find((c) => /Ne, Do/.test(c.textContent));
    log(!!doneCard && /Left/.test(doneCard.textContent), 'v1.5.16: a checked-out patient shows a green "Left" tag on the board');
    log(!!doneCard && /total/.test(doneCard.textContent) && /here/.test(doneCard.textContent), 'v1.5.16: board cards show two time tags — total time from check-in + time at the current stage');

    // #9: a localized free-text gender ("Mujer") must NOT be mislabeled "Male".
    const gp = db.createPatient(currentUser, { first_name: 'Gen', last_name: 'Der', gender: 'Mujer', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
    void gp;
    const rep16 = (await import('../src/renderer/js/views/reports.js')).renderReports(ctx16);
    document.body.append(rep16); await tick(); await tick();
    log(/Mujer/.test(rep16.textContent) && !/>\s*Male\s*</.test(rep16.textContent.replace(/\s+/g, ' ')) , 'v1.5.16: reports shows a localized gender ("Mujer") verbatim instead of guessing "Male"');
  }

  // ---- v1.5.17: pre-registration carries a SIGNED consent into the chart ----
  {
    currentUser = signInAdmin();
    const ev17 = db.listEvents().find((e) => e.active) || db.listEvents()[0];
    const puid = 'prereg17-patient';
    const iso = '2099-02-01T00:00:00.000Z';
    // Exactly what the Worker writes: a checked-in patient + a signed general
    // consent bound to it, applied through the normal sync path.
    db.applyRemoteRows([
      { entity: 'patient', uid: puid, event_uid: ev17.uid, patient_uid: null, deleted: 0, updated_at: iso + '@prereg', data: {
        language: 'en', first_name: 'Signed', last_name: 'Consent', dob: null, gender: 'female', phone: null, email: null,
        demographics: JSON.stringify({ preregistered: true }), medical_history: JSON.stringify({ conditions: ['diabetes'], under_treatment: 'yes' }),
        dental_history: JSON.stringify({ reason: 'exam', visit_type: 'filling', gum_bleeding: 'no' }), status: 'checked_in', created_at: iso, dismissed_at: null, dismissed_by_name: null } },
      { entity: 'consent', uid: 'prereg17-consent', event_uid: ev17.uid, patient_uid: puid, deleted: 0, updated_at: iso + '@prereg-c1', data: {
        type: 'general', version: 'general-oregon-en-v1+covid', language: 'en', signer_name: 'Signed Consent', relationship: 'Self',
        signature_png: 'data:image/png;base64,AAAA', signed_at: iso, tooth_numbers: null, amended_by: null, amended_at: null } },
    ]);
    const sp = db.listPatients({}).find((p) => p.first_name === 'Signed' && p.last_name === 'Consent');
    log(!!sp && sp.preregistered === true && sp.status === 'checked_in', 'v1.5.17: a full-parity pre-registration lands as a checked-in patient');
    const full17 = db.getPatient(sp.id);
    log((full17.consents || []).some((c) => c.type === 'general' && c.signer_name === 'Signed Consent' && c.signature_png), 'v1.5.17: the consent SIGNED on the pre-registration link is attached to the chart');
    log((full17.medical_history.conditions || []).includes('diabetes') && full17.medical_history.under_treatment === 'yes' && full17.dental_history.visit_type === 'filling', 'v1.5.17: the extra check-in-parity answers (medical + dental history) carry through');
  }

  // ---- v1.5.18: returning-patient new visit, ZIP export, reports email list ----
  {
    currentUser = signInAdmin();

    // #1: start a new visit from an existing record — details carry over, fresh visit.
    const src = db.createPatient(currentUser, { first_name: 'Rita', last_name: 'Returns', dob: '1980-05-05', gender: 'female', phone: '5551234567', email: 'rita@example.com', demographics: { address: '5 Elm St' }, medical_history: { conditions: ['diabetes'], allergies: ['penicillin'] }, dental_history: { reason: 'old reason', visit_type: 'extraction_pain', prior_dentist: 'Dr. Prior' }, consents: [] });
    const nv = db.startVisitFromExisting(currentUser, src.id);
    log(nv.id !== src.id && nv.first_name === 'Rita' && nv.last_name === 'Returns' && nv.dob === '1980-05-05' && nv.email === 'rita@example.com', 'v1.5.18: a returning patient starts a NEW visit with their details carried over');
    log((nv.medical_history.conditions || []).includes('diabetes') && nv.demographics.address === '5 Elm St' && nv.dental_history.prior_dentist === 'Dr. Prior', 'v1.5.18: the new visit keeps medical + demographics (no re-typing)');
    log(!nv.dental_history.reason && !nv.dental_history.visit_type && nv.status === 'checked_in', 'v1.5.18: the visit-specific reason/need starts fresh and enters the check-in queue');
    log(db.searchAllPatients('Returns').length >= 1, 'v1.5.18: returning patients are findable via the cross-event search');

    // #5: the clinic ZIP export is a valid archive (DB + records + README).
    const zipStore = (await import('../src/main/zipStore.js')).default;
    const z = zipStore.zip([{ name: 'database.db', data: Buffer.from('SQLite format 3 rest') }, { name: 'records.json', data: Buffer.from('{"a":1}') }, { name: 'README.txt', data: Buffer.from('hello') }]);
    log(Buffer.isBuffer(z) && z.length > 60 && z.readUInt32LE(0) === 0x04034b50 && z.includes(Buffer.from('records.json')) && z.subarray(z.length - 22).readUInt32LE(0) === 0x06054b50, 'v1.5.18: the clinic ZIP export is a valid PK archive with the expected files');
    log(zipStore.crc32(Buffer.from('123456789')) === 0xCBF43926, 'v1.5.18: the ZIP writer computes a correct CRC-32');

    // #4: checked-out patients with an email appear in Reports' email list.
    const store18 = (await import('../src/renderer/js/store.js')).store; store18.setUser(currentUser);
    const ctx18 = { navigate: () => {}, toast: () => {}, store: store18, setDetail: () => {} };
    const ep = db.createPatient(currentUser, { first_name: 'Ed', last_name: 'Mailer', email: 'ed@example.com', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
    db.saveVitals(currentUser, ep.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
    db.routePatient(currentUser, ep.id, 'dentist');
    db.dismissPatient(currentUser, ep.id);
    const rep18 = (await import('../src/renderer/js/views/reports.js')).renderReports(ctx18);
    document.body.append(rep18); await tick(); await tick();
    log(/Email visit summaries/.test(rep18.textContent) && /ed@example\.com/.test(rep18.textContent), 'v1.5.18: Reports lists checked-out patients who left an email, for follow-up');

    // Dashboard offers the returning-patient lookup for the front desk.
    const dash18 = (await import('../src/renderer/js/views/dashboard.js')).renderDashboard(ctx18);
    document.body.append(dash18); await tick(); await tick();
    log(/Returning patient/.test(dash18.textContent), 'v1.5.18: the dashboard offers a "Returning patient" lookup');
  }

  // ---- v1.5.0: X-ray import — per-x-ray tooth + auto-name, synced; import tile. ----
  {
    currentUser = signInAdmin();
    const xp = db.createPatient(currentUser, { first_name: 'Ex', last_name: 'Ray', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
    const added = db.addXray(currentUser, xp.id, { image_png: 'data:image/png;base64,AAAA', note: 'Ray_Ex_UR_T3', tooth: '3' });
    let xl = db.listXrays(xp.id);
    log(xl.length === 1 && xl[0].tooth === '3' && xl[0].note === 'Ray_Ex_UR_T3', 'v1.5.0: an x-ray stores its tooth + auto-name (Lastname_Firstname_area_tooth)');
    db.updateXrayTooth(currentUser, added.id, '14');
    log(db.listXrays(xp.id)[0].tooth === '14', 'v1.5.0: an x-ray tooth can be re-assigned');
    // tooth travels in the sync payload
    log(db.collectSyncRows(4000).rows.some((r) => r.entity === 'xray' && r.data && r.data.tooth === '14'), 'v1.5.0: the x-ray tooth is a synced field (reaches other laptops)');
    // provider detail renders the Import tile
    const store5 = (await import('../src/renderer/js/store.js')).store; store5.setUser(currentUser);
    const ctx5 = { navigate: () => {}, toast: () => {}, store: store5, setDetail: () => {} };
    db.saveVitals(currentUser, xp.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
    db.routePatient(currentUser, xp.id, 'dentist');
    const provX = (await import('../src/renderer/js/views/provider.js')).renderProvider(ctx5, { id: xp.id }); document.body.append(provX); await tick(); await tick();
    log(/Add X-ray/i.test(provX.textContent), 'v1.5.0: the dentist chart shows an "Add X-ray" upload action');
    log(/Tooth 14/.test(provX.textContent), 'v1.5.0: the imported x-ray shows its assigned tooth on the chart');
  }

  // ---- v1.5.13: upload → center form (tooth/quadrant/general) → save + drive delete ----
  {
    currentUser = signInAdmin();
    const store51 = (await import('../src/renderer/js/store.js')).store; store51.setUser(currentUser);
    const ctx51 = { navigate: () => {}, toast: () => {}, store: store51, setDetail: () => {} };
    const renderProvider = (await import('../src/renderer/js/views/provider.js')).renderProvider;
    const yp = db.createPatient(currentUser, { first_name: 'Ada', last_name: 'Xu', demographics: {}, medical_history: {}, dental_history: {}, consents: [] });
    db.saveVitals(currentUser, yp.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '66' });
    db.routePatient(currentUser, yp.id, 'dentist');

    const pv = renderProvider(ctx51, { id: yp.id }); document.body.append(pv); await tick(); await tick();
    // Single "Add X-ray" upload tile; no folder/DEXIS import UI anymore.
    log(/Add X-ray/i.test(pv.textContent) && !/Import X-ray/i.test(pv.textContent), 'v1.5.13: the chart shows one simple "Add X-ray" upload button (no folder/DEXIS controls)');

    // Drop an uploaded JPG onto the gallery → the labelling form opens.
    const gallery = pv.querySelector('.xray-gallery');
    const file = new window.File([new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9])], 'C0000007.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'path', { value: 'C:/DEXIS/Export/C0000007.jpg' });
    const drop = new window.Event('drop', { bubbles: true }); drop.dataTransfer = { files: [file] };
    gallery.dispatchEvent(drop);
    for (let i = 0; i < 8; i++) await tick();
    const card = document.querySelector('.xray-form-card');
    log(!!card && !!card.querySelector('.xray-form-preview'), 'v1.5.13: uploading opens a centered form with the image preview');
    const opts = Array.from(card.querySelectorAll('.xray-opt'));
    log(opts.length === 3 && /Tooth/.test(opts[0].textContent) && /Quadrant/.test(opts[1].textContent) && /General/.test(opts[2].textContent), 'v1.5.13: the form offers three choices — Tooth, Quadrant, General');

    const nameOf = () => card.querySelector('.xray-form-name').textContent;
    // default is Tooth: type the number
    const toothIn = card.querySelector('input');
    toothIn.value = '9'; toothIn.dispatchEvent(new window.Event('input', { bubbles: true }));
    log(nameOf() === 'Xu_Ada_T9.jpg', 'v1.5.13: Tooth → renames to Lastname_Firstname_T<tooth>.jpg');
    // Quadrant
    opts[1].click(); await tick();
    const areaSel = card.querySelector('select'); areaSel.value = 'LL'; areaSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    log(nameOf() === 'Xu_Ada_LL.jpg', 'v1.5.13: Quadrant → renames to Lastname_Firstname_<quadrant>.jpg');
    // General
    opts[2].click(); await tick();
    log(nameOf() === 'Xu_Ada_General.jpg', 'v1.5.13: General → renames to Lastname_Firstname_General.jpg');

    // back to Tooth, save
    opts[0].click(); await tick();
    card.querySelector('input').value = '9'; card.querySelector('input').dispatchEvent(new window.Event('input', { bubbles: true }));
    const before = db.listXrays(yp.id).length;
    const saveBtn = Array.from(card.querySelectorAll('button')).find((b) => /Save X-ray/i.test(b.textContent));
    saveBtn.click();
    for (let i = 0; i < 8; i++) await tick();
    const afterX = db.listXrays(yp.id);
    log(afterX.length === before + 1 && afterX[afterX.length - 1].note === 'Xu_Ada_T9.jpg' && afterX[afterX.length - 1].tooth === '9', 'v1.5.13: Save files the x-ray to the chart under its renamed .jpg and records the tooth');
    log(mockDeletedFromDrive.includes('C:/DEXIS/Export/C0000007.jpg'), 'v1.5.13: after saving, the source file is deleted from the computer drive');
    log(!document.querySelector('.xray-form-card'), 'v1.5.13: the form closes itself after saving');
  }

  // ---- v1.5.21: a station can always re-read the whole clinic ----
  // Guards the fix for patients appearing on one laptop but not another. The
  // pull cursor used to be a timestamp high-water mark, so a record that reached
  // the cloud late (an offline check-in, or a laptop with a slow clock) fell
  // below the mark and was never delivered to that station again.
  {
    // The one-time heal runs on upgrade: the cursor is cleared so the station
    // re-reads everything it may have stepped over.
    log(db.getSetting('cloud_cursor_heal') === 'v1', 'v1.5.21: the one-time sync heal is applied on upgrade');

    // A station that has synced for a while, then hits "Re-sync everything".
    db.setSyncMeta({ cursor: '4821' });
    db.setSyncPending([{ entity: 'consent', uid: 'orphan-1', patient_uid: 'nobody', updated_at: 'x', data: {} }]);
    log(db.getSyncMeta().cursor === '4821' && db.getSyncPending().length === 1, 'v1.5.21: a station tracks its place in the clinic queue');
    db.resetSyncCursor();
    log(db.getSyncMeta().cursor === '' && db.getSyncPending().length === 0, 'v1.5.21: "Re-sync everything" rewinds the station so it re-reads the whole clinic');

    // A patient pushed with a BACK-DATED stamp (checked in while that laptop was
    // offline) must still land here — this is the record that used to vanish.
    const evR = db.listEvents().find((e) => e.active) || db.listEvents()[0];
    const backdated = '2020-01-01T08:00:00.000Z@offline-laptop';
    const res21 = db.applyRemoteRows([{
      entity: 'patient', uid: 'offline-checkin-1', event_uid: evR.uid, patient_uid: null, deleted: 0,
      updated_at: backdated,
      data: {
        language: 'en', first_name: 'Olivia', last_name: 'Offline', dob: '1990-02-02', gender: 'female',
        phone: null, email: null, demographics: '{}', medical_history: '{}', dental_history: '{}',
        status: 'checked_in', created_at: '2020-01-01T08:00:00.000Z', dismissed_at: null, dismissed_by_name: null,
      },
    }]);
    const olivia = db.listPatients({}).find((p) => p.last_name === 'Offline');
    log(res21.applied === 1 && !!olivia && olivia.status === 'checked_in',
      'v1.5.21: a back-dated offline check-in still lands in this station\'s queue');
  }

  // ---- v1.5.23: "Waiting for vitals" counts pre-registered patients too ----
  // The tile used to be read off the triage table, which only the in-person
  // check-in creates — so a board showing 30 pre-registered patients in "Checked
  // in" sat next to a tile reading 1 (the single walk-in).
  {
    currentUser = signInAdmin();
    const evW = db.listEvents().find((e) => e.active) || db.listEvents()[0];
    const before = db.dashboardStats().waiting_triage;

    // Three patients arrive the way a pre-registration does: a patient row from
    // the cloud, with no triage row of their own.
    for (const n of ['One', 'Two', 'Three']) {
      db.applyRemoteRows([{
        entity: 'patient', uid: 'prereg-count-' + n, event_uid: evW.uid, patient_uid: null, deleted: 0,
        updated_at: '2099-02-01T00:00:0' + n.length + '.000Z@prereg',
        data: {
          language: 'en', first_name: n, last_name: 'Prereg', dob: '1990-01-01', gender: 'female',
          phone: null, email: null, demographics: JSON.stringify({ preregistered: true }),
          medical_history: '{}', dental_history: '{}',
          status: 'checked_in', created_at: '2099-02-01T00:00:00.000Z', dismissed_at: null, dismissed_by_name: null,
        },
      }]);
    }
    log(db.dashboardStats().waiting_triage === before + 3,
      'v1.5.23: pre-registered patients are counted in "Waiting for vitals"');

    // And the tile agrees with the live board's "Checked in" column.
    const boardCheckedIn = db.listPatients({}).filter((p) => p.status === 'checked_in' && !p.has_vitals).length;
    log(db.dashboardStats().waiting_triage === boardCheckedIn,
      'v1.5.23: the tile matches the board\'s "Checked in" column exactly');

    // Once vitals are taken the patient leaves the count (moves to the Vitals column).
    const oneP = db.listPatients({}).find((p) => p.first_name === 'One' && p.last_name === 'Prereg');
    const midCount = db.dashboardStats().waiting_triage;
    db.saveVitals(currentUser, oneP.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
    log(db.dashboardStats().waiting_triage === midCount - 1,
      'v1.5.23: taking vitals removes the patient from "Waiting for vitals"');
  }

  // ---- v1.5.24: auto-routing from the patient's own answer ----
  {
    currentUser = signInAdmin();
    const mk = (last, visit) => db.createPatient(currentUser, {
      first_name: 'Auto', last_name: last, dob: '1990-01-01', gender: 'female',
      demographics: {}, medical_history: {}, dental_history: { visit_type: visit, reason: 'x' },
    });
    const routeOf = (p) => (db.listPatients({}).find((x) => x.id === p.id) || {}).route;
    log(routeOf(mk('Clean', 'cleaning')) === 'hygienist', 'v1.5.24: choosing a cleaning routes to the hygienist automatically');
    log(routeOf(mk('Fill', 'filling')) === 'dentist', 'v1.5.24: choosing a filling routes to the dentist automatically');
    log(routeOf(mk('Pull', 'extraction_pain')) === 'dentist', 'v1.5.24: choosing an extraction routes to the dentist automatically');
    // An explicit choice still wins, and an unanswered visit type leaves it open.
    const explicit = db.createPatient(currentUser, { first_name: 'Auto', last_name: 'Override', demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' }, route: 'dentist' });
    log(routeOf(explicit) === 'dentist', 'v1.5.24: an explicitly chosen station still wins over the automatic one');
    log(routeOf(mk('Blank', null)) == null, 'v1.5.24: no answer leaves the station for the EMT to choose');
  }

  // ---- v1.5.24: the front desk's arrival check ----
  {
    currentUser = signInAdmin();
    const signed = { type: 'general', signer_name: 'Pat Ient', relationship: 'Self', signature_png: 'data:image/png;base64,AAAA' };

    // Consent signed + a cleaning chosen -> ready, and confirming marks them here.
    const ok = db.createPatient(currentUser, {
      first_name: 'Ready', last_name: 'ToGo', dob: '1985-01-01', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' }, consents: [signed],
    });
    const r1 = db.arrivalReadiness(ok.id);
    log(r1.general_signed && r1.needs_surgery_consent === false && r1.route === 'hygienist' && r1.ready,
      'v1.5.24: a signed cleaning patient is ready, with their station already set');
    const after = db.confirmArrival(currentUser, ok.id, {});
    log(!!after.arrived_at, 'v1.5.24: confirming arrival records that the patient is physically here');
    const listed = db.listPatients({}).find((p) => p.id === ok.id);
    log(!!listed.arrived_at && listed.status === 'checked_in',
      'v1.5.24: a confirmed patient still goes to vitals next (no station is skipped)');

    // Unsigned general consent -> refused.
    const unsigned = db.createPatient(currentUser, {
      first_name: 'No', last_name: 'Consent', dob: '1985-01-01', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' }, consents: [],
    });
    let blocked = false;
    try { db.confirmArrival(currentUser, unsigned.id, {}); } catch (e) { blocked = /general consent/i.test(e.message); }
    log(blocked, 'v1.5.24: a patient with no signed general consent cannot be sent through');

    // A consent row with NO signature does not count as signed.
    const empty = db.createPatient(currentUser, {
      first_name: 'Empty', last_name: 'Sig', dob: '1985-01-01', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: 'X', signature_png: '' }],
    });
    log(db.arrivalReadiness(empty.id).general_signed === false, 'v1.5.24: an unsigned consent form does not count as consent');

    // Extraction with only the general consent -> refused until surgery is signed.
    const ex = db.createPatient(currentUser, {
      first_name: 'Ex', last_name: 'Traction', dob: '1985-01-01', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'extraction_pain' }, consents: [signed],
    });
    const rEx = db.arrivalReadiness(ex.id);
    log(rEx.needs_surgery_consent === true && rEx.surgery_signed === false && !rEx.ready,
      'v1.5.24: an extraction patient is not ready on the general consent alone');
    let exBlocked = false;
    try { db.confirmArrival(currentUser, ex.id, {}); } catch (e) { exBlocked = /oral surgery/i.test(e.message); }
    log(exBlocked, 'v1.5.24: an extraction patient without the surgery consent cannot be sent through');
    // Sign it chairside -> now allowed, and routed to the dentist.
    db.addPatientConsent(currentUser, ex.id, { type: 'oral_surgery', signer_name: 'Ex Traction', relationship: 'Self', signature_png: 'data:image/png;base64,BBBB', tooth_numbers: '30' });
    const okNow = db.confirmArrival(currentUser, ex.id, {});
    log(!!okNow.arrived_at && db.arrivalReadiness(ex.id).route === 'dentist',
      'v1.5.24: once the surgery consent is signed the extraction patient goes through to the dentist');

    // The Arrivals screen itself: waiting vs. confirmed, with the consent state
    // shown on each row so the desk can see the blocker before they tap.
    const store24 = (await import('../src/renderer/js/store.js')).store; store24.setUser(currentUser);
    const ctx24 = { navigate: () => {}, toast: () => {}, store: store24, setDetail: () => {} };
    const arrivals = (await import('../src/renderer/js/views/arrivals.js')).renderArrivals(ctx24);
    document.body.append(arrivals); await tick(); await tick();
    // v1.5.26: the screen is split by how the patient registered. These patients
    // were registered at the desk, so open that tab.
    const pickTab = (view, label) => {
      const b = Array.from(view.querySelectorAll('.arrival-tab')).find((x) => new RegExp(label, 'i').test(x.textContent));
      if (b) b.click();
      return b;
    };
    pickTab(arrivals, 'Registered at the desk'); await tick();
    const atxt = arrivals.textContent;
    log(/Arrivals/.test(atxt) && /Waiting to be confirmed/.test(atxt) && /Confirmed here/.test(atxt),
      'v1.5.24: the Arrivals screen lists who is waiting and who is confirmed');
    const unsignedRow = Array.from(arrivals.querySelectorAll('.arrival-row')).find((r) => /Consent, No/.test(r.textContent));
    log(!!unsignedRow && /Consent missing/.test(unsignedRow.textContent),
      'v1.5.24: a patient with an unsigned consent is flagged on the arrivals list');
    const readyRow = Array.from(arrivals.querySelectorAll('.arrival-row')).find((r) => /ToGo, Ready/.test(r.textContent));
    log(!!readyRow && /Here/.test(readyRow.textContent),
      'v1.5.24: a confirmed patient shows as here');

    // ...and the live board marks them too.
    const dash24 = (await import('../src/renderer/js/views/dashboard.js')).renderDashboard(ctx24);
    document.body.append(dash24); await tick(); await tick();
    const okCard = Array.from(dash24.querySelectorAll('.crm-card')).find((c) => /ToGo, Ready/.test(c.textContent));
    log(!!okCard && /Here/.test(okCard.textContent), 'v1.5.24: the board shows a "Here" tag once the front desk confirms arrival');

    // v1.5.25: the arrivals search — a busy front desk needs to find one person.
    const findMe = db.createPatient(currentUser, {
      first_name: 'Yolanda', last_name: 'Zaragoza', dob: '1977-03-04', gender: 'female', phone: '5035559876',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: 'Y Z', signature_png: 'data:image/png;base64,AAAA' }],
    });
    const arr2 = (await import('../src/renderer/js/views/arrivals.js')).renderArrivals(ctx24);
    document.body.append(arr2); await tick(); await tick();
    pickTab(arr2, 'Registered at the desk'); await tick();
    const box = arr2.querySelector('input[type="search"]');
    log(!!box, 'v1.5.25: the arrivals screen has a search box');
    const rowsFor = () => Array.from(arr2.querySelectorAll('.arrival-row')).map((r) => r.textContent);
    log(rowsFor().length > 1, 'v1.5.25: (setup) more than one patient is listed');
    const type = async (v) => { box.value = v; box.dispatchEvent(new window.Event('input', { bubbles: true })); await tick(); };
    await type('zaragoza');
    log(rowsFor().length === 1 && /Zaragoza/.test(rowsFor()[0]), 'v1.5.25: searching a surname narrows the list to that patient');
    await type('5035559876');
    log(rowsFor().length === 1 && /Zaragoza/.test(rowsFor()[0]), 'v1.5.25: searching a phone number finds them too');
    await type('1977-03-04');
    log(rowsFor().length === 1 && /Zaragoza/.test(rowsFor()[0]), 'v1.5.25: searching a date of birth finds them too');
    await type('zaragoza yol');
    log(rowsFor().length === 1, 'v1.5.25: words can be typed in any order');
    await type('nobody-by-this-name');
    log(rowsFor().length === 0 && /No match here/.test(arr2.textContent), 'v1.5.25: a search with no match says so');
    await type('');
    log(rowsFor().length > 1, 'v1.5.25: clearing the search restores the full list');
    // The queue refreshing underneath must not wipe what is being typed.
    await type('zaragoza');
    const before = box.value;
    const reloaded = arr2.querySelector('input[type="search"]');
    log(reloaded === box && reloaded.value === before && rowsFor().length === 1,
      'v1.5.25: a background refresh keeps the search text and the filtered list');
  }

  // ---- v1.5.24: vitals are a hard gate, and patients can be walked back ----
  {
    currentUser = signInAdmin();
    const mkP = (last, visit) => db.createPatient(currentUser, {
      first_name: 'Gate', last_name: last, dob: '1980-01-01', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: visit || 'filling' },
      consents: [{ type: 'general', signer_name: 'Gate', signature_png: 'data:image/png;base64,AAAA' }],
    });

    // No vitals -> cannot reach a provider, by any path.
    const g1 = mkP('One');
    let refused = '';
    try { db.routePatient(currentUser, g1.id, 'dentist'); } catch (e) { refused = e.message; }
    log(/vitals/i.test(refused), 'v1.5.24: a patient with no vitals cannot be routed to the dentist');
    let refusedHyg = '';
    try { db.routePatient(currentUser, g1.id, 'hygienist'); } catch (e) { refusedHyg = e.message; }
    log(/vitals/i.test(refusedHyg), 'v1.5.24: ...nor to the hygienist');
    // The admin override obeys the same gate — otherwise it is not a gate.
    let refusedAdmin = '';
    try { db.adminMovePatient(currentUser, g1.id, 'dentist'); } catch (e) { refusedAdmin = e.message; }
    log(/vitals/i.test(refusedAdmin), 'v1.5.24: an admin override cannot walk a patient past the vitals station either');
    log(db.listPatients({}).find((p) => p.id === g1.id).status === 'checked_in',
      'v1.5.24: the blocked patient stays put rather than half-moving');

    // A pulse alone is enough to pass the gate (a BP cuff isn't always available).
    const g2 = mkP('Pulse');
    db.saveVitals(currentUser, g2.id, { heart_rate: '72' });
    db.routePatient(currentUser, g2.id, 'dentist');
    log(db.listPatients({}).find((p) => p.id === g2.id).status === 'triaged',
      'v1.5.24: a recorded pulse satisfies the vitals gate');

    // Walking a patient BACK.
    const back = mkP('Back');
    db.saveVitals(currentUser, back.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
    db.confirmArrival(currentUser, back.id, { route: 'dentist' });
    db.routePatient(currentUser, back.id, 'dentist');
    log(db.listPatients({}).find((p) => p.id === back.id).status === 'triaged', 'v1.5.24: (setup) patient is with the dentist');

    // ...back to vitals: no longer signed off, waiting again.
    db.adminMovePatient(currentUser, back.id, 'emt');
    let row = db.listPatients({}).find((p) => p.id === back.id);
    log(row.status === 'checked_in' && !row.emt_signed_off,
      'v1.5.24: "back to vitals" undoes the EMT sign-off, not just the label');

    // ...all the way back to check-in: arrival cleared, station cleared, vitals kept.
    db.routePatient(currentUser, back.id, 'dentist');
    db.adminMovePatient(currentUser, back.id, 'checkin');
    row = db.listPatients({}).find((p) => p.id === back.id);
    log(row.status === 'checked_in' && !row.arrived_at && !row.route && !row.emt_signed_off,
      'v1.5.24: "back to check-in" clears arrival, station and sign-off');
    log(row.has_vitals === true, 'v1.5.24: ...but the recorded vitals are kept (clinical data is never discarded)');
    log(db.arrivalReadiness(back.id).arrived_at === null,
      'v1.5.24: the patient reappears in the front desk arrivals list');

    // A checked-out patient can be pulled back to check-in too.
    const outP = mkP('Out');
    db.saveVitals(currentUser, outP.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '64' });
    db.routePatient(currentUser, outP.id, 'dentist');
    db.dismissPatient(currentUser, outP.id);
    log(db.listPatients({}).find((p) => p.id === outP.id).status === 'dismissed', 'v1.5.24: (setup) patient is checked out');
    db.adminMovePatient(currentUser, outP.id, 'checkin');
    row = db.listPatients({}).find((p) => p.id === outP.id);
    log(row.status === 'checked_in' && !row.dismissed_at,
      'v1.5.24: a checked-out patient can be brought all the way back to check-in');
  }

  // ---- v1.5.26: arrivals tabs + A–Z order; hygienist history; slider fix ----
  {
    currentUser = signInAdmin();
    const ev26 = db.listEvents().find((e) => e.active) || db.listEvents()[0];
    const signed = [{ type: 'general', signer_name: 'S', signature_png: 'data:image/png;base64,AAAA' }];
    // Desk-registered, deliberately out of alphabetical order.
    for (const last of ['Zimmerman', 'Abbott', 'Mercer']) {
      db.createPatient(currentUser, {
        first_name: 'Desk', last_name: last, dob: '1980-01-01', gender: 'male',
        demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' }, consents: signed,
      });
    }
    // Pre-registered, also out of order (arrives through sync, as the Worker writes it).
    ['Yardley', 'Bannister'].forEach((last, i) => db.applyRemoteRows([{
      entity: 'patient', uid: 'tabs-prereg-' + last, event_uid: ev26.uid, patient_uid: null, deleted: 0,
      updated_at: '2099-03-0' + (i + 1) + 'T00:00:00.000Z@prereg',
      data: {
        language: 'en', first_name: 'Online', last_name: last, dob: '1990-01-01', gender: 'female',
        phone: null, email: null, demographics: JSON.stringify({ preregistered: true }),
        medical_history: '{}', dental_history: JSON.stringify({ visit_type: 'cleaning' }),
        status: 'checked_in', created_at: '2099-03-01T00:00:00.000Z', dismissed_at: null, dismissed_by_name: null,
      },
    }]));

    const store26 = (await import('../src/renderer/js/store.js')).store; store26.setUser(currentUser);
    const ctx26 = { navigate: () => {}, toast: () => {}, store: store26, setDetail: () => {} };
    const view = (await import('../src/renderer/js/views/arrivals.js')).renderArrivals(ctx26);
    document.body.append(view); await tick(); await tick();

    const tabs = Array.from(view.querySelectorAll('.arrival-tab')).map((b) => b.textContent);
    log(tabs.length === 2 && /Pre-registered/i.test(tabs[0]) && /Registered at the desk/i.test(tabs[1]),
      'v1.5.26: arrivals is split into "Pre-registered online" and "Registered at the desk" tabs');
    const surnames = () => Array.from(view.querySelectorAll('.arrival-row strong')).map((e) => e.textContent.split(',')[0]);
    const click = (label) => {
      const b = Array.from(view.querySelectorAll('.arrival-tab')).find((x) => new RegExp(label, 'i').test(x.textContent));
      b.click(); return b;
    };

    click('Pre-registered'); await tick();
    const pre = surnames();
    log(pre.includes('Yardley') && pre.includes('Bannister') && !pre.includes('Abbott'),
      'v1.5.26: the pre-registered tab shows only patients who registered online');
    log(JSON.stringify(pre) === JSON.stringify([...pre].sort()), 'v1.5.26: the pre-registered list is in A–Z order by surname');

    click('Registered at the desk'); await tick();
    const desk = surnames();
    log(desk.includes('Abbott') && desk.includes('Zimmerman') && !desk.includes('Yardley'),
      'v1.5.26: the desk tab shows only patients registered here');
    const deskIdx = [desk.indexOf('Abbott'), desk.indexOf('Mercer'), desk.indexOf('Zimmerman')];
    log(deskIdx[0] < deskIdx[1] && deskIdx[1] < deskIdx[2], 'v1.5.26: the desk list is in A–Z order by surname');
  }

  // The hygienist must see the medical history, not just the dentist.
  {
    currentUser = signInAdmin();
    const hp26 = db.createPatient(currentUser, {
      first_name: 'Hyg', last_name: 'History', dob: '1975-05-05', gender: 'female',
      demographics: {}, medical_history: { conditions: ['diabetes', 'high_bp'], allergies: ['penicillin'], allergies_other: 'Sulfa', under_treatment: 'yes' },
      dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: 'H', signature_png: 'data:image/png;base64,AAAA' }],
    });
    db.saveVitals(currentUser, hp26.id, { bp_systolic: '124', bp_diastolic: '80', heart_rate: '70' });
    db.routePatient(currentUser, hp26.id, 'hygienist');
    const storeH = (await import('../src/renderer/js/store.js')).store; storeH.setUser(currentUser);
    const ctxH = { navigate: () => {}, toast: () => {}, store: storeH, setDetail: () => {} };
    const hv = (await import('../src/renderer/js/views/hygienist.js')).renderHygienist(ctxH, { id: hp26.id });
    document.body.append(hv);
    for (let i = 0; i < 8; i++) await tick();
    const htxt = hv.textContent;
    log(/Medical history/i.test(htxt), 'v1.5.26: the hygienist screen shows the medical history section');
    log(/Diabetes/i.test(htxt) && /High blood pressure/i.test(htxt), 'v1.5.26: the hygienist sees the patient\'s conditions');
    log(/Penicillin/i.test(htxt) && /Sulfa/i.test(htxt), 'v1.5.26: the hygienist sees allergies, including a typed-in one');
    const panel = hv.querySelector('details.collapse');
    log(!!panel && panel.hasAttribute('open'), 'v1.5.26: the history is open by default, not hidden behind a toggle');
  }

  // ---- v1.6.0: export as a spreadsheet, restore it, and purge PHI ----
  {
    currentUser = signInAdmin();
    const ev = db.createEvent(currentUser, { name: 'Export Test', location: 'Sandy' });
    db.setActiveEvent(currentUser, ev.id);
    const pt = db.createPatient(currentUser, {
      first_name: 'Wilhelmina', last_name: 'Farnsworth', dob: '1988-09-14', gender: 'female', phone: '5035550142',
      demographics: { city: 'Sandy', state: 'OR' },
      medical_history: { allergies: ['penicillin'], allergies_other: 'Sulfa', conditions: ['diabetes'] },
      dental_history: { visit_type: 'extraction_pain', reason: 'Molar pain' },
      consents: [{ type: 'general', signer_name: 'Wilhelmina Farnsworth', signature_png: 'data:image/png;base64,AAAA' }],
    });
    db.saveVitals(currentUser, pt.id, { bp_systolic: '148', bp_diastolic: '92', heart_rate: '78' });
    db.routePatient(currentUser, pt.id, 'dentist');
    db.addXray(currentUser, pt.id, { station: 'dentist', image_png: 'data:image/jpeg;base64,BBBB', note: 'Farnsworth_W_T30.jpg', tooth: '30' });

    const bundle = db.exportClinicBundle(ev.id);
    log(bundle.patients.length === 1 && bundle.consents.length === 1 && bundle.xrays.length === 1 && !!bundle.patients[0].uid,
      'v1.6.0: the clinic export carries patients, consents and x-rays, each with a stable id');
    log(String(bundle.consents[0].signature_png).startsWith('data:image') && String(bundle.xrays[0].image_png).startsWith('data:image'),
      'v1.6.0: signatures and x-ray images are in the backup (a spreadsheet cannot hold them)');

    // The readable workbook.
    const { clinicSheets } = await import('../src/main/clinicSheets.js');
    const { buildWorkbook } = await import('../src/main/xlsx.js');
    const sheets = clinicSheets(bundle);
    const names = sheets.map((s) => s.name);
    log(names.includes('Patients') && names.includes('Treatment') && names.includes('Consents') && names.includes('X-rays'),
      'v1.6.0: the workbook has a sheet for patients, treatment, consents and x-rays');
    const pRow = sheets[0].rows[0];
    const pCols = sheets[0].columns;
    log(pRow[pCols.indexOf('Allergies')] === 'Penicillin, Sulfa',
      'v1.6.0: the spreadsheet shows a typed-in allergy alongside the ticked ones');
    log(pRow[pCols.indexOf('Blood pressure')] === '148/92' && pRow[pCols.indexOf('City')] === 'Sandy',
      'v1.6.0: vitals and city read plainly in the spreadsheet');
    const wb = buildWorkbook(sheets);
    log(Buffer.isBuffer(wb) && wb.slice(0, 2).toString() === 'PK', 'v1.6.0: the workbook is a real .xlsx file');

    // Finishing the clinic keeps the figures and removes the people.
    const fin = db.finishEvent(currentUser, ev.id);
    log(fin.removed === 1 && db.listPatients({ eventId: ev.id }).length === 0,
      'v1.6.0: finishing a clinic removes every patient record');
    const reports = db.listEventReports();
    const rep = reports.find((r) => r.event_id === ev.id);
    log(!!rep && rep.summary.patients_seen === 1 && rep.summary.extractions === 0,
      'v1.6.0: the de-identified reporting totals are kept');
    log(!!rep && rep.summary.by_city['Sandy, OR'] === 1 && !!rep.summary.by_age,
      'v1.6.0: the kept report still has the by-city and by-age breakdowns for grant returns');
    const repText = JSON.stringify(rep.summary);
    log(!/Wilhelmina|Farnsworth/.test(repText) && !/5035550142/.test(repText) && !/1988-09-14/.test(repText),
      'v1.6.0: the kept report contains no name, phone or date of birth');

    // The deletion must travel, or the cloud simply sends the patient back.
    const pending = db.collectSyncRows(400).rows.filter((r) => r.deleted);
    const tombEntities = new Set(pending.map((r) => r.entity));
    log(pending.some((r) => r.uid === bundle.patients[0].uid) && pending.every((r) => JSON.stringify(r.data) === '{}'),
      'v1.6.0: a purge queues a deletion for the cloud, carrying no patient data');
    // The whole chart must be tombstoned. A patient-only tombstone would leave
    // the consent signatures and x-ray images sitting in the cloud forever —
    // the most identifying data in the system.
    log(tombEntities.has('patient') && tombEntities.has('consent') && tombEntities.has('xray') && tombEntities.has('triage'),
      'v1.6.0: consents, x-rays and vitals are purged from the cloud too, not just the patient row');
    const tombUids = new Set(pending.map((r) => r.uid));
    log(tombUids.has(bundle.consents[0].uid) && tombUids.has(bundle.xrays[0].uid),
      'v1.6.0: the purged signature and x-ray are named explicitly so the cloud drops them');
    // ...and an incoming deletion removes the record here too.
    db.setEventActive(currentUser, ev.id, true); // finishing the clinic turned it off
    db.setActiveEvent(currentUser, ev.id);
    const victim = db.createPatient(currentUser, { first_name: 'Gone', last_name: 'Soon', demographics: {}, medical_history: {}, dental_history: {} });
    const vUid = db.exportClinicBundle(ev.id).patients.find((p) => p.last_name === 'Soon').uid;
    // v1.6.3: deletions are counted separately from records brought in.
    const del = db.applyRemoteRows([{ entity: 'patient', uid: vUid, deleted: 1, updated_at: '2099-12-31T00:00:00.000Z@peer', data: {} }]);
    log(del.deleted === 1 && !db.listPatients({ eventId: ev.id }).find((p) => p.id === victim.id),
      'v1.6.0: a deletion from another station removes the patient here as well');

    // Restore puts the whole clinic back, signatures and images included.
    const back = db.importClinicBundle(currentUser, bundle);
    const restored = db.listPatients({ eventId: ev.id }).find((p) => p.last_name === 'Farnsworth');
    const full = restored ? db.getPatient(restored.id) : null;
    log(back.patients === 1 && !!full, 'v1.6.0: a clinic can be restored from its backup file');
    log(!!full && String((full.consents[0] || {}).signature_png).startsWith('data:image') && String(full.triage.bp_systolic) === '148',
      'v1.6.0: the restored record still has its signed consent and vitals');
    log(!!full && full.xrays.length === 1 && String(db.getXray(full.xrays[0].id).image_png).startsWith('data:image'),
      'v1.6.0: the restored record still has its x-ray image');
    db.importClinicBundle(currentUser, bundle);
    log(db.listPatients({ eventId: ev.id }).filter((p) => p.last_name === 'Farnsworth').length === 1,
      'v1.6.0: importing the same file twice does not duplicate anyone');
  }

  // ---- v1.6.1: one-tap check-out tick, and a modernised Reports tab ----
  {
    currentUser = signInAdmin();
    const ev61 = db.listEvents().find((e) => e.active) || db.listEvents()[0];
    db.setActiveEvent(currentUser, ev61.id);
    const mk = (last, city) => {
      const p = db.createPatient(currentUser, {
        first_name: 'Tick', last_name: last, dob: '1980-01-01', gender: 'female',
        demographics: { city, state: 'OR' }, medical_history: { conditions: ['diabetes'] },
        dental_history: { visit_type: 'cleaning' },
        consents: [{ type: 'general', signer_name: 'T', signature_png: 'data:image/png;base64,AAAA' }],
      });
      db.saveVitals(currentUser, p.id, { bp_systolic: '120', bp_diastolic: '78', heart_rate: '70' });
      db.routePatient(currentUser, p.id, 'hygienist');
      db.saveTreatment(currentUser, p.id, { cleaning: { scaling: true }, clinical_notes: 'done' }, true);
      return p;
    };
    const a1 = mk('Alpha', 'Sandy');
    mk('Beta', 'Boring');

    const store61 = (await import('../src/renderer/js/store.js')).store; store61.setUser(currentUser);
    const ctx61 = { navigate: () => {}, toast: () => {}, store: store61, setDetail: () => {} };
    const co = (await import('../src/renderer/js/views/checkout.js')).renderCheckout(ctx61);
    document.body.append(co);
    for (let i = 0; i < 6; i++) await tick();

    const tickBtns = Array.from(co.querySelectorAll('.tick-btn'));
    log(tickBtns.length >= 2, 'v1.6.1: check-out lists a one-tap tick for each ready patient');
    let alphaRow = Array.from(co.querySelectorAll('tr')).find((r) => /Alpha/.test(r.textContent));
    log(!!alphaRow && !!alphaRow.querySelector('.tick-btn'), 'v1.6.1: the tick sits on the patient\'s own row');

    // v0.0.8: the exit survey comes first. With none recorded the tick opens the
    // survey rather than the dismiss confirmation — the desk's next action is the
    // same either way, and a disabled button with no explanation is how a
    // required step gets worked around instead of used.
    alphaRow.querySelector('.tick-btn').click();
    for (let i = 0; i < 4; i++) await tick();
    const svOverlay = document.querySelector('.survey-overlay');
    log(!!svOverlay, 'MMW survey: ticking a patient who has not been surveyed opens the survey first');
    log(!!svOverlay && /Prefer not to answer|rather not/i.test(svOverlay.textContent),
      'MMW survey: the patient can decline from inside the survey');
    // Decline it, which is a recorded answer, and the flow continues to dismissal.
    const declineBtn = Array.from(svOverlay.querySelectorAll('button')).find((b) => /rather not/i.test(b.textContent));
    declineBtn.click();
    for (let i = 0; i < 10; i++) await tick();
    log(db.getExitSurvey(a1.id) && db.getExitSurvey(a1.id).declined === true,
      'MMW survey: declining from the tick flow is recorded against the patient');

    // Now that the survey is answered, the tick asks for the dismiss confirmation.
    alphaRow = Array.from(co.querySelectorAll('tr')).find((r) => /Alpha/.test(r.textContent));
    if (alphaRow && alphaRow.querySelector('.tick-btn')) alphaRow.querySelector('.tick-btn').click();
    for (let i = 0; i < 4; i++) await tick();
    const confirmBtn = Array.from(document.querySelectorAll('.modal-card button')).find((b) => /Verify & dismiss/i.test(b.textContent));
    log(!!confirmBtn, 'v1.6.1: ticking a surveyed patient asks for confirmation before checking them out');
    confirmBtn.click();
    for (let i = 0; i < 8; i++) await tick();
    log(db.listPatients({}).find((p) => p.id === a1.id).status === 'dismissed',
      'v1.6.1: confirming the tick checks the patient out from the list');
    const doneRow = Array.from(co.querySelectorAll('tr')).find((r) => /Alpha/.test(r.textContent));
    log(!!doneRow && !!doneRow.querySelector('.tick-done') && !doneRow.querySelector('.tick-btn'),
      'v1.6.1: a checked-out patient shows the completed tick and no longer offers the button');

    // Reports: ranked bars now carry a count AND a share, and the day chart draws.
    const rep = (await import('../src/renderer/js/views/reports.js')).renderReports(ctx61);
    document.body.append(rep);
    for (let i = 0; i < 10; i++) await tick();
    const rows = Array.from(rep.querySelectorAll('.bar-row'));
    log(rows.length > 0 && rows.every((r) => r.querySelectorAll('.bar-val').length === 1 && r.querySelectorAll('.bar-pct').length === 1),
      'v1.6.1: every breakdown row shows both a count and its share of the total');
    const cityRows = Array.from(rep.querySelectorAll('.demo-group')).find((g) => /By city/i.test(g.textContent));
    log(!!cityRows && /%/.test(cityRows.textContent), 'v1.6.1: the by-city breakdown carries percentages for grant reporting');
    const cols = rep.querySelectorAll('.day-chart .day-col');
    log(cols.length > 0, 'v1.6.1: clinic activity is drawn as a day-by-day chart');
    log(!!rep.querySelector('.chart-key') && /Seen/.test(rep.textContent) && /Completed/.test(rep.textContent),
      'v1.6.1: the chart is labelled so the bars can be read');
    log(!!rep.querySelector('details.collapse'), 'v1.6.1: the day-by-day numbers are still available, tucked under the chart');
  }

  // ---- v1.6.2: a patient who left HAS finished; sign-ups vs check-outs ----
  {
    currentUser = signInAdmin();
    const ev62 = db.createEvent(currentUser, { name: 'Completion Test', location: 'Sandy' });
    db.setActiveEvent(currentUser, ev62.id);
    const mk62 = (last, { prereg = false, finish = false } = {}) => {
      const p = db.createPatient(currentUser, {
        first_name: 'C', last_name: last, dob: '1980-01-01', gender: 'female',
        demographics: { city: 'Sandy', state: 'OR', preregistered: prereg },
        medical_history: {}, dental_history: { visit_type: 'cleaning' },
        consents: [{ type: 'general', signer_name: 'C', signature_png: 'data:image/png;base64,AAAA' }],
      });
      db.saveVitals(currentUser, p.id, { bp_systolic: '120', bp_diastolic: '78', heart_rate: '70' });
      db.routePatient(currentUser, p.id, 'hygienist');
      if (finish) { db.saveTreatment(currentUser, p.id, { cleaning: { scaling: true } }, true); db.dismissPatient(currentUser, p.id); }
      return p;
    };
    // 2 pre-reg (1 left), 2 on-site (1 left) -> 50% checked out overall.
    mk62('PreDone', { prereg: true, finish: true });
    mk62('PreStill', { prereg: true });
    mk62('SiteDone', { finish: true });
    mk62('SiteStill', {});

    const store62 = (await import('../src/renderer/js/store.js')).store; store62.setUser(currentUser);
    const ctx62 = { navigate: () => {}, toast: () => {}, store: store62, setDetail: () => {} };
    const rp = (await import('../src/renderer/js/views/reports.js')).renderReports(ctx62);
    document.body.append(rp);
    for (let i = 0; i < 12; i++) await tick();
    // Scope to this event only, so other tests' patients don't skew the maths.
    const sel = rp.querySelector('select');
    const opt = Array.from(sel.options).find((o) => /Completion Test/.test(o.textContent));
    sel.value = opt.value; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    for (let i = 0; i < 12; i++) await tick();

    // A dismissed patient has finished — this used to read 0%.
    const kpiCards = Array.from(rp.querySelectorAll('.kpi'));
    const finishedKpi = kpiCards.find((k) => /Visits finished/i.test(k.textContent));
    log(!!finishedKpi && /\b2\b/.test(finishedKpi.querySelector('.kpi-val').textContent),
      'v1.6.2: a patient who was checked out counts as a finished visit');
    log(!!finishedKpi && /50% of 4/.test(finishedKpi.textContent) && /2 checked out/.test(finishedKpi.textContent),
      'v1.6.2: the finished KPI shows the real share and how many actually left');
    const ringTxt = rp.querySelector('.ring-top') ? rp.querySelector('.ring-top').textContent : '';
    log(/50%/.test(ringTxt), 'v1.6.2: the completion ring agrees with it');
    const ringLegend = rp.querySelector('.ring-legend').textContent;
    log(/Still in the clinic/.test(ringLegend) && /of which checked out/.test(ringLegend),
      'v1.6.2: the ring separates "finished" from "still in the clinic"');

    // Sign-ups vs check-outs, split by where they registered.
    const su = Array.from(rp.querySelectorAll('.card')).find((c) => /Sign-ups vs check-outs/i.test(c.textContent));
    log(!!su, 'v1.6.2: reports has a sign-ups vs check-outs breakdown');
    log(!!su && /2 of 4 patient\(s\) who signed up were checked out/.test(su.textContent) && /50%/.test(su.textContent),
      'v1.6.2: it states how many who signed up were checked out, as a percentage');
    const rowsSU = Array.from(su.querySelectorAll('.signup-row'));
    const preRow = rowsSU.find((r) => /Pre-registered online/.test(r.textContent));
    const siteRow = rowsSU.find((r) => /Registered on site/.test(r.textContent));
    log(!!preRow && /50% of all sign-ups/.test(preRow.textContent) && /50%/.test(preRow.querySelector('.signup-pct').textContent),
      'v1.6.2: pre-registered shows its share of sign-ups and its own check-out rate');
    log(!!siteRow && /50% of all sign-ups/.test(siteRow.textContent),
      'v1.6.2: on-site registration shows its share of sign-ups');
    const totalRow = rowsSU.find((r) => /All patients/.test(r.textContent));
    log(!!totalRow && /50%/.test(totalRow.querySelector('.signup-pct').textContent),
      'v1.6.2: the total row carries the overall check-out rate');
  }

  // ---- v1.6.2: a deleted patient STAYS deleted, everywhere ----
  {
    currentUser = signInAdmin();
    const evD = db.createEvent(currentUser, { name: 'Deletion Test' });
    db.setActiveEvent(currentUser, evD.id);
    const ghost = db.createPatient(currentUser, {
      first_name: 'Ghost', last_name: 'Gone', dob: '1980-01-01', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: 'G', signature_png: 'data:image/png;base64,AAAA' }],
    });
    db.saveVitals(currentUser, ghost.id, { bp_systolic: '120', heart_rate: '70' });

    // Capture the rows exactly as the cloud holds them BEFORE the deletion.
    const snap = db.collectSyncRows(400); db.markSynced(snap.mark);
    const liveRow = snap.rows.find((r) => r.entity === 'patient' && r.data.last_name === 'Gone');
    const liveConsent = snap.rows.find((r) => r.entity === 'consent');

    db.deletePatient(currentUser, ghost.id);
    log(!db.listPatients({ eventId: evD.id }).some((p) => p.last_name === 'Gone'),
      'v1.6.2: deleting a patient removes them locally');
    const tombs = db.collectSyncRows(400).rows.filter((r) => r.deleted);
    log(tombs.some((r) => r.entity === 'patient') && tombs.some((r) => r.entity === 'consent'),
      'v1.6.2: the deletion is queued for the cloud, chart and all');

    // The failure the clinic hit: a station still holding the old copy pushes it
    // back and the patient reappears as if nothing happened.
    db.applyRemoteRows([liveRow]);
    log(!db.listPatients({ eventId: evD.id }).some((p) => p.last_name === 'Gone'),
      'v1.6.2: an old copy arriving from another station does NOT bring them back');
    db.applyRemoteRows([liveConsent]);
    log(!db.getPatient(ghost.id), 'v1.6.2: nor does an old consent or chart row re-create them');

    // ...but a deliberate restore (a genuinely newer copy) must still work,
    // otherwise "Restore a clinic from backup" would be silently blocked.
    db.applyRemoteRows([{ ...liveRow, updated_at: '2099-12-31T23:59:59.000Z@peer' }]);
    log(db.listPatients({ eventId: evD.id }).some((p) => p.last_name === 'Gone'),
      'v1.6.2: a deliberate restore (a newer copy) still brings the patient back');

    // A deletion arriving FROM another station is remembered here too, so this
    // machine also refuses to re-create the record later.
    const back = db.listPatients({ eventId: evD.id }).find((p) => p.last_name === 'Gone');
    const uid = db.exportClinicBundle(evD.id).patients.find((p) => p.last_name === 'Gone').uid;
    db.applyRemoteRows([{ entity: 'patient', uid, deleted: 1, updated_at: '2100-01-01T00:00:00.000Z@peer', data: {} }]);
    log(!db.listPatients({ eventId: evD.id }).some((p) => p.id === back.id),
      'v1.6.2: a deletion from another station removes the patient here');
    db.applyRemoteRows([{ ...liveRow, uid, updated_at: '2099-06-01T00:00:00.000Z@peer' }]);
    log(!db.listPatients({ eventId: evD.id }).some((p) => p.last_name === 'Gone'),
      'v1.6.2: ...and this station then refuses to re-create it from an older copy');
  }

  // ---- v1.6.3: EVERY delete travels, not just the patient one ----
  {
    currentUser = signInAdmin();
    const evT = db.createEvent(currentUser, { name: 'Travel Test' });
    db.setActiveEvent(currentUser, evT.id);
    const tombUids = () => new Set(db.collectSyncRows(800).rows.filter((r) => r.deleted).map((r) => r.uid));

    // An x-ray carries its own image to every station.
    const xp = db.createPatient(currentUser, { first_name: 'X', last_name: 'Ray', demographics: {}, medical_history: {}, dental_history: {} });
    const xr = db.addXray(currentUser, xp.id, { station: 'dentist', image_png: 'data:image/jpeg;base64,AAAA', note: 'x.jpg', tooth: '14' });
    const xUid = db.exportClinicBundle(evT.id).xrays.find((x) => x.id === xr.id).uid;
    db.deleteXray(currentUser, xr.id);
    log(tombUids().has(xUid), 'v1.6.3: deleting an x-ray removes it from the cloud too, not just this laptop');

    // The empty-record cleanup says "permanently"; make sure it is.
    const junk = db.createPatient(currentUser, { first_name: 'A', last_name: 'B', demographics: {}, medical_history: {}, dental_history: {} });
    const junkUid = db.exportClinicBundle(evT.id).patients.find((p) => p.id === junk.id).uid;
    db.deleteIncompletePatients(currentUser);
    log(tombUids().has(junkUid), 'v1.6.3: clearing empty records is permanent everywhere, as the dialog claims');

    // Revoking a staff account has to revoke it on every laptop — the account
    // carries its own password hash.
    const u = db.createUser(currentUser, { username: 'gone.soon', full_name: 'Gone Soon', role: 'emt', password: 'demo1234', event_id: evT.id });
    db.collectSyncRows(800); // give the account a uid, as a first sync would
    db.deleteUser(currentUser, u.id);
    const afterUsers = db.collectSyncRows(800).rows.filter((r) => r.deleted && r.entity === 'user');
    log(afterUsers.length >= 1, 'v1.6.3: deleting a staff account revokes it on every laptop');

    // "Start fresh for next event" is a revocation, not a local tidy-up.
    const u2 = db.createUser(currentUser, { username: 'fresh.one', full_name: 'Fresh One', role: 'hygienist', password: 'demo1234', event_id: evT.id });
    db.collectSyncRows(800);
    db.clearEventStaff(currentUser, evT.id);
    const clearedTombs = db.collectSyncRows(800).rows.filter((r) => r.deleted && r.entity === 'user');
    log(clearedTombs.length >= 1, 'v1.6.3: "Start fresh for next event" revokes those accounts everywhere');

    // Force-deleting an event must clear its patients from the cloud as well.
    const ev2 = db.createEvent(currentUser, { name: 'Doomed' });
    db.setActiveEvent(currentUser, ev2.id);
    const dp = db.createPatient(currentUser, { first_name: 'Doom', last_name: 'Ed', demographics: {}, medical_history: {}, dental_history: {} });
    const dpUid = db.exportClinicBundle(ev2.id).patients.find((p) => p.id === dp.id).uid;
    db.setActiveEvent(currentUser, evT.id);
    db.deleteEvent(currentUser, ev2.id, { force: true });
    log(tombUids().has(dpUid), 'v1.6.3: force-deleting an event clears its patients from the cloud too');

    // A stale deletion must not wipe a newer local edit.
    const keep = db.createPatient(currentUser, { first_name: 'Keep', last_name: 'Me', demographics: {}, medical_history: {}, dental_history: {} });
    db.collectSyncRows(800);
    const keepUid = db.exportClinicBundle(evT.id).patients.find((p) => p.id === keep.id).uid;
    db.updatePatient(currentUser, keep.id, { first_name: 'Keep', last_name: 'Me', phone: '5035551234' });
    const stale = db.applyRemoteRows([{ entity: 'patient', uid: keepUid, deleted: 1, updated_at: '2000-01-01T00:00:00.000Z@old', data: {} }]);
    log(stale.deleted === 0 && !!db.listPatients({ eventId: evT.id }).find((p) => p.id === keep.id),
      'v1.6.3: an old deletion does not wipe a newer local edit');
  }

  // ---- v1.6.4: every patient list A–Z; treatment notes name their clinician ----
  {
    currentUser = signInAdmin();
    const evA = db.createEvent(currentUser, { name: 'Alphabetical Test' });
    db.setActiveEvent(currentUser, evA.id);
    const consent = [{ type: 'general', signer_name: 'S', signature_png: 'data:image/png;base64,AAAA' }];
    // Deliberately created out of order.
    const make = (last, route, finish) => {
      const p = db.createPatient(currentUser, {
        first_name: 'Sort', last_name: last, dob: '1980-01-01', gender: 'female',
        demographics: {}, medical_history: {}, dental_history: { visit_type: route === 'hygienist' ? 'cleaning' : 'filling' },
        consents: consent,
      });
      db.saveVitals(currentUser, p.id, { bp_systolic: '120', bp_diastolic: '78', heart_rate: '70' });
      db.routePatient(currentUser, p.id, route);
      if (finish) db.saveTreatment(currentUser, p.id, { cleaning: { scaling: true }, provider_name: 'Dr X' }, true);
      return p;
    };
    ['Zeller', 'Abbott', 'Mendez'].forEach((n) => make(n, 'hygienist'));
    ['Yates', 'Baker'].forEach((n) => make(n, 'dentist'));
    make('Quinn', 'dentist', true);
    make('Carver', 'dentist', true);

    const storeA = (await import('../src/renderer/js/store.js')).store; storeA.setUser(currentUser);
    const ctxA = { navigate: () => {}, toast: () => {}, store: storeA, setDetail: () => {} };
    const namesIn = (node) => Array.from(node.querySelectorAll('td strong, .arrival-row strong')).map((e) => e.textContent.split(',')[0]);
    const isSorted = (arr) => arr.every((v, i) => i === 0 || arr[i - 1].localeCompare(v, undefined, { sensitivity: 'base' }) <= 0);

    const views = [
      ['emt.js', 'renderEmt', 'Vitals'],
      ['hygienist.js', 'renderHygienist', 'Cleanings'],
      ['provider.js', 'renderProvider', 'Dental Triage'],
      ['checkout.js', 'renderCheckout', 'Check-Out'],
      ['records.js', 'renderRecords', 'Records'],
    ];
    for (const [file, fn, label] of views) {
      const mod = await import(`../src/renderer/js/views/${file}`);
      const node = mod[fn](ctxA, {});
      document.body.append(node);
      for (let i = 0; i < 10; i++) await tick();
      // A view may render several queues (the dentist shows its own list plus
      // who is at the hygienist); each one is sorted on its own.
      const groups = Array.from(node.querySelectorAll('tbody, .arrival-list'))
        .map((g) => Array.from(g.querySelectorAll('strong')).map((e) => e.textContent.split(',')[0]))
        .map((names) => names.filter((n) => /Zeller|Abbott|Mendez|Yates|Baker|Quinn|Carver/.test(n)))
        .filter((names) => names.length > 1);
      log(groups.length > 0 && groups.every(isSorted), `v1.6.4: the ${label} list is in A–Z order by surname`);
    }

    // A treatment note has to say who provided the care.
    const dentP = db.listPatients({ eventId: evA.id }).find((p) => p.last_name === 'Baker');
    const prov = (await import('../src/renderer/js/views/provider.js')).renderProvider(ctxA, { id: dentP.id });
    document.body.append(prov);
    for (let i = 0; i < 14; i++) await tick();
    const nameInput = Array.from(prov.querySelectorAll('input')).find((i) => i.placeholder === 'Printed name');
    log(!!nameInput && nameInput.value === currentUser.full_name,
      'v1.6.4: the dentist\'s printed name is pre-filled from who is signed in');
    nameInput.value = '';
    nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    const completeBtn = Array.from(prov.querySelectorAll('button')).find((b) => /Mark visit complete/i.test(b.textContent));
    if (completeBtn) {
      completeBtn.click();
      for (let i = 0; i < 8; i++) await tick();
      log(db.listPatients({ eventId: evA.id }).find((p) => p.id === dentP.id).status !== 'completed',
        'v1.6.4: a visit cannot be marked complete without the dentist\'s name');
    } else log(false, 'v1.6.4: (setup) the dentist has a "Mark visit complete" action');
  }

  // ---- v1.6.5: an export + delete must never destroy the reporting totals ----
  {
    currentUser = signInAdmin();
    const evR = db.createEvent(currentUser, { name: 'Report Loss Test', location: 'Sandy' });
    db.setActiveEvent(currentUser, evR.id);
    const seed = (last, city) => {
      const p = db.createPatient(currentUser, {
        first_name: 'R', last_name: last, dob: '1980-01-01', gender: 'female',
        demographics: { city, state: 'OR' }, medical_history: { conditions: ['diabetes'] },
        dental_history: { visit_type: 'extraction_pain' },
        consents: [{ type: 'general', signer_name: 'R', signature_png: 'data:image/png;base64,AAAA' }],
      });
      db.saveVitals(currentUser, p.id, { bp_systolic: '120', heart_rate: '70' });
      db.routePatient(currentUser, p.id, 'dentist');
      db.saveTreatment(currentUser, p.id, { extractions: [{ tooth: '30' }], provider_name: 'D' }, true);
      db.dismissPatient(currentUser, p.id);
      return p;
    };
    seed('Alpha', 'Sandy'); seed('Beta', 'Boring'); seed('Gamma', 'Sandy');

    const bundle = db.exportClinicBundle(evR.id);

    // THE REPORTED BUG: exporting, then using the Delete button that unlocks
    // afterwards, used to leave the event with no patients AND no totals.
    db.purgeEventPatients(currentUser, evR.id);
    log(db.listPatients({ eventId: evR.id }).length === 0, 'v1.6.5: (setup) the purge removes the patient records');
    const keptRec = db.listEventReports().find((r) => r.event_id === evR.id);
    log(!!keptRec, 'v1.6.5: deleting a clinic\'s patient data KEEPS its reporting totals');
    log(!!keptRec && keptRec.summary.patients_seen === 3 && keptRec.summary.extractions === 3,
      'v1.6.5: the kept totals are the real numbers, not zeros');
    log(!!keptRec && keptRec.summary.by_city['Sandy, OR'] === 2 && keptRec.summary.by_city['Boring, OR'] === 1,
      'v1.6.5: the by-city breakdown survives for grant reporting');
    const keptText = JSON.stringify(keptRec.summary);
    log(!/Alpha|Beta|Gamma/.test(keptText) && !/1980-01-01/.test(keptText),
      'v1.6.5: and it still holds no patient information');

    // Reports must SHOW them rather than computing zeros from an empty list.
    const storeR = (await import('../src/renderer/js/store.js')).store; storeR.setUser(currentUser);
    const ctxR = { navigate: () => {}, toast: () => {}, store: storeR, setDetail: () => {} };
    const rv = (await import('../src/renderer/js/views/reports.js')).renderReports(ctxR);
    document.body.append(rv);
    for (let i = 0; i < 12; i++) await tick();
    const sel = rv.querySelector('select');
    const opt = Array.from(sel.options).find((o) => /Report Loss Test/.test(o.textContent));
    sel.value = opt.value; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    for (let i = 0; i < 14; i++) await tick();
    const txt = rv.textContent;
    log(/patient records have been removed/i.test(txt),
      'v1.6.5: Reports says the records were removed rather than silently showing zeros');
    const kpis = Array.from(rv.querySelectorAll('.kpi')).map((k) => k.textContent);
    log(kpis.some((k) => /^3Patients seen/.test(k)) && kpis.some((k) => /Visits finished/.test(k)),
      'v1.6.5: Reports shows the kept totals for a purged clinic');
    log(/Sandy, OR/.test(txt) && /Boring, OR/.test(txt),
      'v1.6.5: the archived report still shows the by-city breakdown');

    // Recovery for a clinic that already lost its figures: recount from the
    // backup file, without bringing any patient back.
    const raw = (await import('better-sqlite3')).default;
    const before = db.listEventReports().length;
    db.applyRemoteRows([]); // no-op, keeps the import above honest
    // Wipe the kept report to imitate a clinic that purged on an older version.
    db.rebuildSummaryFromBundle(currentUser, bundle); // idempotent refresh
    const rebuilt = db.rebuildSummaryFromBundle(currentUser, bundle);
    log(rebuilt.ok && rebuilt.summary.patients_seen === 3 && rebuilt.summary.extractions === 3,
      'v1.6.5: a lost report can be rebuilt from the exported backup file');
    log(db.listPatients({ eventId: evR.id }).length === 0,
      'v1.6.5: rebuilding the report does NOT restore the patient records');
    log(db.listEventReports().filter((r) => r.event_id === evR.id).length === 1,
      'v1.6.5: rebuilding twice refreshes the report rather than duplicating it');
  }

  // ---- v1.6.6: the report data that "got removed" — the rest of the story ----
  {
    currentUser = signInAdmin();

    // 1. "All events" is the DEFAULT view of the Reports tab. It computed from
    //    the live patient list alone, so every finished clinic counted as zero —
    //    the roll-up a grant return is read off silently lost them.
    const rollAll = db.reportRollup('all');
    const liveNow = db.listPatients({ eventId: 'all' }).length;
    const keptSeen = rollAll.kept_events.reduce((n, k) => n + (Number(k.patients_seen) || 0), 0);
    log(rollAll.kept_events.some((k) => /Report Loss Test/.test(k.name || '')),
      'v1.6.6: "All events" knows about the clinics whose records were removed');
    log(keptSeen > 0 && rollAll.summary.patients_seen === liveNow + keptSeen,
      'v1.6.6: "All events" adds the kept totals to the live ones (was: finished clinics counted 0)');

    // 2. The live tab and the kept totals must count the same way. An extraction
    //    row ticked "other" with no tooth is a note, not a procedure.
    const evC = db.createEvent(currentUser, { name: 'Counting Rules', location: 'Sandy' });
    db.setActiveEvent(currentUser, evC.id);
    const pc = db.createPatient(currentUser, {
      first_name: 'Count', last_name: 'Rules', dob: '1990-05-05', gender: 'male',
      demographics: { city: 'Sandy', state: 'OR' }, medical_history: {}, dental_history: { visit_type: 'extraction_pain' },
      consents: [{ type: 'general', signer_name: 'C', signature_png: 'data:image/png;base64,AAAA' }],
    });
    db.saveVitals(currentUser, pc.id, { bp_systolic: '120', heart_rate: '70' });
    db.routePatient(currentUser, pc.id, 'dentist');
    db.saveTreatment(currentUser, pc.id, {
      extractions: [{ tooth: '30' }, { other: true }],
      cleaning: { quad_detail: 'UR', teeth: '1,2' },
      provider_name: 'D',
    }, true);
    const liveC = db.reportRollup(evC.id).summary;
    log(liveC.extractions === 1, 'v1.6.6: an "other" extraction with no tooth is not counted as a procedure');
    log(liveC.cleanings === 0, 'v1.6.6: cleaning notes alone do not count as a cleaning performed');
    db.dismissPatient(currentUser, pc.id);
    const bundleC = db.exportClinicBundle(evC.id);
    db.purgeEventPatients(currentUser, evC.id);
    const keptC = db.listEventReports().find((r) => r.event_id === evC.id).summary;
    log(keptC.extractions === liveC.extractions && keptC.cleanings === liveC.cleanings,
      'v1.6.6: the kept totals count exactly what the live tab counted');

    // 3. A purged clinic is CLOSED. Leaving it active made the next walk-in
    //    restart the count and hid the kept report behind a "live" event.
    const evAfter = db.listEvents().find((e) => e.id === evC.id);
    log(evAfter && !evAfter.active, 'v1.6.6: removing a clinic\'s records closes the clinic');

    // 4. A rebuilt report agrees with the one the clinic saw on the day.
    const reb = db.rebuildSummaryFromBundle(currentUser, bundleC);
    log(reb.summary.extractions === liveC.extractions && reb.summary.patients_seen === liveC.patients_seen,
      'v1.6.6: a report rebuilt from the backup matches the original figures');

    // 5. Deleting an event outright is the one destructive action NOT gated
    //    behind an export — its figures must survive it, and still be readable.
    const evD = db.createEvent(currentUser, { name: 'Deleted Outright', location: 'Boring' });
    db.setActiveEvent(currentUser, evD.id);
    for (const last of ['Uno', 'Dos']) {
      const p = db.createPatient(currentUser, {
        first_name: 'Del', last_name: last, dob: '1985-03-03', gender: 'female',
        demographics: { city: 'Boring', state: 'OR' }, medical_history: {}, dental_history: { visit_type: 'cleaning' },
        consents: [{ type: 'general', signer_name: 'D', signature_png: 'data:image/png;base64,AAAA' }],
      });
      db.saveVitals(currentUser, p.id, { bp_systolic: '118', heart_rate: '68' });
      db.routePatient(currentUser, p.id, 'hygienist');
      db.saveTreatment(currentUser, p.id, { cleaning: { scaling: true }, provider_name: 'H' }, true);
      db.dismissPatient(currentUser, p.id);
    }
    db.deleteEvent(currentUser, evD.id, { force: true });
    const keptD = db.listEventReports().find((r) => r.event_id === evD.id);
    log(!!keptD && keptD.summary.patients_seen === 2,
      'v1.6.6: deleting an event keeps its de-identified totals');
    const rollAfterDelete = db.reportRollup('all');
    log(rollAfterDelete.kept_events.some((k) => k.id === evD.id && k.event_deleted),
      'v1.6.6: a deleted clinic\'s figures still appear in "All events"');

    // 6. One report row per event, whatever happens. Two stations finishing the
    //    same clinic offline used to leave two rows and double the roll-up.
    db.captureEventSummary(currentUser, evC.id);
    db.captureEventSummary(currentUser, evC.id);
    log(db.listEventReports().filter((r) => r.event_id === evC.id).length === 1,
      'v1.6.6: an event can only ever have one report row');

    // 7. Age is counted AS OF THE VISIT, so rebuilding a report years later does
    //    not move someone into a different age band.
    const evAge = db.createEvent(currentUser, { name: 'Age Bands', location: 'Sandy' });
    db.setActiveEvent(currentUser, evAge.id);
    const teen = db.createPatient(currentUser, {
      first_name: 'Almost', last_name: 'Adult', dob: '2009-01-01', gender: 'male',
      demographics: { city: 'Sandy', state: 'OR' }, medical_history: {}, dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: 'A', signature_png: 'data:image/png;base64,AAAA' }],
    });
    { const h = rawDb(); h.prepare('UPDATE patients SET created_at = ? WHERE id = ?').run('2020-06-01T10:00:00.000Z', teen.id); h.close(); }
    const ageSum = db.reportRollup(evAge.id).summary;
    log((ageSum.by_age['Under 18'] || 0) === 1,
      'v1.6.6: age is counted as of the visit, not as of today');

    // 8. And the tab itself — its DEFAULT view — must show those numbers.
    const storeA = (await import('../src/renderer/js/store.js')).store; storeA.setUser(currentUser);
    const ctxA = { navigate: () => {}, toast: () => {}, store: storeA, setDetail: () => {} };
    const av = (await import('../src/renderer/js/views/reports.js')).renderReports(ctxA);
    document.body.append(av);
    for (let i = 0; i < 14; i++) await tick();
    const expected = db.reportRollup('all').summary.patients_seen;
    const seenKpi = Array.from(av.querySelectorAll('.kpi')).find((k) => /Patients seen/.test(k.textContent));
    log(!!seenKpi && seenKpi.textContent.startsWith(String(expected)) && expected > 0,
      'v1.6.6: the Reports tab opens on a total that includes the finished clinics');
    log(/records have been removed|records removed/i.test(av.textContent),
      'v1.6.6: it says plainly which figures come from clinics whose records are gone');
    // The heading followed the ACTIVE event even when another was selected.
    const selA = av.querySelector('select');
    const optA = Array.from(selA.options).find((o) => /Age Bands/.test(o.textContent));
    selA.value = optA.value; selA.dispatchEvent(new window.Event('change', { bubbles: true }));
    for (let i = 0; i < 14; i++) await tick();
    log(/Age Bands/.test(av.querySelector('.view-sub').textContent),
      'v1.6.6: the heading names the clinic whose numbers are on screen');
    av.remove();

    // 9. A report kept by the PREVIOUS version holds only the headline counts.
    //    It must still contribute them — and the page has to say what is missing
    //    rather than printing a check-out rate of 0% as though it were measured.
    {
      const h = rawDb();
      const rec = h.prepare('SELECT * FROM event_reports WHERE event_id = ?').get(evC.id);
      const oldSummary = JSON.parse(rec.summary);
      ['checked_out', 'flagged', 'patients_with_xray', 'pre_signups', 'pre_checked_out',
        'onsite_signups', 'onsite_checked_out', 'by_status', 'days'].forEach((k) => { delete oldSummary[k]; });
      h.prepare('UPDATE event_reports SET summary = ? WHERE id = ?').run(JSON.stringify(oldSummary), rec.id);
      h.close();
      const legacyRoll = db.reportRollup(evC.id).summary;
      log(legacyRoll.patients_seen === oldSummary.patients_seen && legacyRoll.legacy_parts === 1,
        'v1.6.6: totals kept by the previous version still count, and are marked as incomplete');

      const lv = (await import('../src/renderer/js/views/reports.js')).renderReports(ctxA);
      document.body.append(lv);
      for (let i = 0; i < 14; i++) await tick();
      const selL = lv.querySelector('select');
      const optL = Array.from(selL.options).find((o) => /Counting Rules/.test(o.textContent));
      selL.value = optL.value; selL.dispatchEvent(new window.Event('change', { bubbles: true }));
      for (let i = 0; i < 14; i++) await tick();
      log(/before this breakdown existed/i.test(lv.textContent),
        'v1.6.6: the page says which figures an older kept report cannot answer');
      lv.remove();
    }
  }

  // ---- v1.6.6: a deletion that could not be applied is retried, not lost ----
  {
    currentUser = signInAdmin();
    const evX = db.createEvent(currentUser, { name: 'FK Order Clinic', location: 'Sandy' });
    db.setActiveEvent(currentUser, evX.id);
    const px = db.createPatient(currentUser, {
      first_name: 'Fk', last_name: 'Order', dob: '1970-02-02', gender: 'male',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: 'F', signature_png: 'data:image/png;base64,AAAA' }],
    });
    db.collectSyncRows(); // hands out the uids the cloud keys rows by
    const hx = rawDb();
    const evUid = hx.prepare('SELECT uid FROM events WHERE id = ?').get(evX.id).uid;
    const pxUid = hx.prepare('SELECT uid FROM patients WHERE id = ?').get(px.id).uid;
    const stillHere = (table, id) => !!hx.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
    const later = new Date(Date.now() + 60000).toISOString();

    // Another station deleted the whole clinic. The event tombstone alone cannot
    // be applied while this station still holds the patients — that used to be
    // swallowed as a silent skip and never retried, so the clinic lived on here.
    const evOnly = db.applyRemoteRows([{ entity: 'event', uid: evUid, deleted: true, updated_at: later }]);
    log(stillHere('events', evX.id) && evOnly.deferredRows.length === 1,
      'v1.6.6: an event deletion that its patients block is handed back for retry, not dropped');

    // With the patient's tombstone in the same batch, deletions apply
    // children-first and the whole clinic goes.
    const both = db.applyRemoteRows([
      { entity: 'event', uid: evUid, deleted: true, updated_at: later },
      { entity: 'patient', uid: pxUid, event_uid: evUid, deleted: true, updated_at: later },
    ]);
    log(!stillHere('events', evX.id) && both.deleted === 2,
      'v1.6.6: a clinic deleted on another station is removed here too');

    // And a stray child for a clinic that was deleted here is dropped rather
    // than parked in the retry buffer for ever.
    const stray = db.applyRemoteRows([{ entity: 'patient', uid: 'stray-' + pxUid, event_uid: evUid,
      updated_at: later, data: { first_name: 'Stray', last_name: 'Child' } }]);
    log(stray.deferredRows.length === 0,
      'v1.6.6: a record whose clinic was deleted here is not retried for ever');
    hx.close();
  }

  /* ================= MMW v0.0.1 — wristband, scanning, Clearance vitals ========
     The EMR flow keys every station off a scanned band, so these cover the
     whole path: issue a code, encode it, scan it back, and record the four
     vitals the printed Clearance band asks for. */
  {
    const { code128Modules } = await import('../src/renderer/js/components/barcode.js');

    const evW = db.createEvent(currentUser, { name: 'Wristband Clinic' });
    db.setActiveEvent(currentUser, evW.id);
    const w1 = db.createPatient(currentUser, { first_name: 'Ana', last_name: 'Ruiz', dob: '1990-04-02',
      gender: 'female', demographics: { city: 'Yorba Linda', state: 'CA', services: ['dental', 'vision'] } });
    const w2 = db.createPatient(currentUser, { first_name: 'Bo', last_name: 'Chen', dob: '1985-01-09' });
    const g1 = db.getPatient(w1.id), g2 = db.getPatient(w2.id);

    log(/^[0-9]{6}$/.test(g1.patient_code || ''), 'MMW: registration issues a 6-digit wristband ID');
    log(g1.patient_code !== g2.patient_code, 'MMW: two patients never share a wristband ID');

    // A scanner types the digits then presses Enter, so trailing CR/whitespace
    // is the normal case, not an edge case.
    const scanned = db.findPatientByCode('  ' + g1.patient_code + '\r\n');
    log(!!scanned && scanned.id === g1.id, 'MMW: scanning a band resolves to that patient');
    log(db.findPatientByCode('000001') === null, 'MMW: an unknown band resolves to nothing rather than a wrong patient');

    // The barcode has to be a real Code 128 frame or no scanner will read it:
    // start + data + modulo-103 check + stop.
    const mods = code128Modules(g1.patient_code);
    log(mods.reduce((a, b) => a + b, 0) === 11 * 5 + 13,
      'MMW: the wristband barcode is a well-formed Code 128 frame');
    log(JSON.stringify(code128Modules('123456'))
      === JSON.stringify(['211232', '112232', '131123', '331121', '132131', '2331112'].join('').split('').map(Number)),
      'MMW: Code 128 subset C encoding matches the standard (check digit 44)');

    // Clearance records BP / BS / PULSE / RESP, per the printed record.
    db.saveVitals(currentUser, w1.id, { bp_systolic: 128, bp_diastolic: 82, heart_rate: 74, glucose: 104, respiration: 16 });
    const v = db.getPatient(w1.id).triage;
    log(v.glucose === 104 && v.respiration === 16, 'MMW: Clearance records blood sugar and respiration');
    // A later review-only save must not silently wipe them.
    db.saveVitals(currentUser, w1.id, { blood_thinner: 'no' });
    const v2 = db.getPatient(w1.id).triage;
    log(v2.glucose === 104 && v2.respiration === 16 && v2.bp_systolic === 128,
      'MMW: a review-only save does not wipe the recorded vitals');

    log(JSON.stringify(db.getPatient(w1.id).demographics.services) === JSON.stringify(['dental', 'vision']),
      'MMW: the services chosen at registration are kept on the record');
  }

  /* ======= MMW v0.0.5 — the shipped administrator, and setup after a reset ===
     A fresh install signs in with admin / admin. That is a known credential on a
     machine holding patient records, so these cover three things: that it works
     out of the box, that the app can still tell it is in place (which is what
     drives the warnings), and that it stops being reported the moment it is
     changed. The first-run setup path still exists for a machine that has been
     reset, so it is exercised too. */
  {
    // On THIS database the seeded administrator is what the harness signed in
    // with at startup, so its working is already implied — assert it directly
    // anyway, because it is the single thing an installer has to get right.
    log(!!db.login('admin', 'admin'), 'MMW admin: a fresh install signs in with admin / admin');
    log(db.needsSetup() === false, 'MMW admin: an install with an account does not ask for setup');
    log(db.defaultAdminActive() === true, 'MMW admin: the app knows the shipped password is still in place');

    // The seeded admin carries the shared sync identity, and is back-dated so a
    // freshly imaged laptop always LOSES last-write-wins to one whose password
    // was actually set. Without that, installing the app on a new laptop and
    // syncing would reset the clinic's real administrator password.
    {
      const raw = rawDb();
      const row = raw.prepare("SELECT uid, updated_at FROM users WHERE username = 'admin'").get();
      raw.close();
      log(row.uid === '00000000-0000-4000-8000-000000000002',
        'MMW admin: the seeded administrator uses the shared sync identity, not one per laptop');
      log(String(row.updated_at || '').startsWith('0000-01-01'),
        'MMW admin: the untouched seeded administrator is back-dated so it loses to a real password');
    }

    // The security property: createFirstAdmin is reachable without signing in,
    // so it must refuse outright once any account exists.
    let blocked = false;
    try { db.createFirstAdmin({ full_name: 'Mallory', username: 'mallory', password: 'password123' }); }
    catch (_) { blocked = true; }
    log(blocked, 'MMW admin: a second administrator cannot be created through setup');

    // Everything else needs databases in states this one cannot reach (a fresh
    // install, and a reset one), which means a separate process — the data layer
    // holds a single connection.
    const { execFileSync } = await import('node:child_process');
    const probe = `
      const os=require('os'),fs=require('fs'),path=require('path');
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mmwsetup-'));
      const dbmod=process.argv[2];
      const db=require(dbmod); const file=db.init(dir);
      const out={};

      /* --- a brand new install --- */
      out.freshSignsIn = !!db.login('admin','admin');
      out.freshNoSetup = db.needsSetup() === false;
      out.freshDefaultFlag = db.defaultAdminActive() === true;
      out.freshRole = (db.login('admin','admin')||{}).role === 'admin';
      out.wrongPwFails = !db.login('admin','wrong');

      /* --- once the password is changed, the app stops reporting it --- */
      const admin = db.login('admin','admin');
      db.updateUser(admin, admin.id, { password: 'a-real-clinic-password' });
      out.changedFlagClears = db.defaultAdminActive() === false;
      out.changedSignsIn = !!db.login('admin','a-real-clinic-password');
      out.oldPwDead = !db.login('admin','admin');

      /* --- a wiped machine: setup until it is restarted, then seeded again --- */
      db.resetClinicData();
      out.resetNeedsSetup = db.needsSetup() === true;
      out.rejects = [];
      for (const bad of [{},{full_name:'A'},{full_name:'A',username:'ab'},{full_name:'A',username:'anna',password:'short'}]) {
        try { db.createFirstAdmin(bad); out.rejects.push(false); } catch(e){ out.rejects.push(true); }
      }
      const u = db.createFirstAdmin({full_name:'Anna Reed',username:'Anna.Reed',password:'clinic2026'});
      out.role = u.role;
      out.lowercased = u.username === 'anna.reed';
      out.signsIn = !!db.login('anna.reed','clinic2026');
      out.setupDone = db.needsSetup() === false;
      // Must NOT reuse the shared seeded-admin uid: two laptops each set up by
      // hand would then share one sync identity, and last-write-wins would
      // overwrite one administrator's password.
      const raw = new (require('better-sqlite3'))(file);
      out.uid = raw.prepare("SELECT uid FROM users WHERE username='anna.reed'").get().uid;
      raw.close();
      db.close(); fs.rmSync(dir,{recursive:true,force:true});

      /* --- upgrading a machine that was ALREADY set up on an older build ---
         seed() only fires on an empty database, so before the one-time
         bootstrap migration these installs never got admin/admin — which is
         exactly what was reported from a real install. */
      const B=require('better-sqlite3');
      const dirU=fs.mkdtempSync(path.join(os.tmpdir(),'mmwupg-'));
      const fileU=db.init(dirU);
      db.createUser(db.login('admin','admin'),{username:'anna',full_name:'Anna Reed',role:'admin',password:'annapw1234'});
      db.close();
      let ru=new B(fileU);
      ru.prepare("DELETE FROM audit_log").run();
      ru.prepare("DELETE FROM users WHERE username='admin'").run();          // an older build had no such row
      ru.prepare("DELETE FROM settings WHERE key='bootstrap_admin_v1'").run(); // and no migration flag
      ru.close();
      db.init(dirU);                                    // the upgraded launch
      out.upgradeSignsIn = !!db.login('admin','admin');
      out.upgradeKeepsExisting = !!db.login('anna','annapw1234');
      db.close(); fs.rmSync(dirU,{recursive:true,force:true});

      /* --- an 'admin' account that exists with some OTHER password --- */
      const dirO=fs.mkdtempSync(path.join(os.tmpdir(),'mmwother-'));
      const fileO=db.init(dirO);
      const ao=db.login('admin','admin');
      db.updateUser(ao, ao.id, { password: 'somethingelse' });
      db.close();
      let ro=new B(fileO); ro.prepare("DELETE FROM settings WHERE key='bootstrap_admin_v1'").run(); ro.close();
      db.init(dirO);
      out.repairsWrongPassword = !!db.login('admin','admin');
      db.close(); fs.rmSync(dirO,{recursive:true,force:true});

      /* --- but a deliberate password change must NOT be undone on restart --- */
      const dirK=fs.mkdtempSync(path.join(os.tmpdir(),'mmwkeep-'));
      db.init(dirK);
      const ak=db.login('admin','admin');
      db.updateUser(ak, ak.id, { password: 'a-real-clinic-password' });
      db.close();
      db.init(dirK);
      out.keepsChangedPassword = !db.login('admin','admin') && !!db.login('admin','a-real-clinic-password');
      db.close(); fs.rmSync(dirK,{recursive:true,force:true});

      /* --- a wipe followed by the restart the app actually does --- */
      const dir2=fs.mkdtempSync(path.join(os.tmpdir(),'mmwreset-'));
      db.init(dir2);
      db.resetClinicData();
      db.close();
      db.init(dir2);   // the restart
      out.reseedsAfterRestart = !!db.login('admin','admin');
      out.reseedEvent = !!db.getActiveEvent();
      db.close(); fs.rmSync(dir2,{recursive:true,force:true});

      process.stdout.write(JSON.stringify(out));
    `;
    // fileURLToPath, not URL.pathname: on Windows the latter yields
    // "/D:/a/..." — a leading slash that require() cannot resolve.
    const { fileURLToPath } = await import('node:url');
    const dbPath = fileURLToPath(new URL('../src/main/db.js', import.meta.url));
    // Written to a .cjs file rather than passed with -e: a multi-line script as
    // an argv entry depends on the platform's command-line quoting, and this
    // harness has to behave identically on the Windows build runner.
    //
    // It lives beside this harness rather than in the OS temp dir because Node
    // resolves require() from the script's own directory — better-sqlite3 is
    // only reachable from inside the repo.
    const probeFile = path.join(fileURLToPath(new URL('.', import.meta.url)), '.setup-probe.cjs');
    let r;
    try {
      fs.writeFileSync(probeFile, probe);
      r = JSON.parse(execFileSync(process.execPath, [probeFile, dbPath], { encoding: 'utf8' }));
    } finally {
      fs.rmSync(probeFile, { force: true });
    }
    log(r.freshSignsIn && r.freshRole, 'MMW admin: a brand new install signs in as an administrator with admin / admin');
    log(r.freshNoSetup, 'MMW admin: a brand new install goes straight to sign-in, not setup');
    log(r.freshDefaultFlag, 'MMW admin: a brand new install reports the shipped password as still in place');
    log(r.wrongPwFails, 'MMW admin: a wrong password is still refused');
    log(r.changedFlagClears, 'MMW admin: changing the password clears the shipped-password warning');
    log(r.changedSignsIn && r.oldPwDead, 'MMW admin: the new password works and admin / admin stops working');
    log(r.upgradeSignsIn, 'MMW admin: upgrading a machine that was already set up gets admin / admin too');
    log(r.upgradeKeepsExisting, 'MMW admin: upgrading does not disturb the account that was already there');
    log(r.repairsWrongPassword, 'MMW admin: an admin account left on some other password is repaired once');
    log(r.keepsChangedPassword, 'MMW admin: a deliberately changed password is never forced back to admin');
    log(r.resetNeedsSetup, 'MMW admin: a wiped machine has no account until it is restarted');
    log(r.reseedsAfterRestart, 'MMW admin: restarting after a reset puts admin / admin back, so the laptop is never stranded');
    log(r.reseedEvent, 'MMW admin: the reset machine also gets its clinic event back on restart');
    log(r.rejects.every(Boolean), 'MMW setup: blank name, short username and weak password are all refused');
    log(r.role === 'admin' && r.lowercased, 'MMW setup: the first account is an administrator, username normalised');
    log(r.signsIn, 'MMW setup: the chosen password works');
    log(r.setupDone, 'MMW setup: setup does not run again once an account exists');
    log(r.uid !== '00000000-0000-4000-8000-000000000002',
      'MMW setup: an administrator created by hand does not reuse the shared admin sync identity');
  }

  /* ================= MMW v0.0.8 — the patient exit survey ====================
     Taken at check-out, for grant reporting. The things that matter: that it
     stores only answers the survey actually offers, that declining is a real
     answer rather than an absence, that the aggregate is counts-only, and that
     the two copies of the question schema (renderer form, data-layer
     validation) cannot drift apart. */
  {
    const sp = await import('../src/renderer/i18n/exitSurvey.js');

    // The two schemas are written out separately — one ES module for the form,
    // one CommonJS object for validation — because the renderer and the data
    // layer cannot import each other. If they ever disagree, answers the form
    // collects get silently dropped on save, which is the worst possible
    // failure: the clinic sees a completed survey and the report sees nothing.
    const uiKeys = sp.QUESTIONS.map((q) => q.key).sort();
    const dbKeys = Object.keys(db.SURVEY_SCHEMA).sort();
    log(JSON.stringify(uiKeys) === JSON.stringify(dbKeys),
      'MMW survey: the form and the data layer ask exactly the same questions');
    let optsMatch = true, multiMatch = true;
    for (const q of sp.QUESTIONS) {
      const ui = q.options.map((o) => o.value).sort();
      const dbv = (db.SURVEY_SCHEMA[q.key] || []).slice().sort();
      if (JSON.stringify(ui) !== JSON.stringify(dbv)) { optsMatch = false; log(false, `  schema drift on ${q.key}: ui=${ui} db=${dbv}`); }
      if ((q.type === 'multi') !== db.SURVEY_MULTI.has(q.key)) multiMatch = false;
    }
    log(optsMatch, 'MMW survey: every question offers the same options on both sides');
    log(multiMatch, 'MMW survey: select-all-that-apply questions agree on both sides');
    log(sp.QUESTIONS.every((q) => q.en && q.es) && sp.QUESTIONS.every((q) => q.options.every((o) => o.en && o.es)),
      'MMW survey: every question and option is translated into Spanish');
    log(sp.SECTIONS.every((sec) => sec.en && sec.es), 'MMW survey: every section heading is translated');

    currentUser = signInAdmin();
    const sp1 = db.createPatient(currentUser, { first_name: 'Survey', last_name: 'One', language: 'es', demographics: {}, medical_history: {}, dental_history: {} });
    const saved = db.saveExitSurvey(currentUser, sp1.id, {
      version: sp.SURVEY_VERSION, language: 'es',
      answers: {
        first_time: 'yes', income: '0_15k', living_situation: 'homeless',
        assistance: ['snap', 'wic', 'snap'],        // duplicated tick
        access_barriers: ['cost', 'made_up_thing'], // one real, one junk
        rate_care: '5',
        employment: 'not_a_status',                 // value the question never offers
        totally_unknown_question: 'x',
      },
    });
    log(saved.answers.first_time === 'yes' && saved.answers.rate_care === '5',
      'MMW survey: answers are stored against the patient');
    log(JSON.stringify(saved.answers.assistance) === JSON.stringify(['snap', 'wic']),
      'MMW survey: a repeated tick on a select-all question is only counted once');
    log(JSON.stringify(saved.answers.access_barriers) === JSON.stringify(['cost']),
      'MMW survey: an option the question does not offer is dropped');
    log(saved.answers.employment === undefined && saved.answers.totally_unknown_question === undefined,
      'MMW survey: unknown questions and impossible values never reach the database');
    log(db.getPatient(sp1.id).exit_survey.answers.living_situation === 'homeless',
      'MMW survey: the survey comes back on the patient record');

    // Declining is an answer. Without it a required survey would force staff to
    // invent responses for a patient who does not want to disclose their income.
    const sp2 = db.createPatient(currentUser, { first_name: 'Survey', last_name: 'Two', demographics: {}, medical_history: {}, dental_history: {} });
    const dec = db.saveExitSurvey(currentUser, sp2.id, { declined: true });
    log(dec.declined === true && Object.keys(dec.answers).length === 0,
      'MMW survey: declining records a refusal and stores no answers');

    // Re-answering corrects rather than duplicating, or a household would be
    // counted twice in a grant return.
    db.saveExitSurvey(currentUser, sp1.id, { answers: { first_time: 'no' } });
    const again = db.getExitSurvey(sp1.id);
    log(again.answers.first_time === 'no' && again.answers.rate_care === undefined,
      'MMW survey: answering again replaces the response rather than adding a second one');

    // The aggregate: counts only, and nothing that belongs to a person.
    const sum = db.buildEventSummary();
    const blob = JSON.stringify(sum.survey);
    log(sum.survey.responses >= 1 && sum.survey.declined >= 1,
      'MMW survey: the summary counts completions and refusals separately');
    log(!blob.includes('Survey') && !blob.includes('One') && !/patient_id/.test(blob),
      'MMW survey: the aggregate carries counts only — no names, no patient ids');
    log(Object.values(sum.survey.answers).every((o) => Object.values(o).every((n) => typeof n === 'number')),
      'MMW survey: every aggregated value is a number');

    // A clinic that has been through a purge must keep its survey totals, since
    // that is the whole reason the figures are de-identified.
    const merged = db.mergeSummaries([sum, sum]);
    log(merged.survey.responses === sum.survey.responses * 2,
      'MMW survey: merging two clinics adds their survey totals together');
    log(merged.survey.answers.first_time.no === (sum.survey.answers.first_time.no || 0) * 2,
      'MMW survey: merging adds option counts question by question');
  }

  /* ===== "Not applicable" must not leak as a raw code ======================
     Pregnancy gained a third answer at check-in. Two files outside the renderer
     print that value straight through, so the patient's printed record and the
     clinic export would have read "na" next to "Pregnant / nursing". This is the
     seam between the screen that collects a value and everything that prints it
     — the place a new option quietly escapes. */
  {
    currentUser = signInAdmin();
    const naP = db.createPatient(currentUser, {
      first_name: 'Not', last_name: 'Applicable', dob: '1970-01-02', gender: 'male',
      demographics: { city: 'Sandy', state: 'OR' },
      medical_history: { pregnancy: 'na', tobacco: 'no', conditions: ['none'], allergies: ['none'] },
      dental_history: { visit_type: 'cleaning' },
    });
    const { buildHtml } = require('../src/main/pdf.js');
    // 'full' is the packet that carries the medical history block; 'summary'
    // and 'progress' do not print this field at all.
    const recHtml = buildHtml(db.getPatient(naP.id), 'full');
    log(/Pregnant \/ nursing/.test(recHtml), 'na: the full patient packet prints the pregnancy answer');
    log(/Not applicable/.test(recHtml), 'na: it says "Not applicable", not "na"');
    log(!/<div class="val">na<\/div>/.test(recHtml), 'na: no raw code reaches the printed record');

    const { clinicSheets } = require('../src/main/clinicSheets.js');
    const sheets = clinicSheets(db.exportClinicBundle());
    const patientSheet = sheets.find((x) => /patient/i.test(x.name));
    const flat = JSON.stringify(patientSheet.rows);
    log(!/"na"/.test(flat), 'na: no raw code reaches the clinic spreadsheet');
    log(/Not applicable/.test(flat), 'na: the spreadsheet spells it out');

    // Both forms must agree on what a complete history is. The walk-in form
    // offers the third answer; the online one has to accept it.
    const wSrc = require('node:fs').readFileSync(new URL('../cloud/worker.js', import.meta.url), 'utf8');
    log(/v === 'na'/.test(wSrc), 'na: the online form counts "Not applicable" as answered');
    // v0.0.15: the pregnancy question is the pregnancy row of the conditions
    // table, and it alone carries the fourth answer — offered and accepted.
    log(/k === 'pregnant' \? \['na'\]/.test(wSrc) && /k === 'pregnant' && v === 'na'/.test(wSrc),
      'na: and offers and accepts it on the pregnancy row only');
  }

  /* ===== v0.0.15 intake — Dr. Trinh's history, Step 3, City, no survey =====
     The medical history became Dr. Trinh's form (25 conditions answered Yes /
     No / Unsure, an allergy gate, a medication checklist, major surgery, "Do
     you smoke?"), Step 3 became his eight questions, City became the event's
     own list, and the survey left registration. Every record taken before this
     is still on disk, in the cloud and in backups, so each check below looks at
     an OLD record and a NEW one side by side: an old record must still read
     truthfully everywhere it did (an unticked box is "not reported", never
     "No"), and a new one must read the same on every screen and export. */
  {
    currentUser = signInAdmin();
    const fsV = require('node:fs');
    const srcV = (rel) => fsV.readFileSync(new URL(rel, import.meta.url), 'utf8');
    const st = await import('../src/renderer/i18n/strings.js');
    const mhx = await import('../src/renderer/js/medicalHistory.js');
    const ml = require('../src/main/medicalLabels.js');
    const i18nV = await import('../src/renderer/js/i18n.js');
    i18nV.setLang('en');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // ---- the catalogues: his lists, in his order, retired entries kept ----
    const INTAKE_25 = ['high_bp', 'diabetes', 'heart_disease', 'heart_attack', 'stroke', 'high_cholesterol', 'asthma', 'copd',
      'kidney', 'liver', 'thyroid', 'cancer', 'epilepsy', 'bleeding', 'blood_clot', 'anemia', 'arthritis', 'osteoporosis',
      'ulcers', 'mental_health', 'sleep_apnea', 'tuberculosis', 'hiv', 'autoimmune', 'pregnant'];
    const intakeConds = st.CONDITIONS.filter((c) => c.intake !== false);
    log(same(intakeConds.map((c) => c.key), INTAKE_25), 'v0.0.15: check-in asks Dr. Trinh\'s 25 conditions, in his order');
    log(same(intakeConds.filter((c) => c.flag).map((c) => c.key),
      ['high_bp', 'diabetes', 'heart_disease', 'heart_attack', 'stroke', 'liver', 'epilepsy', 'bleeding', 'blood_clot', 'osteoporosis', 'tuberculosis', 'hiv', 'pregnant']),
    'v0.0.15: the red-flag conditions are the agreed set (liver absorbs hepatitis; osteoporosis for bone drugs)');
    const RETIRED_C = ['heart_murmur', 'pacemaker', 'artificial_valve', 'rheumatic_fever', 'hepatitis', 'blood_thinners', 'glaucoma',
      'respiratory', 'latex', 'anesthesia_reaction', 'pain_mgmt', 'weight_mgmt'];
    log(RETIRED_C.every((k) => { const c = st.CONDITIONS.find((x) => x.key === k); return c && c.intake === false && c.en && c.es; })
      && st.CONDITIONS.find((c) => c.key === 'heart_murmur').en === 'Heart murmur' && st.CONDITIONS.find((c) => c.key === 'hepatitis').flag === true,
    'v0.0.15: every retired condition still resolves, under its OLD name and flag, for the records that hold it');
    log(st.CONDITIONS.every((c) => /^[a-z_]+$/.test(c.key) && c.en && c.es), 'v0.0.15: every condition is translated into Spanish');
    const intakeAll = st.ALLERGIES.filter((a) => a.intake !== false).map((a) => a.key);
    log(same(intakeAll, ['penicillin', 'amoxicillin', 'ampicillin', 'cephalosporins', 'sulfa', 'azithromycin', 'clindamycin', 'metronidazole',
      'doxycycline', 'fluoroquinolones', 'aspirin', 'ibuprofen_nsaids', 'tylenol', 'codeine', 'hydrocodone', 'oxycodone', 'morphine',
      'lidocaine', 'general_anesthetic', 'anticonvulsant', 'bp_medication', 'diuretic', 'diabetes_medication', 'steroid']),
    'v0.0.15: the allergy checklist is Dr. Trinh\'s 24, in his order');
    log(['articaine', 'mepivacaine', 'bupivacaine', 'prilocaine', 'amoxicillin_clavulanate', 'erythromycin', 'nsaids', 'novocain']
      .every((k) => { const a = st.ALLERGIES.find((x) => x.key === k); return a && a.intake === false; })
      && st.ALLERGIES.find((a) => a.key === 'nsaids').en === 'NSAIDs (Ibuprofen, Aspirin)',
    'v0.0.15: retired allergies keep their old names — an old "NSAIDs (Ibuprofen, Aspirin)" still says aspirin');
    log(st.MED_CHECKLIST.length === 25 && st.MED_CHECKLIST.every((m) => m.key && m.en && m.es) && st.MEDICATIONS.length === 100,
      'v0.0.15: his 25-medication checklist, with the 100-drug list kept for "Other"');
    log(same(st.SURGERY_SITES.map((x) => x.key), ['knee', 'elbow', 'hip', 'neck', 'heart', 'leg', 'arm', 'lung', 'kidney', 'liver']),
      'v0.0.15: major surgery offers his ten body sites');
    log(same(st.DENTAL_QUESTIONS.map((q) => q.key), ['pain_cold', 'pain_hot', 'pain_eating', 'toothache_night', 'pain_touch', 'grinding_night', 'jaw_pain_waking', 'sores'])
      && st.DENTAL_QUESTIONS.every((q) => q.en && q.es && q.short),
    'v0.0.15: Step 3 is his eight questions (grinding at night is a NEW key; sores reuses the old one)');

    // ---- the copies, pinned: online form, main-process labels, data layer ----
    const wSrcV = srcV('../cloud/worker.js');
    const pairs = (name) => {
      const m = wSrcV.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\n\\];'));
      return m ? Array.from(m[1].matchAll(/\['([a-z_]+)', '((?:[^'\\]|\\.)*)'\]/g)).map((x) => [x[1], x[2]]) : null;
    };
    const expect = (list, lang) => list.map((x) => [x.key, x[lang]]);
    log(same(pairs('FORM_CONDITIONS'), expect(intakeConds, 'en')) && same(pairs('FORM_CONDITIONS_ES'), expect(intakeConds, 'es')),
      'v0.0.15: the online form asks the same 25 conditions, same order, same words (English and Spanish)');
    const intakeAllergyItems = st.ALLERGIES.filter((a) => a.intake !== false);
    log(same(pairs('FORM_ALLERGIES'), expect(intakeAllergyItems, 'en')) && same(pairs('FORM_ALLERGIES_ES'), expect(intakeAllergyItems, 'es')),
      'v0.0.15: the online form offers the same allergy list, word for word, in both languages');
    log(same(pairs('FORM_MED_CHECKLIST'), expect(st.MED_CHECKLIST, 'en')) && same(pairs('FORM_MED_CHECKLIST_ES'), expect(st.MED_CHECKLIST, 'es')),
      'v0.0.15: the online medication checklist stores the same canonical names');
    log(same(pairs('FORM_SURGERY_SITES'), expect(st.SURGERY_SITES, 'en')) && same(pairs('FORM_SURGERY_SITES_ES'), expect(st.SURGERY_SITES, 'es')),
      'v0.0.15: the online form offers the same surgery sites');
    log(same(pairs('FORM_DENTAL_YESNO'), expect(st.DENTAL_QUESTIONS, 'en')) && same(pairs('FORM_DENTAL_YESNO_ES'), expect(st.DENTAL_QUESTIONS, 'es')),
      'v0.0.15: the online Step 3 is the same eight questions, word for word');
    const enCat = st.CATALOG.en.intake, esCat = st.CATALOG.es.intake;
    log(same(pairs('FORM_MED_YESNO'), [['under_treatment', enCat.underTreatment], ['major_surgery', enCat.majorSurgery], ['tobacco', enCat.tobacco]])
      && same(pairs('FORM_MED_YESNO_ES'), [['under_treatment', esCat.underTreatment], ['major_surgery', esCat.majorSurgery], ['tobacco', esCat.tobacco]]),
    'v0.0.15: doctor\'s care, major surgery and "Do you smoke?" read the same online as at the kiosk');
    const enLabels = (list) => Object.fromEntries(list.map((x) => [x.key, x.en]));
    log(same(ml.CONDITION_LABELS, enLabels(st.CONDITIONS)) && same(ml.ALLERGY_LABELS, enLabels(st.ALLERGIES))
      && same(ml.MED_CHECKLIST_LABELS, enLabels(st.MED_CHECKLIST)) && same(ml.SURGERY_SITE_LABELS, enLabels(st.SURGERY_SITES)),
    'v0.0.15: the printed record and spreadsheet name everything exactly as the app does (medicalLabels.js pinned)');
    log(same(ml.FLAG_CONDITIONS, st.CONDITIONS.filter((c) => c.flag).map((c) => c.key)) && same(ml.INTAKE_CONDITIONS, INTAKE_25)
      && same(ml.DENTAL_Q_LABELS, Object.fromEntries(st.DENTAL_QUESTIONS.map((q) => [q.key, q.short])))
      && same(ml.DENTAL_LEGACY_LABELS, Object.fromEntries(st.DENTAL_LEGACY.map((q) => [q.key, q.label]))),
    'v0.0.15: the main process agrees on the red flags, the 25 asked, and the Step 3 labels');
    log(same(ml.ALLERGY_STATUS_LABELS, { nkda: enCat.nkda, yes: st.CATALOG.en.common.yes, unsure: enCat.unsure })
      && /ALLERGY_STATUS = medicalLabels\.ALLERGY_STATUS_LABELS/.test(srcV('../src/main/clinicSheets.js')),
    'v0.0.15: the spreadsheet words the allergy answer as the kiosk\'s own dropdown does (one copy, in medicalLabels.js)');
    // The conditions are answered row by row now. A language still telling the
    // patient to "select all that apply" above 25 dropdowns gives the wrong
    // instruction; one without its own wording falls back to the English.
    log(Object.values(st.CATALOG).every((c) => !(c.intake && c.intake.conditionsHint) || c.intake.conditionsHint !== c.intake.allergiesHint)
      && /«Да», «Нет» или «Не уверен\(а\)»/.test(st.CATALOG.ru.intake.conditionsHint),
    'v0.0.15: no language words the conditions as "select all that apply" any more');
    const dbSrcV = srcV('../src/main/db.js');
    log(/const VISIT_SPECIFIC_DENTAL_KEYS = Object\.keys\(require\('\.\/medicalLabels'\)\.DENTAL_Q_LABELS\)/.test(dbSrcV),
      'v0.0.15: a returning patient\'s new visit clears the Step 3 questions from the pinned list, not a copy of its own');
    log(/\n  event: \[[^\]]*'cities'[^\]]*\]/.test(dbSrcV), 'v0.0.15: the City list is part of what syncs for an event');

    // ---- one legacy record and one v0.0.15 record, used by every check below ----
    const ANS = Object.fromEntries(INTAKE_25.map((k) => [k, 'no']));
    const LEGACY_MH = {
      under_treatment: 'yes', hospitalized: 'yes', tobacco: 'no', pregnancy: 'na',
      conditions: ['diabetes', 'heart_murmur', 'pain_mgmt', 'other'], conditions_other: 'Gout',
      allergies: ['articaine', 'nsaids', 'other'], allergies_other: 'Sulfa',
      medications: [{ name: 'Metformin', dose: '500 mg', reason: 'sugar' }],
    };
    const LEGACY_DH = { prior_dentist: 'Dr. Prior', gum_bleeding: 'yes', ortho: 'no', grinding: 'yes', visit_type: 'filling' };
    const V2_MH = mhx.normalizeMedical({
      under_treatment: 'no', condition_answers: { ...ANS, diabetes: 'yes', copd: 'yes', bleeding: 'unsure', pregnant: 'unsure' },
      conditions_other: '', medications: [{ key: 'warfarin', name: 'Warfarin (Coumadin)' }, { key: 'other', name: 'Fish oil' }],
      major_surgery: 'yes', surgery_sites: ['knee', 'hip'], tobacco: 'yes',
      allergy_status: 'yes', allergies: ['sulfa', 'other'], allergies_other: 'Latex gloves',
    });
    const V2_DH = { prior_dentist: 'about_1_year', pain_cold: 'yes', pain_hot: 'no', pain_eating: 'yes', toothache_night: 'no',
      pain_touch: 'no', grinding_night: 'yes', jaw_pain_waking: 'no', sores: 'no', visit_type: 'extraction_pain', may_need_extraction: 'yes' };
    const V2_UNSURE = mhx.normalizeMedical({ ...V2_MH, allergy_status: 'unsure', allergies: [] });
    const UNKNOWN = { conditions: ['diabetes', 'future_condition'], allergies: ['bee_venom'] };

    // ---- the two implementations agree (renderer vs main process) ----
    const fixtures = [LEGACY_MH, V2_MH, V2_UNSURE, UNKNOWN, {}, { conditions: ['none'], allergies: ['none'], medications_none: true }];
    log(fixtures.every((f) => same(mhx.medicalDisplay(f, 'en'), ml.medicalDisplay(f))),
      'v0.0.15: the screens and the printed record read every history the same way (legacy, new, unsure, unknown keys, empty)');
    log(fixtures.every((f) => same(mhx.clinicalFlags(f), ml.clinicalFlags(f)) && mhx.firstMissingMedical(f) === ml.firstMissingMedical(f)),
      'v0.0.15: the red flags and the "what is still unanswered" rule are identical in both');
    const dSub = (d) => ({ q: d.questions.map((q) => [q.key, q.short, q.value]), l: d.legacy });
    log([LEGACY_DH, V2_DH, {}].every((d) => same(dSub(mhx.dentalDisplay(d, 'en')), dSub(ml.dentalDisplay(d)))),
      'v0.0.15: the dental history reads the same on screen and in print');

    // ---- what the form stores, derived ----
    log(same(V2_MH.conditions, ['diabetes', 'copd']) && V2_MH.history_version === 2 && !V2_MH.conditions_none,
      'v0.0.15: conditions are derived from the Yes answers (Unsure is not a Yes)');
    const allNo = mhx.normalizeMedical({ ...V2_MH, condition_answers: { ...ANS, pregnant: 'na' } });
    log(same(allNo.conditions, ['none']) && allNo.conditions_none === true, 'v0.0.15: every condition answered No (or N/A) is a reviewed "none"');
    const unsureOnly = mhx.normalizeMedical({ ...V2_MH, condition_answers: { ...ANS, asthma: 'unsure' } });
    log(same(unsureOnly.conditions, []) && !unsureOnly.conditions_none, 'v0.0.15: an Unsure is never recorded as "none"');
    const nk = mhx.normalizeMedical({ ...V2_MH, allergy_status: 'nkda', allergies: ['sulfa'] });
    log(same(nk.allergies, ['none']) && nk.allergies_none === true && same(V2_UNSURE.allergies, []) && !V2_UNSURE.allergies_none,
      'v0.0.15: NKDA is recorded as reviewed-none; Unsure lists nothing and is NOT "none"');
    log(same(mhx.normalizeMedical({ ...V2_MH, major_surgery: 'no' }).surgery_sites, []), 'v0.0.15: no major surgery, no sites');
    log(mhx.normalizeMedical(LEGACY_MH).history_version === undefined, 'v0.0.15: an old checklist run through the normaliser is not passed off as answered');

    // ---- the red flags the dentist sees ----
    const fl = mhx.clinicalFlags(V2_UNSURE);
    log(fl.includes('Diabetes – Type 1 or Type 2') && fl.includes('Unsure: Bleeding Disorder / Excessive Bleeding') && fl.includes('Possibly pregnant')
      && fl.includes('Allergy status unsure') && !fl.some((f) => /COPD/.test(f)),
    'v0.0.15: flags carry the red-flag conditions, "Unsure: …" ones, "Possibly pregnant" and an Unsure allergy answer');
    log(mhx.clinicalFlags(V2_MH).includes('Allergy: Sulfa antibiotics') && mhx.clinicalFlags(V2_MH).includes('Allergy: Latex gloves'),
      'v0.0.15: a typed-in allergy is flagged too (it never was)');
    log(mhx.clinicalFlags({ pregnancy: 'yes' }).includes('Pregnant') && mhx.clinicalFlags({ conditions: ['pregnant'] }).includes('Pregnant')
      && !mhx.clinicalFlags({ conditions: ['blood_thinners'] }).length,
    'v0.0.15: an older record\'s pregnancy still flags; blood thinners keep their own banner');
    const reAnswered = mhx.normalizeMedical({ ...V2_MH, pregnancy: 'yes', condition_answers: { ...V2_MH.condition_answers, pregnant: 'no' } });
    log(!mhx.clinicalFlags(reAnswered).includes('Pregnant') && !ml.clinicalFlags(reAnswered).includes('Pregnant'),
      'v0.0.15: a pregnancy row answered No wins over an older record\'s "Pregnant, nursing…" Yes');
    log(mhx.clinicalFlags(LEGACY_MH).includes('Heart murmur') && mhx.clinicalFlags(LEGACY_MH).includes('Allergy: Articaine'),
      'v0.0.15: an older record\'s retired red flags still raise the flag');

    // The blood-thinner rules recognise the checklist's canonical names — in all
    // three places they live — and none of the other 21.
    const mfV = await import('../src/renderer/js/medFlags.js');
    const thin = ['warfarin', 'apixaban', 'clopidogrel', 'aspirin'];
    const hits = st.MED_CHECKLIST.filter((m) => mfV.bloodThinnerFlags({ medications: [{ name: m.en }] }).length).map((m) => m.key);
    log(same(hits.sort(), thin.slice().sort()), 'v0.0.15: the screens detect exactly Warfarin, Apixaban, Clopidogrel and Aspirin from the checklist');
    const { buildHtml } = require('../src/main/pdf.js');
    const thinPdf = st.MED_CHECKLIST.filter((m) => /Blood thinners[\s\S]{0,80}YES/.test(buildHtml({ first_name: 'T', last_name: 'P', medical_history: { medications: [{ name: m.en }] }, triage: {} }, 'summary'))).map((m) => m.key);
    log(same(thinPdf.sort(), thin.slice().sort()), 'v0.0.15: the printed record detects the same four');
    const thinP = db.createPatient(currentUser, { first_name: 'Thin', last_name: 'Checklist', demographics: {}, medical_history: { medications: [{ key: 'apixaban', name: 'Apixaban (Eliquis)' }] }, dental_history: {} });
    const coffeeP = db.createPatient(currentUser, { first_name: 'Not', last_name: 'Thin', demographics: {}, medical_history: { medications: [{ key: 'losartan', name: 'Losartan (Cozaar)' }] }, dental_history: {} });
    const qRows = db.listPatients({});
    log(qRows.find((x) => x.id === thinP.id).on_thinner === true && qRows.find((x) => x.id === coffeeP.id).on_thinner === false,
      'v0.0.15: and so do the queues (a checklist Apixaban is a thinner; Losartan is not)');

    // ---- every screen: an old record and a new one ----
    const oldP = db.createPatient(currentUser, { first_name: 'Olga', last_name: 'Legacy', dob: '1960-02-02', gender: 'female',
      demographics: { city: 'Sandy', state: 'OR', marital_status: 'married', referral: 'flyer' }, medical_history: LEGACY_MH, dental_history: LEGACY_DH });
    const newP = db.createPatient(currentUser, { first_name: 'Nina', last_name: 'Newform', dob: '1990-03-03', gender: 'female',
      demographics: { city: 'Boring', state: 'OR', referral: 'other', referral_other: 'A neighbour' }, medical_history: V2_MH, dental_history: V2_DH });
    const unsP = db.createPatient(currentUser, { first_name: 'Uma', last_name: 'Unsure', gender: 'male',
      demographics: {}, medical_history: V2_UNSURE, dental_history: {} });
    const { patientHistoryCards } = await import('../src/renderer/js/components/patientHistory.js');
    const cardsText = (p) => { const d = document.createElement('div'); patientHistoryCards(db.getPatient(p.id)).forEach((c) => d.append(c)); return d; };
    const oc = cardsText(oldP), ocT = oc.textContent;
    log(/Heart murmur/.test(ocT) && /Pain management program/.test(ocT) && /Gout/.test(ocT) && /Diabetes/.test(ocT),
      'legacy: the chart still lists every condition an old record ticked, retired and typed ones included');
    log(/Articaine/.test(ocT) && /NSAIDs \(Ibuprofen, Aspirin\)/.test(ocT) && /Sulfa/.test(ocT), 'legacy: every logged allergy is still on the chart, typed one included');
    log(/Hospitalized \(2 yrs\)/.test(ocT) && /Pregnant \/ nursing/.test(ocT) && /Not applicable/.test(ocT),
      'legacy: the retired questions still show for the record that answered them, in words');
    log(!/Unsure/.test(ocT) && !/High Blood Pressure/.test(ocT) && !/Major surgery/.test(ocT),
      'legacy: nothing an old checklist did not tick is shown as an answer (never "No")');
    log(/500 mg/.test(ocT) && /sugar/.test(ocT), 'legacy: an older medication\'s dose and reason still show');
    log(/Earlier intake questions/.test(ocT) && /Gums bleed/.test(ocT) && /Clenching \/ grinding/.test(ocT) && /Dr\. Prior/.test(ocT),
      'legacy: the old Step 3 answers show under "Earlier intake questions", and a free-text last visit verbatim');
    log(/Female/.test(ocT) && /Married/.test(ocT) && /Heard about us/.test(ocT) && /Flyer/.test(ocT) && /Sandy/.test(ocT) && !/>female</.test(oc.innerHTML),
      'the patient card labels gender, marital status and "heard about us" and shows the town (no raw codes)');
    const nc = cardsText(newP), ncT = nc.textContent;
    log(/Diabetes – Type 1 or Type 2/.test(ncT) && /COPD/.test(ncT) && /Unsure — ask the patient/.test(ncT) && /Bleeding Disorder/.test(ncT),
      'new: the chart shows the Yes conditions and, separately, the ones the patient was unsure of');
    log(/Major surgery \(6 mo\)/.test(ncT) && /Yes — Knee, Hip/.test(ncT) && /Smokes \/ tobacco/.test(ncT) && /Pregnancy/.test(ncT),
      'new: major surgery with its sites, smoking and the pregnancy answer are on the chart');
    log(!/Hospitalized/.test(ncT) && !/Pregnant \/ nursing/.test(ncT) && !/Earlier intake questions/.test(ncT),
      'new: the retired questions do not appear as blanks on a record that was never asked them');
    log(/Warfarin \(Coumadin\)/.test(ncT) && /Fish oil/.test(ncT) && !/<th>Dose<\/th>/.test(nc.innerHTML),
      'new: checklist and typed medications are listed (no empty dose column)');
    log(/Pain with cold water/.test(ncT) && /Clenches \/ grinds at night/.test(ncT) && /Boring/.test(ncT) && /A neighbour/.test(ncT),
      'new: the Step 3 answers and the town show on the chart');
    const carried = db.createPatient(currentUser, { first_name: 'Carried', last_name: 'Over', demographics: {},
      medical_history: { ...V2_MH, hospitalized: 'yes' }, dental_history: {} });
    log(/Hospitalized \(2 yrs\) \(earlier form\)/.test(cardsText(carried).textContent)
      && /Recent hospitalization \(earlier form\)/.test(buildHtml(db.getPatient(carried.id), 'full')),
    'a retired answer carried into a new-form record is marked as the earlier form\'s');
    const ucT = cardsText(unsP).textContent;
    log(/Unsure — ask the patient/.test(ucT) && !/None reported|None \(reviewed\)/.test(ucT.split('Conditions')[0]),
      'an allergy answer of Unsure never reads as "None"');

    // A key this build does not know — written by a newer list, or typed
    // into a backup — is shown readably, never dropped.
    const unkP = db.createPatient(currentUser, { first_name: 'Una', last_name: 'Known', demographics: {}, medical_history: UNKNOWN, dental_history: {} });
    const unkT = cardsText(unkP).textContent;
    log(/Future Condition/.test(unkT) && /Bee Venom/.test(unkT) && /Allergy: Bee Venom/.test(mhx.clinicalFlags(UNKNOWN).join('|')),
      'an unknown condition or allergy key is shown (and flagged) by a readable name, never dropped');

    // Records shows the chart's own cards.
    const { renderRecords: recV } = await import('../src/renderer/js/views/records.js');
    const storeV = (await import('../src/renderer/js/store.js')).store; storeV.setUser(currentUser);
    const ctxV = { navigate: () => {}, toast: () => {}, store: storeV, setDetail: () => {} };
    const recOld = recV(ctxV, { id: oldP.id }); document.body.append(recOld);
    const recNew = recV(ctxV, { id: newP.id }); document.body.append(recNew);
    for (let i = 0; i < 6; i++) await tick();
    log(/Heart murmur/.test(recOld.textContent) && /Hospitalized \(2 yrs\)/.test(recOld.textContent) && /Gums bleed/.test(recOld.textContent) && /Blood thinner/.test(recOld.textContent),
      'records: an old record reads as it did, with vitals and blood thinner still in the medical card');
    log(/Unsure — ask the patient/.test(recNew.textContent) && /Yes — Knee, Hip/.test(recNew.textContent) && /Heard about us/.test(recNew.textContent) && !/>Referral</.test(recNew.innerHTML),
      'records: a new record shows the same history the chart does; "Referral" reads "Heard about us"');

    // The dentist's banner and summary.
    const { renderProvider: provV } = await import('../src/renderer/js/views/provider.js');
    const provNew = provV(ctxV, { id: unsP.id }); document.body.append(provNew);
    for (let i = 0; i < 6; i++) await tick();
    const banner = Array.from(provNew.querySelectorAll('.banner')).map((b) => b.textContent).find((x) => /Medical flags/.test(x)) || '';
    log(/Unsure: Bleeding Disorder/.test(banner) && /Possibly pregnant/.test(banner) && /Allergy status unsure/.test(banner),
      'provider: the medical-flags banner carries Unsure answers and an Unsure allergy status');
    const mini = provNew.querySelector('.mini-hist');
    log(!!mini && /Allergies: Unsure — ask the patient/.test(mini.textContent) && /Unsure: Bleeding Disorder/.test(mini.textContent) && /Warfarin \(Coumadin\)/.test(mini.textContent),
      'provider: the patient summary reads the allergy answer, the Unsure conditions and the medications');

    // The printed record, both formats.
    const fullOld = buildHtml(db.getPatient(oldP.id), 'full');
    const fullNew = buildHtml(db.getPatient(newP.id), 'full');
    log(/Heart murmur/.test(fullOld) && /Articaine/.test(fullOld) && /Sulfa/.test(fullOld) && /Recent hospitalization/.test(fullOld) && /Pregnant \/ nursing/.test(fullOld)
      && /500 mg/.test(fullOld) && /Gums bleed \(earlier form\)/.test(fullOld),
    'pdf: an old record prints its conditions and allergies by name, its retired answers and its old Step 3 answers');
    log(!/Heart Murmur|Pain Mgmt|>Nsaids</.test(fullOld), 'pdf: no stored key is title-cased onto the record any more');
    log(/Major surgery in the past 6 months/.test(fullNew) && /Yes — Knee, Hip/.test(fullNew) && /Smokes \/ tobacco/.test(fullNew)
      && /Unsure — ask the patient/.test(fullNew) && /Pain with cold water/.test(fullNew) && /Clenches \/ grinds at night/.test(fullNew)
      && !/Recent hospitalization/.test(fullNew) && !/Gums bleed/.test(fullNew),
    'pdf: a new record prints major surgery, smoking, the Unsure group and the eight Step 3 answers — and no retired rows');
    log(/<div class="val">Female<\/div>/.test(fullNew) && !/<div class="val">(female|unsure|na|yes|no)<\/div>/.test(fullNew + fullOld),
      'pdf: no raw code reaches the printed record');
    log((fullNew.match(/<tr>(?:(?!<\/tr>)[\s\S])*<\/tr>/g) || []).filter((r) => /class="label"/.test(r)).every((r) => (r.match(/<td>/g) || []).length <= 2),
      'pdf: every history row has at most two cells (an odd count is padded, never spilled)');
    const sumUns = buildHtml(db.getPatient(unsP.id), 'summary');
    log(/Unsure — ask the patient/.test(sumUns) && /Major surgery \(6 mo\)/.test(sumUns) && !/None reported/.test(sumUns.split('Conditions')[0]),
      'pdf summary: the Unsure allergy answer and major surgery print; Unsure is never "None"');
    log(/Heart murmur/.test(buildHtml(db.getPatient(oldP.id), 'summary')), 'pdf summary: an old record\'s conditions print by their old names');

    // The clinic spreadsheet.
    const { clinicSheets: sheetsV } = require('../src/main/clinicSheets.js');
    const shV = sheetsV(db.exportClinicBundle())[0];
    const rowOf = (last) => { const r = shV.rows.find((x) => x[0] === last); return Object.fromEntries(shV.columns.map((c, i) => [c, r[i]])); };
    log(shV.rows.every((r) => r.length === shV.columns.length), 'sheet: every patient row has exactly one value per column');
    const ro = rowOf('Legacy'), rn = rowOf('Newform');
    log(ro.Allergies === 'Articaine, NSAIDs (Ibuprofen, Aspirin), Sulfa' && /Heart murmur/.test(ro.Conditions) && ro['Hospitalized (2 yrs)'] === 'Yes'
      && ro['Pregnant/nursing'] === 'Not applicable' && ro['Allergy status'] === '' && ro['Major surgery (6 mo)'] === '',
    'sheet: an old record exports its answers by name, and leaves the questions it was never asked empty');
    log(rn['Allergy status'] === 'Yes' && rn.Allergies === 'Sulfa antibiotics, Latex gloves' && rn['Conditions (unsure)'] === 'Bleeding Disorder / Excessive Bleeding, Pregnancy / Possible Pregnancy (when applicable)'
      && rn['Major surgery (6 mo)'] === 'Yes' && rn['Surgery sites'] === 'Knee, Hip' && rn['Smokes / tobacco'] === 'Yes' && rn.Pregnancy === 'Unsure'
      && rn['Hospitalized (2 yrs)'] === '' && rn.Gender === 'Female',
    'sheet: a new record exports its allergy status, Unsure conditions, surgery, smoking and pregnancy answers');
    const dentCols = shV.columns.slice(shV.columns.indexOf('Last saw a dentist') + 1, shV.columns.indexOf('Last saw a dentist') + 9);
    log(same(dentCols, st.DENTAL_QUESTIONS.map((q) => q.short)) && rn['Pain with cold water'] === 'Yes' && rn['Wakes with jaw pain'] === 'No',
      'sheet: the eight Step 3 answers follow "Last saw a dentist"');

    // ---- reports: the "none" / "other" markers were never conditions ----
    const sentP = db.createPatient(currentUser, { first_name: 'Sent', last_name: 'Inel', demographics: {}, medical_history: { conditions: ['none'] }, dental_history: {} });
    const sentQ = db.createPatient(currentUser, { first_name: 'Sent', last_name: 'Other', demographics: {}, medical_history: { conditions: ['other'], conditions_other: 'x' }, dental_history: {} });
    void sentP; void sentQ;
    const liveSum = db.buildEventSummary();
    log(liveSum.conditions.none === undefined && liveSum.conditions.other === undefined && liveSum.conditions.heart_murmur >= 1,
      'reports: "none" and "other" are no longer counted as conditions');
    const rex = require('../src/main/reportExport.js');
    const kept = { patients_seen: 10, conditions: { none: 99, other: 12, diabetes: 3, diabetes_typo: 2, heart_murmur: 1, mystery_key: 1 } };
    const condRows = rex.reportSections(kept, 'Kept', { conditions: { diabetes: 'Diabetes', diabetes_typo: 'Diabetes', heart_murmur: 'Heart murmur' } })
      .find((x) => x.title === 'Most common conditions').rows;
    log(!condRows.some((r) => /^(None|Other|none|other)$/.test(r[0])) && condRows.find((r) => r[0] === 'Diabetes')[1] === 5
      && condRows.some((r) => r[0] === 'Heart murmur') && condRows.some((r) => r[0] === 'Mystery Key'),
    'reports: a kept summary\'s old "none"/"other" counts are dropped, two keys with one name are ADDED, and no raw key reaches a funder');
    // The Reports tab reads a kept summary the same way.
    const evK = db.createEvent(currentUser, { name: 'Kept Sentinels' });
    const rdb = rawDb();
    rdb.prepare(`INSERT INTO event_reports (uid, event_id, summary, patients_seen, finished_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run('kept-sentinels-uid', evK.id, JSON.stringify({ patients_seen: 3, conditions: { none: 99, other: 40, heart_murmur: 2 }, by_city: { 'sandy, OR': 1, 'Sandy , OR': 1, 'Sandy, OR': 3 } }), 3, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    rdb.close();
    const rollK = db.reportRollup(evK.id);
    log(rollK.summary.by_city['Sandy, OR'] === 5 && Object.keys(rollK.summary.by_city).length === 1,
      'reports: one town is one row — a kept report\'s "sandy" / "Sandy " / "Sandy" are folded together');
    const allLabels = { conditions: Object.fromEntries(i18nV.conditions().map((c) => [c.key, c.label])) };
    const allRows = rex.reportSections(db.reportRollup('all').summary, 'All', allLabels).find((x) => x.title === 'Most common conditions').rows;
    log(allRows.some((r) => r[0] === 'Heart murmur') && !allRows.some((r) => /^None$|^Other$/.test(r[0])),
      'reports: across all clinics, kept and live, a retired condition is named and "None" is not a condition');
    const { renderReports: repV } = await import('../src/renderer/js/views/reports.js');
    const repK = repV(ctxV); document.body.append(repK);
    for (let i = 0; i < 8; i++) await tick();
    const condCard = Array.from(repK.querySelectorAll('.card')).find((c) => /Most common conditions/.test(c.textContent));
    log(!!condCard && /Diabetes/.test(condCard.textContent) && !/\bNone\b/.test(condCard.textContent) && !/\b99\b/.test(condCard.textContent),
      'reports: the Reports tab never lists "None" among the most common conditions');
    const foldSum = db.mergeSummaries([{ by_city: { 'Boring, OR': 1 } }, { by_city: { 'boring, OR': 2 } }]);
    log(foldSum.by_city['boring, OR'] === 3 && Object.keys(foldSum.by_city).length === 1,
      'reports: merged totals fold one town\'s spellings together, under the spelling most of them used');

    // ---- City: the event's own list ----
    const evC = db.createEvent(currentUser, { name: 'City List', cities: [' Sandy ', 'sandy', 'Boring', '', 'Other', 'Estacada  Heights'] });
    // The list is cleaned in three places — the data layer when the admin saves
    // it, the kiosk, and the Worker when it serves the online form — so all
    // three are run over one messy list and must offer the same towns.
    const { eventCities: evCitiesR } = await import('../src/renderer/js/components/intakeSections.js');
    const MESSY = [' Sandy ', 'sandy', 'Boring', '', 'Other', ' OTHER ', 'Estacada  Heights', 'x'.repeat(90),
      ...Array.from({ length: 120 }, (_, i) => 'Town   ' + i)];
    const kioskTowns = evCitiesR({ cities: MESSY });
    const dbTowns = JSON.parse(db.createEvent(currentUser, { name: 'City Parity', cities: MESSY }).cities);
    const workerC = (await import('../cloud/worker.js')).default;
    const envC = { DB: { prepare() { return { bind() { return this; },
      async first() { return { data: JSON.stringify({ name: 'Parity', active: 1, cities: JSON.stringify(MESSY) }) }; }, async run() { return {}; } }; } } };
    const parityPage = await (await workerC.fetch(new Request('https://sync.example/checkin/evt-parity'), envC, {})).text();
    const workerTowns = Array.from(new JSDOM(parityPage).window.document.querySelectorAll('#city option')).map((o) => o.value).filter((v) => v && v !== 'other');
    log(same(kioskTowns, dbTowns) && same(kioskTowns, workerTowns) && kioskTowns.length === 100 && kioskTowns[3] === 'x'.repeat(80)
      && same(kioskTowns.slice(0, 5), ['Sandy', 'Boring', 'Estacada Heights', 'x'.repeat(80), 'Town 0']),
    'city: the data layer, the kiosk and the online form clean one messy list to the same towns (80 characters, 100 towns)');
    log(evC.cities === JSON.stringify(['Sandy', 'Boring', 'Estacada Heights']),
      'city: the list is stored trimmed, de-duplicated ignoring case, without blanks or "Other"');
    log(db.updateEvent(currentUser, evC.id, { name: 'City List' }).cities === evC.cities, 'city: an edit that does not mention the list keeps it');
    const bundleC = db.exportClinicBundle(evC.id);
    bundleC.event.uid = 'city-list-copy'; bundleC.event.name = 'City List (restored)';
    db.importClinicBundle(currentUser, bundleC);
    const restored = db.listEvents().find((e) => e.uid === 'city-list-copy');
    log(!!restored && restored.cities === evC.cities, 'city: the list travels in a clinic backup and is restored with the event');
    log(db.updateEvent(currentUser, restored.id, { cities: [] }).cities === null, 'city: clearing the list returns City to a free-text box');

    // The admin event form carries the list.
    const { renderAdmin } = await import('../src/renderer/js/views/admin.js');
    const adm = renderAdmin(ctxV, { section: 'events' }); document.body.append(adm);
    for (let i = 0; i < 6; i++) await tick();
    clickText('New event', adm); await tick();
    const ov = $all('.modal-overlay').pop();
    const ta = ov && Array.from(ov.querySelectorAll('label.field')).find((l) => /Cities offered at check-in/.test(l.textContent));
    log(!!ta && !!ta.querySelector('textarea'), 'city: the admin event form asks "Cities offered at check-in (one per line)"');
    if (ta) {
      setInput(ov.querySelector('input'), 'Form Made Clinic');
      setInput(ta.querySelector('textarea'), 'Gresham\ngresham\nTroutdale');
      clickText('Create', ov);
      for (let i = 0; i < 6; i++) await tick();
    }
    const made = db.listEvents().find((e) => e.name === 'Form Made Clinic');
    log(!!made && made.cities === JSON.stringify(['Gresham', 'Troutdale']), 'city: an admin-typed list is saved on the event');

    // The kiosk offers the list, canonicalises a typed town, and never blanks an old one.
    const { demographicsSection, medicalHistorySection, dentalHistorySection } = await import('../src/renderer/js/components/intakeSections.js');
    const cities = ['Sandy', 'Boring'];
    const citySel = (sec) => Array.from(sec.node.querySelectorAll('label.field')).find((l) => /^City/.test(l.querySelector('.field-label').textContent)).querySelector('select');
    const otherIn = (sec) => Array.from(sec.node.querySelectorAll('label.field')).find((l) => /Please type your city/.test(l.textContent)).querySelector('input');
    const baseDemo = { first_name: 'C', last_name: 'T', dob: '1990-01-01', gender: 'male', phone: '5035550100',
      demographics: { state: 'OR', emergency_name: 'E', emergency_phone: '5035550101', services: ['dental'], future_key: 'kept' } };
    const s1 = demographicsSection(baseDemo, { cities });
    log(!!citySel(s1) && same(Array.from(citySel(s1).options).map((o) => o.value), ['', 'Sandy', 'Boring', 'other']),
      'city: with a list, City is a dropdown of the event\'s towns plus Other');
    citySel(s1).value = 'other'; citySel(s1).dispatchEvent(new window.Event('change'));
    setInput(otherIn(s1), ' boring ');
    const got1 = s1.collect();
    log(!!got1 && got1.demographics.city === 'Boring' && got1.demographics.future_key === 'kept',
      'city: a typed town that is on the list is stored in the listed spelling (and unknown demographics keys survive)');
    const s2 = demographicsSection({ ...baseDemo, demographics: { ...baseDemo.demographics, city: 'Sandy OR' } }, { cities });
    log(citySel(s2).value === 'other' && otherIn(s2).value === 'Sandy OR' && s2.collect().demographics.city === 'Sandy OR' && !s2.isDirty(),
      'city: an old free-text town opens as Other with its text — never silently blanked');
    citySel(s2).value = 'other'; setInput(otherIn(s2), '');
    log(s2.collect() === false && /Please type your city/.test($all('#toast-host .toast').pop().textContent),
      'city: Other with nothing typed is refused, by name');
    const s3 = demographicsSection({ ...baseDemo, demographics: { ...baseDemo.demographics, city: 'SANDY' } }, { cities });
    log(citySel(s3).value === 'Sandy', 'city: an old record in another case opens on the listed town');
    const noListSec = demographicsSection(baseDemo, { cities: [] });
    const noList = Array.from(noListSec.node.querySelectorAll('label.field')).find((l) => /^City/.test(l.querySelector('.field-label').textContent));
    log(!!noList.querySelector('input') && !noList.querySelector('select'), 'city: with no list, City stays a text box');
    // A typed town is cleaned the way the online form cleans one, list or no list.
    const longTown = '  Far   Away ' + 'x'.repeat(100);
    const s5 = demographicsSection(baseDemo, { cities });
    citySel(s5).value = 'other'; citySel(s5).dispatchEvent(new window.Event('change'));
    setInput(otherIn(s5), longTown);
    setInput(noList.querySelector('input'), longTown);
    const cityGot = (sec) => (sec.collect() || { demographics: {} }).demographics.city;
    log(cityGot(s5) === ('Far Away ' + 'x'.repeat(100)).slice(0, 80) && cityGot(noListSec) === cityGot(s5)
      && otherIn(s5).maxLength === 80 && noList.querySelector('input').maxLength === 80,
    'city: a typed town is stored as the online form stores it (one space, trimmed, at most 80 characters)');

    // An answer from before a question was a dropdown — the online form stored
    // "How did you hear about us?" as prose until v0.0.13 — or a key from a
    // newer build's list opens as recorded, and is saved back exactly as it was.
    const legacyDemo = { ...baseDemo, gender: 'F',
      demographics: { ...baseDemo.demographics, city: 'Sandy', state: 'Ore.', referral: 'Facebook group', marital_status: 'Separated' } };
    const s4 = demographicsSection(legacyDemo, { cities });
    const selOf = (sec, re) => Array.from(sec.node.querySelectorAll('label.field')).find((l) => re.test(l.querySelector('.field-label').textContent)).querySelector('select');
    const shownIn = (sel) => sel.options[sel.selectedIndex].textContent;
    log(shownIn(selOf(s4, /^How did you hear/)) === 'Facebook group (as recorded)' && shownIn(selOf(s4, /^Marital/)) === 'Separated (as recorded)'
      && shownIn(selOf(s4, /^State/)) === 'Ore. (as recorded)' && shownIn(selOf(s4, /^Gender/)) === 'F (as recorded)',
    'edit: an old free-text referral, marital status, state or gender opens showing what the record says (never a blank "—")');
    const got4 = s4.collect();
    log(!s4.isDirty() && !!got4 && got4.demographics.referral === 'Facebook group' && got4.demographics.marital_status === 'Separated'
      && got4.demographics.state === 'Ore.' && got4.gender === 'F' && got4.demographics.future_key === 'kept',
    'edit: saving without touching them keeps every one exactly as recorded — nothing reads as changed, nothing is erased');
    const refSel4 = selOf(s4, /^How did you hear/); refSel4.value = 'flyer'; refSel4.dispatchEvent(new window.Event('change'));
    const got4b = s4.collect();
    log(s4.isDirty() && !!got4b && got4b.demographics.referral === 'flyer', 'edit: choosing a listed answer replaces the recorded one, and is noticed');
    const s4b = demographicsSection({ ...legacyDemo, demographics: { ...legacyDemo.demographics, state: 'oregon', referral: 'flyer' } }, { cities });
    log(selOf(s4b, /^State/).value === 'OR' && selOf(s4b, /^How did you hear/).value === 'flyer' && !Array.from(selOf(s4b, /^How did you hear/).options).some((o) => /as recorded/.test(o.textContent)),
      'edit: a state typed out in full still opens on its code, and a listed answer adds no "as recorded" option');

    // "Prefer not to answer" is about the race list, so it replaces it — on
    // screen, not silently when saved — and any race chosen after clears it.
    const raceSec = demographicsSection({ ...baseDemo, demographics: { ...baseDemo.demographics, city: 'Sandy' } }, { cities });
    const raceGrid = Array.from(raceSec.node.querySelectorAll('.field')).find((f) => Array.from(f.children).some((c) => c.classList.contains('field-label') && /^Race and ethnicity/.test(c.textContent)));
    const raceLit = () => Array.from(raceGrid.querySelectorAll('.chip-select--on')).map((b) => b.dataset.key);
    raceGrid.querySelector('.chip-select[data-key="white"]').click();
    raceGrid.querySelector('.chip-select[data-key="prefer_not"]').click();
    const raceGot = () => (raceSec.collect() || { demographics: {} }).demographics.race;
    const racePna = [raceLit(), raceGot()];
    raceGrid.querySelector('.chip-select[data-key="asian"]').click();
    log(same(racePna, [['prefer_not'], ['prefer_not']]) && same(raceLit(), ['asian']) && same(raceGot(), ['asian']),
      'race: "Prefer not to answer" clears the other choices on screen, and a race chosen after it clears it');
    // And the kiosk itself, on an event with a list.
    const prevActive = db.getActiveEvent();
    db.setActiveEvent(currentUser, evC.id);
    const { renderKiosk } = await import('../src/renderer/js/views/kiosk.js');
    const ksk = renderKiosk({ navigate: () => {} }); document.body.append(ksk);
    for (let i = 0; i < 4; i++) await tick();
    Array.from(ksk.querySelectorAll('.lang-card')).find((c) => /English/.test(c.textContent)).click();
    for (let i = 0; i < 4; i++) await tick();
    const kCity = Array.from(ksk.querySelectorAll('label.field')).find((l) => /^City/.test(l.querySelector('.field-label').textContent));
    log(!!kCity && !!kCity.querySelector('select') && /Estacada Heights/.test(kCity.textContent),
      'city: the kiosk offers the active event\'s towns');
    ksk.remove();
    if (prevActive) db.setActiveEvent(currentUser, prevActive.id);

    // ---- the shared builders: an old record opened for editing ----
    const medSec = medicalHistorySection(LEGACY_MH);
    const rowSel = (sec, k) => sec.node.querySelector(`.tri-row[data-key="${k}"] select`);
    log(rowSel(medSec, 'diabetes').value === 'yes' && rowSel(medSec, 'high_bp').value === '' && rowSel(medSec, 'heart_murmur').value === 'yes'
      && rowSel(medSec, 'pain_mgmt').value === 'yes',
    'edit: an old record opens with its ticks as Yes, nothing unticked as No, and its retired conditions still on screen');
    log(!medSec.isDirty(), 'edit: opening a record changes nothing');
    const gridIn = (sec, re) => Array.from(sec.node.querySelectorAll('.field')).find((f) => Array.from(f.children).some((c) => c.classList.contains('field-label') && re.test(c.textContent)));
    const allergyGridE = gridIn(medSec, /^Medication allergies \*/);
    log(!!allergyGridE.querySelector('.chip-select--on[data-key="articaine"]') && !!allergyGridE.querySelector('.chip-select--on[data-key="nsaids"]'),
      'edit: an old record\'s retired allergies stay selected, so saving cannot drop them');
    log(medSec.collect() === false && /Required: High Blood Pressure \(Hypertension\)/.test($all('#toast-host .toast').pop().textContent),
      'edit: the questions an old record never answered are still asked before it can be saved');
    INTAKE_25.forEach((k) => { const sel = rowSel(medSec, k); if (!sel.value) { sel.value = k === 'pregnant' ? 'na' : 'no'; } });
    const selIn = (sec, re) => Array.from(sec.node.querySelectorAll('label.field')).find((l) => re.test(l.querySelector('.field-label').textContent)).querySelector('select');
    [[/^Major surgery/, 'no'], [/^Do you smoke/, 'no'], [/under a doctor/, 'yes']].forEach(([re, v]) => { const x = selIn(medSec, re); x.value = v; x.dispatchEvent(new window.Event('change')); });
    log(medSec.isDirty(), 'edit: a change is noticed');
    const savedMh = medSec.collect();
    log(!!savedMh && savedMh.history_version === 2 && savedMh.hospitalized === 'yes' && savedMh.pregnancy === 'na'
      && savedMh.conditions.includes('heart_murmur') && savedMh.conditions.includes('pain_mgmt') && savedMh.allergies.includes('articaine')
      && savedMh.medications.some((m) => m.name === 'Metformin' && m.dose === '500 mg' && m.reason === 'sugar'),
    'edit: saving an old record keeps every answer it had — retired questions, retired items and an old dose included');
    // A free-text "last saw a dentist" from before the dropdown opens as
    // recorded — whoever edits the record sees what it says — and is kept
    // unless they choose an answer from the list.
    const dSec = dentalHistorySection(LEGACY_DH);
    const dSels = Array.from(dSec.node.querySelectorAll('select'));
    log(dSels[0].value === 'Dr. Prior' && dSels[0].options[dSels[0].selectedIndex].textContent === 'Dr. Prior (as recorded)' && !dSec.isDirty(),
      'edit: an old free-text last visit opens showing what it says, not a blank');
    dSels.slice(1).forEach((x) => { if (!x.value) x.value = 'no'; });
    const savedDh = dSec.collect();
    log(!!savedDh && savedDh.prior_dentist === 'Dr. Prior' && savedDh.gum_bleeding === 'yes' && savedDh.grinding === 'yes' && savedDh.visit_type === 'filling' && savedDh.pain_cold === 'no',
      'edit: saving Step 3 keeps the old answers, the recorded last visit and the visit type it was not asked to change');
    dSels[0].value = 'over_3_years';
    log((dSec.collect() || {}).prior_dentist === 'over_3_years', 'edit: choosing from the list replaces the recorded last visit');
    const two = [medicalHistorySection({}), medicalHistorySection({})].map((x) => x.node.querySelector('datalist').id);
    log(two[0] !== two[1], 'edit: two forms open at once never share a datalist id');
    // "No medications" is an answer about the list: it replaces the ticked and
    // typed medications on screen and in what is saved, and a tick clears it.
    const exSec = medicalHistorySection(V2_MH);
    const exGrid = gridIn(exSec, /^Current medications/);
    const exLit = () => Array.from(exGrid.querySelectorAll('.chip-select--on')).map((b) => b.dataset.key);
    log(same(exLit(), ['warfarin', 'other']), 'edit: a record\'s checklist and typed medications open ticked');
    exGrid.querySelector('.chip-select[data-key="none"]').click();
    const exNone = exSec.collect();
    log(same(exLit(), ['none']) && !!exNone && same(exNone.medications, []) && exNone.medications_none === true,
      'edit: "No medications" clears the ticked and typed medications, on screen and in the saved history');
    exGrid.querySelector('.chip-select[data-key="aspirin"]').click();
    const exAsp = exSec.collect();
    log(same(exLit(), ['aspirin']) && !!exAsp && same(exAsp.medications.map((x) => x.key), ['aspirin']) && exAsp.medications_none === undefined,
      'edit: ticking a medication clears "No medications" again');

    // ---- a Spanish-speaking patient reads the whole step in Spanish ----
    i18nV.setLang('es');
    const esMed = medicalHistorySection({});
    const esT = esMed.node.textContent;
    log(/Presión arterial alta \(hipertensión\)/.test(esT) && /¿Fuma\?/.test(esT) && /¿Cirugía mayor en los últimos 6 meses\?/.test(esT)
      && /Sin alergias conocidas a medicamentos \(NKDA\)/.test(esT) && /No estoy seguro\/a/.test(esT) && /No aplica/.test(esT) && /Warfarina \(Coumadin\)/.test(esT),
    'es: the medical step reads in Spanish, its answers included');
    INTAKE_25.forEach((k) => { rowSel(esMed, k).value = k === 'pregnant' ? 'na' : 'no'; });
    [[/^¿Está bajo el cuidado/, 'no'], [/^¿Cirugía mayor/, 'no'], [/^¿Fuma/, 'no'], [/^¿Tiene alergia/, 'nkda']]
      .forEach(([re, v]) => { const x = selIn(esMed, re); x.value = v; x.dispatchEvent(new window.Event('change')); });
    gridIn(esMed, /^Medicamentos actuales/).querySelector('.chip-select[data-key="warfarin"]').click();
    const esSaved = esMed.collect();
    log(!!esSaved && esSaved.medications[0].name === 'Warfarin (Coumadin)' && same(esSaved.allergies, ['none']),
      'es: a medication ticked in Spanish is stored under its canonical English name (the blood-thinner rules read it)');
    log(/¿Siente dolor al tomar agua fría\?/.test(dentalHistorySection({}).node.textContent)
      && Array.from(demographicsSection(baseDemo, { cities }).node.querySelectorAll('option')).some((o) => o.value === 'other' && o.textContent === 'Otra'),
    'es: Step 3 and the City list read in Spanish');
    i18nV.setLang('en');

    // ---- a Spanish-speaking patient checks in at the kiosk, start to finish ----
    // The Sign & Submit review reads back what they ticked in their own
    // language, while the record stores the canonical English name.
    try {
      const kes = renderKiosk({ navigate: () => {} }); document.body.append(kes);
      for (let i = 0; i < 4; i++) await tick();
      Array.from(kes.querySelectorAll('.lang-card')).find((c) => /Español/.test(c.textContent)).click();
      for (let i = 0; i < 4; i++) await tick();
      const T = i18nV.t;
      const fieldOf = (label) => Array.from(kes.querySelectorAll('.kiosk-body label.field'))
        .find((l) => (l.querySelector('.field-label') || {}).textContent.replace(/\s*\*\s*$/, '').trim() === label);
      const put = (label, v) => { const f = fieldOf(label); const x = f.querySelector('select') || f.querySelector('input'); setInput(x, v); };
      const nextStep = async () => { clickText(T('common.next'), kes); for (let i = 0; i < 3; i++) await tick(); };
      put(T('intake.firstName'), 'Lucía'); put(T('intake.lastName'), 'Espanola'); put(T('intake.dob'), '1980-01-01');
      put(T('intake.gender'), 'female'); put(T('intake.phone'), '5035550123');
      const citySelEs = fieldOf(T('intake.city')).querySelector('select');
      put(T('intake.city'), citySelEs ? citySelEs.options[1].value : 'Sandy');
      put(T('intake.state'), 'OR'); put(T('intake.emergencyName'), 'Ana'); put(T('intake.emergencyPhone'), '5035550124');
      await nextStep();
      kes.querySelectorAll('.tri-row select').forEach((x) => { setInput(x, x.closest('.tri-row').dataset.key === 'pregnant' ? 'na' : 'no'); });
      put(T('intake.underTreatment'), 'no'); put(T('intake.majorSurgery'), 'no'); put(T('intake.tobacco'), 'no'); put(T('intake.allergyQuestion'), 'nkda');
      gridIn({ node: kes }, /^Medicamentos actuales/).querySelector('.chip-select[data-key="acetaminophen"]').click();
      await nextStep();
      const esDental = Array.from(kes.querySelectorAll('.kiosk-body select'));
      esDental.forEach((x, i) => setInput(x, i === 0 ? 'never' : 'no'));
      kes.querySelectorAll('.kiosk-body .highlight-field button')[2].click();
      await nextStep();
      const esAgree = kes.querySelector('.big-check'); esAgree.checked = true; esAgree.dispatchEvent(new window.Event('change', { bubbles: true }));
      kes.querySelector('.deemed-field .chip-btn').click();
      put(T('intake.signerName'), 'Lucía Espanola');
      await nextStep();
      const esReview = kes.querySelector('.review') ? kes.querySelector('.review').textContent : '';
      log(/Acetaminofén \(Tylenol\)/.test(esReview) && !/Acetaminophen/.test(esReview) && /Sin alergias conocidas/.test(esReview),
        'es kiosk: the review reads back a ticked medication in Spanish, not the stored English name');
      log(/General — firmado/.test(esReview) && !/signed/.test(esReview), 'es kiosk: the review says the consent is signed in Spanish too');
      $all('.kiosk-nav button', kes).pop().click();
      for (let i = 0; i < 4; i++) await tick();
      const esP = db.listPatients({ eventId: 'all' }).find((x) => x.last_name === 'Espanola');
      const esMhK = esP ? db.getPatient(esP.id).medical_history : {};
      log(!!kes.querySelector('.kiosk-thanks') && same((esMhK.medications || []).map((x) => [x.key, x.name]), [['acetaminophen', 'Acetaminophen (Tylenol)']]),
        'es kiosk: a Spanish check-in submits, the medication stored under its canonical English name');
      kes.remove();
    } catch (e) {
      log(false, 'es kiosk: a Spanish check-in could not be walked through: ' + e.message);
    }
    i18nV.setLang('en');

    // ---- a returning patient: today's answers are asked again ----
    const back = db.createPatient(currentUser, { first_name: 'Ret', last_name: 'Urner', demographics: {},
      medical_history: mhx.normalizeMedical({ ...V2_MH, condition_answers: { ...ANS, diabetes: 'yes', pregnant: 'yes' } }),
      dental_history: V2_DH });
    const again = db.startVisitFromExisting(currentUser, back.id);
    const am = again.medical_history, ad = again.dental_history;
    log(am.condition_answers.pregnant === undefined && !am.conditions.includes('pregnant') && am.major_surgery === undefined
      && am.surgery_sites === undefined && am.history_version === undefined && am.condition_answers.diabetes === 'yes'
      && !mhx.clinicalFlags(am).includes('Pregnant'),
    'return visit: pregnancy and last visit\'s major surgery are asked again; the rest of the history carries over');
    const allNoBack = db.createPatient(currentUser, { first_name: 'All', last_name: 'Noes', demographics: {},
      medical_history: mhx.normalizeMedical({ ...V2_MH, condition_answers: { ...ANS } }), dental_history: {} });
    const allNoAgain = db.startVisitFromExisting(currentUser, allNoBack.id).medical_history;
    log(db.getPatient(allNoBack.id).medical_history.conditions_none === true && same(allNoAgain.conditions, []) && !allNoAgain.conditions_none,
      'return visit: with the pregnancy answer gone, the history no longer claims every condition was reviewed as None');
    log(st.DENTAL_QUESTIONS.every((q) => ad[q.key] === undefined) && ad.prior_dentist === 'about_1_year',
      'return visit: today\'s toothache questions start blank; when they last saw a dentist carries over');

    // ---- the online form, driven for real: page -> server -> sync -> chart ----
    const workerV = (await import('../cloud/worker.js')).default;
    const rowsV = [];
    const envV = { DB: { prepare(sql) { return { bind(...a) { this.a = a; return this; },
      async first() { if (/entity = 'event'/.test(sql)) return { data: JSON.stringify({ name: 'Online', active: 1, cities: JSON.stringify(['Sandy', 'Boring']) }) }; return { v: rowsV.length + 1 }; },
      async run() { if (/INSERT OR REPLACE/.test(sql)) rowsV.push(this.a); return {}; } }; } } };
    const pageHtml = await (await workerV.fetch(new Request('https://sync.example/checkin/evt-online'), envV, {})).text();
    const formDom = new JSDOM(pageHtml, { runScripts: 'dangerously', url: 'https://sync.example/checkin/evt-online', pretendToBeVisual: true,
      beforeParse(w) {
        w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {} });
        w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';
        w.HTMLElement.prototype.scrollIntoView = function () {};
        w.scrollTo = () => {};
        w.fetch = async (_u, init) => { w.__posted = JSON.parse(init.body); return { json: async () => ({ ok: true }) }; };
      } });
    const fw = formDom.window, fd = fw.document;
    const fset = (id, v) => { const e = fd.getElementById(id); e.value = v; e.dispatchEvent(new fw.Event('change', { bubbles: true })); };
    const ftick = (sel) => { const e = fd.querySelector(sel); e.checked = true; e.dispatchEvent(new fw.Event('change', { bubbles: true })); };
    const fsubmit = () => { fd.getElementById('err').textContent = ''; fd.getElementById('f').dispatchEvent(new fw.Event('submit', { cancelable: true })); return fd.getElementById('err').textContent; };
    fset('first_name', 'Olivia'); fset('last_name', 'Online'); fset('dob', '1991-01-01'); fset('gender', 'female');
    fset('city', 'other'); fset('city_other', 'sandy'); fset('state', 'OR'); fset('emergency_name', 'K'); fset('emergency_phone', '5550001111');
    ftick('input[name=service][value=dental]'); ftick('input[name=visit][value=cleaning]');
    // Phone is required online as it is at the kiosk, and asked in the kiosk's order.
    const phoneRefusal = fsubmit();
    log(phoneRefusal === 'Please enter a phone number.', 'online form (real page): a missing phone number is refused, by name, as at the kiosk');
    fset('phone', '5035550100');
    // "Prefer not to answer" replaces the race list on screen, as at the kiosk.
    const raceOn = () => Array.from(fd.querySelectorAll('#race input:checked')).map((x) => x.value);
    const raceLitOn = () => Array.from(fd.querySelectorAll('#race .chip.on input')).map((x) => x.value);
    ftick('input[name=race][value=white]'); ftick('input[name=race][value=prefer_not]');
    const pnaOnly = same(raceOn(), ['prefer_not']) && same(raceLitOn(), ['prefer_not']);
    ftick('input[name=race][value=asian]');
    log(pnaOnly && same(raceOn(), ['asian']) && same(raceLitOn(), ['asian']),
      'online form (real page): "Prefer not to answer" clears the other races on screen, and a race chosen after clears it');
    fset('under_treatment', 'no');
    const firstRefusal = fsubmit();
    log(/every medical and dental history question: High Blood Pressure \(Hypertension\)/.test(firstRefusal),
      'online form (real page): a missing answer is refused naming the question, in the kiosk\'s order');
    fd.querySelectorAll('#conditions select').forEach((x) => { x.value = 'no'; });
    fset('cond_diabetes', 'yes'); fset('cond_pregnant', 'na');
    // "No medications" clears the ticks, and a tick clears it — as at the kiosk.
    const medOn = () => Array.from(fd.querySelectorAll('#medchips input:checked')).map((x) => x.name === 'med' ? x.value : x.id);
    const medLit = () => Array.from(fd.querySelectorAll('#medchips .chip.on input')).map((x) => x.name === 'med' ? x.value : x.id);
    ftick('input[name=med][value=warfarin]'); ftick('#medications_none');
    const noneOnly = same(medOn(), ['medications_none']) && same(medLit(), ['medications_none']);
    ftick('input[name=med][value=metformin]');
    log(noneOnly && same(medOn(), ['metformin']) && same(medLit(), ['metformin']),
      'online form (real page): "No medications" clears the ticked medications, and a tick clears it');
    ftick('input[name=med][value=other]');
    fd.querySelector('#meds input').value = 'Fish oil';
    // Worded as the kiosk words it: "Other" on both lists, and the typed
    // allergy under a label of its own.
    const chipText = (doc, name) => doc.querySelector('input[name=' + name + '][value=other]').closest('label').textContent;
    const esPage = new JSDOM(await (await workerV.fetch(new Request('https://sync.example/checkin/evt-online?lang=es'), envV, {})).text()).window.document;
    const allergyOtherLabel = fd.querySelector('label[for=allergies_other]');
    log(chipText(fd, 'med') === st.CATALOG.en.common.other && chipText(fd, 'allergy') === st.CATALOG.en.common.other
      && chipText(esPage, 'med') === st.CATALOG.es.common.other && chipText(esPage, 'allergy') === st.CATALOG.es.common.other
      && !!allergyOtherLabel && allergyOtherLabel.textContent.startsWith(st.CATALOG.en.intake.allergyOther),
    'online form (real page): "Other" and the typed-allergy label read exactly as at the kiosk, in English and Spanish');
    fset('major_surgery', 'no'); fset('tobacco', 'no'); fset('allergy_status', 'yes'); ftick('input[name=allergy][value=penicillin]');
    fset('prior_dentist', 'never');
    fd.querySelectorAll('select').forEach((x) => { if (st.DENTAL_QUESTIONS.some((q) => q.key === x.id)) x.value = 'no'; });
    ftick('#cagree'); fset('signer', 'Olivia Online');
    const pdE = new fw.Event('pointerdown', { bubbles: true }); pdE.clientX = 1; pdE.clientY = 1; fd.getElementById('gsig').dispatchEvent(pdE);
    log(fsubmit() === '' && !!fw.__posted && fw.__posted.form_version === 2, 'online form (real page): a complete form submits');
    const postRes = await workerV.fetch(new Request('https://sync.example/checkin/evt-online', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fw.__posted) }), envV, {});
    const patRow = rowsV.find((r) => r[1] === 'patient');
    const onlineData = patRow ? JSON.parse(patRow[6]) : null;
    const onlineMh = onlineData ? JSON.parse(onlineData.medical_history) : {};
    log(postRes.status === 200 && !rowsV.some((r) => r[1] === 'survey') && JSON.parse(onlineData.demographics).city === 'Sandy',
      'online form (real page): accepted, the typed town canonicalised, and no survey row filed');
    const kioskSame = mhx.normalizeMedical({ under_treatment: 'no', condition_answers: { ...ANS, diabetes: 'yes', pregnant: 'na' }, conditions_other: '',
      medications: [{ key: 'metformin', name: 'Metformin (Glucophage)' }, { key: 'other', name: 'Fish oil' }], major_surgery: 'no', surgery_sites: [], tobacco: 'no',
      allergy_status: 'yes', allergies: ['penicillin'], allergies_other: '' });
    // Key order is not meaning, so both are compared with keys sorted at EVERY
    // depth. (A replacer array would not do: it filters nested keys as well, so
    // condition_answers and each medication row would compare as {}.)
    const stableV = (v) => (Array.isArray(v) ? v.map(stableV)
      : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stableV(v[k])])) : v);
    const sortedJ = (o) => JSON.stringify(stableV(o));
    log(sortedJ({ a: { x: 1 }, m: [{ key: 'warfarin' }] }) !== sortedJ({ a: { x: 2 }, m: [{ key: 'aspirin' }] })
      && sortedJ(onlineMh) === sortedJ(kioskSame) && Object.keys(onlineMh.condition_answers).length === 25,
    'online form (real page): stores exactly the history the kiosk stores for the same answers — every answer and medication compared');
    const evOn = db.getActiveEvent();
    db.applyRemoteRows([{ entity: 'patient', uid: 'online-v15-uid', event_uid: evOn.uid, patient_uid: null, deleted: 0, updated_at: '2099-05-05T00:00:00.000Z@prereg', data: onlineData }]);
    const onlineP = db.listPatients({}).find((x) => x.last_name === 'Online');
    const onlineCards = onlineP ? cardsText(onlineP).textContent : '';
    log(/Diabetes – Type 1 or Type 2/.test(onlineCards) && /Metformin \(Glucophage\)/.test(onlineCards) && /Penicillin/.test(onlineCards) && /Sandy/.test(onlineCards),
      'online form: the pre-registration arrives by sync and reads on the chart like a walk-in');
  }

  /* ===== Supplies ===========================================================
     On hand is SUMMED from a ledger, never stored as an editable number. The
     property that matters is that a correction is recorded rather than
     overwriting history — a clinic packing a van needs to answer "did we use 40
     boxes or leave them behind", and an edited count cannot answer it. */
  {
    currentUser = signInAdmin();
    const gloves = db.saveInventoryItem(currentUser, { name: 'Exam gloves — medium', category: 'PPE', unit: 'box', par_level: 5 });
    const lido = db.saveInventoryItem(currentUser, { name: 'Lidocaine 2%', category: 'Anaesthetic', unit: 'carpule', par_level: 50 });
    log(gloves.on_hand === 0, 'supplies: a new item starts at zero — adding it is not the same as having it');

    db.recordInventoryMove(currentUser, { item_id: gloves.id, delta: 12, reason: 'received', note: 'Donation' });
    db.recordInventoryMove(currentUser, { item_id: gloves.id, delta: -3, reason: 'used' });
    log(db.getInventoryItem(gloves.id).on_hand === 9, 'supplies: on hand is the running total of what moved');

    // The point of the ledger.
    db.recordInventoryMove(currentUser, { item_id: gloves.id, delta: -2, reason: 'adjusted', note: 'Recount' });
    const g = db.getInventoryItem(gloves.id);
    log(g.on_hand === 7, 'supplies: a correction changes the count');
    log(g.moves.length === 3, 'supplies: and it is recorded as a correction rather than overwriting the history');
    log(g.moves.some((m) => m.reason === 'received' && m.delta === 12),
      'supplies: the original delivery is still on the record after a correction');
    log(g.moves.every((m) => m.created_by_name), 'supplies: every movement records who made it');

    // Low and out are different problems and a clinic reads them differently.
    db.recordInventoryMove(currentUser, { item_id: lido.id, delta: 100, reason: 'received' });
    db.recordInventoryMove(currentUser, { item_id: lido.id, delta: -60, reason: 'used' });
    const list = db.listInventory();
    const L = Object.fromEntries(list.map((i) => [i.name, i]));
    log(L['Lidocaine 2%'].status === 'low', 'supplies: at or below the reorder level reads as low');
    log(L['Exam gloves — medium'].status === 'ok', 'supplies: comfortably stocked reads as in stock');
    db.recordInventoryMove(currentUser, { item_id: gloves.id, delta: -7, reason: 'used' });
    log(db.listInventory().find((i) => i.id === gloves.id).status === 'out',
      'supplies: nothing left reads as out, not as low');

    // Consumption is per clinic, which is what a restock list is built from.
    log(L['Lidocaine 2%'].used_here === 60, 'supplies: what this clinic consumed is counted separately from the balance');

    // Supplies are clinic property, not patient data: a patient purge must not
    // take the stock list with it.
    const beforePurge = db.listInventory().length;
    db.purgeEventPatients(currentUser, Number(db.getSetting('active_event_id')));
    log(db.listInventory().length === beforePurge,
      'supplies: purging patient records leaves the supply list alone');

    // Deleting an item takes its ledger with it — and tombstones both, or the
    // cloud would rebuild the item on the next pull.
    const tmp = db.saveInventoryItem(currentUser, { name: 'Temp item', unit: 'each' });
    db.recordInventoryMove(currentUser, { item_id: tmp.id, delta: 5, reason: 'received' });
    const raw = rawDb();
    const uid = raw.prepare('SELECT uid FROM inventory_items WHERE id = ?').get(tmp.id);
    raw.close();
    db.deleteInventoryItem(currentUser, tmp.id);
    log(!db.getInventoryItem(tmp.id), 'supplies: a deleted item is gone');
    const raw2 = rawDb();
    const moves = raw2.prepare('SELECT COUNT(*) AS n FROM inventory_moves WHERE item_id = ?').get(tmp.id).n;
    const tombed = uid && uid.uid
      ? raw2.prepare('SELECT COUNT(*) AS n FROM tombstones WHERE uid = ?').get(uid.uid).n : 0;
    raw2.close();
    log(moves === 0, 'supplies: its ledger goes with it');
    log(!uid || !uid.uid || tombed === 1, 'supplies: and the deletion is recorded so another laptop cannot resurrect it');

    // Refusals.
    let bad = 0;
    try { db.saveInventoryItem(currentUser, { name: '   ' }); } catch (e) { bad++; }
    try { db.recordInventoryMove(currentUser, { item_id: gloves.id, delta: 0, reason: 'used' }); } catch (e) { bad++; }
    try { db.recordInventoryMove(currentUser, { item_id: 999999, delta: 1, reason: 'received' }); } catch (e) { bad++; }
    log(bad === 3, 'supplies: a nameless item, a zero movement and an unknown item are all refused');

    // The screen itself.
    const storeInv = (await import('../src/renderer/js/store.js')).store;
    storeInv.setUser(currentUser);
    const ctxInv = { navigate: () => {}, toast: () => {}, store: storeInv, setDetail: () => {} };
    const invView = (await import('../src/renderer/js/views/inventory.js')).renderInventory(ctxInv);
    document.body.append(invView);
    for (let i = 0; i < 8; i++) await tick();
    const txt = invView.textContent;
    log(/Supplies/.test(txt), 'supplies: the screen renders');
    log(/Exam gloves/.test(txt) && /Lidocaine/.test(txt), 'supplies: it lists the tracked items');
    log(/On hand/.test(txt) && /Reorder at/.test(txt) && /Used this clinic/.test(txt),
      'supplies: it shows the balance, the reorder level and what this clinic used');
    log(/run out|reorder level/i.test(txt), 'supplies: what is wrong right now is stated at the top of the screen');
    const quick = Array.from(invView.querySelectorAll('button')).filter((b) => b.textContent === '−1' || b.textContent === '+1');
    log(quick.length >= 2, 'supplies: stock can be moved from the list without opening the item');
    const before = db.getInventoryItem(lido.id).on_hand;
    quick.find((b) => b.textContent === '−1' && b.closest('tr').textContent.includes('Lidocaine')).click();
    for (let i = 0; i < 8; i++) await tick();
    log(db.getInventoryItem(lido.id).on_hand === before - 1,
      'supplies: the one-tap control records a real movement');

    // Wording. A clinic lead reads this screen aloud to whoever is packing the
    // van, so it has to be English: no "item(s)", no "14 boxs", no "70 eachs".
    const txt2 = invView.textContent;
    log(!/\(s\)/.test(txt2), 'supplies: the screen counts things in English, never "item(s)"');
    // textContent runs the cells together ("39 carpules501"), so these match on
    // the count-and-unit pair rather than on a trailing word boundary.
    log(!/\d+ (boxs|eachs|carpuless|setss)/.test(txt2),
      'supplies: units are pluralised properly next to their count');
    log(/39 carpules/.test(txt2) && /0 boxes/.test(txt2),
      'supplies: a box is "boxes" and a carpule is "carpules"');

    // Opening an item. A new screen's detail view is where a wiring mistake
    // hides, because the list can render perfectly without it.
    Array.from(invView.querySelectorAll('tr')).find((r) => r.textContent.includes('Lidocaine')).click();
    for (let i = 0; i < 8; i++) await tick();
    // The LAST overlay: an earlier check left one open, and the first match
    // would be that stale one rather than the item just clicked.
    const overlays = document.querySelectorAll('.modal-overlay');
    const card = overlays.length ? overlays[overlays.length - 1].querySelector('.modal-card') : null;
    const cardTxt = card ? card.textContent : '';
    log(/Lidocaine/.test(cardTxt), 'supplies: opening an item shows that item');
    log(/Reorder at/.test(cardTxt) && /Counted in/.test(cardTxt),
      'supplies: the item can be edited from there');
    log(/received|Received/.test(cardTxt) && /100/.test(cardTxt),
      'supplies: and its history is on the same screen, delivery and all');
    const rec = Array.from(card ? card.querySelectorAll('button') : []).find((b) => /Record/.test(b.textContent));
    log(!!rec, 'supplies: a movement can be recorded without leaving the item');
  }

  /* ===== Dental Triage (v0.0.15) ===========================================
     The dentist's station is renamed Dental Triage and gains a Treatment
     Waiting stage, a typed count of X-rays taken, an injection-site dropdown,
     M F L O B surfaces and a Referral card in place of Services. Every one of
     those rides on stored data that older records, older laptops and older
     backups do not have, so the checks come in pairs: a record written the new
     way, and one written the old way, each shown correctly on every screen and
     in every export — and the old laptop's row never allowed to wipe the new. */
  {
    currentUser = signInAdmin();
    const prevEventId = Number(db.getSetting('active_event_id'));
    const evB = db.createEvent(currentUser, { name: 'Dental Triage Clinic', location: 'Sandy' });
    db.setActiveEvent(currentUser, evB.id);
    const DLr = await import('../src/renderer/i18n/dentalLists.js');
    const DLm = require('../src/main/dentalLabels.js');
    const stB = await import('../src/renderer/i18n/strings.js');
    const i18nB = await import('../src/renderer/js/i18n.js');
    const pdfB = require('../src/main/pdf.js');
    const { clinicSheets: sheetsB, summarySheets: summarySheetsB } = require('../src/main/clinicSheets.js');
    const rexB = require('../src/main/reportExport.js');
    const readSrcB = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    const plain = (html) => html.replace(/<style>[\s\S]*?<\/style>/, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const storeB = (await import('../src/renderer/js/store.js')).store; storeB.setUser(currentUser);
    let navB = null; const toastsB = [];
    const ctxB = { navigate: (v) => { navB = v; }, toast: (m) => toastsB.push(m), store: storeB, setDetail: () => {} };
    const settle = async (n = 12) => { for (let i = 0; i < n; i++) await tick(); };
    const GEN = [{ type: 'general', signer_name: 'Chair Side', signature_png: 'data:image/png;base64,AAAA' }];
    const mkB = (first, last, route = 'dentist') => {
      const p = db.createPatient(currentUser, { first_name: first, last_name: last, dob: '1979-04-04', demographics: {}, medical_history: {}, dental_history: {}, consents: GEN });
      db.saveVitals(currentUser, p.id, { bp_systolic: '122', bp_diastolic: '80', heart_rate: '72' });
      db.routePatient(currentUser, p.id, route);
      return p;
    };
    const view = async (file, fn, params = {}) => {
      const node = (await import(`../src/renderer/js/views/${file}`))[fn](ctxB, params);
      document.body.append(node);
      await settle(16);
      return node;
    };
    const btnIn = (node, re) => Array.from(node.querySelectorAll('button')).find((b) => re.test(b.textContent));
    const cardTitled = (node, title) => Array.from(node.querySelectorAll('.card')).find((c) => {
      const t = c.querySelector('.card-title');
      return t && t.textContent.trim().startsWith(title);
    });
    const fieldLabelled = (node, label) => Array.from(node.querySelectorAll('label.field')).find((l) => {
      const s = l.querySelector('.field-label');
      return s && s.textContent.trim() === label;
    });
    const selectedText = (sel) => (sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent : '');
    const toastTexts = () => Array.from(document.querySelectorAll('#toast-host .toast')).map((x) => x.textContent);

    /* ---- the lists, and their CommonJS mirror ---- */
    log(DLr.SURFACES.map((s) => s.key).join('') === 'MFLOB',
      'dental triage: the surface pills are exactly M, F, L, O, B');
    for (const name of ['SURFACES', 'LEGACY_SURFACE_COUNTS', 'ANES_SITES', 'DENTAL_REFERRAL_TO', 'REFERRAL_URGENCY', 'STATUS_LABELS']) {
      log(JSON.stringify(DLr[name]) === JSON.stringify(DLm[name]),
        `dental triage: ${name} in src/main/dentalLabels.js mirrors the renderer list`);
    }
    log(JSON.stringify(stB.ANESTHETICS.map((a) => [a.key, a.en, !!a.retired])) === JSON.stringify(DLm.ANESTHETICS.map((a) => [a.key, a.en, !!a.retired])),
      'dental triage: the printed record and spreadsheet know every anaesthetic in the clinic list, retired ones included');
    log(DLr.DENTAL_REFERRAL_TO.every((d) => d.en && d.es) && DLr.REFERRAL_URGENCY.every((d) => d.en && d.es),
      'dental triage: referral destinations and urgency are translated into Spanish for the patient’s own copy');
    log(new Set(DLr.ANES_SITES.map((s) => s.key)).size === DLr.ANES_SITES.length && DLr.ANES_SITES[DLr.ANES_SITES.length - 1].key === 'other',
      'dental triage: injection sites have unique keys and end with Other');
    const surfCases = [[['O', 'M'], 'MO'], ['1,2', '1-surface, 2-surface'], ['MOD', 'MOD'], [['2', 'M'], 'M, 2-surface'], [[], ''], [null, ''], [['b', 'L'], 'LB']];
    log(surfCases.every(([v, want]) => DLr.formatSurfaces(v) === want && DLm.formatSurfaces(v) === want),
      'dental triage: surfaces read "MO" in canonical order and a legacy count reads "2-surface", on screen and on paper alike');
    log(['checked_in', 'triaged', 'treatment_waiting', 'in_treatment', 'completed', 'dismissed'].every((k) => DLr.STATUS_LABELS[k] && DLr.STATUS_LABELS[k] !== k)
      && DLr.STATUS_LABELS.triaged === 'Waiting for provider' && DLr.STATUS_LABELS.treatment_waiting === 'Treatment waiting',
      'dental triage: every patient status has one label, "Waiting for provider" and "Treatment waiting" included');

    /* ---- the station's name, not the person's ---- */
    log(i18nB.t('nav.provider') === 'Dental Triage' && i18nB.t('roles.doctor') === 'Dentist',
      'dental triage: the station is called Dental Triage, while the staff role is still "Dentist"');
    i18nB.setLang('es');
    log(i18nB.t('nav.provider') === 'Triaje dental', 'dental triage: and "Triaje dental" in Spanish');
    i18nB.setLang('en');
    let gateMsg = '';
    const novit = db.createPatient(currentUser, { first_name: 'Vic', last_name: 'Novitals', consents: GEN });
    try { db.routePatient(currentUser, novit.id, 'dentist'); } catch (e) { gateMsg = e.message; }
    log(/Dental Triage/.test(gateMsg) && !/dentist/.test(gateMsg), 'dental triage: the vitals gate names the station Dental Triage');

    /* ---- a record written the old way ---- */
    const leg = mkB('Lena', 'Legacy');
    // As v0.0.14 wrote it: an "X-ray station #", surface COUNTS (one row as a
    // string), a typed injection site, an agent key this build does not list,
    // Services counts and the retired triage checklist's referral tick.
    db.saveTriage(currentUser, leg.id, { complaint: 'Old pain', xray_count: 0, xray_station: '3', status: 'ready', checklist: { referral: true } });
    db.addXray(currentUser, leg.id, { station: '3', image_png: 'data:image/jpeg;base64,AAAA', note: 'Legacy_Lena_T14.jpg' });
    db.addXray(currentUser, leg.id, { station: '3', image_png: 'data:image/jpeg;base64,BBBB', note: 'Legacy_Lena_T3.jpg' });
    db.saveTreatment(currentUser, leg.id, {
      fillings: [{ tooth: '14', surfaces: ['2'], post: true }, { tooth: '3', surfaces: '1,2' }],
      anesthetic: [{ agent: 'mepivacaine', carps: '1', location: '#14 lingual', tooth: '14' }, { agent: 'supplemental', carps: '0.5' }],
      cleaning: { teeth: [], quad_detail: '' },
      restorative: { denture: { on: true, kind: 'partial', action: 'new' } },
      services: { pulpotomy: '1', irm: '', alveoplasty: '2' },
    });

    const provL = await view('provider.js', 'renderProvider', { id: leg.id });
    const txtL = provL.textContent;
    log(!!fieldLabelled(provL, 'Number of X-rays taken') && /Images uploaded/.test(txtL) && !/X-ray station #/.test(txtL),
      'dental triage: the visit panel asks for the number of X-rays taken, beside the images uploaded');
    log(/X-ray station \(recorded earlier\)\s*3/.test(txtL),
      'dental triage: a station number from an older visit is still shown, read-only');
    const pillsL = Array.from(provL.querySelectorAll('.filling-row')).map((r) => Array.from(r.querySelectorAll('.surf-chip')).map((b) => b.textContent));
    log(pillsL.length === 2 && pillsL[0].slice(0, 5).join('') === 'MFLOB',
      'dental triage: a filling offers the pills M F L O B');
    log(pillsL.length === 2 && pillsL[0].includes('2-surf') && pillsL[1].includes('1-surf') && pillsL[1].includes('2-surf'),
      'dental triage: an older record’s surface COUNT shows as its own chip — and a count stored as a string no longer breaks the screen');
    log(provL.querySelectorAll('.surf-chip--legacy').length === 3 && Array.from(provL.querySelectorAll('.surf-chip--legacy')).every((c) => c.tagName === 'SPAN'),
      'dental triage: a surface count cannot be edited — it is shown as recorded and kept');
    const anesL = Array.from(provL.querySelectorAll('.anes-admin-row'));
    const [agentL0, siteL0] = anesL.length ? anesL[0].querySelectorAll('select') : [];
    log(!!siteL0 && siteL0.value === '#14 lingual' && /\(recorded\) #14 lingual/.test(selectedText(siteL0)),
      'dental triage: a typed injection site from an older record is kept as a "(recorded)" choice, selected');
    log(!!siteL0 && DLr.ANES_SITES.every((s) => Array.from(siteL0.options).some((o) => o.value === s.key)) && siteL0.options[0].value === '',
      'dental triage: the injection site is a dropdown of the standard sites, starting blank');
    log(!!agentL0 && agentL0.value === 'mepivacaine' && anesL.length === 2 && anesL[1].querySelector('select').value === 'supplemental',
      'dental triage: an agent key this build does not list is shown as recorded rather than turned into "Other"');
    const refCardL = cardTitled(provL, 'Referral');
    log(!!refCardL && !cardTitled(provL, 'Services') && !/Record the number performed/.test(txtL),
      'dental triage: the Services card is replaced by a Referral card');
    log(!!refCardL && /Services recorded earlier/.test(refCardL.textContent) && /Alveoplasty × 2/.test(refCardL.textContent) && /Pulpotomy × 1/.test(refCardL.textContent),
      'dental triage: Services counts recorded earlier stay visible, read-only');
    log(!!refCardL && /earlier triage checklist marked this patient for referral/.test(refCardL.textContent),
      'dental triage: the retired triage checklist’s referral tick is pointed out rather than lost');

    btnIn(provL, /^Save progress$/).click();
    await settle();
    const legA = db.getPatient(leg.id);
    log(legA.triage.xray_station === '3' && legA.triage.xrays_taken == null,
      'dental triage: re-saving an older visit keeps its x-ray station and does not invent a count');
    log(legA.treatment.anesthetic.length === 2 && legA.treatment.anesthetic[0].agent === 'mepivacaine'
      && legA.treatment.anesthetic[0].location === '#14 lingual' && legA.treatment.anesthetic[1].agent === 'supplemental',
      'dental triage: re-saving keeps each recorded agent and typed site exactly as they were');
    log(JSON.stringify(legA.treatment.fillings.map((f) => f.surfaces)) === JSON.stringify([['2'], ['1', '2']]),
      'dental triage: re-saving keeps an older filling’s surface count');
    log(legA.treatment.services.pulpotomy === '1' && legA.treatment.services.alveoplasty === '2' && (legA.treatment.restorative.denture || {}).on === true,
      'dental triage: a save from the new screen keeps Services (no longer collected) and Restorative');
    log(legA.treatment.referral_out === null, 'dental triage: a save with the Referral card left empty records no referral');

    const legProg = plain(pdfB.buildHtml(legA, 'progress'));
    const legSum = plain(pdfB.buildHtml(legA, 'summary'));
    log(/#14 · 2-surface/.test(legProg) && /#3 · 1-surface, 2-surface/.test(legSum),
      'dental triage: an older filling prints its surface count, on the progress note and the patient summary');
    log(/Mepivacaine 3%/.test(legProg) && !/\bmepivacaine\b/.test(legProg) && /#14 lingual/.test(legProg) && /Supplemental/.test(legSum),
      'dental triage: the printed record names the agent (never "mepivacaine") and keeps the site as typed');
    log(/X-rays taken: 2 · Images uploaded: 2/.test(legProg) && /X-ray station 3 \(recorded earlier\)/.test(legProg),
      'dental triage: an older visit prints its images as the x-rays taken, and its station as recorded earlier');
    log(/Denture — partial, new/.test(legSum) && /Pulpotomy × 1/.test(legSum) && /Denture — partial, new/.test(legProg),
      'dental triage: Restorative and the earlier Services now reach the printed record');
    log(/Cleaning None/.test(legProg) && /Cleaning None/.test(legSum),
      'dental triage: the teeth tapped on the chart are not printed as a cleaning');
    log(/Referral \(triage checklist\)/.test(legProg), 'dental triage: the retired checklist’s referral tick prints by name');

    /* ---- a record written the new way, through the screen ---- */
    const nw = mkB('Nora', 'Newrec');
    const provN = await view('provider.js', 'renderProvider', { id: nw.id });
    const takenIn = fieldLabelled(provN, 'Number of X-rays taken').querySelector('input');
    setInput(takenIn, '150');
    btnIn(provN, /Move Patient to Treatment Waiting/).click();
    await settle();
    log(db.getPatient(nw.id).status === 'triaged' && toastTexts().some((m) => /whole number from 0 to 99/.test(m)),
      'dental triage: an impossible X-ray count is refused at the chair, and nothing is saved');
    let serverRefusal = '';
    try { db.saveTriage(currentUser, nw.id, { complaint: 'x', xrays_taken: '-1', status: 'ready' }); } catch (e) { serverRefusal = e.message; }
    log(/whole number/.test(serverRefusal) && db.getPatient(nw.id).triage.complaint !== 'x',
      'dental triage: the data layer refuses it too, before writing anything');
    setInput(takenIn, '4');
    const fillRow = provN.querySelector('.filling-row');
    setInput(fillRow.querySelector('input'), '30');
    ['O', 'M'].forEach((k) => Array.from(fillRow.querySelectorAll('.surf-chip')).find((b) => b.textContent === k).click());
    const anesN = provN.querySelector('.anes-admin-row');
    const [agentN, siteN] = anesN.querySelectorAll('select');
    log(agentN.value === stB.ANESTHETICS.find((a) => !a.retired).key && siteN.value === '',
      'dental triage: a new administration starts on the first agent the clinic stocks, with no site chosen');
    setInput(anesN.querySelector('input[type="number"]'), '1');
    setInput(siteN, 'ianb');
    btnIn(provN, /Add anesthetic/).click();
    await settle(2);
    const anesN2 = Array.from(provN.querySelectorAll('.anes-admin-row')).pop();
    setInput(anesN2.querySelector('input[type="number"]'), '1');
    const siteN2 = anesN2.querySelectorAll('select')[1];
    setInput(siteN2, 'other');
    const otherSite = Array.from(anesN2.querySelectorAll('input')).find((i) => i.placeholder === 'Describe the site');
    log(!!otherSite && otherSite.style.display !== 'none', 'dental triage: choosing Other asks where');
    setInput(otherSite, 'Palatal papilla');
    const refCardN = cardTitled(provN, 'Referral');
    const refUrg = refCardN.querySelector('select');
    log(refUrg.options[0].value === '' && refUrg.options[0].textContent === '—' && Array.from(refUrg.options).map((o) => o.value).slice(1).join() === 'routine,soon,urgent',
      'dental triage: referral urgency is a dropdown that starts blank');
    Array.from(refCardN.querySelectorAll('.chip-select')).filter((b) => /^(Oral surgeon|Other)$/.test(b.textContent)).forEach((b) => b.click());
    await settle(1);
    const refOther = Array.from(refCardN.querySelectorAll('input')).find((i) => i.placeholder === 'Name the clinic or provider');
    log(!!refOther && refOther.closest('label').style.display !== 'none', 'dental triage: ticking Other asks where the patient is referred');
    setInput(refOther, 'Dr Lee, Riverside');
    setInput(refUrg, 'urgent');
    setInput(Array.from(refCardN.querySelectorAll('input')).find((i) => i.placeholder === 'Tooth #'), '17');
    setInput(refCardN.querySelector('textarea'), 'Impacted third molar');
    navB = null;
    btnIn(provN, /Move Patient to Treatment Waiting/).click();
    await settle();
    const nwA = db.getPatient(nw.id);
    log(nwA.status === 'treatment_waiting' && nwA.triage.status === 'treatment_waiting' && navB === 'provider',
      'dental triage: "Move Patient to Treatment Waiting" parks the patient for a treatment chair and returns to the queue');
    log(!!nwA.triage.treatment_waiting_at && nwA.treatment_waiting_by_name === currentUser.full_name && !nwA.treatment.completed_at && !nwA.treatment.locked,
      'dental triage: the move is stamped with who and when, and neither completes nor locks the visit');
    log(db.patientAudit(nw.id).some((a) => a.action === 'treatment_waiting'), 'dental triage: the move is in the patient’s audit trail');
    log(nwA.triage.xrays_taken === 4, 'dental triage: the number of X-rays taken is saved as a number');
    log(DLr.formatSurfaces(nwA.treatment.fillings[0].surfaces) === 'MO', 'dental triage: surfaces ticked O then M are saved and read as "MO"');
    const [a0, a1] = nwA.treatment.anesthetic;
    log(a0 && a0.location === 'ianb' && a0.agent === 'lidocaine' && a1 && a1.location === 'other' && a1.location_other === 'Palatal papilla',
      'dental triage: the injection site is stored as its list key, with Other’s text beside it');
    const roN = nwA.treatment.referral_out || {};
    log(JSON.stringify(roN.to) === JSON.stringify(['oral_surgeon', 'other']) && roN.to_other === 'Dr Lee, Riverside' && roN.urgency === 'urgent' && roN.tooth === '17' && roN.reason === 'Impacted third molar',
      'dental triage: the referral is stored under referral_out — destinations, other, urgency, tooth and reason');
    log(!nwA.demographics.referral, 'dental triage: it never touches demographics.referral (how the patient heard about MMW)');

    // Everywhere that names a status.
    const { statusPill: pillB } = await import('../src/renderer/js/views/dashboard.js');
    log(pillB('treatment_waiting').textContent === 'Treatment waiting' && pillB('triaged').textContent === 'Waiting for provider',
      'dental triage: the status pill reads "Treatment waiting", and "Waiting for provider" for triaged');
    const queueB = await view('provider.js', 'renderProvider');
    const waitCard = cardTitled(queueB, 'Treatment waiting');
    const triCard = cardTitled(queueB, 'Dental Triage');
    log(!!waitCard && /Newrec, Nora/.test(waitCard.textContent) && /waiting \d/.test(waitCard.textContent) && !!triCard && !/Newrec/.test(triCard.textContent) && /Legacy, Lena/.test(triCard.textContent),
      'dental triage: the queue shows Dental Triage and Treatment waiting as separate lists, with how long each patient has waited');
    const dashB = await view('dashboard.js', 'renderDashboard');
    const colB = (label) => Array.from(dashB.querySelectorAll('.crm-col')).find((c) => c.querySelector('.crm-col-label').textContent === label);
    log(!!colB('Treatment waiting') && /Newrec, Nora/.test(colB('Treatment waiting').textContent) && /Legacy, Lena/.test(colB('Dental Triage').textContent),
      'dental triage: the live board has a Treatment waiting column holding the patient');
    log(Array.from(dashB.querySelectorAll('.stat-card')).some((c) => /Treatment waiting/.test(c.textContent) && /\b1\b/.test(c.querySelector('.stat-value').textContent))
      && db.dashboardStats().treatment_waiting === 1,
      'dental triage: and a Treatment waiting count at the top');
    navB = null;
    Array.from(colB('Treatment waiting').querySelectorAll('.crm-card')).find((c) => /Newrec/.test(c.textContent)).click();
    log(navB === 'provider', 'dental triage: opening a waiting patient from the board goes to Dental Triage, never to Check-Out');
    const listedB = db.listPatients({}).find((p) => p.id === nw.id);
    log(listedB.treatment_waiting_at === nwA.triage.treatment_waiting_at, 'dental triage: the queue rows carry when the wait began');

    // The treating dentist takes the patient in.
    const provW = await view('provider.js', 'renderProvider', { id: nw.id });
    log(/Treatment waiting — examined at Dental Triage by Administrator/.test(provW.textContent) && !btnIn(provW, /Move Patient to Treatment Waiting/),
      'dental triage: a waiting patient’s chart says so, and does not offer the move again');
    btnIn(provW, /^Save progress$/).click();
    await settle();
    log(db.getPatient(nw.id).status === 'in_treatment', 'dental triage: saving a waiting patient’s chart takes them into treatment');
    const queueB2 = await view('provider.js', 'renderProvider');
    log(/Newrec, Nora/.test(cardTitled(queueB2, 'In treatment').textContent) && !/Newrec/.test(cardTitled(queueB2, 'Treatment waiting').textContent),
      'dental triage: and they move to the In treatment list');
    const dashB2 = await view('dashboard.js', 'renderDashboard');
    const inTx = Array.from(dashB2.querySelectorAll('.crm-col')).find((c) => c.querySelector('.crm-col-label').textContent === 'In treatment');
    log(!!inTx && /Newrec, Nora/.test(inTx.textContent), 'dental triage: the board shows them in treatment');

    // Other stations: the EMT's routing, the hygienist, Arrivals, Management.
    const emtB = await view('emt.js', 'renderEmt', { id: leg.id });
    log(/sent to Dental Triage/.test(emtB.textContent), 'dental triage: the vitals station says it sent the patient to Dental Triage');
    const both = mkB('Hal', 'Bothroute', 'both');
    db.saveTreatment(currentUser, both.id, {
      fillings: [{ tooth: '8', surfaces: ['F'] }],
      restorative: { recement: { on: true, tooth: '8' } }, services: { irm: '1' },
      referral_out: { to: ['endodontist'], urgency: 'soon', reason: 'Root canal' },
    }, 'waiting');
    let saveErr = '';
    try { db.saveTriage(currentUser, both.id, { ...db.getPatient(both.id).triage, status: 'ready' }); } catch (e) { saveErr = e.message; }
    log(!saveErr && db.getPatient(both.id).status === 'treatment_waiting',
      'dental triage: a triage save marked ready does not pull a waiting patient back out of the queue for a chair');
    db.saveTreatment(currentUser, both.id, { ...db.getPatient(both.id).treatment }, 'waiting');
    db.createUser(currentUser, { username: 'hyg_dt', full_name: 'Hy Gienist', role: 'hygienist', password: 'x' });
    const hygUser = db.login('hyg_dt', 'x');
    currentUser = hygUser; storeB.setUser(hygUser);
    const hygQ = await view('hygienist.js', 'renderHygienist');
    log(/Bothroute, Hal/.test(hygQ.textContent), 'dental triage: a patient routed to both stays in the cleaning queue while waiting for a chair');
    const hygD = await view('hygienist.js', 'renderHygienist', { id: both.id });
    log(!!btnIn(hygD, /Transfer to Dental Triage/), 'dental triage: the hygienist’s transfer button names Dental Triage');
    Array.from(hygD.querySelectorAll('.chip-btn')).find((b) => /Adult prophy/.test(b.textContent)).click();
    btnIn(hygD, /^Save cleaning$/).click();
    await settle();
    const bothA = db.getPatient(both.id);
    log(bothA.treatment.cleaning.adult_prophy === true && (bothA.treatment.restorative.recement || {}).on === true
      && bothA.treatment.services.irm === '1' && ((bothA.treatment.referral_out || {}).to || [])[0] === 'endodontist',
      'dental triage: a hygienist’s save keeps the dentist’s Restorative, Services and Referral');
    log(bothA.status === 'treatment_waiting', 'dental triage: and the patient keeps their place in the queue for a chair');
    // The data layer itself, for any writer that leaves the keys out (an older
    // portable file, an older hygienist build).
    db.saveTreatment({ id: null, role: 'hygienist', full_name: 'Hy Gienist' }, both.id, { fillings: bothA.treatment.fillings, cleaning: { ohi: true } }, 'cleaning');
    const bothB = db.getPatient(both.id);
    log((bothB.treatment.restorative.recement || {}).on === true && bothB.treatment.services.irm === '1' && ((bothB.treatment.referral_out || {}).to || [])[0] === 'endodontist',
      'dental triage: a treatment save that leaves Restorative, Services or Referral out keeps them as stored');
    currentUser = signInAdmin(); storeB.setUser(currentUser);

    const arrP = db.createPatient(currentUser, { first_name: 'Ada', last_name: 'Arrivee', dob: '1990-01-01', demographics: {}, medical_history: {}, dental_history: { visit_type: 'filling' }, consents: GEN });
    void arrP;
    const arrB = await view('arrivals.js', 'renderArrivals');
    log(Array.from(arrB.querySelectorAll('option')).some((o) => o.value === 'dentist' && o.textContent === 'Dental Triage'),
      'dental triage: Arrivals offers Dental Triage as the station');
    const scanIn = arrB.querySelector('.scan-input');
    toastsB.length = 0;
    if (scanIn) {
      scanIn.value = bothA.patient_code;
      scanIn.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle(8);
    }
    log(toastsB.some((m) => /Bothroute/.test(m) && /waiting for a treatment chair/.test(m)),
      'dental triage: scanning a waiting patient at Arrivals says where they are');
    const mgB = await view('management.js', 'renderManagement');
    const mgRow = Array.from(mgB.querySelectorAll('tr')).find((r) => /Legacy, Lena/.test(r.textContent));
    log(!!mgRow && /Dental Triage/.test(mgRow.querySelector('.pill--teal').textContent) && !!btnIn(mgRow, /^Dental Triage$/) && !!btnIn(mgRow, /^Treatment waiting$/),
      'dental triage: Management labels the route Dental Triage and can move a patient to Treatment waiting');

    // Admin moves in and out of the stage.
    let gate = '';
    try { db.adminMovePatient(currentUser, novit.id, 'treatment_waiting'); } catch (e) { gate = e.message; }
    log(/vitals/i.test(gate), 'dental triage: an admin cannot move a patient without vitals into Treatment waiting');
    const mv = mkB('Max', 'Mover');
    db.adminMovePatient(currentUser, mv.id, 'treatment_waiting');
    let mvP = db.getPatient(mv.id);
    log(mvP.status === 'treatment_waiting' && !!mvP.triage.treatment_waiting_at, 'dental triage: an admin can move a patient to Treatment waiting');
    db.routePatient(currentUser, mv.id, 'hygienist');
    mvP = db.getPatient(mv.id);
    log(mvP.status === 'treatment_waiting' && mvP.triage.status === 'treatment_waiting',
      'dental triage: re-routing a waiting patient keeps them waiting, triage and patient status alike');
    db.adminMovePatient(currentUser, mv.id, 'dentist');
    mvP = db.getPatient(mv.id);
    log(mvP.status === 'triaged' && mvP.triage.route === 'dentist' && mvP.triage.treatment_waiting_at == null,
      'dental triage: sending a waiting patient back to Dental Triage puts them back in its queue');
    db.adminMovePatient(currentUser, mv.id, 'treatment_waiting');
    db.adminMovePatient(currentUser, mv.id, 'emt');
    mvP = db.getPatient(mv.id);
    log(mvP.status === 'checked_in' && mvP.triage.treatment_waiting_at == null, 'dental triage: walking a patient back to vitals clears the wait');

    // A USB record carries the stage with it.
    const port = mkB('Paz', 'Portable');
    db.saveTreatment(currentUser, port.id, { referral_out: { to: ['physician'] } }, 'waiting');
    const portable = { ...db.getPatient(port.id), xrays: db.listXrays(port.id) };
    db.saveTreatment(currentUser, port.id, { fillings: [] });
    db.importPatientFromPortable(currentUser, portable);
    const portA = db.getPatient(port.id);
    log(portA.status === 'treatment_waiting' && portA.triage.treatment_waiting_at === portable.triage.treatment_waiting_at
      && ((portA.treatment.referral_out || {}).to || [])[0] === 'physician',
      'dental triage: a USB record of a patient waiting for a chair imports still waiting, with the original stamp');

    // A prior visit's status is labelled, and its teeth list is not a cleaning.
    const pri1 = mkB('Priya', 'Prior');
    db.saveTreatment(currentUser, pri1.id, { fillings: [{ tooth: '2', surfaces: ['O'] }], cleaning: { teeth: [], quad_detail: '' } }, 'waiting');
    const pri2 = db.createPatient(currentUser, { first_name: 'Priya', last_name: 'Prior', dob: '1979-04-04', consents: GEN });
    const hist = db.patientHistory(pri2.id);
    log(hist.length >= 1 && hist[0].summary === '1 filling(s)', 'dental triage: a prior visit’s summary no longer calls the teeth list a cleaning');
    const { patientHistoryCards: phcB } = await import('../src/renderer/js/components/patientHistory.js');
    const histTxt = phcB(db.getPatient(pri2.id), hist).map((n) => n.textContent).join(' ');
    log(/Treatment waiting/.test(histTxt) && !/treatment_waiting/.test(histTxt), 'dental triage: a prior visit’s status is shown by name, never as a code');

    /* ---- printed record, spreadsheet, reports ---- */
    const nwP = db.getPatient(nw.id);
    const nwProg = plain(pdfB.buildHtml({ ...nwP, status: 'treatment_waiting' }, 'progress'));
    const nwSum = plain(pdfB.buildHtml(nwP, 'summary'));
    log(/Status Treatment waiting/.test(nwProg), 'dental triage: the progress note prints the status by name');
    log(/X-rays taken: 4 · Images uploaded: 0/.test(nwProg) && !/X-ray station/.test(nwProg),
      'dental triage: the progress note prints the X-rays taken, separately from the images uploaded');
    log(/#30 · MO/.test(nwProg) && /#30 · MO/.test(nwSum), 'dental triage: a filling prints its surfaces as "MO"');
    log(/Lidocaine 2% × 1 carp\(s\) · Inferior alveolar nerve block \(IANB\)/.test(nwSum) && /Palatal papilla/.test(nwProg),
      'dental triage: the injection site prints by name, and Other by what was typed');
    log(/Referral Referred to: Oral surgeon, Dr Lee, Riverside · Urgency: Urgent · Tooth #17 Impacted third molar/.test(nwSum)
      && /Referred to: Oral surgeon, Dr Lee, Riverside/.test(nwProg),
      'dental triage: the referral prints on the patient summary and the progress note');
    const agentsPrinted = stB.ANESTHETICS.every((a) => {
      const h = plain(pdfB.buildHtml({ first_name: 'A', last_name: 'B', medical_history: {}, triage: {}, consents: [], treatment: { anesthetic: [{ agent: a.key, carps: '1' }] } }, 'summary'));
      return h.includes(a.en) && !new RegExp(`\\b${a.key}\\b`).test(h);
    });
    log(agentsPrinted, 'dental triage: every agent in the clinic list prints by name on the patient summary');
    const sitesPrinted = DLr.ANES_SITES.filter((s) => s.key !== 'other').every((s) => {
      const h = plain(pdfB.buildHtml({ first_name: 'A', last_name: 'B', medical_history: {}, triage: {}, consents: [], treatment: { anesthetic: [{ agent: 'articaine', location: s.key }] } }, 'progress'));
      return h.includes(s.en);
    });
    log(sitesPrinted, 'dental triage: every injection site prints by name on the progress note');
    const objShape = plain(pdfB.buildHtml({ first_name: 'A', last_name: 'B', medical_history: {}, triage: {}, consents: [], treatment: { anesthetic: { bupivacaine: { carps: '2', location: 'buccal' } }, fillings: [{ tooth: '9', surfaces: 'MO' }] } }, 'summary'));
    log(/Bupivacaine 0\.5% × 2 carp\(s\) · buccal/.test(objShape) && /#9 · MO/.test(objShape),
      'dental triage: the earliest stored shapes (anaesthetic keyed by agent, surfaces as a string) still print');

    const bundleB = db.exportClinicBundle(evB.id);
    const shB = sheetsB(bundleB);
    const rowOf = (sheet, last) => {
      const S = shB.find((x) => x.name === sheet);
      const r = S.rows.find((x) => x[0] === last);
      return r ? Object.fromEntries(S.columns.map((c, i) => [c, r[i]])) : {};
    };
    const legT = rowOf('Treatment', 'Legacy');
    log(legT['Teeth filled'] === '14 2-surface, 3 1-surface, 2-surface' && /Mepivacaine 3% × 1 carp\(s\), tooth 14, #14 lingual/.test(legT.Anaesthetic),
      'dental triage: the spreadsheet prints an older record’s surface counts, agent by name and typed site');
    log(legT.Cleaning === '' && legT.Restorative === 'Denture — partial, new' && legT['Services (recorded before v0.0.15)'] === 'Alveoplasty × 2; Pulpotomy × 1'
      && legT['X-rays taken'] === 2 && legT['X-rays uploaded'] === 2,
      'dental triage: and its Restorative, earlier Services and x-rays, with no cleaning invented from the teeth list');
    const nwT = rowOf('Treatment', 'Newrec');
    log(nwT['Teeth filled'] === '30 MO' && /Inferior alveolar nerve block \(IANB\)/.test(nwT.Anaesthetic) && /Palatal papilla/.test(nwT.Anaesthetic),
      'dental triage: the spreadsheet prints new surfaces and the injection site, which it did not export before');
    log(nwT['Referred to'] === 'Oral surgeon, Dr Lee, Riverside' && nwT['Referral urgency'] === 'Urgent' && nwT['Referral details'] === '#17 — Impacted third molar' && nwT['X-rays taken'] === 4,
      'dental triage: the spreadsheet carries the referral and the X-rays taken');
    const bothP = rowOf('Patients', 'Bothroute');
    log(bothP['Sent to'] === 'Dental Triage + Hygienist' && bothP.Status === 'Treatment waiting' && rowOf('Patients', 'Legacy')['Sent to'] === 'Dental Triage',
      'dental triage: the spreadsheet names the station Dental Triage and the status Treatment waiting');

    const sumB = db.buildEventSummary(evB.id);
    const rawB = rawDb();
    const wantTaken = rawB.prepare(`SELECT t.xrays_taken AS typed, (SELECT COUNT(*) FROM xrays x WHERE x.patient_id = p.id) AS n
      FROM patients p LEFT JOIN triage t ON t.patient_id = p.id WHERE p.event_id = ?`).all(evB.id)
      .reduce((acc, r) => acc + (r.typed != null ? r.typed : r.n), 0);
    rawB.close();
    log(sumB.xrays_taken === wantTaken && sumB.xrays === 2 && sumB.xrays_taken >= 6,
      `dental triage: the report counts X-rays taken as typed, or the images for a visit without the count (${sumB.xrays_taken} taken, ${sumB.xrays} uploaded)`);
    log(sumB.referrals === 3 && sumB.by_status.treatment_waiting >= 2, 'dental triage: the report counts referrals and patients waiting for a chair');
    const mergedB = db.mergeSummaries([{ patients_seen: 3, xrays: 5 }, sumB]);
    log(mergedB.xrays_taken === sumB.xrays_taken + 5 && mergedB.referrals === sumB.referrals,
      'dental triage: totals kept before v0.0.15 contribute their images as x-rays taken, and no referrals');
    const secB = Object.fromEntries(rexB.reportSections(sumB, 'This clinic').map((x) => [x.title, x]));
    const procB = Object.fromEntries(secB['Procedures and imaging'].rows);
    log(procB['X-rays taken'] === sumB.xrays_taken && procB['X-ray images uploaded'] === 2 && procB['Referred elsewhere for care'] === 3,
      'dental triage: the exported report separates X-rays taken from images uploaded, and counts referrals');
    log(secB['Where patients were in the clinic'].rows.some((r) => r[0] === 'Treatment waiting') && !secB['Where patients were in the clinic'].rows.some((r) => /_/.test(r[0])),
      'dental triage: the exported report names every stage, Treatment waiting included');
    const oldRep = Object.fromEntries(rexB.reportSections({ xrays: 7 }, 'Old').find((x) => x.title === 'Procedures and imaging').rows);
    log(oldRep['X-rays taken'] === 7, 'dental triage: a report kept before v0.0.15 still says how many x-rays were taken');
    const sumRows = Object.fromEntries(summarySheetsB(sumB)[0].rows);
    log(sumRows['X-rays taken'] === sumB.xrays_taken && sumRows['X-rays uploaded'] === 2 && sumRows['Referred elsewhere for care'] === 3,
      'dental triage: the clinic spreadsheet’s summary sheet agrees');
    const repB = await view('reports.js', 'renderReports');
    log(/X-rays taken/.test(repB.textContent) && /X-rays uploaded/.test(repB.textContent) && /Treatment waiting/.test(repB.textContent) && /Waiting for provider/.test(repB.textContent),
      'dental triage: the Reports tab shows X-rays taken and uploaded, and every stage by name');

    /* ---- the retire-safe anaesthetic list ---- */
    const provSrcB = readSrcB('../src/renderer/js/views/provider.js');
    log(/station: ''/.test(provSrcB) && !/station\.input/.test(provSrcB),
      'dental triage: an uploaded x-ray is no longer stamped with the typed count as its station');
    log(/ANESTHETICS\.filter\(\(a\) => !a\.retired\)\.map/.test(readSrcB('../src/renderer/js/views/inventory.js')),
      'dental triage: the supplies starter list skips retired anaesthetics');
    const mep = stB.ANESTHETICS.find((a) => a.key === 'mepivacaine');
    const lido = stB.ANESTHETICS.find((a) => a.key === 'lidocaine');
    mep.retired = true; lido.retired = true;
    try {
      const provR = await view('provider.js', 'renderProvider', { id: leg.id });
      const optsOf = (row) => Array.from(row.querySelector('select').options).map((o) => o.value);
      log(optsOf(provR.querySelectorAll('.anes-admin-row')[0]).includes('mepivacaine'),
        'dental triage: a retired agent is still offered on the row that records it');
      btnIn(provR, /Add anesthetic/).click();
      await settle(2);
      const fresh = Array.from(provR.querySelectorAll('.anes-admin-row')).pop();
      log(!optsOf(fresh).includes('mepivacaine') && !optsOf(fresh).includes('lidocaine') && fresh.querySelector('select').value === 'articaine',
        'dental triage: a retired agent is not offered for a new administration, and the default is the first agent still stocked');
      btnIn(provR, /^Save progress$/).click();
      await settle();
      log(db.getPatient(leg.id).treatment.anesthetic[0].agent === 'mepivacaine',
        'dental triage: a retired agent is saved back as itself, not rewritten to "Other"');
      log(/Mepivacaine 3%/.test(plain(pdfB.buildHtml(db.getPatient(leg.id), 'progress'))), 'dental triage: and still prints by name');
    } finally { delete mep.retired; delete lido.retired; }

    // A locked record's referral is read-only.
    const lk = mkB('Lou', 'Lockedref');
    db.saveTreatment(currentUser, lk.id, { referral_out: { to: ['periodontist'], urgency: 'routine' }, provider_signature: 'data:image/png;base64,S', provider_name: 'Dr' }, 'lock');
    const provK = await view('provider.js', 'renderProvider', { id: lk.id });
    const refK = cardTitled(provK, 'Referral');
    log(!!refK && Array.from(refK.querySelectorAll('button, select, input, textarea')).every((n) => n.disabled)
      && /chip-select--on/.test(Array.from(refK.querySelectorAll('.chip-select')).find((b) => /Periodontist/.test(b.textContent)).className),
      'dental triage: a locked record shows its referral, and cannot change it');

    /* ---- sync safety: an older laptop, an older backup ---- */
    const rawU = (sql, ...a) => { const r = rawDb(); try { return r.prepare(sql).get(...a); } finally { r.close(); } };
    const rawRun = (sql, ...a) => { const r = rawDb(); try { r.prepare(sql).run(...a); } finally { r.close(); } };
    const collected = db.collectSyncRows(5000).rows;
    const legTxUid = rawU('SELECT uid FROM treatments WHERE patient_id = ?', leg.id).uid;
    const legTriUid = rawU('SELECT uid FROM triage WHERE patient_id = ?', leg.id).uid;
    const legPUid = rawU('SELECT uid FROM patients WHERE id = ?', leg.id).uid;
    const nwTriRow = collected.find((r) => r.uid === rawU('SELECT uid FROM triage WHERE patient_id = ?', nw.id).uid);
    log(!!nwTriRow && nwTriRow.data.xrays_taken === 4 && !!nwTriRow.data.treatment_waiting_at && nwTriRow.data.treatment_waiting_by_name === 'Administrator',
      'sync safety: X-rays taken and the Treatment Waiting stamp travel with the triage row');
    const nwTxRow = collected.find((r) => r.uid === rawU('SELECT uid FROM treatments WHERE patient_id = ?', nw.id).uid);
    log(!!nwTxRow && /oral_surgeon/.test(nwTxRow.data.referral_out || '') && nwTxRow.data.restorative != null && nwTxRow.data.services != null,
      'sync safety: the referral, Restorative and Services travel with the treatment row');
    const legTxRow = collected.find((r) => r.uid === legTxUid);
    // What a laptop still on v0.0.14 sends: no restorative, services or referral_out.
    const oldTx = { ...legTxRow.data };
    delete oldTx.restorative; delete oldTx.services; delete oldTx.referral_out;
    oldTx.clinical_notes = 'Edited on a laptop still running v0.0.14';
    const age = (table, uid) => rawRun(`UPDATE ${table} SET updated_at = '2000-01-01T00:00:00.000Z@here' WHERE uid = ?`, uid);
    const recent = () => new Date(Date.now() - 5000).toISOString() + '@oldlaptop';
    age('treatments', legTxUid);
    const oldStamp = recent();
    const resOld = db.applyRemoteRows([{ entity: 'treatment', uid: legTxUid, patient_uid: legPUid, event_uid: null, deleted: 0, updated_at: oldStamp, data: oldTx }]);
    const legS = db.getPatient(leg.id);
    log(resOld.applied === 1 && legS.treatment.clinical_notes === 'Edited on a laptop still running v0.0.14',
      'sync safety: a treatment row from a laptop that has not been upgraded applies, rather than being skipped');
    log((legS.treatment.restorative.denture || {}).on === true && legS.treatment.services.pulpotomy === '1',
      'sync safety: and this laptop keeps the Restorative and Services the older laptop never had');
    const rePush = db.collectSyncRows(5000).rows.find((r) => r.uid === legTxUid);
    log(!!rePush && /denture/.test(rePush.data.restorative) && rePush.updated_at > oldStamp && rePush.data.clinical_notes === oldTx.clinical_notes,
      'sync safety: the merged row is sent back, so the cloud copy the older laptop overwrote gets them back');
    // Stamped just above the older laptop's edit, not "now": a current stamp
    // outranked every edit a colleague made after the older laptop's, so the
    // colleague's genuine later edit was refused here and lost in the cloud.
    const peerLater = new Date(Date.now() - 2500).toISOString() + '@peer';
    log(!!rePush && rePush.updated_at.startsWith(oldStamp + '~') && rePush.updated_at < peerLater,
      'sync safety: the merged row is stamped just above the older laptop’s edit, never with the time it was merged');
    const resPeer = db.applyRemoteRows([{ entity: 'treatment', uid: legTxUid, patient_uid: legPUid, event_uid: null, deleted: 0, updated_at: peerLater,
      data: { ...rePush.data, clinical_notes: 'A colleague’s edit, made after the older laptop’s' } }]);
    log(resPeer.applied === 1 && db.getPatient(leg.id).treatment.clinical_notes === 'A colleague’s edit, made after the older laptop’s'
      && (db.getPatient(leg.id).treatment.restorative.denture || {}).on === true,
      'sync safety: so a colleague’s later edit still wins over the merged row, in a mixed fleet as anywhere');
    const legTriRow = collected.find((r) => r.uid === legTriUid);
    const oldTri = { ...legTriRow.data };
    delete oldTri.xrays_taken; delete oldTri.treatment_waiting_at; delete oldTri.treatment_waiting_by_name;
    oldTri.notes = 'Triage note from the older laptop';
    rawRun('UPDATE triage SET xrays_taken = 5 WHERE uid = ?', legTriUid);
    age('triage', legTriUid);
    db.applyRemoteRows([{ entity: 'triage', uid: legTriUid, patient_uid: legPUid, event_uid: null, deleted: 0, updated_at: recent(), data: oldTri }]);
    const legT2 = db.getPatient(leg.id).triage;
    log(legT2.notes === 'Triage note from the older laptop' && legT2.xrays_taken === 5,
      'sync safety: a triage row without the new columns keeps this laptop’s X-rays taken');
    age('treatments', legTxUid);
    db.applyRemoteRows([{ entity: 'treatment', uid: legTxUid, patient_uid: legPUid, event_uid: null, deleted: 0, updated_at: recent(),
      data: { ...oldTx, restorative: '{}', services: '{}', referral_out: null, clinical_notes: 'From an upgraded laptop that never had them' } }]);
    const legS2 = db.getPatient(leg.id).treatment;
    log(legS2.clinical_notes === 'From an upgraded laptop that never had them' && (legS2.restorative.denture || {}).on === true && legS2.services.pulpotomy === '1',
      'sync safety: an empty {} from a peer never overwrites a real Restorative or Services entry');
    age('treatments', legTxUid);
    db.applyRemoteRows([{ entity: 'treatment', uid: legTxUid, patient_uid: legPUid, event_uid: null, deleted: 0, updated_at: recent(),
      data: { ...oldTx, restorative: JSON.stringify({ core_buildup: { on: true, tooth: '8' } }), services: '{}' } }]);
    log((db.getPatient(leg.id).treatment.restorative.core_buildup || {}).tooth === '8' && !db.getPatient(leg.id).treatment.restorative.denture,
      'sync safety: while a real edit from a peer still replaces it');
    const evUidB = db.listEvents().find((e) => e.id === evB.id).uid;
    const isoB = new Date().toISOString();
    const resIns = db.applyRemoteRows([
      { entity: 'patient', uid: 'dt-old-laptop-patient', event_uid: evUidB, patient_uid: null, deleted: 0, updated_at: recent(), data: {
        language: 'en', first_name: 'Olaf', last_name: 'Oldlaptop', dob: null, gender: null, phone: null, email: null,
        demographics: '{}', medical_history: '{}', dental_history: '{}', status: 'in_treatment', created_at: isoB,
        dismissed_at: null, dismissed_by_name: null, arrived_at: null, arrived_by_name: null } },
      { entity: 'treatment', uid: 'dt-old-laptop-treatment', event_uid: null, patient_uid: 'dt-old-laptop-patient', deleted: 0, updated_at: recent(), data: {
        fillings: JSON.stringify([{ tooth: '19', surfaces: ['3'] }]), extractions: '[]', cleaning: '{}', anesthetic: '[]',
        other_procedures: null, clinical_notes: null, provider_name: 'Dr Old', provider_signature: null, locked: 0, completed_at: null, completed_by_name: null } },
    ]);
    const olaf = db.listPatients({}).find((p) => p.last_name === 'Oldlaptop');
    const olafP = olaf ? db.getPatient(olaf.id) : null;
    log(resIns.applied === 2 && !!olafP && olafP.treatment.fillings[0].tooth === '19' && JSON.stringify(olafP.treatment.restorative) === '{}' && olafP.treatment.referral_out === null,
      'sync safety: a new treatment from an older laptop is created with the defaults for what it did not send');
    log(!!olafP && /#19 · 3-surface/.test(plain(pdfB.buildHtml(olafP, 'progress'))),
      'sync safety: and prints correctly');

    // A clinic backup from before these columns existed.
    const rest = mkB('Rhea', 'Restore');
    db.saveTriage(currentUser, rest.id, { complaint: 'r', xrays_taken: 3, status: 'ready' });
    db.saveTreatment(currentUser, rest.id, { restorative: { bridge: { on: true, action: 'repair' } }, referral_out: { to: ['prosthodontist'] } });
    const oldBundle = JSON.parse(JSON.stringify(db.exportClinicBundle(evB.id)));
    oldBundle.treatments.forEach((t) => { delete t.restorative; delete t.services; delete t.referral_out; });
    oldBundle.triage.forEach((t) => { delete t.xrays_taken; delete t.treatment_waiting_at; delete t.treatment_waiting_by; delete t.treatment_waiting_by_name; });
    let restoreErr = '';
    try { db.importClinicBundle(currentUser, oldBundle); } catch (e) { restoreErr = e.message; }
    const restA = db.getPatient(rest.id);
    log(!restoreErr && restA.triage.xrays_taken === 3 && (restA.treatment.restorative.bridge || {}).on === true && ((restA.treatment.referral_out || {}).to || [])[0] === 'prosthodontist',
      'sync safety: restoring an older backup over this clinic keeps what the backup never had' + (restoreErr ? ': ' + restoreErr : ''));
    db.deletePatient(currentUser, rest.id);
    restoreErr = '';
    try { db.importClinicBundle(currentUser, oldBundle); } catch (e) { restoreErr = e.message; }
    const restBack = db.listPatients({}).find((p) => p.last_name === 'Restore');
    const restB = restBack ? db.getPatient(restBack.id) : null;
    log(!restoreErr && !!restB && JSON.stringify(restB.treatment.restorative) === '{}' && restB.treatment.referral_out === null && restB.triage.xrays_taken == null,
      'sync safety: and an older backup restores into an empty laptop, taking the defaults' + (restoreErr ? ': ' + restoreErr : ''));

    /* ---- after review: the seams an adversarial pass found ---- */
    // A USB record of a patient an admin parked for a chair without charting
    // anything (no treatment row), and of one taken from the wait into a chair.
    const PARKED_AT = '2026-01-02T03:04:05.000Z';
    const pw = mkB('Wanda', 'Parkedonly');
    db.adminMovePatient(currentUser, pw.id, 'treatment_waiting');
    rawRun("UPDATE triage SET treatment_waiting_at = ?, treatment_waiting_by_name = 'Dr Parker' WHERE patient_id = ?", PARKED_AT, pw.id);
    const pwFile = { ...db.getPatient(pw.id), xrays: [] };
    db.deletePatient(currentUser, pw.id);
    const pwBack = db.importPatientFromPortable(currentUser, pwFile);
    log(!pwFile.treatment && pwBack.status === 'treatment_waiting' && pwBack.triage.status === 'treatment_waiting'
      && pwBack.triage.treatment_waiting_at === PARKED_AT && pwBack.treatment_waiting_by_name === 'Dr Parker',
      'dental triage: a USB record of a patient parked for a chair with nothing charted imports still waiting, with who parked them and when');
    const pc = mkB('Chet', 'Chairtaken');
    db.saveTreatment(currentUser, pc.id, { fillings: [] }, 'waiting');
    rawRun("UPDATE triage SET treatment_waiting_at = ?, treatment_waiting_by_name = 'Dr Parker' WHERE patient_id = ?", PARKED_AT, pc.id);
    db.saveTreatment(currentUser, pc.id, { fillings: [{ tooth: '5', surfaces: ['O'] }] });
    const pcFile = { ...db.getPatient(pc.id), xrays: [] };
    db.deletePatient(currentUser, pc.id);
    const pcBack = db.importPatientFromPortable(currentUser, pcFile);
    const queueR = await view('provider.js', 'renderProvider');
    log(pcBack.status === 'in_treatment' && pcBack.triage.treatment_waiting_at === PARKED_AT && pcBack.treatment_waiting_by_name === 'Dr Parker'
      && /Chairtaken, Chet/.test(cardTitled(queueR, 'In treatment').textContent) && !/Chairtaken/.test(cardTitled(queueR, 'Dental Triage').textContent),
      'dental triage: a USB record of a patient taken from the wait into a chair imports in treatment — not back in Dental Triage’s list');

    // Which station saved, not who is signed in, decides whether a cleaning
    // takes a waiting patient out of the queue for a chair.
    const bw = mkB('Bea', 'Bothwait', 'both');
    db.saveTreatment(currentUser, bw.id, { fillings: [] }, 'waiting');
    const hygAdm = await view('hygienist.js', 'renderHygienist', { id: bw.id });
    Array.from(hygAdm.querySelectorAll('.chip-btn')).find((b) => /Adult prophy/.test(b.textContent)).click();
    btnIn(hygAdm, /^Save cleaning$/).click();
    await settle();
    const bwA = db.getPatient(bw.id);
    log(currentUser.role === 'admin' && bwA.status === 'treatment_waiting' && bwA.treatment.cleaning.adult_prophy === true,
      'dental triage: an administrator saving a cleaning on the hygienist’s screen leaves a patient waiting for a chair in the queue');
    db.saveTreatment(currentUser, bw.id, { ...bwA.treatment });
    log(db.getPatient(bw.id).status === 'in_treatment', 'dental triage: while a Dental Triage save by the same administrator takes them into treatment');

    // The dashboard's counts and the board's columns.
    const dashR = await view('dashboard.js', 'renderDashboard');
    const statsR = db.dashboardStats();
    const tilesR = Array.from(dashR.querySelectorAll('.stat-card'));
    log(!tilesR.some((c) => /In treatment/.test(c.textContent))
      && tilesR.some((c) => /With a provider/.test(c.textContent) && c.querySelector('.stat-value').textContent === String(statsR.in_treatment))
      && Array.from(dashR.querySelectorAll('.step-name')).some((n) => n.textContent === 'With a provider'),
      'dental triage: the count of everyone in treatment is called "With a provider", so it never contradicts the board’s narrower In treatment column');
    const inTxR = Array.from(dashR.querySelectorAll('.crm-col')).find((c) => c.querySelector('.crm-col-label').textContent === 'In treatment');
    const cardR = inTxR && Array.from(inTxR.querySelectorAll('.crm-card')).find((c) => /Chairtaken/.test(c.textContent));
    log(!!cardR && /since triage$/.test(cardR.querySelector('.crm-chip--stage').textContent),
      'dental triage: the In treatment column times a patient from when Dental Triage parked them, and says so');

    // A referral is somewhere to send the patient.
    const rn = mkB('Ren', 'Nodest');
    const provRn = await view('provider.js', 'renderProvider', { id: rn.id });
    const refRn = cardTitled(provRn, 'Referral');
    setInput(refRn.querySelector('select'), 'urgent');
    btnIn(provRn, /^Save progress$/).click();
    await settle();
    log(toastTexts().some((m) => /Required: Refer to/.test(m)) && !db.getPatient(rn.id).treatment,
      'dental triage: an urgency with nowhere to send the patient is refused, naming "Refer to", and nothing is saved');
    Array.from(refRn.querySelectorAll('.chip-select')).find((b) => b.textContent === 'Oral surgeon').click();
    btnIn(provRn, /^Save progress$/).click();
    await settle();
    log((((db.getPatient(rn.id).treatment || {}).referral_out) || {}).urgency === 'urgent', 'dental triage: and is saved once a destination is ticked');
    const halfRef = { first_name: 'A', last_name: 'B', medical_history: {}, triage: {}, consents: [], treatment: { referral_out: { to: [], to_other: '', urgency: 'urgent', tooth: '', reason: 'x' } } };
    log(!/Referred to|Referral/.test(plain(pdfB.buildHtml(halfRef, 'summary'))) && !/Referred to/.test(plain(pdfB.buildHtml(halfRef, 'progress'))),
      'dental triage: the printed record shows a Referral only when the patient is sent somewhere, the rule every count uses');
    const refCases = [null, {}, { to: [] }, { to: ['other'] }, { to: [], to_other: ' ' }, { to: [], to_other: 'Dr X' }, { to: ['physician'], urgency: 'soon' }, { urgency: 'urgent', reason: 'x' }];
    log(refCases.every((r) => DLr.hasReferralOut(r) === DLm.hasReferralOut(r)) && refCases.filter((r) => DLm.hasReferralOut(r)).length === 3,
      'dental triage: the records screen and the printed record agree on what counts as a referral');
    log(!('referralDestinations' in DLr) && !('anesSiteText' in DLr) && typeof DLm.referralDestinations === 'function' && typeof DLm.anesSiteText === 'function',
      'dental triage: how a referral and a site read is decided once, in the copy the printed record uses');

    // The provisional lists retire entries rather than lose them.
    const siteR = DLr.ANES_SITES.find((x) => x.key === 'psa');
    const destR = DLr.DENTAL_REFERRAL_TO.find((x) => x.key === 'orthodontist');
    siteR.retired = true; destR.retired = true;
    try {
      const rt = mkB('Rita', 'Retired');
      db.saveTreatment(currentUser, rt.id, { anesthetic: [{ agent: 'articaine', carps: '1', location: 'psa' }], referral_out: { to: ['orthodontist', 'teledentistry'], urgency: 'routine' } });
      const provRt = await view('provider.js', 'renderProvider', { id: rt.id });
      const siteSel = provRt.querySelector('.anes-admin-row').querySelectorAll('select')[1];
      log(siteSel.value === 'psa' && selectedText(siteSel) === siteR.en, 'dental triage: a retired injection site is still shown by name on the row that records it');
      btnIn(provRt, /Add anesthetic/).click();
      await settle(2);
      const freshSite = Array.from(provRt.querySelectorAll('.anes-admin-row')).pop().querySelectorAll('select')[1];
      log(!Array.from(freshSite.options).some((o) => o.value === 'psa'), 'dental triage: and is not offered for a new administration');
      const chipsRt = Array.from(cardTitled(provRt, 'Referral').querySelectorAll('.chip-select'));
      const onOf = (label) => { const b = chipsRt.find((x) => x.textContent === label); return b ? b.classList.contains('chip-select--on') : null; };
      log(onOf('Orthodontist') === true && onOf('(recorded) teledentistry') === true && chipsRt[chipsRt.length - 1].textContent === 'Other',
        'dental triage: a retired or unknown referral destination on a record is shown ticked, where the dentist can see it and untick it');
      btnIn(provRt, /^Save progress$/).click();
      await settle();
      const rtP = db.getPatient(rt.id);
      log(rtP.treatment.anesthetic[0].location === 'psa' && JSON.stringify(rtP.treatment.referral_out.to) === JSON.stringify(['orthodontist', 'teledentistry']),
        'dental triage: a re-save keeps a retired site and destination as recorded');
      log(/Posterior superior alveolar block \(PSA\)/.test(plain(pdfB.buildHtml(rtP, 'progress'))) && /Orthodontist/.test(plain(pdfB.buildHtml(rtP, 'summary'))),
        'dental triage: and they still print by name');
      const provFresh = await view('provider.js', 'renderProvider', { id: mkB('Fay', 'Fresh').id });
      const freshChips = Array.from(cardTitled(provFresh, 'Referral').querySelectorAll('.chip-select')).map((b) => b.textContent);
      log(!freshChips.includes('Orthodontist') && freshChips.includes('Oral surgeon'), 'dental triage: a retired destination is not offered on a new record');
    } finally { delete siteR.retired; delete destR.retired; }

    // Keys an early build stored for procedures print by name.
    const earlyKeys = { first_name: 'A', last_name: 'B', medical_history: {}, triage: {}, consents: [], treatment: { cleaning: { scaling: true }, extractions: [{ tooth: '1', type: 'simple' }] } };
    log(['progress', 'summary', 'full'].every((f) => { const h = plain(pdfB.buildHtml(earlyKeys, f)); return /Deep scaling/.test(h) && /#1 · Simple/.test(h) && !/· simple|Cleaning scaling/.test(h); }),
      'dental triage: an early record’s "scaling" cleaning and single extraction type print by name, not as codes');

    // Upgrading a laptop that has synced: separate process, because it needs a
    // database hashed the way v0.0.14 hashed it, then a real restart.
    const { execFileSync: execB } = await import('node:child_process');
    const { fileURLToPath: toPathB } = await import('node:url');
    const upgradeProbe = `
      const os=require('os'),fs=require('fs'),path=require('path'),crypto=require('crypto');
      const B=require('better-sqlite3');
      const db=require(process.argv[2]);
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mmwcols-'));
      const file=db.init(dir);
      const out={};
      const admin=db.login('admin','admin');
      const ev=db.createEvent(admin,{name:'Upgraded clinic',location:'X'});
      db.setActiveEvent(admin,ev.id);
      const GEN=[{type:'general',signer_name:'X',signature_png:'data:image/png;base64,AAAA'}];
      const mk=(first)=>{const p=db.createPatient(admin,{first_name:first,last_name:'Upgrade',dob:'1980-01-01',consents:GEN});
        db.saveVitals(admin,p.id,{bp_systolic:'120',bp_diastolic:'80',heart_rate:'70'});db.routePatient(admin,p.id,'dentist');return p;};
      const quiet=mk('Quiet'); db.saveTreatment(admin,quiet.id,{fillings:[{tooth:'3',surfaces:['2']}],clinical_notes:'as synced'});
      const dent=mk('Denture'); db.saveTreatment(admin,dent.id,{restorative:{denture:{on:true,kind:'full',action:'new'}}});
      const edit=mk('Edited'); db.saveTreatment(admin,edit.id,{clinical_notes:'edited offline, not sent yet'});
      const first=db.collectSyncRows(5000); db.markSynced(first.mark);
      /* As v0.0.14 left it: every triage and treatment row hashed under the
         column lists it synced with, which knew none of the new columns. */
      const V14=db.SYNC_COLS_BEFORE_V0_0_15;
      const sha=(o)=>crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
      const pick=(data,cols)=>{const o={};for(const c of cols)o[c]=data[c]===undefined?null:data[c];return o;};
      let raw=new B(file);
      const uidOf=(t,pid)=>raw.prepare('SELECT uid FROM '+t+' WHERE patient_id=?').get(pid).uid;
      const U={qTri:uidOf('triage',quiet.id),qTx:uidOf('treatments',quiet.id),dTri:uidOf('triage',dent.id),dTx:uidOf('treatments',dent.id),eTx:uidOf('treatments',edit.id)};
      const before={};
      for (const r of first.rows) {
        if (r.entity!=='triage'&&r.entity!=='treatment') continue;
        const s=sha(pick(r.data,V14[r.entity]));
        raw.prepare('UPDATE '+(r.entity==='triage'?'triage':'treatments')+' SET synced_rev=?, content_rev=? WHERE uid=?').run(s,s,r.uid);
        before[r.uid]=r.updated_at;
      }
      raw.prepare("UPDATE treatments SET synced_rev='an earlier revision' WHERE uid=?").run(U.eTx);
      raw.prepare("DELETE FROM settings WHERE key='sync_cols_seen'").run();
      raw.close(); db.close();
      db.init(dir);   /* the upgraded launch */
      const up=db.collectSyncRows(5000);
      const sent=Object.fromEntries(up.rows.map((r)=>[r.uid,r]));
      out.quiet=!sent[U.qTri]&&!sent[U.qTx]&&!sent[U.dTri];
      out.only=up.rows.length===2;
      out.dentBumped=!!sent[U.dTx]&&sent[U.dTx].updated_at.startsWith(before[U.dTx]+'~');
      out.dentCarries=!!sent[U.dTx]&&/denture/.test(sent[U.dTx].data.restorative);
      out.editKeeps=!!sent[U.eTx]&&sent[U.eTx].updated_at===before[U.eTx];
      db.markSynced(up.mark);
      out.cleanAfter=db.collectSyncRows(5000).rows.length===0;
      db.close(); db.init(dir);
      out.restartQuiet=db.collectSyncRows(5000).rows.length===0;
      /* A later release syncing one more column: the lists stored at this
         upgrade are what its rows are recognised by. */
      raw=new B(file); raw.prepare('UPDATE treatments SET synced_rev=NULL').run(); raw.close();
      const all=db.collectSyncRows(5000).rows.filter((r)=>r.entity==='treatment');
      const fewer=Object.keys(all[0].data).filter((c)=>c!=='referral_out');
      raw=new B(file);
      for (const r of all) { const s=sha(pick(r.data,fewer)); raw.prepare('UPDATE treatments SET synced_rev=?, content_rev=? WHERE uid=?').run(s,s,r.uid); }
      raw.prepare("UPDATE settings SET value=? WHERE key='sync_cols_seen'").run(JSON.stringify({treatment:fewer}));
      raw.close(); db.close(); db.init(dir);
      out.laterRelease=db.collectSyncRows(5000).rows.length===0;
      db.close(); fs.rmSync(dir,{recursive:true,force:true});
      process.stdout.write(JSON.stringify(out));
    `;
    const upgradeFile = path.join(toPathB(new URL('.', import.meta.url)), '.upgrade-probe.cjs');
    let upR = {};
    try {
      fs.writeFileSync(upgradeFile, upgradeProbe);
      upR = JSON.parse(execB(process.execPath, [upgradeFile, toPathB(new URL('../src/main/db.js', import.meta.url))], { encoding: 'utf8' }));
    } catch (e) { upR = { error: String(e.message || e).slice(0, 300) }; }
    finally { fs.rmSync(upgradeFile, { force: true }); }
    log(upR.quiet && upR.only,
      'sync safety: upgrading re-sends no triage or treatment row nobody edited, so a laptop that was behind cannot push its stale copy over newer edits' + (upR.error ? ': ' + upR.error : ''));
    log(upR.dentBumped && upR.dentCarries,
      'sync safety: a Restorative entry that never synced is sent once, stamped just above its own last edit, so it cannot outrank a later one');
    log(upR.editKeeps, 'sync safety: an edit made before the upgrade and not yet sent keeps the time it was made');
    log(upR.cleanAfter && upR.restartQuiet, 'sync safety: once sent, nothing is sent again, and a restart does not redo the upgrade');
    log(upR.laterRelease, 'sync safety: a later release that syncs another column is handled the same way, from the lists stored at this upgrade');

    /* ---- after a second review ---- */
    // Treatment Waiting is Dental Triage's queue for a chair, however the
    // patient gets there: a dentist parking a patient opened from the
    // hygienist's list routes them there, as an admin move does.
    const hp = mkB('Hugo', 'Hygparked', 'hygienist');
    const provHp = await view('provider.js', 'renderProvider', { id: hp.id });
    btnIn(provHp, /Move Patient to Treatment Waiting/).click();
    await settle();
    const hpA = db.getPatient(hp.id);
    log(hpA.status === 'treatment_waiting' && hpA.triage.route === 'dentist' && db.patientAudit(hp.id).some((a) => a.action === 'route' && a.detail === 'dentist'),
      'dental triage: a patient opened from the hygienist’s list and moved to Treatment Waiting is routed to Dental Triage, as an admin move routes them');
    const queueHp = await view('provider.js', 'renderProvider');
    const hygListHp = Array.from(queueHp.querySelectorAll('details')).find((d) => /^At the hygienist/.test(d.querySelector('summary').textContent));
    log(/Hygparked, Hugo/.test(cardTitled(queueHp, 'Treatment waiting').textContent) && !(hygListHp && /Hygparked/.test(hygListHp.textContent)),
      'dental triage: and they are in the Treatment waiting list, not left in the hygienist’s');
    const dashHp = await view('dashboard.js', 'renderDashboard');
    const colHp = (label) => Array.from(dashHp.querySelectorAll('.crm-col')).find((c) => c.querySelector('.crm-col-label').textContent === label);
    const waitTileHp = Array.from(dashHp.querySelectorAll('.stat-card')).find((c) => /Treatment waiting/.test(c.textContent));
    log(/Hygparked, Hugo/.test(colHp('Treatment waiting').textContent) && !/Hygparked/.test(colHp('Hygienist').textContent)
      && !!waitTileHp && waitTileHp.querySelector('.stat-value').textContent === String(colHp('Treatment waiting').querySelectorAll('.crm-card').length),
      'dental triage: the board files them in the Treatment waiting column, which holds as many patients as its count at the top');
    log(db.getPatient(both.id).triage.route === 'both', 'dental triage: a patient routed to both keeps both routes while waiting for a chair');

    // A USB record states the stage the other laptop has the patient in, even
    // when that is back out of Treatment Waiting.
    const sb = mkB('Sam', 'Sentback');
    db.adminMovePatient(currentUser, sb.id, 'treatment_waiting');
    db.adminMovePatient(currentUser, sb.id, 'dentist');            // the other laptop sent them back
    const sbFile = { ...db.getPatient(sb.id), xrays: [] };
    db.adminMovePatient(currentUser, sb.id, 'treatment_waiting');  // this laptop still has them parked
    const sbA = db.importPatientFromPortable(currentUser, sbFile);
    log(sbFile.status === 'triaged' && sbA.status === 'triaged' && sbA.triage.status === 'ready' && sbA.triage.treatment_waiting_at == null && sbA.treatment_waiting_by_name == null,
      'dental triage: a USB record of a patient sent back to Dental Triage takes this laptop’s copy out of Treatment Waiting, stamp and all');
    const sx = mkB('Sid', 'Reexamined');
    db.saveTreatment(currentUser, sx.id, { fillings: [] }, 'waiting');
    db.adminMovePatient(currentUser, sx.id, 'dentist');
    db.saveTreatment(currentUser, sx.id, { fillings: [{ tooth: '4', surfaces: ['O'] }] });   // examined again at Dental Triage
    const sxFile = { ...db.getPatient(sx.id), xrays: [] };
    db.adminMovePatient(currentUser, sx.id, 'treatment_waiting');
    const sxA = db.importPatientFromPortable(currentUser, sxFile);
    const queueSx = await view('provider.js', 'renderProvider');
    log(sxA.status === 'in_treatment' && sxA.triage.treatment_waiting_at == null
      && /Reexamined, Sid/.test(cardTitled(queueSx, 'Dental Triage').textContent) && !/Reexamined/.test(cardTitled(queueSx, 'In treatment').textContent),
      'dental triage: one being examined again at Dental Triage imports into its list, not the In treatment list');
    const ol = mkB('Otto', 'Olderfile');
    db.saveTreatment(currentUser, ol.id, { fillings: [] }, 'waiting');
    db.saveTreatment(currentUser, ol.id, { fillings: [{ tooth: '6', surfaces: ['F'] }] });   // taken into a chair
    const olStamp = db.getPatient(ol.id).triage.treatment_waiting_at;
    const olFile = JSON.parse(JSON.stringify({ ...db.getPatient(ol.id), xrays: [] }));
    ['treatment_waiting_at', 'treatment_waiting_by', 'treatment_waiting_by_name'].forEach((k) => { delete olFile.triage[k]; });
    delete olFile.treatment_waiting_by_name;
    const olA = db.importPatientFromPortable(currentUser, olFile);
    log(olA.status === 'in_treatment' && !!olStamp && olA.triage.treatment_waiting_at === olStamp,
      'dental triage: a USB record from an older laptop, which knows nothing of the stage, leaves the stamp of a patient taken into a chair here');

    // A referral needs a destination in the data layer too, and a named Other.
    const nd = mkB('Nell', 'Nodestdb');
    let ndErr = '';
    try { db.saveTreatment(currentUser, nd.id, { referral_out: { to: [], urgency: 'urgent', reason: 'check', tooth: '9' } }); } catch (e) { ndErr = e.message; }
    log(/Required: Refer to/.test(ndErr) && !db.getPatient(nd.id).treatment && db.getPatient(nd.id).status === 'triaged',
      'dental triage: the data layer refuses referral details with nowhere to send the patient, as the screen does, before writing anything');
    db.saveTreatment(currentUser, nd.id, { fillings: [] });
    rawRun('UPDATE treatments SET referral_out = ? WHERE patient_id = ?', JSON.stringify({ to: [], to_other: '', urgency: 'urgent', tooth: '9', reason: 'check' }), nd.id);
    const ndSheet = sheetsB(db.exportClinicBundle(evB.id)).find((x) => x.name === 'Treatment');
    const ndRowRaw = ndSheet.rows.find((x) => x[0] === 'Nodestdb');
    const ndRow = ndRowRaw ? Object.fromEntries(ndSheet.columns.map((c, i) => [c, ndRowRaw[i]])) : null;
    log(!!ndRow && ndRow['Referred to'] === '' && ndRow['Referral urgency'] === '' && ndRow['Referral details'] === ''
      && !/Referral/.test(plain(pdfB.buildHtml(db.getPatient(nd.id), 'summary'))),
      'dental triage: details stored with no destination (from any other writer) fill none of the spreadsheet’s referral columns, as the printed record shows none');
    rawRun('UPDATE treatments SET referral_out = NULL WHERE patient_id = ?', nd.id);
    const on = mkB('Omar', 'Othernoname');
    const provOn = await view('provider.js', 'renderProvider', { id: on.id });
    Array.from(cardTitled(provOn, 'Referral').querySelectorAll('.chip-select')).find((b) => b.textContent === 'Other').click();
    await settle(1);
    btnIn(provOn, /^Save progress$/).click();
    await settle();
    log(toastTexts().some((m) => /Required: Other destination/.test(m)) && !db.getPatient(on.id).treatment,
      'dental triage: ticking Other without naming where is refused, naming "Other destination", and nothing is saved');

    // Shapes an early build stored survive a re-save from the new screen.
    const lx = mkB('Lex', 'Earlyshapes');
    db.saveTreatment(currentUser, lx.id, {
      extractions: [{ tooth: '1', type: 'surgical' }, { tooth: '2', type: 'hemisection' }],
      fillings: [{ tooth: '14', surfaces: ['2'], position: 'post' }],
    });
    const provLx = await view('provider.js', 'renderProvider', { id: lx.id });
    const extLx = Array.from(provLx.querySelectorAll('.ext-row'));
    const onLx = (r) => Array.from(r.querySelectorAll('.chip-btn--on')).map((b) => b.textContent);
    log(extLx.length === 2 && onLx(extLx[0]).join() === 'Surgical' && onLx(extLx[1]).length === 0 && /\(recorded\) hemisection/.test(extLx[1].textContent)
      && /post/.test(provLx.querySelector('.filling-row .antpost').textContent),
      'dental triage: an early record’s single extraction type shows ticked, and a type or filling position this build does not offer shows as recorded');
    btnIn(provLx, /^Save progress$/).click();
    await settle();
    const lxT = db.getPatient(lx.id).treatment;
    log(JSON.stringify(lxT.extractions.map((x) => x.types)) === JSON.stringify([['surgical'], ['hemisection']])
      && lxT.fillings[0].position === 'post' && JSON.stringify(lxT.fillings[0].surfaces) === '["2"]',
      'dental triage: re-saving keeps an early record’s extraction type and filling position');
    const lxProg = plain(pdfB.buildHtml(db.getPatient(lx.id), 'progress'));
    log(/#1 · Surgical/.test(lxProg) && /#14 · 2-surface · post/.test(lxProg), 'dental triage: and the printed record still shows them');

    // A cleaning's teeth stored as a string, as older records hold them.
    const ct = mkB('Cleo', 'Stringteeth', 'both');
    db.saveTreatment(currentUser, ct.id, { cleaning: { adult_prophy: true, teeth: '1,2' } });
    const errsCt = errors.length;
    const provCt = await view('provider.js', 'renderProvider', { id: ct.id });
    log(errors.length === errsCt && !!cardTitled(provCt, 'Referral') && /Teeth cleaned:12/.test(provCt.textContent),
      'dental triage: a cleaning whose teeth are stored as a string ("1,2") no longer stops the chart drawing');
    const hygCt = await view('hygienist.js', 'renderHygienist', { id: ct.id });
    btnIn(hygCt, /^Save cleaning$/).click();
    await settle();
    log(JSON.stringify(db.getPatient(ct.id).treatment.cleaning.teeth) === '["1","2"]',
      'dental triage: the hygienist’s screen reads them as teeth 1 and 2 and saves them so — never the comma as a tooth');
    db.saveTreatment(currentUser, ct.id, { cleaning: { adult_prophy: true, teeth: '3 4' } });
    const provCt2 = await view('provider.js', 'renderProvider', { id: ct.id });
    const saveCt2 = btnIn(provCt2, /^Save progress$/);   // absent when the chart failed to draw
    if (saveCt2) saveCt2.click();
    await settle();
    log(errors.length === errsCt && JSON.stringify(db.getPatient(ct.id).treatment.cleaning.teeth) === '["3","4"]',
      'dental triage: and a Dental Triage save writes them back as a list');

    // A pull reads back only a row it may have merged.
    const Sqlite = require('better-sqlite3');
    const prepareB = Sqlite.prototype.prepare;
    const readBacks = [];
    Sqlite.prototype.prepare = function (sql) {
      const m = /^SELECT \* FROM (\w+) WHERE uid = \?$/.exec(sql);
      if (m) readBacks.push(m[1]);
      return prepareB.call(this, sql);
    };
    let resPull;
    try {
      const xp = mkB('Xavi', 'Xraypeer');
      db.collectSyncRows(5000);   // gives the new patient its sync uid
      readBacks.length = 0;
      const xpUid = rawU('SELECT uid FROM patients WHERE id = ?', xp.id).uid;
      const img = 'data:image/jpeg;base64,' + 'QUJD'.repeat(2000);
      resPull = db.applyRemoteRows([
        ...[0, 1, 2].map((i) => ({ entity: 'xray', uid: 'dt-peer-xray-' + i, patient_uid: xpUid, event_uid: null, deleted: 0, updated_at: recent(),
          data: { station: null, image_png: img, note: `peer_${i}.jpg`, created_at: isoB, tooth: String(i + 1) } })),
        { entity: 'treatment', uid: 'dt-peer-treatment', patient_uid: xpUid, event_uid: null, deleted: 0, updated_at: recent(),
          data: { ...nwTxRow.data, clinical_notes: 'From a peer on this version' } },
      ]);
      // A later edit of one of them (recent() could repeat the first stamp to the millisecond).
      resPull = [resPull, db.applyRemoteRows([{ entity: 'xray', uid: 'dt-peer-xray-0', patient_uid: xpUid, event_uid: null, deleted: 0, updated_at: new Date().toISOString() + '@peer',
        data: { station: null, image_png: img, note: 'peer_0_renamed.jpg', created_at: isoB, tooth: '1' } }])];
    } finally { Sqlite.prototype.prepare = prepareB; }
    log(resPull[0].applied === 4 && resPull[1].applied === 1 && readBacks.length === 0,
      'sync safety: a pull does not read back and re-hash a row it applied exactly as it arrived (x-ray images above all)'
        + (readBacks.length ? ': read back ' + readBacks.join(',') : '') + (resPull[0].applied === 4 && resPull[1].applied === 1 ? '' : ': applied ' + resPull.map((r) => r.applied).join('+')));
    log(db.listXrays(db.listPatients({}).find((p) => p.last_name === 'Xraypeer').id).length === 3,
      'sync safety: and those rows are applied');

    if (prevEventId && db.listEvents().some((e) => e.id === prevEventId)) db.setActiveEvent(currentUser, prevEventId);
  }

  /* ===== The report, exported ===============================================
     CSV, Excel and PDF are three renderings of ONE set of section definitions.
     A grant return quoting the spreadsheet and a board paper quoting the PDF
     must never give different numbers for the same clinic, so the thing worth
     testing is that the three agree — not that each one runs. */
  {
    currentUser = signInAdmin();
    const rex = require('../src/main/reportExport.js');
    const mkP = (i) => db.createPatient(currentUser, {
      first_name: 'Rep' + i, last_name: 'Ort', dob: '1985-03-02', gender: i % 2 ? 'male' : 'female',
      language: i % 3 ? 'en' : 'es',
      demographics: { city: i % 2 ? 'Sandy' : 'Boring', state: 'OR', race: [i % 2 ? 'white' : 'hispanic_latino'], preregistered: i % 2 === 0 },
      medical_history: { conditions: i % 2 ? ['diabetes'] : ['high_bp'] },
      dental_history: { visit_type: 'cleaning' },
    });
    for (let i = 1; i <= 6; i++) mkP(i);
    const sum = db.buildEventSummary();
    const labels = { conditions: { diabetes: 'Diabetes', high_bp: 'High blood pressure' } };
    const secs = rex.reportSections(sum, 'This clinic', labels);
    const byTitle = Object.fromEntries(secs.map((x) => [x.title, x]));

    // Everything the report was asked to include.
    for (const t of ['Patient counts', 'How patients registered', 'Gender', 'Age band',
                     'Race and ethnicity', 'Language', 'City', 'Most common conditions']) {
      log(!!byTitle[t], `report: includes "${t}"`);
    }
    // Relative, not absolute: this database already holds every patient the
    // earlier checks created, so what matters is that the report agrees with the
    // summary rather than hitting a number this block happens to know.
    const seenCount = byTitle['Patient counts'].rows.find((r) => r[0] === 'Patients seen')[1];
    log(seenCount === sum.patients_seen && seenCount >= 6,
      `report: the patient count matches the clinic summary (${seenCount})`);
    // Pre-registered vs registered at the desk, which is the split the online
    // form exists to be judged on.
    const reg = byTitle['How patients registered'].rows;
    log(reg.length === 2 && reg[0][0] === 'Pre-registered online' && reg[1][0] === 'Registered at the clinic',
      'report: separates patients who pre-registered from those who registered at the desk');
    log(reg[0][1] + reg[1][1] === seenCount,
      'report: every patient falls into one registration route or the other, with none lost between them');
    log(byTitle.City.rows.some((r) => /Sandy/.test(r[0])), 'report: city breakdown carries real places');
    log(byTitle.Language.rows.some((r) => r[0] === 'English'),
      'report: language is shown by name, not by its code');
    log(byTitle['Most common conditions'].rows.some((r) => r[0] === 'High blood pressure'),
      'report: conditions are shown by name — a funder never sees "high_bp"');
    log(byTitle['Race and ethnicity'].note && /more than 100%/.test(byTitle['Race and ethnicity'].note),
      'report: the race table says why its shares can exceed 100%');

    // The three formats, from the same sections.
    const csv = rex.reportCsv(sum, 'This clinic', labels);
    const xlsxBuf = rex.reportWorkbook(sum, 'This clinic', labels);
    const html = rex.reportHtml(sum, 'This clinic', labels);
    log(typeof csv === 'string' && csv.length > 200, 'report: CSV is produced');
    log(csv.charCodeAt(0) === 0xFEFF, 'report: the CSV carries a BOM so Excel reads accents rather than mojibake');
    log(/\r\n/.test(csv), 'report: the CSV uses CRLF line endings');
    log(Buffer.isBuffer(xlsxBuf) && xlsxBuf.slice(0, 2).toString() === 'PK',
      'report: the Excel workbook is a real .xlsx file');
    log(/<table>/.test(html) && /Mission Minded Worldwide/.test(html), 'report: the printable PDF body is produced');

    // The agreement that actually matters: one number, three files.
    log(csv.includes(`Patients seen,${seenCount}`), 'report: the CSV carries the same patient count as the sections');
    log(html.includes(`<td class="num">${seenCount}</td>`), 'report: the PDF carries the same patient count');
    for (const t of Object.keys(byTitle)) {
      // Every section title appears in every format, so none can silently drop one.
      if (!csv.includes(t) || !html.includes(t)) { log(false, `report: "${t}" is missing from CSV or PDF`); }
    }
    log(secs.every((x) => csv.includes(x.title) && html.includes(x.title)),
      'report: every section appears in all three formats');

    // Built from the de-identified summary, so no patient name can reach a file
    // that gets emailed to a funder.
    log(!/Rep1|Ort/.test(csv) && !/Rep1|Ort/.test(html),
      'report: no patient name appears in an exported report');
    log(rex.reportSections({}, 'Empty').length > 0,
      'report: a clinic with no patients still produces a report rather than failing');
  }

  /* ===== Vitals review, the patient's record through the flow, the lock =====
     v0.0.15. The Vitals station stops asking its four yes/no questions and
     instead reviews and edits the whole medical history with the check-in
     form itself; every station shows the patient's record and lets each role
     correct its own part of it, merged into what is stored, checked by the
     check-in rules and refused once the record is signed off and locked;
     and an administrator unlocks (with a reason) and locks records on purpose.
     Every permission is proved both ways through the permission-enforcing api
     mock, whose table is itself pinned to ipc.js entry for entry. */
  {
    currentUser = signInAdmin();
    const prevEvC = Number(db.getSetting('active_event_id'));
    const evC = db.createEvent(currentUser, { name: 'Flow Clinic', location: 'Sandy', cities: ['Sandy', 'Gresham'] });
    db.setActiveEvent(currentUser, evC.id);
    const i18nC = await import('../src/renderer/js/i18n.js');
    i18nC.setLang('en');
    const storeC = (await import('../src/renderer/js/store.js')).store;
    const PH = await import('../src/renderer/js/components/patientHistory.js');
    const MHr = await import('../src/renderer/js/medicalHistory.js');
    const IS = await import('../src/renderer/js/components/intakeSections.js');
    const stC = await import('../src/renderer/i18n/strings.js');
    const MLm = require('../src/main/medicalLabels.js');
    const pdfC = require('../src/main/pdf.js');
    const { clinicSheets: sheetsC } = require('../src/main/clinicSheets.js');
    const readSrcC = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    const plainC = (html) => html.replace(/<style>[\s\S]*?<\/style>/, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    const settle = async (n = 12) => { for (let i = 0; i < n; i++) await tick(); };
    const ctxC = { navigate: () => {}, toast: () => {}, store: storeC, setDetail: () => {} };
    const viewC = async (file, fn, params = {}) => {
      const mod = await import('../src/renderer/js/views/' + file);
      const node = mod[fn](ctxC, params); document.body.append(node); await settle(); return node;
    };
    const closeOverlays = () => $all('.modal-overlay').forEach((o) => o.remove());
    const lastToastC = () => { const all = $all('#toast-host .toast'); return all.length ? all[all.length - 1].textContent : ''; };
    const btnIn = (root, re) => $all('button', root).find((b) => re.test(b.textContent.trim()));
    const cardOf = (root, section) => root && root.querySelector(`.card[data-section="${section}"]`);

    // One account per staff role, signed in through the api mock (which
    // enforces the permission table) and set on the store the screens read.
    const ROLES7 = ['admin', 'registration', 'emt', 'triage', 'doctor', 'hygienist', 'checkout'];
    for (const r of ROLES7.slice(1)) db.createUser(currentUser, { username: 'c_' + r, full_name: 'C ' + r, role: r, password: 'x' });
    const as = async (role) => {
      const r = role === 'admin'
        ? await window.api.authLogin({ username: 'admin', password: 'admin' })
        : await window.api.authLogin({ username: 'c_' + role, password: 'x' });
      if (!r.ok) throw new Error('sign-in failed for ' + role);
      storeC.setUser(currentUser);
      return currentUser;
    };

    // A complete history on Dr. Trinh's form, and the rest of a complete intake.
    const NO25 = Object.fromEntries(MHr.INTAKE_CONDITIONS.map((k) => [k, 'no']));
    const V2 = (x = {}) => MHr.normalizeMedical({
      under_treatment: 'no', condition_answers: { ...NO25, ...(x.answers || {}) },
      medications: x.medications || [], medications_none: x.medications ? undefined : true,
      major_surgery: 'no', surgery_sites: [], tobacco: 'no',
      allergy_status: x.allergy_status || 'nkda', allergies: x.allergies || [], ...(x.rest || {}),
    });
    const DENT = (x = {}) => ({
      prior_dentist: 'about_1_year', pain_cold: 'no', pain_hot: 'no', pain_eating: 'no', toothache_night: 'no',
      pain_touch: 'no', grinding_night: 'no', jaw_pain_waking: 'no', sores: 'no', visit_type: 'filling', may_need_extraction: 'no', ...x,
    });
    const DEMO = (x = {}) => ({ city: 'Sandy', state: 'OR', emergency_name: 'Em Contact', emergency_phone: '5035550100', services: ['dental'], ...x });
    const GENC = [{ type: 'general', signer_name: 'Flow', signature_png: 'data:image/png;base64,AAAA' }];
    const mkC = (first, last, { medical = V2(), dental = DENT(), demographics = DEMO(), vitals = false, route = null } = {}) => {
      const a = signInAdmin();
      const p = db.createPatient(a, {
        first_name: first, last_name: last, dob: '1980-02-02', gender: 'female', phone: '5035550199',
        demographics, medical_history: medical, dental_history: dental, consents: GENC,
      });
      if (vitals || route) db.saveVitals(a, p.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '72', glucose: '110', respiration: '18' });
      if (route) db.routePatient(a, p.id, route);
      return db.getPatient(p.id);
    };
    const upd = (id, section, values, opts = {}) => window.api.patientsUpdateSection({ id, section, values, ...opts });

    /* ---- the permission matrix, wherever it is written ---- */
    const ipcSrc = readSrcC('../src/main/ipc.js');
    const camel = (ch) => ch.replace(/[:](\w)/g, (_, c) => c.toUpperCase());
    const permBlock = ipcSrc.slice(ipcSrc.indexOf('const PERMS = {'), ipcSrc.indexOf('};', ipcSrc.indexOf('const PERMS = {')));
    const ipcPerms = {};
    for (const m of permBlock.matchAll(/'([a-zA-Z]+:[a-zA-Z]+)':\s*\[([^\]]*)\]/g)) {
      ipcPerms[camel(m[1])] = m[2].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean).sort();
    }
    const permDrift = [...new Set([...Object.keys(ipcPerms), ...Object.keys(PERMS)])]
      .filter((k) => JSON.stringify(ipcPerms[k] || null) !== JSON.stringify(PERMS[k] ? [...PERMS[k]].sort() : null));
    log(Object.keys(ipcPerms).length >= 80 && !permDrift.length,
      `perms: the harness permission table IS ipc.js PERMS, entry for entry (${permDrift.length ? 'drift: ' + permDrift.join(', ') : Object.keys(ipcPerms).length + ' channels'})`);
    const preSrc = readSrcC('../src/main/preload.js');
    const chanBlock = preSrc.slice(preSrc.indexOf('const CHANNELS = ['), preSrc.indexOf('];', preSrc.indexOf('const CHANNELS = [')));
    const channels = new Set([...chanBlock.matchAll(/'([a-zA-Z]+:[a-zA-Z]+)'/g)].map((m) => m[1]));
    const handled = [...ipcSrc.matchAll(/(?:\bhandle|ipcMain\.handle)\('([a-zA-Z]+:[a-zA-Z]+)'/g)].map((m) => m[1]);
    const permChannels = [...permBlock.matchAll(/'([a-zA-Z]+:[a-zA-Z]+)':/g)].map((m) => m[1]);
    const unreachable = [...new Set([...handled, ...permChannels])].filter((c) => !channels.has(c));
    log(['patients:updateSection', 'treatment:unlock', 'treatment:lock'].every((c) => channels.has(c) && handled.includes(c)) && !unreachable.length,
      `perms: every channel ipc.js answers is whitelisted in preload.js, the three new ones included${unreachable.length ? ' (missing: ' + unreachable.join(', ') + ')' : ''}`);
    const apiSrc = readSrcC('../src/renderer/js/api.js');
    const methodNames = new Set([...channels].map(camel));
    const orphanCalls = [...apiSrc.matchAll(/call\('([a-zA-Z]+)'/g)].map((m) => m[1]).filter((n) => !methodNames.has(n));
    log(!orphanCalls.length && /call\('patientsUpdateSection'/.test(apiSrc) && /call\('treatmentUnlock'/.test(apiSrc) && /call\('treatmentLock'/.test(apiSrc),
      `perms: every api.js call names a preload channel (a missing one is undefined in Electron and invisible here)${orphanCalls.length ? ' — orphans: ' + orphanCalls.join(', ') : ''}`);
    log(JSON.stringify(db.SECTION_ROLES) === JSON.stringify(PH.SECTION_ROLES) && /db\.SECTION_ROLES\[section\]/.test(ipcSrc),
      'perms: who may edit which section is one table — the data layer\'s, used by ipc.js and mirrored exactly by the screens');
    const allSectionRoles = [...new Set(Object.values(db.SECTION_ROLES).flat())].sort();
    log(JSON.stringify(allSectionRoles) === JSON.stringify(ipcPerms.patientsUpdateSection),
      'perms: the section channel is open to exactly the roles some section allows');
    const appSrc = readSrcC('../src/renderer/js/app.js');
    const emtRoles = (/emt: \{ render: renderEmt, roles: \[([^\]]*)\]/.exec(appSrc) || [])[1] || '';
    log(emtRoles && emtRoles.split(',').map((x) => x.trim().replace(/'/g, '')).every((r) => db.SECTION_ROLES.medical_history.includes(r)),
      'perms: every role that can open Vitals may edit the medical history there (no Edit offered that the save refuses)');

    /* ---- one normalizer, two copies ---- */
    const FIX = [
      {},
      { conditions: ['diabetes', 'none'], allergies: ['penicillin'], allergies_other: ' Sulfa ', medications: [{ name: 'Metformin', dose: '500 mg', reason: 'sugar' }], pregnancy: 'no' },
      V2({ answers: { diabetes: 'yes', bleeding: 'unsure', pregnant: 'na' }, allergy_status: 'yes', allergies: ['penicillin', 'other'], rest: { allergies_other: 'Latex' } }),
      { ...V2(), medications_none: true, medications: [{ key: 'warfarin', name: 'Warfarin (Coumadin)' }], major_surgery: 'yes', surgery_sites: ['knee', 'knee', ''] },
      { condition_answers: { diabetes: 'yes' }, allergy_status: 'unsure', allergies: ['penicillin'], medications: ['Aspirin', { key: 'aspirin', name: 'Aspirin' }, { key: 'aspirin', name: 'Aspirin' }], conditions_other: '  Gout ' },
    ];
    log(FIX.every((f) => JSON.stringify(MHr.normalizeMedical(f)) === JSON.stringify(MLm.normalizeMedical(f))),
      'medical: the data layer derives a history exactly as the form does (normalizeMedical, both copies, old and new records)');
    const EN = stC.CATALOG.en.intake;
    const QMAP = { under_treatment: 'underTreatment', medications: 'medsTitle', medications_other: 'medOther', major_surgery: 'majorSurgery', surgery_sites: 'surgerySites', tobacco: 'tobacco', allergy_status: 'allergyQuestion', allergies: 'allergiesTitle', allergies_other: 'allergyOther' };
    log(Object.entries(QMAP).every(([id, key]) => MLm.MEDICAL_QUESTION_LABELS[id] === EN[key]) && Object.keys(MLm.MEDICAL_QUESTION_LABELS).length === Object.keys(QMAP).length,
      'medical: a refusal from the data layer names the question in the form\'s own words');

    /* ---- each role, each section: allowed AND refused, through the api ---- */
    const permP = mkC('Perm', 'Matrix');
    const medRoles = ['admin', 'emt', 'triage', 'doctor', 'hygienist'];
    for (let i = 0; i < ROLES7.length; i++) {
      const r = ROLES7[i];
      await as(r);
      const dm = await upd(permP.id, 'demographics', { phone: '50355501' + String(i).padStart(2, '0') });
      const md = await upd(permP.id, 'medical_history', { tobacco: i % 2 ? 'yes' : 'no' });
      const dd = await upd(permP.id, 'dental_history', { pain_cold: i % 2 ? 'yes' : 'no' });
      const may = medRoles.includes(r);
      const okRole = dm.ok && dm.data.phone === '50355501' + String(i).padStart(2, '0')
        && (may ? md.ok && dd.ok : (!md.ok && /permission/i.test(md.error) && !dd.ok && /permission/i.test(dd.error)));
      log(okRole, `perms: ${r} ${may ? 'may correct the patient\'s details, medical and dental history' : 'may correct the patient\'s details and is refused the medical and dental history'}`);
    }
    await as('emt');
    let prC = await upd(permP.id, 'medical_history', {}, { reviewedOnly: true });
    const emtReview = prC.ok && prC.data.triage.history_reviewed_by_name === 'C emt';
    await as('checkout');
    prC = await upd(permP.id, 'medical_history', {}, { reviewedOnly: true });
    await as('registration');
    const regReview = await upd(permP.id, 'medical_history', {}, { reviewedOnly: true });
    log(emtReview && !prC.ok && /permission/i.test(prC.error) && !regReview.ok,
      'perms: the EMT can mark the history reviewed; check-out and the front desk cannot');
    const regGet = await window.api.patientsGet(permP.id);
    log(regGet.ok && regGet.data.id === permP.id, 'perms: the front desk can now open a patient\'s record (patients:get) to view it at Arrivals');
    const lockRefused = [];
    for (const r of ROLES7.slice(1)) {
      await as(r);
      const u = await window.api.treatmentUnlock({ patientId: permP.id, reason: 'x' });
      const l = await window.api.treatmentLock({ patientId: permP.id });
      if (!u.ok && /permission/i.test(u.error) && !l.ok && /permission/i.test(l.error)) lockRefused.push(r);
    }
    log(lockRefused.length === 6, `perms: unlocking and locking are refused to ${lockRefused.join(', ')}`);
    const pdfOk = {};
    for (const r of ['emt', 'triage', 'checkout', 'doctor']) { await as(r); pdfOk[r] = (await window.api.pdfGenerate({ patientId: permP.id, format: 'summary' })).ok; }
    log(!pdfOk.emt && !pdfOk.triage && pdfOk.checkout && pdfOk.doctor,
      'perms: the PDF channels are gated in the mock as in ipc.js — Vitals roles are refused, check-out and the dentist are not');

    /* ---- merged, never replaced ---- */
    const oldMed = V2({ rest: { hospitalized: 'yes', bp_systolic: 150, bp_diastolic: 95, heart_rate: 80, future_key: 'from a newer build' } });
    const mp = mkC('Merge', 'Keeper', {
      medical: oldMed,
      dental: DENT({ gum_bleeding: 'yes', reason: 'Old prose reason' }),
      demographics: DEMO({ preregistered: true, prereg_at: '2026-10-01T08:00:00.000Z', mailing_address: 'PO Box 1', future_demo: 'kept' }),
    });
    await as('emt');
    const warf = { key: 'warfarin', name: 'Warfarin (Coumadin)', dose: '', reason: '' };
    prC = await upd(mp.id, 'medical_history', { allergy_status: 'yes', allergies: ['penicillin'], medications: [warf], medications_none: null });
    const mpA = db.getPatient(mp.id);
    const mh = mpA.medical_history;
    log(prC.ok && mh.hospitalized === 'yes' && mh.bp_systolic === 150 && mh.future_key === 'from a newer build',
      'edit: a medical edit keeps what the form never asked — the retired answer, the old self-reported vitals, a newer build\'s key');
    log(JSON.stringify(mh.allergies) === '["penicillin"]' && mh.allergies_none === undefined && mh.medications.length === 1
      && mh.medications[0].name === 'Warfarin (Coumadin)' && mh.medications_none === undefined && mh.history_version === 2,
      'edit: the changed answers land, and a removed "No medications" flag is really removed (null deletes)');
    log(JSON.stringify(mpA.dental_history) === JSON.stringify(mp.dental_history) && JSON.stringify(mpA.demographics) === JSON.stringify(mp.demographics),
      'edit: a medical edit touches nothing but the medical history');
    log(mpA.lock.locked === false && mpA.triage.history_reviewed_by_name === 'C emt' && !!mpA.triage.history_reviewed_at,
      'edit: saving the history stamps who reviewed it at this visit');
    log(mpA.triage.flags.includes('Allergy: Penicillin'),
      'edit: the dentist\'s flags follow the edited history at once, before the chart is opened');
    const auditMp = db.patientAudit(mp.id);
    const histEdit = auditMp.find((a) => a.action === 'history_edit');
    log(!!histEdit && /^medical_history: /.test(histEdit.detail) && /allergies/.test(histEdit.detail) && /medications/.test(histEdit.detail)
      && !/Warfarin|Penicillin|penicillin/.test(histEdit.detail) && histEdit.user_name === 'C emt',
      'edit: audited as "history_edit" with the names of what changed — never the values, which are health information');
    const syncTri = db.collectSyncRows(5000).rows.find((r) => r.entity === 'triage' && r.data && r.data.history_reviewed_by_name === 'C emt' && JSON.parse(r.data.flags || '[]').includes('Allergy: Penicillin'));
    log(!!syncTri, 'edit: the review stamp (and the refreshed flags) travel to every station in the triage row');
    const listedMp = db.listPatients({}).find((x) => x.id === mp.id);
    log(listedMp.on_thinner === true, 'edit: Warfarin added at Vitals makes the queues show the patient as on a blood thinner');

    await as('registration');
    prC = await upd(mp.id, 'demographics', { phone: '5035550777', demographics: { mailing_address: null, city: '  Gresham ' } });
    const mpD = db.getPatient(mp.id);
    log(prC.ok && mpD.phone === '5035550777' && mpD.demographics.city === 'Gresham' && mpD.demographics.mailing_address === undefined
      && mpD.demographics.preregistered === true && mpD.demographics.prereg_at === '2026-10-01T08:00:00.000Z' && mpD.demographics.future_demo === 'kept',
      'edit: a details edit keeps the online form\'s preregistered stamp and unknown keys, and removes a key sent as null');
    const demoAudit = db.patientAudit(mp.id).find((a) => a.action === 'patient_edit');
    log(!!demoAudit && /phone/.test(demoAudit.detail) && /demographics\.city/.test(demoAudit.detail) && !/5035550777|Gresham/.test(demoAudit.detail),
      'edit: a details edit is audited as "patient_edit", by field name only');
    await as('hygienist');
    prC = await upd(mp.id, 'dental_history', { pain_cold: 'yes' });
    const mpT = db.getPatient(mp.id);
    log(prC.ok && mpT.dental_history.pain_cold === 'yes' && mpT.dental_history.gum_bleeding === 'yes' && mpT.dental_history.reason === 'Old prose reason',
      'edit: a dental edit keeps the earlier form\'s answers and the old free-text reason');

    /* ---- the check-in rules, applied to a station's save ---- */
    await as('doctor');
    const refused = async (section, values, re) => { const r = await upd(mp.id, section, values); return !r.ok && re.test(r.error); };
    log(await refused('medical_history', { under_treatment: null }, /^Required: Are you currently under a doctor’s care\?$/),
      'rules: a history saved with a question blanked is refused, naming the question');
    log(await refused('medical_history', { condition_answers: { ...NO25, stroke: '' } }, /^Required: Stroke \/ TIA$/),
      'rules: a condition left unanswered is refused by its own name');
    const inconsistent = await upd(mp.id, 'medical_history', { condition_answers: { ...NO25, diabetes: 'yes' }, conditions: [] });
    log(inconsistent.ok && db.getPatient(mp.id).medical_history.conditions.includes('diabetes'),
      'rules: the derived condition list is re-derived from the answers, whatever a caller sent');
    log(await refused('dental_history', { pain_cold: null }, /^Required: Pain with cold water$/)
      && await refused('dental_history', { pain_cold: 'maybe' }, /Yes or No/)
      && await refused('dental_history', { visit_type: 'surgery' }, /What do you need today/),
      'rules: the dental history keeps check-in\'s rules — all eight questions, Yes or No, a known visit type');
    log(await refused('demographics', { phone: '' }, /^Required: Phone number$/)
      && await refused('demographics', { demographics: { emergency_name: null } }, /^Required: Emergency contact name$/)
      && await refused('demographics', { demographics: { services: [] } }, /at least one service/)
      && await refused('demographics', { dob: '02/02/1980' }, /must be a date/)
      && await refused('demographics', { nickname: 'Mo' }, /Unknown field/)
      && await refused('demographics', { demographics: { services: 'dental' } }, /Invalid value/)
      && await refused('medical_history', { tobacco: { a: { b: { c: { d: 1 } } } } }, /Invalid value/),
      'rules: required details cannot be blanked, and a malformed or unknown field is refused rather than stored for every station');
    const legacyP = mkC('Legacy', 'Checklist', { medical: { conditions: ['diabetes'], allergies: ['penicillin'], medications: [{ name: 'Metformin', dose: '500 mg', reason: '' }] } });
    await as('emt');
    const legacyEdit = await upd(legacyP.id, 'medical_history', { tobacco: 'no' });
    const legacyReview = await upd(legacyP.id, 'medical_history', {}, { reviewedOnly: true });
    log(!legacyEdit.ok && /^Required: /.test(legacyEdit.error) && !legacyReview.ok && /^Required: .*Edit/.test(legacyReview.error)
      && !db.getPatient(legacyP.id).triage.history_reviewed_at,
      'rules: an older checklist record is completed with the patient before it is saved or marked reviewed — not ticked past');
    const beforeRv = JSON.stringify(db.getPatient(permP.id).medical_history);
    await as('triage');
    prC = await upd(permP.id, 'medical_history', {}, { reviewedOnly: true });
    log(prC.ok && JSON.stringify(prC.data.medical_history) === beforeRv && prC.data.triage.history_reviewed_by_name === 'C triage'
      && db.patientAudit(permP.id)[0].action === 'history_review',
      'rules: "Reviewed with patient — no changes" stamps the review and changes nothing in the history');

    /* ---- what the visit type decides ---- */
    const vtP = mkC('Visit', 'Type', { dental: DENT({ visit_type: 'filling' }) });
    await as('registration');
    const vtNo = await upd(vtP.id, 'dental_history', { visit_type: 'cleaning' });
    await as('emt');
    prC = await upd(vtP.id, 'dental_history', { visit_type: 'cleaning' });
    let vt = db.getPatient(vtP.id);
    log(!vtNo.ok && prC.ok && vt.triage.route === 'hygienist' && vt.triage.complaint === 'Cleaning' && vt.dental_history.may_need_extraction === 'no',
      'visit type: changed at Vitals, it re-routes the patient and replaces the automatic complaint');
    prC = await upd(vtP.id, 'dental_history', { visit_type: 'extraction_pain', may_need_extraction: 'no' });
    vt = db.getPatient(vtP.id);
    log(vt.dental_history.may_need_extraction === 'yes' && vt.triage.route === 'dentist' && db.arrivalReadiness(vtP.id).needs_surgery_consent,
      'visit type: an extraction makes the surgery consent needed, whatever the screen said');
    db.saveTriage(signInAdmin(), vtP.id, { complaint: 'Swollen jaw', status: 'waiting' });
    await as('emt');
    await upd(vtP.id, 'dental_history', { visit_type: 'filling' });
    log(db.getPatient(vtP.id).triage.complaint === 'Swollen jaw', 'visit type: a complaint someone typed is never replaced');
    db.saveVitals(signInAdmin(), vtP.id, { bp_systolic: '120', bp_diastolic: '80', heart_rate: '70' });
    db.routePatient(signInAdmin(), vtP.id, 'dentist');
    await as('emt');
    await upd(vtP.id, 'dental_history', { visit_type: 'cleaning' });
    log(db.getPatient(vtP.id).triage.route === 'dentist',
      'visit type: once the EMT has sent the patient on, an edit does not undo where they were sent');

    /* ---- the lock, enforced where the data is written ---- */
    const lkP = mkC('Lou', 'Locked', { route: 'dentist' });
    const a0 = signInAdmin();
    const xr = db.addXray(a0, lkP.id, { image_png: 'data:image/png;base64,AAAA', note: 'bw' });
    db.addPatientConsent(a0, lkP.id, { type: 'oral_surgery', signer_name: 'Lou', signature_png: 'data:,s' });
    const osId = db.getPatient(lkP.id).consents.find((c) => c.type === 'oral_surgery').id;
    db.saveTreatment(a0, lkP.id, { fillings: [{ tooth: '3', surfaces: ['O'] }], provider_name: 'Dr Lock', provider_signature: 'data:,sig' }, 'lock');
    let lk = db.getPatient(lkP.id);
    log(lk.treatment.locked && lk.lock.locked_by_name === 'Administrator' && !!lk.treatment.locked_at
      && lk.lock.history.length === 1 && lk.lock.history[0].action === 'lock',
      'lock: signing off and locking stamps who locked it and when, and starts the lock trail');
    const syncTx = db.collectSyncRows(5000).rows.find((r) => r.entity === 'treatment' && r.data && r.data.locked_by_name === 'Administrator' && r.data.locked_at === lk.treatment.locked_at);
    log(!!syncTx && JSON.parse(syncTx.data.lock_history).length === 1, 'lock: the lock stamp and trail travel to every station in the treatment row');
    await as('emt');
    const gV = await window.api.vitalsSave({ patientId: lkP.id, data: { bp_systolic: '150' } });
    const gR = await window.api.patientsRoute({ patientId: lkP.id, route: 'hygienist' });
    const gM = await upd(lkP.id, 'medical_history', { tobacco: 'yes' });
    const gD = await upd(lkP.id, 'dental_history', { pain_cold: 'yes' });
    const gX = await window.api.xrayAdd({ patientId: lkP.id, image_png: 'data:image/png;base64,BBBB' });
    await as('doctor');
    const gT = await window.api.triageSave({ patientId: lkP.id, data: { complaint: 'changed' } });
    const gC = await window.api.consentAdd({ patientId: lkP.id, consent: { type: 'general', signer_name: 'x', signature_png: 'data:,s' } });
    const gCT = await window.api.consentSetTeeth({ consentId: osId, tooth_numbers: '30' });
    const gXT = await window.api.xraySetTooth({ id: xr.id, tooth: '14' });
    const gXD = await window.api.xrayDelete(xr.id);
    const allRefused = [gV, gR, gM, gD, gX, gT, gC, gCT, gXT, gXD].every((r) => !r.ok && /locked/i.test(r.error));
    lk = db.getPatient(lkP.id);
    log(allRefused && lk.triage.bp_systolic === 120 && lk.triage.route === 'dentist' && lk.triage.complaint !== 'changed'
      && lk.xrays.length === 1 && lk.consents.length === 2 && lk.medical_history.tobacco === 'no',
      'lock: vitals, routing, triage, x-rays (add, tooth, delete), consents (add, teeth) and both histories are refused on a locked record — and nothing was written');
    await as('checkout');
    const gId = await upd(lkP.id, 'demographics', { first_name: 'Lucia' });
    const gPh = await upd(lkP.id, 'demographics', { phone: '5035550888' });
    const gSv = await window.api.surveySave({ patientId: lkP.id, data: { stage: 'exit', declined: true } });
    log(!gId.ok && /administrator/i.test(gId.error) && gPh.ok && gPh.data.phone === '5035550888' && gSv.ok,
      'lock: check-out can still fix a phone number and take the survey on a locked record, but not change who the patient is');
    const adm = await as('admin');
    const aV = await window.api.vitalsSave({ patientId: lkP.id, data: { bp_systolic: '124', bp_diastolic: '82', heart_rate: '70' } });
    const aN = await upd(lkP.id, 'demographics', { first_name: 'Lucia' });
    let aT = false; try { db.saveTreatment(adm, lkP.id, { provider_name: 'x' }, false); } catch (e) { aT = /locked/i.test(e.message); }
    log(aV.ok && aN.ok && aN.data.first_name === 'Lucia' && aT,
      'lock: an administrator may still correct vitals and identity, but even they cannot save treatment over a lock without unlocking');

    /* ---- unlock, amend, re-lock ---- */
    const noWhy = await window.api.treatmentUnlock({ patientId: lkP.id, reason: '   ' });
    log(!noWhy.ok && /why/i.test(noWhy.error) && db.getPatient(lkP.id).treatment.locked, 'unlock: a reason is required');
    const statusBefore = db.getPatient(lkP.id).status;
    const un = await window.api.treatmentUnlock({ patientId: lkP.id, reason: 'Wrong tooth recorded' });
    lk = db.getPatient(lkP.id);
    log(un.ok && !lk.treatment.locked && lk.status === statusBefore && lk.status === 'completed' && lk.lock.unlock_reason === 'Wrong tooth recorded'
      && lk.lock.unlocked_by_name === 'Administrator' && lk.lock.amending && lk.lock.history.map((h) => h.action).join(',') === 'lock,unlock',
      'unlock: status-neutral (the patient stays in the check-out queue), with who, when and why kept on the record');
    log(db.patientAudit(lkP.id).some((a) => a.action === 'unlock' && a.detail === 'Wrong tooth recorded'), 'unlock: audited with its reason');
    const again = await window.api.treatmentUnlock({ patientId: lkP.id, reason: 'x' });
    log(!again.ok && /not locked/i.test(again.error), 'unlock: an unlocked record cannot be unlocked again');
    const row = db.listPatients({}).find((x) => x.id === lkP.id);
    log(row.locked === false && row.amending === true, 'unlock: the patient list says the record is being amended');
    await as('doctor');
    const completedAt = lk.treatment.completed_at;
    prC = await window.api.treatmentSave({ patientId: lkP.id, data: { fillings: [{ tooth: '4', surfaces: ['O'] }], provider_name: 'Dr Lock' }, finalize: false });
    lk = db.getPatient(lkP.id);
    log(prC.ok && lk.status === 'completed' && lk.treatment.completed_at === completedAt && lk.treatment.fillings[0].tooth === '4'
      && db.patientAudit(lkP.id).some((a) => a.action === 'amend'),
      'amend: saving the correction keeps the patient where they are and keeps who completed the visit and when');
    prC = await window.api.treatmentSave({ patientId: lkP.id, data: { ...lk.treatment, provider_name: 'Dr Lock' }, finalize: 'lock' });
    lk = db.getPatient(lkP.id);
    log(prC.ok && lk.treatment.locked && lk.lock.locked_by_name === 'C doctor' && lk.lock.history.map((h) => h.action).join(',') === 'lock,unlock,relock',
      'amend: re-signing locks it again, as a re-lock by the dentist who re-signed');
    // A checked-out patient's record, amended.
    const outL = mkC('Otto', 'Leftalready', { route: 'dentist' });
    db.saveTreatment(signInAdmin(), outL.id, { provider_name: 'Dr O', provider_signature: 'data:,s' }, 'lock');
    db.dismissPatient(signInAdmin(), outL.id);
    await as('admin');
    await window.api.treatmentUnlock({ patientId: outL.id, reason: 'Add the note' });
    await as('doctor');
    await window.api.treatmentSave({ patientId: outL.id, data: { provider_name: 'Dr O', clinical_notes: 'Added later' }, finalize: false });
    await window.api.treatmentSave({ patientId: outL.id, data: { provider_name: 'Dr O', clinical_notes: 'Added later', provider_signature: 'data:,s' }, finalize: 'lock' });
    const ol = db.getPatient(outL.id);
    log(ol.status === 'dismissed' && !!ol.dismissed_at && ol.treatment.locked && ol.treatment.clinical_notes === 'Added later',
      'amend: a checked-out patient\'s record can be corrected and re-signed without pulling them back into the clinic');

    /* ---- lock a finished visit that was never locked ---- */
    const cmp = mkC('Cam', 'Complete', { route: 'dentist' });
    db.saveTreatment(signInAdmin(), cmp.id, { provider_name: 'Dr C' }, 'complete');
    await as('doctor');
    const docLock = await window.api.treatmentLock({ patientId: cmp.id });
    await as('admin');
    const admLock = await window.api.treatmentLock({ patientId: cmp.id });
    const twice = await window.api.treatmentLock({ patientId: cmp.id });
    const busy = mkC('Ivy', 'Inprogress', { route: 'dentist' });
    db.saveTreatment(signInAdmin(), busy.id, { provider_name: 'Dr C' }, false);
    const busyLock = await window.api.treatmentLock({ patientId: busy.id });
    let dbNonAdmin = false; try { db.lockRecord({ id: 1, role: 'doctor', full_name: 'D' }, cmp.id); } catch (e) { dbNonAdmin = /administrator/i.test(e.message); }
    log(!docLock.ok && admLock.ok && admLock.data.treatment.locked && admLock.data.lock.history[0].action === 'lock' && admLock.data.status === 'completed'
      && !twice.ok && /already/i.test(twice.error) && !busyLock.ok && /not finished/i.test(busyLock.error) && dbNonAdmin,
      'lock: an administrator locks a finished, never-locked visit; an unfinished or already-locked one is refused, and so is anyone else');

    /* ---- the admin moves unlock through the same door ---- */
    const mvP = mkC('Mo', 'Mover', { route: 'dentist' });
    db.saveTreatment(signInAdmin(), mvP.id, { provider_name: 'Dr M', provider_signature: 'data:,s' }, 'lock');
    db.adminMovePatient(signInAdmin(), mvP.id, 'reopen');
    const mv = db.getPatient(mvP.id);
    const lastH = mv.lock.history[mv.lock.history.length - 1];
    log(!mv.treatment.locked && mv.status === 'in_treatment' && lastH.action === 'unlock' && lastH.reason === 'Admin move: re-open'
      && mv.lock.unlock_reason === 'Admin move: re-open' && !mv.lock.amending,
      'lock: "Re-open" still re-opens, and now leaves an unlock in the trail saying so');
    db.saveTreatment(signInAdmin(), mvP.id, { provider_name: 'Dr M', provider_signature: 'data:,s' }, 'lock');
    db.adminMovePatient(signInAdmin(), mvP.id, 'checkin');
    const mv2 = db.getPatient(mvP.id);
    log(!mv2.treatment.locked && mv2.status === 'checked_in' && mv2.lock.history.slice(-1)[0].reason === 'Admin move: back to check-in',
      'lock: "back to check-in" is recorded as the unlock it has always silently been');

    /* ---- a record locked before v0.0.15 ---- */
    const oldL = mkC('Olga', 'Oldlock', { route: 'dentist' });
    db.saveTreatment(signInAdmin(), oldL.id, { provider_name: 'Dr Old', provider_signature: 'data:,s' }, 'lock');
    { const r = rawDb(); try { r.prepare("UPDATE treatments SET locked_at=NULL, locked_by_name=NULL, lock_history=NULL, completed_by_name='Dr Old Name' WHERE patient_id=?").run(oldL.id); } finally { r.close(); } }
    const ol0 = db.getPatient(oldL.id);
    log(ol0.lock.locked && ol0.lock.locked_at === ol0.treatment.completed_at && ol0.lock.locked_by_name === 'Dr Old Name' && Array.isArray(ol0.treatment.lock_history),
      'lock: a record locked before this release reads its completion as the sign-off that locked it — without being rewritten');
    const progOld = plainC(pdfC.buildHtml(ol0, 'progress'));
    log(/Signed off & locked .* by Dr Old Name/.test(progOld) && !/Amended after sign-off/.test(progOld),
      'lock: and prints as signed off and locked, by whom');

    /* ---- the USB file of a record since locked here ---- */
    const usbP = db.getPatient(cmp.id);
    await as('checkout');
    db.importPatientFromPortable(currentUser, { ...usbP, id: usbP.id, medical_history: V2({ answers: { hiv: 'yes' } }), treatment: { ...usbP.treatment, locked: false } });
    const usbAfter = db.getPatient(cmp.id);
    log(usbAfter.treatment.locked && usbAfter.medical_history.condition_answers.hiv === 'no'
      && db.patientAudit(cmp.id).some((a) => a.action === 'usb_import' && /skipped/.test(a.detail)),
      'lock: a patient\'s USB file cannot rewrite a record signed off here since it was written — skipped, and the log says so');
    // A locked file arriving on a laptop that has no copy keeps its own
    // sign-off — and a file from before the lock trail gets the one lock it
    // evidences, never a trail naming whoever ran the import.
    const src = db.getPatient(cmp.id);
    const nuNew = db.importPatientFromPortable(currentUser, { ...src, id: undefined, first_name: 'Porta', last_name: 'Newfile', dob: '1971-01-01' });
    const oldTx = { ...src.treatment, locked_at: undefined, locked_by_name: undefined, lock_history: undefined };
    const nuOld = db.importPatientFromPortable(currentUser, { ...src, lock: undefined, id: undefined, first_name: 'Porta', last_name: 'Oldfile', dob: '1972-01-01', completed_by_name: 'Dr File', treatment: oldTx });
    log(nuNew.treatment.locked && nuNew.lock.locked_by_name === 'Administrator' && JSON.stringify(nuNew.lock.history) === JSON.stringify(src.lock.history)
      && nuOld.treatment.locked && nuOld.lock.locked_by_name === 'Dr File' && nuOld.lock.history.length === 1 && nuOld.lock.history[0].by === 'Dr File',
      'lock: a locked USB file keeps who locked it; an older file without the trail is locked by its own sign-off, not by the importer');

    /* ---- routing names its router ---- */
    const rtP = mkC('Rita', 'Route', { vitals: true });
    await as('emt');
    await window.api.patientsRoute({ patientId: rtP.id, route: 'dentist' });
    await as('triage');
    await window.api.patientsRoute({ patientId: rtP.id, route: 'hygienist' });
    const rt = db.getPatient(rtP.id);
    const rtSync = db.collectSyncRows(5000).rows.find((r) => r.entity === 'triage' && r.data && r.data.route === 'hygienist' && r.data.routed_by_name === 'C triage');
    log(rt.routed_by_name === 'C triage' && !!rtSync, 'routing: a re-route names the person who re-routed, locally and on every station');

    /* ---- a returning patient's older history ---- */
    const retP = mkC('Rhea', 'Returning', { medical: { conditions: ['none'], conditions_none: true, pregnancy: 'no', allergies: ['none'], allergies_none: true, medications_none: true } });
    const nv = db.startVisitFromExisting(signInAdmin(), retP.id);
    const nvm = nv.medical_history;
    log(JSON.stringify(nvm.conditions) === '[]' && nvm.conditions_none === undefined && nvm.pregnancy === undefined && nvm.allergies_none === true
      && MHr.medicalDisplay(nvm).conditionsNone === false,
      'return visit: an older checklist\'s "None" (which covered pregnancy) is not carried as "None (reviewed)"');
    const retD = mkC('Dan', 'Returning', { medical: { conditions: ['diabetes'], pregnancy: 'yes' } });
    const nv2 = db.startVisitFromExisting(signInAdmin(), retD.id).medical_history;
    log(JSON.stringify(nv2.conditions) === '["diabetes"]' && nv2.pregnancy === undefined, 'return visit: a real condition carries over; pregnancy is asked again');

    /* ---- blood sugar and respiration, everywhere vitals are ---- */
    const gl = mkC('Gil', 'Glucose', { route: 'dentist' });
    const glSync = db.collectSyncRows(5000).rows.find((r) => r.entity === 'triage' && r.data && r.data.glucose === 110 && r.data.respiration === 18);
    log(!!glSync, 'vitals: blood sugar and respiration now sync like the other vitals');
    const bundleC = db.exportClinicBundle(evC.id);
    { const r = rawDb(); try { r.prepare('UPDATE triage SET glucose=NULL, respiration=NULL WHERE patient_id=?').run(gl.id); } finally { r.close(); } }
    db.importClinicBundle(signInAdmin(), bundleC);
    const glR = db.getPatient(gl.id).triage;
    log(glR.glucose === 110 && glR.respiration === 18, 'vitals: and a clinic backup restores them (it used to drop both)');
    const sumGl = plainC(pdfC.buildHtml(db.getPatient(gl.id), 'summary'));
    const progGl = plainC(pdfC.buildHtml(db.getPatient(gl.id), 'progress'));
    const sumNo = plainC(pdfC.buildHtml(db.getPatient(mp.id), 'summary'));
    log(/BS 110 mg\/dL · RESP 18\/min/.test(sumGl) && /BS 110 mg\/dL · RESP 18\/min/.test(progGl) && !/BS |RESP /.test(sumNo),
      'vitals: the summary and progress PDFs print them — and a visit without them prints as it always did');
    const shC = sheetsC(db.exportClinicBundle(evC.id));
    const pSheet = shC.find((s) => s.name === 'Patients');
    const glRow = pSheet.rows.find((r) => r[0] === 'Glucose');
    log(glRow[pSheet.columns.indexOf('Blood sugar (mg/dL)')] === 110 && glRow[pSheet.columns.indexOf('Respiration (/min)')] === 18,
      'vitals: the clinic spreadsheet carries them');
    await as('doctor');
    const provGl = await viewC('provider.js', 'renderProvider', { id: gl.id });
    const recGl = await viewC('records.js', 'renderRecords', { id: gl.id });
    log(/BS 110 mg\/dL/.test(provGl.textContent) && /RESP 18\/min/.test(provGl.textContent) && /BS 110 mg\/dL/.test(recGl.textContent),
      'vitals: the dentist\'s handoff strip and the Records card show them');

    /* ---- the outputs: review stamp, lock, amendments ---- */
    const sumMp = plainC(pdfC.buildHtml(db.getPatient(mp.id), 'summary'));
    const fullMp = plainC(pdfC.buildHtml(db.getPatient(mp.id), 'full'));
    // mp was last saved by the dentist (the rules checks above), who is then
    // the one who last went through it.
    log(/Health history reviewed with the patient by C doctor/.test(sumMp) && /Health history reviewed with the patient by C doctor/.test(fullMp)
      && !/Health history reviewed/.test(plainC(pdfC.buildHtml(db.getPatient(legacyP.id), 'summary'))),
      'outputs: the summary and full record print who reviewed the history — and nothing for a visit nobody reviewed');
    const progLk = plainC(pdfC.buildHtml(db.getPatient(lkP.id), 'progress'));
    const progCmpDone = plainC(pdfC.buildHtml(db.getPatient(busy.id), 'progress'));
    db.saveTreatment(signInAdmin(), busy.id, { provider_name: 'Dr C' }, 'complete');
    const progCompleted = plainC(pdfC.buildHtml(db.getPatient(busy.id), 'progress'));
    log(/Signed off & locked .* by C doctor/.test(progLk) && /Amended after sign-off — unlocked .* by Administrator: Wrong tooth recorded/.test(progLk)
      && /Not yet finalized/.test(progCmpDone) && /Completed .* \(not locked\)/.test(progCompleted) && !/Signed off/.test(progCompleted),
      'outputs: the sign-off block says locked (by whom), completed-not-locked, or not finalized — and every amendment after sign-off, with its reason');
    const txSheet = sheetsC(db.exportClinicBundle(evC.id)).find((s) => s.name === 'Treatment');
    const col = (n) => txSheet.columns.indexOf(n);
    const lkRow = txSheet.rows.find((r) => r[0] === 'Locked' && r[1] === 'Lucia');
    const oldRow = txSheet.rows.find((r) => r[0] === 'Oldlock');
    const busyRow = txSheet.rows.find((r) => r[0] === 'Inprogress');
    log(!!lkRow && lkRow[col('Record lock')] === 'Locked' && lkRow[col('Locked by')] === 'C doctor' && /Wrong tooth recorded/.test(lkRow[col('Amended after sign-off')])
      && oldRow[col('Record lock')] === 'Locked' && oldRow[col('Locked by')] === 'Dr Old Name' && busyRow[col('Record lock')] === '',
      'outputs: the spreadsheet says Locked, by whom (an older lock by its completion) and every amendment after sign-off');

    /* ---- the legacy EMT confirmations stay visible ---- */
    const emtOld = mkC('Edna', 'Earlier', { route: 'dentist' });
    db.saveVitals(signInAdmin(), emtOld.id, { emt_review: { pregnant: 'no', diabetic: 'yes' } });
    log(PH.emtConfirmationsText(db.getPatient(emtOld.id).triage) === 'Earlier EMT confirmations: Pregnant: No · Diabetic: Yes'
      && PH.emtConfirmationsText({ emt_review: {} }) === '',
      'EMT review: an older visit\'s four answers read back in words, and a visit without them says nothing');
    const sumEo = plainC(pdfC.buildHtml(db.getPatient(emtOld.id), 'summary'));
    log(/EMT review Pregnant: NO · Diabetic: YES/.test(sumEo), 'EMT review: the summary PDF still prints them for the visits that have them');

    /* ---- the Vitals screen ---- */
    closeOverlays();
    await as('emt');
    const vtl = mkC('Vera', 'Vitals', { medical: V2(), vitals: false });
    const emtV = await viewC('emt.js', 'renderEmt', { id: vtl.id });
    const panelV = emtV.querySelector('details.patient-info');
    const cards = $all('.card', emtV);
    const vitalsCard = cards.find((c) => /Blood sugar/.test(c.textContent) && c.querySelector('input'));
    const nextCard = cards.find((c) => /Next step/.test(c.textContent) && !c.closest('details'));
    const order = (a, b) => !!(a && b) && !!(a.compareDocumentPosition(b) & window.Node.DOCUMENT_POSITION_FOLLOWING);
    log(!/EMT review|Save review/.test(emtV.textContent) && !!panelV && panelV.hasAttribute('open') && order(vitalsCard, panelV) && order(panelV, nextCard),
      'Vitals: the EMT review card is gone; the health history sits in its place, after vitals and before Next step, open');
    log(/Not yet reviewed at this visit/.test(panelV.textContent) && !!btnIn(panelV, /^Reviewed with patient — no changes$/)
      && !!cardOf(panelV, 'medical_history').querySelector('.card-edit'),
      'Vitals: it says the history has not been reviewed at this visit, and offers the review and Edit');
    btnIn(panelV, /^Reviewed with patient — no changes$/).click(); await settle();
    log(db.getPatient(vtl.id).triage.history_reviewed_by_name === 'C emt' && /Reviewed by C emt/.test(emtV.querySelector('details.patient-info').textContent),
      'Vitals: "Reviewed with patient — no changes" stamps the review, and the screen says who');
    const sysIn = $all('input', vitalsCard)[0];
    setInput(sysIn, '150');
    cardOf(emtV.querySelector('details.patient-info'), 'medical_history').querySelector('.card-edit').click(); await settle();
    const ed = $all('.section-editor').pop();
    log(!!ed && ed.parentElement === document.body && ed.dataset.section === 'medical_history' && $all('.tri-row', ed).length === 25
      && $all('.tri-row', ed).map((r) => r.dataset.key).join(',') === MHr.INTAKE_CONDITIONS.join(','),
      'Vitals: Edit opens the check-in form itself — the same 25 questions in the same order — over the page, not inside it');
    ed.querySelector('.chip-select[data-key="warfarin"]').click();
    btnIn(ed, /^Save$/).click(); await settle();
    log(!document.body.contains(ed) && db.getPatient(vtl.id).medical_history.medications.some((x) => x.key === 'warfarin')
      && /BLOOD THINNER — Warfarin/.test(emtV.textContent) && sysIn.isConnected && sysIn.value === '150',
      'Vitals: adding Warfarin turns on the blood-thinner banner at once — and the blood pressure typed but not yet saved is still there');
    const emtLegacy = await viewC('emt.js', 'renderEmt', { id: legacyP.id });
    const pl = emtLegacy.querySelector('details.patient-info');
    log(!btnIn(pl, /^Reviewed with patient/) && /Some questions have not been answered at this visit/.test(pl.textContent),
      'Vitals: an older record is gone through with Edit, not ticked as reviewed');
    cardOf(pl, 'medical_history').querySelector('.card-edit').click(); await settle();
    const edL = $all('.section-editor').pop();
    btnIn(edL, /^Save$/).click(); await settle();
    log(document.body.contains(edL) && /^Required: /.test(lastToastC()),
      'Vitals: a refused save leaves the form open with what was typed, and names the question it needs');
    btnIn(edL, /^Cancel$/).click(); await settle();
    log(!document.body.contains(edL), 'Vitals: Cancel on an untouched form closes it');
    const emtEo = await viewC('emt.js', 'renderEmt', { id: emtOld.id });
    log(/Earlier EMT confirmations: Pregnant: No · Diabetic: Yes/.test(emtEo.textContent),
      'Vitals: an older visit\'s EMT confirmations are shown with its history');
    const emtLk = await viewC('emt.js', 'renderEmt', { id: lkP.id });
    log(!btnIn(emtLk, /^Save vitals$/) && $all('.vitals-grid input', emtLk).every((i) => i.disabled) && /Locked by C doctor/.test(emtLk.textContent)
      && !cardOf(emtLk, 'medical_history').querySelector('.card-edit') && /Signed off and locked — an administrator can unlock it/.test(cardOf(emtLk, 'medical_history').textContent)
      && !!cardOf(emtLk, 'demographics').querySelector('.card-edit') && !btnIn(emtLk, /Sign off & send|Transfer to/) && !btnIn(emtLk, /Unlock to amend/),
      'Vitals: a locked record is read, not changed — no vitals save, no routing, the history locked, who locked it said');
    const qEmt = await viewC('emt.js', 'renderEmt');
    await as('admin');
    const qAdm = await viewC('emt.js', 'renderEmt');
    const emtLkAdm = await viewC('emt.js', 'renderEmt', { id: lkP.id });
    log(!$all('button[title="Patient summary PDF"]', qEmt).length && $all('button[title="Patient summary PDF"]', qAdm).length > 0
      && !!btnIn(emtLkAdm, /Unlock to amend/) && !!btnIn(emtLkAdm, /^Save vitals$/),
      'Vitals: the queue\'s PDF button is offered only to roles that may export; an administrator sees Unlock on a locked record');

    /* ---- editing the patient's details ---- */
    closeOverlays();
    await as('checkout');
    PH.openSectionEditor(db.getPatient(lkP.id), 'demographics', {});
    const edI = $all('.section-editor').pop();
    const inputsI = $all('input', edI);
    log(inputsI[0].disabled && inputsI[1].disabled && /can only be changed by an administrator/.test(edI.textContent),
      'details: on a locked record, check-out edits contact details with name, date of birth and gender shown read-only');
    closeOverlays();
    const svcP = mkC('Sam', 'Services', { demographics: DEMO({ services: ['dental', 'optometry_future'] }) });
    const secA = IS.demographicsSection({ ...db.getPatient(svcP.id), demographics: db.getPatient(svcP.id).demographics }, { staff: true });
    const outA = secA.collect();
    const secB = IS.demographicsSection({ first_name: 'N', last_name: 'S', dob: '1990-01-01', gender: 'male', phone: '5035550000', demographics: DEMO({ services: [] }) }, { staff: true });
    const outB = secB.collect();
    const secK = IS.demographicsSection({ first_name: 'N', last_name: 'S', dob: '1990-01-01', gender: 'male', phone: '5035550000', demographics: DEMO({ services: undefined }) }, {});
    const outK = secK.collect();
    log(!secA.isDirty() && JSON.stringify(outA.demographics.services) === '["dental","optometry_future"]'
      && !secB.isDirty() && outB === false && JSON.stringify(outK.demographics.services) === '["dental"]',
      'details: a service the form has no chip for is kept, a staff edit never invents "Dental", and a new kiosk patient still starts on it');

    /* ---- Arrivals ---- */
    closeOverlays();
    await as('registration');
    const arP = mkC('Ari', 'Arrives');
    const arr = await viewC('arrivals.js', 'renderArrivals');
    $all('.arrival-tab', arr).find((t) => /desk/i.test(t.textContent)).click(); await settle();
    const arRow = $all('.arrival-row', arr).find((r) => /Arrives, Ari/.test(r.textContent));
    btnIn(arRow, /View \/ edit/).click(); await settle();
    const info = $all('.patient-info-overlay').pop();
    log(!!info && info.parentElement === document.body && !!cardOf(info, 'demographics').querySelector('.card-edit')
      && !cardOf(info, 'medical_history').querySelector('.card-edit') && /Wristband ID/.test(info.textContent),
      'Arrivals: View / edit opens the record over the list — the front desk may correct the details, not the history');
    cardOf(info, 'demographics').querySelector('.card-edit').click(); await settle();
    const edA = $all('.section-editor').pop();
    const phoneIn = $all('label.field', edA).find((l) => /^Phone/.test(l.textContent)).querySelector('input');
    setInput(phoneIn, '5035550444');
    btnIn(arr, /Refresh/).click(); await settle();
    log(document.body.contains(edA) && phoneIn.value === '5035550444', 'Arrivals: the list refreshing behind the editor does not close it or lose what is typed');
    btnIn(edA, /^Save$/).click(); await settle();
    log(db.getPatient(arP.id).phone === '5035550444' && document.body.contains(info) && /5035550444/.test(info.textContent),
      'Arrivals: the edit saves, and the record open over the list shows it');
    closeOverlays();

    /* ---- Dental Triage, the hygienist, check-out, Records, Management ---- */
    await as('doctor');
    const dtP = mkC('Dora', 'Dentist', { route: 'dentist' });
    const prov = await viewC('provider.js', 'renderProvider', { id: dtP.id });
    const complaintIn = $all('input', prov).find((i) => i.placeholder === 'Chief complaint');
    setInput(complaintIn, 'Typed, not saved');
    const provPanel = prov.querySelector('details.patient-info');
    cardOf(provPanel, 'medical_history').querySelector('.card-edit').click(); await settle();
    const edP = $all('.section-editor').pop();
    const gateP = $all('label.field', edP).find((l) => /allergy or serious reaction/i.test(l.textContent)).querySelector('select');
    gateP.value = 'yes'; gateP.dispatchEvent(new window.Event('change', { bubbles: true }));
    edP.querySelector('.chip-select[data-key="penicillin"]').click();
    btnIn(edP, /^Save$/).click(); await settle();
    const flagsBanner = $all('.banner', prov).map((b) => b.textContent).find((x) => /Medical flags/.test(x)) || '';
    log(/Allergy: Penicillin/.test(flagsBanner) && complaintIn.isConnected && complaintIn.value === 'Typed, not saved' && !!btnIn(prov, /Mark visit complete/)
      && /Allergies: Penicillin/.test(prov.querySelector('.mini-hist').textContent),
      'Dental Triage: an allergy added from the chart\'s patient panel is flagged at once, and the chart typed so far is untouched');
    const provDone = await viewC('provider.js', 'renderProvider', { id: busy.id });
    const accDone = $all('.card', provDone).find((c) => /Accountability/.test(c.textContent));
    log(/Completed by/.test(accDone.textContent) && !/Signed off/.test(accDone.textContent),
      'Dental Triage: a visit completed without the lock reads "Completed by", not "Signed off by"');
    const provLk = await viewC('provider.js', 'renderProvider', { id: lkP.id });
    const accLk = $all('.card', provLk).find((c) => /Accountability/.test(c.textContent));
    log(/Signed off & locked by/.test(accLk.textContent) && /Unlocked by/.test(accLk.textContent) && /Wrong tooth recorded/.test(accLk.textContent)
      && /Locked by C doctor/.test(provLk.textContent) && !btnIn(provLk, /Unlock to amend/),
      'Dental Triage: a locked record says who locked it and who unlocked it before, and why; the dentist is not offered Unlock');
    await as('admin');
    const provLkA = await viewC('provider.js', 'renderProvider', { id: lkP.id });
    btnIn(provLkA, /Unlock to amend/).click(); await settle();
    const dlg = $all('.unlock-dialog').pop();
    btnIn(dlg, /Unlock to amend/).click(); await settle();
    log(document.body.contains(dlg) && db.getPatient(lkP.id).treatment.locked && /Required/.test(lastToastC()),
      'Unlock: the dialog will not unlock without a reason, and stays open to be given one');
    const why = dlg.querySelector('textarea'); why.value = 'Second correction'; why.dispatchEvent(new window.Event('input', { bubbles: true }));
    btnIn(dlg, /Unlock to amend/).click(); await settle();
    log(!document.body.contains(dlg) && !db.getPatient(lkP.id).treatment.locked && db.getPatient(lkP.id).lock.unlock_reason === 'Second correction',
      'Unlock: with a reason, it unlocks');
    await as('doctor');
    const provAm = await viewC('provider.js', 'renderProvider', { id: lkP.id });
    log(/Amending a signed-off record — unlocked by Administrator/.test(provAm.textContent) && /Second correction/.test(provAm.textContent)
      && !!btnIn(provAm, /Re-sign & lock/) && !!btnIn(provAm, /Save amendment/) && !btnIn(provAm, /Mark visit complete/),
      'Dental Triage: an unlocked record being amended says so, and offers the amendment and the re-lock, not "finish the visit"');
    await as('hygienist');
    const hygP = mkC('Hana', 'Hygiene', { route: 'hygienist' });
    const hyg = await viewC('hygienist.js', 'renderHygienist', { id: hygP.id });
    const hygPanel = hyg.querySelector('details.collapse');
    log(!!hygPanel && hygPanel.classList.contains('patient-info') && hygPanel.hasAttribute('open') && !!cardOf(hygPanel, 'medical_history').querySelector('.card-edit'),
      'Hygienist: the patient panel is still the first, open panel, and the hygienist may correct the history from it');
    await as('checkout');
    const coLk = await viewC('checkout.js', 'renderCheckout', { id: outL.id });
    const coPanel = coLk.querySelector('details.patient-info');
    log(!!coPanel && !!cardOf(coPanel, 'demographics').querySelector('.card-edit') && !cardOf(coPanel, 'medical_history').querySelector('.card-edit')
      && /Locked by C doctor/.test(coLk.textContent) && !btnIn(coLk, /Unlock to amend|Lock record/),
      'Check-out: shows the record and who locked it; check-out may correct contact details, not the history, and cannot unlock');
    await as('admin');
    const coAdm = await viewC('checkout.js', 'renderCheckout', { id: busy.id });
    log(!!btnIn(coAdm, /^Lock record$/), 'Check-out: an administrator can lock a finished visit that was never locked');
    const recAdm = await viewC('records.js', 'renderRecords', { id: outL.id });
    log(!btnIn(recAdm, /Edit patient details/) && !!btnIn(recAdm, /Unlock to amend/) && /Lock history/.test(recAdm.textContent)
      && /Re-locked by C doctor/.test(recAdm.textContent) && /Unlocked by Administrator .* — Add the note/.test(recAdm.textContent)
      && /Locked by/.test($all('.card', recAdm).find((c) => /History \/ accountability/.test(c.textContent)).textContent),
      'Records: the administrator\'s card unlocks and shows the lock trail; the old admin-only "Edit patient details" is gone');
    await as('checkout');
    const recCo = await viewC('records.js', 'renderRecords', { id: mp.id });
    log(!!cardOf(recCo, 'demographics').querySelector('.card-edit') && !cardOf(recCo, 'medical_history').querySelector('.card-edit')
      && /History reviewed by/.test(recCo.textContent) && /Blood thinner/.test(cardOf(recCo, 'medical_history').textContent),
      'Records: check-out edits the details section only; the history card keeps its vitals and blood-thinner lines');
    await as('doctor');
    const recDoc = await viewC('records.js', 'renderRecords', { id: mp.id });
    log(['demographics', 'medical_history', 'dental_history'].every((s) => !!cardOf(recDoc, s).querySelector('.card-edit')),
      'Records: the dentist may correct every section there');
    await as('admin');
    const mg = await viewC('management.js', 'renderManagement');
    const mgRow = (last) => $all('tr', mg).find((r) => new RegExp(last + ', ').test(r.textContent));
    const mgLk = mgRow('Oldlock');
    const mgAm = mgRow('Locked');
    log(!!mgLk && /Locked/.test(mgLk.querySelector('td:nth-child(3)').textContent) && !!btnIn(mgLk, /Unlock to amend/)
      && !!mgAm && /Amending/.test(mgAm.textContent) && !!btnIn(mgAm, /^Lock record$/),
      'Management: every row says Locked or Amending, with Unlock or Lock beside it');
    btnIn(mgAm, /^Lock record$/).click(); await settle();
    const confirmLock = $all('.modal-overlay').pop();
    btnIn(confirmLock, /^Lock record$/).click(); await settle();
    log(db.getPatient(lkP.id).treatment.locked && db.getPatient(lkP.id).lock.locked_by_name === 'Administrator',
      'Management: Lock re-locks the amended record, as the administrator');
    closeOverlays();

    currentUser = signInAdmin();
    storeC.setUser(currentUser);
    if (prevEvC && db.listEvents().some((e) => e.id === prevEvC)) db.setActiveEvent(currentUser, prevEvC);
  }

  /* ===== The clinic's own drug and medication lists =========================
     MMW supplied two spreadsheets: 100 medications patients commonly take, and
     the anaesthetics and antibiotics this clinic actually carries. Both feed
     check-in, and both are duplicated into the Worker, so they are pinned. */
  {
    const fsD = await import('node:fs');
    const readSrc = (rel) => fsD.readFileSync(new URL(rel, import.meta.url), 'utf8');
    const st = await import('../src/renderer/i18n/strings.js');

    log(st.MEDICATIONS.length === 100, `meds: all 100 medications from the clinic list are offered (${st.MEDICATIONS.length})`);
    log(st.MEDICATIONS.every((m) => m.name && m.key && typeof m.rank === 'number'),
      'meds: every medication has a name, a stable key and its ranking');
    // Ordered by how commonly prescribed, so the drugs most patients are on are
    // the first a volunteer sees rather than buried alphabetically.
    const ranks = st.MEDICATIONS.map((m) => m.rank);
    log(ranks.every((r, i) => i === 0 || ranks[i - 1] < r) && ranks[0] === 1 && ranks[99] === 100,
      'meds: the picker lists them commonest-first, with no gaps or duplicates');
    log(st.MEDICATIONS[0].name === 'Atorvastatin' && st.MEDICATIONS[2].name === 'Metformin',
      'meds: the clinic list ordering is preserved exactly');
    const medKeys = new Set(st.MEDICATIONS.map((m) => m.key));
    log(medKeys.size === 100, 'meds: no two medications collide on the same key');

    // The five anaesthetics and five antibiotics MMW carries.
    log(st.ANESTHETICS.length === 5 && st.ANESTHETICS.map((a) => a.en).join('|')
      === 'Lidocaine 2%|Articaine 4%|Mepivacaine 3%|Bupivacaine 0.5%|Prilocaine 4%',
      'drugs: all five local anaesthetics carry their concentration');
    log(st.ANTIBIOTICS.length === 5, 'drugs: all five antibiotics are listed');

    // Every drug the clinic can put IN a patient must be offerable as an
    // allergy — that is the answer that changes what a provider may safely give.
    const allergyKeys = new Set(st.ALLERGIES.map((a) => a.key));
    log(st.ANESTHETICS.every((a) => allergyKeys.has(a.key)),
      'allergies: every anaesthetic the clinic carries can be recorded as an allergy');
    for (const k of ['amoxicillin', 'clindamycin', 'azithromycin', 'amoxicillin_clavulanate', 'penicillin']) {
      log(allergyKeys.has(k), `allergies: ${k} can be recorded`);
    }
    log(st.ALLERGIES.every((a) => a.en && a.es), 'allergies: every option is translated into Spanish');
    // Never drop one that has been logged against a real record.
    log(allergyKeys.has('novocain') && st.ALLERGIES.find((a) => a.key === 'novocain').intake === false,
      'allergies: a retired option is kept for display so an old record still shows it');

    // The chairside agent picker offers all five, not the two it used to —
    // and offers them from the clinic list, skipping only retired agents.
    const provSrc = readSrc('../src/renderer/js/views/provider.js');
    log(/ANESTHETICS\.filter\(\(a\) => !a\.retired \|\| a\.key === current\)\.map/.test(provSrc),
      'drugs: the chairside anaesthetic picker is driven by the clinic list, not its own copy');

    // The Worker keeps its own copies; drift there is silent.
    const wSrc = readSrc('../cloud/worker.js');
    const wMeds = (wSrc.match(/const MED_OPTIONS = '([^']*)'/) || [])[1] || '';
    const wNames = Array.from(wMeds.matchAll(/value="([^"]*)"/g)).map((m) => m[1]);
    log(wNames.length === 100 && wNames[0] === st.MEDICATIONS[0].name && wNames[99] === st.MEDICATIONS[99].name,
      'meds: the online form offers the same 100 in the same order');
    const wAll = (wSrc.match(/const FORM_ALLERGIES = \[([\s\S]*?)\n\];/) || [])[1] || '';
    const wAllKeys = Array.from(wAll.matchAll(/\['([a-z_]+)'/g)).map((m) => m[1]);
    const intakeKeys = st.ALLERGIES.filter((a) => a.intake !== false).map((a) => a.key);
    log(JSON.stringify(wAllKeys) === JSON.stringify(intakeKeys),
      'allergies: the online form offers exactly the same list as the walk-in form');
    // The attribute is written inside a JS string literal in the Worker, so it
    // appears backslash-escaped in the source; what matters is that the RENDERED
    // input carries it, which cloud/test-worker.mjs asserts against real output.
    log(/list=\\?"medlist\\?"/.test(wSrc) && /<datalist id="medlist"/.test(wSrc),
      'meds: the online form suggests from the list while still accepting anything typed');
  }

  /* ===== The survey, split across the visit =================================
     The demographic half is asked at the end of registration and the experience
     half at check-out. They are one row, filled in two sittings hours apart by
     two different people, so the second must MERGE — a check-out that replaced
     the blob would silently erase everything the patient told registration
     about their household and income. */
  {
    currentUser = signInAdmin();
    const two = db.createPatient(currentUser, {
      first_name: 'Two', last_name: 'Sittings', demographics: {}, medical_history: {},
      dental_history: { visit_type: 'cleaning' },
      survey: { answers: { household_size: '4', income: '0_15k', food_insecurity: 'yes' } },
    });
    let sv2 = db.getExitSurvey(two.id);
    log(sv2.registration_status === 'completed' && !sv2.exit_status,
      'survey split: registration records its half and leaves the other open');
    db.saveExitSurvey(currentUser, two.id, { stage: 'exit', answers: { rate_care: '5', recommend: '5' } });
    sv2 = db.getExitSurvey(two.id);
    log(sv2.answers.household_size === '4' && sv2.answers.income === '0_15k',
      'survey split: check-out does NOT erase what registration collected');
    log(sv2.answers.rate_care === '5' && sv2.exit_status === 'completed',
      'survey split: the check-out answers join the same record');

    // Declining at check-out must take only the check-out half with it.
    db.saveExitSurvey(currentUser, two.id, { stage: 'exit', declined: true });
    sv2 = db.getExitSurvey(two.id);
    log(sv2.answers.household_size === '4' && sv2.answers.rate_care === undefined,
      'survey split: declining at check-out clears only the check-out answers');
    log(sv2.registration_status === 'completed' && sv2.exit_status === 'declined',
      'survey split: each half records its own outcome');

    // A patient can decline at registration and still answer at check-out.
    const decl = db.createPatient(currentUser, {
      first_name: 'Declined', last_name: 'Early', demographics: {}, medical_history: {},
      dental_history: { visit_type: 'cleaning' }, survey: { declined: true },
    });
    db.saveExitSurvey(currentUser, decl.id, { stage: 'exit', answers: { rate_care: '4' } });
    const sv3 = db.getExitSurvey(decl.id);
    log(sv3.registration_status === 'declined' && sv3.exit_status === 'completed' && sv3.answers.rate_care === '4',
      'survey split: declining the household questions does not stop the visit questions being answered');

    // The stage map in the data layer must match the sections in the renderer.
    const sx = await import('../src/renderer/i18n/exitSurvey.js');
    for (const stage of ['registration', 'exit']) {
      const ui = sx.questionsForStage(stage).map((q) => q.key).sort();
      const dbq = db.STAGE_QUESTIONS[stage].slice().sort();
      log(JSON.stringify(ui) === JSON.stringify(dbq),
        `survey split: the form and the data layer agree on which questions are asked at ${stage}`);
    }
    log(sx.questionsForStage('registration').length === 22 && sx.questionsForStage('exit').length === 12,
      'survey split: 22 questions at registration, 12 at check-out, 34 in total');
    // By key, not by wording: "What services do you or your household need in
    // the future?" mentions a household but is a forward-looking question that
    // belongs at check-out.
    const DEMOGRAPHIC = ['household_size', 'children_under_18', 'income', 'employment', 'education',
      'living_situation', 'health_insurance', 'dental_insurance', 'vision_insurance', 'assistance'];
    const exitKeys = sx.questionsForStage('exit').map((q) => q.key);
    log(DEMOGRAPHIC.every((k) => !exitKeys.includes(k)),
      'survey split: no household, income or insurance question is left at check-out');
    // And the reverse: nothing that needs the visit to have happened is asked
    // during registration, which is the whole reason for splitting it.
    const POST_VISIT = ['rate_care', 'rate_staff', 'rate_wait', 'explained_care', 'comfortable_questions',
      'will_improve_health', 'reduced_financial_burden'];
    const regKeys = sx.questionsForStage('registration').map((q) => q.key);
    log(POST_VISIT.every((k) => !regKeys.includes(k)),
      'survey split: registration never asks about care the patient has not received yet');
  }

  /* ===== C1 + C4 — age, race, and how the waiver was signed ==================
     Both changes shipped with no coverage at all until these were added, and the
     one pre-existing merge check used mergeSummaries([sum, sum]) — merging a
     report with ITSELF, the single input shape that cannot tell correct
     size-weighted merging apart from averaging two averages. */
  {
    currentUser = signInAdmin();
    const sp = await import('../src/renderer/i18n/exitSurvey.js');   // keep the import graph warm
    void sp;

    // ---- C1: mean age must be a SUM and a COUNT, never a stored average -----
    // Two clinics of DIFFERENT sizes. Averaging the averages gives 40; the true
    // mean of all ten patients is 46.
    const small = { age_sum: 60, age_known: 2, by_race: { white: 1 }, race_answered: 2, race_declined: 0 };
    const large = { age_sum: 400, age_known: 8, by_race: { white: 5, asian: 2 }, race_answered: 7, race_declined: 1 };
    const merged = db.mergeSummaries([small, large]);
    log(merged.age_sum === 460 && merged.age_known === 10,
      'C1: merging reports of different sizes adds the age sum and count');
    log(merged.age_sum / merged.age_known === 46,
      'C1: the combined mean age is of all patients (46), not the average of the two means (40)');
    log(merged.by_race.white === 6 && merged.by_race.asian === 2,
      'C1: race counts merge question by question across clinics');
    log(merged.race_answered === 9 && merged.race_declined === 1,
      'C1: the people-who-answered counts merge too');
    // A report kept before this change has none of these fields.
    const legacyMerge = db.mergeSummaries([small, { patients_seen: 3 }]);
    log(Number.isFinite(legacyMerge.age_sum) && legacyMerge.age_sum === 60,
      'C1: a report kept before age was tracked contributes zero rather than NaN');

    // ---- C1: the capture path, end to end -----------------------------------
    const rp = db.createPatient(currentUser, {
      first_name: 'Race', last_name: 'Capture', dob: '1990-06-01', gender: 'female',
      demographics: { city: 'Sandy', state: 'OR', race: ['black_african_american', 'hispanic_latino'] },
      medical_history: {}, dental_history: { visit_type: 'cleaning' },
    });
    log(JSON.stringify(db.getPatient(rp.id).demographics.race) === JSON.stringify(['black_african_american', 'hispanic_latino']),
      'C1: a race answer survives the round trip through the database');
    const declined = db.createPatient(currentUser, {
      first_name: 'Race', last_name: 'Declined', dob: '1980-06-01',
      demographics: { race: ['prefer_not'] }, medical_history: {}, dental_history: { visit_type: 'cleaning' },
    });
    // A date of birth AFTER the visit is a typo; it must not drag the mean.
    const bad = db.createPatient(currentUser, {
      first_name: 'Bad', last_name: 'Dob', dob: '2099-01-01',
      demographics: {}, medical_history: {}, dental_history: { visit_type: 'cleaning' },
    });
    void declined; void bad;
    const sum1 = db.buildEventSummary();
    log(sum1.by_race.black_african_american >= 1 && sum1.by_race.hispanic_latino >= 1,
      'C1: one patient choosing two categories counts once in each');
    log(sum1.race_declined >= 1, 'C1: "prefer not to answer" is counted as a refusal, not as a category');
    log(Object.keys(sum1.by_race).every((k) => k === 'Not recorded' || /^[a-z_]+$/.test(k)),
      'C1: the report stores raw codes, not display labels, so the blob stays language-neutral');
    const meanNow = sum1.age_sum / sum1.age_known;
    log(meanNow > 0 && meanNow < 130,
      `C1: a date of birth after the visit date cannot poison the mean age (${meanNow.toFixed(1)})`);

    // ---- C4: how the waiver was signed --------------------------------------
    for (const [method, who] of [['draw', 'Drawn Sig'], ['type', 'Typed Sig'], ['generate', 'Made Sig']]) {
      const p4 = db.createPatient(currentUser, {
        first_name: who.split(' ')[0], last_name: 'Waiver', demographics: {}, medical_history: {},
        dental_history: { visit_type: 'filling' },
        consents: [{ type: 'general', signer_name: who, signature_png: 'data:image/png;base64,AAAA', signature_method: method, deemed_consent: 'yes' }],
      });
      const c = db.getPatient(p4.id).consents[0];
      log(c.signature_method === method, `C4: a consent signed by "${method}" records that it was`);
      log(c.deemed_consent === 'yes', `C4: the HIV/Hepatitis answer is stored alongside it (${method})`);
    }
    const junk = db.createPatient(currentUser, {
      first_name: 'Junk', last_name: 'Method', demographics: {}, medical_history: {}, dental_history: {},
      consents: [{ type: 'general', signer_name: 'J', signature_png: 'data:,x', signature_method: 'forged' }],
    });
    log(db.getPatient(junk.id).consents[0].signature_method === null,
      'C4: a signature method the app does not offer is not stored');

    // ---- the duplicated lists, actually pinned ------------------------------
    // Several source comments claim the harness keeps these copies in step.
    // Until now that claim was simply untrue. PRIOR_DENTIST exists in five
    // places and the route rule in two, across CommonJS and ES modules that
    // cannot import each other, so drift is silent and only shows up as a
    // report bucket nobody can explain.
    const fsx = await import('node:fs');
    const strings = await import('../src/renderer/i18n/strings.js');
    const readSrc = (rel) => fsx.readFileSync(new URL(rel, import.meta.url), 'utf8');
    const canonicalPD = strings.PRIOR_DENTIST.map((o) => o.key);
    const keysIn = (src, varName) => {
      const m = src.match(new RegExp(varName + '\\s*=\\s*\\{([\\s\\S]*?)\\n\\};'));
      return m ? Array.from(m[1].matchAll(/^\s*([a-z0-9_]+)\s*:/gm)).map((x) => x[1]) : null;
    };
    const pdfKeys = keysIn(readSrc('../src/main/pdf.js'), 'PRIOR_DENTIST_LABELS');
    const sheetKeys = keysIn(readSrc('../src/main/clinicSheets.js'), 'PRIOR_DENTIST_LABELS');
    const workerSrc = readSrc('../cloud/worker.js');
    const workerArr = workerSrc.match(/const PRIOR_DENTIST = \[([^\]]*)\]/);
    const workerKeys = workerArr ? Array.from(workerArr[1].matchAll(/'([a-z0-9_]+)'/g)).map((x) => x[1]) : null;
    const same = (a) => Array.isArray(a) && JSON.stringify(a.slice().sort()) === JSON.stringify(canonicalPD.slice().sort());
    log(same(pdfKeys), 'C2: the patient-record PDF knows every last-dental-visit option');
    log(same(sheetKeys), 'C2: the clinic spreadsheet knows every last-dental-visit option');
    log(same(workerKeys), 'C2: the online form validates against the same option list');
    log(workerSrc.includes('Within the past 6 months') && workerSrc.includes('En los últimos 6 meses'),
      'C2: the online form carries the options in English and Spanish');

    // C3: the route rule lives in db.js (authoritative) and strings.js (display).
    for (const [vt, want] of [['cleaning', 'hygienist'], ['filling', 'dentist'], ['extraction_pain', 'dentist'], ['extraction_no_pain', 'dentist']]) {
      log(strings.routeForVisitType(vt) === want, `C3: ${vt} routes to the ${want} (renderer copy)`);
    }
    log(strings.routeForVisitType(undefined) === null && strings.routeForVisitType('nonsense') === null,
      'C3: an unknown or missing visit type routes nowhere rather than guessing');
    const dbRoute = readSrc('../src/main/db.js').match(/const VISIT_ROUTE = \{([\s\S]*?)\};/);
    const dbPairs = dbRoute ? Object.fromEntries(Array.from(dbRoute[1].matchAll(/([a-z_]+):\s*'([a-z]+)'/g)).map((m) => [m[1], m[2]])) : {};
    log(Object.entries(dbPairs).every(([k, v]) => strings.routeForVisitType(k) === v)
      && Object.keys(dbPairs).length === 4,
      'C3: the data layer and the renderer agree on every routing rule');

    // C4 / the bug fixed in passing: both must be in the SYNCED payload or they
    // are dropped on every other laptop and on a USB clinic restore.
    const dbSrc = readSrc('../src/main/db.js');
    const consentCols = dbSrc.match(/\n  consent: \[([^\]]*)\]/);
    log(!!consentCols && /'signature_method'/.test(consentCols[1]),
      'C4: how a consent was signed is part of what syncs between laptops');
    log(!!consentCols && /'deemed_consent'/.test(consentCols[1]),
      'C4: the HIV/Hepatitis answer syncs too (it was silently dropped before)');
  }

  /* ================= MMW v0.0.3 — severing the inherited cloud ===============
     Builds up to v0.0.2 shipped another organisation's Worker URL and bearer key
     and connected at boot with no user action. These guard the severance. */
  {
    const SEVERED = 'little-block-222a.randy-982.workers.dev';

    // Nothing is baked in: an unconfigured install has no endpoint and no key.
    const m = db.getSyncMeta();
    log(!m.url && !m.key, 'MMW severance: an unconfigured install has no server or key');
    log(m.enabled === false && m.mode === 'offline',
      'MMW severance: sync fails closed — offline and disabled until configured');
    log(m.configured === false, 'MMW severance: status reports the clinic as not configured');

    // The constant is gone from the source, not merely unused.
    const { readFileSync } = await import('node:fs');
    const dbSrc = readFileSync(fileURLToPathSev(new URL('../src/main/db.js', import.meta.url)), 'utf8');
    const workerSrc = readFileSync(fileURLToPathSev(new URL('../cloud/worker.js', import.meta.url)), 'utf8');
    // The hostname may still appear — the severing migration matches on it to
    // spot an affected install, and cloud.js blocklists it. What must be gone is
    // any use of it as a DEFAULT: a fallback the app would connect to on its own.
    const defaultUses = dbSrc.split('\n').filter((l) => l.includes(SEVERED) && !l.includes('includes('));
    log(!/DEFAULT_CLOUD/.test(dbSrc) && defaultUses.length === 0,
      'MMW severance: the endpoint survives only as a detector, never as a default');
    const cloudSrc = readFileSync(fileURLToPathSev(new URL('../src/main/cloud.js', import.meta.url)), 'utf8');
    log(/SEVERED_HOSTS/.test(cloudSrc) && cloudSrc.includes(SEVERED),
      'MMW severance: the sync engine blocklists the inherited host');
    log(!/DEFAULT_CLINIC_KEY/.test(workerSrc),
      'MMW severance: the sync Worker has no fallback key and fails closed without a secret');

    // Even if the endpoint reappears in settings, it is refused.
    const cloudMod = await import('../src/main/cloud.js');
    const cloud = cloudMod.default || cloudMod;
    db.setSetting('cloud_url', `https://${SEVERED}`);
    db.setSetting('cloud_key', 'randy');
    db.setSetting('cloud_mode', 'online');
    const r = await cloud.syncOnce();
    log(r && r.skipped === true, 'MMW severance: the inherited endpoint is refused even if it reappears in settings');
    log((db.getSyncMeta().lastError || '').includes('another organisation'),
      'MMW severance: refusing it records a plain reason rather than failing silently');

    // Disconnect clears the endpoint and pins the mode to offline.
    db.disconnectCloud();
    const after = db.getSyncMeta();
    log(!after.url && !after.key && after.mode === 'offline' && !after.enabled,
      'MMW severance: disconnect clears the server, key and cursor and pins offline');
  }

  /* ========== MMW v0.0.4 — the printed forms, reflected in the app ==========
     Each MMW document maps to a step: the Patient Application and Consent for
     Health Care to registration, the Consent for Oral Surgery to the surgery
     gate, and the Dental half of the Patient Record to the dentist view. */
  {
    // Registration must RECORD the deemed-consent answer, not merely display
    // the paragraph — a signed consent has to evidence what was agreed.
    // Queried straight from the table: listPatients is scoped to the ACTIVE
    // event, and earlier blocks move it, so the check-in patient is not
    // necessarily in scope by the time this runs.
    const cdb = rawDb();
    const gen = cdb.prepare("SELECT * FROM consents WHERE type = 'general' AND version LIKE 'mmw-general-%' ORDER BY id DESC LIMIT 1").get();
    log(!!gen, 'MMW forms: registration records the general consent');
    log(!!gen && (gen.deemed_consent === 'yes' || gen.deemed_consent === 'no'),
      'MMW forms: the HIV / Hepatitis deemed-consent answer is stored with it');
    cdb.close();

    // The Dental blocks that previously had nowhere to go but free text.
    const evF = db.createEvent(currentUser, { name: 'Forms Clinic' });
    db.setActiveEvent(currentUser, evF.id);
    const fp = db.createPatient(currentUser, { first_name: 'Form', last_name: 'Check' });
    db.saveTreatment(currentUser, fp.id, {
      restorative: { core_buildup: { on: true, tooth: '14' }, denture: { on: true, kind: 'partial', action: 'new' } },
      services: { alveoplasty: '2', irm: '1', buccal: '', pulpotomy: '3' },
    });
    const tx = db.getPatient(fp.id).treatment;
    log(tx.restorative.core_buildup.on === true && tx.restorative.core_buildup.tooth === '14',
      'MMW forms: the dentist view records Restorative (core build-up, tooth)');
    log(tx.restorative.denture.kind === 'partial' && tx.restorative.denture.action === 'new',
      'MMW forms: denture type and action are captured as on the paper record');
    log(tx.services.alveoplasty === '2' && tx.services.pulpotomy === '3',
      'MMW forms: the Services counts (alveoplasty, IRM, buccal, pulpotomy) are captured');

    // Oral surgery consent still carries its tooth numbers.
    db.addPatientConsent(currentUser, fp.id, { type: 'oral_surgery', signer_name: 'Form Check', signature_png: 'data:,', tooth_numbers: '18,19' });
    const os2 = db.getPatient(fp.id).consents.find((c) => c.type === 'oral_surgery');
    log(!!os2 && os2.tooth_numbers === '18,19',
      'MMW forms: the oral surgery consent records the tooth numbers it covers');
  }

  // ---- the wristband scan box reaches the two desk screens ----
  // A band is a keyboard that types fast and presses Enter, which is what makes
  // it the fastest way to identify one person in a room where half the queue
  // shares three surnames. Arrivals and Check-Out are the two screens where a
  // clinic running 250 patients a day feels that most.
  {
    currentUser = signInAdmin();
    const evS = db.createEvent(currentUser, { name: 'Scan Clinic' });
    db.setActiveEvent(currentUser, evS.id);
    const mkS = (first, last, demographics = {}) => db.createPatient(currentUser, {
      first_name: first, last_name: last, dob: '1990-06-01', gender: 'female',
      demographics, medical_history: {}, dental_history: { visit_type: 'cleaning' },
      consents: [{ type: 'general', signer_name: first, signature_png: 'data:image/png;base64,AAAA' }],
    });
    // Two waiting patients, one per tab, so the scan has to pick the right tab
    // as well as the right row — Arrivals opens on 'prereg' while someone is
    // waiting there.
    mkS('Pia', 'Prereg', { preregistered: true });
    const walk = mkS('Wanda', 'Walkin');
    // ...and one who is already through the arrival gate, to scan by mistake.
    const gone = mkS('Gus', 'Gone');
    db.confirmArrival(currentUser, gone.id, {});
    db.saveVitals(currentUser, gone.id, { bp_systolic: '118', bp_diastolic: '76', heart_rate: '68' });
    db.routePatient(currentUser, gone.id, 'hygienist');

    const storeS = (await import('../src/renderer/js/store.js')).store; storeS.setUser(currentUser);
    const toasts = [];
    const ctxS = { navigate: () => {}, toast: (m) => toasts.push(m), store: storeS, setDetail: () => {} };
    const scan = async (view, code) => {
      const input = view.querySelector('.scan-input');
      if (!input) return null; // the check above has already failed; keep the run going
      input.value = code;
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (let i = 0; i < 8; i++) await tick();
      return input;
    };

    const arr = (await import('../src/renderer/js/views/arrivals.js')).renderArrivals(ctxS);
    document.body.append(arr);
    for (let i = 0; i < 6; i++) await tick();
    log(!!arr.querySelector('.scan-box') && !!arr.querySelector('.scan-input'),
      'Arrivals carries the wristband scan box');
    log(/Pre-registered online/.test(((arr.querySelector('.arrival-tab.is-active') || {}).textContent || '')),
      '(setup) Arrivals opens on the pre-registered tab');
    await scan(arr, walk.patient_code);
    const hit = arr.querySelector('.arrival-row--scanned');
    log(!!hit && /Walkin, Wanda/.test(hit.textContent),
      'scanning a band marks that patient\u2019s own row on Arrivals');
    log(/Registered at the desk/.test(((arr.querySelector('.arrival-tab.is-active') || {}).textContent || '')),
      'the scan switches to the tab the patient is actually in, so the row is on screen');
    log(arr.querySelector('input[type="search"]').value === '',
      'the scan clears a search that would otherwise hide the scanned patient');
    // A band belonging to someone already past this screen says so rather than
    // appearing to do nothing at all.
    toasts.length = 0;
    await scan(arr, gone.patient_code);
    log(toasts.some((m) => /Gus Gone is not waiting to be confirmed/.test(m) && /already through/.test(m)),
      'scanning a patient who is already past Arrivals explains why, naming them');
    log(!!arr.querySelector('.arrival-row--scanned') && /Walkin, Wanda/.test(arr.querySelector('.arrival-row--scanned').textContent),
      'a refused scan leaves the screen where it was');

    // Check-Out: the band opens that patient's own check-out record.
    const ready = mkS('Rita', 'Ready');
    db.confirmArrival(currentUser, ready.id, {});
    db.saveVitals(currentUser, ready.id, { bp_systolic: '120', bp_diastolic: '78', heart_rate: '70' });
    db.routePatient(currentUser, ready.id, 'hygienist');
    db.saveTreatment(currentUser, ready.id, { cleaning: { scaling: true }, clinical_notes: 'done' }, true);
    const co2 = (await import('../src/renderer/js/views/checkout.js')).renderCheckout(ctxS);
    document.body.append(co2);
    for (let i = 0; i < 8; i++) await tick();
    log(!!co2.querySelector('.scan-box') && !!co2.querySelector('.scan-input'),
      'Check-Out carries the wristband scan box');
    await scan(co2, ready.patient_code);
    log(/Rita Ready/.test(co2.textContent) && /Verify & dismiss/.test(co2.textContent),
      'scanning a finished patient opens their check-out record, ready to dismiss');
    // Back to the queue, then scan someone who has not been through the clinic.
    const backBtn = Array.from(co2.querySelectorAll('button')).find((b) => /Back|Atr[a\u00e1]s/i.test(b.textContent));
    if (backBtn) backBtn.click();
    for (let i = 0; i < 8; i++) await tick();
    const waitingP = mkS('Nina', 'Notyet');
    await scan(co2, waitingP.patient_code);
    const outToast = Array.from(document.querySelectorAll('#toast-host .toast')).map((x) => x.textContent);
    log(outToast.some((m) => /Nina Notyet has not been through the clinic yet/.test(m)),
      'scanning a patient who has not been treated says so instead of opening a dead button');
    log(/Nina Notyet/.test(co2.textContent),
      'their record still opens, so the desk can see where the patient actually is');
  }

  // ---- bilingual: the medical refusals speak the patient's language ----
  {
    const i18n = await import('../src/renderer/js/i18n.js');
    const refusal = (lang, key) => { i18n.setLang(lang); return i18n.t('common.required') + ': ' + i18n.t(key); };
    log(refusal('es', 'intake.underTreatment') === 'Requerido: \u00bfEst\u00e1 bajo el cuidado de un m\u00e9dico actualmente?',
      'the medical refusal is fully Spanish for a Spanish-speaking patient');
    log(refusal('es', 'intake.majorSurgery') === 'Requerido: \u00bfCirug\u00eda mayor en los \u00faltimos 6 meses?'
      && refusal('es', 'intake.tobacco') === 'Requerido: \u00bfFuma?',
      'the new questions (major surgery, "Do you smoke?") are translated too');
    // The pregnancy row of the conditions table, and its fourth answer.
    log(i18n.conditionLabel('pregnant') === 'Embarazo / posible embarazo (cuando aplique)'
      && i18n.answerLabel('na') === 'No aplica' && i18n.answerLabel('unsure') === 'No estoy seguro/a',
      'the pregnancy row, Not applicable and Unsure are translated too');
    // ru/bzj/nya carry their own 'Required'; the question falls back to English
    // rather than showing a key, which is the existing rule for this file.
    log(refusal('bzj', 'intake.tobacco') === 'Fi need: Do you smoke?',
      'a language without the question translated still names it, in its own Required');
    i18n.setLang('en');
  }

  await tick();
  if (errors.length) errors.forEach((e) => log(false, 'RUNTIME: ' + e));
  const failed = results.filter((r) => !r[0]).length;
  console.log('\n=== ' + (failed ? failed + ' FAILURES' : 'ALL ' + results.length + ' CHECKS PASSED') + ' ===');
  db.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
