"""记录弹窗 / 遮罩的 class 变化时间线，排查「弹窗偶发不出现」。"""
import base64, json, os, random, shutil, subprocess, threading, time, queue, urllib.request
import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = random.randint(9400, 9499)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-diag2-{PORT}"
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

HOOK = """
window.__log = [];
const t0 = performance.now();
const pick = (el) => (el && (el.id === 'musicPrompt' || el.id === 'loading')) ? el : null;
const attach = () => new MutationObserver((recs) => {
  for (const r of recs) {
    const el = pick(r.target);
    if (!el) continue;
    const last = window.__log[window.__log.length - 1];
    const snap = { t: Math.round(performance.now() - t0), id: el.id, cls: el.className, hidden: el.hidden };
    if (last && last.id === snap.id && last.cls === snap.cls && last.hidden === snap.hidden) continue;
    window.__log.push(snap);
  }
}).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
attach();
"""

cmd("Page.enable"); cmd("Runtime.enable")
cmd("Page.addScriptToEvaluateOnNewDocument", {"source": HOOK})
cmd("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
time.sleep(6.0)
print(json.dumps(ev("window.__log"), ensure_ascii=False))
print("state:", ev("""JSON.stringify({rs: document.readyState, app: !!window.__app, ov: document.getElementById('loading').className, p: document.getElementById('musicPrompt').hidden, t: document.getElementById('loadingText').textContent, bar: document.getElementById('loadingBar').style.width})"""))
ws.close(); proc.terminate()
