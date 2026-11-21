# -*- coding: utf-8 -*-
"""前景光斑单独验形：把亮度临时拉满拍一张（看形状和分布），再拍正常一张。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-bk-{PORT}"
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


def cmd(m, p=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": m, "params": p or {}}))
    while True:
        msg = json.loads(ws.recv())
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
    return Image.open(name).convert("RGB")


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride",
    {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")
for _ in range(120):
    time.sleep(0.4)
    if ev("!!(window.__app && window.__app.nearBokeh)"):
        break

ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const m = document.getElementById('musicPrompt'); if (m) m.style.display = 'none';
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  const b = window.__app.nearBokeh;
  b._pin = 0;
  const orig = b.update.bind(b);
  b.update = function (dt, t, params, cam) {
    orig(dt, t, params, cam);
    if (b._pin) this.mat.uniforms.uIntensity.value = b._pin;
  };
  // 把它们钉在几个固定位置，方便看形状
  const g = b.points.geometry;
  b._freeze = true;
  return 'ok';
})()""")
time.sleep(2.4)

# 只看光斑：把树 / 地台 / 雪全藏掉，背景压黑，避免被别的东西干扰判断
ev("""(() => {
  const a = window.__app;
  a.tree.group.visible = false;
  a.groundBase.group.visible = false;
  a.effects.snow.visible = false;
  a.effects.skyStars.visible = false;
  a.spiral.points.visible = false;
  a.effects.scene.background.setHex(0x04060a);
  return 'ok';
})()""")
time.sleep(0.5)

# 1) 形状验证：亮度拉满、时间冻结在某一刻（位置由 aY 决定，冻结不了就多拍几张取一张）
ev("window.__app.nearBokeh._pin = 1.0")
time.sleep(0.5)
im = shot("bk-a-bright.png")

ev("window.__app.nearBokeh._pin = 0.40")
time.sleep(0.5)
im2 = shot("bk-b-normal.png")

# 找出图上最亮的 200x200 区，裁出来看形状（不装 numpy，用 PIL 缩图取平均）
small = im2.convert("L").resize((144, 90))
px = list(small.getdata())
best = (0, 0, -1)
W = 20
for gy in range(0, 90 - W):
    for gx in range(0, 144 - W):
        tot = 0
        for yy in range(gy, gy + W):
            row = yy * 144
            tot += sum(px[row + gx: row + gx + W])
        avg = tot / (W * W)
        if avg > best[2]:
            best = (gx, gy, avg)
gx, gy, _ = best
x, y = gx * 10, gy * 10
print("brightest tile:", x, y, round(best[2], 1))
im2.crop((max(0, x - 60), max(0, y - 60), x + 260, y + 260)).resize((640, 640), Image.LANCZOS).save("bk-zoom.png")
print("bk-zoom.png")
im.resize((960, 600), Image.LANCZOS).save("bk-a-bright-small.png")

ws.close()
proc.terminate()
