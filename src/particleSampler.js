/**
 * 把「离屏画布上的不透明像素」采样成粒子点集。
 *
 * 弹幕（CallDanmaku）和点赞（LikeBurst）用的是同一套逻辑：
 * 先在 canvas 上把要显示的东西画出来（文字 / 图形），再逐像素扫一遍，
 * 命中的像素随机取若干个当粒子落脚点。这样任何 2D 图形都能变成粒子，
 * 不需要为每个形状单独写几何。
 *
 * 采样步长 STEP 决定点距：太小粒子叠成一团白斑、太大笔画会断。
 */

const STEP = 2;

const TEXT_FAMILY = '"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';

/**
 * 花体用的字体栈，和 LoveMessage 的「I love you」完全一致：
 * 斜体衬线（Georgia 在有「I love you」那套里已经验证过粒子化之后还认得出），
 * 比无衬线更像手写，也更有装饰性。
 */
const SCRIPT_FAMILY = 'Georgia, "Times New Roman", "Songti SC", serif';

/**
 * 文字 → 点集。归一化到「字格高 = height」的局部坐标（原点在文字中心），
 * 横向宽度随文本自然变化，调用方再按可视宽度收。
 *
 * 注意按字号（FS）归一而不是按墨迹高：中文是方块字，字宽≈字号，
 * 用 actualBoundingBox 的墨迹高去归一会把字横向撑开 1.4 倍，看起来又扁又长。
 *
 * opts.script：斜体衬线花体，数字/英文用这个（和「I love you」同一套字形）。
 * opts.spacing：字距（em），花体偏窄，稍微松一点更透气。
 */
export function sampleText(text, count, height, { script = false, spacing = 0 } = {}) {
  const FS = 96;
  // 汉字和拉丁字母要分开处理：
  //   汉字笔画多、字腔（「口」里的空白）小，700 加粗之后墨迹占掉六成，
  //   粒子撒上去就是一块实心噪点 —— 必须用常规体 + 一道很细的描边；
  //   数字/英文正好相反，加粗之后笔画更实、粒子连得起来，看起来更有力。
  const cjk = /[\u3400-\u9fff]/.test(text);
  const weight = script ? 700 : cjk ? 400 : 700;
  const style = script ? 'italic ' : '';
  const family = script ? SCRIPT_FAMILY : TEXT_FAMILY;
  // 花体本身就是粗斜体，再描边会把字腔糊掉，所以只给中文常规体补那道细边
  const bold = cjk && !script ? FS * 0.020 : 0;
  const font = `${style}${weight} ${FS}px ${family}`;

  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  if (spacing) probe.letterSpacing = `${(spacing * FS).toFixed(1)}px`;
  const textW = Math.max(1, probe.measureText(text).width);
  const pad = Math.round(FS * 0.16);
  const W = Math.ceil(textW + pad * 2);
  const H = Math.ceil(FS * 1.30);

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.font = font;
  if (spacing) ctx.letterSpacing = `${(spacing * FS).toFixed(1)}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(text, W / 2, H * 0.54);
  // 汉字再描一圈很细的边：纯 400 的笔画太细，粒子化之后会碎成虚线；
  // 但描粗一点字腔就被糊死，所以只有 2%。
  if (bold) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = bold;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, W / 2, H * 0.54);
  }

  const hits = scan(ctx, W, H);
  const scale = height / FS;                       // 世界单位 / 像素
  // 横向再压 10% 只对中文做：汉字的字格（advance=字号）比墨迹宽，不压的话
  // 每个字看起来都偏扁、字距也显得松。花体/数字按原比例，压了会变成斜瘦条。
  const squash = cjk ? 0.9 : 1;
  const width = W * scale * squash;
  const pts = [];
  if (!hits.length) return { pts: cloud(count, width, height), width, height };

  for (let i = 0; i < count; i++) {
    const [x, y] = hits[(Math.random() * hits.length) | 0];
    pts.push([(x - W / 2) * scale * squash, (H / 2 - y) * scale]);
  }
  return { pts, width, height };
}

/**
 * 任意 2D 图形 → 点集。draw(ctx, W, H) 负责把图形画成不透明剪影，
 * 采样后按**墨迹包围盒**归一：高度正好等于 height，宽度按图形自身比例来。
 *
 * 图形用 draw 函数而不是图片，是为了不依赖字体/网络：
 * emoji 的「👍」在 Windows / Android / iOS 上是三种画法，甚至有的系统只画方块，
 * 用几何体自己拼一个，任何机器上采样出来的轮廓都一样。
 */
export function sampleShape(draw, count, height, { width: cw = 94, height: ch = 100 } = {}) {
  const S = 260;                                   // 基准边长（像素）
  const U = S / 100;
  const W = Math.round(cw * U);
  const H = Math.round(ch * U);

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  draw(ctx, U);

  const hits = scan(ctx, W, H);
  if (!hits.length) return { pts: cloud(count, height * (cw / ch), height), width: height * (cw / ch), height };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of hits) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const inkW = Math.max(1, maxX - minX);
  const inkH = Math.max(1, maxY - minY);
  const scale = height / inkH;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const pts = [];
  for (let i = 0; i < count; i++) {
    const [x, y] = hits[(Math.random() * hits.length) | 0];
    pts.push([(x - cx) * scale, (cy - y) * scale]);
  }
  return { pts, width: inkW * scale, height };
}

function scan(ctx, W, H) {
  const data = ctx.getImageData(0, 0, W, H).data;
  const hits = [];
  for (let y = 0; y < H; y += STEP) {
    for (let x = 0; x < W; x += STEP) {
      if (data[(y * W + x) * 4 + 3] > 128) hits.push([x, y]);
    }
  }
  return hits;
}

/** 拿不到 2d 上下文时的兜底：一团云，至少不崩 */
function cloud(count, width, height) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    pts.push([(Math.random() - 0.5) * width, (Math.random() - 0.5) * height]);
  }
  return pts;
}
