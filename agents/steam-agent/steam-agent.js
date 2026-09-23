// Steam Library Agent
// Exposes JSON of installed Steam games for the NasDash / Homepage dashboard.
//
// Endpoints:
//   GET /                  -> health + library status
//   GET /summary           -> recent game + total counts (legacy customapi widget)
//   GET /recent?n=5        -> top N recent games
//   GET /all               -> full library (raw)
//   GET /dashboard         -> everything the Steam card needs: games (with
//                             playtime), totals, running game, active updates
//   GET /launch-recent     -> 302 redirect to steam://run/<most-recent-appid>
//   GET /launch/<appid>    -> 302 redirect to steam://run/<appid>
//
// Listens on 0.0.0.0:7790

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile, spawn } = require('child_process');

// Spotify (Microsoft Store build) via its app-execution alias; --minimized is
// the same flag Spotify's own start-at-login uses. Used by the dashboard's
// Play button when the PC isn't a Spotify device yet.
const SPOTIFY_ALIAS = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'Spotify.exe');
function spotifyRunning() {
  return new Promise(resolve => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Spotify.exe', '/NH'], { windowsHide: true }, (err, out) =>
      resolve(!err && /Spotify\.exe/i.test(String(out))));
  });
}

const PORT = 7790;
const STEAM_ROOT = 'C:\\Program Files (x86)\\Steam';
const LIBRARIES = [
  STEAM_ROOT + '\\steamapps',
  'D:\\SteamLibrary\\steamapps',
];
// Steam tools that live in the library but aren't games.
const NOT_GAMES = /Steamworks Common Redistributables|Steam Linux Runtime|^Proton|SteamVR|Redistributable|Steam Controller Configs/i;

function acfGet(content, key) {
  const m = content.match(new RegExp('"' + key + '"\\s+"([^"]*)"', 'i'));
  return m ? m[1] : null;
}

function parseAcf(content) {
  return {
    appid: acfGet(content, 'appid'),
    name: acfGet(content, 'name'),
    lastPlayed: parseInt(acfGet(content, 'LastPlayed') || '0', 10),
    sizeOnDisk: parseInt(acfGet(content, 'SizeOnDisk') || '0', 10),
    stateFlags: parseInt(acfGet(content, 'StateFlags') || '4', 10),
    bytesToDownload: parseInt(acfGet(content, 'BytesToDownload') || '0', 10),
    bytesDownloaded: parseInt(acfGet(content, 'BytesDownloaded') || '0', 10),
  };
}

function scanLibrary(libPath) {
  const games = [];
  if (!fs.existsSync(libPath)) return games;
  let entries;
  try { entries = fs.readdirSync(libPath); } catch (err) { return games; }
  for (const entry of entries) {
    if (!entry.startsWith('appmanifest_') || !entry.endsWith('.acf')) continue;
    try {
      const content = fs.readFileSync(path.join(libPath, entry), 'utf8');
      const game = parseAcf(content);
      if (game.appid && game.name) games.push(game);
    } catch (err) { /* skip */ }
  }
  return games;
}

function scanAll() {
  const all = [];
  for (const lib of LIBRARIES) all.push(...scanLibrary(lib));
  const byAppid = new Map();
  for (const g of all) {
    const existing = byAppid.get(g.appid);
    if (!existing || g.lastPlayed > existing.lastPlayed) byAppid.set(g.appid, g);
  }
  return [...byAppid.values()].sort((a, b) => b.lastPlayed - a.lastPlayed);
}

// ── Minimal VDF (Valve KeyValues) parser for localconfig.vdf ──
function parseVdf(text) {
  const root = {}; const stack = [root]; let key = null;
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g; let m;
  while ((m = re.exec(text))) {
    const cur = stack[stack.length - 1];
    if (m[2] === '{') { const o = {}; cur[key] = o; stack.push(o); key = null; }
    else if (m[2] === '}') { stack.pop(); key = null; }
    else if (key === null) key = m[1];
    else { cur[key] = m[1]; key = null; }
  }
  return root;
}
const ci = (obj, k) => { if (!obj) return undefined; const hit = Object.keys(obj).find(x => x.toLowerCase() === k.toLowerCase()); return hit ? obj[hit] : undefined; };

// appid -> playtime minutes, cached by file mtime.
let playCache = { mtime: 0, map: new Map() };
function playtimes() {
  try {
    const ud = path.join(STEAM_ROOT, 'userdata');
    const ids = fs.readdirSync(ud).filter(d => /^\d+$/.test(d));
    let file = null, mtime = 0;
    for (const id of ids) {
      const f = path.join(ud, id, 'config', 'localconfig.vdf');
      try { const st = fs.statSync(f); if (st.mtimeMs > mtime) { mtime = st.mtimeMs; file = f; } } catch {}
    }
    if (!file) return playCache.map;
    if (mtime === playCache.mtime) return playCache.map;
    const v = parseVdf(fs.readFileSync(file, 'utf8'));
    const apps = ci(ci(ci(ci(ci(v, 'UserLocalConfigStore'), 'Software'), 'Valve'), 'Steam'), 'apps') || {};
    const map = new Map();
    for (const [appid, a] of Object.entries(apps)) {
      const pt = parseInt(ci(a, 'Playtime') || '0', 10);
      if (pt) map.set(appid, pt);
    }
    playCache = { mtime, map };
  } catch { /* keep last good */ }
  return playCache.map;
}

// Currently running game (HKCU\Software\Valve\Steam\RunningAppID), cached 3s.
let runCache = { at: 0, appid: '0' };
function runningAppId() {
  return new Promise(resolve => {
    if (Date.now() - runCache.at < 3000) return resolve(runCache.appid);
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'RunningAppID'], { windowsHide: true }, (err, out) => {
      let id = '0';
      if (!err) { const m = String(out).match(/RunningAppID\s+REG_DWORD\s+0x([0-9a-f]+)/i); if (m) id = String(parseInt(m[1], 16)); }
      runCache = { at: Date.now(), appid: id };
      resolve(id);
    });
  });
}

function relativeTime(unixSeconds) {
  if (!unixSeconds) return 'Never';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSeconds;
  if (diff < 0) return 'just now';
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
  if (diff < 86400 * 30) return Math.floor(diff / (86400 * 7)) + 'w ago';
  if (diff < 86400 * 365) return Math.floor(diff / (86400 * 30)) + 'mo ago';
  return Math.floor(diff / (86400 * 365)) + 'y ago';
}

function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
}

function redirectToSteam(res, steamUrl) {
  res.statusCode = 302;
  res.setHeader('Location', steamUrl);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><meta http-equiv="refresh" content="0;url=' + steamUrl + '">' +
          '<p>Launching Steam... <a href="' + steamUrl + '">click here</a> if nothing happens.</p>');
}


// ── Artwork from Steam's local library cache ──
// Older games: appcache/librarycache/<appid>/header.jpg etc. Newer games keep
// the same images inside hash-named subfolders (library_header.jpg, ...), which
// the public CDN can't be guessed for — so serve whatever the client cached.
const ART_CACHE = STEAM_ROOT + '\\appcache\\librarycache';
const ART_NAMES = {
  header:  ['header.jpg', 'library_header.jpg'],
  capsule: ['library_600x900.jpg', 'library_capsule.jpg'],
  hero:    ['library_hero.jpg'],
  logo:    ['logo.png'],
};
const artIndex = new Map();   // "<appid>/<kind>" -> path, refreshed on miss
function findArt(appid, kind) {
  const key = appid + '/' + kind;
  const cached = artIndex.get(key);
  if (cached && fs.existsSync(cached)) return cached;
  const dir = path.join(ART_CACHE, appid);
  const names = ART_NAMES[kind] || [];
  const walk = (d, depth) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const n of names) { const hit = entries.find(e => e.isFile() && e.name.toLowerCase() === n); if (hit) return path.join(d, hit.name); }
    if (depth > 0) for (const e of entries) if (e.isDirectory()) { const r = walk(path.join(d, e.name), depth - 1); if (r) return r; }
    return null;
  };
  const found = walk(dir, 2);
  if (found) artIndex.set(key, found);
  return found;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);

  if (url.pathname === '/launch-recent') {
    try {
      const games = scanAll().filter(g => !NOT_GAMES.test(g.name));
      const recent = games[0];
      if (!recent) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'no games found' }));
        return;
      }
      redirectToSteam(res, 'steam://run/' + recent.appid);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (url.pathname === '/spotify/launch') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST only' })); return; }
    if (await spotifyRunning()) { res.end(JSON.stringify({ launched: false, running: true })); return; }
    // App-execution aliases are reparse points: existsSync/stat can't follow them, lstat can.
    let aliasOk = false; try { fs.lstatSync(SPOTIFY_ALIAS); aliasOk = true; } catch {}
    if (!aliasOk) { res.statusCode = 404; res.end(JSON.stringify({ error: 'Spotify not installed' })); return; }
    try {
      const p = spawn('cmd.exe', ['/c', 'start', '""', SPOTIFY_ALIAS, '--minimized'], { detached: true, stdio: 'ignore', windowsHide: true });
      p.unref();
      // Then hide its window entirely (no taskbar button): background playback only.
      const h = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(__dirname, 'hide-spotify.ps1')],
                      { stdio: 'ignore', windowsHide: true });   // not detached: detached PowerShell can't hide the window
      h.unref();
      res.end(JSON.stringify({ launched: true, running: true }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
    return;
  }

  const artMatch = url.pathname.match(/^\/art\/(\d+)\/(header|capsule|hero|logo)$/);
  if (artMatch) {
    const file = findArt(artMatch[1], artMatch[2]);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!file) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.png') ? 'image/png' : 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(file).on('error', () => { res.statusCode = 500; res.end(); }).pipe(res);
    return;
  }

  const launchMatch = url.pathname.match(/^\/launch\/(\d+)$/);
  if (launchMatch) {
    redirectToSteam(res, 'steam://run/' + launchMatch[1]);
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const games = scanAll();
    if (url.pathname === '/' || url.pathname === '/health') {
      res.end(JSON.stringify({
        ok: true,
        libraries: LIBRARIES.map((l) => ({ path: l, exists: fs.existsSync(l) })),
        count: games.length,
      }));
      return;
    }
    if (url.pathname === '/summary') {
      const recent = games[0] || null;
      const totalSize = games.reduce((sum, g) => sum + (g.sizeOnDisk || 0), 0);
      res.end(JSON.stringify({
        count: games.length,
        recent_name: recent ? recent.name : 'None',
        recent_appid: recent ? recent.appid : null,
        recent_last_played: recent ? recent.lastPlayed : 0,
        recent_relative: recent ? relativeTime(recent.lastPlayed) : 'Never',
        total_size_bytes: totalSize,
        total_size_human: humanSize(totalSize),
      }));
      return;
    }
    if (url.pathname === '/dashboard') {
      const pt = playtimes();
      const running = await runningAppId();
      const list = games.filter(g => !NOT_GAMES.test(g.name)).map(g => ({
        appid: g.appid,
        name: g.name,
        lastPlayed: g.lastPlayed,
        lastPlayedRel: relativeTime(g.lastPlayed),
        size: g.sizeOnDisk,
        sizeHuman: humanSize(g.sizeOnDisk),
        playtimeMin: pt.get(g.appid) || 0,
        updating: (g.stateFlags & 4) === 0 || (g.bytesToDownload > 0 && g.bytesDownloaded < g.bytesToDownload),
        progress: g.bytesToDownload > 0 ? Math.round((g.bytesDownloaded / g.bytesToDownload) * 100) : null,
      }));
      const totalSize = list.reduce((s, g) => s + (g.size || 0), 0);
      const run = running !== '0' ? (list.find(g => g.appid === running) || { appid: running, name: null }) : null;
      res.end(JSON.stringify({
        count: list.length,
        totalSize, totalSizeHuman: humanSize(totalSize),
        running: run ? { appid: run.appid, name: run.name } : null,
        updating: list.filter(g => g.updating).map(g => ({ appid: g.appid, name: g.name, progress: g.progress })),
        games: list,
      }));
      return;
    }
    if (url.pathname === '/recent') {
      const n = parseInt(url.searchParams.get('n') || '5', 10);
      const top = games.slice(0, n).map((g) => ({
        name: g.name,
        appid: g.appid,
        last_played: g.lastPlayed,
        last_played_relative: relativeTime(g.lastPlayed),
        size_bytes: g.sizeOnDisk,
        size_human: humanSize(g.sizeOnDisk),
      }));
      res.end(JSON.stringify(top));
      return;
    }
    if (url.pathname === '/all') { res.end(JSON.stringify(games)); return; }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Steam agent listening on http://0.0.0.0:' + PORT);
});
