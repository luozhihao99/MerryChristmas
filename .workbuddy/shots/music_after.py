"""遮罩收起后的两种路径：点了音乐 / 没点音乐。"""
import base64, json, os, shutil, subprocess, threading, time, queue, urllib.request
import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9335
PROFILE = r"C:\Users\Cling\AppData\Local\Temp\cdp-music2-prof"
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

ws = websocket.create_connection(json.load(urllib.request.urlopen(
    urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?about:blank", method="PUT")))["webSocketDebuggerUrl"], timeout=40)
_id = 0
events = queue.Queue()

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
    return cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})["result"].get("value")

def paused(t0, timeout=20):
    while time.time() - t0 < timeout:
        try:
            m = events.get(timeout=0.2)
        except queue.Empty:
            continue
        if m.get("method") == "Fetch.requestPaused":
            return m["params"]["requestId"]
        events.put(m)
    return None

def shot(name):
    open(os.path.join(OUT, name), "wb").write(base64.b64decode(cmd("Page.captureScreenshot", {"format": "png"})["data"]))
    print("shot", name)

def click(x, y):
    cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
    cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
    time.sleep(0.05)
    cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})

STATE = """JSON.stringify({
  musicBtn: document.getElementById('btnLoadMusic').className + ' / ' + document.getElementById('loadingMusicText').textContent,
  overlay: document.getElementById('loading').className,
  playing: window.__app.audio.playing, name: window.__app.audio.name,
  track: document.getElementById('trackName').textContent,
  pillHidden: document.getElementById('btnPlayMusic').hidden,
  pause: document.getElementById('btnPause').textContent,
  pauseNudge: document.getElementById('btnPause').className
})"""

cmd("Page.enable"); cmd("Runtime.enable"); cmd("Network.enable")
cmd("Fetch.enable", {"patterns": [{"urlPattern": "*hand_landmarker.task*"}]})
t0 = time.time()
cmd("Page.navigate", {"url": URL})
rid = paused(t0)
print("paused:", rid)
time.sleep(1.8)

box = json.loads(ev("(() => { const r = document.getElementById('btnLoadMusic').getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()"))
click(box["x"], box["y"])
print("clicked")
time.sleep(1.0)
print("B-1 (音乐加载中):", ev(STATE))

cmd("Fetch.continueRequest", {"requestId": rid})
time.sleep(6.0)
print("B-2 (遮罩收起):", ev(STATE))
shot("music-e-after.png")

# 场景 C：重载，不点音乐，等它自己预载完
cmd("Fetch.disable")
cmd("Page.reload", {"ignoreCache": False})
time.sleep(6.0)
print("C (没点音乐):", ev(STATE))
shot("music-f-noclick.png")

ws.close(); proc.terminate()
