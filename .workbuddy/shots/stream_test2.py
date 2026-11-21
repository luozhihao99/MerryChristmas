# -*- coding: utf-8 -*-
"""验证流式加载：用独立的 AudioEngine 实例，避免和页面后台预载抢元素。"""
import json
import os
import random
import shutil
import subprocess
import time
import urllib.request

import websocket

PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-stream{random.randint(100, 999)}"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

shutil.rmtree(PROFILE, ignore_errors=True)
proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
    f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--window-size=1440,900", "about:blank",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ws_url = None
for _ in range(80):
    try:
        tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list"))
        page = [t for t in tabs if t.get("type") == "page"]
        if page:
            ws_url = page[0]["webSocketDebuggerUrl"]
            break
    except Exception:
        pass
    time.sleep(0.25)

ws = websocket.create_connection(ws_url, timeout=90)
_id = [0]


def cmd(method, params=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id[0]:
            if "error" in msg:
                raise RuntimeError(msg["error"])
            return msg.get("result", {})


def ev(expr, await_promise=True):
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                 "awaitPromise": await_promise, "userGesture": True})
    if r.get("exceptionDetails"):
        return {"__err": str(r["exceptionDetails"].get("exception", {}).get("description"))}
    return r["result"].get("value")


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
time.sleep(3)

print("=== 1. CORS 直连（期望 via=direct-cors，几十~几百 ms 就就绪）===")
print(ev("""
(async () => {
  const { AudioEngine } = await import('/src/AudioEngine.js');
  window.__t = new AudioEngine();
  const a = window.__t;
  a.ensureContext();
  await a.ctx.resume();
  const t0 = performance.now();
  const phases = [];
  const res = await a.loadUrl('http://127.0.0.1:8199/cors/tone.wav', 'mock', {
    onPhase: (p, i) => phases.push(p + ':' + i.via + '@' + Math.round(performance.now() - t0) + 'ms'),
  });
  const tMeta = performance.now() - t0;
  const el = a.el;
  const bufAtMeta = el.buffered.length ? el.buffered.end(0) : 0;
  a.play(0);
  await new Promise(r => setTimeout(r, 1500));
  const f = a.getFrame();
  return JSON.stringify({
    via: res.mode + '/' + res.analysable, phases,
    metaMs: Math.round(tMeta),
    duration: +el.duration.toFixed(1),
    bufAtMeta: +bufAtMeta.toFixed(2),
    bufNow: el.buffered.length ? +el.buffered.end(0).toFixed(2) : 0,
    curTime: +el.currentTime.toFixed(2),
    paused: el.paused, readyState: el.readyState,
    freq: f ? { low: Math.round(f.low), rms: Math.round(f.rms) } : null,
  });
})()
"""))

time.sleep(1.5)
print("3s 后（还在播、肯定没下完）:", ev("""
(() => { const a = window.__t, el = a.el;
  return JSON.stringify({ cur: +el.currentTime.toFixed(2),
    buf: el.buffered.length ? +el.buffered.end(0).toFixed(2) : 0,
    dur: +el.duration.toFixed(1), paused: el.paused }); })()
""", await_promise=False))

print("=== 2. 无 CORS（期望降级到 proxy，仍然流式 + 有频谱）===")
print(ev("""
(async () => {
  const a = window.__t;
  a.stop();
  const t0 = performance.now();
  const phases = [];
  const res = await a.loadUrl('http://127.0.0.1:8199/nocors/tone.wav', 'mock2', {
    onPhase: (p, i) => phases.push(p + ':' + i.via + '@' + Math.round(performance.now() - t0) + 'ms'),
  });
  const el = a.el;
  const bufAtMeta = el.buffered.length ? el.buffered.end(0) : 0;
  a.play(0);
  await new Promise(r => setTimeout(r, 1200));
  const f = a.getFrame();
  return JSON.stringify({
    phases, metaMs: Math.round(performance.now() - t0),
    duration: +el.duration.toFixed(1), bufAtMeta: +bufAtMeta.toFixed(2),
    analysable: res.analysable, paused: el.paused,
    src: (el.src || '').replace('http://127.0.0.1:8123', '').slice(0, 56),
    freq: f ? { low: Math.round(f.low), rms: Math.round(f.rms) } : null,
  });
})()
"""))

print("=== 3. 并发第二次加载：旧请求应立即失败，而不是等 15 秒 ===")
print(ev("""
(async () => {
  const a = window.__t;
  a.stop();
  const t0 = performance.now();
  const first = a.loadUrl('http://127.0.0.1:8199/cors/tone.wav', 'a1', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 120));
  const second = a.loadUrl('http://127.0.0.1:8199/cors/tone.wav', 'a2', { timeout: 15000 });
  const [r1, r2] = await Promise.allSettled([first, second]);
  return JSON.stringify({
    first: r1.status + ':' + (r1.reason ? r1.reason.message : ''),
    second: r2.status,
    totalMs: Math.round(performance.now() - t0),
    playingSrc: (a.el && a.el.src || '').slice(-18),
  });
})()
"""))

print("errors:", ev("JSON.stringify(window.__errors || [])", await_promise=False))
ws.close()
proc.terminate()
print("done")
