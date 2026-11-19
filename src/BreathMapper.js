const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 把音频能量 / 鼓点脉冲映射成视觉参数。
 * 只负责“亮度与能量”，不碰形态，形态由手势决定。
 */
export class BreathMapper {
  constructor() {
    this.smooth = { low: 0, body: 0, mid: 0, high: 0, rms: 0 };
    this.rmsPeak = 60;
    this.enabled = true;
  }

  compute(levels, beat, t, dt) {
    const k = 1 - Math.exp(-dt * 8);
    const src = levels || { low: 0, body: 0, mid: 0, high: 0, rms: 0 };

    this.smooth.low = lerp(this.smooth.low, src.low, k);
    this.smooth.body = lerp(this.smooth.body, src.body, k);
    this.smooth.mid = lerp(this.smooth.mid, src.mid, k);
    this.smooth.high = lerp(this.smooth.high, src.high, k);
    this.smooth.rms = lerp(this.smooth.rms, src.rms, k * 0.8);

    this.rmsPeak = Math.max(this.rmsPeak * 0.999, this.smooth.rms, 40);

    const rmsN = clamp(this.smooth.rms / 255, 0, 1);
    const bodyN = clamp(this.smooth.body / 180, 0, 1);
    const highN = clamp(this.smooth.high / 140, 0, 1);
    const pulse = beat.pulse;

    const hasAudio = !!(levels && levels.hasAudio);
    const base = hasAudio ? 0.62 : 0.98;
    const music = hasAudio ? rmsN * 0.42 + pulse * 0.20 : pulse * 0.16;
    const breath = Math.sin(t * 1.85) * 0.05 * (0.4 + rmsN);

    const brightness = clamp(base + music + breath, 0.32, 1.32);
    const bloom = clamp(0.58 + pulse * 0.72 + rmsN * 0.18, 0.35, 1.75);
    const warm = clamp(0.2 + bodyN * 0.55 + pulse * 0.2, 0, 1);

    return {
      brightness,
      bloom,
      warm,
      high: highN,
      beat: pulse,
      rms: rmsN,
      particleBoost: 1 + pulse * 0.12,
      hasAudio,
    };
  }
}

/** MP3 的“帧率”说法不准确：这里是 FFT 分析帧，与渲染帧同步即可 */
export const ANALYZE_INTERVAL = 0;
