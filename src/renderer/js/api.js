// Thin wrapper over the preload-exposed IPC bridge. Every call returns the
// resolved data or throws with the server-side error message.

async function call(method, payload) {
  const res = await window.api[method](payload);
  if (!res || res.ok === false) {
    throw new Error((res && res.error) || 'Something went wrong.');
  }
  return res.data;
}

export const api = {
  login: (username, password) => call('authLogin', { username, password }),
  logout: () => window.api.authLogout(),
  current: () => call('authCurrent'),
  needsSetup: () => call('authNeedsSetup'),
  setupAdmin: (p) => call('authSetupAdmin', p),

  listUsers: () => call('usersList'),
  createUser: (p) => call('usersCreate', p),
  updateUser: (p) => call('usersUpdate', p),
  deleteUser: (id) => call('usersDelete', id),
  clearEventStaff: (eventId) => call('usersClearEventStaff', eventId),

  listEvents: () => call('eventsList'),
  activeEvent: () => call('eventsActive'),
  createEvent: (p) => call('eventsCreate', p),
  updateEvent: (p) => call('eventsUpdate', p),
  setActiveEvent: (id) => call('eventsSetActive', id),
  setEventState: (id, active) => call('eventsSetState', { id, active }),
  deleteEvent: (id, force) => call('eventsDelete', { id, force }),

  createPatient: (p) => call('patientsCreate', p),
  // v0.0.15: one section of the intake answers, as CHANGES (null removes a key).
  updatePatientSection: (id, section, values, opts) => call('patientsUpdateSection', { id, section, values, ...(opts || {}) }),
  deletePatient: (id) => call('patientsDelete', id),
  getPatient: (id) => call('patientsGet', id),
  listPatients: (opts) => call('patientsList', opts),
  records: (opts) => call('patientsRecords', opts),
  searchAll: (term) => call('patientsSearchAll', term),
  findByCode: (code) => call('patientsFindByCode', code),
  newVisit: (sourceId) => call('patientsNewVisit', sourceId),
  patientHistory: (id) => call('patientsHistory', id),
  listIncomplete: () => call('patientsIncomplete'),
  cleanupIncomplete: () => call('patientsCleanupIncomplete'),

  saveTriage: (patientId, data) => call('triageSave', { patientId, data }),

  saveExitSurvey: (patientId, data) => call('surveySave', { patientId, data }),
  saveTreatment: (patientId, data, finalize) => call('treatmentSave', { patientId, data, finalize }),
  unlockRecord: (patientId, reason) => call('treatmentUnlock', { patientId, reason }),
  lockRecord: (patientId) => call('treatmentLock', { patientId }),
  saveVitals: (patientId, data) => call('vitalsSave', { patientId, data }),
  routePatient: (patientId, route) => call('patientsRoute', { patientId, route }),
  setConsentTeeth: (consentId, tooth_numbers) => call('consentSetTeeth', { consentId, tooth_numbers }),
  addConsent: (patientId, consent) => call('consentAdd', { patientId, consent }),
  // Front-desk arrivals (v1.5.24)
  arrivalCheck: (id) => call('patientsArrivalCheck', id),
  confirmArrival: (id, route) => call('patientsConfirmArrival', { id, route }),
  dismissPatient: (id, { reason } = {}) => call('patientsDismiss', reason ? { id, reason } : id),
  movePatient: (id, target) => call('patientsMove', { id, target }),
  patientAudit: (id) => call('patientsAudit', id),

  usbList: () => call('usbList'),
  usbWriteCheckin: (patientId) => call('usbWriteCheckin', { patientId }),
  usbLoad: () => call('usbLoad'),
  usbUploadCheckout: () => call('usbUploadCheckout'),
  usbClear: (dir) => call('usbClear', { dir, choose: !dir }),

  addXray: (p) => call('xrayAdd', p),
  setXrayTooth: (id, tooth) => call('xraySetTooth', { id, tooth }),
  xrayFolderList: () => call('xrayFolderList', {}),
  xrayFolderConfig: () => call('xrayFolderConfig', {}),
  xrayFolderChoose: () => call('xrayFolderChoose', {}),
  xrayFolderLock: (opts) => call('xrayFolderLock', opts || {}),
  xrayFolderDelete: (name) => call('xrayFolderDelete', { name }),
  deleteDiskFile: (path) => call('xrayDeleteFile', { path }),
  getXray: (id) => call('xrayGet', id),
  listXrays: (patientId) => call('xrayList', patientId),
  deleteXray: (id) => call('xrayDelete', id),

  dashboard: () => call('statsDashboard'),
  audit: (limit) => call('auditList', limit),

  // lang is optional: the language of the after-care page, when it should not
  // be the patient's own (e.g. "Print in English").
  pdfPreview: (patientId, format, lang) => call('pdfPreview', { patientId, format, lang }),
  pdfGenerate: (patientId, format, lang) => call('pdfGenerate', { patientId, format, lang }),
  pdfPrint: (patientId, format, lang) => call('pdfPrint', { patientId, format, lang }),
  aftercareGet: (patientId, lang) => call('aftercareGet', { patientId, lang }),
  exportRecordUsb: (patientId) => call('recordExportUsb', { patientId }),

  backup: () => call('backupRun'),
  exportEvent: (eventId) => call('exportEvent', { eventId }),
  exportReport: (scope, format, labels) => call('reportExport', { scope, format, labels }),
  inventoryList: (eventId) => call('inventoryList', { eventId }),
  inventoryGet: (id) => call('inventoryGet', { id }),
  inventorySave: (data) => call('inventorySave', { data }),
  inventoryMove: (data) => call('inventoryMove', { data }),
  inventoryDelete: (id) => call('inventoryDelete', { id }),
  inventoryChairUsage: (eventId) => call('inventoryChairUsage', { eventId }),
  exportZip: () => call('exportZip'),
  exportClinic: (eventId) => call('exportClinic', { eventId }),
  importClinic: () => call('importClinic'),
  finishEvent: (eventId) => call('eventFinish', { eventId }),
  purgeEvent: (eventId) => call('eventPurge', { eventId }),
  archivedReports: () => call('reportsArchived'),
  reportRollup: (eventId) => call('reportsRollup', { eventId }),
  rebuildReport: () => call('reportsRebuild'),

  appVersion: () => call('appVersion'),
  checkUpdate: (opts) => call('updateCheck', opts || {}),
  installUpdate: (path) => call('updateInstall', { path }),

  // Online auto-update
  onlineUpdateAvailable: () => call('updateOnlineAvailable'),
  checkOnline: () => call('updateCheckOnline'),
  downloadOnline: () => call('updateDownloadOnline'),
  installOnline: () => call('updateInstallOnline'),
  onUpdateEvent: (cb) => window.api.onUpdateEvent(cb),

  // Cloud sync (v1.1.0)
  cloudStatus: () => call('cloudStatus'),
  cloudConfig: (cfg) => call('cloudConfig', cfg),
  // lan (v0.0.17): the address is a clinic network host — { pin, hostId, fp,
  // name }, as far as known. The answer then carries the pin to save with it.
  cloudTest: (url, key, lan) => call('cloudTest', { url, key, ...(lan ? { lan } : {}) }),
  cloudSyncNow: () => call('cloudSyncNow'),
  cloudResync: () => call('cloudResync'),
  cloudDisconnect: () => call('cloudDisconnect'),
  // v0.0.16: the server address + clinic key as one code (administrators
  // only), and the sign-in screen's Join a clinic (test, save, first sync).
  cloudConnectionCode: () => call('cloudConnectionCode'),
  // move: the person confirmed moving a laptop already connected elsewhere.
  cloudJoin: (url, key, move, lan) => call('cloudJoin', { url, key, ...(move ? { move: true } : {}), ...(lan ? { lan } : {}) }),
  // v0.0.17: the clinic network — hosting it here (administrators only), and
  // the hosts heard on this Wi-Fi.
  hubStatus: () => call('hubStatus'),
  hubStart: (name, move) => call('hubStart', { name, ...(move ? { move: true } : {}) }),
  hubStop: (erase) => call('hubStop', { erase: !!erase }),
  hubFirewall: () => call('hubFirewall'),
  lanScan: (ms) => call('lanScan', { ms }),
  resetAllData: () => call('dataReset'),
  onCloudChanged: (cb) => window.api.onCloudChanged(cb),

  openExternal: (url) => window.api.appOpenExternal(url),
};
