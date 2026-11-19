/**
 * 低频鼓点检测。
 *
 * 单一频段的绝对阈值在真实音乐里很不稳：底鼓一响，频谱平滑会把能量拖很久，
 * 于是同一次鼓点被连续触发好几下。这里改成经典的“能量历史 + 自适应阈值”：
 *   score = 低频峰值 * 0.7 + 时域 RMS * 0.9
 * 与最近 1s 的均值/标准差比较，配合 200ms 冷却与重新武装，输出单次脉冲。
 */
export class BeatDetector {
  constructor() {
    this.hist = [];
    this.lastBeat = 0;
    this.pulse = 0;
    this.bpm = 0;
    this.intervals = [];
    this.armed = true;
    this.beatCount = 0;
    this.score = 0;
    this.mean = 0;
    this.startAt = 0;
  }

  update(levels, now, dt) {
    if (!levels) {
      this.pulse *= Math.exp(-dt * 5.2);
      return { pulse: this.pulse, hit: false, bpm: this.bpm };
    }

    const score = levels.low * 0.7 + levels.rms * 0.9;
    this.score = score;
    if (!this.startAt) this.startAt = now;

    this.hist.push({ t: now, v: score });
    while (this.hist.length && now - this.hist[0].t > 1000) this.hist.shift();

    const n = this.hist.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += this.hist[i].v;
    mean /= n;
    let varSum = 0;
    for (let i = 0; i < n; i++) varSum += (this.hist[i].v - mean) ** 2;
    const std = Math.sqrt(varSum / n);
    this.mean = mean;

    const threshold = mean + Math.max(6, std * 1.15);
    let hit = false;

    if (!this.armed && score < mean + Math.max(3, std * 0.3)) this.armed = true;

    if (
      now - this.startAt > 600 &&
      this.armed &&
      score > threshold &&
      score > mean * 1.22 &&
      now - this.lastBeat > 200
    ) {
      if (this.lastBeat > 0) {
        const interval = now - this.lastBeat;
        if (interval > 250 && interval < 1600) {
          this.intervals.push(interval);
          if (this.intervals.length > 8) this.intervals.shift();
          const avg = this.intervals.reduce((a, b) => a + b, 0) / this.intervals.length;
          this.bpm = Math.round(60000 / avg);
        }
      }
      this.lastBeat = now;
      this.pulse = 1;
      this.armed = false;
      this.beatCount++;
      hit = true;
    }

    this.pulse *= Math.exp(-dt * 5.2);
    if (this.pulse < 0.001) this.pulse = 0;

    return { pulse: this.pulse, hit, bpm: this.bpm };
  }

  reset() {
    this.hist.length = 0;
    this.lastBeat = 0;
    this.pulse = 0;
    this.bpm = 0;
    this.intervals.length = 0;
    this.armed = true;
    this.beatCount = 0;
    this.score = 0;
    this.mean = 0;
    this.startAt = 0;
  }
}

/** 无音乐时的内置律动：96 BPM 的四拍鼓点 */
export function demoBeat(now) {
  const bpm = 96;
  const beatMs = 60000 / bpm;
  const phase = (now % beatMs) / beatMs;
  const kick = Math.exp(-phase * 6.5);
  const bar = Math.floor(now / beatMs) % 4;
  const accent = bar === 0 ? 1.0 : 0.78;
  return kick * accent;
}
