import * as THREE from 'three';
import { dotTexture } from './textures.js';

/**
 * 「打电话」手势（拇指 + 小指伸出，贴在耳边）触发的孔明灯。
 *
 * 原来是三行粒子字：666 / Miss me? / Call me。问题不在于字不好看，在于
 * **画面语言重复** —— OK 手势收尾已经是「miss you」金色花体，再来一次文字，
 * 同一个技巧用两遍就不值钱了。而且 666 是弹幕梗，放进雪夜圣诞树里气质不对。
 *
 * 换成「放灯」：语义上正好接得住「打电话 = 想找远方的那个人」，
 * 一盏灯升空比一句 call me 含蓄得多。视觉上也补齐了画面缺的那一块 ——
 * 树上全是冷色（墨绿 / 雪 / 月光），一整片暖橙的灯飘在夜空里，颜色立刻立住。
 *
 * 为什么灯壳只画轮廓、不铺满：
 * 加法混合下把柱面上的点铺满，正面几百颗叠起来就是一块白斑，连灯形都看不出。
 * 这里按「柱面法线朝向相机」逐点判亮度：正对镜头的地方压到 0.12（透一点纸的
 * 光），视线切过灯身的两条边缘提到 1.0。于是每盏灯都是一圈亮线 + 内部一点微光，
 * 一眼认得出是个灯笼，又不会被自身亮成糊。
 */

const COUNT_WIDE = 6;      // 宽屏一次放几盏
const COUNT_NARROW = 4;    // 竖屏：可视宽度只有三分之一，六盏会挤成一串
const LANTERN_H = 1.48;    // 灯身高度（世界单位）—— 小于 1 在 1440×900 上只有 40px 高，
                           // 轮廓点连不成线，看着像一粒橙色噪点
const R0 = 0.48;           // 灯身最大半径

const vert = /* glsl */`
uniform float uTime;
uniform float uSize;
uniform float uPixelRatio;
uniform float uAlpha;
uniform float uPhase;
uniform float uRot;
uniform vec3  uPos;
uniform vec3  uCam;

attribute float aU;      // 沿灯身的高度参数 0..1
attribute float aAng;    // 绕灯身的方位角
attribute float aRole;   // 0 灯壳 / 1 灯芯 / 2 余烬
attribute float aSeed;
attribute float aSize;

varying float vAlpha;
varying vec3  vColor;

void main(){
  vec3 col = mix(vec3(1.00, 0.58, 0.22), vec3(1.00, 0.80, 0.44), aSeed);
  vec3 lp;
  float lum;

  if (aRole < 0.5) {
    // ---- 灯壳 ----
    // 孔明灯的真实剖面：底部开口略小 → 往上鼓到最宽 → 圆顶收到一个小口。
    // 早先写成单条 sqrt(1-u^2.3)，顶部收成 0.2R 的尖，投影上像蒙古包的尖顶；
    // 分成两段之后顶口留 0.34R，才看得出「一个开口的袋子」。
    float t1 = clamp(aU / 0.55, 0.0, 1.0);
    float t2 = clamp((aU - 0.55) / 0.45, 0.0, 1.0);
    float sh = aU < 0.55
      ? mix(0.74, 1.00, sin(1.5708 * t1))
      : mix(1.00, 0.34, t2 * t2 * (3.0 - 2.0 * t2));
    float rad = ${R0.toFixed(2)} * sh * (1.0 + (aSeed - 0.5) * 0.10);
    lp = vec3(cos(aAng) * rad, aU * ${LANTERN_H.toFixed(2)}, sin(aAng) * rad);

    // 视线切过灯身的那两条边缘最亮，正对镜头的纸面只透一点光。
    //
    // 法线必须连同灯自身的 yaw 一起转（aAng + uRot）：灯是绕 Y 轴慢慢自转的，
    // 拿未旋转的角去算，亮线会跟实际轮廓错开一个随机角度 —— 灯就散成一团点，
    // 怎么看都不像个灯笼（这个坑踩过一次）。
    float wa = aAng + uRot;
    vec3 nrm = normalize(vec3(cos(wa), 0.0, sin(wa)));
    vec3 toCam = normalize(uCam - uPos);
    float front = dot(nrm, normalize(vec3(toCam.x, 0.0, toCam.z) + 0.0001));
    float vis = smoothstep(-0.40, 0.35, front);              // 只留朝相机的半边
    float edge = pow(1.0 - clamp(abs(front), 0.0, 1.0), 1.2);
    // 0.30 是正对镜头的纸面透光。给到 0.16 时灯就成了「上下两个亮圈中间空着」的
    // 光罩，看着像水母；纸本身要亮起来，整盏灯才是一个完整的发光体
    lum = max(edge * 1.05, 0.30) * vis;
    // 越靠灯口越亮：火在底下，纸是被从里面烤亮的
    lum *= 0.70 + 0.75 * (1.0 - aU);
  } else if (aRole < 1.5) {
    // ---- 灯芯 ----
    // 亮度要收着。第一版给了 2.8 倍、芯的点又有 8px 大，八十颗叠起来直接过曝成
    // 一块白斑，把好不容易算出来的轮廓整个盖掉了 —— 灯芯只要「一点暖」，不要「一团白」
    float rad = 0.26 * aU;
    lp = vec3(cos(aAng) * rad, 0.075 + (1.0 - aU) * 0.16, sin(aAng) * rad);
    lum = 1.45 * (0.55 + 0.45 * aSeed);
    col = vec3(1.00, 0.84, 0.56);
  } else {
    // ---- 余烬 ----
    // 从灯口撒出去、自己往下落。用 fract 做循环，一颗点可以反复用
    float life = fract(uTime * 0.40 + aU);
    float rad = 0.22 + life * (0.38 + aSeed * 0.55);
    lp = vec3(cos(aAng) * rad, 0.03 - life * (0.75 + aSeed * 1.20), sin(aAng) * rad);
    // 平方衰减：刚离开火最亮，飘远了几乎看不见
    lum = (1.0 - life) * (1.0 - life) * 1.60;
    col = mix(vec3(1.00, 0.70, 0.28), vec3(1.00, 0.50, 0.14), aSeed);
  }

  // 灯自身绕 Y 慢转
  float cr = cos(uRot), sr = sin(uRot);
  vec3 p = vec3(lp.x * cr - lp.z * sr, lp.y, lp.x * sr + lp.z * cr);

  // 热气球式的轻摆：整盏灯一起偏（由 uPhase 统一），
  // 每颗各摆的话灯会散架
  float sw = sin(uTime * 0.85 + uPhase) * 0.052;
  p.x += p.y * sw;
  p.z += p.y * sw * 0.65;

  p += uPos;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  gl_PointSize = aSize * uSize * uPixelRatio / max(-mv.z, 0.1);

  // 灯芯和余烬带一点火光的抖动，整盏灯才不是一块死色
  float flick = 0.90 + 0.10 * sin(uTime * 7.0 + aSeed * 30.0);
  vAlpha = uAlpha * lum * flick;
  vColor = col;
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

const smooth01 = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class WishLantern {
  constructor(scene, { count = 1260 } = {}) {
    this.scene = scene;
    this.now = -1;
    this.active = false;
    this.endAt = 0;
    this.count = count;
    this.spread = 1;          // 竖屏时把灯往中间收

    const perWide = Math.round(count / COUNT_WIDE);
    const perNarrow = Math.round(count / COUNT_NARROW);

    this.wide = this._build(COUNT_WIDE, perWide);
    this.narrow = this._build(COUNT_NARROW, perNarrow);
    this.list = this.wide;
    for (const L of this.narrow) L.points.visible = false;
  }

  _build(n, per) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const points = this._one(per);
      out.push({
        points,
        mat: points.material,
        start: 0,
        x0: 0, y0: 0, z0: 0, speed: 1, phase: 0, drift: 0, rot: 0,
      });
    }
    return out;
  }

  _one(per) {
    const shellN = Math.round(per * 0.58);
    const coreN = Math.round(per * 0.24);
    const emberN = Math.max(24, per - shellN - coreN);
    const n = shellN + coreN + emberN;

    const pos = new Float32Array(n * 3);
    const aU = new Float32Array(n);
    const aAng = new Float32Array(n);
    const aRole = new Float32Array(n);
    const aSeed = new Float32Array(n);
    const aSize = new Float32Array(n);

    let k = 0;
    for (let i = 0; i < shellN; i++, k++) {
      // 高度均匀分布，但底部略密一点 —— 灯口一带是整盏灯最亮的地方
      aU[k] = Math.pow(Math.random(), 0.88);
      aAng[k] = Math.random() * Math.PI * 2;
      aRole[k] = 0;
      aSeed[k] = Math.random();
      aSize[k] = 0.70 + Math.random() * 0.65;
    }
    for (let i = 0; i < coreN; i++, k++) {
      aU[k] = Math.random();
      aAng[k] = Math.random() * Math.PI * 2;
      aRole[k] = 1;
      aSeed[k] = Math.random();
      aSize[k] = 0.50 + Math.random() * 0.60;
    }
    for (let i = 0; i < emberN; i++, k++) {
      aU[k] = Math.random();
      aAng[k] = Math.random() * Math.PI * 2;
      aRole[k] = 2;
      aSeed[k] = Math.random();
      aSize[k] = 0.42 + Math.random() * 0.50;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
    geo.setAttribute('aAng', new THREE.BufferAttribute(aAng, 1));
    geo.setAttribute('aRole', new THREE.BufferAttribute(aRole, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 80 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.85) },
        uAlpha: { value: 0 },
        uPhase: { value: Math.random() * 6.2831 },
        uRot: { value: 0 },
        uPos: { value: new THREE.Vector3() },
        uCam: { value: new THREE.Vector3(0, 5.3, 16.8) },
        uMap: { value: dotTexture() },
      },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      // 必须关掉深度测试：树的针叶是写入深度的实体点云，灯飘到树后面
      // （或树的 z 更大）就整盏被裁掉 —— 第一版就是这样，放完一轮一盏都看不见
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 7;
    points.visible = false;
    this.scene.add(points);
    return points;
  }

  /**
   * 给一套布局排好出发时间与起手位置。
   * 宽屏 6 盏、竖屏 4 盏，两套各自排一次 —— 横竖屏切换时新的一套能直接接上，
   * 不然会看见 4 盏灯同时贴在地面上。
   */
  _layout(set, t) {
    const n = set.length;
    for (let i = 0; i < n; i++) {
      const L = set[i];
      // 环绕树散开，起手半径 4.0~7.0（灯直径一米，太贴近树就会被针叶吃掉）。
      // 角度均分再加一点抖动：全随机会出现两三盏挤在同一侧
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.55;
      const r = 4.0 + Math.random() * 3.0;
      L.x0 = Math.cos(a) * r;
      L.z0 = Math.sin(a) * r * 0.72 + 0.6;
      L.y0 = 0.35 + Math.random() * 1.05;
      L.speed = 1.00 + Math.random() * 0.42;
      L.phase = Math.random() * 6.2831;
      L.drift = (Math.random() - 0.5) * 0.12;
      L.rot = Math.random() * 6.2831;
      // 错开出发：一起升像电梯，错开才像一盏盏陆续放上去
      L.start = t + i * 0.26 + Math.random() * 0.18;
      L.points.visible = true;
      L.mat.uniforms.uAlpha.value = 0;
    }
  }

  /** 一轮没升完不叠下一轮 */
  get busy() {
    return this.active && this.now < this.endAt - 1.2;
  }

  trigger(t) {
    this.active = true;
    this.endAt = t + 10.5;
    this._layout(this.list, t);
  }

  update(dt, t, camera) {
    this.now = t;

    // 竖屏：把灯往中间收。可视宽度只有 ±2.97 个世界单位（414×896 实测），
    // 起手半径 4~7 乘 1.0 的话六盏全在画外；0.40 才能把它们收进树的两侧
    const aspect = camera ? camera.aspect : 1.6;
    const targetSpread = aspect < 0.95 ? 0.40 : 1.0;
    this.spread += (targetSpread - this.spread) * (1 - Math.exp(-dt * 5));

    const next = aspect < 0.95 ? this.narrow : this.wide;
    if (next !== this.list) {
      for (const L of this.list) L.points.visible = false;
      this.list = next;
      // 窄幅画面里同样的世界尺寸占的屏幕比例更大，点要跟着收一档，
      // 否则竖屏上灯会糊成一团（和 SpiralRise 里同一个理由）
      for (const L of next) L.mat.uniforms.uSize.value = aspect < 0.95 ? 70 : 80;
      // 换成另一套布局：从 1 秒前重排，灯已经是升起中的状态，
      // 不会在屏幕边缘突然「刷新」出一排贴地的灯
      if (this.active) this._layout(next, t - 1.0);
    }

    if (!this.active) {
      // 收尾后把所有灯的 alpha 压回 0，下次触发从干净状态开始
      for (const L of this.list) L.mat.uniforms.uAlpha.value = 0;
      return;
    }

    for (const L of this.list) {
      const e = t - L.start;
      if (e < 0) { L.mat.uniforms.uAlpha.value = 0; continue; }

      const y = L.y0 + e * L.speed;
      const x = L.x0 * this.spread + Math.sin(e * 0.33 + L.phase) * 0.72 + e * L.drift;
      const z = L.z0 + Math.cos(e * 0.27 + L.phase) * 0.52;

      const u = L.mat.uniforms;
      u.uTime.value = t;
      u.uPos.value.set(x, y, z);
      u.uRot.value = L.rot + e * 0.22;
      // 淡入 0.55s，升到 8.0 开始化掉，10.8 完全消失
      u.uAlpha.value = smooth01(0, 0.55, e) * (1 - smooth01(8.0, 10.8, y));
      if (camera) u.uCam.value.copy(camera.position);
    }

    if (t > this.endAt) {
      this.active = false;
      for (const L of this.list) L.points.visible = false;
    }
  }

  setPixelRatio(pr) {
    for (const set of [this.wide, this.narrow]) {
      for (const L of set) L.mat.uniforms.uPixelRatio.value = pr;
    }
  }
}
