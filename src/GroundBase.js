import * as THREE from 'three';
import {
  warmPoolTexture,
  canopySpillTexture,
  contactShadowTexture,
  dotTexture,
} from './textures.js';

/**
 * 树的「底座」四件事，各管一件事：
 *
 *   1. 暖光池    —— 贴地的加色光晕：告诉眼睛「地面在这儿，而且被树上的灯照亮了」
 *   2. 绿色回光  —— 冷绿的一圈：告诉眼睛「亮的是那棵绿树」（冷暖交界才有体积）
 *   3. 地灯      —— 三盏真实 PointLight：地面的明暗靠它算，礼物盒的侧面也被它照亮
 *   4. 星云 + 雾 —— 给底座厚度。贴片永远是一张纸，粒子和光雾浮起来才「托」得住树
 *
 * 另外还负责雪地上的投影（见 groundShadow）：礼物堆摆好之后由 main.js 调
 * addGiftShadow()。它必须画在两层加色光之后（renderOrder 3 > 1），否则光会把
 * 影子吃掉，盒子又浮起来。
 *
 * 之前树底是空的：只有一块近乎全黑的地面 + 一张半径 8.5 的绿色光贴片。
 * 礼物盒的位置其实是对的（y 正好是半个盒高，贴地），但看起来全在飘 ——
 * 因为地面上没有任何明暗关系：既没有被照亮的区域，也没有盒子压住光的痕迹。
 * 「站在地上」这件事靠的是它和地面的**接触关系**，不是它自身的阴影。
 */

/** 星云粒子的活动范围：树根外围到礼物堆之外，正好把整棵树「托」在一个盘子里 */
const R_IN = 1.05;
const R_OUT = 6.2;

const nebulaVert = /* glsl */`
uniform float uTime;
uniform float uPixelRatio;
uniform float uSize;
uniform float uIntensity;
uniform float uBeat;

attribute float aRadius;
attribute float aAngle;
attribute float aY;
attribute float aSeed;
attribute float aSize;
attribute float aSpeed;

varying float vAlpha;
varying vec3  vColor;

void main(){
  // 地面自己的气流：绕中轴慢转，和树的自转（uSpin）无关 ——
  // 跟着树一起转会让人觉得整块地板在转，那不是「承托」，是「转盘」。
  float ang = aAngle + uTime * aSpeed * 0.085;

  // 缓慢上浮、到顶淡出、从地面补回来。用 fract 循环，不需要 JS 侧回收。
  // 上浮幅度按 seed 拉开（0.35~1.35），高低错落才有厚度，整齐一层就是水面。
  float y = fract(aY + uTime * aSpeed * 0.052);
  float h = y * (0.26 + aSeed * 0.86);

  // 半径轻微呼吸：完全静止的圆环看起来像印在地板上的花纹
  float r = aRadius * (1.0 + 0.028 * sin(uTime * 0.31 + aSeed * 6.2831));

  vec3 p = vec3(cos(ang) * r, h, sin(ang) * r);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uSize * uPixelRatio * (1.0 + uBeat * 0.22) / max(-mv.z, 0.1);

  // 两端渐隐：底部刚「生出来」和顶部快要消失时都不该是硬切
  float rise = smoothstep(0.0, 0.20, y) * (1.0 - smoothstep(0.55, 1.0, y));

  // 树根正下方留白：那儿被树干和针叶挡着，粒子钻进去只会糊成一团白
  float inner = smoothstep(R_IN_GLSL, R_IN_GLSL + 0.85, r);
  // 外缘散掉，别在礼物堆外面留一条清晰的边
  float outer = 1.0 - smoothstep(R_OUT_GLSL - 1.6, R_OUT_GLSL + 0.4, r);

  float tw = 0.55 + 0.45 * sin(uTime * 1.55 + aSeed * 41.0);

  vAlpha = uIntensity * rise * inner * outer * (0.42 + 0.58 * tw);

  // 暖金 → 青绿：底座要同时交代「暖灯」和「绿树」两种光，
  // 全暖会像篝火余烬，全绿又会和树的针叶糊在一起
  vColor = mix(vec3(1.00, 0.80, 0.52), vec3(0.60, 0.94, 0.78), aSeed)
         * (0.78 + aSeed * 0.44);
}
`;

const nebulaFrag = /* glsl */`
uniform sampler2D uMap;
varying float vAlpha;
varying vec3  vColor;

void main(){
  float a = texture2D(uMap, gl_PointCoord).a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}
`;

const hazeVert = /* glsl */`
uniform float uTime;
uniform float uProj;
uniform float uIntensity;
uniform float uBeat;
uniform float uLove;

attribute float aRadius;
attribute float aAngle;
attribute float aY;
attribute float aSeed;
attribute float aSize;
attribute float aSpeed;

varying float vAlpha;
varying vec3  vColor;

void main(){
  // 雾几乎不转：地雾是「停在那儿被照亮」的，转起来就成漩涡了
  float ang = aAngle + uTime * aSpeed * 0.032;
  float r = aRadius * (1.0 + 0.05 * sin(uTime * 0.19 + aSeed * 6.2831));
  float y = aY + sin(uTime * 0.27 + aSeed * 9.0) * 0.11;
  vec3 p = vec3(cos(ang) * r, y, sin(ang) * r);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // 用世界尺寸投影（uProj 是焦距），所以换屏幕、换像素比都不会变大变小
  gl_PointSize = aSize * uProj / max(-mv.z, 0.1);

  // 靠树根的一圈最浓（光源在那儿），外圈散掉；正下方留白，那儿被树干挡着
  float inner = smoothstep(0.7, 1.75, r);
  float outer = 1.0 - smoothstep(3.7, 5.6, r);
  float breathe = 0.62 + 0.38 * sin(uTime * 0.21 + aSeed * 8.0);

  vAlpha = uIntensity * 0.042 * inner * outer * breathe * (0.6 + aSeed * 0.7);
  // 暖金偏多、少量青绿：雾是被树上的灯照亮的，主色只能是灯的颜色
  vColor = mix(vec3(1.00, 0.86, 0.64), vec3(0.68, 0.94, 0.80), aSeed * 0.75);
}
`;

const hazeFrag = /* glsl */`
uniform sampler2D uMap;
varying float vAlpha;
varying vec3  vColor;

void main(){
  float a = texture2D(uMap, gl_PointCoord).a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}
`;

// 着色器里直接写常量，省得每帧传 uniform（这两个值不会变）
const NEBULA_VERT = nebulaVert
  .replace(/R_IN_GLSL/g, R_IN.toFixed(2))
  .replace(/R_OUT_GLSL/g, R_OUT.toFixed(2));

let shadowGeo = null;
let shadowMat = null;

/**
 * 给「站在雪地上的一摞礼物」画投影。
 *
 * 第一版做的是贴在盒底的一圈接触阴影，结果几乎看不出来 —— 原因有二：
 *   1. 圈只比盒底大一圈，1440 宽的画面上就是七八个像素，等于没画；
 *   2. 更糟的是盒底那块立面被地灯照亮了，比地面还亮。亮底面 + 无暗接缝，
 *      眼睛唯一的结论就是「悬空」。
 * 所以改成真正的**投影**：光的来源是树脚那一圈灯，方向固定由内向外，
 * 阴影就往背离树心的方向拉长（1.55 : 1.15 的椭圆），并且随距离变软。
 * 影子落在盒子外侧那片看得见的地面上，才是「这个盒子挡住了光」的证据。
 *
 * @param {number} x 礼物在世界坐标里的位置（雪地是平的，y 不用管）
 * @param {number} z
 * @param {number} size 盒子的边长
 */
function groundShadow(x, z, size) {
  if (!shadowGeo) shadowGeo = new THREE.CircleGeometry(1, 28);
  if (!shadowMat) {
    shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: contactShadowTexture(),
      transparent: true,
      depthWrite: false,
      // 普通混合的黑色 = 把底下（包括已经加过色的地台光）乘暗。
      // 加色混合做不到这一点：加再少也只会更亮。
      blending: THREE.NormalBlending,
      opacity: 0.92,
    });
  }

  const len = Math.hypot(x, z) || 1;
  const dx = x / len;
  const dz = z / len;

  const m = new THREE.Mesh(shadowGeo, shadowMat);
  // 先把圆放平（局部 x→世界 x，局部 y→世界 -z），再在平面内转到背离树心的方向
  m.rotation.set(-Math.PI / 2, 0, Math.atan2(-dz, dx));
  // 局部 y 是短轴（盒子本身占的宽度），局部 x 是长轴（影子被拉出去的方向）
  m.scale.set(size * 1.58, size * 1.34, 1);
  // 影子中心往盒子外侧挪半个身位：灯在树心那一侧，影子必然偏在背面
  m.position.set(x + dx * size * 0.30, 0.018, z + dz * size * 0.30);
  // 必须排在两层加色光之后，否则光会盖住影子，盒子又浮起来
  m.renderOrder = 3;
  return m;
}

export class GroundBase {
  constructor(scene, { count = 860 } = {}) {
    this.group = new THREE.Group();
    scene.add(this.group);

    this._buildBaseLights();
    this._buildPool();
    this._buildSpill();
    this._buildNebula(count);
    this._buildHaze(Math.max(28, Math.round(count * 0.06)));
  }

  /**
   * 贴近地面的三盏暖色点光。
   *
   * 只靠加色的光池贴片是不够的 —— 那东西是一张没有法线的图，从低角度看永远
   * 是一条横向的雾带，看着「地上蒙了一层光」，而不是「雪被照亮了」。真正的
   * 明暗来自漫反射：同一块地面上，朝向灯的部分亮、背光的部分暗。所以这里补
   * 三盏真实的 PointLight（衰减 2 次方，距离 10），地面的 roughness 会自己算
   * 出从树根往外那道柔和的衰减，礼物盒的侧面和底面也会被染上一点暖色 ——
   * 这才是「站在一个亮着的地台上」而不是「贴在一张亮图上」。
   *
   * 强度不能大：地面材质很暗（夜间雪地），灯一亮就成聚光灯下的舞台。
   * 三盏错开 120°，是因为一盏会在雪面上压出一个方向明确的亮斑；
   * 三盏叠起来，树脚四周才是一圈均匀的、看不出「灯在哪」的光。
   */
  _buildBaseLights() {
    this.baseLights = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      // three 现在按物理量走（intensity = 坎德拉），1 这个量级完全看不见 ——
      // 照度 = intensity / 距离²，离灯 2.5 米处想拿到 0.2 左右，得给到十几。
      // 12 配地面反照率 0x1c2632，树脚刚好是「被灯照亮的雪」那个亮度；
      // 试过 34，整条底边会白成一片，礼物盒的顶面直接过曝。
      const l = new THREE.PointLight(0xffd0a2, 12, 11, 2);
      l.position.set(Math.cos(a) * 1.9, 0.62, Math.sin(a) * 1.9);
      this.group.add(l);
      this.baseLights.push(l);
    }
  }

  /** 贴地暖光池：地台的「亮」，也是礼物盒脚下那片被照亮的地面 */
  _buildPool() {
    const geo = new THREE.PlaneGeometry(8.6, 8.6);
    geo.rotateX(-Math.PI / 2);
    this.poolMat = new THREE.MeshBasicMaterial({
      map: warmPoolTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.pool = new THREE.Mesh(geo, this.poolMat);
    this.pool.position.y = 0.014;
    this.pool.renderOrder = 1;
    this.group.add(this.pool);
  }

  /** 树冠洒下来的一圈冷绿回光，中心留空（那儿照理晒不到） */
  _buildSpill() {
    const geo = new THREE.PlaneGeometry(18, 18);
    geo.rotateX(-Math.PI / 2);
    this.spillMat = new THREE.MeshBasicMaterial({
      map: canopySpillTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.spill = new THREE.Mesh(geo, this.spillMat);
    this.spill.position.y = 0.012;
    this.spill.renderOrder = 1;
    this.group.add(this.spill);
  }

  _buildNebula(count) {
    const pos = new Float32Array(count * 3);   // 占位，真实位置全在着色器里算
    const radius = new Float32Array(count);
    const angle = new Float32Array(count);
    const y0 = new Float32Array(count);
    const seed = new Float32Array(count);
    const size = new Float32Array(count);
    const speed = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      // 幂次 0.62：靠近树根一段更密（那儿正是要「托」的地方），外缘自然变稀
      const k = Math.pow(Math.random(), 0.62);
      radius[i] = R_IN + k * (R_OUT - R_IN);
      angle[i] = Math.random() * Math.PI * 2;
      y0[i] = Math.random();
      seed[i] = Math.random();
      // 大颗粒少、小颗粒多：全都一样大就成了萤火虫群
      size[i] = 0.45 + Math.pow(Math.random(), 2.2) * 2.1;
      speed[i] = 0.55 + Math.random() * 0.95;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1));
    geo.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
    geo.setAttribute('aY', new THREE.BufferAttribute(y0, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));

    this.nebulaMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.85) },
        uSize: { value: 60 },
        uIntensity: { value: 1 },
        uBeat: { value: 0 },
        uMap: { value: dotTexture() },
      },
      vertexShader: NEBULA_VERT,
      fragmentShader: nebulaFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.nebula = new THREE.Points(geo, this.nebulaMat);
    this.nebula.frustumCulled = false;
    this.nebula.renderOrder = 4;
    this.group.add(this.nebula);
  }

  /**
   * 贴地的薄雾：几十团「大而极淡」的柔光，浮在雪面 0.1~1.1 米之间。
   *
   * 星云粒子（上面那层）给的是「有声有色的细碎颗粒」，但颗粒再密也只是点，
   * 点凑不出体积 —— 底座要「托住」一棵九米高的树，缺的是一层能看出厚度的光。
   * 真实舞台上这种东西叫地雾 / 光雾：不用几何体，就是一片被光照亮的空气。
   * 做法是几十个大号柔光点（直径 40~120 像素），单团不透明度只有 0.05 左右，
   * 叠在一起才慢慢积出那层雾 —— 任何一团单独拎出来都几乎看不见，这正是关键：
   * 看得见单团就变成一颗颗球了。
   */
  _buildHaze(count) {
    const pos = new Float32Array(count * 3);
    const radius = new Float32Array(count);
    const angle = new Float32Array(count);
    const y0 = new Float32Array(count);
    const seed = new Float32Array(count);
    const size = new Float32Array(count);
    const speed = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      radius[i] = 1.1 + Math.pow(Math.random(), 0.7) * 4.1;
      angle[i] = Math.random() * Math.PI * 2;
      y0[i] = 0.10 + Math.random() * 0.95;
      seed[i] = Math.random();
      // 世界尺度：0.55~1.85 米。近处约 120 像素、远处约 40 像素
      size[i] = 0.55 + Math.pow(Math.random(), 1.4) * 1.30;
      speed[i] = 0.25 + Math.random() * 0.65;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1));
    geo.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
    geo.setAttribute('aY', new THREE.BufferAttribute(y0, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));

    this.hazeMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uProj: { value: 900 },
        uIntensity: { value: 1 },
        uBeat: { value: 0 },
        uLove: { value: 0 },
        uMap: { value: dotTexture() },
      },
      vertexShader: hazeVert,
      fragmentShader: hazeFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.haze = new THREE.Points(geo, this.hazeMat);
    this.haze.frustumCulled = false;
    this.haze.renderOrder = 5;
    this.group.add(this.haze);
  }

  update(dt, t, params) {
    const beat = Math.min(1.2, params.beat || 0);
    const love = Math.min(1, (params.love || 0) + (params.collapse || 0));
    const u = this.nebulaMat.uniforms;
    u.uTime.value = t;
    u.uBeat.value = beat;
    // 满屏爱心 / 收树的时候底座跟着收，不然它会从心形的缝里透出来
    u.uIntensity.value = 1.95 * (1 - 0.5 * love);

    const h = this.hazeMat.uniforms;
    h.uTime.value = t;
    h.uBeat.value = beat;
    h.uLove.value = Math.min(1, params.love || 0);
    h.uIntensity.value = (0.75 + beat * 0.2) * (1 - 0.6 * love);

    // 地台亮度跟着鼓点呼吸，但要克制：它是一大片，强闪会盖住树根
    // 地面的「亮」现在主要是真实点光给的，贴片只负责那层飘在雪面上的薄光晕，
    // 所以亮度压到 0.78 左右就够了 —— 再高就会把漫反射的过渡盖平，又变回一张图
    this.poolMat.opacity = (0.56 + beat * 0.13) * (1 - 0.4 * love);
    this.spillMat.opacity = (0.45 + beat * 0.10) * (1 - 0.4 * love);
    for (const l of this.baseLights) l.intensity = (14 + beat * 5.5) * (1 - 0.55 * love);

    // 比心时地面偏玫瑰：整场只剩心形是亮的，地台要是还发暖金，
    // 心的边缘会被地面的暖色吃掉
    this.poolMat.color.setRGB(1, 1 - 0.22 * love, 1 - 0.10 * love);
  }

  /** 光雾按世界尺寸投影，和屏幕分辨率 / 像素比无关（焦距随视口重算） */
  setViewport(camera, viewH, pixelRatio) {
    const hPx = viewH * pixelRatio;
    const f = (hPx * 0.5) / Math.tan((camera.fov * Math.PI) / 360);
    this.hazeMat.uniforms.uProj.value = f;
  }

  /** 雪地上的一块投影（礼物堆在摆的时候调用，见 groundShadow） */
  addGiftShadow(x, z, size) {
    const m = groundShadow(x, z, size);
    this.group.add(m);
    return m;
  }

  setPixelRatio(pr) {
    this.nebulaMat.uniforms.uPixelRatio.value = pr;
  }
}
