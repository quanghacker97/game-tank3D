'use strict';

const {
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
} = require('./constants');

let nextBulletId = 1;

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

class Game {
  constructor() {
    this.players = new Map(); // id -> player state
    this.bullets = new Map(); // id -> bullet state
    this.events = []; // transient events (hit/kill/join/leave) since last flush
    this._colorIndex = 0;
  }

  addPlayer(id, name) {
    const spawn = randomSpawn();
    const color = PLAYER_COLORS[this._colorIndex % PLAYER_COLORS.length];
    this._colorIndex++;

    const player = {
      id,
      name: sanitizeName(name),
      x: spawn.x,
      z: spawn.z,
      bodyRot: spawn.rotY,
      turretRot: spawn.rotY,
      hp: TANK_MAX_HP,
      alive: true,
      kills: 0,
      deaths: 0,
      color,
      lastFireTime: 0,
      deathTime: 0,
      input: { forward: false, back: false, left: false, right: false, turretRot: spawn.rotY, firing: false },
    };
    this.players.set(id, player);
    this.events.push({ type: 'join', id, name: player.name });
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    this.events.push({ type: 'leave', id, name: player.name });
  }

  setInput(id, input) {
    const player = this.players.get(id);
    if (!player || !input) return;
    player.input.forward = !!input.forward;
    player.input.back = !!input.back;
    player.input.left = !!input.left;
    player.input.right = !!input.right;
    player.input.firing = !!input.firing;
    if (typeof input.turretRot === 'number' && Number.isFinite(input.turretRot)) {
      player.input.turretRot = input.turretRot;
    }
  }

  _spawnBullet(owner) {
    const id = nextBulletId++;
    const muzzleDist = TANK_RADIUS + 1.2;
    const dirX = Math.sin(owner.turretRot);
    const dirZ = Math.cos(owner.turretRot);
    this.bullets.set(id, {
      id,
      ownerId: owner.id,
      x: owner.x + dirX * muzzleDist,
      z: owner.z + dirZ * muzzleDist,
      vx: dirX * BULLET_SPEED,
      vz: dirZ * BULLET_SPEED,
      bornAt: Date.now(),
    });
  }

  tick() {
    const dt = TICK_MS / 1000;
    const now = Date.now();

    for (const player of this.players.values()) {
      if (!player.alive) {
        if (now - player.deathTime >= RESPAWN_DELAY_MS) {
          const spawn = randomSpawn();
          player.x = spawn.x;
          player.z = spawn.z;
          player.bodyRot = spawn.rotY;
          player.turretRot = spawn.rotY;
          player.hp = TANK_MAX_HP;
          player.alive = true;
        }
        continue;
      }

      const { input } = player;

      if (input.left) player.bodyRot -= TURN_SPEED * dt;
      if (input.right) player.bodyRot += TURN_SPEED * dt;

      let moveDir = 0;
      if (input.forward) moveDir += 1;
      if (input.back) moveDir -= 1;

      if (moveDir !== 0) {
        const dx = Math.sin(player.bodyRot) * moveDir * MOVE_SPEED * dt;
        const dz = Math.cos(player.bodyRot) * moveDir * MOVE_SPEED * dt;

        const nx = clamp(player.x + dx, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
        if (!isBlockedByObstacle(nx, player.z, TANK_RADIUS)) player.x = nx;

        const nz = clamp(player.z + dz, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
        if (!isBlockedByObstacle(player.x, nz, TANK_RADIUS)) player.z = nz;
      }

      player.turretRot = input.turretRot;

      if (input.firing && now - player.lastFireTime >= FIRE_COOLDOWN_MS) {
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
            target.hp -= BULLET_DAMAGE;
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
  }

  snapshot() {
    return {
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        x: p.x,
        z: p.z,
        bodyRot: p.bodyRot,
        turretRot: p.turretRot,
        hp: p.hp,
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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sanitizeName(name) {
  const trimmed = String(name || '').trim().slice(0, 16);
  return trimmed.replace(/[<>]/g, '') || 'Tank';
}

module.exports = { Game };
