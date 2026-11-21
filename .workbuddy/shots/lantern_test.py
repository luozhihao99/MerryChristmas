# -*- coding: utf-8 -*-
"""验证两件事：常驻螺旋银白粒子、打电话的孔明灯。"""
import json, random, shutil, subprocess, sys, time, urllib.request
import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-lant-{PORT}"
shutil.rmtree(PROFILE, ignore_errors=True)
proc = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
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
    with open(name, "wb") as f:
        f.write(__import__("base64").b64decode(r["data"]))
    print("  shot", name)

def key(k, code, vk):
    cmd("Input.dispatchKeyEvent", {"type": "keyDown", "key": k, "code": code,
                                   "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk})
    cmd("Input.dispatchKeyEvent", {"type": "keyUp", "key": k, "code": code,
                                   "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk})

cmd("Page.enable"); cmd("Runtime.enable"); cmd("Log.enable")
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")

# 等遮罩收起
ready = False
t0 = time.time()
while time.time() - t0 < 40:
    time.sleep(0.4)
    if ev("document.getElementById('loading').classList.contains('done')"):
        ready = True
        break
print("遮罩收起:", ready, f"{time.time()-t0:.1f}s")

# 藏掉弹窗/探针，别挡截图
ev("(() => { const p=document.getElementById('musicPrompt'); if(p) p.style.display='none';"
   " const q=document.getElementById('probe'); if(q) q.style.display='none'; return 'ok'; })()")

# 常驻螺旋粒子：等 extras 建好
for _ in range(30):
    time.sleep(0.4)
    if ev("!!(window.__app && window.__app.lantern)"):
        break
print("extras:", ev("JSON.stringify({lantern: !!(window.__app&&window.__app.lantern), spiral: !!(window.__app&&window.__app.spiral)})"))

time.sleep(1.5)
shot("lant-a-idle.png")

# 孔明灯
key("6", "Digit6", 54)
tk = time.time()
# 用真实时间点截：灯刚起、升到半腰、快到顶、收尾
for at, name in [(1.0, "lant-b-start.png"), (2.7, "lant-c-mid.png"),
                 (4.6, "lant-d-high.png"), (7.0, "lant-e-late.png")]:
    while time.time() - tk < at:
        time.sleep(0.08)
    shot(name)

print("状态:", ev("JSON.stringify({act: window.__app.lantern.active, now: +(window.__app.lantern.now||0).toFixed(1), end: +(window.__app.lantern.endAt||0).toFixed(1)})"))
bad = [e for e in errs if "videotolink" not in e and "cors" not in e.lower()]
print("errors:", bad[:4] if bad else "none")
ws.close(); proc.terminate()
