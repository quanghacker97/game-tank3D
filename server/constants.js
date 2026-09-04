'use strict';

// Shared game-balance / world constants used by the server (and echoed to
// clients via the 'init' event so rendering matches simulation).

const TICK_RATE = 20; // physics/network ticks per second
const TICK_MS = 1000 / TICK_RATE;

const ARENA_HALF_SIZE = 60; // world spans [-60, 60] on X and Z

// Tank meshes render at 0.4x their original modeled size (see
// createTankMesh's tankGroup.scale in client.js) — the hitbox shrinks with
// them so it still matches the visible silhouette.
const TANK_RADIUS = 0.92;

const RESPAWN_DELAY_MS = 3000;

const BULLET_RADIUS = 0.4;
const BULLET_SPEED = 70; // units/sec
const BULLET_LIFETIME_MS = 2200;

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

// ---------------------------------------------------------------------
// Equipment upgrades ("nâng cấp trang bị"). Each track has 6 levels
// (0 = base tank, 5 = fully upgraded). Levels are computed server-side
// from a client-supplied loadout so a tampered client can at worst claim
// stats equal to a legitimately maxed-out tank, never beyond it.
// ---------------------------------------------------------------------

const MAX_UPGRADE_LEVEL = 5;

// Turning (both turret and hull, which always face the same way — see
// Game.js) tracks the mouse directly and isn't gated by an upgrade; only
// move speed and the other three tracks are purchasable.
const UPGRADES = {
  power: [25, 29, 33, 37, 41, 45], // bullet damage
  defense: [100, 116, 132, 148, 164, 180], // max HP
  agilityMove: [14, 15.2, 16.4, 17.6, 18.8, 20], // move speed (units/sec)
  rate: [550, 510, 470, 430, 390, 350], // fire cooldown ms (lower = faster)
};

// Cost in coins to advance from level i to i+1 (index 0 = 0->1, ...).
const UPGRADE_COST = [50, 120, 220, 360, 550];

// ---------------------------------------------------------------------
// Campaign ("vượt ải"): solo player vs. AI-controlled tanks.
// ---------------------------------------------------------------------

// turnSpeed rate-limits how fast a bot's aim/hull can swing onto target —
// this alone (plus fireCooldown/moveSpeed/damage) is what makes a bot feel
// less than perfectly accurate, so there's no separate aim-error knob.
const BOT_TIERS = {
  easy: {
    maxHp: 80,
    damage: 16,
    moveSpeed: 9,
    turnSpeed: 1.6,
    fireCooldown: 950,
    engageRange: 42,
    color: 0xb0b0b0,
  },
  medium: {
    maxHp: 110,
    damage: 20,
    moveSpeed: 12,
    turnSpeed: 2.2,
    fireCooldown: 750,
    engageRange: 46,
    color: 0xcc6633,
  },
  hard: {
    maxHp: 150,
    damage: 26,
    moveSpeed: 14.5,
    turnSpeed: 3.0,
    fireCooldown: 580,
    engageRange: 50,
    color: 0x8b1a1a,
  },
};

const STAGES = [
  { id: 1, name: 'Ải 1', bots: ['easy'], reward: 60 },
  { id: 2, name: 'Ải 2', bots: ['easy', 'easy'], reward: 90 },
  { id: 3, name: 'Ải 3', bots: ['easy', 'medium'], reward: 130 },
  { id: 4, name: 'Ải 4', bots: ['medium', 'medium'], reward: 180 },
  { id: 5, name: 'Ải 5', bots: ['medium', 'medium', 'easy'], reward: 240 },
  { id: 6, name: 'Ải 6', bots: ['medium', 'medium', 'hard'], reward: 320 },
  { id: 7, name: 'Ải 7', bots: ['hard', 'hard', 'medium'], reward: 420 },
  { id: 8, name: 'Ải 8 (Trùm)', bots: ['hard', 'hard', 'hard'], reward: 600 },
];

module.exports = {
  TICK_RATE,
  TICK_MS,
  ARENA_HALF_SIZE,
  TANK_RADIUS,
  RESPAWN_DELAY_MS,
  BULLET_RADIUS,
  BULLET_SPEED,
  BULLET_LIFETIME_MS,
  OBSTACLES,
  SPAWN_POINTS,
  PLAYER_COLORS,
  MAX_UPGRADE_LEVEL,
  UPGRADES,
  UPGRADE_COST,
  BOT_TIERS,
  STAGES,
};
