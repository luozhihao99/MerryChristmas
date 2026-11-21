# -*- coding: utf-8 -*-
"""OK 手势那段特效的分阶段截图。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-ok-{PORT}"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

shutil.rmtree(PROFILE, ignore_errors=True)
proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
    f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", "--window-size=414,896",
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


def ev(expr, await_promise=False):
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                 "awaitPromise": await_promise, "userGesture": True})
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

for i in range(60):
    time.sleep(0.5)
    if ev("!!(window.__app && window.__app.missYou)"):
        print("extras ready after", round(i * 0.5, 1), "s")
        break

# 把音乐弹窗和调试探针收掉，别挡着看特效
ev("""(() => {
  const p = document.getElementById('musicPrompt');
  if (p) { p.hidden = true; p.classList.remove('show'); }
  const pr = document.getElementById('probe');
  if (pr) pr.hidden = true;
  return 'cleaned';
})()""")

time.sleep(1.0)
print("fps probe:", ev("""
(async () => {
  const t0 = performance.now(); let n = 0;
  await new Promise(r => { const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); });
  return n + ' fps';
})()
""", await_promise=True))

# 用 M 键触发，走真实的 clock.elapsedTime
cmd("Input.dispatchKeyEvent", {"type": "keyDown", "key": "m", "code": "KeyM", "windowsVirtualKeyCode": 77, "nativeVirtualKeyCode": 77})
cmd("Input.dispatchKeyEvent", {"type": "keyUp", "key": "m", "code": "KeyM", "windowsVirtualKeyCode": 77, "nativeVirtualKeyCode": 77})
t0 = time.time()

marks = [
    (1.00, "m-a-heart.png"),
    (2.20, "m-b-fire.png"),
    (2.90, "m-c-blow.png"),
    (5.20, "m-d-text.png"),
]
for at, name in marks:
    while time.time() - t0 < at:
        time.sleep(0.05)
    print(f"t={time.time()-t0:.2f}", "state:", ev("""(() => { const m = window.__app.missYou;
      return JSON.stringify({ active: m.active, dim: +m.dim.toFixed(2),
        vis: m.set.map(l => l.points.visible ? 1 : 0).join(''), key: m.key }); })()"""))
    shot(name)

print("errors:", errors[:5] if errors else "none")
ws.close()
proc.terminate()
print("done")
