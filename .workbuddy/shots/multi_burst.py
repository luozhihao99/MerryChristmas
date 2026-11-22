# -*- coding: utf-8 -*-
"""多朵点击烟花同放 + 水波纹亮度中间档 复验。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-mb-{PORT}"
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
            console.append(str(msg["params"].get("args", []))[:200])
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


def pev(kind, x, y):
    return ev(f"""(() => {{
      window.dispatchEvent(new PointerEvent('{kind}', {{
        clientX: {x}, clientY: {y}, bubbles: true, pointerId: 7,
      }}));
      return 'ok';
    }})()""")


def tap(x, y):
    pev('pointerdown', x, y)
    time.sleep(0.04)
    pev('pointerup', x, y)


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride",
    {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")

for _ in range(120):
    time.sleep(0.4)
    if ev("!!(window.__app && window.__app.clickBurst && window.__app.ripple)"):
        break

ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const st = document.createElement('style');
  st.textContent = '#musicPrompt{display:none!important}';
  document.head.appendChild(st);
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  return 'ok';
})()""")
time.sleep(2.2)

# ---- 1. 连点 3 下（不同位置）：uStart 应占 3 个槽且值各不相同 ----
t0 = ev("window.__app.clickBurst.time.toFixed(2)")
tap(560, 380)
tap(880, 430)
tap(720, 560)
time.sleep(0.1)
print("starts:", ev("[...window.__app.clickBurst.mat.uniforms.uStart.value].map(v=>v.toFixed(2))"))
print("sizes:", ev("[...window.__app.clickBurst.mat.uniforms.uSize.value]"))
shot("mb-a-three.png")

# ---- 2. 1 秒后：3 朵都还在生命周期内（寿命 2.1s），槽位未变 ----
time.sleep(1.0)
shot("mb-b-later.png")

# ---- 3. 连点 5 下：第 5 下循环回槽 0（重放最早那朵）----
for x, y in [(500, 500), (960, 380)]:
    tap(x, y)
time.sleep(0.05)
print("after 5 taps starts:", ev("[...window.__app.clickBurst.mat.uniforms.uStart.value].map(v=>v.toFixed(2))"))

# ---- 4. 水波纹亮度中间档（假频谱淡入后测底区亮度）----
ev("""(() => {
  const a = window.__app;
  let ph = 0;
  a._orig = a.audio.getFrame.bind(a.audio);
  a.audio.getFrame = () => {
    ph += 0.09;
    const spec = new Float32Array(64);
    for (let k = 0; k < 64; k++) {
      spec[k] = Math.max(0, Math.min(1,
        0.75 * Math.exp(-k * 0.06) + 0.30 * Math.abs(Math.sin(ph * 1.3 + k * 0.31))));
    }
    return { low: 100, body: 160, mid: 90, high: 60, rms: 120,
             spectrum: spec, hasAudio: true };
  };
  return 'ok';
})()""")
time.sleep(2.0)
print("master:", ev("window.__app.ripple.mat.uniforms.uMaster.value.toFixed(3)"))
ev("window.__app.audio.getFrame = window.__app._orig")
im = shot("mb-c-ripple.png")
w, h = im.size
crop = im.crop((int(w*0.18), int(h*0.62), int(w*0.82), int(h*0.98))).convert("L")
px = list(crop.getdata())
print("base mean:", round(sum(px)/len(px), 1), "max:", max(px))
crop2 = Image.open("mb-c-ripple.png").crop((int(w*0.18), int(h*0.62), int(w*0.82), int(h*0.98)))
crop2.resize((int(w*0.64*1.4), int(h*0.36*1.4))).save("mb-c-ripple_crop.png")

print("errors:", errors[:3])
print("console:", console[:4])
ws.close()
proc.terminate()
