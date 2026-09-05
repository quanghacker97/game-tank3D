'use strict';

// Must mirror server/constants.js so local prediction matches the
// authoritative simulation closely enough that server corrections stay tiny.
const TANK_RADIUS = 0.92;
const TANK_VISUAL_SCALE = 0.4;
const RESPAWN_DELAY_MS = 3000;
const MOUSE_SENSITIVITY = 0.0022;
const TOUCH_LOOK_SENSITIVITY = 0.0026;
const JOYSTICK_RADIUS = 48; // px, matches #touchJoystickBase knob travel
const CAM_DIST = 11;
const CAM_BASE_HEIGHT = 3;
const BASE_FOV = 65;

// ---- RMB = ADS/zoom (fully independent of target-lock) ----
const ADS_FOV = 54; // moderate ~17% narrower than BASE_FOV — precision, not binoculars
const ADS_SENS_MULT = 0.62; // slower/more precise mouse while ADS-zoomed
const ADS_CAM_DIST_MULT = 0.92; // slight lean-in, kept subtle so the map stays readable
const ADS_TRANSITION_SPEED = 9; // higher = snappier ease in/out of ADS, still not an instant pop

// ---- LMB+RMB = target lock/focus (fully independent of ADS/zoom) ----
const LOCK_TURN_RATE = 3.0; // rad/sec turret assist-tracking speed while target-locked
const LOCK_MAX_RANGE = 90;
const LOCK_MAX_ANGLE = 0.3; // rad (~17deg) cone around the aim direction for LMB+RMB target acquisition
const LOCK_COMBO_WINDOW_MS = 220; // max gap between the two buttons for it to count as one lock chord

// ---- Minimap (player-centered, rotates with the player's authoritative
// bodyRot — see updateMinimap; fully independent of ADS/target-lock) ----
const MINIMAP_RANGE = 70; // world units from the player to the minimap edge


const MAX_UPGRADE_LEVEL = 5;
const UPGRADES = {
  power: [25, 29, 33, 37, 41, 45],
  defense: [100, 116, 132, 148, 164, 180],
  agilityMove: [14, 15.2, 16.4, 17.6, 18.8, 20],
  rate: [550, 510, 470, 430, 390, 350],
};
const UPGRADE_COST = [50, 120, 220, 360, 550];
const UPGRADE_TRACKS = [
  { key: 'power', icon: '⚔️', label: 'Sức mạnh', fmt: (lv) => `${UPGRADES.power[lv]} sát thương` },
  { key: 'defense', icon: '🛡️', label: 'Phòng thủ', fmt: (lv) => `${UPGRADES.defense[lv]} máu` },
  { key: 'agility', icon: '💨', label: 'Nhanh nhẹn', fmt: (lv) => `${UPGRADES.agilityMove[lv].toFixed(1)} m/s` },
  { key: 'rate', icon: '🔫', label: 'Tốc độ bắn', fmt: (lv) => `${(1000 / UPGRADES.rate[lv]).toFixed(2)} phát/s` },
];

// Visual/label metadata for weapons & pickups — must mirror the kinds server/
// constants.js's WEAPON_TYPES / PICKUP_TYPES can produce. Damage/splash stay
// server-authoritative; cooldownMult is duplicated here too (must match
// server exactly) purely so the local reload-bar prediction paces itself
// correctly for whichever weapon is currently active.
const WEAPON_META = {
  normal: { icon: '🔫', label: 'Pháo thường', cooldownMult: 1 },
  laser: { icon: '⚡', label: 'Tia laser', cooldownMult: 0.32 },
  sniper: { icon: '🔭', label: 'Đạn tỉa', cooldownMult: 2.6 },
  spread: { icon: '🎇', label: 'Đạn tỏa 3 viên', cooldownMult: 1.3 },
  explosive: { icon: '💣', label: 'Đạn nổ', cooldownMult: 1.9 },
  ap: { icon: '🛠️', label: 'Xuyên giáp', cooldownMult: 1.5 },
  shock: { icon: '⚡', label: 'Đạn điện', cooldownMult: 1.5 },
  missile: { icon: '🚀', label: 'Tên lửa tự dẫn', cooldownMult: 2.2 },
  ricochet: { icon: '🔰', label: 'Đạn dội tường', cooldownMult: 1.4 },
  cryo: { icon: '❄️', label: 'Đạn đóng băng', cooldownMult: 1.4 },
};

const PICKUP_META = {
  armor: { icon: '🛡️', label: 'Giáp', color: 0x4da8ff },
  heal: { icon: '➕', label: 'Hồi máu', color: 0x3ddc6c },
  speed: { icon: '💨', label: 'Tăng tốc', color: 0x2de6c8 },
  rapidfire: { icon: '🔃', label: 'Bắn nhanh', color: 0xff5ec4 },
  invuln: { icon: '⭐', label: 'Bất tử tạm thời', color: 0xb35cff },
  weapon_laser: { icon: '⚡', label: 'Tia laser', color: 0x35e6ff },
  weapon_sniper: { icon: '🔭', label: 'Đạn tỉa', color: 0xfff066 },
  weapon_spread: { icon: '🎇', label: 'Đạn tỏa 3 viên', color: 0xff8a3d },
  weapon_explosive: { icon: '💣', label: 'Đạn nổ', color: 0xff4d4d },
  weapon_ap: { icon: '🛠️', label: 'Xuyên giáp', color: 0xd8d8d8 },
  weapon_shock: { icon: '⚡', label: 'Đạn điện', color: 0x63d2ff },
  weapon_missile: { icon: '🚀', label: 'Tên lửa tự dẫn', color: 0xff9a3d },
  weapon_ricochet: { icon: '🔰', label: 'Đạn dội tường', color: 0xb6ff5c },
  weapon_cryo: { icon: '❄️', label: 'Đạn đóng băng', color: 0x9fe8ff },
  // Support-weapon crates — visually larger/brighter markers (see
  // createPickupMesh) so they read as a special, rarer find on sight.
  support_turret: { icon: '🗼', label: 'Auto Turret', color: 0xffb020, support: true },
  support_drone: { icon: '🛸', label: 'Combat Drone', color: 0x4dd0ff, support: true },
  support_missilepod: { icon: '🚀', label: 'Missile Pod', color: 0xff5c3d, support: true },
  support_orbital: { icon: '🪐', label: 'Orbital Support', color: 0xb35cff, support: true },
  support_sentinel: { icon: '👁️', label: 'Sentinel', color: 0xffe14d, support: true },
};

// Small standalone table (label/icon only — duration/expiry always comes
// from the server snapshot) for the support-weapon HUD panel and the
// tank's support-aura indicator mesh.
const SUPPORT_META = {
  turret: { icon: '🗼', label: 'Auto Turret', color: 0xffb020 },
  drone: { icon: '🛸', label: 'Combat Drone', color: 0x4dd0ff },
  missilepod: { icon: '🚀', label: 'Missile Pod', color: 0xff5c3d },
  orbital: { icon: '🪐', label: 'Orbital Support', color: 0xb35cff },
  sentinel: { icon: '👁️', label: 'Sentinel', color: 0xffe14d },
};
// Precompute each kind's CSS hex string once (used by the minimap every
// frame per visible pickup) instead of re-running toString(16)+padStart on
// the same constant color value on every single render.
for (const meta of Object.values(PICKUP_META)) {
  meta.hex = '#' + meta.color.toString(16).padStart(6, '0');
}

// Timed-buff badge metadata for the HUD. Must mirror server/constants.js's
// SPEED_BOOST_MULT/RAPID_FIRE_MULT so local movement/reload prediction
// matches the authoritative simulation while a buff is active.
const BUFF_META = {
  armor: { icon: '🛡️', label: 'Giáp' },
  speed: { icon: '💨', label: 'Tăng tốc' },
  rapidfire: { icon: '🔃', label: 'Bắn nhanh' },
  invuln: { icon: '⭐', label: 'Bất tử' },
};
const SPEED_BOOST_MULT = 1.5;
const RAPID_FIRE_MULT = 0.65;

const BULLET_VISUALS = {
  normal: { shape: 'sphere', size: 0.4, color: 0xffcc33, emissive: 0xff9900 },
  laser: { shape: 'bolt', length: 2.2, radius: 0.12, color: 0x35e6ff, emissive: 0x35e6ff },
  sniper: { shape: 'bolt', length: 1.6, radius: 0.14, color: 0xfff066, emissive: 0xffe14d },
  spread: { shape: 'sphere', size: 0.28, color: 0xff8a3d, emissive: 0xff6a00 },
  explosive: { shape: 'sphere', size: 0.55, color: 0xff4d4d, emissive: 0xff2200 },
  ap: { shape: 'bolt', length: 1.3, radius: 0.09, color: 0xd8d8d8, emissive: 0xaaaaaa },
  shock: { shape: 'sphere', size: 0.32, color: 0x63d2ff, emissive: 0x2ea6ff },
  missile: { shape: 'bolt', length: 1.1, radius: 0.16, color: 0xff9a3d, emissive: 0xff6a00 },
  ricochet: { shape: 'sphere', size: 0.3, color: 0xb6ff5c, emissive: 0x8ef22c },
  cryo: { shape: 'sphere', size: 0.34, color: 0x9fe8ff, emissive: 0x6cd4ff },
  // Support-weapon projectiles all share one small, neutral bolt look — kept
  // simple since they're secondary/automatic fire, not the player's own shot.
  support_turret: { shape: 'sphere', size: 0.3, color: 0xffb020, emissive: 0xff8800 },
  support_drone: { shape: 'sphere', size: 0.26, color: 0x4dd0ff, emissive: 0x2196c9 },
  support_missilepod: { shape: 'bolt', length: 1.0, radius: 0.15, color: 0xff5c3d, emissive: 0xff3300 },
  support_orbital: { shape: 'sphere', size: 0.24, color: 0xb35cff, emissive: 0x8a2be2 },
  support_sentinel: { shape: 'bolt', length: 1.4, radius: 0.17, color: 0xffe14d, emissive: 0xffc400 },
};
const BULLET_HEIGHT = 0.68;

// ---------- Sound (Web Audio API — fully synthesized, no asset files) ----------
const SOUND_MUTED_KEY = 'tank3d_muted_v1';
const Sound = (() => {
  let ctx = null;
  let master = null;
  let muted = false;
  try {
    muted = localStorage.getItem(SOUND_MUTED_KEY) === '1';
  } catch (e) {
    /* storage unavailable */
  }

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.55;
    master.connect(ctx.destination);
    return ctx;
  }

  function resume() {
    const c = ensureCtx();
    if (c && c.state === 'suspended') c.resume();
  }

  function setMuted(v) {
    muted = v;
    try {
      localStorage.setItem(SOUND_MUTED_KEY, muted ? '1' : '0');
    } catch (e) {
      /* storage unavailable */
    }
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.55, ctx.currentTime, 0.05);
  }

  function isMuted() {
    return muted;
  }

  function noiseBuffer(duration) {
    const c = ensureCtx();
    const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * duration)), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function playTone({ freq = 440, endFreq = null, type = 'sine', duration = 0.15, gain = 0.3, delay = 0 }) {
    const c = ensureCtx();
    if (!c || gain <= 0) return;
    const osc = c.createOscillator();
    osc.type = type;
    const g = c.createGain();
    const t0 = c.currentTime + delay;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t0 + duration);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function playNoise({ duration = 0.2, gain = 0.3, filterFreq = 1200, filterType = 'lowpass', delay = 0 }) {
    const c = ensureCtx();
    if (!c || gain <= 0) return;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(duration);
    const filter = c.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    const g = c.createGain();
    const t0 = c.currentTime + delay;
    g.gain.setValueAtTime(Math.max(0.0001, gain), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter);
    filter.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
  }

  const SHOT_PROFILES = {
    normal: (m) => {
      playTone({ freq: 620, endFreq: 180, type: 'square', duration: 0.11, gain: 0.28 * m });
      playNoise({ duration: 0.08, gain: 0.18 * m, filterFreq: 2200 });
    },
    laser: (m) => {
      playTone({ freq: 1600, endFreq: 500, type: 'sawtooth', duration: 0.09, gain: 0.2 * m });
    },
    sniper: (m) => {
      playTone({ freq: 260, endFreq: 60, type: 'square', duration: 0.28, gain: 0.36 * m });
      playNoise({ duration: 0.2, gain: 0.22 * m, filterFreq: 1500 });
    },
    spread: (m) => {
      playTone({ freq: 700, endFreq: 240, type: 'square', duration: 0.09, gain: 0.22 * m });
      playNoise({ duration: 0.06, gain: 0.14 * m, filterFreq: 2400 });
    },
    explosive: (m) => {
      playTone({ freq: 340, endFreq: 90, type: 'sawtooth', duration: 0.16, gain: 0.3 * m });
      playNoise({ duration: 0.12, gain: 0.2 * m, filterFreq: 1000 });
    },
  };

  function shot(kind, mult = 1) {
    const fn = SHOT_PROFILES[kind] || SHOT_PROFILES.normal;
    fn(Math.max(0, mult));
  }

  function hit(mult = 1) {
    playNoise({ duration: 0.1, gain: 0.3 * mult, filterFreq: 900, filterType: 'bandpass' });
    playTone({ freq: 150, endFreq: 60, type: 'triangle', duration: 0.1, gain: 0.21 * mult });
  }

  function blocked(mult = 1) {
    playTone({ freq: 1100, endFreq: 1400, type: 'triangle', duration: 0.12, gain: 0.25 * mult });
  }

  function explosion(mult = 1, big = false) {
    playNoise({ duration: big ? 0.55 : 0.35, gain: (big ? 0.5 : 0.35) * mult, filterFreq: 700, filterType: 'lowpass' });
    playTone({ freq: big ? 160 : 220, endFreq: 40, type: 'sawtooth', duration: big ? 0.5 : 0.32, gain: (big ? 0.4 : 0.3) * mult });
  }

  function pickup() {
    playTone({ freq: 660, type: 'sine', duration: 0.09, gain: 0.22 });
    playTone({ freq: 990, type: 'sine', duration: 0.12, gain: 0.22, delay: 0.07 });
  }

  function click() {
    playTone({ freq: 500, type: 'triangle', duration: 0.05, gain: 0.15 });
  }

  function lowHealthBeep() {
    playTone({ freq: 880, type: 'square', duration: 0.09, gain: 0.18 });
  }

  function stageClear() {
    [660, 880, 1100].forEach((f, i) => playTone({ freq: f, type: 'triangle', duration: 0.18, gain: 0.25, delay: i * 0.12 }));
  }

  function stageFailed() {
    [420, 320, 220].forEach((f, i) => playTone({ freq: f, type: 'sawtooth', duration: 0.22, gain: 0.25, delay: i * 0.14 }));
  }

  function supportActivate() {
    [440, 660, 880].forEach((f, i) => playTone({ freq: f, type: 'square', duration: 0.1, gain: 0.22, delay: i * 0.06 }));
  }

  function supportExpire() {
    playTone({ freq: 500, endFreq: 180, type: 'triangle', duration: 0.28, gain: 0.2 });
  }

  // Continuous soft engine drone; volume/pitch rise with movement input.
  let engineOsc = null;
  let engineGain = null;
  function updateEngine(moveMag) {
    const c = ensureCtx();
    if (!c) return;
    if (!engineOsc) {
      engineOsc = c.createOscillator();
      engineOsc.type = 'sawtooth';
      engineOsc.frequency.value = 50;
      engineGain = c.createGain();
      engineGain.gain.value = 0.0001;
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 220;
      engineOsc.connect(filter);
      filter.connect(engineGain);
      engineGain.connect(master);
      engineOsc.start();
    }
    const clamped = Math.min(1, Math.max(0, moveMag));
    engineGain.gain.setTargetAtTime(0.02 + clamped * 0.05, c.currentTime, 0.15);
    engineOsc.frequency.setTargetAtTime(50 + clamped * 30, c.currentTime, 0.15);
  }

  function stopEngine() {
    if (engineOsc) {
      try {
        engineOsc.stop();
      } catch (e) {
        /* already stopped */
      }
      engineOsc.disconnect();
      engineGain.disconnect();
      engineOsc = null;
      engineGain = null;
    }
  }

  return {
    resume,
    setMuted,
    isMuted,
    shot,
    hit,
    blocked,
    explosion,
    pickup,
    click,
    lowHealthBeep,
    stageClear,
    stageFailed,
    supportActivate,
    supportExpire,
    updateEngine,
    stopEngine,
  };
})();

['pointerdown', 'keydown', 'touchstart'].forEach((evt) => {
  window.addEventListener(evt, () => Sound.resume(), { once: true, passive: true });
});

function distVolMult(x, z, maxDist = 55) {
  const self = entities.get(selfId);
  if (!self) return 1;
  const d = Math.hypot(x - self.render.x, z - self.render.z);
  return Math.max(0, 1 - d / maxDist);
}

// ---------- Profile / progression (localStorage) ----------
const PROFILE_KEY = 'tank3d_profile_v1';

function clampLevel(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_UPGRADE_LEVEL, n)) : 0;
}

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        name: typeof p.name === 'string' ? p.name.slice(0, 16) : '',
        currency: Number.isFinite(p.currency) ? Math.max(0, p.currency) : 0,
        upgrades: {
          power: clampLevel(p.upgrades && p.upgrades.power),
          defense: clampLevel(p.upgrades && p.upgrades.defense),
          agility: clampLevel(p.upgrades && p.upgrades.agility),
          rate: clampLevel(p.upgrades && p.upgrades.rate),
        },
        unlockedStage: Number.isFinite(p.unlockedStage) ? Math.max(1, p.unlockedStage) : 1,
      };
    }
  } catch (e) {
    /* ignore corrupt storage */
  }
  return { name: '', currency: 0, upgrades: { power: 0, defense: 0, agility: 0, rate: 0 }, unlockedStage: 1 };
}

function saveProfile() {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch (e) {
    /* storage unavailable (private mode, quota) — progress just won't persist */
  }
}

const profile = loadProfile();
let STAGES_META = [];
fetch('/api/stages')
  .then((r) => r.json())
  .then((data) => {
    STAGES_META = Array.isArray(data) ? data : [];
    renderStages();
  })
  .catch(() => {});

// ---------- DOM ----------
const canvas = document.getElementById('scene');
const loginOverlay = document.getElementById('loginOverlay');
const elPanelName = document.getElementById('panelName');
const elPanelMenu = document.getElementById('panelMenu');
const elPanelStages = document.getElementById('panelStages');
const elPanelGarage = document.getElementById('panelGarage');

const nameInputEl = document.getElementById('nameInput');
const continueBtnEl = document.getElementById('continueBtn');
const loginStatusEl = document.getElementById('loginStatus');
const menuCurrencyEl = document.getElementById('menuCurrency');
const menuNameEl = document.getElementById('menuName');
const changeNameLinkEl = document.getElementById('changeNameLink');
const btnArenaEl = document.getElementById('btnArena');
const btnCampaignEl = document.getElementById('btnCampaign');
const btnGarageEl = document.getElementById('btnGarage');
const stageGridEl = document.getElementById('stageGrid');
const stagesBackEl = document.getElementById('stagesBack');
const garageBackEl = document.getElementById('garageBack');
const garageCurrencyEl = document.getElementById('garageCurrency');
const upgradeListEl = document.getElementById('upgradeList');

const hud = document.getElementById('hud');
const campaignBarEl = document.getElementById('campaignBar');
const campaignStageNameEl = document.getElementById('campaignStageName');
const campaignEnemiesEl = document.getElementById('campaignEnemies');
const hudCurrencyValueEl = document.getElementById('hudCurrencyValue');
const menuLeaveBtnEl = document.getElementById('menuLeaveBtn');
const muteBtnEl = document.getElementById('muteBtn');
const minimapEl = document.getElementById('minimap');
const minimapCtx = minimapEl.getContext('2d');
const healthBar = document.getElementById('healthBar');
const healthLabel = document.getElementById('healthLabel');
const reloadBar = document.getElementById('reloadBar');
const weaponIconEl = document.getElementById('weaponIcon');
const weaponLabelEl = document.getElementById('weaponLabel');
const activeBuffsEl = document.getElementById('activeBuffs');
const supportPanelEl = document.getElementById('supportPanel');
const supportPanelIconEl = document.getElementById('supportPanelIcon');
const supportPanelTypeEl = document.getElementById('supportPanelType');
const supportPanelBarEl = document.getElementById('supportPanelBar');
const supportPanelTimeEl = document.getElementById('supportPanelTime');
const crosshairEl = document.getElementById('crosshair');
const lockLabelEl = document.getElementById('lockLabel');
const killfeedEl = document.getElementById('killfeed');
const scoreboardEl = document.getElementById('scoreboard');
const deathBanner = document.getElementById('deathBanner');
const respawnCountEl = document.getElementById('respawnCount');
const stageResultOverlayEl = document.getElementById('stageResultOverlay');
const stageResultTitleEl = document.getElementById('stageResultTitle');
const stageResultSubEl = document.getElementById('stageResultSub');
const btnStageNextEl = document.getElementById('btnStageNext');
const btnStageRetryEl = document.getElementById('btnStageRetry');
const btnStageMenuEl = document.getElementById('btnStageMenu');
const touchControlsEl = document.getElementById('touchControls');
const touchJoystickBaseEl = document.getElementById('touchJoystickBase');
const touchJoystickKnobEl = document.getElementById('touchJoystickKnob');
const touchFireBtnEl = document.getElementById('touchFireBtn');
const touchLockBtnEl = document.getElementById('touchLockBtn');

// ---------- Three.js setup ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();

function createSkyTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#3f7fd6');
  grad.addColorStop(0.45, '#7fb3e8');
  grad.addColorStop(0.82, '#cfe6f5');
  grad.addColorStop(1, '#eef6fb');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 256);
  return new THREE.CanvasTexture(canvas);
}

scene.background = createSkyTexture();
scene.fog = new THREE.Fog(0xcfe6f5, 70, 165);

const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 20, 20);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const hemi = new THREE.HemisphereLight(0x9fc7ec, 0x3c4a2e, 0.95);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(60, 90, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -80;
sun.shadow.camera.right = 80;
sun.shadow.camera.top = 80;
sun.shadow.camera.bottom = -80;
sun.shadow.camera.far = 250;
scene.add(sun);

let arenaHalfSize = 60;
let obstacles = [];
let worldBuilt = false;

function createGrassTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#4d7a3a';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 4000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const light = Math.random() < 0.5;
    ctx.fillStyle = light ? 'rgba(120,165,80,0.22)' : 'rgba(40,70,30,0.22)';
    const s = 1 + Math.random() * 2;
    ctx.fillRect(x, y, s, s);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(arenaHalfSize / 3, arenaHalfSize / 3);
  return tex;
}

function buildGround() {
  const geo = new THREE.PlaneGeometry(arenaHalfSize * 2 + 60, arenaHalfSize * 2 + 60, 20, 20);
  const mat = new THREE.MeshStandardMaterial({ map: createGrassTexture(), roughness: 1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

function buildProps() {
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x7c8288, roughness: 1, flatShading: true });
  const bushMat = new THREE.MeshStandardMaterial({ color: 0x3f6b2e, roughness: 1, flatShading: true });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 });

  function scatterRing(count, rMin, rMax, place) {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = rMin + Math.random() * (rMax - rMin);
      place(Math.sin(ang) * r, Math.cos(ang) * r);
    }
  }

  scatterRing(18, arenaHalfSize - 9, arenaHalfSize - 3, (x, z) => {
    const s = 0.6 + Math.random() * 1.2;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), rockMat);
    rock.position.set(x, s * 0.45, z);
    rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    rock.castShadow = true;
    rock.receiveShadow = true;
    scene.add(rock);
  });

  scatterRing(22, arenaHalfSize - 15, arenaHalfSize - 5, (x, z) => {
    const s = 0.8 + Math.random() * 0.6;
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), bushMat);
    bush.position.set(x, s * 0.7, z);
    bush.rotation.y = Math.random() * Math.PI;
    bush.castShadow = true;
    bush.receiveShadow = true;
    scene.add(bush);
  });

  // Dead trees scattered just past the boundary wall, purely as a backdrop.
  scatterRing(16, arenaHalfSize + 6, arenaHalfSize + 32, (x, z) => {
    const h = 4 + Math.random() * 4;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, h, 6), trunkMat);
    trunk.position.set(x, h / 2, z);
    trunk.castShadow = true;
    scene.add(trunk);
    const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, h * 0.55, 5), trunkMat);
    branch.position.set(x, h * 0.8, z);
    branch.rotation.z = Math.PI / 3.2;
    branch.rotation.y = Math.random() * Math.PI;
    scene.add(branch);
  });
}

function buildBoundaryWalls() {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x555f6b, roughness: 0.9 });
  const h = 6;
  const t = 2;
  const s = arenaHalfSize;
  const specs = [
    { x: 0, z: -s - t / 2, w: s * 2 + t * 2, d: t },
    { x: 0, z: s + t / 2, w: s * 2 + t * 2, d: t },
    { x: -s - t / 2, z: 0, w: t, d: s * 2 },
    { x: s + t / 2, z: 0, w: t, d: s * 2 },
  ];
  for (const spec of specs) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(spec.w, h, spec.d), wallMat);
    mesh.position.set(spec.x, h / 2, spec.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

function buildObstacles(list) {
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 0.95 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x6b5d45, roughness: 0.9 });
  for (const o of list) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), baseMat);
    mesh.position.set(o.x, o.h / 2, o.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    const cap = new THREE.Mesh(new THREE.BoxGeometry(o.w + 0.3, 0.3, o.d + 0.3), capMat);
    cap.position.set(o.x, o.h + 0.15, o.z);
    cap.castShadow = true;
    cap.receiveShadow = true;
    scene.add(cap);
  }
}

// Frees GPU-side geometry/material buffers for every mesh in a subtree.
// scene.remove() alone only unlinks an Object3D from the scene graph — the
// WebGL buffers it owns are NOT freed until this is called, so every
// removal site below (bullets, pickups, tanks) must pair scene.remove()
// with this. Do NOT call this on anything using a shared/module-level
// geometry or material (e.g. the burst effect's shared sphere geometry —
// see updateBursts) since it would destroy a resource other live objects
// still reference.
function disposeObject3D(root) {
  root.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
      else child.material.dispose();
    }
  });
}

// ---------- Tank factory ----------
function createTankMesh(color) {
  const tankGroup = new THREE.Group();

  const baseColor = new THREE.Color(color);
  const turretColor = baseColor.clone().multiplyScalar(0.85);
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x1c1f22, roughness: 0.9, metalness: 0.2 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111315, roughness: 0.95 });

  const bodyPivot = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.6, metalness: 0.15 });

  const hull = new THREE.Mesh(new THREE.BoxGeometry(3.3, 1.0, 5.0), hullMat);
  hull.position.y = 0.75;
  hull.castShadow = true;
  hull.receiveShadow = true;
  bodyPivot.add(hull);

  const glacis = new THREE.Mesh(new THREE.BoxGeometry(2.85, 1.0, 1.6), hullMat);
  glacis.rotation.x = -0.45;
  glacis.position.set(0, 1.05, 2.0);
  glacis.castShadow = true;
  bodyPivot.add(glacis);

  const rearDeck = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.4, 1.3), hullMat);
  rearDeck.position.set(0, 1.35, -2.0);
  rearDeck.castShadow = true;
  bodyPivot.add(rearDeck);

  for (const side of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.85, 4.6), trimMat);
    skirt.position.set(side * 1.78, 0.85, 0);
    bodyPivot.add(skirt);

    const track = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.85, 4.0), trimMat);
    track.position.set(side * 1.85, 0.5, 0);
    track.castShadow = true;
    bodyPivot.add(track);

    for (const zEnd of [-2.0, 2.0]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.65, 10), trimMat);
      cap.rotation.z = Math.PI / 2;
      cap.position.set(side * 1.85, 0.5, zEnd);
      cap.castShadow = true;
      bodyPivot.add(cap);
    }

    for (let i = 0; i < 5; i++) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.72, 10), wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side * 1.85, 0.45, -1.8 + i * 0.9);
      bodyPivot.add(wheel);
    }
  }

  const turretPivot = new THREE.Group();
  const turretMat = new THREE.MeshStandardMaterial({ color: turretColor, roughness: 0.5, metalness: 0.25 });

  const turretRing = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.6, 0.22, 16), trimMat);
  turretRing.position.y = 1.28;
  turretRing.castShadow = true;
  turretPivot.add(turretRing);

  const turretMesh = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.5, 1.15, 16), turretMat);
  turretMesh.position.y = 1.85;
  turretMesh.castShadow = true;
  turretPivot.add(turretMesh);

  const bustle = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.85, 0.9), turretMat);
  bustle.position.set(0, 1.85, -0.85);
  bustle.castShadow = true;
  turretPivot.add(bustle);

  const mantlet = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.95, 0.5), turretMat);
  mantlet.position.set(0, 1.9, 1.0);
  mantlet.castShadow = true;
  turretPivot.add(mantlet);

  const barrelMesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 3.6), trimMat);
  barrelMesh.position.set(0, 1.9, 2.0);
  barrelMesh.castShadow = true;
  turretPivot.add(barrelMesh);

  const muzzleBrake = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.5, 10), trimMat);
  muzzleBrake.rotation.x = Math.PI / 2;
  muzzleBrake.position.set(0, 1.9, 3.7);
  muzzleBrake.castShadow = true;
  turretPivot.add(muzzleBrake);

  const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.2, 10), trimMat);
  hatch.position.set(0.3, 2.5, -0.5);
  turretPivot.add(hatch);

  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.0, 4), trimMat);
  antenna.position.set(0.75, 3.0, -0.9);
  antenna.rotation.z = 0.18;
  turretPivot.add(antenna);

  const shieldMat = new THREE.MeshBasicMaterial({
    color: 0x4da8ff,
    transparent: true,
    opacity: 0.28,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const shieldMesh = new THREE.Mesh(new THREE.SphereGeometry(2.8, 16, 12), shieldMat);
  shieldMesh.position.y = 1.4;
  shieldMesh.visible = false;
  tankGroup.add(shieldMesh);

  const invulnMat = new THREE.MeshBasicMaterial({
    color: 0xb35cff,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const invulnMesh = new THREE.Mesh(new THREE.SphereGeometry(3.1, 16, 12), invulnMat);
  invulnMesh.position.y = 1.4;
  invulnMesh.visible = false;
  tankGroup.add(invulnMesh);

  // Active support-weapon indicator — one ring whose color is set per-frame
  // from SUPPORT_META (see updateEntityMeshes), so every support type reuses
  // this same mesh instead of needing five bespoke models.
  const supportMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const supportMesh = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.12, 8, 24), supportMat);
  supportMesh.rotation.x = Math.PI / 2;
  supportMesh.position.y = 3.4;
  supportMesh.visible = false;
  tankGroup.add(supportMesh);

  // Slow/shock debuff indicator — a small ground ring, blue while slowed,
  // flickering white/red while a shock's fire-disable is active.
  const statusMat = new THREE.MeshBasicMaterial({
    color: 0x4da8ff,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const statusMesh = new THREE.Mesh(new THREE.RingGeometry(1.9, 2.15, 20), statusMat);
  statusMesh.rotation.x = -Math.PI / 2;
  statusMesh.position.y = 0.05;
  statusMesh.visible = false;
  tankGroup.add(statusMesh);

  tankGroup.add(bodyPivot);
  tankGroup.add(turretPivot);
  tankGroup.scale.setScalar(TANK_VISUAL_SCALE);
  scene.add(tankGroup);

  return { tankGroup, bodyPivot, turretPivot, shieldMesh, invulnMesh, supportMesh, statusMesh };
}

// ---------- Bullet visuals ----------
function createBulletMesh(kind) {
  const v = BULLET_VISUALS[kind] || BULLET_VISUALS.normal;
  const mat = new THREE.MeshStandardMaterial({ color: v.color, emissive: v.emissive, emissiveIntensity: 1.6 });
  // A wrapper group decouples "point this along the flight direction" (set
  // on the group each frame from vx/vz) from "lay the cylinder flat" (a
  // fixed local tilt on the mesh) so the two rotations can't fight.
  const group = new THREE.Group();
  let mesh;
  if (v.shape === 'bolt') {
    mesh = new THREE.Mesh(new THREE.CylinderGeometry(v.radius, v.radius, v.length, 8), mat);
    mesh.rotation.x = Math.PI / 2;
  } else {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(v.size, 10, 10), mat);
  }
  mesh.castShadow = true;
  group.add(mesh);
  scene.add(group);
  return group;
}

function createPickupMesh(kind) {
  const meta = PICKUP_META[kind] || PICKUP_META.armor;
  const group = new THREE.Group();
  // Support-weapon crates read as visually special/rarer on sight (section
  // 15): a larger, sharper-cut core with a brighter glow and a second outer
  // ring, instead of the plain single-ring look every ordinary buff/ammo
  // pickup uses.
  const isSupport = !!meta.support;

  const coreMat = new THREE.MeshStandardMaterial({
    color: meta.color,
    emissive: meta.color,
    emissiveIntensity: isSupport ? 1.1 : 0.65,
    roughness: 0.3,
    metalness: 0.4,
  });
  const coreGeo = isSupport ? new THREE.IcosahedronGeometry(1.05, 0) : new THREE.OctahedronGeometry(0.85, 0);
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.castShadow = true;
  group.add(core);

  const ringMat = new THREE.MeshBasicMaterial({
    color: meta.color,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.3, 24), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  group.add(ring);

  if (isSupport) {
    const outerRing = new THREE.Mesh(new THREE.RingGeometry(1.55, 1.75, 24), ringMat);
    outerRing.rotation.x = -Math.PI / 2;
    outerRing.position.y = 0.05;
    group.add(outerRing);
  }

  scene.add(group);

  const labelEl = document.createElement('div');
  labelEl.className = 'pickupLabel' + (isSupport ? ' pickupLabelSupport' : '');
  labelEl.textContent = meta.icon;
  document.body.appendChild(labelEl);

  return { group, core, labelEl };
}

const bursts = [];
// Kills (the only thing that spawns a burst) are infrequent compared to
// bullets/hits, so a full pool isn't worth the complexity here -- but the
// geometry is identical every time (only per-instance scale/opacity ever
// differ), so it's hoisted out to a single shared instance instead of
// rebuilding an identical vertex buffer on every kill. The material stays
// per-instance since opacity animates independently and multiple bursts
// can be fading at once; disposeObject3D is intentionally NOT used here
// because it would also dispose this shared geometry.
const _burstGeometry = new THREE.SphereGeometry(1, 10, 10);
function spawnBurst(x, z) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xff7722, transparent: true, opacity: 0.9 });
  const mesh = new THREE.Mesh(_burstGeometry, mat);
  mesh.position.set(x, 0.64, z);
  scene.add(mesh);
  bursts.push({ mesh, age: 0 });
}
function updateBursts(dt) {
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.age += dt;
    const t = b.age / 0.5;
    if (t >= 1) {
      scene.remove(b.mesh);
      b.mesh.material.dispose(); // per-instance -- the shared geometry above must NOT be disposed
      bursts.splice(i, 1);
      continue;
    }
    b.mesh.scale.setScalar(1 + t * 4);
    b.mesh.material.opacity = 0.9 * (1 - t);
  }
}

// ---------- Floating combat numbers (damage/heal) ----------
// Pooled: every hit/heal event spawns one of these, which during sustained
// combat can happen many times a second -- reusing hidden <div>s avoids a
// createElement+appendChild/remove cycle per hit.
const combatNumbers = [];
const combatNumberPool = [];
function spawnCombatNumber(x, z, text, kind) {
  let el = combatNumberPool.pop();
  if (!el) {
    el = document.createElement('div');
    document.body.appendChild(el);
  }
  el.className = 'combatNumber ' + kind;
  el.textContent = text;
  el.style.opacity = 1;
  combatNumbers.push({ el, x, z, age: 0 });
}
function updateCombatNumbers(dt) {
  for (let i = combatNumbers.length - 1; i >= 0; i--) {
    const n = combatNumbers[i];
    n.age += dt;
    const t = n.age / 0.9;
    if (t >= 1) {
      n.el.style.display = 'none';
      combatNumberPool.push(n.el);
      combatNumbers.splice(i, 1);
      continue;
    }
    const worldY = 1.9 + t * 1.4; // float upward in world space
    const screenPos = _scratchVec3.set(n.x, worldY, n.z).project(camera);
    if (screenPos.z > 1) {
      n.el.style.display = 'none';
      continue;
    }
    n.el.style.display = 'block';
    n.el.style.left = (screenPos.x * 0.5 + 0.5) * window.innerWidth + 'px';
    n.el.style.top = (-screenPos.y * 0.5 + 0.5) * window.innerHeight + 'px';
    n.el.style.opacity = 1 - t;
  }
}

// ---------- Networking / state ----------
const socket = io();

let selfId = null;
let mode = null; // 'arena' | 'campaign'
let latestStageStatus = null;
let stageResultShown = false;

const entities = new Map(); // id -> { mesh, nameTagEl, hpFillEl, render, target, alive, name, isBot, maxHp, hp, kills, deaths }
const bulletMeshes = new Map();
const bulletRender = new Map();
let latestBulletData = [];

const pickupMeshes = new Map(); // id -> { group, core, labelEl }
let latestPickupData = [];

let localDeathStart = 0;
let lastLowHpBeep = 0;
let lockedTargetId = null;

function angleDiff(a, b) {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

function angleLerp(a, b, t) {
  return a + angleDiff(a, b) * t;
}

function angleLerpCapped(a, b, maxStep) {
  const clamped = Math.max(-maxStep, Math.min(maxStep, angleDiff(a, b)));
  return a + clamped;
}

function ensureEntity(id, color) {
  let e = entities.get(id);
  if (e) return e;
  const mesh = createTankMesh(color);

  const nameTagEl = document.createElement('div');
  nameTagEl.className = 'nameTag';
  const hpOuter = document.createElement('div');
  hpOuter.className = 'nameTagHp';
  const hpFillEl = document.createElement('div');
  hpOuter.appendChild(hpFillEl);
  nameTagEl.appendChild(document.createElement('span'));
  nameTagEl.appendChild(hpOuter);
  document.body.appendChild(nameTagEl);

  e = {
    mesh,
    nameTagEl,
    hpFillEl,
    nameLabel: nameTagEl.querySelector('span'),
    render: { x: 0, z: 0, bodyRot: 0, turretRot: 0 },
    target: { x: 0, z: 0, bodyRot: 0, turretRot: 0 },
    alive: true,
    name: '',
    isBot: false,
    maxHp: 100,
    hp: 100,
    armorActive: false,
    armorExpiresAt: 0,
    speedActive: false,
    speedExpiresAt: 0,
    rapidfireActive: false,
    rapidfireExpiresAt: 0,
    invulnActive: false,
    invulnExpiresAt: 0,
    weaponType: 'normal',
    weaponExpiresAt: 0,
    slowActive: false,
    shockedActive: false,
    supportType: null,
    supportExpiresAt: 0,
  };
  entities.set(id, e);
  return e;
}

function removeEntity(id) {
  const e = entities.get(id);
  if (!e) return;
  scene.remove(e.mesh.tankGroup);
  disposeObject3D(e.mesh.tankGroup);
  e.nameTagEl.remove();
  entities.delete(id);
}

function resetGameState() {
  for (const id of Array.from(entities.keys())) removeEntity(id);
  for (const mesh of bulletMeshes.values()) {
    scene.remove(mesh);
    disposeObject3D(mesh);
  }
  bulletMeshes.clear();
  bulletRender.clear();
  latestBulletData = [];
  for (const entry of pickupMeshes.values()) {
    scene.remove(entry.group);
    disposeObject3D(entry.group);
    entry.labelEl.remove();
  }
  pickupMeshes.clear();
  latestPickupData = [];
  // Recycle rather than discard -- these divs are pool-managed (see
  // spawnCombatNumber) so a session reset should return them, not orphan
  // them outside the pool's bookkeeping.
  for (const n of combatNumbers) {
    n.el.style.display = 'none';
    combatNumberPool.push(n.el);
  }
  combatNumbers.length = 0;
  selfId = null;
  lockedTargetId = null;
  stageResultShown = false;
  latestStageStatus = null;
  stageResultOverlayEl.classList.add('hidden');
  deathBanner.classList.add('hidden');
  killfeedEl.innerHTML = '';
  keys.clear();
  firing = false;
  lmbDown = false;
  rmbDown = false;
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  Sound.stopEngine();
}

function addKillfeedEntry(html) {
  const div = document.createElement('div');
  div.className = 'killfeed-item';
  div.innerHTML = html;
  killfeedEl.appendChild(div);
  setTimeout(() => div.remove(), 5100);
  while (killfeedEl.children.length > 6) killfeedEl.removeChild(killfeedEl.firstChild);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Screen navigation ----------
function showPanel(name) {
  for (const el of [elPanelName, elPanelMenu, elPanelStages, elPanelGarage]) el.classList.add('hidden');
  loginOverlay.classList.remove('hidden');
  ({ name: elPanelName, menu: elPanelMenu, stages: elPanelStages, garage: elPanelGarage })[name].classList.remove('hidden');
}

function refreshMenuTexts() {
  menuNameEl.textContent = profile.name;
  menuCurrencyEl.textContent = profile.currency;
  hudCurrencyValueEl.textContent = profile.currency;
}

function renderStages() {
  stageGridEl.innerHTML = '';
  for (const s of STAGES_META) {
    const unlocked = s.id <= profile.unlockedStage;
    const card = document.createElement('div');
    card.className = 'stageCard' + (unlocked ? '' : ' locked');
    card.innerHTML = `
      <div class="stageName">${escapeHtml(s.name)}</div>
      <div class="stageMeta">${s.botCount} kẻ địch · +${s.reward} Xu</div>
      ${unlocked ? '' : '<div class="lockIcon">🔒</div>'}
    `;
    if (unlocked) card.addEventListener('click', () => startCampaign(s.id));
    stageGridEl.appendChild(card);
  }
}

function renderGarage() {
  garageCurrencyEl.textContent = profile.currency;
  upgradeListEl.innerHTML = '';
  for (const track of UPGRADE_TRACKS) {
    const lvl = profile.upgrades[track.key];
    const maxed = lvl >= MAX_UPGRADE_LEVEL;
    const cost = maxed ? null : UPGRADE_COST[lvl];
    let pips = '';
    for (let i = 0; i < MAX_UPGRADE_LEVEL; i++) pips += i < lvl ? '●' : '<span class="empty">●</span>';

    const row = document.createElement('div');
    row.className = 'upgradeRow';
    row.innerHTML = `
      <div class="upgradeInfo">
        <div class="upgradeName">${track.icon} ${track.label} (Lv.${lvl}/${MAX_UPGRADE_LEVEL})</div>
        <div class="upgradeValue">${track.fmt(lvl)}${maxed ? '' : ` → <span class="next">${track.fmt(lvl + 1)}</span>`}</div>
        <div class="upgradePips">${pips}</div>
      </div>
      <button class="upgradeBtn" ${maxed || profile.currency < cost ? 'disabled' : ''}>${maxed ? 'Tối đa' : `Nâng cấp (${cost} Xu)`}</button>
    `;
    row.querySelector('.upgradeBtn').addEventListener('click', () => tryUpgrade(track.key));
    upgradeListEl.appendChild(row);
  }
}

function tryUpgrade(trackKey) {
  const lvl = profile.upgrades[trackKey];
  if (lvl >= MAX_UPGRADE_LEVEL) return;
  const cost = UPGRADE_COST[lvl];
  if (profile.currency < cost) return;
  profile.currency -= cost;
  profile.upgrades[trackKey] = lvl + 1;
  saveProfile();
  renderGarage();
  refreshMenuTexts();
}

// ---------- Join / leave flow ----------
function joinGame(opts) {
  mode = opts.mode;
  loginOverlay.classList.add('hidden');
  socket.emit('join', {
    name: profile.name,
    mode: opts.mode,
    stage: opts.stage,
    loadout: profile.upgrades,
  });
}

function startCampaign(stageId) {
  joinGame({ mode: 'campaign', stage: stageId });
}

function leaveRoomAndGoMenu() {
  socket.emit('leaveRoom');
  resetGameState();
  hud.classList.remove('active');
  refreshMenuTexts();
  renderStages();
  showPanel('menu');
}

function leaveAndRejoinCampaign(stageId) {
  socket.emit('leaveRoom');
  resetGameState();
  startCampaign(stageId);
}

// ---------- UI wiring ----------
if (profile.name) {
  nameInputEl.value = profile.name;
  refreshMenuTexts();
  showPanel('menu');
} else {
  showPanel('name');
}

continueBtnEl.addEventListener('click', () => {
  const name = nameInputEl.value.trim();
  if (!name) {
    loginStatusEl.textContent = 'Vui lòng nhập tên.';
    return;
  }
  profile.name = name.slice(0, 16);
  saveProfile();
  loginStatusEl.textContent = '';
  refreshMenuTexts();
  showPanel('menu');
});
nameInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') continueBtnEl.click();
});
nameInputEl.focus();

changeNameLinkEl.addEventListener('click', (e) => {
  e.preventDefault();
  nameInputEl.value = profile.name;
  showPanel('name');
});

btnArenaEl.addEventListener('click', () => joinGame({ mode: 'arena' }));
btnCampaignEl.addEventListener('click', () => {
  renderStages();
  showPanel('stages');
});
btnGarageEl.addEventListener('click', () => {
  renderGarage();
  showPanel('garage');
});
stagesBackEl.addEventListener('click', () => showPanel('menu'));
garageBackEl.addEventListener('click', () => {
  refreshMenuTexts();
  showPanel('menu');
});

menuLeaveBtnEl.addEventListener('click', leaveRoomAndGoMenu);
btnStageMenuEl.addEventListener('click', leaveRoomAndGoMenu);
btnStageRetryEl.addEventListener('click', () => leaveAndRejoinCampaign(latestStageStatus.stageId));
btnStageNextEl.addEventListener('click', () => leaveAndRejoinCampaign(latestStageStatus.stageId + 1));

function refreshMuteBtn() {
  muteBtnEl.textContent = Sound.isMuted() ? '🔇' : '🔊';
}
muteBtnEl.addEventListener('click', () => {
  Sound.resume();
  Sound.setMuted(!Sound.isMuted());
  refreshMuteBtn();
});
refreshMuteBtn();

// Generic soft click blip for any HUD/menu button, skipping the touch
// fire/lock buttons (held rapidly, would spam the sound).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn && btn.id !== 'touchFireBtn' && btn.id !== 'touchLockBtn') Sound.click();
});

socket.on('connect_error', () => {
  loginStatusEl.textContent = 'Không thể kết nối tới máy chủ. Vui lòng thử lại.';
});

socket.on('joinError', (err) => {
  console.warn('joinError', err && err.message);
  resetGameState();
  hud.classList.remove('active');
  refreshMenuTexts();
  showPanel('menu');
});

// ---------- Game state sync ----------
function applySnapshot(snapshot, isInit) {
  const seen = new Set();
  for (const p of snapshot.players) {
    seen.add(p.id);
    const e = ensureEntity(p.id, p.color);
    e.name = p.name;
    e.isBot = !!p.isBot;
    e.nameTagEl.className = 'nameTag' + (p.isBot ? ' bot' : '');
    e.nameLabel.textContent = p.name + (p.id === selfId ? ' (bạn)' : '');
    e.target.x = p.x;
    e.target.z = p.z;
    e.target.bodyRot = p.bodyRot;
    e.target.turretRot = p.turretRot;
    e.hp = p.hp;
    e.maxHp = p.maxHp;
    e.kills = p.kills;
    e.deaths = p.deaths;
    e.alive = p.alive;
    e.armorActive = !!p.armorActive;
    e.armorExpiresAt = p.armorExpiresAt || 0;
    e.speedActive = !!p.speedActive;
    e.speedExpiresAt = p.speedExpiresAt || 0;
    e.rapidfireActive = !!p.rapidfireActive;
    e.rapidfireExpiresAt = p.rapidfireExpiresAt || 0;
    e.invulnActive = !!p.invulnActive;
    e.invulnExpiresAt = p.invulnExpiresAt || 0;
    e.weaponType = p.weaponType || 'normal';
    e.weaponExpiresAt = p.weaponExpiresAt || 0;
    e.slowActive = !!p.slowActive;
    e.shockedActive = !!p.shockedActive;
    e.supportType = p.supportType || null;
    e.supportExpiresAt = p.supportExpiresAt || 0;
    if (isInit) {
      e.render.x = p.x;
      e.render.z = p.z;
      e.render.bodyRot = p.bodyRot;
      e.render.turretRot = p.turretRot;
    }
  }
  for (const id of Array.from(entities.keys())) {
    if (!seen.has(id)) removeEntity(id);
  }
  updateScoreboard(snapshot.players);
}

function updateScoreboard(players) {
  const sorted = players.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  let html = '<div class="hdr">Bảng xếp hạng</div>';
  for (const p of sorted.slice(0, 8)) {
    const cls = p.id === selfId ? 'self' : p.isBot ? 'bot' : '';
    html += `<div class="row ${cls}"><span>${escapeHtml(p.name)}</span><span>${p.kills}/${p.deaths}</span></div>`;
  }
  scoreboardEl.innerHTML = html;
}

socket.on('init', (data) => {
  selfId = data.selfId;
  mode = data.mode;
  arenaHalfSize = data.arenaHalfSize;
  obstacles = data.obstacles;
  latestStageStatus = data.stageStatus || null;
  latestBulletData = data.snapshot.bullets;
  latestPickupData = data.snapshot.pickups || [];

  if (!worldBuilt) {
    buildGround();
    buildBoundaryWalls();
    buildObstacles(obstacles);
    buildProps();
    worldBuilt = true;
  }

  applySnapshot(data.snapshot, true);
  campaignBarEl.classList.toggle('hidden', mode !== 'campaign');
  loginOverlay.classList.add('hidden');
  hud.classList.add('active');
});

socket.on('playerJoined', (p) => {
  addKillfeedEntry(`<span class="k">${escapeHtml(p.name)}</span> đã vào trận`);
});

socket.on('playerLeft', (p) => {
  const e = entities.get(p.id);
  if (e) addKillfeedEntry(`${escapeHtml(e.name)} đã rời trận`);
  removeEntity(p.id);
});

socket.on('state', (msg) => {
  applySnapshot(msg.snapshot, false);
  latestBulletData = msg.snapshot.bullets;
  latestPickupData = msg.snapshot.pickups || [];
  latestStageStatus = msg.stageStatus || null;

  for (const ev of msg.events) {
    if (ev.type === 'hit' || ev.type === 'kill') {
      const attackerId = ev.type === 'kill' ? ev.killerId : ev.attackerId;
      const victim = entities.get(ev.victimId);
      if (victim && ev.amount > 0) {
        const kind = ev.victimId === selfId ? 'taken' : attackerId === selfId ? 'dealt' : 'neutral';
        spawnCombatNumber(victim.target.x, victim.target.z, '-' + ev.amount, kind);
        const mult = ev.victimId === selfId ? 1 : distVolMult(victim.target.x, victim.target.z);
        if (mult > 0.03) Sound.hit(mult);
      } else if (victim && ev.blocked) {
        spawnCombatNumber(victim.target.x, victim.target.z, 'Miễn nhiễm', 'blocked');
        const mult = ev.victimId === selfId ? 1 : distVolMult(victim.target.x, victim.target.z);
        if (mult > 0.03) Sound.blocked(mult);
      }
    }
    if (ev.type === 'kill') {
      const victim = entities.get(ev.victimId);
      if (victim) spawnBurst(victim.target.x, victim.target.z);
      const killerLabel = ev.killerId === selfId ? 'Bạn' : escapeHtml(ev.killerName);
      const victimLabel = ev.victimId === selfId ? 'Bạn' : escapeHtml(ev.victimName);
      addKillfeedEntry(`<span class="k">${killerLabel}</span> đã hạ <span class="v">${victimLabel}</span>`);
      const isSelfDeath = ev.victimId === selfId;
      const explMult = isSelfDeath ? 1 : victim ? distVolMult(victim.target.x, victim.target.z) : 0.3;
      Sound.explosion(Math.max(explMult, 0.15), isSelfDeath);
      if (isSelfDeath) localDeathStart = performance.now();
    } else if (ev.type === 'pickup') {
      const who = ev.playerId === selfId ? 'Bạn' : escapeHtml(ev.playerName);
      addKillfeedEntry(`${who} nhặt được <span class="k">${escapeHtml(ev.itemLabel)}</span>`);
      if (ev.playerId === selfId) Sound.pickup();
      if (ev.healAmount > 0) {
        const healer = entities.get(ev.playerId);
        if (healer) spawnCombatNumber(healer.target.x, healer.target.z, '+' + ev.healAmount, 'heal');
      }
      if (ev.supportType && ev.playerId === selfId) Sound.supportActivate();
    } else if (ev.type === 'supportExpired') {
      if (ev.playerId === selfId) Sound.supportExpire();
    } else if (ev.type === 'explosion') {
      spawnBurst(ev.x, ev.z);
      const mult = distVolMult(ev.x, ev.z);
      if (mult > 0.03) Sound.explosion(mult, false);
    }
  }

  if (latestStageStatus && latestStageStatus.finished && !stageResultShown) {
    showStageResult(latestStageStatus);
  }
});

function showStageResult(status) {
  stageResultShown = true;
  if (document.pointerLockElement === canvas) document.exitPointerLock();

  if (status.cleared) {
    profile.currency += status.reward;
    profile.unlockedStage = Math.min(
      STAGES_META.length || status.stageId + 1,
      Math.max(profile.unlockedStage, status.stageId + 1)
    );
    saveProfile();
    stageResultTitleEl.textContent = '🎉 Hoàn thành!';
    stageResultSubEl.textContent = `${status.stageName} — Nhận +${status.reward} Xu`;
    btnStageNextEl.classList.toggle('hidden', !STAGES_META.length || status.stageId >= STAGES_META.length);
    Sound.stageClear();
  } else {
    stageResultTitleEl.textContent = '💥 Thất bại';
    stageResultSubEl.textContent = `${status.stageName} — Thử lại nào!`;
    btnStageNextEl.classList.add('hidden');
    Sound.stageFailed();
  }
  stageResultOverlayEl.classList.remove('hidden');
}

// ---------- Input ----------
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

const keys = new Set();
let turretYaw = 0;
// Fixed, not adjustable by mouse/touch: aiming is left/right (yaw) only —
// a free-look vertical axis on top of that made the camera easy to lose
// control of, especially on a touch drag.
const camPitch = 0.3;
let firing = false;
let pointerLocked = false;
let lmbDown = false;
let rmbDown = false; // RMB held = ADS/zoom (see updateCamera); also half of the LMB+RMB lock chord
let lmbDownAt = 0; // performance.now() timestamp of the current LMB press, for chord-timing checks
let rmbDownAt = 0; // same, for RMB
const joystickVec = { x: 0, y: 0 }; // x = strafe right, y = forward, both -1..1

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space') firing = true;
  if (e.code === 'Tab' && hud.classList.contains('active')) {
    e.preventDefault();
    tryToggleLock();
  }
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Space') firing = false;
});

if (!isTouchDevice) {
  canvas.addEventListener('click', () => {
    if (loginOverlay.classList.contains('hidden') === false) return;
    if (!stageResultOverlayEl.classList.contains('hidden')) return;
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock();
    }
  });

  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
    if (!pointerLocked) {
      firing = false;
      lmbDown = false;
      rmbDown = false;
      // Losing pointer lock does NOT clear an active target lock — the lock
      // persists independent of button state and is only released by the
      // conditions in updateAimLock, or by a manual tryToggleLock.
    }
    // While the pointer is locked, ALL mouse events (per spec) are routed to
    // the locked element, so a real click on this button would never arrive —
    // hide it during aiming and reveal it once Esc releases the lock.
    menuLeaveBtnEl.classList.toggle('hidden', pointerLocked);
    muteBtnEl.classList.toggle('hidden', pointerLocked);
  });

  document.addEventListener('mousemove', (e) => {
    if (!pointerLocked) return;
    // Yaw only — camPitch is fixed (see its declaration) so aiming is a
    // single left/right axis, not a free-look that's easy to lose control of.
    // Sign is negated: with this game's forward-vector convention
    // (fx=sin(yaw), fz=cos(yaw)), increasing yaw turns the tank toward its
    // own LEFT, so movementX (mouse right = positive) must SUBTRACT from
    // yaw for "mouse right" to turn the tank/camera right on screen.
    // Mouse always drives aim, even while a target is locked (see
    // updateAimLock) — target lock is a soft assist layered on top each
    // frame, not a hard override, so the player can freely look elsewhere
    // (e.g. to pick a new target) without the mouse ever being frozen.
    // Slower/more precise while ADS-zoomed (RMB held), same as a real ADS.
    const sens = MOUSE_SENSITIVITY * (rmbDown ? ADS_SENS_MULT : 1);
    turretYaw -= e.movementX * sens;
  });

  // LMB = shoot, RMB = ADS. The two are independent EXCEPT for the special
  // case of a quick LMB+RMB chord (either order, within LOCK_COMBO_WINDOW_MS
  // of each other), which is target-lock activation instead of a shot: it
  // must never fire, so firing is forced off for that press. A slow/held
  // overlap (e.g. ADS for a while, then a LMB shot much later) is NOT a
  // chord — it's just ADS + a normal, independent shot — so only presses
  // that land close together in time are treated as the lock gesture.
  canvas.addEventListener('mousedown', (e) => {
    if (!pointerLocked) return;
    const now = performance.now();
    if (e.button === 0) {
      lmbDown = true;
      lmbDownAt = now;
      if (rmbDown && now - rmbDownAt <= LOCK_COMBO_WINDOW_MS) {
        attemptTargetLock();
        firing = false;
      } else {
        firing = true;
      }
    } else if (e.button === 2) {
      rmbDown = true;
      rmbDownAt = now;
      if (lmbDown && now - lmbDownAt <= LOCK_COMBO_WINDOW_MS) {
        attemptTargetLock();
        firing = false; // cancel whatever LMB-alone had already started
      }
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      firing = false;
      lmbDown = false;
    } else if (e.button === 2) {
      rmbDown = false;
    }
  });
  // RMB drives aim/zoom, not a context menu.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- Touch controls (mobile) ----------
// Left thumb: fixed on-screen joystick drives movement. Anywhere else on the
// canvas: drag to look/aim (turret + camera), tracked by touch identifier so
// it works at the same time as the joystick. Dedicated buttons fire and
// lock/unlock the nearest target. No Pointer Lock is used on touch at all.
let joystickTouchId = null;
let joystickCenter = { x: 0, y: 0 };
let lookTouchId = null;
let lookLastX = 0;

function setupTouchControls() {
  if (!isTouchDevice) return;
  document.body.classList.add('touch-mode');
  touchControlsEl.classList.remove('hidden');

  function updateJoystickFromTouch(t) {
    let dx = t.clientX - joystickCenter.x;
    let dy = t.clientY - joystickCenter.y;
    const dist = Math.hypot(dx, dy);
    if (dist > JOYSTICK_RADIUS) {
      dx = (dx / dist) * JOYSTICK_RADIUS;
      dy = (dy / dist) * JOYSTICK_RADIUS;
    }
    joystickVec.x = dx / JOYSTICK_RADIUS;
    joystickVec.y = -dy / JOYSTICK_RADIUS; // screen up = forward
    touchJoystickKnobEl.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  function resetJoystick() {
    joystickTouchId = null;
    joystickVec.x = 0;
    joystickVec.y = 0;
    touchJoystickKnobEl.style.transform = 'translate(0px, 0px)';
  }

  touchJoystickBaseEl.addEventListener(
    'touchstart',
    (e) => {
      if (joystickTouchId !== null) return;
      const t = e.changedTouches[0];
      joystickTouchId = t.identifier;
      const rect = touchJoystickBaseEl.getBoundingClientRect();
      joystickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      updateJoystickFromTouch(t);
      e.preventDefault();
    },
    { passive: false }
  );
  touchJoystickBaseEl.addEventListener(
    'touchmove',
    (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === joystickTouchId) updateJoystickFromTouch(t);
      }
      e.preventDefault();
    },
    { passive: false }
  );
  touchJoystickBaseEl.addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) if (t.identifier === joystickTouchId) resetJoystick();
  });
  touchJoystickBaseEl.addEventListener('touchcancel', resetJoystick);

  canvas.addEventListener(
    'touchstart',
    (e) => {
      for (const t of e.changedTouches) {
        // Only the right half of the screen aims. The joystick already
        // claims its own touches via DOM hit-testing, but without this a
        // thumb/palm resting on the LEFT side while operating the joystick
        // could still be picked up here and spuriously spin the turret.
        if (lookTouchId === null && t.clientX >= window.innerWidth / 2) {
          lookTouchId = t.identifier;
          lookLastX = t.clientX;
        }
      }
    },
    { passive: true }
  );
  canvas.addEventListener(
    'touchmove',
    (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== lookTouchId) continue;
        // Yaw only — camPitch is fixed (see its declaration) so aiming is a
        // single left/right axis, not a free-look that's easy to lose control of.
        const dx = t.clientX - lookLastX;
        lookLastX = t.clientX;
        // Sign negated to match the mouse fix above — see the comment on
        // the mousemove handler for why "+movementX" turns the tank left.
        // Always active, even while locked — see the mousemove handler comment.
        turretYaw -= dx * TOUCH_LOOK_SENSITIVITY;
      }
      e.preventDefault();
    },
    { passive: false }
  );
  function endLookTouch(e) {
    for (const t of e.changedTouches) if (t.identifier === lookTouchId) lookTouchId = null;
  }
  canvas.addEventListener('touchend', endLookTouch);
  canvas.addEventListener('touchcancel', endLookTouch);

  touchFireBtnEl.addEventListener(
    'touchstart',
    (e) => {
      firing = true;
      e.preventDefault();
    },
    { passive: false }
  );
  touchFireBtnEl.addEventListener(
    'touchend',
    (e) => {
      firing = false;
      e.preventDefault();
    },
    { passive: false }
  );
  touchFireBtnEl.addEventListener('touchcancel', () => {
    firing = false;
  });

  touchLockBtnEl.addEventListener(
    'touchstart',
    (e) => {
      tryToggleLock();
      e.preventDefault();
    },
    { passive: false }
  );
}
setupTouchControls();

function tryToggleLock() {
  if (lockedTargetId) {
    lockedTargetId = null;
    return;
  }
  const self = entities.get(selfId);
  if (!self) return;
  let best = null;
  let bestDist = Infinity;
  for (const [id, e] of entities) {
    if (id === selfId || !e.alive) continue;
    const d = Math.hypot(e.render.x - self.render.x, e.render.z - self.render.z);
    if (d < bestDist) {
      bestDist = d;
      best = id;
    }
  }
  lockedTargetId = best;
}

// Liang-Barsky segment/AABB clip test in the XZ plane — cheap line-of-sight
// check reusing the same obstacle boxes the server uses for collision.
function segmentIntersectsAabb(x1, z1, x2, z2, minX, minZ, maxX, maxZ) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  let t0 = 0;
  let t1 = 1;
  function clip(p, q) {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  }
  if (!clip(-dx, x1 - minX)) return false;
  if (!clip(dx, maxX - x1)) return false;
  if (!clip(-dz, z1 - minZ)) return false;
  if (!clip(dz, maxZ - z1)) return false;
  return t0 < t1;
}

function hasLineOfSight(x1, z1, x2, z2) {
  for (const o of obstacles) {
    if (segmentIntersectsAabb(x1, z1, x2, z2, o.x - o.w / 2, o.z - o.d / 2, o.x + o.w / 2, o.z + o.d / 2)) {
      return false;
    }
  }
  return true;
}

// LMB+RMB target acquisition: picks the valid, visible enemy whose direction
// from the player is closest to the current aim (turretYaw), within the
// lock-on cone/range — reuses the same lockedTargetId/updateAimLock system
// as the Tab/touch quick-lock so tracking, release-on-invalid, and HUD stay
// unified across both ways of acquiring a lock.
// Angle-from-tank (not a camera screen-space raycast) is deliberate: the
// tank's shooting direction is turretYaw regardless of where the chase-cam
// sits, so bore-sighting off turretYaw is what actually predicts which
// enemy the shot will hit — a camera raycast could disagree with it.
function pickCrosshairTarget() {
  const self = entities.get(selfId);
  if (!self || !self.alive) return null;
  let best = null;
  let bestAngle = LOCK_MAX_ANGLE;
  for (const [id, e] of entities) {
    if (id === selfId || !e.alive) continue;
    const dx = e.render.x - self.render.x;
    const dz = e.render.z - self.render.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.01 || dist > LOCK_MAX_RANGE) continue;
    const angle = Math.abs(angleDiff(turretYaw, Math.atan2(dx, dz)));
    if (angle > bestAngle) continue;
    if (!hasLineOfSight(self.render.x, self.render.z, e.render.x, e.render.z)) continue;
    bestAngle = angle;
    best = id;
  }
  return best;
}

// LMB+RMB target-lock activation: called synchronously, once, from the
// mousedown handler the instant the chord is recognized (see the timing
// check there) — NOT polled every frame, so it only ever runs exactly once
// per press. The lock it produces does not depend on the buttons staying
// down: release both immediately and the target stays locked (see
// updateAimLock, the only place a lock is cleared, aside from manual
// unlock via tryToggleLock).
// Calling this while a target is already locked re-picks under the
// crosshair and, if a different valid enemy is found, switches the lock to
// it; if nothing valid is under the crosshair, the current lock is left
// untouched rather than being cleared.
function attemptTargetLock() {
  const target = pickCrosshairTarget();
  if (target !== null) lockedTargetId = target;
}

function updateAimLock(dt) {
  if (!lockedTargetId) return;
  const target = entities.get(lockedTargetId);
  const self = entities.get(selfId);
  if (!target || !target.alive || !self) {
    lockedTargetId = null;
    return;
  }
  const dx = target.render.x - self.render.x;
  const dz = target.render.z - self.render.z;
  const dist = Math.hypot(dx, dz);
  if (dist > LOCK_MAX_RANGE || !hasLineOfSight(self.render.x, self.render.z, target.render.x, target.render.z)) {
    lockedTargetId = null;
    return;
  }
  // Soft assist, not a hard override: this nudges turretYaw toward the
  // target at a capped rate every frame, on top of whatever the mouse/touch
  // handlers already applied this frame. A deliberate manual turn (e.g. to
  // look at a different enemy before re-locking) easily outpaces this small
  // per-frame correction, so it never fights or overrides manual aim — it
  // just keeps the shot centered on the target when the player isn't
  // actively turning away from it.
  const desired = Math.atan2(dx, dz);
  turretYaw = angleLerpCapped(turretYaw, desired, LOCK_TURN_RATE * dt);
}

// Runs every frame, but the locked target only actually changes on a
// discrete event (acquire/switch/release) -- cache it so the DOM (a
// classList flip + a textContent write) is touched only on that frame,
// not all 60 of them while a lock sits unchanged.
let lastRenderedLockId = undefined;
function updateLockUI() {
  if (lockedTargetId === lastRenderedLockId) return;
  lastRenderedLockId = lockedTargetId;
  if (lockedTargetId && entities.has(lockedTargetId)) {
    crosshairEl.classList.add('locked');
    lockLabelEl.classList.remove('hidden');
    lockLabelEl.textContent = '🔒 ' + entities.get(lockedTargetId).name;
  } else {
    crosshairEl.classList.remove('locked');
    lockLabelEl.classList.add('hidden');
  }
}

function isBlockedByObstacle(x, z, pad) {
  for (const o of obstacles) {
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

// ---------- Main loop ----------
let lastFireTimeLocal = 0;
let fireCooldownLocal = 550;
let lastTime = performance.now();
let lastMoveMag = 0;

function currentLoadoutStats() {
  const u = profile.upgrades;
  const self = entities.get(selfId);
  const weaponMeta = WEAPON_META[(self && self.weaponType) || 'normal'] || WEAPON_META.normal;
  const speedMult = self && self.speedActive ? SPEED_BOOST_MULT : 1;
  const rapidMult = self && self.rapidfireActive ? RAPID_FIRE_MULT : 1;
  return {
    moveSpeed: UPGRADES.agilityMove[u.agility] * speedMult,
    fireCooldown: UPGRADES.rate[u.rate] * weaponMeta.cooldownMult * rapidMult,
  };
}

// Keyboard (normalized so a diagonal isn't faster) takes priority; falls
// back to the mobile joystick, which is already analog/pre-normalized.
function computeMoveVector() {
  let f = 0;
  let r = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) r += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) r -= 1;
  if (f !== 0 || r !== 0) {
    const len = Math.hypot(f, r);
    return { f: f / len, r: r / len };
  }
  return { f: joystickVec.y, r: joystickVec.x };
}

function sendInput() {
  if (!selfId) return;
  const move = computeMoveVector();
  socket.emit('input', {
    moveForward: move.f,
    moveRight: move.r,
    turretRot: turretYaw,
    firing,
    // Echoed purely so the sentinel support weapon (server-side) can prefer
    // this same target — see Game.js#_updateSupportWeapons. Never used by
    // the server for aiming/movement/damage.
    lockedTargetId,
  });
}
setInterval(sendInput, 50); // 20 Hz, matches server tick rate

function updateLocalPrediction(dt) {
  const self = entities.get(selfId);
  if (!self || !self.alive) {
    lastMoveMag = 0;
    return;
  }

  const stats = currentLoadoutStats();
  fireCooldownLocal = stats.fireCooldown;

  // Hull always faces the same way the turret aims (mouse/touch-driven) —
  // movement below is relative to that single facing direction: forward/back
  // and strafe left/right. This mirrors server/Game.js exactly.
  const bodyRot = turretYaw;
  const move = computeMoveVector();
  const moveForward = move.f;
  const moveRight = move.r;
  lastMoveMag = Math.hypot(moveForward, moveRight);

  let x = self.render.x;
  let z = self.render.z;
  if (moveForward !== 0 || moveRight !== 0) {
    const fx = Math.sin(bodyRot);
    const fz = Math.cos(bodyRot);
    // -PI/2 to match server/Game.js — see comment there.
    const rx = Math.sin(bodyRot - Math.PI / 2);
    const rz = Math.cos(bodyRot - Math.PI / 2);
    const dx = (fx * moveForward + rx * moveRight) * stats.moveSpeed * dt;
    const dz = (fz * moveForward + rz * moveRight) * stats.moveSpeed * dt;
    const nx = clamp(x + dx, -arenaHalfSize + TANK_RADIUS, arenaHalfSize - TANK_RADIUS);
    if (!isBlockedByObstacle(nx, z, TANK_RADIUS)) x = nx;
    const nz = clamp(z + dz, -arenaHalfSize + TANK_RADIUS, arenaHalfSize - TANK_RADIUS);
    if (!isBlockedByObstacle(x, nz, TANK_RADIUS)) z = nz;
  }

  self.render.bodyRot = bodyRot;
  self.render.x = x;
  self.render.z = z;
  self.render.turretRot = turretYaw;

  const correction = 0.06;
  self.render.x += (self.target.x - self.render.x) * correction;
  self.render.z += (self.target.z - self.render.z) * correction;
  self.render.bodyRot = angleLerp(self.render.bodyRot, self.target.bodyRot, correction);
}

function updateRemoteInterpolation() {
  const smoothing = 0.28;
  for (const [id, e] of entities) {
    if (id === selfId) continue;
    e.render.x += (e.target.x - e.render.x) * smoothing;
    e.render.z += (e.target.z - e.render.z) * smoothing;
    e.render.bodyRot = angleLerp(e.render.bodyRot, e.target.bodyRot, smoothing);
    e.render.turretRot = angleLerp(e.render.turretRot, e.target.turretRot, smoothing);
  }
}

// Shared scratch vector for the screen-space projections below
// (updateEntityMeshes/updatePickups/updateCombatNumbers) — these all run
// once per render frame, once per live object, and previously each did
// `new THREE.Vector3(...)` per object per frame purely to throw it away a
// line later. None of these call sites need the value to survive past its
// own immediate use, so one reused vector removes that per-frame garbage
// without changing any result.
const _scratchVec3 = new THREE.Vector3();

function updateEntityMeshes() {
  for (const [id, e] of entities) {
    const { tankGroup, bodyPivot, turretPivot, shieldMesh, invulnMesh, supportMesh, statusMesh } = e.mesh;
    tankGroup.position.set(e.render.x, 0, e.render.z);
    bodyPivot.rotation.y = e.render.bodyRot;
    turretPivot.rotation.y = e.render.turretRot;
    shieldMesh.visible = e.armorActive && e.alive;
    invulnMesh.visible = e.invulnActive && e.alive;
    if (invulnMesh.visible) {
      const pulse = 1 + Math.sin(performance.now() / 120) * 0.06;
      invulnMesh.scale.setScalar(pulse);
    }

    const supportVisible = !!e.supportType && e.alive;
    supportMesh.visible = supportVisible;
    if (supportVisible) {
      if (e._supportMeshType !== e.supportType) {
        e._supportMeshType = e.supportType;
        const meta = SUPPORT_META[e.supportType];
        if (meta) supportMesh.material.color.setHex(meta.color);
      }
      supportMesh.rotation.z = performance.now() / 800;
    }

    const statusVisible = (e.slowActive || e.shockedActive) && e.alive;
    statusMesh.visible = statusVisible;
    if (statusVisible) {
      // Shocked (weapon disabled) reads as an urgent flicker; a plain slow
      // (no shock) stays a calm, steady blue — same mesh, different color
      // driven by which debuff is actually active, cached like above so the
      // color isn't rewritten every single frame while unchanged.
      const wantFlicker = e.shockedActive;
      if (e._statusMeshFlicker !== wantFlicker) {
        e._statusMeshFlicker = wantFlicker;
        if (!wantFlicker) statusMesh.material.color.setHex(0x4da8ff);
      }
      if (wantFlicker) {
        const flicker = Math.sin(performance.now() / 70) > 0 ? 0xff4d4d : 0xffffff;
        statusMesh.material.color.setHex(flicker);
      }
    }

    tankGroup.visible = e.alive;

    const screenPos = _scratchVec3.set(e.render.x, 1.7, e.render.z).project(camera);
    const behindCamera = screenPos.z > 1;
    if (behindCamera || !e.alive) {
      if (e._nameTagShown !== false) {
        e._nameTagShown = false;
        e.nameTagEl.style.display = 'none';
      }
    } else {
      if (e._nameTagShown !== true) {
        e._nameTagShown = true;
        e.nameTagEl.style.display = 'block';
      }
      const sx = (screenPos.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-screenPos.y * 0.5 + 0.5) * window.innerHeight;
      e.nameTagEl.style.left = sx + 'px';
      e.nameTagEl.style.top = sy + 'px';
      // HP only changes on an actual hit/heal (far rarer than every render
      // frame) — skip the style writes entirely when it hasn't moved, same
      // pattern as updateHud below.
      const hpPct = Math.max(0, Math.min(100, (e.hp / e.maxHp) * 100));
      if (e._hpPct !== hpPct) {
        e._hpPct = hpPct;
        e.hpFillEl.style.width = hpPct + '%';
        e.hpFillEl.style.background = hpPct > 50 ? '#3ddc6c' : hpPct > 25 ? '#ffb020' : '#ff4d4d';
      }
    }
  }
}

function syncBullets() {
  const seen = new Set();
  for (const b of latestBulletData) {
    seen.add(b.id);
    let mesh = bulletMeshes.get(b.id);
    let r = bulletRender.get(b.id);
    if (!mesh) {
      mesh = createBulletMesh(b.kind);
      bulletMeshes.set(b.id, mesh);
      r = { x: b.x, z: b.z };
      bulletRender.set(b.id, r);
      // Self shots already get instant feedback from the local fire-cooldown
      // timer below — only sound freshly-seen bullets from others here.
      if (b.ownerId !== selfId) {
        const mult = distVolMult(b.x, b.z);
        if (mult > 0.03) Sound.shot(b.kind, mult);
      }
    }
    r.x += (b.x - r.x) * 0.5;
    r.z += (b.z - r.z) * 0.5;
    mesh.position.set(r.x, BULLET_HEIGHT, r.z);
    if (b.vx || b.vz) mesh.rotation.y = Math.atan2(b.vx, b.vz);
  }
  for (const [id, mesh] of bulletMeshes) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      disposeObject3D(mesh);
      bulletMeshes.delete(id);
      bulletRender.delete(id);
    }
  }
}

function syncPickups() {
  const seen = new Set();
  for (const pk of latestPickupData) {
    seen.add(pk.id);
    let entry = pickupMeshes.get(pk.id);
    if (!entry) {
      entry = createPickupMesh(pk.kind);
      pickupMeshes.set(pk.id, entry);
    }
    entry.x = pk.x;
    entry.z = pk.z;
  }
  for (const [id, entry] of pickupMeshes) {
    if (!seen.has(id)) {
      scene.remove(entry.group);
      disposeObject3D(entry.group);
      entry.labelEl.remove();
      pickupMeshes.delete(id);
    }
  }
}

function updatePickups(dt, tSec) {
  for (const entry of pickupMeshes.values()) {
    entry.group.position.set(entry.x, 0, entry.z);
    entry.core.rotation.y += dt * 1.6;
    entry.core.position.y = 1.1 + Math.sin(tSec * 2 + entry.x) * 0.15;

    const screenPos = _scratchVec3.set(entry.x, 2.1, entry.z).project(camera);
    if (screenPos.z > 1) {
      entry.labelEl.style.display = 'none';
      continue;
    }
    entry.labelEl.style.display = 'block';
    entry.labelEl.style.left = (screenPos.x * 0.5 + 0.5) * window.innerWidth + 'px';
    entry.labelEl.style.top = (-screenPos.y * 0.5 + 0.5) * window.innerHeight + 'px';
  }
}

let adsT = 0; // eased 0..1, 0 = normal view, 1 = fully ADS-zoomed (RMB held)

// RMB = ADS/zoom. Fully independent of target-lock — attemptTargetLock/
// updateAimLock never touch FOV or camera distance, so locking a target
// never triggers this. Kept deliberately modest (a moderate FOV drop plus
// a slight lean-in distance, both eased) so the player still reads the
// map/surroundings instead of tunneling in like binoculars.
function updateCamera(dt) {
  const self = entities.get(selfId);
  if (!self) return;
  const yaw = self.render.turretRot;
  const targetX = self.render.x;
  const targetZ = self.render.z;
  const targetY = 0.64;

  const adsTarget = rmbDown ? 1 : 0;
  adsT += (adsTarget - adsT) * Math.min(1, ADS_TRANSITION_SPEED * dt);
  const camDist = CAM_DIST - CAM_DIST * (1 - ADS_CAM_DIST_MULT) * adsT;
  const fov = BASE_FOV - (BASE_FOV - ADS_FOV) * adsT;

  const camX = targetX - Math.sin(yaw) * camDist * Math.cos(camPitch);
  const camZ = targetZ - Math.cos(yaw) * camDist * Math.cos(camPitch);
  const camY = targetY + camDist * Math.sin(camPitch) + CAM_BASE_HEIGHT * camPitch;

  camera.position.set(camX, camY + 2, camZ);
  camera.lookAt(targetX, targetY + 0.48, targetZ);

  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}

// updateHud() runs every render frame (~60/sec), but almost everything it
// shows only actually changes on a discrete game event (a hit, a pickup, a
// weapon swap) — far less often than 60/sec. Each field below is guarded by
// a cached "last written" value so the DOM is only touched when the value
// actually moved, instead of unconditionally re-writing (and, for the buffs
// list, re-parsing a whole innerHTML blob) every single frame regardless of
// whether anything changed. reloadBar is the one deliberate exception: it's
// a continuously-filling progress bar, so it must keep writing every frame
// or the fill animation would freeze.
let lastHudCurrency = null;
let lastHudStageName = null;
let lastHudEnemiesRemaining = null;
let lastHudHpPct = null;
let lastHudHpLabel = null;
let lastHudWeaponType = null;
let lastHudBuffsKey = null;
let lastHudSupportType = null;
let lastHudSupportTotalMs = 1; // captured on activation (server only sends expiresAt, not total duration)
let lastHudAlive = null;
let lastHudRespawnSec = null;

function updateHud() {
  const self = entities.get(selfId);
  if (profile.currency !== lastHudCurrency) {
    lastHudCurrency = profile.currency;
    hudCurrencyValueEl.textContent = profile.currency;
  }

  if (mode === 'campaign' && latestStageStatus) {
    if (latestStageStatus.stageName !== lastHudStageName) {
      lastHudStageName = latestStageStatus.stageName;
      campaignStageNameEl.textContent = latestStageStatus.stageName;
    }
    if (latestStageStatus.enemiesRemaining !== lastHudEnemiesRemaining) {
      lastHudEnemiesRemaining = latestStageStatus.enemiesRemaining;
      campaignEnemiesEl.textContent = latestStageStatus.enemiesRemaining;
    }
  }

  if (!self) return;
  const hpPct = Math.max(0, Math.min(100, (self.hp / self.maxHp) * 100));
  if (hpPct !== lastHudHpPct) {
    lastHudHpPct = hpPct;
    healthBar.style.width = hpPct + '%';
  }
  const hpLabel = `${Math.max(0, Math.round(self.hp))} / ${self.maxHp}`;
  if (hpLabel !== lastHudHpLabel) {
    lastHudHpLabel = hpLabel;
    healthLabel.textContent = hpLabel;
  }

  if (self.alive && hpPct > 0 && hpPct < 25) {
    const nowBeep = performance.now();
    if (nowBeep - lastLowHpBeep > 900) {
      Sound.lowHealthBeep();
      lastLowHpBeep = nowBeep;
    }
  }

  // Continuous fill animation -- intentionally NOT change-guarded.
  const sinceFire = Date.now() - lastFireTimeLocal;
  const reloadPct = Math.min(100, (sinceFire / fireCooldownLocal) * 100);
  reloadBar.style.width = reloadPct + '%';

  if (self.weaponType !== lastHudWeaponType) {
    lastHudWeaponType = self.weaponType;
    const weaponMeta = WEAPON_META[self.weaponType] || WEAPON_META.normal;
    weaponIconEl.textContent = weaponMeta.icon;
    weaponLabelEl.textContent = weaponMeta.label;
  }

  // The buffsKey captures every bit of state the rendered HTML depends on
  // (which buffs are active + their rounded remaining seconds) so the
  // (comparatively expensive) innerHTML rebuild below only runs on the
  // ~1/sec tick where a countdown digit actually changes, instead of 60x/sec.
  let buffsKey = '';
  let buffsHtml = '';
  const nowMs = Date.now();
  for (const key of ['armor', 'speed', 'rapidfire', 'invuln']) {
    if (!self[key + 'Active']) continue;
    const meta = BUFF_META[key];
    const remainingS = Math.max(0, Math.ceil((self[key + 'ExpiresAt'] - nowMs) / 1000));
    buffsKey += key + remainingS + '|';
    buffsHtml += `<div class="buffBadge buff-${key}">${meta.icon} ${remainingS}s</div>`;
  }
  if (buffsKey !== lastHudBuffsKey) {
    lastHudBuffsKey = buffsKey;
    activeBuffsEl.innerHTML = buffsHtml;
  }

  // Support-weapon panel: icon/label only change on activate/switch (change
  // -guarded like the buffs above), but the bar/countdown need to animate
  // continuously while active, same as reloadBar.
  if (self.supportType !== lastHudSupportType) {
    lastHudSupportType = self.supportType;
    supportPanelEl.classList.toggle('hidden', !self.supportType);
    if (self.supportType) {
      const meta = SUPPORT_META[self.supportType];
      if (meta) {
        supportPanelIconEl.textContent = meta.icon;
        supportPanelTypeEl.textContent = meta.label;
      }
      // Server only sends the expiry timestamp, not the total duration, so
      // the total (needed for the bar's fill percentage) is captured once
      // here, the moment activation is first observed.
      lastHudSupportTotalMs = Math.max(1, self.supportExpiresAt - nowMs);
    }
  }
  if (self.supportType) {
    const remainingMs = Math.max(0, self.supportExpiresAt - nowMs);
    supportPanelBarEl.style.width = Math.min(100, (remainingMs / lastHudSupportTotalMs) * 100) + '%';
    supportPanelTimeEl.textContent = (remainingMs / 1000).toFixed(1) + 's';
  }

  if (!self.alive) {
    if (lastHudAlive !== false) {
      lastHudAlive = false;
      deathBanner.classList.remove('hidden');
    }
    const remaining = Math.max(0, RESPAWN_DELAY_MS - (performance.now() - localDeathStart));
    const respawnSec = Math.ceil(remaining / 1000);
    if (respawnSec !== lastHudRespawnSec) {
      lastHudRespawnSec = respawnSec;
      respawnCountEl.textContent = respawnSec;
    }
  } else if (lastHudAlive !== true) {
    lastHudAlive = true;
    deathBanner.classList.add('hidden');
  }
}

// ---------- Minimap ----------
// Player-centered, rotating radar: the player is always drawn fixed at the
// minimap's center pointing straight up, and the world (obstacles, pickups,
// other entities) rotates/scrolls around them instead. This is "Design A"
// (map rotates, player icon fixed) rather than the previous fixed-map/
// rotating-icon layout, because a forward-locked radar is far easier to
// read in combat — "up" always means "where I'm facing," full stop.
//
// The rotation is driven ONLY by self.render.bodyRot — the exact same
// authoritative horizontal value the main chase camera and turret use (see
// updateCamera/updateLocalPrediction) — never raw mouse delta, never a
// locked target's bearing, and never camera pitch/FOV/ADS state. Concretely:
//   - ADS (updateCamera) only ever touches camera.fov/camera position; it
//     never writes bodyRot, so holding RMB cannot move the minimap.
//   - Target lock (updateAimLock) only ever writes turretYaw (which becomes
//     bodyRot next frame) as part of normal aiming — the SAME rotation the
//     player's own camera follows. The minimap therefore tracks the player's
//     true facing exactly like the main camera does; it never independently
//     turns toward the locked enemy.
//   - camPitch (look up/down) is a separate constant never read here, so
//     pitch cannot tilt the minimap.
function updateMinimap() {
  const self = entities.get(selfId);
  const size = minimapEl.width;
  const ctx = minimapCtx;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(8,12,18,0.55)';
  ctx.fillRect(0, 0, size, size);

  if (!self) return;

  const half = size / 2;
  const scale = size / (MINIMAP_RANGE * 2);
  const bodyRot = self.render.bodyRot; // horizontal-only — see the function comment above
  // Unrotated world→map projection (world +z → up, +x → right); this
  // convention is arbitrary (see server/Game.js's forward vector) but is
  // applied consistently to every object below, including the compass.
  const toMap = (x, z) => ({ px: x * scale, py: -z * scale });
  const playerP = toMap(self.render.x, self.render.z);

  // Counter-rotate (and re-center on the player) everything EXCEPT the
  // player's own icon: translate so the player's unrotated map position
  // lands at the origin, rotate by -bodyRot, then translate to the
  // minimap's center. Drawing the player's own icon inside this same
  // transform would also place it exactly at the center (its own offset
  // from itself is zero either way) — it's kept separate purely so it can
  // be drawn UNROTATED afterward; rotating it here too would double-rotate
  // it and point it the wrong way (see the fixed icon below).
  ctx.save();
  ctx.translate(half, half);
  ctx.rotate(-bodyRot);
  ctx.translate(-playerP.px, -playerP.py);

  ctx.fillStyle = 'rgba(150,160,175,0.6)';
  for (const o of obstacles) {
    const p = toMap(o.x - o.w / 2, o.z + o.d / 2);
    ctx.fillRect(p.px, p.py, o.w * scale, o.d * scale);
  }

  for (const pk of latestPickupData) {
    const meta = PICKUP_META[pk.kind];
    if (!meta) continue;
    const p = toMap(pk.x, pk.z);
    ctx.fillStyle = meta.hex;
    ctx.beginPath();
    ctx.arc(p.px, p.py, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const [id, e] of entities) {
    if (!e.alive || id === selfId) continue;
    const p = toMap(e.render.x, e.render.z);
    ctx.fillStyle = e.isBot ? '#ff8a8a' : '#e8edf4';
    ctx.beginPath();
    ctx.arc(p.px, p.py, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  // Compass "N" (world +z under the same convention as toMap above): swings
  // around the rim as the player turns, staying consistent with the
  // rotating world rather than a static letter.
  const northAngle = -bodyRot;
  const rimR = half - 9;
  const nx = half + Math.sin(northAngle) * rimR;
  const ny = half - Math.cos(northAngle) * rimR;
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', nx, ny);

  // Player marker: fixed at the exact center, always pointing straight up —
  // see the function comment for why this must stay unrotated.
  ctx.fillStyle = '#ffb020';
  ctx.beginPath();
  ctx.moveTo(half, half - 6);
  ctx.lineTo(half - 4.2, half + 4.5);
  ctx.lineTo(half + 4.2, half + 4.5);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
}

setInterval(() => {
  if (firing) {
    const now = Date.now();
    if (now - lastFireTimeLocal >= fireCooldownLocal) {
      lastFireTimeLocal = now;
      const self = entities.get(selfId);
      if (self && self.alive) Sound.shot(self.weaponType || 'normal', 1);
    }
  }
}, 30);

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  if (selfId) {
    updateAimLock(dt);
    updateLocalPrediction(dt);
    updateRemoteInterpolation();
    updateEntityMeshes();
    syncBullets();
    syncPickups();
    updatePickups(dt, now / 1000);
    updateBursts(dt);
    updateCombatNumbers(dt);
    updateCamera(dt);
    updateHud();
    updateLockUI();
    updateMinimap();
    Sound.updateEngine(lastMoveMag);
  }

  renderer.render(scene, camera);
}
animate();
