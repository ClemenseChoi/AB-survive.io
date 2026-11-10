// HTTP(정적 파일) + WebSocket 게임 서버
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./game');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const MAX_PER_ROOM = +process.env.MAX_PER_ROOM || 30;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

const rooms = new Map();
let nextRoomId = 1;

// ---------------- 계정 API ----------------
const authHits = new Map(); // IP별 로그인/가입 시도 횟수 (무차별 대입 방지)
setInterval(() => authHits.clear(), 60 * 1000);
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function bearer(req) { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; }

async function handleApi(req, res, url) {
  if (!db.enabled()) return json(res, 503, { error: '지금은 로그인 기능을 쓸 수 없어요.' });
  try {
    if (req.method === 'POST' && (url === '/api/register' || url === '/api/login')) {
      const ip = clientIp(req);
      const n = (authHits.get(ip) || 0) + 1; authHits.set(ip, n);
      if (n > 10) return json(res, 429, { error: '시도가 너무 많아요. 1분 뒤에 다시 해 주세요.' });
      const b = await readBody(req);
      const r = url === '/api/register' ? await db.register(b.username, b.password) : await db.login(b.username, b.password);
      return json(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'POST' && url === '/api/logout') { await db.logout(bearer(req)); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && url === '/api/me') {
      const u = await db.userByToken(bearer(req));
      if (!u) return json(res, 401, { error: '로그인이 필요해요.' });
      return json(res, 200, { user: u, ...(await db.profile(u.id)) });
    }
    if (req.method === 'GET' && url === '/api/leaderboard') return json(res, 200, { top: await db.leaderboard(20) });
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('API 오류:', e.message);
    return json(res, 500, { error: '서버 오류가 났어요. 잠시 뒤에 다시 해 주세요.' });
  }
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === '/status') {
    let players = 0;
    for (const r of rooms.values()) players += r.clients.size;
    return json(res, 200, { players, rooms: rooms.size, auth: db.enabled() });
  }
  if (url.startsWith('/api/')) return handleApi(req, res, url);
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
    if (m.t === 'join' && !c.room && !c.joining) {
      c.joining = true;
      (async () => {
        const u = m.token ? await db.userByToken(m.token).catch(() => null) : null;
        if (u) { c.userId = u.id; c.name = u.username; }
        else c.name = String(m.name || '').replace(/[<>]/g, '').trim().slice(0, 12) || '게스트' + Math.floor(Math.random() * 1000);
        if (ws.readyState !== 1) return;
        c.room = findRoom();
        c.room.addClient(c);
      })();
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

db.init().catch((e) => console.error('데이터베이스 연결 실패 (게스트 플레이만 가능):', e.message))
  .finally(() => server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`)));
