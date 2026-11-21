import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';
import { GESTURE_SWITCH } from './gestureConfig.js';

const TIP = [8, 12, 16, 20];
const PIP = [6, 10, 14, 18];
const MCP = [5, 9, 13, 17];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const DELEGATE_KEY = 'mp-delegate';

/**
 * 扇风方向符号。
 * 画面是镜像显示的，法线的 x 分量要翻一下才和「屏幕左右」一致。
 * 真机上如果出现「手往右扇、树往左跑」，把这里改成 1 即可。
 */
const SIDE_SIGN = -1;

/** 「抓取 → 张开手掌」的阈值 */
const BURST_CFG = {
  grab: 0.50,        // 抓取程度达到它才算「抓到了」（1 = 五指完全收进掌心）
  grabOpen: 0.62,    // 抓握时手掌不可能很开，超过它直接不算，避免张开手被当成抓取
  hold: 90,          // 抓取要保持多久才算数（路过时指尖扫一下不算）
  open: 0.72,        // 「张开手掌」的 openness 门槛
  window: 1200,      // 抓取后多久之内张开才算数
  cooldown: 700,     // 两次炸裂的最短间隔
};

/**
 * 「点赞」（拇指竖起、其余四指收回）的判定与节流参数。
 *
 * 这个手势和「比 6 / 打电话」几何上只差一根小指，所以分数里专门乘了
 * 一项「小指收回」的权重：小指一伸出去，分数直接掉到 0，绝不会互相抢。
 */
const LIKE_CFG = {
  threshold: 0.70,   // like 分数门槛（拇指朝上 ≈0.95，握拳 ≈0.5，比 6 ≈0.35）
  hold: 240,         // 稳住多久才触发（抬手路过不会误触）
  cooldown: 3000,    // 两轮之间的最短间隔
  burstGuard: 0.45,  // like 超过它时不认「抓取」，否则点赞收手会被当成张手炸雪
};

/** 双手比心的软阈值。全部是「渐进打分」而不是硬与门，落到某一条不满足时会写进 probe.stage */
/**
 * 「单手 OK」：拇指和食指捏成圈，另外三根手指伸开。
 *
 * 和「捏合（pinch）」只差一件事 —— 另外三指是伸还是屈。捏合时手指多半收着，
 * 比 OK 时是张开的，这一条把两者分得很干净。
 * 和「比 6 / 打电话」也正好相反：那个是中间三指收拢、小指伸出。
 *
 * 整段特效 8.5 秒，所以冷却给到 9 秒：手势一直比着也只会完整放一轮。
 */
const OK_CFG = {
  threshold: 0.62,
  hold: 260,         // 稳住多久才认（抬手路过不算）
  cooldown: 9000,
};

/**
 * 「双手拉弓」：两只手一前一后拉开，像把弦拉满。
 *
 * 为什么能和不冲突的手势分开 —— 全部靠「几何构型」而不是时序：
 *   比心：两手并拢（指尖距离 < 1.3 手宽），拉弓要求 >= 1.5 手宽，天然互斥；
 *   双手开合缩放：两手都摊开，拉弓要求至少一只手是「握」的（clutch 高），
 *     拉弦那只手的食指中指是勾着的，这正好是 clutch 的形态；
 *   拍手：两手快速合拢 —— 它发生在拉弓**之后**，所以拉弓期间要反过来压住 clap。
 *
 * 拉伸量 pull 不做「绝对像素」映射，而是除以手宽再归一：手离镜头远近、
 * 用户手大手小都不影响。0.45 以下是「还没拉开」，0.85 以上算满弓。
 */
/**
 * 拉弓的参数全部往「宽松」一侧调过一次。第一版是拿「标准姿势」量出来的：
 * 两手水平、间距 4.6 个手宽、勾弦的手必须半握、放箭要快过 3.2 手宽/秒 ——
 * 实测绝大多数人做不到其中任意一条，于是「比划了半天弓不出来」。
 *
 * 三条最卡人的：
 *   1. 手必须**水平**对齐（levelZero 1.65）。可画面里的弓是斜指左上的，
 *      人一比划自然就带斜度，于是判不出来 → 放到 2.30；
 *   2. 拉满要 4.6 个手宽。真人两只手都在胸前，胳膊展开也就 3 个手宽左右
 *      → 拉到 3.6 就算满弓；
 *   3. 勾弦的手必须握成拳（clutch > 0.52）。自然放松的手 clutch ≈ 0.4~0.45，
 *      根本够不着 → 降到 0.30（摊平的掌 ≈ 0，那一类仍然留给「双手开合缩放」）。
 */
const BOW_CFG = {
  start: 1.12,        // 两手间距 / 手宽，低于它还没开始拉
  full: 3.60,         // 拉满
  levelFull: 0.90,    // 两手高度差 / 手宽（越小越正）
  levelZero: 2.30,
  // 五指收向掌心的程度（clutch）：握拳 ≈ 1.0，自然放松的手 ≈ 0.4，摊平的掌 ≈ 0。
  // 0.30 只排除「完全摊开」——那一类属于「双手开合缩放」，不能抢。
  gripMin: 0.30,
  gripFull: 0.72,
  threshold: 0.26,    // levelScore 门槛
  hold: 150,          // 姿势稳住多久才让弓出现
  releaseMs: 340,     // 松手滞回：追踪抖一下不让弓闪掉
  drop: 0.15,         // pull 从峰值回落这么多 = 放箭（唯一判据，不受跟丢重捕影响）
  peakMin: 0.24,      // 峰值至少拉到这儿才允许放箭
  handLossPeak: 0.34, // 一只手直接消失时，至少拉到这个程度才算「放箭」
  guard: 420,         // 放完箭后的冷却：手合拢的过程不能立刻又被判成拉弓
  cooldown: 1100,
};

const HEART_CFG = {
  gapNear: 0.02, gapNearFull: 0.16,     // 两手指尖几乎重叠 → 更像拍手，降分
  gapFarFull: 1.30, gapFarZero: 1.90,   // 心形是两手并拢（约一拳内），拉得更开就是缩放
  levelFull: 0.85, levelZero: 1.60,     // 两手高度差（按手宽归一）
  rateFull: 2.50, rateZero: 5.00,       // 指尖间距变化速度（手宽/秒）：只挡住快速挥舞
  holdMs: 260,                          // 稳定保持多久才点亮
  releaseMs: 220,                       // 松手后多久才熄灭（滞回，防闪）
  threshold: 0.40,
  clapGuard: 300,
  ringGate: 0.55,
  gapSmooth: 0.30,                      // 指尖间距低通：吃掉 MediaPipe 的逐帧抖动
  rateSmooth: 0.30,
};

const smooth = (x) => {
  const v = clamp01(x);
  return v * v * (3 - 2 * v);
};

function readDelegate() {
  try {
    return localStorage.getItem(DELEGATE_KEY) === 'CPU' ? 'CPU' : 'GPU';
  } catch {
    return 'GPU';
  }
}

function rememberDelegate(d) {
  try {
    localStorage.setItem(DELEGATE_KEY, d);
  } catch {
    /* 隐私模式忽略 */
  }
}

/**
 * MediaPipe HandLandmarker 封装。
 * 输出每只手的结构化状态（掌心、开合度、捏合、掌面朝向、运动速度），
 * 以及离散手势事件：burst（张手炸裂）、clap（拍手）、tray（托盘）。
 */
export class GestureController {
  constructor({ video, onEvent, onStatus }) {
    this.video = video;
    this.onEvent = onEvent || (() => {});
    this.onStatus = onStatus || (() => {});
    this.landmarker = null;
    this.stream = null;
    this.ready = false;
    this.lastVideoTime = -1;
    this.lastDetectAt = 0;
    this.hands = [];
    this.slots = { Left: null, Right: null };
    this.spread = null;
    this.trayActive = false;
    this.traySince = 0;
    this.lastClapAt = 0;
    this.farDist = null;
    this.farAt = 0;
    this.handStates = {};
    // 「打电话 / 比 6」：要稳住 240ms 才触发，触发后必须放下手才能再触发一次
    this.phoneSince = 0;
    this.phoneOn = false;
    this.lastCallAt = 0;
    // 「点赞」：同样的边沿触发 + 冷却
    this.likeSince = 0;
    this.likeOn = false;
    this.lastLikeAt = 0;

    this.okSince = 0;
    this.okOn = false;
    this.lastOkAt = 0;
    this.lastBurstAt = 0;

    // 双手比心
    this.heart = { active: false, strength: 0, x: 0.5, y: 0.55, radius: 0.12 };
    this.heartHoldSince = 0;
    this.heartOn = false;
    this.heartOffSince = 0;
    this.heartLastAt = 0;
    this.heartGap = null;
    this.heartGapRate = 0;

    // 双手拉弓：连续值（拉多少）+ 一句「放箭」事件
    this.bow = { active: false, pull: 0, sep: 0, level: 0, grip: 0, x: 0.5, y: 0.5 };
    this.bowLastAt = 0;
    this.bowSince = 0;
    this.bowOffSince = 0;
    this.bowPeak = 0;
    this.bowGuardUntil = 0;
    this.lastBowAt = 0;
    this.bowSepPrev = null;
    this.bowSepRate = 0;
    // 调试探针：真机上比心不出效果时，看这几个数就知道卡在哪一步
    this.probe = { ringA: 0, ringB: 0, gap: 0, level: 0, rate: 0, score: 0, stage: '-' };

    this.state = {
      hands: [],
      handCount: 0,
      spread: null,
      tray: null,
      heart: this.heart,
      bow: this.bow,
    };
  }

  /**
   * @param {object} prefetched 由 assetLoader 预取的结果（可选）
   *   { wasmBase, modelBuffer, onProgress }
   * 模型下载与摄像头授权并行进行，谁先完成都不影响另一个。
   *
   * onStatus(cn, en) 会被三处调用：请求权限 → 启动识别 → 就绪。
   * 首屏遮罩直接拿这三句当中英文案，所以英文必须一起给。
   */
  async init(prefetched = {}) {
    const {
      wasmBase = './vendor/mediapipe/wasm',
      modelBuffer = null,
      onProgress = null,
    } = prefetched;

    if (!navigator.mediaDevices || !window.isSecureContext) {
      throw new Error('摄像头需要 https 或 localhost 环境');
    }

    // 先把摄像头权限问出来，别让用户盯着进度条等模型
    let cameraDone = false;
    const cameraPromise = this._startCamera();
    // 两个回调都给：只给成功那个的话，拒绝时这里会多一条 unhandled rejection
    cameraPromise.then(() => { cameraDone = true; }, () => {});
    cameraPromise.catch(() => {});   // 稍后统一 await，这里只避免 unhandled rejection

    try {
      await this._createLandmarker(wasmBase, modelBuffer, onProgress);
    } catch (err) {
      this._stopCamera();
      throw err;
    }

    // 模型建完却还没就绪，只可能是在等摄像头 —— 文案说清楚，
    // 免得用户以为「正在启动」这句卡死了（其实是权限弹窗还没人点）
    if (!cameraDone) this.onStatus('正在等待摄像头…', 'Waiting for the camera…');
    await cameraPromise;
    performance.mark('mp:camera-ready');
    this.ready = true;
    this.onStatus('把手举到镜头前', 'Raise your hands to the camera');
    return true;
  }

  async _createLandmarker(wasmBase, modelBuffer, onProgress) {
    this.onStatus('正在启动手势识别…', 'Starting hand tracking…');
    performance.mark('mp:wasm-start');
    const vision = await FilesetResolver.forVisionTasks(wasmBase);
    performance.mark('mp:wasm-ready');
    onProgress?.({ phase: 'wasm' });

    // 已预取到内存就直接喂 buffer，免掉第二次网络请求
    const baseOptions = modelBuffer
      ? { modelAssetBuffer: new Uint8Array(modelBuffer), delegate: 'GPU' }
      : { modelAssetPath: './assets/hand_landmarker.task', delegate: 'GPU' };

    const options = {
      baseOptions,
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    };

    onProgress?.({ phase: 'init' });
    performance.mark('mp:init-start');

    // 记住上次成功的 delegate：移动端 GPU 常初始化失败，
    // 若每次都先试 GPU 再退回 CPU，等于白等一次（几百毫秒）
    const make = (delegate) => ({ ...options, baseOptions: { ...baseOptions, delegate } });
    const preferred = readDelegate();

    try {
      this.landmarker = await HandLandmarker.createFromOptions(vision, make(preferred));
      rememberDelegate(preferred);
    } catch (err) {
      const fallback = preferred === 'GPU' ? 'CPU' : 'GPU';
      console.warn(`[gesture] ${preferred} delegate 初始化失败，改用 ${fallback}`, err);
      this.landmarker = await HandLandmarker.createFromOptions(vision, make(fallback));
      rememberDelegate(fallback);
    }

    performance.mark('mp:init-done');
    performance.measure('mp:wasm', 'mp:wasm-start', 'mp:wasm-ready');
    performance.measure('mp:init', 'mp:init-start', 'mp:init-done');
  }

  async _startCamera() {
    this.onStatus('正在请求摄像头权限…', 'Asking for camera access…');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user',
      },
      audio: false,
    });

    this.video.srcObject = this.stream;
    await this.video.play();
    await new Promise((resolve) => {
      if (this.video.videoWidth > 0) return resolve();
      this.video.onloadedmetadata = () => resolve();
    });
  }

  _stopCamera() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  update(now) {
    if (!this.ready) return this.state;
    if (this.video.readyState < 2) return this.state;

    // 摄像头帧率通常 30fps，限制检测频率，避免主线程被占满
    if (now - this.lastDetectAt < 26) return this.state;
    this.lastDetectAt = now;
    if (this.video.currentTime === this.lastVideoTime) return this.state;
    this.lastVideoTime = this.video.currentTime;

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, now);
    } catch (err) {
      return this.state;
    }

    const aspect = (this.video.videoWidth || 640) / (this.video.videoHeight || 480);
    const hands = [];

    if (result && result.landmarks) {
      for (let i = 0; i < result.landmarks.length; i++) {
        const lm = result.landmarks[i];
        const label = result.handedness?.[i]?.[0]?.categoryName || `H${i}`;
        hands.push(this._describeHand(lm, aspect, label));
      }
    }

    // 平滑：按左右手槽位保留上一帧位置，避免抖动
    for (const h of hands) {
      const prev = this.slots[h.label];
      if (prev && h.label !== 'H0' && h.label !== 'H1') {
        h.palm.x = prev.palm.x * 0.55 + h.palm.x * 0.45;
        h.palm.y = prev.palm.y * 0.55 + h.palm.y * 0.45;
        h.motion.x = (h.palm.x - prev.palm.x) * 1000;
        h.motion.y = (h.palm.y - prev.palm.y) * 1000;
      }
      this.slots[h.label] = { palm: { ...h.palm } };
    }

    // 拉弓要先算：它要压住 clap（放箭＝两手合拢，几何上就是拍手）
    // 和比心（拉弓时两手分开、比心时两手并拢，用 pull 就能区分）
    this.state.bow = this._computeBow(hands, now);

    this._detectEvents(hands, now);

    this.state.hands = hands;
    this.state.handCount = hands.length;
    this.state.spread = this._computeSpread(hands);
    this.state.tray = this._computeTray(hands, now);
    this.state.heart = this._computeHeart(hands, now);
    return this.state;
  }

  _describeHand(lm, aspect, label) {
    const p = (i) => ({ x: lm[i].x * aspect, y: lm[i].y, z: lm[i].z || 0 });
    const px = (i) => ({ x: lm[i].x, y: lm[i].y, z: lm[i].z || 0 });

    const wrist = p(0);
    const middleMcp = p(9);
    const size = Math.max(0.02, dist2(wrist, middleMcp));

    const palm = { x: 0, y: 0 };
    for (const i of [0, 5, 9, 13, 17]) {
      palm.x += p(i).x / 5;
      palm.y += p(i).y / 5;
    }

    let extended = 0;
    for (let k = 0; k < 4; k++) {
      const dTip = dist2(p(TIP[k]), wrist);
      const dPip = dist2(p(PIP[k]), wrist);
      if (dTip > dPip * 1.12) extended++;
    }
    const openness = extended / 4;

    const pinchRaw = dist2(p(4), p(8)) / size;
    const pinch = clamp01(1 - (pinchRaw - 0.25) / 0.55);

    // 「圈」：拇指尖与食指尖是否闭合，比心的关键判据。
    // 门槛刻意放得比 pinch 宽：真人比心时两个指尖常留一两毫米缝，
    // 640×480 下这点缝就足够让严格阈值判负 —— 之前比心一次都不出的主因之一。
    // pinchRaw ≤ 0.30 → 1.0，≈0.72 → 0.5，≥1.15 → 0
    const ring = clamp01(1 - (pinchRaw - 0.30) / 0.85);
    const tipMid = { x: (p(4).x + p(8).x) / 2, y: (p(4).y + p(8).y) / 2 };

    // 食指是否伸出：比心时食指是伸直向外张开的，半握拳时不是。
    // 只用于辅助评分，不做硬判定，避免手势细节差异把人挡在外面。
    const indexStraight = dist2(p(8), wrist) > dist2(p(6), wrist) * 1.12;

    // 五指「抓取」程度：五个指尖收向掌心的程度，按手宽归一。
    // 为什么不用「指尖聚成一点」（tipSpread）：那是「捏」的特征，
    // 真人做「抓一把」时手指是各自向内钩的，指尖之间还留着间距，
    // 只有「指尖离掌心越来越近」才是抓取。张开手掌 ≈1.0，抓握 ≈0.5~0.7。
    const tips = [4, 8, 12, 16, 20];
    let tipToPalm = 0;
    for (const k of tips) tipToPalm += Math.hypot(p(k).x - palm.x, p(k).y - palm.y);
    const clutchRaw = tipToPalm / tips.length / size;
    const clutch = clamp01(1 - (clutchRaw - 0.66) / 0.34);

    let tcx = 0;
    let tcy = 0;
    for (const k of tips) {
      tcx += p(k).x;
      tcy += p(k).y;
    }
    tcx /= tips.length;
    tcy /= tips.length;
    let tipSum = 0;
    for (const k of tips) tipSum += Math.hypot(p(k).x - tcx, p(k).y - tcy);
    // 按手宽归一：张开手掌约 0.55~0.75，五指捏一起约 0.12~0.20
    const tipSpread = tipSum / tips.length / size;
    const gather = clamp01(1 - (tipSpread - 0.22) / 0.30);

    // 「打电话 / 比 6」：拇指和小指伸出，中间三指收拢。
    // 这是最好认的手势之一（两个指头张得很开），也很少和别的手势撞车：
    // 比心是拇指+食指成圈，抓取是五指全收，扇风要求掌面朝侧。
    const thumbOut = clamp01((dist2(p(4), p(5)) / size - 0.42) / 0.36);
    const pinkyOut = clamp01((dist2(p(20), wrist) / Math.max(0.001, dist2(p(18), wrist)) - 1.02) / 0.22);
    let midCurled = 0;
    for (const k of [0, 1, 2]) {
      if (dist2(p(TIP[k]), wrist) <= dist2(p(PIP[k]), wrist) * 1.08) midCurled++;
    }
    const phone = clamp01(thumbOut * 0.34 + pinkyOut * 0.30 + (midCurled / 3) * 0.36);

    // 「点赞」：拇指竖起朝上，其余四指全部收回。
    // 三个分量：拇指伸得多开（thumbOut）、四指收得多彻底（fourCurled）、
    // 拇指是不是**朝上**（upness，拇指方向向量的 y 分量）。
    // 最后乘 pinkyKeep：小指一伸出去分数归零 —— 那是「比 6」，不能让两个手势互相抢。
    let curled4 = 0;
    for (let k = 0; k < 4; k++) {
      if (dist2(p(TIP[k]), wrist) <= dist2(p(PIP[k]), wrist) * 1.10) curled4++;
    }
    const fourCurled = curled4 / 4;
    const tv = { x: p(4).x - p(2).x, y: p(4).y - p(2).y };
    const tvl = Math.hypot(tv.x, tv.y) || 1e-4;
    const upness = clamp01((-tv.y / tvl - 0.20) / 0.50);   // y 轴朝下，取负才是「向上」
    const pinkyKeep = 1 - clamp01((pinkyOut - 0.25) / 0.45);
    // 拇指必须真的**伸出去**：握拳时拇指是横搭在指头上的，方向也朝上，
    // 单看方向会把握拳判成点赞（实测拳头 upness 也是 1.0）。thumbOut 才是分水岭。
    const thumbGate = clamp01((thumbOut - 0.25) / 0.35);
    // 关掉 like 时直接给 0：否则「点赞姿态不准抓取」这条保护仍然生效，
    // 抓取炸裂会被一个根本不播特效的手势按住
    const like = GESTURE_SWITCH.like
      ? clamp01(thumbOut * 0.40 + fourCurled * 0.32 + upness * 0.28) * pinkyKeep * thumbGate
      : 0;

    // 「OK」：拇指尖和食指尖捏成圈（ring 已经算过），同时中/无名/小指伸开。
    // 还要让位给「比 6」：那个手势中间三指是收拢的，phone 分数高，直接扣到 0。
    let ext3 = 0;
    for (const k of [1, 2, 3]) {
      if (dist2(p(TIP[k]), wrist) > dist2(p(PIP[k]), wrist) * 1.15) ext3++;
    }
    const ext3n = ext3 / 3;
    const ok = GESTURE_SWITCH.ok
      ? clamp01((ring - 0.42) / 0.42)
        * clamp01((ext3n - 0.42) / 0.58)
        * (1 - clamp01((phone - 0.55) / 0.45))
      : 0;

    // 掌面法线（3D，y 轴向下）
    const v1 = { x: p(5).x - p(0).x, y: p(5).y - p(0).y, z: p(5).z - p(0).z };
    const v2 = { x: p(17).x - p(0).x, y: p(17).y - p(0).y, z: p(17).z - p(0).z };
    let nx = v1.y * v2.z - v1.z * v2.y;
    let ny = v1.z * v2.x - v1.x * v2.z;
    let nz = v1.x * v2.y - v1.y * v2.x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;

    const fingerDir = { x: p(9).x - p(0).x, y: p(9).y - p(0).y };
    const fl = Math.hypot(fingerDir.x, fingerDir.y) || 1;
    const fingerHorizontal = Math.abs(fingerDir.y / fl);

    // 掌面「侧立」程度：掌心朝左 / 朝右，这是「扇风」和普通挥手的区别。
    // nx 是相机空间法线的 x 分量；画面是镜像的，取负号后才和屏幕左右一致。
    //   sideW = 1 → 掌心正对侧面（手竖起来）；0 → 掌心朝镜头或朝上
    // 曲线刻意放得很宽（|nx| 0.28 起步、0.60 满分）：MediaPipe 的 3D 法线在
    // 手掌侧对镜头时估得偏保守，真人「斜着侧立」常常只给到 0.5~0.6 的 |nx|，
    // 用旧阈值会被判成「不是扇风」，于是手势怎么比都不转。
    const palmSide = nx * SIDE_SIGN;
    const sideW = smooth((Math.abs(nx) - 0.28) / 0.32)
      * (1 - smooth((Math.abs(ny) - 0.58) / 0.34));

    let gesture = 'other';
    if (openness >= 0.75 && pinch < 0.45) gesture = 'open';
    // 握拳被 GESTURE_SWITCH.fist 关掉时，这里直接不产出 'fist'：
    // 下游的收拢（collapse）和张手炸裂（burst）都依赖这个标签，一处关掉两处都停。
    else if (openness <= 0.25 && GESTURE_SWITCH.fist) gesture = 'fist';
    else if (pinch > 0.75) gesture = 'pinch';

    return {
      label,
      landmarks: lm,
      palm,                              // 归一化 0..1（未镜像，x 已乘 aspect）
      palmMirrored: { x: 1 - palm.x / aspect, y: palm.y },
      size,
      openness,
      pinch,
      pinchRaw,
      ring,
      indexStraight,
      tipSpread,
      gather,
      clutch,
      clutchRaw,
      phone,
      like,
      ok,
      ext3,
      tipMid,
      tipMidMirrored: { x: 1 - tipMid.x / aspect, y: tipMid.y },
      palmUp: Math.abs(ny) > 0.55 && fingerHorizontal < 0.55,
      palmSide,                          // -1..1，正 = 掌心朝屏幕右侧
      sideW,                             // 0..1，掌面侧立程度（扇风判据）
      palmFacing: nz,
      gesture,
      motion: { x: 0, y: 0 },
      extended,
    };
  }

  _computeSpread(hands) {
    if (hands.length < 2) return null;
    const [a, b] = hands;
    return Math.hypot(a.palm.x - b.palm.x, a.palm.y - b.palm.y);
  }

  /**
   * 双手拉弓。
   *
   * 输出的不是「一次事件」，而是一条连续曲线 pull（0..1）—— 弦的弯曲、
   * 箭的回撤、弓身的形变都靠它，所以必须逐帧跟手，不能只在触发时给一个数。
   *
   * 放箭的判据是「两手**快速**合拢」而不是「pull 变小」：
   * 后者在把手放下去的时候也会成立，结果每次收手都白射一箭。
   * 快速合拢是物理上不同的一件事 —— 拉弦的手一松，两只手是弹回去的。
   */
  _computeBow(hands, now) {
    const b = this.bow;
    if (!GESTURE_SWITCH.bow) {
      b.active = false;
      b.pull = 0;
      b.sep = 0;
      b.level = 0;
      b.grip = 0;
      this.bowPeak = 0;
      this.bowSince = 0;
      this.bowOffSince = 0;
      this.bowSepRate = 0;
      return b;
    }

    const dt = this.bowLastAt ? Math.min(0.2, Math.max(0.008, (now - this.bowLastAt) / 1000)) : 0.016;
    this.bowLastAt = now;

    let sep = 0;
    let level = 0;
    let grip = 0;
    let posed = false;
    let sepRate = 0;

    if (hands.length === 2) {
      const [a, c] = hands;
      const sizeAvg = Math.max(0.02, (a.size + c.size) / 2);
      sep = Math.hypot(a.palm.x - c.palm.x, a.palm.y - c.palm.y) / sizeAvg;
      level = Math.abs(a.palm.y - c.palm.y) / sizeAvg;
      // 勾弦那只手是半握的：clutch（五指收向掌心）或 pinch（拇指食指捏）都会高。
      // 摊开的双手 clutch≈0 —— 那正是「双手开合缩放」，不能抢。
      grip = Math.max(a.clutch, c.clutch, a.pinch, c.pinch);
      const levelScore = 1 - smooth((level - BOW_CFG.levelFull) / (BOW_CFG.levelZero - BOW_CFG.levelFull));
      const gripScore = smooth((grip - BOW_CFG.gripMin) / (BOW_CFG.gripFull - BOW_CFG.gripMin));
      // 比心期间不判拉弓：两手并拢做心时「掌间距」照样超过 start（1.12 手宽），
      // 而且捏半心时 pinch 很高、握姿那一关也过得去 ——
      // 不排掉就会一边比心一边从右下角冒出一把弓。这里读的是上一帧的心状态，
      // 差一帧无所谓：心的入场要稳 260ms，弓的入场也要稳 150ms。
      const heartBusy = !!(this.heart && (this.heart.active || this.heart.strength > 0.30));
      // grip 只做「排除摊平的手」，不再要求它很高：0.06 的门槛意味着
      // 只要 clutch 过了一点点线就算 —— 真正的区分交给下面那条 sep > start
      posed = !heartBusy && levelScore > BOW_CFG.threshold
        && gripScore > 0.06 && sep > BOW_CFG.start;
      b.x = (a.palmMirrored.x + c.palmMirrored.x) / 2;
      b.y = (a.palmMirrored.y + c.palmMirrored.y) / 2;

      // 只做探针用的手间距变化率（手宽/秒，负 = 在靠近）。
      // **不要**拿它当放箭判据：手一旦被跟丢重捕，位置会跳，瞬时时序速度
      // 能到几百 —— 那会被当成一次猛烈的「弹弦」，凭空放出一箭。
      // 放箭只看 pull 的回落，pull 本身是低通过（10/s），跳变进不来。
      const inst = this.bowSepPrev == null ? 0 : (sep - this.bowSepPrev) / Math.max(dt, 0.008);
      this.bowSepRate += (Math.max(-20, Math.min(20, inst)) - this.bowSepRate) * 0.35;
      this.bowSepPrev = sep;
      sepRate = this.bowSepRate;
    } else {
      this.bowSepPrev = null;
      this.bowSepRate = 0;
      // 这里**不能**清 bowOffSince：清了以后下面那句 `if (!bowOffSince)` 会
      // 每帧把它重置成 now，于是「只剩一只手」时 active 永远不会掉，
      // 弓会一直挂在屏幕上、缩放权重也一直被它占着。
    }

    // 入场要稳 220ms（双手抬起来路过不算），退场给 280ms 滞回（追踪抖一下弓不闪）
    if (posed && now > this.bowGuardUntil) {
      this.bowOffSince = 0;
      if (!this.bowSince) this.bowSince = now;
      if (now - this.bowSince >= BOW_CFG.hold) b.active = true;
    } else {
      this.bowSince = 0;
      if (b.active) {
        if (!this.bowOffSince) this.bowOffSince = now;
        if (now - this.bowOffSince >= BOW_CFG.releaseMs) b.active = false;
      }
    }

    // 拉弓量：手间距按「手宽」归一后再做一次平滑映射
    const target = b.active
      ? smooth((sep - BOW_CFG.start) / (BOW_CFG.full - BOW_CFG.start))
      : 0;
    b.pull += (target - b.pull) * (1 - Math.exp(-dt * (b.active ? 10 : 5.5)));
    if (b.pull < 0.004) b.pull = 0;

    b.sep = sep;
    b.level = level;
    b.grip = grip;
    b.rate = sepRate;

    // ---- 放箭 ----
    // 峰值以 1.15/s 缓慢回落：只要 pull 掉得比这个快，drop 就会累积到 0.15；
    // 而慢慢把手放下（约 0.5~0.7/s）永远追不上它 —— 这就是「弹弦」和
    // 「收手」的区别，不需要人真的做出多快的手速。
    //
    // 两条路都算放箭：
    //   a) pull 从峰值掉了 0.15 —— 松手 / 回收，最自然的那条；
    //   b) 一只手直接从画面里消失 —— 用户会以为没反应，替他放出去。
    // 之所以不用「手合拢的瞬时速度」：手被跟丢重捕时坐标会跳，
    // 一帧就能造出几百手宽/秒的假速度，于是凭空放箭（第一版踩过）。
    // pull 是低通过的量，跳变进不来。
    this.bowPeak = Math.max(b.pull, this.bowPeak - dt * 1.15);
    const drop = this.bowPeak - b.pull;
    const armed = b.active || (this.bowOffSince && now - this.bowOffSince < 240);
    const ready = now - this.lastBowAt > BOW_CFG.cooldown;
    const snapped = drop > BOW_CFG.drop;

    if (armed && ready && this.bowPeak > BOW_CFG.peakMin && snapped) {
      this._fireBow(this.bowPeak, now);
    } else if (ready && hands.length < 2 && this.bowPeak > BOW_CFG.handLossPeak) {
      // 拉满之后一只手直接出了画面（或检测丢了）：当成放箭，否则用户会以为没反应
      this._fireBow(this.bowPeak, now);
    }

    return b;
  }

  _fireBow(pull, now) {
    this.bowPeak = 0;
    this.lastBowAt = now;
    this.bowGuardUntil = now + BOW_CFG.guard;
    this.bow.active = false;
    this.bowSince = 0;
    this.bowOffSince = 0;
    // 0.45 保底：哪怕只拉到一半，箭也要飞得像样；0.85 以上算满弓
    this.onEvent('bowRelease', { power: Math.min(1, Math.max(0.45, pull / 0.85)) });
  }

  _detectEvents(hands, now) {
    // 两手都在做「圈」＝比心姿态。它和拍手/炸裂都是「两手靠近 / 手指收拢」，
    // 几何上容易撞车，所以这两个事件都先排除它。
    const bothRinged = hands.length === 2 && hands[0].ring > 0.5 && hands[1].ring > 0.5;
    // 拉弓期间（含放箭那一刻）两手快速合拢 = 松弦，不是拍手。
    // 不压住的话，每放一箭都会顺手炸一场暴雪，把箭的轨迹盖掉。
    const bowLive = this.bow && (this.bow.active || this.bow.pull > 0.12);

    // 张手炸裂：**单手抓取 → 1.2 秒内张开手掌**。
    // 抓取的判据是「五个指尖一起收向掌心」（clutch），不是「指尖聚成一点」——
    // 真人抓一把时手指是各自向内钩的，指尖之间还留着间距，用「捏」的几何去判会漏。
    // 抓取至少保持 90ms 才算数，手掌扫过镜头不会平白炸一场雪。
    if (GESTURE_SWITCH.burst) {
      for (const h of hands) {
        const st = this.handStates[h.label]
          || (this.handStates[h.label] = { grabbed: false, grabFrom: 0, lastGrab: 0 });
        // 点赞（四指收起）也是 clutch 很高的姿态，不排掉的话，
        // 比完赞顺手张开五指就会平白炸一场雪
        const grabbing = h.clutch > BURST_CFG.grab && h.openness < BURST_CFG.grabOpen
          && h.like < LIKE_CFG.burstGuard;

        if (grabbing) {
          if (!st.grabbed) {
            st.grabbed = true;
            st.grabFrom = now;
          }
          st.lastGrab = now;
        } else if (st.grabbed) {
          const held = st.lastGrab - st.grabFrom;
          const fresh = now - st.lastGrab < BURST_CFG.window;
          if (!fresh) {
            // 抓完直接放下了、也没张开 → 作废，别让下一次抬手平白炸雪
            st.grabbed = false;
          } else if (held >= BURST_CFG.hold && h.openness > BURST_CFG.open) {
            st.grabbed = false;
            if (!bothRinged && !bowLive && now - this.lastBurstAt > BURST_CFG.cooldown) {
              this.lastBurstAt = now;
              this.onEvent('burst', { strength: 1.0, hand: h });
            }
          }
        }
      }
    } else {
      for (const k of Object.keys(this.handStates)) this.handStates[k].grabbed = false;
    }

    // 打电话 / 比 6 → 弹幕。两只手任一比出来都算，取分数高的那只。
    // 稳住 240ms 才触发（摆手、换姿势时不会误触）；触发后必须把手放开/换姿势
    // 才会再触发，所以一直比着不会刷屏，只是弹幕播完就停。
    if (GESTURE_SWITCH.call) {
      let best = null;
      for (const h of hands) {
        // 点赞姿态也可能攒到 0.75 分（四指全收 + 拇指伸得开），必须让位给点赞：
        // 这两者只差一根小指，谁的判据更严就让谁先，否则比个大拇指会先飘出「打电话」。
        if (h.like > 0.5) continue;
        if (h.phone > 0.72 && (!best || h.phone > best.phone)) best = h;
      }
      if (best) {
        if (!this.phoneOn) {
          if (!this.phoneSince) this.phoneSince = now;
          if (now - this.phoneSince > 240 && now - this.lastCallAt > 4000) {
            this.phoneOn = true;
            this.lastCallAt = now;
            this.onEvent('call', { hand: best });
          }
        }
      } else {
        this.phoneSince = 0;
        this.phoneOn = false;
      }
    } else {
      this.phoneSince = 0;
      this.phoneOn = false;
    }

    // 点赞（拇指竖起）→ 粒子大拇指 + 666。
    // 和打电话同一套节流：稳住 240ms 才认，比着不放只出一轮，3 秒冷却兜底。
    if (GESTURE_SWITCH.like) {
      let best = null;
      for (const h of hands) {
        if (h.like > LIKE_CFG.threshold && (!best || h.like > best.like)) best = h;
      }
      if (best) {
        if (!this.likeOn) {
          if (!this.likeSince) this.likeSince = now;
          if (now - this.likeSince > LIKE_CFG.hold && now - this.lastLikeAt > LIKE_CFG.cooldown) {
            this.likeOn = true;
            this.lastLikeAt = now;
            this.onEvent('like', { hand: best });
          }
        }
      } else {
        this.likeSince = 0;
        this.likeOn = false;
      }
    } else {
      this.likeSince = 0;
      this.likeOn = false;
    }

    // 单手 OK → 爱心 / 流星雨 / 烟花 / miss you。
    // 只在「画面里只有一只手」时判：双手比心时两只手的 ring 也都很高，
    // 混进来会把比心当成 OK，满屏爱心先把心形盖掉了。
    if (GESTURE_SWITCH.ok) {
      let best = null;
      if (hands.length === 1) {
        const h = hands[0];
        if (h.ok > OK_CFG.threshold) best = h;
      }
      if (best) {
        if (!this.okOn) {
          if (!this.okSince) this.okSince = now;
          if (now - this.okSince > OK_CFG.hold && now - this.lastOkAt > OK_CFG.cooldown) {
            this.okOn = true;
            this.lastOkAt = now;
            this.onEvent('ok', { hand: best });
          }
        }
      } else {
        this.okSince = 0;
        this.okOn = false;
      }
    } else {
      this.okSince = 0;
      this.okOn = false;
    }

    // 拍手：两手快速靠近（GESTURE_SWITCH.clap 关掉时传 null，直接跳过）
    const s = GESTURE_SWITCH.clap ? this._computeSpread(hands) : null;
    if (s !== null) {
      // 拍手是「张开的手掌相击」。两手都在做圈形（比心姿态）靠近时不算拍手，
      // 否则比心会被爆雪打断，还会顺手压制 300ms 的心形判定。
      if (s > 0.30) {
        this.farDist = s;
        this.farAt = now;
      }
      if (!bothRinged && !bowLive && s < 0.16 && this.farDist !== null && this.farDist > 0.26 && now - this.farAt < 700) {
        if (now - this.lastClapAt > 500) {
          this.lastClapAt = now;
          this.onEvent('clap', { strength: 1.0 });
        }
        this.farDist = null;
      }
    } else {
      this.farDist = null;
    }
  }

  _computeTray(hands, now) {
    if (!GESTURE_SWITCH.tray) {
      if (this.trayActive) {
        this.trayActive = false;
        this.onEvent('trayOff', {});
      }
      return null;
    }
    if (hands.length !== 1) {
      if (this.trayActive) {
        this.trayActive = false;
        this.onEvent('trayOff', {});
      }
      return null;
    }
    const h = hands[0];
    const inFrame = h.palmMirrored.y > 0.25 && h.palmMirrored.y < 0.96;
    const pose = h.openness >= 0.75 && h.palmUp && inFrame;

    if (pose) {
      if (!this.trayActive) {
        if (!this.traySince) this.traySince = now;
        if (now - this.traySince > 260) {
          this.trayActive = true;
          this.onEvent('trayOn', { hand: h });
        }
      }
    } else {
      this.traySince = 0;
      if (this.trayActive) {
        this.trayActive = false;
        this.onEvent('trayOff', {});
      }
    }

    if (!this.trayActive) return null;
    return {
      x: h.palmMirrored.x,
      y: h.palmMirrored.y,
      strength: h.openness,
    };
  }

  /**
   * 双手比心：两只手各自把拇指尖和食指尖合上，并排举在身前组成心形。
   *
   * 为什么不用单手比心：单手「拇指+食指交叉」在 640×480 下两个指尖常常并成一团，
   * 关键点分辨率只剩几个像素，而且和「捏合」是同一个几何构型，误触率很高。
   * 双手比心多了一组约束（两手各自闭合 + 并排 + 等高 + 间距），稳定得多。
   *
   * 和「双手开合缩放」怎么区分 —— 两者都是两手捏着靠近，几何上几乎同构，
   * 所以只用「保持不动」这一条物理上不同的信号来分：
   *   缩放 = 指尖间距持续变化（rate 大）；比心 = 定住不动（rate→0）。
   * 配合 260ms 保持 + 220ms 滞回，比心稳稳点亮，而拉拽时不会误闪。
   */
  _computeHeart(hands, now) {
    const h = this.heart;
    if (!GESTURE_SWITCH.heart) {
      // 关掉时把状态清干净，避免残留 strength 让心形一直半亮
      this.heartGap = null;
      this.heartGapRate = 0;
      this.heartHoldSince = 0;
      this.heartOn = false;
      h.strength = 0;
      h.active = false;
      return h;
    }
    const dt = this.heartLastAt ? Math.min(0.2, Math.max(0.008, (now - this.heartLastAt) / 1000)) : 0.016;
    this.heartLastAt = now;
    const probe = this.probe;

    let cx = h.x;
    let cy = h.y;
    let radius = h.radius;
    let score = 0;
    let stage = hands.length === 2 ? 'ok' : 'hands';

    if (hands.length === 2) {
      const [a, b] = hands;
      const sizeAvg = Math.max(0.02, (a.size + b.size) / 2);
      const gap = Math.hypot(a.tipMid.x - b.tipMid.x, a.tipMid.y - b.tipMid.y) / sizeAvg;
      const level = Math.abs(a.tipMid.y - b.tipMid.y) / sizeAvg;

      // 两级平滑：先低通吃掉 MediaPipe 的逐帧抖动，再算速度。
      // 否则摄像头噪声本身就会被当成「手在动」，比心永远点不亮。
      const gs = this.heartGap === null
        ? gap
        : this.heartGap + (gap - this.heartGap) * HEART_CFG.gapSmooth;
      if (this.heartGap === null) {
        this.heartGapRate = 0;
      } else {
        const inst = Math.abs(gs - this.heartGap) / Math.max(dt, 0.008);
        this.heartGapRate += (inst - this.heartGapRate) * HEART_CFG.rateSmooth;
      }
      this.heartGap = gs;

      const ringScore = Math.min(a.ring, b.ring);
      const gapScore = smooth((gap - HEART_CFG.gapNear) / (HEART_CFG.gapNearFull - HEART_CFG.gapNear))
        * (1 - smooth((gap - HEART_CFG.gapFarFull) / (HEART_CFG.gapFarZero - HEART_CFG.gapFarFull)));
      const levelScore = 1 - smooth((level - HEART_CFG.levelFull)
        / (HEART_CFG.levelZero - HEART_CFG.levelFull));
      const rateScore = 1 - smooth((this.heartGapRate - HEART_CFG.rateFull)
        / (HEART_CFG.rateZero - HEART_CFG.rateFull));

      // 食指伸出去一点是比心的常态；半握拳略降分，但不硬性否决
      const straight = (a.indexStraight === false ? 0.85 : 1) * (b.indexStraight === false ? 0.85 : 1);

      score = ringScore * gapScore * levelScore * rateScore * straight;

      const ma = a.tipMidMirrored;
      const mb = b.tipMidMirrored;
      cx = (ma.x + mb.x) * 0.5;
      cy = (ma.y + mb.y) * 0.5;
      radius = Math.min(0.32, Math.max(0.09, Math.abs(ma.x - mb.x) * 1.05 + 0.07));

      if (now - this.lastClapAt <= HEART_CFG.clapGuard) stage = 'clap';
      else if (ringScore < HEART_CFG.ringGate) stage = 'ring';
      else if (gapScore < 0.4) stage = gap < 0.3 ? 'near' : 'far';
      else if (levelScore < 0.4) stage = 'level';
      else if (rateScore < 0.4) stage = 'move';

      probe.ringA = a.ring;
      probe.ringB = b.ring;
      probe.gap = gap;
      probe.level = level;
      probe.rate = this.heartGapRate;
      probe.score = score;
    } else {
      this.heartGap = null;
      this.heartGapRate = 0;
      probe.ringA = probe.ringB = probe.gap = probe.level = probe.rate = probe.score = 0;
    }

    const cand = hands.length === 2
      && now - this.lastClapAt > HEART_CFG.clapGuard
      && !(this.bow && (this.bow.active || this.bow.pull > 0.12))   // 拉弓时不让心形抢戏
      && score >= HEART_CFG.threshold;

    let pose;
    if (cand) {
      this.heartOffSince = 0;
      if (!this.heartHoldSince) this.heartHoldSince = now;
      pose = now - this.heartHoldSince >= HEART_CFG.holdMs;
      if (!pose) stage = 'hold';
    } else if (this.heartOn) {
      // 松手滞回：手抖一下不会让心形闪掉
      if (!this.heartOffSince) this.heartOffSince = now;
      pose = now - this.heartOffSince < HEART_CFG.releaseMs;
    } else {
      pose = false;
      this.heartHoldSince = 0;
    }

    if (pose && !this.heartOn) this.onEvent('heart', {});
    this.heartOn = pose;
    probe.stage = pose ? 'on' : stage;

    const target = pose ? 1 : 0;
    h.strength += (target - h.strength) * (1 - Math.exp(-dt * (target ? 12 : 4.5)));
    if (h.strength < 0.01) h.strength = 0;
    h.active = h.strength > 0.06;

    const k = 1 - Math.exp(-dt * 12);
    h.x += (cx - h.x) * k;
    h.y += (cy - h.y) * k;
    h.radius += (radius - h.radius) * (1 - Math.exp(-dt * 8));
    return h;
  }

  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }
}
