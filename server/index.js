'use strict';

const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const RoomManager = require('./RoomManager');
const {
  TICK_MS,
  ARENA_HALF_SIZE,
  OBSTACLES,
  STAGES,
  DIFFICULTIES,
  TEAM_COLORS,
  DAILY_MODIFIERS,
  DAILY_BONUS_REWARD,
  getDailyStageId,
  getDailyModifierKey,
} = require('./constants');

const PORT = process.env.PORT || 3000;

// Reconnect (section 3.1-3.3): how long a room keeps a disconnected
// player's state around (mines/kills/position/perks — not just re-adding
// them as a stranger) before finally giving up and treating it as a real
// leave. One flat value for every mode — long enough to survive a phone
// screen lock or a Wi-Fi blip, short enough that a genuine leave doesn't
// leave a solo campaign/survival room lingering for real.
const RECONNECT_GRACE_MS = 20000;

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
      hasHazards: s.hazards.length > 0,
      hasOptionalObjective: !!s.optionalObjective,
    }))
  );
});

// Pre-join info for the client's Team Deathmatch team-select screen (live
// Red/Blue counts + a client-side-only balance hint) -- reads the
// persistent team room directly; no socket join needed since
// RoomManager.getTeamGame() always exists from module load. Never creates a
// room just because this was requested.
app.get('/api/team-counts', (req, res) => {
  const game = RoomManager.getTeamGame();
  res.json(game ? game.getTeamCounts() : { red: 0, blue: 0 });
});

// Same precedent for King of the Hill's team-select screen (section 5.1-5.3).
app.get('/api/koth-counts', (req, res) => {
  const game = RoomManager.getKothGame();
  res.json(game ? game.getTeamCounts() : { red: 0, blue: 0 });
});

// Pre-join info for the Endless/Survival "solo or co-op" screen — live
// headcount of the one persistent shared co-op room, same precedent as
// /api/team-counts above.
app.get('/api/survival-coop-count', (req, res) => {
  const game = RoomManager.getSurvivalCoopGame();
  const count = game ? Array.from(game.players.values()).filter((p) => !p.isBot).length : 0;
  res.json({ count });
});

// Same precedent for the Daily Survival co-op room (follow-up).
app.get('/api/survival-coop-daily-count', (req, res) => {
  const game = RoomManager.getRoom(RoomManager.SURVIVAL_COOP_DAILY_ROOM_ID);
  const count = game ? Array.from(game.players.values()).filter((p) => !p.isBot).length : 0;
  res.json({ count });
});

// Pre-join info for the Daily Challenge menu entry (section 2.6) — today's
// fixed stage + modifier, purely computed from the clock (see
// getDailyStageId/getDailyModifierKey), so the client can show what it is
// before the player commits to joining.
app.get('/api/daily', (req, res) => {
  const stageId = getDailyStageId();
  const modifierKey = getDailyModifierKey();
  const modifier = DAILY_MODIFIERS[modifierKey];
  const stageDef = STAGES[stageId - 1];
  res.json({
    stageId,
    stageName: stageDef ? stageDef.name : '',
    modifierLabel: modifier.label,
    modifierDesc: modifier.desc,
    bonusReward: DAILY_BONUS_REWARD,
  });
});

// The actual "this player is really gone" logic — shared by an explicit
// leaveRoom (immediate) and a disconnect's grace timer expiring (delayed).
// Takes plain values rather than a live socket since the delayed path runs
// long after the original socket object is gone.
function finalizeLeave(roomId, mode, socketId) {
  const isSurvivalCoop =
    mode === 'survival' && (roomId === RoomManager.SURVIVAL_COOP_ROOM_ID || roomId === RoomManager.SURVIVAL_COOP_DAILY_ROOM_ID);
  const game = RoomManager.getRoom(roomId);
  if (game) {
    game.removePlayer(socketId);
    if (mode === 'arena' || mode === 'team' || mode === 'koth' || isSurvivalCoop) io.to(roomId).emit('playerLeft', { id: socketId });
  }
  // Solo survival rooms are per-socket, just like campaign — clean them up
  // once truly abandoned; the shared co-op room (like arena/team/koth) persists.
  if (mode === 'campaign' || (mode === 'survival' && !isSurvivalCoop)) RoomManager.destroyRoom(roomId);
}

function cleanupSocketRoom(socket) {
  const { roomId, mode } = socket.data;
  if (!roomId) return;
  finalizeLeave(roomId, mode, socket.id);
  socket.leave(roomId);
  socket.data.roomId = null;
  socket.data.mode = null;
}

io.on('connection', (socket) => {
  socket.data.roomId = null;
  socket.data.mode = null;

  socket.on('join', (data) => {
    if (socket.data.roomId) return; // already in a room

    // Reconnect (section 3.1-3.3): a self-generated, opaque session id the
    // client persists across reloads/reconnects (never an auth credential —
    // just enough to say "same browser tab as before"). If it matches a
    // still-pending disconnect, resume that SAME player in that SAME room
    // instead of starting a fresh join below.
    const sessionId = data && typeof data.sessionId === 'string' && data.sessionId.length > 0 && data.sessionId.length <= 100 ? data.sessionId : null;
    socket.data.sessionId = sessionId;

    if (sessionId) {
      const pending = RoomManager.peekPendingDisconnect(sessionId);
      if (pending) {
        const game = RoomManager.getRoom(pending.roomId);
        const player = game && game.reconnectPlayer(pending.oldSocketId, socket.id);
        if (game && player) {
          RoomManager.takePendingDisconnect(sessionId);
          socket.join(pending.roomId);
          socket.data.roomId = pending.roomId;
          socket.data.mode = pending.mode;
          socket.emit('init', {
            selfId: socket.id,
            mode: pending.mode,
            arenaHalfSize: ARENA_HALF_SIZE,
            obstacles: OBSTACLES,
            snapshot: game.snapshot(),
            stageStatus: game.getStageStatus(),
            reconnected: true,
          });
          return;
        }
        // The room's already gone (grace genuinely lapsed, or it was
        // destroyed for some other reason) -- discard the stale entry and
        // fall through to a completely fresh join below.
        RoomManager.takePendingDisconnect(sessionId);
      }
    }

    const name = data && typeof data.name === 'string' ? data.name : 'Tank';
    const loadout = (data && data.loadout) || {};
    const perks = (data && data.perks) || {};
    // Tank skins (section 4.1-4.2 follow-up): Game.addPlayer itself is the
    // real validator (against SKIN_IDS) -- this is just plumbing the raw
    // client-claimed id through, same "pass it down, let Game.js decide"
    // shape as loadout/perks/team above.
    const skinId = data && typeof data.skin === 'string' ? data.skin : null;
    // Daily Challenge (section 2.6) is just Campaign underneath — same
    // wave/objective/hazard/boss machinery, a stage + modifier the server
    // alone picks from the clock. Folding it into 'campaign' here (rather
    // than a distinct mode string) means every existing 'campaign' HUD/
    // gate on the client keeps working with zero changes.
    const isDaily = !!(data && data.mode === 'daily');
    // Daily Survival (follow-up to the Daily Challenge above): same "fold
    // into the real mode, remember the daily-ness in one flag" shape --
    // every existing 'survival' HUD/gate on the client keeps working
    // unmodified, it just also carries today's modifier + bonus reward.
    const isDailySurvival = !!(data && data.mode === 'survivalDaily');
    const mode =
      data && (data.mode === 'campaign' || isDaily)
        ? 'campaign'
        : data && data.mode === 'team'
        ? 'team'
        : data && data.mode === 'koth'
        ? 'koth'
        : data && (data.mode === 'survival' || isDailySurvival)
        ? 'survival'
        : 'arena';

    if (mode === 'campaign') {
      const stageNumber = isDaily ? getDailyStageId() : Number(data && data.stage);
      const difficultyKey = DIFFICULTIES[data && data.difficulty] ? data.difficulty : 'normal';
      const dailyModifierKey = isDaily ? getDailyModifierKey() : undefined;
      const created = RoomManager.createCampaignRoom(socket.id, stageNumber, difficultyKey, dailyModifierKey);
      if (!created) {
        socket.emit('joinError', { message: 'Ải không hợp lệ.' });
        return;
      }
      const { roomId, game } = created;
      game.addPlayer(socket.id, name, loadout, perks, null, skinId);
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
    } else if (mode === 'team') {
      const game = RoomManager.getTeamGame();
      // Team selection (section: Team Deathmatch team-select screen): the
      // player may request a specific side from the team-select screen —
      // never trust it blindly, only TEAM_COLORS' own keys are valid (same
      // check addPlayer() itself repeats as a second layer of defense). A
      // missing/invalid value (the "Tự động cân bằng" choice, or a
      // malformed/tampered payload) falls back to the existing auto-balance.
      const requestedTeam = data && typeof data.team === 'string' ? data.team : null;
      const team = requestedTeam && TEAM_COLORS[requestedTeam] ? requestedTeam : game.assignTeam();
      const player = game.addPlayer(socket.id, name, loadout, perks, team, skinId);
      socket.join(RoomManager.TEAM_ROOM_ID);
      socket.data.roomId = RoomManager.TEAM_ROOM_ID;
      socket.data.mode = 'team';

      socket.emit('init', {
        selfId: socket.id,
        mode: 'team',
        arenaHalfSize: ARENA_HALF_SIZE,
        obstacles: OBSTACLES,
        snapshot: game.snapshot(),
      });
      socket.to(RoomManager.TEAM_ROOM_ID).emit('playerJoined', { id: player.id, name: player.name });
    } else if (mode === 'koth') {
      const game = RoomManager.getKothGame();
      // Same free-choice-with-auto-balance-fallback validation as Team
      // Deathmatch above -- King of the Hill is a straight variant of it.
      const requestedTeam = data && typeof data.team === 'string' ? data.team : null;
      const team = requestedTeam && TEAM_COLORS[requestedTeam] ? requestedTeam : game.assignTeam();
      const player = game.addPlayer(socket.id, name, loadout, perks, team, skinId);
      socket.join(RoomManager.KOTH_ROOM_ID);
      socket.data.roomId = RoomManager.KOTH_ROOM_ID;
      socket.data.mode = 'koth';

      socket.emit('init', {
        selfId: socket.id,
        mode: 'koth',
        arenaHalfSize: ARENA_HALF_SIZE,
        obstacles: OBSTACLES,
        snapshot: game.snapshot(),
      });
      socket.to(RoomManager.KOTH_ROOM_ID).emit('playerJoined', { id: player.id, name: player.name });
    } else if (mode === 'survival') {
      const coop = !!(data && data.coop);
      const dailyModifierKey = isDailySurvival ? getDailyModifierKey() : undefined;
      if (coop) {
        // Daily Survival co-op (follow-up) lands in its OWN persistent room,
        // never the plain co-op one -- see SURVIVAL_COOP_DAILY_ROOM_ID's
        // comment for why the two can't share a physical room.
        const roomId = isDailySurvival ? RoomManager.SURVIVAL_COOP_DAILY_ROOM_ID : RoomManager.SURVIVAL_COOP_ROOM_ID;
        const game = isDailySurvival ? RoomManager.getSurvivalCoopDailyGame() : RoomManager.getSurvivalCoopGame();
        const player = game.addPlayer(socket.id, name, loadout, perks, null, skinId);
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.mode = 'survival';

        socket.emit('init', {
          selfId: socket.id,
          mode: 'survival',
          arenaHalfSize: ARENA_HALF_SIZE,
          obstacles: OBSTACLES,
          snapshot: game.snapshot(),
          stageStatus: game.getStageStatus(),
        });
        socket.to(roomId).emit('playerJoined', { id: player.id, name: player.name });
      } else {
        const difficultyKey = DIFFICULTIES[data && data.difficulty] ? data.difficulty : 'normal';
        const { roomId, game } = RoomManager.createSurvivalRoom(socket.id, difficultyKey, dailyModifierKey);
        game.addPlayer(socket.id, name, loadout, perks, null, skinId);
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.mode = 'survival';

        socket.emit('init', {
          selfId: socket.id,
          mode: 'survival',
          arenaHalfSize: ARENA_HALF_SIZE,
          obstacles: OBSTACLES,
          snapshot: game.snapshot(),
          stageStatus: game.getStageStatus(),
        });
      }
    } else {
      const game = RoomManager.getArenaGame();
      const player = game.addPlayer(socket.id, name, loadout, perks, null, skinId);
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

  // Quick ping (section 6.2) -- fire-and-forget, same as every other socket
  // event here; Game.requestPing is the sole authority on validity/cooldown.
  socket.on('ping', (kind) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const game = RoomManager.getRoom(roomId);
    if (game) game.requestPing(socket.id, kind, Date.now());
  });

  // Tank skins (section 4.1-4.2 follow-up) -- lets a player re-equip while
  // already inside a persistent room (Arena/Team/KOTH/co-op Survival), not
  // just at join time. Game.equipSkin is the sole validator (SKIN_IDS).
  socket.on('equipSkin', (skinId) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const game = RoomManager.getRoom(roomId);
    if (game) game.equipSkin(socket.id, skinId);
  });

  // Pre-stage confirmation (section: "Enemies must not attack before player
  // confirms") — the player's explicit "Confirm/Start Stage" click. Only
  // meaningful for campaign rooms; Game.startCombat() is itself idempotent
  // so a stray/duplicate emit (a malicious or buggy client re-sending it)
  // can't re-trigger the combat-start side effects a second time.
  // Pre-stage/pre-survival confirmation (section 7): shared by Campaign AND
  // solo Survival now. The co-op survival room's combatActive is already
  // forced true at module load (see RoomManager), so startCombat() there is
  // simply a harmless no-op (it's already active) rather than needing a
  // separate mode check here.
  socket.on('confirmStage', () => {
    const roomId = socket.data.roomId;
    if (!roomId || (socket.data.mode !== 'campaign' && socket.data.mode !== 'survival')) return;
    const game = RoomManager.getRoom(roomId);
    if (game) game.startCombat();
  });

  socket.on('leaveRoom', () => {
    cleanupSocketRoom(socket);
  });

  // A raw network drop -- unlike leaveRoom, this is never a deliberate
  // "I'm done" signal, so it never finalizes immediately. The player is
  // frozen in place (their last input is cleared so a disconnect mid-move/
  // mid-fire can't keep acting on stale input) and kept in the room for
  // RECONNECT_GRACE_MS in case the SAME session reconnects (see the 'join'
  // handler above). The world does not pause for them -- bots/other
  // players keep going, so a disconnect mid-fight can still end badly.
  socket.on('disconnect', () => {
    const { roomId, mode, sessionId } = socket.data;
    if (!roomId) return;

    const game = RoomManager.getRoom(roomId);
    const player = game && game.players.get(socket.id);
    if (player) {
      player.disconnectedAt = Date.now();
      player.input.moveForward = 0;
      player.input.moveRight = 0;
      player.input.firing = false;
    }
    socket.leave(roomId);

    if (!sessionId) {
      // No session id at all (an out-of-date client) -- can't offer a
      // reconnect window, so fall back to the old immediate-finalize
      // behavior exactly as before this feature existed.
      finalizeLeave(roomId, mode, socket.id);
      return;
    }

    const timeoutHandle = setTimeout(() => {
      RoomManager.takePendingDisconnect(sessionId);
      finalizeLeave(roomId, mode, socket.id);
    }, RECONNECT_GRACE_MS);
    RoomManager.setPendingDisconnect(sessionId, { roomId, mode, oldSocketId: socket.id, timeoutHandle });
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
