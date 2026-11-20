import * as THREE from 'three';
import { dotTexture, glowTexture, heartTexture } from './textures.js';

/**
 * 双手比心 → 心形光尘。
 *
 * 视觉上刻意不用「实心爱心贴图」，而是沿着心形曲线铺一圈粒子、内部再撒稀疏光尘：
 * 加法混合 + Bloom 之后边缘会自然发光，内部保留空隙，看起来是「用光画出来的心」，
 * 而不是一张贴在屏幕上的贴纸。
 *
 * 三个层次：
 *   1. heartDust   —— 心形轮廓 + 内部星尘（自定义着色器，带闪烁与心跳呼吸）
 *   2. heartGlow   —— 心后的柔光，负责把 Bloom 撑起来
 *   3. floaters    —— 不断飘起的小爱心，负责「爱意」的氛围
 */

const HEART_Z = 5.6;      // 心形浮在树前，避免和树枝穿插
const DUST = 1600;
const FLOATERS = 16;
const POLY = 160;

const heartVert = /* glsl */`
uniform float uTime;
uniform float uSize;
uniform float uPixelRatio;
uniform float uIntensity;
uniform float uBeat;
uniform float uRise;

attribute float aSize;
attribute float aSeed;
attribute float aPhase;
attribute float aEdge;
attribute vec3 aColor;

varying float vAlpha;
varying vec3 vColor;

void main(){
  vec3 p = position;

  // 轻微呼吸：每颗粒子相位不同，整体看起来像在起伏
  p.xy *= 1.0 + 0.016 * sin(uTime * 2.2 + aSeed * 6.2831);
  // 松手后整片心向上升起再散掉
  p.y += uRise * (0.30 + aSeed * 0.85);
  p.z += sin(uTime * 1.6 + aPhase * 6.2831) * 0.045;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float tw = 0.55 + 0.45 * sin(uTime * 2.8 + aPhase * 6.2831);
  gl_PointSize = aSize * uSize * uPixelRatio * (1.0 + uBeat * 0.16) / max(-mv.z, 0.1);

  vAlpha = uIntensity * tw * mix(0.42, 1.0, aEdge);
  vColor = aColor;
}
`;

const heartFrag = /* glsl */`
uniform sampler2D uMap;
varying float vAlpha;
varying vec3 vColor;

void main(){
  float a = texture2D(uMap, gl_PointCoord).a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}
`;

const floatVert = /* glsl */`
uniform float uTime;
uniform float uSize;
uniform float uPixelRatio;
uniform float uIntensity;

attribute float aSize;
attribute float aSeed;

varying float vAlpha;

void main(){
  float life = fract(uTime * 0.13 + aSeed);

  vec3 p = position;
  p.y += life * 1.55;
  p.x += sin(uTime * 0.85 + aSeed * 21.0) * (0.10 + life * 0.30);
  p.z += cos(uTime * 0.62 + aSeed * 13.0) * 0.12;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  gl_PointSize = aSize * uSize * uPixelRatio * (0.5 + life * 1.1) / max(-mv.z, 0.1);
  vAlpha = uIntensity * sin(life * 3.14159) * 0.95;
}
`;

const floatFrag = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor;
varying float vAlpha;

void main(){
  float a = texture2D(uMap, gl_PointCoord).a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * a * vAlpha, 1.0);
}
`;

/** 参数化心形曲线，归一到 [-1,1] 并上下居中。LoveMessage 复用同一条曲线做散开起点 */
export function heartPoint(t) {
  const x = (16 * Math.pow(Math.sin(t), 3)) / 17;
  const y = (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17;
  return [x, y + 0.34];
}

/**
 * 弧长表：心形曲线在尖角处导数趋零，按 t 均匀采样会让粒子在心尖挤成一团。
 * 按弧长均匀采样，整条轮廓的间距才一致。
 */
function buildArc(n = 512) {
  const pts = [];
  let total = 0;
  let prev = heartPoint(0);
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    const p = heartPoint(t);
    if (i > 0) total += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    pts.push({ t, len: total });
    prev = p;
  }
  return { pts, total };
}

function sampleT(arc, u) {
  const target = u * arc.total;
  let lo = 0;
  let hi = arc.pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arc.pts[mid].len < target) lo = mid + 1;
    else hi = mid;
  }
  return arc.pts[lo].t;
}

function buildPolygon() {
  const poly = [];
  for (let i = 0; i < POLY; i++) poly.push(heartPoint((i / POLY) * Math.PI * 2));
  return poly;
}

function insidePolygon(x, y, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi) hit = !hit;
  }
  return hit;
}

/** 心跳包络：一次「咚—咚」，用来驱动缩放 */
function heartbeat(t) {
  const p = (t * 1.12) % 1;
  const b1 = Math.exp(-Math.pow((p - 0.02) * 11, 2));
  const b2 = 0.62 * Math.exp(-Math.pow((p - 0.2) * 13, 2));
  return b1 + b2;
}

export class HeartEffect {
  constructor(scene, { onEnd = null } = {}) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.renderOrder = 6;
    scene.add(this.group);

    this.onEnd = onEnd;
    this.peak = 0;
    this.lastEndAt = -99;

    this.intensity = 0;
    this.rise = 0;
    this.pos = new THREE.Vector3(0, 6.2, HEART_Z);
    this._v = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._e = new THREE.Vector3();

    this._arc = buildArc();
    this._buildDust();
    this._buildGlow();
    this._buildFloaters();
    this._buildLight();
  }

  _buildDust() {
    const poly = buildPolygon();
    const pos = new Float32Array(DUST * 3);
    const col = new Float32Array(DUST * 3);
    const size = new Float32Array(DUST);
    const seed = new Float32Array(DUST);
    const phase = new Float32Array(DUST);
    const edge = new Float32Array(DUST);

    const rose = new THREE.Color(0xff4f7d).multiplyScalar(2.25);
    const blush = new THREE.Color(0xffd6e0).multiplyScalar(2.55);
    const amber = new THREE.Color(0xffc27a).multiplyScalar(1.7);
    const c = new THREE.Color();

    for (let i = 0; i < DUST; i++) {
      let x;
      let y;
      let isEdge;

      if (i < DUST * 0.52) {
        // 轮廓：沿心形曲线撒，径向加一点抖动，让线变成「光带」
        const t = sampleT(this._arc, Math.random());
        const [hx, hy] = heartPoint(t);
        const jitter = 0.012 + Math.random() * 0.028;
        const n = Math.hypot(hx, hy) || 1;
        x = hx + (hx / n) * (Math.random() - 0.5) * jitter * 2;
        y = hy + (hy / n) * (Math.random() - 0.5) * jitter * 2;
        isEdge = 1;
      } else {
        // 内部：拒绝采样填满心形，靠中心稍微稀疏
        let px = 0;
        let py = 0;
        for (let k = 0; k < 24; k++) {
          px = (Math.random() * 2 - 1) * 0.95;
          py = (Math.random() * 2 - 1) * 0.72;
          if (insidePolygon(px, py, poly)) break;
        }
        x = px;
        y = py;
        isEdge = 0;
      }

      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 0.18;

      if (isEdge) {
        const spark = Math.random() < 0.07;
        c.copy(spark ? blush : (Math.random() < 0.45 ? blush : rose));
        if (spark) c.multiplyScalar(1.32);
        size[i] = (spark ? 1.45 : 0.8) + Math.random() * (spark ? 0.8 : 1.15);
      } else {
        c.copy(Math.random() < 0.28 ? amber : rose).multiplyScalar(0.40 + Math.random() * 0.32);
        size[i] = 0.38 + Math.random() * 0.62;
      }
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;

      seed[i] = Math.random();
      phase[i] = Math.random();
      edge[i] = isEdge;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));

    this.dustMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 28 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.85) },
        uIntensity: { value: 0 },
        uBeat: { value: 0 },
        uRise: { value: 0 },
        uMap: { value: dotTexture() },
      },
      vertexShader: heartVert,
      fragmentShader: heartFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.dust = new THREE.Points(geo, this.dustMat);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  _buildGlow() {
    this.glowMat = new THREE.SpriteMaterial({
      map: glowTexture(),
      color: new THREE.Color(0xff6f97).multiplyScalar(1.05),
      transparent: true,
      depthWrite: false,
      opacity: 0,
      blending: THREE.AdditiveBlending,
    });
    this.glow = new THREE.Sprite(this.glowMat);
    this.glow.scale.setScalar(2.35);
    this.group.add(this.glow);
  }

  _buildFloaters() {
    const pos = new Float32Array(FLOATERS * 3);
    const size = new Float32Array(FLOATERS);
    const seed = new Float32Array(FLOATERS);

    for (let i = 0; i < FLOATERS; i++) {
      pos[i * 3] = (Math.random() * 2 - 1) * 0.88;
      pos[i * 3 + 1] = (Math.random() * 2 - 1) * 0.55;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
      size[i] = 0.7 + Math.random() * 0.7;
      seed[i] = Math.random();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    this.floatMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 104 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.85) },
        uIntensity: { value: 0 },
        uColor: { value: new THREE.Color(0xff9ab8).multiplyScalar(1.55) },
        uMap: { value: heartTexture() },
      },
      vertexShader: floatVert,
      fragmentShader: floatFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.floaters = new THREE.Points(geo, this.floatMat);
    this.floaters.frustumCulled = false;
    this.group.add(this.floaters);
  }

  _buildLight() {
    this.light = new THREE.PointLight(0xff7f9f, 0, 13, 2);
    this.light.position.set(0, 0, 0.4);
    this.group.add(this.light);
  }

  /** 把归一化屏幕坐标投到心形所在平面，得到世界坐标 */
  _project(nx, ny, camera, out) {
    this._v.set(nx * 2 - 1, -(ny * 2 - 1), 0.5).unproject(camera);
    this._dir.copy(this._v).sub(camera.position).normalize();
    const denom = Math.abs(this._dir.z) < 1e-4 ? 1e-4 : this._dir.z;
    const k = (HEART_Z - camera.position.z) / denom;
    return out.copy(camera.position).addScaledVector(this._dir, Math.max(k, 0.5));
  }

  /**
   * @param {number} dt
   * @param {number} t
   * @param {{active:boolean,strength:number,x:number,y:number,radius:number}} heart
   *        归一化坐标（x/y 为 0..1，已镜像），radius 也是归一化单位
   * @param {object} params 复用主参数（beat）
   * @param {THREE.Camera} camera
   */
  update(dt, t, heart, params, camera) {
    const target = heart && heart.active ? Math.min(1, 0.35 + heart.strength * 0.65) : 0;
    this.intensity += (target - this.intensity) * (1 - Math.exp(-dt * (target > this.intensity ? 10 : 4.5)));
    if (this.intensity < 0.004) this.intensity = 0;

    // 「心形亮过、又熄了」→ 把位置与缩放交给文字特效，粒子从这里起飞。
    //
    // 这里不能用心形 strength 的阈值（之前就是这么写的）：比心刚点亮就松手时
    // strength 可能只走到 0.5 上下，用 0.6 去卡会把「短比心」整个漏掉，
    // 表现就是「心亮了，松手什么都没有」。改成跟踪这次亮起来过的峰值强度，
    // 只要真的成型过（>0.5）且现在已经暗下去，就触发一次。
    this.peak = Math.max(this.intensity, this.peak * (1 - dt * 0.35));
    if (this.onEnd && this.peak > 0.5 && this.intensity < 0.3 && t - this.lastEndAt > 1.6) {
      this.lastEndAt = t;
      this.peak = 0;
      this.onEnd(this.pos, this.group.scale.x);
    }

    if (this.intensity <= 0.004) {
      this.group.visible = false;
      this.rise = 0;
      this.light.intensity = 0;
      return;
    }
    this.group.visible = true;

    const hx = heart ? heart.x : 0.5;
    const hy = heart ? heart.y : 0.5;
    const radius = heart ? Math.max(0.05, heart.radius) : 0.12;

    const world = this._project(hx, hy, camera, this._w);
    const edge = this._project(hx + radius, hy, camera, this._e);
    const worldR = Math.max(0.7, Math.abs(edge.x - world.x));

    // 位置平滑，手抖不会让心乱跳
    const k = 1 - Math.exp(-dt * 11);
    this.pos.x += (world.x - this.pos.x) * k;
    this.pos.y += (world.y - this.pos.y) * k;
    this.pos.z += (HEART_Z - this.pos.z) * k;
    this.group.position.copy(this.pos);

    // 松手：心形上浮并散开
    if (heart && heart.active) {
      this.rise *= Math.exp(-dt * 6);
    } else {
      this.rise = Math.min(1.1, this.rise + dt * 0.85);
    }

    const hb = heartbeat(t);
    const appear = 0.68 + 0.32 * Math.min(1, this.intensity * 1.4);
    const scale = worldR * 1.06 * appear * (1 + 0.052 * hb) * (1 + params.beat * 0.05);
    this.group.scale.setScalar(scale);
    this.group.rotation.z = Math.sin(t * 0.55) * 0.032;

    this.dustMat.uniforms.uTime.value = t;
    this.dustMat.uniforms.uIntensity.value = this.intensity * 0.92;
    this.dustMat.uniforms.uBeat.value = params.beat;
    this.dustMat.uniforms.uRise.value = this.rise;

    this.floatMat.uniforms.uTime.value = t;
    this.floatMat.uniforms.uIntensity.value = this.intensity;

    this.glowMat.opacity = this.intensity * (0.17 + 0.07 * hb + params.beat * 0.05);
    this.glow.scale.setScalar(2.1 * (1 + 0.08 * hb + params.beat * 0.06));

    this.light.intensity = this.intensity * (11 + hb * 5) * (1 - this.rise * 0.5);
  }

  setPixelRatio(pr) {
    this.dustMat.uniforms.uPixelRatio.value = pr;
    this.floatMat.uniforms.uPixelRatio.value = pr;
  }
}
