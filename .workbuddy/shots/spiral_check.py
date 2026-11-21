# -*- coding: utf-8 -*-
"""螺旋粒子配色/亮度对比：同一机位截横屏与竖屏各一张静帧。"""
import base64
import json
import random
import shutil
import subprocess
import sys
import time
import urllib.request

import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-sp-{PORT}"
shutil.rmtree(PROFILE, ignore_errors=True)

W, H = (1440, 900)
if len(sys.argv) > 1 and sys.argv[1] == "mobile":
    W, H = 414, 896

proc = subprocess.Popen(
    [CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
     f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
     "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream",
     "--use-fake-device-for-media-stream", f"--window-size={W},{H}", "about:blank"],
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
errs = []


def cmd(m, p=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": m, "params": p or {}}))
    while True:
        msg = json.loads(ws.recv())
        if "method" in msg and msg["method"] in ("Runtime.exceptionThrown", "Log.entryAdded"):
            errs.append(json.dumps(msg.get("params", {}), ensure_ascii=False)[:300])
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
    print("  shot", name)


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Log.enable")
cmd("Emulation.setDeviceMetricsOverride",
    {"width": W, "height": H, "deviceScaleFactor": 2 if W < 500 else 1, "mobile": W < 500})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")

for _ in range(100):
    time.sleep(0.4)
    if ev("!!(window.__app && window.__app.spiral)"):
        break

# 遮罩收起 + 挡住音乐卡与探针
ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const m = document.getElementById('musicPrompt'); if (m) m.style.display = 'none';
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  return 'ok';
})()""")
time.sleep(2.5)

print("spiral:", ev("""JSON.stringify({
  count: window.__app.spiral.points.geometry.attributes.aArm.count,
  inten: +window.__app.spiral.mat.uniforms.uIntensity.value.toFixed(3),
  size: window.__app.spiral.mat.uniforms.uSize.value,
  aspect: +window.__app.camera.aspect.toFixed(2)
})"""))
shot(f"sp-{'m' if W < 500 else 'w'}-after.png")

print("errs:", [e for e in errs if "videotolink" not in e][:3] or "none")
ws.close()
proc.terminate()
