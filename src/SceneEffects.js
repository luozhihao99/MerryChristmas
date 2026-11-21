import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { dotTexture } from './textures.js';

const VignetteGrainShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.72 },
    uGrain: { value: 0.026 },
    uWarmLift: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uWarmLift;
    varying vec2 vUv;

    float hash(vec2 p){
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = 1.0 - dot(d, d) * uVignette * 1.85;
      c.rgb *= clamp(v, 0.0, 1.0);

      float g = hash(vUv * 1024.0 + uTime * 0.63) - 0.5;
      c.rgb += g * uGrain;

      c.rgb += vec3(0.035, 0.024, 0.012) * uWarmLift * (1.0 - vUv.y);
      gl_FragColor = c;
    }
  `,
};

const snowVert = /* glsl */`
uniform float uTime;
uniform float uPixelRatio;
uniform float uSize;
uniform float uBeat;
uniform float uSwirl;
uniform float uStorm;
uniform float uLove;

attribute float aSeed;
attribute float aSize;
attribute float aSpeed;

varying float vAlpha;

void main(){
  vec3 p = position;
  p.y = mod(p.y - uTime * aSpeed * (1.0 + uStorm * 2.0) * (1.0 - uLove * 0.5), 22.0) - 2.0;
  p.x += sin(uTime * 0.52 + aSeed * 22.0) * (0.9 + uStorm * 2.5) * (1.0 - uLove * 0.55);
  p.z += cos(uTime * 0.44 + aSeed * 15.0) * 0.9;
  p.xz += normalize(p.xz + 0.001) * uSwirl * 1.4;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  gl_PointSize = aSize * uSize * uPixelRatio * (1.0 + uBeat * 0.35) / max(-mv.z, 0.1);
  vAlpha = (0.16 + 0.34 * aSeed) * (1.0 + uStorm * 0.5);
}
`;

const snowFrag = /* glsl */`
uniform sampler2D uMap;
uniform float uLove;
varying float vAlpha;
void main(){
  float a = texture2D(uMap, gl_PointCoord).a;
  if (a < 0.01) discard;
  // 比心时雪从冷白渐变到玫瑰粉，像花瓣在飘
  vec3 col = mix(vec3(0.82, 0.90, 1.0), vec3(1.0, 0.72, 0.84), uLove);
  gl_FragColor = vec4(col * a * vAlpha, 1.0);
}
`;

function buildEnvironment(renderer) {
  const w = 1024;
  const h = 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0.0, '#0a1220');
  sky.addColorStop(0.45, '#131f2e');
  sky.addColorStop(0.58, '#1a2331');
  sky.addColorStop(0.75, '#0a0e15');
  sky.addColorStop(1.0, '#04060a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const warm = ctx.createRadialGradient(w * 0.5, h * 0.62, 0, w * 0.5, h * 0.62, w * 0.34);
  warm.addColorStop(0.0, 'rgba(255,196,120,0.55)');
  warm.addColorStop(0.35, 'rgba(210,150,80,0.18)');
  warm.addColorStop(1.0, 'rgba(120,90,50,0)');
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, w, h);

  const cool = ctx.createRadialGradient(w * 0.12, h * 0.3, 0, w * 0.12, h * 0.3, w * 0.22);
  cool.addColorStop(0.0, 'rgba(120,170,230,0.28)');
  cool.addColorStop(1.0, 'rgba(90,130,180,0)');
  ctx.fillStyle = cool;
  ctx.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}

export class SceneEffects {
  constructor(renderer, scene, camera, { width, height, pixelRatio }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.scene.environment = buildEnvironment(renderer);
    this.scene.fog = new THREE.FogExp2(0x060a11, 0.024);

    this._buildGround();
    this._buildSkyStars();
    this._buildSnow();

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.62, 0.72, 0.74);
    this.composer.addPass(this.bloom);

    this.composer.addPass(new OutputPass());

    this.vignette = new ShaderPass(VignetteGrainShader);
    this.vignette.renderToScreen = true;
    this.composer.addPass(this.vignette);
  }

  _buildGround() {
    const geo = new THREE.CircleGeometry(48, 64);
    geo.rotateX(-Math.PI / 2);
    // 反照率不能再压到 0x0e1822：暗到这个程度，任何灯打上去都只是「黑上加点亮」，
    // 看上去像贴了一层雾。抬到 0x263140 给雪地一点真实的漫反射底子，
    // 树底那三盏点光才照得出「越靠树根越亮」的衰减（而不是靠加色贴片硬画）。
    // 仍然是夜里的雪：环境光只有 0.75，远处会被雾吃掉，只剩树脚这一圈是亮的。
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1c2632,
      roughness: 0.94,
      metalness: 0.0,
    });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.position.y = -0.02;
    this.scene.add(this.ground);

    // 地面上的光不再由这里负责：暖光池 + 树冠回光 + 星云底座都在 GroundBase 里，
    // 那三样要共享同一套亮度节奏（跟着鼓点呼吸、比心时转玫瑰色），拆开写会各亮各的。
  }

  _buildSkyStars() {
    const count = 700;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 26 + Math.random() * 18;
      const y = Math.random() * 26 - 2;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      map: dotTexture(),
      size: 0.34,
      sizeAttenuation: true,
      color: 0x9fb8d8,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.skyStars = new THREE.Points(geo, mat);
    this.scene.add(this.skyStars);
  }

  _buildSnow() {
    const count = 1000;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const size = new Float32Array(count);
    const speed = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 34;
      pos[i * 3 + 1] = Math.random() * 22;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 26;
      seed[i] = Math.random();
      size[i] = 0.5 + Math.random() * 1.1;
      speed[i] = 0.5 + Math.random() * 1.5;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));

    this.snowMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uSize: { value: 22 },
        uBeat: { value: 0 },
        uSwirl: { value: 0 },
        uStorm: { value: 0 },
        uLove: { value: 0 },
        uMap: { value: dotTexture() },
      },
      vertexShader: snowVert,
      fragmentShader: snowFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.snow = new THREE.Points(geo, this.snowMat);
    this.snow.frustumCulled = false;
    this.scene.add(this.snow);
  }

  update(t, params) {
    const love = params.love || 0;
    this.snowMat.uniforms.uTime.value = t;
    this.snowMat.uniforms.uBeat.value = params.beat;
    this.snowMat.uniforms.uSwirl.value = params.swirl;
    this.snowMat.uniforms.uStorm.value = params.storm;
    this.snowMat.uniforms.uLove.value = love;

    this.bloom.strength = params.bloom;
    this.vignette.uniforms.uTime.value = t;
    this.vignette.uniforms.uWarmLift.value = params.warm * 0.8;

    this.skyStars.material.opacity = 0.42 + params.beat * 0.16;
  }

  setSize(width, height, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.snowMat.uniforms.uPixelRatio.value = pixelRatio;
  }

  render() {
    this.composer.render();
  }
}
