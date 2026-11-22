# -*- coding: utf-8 -*-
"""HUD 开关（玩法/摄像头默认隐藏）+ 底部玩法提示轮换 + S 键爆雪仍然可用。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-ui-{PORT}"
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
    return ev(f"""(() => {{
      const b = document.getElementById('{sel}');
      b.dispatchEvent(new MouseEvent('click', {{bubbles: true}}));
      return b.getAttribute('aria-pressed');
    }})()""")


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

# 收掉遮罩和音乐弹窗，等摄像头链路 ready（fake device 应能成功）
print(ev("""(() => {
  const l = document.getElementById('loading'); if (l) l.classList.add('done');
  const st = document.createElement('style');
  st.textContent = '#musicPrompt{display:none!important}';
  document.head.appendChild(st);
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  return 'ok';
})()"""))

# 等玩法提示启动（cameraReady → startTips）
tip = ''
for _ in range(80):
    time.sleep(0.5)
    tip = ev("document.getElementById('statusText').textContent") or ''
    if '试试' in tip:
        break
print("tip1:", repr(tip))
print("tips.idx:", ev("window.__app.tips.idx"), "done:", ev("window.__app.tips.done"))

# 默认显隐（现在默认都开着）
print("default hidden:", ev("""
  [document.getElementById('hints').hidden,
   document.getElementById('camWrap').hidden,
   document.getElementById('btnHints').getAttribute('aria-pressed'),
   document.getElementById('btnCam').getAttribute('aria-pressed')]
"""))
base = shot("ui-a-default.png")

# 开关切换（先收起，再打开）
print("close hints:", click('btnHints'), "close cam:", click('btnCam'))
print("after close:", ev("[document.getElementById('hints').hidden, document.getElementById('camWrap').hidden]"))
print("open hints:", click('btnHints'), "open cam:", click('btnCam'))
print("after open:", ev("[document.getElementById('hints').hidden, document.getElementById('camWrap').hidden]"))
time.sleep(0.4)
shot("ui-b-hints.png")

# 触发当前提示的玩法：伪造比心 → love 上升 → active 有 heart
print(ev("""(() => {
  const a = window.__app;
  a.gesture.update = () => ({
    hands: [], handCount: 2, spread: null, tray: null,
    heart: { active: true, strength: 1 }, bow: null,
  });
  return 'hooked heart';
})()"""))
time.sleep(0.8)
print("flash:", ev("[document.getElementById('status').className, document.getElementById('statusText').textContent]"))
shot("ui-c-flash.png")

# 等高亮结束，确认换成了没触发过的新玩法
time.sleep(2.6)
tip2 = ev("document.getElementById('statusText').textContent")
print("tip2:", repr(tip2), "idx:", ev("window.__app.tips.idx"), "done:", ev("window.__app.tips.done"))

# 撤掉假手势，S 键爆雪仍然可用（拍手手势已屏蔽，键盘直通 router）
print("stub:", ev("""(() => {
  const a = window.__app;
  a.gesture.update = () => ({ hands: [], handCount: 0, spread: null, tray: null, heart: null, bow: null });
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
  return [a.router.explode, a.router.storm];
})()"""))
time.sleep(0.15)
storm = shot("ui-d-storm.png")


def lum(im):
    px = list(im.resize((160, 100)).getdata())
    return sum(sum(p) for p in px) / (len(px) * 3)


print("lum base/storm:", round(lum(base), 1), round(lum(storm), 1))

# localStorage 持久化
print("store:", ev("localStorage.getItem('tree.tips.done')"))

print("errors:", errors[:3])
ws.close()
proc.terminate()
