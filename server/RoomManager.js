'use strict';

const { Game } = require('./Game');
const { STAGES, DAILY_MODIFIERS, getDailyModifierKey } = require('./constants');

const ARENA_ROOM_ID = 'arena';
const TEAM_ROOM_ID = 'team';
const KOTH_ROOM_ID = 'koth';
const SURVIVAL_COOP_ROOM_ID = 'survival-coop';
// Daily Survival integration (follow-up): a SEPARATE persistent co-op room
// from the plain one above -- the actual daily modifier changes enemy
// stats for the WHOLE shared simulated world, so it would be unfair to mix
// daily-flavored and plain co-op players in the same physical room. Anyone
// who picks "Sinh Tồn Cùng Người Khác (Hàng Ngày)" lands here instead.
const SURVIVAL_COOP_DAILY_ROOM_ID = 'survival-coop-daily';

const rooms = new Map();
rooms.set(ARENA_ROOM_ID, new Game(ARENA_ROOM_ID, 'arena', null));
// Team Deathmatch: one persistent shared room, same lifecycle as the arena
// room (never destroyed, everyone who picks 'team' joins this single game).
rooms.set(TEAM_ROOM_ID, new Game(TEAM_ROOM_ID, 'team', null));
// King of the Hill (section 5.1-5.3): a separate persistent room from plain
// Team Deathmatch -- same team-vs-team combat, different (objective-score)
// win condition, so the two don't fight over the same scoreboard/room.
rooms.set(KOTH_ROOM_ID, new Game(KOTH_ROOM_ID, 'koth', null));
// Endless/Survival co-op: same "one eternal shared room" lifecycle as arena/
// team. Always runs at a fixed 'normal' difficulty since — unlike a solo
// run — there's no single player whose profile setting could apply.
rooms.set(SURVIVAL_COOP_ROOM_ID, new Game(SURVIVAL_COOP_ROOM_ID, 'survival', null, 'normal'));
rooms.get(SURVIVAL_COOP_ROOM_ID).survivalCoop = true;
// Pre-survival confirmation (section 7) makes sense for a fresh SOLO room
// (this player's own instance, nothing has started yet) but not for this
// eternal shared room -- there is no single "the run begins now" moment to
// confirm against once other players may already be mid-fight, so it
// starts active immediately, same as Arena/Team/KOTH.
rooms.get(SURVIVAL_COOP_ROOM_ID).combatActive = true;
console.log(`[Survival] Room ${SURVIVAL_COOP_ROOM_ID} (co-op) loaded | State = COMBAT (always active)`);

rooms.set(SURVIVAL_COOP_DAILY_ROOM_ID, new Game(SURVIVAL_COOP_DAILY_ROOM_ID, 'survival', null, 'normal'));
rooms.get(SURVIVAL_COOP_DAILY_ROOM_ID).survivalCoop = true;
rooms.get(SURVIVAL_COOP_DAILY_ROOM_ID).combatActive = true;
// dailyModifier itself is refreshed on each join (see index.js) rather than
// here at module load, since this room -- unlike a fresh solo room -- never
// gets recreated, so a value baked in once here would go stale the moment
// the calendar day rolls over.
console.log(`[Survival] Room ${SURVIVAL_COOP_DAILY_ROOM_ID} (co-op, daily) loaded | State = COMBAT (always active)`);

function getArenaGame() {
  return rooms.get(ARENA_ROOM_ID);
}

function getTeamGame() {
  return rooms.get(TEAM_ROOM_ID);
}

function getKothGame() {
  return rooms.get(KOTH_ROOM_ID);
}

function getSurvivalCoopGame() {
  return rooms.get(SURVIVAL_COOP_ROOM_ID);
}

/** Same idea as getSurvivalCoopGame(), but also refreshes dailyModifier to
 * match TODAY before handing the room back -- called on every join to this
 * room (see index.js), since the room itself is never recreated. */
function getSurvivalCoopDailyGame() {
  const game = rooms.get(SURVIVAL_COOP_DAILY_ROOM_ID);
  if (game) game.dailyModifier = DAILY_MODIFIERS[getDailyModifierKey()] || null;
  return game;
}

/** Creates a solo Endless/Survival room for one player — same per-socket
 * lifecycle as createCampaignRoom, but with no stage lookup (survival has
 * no fixed stageDef, its waves are generated procedurally, see Game.js's
 * _spawnSurvivalWave). */
function createSurvivalRoom(socketId, difficultyKey, dailyModifierKey) {
  const roomId = `survival-${socketId}`;
  const game = new Game(roomId, 'survival', null, difficultyKey);
  game.survivalCoop = false;
  if (dailyModifierKey && DAILY_MODIFIERS[dailyModifierKey]) game.dailyModifier = DAILY_MODIFIERS[dailyModifierKey];
  console.log(`[Survival] Room ${roomId} (solo${dailyModifierKey ? ', daily' : ''}) loaded | State = WAITING_FOR_CONFIRMATION`);
  rooms.set(roomId, game);
  return { roomId, game };
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function allRooms() {
  return rooms;
}

// ---------------------------------------------------------------------
// Reconnect (section 3.1-3.3): keyed by the client's own self-generated
// `sessionId` (opaque, never authenticated — good enough to survive a
// brief network drop, not a real account system). index.js owns the
// actual grace-period setTimeout (it needs `io` to emit events once the
// grace expires); this registry just holds the room/mode/old-socket-id a
// session can resume into while that timer is pending.
// ---------------------------------------------------------------------
const pendingDisconnects = new Map(); // sessionId -> { roomId, mode, oldSocketId, timeoutHandle }

function setPendingDisconnect(sessionId, info) {
  pendingDisconnects.set(sessionId, info);
}

function peekPendingDisconnect(sessionId) {
  return pendingDisconnects.get(sessionId) || null;
}

/** Consumes (removes) a pending-disconnect entry and cancels its grace timer — call this the moment a reconnect is actually accepted, or once the grace period has genuinely expired. */
function takePendingDisconnect(sessionId) {
  const entry = pendingDisconnects.get(sessionId) || null;
  if (entry) {
    clearTimeout(entry.timeoutHandle);
    pendingDisconnects.delete(sessionId);
  }
  return entry;
}

/** Creates a solo campaign room for the given stage number (1-based). Returns null if the stage is invalid.
 * Enemy waves are NOT spawned here — Game.js's own wave scheduler (see
 * _updateWaves, called every tick) spawns wave 1 on the room's first tick
 * and every subsequent wave/boss progressively (section 23), rather than
 * everything existing the instant the room is created. */
/** `dailyModifierKey` is optional — only the Daily Challenge join path
 * (section 2.6) ever passes one; a normal campaign stage join leaves it
 * undefined and this.dailyModifier stays null (see Game.js constructor). */
function createCampaignRoom(socketId, stageNumber, difficultyKey, dailyModifierKey) {
  const stageDef = STAGES[stageNumber - 1];
  if (!stageDef) return null;

  const roomId = `campaign-${socketId}`;
  const game = new Game(roomId, 'campaign', stageDef, difficultyKey);
  if (dailyModifierKey && DAILY_MODIFIERS[dailyModifierKey]) game.dailyModifier = DAILY_MODIFIERS[dailyModifierKey];
  rooms.set(roomId, game);
  return { roomId, game };
}

/** Removes a non-persistent room from the tick loop. No-op for the persistent arena/team rooms. */
function destroyRoom(roomId) {
  if (
    roomId === ARENA_ROOM_ID ||
    roomId === TEAM_ROOM_ID ||
    roomId === KOTH_ROOM_ID ||
    roomId === SURVIVAL_COOP_ROOM_ID ||
    roomId === SURVIVAL_COOP_DAILY_ROOM_ID
  )
    return;
  rooms.delete(roomId);
}

module.exports = {
  ARENA_ROOM_ID,
  TEAM_ROOM_ID,
  KOTH_ROOM_ID,
  SURVIVAL_COOP_ROOM_ID,
  SURVIVAL_COOP_DAILY_ROOM_ID,
  getArenaGame,
  getTeamGame,
  getKothGame,
  getSurvivalCoopGame,
  getSurvivalCoopDailyGame,
  getRoom,
  allRooms,
  createCampaignRoom,
  createSurvivalRoom,
  destroyRoom,
  setPendingDisconnect,
  peekPendingDisconnect,
  takePendingDisconnect,
};
