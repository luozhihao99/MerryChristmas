# -*- coding: utf-8 -*-
"""检查地台 / 接触阴影 / 前景光斑：全套、关地台、关前景各一张，再裁树底放大。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-gb-{PORT}"
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
            errors.append(str(msg["params"]["exceptionDetails"].get("text")))
        if msg.get("id") == _id[0]:
            return msg.get("result", {})


def ev(e):
    r = cmd("Runtime.evaluate", {"expression": e, "returnByValue": True, "userGesture": True})
    if r.get("exceptionDetails"):
        return "ERR " + str(r["exceptionDetails"].get("exception", {}).get("description"))[:300]
    return r["result"].get("value")


def shot(name):
    r = cmd("Page.captureScreenshot", {"format": "png"})
    data = base64.b64decode(r["data"])
    open(name, "wb").write(data)
    print("  ", name)
    return Image.open(name).convert("RGB")


cmd("Page.enable")
cmd("Runtime.enable")
# headless 新窗口的实际视口比 --window-size 小一圈（1422×748），裁切坐标会全错。
# 用 Emulation 钉死成 1440×900，截图与 CSS 像素一一对应。
cmd("Emulation.setDeviceMetricsOverride",
    {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")

for _ in range(120):
    time.sleep(0.4)
    if ev("!!(window.__app && window.__app.groundBase && window.__app.nearBokeh)"):
        break

print("ready:", ev("(()=>{const a=window.__app;return JSON.stringify({boot:a.bootState.finished, gb:!!a.groundBase, nb:!!a.nearBokeh});})()"))

ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const m = document.getElementById('musicPrompt'); if (m) m.style.display = 'none';
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  return 'ok';
})()""")
time.sleep(2.6)

a = shot("gb-a-all.png")
time.sleep(5.5)
a2 = shot("gb-a-all2.png")
ev("window.__app.groundBase.group.visible = false")
time.sleep(0.5)
b = shot("gb-b-noground.png")
ev("window.__app.groundBase.group.visible = true; window.__app.nearBokeh.points.visible = false")
time.sleep(0.5)
c = shot("gb-c-nobokeh.png")
ev("window.__app.nearBokeh.points.visible = true")

# 树底裁切放大
for name, img in (("gb-a-all.png", a), ("gb-b-noground.png", b)):
    crop = img.crop((350, 700, 1090, 900)).resize((1480, 400), Image.LANCZOS)
    out = name.replace(".png", "-base.png")
    crop.save(out)
    print("  ", out)
    tight = img.crop((420, 700, 640, 865)).resize((880, 660), Image.LANCZOS)
    out2 = name.replace(".png", "-gift.png")
    tight.save(out2)
    print("  ", out2)

# 数值对比：地台在不在，树底那片区域的平均亮度
def mean_region(img):
    px = img.crop((350, 700, 1090, 900)).resize((180, 48))
    d = list(px.getdata())
    return tuple(round(sum(c[i] for c in d) / len(d), 2) for i in range(3))

print("mean base  all:", mean_region(a))
print("mean base  off:", mean_region(b))
print("mean whole all:", mean_region(a) and None)
print("pageerrors:", errors[:4])
ws.close()
proc.terminate()
