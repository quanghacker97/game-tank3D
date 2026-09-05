'use strict';

// Shared game-balance / world constants used by the server (and echoed to
// clients via the 'init' event so rendering matches simulation).

const TICK_RATE = 20; // physics/network ticks per second
const TICK_MS = 1000 / TICK_RATE;

const ARENA_HALF_SIZE = 75; // world spans [-75, 75] on X and Z — a 25% wider
// arena than the original [-60,60] (see OBSTACLES below for the richer,
// mirror-symmetric terrain that fills the extra space).

// Tank meshes render at 0.4x their original modeled size (see
// createTankMesh's tankGroup.scale in client.js) — the hitbox shrinks with
// them so it still matches the visible silhouette.
const TANK_RADIUS = 0.92;

const RESPAWN_DELAY_MS = 3000;

const BULLET_RADIUS = 0.4;
const BULLET_SPEED = 70; // units/sec
const BULLET_LIFETIME_MS = 2200;

// Static cover boxes. Shared with the client for rendering (client.js's
// buildObstacles renders each `type` with a distinct look) and used
// server-side for tank/bullet collision (AABB, `type` is cosmetic only).
// Kept 4-fold mirror-symmetric (x -> -x, z -> -z) so neither side of the
// arena — including the two Team Deathmatch spawn ends — has a cover
// advantage.
const OBSTACLES = [
  // Corner crate clusters (original 4, moved outward for the bigger arena).
  { x: -25, z: -25, w: 8, d: 8, h: 4, type: 'crate' },
  { x: 25, z: -25, w: 8, d: 8, h: 4, type: 'crate' },
  { x: -25, z: 25, w: 8, d: 8, h: 4, type: 'crate' },
  { x: 25, z: 25, w: 8, d: 8, h: 4, type: 'crate' },
  // Central bunker pair with a lane between them (was a single small box).
  { x: 0, z: -8, w: 10, d: 4, h: 5, type: 'bunker' },
  { x: 0, z: 8, w: 10, d: 4, h: 5, type: 'bunker' },
  // Extra crate cover flanking the vertical mid-lane.
  { x: 0, z: -38, w: 8, d: 8, h: 4, type: 'crate' },
  { x: 0, z: 38, w: 8, d: 8, h: 4, type: 'crate' },
  // Long outer walls (original 4, moved outward).
  { x: -47, z: 0, w: 4, d: 18, h: 4, type: 'wall' },
  { x: 47, z: 0, w: 4, d: 18, h: 4, type: 'wall' },
  { x: 0, z: -53, w: 18, d: 4, h: 4, type: 'wall' },
  { x: 0, z: 53, w: 18, d: 4, h: 4, type: 'wall' },
  // Mid-field watchtowers (8-fold symmetric ring) — break up long sightlines
  // across the wider arena without blocking any single lane completely.
  { x: 38, z: 14, w: 3, d: 3, h: 8, type: 'tower' },
  { x: -38, z: 14, w: 3, d: 3, h: 8, type: 'tower' },
  { x: 38, z: -14, w: 3, d: 3, h: 8, type: 'tower' },
  { x: -38, z: -14, w: 3, d: 3, h: 8, type: 'tower' },
  { x: 14, z: 38, w: 3, d: 3, h: 8, type: 'tower' },
  { x: -14, z: 38, w: 3, d: 3, h: 8, type: 'tower' },
  { x: 14, z: -38, w: 3, d: 3, h: 8, type: 'tower' },
  { x: -14, z: -38, w: 3, d: 3, h: 8, type: 'tower' },
];

// Kept at least ~15 units clear of the boundary wall (at ±ARENA_HALF_SIZE):
// a freshly-spawned tank faces straight toward the arena center, and the
// third-person chase camera sits ~10.5 units BEHIND that facing (see
// client.js's updateCamera: CAM_DIST * cos(camPitch)) — too little margin
// here puts the camera inside the boundary wall for the first instant after
// spawning/respawning.
const SPAWN_POINTS = [
  { x: -58, z: -58 },
  { x: 58, z: -58 },
  { x: -58, z: 58 },
  { x: 58, z: 58 },
  { x: 0, z: -60 },
  { x: 0, z: 60 },
  { x: -60, z: 0 },
  { x: 60, z: 0 },
];

// Team Deathmatch (section: team mode) spawns each side along one edge of
// the arena, facing the opposite side, well clear of every OBSTACLES entry
// above AND (see SPAWN_POINTS' comment) far enough from the boundary wall
// that the spawn-facing chase camera doesn't clip into it.
const TEAM_SPAWN_POINTS = {
  red: [
    { x: -60, z: -60 },
    { x: -30, z: -60 },
    { x: 0, z: -60 },
    { x: 30, z: -60 },
    { x: 60, z: -60 },
  ],
  blue: [
    { x: -60, z: 60 },
    { x: -30, z: 60 },
    { x: 0, z: 60 },
    { x: 30, z: 60 },
    { x: 60, z: 60 },
  ],
};

const PLAYER_COLORS = [
  0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f,
  0x9b59b6, 0x1abc9c, 0xe67e22, 0xecf0f1,
];

// Team Deathmatch tank colors — every player on a side renders in the same
// color instead of PLAYER_COLORS' per-player round robin, so teammates are
// instantly recognizable at a glance.
const TEAM_COLORS = { red: 0xe74c3c, blue: 0x3498db };

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
// Expanded progression catalog (25 nodes across 6 categories). The 4
// legacy tracks above (power/defense/agilityMove/rate) are folded in
// UNCHANGED — same arrays, same costs — so an existing save's spent
// currency/levels stay exactly as valuable as before; every other node is
// purely additive on top of them. `mode: 'absolute'` means the level's
// value REPLACES the base stat (the 4 legacy tracks); `mode: 'bonus'`
// means level 0 is a no-op and every level ADDS the listed amount (levels
// array already contains the running total at each level, not the delta,
// so Game.js never needs to sum deltas itself).
// ---------------------------------------------------------------------
function bonusLevels(base, perLevel, maxLevel) {
  const arr = [base];
  for (let i = 1; i <= maxLevel; i++) arr.push(Math.round((base + perLevel * i) * 1000) / 1000);
  return arr;
}
function costCurve(maxLevel, baseCost, growth) {
  const arr = [];
  let c = baseCost;
  for (let i = 0; i < maxLevel; i++) {
    arr.push(Math.round(c));
    c *= growth;
  }
  return arr;
}

const UPGRADE_CATALOG = [
  // ---- OFFENSE ----
  { id: 'power', category: 'offense', icon: '⚔️', label: 'Sức Mạnh', unit: 'sát thương', mode: 'absolute', maxLevel: 5, costs: UPGRADE_COST, levels: UPGRADES.power },
  { id: 'critChance', category: 'offense', icon: '🎯', label: 'Tỉ Lệ Chí Mạng', unit: '% chí mạng', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 80, 1.6), levels: bonusLevels(0, 0.03, 5) },
  { id: 'critDamage', category: 'offense', icon: '💥', label: 'Sát Thương Chí Mạng', unit: 'x sát thương chí mạng', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 100, 1.6), levels: bonusLevels(1.5, 0.15, 5) },
  { id: 'armorPen', category: 'offense', icon: '🗡️', label: 'Xuyên Giáp', unit: '% bỏ qua giáp địch', mode: 'bonus', maxLevel: 4, costs: costCurve(4, 90, 1.7), levels: bonusLevels(0, 0.15, 4) },
  { id: 'elementalDamage', category: 'offense', icon: '🔥', label: 'Sát Thương Nguyên Tố', unit: 'x sát thương đạn đặc biệt', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 90, 1.6), levels: bonusLevels(1, 0.08, 5) },
  // ---- DEFENSE ----
  { id: 'defense', category: 'defense', icon: '🛡️', label: 'Giáp Trụ', unit: 'máu tối đa', mode: 'absolute', maxLevel: 5, costs: UPGRADE_COST, levels: UPGRADES.defense },
  { id: 'damageReduction', category: 'defense', icon: '🛡️', label: 'Giảm Sát Thương', unit: '% giảm sát thương nhận', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 100, 1.6), levels: bonusLevels(0, 0.03, 5) },
  { id: 'healthRegen', category: 'defense', icon: '➕', label: 'Hồi Máu', unit: 'máu/giây', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 70, 1.6), levels: bonusLevels(0, 0.6, 5) },
  { id: 'elementalResist', category: 'defense', icon: '❄️', label: 'Kháng Nguyên Tố', unit: '% giảm hiệu ứng khống chế nhận vào', mode: 'bonus', maxLevel: 4, costs: costCurve(4, 90, 1.7), levels: bonusLevels(0, 0.1, 4) },
  // ---- MOBILITY ----
  { id: 'agility', category: 'mobility', icon: '💨', label: 'Nhanh Nhẹn', unit: 'm/s', mode: 'absolute', maxLevel: 5, costs: UPGRADE_COST, levels: UPGRADES.agilityMove },
  { id: 'sprintSpeed', category: 'mobility', icon: '🏃', label: 'Tốc Độ Chạy Nước Rút', unit: '% tốc độ chạy nước rút', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 70, 1.5), levels: bonusLevels(0, 0.06, 5) },
  { id: 'maxStamina', category: 'mobility', icon: '🔋', label: 'Thể Lực Tối Đa', unit: 'điểm thể lực', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 60, 1.5), levels: bonusLevels(0, 15, 5) },
  { id: 'staminaRegen', category: 'mobility', icon: '♻️', label: 'Hồi Thể Lực', unit: 'điểm/giây', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 60, 1.5), levels: bonusLevels(0, 3, 5) },
  { id: 'sprintEfficiency', category: 'mobility', icon: '🌀', label: 'Hiệu Suất Chạy', unit: '% giảm tiêu hao thể lực', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 70, 1.6), levels: bonusLevels(0, 0.08, 5) },
  // ---- WEAPON ----
  { id: 'rate', category: 'weapon', icon: '🔫', label: 'Tốc Độ Bắn', unit: 'ms hồi chiêu (thấp hơn = nhanh hơn)', mode: 'absolute', maxLevel: 5, costs: UPGRADE_COST, levels: UPGRADES.rate },
  { id: 'projectileSpeed', category: 'weapon', icon: '➡️', label: 'Tốc Độ Đạn', unit: 'x tốc độ đạn', mode: 'bonus', maxLevel: 4, costs: costCurve(4, 60, 1.5), levels: bonusLevels(1, 0.05, 4) },
  { id: 'projectilePierce', category: 'weapon', icon: '🔱', label: 'Xuyên Mục Tiêu', unit: '+số mục tiêu xuyên qua', mode: 'bonus', maxLevel: 3, costs: costCurve(3, 150, 2.0), levels: bonusLevels(0, 1, 3) },
  { id: 'explosionRadius', category: 'weapon', icon: '💣', label: 'Bán Kính Nổ', unit: 'x bán kính nổ', mode: 'bonus', maxLevel: 4, costs: costCurve(4, 80, 1.6), levels: bonusLevels(1, 0.1, 4) },
  { id: 'statusDuration', category: 'weapon', icon: '⏱️', label: 'Thời Gian Hiệu Ứng', unit: 'x thời lượng hiệu ứng', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 80, 1.6), levels: bonusLevels(1, 0.1, 5) },
  // ---- SPECIAL ----
  { id: 'onKillHeal', category: 'special', icon: '🩸', label: 'Hồi Máu Khi Hạ Địch', unit: '% máu tối đa/lần hạ', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 90, 1.6), levels: bonusLevels(0, 0.02, 5) },
  { id: 'killStreakDamage', category: 'special', icon: '🔗', label: 'Sát Thương Chuỗi Giết', unit: '% sát thương/stack (tối đa 5 stack)', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 100, 1.6), levels: bonusLevels(0, 0.02, 5) },
  { id: 'lowHpDamageBonus', category: 'special', icon: '😤', label: 'Cuồng Nộ Máu Thấp', unit: '% sát thương khi máu <30%', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 90, 1.6), levels: bonusLevels(0, 0.06, 5) },
  { id: 'lootLuck', category: 'special', icon: '🍀', label: 'May Mắn Chiến Lợi Phẩm', unit: 'x tỉ lệ rơi đồ hiếm', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 100, 1.7), levels: bonusLevels(1, 0.15, 5) },
  // ---- UTILITY ----
  { id: 'supportDuration', category: 'utility', icon: '⏳', label: 'Thời Lượng Hỗ Trợ', unit: 'x thời lượng vũ khí hỗ trợ', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 80, 1.6), levels: bonusLevels(1, 0.1, 5) },
  { id: 'supportPower', category: 'utility', icon: '🚀', label: 'Sức Mạnh Hỗ Trợ', unit: 'x sát thương & tốc độ bắn vũ khí hỗ trợ', mode: 'bonus', maxLevel: 5, costs: costCurve(5, 90, 1.6), levels: bonusLevels(1, 0.08, 5) },
];

const UPGRADE_CATEGORIES = ['offense', 'defense', 'mobility', 'weapon', 'special', 'utility'];

// ---------------------------------------------------------------------
// Sprint / stamina (section 1-6).
// ---------------------------------------------------------------------
const SPRINT_SPEED_MULT = 1.55; // base sprint speed multiplier (before the sprintSpeed upgrade's own bonus)
const MAX_STAMINA = 100; // before the maxStamina upgrade's bonus
const STAMINA_DRAIN_PER_SEC = 26;
const STAMINA_REGEN_PER_SEC = 20;
const STAMINA_REGEN_DELAY_MS = 700; // must stop sprinting this long before regen kicks back in

// ---------------------------------------------------------------------
// Post-stage permanent perk picks (section 15-17, 39): free (no currency),
// offered as 1-of-3 after clearing ANY stage, small permanent bonuses laid
// on top of the currency-bought Garage above. Client sends stack COUNTS in
// the loadout (like upgrade levels) — the server clamps each to its own
// maxStacks and looks up the bonus from ITS OWN table below, so a tampered
// client can never claim more than a legitimately-earned perk stack is
// actually worth.
// ---------------------------------------------------------------------
const PERK_POOL = [
  { id: 'overcharge', label: 'QUÁ TẢI', icon: '⚔️', rarity: 'common', desc: '+4% sát thương vũ khí', maxStacks: 5, statKey: 'damageMult', perStack: 0.04 },
  { id: 'reinforced', label: 'GIÁP GIA CỐ', icon: '🛡️', rarity: 'common', desc: '+6% máu tối đa', maxStacks: 5, statKey: 'hpMult', perStack: 0.06 },
  { id: 'overdrive', label: 'TĂNG TỐC HỒI', icon: '⚡', rarity: 'uncommon', desc: '+15% hồi thể lực', maxStacks: 4, statKey: 'staminaRegenMult', perStack: 0.15 },
  { id: 'swiftboots', label: 'GIÀY THẦN TỐC', icon: '👢', rarity: 'uncommon', desc: '+5% tốc độ di chuyển', maxStacks: 4, statKey: 'moveSpeedMult', perStack: 0.05 },
  { id: 'vampiric', label: 'HÚT MÁU', icon: '🩸', rarity: 'rare', desc: '+2% hồi máu khi hạ địch', maxStacks: 3, statKey: 'onKillHealFlat', perStack: 0.02 },
  { id: 'quickcharge', label: 'NẠP NHANH', icon: '🔃', rarity: 'rare', desc: '-6% thời gian hồi chiêu', maxStacks: 3, statKey: 'cooldownMult', perStack: -0.06 },
  { id: 'juggernaut', label: 'BẤT KHUẤT', icon: '💪', rarity: 'epic', desc: '+5% giảm sát thương nhận vào', maxStacks: 2, statKey: 'damageReductionFlat', perStack: 0.05 },
  { id: 'sharpshooter', label: 'THIỆN XẠ', icon: '🎯', rarity: 'epic', desc: '+8% tỉ lệ chí mạng', maxStacks: 2, statKey: 'critChanceFlat', perStack: 0.08 },
  { id: 'ascendant', label: 'SIÊU VIỆT', icon: '🌟', rarity: 'legendary', desc: '+20% sát thương & +20% thể lực tối đa', maxStacks: 1, statKey: 'legendaryOffense', perStack: 1 },
  { id: 'phoenix', label: 'PHƯỢNG HOÀNG', icon: '🔥', rarity: 'legendary', desc: '+20% máu tối đa & hồi 2 máu/giây', maxStacks: 1, statKey: 'legendaryDefense', perStack: 1 },
];
const PERK_RARITY_WEIGHT = { common: 100, uncommon: 42, rare: 16, epic: 6, legendary: 2 };

// ---------------------------------------------------------------------
// Campaign difficulty (section 38) — an ADDITIVE modifier layered on top
// of the per-chapter enemy scaling below, never a replacement for it.
// ---------------------------------------------------------------------
const DIFFICULTIES = {
  normal: { label: 'Thường', hpMult: 1, dmgMult: 1, speedMult: 1, aggroMult: 1, eliteChanceMult: 1, rewardMult: 1 },
  hard: { label: 'Khó', hpMult: 1.2, dmgMult: 1.15, speedMult: 1.05, aggroMult: 1.15, eliteChanceMult: 1.3, rewardMult: 1.2 },
  veryhard: { label: 'Rất Khó', hpMult: 1.45, dmgMult: 1.3, speedMult: 1.1, aggroMult: 1.3, eliteChanceMult: 1.6, rewardMult: 1.45 },
  nightmare: { label: 'Ác Mộng', hpMult: 1.8, dmgMult: 1.5, speedMult: 1.18, aggroMult: 1.5, eliteChanceMult: 2.2, rewardMult: 1.8 },
};

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

// ---------------------------------------------------------------------
// Enemy roles (section 25): behavioral deltas layered ON TOP of a base
// BOT_TIERS entry — a role changes HOW a bot fights (see Game.js's
// _updateBotAI branch on `behavior`), not just its raw numbers, so
// "Ranged" genuinely plays differently from "Melee" rather than just
// having a bigger/smaller number. `hpMult`/`dmgMult` default to 1 when
// omitted. Not every role is introduced from chapter 1 — see
// ROLE_UNLOCK_CHAPTER below (section 25's "gradually teach the player").
// ---------------------------------------------------------------------
const ENEMY_ROLES = {
  normal: { label: 'Lính', behavior: 'standard' },
  melee: { label: 'Cảm Tử Cận Chiến', behavior: 'melee', engageMult: 0.32, moveMult: 1.3, fireMult: 1.35 },
  ranged: { label: 'Xạ Thủ', behavior: 'kiting', engageMult: 1.5, moveMult: 0.85, fireMult: 0.9 },
  tank: { label: 'Xe Tăng Hạng Nặng', behavior: 'standard', engageMult: 0.85, moveMult: 0.6, fireMult: 0.7, hpMult: 1.9, dmgMult: 1.25 },
  sniper: { label: 'Bắn Tỉa', behavior: 'sniper', engageMult: 2.2, moveMult: 0.5, fireMult: 0.32, dmgMult: 2.3 },
  assault: { label: 'Đột Kích', behavior: 'aggressive', engageMult: 1.05, moveMult: 1.45, fireMult: 1.55 },
  summoner: { label: 'Triệu Hồi', behavior: 'summoner', engageMult: 1.3, moveMult: 0.8, fireMult: 0.6, summonEveryMs: 9000 },
  explosive: { label: 'Tự Sát Nổ', behavior: 'suicide', engageMult: 0.22, moveMult: 1.6, fireMult: 0, explodeRadius: 6, explodeDamageMult: 3.2 },
  hunter: { label: 'Săn Lùng', behavior: 'flank', engageMult: 1.0, moveMult: 1.2, fireMult: 1.0 },
  support: { label: 'Chi Viện', behavior: 'buffAura', engageMult: 1.2, moveMult: 0.8, fireMult: 0.65, auraRadius: 14, auraFireRateMult: 0.8, auraSpeedMult: 1.15 },
  shield: { label: 'Vệ Binh Khiên', behavior: 'standard', engageMult: 1.0, moveMult: 0.85, hpMult: 1.2, damageReduction: 0.4 },
};
// Chapter at which each new role first becomes eligible to spawn (section
// 25's "gradually teach the player" — chapter 1 only ever sees `normal`).
const ROLE_UNLOCK_CHAPTER = {
  normal: 1,
  melee: 1,
  ranged: 2,
  tank: 3,
  hunter: 4,
  sniper: 6,
  assault: 4,
  support: 7,
  explosive: 5,
  shield: 3,
  summoner: 8,
};

// ---------------------------------------------------------------------
// Elite enemies (section 26): a rolled-up multiplier + one random ability
// from this pool, applied on top of whatever base tier/role the elite
// otherwise is. Kept small and readable rather than stacking many at once.
// ---------------------------------------------------------------------
const ELITE_HP_MULT = 2.4;
const ELITE_DMG_MULT = 1.5;
const ELITE_ABILITIES = ['dash', 'shieldPulse', 'regen'];
const ELITE_DASH_COOLDOWN_MS = 4500;
const ELITE_DASH_SPEED_MULT = 3.2;
const ELITE_DASH_DURATION_MS = 500;
const ELITE_SHIELD_DURATION_MS = 2500;
const ELITE_SHIELD_COOLDOWN_MS = 9000;
const ELITE_SHIELD_REDUCTION = 0.6;
const ELITE_REGEN_PER_SEC_PCT = 0.02; // % of max HP per second

// ---------------------------------------------------------------------
// Chapter-based enemy scaling (section 19/24) — a smooth formula across
// all 10 chapters (auditable, not 10 hand-typed magic numbers), covering
// far more than HP: damage, speed, aim tightness (via turnSpeed), elite
// frequency, and how many extra bots a wave gets at higher chapters.
// ---------------------------------------------------------------------
function chapterScaling(chapter) {
  const t = clampChapter(chapter);
  const p = (t - 1) / 9; // 0 at chapter 1, 1 at chapter 10
  return {
    hpMult: 1 + p * 2.6,
    dmgMult: 1 + p * 1.5,
    speedMult: 1 + p * 0.35,
    turnSpeedMult: 1 + p * 0.5, // tighter aim/tracking at higher chapters
    eliteChance: 0.03 + p * 0.27,
    extraWaveBots: Math.floor(p * 3), // 0..3 extra bots per wave at higher chapters
  };
}
function clampChapter(c) {
  const n = Math.round(Number(c));
  return Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : 1;
}

// ---------------------------------------------------------------------
// Boss framework (section 27-34): ONE reusable engine (see Game.js's
// _updateBossAI) driven entirely by data — a boss is a specialized bot
// whose attack pattern is a small pool of shared, fully-telegraphed
// special attacks (never "shoots normal bullets"). Every attack has a
// telegraphMs warning window BEFORE it executes (section 31) so it's
// always avoidable if the player reacts.
// ---------------------------------------------------------------------
// telegraphMs floors (section 4's suggested reaction windows): >=800ms for
// a normal attack, >=1200ms for a strong one. `dash` (700) and
// `bulletStorm` (800, right at the floor) were bumped up — a charge that
// also repositions the boss needs more warning than a stationary attack.
const BOSS_ATTACKS = {
  missileBarrage: { label: 'Mưa Tên Lửa', telegraphMs: 900, cooldownMs: 6200, count: 5, damageMult: 0.6, warnRadius: 5 },
  laserBeam: { label: 'Tia Laser', telegraphMs: 1500, cooldownMs: 7500, damageMult: 2.0, width: 2.4, range: 60 },
  groundSlam: { label: 'Đập Đất', telegraphMs: 1100, cooldownMs: 6500, radius: 15, damageMult: 1.3, knockback: 9 },
  summon: { label: 'Triệu Hồi', telegraphMs: 1000, cooldownMs: 13000, count: 2 },
  dash: { label: 'Lao Thẳng', telegraphMs: 1000, cooldownMs: 5500, damageMult: 1.5, radius: 4.5 },
  bulletStorm: { label: 'Bão Đạn', telegraphMs: 950, cooldownMs: 7500, count: 14, damageMult: 0.32, warnRadius: 20 },
  teleportStrike: { label: 'Dịch Chuyển Tấn Công', telegraphMs: 1100, cooldownMs: 9000, damageMult: 1.6, radius: 6 },
};

const BOSS_PHASE_THRESHOLDS = [0.75, 0.5, 0.25]; // HP% at which the boss advances a phase
const BOSS_TRANSITION_INVULN_MS = 1200;
const BOSS_ENRAGE_HP_PCT = 0.18;
const BOSS_ENRAGE_COOLDOWN_MULT = 0.65; // attacks recharge faster while enraged
const BOSS_ENRAGE_SPEED_MULT = 1.25;

// hpMult/dmgMult below are relative to a same-chapter 'hard'-tier normal
// enemy (BOT_TIERS.hard, AFTER chapterScaling is applied) — a smooth
// formula (12 + chapter*1.8 HP, 1.3 + chapter*0.09 damage), not 10
// hand-tuned sponge numbers, kept explicit per-boss only for name/color/
// attack-pool/enrage — exactly the "reusable architecture with different
// attack patterns, stats, VFX" the brief itself allows when unique art
// isn't available (section 28).
function bossStatMult(chapter) {
  return { hpMult: 12 + chapter * 1.8, dmgMult: 1.3 + chapter * 0.09 };
}

const BOSS_DEFS = [
  { id: 'boss_ch1', chapter: 1, name: 'Chỉ Huy Đột Kích', color: 0xff5c3d, scale: 1.5, attacks: ['dash', 'bulletStorm'] },
  { id: 'boss_ch2', chapter: 2, name: 'Xe Tăng Cơ Giới', color: 0x8a8a8a, scale: 1.65, attacks: ['groundSlam', 'bulletStorm', 'missileBarrage'] },
  { id: 'boss_ch3', chapter: 3, name: 'Tư Lệnh Thiết Giáp', color: 0x3d5cff, scale: 1.6, attacks: ['groundSlam', 'dash', 'summon'] },
  { id: 'boss_ch4', chapter: 4, name: 'Thợ Săn Bóng Đêm', color: 0x2a2a3a, scale: 1.55, attacks: ['dash', 'teleportStrike', 'bulletStorm'] },
  { id: 'boss_ch5', chapter: 5, name: 'Quái Thú Biến Dị', color: 0x6b2fa0, scale: 1.75, attacks: ['dash', 'groundSlam', 'summon'] },
  { id: 'boss_ch6', chapter: 6, name: 'Kẻ Hủy Diệt Tầm Xa', color: 0xd9a441, scale: 1.6, attacks: ['laserBeam', 'missileBarrage', 'teleportStrike'] },
  { id: 'boss_ch7', chapter: 7, name: 'Cỗ Máy Thử Nghiệm', color: 0x35e6ff, scale: 1.7, attacks: ['laserBeam', 'groundSlam', 'summon', 'bulletStorm'] },
  { id: 'boss_ch8', chapter: 8, name: 'Chúa Tể Bầy Đàn', color: 0x3ddc6c, scale: 1.8, attacks: ['summon', 'bulletStorm', 'groundSlam'] },
  { id: 'boss_ch9', chapter: 9, name: 'Cỗ Máy Chiến Tranh', color: 0xff4d4d, scale: 1.9, attacks: ['missileBarrage', 'laserBeam', 'groundSlam', 'dash'] },
  {
    id: 'boss_ch10',
    chapter: 10,
    name: 'HỦY DIỆT TỐI THƯỢNG',
    color: 0x1a1a2e,
    scale: 2.2,
    isFinal: true,
    attacks: ['missileBarrage', 'laserBeam', 'groundSlam', 'summon', 'dash', 'bulletStorm', 'teleportStrike'],
  },
];

// ---------------------------------------------------------------------
// Weapons ("nhiều loại đạn hình thái khác nhau"). "normal" is the base
// cannon every tank starts with; the other four are temporary pickups.
// Multipliers apply on top of the player's own loadout damage/cooldown
// (from UPGRADES) so equipment upgrades still matter while a special
// weapon is active.
// ---------------------------------------------------------------------

const WEAPON_TYPES = {
  normal: {
    label: 'Pháo thường',
    bulletSpeed: 70,
    damageMult: 1,
    cooldownMult: 1,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 0,
    color: 0xffcc33,
  },
  laser: {
    label: 'Tia laser',
    bulletSpeed: 200,
    damageMult: 0.45,
    cooldownMult: 0.32,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 0,
    color: 0x35e6ff,
  },
  sniper: {
    label: 'Đạn tỉa',
    bulletSpeed: 260,
    damageMult: 2.6,
    cooldownMult: 2.6,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 0,
    color: 0xfff066,
  },
  spread: {
    label: 'Đạn tỏa 3 viên',
    bulletSpeed: 65,
    damageMult: 0.5,
    cooldownMult: 1.3,
    bulletsPerShot: 3,
    spreadAngle: 0.22, // radians between adjacent pellets
    splashRadius: 0,
    color: 0xff8a3d,
  },
  explosive: {
    label: 'Đạn nổ',
    bulletSpeed: 42,
    damageMult: 1.15,
    cooldownMult: 1.9,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 4.5,
    splashDamageMult: 0.6,
    color: 0xff4d4d,
    knockback: 5.5, // max push distance (units) at the blast center, falls off with distance like damage
  },
  // ---- New ammo types -----------------------------------------------
  ap: {
    label: 'Xuyên giáp (AP)',
    bulletSpeed: 150,
    damageMult: 0.85,
    cooldownMult: 1.5,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 0,
    color: 0xd8d8d8,
    pierceCount: 2, // can pass through this many enemies before disappearing
    pierceDamageFalloff: 0.7, // each successive hit deals (prev * this) damage
  },
  shock: {
    label: 'Đạn điện (Shock)',
    bulletSpeed: 95,
    damageMult: 0.7,
    cooldownMult: 1.5,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 0,
    color: 0x63d2ff,
    shockRadius: 6,
    shockSlowMult: 0.5, // victim moves at 50% speed
    shockDurationMs: 2000,
    shockDisableFireMs: 1200, // victim's own weapon is disabled for this long
    chainMaxTargets: 4, // primary hit + up to this many extra nearby enemies get the WEAKER chain effect
    chainSlowMult: 0.75, // weaker slow for chained (non-primary) victims
    chainDurationMs: 1200,
    chainDisableFireMs: 500,
    chainCooldownMs: 1500, // a given victim can't be re-chained (by ANY shock bullet) more often than this
  },
  missile: {
    label: 'Tên lửa tự dẫn',
    bulletSpeed: 55,
    damageMult: 1.3,
    cooldownMult: 2.2,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 3,
    splashDamageMult: 0.5,
    color: 0xff9a3d,
    homing: true,
    homingTurnRateRadPerSec: 2.4, // capped steering — subtle, never a snap/180
    homingConeAngle: 0.9, // ~51deg search cone in front of the missile
    homingRange: 55,
  },
  ricochet: {
    label: 'Đạn dội tường',
    bulletSpeed: 85,
    damageMult: 0.8,
    cooldownMult: 1.4,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 0,
    color: 0xb6ff5c,
    bounceCount: 3,
    bounceDamageMult: 0.7, // damage carried into the NEXT bounce
    bounceSpeedMult: 0.92,
  },
  cryo: {
    label: 'Đạn đóng băng (Cryo)',
    bulletSpeed: 80,
    damageMult: 0.65,
    cooldownMult: 1.4,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 0,
    color: 0x9fe8ff,
    cryoSlowPerStack: 0.18, // each stacked hit adds this much slow...
    cryoMaxStacks: 3, // ...at max stacks the target is briefly frozen solid (see CRYO_FREEZE_MS)
    cryoDurationMs: 2500,
  },
  // ---- Section-4..14 special ammo -----------------------------------
  fire: {
    label: 'Đạn cháy (Incendiary)',
    bulletSpeed: 75,
    damageMult: 1.0, // ~70 raw damage at base power — direct hit, then burns
    cooldownMult: 1.5,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 0,
    color: 0xff6a1a,
    burnDamage: 15, // per tick, every burnTickMs
    burnTickMs: 500,
    burnDurationMs: 3000, // repeated hits REFRESH this, never stack ticks
  },
  corrosive: {
    label: 'Đạn ăn mòn (Corrosive)',
    bulletSpeed: 78,
    damageMult: 0.75,
    cooldownMult: 1.4,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 0,
    color: 0x8cff5c,
    corrodeMult: 1.25, // +25% damage taken from ALL sources while active
    corrodeDurationMs: 4000, // refreshed (never stacked) by repeated hits
  },
  vampire: {
    label: 'Đạn hút máu (Vampire)',
    bulletSpeed: 72,
    damageMult: 0.85,
    cooldownMult: 1.6,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 0,
    color: 0xff2d55,
    lifestealPct: 0.35, // fraction of damage dealt is a share of the flat lifesteal below
    lifestealCap: 8, // absolute HP restored per hit is min(damage*pct-scaled, this) — bounded, never unlimited
  },
  marking: {
    label: 'Đạn đánh dấu (Marking)',
    bulletSpeed: 90,
    damageMult: 0.6,
    cooldownMult: 1.5,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 0,
    color: 0xffe14d,
    markDurationMs: 6000,
    markSupportDamageMult: 1.25, // support-weapon damage vs a marked target
  },
  cluster: {
    label: 'Đạn chùm (Cluster)',
    bulletSpeed: 60,
    damageMult: 0.9,
    cooldownMult: 2.0,
    bulletsPerShot: 1,
    spreadAngle: 0,
    splashRadius: 0,
    color: 0xffa64d,
    clusterCount: 5, // fragments spawned on impact (fixed, bounded — no recursive clustering)
    clusterDamageMult: 0.4, // each fragment's damage relative to the main round
    clusterSpeed: 46,
    clusterSpreadAngle: Math.PI * 2, // fragments spray in a full circle from the impact point
  },
};

const WEAPON_BUFF_DURATION_MS = 25000;

// Explosive/missile splash: linear falloff from full damage at the center
// to SPLASH_FALLOFF_MIN at the edge of the radius, and blocked entirely by
// walls (no damage through solid cover even inside the radius).
const SPLASH_FALLOFF_MIN = 0.1;

// Cryo: at max stacks the victim is rooted solid (speed 0) for
// CRYO_FREEZE_MS, then gradually regains movement over CRYO_THAW_MS — never
// a permanent freeze (see server/Game.js's freeze/thaw handling in tick()).
const CRYO_FREEZE_MS = 1000;
const CRYO_THAW_MS = 1200;

// Turret suppression (section 16): sustained hits build a stack counter
// that decays if the turret stops landing hits; at SUPPRESSION_MAX stacks
// the victim is briefly staggered (can't fire, heavily slowed), then the
// counter resets so it can't just stay staggered forever.
const SUPPRESSION_MAX = 4;
const SUPPRESSION_DECAY_MS = 2500;
const SUPPRESSION_STAGGER_MS = 1200;
const SUPPRESSION_SLOW_MULT = 0.88; // mild slow per suppressing hit, below full stagger
const SUPPRESSION_STAGGER_SLOW_MULT = 0.35;

// Chain Lightning (section 23) & the Orbital laser's LOS-gated targeting
// share the same "don't scan forever" cap as everything else in this file.
const MAX_ZONES = 6; // hard cap on simultaneous missile-pod danger zones + gravity cores (perf safety, section 30)

// ---------------------------------------------------------------------
// Temporary automatic support weapons (turret/drone/missile-pod/orbital/
// sentinel pickups). One shared targeting+firing loop in Game.js drives
// all of them — they differ only by the numbers below (data-driven, no
// per-type script duplication). `modules` > 1 means several independent
// firing slots (each with its own cooldown) active at once, e.g. the
// orbital support's ring of mini-turrets.
// ---------------------------------------------------------------------
const SUPPORT_TYPES = {
  // ---- Auto-firing supports (generic targeting+fire loop, see
  // Game.js#_updateSupportWeapons) — each still needs a DISTINCT gameplay
  // effect (section 15), so beyond the raw numbers below, every one of
  // these sets extra per-type flags read by _resolveBulletHit /
  // _spawnSupportBullet: turret suppresses, drone marks, missilepod leaves
  // a danger zone, orbital's bolt burns+corrodes, sentinel executes.
  turret: {
    label: 'Auto Turret',
    rarity: 'common',
    durationMs: 19000,
    fireCooldownMs: 750,
    damage: 16,
    bulletSpeed: 75,
    range: 40,
    modules: 1,
    appliesSuppression: true,
  },
  drone: {
    label: 'Combat Drone',
    rarity: 'uncommon',
    durationMs: 20000,
    fireCooldownMs: 650,
    damage: 13,
    bulletSpeed: 95,
    range: 35,
    modules: 1,
    appliesMark: true,
    markDurationMs: 4000,
  },
  missilepod: {
    label: 'Missile Pod',
    rarity: 'rare',
    durationMs: 14000,
    fireCooldownMs: 1900,
    damage: 26,
    bulletSpeed: 52,
    range: 50,
    modules: 1,
    homing: true,
    splashRadius: 5,
    splashDamageMult: 0.55,
    zoneKind: 'danger', // area-denial zone left behind at the impact point
    zoneRadius: 6,
    zoneDurationMs: 4500,
    zoneTickMs: 500,
    zoneTickDamage: 5,
    zoneSlowMult: 0.6,
  },
  orbital: {
    label: 'Orbital Support',
    rarity: 'epic',
    durationMs: 11000,
    fireCooldownMs: 1500,
    damage: 16,
    bulletSpeed: 210, // near-instant hitscan-like bolt — reads as a laser, still a real swept projectile
    range: 32,
    modules: 3, // 3 independent orbiting modules, each firing on its own cooldown
    appliesBurn: true,
    burnDamage: 10,
    burnTickMs: 500,
    burnDurationMs: 2200,
    appliesCorrode: true,
    corrodeMult: 1.2,
    corrodeDurationMs: 3000,
  },
  sentinel: {
    label: 'Sentinel',
    rarity: 'legendary',
    durationMs: 10000,
    fireCooldownMs: 2200,
    damage: 50,
    bulletSpeed: 105,
    range: 55,
    modules: 1,
    preferLockedTarget: true, // prioritizes the owner's client-side locked target when valid
    preferLowestHp: true, // otherwise prioritizes the weakest valid target in range, not just the closest
    executeHpPct: 0.2, // targets at/below this HP fraction get the execution multiplier
    executeDamageMult: 2.4,
  },
  // ---- Special-behavior supports (section 21-24) — NOT a simple
  // find-target-and-shoot loop, so _updateSupportWeapons special-cases
  // `special` before falling back to the generic loop above.
  shield: {
    label: 'Khiên Năng Lượng',
    rarity: 'epic',
    durationMs: 16000,
    special: 'shield',
    shieldMaxHp: 90,
    shieldRegenDelayMs: 4000, // must go this long without taking damage before regen starts
    shieldRegenPerSec: 16,
  },
  timeslow: {
    label: 'Trường Thời Gian',
    rarity: 'epic',
    durationMs: 9000,
    special: 'timeslow',
    radius: 14,
    slowMult: 0.45,
  },
  lightning: {
    label: 'Sét Lan Truyền',
    rarity: 'rare',
    durationMs: 11000,
    special: 'lightning',
    boltCooldownMs: 1600,
    damage: 26,
    chainDamageMult: 0.7,
    maxChainTargets: 4,
    range: 26,
    chainRange: 12,
    stunMs: 650,
  },
  gravity: {
    label: 'Hố Đen Trọng Lực',
    rarity: 'legendary',
    durationMs: 9000,
    special: 'gravity',
    radius: 15,
    pullSpeed: 3.4, // units/sec pulled toward the anchor while caught in the field
    slowMult: 0.35,
    burstDamage: 65,
    burstRadius: 9,
  },
};

// ---------------------------------------------------------------------
// Pickups: armor (damage reduction) + one pickup per special weapon.
// Spawn at fixed candidate points spread across open lanes of the map
// (kept clear of the OBSTACLES boxes above).
// ---------------------------------------------------------------------

const PICKUP_TYPES = {
  armor: { kind: 'armor', label: 'Giáp', color: 0x4da8ff, rarity: 'common' },
  heal: { kind: 'heal', label: 'Hồi máu', color: 0x3ddc6c, rarity: 'common' },
  speed: { kind: 'speed', label: 'Tăng tốc', color: 0x2de6c8, rarity: 'common' },
  rapidfire: { kind: 'rapidfire', label: 'Bắn nhanh', color: 0xff5ec4, rarity: 'common' },
  invuln: { kind: 'invuln', label: 'Bất tử tạm thời', color: 0xb35cff, rarity: 'uncommon' },
  // "AMMO BOX" (section 2 item 1): this game has no clip/ammo-count system
  // (fire rate is cooldown-based, never runs out) — the closest honest
  // equivalent is an instant, guaranteed-ready next shot.
  ammo_refill: { kind: 'ammo_refill', label: 'Hộp đạn (nạp tức thì)', color: 0xe8edf4, rarity: 'common' },
  weapon_laser: { kind: 'weapon', weapon: 'laser', label: 'Tia laser', color: 0x35e6ff, rarity: 'common' },
  weapon_sniper: { kind: 'weapon', weapon: 'sniper', label: 'Đạn tỉa', color: 0xfff066, rarity: 'common' },
  weapon_spread: { kind: 'weapon', weapon: 'spread', label: 'Đạn tỏa 3 viên', color: 0xff8a3d, rarity: 'common' },
  weapon_explosive: { kind: 'weapon', weapon: 'explosive', label: 'Đạn nổ', color: 0xff4d4d, rarity: 'uncommon' },
  weapon_shock: { kind: 'weapon', weapon: 'shock', label: 'Đạn điện', color: 0x63d2ff, rarity: 'uncommon' },
  weapon_cryo: { kind: 'weapon', weapon: 'cryo', label: 'Đạn đóng băng', color: 0x9fe8ff, rarity: 'uncommon' },
  weapon_fire: { kind: 'weapon', weapon: 'fire', label: 'Đạn cháy', color: 0xff6a1a, rarity: 'uncommon' },
  weapon_corrosive: { kind: 'weapon', weapon: 'corrosive', label: 'Đạn ăn mòn', color: 0x8cff5c, rarity: 'uncommon' },
  weapon_ap: { kind: 'weapon', weapon: 'ap', label: 'Xuyên giáp', color: 0xd8d8d8, rarity: 'rare' },
  weapon_missile: { kind: 'weapon', weapon: 'missile', label: 'Tên lửa tự dẫn', color: 0xff9a3d, rarity: 'rare' },
  weapon_ricochet: { kind: 'weapon', weapon: 'ricochet', label: 'Đạn dội tường', color: 0xb6ff5c, rarity: 'rare' },
  weapon_vampire: { kind: 'weapon', weapon: 'vampire', label: 'Đạn hút máu', color: 0xff2d55, rarity: 'rare' },
  weapon_cluster: { kind: 'weapon', weapon: 'cluster', label: 'Đạn chùm', color: 0xffa64d, rarity: 'rare' },
  weapon_marking: { kind: 'weapon', weapon: 'marking', label: 'Đạn đánh dấu', color: 0xffe14d, rarity: 'epic' },
  // ---- Support-weapon crates (rarer, visually distinct on the client) ----
  support_turret: { kind: 'support', support: 'turret', label: 'Auto Turret', color: 0xffb020, rarity: 'common' },
  support_drone: { kind: 'support', support: 'drone', label: 'Combat Drone', color: 0x4dd0ff, rarity: 'uncommon' },
  support_missilepod: { kind: 'support', support: 'missilepod', label: 'Missile Pod', color: 0xff5c3d, rarity: 'rare' },
  support_lightning: { kind: 'support', support: 'lightning', label: 'Sét Lan Truyền', color: 0x7df9ff, rarity: 'rare' },
  support_orbital: { kind: 'support', support: 'orbital', label: 'Orbital Support', color: 0xb35cff, rarity: 'epic' },
  support_shield: { kind: 'support', support: 'shield', label: 'Khiên Năng Lượng', color: 0x4da8ff, rarity: 'epic' },
  support_timeslow: { kind: 'support', support: 'timeslow', label: 'Trường Thời Gian', color: 0x8ec9ff, rarity: 'epic' },
  support_sentinel: { kind: 'support', support: 'sentinel', label: 'Sentinel', color: 0xffe14d, rarity: 'legendary' },
  support_gravity: { kind: 'support', support: 'gravity', label: 'Hố Đen Trọng Lực', color: 0x2a1a4d, rarity: 'legendary' },
};

// 5-tier rarity system (section 3). Spawn weighting so rarer pickups come up
// far less often (roulette-wheel selection, see Game.js#_pickWeightedPickupKind
// and #_rollDropTable). A pickup with no explicit `rarity` above defaults to
// 'common'.
const PICKUP_RARITY_WEIGHT = { common: 100, uncommon: 42, rare: 16, epic: 6, legendary: 2 };

// ---------------------------------------------------------------------
// Loot/drop system (section 28-29): killing an eligible enemy (a bot, or —
// at reduced odds — an opposing player in Arena) rolls FIRST for whether
// anything drops at all, using per-category chances so the numbers below
// read directly as "X% of kills drop an item of this quality" rather than
// an opaque weight table. Only one item ever drops per kill. Order matters:
// rolled best-category-first so the (small) rare-support chance and the
// (larger) normal-ammo chance don't both need to fire independently.
// Table is keyed by bot tier (easy/medium/hard = "Normal/Elite/Boss" from
// the spec) plus a separate, more conservative 'pvp' tier for Arena kills.
// ---------------------------------------------------------------------
const DROP_TABLES = {
  easy: { normal: 0.2, special: 0.1, support: 0.06, rareSupport: 0.02 },
  medium: { normal: 0.28, special: 0.18, support: 0.12, rareSupport: 0.05 },
  hard: { normal: 0.3, special: 0.22, support: 0.18, rareSupport: 0.1 },
  pvp: { normal: 0.16, special: 0.08, support: 0.04, rareSupport: 0.015 },
};

const PICKUP_SPAWN_POINTS = [
  { x: 0, z: -25 }, { x: 0, z: 25 },
  { x: -19, z: 0 }, { x: 19, z: 0 },
  { x: 38, z: 38 }, { x: -38, z: 38 }, { x: 38, z: -38 }, { x: -38, z: -38 },
  { x: 0, z: -40 }, { x: 0, z: 40 },
  { x: 56, z: 0 }, { x: -56, z: 0 },
  { x: 15, z: 15 }, { x: -15, z: -15 }, { x: 15, z: -15 }, { x: -15, z: 15 },
  { x: 65, z: 65 }, { x: -65, z: 65 }, { x: 65, z: -65 }, { x: -65, z: -65 },
];

const PICKUP_RADIUS = 1.4;
// Section 1: noticeably higher drop/spawn frequency than before (was 4 /
// 12000ms) so combat regularly produces something worth grabbing, without
// flooding the map.
const MAX_ACTIVE_PICKUPS = 7;
const PICKUP_SPAWN_INTERVAL_MS = 6500;
const PICKUP_MIN_SEPARATION = 8; // don't spawn two pickups on top of each other
const DROPPED_PICKUP_POP_MS = 550; // pop-up/rotate/land intro (section 29), read by the client only

const ARMOR_DAMAGE_REDUCTION = 0.35;
const ARMOR_DURATION_MIN_MS = 30000;
const ARMOR_DURATION_MAX_MS = 60000;

const HEAL_AMOUNT = 40;

const SPEED_BOOST_MULT = 1.5;
const SPEED_BOOST_DURATION_MS = 20000;

const RAPID_FIRE_MULT = 0.65; // multiplies cooldown (lower = faster)
const RAPID_FIRE_DURATION_MS = 20000;

const INVULN_DURATION_MS = 4000;

// ---------------------------------------------------------------------
// Campaign structure (section 18-22, 45): 10 CHAPTERS x 8 STAGES = 80
// total. There is only ONE actual arena map in this project (fixed
// OBSTACLES/ARENA_HALF_SIZE) — rather than faking 10 unique environments
// this project's assets don't have, each chapter gets a cheap, honest
// re-skin (sky/fog tint, via `skyTint` below, read by the client's
// existing createSkyTexture) and, far more importantly, a genuinely
// different FIGHT: enemy tier/role composition, wave count, objective
// type, elite/boss presence — all generated by the formula below rather
// than 80 hand-authored (and therefore easy to fake/leave hollow) entries.
// ---------------------------------------------------------------------
const CHAPTER_THEMES = [
  { chapter: 1, name: 'Huấn Luyện / Ngoại Ô', skyTint: 0x7fb3e8 },
  { chapter: 2, name: 'Khu Công Nghiệp', skyTint: 0x8a8f7a },
  { chapter: 3, name: 'Căn Cứ Quân Sự', skyTint: 0x6b7d8c },
  { chapter: 4, name: 'Tàn Tích Đô Thị', skyTint: 0xa67c52 },
  { chapter: 5, name: 'Khu Phức Hợp Ngầm', skyTint: 0x3a3a4a },
  { chapter: 6, name: 'Sa Mạc Hoang Tàn', skyTint: 0xd9b56b },
  { chapter: 7, name: 'Cơ Sở Nghiên Cứu', skyTint: 0x35c9e6 },
  { chapter: 8, name: 'Vùng Nhiễm Cao', skyTint: 0x4d8a3d },
  { chapter: 9, name: 'Vùng Chiến Sự', skyTint: 0x8a2f2f },
  { chapter: 10, name: 'Khu Vực Cuối Cùng', skyTint: 0x1a1a2e },
];

// Section 22: 5 real objective types (ELIMINATE/SURVIVE/DEFEND/HUNT are
// mechanically distinct; HOLD is folded into DEFEND since "hold ground
// protecting something" and "defend an objective" are the same mechanic
// here — documented in the final report rather than built twice).
// ESCORT/DESTROY/ESCAPE were NOT implemented: this project has no movable
// escort entity, destructible structure props, or extraction-point system
// to hang them on honestly, so faking them as reskinned ELIMINATE stages
// was deliberately avoided.
const OBJECTIVE_TYPES = ['eliminate', 'survive', 'defend', 'hunt', 'boss'];

function tierForChapter(chapter) {
  if (chapter <= 3) return 'easy';
  if (chapter <= 7) return 'medium';
  return 'hard';
}

// Deterministic role rotation: only roles already unlocked by this
// chapter (ROLE_UNLOCK_CHAPTER) are eligible, and `offset` (derived from
// the stage/wave index) rotates the starting point through that list so
// stages within the same chapter don't all reuse an identical composition.
function pickRoles(chapter, count, offset) {
  const unlocked = Object.keys(ROLE_UNLOCK_CHAPTER).filter((r) => ROLE_UNLOCK_CHAPTER[r] <= chapter);
  const roles = [];
  for (let i = 0; i < count; i++) roles.push(unlocked[(offset + i) % unlocked.length]);
  return roles;
}

function buildWave(chapter, botCount, offset) {
  const tier = tierForChapter(chapter);
  return pickRoles(chapter, botCount, offset).map((role) => ({ tier, role }));
}

// One wave list per (chapter, stageInChapter) — section 23: enemies never
// all spawn at once, later waves only start once the previous one is
// cleared (see Game.js's wave scheduler), with a short breather between.
function buildWavesForStage(chapter, stageInChapter) {
  const scale = chapterScaling(chapter);
  const extra = scale.extraWaveBots;
  switch (stageInChapter) {
    case 1: // introduction — one small wave
      return [buildWave(chapter, 2 + extra, 0)];
    case 2: // higher density — two waves
      return [buildWave(chapter, 2 + extra, 1), buildWave(chapter, 2 + extra, 3)];
    case 3: // a new-to-this-chapter role leads the wave
      return [buildWave(chapter, 2 + extra, 5), buildWave(chapter, 2 + extra, 2)];
    case 4: // HUNT — a small escort wave plus the guaranteed elite (added separately)
      return [buildWave(chapter, 1 + extra, 4)];
    case 5: // mixed composition — one big wave spanning several roles at once
      return [buildWave(chapter, 3 + extra, 0), buildWave(chapter, 2 + extra, 6)];
    case 6: // SURVIVE — waves recycle until the timer runs out (see Game.js)
      return [buildWave(chapter, 2 + extra, 2), buildWave(chapter, 2 + extra, 7)];
    case 7: // DEFEND — steady pressure on the objective
      return [buildWave(chapter, 2 + extra, 1), buildWave(chapter, 2 + extra, 4), buildWave(chapter, 2 + extra, 0)];
    case 8: // boss stage — one light warm-up wave, then the boss
      return [buildWave(chapter, 1 + Math.floor(extra / 2), 3)];
    default:
      return [buildWave(chapter, 2, 0)];
  }
}

function objectiveForStage(stageInChapter, chapter) {
  const scale = chapterScaling(chapter);
  switch (stageInChapter) {
    case 6:
      return { type: 'survive', durationS: 60 + chapter * 6 };
    case 7:
      return { type: 'defend', objectiveMaxHp: Math.round(150 + chapter * 22) };
    case 4:
      return { type: 'hunt' };
    case 8:
      return { type: 'boss' };
    default:
      return { type: 'eliminate' };
  }
}

function stageNameFor(chapter, stageInChapter, objectiveType, isBoss) {
  if (isBoss) return `Chương ${chapter} — TRÙM CUỐI`;
  const label = { eliminate: 'Tiêu Diệt', survive: 'Sống Sót', defend: 'Phòng Thủ', hunt: 'Truy Lùng' }[objectiveType] || 'Nhiệm Vụ';
  return `Chương ${chapter}.${stageInChapter} — ${label}`;
}

function generateStages() {
  const stages = [];
  for (let chapter = 1; chapter <= 10; chapter++) {
    const scale = chapterScaling(chapter);
    for (let stageInChapter = 1; stageInChapter <= 8; stageInChapter++) {
      const id = (chapter - 1) * 8 + stageInChapter;
      const isBoss = stageInChapter === 8;
      const objective = objectiveForStage(stageInChapter, chapter);
      const waves = buildWavesForStage(chapter, stageInChapter);
      const eliteChance = objective.type === 'hunt' ? 1 : scale.eliteChance;
      const reward = Math.round((60 + chapter * 35 + stageInChapter * 12) * (isBoss ? 2.4 : 1));
      stages.push({
        id,
        chapter,
        stageInChapter,
        name: stageNameFor(chapter, stageInChapter, objective.type, isBoss),
        theme: CHAPTER_THEMES[chapter - 1],
        objective,
        waves,
        eliteChance,
        boss: isBoss ? BOSS_DEFS[chapter - 1] : null,
        reward,
        // kept for the /api/stages summary + any legacy reader expecting a
        // flat bot count (see server/index.js).
        botCount: waves.reduce((sum, w) => sum + w.length, 0) + (isBoss ? 1 : 0),
      });
    }
  }
  return stages;
}

const STAGES = generateStages();

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
  TEAM_SPAWN_POINTS,
  PLAYER_COLORS,
  TEAM_COLORS,
  MAX_UPGRADE_LEVEL,
  UPGRADES,
  UPGRADE_COST,
  UPGRADE_CATALOG,
  UPGRADE_CATEGORIES,
  SPRINT_SPEED_MULT,
  MAX_STAMINA,
  STAMINA_DRAIN_PER_SEC,
  STAMINA_REGEN_PER_SEC,
  STAMINA_REGEN_DELAY_MS,
  PERK_POOL,
  PERK_RARITY_WEIGHT,
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
  BOSS_DEFS,
  CHAPTER_THEMES,
  OBJECTIVE_TYPES,
  STAGES,
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
  DROPPED_PICKUP_POP_MS,
  ARMOR_DAMAGE_REDUCTION,
  ARMOR_DURATION_MIN_MS,
  ARMOR_DURATION_MAX_MS,
  HEAL_AMOUNT,
  SPEED_BOOST_MULT,
  SPEED_BOOST_DURATION_MS,
  RAPID_FIRE_MULT,
  RAPID_FIRE_DURATION_MS,
  INVULN_DURATION_MS,
};
