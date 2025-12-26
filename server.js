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
const MAX_PLAYERS_DATING = 2;
const QUESTIONS_PER_ROUND = 10;

const THEMES = {
  default: [
    "Ooit wil ik nog eens op vakantie naar …",
    "Als ik voor de rest van mijn leven nog één keuken mag kiezen, dan kies ik de … keuken",
    "Ik zou later graag willen wonen in …",
    "Mijn grootste guilty pleasure is …",
    "Ik kan echt niet zonder …",
    "Als ik morgen €1.000.000 win, dan koop ik als eerste …",
    "Mijn meest random talent is …",
    "Mijn grootste irritant in het verkeer is …",
    "Op een zonnige dag op het terras, bestel ik ...",
    "Het eerste wat ik doe als ik wakker word is ...",
    "Als ik een superkracht mag kiezen, dan is dat ...",
    "Mijn favoriete genre muziek is ...",
    "Mijn favoriete kleur is ..."
  ],
  holidays: [
    "Mijn favoriete vakantiebestemming is …",
    "Op vakantie kan ik echt niet zonder …",
    "Het beste vakantiegevoel krijg ik van …",
    "Mijn droomvakantie is …",
    "Op vakantie eet ik het liefst …",
    "Het leukste aan vakantie is …",
    "Mijn ideale vakantie dag begint met …",
    "Op vakantie mis ik het meest …",
    "Mijn favoriete vakantieherinnering is …",
    "De perfecte vakantie is …",
    "Op vakantie lees ik graag …",
    "Mijn vakantie guilty pleasure is …",
    "Het beste vakantiegeschenk is …"
  ],
  "18+": [
    "Ik heb ooit een threesome gehad",
    "Ik heb ooit seks gehad in het openbaar",
    "Ik heb ooit een one-night stand gehad",
    "Ik heb ooit geflirt met iemand terwijl ik in een relatie zat",
    "Ik heb ooit iemand gezoend die ik niet kende",
    "Ik heb ooit een sexting gestuurd",
    "Ik heb ooit gedacht aan een collega tijdens seks",
    "Ik heb ooit een vriend(in) gehad met voordelen",
    "Ik heb ooit iemand gezoend van hetzelfde geslacht",
    "Ik heb ooit een date gehad via een dating app",
    "Ik heb ooit seks gehad op een ongewone plek",
    "Ik heb ooit iemand afgewezen omdat ze te saai waren in bed",
    "Ik heb ooit een fantasie gehad over een vriend(in)"
  ],
  dating: [
    "Mijn ideale date is …",
    "Het belangrijkste in een relatie is …",
    "Mijn grootste turn-on is …",
    "Mijn grootste turn-off is …",
    "Het perfecte eerste date gesprek gaat over …",
    "Mijn favoriete manier om te flirten is …",
    "Het meest romantische dat iemand voor me heeft gedaan is …",
    "Mijn droompartner is iemand die …",
    "Het leukste aan daten is …",
    "Mijn favoriete date locatie is …",
    "Het meest belangrijke in een eerste indruk is …",
    "Mijn ideale avond samen is …",
    "Het beste daten advies dat ik ooit kreeg was …"
  ],
  friendgroup: [
    "Met mijn vrienden kan ik altijd …",
    "Mijn favoriete vriendengroep activiteit is …",
    "Het beste aan mijn vrienden is …",
    "Met vrienden maak ik het liefst …",
    "Mijn favoriete herinnering met vrienden is …",
    "Het leukste aan vrienden is …",
    "Met vrienden ga ik het liefst naar …",
    "Mijn favoriete vriendengroep traditie is …",
    "Het beste vrienden moment was toen …",
    "Met vrienden deel ik altijd …",
    "Mijn favoriete vriendengroep inside joke gaat over …",
    "Het leukste aan onze vriendengroep is …",
    "Mijn favoriete vriendengroep avond bestaat uit …"
  ],
  work: [
    "Mijn favoriete werkdag is …",
    "Het beste aan mijn werk is …",
    "Mijn ideale collega is iemand die …",
    "Het leukste aan werken met collega's is …",
    "Mijn favoriete werkactiviteit is …",
    "Het beste team moment was toen …",
    "Mijn ideale werkdag begint met …",
    "Het leukste aan mijn team is …",
    "Mijn favoriete koffiepauze gesprek gaat over …",
    "Het beste aan samenwerken is …",
    "Mijn favoriete werk traditie is …",
    "Het leukste aan mijn collega's is …",
    "Mijn ideale werk omgeving heeft …"
  ]
};

const PROMPTS = THEMES.default;

// roomCode -> room
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
  s = s.replace(/[^a-z0-9\s]/g, " "); // punctuation weg
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

  if (na === nb) return true;

  const MIN_SUB = 4;
  if (na.length >= MIN_SUB && nb.includes(na)) return true;
  if (nb.length >= MIN_SUB && na.includes(nb)) return true;

  const ta = tokenize(na);
  const tb = tokenize(nb);
  if (!ta.length || !tb.length) return false;

  const setA = new Set(ta);
  const setB = new Set(tb);

  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;

  const union = new Set([...setA, ...setB]).size;
  const jaccard = union ? inter / union : 0;

  return jaccard >= 0.6;
}

/* =======================
   HELPERS
======================= */

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createRoom(theme = "default") {
  let code;
  do code = generateRoomCode();
  while (rooms.has(code));

  const validTheme = THEMES[theme] ? theme : "default";

  rooms.set(code, {
    code,
    theme: validTheme,
    players: new Map(),
    game: {
      state: "LOBBY",             // LOBBY | ANSWERING | REVEAL | SCOREBOARD
      round: 1,
      question: 0,                // 1..QUESTIONS_PER_ROUND tijdens ronde
      questionsPerRound: QUESTIONS_PER_ROUND,
      prompt: null,
      promptPool: [],

      submissions: {},            // { [playerId]: { self, predicts:{[otherId]:text} } }
      revealOrder: [],
      revealIndex: 0,

      matchMap: {},               // { [targetId]: { [predictorId]: true/false } }
      scoredPairs: {}             // { "r1q3:pX->pY": true }
    }
  });

  return code;
}

function getRoom(code) {
  return rooms.get(String(code || "").toUpperCase());
}

function startNewQuestion(room) {
  // vul promptPool opnieuw als nodig met theme-specifieke prompts
  if (!room.game.promptPool || room.game.promptPool.length === 0) {
    const themePrompts = THEMES[room.theme] || THEMES.default;
    room.game.promptPool = shuffle(themePrompts);
  }

  room.game.prompt = room.game.promptPool.shift();
  room.game.state = "ANSWERING";

  room.game.submissions = {};
  room.game.revealOrder = Array.from(room.players.keys());
  room.game.revealIndex = 0;

  room.game.matchMap = {};
  room.game.scoredPairs = {}; // per vraag resetten
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

function snapshot(room, isHost) {
  const players = playersArray(room);

  const maxPlayers = room.theme === "dating" ? MAX_PLAYERS_DATING : MAX_PLAYERS;
  const base = {
    roomCode: room.code,
    theme: room.theme || "default",
    maxPlayers: maxPlayers,
    state: room.game.state,
    players,
    round: room.game.round,
    question: room.game.question,
    questionsPerRound: room.game.questionsPerRound,
    submissionsCount: Object.keys(room.game.submissions || {}).length,
    revealOrder: room.game.revealOrder,
    revealIndex: room.game.revealIndex
  };

  if (!isHost) return base;

  // Host extra: alleen IDs van players die ingestuurd hebben (geen antwoorden)
  const submittedIds = Object.keys(room.game.submissions || {});

  // revealData voor host
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
    revealData,
    submittedIds
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
  const theme = req.query.theme || "default";
  const code = createRoom(theme);
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
    const maxPlayers = room.theme === "dating" ? MAX_PLAYERS_DATING : MAX_PLAYERS;
    if (room.players.size >= maxPlayers) {
      const maxText = room.theme === "dating" ? "max 2" : "max 6";
      return socket.emit("joinError", `Room is vol (${maxText}).`);
    }

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

  // Start ronde = vraag 1/10
  socket.on("hostStartGame", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const connected = Array.from(room.players.values()).filter(p => p.connected);
    if (connected.length < 2) return;

    const allReady = connected.every(p => p.ready);
    if (!allReady) return;

    // nieuwe ronde start: scores resetten
    for (const p of room.players.values()) p.score = 0;

    room.game.question = 1;
    room.game.questionsPerRound = QUESTIONS_PER_ROUND;
    const themePrompts = THEMES[room.theme] || THEMES.default;
    room.game.promptPool = shuffle(themePrompts);

    startNewQuestion(room);

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
      // matchMap bouwen
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

      // scores 1x per pair toekennen (per vraag)
      for (const targetId of room.game.revealOrder) {
        for (const predictorId of room.game.revealOrder) {
          if (predictorId === targetId) continue;
          const key = `r${room.game.round}q${room.game.question}:${predictorId}->${targetId}`;
          if (room.game.scoredPairs[key]) continue;

          const isMatch = room.game.matchMap?.[targetId]?.[predictorId] ?? false;
          if (isMatch) {
            const predictor = room.players.get(predictorId);
            if (predictor) predictor.score += 1;
          }
          room.game.scoredPairs[key] = true;
        }
      }

      room.game.state = "REVEAL";
      room.game.revealIndex = 0;
    }

    emitRoom(room.code);
  });

  // reveal per target speler
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

  // vanaf scoreboard naar volgende vraag of nieuwe ronde
  socket.on("hostNextQuestion", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.game.state !== "SCOREBOARD") return;

    if (room.game.question < room.game.questionsPerRound) {
      room.game.question += 1;
      startNewQuestion(room);
    } else {
      // ronde klaar -> terug naar lobby (ready reset)
      room.game.round += 1;
      room.game.question = 0;
      room.game.prompt = null;
      room.game.promptPool = [];
      room.game.submissions = {};
      room.game.revealOrder = [];
      room.game.revealIndex = 0;
      room.game.matchMap = {};
      room.game.scoredPairs = {};
      room.game.state = "LOBBY";

      for (const p of room.players.values()) p.ready = false;
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
