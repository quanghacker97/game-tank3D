'use strict';

// Must mirror server/constants.js so local prediction matches the
// authoritative simulation closely enough that server corrections stay tiny.
const MOVE_SPEED = 14;
const TURN_SPEED = 2.4;
const TANK_RADIUS = 2.3;
const RESPAWN_DELAY_MS = 3000;
const MOUSE_SENSITIVITY = 0.0022;
const PITCH_MIN = 0.05;
const PITCH_MAX = 0.9;
const CAM_DIST = 11;
const CAM_BASE_HEIGHT = 3;

// ---------- DOM ----------
const canvas = document.getElementById('scene');
const loginOverlay = document.getElementById('loginOverlay');
const nameInput = document.getElementById('nameInput');
const playBtn = document.getElementById('playBtn');
const loginStatus = document.getElementById('loginStatus');
const hud = document.getElementById('hud');
const healthBar = document.getElementById('healthBar');
const healthLabel = document.getElementById('healthLabel');
const reloadBar = document.getElementById('reloadBar');
const killfeedEl = document.getElementById('killfeed');
const scoreboardEl = document.getElementById('scoreboard');
const deathBanner = document.getElementById('deathBanner');
const respawnCountEl = document.getElementById('respawnCount');

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

// Lights
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

// Simple expanding-fade burst used for kill feedback.
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
let tankMaxHp = 100;

// entities: id -> { render, target, mesh:{...}, nameTagEl, hpFillEl, color, alive }
const entities = new Map();
const bulletMeshes = new Map(); // bulletId -> mesh

let localDeathStart = 0;

function angleLerp(a, b, t) {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
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

function addKillfeedEntry(html) {
  const div = document.createElement('div');
  div.className = 'killfeed-item';
  div.innerHTML = html;
  killfeedEl.appendChild(div);
  setTimeout(() => div.remove(), 5100);
  while (killfeedEl.children.length > 6) killfeedEl.removeChild(killfeedEl.firstChild);
}

socket.on('init', (data) => {
  selfId = data.selfId;
  arenaHalfSize = data.arenaHalfSize;
  obstacles = data.obstacles;
  tankMaxHp = data.tankMaxHp;

  buildGround();
  buildBoundaryWalls();
  buildObstacles(obstacles);

  applySnapshot(data.snapshot, true);
  loginOverlay.classList.add('hidden');
  hud.classList.add('active');
  canvas.requestPointerLock = canvas.requestPointerLock || canvas.mozRequestPointerLock;
});

socket.on('playerJoined', (p) => {
  addKillfeedEntry(`<span class="k">${escapeHtml(p.name)}</span> đã vào trận`);
});

socket.on('playerLeft', (p) => {
  const e = entities.get(p.id);
  if (e) addKillfeedEntry(`${escapeHtml(e.name)} đã rời trận`);
  removeEntity(p.id);
});

let latestBulletData = [];

socket.on('state', (msg) => {
  applySnapshot(msg.snapshot, false);
  latestBulletData = msg.snapshot.bullets;
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
});

function applySnapshot(snapshot, isInit) {
  const seen = new Set();
  for (const p of snapshot.players) {
    seen.add(p.id);
    const e = ensureEntity(p.id, p.color);
    e.name = p.name;
    e.nameLabel.textContent = p.name + (p.id === selfId ? ' (bạn)' : '');
    e.target.x = p.x;
    e.target.z = p.z;
    e.target.bodyRot = p.bodyRot;
    e.target.turretRot = p.turretRot;
    e.hp = p.hp;
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
    html += `<div class="row ${p.id === selfId ? 'self' : ''}"><span>${escapeHtml(p.name)}</span><span>${p.kills}/${p.deaths}</span></div>`;
  }
  scoreboardEl.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Space') firing = false;
});

canvas.addEventListener('click', () => {
  if (!loginOverlay.classList.contains('hidden')) return;
  if (document.pointerLockElement !== canvas) {
    canvas.requestPointerLock();
  }
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  if (!pointerLocked) firing = false;
});

document.addEventListener('mousemove', (e) => {
  if (!pointerLocked) return;
  turretYaw += e.movementX * MOUSE_SENSITIVITY;
  camPitch -= e.movementY * MOUSE_SENSITIVITY * 0.8;
  camPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, camPitch));
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0 && pointerLocked) firing = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) firing = false;
});

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

// ---------- Login flow ----------
function startGame() {
  const name = nameInput.value.trim() || 'Tank';
  loginStatus.textContent = '';
  playBtn.disabled = true;
  socket.emit('join', { name });
}
playBtn.addEventListener('click', startGame);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startGame();
});
nameInput.focus();

socket.on('connect_error', () => {
  loginStatus.textContent = 'Không thể kết nối tới máy chủ. Vui lòng thử lại.';
  playBtn.disabled = false;
});

// ---------- Main loop ----------
let lastFireTimeLocal = 0;
const FIRE_COOLDOWN_MS_LOCAL = 550;
let lastTime = performance.now();

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

  let bodyRot = self.render.bodyRot;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) bodyRot -= TURN_SPEED * dt;
  if (keys.has('KeyD') || keys.has('ArrowRight')) bodyRot += TURN_SPEED * dt;

  let moveDir = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) moveDir += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) moveDir -= 1;

  let x = self.render.x;
  let z = self.render.z;
  if (moveDir !== 0) {
    const dx = Math.sin(bodyRot) * moveDir * MOVE_SPEED * dt;
    const dz = Math.cos(bodyRot) * moveDir * MOVE_SPEED * dt;
    const nx = clamp(x + dx, -arenaHalfSize + TANK_RADIUS, arenaHalfSize - TANK_RADIUS);
    if (!isBlockedByObstacle(nx, z, TANK_RADIUS)) x = nx;
    const nz = clamp(z + dz, -arenaHalfSize + TANK_RADIUS, arenaHalfSize - TANK_RADIUS);
    if (!isBlockedByObstacle(x, nz, TANK_RADIUS)) z = nz;
  }

  self.render.bodyRot = bodyRot;
  self.render.x = x;
  self.render.z = z;
  self.render.turretRot = turretYaw;

  // Gently reconcile toward the server's authoritative position so small
  // divergences (e.g. collision-shape edge cases) don't accumulate.
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
      const hpPct = Math.max(0, Math.min(100, (e.hp / tankMaxHp) * 100));
      e.hpFillEl.style.width = hpPct + '%';
      e.hpFillEl.style.background = hpPct > 50 ? '#3ddc6c' : hpPct > 25 ? '#ffb020' : '#ff4d4d';
    }
  }
}

const bulletRender = new Map(); // id -> {x,z}

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
  if (!self) return;
  const hpPct = Math.max(0, Math.min(100, (self.hp / tankMaxHp) * 100));
  healthBar.style.width = hpPct + '%';
  healthLabel.textContent = `${Math.max(0, Math.round(self.hp))} / ${tankMaxHp}`;

  const sinceFire = Date.now() - lastFireTimeLocal;
  const reloadPct = Math.min(100, (sinceFire / FIRE_COOLDOWN_MS_LOCAL) * 100);
  reloadBar.style.width = reloadPct + '%';

  if (!self.alive) {
    deathBanner.classList.remove('hidden');
    const remaining = Math.max(0, RESPAWN_DELAY_MS - (performance.now() - localDeathStart));
    respawnCountEl.textContent = Math.ceil(remaining / 1000);
  } else {
    deathBanner.classList.add('hidden');
  }
}

// Track local fire cooldown purely for the UI reload bar.
setInterval(() => {
  if (firing) {
    const now = Date.now();
    if (now - lastFireTimeLocal >= FIRE_COOLDOWN_MS_LOCAL) lastFireTimeLocal = now;
  }
}, 30);

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  if (selfId) {
    updateLocalPrediction(dt);
    updateRemoteInterpolation();
    updateEntityMeshes();
    syncBullets();
    updateBursts(dt);
    updateCamera();
    updateHud();
  }

  renderer.render(scene, camera);
}
animate();
