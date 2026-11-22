# -*- coding: utf-8 -*-
"""spread 屏蔽 / 拖拽扇风 / 点击烟花 三件事一次验完。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-pf-{PORT}"
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


def pev(kind, x, y):
    return ev(f"""(() => {{
      window.dispatchEvent(new PointerEvent('{kind}', {{
        clientX: {x}, clientY: {y}, bubbles: true, pointerId: 7,
      }}));
      return 'ok';
    }})()""")


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

ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const st = document.createElement('style');
  st.textContent = '#musicPrompt{display:none!important}';
  document.head.appendChild(st);
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  return 'ok';
})()""")
time.sleep(2.4)

# ---- 1. spread 屏蔽：开关关掉时 GestureController 必须永远输出 null ----
# （屏蔽在 controller 内部，外面伪造 spread 绕过它，测不到那行代码）
print(ev("""(() => {
  const a = window.__app;
  a.gesture.update = () => ({ hands: [], handCount: 2, spread: null, tray: null, heart: null, bow: null });
  const cfg = a.gesture.constructor;
  return [
    !!cfg.prototype._computeSpread,
    a.gesture.state.spread,
    document.querySelector('.hint[data-k=spread]').hidden,
  ];
})()"""))

# ---- 2. 拖拽扇风：按住往右快速拖 ----
ev("window.__app.gesture.update = () => ({ hands: [], handCount: 0, spread: null, tray: null, heart: null, bow: null })")
pev('pointerdown', 400, 450)
for i in range(12):
    pev('pointermove', 400 + i * 45, 450)
    time.sleep(0.03)
print("during drag:", ev("[window.__app.router.pointerDown, window.__app.router.pointerVX.toFixed(2), window.__app.router.spinVel.toFixed(2), window.__app.router.spin.toFixed(3)]"))
time.sleep(0.25)
spin_after = ev("window.__app.router.spin.toFixed(3)")
pev('pointerup', 940, 450)
time.sleep(0.5)
print("spin inertia:", spin_after, "->", ev("window.__app.router.spin.toFixed(3)"),
      "vx decayed:", ev("window.__app.router.pointerVX.toFixed(2)"))

# 惯性转一会儿再拍一张对照
time.sleep(0.5)

# ---- 3. 点击烟花：快速点一下（位移 0）----
print("t0 before:", ev("[window.__app.clickBurst.time.toFixed(2), window.__app.clickBurst.mat.uniforms.uStart.value[0].toFixed(2)]"))
pev('pointerdown', 720, 430)
time.sleep(0.05)
pev('pointerup', 720, 430)
time.sleep(0.12)
print("t0 after tap:", ev("[window.__app.clickBurst.time.toFixed(2), window.__app.clickBurst.mat.uniforms.uStart.value[0].toFixed(2)]"))
im0 = shot("pf-a0-flash.png")   # 炸开后约 0.06s：验证没有方形亮块
# 爆心区域亮度统计（应为一团球状粒子光，而不是顶格的方形白块）
crop = im0.crop((620, 330, 820, 530)).convert("L")
px = list(crop.getdata())
print("burst region: mean", round(sum(px) / len(px), 1), "max", max(px),
      "over240:", sum(1 for v in px if v > 240))
time.sleep(0.12)
shot("pf-a-firework.png")

# 点按钮不应炸烟花（对照 aT0，time 是一直前进的时钟读数）
t0_btn = ev("window.__app.clickBurst.mat.uniforms.uStart.value[0].toFixed(2)")
ev("document.getElementById('btnHints').dispatchEvent(new MouseEvent('click', {bubbles:true})), 'ok'")
time.sleep(0.3)
print("button click no firework:", ev("[window.__app.clickBurst.mat.uniforms.uStart.value[0].toFixed(2), document.getElementById('hints').hidden]"), "was", t0_btn)

# ---- 4. 烟花后半段（粒子下落淡出）----
time.sleep(0.9)
shot("pf-b-fall.png")

print("errors:", errors[:3])
ws.close()
proc.terminate()
