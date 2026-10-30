import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'uno-store-test-'));
process.env.DB_PATH = join(dir, 'test.sqlite');
const store = await import('../server/store.js');

test('legacy account SQLite schema upgrades with generated username and nickname', () => {
  const script = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.env.DB_PATH); db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,password_hash TEXT,password_salt TEXT,created_at TEXT); INSERT INTO users VALUES(1,'old_user@example.com','hash','salt','2025-01-01')"); db.close(); await import(${JSON.stringify(new URL('../server/store.js', import.meta.url).href)}); const upgraded=new DatabaseSync(process.env.DB_PATH); console.log(JSON.stringify(upgraded.prepare('SELECT username,nickname FROM users WHERE id=1').get())); upgraded.close();`;
  const legacyPath = join(dir, 'legacy.sqlite');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DB_PATH: legacyPath }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { username: 'old_user_1', nickname: 'old_user_1' });
  rmSync(legacyPath, { force: true });
});

test('email verification gates account creation; sessions and game profile stats persist in SQLite', () => {
  assert.equal(store.prepareRegistration('bad-email', 'correct-horse-8', 'tester').ok, false);
  assert.equal(store.prepareRegistration('valid@example.com', 'short', 'tester').ok, false);
  assert.equal(store.prepareRegistration('valid@example.com', 'correct-horse-8', 'x!').ok, false);

  const pending = store.prepareRegistration('Test@Example.com', 'correct-horse-8', 'tester_1');
  assert.equal(pending.ok, true);
  assert.equal(store.getUser(pending.email), null);
  assert.equal(store.confirmRegistration(pending.email, '000000').ok, false);
  const verified = store.confirmRegistration(pending.email, pending.code);
  assert.equal(verified.ok, true);
  assert.equal(verified.user.email, 'test@example.com');
  assert.equal(verified.user.username, 'tester_1');
  assert.equal(store.confirmRegistration(pending.email, pending.code).ok, false);
  assert.equal(store.prepareRegistration('test@example.com', 'correct-horse-8', 'newname').error, '该邮箱已注册');
  assert.equal(store.prepareRegistration('other@example.com', 'correct-horse-8', 'TESTER_1').error, '该用户名已被占用');
  assert.equal(store.updateNickname(verified.user.id, '我的昵称').ok, true);
  assert.equal(store.updateNickname(verified.user.id, 'x').ok, false);

  const login = store.login('test@example.com', 'correct-horse-8');
  assert.equal(login.ok, true);
  assert.equal(store.getUser(login.token).email, 'test@example.com');
  assert.equal(store.login('test@example.com', 'wrong-password').ok, false);

  const start = Date.now() - 65000;
  store.recordGame('ABCD', start, Date.now(), ['socket-a', 'socket-b'], 'socket-a', id => id === 'socket-a' ? verified.user.id : null);
  const stats = store.profile(verified.user.id);
  assert.equal(stats.gamesPlayed, 1);
  assert.equal(stats.wins, 1);
  assert.equal(stats.winRate, 100);
  assert.ok(stats.playSeconds >= 60);
  store.recordGame('EFGH', start, Date.now(), ['socket-b', 'socket-a'], 'socket-b', id => id === 'socket-a' ? verified.user.id : null);
  const losses = store.profile(verified.user.id);
  assert.equal(losses.gamesPlayed, 2);
  assert.equal(losses.wins, 1);
  assert.equal(losses.winRate, 50);
  store.logout(login.token);
  assert.equal(store.getUser(login.token), null);
});

test('login failures are rate limited per email', () => {
  const email = 'ratelimit_probe@example.com';
  for (let i = 0; i < 10; i++) {
    const r = store.login(email, 'wrong-pass-123');
    assert.equal(r.ok, false);
    assert.equal(r.error, '邮箱或密码错误');
  }
  const locked = store.login(email, 'wrong-pass-123');
  assert.equal(locked.ok, false);
  assert.equal(locked.error, '尝试次数过多，请 15 分钟后再试');
});

test.after(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
