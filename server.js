import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { randomBytes } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

// Import engine functions from the project so the server is authoritative
import { initialState, generatePseudoLegalMoves, expandWithPortalOutcomes, filterLegalByCheck, applyResolvedMove, gameResult } from './engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static frontend files from project root
app.use(express.static(path.join(__dirname)));

// Serve images directory explicitly at /images so requests like
// GET /images/foo.png map to <project root>/images/foo.png
// This avoids any ambiguity with SPA fallbacks and ensures a clear
// mount point for image assets.
app.use('/images', express.static(path.join(__dirname, 'images')));

// Fallback to index.html for SPA/room deep links like /play/:id
// But only return index.html for requests that accept HTML. This prevents
// the catch-all from responding to requests for actual static assets
// (like .js/.css) which should be served by express.static above.
app.get('*', (req, res) => {
  // Only serve index.html for navigational requests that accept HTML and
  // that don't look like requests for a static file (no extension).
  // This avoids returning index.html for requests such as /ui.js which
  // should be handled by express.static and must return JS with correct
  // MIME types.
  const hasExt = !!path.extname(req.path);
  if (req.accepts && req.accepts('html') && !hasExt) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    // If the request explicitly looks like a static asset (has an
    // extension) or does not accept HTML, return 404 so that the client
    // doesn't receive HTML where JS/CSS is expected.
    res.status(404).send('Not found');
  }
});

// Simple in-memory rooms store. Each room holds game state and clock info.
// { roomId: { sockets: Set, state, locked, host, over, clock: {w,b}, lastTick, clockInterval } }
const rooms = new Map();

function makeRoomId(len = 5) {
  return randomBytes(Math.ceil(len/2)).toString('hex').slice(0, len);
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('createRoom', (payload, cb) => {
    // Support optional payload: createRoom({ timeMinutes: 5 }, cb)
    let timeMinutes = 10; // default
    let callback = cb;
    // If payload is actually the callback (legacy signature createRoom(cb))
    if (typeof payload === 'function') {
      callback = payload;
    } else if (payload && payload.timeMinutes) {
      const pm = parseInt(payload.timeMinutes, 10);
      if (Number.isFinite(pm) && pm > 0) timeMinutes = pm;
    }

    const roomId = makeRoomId(5);
    // room.over indicates the game has finished (checkmate/stalemate/timeout) and prevents further moves
    const timeMs = Math.max(1, timeMinutes) * 60 * 1000;
    const room = { sockets: new Set([socket.id]), state: initialState(), locked: false, host: socket.id, over: false, clock: { w: timeMs, b: timeMs }, lastTick: Date.now(), clockInterval: null };
    rooms.set(roomId, room);
    socket.join(roomId);
    console.log(`Room ${roomId} created by ${socket.id}`);
    if (typeof callback === 'function') callback({ roomId });
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
      io.to(whiteId).emit('gameStart', { roomId, color: 'w', state: room.state, clocks: room.clock });
      io.to(blackId).emit('gameStart', { roomId, color: 'b', state: room.state, clocks: room.clock });
      // Start the server-side ticking loop for the room clock
      startRoomClock(roomId);
      console.log(`Room ${roomId} locked: ${whiteId}=w, ${blackId}=b`);
    } else {
      // notify joined but waiting
      io.to(room.host).emit('playerJoined', { socketId: socket.id });
    }
    if (typeof cb === 'function') cb({ ok: true });
  });

  function startRoomClock(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.clockInterval) return; // already running
    room.lastTick = Date.now();
    room.clockInterval = setInterval(() => {
      try {
        tickRoomClock(roomId);
      } catch (e) { console.error('room clock tick error', e && e.message); }
    }, 250);
  }

  function stopRoomClock(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.clockInterval) {
      clearInterval(room.clockInterval);
      room.clockInterval = null;
    }
  }

  function tickRoomClock(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.over || !room.locked) return;
    const now = Date.now();
    const delta = now - (room.lastTick || now);
    room.lastTick = now;
    const turn = room.state && room.state.turn ? room.state.turn : 'w';
    if (!room.clock || typeof room.clock[turn] !== 'number') return;
    room.clock[turn] = Math.max(0, room.clock[turn] - delta);
    // Broadcast clock snapshot to clients for sync
    io.to(roomId).emit('clock', { clocks: { w: room.clock.w, b: room.clock.b }, turn, ts: now });
    // Timeout detection
    if (room.clock[turn] <= 0) {
      // current player timed out -> other player wins
      room.over = true;
      stopRoomClock(roomId);
      const winner = turn === 'w' ? 'black' : 'white';
      io.to(roomId).emit('gameEnd', { result: 'timeout', winner });
    }
  }

  socket.on('makeMove', async (data, cb) => {
    try {
      const { roomId, resolved } = data || {};
      if (!roomId || !resolved) return cb && cb({ error: 'invalid-payload' });
      const room = rooms.get(roomId);
      if (!room) return cb && cb({ error: 'not-found' });
  if (!room.locked) return cb && cb({ error: 'not-ready' });
  if (room.over) return cb && cb({ error: 'game-over' });

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

  // Before applying the move, advance the room clock to account for elapsed
  try { tickRoomClock(roomId); } catch (e) { /* ignore tick errors */ }

  // Accept the first matching outcome and apply
  const chosen = matches[0];
  const nextState = applyResolvedMove(room.state, chosen);
  room.state = nextState;
  // reset lastTick so server starts timing the next player from now
  room.lastTick = Date.now();

  // Broadcast to room (include latest clocks so clients can re-sync immediately)
  io.to(roomId).emit('moveMade', { resolved: chosen, state: nextState, clocks: room.clock });
  // Also emit an immediate clock snapshot
  io.to(roomId).emit('clock', { clocks: { w: room.clock.w, b: room.clock.b }, turn: room.state.turn, ts: room.lastTick });

      // Server-side game end detection (checkmate / stalemate)
      try {
        const res = gameResult(nextState);
        // Log the computed result so rendered deployments show the decision
        console.log(`gameResult for room ${roomId}:`, res);
        if (res && res.result && res.result !== 'ongoing') {
          room.over = true;
          // stop clock ticking for this room
          stopRoomClock(roomId);
          if (res.result === 'checkmate') {
            const winner = res.winner === 'w' ? 'white' : (res.winner === 'b' ? 'black' : null);
            io.to(roomId).emit('gameEnd', { result: 'checkmate', winner });
          } else if (res.result === 'stalemate') {
            io.to(roomId).emit('gameEnd', { result: 'stalemate' });
          }
        }
      } catch (e) {
        console.warn('game end detection failed', e && e.message);
      }
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
            // clear any running clock interval
            if (room.clockInterval) clearInterval(room.clockInterval);
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
