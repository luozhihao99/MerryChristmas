# -*- coding: utf-8 -*-
"""RIPPLE_ENABLED=false 冒烟测试：页面正常、ripple 为 null、W 提示已关闭、无报错。"""
import base64, json, random, shutil, subprocess, time, urllib.request
import websocket
from PIL import Image

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-roff-{PORT}"
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
            errors.append(str(msg["params"]["exceptionDetails"].get("exception", {}).get("description"))[:300])
            continue
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
    print(" ", name)


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride",
    {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")

for _ in range(120):
    time.sleep(0.4)
    if ev("!!(window.__app && window.__app.archery)"):
        break

ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const st = document.createElement('style');
  st.textContent = '#musicPrompt{display:none!important}';
  document.head.appendChild(st);
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  return 'ok';
})()""")
time.sleep(2.0)

print("ripple:", ev("window.__app.ripple"))
print("tick alive:", ev("window.__app.bootState.tickCount > 60"))
ev("window.dispatchEvent(new KeyboardEvent('keydown', {key: 'w'})), 'ok'")
time.sleep(0.2)
print("W status:", ev("document.getElementById('statusText').textContent"))
shot("roff-a.png")
print("errors:", errors[:3])
ws.close()
proc.terminate()
