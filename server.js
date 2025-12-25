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
  "Als ik morgen €1.000.000 win, dan …",
  "Mijn meest random talent is …",
  "Ik ben stiekem bang voor …",
  "Mijn perfecte weekend is …",
  "Ik zou nooit kunnen daten met iemand die …"
];

const rooms = new Map();

/* =======================
   MATCHING (relaxed - optie C)
======================= */

const STOPWORDS_NL = new Set([
  "de","het","een","en","of","maar","ik","jij","je","u","we","wij","jullie","hij","zij","ze",
  "mijn","jouw","zijn","haar","onze","hun","naar","van","voor","met","zonder","op","in","uit",
  "die","dat","dit","daar","hier","nog","eens","echt","heel","veel","altijd","nooit"
]);

function stripDiacritics(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeAnswer(str) {
  let s = String(str || "").toLowerCase();
  s = stripDiacritics(s);
  s = s.replace(/[^a-z0-9\s]/g, " ");   // punctuation weg
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function tokenize(str) {
  const s = normalizeAnswer(str);
  if (!s) return [];
  return s
    .split(" ")
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOPWORDS_NL.has(t));
}

function computeMatchRelaxed(a, b) {
  const na = normalizeAnswer(a);
  const nb = normalizeAnswer(b);
  if (!na || !nb) return false;

  // exact match
  if (na === nb) return true;

  // substring match (min lengte)
  const MIN_SUB = 4;
  if (na.length >= MIN_SUB && nb.includes(na)) return true;
  if (nb.length >= MIN_SUB && na.includes(nb)) return true;

  // token overlap
  const ta = tokenize(na);
  const tb = tokenize(nb);
  if (!ta.length || !tb.length) return false;

  const setA = new Set(ta);
  const setB = new Set(tb);

  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;

  const union = new Set([...setA, ...setB]).size;
  const jaccard = union ? inter / union : 0;

  // relaxed threshold
  return jaccard >= 0.6;
}

/* =======================
   HELPERS
======================= */

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
      state: "LOBBY",         // LOBBY | ANSWERING | REVEAL | SCOREBOARD
      round: 1,
      prompt: null,           // string
      submissions: {},        // { [playerId]: { self, predicts:{[otherId]:text} } }
      revealOrder: [],        // [playerId,...] target volgorde
      revealIndex: 0,         // welke target nu
      matchMap: {},           // { [targetId]: { [predictorId]: true/false } }
      scoredPairs: {}         // { "r1:pX->pY": true }
    }
  });

  return code;
}

function getRoom(code) {
  return rooms.get(String(code || "").toUpperCase());
}

function playersArray(room) {
  return Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    ready: p.ready,
    connected: p.connected,
    score: p.score
  }));
}

/**
 * Host snapshot bevat:
 * - prompt
 * - submissions (alleen host)
 * - revealData voor animatie (alleen host)
 */
function snapshot(room, isHost) {
  const players = playersArray(room);

  const base = {
    roomCode: room.code,
    maxPlayers: MAX_PLAYERS,
    state: room.game.state,
    players,
    round: room.game.round,
    submissionsCount: Object.keys(room.game.submissions || {}).length,
    revealOrder: room.game.revealOrder,
    revealIndex: room.game.revealIndex
  };

  if (!isHost) return base;

  // current reveal data (voor de animatie)
  let revealData = null;
  if (room.game.state === "REVEAL") {
    const order = room.game.revealOrder || [];
    const idx = room.game.revealIndex || 0;
    const targetId = order[idx];

    const target = room.players.get(targetId);
    const targetAnswer = room.game.submissions?.[targetId]?.self ?? "";

    const predictors = players
      .filter(p => p.id !== targetId)
      .map(p => {
        const predicted = room.game.submissions?.[p.id]?.predicts?.[targetId] ?? "";
        const match = room.game.matchMap?.[targetId]?.[p.id] ?? false;
        return { predictorId: p.id, predictorName: p.name, predicted, match };
      });

    revealData = {
      targetId,
      targetName: target?.name || "",
      targetAnswer,
      predictors
    };
  }

  return {
    ...base,
    prompt: room.game.prompt,
    submissions: room.game.submissions,
    revealData
  };
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
    if (!room) return socket.emit("joinError", "Room bestaat niet (meer).");
    if (room.players.size >= MAX_PLAYERS) return socket.emit("joinError", "Room is vol (max 6).");

    const trimmed = String(name || "").trim().slice(0, 24);
    if (!trimmed) return socket.emit("joinError", "Vul een naam in.");

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
    if (!p || p.socketId !== socket.id) return;

    p.ready = !!ready;
    emitRoom(room.code);
  });

  socket.on("hostStartGame", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const connected = Array.from(room.players.values()).filter(p => p.connected);
    if (connected.length < 2) return;

    const allReady = connected.every(p => p.ready);
    if (!allReady) return;

    room.game.state = "ANSWERING";
    room.game.prompt = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
    room.game.submissions = {};
    room.game.revealOrder = Array.from(room.players.keys());
    room.game.revealIndex = 0;
    room.game.matchMap = {};
    room.game.scoredPairs = {}; // reset per ronde

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
    for (const [otherId, val] of Object.entries(rawPredicts)) {
      if (!room.players.has(otherId)) continue;
      cleanPredicts[otherId] = String(val || "").trim().slice(0, 80);
    }

    room.game.submissions[playerId] = { self: cleanSelf, predicts: cleanPredicts };

    // iedereen submitted?
    if (Object.keys(room.game.submissions).length === room.players.size) {
      // 1) matchMap opbouwen
      room.game.matchMap = {};
      for (const targetId of room.game.revealOrder) {
        room.game.matchMap[targetId] = {};
        const targetSelf = room.game.submissions?.[targetId]?.self ?? "";

        for (const predictorId of room.game.revealOrder) {
          if (predictorId === targetId) continue;
          const predicted = room.game.submissions?.[predictorId]?.predicts?.[targetId] ?? "";
          room.game.matchMap[targetId][predictorId] = computeMatchRelaxed(targetSelf, predicted);
        }
      }

      // 2) scores automatisch 1x toekennen
      // score = predictor krijgt punt als predictor matcht target
      for (const targetId of room.game.revealOrder) {
        for (const predictorId of room.game.revealOrder) {
          if (predictorId === targetId) continue;
          const key = `r${room.game.round}:${predictorId}->${targetId}`;
          if (room.game.scoredPairs[key]) continue;

          const isMatch = room.game.matchMap?.[targetId]?.[predictorId] ?? false;
          if (isMatch) {
            const predictor = room.players.get(predictorId);
            if (predictor) predictor.score += 1;
          }
          room.game.scoredPairs[key] = true;
        }
      }

      // 3) reveal state
      room.game.state = "REVEAL";
      room.game.revealIndex = 0;
    }

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
    room.game.revealOrder = [];
    room.game.revealIndex = 0;
    room.game.matchMap = {};
    room.game.scoredPairs = {};

    // ready reset
    for (const p of room.players.values()) p.ready = false;

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
