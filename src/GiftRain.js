import * as THREE from 'three';
import { dotTexture } from './textures.js';

// 第四色原来是 0xd8d0c0（近白）。树底那三盏点光把地面照到 0.3 亮度之后，
// 这只盒子正好站在灯前 —— 反照率 0.85 乘上照度直接顶到 1.0，整只盒子糊成纯白方块。
// 换成暖米色，同样的光照下还能看出盒面和缎带。
const GIFT_COLORS = [0xb3202f, 0xc8a02e, 0x2f6b46, 0xb2a691, 0x8e1f4a, 0x1f4f8e];
const RIBBON_COLORS = [0xf0e2c0, 0xd8b45a, 0xe8e2d4];

export function makeGift() {
  const g = new THREE.Group();
  const size = 0.42 + Math.random() * 0.2;
  const bodyColor = GIFT_COLORS[(Math.random() * GIFT_COLORS.length) | 0];
  const ribbonColor = RIBBON_COLORS[(Math.random() * RIBBON_COLORS.length) | 0];

  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    roughness: 0.52,
    metalness: 0.16,
  });
  const box = new THREE.Mesh(new THREE.BoxGeometry(size, size * 0.84, size), bodyMat);
  g.add(box);

  const ribbonMat = new THREE.MeshStandardMaterial({
    color: ribbonColor,
    roughness: 0.3,
    metalness: 0.5,
    emissive: new THREE.Color(ribbonColor).multiplyScalar(0.06),
  });
  const r1 = new THREE.Mesh(new THREE.BoxGeometry(size * 1.02, size * 0.86, size * 0.16), ribbonMat);
  const r2 = new THREE.Mesh(new THREE.BoxGeometry(size * 0.16, size * 0.86, size * 1.02), ribbonMat);
  g.add(r1, r2);

  const knot = new THREE.Mesh(new THREE.TorusGeometry(size * 0.14, size * 0.05, 8, 16), ribbonMat);
  knot.position.y = size * 0.44;
  knot.rotation.x = Math.PI / 2;
  g.add(knot);

  g.userData.size = size;
  return g;
}

class BurstSystem {
  constructor(max = 320) {
    this.max = max;
    this.cursor = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.size = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: dotTexture() },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
      vertexShader: /* glsl */`
        uniform float uPixelRatio;
        attribute float aLife;
        attribute float aSize;
        varying float vLife;
        void main(){
          vLife = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPixelRatio * (0.35 + aLife * 0.9) * (70.0 / max(-mv.z, 0.1));
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying float vLife;
        void main(){
          if (vLife <= 0.0) discard;
          float a = texture2D(uMap, gl_PointCoord).a;
          vec3 c = mix(vec3(1.0, 0.62, 0.24), vec3(1.0, 0.92, 0.72), vLife);
          gl_FragColor = vec4(c * a * vLife * 1.6, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.geo = geo;
  }

  spawn(x, y, z, count = 46, power = 3.2) {
    for (let i = 0; i < count; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      this.pos[idx * 3] = x;
      this.pos[idx * 3 + 1] = y;
      this.pos[idx * 3 + 2] = z;

      const a = Math.random() * Math.PI * 2;
      const up = 0.4 + Math.random() * 1.2;
      const r = Math.random() * power;
      this.vel[idx * 3] = Math.cos(a) * r;
      this.vel[idx * 3 + 1] = up * power * 0.55;
      this.vel[idx * 3 + 2] = Math.sin(a) * r * 0.7;

      this.life[idx] = 1.0;
      this.size[idx] = 1.2 + Math.random() * 2.4;
    }
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt * 1.15;
      if (this.life[i] < 0) this.life[i] = 0;
      this.vel[i * 3 + 1] -= 5.0 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    if (any) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aLife.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
    }
  }
}

/**
 * 天空落下的礼物 + 托盘接取判定 + 金色爆散。
 */
export class GiftRain {
  constructor(scene, { onCatch } = {}) {
    this.scene = scene;
    this.onCatch = onCatch || (() => {});
    this.group = new THREE.Group();
    scene.add(this.group);

    this.pool = [];
    for (let i = 0; i < 8; i++) {
      const g = makeGift();
      g.visible = false;
      this.group.add(g);
      this.pool.push(g);
    }

    this.active = [];
    this.burst = new BurstSystem();
    scene.add(this.burst.points);

    this.timer = 2.0;
    this.count = 0;

    const ringGeo = new THREE.RingGeometry(0.72, 0.92, 48);
    this.ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffd79a,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    scene.add(this.ring);
  }

  _take() {
    for (const g of this.pool) {
      if (!g.visible) return g;
    }
    return null;
  }

  spawnGift() {
    const g = this._take();
    if (!g) return;
    const x = (Math.random() - 0.5) * 8.5;
    g.position.set(x, 11.5, 1.5 + Math.random() * 0.9);
    g.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    g.scale.setScalar(1);
    g.visible = true;
    this.active.push({ obj: g, vy: -0.6, spin: (Math.random() - 0.5) * 1.6, caught: false });
  }

  update(dt, tray) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = tray && tray.active ? 2.2 + Math.random() * 0.8 : 4.6 + Math.random() * 1.4;
      if (this.active.length < 4) this.spawnGift();
    }

    if (tray && tray.active) {
      this.ring.position.set(tray.x, tray.y, tray.z);
      this.ring.material.opacity += (0.26 - this.ring.material.opacity) * Math.min(1, dt * 8);
    } else {
      this.ring.material.opacity *= Math.exp(-dt * 8);
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const item = this.active[i];
      const g = item.obj;

      item.vy -= 6.4 * dt;
      g.position.y += item.vy * dt;
      g.rotation.x += item.spin * dt;
      g.rotation.z += item.spin * 0.6 * dt;

      let done = false;

      if (tray && tray.active) {
        const dx = g.position.x - tray.x;
        const dy = g.position.y - tray.y;
        const dz = g.position.z - tray.z;
        if (Math.abs(dx) < 1.05 && Math.abs(dy) < 0.85 && Math.abs(dz) < 1.6) {
          this.burst.spawn(g.position.x, g.position.y, g.position.z, 54, 3.4);
          this.count++;
          this.onCatch(this.count);
          done = true;
        }
      }

      if (!done && g.position.y < 0.25) {
        this.burst.spawn(g.position.x, 0.2, g.position.z, 16, 1.6);
        done = true;
      }

      if (done) {
        g.visible = false;
        this.active.splice(i, 1);
      }
    }

    this.burst.update(dt);
  }

  reset() {
    for (const item of this.active) item.obj.visible = false;
    this.active.length = 0;
    this.count = 0;
  }
}
