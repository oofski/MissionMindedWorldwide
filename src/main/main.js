'use strict';

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const db = require('./db');
const ipc = require('./ipc');
const autoupdate = require('./autoupdate');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#f6f7f8',
    show: false,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    title: 'Mission Minded',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses ipcRenderer; renderer stays isolated
      spellcheck: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open external links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const about = {
    // Contact details come from the MMW consent form rather than a web
    // link: the clinic runs offline, so a browser is often unavailable
    // and the phone number is what a patient actually needs.
    label: 'About Mission Minded',
    click: () => dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'About Mission Minded',
      message: `Mission Minded Worldwide\nFree Clinics — v${app.getVersion()}`,
      detail: [
        '4633 Avenida Rio Del Oro',
        'Yorba Linda, CA 92886',
        'Telephone: (951) 317-4968',
        '',
        'Offline-first patient records for free dental, medical and vision clinics.',
      ].join('\n'),
      buttons: ['Close'],
    }),
  };

  const template = [
    // macOS puts the application menu first and expects the standard roles in
    // it — About and Quit live here, not under Help, and Cmd+Q comes from the
    // quit role rather than working by itself.
    ...(isMac ? [{
      label: app.name,
      submenu: [
        about,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: isMac ? 'File' : 'Mission Minded',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit' },
      ],
    },
    // Not optional on macOS. Chromium gives Windows and Linux cut/copy/paste
    // for free, but on macOS those accelerators are driven BY the menu — with
    // no Edit menu, Cmd+C, Cmd+V, Cmd+X, Cmd+Z and Cmd+A do nothing anywhere
    // in the app, which makes every form in the clinic painful to fill in.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' }] : []),
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    // Printing a wristband or a patient record opens the system print dialog,
    // which on macOS is a sheet on the window — a minimised window hides it,
    // so the window controls belong in the menu bar there.
    ...(isMac ? [{ role: 'windowMenu' }] : []),
    ...(isMac ? [] : [{
      label: 'Help',
      submenu: [about],
    }]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  db.init(app.getPath('userData'));
  ipc.register(() => mainWindow);
  autoupdate.init(() => mainWindow);
  require('./cloud').start(() => mainWindow);
  buildMenu();
  createWindow();

  // Silent online update check shortly after launch (installed app only).
  setTimeout(() => autoupdate.checkSilently(), 4000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  db.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => db.close());

// Single-instance lock — a clinic should run one copy per device.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
