'use strict';

// Shared game-balance / world constants used by the server (and echoed to
// clients via the 'init' event so rendering matches simulation).

const TICK_RATE = 20; // physics/network ticks per second
const TICK_MS = 1000 / TICK_RATE;

const ARENA_HALF_SIZE = 60; // world spans [-60, 60] on X and Z

const TANK_RADIUS = 2.3;
const MOVE_SPEED = 14; // units/sec
const TURN_SPEED = 2.4; // radians/sec

const TANK_MAX_HP = 100;
const RESPAWN_DELAY_MS = 3000;

const BULLET_RADIUS = 0.4;
const BULLET_SPEED = 70; // units/sec
const BULLET_LIFETIME_MS = 2200;
const BULLET_DAMAGE = 25;
const FIRE_COOLDOWN_MS = 550;

// Static cover boxes. Shared with the client for rendering and used
// server-side for tank/bullet collision.
const OBSTACLES = [
  { x: -20, z: -20, w: 8, d: 8, h: 4 },
  { x: 20, z: -20, w: 8, d: 8, h: 4 },
  { x: -20, z: 20, w: 8, d: 8, h: 4 },
  { x: 20, z: 20, w: 8, d: 8, h: 4 },
  { x: 0, z: 0, w: 10, d: 4, h: 5 },
  { x: -38, z: 0, w: 4, d: 18, h: 4 },
  { x: 38, z: 0, w: 4, d: 18, h: 4 },
  { x: 0, z: -42, w: 18, d: 4, h: 4 },
  { x: 0, z: 42, w: 18, d: 4, h: 4 },
];

const SPAWN_POINTS = [
  { x: -50, z: -50 },
  { x: 50, z: -50 },
  { x: -50, z: 50 },
  { x: 50, z: 50 },
  { x: 0, z: -52 },
  { x: 0, z: 52 },
  { x: -52, z: 0 },
  { x: 52, z: 0 },
];

const PLAYER_COLORS = [
  0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f,
  0x9b59b6, 0x1abc9c, 0xe67e22, 0xecf0f1,
];

module.exports = {
  TICK_RATE,
  TICK_MS,
  ARENA_HALF_SIZE,
  TANK_RADIUS,
  MOVE_SPEED,
  TURN_SPEED,
  TANK_MAX_HP,
  RESPAWN_DELAY_MS,
  BULLET_RADIUS,
  BULLET_SPEED,
  BULLET_LIFETIME_MS,
  BULLET_DAMAGE,
  FIRE_COOLDOWN_MS,
  OBSTACLES,
  SPAWN_POINTS,
  PLAYER_COLORS,
};
