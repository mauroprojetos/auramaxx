const { app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

const WEB_PORT = process.env.AURA_WEB_PORT || '4747';
const API_PORT = process.env.AURA_API_PORT || '4242';
const WEB_URL = process.env.AURA_WEB_URL || `http://localhost:${WEB_PORT}`;
const API_URL = process.env.AURA_API_URL || `http://localhost:${API_PORT}`;
const INSTALL_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const CLI_CANDIDATES = ['aura', 'auramaxx'];
const STARTUP_HTML = path.join(__dirname, 'startup.html');
const APP_ICON = path.join(__dirname, 'icon.png');

let auraProcess = null;
let mainWindow = null;
let tray = null;

// ── Logging ──────────────────────────────────────────────────

function log(...args) {
  console.log('[desktop-electron]', ...args);
}

// ── Shell helpers ────────────────────────────────────────────

function runCommand(command, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      env: process.env,
      ...opts,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, code: code ?? 1, stdout, stderr });
    });
  });
}

async function commandExists(bin) {
  const check = process.platform === 'win32'
    ? await runCommand('where', [bin])
    : await runCommand('which', [bin]);
  return check.ok;
}

async function resolveAuraCli() {
  for (const candidate of CLI_CANDIDATES) {
    if (await commandExists(candidate)) return candidate;
  }
  return null;
}

// ── Health checks ────────────────────────────────────────────

async function isWebReady() {
  try {
    const res = await fetch(WEB_URL, { method: 'GET' });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function isApiReady() {
  try {
    const res = await fetch(`${API_URL}/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForWeb(timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isWebReady()) return;
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`Timed out waiting for dashboard at ${WEB_URL}`);
}

// ── IPC: service lifecycle ───────────────────────────────────

function sendStatus(phase, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('aura:start-status', { phase, message });
  }
}

function registerIpcHandlers() {
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('shell:openExternal', async (_event, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  // Quick health check — is the dashboard reachable right now?
  ipcMain.handle('aura:check-ready', async () => {
    return isWebReady();
  });

  // Full start sequence: find CLI → install if needed → start service → wait
  ipcMain.handle('aura:start-service', async () => {
    try {
      // Already running?
      if (await isWebReady()) {
        sendStatus('ready', 'Dashboard is running');
        return { ok: true };
      }

      // Resolve CLI
      sendStatus('checking', 'Looking for AuraMaxx CLI\u2026');
      let cli = await resolveAuraCli();

      if (!cli) {
        sendStatus('installing', 'Installing AuraMaxx (npm install -g auramaxx)\u2026');
        log('CLI not found. Running npm install -g auramaxx ...');
        const install = await runCommand(INSTALL_CMD, ['install', '-g', 'auramaxx'], { stdio: 'pipe' });
        if (!install.ok) {
          const detail = (install.stderr || install.stdout || '').slice(0, 300);
          return { ok: false, error: `npm install failed: ${detail}`.trim() };
        }
        cli = await resolveAuraCli();
        if (!cli) {
          return { ok: false, error: 'AuraMaxx CLI still not found after installation. Check your PATH.' };
        }
      }

      // Start service
      sendStatus('starting', 'Starting AuraMaxx service\u2026');
      log(`Starting service with: ${cli} start`);
      auraProcess = spawn(cli, ['start'], {
        env: process.env,
        cwd: path.resolve(__dirname, '..', '..'),
        stdio: 'pipe',
      });
      auraProcess.stdout?.on('data', (chunk) => log(String(chunk).trim()));
      auraProcess.stderr?.on('data', (chunk) => console.error('[desktop-electron:aura]', String(chunk).trim()));

      // Wait for dashboard
      sendStatus('waiting', 'Waiting for dashboard\u2026');
      await waitForWeb(60000);

      sendStatus('ready', 'Dashboard is ready');
      startStatusPolling();
      return { ok: true };
    } catch (err) {
      log('Start service failed:', err?.message || err);
      return { ok: false, error: err?.message || 'Failed to start AuraMaxx' };
    }
  });

  // Navigate main window to the live dashboard
  ipcMain.handle('aura:navigate-dashboard', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(WEB_URL);
    }
  });
}

// ── Tray icon ────────────────────────────────────────────────

function createTrayIcon() {
  const icon = nativeImage.createFromPath(APP_ICON);

  if (process.platform === 'darwin') {
    // macOS menubar: 16pt (32px at 2x retina)
    return icon.resize({ width: 16, height: 16 });
  }

  // Windows/Linux: 24x24
  return icon.resize({ width: 24, height: 24 });
}

function buildTrayMenu() {
  const windowVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  return Menu.buildFromTemplate([
    {
      label: 'AuraMaxx',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: windowVisible ? 'Hide Window' : 'Show Window',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createWindow();
        } else if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    },
    {
      label: 'Open in Browser',
      click: () => shell.openExternal(WEB_URL),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('AuraMaxx');
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    } else if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
    if (tray) tray.setContextMenu(buildTrayMenu());
  });
}

// ── Status polling ───────────────────────────────────────────

let statusInterval = null;

function startStatusPolling() {
  if (statusInterval) return;
  statusInterval = setInterval(async () => {
    const apiUp = await isApiReady();
    const tooltip = apiUp ? 'AuraMaxx — Running' : 'AuraMaxx — Offline';
    if (tray && !tray.isDestroyed()) {
      tray.setToolTip(tooltip);
    }
  }, 15_000);
}

function stopStatusPolling() {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
}

// ── Menu bar ─────────────────────────────────────────────────

function createMenu() {
  const template = [
    {
      label: 'Aura',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Aura Docs',
          click: () => shell.openExternal(`${WEB_URL}/docs`),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Windows ──────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'Aura',
    icon: APP_ICON,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
    },
  });

  // On any navigation failure (ERR_CONNECTION_REFUSED, etc.) show the startup page.
  // Only redirect if we were trying to load the dashboard, not the local startup file.
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _errorDesc, validatedURL) => {
    const isRemoteURL = validatedURL && validatedURL.startsWith('http');
    if (isRemoteURL) {
      log(`Dashboard load failed (code ${errorCode}): ${validatedURL}. Showing startup page.`);
      mainWindow.loadFile(STARTUP_HTML);
    }
  });

  // Start by loading the local startup page — it auto-checks and redirects if dashboard is up.
  mainWindow.loadFile(STARTUP_HTML);

  // Close window → hide to tray instead of quitting (macOS behavior)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (tray) tray.setContextMenu(buildTrayMenu());
    }
  });

  mainWindow.on('show', () => {
    if (tray) tray.setContextMenu(buildTrayMenu());
  });

  return mainWindow;
}

// ── App lifecycle ────────────────────────────────────────────

app.isQuitting = false;

app.on('before-quit', () => {
  app.isQuitting = true;
  stopStatusPolling();
  if (auraProcess && !auraProcess.killed) {
    auraProcess.kill('SIGTERM');
  }
});

app.whenReady().then(async () => {
  registerIpcHandlers();
  createMenu();
  createTray();

  // Set dock icon on macOS (dev mode uses default Electron icon otherwise)
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(APP_ICON);
  }

  // Show window immediately with the startup page.
  // The startup page auto-checks if the dashboard is running and redirects if so.
  createWindow();

  // If the dashboard is already up, start polling right away
  if (await isWebReady()) {
    startStatusPolling();
  }

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (!tray || tray.isDestroyed()) {
      app.quit();
    }
  }
});
