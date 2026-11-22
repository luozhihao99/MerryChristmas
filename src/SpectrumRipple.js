import * as THREE from 'three';

/**
 * 树底频谱水波纹 —— 平铺在地面上的频谱环 + 鼓点涟漪：
 *
 *   ① 频谱环两层：外圈每个角度的「外扩量」由频谱驱动，内圈是更淡更矮的
 *      同款倒影层，两圈叠出「水面」的层次。频谱 64 点按左右对称铺
 *      （|θ| 相同的角度取同一个频点），画面永远是轴对称的。
 *      整层都要「淡」：亮度压在 0.55 档，只是地面上一层微光，不抢树。
 *
 *   ② 鼓点涟漪：每次鼓点（beat.hit）从内圈向外扩出一道圆环，
 *      越扩越大越扩越淡，像石头丢进水里的涟漪。同时最多 3 道，循环复用。
 *      只跟真音乐走：没有频谱（没放歌 / 暂停 / 跨域读不到）就不触发。
 *
 *   ③ 整层有总开关 uMaster：有音乐时 ~2 秒淡入，音乐暂停后 ~3 秒淡淡消失，
 *      不是常驻的。无音乐时不做假波，安静地退场。
 *
 * 全 GPU：频谱走 uniform 数组（64 float，每帧 CPU 写一次小数组），
 * 涟漪只写 3 个起始时间 uniform，粒子位置全在顶点着色器算。
 */

const SEG = 260;          // 每层频谱环的角度采样数（整圈）
const RIPPLES = 3;        // 同时存在的涟漪数
const RIPPLE_PTS = 260;   // 每道涟漪的圆周点数（外圈周长更长，点要够密才不断线）
const RIPPLE_LIFE = 2.6;  // 涟漪寿命（秒）
const RING_R = 4.55;      // 外圈频谱环的基础半径（在光池峰值圈外一点，不被树挡）
const RING_IN = 3.45;     // 内圈（倒影层）半径
const RING_AMP = 1.35;    // 外圈频谱满格时的外扩幅度（世界单位）
const RING_AMP_IN = 0.7;  // 内圈幅度：更矮，只是陪衬
const RIPPLE_R0 = 3.1;    // 涟漪起始半径
const RIPPLE_SPD = 2.1;   // 涟漪扩散速度（世界单位/秒）

const vert = /* glsl */`
uniform float uTime, uProj, uMaster;
uniform float uSpec[64];
uniform float uRippleStart[3];
uniform float uRipplePow[3];
attribute float aTheta;   // 频谱环：角度 -PI..PI（0 = 正对镜头）；涟漪：unused
attribute float aU;       // 涟漪：圆周 0..1；频谱环：unused
attribute float aRing;    // 涟漪：0..2；频谱环：-1 外圈 / -2 内圈
varying float vS;
varying float vA;

void main() {
  // ---------- 频谱环（外圈 -1，内圈倒影层 -2）----------
  if (aRing < -0.5) {
    float inner = aRing < -1.5 ? 1.0 : 0.0;
    // 左右对称：|θ| 相同 → 同一个频点。0..63 覆盖半个圆
    float f = abs(aTheta) / 3.14159265 * 63.0;
    float i0 = floor(f);
    float i1 = min(i0 + 1.0, 63.0);
    float s = mix(uSpec[int(i0)], uSpec[int(i1)], f - i0);
    vS = s;

    float r = mix(${RING_R.toFixed(2)}, ${RING_IN.toFixed(2)}, inner)
            + s * mix(${RING_AMP.toFixed(2)}, ${RING_AMP_IN.toFixed(2)}, inner);
    vec3 p = vec3(sin(aTheta) * r, 0.10 + s * 0.13, cos(aTheta) * r);

    // 淡但不隐身：外圈 0.62 档、内圈倒影 0.38 档（0.4/0.22 那版太淡看不见了）
    float base = mix(0.62, 0.38, inner);
    vA = (base + 0.30 * cos(aTheta * 0.5)) * uMaster;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    // 点径必须大于周长/SEG 的点间距，否则连不起来、看着像一串珠子
    gl_PointSize = (0.14 + 0.12 * s) * uProj / max(-mv.z, 0.1);
    return;
  }

  // ---------- 鼓点涟漪 ----------
  int k = int(aRing + 0.5);
  float age = uTime - uRippleStart[k];
  if (age < 0.0 || age > ${RIPPLE_LIFE.toFixed(2)}) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vS = 0.0; vA = 0.0;
    return;
  }
  float r = ${RIPPLE_R0.toFixed(2)} + age * ${RIPPLE_SPD.toFixed(2)};
  float th = aU * 6.28318530;
  vec3 p = vec3(sin(th) * r, 0.08, cos(th) * r);
  vS = 0.0;
  vA = pow(1.0 - age / ${RIPPLE_LIFE.toFixed(2)}, 1.7) * uRipplePow[k] * uMaster * 0.75;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = 0.15 * uProj / max(-mv.z, 0.1);
}
`;

const frag = /* glsl */`
varying float vS;
varying float vA;
void main() {
  if (vA <= 0.004) discard;
  // 圆形软边遮罩必须写成正序 smoothstep（倒写是未定义行为，会渲染成方块）
  vec2 d = gl_PointCoord - 0.5;
  float m = 1.0 - smoothstep(0.10, 0.5, length(d));
  // 淡淡的暖金：能量高时也只是亮一点点，不往白里冲
  vec3 col = mix(vec3(0.70, 0.50, 0.30), vec3(1.15, 0.88, 0.52), clamp(vS, 0.0, 1.0));
  gl_FragColor = vec4(col * (0.75 + 0.40 * vS), m * vA);
}
`;

export class SpectrumRipple {
  constructor(scene) {
    const N = SEG * 2 + RIPPLES * RIPPLE_PTS;
    const theta = new Float32Array(N);
    const u = new Float32Array(N);
    const ring = new Float32Array(N);
    const pos = new Float32Array(N * 3); // 占位，真实位置全在着色器里算

    let i = 0;
    for (; i < SEG; i++) {
      // 外圈：整圈均匀采样，θ=-PI..PI；中心留空避开树干
      theta[i] = (i / SEG) * Math.PI * 2 - Math.PI;
      ring[i] = -1;
    }
    for (; i < SEG * 2; i++) {
      // 内圈倒影层：错开半个采样步，两层点不会重合成一条线
      theta[i] = ((i - SEG + 0.5) / SEG) * Math.PI * 2 - Math.PI;
      ring[i] = -2;
    }
    for (; i < N; i++) {
      const k = (i - SEG * 2) % RIPPLES;
      u[i] = (i - SEG * 2) / RIPPLE_PTS;
      ring[i] = k;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aTheta', new THREE.BufferAttribute(theta, 1));
    geo.setAttribute('aU', new THREE.BufferAttribute(u, 1));
    geo.setAttribute('aRing', new THREE.BufferAttribute(ring, 1));

    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uTime: { value: 0 },
        uProj: { value: 900 },
        uMaster: { value: 0 },   // 总开关：0 = 完全隐去（没音乐）
        uSpec: { value: new Float32Array(64) },
        uRippleStart: { value: [-99, -99, -99] },
        uRipplePow: { value: [0, 0, 0] },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);

    this.slot = 0;
    this.master = 0;
  }

  setViewport(camera, viewH, pixelRatio) {
    const hPx = viewH * pixelRatio;
    this.mat.uniforms.uProj.value = (hPx * 0.5) / Math.tan((camera.fov * Math.PI) / 360);
  }

  /**
   * @param t      主时钟 elapsedTime
   * @param spec   Float32Array(64) 0..1；null = 没在放音乐（整层淡淡退场）
   * @param beat   BeatDetector 的返回 { pulse, hit, bpm }
   * @param dt     本帧步长（秒），做淡入淡出的指数平滑
   */
  update(t, spec, beat, dt = 0.016) {
    const u = this.mat.uniforms;
    u.uTime.value = t;

    // 总开关：有频谱 ~1.2s 淡入，没有 ~3s 淡淡消失（音乐暂停 / 没放歌都走这条）
    const on = !!(spec && spec.length === 64);
    const k = on ? 1 - Math.exp(-dt * 2.6) : 1 - Math.exp(-dt * 0.9);
    this.master += ((on ? 1 : 0) - this.master) * k;
    if (this.master < 0.001) this.master = 0;
    u.uMaster.value = this.master;

    if (on) {
      // 抹平到 0.9 高度的能量条，顺手压掉采样毛刺
      const arr = u.uSpec.value;
      for (let j = 0; j < 64; j++) arr[j] = Math.min(1, spec[j] * 0.9);
    }

    // 涟漪只跟真音乐走：待机的假鼓点不再让它常驻树底
    if (on && beat && beat.hit) {
      const j = this.slot;
      this.slot = (this.slot + 1) % RIPPLES;
      u.uRippleStart.value[j] = t;
      u.uRipplePow.value[j] = 0.55 + 0.45 * Math.min(1, beat.pulse);
    }
  }
}
