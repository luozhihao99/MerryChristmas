import * as THREE from 'three';
import { dotTexture } from './textures.js';
import { sampleText } from './particleSampler.js';
import { SoftVeil } from './SoftVeil.js';

/**
 * 「打电话」手势（拇指 + 小指伸出）触发的粒子弹幕。
 *
 * 时间线：粒子从树冠里升起 → 拼成文字 → 原地停留让人读完 → 整团被风吹散。
 *
 * 为什么不是像普通弹幕那样从右边缘飞进来再横穿出去：
 *   横穿的时候字一直在动，眼睛来不及看；而且一行字的左半和右半同时在不同
 *   位置，测光上也没法让树让出一个稳定的暗区。现在改成「成形 → 静止 → 散」，
 *   字在原地停 1.7 秒，够读完；散的时候是逐颗被卷走，和点赞那颗星的收尾一致。
 *
 * 布局分宽屏 / 竖屏两套：竖屏可视宽度只有宽屏的三分之一，字号守不住，
 * 所以手机上把行距压紧、字号收一档，别让字顶出画面。
 */

const Z = 7.0;         // 比树（z≈0）更靠近镜头
const FORM = 0.55;     // 成形耗时
const READ = 1.35;     // 全部行都成形后再留多久给人读
const BLOW = 1.95;     // 被风吹散的耗时

/**
 * height 是**字格**高度（近似字号），实际墨迹高约是它的 0.72 —— 中文方块字尤其如此。
 *
 * 文案用英文、字形用斜体衬线（`sampleText` 的 `script`），和比心收尾那行
 * 「I love you」是同一套字：整棵树的特效因此只有一种「字体语言」，
 * 花体在粒子化之后也还认得出是手写，比无衬线的方块字耐看。
 *
 * 中文原句「想我就给我打电话」在花体里没有对应的英文连写字体，
 * 硬塞八个汉字又只能缩到一条扁线，所以改成「Miss me? / Call me」两行。
 */
const WIDE_ROWS = [
  { text: '666', height: 1.24, y: 6.92, delay: 0.00, size: 1.00, weight: 0.22, gold: true },
  { text: 'Miss me?', height: 1.30, y: 5.66, delay: 0.40, size: 1.00, weight: 0.32, gold: false },
  { text: 'Call me', height: 1.30, y: 4.26, delay: 0.72, size: 1.00, weight: 0.46, gold: false },
];

/**
 * 竖屏只有 3 条：可视宽度太窄，4 行会挤成一片。
 * 两行英文用同一个 height（= 同样的字号），行距比宽屏更紧一点。
 */
const NARROW_ROWS = [
  { text: '666', height: 1.00, y: 6.72, delay: 0.00, size: 1.00, weight: 0.24, gold: true },
  { text: 'Miss me?', height: 0.94, y: 5.58, delay: 0.32, size: 1.00, weight: 0.30, gold: false },
  { text: 'Call me', height: 0.94, y: 4.28, delay: 0.64, size: 1.00, weight: 0.46, gold: false },
];


const vert = /* glsl */`
uniform float uTime;
uniform float uStart;
uniform float uScale;
uniform float uSize;
uniform float uPixelRatio;
uniform float uIntensity;
uniform float uSpan;
uniform float uBlowAt;
uniform float uX0;
uniform float uY;

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

  // 成形：每颗粒子有各自的延迟，整团才像散开而不是整体平移
  float form = clamp((e - aDelay) / 0.55, 0.0, 1.0);
  form = form * form * (3.0 - 2.0 * form);

  vec3 home = vec3(position.xy * uScale, 0.0) + vec3(uX0, uY, ${Z.toFixed(1)});
  // 起点集中在树冠里（本行正下方），升上来时带一点随机横向散开。
  // 散开幅度不能大：竖屏只有 3.5 个世界单位宽，散太开会从上一行里穿过去。
  vec3 origin = vec3(uX0 + (aSeed - 0.5) * 1.5, uY - 1.1 - aSeed * 0.5, ${(Z - 1.4).toFixed(1)});

  vec3 p = mix(origin, home, form);

  // 成形时的上抛弧线，直线飞会显得很机械；幅度要小，
  // 否则相邻两行会互相穿插（竖屏行距只有 1 个世界单位）
  float arc = sin(3.14159265 * form);
  p.y += arc * (0.34 + aSeed * 0.55);
  p.x += arc * (aSeed - 0.5) * 0.95;
  p.z += arc * (0.30 + aSeed * 0.40);

  // 停下时的轻微呼吸：完全静止会像贴纸，动一点点才「活」
  p.y += sin(uTime * 1.9 + aSeed * 23.0) * 0.06;

  // 被风吹散：整组用同一个起风时刻（uBlowAt），
  // 不能各算各的 e —— 每行延迟不同，各算各的会出现「第一行已经散了、
  // 最后一行还在成」的接力，整句永远凑不齐。
  // 每颗再错开一点点，风才像从一边扫过去，而不是整块一起消失。
  float trav = clamp((uTime - uBlowAt - aSeed * 0.22) / ${BLOW.toFixed(2)}, 0.0, 1.0);
  float b = trav * trav;                       // 先慢后快，像被一阵风突然卷走
  vec2 dirv = normalize(position.xy + vec2(0.0001, 0.02));
  p.xy += dirv * b * (0.45 + aSeed * 1.00);
  p.x += uSpan * b * (0.26 + aSeed * 0.40);    // 整体风向：往右上
  p.y += b * (0.80 + aSeed * 1.35);
  p.z += b * (0.20 + aSeed * 1.10);
  // 湍流：没有它，散开就是一朵规整的伞形
  p.x += sin(uTime * 1.80 + aSeed * 41.0) * b * 0.75;
  p.y += sin(uTime * 1.35 + aSeed * 29.0) * b * 0.55;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float tw = 0.68 + 0.32 * sin(uTime * 3.0 + aSeed * 6.2831);
  gl_PointSize = aSize * uSize * uPixelRatio / max(-mv.z, 0.1);

  float fadeIn = smoothstep(0.0, 0.30, form);
  float fadeOut = 1.0 - smoothstep(0.26, 1.0, trav);
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

// 弹幕压在树上，必须和树的暖黄/绿拉开色相，否则加法混合后糊成一片。
// 666 用香槟金（呼应星星），英文句用粉 —— 和「I love you」同一个色系，
// 粉在满屏暖黄里最跳。
const GOLD = [0xffd79a, 0xffeccb, 0xfff3d8];
const WARM = [0xff9ecb, 0xffd6e8, 0xffb8d6];

export class CallDanmaku {
  constructor(scene, { count = 2600 } = {}) {
    this.now = -1;
    this.active = false;
    this.endAt = 0;
    // 弹幕在场时让树让一点亮度：字压在树最亮的那一段上，不压暗就糊在一起
    this.dim = 0;

    this.wide = this._build(scene, WIDE_ROWS, count);
    this.narrow = this._build(scene, NARROW_ROWS, Math.round(count * 0.8));
    this.set = this.wide;
    for (const r of this.narrow) r.points.visible = false;

    // 文字背后垫一层软暗角：四行字压在那儿，靠调亮/压暗全局都救不回来，
    // 缺的是局部对比度（见 SoftVeil 的注释）
    this.veilWide = new SoftVeil(scene, { width: 6.3, height: 3.4, y: 5.55, z: Z - 0.25, max: 0.52 });
    this.veilNarrow = new SoftVeil(scene, { width: 3.5, height: 2.9, y: 5.46, z: Z - 0.25, max: 0.52 });
    this.veil = this.veilWide;
  }

  _build(scene, cfgs, count) {
    const rows = [];
    const c = new THREE.Color();

    for (const cfg of cfgs) {
      const n = Math.max(120, Math.round(count * cfg.weight));
      const { pts, width } = sampleText(cfg.text, n, cfg.height, { script: true });

      const pos = new Float32Array(n * 3);
      const size = new Float32Array(n);
      const seed = new Float32Array(n);
      const delay = new Float32Array(n);
      const col = new Float32Array(n * 3);
      const palette = cfg.gold ? GOLD : WARM;
      const gain = cfg.gold ? 1.7 : 1.9;

      for (let i = 0; i < n; i++) {
        pos[i * 3] = pts[i][0];
        pos[i * 3 + 1] = pts[i][1];
        pos[i * 3 + 2] = 0;

        size[i] = 0.72 + Math.random() * 0.62;
        seed[i] = Math.random();
        delay[i] = Math.random() * 0.30;

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
          uSize: { value: 28 * cfg.size },
          uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.85) },
          uIntensity: { value: 0.95 },
          uSpan: { value: 8 },
          uBlowAt: { value: 1e9 },
          uX0: { value: 0 },
          uY: { value: cfg.y },
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

  /** 当前布局的行（窄屏/宽屏两套） */
  get rows() {
    return this.set;
  }

  /** 现在能不能再触发（一轮弹幕快要播完时才允许叠下一轮） */
  get busy() {
    return this.active && this.now < this.endAt - 1.0;
  }

  trigger(t) {
    this.active = true;
    // 起风时刻 = 末行也成形之后，再留 READ 秒；
    // 之前每行各算各的 e，第一行散的时候最后一行还在爬，整句永远凑不齐
    let last = 0;
    for (const r of this.set) last = Math.max(last, r.delay);
    const blowAt = t + last + FORM + READ;
    this.blowAt = blowAt;
    this.endAt = blowAt + BLOW;
    // 两套布局都排好时间，横竖屏切换时正在播的那一轮能无缝接上
    for (const set of [this.wide, this.narrow]) {
      for (const r of set) {
        r.mat.uniforms.uStart.value = t + r.delay;
        r.mat.uniforms.uBlowAt.value = blowAt;
        r.mat.uniforms.uTime.value = t;
      }
    }
    for (const r of this.set) r.points.visible = true;
  }

  update(dt, t, camera) {
    this.now = t;
    // 让位强度：active 变 false 后也继续平滑回落，收尾不会亮度突跳
    this.dim += ((this.active ? 1 : 0) - this.dim) * (1 - Math.exp(-dt * 6));

    // 竖屏换一套更短的文案，否则整句会被压成一条扁线
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

    // 暗角跟着出场淡入；文字开始散的时候同步退掉，
    // 否则字已经飘没了、底下一块方形的暗斑还杵在那儿
    const k = this.blowAt ? Math.min(1, Math.max(0, (t - this.blowAt) / BLOW)) : 0;
    const fade = 1 - Math.min(1, Math.max(0, (k - 0.35) / 0.65));
    this.veil.setOpacity(this.dim * 0.94 * fade);

    if (!this.active) return;

    // 可视范围：弹幕放在 z=Z 平面，宽度按相机实时算
    let halfW = 8;
    if (camera) {
      const dist = Math.max(1, Math.abs(camera.position.z - Z));
      const halfH = Math.tan((camera.fov * Math.PI) / 360) * dist;
      halfW = halfH * Math.max(0.35, camera.aspect);
    }

    for (const r of this.set) {
      const u = r.mat.uniforms;
      // 整行宽于画面时等比收窄（竖屏手机上那几句会收）。
      // 留的边距不是「排版留白」而是给粒子让位：字的最右一颗点直径加泛光
      // 还有好几个像素，0.94 的话竖屏看上去就是被切掉一截。
      const margin = camera && camera.aspect < 0.95 ? 0.84 : 0.90;
      u.uScale.value = Math.min(1, (halfW * 2 * margin) / Math.max(0.001, r.width));
      u.uSpan.value = halfW * 1.10 + r.width * 0.30;
      u.uX0.value = 0;
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
