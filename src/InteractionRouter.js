const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 手势 / 音乐的合并层。
 * 手势管“形态与空间”，音乐管“亮度与能量”，冲突参数相加后 clamp。
 */
export class InteractionRouter {
  constructor() {
    this.scale = 1;
    this.scaleVel = 0;
    this.explode = 0;
    this.swirl = 0;
    this.collapse = 0;
    this.storm = 0;
    this.seq = 1;
    this.push = 0;
    this.angular = 0;
    this.hist = [];
    this.lastSize = null;
    this.clapFlash = 0;

    this.trayWorld = { x: 0, y: 6.0, z: 2.7, active: false };
    this.active = new Set();
  }

  onEvent(type, payload) {
    if (type === 'burst') {
      this.explode = Math.max(this.explode, payload.strength || 0.75);
      this.storm = Math.max(this.storm, 0.45);
    } else if (type === 'clap') {
      this.explode = 1.0;
      this.storm = 1.0;
      this.clapFlash = 1.0;
    } else if (type === 'trayOn') {
      this.trayWorld.active = true;
    } else if (type === 'trayOff') {
      this.trayWorld.active = false;
    }
  }

  update(dt, t, gstate, music) {
    const hands = gstate.hands || [];
    const now = t * 1000;

    // ---- 双手缩放 ----
    let target = 1;
    if (gstate.spread != null) {
      target = clamp(0.62 + (gstate.spread - 0.16) * 2.6, 0.66, 1.78);
    }
    this.scaleVel += (target - this.scale) * 70 * dt;
    this.scaleVel *= Math.exp(-dt * 7.5);
    this.scale += this.scaleVel * dt;
    this.scale = clamp(this.scale, 0.6, 1.85);

    // ---- 握拳收拢 ----
    const fist = hands.some((h) => h.gesture === 'fist');
    this.collapse = lerp(this.collapse, fist ? 1 : 0, 1 - Math.exp(-dt * 7));

    // ---- 涡流 + 推拉 ----
    if (hands.length === 1) {
      const h = hands[0];
      this.hist.push({ x: h.palmMirrored.x, y: h.palmMirrored.y });
      if (this.hist.length > 20) this.hist.shift();

      if (this.hist.length > 8) {
        let cx = 0, cy = 0;
        for (const p of this.hist) { cx += p.x; cy += p.y; }
        cx /= this.hist.length;
        cy /= this.hist.length;

        let sum = 0;
        for (let i = 1; i < this.hist.length; i++) {
          const a0 = Math.atan2(this.hist[i - 1].y - cy, this.hist[i - 1].x - cx);
          const a1 = Math.atan2(this.hist[i].y - cy, this.hist[i].x - cx);
          let d = a1 - a0;
          if (d > Math.PI) d -= Math.PI * 2;
          if (d < -Math.PI) d += Math.PI * 2;
          sum += d;
        }
        this.angular = lerp(this.angular, sum, 0.16);
      }

      const sizeV = this.lastSize === null ? 0 : (h.size - this.lastSize) / Math.max(dt, 0.001);
      this.lastSize = h.size;
      if (Math.abs(sizeV) > 0.03) {
        this.push = lerp(this.push, clamp(sizeV * 5.5, -1.2, 1.2), 0.22);
      }
    } else {
      this.hist.length = 0;
      this.angular *= Math.exp(-dt * 2.2);
      this.lastSize = null;
    }

    this.push *= Math.exp(-dt * 1.9);

    const swirlTarget = clamp(this.angular * 2.4, -1.7, 1.7) - this.push * 0.55;
    this.swirl = lerp(this.swirl, swirlTarget, 1 - Math.exp(-dt * 3.2));

    // ---- 脉冲衰减 ----
    this.explode *= Math.exp(-dt * 1.35);
    this.storm *= Math.exp(-dt * 2.4);
    this.clapFlash *= Math.exp(-dt * 2.0);
    if (this.explode < 0.002) this.explode = 0;
    if (this.storm < 0.002) this.storm = 0;

    // ---- 彩灯随缩放依次点亮 ----
    const seqTarget = clamp((this.scale - 0.70) / 0.85, 0, 1);
    this.seq = lerp(this.seq, seqTarget, 1 - Math.exp(-dt * 2.4));

    // ---- 托盘世界坐标 ----
    if (gstate.tray) {
      this.trayWorld.x = (gstate.tray.x - 0.5) * 13.0;
      this.trayWorld.y = (1 - gstate.tray.y) * 9.8;
      this.trayWorld.active = true;
    } else {
      this.trayWorld.active = false;
    }

    // ---- 合并 ----
    const dim = 1 - this.collapse * 0.58;
    const params = {
      brightness: clamp(music.brightness * dim + this.explode * 0.10, 0.24, 1.35),
      bloom: clamp(music.bloom * dim + this.explode * 0.30 + this.storm * 0.22, 0.30, 1.95),
      warm: clamp(music.warm + this.explode * 0.15, 0, 1),
      high: music.high,
      beat: clamp(music.beat * (1 + this.explode * 0.35) + this.clapFlash * 0.4, 0, 1.4),
      explode: this.explode,
      swirl: this.swirl,
      collapse: this.collapse,
      scale: this.scale * (1 - this.collapse * 0.05),
      seq: clamp(this.seq * (1 - this.collapse * 0.85), 0, 1),
      storm: clamp(this.storm + Math.abs(this.push) * 0.3, 0, 1.4),
    };

    // ---- UI 高亮 ----
    const a = this.active;
    a.clear();
    if (this.collapse > 0.45) a.add('fist');
    if (this.explode > 0.35) a.add('open');
    if (hands.length >= 2) a.add('spread');
    if (this.clapFlash > 0.3) a.add('clap');
    if (Math.abs(this.swirl) > 0.16) a.add('vortex');
    if (this.trayWorld.active) a.add('tray');

    return params;
  }
}
