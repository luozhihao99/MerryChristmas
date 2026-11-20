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

/** 星星这类小尺寸贴图会被缩放，开 mipmap 才能避免边缘闪烁 */
function toCrispTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
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

const STAR_OUTER = 0.365;   // 外接半径（相对画布边长）
const STAR_INNER = 0.148;   // 内接半径，约 0.40 倍外径，得到经典五角星

function starPoints(S) {
  const cx = S / 2;
  const cy = S / 2;
  const R = S * STAR_OUTER;
  const ri = S * STAR_INNER;
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : ri;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
  }
  return pts;
}

/**
 * 树顶星本体：标准五角星（一尖朝上）。
 * 从星心分十个三角切面，按单侧来光做明暗，再加棱线、内缘高光和中心反光，
 * 用不透明混合渲染，暗部不会被吃掉，看起来是「金属实体」而不是发光贴纸。
 */
export function starTexture(size = 512) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const S = size;
  const cx = S / 2;
  const cy = S / 2;
  const R = S * STAR_OUTER;
  const pts = starPoints(S);

  const outline = () => {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
  };

  ctx.clearRect(0, 0, S, S);

  // 1. 切面：每根尖角分成左右两个面，各自按来光方向取明暗，
  //    中间自然形成一道折脊——这才是金属树顶星该有的分面结构
  const lightAng = -Math.PI * 0.78;
  const lx = Math.cos(lightAng);
  const ly = Math.sin(lightAng);

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const facetColor = (k) => {
    // 暗面偏琥珀，亮面偏淡金；白色只留给高光，整体保持金色
    const r = Math.round(196 + 59 * k);
    const g = Math.round(108 + 112 * k);
    const b = Math.round(26 + 140 * k);
    return `rgb(${r},${g},${b})`;
  };
  const facet = (ax, ay, bx, by, k) => {
    ctx.fillStyle = facetColor(clamp01(k));
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.closePath();
    ctx.fill();
  };

  ctx.save();
  outline();
  ctx.clip();
  for (let i = 0; i < 5; i++) {
    const tip = pts[i * 2];
    const left = pts[(i * 2 + 9) % 10];
    const right = pts[(i * 2 + 1) % 10];

    const dx = tip[0] - cx;
    const dy = tip[1] - cy;
    const dl = Math.hypot(dx, dy) || 1;
    const dirX = dx / dl;
    const dirY = dy / dl;
    const armLit = Math.max(0, dirX * lx + dirY * ly);

    // 两个面的法线（臂方向的左右法线），决定各自朝向光源的程度
    const sideLit = Math.max(0, -dirY * lx + dirX * ly);
    const otherLit = Math.max(0, dirY * lx - dirX * ly);

    const kA = 0.14 + 0.72 * (0.42 * armLit + 0.78 * sideLit);
    const kB = 0.14 + 0.72 * (0.42 * armLit + 0.78 * otherLit);

    facet(left[0], left[1], tip[0], tip[1], kA);
    facet(tip[0], tip[1], right[0], right[1], kB);
  }
  ctx.restore();

  // 2. 受光面整体提亮：一道从左上到右下衰减的柔光，像灯光掠过金面
  ctx.save();
  outline();
  ctx.clip();
  const sheen = ctx.createRadialGradient(
    cx - R * 0.34, cy - R * 0.40, 0,
    cx - R * 0.34, cy - R * 0.40, R * 1.05
  );
  sheen.addColorStop(0.0, 'rgba(255,255,246,0.20)');
  sheen.addColorStop(0.45, 'rgba(255,250,226,0.07)');
  sheen.addColorStop(1.0, 'rgba(255,240,205,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, S, S);
  ctx.restore();

  // 3. 折脊高光：沿五根尖角的中线补一道窄亮线，强化金属转折
  ctx.save();
  outline();
  ctx.clip();
  ctx.filter = `blur(${S * 0.005}px)`;
  ctx.lineWidth = S * 0.007;
  for (let i = 0; i < 5; i++) {
    const tip = pts[i * 2];
    const g = ctx.createLinearGradient(cx, cy, tip[0], tip[1]);
    g.addColorStop(0.0, 'rgba(255,252,236,0.32)');
    g.addColorStop(0.55, 'rgba(255,250,230,0.55)');
    g.addColorStop(1.0, 'rgba(255,246,220,0.12)');
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tip[0], tip[1]);
    ctx.stroke();
  }
  ctx.restore();

  // 4. 内缘高光：沿着轮廓的一圈细亮边
  ctx.save();
  outline();
  ctx.clip();
  ctx.filter = `blur(${S * 0.005}px)`;
  ctx.lineWidth = S * 0.024;
  const rim = ctx.createLinearGradient(cx - S * 0.3, cy - S * 0.3, cx + S * 0.3, cy + S * 0.3);
  rim.addColorStop(0.0, 'rgba(255,255,252,0.94)');
  rim.addColorStop(0.38, 'rgba(255,246,222,0.42)');
  rim.addColorStop(0.72, 'rgba(255,232,186,0.14)');
  rim.addColorStop(1.0, 'rgba(255,226,170,0.06)');
  ctx.strokeStyle = rim;
  outline();
  ctx.stroke();
  ctx.restore();

  // 5. 中心反光：略偏左上，像金属球面的高光点
  const hx = cx - S * 0.022;
  const hy = cy - S * 0.030;
  const core = ctx.createRadialGradient(hx, hy, 0, hx, hy, S * 0.085);
  core.addColorStop(0.0, 'rgba(255,255,252,0.92)');
  core.addColorStop(0.42, 'rgba(255,250,228,0.45)');
  core.addColorStop(1.0, 'rgba(255,236,190,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(hx, hy, S * 0.085, 0, Math.PI * 2);
  ctx.fill();

  // 6. 收边：极细的暖色描边，压住抗锯齿毛边
  ctx.save();
  ctx.lineWidth = S * 0.004;
  ctx.strokeStyle = 'rgba(255,214,150,0.55)';
  ctx.filter = `blur(${S * 0.002}px)`;
  outline();
  ctx.stroke();
  ctx.restore();

  return toCrispTexture(c);
}

/** 树顶星的辉光：外扩柔光 + 星形模糊，叠加在星体后面（加法混合） */
export function starGlowTexture(size = 256) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const S = size;
  const cx = S / 2;
  const cy = S / 2;
  const pts = starPoints(S);

  ctx.clearRect(0, 0, S, S);

  // 星形模糊：让光晕跟着星形扩散，而不是单纯一个圆
  ctx.save();
  ctx.filter = `blur(${S * 0.05}px)`;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,200,110,0.60)';
  ctx.fill();
  ctx.restore();

  // 圆形底光：给空气感
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.46);
  halo.addColorStop(0.0, 'rgba(255,226,168,0.66)');
  halo.addColorStop(0.18, 'rgba(255,206,132,0.22)');
  halo.addColorStop(0.45, 'rgba(255,188,100,0.055)');
  halo.addColorStop(1.0, 'rgba(255,176,80,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, S, S);

  return toCrispTexture(c);
}

/**
 * 心形贴图：用于「比心」飘起的小爱心。
 * 纯白 + alpha，颜色交给材质的 uColor 控制，方便从玫红渐变到金色。
 */
export function heartTexture(size = 128) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const S = size;
  const cx = S / 2;
  const cy = S * 0.53;
  const k = S / 128;

  const path = () => {
    const p = new Path2D();
    p.moveTo(cx, cy + 34 * k);
    p.bezierCurveTo(cx - 46 * k, cy + 6 * k, cx - 40 * k, cy - 40 * k, cx - 14 * k, cy - 40 * k);
    p.bezierCurveTo(cx - 4 * k, cy - 40 * k, cx, cy - 30 * k, cx, cy - 22 * k);
    p.bezierCurveTo(cx, cy - 30 * k, cx + 4 * k, cy - 40 * k, cx + 14 * k, cy - 40 * k);
    p.bezierCurveTo(cx + 40 * k, cy - 40 * k, cx + 46 * k, cy + 6 * k, cx, cy + 34 * k);
    p.closePath();
    return p;
  };

  // 外发光要克制：小尺寸下模糊太多就变成光斑，看不出是心
  ctx.save();
  ctx.filter = `blur(${2.4 * k}px)`;
  ctx.fillStyle = 'rgba(255,255,255,0.34)';
  ctx.fill(path());
  ctx.restore();

  ctx.filter = `blur(${0.5 * k}px)`;
  ctx.fillStyle = '#ffffff';
  ctx.fill(path());
  ctx.filter = 'none';

  // 左上高光，避免小图标发死
  const shine = ctx.createRadialGradient(cx - 9 * k, cy - 18 * k, 0, cx - 9 * k, cy - 18 * k, 30 * k);
  shine.addColorStop(0.0, 'rgba(255,255,255,0.95)');
  shine.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.save();
  ctx.clip(path());
  ctx.fillStyle = shine;
  ctx.fillRect(0, 0, S, S);
  ctx.restore();

  return toCrispTexture(c);
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
