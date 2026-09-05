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
  TEAM_SPAWN_POINTS,
  PLAYER_COLORS,
  TEAM_COLORS,
  MAX_UPGRADE_LEVEL,
  UPGRADES,
  UPGRADE_CATALOG,
  SPRINT_SPEED_MULT,
  MAX_STAMINA,
  STAMINA_DRAIN_PER_SEC,
  STAMINA_REGEN_PER_SEC,
  STAMINA_REGEN_DELAY_MS,
  PERK_POOL,
  DIFFICULTIES,
  BOT_TIERS,
  ENEMY_ROLES,
  ROLE_UNLOCK_CHAPTER,
  ELITE_HP_MULT,
  ELITE_DMG_MULT,
  ELITE_ABILITIES,
  ELITE_DASH_COOLDOWN_MS,
  ELITE_DASH_SPEED_MULT,
  ELITE_DASH_DURATION_MS,
  ELITE_SHIELD_DURATION_MS,
  ELITE_SHIELD_COOLDOWN_MS,
  ELITE_SHIELD_REDUCTION,
  ELITE_REGEN_PER_SEC_PCT,
  chapterScaling,
  BOSS_ATTACKS,
  BOSS_PHASE_THRESHOLDS,
  BOSS_TRANSITION_INVULN_MS,
  BOSS_ENRAGE_HP_PCT,
  BOSS_ENRAGE_COOLDOWN_MULT,
  BOSS_ENRAGE_SPEED_MULT,
  bossStatMult,
  WEAPON_TYPES,
  WEAPON_BUFF_DURATION_MS,
  SPLASH_FALLOFF_MIN,
  CRYO_FREEZE_MS,
  CRYO_THAW_MS,
  SUPPRESSION_MAX,
  SUPPRESSION_DECAY_MS,
  SUPPRESSION_STAGGER_MS,
  SUPPRESSION_SLOW_MULT,
  SUPPRESSION_STAGGER_SLOW_MULT,
  MAX_ZONES,
  SUPPORT_TYPES,
  PICKUP_TYPES,
  PICKUP_RARITY_WEIGHT,
  DROP_TABLES,
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
  STAGES,
} = require('./constants');

let nextBulletId = 1;
let nextBotSeq = 1;
let nextPickupId = 1;
let nextZoneId = 1;

function randomSpawn(team) {
  const pool = team && TEAM_SPAWN_POINTS[team] ? TEAM_SPAWN_POINTS[team] : SPAWN_POINTS;
  const p = pool[Math.floor(Math.random() * pool.length)];
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

function clampNodeLevel(v, maxLevel) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return clamp(n, 0, maxLevel);
}

function clampPerkStacks(v, maxStacks) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return clamp(n, 0, maxStacks);
}

// Computes every stat this player's tank actually has, from a
// client-supplied loadout (25 upgrade node levels) + perk stack counts —
// both are just small integers clamped HERE against each node/perk's own
// authoritative table, so a tampered client can at best claim what a
// legitimately fully-upgraded/perked tank would have, never beyond it
// (same trust model the original 4-track system already used).
// `levels`/`perkStacks` are returned so the snapshot/UI can echo back
// exactly what was applied.
function statsFromLoadout(loadout, perks) {
  const levels = {};
  const bonus = {}; // nodeId -> applied value at this level (0 for 'absolute' nodes, which replace instead)
  const absolute = {};
  for (const node of UPGRADE_CATALOG) {
    const lvl = clampNodeLevel(loadout && loadout[node.id], node.maxLevel);
    levels[node.id] = lvl;
    if (node.mode === 'absolute') absolute[node.id] = node.levels[lvl];
    else bonus[node.id] = node.levels[lvl];
  }

  const perkStacks = {};
  const perkTotals = {};
  for (const perk of PERK_POOL) {
    const stacks = clampPerkStacks(perks && perks[perk.id], perk.maxStacks);
    perkStacks[perk.id] = stacks;
    perkTotals[perk.statKey] = (perkTotals[perk.statKey] || 0) + stacks * perk.perStack;
  }

  const damage = absolute.power * (1 + (perkTotals.damageMult || 0) + (perkTotals.legendaryOffense ? 0.2 : 0));
  const maxHp = Math.round(
    absolute.defense * (1 + (perkTotals.hpMult || 0) + (perkTotals.legendaryOffense ? 0.2 : 0) + (perkTotals.legendaryDefense ? 0.2 : 0))
  );
  const moveSpeed = absolute.agility * (1 + (perkTotals.moveSpeedMult || 0));
  const fireCooldown = Math.max(120, absolute.rate * (1 + (perkTotals.cooldownMult || 0)));

  return {
    damage,
    maxHp,
    moveSpeed,
    fireCooldown,
    levels,
    perkStacks,
    // ---- derived stats used throughout tick()/combat below ----
    critChance: clamp(bonus.critChance + (perkTotals.critChanceFlat || 0), 0, 0.9),
    critDamageMult: bonus.critDamage,
    armorPen: bonus.armorPen,
    elementalDamageMult: bonus.elementalDamage,
    damageReductionMult: clamp(bonus.damageReduction + (perkTotals.damageReductionFlat || 0), 0, 0.75),
    healthRegenPerSec: bonus.healthRegen + (perkTotals.legendaryDefense ? 2 : 0),
    elementalResistMult: bonus.elementalResist,
    sprintSpeedBonusMult: bonus.sprintSpeed,
    maxStaminaBonus: bonus.maxStamina,
    staminaRegenBonus: bonus.staminaRegen * (1 + (perkTotals.staminaRegenMult || 0)),
    sprintDrainReductionMult: bonus.sprintEfficiency,
    projectileSpeedMult: bonus.projectileSpeed,
    projectilePierceBonus: bonus.projectilePierce,
    explosionRadiusMult: bonus.explosionRadius,
    statusDurationMult: bonus.statusDuration,
    onKillHealPct: bonus.onKillHeal + (perkTotals.onKillHealFlat || 0),
    killStreakDamagePerStack: bonus.killStreakDamage,
    lowHpDamageBonusMult: bonus.lowHpDamageBonus,
    lootLuckMult: bonus.lootLuck,
    supportDurationMult: bonus.supportDuration,
    supportPowerMult: bonus.supportPower,
  };
}

// Bots (and bosses) go through the SAME campaign difficulty + chapter
// scaling formula, then a role's stat multipliers on top (section 25) —
// one shared function instead of special-casing per role.
function statsFromBotTier(tierName, roleName, chapter, difficultyKey) {
  const tier = BOT_TIERS[tierName] || BOT_TIERS.easy;
  const role = ENEMY_ROLES[roleName] || ENEMY_ROLES.normal;
  const scale = chapterScaling(chapter || 1);
  const diff = DIFFICULTIES[difficultyKey] || DIFFICULTIES.normal;
  const hpMult = scale.hpMult * (role.hpMult || 1) * diff.hpMult;
  const dmgMult = scale.dmgMult * (role.dmgMult || 1) * diff.dmgMult;
  const speedMult = scale.speedMult * (role.moveMult || 1) * diff.speedMult;
  return {
    damage: tier.damage * dmgMult,
    maxHp: Math.round(tier.maxHp * hpMult),
    moveSpeed: tier.moveSpeed * speedMult,
    turnSpeed: tier.turnSpeed * scale.turnSpeedMult,
    fireCooldown: tier.fireCooldown / Math.max(0.2, role.fireMult != null ? role.fireMult : 1),
    engageRange: tier.engageRange * (role.engageMult != null ? role.engageMult : 1),
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

// Status-effect system for every ammo/support debuff (sections 4-24). Each
// slot is a generic flag the movement/fire/damage math reads once — adding
// a new effect never means hardcoding a bespoke path deep in collision code.
//   slow      — shared, single-value speed multiplier; strongest source
//               wins on conflict (see Game.js#_applySlow). `source` is used
//               only for cryo's OWN stacking rule (see _applyCryoStack).
//   shocked   — weapon disabled (EMP / lightning stun).
//   freeze    — cryo's max-stack hard root: speed forced to 0 while
//               active, then a linear thaw ramp back to normal by
//               `thawUntil` — NEVER a permanent freeze.
//   burn      — incendiary DOT; repeated hits REFRESH (never stack ticks).
//   corroded  — corrosive vulnerability (+% damage taken); refresh-only.
//   marked    — marking ammo/combat drone; boosts SUPPORT weapon damage
//               taken specifically (see _applyDamage).
//   suppressed/staggered — Auto Turret's suppression build-up and the
//               resulting brief stagger (section 16).
function freshDebuffs() {
  return {
    slow: { active: false, expiresAt: 0, mult: 1, stacks: 0, source: null },
    shocked: { active: false, expiresAt: 0 },
    freeze: { active: false, expiresAt: 0, thawUntil: 0 },
    burn: { active: false, expiresAt: 0, nextTickAt: 0, damage: 0, tickMs: 500, sourceId: null },
    corroded: { active: false, expiresAt: 0, mult: 1 },
    marked: { active: false, expiresAt: 0, supportDamageMult: 1 },
    suppressed: { stacks: 0, expiresAt: 0 },
    staggered: { active: false, expiresAt: 0 },
  };
}

function freshCombatState() {
  return {
    buffs: freshBuffs(),
    debuffs: freshDebuffs(),
    weapon: { type: 'normal', expiresAt: 0 },
    support: null, // active temporary support weapon, if any — see _updateSupportWeapons
  };
}

// Every bullet (player ammo, support-weapon fire, or a cluster fragment)
// carries this SAME full shape — every field a no-op zero/identity unless
// the spawning weapon/support def explicitly sets it — so the single
// shared tick() resolution loop never has to special-case which kind of
// bullet it's currently looking at.
function defaultBulletFields() {
  return {
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
    chainMaxTargets: 0,
    chainSlowMult: 1,
    chainDurationMs: 0,
    chainDisableFireMs: 0,
    chainCooldownMs: 0,
    cryoSlowPerStack: 0,
    cryoMaxStacks: 0,
    cryoDurationMs: 0,
    burnDamage: 0,
    burnTickMs: 500,
    burnDurationMs: 0,
    corrodeMult: 1,
    corrodeDurationMs: 0,
    lifestealPct: 0,
    lifestealCap: 0,
    markDurationMs: 0,
    markSupportDamageMult: 1.25,
    knockback: 0,
    clusterCount: 0,
    clusterDamageMult: 1,
    clusterSpeed: 0,
    clusterSpreadAngle: 0,
    homing: false,
    homingTurnRate: 0,
    homingConeAngle: 0,
    homingRange: 0,
    preferredTargetId: null,
    isSupport: false,
    isExecution: false,
    appliesSuppression: false,
    zoneKind: null,
    zoneRadius: 0,
    zoneDurationMs: 0,
    zoneTickMs: 500,
    zoneTickDamage: 0,
    zoneSlowMult: 1,
    splashRadius: 0,
    splashDamageMult: 0,
  };
}

class Game {
  /**
   * @param {string} roomId
   * @param {'arena'|'campaign'} mode
   * @param {object|null} stageDef  Required when mode === 'campaign'.
   * @param {string} [difficultyKey] Campaign difficulty (section 38) — ignored outside campaign.
   */
  constructor(roomId, mode, stageDef, difficultyKey) {
    this.roomId = roomId;
    this.mode = mode;
    this.stageDef = stageDef || null;
    this.chapter = stageDef ? stageDef.chapter : 1;
    this.difficulty = DIFFICULTIES[difficultyKey] ? difficultyKey : 'normal';
    this.players = new Map(); // id -> player state (humans + bots)
    this.bullets = new Map(); // id -> bullet state
    this.pickups = new Map(); // id -> {id, kind, x, z, droppedAt}
    this.zones = new Map(); // id -> area-denial zone (missile pod danger zones)
    this._shockChainCooldown = new Map(); // playerId -> timestamp before which it can't be re-chained
    this.events = []; // transient events (hit/kill/join/leave/pickup) since last flush
    this._colorIndex = 0;
    this._lastPickupSpawnAt = Date.now();
    this.finished = false;
    this.stageCleared = false;
    this.stageFailed = false;

    // ---- Wave/objective state (sections 22-23) — campaign-only; a plain
    // arena room just leaves this at its harmless defaults. ----
    this.waveIndex = -1; // -1 = no wave spawned yet
    this.waveBreatherUntil = 0;
    this.stageStartedAt = Date.now();
    this.objective = null; // built lazily on first tick (see _ensureObjectiveState)
    this.huntTargetId = null;
    this.bossId = null;
    this._bossSpawned = false;
  }

  addPlayer(id, name, loadout, perks, team) {
    team = team && TEAM_COLORS[team] ? team : null;
    const spawn = randomSpawn(team);
    let color;
    if (team) {
      color = TEAM_COLORS[team];
    } else {
      color = PLAYER_COLORS[this._colorIndex % PLAYER_COLORS.length];
      this._colorIndex++;
    }
    const stats = statsFromLoadout(loadout, perks);
    const maxStamina = MAX_STAMINA + stats.maxStaminaBonus;

    const player = {
      id,
      name: sanitizeName(name),
      isBot: false,
      team,
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
      lastDamagedAt: 0,
      deathTime: 0,
      stamina: maxStamina,
      sprinting: false,
      staminaRegenAt: 0,
      killStreak: 0,
      killStreakExpiresAt: 0,
      input: { moveForward: 0, moveRight: 0, turretRot: spawn.rotY, firing: false, sprinting: false, lockedTargetId: null },
      ...freshCombatState(),
    };
    this.players.set(id, player);
    this.events.push({ type: 'join', id, name: player.name });
    return player;
  }

  // `opts`: { role, chapter, difficulty, isElite, bossDef } — every campaign
  // bot (normal, elite, or boss) goes through this ONE factory; a boss is
  // simply a bot with `opts.bossDef` set, sharing the exact same
  // players-map/snapshot/collision plumbing as everything else (section 27
  // explicitly permits — and this project's single-map/no-custom-model
  // constraints make it the only honest option — a shared, data-driven boss
  // "entity" rather than a bespoke class hierarchy).
  addBot(tierName, opts) {
    opts = opts || {};
    const roleName = opts.role || 'normal';
    const id = opts.bossDef ? `boss-${this.roomId}` : `bot-${this.roomId}-${nextBotSeq++}`;
    const spawn = randomSpawn();
    const stats = statsFromBotTier(tierName, roleName, opts.chapter || this.chapter, opts.difficulty || this.difficulty);
    const tier = BOT_TIERS[tierName] || BOT_TIERS.easy;
    const role = ENEMY_ROLES[roleName] || ENEMY_ROLES.normal;

    if (opts.isElite) {
      stats.maxHp = Math.round(stats.maxHp * ELITE_HP_MULT);
      stats.damage *= ELITE_DMG_MULT;
    }

    let bossState = null;
    if (opts.bossDef) {
      const mult = bossStatMult(opts.chapter || this.chapter);
      stats.maxHp = Math.round(stats.maxHp * mult.hpMult);
      stats.damage *= mult.dmgMult;
      bossState = {
        def: opts.bossDef,
        phase: 0,
        enraged: false,
        invulnUntil: 0,
        attack: { type: null, state: 'idle', startedAt: 0, readyAt: 0, data: null },
        attackCooldowns: {},
      };
    }

    const bot = {
      id,
      name: opts.bossDef ? opts.bossDef.name : `${opts.isElite ? 'TINH NHUỆ — ' : ''}${role.label} (${tierLabel(tierName)})`,
      isBot: true,
      tierName,
      role: roleName,
      isElite: !!opts.isElite,
      isBoss: !!opts.bossDef,
      boss: bossState,
      elite: opts.isElite
        ? {
            ability: ELITE_ABILITIES[Math.floor(Math.random() * ELITE_ABILITIES.length)],
            dashReadyAt: 0,
            dashUntil: 0,
            shieldReadyAt: 0,
            shieldUntil: 0,
          }
        : null,
      x: spawn.x,
      z: spawn.z,
      bodyRot: spawn.rotY,
      turretRot: spawn.rotY,
      hp: stats.maxHp,
      alive: true,
      kills: 0,
      deaths: 0,
      color: opts.bossDef ? opts.bossDef.color : tier.color,
      stats,
      lastFireTime: 0,
      deathTime: 0,
      input: { moveForward: 0, moveRight: 0, turretRot: spawn.rotY, firing: false, sprinting: false, lockedTargetId: null },
      ai: {
        lastX: spawn.x,
        lastZ: spawn.z,
        stuckTicks: 0,
        avoidUntil: 0,
        avoidSign: 1,
        flankSign: Math.random() < 0.5 ? -1 : 1,
        summonNextAt: Date.now() + (role.summonEveryMs || 8000),
        chargeUntil: 0,
        chargeDirX: 0,
        chargeDirZ: 0,
        buffedUntil: 0,
      },
      ...freshCombatState(),
    };
    this.players.set(id, bot);
    if (opts.bossDef) this.bossId = id;
    return bot;
  }

  // Team Deathmatch: balances new joins onto whichever side currently has
  // fewer players (coin flip on a tie) so a room never lopsidedly stacks one
  // side.
  assignTeam() {
    let red = 0;
    let blue = 0;
    for (const p of this.players.values()) {
      if (p.team === 'red') red++;
      else if (p.team === 'blue') blue++;
    }
    if (red === blue) return Math.random() < 0.5 ? 'red' : 'blue';
    return red < blue ? 'red' : 'blue';
  }

  // Friendly-fire gate used by every PvP damage/target-selection path below:
  // true for a self-hit (harmless — callers already special-case it) AND for
  // two players sharing a truthy `team` (Team Deathmatch). Arena/campaign
  // players never have `team` set, so this is always false for them.
  _sameTeam(idA, idB) {
    if (idA === idB) return true;
    const a = this.players.get(idA);
    const b = this.players.get(idB);
    return !!(a && b && a.team && a.team === b.team);
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    this._shockChainCooldown.delete(id);
    if (this.bossId === id) this.bossId = null;
    this.events.push({ type: 'leave', id, name: player.name });
  }

  setInput(id, input) {
    const player = this.players.get(id);
    if (!player || player.isBot || !input) return;
    player.input.moveForward = clampAxis(input.moveForward);
    player.input.moveRight = clampAxis(input.moveRight);
    player.input.firing = !!input.firing;
    // Sprint is only actually granted in tick() if stamina allows it — see
    // the movement block — so a tampered client claiming sprinting:true
    // with 0 stamina simply gets ignored there, same trust model as
    // everything else here.
    player.input.sprinting = !!input.sprinting;
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
  // which alone is what makes them feel less than perfectly accurate. A
  // bot's `role` (section 25) changes movement/engagement behavior, not
  // just its raw stats — see the `behavior` branches below.
  _updateBotAI(bot, now, dt) {
    if (bot.isBoss) {
      this._updateBossAI(bot, now, dt);
      return;
    }

    const target = this._primaryHuman();
    if (!target || !target.alive) {
      bot.input.moveForward = 0;
      bot.input.moveRight = 0;
      bot.input.firing = false;
      return;
    }

    const role = ENEMY_ROLES[bot.role] || ENEMY_ROLES.normal;
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
    // Hunter (flank behavior) always biases its approach angle sideways
    // instead of only when stuck — it's actively trying to come at the
    // player from an angle rather than walking straight at them.
    let steerAngle;
    if (role.behavior === 'flank') steerAngle = desiredAngle + bot.ai.flankSign * 0.55;
    else if (now < bot.ai.avoidUntil) steerAngle = desiredAngle + bot.ai.avoidSign * 1.4;
    else steerAngle = desiredAngle;

    const maxStep = bot.stats.turnSpeed * dt;
    const step = clamp(angleDiff(bot.turretRot, steerAngle), -maxStep, maxStep);
    bot.input.turretRot = bot.turretRot + step;

    if (role.behavior === 'suicide') {
      // Always charges straight at the player regardless of range, never
      // fires a normal shot, and self-detonates once close enough.
      bot.input.moveForward = 1;
      bot.input.moveRight = 0;
      bot.input.firing = false;
      if (dist < 3.5) this._detonateSuicideBot(bot, role, now);
      return;
    }

    if (role.behavior === 'kiting' || role.behavior === 'sniper') {
      // Prefers to fight from near the edge of its own engage range —
      // backs off if the player closes in, advances if they're too far.
      const desiredDist = bot.stats.engageRange * 0.85;
      bot.input.moveForward = dist < desiredDist * 0.7 ? -1 : dist > desiredDist * 1.15 ? 1 : 0;
    } else if (role.behavior === 'aggressive' || role.behavior === 'melee') {
      const closeDist = role.behavior === 'melee' ? 6 : 10;
      bot.input.moveForward = dist > closeDist ? 1 : 0;
    } else {
      const tooClose = dist < 10;
      const tooFar = dist > bot.stats.engageRange * 0.7;
      bot.input.moveForward = tooFar ? 1 : tooClose ? -1 : 0;
    }
    bot.input.moveRight = 0;

    // Support role: periodically refreshes a speed/fire-rate buff on
    // nearby living allies (consumed in tick()'s movement/fire-cooldown
    // math) — a real "buffs nearby enemies" mechanic, not just a stat bump.
    if (role.behavior === 'buffAura') {
      for (const other of this.players.values()) {
        if (other === bot || !other.isBot || !other.alive || other.isBoss) continue;
        const adx = other.x - bot.x;
        const adz = other.z - bot.z;
        if (adx * adx + adz * adz > role.auraRadius * role.auraRadius) continue;
        other.ai.buffedUntil = now + 600;
      }
    }

    // Summoner role: periodically calls in one extra reinforcement.
    if (role.behavior === 'summoner' && now >= bot.ai.summonNextAt) {
      bot.ai.summonNextAt = now + (role.summonEveryMs || 9000);
      this._spawnReinforcement(bot);
    }

    if (bot.isElite) this._updateEliteAbility(bot, target, dist, now);

    const aligned = Math.abs(angleDiff(bot.input.turretRot, desiredAngle)) < 0.12;
    bot.input.firing = dist <= bot.stats.engageRange && aligned;
  }

  // Elite ability upkeep (section 26) — one of three small, readable
  // abilities rolled at spawn time (see addBot).
  _updateEliteAbility(bot, target, dist, now) {
    const elite = bot.elite;
    if (elite.ability === 'dash') {
      if (now >= elite.dashReadyAt && dist > 6 && dist < 30) {
        elite.dashUntil = now + ELITE_DASH_DURATION_MS;
        elite.dashReadyAt = now + ELITE_DASH_COOLDOWN_MS;
      }
    } else if (elite.ability === 'shieldPulse') {
      if (now >= elite.shieldReadyAt && bot.hp < bot.stats.maxHp * 0.6) {
        elite.shieldUntil = now + ELITE_SHIELD_DURATION_MS;
        elite.shieldReadyAt = now + ELITE_SHIELD_COOLDOWN_MS;
      }
    } else if (elite.ability === 'regen') {
      bot.hp = Math.min(bot.stats.maxHp, bot.hp + bot.stats.maxHp * ELITE_REGEN_PER_SEC_PCT * (TICK_MS / 1000));
    }
  }

  // Explosive role (section 25): reuses the same splash falloff + LOS rule
  // as explosive ammo, then removes itself — no kill credit/loot, since a
  // suicide unit farmable for guaranteed drops would be an obvious exploit.
  _detonateSuicideBot(bot, role, now) {
    if (!bot.alive) return;
    const radius = role.explodeRadius;
    const dmg = bot.stats.damage * role.explodeDamageMult;
    this.events.push({ type: 'explosion', x: bot.x, z: bot.z });
    for (const p of this.players.values()) {
      if (!p.alive || p.id === bot.id) continue;
      const dx = p.x - bot.x;
      const dz = p.z - bot.z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius) continue;
      if (!this._hasLineOfSight(bot.x, bot.z, p.x, p.z)) continue;
      const falloff = Math.max(SPLASH_FALLOFF_MIN, 1 - (dist / radius) * (1 - SPLASH_FALLOFF_MIN));
      this._applyDamage({ ownerId: bot.id }, p, dmg * falloff, now);
    }
    bot.hp = 0;
    bot.alive = false;
    bot.deathTime = now;
    bot.deaths++;
  }

  // Summoner role + boss `summon` attack share this one reinforcement
  // spawner — capped so a summon-heavy stage can't runaway-grow the room.
  _spawnReinforcement(caller) {
    if (this.players.size > 26) return;
    this.addBot(caller.tierName, { role: 'normal', chapter: this.chapter, difficulty: this.difficulty });
  }

  // ---- Boss engine (section 27-34): ONE reusable state machine driving
  // every chapter boss via BOSS_DEFS/BOSS_ATTACKS data — phase thresholds,
  // a brief invulnerability window on transition, enrage, and a fully
  // telegraphed (idle -> telegraph -> execute -> cooldown) attack loop so
  // every hit is avoidable if the player reacts to the warning event.
  _updateBossAI(boss, now, dt) {
    const target = this._primaryHuman();
    const state = boss.boss;
    if (!target || !target.alive) {
      boss.input.moveForward = 0;
      boss.input.moveRight = 0;
      boss.input.firing = false;
      return;
    }

    const dx = target.x - boss.x;
    const dz = target.z - boss.z;
    const dist = Math.hypot(dx, dz);
    const desiredAngle = Math.atan2(dx, dz);
    const maxStep = boss.stats.turnSpeed * dt;
    boss.input.turretRot = boss.turretRot + clamp(angleDiff(boss.turretRot, desiredAngle), -maxStep, maxStep);
    boss.input.firing = false; // bosses only ever damage through their special attack pool, never a plain shot

    const hpPct = Math.max(0, boss.hp / boss.stats.maxHp);
    const crossedIdx = BOSS_PHASE_THRESHOLDS.findIndex((t) => hpPct <= t);
    const targetPhase = crossedIdx === -1 ? 0 : crossedIdx + 1;
    if (targetPhase > state.phase) {
      state.phase = targetPhase;
      state.invulnUntil = now + BOSS_TRANSITION_INVULN_MS;
      state.attack.state = 'idle';
      this.events.push({ type: 'bossPhase', bossId: boss.id, phase: state.phase, name: state.def.name });
    }
    if (!state.enraged && hpPct <= BOSS_ENRAGE_HP_PCT) {
      state.enraged = true;
      this.events.push({ type: 'bossEnrage', bossId: boss.id, name: state.def.name });
    }

    if (now < state.invulnUntil) {
      // Transition window: visibly present but not attacking or repositioning
      // (section 33 — "avoid unfair damage during transitions").
      boss.input.moveForward = 0;
      boss.input.moveRight = 0;
      return;
    }

    // ROOT CAUSE of "boss attacks feel unfair": the boss used to keep
    // repositioning every tick even WHILE a telegraph was already showing a
    // warning at its (about-to-be-stale) position — so by the time the
    // attack actually executed, the boss (and therefore the real damage
    // area) had silently drifted away from wherever the warning was drawn.
    // Freezing movement for the whole telegraph->execute window guarantees
    // the ground position the player was warned about IS the position the
    // attack fires from — see _updateBossAttack's capture-at-telegraph-time
    // for the two attacks (dash/teleportStrike) that also relocate the boss.
    if (state.attack.state === 'idle') {
      const desiredDist = 22;
      boss.input.moveForward = dist > desiredDist * 1.2 ? 1 : dist < desiredDist * 0.6 ? -1 : 0;
      boss.input.moveRight = 0;
    } else {
      boss.input.moveForward = 0;
      boss.input.moveRight = 0;
    }

    this._updateBossAttack(boss, target, now);
  }

  _updateBossAttack(boss, target, now) {
    const state = boss.boss;
    const def = state.def;
    const atk = state.attack;
    const enrageMult = state.enraged ? BOSS_ENRAGE_COOLDOWN_MULT : 1;

    if (atk.state === 'idle') {
      const ready = def.attacks.filter((name) => now >= (state.attackCooldowns[name] || 0));
      if (ready.length === 0) return;
      const chosen = ready[Math.floor(Math.random() * ready.length)];
      const attackDef = BOSS_ATTACKS[chosen];
      atk.type = chosen;
      atk.state = 'telegraph';
      atk.startedAt = now;
      atk.readyAt = now + attackDef.telegraphMs;

      // Capture EVERYTHING _executeBossAttack will need, exactly ONCE, right
      // now — this is the fix for the "telegraph shows one spot, damage
      // lands somewhere else" bug (section 9): dash/teleportStrike used to
      // roll their landing point fresh at EXECUTE time, so the warning the
      // player saw literally could not have contained that information yet.
      // Rolling it here means the same data object feeds both the warning
      // event below and the real damage resolution later, by construction.
      const data = { targetX: target.x, targetZ: target.z };
      if (chosen === 'teleportStrike') {
        const angle = Math.random() * Math.PI * 2;
        const r = attackDef.radius * (0.25 + Math.random() * 0.35);
        data.landX = clamp(target.x + Math.sin(angle) * r, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
        data.landZ = clamp(target.z + Math.cos(angle) * r, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
      } else if (chosen === 'dash') {
        const dx = target.x - boss.x;
        const dz = target.z - boss.z;
        const dist2 = Math.hypot(dx, dz) || 1;
        const travel = Math.max(0, dist2 - attackDef.radius * 0.5);
        data.landX = clamp(boss.x + (dx / dist2) * travel, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
        data.landZ = clamp(boss.z + (dz / dist2) * travel, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
      } else if (chosen === 'missileBarrage') {
        // Homing missiles have no single fixed impact point — the target's
        // position at telegraph time is the honest approximation of "where
        // the barrage is inbound to" (the missiles' own visible flight then
        // gives additional real-time dodge information beyond this marker).
        data.landX = target.x;
        data.landZ = target.z;
      } else {
        // groundSlam/laserBeam/bulletStorm all fire from the boss's own
        // (now-frozen, see _updateBossAI) position/aim.
        data.landX = boss.x;
        data.landZ = boss.z;
      }
      atk.data = data;

      const aimAngle = Math.atan2(data.targetX - boss.x, data.targetZ - boss.z);
      // The client-visible warning (section 31) — MUST fire before any
      // damage from this attack ever can (readyAt is still in the future) —
      // and carries the attack's REAL shape (radius/width/range/count) read
      // from the exact same BOSS_ATTACKS entry _executeBossAttack uses, so
      // the indicator can never visually disagree with the actual hitbox.
      this.events.push({
        type: 'bossTelegraph',
        bossId: boss.id,
        attack: chosen,
        telegraphMs: attackDef.telegraphMs,
        x: boss.x,
        z: boss.z,
        targetX: data.targetX,
        targetZ: data.targetZ,
        landX: data.landX,
        landZ: data.landZ,
        dirX: Math.sin(aimAngle),
        dirZ: Math.cos(aimAngle),
        radius: attackDef.radius || 0,
        width: attackDef.width || 0,
        range: attackDef.range || 0,
        count: attackDef.count || 0,
        warnRadius: attackDef.warnRadius || attackDef.radius || 0,
      });
    } else if (atk.state === 'telegraph' && now >= atk.readyAt) {
      this._executeBossAttack(boss, target, atk, now);
      state.attackCooldowns[atk.type] = now + BOSS_ATTACKS[atk.type].cooldownMs * enrageMult;
      atk.state = 'idle';
    }
  }

  _executeBossAttack(boss, target, atk, now) {
    const def = BOSS_ATTACKS[atk.type];
    switch (atk.type) {
      case 'missileBarrage': {
        const baseAngle = Math.atan2(target.x - boss.x, target.z - boss.z);
        for (let i = 0; i < def.count; i++) {
          const spread = (i - (def.count - 1) / 2) * 0.16;
          this._spawnBossProjectile(boss, baseAngle + spread, 42, boss.stats.damage * def.damageMult, now, {
            homing: true,
            kind: 'support_missilepod',
            splashRadius: 3,
            splashDamageMult: 0.6,
          });
        }
        break;
      }
      case 'laserBeam': {
        const angle = Math.atan2(atk.data.targetX - boss.x, atk.data.targetZ - boss.z);
        const dirX = Math.sin(angle);
        const dirZ = Math.cos(angle);
        this.events.push({ type: 'bossLaserFire', bossId: boss.id, x: boss.x, z: boss.z, dirX, dirZ, range: def.range });
        for (const p of this.players.values()) {
          if (!p.alive || p.id === boss.id) continue;
          const px = p.x - boss.x;
          const pz = p.z - boss.z;
          const along = px * dirX + pz * dirZ;
          if (along < 0 || along > def.range) continue;
          const perp = Math.abs(px * dirZ - pz * dirX);
          if (perp > def.width) continue;
          if (!this._hasLineOfSight(boss.x, boss.z, p.x, p.z)) continue;
          this._applyDamage({ ownerId: boss.id }, p, boss.stats.damage * def.damageMult, now);
        }
        break;
      }
      case 'groundSlam': {
        this._bossAreaDamage(boss, boss.x, boss.z, def.radius, boss.stats.damage * def.damageMult, def.knockback, now);
        break;
      }
      case 'summon': {
        for (let i = 0; i < def.count; i++) this._spawnReinforcement(boss);
        break;
      }
      case 'dash': {
        // Land at the EXACT point captured at telegraph time (see
        // _updateBossAttack) — recomputing from the target's CURRENT
        // position here (as this used to do) would silently home in on
        // wherever the player moved to, making "dodge by moving away"
        // impossible even though the warning told them a fixed spot.
        boss.x = atk.data.landX;
        boss.z = atk.data.landZ;
        this._bossAreaDamage(boss, boss.x, boss.z, def.radius, boss.stats.damage * def.damageMult, 4, now);
        break;
      }
      case 'bulletStorm': {
        for (let i = 0; i < def.count; i++) {
          const angle = (i / def.count) * Math.PI * 2;
          this._spawnBossProjectile(boss, angle, 55, boss.stats.damage * def.damageMult, now, { kind: 'normal' });
        }
        break;
      }
      case 'teleportStrike': {
        // Land at the EXACT point rolled at telegraph time (see
        // _updateBossAttack) — rolling it fresh here (as this used to do)
        // meant the warning event literally could not have known where the
        // boss would reappear, making the attack undodgeable by definition.
        boss.x = atk.data.landX;
        boss.z = atk.data.landZ;
        this._bossAreaDamage(boss, boss.x, boss.z, def.radius, boss.stats.damage * def.damageMult, 3, now);
        break;
      }
      default:
        break;
    }
  }

  _spawnBossProjectile(boss, angle, speed, damage, now, opts) {
    opts = opts || {};
    const id = nextBulletId++;
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);
    this.bullets.set(id, {
      id,
      ownerId: boss.id,
      kind: opts.kind || 'normal',
      color: 0xff3d3d,
      damage,
      x: boss.x,
      z: boss.z,
      vx: dirX * speed,
      vz: dirZ * speed,
      bornAt: now,
      ...defaultBulletFields(),
      homing: !!opts.homing,
      homingTurnRate: 2.2,
      homingConeAngle: Math.PI,
      homingRange: 60,
      splashRadius: opts.splashRadius || 0,
      splashDamageMult: opts.splashDamageMult || 0,
    });
  }

  // Shared area-damage helper for groundSlam/dash/teleportStrike — same
  // falloff+LOS+knockback rule as explosive ammo (see _resolveSplash),
  // factored out since three attacks need it verbatim.
  _bossAreaDamage(boss, x, z, radius, damage, knockback, now) {
    this.events.push({ type: 'explosion', x, z });
    for (const p of this.players.values()) {
      if (!p.alive || p.id === boss.id) continue;
      const dx = p.x - x;
      const dz = p.z - z;
      const dist = Math.hypot(dx, dz);
      if (dist > radius) continue;
      if (!this._hasLineOfSight(x, z, p.x, p.z)) continue;
      const falloff = Math.max(SPLASH_FALLOFF_MIN, 1 - (dist / radius) * (1 - SPLASH_FALLOFF_MIN));
      this._applyDamage({ ownerId: boss.id }, p, damage * falloff, now);
      if (knockback > 0) this._applyKnockback(p, x, z, knockback * falloff);
    }
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
    const s = owner.stats || {};

    // ---- Offense/Weapon upgrade integration (sections 9/12) — all
    // computed ONCE at fire time, entirely from the shooter's own
    // server-trusted stats, never the target's. ----
    let damage = owner.stats.damage * weaponDef.damageMult;
    if (weaponType !== 'normal' && s.elementalDamageMult) damage *= s.elementalDamageMult;
    if (!owner.isBot && owner.hp / owner.stats.maxHp < 0.3 && s.lowHpDamageBonusMult) damage *= 1 + s.lowHpDamageBonusMult;
    if (!owner.isBot && owner.killStreak > 0 && now < owner.killStreakExpiresAt && s.killStreakDamagePerStack) {
      damage *= 1 + owner.killStreak * s.killStreakDamagePerStack;
    }
    const isCrit = !owner.isBot && s.critChance > 0 && Math.random() < s.critChance;
    if (isCrit) damage *= s.critDamageMult || 1.5;

    const speedMult = s.projectileSpeedMult || 1;
    const durationMult = s.statusDurationMult || 1;
    const pierceBonus = !owner.isBot ? s.projectilePierceBonus || 0 : 0;
    const basePierce = weaponDef.pierceCount ? weaponDef.pierceCount - 1 : 0;
    const totalPierce = basePierce + pierceBonus;

    this.bullets.set(id, {
      id,
      ownerId: owner.id,
      kind: weaponType,
      color: weaponDef.color,
      damage,
      isCrit,
      armorPen: s.armorPen || 0,
      x: owner.x + dirX * muzzleDist,
      z: owner.z + dirZ * muzzleDist,
      vx: dirX * weaponDef.bulletSpeed * speedMult,
      vz: dirZ * weaponDef.bulletSpeed * speedMult,
      bornAt: now,
      // Per-kind ammo behavior — all zero/no-op unless weaponDef sets them,
      // so "normal" and every basic weapon type behaves exactly as before.
      ...defaultBulletFields(),
      splashRadius: (weaponDef.splashRadius || 0) * (s.explosionRadiusMult || 1),
      splashDamageMult: weaponDef.splashDamageMult || 0,
      knockback: weaponDef.knockback || 0,
      // pierceCount is the TOTAL number of enemies this bullet can hit
      // before disappearing; the first hit is "free", so only
      // (pierceCount - 1) further hits need to be tracked/decremented here.
      // The Projectile Penetration upgrade adds extra pierce to EVERY
      // weapon type, not just AP, so `hitIds` must exist whenever that
      // bonus is active too.
      pierceRemaining: totalPierce,
      pierceDamageFalloff: weaponDef.pierceDamageFalloff || 1,
      hitIds: totalPierce > 0 ? new Set() : null,
      bounceRemaining: weaponDef.bounceCount || 0,
      bounceDamageMult: weaponDef.bounceDamageMult || 1,
      bounceSpeedMult: weaponDef.bounceSpeedMult || 1,
      shockRadius: weaponDef.shockRadius || 0,
      shockSlowMult: weaponDef.shockSlowMult || 1,
      shockDurationMs: (weaponDef.shockDurationMs || 0) * durationMult,
      shockDisableFireMs: (weaponDef.shockDisableFireMs || 0) * durationMult,
      chainMaxTargets: weaponDef.chainMaxTargets || 0,
      chainSlowMult: weaponDef.chainSlowMult || 1,
      chainDurationMs: (weaponDef.chainDurationMs || 0) * durationMult,
      chainDisableFireMs: (weaponDef.chainDisableFireMs || 0) * durationMult,
      chainCooldownMs: weaponDef.chainCooldownMs || 0,
      cryoSlowPerStack: weaponDef.cryoSlowPerStack || 0,
      cryoMaxStacks: weaponDef.cryoMaxStacks || 0,
      cryoDurationMs: (weaponDef.cryoDurationMs || 0) * durationMult,
      burnDamage: weaponDef.burnDamage || 0,
      burnTickMs: weaponDef.burnTickMs || 500,
      burnDurationMs: (weaponDef.burnDurationMs || 0) * durationMult,
      corrodeMult: weaponDef.corrodeMult || 1,
      corrodeDurationMs: (weaponDef.corrodeDurationMs || 0) * durationMult,
      lifestealPct: weaponDef.lifestealPct || 0,
      lifestealCap: weaponDef.lifestealCap || 0,
      markDurationMs: (weaponDef.markDurationMs || 0) * durationMult,
      markSupportDamageMult: weaponDef.markSupportDamageMult || 1.25,
      clusterCount: weaponDef.clusterCount || 0,
      clusterDamageMult: weaponDef.clusterDamageMult || 1,
      clusterSpeed: weaponDef.clusterSpeed || 0,
      clusterSpreadAngle: weaponDef.clusterSpreadAngle || 0,
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
  // weapon (turret/drone/missile pod/orbital/sentinel/lightning). O(#players
  // in this room), never a scene-wide search, and never called more than
  // once per shooter/support-slot per tick. Priority: an explicit preferred
  // id (the shooter's own client-side locked target, or a homing missile's
  // captured-at-launch target) if it's still alive/in range/visible; else
  // the best candidate by distance (default), lowest HP (sentinel's execute
  // priority), or highest HP (lightning's "strongest nearby enemy").
  _findValidTarget(originX, originZ, excludeId, opts) {
    const {
      preferredId,
      range,
      coneCenterAngle = null,
      coneHalfAngle = 0,
      requireLOS = true,
      excludeIds = null,
      preferLowestHp = false,
      preferHighestHp = false,
    } = opts;
    // Every call site passes the shooter's own id as excludeId, so deriving
    // its team here (rather than threading a team param through all four
    // call sites) makes every automatic-targeting path — homing ammo,
    // support weapons, lightning's chain — team-safe for free.
    const excludeTeam = (this.players.get(excludeId) || {}).team || null;
    const consider = (target) => {
      if (!target || !target.alive || target.id === excludeId) return false;
      if (excludeTeam && target.team === excludeTeam) return false;
      if (excludeIds && excludeIds.has(target.id)) return false;
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
    let bestScore = Infinity;
    for (const target of this.players.values()) {
      if (!consider(target)) continue;
      const dx = target.x - originX;
      const dz = target.z - originZ;
      let score;
      if (preferLowestHp) score = target.hp;
      else if (preferHighestHp) score = -target.hp;
      else score = dx * dx + dz * dz;
      if (score < bestScore) {
        bestScore = score;
        best = target;
      }
    }
    return best;
  }

  // Applies rawDamage (already weapon-scaled) to target, factoring armor,
  // corrosion (vulnerability), the marked-vs-support-weapon bonus, invuln,
  // and a shield support's absorbing HP pool, then handles death/kill
  // bookkeeping. Shared by every damage source in the game (direct hits,
  // splash, burn ticks, danger zones, lightning, gravity bursts) so they
  // all go through identical mitigation/death logic. Returns the actual HP
  // damage that was applied (0 if fully blocked/absorbed) — read by the
  // vampire ammo's lifesteal, which must be based on REAL damage dealt.
  _applyDamage(bullet, target, rawDamage, now) {
    // Boss phase-transition invulnerability (section 33) — visibly present,
    // completely untouchable, so a transition can never be an unfair hit.
    if (target.isBoss && target.boss && now < target.boss.invulnUntil) {
      this.events.push({ type: 'hit', attackerId: bullet.ownerId, victimId: target.id, amount: 0, blocked: true });
      return 0;
    }
    if (target.buffs.invuln.active) {
      this.events.push({ type: 'hit', attackerId: bullet.ownerId, victimId: target.id, amount: 0, blocked: true });
      return 0;
    }
    let dmg = rawDamage;
    if (target.debuffs.corroded.active && now < target.debuffs.corroded.expiresAt) {
      dmg *= target.debuffs.corroded.mult;
    }
    if (bullet.isSupport && target.debuffs.marked.active && now < target.debuffs.marked.expiresAt) {
      dmg *= target.debuffs.marked.supportDamageMult;
    }
    // Armor Penetration (offense upgrade) ignores a fraction of the
    // victim's armor-buff mitigation specifically — it never touches the
    // Energy Shield support's separate absorption below.
    if (target.buffs.armor.active) {
      const armorPen = clamp(bullet.armorPen || 0, 0, 1);
      dmg *= 1 - ARMOR_DAMAGE_REDUCTION * (1 - armorPen);
    }
    // Elite Shield Pulse ability (section 26).
    if (target.isElite && target.elite && now < target.elite.shieldUntil) {
      dmg *= 1 - ELITE_SHIELD_REDUCTION;
    }
    // Passive damage-reduction upgrade/perk (always-on, capped low so it
    // can't stack into invincibility with armor/shield above).
    if (target.stats && target.stats.damageReductionMult) {
      dmg *= 1 - target.stats.damageReductionMult;
    }

    // Energy Shield (section 21): absorbs before HP; breaking it ends the
    // support early, per spec, with its own event for the client's
    // shockwave/sound.
    if (target.support && target.support.type === 'shield' && target.support.shieldHp > 0) {
      target.support.lastDamagedAt = now;
      const absorbed = Math.min(target.support.shieldHp, dmg);
      target.support.shieldHp -= absorbed;
      dmg -= absorbed;
      if (target.support.shieldHp <= 0) {
        target.support.shieldHp = 0;
        this.events.push({ type: 'shieldBreak', playerId: target.id });
        target.support = null;
      }
    }

    if (dmg > 0) target.lastDamagedAt = now; // gates the healthRegen upgrade's out-of-combat requirement

    target.hp -= dmg;
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.deathTime = now;
      target.deaths++;
      const killer = this.players.get(bullet.ownerId);
      if (killer) {
        killer.kills++;
        if (!killer.isBot) {
          killer.killStreak = Math.min(5, (killer.killStreak || 0) + 1);
          killer.killStreakExpiresAt = now + 8000;
          if (killer.stats.onKillHealPct > 0) {
            killer.hp = Math.min(killer.stats.maxHp, killer.hp + killer.stats.maxHp * killer.stats.onKillHealPct);
          }
        }
      }
      this.events.push({
        type: 'kill',
        killerId: bullet.ownerId,
        killerName: killer ? killer.name : 'Unknown',
        victimId: target.id,
        victimName: target.name,
        amount: Math.round(dmg),
        executed: !!bullet.isExecution,
        crit: !!bullet.isCrit,
      });
      this._maybeDropLoot(target, now, killer);
    } else {
      this.events.push({
        type: 'hit',
        attackerId: bullet.ownerId,
        victimId: target.id,
        amount: Math.round(dmg),
        crit: !!bullet.isCrit,
      });
    }
    return dmg;
  }

  // Strongest-wins, refresh-on-reapply slow application shared by shock,
  // the missile-pod danger zone, the time-slow field, gravity's pull, and
  // turret suppression — a weaker slow landing later never cancels a
  // stronger one still running (e.g. a field tick can't undo a cryo
  // freeze's slow remnant), it just extends the stronger one's timer.
  _applySlow(target, mult, durationMs, source, now) {
    // Elemental Resistance (defense upgrade) shortens how long an incoming
    // slow lasts on THIS target — never touches how strong it is, just how
    // long, so it stays a meaningful mitigation without making CC useless.
    if (target.stats && target.stats.elementalResistMult) durationMs *= 1 - target.stats.elementalResistMult;
    const slow = target.debuffs.slow;
    const newExpiresAt = now + durationMs;
    const currentlyActive = slow.active && now < slow.expiresAt;
    if (!currentlyActive || mult <= slow.mult) {
      slow.active = true;
      slow.mult = mult;
      slow.source = source;
      slow.stacks = 0;
      slow.expiresAt = newExpiresAt;
    } else {
      slow.expiresAt = Math.max(slow.expiresAt, newExpiresAt);
    }
  }

  // Cryo (section 7): stacking slow that gets stronger with repeated hits;
  // at cryoMaxStacks the victim is rooted solid for CRYO_FREEZE_MS, then
  // thaws back to normal speed over CRYO_THAW_MS (see the speedMult read in
  // tick()) — never a permanent freeze, and no further stacking can extend
  // it while it's active.
  _applyCryoStack(bullet, target, now) {
    const debuffs = target.debuffs;
    if (debuffs.freeze.active && now < debuffs.freeze.expiresAt) return;
    const slow = debuffs.slow;
    const stacks =
      slow.active && slow.source === 'cryo' && now < slow.expiresAt ? Math.min(slow.stacks + 1, bullet.cryoMaxStacks) : 1;
    if (stacks >= bullet.cryoMaxStacks) {
      debuffs.freeze.active = true;
      debuffs.freeze.expiresAt = now + CRYO_FREEZE_MS;
      debuffs.freeze.thawUntil = now + CRYO_FREEZE_MS + CRYO_THAW_MS;
      slow.active = false;
      slow.stacks = 0;
      slow.source = null;
    } else {
      slow.active = true;
      slow.source = 'cryo';
      slow.stacks = stacks;
      slow.mult = Math.max(0.2, 1 - stacks * bullet.cryoSlowPerStack);
      slow.expiresAt = now + bullet.cryoDurationMs;
    }
  }

  // Shock (section 6): the directly-hit victim gets the full effect; up to
  // chainMaxTargets other nearby enemies get a WEAKER arc, each gated by its
  // own short cooldown so the same victim can't be re-chained endlessly by
  // repeated shock bullets.
  _applyShockPulse(bullet, primary, now) {
    const strike = (victim, slowMult, durationMs, disableMs) => {
      this._applySlow(victim, slowMult, durationMs, 'shock', now);
      victim.debuffs.shocked.active = true;
      victim.debuffs.shocked.expiresAt = now + disableMs;
    };
    strike(primary, bullet.shockSlowMult, bullet.shockDurationMs, bullet.shockDisableFireMs);
    this._shockChainCooldown.set(primary.id, now + bullet.chainCooldownMs);
    if (bullet.chainMaxTargets <= 0) return;

    const candidates = [];
    for (const other of this.players.values()) {
      if (!other.alive || other.id === bullet.ownerId || other.id === primary.id) continue;
      if (now < (this._shockChainCooldown.get(other.id) || 0)) continue;
      const dx = other.x - bullet.x;
      const dz = other.z - bullet.z;
      const dist = Math.hypot(dx, dz);
      if (dist > bullet.shockRadius) continue;
      if (!this._hasLineOfSight(bullet.x, bullet.z, other.x, other.z)) continue;
      candidates.push({ other, dist });
    }
    candidates.sort((a, b) => a.dist - b.dist);
    const n = Math.min(bullet.chainMaxTargets, candidates.length);
    for (let i = 0; i < n; i++) {
      const victim = candidates[i].other;
      strike(victim, bullet.chainSlowMult, bullet.chainDurationMs, bullet.chainDisableFireMs);
      this._shockChainCooldown.set(victim.id, now + bullet.chainCooldownMs);
    }
  }

  // Auto Turret suppression (section 16): sustained hits build a decaying
  // stack counter; at SUPPRESSION_MAX the victim is briefly staggered
  // (can't fire, heavily slowed) and the counter resets so it can't just
  // stay staggered forever.
  _applySuppression(target, now) {
    const s = target.debuffs.suppressed;
    if (now >= s.expiresAt) s.stacks = 0;
    s.stacks = Math.min(SUPPRESSION_MAX, s.stacks + 1);
    s.expiresAt = now + SUPPRESSION_DECAY_MS;
    if (s.stacks >= SUPPRESSION_MAX) {
      target.debuffs.staggered.active = true;
      target.debuffs.staggered.expiresAt = now + SUPPRESSION_STAGGER_MS;
      s.stacks = 0;
      this._applySlow(target, SUPPRESSION_STAGGER_SLOW_MULT, SUPPRESSION_STAGGER_MS, 'suppression', now);
    } else {
      this._applySlow(target, SUPPRESSION_SLOW_MULT, SUPPRESSION_DECAY_MS, 'suppression', now);
    }
  }

  // Called once when a bullet's swept path first enters a target's hit
  // circle (see tick()). Handles the direct-damage + every ammo/support
  // status-effect side of the hit. Splash's own damage pass (_resolveSplash)
  // runs separately so a splash weapon's direct victim isn't double-counted.
  _resolveBulletHit(bullet, target, now) {
    let dealt = 0;
    if (bullet.splashRadius === 0) {
      dealt = this._applyDamage(bullet, target, bullet.damage, now);
    }

    if (bullet.shockRadius > 0) this._applyShockPulse(bullet, target, now);
    if (bullet.cryoMaxStacks > 0) this._applyCryoStack(bullet, target, now);

    // Elemental Resistance (defense upgrade) shortens the DURATION of
    // incoming burn/corrode/mark on this target — same rule as _applySlow.
    const resistMult = 1 - (target.stats && target.stats.elementalResistMult ? target.stats.elementalResistMult : 0);

    if (bullet.burnDamage > 0) {
      const burn = target.debuffs.burn;
      burn.active = true;
      burn.damage = bullet.burnDamage;
      burn.tickMs = bullet.burnTickMs;
      burn.nextTickAt = now + bullet.burnTickMs;
      burn.expiresAt = now + bullet.burnDurationMs * resistMult;
      burn.sourceId = bullet.ownerId;
    }

    if (bullet.corrodeMult > 1) {
      const corroded = target.debuffs.corroded;
      corroded.active = true;
      corroded.mult = bullet.corrodeMult;
      corroded.expiresAt = now + bullet.corrodeDurationMs * resistMult;
    }

    if (bullet.markDurationMs > 0) {
      const marked = target.debuffs.marked;
      marked.active = true;
      marked.expiresAt = now + bullet.markDurationMs * resistMult;
      marked.supportDamageMult = bullet.markSupportDamageMult || 1.25;
    }

    if (bullet.lifestealPct > 0 && dealt > 0) {
      const owner = this.players.get(bullet.ownerId);
      if (owner && owner.alive) {
        const before = owner.hp;
        const heal = Math.min(bullet.lifestealCap, dealt * bullet.lifestealPct);
        owner.hp = Math.min(owner.stats.maxHp, owner.hp + heal);
        const actualHeal = Math.round(owner.hp - before);
        if (actualHeal > 0) this.events.push({ type: 'lifesteal', playerId: owner.id, amount: actualHeal });
      }
    }

    if (bullet.appliesSuppression) this._applySuppression(target, now);
  }

  // Splash damage with distance falloff + line-of-sight (a wall between the
  // blast and a target fully blocks it, even inside the radius) — shared by
  // the explosive weapon, the missile/missile-pod ammo's impact, and the
  // gravity core's burst. Explosive additionally pushes survivors away from
  // the blast center (section 8's knockback), also falling off with distance
  // and still blocked by obstacles (never pushes a target through a wall).
  _resolveSplash(bullet, detonateAt, now) {
    // One visible explosion per detonation, whether or not it actually
    // damages anyone — the client reuses its already-pooled burst effect
    // (see spawnBurst in client.js) rather than this needing its own VFX.
    this.events.push({ type: 'explosion', x: detonateAt.x, z: detonateAt.z });
    for (const target of this.players.values()) {
      if (!target.alive || this._sameTeam(bullet.ownerId, target.id)) continue;
      const dx = target.x - detonateAt.x;
      const dz = target.z - detonateAt.z;
      const dist = Math.hypot(dx, dz);
      if (dist > bullet.splashRadius) continue;
      if (!this._hasLineOfSight(detonateAt.x, detonateAt.z, target.x, target.z)) continue;
      const distRatio = dist / bullet.splashRadius;
      const falloff = Math.max(SPLASH_FALLOFF_MIN, 1 - distRatio * (1 - SPLASH_FALLOFF_MIN));
      this._applyDamage(bullet, target, bullet.damage * bullet.splashDamageMult * falloff, now);
      if (bullet.knockback > 0) this._applyKnockback(target, detonateAt.x, detonateAt.z, bullet.knockback * falloff);
    }
  }

  _applyKnockback(target, fromX, fromZ, distance) {
    if (distance <= 0.001) return;
    let dx = target.x - fromX;
    let dz = target.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const nx = clamp(target.x + dx * distance, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
    if (!isBlockedByObstacle(nx, target.z, TANK_RADIUS)) target.x = nx;
    const nz = clamp(target.z + dz * distance, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
    if (!isBlockedByObstacle(target.x, nz, TANK_RADIUS)) target.z = nz;
  }

  // Cluster ammo (section 14): on ANY impact (enemy or wall), spawns a
  // fixed, bounded number of fragments in a spread from the impact point —
  // never recursive (fragments carry clusterCount 0), so this can never
  // spawn more than clusterCount extra bullets per shot fired.
  _spawnClusterFragments(bullet, at, now) {
    const owner = this.players.get(bullet.ownerId);
    if (!owner) return;
    const n = bullet.clusterCount;
    const fragDamage = bullet.damage * bullet.clusterDamageMult;
    const baseAngle = Math.random() * Math.PI * 2;
    // Retreat the shared spawn origin slightly back along the MAIN round's
    // own incoming direction — since `at` is the exact point that path first
    // touched a target/wall, stepping backward along that same ray is
    // guaranteed to land just outside whatever it hit (sweepCircleHit
    // treats a segment that *starts* on/inside a circle as an immediate
    // t=0 hit regardless of a fragment's own travel direction, so spawning
    // exactly at the impact point would make several fragments register a
    // spurious instant self-hit rather than actually flying anywhere).
    const speed = Math.hypot(bullet.vx, bullet.vz) || 1;
    const originX = at.x - (bullet.vx / speed) * 0.5;
    const originZ = at.z - (bullet.vz / speed) * 0.5;
    for (let i = 0; i < n; i++) {
      const angle = baseAngle + (i / n) * bullet.clusterSpreadAngle;
      const dirX = Math.sin(angle);
      const dirZ = Math.cos(angle);
      const id = nextBulletId++;
      this.bullets.set(id, {
        id,
        ownerId: owner.id,
        kind: 'cluster_frag',
        color: 0xffa64d,
        damage: fragDamage,
        x: originX,
        z: originZ,
        vx: dirX * bullet.clusterSpeed,
        vz: dirZ * bullet.clusterSpeed,
        bornAt: now,
        ...defaultBulletFields(),
      });
    }
  }

  // Missile Pod's area-denial danger zone (section 18): spawned at an
  // impact point, capped at MAX_ZONES total for perf safety (section 30).
  _spawnZone(bullet, at, now) {
    if (this.zones.size >= MAX_ZONES) return;
    const id = nextZoneId++;
    this.zones.set(id, {
      id,
      kind: bullet.zoneKind,
      ownerId: bullet.ownerId,
      x: at.x,
      z: at.z,
      radius: bullet.zoneRadius,
      tickMs: bullet.zoneTickMs,
      tickDamage: bullet.zoneTickDamage,
      slowMult: bullet.zoneSlowMult,
      nextTickAt: now + bullet.zoneTickMs,
      expiresAt: now + bullet.zoneDurationMs,
    });
  }

  _updateZones(now) {
    for (const zone of this.zones.values()) {
      if (now >= zone.expiresAt) {
        this.zones.delete(zone.id);
        continue;
      }
      if (zone.kind === 'danger' && now >= zone.nextTickAt) {
        zone.nextTickAt = now + zone.tickMs;
        for (const target of this.players.values()) {
          if (!target.alive || this._sameTeam(zone.ownerId, target.id)) continue;
          const dx = target.x - zone.x;
          const dz = target.z - zone.z;
          if (dx * dx + dz * dz > zone.radius * zone.radius) continue;
          this._applyDamage({ ownerId: zone.ownerId }, target, zone.tickDamage, now);
          this._applySlow(target, zone.slowMult, zone.tickMs + 200, 'zone', now);
        }
      }
    }
  }

  // One shared spawn path for every automatic support weapon's projectile
  // (turret/drone/missile pod/orbital/sentinel) — aims directly at the
  // already-resolved `target` (unlike _spawnBullet, which aims along the
  // owner's turretRot) but is otherwise a completely normal bullet: it goes
  // through the exact same swept collision / wall-blocking / damage pipeline
  // in tick(), so a support weapon can never shoot through a wall or bypass
  // real collision. `extra.damageMult`/`extra.isExecution` implement the
  // Sentinel's execution shot (section 20); the rest of each support's
  // identity (suppression/mark/burn+corrode/zone) is read straight off
  // supportDef, same data-driven pattern as ammo.
  _spawnSupportBullet(owner, target, supportDef, supportType, now, extra) {
    extra = extra || {};
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
      damage: supportDef.damage * (extra.damageMult || 1),
      x: owner.x,
      z: owner.z,
      vx: dirX * supportDef.bulletSpeed,
      vz: dirZ * supportDef.bulletSpeed,
      bornAt: now,
      ...defaultBulletFields(),
      isSupport: true,
      isExecution: !!extra.isExecution,
      homing: !!supportDef.homing,
      homingTurnRate: 3.2,
      homingConeAngle: Math.PI,
      homingRange: supportDef.range,
      splashRadius: supportDef.splashRadius || 0,
      splashDamageMult: supportDef.splashDamageMult || 0,
      appliesSuppression: !!supportDef.appliesSuppression,
      markDurationMs: supportDef.appliesMark ? supportDef.markDurationMs || 0 : 0,
      markSupportDamageMult: 1.25,
      burnDamage: supportDef.appliesBurn ? supportDef.burnDamage || 0 : 0,
      burnTickMs: supportDef.burnTickMs || 500,
      burnDurationMs: supportDef.burnDurationMs || 0,
      corrodeMult: supportDef.appliesCorrode ? supportDef.corrodeMult || 1 : 1,
      corrodeDurationMs: supportDef.corrodeDurationMs || 0,
      zoneKind: supportDef.zoneKind || null,
      zoneRadius: supportDef.zoneRadius || 0,
      zoneDurationMs: supportDef.zoneDurationMs || 0,
      zoneTickMs: supportDef.zoneTickMs || 500,
      zoneTickDamage: supportDef.zoneTickDamage || 0,
      zoneSlowMult: supportDef.zoneSlowMult || 1,
    });
  }

  // Drives every player's active temporary support weapon. Auto-firing
  // types (turret/drone/missilepod/orbital/sentinel) share one
  // find-target-and-shoot loop (no scene-wide scan, no per-frame allocation
  // beyond the tiny bullet object itself); the four "special" supports
  // (shield/timeslow/lightning/gravity) don't fit that shape at all, so
  // they're delegated to _updateSpecialSupport instead (section 21-24).
  _updateSupportWeapons(now, dt) {
    for (const player of this.players.values()) {
      if (!player.support || !player.alive) continue;
      const def = SUPPORT_TYPES[player.support.type];
      if (!def) {
        player.support = null;
        continue;
      }
      if (now >= player.support.expiresAt) {
        if (def.special === 'gravity') this._gravityBurst(player, def, now);
        this.events.push({ type: 'supportExpired', playerId: player.id, supportType: player.support.type });
        player.support = null;
        continue;
      }

      if (def.special) {
        this._updateSpecialSupport(player, def, now, dt);
        continue;
      }

      const preferredId = def.preferLockedTarget ? player.input.lockedTargetId : null;
      for (let slot = 0; slot < def.modules; slot++) {
        if (now < player.support.nextFireAt[slot]) continue;
        const target = this._findValidTarget(player.x, player.z, player.id, {
          preferredId,
          range: def.range,
          requireLOS: true,
          preferLowestHp: !!def.preferLowestHp,
        });
        if (!target) continue; // nothing valid to shoot at yet — keep waiting, cooldown untouched
        // Utility upgrade "Sức Mạnh Hỗ Trợ" (supportPower) boosts BOTH the
        // support weapon's damage and its fire rate together (one node,
        // section 13/14's support-build synergy).
        const powerMult = (player.stats && player.stats.supportPowerMult) || 1;
        let damageMult = powerMult;
        let isExecution = false;
        if (def.executeHpPct && target.hp / target.stats.maxHp <= def.executeHpPct) {
          damageMult *= def.executeDamageMult;
          isExecution = true;
        }
        this._spawnSupportBullet(player, target, def, player.support.type, now, { damageMult, isExecution });
        player.support.nextFireAt[slot] = now + def.fireCooldownMs / powerMult;
      }
    }
  }

  // Shield (21) / Temporal Field (22) / Chain Lightning (23) / Gravity Core
  // (24) — each a genuinely different gameplay verb, not another "shoot at
  // nearest enemy" loop.
  _updateSpecialSupport(player, def, now, dt) {
    if (def.special === 'shield') {
      const sp = player.support;
      if (now - sp.lastDamagedAt >= def.shieldRegenDelayMs && sp.shieldHp < def.shieldMaxHp) {
        sp.shieldHp = Math.min(def.shieldMaxHp, sp.shieldHp + def.shieldRegenPerSec * dt);
      }
      return;
    }

    if (def.special === 'timeslow') {
      for (const other of this.players.values()) {
        if (!other.alive || this._sameTeam(player.id, other.id)) continue;
        const dx = other.x - player.x;
        const dz = other.z - player.z;
        if (dx * dx + dz * dz > def.radius * def.radius) continue;
        this._applySlow(other, def.slowMult, 350, 'field', now);
      }
      return;
    }

    if (def.special === 'lightning') {
      if (now < player.support.nextFireAt[0]) return;
      const first = this._findValidTarget(player.x, player.z, player.id, {
        range: def.range,
        requireLOS: true,
        preferHighestHp: true,
      });
      if (!first) return;
      player.support.nextFireAt[0] = now + def.boltCooldownMs;
      const points = [[player.x, player.z]];
      const hit = new Set([first.id]);
      let dmg = def.damage;
      let cur = first;
      for (let i = 0; i <= def.maxChainTargets; i++) {
        this._applyDamage({ ownerId: player.id }, cur, dmg, now);
        this._applySlow(cur, 0.3, def.stunMs, 'lightning', now);
        cur.debuffs.shocked.active = true;
        cur.debuffs.shocked.expiresAt = now + def.stunMs;
        points.push([cur.x, cur.z]);
        if (i === def.maxChainTargets) break;
        const next = this._findValidTarget(cur.x, cur.z, player.id, {
          range: def.chainRange,
          requireLOS: true,
          excludeIds: hit,
        });
        if (!next) break;
        hit.add(next.id);
        dmg *= def.chainDamageMult;
        cur = next;
      }
      this.events.push({ type: 'lightning', points });
      return;
    }

    if (def.special === 'gravity') {
      const anchor = player.support;
      for (const other of this.players.values()) {
        if (!other.alive || this._sameTeam(player.id, other.id)) continue;
        const dx = anchor.anchorX - other.x;
        const dz = anchor.anchorZ - other.z;
        const dist = Math.hypot(dx, dz);
        if (dist > def.radius || dist < 0.05) continue;
        const step = Math.min(dist, def.pullSpeed * dt);
        const nx = other.x + (dx / dist) * step;
        const nz = other.z + (dz / dist) * step;
        if (!isBlockedByObstacle(nx, other.z, TANK_RADIUS)) other.x = nx;
        if (!isBlockedByObstacle(other.x, nz, TANK_RADIUS)) other.z = nz;
        this._applySlow(other, def.slowMult, 350, 'gravity', now);
      }
    }
  }

  // Gravity Core's payoff (section 24): once the charge/pull phase (the
  // support's whole active duration) ends, release one controlled burst at
  // the anchor point — a plain falloff+LOS area hit, NOT a physics
  // explosion — then the support ends.
  _gravityBurst(player, def, now) {
    const anchor = player.support;
    this.events.push({ type: 'explosion', x: anchor.anchorX, z: anchor.anchorZ });
    for (const target of this.players.values()) {
      if (!target.alive || this._sameTeam(player.id, target.id)) continue;
      const dx = target.x - anchor.anchorX;
      const dz = target.z - anchor.anchorZ;
      const dist = Math.hypot(dx, dz);
      if (dist > def.burstRadius) continue;
      if (!this._hasLineOfSight(anchor.anchorX, anchor.anchorZ, target.x, target.z)) continue;
      const falloff = Math.max(SPLASH_FALLOFF_MIN, 1 - (dist / def.burstRadius) * (1 - SPLASH_FALLOFF_MIN));
      this._applyDamage({ ownerId: player.id }, target, def.burstDamage * falloff, now);
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
    this.pickups.set(id, { id, kind, x: point.x, z: point.z, droppedAt: now });
    this._lastPickupSpawnAt = now;
  }

  // Rarity-weighted pickup selection (section 3) for the periodic world
  // spawner: a pickup with no explicit `rarity` field defaults to 'common'.
  // Only runs once per ~6.5s spawn, so recomputing the weight table each
  // call is negligible.
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

  // Loot/drop system (section 28-29): rolls whether a kill drops anything at
  // all, best-quality-category-first, using the per-tier percentages in
  // DROP_TABLES — reads directly as "X% of kills drop an item of this
  // quality" rather than an opaque weight table. Reused for every tier via
  // data (bot tier name, or 'pvp' for a human-vs-human Arena kill) — never a
  // per-enemy-type branch of code.
  // `killer` (section 40): the Loot Luck upgrade + a small per-chapter
  // bonus both boost ONLY the better-than-normal categories, so campaign
  // progression and build choices make good drops meaningfully more
  // common WITHOUT ever making a common/normal drop impossible instead.
  _maybeDropLoot(victim, now, killer) {
    // Bosses always drop something rare-or-better (section 35's guaranteed
    // valuable reward) — everything else still rolls normally.
    if (victim.isBoss) {
      const kind = this._pickDropKind('rareSupport');
      if (kind && this.pickups.size < MAX_ACTIVE_PICKUPS + 3) {
        const id = nextPickupId++;
        this.pickups.set(id, { id, kind, x: victim.x, z: victim.z, droppedAt: now });
      }
      return;
    }
    const tierKey = victim.isBot ? victim.tierName || 'easy' : 'pvp';
    const table = DROP_TABLES[tierKey] || DROP_TABLES.pvp;
    const luckMult = (killer && killer.stats && killer.stats.lootLuckMult) || 1;
    const chapterMult = 1 + (Math.max(1, this.chapter) - 1) * 0.05;
    const bonusMult = luckMult * chapterMult;
    const roll = Math.random();
    let category = null;
    let acc = 0;
    const order = ['rareSupport', 'support', 'special', 'normal'];
    for (const cat of order) {
      const chance = cat === 'normal' ? table[cat] || 0 : (table[cat] || 0) * bonusMult;
      acc += chance;
      if (roll < acc) {
        category = cat;
        break;
      }
    }
    if (!category) return;

    const kind = this._pickDropKind(category);
    if (!kind) return;
    if (this.pickups.size >= MAX_ACTIVE_PICKUPS + 3) return; // hard safety cap (section 30)

    const id = nextPickupId++;
    this.pickups.set(id, { id, kind, x: victim.x, z: victim.z, droppedAt: now });
  }

  _pickDropKind(category) {
    const entries = Object.entries(PICKUP_TYPES).filter(([, def]) => {
      const isSupport = def.kind === 'support';
      const rarity = def.rarity || 'common';
      if (category === 'rareSupport') return isSupport && rarity !== 'common' && rarity !== 'uncommon';
      if (category === 'support') return isSupport && (rarity === 'common' || rarity === 'uncommon');
      if (category === 'special') return !isSupport && rarity !== 'common';
      if (category === 'normal') return !isSupport && rarity === 'common';
      return false;
    });
    if (entries.length === 0) return null;
    let total = 0;
    for (const [, def] of entries) total += PICKUP_RARITY_WEIGHT[def.rarity] || PICKUP_RARITY_WEIGHT.common;
    let roll = Math.random() * total;
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
    } else if (def.kind === 'ammo_refill') {
      // This game has no clip/ammo-count system (fire rate is purely
      // cooldown-based) — the honest equivalent of "found ammo" is an
      // instantly-ready next shot (section 2 item 1).
      player.lastFireTime = 0;
    } else if (def.kind === 'support') {
      const supportDef = SUPPORT_TYPES[def.support];
      // Picking up a second support crate simply replaces whatever was
      // active (fresh full duration, fresh cooldowns) rather than stacking
      // two at once — keeps "only one support weapon at a time" simple and
      // matches how the single `weapon` buff slot already works above.
      const durationMult = (player.stats && player.stats.supportDurationMult) || 1;
      player.support = {
        type: def.support,
        expiresAt: now + supportDef.durationMs * durationMult,
        nextFireAt: new Array(supportDef.modules || 1).fill(now),
        shieldHp: supportDef.special === 'shield' ? supportDef.shieldMaxHp : 0,
        lastDamagedAt: 0,
        anchorX: player.x,
        anchorZ: player.z,
      };
    }

    this.events.push({
      type: 'pickup',
      playerId: player.id,
      playerName: player.name,
      itemKind: def.kind,
      itemLabel: def.label,
      itemRarity: def.rarity || 'common',
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
        if (!player.isBot && (this.mode === 'arena' || this.mode === 'team') && now - player.deathTime >= RESPAWN_DELAY_MS) {
          const spawn = randomSpawn(player.team);
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

      const debuffs = player.debuffs;
      if (debuffs.slow.active && now >= debuffs.slow.expiresAt) {
        debuffs.slow.active = false;
        debuffs.slow.stacks = 0;
        debuffs.slow.mult = 1;
        debuffs.slow.source = null;
      }
      if (debuffs.shocked.active && now >= debuffs.shocked.expiresAt) debuffs.shocked.active = false;
      if (debuffs.freeze.active && now >= debuffs.freeze.expiresAt) debuffs.freeze.active = false;
      if (debuffs.corroded.active && now >= debuffs.corroded.expiresAt) {
        debuffs.corroded.active = false;
        debuffs.corroded.mult = 1;
      }
      if (debuffs.marked.active && now >= debuffs.marked.expiresAt) debuffs.marked.active = false;
      if (debuffs.staggered.active && now >= debuffs.staggered.expiresAt) debuffs.staggered.active = false;
      if (debuffs.burn.active) {
        if (now >= debuffs.burn.expiresAt) {
          debuffs.burn.active = false;
        } else if (now >= debuffs.burn.nextTickAt) {
          debuffs.burn.nextTickAt = now + debuffs.burn.tickMs;
          this._applyDamage({ ownerId: debuffs.burn.sourceId }, player, debuffs.burn.damage, now);
        }
      }
      if (!player.alive) continue; // a burn tick (or anything else above) may have just killed this player

      // Kill-streak decay (special upgrade) + passive out-of-combat health
      // regen (defense upgrade) — human players only, same reasoning as the
      // low-HP/kill-streak damage bonuses at fire time.
      if (!player.isBot) {
        if (player.killStreak > 0 && now >= player.killStreakExpiresAt) player.killStreak = 0;
        if (player.stats.healthRegenPerSec > 0 && player.hp < player.stats.maxHp && now - player.lastDamagedAt > 3000) {
          player.hp = Math.min(player.stats.maxHp, player.hp + player.stats.healthRegenPerSec * dt);
        }
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

      // ---- Sprint / Stamina (sections 1-6): human players only. Sprint
      // only actually engages while stamina remains AND the player is
      // actually trying to move — holding Shift while standing still
      // doesn't drain anything. Stops automatically at 0 and can't resume
      // until STAMINA_REGEN_DELAY_MS after the player stops holding it.
      let sprintMult = 1;
      if (!player.isBot) {
        const maxStamina = MAX_STAMINA + player.stats.maxStaminaBonus;
        const isMoving = moveForward !== 0 || moveRight !== 0;
        const wantsSprint = input.sprinting && isMoving && player.stamina > 0 && !debuffs.freeze.active;
        if (wantsSprint) {
          player.sprinting = true;
          const drain = STAMINA_DRAIN_PER_SEC * (1 - (player.stats.sprintDrainReductionMult || 0));
          player.stamina = Math.max(0, player.stamina - drain * dt);
          player.staminaRegenAt = now + STAMINA_REGEN_DELAY_MS;
          if (player.stamina <= 0) player.sprinting = false; // auto-stop the instant it's exhausted
        } else {
          player.sprinting = false;
          if (now >= player.staminaRegenAt && player.stamina < maxStamina) {
            const regen = STAMINA_REGEN_PER_SEC + (player.stats.staminaRegenBonus || 0);
            player.stamina = Math.min(maxStamina, player.stamina + regen * dt);
          }
        }
        if (player.sprinting) sprintMult = SPRINT_SPEED_MULT * (1 + (player.stats.sprintSpeedBonusMult || 0));
      }

      if (moveForward !== 0 || moveRight !== 0) {
        const fx = Math.sin(player.bodyRot);
        const fz = Math.cos(player.bodyRot);
        // -PI/2 (not +PI/2): with forward = (sin, cos), rotating by -90° is
        // the direction that actually reads as screen-right for our chase
        // camera (verified empirically — the other sign strafed backwards).
        const rx = Math.sin(player.bodyRot - Math.PI / 2);
        const rz = Math.cos(player.bodyRot - Math.PI / 2);

        // Freeze (cryo max-stack) roots movement entirely, then thaws back
        // to normal linearly — never a permanent freeze. Otherwise a plain
        // slow (shock/cryo/zone/field/gravity/suppression — whichever is
        // currently strongest, see _applySlow) multiplies speed as before.
        let speedMult = (player.buffs.speed.active ? SPEED_BOOST_MULT : 1) * sprintMult;
        if (player.isBot) {
          if (player.isElite && player.elite && now < player.elite.dashUntil) speedMult *= ELITE_DASH_SPEED_MULT;
          if (player.ai && now < player.ai.buffedUntil) speedMult *= ENEMY_ROLES.support.auraSpeedMult;
          if (player.isBoss && player.boss && player.boss.enraged) speedMult *= BOSS_ENRAGE_SPEED_MULT;
        }
        if (debuffs.freeze.active) {
          speedMult = 0;
        } else if (now < debuffs.freeze.thawUntil) {
          const thawT = 1 - (debuffs.freeze.thawUntil - now) / CRYO_THAW_MS;
          speedMult *= clamp(thawT, 0, 1);
        } else if (debuffs.slow.active) {
          speedMult *= debuffs.slow.mult;
        }

        const dx = (fx * moveForward + rx * moveRight) * player.stats.moveSpeed * speedMult * dt;
        const dz = (fz * moveForward + rz * moveRight) * player.stats.moveSpeed * speedMult * dt;

        const nx = clamp(player.x + dx, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
        if (!isBlockedByObstacle(nx, player.z, TANK_RADIUS)) player.x = nx;

        const nz = clamp(player.z + dz, -ARENA_HALF_SIZE + TANK_RADIUS, ARENA_HALF_SIZE - TANK_RADIUS);
        if (!isBlockedByObstacle(player.x, nz, TANK_RADIUS)) player.z = nz;
      }

      if (input.firing && !debuffs.shocked.active && !debuffs.freeze.active && !debuffs.staggered.active) {
        const weaponDef = WEAPON_TYPES[player.weapon.type] || WEAPON_TYPES.normal;
        const rapidMult = player.buffs.rapidfire.active ? RAPID_FIRE_MULT : 1;
        // Support role's aura (section 25) makes buffed nearby allies fire faster.
        const auraMult = player.isBot && player.ai && now < player.ai.buffedUntil ? ENEMY_ROLES.support.auraFireRateMult : 1;
        const cooldown = player.stats.fireCooldown * weaponDef.cooldownMult * rapidMult * auraMult;
        if (now - player.lastFireTime >= cooldown) {
          player.lastFireTime = now;
          this._fireWeapon(player, now);
        }
      }
    }

    this._updateSupportWeapons(now, dt);
    this._updateZones(now);
    this._ensureObjectiveState();
    this._updateWaves(now);

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
          if (!target.alive || this._sameTeam(bullet.ownerId, target.id)) continue;
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
          if (bullet.splashRadius > 0 || bullet.clusterCount > 0) detonateAt = { x: bullet.x, z: bullet.z };
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
          if (bullet.splashRadius > 0 || bullet.clusterCount > 0) detonateAt = { x: bullet.x, z: bullet.z };
          // A wall hit with no splash/cluster/bounces left just disappears.
        }
      }

      if (detonateAt) {
        if (bullet.splashRadius > 0) this._resolveSplash(bullet, detonateAt, now);
        if (bullet.clusterCount > 0) this._spawnClusterFragments(bullet, detonateAt, now);
        if (bullet.zoneKind) this._spawnZone(bullet, detonateAt, now);
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

    this._updateObjective(now);
  }

  // Lazily builds the objective's runtime state from stageDef.objective the
  // first time tick() runs — kept separate from the constructor so a
  // freshly-created Game (before its first tick) has a predictable
  // "nothing built yet" state other code can check against.
  _ensureObjectiveState() {
    if (this.objective || this.mode !== 'campaign' || !this.stageDef) return;
    const o = this.stageDef.objective;
    if (o.type === 'defend') {
      // A fixed point clear of the central obstacle ({x:0,z:0,w:10,d:4}).
      this.objective = { type: 'defend', maxHp: o.objectiveMaxHp, hp: o.objectiveMaxHp, x: 0, z: -9, alive: true };
    } else if (o.type === 'survive') {
      this.objective = { type: 'survive', durationS: o.durationS };
    } else {
      this.objective = { type: o.type };
    }
  }

  // Wave scheduler (section 23): never dumps every enemy at once. Spawns
  // wave 0 immediately, then the next wave only once every bot from the
  // current one is dead AND a short breather has passed. A SURVIVE stage
  // recycles its last wave indefinitely once the authored list is
  // exhausted, until the timer runs out; a boss stage spawns its boss (via
  // the SAME reusable addBot factory) once every regular wave is cleared.
  _updateWaves(now) {
    if (this.mode !== 'campaign' || !this.stageDef || this.finished) return;
    const waves = this.stageDef.waves;

    if (this.waveIndex === -1) {
      this._spawnWave(0, now);
      return;
    }

    const botsRemaining = Array.from(this.players.values()).some((p) => p.isBot && p.alive && !p.isBoss);
    if (botsRemaining || now < this.waveBreatherUntil) return;

    if (this.waveIndex < waves.length - 1) {
      this._spawnWave(this.waveIndex + 1, now);
    } else if (this.stageDef.boss && !this._bossSpawned) {
      this._spawnBoss(this.stageDef.boss, now);
    } else if (this.objective && this.objective.type === 'survive' && now - this.stageStartedAt < this.objective.durationS * 1000) {
      this._spawnWave(waves.length - 1, now);
    }
  }

  _spawnWave(idx, now) {
    const wave = this.stageDef.waves[idx];
    if (!wave) return;
    this.waveIndex = idx;
    this.waveBreatherUntil = now + 3500; // short breathing room before the NEXT wave (section 23)
    const isHunt = this.objective && this.objective.type === 'hunt';
    for (const spec of wave) {
      let isElite = false;
      if (isHunt) {
        if (!this.huntTargetId) isElite = true; // exactly one guaranteed elite for the whole stage
      } else {
        isElite = Math.random() < (this.stageDef.eliteChance || 0);
      }
      const bot = this.addBot(spec.tier, { role: spec.role, chapter: this.chapter, difficulty: this.difficulty, isElite });
      if (isHunt && isElite && !this.huntTargetId) this.huntTargetId = bot.id;
    }
  }

  _spawnBoss(bossDef, now) {
    this._bossSpawned = true;
    // A shared base tier ('hard') for every boss — bossStatMult already
    // scales HP/damage far beyond any normal tier, so the base tier picked
    // here is just a stat starting point, not a balance lever.
    this.addBot('hard', { role: 'normal', chapter: this.chapter, difficulty: this.difficulty, bossDef });
    this.events.push({ type: 'bossSpawn', name: bossDef.name });
  }

  // Section 22: per-objective-type win/fail resolution. Player death (the
  // human losing all HP) is already handled earlier in tick() regardless
  // of objective type — this only covers the OTHER ways a stage ends.
  _updateObjective(now) {
    if (this.mode !== 'campaign' || this.finished || !this.objective) return;
    const obj = this.objective;

    if (obj.type === 'defend' && obj.alive) {
      // Any living bot near the objective chips away at it — simple
      // proximity/tick pressure rather than routing a non-player entity
      // through the full bullet-collision pipeline.
      const SIEGE_RANGE = 16;
      for (const p of this.players.values()) {
        if (!p.isBot || !p.alive) continue;
        const dx = p.x - obj.x;
        const dz = p.z - obj.z;
        if (dx * dx + dz * dz > SIEGE_RANGE * SIEGE_RANGE) continue;
        obj.hp -= p.stats.damage * 0.1 * (TICK_MS / 1000);
      }
      if (obj.hp <= 0) {
        obj.hp = 0;
        obj.alive = false;
        this.finished = true;
        this.stageFailed = true;
        this.events.push({ type: 'stageFailed' });
        return;
      }
    }

    if (obj.type === 'survive') {
      if (now - this.stageStartedAt >= obj.durationS * 1000) this._clearStage();
      return;
    }

    const boss = this.bossId ? this.players.get(this.bossId) : null;
    const bossDone = !this.stageDef.boss || (this._bossSpawned && (!boss || !boss.alive));
    if (obj.type === 'boss') {
      if (bossDone) this._clearStage();
      return;
    }

    const noBotsLeft = !Array.from(this.players.values()).some((p) => p.isBot && p.alive);
    const wavesExhausted = this.waveIndex >= this.stageDef.waves.length - 1;

    if (obj.type === 'hunt') {
      const eliteTarget = this.huntTargetId ? this.players.get(this.huntTargetId) : null;
      const eliteDone = this.huntTargetId && (!eliteTarget || !eliteTarget.alive);
      if (eliteDone && noBotsLeft && wavesExhausted) this._clearStage();
      return;
    }

    // 'eliminate', and 'defend' once its siege has been survived through
    // every wave without the objective dying.
    if (noBotsLeft && wavesExhausted && bossDone) this._clearStage();
  }

  _clearStage() {
    if (this.finished) return;
    this.finished = true;
    this.stageCleared = true;
    const rewardMult = (DIFFICULTIES[this.difficulty] || DIFFICULTIES.normal).rewardMult;
    this.events.push({ type: 'stageClear', reward: Math.round(this.stageDef.reward * rewardMult) });
  }

  getStageStatus() {
    if (this.mode !== 'campaign') return null;
    const enemiesRemaining = Array.from(this.players.values()).filter((p) => p.isBot && p.alive && !p.isBoss).length;
    const boss = this.bossId ? this.players.get(this.bossId) : null;
    const rewardMult = (DIFFICULTIES[this.difficulty] || DIFFICULTIES.normal).rewardMult;
    return {
      stageId: this.stageDef.id,
      stageName: this.stageDef.name,
      chapter: this.chapter,
      // Server-computed "what comes next" (bug-fix: the client used to do
      // its own `stageId + 1` arithmetic — that math was never actually
      // wrong in this flat-integer id scheme, but having the CLIENT derive
      // progression at all is exactly the kind of "two systems computing
      // the same thing independently" section 27 warns can drift out of
      // sync; null once this is genuinely the last stage in the campaign.
      nextStageId: this.stageDef.id < STAGES.length ? this.stageDef.id + 1 : null,
      isLastStage: this.stageDef.id >= STAGES.length,
      enemiesRemaining,
      finished: this.finished,
      cleared: this.stageCleared,
      failed: this.stageFailed,
      reward: this.stageCleared ? Math.round(this.stageDef.reward * rewardMult) : 0,
      objective: this.objective
        ? {
            type: this.objective.type,
            durationS: this.objective.durationS || 0,
            elapsedS: this.objective.type === 'survive' ? Math.floor((Date.now() - this.stageStartedAt) / 1000) : 0,
            objectiveHp: this.objective.hp || 0,
            objectiveMaxHp: this.objective.maxHp || 0,
            huntTargetId: this.huntTargetId,
          }
        : null,
      boss: boss
        ? {
            id: boss.id,
            name: boss.boss.def.name,
            hp: boss.hp,
            maxHp: boss.stats.maxHp,
            phase: boss.boss.phase,
            enraged: boss.boss.enraged,
            invuln: Date.now() < boss.boss.invulnUntil,
          }
        : null,
    };
  }

  snapshot() {
    const now = Date.now();
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
        team: p.team || null,
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
        freezeActive: p.debuffs.freeze.active || now < p.debuffs.freeze.thawUntil,
        corrodedActive: p.debuffs.corroded.active,
        markedActive: p.debuffs.marked.active,
        burnActive: p.debuffs.burn.active,
        staggeredActive: p.debuffs.staggered.active,
        supportType: p.support ? p.support.type : null,
        supportExpiresAt: p.support ? p.support.expiresAt : 0,
        shieldHp: p.support && p.support.type === 'shield' ? Math.round(p.support.shieldHp) : 0,
        shieldMaxHp: p.support && p.support.type === 'shield' ? SUPPORT_TYPES.shield.shieldMaxHp : 0,
        // ---- Sprint/stamina (human only) ----
        stamina: p.isBot ? 0 : Math.round(p.stamina),
        maxStamina: p.isBot ? 0 : Math.round(MAX_STAMINA + p.stats.maxStaminaBonus),
        sprinting: !!p.sprinting,
        // ---- Enemy roles / elites / bosses (sections 25-27) ----
        role: p.isBot ? p.role : null,
        isElite: !!p.isElite,
        isBoss: !!p.isBoss,
        bossPhase: p.isBoss && p.boss ? p.boss.phase : 0,
        bossEnraged: p.isBoss && p.boss ? p.boss.enraged : false,
        bossInvuln: p.isBoss && p.boss ? now < p.boss.invulnUntil : false,
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
        isExecution: !!b.isExecution,
      })),
      pickups: Array.from(this.pickups.values()).map((pk) => ({
        id: pk.id,
        kind: pk.kind,
        x: pk.x,
        z: pk.z,
        droppedAt: pk.droppedAt || 0,
      })),
      zones: Array.from(this.zones.values())
        .map((z) => ({ id: 'zone-' + z.id, kind: z.kind, x: z.x, z: z.z, radius: z.radius, expiresAt: z.expiresAt }))
        // A gravity core isn't tracked in `this.zones` (its gameplay pull/
        // burst is driven directly off player.support, see
        // _updateSpecialSupport) — this synthetic entry exists purely so
        // the client can render the anomaly at its anchor without
        // hardcoding SUPPORT_TYPES.gravity.radius as a second, separately
        // maintained copy of a server-authoritative number.
        .concat(
          Array.from(this.players.values())
            .filter((p) => p.support && p.support.type === 'gravity')
            .map((p) => ({
              id: 'gravity-' + p.id,
              kind: 'gravity',
              x: p.support.anchorX,
              z: p.support.anchorZ,
              radius: SUPPORT_TYPES.gravity.radius,
              expiresAt: p.support.expiresAt,
            }))
        ),
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
