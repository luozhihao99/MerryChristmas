# -*- coding: utf-8 -*-
"""同页三档点光强度对比：地台亮度到底该给多少。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-gt-{PORT}"
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
    if ev("!!(window.__app && window.__app.groundBase)"):
        break

ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const m = document.getElementById('musicPrompt'); if (m) m.style.display = 'none';
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  const g = window.__app.groundBase;
  g._pin = 0;
  const orig = g.update.bind(g);
  g.update = function (dt, t, params) {
    orig(dt, t, params);
    if (g._pin) for (const l of this.baseLights) l.intensity = g._pin;
  };
  return 'ok';
})()""")
time.sleep(2.4)

tiles = []
for v, name in ((8, "gt-008.png"), (14, "gt-014.png"), (22, "gt-022.png")):
    ev(f"window.__app.groundBase._pin = {v}")
    time.sleep(0.5)
    im = shot(name)
    crop = im.crop((330, 660, 1110, 900))
    tiles.append((v, crop))
    px = crop.resize((120, 37))
    d = list(px.getdata())
    print(name, tuple(round(sum(c[i] for c in d) / len(d), 1) for i in range(3)))

W = tiles[0][1].width
H = tiles[0][1].height
sheet = Image.new("RGB", (W, H * 3 + 12), (0, 0, 0))
for i, (v, crop) in enumerate(tiles):
    sheet.paste(crop, (0, i * (H + 6)))
sheet.save("gt-stack.png")
print("gt-stack.png", sheet.size)

ws.close()
proc.terminate()
