import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const dbPath = resolve(process.env.DB_PATH || new URL('../data/uno.sqlite', import.meta.url).pathname);
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 username TEXT NOT NULL UNIQUE COLLATE NOCASE, nickname TEXT NOT NULL,
 password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_registrations (
 email TEXT PRIMARY KEY COLLATE NOCASE, username TEXT NOT NULL COLLATE NOCASE,
 password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
 code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS games (
 id INTEGER PRIMARY KEY, room_code TEXT NOT NULL, started_at INTEGER NOT NULL,
 ended_at INTEGER NOT NULL, duration_seconds INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS game_players (
 game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id), won INTEGER NOT NULL,
 PRIMARY KEY (game_id, user_id)
);`);

const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
if (!userColumns.has('username')) {
  db.exec('ALTER TABLE users ADD COLUMN username TEXT');
  db.exec('ALTER TABLE users ADD COLUMN nickname TEXT');
  const legacyUsers = db.prepare('SELECT id,email FROM users').all();
  const updateLegacyUser = db.prepare('UPDATE users SET username=?,nickname=? WHERE id=?');
  for (const user of legacyUsers) {
    const stem = String(user.email).split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 13) || 'player';
    const username = `${stem}_${user.id}`;
    updateLegacyUser.run(username, username, user.id);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username COLLATE NOCASE)');
}
const pendingColumns = new Set(db.prepare('PRAGMA table_info(pending_registrations)').all().map(column => column.name));
if (!pendingColumns.has('username')) db.exec("ALTER TABLE pending_registrations ADD COLUMN username TEXT NOT NULL DEFAULT 'player'");

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const passwordHash = (password, salt) => scryptSync(password, salt, 64).toString('hex');

export function prepareRegistration(email, password, username) {
  if (typeof email !== 'string' || !emailPattern.test(email) || email.length > 254) return { ok: false, error: '请输入有效邮箱' };
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return { ok: false, error: '密码长度需为 8–128 位' };
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedUsername = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(normalizedUsername)) return { ok: false, error: '用户名需为 3–20 位字母、数字或下划线' };
  if (db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE').get(normalizedEmail)) return { ok: false, error: '该邮箱已注册' };
  if (db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(normalizedUsername)) return { ok: false, error: '该用户名已被占用' };
  if (db.prepare('SELECT 1 FROM pending_registrations WHERE username=? COLLATE NOCASE AND email<>? COLLATE NOCASE').get(normalizedUsername, normalizedEmail)) return { ok: false, error: '该用户名暂不可用' };
  const salt = randomBytes(16).toString('hex');
  const code = String(randomBytes(4).readUInt32BE() % 1000000).padStart(6, '0');
  db.prepare(`INSERT INTO pending_registrations(email,username,password_hash,password_salt,code_hash,expires_at,attempts)
    VALUES(?,?,?,?,?,?,0) ON CONFLICT(email) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,
    password_salt=excluded.password_salt,code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0`)
    .run(normalizedEmail, normalizedUsername, passwordHash(password, salt), salt, tokenHash(code), Date.now() + 10 * 60 * 1000);
  return { ok: true, email: normalizedEmail, username: normalizedUsername, code };
}

export function confirmRegistration(email, code) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const pending = db.prepare('SELECT * FROM pending_registrations WHERE email=? COLLATE NOCASE').get(normalizedEmail);
  if (!pending || pending.expires_at < Date.now()) {
    db.prepare('DELETE FROM pending_registrations WHERE email=? COLLATE NOCASE').run(normalizedEmail);
    return { ok: false, error: '验证码无效或已过期，请重新发送' };
  }
  if (pending.attempts >= 5) return { ok: false, error: '验证码尝试次数过多，请重新发送' };
  const candidateHash = tokenHash(String(code || ''));
  const valid = /^[0-9]{6}$/.test(String(code || '')) && timingSafeEqual(Buffer.from(candidateHash), Buffer.from(pending.code_hash));
  if (!valid) {
    db.prepare('UPDATE pending_registrations SET attempts=attempts+1 WHERE email=?').run(normalizedEmail);
    return { ok: false, error: '验证码错误' };
  }
  const token = randomBytes(32).toString('base64url');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare('INSERT INTO users(email,username,nickname,password_hash,password_salt) VALUES(?,?,?,?,?)').run(normalizedEmail, pending.username, pending.username, pending.password_hash, pending.password_salt);
    const userId = Number(result.lastInsertRowid);
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash(token), userId, Date.now() + 30 * 24 * 60 * 60 * 1000);
    db.prepare('DELETE FROM pending_registrations WHERE email=?').run(normalizedEmail);
    db.exec('COMMIT');
    return { ok: true, token, user: { id: userId, email: normalizedEmail, username: pending.username, nickname: pending.username } };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function login(email, password) {
  const user = db.prepare('SELECT id,email,username,nickname,password_hash,password_salt FROM users WHERE email = ? COLLATE NOCASE').get(String(email || '').trim());
  const actual = scryptSync(String(password || ''), user?.password_salt || 'invalid-user-salt', 64);
  if (!user || !timingSafeEqual(actual, Buffer.from(user.password_hash, 'hex'))) return { ok: false, error: '邮箱或密码错误' };
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash(token), user.id, Date.now() + 30 * 24 * 60 * 60 * 1000);
  return { ok: true, token, user: { id: user.id, email: user.email, username: user.username, nickname: user.nickname } };
}

export function getUser(token) {
  if (!token) return null;
  return db.prepare('SELECT u.id,u.email,u.username,u.nickname FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash(token), Date.now()) || null;
}

export function logout(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
}

export function updateNickname(userId, nickname) {
  const value = String(nickname || '').trim();
  if (value.length < 2 || value.length > 20) return { ok: false, error: '昵称需为 2–20 个字符' };
  db.prepare('UPDATE users SET nickname=? WHERE id=?').run(value, userId);
  return { ok: true, nickname: value };
}

export function profile(userId) {
  return db.prepare(`SELECT u.email,u.username,u.nickname,u.created_at AS memberSince, COUNT(gp.game_id) AS gamesPlayed,
    COALESCE(SUM(gp.won),0) AS wins,
    CASE WHEN COUNT(gp.game_id)=0 THEN 0 ELSE ROUND(100.0*SUM(gp.won)/COUNT(gp.game_id),1) END AS winRate,
    COALESCE(SUM(g.duration_seconds),0) AS playSeconds
    FROM users u LEFT JOIN game_players gp ON gp.user_id=u.id
    LEFT JOIN games g ON g.id=gp.game_id WHERE u.id=? GROUP BY u.id`).get(userId);
}

// 公开战绩（不含 email）：用于游戏中点击对手头像查看资料
export function publicProfile(username) {
  const name = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(name)) return null;
  const row = db.prepare(`SELECT u.username,u.nickname,u.created_at AS memberSince, COUNT(gp.game_id) AS gamesPlayed,
    COALESCE(SUM(gp.won),0) AS wins,
    CASE WHEN COUNT(gp.game_id)=0 THEN 0 ELSE ROUND(100.0*SUM(gp.won)/COUNT(gp.game_id),1) END AS winRate,
    COALESCE(SUM(g.duration_seconds),0) AS playSeconds
    FROM users u LEFT JOIN game_players gp ON gp.user_id=u.id
    LEFT JOIN games g ON g.id=gp.game_id WHERE u.username=? COLLATE NOCASE GROUP BY u.id`).get(name);
  return row || null;
}

export function recordGame(roomCode, startedAt, endedAt, playerIds, winnerId, userIdBySocket) {
  const duration = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const insertGame = db.prepare('INSERT INTO games(room_code,started_at,ended_at,duration_seconds) VALUES(?,?,?,?)');
  const insertPlayer = db.prepare('INSERT OR IGNORE INTO game_players(game_id,user_id,won) VALUES(?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const gameId = Number(insertGame.run(roomCode, startedAt, endedAt, duration).lastInsertRowid);
    for (const socketId of playerIds) {
      const userId = userIdBySocket(socketId);
      if (userId) insertPlayer.run(gameId, userId, socketId === winnerId ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
