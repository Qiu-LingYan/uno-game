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
);
CREATE TABLE IF NOT EXISTS game_replays (
 game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
 actions TEXT NOT NULL
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
// 积分赛季（2026-10-31）：胜 +3+连击加成（连击每 +1 多 1 分，封顶 +7），负 +1 保底；排行榜按积分排序
if (!userColumns.has('points')) {
  db.exec('ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE users ADD COLUMN streak INTEGER NOT NULL DEFAULT 0');
}

// 高频 SQL 全部模块级预编译，避免每次调用重复 prepare
const q = {
  emailExists: db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE'),
  usernameExists: db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE'),
  pendingUsernameTaken: db.prepare('SELECT 1 FROM pending_registrations WHERE username=? COLLATE NOCASE AND email<>? COLLATE NOCASE'),
  purgeExpiredPending: db.prepare('DELETE FROM pending_registrations WHERE expires_at < ?'),
  upsertPending: db.prepare(`INSERT INTO pending_registrations(email,username,password_hash,password_salt,code_hash,expires_at,attempts)
    VALUES(?,?,?,?,?,?,0) ON CONFLICT(email) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,
    password_salt=excluded.password_salt,code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0`),
  getPending: db.prepare('SELECT * FROM pending_registrations WHERE email=? COLLATE NOCASE'),
  deletePending: db.prepare('DELETE FROM pending_registrations WHERE email=?'),
  bumpPendingAttempts: db.prepare('UPDATE pending_registrations SET attempts=attempts+1 WHERE email=?'),
  insertUser: db.prepare('INSERT INTO users(email,username,nickname,password_hash,password_salt) VALUES(?,?,?,?,?)'),
  insertSession: db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)'),
  purgeExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  userByEmail: db.prepare('SELECT id,email,username,nickname,password_hash,password_salt FROM users WHERE email = ? COLLATE NOCASE'),
  updatePasswordHash: db.prepare('UPDATE users SET password_hash=? WHERE id=?'),
  userBySession: db.prepare('SELECT u.id,u.email,u.username,u.nickname FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
  updateNickname: db.prepare('UPDATE users SET nickname=? WHERE id=?'),
  profile: db.prepare(`SELECT u.email,u.username,u.nickname,u.points,u.created_at AS memberSince, COUNT(gp.game_id) AS gamesPlayed,
    COALESCE(SUM(gp.won),0) AS wins,
    CASE WHEN COUNT(gp.game_id)=0 THEN 0 ELSE ROUND(100.0*SUM(gp.won)/COUNT(gp.game_id),1) END AS winRate,
    COALESCE(SUM(g.duration_seconds),0) AS playSeconds
    FROM users u LEFT JOIN game_players gp ON gp.user_id=u.id
    LEFT JOIN games g ON g.id=gp.game_id WHERE u.id=? GROUP BY u.id`),
  publicProfile: db.prepare(`SELECT u.username,u.nickname,u.points,u.created_at AS memberSince, COUNT(gp.game_id) AS gamesPlayed,
    COALESCE(SUM(gp.won),0) AS wins,
    CASE WHEN COUNT(gp.game_id)=0 THEN 0 ELSE ROUND(100.0*SUM(gp.won)/COUNT(gp.game_id),1) END AS winRate,
    COALESCE(SUM(g.duration_seconds),0) AS playSeconds
    FROM users u LEFT JOIN game_players gp ON gp.user_id=u.id
    LEFT JOIN games g ON g.id=gp.game_id WHERE u.username=? COLLATE NOCASE GROUP BY u.id`),
  insertGame: db.prepare('INSERT INTO games(room_code,started_at,ended_at,duration_seconds) VALUES(?,?,?,?)'),
  insertGamePlayer: db.prepare('INSERT OR IGNORE INTO game_players(game_id,user_id,won) VALUES(?,?,?)'),
  winScore: db.prepare('UPDATE users SET streak=streak+1, points=points+3+MIN(streak,4) WHERE id=?'),
  loseScore: db.prepare("UPDATE users SET streak=0, points=points+1 WHERE id=?"),
  insertReplay: db.prepare('INSERT OR REPLACE INTO game_replays(game_id,actions) VALUES(?,?)'),
  replay: db.prepare('SELECT r.actions FROM game_replays r JOIN game_players gp ON gp.game_id=r.game_id AND gp.user_id=? WHERE r.game_id=?'),
  leaderboard: db.prepare(`SELECT u.username,u.nickname,u.points,u.streak, COUNT(gp.game_id) AS gamesPlayed,
    COALESCE(SUM(gp.won),0) AS wins,
    CASE WHEN COUNT(gp.game_id)=0 THEN 0 ELSE ROUND(100.0*SUM(gp.won)/COUNT(gp.game_id),1) END AS winRate,
    COALESCE(SUM(g.duration_seconds),0) AS playSeconds
    FROM users u JOIN game_players gp ON gp.user_id=u.id
    JOIN games g ON g.id=gp.game_id GROUP BY u.id
    HAVING gamesPlayed > 0
    ORDER BY points DESC, winRate DESC, gamesPlayed DESC, playSeconds DESC LIMIT 20`),
  recentGames: db.prepare(`SELECT g.id, g.room_code, g.duration_seconds, g.ended_at, gp.won
    FROM game_players gp JOIN games g ON g.id=gp.game_id
    WHERE gp.user_id=? ORDER BY g.ended_at DESC LIMIT 10`),
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const tokenHash = token => createHash('sha256').update(token).digest('hex');
// 登录失败速率限制：同一邮箱 15 分钟内最多 10 次失败，防止暴力破解
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
function recordLoginFailure(key) {
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) loginAttempts.set(key, { first: now, count: 1 });
  else rec.count += 1;
  if (loginAttempts.size > 5000) loginAttempts.clear();
}
// 2026-10-30 起新哈希用 N=32768；登录先按新参数校验，失败再按旧默认参数（N=16384）校验并透明升级
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const passwordHash = (password, salt) => scryptSync(password, salt, 64, SCRYPT_PARAMS).toString('hex');

export function prepareRegistration(email, password, username) {
  if (typeof email !== 'string' || !emailPattern.test(email) || email.length > 254) return { ok: false, error: '请输入有效邮箱' };
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return { ok: false, error: '密码长度需为 8–128 位' };
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedUsername = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(normalizedUsername)) return { ok: false, error: '用户名需为 3–20 位字母、数字或下划线' };
  if (q.emailExists.get(normalizedEmail)) return { ok: false, error: '该邮箱已注册' };
  if (q.usernameExists.get(normalizedUsername)) return { ok: false, error: '该用户名已被占用' };
  if (q.pendingUsernameTaken.get(normalizedUsername, normalizedEmail)) return { ok: false, error: '该用户名暂不可用' };
  q.purgeExpiredPending.run(Date.now());
  const salt = randomBytes(16).toString('hex');
  const code = String(randomBytes(4).readUInt32BE() % 1000000).padStart(6, '0');
  q.upsertPending
    .run(normalizedEmail, normalizedUsername, passwordHash(password, salt), salt, tokenHash(code), Date.now() + 10 * 60 * 1000);
  return { ok: true, email: normalizedEmail, username: normalizedUsername, code };
}

export function confirmRegistration(email, code) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const pending = q.getPending.get(normalizedEmail);
  if (!pending || pending.expires_at < Date.now()) {
    q.deletePending.run(normalizedEmail);
    return { ok: false, error: '验证码无效或已过期，请重新发送' };
  }
  if (pending.attempts >= 5) return { ok: false, error: '验证码尝试次数过多，请重新发送' };
  const candidateHash = tokenHash(String(code || ''));
  const valid = /^[0-9]{6}$/.test(String(code || '')) && timingSafeEqual(Buffer.from(candidateHash), Buffer.from(pending.code_hash));
  if (!valid) {
    q.bumpPendingAttempts.run(normalizedEmail);
    return { ok: false, error: '验证码错误' };
  }
  const token = randomBytes(32).toString('base64url');
  // 用户名可能在等待验证期间被他人注册：给出友好错误并作废该 pending（需重新注册）
  if (q.usernameExists.get(pending.username)) {
    q.deletePending.run(normalizedEmail);
    return { ok: false, error: '该用户名已被占用，请重新注册并换一个用户名' };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = q.insertUser.run(normalizedEmail, pending.username, pending.username, pending.password_hash, pending.password_salt);
    const userId = Number(result.lastInsertRowid);
    q.insertSession.run(tokenHash(token), userId, Date.now() + 30 * 24 * 60 * 60 * 1000);
    q.deletePending.run(normalizedEmail);
    db.exec('COMMIT');
    return { ok: true, token, user: { id: userId, email: normalizedEmail, username: pending.username, nickname: pending.username } };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function login(email, password) {
  const key = String(email || '').trim().toLowerCase();
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (rec && rec.count >= LOGIN_MAX_FAILURES && now - rec.first < LOGIN_WINDOW_MS) {
    return { ok: false, error: '尝试次数过多，请 15 分钟后再试' };
  }
  const user = q.userByEmail.get(String(email || '').trim());
  if (!user) { recordLoginFailure(key); return { ok: false, error: '邮箱或密码错误' }; }
  const candidate = String(password || '');
  const stored = Buffer.from(user.password_hash, 'hex');
  let upgraded = null;
  let actual;
  try {
    actual = scryptSync(candidate, user.password_salt, 64, SCRYPT_PARAMS);
  } catch { actual = null; }
  if (!(actual && timingSafeEqual(actual, stored))) {
    // 旧默认参数（N=16384）哈希：验证通过后用新参数重哈希
    const legacy = scryptSync(candidate, user.password_salt, 64);
    if (!timingSafeEqual(legacy, stored)) { recordLoginFailure(key); return { ok: false, error: '邮箱或密码错误' }; }
    upgraded = passwordHash(candidate, user.password_salt);
  }
  const token = randomBytes(32).toString('base64url');
  loginAttempts.delete(key);
  q.purgeExpiredSessions.run(Date.now());
  if (upgraded) q.updatePasswordHash.run(upgraded, user.id);
  q.insertSession.run(tokenHash(token), user.id, Date.now() + 30 * 24 * 60 * 60 * 1000);
  return { ok: true, token, user: { id: user.id, email: user.email, username: user.username, nickname: user.nickname } };
}

export function getUser(token) {
  if (!token) return null;
  return q.userBySession.get(tokenHash(token), Date.now()) || null;
}

export function logout(token) {
  if (token) q.deleteSession.run(tokenHash(token));
}

export function updateNickname(userId, nickname) {
  const value = String(nickname || '').trim();
  if (value.length < 2 || value.length > 20) return { ok: false, error: '昵称需为 2–20 个字符' };
  q.updateNickname.run(value, userId);
  return { ok: true, nickname: value };
}

export function profile(userId) {
  return q.profile.get(userId);
}

// 排行榜：胜率优先，其次场次、时长
export function leaderboard() {
  return q.leaderboard.all();
}

// 个人中心最近对局
export function recentGames(userId) {
  return q.recentGames.all(userId);
}

// 公开战绩（不含 email）：用于游戏中点击对手头像查看资料
export function publicProfile(username) {
  const name = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(name)) return null;
  return q.publicProfile.get(name) || null;
}

export function recordGame(roomCode, startedAt, endedAt, playerIds, winnerId, userIdBySocket, actions) {
  const duration = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  db.exec('BEGIN IMMEDIATE');
  try {
    const gameId = Number(q.insertGame.run(roomCode, startedAt, endedAt, duration).lastInsertRowid);
    for (const socketId of playerIds) {
      const userId = userIdBySocket(socketId);
      if (!userId) continue;
      q.insertGamePlayer.run(gameId, userId, socketId === winnerId ? 1 : 0);
      // 积分：胜 +3+连击加成（封顶 +7），负 +1；机器人/游客无账号不计
      if (socketId === winnerId) q.winScore.run(userId); else q.loseScore.run(userId);
    }
    if (Array.isArray(actions) && actions.length) q.insertReplay.run(gameId, JSON.stringify(actions));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// 对局回放：仅参与者可读
export function replay(gameId, userId) {
  const row = q.replay.get(userId, Number(gameId) || 0);
  if (!row) return { ok: false, error: '回放不存在' };
  let actions;
  try { actions = JSON.parse(row.actions); } catch { return { ok: false, error: '回放数据损坏' }; }
  return { ok: true, actions };
}
