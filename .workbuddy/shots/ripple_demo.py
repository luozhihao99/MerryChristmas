# -*- coding: utf-8 -*-
"""W 键水波纹演示模式验证：不依赖音乐也能出效果，并打印音频链路诊断。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-rd-{PORT}"
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
console = []


def cmd(m, p=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": m, "params": p or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("method") == "Runtime.exceptionThrown":
            errors.append(str(msg["params"]["exceptionDetails"].get("exception", {}).get("description"))[:300])
            continue
        if msg.get("method") == "Runtime.consoleAPICalled" and msg["params"].get("type") == "log":
            console.append(str(msg["params"].get("args", []))[:200])
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
    im = Image.open(name).convert("RGB")
    print(" ", name, im.size)
    return im


def key(k):
    return ev(f"window.dispatchEvent(new KeyboardEvent('keydown', {{key: '{k}'}})), 'ok'")


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride",
    {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")

for _ in range(120):
    time.sleep(0.4)
    if ev("!!(window.__app && window.__app.ripple)"):
        break

ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const st = document.createElement('style');
  st.textContent = '#musicPrompt{display:none!important}';
  document.head.appendChild(st);
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  return 'ok';
})()""")
time.sleep(2.2)

# 初始：没音乐，master 应为 0
print("before W master:", ev("window.__app.ripple.mat.uniforms.uMaster.value.toFixed(3)"))

# 按 W 开演示
key('w')
time.sleep(0.3)
print("after W +0.3s:", ev("[window.__app.ripple.mat.uniforms.uMaster.value.toFixed(3), ...window.__app.ripple.mat.uniforms.uSpec.value.slice(0,3).map(v=>v.toFixed(2))]"))
time.sleep(1.5)
print("after W +1.8s:", ev("[window.__app.ripple.mat.uniforms.uMaster.value.toFixed(3), ...window.__app.ripple.mat.uniforms.uRippleStart.value.map(v=>v.toFixed(2))]"))
im = shot("rd-a-demo.png")

# 再按 W 关：应淡出
key('w')
time.sleep(3.5)
print("after W off +3.5s:", ev("window.__app.ripple.mat.uniforms.uMaster.value.toFixed(3)"))

# 底区亮度
crop = im.crop((int(1440*0.18), int(900*0.62), int(1440*0.82), int(900*0.98))).convert("L")
px = list(crop.getdata())
print("demo base mean:", round(sum(px)/len(px), 1), "max:", max(px))

print("console log:", [c for c in console if '水波纹' in c][:2])
print("errors:", errors[:3])
ws.close()
proc.terminate()
