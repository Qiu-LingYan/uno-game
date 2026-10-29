import { spawn } from 'node:child_process';
import { io as client } from 'socket.io-client';
import assert from 'node:assert/strict';

const port = 33000 + Math.floor(Math.random() * 20000);
const proc = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
const url = `http://127.0.0.1:${port}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function connect() {
  const s = client(url, { reconnection: false, timeout: 3000 });
  await new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); });
  return s;
}
let a, b;
try {
  for (let i = 0; i < 40; i++) {
    try { a = await connect(); break; } catch { await wait(100); }
  }
  assert.ok(a, 'server started');
  b = await connect();
  const lobbyState = new Promise(resolve => a.once('state', resolve));
  const room = await new Promise(resolve => a.emit('createRoom', { name: 'Alice' }, resolve));
  assert.equal(room.ok, true);
  const initialLobby = await lobbyState;
  assert.equal(initialLobby.room, room.code);
  const joined = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('joinRoom callback timed out')), 3000);
    b.emit('joinRoom', { code: room.code, name: 'Bob' }, result => { clearTimeout(timer); resolve(result); });
  });
  assert.equal(joined.ok, true);
  await wait(100);
  const stateA = new Promise(resolve => a.once('state', resolve));
  const stateB = new Promise(resolve => b.once('state', resolve));
  a.emit('startGame', { code: room.code });
  const initialA = await Promise.race([stateA, wait(3000).then(() => null)]);
  const initialB = await Promise.race([stateB, wait(3000).then(() => null)]);
  assert.ok(initialA && initialB, `both received start state: A=${JSON.stringify(initialA)} B=${JSON.stringify(initialB)}`);
  assert.equal(initialA.players.length, 2);
  assert.equal(initialB.players.length, 2);
  const first = initialA.turn === a.id ? a : b;
  const firstState = initialA.turn === a.id ? initialA : initialB;
  const observer = first === a ? b : a;
  const before = new Promise(resolve => observer.once('state', resolve));
  const hand = firstState.yourHand;
  let idx = hand.findIndex(c => c.color === 'wild' || c.color === firstState.activeColor || c.value === firstState.top.value);
  if (idx < 0) {
    first.emit('draw', { code: room.code });
  } else {
    const card = hand[idx];
    first.emit('playCard', { code: room.code, cardIndex: idx, chosenColor: card.color === 'wild' ? 'red' : undefined });
  }
  const synced = await Promise.race([before, wait(3000).then(() => null)]);
  assert.ok(synced, 'state sync received after a turn action');
  console.log('PASS: 两位客户端加入同一房间，并收到同步后的出牌/摸牌状态');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  a?.disconnect(); b?.disconnect(); proc.kill('SIGTERM');
}
