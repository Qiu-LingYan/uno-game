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

export const UNO_CATCH_MS = 2000;

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
    unoCalled: {},
    mayPlayDrawn: null,
    unoVulnerable: null,
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
  // +2/+4 叠加：待摸张数未清零时，只允许叠加同value的 +2 或任意 wild4
  if (state.pendingDraw > 0) {
    const stackable = (card.value === "draw2" && top.value === "draw2") || card.value === "wild4";
    if (!stackable) return { ok: false, error: "只能叠加 +2 或 +4" };
    if (card.color === "wild" && !chosenColor) return { ok: false, error: "choose a color" };
    if (card.color === "wild" && chosenColor && !COLORS.includes(chosenColor)) return { ok: false, error: "bad color" };
  } else {
    if (!canPlay(card, top, state.activeColor)) return { ok: false, error: "card not playable" };
    if (card.color === "wild" && !chosenColor) return { ok: false, error: "choose a color" };
    if (card.color === "wild" && chosenColor && !COLORS.includes(chosenColor)) return { ok: false, error: "bad color" };
  }
  // 摸牌后保留回合时，只能打出刚摸的那张牌
  if (state.mayPlayDrawn != null && cardIndex !== state.mayPlayDrawn) {
    return { ok: false, error: "只能打出刚摸到的牌" };
  }
  const drewThisTurn = state.mayPlayDrawn != null;
  state.mayPlayDrawn = null;

  hand.splice(cardIndex, 1);
  state.unoCalled[playerId] = false;
  state.discard.push(card);
  state.activeColor = card.color === "wild" ? chosenColor : card.color;

  let event = null;
  if (state.pendingDraw > 0) {
    state.pendingDraw += card.value === "draw2" ? 2 : 4;
    event = "stack";
  } else if (card.value === "skip") event = "skip";
  else if (card.value === "reverse") { state.direction *= -1; event = "reverse"; }
  else if (card.value === "draw2") { state.pendingDraw = 2; event = "draw2"; }
  else if (card.value === "wild4") { state.pendingDraw = 4; event = "wild4"; }

  if (hand.length === 0) { state.winner = playerId; state.unoVulnerable = null; return { ok: true, event }; }
  // 只剩 1 张且未喊 UNO：给其他玩家一个抓 UNO 的窗口
  if (hand.length === 1) state.unoVulnerable = { player: playerId, deadline: Date.now() + UNO_CATCH_MS };
  else if (state.unoVulnerable?.player === playerId) state.unoVulnerable = null;
  advanceTurn(state, event === "skip" ? 2 : 1);
  return { ok: true, event, drewThisTurn };
}

export function advanceTurn(state, steps = 1) {
  const n = state.players.length;
  state.turn = ((state.turn + state.direction * steps) % n + n) % n;
}

export function callUno(state, playerId) {
  if (!state.players.includes(playerId)) return { ok: false, error: "not in game" };
  if (state.hands[playerId].length !== 1) return { ok: false, error: "UNO can only be called with one card" };
  state.unoCalled[playerId] = true;
  if (state.unoVulnerable?.player === playerId) state.unoVulnerable = null;
  return { ok: true };
}

// 抓 UNO：在暴露窗口内抓到未喊 UNO 的玩家，罚其摸 2 张
export function catchUno(state, catcherId, now = Date.now()) {
  const v = state.unoVulnerable;
  if (state.winner) return { ok: false, error: "game over" };
  if (!state.players.includes(catcherId)) return { ok: false, error: "not in game" };
  if (!v) return { ok: false, error: "no uno to catch" };
  if (v.player === catcherId) return { ok: false, error: "cannot catch yourself" };
  if (now > v.deadline) { state.unoVulnerable = null; return { ok: false, error: "too late" }; }
  const hand = state.hands[v.player];
  for (let i = 0; i < 2; i++) {
    if (state.drawPile.length === 0) reshuffle(state);
    if (state.drawPile.length === 0) break;
    hand.push(state.drawPile.pop());
  }
  state.unoVulnerable = null;
  return { ok: true, target: v.player, drawn: hand.length };
}

// 摸牌后选择"留着"：结束回合
export function keepDrawn(state, playerId) {
  if (state.winner) return { ok: false, error: "game over" };
  if (state.players[state.turn] !== playerId) return { ok: false, error: "not your turn" };
  if (state.mayPlayDrawn == null) return { ok: false, error: "no drawn card" };
  state.mayPlayDrawn = null;
  advanceTurn(state, 1);
  return { ok: true };
}

// 摸牌（处理 pendingDraw 累积）
export function drawCards(state, playerId) {
  if (state.winner) return { ok: false, error: "game over" };
  const pid = state.players[state.turn];
  if (pid !== playerId) return { ok: false, error: "not your turn" };
  const count = state.pendingDraw > 0 ? state.pendingDraw : 1;
  const forced = state.pendingDraw > 0;
  state.pendingDraw = 0;
  const hand = state.hands[playerId];
  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0) reshuffle(state);
    if (state.drawPile.length === 0) break;
    hand.push(state.drawPile.pop());
  }
  // 主动摸 1 张且摸到的牌可出：保留回合，玩家可选择打出或留着
  const top = state.discard[state.discard.length - 1];
  if (!forced && count === 1 && canPlay(hand[hand.length - 1], top, state.activeColor)) {
    state.mayPlayDrawn = hand.length - 1;
    return { ok: true, drawn: count, mayPlay: true };
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
    unoCalled: state.unoCalled,
    mayPlayDrawn: state.mayPlayDrawn,
    unoVulnerable: state.unoVulnerable && state.unoVulnerable.deadline > Date.now()
      ? { player: state.unoVulnerable.player, remainingMs: state.unoVulnerable.deadline - Date.now() }
      : null,
  };
}
