import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck, canPlay, playCard, callUno, publicState } from '../server/game.js';

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
  assert.deepEqual(playCard(state, 'a', 0), { ok: true, event: null });
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
