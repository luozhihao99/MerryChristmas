import * as THREE from 'three';

/**
 * 点击烟花 —— 把 OK 那段里的「烟花炸开」单独抽出来：点一下屏幕，
 * 在点击位置炸一小蓬彩色粒子，随风散掉。桌面鼠标点击、手机点按都算。
 *
 * **多朵同放**：池子按槽位切 4 份，每份 460 粒、各有独立的时间轴
 * （uStart[slot]）和尺寸（uSize[slot]）。点一下占一个槽，转着用；
 * 四朵同时在空中互不打架。同一个槽再点只是「这一朵重放」。
 *
 * 全 GPU：trigger() 只写爆心和方向两组 attribute + 两个 uniform，
 * 之后每帧只推进一个 uTime，CPU 零逐帧开销。
 *
 * 位置由 main.js 换算：屏幕点击 → 视线方向 → 与树前方 z=3.2 平面的交点
 * （树在 z=0，烟花炸在树前面一点，不会被树身吃掉亮度）。
 */

const COUNT = 460;      // 单朵粒子数
const SLOTS = 4;        // 同时可放的朵数
const LIFE = 2.1;       // 单朵寿命（秒）：0.55 炸开 + 1.5 飘落淡出
const GRAVITY = 1.05;   // 比 MissYou 的 1.45 小一点：点击烟花要「飘」着落，不要砸下来
const RADIUS = 2.1;     // 炸开半径（世界单位）—— 大一点，中心密度低才不会糊成一团白

// 与 MissYou 同一套暖金色板，画面里不会跳出另一种颜色语言
const FIRE = [0xfff3d8, 0xffdca8, 0xe6f2ff, 0xffc98a];

const vert = /* glsl */`
uniform float uTime, uPixelRatio;
uniform float uStart[${SLOTS}];
uniform float uSize[${SLOTS}];
attribute vec3 aOrigin;
attribute vec3 aDir;
attribute vec3 aColor;
attribute float aSeed;
attribute float aSlot;
varying vec3 vColor;
varying float vFade;

void main() {
  int s = int(aSlot + 0.5);
  float age = uTime - uStart[s];
  if (age < 0.0 || age > ${LIFE.toFixed(2)}) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0); vFade = 0.0;
    return;
  }
  // 爆开：exp 衰减 —— 先猛地炸开，随后几乎停住（空气阻力），和 OK 烟花同款手感。
  // r0 给每粒一个初始半径：age=0 时如果全部堆在爆心一个点上，
  // 460 粒加色混合会糊成一团白光；开局就该是一颗小球壳，而不是一个点
  float boom = max(age - 0.05, 0.0);
  float r0 = 0.14 + 0.26 * aSeed;
  float rr = r0 + (1.0 - exp(-boom * 2.6)) * ${RADIUS.toFixed(2)} * (0.62 + 0.42 * aSeed);
  vec3 p = aOrigin + aDir * rr;
  p.y -= ${GRAVITY.toFixed(2)} * boom * boom;
  p.x += sin(boom * 1.9 + aSeed * 33.0) * 0.09 * boom;
  p.z += cos(boom * 1.7 + aSeed * 21.0) * 0.07 * boom;

  // 头 6% 亮度顶格（爆闪），之后按 1.5 次幂淡出 —— 二次方太急，花还没落就没了
  float k = age / ${LIFE.toFixed(2)};
  vFade = pow(1.0 - k, 1.5);
  vColor = aColor;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (0.5 + 0.55 * aSeed) * uSize[s] * uPixelRatio / max(-mv.z, 0.1);
}
`;

const frag = /* glsl */`
varying vec3 vColor;
varying float vFade;
void main() {
  if (vFade <= 0.003) discard;
  // 圆形软边遮罩必须写成正序 smoothstep（倒写是未定义行为，会渲染成方块）
  vec2 d = gl_PointCoord - 0.5;
  float m = (1.0 - smoothstep(0.08, 0.5, length(d))) * 0.8;
  // 加色混合下要超额亮度才顶得出来；淡出时顺带收一点颜色，避免留下灰雾
  gl_FragColor = vec4(vColor * (0.9 + 0.7 * vFade), m * vFade);
}
`;

const _c = new THREE.Color();

export class ClickBurst {
  constructor(scene) {
    const N = COUNT * SLOTS;
    const pos = new Float32Array(N * 3);       // 占位（真实位置全在 aOrigin）
    const origin = new Float32Array(N * 3);
    const dir = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    const slot = new Float32Array(N);

    for (let i = 0; i < N; i++) {
      seed[i] = Math.random();
      slot[i] = (i / COUNT) | 0;               // 每 COUNT 粒一个槽
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aOrigin', new THREE.BufferAttribute(origin, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));

    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uStart: { value: new Array(SLOTS).fill(-99) },
        uSize: { value: new Array(SLOTS).fill(82) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 12;
    this.points.visible = true;
    scene.add(this.points);

    this.geo = geo;
    this.origin = origin;
    this.dir = dir;
    this.col = col;
    this.slot = 0;
    this.time = 0;
  }

  setPixelRatio(pr) { this.mat.uniforms.uPixelRatio.value = pr; }

  /** 世界坐标爆一朵。time 用主循环的 clock.elapsedTime，和别的模块同一时钟 */
  trigger(pos, time, scale = 1) {
    const s = this.slot;
    this.slot = (this.slot + 1) % SLOTS;
    this.mat.uniforms.uStart.value[s] = time;
    this.mat.uniforms.uSize.value[s] = 82 * scale;
    const base = s * COUNT;
    for (let i = 0; i < COUNT; i++) {
      const j = (base + i) * 3;
      this.origin[j] = pos.x;
      this.origin[j + 1] = pos.y;
      this.origin[j + 2] = pos.z;
      // 球面均匀分布（z 均匀取、半径 sqrt 修正），再撒一点随机抖动
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.max(0, 1 - u * u));
      this.dir[j] = Math.cos(th) * rr;
      this.dir[j + 1] = u;
      this.dir[j + 2] = Math.sin(th) * rr;
      _c.setHex(FIRE[(Math.random() * FIRE.length) | 0]).multiplyScalar(1.65 + Math.random() * 0.8);
      this.col[j] = _c.r; this.col[j + 1] = _c.g; this.col[j + 2] = _c.b;
    }
    this.geo.attributes.aOrigin.needsUpdate = true;
    this.geo.attributes.aDir.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
  }

  update(t) {
    this.time = t;
    this.mat.uniforms.uTime.value = t;
  }
}
