import * as THREE from 'three';
import { dotTexture } from './textures.js';
import { sampleText, sampleShape } from './particleSampler.js';
import { SoftVeil } from './SoftVeil.js';

/**
 * 「点赞」手势（拇指竖起、其余四指收回）触发的粒子图案：
 * 一颗粒子勾出的五角星（中间一点亮芯），头顶一串「666」——
 * 666 用斜体衬线的花体，和比心收尾的「I love you」、打电话弹幕同一套字，
 * 成形后星会慢慢自转，停一会儿再一起被风吹散。
 *
 * 为什么是一个描边的星、而不是实心剪影：
 * 粒子是加法混合，实心块里几百颗点叠在一起只会过曝成一块白斑，
 * 形状本身反而看不出来（先前的实心大拇指就是这样，怎么调亮度都糊）。
 * 描边只在下笔的那一条线上有点，密度集中、边界清楚，一眼就能认出是星。
 */

const Z = 7.0;         // 比树（z≈0）更靠近镜头
const FORM = 0.66;     // 成形耗时（秒）
const HOLD = 1.70;     // 成形后原地停留，星星慢慢转
const BLOW = 2.10;     // 被风吹散的耗时
const SPIN = 0.50;     // 停留期自转角速度（弧度/秒），转半分钟也不会转晕

/**
 * 布局：宽屏一套、竖屏一套。
 * 两套都排好时间，横竖屏切换时正在播的那一轮能无缝接上（和弹幕同款做法）。
 */
const WIDE = [
  { kind: 'star', height: 2.24, y: 4.82, weight: 0.70, delay: 0.00, size: 0.96 },
  { kind: 'text', text: '666', height: 1.32, y: 6.56, weight: 0.30, delay: 0.16, size: 0.95 },
];

const NARROW = [
  { kind: 'star', height: 1.74, y: 4.60, weight: 0.68, delay: 0.00, size: 0.90 },
  { kind: 'text', text: '666', height: 1.02, y: 5.98, weight: 0.32, delay: 0.14, size: 0.88 },
];

const vert = /* glsl */`
uniform float uTime;
uniform float uStart;
uniform float uScale;
uniform float uSize;
uniform float uPixelRatio;
uniform float uIntensity;
uniform float uSpan;
uniform float uSpin;
uniform vec2  uCenter;

attribute float aSize;
attribute float aSeed;
attribute float aDelay;
attribute vec3  aColor;

varying float vAlpha;
varying vec3  vColor;

void main(){
  float e = uTime - uStart;
  if (e < 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // 还没轮到它，推出裁剪空间
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    vColor = vec3(0.0);
    return;
  }

  // 成形：每颗粒子各有延迟，整团才像「聚起来」而不是整体平移
  float form = clamp((e - aDelay) / ${FORM.toFixed(2)}, 0.0, 1.0);
  form = form * form * (3.0 - 2.0 * form);

  // 自转：等画完一圈轮廓再开始转，否则成形时像被搅散的漩涡
  float ang = uSpin * max(e - ${(FORM + 0.20).toFixed(2)}, 0.0);
  float ca = cos(ang);
  float sa = sin(ang);
  vec2 lp = mat2(ca, -sa, sa, ca) * position.xy;

  vec3 home = vec3(lp * uScale, 0.0) + vec3(uCenter, ${Z.toFixed(1)});
  // 起点在图案下方（树冠里），带一点随机横向散开
  vec3 origin = vec3(uCenter.x + (aSeed - 0.5) * 2.4, uCenter.y - 1.7 - aSeed * 0.8, ${(Z - 2.0).toFixed(1)});

  vec3 p = mix(origin, home, form);

  // 上升弧线：纯直线飞过去很机械
  float arc = sin(3.14159265 * form);
  p.y += arc * (0.38 + aSeed * 0.55);
  p.x += arc * (aSeed - 0.5) * 0.50;
  p.z += arc * (0.25 + aSeed * 0.30);

  // 被风吹散：先向外松开（保留「原本是一颗星」的记忆），再整体被风带走
  float trav = clamp((e - ${FORM.toFixed(2)} - ${HOLD.toFixed(2)}) / ${BLOW.toFixed(2)}, 0.0, 1.0);
  float b = trav * trav;                       // 先慢后快，像被一阵风突然卷走
  vec2 dirv = normalize(lp + vec2(0.0001, 0.02));
  p.xy += dirv * b * (0.60 + aSeed * 1.25);
  p.x += uSpan * b * (0.30 + aSeed * 0.45);    // 整体风向：往右上
  p.y += b * (0.85 + aSeed * 1.45);
  p.z += b * (0.25 + aSeed * 1.20);
  // 湍流：没有它，散开就是一朵规整的伞形
  p.x += sin(uTime * 1.80 + aSeed * 41.0) * b * 0.80;
  p.y += sin(uTime * 1.35 + aSeed * 29.0) * b * 0.60;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float tw = 0.72 + 0.28 * sin(uTime * 3.0 + aSeed * 6.2831);
  gl_PointSize = aSize * uSize * uPixelRatio / max(-mv.z, 0.1);

  float fadeIn = smoothstep(0.0, 0.32, form);
  float fadeOut = 1.0 - smoothstep(0.28, 1.0, trav);
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

/**
 * 五角星。坐标系：100 单位见方，y 轴向下，圆心 (50, 52)。
 *
 * 只用「描边」不用「填充」：填充的星在加法混合下会糊成一块白斑，
 * 描边的墨迹集中在一条线上，粒子化之后反而更亮更像星。
 * 中间加一个实心小圆当亮芯，避免空心星看起来像没画完。
 */
function drawStar(ctx, U) {
  const cx = 50;
  const cy = 52;
  const R = 45;
  const r = 19.5;
  const rot = -Math.PI / 2;        // 一只尖朝上

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 8.0 * U;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 ? r : R;
    const ang = rot + (i * Math.PI) / 5;
    const x = (cx + Math.cos(ang) * rad) * U;
    const y = (cy + Math.sin(ang) * rad) * U;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx * U, cy * U, 7.2 * U, 0, Math.PI * 2);
  ctx.fill();
}

// 666 用香槟金（和弹幕、树上的星星呼应）；星用冷白，
// 冷白在满屏暖黄里最跳，一眼能看出是「叠在上面的一层」。
const GOLD = [0xffd79a, 0xffeccb, 0xfff3d8];
const COOL = [0xe6f3ff, 0xffffff, 0xcfe8ff];

export class LikeBurst {
  constructor(scene, { count = 2400 } = {}) {
    this.now = -1;
    this.active = false;
    this.endAt = 0;
    this.dim = 0;

    this.wide = this._build(scene, WIDE, count);
    this.narrow = this._build(scene, NARROW, Math.round(count * 0.85));
    this.set = this.wide;
    for (const r of this.narrow) r.points.visible = false;

    // 星和 666 都是「浮在树上的一层」，背后垫一块软暗角才立得住
    this.veilWide = new SoftVeil(scene, { width: 2.6, height: 3.3, y: 5.36, z: Z - 0.25, max: 0.42 });
    this.veilNarrow = new SoftVeil(scene, { width: 1.95, height: 2.7, y: 5.06, z: Z - 0.25, max: 0.42 });
    this.veil = this.veilWide;
  }

  _build(scene, cfgs, count) {
    const rows = [];
    const c = new THREE.Color();

    for (const cfg of cfgs) {
      const n = Math.max(160, Math.round(count * cfg.weight));
      const { pts, width } = cfg.kind === 'star'
        ? sampleShape(drawStar, n, cfg.height, { width: 100, height: 100 })
        : sampleText(cfg.text, n, cfg.height, { script: true });

      const pos = new Float32Array(n * 3);
      const size = new Float32Array(n);
      const seed = new Float32Array(n);
      const delay = new Float32Array(n);
      const col = new Float32Array(n * 3);
      const palette = cfg.kind === 'star' ? COOL : GOLD;
      // 描边本身墨迹少，单点可以给亮一些，不会像实心块那样叠成白斑
      const gain = cfg.kind === 'star' ? 2.1 : 1.9;

      for (let i = 0; i < n; i++) {
        pos[i * 3] = pts[i][0];
        pos[i * 3 + 1] = pts[i][1];
        pos[i * 3 + 2] = 0;

        size[i] = 0.70 + Math.random() * 0.60;
        seed[i] = Math.random();
        delay[i] = Math.random() * 0.26;

        c.setHex(palette[(Math.random() * palette.length) | 0]).multiplyScalar(gain + Math.random() * 0.8);
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      geo.setAttribute('aDelay', new THREE.BufferAttribute(delay, 1));
      geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uStart: { value: 1e9 },
          uScale: { value: 1 },
          uSize: { value: 25 * cfg.size },
          uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.85) },
          uIntensity: { value: cfg.kind === 'star' ? 1.0 : 0.96 },
          uSpan: { value: 6 },
          uSpin: { value: cfg.kind === 'star' ? SPIN : 0 },
          uCenter: { value: new THREE.Vector2(0, cfg.y) },
          uMap: { value: dotTexture() },
        },
        vertexShader: vert,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });

      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      points.renderOrder = 8;
      points.visible = false;
      scene.add(points);

      rows.push({ cfg, points, mat, width, delay: cfg.delay });
    }
    return rows;
  }

  get busy() {
    return this.active && this.now < this.endAt - 0.6;
  }

  trigger(t) {
    this.active = true;
    // 每行有自己的延迟，末行最晚开始，总时长要把它算进去
    let last = 0;
    for (const r of this.set) last = Math.max(last, r.delay);
    this.endAt = t + last + FORM + HOLD + BLOW;
    for (const set of [this.wide, this.narrow]) {
      for (const r of set) {
        r.mat.uniforms.uStart.value = t + r.delay;
        r.mat.uniforms.uTime.value = t;
      }
    }
    for (const r of this.set) r.points.visible = true;
  }

  update(dt, t, camera) {
    this.now = t;
    this.dim += ((this.active ? 1 : 0) - this.dim) * (1 - Math.exp(-dt * 6));

    const next = camera && camera.aspect < 0.95 ? this.narrow : this.wide;
    if (next !== this.set) {
      for (const r of this.set) r.points.visible = false;
      this.set = next;
      // 两块暗角都要先清零：切换时旧的那块不会自动隐身，
      // 不清理会出现「竖屏了还压着一块按横屏尺寸算的暗斑」
      this.veilWide.setOpacity(0);
      this.veilNarrow.setOpacity(0);
      this.veil = next === this.wide ? this.veilWide : this.veilNarrow;
      if (this.active) for (const r of next) r.points.visible = true;
    }

    // 暗角随星一起退场：星散没了还留一块暗斑会很突兀
    const k = this.active ? Math.min(1, Math.max(0, (t - (this.endAt - BLOW)) / BLOW)) : 1;
    this.veil.setOpacity(this.dim * 0.94 * (1 - Math.min(1, Math.max(0, (k - 0.35) / 0.65))));

    if (!this.active) return;

    // 可视宽度按相机实时算：竖屏要收窄，否则星会被切掉
    let halfW = 8;
    if (camera) {
      const dist = Math.max(1, Math.abs(camera.position.z - Z));
      const halfH = Math.tan((camera.fov * Math.PI) / 360) * dist;
      halfW = halfH * Math.max(0.35, camera.aspect);
    }

    for (const r of this.set) {
      const u = r.mat.uniforms;
      // 边距同样给粒子的直径和泛光让位（竖屏更紧，收得更多）
      const margin = camera && camera.aspect < 0.95 ? 0.80 : 0.86;
      u.uScale.value = Math.min(1, (halfW * 2 * margin) / Math.max(0.001, r.width));
      // 星的轮廓一直在转，宽度按外接圆算，否则转起来会被屏幕边缘切角
      u.uSpan.value = halfW * 1.10 + Math.max(r.width, r.cfg.height) * 0.55;
      u.uTime.value = t;
    }

    if (t > this.endAt) {
      this.active = false;
      for (const r of this.set) r.points.visible = false;
    }
  }

  setPixelRatio(pr) {
    for (const set of [this.wide, this.narrow]) {
      for (const r of set) r.mat.uniforms.uPixelRatio.value = pr;
    }
  }
}
