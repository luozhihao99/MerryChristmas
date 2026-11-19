/**
 * 音频源 + 频谱分析。
 * 没有音乐时返回 null，由上层切换到内置律动（demo 模式），保证画面始终在呼吸。
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.gain = null;
    this.source = null;
    this.buffer = null;
    this.freqData = null;
    this.timeData = null;
    this.playing = false;
    this.name = '';
    this.startedAt = 0;
    this.offset = 0;
    this.bandBins = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.9;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.45;
      this.analyser.minDecibels = -90;
      this.analyser.maxDecibels = -10;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.timeData = new Uint8Array(this.analyser.fftSize);
      this._computeBands();
    }
    return this.ctx;
  }

  _computeBands() {
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const bin = (hz) => Math.max(1, Math.min(this.analyser.frequencyBinCount - 1, Math.round(hz / binHz)));
    this.bandBins = {
      low: [bin(30), bin(110)],
      body: [bin(120), bin(500)],
      mid: [bin(500), bin(2000)],
      high: [bin(2000), bin(8000)],
    };
  }

  async load(file) {
    this.ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stop();

    const arrayBuffer = await file.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.name = file.name.replace(/\.[^.]+$/, '');
    this.offset = 0;
    return this.buffer.duration;
  }

  play(from = 0) {
    if (!this.buffer) return false;
    this.ensureContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.stopSource();

    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.loop = true;
    this.source.connect(this.gain);
    this.source.start(0, from % this.buffer.duration);
    this.startedAt = this.ctx.currentTime;
    this.offset = from;
    this.playing = true;
    return true;
  }

  stopSource() {
    if (this.source) {
      try {
        this.offset = this.currentTime();
        this.source.stop();
      } catch (e) { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
    this.playing = false;
  }

  stop() {
    this.stopSource();
    this.offset = 0;
  }

  toggle() {
    if (!this.buffer) return false;
    if (this.playing) {
      this.stopSource();
      return false;
    }
    return this.play(this.offset);
  }

  currentTime() {
    if (!this.playing || !this.buffer) return this.offset;
    return (this.offset + (this.ctx.currentTime - this.startedAt)) % this.buffer.duration;
  }

  _max(arr, [a, b]) {
    let m = 0;
    const end = Math.min(b, arr.length);
    for (let i = a; i < end; i++) if (arr[i] > m) m = arr[i];
    return m;
  }

  _avg(arr, [a, b]) {
    let sum = 0;
    const end = Math.min(b, arr.length);
    if (end <= a) return 0;
    for (let i = a; i < end; i++) sum += arr[i];
    return sum / (end - a);
  }

  /** 每帧调用一次；无音频时返回 null */
  getFrame() {
    if (!this.analyser || !this.playing) return null;
    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getByteTimeDomainData(this.timeData);

    let sumSq = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const v = (this.timeData[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / this.timeData.length) * 255;

    const low = this._max(this.freqData, this.bandBins.low);
    const body = this._avg(this.freqData, this.bandBins.body);
    const mid = this._avg(this.freqData, this.bandBins.mid);
    const high = this._avg(this.freqData, this.bandBins.high);

    return { low, body, mid, high, rms, hasAudio: true };
  }
}
