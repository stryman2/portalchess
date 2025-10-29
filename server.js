import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { randomBytes } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

// Import engine functions from the project so the server is authoritative
import { initialState, generatePseudoLegalMoves, expandWithPortalOutcomes, filterLegalByCheck, applyResolvedMove } from './engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static frontend files from project root
app.use(express.static(path.join(__dirname)));

// Fallback to index.html for SPA/room deep links like /play/:id
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Simple in-memory rooms store. { roomId: { sockets: Set, state, locked, hostSocketId } }
const rooms = new Map();

function makeRoomId(len = 5) {
  return randomBytes(Math.ceil(len/2)).toString('hex').slice(0, len);
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('createRoom', (cb) => {
    const roomId = makeRoomId(5);
    const room = { sockets: new Set([socket.id]), state: initialState(), locked: false, host: socket.id };
    rooms.set(roomId, room);
    socket.join(roomId);
    console.log(`Room ${roomId} created by ${socket.id}`);
    if (typeof cb === 'function') cb({ roomId });
  });

  socket.on('joinRoom', (data, cb) => {
    const roomId = (data && data.roomId) || data;
    if (!roomId) return cb && cb({ error: 'missing-room-id' });
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ error: 'not-found' });
    if (room.locked) return cb && cb({ error: 'room-locked' });
    room.sockets.add(socket.id);
    socket.join(roomId);
    console.log(`${socket.id} joined room ${roomId}`);
    // If two players present, lock and start
    if (room.sockets.size >= 2) {
      room.locked = true;
      const ids = Array.from(room.sockets);
      const whiteId = room.host || ids[0];
      const blackId = ids.find(id => id !== whiteId) || ids[1];
      // send gameStart to both players with assigned color and initial state
      io.to(whiteId).emit('gameStart', { roomId, color: 'w', state: room.state });
      io.to(blackId).emit('gameStart', { roomId, color: 'b', state: room.state });
      console.log(`Room ${roomId} locked: ${whiteId}=w, ${blackId}=b`);
    } else {
      // notify joined but waiting
      io.to(room.host).emit('playerJoined', { socketId: socket.id });
    }
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('makeMove', async (data, cb) => {
    try {
      const { roomId, resolved } = data || {};
      if (!roomId || !resolved) return cb && cb({ error: 'invalid-payload' });
      const room = rooms.get(roomId);
      if (!room) return cb && cb({ error: 'not-found' });
      if (!room.locked) return cb && cb({ error: 'not-ready' });

      // Validate that it's this player's turn. We don't track which socket is which color
      // beyond the initial assignment, so for simplicity accept moves and validate via state.turn.

      // Generate all legal resolved outcomes for the moving piece from the server state
      const from = (resolved.from || '').toUpperCase();
      const baseMoves = generatePseudoLegalMoves(room.state, from);
      let outcomes = [];
      for (const bm of baseMoves) outcomes.push(...expandWithPortalOutcomes(room.state, bm));
      outcomes = filterLegalByCheck(room.state, outcomes);

      // Find matching outcome by comparing key properties (toFinal/to, kind, viaPortal.choice/meta.promo)
      const matches = outcomes.filter(o => {
        const aTo = (o.toFinal || o.to || '').toUpperCase();
        const bTo = (resolved.toFinal || resolved.to || '').toUpperCase();
        if (aTo !== bTo) return false;
        if ((o.kind || '') !== (resolved.kind || '')) return false;
        // compare promo if present
        if ((o.promo || o.meta?.promo || '') !== (resolved.promo || resolved.meta?.promo || '')) return false;
        // compare portal choice if present
        const aChoice = o.viaPortal && o.viaPortal.choice ? o.viaPortal.choice.toUpperCase() : '';
        const bChoice = resolved.viaPortal && resolved.viaPortal.choice ? resolved.viaPortal.choice.toUpperCase() : '';
        if (aChoice !== bChoice) return false;
        return true;
      });

      if (matches.length === 0) {
        console.warn('Rejected move: no matching legal outcome');
        return cb && cb({ error: 'illegal-move' });
      }

      // Accept the first matching outcome and apply
      const chosen = matches[0];
      const nextState = applyResolvedMove(room.state, chosen);
      room.state = nextState;

      // Broadcast to room
      io.to(roomId).emit('moveMade', { resolved: chosen, state: nextState });
      return cb && cb({ ok: true });
    } catch (err) {
      console.error('makeMove error', err);
      return cb && cb({ error: 'server-error', detail: err && err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
    // remove from any rooms
    for (const [roomId, room] of rooms.entries()) {
      if (room.sockets.has(socket.id)) {
        room.sockets.delete(socket.id);
        io.to(roomId).emit('playerLeft', { socketId: socket.id });
        // If room is empty, delete it
        if (room.sockets.size === 0) {
          rooms.delete(roomId);
          console.log(`Room ${roomId} removed (empty)`);
        } else {
          // unlock room if someone leaves so a new player can join
          room.locked = false;
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
