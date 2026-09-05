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
  SPLASH_FALLOFF_MIN,
  SUPPORT_TYPES,
  PICKUP_TYPES,
  PICKUP_RARITY_WEIGHT,
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

// ---- Swept bullet collision -----------------------------------------
// Bullets move fast enough per tick (e.g. the sniper weapon covers ~13
// units in one 50ms tick, versus a ~1.3-unit tank hit radius) that testing
// only the bullet's post-move endpoint lets it "jump over" a target
// without ever landing inside its hit circle — classic tunneling. Both
// helpers below instead solve for the point where the bullet's FULL
// per-tick travel segment (prevPos -> newPos) first touches a shape, so a
// hit is registered even when the bullet crosses the whole target between
// two ticks.

// Ray/segment-vs-circle: returns the smallest t in [0,1] along the segment
// (px,pz)+t*(dx,dz) at which it first enters the circle (cx,cz,r), or null
// if it never does within this movement step. Standard quadratic solve;
// t1<0<=t2 means the segment *starts* already inside the circle (e.g. a
// bullet spawned at point-blank range), which is reported as an immediate
// hit at t=0 rather than being missed.
function sweepCircleHit(px, pz, dx, dz, cx, cz, r) {
  const fx = px - cx;
  const fz = pz - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return fx * fx + fz * fz <= r * r ? 0 : null;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b - sqrtDisc) / (2 * a);
  const t2 = (-b + sqrtDisc) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t1 < 0 && t2 >= 0) return 0;
  return null;
}

// Liang-Barsky segment/AABB clip (same technique as the client's
// line-of-sight check) — returns { t, nx, nz } (entry parameter in [0,1]
// plus the outward surface normal of the face it entered through), or null
// if the segment never touches the box. The normal is only needed by the
// ricochet ammo type (to reflect velocity); every other caller just reads
// `.t`, exactly like the plain boolean/number this used to return.
function sweepAabbHit(px, pz, dx, dz, minX, minZ, maxX, maxZ) {
  let t0 = 0;
  let t1 = 1;
  let nx0 = 0;
  let nz0 = 0;
  function clip(p, q, axisNx, axisNz) {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) {
        t0 = r;
        nx0 = axisNx;
        nz0 = axisNz;
      }
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  }
  if (!clip(-dx, px - minX, -1, 0)) return null;
  if (!clip(dx, maxX - px, 1, 0)) return null;
  if (!clip(-dz, pz - minZ, 0, -1)) return null;
  if (!clip(dz, maxZ - pz, 0, 1)) return null;
  if (t0 >= t1) return null;
  return { t: t0, nx: nx0, nz: nz0 };
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

// Lightweight status-effect system for the shock/cryo ammo types (section
// 4/7 of the ammo spec) — a generic slot the movement/fire code reads
// (speedMult *= slow.mult, "can't fire while shocked"), instead of each
// ammo type hardcoding its own bespoke effect deep inside the projectile
// resolution code. `slow` is shared by both shock (flat, always overwrites)
// and cryo (stacking, only accumulates against its own prior stacks — see
// _resolveBulletHit) — `source` disambiguates which one currently owns it.
function freshDebuffs() {
  return {
    slow: { active: false, expiresAt: 0, mult: 1, stacks: 0, source: null },
    shocked: { active: false, expiresAt: 0 }, // weapon disabled (EMP)
  };
}

function freshCombatState() {
  return {
    buffs: freshBuffs(),
    debuffs: freshDebuffs(),
    weapon: { type: 'normal', expiresAt: 0 },
    support: null, // active temporary auto-firing support weapon, if any — see _updateSupportWeapons
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
      input: { moveForward: 0, moveRight: 0, turretRot: spawn.rotY, firing: false, lockedTargetId: null },
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
      input: { moveForward: 0, moveRight: 0, turretRot: spawn.rotY, firing: false, lockedTargetId: null },
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
    // Client-side-only target lock (see public/client.js) is purely an aim
    // convenience there; the id is echoed here ONLY so automatic support
    // weapons can prefer it as a targeting hint (section 19) — it never
    // otherwise touches server aim/movement/damage.
    player.input.lockedTargetId = input.lockedTargetId != null ? String(input.lockedTargetId) : null;
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
      // Per-kind ammo behavior — all zero/no-op unless weaponDef sets them,
      // so "normal" and every pre-existing weapon type behaves exactly as
      // before. See the tick() bullet-resolution loop for how each is used.
      // pierceCount is the TOTAL number of enemies this bullet can hit
      // before disappearing; the first hit is "free", so only
      // (pierceCount - 1) further hits need to be tracked/decremented here.
      pierceRemaining: weaponDef.pierceCount ? weaponDef.pierceCount - 1 : 0,
      pierceDamageFalloff: weaponDef.pierceDamageFalloff || 1,
      hitIds: weaponDef.pierceCount ? new Set() : null,
      bounceRemaining: weaponDef.bounceCount || 0,
      bounceDamageMult: weaponDef.bounceDamageMult || 1,
      bounceSpeedMult: weaponDef.bounceSpeedMult || 1,
      shockRadius: weaponDef.shockRadius || 0,
      shockSlowMult: weaponDef.shockSlowMult || 1,
      shockDurationMs: weaponDef.shockDurationMs || 0,
      shockDisableFireMs: weaponDef.shockDisableFireMs || 0,
      cryoSlowPerStack: weaponDef.cryoSlowPerStack || 0,
      cryoMaxStacks: weaponDef.cryoMaxStacks || 0,
      cryoDurationMs: weaponDef.cryoDurationMs || 0,
      homing: !!weaponDef.homing,
      homingTurnRate: weaponDef.homingTurnRateRadPerSec || 0,
      homingConeAngle: weaponDef.homingConeAngle || 0,
      homingRange: weaponDef.homingRange || 0,
      // One-shot hint captured at fire time (the shooter's client-side
      // locked target, if any) — re-validated every tick in the homing
      // steer below, never trusted blindly, never a guaranteed hit.
      preferredTargetId: weaponDef.homing ? owner.input.lockedTargetId || null : null,
    });
  }

  // Straight-line visibility test reusing the same swept AABB test bullets
  // use for wall collision — one obstacle loop, O(#obstacles), no scene
  // scan. Shared by homing ammo, splash line-of-sight, and every automatic
  // support weapon's targeting.
  _hasLineOfSight(x1, z1, x2, z2) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    for (const o of OBSTACLES) {
      if (sweepAabbHit(x1, z1, dx, dz, o.x - o.w / 2, o.z - o.d / 2, o.x + o.w / 2, o.z + o.d / 2)) {
        return false;
      }
    }
    return true;
  }

  // Shared targeting used by homing ammo AND every automatic support
  // weapon (turret/drone/missile pod/orbital/sentinel) — section 18's
  // "SupportWeaponTargeting". O(#players in this room), never a scene-wide
  // search, and never called more than once per shooter/support-slot per
  // tick. Priority: an explicit preferred id (the shooter's own client-side
  // locked target, or a homing missile's captured-at-launch target) if it's
  // still alive/in range/visible, else the closest such candidate.
  _findValidTarget(originX, originZ, excludeId, opts) {
    const { preferredId, range, coneCenterAngle = null, coneHalfAngle = 0, requireLOS = true } = opts;
    const consider = (target) => {
      if (!target || !target.alive || target.id === excludeId) return false;
      const dx = target.x - originX;
      const dz = target.z - originZ;
      const dist = Math.hypot(dx, dz);
      if (dist > range) return false;
      if (coneCenterAngle !== null) {
        const angle = Math.abs(angleDiff(coneCenterAngle, Math.atan2(dx, dz)));
        if (angle > coneHalfAngle) return false;
      }
      if (requireLOS && !this._hasLineOfSight(originX, originZ, target.x, target.z)) return false;
      return true;
    };

    if (preferredId) {
      const preferred = this.players.get(preferredId);
      if (consider(preferred)) return preferred;
    }

    let best = null;
    let bestDistSq = Infinity;
    for (const target of this.players.values()) {
      if (!consider(target)) continue;
      const dx = target.x - originX;
      const dz = target.z - originZ;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = target;
      }
    }
    return best;
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

  // Called once when a bullet's swept path first enters a target's hit
  // circle (see tick()). Handles the direct-damage + any status-effect side
  // of an ammo type; splash's own damage pass (_resolveSplash) runs
  // separately so a splash weapon's direct victim isn't double-counted —
  // hitting a splashRadius>0 bullet only ever applies damage through the
  // splash pass (which naturally gives that same victim full falloff-1.0
  // damage anyway, being at distance 0 from the blast).
  _resolveBulletHit(bullet, target, now) {
    if (bullet.splashRadius === 0) {
      this._applyDamage(bullet, target, bullet.damage, now);
    }

    if (bullet.shockRadius > 0) {
      // EMP pulse centered on the impact point (bullet.x/z were already
      // moved there by the caller) — slows AND disables firing for every
      // living player in range, including the one directly hit.
      for (const other of this.players.values()) {
        if (!other.alive || other.id === bullet.ownerId) continue;
        const dx = other.x - bullet.x;
        const dz = other.z - bullet.z;
        if (dx * dx + dz * dz > bullet.shockRadius * bullet.shockRadius) continue;
        const slow = other.debuffs.slow;
        slow.active = true;
        slow.source = 'shock';
        slow.stacks = 0;
        slow.mult = bullet.shockSlowMult;
        slow.expiresAt = now + bullet.shockDurationMs;
        other.debuffs.shocked.active = true;
        other.debuffs.shocked.expiresAt = now + bullet.shockDisableFireMs;
      }
    }

    if (bullet.cryoMaxStacks > 0) {
      // Single-target stacking slow: each cryo hit that lands while a prior
      // cryo stack on the SAME target is still active adds one more stack
      // (up to the configured max); a hit landing after it expired (or a
      // shock effect currently owns the slot) starts fresh at 1 stack.
      const slow = target.debuffs.slow;
      const stacks = slow.active && slow.source === 'cryo' ? Math.min(slow.stacks + 1, bullet.cryoMaxStacks) : 1;
      slow.active = true;
      slow.source = 'cryo';
      slow.stacks = stacks;
      slow.mult = Math.max(0.2, 1 - stacks * bullet.cryoSlowPerStack);
      slow.expiresAt = now + bullet.cryoDurationMs;
    }
  }

  // Splash damage with distance falloff + line-of-sight (a wall between the
  // blast and a target fully blocks it, even inside the radius) — shared by
  // the explosive weapon and the missile ammo's impact.
  _resolveSplash(bullet, detonateAt, now) {
    // One visible explosion per detonation, whether or not it actually
    // damages anyone — the client reuses its already-pooled burst effect
    // (see spawnBurst in client.js) rather than this needing its own VFX.
    this.events.push({ type: 'explosion', x: detonateAt.x, z: detonateAt.z });
    for (const target of this.players.values()) {
      if (!target.alive || target.id === bullet.ownerId) continue;
      const dx = target.x - detonateAt.x;
      const dz = target.z - detonateAt.z;
      const dist = Math.hypot(dx, dz);
      if (dist > bullet.splashRadius) continue;
      if (!this._hasLineOfSight(detonateAt.x, detonateAt.z, target.x, target.z)) continue;
      const distRatio = dist / bullet.splashRadius;
      const falloff = Math.max(SPLASH_FALLOFF_MIN, 1 - distRatio * (1 - SPLASH_FALLOFF_MIN));
      this._applyDamage(bullet, target, bullet.damage * bullet.splashDamageMult * falloff, now);
    }
  }

  // One shared spawn path for every automatic support weapon's projectile
  // (turret/drone/missile pod/orbital/sentinel) — aims directly at the
  // already-resolved `target` (unlike _spawnBullet, which aims along the
  // owner's turretRot) but is otherwise a completely normal bullet: it goes
  // through the exact same swept collision / wall-blocking / damage pipeline
  // in tick(), so a support weapon can never shoot through a wall or bypass
  // real collision. missilepod's def.homing gives its bullets the same
  // capped-steering behavior as the Micro Missile ammo.
  _spawnSupportBullet(owner, target, supportDef, supportType, now) {
    const id = nextBulletId++;
    const dx = target.x - owner.x;
    const dz = target.z - owner.z;
    const dist = Math.hypot(dx, dz) || 1;
    const dirX = dx / dist;
    const dirZ = dz / dist;
    this.bullets.set(id, {
      id,
      ownerId: owner.id,
      kind: 'support_' + supportType,
      color: 0xffffff,
      damage: supportDef.damage,
      splashRadius: 0,
      splashDamageMult: 0,
      x: owner.x,
      z: owner.z,
      vx: dirX * supportDef.bulletSpeed,
      vz: dirZ * supportDef.bulletSpeed,
      bornAt: now,
      pierceRemaining: 0,
      pierceDamageFalloff: 1,
      hitIds: null,
      bounceRemaining: 0,
      bounceDamageMult: 1,
      bounceSpeedMult: 1,
      shockRadius: 0,
      shockSlowMult: 1,
      shockDurationMs: 0,
      shockDisableFireMs: 0,
      cryoSlowPerStack: 0,
      cryoMaxStacks: 0,
      cryoDurationMs: 0,
      homing: !!supportDef.homing,
      homingTurnRate: 3.2,
      homingConeAngle: Math.PI,
      homingRange: supportDef.range,
      preferredTargetId: null,
    });
  }

  // Drives every player's active temporary support weapon: finds a target
  // (shared _findValidTarget — no scene-wide scan, no per-frame allocation
  // beyond the tiny bullet object itself) and fires when its own cooldown
  // allows. `modules` > 1 (orbital) means several independent firing slots,
  // each on its own cooldown, so they don't all fire in lockstep.
  _updateSupportWeapons(now) {
    for (const player of this.players.values()) {
      if (!player.support || !player.alive) continue;
      const def = SUPPORT_TYPES[player.support.type];
      if (!def) {
        player.support = null;
        continue;
      }
      if (now >= player.support.expiresAt) {
        this.events.push({ type: 'supportExpired', playerId: player.id, supportType: player.support.type });
        player.support = null;
        continue;
      }

      const preferredId = def.preferLockedTarget ? player.input.lockedTargetId : null;
      for (let slot = 0; slot < def.modules; slot++) {
        if (now < player.support.nextFireAt[slot]) continue;
        const target = this._findValidTarget(player.x, player.z, player.id, {
          preferredId,
          range: def.range,
          requireLOS: true,
        });
        if (!target) continue; // nothing valid to shoot at yet — keep waiting, cooldown untouched
        this._spawnSupportBullet(player, target, def, player.support.type, now);
        player.support.nextFireAt[slot] = now + def.fireCooldownMs;
      }
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
    const kind = this._pickWeightedPickupKind();
    const id = nextPickupId++;
    this.pickups.set(id, { id, kind, x: point.x, z: point.z });
    this._lastPickupSpawnAt = now;
  }

  // Rarity-weighted pickup selection (section 15): a pickup with no
  // explicit `rarity` field defaults to 'common'. Only runs once per ~12s
  // spawn, so recomputing the weight table each call is negligible.
  _pickWeightedPickupKind() {
    const entries = Object.entries(PICKUP_TYPES);
    let totalWeight = 0;
    for (const [, def] of entries) totalWeight += PICKUP_RARITY_WEIGHT[def.rarity] || PICKUP_RARITY_WEIGHT.common;
    let roll = Math.random() * totalWeight;
    for (const [kind, def] of entries) {
      roll -= PICKUP_RARITY_WEIGHT[def.rarity] || PICKUP_RARITY_WEIGHT.common;
      if (roll <= 0) return kind;
    }
    return entries[entries.length - 1][0];
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
    } else if (def.kind === 'support') {
      const supportDef = SUPPORT_TYPES[def.support];
      // Picking up a second support crate simply replaces whatever was
      // active (fresh full duration, fresh cooldowns) rather than stacking
      // two at once — keeps "only one support weapon at a time" simple and
      // matches how the single `weapon` buff slot already works above.
      player.support = {
        type: def.support,
        expiresAt: now + supportDef.durationMs,
        nextFireAt: new Array(supportDef.modules).fill(now),
      };
    }

    this.events.push({
      type: 'pickup',
      playerId: player.id,
      playerName: player.name,
      itemKind: def.kind,
      itemLabel: def.label,
      healAmount,
      supportType: def.kind === 'support' ? def.support : null,
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
      if (player.debuffs.slow.active && now >= player.debuffs.slow.expiresAt) {
        player.debuffs.slow.active = false;
        player.debuffs.slow.stacks = 0;
        player.debuffs.slow.mult = 1;
        player.debuffs.slow.source = null;
      }
      if (player.debuffs.shocked.active && now >= player.debuffs.shocked.expiresAt) {
        player.debuffs.shocked.active = false;
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
        const speedMult =
          (player.buffs.speed.active ? SPEED_BOOST_MULT : 1) * (player.debuffs.slow.active ? player.debuffs.slow.mult : 1);
        const dx = (fx * moveForward + rx * moveRight) * player.stats.moveSpeed * speedMult * dt;
        const dz = (fz * moveForward + rz * moveRight) * player.stats.moveSpeed * speedMult * dt;

        const nx = clamp(player.x + dx, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
        if (!isBlockedByObstacle(nx, player.z, TANK_RADIUS)) player.x = nx;

        const nz = clamp(player.z + dz, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
        if (!isBlockedByObstacle(player.x, nz, TANK_RADIUS)) player.z = nz;
      }

      if (input.firing && !player.debuffs.shocked.active) {
        const weaponDef = WEAPON_TYPES[player.weapon.type] || WEAPON_TYPES.normal;
        const rapidMult = player.buffs.rapidfire.active ? RAPID_FIRE_MULT : 1;
        const cooldown = player.stats.fireCooldown * weaponDef.cooldownMult * rapidMult;
        if (now - player.lastFireTime >= cooldown) {
          player.lastFireTime = now;
          this._fireWeapon(player, now);
        }
      }
    }

    this._updateSupportWeapons(now);

    for (const bullet of this.bullets.values()) {
      if (now - bullet.bornAt >= BULLET_LIFETIME_MS) {
        this.bullets.delete(bullet.id);
        continue;
      }

      // Subtle capped-rate steering toward a target (never a snap, never a
      // teleport) — see _findValidTarget's cone/range/LOS filtering. This
      // only ever changes the bullet's VELOCITY DIRECTION; the swept
      // collision below remains the sole authority on whether/what it hits.
      if (bullet.homing) {
        const heading = Math.atan2(bullet.vx, bullet.vz);
        const homingTarget = this._findValidTarget(bullet.x, bullet.z, bullet.ownerId, {
          preferredId: bullet.preferredTargetId,
          range: bullet.homingRange,
          coneCenterAngle: heading,
          coneHalfAngle: bullet.homingConeAngle,
          requireLOS: true,
        });
        if (homingTarget) {
          const desired = Math.atan2(homingTarget.x - bullet.x, homingTarget.z - bullet.z);
          const maxStep = bullet.homingTurnRate * dt;
          const newHeading = heading + clamp(angleDiff(heading, desired), -maxStep, maxStep);
          const speed = Math.hypot(bullet.vx, bullet.vz);
          bullet.vx = Math.sin(newHeading) * speed;
          bullet.vz = Math.cos(newHeading) * speed;
        } else {
          bullet.preferredTargetId = null; // stale/invalid — stop re-checking it every tick
        }
      }

      // Resolves the bullet's ENTIRE per-tick travel as a sequence of
      // sub-segments rather than one straight shot: a fast bullet can pass
      // through several enemies (AP) or bounce off several walls
      // (ricochet) within a single 50ms tick, and each of those events can
      // change its position/velocity/damage mid-tick, so the remaining
      // travel must be re-swept from wherever/whatever it just did. The
      // iteration cap is just a safety net (pierce/bounce budgets are
      // always small) against an unforeseen infinite loop.
      let remainingTime = dt;
      let remove = false;
      let detonateAt = null;
      let iterations = 0;
      while (!remove && remainingTime > 1e-7 && iterations++ < 8) {
        const startX = bullet.x;
        const startZ = bullet.z;
        const moveDx = bullet.vx * remainingTime;
        const moveDz = bullet.vz * remainingTime;
        const candX = startX + moveDx;
        const candZ = startZ + moveDz;

        if (Math.abs(candX) > ARENA_HALF_SIZE || Math.abs(candZ) > ARENA_HALF_SIZE) {
          bullet.x = candX;
          bullet.z = candZ;
          remove = true;
          break;
        }

        // Swept collision over this sub-segment — see sweepCircleHit/
        // sweepAabbHit for why the whole segment (not just its endpoint)
        // must be tested. "First hit wins": whichever candidate (any
        // obstacle, any alive non-owner enemy not already pierced by this
        // bullet) has the smallest entry-t is the one actually hit.
        let bestT = Infinity;
        let hitTarget = null;
        let hitNormal = null;

        for (const o of OBSTACLES) {
          const hit = sweepAabbHit(
            startX,
            startZ,
            moveDx,
            moveDz,
            o.x - o.w / 2 - BULLET_RADIUS,
            o.z - o.d / 2 - BULLET_RADIUS,
            o.x + o.w / 2 + BULLET_RADIUS,
            o.z + o.d / 2 + BULLET_RADIUS
          );
          if (hit && hit.t < bestT) {
            bestT = hit.t;
            hitTarget = null;
            hitNormal = hit;
          }
        }

        for (const target of this.players.values()) {
          if (!target.alive || target.id === bullet.ownerId) continue;
          if (bullet.hitIds && bullet.hitIds.has(target.id)) continue; // AP: never re-hit the same target
          const t = sweepCircleHit(startX, startZ, moveDx, moveDz, target.x, target.z, TANK_RADIUS + BULLET_RADIUS);
          if (t !== null && t < bestT) {
            bestT = t;
            hitTarget = target;
            hitNormal = null;
          }
        }

        if (bestT > 1) {
          bullet.x = candX;
          bullet.z = candZ;
          break; // nothing left to hit in this tick's remaining travel
        }

        bullet.x = startX + moveDx * bestT;
        bullet.z = startZ + moveDz * bestT;
        remainingTime -= remainingTime * bestT;

        if (hitTarget) {
          this._resolveBulletHit(bullet, hitTarget, now);
          if (bullet.hitIds) {
            bullet.hitIds.add(hitTarget.id); // AP: never re-hit this same target again
            if (bullet.pierceRemaining > 0) {
              bullet.pierceRemaining--;
              bullet.damage *= bullet.pierceDamageFalloff;
              continue; // keep flying, may hit another target or a wall this same tick
            }
          }
          remove = true;
          if (bullet.splashRadius > 0) detonateAt = { x: bullet.x, z: bullet.z };
        } else {
          if (bullet.bounceRemaining > 0) {
            // Reflect velocity off the wall's surface normal: v' = v - 2(v.n)n
            const dot = bullet.vx * hitNormal.nx + bullet.vz * hitNormal.nz;
            bullet.vx = (bullet.vx - 2 * dot * hitNormal.nx) * bullet.bounceSpeedMult;
            bullet.vz = (bullet.vz - 2 * dot * hitNormal.nz) * bullet.bounceSpeedMult;
            bullet.damage *= bullet.bounceDamageMult;
            bullet.bounceRemaining--;
            continue; // ricochet: keep flying with the new reflected velocity
          }
          remove = true;
          if (bullet.splashRadius > 0) detonateAt = { x: bullet.x, z: bullet.z };
          // A wall hit with no splash and no bounces left just disappears.
        }
      }

      if (detonateAt) this._resolveSplash(bullet, detonateAt, now);
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
        slowActive: p.debuffs.slow.active,
        shockedActive: p.debuffs.shocked.active,
        supportType: p.support ? p.support.type : null,
        supportExpiresAt: p.support ? p.support.expiresAt : 0,
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
