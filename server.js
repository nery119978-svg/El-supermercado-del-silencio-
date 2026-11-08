/* Servidor multijugador de "El Supermercado del Silencio".
   Sin dependencias: solo Node 18+. Sirve el juego en "/" y las salas por WebSocket en "/ws".
   Uso:  node server.js   (o npm start)   -> http://localhost:3000   */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const MAX_ROOM = 12;            // jugadores por sala
const MAX_FRAME = 64 * 1024;    // bytes por mensaje
const FLUSH_MS = 100;           // cada cuánto se reparte la lista de jugadores
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const INDEX = path.join(__dirname, 'public', 'index.html');

/* ---------- HTTP: sirve el juego ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (url !== '/' && url !== '/index.html') { res.writeHead(404); res.end('No encontrado'); return; }
  fs.readFile(INDEX, 'utf8', (err, html) => {
    if (err) { res.writeHead(500); res.end('Falta public/index.html'); return; }
    /* marca para que el juego sepa que este servidor le ofrece las salas */
    html = html.replace('<head>', '<head><script>window.SSIL_SERVER=true;</script>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(html);
  });
});

/* ---------- WebSocket mínimo (RFC 6455) ---------- */
function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

class Client {
  constructor(socket) {
    this.socket = socket;
    this.id = 'p' + crypto.randomBytes(4).toString('hex');
    this.room = null;
    this.presence = {};
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.fragOp = 0;
    this.alive = true;
    this.msgs = 0;
    this.winStart = Date.now();
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }
  send(obj) {
    if (!this.alive) return;
    try { this.socket.write(frame(0x1, Buffer.from(JSON.stringify(obj)))); } catch (e) { this.close(); }
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > MAX_FRAME * 2) { this.kill(); return; }
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; const big = this.buf.readBigUInt64BE(2); if (big > BigInt(MAX_FRAME)) { this.kill(); return; } len = Number(big); off = 10; }
      if (len > MAX_FRAME) { this.kill(); return; }
      if (!masked) { this.kill(); return; }              // los clientes siempre enmascaran
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const data = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) { try { this.socket.write(frame(0x8, Buffer.alloc(0))); } catch (e) {} this.close(); return; }
      if (op === 0x9) { try { this.socket.write(frame(0xA, data)); } catch (e) {} continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2) { this.frag = [data]; this.fragOp = op; }
      else if (op === 0x0) this.frag.push(data);
      else continue;
      if (fin) {
        const whole = Buffer.concat(this.frag); this.frag = [];
        if (this.fragOp === 0x1) this.onText(whole.toString('utf8'));
      }
    }
  }
  onText(text) {
    /* límite de ritmo: 120 mensajes por segundo como máximo */
    const now = Date.now();
    if (now - this.winStart > 1000) { this.winStart = now; this.msgs = 0; }
    if (++this.msgs > 120) return;
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') this.join(m.room);
    else if (m.t === 'leave') this.leave();
    else if (!this.room) return;
    else if (m.t === 'presence') {
      if (!m.patch || typeof m.patch !== 'object') return;
      const next = Object.assign({}, this.presence, m.patch);
      if (JSON.stringify(next).length > 4096) return;
      this.presence = next; this.room.dirty = true;
    } else if (m.t === 'emit') {
      if (typeof m.topic !== 'string' || m.topic.length > 32) return;
      const out = { t: 'msg', topic: m.topic, from: this.id, data: m.data };
      for (const c of this.room.clients) if (c !== this) c.send(out);
    }
  }
  join(name) {
    name = String(name || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 48);
    if (!name) return;
    this.leave();
    let r = rooms.get(name);
    if (!r) { r = { name, clients: new Set(), dirty: false }; rooms.set(name, r); }
    if (r.clients.size >= MAX_ROOM) { this.send({ t: 'error', error: 'room_full' }); try { this.socket.end(); } catch (e) {} return; }
    r.clients.add(this); this.room = r; this.presence = {};
    this.send({ t: 'welcome', id: this.id });
    r.dirty = true; flushRoom(r);
  }
  leave() {
    if (!this.room) return;
    const r = this.room; r.clients.delete(this); this.room = null;
    if (!r.clients.size) rooms.delete(r.name); else { r.dirty = true; flushRoom(r); }
  }
  kill() { try { this.socket.destroy(); } catch (e) {} this.close(); }
  close() { if (!this.alive) return; this.leave(); this.alive = false; }
}

const rooms = new Map();
function flushRoom(r) {
  r.dirty = false;
  const peers = [...r.clients].map(c => ({ peer: c.id, presence: c.presence }));
  const out = { t: 'peers', peers };
  for (const c of r.clients) c.send(out);
}
setInterval(() => { for (const r of rooms.values()) if (r.dirty) flushRoom(r); }, FLUSH_MS);

server.on('upgrade', (req, socket) => {
  const url = (req.url || '').split('?')[0];
  const key = req.headers['sec-websocket-key'];
  if (url !== '/ws' || !key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  new Client(socket);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('El Supermercado del Silencio - servidor listo en http://localhost:' + PORT);
    const nets = require('os').networkInterfaces();
    Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).forEach(n => console.log('  En tu red local: http://' + n.address + ':' + PORT));
  });
}
module.exports = { server, rooms };
