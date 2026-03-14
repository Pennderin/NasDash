const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');

let mainWindow, tray, expandedBounds = null;

// In dev: __dirname. In built exe: app.getPath('userData') for writable state
const isPacked = app.isPackaged;
const stateDir = isPacked ? app.getPath('userData') : __dirname;
const resDir = isPacked ? process.resourcesPath : __dirname;

const FILES = {
  speed:    path.join(stateDir, 'speedtest-results.json'),
  exe:      path.join(resDir, 'speedtest.exe'),
  services: path.join(stateDir, 'services-config.json'),
  bounds:   path.join(stateDir, 'window-bounds.json'),
  ratios:   path.join(stateDir, 'card-ratios.json'),
  state:    path.join(stateDir, 'widget-state.json'),
};
const SIX_HOURS = 6 * 60 * 60 * 1000;
const COLLAPSED_H = 52;

function readJSON(f) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e){} return null; }
function writeJSON(f, d) { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch(e){} }

function loadState() { return readJSON(FILES.state) || { locked: false }; }
function saveState(s) { writeJSON(FILES.state, s); }

let state = loadState();

function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getBounds();
  if (b.height > COLLAPSED_H + 20) writeJSON(FILES.bounds, b);
}

function createWindow() {
  const { width: sW, height: sH } = screen.getPrimaryDisplay().workAreaSize;
  const saved = readJSON(FILES.bounds);
  const bounds = saved || { width: 360, height: sH - 40, x: sW - 375, y: 20 };

  mainWindow = new BrowserWindow({
    ...bounds, frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, hasShadow: false,
    minimizable: false, maximizable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mainWindow.loadFile('index.html');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.on('moved', saveBounds);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  const icon = nativeImage.createFromBuffer(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAARElEQVQ4y2P4z8BQz0BPAMNA' +
    'YGBg+M9AT8DAQDcXDKgL6OeCARUNGHUBXV0wFAwgGwAAAAD//wMAAAD//wMAAAD//wMA/wCq' +
    'w1QAAAAASUVORK5CYII=', 'base64'));
  tray = new Tray(icon);
  tray.setToolTip('Unraid NAS Widget');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show/Hide', click: () => mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show() },
    { label: 'Run Speed Test', click: () => runSpeedTest() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', () => mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show());
}

// ─── Resize ───
ipcMain.on('resize', (ev, edge, dx, dy) => {
  if (!mainWindow || state.locked) return;
  const b = mainWindow.getBounds(), minW = 280, minH = 52;
  const apply = { top: () => { if (b.height-dy>=minH){b.y+=dy;b.height-=dy;} },
    bottom: () => { if (b.height+dy>=minH) b.height+=dy; },
    left: () => { if (b.width-dx>=minW){b.x+=dx;b.width-=dx;} },
    right: () => { if (b.width+dx>=minW) b.width+=dx; } };
  for (const part of edge.split('-')) if (apply[part]) apply[part]();
  mainWindow.setBounds(b);
});
ipcMain.on('resize-done', () => saveBounds());

// ─── Collapse ───
ipcMain.on('collapse-widget', () => {
  if (!mainWindow) return;
  expandedBounds = mainWindow.getBounds();
  const b = mainWindow.getBounds();
  mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: COLLAPSED_H });
});
ipcMain.on('expand-widget', () => {
  if (!mainWindow) return;
  if (expandedBounds) {
    const c = mainWindow.getBounds();
    mainWindow.setBounds({ x: c.x, y: c.y, width: expandedBounds.width, height: expandedBounds.height });
    expandedBounds = null;
  } else {
    const { height: sH } = screen.getPrimaryDisplay().workAreaSize;
    const b = mainWindow.getBounds();
    mainWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: sH - 40 });
  }
});

// ─── Lock ───
ipcMain.on('toggle-lock', () => {
  state.locked = !state.locked;
  saveState(state);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lock-state', state.locked);
});
ipcMain.handle('get-lock-state', () => state.locked);

// ─── Card ratios ───
ipcMain.handle('load-ratios', () => readJSON(FILES.ratios));
ipcMain.on('save-ratios', (ev, d) => writeJSON(FILES.ratios, d));

// ─── Services ───
ipcMain.handle('load-services', () => readJSON(FILES.services));
ipcMain.on('save-services', (ev, d) => writeJSON(FILES.services, d));

// ─── Speed ───
ipcMain.on('open-url', (ev, url) => { if (url) shell.openExternal(url); });
ipcMain.on('run-speedtest', () => runSpeedTest());
ipcMain.handle('get-cached-speed', () => readJSON(FILES.speed));

function runSpeedTest() {
  if (!fs.existsSync(FILES.exe)) { send('speedtest-results', { error: 'not found' }); return; }
  send('speedtest-results', { running: true });
  execFile(FILES.exe, ['--accept-license','--accept-gdpr','-f','json'], { timeout: 120000 }, (err, out) => {
    if (err) { send('speedtest-results', { error: err.message }); return; }
    try {
      const d = JSON.parse(out);
      const r = {
        download: Math.round(d.download.bandwidth*8/1e6*100)/100,
        upload: Math.round(d.upload.bandwidth*8/1e6*100)/100,
        ping: Math.round(d.ping.latency*100)/100,
        server: d.server?.name||'', timestamp: new Date().toISOString(),
      };
      writeJSON(FILES.speed, r);
      send('speedtest-results', r);
    } catch(e) { send('speedtest-results', { error: 'parse' }); }
  });
}
function send(ch, d) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, d); }

app.whenReady().then(() => {
  createWindow(); createTray();
  setTimeout(() => {
    const c = readJSON(FILES.speed);
    if (c?.timestamp && Date.now() - new Date(c.timestamp).getTime() < SIX_HOURS) return;
    runSpeedTest();
  }, 10000);
  setInterval(runSpeedTest, SIX_HOURS);
});
app.on('window-all-closed', e => e.preventDefault());
