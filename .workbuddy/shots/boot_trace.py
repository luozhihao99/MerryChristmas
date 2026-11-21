# -*- coding: utf-8 -*-
"""轻量时间线：只采进度数字/文案，不截图，看进度条是不是一直在走。"""
import json
import random
import shutil
import subprocess
import sys
import time
import urllib.request

import websocket

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

SAMPLE = """(() => {
  const g = window.__app && window.__app.gesture;
  return JSON.stringify({
    pct: document.getElementById('loadingPctNum').textContent,
    cn: document.getElementById('loadingText').textContent,
    done: document.getElementById('loading').classList.contains('done'),
    ready: !!(g && g.ready),
    skip: !document.getElementById('btnSkip').hidden,
  });
})()"""


def run(deny):
    port = random.randint(9700, 9799)
    profile = rf"C:\Users\Cling\AppData\Local\Temp\cdp-trace-{port}"
    shutil.rmtree(profile, ignore_errors=True)
    args = [CHROME, "--headless=new", f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
            "--enable-unsafe-swiftshader", "--use-fake-device-for-media-stream",
            "--window-size=1280,800"]
    args.append("--deny-permission-prompts" if deny else "--use-fake-ui-for-media-stream")
    args.append("about:blank")
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    ws_url = None
    for _ in range(80):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list"))
            p = [t for t in tabs if t.get("type") == "page"]
            if p:
                ws_url = p[0]["webSocketDebuggerUrl"]
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
                return msg.get("result", {})

    def ev(expr):
        r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True, "userGesture": True})
        return r["result"].get("value")

    cmd("Page.enable")
    cmd("Runtime.enable")
    t0 = time.time()
    cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
    # 不 bringToFront 的话页面算后台，rAF 被节流，进度条的逐帧补间根本不会跑
    cmd("Page.bringToFront")

    print(f"\n=== {'摄像头被拒' if deny else '正常'} ===")
    last_pct, last_cn, last_skip = None, None, None
    while time.time() - t0 < 45:
        raw = ev(SAMPLE)
        if isinstance(raw, str) and raw.startswith("{"):
            s = json.loads(raw)
            el = time.time() - t0
            if (s["pct"], s["cn"], s["skip"]) != (last_pct, last_cn, last_skip):
                print(f"  {el:5.2f}s  {s['pct']:>3}%  ready={int(s['ready'])} "
                      f"skip={int(s['skip'])}  {s['cn']}")
                last_pct, last_cn, last_skip = s["pct"], s["cn"], s["skip"]
            if s["done"]:
                print(f"  >>> 收起 @ {el:.2f}s  ready={s['ready']}")
                break
        time.sleep(0.06)
    else:
        print("  !!! 45 秒仍在遮罩上")
    ws.close()
    proc.terminate()


if __name__ == "__main__":
    run(sys.argv[1] == "deny" if len(sys.argv) > 1 else False)
