import * as THREE from 'three';
import { dotTexture } from './textures.js';
import { TREE } from './ParticleTree.js';

/**
 * 常驻的一层「暖金浮尘」：沿着树的锥面螺旋向上爬升，顶端散开、底部补进来，
 * 永远循环。它不是特效，是氛围 —— 一整棵树静止不动的时候，画面里还有东西在走。
 *
 * 颜色为什么是暖金而不是银白：
 *   这套画面深绿打底、暖金点缀（彩灯、树顶的星、孔明灯），银白是唯一的
 *   高饱和冷色。冷暖一撞，它就从「氛围」变成「另一个主角」—— 尤其在树的
 *   轮廓线上，那儿正是人眼看锥体时对比最敏感的位置。换成同族暖金、亮度压到
 *   三分之一之后，它读起来是「树自己散出来的一点热气」，而不是绕着柱子跑的灯带。
 *
 * 为什么是螺旋而不是直上直下：
 *   直上直下就是一层雨，和场景里已有的飘雪打对台（雪往下、它也往下就没区别；
 *   反过来两股对流又太吵）。螺旋的轨迹自带「绕」的含义，贴着树的腰线走，
 *   视觉上像是树自己在放光，而不是屏幕前面撒了一把点。
 *
 * 为什么半径要跟着树轮廓变：
 *   固定半径的圆柱螺旋在树这种锥体旁边会「顶穿」——底部离树两米，到顶就飘在
 *   树冠外面。跟着 radiusAt 走，粒子始终贴着树皮外面一点点，才有缠绕感。
 *
 * 为什么粒子要分几条臂：
 *   单臂只有一条线在转，看久了像根亮着的弹簧。三条臂错开 120°，
 *   任何时刻都有粒子同时在左、中、右三个位置，缠绕感来自它们之间的关系。
 */

const ARMS = 3;
const TURNS = 1.45;           // 从树根到树顶绕几圈（1.45 圈刚好能看出「绕」又不至于太密）
const TOP = TREE.H + 1.6;     // 螺旋顶端：树高 9，出头 1.6，粒子会在这里散成星尘

const vert = /* glsl */`
uniform float uTime;
uniform float uSpin;
uniform float uScale;
uniform float uSize;
uniform float uPixelRatio;
uniform float uIntensity;
uniform float uBeat;
uniform float uStorm;
uniform float uHeight;
uniform vec3  uCam;

attribute float aArm;
attribute float aPhase;
attribute float aSpeed;
attribute float aSeed;
attribute float aSize;

varying float vAlpha;
varying vec3  vColor;

void main(){
  // 沿螺旋线流动：每颗自己的速度，快慢差会造成疏密不均，
  // 正好像一缕缕被带起来的气流，而不是一条匀速传送带
  float s = fract(aPhase + uTime * aSpeed);

  float t = s * uHeight;                       // 世界高度（0 .. uHeight）
  float tt = clamp(t / ${TREE.H.toFixed(1)}, 0.0, 1.2);   // 树自己的归一化高度

  // 树的锥面轮廓（和 ParticleTree 的 radiusAt 同一条曲线，去掉角度扰动 ——
  // 那点起伏在 3 个像素大的光点上看不出来，留着只是白算）
  float cone = pow(max(1.0 - tt, 0.0), 1.04);
  float tiers = 1.0 + 0.10 * sin(tt * 25.1327 + 0.55);
  // +0.32 是「离树皮多远」。0.52 时正落在锥体的轮廓线上 —— 那是人眼看
  // 锥体时对比最敏感的位置，读起来像绕着绿柱子跑的灯带；0.16 又完全陷进针叶里
  // 只剩一片糊光。0.32 刚好浮出半个身位：能看出「绕」，又不贴在轮廓上
  float r = ${TREE.R.toFixed(2)} * cone * tiers * 1.06 + 0.32;

  // 冲出树顶之后向外散开，否则顶端会收成一根光柱
  float over = smoothstep(0.90, 1.02, tt);
  r += over * (0.55 + aSeed * 1.35);

  // 螺旋角：臂偏移 + 高度带来的转角 + 树自转
  float ang = aArm * 6.28318 / ${ARMS.toFixed(1)}
            + s * ${(TURNS * Math.PI * 2).toFixed(4)}
            + uSpin;

  // 光带要有厚度，但只能薄薄一层 —— 抖到 0.22 就散成一圈雾，看不出线
  r += (aSeed - 0.5) * 0.13;

  vec3 p = vec3(cos(ang) * r, t, sin(ang) * r);

  // 风：拍手/张开那一下整条光带会被吹得外扩、抖起来
  p.xz *= 1.0 + uStorm * (0.10 + aSeed * 0.26);
  p.x += sin(uTime * 1.7 + aSeed * 37.0) * uStorm * 0.55;
  p.z += cos(uTime * 1.5 + aSeed * 29.0) * uStorm * 0.55;

  p *= uScale;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  gl_PointSize = aSize * uSize * uPixelRatio * (1.0 + uBeat * 0.30)
               / max(-mv.z, 0.1);

  // 沿高度走一道亮带：明暗在螺旋上流动，光带才像「活的」
  float flow = 0.66 + 0.44 * sin((t * 0.42 - uTime * 1.15) * 3.1416 + aSeed * 1.2);

  // 绕到树背面要暗下去。没有这条，一整圈一样亮，看得出是贴片而不是缠绕。
  // 前面 1.0 / 背后 0.22 对比要够大 —— 之前 1.0/0.52，前后一样亮，
  // 投影重叠之后就是锥面上撒了一把散点
  float facing = 0.22 + 0.78 * smoothstep(-2.8, 2.2, p.z);

  float fin = smoothstep(0.0, 0.10, s);
  float fout = 1.0 - smoothstep(0.80, 1.0, s);

  // 根部和树顶渐隐，但要留得宽 —— 权重收窄到「只在树腰」时，三条臂会在
  // 同一高度汇成一圈，看着像给树系了条金项链，而不是绕着往上走
  float belly = smoothstep(0.02, 0.24, s) * (1.0 - smoothstep(0.72, 1.0, s));
  belly = 0.40 + 0.60 * belly;

  vAlpha = uIntensity * fin * fout * belly * flow * facing * (0.70 + aSeed * 0.30);

  // 暖金，和树上那串彩灯、树顶的星、孔明灯同一族。
  // 早先是银白（冷端偏蓝），这套画面里深绿是底、暖金是点缀，银白是唯一的
  // 高饱和冷色 —— 冷暖一撞，它就从「氛围」变成了「另一个主角」。
  // 换成暖金之后它不再是外来光源，读起来是树自己散出来的一点热气。
  vColor = mix(vec3(1.00, 0.77, 0.46), vec3(1.00, 0.93, 0.76), aSeed) * (0.90 + aSeed * 0.34);
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

export class SpiralRise {
  constructor(scene, { count = 1600 } = {}) {
    const pos = new Float32Array(count * 3);      // 占位，位置全在 shader 里算
    const arm = new Float32Array(count);
    const phase = new Float32Array(count);
    const speed = new Float32Array(count);
    const seed = new Float32Array(count);
    const size = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      arm[i] = i % ARMS;
      // 起始相位均匀铺开，否则一开场所有粒子挤在底部一起往上冲
      phase[i] = Math.random();
      // 一圈 8~15 秒。太快像电梯，太慢就看不出在动
      speed[i] = 0.062 + Math.random() * 0.055;
      seed[i] = Math.random();
      size[i] = 0.55 + Math.random() * 1.05;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aArm', new THREE.BufferAttribute(arm, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSpin: { value: 0 },
        uScale: { value: 1 },
        uSize: { value: 38 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.85) },
        uIntensity: { value: 0.68 },
        uBeat: { value: 0 },
        uStorm: { value: 0 },
        uHeight: { value: TOP },
        uCam: { value: new THREE.Vector3(0, 5.3, 16.8) },
        uMap: { value: dotTexture() },
      },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);

    this._t = 0;
  }

  /**
   * @param {object} params InteractionRouter 的输出（只用到 spin / scale / beat / storm）
   * @param {THREE.Camera} camera 其实只有位置在变，但光带的背向压暗按世界 z 判，
   *   不用相机矩阵 —— 相机始终在 +z，换个角度再看就得改这里
   */
  update(dt, t, params, camera) {
    this._t = t;
    const u = this.mat.uniforms;
    u.uTime.value = t;
    u.uSpin.value = params.spin || 0;
    u.uScale.value = params.scale || 1;
    u.uBeat.value = Math.min(1.2, params.beat || 0);
    u.uStorm.value = Math.min(1, params.storm || 0);

    // 竖屏要收：世界尺寸没变，但窄幅画面里同样的 0.5 米占的屏幕比例大得多，
    // 三条光带直接亮成闪电、把树糊掉（手机上第一次跑就是这样）
    const narrow = camera ? camera.aspect < 0.95 : false;
    u.uSize.value = narrow ? 29 : 38;

    // 亮度按「它是背景，不是特效」定。这里做过三档实测（0.50 / 0.75 / 1.00），
    // 结论有点反直觉：换成暖金之后，0.85 也不会像原来银白那样抢戏 ——
    // 当初刺眼的是色相（深绿底上唯一的冷色），不是亮度。所以亮度不必压到看不见，
    // 定在 0.80 让「绕」这件事读得出来，竖屏窄幅占屏大，收一档到 0.62
    let inten = narrow ? 0.54 : 0.68;

    // 比心/暗场的时候光带跟着再弱一点：满屏爱心时它会从心形的缝里透出来
    inten *= 1 - 0.55 * Math.min(1, (params.love || 0) + (params.collapse || 0));
    u.uIntensity.value = inten;
    if (camera) u.uCam.value.copy(camera.position);
  }

  setPixelRatio(pr) {
    this.mat.uniforms.uPixelRatio.value = pr;
  }
}
