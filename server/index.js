import express from "express";
import http from "http";
import { Server } from "socket.io";
import { newGame, playCard, drawCards, callUno, catchUno, keepDrawn, removePlayerFromState, rebindPlayerId, publicState, canPlay, COLORS } from "./game.js";
import { prepareRegistration, confirmRegistration, login, getUser, logout, profile, updateNickname, recordGame, publicProfile, leaderboard, recentGames } from "./store.js";

const PORT = process.env.PORT || 3001;
const MAX_PLAYERS = 7;   // 单房间座位上限（旁观席另限 8）
const app = express();
const server = http.createServer(app);
// CORS 白名单：站点自身 + 本地开发，禁止任意来源建立 WS 连接
const ALLOWED_ORIGINS = [process.env.APP_URL || "https://uno.qiulingyan.top", "https://chat.qiulingyan.top", "http://localhost:5173", "http://127.0.0.1:5173"];
const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] } });
app.set("trust proxy", true); // 经 openresty 反代，取 X-Forwarded-For 作为限速 IP
app.use(express.json({ limit: "16kb" }));
// hash 文件名内容不可变 → 30 天强缓存；index.html 保持无缓存，保证发版后引用立即生效
app.use("/assets", express.static(new URL("../dist/assets", import.meta.url).pathname, { maxAge: "30d", immutable: true }));
app.use(express.static(new URL("../dist", import.meta.url).pathname));

// 注册邮件限速：同邮箱 15 分钟最多 3 次、同 IP 1 小时最多 20 次，防止刷接口烧 Resend 配额
const registerAttempts = new Map();
function registerRateLimited(email, ip) {
  const now = Date.now();
  const hit = (key, limit, windowMs) => {
    const rec = registerAttempts.get(key);
    if (!rec || now - rec.first > windowMs) { registerAttempts.set(key, { first: now, count: 1 }); return false; }
    rec.count += 1;
    return rec.count > limit;
  };
  const limited = hit(`e:${email}`, 3, 15 * 60 * 1000) | hit(`i:${ip}`, 20, 60 * 60 * 1000);
  if (registerAttempts.size > 5000) registerAttempts.clear();
  return Boolean(limited);
}

const socketUsers = new Map();
const authFromRequest = req => getUser((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
const escapeHtml = value => String(value).replace(/[&<>\"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[char]);

async function sendVerificationEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !fromEmail) throw new Error('邮件服务尚未配置，请联系管理员');
  const fromName = process.env.RESEND_FROM_NAME || 'UNO PARTY';
  const appUrl = process.env.APP_URL || 'http://localhost:3001';
  const safeCode = escapeHtml(code);
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#101114;padding:36px 14px;font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#f7f5f2"><div style="display:none;max-height:0;overflow:hidden">你的 UNO PARTY 邮箱验证码是 ${safeCode}，10 分钟内有效。</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#191a1f;border:1px solid #34363d;border-radius:22px;overflow:hidden"><tr><td style="padding:30px 34px;background:linear-gradient(120deg,#ff596b,#ff914f);color:#fff"><div style="font-size:12px;letter-spacing:3px;font-weight:bold">UNO PARTY</div><h1 style="margin:22px 0 4px;font-size:28px">欢迎加入牌局</h1><p style="margin:0;font-size:14px;opacity:.92">验证邮箱，保存你的战绩与游戏时长</p></td></tr><tr><td style="padding:32px 34px"><p style="margin:0 0 12px;color:#c8c7cb;font-size:15px">请在注册页面输入以下验证码：</p><div style="padding:18px 12px;text-align:center;background:#111216;border:1px solid #373941;border-radius:14px"><span style="font-size:36px;letter-spacing:12px;font-weight:800;color:#ff7380">${safeCode}</span></div><p style="margin:16px 0 0;color:#9b9ca4;font-size:13px;line-height:1.7">验证码将在 <strong style="color:#f4c86a">10 分钟</strong>后失效。为保障账号安全，请勿将验证码告诉任何人。</p><div style="margin-top:28px;padding-top:18px;border-top:1px solid #34363d;color:#777982;font-size:12px;line-height:1.7">如果你没有发起注册，可以忽略这封邮件。<br><a href="${escapeHtml(appUrl)}" style="color:#ff8791;text-decoration:none">打开 UNO PARTY</a></div></td></tr></table><p style="margin:18px 0 0;text-align:center;color:#686a72;font-size:11px">© UNO PARTY · 和朋友来一局</p></td></tr></table></body></html>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${fromName} <${fromEmail}>`, to: [email], subject: 'UNO PARTY 邮箱验证码', html, text: `你的 UNO PARTY 邮箱验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略此邮件。` }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || payload.name || `Resend 邮件发送失败（HTTP ${response.status}）`);
  }
}
app.post("/api/register", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (registerRateLimited(email, req.ip)) return res.status(429).json({ ok: false, error: "请求太频繁，请稍后再试" });
  const result = prepareRegistration(req.body?.email, req.body?.password, req.body?.username);
  if (!result.ok) return res.status(400).json(result);
  try {
    await sendVerificationEmail(result.email, result.code);
    res.status(202).json({ ok: true, message: "验证码已发送，请查收邮件" });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message || "验证码邮件发送失败" });
  }
});
app.post("/api/register/confirm", (req, res) => {
  const result = confirmRegistration(req.body?.email, req.body?.code);
  if (!result.ok) return res.status(400).json(result);
  res.status(201).json({ ok: true, token: result.token, user: result.user });
});
app.post("/api/login", (req, res) => {
  const result = login(req.body?.email, req.body?.password);
  res.status(result.ok ? 200 : 401).json(result);
});
app.post("/api/logout", (req, res) => { logout((req.headers.authorization || "").replace(/^Bearer\s+/i, "")); res.json({ ok: true }); });
app.get("/api/me", (req, res) => {
  const user = authFromRequest(req);
  if (!user) return res.status(401).json({ error: "请先登录" });
  res.json(user);
});
app.get("/api/profile", (req, res) => {
  const user = authFromRequest(req);
  if (!user) return res.status(401).json({ error: "请先登录" });
  res.json({ ...profile(user.id), recent: recentGames(user.id) });
});

// 排行榜（公开）：胜率优先
app.get("/api/leaderboard", (_req, res) => res.json(leaderboard()));
app.patch("/api/profile", (req, res) => {
  const user = authFromRequest(req);
  if (!user) return res.status(401).json({ error: "请先登录" });
  const result = updateNickname(user.id, req.body?.nickname);
  if (!result.ok) return res.status(400).json(result);
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.user?.id === user.id) socket.data.user.nickname = result.nickname;
  }
  // 房间内显示名同步：座位/旁观席昵称即时更新并广播，无需重连
  for (const [c, room] of rooms) {
    let changed = false;
    for (const p of room.players) if (p.userId === user.id && p.name !== result.nickname) { p.name = result.nickname; changed = true; }
    for (const p of room.spectators || []) if (p.userId === user.id && p.name !== result.nickname) { p.name = result.nickname; changed = true; }
    if (changed) broadcast(room, c);
  }
  res.json({ ok: true, nickname: result.nickname });
});

// 游戏内点击对手头像查看公开战绩（不含 email）
app.get("/api/player/:username", (req, res) => {
  const row = publicProfile(req.params.username);
  if (!row) return res.status(404).json({ error: "玩家不存在" });
  res.json(row);
});

/** rooms: { code: { players: [{id,name,clientId,disconnectedAt}], state, started, lastActivity } } */
const rooms = new Map();
const ROOM_TTL_MS = 60 * 60 * 1000;
// 断线座位保留 1 小时（与房间 TTL 一致）：手机切后台/锁屏断连后，1 小时内回来仍能恢复座位，
// 之前 30 秒宽限导致"几分钟没操作房间就没了"
const RECONNECT_GRACE_MS = 60 * 60 * 1000;
// 回合倒计时：真人 60s，Bot 1.5-3s；超时自动出可出的牌、否则摸牌，防止挂机卡死全场
const TURN_MS = 60 * 1000;
let botSeq = 0;

function touch(room) { room.lastActivity = Date.now(); }

function isBot(p) { return !!p?.bot; }
function resetTurnTimer(room) {
  const pid = room.state && !room.state.winner ? room.state.players[room.state.turn] : null;
  const seat = room.players.find(p => p.id === pid);
  room.turnDeadline = pid ? Date.now() + (isBot(seat) ? 1000 + Math.floor(Math.random() * 2000) : TURN_MS) : null;
}

// 座位匹配：登录用户按 userId，匿名玩家按 clientId（前端持久化，刷新不丢状态）
function findPlayerIdx(room, userId, clientId) {
  let i = userId != null ? room.players.findIndex(p => p.userId === userId) : -1;
  if (i === -1 && clientId) i = room.players.findIndex(p => !p.userId && p.clientId === clientId);
  return i;
}
function findSpectatorIdx(room, userId, clientId) {
  if (!room.spectators) return -1;
  let i = userId != null ? room.spectators.findIndex(p => p.userId === userId) : -1;
  if (i === -1 && clientId) i = room.spectators.findIndex(p => !p.userId && p.clientId === clientId);
  return i;
}

// 同一账号/clientId 只能占据一个房间：防止登录用户在多个房间同时占座刷战绩
function seatElsewhere(userId, clientId, excludeCode) {
  for (const [code, room] of rooms) {
    if (code === excludeCode) continue;
    const seated = (room.players || []).concat(room.spectators || []);
    if (seated.some(p => (userId != null && p.userId === userId) || (userId == null && clientId && p.clientId === clientId))) return code;
  }
  return null;
}

// 一轮结束：房间回到等待状态，未满员时旁观者自动转正为玩家，房主可直接开下一轮
function endRound(room, code) {
  room.started = false;
  room.state = null;
  while (room.spectators?.length && room.players.length < MAX_PLAYERS) {
    room.players.push({ ...room.spectators.shift(), disconnectedAt: null });
  }
  touch(room);
  broadcast(room, code);
}

function isWithinGrace(player) {
  return player.disconnectedAt && Date.now() - player.disconnectedAt <= RECONNECT_GRACE_MS;
}

// 每分钟清理一次：1 小时无操作解散房间；清理超出宽限期的断线玩家/旁观者；处理到期的 votekick
const VOTEKICK_MS = 3 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - (room.lastActivity || 0) > ROOM_TTL_MS) {
      rooms.delete(code);
      continue;
    }
    // votekick 到期：把目标移出对局/房间（支持同时跟踪多个掉线玩家）
    if (room.kickTargets?.length) {
      const due = room.kickTargets.filter(k => now > k.until);
      if (due.length) {
        room.kickTargets = room.kickTargets.filter(k => now <= k.until);
        for (const k of due) {
          const target = room.players.find(p => p.id === k.playerId || p.clientId === k.clientId);
          if (!target) continue;
          const si = room.players.indexOf(target);
          if (si !== -1) room.players.splice(si, 1);
          if (room.started && room.state) {
            removePlayerFromState(room.state, target.id);
            if (room.players.length <= 1) {
              // 只剩一个玩家：结束游戏，不记战绩
              room.started = false; room.state = null;
              while (room.spectators?.length && room.players.length < MAX_PLAYERS) room.players.push({ ...room.spectators.shift(), disconnectedAt: null });
            }
          }
        }
        touch(room);
        // 到期移出后必须广播，否则所有客户端停留在过期状态
        broadcast(room, code);
      }
    }
    // 清理超出宽限期的断线玩家与旁观者
    let removed = false;
    for (let i = room.players.length - 1; i >= 0; i--) {
      const p = room.players[i];
      if (p.disconnectedAt && now - p.disconnectedAt > RECONNECT_GRACE_MS) {
        room.players.splice(i, 1);
        removed = true;
        // 对局仍在进行：把该玩家同步移出牌局状态，避免幽灵玩家卡死回合
        if (room.started && room.state && !room.state.winner) {
          removePlayerFromState(room.state, p.id);
          if (room.kickTargets) room.kickTargets = room.kickTargets.filter(k => k.playerId !== p.id);
          if (room.players.length <= 1) {
            room.started = false; room.state = null;
            while (room.spectators?.length && room.players.length < MAX_PLAYERS) room.players.push({ ...room.spectators.shift(), disconnectedAt: null });
          }
        }
      }
    }
    if (removed) { touch(room); broadcast(room, code); }
    if (room.spectators) {
      room.spectators = room.spectators.filter(s => !(s.disconnectedAt && now - s.disconnectedAt > RECONNECT_GRACE_MS));
    }
    // 房间空了也删掉
    if (room.players.length === 0 && (room.spectators || []).length === 0) rooms.delete(code);
  }
}, 60 * 1000).unref();

function saveFinishedGame(room, code) {
  if (!room?.state?.winner || room.saved) return;
  try {
    recordGame(code, room.startedAt, Date.now(), room.players.map(player => player.id), room.state.winner,
      id => room.seatUsers?.[id] ?? socketUsers.get(id)?.id ?? null);
    room.saved = true;
  } catch (error) {
    // 结算失败不能崩掉进程；saved 不置位，下次触发可重试
    console.error("recordGame failed:", error);
  }
}

io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  socket.data.user = getUser(auth.token);
  socket.data.clientId = auth.clientId;
  next();
});

// ===== 回合超时 / Bot 行动（共用同一套决策）=====
function bestPlayableIdx(state, pid) {
  const hand = state.hands[pid] || [];
  const top = state.discard[state.discard.length - 1];
  return hand.findIndex(c => state.pendingDraw > 0
    ? (c.value === "wild4" || (c.value === "draw2" && top.value === "draw2"))
    : canPlay(c, top, state.activeColor));
}
// Bot 策略：对手牌少时优先打功能牌压制；平时优先同色数字牌，万能牌尽量留到最后
function botPickIdx(state, pid) {
  const hand = state.hands[pid] || [];
  const top = state.discard[state.discard.length - 1];
  const nextPid = state.players[(state.turn + 1) % state.players.length];
  const nextCount = (state.hands[nextPid] || []).length;
  let best = -1, bestScore = -1;
  hand.forEach((c, i) => {
    const ok = state.pendingDraw > 0
      ? (c.value === "wild4" || (c.value === "draw2" && top.value === "draw2"))
      : canPlay(c, top, state.activeColor);
    if (!ok) return;
    let s;
    if (c.value === "wild4") s = nextCount <= 2 ? 9 : 1;
    else if (c.color === "wild") s = 2;
    else if (c.value === "skip" || c.value === "reverse" || c.value === "draw2") s = nextCount <= 2 ? 12 : 6;
    else s = 4 + (c.color === state.activeColor ? 1 : 0);
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return best;
}
function chosenColorFor(state, pid) {
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of state.hands[pid] || []) if (c.color in counts) counts[c.color]++;
  let best = COLORS[0], n = -1;
  for (const k of COLORS) if (counts[k] > n) { n = counts[k]; best = k; }
  return best;
}
// 对当前回合玩家执行"自动出牌/摸牌"；返回 true 表示动了牌局
function autoAct(room, code, { silent = false } = {}) {
  const state = room.state;
  if (!state || state.winner) return false;
  const pid = state.players[state.turn];
  const seat = room.players.find(p => p.id === pid);
  const name = seat?.name || "玩家";
  let moved = "";
  let idx = silent ? botPickIdx(state, pid) : bestPlayableIdx(state, pid);
  if (idx !== -1) {
    const card = state.hands[pid][idx];
    const r = playCard(state, pid, idx, card.color === "wild" ? chosenColorFor(state, pid) : undefined);
    if (r.ok) {
      moved = "自动出了一张牌";
      if ((state.hands[pid] || []).length === 1) callUno(state, pid);
    } else idx = -1;
  }
  if (idx === -1) {
    const r = drawCards(state, pid);
    if (!r.ok) return false;
    moved = state.pendingDraw === 0 && r.drawn ? "自动摸牌" : `摸了 ${r.drawn} 张`;
    // 主动摸 1 张且可出：超时规则为直接打出
    if (r.mayPlay) {
      const drawnIdx = state.mayPlayDrawn;
      const card = state.hands[pid][drawnIdx];
      playCard(state, pid, drawnIdx, card.color === "wild" ? chosenColorFor(state, pid) : undefined);
      moved = "超时打出刚摸的牌";
      if ((state.hands[pid] || []).length === 1) callUno(state, pid);
    }
  }
  if (!silent) io.to(code).emit("roomNotice", { text: `⏱ ${name} ${moved}` });
  afterAction(room, code);
  return true;
}
// 行动后统一处理：胜负结算/广播/重置回合倒计时
function afterAction(room, code) {
  touch(room);
  if (room.state?.winner) {
    room.turnDeadline = null;
    saveFinishedGame(room, code);
    // 结算画面即转正旁观者：不用等下一局才开始，下局直接入座
    while (room.spectators?.length && room.players.length < MAX_PLAYERS) {
      room.players.push({ ...room.spectators.shift(), disconnectedAt: null });
    }
    broadcast(room, code);
    return;
  }
  resetTurnTimer(room);
  broadcast(room, code);
}
// 每秒巡检：Bot 抓 UNO / Bot 行动 / 真人回合超时
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.started || !room.state || room.state.winner) continue;
    const state = room.state;
    // Bot 顺手抓 UNO：60% 概率在窗口内抓未喊 UNO 的真人/其他玩家
    if (state.unoVulnerable && now < state.unoVulnerable.deadline && Math.random() < 0.07) {
      const bot = room.players.find(p => p.bot && p.id !== state.unoVulnerable.player);
      if (bot) {
        const r = catchUno(state, bot.id, now);
        if (r.ok) {
          const targetName = room.players.find(p => p.id === r.target)?.name || "玩家";
          io.to(code).emit("roomNotice", { text: `🤖 ${bot.name} 抓到了 ${targetName} 的 UNO，罚摸两张` });
          broadcast(room, code);
        }
      }
    }
    if (now < (room.turnDeadline || 0)) continue;
    const pid = state.players[state.turn];
    const seat = room.players.find(p => p.id === pid);
    if (isBot(seat)) autoAct(room, code, { silent: true });
    else autoAct(room, code);
  }
}, 250).unref();


function genCode() {
  let c;
  do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms.has(c));
  return c;
}

function broadcast(room, code) {
  const names = Object.fromEntries(room.players.map(x => [x.id, x.name]));
  // 头像点击查看资料用：socketId → { name, username|null（null=游客）}
  const roster = Object.fromEntries(room.players.map(x => [x.id, { name: x.name, username: x.username || null }]));
  const spectatorNames = (room.spectators || []).map(x => x.name);
  const offlineIds = room.players.filter(p => p.disconnectedAt).map(p => p.id);
  const botIds = room.players.filter(p => p.bot).map(p => p.id);
  const kicks = (room.kickTargets || []).map(k => ({ playerId: k.playerId, until: k.until }));
  const curSeat = room.started && room.state && !room.state.winner ? room.players.find(p => p.id === room.state.players[room.state.turn]) : null;
  // 真人回合才显示倒计时；bot 回合不显示（前端等待即可）
  const turnEndsAt = room.started && room.state && !room.state.winner && !isBot(curSeat) ? room.turnDeadline || null : null;
  const roundSeconds = room.started && room.state?.winner && room.startedAt ? Math.max(1, Math.round((Date.now() - room.startedAt) / 1000)) : null;
  const base = { room: code, players: room.players.map(x => x.name), roster, spectatorNames, offlineIds, kicks, botIds, botNames: room.players.filter(p => p.bot).map(p => p.name), turnEndsAt, started: room.started, names, roundSeconds, unoCatches: room.started ? (room.unoCatches || 0) : 0 };
  for (const p of room.players) {
    const state = room.started ? publicState(room.state, p.id) : { handCounts: {}, turn: null };
    io.to(p.id).emit("state", { ...base, spectating: false, ...state });
  }
  for (const s of room.spectators || []) {
    const state = room.started ? publicState(room.state, null) : { handCounts: {}, turn: null };
    io.to(s.id).emit("state", { ...base, spectating: true, ...state });
  }
}

function removePlayer(socketId, code, room, { explicitLeave = false } = {}) {
  const i = room.players.findIndex(p => p.id === socketId);
  if (i !== -1) {
    const player = room.players[i];
    // 仅"主动离开"判负并结束对局；断线保留座位与对局，等待重连或 votekick
    if (explicitLeave && room.started && room.state && !room.state.winner) {
      room.state.winner = room.players.find(p => p.id !== socketId)?.id || null;
      if (room.state.winner) saveFinishedGame(room, code);
      // 有人中途离场：对局结束，房间回到等待状态，可再开一局（旁观者转正）
      endRound(room, code);
    }
    if (explicitLeave) {
      // 主动离开：彻底移除
      room.players.splice(i, 1);
    } else {
      // 断线：标记为断线，保留座位供宽限期内重连
      player.disconnectedAt = Date.now();
    }
    touch(room);
    broadcast(room, code);
    return true;
  }
  // 旁观者席
  const si = (room.spectators || []).findIndex(p => p.id === socketId);
  if (si === -1) return false;
  if (explicitLeave) room.spectators.splice(si, 1);
  else room.spectators[si].disconnectedAt = Date.now();
  touch(room);
  broadcast(room, code);
  return true;
}

io.on("connection", (socket) => {
  if (socket.data.user) socketUsers.set(socket.id, socket.data.user);
  socket.on("createRoom", ({ name, code: preferredCode }, cb) => {
    const upper = String(preferredCode || "").toUpperCase();
    const clientId = socket.data.clientId;
    const userId = socket.data.user?.id;

    if (upper && !/^[A-Z0-9]{4}$/.test(upper)) return cb?.({ ok: false, error: "房间码需为 4 位字母或数字" });
    // 跨房间重复占座拦截（本房间重连不受影响）
    const other = seatElsewhere(userId, clientId, upper);
    if (other) return cb?.({ ok: false, error: `你已在房间 ${other} 中，请先退出再加入` });

    // 如果提供了房间码且存在，尝试重连
    if (upper) {
      const existingRoom = rooms.get(upper);
      if (existingRoom) {
        existingRoom.spectators = existingRoom.spectators || [];
        const existingIdx = findPlayerIdx(existingRoom, userId, clientId);
        if (existingIdx !== -1 && (existingRoom.players[existingIdx].id === socket.id || isWithinGrace(existingRoom.players[existingIdx]))) {
          const player = existingRoom.players[existingIdx];
          if (player.id !== socket.id) {
            const oldId = player.id;
            player.id = socket.id;
            player.disconnectedAt = null;
            // 刷新/重连：同步重绑定牌局状态里的 socket id，恢复者才能继续出牌
            if (existingRoom.started && existingRoom.state && !existingRoom.state.winner) {
              rebindPlayerId(existingRoom.state, oldId, socket.id);
              if (existingRoom.kickTargets) for (const k of existingRoom.kickTargets) if (k.playerId === oldId) k.playerId = socket.id;
            }
            if (existingRoom.seatUsers?.[oldId] !== undefined) { existingRoom.seatUsers[socket.id] = existingRoom.seatUsers[oldId]; delete existingRoom.seatUsers[oldId]; }
          }
          player.userId = socket.data.user?.id || null;
          if (socket.data.user?.nickname) player.name = socket.data.user.nickname;
          player.username = socket.data.user?.username || null;
          if (socket.data.user) socketUsers.set(socket.id, socket.data.user);
          // 回线即取消 votekick 倒计时
          if (existingRoom.kickTargets) existingRoom.kickTargets = existingRoom.kickTargets.filter(k => !(k.clientId === clientId || (userId != null && k.userId === userId)));
          socket.join(upper);
          touch(existingRoom);
          broadcast(existingRoom, upper);
          return cb?.({ ok: true, code: upper });
        }
        // 房间存在但不是原房主重连，返回错误
        return cb?.({ ok: false, error: "房间码已存在" });
      }
    }

    // 创建新房间
    let code = upper || genCode();
    if (rooms.has(code)) return cb?.({ ok: false, error: "房间码已存在" });

    const roomName = socket.data.user?.nickname || name || "玩家1";
    rooms.set(code, {
      players: [{ id: socket.id, name: roomName, clientId, userId, username: socket.data.user?.username || null, disconnectedAt: null }],
      spectators: [],
      state: null,
      started: false,
      lastActivity: Date.now()
    });
    if (socket.data.user) socketUsers.set(socket.id, socket.data.user);
    socket.join(code);
    cb?.({ ok: true, code });
    const room = rooms.get(code);
    socket.emit("state", { room: code, players: room.players.map(x => x.name), started: false, handCounts: {}, turn: null });
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    const upper = String(code || "").toUpperCase();
    const room = rooms.get(upper);
    if (!room) return cb?.({ ok: false, error: "房间不存在" });
    room.spectators = room.spectators || [];

    const clientId = socket.data.clientId;
    const userId = socket.data.user?.id;
    // 跨房间重复占座拦截（本房间重连/恢复座位不受影响）
    const elsewhere = seatElsewhere(userId, clientId, upper);
    if (elsewhere) return cb?.({ ok: false, error: `你已在房间 ${elsewhere} 中，请先退出再加入` });
    const sameSocketIdx = room.players.findIndex(player => player.id === socket.id);
    let existingIdx = findPlayerIdx(room, userId, clientId);
    // 登出后的同浏览器重连：座位仍挂着 userId，但该账号已无任何在线 socket 时，
    // 允许按 clientId 收回座位（转成游客座位），避免出现"僵尸自己 + 新自己"
    if (existingIdx === -1 && userId == null && clientId) {
      const li = room.players.findIndex(p => p.clientId === clientId && p.userId != null);
      if (li !== -1 && ![...socketUsers.values()].some(u => u.id === room.players[li].userId)) existingIdx = li;
    }

    // 已占座玩家优先处理（含中局断线宽限期内的重连恢复座位），不被"游戏已开始"拦截
    if (existingIdx !== -1 || sameSocketIdx !== -1) {
      const playerIdx = existingIdx !== -1 ? existingIdx : sameSocketIdx;
      const player = room.players[playerIdx];
      // 已在座位：同一 socket 再次加入仅确认成功；断线后则恢复原座位。
      if (player.id === socket.id || isWithinGrace(player)) {
        if (player.id !== socket.id) {
          const oldId = player.id;
          player.id = socket.id;
          player.disconnectedAt = null;
          // 刷新/重连：同步重绑定牌局状态里的 socket id，恢复者才能继续出牌
          if (room.started && room.state && !room.state.winner) {
            rebindPlayerId(room.state, oldId, socket.id);
            if (room.kickTargets) for (const k of room.kickTargets) if (k.playerId === oldId) k.playerId = socket.id;
          }
          if (room.seatUsers?.[oldId] !== undefined) { room.seatUsers[socket.id] = room.seatUsers[oldId]; delete room.seatUsers[oldId]; }
        }
        player.userId = socket.data.user?.id || null;
        if (socket.data.user?.nickname) player.name = socket.data.user.nickname;
        player.username = socket.data.user?.username || null;
        if (socket.data.user) socketUsers.set(socket.id, socket.data.user);
        // 回线即取消 votekick 倒计时
        if (room.kickTargets) room.kickTargets = room.kickTargets.filter(k => !(k.clientId === clientId || (userId != null && k.userId === userId)));
        socket.join(upper);
        touch(room);
        broadcast(room, upper);
        return cb?.({ ok: true, code: upper });
      }
      return cb?.({ ok: false, error: "该账号已在此房间" });
    }

    // 旁观者恢复（断线重连）
    const specSame = room.spectators.findIndex(p => p.id === socket.id);
    const specIdx = findSpectatorIdx(room, userId, clientId);
    if (specSame !== -1 || specIdx !== -1) {
      const spec = room.spectators[specSame !== -1 ? specSame : specIdx];
      if (spec.id !== socket.id) {
        // 旁观者在线时不允许第二个连接接管（与玩家座位同等的保护）
        if (!spec.disconnectedAt) return cb?.({ ok: false, error: "该账号已在此房间" });
        if (spec.disconnectedAt && !isWithinGrace(spec) && specSame === -1) {
          return cb?.({ ok: false, error: "该账号已在此房间" });
        }
        spec.id = socket.id;
        spec.disconnectedAt = null;
      }
      if (socket.data.user?.nickname) spec.name = socket.data.user.nickname;
      spec.username = socket.data.user?.username || null;
      if (socket.data.user) socketUsers.set(socket.id, socket.data.user);
      socket.join(upper);
      touch(room);
      broadcast(room, upper);
      return cb?.({ ok: true, code: upper, spectating: true });
    }

    // 新座位：对局进行中加入的人当旁观者，本轮结束后未满员自动转正
    const joinName = socket.data.user?.nickname || name || `玩家${room.players.length + 1}`;
    if (room.started) {
      if (room.spectators.length >= 8) return cb?.({ ok: false, error: "旁观席已满" });
      room.spectators.push({ id: socket.id, name: joinName, clientId, userId, username: socket.data.user?.username || null, disconnectedAt: null });
      if (socket.data.user) socketUsers.set(socket.id, socket.data.user);
      socket.join(upper);
      touch(room);
      cb?.({ ok: true, code: upper, spectating: true });
      broadcast(room, upper);
      return;
    }
    if (room.players.length >= MAX_PLAYERS) return cb?.({ ok: false, error: "房间已满" });

    touch(room);
    room.players.push({
      id: socket.id,
      name: joinName,
      clientId,
      userId,
      username: socket.data.user?.username || null,
      disconnectedAt: null
    });
    if (socket.data.user) socketUsers.set(socket.id, socket.data.user);
    socket.join(upper);
    cb?.({ ok: true, code: upper });
    broadcast(room, upper);
  });

  socket.on("startGame", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.players.length < 2) return cb?.({ ok: false });
    if (room.started && !room.state?.winner) return cb?.({ ok: false });
    // 只有已占座玩家能开局：防止旁观者/路人拿到房间码替全员开始
    if (!room.players.some(p => p.id === socket.id)) return cb?.({ ok: false, error: "你不在此房间中" });
    touch(room);
    // 上一轮已结束（再来一局）：旁观者自动转正
    while (room.spectators?.length && room.players.length < MAX_PLAYERS) {
      room.players.push({ ...room.spectators.shift(), disconnectedAt: null });
    }
    room.started = true;
    room.startedAt = Date.now();
    room.saved = false;
    room.unoCatches = 0;
    // 开局即固定 userId 映射：对局中登出/断线导致 socketUsers 清理后，结算仍能记到战绩
    room.seatUsers = Object.fromEntries(room.players.map(p => [p.id, p.userId || null]));
    room.state = newGame(room.players.map(p => p.id));
    resetTurnTimer(room);
    broadcast(room, code);
    cb?.({ ok: true });
  });

  // Bot 补位：任意已占座玩家可在等待阶段添加/移除 AI 玩家
  socket.on("addBot", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "房间不存在" });
    if (room.started) return cb?.({ ok: false, error: "游戏已开始" });
    if (!room.players.some(p => p.id === socket.id)) return cb?.({ ok: false, error: "你不在此房间中" });
    if (room.players.length >= MAX_PLAYERS) return cb?.({ ok: false, error: "房间已满" });
    touch(room);
    room.players.push({ id: `bot:${++botSeq}`, name: `机器人 ${botSeq}`, clientId: null, userId: null, username: null, disconnectedAt: null, bot: true });
    cb?.({ ok: true });
    broadcast(room, code);
  });
  socket.on("removeBot", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.started) return cb?.({ ok: false, error: "游戏已开始" });
    const i = room.players.findLastIndex(p => p.bot);
    if (i === -1) return cb?.({ ok: false, error: "没有机器人" });
    room.players.splice(i, 1);
    touch(room);
    cb?.({ ok: true });
    broadcast(room, code);
  });

  socket.on("playCard", ({ code, cardIndex, chosenColor }) => {
    const room = rooms.get(code);
    if (!room?.state) return;
    const r = playCard(room.state, socket.id, cardIndex, chosenColor);
    if (!r.ok) return socket.emit("error-msg", { error: r.error });
    afterAction(room, code);
  });

  socket.on("draw", ({ code }) => {
    const room = rooms.get(code);
    if (!room?.state) return;
    const r = drawCards(room.state, socket.id);
    if (!r.ok) return socket.emit("error-msg", { error: r.error });
    afterAction(room, code);
  });

  socket.on("callUno", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room?.state) return cb?.({ ok: false, error: "game not started" });
    const result = callUno(room.state, socket.id);
    if (!result.ok) return cb?.(result);
    touch(room);
    room.unoCatches = (room.unoCatches || 0) + 1;
    broadcast(room, code);
    // 全房间突脸：UNO！
    const pname = room.players.find(p => p.id === socket.id)?.name || "有人";
    io.to(code).emit("uno-flash", { name: pname });
    cb?.({ ok: true });
  });

  // votekick：对掉线玩家发起，3 分钟倒计时内回线自动取消，到期移出对局；支持对多个掉线玩家分别发起
  socket.on("voteKick", ({ code, targetId }, cb) => {
    const room = rooms.get(code);
    if (!room?.started || !room.state) return cb?.({ ok: false, error: "游戏未开始" });
    if (!room.players.some(p => p.id === socket.id)) return cb?.({ ok: false, error: "你不在此对局中" });
    room.kickTargets = room.kickTargets || [];
    const offline = room.players.filter(p => p.disconnectedAt && !room.kickTargets.some(k => k.playerId === p.id));
    if (!offline.length) return cb?.({ ok: false, error: room.kickTargets.length ? "目标已在移出倒计时中" : "没有掉线玩家" });
    const target = targetId ? offline.find(p => p.id === targetId) : offline.sort((a, b) => a.disconnectedAt - b.disconnectedAt)[0];
    if (!target) return cb?.({ ok: false, error: "没有掉线玩家" });
    room.kickTargets.push({ playerId: target.id, clientId: target.clientId, userId: target.userId, until: Date.now() + VOTEKICK_MS });
    touch(room);
    broadcast(room, code);
    cb?.({ ok: true });
  });

  socket.on("catchUno", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room?.state) return cb?.({ ok: false, error: "game not started" });
    const result = catchUno(room.state, socket.id);
    if (!result.ok) return cb?.(result);
    touch(room);
    broadcast(room, code);
    cb?.({ ok: true, target: result.target });
  });

  socket.on("keepDrawn", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room?.state) return cb?.({ ok: false, error: "game not started" });
    const result = keepDrawn(room.state, socket.id);
    if (!result.ok) return cb?.(result);
    afterAction(room, code);
    cb?.({ ok: true });
  });

  socket.on("leaveRoom", ({ code }, cb) => {
    const upper = String(code || "").toUpperCase();
    const room = rooms.get(upper);
    if (room) { removePlayer(socket.id, upper, room, { explicitLeave: true }); socket.leave(upper); }
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    socketUsers.delete(socket.id);
    for (const [code, room] of rooms) removePlayer(socket.id, code, room);
  });
});

app.get("/healthz", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, "127.0.0.1", () => console.log(`uno-game listening on 127.0.0.1:${PORT}`));

// 进程级兜底：意外异常记日志而不退出（否则一个 handler 抛错 = 全部房间丢失）
process.on("uncaughtException", err => console.error("uncaughtException:", err));
process.on("unhandledRejection", err => console.error("unhandledRejection:", err));

export { app, server, io, rooms };
