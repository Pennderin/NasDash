// Minimal WebSocket client (RFC 6455) that can send a custom Origin header,
// which Wave Link 3 requires (Origin: streamdeck://). No dependencies.
const net = require('net'), crypto = require('crypto'), EventEmitter = require('events');
class MiniWS extends EventEmitter {
  constructor(port, origin) {
    super(); this.buf = Buffer.alloc(0); this.open = false; this.frag = null;
    this.sock = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      this.sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
    });
    this.sock.on('data', d => this._data(d));
    this.sock.on('error', e => this.emit('error', e));
    this.sock.on('close', () => { this.open = false; this.emit('close'); });
  }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (!this.open) {
      const i = this.buf.indexOf('\r\n\r\n'); if (i < 0) return;
      const head = this.buf.slice(0, i).toString(); this.buf = this.buf.slice(i + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) { this.emit('error', new Error('handshake: ' + head.split('\r\n')[0])); this.sock.destroy(); return; }
      this.open = true; this.emit('open');
    }
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1]; let len = b1 & 127, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const masked = b1 & 128; if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.slice(off, off + len);
      if (masked) { const m = this.buf.slice(off - 4, off); payload = Buffer.from(payload.map((x, i) => x ^ m[i % 4])); }
      this.buf = this.buf.slice(off + len);
      const op = b0 & 15, fin = b0 & 128;
      if (op === 8) { this.sock.end(); return; }
      if (op === 9) { this._send(payload, 10); continue; }
      if (op === 1 || op === 2) this.frag = payload; else if (op === 0 && this.frag) this.frag = Buffer.concat([this.frag, payload]);
      if (fin && this.frag) { const msg = this.frag.toString('utf8'); this.frag = null; this.emit('message', msg); }
    }
  }
  _send(payload, op) {
    const len = payload.length, mask = crypto.randomBytes(4);
    const head = len < 126 ? Buffer.from([128 | op, 128 | len]) : len < 65536 ? Buffer.from([128 | op, 128 | 126, len >> 8, len & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 128 | 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
    this.sock.write(Buffer.concat([head, mask, Buffer.from(payload.map((x, i) => x ^ mask[i % 4]))]));
  }
  send(text) { this._send(Buffer.from(text, 'utf8'), 1); }
  close() { try { this._send(Buffer.alloc(0), 8); } catch {} this.sock.end(); }
}
module.exports = MiniWS;

if (require.main === module) {
  const fs = require('fs');
  const port = JSON.parse(fs.readFileSync(process.env.LOCALAPPDATA + '\\Packages\\Elgato.WaveLink_g54w8ztgkx496\\LocalState\\ws-info.json', 'utf8')).port;
  const ws = new MiniWS(port, 'streamdeck://');
  let id = 0; const pending = new Map();
  const call = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params: params || {} })); setTimeout(() => rej(new Error('timeout ' + method)), 4000); });
  ws.on('message', t => { const m = JSON.parse(t); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  ws.on('error', e => { console.log('error', e.message); process.exit(0); });
  ws.on('open', async () => {
    for (const m of ['getApplicationInfo', 'getInputDevices', 'getOutputDevices', 'getMixes', 'getChannels']) {
      try { const r = await call(m); console.log('\n== ' + m + '\n' + JSON.stringify(r).slice(0, 2200)); } catch (e) { console.log('\n== ' + m + ' ERROR ' + e.message); }
    }
    ws.close(); process.exit(0);
  });
  setTimeout(() => { console.log('overall timeout'); process.exit(0); }, 20000);
}
