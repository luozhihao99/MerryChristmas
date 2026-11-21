"""竖屏首屏截图（含音乐按钮）。"""
import base64, json, os, shutil, subprocess, threading, time, queue, urllib.request
import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9336
PROFILE = r"C:\Users\Cling\AppData\Local\Temp\cdp-mob-prof"
OUT = r"D:\aiWork\MediaPipe Hands\.workbuddy\shots"
shutil.rmtree(PROFILE, ignore_errors=True)

proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
    "--no-first-run", "--no-default-browser-check", "--enable-unsafe-swiftshader",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--window-size=414,896", "--hide-scrollbars", "about:blank",
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
        q.put(msg)
    raise TimeoutError(m)

cmd("Page.enable"); cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride", {"width": 414, "height": 896, "deviceScaleFactor": 2, "mobile": True})
cmd("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
cmd("Fetch.enable", {"patterns": [{"urlPattern": "*hand_landmarker.task*"}]})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html"})
time.sleep(2.2)
data = cmd("Page.captureScreenshot", {"format": "png", "clip": {"x": 0, "y": 0, "width": 414, "height": 896, "scale": 1}})["data"]
open(os.path.join(OUT, "load-mobile2.png"), "wb").write(base64.b64decode(data))
print("ok")
ws.close(); proc.terminate()
