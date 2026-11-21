# -*- coding: utf-8 -*-
"""双手拉弓：拉弦形变 / 放箭 / 穿心粒子，三个阶段各拍一张。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-bw-{PORT}"
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


def cmd(m, p=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": m, "params": p or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("method") == "Runtime.exceptionThrown":
            errors.append(str(msg["params"]["exceptionDetails"].get("exception", {}).get("description"))[:300])
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
    if ev("!!(window.__app && window.__app.archery)"):
        break

# 干净画面
print(ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const st = document.createElement('style');
  st.textContent = '#musicPrompt{display:none!important}';
  document.head.appendChild(st);
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  return 'ok';
})()"""))
time.sleep(2.6)

# 用假的手势状态驱动拉弓（headless 里没有真手）
print(ev("""(() => {
  const a = window.__app;
  window.__bow = { on: false, pull: 0 };
  a.gesture.update = () => ({
    hands: [], handCount: 2, spread: null, tray: null,
    heart: { active: false, strength: 0 },
    bow: { active: window.__bow.on, pull: window.__bow.pull, sep: 3.2, level: 0.3, grip: 0.7 },
  });
  // 记下主循环的 t，方便手动放箭
  const orig = a.archery.update.bind(a.archery);
  a.archery.update = (dt, t, s, p) => { window.__t = t; return orig(dt, t, s, p); };
  return 'hooked';
})()"""))
time.sleep(0.6)

# 1) 半拉
ev("window.__bow.on = true; window.__bow.pull = 0.45")
time.sleep(0.9)
shot("bw-a-half.png")

# 2) 拉满
ev("window.__bow.pull = 1.0")
time.sleep(1.0)
shot("bw-b-full.png")
print("vis/pull:", ev("[window.__app.archery.vis, window.__app.archery.pull, window.__app.archery.nockX]"))

# 3) 放箭（把飞行时间拉长到 1.8 秒，截图才有机会落在飞行中段）
ev("window.__bow.on = false; window.__bow.pull = 0; window.__app.archery.trigger(window.__t, 1); window.__app.archery.flight.dur = 1.8")
time.sleep(0.55)
shot("bw-c-fly.png")
print("mid:", ev("[!!window.__app.archery.flight, window.__app.archery.arrowGroup.position.x]"))

# 4) 命中：直接把飞行推到终点，抓命中后 0.15 秒
ev("const a = window.__app.archery; a.flight.t0 = window.__t - 3")
time.sleep(0.12)
print("killed at:", ev("[window.__app.archery.heartKill, window.__app.archery.heartAlive, window.__app.archery.burst.visible]"))
shot("bw-d-hit.png")

time.sleep(0.75)
shot("bw-e-scatter.png")

print("errors:", errors[:3])
ws.close()
proc.terminate()
