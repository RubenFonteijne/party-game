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

// roomCode -> { code, createdAt, players: Map(playerId -> playerObj) }
const rooms = new Map();

function generateRoomCode(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // zonder I/O/1/0
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function createRoom() {
  let code;
  do {
    code = generateRoomCode(4);
  } while (rooms.has(code));
  rooms.set(code, { code, createdAt: Date.now(), players: new Map() });
  return code;
}

function roomSnapshot(code) {
  const room = rooms.get(code);
  if (!room) return null;
  const players = Array.from(room.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    ready: p.ready,
    connected: p.connected,
  }));
  return { roomCode: code, maxPlayers: MAX_PLAYERS, players };
}

function emitRoomState(code) {
  const snap = roomSnapshot(code);
  if (!snap) return;
  io.to(code).emit("roomState", snap);
}

// Static
app.use(express.static(path.join(__dirname, "public")));

// Host entry: server genereert code en redirect
app.get("/host", (req, res) => {
  const code = createRoom();
  res.redirect(`/host/${code}`);
});

// Host page
app.get("/host/:room", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "host.html"));
});

// Join page
app.get("/join/:room", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "join.html"));
});

// QR endpoint (server-side QR generatie)
// GET /api/qr?text=<urlencoded>
app.get("/api/qr", async (req, res) => {
  try {
    const text = (req.query.text || "").toString();
    if (!text || text.length > 2048) {
      return res.status(400).json({ error: "Missing/invalid 'text' query param" });
    }
    const dataUrl = await QRCode.toDataURL(text, { margin: 1, scale: 8 });
    res.json({ dataUrl });
  } catch (e) {
    res.status(500).json({ error: "QR generation failed" });
  }
});

io.on("connection", (socket) => {
  // Host abonneert op room om lobby updates te krijgen
  socket.on("hostSubscribe", ({ roomCode }) => {
    const code = String(roomCode || "").toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit("errorMessage", "Room bestaat niet (meer).");
      return;
    }
    socket.join(code);
    socket.emit("roomState", roomSnapshot(code));
  });

  // Player join
  socket.on("joinRoom", ({ roomCode, name }) => {
    const code = String(roomCode || "").toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      socket.emit("joinError", "Room bestaat niet (meer).");
      return;
    }

    const trimmedName = String(name || "").trim().slice(0, 24);
    if (!trimmedName) {
      socket.emit("joinError", "Vul een naam in.");
      return;
    }

    // Max 6 players (telt ook disconnected players mee als ze nog in room zitten)
    // Voor MVP houden we het simpel: room.players size = max
    if (room.players.size >= MAX_PLAYERS) {
      socket.emit("joinError", "Room is vol (max 6 spelers).");
      return;
    }

    const playerId = `p_${Math.random().toString(36).slice(2, 9)}`;

    const player = {
      id: playerId,
      name: trimmedName,
      ready: false,
      connected: true,
      socketId: socket.id,
    };

    room.players.set(playerId, player);

    socket.data.role = "player";
    socket.data.roomCode = code;
    socket.data.playerId = playerId;

    socket.join(code);

    socket.emit("joined", {
      playerId,
      roomCode: code,
      name: trimmedName,
      maxPlayers: MAX_PLAYERS,
    });

    emitRoomState(code);
  });

  socket.on("setReady", ({ roomCode, playerId, ready }) => {
    const code = String(roomCode || "").toUpperCase();
    const room = rooms.get(code);
    if (!room) return;

    const p = room.players.get(playerId);
    if (!p) return;

    // Alleen de socket die die player is mag dit zetten (MVP security)
    if (p.socketId !== socket.id) return;

    p.ready = !!ready;
    emitRoomState(code);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) return;

    const room = rooms.get(code);
    if (!room) return;

    const p = room.players.get(playerId);
    if (!p) return;

    p.connected = false;
    p.ready = false;
    emitRoomState(code);
  });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server draait op http://localhost:${PORT}`);
  });