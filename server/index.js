import express from "express";
import http from "http";
import { Server } from "socket.io";
import { newGame, playCard, drawCards, callUno, catchUno, keepDrawn, publicState } from "./game.js";
import { prepareRegistration, confirmRegistration, login, getUser, logout, profile, updateNickname, recordGame } from "./store.js";

const PORT = process.env.PORT || 3001;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.json({ limit: "16kb" }));
app.use(express.static(new URL("../dist", import.meta.url).pathname));

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
  res.json(profile(user.id));
});
app.patch("/api/profile", (req, res) => {
  const user = authFromRequest(req);
  if (!user) return res.status(401).json({ error: "请先登录" });
  const result = updateNickname(user.id, req.body?.nickname);
  if (!result.ok) return res.status(400).json(result);
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.user?.id === user.id) socket.data.user.nickname = result.nickname;
  }
  res.json({ ok: true, nickname: result.nickname });
});

/** rooms: { code: { players: [{id,name,clientId,disconnectedAt}], state, started, lastActivity } } */
const rooms = new Map();
const ROOM_TTL_MS = 60 * 60 * 1000;
const RECONNECT_GRACE_MS = 30 * 1000;

function touch(room) { room.lastActivity = Date.now(); }
function playerClientId(socketId) { return io.sockets.sockets.get(socketId)?.data.clientId; }

function findPlayerByUserId(room, userId) {
  if (!userId) return -1;
  return room.players.findIndex(p => p.userId === userId);
}

function isWithinGrace(player) {
  return player.disconnectedAt && Date.now() - player.disconnectedAt <= RECONNECT_GRACE_MS;
}

// 每分钟清理一次：1 小时内没有任何加入或操作的房间自动解散；并清理超出宽限期的断线玩家
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - (room.lastActivity || 0) > ROOM_TTL_MS) {
      rooms.delete(code);
      continue;
    }
    // 清理超出宽限期的断线玩家
    for (let i = room.players.length - 1; i >= 0; i--) {
      const p = room.players[i];
      if (p.disconnectedAt && now - p.disconnectedAt > RECONNECT_GRACE_MS) {
        room.players.splice(i, 1);
        touch(room);
      }
    }
    // 房间空了也删掉
    if (room.players.length === 0) rooms.delete(code);
  }
}, 60 * 1000).unref();

function saveFinishedGame(room, code) {
  if (!room?.state?.winner || room.saved) return;
  room.saved = true;
  recordGame(code, room.startedAt, Date.now(), room.players.map(player => player.id), room.state.winner, id => socketUsers.get(id)?.id);
}

io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  socket.data.user = getUser(auth.token);
  socket.data.clientId = auth.clientId;
  next();
});

function genCode() {
  let c;
  do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms.has(c));
  return c;
}

function broadcast(room, code) {
  const names = Object.fromEntries(room.players.map(x => [x.id, x.name]));
  for (const p of room.players) {
    const state = room.started ? publicState(room.state, p.id) : { handCounts: {}, turn: null };
    io.to(p.id).emit("state", { room: code, players: room.players.map(x => x.name), started: room.started, names, ...state });
  }
}

function removePlayer(socketId, code, room, { explicitLeave = false } = {}) {
  const i = room.players.findIndex(p => p.id === socketId);
  if (i === -1) return false;
  const player = room.players[i];
  if (room.started && !room.state.winner) {
    room.state.winner = room.players.find(p => p.id !== socketId)?.id || null;
    if (room.state.winner) saveFinishedGame(room, code);
    // 有人中途离场：对局结束，房间回到等待状态，可再开一局
    room.started = false;
    room.state = null;
  }
  if (explicitLeave) {
    // 主动离开：彻底移除
    room.players.splice(i, 1);
  } else {
    // 断线：标记为断线，保留座位供宽限期内重连
    player.disconnectedAt = Date.now();
    player.id = socketId;
  }
  touch(room);
  broadcast(room, code);
  return true;
}

io.on("connection", (socket) => {
  if (socket.data.user) socketUsers.set(socket.id, socket.data.user);
  socket.on("createRoom", ({ name, code: preferredCode }, cb) => {
    const upper = (preferredCode || "").toUpperCase();
    const clientId = socket.data.clientId;
    const userId = socket.data.user?.id;

    // 如果提供了房间码且存在，尝试重连
    if (upper) {
      const existingRoom = rooms.get(upper);
      if (existingRoom) {
        const existingIdx = findPlayerByUserId(existingRoom, userId);
        if (existingIdx !== -1 && (existingRoom.players[existingIdx].id === socket.id || isWithinGrace(existingRoom.players[existingIdx]))) {
          const player = existingRoom.players[existingIdx];
          player.id = socket.id;
          player.disconnectedAt = null;
          if (socket.data.user?.nickname) player.name = socket.data.user.nickname;
          if (socket.data.user) socketUsers.set(socket.id, socket.data.user);
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
      players: [{ id: socket.id, name: roomName, clientId, userId, disconnectedAt: null }],
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
    const upper = (code || "").toUpperCase();
    const room = rooms.get(upper);
    if (!room) return cb?.({ ok: false, error: "房间不存在" });

    const clientId = socket.data.clientId;
    const userId = socket.data.user?.id;
    const existingIdx = findPlayerByUserId(room, userId);
    const sameSocketIdx = room.players.findIndex(player => player.id === socket.id);

    // 已占座玩家优先处理（含中局断线宽限期内的重连恢复座位），不被"游戏已开始"拦截
    if (existingIdx !== -1 || sameSocketIdx !== -1) {
      const playerIdx = existingIdx !== -1 ? existingIdx : sameSocketIdx;
      const player = room.players[playerIdx];
      // 已在座位：同一 socket 再次加入仅确认成功；断线后则恢复原座位。
      if (player.id === socket.id || isWithinGrace(player)) {
        if (player.id !== socket.id) {
          player.id = socket.id;
          player.disconnectedAt = null;
        }
        if (socket.data.user?.nickname) player.name = socket.data.user.nickname;
        if (socket.data.user) socketUsers.set(socket.id, socket.data.user);
        socket.join(upper);
        touch(room);
        broadcast(room, upper);
        return cb?.({ ok: true, code: upper });
      }
      return cb?.({ ok: false, error: "该账号已在此房间" });
    }

    if (room.started) return cb?.({ ok: false, error: "游戏已开始" });
    if (room.players.length >= 4) return cb?.({ ok: false, error: "房间已满" });

    touch(room);
    const newPlayer = {
      id: socket.id,
      name: socket.data.user?.nickname || name || `玩家${room.players.length + 1}`,
      clientId,
      userId,
      disconnectedAt: null
    };
    room.players.push(newPlayer);
    if (socket.data.user) socketUsers.set(socket.id, socket.data.user);
    socket.join(upper);
    cb?.({ ok: true, code: upper });
    broadcast(room, upper);
  });

  socket.on("startGame", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.started || room.players.length < 2) return cb?.({ ok: false });
    touch(room);
    room.started = true;
    room.startedAt = Date.now();
    room.saved = false;
    room.state = newGame(room.players.map(p => p.id));
    broadcast(room, code);
    cb?.({ ok: true });
  });

  socket.on("playCard", ({ code, cardIndex, chosenColor }) => {
    const room = rooms.get(code);
    if (!room?.state) return;
    const r = playCard(room.state, socket.id, cardIndex, chosenColor);
    if (!r.ok) return socket.emit("error-msg", { error: r.error });
    touch(room);
    if (room.state.winner) {
      saveFinishedGame(room, code);
      broadcast(room, code);
      // 让玩家看几秒胜利画面，随后房间回到等待状态，可以直接再来一局
      setTimeout(() => {
        if (room.state?.winner) { room.started = false; room.state = null; touch(room); broadcast(room, code); }
      }, 3000).unref();
      return;
    }
    broadcast(room, code);
  });

  socket.on("draw", ({ code }) => {
    const room = rooms.get(code);
    if (!room?.state) return;
    const r = drawCards(room.state, socket.id);
    if (!r.ok) return socket.emit("error-msg", { error: r.error });
    touch(room);
    broadcast(room, code);
  });

  socket.on("callUno", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room?.state) return cb?.({ ok: false, error: "game not started" });
    const result = callUno(room.state, socket.id);
    if (!result.ok) return cb?.(result);
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
    touch(room);
    broadcast(room, code);
    cb?.({ ok: true });
  });

  socket.on("leaveRoom", ({ code }, cb) => {
    const upper = (code || "").toUpperCase();
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

export { app, server, io, rooms };
