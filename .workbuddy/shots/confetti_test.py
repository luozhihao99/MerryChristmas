# -*- coding: utf-8 -*-
"""点赞纸屑：按 L 触发，按真实时间点截几帧。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-cf-{PORT}"
shutil.rmtree(PROFILE, ignore_errors=True)

W, H, DSF = 1440, 900, 1
TAG = "cf"
if len(sys.argv) > 1 and sys.argv[1] == "mobile":
    W, H, DSF, TAG = 414, 896, 2, "m-cf"

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
        return "ERR " + str(r["exceptionDetails"].get("exception", {}).get("description"))[:400]
    return r["result"].get("value")


def shot(name):
    r = cmd("Page.captureScreenshot", {"format": "png"})
    with open(f"{TAG}-{name}", "wb") as f:
        f.write(base64.b64decode(r["data"]))
    print("  shot", f"{TAG}-{name}")


def key(k, code, vk):
    cmd("Input.dispatchKeyEvent", {"type": "keyDown", "key": k, "code": code,
                                   "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk})
    cmd("Input.dispatchKeyEvent", {"type": "keyUp", "key": k, "code": code,
                                   "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk})


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Log.enable")
if DSF != 1:
    cmd("Emulation.setDeviceMetricsOverride",
        {"width": W, "height": H, "deviceScaleFactor": DSF, "mobile": W < 500})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")

t0 = time.time()
while time.time() - t0 < 40:
    time.sleep(0.4)
    if ev("document.getElementById('loading').classList.contains('done')"):
        break

ev("(() => { const p=document.getElementById('musicPrompt'); if(p) p.style.display='none';"
   " const q=document.getElementById('probe'); if(q) q.style.display='none'; return 'ok'; })()")

for _ in range(40):
    time.sleep(0.4)
    if ev("!!(window.__app && window.__app.confetti)"):
        break
print("confetti:", ev("typeof (window.__app && window.__app.confetti)"))
time.sleep(1.2)

key("l", "KeyL", 76)
tk = time.time()
for at, name in [(0.35, "a-burst.png"), (0.90, "b-rise.png"),
                 (1.70, "c-fall.png"), (2.80, "d-late.png")]:
    while time.time() - tk < at:
        time.sleep(0.06)
    print(f"  t={time.time()-tk:.2f}s", ev("JSON.stringify({act: window.__app.confetti.active,"
                                          " now: +(window.__app.confetti.now||0).toFixed(2)})"))
    shot(name)

bad = [e for e in errs if "videotolink" not in e and "cors" not in e.lower()]
print("errors:", bad[:4] if bad else "none")
ws.close()
proc.terminate()
