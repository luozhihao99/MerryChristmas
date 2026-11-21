/**
 * 模型预取入口。
 *
 * 为什么单独开一个模块、还在 <head> 里加载它：
 *   首帧建场（建树、编译着色器）会把主线程堵死近一秒，这期间任何 JS 发出的请求
 *   都只能排队。早先的做法是在 main.js 里 prefetch，实测模型请求被推到 +1.3s；
 *   后来试过 <link rel=preload as=fetch>，确实能提前到 +13ms，但预载拿不到流式进度，
 *   进度条只能一直卡着、等下载完一次性跳到 100%，而且和后面的 fetch 稍有出入
 *   就会把 7.6MB 下两遍。
 *
 *   这个入口只有 3KB 依赖（assetLoader），会比 main.js（要等 163KB 的 three）
 *   早几百毫秒执行，于是：请求早发、进度是真的、且只下载一次。
 */
import { prefetchHandModel } from './assetLoader.js';

/** 首屏建场前就能用摄像头吗（https / localhost）。不能用就没必要花 7.6MB 流量 */
const cameraPossible =
  window.isSecureContext && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

let last = { phase: 'model', loaded: 0, total: 0 };
const subs = new Set();

function emit(p) {
  last = { ...last, ...p };
  for (const fn of subs) {
    try { fn(last); } catch (err) { console.warn('[model] 进度回调出错', err); }
  }
}

/** 订阅下载进度；订阅时先补发一次当前状态，晚订阅的调用方也不会漏 */
export function onModelProgress(fn) {
  subs.add(fn);
  fn(last);
  return () => subs.delete(fn);
}

/** 下载 promise：成功给 { wasmBase, modelBuffer, ... }，失败给 null（交给 MediaPipe 自己加载） */
export const modelJob = cameraPossible
  ? prefetchHandModel({ onProgress: emit })
  : Promise.resolve(null);

export { cameraPossible };
