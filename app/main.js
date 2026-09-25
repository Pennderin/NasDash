const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, shell, session, globalShortcut } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// ─── Single instance ───────────────────────────────────────────────────────
// A second launch (startup shortcut + manual launch) just surfaces the
// existing widget instead of stacking a duplicate on top of it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow = null, tray = null, expandedBounds = null;

const isPacked = app.isPackaged;
const stateDir = isPacked ? app.getPath('userData') : __dirname;

const FILES = {
  bounds:  path.join(stateDir, 'display-bounds.json'),
  state:   path.join(stateDir, 'widget-state.json'),
  opacity: path.join(stateDir, 'opacity.json'),
  cams:    path.join(stateDir, 'cam-windows.json'),
};

const COLLAPSED_H    = 52;
const HOMEPAGE_ORIGIN = 'http://192.168.0.190:3000';
const WHEEL_STEP     = 0.01;
const KEY_STEP       = 0.05;
const DEFAULT_ZOOM   = 0.6;
const DEFAULT_OPACITY = 0.92;

// ─── Persistence ───────────────────────────────────────────────────────────
function readJSON(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
// Atomic write: a crash or power cut mid-write can never leave a truncated
// JSON file behind, because the rename is all-or-nothing.
function writeJSON(f, d) {
  const tmp = `${f}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, f);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

const state = readJSON(FILES.state) || { locked: false };
const saveState = () => writeJSON(FILES.state, state);

let opacity = (() => {
  const o = readJSON(FILES.opacity);
  return (o && typeof o.value === 'number') ? o.value : DEFAULT_OPACITY;
})();

let currentZoom = DEFAULT_ZOOM;
let currentFingerprint = null;
let webviewContents = null;
let injectedCssKey = null;
let retryTimer = null, retryDelay = 2000;

// ─── Display fingerprint ───────────────────────────────────────────────────
// Primary display only: label (from EDID, stable across boots), resolution
// and DPI scale. Display.id is reassigned every boot on Windows, so it can't
// be used here.
function getDisplayFingerprint() {
  const p = screen.getPrimaryDisplay();
  const sig = `${p.label || 'unknown'}|${p.size.width}x${p.size.height}|s${p.scaleFactor}`;
  return crypto.createHash('md5').update(sig).digest('hex').substring(0, 10);
}

function getDefaultBounds() {
  const { width: sW, height: sH } = screen.getPrimaryDisplay().workAreaSize;
  return { width: 800, height: sH - 40, x: sW - 815, y: 20 };
}

function getSavedEntry() {
  currentFingerprint = getDisplayFingerprint();
  return (readJSON(FILES.bounds) || {})[currentFingerprint] || null;
}

function saveLayoutManual() {
  if (!alive(mainWindow)) return false;
  const b = mainWindow.getBounds();
  if (b.height <= COLLAPSED_H + 20) return false;
  const all = readJSON(FILES.bounds) || {};
  currentFingerprint = getDisplayFingerprint();
  all[currentFingerprint] = { x: b.x, y: b.y, width: b.width, height: b.height, zoom: currentZoom };
  writeJSON(FILES.bounds, all);
  return true;
}

function clampBoundsToDisplays(b) {
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const d = screen.getAllDisplays().find(({ bounds: db }) =>
    cx >= db.x && cx < db.x + db.width && cy >= db.y && cy < db.y + db.height
  ) || screen.getPrimaryDisplay();
  const wa = d.workArea;
  return {
    x: Math.max(wa.x, Math.min(b.x, wa.x + wa.width  - b.width)),
    y: Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height)),
    width:  Math.min(b.width,  wa.width),
    height: Math.min(b.height, wa.height),
  };
}

function restoreEntryForCurrentLayout() {
  if (!alive(mainWindow)) return;
  const saved = getSavedEntry();
  if (!saved) return; // unknown layout: leave window and zoom as-is
  mainWindow.setBounds(clampBoundsToDisplays(saved));
  if (typeof saved.zoom === 'number') applyZoom(saved.zoom);
}

// ─── Helpers ───────────────────────────────────────────────────────────────
const alive = w => w && !w.isDestroyed();

function send(channel, ...args) {
  if (alive(mainWindow)) mainWindow.webContents.send(channel, ...args);
}

function applyZoom(factor) {
  const f = Math.max(0.25, Math.min(3.0, Math.round(factor * 100) / 100));
  currentZoom = f;
  if (alive(webviewContents)) { try { webviewContents.setZoomFactor(f); } catch {} }
  send('zoom-updated', f);
  return f;
}

// Ctrl + = / - / 0 — shared by the host page and the webview.
function handleZoomKeys(e, input) {
  if (input.type !== 'keyDown' || !input.control) return;
  const k = input.key;
  if (k === '=' || k === '+')      { e.preventDefault(); applyZoom(currentZoom + KEY_STEP); }
  else if (k === '-' || k === '_') { e.preventDefault(); applyZoom(currentZoom - KEY_STEP); }
  else if (k === '0')              { e.preventDefault(); applyZoom(1.0); }
}

function isInternalUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url), t = new URL(HOMEPAGE_ORIGIN);
    return u.protocol === t.protocol && u.hostname === t.hostname &&
           (u.port || '80') === (t.port || '80');
  } catch { return false; }
}

// Transparency lives here (NasDash only) rather than in Homepage's
// custom.css, so Homepage keeps its normal background in a regular browser.
const TRANSPARENCY_CSS = `
  html, body, #__next, #page_wrapper, #inner_wrapper {
    background: transparent !important;
    background-color: transparent !important;
  }
  #inner_wrapper {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
`;

async function applyWebviewTransparencyCss() {
  if (!alive(webviewContents)) return;
  try {
    if (injectedCssKey) { try { await webviewContents.removeInsertedCSS(injectedCssKey); } catch {} }
    injectedCssKey = await webviewContents.insertCSS(TRANSPARENCY_CSS);
  } catch {}
}

// ─── Window ────────────────────────────────────────────────────────────────
function createWindow() {
  const entry = getSavedEntry();
  if (entry && typeof entry.zoom === 'number') currentZoom = Math.max(0.25, Math.min(3.0, entry.zoom));

  mainWindow = new BrowserWindow({
    ...(entry ? clampBoundsToDisplays(entry) : getDefaultBounds()),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: false,
    focusable: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Lock the embedded webview down: no preload, no node, and it may only
  // ever be created pointing at Homepage.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    if (!isInternalUrl(params.src)) { event.preventDefault(); return; }
    params.backgroundColor = '#00000000';
  });

  mainWindow.webContents.on('did-attach-webview', (event, contents) => {
    webviewContents = contents;
    try { contents.setBackgroundColor('#00000000'); } catch {}

    // dom-ready fires before first paint of content → no opaque flash.
    contents.on('dom-ready', () => {
      try { contents.setZoomFactor(currentZoom); } catch {}
      applyWebviewTransparencyCss();
    });

    contents.on('did-finish-load', () => { retryDelay = 2000; });

    // NAS not reachable yet (e.g. PC booted first) → retry with backoff
    // instead of sitting on an error page until a manual reload.
    contents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 /* ABORTED */) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (alive(contents)) contents.loadURL(HOMEPAGE_ORIGIN).catch(() => {});
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    });

    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(BRIDGE_ORIGIN + '/cams')) { openCamWindow(url); return { action: 'deny' }; }
      if (!isInternalUrl(url)) shell.openExternal(url).catch(() => {});
      else contents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });

    contents.on('will-navigate', (e, url) => {
      if (!isInternalUrl(url)) { e.preventDefault(); shell.openExternal(url).catch(() => {}); }
    });

    contents.on('did-navigate', (e, url) => {
      if (!isInternalUrl(url)) contents.loadURL(HOMEPAGE_ORIGIN).catch(() => {});
    });

    contents.on('zoom-changed', (e, dir) => applyZoom(currentZoom + (dir === 'in' ? WHEEL_STEP : -WHEEL_STEP)));
    contents.on('before-input-event', handleZoomKeys);
  });

  mainWindow.webContents.on('before-input-event', handleZoomKeys);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternalUrl(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null; webviewContents = null; injectedCssKey = null;
    clearTimeout(retryTimer);
  });
}

function showWindow() {
  if (!alive(mainWindow)) createWindow();
  mainWindow.show();
}
function toggleWindow() {
  if (peeking) { peekWasHidden = true; setPeek(false); return; }
  if (alive(mainWindow) && mainWindow.isVisible()) mainWindow.hide();
  else showWindow();
}

// ─── Peek hotkey ───────────────────────────────────────────────────────────
// Press once: NasDash jumps above everything, including borderless-fullscreen
// apps, and takes focus. Press again: it drops back to a normal window and
// focus returns to whatever you were in, so it ends up behind it again.
// (True exclusive-fullscreen games can't be overlaid by any normal window.)
// Override the key by adding "peekHotkey": "<Electron accelerator>" to
// widget-state.json, e.g. "Control+Shift+F12".
const DEFAULT_PEEK_HOTKEY = 'Control+Alt+D';
let peeking = false, peekWasHidden = false, peekHotkey = null, peekPrevHwnd = null;

// winfocus.exe: remembers the window you were in and hands focus back to it
// exactly. Built from winfocus.cs with the in-box .NET Framework compiler
// the first time it's needed (same approach as coms.js / audiodev.exe).
const winfocus = (() => {
  const { spawn, execFileSync } = require('child_process');
  const EXE = path.join(__dirname, 'winfocus.exe');
  const SRC = path.join(__dirname, 'winfocus.cs');
  const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  let proc = null, buf = '', waiters = [];
  function ensure() {
    if (proc) return true;
    if (!fs.existsSync(EXE) && fs.existsSync(SRC) && fs.existsSync(CSC)) {
      try { execFileSync(CSC, ['/nologo', '/target:exe', '/platform:x64', '/out:' + EXE, SRC], { windowsHide: true }); }
      catch (e) { console.error('winfocus build failed:', e.message); }
    }
    if (!fs.existsSync(EXE)) return false;
    proc = spawn(EXE, [], { windowsHide: true });
    proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const lineOut = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const w = waiters.shift(); if (w) w(lineOut);
      }
    });
    const reset = () => { proc = null; buf = ''; waiters.splice(0).forEach(w => w(null)); };
    proc.on('exit', reset); proc.on('error', reset);
    return true;
  }
  function ask(cmd) {
    return new Promise(res => {
      if (!ensure()) return res(null);
      const t = setTimeout(() => { const k = waiters.indexOf(done); if (k >= 0) waiters.splice(k, 1); res(null); }, 400);
      const done = v => { clearTimeout(t); res(v); };
      waiters.push(done);
      try { proc.stdin.write(cmd + '\n'); } catch { done(null); }
    });
  }
  return {
    warm: ensure,
    getForeground: () => ask('get'),
    focus: h => ask('set ' + h),
    stop: () => { try { proc?.kill(); } catch {} },
  };
})();

const ownHwnd = () => {
  try { return mainWindow.getNativeWindowHandle().readBigUInt64LE(0).toString(); } catch { return null; }
};

async function setPeek(on) {
  if (!alive(mainWindow)) createWindow();
  if (on) {
    const fg = await winfocus.getForeground();
    peekPrevHwnd = (fg && fg !== '0' && fg !== ownHwnd()) ? fg : null;
    peekWasHidden = !mainWindow.isVisible();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
    peeking = true;
  } else {
    peeking = false;
    mainWindow.setAlwaysOnTop(false);
    if (peekWasHidden) mainWindow.hide();
    // Hand focus back to the exact window you were in, which also brings it
    // back in front of the dash. Fall back to blur() (next window down).
    const res = peekPrevHwnd ? await winfocus.focus(peekPrevHwnd) : null;
    if (res !== 'ok' && !peekWasHidden && alive(mainWindow)) mainWindow.blur();
    peekPrevHwnd = null;
  }
  refreshTrayMenu();
}
let peekBusy = false;
const togglePeek = async () => {
  if (peekBusy) return;            // ignore key-repeat while a toggle is in flight
  peekBusy = true;
  try { await setPeek(!peeking); } finally { peekBusy = false; }
};

function registerPeekHotkey() {
  const key = (typeof state.peekHotkey === 'string' && state.peekHotkey) || DEFAULT_PEEK_HOTKEY;
  try {
    if (globalShortcut.register(key, togglePeek)) { peekHotkey = key; winfocus.warm(); }
    else console.error(`peek hotkey ${key} is already taken by another app`);
  } catch (e) { console.error(`peek hotkey ${key} invalid:`, e.message); }
}

function refreshTrayMenu() {
  if (!tray) return;
  const peekLabel = peekHotkey
    ? `Peek on top (${peekHotkey.replace(/Control/g, 'Ctrl')})`
    : 'Peek on top (hotkey unavailable)';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show/Hide', click: toggleWindow },
    { label: peekLabel, type: 'checkbox', checked: peeking, click: togglePeek },
    { label: 'Reload',    click: () => { showWindow(); send('reload-webview'); } },
    { type: 'separator' },
    { label: 'Quit',      click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png')));
  tray.setToolTip('NasDash (Homepage)');
  refreshTrayMenu();
  tray.on('click', toggleWindow);
}

// Display changes only ever RESTORE saved layouts, never save.
function watchDisplays() {
  let t = null;
  const onChange = () => { clearTimeout(t); t = setTimeout(restoreEntryForCurrentLayout, 250); };
  screen.on('display-added', onChange);
  screen.on('display-removed', onChange);
  screen.on('display-metrics-changed', onChange);
}

// ─── IPC ───────────────────────────────────────────────────────────────────
ipcMain.on('resize', (ev, edge, dx, dy) => {
  if (!alive(mainWindow) || state.locked) return;
  const b = mainWindow.getBounds(), minW = 320, minH = 52;
  const apply = {
    top:    () => { if (b.height - dy >= minH) { b.y += dy; b.height -= dy; } },
    bottom: () => { if (b.height + dy >= minH) b.height += dy; },
    left:   () => { if (b.width - dx >= minW) { b.x += dx; b.width -= dx; } },
    right:  () => { if (b.width + dx >= minW) b.width += dx; },
  };
  for (const part of edge.split('-')) apply[part]?.();
  mainWindow.setBounds(b);
});

ipcMain.handle('save-layout', () => ({ ok: saveLayoutManual(), fingerprint: currentFingerprint, zoom: currentZoom }));

ipcMain.on('collapse-widget', () => {
  if (!alive(mainWindow)) return;
  const b = mainWindow.getBounds();
  expandedBounds = b;
  mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: COLLAPSED_H });
});
ipcMain.on('expand-widget', () => {
  if (!alive(mainWindow)) return;
  const c = mainWindow.getBounds();
  const h = expandedBounds ? expandedBounds.height : screen.getPrimaryDisplay().workAreaSize.height - 40;
  const w = expandedBounds ? expandedBounds.width : c.width;
  mainWindow.setBounds({ x: c.x, y: c.y, width: w, height: h });
  expandedBounds = null;
});

// ✕ hides to tray instead of destroying the window. (Previously it destroyed
// it, and tray Show/Hide then did nothing until the app was relaunched.)
ipcMain.on('hide-window', () => {
  if (!alive(mainWindow)) return;
  if (peeking) { peekWasHidden = true; setPeek(false); } else mainWindow.hide();
});

ipcMain.on('toggle-lock', () => {
  state.locked = !state.locked;
  saveState();
  send('lock-state', state.locked);
});
ipcMain.handle('get-lock-state', () => state.locked);

ipcMain.on('toggle-desktop-icons', () => {
  const { execFile } = require('child_process');
  execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'toggle-desktop.ps1')],
    { windowsHide: true, timeout: 5000 }, () => {});
});

ipcMain.handle('get-zoom', () => currentZoom);
ipcMain.on('zoom-reset', () => applyZoom(1.0));

ipcMain.handle('get-opacity', () => opacity);
// Renderer updates the look live while dragging and only sends this once
// the slider is released, so there's one disk write per adjustment.
ipcMain.on('save-opacity', (ev, value) => {
  opacity = Math.max(0.20, Math.min(1.0, Math.round(value * 100) / 100));
  writeJSON(FILES.opacity, { value: opacity });
});

// ─── Spotify OAuth loopback ────────────────────────────────────────────────
// Spotify only accepts https or 127.0.0.1 redirect URIs, so the login
// redirect has to land on this PC. This tiny listener catches it and forwards
// the code to media-bridge on the NAS, which does the token exchange and
// keeps the refresh token. Bound to 127.0.0.1 only — not reachable from LAN.
const BRIDGE_ORIGIN = 'http://192.168.0.190:7792';
// ─── Security camera windows ────────────────────────────────────────────────
// Camera views from the dashboard's Security card open as real windows (not
// browser tabs) so they can be dragged to another monitor. One window per view
// (a single camera, or the grid); each remembers where it was left.
const camWindows = new Map();
function openCamWindow(url) {
  let key = 'grid';
  try { key = new URL(url).searchParams.get('src') || 'grid'; } catch {}
  const existing = camWindows.get(key);
  if (alive(existing)) { if (existing.isMinimized()) existing.restore(); existing.show(); existing.focus(); return; }
  const saved = (readJSON(FILES.cams) || {})[key];
  const w = new BrowserWindow({
    ...(saved ? clampBoundsToDisplays(saved) : { width: key === 'grid' ? 1280 : 960, height: key === 'grid' ? 760 : 560 }),
    title: 'NasDash Security',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'tray-icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  w.setMenuBarVisibility(false);
  if (saved && saved.maximized) w.maximize();
  // Locked to the camera viewer: no popups, no navigating elsewhere.
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(BRIDGE_ORIGIN + '/cams')) e.preventDefault(); });
  w.on('close', () => {
    const all = readJSON(FILES.cams) || {};
    all[key] = { ...w.getNormalBounds(), maximized: w.isMaximized() };
    writeJSON(FILES.cams, all);
  });
  w.on('closed', () => camWindows.delete(key));
  camWindows.set(key, w);
  w.loadURL(url).catch(() => {});
}

function startOAuthLoopback() {
  const http = require('http');
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1:8888');
    if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
    try {
      const r = await fetch(`${BRIDGE_ORIGIN}/spotify/callback${u.search}`);
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'text/html' });
      res.end(await r.text());
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Could not reach media-bridge on the NAS: ' + e.message);
    }
  });
  srv.on('error', e => console.error('OAuth loopback listener failed:', e.message));
  srv.listen(8888, '127.0.0.1');
}

// ─── App lifecycle ─────────────────────────────────────────────────────────
app.on('second-instance', showWindow);

// Homepage serves custom.js / custom.css without Cache-Control, so Chromium
// heuristically caches them and can keep running a stale copy after they're
// edited. Force revalidation (cheap 304s) on every load.
function forceFreshConfigAssets() {
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [`${HOMEPAGE_ORIGIN}/api/config/*`] },
    (details, cb) => {
      const h = { ...details.responseHeaders };
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'cache-control') delete h[k];
      h['Cache-Control'] = ['no-cache'];
      cb({ responseHeaders: h });
    }
  );
}

app.whenReady().then(() => {
  forceFreshConfigAssets();
  createWindow();
  registerPeekHotkey();
  createTray();
  watchDisplays();
  startOAuthLoopback();
  // Coms card: Windows default-device guard + Wave Link mic control (loopback API :8889)
  try { coms = require('./coms').start({ stateDir, origin: HOMEPAGE_ORIGIN, log: s => console.log(s) }); } catch (e) { console.error('coms failed:', e.message); }
});

// Keep running in the tray when the window is gone.
let coms = null;
app.on('will-quit', () => { try { coms?.stop(); } catch {} globalShortcut.unregisterAll(); winfocus.stop(); });
app.on('window-all-closed', e => e.preventDefault());
