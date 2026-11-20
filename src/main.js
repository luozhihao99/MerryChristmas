import * as THREE from 'three';
import { ParticleTree, configureQuality, TREE } from './ParticleTree.js';
import { SceneEffects } from './SceneEffects.js';
import { GiftRain, makeGift } from './GiftRain.js';
import { HeartEffect } from './HeartEffect.js';
import { LoveMessage } from './LoveMessage.js';
import { CallDanmaku } from './CallDanmaku.js';
import { LikeBurst } from './LikeBurst.js';
import { GestureController } from './GestureController.js';
import { AudioEngine } from './AudioEngine.js';
import { BeatDetector, demoBeat } from './BeatDetector.js';
import { BreathMapper } from './BreathMapper.js';
import { InteractionRouter } from './InteractionRouter.js';
import { prefetchHandModel } from './assetLoader.js';
import { GESTURE_SWITCH } from './gestureConfig.js';
import { DEFAULT_MUSIC, DEFAULT_MUSIC_NAME } from './appConfig.js';

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
  probe: document.getElementById('probe'),
  hints: Array.from(document.querySelectorAll('.hint')),
};

// 被 GESTURE_SWITCH 关掉的手势，连提示条一起藏掉，
// 免得用户照着「握拳」去比划却什么也不发生。
// 提示条的 data-k 不一定和开关同名（「张开」那条是 data-k="open"，实际归 burst 管），
// 对不上的在这里映射一下。
const HINT_SWITCH = { open: 'burst' };
for (const h of el.hints) {
  const key = HINT_SWITCH[h.dataset.k] || h.dataset.k;
  if (GESTURE_SWITCH[key] === false) h.hidden = true;
}

/* ---------------- 设备档位 ---------------- */

// 触屏设备 / 低核心数：粒子减半、像素比收紧，首帧构建和上传都更快
const lowPower = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency || 8) <= 4;
if (lowPower) configureQuality({ needle: 16000, dust: 900, lights: 150 });

/* ---------------- 模型预取 ---------------- */
// 关键：在场景构建（主线程要卡几百毫秒）之前发出请求，
// 让 7.6MB 模型下载与建树、编译着色器同时进行，而不是排在其后。
const cameraPossible =
  window.isSecureContext && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

let modelProgress = { phase: 'model', loaded: 0, total: 0 };

// 摄像头不可用（手机走 http 局域网就是这种）时，下 9MB 模型纯属浪费，直接跳过
const modelPrefetch = cameraPossible
  ? prefetchHandModel({
      onProgress: (p) => {
        modelProgress = { ...modelProgress, ...p };
        renderModelProgress();
      },
    }).catch((err) => {
      console.warn('[boot] 模型预取失败，交给 MediaPipe 自行加载', err);
      return null;
    })
  : Promise.resolve(null);

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
const pixelRatio = Math.min(window.devicePixelRatio || 1, lowPower ? 1.5 : 1.85);
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

// 比心结束后的收尾：散开的粒子拼成 I love you，停留几秒再被风吹散
const loveMsg = new LoveMessage(scene, { count: lowPower ? 1200 : 2200 });

// 打电话手势（拇指 + 小指伸出）：粒子从树冠升起，拼成三行花体字，停一会儿再被风吹散
const danmaku = new CallDanmaku(scene, { count: lowPower ? 8000 : 16000 });

// 点赞手势（拇指竖起）：粒子勾出五角星 + 666，停一会儿被风吹散
const like = new LikeBurst(scene, { count: lowPower ? 5000 : 9000 });

// 双手比心：心形光尘。心形熄灭时把位置与缩放交给文字特效，粒子从心形起飞
const heart = new HeartEffect(scene, {
  onEnd: (pos, scale) => loveMsg.trigger(pos, scale),
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

let gestureState = { hands: [], handCount: 0, spread: null, tray: null, heart: null };
let cameraReady = false;

const gesture = new GestureController({
  video,
  onEvent: (type, payload) => {
    router.onEvent(type, payload);
    // 打电话：弹幕播完之前不重复触发（手势一直比着也只放一轮）
    // 用 elapsedTime 属性而不是 getElapsedTime()：后者会内部推进时钟，扰动这一帧的 dt
    if (type === 'call' && !danmaku.busy) danmaku.trigger(clock.elapsedTime);
    // 点赞：一轮没放完不叠下一轮（手势一直比着也只放一次）
    if (type === 'like' && !like.busy) like.trigger(clock.elapsedTime);
  },
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

/** 摄像头面板在模型就绪前显示下载进度，避免用户以为是卡住了 */
function renderModelProgress() {
  if (cameraReady) return;
  const { phase, loaded = 0, total = 0, fromCache } = modelProgress;
  const mb = (loaded / 1048576).toFixed(1);

  if (phase === 'wasm') {
    el.camOff.textContent = '模型组件已就绪';
  } else if (phase === 'init') {
    el.camOff.textContent = '正在初始化模型…';
  } else if (fromCache) {
    el.camOff.textContent = '模型已缓存 · 正在启动';
  } else if (total > 0) {
    const pct = Math.min(99, Math.round((loaded / total) * 100));
    el.camOff.textContent = `模型 ${pct}%`;
  } else {
    el.camOff.textContent = `模型 ${mb} MB`;
  }
}

el.btnMusic.addEventListener('click', () => el.fileInput.click());

/* ---------------- 音乐说明气泡 ---------------- */

const btnHelp = document.getElementById('btnHelp');
const musicHelp = document.getElementById('musicHelp');

btnHelp.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = musicHelp.hidden;
  musicHelp.hidden = !open;
  btnHelp.setAttribute('aria-expanded', String(open));
});

document.addEventListener('click', (e) => {
  if (musicHelp.hidden) return;
  if (musicHelp.contains(e.target) || btnHelp.contains(e.target)) return;
  musicHelp.hidden = true;
  btnHelp.setAttribute('aria-expanded', 'false');
});

// 微信内置浏览器不允许选择文件，提前说明，别让用户以为是页面坏了
if (/MicroMessenger/i.test(navigator.userAgent) && !audio.playing) {
  el.trackName.textContent = '微信内不能选文件 · 请用浏览器打开';
}

/* ---------------- 音频加载 ---------------- */

function audioErrorText(err) {
  const code = err && err.code;
  const name = err && err.name;
  if (code === 'empty') return '这个文件是空的 · 换一个试试';
  if (code === 'unsupported' || name === 'NotSupportedError') {
    return '浏览器解不开这个格式 · 换 mp3 / m4a 试试（带版权保护的曲子不行）';
  }
  if (name === 'EncodingError') return '音频编码不支持 · 换标准 mp3 试试';
  return '音频加载失败 · 换 mp3 / m4a 试试，点 ? 看说明';
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

async function loadAudioFile(file) {
  if (!file) return;
  try {
    el.trackName.textContent = '正在读取…';
    setStatus('正在解码音频…');
    const { duration, mode } = await audio.load(file);
    defaultMusicArmed = false;
    audio.play(0);
    beatDetector.reset();
    el.btnPause.disabled = false;
    el.btnPause.textContent = '暂停';
    el.trackName.textContent = audio.name;
    const len = fmtTime(duration);
    setStatus(`${audio.name}${len ? ' · ' + len : ''} · ${mode === 'element' ? '流式播放' : '鼓点驱动呼吸'}`);
  } catch (err) {
    console.error(err);
    el.trackName.textContent = '加载失败 · 点 ? 看支持格式';
    setStatus(audioErrorText(err), true);
  }
}

el.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  await loadAudioFile(file);
  // 允许重复选同一个文件
  e.target.value = '';
});

// 桌面端也可以直接把音频拖进窗口
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  if (f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(f.name)) loadAudioFile(f);
});

el.btnPause.addEventListener('click', () => {
  const playing = audio.toggle();
  el.btnPause.textContent = playing ? '暂停' : '继续';
});

/* ---------------- 默认音乐 ---------------- */

// 远端曲子进页面就开始取，但浏览器不允许「没人点过就出声」，
// 所以取到后先挂起，等第一次触摸 / 点击 / 按键再真正开播（只试一次）。
let defaultMusicReady = false;
let defaultMusicArmed = Boolean(DEFAULT_MUSIC);

async function loadDefaultMusic() {
  if (!DEFAULT_MUSIC) return;
  try {
    el.trackName.textContent = '正在载入默认音乐…';
    const { duration, analysable } = await audio.loadUrl(DEFAULT_MUSIC, DEFAULT_MUSIC_NAME);
    defaultMusicReady = true;
    beatDetector.reset();
    el.btnPause.disabled = false;
    el.btnPause.textContent = '播放';
    el.trackName.textContent = DEFAULT_MUSIC_NAME;
    el.trackName.title = analysable
      ? '默认音乐 · 鼓点驱动呼吸'
      : '默认音乐 · 远端直连，无法分析频谱（呼吸用内置节奏）';
    kickDefaultMusic();
  } catch (err) {
    console.warn('[audio] 默认音乐加载失败', err);
    defaultMusicReady = false;
    defaultMusicArmed = false;
    el.trackName.textContent = '内置节奏 · 点音乐换一首';
  }
}

/** 有交互授权后再开声；被拦截时保留待播状态，下一次交互再试 */
function kickDefaultMusic() {
  if (!defaultMusicReady || !defaultMusicArmed || audio.playing) return;
  audio.play(0);
  // el.play() 的结果是异步的，等一拍再确认到底响了没
  setTimeout(() => {
    if (audio.playing) {
      defaultMusicArmed = false;
      el.btnPause.textContent = '暂停';
    }
  }, 320);
}

document.addEventListener('pointerdown', () => {
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  kickDefaultMusic();
}, true);

window.addEventListener('keydown', () => {
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  kickDefaultMusic();
}, true);

/* ---------------- 指针视差 ---------------- */

const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
window.addEventListener('pointermove', (e) => {
  pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
  pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
});

/* ---------------- 主循环 ---------------- */

const clock = new THREE.Clock();
let beatFlashUntil = 0;
let probeFrame = 0;

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

  // 字幕让位：文字在场时把树压暗一点，光点组成的字才跳得出来
  if (loveMsg.dim > 0.002) {
    params.brightness *= 1 - 0.13 * loveMsg.dim;
    params.bloom *= 1 - 0.08 * loveMsg.dim;
  }
  if (danmaku.dim > 0.002) {
    // 局部对比交给 SoftVeil（文字背后的软暗角），这里只轻微压一点整体亮度
    params.brightness *= 1 - 0.16 * danmaku.dim;
    params.bloom *= 1 - 0.12 * danmaku.dim;
  }
  if (like.dim > 0.002) {
    // 星是描边、又有软暗角托着，整体亮度基本不用动，只收一点泛光免得糊
    params.brightness *= 1 - 0.18 * like.dim;
    params.bloom *= 1 - 0.12 * like.dim;
  }

  tree.update(t, params);
  effects.update(t, params);
  gifts.update(dt, router.trayWorld);

  // 又比心时立刻收掉文字，别和心形抢画面
  if (gestureState.heart && gestureState.heart.active && loveMsg.active) loveMsg.cancel();
  heart.update(dt, t, gestureState.heart, params, camera);
  loveMsg.update(dt, t, camera);
  danmaku.update(dt, t, camera);
  like.update(dt, t, camera);

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

  // 探针：每 6 帧刷一次，够看又不拖 DOM；隐藏时不写
  if (el.probe && !el.probe.hidden && (++probeFrame % 6) === 0) {
    const p = gesture.probe;
    const hh = gestureState.heart;
    const h0 = gestureState.hands[0];
    el.probe.textContent =
      `手 ${gestureState.handCount}  圈 ${p.ringA.toFixed(2)}/${p.ringB.toFixed(2)}\n`
      + `距 ${p.gap.toFixed(2)}  平 ${p.level.toFixed(2)}  速 ${p.rate.toFixed(2)}\n`
      + `分 ${p.score.toFixed(2)}  心 ${(hh ? hh.strength : 0).toFixed(2)}  · ${p.stage}\n`
      + `掌 ${(h0 ? h0.palmSide : 0).toFixed(2)}  立 ${(h0 ? h0.sideW : 0).toFixed(2)}`
      + `  抓 ${(h0 ? h0.clutch : 0).toFixed(2)}  转 ${(router.spin * 57.3).toFixed(0)}°`
      + `  速 ${router.spinVel.toFixed(2)}  电 ${(h0 ? h0.phone : 0).toFixed(2)}`
      + `  赞 ${(h0 ? h0.like : 0).toFixed(2)}`;
    el.probe.classList.toggle('hit', !!(hh && hh.active));
  }

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
  heart.setPixelRatio(pixelRatio);
  loveMsg.setPixelRatio(pixelRatio);
  danmaku.setPixelRatio(pixelRatio);
  like.setPixelRatio(pixelRatio);
}
window.addEventListener('resize', resize);

/* ---------------- 启动 ---------------- */

async function boot() {
  setLoading(30, '正在唤醒雪夜…');
  await nextFrame();

  // 手势链路尽早启动：摄像头授权、wasm、模型都在后台跑，和首帧渲染并行
  const gesturePromise = cameraPossible ? startGesture() : null;

  tick();
  setLoading(78, '正在铺开针叶…');
  await nextFrame();
  await nextFrame();

  // 场景已经出图：先收起遮罩，模型在后台继续加载，不挡用户看画面
  setLoading(100, '准备好了');
  setTimeout(() => el.loading.classList.add('done'), 240);

  // 默认音乐后台取，不挡首帧；取到后等第一次交互再开声
  loadDefaultMusic();

  if (!gesturePromise) {
    el.camOff.textContent = '需要 https 才能用摄像头';
    setStatus('当前为音乐模式 · 摄像头需要 https 或 localhost', true);
    return;
  }

  try {
    await gesturePromise;
    cameraReady = true;
    el.camOff.style.display = 'none';
    setStatus('举起双手 · 张开手掌试试');
  } catch (err) {
    console.error(err);
    cameraReady = false;
    const secure = err && /https|localhost/.test(err.message || '');
    setStatus(secure ? '摄像头需要 https · 当前为音乐模式' : '摄像头未授权 · 当前为音乐模式', true);
    el.camOff.textContent = secure ? '需要 https 才能用摄像头' : '摄像头未授权';
  }
}

function startGesture() {
  return (async () => {
    const pre = await modelPrefetch;
    return gesture.init({
      ...(pre || {}),
      onProgress: (p) => {
        modelProgress = { ...modelProgress, ...p };
        renderModelProgress();
      },
    });
  })();
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

if (new URLSearchParams(location.search).has('debug')) {
  window.__app = { gesture, router, tree, effects, audio, gifts, heart, loveMsg, danmaku, like, breath, beatDetector, camera };
  if (el.probe) el.probe.hidden = false;
}

// Ctrl/⌘ + Shift + D 随时开关比心探针（不必改地址栏参数）
window.addEventListener('keydown', (e) => {
  if (!((e.ctrlKey || e.metaKey) && e.shiftKey) || e.key.toLowerCase() !== 'd') return;
  if (!el.probe) return;
  e.preventDefault();
  el.probe.hidden = !el.probe.hidden;
});

// 按 T 手动播一次 I love you：不用比心也能确认这段收尾动画在不在
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 't') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (/INPUT|TEXTAREA/.test(tag)) return;
  loveMsg.trigger(new THREE.Vector3(0, 5.6, 5.6), 2.6);
});

// 按 6 手动放一次弹幕：不用比手势也能确认这段特效在不在
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key !== '6') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (/INPUT|TEXTAREA/.test(tag)) return;
  danmaku.trigger(clock.elapsedTime);
});

// 按 L 手动放一次点赞：不用比手势也能确认粒子大拇指在不在
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'l') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (/INPUT|TEXTAREA/.test(tag)) return;
  like.trigger(clock.elapsedTime);
});

boot();
