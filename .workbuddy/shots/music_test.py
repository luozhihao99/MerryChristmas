"""首屏「边等边听」实测：点按钮 → 音乐加载 → 播放 → 遮罩收起后状态。"""
import base64, json, os, shutil, subprocess, threading, time, queue, urllib.request
import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9334
PROFILE = r"C:\Users\Cling\AppData\Local\Temp\cdp-music-prof"
OUT = r"D:\aiWork\MediaPipe Hands\.workbuddy\shots"
URL = "http://127.0.0.1:8123/index.html?debug"
os.makedirs(OUT, exist_ok=True)
shutil.rmtree(PROFILE, ignore_errors=True)

proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
    f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", "--window-size=1440,900", "--hide-scrollbars",
    "about:blank",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

for _ in range(80):
    try:
        json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version"))
        break
    except Exception:
        time.sleep(0.15)

tgt = json.load(urllib.request.urlopen(
    urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?about:blank", method="PUT")))
ws = websocket.create_connection(tgt["webSocketDebuggerUrl"], timeout=40)
_id = 0
events = queue.Queue()
logs = []

def reader():
    while True:
        try:
            events.put(json.loads(ws.recv()))
        except Exception:
            return
threading.Thread(target=reader, daemon=True).start()

def cmd(method, params=None):
    global _id
    _id += 1
    mid = _id
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    t0 = time.time()
    while time.time() - t0 < 40:
        try:
            m = events.get(timeout=0.2)
        except queue.Empty:
            continue
        if m.get("id") == mid:
            if "error" in m:
                raise RuntimeError(f"{method}: {m['error']}")
            return m.get("result", {})
        events.put(m)
    raise TimeoutError(method)

def ev(expr):
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    return r.get("result", {}).get("value")

def wait_paused(t0, timeout=20):
    while time.time() - t0 < timeout:
        try:
            m = events.get(timeout=0.2)
        except queue.Empty:
            continue
        if m.get("method") == "Fetch.requestPaused":
            return m["params"]["requestId"]
        if m.get("method") == "Runtime.consoleAPICalled":
            logs.append(m["params"].get("type"))
        events.put(m)
    return None

def shot(name, clip=None):
    p = {"format": "png"}
    if clip:
        p["clip"] = dict(clip, scale=1)
    open(os.path.join(OUT, name), "wb").write(base64.b64decode(cmd("Page.captureScreenshot", p)["data"]))
    print("shot", name)

def click(x, y):
    cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
    cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
    time.sleep(0.06)
    cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})

cmd("Page.enable"); cmd("Runtime.enable"); cmd("Network.enable")
cmd("Fetch.enable", {"patterns": [{"urlPattern": "*hand_landmarker.task*"}]})
t0 = time.time()
cmd("Page.navigate", {"url": URL})
rid = wait_paused(t0)
print("paused:", rid)
time.sleep(2.0)

print("btn:", ev("(() => { const b = document.getElementById('btnLoadMusic'); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2, hidden: b.hidden, text: b.innerText.trim()}); })()"))
shot("music-a-idle.png", clip={"x": 0, "y": 300, "width": 1440, "height": 380})

box = json.loads(ev("(() => { const r = document.getElementById('btnLoadMusic').getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()"))
# 限速，让「正在载入音乐 x%」停留得住
cmd("Network.emulateNetworkConditions", {"offline": False, "latency": 60,
                                         "downloadThroughput": 420 * 1024, "uploadThroughput": 64000})
click(box["x"], box["y"])
time.sleep(1.2)
print("loading:", ev("JSON.stringify({text: document.getElementById('loadingMusicText').textContent, cls: document.getElementById('btnLoadMusic').className, playing: window.__app ? window.__app.audio.playing : null})"))
shot("music-b-loading.png", clip={"x": 0, "y": 300, "width": 1440, "height": 380})

time.sleep(3.0)
print("mid:", ev("JSON.stringify({text: document.getElementById('loadingMusicText').textContent, playing: window.__app ? window.__app.audio.playing : null, ctx: window.__app.audio.ctx.state})"))

cmd("Network.emulateNetworkConditions", {"offline": False, "latency": 0,
                                         "downloadThroughput": -1, "uploadThroughput": -1})
time.sleep(2.5)
print("after:", ev("JSON.stringify({text: document.getElementById('loadingMusicText').textContent, cls: document.getElementById('btnLoadMusic').className, playing: window.__app.audio.playing, name: window.__app.audio.name, mode: window.__app.audio.mode, track: document.getElementById('trackName').textContent, pillHidden: document.getElementById('btnPlayMusic').hidden, pauseTxt: document.getElementById('btnPause').textContent})"))
shot("music-c-on.png", clip={"x": 0, "y": 300, "width": 1440, "height": 380})

time.sleep(2.0)
shot("music-d-scene.png")

print("logs:", logs[:6])
ws.close(); proc.terminate()
