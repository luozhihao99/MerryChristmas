import * as THREE from 'three';
import {
  needleTexture,
  dotTexture,
  glowTexture,
  starTexture,
  starGlowTexture,
} from './textures.js';

export const TREE = { H: 9.0, R: 3.15 };

/** 锥形轮廓 + 分层起伏，让剪影有圣诞树特有的层叠感 */
export function radiusAt(t, angle = 0) {
  const cone = Math.pow(1 - Math.min(Math.max(t, 0), 1), 1.04);
  const tiers = 1 + 0.10 * Math.sin(t * Math.PI * 2 * 4.0 + 0.55);
  const bump = 1
    + 0.055 * Math.sin(angle * 3.0 + t * 4.2)
    + 0.028 * Math.sin(angle * 7.0 - t * 2.1);
  return TREE.R * cone * tiers * bump;
}

// 粒子数量按设备能力调整：移动端减半，既省首帧构建时间也省 GPU 上传
export const QUALITY = { needle: 26000, dust: 1500, lights: 190 };

export function configureQuality({ needle, dust, lights } = {}) {
  if (needle) QUALITY.needle = needle;
  if (dust) QUALITY.dust = dust;
  if (lights) QUALITY.lights = lights;
}

const needleVert = /* glsl */`
uniform float uTime;
uniform float uScale;
uniform float uExplode;
uniform float uSwirl;
uniform float uCollapse;
uniform float uBrightness;
uniform float uWarm;
uniform float uBeat;
uniform float uSize;
uniform float uPixelRatio;
uniform float uHeight;
uniform vec3  uLightDir;

attribute float aSize;
attribute float aSeed;
attribute vec3  aColor;
attribute float aTint;

varying vec3  vColor;
varying float vAlpha;
varying float vRot;

mat2 rot2(float a){ float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }

void main(){
  vec3 p = position;
  float hN = clamp(p.y / uHeight, 0.0, 1.0);
  float r0 = length(p.xz);

  p.x += sin(uTime * 0.70 + aSeed * 6.2831) * 0.055 * hN;
  p.z += cos(uTime * 0.63 + aSeed * 11.70) * 0.055 * hN;

  float col = uCollapse;
  p.xz *= 1.0 - 0.72 * col;
  p.y = mix(p.y, 1.05 + hN * 1.5, col * 0.70);

  float ang = uSwirl * (0.35 + 0.85 * hN) / (1.0 + r0 * 0.40);
  p.xz = rot2(ang) * p.xz;

  float burst = uExplode * (0.45 + aSeed * 1.15);
  vec3 dir = normalize(vec3(p.x, p.y * 0.30 + 0.42, p.z) + 0.001);
  p += dir * burst * 3.6;
  p.y -= burst * burst * 2.6;
  p.x += sin(aSeed * 37.0 + uTime * 2.2) * burst * 0.9;
  p.z += cos(aSeed * 23.0 + uTime * 1.9) * burst * 0.9;

  p *= uScale;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float depth = max(-mv.z, 0.1);
  gl_PointSize = aSize * uSize * uPixelRatio * (0.72 + 0.28 * uScale)
               * (1.0 + uBeat * 0.08) / depth;

  vec2 rd = normalize(p.xz + vec2(0.0001));
  vec3 n = normalize(vec3(rd.x, 0.45, rd.y));

  // 朝向镜头的补光：树会自转（空闲慢转 + 手动旋转），转到背光角度时
  // 整面会变成死黑，只剩彩灯浮在空气里 —— 必须给一层跟随相机的底光。
  // 用观察空间法线算，所以它永远作用在「此刻正对镜头的那一面」。
  vec3 vn = normalize((modelViewMatrix * vec4(n, 0.0)).xyz);
  float fillL = max(dot(vn, vec3(0.0, 0.0, 1.0)), 0.0);

  float lam = max(dot(n, normalize(uLightDir)), 0.0);
  // 底部原来只有 0.30 的顶部光，树根一带几乎是纯黑，抬到 0.44 保住体积感又不至于死。
  float topLight = mix(0.44, 1.0, pow(hN, 0.70));
  float rim = pow(1.0 - abs(dot(n, vec3(0.0, 0.0, 1.0))), 2.0);
  float lit = 0.30 + 0.78 * lam * topLight + 0.26 * fillL + 0.24 * rim * topLight;

  float fog = smoothstep(34.0, 8.0, depth);

  vec3 c = aColor * lit * uBrightness;
  c = mix(c, c * vec3(1.45, 1.12, 0.62), uWarm * aTint);
  c += vec3(0.90, 0.66, 0.26) * uBeat * (0.06 + aTint * 0.30);

  // 背面压暗：体积感的关键线索，但不能压到死黑
  // （0.32 → 0.48，深色背景下 0.32 那一侧会整片消失）
  float back = 1.0 - smoothstep(-2.4, 0.2, p.z / max(uScale, 0.001));
  c *= mix(1.0, 0.48, back);

  vColor = c;
  vAlpha = fog * (0.60 + 0.40 * aTint) * mix(1.0, 0.74, back);
  vRot = aSeed * 6.2831 + uTime * (aSeed - 0.5) * 0.35;
}
`;

const needleFrag = /* glsl */`
uniform sampler2D uMap;
uniform float uOpacity;
varying vec3  vColor;
varying float vAlpha;
varying float vRot;

void main(){
  vec2 uv = gl_PointCoord - 0.5;
  float s = sin(vRot), c = cos(vRot);
  uv = mat2(c, -s, s, c) * uv;
  float a = texture2D(uMap, uv + 0.5).a;
  if (a < 0.015) discard;
  gl_FragColor = vec4(vColor * a * vAlpha * uOpacity, 1.0);
}
`;

const dustVert = /* glsl */`
uniform float uTime;
uniform float uScale;
uniform float uExplode;
uniform float uSwirl;
uniform float uCollapse;
uniform float uBrightness;
uniform float uBeat;
uniform float uSize;
uniform float uPixelRatio;

attribute float aSize;
attribute float aSeed;
attribute vec3  aColor;

varying vec3  vColor;
varying float vAlpha;

mat2 rot2(float a){ float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }

void main(){
  vec3 p = position;
  p.y = mod(p.y - 0.6 + uTime * (0.16 + aSeed * 0.26), 11.2) - 0.6;
  p.x += sin(uTime * 0.55 + aSeed * 21.0) * 0.55;
  p.z += cos(uTime * 0.48 + aSeed * 13.0) * 0.55;

  p.xz *= 1.0 - 0.55 * uCollapse;
  p.xz = rot2(uSwirl * 0.55 / (1.0 + length(p.xz) * 0.3)) * p.xz;
  p += normalize(vec3(p.x, p.y * 0.2 + 0.3, p.z) + 0.001) * uExplode * 1.6;
  p *= uScale;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float depth = max(-mv.z, 0.1);
  gl_PointSize = aSize * uSize * uPixelRatio * (1.0 + uBeat * 0.5) / depth;

  float fog = smoothstep(34.0, 6.0, depth);
  float tw = 0.55 + 0.45 * sin(uTime * 2.0 + aSeed * 30.0);
  vColor = aColor * uBrightness * (0.40 + 0.62 * tw);
  vAlpha = fog * 0.34;
}
`;

const dustFrag = /* glsl */`
uniform sampler2D uMap;
varying vec3  vColor;
varying float vAlpha;
void main(){
  float a = texture2D(uMap, gl_PointCoord).a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}
`;

const lightVert = /* glsl */`
uniform float uTime;
uniform float uBeat;
uniform float uSeq;
uniform float uBrightness;
uniform float uScale;
uniform float uSwirl;
uniform float uCollapse;
uniform float uPixelRatio;

attribute float aSeed;
attribute vec3  aColor;
attribute float aSize;

varying vec3 vColor;

mat2 rot2(float a){ float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }

void main(){
  vec3 p = position;
  p.xz *= 1.0 - 0.72 * uCollapse;
  p.y = mix(p.y, 1.05 + (p.y / 9.0) * 1.5, uCollapse * 0.7);
  p.xz = rot2(uSwirl * (0.35 + 0.85 * clamp(p.y / 9.0, 0.0, 1.0)) / (1.0 + length(p.xz) * 0.4)) * p.xz;
  p *= uScale;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float depth = max(-mv.z, 0.1);
  gl_PointSize = aSize * uPixelRatio * (0.85 + 0.35 * uScale) * (78.0 / depth);

  float on = smoothstep(aSeed - 0.02, aSeed + 0.10, uSeq);
  float twinkle = 0.62 + 0.38 * sin(uTime * 3.1 + aSeed * 47.0);
  float chase = 0.42 + 0.58 * sin(uTime * 1.9 - aSeed * 16.0 + uBeat * 3.4);
  vColor = aColor * (0.55 + 1.35 * chase * twinkle) * uBrightness * on;
}
`;

const lightFrag = /* glsl */`
uniform sampler2D uMap;
varying vec3 vColor;
void main(){
  float a = texture2D(uMap, gl_PointCoord).a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a * 1.15, 1.0);
}
`;

export class ParticleTree {
  constructor(renderer) {
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.solid = new THREE.Group();
    this.group.add(this.solid);

    this.uniforms = {
      uTime: { value: 0 },
      uScale: { value: 1 },
      uExplode: { value: 0 },
      uSwirl: { value: 0 },
      uCollapse: { value: 0 },
      uBrightness: { value: 1 },
      uWarm: { value: 0.3 },
      uBeat: { value: 0 },
      uSeq: { value: 1 },
      uSize: { value: 92 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uHeight: { value: TREE.H },
      uLightDir: { value: new THREE.Vector3(-0.55, 0.72, 0.62).normalize() },
    };

    this._buildNeedles();
    this._buildDust();
    this._buildLights();
    this._buildBase();
    this._buildOrnaments();
    this._buildStar();
  }

  _buildNeedles() {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(QUALITY.needle * 3);
    const col = new Float32Array(QUALITY.needle * 3);
    const size = new Float32Array(QUALITY.needle);
    const seed = new Float32Array(QUALITY.needle);
    const tint = new Float32Array(QUALITY.needle);

    const palette = [
      new THREE.Color(0x0b2b1c).multiplyScalar(1.55),
      new THREE.Color(0x103a26).multiplyScalar(1.48),
      new THREE.Color(0x184c31).multiplyScalar(1.40),
      new THREE.Color(0x22603c).multiplyScalar(1.30),
      new THREE.Color(0x2f7146).multiplyScalar(1.16),
    ];
    const goldA = new THREE.Color(0xffca80).multiplyScalar(1.5);
    const goldB = new THREE.Color(0xffe2ae).multiplyScalar(1.8);
    const c = new THREE.Color();

    for (let i = 0; i < QUALITY.needle; i++) {
      const u = Math.random();
      const t = 1 - Math.pow(u, 0.62);
      const y = t * TREE.H + (Math.random() - 0.5) * 0.16;
      const a = Math.random() * Math.PI * 2;
      const rEdge = radiusAt(t, a);
      const shell = Math.pow(Math.random(), 0.34);
      const r = rEdge * (0.54 + 0.46 * shell);

      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(a) * r;

      const sparkle = Math.random() < 0.03;
      if (sparkle) {
        c.copy(goldA).lerp(goldB, Math.random());
        tint[i] = 1.0;
        size[i] = 0.9 + Math.random() * 1.4;
      } else {
        const k = Math.min(palette.length - 1, Math.floor(Math.pow(Math.random(), 0.8) * palette.length));
        c.copy(palette[k]);
        c.multiplyScalar(0.78 + Math.random() * 0.5);
        tint[i] = Math.random() * 0.22;
        const big = Math.random() < 0.12;
        size[i] = big ? 2.1 + Math.random() * 1.3 : 0.85 + Math.random() * 1.05;
      }

      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      seed[i] = Math.random();
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));

    this.needleMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.uniforms,
        uMap: { value: needleTexture() },
        uOpacity: { value: 0.72 },
      },
      vertexShader: needleVert,
      fragmentShader: needleFrag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    this.needles = new THREE.Points(geo, this.needleMat);
    this.needles.frustumCulled = false;
    this.group.add(this.needles);
  }

  _buildDust() {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(QUALITY.dust * 3);
    const col = new Float32Array(QUALITY.dust * 3);
    const size = new Float32Array(QUALITY.dust);
    const seed = new Float32Array(QUALITY.dust);

    const warm = new THREE.Color(0xffdca8).multiplyScalar(0.75);
    const pale = new THREE.Color(0xcfe8d8).multiplyScalar(0.6);
    const c = new THREE.Color();

    for (let i = 0; i < QUALITY.dust; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 1.6 + Math.pow(Math.random(), 0.7) * 4.0;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = Math.random() * 11.0;
      pos[i * 3 + 2] = Math.sin(a) * r;

      c.copy(Math.random() < 0.42 ? warm : pale);
      c.multiplyScalar(0.5 + Math.random() * 0.6);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;

      size[i] = 0.42 + Math.random() * 0.95;
      seed[i] = Math.random();
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    this.dustMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.uniforms,
        uMap: { value: dotTexture() },
      },
      vertexShader: dustVert,
      fragmentShader: dustFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.dust = new THREE.Points(geo, this.dustMat);
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  _buildLights() {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(QUALITY.lights * 3);
    const col = new Float32Array(QUALITY.lights * 3);
    const size = new Float32Array(QUALITY.lights);
    const seed = new Float32Array(QUALITY.lights);

    const colors = [
      new THREE.Color(0xffd9a0).multiplyScalar(3.4),
      new THREE.Color(0xffb066).multiplyScalar(3.2),
      new THREE.Color(0xff7a6a).multiplyScalar(3.0),
      new THREE.Color(0xfff2d0).multiplyScalar(3.6),
      new THREE.Color(0x9fe0ff).multiplyScalar(2.4),
    ];

    const turns = 7.2;
    for (let i = 0; i < QUALITY.lights; i++) {
      const t = i / (QUALITY.lights - 1);
      // 沿树体螺旋上升，越往上越密
      const y = 0.55 + t * (TREE.H - 1.15);
      const tt = y / TREE.H;
      const a = t * Math.PI * 2 * turns;
      const r = radiusAt(tt, a) * 1.02 + 0.05;

      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(a) * r;

      const c = colors[i % colors.length];
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;

      size[i] = 1.5 + Math.random() * 1.1;
      seed[i] = t;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    this.lightMat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.uniforms,
        uMap: { value: glowTexture() },
      },
      vertexShader: lightVert,
      fragmentShader: lightFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.lights = new THREE.Points(geo, this.lightMat);
    this.lights.frustumCulled = false;
    this.group.add(this.lights);
  }

  /** 低多边形树体：轮廓跟随分层起伏，始终藏在粒子壳内侧 */
  _buildBase() {
    const pts = [];
    for (let i = 0; i <= 56; i++) {
      const t = i / 56;
      pts.push(new THREE.Vector2(Math.max(0.015, radiusAt(t) * 0.84), t * TREE.H));
    }
    const geo = new THREE.LatheGeometry(pts, 72);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0d2517,
      roughness: 0.94,
      metalness: 0.0,
      side: THREE.DoubleSide,
      // 内壳给一点自发光：它是挡住背面粒子的「实心体」，
      // 完全没有灯的角度下如果纯黑，树会像被挖掉一块。只给极暗的绿，不抢针叶。
      emissive: 0x08190f,
      emissiveIntensity: 1.0,
    });
    this.cone = new THREE.Mesh(geo, mat);
    this.solid.add(this.cone);

    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.42, 0.7, 16),
      new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.9 })
    );
    trunk.position.y = 0.2;
    this.solid.add(trunk);
  }

  _buildOrnaments() {
    const count = 30;
    const geo = new THREE.SphereGeometry(1, 18, 14);
    const mat = new THREE.MeshStandardMaterial({
      metalness: 0.86,
      roughness: 0.22,
      emissive: 0x120800,
      emissiveIntensity: 0.4,
    });
    this.ornamentMat = mat;

    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const dummy = new THREE.Object3D();
    const colors = [
      new THREE.Color(0xb3202f),
      new THREE.Color(0xc8a02e),
      new THREE.Color(0xd8d0c0),
      new THREE.Color(0x2f6b46),
      new THREE.Color(0x8e1f4a),
    ];

    for (let i = 0; i < count; i++) {
      const t = 0.10 + Math.random() * 0.82;
      const y = t * TREE.H;
      const a = Math.random() * Math.PI * 2;
      const r = radiusAt(t, a) * 0.97 + 0.04;
      const s = 0.13 + Math.random() * 0.09;

      dummy.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      dummy.scale.setScalar(s);
      dummy.rotation.set(Math.random(), Math.random(), Math.random());
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, colors[i % colors.length]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.solid.add(mesh);
    this.ornaments = mesh;
  }

  _buildStar() {
    // 星体：不透明混合，保留切面明暗，像一枚实体金属星
    const bodyMat = new THREE.SpriteMaterial({
      map: starTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.starMat = bodyMat;
    this.star = new THREE.Sprite(bodyMat);
    this.star.position.set(0, TREE.H + 0.52, 0);
    this.star.scale.setScalar(2.05);
    this.star.renderOrder = 3;
    this.solid.add(this.star);

    // 辉光：加法混合的独立一层，负责发光和 Bloom 的引子
    const glowMat = new THREE.SpriteMaterial({
      map: starGlowTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.5,
    });
    this.starGlowMat = glowMat;
    this.starGlow = new THREE.Sprite(glowMat);
    this.starGlow.position.copy(this.star.position);
    this.starGlow.scale.setScalar(2.75);
    this.starGlow.renderOrder = 2;
    this.solid.add(this.starGlow);

    const glow = new THREE.PointLight(0xffc978, 18, 15, 2);
    glow.position.set(0, TREE.H + 0.1, 0);
    this.starLight = glow;
    this.solid.add(glow);
  }

  update(t, params) {
    const u = this.uniforms;
    u.uTime.value = t;
    u.uBrightness.value = params.brightness;
    u.uBeat.value = params.beat;
    u.uExplode.value = params.explode;
    u.uSwirl.value = params.swirl;
    u.uCollapse.value = params.collapse;
    u.uWarm.value = params.warm;
    u.uScale.value = params.scale;
    u.uSeq.value = params.seq;

    this.solid.scale.setScalar(params.scale);
    this.needleMat.uniforms.uOpacity.value = 0.72 - params.collapse * 0.2;

    // 侧掌扇风：整棵树绕自身中轴转，像被一阵风卷着打旋。
    // 角度由 InteractionRouter 累积（含惯性衰减），这里直接用，不再二次平滑。
    this.group.rotation.y = params.spin || 0;

    // 星星：只做极缓的摇摆和亮度呼吸，避免快速旋转/闪烁
    this.starMat.rotation = Math.sin(t * 0.28) * 0.05;
    this.starGlowMat.rotation = -Math.sin(t * 0.21) * 0.035;
    const twinkle = 0.965 + 0.035 * Math.sin(t * 1.15) + 0.015 * Math.sin(t * 2.7 + 1.1);
    const starScale = 2.05 * (1 + params.beat * 0.10) * (1 + params.explode * 0.16);
    this.star.scale.setScalar(starScale);
    this.starMat.opacity = Math.min(1, 0.92 * twinkle + params.beat * 0.08);
    this.starGlow.scale.setScalar(2.75 * (1 + params.beat * 0.20) * (1 + params.explode * 0.22));
    this.starGlowMat.opacity = Math.min(1, 0.42 * twinkle + params.beat * 0.26);
    this.starLight.intensity = 14 + params.beat * 26;

    this.ornamentMat.emissiveIntensity = 0.25 + params.high * 1.5 + params.beat * 0.5;
  }

  setPixelRatio(r) {
    this.uniforms.uPixelRatio.value = r;
  }
}
