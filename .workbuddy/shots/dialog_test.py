"""首屏音乐确认弹窗 + 双语加载界面。"""
import base64, json, os, random, shutil, subprocess, threading, time, queue, urllib.request
import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = random.randint(9600, 9699)
PROFILE = r"C:\Users\Cling\AppData\Local\Temp\cdp-dlg-prof"
OUT = r"D:\aiWork\MediaPipe Hands\.workbuddy\shots"
URL = "http://127.0.0.1:8123/index.html?debug"
os.makedirs(OUT, exist_ok=True)
shutil.rmtree(PROFILE, ignore_errors=True)

proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
    "--no-first-run", "--no-default-browser-check", "--enable-unsafe-swiftshader",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--window-size=1440,900", "--hide-scrollbars", "about:blank",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(80):
    try:
        json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version")); break
    except Exception:
        time.sleep(0.15)

ws = websocket.create_connection(json.load(urllib.request.urlopen(
    urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?about:blank", method="PUT")))["webSocketDebuggerUrl"], timeout=40)
_id = 0
q = queue.Queue()
errors = []

def reader():
    while True:
        try: q.put(json.loads(ws.recv()))
        except Exception: return
threading.Thread(target=reader, daemon=True).start()

def cmd(m, p=None):
    global _id
    _id += 1; mid = _id
    ws.send(json.dumps({"id": mid, "method": m, "params": p or {}}))
    t0 = time.time()
    while time.time() - t0 < 40:
        try: msg = q.get(timeout=0.2)
        except queue.Empty: continue
        if msg.get("id") == mid:
            if "error" in msg: raise RuntimeError(f"{m}: {msg['error']}")
            return msg.get("result", {})
        if msg.get("method") == "Runtime.exceptionThrown":
            errors.append(json.dumps(msg["params"])[:300])
        q.put(msg)
    raise TimeoutError(m)

def ev(expr):
    return cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})["result"].get("value")

def shot(name, clip=None):
    p = {"format": "png"}
    if clip: p["clip"] = dict(clip, scale=1)
    open(os.path.join(OUT, name), "wb").write(base64.b64decode(cmd("Page.captureScreenshot", p)["data"]))
    print("shot", name)

def click(x, y):
    cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
    cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
    time.sleep(0.05)
    cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})

cmd("Page.enable"); cmd("Runtime.enable"); cmd("Network.enable")
cmd("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Fetch.enable", {"patterns": [{"urlPattern": "*hand_landmarker.task*"}]})
cmd("Page.navigate", {"url": URL})
time.sleep(2.6)

print("loading text:", ev("JSON.stringify({cn: document.getElementById('loadingText').textContent, en: document.getElementById('loadingTextEn').textContent, pct: document.getElementById('loadingPctNum').textContent})"))
print("prompt:", ev("(() => { const p = document.getElementById('musicPrompt'); return JSON.stringify({hidden: p.hidden, cls: p.className, title: document.querySelector('.mp-title').textContent, titleEn: document.querySelector('.mp-title-en').textContent, yes: document.getElementById('btnMusicYes').innerText.replace(/\\n/g,' / '), no: document.getElementById('btnMusicNo').innerText.replace(/\\n/g,' / ')}); })()"))
shot("dlg-a-prompt.png")

box = json.loads(ev("(() => { const r = document.getElementById('btnMusicYes').getBoundingClientRect(); return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()"))
cmd("Network.emulateNetworkConditions", {"offline": False, "latency": 60,
                                         "downloadThroughput": 300 * 1024, "uploadThroughput": 64000})
click(box["x"], box["y"])
time.sleep(1.4)
print("loading state:", ev("JSON.stringify({yes: document.getElementById('btnMusicYes').innerText.replace(/\\n/g,' / '), disabled: document.getElementById('btnMusicYes').disabled, no: document.getElementById('btnMusicNo').innerText.replace(/\\n/g,' / '), playing: window.__app.audio.playing})"))
shot("dlg-b-loading.png")

time.sleep(9.0)
print("after:", ev("JSON.stringify({hidden: document.getElementById('musicPrompt').hidden, cls: document.getElementById('musicPrompt').className, playing: window.__app.audio.playing, track: document.getElementById('trackName').textContent, pill: document.getElementById('btnPlayMusic').hidden})"))
shot("dlg-c-closed.png")

print("errors:", errors[:2])
ws.close(); proc.terminate()
