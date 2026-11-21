# -*- coding: utf-8 -*-
"""OK 手势那段特效的分阶段截图。"""
import base64
import json
import os
import random
import shutil
import subprocess
import time
import urllib.request

import websocket

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)))
PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-ok-{PORT}"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

shutil.rmtree(PROFILE, ignore_errors=True)
proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
    f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", "--window-size=1440,900",
    "about:blank",
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ws_url = None
for _ in range(80):
    try:
        tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list"))
        page = [t for t in tabs if t.get("type") == "page"]
        if page:
            ws_url = page[0]["webSocketDebuggerUrl"]
            break
    except Exception:
        pass
    time.sleep(0.25)

ws = websocket.create_connection(ws_url, timeout=90)
_id = [0]
errors = []


def cmd(method, params=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if "method" in msg and msg["method"] in ("Runtime.exceptionThrown", "Log.entryAdded"):
            errors.append(json.dumps(msg.get("params", {}))[:400])
        if msg.get("id") == _id[0]:
            if "error" in msg:
                raise RuntimeError(msg["error"])
            return msg.get("result", {})


def ev(expr, await_promise=False):
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                 "awaitPromise": await_promise, "userGesture": True})
    if r.get("exceptionDetails"):
        return "ERR " + str(r["exceptionDetails"].get("exception", {}).get("description"))[:300]
    return r["result"].get("value")


def shot(name):
    data = cmd("Page.captureScreenshot", {"format": "png"})["data"]
    with open(os.path.join(OUT, name), "wb") as fh:
        fh.write(base64.b64decode(data))
    print("shot", name)




cmd("Page.enable"); cmd("Runtime.enable")
logs = []
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
time.sleep(4)
print(ev("""(() => { const m = window.__app.missYou.set[0].mat; return m.vertexShader; })()"""))
print("===== 编译错误 =====")
print(ev("""(() => {
  window.__glErrs = [];
  const gl = document.querySelector('canvas').getContext('webgl2');
  const m = window.__app.missYou.set[0].mat;
  const vs = m.vertexShader, fs = m.fragmentShader;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    const ok = gl.getShaderParameter(s, gl.COMPILE_STATUS);
    if (!ok) window.__glErrs.push(gl.getShaderInfoLog(s)); return s; };
  sh(gl.VERTEX_SHADER, vs); sh(gl.FRAGMENT_SHADER, fs);
  return (window.__glErrs.join(' || ') || 'no error').slice(0, 500);
})()"""))
ws.close(); proc.terminate()
