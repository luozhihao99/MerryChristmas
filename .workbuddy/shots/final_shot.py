# -*- coding: utf-8 -*-
"""收尾检查：等首屏真正收遮罩、确认无报错，再拍一张高分辨率成品图。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-fn-{PORT}"
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

ws = websocket.create_connection(ws_url, timeout=180)
_id = [0]
errors = []


def cmd(m, p=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": m, "params": p or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("method") == "Runtime.exceptionThrown":
            errors.append(msg["params"]["exceptionDetails"].get("text"))
        if msg.get("id") == _id[0]:
            return msg.get("result", {})


def ev(e):
    r = cmd("Runtime.evaluate", {"expression": e, "returnByValue": True, "userGesture": True})
    if r.get("exceptionDetails"):
        return "ERR " + str(r["exceptionDetails"].get("exception", {}).get("description"))[:400]
    return r["result"].get("value")


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride",
    {"width": 1440, "height": 900, "deviceScaleFactor": 1.5, "mobile": False})
t0 = time.time()
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")

ready = None
for _ in range(200):
    time.sleep(0.3)
    if ev("!!(window.__app && window.__app.bootState && window.__app.bootState.finished)"):
        ready = round(time.time() - t0, 2)
        break

print("遮罩收起:", ready, "秒")
print("状态:", ev("""(()=>{const b=window.__app.bootState;return JSON.stringify({
  finished:b.finished, rig:+b.rig.toFixed(2), model:b.model,
  cam: window.__app.gesture.cameraReady === undefined ? null : window.__app.gesture.cameraReady,
});})()"""))
print("地台对象:", ev("(()=>{const g=window.__app.groundBase;return JSON.stringify({pool:!!g.pool,lights:g.baseLights.length,nebula:g.nebula.geometry.attributes.position.count,haze:g.haze.geometry.attributes.position.count});})()"))

# 拍成品图：把首屏残留的卡片和探针收掉（?debug 会打开探针）
ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const m = document.getElementById('musicPrompt'); if (m) { m.classList.remove('show'); m.hidden = true; }
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  return 'ok';
})()""")
time.sleep(3.2)
r = cmd("Page.captureScreenshot", {"format": "png"})
open("fn-final.png", "wb").write(base64.b64decode(r["data"]))
im = Image.open("fn-final.png").convert("RGB")
print("size", im.size)
im.resize((1440, 900), Image.LANCZOS).save("fn-final-1440.png")
im.crop((300, int(im.height * 0.68), im.width - 300, im.height)).save("fn-final-base.png")
print("报错:", errors[:5])
ws.close()
proc.terminate()
