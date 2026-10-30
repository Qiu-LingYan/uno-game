import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck, canPlay, playCard, drawCards, callUno, catchUno, keepDrawn, removePlayerFromState, publicState, UNO_CATCH_MS } from '../server/game.js';

function makeState(overrides = {}) {
  return { players: ['a','b'], hands: { a: [], b: [] }, discard: [{ color:'red', value:'3' }], drawPile: [], activeColor:'red', turn:0, direction:1, pendingDraw:0, winner:null, unoCalled: { a:false, b:false }, mayPlayDrawn: null, unoVulnerable: null, ...overrides };
}

test('deck has 108 cards with expected wild count', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 108);
  assert.equal(deck.filter(c => c.color === 'wild').length, 8);
});

test('playability matches active color or value and wild is always playable', () => {
  const top = { color: 'red', value: '5' };
  assert.equal(canPlay({ color: 'red', value: '2' }, top, 'red'), true);
  assert.equal(canPlay({ color: 'blue', value: '5' }, top, 'red'), true);
  assert.equal(canPlay({ color: 'blue', value: '2' }, top, 'red'), false);
  assert.equal(canPlay({ color: 'wild', value: 'wild4' }, top, 'red'), true);
});

test('valid final card wins; invalid play is rejected', () => {
  const state = { players: ['a','b'], hands: { a: [{color:'blue',value:'5'}], b: [{color:'red',value:'1'}] }, discard: [{color:'red',value:'5'}], drawPile: [], activeColor:'red', turn:0, direction:1, pendingDraw:0, winner:null, unoCalled: { a: false, b: false } };
  assert.equal(playCard(state, 'a', 0).ok, true);
  assert.equal(state.winner, 'a');
  assert.equal(playCard(state, 'b', 0).ok, false);
});

test('player with one card can call UNO and announcement is included in public state', () => {
  const state = { players: ['a','b'], hands: { a: [{color:'red',value:'5'}, {color:'blue',value:'7'}], b: [{color:'green',value:'1'}, {color:'green',value:'2'}] }, discard: [{color:'red',value:'3'}], drawPile: [], activeColor:'red', turn:0, direction:1, pendingDraw:0, winner:null, unoCalled: { a: false, b: false } };
  const r = playCard(state, 'a', 0);
  assert.equal(r.ok, true);
  assert.equal(r.event, null);
  assert.equal(state.hands.a.length, 1);
  assert.deepEqual(callUno(state, 'a'), { ok: true });
  assert.equal(publicState(state, 'a').unoCalled.a, true);
});

test('callUno accepts exactly one card and rejects other hand sizes', () => {
  const state = { players: ['a','b'], hands: { a: [{color:'blue',value:'5'}], b: [{color:'red',value:'1'}, {color:'green',value:'2'}] }, discard: [{color:'red',value:'5'}], drawPile: [], activeColor:'red', turn:0, direction:1, pendingDraw:0, winner:null, unoCalled: { a: false, b: false } };
  state.hands.a.push({color:'blue', value:'7'});
  assert.equal(callUno(state, 'a').ok, false);
  state.hands.a.pop();
  assert.deepEqual(callUno(state, 'a'), { ok: true });
  assert.equal(publicState(state, 'a').unoCalled.a, true);
  assert.equal(callUno(state, 'b').ok, false);
});

test('+2 stacks on +2 and accumulates pendingDraw', () => {
  const state = makeState({ hands: { a: [{ color:'blue', value:'draw2' }, { color:'red', value:'8' }], b: [] }, discard: [{ color:'red', value:'draw2' }], activeColor:'red', pendingDraw: 2 });
  const r = playCard(state, 'a', 0);
  assert.equal(r.ok, true);
  assert.equal(r.event, 'stack');
  assert.equal(state.pendingDraw, 4);
  assert.equal(state.turn, 1);
});

test('non-stackable card is rejected while pendingDraw is active', () => {
  const state = makeState({ hands: { a: [{ color:'red', value:'5' }], b: [] }, discard: [{ color:'red', value:'draw2' }], activeColor:'red', pendingDraw: 2 });
  assert.equal(playCard(state, 'a', 0).ok, false);
});

test('wild4 can be stacked and accumulates 4', () => {
  const state = makeState({ hands: { a: [{ color:'wild', value:'wild4' }], b: [] }, discard: [{ color:'red', value:'draw2' }], activeColor:'red', pendingDraw: 2 });
  const r = playCard(state, 'a', 0, 'blue');
  assert.equal(r.ok, true);
  assert.equal(state.pendingDraw, 6);
  assert.equal(state.activeColor, 'blue');
});

test('drawing 1 playable card keeps the turn; player may play or keep it', () => {
  const state = makeState({ hands: { a: [{ color:'red', value:'7' }], b: [] }, drawPile: [{ color:'red', value:'5' }] });
  const r = drawCards(state, 'a');
  assert.equal(r.mayPlay, true);
  assert.equal(state.mayPlayDrawn, 1);
  // 打出刚摸的牌
  const p = playCard(state, 'a', 1);
  assert.equal(p.ok, true);
  assert.equal(state.mayPlayDrawn, null);
  assert.equal(state.turn, 1);
});

test('playing a card other than the drawn one is rejected after drawing', () => {
  const state = makeState({ hands: { a: [{ color:'red', value:'7' }, { color:'green', value:'9' }], b: [] }, drawPile: [{ color:'red', value:'5' }] });
  drawCards(state, 'a');
  assert.equal(playCard(state, 'a', 0).ok, false);
});

test('keepDrawn ends the turn without playing', () => {
  const state = makeState({ hands: { a: [{ color:'red', value:'7' }], b: [] }, drawPile: [{ color:'red', value:'5' }] });
  drawCards(state, 'a');
  assert.deepEqual(keepDrawn(state, 'a'), { ok: true });
  assert.equal(state.mayPlayDrawn, null);
  assert.equal(state.turn, 1);
  assert.equal(keepDrawn(state, 'a').ok, false);
});

test('forced draw from pendingDraw does not allow playing the drawn card', () => {
  const state = makeState({ hands: { a: [], b: [] }, drawPile: [{ color:'red', value:'5' }, { color:'blue', value:'6' }], pendingDraw: 2 });
  const r = drawCards(state, 'b');
  assert.equal(r.mayPlay, undefined);
  assert.equal(state.mayPlayDrawn, null);
  assert.equal(state.turn, 0);
});

test('catchUno within window penalizes 2 cards; expired window rejects', () => {
  const state = makeState({ hands: { a: [{ color:'red', value:'3' }, { color:'blue', value:'9' }], b: [] }, drawPile: [{ color:'green', value:'1' }, { color:'green', value:'2' }] });
  playCard(state, 'a', 0); // a 剩 1 张，进入暴露窗口
  assert.equal(state.unoVulnerable.player, 'a');
  const r = catchUno(state, 'b', Date.now());
  assert.equal(r.ok, true);
  assert.equal(state.hands.a.length, 3);
  assert.equal(state.unoVulnerable, null);

  const state2 = makeState({ hands: { a: [{ color:'red', value:'3' }, { color:'blue', value:'9' }], b: [] } });
  playCard(state2, 'a', 0);
  const r2 = catchUno(state2, 'b', Date.now() + UNO_CATCH_MS + 1);
  assert.equal(r2.ok, false);
  assert.equal(state2.hands.a.length, 1);
});

test('callUno clears the vulnerable window', () => {
  const state = makeState({ hands: { a: [{ color:'red', value:'3' }, { color:'blue', value:'9' }], b: [] } });
  playCard(state, 'a', 0);
  callUno(state, 'a');
  assert.equal(state.unoVulnerable, null);
});

test('publicState exposes mayPlayDrawn and hides expired unoVulnerable', () => {
  const state = makeState({ mayPlayDrawn: 2, unoVulnerable: { player: 'a', deadline: Date.now() - 1 } });
  const s = publicState(state, 'a');
  assert.equal(s.mayPlayDrawn, 2);
  assert.equal(s.unoVulnerable, null);
});

test('removePlayerFromState fixes turn and clears per-player data', () => {
  const state = makeState({ players: ['a','b','c'], hands: { a:[{color:'red',value:'5'}], b:[{color:'red',value:'6'}], c:[{color:'red',value:'7'}] }, unoCalled: { a:false,b:false,c:false } });
  state.turn = 0; // 轮到 a
  assert.equal(removePlayerFromState(state, 'a'), true);
  assert.deepEqual(state.players, ['b','c']);
  assert.equal(state.turn, 0); // b 顶上
  assert.equal(state.hands.a, undefined);
  // 移除的不是当前行动者：turn=1(c) 移除 c 后应指向 b
  state.turn = 1;
  removePlayerFromState(state, 'c');
  assert.equal(state.turn, 0);
});

test('UNO catch window is 15 seconds', () => {
  assert.equal(UNO_CATCH_MS, 15000);
});
