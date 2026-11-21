"""首屏加载界面截图：拦下模型请求，分三阶段看数字 / 文案 / 动效。"""
import base64, json, os, shutil, subprocess, threading, time, queue, urllib.request
import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9333
PROFILE = r"C:\Users\Cling\AppData\Local\Temp\cdp-load-prof"
OUT = r"D:\aiWork\MediaPipe Hands\.workbuddy\shots"
URL = "http://127.0.0.1:8123/index.html"
os.makedirs(OUT, exist_ok=True)
shutil.rmtree(PROFILE, ignore_errors=True)  # 每次清缓存：否则 IndexedDB 里的模型让下载阶段一闪而过

proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
    f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    "--window-size=1440,900", "--hide-scrollbars", "about:blank",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def wait_devtools():
    for _ in range(80):
        try:
            return json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version"))
        except Exception:
            time.sleep(0.15)
    raise SystemExit("devtools 起不来")

wait_devtools()
req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?about:blank", method="PUT")
target = json.load(urllib.request.urlopen(req))

ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=30)
_id = 0
events = queue.Queue()
errors = []

def reader():
    while True:
        try:
            msg = json.loads(ws.recv())
        except Exception:
            return
        events.put(msg)

threading.Thread(target=reader, daemon=True).start()

def cmd(method, params=None):
    global _id
    _id += 1
    mid = _id
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    t0 = time.time()
    while time.time() - t0 < 40:
        try:
            msg = events.get(timeout=0.2)
        except queue.Empty:
            continue
        if msg.get("id") == mid:
            if "error" in msg:
                raise RuntimeError(f"{method}: {msg['error']}")
            return msg.get("result", {})
        events.put(msg)
    raise TimeoutError(method)

def wait_paused(t0, timeout=15):
    while time.time() - t0 < timeout:
        try:
            msg = events.get(timeout=0.2)
        except queue.Empty:
            continue
        if msg.get("method") == "Fetch.requestPaused":
            return msg["params"]["requestId"]
        if msg.get("method") in ("Runtime.exceptionThrown",):
            errors.append(json.dumps(msg["params"])[:400])
        events.put(msg)
    return None

def shot(name, clip=None, scale=1):
    p = {"format": "png"}
    if clip:
        p["clip"] = dict(clip, scale=scale)
    r = cmd("Page.captureScreenshot", p)
    path = os.path.join(OUT, name)
    open(path, "wb").write(base64.b64decode(r["data"]))
    print("shot", name)

cmd("Page.enable")
cmd("Runtime.enable")
cmd("Network.enable")
cmd("Fetch.enable", {"patterns": [{"urlPattern": "*hand_landmarker.task*"}]})
t0 = time.time()
cmd("Page.navigate", {"url": URL})

rid = wait_paused(t0, 20)
print("paused:", rid)

time.sleep(2.2)
# 阶段 A：场景已好，模型被拦着 —— 应显示 55% + 「正在连接手势模型…」+ 流光
shot("load-a-full.png")
print("A:", cmd("Runtime.evaluate", {"returnByValue": True, "expression": "JSON.stringify({track: document.getElementById('loadingBarTrack').className, after: getComputedStyle(document.querySelector('.loading-bar'), '::after').animationName, shine: getComputedStyle(document.querySelector('.loading-bar i'), '::before').animationName, pct: document.getElementById('loadingPctNum').textContent, text: document.getElementById('loadingText').textContent})"})["result"]["value"])

cmd("Network.emulateNetworkConditions", {
    "offline": False, "latency": 60,
    "downloadThroughput": 960 * 1024, "uploadThroughput": 200 * 1024 // 8,
})
cmd("Fetch.continueRequest", {"requestId": rid})
time.sleep(2.2)
# 阶段 B：下载中 —— 数字应爬到 60~75%，文案带 MB
shot("load-b-download.png", clip={"x": 0, "y": 250, "width": 1440, "height": 420})
print("state-b:", cmd("Runtime.evaluate", {
    "expression": "document.getElementById('loadingText').textContent + ' | ' + document.getElementById('loadingPctNum').textContent + ' | bar=' + document.getElementById('loadingBar').style.width",
    "returnByValue": True})["result"]["value"])

cmd("Network.emulateNetworkConditions", {
    "offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
time.sleep(0.35)
shot("load-c-ready.png", clip={"x": 0, "y": 250, "width": 1440, "height": 420})
print("state-c:", cmd("Runtime.evaluate", {
    "expression": "document.getElementById('loadingPctNum').textContent + ' | done=' + document.getElementById('loading').className",
    "returnByValue": True})["result"]["value"])

# 竖屏
cmd("Emulation.setDeviceMetricsOverride", {"width": 414, "height": 896, "deviceScaleFactor": 2, "mobile": True})
cmd("Page.reload", {"ignoreCache": True})
time.sleep(2.4)
shot("load-mobile.png", clip={"x": 0, "y": 300, "width": 414, "height": 300}, scale=2)

print("errors:", errors[:3])
ws.close()
proc.terminate()
