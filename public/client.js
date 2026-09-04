'use strict';

// Must mirror server/constants.js so local prediction matches the
// authoritative simulation closely enough that server corrections stay tiny.
const TANK_RADIUS = 2.3;
const RESPAWN_DELAY_MS = 3000;
const MOUSE_SENSITIVITY = 0.0022;
const TOUCH_LOOK_SENSITIVITY = 0.0026;
const JOYSTICK_RADIUS = 48; // px, matches #touchJoystickBase knob travel
const PITCH_MIN = 0.05;
const PITCH_MAX = 0.9;
const CAM_DIST = 11;
const CAM_BASE_HEIGHT = 3;
const LOCK_TURN_RATE = 3.0; // rad/sec turret tracking speed while target-locked
const LOCK_MAX_RANGE = 90;

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
const healthBar = document.getElementById('healthBar');
const healthLabel = document.getElementById('healthLabel');
const reloadBar = document.getElementById('reloadBar');
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

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 500);
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

  tankGroup.add(bodyPivot);
  tankGroup.add(turretPivot);
  scene.add(tankGroup);

  return { tankGroup, bodyPivot, turretPivot };
}

// ---------- Bullet visuals ----------
const bulletMat = new THREE.MeshStandardMaterial({ color: 0xffcc33, emissive: 0xff9900, emissiveIntensity: 1.5 });
const bulletGeo = new THREE.SphereGeometry(0.4, 8, 8);
function createBulletMesh() {
  const mesh = new THREE.Mesh(bulletGeo, bulletMat);
  mesh.castShadow = true;
  scene.add(mesh);
  return mesh;
}

const bursts = [];
function spawnBurst(x, z) {
  const geo = new THREE.SphereGeometry(1, 10, 10);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff7722, transparent: true, opacity: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 1.6, z);
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
      bursts.splice(i, 1);
      continue;
    }
    b.mesh.scale.setScalar(1 + t * 4);
    b.mesh.material.opacity = 0.9 * (1 - t);
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

let localDeathStart = 0;
let lockedTargetId = null;

function angleLerp(a, b, t) {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

function angleLerpCapped(a, b, maxStep) {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  const clamped = Math.max(-maxStep, Math.min(maxStep, diff));
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
  };
  entities.set(id, e);
  return e;
}

function removeEntity(id) {
  const e = entities.get(id);
  if (!e) return;
  scene.remove(e.mesh.tankGroup);
  e.nameTagEl.remove();
  entities.delete(id);
}

function resetGameState() {
  for (const id of Array.from(entities.keys())) removeEntity(id);
  for (const mesh of bulletMeshes.values()) scene.remove(mesh);
  bulletMeshes.clear();
  bulletRender.clear();
  latestBulletData = [];
  selfId = null;
  lockedTargetId = null;
  stageResultShown = false;
  latestStageStatus = null;
  stageResultOverlayEl.classList.add('hidden');
  deathBanner.classList.add('hidden');
  killfeedEl.innerHTML = '';
  keys.clear();
  firing = false;
  if (document.pointerLockElement === canvas) document.exitPointerLock();
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
  latestStageStatus = msg.stageStatus || null;

  for (const ev of msg.events) {
    if (ev.type === 'kill') {
      const victim = entities.get(ev.victimId);
      if (victim) spawnBurst(victim.target.x, victim.target.z);
      const killerLabel = ev.killerId === selfId ? 'Bạn' : escapeHtml(ev.killerName);
      const victimLabel = ev.victimId === selfId ? 'Bạn' : escapeHtml(ev.victimName);
      addKillfeedEntry(`<span class="k">${killerLabel}</span> đã hạ <span class="v">${victimLabel}</span>`);
      if (ev.victimId === selfId) localDeathStart = performance.now();
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
  } else {
    stageResultTitleEl.textContent = '💥 Thất bại';
    stageResultSubEl.textContent = `${status.stageName} — Thử lại nào!`;
    btnStageNextEl.classList.add('hidden');
  }
  stageResultOverlayEl.classList.remove('hidden');
}

// ---------- Input ----------
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;

const keys = new Set();
let turretYaw = 0;
let camPitch = 0.3;
let firing = false;
let pointerLocked = false;
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
    if (!pointerLocked) firing = false;
    // While the pointer is locked, ALL mouse events (per spec) are routed to
    // the locked element, so a real click on this button would never arrive —
    // hide it during aiming and reveal it once Esc releases the lock.
    menuLeaveBtnEl.classList.toggle('hidden', pointerLocked);
  });

  document.addEventListener('mousemove', (e) => {
    if (!pointerLocked) return;
    if (!lockedTargetId) turretYaw += e.movementX * MOUSE_SENSITIVITY;
    camPitch -= e.movementY * MOUSE_SENSITIVITY * 0.8;
    camPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, camPitch));
  });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0 && pointerLocked) firing = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) firing = false;
  });
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
let lookLastY = 0;

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
        if (lookTouchId === null) {
          lookTouchId = t.identifier;
          lookLastX = t.clientX;
          lookLastY = t.clientY;
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
        const dx = t.clientX - lookLastX;
        const dy = t.clientY - lookLastY;
        lookLastX = t.clientX;
        lookLastY = t.clientY;
        if (!lockedTargetId) turretYaw += dx * TOUCH_LOOK_SENSITIVITY;
        camPitch -= dy * TOUCH_LOOK_SENSITIVITY * 0.8;
        camPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, camPitch));
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
  if (dist > LOCK_MAX_RANGE) {
    lockedTargetId = null;
    return;
  }
  const desired = Math.atan2(dx, dz);
  turretYaw = angleLerpCapped(turretYaw, desired, LOCK_TURN_RATE * dt);
}

function updateLockUI() {
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

function currentLoadoutStats() {
  const u = profile.upgrades;
  return {
    moveSpeed: UPGRADES.agilityMove[u.agility],
    fireCooldown: UPGRADES.rate[u.rate],
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
  });
}
setInterval(sendInput, 50); // 20 Hz, matches server tick rate

function updateLocalPrediction(dt) {
  const self = entities.get(selfId);
  if (!self || !self.alive) return;

  const stats = currentLoadoutStats();
  fireCooldownLocal = stats.fireCooldown;

  // Hull always faces the same way the turret aims (mouse/touch-driven) —
  // movement below is relative to that single facing direction: forward/back
  // and strafe left/right. This mirrors server/Game.js exactly.
  const bodyRot = turretYaw;
  const move = computeMoveVector();
  const moveForward = move.f;
  const moveRight = move.r;

  let x = self.render.x;
  let z = self.render.z;
  if (moveForward !== 0 || moveRight !== 0) {
    const fx = Math.sin(bodyRot);
    const fz = Math.cos(bodyRot);
    const rx = Math.sin(bodyRot + Math.PI / 2);
    const rz = Math.cos(bodyRot + Math.PI / 2);
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

function updateEntityMeshes() {
  for (const [id, e] of entities) {
    const { tankGroup, bodyPivot, turretPivot } = e.mesh;
    tankGroup.position.set(e.render.x, 0, e.render.z);
    bodyPivot.rotation.y = e.render.bodyRot;
    turretPivot.rotation.y = e.render.turretRot;
    tankGroup.visible = e.alive;

    const screenPos = new THREE.Vector3(e.render.x, 3.4, e.render.z).project(camera);
    const behindCamera = screenPos.z > 1;
    if (behindCamera || !e.alive) {
      e.nameTagEl.style.display = 'none';
    } else {
      e.nameTagEl.style.display = 'block';
      const sx = (screenPos.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-screenPos.y * 0.5 + 0.5) * window.innerHeight;
      e.nameTagEl.style.left = sx + 'px';
      e.nameTagEl.style.top = sy + 'px';
      const hpPct = Math.max(0, Math.min(100, (e.hp / e.maxHp) * 100));
      e.hpFillEl.style.width = hpPct + '%';
      e.hpFillEl.style.background = hpPct > 50 ? '#3ddc6c' : hpPct > 25 ? '#ffb020' : '#ff4d4d';
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
      mesh = createBulletMesh();
      bulletMeshes.set(b.id, mesh);
      r = { x: b.x, z: b.z };
      bulletRender.set(b.id, r);
    }
    r.x += (b.x - r.x) * 0.5;
    r.z += (b.z - r.z) * 0.5;
    mesh.position.set(r.x, 1.7, r.z);
  }
  for (const [id, mesh] of bulletMeshes) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      bulletMeshes.delete(id);
      bulletRender.delete(id);
    }
  }
}

function updateCamera() {
  const self = entities.get(selfId);
  if (!self) return;
  const yaw = self.render.turretRot;
  const targetX = self.render.x;
  const targetZ = self.render.z;
  const targetY = 1.6;

  const camX = targetX - Math.sin(yaw) * CAM_DIST * Math.cos(camPitch);
  const camZ = targetZ - Math.cos(yaw) * CAM_DIST * Math.cos(camPitch);
  const camY = targetY + CAM_DIST * Math.sin(camPitch) + CAM_BASE_HEIGHT * camPitch;

  camera.position.set(camX, camY + 2, camZ);
  camera.lookAt(targetX, targetY + 1.2, targetZ);
}

function updateHud() {
  const self = entities.get(selfId);
  hudCurrencyValueEl.textContent = profile.currency;

  if (mode === 'campaign' && latestStageStatus) {
    campaignStageNameEl.textContent = latestStageStatus.stageName;
    campaignEnemiesEl.textContent = latestStageStatus.enemiesRemaining;
  }

  if (!self) return;
  const hpPct = Math.max(0, Math.min(100, (self.hp / self.maxHp) * 100));
  healthBar.style.width = hpPct + '%';
  healthLabel.textContent = `${Math.max(0, Math.round(self.hp))} / ${self.maxHp}`;

  const sinceFire = Date.now() - lastFireTimeLocal;
  const reloadPct = Math.min(100, (sinceFire / fireCooldownLocal) * 100);
  reloadBar.style.width = reloadPct + '%';

  if (!self.alive) {
    deathBanner.classList.remove('hidden');
    const remaining = Math.max(0, RESPAWN_DELAY_MS - (performance.now() - localDeathStart));
    respawnCountEl.textContent = Math.ceil(remaining / 1000);
  } else {
    deathBanner.classList.add('hidden');
  }
}

setInterval(() => {
  if (firing) {
    const now = Date.now();
    if (now - lastFireTimeLocal >= fireCooldownLocal) lastFireTimeLocal = now;
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
    updateBursts(dt);
    updateCamera();
    updateHud();
    updateLockUI();
  }

  renderer.render(scene, camera);
}
animate();
