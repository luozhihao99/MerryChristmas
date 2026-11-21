# -*- coding: utf-8 -*-
"""真实页面：点「开启音乐」后，界面在慢源下会怎么变。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-live-{PORT}"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

shutil.rmtree(PROFILE, ignore_errors=True)
proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
    f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", "--window-size=1440,900",
    "about:blank",
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


def cmd(method, params=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id[0]:
            if "error" in msg:
                raise RuntimeError(msg["error"])
            return msg.get("result", {})


def ev(expr, await_promise=False):
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                 "awaitPromise": await_promise, "userGesture": True})
    if r.get("exceptionDetails"):
        return "ERR " + str(r["exceptionDetails"].get("exception", {}).get("description"))
    return r["result"].get("value")


def shot(name):
    data = cmd("Page.captureScreenshot", {"format": "png"})["data"]
    with open(os.path.join(OUT, name), "wb") as fh:
        fh.write(base64.b64decode(data))
    print("shot", name)


def state():
    return ev("""JSON.stringify({
      btn: document.querySelector('#btnMusicYes .mb-cn').textContent,
      btnEn: document.querySelector('#btnMusicYes .mb-en').textContent,
      track: document.getElementById('trackName').textContent,
      promptHidden: document.getElementById('musicPrompt').hidden,
      overlay: document.getElementById('loading').className,
    })""")


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})

for i in range(40):
    time.sleep(0.5)
    if ev("(() => { const p = document.getElementById('musicPrompt'); return p && !p.hidden; })()"):
        print("prompt shown at", round(i * 0.5, 1), "s")
        break

shot("live-a-prompt.png")

box = ev("""(() => { const b = document.getElementById('btnMusicYes').getBoundingClientRect();
  return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()""")
b = json.loads(box)
cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": b["x"], "y": b["y"], "button": "left", "clickCount": 1})
cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": b["x"], "y": b["y"], "button": "left", "clickCount": 1})
print("clicked at", b)

time.sleep(1.2)
print("1.2s:", state())
shot("live-b-connect.png")

time.sleep(4.5)
print("5.7s:", state())
shot("live-c-slow.png")

time.sleep(6.0)
print("11.7s:", state())

time.sleep(4.0)
print("15.7s:", state())

time.sleep(2.0)
print("17.7s:", state())
shot("live-d-after.png")
print("errors:", ev("JSON.stringify(window.__errors || [])"))

ws.close()
proc.terminate()
print("done")
