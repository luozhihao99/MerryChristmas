import * as THREE from 'three';
import { dotTexture } from './textures.js';
import { heartPoint } from './HeartEffect.js';

/**
 * 比心结束后的收尾：散开的心形粒子飞向空中，拼成一行「I love you」，
 * 停留几秒后被一阵风从左往右吹散。
 *
 * 为什么用粒子拼字而不是直接贴一张文字图片：
 *   整段动画的主角是「同一批光点」。心形的粒子就是文字的粒子，
 *   位置变化而已 —— 这样从心到字是连续的一口气，不会出现「贴图淡入」的割裂感，
 *   加法混合 + Bloom 之后文字边缘会自己发光，和整棵树是同一种材质语言。
 *
 * 时间线：FLY 飞过去 → HOLD 停留 → BLOW 被风吹散。
 */

const TEXT = 'I love you';
const TEXT_W = 8.8;            // 文字世界宽度（会按画面宽窄再收）
const TEXT_ASPECT = 0.293;     // 画布 高/宽
const TEXT_Z = 5.25;
const TEXT_Y = 6.02;

const FLY = 1.15;
const HOLD = 3.2;
const BLOW = 1.9;

const vert = /* glsl */`
uniform float uTime;
uniform float uFly;        // 0→1 飞行进度
uniform float uDissolve;   // 0→1 风散进度
uniform float uSize;
uniform float uPixelRatio;
uniform float uIntensity;
uniform float uTextScale;
uniform vec3 uFrom;        // 心形此刻的世界位置
uniform vec3 uCenter;      // 文字中心
uniform float uFromScale;  // 心形此刻的世界缩放

attribute vec3 aFrom;
attribute float aSize;
attribute float aSeed;
attribute float aDelay;
attribute vec3 aColor;

varying float vAlpha;
varying vec3 vColor;

float smoother(float x){
  x = clamp(x, 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

void main(){
  // 每颗粒子有各自的起飞延迟，整团才像散开而不是整体平移
  float local = clamp((uFly - aDelay) / max(1.0 - aDelay, 0.001), 0.0, 1.0);
  float e = smoother(local);

  vec3 fromPos = uFrom + aFrom * uFromScale;
  vec3 toPos = uCenter + vec3(position.xy * uTextScale, 0.0);

  vec3 p = mix(fromPos, toPos, e);

  // 飞行弧线：先抬起来再落到字上，直线飞会显得很机械
  float arc = sin(3.14159265 * e);
  p.y += arc * (0.35 + aSeed * 0.95);
  p.x += arc * (aSeed - 0.5) * 1.25;
  p.z += arc * (0.55 + aSeed * 0.55);

  // 落位后极轻微呼吸，字不会死板地钉住
  float settle = smoothstep(0.86, 1.0, e);
  p.xy += settle * 0.015 * vec2(sin(uTime * 1.7 + aSeed * 31.0), cos(uTime * 1.4 + aSeed * 17.0));

  // 风：从左往右扫，越靠右越晚被吹走，形成一道波浪
  float wave = smoothstep(0.0, 1.0, uDissolve * 1.45 - (position.x + 3.7) * 0.058);
  vec3 dir = vec3(0.85 + aSeed * 0.85, 0.34 + aSeed * 0.6, 0.18);
  p += dir * wave * (4.6 + aSeed * 6.4);
  p.y += sin(uTime * 2.4 + aSeed * 20.0) * wave * 0.28;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float tw = 0.62 + 0.38 * sin(uTime * 2.6 + aSeed * 6.2831);
  gl_PointSize = aSize * uSize * uPixelRatio / max(-mv.z, 0.1);

  vAlpha = uIntensity * tw * mix(0.5, 1.0, e) * (1.0 - wave * 0.94);
  vColor = aColor;
}
`;

const frag = /* glsl */`
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;

void main(){
  float a = texture2D(uMap, gl_PointCoord).a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}
`;

/** 把 "I love you" 画进离屏画布，按不透明像素采样成点集（归一化到文字局部坐标） */
function sampleGlyphs(count) {
  const W = 1024;
  const H = Math.round(W * TEXT_ASPECT);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const family = 'Georgia, "Times New Roman", "Songti SC", serif';

  // 斜体衬线：比无衬线更像手写，也更容易在粒子化后还认得出是字
  let size = Math.round(H * 0.72);
  ctx.font = `italic 700 ${size}px ${family}`;
  const fit = (W * 0.92) / ctx.measureText(TEXT).width;
  if (fit < 1) {
    size = Math.floor(size * fit);
    ctx.font = `italic 700 ${size}px ${family}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(TEXT, W / 2, H * 0.52);

  const data = ctx.getImageData(0, 0, W, H).data;
  const hits = [];
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (data[(y * W + x) * 4 + 3] > 130) hits.push([x, y]);
    }
  }

  const hgt = TEXT_W * TEXT_ASPECT;
  const pts = [];
  if (!hits.length) {
    // 极端环境（拿不到 2d 上下文）退化成一团云，至少不崩
    for (let i = 0; i < count; i++) {
      pts.push([(Math.random() - 0.5) * TEXT_W, (Math.random() - 0.5) * hgt]);
    }
    return pts;
  }

  for (let i = 0; i < count; i++) {
    const [x, y] = hits[(Math.random() * hits.length) | 0];
    pts.push([(x / W - 0.5) * TEXT_W, (0.5 - y / H) * hgt]);
  }
  return pts;
}

export class LoveMessage {
  constructor(scene, { count = 2200 } = {}) {
    this.now = 0;
    this.state = 'idle';
    this.elapsed = 0;
    this.from = new THREE.Vector3();
    this.fromScale = 1;
    this.intensity = 0;
    // 场景需要给字幕让位：文字在场时把树压暗一点点，字才跳得出来
    this.dim = 0;

    const bg = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const from = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const seed = new Float32Array(count);
    const delay = new Float32Array(count);
    const col = new Float32Array(count * 3);

    const glyph = sampleGlyphs(count);
    const c = new THREE.Color();
    const rose = new THREE.Color(0xffc6d8).multiplyScalar(3.1);
    const blush = new THREE.Color(0xfff0f6).multiplyScalar(3.7);
    const gold = new THREE.Color(0xffcf94).multiplyScalar(2.4);

    for (let i = 0; i < count; i++) {
      pos[i * 3] = glyph[i][0];
      pos[i * 3 + 1] = glyph[i][1];
      pos[i * 3 + 2] = 0;

      // 起点：沿心形曲线（六成）或心形内部（四成），散开后刚好铺成一团心形云
      const t = Math.random() * Math.PI * 2;
      const [hx, hy] = heartPoint(t);
      const k = i < count * 0.6 ? 1 : Math.sqrt(Math.random()) * 0.92;
      from[i * 3] = hx * k;
      from[i * 3 + 1] = hy * k;
      from[i * 3 + 2] = (Math.random() - 0.5) * 0.22;

      size[i] = 0.55 + Math.random() * 0.75;
      seed[i] = Math.random();
      delay[i] = Math.random() * 0.38;

      const r = Math.random();
      c.copy(r < 0.08 ? gold : r < 0.32 ? blush : rose);
      if (r >= 0.32) c.multiplyScalar(0.82 + Math.random() * 0.36);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }

    bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    bg.setAttribute('aFrom', new THREE.BufferAttribute(from, 3));
    bg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    bg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    bg.setAttribute('aDelay', new THREE.BufferAttribute(delay, 1));
    bg.setAttribute('aColor', new THREE.BufferAttribute(col, 3));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uFly: { value: 0 },
        uDissolve: { value: 0 },
        uSize: { value: 30 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.85) },
        uIntensity: { value: 0 },
        uTextScale: { value: 1 },
        uFrom: { value: new THREE.Vector3() },
        uFromScale: { value: 1 },
        uCenter: { value: new THREE.Vector3(0, TEXT_Y, TEXT_Z) },
        uMap: { value: dotTexture() },
      },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(bg, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
    this.points.visible = false;
    scene.add(this.points);
  }

  /** 心形熄灭时调用：粒子从心形的位置和大小起飞 */
  trigger(fromWorld, fromScale = 1) {
    this.from.copy(fromWorld);
    this.fromScale = Math.max(0.6, fromScale);
    this.state = 'fly';
    this.elapsed = 0;
    this.intensity = 1;
    this.points.visible = true;
    const u = this.material.uniforms;
    u.uFrom.value.copy(this.from);
    u.uFromScale.value = this.fromScale;
    u.uFly.value = 0;
    u.uDissolve.value = 0;
  }

  /** 又一次比心时立刻收掉文字，别和心形抢画面 */
  cancel() {
    if (this.state === 'idle') return;
    this.state = 'blow';
    this.elapsed = FLY + HOLD + BLOW * 0.45;
  }

  get active() {
    return this.state !== 'idle';
  }

  update(dt, t, camera) {
    this.now = t;
    if (this.state === 'idle') {
      this.dim += (0 - this.dim) * (1 - Math.exp(-dt * 6));
      return;
    }
    this.elapsed += dt;

    const e = this.elapsed;
    const u = this.material.uniforms;

    if (e < FLY) {
      this.state = 'fly';
      u.uFly.value = e / FLY;
      u.uDissolve.value = 0;
      this.intensity = 1;
    } else if (e < FLY + HOLD) {
      this.state = 'hold';
      u.uFly.value = 1;
      u.uDissolve.value = 0;
      this.intensity = 1;
    } else if (e < FLY + HOLD + BLOW) {
      this.state = 'blow';
      u.uFly.value = 1;
      u.uDissolve.value = (e - FLY - HOLD) / BLOW;
      this.intensity = 1;   // 逐粒子的淡出由 shader 里的 wave 负责
    } else {
      this.state = 'idle';
      this.points.visible = false;
      this.intensity = 0;
      return;
    }

    // 窄屏（竖屏手机）按真实可视宽度等比收窄，留 14% 边距，别把字顶出画面
    if (camera) {
      const dist = Math.max(1, Math.abs(camera.position.z - TEXT_Z));
      const halfH = Math.tan((camera.fov * Math.PI) / 360) * dist;
      const availW = halfH * 2 * Math.max(0.35, camera.aspect) * 0.86;
      const w = Math.min(TEXT_W, availW);
      u.uTextScale.value = w / TEXT_W;
    }

    u.uTime.value = t;
    // 整行字缓慢起伏，比恒定亮度更像「在呼吸」
    u.uIntensity.value = this.intensity * 0.95 * (0.92 + 0.08 * Math.sin(t * 1.5));

    // 让位强度：风散时随 dissolve 一起退，收尾不会突跳
    const dimTarget = this.state === 'blow' ? 1 - u.uDissolve.value : 1;
    this.dim += (dimTarget - this.dim) * (1 - Math.exp(-dt * 6));
  }

  setPixelRatio(pr) {
    this.material.uniforms.uPixelRatio.value = pr;
  }
}
