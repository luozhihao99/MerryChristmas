import * as THREE from 'three';
import { bokehTexture } from './textures.js';

/**
 * 前景失焦光斑：几团「非常大、非常虚」的光从镜头前缓缓飘过。
 *
 * 作用不是装饰，是**造景深**。画面里原有的东西全都落在树的同一层上：树、礼物、
 * 雪、天空 —— 再精致也像一张画。真人的眼睛判断「这是一个空间」靠的是
 * 近处的物体被镜头虚掉、并且移动得比远处快。所以这里放的是：
 *
 *   · 位置：世界 z 5.0~9.5，比树（z ≈ ±3.2）更靠近相机，离镜头只有 7~12 个单位
 *   · 尺寸：世界尺度 0.35~0.95 米，投到屏幕上就是 35~160 像素的大光斑
 *   · 模糊：贴图本身就是焦外的形状（see bokehTexture），不是靠调小透明度糊过去
 *   · 速度：世界尺度 0.25~0.55 米/秒。看着慢，但因为离得近，屏幕上的位移
 *           反而比远处飘雪快 —— 这就是视差
 *
 * 几个必须注意的坑：
 *   1. 点精灵在**中心**出了裁剪体就整个消失。这么大的一团如果直接飘出画外，
 *      会「啪」地不见。所以按 NDC 坐标在贴边处提前淡出（edge 那段）。
 *   2. 只能用加色混合：普通混合的黑色遮罩会在大光斑上留下一个能看出来的方框。
 *   3. 亮度必须低。它面积大，稍亮一点就盖住树中心，而且 bloom 会再乘一遍。
 */

// 宽屏 9 团、竖屏 6 团（窄幅占屏比例大，多了会糊住树腰）—— 数量由 main.js 传
const COUNT_DEFAULT = 9;

/**
 * 世界高度范围：光斑在这个高度带里循环下落。
 * 19 米太长了 —— 前景离镜头只有 10 米上下，竖直视野只有 7 米左右，
 * 光斑撒在 19 米的带子里，同一时刻画面上平均只剩两团，看不出「几片在前面飘」。
 * 收到 12 米（可见区占六成），9 团里常驻 4~5 团在画内。
 */
const SPAN = 12;
const Y0 = -2.5;

const vert = /* glsl */`
uniform float uTime;
uniform float uProj;        // 焦距（像素）：(绘制缓冲高度/2) / tan(fov/2)
uniform float uIntensity;
uniform float uLove;
uniform float uSpan;
uniform float uY0;

attribute float aSize;
attribute float aSeed;
attribute float aSpeed;
attribute float aRot;
attribute vec3  aColor;

varying float vAlpha;
varying vec3  vColor;
varying float vRot;

void main(){
  vec3 p = position;

  // 缓缓下落 + 循环。速度按 seed 拉开，几团不会像被同一根绳子拽着往下走
  float raw = mod(p.y - uTime * aSpeed, uSpan);
  p.y = raw + uY0;

  // 横向极慢的摆：真实的前景光斑会随镜头轻微晃动，纯直线下落很假
  p.x += sin(uTime * 0.11 + aSeed * 6.2831) * 1.35;
  p.z += cos(uTime * 0.09 + aSeed * 4.13) * 0.55;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec4 clip = projectionMatrix * mv;
  gl_Position = clip;

  // 按世界尺寸投影，天然做到「越近越大」，并且和屏幕分辨率/像素比无关
  gl_PointSize = aSize * uProj / max(-mv.z, 0.1);

  // 上下循环的两端渐隐
  float loop = smoothstep(0.0, 3.0, raw) * (1.0 - smoothstep(uSpan - 3.0, uSpan, raw));

  // 贴边淡出（见文件头注释第 1 条）：光斑中心还没出画，就已经淡没了
  float ex = abs(clip.x / clip.w);
  float ey = abs(clip.y / clip.w);
  float edge = (1.0 - smoothstep(0.74, 0.97, ex)) * (1.0 - smoothstep(0.90, 1.0, ey));

  // 个别光斑有极缓的呼吸：全都恒定亮度会像贴了几张图
  float breathe = 0.72 + 0.28 * sin(uTime * 0.23 + aSeed * 11.0);

  vAlpha = uIntensity * loop * edge * breathe * (0.55 + aSeed * 0.45);
  vColor = mix(aColor, vec3(1.0, 0.74, 0.84), uLove * 0.45);
  vRot = aRot + uTime * (aSeed - 0.5) * 0.06;
}
`;

const frag = /* glsl */`
uniform sampler2D uMap;
varying float vAlpha;
varying vec3  vColor;
varying float vRot;

void main(){
  vec2 uv = gl_PointCoord - 0.5;
  float s = sin(vRot), c = cos(vRot);
  uv = mat2(c, -s, s, c) * uv;
  float a = texture2D(uMap, uv + 0.5).a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}
`;

/**
 * 冷白（雪）、暖金（树灯的焦外）、青白（雪地反光）。
 * 三个都比「雪」本身更饱和一点：焦外光团如果只是中性灰，在深色底上会读成
 * 一枚悬在空中的灰硬币；带一点色相，眼睛才会把它归到「光」这一类。
 */
const TINTS = [
  [0.74, 0.86, 1.00],
  [1.00, 0.82, 0.58],
  [0.66, 1.00, 0.86],
];

export class NearBokeh {
  constructor(scene, { count = COUNT_DEFAULT } = {}) {
    const n = Math.max(3, count);
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const seed = new Float32Array(n);
    const speed = new Float32Array(n);
    const rot = new Float32Array(n);
    const color = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
      // 横向避开画面正中：9 团大光斑随机撒，总会有一团正压在树的腰上 ——
      // 那是整幅画的主体，压上去立刻像镜头脏了。让它们分居左右两侧，
      // 作用才是「前景 / 画框」，而不是「污点」。
      const side = i % 2 ? 1 : -1;
      pos[i * 3] = side * (2.6 + Math.random() * 5.4);
      pos[i * 3 + 1] = Math.random() * SPAN;
      // 前排（靠近相机）刻意少一点：太靠前的一团会盖住半个屏幕
      pos[i * 3 + 2] = 5.0 + Math.pow(Math.random(), 1.5) * 4.5;

      size[i] = 0.40 + Math.pow(Math.random(), 1.4) * 0.60;
      seed[i] = Math.random();
      speed[i] = 0.24 + Math.random() * 0.30;
      rot[i] = Math.random() * Math.PI * 2;

      const t = TINTS[i % TINTS.length];
      const k = 0.86 + Math.random() * 0.24;
      color[i * 3] = t[0] * k;
      color[i * 3 + 1] = t[1] * k;
      color[i * 3 + 2] = t[2] * k;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    geo.setAttribute('aRot', new THREE.BufferAttribute(rot, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uProj: { value: 900 },
        uIntensity: { value: 0.34 },
        uLove: { value: 0 },
        uSpan: { value: SPAN },
        uY0: { value: Y0 },
        uMap: { value: bokehTexture() },
      },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      // 不与场景做深度比较：它们本来就该压在树上面。
      // 开着 depthTest 的话，飘到树后面那半截会被切出一条硬边。
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 30;
    scene.add(this.points);
  }

  /**
   * @param {THREE.Camera} camera 只读 fov / aspect 和屏幕高度，用来算焦距
   * @param {number} viewH 视口高度（CSS 像素）
   * @param {number} pixelRatio 绘制缓冲相对 CSS 的倍率
   */
  setViewport(camera, viewH, pixelRatio) {
    // gl_PointSize 的单位是**绘制缓冲**像素，所以焦距也要用绘制缓冲高度来算
    const hPx = viewH * pixelRatio;
    const f = (hPx * 0.5) / Math.tan((camera.fov * Math.PI) / 360);
    this.mat.uniforms.uProj.value = f;
  }

  update(dt, t, params, camera) {
    const u = this.mat.uniforms;
    u.uTime.value = t;
    u.uLove.value = Math.min(1, params.love || 0);

    // 竖屏占屏比例更大，密度和亮度都收一档，否则前景会挡掉半个树
    const narrow = camera ? camera.aspect < 0.95 : false;
    let inten = narrow ? 0.28 : 0.34;
    // 满屏爱心 / 流星时前景让位：大光斑会把细小的粒子图案糊掉
    inten *= 1 - 0.55 * Math.min(1, params.love || 0);
    u.uIntensity.value = inten;
  }
}
