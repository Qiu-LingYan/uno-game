// UNO 游戏核心逻辑（纯函数，便于单测）
export const COLORS = ["red", "yellow", "green", "blue"];

export function buildDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ color, value: "0" });
    for (let n = 1; n <= 9; n++) deck.push({ color, value: String(n) }, { color, value: String(n) });
    for (const v of ["skip", "reverse", "draw2"]) deck.push({ color, value: v }, { color, value: v });
    deck.push({ color: "wild", value: "wild" }, { color: "wild", value: "wild4" });
  }
  return shuffle(deck);
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function canPlay(card, topCard, activeColor) {
  if (card.color === "wild") return true;
  if (card.color === activeColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

export function newGame(playerIds) {
  const deck = buildDeck();
  const hands = {};
  for (const id of playerIds) hands[id] = deck.splice(0, 7);
  let first = deck.pop();
  while (first.color === "wild") { deck.unshift(first); first = deck.pop(); }
  return {
    players: playerIds,
    hands,
    drawPile: deck,
    discard: [first],
    activeColor: first.color,
    turn: 0,
    direction: 1,
    pendingDraw: 0,
    winner: null,
  };
}

// 执行出牌；返回 { ok, error?, event? }。state 会被原地修改。
export function playCard(state, playerId, cardIndex, chosenColor) {
  if (state.winner) return { ok: false, error: "game over" };
  const pid = state.players[state.turn];
  if (pid !== playerId) return { ok: false, error: "not your turn" };
  const hand = state.hands[playerId];
  const card = hand[cardIndex];
  if (!card) return { ok: false, error: "no such card" };
  const top = state.discard[state.discard.length - 1];
  if (!canPlay(card, top, state.activeColor)) return { ok: false, error: "card not playable" };
  if (card.color === "wild" && !chosenColor) return { ok: false, error: "choose a color" };
  if (card.color === "wild" && chosenColor && !COLORS.includes(chosenColor)) return { ok: false, error: "bad color" };

  hand.splice(cardIndex, 1);
  state.discard.push(card);
  state.activeColor = card.color === "wild" ? chosenColor : card.color;

  let event = null;
  if (card.value === "skip") event = "skip";
  else if (card.value === "reverse") { state.direction *= -1; event = "reverse"; }
  else if (card.value === "draw2") { state.pendingDraw = 2; event = "draw2"; }
  else if (card.value === "wild4") { state.pendingDraw = 4; event = "wild4"; }

  if (hand.length === 0) { state.winner = playerId; return { ok: true, event }; }
  advanceTurn(state, event === "skip" ? 2 : 1);
  return { ok: true, event };
}

export function advanceTurn(state, steps = 1) {
  const n = state.players.length;
  state.turn = ((state.turn + state.direction * steps) % n + n) % n;
}

// 摸牌（处理 pendingDraw 累积）
export function drawCards(state, playerId) {
  if (state.winner) return { ok: false, error: "game over" };
  const pid = state.players[state.turn];
  if (pid !== playerId) return { ok: false, error: "not your turn" };
  const count = state.pendingDraw > 0 ? state.pendingDraw : 1;
  state.pendingDraw = 0;
  const hand = state.hands[playerId];
  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0) reshuffle(state);
    if (state.drawPile.length === 0) break;
    hand.push(state.drawPile.pop());
  }
  advanceTurn(state, 1);
  return { ok: true, drawn: count };
}

function reshuffle(state) {
  if (state.discard.length <= 1) return;
  const top = state.discard.pop();
  const rest = state.discard.map(c => c.color === "wild" ? { ...c, color: "wild" } : c);
  state.drawPile = shuffle(rest);
  state.discard = [top];
}

export function publicState(state, forPlayer) {
  return {
    players: state.players,
    handCounts: Object.fromEntries(state.players.map(p => [p, state.hands[p].length])),
    yourHand: forPlayer ? state.hands[forPlayer] : undefined,
    top: state.discard[state.discard.length - 1],
    activeColor: state.activeColor,
    turn: state.players[state.turn],
    direction: state.direction,
    pendingDraw: state.pendingDraw,
    drawPileCount: state.drawPile.length,
    winner: state.winner,
  };
}
