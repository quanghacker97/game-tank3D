'use strict';

const { Game } = require('./Game');
const { STAGES } = require('./constants');

const ARENA_ROOM_ID = 'arena';

const rooms = new Map();
rooms.set(ARENA_ROOM_ID, new Game(ARENA_ROOM_ID, 'arena', null));

function getArenaGame() {
  return rooms.get(ARENA_ROOM_ID);
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function allRooms() {
  return rooms;
}

/** Creates a solo campaign room for the given stage number (1-based). Returns null if the stage is invalid. */
function createCampaignRoom(socketId, stageNumber) {
  const stageDef = STAGES[stageNumber - 1];
  if (!stageDef) return null;

  const roomId = `campaign-${socketId}`;
  const game = new Game(roomId, 'campaign', stageDef);
  for (const tier of stageDef.bots) game.addBot(tier);
  rooms.set(roomId, game);
  return { roomId, game };
}

/** Removes a non-arena room from the tick loop. No-op for the persistent arena room. */
function destroyRoom(roomId) {
  if (roomId === ARENA_ROOM_ID) return;
  rooms.delete(roomId);
}

module.exports = {
  ARENA_ROOM_ID,
  getArenaGame,
  getRoom,
  allRooms,
  createCampaignRoom,
  destroyRoom,
};
