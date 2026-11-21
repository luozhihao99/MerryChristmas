import * as THREE from 'three';

/**
 * 双手拉弓：弓在右下角、红心在左上角，箭沿着那条对角线飞过去。
 *
 * 为什么整组东西挂在 **camera 下面**（而不是世界坐标里）：
 *   用户要的是「右下角有一把弓、左上角有一颗心」—— 这是屏幕位置，不是世界位置。
 *   挂到相机上、放在 z = -3.1 处，就成了一个固定在取景框里的图层：
 *   树怎么转、镜头怎么视差推拉，这两样东西都稳稳待在角上。
 *   代价是它永远在最前面，所以材质全部 depthTest:false + 高 renderOrder，
 *   否则会被树冠的针叶穿过去切一刀。
 *
 * 全部是**粒子**（Points），没有一条实心几何：
 *   - 弓身：220 颗光点沿弓臂分布，中间厚、梢头薄，逐帧在顶点着色器里
 *     用同一个曲线函数算位置 —— 弦要弯、弓梢要后仰，所以不能烘成静态模型；
 *   - 弦：46 颗点连成 V，放箭后跟着一记「嘣」的余振抖；
 *   - 箭：箭杆 / 箭头 / 尾羽 / 拖尾火花都是点，拖尾是「负 x 方向的一撮散点」，
 *     不是一条贴图带子 —— 带子宽一点就成了一根灰棍；
 *   - 心：320 颗点按心形参数方程铺成轮廓 + 内部疏点。命中时**同一批点**
 *     沿各自径向炸开被风带走，不需要另起一套爆炸粒子。
 *
 * 点精灵的尺寸必须用世界尺寸投影（见 _layout 里的 uProj），否则换分辨率、
 * 换像素比就会忽大忽小 —— 这一组的尺寸都是「米」的量级。
 */

const BOW = {
  dist: 3.10,        // 距相机多远（view 空间）
  depth: 0.46,       // 弓腹向外凸出的量（局部单位，半弓长 = 1）
  tipBack: 0.12,     // 拉满时弓梢被带向后的量
  tipCurl: 0.07,     // 弓梢回勾，给一点反曲弓的味道
  pullMax: 0.62,     // 弦中心最多被拉回多少
  arrowLen: 1.16,
  heartWide: 1.12,   // 心的高度（局部单位）
  heartNarrow: 1.12,
};

const N_BOW_CORE = 290;
const N_BOW_INNER = 210;
const N_BOW_HALO = 44;
const N_STRING = 90;
const N_HEART_EDGE = 300;
const N_HEART_FILL = 150;
const N_HEART_GLOW = 70;
const N_BURST = 380;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* ---------------- 着色器 ---------------- */

const sparkFrag = /* glsl */`
varying float vA;
varying vec3  vC;

void main(){
  vec2 q = gl_PointCoord - 0.5;
  float d = length(q);
  if (d > 0.5) discard;
  // 软芯：pow 让中心更实、边缘更快化开，加法混合下不会糊成一片灰
  float a = smoothstep(0.5, 0.0, d);
  a = pow(a, 1.6);
  gl_FragColor = vec4(vC * a * vA, 1.0);
}
`;

const bowVert = /* glsl */`
uniform float uTime;
uniform float uPull;
uniform float uNockX;
uniform float uAlpha;
uniform float uProj;
uniform float uWorld;
uniform float uDepth;
uniform float uTipBack;
uniform float uTipCurl;

attribute float aS;      // 沿弓长 -1..1（弦：-1..1，0 是弦的中点）
attribute float aMode;   // 0 弓身 / 1 弦
attribute float aOff;    // 横向偏移（-1..1）
attribute float aWide;   // 这一颗铺开多宽（光晕比芯宽）
attribute float aSeed;
attribute float aSize;
attribute vec3  aCol;

varying float vA;
varying vec3  vC;

// 弓臂曲线：中间（握把）凸向靶子，两端回到 0；拉得越满，鼓包被压平、弓梢往后仰
vec2 bowPoint(float s){
  float ab = abs(s);
  float bulge = uDepth * (1.0 - s * s) * (1.0 - 0.26 * uPull);
  float back  = uTipBack * uPull * s * s;
  float curl  = uTipCurl * smoothstep(0.66, 1.0, ab);
  return vec2(bulge - back - curl, s);
}

void main(){
  vec2 p;
  float tw;

  if (aMode < 0.5) {
    p = bowPoint(aS);
    // 弓臂切线 → 法线，把粒子铺在「弓的厚度」方向，否则所有点挤成一条线
    vec2 tg = vec2(-2.0 * uDepth * aS * (1.0 - 0.26 * uPull) + 2.0 * uTipBack * uPull * aS, 1.0);
    vec2 nr = normalize(vec2(-tg.y, tg.x));
    float w = mix(0.030, 0.010, pow(abs(aS), 1.5));
    p += nr * aOff * w * aWide;
    tw = 0.55 + 0.45 * sin(uTime * 3.4 + aSeed * 12.0);
  } else {
    // 弦：从中点（弦扣）往上下两个弓梢拉成 V。这里 s 的符号决定上是下
    float k = abs(aS);
    float sy = aS >= 0.0 ? 1.0 : -1.0;
    vec2 tip = bowPoint(1.0);
    p = mix(vec2(uNockX, 0.0), vec2(tip.x, sy), k);
    p.y += aOff * 0.012 * aWide;
    tw = 0.6 + 0.4 * sin(uTime * 5.2 + aSeed * 9.0);
  }

  // 每颗自己的一点微漂：没有这一层就是「一串电灯泡」
  p += vec2(sin(uTime * 2.2 + aSeed * 6.28), cos(uTime * 1.7 + aSeed * 8.1)) * 0.007;

  // 一道沿弓身跑的波：整把弓「活着」
  float wave = 0.74 + 0.26 * sin(uTime * 1.7 - aS * 2.6);

  vec4 mv = modelViewMatrix * vec4(p, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uWorld * uProj / max(-mv.z, 0.1);

  vA = uAlpha * tw * wave;
  vC = aCol;
}
`;

const arrowVert = /* glsl */`
uniform float uTime;
uniform float uProj;
uniform float uWorld;
uniform float uAlpha;
uniform float uTail;     // 尾迹开关：搭在弦上时是 0，飞出去才亮

attribute vec2  aP;      // 箭的局部坐标，x 向前
attribute float aTail;   // 1 = 拖尾火花
attribute float aSeed;
attribute float aSize;
attribute vec3  aCol;

varying float vA;
varying vec3  vC;

void main(){
  vec2 p = aP;
  if (aTail > 0.5) {
    // 尾迹是散点：横向抖开，越远越散（aCol 里已经带了衰减）
    p.y += sin(uTime * 8.0 + aSeed * 21.0) * 0.030 * aSeed;
    p.x += cos(uTime * 6.3 + aSeed * 13.0) * 0.012;
  } else {
    p += vec2(sin(uTime * 7.0 + aSeed * 12.0), cos(uTime * 6.0 + aSeed * 9.0)) * 0.005;
  }

  vec4 mv = modelViewMatrix * vec4(p, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uWorld * uProj / max(-mv.z, 0.1);

  float tw = 0.68 + 0.32 * sin(uTime * 9.0 + aSeed * 15.0);
  vA = uAlpha * tw * (0.55 + 0.45 * aSeed) * (aTail > 0.5 ? uTail : 1.0);
  vC = aCol * (1.0 + 0.5 * (1.0 - aTail) * tw);
}
`;

const heartVert = /* glsl */`
uniform float uTime;
uniform float uProj;
uniform float uWorld;
uniform float uAlpha;
uniform float uScale;
uniform float uCharge;    // 0..1：拉得越满，心跳得越快越大
uniform float uScatter;   // >=0 = 命中后经过的秒数，<0 = 还在
uniform vec2  uCenter;

attribute vec2  aH;       // 心形空间的位置（高约 -1..1）
attribute vec2  aDir;     // 炸开方向
attribute float aSpeed;
attribute float aSeed;
attribute float aSize;
attribute float aEdge;    // 1 轮廓 / 0 内部
attribute vec3  aCol;

varying float vA;
varying vec3  vC;

void main(){
  float pulse = 1.0 + (0.026 + 0.05 * uCharge) * sin(uTime * (2.1 + 3.2 * uCharge));
  vec2 p = uCenter + aH * uScale * pulse;

  // 每股自己的一点点浮动：轮廓要像「被点亮的火」，不是描出来的边
  p += aDir * (0.006 + 0.014 * aSeed) * sin(uTime * 1.8 + aSeed * 6.2831);

  float a = uAlpha * (0.80 + 0.20 * sin(uTime * 2.4 + aSeed * 11.0));

  if (uScatter >= 0.0) {
    float st = uScatter;
    // 初速很快被空气拖住，位移指数趋近：爆开有冲劲，之后自然慢下来
    float damp = (1.0 - exp(-3.6 * st)) / 3.6;
    p += aDir * aSpeed * damp;
    // 风：整片往左上飘，和雪、和纸屑同一个方向
    p.x -= 0.16 * st * st;
    p.y += 0.42 * damp + 0.10 * st * st;
    a *= 1.0 - smoothstep(0.85, 2.4, st);
  }

  vec4 mv = modelViewMatrix * vec4(p, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uWorld * uProj / max(-mv.z, 0.1);

  vA = a * (0.65 + 0.35 * aEdge);
  vC = aCol;
}
`;

const burstVert = /* glsl */`
uniform float uTime;
uniform float uStart;
uniform float uSize;
uniform float uPixelRatio;
uniform float uWorld;
uniform float uAlpha;
uniform vec3  uOrigin;

attribute vec3  aDir;
attribute vec3  aColor;
attribute float aSeed;
attribute float aSpeed;
attribute float aSize;

varying float vAlpha;
varying vec3  vColor;

void main(){
  float t = uTime - uStart;
  if (t < 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    vColor = vec3(0.0);
    return;
  }

  float damp = (1.0 - exp(-3.2 * t)) / 3.2;
  vec3 p = uOrigin + aDir * aSpeed * damp;

  p.x -= 0.085 * t * t;
  p.y += 0.26 * damp + 0.055 * t * t;
  p.x += sin(t * 1.7 + aSeed * 6.2831) * 0.05 * t;
  p.y += cos(t * 1.3 + aSeed * 9.0) * 0.042 * t;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uWorld * uSize * uPixelRatio / max(-mv.z, 0.1);

  float fadeIn = smoothstep(0.0, 0.07, t);
  float fadeOut = 1.0 - smoothstep(1.05, 2.35, t);
  vAlpha = fadeIn * fadeOut * uAlpha * (0.5 + 0.5 * aSeed);
  vColor = aColor;
}
`;

/* ---------------- 心形曲线 ---------------- */

/**
 * 经典心形参数方程，返回归一化到「高 -1..1、中心在原点」的坐标。
 * x 的范围是 ±1（sin³），y 的实际范围是 -17（尖）~ +11.73（两个瓣顶），
 * 所以 y 要先减去中心 (-2.635) 再除以 14.37，否则心会整体偏上、尖端掉出画框。
 */
function heartPoint(t) {
  const s = Math.sin(t);
  const x = s * s * s;
  const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
  return [x * 1.06, (y + 2.635) / 14.37];
}

/** 按弧长均匀采样参数：直接均匀取 t 会在两个尖端堆一大坨点（那儿的曲线速度趋近 0） */
function heartEdgeSamples(n) {
  const M = 720;
  const ts = [];
  const ls = [0];
  let prev = heartPoint(0);
  for (let i = 0; i <= M; i++) {
    const t = (i / M) * Math.PI * 2;
    ts.push(t);
    const p = heartPoint(t);
    ls.push(ls[i] + Math.hypot(p[0] - prev[0], p[1] - prev[1]));
    prev = p;
  }
  const total = ls[M];
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = ((i + Math.random() * 0.8) / n) * total;
    while (j < M - 1 && ls[j + 1] < target) j++;
    const f = (target - ls[j]) / Math.max(1e-6, ls[j + 1] - ls[j]);
    out.push(heartPoint(ts[j] + (ts[j + 1] - ts[j]) * f));
  }
  return out;
}

/** 射线法：判断点是否在心形轮廓内（用来做「面积均匀」的内部填充） */
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export class BowArrow {
  constructor(scene, camera) {
    this.camera = camera;
    this.pr = Math.min(window.devicePixelRatio || 1, 1.85);

    this.root = new THREE.Group();
    this.root.position.z = -BOW.dist;
    this.root.visible = false;
    camera.add(this.root);

    this.vis = 0;
    this.pull = 0;
    this.nockX = -0.05;
    this.aimAngle = Math.PI * 0.83;
    this.heartDist = 7.6;
    this.unit = 0.35;
    this.heartW = BOW.heartWide;

    this.flight = null;
    this.springT = 99;
    this.heartAlive = 1;
    this.heartKill = 0;
    this.scatterT = -1;
    this.stuckUntil = -99;
    this.stuckX = 0;
    this.lastRelease = -99;
    this.lastImpact = -99;
    this.wasActive = false;
    this.inited = false;
    this.demo = 0;

    this.mats = [];
    this._buildBow();
    this._buildHeart();
    this._buildArrow();
    this._buildBurst();
  }

  /* ---------------- 构建 ---------------- */

  _pointsMat(vert, uniforms) {
    const m = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: vert,
      fragmentShader: sparkFrag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mats.push(m);
    return m;
  }

  _buildBow() {
    this.bowPivot = new THREE.Group();
    this.root.add(this.bowPivot);

    const n = N_BOW_CORE + N_BOW_INNER + N_BOW_HALO + N_STRING;
    const pos = new Float32Array(n * 3);        // 占位：位置全部在顶点着色器里算
    const aS = new Float32Array(n);
    const aMode = new Float32Array(n);
    const aOff = new Float32Array(n);
    const aWide = new Float32Array(n);
    const aSeed = new Float32Array(n);
    const aSize = new Float32Array(n);
    const aCol = new Float32Array(n * 3);

    let k = 0;
    // 三层叠出「体量」。只铺一层小点时它读起来是一条虚线（第一版就是这样）：
    // 点径 4px、间距 5px，于是眼睛看到的是「一串珠子」而不是光。
    //   芯 —— 密、小、亮   内光 —— 疏、大、半亮   外晕 —— 极少、极大、极暗
    // 这是加色混合的「伪 bloom」：不额外做后期，靠三档尺寸叠出光晕。
    for (let i = 0; i < N_BOW_CORE; i++, k++) {
      aS[k] = -1 + (2 * (i + 0.5)) / N_BOW_CORE + (Math.random() - 0.5) * 0.006;
      aMode[k] = 0;
      aOff[k] = Math.random() * 2 - 1;
      aWide[k] = 1;
      aSeed[k] = Math.random();
      aSize[k] = 0.030 + Math.random() * 0.020;
      // 暖白偏金：弓芯必须比光晕亮，否则整把弓糊成一团橙雾
      const b = 0.88 + Math.random() * 0.22;
      aCol[k * 3] = b;
      aCol[k * 3 + 1] = b * 0.89;
      aCol[k * 3 + 2] = b * 0.70;
    }
    for (let i = 0; i < N_BOW_INNER; i++, k++) {
      aS[k] = -1 + 2 * Math.random();
      aMode[k] = 0;
      // 内光贴得紧（±0.8）才有「一条发光的弓」，散得太开就是一团篝火烟
      aOff[k] = (Math.random() * 2 - 1) * 0.8;
      aWide[k] = 1.3;
      aSeed[k] = Math.random();
      aSize[k] = 0.10 + Math.random() * 0.08;
      // 色相偏琥珀：绿分量给足，否则低亮度的橙会读成「褐色脏雾」
      const b = 0.085 + Math.random() * 0.035;
      aCol[k * 3] = b;
      aCol[k * 3 + 1] = b * 0.70;
      aCol[k * 3 + 2] = b * 0.42;
    }
    for (let i = 0; i < N_BOW_HALO; i++, k++) {
      aS[k] = -1 + 2 * Math.random();
      aMode[k] = 0;
      aOff[k] = (Math.random() * 2 - 1) * 1.2;
      aWide[k] = 1.2;
      aSeed[k] = Math.random();
      aSize[k] = 0.26 + Math.random() * 0.16;
      const b = 0.030 + Math.random() * 0.022;
      aCol[k * 3] = b;
      aCol[k * 3 + 1] = b * 0.70;
      aCol[k * 3 + 2] = b * 0.42;
    }
    // 弦：偏冷的白，和暖金的弓身分开。90 颗才连得住，46 颗是一串空格子
    for (let i = 0; i < N_STRING; i++, k++) {
      aS[k] = -1 + (2 * (i + 0.5)) / N_STRING;
      aMode[k] = 1;
      aOff[k] = Math.random() * 2 - 1;
      aWide[k] = 0.9;
      aSeed[k] = Math.random();
      aSize[k] = 0.017 + Math.random() * 0.012;
      const b = 0.60 + Math.random() * 0.24;
      aCol[k * 3] = b * 0.98;
      aCol[k * 3 + 1] = b * 0.93;
      aCol[k * 3 + 2] = b * 0.86;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
    geo.setAttribute('aMode', new THREE.BufferAttribute(aMode, 1));
    geo.setAttribute('aOff', new THREE.BufferAttribute(aOff, 1));
    geo.setAttribute('aWide', new THREE.BufferAttribute(aWide, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
    geo.setAttribute('aCol', new THREE.BufferAttribute(aCol, 3));

    this.bowMat = this._pointsMat(bowVert, {
      uTime: { value: 0 },
      uPull: { value: 0 },
      uNockX: { value: -0.05 },
      uAlpha: { value: 1 },
      uProj: { value: 1200 },
      uWorld: { value: 0.35 },
      uDepth: { value: BOW.depth },
      uTipBack: { value: BOW.tipBack },
      uTipCurl: { value: BOW.tipCurl },
    });
    this.bow = new THREE.Points(geo, this.bowMat);
    this.bow.frustumCulled = false;
    this.bow.renderOrder = 21;
    this.bowPivot.add(this.bow);
  }

  _buildHeart() {
    const n = N_HEART_EDGE + N_HEART_FILL + N_HEART_GLOW;
    const pos = new Float32Array(n * 3);
    const aH = new Float32Array(n * 2);
    const aDir = new Float32Array(n * 2);
    const aSpeed = new Float32Array(n);
    const aSeed = new Float32Array(n);
    const aSize = new Float32Array(n);
    const aEdge = new Float32Array(n);
    const aCol = new Float32Array(n * 3);

    const edge = heartEdgeSamples(N_HEART_EDGE);
    let k = 0;
    for (let i = 0; i < N_HEART_EDGE; i++, k++) {
      const [x, y] = edge[i];
      aH[k * 2] = x;
      aH[k * 2 + 1] = y;
      aEdge[k] = 1;
      aSeed[k] = Math.random();
      // 轮廓上偶有几颗大的：纯等大的一圈点会读成虚线
      aSize[k] = Math.random() < 0.14 ? 0.050 + Math.random() * 0.022 : 0.028 + Math.random() * 0.016;
      // 加色混合下「正红」会被推到粉白，所以绿蓝要压得比直觉更低：
      // (1, 0.1, 0.16) 叠出来才是眼睛认的那种心红
      const g = Math.random();
      aCol[k * 3] = 1.05 + g * 0.16;
      aCol[k * 3 + 1] = 0.07 + g * 0.13;
      aCol[k * 3 + 2] = 0.13 + g * 0.10;
    }
    // 内部填充**不能**用「轮廓点 × 半径」：那样 x≈0 的那些点（t 接近 0 和 π，
    // 也就是心的凹口和尖）会全叠在竖轴上，看上去像一根穿心的骨刺 —— 第一版就中了。
    // 改成在包围盒里拒绝采样，配合射线法判内外，得到面积均匀的散点。
    for (let i = 0; i < N_HEART_FILL; i++, k++) {
      let x = 0;
      let y = 0;
      for (let guard = 0; guard < 200; guard++) {
        x = (Math.random() * 2 - 1) * 1.02;
        y = Math.random() * 1.95 - 0.97;
        if (pointInPoly(x, y, edge)) break;
      }
      aH[k * 2] = x;
      aH[k * 2 + 1] = y;
      aEdge[k] = 0;
      aSeed[k] = Math.random();
      aSize[k] = 0.020 + Math.random() * 0.018;
      // 内部压暗：填充点一亮，心就成了一颗实心球
      const g = Math.random();
      aCol[k * 3] = 0.46 + g * 0.30;
      aCol[k * 3 + 1] = 0.015 + g * 0.06;
      aCol[k * 3 + 2] = 0.06 + g * 0.05;
    }
    // 内部柔光：几颗很大的暗红点，给心一点「里面有火」的体积。
    // 没有这一层，心只是一圈描边，中间是空的，看着像个镂空贴纸。
    for (let i = 0; i < N_HEART_GLOW; i++, k++) {
      let x = 0;
      let y = 0;
      for (let guard = 0; guard < 200; guard++) {
        x = (Math.random() * 2 - 1) * 0.92;
        y = Math.random() * 1.8 - 0.9;
        if (pointInPoly(x, y, edge)) break;
      }
      aH[k * 2] = x * 0.82;
      aH[k * 2 + 1] = y * 0.82;
      aEdge[k] = 0;
      aSeed[k] = Math.random();
      aSize[k] = 0.13 + Math.random() * 0.11;
      const b = 0.055 + Math.random() * 0.045;
      aCol[k * 3] = b;
      aCol[k * 3 + 1] = b * 0.10;
      aCol[k * 3 + 2] = b * 0.22;
    }

    for (let i = 0; i < n; i++) {
      // 炸开方向：从心脏中心往外，掺一点随机，避免整颗心「平均地膨胀」
      const x = aH[i * 2];
      const y = aH[i * 2 + 1];
      const l = Math.hypot(x, y);
      let dx;
      let dy;
      if (l < 0.08) {
        const th = Math.random() * Math.PI * 2;
        dx = Math.cos(th);
        dy = Math.sin(th);
      } else {
        dx = x / l;
        dy = y / l;
      }
      dx += (Math.random() - 0.5) * 0.75;
      dy += (Math.random() - 0.5) * 0.75;
      const dl = Math.hypot(dx, dy) || 1;
      aDir[i * 2] = dx / dl;
      aDir[i * 2 + 1] = dy / dl;
      aSpeed[i] = 1.1 + Math.pow(Math.random(), 0.7) * 2.3;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aH', new THREE.BufferAttribute(aH, 2));
    geo.setAttribute('aDir', new THREE.BufferAttribute(aDir, 2));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
    geo.setAttribute('aEdge', new THREE.BufferAttribute(aEdge, 1));
    geo.setAttribute('aCol', new THREE.BufferAttribute(aCol, 3));

    this.heartMat = this._pointsMat(heartVert, {
      uTime: { value: 0 },
      uProj: { value: 1200 },
      uWorld: { value: 0.35 },
      uAlpha: { value: 1 },
      uScale: { value: 0.47 },
      uCharge: { value: 0 },
      uScatter: { value: -1 },
      uCenter: { value: new THREE.Vector2(-3.2, 1.8) },
    });
    this.heart = new THREE.Points(geo, this.heartMat);
    this.heart.frustumCulled = false;
    this.heart.renderOrder = 23;
    this.root.add(this.heart);
  }

  _buildArrow() {
    this.arrowGroup = new THREE.Group();
    this.arrowGroup.visible = false;
    this.bowPivot.add(this.arrowGroup);

    const N_SHAFT = 84;
    const N_AGLOW = 26;
    const N_HEAD = 26;
    const N_TAIL = 40;
    const n = N_SHAFT + N_AGLOW + N_HEAD + N_TAIL;

    const pos = new Float32Array(n * 3);
    const aP = new Float32Array(n * 2);
    const aTail = new Float32Array(n);
    const aSeed = new Float32Array(n);
    const aSize = new Float32Array(n);
    const aCol = new Float32Array(n * 3);

    const L = BOW.arrowLen;
    let k = 0;
    // 箭杆：从尾到头一串点，末端略粗
    for (let i = 0; i < N_SHAFT; i++, k++) {
      const u = i / (N_SHAFT - 1);
      aP[k * 2] = 0.02 + u * (L - 0.04);
      aP[k * 2 + 1] = (Math.random() - 0.5) * 0.010;
      aTail[k] = 0;
      aSeed[k] = Math.random();
      // 从尾（0.45）到头（1.0）渐亮：等亮度的一条线会被读成「一根白棍」，
      // 渐变之后眼睛才知道哪一头是箭头
      // 点径必须大于点间距（154px 里 84 点 ≈ 1.8px），否则整支箭是虚线；
      // 直径 2.4→4px 才能叠成一条实心光杆
      const ramp = 0.55 + 0.45 * u;
      aSize[k] = (0.018 + Math.random() * 0.010) * (0.9 + 0.5 * u);
      aCol[k * 3] = 1.05 * ramp;
      aCol[k * 3 + 1] = (0.80 + Math.random() * 0.12) * ramp;
      aCol[k * 3 + 2] = (0.54 + Math.random() * 0.14) * ramp;
    }
    // 箭杆柔光：和弓一样，一层小亮点是「一条虚线」，加大颗淡光才有实体感
    for (let i = 0; i < N_AGLOW; i++, k++) {
      aP[k * 2] = 0.04 + Math.random() * (L - 0.12);
      aP[k * 2 + 1] = (Math.random() - 0.5) * 0.020;
      aTail[k] = 0;
      aSeed[k] = Math.random();
      aSize[k] = 0.050 + Math.random() * 0.045;
      const b = 0.10 + Math.random() * 0.06;
      aCol[k * 3] = b;
      aCol[k * 3 + 1] = b * 0.74;
      aCol[k * 3 + 2] = b * 0.44;
    }
    // 箭头：一撮收紧到尖端的光点（从尾部楔形收成一点）
    for (let i = 0; i < N_HEAD; i++, k++) {
      const u = Math.pow(Math.random(), 0.7);
      const half = (1 - u) * 0.055;
      aP[k * 2] = L - 0.10 + u * 0.10;
      aP[k * 2 + 1] = (Math.random() * 2 - 1) * half;
      aTail[k] = 0;
      aSeed[k] = Math.random();
      aSize[k] = 0.024 + (1 - u) * 0.020;
      // 箭头是整支箭最亮的一点：暗背景里没有它，就只是「一根线」
      aCol[k * 3] = 1.25;
      aCol[k * 3 + 1] = 1.10;
      aCol[k * 3 + 2] = 0.92;
    }
    // 拖尾：箭后方一撮散点，越远越淡越小
    for (let i = 0; i < N_TAIL; i++, k++) {
      // 尾迹要密：30 颗铺 1.35 个单位，在屏幕上就是「一串珍珠」；
      // 96 颗才连成一条被拉长的光尾巴，长度收到 0.9 也不再比箭还长
      const u = Math.pow(Math.random(), 1.35);
      aP[k * 2] = -u * 0.40;
      aP[k * 2 + 1] = (Math.random() - 0.5) * (0.015 + u * 0.05);
      aTail[k] = 1;
      aSeed[k] = Math.random();
      aSize[k] = (0.011 + Math.random() * 0.009) * (1 - u * 0.4);
      // 三次方衰减：一次方太「实」，尾巴会和箭杆连成一根直棍
      const f = Math.pow(1 - u, 2.6) * (0.55 + Math.random() * 0.45);
      aCol[k * 3] = f;
      aCol[k * 3 + 1] = f * 0.66;
      aCol[k * 3 + 2] = f * 0.34;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aP', new THREE.BufferAttribute(aP, 2));
    geo.setAttribute('aTail', new THREE.BufferAttribute(aTail, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
    geo.setAttribute('aCol', new THREE.BufferAttribute(aCol, 3));

    this.arrowMat = this._pointsMat(arrowVert, {
      uTime: { value: 0 },
      uProj: { value: 1200 },
      uWorld: { value: 0.35 },
      uAlpha: { value: 1 },
      uTail: { value: 0 },
    });
    this.arrow = new THREE.Points(geo, this.arrowMat);
    this.arrow.frustumCulled = false;
    this.arrow.renderOrder = 22;
    this.arrowGroup.add(this.arrow);
  }

  _buildBurst() {
    const n = N_BURST;
    const dir = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    const speed = new Float32Array(n);
    const size = new Float32Array(n);
    const pos = new Float32Array(n * 3);      // 占位，全在顶点着色器里算
    const c = new THREE.Color();

    // 红心炸开以后是「红 + 香槟金」，不是纯红：纯红在暗背景上会读成一团血
    const palette = [0xff4a5c, 0xff7a6a, 0xffc08a, 0xfff0d8, 0xff2b48];

    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      dir[i * 3] = Math.cos(th) * r;
      dir[i * 3 + 1] = Math.sin(th) * r * 0.92;
      dir[i * 3 + 2] = u * 0.30;

      c.setHex(palette[Math.floor(Math.random() * palette.length)]);
      c.multiplyScalar(0.86 + Math.random() * 0.34);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;

      seed[i] = Math.random();
      speed[i] = 0.55 + Math.pow(Math.random(), 0.7) * 2.1;
      size[i] = 0.016 + Math.pow(Math.random(), 1.5) * 0.034;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

    this.burstMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uStart: { value: -99 },
        uSize: { value: 1170 },
        uPixelRatio: { value: this.pr },
        uWorld: { value: 0.35 },
        uAlpha: { value: 1 },
        uOrigin: { value: new THREE.Vector3(-3.2, 1.8, 0) },
      },
      vertexShader: burstVert,
      fragmentShader: sparkFrag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.burst = new THREE.Points(geo, this.burstMat);
    this.burst.frustumCulled = false;
    this.burst.renderOrder = 24;
    this.burst.visible = false;
    this.root.add(this.burst);
  }

  /* ---------------- 对外 ---------------- */

  /** 放箭。power 0.45~1，决定飞行时间和尾迹长度 */
  trigger(t, power = 1) {
    if (!this.inited) return;
    const p = Math.min(1, Math.max(0.35, power));
    this.flight = {
      t0: t,
      dur: 0.30 + (1 - p) * 0.18,
      from: this.nockX,
      to: this.heartDist - BOW.arrowLen,
      power: p,
    };
    this.springT = 0;
    this.arrowGroup.visible = true;
    this.lastRelease = t;
    this.heartAlive = Math.max(this.heartAlive, 0.9);
    this.scatterT = -1;
  }

  /**
   * 演示：没有摄像头（或不想比手势）时按 B 看一遍完整的拉弓 → 放箭。
   * 内部只是伪造一段 pull 曲线，其余全部走正常管线。
   */
  demoShot(t) {
    this.demo = t;
  }

  update(dt, t, state, params) {
    // 演示模式：1.1 秒把弓拉满，然后自动放箭
    if (this.demo > 0) {
      const k = Math.min(1, (t - this.demo) / 1.1);
      state = { active: true, pull: k };
      if (k >= 1) {
        this.demo = 0;
        this.pull = 1;
        this.trigger(t, 1);
      }
    }

    const active = !!(state && state.active);

    // 换了一次「拉弓」，红心要复活
    if (active && !this.wasActive) {
      this.heartAlive = 1;
      this.scatterT = -1;
      this.heartKill = 0;
    }
    this.wasActive = active;

    const targetPull = active ? Math.min(1, state.pull) : 0;
    this.pull += (targetPull - this.pull) * (1 - Math.exp(-dt * (active ? 13 : 7)));
    if (this.pull < 0.003) this.pull = 0;

    const flying = !!this.flight;
    const keep = active || flying || t - this.lastImpact < 2.6 || t - this.lastRelease < 1.2;
    this.vis += ((keep ? 1 : 0) - this.vis) * (1 - Math.exp(-dt * (keep ? 10 : 2.6)));
    if (this.vis < 0.008) {
      this.root.visible = false;
      this.burst.visible = false;
      this.arrowGroup.visible = false;
      return;
    }
    this.root.visible = true;

    this._layout();
    this._updateBow(dt, t, params);
    this._updateHeart(dt, t);
    this._updateArrow(dt, t);
    this._updateBurst(t);

    this.inited = true;
  }

  setPixelRatio(pr) {
    this.pr = pr;
    this.burstMat.uniforms.uPixelRatio.value = pr;
    this._updateProj();
  }

  /**
   * 点精灵的尺寸换算。gl_PointSize 的单位是**设备像素**，所以焦距要用
   * 绘制缓冲的高度（CSS 高度 × 像素比），否则在 2 倍屏上所有点都会小一半。
   */
  _updateProj() {
    const vh = window.innerHeight || 900;
    const tanHalf = Math.tan((this.camera.fov * Math.PI) / 360);
    const proj = (vh * this.pr * 0.5) / tanHalf;
    for (const m of this.mats) m.uniforms.uProj.value = proj;
    this.burstMat.uniforms.uSize.value = proj / this.pr;
  }

  /* ---------------- 布局 ---------------- */

  /**
   * 每帧算一次。不值当缓存：几个三角函数而已，缓存反而要记一堆 resize 失效条件。
   */
  _layout() {
    const cam = this.camera;
    const halfH = BOW.dist * Math.tan((cam.fov * Math.PI) / 360);
    const halfW = halfH * cam.aspect;
    const narrow = cam.aspect < 0.95;

    // unit = 「1 个局部单位」在屏幕上的高度。弓高固定 2 个局部单位，
    // 所以 unit 取可见高度的 30%（竖屏 18%，窄屏横向只有 2.5 个弓宽，
    // 21.5% 会让弓的右半边直接切出画面）
    const unit = halfH * (narrow ? 0.180 : 0.295);
    this.unit = unit;
    this.root.scale.setScalar(unit);

    // 可见范围的半宽 / 半高，换算成局部单位
    const rx = halfW / unit;
    const ry = halfH / unit;

    // 弓的半径约 1 个局部单位：位置必须让开 1.02，否则会被画框切掉一角
    // （竖屏第一版就是这样：右下角只剩半个弓）。横屏时下面两个 min/max 不生效。
    const bx = Math.min((narrow ? 0.62 : 0.60) * rx, rx - 1.02);
    const by = Math.max(-(narrow ? 0.58 : 0.60) * ry, -(ry - 1.02));
    const hx = -(narrow ? 0.54 : 0.58) * rx;
    const hy = (narrow ? 0.58 : 0.55) * ry;

    this.heartW = narrow ? BOW.heartNarrow : BOW.heartWide;

    this.bowPivot.position.set(bx, by, 0);
    this.aimAngle = Math.atan2(hy - by, hx - bx);
    this.bowPivot.rotation.z = this.aimAngle;

    // 心正好落在这条射线上（角度就是按它算的），所以箭只要沿本地 +X 走就能命中
    this.heartDist = Math.hypot(hx - bx, hy - by);

    this.heartMat.uniforms.uCenter.value.set(hx, hy);
    this.heartMat.uniforms.uScale.value = this.heartW * 0.5;
    this.burstMat.uniforms.uOrigin.value.set(hx, hy, 0);

    // 世界尺寸 → 屏幕像素 的换算，所有点云共用
    this._updateProj();
    this.bowMat.uniforms.uWorld.value = unit;
    this.arrowMat.uniforms.uWorld.value = unit;
    this.heartMat.uniforms.uWorld.value = unit;
    this.burstMat.uniforms.uWorld.value = unit;
  }

  /* ---------------- 弓与弦 ---------------- */

  _updateBow(dt, t, params) {
    const pull = this.pull;
    const glow = this.vis * (0.86 + 0.14 * Math.min(1.2, (params && params.beat) || 0));

    // 放箭后有一记「嘣」的余振：指数衰减的正弦，往回弹过静止位再收住
    this.springT += dt;
    const spring = this.springT < 2 ? 0.17 * Math.exp(-this.springT * 8.5) * Math.sin(this.springT * 46) : 0;
    this.nockX = -0.05 - BOW.pullMax * pull + spring;

    const u = this.bowMat.uniforms;
    u.uTime.value = t;
    u.uPull.value = pull;
    u.uNockX.value = this.nockX;
    u.uAlpha.value = glow * (0.55 + 0.45 * pull);
  }

  /* ---------------- 红心 ---------------- */

  _updateHeart(dt, t) {
    // 拉弓时红心跟着绷紧：越接近满弓，跳得越快、越大（在顶点着色器里用 uCharge 算）
    const charge = smoothstep(0.15, 0.9, this.pull);

    if (this.scatterT >= 0) {
      this.scatterT += dt;
      this.heartAlive = Math.max(0, 1 - smoothstep(0.7, 2.2, this.scatterT));
      if (this.scatterT > 2.6) {
        this.scatterT = -1;
        this.heartAlive = 0;
      }
    } else if (this.heartAlive < 1 && this.wasActive && t - this.lastImpact > 1.9) {
      // 还举着弓才让心慢慢长回来，好放第二箭；松手之后保持在淡出状态 ——
      // 否则观众会看到一颗被打穿的心自己愈合
      this.heartAlive = Math.min(1, this.heartAlive + dt * 1.1);
    }

    const u = this.heartMat.uniforms;
    u.uTime.value = t;
    u.uCharge.value = charge;
    u.uAlpha.value = this.vis * this.heartAlive * (0.9 + 0.1 * Math.sin(t * 2.1));
    u.uScatter.value = this.scatterT;

    this.heart.visible = this.vis > 0.02 && this.heartAlive > 0.01;
  }

  /* ---------------- 箭 ---------------- */

  _updateArrow(dt, t) {
    const f = this.flight;

    if (!f) {
      // 命中后先「钉」在心上 0.26 秒：箭一触到就消失，观众反应不过来
      // 是箭射中了；钉住 + 心一起淡出，才读得出「穿心」。
      // 之后到 0.9 秒之间不显示 —— 否则弓上立刻又搭好一支，
      // 看起来像「一次射了两箭」，也会把心口炸开的粒子抢掉注意力
      const stuck = t < this.stuckUntil;
      this.arrowGroup.visible = stuck
        || (this.vis > 0.05 && this.heartAlive > 0.2 && t - this.lastImpact > 0.9);
      this.arrowGroup.position.set(stuck ? this.stuckX : this.nockX, 0, 0);
      this.arrowMat.uniforms.uAlpha.value = stuck ? this.vis * Math.max(0, 1 - (t - this.lastImpact) / 0.26) : this.vis;
      this.arrowMat.uniforms.uTail.value = 0;
      this.arrowMat.uniforms.uTime.value = t;
      return;
    }

    const k = Math.min(1, (t - f.t0) / f.dur);
    // 箭是「弹」出去的：起步极快，之后略减速（不是匀速漂过去）
    const ease = 1 - Math.pow(1 - k, 1.7);
    const x = f.from + (f.to - f.from) * ease;

    this.arrowGroup.visible = true;
    this.arrowGroup.position.set(x, 0, 0);

    const u = this.arrowMat.uniforms;
    u.uTime.value = t;
    u.uTail.value = 0.7 + 0.3 * f.power;
    u.uAlpha.value = this.vis * (0.65 + 0.35 * f.power) * (1 - k * 0.15);

    if (k >= 1) {
      this.flight = null;
      this.stuckX = f.to;
      this.stuckUntil = t + 0.26;
      this._impact(t, f.power);
    }
  }

  _impact(t, power) {
    this.lastImpact = t;
    this.heartKill = t;
    this.scatterT = 0;        // 心的粒子从这里开始炸开

    const u = this.burstMat.uniforms;
    u.uStart.value = t;
    u.uTime.value = t;
    u.uAlpha.value = 0.62 + 0.38 * power;
    this.burst.visible = true;
  }

  _updateBurst(t) {
    if (!this.burst.visible) return;
    const u = this.burstMat.uniforms;
    u.uTime.value = t;
    if (t - u.uStart.value > 2.6) this.burst.visible = false;
  }
}
