/**
 * 手势模型资源加载层。
 *
 * 解决三件事：
 * 1. 并行：模型（7.6MB）在场景构建之前就开始下载，不再等 wasm 加载完再排第二个请求。
 * 2. 缓存：下载过的模型写进 IndexedDB，第二次打开直接读盘，不再走网络。
 * 3. 双源：本地 vendor/ 与 jsdelivr CDN 互为备份，任何一个失败自动换另一个。
 *
 * 来源选择：
 *   ?src=local  强制本地
 *   ?src=cdn    强制 CDN
 *   ?src=auto   先试 CDN，失败回落本地
 *   默认：localhost / 127.0.0.1 用本地，其它域名用 auto
 */

const MODEL_VERSION = 'hand_landmarker-f16-1';   // 换模型时改这个，旧缓存自动失效

const SOURCES = {
  local: {
    wasmBase: './vendor/mediapipe/wasm',
    modelUrl: './assets/hand_landmarker.task',
  },
  cdn: {
    wasmBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
    modelUrl:
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  },
};

const isLocalHost = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);

function readMode() {
  const p = new URLSearchParams(location.search).get('src');
  if (p === 'local' || p === 'cdn' || p === 'auto') return p;
  return isLocalHost ? 'local' : 'auto';
}

/* ---------------- IndexedDB 缓存 ---------------- */

const DB_NAME = 'mp-model-cache';
const DB_STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;   // 隐私模式 / 存储被禁，直接当没缓存
  }
}

async function cachePut(key, buffer) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(buffer, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* 存不进去就算了，不影响使用 */
  }
}

/* ---------------- 下载 ---------------- */

async function download(url, onProgress) {
  // credentials 用默认的 same-origin，不要写 'omit'：
  // index.html 里 <link rel=preload as=fetch crossorigin="anonymous"> 对应的是
  // 「CORS + same-origin 凭据」。两边凭据模式对不上，浏览器就不会复用预取，
  // 结果是同一个 7.6MB 模型被下载两遍（实测 +19ms 一次、+1.4s 又一次）。
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status} · ${url}`);

  // 服务端开了 gzip 时 content-length 是压缩后大小，不能当总量用
  const encoded = res.headers.get('content-encoding');
  const declared = Number(res.headers.get('x-uncompressed-length') || 0);
  const total = encoded ? declared : Number(res.headers.get('content-length') || 0);

  if (!res.body) {
    const buf = await res.arrayBuffer();
    onProgress?.({ loaded: buf.byteLength, total: buf.byteLength });
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.({ loaded, total });
  }

  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out.buffer;
}

/* ---------------- wasm 预热 ---------------- */

/**
 * MediaPipe 内部会先拉 wasm（9.2MB）再拉模型，默认是串行的。
 * 这里提前把 wasm 读进浏览器缓存，让它在建树期间就开始下载；
 * 只有服务端明确给了长缓存头才做，否则可能白下载一遍（移动端流量代价太大）。
 */
async function warmWasm(base) {
  try {
    const probe = await fetch(`${base}/vision_wasm_internal.wasm`, { method: 'HEAD' });
    if (!probe.ok) return false;
    const cc = probe.headers.get('cache-control') || '';
    if (!/max-age=\d{3,}/.test(cc) && !/immutable/.test(cc)) return false;

    for (const file of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
      // 只读不存，避免占住 9MB 内存
      fetch(`${base}/${file}`)
        .then(async (res) => {
          if (!res.body) return;
          const reader = res.body.getReader();
          while (!(await reader.read()).done) { /* 读空即止 */ }
        })
        .catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 对外接口 ---------------- */

/**
 * 预取手势模型。失败时返回 null，调用方可以退回 MediaPipe 自带的路径加载。
 * 返回 { wasmBase, modelBuffer, fromCache, source }
 */
export async function prefetchHandModel({ onProgress } = {}) {
  const mode = readMode();
  const order = mode === 'cdn' ? ['cdn', 'local'] : mode === 'local' ? ['local', 'cdn'] : ['cdn', 'local'];
  const primary = SOURCES[mode === 'cdn' ? 'cdn' : 'local'];

  // wasm 预热与模型下载并行
  warmWasm(primary.wasmBase);

  // 缓存读盘只给 60ms 的机会，拿不到就直接走网络。
  // 早先是「先 await 读 IndexedDB，再下模型」——IDB 冷启动要几百毫秒，
  // 主线程又被建场卡着，实测模型请求被推到 +1.3s 才开始，等于白等一整个首屏。
  // 现在就两条路同时跑：命中缓存（热启动）就用缓存，否则网络。
  // 另外 /assets 带 immutable 缓存头，重复访问时浏览器自己的 HTTP 缓存本来就是零请求，
  // 所以这个竞速不会造成重复下载。
  const cached = await Promise.race([
    cacheGet(MODEL_VERSION),
    new Promise((r) => setTimeout(() => r(null), 60)),
  ]);
  if (cached) {
    onProgress?.({ phase: 'model', loaded: cached.byteLength, total: cached.byteLength, fromCache: true });
    return { ...primary, modelBuffer: cached, fromCache: true, source: 'cache' };
  }

  let lastErr = null;
  for (const name of order) {
    const src = SOURCES[name];
    try {
      const modelBuffer = await download(src.modelUrl, (p) => onProgress?.({ phase: 'model', ...p }));
      cachePut(MODEL_VERSION, modelBuffer);
      return { ...src, modelBuffer, fromCache: false, source: name };
    } catch (err) {
      lastErr = err;
      console.warn(`[assets] ${name} 模型下载失败，尝试备用源`, err);
    }
  }
  console.warn('[assets] 所有来源都失败，交给 MediaPipe 走默认加载', lastErr);
  return null;
}
