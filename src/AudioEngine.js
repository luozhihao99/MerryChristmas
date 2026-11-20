/**
 * 音频源 + 频谱分析。
 *
 * 两种播放模式，自动选择：
 *   buffer  —— decodeAudioData 整首解码进内存。循环、定位最准，适合短文件。
 *   element —— <audio> + MediaElementAudioSourceNode 流式播放。
 *              不占内存，且能吃下浏览器能播的任何编码（m4a / 长音频）。
 *
 * 为什么要两套：手机上 decode 一首 5 分钟的歌要约 100MB AudioBuffer，
 * Safari 经常直接抛错或整页崩溃；流式模式内存只有几十 KB。
 * 先试 decode（短文件），失败或文件过大就自动退到 element。
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

    this.mode = 'buffer';
    this.el = null;
    this.elSource = null;
    this.elLinked = false;   // 当前 <audio> 是否接进了 Web Audio 图
    this.url = null;
    this.duration = 0;
    this.lastError = null;
    // 频谱能不能读。跨域媒体接不进 analyser（浏览器会静音），此时只能纯播，
    // 呼吸律动退回内置 demoBeat，总比没声音好。
    this.analysable = true;
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

  /** 触屏设备内存更紧，解码上限压得更低 */
  static decodeLimit() {
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    return touch ? 9 * 1024 * 1024 : 20 * 1024 * 1024;
  }

  /**
   * 同一个音频要不要先走本地服务器代理。
   * 直链基本都不发 CORS 头：直接 fetch 会被拦，跨域 <audio> 接进 Web Audio
   * 又会被判成「污染」直接静音 —— 两条路都读不到频谱。
   * serve.py 提供了 /__audio 同源代理，走它能整首解码，呼吸才真的跟着鼓点走。
   * 没起 serve.py（或部署到别处）时这个请求会 404，自动退回直连。
   */
  static proxyUrl(url) {
    if (!/^https?:$/.test(location.protocol)) return null;
    try {
      if (new URL(url, location.href).origin === location.origin) return null;
    } catch (e) {
      return null;
    }
    return `${location.origin}/__audio?url=${encodeURIComponent(url)}`;
  }

  /**
   * 加载一个 File。
   * 返回 { duration, mode }，mode 是实际生效的模式。
   * 抛错时 err.code 会是 'unsupported' / 'empty' / 'element' 之一，便于上层给具体提示。
   */
  async load(file) {
    this.ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stop();
    this.lastError = null;
    this.name = (file.name || '未命名').replace(/\.[^.]+$/, '');
    this.duration = 0;

    if (!file.size) {
      const err = new Error('空文件');
      err.code = 'empty';
      throw err;
    }

    // 1) 优先整首解码：循环无缝、定位精确
    if (file.size <= AudioEngine.decodeLimit()) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        this.buffer = await this._decode(arrayBuffer);
        this.mode = 'buffer';
        this.duration = this.buffer.duration;
        this.offset = 0;
        return { duration: this.duration, mode: this.mode };
      } catch (err) {
        console.warn('[audio] decodeAudioData 失败，改用流式播放', err);
        this.lastError = err;
        this.buffer = null;
      }
    }

    // 2) 流式：解码失败 / 文件过大都走这里
    try {
      await this._loadElement(file);
      this.mode = 'element';
      this.offset = 0;
      return { duration: this.duration, mode: this.mode };
    } catch (err) {
      const wrap = new Error(err.message || '音频无法播放');
      wrap.code = 'unsupported';
      wrap.cause = this.lastError || err;
      throw wrap;
    }
  }

  _decode(arrayBuffer) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = (buf) => { if (!settled) { settled = true; resolve(buf); } };
      const bad = (e) => { if (!settled) { settled = true; reject(e || new Error('decode failed')); } };
      try {
        const ret = this.ctx.decodeAudioData(arrayBuffer, ok, bad);
        if (ret && typeof ret.then === 'function') ret.then(ok).catch(bad);
      } catch (e) {
        bad(e);
      }
    });
  }

  async _loadElement(file) {
    const el = this._ensureEl(true);
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    el.src = this.url;
    await this._waitMeta(el);
    this.duration = isFinite(el.duration) ? el.duration : 0;
    this.analysable = true;
  }

  /**
   * 建立（或复用）<audio> 元素。
   * linked 决定要不要接进 Web Audio 图：
   *   同源（blob / 本地文件）→ 接，能同时出声 + 分析频谱；
   *   跨域远端 url → 不接，接了会被浏览器判成「污染」输出静音。
   * 同一个元素一旦接过 MediaElementAudioSourceNode 就退不回来，所以两种模式必须换元素。
   */
  _ensureEl(linked) {
    if (this.el && this.elLinked === linked) return this.el;

    if (this.el) {
      try { this.el.pause(); } catch (e) { /* 忽略 */ }
      this.el.removeAttribute('src');
      if (this.elSource) {
        try { this.elSource.disconnect(); } catch (e) { /* 忽略 */ }
      }
      this.el = null;
      this.elSource = null;
    }

    const el = new Audio();
    el.loop = true;
    el.preload = 'auto';
    el.volume = linked ? 1 : 0.9;
    if (linked) {
      this.elSource = this.ctx.createMediaElementSource(el);
      this.elSource.connect(this.gain);
    }
    this.el = el;
    this.elLinked = linked;
    return el;
  }

  /** 等元数据就绪；已缓存的情况不会再次触发 loadedmetadata，所以先查 readyState */
  _waitMeta(el) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('读取音频信息超时'));
      }, 12000);
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => {
        cleanup();
        const e = new Error('浏览器无法播放这个文件');
        e.code = 'unsupported';
        reject(e);
      };
      const cleanup = () => {
        clearTimeout(timer);
        el.removeEventListener('loadedmetadata', onReady);
        el.removeEventListener('error', onError);
      };
      el.addEventListener('loadedmetadata', onReady);
      el.addEventListener('error', onError);
      if (el.readyState >= 1 && isFinite(el.duration) && el.duration > 0) onReady();
    });
  }

  /**
   * 加载一个远端音频 URL（默认音乐走这条路）。
   *
   * 两种可能，自动取舍：
   *   A. 对方带 CORS 头 → fetch 成 blob 再整首解码，循环无缝且频谱可用；
   *   B. 没有 CORS（大多数图床/直链都这样）→ fetch 会被拦，退回 <audio> 直连，
   *      能出声但没有频谱，呼吸律动交回内置节奏。
   */
  async loadUrl(url, name = '') {
    this.ensureContext();
    this.stop();
    this.lastError = null;
    this.name = name || decodeURIComponent((url.split('/').pop() || '').split('?')[0]).replace(/\.[^.]+$/, '');
    this.duration = 0;
    this.offset = 0;

    // A. 先试着取回来整首解码（同源代理 → 直连 CORS，能成哪个用哪个）
    const targets = [];
    const proxied = AudioEngine.proxyUrl(url);
    if (proxied) targets.push(proxied);
    targets.push(url);

    for (const target of targets) {
      try {
        const res = await fetch(target, { mode: 'cors', credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (!blob.size) throw new Error('空响应');
        if (blob.size <= AudioEngine.decodeLimit()) {
          this.buffer = await this._decode(await blob.arrayBuffer());
          this.mode = 'buffer';
          this.duration = this.buffer.duration;
          this.analysable = true;
          return { duration: this.duration, mode: this.mode, analysable: true };
        }
        // 太大就当作本地文件走 blob + element（同源，仍可分析）
        await this._loadElement(new File([blob], 'remote.mp3', { type: blob.type || 'audio/mpeg' }));
        this.mode = 'element';
        return { duration: this.duration, mode: this.mode, analysable: true };
      } catch (err) {
        this.lastError = err;
        this.buffer = null;
      }
    }

    console.warn('[audio] 取不到可解码的音频（多半是没开 CORS 且没有本地代理），改为直连播放', this.lastError);

    // B. 直连 <audio>：能出声，读不到频谱
    const el = this._ensureEl(false);
    el.src = url;
    await this._waitMeta(el);
    this.duration = isFinite(el.duration) ? el.duration : 0;
    this.mode = 'element';
    this.analysable = false;
    return { duration: this.duration, mode: this.mode, analysable: false };
  }

  play(from = 0) {
    if (!this.buffer && !this.el) return false;
    this.ensureContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();

    if (this.mode === 'element') {
      const el = this.el;
      if (!el || !el.src) return false;
      try {
        const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
        el.currentTime = dur ? from % dur : 0;
      } catch (e) { /* 元数据还没就绪，忽略 */ }
      const p = el.play();
      if (p && p.catch) {
        p.catch((err) => {
          // 自动播放被拦截：把状态交回上层，按钮仍可再点一次
          console.warn('[audio] 播放被拦截', err);
          this.playing = false;
        });
      }
      this.offset = from;
      this.playing = true;
      return true;
    }

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
    if (this.el && !this.el.paused) {
      this.el.pause();
      this.offset = this.el.currentTime || 0;
    }
    this.playing = false;
  }

  stop() {
    this.stopSource();
    this.offset = 0;
  }

  toggle() {
    if (!this.buffer && !this.el) return false;
    if (this.playing) {
      this.stopSource();
      return false;
    }
    return this.play(this.offset);
  }

  currentTime() {
    if (this.mode === 'element' && this.el) return this.el.currentTime || 0;
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
    // 还没拿到交互授权时 AudioContext 是 suspended，此时频谱全是 0，
    // 交回内置律动画面才有呼吸感（用户点一下页面后就切到真频谱）
    if (!this.ctx || this.ctx.state !== 'running') return null;
    // 跨域直连的曲子接不进 analyser，读出来只会是静音数据，交回内置律动
    if (!this.analysable) return null;
    // 流式模式下用户可能用系统控件暂停，此时交回内置律动
    if (this.mode === 'element' && (!this.el || this.el.paused)) return null;
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
