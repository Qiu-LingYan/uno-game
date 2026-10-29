import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck, canPlay, playCard } from '../server/game.js';

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
  const state = { players: ['a','b'], hands: { a: [{color:'blue',value:'5'}], b: [{color:'red',value:'1'}] }, discard: [{color:'red',value:'5'}], activeColor:'red', turn:0, direction:1, pendingDraw:0, winner:null };
  assert.equal(playCard(state, 'a', 0).ok, true);
  assert.equal(state.winner, 'a');
  assert.equal(playCard(state, 'b', 0).ok, false);
});
