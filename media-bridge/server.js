// media-bridge — server-side proxy between the Homepage dashboard and media
// services. Keeps API keys/tokens off the browser and adds the CORS headers
// the dashboard origin needs. No npm dependencies (Node 20 built-in fetch).
//
// Audiobookshelf:
//   GET  /abs/current            most recent in-progress book + saved position
//   GET  /abs/cover/:itemId      cover image proxy
//   POST /abs/play/:itemId       open a playback session (returns tracks/chapters)
//   GET  /abs/stream/:sid/:idx   audio stream proxy (Range passthrough for seeking)
//   POST /abs/sync/:sid          {currentTime, timeListened} periodic progress sync
//   POST /abs/close/:sid         {currentTime, timeListened} final sync + close
//
// Spotify (Web API, authorization-code flow; refresh token kept in DATA_DIR):
//   GET  /spotify/login          302 → Spotify consent page
//   GET  /spotify/callback       ?code&state — token exchange (forwarded by NasDash
//                                from http://127.0.0.1:8888/callback)
//   GET  /spotify/now            now-playing state (cached ~2s)
//   POST /spotify/play|pause|next|prev|shuffle|repeat
//   POST /spotify/seek           {ms}
//   POST /spotify/volume         {percent}
//   GET  /spotify/devices
//   POST /spotify/transfer       {deviceId, play}
//
//   GET  /health

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const PORT    = parseInt(process.env.PORT || '7792', 10);
const ORIGINS = (process.env.ALLOW_ORIGINS || 'http://192.168.0.190:3000').split(',').map(s => s.trim());
const DATA_DIR = process.env.DATA_DIR || '/data';

const ABS_URL = (process.env.ABS_URL || '').replace(/\/$/, '');
const ABS_KEY = process.env.ABS_KEY || '';
const DEVICE  = { clientName: 'NasDash', deviceId: 'nasdash-homepage', clientVersion: '1.0.0' };

const SP_ID       = process.env.SPOTIFY_CLIENT_ID || '';
const SP_SECRET   = process.env.SPOTIFY_CLIENT_SECRET || '';
const SP_REDIRECT = process.env.SPOTIFY_REDIRECT || 'http://127.0.0.1:8888/callback';
const SP_SCOPES   = 'user-read-playback-state user-modify-playback-state user-read-currently-playing ' +
                    'playlist-read-private playlist-read-collaborative user-read-recently-played user-top-read user-library-read';
const SP_TOKEN_FILE = path.join(DATA_DIR, 'spotify.json');

// ─── helpers ────────────────────────────────────────────────────────────────
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function html(res, code, title, msg) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;background:#1e293b;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2 style="margin:0 0 .5rem">${title}</h2><p style="opacity:.75">${msg}</p></div></body>`);
}

async function readBody(req) {
  let d = '';
  for await (const c of req) { d += c; if (d.length > 64 * 1024) break; }
  try { return d ? JSON.parse(d) : {}; } catch { return {}; }
}

class UpstreamError extends Error {
  constructor(status, where, detail) { super(`upstream ${status} ${where}${detail ? ' ' + detail : ''}`); this.status = status; }
}

function writeFileAtomic(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// ═══ Audiobookshelf ═════════════════════════════════════════════════════════
// sid -> { itemId, tracks: [{contentUrl, startOffset, duration, mimeType}], touched }
const sessions = new Map();
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.touched > SESSION_TTL_MS) sessions.delete(sid);
}, 10 * 60 * 1000).unref();

async function abs(p, { method = 'GET', body, headers = {}, signal } = {}) {
  const r = await fetch(ABS_URL + p, {
    method, signal,
    headers: { Authorization: `Bearer ${ABS_KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok && r.status !== 206) throw new UpstreamError(r.status, p);
  return r;
}

// Pipe an upstream fetch Response to the client, copying the headers that
// matter for media and images. Aborts the upstream fetch if the client goes
// away (seeking fires lots of short-lived range requests).
function pipeUpstream(upstream, res, ctrl, extraHeaders = {}) {
  const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  const headers = { ...extraHeaders };
  for (const h of pass) { const v = upstream.headers.get(h); if (v) headers[h] = v; }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return res.end();
  const stream = Readable.fromWeb(upstream.body);
  res.on('close', () => { ctrl.abort(); stream.destroy(); });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function absCurrent(req, res) {
  const r = await abs('/api/me/items-in-progress?limit=10');
  const { libraryItems = [] } = await r.json();
  const item = libraryItems.find(i => i.mediaType === 'book');
  if (!item) return json(res, 200, { id: null });

  const p = await (await abs(`/api/me/progress/${item.id}`)).json();
  const md = item.media?.metadata || {};
  json(res, 200, {
    id: item.id,
    title: md.title || 'Unknown title',
    author: md.authorName || '',
    series: md.seriesName || '',
    duration: p.duration || item.media?.duration || 0,
    currentTime: p.currentTime || 0,
    progress: p.progress || 0,
    cover: `/abs/cover/${item.id}`,
  });
}

// All in-progress books (most recent first) with their progress, for the book switcher.
async function absInProgress(req, res) {
  const [{ libraryItems = [] }, me] = await Promise.all([
    abs('/api/me/items-in-progress?limit=12').then(r => r.json()),
    abs('/api/me').then(r => r.json()),
  ]);
  const prog = new Map((me.mediaProgress || []).filter(p => !p.episodeId).map(p => [p.libraryItemId, p]));
  json(res, 200, {
    books: libraryItems.filter(i => i.mediaType === 'book' && !prog.get(i.id)?.isFinished && (prog.get(i.id)?.progress || 0) < 0.995).map(i => {
      const md = i.media?.metadata || {}, p = prog.get(i.id) || {};
      return { id: i.id, title: md.title || 'Unknown title', author: md.authorName || '', series: md.seriesName || '',
               progress: p.progress || 0, currentTime: p.currentTime || 0, duration: p.duration || i.media?.duration || 0,
               cover: '/abs/cover/' + i.id };
    }),
  });
}

async function absCover(req, res, itemId) {
  const ctrl = new AbortController();
  const up = await abs(`/api/items/${encodeURIComponent(itemId)}/cover?width=300`, { signal: ctrl.signal });
  pipeUpstream(up, res, ctrl, { 'Cache-Control': 'public, max-age=3600' });
}

async function absPlay(req, res, itemId) {
  const r = await abs(`/api/items/${encodeURIComponent(itemId)}/play`, {
    method: 'POST',
    body: {
      deviceInfo: DEVICE,
      mediaPlayer: 'html5',
      forceDirectPlay: true,
      forceTranscode: false,
      supportedMimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac', 'audio/ogg', 'audio/webm'],
    },
  });
  const s = await r.json();
  const tracks = (s.audioTracks || []).map(t => ({
    contentUrl: t.contentUrl, startOffset: t.startOffset || 0, duration: t.duration || 0, mimeType: t.mimeType,
  }));
  sessions.set(s.id, { itemId, tracks, touched: Date.now() });
  json(res, 200, {
    sessionId: s.id,
    title: s.displayTitle,
    author: s.displayAuthor,
    duration: s.duration,
    currentTime: s.currentTime || 0,
    chapters: (s.chapters || []).map(c => ({ start: c.start, end: c.end, title: c.title })),
    tracks: tracks.map((t, i) => ({ index: i, startOffset: t.startOffset, duration: t.duration, mimeType: t.mimeType, url: `/abs/stream/${s.id}/${i}` })),
    cover: `/abs/cover/${itemId}`,
  });
}

async function absStream(req, res, sid, idx) {
  const s = sessions.get(sid);
  const t = s && s.tracks[parseInt(idx, 10)];
  if (!t) return json(res, 404, { error: 'unknown session or track' });
  s.touched = Date.now();
  const ctrl = new AbortController();
  const headers = req.headers.range ? { Range: req.headers.range } : {};
  const up = await abs(t.contentUrl, { headers, signal: ctrl.signal });
  pipeUpstream(up, res, ctrl);
}

async function absSync(req, res, sid, close) {
  const b = await readBody(req);
  const s = sessions.get(sid);
  if (s) s.touched = Date.now();
  const body = {
    currentTime: Number(b.currentTime) || 0,
    timeListened: Math.max(0, Number(b.timeListened) || 0),
    duration: Number(b.duration) || undefined,
  };
  try {
    await abs(`/api/session/${encodeURIComponent(sid)}/${close ? 'close' : 'sync'}`, { method: 'POST', body });
  } catch (e) {
    // ABS drops sessions it considers stale; tell the client to reopen one.
    if (e.status === 404) return json(res, 410, { error: 'session expired' });
    throw e;
  }
  if (close) sessions.delete(sid);
  json(res, 200, { ok: true });
}

// ═══ Spotify ════════════════════════════════════════════════════════════════
const sp = {
  refreshToken: null,
  accessToken: null,
  expiresAt: 0,
  expired: false,          // refresh token rejected → user must reconnect
  pendingStates: new Map(),// state -> created ms
  nowCache: null, nowCacheAt: 0,
};

try {
  const saved = JSON.parse(fs.readFileSync(SP_TOKEN_FILE, 'utf8'));
  sp.refreshToken = saved.refreshToken || null;
  sp.scope = saved.scope || '';
} catch {}

function saveSpotifyToken() {
  writeFileAtomic(SP_TOKEN_FILE, JSON.stringify({ refreshToken: sp.refreshToken, scope: sp.scope, savedAt: new Date().toISOString() }));
}

async function spTokenRequest(params) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${SP_ID}:${SP_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new UpstreamError(r.status, 'spotify token', body.error || '');
  return body;
}

function applyToken(t) {
  sp.accessToken = t.access_token;
  sp.expiresAt = Date.now() + (t.expires_in - 60) * 1000;
  // Spotify may rotate the refresh token; always keep the newest.
  const scopeChanged = t.scope && t.scope !== sp.scope;
  if (t.scope) sp.scope = t.scope;
  if (t.refresh_token || scopeChanged) { if (t.refresh_token) sp.refreshToken = t.refresh_token; saveSpotifyToken(); }
  sp.expired = false;
}

let refreshing = null;
async function spAccessToken() {
  if (sp.accessToken && Date.now() < sp.expiresAt) return sp.accessToken;
  if (!sp.refreshToken) return null;
  refreshing ??= (async () => {
    try {
      applyToken(await spTokenRequest({ grant_type: 'refresh_token', refresh_token: sp.refreshToken }));
    } catch (e) {
      // invalid_grant = refresh token expired/revoked (6-month lifetime).
      if (e.status === 400) { sp.expired = true; sp.accessToken = null; }
      throw e;
    } finally { refreshing = null; }
  })();
  await refreshing;
  return sp.accessToken;
}

async function spApi(p, { method = 'GET', body, query } = {}) {
  const token = await spAccessToken();
  if (!token) throw new UpstreamError(401, 'spotify', 'not connected');
  const qs = query ? '?' + new URLSearchParams(query) : '';
  const r = await fetch(`https://api.spotify.com/v1${p}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new UpstreamError(r.status, `spotify ${p}`, data?.error?.reason || data?.error?.message || '');
  return data;
}

function spConfigured(res) {
  if (SP_ID && SP_SECRET) return true;
  json(res, 503, { error: 'Spotify not configured' });
  return false;
}

async function spLogin(req, res) {
  const state = crypto.randomBytes(12).toString('hex');
  sp.pendingStates.set(state, Date.now());
  for (const [s, t] of sp.pendingStates) if (Date.now() - t > 10 * 60 * 1000) sp.pendingStates.delete(s);
  const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: SP_ID, scope: SP_SCOPES, redirect_uri: SP_REDIRECT, state,
  });
  res.writeHead(302, { Location: url });
  res.end();
}

async function spCallback(req, res, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');
  if (err) return html(res, 400, 'Spotify not connected', `Spotify said: ${err}`);
  if (!code || !state || !sp.pendingStates.has(state)) {
    return html(res, 400, 'Spotify not connected', 'Login link expired or invalid — click Connect on the dashboard again.');
  }
  sp.pendingStates.delete(state);
  applyToken(await spTokenRequest({ grant_type: 'authorization_code', code, redirect_uri: SP_REDIRECT }));
  sp.nowCache = null;
  html(res, 200, 'Spotify connected ✓', 'You can close this tab — the dashboard card will update within a few seconds.');
}

function shapeNow(p) {
  const item = p?.item;
  if (!p || !item) return { connected: true, active: false, device: p?.device ? shapeDevice(p.device) : null };
  const isEpisode = p.currently_playing_type === 'episode' || item.type === 'episode';
  const images = (isEpisode ? item.images : item.album?.images) || [];
  const art = images.sort((a, b) => (a.width || 0) - (b.width || 0)).find(i => (i.width || 0) >= 200) || images[images.length - 1];
  return {
    connected: true,
    active: true,
    isPlaying: !!p.is_playing,
    title: item.name,
    artist: isEpisode ? (item.show?.name || '') : (item.artists || []).map(a => a.name).join(', '),
    album: isEpisode ? '' : (item.album?.name || ''),
    art: art?.url || null,
    progressMs: p.progress_ms || 0,
    durationMs: item.duration_ms || 0,
    shuffle: !!p.shuffle_state,
    repeat: p.repeat_state || 'off',
    device: p.device ? shapeDevice(p.device) : null,
    url: item.external_urls?.spotify || null,
    at: Date.now(),
  };
}

function shapeDevice(d) {
  return { id: d.id, name: d.name, type: d.type, volume: d.volume_percent, supportsVolume: d.supports_volume !== false };
}

async function spNow(req, res) {
  if (!sp.refreshToken) return json(res, 200, { connected: false, reason: 'not-connected' });
  if (sp.expired)       return json(res, 200, { connected: false, reason: 'expired' });
  // Short cache so several open dashboards don't multiply API calls.
  if (sp.nowCache && Date.now() - sp.nowCacheAt < 2000) return json(res, 200, sp.nowCache);
  try {
    const p = await spApi('/me/player', { query: { additional_types: 'episode' } });
    sp.nowCache = { ...shapeNow(p), needsRescope: !SP_SCOPES.split(' ').every(x => sp.scope.split(' ').includes(x)) };
    sp.nowCacheAt = Date.now();
    json(res, 200, sp.nowCache);
  } catch (e) {
    if (sp.expired) return json(res, 200, { connected: false, reason: 'expired' });
    throw e;
  }
}

// If nothing is active, pick a device so Play still does something useful.
async function spFallbackDevice() {
  const { devices = [] } = (await spApi('/me/player/devices')) || {};
  // Only auto-pick a computer (desktop app or web player). Speakers and AVRs
  // must be chosen deliberately from the device picker, never by default.
  return devices.find(d => d.is_active) || devices.find(d => d.type === 'Computer') || null;
}

async function spControl(req, res, action) {
  const b = await readBody(req);
  const cmd = async () => {
    switch (action) {
      case 'play': {
        const body = b.contextUri ? { context_uri: b.contextUri } : b.uris ? { uris: b.uris } : undefined;
        let deviceId = b.deviceId;
        if (deviceId && !(await spIsComputer(deviceId))) throw new UpstreamError(403, 'not-a-computer');
        if (!deviceId) {
          // PC-first: never resume on a speaker/AVR just because it was the last
          // device used. Only a computer (or a device that is actually playing
          // right now) is used without an explicit choice from the device menu.
          const cur = await spApi('/me/player');
          const d = cur?.device;
          if (!d || (d.type !== 'Computer' && !cur.is_playing)) {
            const { devices = [] } = (await spApi('/me/player/devices')) || {};
            const pc = devices.find(x => x.type === 'Computer');
            if (!pc) throw new UpstreamError(409, 'no-computer');
            deviceId = pc.id;
          }
        }
        return spApi('/me/player/play', { method: 'PUT', body, query: deviceId ? { device_id: deviceId } : undefined });
      }
      case 'pause': return spApi('/me/player/pause', { method: 'PUT' });
      case 'next':  return spApi('/me/player/next', { method: 'POST' });
      case 'prev':  return spApi('/me/player/previous', { method: 'POST' });
      case 'seek':  return spApi('/me/player/seek', { method: 'PUT', query: { position_ms: Math.max(0, Math.round(b.ms || 0)) } });
      case 'volume': return spApi('/me/player/volume', { method: 'PUT', query: { volume_percent: Math.max(0, Math.min(100, Math.round(b.percent ?? 50))) } });
      case 'shuffle': return spApi('/me/player/shuffle', { method: 'PUT', query: { state: String(!!b.state) } });
      case 'repeat':  return spApi('/me/player/repeat', { method: 'PUT', query: { state: ['off', 'context', 'track'].includes(b.state) ? b.state : 'off' } });
      case 'transfer':
        if (!(await spIsComputer(b.deviceId))) throw new UpstreamError(403, 'not-a-computer');
        return spApi('/me/player', { method: 'PUT', body: { device_ids: [b.deviceId], play: !!b.play } });
      default: throw new UpstreamError(404, 'unknown action');
    }
  };
  try {
    await cmd();
  } catch (e) {
    // NO_ACTIVE_DEVICE on play → wake the best available device and retry.
    if (action === 'play' && e.status === 409 && /no-computer/.test(e.message)) return json(res, 409, { error: 'no-computer' });
    if (action === 'play' && e.status === 404) {
      const d = await spFallbackDevice();
      if (!d) return json(res, 409, { error: 'no-computer' });
      // Start on that device directly so a chosen playlist/album is honoured.
      const body = b.contextUri ? { context_uri: b.contextUri } : b.uris ? { uris: b.uris } : undefined;
      if (body) await spApi('/me/player/play', { method: 'PUT', body, query: { device_id: d.id } });
      else await spApi('/me/player', { method: 'PUT', body: { device_ids: [d.id], play: true } });
    } else {
      throw e;
    }
  }
  sp.nowCache = null;
  json(res, 200, { ok: true });
}

async function spIsComputer(id) {
  const { devices = [] } = (await spApi('/me/player/devices')) || {};
  return devices.some(d => d.id === id && d.type === 'Computer');
}

async function spDevices(req, res) {
  const { devices = [] } = (await spApi('/me/player/devices')) || {};
  // NasDash only ever offers the PC (desktop app / web player); speakers and AVRs are never listed.
  json(res, 200, { devices: devices.filter(d => d.type === 'Computer').map(d => ({ ...shapeDevice(d), active: d.is_active })) });
}


// ─── Spotify: library / discovery ──────────────────────────────────────────
function pickImage(images, min = 120) {
  const imgs = (images || []).slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  return (imgs.find(i => (i.width || 0) >= min) || imgs[imgs.length - 1] || {}).url || null;
}

async function spPlaylists(req, res) {
  const out = [];
  let url = '/me/playlists';
  let query = { limit: 50 };
  for (let page = 0; page < 4 && url; page++) {
    const d = await spApi(url, { query });
    for (const p of d?.items || []) {
      if (!p) continue;
      out.push({ uri: p.uri, name: p.name, image: pickImage(p.images), owner: p.owner?.display_name || '', tracks: p.tracks?.total ?? p.items?.total ?? null });
    }
    if (!d?.next) break;
    const n = new URL(d.next);
    url = n.pathname.replace('/v1', ''); query = Object.fromEntries(n.searchParams);
  }
  json(res, 200, { playlists: out });
}

// Recently played → unique listening contexts (playlists/albums/artists) and tracks.
async function spRecent(req, res) {
  const d = await spApi('/me/player/recently-played', { query: { limit: 50 } });
  const contexts = new Map();
  const tracks = [];
  for (const it of d?.items || []) {
    const t = it.track;
    if (t && tracks.length < 20 && !tracks.some(x => x.uri === t.uri)) {
      tracks.push({ uri: t.uri, name: t.name, artist: (t.artists || []).map(a => a.name).join(', '), image: pickImage(t.album?.images, 60) });
    }
    const c = it.context;
    if (c?.uri && !contexts.has(c.uri)) contexts.set(c.uri, { uri: c.uri, type: c.type, playedAt: it.played_at, fallbackImage: pickImage(t?.album?.images) });
  }
  // Resolve names/art for album & artist contexts (playlists come from /me/playlists client-side).
  const resolved = [];
  for (const c of [...contexts.values()].slice(0, 12)) {
    const id = c.uri.split(':').pop();
    let name = null, image = c.fallbackImage;
    try {
      if (c.type === 'album')    { const a = await spApi(`/albums/${id}`);    name = a.name; image = pickImage(a.images) || image; }
      if (c.type === 'artist')   { const a = await spApi(`/artists/${id}`);   name = a.name; image = pickImage(a.images) || image; }
      if (c.type === 'playlist') { const p = await spApi(`/playlists/${id}`, { query: { fields: 'name,images' } }); name = p.name; image = pickImage(p.images) || image; }
    } catch { /* restricted or deleted — keep fallback */ }
    resolved.push({ uri: c.uri, type: c.type, name, image });
  }
  json(res, 200, { contexts: resolved, tracks });
}

async function spTopArtists(req, res) {
  const d = await spApi('/me/top/artists', { query: { limit: 12, time_range: 'medium_term' } });
  json(res, 200, { artists: (d?.items || []).map(a => ({ uri: a.uri, name: a.name, image: pickImage(a.images) })) });
}

async function spQueue(req, res) {
  const d = await spApi('/me/player/queue');
  json(res, 200, {
    queue: (d?.queue || []).slice(0, 15).map(t => ({
      uri: t.uri, name: t.name,
      artist: t.artists ? t.artists.map(a => a.name).join(', ') : (t.show?.name || ''),
      image: pickImage(t.album?.images || t.images, 60),
    })),
  });
}

// One-off capability check against this account's dev-mode app.
async function spProbe(req, res) {
  const tests = {
    myPlaylists: '/me/playlists?limit=1', recentlyPlayed: '/me/player/recently-played?limit=1',
    queue: '/me/player/queue', topArtists: '/me/top/artists?limit=1', savedAlbums: '/me/albums?limit=1',
    featuredPlaylists: '/browse/featured-playlists?limit=1', categories: '/browse/categories?limit=1',
    recommendations: '/recommendations?seed_genres=rock&limit=1', newReleases: '/browse/new-releases?limit=1',
  };
  const token = await spAccessToken();
  const out = {};
  for (const [k, p] of Object.entries(tests)) {
    const r = await fetch('https://api.spotify.com/v1' + p, { headers: { Authorization: 'Bearer ' + token } });
    out[k] = r.status;
  }
  json(res, 200, out);
}


// ═══ Systems (Beszel hub) ═══════════════════════════════════════════════════
// Shapes PC / NAS / JARVIS stats from the Beszel hub into tile-ready objects:
// three rings, per-GPU bars, a 1-hour CPU sparkline, uptime and status.
const BZ_URL  = (process.env.BESZEL_URL || '').replace(/\/$/, '');
const BZ_USER = process.env.BESZEL_EMAIL || '';
const BZ_PASS = process.env.BESZEL_PASSWORD || '';
const SYSTEMS = [
  { name: 'PC',     os: 'Windows', third: 'gpu'   },
  { name: 'NAS',    os: 'Unraid',  third: 'array' },
  { name: 'JARVIS', os: 'Ubuntu',  third: 'vram'  },
];
const bz = { token: null, cache: null, cacheAt: 0 };

async function bzAuth() {
  const r = await fetch(BZ_URL + '/api/collections/users/auth-with-password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: BZ_USER, password: BZ_PASS }),
  });
  if (!r.ok) throw new UpstreamError(r.status, 'beszel auth');
  bz.token = (await r.json()).token;
}

async function bzGet(p, retry = true) {
  if (!bz.token) await bzAuth();
  const r = await fetch(BZ_URL + p, { headers: { Authorization: bz.token } });
  if (r.status === 401 && retry) { bz.token = null; return bzGet(p, false); }
  if (!r.ok) throw new UpstreamError(r.status, 'beszel ' + p.split('?')[0]);
  return r.json();
}

const round = (v, d = 0) => v == null || isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
const shortGpu = n => String(n || 'GPU').replace(/^(NVIDIA\s+)?(GeForce\s+)?/i, '').replace(/\s+SUPER/i, ' Super').trim();

async function buildSystems() {
  const { items = [] } = await bzGet('/api/collections/systems/records?perPage=50&fields=id,name,status,info');
  const out = [];
  for (const def of SYSTEMS) {
    const sys = items.find(x => x.name === def.name);
    if (!sys) { out.push({ name: def.name, status: 'missing' }); continue; }
    // Latest full stats + last hour of 1-minute CPU samples.
    const hist = await bzGet(`/api/collections/system_stats/records?perPage=60&sort=-created&fields=stats,created&filter=${encodeURIComponent(`system='${sys.id}' && type='1m'`)}`);
    const recs = hist.items || [];
    const st = recs[0]?.stats || {};
    const info = sys.info || {};
    const temps = st.t || {};
    const gpus = Object.values(st.g || {}).map(g => ({
      name: shortGpu(g.n),
      util: round(g.u),
      power: round(g.p),
      vramUsed: g.mu, vramTotal: g.mt,
      temp: round(temps[g.n] ?? temps[String(g.n).replace(/\s+\d{1,2}$/, '')] ?? null),
    }));
    const vramPct = gpus.length && gpus.some(g => g.vramTotal) ?
      round(100 * gpus.reduce((a, g) => a + (g.vramUsed || 0), 0) / gpus.reduce((a, g) => a + (g.vramTotal || 0), 0)) : null;
    const arrayPct = info.efs && Object.values(info.efs)[0] != null ? round(Object.values(info.efs)[0]) : null;
    const third = def.third === 'gpu'   ? { label: 'GPU',   value: gpus[0]?.util ?? null }
                : def.third === 'array' ? { label: 'Array', value: arrayPct ?? round(info.dp) }
                :                         { label: 'VRAM',  value: vramPct };
    // GPU summary for the subtitle, e.g. "2× 4070 Ti Super".
    const counts = {};
    for (const g of gpus) counts[g.name.replace(/\s+\d{1,2}$/, '')] = (counts[g.name.replace(/\s+\d{1,2}$/, '')] || 0) + 1;
    const gpuSummary = Object.entries(counts).map(([n, c]) => (c > 1 ? c + '× ' : '') + n).join(', ');
    out.push({
      name: def.name,
      status: sys.status,
      subtitle: [def.os, gpuSummary].filter(Boolean).join(' · '),
      uptime: info.u || 0,
      rings: [
        { label: 'CPU', value: round(info.cpu ?? st.cpu) },
        { label: 'RAM', value: round(info.mp ?? st.mp) },
        third,
      ],
      gpus,
      cpuHistory: recs.slice().reverse().map(r => round(r.stats?.cpu, 1)),
    });
  }
  return out;
}

async function systemsHandler(req, res) {
  if (!BZ_URL || !BZ_USER) return json(res, 503, { error: 'Beszel not configured' });
  if (!bz.cache || Date.now() - bz.cacheAt > 10000) {
    bz.cache = await buildSystems();
    bz.cacheAt = Date.now();
  }
  json(res, 200, { systems: bz.cache, at: bz.cacheAt });
}


// ═══ Home Assistant (JARVIS) ════════════════════════════════════════════════
// Compact dashboard card + control panel. The bridge only ever touches the
// entities in this allow-list; the alarm is read-only by design.
const HA_URL   = (process.env.HA_URL || '').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';
const HA = {
  lights: [
    { id: 'kitchen',        name: 'Kitchen',          entities: ['light.kitchen_lights'] },
    { id: 'kitchen_hall',   name: 'Kitchen hall',     entities: ['light.kitchen_hall'] },
    { id: 'living',         name: 'Living room',      entities: ['light.living_room'] },
    { id: 'living_fan',     name: 'Living fan', entities: ['light.living_room_fan_light'] },
    { id: 'master',         name: 'Master bed',       entities: ['light.master_bedroom_1_2', 'light.master_bedroom_2_2'] },
    { id: 'master_fan',     name: 'Master fan', entities: ['light.master_fan_light'] },
    { id: 'guest_bath',     name: 'Guest bath',       entities: ['light.guest_bathroom_light'] },
    { id: 'front_door',     name: 'Front door',       entities: ['light.front_door'] },
    { id: 'lamp',           name: 'Lamp',             entities: ['light.lamp'] },
  ],
  fans: [
    { id: 'living', name: 'Living room', entity: 'fan.living_room_fan' },
    { id: 'master', name: 'Master',      entity: 'fan.master_fan' },
  ],
  climate: 'climate.mr_cool_ac_air_conditioner',
  temp:    'sensor.bedroom_ac_room_temperature',
  alarm:   'alarm_control_panel.home_alarm',
};
const HA_AC_MODES = ['off', 'cool', 'heat', 'heat_cool', 'fan_only', 'dry'];
const ha = { cache: null, cacheAt: 0 };

async function haFetch(p, { method = 'GET', body } = {}) {
  const r = await fetch(HA_URL + p, {
    method,
    headers: { Authorization: 'Bearer ' + HA_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new UpstreamError(r.status, 'home assistant ' + p);
  return r.json();
}
const haCall = (domain, service, data) => haFetch(`/api/services/${domain}/${service}`, { method: 'POST', body: data });

async function haState(req, res) {
  if (ha.cache && Date.now() - ha.cacheAt < 1500) return json(res, 200, ha.cache);
  const all = await haFetch('/api/states');
  const st = new Map(all.map(e => [e.entity_id, e]));
  const lights = HA.lights.map(l => {
    const ents = l.entities.map(id => st.get(id)).filter(Boolean);
    const available = ents.some(e => e.state !== 'unavailable' && e.state !== 'unknown');
    return { id: l.id, name: l.name, available, on: ents.some(e => e.state === 'on') };
  });
  const fans = HA.fans.map(fn => {
    const e = st.get(fn.entity);
    return { id: fn.id, name: fn.name, available: !!e && e.state !== 'unavailable',
             on: e?.state === 'on', pct: e?.state === 'on' ? Math.round(e.attributes.percentage || 0) : 0 };
  });
  const c = st.get(HA.climate), t = st.get(HA.temp), a = st.get(HA.alarm);
  ha.cache = {
    lightsOn: lights.filter(l => l.on).length,
    temp: t && !isNaN(parseFloat(t.state)) ? { value: parseFloat(t.state), unit: t.attributes.unit_of_measurement || '' } : null,
    ac: c ? {
      mode: c.state, target: c.attributes.temperature ?? null, current: c.attributes.current_temperature ?? null,
      modes: (c.attributes.hvac_modes || []).filter(m => HA_AC_MODES.includes(m)),
      min: c.attributes.min_temp, max: c.attributes.max_temp, step: c.attributes.target_temp_step || 1,
    } : null,
    alarm: a ? a.state : null,
    lights, fans,
  };
  ha.cacheAt = Date.now();
  json(res, 200, ha.cache);
}

async function haControl(req, res, what) {
  const b = await readBody(req);
  if (what === 'light') {
    const l = HA.lights.find(x => x.id === b.id);
    if (!l) return json(res, 400, { error: 'unknown light' });
    await haCall('light', b.on ? 'turn_on' : 'turn_off', { entity_id: l.entities });
  } else if (what === 'fan') {
    const fn = HA.fans.find(x => x.id === b.id);
    if (!fn) return json(res, 400, { error: 'unknown fan' });
    const pct = Math.max(0, Math.min(100, Math.round(Number(b.pct) || 0)));
    if (pct === 0) await haCall('fan', 'turn_off', { entity_id: fn.entity });
    else await haCall('fan', 'set_percentage', { entity_id: fn.entity, percentage: pct });
  } else if (what === 'ac') {
    if (b.mode !== undefined) {
      if (!HA_AC_MODES.includes(b.mode)) return json(res, 400, { error: 'bad mode' });
      await haCall('climate', 'set_hvac_mode', { entity_id: HA.climate, hvac_mode: b.mode });
    }
    if (b.target !== undefined) {
      const t = Number(b.target);
      if (!isFinite(t) || t < 55 || t > 90) return json(res, 400, { error: 'bad target' });
      await haCall('climate', 'set_temperature', { entity_id: HA.climate, temperature: t });
    }
  } else {
    return json(res, 404, { error: 'not found' });
  }
  ha.cache = null;                      // next /ha/state reflects the change
  json(res, 200, { ok: true });
}


// ═══ Steam friends (Steam Web API) ═════════════════════════════════════════
// Online count for the Steam card's friends pill. Key stays on the NAS.
const STEAM_KEY = process.env.STEAM_API_KEY || '';
// SteamID64 = 76561197960265728 + account id (9330235, from Steam userdata)
const STEAM_ID  = process.env.STEAM_ID || (76561197960265728n + 9330235n).toString();
const sf = { cache: null, at: 0 };

async function steamFriends(req, res) {
  if (!STEAM_KEY) return json(res, 200, { configured: false });
  if (sf.cache && Date.now() - sf.at < 60000) return json(res, 200, sf.cache);
  const api = 'https://api.steampowered.com';
  const fl = await fetch(`${api}/ISteamUser/GetFriendList/v1/?key=${STEAM_KEY}&steamid=${STEAM_ID}&relationship=friend`);
  if (fl.status === 401 || fl.status === 403) return json(res, 200, { configured: true, error: 'private' });
  if (!fl.ok) throw new UpstreamError(fl.status, 'steam friends');
  const ids = ((await fl.json()).friendslist?.friends || []).map(x => x.steamid);
  const people = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await fetch(`${api}/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${ids.slice(i, i + 100).join(',')}`);
    if (!r.ok) throw new UpstreamError(r.status, 'steam summaries');
    people.push(...((await r.json()).response?.players || []));
  }
  const online = people.filter(p => p.personastate > 0);
  sf.cache = {
    configured: true, total: ids.length, online: online.length,
    inGame: online.filter(p => p.gameextrainfo).length,
    list: online.slice(0, 20).map(p => ({ name: p.personaname, game: p.gameextrainfo || null })),
  };
  sf.at = Date.now();
  json(res, 200, sf.cache);
}


// ═══ Plex: who is watching what ══════════════════════════════════════════════
// Active sessions for the Plex card's stream list, plus a poster proxy so the
// page never sees the Plex token.
const PLEX_URL   = (process.env.PLEX_URL || '').replace(/\/$/, '');
const PLEX_TOKEN = process.env.PLEX_TOKEN || '';
const px = { cache: null, at: 0 };

async function plexFetch(p) {
  const sep = p.includes('?') ? '&' : '?';
  const r = await fetch(PLEX_URL + p + sep + 'X-Plex-Token=' + encodeURIComponent(PLEX_TOKEN), { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new UpstreamError(r.status, 'plex ' + p.split('?')[0]);
  return r;
}

function plexDecision(m) {
  const t = m.TranscodeSession;
  if (!t) return 'Direct Play';
  const v = t.videoDecision, a = t.audioDecision;
  if (v === 'transcode' || (!v && a === 'transcode')) return 'Transcode';
  return 'Direct Stream';
}

async function plexSessions(req, res) {
  if (px.cache && Date.now() - px.at < 5000) return json(res, 200, px.cache);
  const d = await (await plexFetch('/status/sessions')).json();
  const items = d?.MediaContainer?.Metadata || [];
  const streams = items.map(m => {
    const pad = n => String(n ?? '').padStart(2, '0');
    let title = m.title, subtitle = '';
    if (m.type === 'episode') { title = m.grandparentTitle; subtitle = `S${pad(m.parentIndex)}E${pad(m.index)} · ${m.title}`; }
    else if (m.type === 'track') { title = m.title; subtitle = [m.grandparentTitle, m.parentTitle].filter(Boolean).join(' · '); }
    else if (m.year) subtitle = String(m.year);
    const media = (m.Media || [])[0] || {};
    const thumb = m.type === 'episode' ? (m.grandparentThumb || m.thumb) : (m.parentThumb && m.type === 'track' ? m.parentThumb : m.thumb);
    return {
      user: m.User?.title || 'Unknown',
      type: m.type, title, subtitle,
      progress: m.duration ? Math.min(100, Math.round((m.viewOffset || 0) / m.duration * 100)) : null,
      remainingMin: m.duration ? Math.max(0, Math.round((m.duration - (m.viewOffset || 0)) / 60000)) : null,
      state: m.Player?.state || 'playing',
      player: m.Player?.title || m.Player?.product || '',
      platform: m.Player?.platform || '',
      local: !!m.Player?.local,
      decision: plexDecision(m),
      quality: media.videoResolution ? (/^\d+$/.test(media.videoResolution) ? media.videoResolution + 'p' : media.videoResolution.toUpperCase()) : (media.audioCodec || '').toUpperCase(),
      bandwidthKbps: m.Session?.bandwidth || null,
      thumb: thumb ? '/plex/thumb?p=' + encodeURIComponent(thumb) : null,
    };
  });
  px.cache = { streams, totalBandwidthKbps: streams.reduce((a, s) => a + (s.bandwidthKbps || 0), 0) };
  px.at = Date.now();
  json(res, 200, px.cache);
}

// Poster proxy: only library artwork paths, resized by Plex's transcoder.
async function plexThumb(req, res, url) {
  const p = url.searchParams.get('p') || '';
  if (!/^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/.test(p)) return json(res, 400, { error: 'bad path' });
  const ctrl = new AbortController();
  const up = await plexFetch('/photo/:/transcode?width=120&height=180&minSize=1&upscale=1&url=' + encodeURIComponent(p));
  pipeUpstream(up, res, ctrl, { 'Cache-Control': 'public, max-age=3600' });
}


// ═══ SABnzbd: queue list + pause/resume ═════════════════════════════════════
const SAB_URL = (process.env.SAB_URL || '').replace(/\/$/, '');
const SAB_KEY = process.env.SAB_KEY || '';

async function sabApi(params) {
  const q = new URLSearchParams({ ...params, apikey: SAB_KEY, output: 'json' });
  const r = await fetch(SAB_URL + '/api?' + q);
  if (!r.ok) throw new UpstreamError(r.status, 'sabnzbd');
  return r.json();
}

async function sabQueue(req, res) {
  const d = (await sabApi({ mode: 'queue', limit: '25' })).queue || {};
  json(res, 200, {
    paused: !!d.paused, status: d.status, speed: d.speed, kbpersec: Number(d.kbpersec) || 0,
    timeleft: d.timeleft, mbleft: Number(d.mbleft) || 0, total: Number(d.noofslots_total ?? d.noofslots) || 0,
    pausedUntil: d.pause_int && d.pause_int !== '0' ? d.pause_int : null,
    items: (d.slots || []).map(x => ({
      name: x.filename, pct: Number(x.percentage) || 0, timeleft: x.timeleft,
      mb: Number(x.mb) || 0, mbleft: Number(x.mbleft) || 0, status: x.status, cat: x.cat,
    })),
  });
}

async function sabControl(req, res, action) {
  const b = await readBody(req);
  if (action === 'pause') {
    const minutes = Math.max(0, Math.min(1440, Math.round(Number(b.minutes) || 0)));
    if (minutes) await sabApi({ mode: 'config', name: 'set_pause', value: String(minutes) });
    else await sabApi({ mode: 'pause' });
  } else if (action === 'resume') {
    await sabApi({ mode: 'resume' });
  } else return json(res, 404, { error: 'not found' });
  json(res, 200, { ok: true });
}


// ═══ Security: Ring cameras (via ring-mqtt → go2rtc) ═════════════════════════
// Status comes from Home Assistant; video from go2rtc, which sits on a private
// Docker network with no published ports — only this bridge can reach it.
const net = require('net');
const GO2RTC_URL = (process.env.GO2RTC_URL || 'http://go2rtc:1984').replace(/\/$/, '');
const CAMS = [
  { id: 'front_door',  name: 'Front Door',  entity: 'camera.front_door_snapshot',  motion: 'binary_sensor.front_door_motion' },
  { id: 'living_room', name: 'Living Room', entity: 'camera.living_room_snapshot', motion: 'binary_sensor.living_room_motion' },
  { id: 'garage',      name: 'Garage',      entity: 'camera.garage_snapshot',      motion: 'binary_sensor.garage_motion' },
];
const CAM_IDS = new Set(CAMS.map(c => c.id));
const rc = { cache: null, at: 0 };

async function ringCameras(req, res) {
  if (rc.cache && Date.now() - rc.at < 5000) return json(res, 200, rc.cache);
  const all = await haFetch('/api/states');
  const st = new Map(all.map(e => [e.entity_id, e]));
  rc.cache = { cameras: CAMS.map(c => {
    const cam = st.get(c.entity), m = st.get(c.motion);
    return { id: c.id, name: c.name,
      online: !!cam && cam.state !== 'unavailable' && cam.state !== 'unknown',
      motion: m?.state === 'on', lastMotion: m?.attributes?.lastMotionTime || null };
  }) };
  rc.at = Date.now();
  json(res, 200, rc.cache);
}

function camsPage(req, res, url) {
  const one = url.searchParams.get('src');
  const list = one && CAM_IDS.has(one) ? CAMS.filter(c => c.id === one) : CAMS;
  const title = list.length === 1 ? list[0].name + ' — NasDash Security' : 'NasDash Security';
  const tiles = list.map(c => `<div class="tile" data-id="${c.id}"><div class="lbl"><i></i>${c.name}</div></div>`).join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script type="module" src="/cams/video-stream.js"></script>
<style>
html,body{margin:0;height:100%;background:#000;color:#c9d0da;font-family:'IBM Plex Mono',ui-monospace,Consolas,monospace;overflow:hidden}
.grid{display:grid;height:100vh;gap:2px;background:#0b0d11;grid-template-columns:repeat(var(--cols,1),1fr);grid-auto-rows:1fr}
.tile{position:relative;background:#000;overflow:hidden;cursor:pointer}
.grid.focus .tile{display:none}.grid.focus .tile.on{display:block;grid-column:1/-1;grid-row:1/-1}
video-stream{position:absolute;inset:0;display:block}
video-stream video{width:100%!important;height:100%!important;object-fit:contain;background:#000}
.lbl{position:absolute;left:8px;top:8px;z-index:2;font-size:12px;padding:3px 9px;background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.14)}
.lbl i{display:inline-block;width:7px;height:7px;background:#22c55e;margin-right:7px;vertical-align:1px}
.hud{position:fixed;right:10px;bottom:8px;z-index:3;font-size:11px;color:#7a8494;background:rgba(0,0,0,.5);padding:2px 8px}
</style></head><body>
<div class="grid" id="g">${tiles}</div>
<div class="hud" id="hud"></div>
<script>
const g = document.getElementById('g'), n = g.children.length;
// go2rtc's player takes its settings as properties (not attributes), once the
// component is defined: mode first, then src (setting src connects).
customElements.whenDefined('video-stream').then(() => {
  for (const t of g.querySelectorAll('.tile')) {
    const v = document.createElement('video-stream');
    v.mode = 'mse';
    v.src = new URL('/cams/ws?src=' + t.dataset.id, location.href);
    t.appendChild(v);
  }
});
function layout(){ const wide = innerWidth / innerHeight > 2.1; g.style.setProperty('--cols', n === 1 ? 1 : (n === 3 && wide) ? 3 : 2); }
addEventListener('resize', layout); layout();
// In the grid: click a camera to focus it, click again to go back. F toggles fullscreen.
if (n > 1) g.addEventListener('click', e => { const t = e.target.closest('.tile'); if (!t) return;
  if (g.classList.contains('focus')) { g.classList.remove('focus'); t.classList.remove('on'); } else { g.classList.add('focus'); t.classList.add('on'); } });
addEventListener('keydown', e => { if (e.key === 'f' || e.key === 'F') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }
  if (e.key === 'Escape' && g.classList.contains('focus')) { g.classList.remove('focus'); g.querySelectorAll('.on').forEach(x => x.classList.remove('on')); } });
const hud = document.getElementById('hud');
setInterval(() => { hud.textContent = new Date().toLocaleTimeString() + (n > 1 ? '  ·  click a camera to focus  ·  F fullscreen' : '  ·  F fullscreen'); }, 1000);
</script></body></html>`);
}

async function camsAsset(req, res, name) {
  if (!/^video-(stream|rtc)\.js$/.test(name)) return json(res, 404, { error: 'not found' });
  const r = await fetch(GO2RTC_URL + '/' + name);
  if (!r.ok) throw new UpstreamError(r.status, 'go2rtc ' + name);
  res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=3600' });
  res.end(await r.text());
}

// WebSocket relay: /cams/ws?src=<camera> → go2rtc /api/ws?src=<camera>
function camsUpgrade(req, socket, head) {
  let u; try { u = new URL(req.url, 'http://x'); } catch { return socket.destroy(); }
  const src = u.searchParams.get('src');
  if (u.pathname !== '/cams/ws' || !CAM_IDS.has(src)) return socket.destroy();
  const g = new URL(GO2RTC_URL);
  const up = net.connect(Number(g.port) || 80, g.hostname, () => {
    let hdr = `GET /api/ws?src=${encodeURIComponent(src)} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (!/^host$/i.test(req.rawHeaders[i])) hdr += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    hdr += `Host: ${g.host}\r\n\r\n`;
    up.write(hdr);
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}


// ═══ Services card: app list with up/down status ═════════════════════════════
// Any HTTP answer below 500 (including login redirects) counts as online.
const SERVICES = [
  { id: 'radarr',   name: 'Radarr',   url: 'http://192.168.0.190:7878', icon: 'radarr' },
  { id: 'sonarr',   name: 'Sonarr',   url: 'http://192.168.0.190:8989', icon: 'sonarr' },
  { id: 'bazarr',   name: 'Bazarr',   url: 'http://192.168.0.190:6767', icon: 'bazarr' },
  { id: 'prowlarr', name: 'Prowlarr', url: 'http://192.168.0.190:9696', icon: 'prowlarr' },
  { id: 'hunterr',  name: 'Hunterr',  url: 'http://192.168.0.190:9878', icon: null },
];
const svc = { cache: null, at: 0 };
const ARR_KEYS = { radarr: process.env.RADARR_KEY, sonarr: process.env.SONARR_KEY, bazarr: process.env.BAZARR_KEY, prowlarr: process.env.PROWLARR_KEY };
// Extra up/down checks used for status badges on other cards.
const HEALTH = [
  { id: 'openwebui', url: 'http://192.168.0.26:3000' },
  { id: 'speedtest', url: 'http://192.168.0.190:7791/summary' },
  { id: 'homeassistant', url: 'http://192.168.0.26:8123' },
];
const statsCache = new Map();   // id -> { at, ttl, data }

async function getJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}
async function cached(key, ttl, fn) {
  const c = statsCache.get(key);
  if (c && Date.now() - c.at < ttl) return c.data;
  try { const data = await fn(); statsCache.set(key, { at: Date.now(), data }); return data; }
  catch { return c ? c.data : null; }
}

async function arrStats(id) {
  const k = ARR_KEYS[id]; if (!k) return null;
  const H = { 'X-Api-Key': k };
  if (id === 'radarr') {
    const lib = await cached('radarr-lib', 300000, async () => {
      const m = await getJson('http://192.168.0.190:7878/api/v3/movie', H);
      return { library: m.length, missing: m.filter(x => x.monitored && !x.hasFile).length, wanted: m.filter(x => x.monitored && !x.hasFile && x.isAvailable).length };
    });
    const q = await cached('radarr-q', 30000, async () => (await getJson('http://192.168.0.190:7878/api/v3/queue?pageSize=1', H)).totalRecords);
    return lib && { ...lib, queued: q ?? 0 };
  }
  if (id === 'sonarr') {
    const lib = await cached('sonarr-lib', 300000, async () => (await getJson('http://192.168.0.190:8989/api/v3/series', H)).length);
    const w = await cached('sonarr-w', 60000, async () => (await getJson('http://192.168.0.190:8989/api/v3/wanted/missing?pageSize=1', H)).totalRecords);
    const q = await cached('sonarr-q', 30000, async () => (await getJson('http://192.168.0.190:8989/api/v3/queue?pageSize=1', H)).totalRecords);
    return { library: lib, wanted: w, queued: q ?? 0 };
  }
  if (id === 'bazarr') {
    return await cached('bazarr', 120000, async () => {
      const B = { 'X-API-KEY': k };
      const e = await getJson('http://192.168.0.190:6767/api/episodes/wanted?length=1', B);
      const m = await getJson('http://192.168.0.190:6767/api/movies/wanted?length=1', B);
      return { subsEpisodes: e.total ?? 0, subsMovies: m.total ?? 0 };
    });
  }
  if (id === 'prowlarr') {
    return await cached('prowlarr', 120000, async () => {
      const idx = await getJson('http://192.168.0.190:9696/api/v1/indexer', H);
      const st = await getJson('http://192.168.0.190:9696/api/v1/indexerstatus', H);
      const enabled = idx.filter(x => x.enable);
      const failingIds = new Set(st.filter(x => x.disabledTill && new Date(x.disabledTill) > new Date()).map(x => x.indexerId));
      return { indexers: enabled.length, failing: enabled.filter(x => failingIds.has(x.id)).length };
    });
  }
  return null;
}

async function servicesStatus(req, res) {
  if (svc.cache && Date.now() - svc.at < 15000) return json(res, 200, svc.cache);
  const ping = async x => {
    const t0 = Date.now();
    try {
      const r = await fetch(x.url, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
      return { online: r.status < 500, ms: Date.now() - t0 };
    } catch { return { online: false, ms: null }; }
  };
  const [services, health] = await Promise.all([
    Promise.all(SERVICES.map(async x => {
      const p = await ping(x);
      return { ...x, ...p, stats: p.online ? await arrStats(x.id).catch(() => null) : null };
    })),
    Promise.all(HEALTH.map(async x => ({ id: x.id, ...(await ping(x)) }))),
  ]);
  svc.cache = { services, health: Object.fromEntries(health.map(h => [h.id, h.online])) }; svc.at = Date.now();
  json(res, 200, svc.cache);
}


// ═══ System detail panels (NAS / JARVIS tiles) ═══════════════════════════════
// Beszel for live stats; Unraid's status files (/emhttp, read-only mount) for
// array/parity/disks; llama.cpp health + model name for JARVIS (never /slots:
// that can contain conversation text).
function readIni(file) {
  const out = {}; let sec = null;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\[(.+)\]$/); if (m) { sec = m[1].replace(/"/g, ''); out[sec] = {}; continue; }
      const kv = line.match(/^([^=]+)="?(.*?)"?$/); if (!kv) continue;
      if (sec) out[sec][kv[1]] = kv[2]; else out[kv[1]] = kv[2];
    }
  } catch { return null; }
  return out;
}

function unraidDetail() {
  const v = readIni('/emhttp/var.ini'), d = readIni('/emhttp/disks.ini');
  if (!v || !d) return null;
  const num = x => Number(x) || 0;
  const disks = Object.values(d).filter(x => x.status && x.status !== 'DISK_NP' && x.name).map(x => ({
    name: x.name, type: x.type, status: x.status,
    temp: x.temp === '*' || x.temp === '' ? null : num(x.temp), spunDown: x.temp === '*',
    errors: num(x.numErrors),
    sizeKB: num(x.fsSize) || null, usedKB: x.fsSize ? num(x.fsSize) - num(x.fsFree) : null,
  }));
  const running = num(v.mdResync) > 0 && num(v.mdResyncPos) > 0;
  const kbps = num(v.mdResyncDt) ? num(v.mdResyncDb) / num(v.mdResyncDt) : 0;   // KB per second
  return {
    state: v.mdState, numDisks: num(v.mdNumDisks),
    disabled: num(v.mdNumDisabled), invalid: num(v.mdNumInvalid), missing: num(v.mdNumMissing),
    parity: {
      running, action: v.mdResyncAction,
      pct: running ? Math.round(num(v.mdResyncPos) / num(v.mdResyncSize) * 1000) / 10 : null,
      speedMBs: running ? Math.round(kbps / 1024 * 10) / 10 : null,
      etaSec: running && kbps ? Math.round((num(v.mdResyncSize) - num(v.mdResyncPos)) / kbps) : null,
      lastStart: num(v.sbSynced) || null, lastEnd: num(v.sbSynced2) || null,
      lastErrors: num(v.sbSyncErrs), lastExit: num(v.sbSyncExit),
    },
    disks,
  };
}

async function systemDetail(req, res, url) {
  const name = url.searchParams.get('name');
  if (!['NAS', 'JARVIS', 'PC'].includes(name)) return json(res, 400, { error: 'unknown system' });
  const { items = [] } = await bzGet('/api/collections/systems/records?perPage=50&fields=id,name,status,info');
  const sys = items.find(x => x.name === name);
  if (!sys) return json(res, 404, { error: 'system not in Beszel' });
  const flt = encodeURIComponent(`system='${sys.id}'`);
  const [st, ct] = await Promise.all([
    bzGet(`/api/collections/system_stats/records?perPage=1&sort=-created&filter=${encodeURIComponent(`system='${sys.id}' && type='1m'`)}`),
    bzGet(`/api/collections/container_stats/records?perPage=1&sort=-created&filter=${flt}`).catch(() => ({ items: [] })),
  ]);
  const x = st.items?.[0]?.stats || {}, info = sys.info || {};
  const temps = Object.entries(x.t || {}).map(([k, v]) => ({ name: k, c: Math.round(v) })).filter(t => t.c > 0 && t.c < 120).sort((a, b) => b.c - a.c);
  const gpus = Object.values(x.g || {}).map(g => ({ name: shortGpu(g.n), util: round(g.u), vramUsedMB: round(g.mu), vramTotalMB: round(g.mt), power: round(g.p, 1),
    temp: round((x.t || {})[g.n] ?? (x.t || {})[String(g.n).replace(/\s+\d{1,2}$/, '')] ?? null) }));
  const containers = (ct.items?.[0]?.stats || []).map(c => ({ name: c.n, cpu: round(c.c, 1), memMB: round(c.m) })).sort((a, b) => b.memMB - a.memMB);
  const out = {
    name, status: sys.status, uptime: info.u || 0, load: x.la || info.la || null,
    cpu: round(x.cpu, 1),
    mem: { usedGB: round(x.mu, 1), totalGB: round(x.m, 1), pct: round(x.mp) },
    swap: x.s ? { usedGB: round(x.su, 1), totalGB: round(x.s, 1) } : null,
    disk: { usedGB: round(x.du), totalGB: round(x.d), pct: round(x.dp) },
    net: Array.isArray(x.b) ? { sentBps: x.b[0], recvBps: x.b[1] } : null,
    diskIO: Array.isArray(x.dio) ? { readBps: x.dio[0], writeBps: x.dio[1] } : null,
    temps: temps.slice(0, 8),
    fans: Object.entries(x.f || {}).filter(([, v]) => v > 0).map(([k, v]) => ({ name: k.replace(/^nct\d+_/, ''), rpm: Math.round(v) })),
    gpus,
    containers: { running: containers.length, top: containers.slice(0, 6) },
  };
  if (name === 'NAS') out.unraid = unraidDetail();
  if (name === 'JARVIS') {
    try {
      const h = await fetch('http://192.168.0.26:8080/health', { signal: AbortSignal.timeout(3000) });
      const m = await fetch('http://192.168.0.26:8080/v1/models', { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null);
      const id = m?.data?.[0]?.id || '';
      out.llm = { ok: h.ok, server: 'llama.cpp', model: id.split('/').pop().replace(/\.gguf$/i, '') || null };
    } catch { out.llm = { ok: false, server: 'llama.cpp', model: null }; }
  }
  json(res, 200, out);
}


// ═══ JARVIS quick chat (dashboard) → llama.cpp on JARVIS ══════════════════════
// Relays a short conversation and streams the reply back (SSE). Nothing is
// stored or logged: the conversation only lives in the open dashboard page.
const LLM_URL = 'http://192.168.0.26:8080';
const LLM_SYSTEM = [
  'You are JARVIS, Anthony\'s personal AI assistant, answering quick questions from his desktop dashboard.',
  'Facts about yourself (these are true; state them plainly if asked):',
  '- You are the open-weight Qwen3.8-27B language model (made by Alibaba\'s Qwen team), running locally on Anthony\'s own',
  '  server "JARVIS" at home via llama.cpp on his RTX 4070 Ti Super GPUs.',
  '- You are NOT Claude, NOT ChatGPT, and have no connection to Anthropic, OpenAI or any cloud service.',
  '  Your training data included text from other AI assistants, which is why you may feel inclined to claim',
  '  another identity; do not.',
  '- Nothing you process leaves his home network. This dashboard chat is not saved anywhere.',
  '- You have no tools, no internet access and no ability to run commands, install software or change settings.',
  '  Never offer to set things up or take actions; explain how Anthony could do it instead.',
  '- Your knowledge stops at your training date. For fast-moving topics (software versions, new AI models, prices,',
  '  news) say that your information may be out of date.',
  'Style: concise and direct; a few sentences or a short list unless asked for more. Use Markdown for code.',
].join('\n');

async function llmInfo(req, res) {
  try {
    const [h, m] = await Promise.all([
      fetch(LLM_URL + '/health', { signal: AbortSignal.timeout(3000) }),
      fetch(LLM_URL + '/v1/models', { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null),
    ]);
    const id = m?.data?.[0]?.id || '';
    json(res, 200, { ok: h.ok, model: id.split('/').pop().replace(/\.gguf$/i, '') || null });
  } catch { json(res, 200, { ok: false, model: null }); }
}

async function llmChat(req, res) {
  const b = await readBody(req);
  // Only user/assistant turns with plain text; keep the last 12 and cap total size.
  let msgs = (Array.isArray(b.messages) ? b.messages : [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12).map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
  while (msgs.reduce((a, m) => a + m.content.length, 0) > 24000 && msgs.length > 1) msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json(res, 400, { error: 'no question' });

  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());          // user closed/cleared: stop generating
  let up;
  try {
    up = await fetch(LLM_URL + '/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'system', content: LLM_SYSTEM }, ...msgs], stream: true,
        max_tokens: 1200, temperature: 0.6, chat_template_kwargs: { enable_thinking: false } }),
    });
  } catch { return json(res, 502, { error: 'JARVIS is not responding' }); }
  if (!up.ok || !up.body) return json(res, 502, { error: 'JARVIS error ' + up.status });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  try { for await (const chunk of up.body) res.write(chunk); } catch {}
  res.end();
}

// ─── router ─────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean);

  try {
    if (p === '/health') return json(res, 200, {
      ok: true, absSessions: sessions.size,
      spotify: !SP_ID ? 'unconfigured' : sp.expired ? 'expired' : sp.refreshToken ? 'connected' : 'not-connected',
    });

    if (p === '/systems') return await systemsHandler(req, res);
    if (p === '/system/detail' && req.method === 'GET') return await systemDetail(req, res, url);
    if (p === '/services/status' && req.method === 'GET') return await servicesStatus(req, res);
    if (p === '/llm/info' && req.method === 'GET') return await llmInfo(req, res);
    if (p === '/llm/chat' && req.method === 'POST') return await llmChat(req, res);
    if (p === '/ring/cameras' && req.method === 'GET') {
      if (!HA_URL || !HA_TOKEN) return json(res, 503, { error: 'Home Assistant not configured' });
      return await ringCameras(req, res);
    }
    if (p === '/cams' && req.method === 'GET') return camsPage(req, res, url);
    if (p.startsWith('/cams/') && req.method === 'GET') return await camsAsset(req, res, p.slice(6));
    if (p.startsWith('/sab/')) {
      if (!SAB_URL || !SAB_KEY) return json(res, 503, { error: 'SABnzbd not configured' });
      if (req.method === 'GET' && p === '/sab/queue') return await sabQueue(req, res);
      if (req.method === 'POST' && (p === '/sab/pause' || p === '/sab/resume')) return await sabControl(req, res, p.split('/')[2]);
    }
    if (p.startsWith('/plex/')) {
      if (!PLEX_URL || !PLEX_TOKEN) return json(res, 503, { error: 'Plex not configured' });
      if (p === '/plex/sessions') return await plexSessions(req, res);
      if (p === '/plex/thumb') return await plexThumb(req, res, url);
    }
    if (p === '/steam/friends' && req.method === 'GET') return await steamFriends(req, res);

    if (seg[0] === 'ha' && seg.length === 2) {
      if (!HA_URL || !HA_TOKEN) return json(res, 503, { error: 'Home Assistant not configured' });
      if (req.method === 'GET'  && seg[1] === 'state') return await haState(req, res);
      if (req.method === 'POST' && ['light', 'fan', 'ac'].includes(seg[1])) return await haControl(req, res, seg[1]);
    }

    if (seg[0] === 'abs') {
      if (!ABS_URL || !ABS_KEY) return json(res, 503, { error: 'ABS not configured' });
      if (req.method === 'GET'  && seg[1] === 'current' && seg.length === 2) return await absCurrent(req, res);
      if (req.method === 'GET'  && seg[1] === 'in-progress' && seg.length === 2) return await absInProgress(req, res);
      if (req.method === 'GET'  && seg[1] === 'cover'   && seg.length === 3) return await absCover(req, res, seg[2]);
      if (req.method === 'POST' && seg[1] === 'play'    && seg.length === 3) return await absPlay(req, res, seg[2]);
      if (req.method === 'GET'  && seg[1] === 'stream'  && seg.length === 4) return await absStream(req, res, seg[2], seg[3]);
      if (req.method === 'POST' && seg[1] === 'sync'    && seg.length === 3) return await absSync(req, res, seg[2], false);
      if (req.method === 'POST' && seg[1] === 'close'   && seg.length === 3) return await absSync(req, res, seg[2], true);
    }

    if (seg[0] === 'spotify' && seg.length === 2) {
      if (!spConfigured(res)) return;
      const a = seg[1];
      if (req.method === 'GET' && a === 'login')    return await spLogin(req, res);
      if (req.method === 'GET' && a === 'callback') return await spCallback(req, res, url);
      if (req.method === 'GET' && a === 'now')      return await spNow(req, res);
      if (req.method === 'GET' && a === 'devices')  return await spDevices(req, res);
      if (req.method === 'GET' && a === 'playlists') return await spPlaylists(req, res);
      if (req.method === 'GET' && a === 'recent')   return await spRecent(req, res);
      if (req.method === 'GET' && a === 'queue')    return await spQueue(req, res);
      if (req.method === 'GET' && a === 'top')      return await spTopArtists(req, res);
      if (req.method === 'GET' && a === '_probe')   return await spProbe(req, res);
      if (req.method === 'POST' && ['play', 'pause', 'next', 'prev', 'seek', 'volume', 'shuffle', 'repeat', 'transfer'].includes(a)) {
        return await spControl(req, res, a);
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(new Date().toISOString(), req.method, p, e.message);
    if (!res.headersSent) json(res, e.status && e.status < 500 ? e.status : 502, { error: e.message });
    else res.destroy();
  }
});

server.on('upgrade', camsUpgrade);
server.listen(PORT, () => console.log(`media-bridge listening on :${PORT} (origins: ${ORIGINS.join(', ')}; spotify: ${SP_ID ? 'configured' : 'off'})`));
