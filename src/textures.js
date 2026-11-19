import * as THREE from 'three';

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function toTexture(canvas, { srgb = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * 针叶 / 光尘粒子纹理：细长水滴形主体 + 外发光。
 * 顶点着色器会按粒子随机角度旋转 UV，所以一张纹理即可得到随机朝向的针叶。
 */
export function needleTexture(size = 128) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const S = size;
  ctx.clearRect(0, 0, S, S);
  ctx.translate(S / 2, S / 2);

  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 0.44);
  glow.addColorStop(0.0, 'rgba(255,255,255,0.40)');
  glow.addColorStop(0.35, 'rgba(255,255,255,0.10)');
  glow.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(-S / 2, -S / 2, S, S);

  const body = ctx.createLinearGradient(0, -S * 0.46, 0, S * 0.44);
  body.addColorStop(0.00, 'rgba(255,255,255,0)');
  body.addColorStop(0.28, 'rgba(255,255,255,0.92)');
  body.addColorStop(0.62, 'rgba(255,255,255,0.72)');
  body.addColorStop(0.88, 'rgba(255,255,255,0.18)');
  body.addColorStop(1.00, 'rgba(255,255,255,0)');

  ctx.filter = 'blur(1.4px)';
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(0, -S * 0.46);
  ctx.bezierCurveTo(S * 0.085, -S * 0.22, S * 0.065, S * 0.16, 0, S * 0.44);
  ctx.bezierCurveTo(-S * 0.065, S * 0.16, -S * 0.085, -S * 0.22, 0, -S * 0.46);
  ctx.closePath();
  ctx.fill();

  ctx.filter = 'blur(3px)';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(0, -S * 0.02, S * 0.022, S * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();

  return toTexture(c);
}

/** 柔和圆点，用于光尘、雪花、礼物爆散 */
export function dotTexture(size = 64) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const S = size;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.16)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return toTexture(c);
}

/** 彩灯用的更外扩的辉光点 */
export function glowTexture(size = 128) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const S = size;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.14, 'rgba(255,255,255,0.62)');
  g.addColorStop(0.38, 'rgba(255,255,255,0.14)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.03)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return toTexture(c);
}

/** 树顶星：四芒星 + 光晕 */
export function starTexture(size = 256) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const S = size;
  const cx = S / 2;
  const cy = S / 2;

  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.5);
  halo.addColorStop(0.0, 'rgba(255,246,220,0.75)');
  halo.addColorStop(0.18, 'rgba(255,226,160,0.34)');
  halo.addColorStop(0.48, 'rgba(255,204,120,0.09)');
  halo.addColorStop(1.0, 'rgba(255,190,90,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, S, S);

  const spike = (len, wide, rot) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    const g = ctx.createLinearGradient(0, -len, 0, len * 0.2);
    g.addColorStop(0, 'rgba(255,250,235,0)');
    g.addColorStop(0.45, 'rgba(255,244,214,0.92)');
    g.addColorStop(1, 'rgba(255,228,170,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -len);
    ctx.lineTo(wide, 0);
    ctx.lineTo(0, len * 0.16);
    ctx.lineTo(-wide, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  ctx.filter = 'blur(1.2px)';
  spike(S * 0.46, S * 0.035, 0);
  spike(S * 0.46, S * 0.035, Math.PI / 2);
  ctx.filter = 'blur(2.2px)';
  spike(S * 0.30, S * 0.055, Math.PI / 4);
  spike(S * 0.30, S * 0.055, -Math.PI / 4);

  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.06);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(1, 'rgba(255,240,200,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.06, 0, Math.PI * 2);
  ctx.fill();

  return toTexture(c);
}

/** 地面上的绿色光晕贴片 */
export function groundGlowTexture(size = 256) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const S = size;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(120,220,170,0.30)');
  g.addColorStop(0.35, 'rgba(70,170,130,0.11)');
  g.addColorStop(0.7, 'rgba(40,110,90,0.03)');
  g.addColorStop(1.0, 'rgba(20,60,50,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return toTexture(c);
}
