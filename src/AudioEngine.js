/**
 * 音频源 + 频谱分析。
 *
 * 两种播放模式：
 *   element —— <audio> + MediaElementAudioSourceNode。**远端音频一律走这条**：
 *              元数据一到就能播，剩下的字节按 Range 边播边拉，内存只占几十 KB。
 *              能吃下浏览器能播的任何编码（m4a / mp3 / 长音频）。
 *   buffer  —— decodeAudioData 整首解码进内存。只给本地拖进来的**小文件**用：
 *              本地读盘本来就是毫秒级，换来的是无缝循环和精确定位。
 *
 * 为什么远端不 decode：手机上 decode 一首 5 分钟的歌要约 100MB AudioBuffer，
 * Safari 经常直接抛错或整页崩溃；而且必须先下完整个文件才能解码 ——
 * 那就是「加载很慢」的根源。流式只要前几十 KB 就能出声。
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
    this._seq = 0;               // 加载令牌：新加载 / 主动取消都会把它加一，旧的立刻作废
    this._pendingReject = null;
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

  /**
   * 可视化频谱：64 个对数分布的频点（55Hz ~ 8.2kHz），每个点取频段内最大值。
   * 对数分布符合听感（低频细分、高频粗分），树底水波纹按这 64 点取值；
   * 频点区间只依赖采样率，算一次缓存住。
   */
  _spectrumRanges() {
    if (this._specRanges) return this._specRanges;
    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const N = 64, lo = 55, hi = 8200;
    const ranges = [];
    for (let k = 0; k < N; k++) {
      const f0 = lo * Math.pow(hi / lo, k / N);
      const f1 = lo * Math.pow(hi / lo, (k + 1) / N);
      const b0 = Math.max(1, Math.round(f0 / binHz));
      const b1 = Math.max(b0 + 1, Math.min(this.analyser.frequencyBinCount - 1, Math.round(f1 / binHz)));
      ranges.push([b0, b1]);
    }
    this._specRanges = ranges;
    this.spectrum = new Float32Array(N);
    return ranges;
  }

  /** 触屏设备内存更紧，解码上限压得更低 */
  static decodeLimit() {
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    return touch ? 9 * 1024 * 1024 : 20 * 1024 * 1024;
  }

  /**
   * 同一个音频要不要先走本地服务器代理。
   * 直链不发 CORS 头时：直接挂 <audio crossorigin> 会被拦，跨域 <audio> 接进
   * Web Audio 又会被判成「污染」直接静音 —— 两条路都读不到频谱。
   * serve.py 提供了 /__audio 同源代理（透传 Range、边收边发），走它仍是流式。
   * 没起 serve.py（或部署到静态托管）时这个请求会 404 / 连不上，自动跳过。
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

  /** 主动放弃当前加载：页面等不了时说一声，别让三条路各耗 8 秒 */
  cancel() {
    this._seq += 1;
    this._dropEl();
    this.stop();
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
    this._dropEl();          // 若有远端加载还挂着，先掐掉，别让两条请求互相拆台
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
   *   同源（blob / 本地文件 / 本地代理）→ 接，能同时出声 + 分析频谱；
   *   跨域且没 CORS → 不能接，接了会被浏览器判成「污染」输出静音。
   * 同一个元素一旦接过 MediaElementAudioSourceNode 就退不回来，所以两种模式必须换元素。
   * crossOrigin 也要参与比较：先试 anonymous、失败再试不带 CORS 时，
   * 必须换一个干净的元素，否则旧的跨域状态会把新地址也判死。
   */
  _ensureEl(linked, crossOrigin = null) {
    const wantCO = crossOrigin || null;
    if (this.el && this.elLinked === linked && (this.el.crossOrigin || null) === wantCO) {
      return this.el;
    }
    this._dropEl();

    const el = new Audio();
    el.loop = true;
    el.preload = 'auto';
    el.volume = linked ? 1 : 0.9;
    if (wantCO) el.crossOrigin = wantCO;      // 必须在设 src 之前
    if (linked) {
      this.elSource = this.ctx.createMediaElementSource(el);
      this.elSource.connect(this.gain);
    }
    this.el = el;
    this.elLinked = linked;
    return el;
  }

  /** 丢弃当前 <audio>，并真正中止它挂起的请求（换地址 / 失败重试时用） */
  _dropEl() {
    // 先叫醒还在 _waitMeta 里等的人：元素一旦被拆，loadedmetadata / error
    // 都不会再来，不主动 reject 就得干等到超时（15 秒）。
    if (this._pendingReject) {
      const reject = this._pendingReject;
      this._pendingReject = null;
      reject(new Error('加载已被新的请求取代'));
    }
    if (!this.el) return;
    const el = this.el;
    try { el.pause(); } catch (e) { /* 忽略 */ }
    el.removeAttribute('src');
    try { el.load(); } catch (e) { /* 忽略：load() 才会中止在途请求 */ }
    if (this.elSource) {
      try { this.elSource.disconnect(); } catch (e) { /* 忽略 */ }
    }
    this.el = null;
    this.elSource = null;
    this.elLinked = false;
  }

  /** 等元数据就绪；已缓存的情况不会再次触发 loadedmetadata，所以先查 readyState */
  _waitMeta(el, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('读取音频信息超时'));
      }, timeout);
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => {
        cleanup();
        const e = new Error('浏览器无法播放这个文件');
        e.code = 'unsupported';
        reject(e);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this._pendingReject = null;
        el.removeEventListener('loadedmetadata', onReady);
        el.removeEventListener('error', onError);
      };
      // 被 _dropEl 打断时走这条，别等到超时
      this._pendingReject = (err) => { cleanup(); reject(err); };
      el.addEventListener('loadedmetadata', onReady);
      el.addEventListener('error', onError);
      if (el.readyState >= 1 && isFinite(el.duration) && el.duration > 0) onReady();
    });
  }

  /**
   * 把一个远端地址挂到 <audio> 上，只等元数据（不是等下载完）。
   * 元数据一到就返回：此刻 duration 已知、可以 play()，剩下的字节由浏览器
   * 按 Range 自己边播边拉 —— 这就是「流式」和「整首下完再播」的区别。
   */
  async _streamUrl(url, { crossOrigin = null, linked = true, timeout = 8000 } = {}) {
    const el = this._ensureEl(linked, crossOrigin);
    this.duration = 0;                        // 换地址了，旧时长立即作废
    el.src = url;
    try { el.load(); } catch (e) { /* 某些浏览器没有 load，忽略 */ }
    await this._waitMeta(el, timeout);
    this.duration = isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    this.mode = 'element';
    this.analysable = linked;
    return { duration: this.duration, mode: 'element', analysable: linked, streaming: true };
  }


  /**
   * 加载一个远端音频 URL（默认音乐走这条路）。
   *
   * **流式优先，绝不整首下完再播。** 先把地址挂到 <audio> 上，元数据一到就算就绪，
   * 用户一点立刻出声；剩下的字节由浏览器按 Range 自己边播边拉。
   * 以前那版是 fetch 成 Blob → decodeAudioData → 才播，等于「等整首 + 解码完」
   * 才开始，一首 2.3MB 的歌在慢网要卡十几秒。
   *
   * 三条路，按「快 → 稳」依次尝试：
   *   1. 直连 + crossorigin="anonymous"：COS / 任何配了 CORS 的 CDN。
   *      最快（少一跳），而且带 CORS 头的媒体接进 Web Audio 不算污染，频谱能读。
   *   2. 同源代理 /__audio：源站没发 CORS 头时的本地兜底（serve.py 透传 Range）。
   *   3. 裸直连（不带 crossorigin）：能出声，但元素被污染、读不到频谱，
   *      呼吸退回内置节拍。总比没声音好。
   *
   * opts.onPhase(phase, info)：'connect'（正在连某条路）/ 'ready'（可以播了）。
   * 流式下没有「下载百分比」可报 —— 起播只要前几十 KB，百分比反而误导人。
   */
  async loadUrl(url, name = '', opts = {}) {
    this.ensureContext();
    this.stop();
    this.lastError = null;
    this.name = name || decodeURIComponent((url.split('/').pop() || '').split('?')[0]).replace(/\.[^.]+$/, '');
    this.duration = 0;
    this.offset = 0;
    this.analysable = true;

    const seq = ++this._seq;
    const onPhase = typeof opts.onPhase === 'function' ? opts.onPhase : null;
    const emit = (phase, info) => {
      if (!onPhase) return;
      try { onPhase(phase, info); } catch (e) { /* UI 报错不该拖垮加载 */ }
    };

    const attempts = [];
    attempts.push({ via: 'direct-cors', url, crossOrigin: 'anonymous', linked: true });
    const proxied = AudioEngine.proxyUrl(url);
    if (proxied) attempts.push({ via: 'proxy', url: proxied, crossOrigin: null, linked: true });
    attempts.push({ via: 'direct-plain', url, crossOrigin: null, linked: false });

    for (const attempt of attempts) {
      if (seq !== this._seq) {
        throw Object.assign(new Error('加载已取消'), { code: 'cancelled' });
      }
      emit('connect', { via: attempt.via });
      try {
        const out = await this._streamUrl(attempt.url, {
          crossOrigin: attempt.crossOrigin,
          linked: attempt.linked,
          timeout: opts.timeout || 8000,
        });
        emit('ready', { via: attempt.via, duration: out.duration, analysable: out.analysable });
        return out;
      } catch (err) {
        this.lastError = err;
        this._dropEl();
        if (seq !== this._seq) {
          throw Object.assign(new Error('加载已取消'), { code: 'cancelled' });
        }
        console.warn(`[audio] ${attempt.via} 方式加载失败`, err);
      }
    }

    throw Object.assign(new Error('音频加载失败'), {
      code: 'unsupported',
      cause: this.lastError,
    });
  }

  play(from = 0) {
    if (!this.buffer && !this.el) return false;
    this.ensureContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();

    if (this.mode === 'element') {
      const el = this.el;
      if (!el || !el.src) return false;
      // 从头播时别去碰 currentTime：流式音频上这一下会触发一次 seek，
      // 浏览器得重新要一段数据才开始出声，白白多等一两百毫秒。
      if (from > 0) {
        try {
          const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
          el.currentTime = dur ? from % dur : 0;
        } catch (e) { /* 元数据还没就绪，忽略 */ }
      }
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

    // 64 点频谱（0..1），树底圆环水波纹的可视化数据源
    const ranges = this._spectrumRanges();
    const spec = this.spectrum;
    for (let k = 0; k < ranges.length; k++) {
      const b0 = ranges[k][0], b1 = ranges[k][1];
      let m = 0;
      for (let b = b0; b < b1; b++) if (this.freqData[b] > m) m = this.freqData[b];
      spec[k] = m / 255;
    }

    return { low, body, mid, high, rms, spectrum: spec, hasAudio: true };
  }
}
