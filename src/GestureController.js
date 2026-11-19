import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const TIP = [8, 12, 16, 20];
const PIP = [6, 10, 14, 18];
const MCP = [5, 9, 13, 17];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

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
    this.vortexAccum = 0;
    this.handStates = {};

    this.state = {
      hands: [],
      handCount: 0,
      spread: null,
      tray: null,
      vortex: 0,
    };
  }

  async init() {
    this.onStatus('正在加载手势模型…');
    const vision = await FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm');

    const options = {
      baseOptions: {
        modelAssetPath: './assets/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    };

    try {
      this.landmarker = await HandLandmarker.createFromOptions(vision, options);
    } catch (err) {
      console.warn('GPU delegate failed, falling back to CPU', err);
      options.baseOptions.delegate = 'CPU';
      this.landmarker = await HandLandmarker.createFromOptions(vision, options);
    }

    if (!navigator.mediaDevices || !window.isSecureContext) {
      throw new Error('摄像头需要 https 或 localhost 环境');
    }

    this.onStatus('正在请求摄像头权限…');
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

    this.ready = true;
    this.onStatus('把手举到镜头前');
    return true;
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

    this._detectEvents(hands, now);

    this.state.hands = hands;
    this.state.handCount = hands.length;
    this.state.spread = this._computeSpread(hands);
    this.state.tray = this._computeTray(hands, now);
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

    let gesture = 'other';
    if (openness >= 0.75 && pinch < 0.45) gesture = 'open';
    else if (openness <= 0.25) gesture = 'fist';
    else if (pinch > 0.75) gesture = 'pinch';

    return {
      label,
      landmarks: lm,
      palm,                              // 归一化 0..1（未镜像，x 已乘 aspect）
      palmMirrored: { x: 1 - palm.x / aspect, y: palm.y },
      size,
      openness,
      pinch,
      palmUp: Math.abs(ny) > 0.55 && fingerHorizontal < 0.55,
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

  _detectEvents(hands, now) {
    // 张手炸裂：握拳后 900ms 内快速张开
    for (const h of hands) {
      const st = this.handStates[h.label] || (this.handStates[h.label] = { fistAt: 0, wasFist: false });
      if (h.gesture === 'fist') {
        if (!st.wasFist) {
          st.wasFist = true;
          st.fistAt = now;
        }
      } else if (st.wasFist && h.openness > 0.75 && now - st.fistAt < 900) {
        st.wasFist = false;
        this.onEvent('burst', { strength: 0.75, hand: h });
      } else if (h.openness > 0.75) {
        st.wasFist = false;
      }
    }

    // 拍手：两手快速靠近
    const s = this._computeSpread(hands);
    if (s !== null) {
      if (s > 0.30) {
        this.farDist = s;
        this.farAt = now;
      }
      if (s < 0.16 && this.farDist !== null && this.farDist > 0.26 && now - this.farAt < 700) {
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

  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
  }
}
