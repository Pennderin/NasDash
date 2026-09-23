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

server.listen(PORT, () => console.log(`media-bridge listening on :${PORT} (origins: ${ORIGINS.join(', ')}; spotify: ${SP_ID ? 'configured' : 'off'})`));
