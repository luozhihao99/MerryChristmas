# -*- coding: utf-8 -*-
"""树顶星星缩小 + 树底频谱水波纹 验证。"""
import base64
import json
import random
import shutil
import subprocess
import time
import urllib.request

import websocket
from PIL import Image

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-sr-{PORT}"
shutil.rmtree(PROFILE, ignore_errors=True)

proc = subprocess.Popen(
    [CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
     f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
     "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream",
     "--use-fake-device-for-media-stream", "--window-size=1440,900", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ws_url = None
for _ in range(80):
    try:
        tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list"))
        p = [t for t in tabs if t.get("type") == "page"]
        if p:
            ws_url = p[0]["webSocketDebuggerUrl"]
            break
    except Exception:
        pass
    time.sleep(0.25)

ws = websocket.create_connection(ws_url, timeout=120)
_id = [0]
errors = []
console = []


def cmd(m, p=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": m, "params": p or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("method") == "Runtime.exceptionThrown":
            errors.append(str(msg["params"]["exceptionDetails"].get("exception", {}).get("description"))[:300])
            continue
        if msg.get("method") == "Runtime.consoleAPICalled" and msg["params"].get("type") == "error":
            console.append(str(msg["params"].get("args", []))[:300])
            continue
        if msg.get("id") == _id[0]:
            return msg.get("result", {})


def ev(e):
    r = cmd("Runtime.evaluate", {"expression": e, "returnByValue": True, "userGesture": True})
    if r.get("exceptionDetails"):
        return "ERR " + str(r["exceptionDetails"].get("exception", {}).get("description"))[:400]
    return r["result"].get("value")


def shot(name):
    r = cmd("Page.captureScreenshot", {"format": "png"})
    open(name, "wb").write(base64.b64decode(r["data"]))
    im = Image.open(name).convert("RGB")
    print(" ", name, im.size)
    return im


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride",
    {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")

for _ in range(120):
    time.sleep(0.4)
    if ev("!!(window.__app && window.__app.ripple && window.__app.tree.star)"):
        break

ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const st = document.createElement('style');
  st.textContent = '#musicPrompt{display:none!important}';
  document.head.appendChild(st);
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  return 'ok';
})()""")
time.sleep(2.4)

# ---- 1. 星星尺寸 ----
print("star scales:", ev("[window.__app.tree.star.scale.x.toFixed(2), window.__app.tree.starGlow.scale.x.toFixed(2)]"))

# ---- 2. 无音乐：整层应淡出（uMaster -> 0），涟漪不触发 ----
m1 = ev("window.__app.ripple.mat.uniforms.uMaster.value")
time.sleep(3.5)
m2 = ev("window.__app.ripple.mat.uniforms.uMaster.value")
print("master fade out:", round(m1, 3), "->", round(m2, 3))
s1 = ev("[...window.__app.ripple.mat.uniforms.uSpec.value].slice(0,3)")
time.sleep(0.6)
s2 = ev("[...window.__app.ripple.mat.uniforms.uSpec.value].slice(0,3)")
print("idle spec frozen (no fake wave):", s1 == s2, s1)
print("idle ripples:", ev("[...window.__app.ripple.mat.uniforms.uRippleStart.value]"))
shot("sr-a-idle.png")

# ---- 3. 假频谱 + 假鼓点：uSpec 跟着走、涟漪触发 ----
ev("""(() => {
  const a = window.__app;
  let ph = 0;
  a._origGetFrame = a.audio.getFrame.bind(a.audio);
  a.audio.getFrame = () => {
    ph += 0.09;
    const spec = new Float32Array(64);
    for (let k = 0; k < 64; k++) {
      spec[k] = Math.max(0, Math.min(1,
        0.75 * Math.exp(-k * 0.06) + 0.30 * Math.abs(Math.sin(ph * 1.3 + k * 0.31))));
    }
    // 低频/RMS 脉冲化：BeatDetector 是「能量历史 + 自适应阈值」，常量过不了线
    const kick = Math.pow(Math.max(0, Math.sin(ph * 0.85)), 6);
    return { low: 100 + 150 * kick, body: 160, mid: 90, high: 60,
             rms: 90 + 110 * kick, spectrum: spec, hasAudio: true };
  };
  return 'ok';
})()""")
time.sleep(1.6)   # BeatDetector 有 600ms 起步保护 + 200ms 冷却，等它打出几拍
print("master fade in:", ev("window.__app.ripple.mat.uniforms.uMaster.value.toFixed(3)"))
print("fake spec ->", ev("[...window.__app.ripple.mat.uniforms.uSpec.value].slice(0,4).map(v=>v.toFixed(3))"))
print("ripple starts:", ev("[...window.__app.ripple.mat.uniforms.uRippleStart.value].map(v=>v.toFixed(2))"))
print("ripple pows:", ev("[...window.__app.ripple.mat.uniforms.uRipplePow.value].map(v=>v.toFixed(2))"))
shot("sr-b-spec.png")
time.sleep(0.8)
shot("sr-c-ripple.png")

# ---- 4b. 暂停音乐：master 应开始回落 ----
ev("window.__app.audio.getFrame = window.__app._origGetFrame")
time.sleep(2.0)
print("master after pause:", ev("window.__app.ripple.mat.uniforms.uMaster.value.toFixed(3)"))

# ---- 4. 对称性 + 两层环存在性 ----
print("theta/ring:", ev("""(() => {
  const g = window.__app.ripple.points.geometry;
  const th = g.attributes.aTheta.array, rg = g.attributes.aRing.array;
  let outer = 0, inner = 0, ringPts = 0;
  for (let i = 0; i < rg.length; i++) {
    if (rg[i] === -1) outer++;
    else if (rg[i] === -2) inner++;
    else ringPts++;
  }
  return [outer, inner, ringPts];
})()"""))

ev("window.__app.audio.getFrame = window.__app._origGetFrame")

# ---- 5. 涟漪兜底：手动灌一发 hit（tick 不会清 uRippleStart，能存活）----
ev("""(() => {
  const a = window.__app;
  a.ripple.update(a.ripple.mat.uniforms.uTime.value, null, { pulse: 1, hit: true });
  return [...a.ripple.mat.uniforms.uRippleStart.value].map(v => v.toFixed(2));
})()""")
time.sleep(0.5)
print("ripple after manual hit:", ev("[...window.__app.ripple.mat.uniforms.uRippleStart.value].map(v=>v.toFixed(2))"))
shot("sr-d-ripple2.png")

# ---- 6. 底部亮度统计（水波纹不能糊成一团）----
im = Image.open("sr-b-spec.png").convert("L")
w, h = im.size
crop = im.crop((int(w*0.22), int(h*0.72), int(w*0.78), int(h*0.95)))
px = list(crop.getdata())
print("base region mean:", round(sum(px)/len(px), 1), "max:", max(px))

print("errors:", errors[:3])
print("console errors:", console[:5])
ws.close()
proc.terminate()
