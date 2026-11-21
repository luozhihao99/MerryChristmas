# -*- coding: utf-8 -*-
"""验证：加载遮罩是否等到「手势真的能用」才收起。

跑两遍：
  1) 正常网络 —— 记录进度数字/文案的整条时间线，以及遮罩收起那一刻 gesture.ready
  2) 摄像头被拒 —— 确认不会永久卡在遮罩上（应当降级成音乐模式放人进去）
"""
import base64
import json
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.request

import websocket

OUT = os.path.dirname(os.path.abspath(__file__))
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

SAMPLE = """(() => {
  const L = document.getElementById('loading');
  const pr = document.getElementById('probe');
  const g = window.__app && window.__app.gesture;
  return JSON.stringify({
    pct: document.getElementById('loadingPctNum').textContent,
    cn: document.getElementById('loadingText').textContent,
    en: document.getElementById('loadingTextEn').textContent,
    done: L.classList.contains('done'),
    wait: document.getElementById('loadingBarTrack').classList.contains('is-wait'),
    skip: !document.getElementById('btnSkip').hidden,
    ready: !!(g && g.ready),
    status: document.getElementById('statusText').textContent,
    prompt: !document.getElementById('musicPrompt').hidden,
  });
})()"""


def launch(deny_camera):
    port = random.randint(9700, 9799)
    profile = rf"C:\Users\Cling\AppData\Local\Temp\cdp-boot-{port}"
    shutil.rmtree(profile, ignore_errors=True)
    args = [
        CHROME, "--headless=new", f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
        "--enable-unsafe-swiftshader", "--window-size=1440,900",
        "--use-fake-device-for-media-stream",
    ]
    if deny_camera:
        # 不给 --use-fake-ui-for-media-stream，改为显式拒绝
        args.append("--deny-permission-prompts")
    else:
        args.append("--use-fake-ui-for-media-stream")
    args.append("about:blank")
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ws_url = None
    for _ in range(80):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list"))
            page = [t for t in tabs if t.get("type") == "page"]
            if page:
                ws_url = page[0]["webSocketDebuggerUrl"]
                break
        except Exception:
            pass
        time.sleep(0.25)
    return proc, ws_url


class Cdp:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=90)
        self._id = 0
        self.errors = []
        self.ws.send(json.dumps({"id": -1, "method": "Page.enable"}))
        self.ws.send(json.dumps({"id": -2, "method": "Runtime.enable"}))
        self.ws.send(json.dumps({"id": -3, "method": "Log.enable"}))

    def cmd(self, method, params=None):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if "method" in msg and msg["method"] in ("Runtime.exceptionThrown", "Log.entryAdded"):
                self.errors.append(json.dumps(msg.get("params", {}))[:300])
            if msg.get("id") == self._id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def ev(self, expr, await_promise=False):
        r = self.cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                          "awaitPromise": await_promise, "userGesture": True})
        if r.get("exceptionDetails"):
            return "ERR " + str(r["exceptionDetails"].get("exception", {}).get("description"))[:200]
        return r["result"].get("value")

    def shot(self, name):
        data = self.cmd("Page.captureScreenshot", {"format": "png"})["data"]
        with open(os.path.join(OUT, name), "wb") as fh:
            fh.write(base64.b64decode(data))
        print("  shot", name)


def run(deny_camera, tag, limit=40.0, shots=()):
    print(f"\n=== {tag} ===  camera={'denied' if deny_camera else 'allowed'}")
    proc, ws_url = launch(deny_camera)
    c = Cdp(ws_url)
    c.cmd("Emulation.setDeviceMetricsOverride",
          {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
    t0 = time.time()
    c.cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})

    due = {name: at for name, at in shots}
    done_shots = set()
    seen = []
    last = None
    while time.time() - t0 < limit:
        raw = c.ev(SAMPLE)
        if isinstance(raw, str) and raw.startswith("{"):
            s = json.loads(raw)
            key = (s["pct"], s["cn"], s["done"], s["skip"], s["wait"])
            if key != last:
                last = key
                print(f"  t={time.time()-t0:5.2f}s  {s['pct']:>3}%  wait={int(s['wait'])} "
                      f"skip={int(s['skip'])}  ready={int(s['ready'])}  {s['cn']}")
                seen.append((round(time.time() - t0, 2), s))
            for name, at in due.items():
                if name not in done_shots and time.time() - t0 >= at:
                    done_shots.add(name)
                    print(f"  ... t={at}s 截图，此刻 ready={s['ready']} pct={s['pct']}")
                    c.shot(name)
            if s["done"]:
                print(f"  >>> 遮罩收起于 t={time.time()-t0:.2f}s，"
                      f"那一刻 gesture.ready={s['ready']}  状态条「{s['status']}」")
                break
        time.sleep(0.08)
    else:
        print("  !!! 超时仍在遮罩上")

    time.sleep(1.5)
    print("  终态:", c.ev(SAMPLE))
    print("  时间线:", json.dumps(seen, ensure_ascii=False)[:1600])
    errs = [e for e in c.errors if "favicon" not in e]
    print("  报错:", errs[:3] if errs else "none")
    c.ws.close()
    proc.terminate()


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    if which in ("ok", "both"):
        run(False, "正常网络 + 摄像头允许", shots=(("boot-a-progress.png", 1.2),
                                                   ("boot-b-rig.png", 3.0)))
    if which in ("deny", "both"):
        run(True, "摄像头被拒", limit=40.0)
