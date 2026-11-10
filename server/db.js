// 계정 / 전적 저장 (PostgreSQL). DATABASE_URL이 없으면 로그인 기능만 꺼지고 게임은 그대로 돌아간다.
const crypto = require('crypto');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_DAYS = 60;
let pool = null;

const USERNAME_RE = /^[가-힣a-zA-Z0-9_]{2,12}$/;

async function init() {
  if (!DATABASE_URL) {
    console.log('DATABASE_URL이 없어서 로그인/전적 기능은 꺼져 있습니다 (게스트 플레이만 가능).');
    return false;
  }
  pool = new Pool({ connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  pool.on('error', (e) => console.error('DB 연결 오류:', e.message));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS stats (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      games INT NOT NULL DEFAULT 0,
      wins INT NOT NULL DEFAULT 0,
      kills INT NOT NULL DEFAULT 0,
      best_place INT,
      best_kills INT NOT NULL DEFAULT 0,
      play_seconds INT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      played_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      place INT NOT NULL,
      players INT NOT NULL,
      kills INT NOT NULL,
      seconds INT NOT NULL,
      cause TEXT
    );
    CREATE INDEX IF NOT EXISTS matches_user_time ON matches (user_id, played_at DESC);
  `);
  console.log('데이터베이스 연결 완료: 로그인/전적 기능 켜짐');
  return true;
}

const enabled = () => !!pool;

// ---------- 비밀번호 (scrypt 해시, 원문은 저장하지 않음) ----------
function hashPassword(pw) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, 64, (err, key) => (err ? reject(err) : resolve(`scrypt$${salt.toString('hex')}$${key.toString('hex')}`)));
  });
}
function verifyPassword(pw, stored) {
  return new Promise((resolve) => {
    const [alg, saltHex, keyHex] = String(stored).split('$');
    if (alg !== 'scrypt' || !saltHex || !keyHex) return resolve(false);
    crypto.scrypt(pw, Buffer.from(saltHex, 'hex'), 64, (err, key) => {
      if (err) return resolve(false);
      const want = Buffer.from(keyHex, 'hex');
      resolve(want.length === key.length && crypto.timingSafeEqual(want, key));
    });
  });
}

async function newSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
  return token;
}

// ---------- 계정 ----------
async function register(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  if (!USERNAME_RE.test(username)) return { error: '아이디는 2~12자의 한글, 영문, 숫자, _ 만 쓸 수 있어요.' };
  if (password.length < 4 || password.length > 64) return { error: '비밀번호는 4자 이상이어야 해요.' };
  const hash = await hashPassword(password);
  let user;
  try {
    const r = await pool.query('INSERT INTO users (username, pass_hash) VALUES ($1, $2) RETURNING id, username', [username, hash]);
    user = r.rows[0];
  } catch (e) {
    if (e.code === '23505') return { error: '이미 사용 중인 아이디예요.' };
    throw e;
  }
  await pool.query('INSERT INTO stats (user_id) VALUES ($1)', [user.id]);
  return { token: await newSession(user.id), user };
}

async function login(username, password) {
  const r = await pool.query('SELECT id, username, pass_hash FROM users WHERE lower(username) = lower($1)', [String(username || '').trim()]);
  const u = r.rows[0];
  // 아이디가 없어도 같은 시간이 걸리도록 해시 계산은 항상 한다
  const ok = await verifyPassword(String(password || ''), u ? u.pass_hash : 'scrypt$00$00');
  if (!u || !ok) return { error: '아이디 또는 비밀번호가 맞지 않아요.' };
  return { token: await newSession(u.id), user: { id: u.id, username: u.username } };
}

async function userByToken(token) {
  if (!pool || typeof token !== 'string' || token.length !== 48) return null;
  const r = await pool.query(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.created_at > now() - interval '${SESSION_DAYS} days'`, [token]);
  return r.rows[0] || null;
}

async function logout(token) {
  if (typeof token === 'string') await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

// ---------- 전적 ----------
async function recordMatch(userId, { place, players, kills, seconds, cause }) {
  if (!pool || !userId) return;
  try {
    await pool.query('INSERT INTO matches (user_id, place, players, kills, seconds, cause) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, place, players, kills, Math.round(seconds), cause || null]);
    await pool.query(
      `UPDATE stats SET games = games + 1, wins = wins + $2, kills = kills + $3,
         best_place = LEAST(COALESCE(best_place, $4), $4), best_kills = GREATEST(best_kills, $3),
         play_seconds = play_seconds + $5
       WHERE user_id = $1`, [userId, place === 1 ? 1 : 0, kills, place, Math.round(seconds)]);
  } catch (e) {
    console.error('전적 저장 실패:', e.message);
  }
}

async function profile(userId) {
  const s = await pool.query('SELECT games, wins, kills, best_place, best_kills, play_seconds FROM stats WHERE user_id = $1', [userId]);
  const m = await pool.query('SELECT played_at, place, players, kills, seconds, cause FROM matches WHERE user_id = $1 ORDER BY played_at DESC LIMIT 10', [userId]);
  return { stats: s.rows[0] || null, recent: m.rows };
}

async function leaderboard(limit = 20) {
  const r = await pool.query(
    `SELECT u.username, s.games, s.wins, s.kills, s.best_place, s.best_kills
     FROM stats s JOIN users u ON u.id = s.user_id
     WHERE s.games > 0
     ORDER BY s.wins DESC, s.kills DESC, s.games ASC
     LIMIT $1`, [limit]);
  return r.rows;
}

module.exports = { init, enabled, register, login, logout, userByToken, recordMatch, profile, leaderboard };
