import * as THREE from 'three';
import { ParticleTree, TREE } from './ParticleTree.js';
import { SceneEffects } from './SceneEffects.js';
import { GiftRain, makeGift } from './GiftRain.js';
import { GestureController } from './GestureController.js';
import { AudioEngine } from './AudioEngine.js';
import { BeatDetector, demoBeat } from './BeatDetector.js';
import { BreathMapper } from './BreathMapper.js';
import { InteractionRouter } from './InteractionRouter.js';

const canvas = document.getElementById('scene');
const video = document.getElementById('cam');

const el = {
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loadingText'),
  loadingBar: document.getElementById('loadingBar'),
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  handCount: document.getElementById('handCount'),
  btnMusic: document.getElementById('btnMusic'),
  btnPause: document.getElementById('btnPause'),
  fileInput: document.getElementById('fileInput'),
  trackName: document.getElementById('trackName'),
  beatDot: document.getElementById('beatDot'),
  score: document.getElementById('score'),
  scoreNum: document.getElementById('scoreNum'),
  camOff: document.getElementById('camOff'),
  hints: Array.from(document.querySelectorAll('.hint')),
};

/* ---------------- 渲染器与场景 ---------------- */

if (!document.createElement('canvas').getContext('webgl2')) {
  document.getElementById('loadingText').textContent = '当前浏览器不支持 WebGL2，请用 Chrome / Edge 打开';
  throw new Error('WebGL2 unavailable');
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: 'high-performance',
  stencil: false,
});
const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.85);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070c);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 120);
camera.position.set(0, 5.3, 16.8);

const ambient = new THREE.AmbientLight(0x2b3c55, 0.75);
scene.add(ambient);

const key = new THREE.DirectionalLight(0xc3d8ff, 2.1);
key.position.set(-6, 12, 8);
scene.add(key);

const fill = new THREE.DirectionalLight(0x2c4260, 0.85);
fill.position.set(7, 4, -6);
scene.add(fill);

const tree = new ParticleTree(renderer);
scene.add(tree.group);

const effects = new SceneEffects(renderer, scene, camera, {
  width: window.innerWidth,
  height: window.innerHeight,
  pixelRatio,
});

const gifts = new GiftRain(scene, {
  onCatch: (count) => {
    el.score.classList.add('show');
    el.scoreNum.textContent = String(count);
  },
});

// 树下礼物堆：给画面一个重量感锚点
const pile = new THREE.Group();
for (let i = 0; i < 9; i++) {
  const g = makeGift();
  const a = (i / 9) * Math.PI * 2 + Math.random() * 0.4;
  const r = 3.0 + Math.random() * 0.9;
  g.position.set(Math.cos(a) * r, g.userData.size * 0.42, Math.sin(a) * r * 0.72);
  g.rotation.y = Math.random() * Math.PI * 2;
  g.scale.setScalar(0.88 + Math.random() * 0.18);
  pile.add(g);
}
scene.add(pile);

/* ---------------- 音频 / 手势 / 合并 ---------------- */

const audio = new AudioEngine();
const beatDetector = new BeatDetector();
const breath = new BreathMapper();
const router = new InteractionRouter();

let gestureState = { hands: [], handCount: 0, spread: null, tray: null };
let cameraReady = false;

const gesture = new GestureController({
  video,
  onEvent: (type, payload) => router.onEvent(type, payload),
  onStatus: (text) => {
    setStatus(text);
    if (!cameraReady) el.loadingText.textContent = text;
  },
});

/* ---------------- UI ---------------- */

function setStatus(text, warn = false) {
  el.statusText.textContent = text;
  el.status.classList.toggle('warn', warn);
}

function setLoading(pct, text) {
  el.loadingBar.style.width = `${pct}%`;
  if (text) el.loadingText.textContent = text;
}

el.btnMusic.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    setStatus('正在解码音频…');
    await audio.load(file);
    audio.play(0);
    beatDetector.reset();
    el.btnPause.disabled = false;
    el.btnPause.textContent = '暂停';
    el.trackName.textContent = audio.name;
    setStatus('音乐已接入 · 鼓点驱动呼吸');
  } catch (err) {
    console.error(err);
    setStatus('音频解码失败，换个文件试试', true);
  }
});

el.btnPause.addEventListener('click', () => {
  const playing = audio.toggle();
  el.btnPause.textContent = playing ? '暂停' : '继续';
});

document.addEventListener('pointerdown', () => {
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
});

/* ---------------- 指针视差 ---------------- */

const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
window.addEventListener('pointermove', (e) => {
  pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
  pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
});

/* ---------------- 主循环 ---------------- */

const clock = new THREE.Clock();
let beatFlashUntil = 0;

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const now = performance.now();

  gestureState = gesture.update(now);

  const levels = audio.getFrame();
  let beat;
  if (levels) {
    beat = beatDetector.update(levels, now, dt);
  } else {
    const d = demoBeat(now);
    beat = { pulse: d, hit: d > 0.82, bpm: 96 };
  }

  const music = breath.compute(levels, beat, t, dt);
  const params = router.update(dt, t, gestureState, music);

  tree.update(t, params);
  effects.update(t, params);
  gifts.update(dt, router.trayWorld);

  // 视差 + 轻微呼吸式推拉
  pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 3);
  pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 3);
  const push = params.explode * 0.9 + params.storm * 0.4;
  camera.position.x = pointer.x * 0.85;
  camera.position.y = 5.3 - pointer.y * 0.42;
  camera.position.z = 16.8 + push * 1.6;
  camera.lookAt(0, TREE.H * 0.545, 0);

  // UI 同步（降低频率，避免每帧写 DOM）
  if (beat.hit) {
    beatFlashUntil = now + 90;
    el.beatDot.classList.add('hit');
  } else if (now > beatFlashUntil) {
    el.beatDot.classList.remove('hit');
  }

  for (const h of el.hints) {
    h.classList.toggle('on', router.active.has(h.dataset.k));
  }
  el.handCount.textContent = String(gestureState.handCount);

  effects.render();
  requestAnimationFrame(tick);
}

/* ---------------- 尺寸 ---------------- */

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  effects.setSize(w, h, pixelRatio);
  tree.setPixelRatio(pixelRatio);
}
window.addEventListener('resize', resize);

/* ---------------- 启动 ---------------- */

async function boot() {
  setLoading(22, '正在唤醒雪夜…');
  await new Promise((r) => setTimeout(r, 120));

  tick();
  setLoading(48, '正在加载手势模型…');

  try {
    await gesture.init();
    cameraReady = true;
    el.camOff.style.display = 'none';
    setLoading(100, '准备好了');
    setStatus('举起双手 · 张开手掌试试');
    el.camOff.style.display = 'none';
    setTimeout(() => el.loading.classList.add('done'), 420);
  } catch (err) {
    console.error(err);
    cameraReady = false;
    setLoading(100, '摄像头不可用');
    setStatus('摄像头未授权 · 当前为音乐模式', true);
    el.camOff.textContent = '摄像头未授权';
    setTimeout(() => el.loading.classList.add('done'), 700);
  }
}

if (new URLSearchParams(location.search).has('debug')) {
  window.__app = { gesture, router, tree, effects, audio, gifts, breath, beatDetector };
}

boot();
