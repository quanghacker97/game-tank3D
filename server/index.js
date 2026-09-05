'use strict';

const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const RoomManager = require('./RoomManager');
const { TICK_MS, ARENA_HALF_SIZE, OBSTACLES, STAGES, DIFFICULTIES } = require('./constants');

const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/stages', (req, res) => {
  res.json(
    STAGES.map((s) => ({
      id: s.id,
      chapter: s.chapter,
      stageInChapter: s.stageInChapter,
      name: s.name,
      theme: s.theme,
      objective: s.objective,
      botCount: s.botCount,
      isBoss: !!s.boss,
      bossName: s.boss ? s.boss.name : null,
      reward: s.reward,
    }))
  );
});

function cleanupSocketRoom(socket) {
  const { roomId, mode } = socket.data;
  if (!roomId) return;

  const game = RoomManager.getRoom(roomId);
  if (game) {
    game.removePlayer(socket.id);
    if (mode === 'arena') io.to(roomId).emit('playerLeft', { id: socket.id });
  }
  if (mode === 'campaign') RoomManager.destroyRoom(roomId);

  socket.leave(roomId);
  socket.data.roomId = null;
  socket.data.mode = null;
}

io.on('connection', (socket) => {
  socket.data.roomId = null;
  socket.data.mode = null;

  socket.on('join', (data) => {
    if (socket.data.roomId) return; // already in a room

    const name = data && typeof data.name === 'string' ? data.name : 'Tank';
    const loadout = (data && data.loadout) || {};
    const perks = (data && data.perks) || {};
    const mode = data && data.mode === 'campaign' ? 'campaign' : 'arena';

    if (mode === 'campaign') {
      const stageNumber = Number(data && data.stage);
      const difficultyKey = DIFFICULTIES[data && data.difficulty] ? data.difficulty : 'normal';
      const created = RoomManager.createCampaignRoom(socket.id, stageNumber, difficultyKey);
      if (!created) {
        socket.emit('joinError', { message: 'Ải không hợp lệ.' });
        return;
      }
      const { roomId, game } = created;
      game.addPlayer(socket.id, name, loadout, perks);
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.mode = 'campaign';

      socket.emit('init', {
        selfId: socket.id,
        mode: 'campaign',
        arenaHalfSize: ARENA_HALF_SIZE,
        obstacles: OBSTACLES,
        snapshot: game.snapshot(),
        stageStatus: game.getStageStatus(),
      });
    } else {
      const game = RoomManager.getArenaGame();
      const player = game.addPlayer(socket.id, name, loadout, perks);
      socket.join(RoomManager.ARENA_ROOM_ID);
      socket.data.roomId = RoomManager.ARENA_ROOM_ID;
      socket.data.mode = 'arena';

      socket.emit('init', {
        selfId: socket.id,
        mode: 'arena',
        arenaHalfSize: ARENA_HALF_SIZE,
        obstacles: OBSTACLES,
        snapshot: game.snapshot(),
      });
      socket.to(RoomManager.ARENA_ROOM_ID).emit('playerJoined', { id: player.id, name: player.name });
    }
  });

  socket.on('input', (input) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const game = RoomManager.getRoom(roomId);
    if (game) game.setInput(socket.id, input);
  });

  socket.on('leaveRoom', () => {
    cleanupSocketRoom(socket);
  });

  socket.on('disconnect', () => {
    cleanupSocketRoom(socket);
  });
});

setInterval(() => {
  for (const [roomId, game] of RoomManager.allRooms()) {
    game.tick();
    const events = game.flushEvents();
    io.to(roomId).emit('state', {
      t: Date.now(),
      snapshot: game.snapshot(),
      events,
      stageStatus: game.getStageStatus(),
    });
  }
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`Tank3D server listening on http://localhost:${PORT}`);
});
