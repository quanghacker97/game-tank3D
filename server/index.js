'use strict';

const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const { Game } = require('./Game');
const { TICK_MS, ARENA_HALF_SIZE, OBSTACLES, TANK_MAX_HP } = require('./constants');

const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const game = new Game();

io.on('connection', (socket) => {
  let joined = false;

  socket.on('join', (data) => {
    if (joined) return;
    joined = true;
    const name = data && typeof data.name === 'string' ? data.name : 'Tank';
    const player = game.addPlayer(socket.id, name);

    socket.emit('init', {
      selfId: socket.id,
      arenaHalfSize: ARENA_HALF_SIZE,
      obstacles: OBSTACLES,
      tankMaxHp: TANK_MAX_HP,
      snapshot: game.snapshot(),
    });
    socket.broadcast.emit('playerJoined', { id: player.id, name: player.name });
  });

  socket.on('input', (input) => {
    if (!joined) return;
    game.setInput(socket.id, input);
  });

  socket.on('disconnect', () => {
    if (!joined) return;
    game.removePlayer(socket.id);
    io.emit('playerLeft', { id: socket.id });
  });
});

setInterval(() => {
  game.tick();
  const events = game.flushEvents();
  io.emit('state', { t: Date.now(), snapshot: game.snapshot(), events });
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`Tank3D server listening on http://localhost:${PORT}`);
});
