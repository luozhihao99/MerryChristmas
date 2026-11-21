# -*- coding: utf-8 -*-
"""排障：接触阴影到底在不在场景里、渲染顺序和世界坐标对不对。"""
import json
import random
import shutil
import subprocess
import time
import urllib.request

import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-gd-{PORT}"
shutil.rmtree(PROFILE, ignore_errors=True)

proc = subprocess.Popen(
    [CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
     f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
     "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream",
     "--use-fake-device-for-media-stream", "--window-size=1440,900", "about:blank"],
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


def cmd(m, p=None):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": m, "params": p or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _id[0]:
            return msg.get("result", {})


def ev(e):
    r = cmd("Runtime.evaluate", {"expression": e, "returnByValue": True, "userGesture": True})
    if r.get("exceptionDetails"):
        return "ERR " + str(r["exceptionDetails"].get("exception", {}).get("description"))[:400]
    return r["result"].get("value")


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
cmd("Page.bringToFront")
for _ in range(120):
    time.sleep(0.4)
    if ev("!!(window.__app && window.__app.groundBase)"):
        break

print(ev("""(() => {
  const a = window.__app;
  let pile = null;
  a.tree.group.parent.traverse(o => {
    if (o.type === 'Group' && o.children.length === 9) pile = o;
  });
  const out = { found: !!pile, shadows: [], poolOrder: a.groundBase.pool.renderOrder,
                poolVisible: a.groundBase.pool.visible, spillVisible: a.groundBase.spill.visible };
  if (pile) {
    a.tree.group.parent.traverse(o => {
      if (o.isMesh && o.material && o.material.map && o.material.color && o.material.color.getHex() === 0
          && o.renderOrder === 3) {
        const v = new (o.position.constructor)();
        o.getWorldPosition(v);
        out.shadows.push({ y: +v.y.toFixed(4), r: +o.scale.x.toFixed(3), op: o.material.opacity,
                           vis: o.visible, ord: o.renderOrder, depthTest: o.material.depthTest,
                           transparent: o.material.transparent, blending: o.material.blending });
      }
    });
  }
  return JSON.stringify(out);
})()"""))

# 只看星云：关掉光池 / 回光 / 点光，雪和树保留，看粒子床本身够不够
ev("""(() => {
  const g = window.__app.groundBase;
  g.pool.visible = false; g.spill.visible = false;
  for (const l of g.baseLights) l.intensity = 0;
  g.nebulaMat.uniforms.uIntensity.value = 2.0;
  return 'ok';
})()""")
time.sleep(0.8)
r = cmd("Page.captureScreenshot", {"format": "png"})
import base64
open("gd-nebula.png", "wb").write(base64.b64decode(r["data"]))
from PIL import Image
im = Image.open("gd-nebula.png").convert("RGB")
im.crop((330, 660, 1110, 900)).resize((1560, 480), Image.LANCZOS).save("gd-nebula-base.png")
print("ok")

ws.close()
proc.terminate()
