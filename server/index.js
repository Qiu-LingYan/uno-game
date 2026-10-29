import express from "express";
import http from "http";
import { Server } from "socket.io";
import { newGame, playCard, drawCards, publicState } from "./game.js";

const PORT = process.env.PORT || 3001;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static(new URL("../dist", import.meta.url).pathname));

/** rooms: { code: { players: [{id,name}], state, started } } */
const rooms = new Map();

function genCode() {
  let c;
  do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms.has(c));
  return c;
}

function broadcast(room, code) {
  for (const p of room.players) {
    const state = room.started ? publicState(room.state, p.id) : { handCounts: {}, turn: null };
    io.to(p.id).emit("state", { room: code, players: room.players.map(x => x.name), started: room.started, ...state });
  }
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }, cb) => {
    const code = genCode();
    rooms.set(code, { players: [{ id: socket.id, name: name || "玩家1" }], state: null, started: false });
    socket.join(code);
    cb?.({ ok: true, code });
    const room = rooms.get(code);
    socket.emit("state", { room: code, players: rooms.get(code).players.map(x => x.name), started: false, handCounts: {}, turn: null });
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return cb?.({ ok: false, error: "房间不存在" });
    if (room.started) return cb?.({ ok: false, error: "游戏已开始" });
    if (room.players.length >= 4) return cb?.({ ok: false, error: "房间已满" });
    room.players.push({ id: socket.id, name: name || `玩家${room.players.length + 1}` });
    socket.join(code.toUpperCase());
    cb?.({ ok: true, code: code.toUpperCase() });
    broadcast(room, code.toUpperCase());
  });

  socket.on("startGame", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room || room.started || room.players.length < 2) return cb?.({ ok: false });
    room.started = true;
    room.state = newGame(room.players.map(p => p.id));
    broadcast(room, code);
    cb?.({ ok: true });
  });

  socket.on("playCard", ({ code, cardIndex, chosenColor }) => {
    const room = rooms.get(code);
    if (!room?.state) return;
    const r = playCard(room.state, socket.id, cardIndex, chosenColor);
    if (!r.ok) return socket.emit("error-msg", { error: r.error });
    broadcast(room, code);
  });

  socket.on("draw", ({ code }) => {
    const room = rooms.get(code);
    if (!room?.state) return;
    const r = drawCards(room.state, socket.id);
    if (!r.ok) return socket.emit("error-msg", { error: r.error });
    broadcast(room, code);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      const i = room.players.findIndex(p => p.id === socket.id);
      if (i === -1) continue;
      room.players.splice(i, 1);
      if (room.players.length === 0) { rooms.delete(code); continue; }
      if (room.started) room.state.winner = room.state.winner ?? room.players[0].id;
      broadcast(room, code);
    }
  });
});

app.get("/healthz", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

server.listen(PORT, "127.0.0.1", () => console.log(`uno-game listening on 127.0.0.1:${PORT}`));

export { app, server, io, rooms };
