'use strict';

// Must mirror server/constants.js so local prediction matches the
// authoritative simulation closely enough that server corrections stay tiny.
const TANK_RADIUS = 2.3;
const RESPAWN_DELAY_MS = 3000;
const MOUSE_SENSITIVITY = 0.0022;
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
  agilityTurn: [2.4, 2.6, 2.8, 3.0, 3.2, 3.4],
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

// ---------- Three.js setup ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x86b4e0);
scene.fog = new THREE.Fog(0x86b4e0, 60, 150);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 20, 20);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 0.9);
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

function buildGround() {
  const geo = new THREE.PlaneGeometry(arenaHalfSize * 2 + 40, arenaHalfSize * 2 + 40, 20, 20);
  const mat = new THREE.MeshStandardMaterial({ color: 0x4d7a3a, roughness: 1 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  scene.add(mesh);

  const grid = new THREE.GridHelper(arenaHalfSize * 2, arenaHalfSize / 5, 0x2a4a20, 0x2a4a20);
  grid.position.y = 0.01;
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  scene.add(grid);
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
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 0.95 });
  for (const o of list) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), mat);
    mesh.position.set(o.x, o.h / 2, o.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

// ---------- Tank factory ----------
function createTankMesh(color) {
  const tankGroup = new THREE.Group();

  const bodyPivot = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15 });
  const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.4, 4.6), bodyMat);
  bodyMesh.position.y = 1.0;
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyPivot.add(bodyMesh);

  const trackMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 1 });
  for (const side of [-1, 1]) {
    const track = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 5.0), trackMat);
    track.position.set(side * 1.75, 0.6, 0);
    track.castShadow = true;
    bodyPivot.add(track);
  }

  const turretPivot = new THREE.Group();
  const turretMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.25 });
  const turretMesh = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, 1.2, 16), turretMat);
  turretMesh.position.y = 1.9;
  turretMesh.castShadow = true;
  turretPivot.add(turretMesh);

  const barrelMesh = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 3.4), turretMat);
  barrelMesh.position.set(0, 1.9, 2.2);
  barrelMesh.castShadow = true;
  turretPivot.add(barrelMesh);

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
const keys = new Set();
let turretYaw = 0;
let camPitch = 0.3;
let firing = false;
let pointerLocked = false;

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
    turnSpeed: UPGRADES.agilityTurn[u.agility],
    fireCooldown: UPGRADES.rate[u.rate],
  };
}

function sendInput() {
  if (!selfId) return;
  socket.emit('input', {
    forward: keys.has('KeyW') || keys.has('ArrowUp'),
    back: keys.has('KeyS') || keys.has('ArrowDown'),
    left: keys.has('KeyA') || keys.has('ArrowLeft'),
    right: keys.has('KeyD') || keys.has('ArrowRight'),
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

  let bodyRot = self.render.bodyRot;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) bodyRot -= stats.turnSpeed * dt;
  if (keys.has('KeyD') || keys.has('ArrowRight')) bodyRot += stats.turnSpeed * dt;

  let moveDir = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) moveDir += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) moveDir -= 1;

  let x = self.render.x;
  let z = self.render.z;
  if (moveDir !== 0) {
    const dx = Math.sin(bodyRot) * moveDir * stats.moveSpeed * dt;
    const dz = Math.cos(bodyRot) * moveDir * stats.moveSpeed * dt;
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
