// HTTP(정적 파일) + WebSocket 게임 서버
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./game');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = +process.env.MAX_PER_ROOM || 30;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

const rooms = new Map();
let nextRoomId = 1;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === '/status') {
    let players = 0;
    for (const r of rooms.values()) players += r.clients.size;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ players, rooms: rooms.size }));
  }
  const file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 4096,
  perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 3 } }, // JSON 압축으로 대역폭 절약
});

function findRoom() {
  for (const r of rooms.values()) if (r.clients.size < MAX_PER_ROOM) return r;
  const r = new Room(nextRoomId++);
  rooms.set(r.id, r);
  return r;
}

wss.on('connection', (ws) => {
  const c = { ws, name: '플레이어', room: null, pid: null, spec: null, msgCount: 0 };
  ws.on('message', (data) => {
    if (++c.msgCount > 200) return; // 1초에 200개 넘게 보내면 무시
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'join' && !c.room) {
      c.name = String(m.name || '').replace(/[<>]/g, '').trim().slice(0, 14) || '플레이어' + Math.floor(Math.random() * 1000);
      c.room = findRoom();
      c.room.addClient(c);
      return;
    }
    if (c.room) c.room.onMessage(c, m);
  });
  ws.on('close', () => {
    if (!c.room) return;
    c.room.removeClient(c);
    if (c.room.clients.size === 0) { c.room.destroy(); rooms.delete(c.room.id); }
  });
  const iv = setInterval(() => { c.msgCount = 0; }, 1000);
  ws.on('close', () => clearInterval(iv));
});

server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
