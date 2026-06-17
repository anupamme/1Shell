'use strict';

const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

// electron-updater 仅在打包环境可用；开发模式下 require 可能失败，做容错。
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}

const APP_NAME = '1Shell';
const GITHUB_URL = 'https://github.com/weidu12123/1Shell';
const DEFAULT_PORT = 3301;
const DEFAULT_SETTINGS = {
  startAtLogin: false,
  backgroundOnClose: true,
};

let mainWindow = null;
let tray = null;
let settings = { ...DEFAULT_SETTINGS };
let serverProcess = null;
let serverReadyPromise = null;
let usingExternalServer = false;
let isQuitting = false;
let serverExitReason = '';

// 自动更新状态：通过 IPC 推送给渲染进程的"关于"面板
let updateState = {
  status: 'idle', // idle | checking | available | not-available | downloading | downloaded | error | unsupported
  version: '',
  releaseNotes: '',
  percent: 0,
  error: '',
};
let updaterWired = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function resolvePort() {
  const parsed = Number.parseInt(process.env.PORT || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

function appUrl(pathname = '/app/') {
  return `http://127.0.0.1:${resolvePort()}${pathname}`;
}

function getAppRoot() {
  if (process.env.ONESHELL_APP_ROOT) {
    return path.resolve(process.env.ONESHELL_APP_ROOT);
  }
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function getDesktopDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function getDesktopEnvFile() {
  return path.join(app.getPath('userData'), '.env');
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
    return {
      ...DEFAULT_SETTINGS,
      startAtLogin: Boolean(parsed.startAtLogin),
      backgroundOnClose: parsed.backgroundOnClose !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function seedDesktopData() {
  const sourceSkills = path.join(getAppRoot(), 'data', 'skills');
  const targetSkills = path.join(getDesktopDataDir(), 'skills');
  fs.mkdirSync(getDesktopDataDir(), { recursive: true });
  if (fs.existsSync(sourceSkills) && !fs.existsSync(targetSkills)) {
    fs.cpSync(sourceSkills, targetSkills, { recursive: true });
  }
}

function quoteDesktopExec(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function linuxAutostartPath() {
  return path.join(app.getPath('appData'), 'autostart', '1shell.desktop');
}

function applyLinuxStartAtLogin(enabled) {
  const filePath = linuxAutostartPath();
  if (!enabled) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${APP_NAME}`,
    `Comment=Start ${APP_NAME} in the background`,
    `Exec=${quoteDesktopExec(process.execPath)} --hidden`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
  try { fs.chmodSync(filePath, 0o644); } catch { /* best effort */ }
}

function applyStartAtLogin(enabled) {
  if (process.platform === 'linux') {
    applyLinuxStartAtLogin(enabled);
    return;
  }
  const options = {
    openAtLogin: Boolean(enabled),
    path: process.execPath,
    args: ['--hidden'],
  };
  if (process.platform === 'darwin') {
    options.openAsHidden = true;
  }
  app.setLoginItemSettings(options);
}

function readStartAtLoginState() {
  try {
    if (process.platform === 'linux') {
      return fs.existsSync(linuxAutostartPath());
    }
    return app.getLoginItemSettings({
      path: process.execPath,
      args: ['--hidden'],
    }).openAtLogin;
  } catch {
    return Boolean(settings.startAtLogin);
  }
}

function resolveIconPath() {
  const appRoot = getAppRoot();
  const candidates = process.platform === 'win32'
    ? [
      path.join(appRoot, 'public', 'favicon.ico'),
      path.join(appRoot, 'frontend', 'public', 'favicon.png'),
    ]
    : [
      path.join(appRoot, 'frontend', 'public', 'favicon.png'),
      path.join(appRoot, 'public', 'favicon.ico'),
    ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function createTray() {
  if (tray) return tray;
  const iconPath = resolveIconPath();
  if (!iconPath) return null;
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return null;
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  tray.on('click', () => showMainWindow());
  updateTrayMenu();
  return tray;
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: '打开 1Shell',
      click: () => showMainWindow(),
    },
    {
      label: `服务地址: ${appUrl('/app/')}`,
      click: () => shell.openExternal(appUrl('/app/')),
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: readStartAtLoginState(),
      click: (item) => {
        updateDesktopSettings({ startAtLogin: item.checked }).catch(showSettingsError);
      },
    },
    {
      label: '关闭窗口后后台运行',
      type: 'checkbox',
      checked: settings.backgroundOnClose,
      click: (item) => {
        updateDesktopSettings({ backgroundOnClose: item.checked }).catch(showSettingsError);
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => quitApp(),
    },
  ]);
  tray.setContextMenu(menu);
}

function showSettingsError(error) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:settings-error', error.message || String(error));
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function dataPage(title, body) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { min-height: 100%; display: grid; place-items: center; padding: 32px; box-sizing: border-box; }
    section { width: min(520px, 100%); border: 1px solid rgba(148, 163, 184, .25); border-radius: 12px; padding: 24px; background: rgba(15, 23, 42, .82); }
    h1 { margin: 0 0 10px; font-size: 20px; line-height: 1.3; }
    p { margin: 0; color: #94a3b8; line-height: 1.7; font-size: 14px; }
    code { color: #bae6fd; }
  </style>
</head>
<body><main><section><h1>${escapeHtml(title)}</h1><p>${body}</p></section></main></body>
</html>`)}`;
}

function loadingPage() {
  return dataPage('正在启动 1Shell', `正在启动本地服务，端口 <code>${resolvePort()}</code> 会继续用于 MCP 与 API。`);
}

function errorPage(error) {
  return dataPage('1Shell 启动失败', `${escapeHtml(error.message || String(error))}<br><br>可以查看桌面应用数据目录中的 <code>logs/backend.log</code>。`);
}

function createMainWindow({ show = true } = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const iconPath = resolveIconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: APP_NAME,
    icon: iconPath || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && settings.backgroundOnClose) {
      event.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (show) {
    mainWindow.once('ready-to-show', () => showMainWindow());
  }
  mainWindow.loadURL(loadingPage()).catch(() => {});
  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    openMainWindow({ show: true }).catch(showSettingsError);
    return;
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function appendBackendLog(message) {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'backend.log'), message, 'utf8');
  } catch {
    // Logging must never break startup.
  }
}

function resolveNodeExecutable() {
  const appRoot = getAppRoot();
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const runtimeRel = process.platform === 'win32'
    ? path.join('runtime', 'node', exeName)
    : path.join('runtime', 'node', 'bin', exeName);
  const candidates = [
    path.join(appRoot, runtimeRel),
    path.join(process.resourcesPath || appRoot, runtimeRel),
    path.join(process.cwd(), runtimeRel),
  ];
  const bundled = candidates.find((candidate) => fs.existsSync(candidate));
  return bundled || 'node';
}

function isAbsoluteCommand(command) {
  return path.isAbsolute(command) || /^[a-zA-Z]:[\\/]/.test(command);
}

function healthCheckOnce() {
  return new Promise((resolve) => {
    const req = http.get(appUrl('/api/health'), (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthCheckOnce()) return;
    if (serverExitReason) throw new Error(serverExitReason);
    await delay(500);
  }
  throw new Error(`本地服务在 ${Math.round(timeoutMs / 1000)} 秒内没有响应: ${appUrl('/api/health')}`);
}

function spawnServer() {
  const appRoot = getAppRoot();
  const nodeExecutable = resolveNodeExecutable();
  const env = { ...process.env };
  env.NODE_ENV = env.NODE_ENV || 'production';
  env.ONESHELL_DESKTOP = '1';
  env.ONESHELL_DATA_DIR = getDesktopDataDir();
  env.ONESHELL_ENV_FILE = getDesktopEnvFile();
  env.PORT = String(resolvePort());
  delete env.ELECTRON_RUN_AS_NODE;

  if (isAbsoluteCommand(nodeExecutable)) {
    env.PATH = `${path.dirname(nodeExecutable)}${path.delimiter}${env.PATH || ''}`;
  }

  serverExitReason = '';
  appendBackendLog(`\n[desktop] starting backend at ${new Date().toISOString()}\n`);
  serverProcess = spawn(nodeExecutable, [path.join(appRoot, 'server.js')], {
    cwd: appRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (chunk) => appendBackendLog(chunk.toString()));
  serverProcess.stderr.on('data', (chunk) => appendBackendLog(chunk.toString()));
  serverProcess.on('error', (error) => {
    serverExitReason = `无法启动 Node 后端: ${error.message}`;
    appendBackendLog(`[desktop] backend spawn error: ${error.stack || error.message}\n`);
  });
  serverProcess.on('exit', (code, signal) => {
    const reason = `后端进程已退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    serverExitReason = reason;
    appendBackendLog(`[desktop] ${reason}\n`);
    serverProcess = null;
    updateTrayMenu();
  });
}

async function ensureServer() {
  if (serverReadyPromise) return serverReadyPromise;
  serverReadyPromise = (async () => {
    seedDesktopData();
    if (await healthCheckOnce()) {
      usingExternalServer = true;
      return;
    }
    usingExternalServer = false;
    spawnServer();
    await waitForHealth();
  })();
  try {
    await serverReadyPromise;
  } finally {
    serverReadyPromise = null;
  }
}

async function openMainWindow({ show = true } = {}) {
  const win = createMainWindow({ show });
  try {
    await ensureServer();
    await win.loadURL(appUrl('/app/'));
    if (show) showMainWindow();
  } catch (error) {
    await win.loadURL(errorPage(error)).catch(() => {});
    win.show();
  }
}

function getSettingsPayload() {
  return {
    available: true,
    platform: process.platform,
    port: resolvePort(),
    url: appUrl('/app/'),
    startAtLogin: readStartAtLoginState(),
    backgroundOnClose: settings.backgroundOnClose,
    serviceRunning: usingExternalServer || Boolean(serverProcess),
    serviceManaged: !usingExternalServer,
    dataDir: getDesktopDataDir(),
    envFile: getDesktopEnvFile(),
  };
}

async function updateDesktopSettings(patch) {
  if (!patch || typeof patch !== 'object') {
    throw new Error('无效的桌面设置');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'startAtLogin')) {
    const enabled = Boolean(patch.startAtLogin);
    applyStartAtLogin(enabled);
    settings.startAtLogin = enabled;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'backgroundOnClose')) {
    settings.backgroundOnClose = Boolean(patch.backgroundOnClose);
  }
  saveSettings();
  updateTrayMenu();
  return getSettingsPayload();
}

async function stopServer() {
  if (usingExternalServer || !serverProcess) return;
  const child = serverProcess;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 4000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function quitApp() {
  isQuitting = true;
  await stopServer();
  app.quit();
}

// ─── 自动更新 ───────────────────────────────────────────────────────────
function broadcastUpdateState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:update-state', getUpdatePayload());
  }
}

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  broadcastUpdateState();
}

// Linux 下 electron-updater 只能在以 AppImage 方式运行时工作（依赖 APPIMAGE 环境变量）。
// 解压直跑 / 包管理器安装的版本无法自更新，需要给出明确提示而非抛原始错误。
function linuxAppImageUnavailable() {
  return process.platform === 'linux' && app.isPackaged && !process.env.APPIMAGE;
}

function getUpdatePayload() {
  const supported = Boolean(autoUpdater) && app.isPackaged && !linuxAppImageUnavailable();
  return {
    supported,
    currentVersion: app.getVersion(),
    githubUrl: GITHUB_URL,
    releasesUrl: `${GITHUB_URL}/releases`,
    ...updateState,
  };
}

function wireAutoUpdater() {
  if (updaterWired || !autoUpdater) return;
  updaterWired = true;
  autoUpdater.autoDownload = false;          // 由用户在"关于"里点"下载更新"
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdateState({ status: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => setUpdateState({
    status: 'available', version: info?.version || '', releaseNotes: normalizeReleaseNotes(info?.releaseNotes), error: '',
  }));
  autoUpdater.on('update-not-available', () => setUpdateState({ status: 'not-available', error: '' }));
  autoUpdater.on('download-progress', (p) => setUpdateState({ status: 'downloading', percent: Math.round(p?.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => setUpdateState({ status: 'downloaded', version: info?.version || updateState.version, percent: 100 }));
  autoUpdater.on('error', (err) => setUpdateState({ status: 'error', error: err?.message || String(err) }));
}

function normalizeReleaseNotes(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes.slice(0, 4000);
  if (Array.isArray(notes)) return notes.map((n) => n?.note || '').filter(Boolean).join('\n\n').slice(0, 4000);
  return '';
}

async function checkForUpdates() {
  if (!autoUpdater || !app.isPackaged) {
    setUpdateState({ status: 'unsupported', error: '' });
    return getUpdatePayload();
  }
  if (linuxAppImageUnavailable()) {
    setUpdateState({ status: 'unsupported', error: '当前不是以 AppImage 方式运行，无法自动更新，请前往 GitHub Releases 下载最新 AppImage。' });
    return getUpdatePayload();
  }
  wireAutoUpdater();
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setUpdateState({ status: 'error', error: err?.message || String(err) });
  }
  return getUpdatePayload();
}

async function downloadUpdate() {
  if (!autoUpdater || !app.isPackaged) return getUpdatePayload();
  wireAutoUpdater();
  try {
    setUpdateState({ status: 'downloading', percent: 0, error: '' });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    setUpdateState({ status: 'error', error: err?.message || String(err) });
  }
  return getUpdatePayload();
}

function quitAndInstall() {
  if (!autoUpdater || updateState.status !== 'downloaded') return false;
  isQuitting = true;
  stopServer().catch(() => {}).finally(() => {
    try { autoUpdater.quitAndInstall(); } catch { app.quit(); }
  });
  return true;
}

ipcMain.handle('desktop:get-settings', () => getSettingsPayload());
ipcMain.handle('desktop:update-settings', (_event, patch) => updateDesktopSettings(patch));
ipcMain.handle('desktop:open-window', () => {
  showMainWindow();
  return getSettingsPayload();
});
ipcMain.handle('desktop:quit', () => quitApp());
ipcMain.handle('desktop:get-update-state', () => getUpdatePayload());
ipcMain.handle('desktop:check-update', () => checkForUpdates());
ipcMain.handle('desktop:download-update', () => downloadUpdate());
ipcMain.handle('desktop:install-update', () => quitAndInstall());

app.on('second-instance', () => showMainWindow());

app.on('before-quit', () => {
  isQuitting = true;
  stopServer().catch(() => {});
});

app.on('window-all-closed', () => {
  if (!settings.backgroundOnClose) {
    quitApp().catch(() => app.quit());
  }
});

app.on('activate', () => {
  openMainWindow({ show: true }).catch(showSettingsError);
});

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.oneshell.app');
  }
  settings = readSettings();
  applyStartAtLogin(settings.startAtLogin);
  saveSettings();
  const trayCreated = createTray();
  const hiddenLaunch = process.argv.includes('--hidden') && settings.backgroundOnClose && Boolean(trayCreated);
  openMainWindow({ show: !hiddenLaunch }).catch(showSettingsError);
  // 启动后静默检查更新（仅打包环境；不自动下载，发现新版本时在"关于"里提示）
  if (autoUpdater && app.isPackaged) {
    setTimeout(() => { checkForUpdates().catch(() => {}); }, 8000);
  }
}).catch((error) => {
  appendBackendLog(`[desktop] fatal startup error: ${error.stack || error.message}\n`);
  app.quit();
});
