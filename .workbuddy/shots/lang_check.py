# -*- coding: utf-8 -*-
"""三语选择验证：进入选语言 → 遮罩/标题/按钮/玩法一览/底部提示 全部切换。"""
import base64, json, random, shutil, subprocess, time, urllib.request
import websocket
from PIL import Image

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-lang-{PORT}"
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

ws = websocket.create_connection(ws_url, timeout=180)
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


def key(k):
    return ev(f"window.dispatchEvent(new KeyboardEvent('keydown', {{key: '{k}'}})), 'ok'")


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride",
    {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")

# 等语言选择器出现（main.js 一执行 applyStatic 就有）
for _ in range(40):
    time.sleep(0.3)
    if ev("!!document.getElementById('langPick')"):
        break
time.sleep(1.0)

def pick_state():
    return ev("""(() => {
      const on = document.querySelector('.lang-pick button.on');
      return [on && on.dataset.lang, document.getElementById('loadingText').textContent,
              document.querySelector('.hint[data-k=bow] span').textContent];
    })()""")

print("default:", pick_state())

# 切泰语
ev("document.querySelector('.lang-pick button[data-lang=th]').click()")
time.sleep(0.4)
print("th:", pick_state())
shot("lang-th.png")

# 切英语
ev("document.querySelector('.lang-pick button[data-lang=en]').click()")
time.sleep(0.4)
print("en:", pick_state())
shot("lang-en.png")

# 等遮罩收掉（假摄像头会走完，或按 T/S 无关；直接等 bootState.finished）
for _ in range(150):
    time.sleep(0.5)
    fin = ev("window.__app && window.__app.bootState.finished")
    if fin:
        break
ev("""(() => {
  const st = document.createElement('style');
  st.textContent = '#musicPrompt{display:none!important}';
  document.head.appendChild(st);
  const p = document.getElementById('probe'); if (p) p.hidden = true;
  return 'ok';
})()""")
time.sleep(1.5)

print("after boot en:", ev("""(() => ({
  brand: document.querySelector('.brand-cn').textContent,
  music: document.getElementById('btnMusic').textContent,
  hints: document.querySelector('.hint[data-k=heart] b').textContent,
  score: document.querySelector('.score-label').textContent,
  camOff: document.getElementById('camOff').textContent,
  title: document.title,
}))()"""))
shot("lang-en-boot.png")

# ---- 内容页语言按钮：循环切换 + 清屏图标不被翻译 ----
print("clean icon:", ev("document.getElementById('btnClean').textContent"))
print("lang label:", ev("document.getElementById('btnLang').textContent"))
ev("document.getElementById('btnLang').click()")
time.sleep(0.3)
print("btnLang -> th:", ev("""(() => ({
  lbl: document.getElementById('btnLang').textContent,
  music: document.getElementById('btnMusic').textContent,
  hint: document.querySelector('.hint[data-k=heart] b').textContent,
  score: document.querySelector('.score-label').textContent,
}))()"""))
ev("document.getElementById('btnLang').click()")
time.sleep(0.3)
print("btnLang -> zh:", ev("document.getElementById('btnLang').textContent + '|' + document.getElementById('btnMusic').textContent + '|' + document.querySelector('.hint[data-k=heart] b').textContent"))
ev("document.getElementById('btnLang').click()")
time.sleep(0.3)
print("btnLang -> en:", ev("document.getElementById('btnLang').textContent + '|' + document.getElementById('btnMusic').textContent"))
shot("lang-en-cycle.png")

# 窄屏：加语言按钮后顶栏不溢出
cmd("Emulation.setDeviceMetricsOverride",
    {"width": 414, "height": 896, "deviceScaleFactor": 2, "mobile": True})
time.sleep(0.8)
print("narrow overflow:", ev("""(() => {
  const bar = document.querySelector('.audio-bar');
  return [bar.scrollWidth, window.innerWidth, bar.scrollWidth <= window.innerWidth];
})()"""))
cmd("Emulation.setDeviceMetricsOverride",
    {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})

# 刷新：localStorage 里是 en，应自动预选英语
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
time.sleep(2.5)
print("reload preselect:", ev("""(() => {
  const on = document.querySelector('.lang-pick button.on');
  return [on && on.dataset.lang, document.getElementById('loadingText').textContent];
})()"""))

# 改回中文再刷新验证持久化
ev("document.querySelector('.lang-pick button[data-lang=zh]').click()")
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
time.sleep(2.5)
print("zh persisted:", pick_state())

print("errors:", errors[:3])
ws.close()
proc.terminate()
