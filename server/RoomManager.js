'use strict';

const { Game } = require('./Game');
const { STAGES } = require('./constants');

const ARENA_ROOM_ID = 'arena';
const TEAM_ROOM_ID = 'team';

const rooms = new Map();
rooms.set(ARENA_ROOM_ID, new Game(ARENA_ROOM_ID, 'arena', null));
// Team Deathmatch: one persistent shared room, same lifecycle as the arena
// room (never destroyed, everyone who picks 'team' joins this single game).
rooms.set(TEAM_ROOM_ID, new Game(TEAM_ROOM_ID, 'team', null));

function getArenaGame() {
  return rooms.get(ARENA_ROOM_ID);
}

function getTeamGame() {
  return rooms.get(TEAM_ROOM_ID);
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function allRooms() {
  return rooms;
}

/** Creates a solo campaign room for the given stage number (1-based). Returns null if the stage is invalid.
 * Enemy waves are NOT spawned here — Game.js's own wave scheduler (see
 * _updateWaves, called every tick) spawns wave 1 on the room's first tick
 * and every subsequent wave/boss progressively (section 23), rather than
 * everything existing the instant the room is created. */
function createCampaignRoom(socketId, stageNumber, difficultyKey) {
  const stageDef = STAGES[stageNumber - 1];
  if (!stageDef) return null;

  const roomId = `campaign-${socketId}`;
  const game = new Game(roomId, 'campaign', stageDef, difficultyKey);
  rooms.set(roomId, game);
  return { roomId, game };
}

/** Removes a non-persistent room from the tick loop. No-op for the persistent arena/team rooms. */
function destroyRoom(roomId) {
  if (roomId === ARENA_ROOM_ID || roomId === TEAM_ROOM_ID) return;
  rooms.delete(roomId);
}

module.exports = {
  ARENA_ROOM_ID,
  TEAM_ROOM_ID,
  getArenaGame,
  getTeamGame,
  getRoom,
  allRooms,
  createCampaignRoom,
  destroyRoom,
};
