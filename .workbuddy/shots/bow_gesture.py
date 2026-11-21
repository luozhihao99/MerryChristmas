# -*- coding: utf-8 -*-
"""双手拉弓的判定链路：出手 → 拉开 → 松手放箭，全部走真实代码路径。

坐标换算：假手的 size=0.10、palm.x 已乘过 1.333 的宽高比，
所以 sep（手间距 / 手宽）= 13.33 * dx。BOW_CFG 里 start=1.12、full=3.60，
对应 dx 0.084 / 0.270 —— 也就是两只手在画面上分开 8% / 27% 的宽度。
"""
import json
import random
import shutil
import subprocess
import time
import urllib.request

import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-bg-{PORT}"
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
  document.getElementById('loading').classList.add('done');
  const st = document.createElement('style');
  st.textContent = '#musicPrompt{display:none!important}';
  document.head.appendChild(st);
})()""")
time.sleep(1.2)

print(ev("""(() => {
  const a = window.__app;
  const g = a.gesture;
  window.__shots = 0;
  const origEvent = g.onEvent;
  g.onEvent = (type, payload) => {
    if (type === 'bowRelease') window.__shots++;
    return origEvent(type, payload);
  };
  g.update = () => ({
    hands: [], handCount: 2, spread: 0.46, tray: null,
    heart: { active: false, strength: 0 },
    bow: g.bow,
  });
  // palm.x 已经乘过 aspect；size = 0.10 → sep = 13.33 * dx
  const hand = (x, clutch) => ({
    palm: { x: x * 1.333, y: 0.42 },
    palmMirrored: { x: 1 - x, y: 0.42 },
    size: 0.10, clutch, pinch: 0.55, ring: 0.1,
  });
  window.__hand = hand;
  window.__draw = (xo, dt, t0, clutch) => {
    const g2 = window.__app.gesture;
    g2._computeBow([hand(0.5 - xo, clutch), hand(0.5 + xo, clutch)], t0);
    return g2.bow;
  };
  return 'hooked';
})()"""))


def draw(t0, x_from, x_to, n, step, clutch=0.62):
    """从 x_from 走到 x_to（xo = 半间距），喂 n 帧"""
    for i in range(n):
        k = i / max(1, n - 1)
        xo = x_from + (x_to - x_from) * k
        ev(f"window.__draw({xo:.4f}, 0.045, {t0 + i * step}, {clutch})")


# 1) 两手抬起来，间距刚过起手线（sep≈1.1）
t = ev("performance.now()")
draw(t, 0.020, 0.036, 8, 40)
time.sleep(0.4)
print("抬手 sep≈1.2:", ev("[window.__app.gesture.bow.active, +window.__app.gesture.bow.sep.toFixed(2)]"))

# 2) 慢慢拉开到 sep≈2.6（七成）
t += 8 * 40 + 40
draw(t, 0.036, 0.080, 16, 45)
time.sleep(0.4)
print("拉到七成:", ev("[window.__app.gesture.bow.active, +window.__app.gesture.bow.pull.toFixed(2), +window.__app.gesture.bow.sep.toFixed(2)]"))

# 3) 再拉满（sep≈3.8）
t += 16 * 45 + 40
draw(t, 0.080, 0.120, 10, 45)
time.sleep(0.4)
print("拉满:", ev("[window.__app.gesture.bow.active, +window.__app.gesture.bow.pull.toFixed(2), +window.__app.gesture.bow.sep.toFixed(2)]"))
print("缩放权重（应≈0，树不被推大）:", ev("[+window.__app.router.bowW.toFixed(2), +window.__app.router.scale.toFixed(3)]"))

# 4) 松手：两手在 120ms 内回到 sep≈1.0
t += 10 * 45 + 40
draw(t, 0.120, 0.030, 4, 40)
time.sleep(0.5)
print("松手后:", ev("[window.__shots, window.__app.gesture.bow.active, !!window.__app.archery.flight]"))

# 5) 慢慢放下手（不该误射）：1.2 秒里从 sep 3.8 收到 1.4
time.sleep(1.4)
s0 = ev("window.__shots")
t = ev("performance.now()")
for i in range(24):
    xo = 0.120 - (0.120 - 0.044) * (i / 23)
    ev(f"window.__draw({xo:.4f}, 0.05, {t + i * 50}, 0.62)")
time.sleep(0.5)
print("慢慢放下手（应仍是一次）:", ev("[window.__shots, window.__app.gesture.bow.active, +window.__app.gesture.bow.pull.toFixed(2)]"), "before", s0)

# 6) 只剩一只手：不该乱射，弓要在 ~350ms 内退出
time.sleep(1.3)
s1 = ev("window.__shots")
t = ev("performance.now()")
draw(t, 0.044, 0.120, 12, 45)
print("再拉满:", ev("[+window.__app.gesture.bow.pull.toFixed(2)]"))
t2 = ev("performance.now()")
for i in range(10):
    ev(f"window.__app.gesture._computeBow([window.__hand(0.5 - 0.12, 0.7)], {t2 + i * 50})")
print("丢手后:", ev("[window.__app.gesture.bow.active, window.__shots]"), "before", s1)

print("vis:", ev("[+window.__app.archery.vis.toFixed(2), window.__app.archery.inited]"))
print("errors:", errors[:3])
ws.close()
proc.terminate()
