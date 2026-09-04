'use strict';

const {
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
  BOT_TIERS,
} = require('./constants');

let nextBulletId = 1;
let nextBotSeq = 1;

function randomSpawn() {
  const p = SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
  // Face roughly toward the center of the arena.
  const rotY = Math.atan2(-p.x, -p.z);
  return { x: p.x, z: p.z, rotY };
}

function isBlockedByObstacle(x, z, pad) {
  for (const o of OBSTACLES) {
    if (
      x > o.x - o.w / 2 - pad &&
      x < o.x + o.w / 2 + pad &&
      z > o.z - o.d / 2 - pad &&
      z < o.z + o.d / 2 + pad
    ) {
      return true;
    }
  }
  return false;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Per-axis analog input (keyboard sends exactly -1/0/1, a touch joystick
// sends a continuous value) — clamp defensively, vector magnitude is
// clamped separately in tick() so a diagonal can't exceed full speed.
function clampAxis(v) {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, -1, 1) : 0;
}

function clampLevel(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return clamp(n, 0, MAX_UPGRADE_LEVEL);
}

// Wrapped angle difference b-a, result in (-PI, PI].
function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function statsFromLoadout(loadout) {
  const l = {
    power: clampLevel(loadout && loadout.power),
    defense: clampLevel(loadout && loadout.defense),
    agility: clampLevel(loadout && loadout.agility),
    rate: clampLevel(loadout && loadout.rate),
  };
  return {
    damage: UPGRADES.power[l.power],
    maxHp: UPGRADES.defense[l.defense],
    moveSpeed: UPGRADES.agilityMove[l.agility],
    fireCooldown: UPGRADES.rate[l.rate],
    levels: l,
  };
}

function statsFromBotTier(tierName) {
  const tier = BOT_TIERS[tierName] || BOT_TIERS.easy;
  return {
    damage: tier.damage,
    maxHp: tier.maxHp,
    moveSpeed: tier.moveSpeed,
    turnSpeed: tier.turnSpeed,
    fireCooldown: tier.fireCooldown,
    engageRange: tier.engageRange,
  };
}

function sanitizeName(name) {
  const trimmed = String(name || '').trim().slice(0, 16);
  return trimmed.replace(/[<>]/g, '') || 'Tank';
}

class Game {
  /**
   * @param {string} roomId
   * @param {'arena'|'campaign'} mode
   * @param {object|null} stageDef  Required when mode === 'campaign'.
   */
  constructor(roomId, mode, stageDef) {
    this.roomId = roomId;
    this.mode = mode;
    this.stageDef = stageDef || null;
    this.players = new Map(); // id -> player state (humans + bots)
    this.bullets = new Map(); // id -> bullet state
    this.events = []; // transient events (hit/kill/join/leave) since last flush
    this._colorIndex = 0;
    this.finished = false;
    this.stageCleared = false;
    this.stageFailed = false;
  }

  addPlayer(id, name, loadout) {
    const spawn = randomSpawn();
    const color = PLAYER_COLORS[this._colorIndex % PLAYER_COLORS.length];
    this._colorIndex++;
    const stats = statsFromLoadout(loadout);

    const player = {
      id,
      name: sanitizeName(name),
      isBot: false,
      x: spawn.x,
      z: spawn.z,
      bodyRot: spawn.rotY,
      turretRot: spawn.rotY,
      hp: stats.maxHp,
      alive: true,
      kills: 0,
      deaths: 0,
      color,
      stats,
      lastFireTime: 0,
      deathTime: 0,
      input: { moveForward: 0, moveRight: 0, turretRot: spawn.rotY, firing: false },
    };
    this.players.set(id, player);
    this.events.push({ type: 'join', id, name: player.name });
    return player;
  }

  addBot(tierName) {
    const id = `bot-${this.roomId}-${nextBotSeq++}`;
    const spawn = randomSpawn();
    const stats = statsFromBotTier(tierName);
    const tier = BOT_TIERS[tierName] || BOT_TIERS.easy;

    const bot = {
      id,
      name: `Địch (${tierLabel(tierName)})`,
      isBot: true,
      tierName,
      x: spawn.x,
      z: spawn.z,
      bodyRot: spawn.rotY,
      turretRot: spawn.rotY,
      hp: stats.maxHp,
      alive: true,
      kills: 0,
      deaths: 0,
      color: tier.color,
      stats,
      lastFireTime: 0,
      deathTime: 0,
      input: { moveForward: 0, moveRight: 0, turretRot: spawn.rotY, firing: false },
      ai: { lastX: spawn.x, lastZ: spawn.z, stuckTicks: 0, avoidUntil: 0, avoidSign: 1 },
    };
    this.players.set(id, bot);
    return bot;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    this.events.push({ type: 'leave', id, name: player.name });
  }

  setInput(id, input) {
    const player = this.players.get(id);
    if (!player || player.isBot || !input) return;
    player.input.moveForward = clampAxis(input.moveForward);
    player.input.moveRight = clampAxis(input.moveRight);
    player.input.firing = !!input.firing;
    if (typeof input.turretRot === 'number' && Number.isFinite(input.turretRot)) {
      player.input.turretRot = input.turretRot;
    }
  }

  _primaryHuman() {
    for (const p of this.players.values()) {
      if (!p.isBot) return p;
    }
    return null;
  }

  // Bots share the same "hull always faces where it's aiming" model as
  // players (see tick()), but unlike a mouse-driven human they can't snap
  // instantly — their aim/facing turns at a capped rate (bot.stats.turnSpeed),
  // which alone is what makes them feel less than perfectly accurate.
  _updateBotAI(bot, now, dt) {
    const target = this._primaryHuman();
    if (!target || !target.alive) {
      bot.input.moveForward = 0;
      bot.input.moveRight = 0;
      bot.input.firing = false;
      return;
    }

    const dx = target.x - bot.x;
    const dz = target.z - bot.z;
    const dist = Math.hypot(dx, dz);
    const desiredAngle = Math.atan2(dx, dz);

    // Simple stuck detection -> temporary steer offset to route around cover.
    const moved = Math.hypot(bot.x - bot.ai.lastX, bot.z - bot.ai.lastZ);
    if (bot.input.moveForward > 0 && moved < 0.05) bot.ai.stuckTicks++;
    else bot.ai.stuckTicks = 0;
    bot.ai.lastX = bot.x;
    bot.ai.lastZ = bot.z;
    if (bot.ai.stuckTicks > 6 && now > bot.ai.avoidUntil) {
      bot.ai.avoidSign = Math.random() < 0.5 ? -1 : 1;
      bot.ai.avoidUntil = now + 1200;
      bot.ai.stuckTicks = 0;
    }
    const steerAngle = now < bot.ai.avoidUntil ? desiredAngle + bot.ai.avoidSign * 1.4 : desiredAngle;

    const maxStep = bot.stats.turnSpeed * dt;
    const step = clamp(angleDiff(bot.turretRot, steerAngle), -maxStep, maxStep);
    bot.input.turretRot = bot.turretRot + step;

    const tooClose = dist < 10;
    const tooFar = dist > bot.stats.engageRange * 0.7;
    bot.input.moveForward = tooFar ? 1 : tooClose ? -1 : 0;
    bot.input.moveRight = 0;

    const aligned = Math.abs(angleDiff(bot.input.turretRot, desiredAngle)) < 0.12;
    bot.input.firing = dist <= bot.stats.engageRange && aligned;
  }

  _spawnBullet(owner) {
    const id = nextBulletId++;
    const muzzleDist = TANK_RADIUS + 0.48; // barrel tip, scaled with the tank's 0.4x model
    const dirX = Math.sin(owner.turretRot);
    const dirZ = Math.cos(owner.turretRot);
    this.bullets.set(id, {
      id,
      ownerId: owner.id,
      damage: owner.stats.damage,
      x: owner.x + dirX * muzzleDist,
      z: owner.z + dirZ * muzzleDist,
      vx: dirX * BULLET_SPEED,
      vz: dirZ * BULLET_SPEED,
      bornAt: Date.now(),
    });
  }

  tick() {
    if (this.finished) return;

    const dt = TICK_MS / 1000;
    const now = Date.now();

    for (const player of this.players.values()) {
      if (player.isBot && player.alive) this._updateBotAI(player, now, dt);

      if (!player.alive) {
        if (!player.isBot && this.mode === 'arena' && now - player.deathTime >= RESPAWN_DELAY_MS) {
          const spawn = randomSpawn();
          player.x = spawn.x;
          player.z = spawn.z;
          player.bodyRot = spawn.rotY;
          player.turretRot = spawn.rotY;
          player.hp = player.stats.maxHp;
          player.alive = true;
        } else if (!player.isBot && this.mode === 'campaign' && !this.finished) {
          this.finished = true;
          this.stageFailed = true;
          this.events.push({ type: 'stageFailed' });
        }
        continue;
      }

      const { input } = player;

      // Hull always faces the same way the turret aims (mouse-driven for
      // humans, rate-limited by _updateBotAI for bots) — movement below is
      // relative to this single facing direction, so the gun always points
      // the way you're actually driving.
      player.bodyRot = input.turretRot;
      player.turretRot = input.turretRot;

      let moveForward = input.moveForward;
      let moveRight = input.moveRight;
      const moveLen = Math.hypot(moveForward, moveRight);
      if (moveLen > 1) {
        moveForward /= moveLen;
        moveRight /= moveLen;
      }

      if (moveForward !== 0 || moveRight !== 0) {
        const fx = Math.sin(player.bodyRot);
        const fz = Math.cos(player.bodyRot);
        // -PI/2 (not +PI/2): with forward = (sin, cos), rotating by -90° is
        // the direction that actually reads as screen-right for our chase
        // camera (verified empirically — the other sign strafed backwards).
        const rx = Math.sin(player.bodyRot - Math.PI / 2);
        const rz = Math.cos(player.bodyRot - Math.PI / 2);
        const dx = (fx * moveForward + rx * moveRight) * player.stats.moveSpeed * dt;
        const dz = (fz * moveForward + rz * moveRight) * player.stats.moveSpeed * dt;

        const nx = clamp(player.x + dx, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
        if (!isBlockedByObstacle(nx, player.z, TANK_RADIUS)) player.x = nx;

        const nz = clamp(player.z + dz, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
        if (!isBlockedByObstacle(player.x, nz, TANK_RADIUS)) player.z = nz;
      }

      if (input.firing && now - player.lastFireTime >= player.stats.fireCooldown) {
        player.lastFireTime = now;
        this._spawnBullet(player);
      }
    }

    for (const bullet of this.bullets.values()) {
      bullet.x += bullet.vx * dt;
      bullet.z += bullet.vz * dt;

      let remove = false;

      if (now - bullet.bornAt >= BULLET_LIFETIME_MS) remove = true;
      if (
        !remove &&
        (Math.abs(bullet.x) > ARENA_HALF_SIZE || Math.abs(bullet.z) > ARENA_HALF_SIZE)
      ) {
        remove = true;
      }
      if (!remove && isBlockedByObstacle(bullet.x, bullet.z, BULLET_RADIUS)) {
        remove = true;
      }

      if (!remove) {
        for (const target of this.players.values()) {
          if (!target.alive || target.id === bullet.ownerId) continue;
          const dx = target.x - bullet.x;
          const dz = target.z - bullet.z;
          const distSq = dx * dx + dz * dz;
          const hitDist = TANK_RADIUS + BULLET_RADIUS;
          if (distSq <= hitDist * hitDist) {
            target.hp -= bullet.damage;
            remove = true;
            if (target.hp <= 0) {
              target.hp = 0;
              target.alive = false;
              target.deathTime = now;
              target.deaths++;
              const killer = this.players.get(bullet.ownerId);
              if (killer) killer.kills++;
              this.events.push({
                type: 'kill',
                killerId: bullet.ownerId,
                killerName: killer ? killer.name : 'Unknown',
                victimId: target.id,
                victimName: target.name,
              });
            } else {
              this.events.push({
                type: 'hit',
                attackerId: bullet.ownerId,
                victimId: target.id,
              });
            }
            break;
          }
        }
      }

      if (remove) this.bullets.delete(bullet.id);
    }

    if (this.mode === 'campaign' && !this.finished) {
      const botsAlive = Array.from(this.players.values()).some((p) => p.isBot && p.alive);
      if (!botsAlive) {
        this.finished = true;
        this.stageCleared = true;
        this.events.push({ type: 'stageClear', reward: this.stageDef.reward });
      }
    }
  }

  getStageStatus() {
    if (this.mode !== 'campaign') return null;
    const enemiesRemaining = Array.from(this.players.values()).filter((p) => p.isBot && p.alive).length;
    return {
      stageId: this.stageDef.id,
      stageName: this.stageDef.name,
      enemiesRemaining,
      finished: this.finished,
      cleared: this.stageCleared,
      failed: this.stageFailed,
      reward: this.stageCleared ? this.stageDef.reward : 0,
    };
  }

  snapshot() {
    return {
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        x: p.x,
        z: p.z,
        bodyRot: p.bodyRot,
        turretRot: p.turretRot,
        hp: p.hp,
        maxHp: p.stats.maxHp,
        alive: p.alive,
        kills: p.kills,
        deaths: p.deaths,
        color: p.color,
      })),
      bullets: Array.from(this.bullets.values()).map((b) => ({
        id: b.id,
        x: b.x,
        z: b.z,
        ownerId: b.ownerId,
      })),
    };
  }

  flushEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }
}

function tierLabel(tierName) {
  if (tierName === 'easy') return 'Dễ';
  if (tierName === 'medium') return 'Vừa';
  if (tierName === 'hard') return 'Khó';
  return tierName;
}

module.exports = { Game };
