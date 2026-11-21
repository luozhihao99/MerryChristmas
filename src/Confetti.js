import * as THREE from 'three';

/**
 * 「点赞」手势（拇指竖起、其余四指收回）触发的粒子：一蓬金箔纸屑。
 *
 * 原来这里是「五角星 + 666」（`LikeBurst.js`，保留作备选）。换掉的理由不是
 * 五角星画得不好，是符号本身不对：
 *   五角星属于「评分 / 收藏」这一套符号系统（打分、收藏夹、会员星级），
 *   在一个雪夜圣诞树前面，它读起来像电商首页的角标；666 又是弹幕梗。
 *   两个加在一起，画面情绪从「为你叫好」掉到「直播间刷礼物」。
 *   撒花是「叫好」最通用的视觉语言，不需要任何文字注解。
 *
 * 形态上它是场景里唯一的「薄片」：雪花是圆点、流星是斜线、孔明灯是球、
 * 螺旋是环。纸屑翻转时的宽窄变化，让它一眼就能和别的东西分开。
 *
 * ---- 为什么每片只用一个点 ----
 * 第一版用 8 个圆点拼一片（4×2 的点阵）。跑起来全是「金色小点」——
 * 软圆点没有边缘，8 个叠在一起还是 8 个点，读不出「一张纸」，
 * 和树上的彩灯、和雪糊成同一种东西。
 * 现在改成「一个点 = 一片纸屑」，形状在片元着色器里用旋转矩形裁出来：
 * 边界是硬的，转动时是有棱角的，才像金箔。
 *
 * 出发位置也不再是「树腰一点炸开」——300 片挤在同一个位置，
 * 加法混合下当场烧成一团白斑。改成按锥面散布在整棵树上、错开出場，
 * 才像一整棵树在往下撒。
 */

const LIFE = 4.80;             // 一片纸屑从出现到淡出的时长（秒）
const ASPECT = 0.62;           // 宽 / 长。金箔不是细长条，接近 2:3 的小方片
const DIAG = Math.hypot(1, ASPECT);   // 旋转时外接对角线，用来放大点径免得被裁

const vert = /* glsl */`
uniform float uTime;
uniform float uStart;
uniform float uSize;
uniform float uPixelRatio;
uniform float uIntensity;
uniform float uLife;

attribute float aSeed;
attribute float aSize;
attribute vec3  aColor;

varying float vAlpha;
varying float vRot;
varying vec2  vHalf;
varying vec3  vColor;

// 从种子派生一串互不相关的伪随机数。传一堆 attribute 太浪费，
// 反正只要「片与片之间不同」就够了
float hash(float n){
  return fract(sin(n * 127.1) * 43758.5453);
}

void main(){
  float e = uTime - uStart;
  if (e < 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    vColor = vec3(0.0);
    return;
  }

  float h1 = hash(aSeed + 1.3);
  float h2 = hash(aSeed + 2.7);
  float h3 = hash(aSeed + 4.1);
  float h4 = hash(aSeed + 5.9);
  float h5 = hash(aSeed + 7.3);
  float h6 = hash(aSeed + 9.7);

  // 错开出场：整棵树「唰」地同时出现像贴图，错开半秒才像被抖下来
  float t = max(e - h6 * 0.52, 0.0);

  // ---- 出身：按锥面散布在树身上，不是从某一点炸开 ----
  float hy = 0.05 + h1 * 0.95;                   // 归一化高度
  float y0 = 0.85 + hy * 7.9;
  float cone = pow(max(1.0 - hy, 0.0), 1.04);
  float rr = 3.15 * cone * 1.05 + 0.22 + h2 * 0.55;
  float th = h3 * 6.2831;

  // 向外 + 向上一点，然后被重力按住往下落
  float vOut = 0.30 + h4 * 0.85;
  float vUp = 0.22 + h5 * 1.25;

  float k = 1.55;
  float damp = (1.0 - exp(-k * t)) / k;

  float x = cos(th) * rr + cos(th) * vOut * damp + (h1 - 0.5) * 0.30 * t;
  float y = y0 + vUp * damp - 0.62 * t * t;
  float z = sin(th) * rr * 0.86 + 0.45 + (h3 - 0.5) * 0.7;

  // 飘：左右摆一下，整体再被风带着走（和别的特效同一个风向）
  x += sin(t * 2.1 + h4 * 6.2831) * 0.26 * smoothstep(0.0, 0.9, t);
  x += t * t * 0.34;

  // 落地就停住，别穿到地下
  float ground = 1.0 - smoothstep(0.25, 1.15, y);
  y = max(y, 0.10);

  // ---- 翻转 ----
  // vRot 是片在屏幕里的朝向；flip 是它绕长轴自转时正背面交替造成的「变窄」
  float vRot = h4 * 6.2831 + t * (1.8 + h5 * 2.8);
  float flip = 0.16 + 0.84 * abs(cos(t * 4.2 + h5 * 6.2831));

  vec4 mv = modelViewMatrix * vec4(x, y, z, 1.0);
  gl_Position = projectionMatrix * mv;

  // 点径按「片长 × 对角线」给：正方点要能容下转到 45° 的那条长边，
  // 不乘 DIAG 的话斜着转的一瞬间两端会被裁掉
  float L = (0.032 + h2 * 0.030) * aSize;
  gl_PointSize = L * ${DIAG.toFixed(4)} * uSize * uPixelRatio / max(-mv.z, 0.1);

  float fadeIn = smoothstep(0.0, 0.10, t);
  float fadeOut = 1.0 - smoothstep(uLife * 0.60, uLife, t);

  // 落地后不收干净会在地面留一层金屑停着不动
  vAlpha = uIntensity * fadeIn * fadeOut * (1.0 - 0.88 * ground) * (0.72 + 0.38 * h5);

  // 半宽半高，单位是「点空间的 -0.5..0.5」。除以 DIAG 是因为点已按对角线放大过
  vHalf = vec2(0.5, 0.5 * ${ASPECT.toFixed(3)} * flip) / ${DIAG.toFixed(4)};
  vColor = aColor;
}
`;

const frag = /* glsl */`
varying float vAlpha;
varying float vRot;
varying vec2  vHalf;
varying vec3  vColor;

void main(){
  // 把点坐标转到纸屑自己的坐标系，再裁一个矩形出来
  vec2 pc = gl_PointCoord - 0.5;
  float c = cos(vRot);
  float s = sin(vRot);
  vec2 q = vec2(c * pc.x + s * pc.y, -s * pc.x + c * pc.y);

  vec2 a = abs(q);
  if (a.x > vHalf.x || a.y > vHalf.y) discard;

  // 边缘柔一档：硬边在加法混合下转动时会闪（像素级锯齿），
  // 但也不能太软 —— 软了就又变回圆点，这一版就白改了
  float ex = 1.0 - smoothstep(vHalf.x * 0.76, vHalf.x, a.x);
  float ey = 1.0 - smoothstep(vHalf.y * 0.58, vHalf.y, a.y);
  float alpha = ex * ey;

  // 金箔不是均匀发光：靠长轴一端亮一点，像被灯照到的那一面
  float sheen = 0.78 + 0.34 * (1.0 - a.x / max(vHalf.x, 0.001));

  gl_FragColor = vec4(vColor * alpha * vAlpha * sheen, 1.0);
}
`;

// 金箔为主，掺一点银箔和白。真实的圣诞纸屑就是金银混在一起 ——
// 全给金色会跟树上那串暖白彩灯糊成一个色系，读不出「这是撒下来的东西」
const PALETTE = [
  { hex: 0xffc978, w: 0.46 },   // 金（主色，压过雪的白）
  { hex: 0xfff0da, w: 0.22 },   // 香槟白
  { hex: 0xdfe9f5, w: 0.14 },   // 银，只作点缀 —— 多了就跟雪分不开
  { hex: 0xffab5c, w: 0.13 },   // 暖橙
  { hex: 0xff6f5a, w: 0.05 },   // 一点红，多了像婚礼
];

function pickColor() {
  const r = Math.random();
  let acc = 0;
  for (const p of PALETTE) {
    acc += p.w;
    if (r <= acc) return p.hex;
  }
  return PALETTE[0].hex;
}

export class Confetti {
  constructor(scene, { count = 2600 } = {}) {
    this.now = -1;
    this.active = false;
    this.endAt = 0;
    this.dim = 0;
    this.mat = null;

    this._build(scene, count);
  }

  _build(scene, count) {
    const n = Math.max(200, count);
    const pos = new Float32Array(n * 3);     // 占位，全在 shader 里算
    const seed = new Float32Array(n);
    const size = new Float32Array(n);
    const col = new Float32Array(n * 3);

    const c = new THREE.Color();

    for (let i = 0; i < n; i++) {
      seed[i] = Math.random() * 97.0;
      // 尺寸两极分化：大片少、小片多，看起来才有前后层次
      size[i] = 0.58 + Math.pow(Math.random(), 1.7) * 0.95;

      c.setHex(pickColor()).multiplyScalar(0.92 + Math.random() * 0.36);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uStart: { value: 1e9 },
        uSize: { value: 990 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.85) },
        uIntensity: { value: 0.78 },
        uLife: { value: LIFE },
      },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    this.points.visible = false;
    scene.add(this.points);
  }

  /** 一轮还没落完不叠下一轮（手势一直比着也只放一次） */
  get busy() {
    return this.active && this.now < this.endAt - 0.7;
  }

  trigger(t) {
    this.active = true;
    this.endAt = t + LIFE;
    this.mat.uniforms.uStart.value = t;
    this.mat.uniforms.uTime.value = t;
    this.points.visible = true;
  }

  update(dt, t, camera) {
    this.now = t;
    this.dim += ((this.active ? 1 : 0) - this.dim) * (1 - Math.exp(-dt * 7));

    const u = this.mat.uniforms;

    // 点径的换算是「世界单位 → 像素」，得跟着视口高度和 fov 走：
    //   pixelsPerUnit = (viewportH / 2) / (dist * tan(fov/2))
    // 顶点里写的是 gl_PointSize = L * DIAG * uSize / dist，
    // 所以 uSize = (viewportH / 2) / tan(fov/2) / DIAG。
    // 早先凭感觉给 62，算下来一片只有 1.7 像素 —— 等于什么都没画
    if (camera) {
      const vh = window.innerHeight || 900;
      const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
      const narrow = camera.aspect < 0.95;
      // 竖屏：树几乎占满整个宽度，同样大小的片在窄幅里显得又大又密，
      // 一片片会连成一层白雾。片径收到 0.62、亮度也压一档
      u.uSize.value = ((vh * 0.5) / tanHalf / DIAG) * (narrow ? 0.62 : 1.0);
      u.uIntensity.value = narrow ? 0.66 : 0.78;
    }

    if (!this.active) return;

    u.uTime.value = t;

    if (t > this.endAt) {
      this.active = false;
      this.points.visible = false;
    }
  }

  setPixelRatio(pr) {
    this.mat.uniforms.uPixelRatio.value = pr;
  }
}
