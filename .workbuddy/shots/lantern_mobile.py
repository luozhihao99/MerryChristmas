# -*- coding: utf-8 -*-
"""竖屏：常驻螺旋粒子 + 孔明灯的适配情况。"""
import base64
import json
import os
import random
import shutil
import subprocess
import time
import urllib.request

import websocket

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)))
PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-ml-{PORT}"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

shutil.rmtree(PROFILE, ignore_errors=True)
proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
    f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", "--window-size=414,896", "about:blank",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ws_url = None
for _ in range(80):
    try:
        tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list"))
        page = [t for t in tabs if t.get("type") == "page"]
        if page:
            ws_url = page[0]["webSocketDebuggerUrl"]
            break
    except Exception:
        pass
    time.sleep(0.25)

ws = websocket.create_connection(ws_url, timeout=90)
_id = [0]
errors = []


def cmd(method, params=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if "method" in msg and msg["method"] in ("Runtime.exceptionThrown", "Log.entryAdded"):
            errors.append(json.dumps(msg.get("params", {}))[:400])
        if msg.get("id") == _id[0]:
            if "error" in msg:
                raise RuntimeError(msg["error"])
            return msg.get("result", {})


def ev(expr):
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True, "userGesture": True})
    if r.get("exceptionDetails"):
        return "ERR " + str(r["exceptionDetails"].get("exception", {}).get("description"))[:300]
    return r["result"].get("value")


def shot(name):
    data = cmd("Page.captureScreenshot", {"format": "png"})["data"]
    with open(os.path.join(OUT, name), "wb") as fh:
        fh.write(base64.b64decode(data))
    print("shot", name)


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Log.enable")
cmd("Emulation.setDeviceMetricsOverride", {"width": 414, "height": 896, "deviceScaleFactor": 2, "mobile": True})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")

for i in range(70):
    time.sleep(0.5)
    if ev("!!(window.__app && window.__app.lantern)"):
        print("extras ready after", round(i * 0.5, 1), "s")
        break

ev("""(() => {
  const p = document.getElementById('musicPrompt');
  if (p) { p.hidden = true; p.classList.remove('show'); }
  const pr = document.getElementById('probe');
  if (pr) pr.hidden = true;
  return 'cleaned';
})()""")

time.sleep(1.2)
shot("m-lant-a-idle.png")

cmd("Input.dispatchKeyEvent", {"type": "keyDown", "key": "6", "code": "Digit6", "windowsVirtualKeyCode": 54, "nativeVirtualKeyCode": 54})
cmd("Input.dispatchKeyEvent", {"type": "keyUp", "key": "6", "code": "Digit6", "windowsVirtualKeyCode": 54, "nativeVirtualKeyCode": 54})
t0 = time.time()

for at, name in [(2.4, "m-lant-b-mid.png"), (5.0, "m-lant-c-high.png")]:
    while time.time() - t0 < at:
        time.sleep(0.05)
    shot(name)

print("list:", ev("""(() => { const L = window.__app.lantern;
  return JSON.stringify({ n: L.list.length, spread: +L.spread.toFixed(2),
    vis: L.list.map(x => x.points.visible ? 1 : 0).join(''),
    ys: L.list.map(x => +x.mat.uniforms.uPos.value.y.toFixed(1)),
    xs: L.list.map(x => +x.mat.uniforms.uPos.value.x.toFixed(1)) }); })()"""))
print("errors:", errors[:5] if errors else "none")
ws.close()
proc.terminate()
print("done")
