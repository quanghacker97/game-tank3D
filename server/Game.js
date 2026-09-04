'use strict';

const {
  TICK_MS,
  ARENA_HALF_SIZE,
  TANK_RADIUS,
  RESPAWN_DELAY_MS,
  BULLET_RADIUS,
  BULLET_LIFETIME_MS,
  OBSTACLES,
  SPAWN_POINTS,
  PLAYER_COLORS,
  MAX_UPGRADE_LEVEL,
  UPGRADES,
  BOT_TIERS,
  WEAPON_TYPES,
  WEAPON_BUFF_DURATION_MS,
  PICKUP_TYPES,
  PICKUP_SPAWN_POINTS,
  PICKUP_RADIUS,
  MAX_ACTIVE_PICKUPS,
  PICKUP_SPAWN_INTERVAL_MS,
  PICKUP_MIN_SEPARATION,
  ARMOR_DAMAGE_REDUCTION,
  ARMOR_DURATION_MIN_MS,
  ARMOR_DURATION_MAX_MS,
  HEAL_AMOUNT,
  SPEED_BOOST_MULT,
  SPEED_BOOST_DURATION_MS,
  RAPID_FIRE_MULT,
  RAPID_FIRE_DURATION_MS,
  INVULN_DURATION_MS,
} = require('./constants');

let nextBulletId = 1;
let nextBotSeq = 1;
let nextPickupId = 1;

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

// Timed on/off buffs. Adding a new one only means: a row here, one branch
// in _collectPickup, and (if it changes movement/damage/fire math) one read
// of player.buffs.<key>.active at the point that math happens.
function freshBuffs() {
  return {
    armor: { active: false, expiresAt: 0 },
    speed: { active: false, expiresAt: 0 },
    rapidfire: { active: false, expiresAt: 0 },
    invuln: { active: false, expiresAt: 0 },
  };
}

function freshCombatState() {
  return {
    buffs: freshBuffs(),
    weapon: { type: 'normal', expiresAt: 0 },
  };
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
    this.pickups = new Map(); // id -> {id, kind, x, z}
    this.events = []; // transient events (hit/kill/join/leave/pickup) since last flush
    this._colorIndex = 0;
    this._lastPickupSpawnAt = Date.now();
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
      ...freshCombatState(),
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
      ...freshCombatState(),
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

  _fireWeapon(player, now) {
    const weaponType = player.weapon.type;
    const weaponDef = WEAPON_TYPES[weaponType] || WEAPON_TYPES.normal;
    const n = weaponDef.bulletsPerShot;
    const mid = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      const angleOffset = n > 1 ? (i - mid) * weaponDef.spreadAngle : 0;
      this._spawnBullet(player, weaponType, weaponDef, angleOffset, now);
    }
  }

  _spawnBullet(owner, weaponType, weaponDef, angleOffset, now) {
    const id = nextBulletId++;
    const muzzleDist = TANK_RADIUS + 0.48; // barrel tip, scaled with the tank's 0.4x model
    const angle = owner.turretRot + angleOffset;
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);
    this.bullets.set(id, {
      id,
      ownerId: owner.id,
      kind: weaponType,
      color: weaponDef.color,
      damage: owner.stats.damage * weaponDef.damageMult,
      splashRadius: weaponDef.splashRadius || 0,
      splashDamageMult: weaponDef.splashDamageMult || 0,
      x: owner.x + dirX * muzzleDist,
      z: owner.z + dirZ * muzzleDist,
      vx: dirX * weaponDef.bulletSpeed,
      vz: dirZ * weaponDef.bulletSpeed,
      bornAt: now,
    });
  }

  // Applies rawDamage (already weapon-scaled) to target, reduced by armor
  // (or entirely blocked by invuln), then handles death/kill bookkeeping.
  // Shared by direct hits and explosive splash so both go through identical
  // buff/death logic.
  _applyDamage(bullet, target, rawDamage, now) {
    if (target.buffs.invuln.active) {
      this.events.push({ type: 'hit', attackerId: bullet.ownerId, victimId: target.id, amount: 0, blocked: true });
      return;
    }
    const dmg = target.buffs.armor.active ? rawDamage * (1 - ARMOR_DAMAGE_REDUCTION) : rawDamage;
    target.hp -= dmg;
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
        amount: Math.round(dmg),
      });
    } else {
      this.events.push({
        type: 'hit',
        attackerId: bullet.ownerId,
        victimId: target.id,
        amount: Math.round(dmg),
      });
    }
  }

  _maintainPickups(now) {
    if (this.pickups.size >= MAX_ACTIVE_PICKUPS) return;
    if (now - this._lastPickupSpawnAt < PICKUP_SPAWN_INTERVAL_MS) return;

    const existing = Array.from(this.pickups.values());
    const candidates = PICKUP_SPAWN_POINTS.filter(
      (p) =>
        !existing.some((pk) => {
          const dx = pk.x - p.x;
          const dz = pk.z - p.z;
          return dx * dx + dz * dz < PICKUP_MIN_SEPARATION * PICKUP_MIN_SEPARATION;
        })
    );
    if (candidates.length === 0) return;

    const point = candidates[Math.floor(Math.random() * candidates.length)];
    const kinds = Object.keys(PICKUP_TYPES);
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const id = nextPickupId++;
    this.pickups.set(id, { id, kind, x: point.x, z: point.z });
    this._lastPickupSpawnAt = now;
  }

  _collectPickup(player, pickup, now) {
    const def = PICKUP_TYPES[pickup.kind];
    let healAmount = 0;

    if (def.kind === 'weapon') {
      player.weapon.type = def.weapon;
      player.weapon.expiresAt = now + WEAPON_BUFF_DURATION_MS;
    } else if (def.kind === 'heal') {
      const before = player.hp;
      player.hp = Math.min(player.stats.maxHp, player.hp + HEAL_AMOUNT);
      healAmount = Math.round(player.hp - before);
    } else if (def.kind === 'armor') {
      const duration = ARMOR_DURATION_MIN_MS + Math.random() * (ARMOR_DURATION_MAX_MS - ARMOR_DURATION_MIN_MS);
      player.buffs.armor.active = true;
      player.buffs.armor.expiresAt = now + duration;
    } else if (def.kind === 'speed') {
      player.buffs.speed.active = true;
      player.buffs.speed.expiresAt = now + SPEED_BOOST_DURATION_MS;
    } else if (def.kind === 'rapidfire') {
      player.buffs.rapidfire.active = true;
      player.buffs.rapidfire.expiresAt = now + RAPID_FIRE_DURATION_MS;
    } else if (def.kind === 'invuln') {
      player.buffs.invuln.active = true;
      player.buffs.invuln.expiresAt = now + INVULN_DURATION_MS;
    }

    this.events.push({
      type: 'pickup',
      playerId: player.id,
      playerName: player.name,
      itemKind: def.kind,
      itemLabel: def.label,
      healAmount,
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
          Object.assign(player, freshCombatState());
        } else if (!player.isBot && this.mode === 'campaign' && !this.finished) {
          this.finished = true;
          this.stageFailed = true;
          this.events.push({ type: 'stageFailed' });
        }
        continue;
      }

      for (const buff of Object.values(player.buffs)) {
        if (buff.active && now >= buff.expiresAt) buff.active = false;
      }
      if (player.weapon.type !== 'normal' && now >= player.weapon.expiresAt) player.weapon.type = 'normal';

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
        const speedMult = player.buffs.speed.active ? SPEED_BOOST_MULT : 1;
        const dx = (fx * moveForward + rx * moveRight) * player.stats.moveSpeed * speedMult * dt;
        const dz = (fz * moveForward + rz * moveRight) * player.stats.moveSpeed * speedMult * dt;

        const nx = clamp(player.x + dx, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
        if (!isBlockedByObstacle(nx, player.z, TANK_RADIUS)) player.x = nx;

        const nz = clamp(player.z + dz, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
        if (!isBlockedByObstacle(player.x, nz, TANK_RADIUS)) player.z = nz;
      }

      if (input.firing) {
        const weaponDef = WEAPON_TYPES[player.weapon.type] || WEAPON_TYPES.normal;
        const rapidMult = player.buffs.rapidfire.active ? RAPID_FIRE_MULT : 1;
        const cooldown = player.stats.fireCooldown * weaponDef.cooldownMult * rapidMult;
        if (now - player.lastFireTime >= cooldown) {
          player.lastFireTime = now;
          this._fireWeapon(player, now);
        }
      }
    }

    for (const bullet of this.bullets.values()) {
      bullet.x += bullet.vx * dt;
      bullet.z += bullet.vz * dt;

      let remove = false;
      let detonateAt = null; // set when a splash weapon should explode this tick

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
      if (remove && bullet.splashRadius > 0) detonateAt = { x: bullet.x, z: bullet.z };

      if (!remove) {
        for (const target of this.players.values()) {
          if (!target.alive || target.id === bullet.ownerId) continue;
          const dx = target.x - bullet.x;
          const dz = target.z - bullet.z;
          const distSq = dx * dx + dz * dz;
          const hitDist = TANK_RADIUS + BULLET_RADIUS;
          if (distSq <= hitDist * hitDist) {
            remove = true;
            if (bullet.splashRadius > 0) {
              detonateAt = { x: bullet.x, z: bullet.z };
            } else {
              this._applyDamage(bullet, target, bullet.damage, now);
            }
            break;
          }
        }
      }

      if (detonateAt) {
        // Splash never hits the owner (no self-damage), and isn't reduced
        // by distance within the radius — simple and predictable.
        for (const target of this.players.values()) {
          if (!target.alive || target.id === bullet.ownerId) continue;
          const dx = target.x - detonateAt.x;
          const dz = target.z - detonateAt.z;
          if (dx * dx + dz * dz <= bullet.splashRadius * bullet.splashRadius) {
            this._applyDamage(bullet, target, bullet.damage * bullet.splashDamageMult, now);
          }
        }
      }

      if (remove) this.bullets.delete(bullet.id);
    }

    this._maintainPickups(now);
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      for (const pickup of this.pickups.values()) {
        const dx = player.x - pickup.x;
        const dz = player.z - pickup.z;
        const hitDist = TANK_RADIUS + PICKUP_RADIUS;
        if (dx * dx + dz * dz <= hitDist * hitDist) {
          this._collectPickup(player, pickup, now);
          this.pickups.delete(pickup.id);
          break;
        }
      }
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
        armorActive: p.buffs.armor.active,
        armorExpiresAt: p.buffs.armor.expiresAt,
        speedActive: p.buffs.speed.active,
        speedExpiresAt: p.buffs.speed.expiresAt,
        rapidfireActive: p.buffs.rapidfire.active,
        rapidfireExpiresAt: p.buffs.rapidfire.expiresAt,
        invulnActive: p.buffs.invuln.active,
        invulnExpiresAt: p.buffs.invuln.expiresAt,
        weaponType: p.weapon.type,
        weaponExpiresAt: p.weapon.expiresAt,
      })),
      bullets: Array.from(this.bullets.values()).map((b) => ({
        id: b.id,
        x: b.x,
        z: b.z,
        vx: b.vx,
        vz: b.vz,
        ownerId: b.ownerId,
        kind: b.kind,
        color: b.color,
      })),
      pickups: Array.from(this.pickups.values()).map((pk) => ({
        id: pk.id,
        kind: pk.kind,
        x: pk.x,
        z: pk.z,
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
