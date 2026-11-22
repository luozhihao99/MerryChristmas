# -*- coding: utf-8 -*-
"""清屏：隐藏标题+控制栏，右下角「菜单」与 Esc 都能恢复；顺带看窄屏按钮不溢出。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-cl-{PORT}"
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
    im = Image.open(name).convert("RGB")
    print(" ", name, im.size)
    return im


def click(sel):
    return ev(f"document.getElementById('{sel}').dispatchEvent(new MouseEvent('click', {{bubbles: true}})), 'ok'")


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
time.sleep(2.4)

# 1) 正常态
click('btnHints')   # 顺手让左下角一览也开着，清屏时必须一起消失
click('btnCam')
time.sleep(0.4)
shot("cl-a-normal.png")
print("normal:", ev("[document.getElementById('hud').className, document.getElementById('btnUnclean').hidden]"))

# 2) 清屏
click('btnClean')
time.sleep(0.45)
print("clean:", ev("""(() => {
  const g = (s) => getComputedStyle(document.querySelector(s)).opacity;
  const u = document.getElementById('btnUnclean');
  const t = document.getElementById('cleanToast');
  return {
    cls: document.getElementById('hud').className,
    top: g('.hud-top'), cam: g('.cam-wrap'), hints: g('.hints'),
    status: g('.status'), score: g('.score'),
    unc: [+!u.hidden, getComputedStyle(u).opacity, u.textContent.trim(), u.clientWidth + 'x' + u.clientHeight],
    toast: [t.hidden, getComputedStyle(t).opacity, t.textContent.trim()],
    cleanBtnPressed: document.getElementById('btnClean').getAttribute('aria-pressed'),
  };
})()"""))
shot("cl-b-clean.png")

# 2.5 秒后轻提示应自己淡掉
time.sleep(2.3)
print("toast after 2.7s:", ev("""(() => {
  const t = document.getElementById('cleanToast');
  return [t.hidden, getComputedStyle(t).opacity];
})()"""))
shot("cl-b2-toast-gone.png")

# 3) Esc 恢复
ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
time.sleep(0.6)
print("after esc:", ev("[document.getElementById('hud').className, document.getElementById('btnUnclean').hidden]"))
shot("cl-c-restored.png")

# 4) 再清屏，用右下角「菜单」按钮恢复
click('btnClean')
time.sleep(0.5)
click('btnUnclean')
time.sleep(0.6)
print("after menu:", ev("[document.getElementById('hud').className, document.getElementById('btnUnclean').hidden]"))

# 5) 窄屏：音乐条是否溢出
cmd("Emulation.setDeviceMetricsOverride",
    {"width": 414, "height": 896, "deviceScaleFactor": 2, "mobile": True})
time.sleep(1.2)
click('btnHints')
time.sleep(0.3)
print("mobile bar overflow:", ev("""(() => {
  const bar = document.querySelector('.audio-bar');
  const top = document.querySelector('.hud-top');
  return [bar.scrollWidth, bar.clientWidth, top.scrollWidth, document.documentElement.clientWidth];
})()"""))
shot("cl-d-mobile.png")
click('btnClean')
time.sleep(0.6)
shot("cl-e-mobile-clean.png")

print("errors:", errors[:3])
ws.close()
proc.terminate()
