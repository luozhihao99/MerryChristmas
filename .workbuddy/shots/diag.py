"""快网路径：弹窗留在场景上等答复。"""
import base64, json, os, shutil, subprocess, threading, time, queue, urllib.request
import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9339
PROFILE = r"C:\Users\Cling\AppData\Local\Temp\cdp-final2-prof"
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

def ev(e):
    return cmd("Runtime.evaluate", {"expression": e, "returnByValue": True})["result"].get("value")

def shot(name):
    open(os.path.join(OUT, name), "wb").write(base64.b64decode(cmd("Page.captureScreenshot", {"format": "png"})["data"]))
    print("shot", name)

def click(x, y):
    cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
    cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
    time.sleep(0.05)
    cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})


cmd("Page.enable"); cmd("Runtime.enable")
cmd("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Runtime.enable")
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
for i in range(12):
    time.sleep(0.4)
    print(i, ev("""(() => {
      const p = document.getElementById('musicPrompt');
      const b = document.getElementById('btnMusicYes').getBoundingClientRect();
      return JSON.stringify({h: p.hidden, c: p.className, w: Math.round(b.width), y: Math.round(b.y),
        bar: document.getElementById('loadingBar').style.width,
        ov: document.getElementById('loading').className,
        n: document.querySelectorAll('#musicPrompt').length,
        src: document.querySelector('script[type=module]').src});
    })()"""))
ws.close(); proc.terminate()
