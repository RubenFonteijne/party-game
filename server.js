const express = require("express");
const http = require("http");
const path = require("path");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;

const PROMPTS = [
  "Ooit wil ik nog eens op vakantie naar …",
  "Mijn favoriete eten is …",
  "Ik zou later graag willen wonen in …",
  "Mijn grootste guilty pleasure is …",
  "Ik kan echt niet zonder …",
  "Als ik morgen €1.000.000 win, dan koop ik als eerst …",
  "Mijn meest random talent is …",
  "Ik ben stiekem bang voor …",
  "Mijn perfecte weekend is …",
  "Ik zou nooit kunnen daten met iemand die …"
];

// roomCode -> room
const rooms = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function createRoom() {
  let code;
  do code = generateRoomCode();
  while (rooms.has(code));

  rooms.set(code, {
    code,
    players: new Map(),
    game: {
      state: "LOBBY",        // LOBBY | ANSWERING | REVEAL | SCOREBOARD
      round: 1,
      prompt: null,          // string
      submissions: {},       // { [playerId]: { self: string, predicts: { [otherId]: string } } }
      approvals: {},         // { [targetId]: { [predictorId]: true|false|null } }
      revealOrder: [],       // [playerId, ...]
      revealIndex: 0
    }
  });

  return code;
}

function getRoom(code) {
  return rooms.get(String(code || "").toUpperCase());
}

function snapshot(room, isHost) {
  const players = Array.from(room.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    ready: p.ready,
    connected: p.connected,
    score: p.score
  }));

  const base = {
    roomCode: room.code,
    maxPlayers: MAX_PLAYERS,
    state: room.game.state,
    players,
    round: room.game.round,
    revealOrder: room.game.revealOrder,
    revealIndex: room.game.revealIndex,
    submissionsCount: Object.keys(room.game.submissions || {}).length
  };

  // prompt + submissions + approvals alleen naar host
  if (isHost) {
    return {
      ...base,
      prompt: room.game.prompt,
      submissions: room.game.submissions,
      approvals: room.game.approvals
    };
  }

  return base;
}

function emitRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  io.to(`${roomCode}-host`).emit("roomState", snapshot(room, true));
  io.to(roomCode).emit("roomState", snapshot(room, false));
}

/* =======================
   ROUTES
======================= */

app.use(express.static(path.join(__dirname, "public")));

app.get("/host", (req, res) => {
  const code = createRoom();
  res.redirect(`/host/${code}`);
});

app.get("/host/:room", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "host.html"))
);

app.get("/join/:room", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "join.html"))
);

app.get("/api/qr", async (req, res) => {
  try {
    const text = (req.query.text || "").toString();
    if (!text) return res.status(400).json({ error: "Missing text" });
    const dataUrl = await QRCode.toDataURL(text, { margin: 1, scale: 8 });
    res.json({ dataUrl });
  } catch {
    res.status(500).json({ error: "QR generation failed" });
  }
});

/* =======================
   SOCKETS
======================= */

io.on("connection", (socket) => {

  socket.on("hostSubscribe", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit("errorMessage", "Room bestaat niet (meer).");
      return;
    }
    socket.join(`${room.code}-host`);
    emitRoom(room.code);
  });

  socket.on("joinRoom", ({ roomCode, name }) => {
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit("joinError", "Room bestaat niet (meer).");
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      socket.emit("joinError", "Room is vol (max 6 spelers).");
      return;
    }

    const trimmed = String(name || "").trim().slice(0, 24);
    if (!trimmed) {
      socket.emit("joinError", "Vul een naam in.");
      return;
    }

    const id = "p_" + Math.random().toString(36).slice(2, 9);

    room.players.set(id, {
      id,
      name: trimmed,
      ready: false,
      connected: true,
      score: 0,
      socketId: socket.id
    });

    socket.data.roomCode = room.code;
    socket.data.playerId = id;

    socket.join(room.code);
    socket.emit("joined", { playerId: id, roomCode: room.code, name: trimmed });

    emitRoom(room.code);
  });

  socket.on("setReady", ({ roomCode, playerId, ready }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const p = room.players.get(playerId);
    if (!p) return;

    if (p.socketId !== socket.id) return;
    p.ready = !!ready;

    emitRoom(room.code);
  });

  socket.on("hostStartGame", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    // minimaal 2 players en allemaal ready + connected
    const connected = Array.from(room.players.values()).filter(p => p.connected);
    if (connected.length < 2) return;

    const allReady = connected.every(p => p.ready);
    if (!allReady) return;

    room.game.state = "ANSWERING";
    room.game.prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
    room.game.submissions = {};
    room.game.approvals = {};
    room.game.revealOrder = Array.from(room.players.keys());
    room.game.revealIndex = 0;

    emitRoom(room.code);
  });

  socket.on("submitAnswers", ({ roomCode, playerId, self, predicts }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    if (room.game.state !== "ANSWERING") return;

    const p = room.players.get(playerId);
    if (!p || p.socketId !== socket.id) return;

    const cleanSelf = String(self || "").trim().slice(0, 80);
    const cleanPredicts = {};
    const rawPredicts = predicts && typeof predicts === "object" ? predicts : {};

    // alleen voorspellingen voor bestaande spelers
    for (const [otherId, val] of Object.entries(rawPredicts)) {
      if (!room.players.has(otherId)) continue;
      cleanPredicts[otherId] = String(val || "").trim().slice(0, 80);
    }

    room.game.submissions[playerId] = { self: cleanSelf, predicts: cleanPredicts };

    // als iedereen (die in room zit) submitted heeft → REVEAL
    if (Object.keys(room.game.submissions).length === room.players.size) {
      room.game.state = "REVEAL";
      // init approvals map per target
      room.game.approvals = {};
      for (const targetId of room.game.revealOrder) {
        room.game.approvals[targetId] = {};
        for (const predictorId of room.game.revealOrder) {
          if (predictorId === targetId) continue;
          room.game.approvals[targetId][predictorId] = null;
        }
      }
    }

    emitRoom(room.code);
  });

  // Host keurt een voorspelling goed/af (optie C)
  socket.on("hostSetApproval", ({ roomCode, targetId, predictorId, approved }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    if (room.game.state !== "REVEAL") return;

    const a = room.game.approvals?.[targetId];
    if (!a || !(predictorId in a)) return;

    const prev = a[predictorId];               // null | true | false
    const next = approved === true ? true : (approved === false ? false : null);

    if (prev === next) return;

    // score delta bij togglen
    const predictor = room.players.get(predictorId);
    if (predictor) {
      if (prev === true) predictor.score -= 1;
      if (next === true) predictor.score += 1;
    }

    a[predictorId] = next;
    emitRoom(room.code);
  });

  socket.on("hostNextReveal", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    if (room.game.state !== "REVEAL") return;

    room.game.revealIndex += 1;

    if (room.game.revealIndex >= room.game.revealOrder.length) {
      room.game.state = "SCOREBOARD";
    }

    emitRoom(room.code);
  });

  socket.on("hostNextRound", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    room.game.round += 1;
    room.game.state = "LOBBY";
    room.game.prompt = null;
    room.game.submissions = {};
    room.game.approvals = {};
    room.game.revealOrder = [];
    room.game.revealIndex = 0;

    // ready resetten zodat iedereen bewust opnieuw ready klikt
    for (const p of room.players.values()) {
      p.ready = false;
    }

    emitRoom(room.code);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!roomCode || !playerId) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const p = room.players.get(playerId);
    if (!p) return;

    p.connected = false;
    p.ready = false;

    emitRoom(room.code);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server draait op http://localhost:${PORT}`);
});
