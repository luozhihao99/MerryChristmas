import * as THREE from 'three';
import { ParticleTree, configureQuality, TREE } from './ParticleTree.js';
import { SceneEffects } from './SceneEffects.js';
import { SpiralRise } from './SpiralRise.js';
import { GroundBase } from './GroundBase.js';
import { SpectrumRipple } from './SpectrumRipple.js';
import { BowArrow } from './BowArrow.js';
import { ClickBurst } from './ClickBurst.js';
import { GiftRain, makeGift } from './GiftRain.js';
import { HeartEffect } from './HeartEffect.js';
// LoveMessage / WishLantern / Confetti / MissYou 走动态 import（见 scheduleExtras）：
// 合计约 40KB 代码 + 十几万颗粒子的生成，首帧一个都用不上。
import { GestureController } from './GestureController.js';
import { AudioEngine } from './AudioEngine.js';
import { applyStatic, getLang, setLang, t, tf } from './i18n.js';
import { BeatDetector, demoBeat } from './BeatDetector.js';
import { BreathMapper } from './BreathMapper.js';
import { InteractionRouter } from './InteractionRouter.js';
import { modelJob, onModelProgress, cameraPossible } from './modelPreload.js';
import { GESTURE_SWITCH } from './gestureConfig.js';
import { DEFAULT_MUSIC, DEFAULT_MUSIC_NAME } from './appConfig.js';

const canvas = document.getElementById('scene');
const video = document.getElementById('cam');

/** ?debug：打开探针、把内部状态挂到 window.__app，并记录一些排障用的数字 */
const DEBUG = new URLSearchParams(location.search).has('debug');

// 音乐是流式播的，起播快慢几乎全看「第一个字节什么时候到」。
// 这里提前把 DNS + TLS 走完，点下按钮时只差一次 HTTP 请求。
if (DEFAULT_MUSIC) {
  try {
    const musicOrigin = new URL(DEFAULT_MUSIC, location.href).origin;
    if (musicOrigin !== location.origin) {
      for (const rel of ['preconnect', 'dns-prefetch']) {
        const link = document.createElement('link');
        link.rel = rel;
        link.href = musicOrigin;
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
      }
    }
  } catch (e) { /* 地址不合法就跳过，不影响其它 */ }
}

// 静态文案按所选语言刷一遍（首屏遮罩还在屏幕上，必须抢在用户看清之前）。
// 选择器的交互接线在 initLangPick()（定义集中在前面的常量都就位之后调用）。
applyStatic();

// 拉弓提示文案：key → i18n key。放在 tick 外面——tick 里有局部变量 t（时钟），
// 会遮蔽 i18n 的翻译函数 t()，在那里直接调用会抛 TypeError
const BOW_TIP_I18N = {
  shot: 'bowtip.shot',
  full: 'bowtip.full',
  mid: 'bowtip.mid',
  low: 'bowtip.low',
  start: 'bowtip.start',
};
function bowTipText(key) {
  return (BOW_TIP_I18N[key] && t(BOW_TIP_I18N[key])) || '';
}

const el = {
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loadingText'),
  loadingBar: document.getElementById('loadingBar'),
  loadingBarTrack: document.getElementById('loadingBarTrack'),
  loadingPctNum: document.getElementById('loadingPctNum'),
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
  btnPlay: document.getElementById('btnPlayMusic'),
  btnSkip: document.getElementById('btnSkip'),
  langPick: document.getElementById('langPick'),
  btnLang: document.getElementById('btnLang'),
  musicPrompt: document.getElementById('musicPrompt'),
  btnMusicYes: document.getElementById('btnMusicYes'),
  btnMusicNo: document.getElementById('btnMusicNo'),
  hints: Array.from(document.querySelectorAll('.hint')),
  hintsPanel: document.getElementById('hints'),
  camWrap: document.getElementById('camWrap'),
  bowTip: document.getElementById('bowTip'),
  bowTipPct: document.getElementById('bowTipPct'),
  bowTipText: document.getElementById('bowTipText'),
  bowTipFill: document.getElementById('bowTipFill'),
};

// 显隐交给 opacity（.show），不要用 [hidden] —— display:none 会让过渡直接失效
if (el.bowTip) el.bowTip.hidden = false;

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
// 请求在 src/modelPreload.js 里就已经发出了（它作为独立入口写在 <head> 里，
// 只依赖 3KB 的 assetLoader，比本文件早几百毫秒执行）。
// 原因：首帧建场会把主线程堵住近一秒，在这之后才发出的请求只能排队 ——
// 早先在本文件里 prefetch，实测模型请求被推到 +1.3s。
// 这里只负责接进度，并把失败兜住。

let modelProgress = { phase: 'model', loaded: 0, total: 0 };
// 这个标志比下面那些「渲染器之后」的变量先用上：订阅进度时会立刻回放一次，
// 回调里就会读它。声明提前，免得撞 TDZ。
let cameraReady = false;

/* ---------------- 首屏进度 ---------------- */

/**
 * 一条进度条说三件事，权重按实测耗时分配（合计 100）：
 *   场景 35 —— 建树、编译着色器，吃本地算力，通常 0.4~1.3 秒
 *   模型 30 —— 5.7MB 的 .task，全看网速（本地倒是快到看不见）
 *   链路 35 —— 摄像头授权 + wasm 实例化 + landmarker 创建，
 *             这一段没有进度回调、只有「好了没」，机器慢时能拖上几秒
 *
 * 三者全部到位才收遮罩。早先只等模型就放人进去，结果场景里摄像头小窗
 * 还在转圈、举手没反应 —— 看起来像坏了。宁可多等这几百毫秒。
 */
const BOOT_W = { scene: 35, model: 30, rig: 35 };

/** 兜底：授权弹窗没人理、网络卡死时，别让人觉得页面死了 */
const READY_WAIT = 22000;

const bootState = {
  withModel: cameraPossible,
  scene: 0,        // 0..1 场景搭建
  model: -1,       // -1 未知 / 0..1 下载进度
  rig: 0,          // 0..1 手势链路（摄像头 + wasm + 模型实例化）
  rigText: null,   // [中文, 英文]，由 GestureController 的 onStatus 推上来
  rigT0: 0,        // 进入「建 landmarker」这段的时刻，用来按时间估进度
  skipped: false,  // 用户点了「先看看树」
  finished: false,
};

const bootAt = performance.now();

/** 跳过按钮别在开局就劝人放弃：等超过这么久还没好，才把出口亮出来 */
const SKIP_AFTER = 4000;

let skipResolve;
const skipPromise = new Promise((r) => { skipResolve = r; });

/* 百分比数字不能跟着下载回调生硬跳 —— 它逐帧追目标值。
   条本身交给 CSS 的 width 过渡（缓动曲线和这个系数对得上，视觉同步）。 */
let shownPct = 0;
let targetPct = 0;
let pctRaf = 0;
let pctWhole = -1;

function pushPct(v) {
  const next = Math.max(0, Math.min(100, v));
  // 只进不退：下载进度偶尔回跳（分片重试）看着像出错
  if (next > targetPct) targetPct = next;
  if (!pctRaf) pctRaf = requestAnimationFrame(stepPct);
}

function stepPct() {
  pctRaf = 0;
  const d = targetPct - shownPct;
  // 大跳变（建场把主线程堵了一秒、或模型瞬间下完）给更快的追赶系数，
  // 否则「已下 89%」的文案会和数字上的 8% 同时出现在屏幕上
  const k = Math.abs(d) > 25 ? 0.42 : 0.17;
  shownPct = Math.abs(d) < 0.12 ? targetPct : shownPct + d * k;
  el.loadingBar.style.width = `${shownPct.toFixed(2)}%`;

  const whole = Math.round(shownPct);
  if (whole !== pctWhole) {
    pctWhole = whole;
    el.loadingPctNum.textContent = String(whole);
  }
  if (shownPct !== targetPct) pctRaf = requestAnimationFrame(stepPct);
}

/** 文案换句时淡入上滑；中英同步换，同一句不重放（否则下载回调会把它闪成跑马灯） */
function replaySwap(node) {
  node.classList.remove('swap');
  void node.offsetWidth;   // 重排一次，动画才会重新开始
  node.classList.add('swap');
}

/** 遮罩进度行只显示一行（所选语言）；text 由调用方用 t()/tf() 取好传进来 */
function setLoadingText(text) {
  if (text && el.loadingText.textContent !== text) {
    el.loadingText.textContent = text;
    replaySwap(el.loadingText);
  }
}

function paintLoading(sceneText) {
  if (bootState.finished) return;

  const { scene, withModel, skipped, rig } = bootState;
  const model = Number.isFinite(bootState.model) ? bootState.model : -1;
  const modelDone = !withModel || model >= 1;
  const rigDone = !withModel || rig >= 1;
  const done = scene >= 1 && modelDone && rigDone;

  // wasm 实例化 + landmarker 创建这一段 MediaPipe 不给任何进度回调，
  // 只有「好了没」。所以显示值完全交给时间估算：4 秒线性爬满，真就绪时
  // stepRig(1) 直接补满。用线性而不是指数渐近 —— 指数在尾巴上几乎不动，
  // 正好是用户最焦虑的那几秒。
  // 注意别拿 rig 的台阶值去 max：那会把估时曲线压死，反而更僵（实测卡 94% 三秒多）。
  let rigShow = rig;
  let rigEl = 0;
  if (withModel && modelDone && rig < 1 && bootState.rigT0) {
    rigEl = Math.max(0, performance.now() - bootState.rigT0) / 1000;
    rigShow = 0.45 + 0.53 * Math.min(1, rigEl / 4);
  }

  const pct = withModel
    ? scene * BOOT_W.scene + Math.max(0, model) * BOOT_W.model + rigShow * BOOT_W.rig
    : scene * 100;
  pushPct(done ? 100 : pct);
  // 排障用：?debug 下能在控制台看到进度条每一帧的拆解
  if (DEBUG) bootState.dbg = { scene, model, rig, rigShow, rigEl, pct, done };

  if (done) {
    setLoadingText(t('load.ready'));
  } else if (scene < 1) {
    setLoadingText(sceneText || t('load.waking'));
  } else if (!withModel) {
    setLoadingText(t('load.needles'));
  } else if (!modelDone) {
    const { loaded = 0, total = 0 } = modelProgress;
    if (model < 0 || !(total > 0)) {
      setLoadingText(t('load.connect'));
    } else {
      const a = (loaded / 1048576).toFixed(1);
      const b = (total / 1048576).toFixed(1);
      setLoadingText(tf('load.download', { a, b }));
    }
  } else if (!rigDone) {
    // 模型已经到手，剩下摄像头授权 / wasm / 建 landmarker 这几步，
    // 文案由 GestureController 的 onStatus 推上来（它最清楚卡在哪一环），
    // 这里存的是 i18n key，切换语言后下一次重画自动跟着换
    setLoadingText(t(bootState.rigText || 'gest.starting'));
  } else {
    setLoadingText(t('load.finish'));
  }

  // 场景已好、后面还有东西在路上：空档里跑一道流光，
  // 让「进度暂时不走」和「卡死了」看起来是两回事
  el.loadingBarTrack.classList.toggle('is-wait', !done && scene >= 1);

  // 树已经能看了、后面还有东西在路上：给一条随时溜走的出口，
  // 但别在开局就劝人放弃 —— 等超过 SKIP_AFTER 还没好再亮出来。
  const canSkip = scene >= 1 && !done && performance.now() - bootAt > SKIP_AFTER;
  const showSkip = canSkip && !skipped;
  if (el.btnSkip.hidden === showSkip) el.btnSkip.hidden = !showSkip;
}

const modelPrefetch = cameraPossible
  ? modelJob.catch((err) => {
      console.warn('[boot] 模型预取失败，交给 MediaPipe 自行加载', err);
      return null;
    })
  : Promise.resolve(null);

onModelProgress((p) => {
  modelProgress = { ...modelProgress, ...p };
  if (p.phase === 'model') {
    const total = Number(p.total);
    const loaded = Number(p.loaded);
    bootState.model = p.fromCache
      ? 1
      : Number.isFinite(total) && total > 0 && Number.isFinite(loaded)
        ? Math.min(1, loaded / total)
        : -1;
    paintLoading();
  }
  renderModelProgress();
});

/* ---------------- 渲染器与场景 ---------------- */

if (!document.createElement('canvas').getContext('webgl2')) {
  setLoadingText(t('load.webgl2'));
  el.loadingPctNum.textContent = '—';
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
// 拉弓那组（弓 / 箭 / 红心）是挂在相机下面的屏幕图层，相机必须进场景图，
// 否则它的子节点不会被渲染 —— 而且不会有任何报错，只是「什么也没出现」。
scene.add(camera);

const ambient = new THREE.AmbientLight(0x2b3c55, 0.75);
scene.add(ambient);

const key = new THREE.DirectionalLight(0xc3d8ff, 2.1);
key.position.set(-6, 12, 8);
scene.add(key);

const fill = new THREE.DirectionalLight(0x2c4260, 0.85);
fill.position.set(7, 4, -6);
scene.add(fill);

const tree = new ParticleTree(renderer);
performance.mark('boot:tree');
scene.add(tree.group);

// 常驻氛围：一层暖金浮尘绕着树的腰线螺旋上升，永远循环。
// 它不属于任何手势 —— 树静止不动的时候，画面里得还有东西在走。
// 颗数从 1600 收到 1100：太密就排成一条连续的线（像跑道灯），
// 稀一点才像零散的热气。
const spiral = new SpiralRise(scene, { count: lowPower ? 720 : 1100 });

// 地面：暖光池 + 树冠回光 + 贴地星云。原来的地面只有一张绿色光贴片，
// 礼物盒站在一片纯黑上，看起来全在飘（详见 GroundBase 文件头）。
const groundBase = new GroundBase(scene, { count: lowPower ? 720 : 1150 });

// 前景失焦光斑（src/NearBokeh.js）已停用：那几团半透明虚光压在树上，
// 读起来更像挡在镜头前的泡泡，而不是景深。想复现就把模块加回来，
// 在 resize() 里补 setViewport、在 update 里补 update。
groundBase.setViewport(camera, window.innerHeight, pixelRatio);

// 树底频谱水波纹（src/SpectrumRipple.js）：用户反馈后暂时整体关闭。
// 想恢复把它改回 true 即可，特效代码和 W 键演示模式都还在。
const RIPPLE_ENABLED = false;

// prettier-ignore
const ripple = RIPPLE_ENABLED ? new SpectrumRipple(scene) : null;
if (ripple) ripple.setViewport(camera, window.innerHeight, pixelRatio);

// 双手拉弓：弓在右下、红心在左上，箭沿对角线飞过去穿心。
// 它是相机子节点（屏幕坐标），所以不受树的缩放/旋转影响。
const archery = new BowArrow(scene, camera);
archery.setPixelRatio(pixelRatio);

// 点击烟花：点一下屏幕，在点击位置炸一蓬暖金色粒子（OK 那段烟花的单独版）。
// 位置由点击处换算到树前方 z=3.2 的平面，见「指针」一节。
const clickBurst = new ClickBurst(scene);
clickBurst.setPixelRatio(pixelRatio);

performance.mark('boot:prefx');
const effects = new SceneEffects(renderer, scene, camera, {
  width: window.innerWidth,
  height: window.innerHeight,
  pixelRatio,
});
performance.mark('boot:effects');

const gifts = new GiftRain(scene, {
  onCatch: (count) => {
    el.score.classList.add('show');
    el.scoreNum.textContent = String(count);
  },
});

// 三段「粒子图案」特效：比心收尾的 I love you、点赞的纸屑、OK 的 miss you。
// 它们各自要生成/采样上万颗粒子（合计约 10 万），建一次几十毫秒，首帧却一个都用不上，
// 所以在首帧出图之后按空闲时段建（scheduleExtras），建好之前 tick 里判空跳过。
let loveMsg = null;
let lantern = null;
let confetti = null;
let missYou = null;
let extrasStarted = false;


// 双手比心：心形光尘。心形熄灭时把位置与缩放交给文字特效，粒子从心形起飞
const heart = new HeartEffect(scene, {
  onEnd: (pos, scale) => { if (loveMsg) loveMsg.trigger(pos, scale); },
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
  // 每盒往背离树心的方向拖一块软投影。位置本来是对的（正好贴地），
  // 但地面太暗、盒底又被地灯照亮，看不出「贴」—— 影子落在盒子外侧那片
  // 看得见的地面上，才读得出「它挡住了光」
  groundBase.addGiftShadow(g.position.x, g.position.z, g.userData.size);
  pile.add(g);
}
scene.add(pile);

/* ---------------- 音频 / 手势 / 合并 ---------------- */

const audio = new AudioEngine();
const beatDetector = new BeatDetector();
const breath = new BreathMapper();
const router = new InteractionRouter();

let gestureState = { hands: [], handCount: 0, spread: null, tray: null, heart: null, bow: null };
// 拉弓提示当前显示的是哪一档文案（只用于避免每帧写 DOM）
let bowTipKey = '';

const gesture = new GestureController({
  video,
  // 手势事件总入口：真手势和下面的调试快捷键都从这里进 ——
  // 以后某个手势在 main.js 里补了额外特效，键盘触发也不会漏掉那一部分
  onEvent: handleGestureEvent,
  onStatus: (key) => {
    // 遮罩上的文案由 paintLoading 独占（存 key，重画时按当前语言取），这里只更新右上角状态条。
    // 但遮罩还没收的时候，这几句就是「现在卡在哪一环」，得同时交给 paintLoading。
    if (key) {
      setStatus(t(key));
      bootState.rigText = key;
      paintLoading();
    }
  },
});

/**
 * 手势离散事件的总入口（GestureController 回调 / 调试快捷键共用）。
 *
 * router 负责连续参数（explode / storm / 各种 flash），这里负责「一次性的
 * 段落式特效」：放箭、孔明灯、纸屑、miss you。分开是因为前者每帧都在衰减，
 * 后者是「播一轮、播完为止」的互斥状态机。
 */
function handleGestureEvent(type, payload) {
  router.onEvent(type, payload);
  // 拉弓松手：箭从当前弓弦位置射向红心。power 由拉弓量决定，
  // 影响飞行时间和拖影长度 —— 拉到一半和拉满看起来必须不一样
  if (type === 'bowRelease') archery.trigger(clock.elapsedTime, (payload && payload.power) || 1);
  // 打电话：一盏盏孔明灯从树旁升起，升完之前不重复触发（手势一直比着也只放一轮）
  // 用 elapsedTime 属性而不是 getElapsedTime()：后者会内部推进时钟，扰动这一帧的 dt
  if (type === 'call' && lantern && !lantern.busy) lantern.trigger(clock.elapsedTime);
  // 点赞：一蓬金箔从树腰迸开，翻转着飘落。落完之前不叠下一轮
  if (type === 'like' && confetti && !confetti.busy) confetti.trigger(clock.elapsedTime);
  // 单手 OK：爱心 → 流星雨 → 烟花 → 飘散 → miss you → 飘散，整段 8.5 秒不叠播
  if (type === 'ok' && missYou && !missYou.busy) missYou.trigger(clock.elapsedTime);
}

/* ---------------- UI ---------------- */

function setStatus(text, warn = false) {
  // 系统消息（曲名 / 错误 / 状态）会顶掉玩法提示；7 秒后由 tickTips 悄悄恢复
  if (tipIdx >= 0 && text !== TIPS[tipIdx].text) tipHoldUntil = performance.now() + 7000;
  el.statusText.textContent = text;
  el.status.classList.toggle('warn', warn);
}

function setLoading(pct, text) {
  pushPct(pct);
  if (text) setLoadingText(text);
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

// 「先看看树」：模型继续在后台下，只是不再拦着首屏
if (el.btnSkip) {
  el.btnSkip.addEventListener('click', () => {
    bootState.skipped = true;
    skipResolve();
  });
}

/* ---------------- 界面开关：玩法一览 / 摄像头小窗 ---------------- */

// 两块都默认收起，画面干净；按钮点亮 = 当前展开。
// 摄像头这里只藏「画面」：video 一直在播，手势识别不受影响。
function bindPanelToggle(btn, panel) {
  if (!btn || !panel) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const show = panel.hidden;
    panel.hidden = !show;
    btn.setAttribute('aria-pressed', String(show));
  });
}
bindPanelToggle(document.getElementById('btnHints'), el.hintsPanel);
bindPanelToggle(document.getElementById('btnCam'), el.camWrap);

/* ---------------- 清屏：录屏演示时只留画面 ---------------- */

// 清屏后右上角那排控制栏整块藏起来，所以「取消清屏」不能还放在那里。
// 入口有两个：右下角一个极淡的小「菜单」（hover 才亮），以及 Esc —— 键盘是最后的兜底。
const hudEl = document.getElementById('hud');
const btnClean = document.getElementById('btnClean');
const btnUnclean = document.getElementById('btnUnclean');
const cleanToast = document.getElementById('cleanToast');
let cleanToastTimer = 0;

function setClean(on) {
  hudEl.classList.toggle('clean', on);
  if (btnClean) btnClean.setAttribute('aria-pressed', String(on));
  if (btnUnclean) btnUnclean.hidden = !on;

  // 清屏的一瞬间，右上角整条控制栏连同「怎么退出」一起消失了 ——
  // 所以先在顶部居中弹一句 2 秒的轻提示，把「右下角图标」指出来。
  if (!cleanToast) return;
  clearTimeout(cleanToastTimer);
  if (on) {
    cleanToast.hidden = false;
    requestAnimationFrame(() => cleanToast.classList.add('show'));
    cleanToastTimer = setTimeout(() => {
      cleanToast.classList.remove('show');
      cleanToastTimer = setTimeout(() => { cleanToast.hidden = true; }, 420);
    }, 2000);
  } else {
    cleanToast.classList.remove('show');
    cleanToast.hidden = true;
  }
}

if (btnClean) btnClean.addEventListener('click', (e) => { e.stopPropagation(); setClean(true); });
if (btnUnclean) btnUnclean.addEventListener('click', () => setClean(false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && hudEl.classList.contains('clean')) setClean(false);
});

/* ---------------- 底部玩法提示 ---------------- */

// 状态条平时轮换「一个」玩法：随机挑一条还没触发过的；全都玩过之后就纯随机。
// 玩法被比出来的一瞬间整行亮金（.status.hit），2 秒后换下一条。
// 已触发列表存 localStorage（键 tree.tips.done），刷新不重置；想清零删掉这个键即可。
// 文案写得比左下角一览更完整 —— 一览默认是收起的，底部这句话常常是唯一的教学。
const TIPS = [
  { k: 'bow',    key: 'tip.bow' },
  { k: 'spread', key: 'tip.spread' },
  { k: 'slide',  key: 'tip.slide' },
  { k: 'heart',  key: 'tip.heart' },
  { k: 'call',   key: 'tip.call' },
  { k: 'like',   key: 'tip.like' },
  { k: 'ok',     key: 'tip.ok' },
];
// 提示条 data-k 与 router.active 的键同名，只有「张开」例外（data-k="open"，归 burst 管）
const TIP_MAP = { open: 'burst' };
const TIP_STORE = 'tree.tips.done';
const TIP_FLASH_MS = 2000;

let tipsDone = new Set();
let tipsPersist = false;
try {
  tipsDone = new Set(JSON.parse(localStorage.getItem(TIP_STORE) || '[]'));
  tipsPersist = true;
} catch (e) { /* localStorage 不可用（隐私模式 / file://）：只在本会话里记 */ }
function saveTips() {
  if (!tipsPersist) return;
  try { localStorage.setItem(TIP_STORE, JSON.stringify([...tipsDone])); } catch (e) { /* 忽略 */ }
}

const tipPool = () => TIPS.filter((t) => GESTURE_SWITCH[t.k] !== false);

let tipIdx = -1;          // 当前提示的下标（-1 = 轮换还没开始，多为音乐模式）
let tipHoldUntil = 0;     // 系统消息（曲名 / 错误）占用状态条的截止时间
let tipFlashUntil = 0;    // 触发庆祝高亮的截止时间

/** 挑下一条提示：优先还没触发过的；全触发过就随机；尽量不和当前这条重复 */
function pickTip() {
  const pool = tipPool();
  if (!pool.length) return;
  let cand = pool.filter((t) => !tipsDone.has(t.k));
  if (!cand.length) cand = pool;
  if (cand.length > 1 && tipIdx >= 0) cand = cand.filter((t) => t !== TIPS[tipIdx]);
  const pick = cand[(Math.random() * cand.length) | 0];
  tipIdx = TIPS.indexOf(pick);
  el.statusText.textContent = t(pick.key);
}

/** 摄像头链路就绪后调用：开始轮换玩法提示 */
function startTips() {
  if (tipIdx >= 0) return;
  pickTip();
}

/**
 * 每帧由主循环调用：
 * · 新触发的玩法记成「已触发」（哪怕它不是当前提示的那条）；
 * · 当前提示被触发 → 亮金 2 秒，然后换下一条没触发过的；
 * · 状态条被系统消息占了 7 秒以上 → 悄悄把玩法提示请回来。
 */
function tickTips(active, now) {
  if (tipIdx < 0) return;
  let fresh = false;
  for (const k of active) {
    const key = TIP_MAP[k] || k;
    if (!tipPool().some((t) => t.k === key) || tipsDone.has(key)) continue;
    tipsDone.add(key);
    saveTips();
    fresh = true;
  }
  // 只要是「第一次玩出某个玩法」就换条：用户刚做完一个动作，
  // 正是最好奇「还能玩什么」的时候，哪怕做的不是当前提示的那一条。
  if (fresh) {
    el.status.classList.add('hit');
    tipFlashUntil = now + TIP_FLASH_MS;
    pickTip();
  }
  if (tipFlashUntil && now > tipFlashUntil) {
    tipFlashUntil = 0;
    el.status.classList.remove('hit');
  }
  if (tipHoldUntil && now > tipHoldUntil && now > tipFlashUntil) {
    tipHoldUntil = 0;
    el.statusText.textContent = t(TIPS[tipIdx].key);
  }
}

/* ---------------- 音乐说明气泡 ---------------- */

// #musicHelp 的整块 HTML 目前在 index.html 里被注释掉了（「?」按钮也随之隐藏），
// getElementById 会拿到 null —— 整段逻辑必须先判空，否则每次页面点击都会
// 在下面的 document 处理器里抛 TypeError（读 null.hidden）。
// 把气泡加回 HTML 后，这段代码无需改动即自动恢复工作。
const btnHelp = document.getElementById('btnHelp');
const musicHelp = document.getElementById('musicHelp');

if (btnHelp && musicHelp) {
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
}

// 微信内置浏览器不允许选择文件，提前说明，别让用户以为是页面坏了
if (/MicroMessenger/i.test(navigator.userAgent) && !audio.playing) {
  setTrackLabel('wechat');
}

/* ---------------- 音频加载 ---------------- */

function audioErrorText(err) {
  const code = err && err.code;
  const name = err && err.name;
  if (code === 'empty') return t('audio.err.empty');
  if (code === 'unsupported' || name === 'NotSupportedError') {
    return t('audio.err.unsupported');
  }
  if (name === 'EncodingError') return t('audio.err.encoding');
  return t('audio.err.generic');
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
    setTrackLabel('audio.reading');
    setStatus(t('audio.decoding'));
    const { duration, mode } = await audio.load(file);
    // 用户自己换了歌：默认音乐那条「点击播放」就不再弹了
    musicStarted = true;
    refreshPlayPill();
    audio.play(0);
    beatDetector.reset();
    el.btnPause.disabled = false;
    el.btnPause.textContent = t('btnPause');
    setTrackLabel(null, audio.name);
    const len = fmtTime(duration);
    setStatus(`${audio.name}${len ? ' · ' + len : ''} · ${t(mode === 'element' ? 'audio.stream' : 'audio.beat')}`);
  } catch (err) {
    console.error(err);
    setTrackLabel('audio.fail');
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
  if (playing) musicStarted = true;
  el.btnPause.textContent = playing ? t('btnPause') : t('btnResume');
  refreshPlayPill();
});

/* ---------------- 默认音乐 ---------------- */

// 浏览器不允许「用户没点过就出声」（autoplay policy），所以这里不做任何
// 偷偷摸摸的自动播放：歌取到之后亮一个明确的按钮，点了才响。
// 之前那版是「任意一次点击都顺手 play()」——技术上能响，但用户不知道声音是怎么来的，
// 也不知道为什么没声音，出了问题无从下手。
//
// 首屏另开一个口子：加载遮罩上摆「边等边听 · 开启音乐」。用户点了才去取音频
// （不点就不抢模型的带宽），取完直接播 —— 等模型的这几秒正好用来听歌。
let defaultMusicReady = false;
let musicStarted = false;      // 播过一次（或用户自己换了歌）就不再弹按钮
let musicJob = null;           // 正在取默认音乐的那一次，避免重复请求
let musicAutoplay = false;     // 取完要不要直接播（用户点过「开启音乐」）
let musicAsked = false;        // 用户点过首屏那个按钮

function refreshPlayPill() {
  // 只在「有歌、还没开始过、也没在播」时提示；
  // 用户自己按过暂停就不再问，免得像在催。
  const promptUp = !!el.musicPrompt && !el.musicPrompt.hidden;
  const need = defaultMusicReady && !musicStarted && !audio.playing && !promptUp;
  // 宽屏：底部胶囊（窄屏被 CSS 藏掉，会压住左侧手势提示条）
  if (el.btnPlay) el.btnPlay.hidden = !need;
  // 窄屏：顶栏「播放」按钮本身就是那个交互按钮，这里给它描一圈金边
  el.btnPause.classList.toggle('nudge', need);
}

/**
 * 「先听一首歌？」弹窗。
 *
 * 浏览器的自动播放策略要求「用户点过才出声」，与其在角落里放个小按钮，
 * 不如把这次点击直接要下来：加载遮罩上浮一张卡片，两个选择都写清楚。
 * 首帧出图之后才弹（boot 里 setTimeout），不抢 FCP。
 */
let musicPromptShown = false;
let promptShownAt = 0;
let promptClosed = false;

function showMusicPrompt() {
  if (!el.musicPrompt || musicPromptShown) return;
  if (!DEFAULT_MUSIC || audio.playing || musicStarted) return;
  musicPromptShown = true;
  promptShownAt = performance.now();
  el.musicPrompt.hidden = false;
  refreshPlayPill();     // 卡片露脸了，底部胶囊先让位，别两个入口一起出现
  // 强制一次布局再挂 show：不然 hidden → visible 和过渡起点挤在同一帧，淡入会丢
  void el.musicPrompt.offsetWidth;
  el.musicPrompt.classList.add('show');
  // 一直没人理就自己收，别一直挡着场景
  setTimeout(() => { if (!promptClosed) hideMusicPrompt(); }, 12000);
}

/**
 * 收弹窗。
 * instant：用户自己点掉的，立刻走。
 * 否则（加载完了 / 超时）至少让它露脸一秒 —— 本地秒开时遮罩一秒就没了，
 * 不兜这一下，这张卡会闪一下就消失，等于没问。
 */
function hideMusicPrompt(instant = false) {
  if (!el.musicPrompt || el.musicPrompt.hidden) return;
  promptClosed = true;
  const run = () => {
    el.musicPrompt.classList.remove('show');
    setTimeout(() => {
      el.musicPrompt.hidden = true;
      // 卡片真的让开了，该轮到胶囊提示了（refreshPlayPill 会看 hidden）
      refreshPlayPill();
    }, 320);
  };
  if (instant) { run(); return; }
  setTimeout(run, Math.max(0, 1000 - (performance.now() - promptShownAt)));
}

/** 弹窗里主按钮的三态：默认 / 取歌中（带百分比）/ 失败可重试。文案全走 i18n */
function setPromptButtons(state, pct) {
  promptState = state;         // 记下来，切语言时重画用
  const yes = el.btnMusicYes;
  const no = el.btnMusicNo;
  if (!yes || !no) return;
  if (state === 'loading') {
    yes.disabled = true;
    // 流式加载拿不到「下载百分比」，只报「正在连接」，别编一个数字骗人
    yes.textContent = pct == null ? t('mp.connect') : tf('mp.loading', { p: pct });
    no.textContent = t('mp.cancel');
  } else if (state === 'slow') {
    // 连了五六秒还没拿到元数据：把「在等」和「卡死」区分开
    yes.disabled = true;
    yes.textContent = t('mp.slow');
    no.textContent = t('mp.cancel');
  } else if (state === 'failed') {
    yes.disabled = false;
    yes.textContent = t('mp.retry');
    no.textContent = t('mpNo');
  } else {
    yes.disabled = false;
    yes.textContent = t('mpYes');
    no.textContent = t('mpNo');
  }
}

/** 真正开播：弹窗、胶囊、顶栏三处的状态都在这里对齐 */
function startMusic() {
  if (audio.playing) return true;
  if (!audio.play(0)) return false;
  musicStarted = true;
  el.btnPause.disabled = false;
  el.btnPause.textContent = t('btnPause');
  refreshPlayPill();
  return true;
}

/**
 * 按钮上的「网络较慢」。必须从**用户点击那一刻**开始计时 ——
 * 后台预载可能早就把时间耗掉了，那样一点就跳到「较慢」，更像出故障。
 */
let promptSlowTimer = null;
let loadSlow = false;          // 这一次加载是否已经慢到该提示用户
function armSlowHint() {
  clearTimeout(promptSlowTimer);
  // 后台预载已经等够久了：点下去就直接说「较慢」，别再让按钮装 5 秒正常
  if (loadSlow) { setPromptButtons('slow'); return; }
  promptSlowTimer = setTimeout(() => {
    if (defaultMusicReady || !musicAsked) return;
    if (el.musicPrompt && !el.musicPrompt.hidden) setPromptButtons('slow');
  }, 5000);
}

function loadDefaultMusic({ autoplay = false } = {}) {
  if (!DEFAULT_MUSIC) return Promise.resolve(false);
  if (autoplay) musicAutoplay = true;
  if (!musicJob) musicJob = fetchDefaultMusic();
  return musicJob;
}

async function fetchDefaultMusic() {
  let slowTimer = null;
  let guard = null;
  loadSlow = false;
  try {
    setTrackLabel('track.connect');
    // 流式播放拼的是「第一个字节什么时候到」。五六秒还没元数据，
    // 说明源站或网络有问题，得让用户看到「在等」而不是像卡死。
    slowTimer = setTimeout(() => {
      loadSlow = true;
      setTrackLabel('track.slow');
    }, 5000);
    // 三条路各 8 秒 = 24 秒，太久了。14 秒还没就绪就主动放弃，
    // 让用户看到「可重试」而不是一个转不停的转圈。
    guard = setTimeout(() => {
      setTrackLabel('track.timeout');
      audio.cancel();
    }, 14000);
    // 流式加载：只等元数据（几十 KB），不等整首。
    // 所以这里没有百分比可报 —— 报一个假的进度反而更让人等。
    const { analysable } = await audio.loadUrl(DEFAULT_MUSIC, DEFAULT_MUSIC_NAME, {
      onPhase: (phase) => {
        if (phase !== 'connect') return;
        if (!musicAsked || !el.musicPrompt || el.musicPrompt.hidden) return;
        setPromptButtons('loading', null);
      },
    });
    clearTimeout(slowTimer);
    clearTimeout(guard);
    clearTimeout(promptSlowTimer);
    loadSlow = false;
    defaultMusicReady = true;
    beatDetector.reset();
    el.btnPause.disabled = false;
    el.btnPause.textContent = t('btnPlay');
    setTrackLabel(null, DEFAULT_MUSIC_NAME);
    el.trackName.title = t(analysable ? 'trackTitle.stream' : 'trackTitle.noSpec');

    if (musicAutoplay) {
      // 取到了就响：这一下是用户在弹窗上点的，不算自动播放
      if (startMusic()) hideMusicPrompt(true);
      else if (el.musicPrompt && !el.musicPrompt.hidden) setPromptButtons('failed');
    } else if (musicAsked) {
      // 点过开始、中途又按了取消：卡片收掉，歌留着等胶囊提示
      hideMusicPrompt();
    }
    // 没点过的走这里时什么都别做 —— 用户可能正看着卡片，
    // 后台预载完不该替他把它关掉
    refreshPlayPill();
    return true;
  } catch (err) {
    clearTimeout(slowTimer);
    clearTimeout(guard);
    clearTimeout(promptSlowTimer);
    loadSlow = false;
    console.warn('[audio] 默认音乐加载失败', err);
    defaultMusicReady = false;
    // 允许再点一次：下一次点击重新发请求
    musicJob = null;
    musicAutoplay = false;
    setTrackLabel('track.builtin');
    if (el.musicPrompt && !el.musicPrompt.hidden) setPromptButtons('failed');
    refreshPlayPill();
    return false;
  }
}

function playDefaultMusic() {
  if (audio.playing) return;
  if (defaultMusicReady) { startMusic(); return; }
  // 歌还没取：点了就取，取完直接播，别让人再点第二下
  loadDefaultMusic({ autoplay: true });
}

if (el.btnPlay) el.btnPlay.addEventListener('click', playDefaultMusic);

if (el.btnMusicYes) {
  el.btnMusicYes.addEventListener('click', () => {
    musicAsked = true;
    if (defaultMusicReady) {
      if (startMusic()) hideMusicPrompt(true);
      else setPromptButtons('failed');
      return;
    }
    setPromptButtons('loading', null);
    armSlowHint();
    loadDefaultMusic({ autoplay: true });
  });
}

if (el.btnMusicNo) {
  el.btnMusicNo.addEventListener('click', () => {
    // 已经点过开始、正在下载时按「取消」：不再自动播，歌继续取
    // （取到了还能从底部的播放胶囊开，不算白下）
    if (musicJob && !defaultMusicReady) {
      musicAutoplay = false;
      musicAsked = false;
    }
    hideMusicPrompt(true);
  });
}

// 任何一次交互后 AudioContext 都可能还挂在 suspended，
// 这里只负责恢复上下文，开播必须由用户明确点（按钮 / 选文件 / 播放键）。
function resumeContext() {
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
}
document.addEventListener('pointerdown', resumeContext, true);
window.addEventListener('keydown', resumeContext, true);

/* ---------------- 指针：视差 / 拖拽扇风 / 点击烟花 ---------------- */

const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
window.addEventListener('pointermove', (e) => {
  pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
  pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
});

// 按住拖拽 → 虚拟扇风（router 里和侧掌扇风同一套 spin 弹簧）；
// 快速点按 → 在点击位置炸一朵烟花。同一条 pointer 流，抬起时用
// 「位移 < 12px 且没按多久」区分两种意图 —— 拖拽结束不炸，点击不转树。
const TAP_DIST = 12;
let drag = null;

/** 点按钮 / 说明气泡时不算滑动也不炸烟花，别让调音量也满天烟花 */
function isHudControl(e) {
  return !!(e.target && e.target.closest && e.target.closest('button, .music-help, .cam-wrap, .probe'));
}

/** 屏幕坐标 → 树前方 z=3.2 平面上的世界坐标（烟花炸在树前面，不被树身吃亮度） */
function screenToWorld(x, y) {
  const ndc = new THREE.Vector3(
    (x / window.innerWidth) * 2 - 1,
    -(y / window.innerHeight) * 2 + 1,
    0.5,
  );
  ndc.unproject(camera);
  const dir = ndc.sub(camera.position).normalize();
  const Z = 3.2;
  if (Math.abs(dir.z) < 1e-4) return null;
  const k = (Z - camera.position.z) / dir.z;
  if (k <= 0) return null;
  return camera.position.clone().addScaledVector(dir, k);
}

window.addEventListener('pointerdown', (e) => {
  if (isHudControl(e)) { drag = null; return; }
  drag = { x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false };
  router.pointerDown = true;
  router.pointerX = e.clientX / window.innerWidth;
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > TAP_DIST) drag.moved = true;
  if (drag.moved) router.pointerX = e.clientX / window.innerWidth;
});

window.addEventListener('pointerup', (e) => {
  router.pointerDown = false;
  if (drag && !drag.moved && performance.now() - drag.t0 < 450) {
    const p = screenToWorld(e.clientX, e.clientY);
    if (p) clickBurst.trigger(p, clock.elapsedTime, window.innerWidth < 560 ? 0.85 : 1);
  }
  drag = null;
});
window.addEventListener('pointercancel', () => {
  router.pointerDown = false;
  drag = null;
});

/* ---------------- 主循环 ---------------- */

const clock = new THREE.Clock();
let beatFlashUntil = 0;
let probeFrame = 0;

// 水波纹演示模式（W 键切换）：不依赖音乐，直接喂假频谱 + 96 BPM 假鼓点，
// 用来区分「特效没写好」还是「音乐数据没到」——演示模式下水波正常 = 特效没问题，
// 问题出在音频链路（跨域读不到频谱 / AudioContext 没跑起来等）。
let rippleDemo = false;
const RIPPLE_DEMO_BEAT_MS = 60000 / 96;

function rippleDemoFrame(t, dt) {
  const spec = new Float32Array(64);
  for (let k = 0; k < 64; k++) {
    spec[k] = Math.max(0, Math.min(1,
      0.70 * Math.exp(-k * 0.05) * (0.55 + 0.45 * Math.abs(Math.sin(t * 2.1)))
      + 0.30 * Math.abs(Math.sin(t * 1.3 + k * 0.31))));
  }
  const ms = performance.now() % RIPPLE_DEMO_BEAT_MS;
  const beat = {
    pulse: Math.exp(-(ms / RIPPLE_DEMO_BEAT_MS) * 6.5),
    hit: ms < 40,
    bpm: 96,
  };
  ripple.update(t, spec, beat, dt);
}

function rippleDiagnosis() {
  return [
    'mode=' + audio.mode,
    'playing=' + audio.playing,
    'analysable=' + audio.analysable,
    'ctx=' + (audio.ctx ? audio.ctx.state : 'none'),
    'levels=' + (audio.getFrame() ? 'yes' : 'no'),
  ].join(' ');
}

function tick() {
  if (DEBUG) bootState.tickCount = (bootState.tickCount || 0) + 1;
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
  if (loveMsg && loveMsg.dim > 0.002) {
    params.brightness *= 1 - 0.13 * loveMsg.dim;
    params.bloom *= 1 - 0.08 * loveMsg.dim;
  }
  if (missYou && missYou.dim > 0.002) {
    // 满屏爱心 / 流星 / 烟花本身就压着画面，整体只收一点点，别让树彻底黑掉
    params.brightness *= 1 - 0.22 * missYou.dim;
    params.bloom *= 1 - 0.12 * missYou.dim;
  }
  if (confetti && confetti.dim > 0.002) {
    // 纸屑是往外飞的一层，不要求静止对比，所以几乎不动全局亮度 ——
    // 只收一点泛光，免得密集处过曝成一团金雾
    params.brightness *= 1 - 0.10 * confetti.dim;
    params.bloom *= 1 - 0.08 * confetti.dim;
  }

  tree.update(t, params);
  spiral.update(dt, t, params, camera);
  groundBase.update(dt, t, params);
  if (ripple) {
    if (rippleDemo) {
      rippleDemoFrame(t, dt);
    } else {
      ripple.update(t, levels && levels.spectrum, beat, dt);
    }
  }
  clickBurst.update(t);
  archery.update(dt, t, gestureState.bow, params);
  effects.update(t, params);
  gifts.update(dt, router.trayWorld);

  // 又比心时立刻收掉文字，别和心形抢画面
  if (gestureState.heart && gestureState.heart.active && loveMsg && loveMsg.active) loveMsg.cancel();
  heart.update(dt, t, gestureState.heart, params, camera);
  if (loveMsg) loveMsg.update(dt, t, camera);
  if (lantern) lantern.update(dt, t, camera);
  if (confetti) confetti.update(dt, t, camera);
  if (missYou) missYou.update(dt, t, camera);

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

  // 底部玩法提示：检测新触发的玩法 → 记账 → 亮金换条（见 TIPS 一节）
  tickTips(router.active, now);

  // 拉弓提示：只在弓（或刚射出的箭）在的时候出现 —— 平时挂着它，
  // 等于一直提醒用户「你还没拉弓」。用户最常卡住的两件事是
  // 「拉开多少算满」和「怎么放出去」，所以这两句直接写在进度条上。
  if (el.bowTip) {
    const bw = gestureState.bow;
    const bowOn = !!(bw && bw.active);
    const justShot = archery.lastRelease > 0 && clock.elapsedTime - archery.lastRelease < 1.15;
    const show = bowOn || justShot;
    const pull = archery.pull;
    let key;
    if (!show) key = 'off';
    else if (!bowOn) key = 'shot';
    else if (pull >= 0.82) key = 'full';
    else if (pull >= 0.3) key = 'mid';
    else if (pull > 0.02) key = 'low';
    else key = 'start';

    if (key !== bowTipKey) {
      bowTipKey = key;
      el.bowTip.classList.toggle('show', show);
      el.bowTip.classList.toggle('full', key === 'full' || key === 'shot');
      el.bowTipText.textContent = bowTipText(key);
    }
    if (show) {
      el.bowTipPct.textContent = `${Math.round(pull * 100)}%`;
      el.bowTipFill.style.width = `${Math.round(pull * 100)}%`;
    }
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
      + `  赞 ${(h0 ? h0.like : 0).toFixed(2)}`
      + `  OK ${(h0 ? h0.ok : 0).toFixed(2)}\n`
      + (() => {
        const bw = gestureState.bow;
        if (!bw) return '弓 -';
        return `弓 ${bw.pull.toFixed(2)}${bw.active ? ' ON' : ' --'}`
          + `  距 ${bw.sep.toFixed(2)}  平 ${bw.level.toFixed(2)}  握 ${bw.grip.toFixed(2)}`
          + `  速 ${(bw.rate || 0).toFixed(1)}`;
      })();
    el.probe.classList.toggle('hit', !!(hh && hh.active));
  }

  // 首屏还没收、正卡在「建 landmarker」这一段时，进度按时间渐近爬（见 paintLoading），
  // 所以要每帧刷一次让它真的在动。文案没变时 paintLoading 不会碰 DOM，成本可忽略。
  if (!bootState.finished && bootState.rigT0 && bootState.rig < 1) paintLoading();

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
  spiral.setPixelRatio(pixelRatio);
  groundBase.setPixelRatio(pixelRatio);
  groundBase.setViewport(camera, h, pixelRatio);
  if (ripple) ripple.setViewport(camera, h, pixelRatio);
  heart.setPixelRatio(pixelRatio);
  if (loveMsg) loveMsg.setPixelRatio(pixelRatio);
  if (lantern) lantern.setPixelRatio(pixelRatio);
  if (confetti) confetti.setPixelRatio(pixelRatio);
  if (missYou) missYou.setPixelRatio(pixelRatio);
  archery.setPixelRatio(pixelRatio);
  clickBurst.setPixelRatio(pixelRatio);
}
window.addEventListener('resize', resize);

/* ---------------- 启动 ---------------- */

async function boot() {
  bootState.scene = 0.10;
  paintLoading(t('load.waking'));
  await nextPaint();                 // 先让遮罩出图（FCP 就是这一帧）

  bootState.scene = 0.35;
  paintLoading(t('load.stage'));

  // 手势链路尽早启动：摄像头授权、wasm、模型都在后台跑，和首帧渲染并行
  const gesturePromise = cameraPossible ? startGesture() : null;

  performance.mark('boot:tick0');
  tick();                            // 首帧：建树、编译着色器、出图
  performance.mark('boot:tickend');

  bootState.scene = 1;
  paintLoading(t('load.needles'));
  scheduleExtras();

  // 首帧已经出图，这时候问「先听一首歌？」不会拖慢 FCP
  setTimeout(showMusicPrompt, 520);

  // 首屏最后排队的是整条手势链路：模型下载 + 摄像头授权 + wasm + landmarker。
  // 等「手势真的能用」再收遮罩 —— 只等模型就放人的话，进去以后摄像头小窗
  // 还在转圈、举手没反应，用户会以为坏了。等太久、或者用户点了跳过，就先放人。
  let readyKey = 'ready.ok';
  if (gesturePromise) {
    const why = await Promise.race([
      gesturePromise.then(() => 'ok', () => 'fail'),
      skipPromise.then(() => 'skip'),
      new Promise((r) => setTimeout(() => r('timeout'), READY_WAIT)),
    ]);
    // 遮罩上最后那句话要把结果说清楚：进去才发现「摄像头未授权」算是惊吓
    if (why === 'fail') {
      readyKey = 'ready.fail';
    } else if (why === 'timeout') {
      readyKey = 'ready.timeout';
    }
  }
  finishLoading(readyKey);

  if (!gesturePromise) {
    applyCamOff('needHttps');
    setStatus(t('cam.noHttps'), true);
    return;
  }

  try {
    await gesturePromise;
    cameraReady = true;
    el.camOff.style.display = 'none';
    startTips();
  } catch (err) {
    console.error(err);
    cameraReady = false;
    const secure = err && /https|localhost/.test(err.message || '');
    setStatus(secure ? t('cam.needHttps') : t('cam.denied'), true);
    applyCamOff(secure ? 'needHttps' : 'denied');
  }
}

/** 收起首屏遮罩。只做一次：跳过、加载完、超时三条路都可能走到这里 */
function finishLoading(key = 'ready.ok') {
  if (bootState.finished) return;
  bootState.finished = true;
  pushPct(100);
  setLoadingText(t(key));
  el.loadingBarTrack.classList.remove('is-wait');
  el.btnSkip.hidden = true;
  // 多给一拍：百分比要从当前值爬到 100 再淡出，不然「100%」来不及被看见
  setTimeout(() => el.loading.classList.add('done'), 480);
  // 默认音乐等首屏放完再取：2MB 的音频和 5.7MB 的模型抢同一条带宽，
  // 先取音乐只会把模型拖慢，而音乐本来就要等用户点才响。
  loadDefaultMusic();
}

/* ---------------- 延后构建的特效 ---------------- */

function scheduleExtras() {
  const run = () => { if (!extrasStarted) buildExtras(); };
  // 首帧之后紧接着还有着色器编译的余震，等一个空闲窗口再建，别贴着首帧
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2500 });
  else setTimeout(run, 260);
}

async function buildExtras() {
  extrasStarted = true;
  try {
    const [{ LoveMessage }, { WishLantern }, { Confetti }, { MissYou }] = await Promise.all([
      import('./LoveMessage.js'),
      import('./WishLantern.js'),
      import('./Confetti.js'),
      import('./MissYou.js'),
    ]);
    loveMsg = new LoveMessage(scene, { count: lowPower ? 1200 : 2200 });
    // 孔明灯：6 盏 × 340 颗 = 2040，比原来那串文字弹幕（16000）轻得多，
    // 因为它不需要采样字形，全部是程序化分布在灯身和火光上
    lantern = new WishLantern(scene, { count: lowPower ? 960 : 2040 });
    // 纸屑：每片 8 个点，3200 点 = 400 片。没有字形要采样，比原来的
    // 「五角星 + 666」（9000 点）轻一多半
    confetti = new Confetti(scene, { count: lowPower ? 1400 : 2400 });
    missYou = new MissYou(scene, { count: lowPower ? 6000 : 10500 });
    for (const o of [loveMsg, lantern, confetti, missYou]) o.setPixelRatio(pixelRatio);
    if (window.__app) Object.assign(window.__app, { loveMsg, lantern, confetti, missYou });
  } catch (err) {
    // 建不出来就当没有这几段特效，主场景照常跑
    extrasStarted = false;
    console.warn('[extras] 特效模块加载失败', err);
  }
}

/** rig 只进不退：并行的小步骤互相超越时，别让进度条回跳 */
function stepRig(v) {
  if (bootState.rig < v) bootState.rig = v;
  paintLoading();
}

function startGesture() {
  return (async () => {
    stepRig(0.06);
    // 模型 buffer 先到手，才谈得上建 landmarker；摄像头授权跟它并行进行
    const pre = await modelPrefetch;
    stepRig(0.45);
    bootState.rigT0 = performance.now();   // 从这里开始按时间估进度（见 paintLoading）
    const ok = await gesture.init({
      ...(pre || {}),
      // 只为摄像头小窗里那行字（模型 % / 正在初始化模型…），不参与进度条：
      // wasm/init 没有可信的百分比，进度条的节奏统一交给 rigT0 的时间估算
      onProgress: (p) => {
        modelProgress = { ...modelProgress, ...p };
        renderModelProgress();
      },
    });
    stepRig(1);
    return ok;
  })();
}

/**
 * 等「真的画出来了一帧」再继续。
 *
 * 不能只 requestAnimationFrame(() => r())：那样 await 的后续是微任务，
 * 会在同一个帧里、浏览器真正绘制之前就执行 —— 紧接着的建场长任务把这一帧
 * 直接吞掉，首屏遮罩就白等了（实测 FCP 在 220ms 和 1.3s 之间随机跳）。
 * rAF 之后再排一个宏任务，就落在这帧绘制之后了。
 */
function nextPaint() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

if (DEBUG) {
  window.__app = { gesture, router, tree, spiral, groundBase, ripple, archery, clickBurst, effects, audio, gifts, heart, loveMsg, lantern, confetti, missYou, breath, beatDetector, camera, bootState,
    tips: {
      list: TIPS,
      get idx() { return tipIdx; },
      get done() { return [...tipsDone]; },
      pickTip, tickTips, startTips,
    } };
  // loveMsg / lantern / confetti / missYou 是空闲时段才建的，buildExtras 里建好后会补挂上来
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
  if (loveMsg) loveMsg.trigger(new THREE.Vector3(0, 5.6, 5.6), 2.6);
});

// 按 6 手动放一次孔明灯：不用比手势也能确认这段特效在不在
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key !== '6') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (/INPUT|TEXTAREA/.test(tag)) return;
  if (lantern) lantern.trigger(clock.elapsedTime);
});

// 按 M 手动放一次 OK 那段：不用比手势也能确认爱心 / 流星 / 烟花 / miss you
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'm') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (/INPUT|TEXTAREA/.test(tag)) return;
  if (missYou) missYou.trigger(clock.elapsedTime);
});

// 按 L 手动撒一次纸屑：不用比手势也能确认点赞这段在不在
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'l') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (/INPUT|TEXTAREA/.test(tag)) return;
  if (confetti) confetti.trigger(clock.elapsedTime);
});

// 按 B 看一次「拉弓 → 放箭 → 穿心 → 粒子散开」：不用比手势也能确认这段在不在
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'b') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (/INPUT|TEXTAREA/.test(tag)) return;
  archery.demoShot(clock.elapsedTime);
});

// 按 S 手动触发一次「拍手暴雪」：不用真拍手也能反复看雪量 / 亮度 / 相机后推。
// 走的是和真手势同一个入口，所以 HUD 那条「拍手」提示也会跟着亮。
// router 里 explode / storm 都取 max，连按不会叠成两次爆炸，只是把衰减曲线拉回峰值。
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 's') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (/INPUT|TEXTAREA/.test(tag)) return;
  handleGestureEvent('clap', { strength: 1 });
});

// 按 W 切换「树底水波纹演示」（仅当 RIPPLE_ENABLED 时有意义；关着就提示一下）
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'w') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (/INPUT|TEXTAREA/.test(tag)) return;
  if (!ripple) { setStatus(t('rippleOff')); return; }
  rippleDemo = !rippleDemo;
  const diag = rippleDiagnosis();
  console.log('[水波纹] 演示模式', rippleDemo ? '开' : '关', '·', diag);
  setStatus(rippleDemo ? '水波纹演示 · ' + diag : '水波纹演示关 · ' + diag);
});

// 摄像头小窗占位文案的状态（null = 还没启动 / needHttps / denied）。
// 存 key 而不是存字符串：切换语言时按新语言重取。
let camOffState = null;
function applyCamOff(state) {
  if (state !== undefined) camOffState = state;
  if (el.camOff) el.camOff.textContent = camOffState ? t('camOff.' + camOffState) : t('camOff');
}

/* ---------------- 语言切换（内容页里也能切） ---------------- */

// 语言按钮上显示的短标签：固定写死，不进词典（「中」这种字不需要被翻译）
const LANG_LABEL = { zh: '中', en: 'EN', th: 'ไท' };

// 曲名区当前显示的是什么。记 key（或歌名），不记旧语言的字符串——
// 切语言时才知道该用新语言重取哪句。
let trackLabel = { key: 'trackNone', name: null };
function setTrackLabel(key, name = null) {
  trackLabel = { key: key || trackLabel.key, name };
  el.trackName.textContent = name !== null ? name : t(key);
}

// 音乐弹窗主按钮当前处在哪个态（idle/loading/slow/failed），切语言时重画
let promptState = 'idle';

/** 语言切走之后，把所有「JS 写出来的」动态文案按新语言重刷一遍。
 *  静态文案（按钮字、玩法一览、弹窗、toast 等）由 applyStatic() 负责，那边先调。 */
function refreshDynamicTexts() {
  // 播放/暂停按钮：按当前播放状态取词
  el.btnPause.textContent = audio.playing ? t('btnPause') : t('btnPlay');
  // 曲名区
  setTrackLabel(trackLabel.key, trackLabel.name);
  // 音乐弹窗（如果正开着某个态）
  if (el.musicPrompt && !el.musicPrompt.hidden && promptState !== 'idle') {
    setPromptButtons(promptState);
  }
  applyCamOff();
  bowTipKey = '';          // 拉弓提示下一帧按新语言重写
  // 底部提示条：正在轮换玩法提示就换成新语言那条；被系统消息顶掉时不动，
  // 那条消息是瞬时的，下一轮 tick 会恢复玩法提示（到时候自然用新语言）
  if (tipIdx >= 0 && !tipHoldUntil) el.statusText.textContent = t(TIPS[tipIdx].key);
}

/** 统一的切语言入口：首屏选择器和内容页的语言按钮都走这里 */
function switchLanguage(lang) {
  setLang(lang);
  applyStatic();                       // 标题/按钮字/一览/弹窗/toast 等静态全部重刷
  syncLangPickButtons();
  if (el.btnLang) el.btnLang.textContent = LANG_LABEL[getLang()];
  refreshDynamicTexts();
}

function syncLangPickButtons() {
  if (!el.langPick) return;
  el.langPick.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === getLang());
  });
}

/** 首屏语言选择器：点了立即切语言（存 localStorage），下次进来自动预选 */
function initLangPick() {
  if (!el.langPick) return;
  syncLangPickButtons();
  el.langPick.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lang]');
    if (!b) return;
    switchLanguage(b.dataset.lang);
    // 已经画过的遮罩进度行按新语言重画
    if (!bootState.finished) paintLoading();
  });
}

/** 内容页的语言按钮：中 → EN → ไท → 中 循环。切换即刻生效并持久化 */
el.btnLang.addEventListener('click', () => {
  const order = ['zh', 'en', 'th'];
  const next = order[(order.indexOf(getLang()) + 1) % order.length];
  switchLanguage(next);
});

boot();
initLangPick();
