# -*- coding: utf-8 -*-
"""验证「流式加载」真的生效：元数据到就播，不等整首下完。"""
import json
import os
import random
import shutil
import subprocess
import time
import urllib.request

import websocket

PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-stream-{PORT}"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
URL = "http://127.0.0.1:8123/index.html?debug"

shutil.rmtree(PROFILE, ignore_errors=True)
proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
    f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", "--window-size=1440,900",
    "about:blank",
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
    r = cmd("Runtime.evaluate", {
        "expression": expr, "returnByValue": True,
        "awaitPromise": await_promise, "userGesture": True,
    })
    if r.get("exceptionDetails"):
        return {"__err": str(r["exceptionDetails"].get("exception", {}).get("description"))}
    return r["result"].get("value")


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Page.navigate", {"url": URL})

for i in range(60):
    ok = ev("!!(window.__app && window.__app.audio)", await_promise=False)
    if ok:
        print("app ready after", round(i * 0.5, 1), "s")
        break
    time.sleep(0.5)

# ---- 1. 带 CORS 的直连 ----
print("=== CORS 直连 ===")
print(ev("""
(async () => {
  const a = window.__app.audio;
  const t0 = performance.now();
  const phases = [];
  const res = await a.loadUrl('http://127.0.0.1:8199/cors/tone.wav', 'mock', {
    onPhase: (p, i) => phases.push(p + '/' + i.via + '@' + Math.round(performance.now() - t0)),
  });
  const tMeta = performance.now() - t0;
  const el = a.el;
  const bufAtMeta = el.buffered.length ? el.buffered.end(0) : 0;
  const t1 = performance.now();
  a.play(0);
  const tPlay = performance.now() - t1;
  await new Promise(r => setTimeout(r, 1200));
  return JSON.stringify({
    res, phases,
    metaMs: Math.round(tMeta), playMs: Math.round(tPlay),
    duration: +el.duration.toFixed(1),
    bufAtMeta: +bufAtMeta.toFixed(2),
    bufNow: el.buffered.length ? +el.buffered.end(0).toFixed(2) : 0,
    readyState: el.readyState,
    paused: el.paused, playing: a.playing,
    mode: a.mode, analysable: a.analysable,
  }, null, 0);
})()
"""))

print("频谱:", ev("""
(() => { const f = window.__app.audio.getFrame();
  return f ? JSON.stringify({ low: Math.round(f.low), body: Math.round(f.body), rms: Math.round(f.rms) }) : 'null'; })()
""", await_promise=False))

time.sleep(2.2)
print("2s 后:", ev("""
(() => { const a = window.__app.audio, el = a.el;
  return JSON.stringify({ cur: +el.currentTime.toFixed(2),
    buf: el.buffered.length ? +el.buffered.end(0).toFixed(2) : 0,
    dur: +el.duration.toFixed(1), paused: el.paused }); })()
""", await_promise=False))

# ---- 2. 不带 CORS：应走本地代理 ----
print("=== 无 CORS（应走代理）===")
print(ev("""
(async () => {
  const a = window.__app.audio;
  const t0 = performance.now();
  const phases = [];
  const res = await a.loadUrl('http://127.0.0.1:8199/nocors/tone.wav', 'mock2', {
    onPhase: (p, i) => phases.push(p + '/' + i.via + '@' + Math.round(performance.now() - t0)),
  });
  const el = a.el;
  const bufAtMeta = el.buffered.length ? el.buffered.end(0) : 0;
  a.play(0);
  await new Promise(r => setTimeout(r, 900));
  return JSON.stringify({
    res, phases, metaMs: Math.round(performance.now() - t0),
    duration: +el.duration.toFixed(1), bufAtMeta: +bufAtMeta.toFixed(2),
    mode: a.mode, analysable: a.analysable, paused: el.paused,
    src: (el.src || '').slice(0, 48),
  });
})()
"""))

# 代理路径的频谱
print("代理频谱:", ev("""
(() => { const f = window.__app.audio.getFrame();
  return f ? JSON.stringify({ low: Math.round(f.low), rms: Math.round(f.rms) }) : 'null'; })()
""", await_promise=False))

print("errors:", ev("JSON.stringify(window.__errors || [])", await_promise=False))

a = ev("""(() => { const a = window.__app.audio; a.stop(); return 'stopped'; })()""", await_promise=False)
ws.close()
proc.terminate()
print("done")
