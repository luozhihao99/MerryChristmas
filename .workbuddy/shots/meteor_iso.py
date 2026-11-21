# -*- coding: utf-8 -*-
"""只显示流星层，确认它到底有没有画出来。"""
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
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-iso-{PORT}"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

shutil.rmtree(PROFILE, ignore_errors=True)
proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
    f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-swiftshader", "--window-size=1440,900", "about:blank",
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


def cmd(method, params=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id[0]:
            if "error" in msg:
                raise RuntimeError(msg["error"])
            return msg.get("result", {})


def ev(expr, await_promise=False):
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                 "awaitPromise": await_promise, "userGesture": True})
    if r.get("exceptionDetails"):
        return "ERR " + str(r["exceptionDetails"].get("exception", {}).get("description"))[:400]
    return r["result"].get("value")


def shot(name):
    data = cmd("Page.captureScreenshot", {"format": "png"})["data"]
    with open(os.path.join(OUT, name), "wb") as fh:
        fh.write(base64.b64decode(data))
    print("shot", name)


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
time.sleep(4)

print(ev("""(() => {
  const p = document.getElementById('musicPrompt');
  if (p) { p.hidden = true; }
  const pr = document.getElementById('probe');
  if (pr) pr.hidden = true;
  return 'ok';
})()"""))

print("meteor uniforms:", ev("""(() => {
  const l = window.__app.missYou.set[1];
  const u = l.mat.uniforms;
  return JSON.stringify({
    uHalfW: u.uHalfW && u.uHalfW.value, uLife: u.uLife && u.uLife.value,
    uSize: u.uSize && u.uSize.value, uIntensity: u.uIntensity && u.uIntensity.value,
    uStart: u.uStart.value, uTime: u.uTime.value,
    count: l.points.geometry.attributes.aSize.count,
    trailMax: (() => { const a = l.points.geometry.attributes.aTrail.array; let m = 0; for (const v of a) if (v > m) m = v; return m; })(),
    lenMax: (() => { const a = l.points.geometry.attributes.aLen.array; let m = 0; for (const v of a) if (v > m) m = v; return m; })(),
    delayMin: (() => { const a = l.points.geometry.attributes.aDelay.array; return Math.min(...a).toFixed(2); })(),
  });
})()"""))

# 只留流星
ev("""(() => {
  const m = window.__app.missYou;
  m.trigger(m.now);
  m.set.forEach((l, i) => { l.points.visible = i === 1; });
  return 'iso at ' + m.now.toFixed(1);
})()""")

for at, name in [(1.4, "iso-meteor-a.png"), (2.4, "iso-meteor-b.png")]:
    time.sleep(at if at == 1.4 else 1.0)
    print(ev("""(() => { const u = window.__app.missYou.set[1].mat.uniforms;
      return JSON.stringify({ t: +u.uTime.value.toFixed(2), start: +u.uStart.value.toFixed(2) }); })()"""))
    shot(name)

ws.close()
proc.terminate()
print("done")
