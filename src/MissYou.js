import * as THREE from 'three';
import { dotTexture } from './textures.js';
import { sampleText, sampleShape } from './particleSampler.js';
import { SoftVeil } from './SoftVeil.js';

/**
 * 「OK」手势（拇指食指成圈、其余三指伸开）触发的一段独幕剧，约 8.5 秒：
 *
 *   0.00  全屏爱心从外圈汇聚成型，粉色，轻轻跳动
 *   0.15  银色流星雨从上方斜落（一直持续到 2.4 秒）
 *   1.25  烟花从屏幕底部一发发升空、炸开（四发，间隔 0.3 秒）
 *   2.55  爱心 / 流星 / 烟花一起被风吹散
 *   3.75  「miss you」用金色花体浮现
 *   5.20  停一会儿
 *   6.15  字也被风吹散
 *
 * 为什么最后才出字：先让满屏的东西散掉，画面空下来，字才看得见。
 * 反过来的话，字永远被爱心和烟花压着。
 *
 * 所有层共用同一套「飘散」公式（向外松 + 整体风向 + 湍流），
 * 这样它们看起来是被同一阵风吹走的，而不是各散各的。
 */

const Z_HEART = 7.0;
const Z_METEOR = 6.6;
const Z_FIRE = 6.8;
const Z_TEXT = 7.2;

/** 时间轴（秒，相对 trigger 时刻） */
const TL = {
  heartForm: 0.75,
  meteorFrom: 0.15,
  meteorTo: 2.40,
  meteorLife: 1.25,
  fireFrom: 0.85,
  fireGap: 0.26,
  fireCount: 5,
  blowAt: 2.55,
  blowDur: 2.30,
  textAt: 3.75,
  textForm: 0.85,
  textHold: 1.45,
  textBlow: 2.05,
};

const TEXT_BLOW_AT = TL.textAt + TL.textForm + TL.textHold;
const TOTAL = TL.textAt + TL.textForm + TL.textHold + TL.textBlow;

const WIDE = {
  heart: { height: 6.6, y: 5.15, size: 1.0 },
  fire: { low: -2.6, spread: 0.62 },
  text: { height: 1.62, y: 5.10, size: 1.0 },
  veil: { width: 12.6, height: 8.6, y: 5.15 },
};

const NARROW = {
  heart: { height: 3.30, y: 5.05, size: 0.88 },
  fire: { low: -2.6, spread: 0.78 },
  text: { height: 0.98, y: 5.05, size: 0.86 },
  veil: { width: 4.9, height: 8.2, y: 5.15 },
};

/* ---------------- 着色器 ---------------- */

// 飘散：先向外松开（保留「原本是个什么形状」的记忆），再被同一阵风带走。
// 四个层都用这一段，风才不会各吹各的。
const BLOW = /* glsl */`
  float trav = clamp(((uTime - uStart) - uBlowAt) / uBlowDur, 0.0, 1.0);
  float b = trav * trav;
  p.xy += dirv * b * (0.75 + aSeed * 1.55);
  p.x += uSpan * b * (0.30 + aSeed * 0.50);
  p.y += b * (0.95 + aSeed * 1.55);
  p.z += b * (0.28 + aSeed * 1.10);
  p.x += sin(uTime * 1.80 + aSeed * 41.0) * b * 0.85;
  p.y += sin(uTime * 1.35 + aSeed * 29.0) * b * 0.55;
`;

const vertHeart = /* glsl */`
uniform float uTime, uStart, uScale, uSize, uPixelRatio, uIntensity;
uniform float uSpan, uBlowAt, uBlowDur;
uniform vec2  uCenter;

attribute float aSize, aSeed, aDelay;
attribute vec3  aColor;

varying float vAlpha;
varying vec3  vColor;

void main(){
  float e = uTime - uStart;
  if (e < 0.0) { gl_Position = vec4(0.0,0.0,2.0,1.0); gl_PointSize = 0.0; vAlpha = 0.0; vColor = vec3(0.0); return; }

  float form = clamp((e - aDelay) / ${TL.heartForm.toFixed(2)}, 0.0, 1.0);
  form = form * form * (3.0 - 2.0 * form);

  // 心跳：成形之后轻轻鼓一下，静止的心看着像贴图
  float beat = 1.0 + 0.038 * sin(max(e - ${TL.heartForm.toFixed(2)}, 0.0) * 5.4);
  vec2 lp = position.xy * beat * uScale;

  vec2 dirv = normalize(position.xy + vec2(0.0001, 0.0001));
  // 起点在同一方向的更外圈：粒子朝心口收，像被吸进去
  vec2 outer = position.xy * uScale * (1.55 + aSeed * 0.90);
  vec3 origin = vec3(uCenter + outer, ${(Z_HEART - 0.5).toFixed(2)});
  vec3 home = vec3(uCenter + lp, ${Z_HEART.toFixed(2)});

  vec3 p = mix(origin, home, form);
  float arc = sin(3.14159265 * form);            // 纯直线会显得很机械
  p.y += arc * (0.30 + aSeed * 0.55);
  p.z += arc * (0.20 + aSeed * 0.30);

${BLOW}

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float tw = 0.78 + 0.22 * sin(uTime * 3.4 + aSeed * 6.2831);
  gl_PointSize = aSize * uSize * uPixelRatio / max(-mv.z, 0.1);

  float fadeIn  = smoothstep(0.0, 0.26, form);
  float fadeOut = 1.0 - smoothstep(0.10, 1.0, trav);
  vAlpha = uIntensity * fadeIn * fadeOut * tw;
  vColor = aColor;
}
`;

const vertMeteor = /* glsl */`
uniform float uTime, uStart, uSize, uPixelRatio, uIntensity;
uniform float uSpan, uBlowAt, uBlowDur, uHalfW, uLife;

attribute float aSize, aSeed, aDelay, aTrail, aStartX, aLen;
attribute vec2  aVel;
attribute vec3  aColor;

varying float vAlpha;
varying vec3  vColor;

void main(){
  float e = uTime - uStart - aDelay;
  if (e < 0.0 || e > uLife) { gl_Position = vec4(0.0,0.0,2.0,1.0); gl_PointSize = 0.0; vAlpha = 0.0; vColor = vec3(0.0); return; }

  float k = clamp(e / uLife, 0.0, 1.0);
  vec2 v = aVel;
  vec2 head = vec2(aStartX * uHalfW, 10.4) + v * e;
  vec2 dir  = normalize(v + vec2(0.0001, 0.0001));
  // 拖尾朝着来路铺开，快结束时拖尾缩短（像烧完了）
  vec2 lp = head - dir * (aTrail * aLen * (1.0 - 0.35 * k));
  // 一点横向抖动，太直会像尺子画出来的
  lp.x += sin(aSeed * 57.0 + e * 3.0) * 0.05;

  vec3 p = vec3(lp, ${Z_METEOR.toFixed(2)});
  vec2 dirv = normalize(mix(dir, vec2(aSeed - 0.5, aSeed - 0.5), 0.55) + vec2(0.0001, 0.0001));

${BLOW}

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float tw = 0.80 + 0.20 * sin(uTime * 6.0 + aSeed * 12.0);
  gl_PointSize = aSize * uSize * uPixelRatio / max(-mv.z, 0.1);

  // 头部亮、尾部暗；出生淡入、寿命末淡出
  float headW = 1.0 - aTrail * 0.55;
  float fade  = smoothstep(0.0, 0.09, k) * (1.0 - smoothstep(0.78, 1.0, k));
  float fadeOut = 1.0 - smoothstep(0.10, 1.0, trav);
  vAlpha = uIntensity * fade * fadeOut * tw * headW;
  vColor = aColor;
}
`;

const vertFire = /* glsl */`
uniform float uTime, uStart, uSize, uPixelRatio, uIntensity;
uniform float uSpan, uBlowAt, uBlowDur, uFireGap, uGravity, uHalfW;

attribute float aSize, aSeed, aShell, aRadius, aHeight, aBaseX;
attribute vec3  aDir;
attribute vec3  aColor;

varying float vAlpha;
varying vec3  vColor;

void main(){
  // BLOW 宏按 e 算飘散，这里必须留着 e（tl 只是「这一发」自己的时间）
  float e = uTime - uStart;
  float tl = e - aShell * uFireGap;
  if (tl < 0.0) { gl_Position = vec4(0.0,0.0,2.0,1.0); gl_PointSize = 0.0; vAlpha = 0.0; vColor = vec3(0.0); return; }

  const float RISE = 0.52;
  vec3 p;
  float riseFade = 1.0;
  float boom = 0.0;

  if (tl < RISE) {
    // 上升段：一小簇挤在弹丸附近，越往上越快（smoothstep 的加速度）
    float q = tl / RISE;
    float yq = q * q * (3.0 - 2.0 * q);
    p = vec3(aBaseX * uHalfW + (aSeed - 0.5) * 0.10, mix(-2.8, aHeight, yq), ${Z_FIRE.toFixed(2)} + (aSeed - 0.5) * 0.18);
    riseFade = 0.55 + 0.45 * q;
  } else {
    boom = tl - RISE;
    // exp 衰减：先猛地炸开，随后几乎停住（空气阻力）
    float rr = (1.0 - exp(-boom * 2.55)) * aRadius;
    p = vec3(aBaseX * uHalfW, aHeight, ${Z_FIRE.toFixed(2)}) + aDir * rr;
    p.y -= uGravity * boom * boom;
    p.x += sin(boom * 1.9 + aSeed * 33.0) * 0.09 * boom;
    p.z += cos(boom * 1.7 + aSeed * 21.0) * 0.07 * boom;
  }

  vec2 dirv = normalize(aDir.xy + vec2(aSeed - 0.5, aSeed - 0.5) + vec2(0.0001, 0.0001));

${BLOW}

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float tw = 0.76 + 0.24 * sin(uTime * 9.0 + aSeed * 40.0);
  gl_PointSize = aSize * uSize * uPixelRatio / max(-mv.z, 0.1);

  // 上升段很亮很短；炸开后 1.6 秒内烧完
  float boomFade = boom <= 0.0 ? 1.0 : (1.0 - smoothstep(0.55, 1.85, boom));
  float fadeOut = 1.0 - smoothstep(0.10, 1.0, trav);
  vAlpha = uIntensity * riseFade * boomFade * fadeOut * tw;
  vColor = aColor;
}
`;

const vertText = /* glsl */`
uniform float uTime, uStart, uScale, uSize, uPixelRatio, uIntensity;
uniform float uSpan, uBlowAt, uBlowDur;
uniform vec2  uCenter;

attribute float aSize, aSeed, aDelay;
attribute vec3  aColor;

varying float vAlpha;
varying vec3  vColor;

void main(){
  float e = uTime - uStart - ${TL.textAt.toFixed(2)};
  if (e < 0.0) { gl_Position = vec4(0.0,0.0,2.0,1.0); gl_PointSize = 0.0; vAlpha = 0.0; vColor = vec3(0.0); return; }

  float form = clamp((e - aDelay) / ${TL.textForm.toFixed(2)}, 0.0, 1.0);
  form = form * form * (3.0 - 2.0 * form);

  vec3 home = vec3(uCenter + position.xy * uScale, ${Z_TEXT.toFixed(2)});
  // 从文字下方一点点浮上来，比「凭空出现」有来处
  vec3 origin = vec3(uCenter.x + (aSeed - 0.5) * 3.0, uCenter.y - 2.1 - aSeed * 0.9, ${(Z_TEXT - 0.6).toFixed(2)});

  vec3 p = mix(origin, home, form);
  float arc = sin(3.14159265 * form);
  p.y += arc * (0.22 + aSeed * 0.36);

  // 主方向偏上：字是横排的，纯按字形径向散开会像被左右拉长，
  // 加一个大一点的向上分量才像「被风卷走」
  vec2 dirv = normalize(position.xy * 0.75 + vec2(aSeed - 0.5, 0.85) + vec2(0.0001, 0.0001));

${BLOW}

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float tw = 0.80 + 0.20 * sin(uTime * 2.8 + aSeed * 6.2831);
  gl_PointSize = aSize * uSize * uPixelRatio / max(-mv.z, 0.1);

  float fadeIn  = smoothstep(0.0, 0.30, form);
  float fadeOut = 1.0 - smoothstep(0.10, 1.0, trav);
  vAlpha = uIntensity * fadeIn * fadeOut * tw;
  vColor = aColor;
}
`;

const frag = /* glsl */`
uniform sampler2D uMap;
varying float vAlpha;
varying vec3  vColor;

void main(){
  float a = texture2D(uMap, gl_PointCoord).a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}
`;

/* ---------------- 图形 ---------------- */

/**
 * 心形：经典参数方程 16sin³t / 13cos t − 5cos2t − 2cos3t − cos4t，
 * 画成 100×100 的坐标系，只描边不填充 —— 加法混合下实心块会糊成一片白，
 * 描边的墨迹集中在一条线上，粒子化之后反而轮廓清楚。
 */
function drawHeart(ctx, U) {
  const N = 200;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 7.0 * U;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    // 参数方程本身是「y 向上」的：峰值出现在 t≈±1（两个圆瓣），谷底在 t=π（心尖）。
    // canvas 的 y 向下，所以这里保持原样、只在算 py 时减 —— 多取一次负号整颗心就倒了。
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    const px = (50 + x * 2.55) * U;
    const py = (46 - y * 2.55) * U;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();

  // 心口一点亮芯。之前这里套过一个小一圈的心，竖屏缩下来像「两个心叠在一起」，
  // 反而看不出是几颗心 —— 只留一个点，安静但镇得住。
  // 44 落在两瓣凹陷（约 33）与心形中心（约 53）之间，正在心口的位置。
  ctx.beginPath();
  ctx.arc(50 * U, 44 * U, 5.5 * U, 0, Math.PI * 2);
  ctx.fill();
}

const HEART = [0xff5f8d, 0xff8fae, 0xffc2d2, 0xffe3ea];
const SILVER = [0xdfeeff, 0xffffff, 0xc2d8f0, 0xeaf4ff];
const FIRE = [0xfff3d8, 0xffdca8, 0xe6f2ff, 0xffc98a];
const GOLD = [0xffd79a, 0xffeccb, 0xfff3d8];

export class MissYou {
  constructor(scene, { count = 10000 } = {}) {
    this.now = -1;
    this.active = false;
    this.endAt = 0;
    this.dim = 0;

    this.layers = {
      wide: this._build(scene, WIDE, count),
      narrow: this._build(scene, NARROW, Math.round(count * 0.78)),
    };
    this.key = 'wide';
    this.set = this.layers.wide;
    for (const l of this.layers.narrow) l.points.visible = false;

    this.veilWide = new SoftVeil(scene, {
      width: WIDE.veil.width, height: WIDE.veil.height, y: WIDE.veil.y, z: Z_TEXT - 0.55, max: 0.34,
    });
    this.veilNarrow = new SoftVeil(scene, {
      width: NARROW.veil.width, height: NARROW.veil.height, y: NARROW.veil.y, z: Z_TEXT - 0.55, max: 0.34,
    });
    this.veil = this.veilWide;
  }

  _build(scene, cfg, count) {
    const layers = [];
    const c = new THREE.Color();

    // ---- 1. 全屏爱心 ----
    const nHeart = Math.round(count * 0.42);
    {
      const { pts, width } = sampleShape(drawHeart, nHeart, cfg.heart.height, { width: 100, height: 100 });
      const pos = new Float32Array(nHeart * 3);
      const size = new Float32Array(nHeart);
      const seed = new Float32Array(nHeart);
      const delay = new Float32Array(nHeart);
      const col = new Float32Array(nHeart * 3);
      for (let i = 0; i < nHeart; i++) {
        pos[i * 3] = pts[i][0];
        pos[i * 3 + 1] = pts[i][1];
        pos[i * 3 + 2] = 0;
        size[i] = 0.62 + Math.random() * 0.55;
        seed[i] = Math.random();
        delay[i] = Math.random() * 0.30;
        // 外圈偏亮粉、内圈偏浅：粒子化之后有一点点体积感
        const r = Math.hypot(pts[i][0], pts[i][1]) / Math.max(0.001, cfg.heart.height * 0.5);
        const hex = HEART[Math.min(HEART.length - 1, Math.round(Math.min(1, r) * 2.2))];
        c.setHex(hex).multiplyScalar(2.95 + Math.random() * 1.30);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      layers.push(this._make(scene, {
        pos, size, seed, delay, col, count: nHeart,
        uniforms: {
          uScale: 1, uSize: 33 * cfg.heart.size, uIntensity: 1.0,
          uCenter: new THREE.Vector2(0, cfg.heart.y),
          uBlowAt: TL.blowAt, uBlowDur: TL.blowDur,
        },
        vertexShader: vertHeart,
        width,
        height: cfg.heart.height,
      }));
    }

    // ---- 2. 银色流星雨 ----
    const meteors = Math.max(34, Math.round(count * 0.0074));
    // 拖尾要「连成线」：aLen 最长 4.6 单位，屏幕上一单位约 80px，
    // 20 个点摆开间距将近 20px，而点径只有 3~4px —— 看起来是一串散点。
    // 取 42 个点，间距压到 8px 左右，才连得起来。
    const perTrail = 44;
    {
      const n = meteors * perTrail;
      const pos = new Float32Array(n * 3);
      const size = new Float32Array(n);
      const seed = new Float32Array(n);
      const delay = new Float32Array(n);
      const trail = new Float32Array(n);
      const startX = new Float32Array(n);
      const len = new Float32Array(n);
      const vel = new Float32Array(n * 2);
      const col = new Float32Array(n * 3);
      for (let m = 0; m < meteors; m++) {
        const d = TL.meteorFrom + Math.random() * (TL.meteorTo - TL.meteorFrom);
        const sx = -1.25 + Math.random() * 2.5;
        // 斜着落：竖直为主，横向 20° 左右，方向统一偏左（和收尾的风向一致）
        const vy = -(6.2 + Math.random() * 2.6);
        const vx = -(1.6 + Math.random() * 1.5);
        // 拖尾要够长才像流星：速度 7 单位/秒，2.8~4.6 单位相当于 0.4~0.65 秒的轨迹
        const L = 2.6 + Math.random() * 1.9;
        for (let k = 0; k < perTrail; k++) {
          const i = m * perTrail + k;
          const t = k / (perTrail - 1);
          pos[i * 3] = 0;
          pos[i * 3 + 1] = 0;
          pos[i * 3 + 2] = 0;
          size[i] = (1.0 - t * 0.55) * (1.05 + Math.random() * 0.55);
          seed[i] = Math.random();
          delay[i] = d;
          trail[i] = t;
          startX[i] = sx * 0.92 + Math.random() * 0.02;
          len[i] = L;
          vel[i * 2] = vx;
          vel[i * 2 + 1] = vy;
          c.setHex(SILVER[(Math.random() * SILVER.length) | 0]).multiplyScalar(3.2 + Math.random() * 1.0);
          col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      geo.setAttribute('aDelay', new THREE.BufferAttribute(delay, 1));
      geo.setAttribute('aTrail', new THREE.BufferAttribute(trail, 1));
      geo.setAttribute('aStartX', new THREE.BufferAttribute(startX, 1));
      geo.setAttribute('aLen', new THREE.BufferAttribute(len, 1));
      geo.setAttribute('aVel', new THREE.BufferAttribute(vel, 2));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      const mat = this._material(vertMeteor, {
        uScale: 1, uSize: 36, uIntensity: 1.1, uSpan: 6,
        uHalfW: 8, uLife: TL.meteorLife,
        uBlowAt: TL.blowAt, uBlowDur: TL.blowDur,
      });
      layers.push(this._points(scene, geo, mat, { width: 0, height: 0 }));
    }

    // ---- 3. 底部升空烟花 ----
    const perShell = Math.round(count * 0.26 / TL.fireCount);
    for (let s = 0; s < TL.fireCount; s++) {
      const baseX = (Math.random() - 0.5) * 2 * cfg.fire.spread;
      const height = 3.5 + Math.random() * 2.7;
      const radius = 1.8 + Math.random() * 1.0;
      const n = perShell;
      const pos = new Float32Array(n * 3);
      const size = new Float32Array(n);
      const seed = new Float32Array(n);
      const shell = new Float32Array(n);
      const rad = new Float32Array(n);
      const hgt = new Float32Array(n);
      const bx = new Float32Array(n);
      const dir = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = 0; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = 0;
        size[i] = 0.85 + Math.random() * 0.75;
        seed[i] = Math.random();
        shell[i] = s;
        rad[i] = radius * (0.62 + Math.random() * 0.42);
        hgt[i] = height;
        bx[i] = baseX;
        // 球面均匀分布（z 均匀取，半径按 sqrt 修正）
        const u = Math.random() * 2 - 1;
        const th = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.max(0, 1 - u * u));
        dir[i * 3] = Math.cos(th) * rr;
        dir[i * 3 + 1] = u;
        dir[i * 3 + 2] = Math.sin(th) * rr;
        c.setHex(FIRE[(Math.random() * FIRE.length) | 0]).multiplyScalar(2.4 + Math.random() * 1.0);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      geo.setAttribute('aShell', new THREE.BufferAttribute(shell, 1));
      geo.setAttribute('aRadius', new THREE.BufferAttribute(rad, 1));
      geo.setAttribute('aHeight', new THREE.BufferAttribute(hgt, 1));
      geo.setAttribute('aBaseX', new THREE.BufferAttribute(bx, 1));
      geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      const mat = this._material(vertFire, {
        uScale: 1, uSize: 32, uIntensity: 1.15, uSpan: 6,
        uFireGap: TL.fireGap, uGravity: 1.45, uHalfW: 7,
        uBlowAt: TL.blowAt, uBlowDur: TL.blowDur,
      });
      layers.push(this._points(scene, geo, mat, { width: 0, height: 0 }));
    }

    // ---- 4. miss you ----
    const nText = Math.round(count * 0.24);
    {
      const { pts, width } = sampleText('miss you', nText, cfg.text.height, { script: true, spacing: 0.02 });
      const pos = new Float32Array(nText * 3);
      const size = new Float32Array(nText);
      const seed = new Float32Array(nText);
      const delay = new Float32Array(nText);
      const col = new Float32Array(nText * 3);
      for (let i = 0; i < nText; i++) {
        pos[i * 3] = pts[i][0];
        pos[i * 3 + 1] = pts[i][1];
        pos[i * 3 + 2] = 0;
        size[i] = 0.72 + Math.random() * 0.6;
        seed[i] = Math.random();
        delay[i] = Math.random() * 0.24;
        c.setHex(GOLD[(Math.random() * GOLD.length) | 0]).multiplyScalar(1.95 + Math.random() * 0.75);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      layers.push(this._make(scene, {
        pos, size, seed, delay, col, count: nText,
        uniforms: {
          uScale: 1, uSize: 28 * cfg.text.size, uIntensity: 0.98,
          uCenter: new THREE.Vector2(0, cfg.text.y),
          uBlowAt: TEXT_BLOW_AT, uBlowDur: TL.textBlow,
        },
        vertexShader: vertText,
        width,
        height: cfg.text.height,
      }));
    }

    return layers;
  }

  _material(vertexShader, uniforms) {
    // 传进来的都是裸值（1 / 0.95 / Vector2），这里统一包成 { value }。
    // three 的 uniforms 必须是对象，直接给数字会在赋值时报
    // 「Cannot create property 'value' on number」。
    const u = {};
    for (const [k, v] of Object.entries(uniforms)) {
      u[k] = v && typeof v === 'object' && 'value' in v ? v : { value: v };
    }
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uStart: { value: 1e9 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.85) },
        uSpan: { value: 6 },
        ...u,
        uMap: { value: dotTexture() },
      },
      vertexShader,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
  }

  _points(scene, geo, mat, info) {
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 9;
    points.visible = false;
    scene.add(points);
    return { points, mat, width: info.width, height: info.height };
  }

  _make(scene, { pos, size, seed, delay, col, uniforms, vertexShader, width, height }) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aDelay', new THREE.BufferAttribute(delay, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    const mat = this._material(vertexShader, uniforms);
    return this._points(scene, geo, mat, { width, height });
  }

  get busy() {
    return this.active && this.now < this.endAt - 0.8;
  }

  trigger(t) {
    this.active = true;
    this.now = t;
    this.endAt = t + TOTAL;
    for (const key of ['wide', 'narrow']) {
      for (const l of this.layers[key]) {
        l.mat.uniforms.uStart.value = t;
        l.mat.uniforms.uTime.value = t;
      }
    }
    for (const l of this.set) l.points.visible = true;
  }

  cancel() {
    this.active = false;
    for (const key of ['wide', 'narrow']) {
      for (const l of this.layers[key]) l.points.visible = false;
    }
    this.veilWide.setOpacity(0);
    this.veilNarrow.setOpacity(0);
  }

  update(dt, t, camera) {
    this.now = t;
    this.dim += ((this.active ? 1 : 0) - this.dim) * (1 - Math.exp(-dt * 5));

    const key = camera && camera.aspect < 0.95 ? 'narrow' : 'wide';
    if (key !== this.key) {
      for (const l of this.set) l.points.visible = false;
      this.key = key;
      this.set = this.layers[key];
      // 两块暗角都先清零，否则会留下一块按旧比例算的暗斑
      this.veilWide.setOpacity(0);
      this.veilNarrow.setOpacity(0);
      this.veil = key === 'wide' ? this.veilWide : this.veilNarrow;
      if (this.active) for (const l of this.set) l.points.visible = true;
    }

    // 暗角只在字出现之后才需要（字细、背后是树，会糊），
    // 爱心和烟花那一段画面本来就满，再压一层只会显脏
    const tSinceStart = this.active ? t - (this.endAt - TOTAL) : 99;
    const clamp01 = (x) => Math.min(1, Math.max(0, x));
    const veilIn = clamp01((tSinceStart - 0.10) / 0.55);
    const veilOut = 1 - clamp01((tSinceStart - (TEXT_BLOW_AT + 0.85)) / (TL.textBlow - 0.85));
    this.veil.setOpacity(veilIn * veilOut * 0.92);

    if (!this.active) return;

    let halfW = 8;
    if (camera) {
      const dist = Math.max(1, Math.abs(camera.position.z - Z_HEART));
      const halfH = Math.tan((camera.fov * Math.PI) / 360) * dist;
      halfW = halfH * Math.max(0.35, camera.aspect);
    }
    const margin = camera && camera.aspect < 0.95 ? 0.82 : 0.88;

    for (const l of this.set) {
      const u = l.mat.uniforms;
      u.uTime.value = t;
      if (l.width > 0) {
        u.uScale.value = Math.min(1, (halfW * 2 * margin) / Math.max(0.001, l.width));
        u.uSpan.value = halfW * 1.05 + Math.max(l.width, l.height) * 0.6;
      } else {
        u.uSpan.value = halfW * 1.15;
        if (u.uHalfW) u.uHalfW.value = Math.max(3.2, halfW);
      }
    }

    if (t > this.endAt) {
      this.active = false;
      for (const l of this.set) l.points.visible = false;
    }
  }

  setPixelRatio(pr) {
    for (const key of ['wide', 'narrow']) {
      for (const l of this.layers[key]) l.mat.uniforms.uPixelRatio.value = pr;
    }
  }
}
