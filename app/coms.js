// NasDash "Coms": Windows default-device guard + Elgato Wave Link mic control,
// exposed to the dashboard's Coms card over a private loopback API.
// Everything runs inside NasDash's main process; the only helper is
// audiodev.exe (built from audiodev.cs in this folder, on demand).
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path'), fs = require('fs'), http = require('http');
const MiniWS = require('./miniws');

const EXE = path.join(__dirname, 'audiodev.exe');
const SRC = path.join(__dirname, 'audiodev.cs');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const PORT = 8889;

const DEFAULT_CFG = {
  enforce: true,
  outputName: 'Speakers (FiiO Q series)',
  inputName: 'Chat Mix (Elgato Virtual Audio)',
};
// Short labels for the card's buttons
const LABELS = [[/fiio/i, 'fiio'], [/Headphones \(.*Wave XLR/i, 'wave xlr'], [/VX2478|NVIDIA High Definition/i, 'monitor'],
                [/^Chat Mix/i, 'chat mix'], [/^Mic In/i, 'mic (raw)'], [/Stream Mix/i, 'stream mix'], [/Personal Mix/i, 'personal mix']];
const label = n => { for (const [re, l] of LABELS) if (re.test(n)) return l; return n.replace(/\s*\(.*\)$/, '').toLowerCase(); };
// Never offered as choices (and never left as defaults while the guard is on)
const HIDE_OUT = /Elgato Virtual Audio|Steam Streaming|DualSense/i;
const HIDE_IN = /Steam Streaming|DualSense|Recording Mix|Aux Mix/i;

module.exports.start = function start({ stateDir, origin, log = () => {} }) {
  const CFG_FILE = path.join(stateDir, 'coms.json');
  let cfg = { ...DEFAULT_CFG };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }; } catch {}
  const saveCfg = () => { try { const t = CFG_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(cfg, null, 2)); fs.renameSync(t, CFG_FILE); } catch {} };

  // ── audiodev helper (build from source if missing, e.g. after a fresh install) ──
  if (!fs.existsSync(EXE) && fs.existsSync(SRC) && fs.existsSync(CSC)) {
    try { execFileSync(CSC, ['/nologo', '/target:exe', '/platform:x64', '/out:' + EXE, SRC], { windowsHide: true }); log('coms: built audiodev.exe'); }
    catch (e) { log('coms: could not build audiodev.exe: ' + e.message); }
  }
  const run = args => new Promise(res => execFile(EXE, args, { windowsHide: true, timeout: 5000 }, (e, out) => res(e ? null : String(out).trim())));

  const st = { endpoints: [], defaults: {}, vol: null, lastFix: null, fixes: 0 };
  async function refresh() {
    const out = await run(['list']); if (!out) return;
    try { const j = JSON.parse(out); st.endpoints = j.endpoints; st.defaults = j.defaults; } catch {}
  }
  const active = (flow, name) => st.endpoints.find(e => e.flow === flow && e.state === 1 && e.name === name);

  let enforcing = false;
  async function enforce(reason) {
    if (!cfg.enforce || enforcing) return;
    enforcing = true;
    try {
      await refresh();
      const out = active('render', cfg.outputName), inp = active('capture', cfg.inputName);
      const d = st.defaults, fixed = [];
      if (out && (d.render !== out.id || d.renderComms !== out.id)) { await run(['set-default', out.id, 'all']); fixed.push('output'); }
      if (inp && (d.capture !== inp.id || d.captureComms !== inp.id)) { await run(['set-default', inp.id, 'all']); fixed.push('input'); }
      if (fixed.length) { st.lastFix = { at: Date.now(), what: fixed, reason }; st.fixes++; log('coms: restored ' + fixed.join('+') + ' (' + reason + ')'); await refresh(); }
    } finally { enforcing = false; }
  }

  // React to Windows device/default changes within milliseconds.
  let watcher = null, debounce = null;
  function startWatcher() {
    if (!fs.existsSync(EXE)) return;
    watcher = spawn(EXE, ['watch'], { windowsHide: true });
    let buf = '';
    watcher.stdout.on('data', d => {
      buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop();
      if (lines.some(l => /^(default|added|state)\t/.test(l))) { clearTimeout(debounce); debounce = setTimeout(() => enforce('device change'), 150); }
    });
    watcher.on('exit', () => { watcher = null; setTimeout(startWatcher, 3000); });
  }
  startWatcher();
  setInterval(() => enforce('periodic check'), 30000);
  enforce('startup');

  // ── Wave Link (Elgato) ──
  const wl = { ws: null, connected: false, id: 0, pending: new Map(), mic: null, meter: 0, meterAt: 0 };
  function wsInfoPort() {
    try {
      const pk = path.join(process.env.LOCALAPPDATA, 'Packages');
      const dir = fs.readdirSync(pk).find(d => /^Elgato\.WaveLink_/i.test(d));
      if (!dir) return null;
      return JSON.parse(fs.readFileSync(path.join(pk, dir, 'LocalState', 'ws-info.json'), 'utf8')).port || null;
    } catch { return null; }
  }
  function rpc(method, params) {
    return new Promise((res, rej) => {
      if (!wl.connected) return rej(new Error('wave link not connected'));
      const i = ++wl.id; wl.pending.set(i, { res, rej });
      wl.ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params: params || {} }));
      setTimeout(() => { if (wl.pending.delete(i)) rej(new Error('timeout ' + method)); }, 4000);
    });
  }
  async function readMic() {
    const r = await rpc('getInputDevices');
    const dev = (r.inputDevices || []).find(d => d.deviceType === 'commonWave') || (r.inputDevices || [])[0];
    const inp = dev?.inputs?.[0];
    if (!inp) { wl.mic = null; return; }
    const g = inp.gain || {};
    const lut = g.lookUpTable || [];
    const db = lut.length ? lut.reduce((b, p) => Math.abs(p[0] - g.value) < Math.abs(b[0] - g.value) ? p : b)[1] : Math.round((g.value || 0) * (g.max || 1));
    const was = wl.mic?.inputId;
    wl.mic = { deviceId: dev.id, inputId: inp.id, name: dev.name, muted: !!inp.isMuted, gain: g.value, gainDb: db, maxDb: g.max, lut, gainLock: !!inp.isGainLockOn };
    if (was !== inp.id) {
      // Wave Link 3.2 meters channels, not inputs: find the mic's hardware channel
      try {
        const ch = ((await rpc('getChannels')).channels || []).find(c => c.type === 'Hardware' && (c.id === inp.id || c.id === dev.id)) ||
                   ((await rpc('getChannels')).channels || []).find(c => c.type === 'Hardware');
        if (ch) { wl.meterChannel = ch.id; await rpc('setSubscription', { levelMeterChanged: { type: 'channel', id: ch.id, isEnabled: true } }); }
      } catch (e) { wl.subErr = String(e.message || e); }
    }
  }
  function connectWL() {
    const port = wsInfoPort();
    if (!port) return setTimeout(connectWL, 5000);
    const ws = new MiniWS(port, 'streamdeck://');
    wl.ws = ws;
    ws.on('open', async () => {
      wl.connected = true; wl.mic = null; log('coms: wave link connected');
      // Register like a Stream Deck plugin; Wave Link only honours subscriptions after this.
      try { await rpc('setPluginInfo', { connectedDevices: [] }); } catch {}
      try { await readMic(); } catch {}
    });
    ws.on('message', t => {
      let m; try { m = JSON.parse(t); } catch { return; }
      if (m.id && wl.pending.has(m.id)) { const p = wl.pending.get(m.id); wl.pending.delete(m.id); return m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      if (m.method === 'levelMeterChanged') {
        wl.meterMsgs = (wl.meterMsgs || 0) + 1; wl.lastMeterRaw = m.params;
        const list = m.params?.channels || m.params?.inputDevices || [];
        const e = list.find(x => x.id === wl.meterChannel) || list[0];
        if (e) { const vals = Object.entries(e).filter(([k, v]) => typeof v === 'number' && /level/i.test(k)).map(([, v]) => v); if (vals.length) { const v = Math.max(...vals); wl.meter = v > 1 ? v / 100 : v; wl.meterAt = Date.now(); } }   // 0..1
        return;
      }
      if (m.method) { clearTimeout(wl.refreshT); wl.refreshT = setTimeout(() => readMic().catch(() => {}), 150); }   // e.g. hardware mute button
    });
    const down = () => { if (wl.ws !== ws) return; wl.connected = false; wl.ws = null; for (const p of wl.pending.values()) p.rej(new Error('closed')); wl.pending.clear(); setTimeout(connectWL, 5000); };
    ws.on('close', down); ws.on('error', down);
  }
  connectWL();
  setInterval(() => { if (wl.connected) readMic().catch(() => {}); }, 5000);

  // ── state for the card ──
  async function stateJson() {
    await refresh();
    const d = st.defaults;
    const cur = id => st.endpoints.find(e => e.id === id);
    const outCur = cur(d.render), inCur = cur(d.capture);
    const vol = outCur ? await run(['vol', outCur.id]) : null;
    const pick = (flow, hide) => st.endpoints.filter(e => e.flow === flow && e.state === 1 && !hide.test(e.name)).map(e => ({ id: e.id, name: e.name, label: label(e.name) }));
    return {
      enforce: cfg.enforce,
      output: { current: outCur && { id: outCur.id, name: outCur.name, label: label(outCur.name) }, target: cfg.outputName, targetLabel: label(cfg.outputName),
                ok: !!outCur && outCur.name === cfg.outputName && d.renderComms === d.render, volume: vol ? JSON.parse(vol) : null, choices: pick('render', HIDE_OUT) },
      input: { current: inCur && { id: inCur.id, name: inCur.name, label: label(inCur.name) }, target: cfg.inputName, targetLabel: label(cfg.inputName),
               ok: !!inCur && inCur.name === cfg.inputName && d.captureComms === d.capture, choices: pick('capture', HIDE_IN) },
      mic: wl.connected && wl.mic ? { name: wl.mic.name, muted: wl.mic.muted, gainDb: wl.mic.gainDb, maxDb: wl.mic.maxDb, gainLock: wl.mic.gainLock } : null,
      waveLink: wl.connected,
      lastFix: st.lastFix,
    };
  }

  // ── loopback API (dashboard page only) ──
  const readBody = req => new Promise(res => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } }); });
  const srv = http.createServer(async (req, res) => {
    const o = req.headers.origin;
    if (o && o !== origin) { res.writeHead(403); return res.end(); }
    if (o) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-NasDash'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const u = new URL(req.url, 'http://127.0.0.1');
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === 'GET' && u.pathname === '/coms/state') return json(200, await stateJson());
      if (req.method === 'GET' && u.pathname === '/coms/debug') return json(200, { connected: wl.connected, meterChannel: wl.meterChannel || null, meterMsgs: wl.meterMsgs || 0, lastMeterRaw: wl.lastMeterRaw || null, subErr: wl.subErr || null, meterAgeMs: wl.meterAt ? Date.now() - wl.meterAt : null, mic: wl.mic && { inputId: wl.mic.inputId } });
      if (req.method === 'GET' && u.pathname === '/coms/meter') return json(200, { level: Date.now() - wl.meterAt < 1000 ? wl.meter : 0, muted: !!wl.mic?.muted });
      if (req.method !== 'POST' || req.headers['x-nasdash'] !== '1') return json(404, { error: 'not found' });
      const b = await readBody(req);
      if (u.pathname === '/coms/output' || u.pathname === '/coms/input') {
        const flow = u.pathname.endsWith('output') ? 'render' : 'capture';
        const e = st.endpoints.find(x => x.id === b.id && x.flow === flow && x.state === 1);
        if (!e) return json(400, { error: 'unknown device' });
        if (flow === 'render') cfg.outputName = e.name; else cfg.inputName = e.name;
        saveCfg(); await run(['set-default', e.id, 'all']);
        return json(200, await stateJson());
      }
      if (u.pathname === '/coms/volume') {
        await refresh(); const id = st.defaults.render; if (!id) return json(400, { error: 'no output' });
        if (b.volume != null) await run(['setvol', id, String(Math.max(0, Math.min(100, Math.round(+b.volume))))]);
        if (b.muted != null) await run(['mute', id, b.muted ? '1' : '0']);
        return json(200, await stateJson());
      }
      if (u.pathname === '/coms/mic') {
        if (!wl.mic) return json(503, { error: 'wave link not connected' });
        const upd = { id: wl.mic.inputId };
        if (b.muted != null) upd.isMuted = !!b.muted;
        if (b.gainDb != null) {
          const target = Math.max(0, Math.min(wl.mic.maxDb || 80, +b.gainDb));
          const p = wl.mic.lut.length ? wl.mic.lut.reduce((best, x) => Math.abs(x[1] - target) < Math.abs(best[1] - target) ? x : best) : [target / (wl.mic.maxDb || 1)];
          upd.gain = { value: p[0] };
        }
        await rpc('setInputDevice', { id: wl.mic.deviceId, inputs: [upd] });
        await readMic();
        return json(200, await stateJson());
      }
      if (u.pathname === '/coms/enforce') { cfg.enforce = !!b.on; saveCfg(); if (cfg.enforce) await enforce('guard enabled'); return json(200, await stateJson()); }
      return json(404, { error: 'not found' });
    } catch (e) { return json(500, { error: String(e.message || e) }); }
  });
  srv.on('error', e => log('coms: api failed: ' + e.message));
  srv.listen(PORT, '127.0.0.1');
  return { stop() { try { watcher?.kill(); } catch {} try { srv.close(); } catch {} try { wl.ws?.close(); } catch {} } };
};
