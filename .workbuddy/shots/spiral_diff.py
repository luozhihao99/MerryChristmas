# -*- coding: utf-8 -*-
"""同一机位、同一时刻，只切 spiral 的可见性，量化它对画面的贡献。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-df-{PORT}"
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
        return "ERR " + str(r["exceptionDetails"].get("exception", {}).get("description"))[:300]
    return r["result"].get("value")


def shot(name):
    r = cmd("Page.captureScreenshot", {"format": "png"})
    open(name, "wb").write(base64.b64decode(r["data"]))


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")

for _ in range(100):
    time.sleep(0.4)
    if ev("!!(window.__app && window.__app.spiral)"):
        break

ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const m = document.getElementById('musicPrompt'); if (m) m.style.display = 'none';
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  return 'ok';
})()""")
# 冻住时间，保证两张只差 spiral 一层
ev("window.__freeze = true; window.__app.spiral ? 'ok' : 'no'")
time.sleep(2.5)

ev("window.__app.spiral.points.visible = true")
time.sleep(0.35)
shot("sp-on.png")
ev("window.__app.spiral.points.visible = false")
time.sleep(0.35)
shot("sp-off.png")

a = Image.open("sp-on.png").convert("L")
b = Image.open("sp-off.png").convert("L")
pa, pb = a.load(), b.load()
w, h = a.size
tot_d = 0
n = 0
hot = 0
for y in range(0, h, 2):
    for x in range(0, w, 2):
        d = pa[x, y] - pb[x, y]
        tot_d += d
        n += 1
        if d > 12:
            hot += 1
print(f"平均增亮 {tot_d / n:.2f} / 255   明显受影响的像素占比 {hot / n * 100:.2f}%")

ws.close()
proc.terminate()
