const { app, BrowserWindow, ipcMain, screen, desktopCapturer, globalShortcut, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const APP_NAME = 'ScreenMagnify3';
const METHOD_IDS = [
  'nearest',
  'bilinear',
  'bicubic-catmull',
  'lanczos3',
  'nis',
  'realesrgan',
  'nomos-span',
  'realesrgan-x4plus'
];
const GPU_ONLY = { nis: 'lanczos3', 'realesrgan-x4plus': 'realesrgan' };
const SHAPES = ['rect', 'ellipse', 'free'];
const LENS_STYLES = ['clean', 'bold', 'classic'];
const DEFAULT_SETTINGS = {
  mode: 1, // 1 = capture a selection (ScreenMagnify), 2 = lens over the screen (ScreenMagnify2)
  lensSize: 10,
  lensStyle: 'clean',
  lensMaxScale: 2,
  alwaysOnTop: true,
  freeze: true,
  delay: 0,
  aiDevice: 'cpu',
  method: 'realesrgan',
  panelCount: 1,
  aiMaxSize: -1,
  theme: 'dark',
  shape: 'rect',
  lastSaveDir: '',
  customPaths: []
};

let settings = { ...DEFAULT_SETTINGS, customPaths: [] };
let mainWindow = null;
let resultWindow = null;
let settingsWindow = null;
let settingsWasOpen = false;
let lensWindows = [];
let lensModalOpen = false; // the save dialog is open in a lens window
let lensSettingsWasOpen = false;
let overlayWindows = [];
let pendingCaptureDisplayId = null;
let freezeImages = {}; // display id -> screenshot (NativeImage) taken when the selection started

const selection = {
  active: false,
  shape: 'rect',
  waitTimer: null,
  waitResolve: null
};

let aiWorker = null;
let aiSeq = 0;
let aiProvider = null;
const aiPending = new Map();
// Largest AI input in pixels (the x4 output is 16x that: 2.5 M px in -> about 150 MiB RGBA out). Keep in sync with SM.AI_MAX_PIXELS.
const AI_MAX_INPUT_PIXELS = 2.6e6;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.setAppUserModelId('com.screenmagnify3.app');

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      settings = { ...DEFAULT_SETTINGS, ...parsed };
      // Migrate old on/off checkboxes: an unchecked option meant its neutral value.
      if (parsed.delayOn === false) settings.delay = 0;
      if (parsed.panelsOn === false) settings.panelCount = 1;
      if (parsed.methodOn === false) settings.method = 'nearest';
      delete settings.delayOn;
      delete settings.methodOn;
      delete settings.panelsOn;
    }
  } catch {
    settings = { ...DEFAULT_SETTINGS, customPaths: [] };
  }
  validateSettings();
}

function validateSettings() {
  settings.mode = settings.mode === 2 ? 2 : 1;
  if (!LENS_STYLES.includes(settings.lensStyle)) settings.lensStyle = DEFAULT_SETTINGS.lensStyle;
  settings.lensSize = Math.max(5, Math.min(40, Math.round(Number(settings.lensSize) || 10)));
  settings.lensMaxScale = Math.max(1, Math.min(5, Math.round(Number(settings.lensMaxScale) || 2)));
  settings.alwaysOnTop = !!settings.alwaysOnTop;
  settings.freeze = !!settings.freeze;
  if (settings.aiDevice !== 'gpu') settings.aiDevice = 'cpu';
  settings.delay = Math.max(0, Math.min(10, Math.round(Number(settings.delay) || 0)));
  if (!METHOD_IDS.includes(settings.method)) settings.method = DEFAULT_SETTINGS.method;
  if (!SHAPES.includes(settings.shape)) settings.shape = 'rect';
  settings.panelCount = Math.max(1, Math.min(3, Math.round(Number(settings.panelCount) || 1)));
  // 0 = automatic (per model and device), -1 = the whole selection; otherwise the largest region side in px.
  settings.aiMaxSize = settings.aiMaxSize === -1 ? -1 : Math.max(0, Math.min(1536, Math.round(Number(settings.aiMaxSize) || 0)));
  // NIS is GPU-only.
  // GPU-only methods fall back on the CPU (keep in sync with `fallback` in public/js/methods.js).
  if (settings.aiDevice !== 'gpu' && GPU_ONLY[settings.method]) settings.method = GPU_ONLY[settings.method];
  if (settings.theme !== 'light' && settings.theme !== 'dark') settings.theme = 'dark';
  if (typeof settings.lastSaveDir !== 'string') settings.lastSaveDir = '';
  if (!Array.isArray(settings.customPaths)) settings.customPaths = [];
  settings.customPaths = settings.customPaths
    .filter((item) => item && typeof item.path === 'string' && item.path.trim())
    .map((item) => ({
      label: String(item.label || path.basename(item.path) || item.path),
      path: path.resolve(item.path)
    }))
    .filter((item, index, list) => list.findIndex((other) => other.path === item.path) === index)
    .slice(0, 12);
}

function saveSettings() {
  try {
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(channel, payload);
      } catch {
        // Window may be closing.
      }
    }
  }
}

// "Always on top" applies to every app window (main, settings, result); selection overlays manage their own level.
function applyAlwaysOnTop() {
  for (const win of [mainWindow, settingsWindow, resultWindow]) {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(settings.alwaysOnTop);
  }
}

function preloadPath() {
  return path.join(__dirname, 'preload.js');
}

function iconPath() {
  const file = path.join(__dirname, '..', 'public', 'assets', 'icon.png');
  return fs.existsSync(file) ? file : undefined;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 330,
    height: 132,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    frame: false,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    title: APP_NAME,
    icon: iconPath(),
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setContentProtection(true);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'public', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  for (const name of ['show', 'hide', 'minimize', 'restore']) mainWindow.on(name, syncRunHotkey);
  mainWindow.on('closed', () => {
    mainWindow = null;
    syncRunHotkey();
    cancelSelection(false, 'cancelled');
    closeLens();
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
    if (resultWindow && !resultWindow.isDestroyed()) resultWindow.destroy();
    resultWindow = null;
  });
}

// Ctrl+Q runs the lens (mode 2) and Ctrl+W runs the capture (mode 1) from anywhere, but only while the main window is
// shown. A minimized, hidden (selection or lens in progress) or closed app does not register them, so the keys keep
// working in other programs then.
const RUN_HOTKEYS = { 'Control+Q': 2, 'Control+W': 1 };
function syncRunHotkey() {
  const active = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();
  for (const [key, mode] of Object.entries(RUN_HOTKEYS)) {
    if (!active) {
      globalShortcut.unregister(key);
      continue;
    }
    if (globalShortcut.isRegistered(key)) continue;
    try {
      // The main window's page starts the run, so the countdown and the busy state work as for a click.
      globalShortcut.register(key, () => {
        if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) return;
        if (settings.mode !== mode) applySettingsPatch({ mode });
        mainWindow.webContents.send('hotkey:run');
      });
    } catch {
      // Another program owns the key: the button still works.
    }
  }
}

// Content height of the settings window: title bar plus 11 rows.
const SETTINGS_HEIGHT = 568;
function toggleSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
    return;
  }
  const bounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : { x: 100, y: 100, width: 330, height: 160 };
  // Below the main window; when that would leave the work area, open above it instead (and keep x on screen).
  const work = screen.getDisplayMatching(bounds).workArea;
  const below = bounds.y + bounds.height + 8;
  const settingsY = below + SETTINGS_HEIGHT <= work.y + work.height ? below : Math.max(work.y, bounds.y - SETTINGS_HEIGHT - 8);
  const settingsX = Math.max(work.x, Math.min(bounds.x, work.x + work.width - 330));
  settingsWindow = new BrowserWindow({
    x: settingsX,
    y: settingsY,
    width: 330,
    height: SETTINGS_HEIGHT,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    frame: false,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    title: `${APP_NAME} 설정`,
    icon: iconPath(),
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  settingsWindow.setContentProtection(true);
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, '..', 'public', 'settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false
      });
      let source = sources.find((item) => item.display_id === String(pendingCaptureDisplayId));
      if (!source) source = sources[0];
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source, audio: false });
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });
}

function applySettingsPatch(patch) {
  if (!patch || typeof patch !== 'object') return { ...settings };
  if ('alwaysOnTop' in patch) settings.alwaysOnTop = !!patch.alwaysOnTop;
  if ('mode' in patch) settings.mode = patch.mode === 2 ? 2 : 1;
  if ('lensSize' in patch) settings.lensSize = patch.lensSize;
  if ('lensStyle' in patch) settings.lensStyle = patch.lensStyle;
  if ('lensMaxScale' in patch) settings.lensMaxScale = patch.lensMaxScale;
  if ('freeze' in patch) settings.freeze = !!patch.freeze;
  if ('aiDevice' in patch) settings.aiDevice = patch.aiDevice === 'gpu' ? 'gpu' : 'cpu';
  if ('delay' in patch) settings.delay = Math.max(0, Math.min(10, Math.round(Number(patch.delay) || 0)));
  if ('method' in patch && METHOD_IDS.includes(patch.method)) settings.method = patch.method;
  if ('aiMaxSize' in patch) settings.aiMaxSize = Number(patch.aiMaxSize) || 0;
  if ('panelCount' in patch) settings.panelCount = Math.max(1, Math.min(3, Math.round(Number(patch.panelCount) || 1)));
  if ('theme' in patch && (patch.theme === 'dark' || patch.theme === 'light')) settings.theme = patch.theme;
  if ('shape' in patch && SHAPES.includes(patch.shape)) settings.shape = patch.shape;
  if ('lastSaveDir' in patch && typeof patch.lastSaveDir === 'string') settings.lastSaveDir = patch.lastSaveDir;
  if ('customPaths' in patch && Array.isArray(patch.customPaths)) settings.customPaths = patch.customPaths;
  validateSettings();
  saveSettings();
  applyAlwaysOnTop();
  const snapshot = { ...settings, customPaths: [...settings.customPaths] };
  broadcast('settings:changed', snapshot);
  return snapshot;
}

// Windows only ever show our own local pages: no navigation, no new windows.
function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

function reportError(message) {
  sendMain('lens:error', message);
}

// Capture every display once and show each one frozen in its own full-display window.
async function startLens() {
  try {
    return await openLens();
  } catch (error) {
    console.error('Lens failed:', error);
    closeLens();
    finishLens();
    reportError(`돋보기를 시작하지 못했습니다: ${error.message}`);
    return { ok: false };
  }
}

// Esc closes the lens, except while the save dialog is open: then it only closes the dialog.
function onEscape() {
  if (lensModalOpen) {
    for (const win of lensWindows) if (!win.isDestroyed()) win.webContents.send('lens:escape');
    return;
  }
  closeLens();
}

function closeLens() {
  lensModalOpen = false;
  for (const win of lensWindows) if (!win.isDestroyed()) win.destroy();
  lensWindows = [];
}

async function openLens() {
  if (lensWindows.length) return { ok: false };
  lensSettingsWasOpen = !!(settingsWindow && !settingsWindow.isDestroyed());
  if (lensSettingsWasOpen) settingsWindow.close();
  mainWindow.hide();
  // Let the countdown run and the main window disappear before grabbing pixels.
  await new Promise((resolve) => setTimeout(resolve, settings.delay * 1000 + 250));

  const cursor = screen.getCursorScreenPoint();
  const cursorDisplay = screen.getDisplayNearestPoint(cursor);
  const shots = [];
  const live = !settings.freeze;
  const displays = screen.getAllDisplays();
  for (const [index, display] of displays.entries()) {
    const physical = { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) };
    // Frozen: grab one full-size picture. Live: only the source id is needed, the window streams the screen itself.
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: live ? { width: 1, height: 1 } : physical });
    // display_id can be empty on some capture backends: fall back to the same position in the list.
    const source = sources.find((src) => src.display_id === String(display.id)) || (sources.length === displays.length ? sources[index] : null);
    // PNG bytes go over IPC as they are (a data URL would add a base64 copy of every screen).
    if (source) shots.push({ display, image: live ? null : source.thumbnail.toPNG(), sourceId: source.id, physical });
  }
  if (!shots.length) {
    finishLens();
    reportError('화면을 가져오지 못했습니다. 화면 캡처 권한과 모니터 연결을 확인해 주세요.');
    return { ok: false };
  }

  try { globalShortcut.register('Escape', onEscape); } catch { /* the in-window handlers still work */ }
  let remaining = shots.length;
  for (const { display, image, sourceId, physical } of shots) {
    const { x, y, width, height } = display.bounds;
    const win = new BrowserWindow({
      x, y, width, height,
      frame: false,
      show: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      backgroundColor: '#000000',
      icon: iconPath(),
      webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: false }
    });
    lensWindows.push(win);
    // A live lens streams the screen, so its own window must be left out of the capture.
    if (live) win.setContentProtection(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    hardenWindow(win);
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, '..', 'public', 'lens.html'));
    const here = display.id === cursorDisplay.id;
    let shown = false;
    const reveal = () => {
      if (shown || win.isDestroyed()) return;
      shown = true;
      // Windows may clamp frameless windows to the work area; force the exact display bounds.
      win.setBounds(display.bounds);
      win.show();
      if (here) win.focus();
    };
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('lens:init', {
        image,
        live,
        sourceId,
        physical,
        shape: settings.shape === 'free' ? 'rect' : settings.shape, // the lens has no free shape
        sizePercent: settings.lensSize,
        lensMaxScale: settings.lensMaxScale,
        lensStyle: settings.lensStyle,
        method: settings.method,
        aiMaxSize: settings.aiMaxSize,
        aiDevice: settings.aiDevice,
        // Only the display holding the cursor starts with a visible lens.
        cursor: here ? { x: cursor.x - x, y: cursor.y - y } : null
      });
      setTimeout(reveal, 4000);
    });
    win.webContents.ipc.once('lens:ready', reveal);
    // Esc must work even when the window never got keyboard focus.
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') onEscape();
    });
    win.on('closed', () => {
      // Closing one lens window (Esc / right click) closes them all, then the main window returns.
      if (--remaining === 0) {
        lensWindows = [];
        finishLens();
      } else {
        closeLens();
      }
    });
  }
  return { ok: true };
}

function finishLens() {
  globalShortcut.unregister('Escape');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.webContents.send('selection:done');
    if (lensSettingsWasOpen) toggleSettingsWindow();
  }
  lensSettingsWasOpen = false;
}

function setupIpc() {
  ipcMain.handle('settings:get', () => ({ ...settings, customPaths: [...settings.customPaths] }));

  ipcMain.handle('settings:set', (event, patch) => applySettingsPatch(patch));
  ipcMain.on('settings:toggleWindow', toggleSettingsWindow);

  ipcMain.on('lens:close', closeLens);
  ipcMain.on('lens:modal', (event, open) => {
    lensModalOpen = !!open;
  });
  // A lens window could not get its picture or stream: close everything and tell the main window why.
  ipcMain.on('lens:fail', (event, message) => {
    closeLens();
    reportError(String(message).slice(0, 200));
  });

  ipcMain.on('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.minimize();
  });

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.isMaximized() ? win.unmaximize() : win.maximize();
  });

  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.handle('selection:start', async (event, payload) => {
    if (settings.mode === 2) return startLens();
    const shape = payload && SHAPES.includes(payload.shape) ? payload.shape : 'rect';
    return startSelection(shape);
  });

  ipcMain.on('selection:cancel', () => {
    if (selection.active) cancelSelection(true, 'cancelled');
  });

  ipcMain.on('selection:done', () => {
    if (resultWindow && !resultWindow.isDestroyed()) resultWindow.focus();
  });

  ipcMain.on('overlay:select', (event, payload) => {
    handleOverlaySelect(event, payload);
  });

  ipcMain.on('overlay:cancel', () => {
    if (selection.active) cancelSelection(true, 'cancelled');
  });

  ipcMain.handle('fs:presets', () => buildPresets());

  ipcMain.handle('fs:listDir', async (event, payload) => {
    const target = payload && payload.dir ? payload.dir : app.getPath('pictures');
    try {
      const dir = path.resolve(target);
      const stat = await fs.promises.stat(dir);
      if (!stat.isDirectory()) return { ok: false, error: '폴더가 아닙니다.' };
      const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
      const entries = dirents
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => ({
          name: entry.name,
          path: path.join(dir, entry.name),
          type: entry.isDirectory() ? 'dir' : 'file'
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' });
        })
        .slice(0, 601);
      const parent = path.dirname(dir);
      return {
        ok: true,
        dir,
        parent: parent === dir ? null : parent,
        entries
      };
    } catch (error) {
      return { ok: false, error: error.message || '폴더를 읽을 수 없습니다.' };
    }
  });

  ipcMain.handle('fs:mkdir', async (event, payload) => {
    try {
      const dir = payload && payload.dir;
      const name = payload && String(payload.name || '').trim();
      if (!dir || !name) return { ok: false, error: '폴더 이름을 입력하세요.' };
      if (/[\\/:*?"<>|]/.test(name)) return { ok: false, error: '사용할 수 없는 문자가 있습니다.' };
      const target = path.join(dir, name);
      await fs.promises.mkdir(target, { recursive: false });
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, error: error.message || '폴더를 만들 수 없습니다.' };
    }
  });

  ipcMain.handle('fs:savePng', async (event, payload) => {
    try {
      if (!payload || !payload.dir) return { ok: false, error: '저장 폴더가 없습니다.' };
      let name = String(payload.name || '').trim();
      if (!name) return { ok: false, error: '파일 이름을 입력하세요.' };
      name = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.png$/i, '').replace(/[. ]+$/, '');
      if (!name) return { ok: false, error: '사용할 수 없는 파일 이름입니다.' };
      // Windows device names (CON, NUL, COM1...) cannot be files, with or without an extension.
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = `${name}_`;
      const dir = path.resolve(payload.dir);
      const stat = await fs.promises.stat(dir);
      if (!stat.isDirectory()) return { ok: false, error: '저장 폴더가 아닙니다.' };
      const buffer = Buffer.from(new Uint8Array(payload.buffer));
      const base = path.join(dir, name);
      let target = `${base}.png`;
      let index = 1;
      while (fs.existsSync(target)) {
        target = `${base} (${index}).png`;
        index += 1;
      }
      await fs.promises.writeFile(target, buffer);
      settings.lastSaveDir = dir;
      saveSettings();
      broadcast('settings:changed', { ...settings, customPaths: [...settings.customPaths] });
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, error: error.message || '파일을 저장할 수 없습니다.' };
    }
  });

  ipcMain.handle('shell:reveal', (event, target) => {
    try {
      if (target && fs.existsSync(target)) {
        shell.showItemInFolder(target);
        return { ok: true };
      }
      if (target && fs.existsSync(path.dirname(target))) {
        shell.openPath(path.dirname(target));
        return { ok: true };
      }
      return { ok: false };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('ai:info', (event, payload) => {
    const key = payload && AI_MODELS[payload.model] ? payload.model : 'realesrgan';
    const item = AI_MODELS[key];
    let size = 0;
    try {
      size = fs.statSync(path.join(aiModelDir(), item.file)).size;
    } catch {
      // Model file missing: report size 0.
    }
    return { name: item.name, file: item.file, size };
  });

  ipcMain.handle('ai:ensure', async (event, payload) => {
    try {
      ensureAIWorker();
      const id = ++aiSeq;
      return await sendToAI({
        type: 'init',
        id,
        model: (payload && payload.model) || 'realesrgan',
        device: settings.aiDevice
      }, 90000);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('ai:infer', async (event, payload) => {
    try {
      ensureAIWorker();
      if (!payload || !payload.width || !payload.height) throw new Error('AI 입력이 올바르지 않습니다.');
      // The x4 output is 16x the input pixels (4 bytes each): keep it bounded whatever the window asks for.
      if (payload.width * payload.height > AI_MAX_INPUT_PIXELS) throw new Error('AI 입력 영역이 너무 큽니다.');
      const id = ++aiSeq;
      const data = payload.data instanceof ArrayBuffer ? payload.data : payload.data && payload.data.buffer;
      if (!(data instanceof ArrayBuffer)) throw new Error('AI 입력 데이터가 올바르지 않습니다.');
      const message = {
        type: 'infer',
        id,
        width: payload.width,
        height: payload.height,
        data,
        model: payload.model || 'realesrgan',
        device: settings.aiDevice
      };
      return await sendToAI(message, 60000, [data]);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

function buildPresets() {
  const presets = [
    { id: 'desktop', label: '바탕화면', path: app.getPath('desktop') },
    { id: 'documents', label: '문서', path: app.getPath('documents') },
    { id: 'downloads', label: '다운로드', path: app.getPath('downloads') },
    { id: 'pictures', label: '사진', path: app.getPath('pictures') },
    { id: 'home', label: '사용자 폴더', path: app.getPath('home') },
    {
      id: 'app',
      label: '앱 폴더',
      path: app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(__dirname, '..')
    }
  ];
  for (const item of settings.customPaths) {
    presets.push({ id: `custom:${item.path}`, label: item.label, path: item.path, custom: true });
  }
  return presets;
}

function serializeDisplay(display) {
  return {
    id: String(display.id),
    label: display.label || '',
    bounds: { ...display.bounds },
    workArea: { ...display.workArea },
    size: { ...display.size },
    scaleFactor: display.scaleFactor
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cancellableWait(ms) {
  return new Promise((resolve) => {
    selection.waitResolve = resolve;
    selection.waitTimer = setTimeout(() => {
      selection.waitTimer = null;
      selection.waitResolve = null;
      resolve();
    }, ms);
  });
}

function sendMain(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function startSelection(shape) {
  if (selection.active) cancelSelection(false, 'cancelled');
  if (resultWindow && !resultWindow.isDestroyed()) {
    resultWindow.destroy();
    resultWindow = null;
  }
  pendingCaptureDisplayId = null;
  selection.active = true;
  selection.shape = shape;

  const delay = settings.delay;
  sendMain('selection:starting', { delay, shape });

  for (let remaining = delay; remaining > 0; remaining -= 1) {
    sendMain('selection:countdown', { remaining });
    await cancellableWait(1000);
    if (!selection.active) return { ok: false, cancelled: true };
  }

  if (delay === 0) sendMain('selection:countdown', { remaining: 0 });

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  settingsWasOpen = !!(settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible());
  if (settingsWasOpen) settingsWindow.hide();
  await wait(140);
  if (!selection.active) {
    showMainWindow();
    return { ok: false, cancelled: true };
  }

  let freezeMap = {};
  freezeImages = {};
  if (settings.freeze) {
    freezeMap = await captureFreezeMap();
  }
  if (!selection.active) {
    showMainWindow();
    return { ok: false, cancelled: true };
  }

  await createOverlays(freezeMap);
  return { ok: true };
}

function showMainWindow() {
  if (settingsWasOpen && settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.show();
  settingsWasOpen = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

function cancelSelection(showMain, reason) {
  if (selection.waitTimer) {
    clearTimeout(selection.waitTimer);
    selection.waitTimer = null;
  }
  if (selection.waitResolve) {
    const resolve = selection.waitResolve;
    selection.waitResolve = null;
    resolve();
  }
  const wasActive = selection.active;
  selection.active = false;
  freezeImages = {};
  closeOverlays();
  if (showMain) showMainWindow();
  if (wasActive) sendMain('selection:done', { reason: reason || 'cancelled' });
}

// Screenshots of the given displays, without the mouse cursor (a display stream always has the cursor in it).
async function grabDisplays(displays) {
  const map = {};
  const sizeOf = (display) => ({
    width: Math.max(1, Math.round(display.size.width * display.scaleFactor)),
    height: Math.max(1, Math.round(display.size.height * display.scaleFactor))
  });
  try {
    // One call for every screen, at the largest display size; each thumbnail is resized to its own display below.
    const sizes = displays.map(sizeOf);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.max(...sizes.map((item) => item.width)), height: Math.max(...sizes.map((item) => item.height)) },
      fetchWindowIcons: false
    });
    displays.forEach((display, index) => {
      const source = sources.find((item) => item.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) return;
      const { width, height } = sizes[index];
      let image = source.thumbnail;
      const size = image.getSize();
      if (size.width !== width || size.height !== height) {
        image = image.resize({ width, height, quality: 'best' });
      }
      map[String(display.id)] = image;
    });
  } catch (error) {
    console.error('Freeze capture failed:', error);
  }
  return map;
}

// The overlays show a JPEG; the full-quality screenshots stay here for the result window.
async function captureFreezeMap() {
  freezeImages = await grabDisplays(screen.getAllDisplays());
  const map = {};
  for (const [id, image] of Object.entries(freezeImages)) map[id] = `data:image/jpeg;base64,${image.toJPEG(92).toString('base64')}`;
  return map;
}

function closeOverlays() {
  const windows = overlayWindows.map((item) => item.win);
  overlayWindows = [];
  for (const win of windows) {
    if (!win.isDestroyed()) {
      try {
        win.destroy();
      } catch {
        // Ignore.
      }
    }
  }
}

async function createOverlays(freezeMap) {
  const displays = screen.getAllDisplays();
  const cursor = screen.getCursorScreenPoint();
  overlayWindows = [];

  const readyList = displays.map((display) => {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      focusable: true,
      backgroundColor: '#00000000',
      title: `${APP_NAME} 선택`,
      icon: iconPath(),
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        sandbox: false
      }
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setContentProtection(true);
    win.setMenuBarVisibility(false);

    const entry = { win, display };
    overlayWindows.push(entry);

    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        cancelSelection(true, 'cancelled');
      }
    });

    const ready = new Promise((resolve) => {
      win.webContents.once('did-finish-load', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });

    win.loadFile(path.join(__dirname, '..', 'public', 'overlay.html'));

    ready.then(() => {
      if (win.isDestroyed()) return;
      win.webContents.send('overlay:init', {
        displayId: String(display.id),
        bounds: display.bounds,
        size: display.size,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        shape: selection.shape,
        freeze: freezeMap[String(display.id)] || null
      });
      win.showInactive();
    });

    return ready;
  });

  await Promise.all(readyList);

  const target = overlayWindows.find((item) => {
    const bounds = item.display.bounds;
    return cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width &&
      cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
  }) || overlayWindows[0];

  if (target && !target.win.isDestroyed() && selection.active) {
    target.win.show();
    target.win.focus();
    target.win.webContents.focus();
  }
}

function handleOverlaySelect(event, payload) {
  if (!selection.active) return;
  const entry = overlayWindows.find((item) => item.win.webContents.id === event.sender.id);
  if (!entry) return;
  if (!payload || !payload.rect) return;

  const display = entry.display;
  let rect = {
    x: Number(payload.rect.x),
    y: Number(payload.rect.y),
    w: Number(payload.rect.w),
    h: Number(payload.rect.h)
  };
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return;

  let polygon = null;
  if (selection.shape === 'free') {
    const points = Array.isArray(payload.polygon) ? payload.polygon : [];
    const valid = points
      .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (valid.length < 3) return;
    const xs = valid.map((point) => point.x);
    const ys = valid.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    if (rect.w < 4 || rect.h < 4) return;
    polygon = valid.map((point) => ({
      x: Math.max(0, Math.min(1, (point.x - rect.x) / rect.w)),
      y: Math.max(0, Math.min(1, (point.y - rect.y) / rect.h))
    }));
  }

  rect.w = Math.min(rect.w, display.size.width - rect.x);
  rect.h = Math.min(rect.h, display.size.height - rect.y);
  if (rect.w < 4 || rect.h < 4) return;

  const selectionPayload = {
    shape: selection.shape,
    rect,
    polygon,
    display: serializeDisplay(display)
  };

  selection.active = false;
  closeOverlays();
  showMainWindow();
  sendMain('selection:done', { reason: 'selected' });
  openResult(selectionPayload);
}

async function findScreenSource(displayId) {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false
    });
    return sources.find((item) => item.display_id === String(displayId)) || sources[0] || null;
  } catch {
    return null;
  }
}

async function openResult(selectionPayload) {
  if (resultWindow && !resultWindow.isDestroyed()) {
    resultWindow.destroy();
    resultWindow = null;
  }

  const display = selectionPayload.display;
  const work = display.workArea;
  const width = Math.max(480, Math.min(1040, work.width - 24));
  const height = Math.max(360, Math.min(760, work.height - 24));
  const rightX = selectionPayload.rect.x + selectionPayload.rect.w + 18 + display.bounds.x;
  const leftX = selectionPayload.rect.x - width - 18 + display.bounds.x;
  let x = rightX + width <= work.x + work.width ? rightX : leftX;
  x = Math.max(work.x + 8, Math.min(x, work.x + work.width - width - 8));
  let y = selectionPayload.rect.y + display.bounds.y - 8;
  y = Math.max(work.y + 8, Math.min(y, work.y + work.height - height - 8));

  pendingCaptureDisplayId = String(display.id);

  resultWindow = new BrowserWindow({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    minWidth: 480,
    minHeight: 360,
    frame: false,
    show: false,
    title: `${APP_NAME} 확대`,
    icon: iconPath(),
    backgroundColor: '#170b2e',
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
            sandbox: false
    }
  });

  resultWindow.setContentProtection(true);
  resultWindow.setMenuBarVisibility(false);
  if (settings.alwaysOnTop) resultWindow.setAlwaysOnTop(true);

  resultWindow.on('closed', () => {
    resultWindow = null;
    pendingCaptureDisplayId = null;
  });

  // The picture the result works on: the frozen screenshot, or a fresh one (after the overlays are gone) when Freeze is off.
  let image = freezeImages[String(display.id)];
  if (!image) {
    await wait(120);
    image = (await grabDisplays(screen.getAllDisplays().filter((item) => String(item.id) === String(display.id))))[String(display.id)];
  }
  freezeImages = {};
  const still = image ? image.toPNG() : null;
  const source = await findScreenSource(display.id);
  const target = resultWindow;
  if (!target || target.isDestroyed()) return;

  target.loadFile(path.join(__dirname, '..', 'public', 'result.html'));
  target.webContents.once('did-finish-load', () => {
    if (!target.isDestroyed()) {
      target.webContents.send('result:init', {
        selection: selectionPayload,
        settings: { ...settings, customPaths: [...settings.customPaths] },
        sourceId: source ? source.id : null,
        still
      });
    }
  });
  target.once('ready-to-show', () => {
    if (!target.isDestroyed()) {
      target.show();
      target.focus();
    }
  });
}

const AI_MODELS = {
  realesrgan: { name: 'Real-ESRGAN-x4v3', file: 'realesr-general-x4v3.onnx' },
  'nomos-span': { name: '4xNomosUni SPAN', file: '4xNomosUni_span_multijpg_fp32_opset17.onnx' },
  'realesrgan-x4plus': { name: 'Real-ESRGAN x4plus', file: 'realesrgan_x4plus.onnx' }
};

function aiModelDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(__dirname, '..', 'models');
}

function ensureAIWorker() {
  if (aiWorker) return;
  aiWorker = new Worker(path.join(__dirname, 'ai-worker.js'), {
    workerData: { modelDir: aiModelDir(), files: Object.fromEntries(Object.entries(AI_MODELS).map(([key, item]) => [key, item.file])) }
  });

  aiWorker.on('message', (message) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'provider') {
      aiProvider = message.provider;
      broadcast('ai:event', { type: 'provider', provider: aiProvider });
      return;
    }

    if (message.id && aiPending.has(message.id)) {
      const pending = aiPending.get(message.id);
      aiPending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === 'error') {
        pending.reject(new Error(message.message || 'AI 처리에 실패했습니다.'));
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (message.type === 'worker-error') {
      broadcast('ai:event', { type: 'error', message: message.message || 'AI 오류' });
    }
  });

  aiWorker.on('error', (error) => {
    broadcast('ai:event', { type: 'error', message: error.message || 'AI 오류' });
  });

  aiWorker.on('exit', () => {
    aiWorker = null;
    aiProvider = null;
    for (const pending of aiPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('AI 워커가 종료되었습니다.'));
    }
    aiPending.clear();
    broadcast('ai:event', { type: 'provider', provider: null });
  });
}

function sendToAI(message, timeoutMs, transferList) {
  return new Promise((resolve, reject) => {
    if (!aiWorker) {
      reject(new Error('AI 워커가 없습니다.'));
      return;
    }
    const timer = setTimeout(() => {
      if (aiPending.has(message.id)) {
        aiPending.delete(message.id);
        reject(new Error('AI 응답 시간 초과'));
        // The worker cannot cancel a running pass: restart it, or its queue would delay every later request.
        // The exit handler tells the windows, which load the model again.
        if (aiWorker) aiWorker.terminate();
      }
    }, timeoutMs);
    aiPending.set(message.id, { resolve, reject, timer });
    try {
      aiWorker.postMessage(message, transferList || []);
    } catch (error) {
      clearTimeout(timer);
      aiPending.delete(message.id);
      reject(error);
    }
  });
}

app.whenReady().then(() => {
  loadSettings();
  setupIpc();
  setupDisplayMediaHandler();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  closeOverlays();
  closeLens();
  if (aiWorker) {
    try {
      aiWorker.terminate();
    } catch {
      // Ignore.
    }
    aiWorker = null;
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
