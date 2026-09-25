// door-toggle — tiny sidecar that lets the NasDash dashboard start/stop ONE
// container (claude-door) and nothing else. It holds the Docker socket so the
// LAN-facing media-bridge never has to. Runs on the private `nasdash` network
// with no published ports; only media-bridge talks to it.
//
//   GET  /status   -> { state, running, startedAt, busy: 'start'|'stop'|null, error }
//   POST /start    returns at once; the start runs in the background
//   POST /stop     (same; docker gives it up to 10 s to exit cleanly)
'use strict';
const http = require('http');

const TARGET = 'claude-door';          // hard-coded on purpose: the only container this can touch
const PORT = 7793;

function docker(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: '/var/run/docker.sock', method, path, timeout: 30000 }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('docker timeout')));
    req.on('error', reject);
    req.end();
  });
}

let busy = null, lastError = null;

async function status() {
  const r = await docker('GET', `/containers/${TARGET}/json`);
  if (r.status === 404) return { state: 'missing', running: false, busy, error: lastError };
  if (r.status !== 200) throw new Error('docker ' + r.status);
  const s = JSON.parse(r.body).State || {};
  return { state: s.Status, running: !!s.Running, startedAt: s.StartedAt || null, busy, error: lastError };
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, await status());
    if (req.method === 'POST' && (req.url === '/start' || req.url === '/stop')) {
      const action = req.url.slice(1);
      if (!busy) {
        busy = action; lastError = null;
        console.log(new Date().toISOString(), action, TARGET);
        docker('POST', `/containers/${TARGET}/${action}?t=10`)
          .then(r => { if (r.status !== 204 && r.status !== 304) lastError = `${action} failed: docker ${r.status}`; })
          .catch(e => { lastError = `${action} failed: ${e.message}`; })
          .finally(() => { busy = null; });
      }
      return send(res, 202, await status());
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 502, { error: e.message }); }
}).listen(PORT, () => console.log(`door-toggle on :${PORT}, target ${TARGET}`));
