"""回归：弹窗不点、正常加载完，遮罩收起 + 胶囊出现。"""
import base64, json, os, shutil, subprocess, threading, time, queue, urllib.request
import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9338
PROFILE = r"C:\Users\Cling\AppData\Local\Temp\cdp-final-prof"
OUT = r"D:\aiWork\MediaPipe Hands\.workbuddy\shots"
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

def ev(expr):
    return cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True})["result"].get("value")

cmd("Page.enable"); cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
time.sleep(1.5)
print("prompt@1.5s:", ev("JSON.stringify({hidden: document.getElementById('musicPrompt').hidden, cls: document.getElementById('musicPrompt').className})"))
time.sleep(5.0)
print("after:", ev("""JSON.stringify({
  overlay: document.getElementById('loading').className,
  promptHidden: document.getElementById('musicPrompt').hidden,
  pct: document.getElementById('loadingPctNum').textContent,
  cn: document.getElementById('loadingText').textContent,
  en: document.getElementById('loadingTextEn').textContent,
  pillHidden: document.getElementById('btnPlayMusic').hidden,
  pause: document.getElementById('btnPause').textContent
})"""))
open(os.path.join(OUT, "final-check.png"), "wb").write(base64.b64decode(
    cmd("Page.captureScreenshot", {"format": "png"})["data"]))
ws.close(); proc.terminate()
