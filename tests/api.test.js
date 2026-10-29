import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const dir = mkdtempSync(join(tmpdir(), 'uno-api-test-'));
process.env.DB_PATH = join(dir, 'api.sqlite');
process.env.PORT = String(34000 + Math.floor(Math.random() * 10000));
process.env.RESEND_API_KEY = 're_test_key';
process.env.RESEND_FROM_EMAIL = 'uno@qiulingyan.cv';
process.env.RESEND_FROM_NAME = 'UNO PARTY';
process.env.APP_URL = 'https://uno.example.test';
let capturedEmail;
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, options) => {
  if (url === 'https://api.resend.com/emails') {
    capturedEmail = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'email-test-id' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return nativeFetch(url, options);
};
const [{ server }, storeModule] = await Promise.all([import('../server/index.js'), import('../server/store.js')]);
const { db } = storeModule;

async function request(path, { token, ...options } = {}) {
  return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
}

test('email registration, login/profile/logout HTTP APIs work and Resend gets HTML', async () => {
  await once(server, 'listening');
  try {
    let response = await request('/api/register', { method: 'POST', body: JSON.stringify({ email: 'UiTest@qiulingyan.cv', password: 'passphrase-123', username: 'uitester' }) });
    assert.equal(response.status, 202);
    assert.match(capturedEmail.from, /UNO PARTY/);
    assert.equal(capturedEmail.to[0], 'uitest@qiulingyan.cv');
    assert.match(capturedEmail.html, /<html lang="zh-CN">/);
    assert.match(capturedEmail.html, /10 分钟/);
    assert.match(capturedEmail.text, /验证码/);
    const code = capturedEmail.html.match(/验证码是 (\d{6})/)?.[1];
    assert.ok(code, 'verification code appears in HTML preheader');

    response = await request('/api/register/confirm', { method: 'POST', body: JSON.stringify({ email: 'uitest@qiulingyan.cv', username: 'uitester', code }) });
    assert.equal(response.status, 201);
    const session = await response.json();
    assert.ok(session.token);

    response = await request('/api/me', { token: session.token });
    assert.equal((await response.json()).email, 'uitest@qiulingyan.cv');
    response = await request('/api/profile', { token: session.token });
    const stats = await response.json();
    assert.equal(stats.gamesPlayed, 0);
    assert.equal(stats.winRate, 0);
    assert.equal(stats.username, 'uitester');
    response = await request('/api/profile', { method: 'PATCH', token: session.token, body: JSON.stringify({ nickname: '派对玩家' }) });
    assert.equal((await response.json()).nickname, '派对玩家');
    response = await request('/api/me', { token: session.token });
    assert.equal((await response.json()).nickname, '派对玩家');

    response = await request('/api/logout', { method: 'POST', token: session.token });
    assert.equal(response.status, 200);
    response = await request('/api/me', { token: session.token });
    assert.equal(response.status, 401);
    console.log('PASS: Resend HTML email, verification, session, profile, and logout API flow');
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
