# -*- coding: utf-8 -*-
"""量移动端顶栏：brand 与 audio-bar 是否放得下。"""
import base64, json, random, shutil, subprocess, time, urllib.request
import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-top-{PORT}"
shutil.rmtree(PROFILE, ignore_errors=True)

proc = subprocess.Popen(
    [CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
     f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
     "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream",
     "--use-fake-device-for-media-stream", "--window-size=500,900", "about:blank"],
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
        return "ERR " + str(r["exceptionDetails"].get("exception", {}).get("description"))[:300]
    return r["result"].get("value")


def shot(name):
    r = cmd("Page.captureScreenshot", {"format": "png"})
    open(name, "wb").write(base64.b64decode(r["data"]))
    print(" ", name)


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
time.sleep(3.0)

MEASURE = """(() => {
  const brand = document.querySelector('.brand');
  const bar = document.querySelector('.audio-bar');
  const top = document.querySelector('.hud-top');
  if (!brand || !bar) return null;
  const b = brand.getBoundingClientRect();
  const a = bar.getBoundingClientRect();
  return {
    vw: window.innerWidth,
    brandW: Math.round(b.width), brandRight: Math.round(b.right),
    barW: Math.round(a.width), barLeft: Math.round(a.left), barRight: Math.round(a.right),
    overflow: Math.round(a.right - window.innerWidth),
    overlap: Math.round(a.left - b.right),
  };
})()"""

for w in (320, 390, 414, 480, 600):
    cmd("Emulation.setDeviceMetricsOverride",
        {"width": w, "height": 896, "deviceScaleFactor": 2, "mobile": True})
    time.sleep(1.2)
    print(w, ev(MEASURE))

cmd("Emulation.setDeviceMetricsOverride",
    {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
time.sleep(0.8)
shot("top-after-390.png")

print("errors:", errors[:3])
ws.close()
proc.terminate()
