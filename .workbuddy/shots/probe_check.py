# -*- coding: utf-8 -*-
"""确认探针第四行已经带上 OK 手势实时分数。"""
import json
import os
import random
import shutil
import subprocess
import time
import urllib.request

import websocket

PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-probe-{PORT}"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

shutil.rmtree(PROFILE, ignore_errors=True)
proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
    f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-swiftshader", "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", "--window-size=1280,860",
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


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Log.enable")
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})

for i in range(60):
    time.sleep(0.5)
    if ev("!!(window.__app && window.__app.missYou)"):
        break

# 探针每 6 帧刷一次，等几帧
time.sleep(1.2)
print("probe visible:", ev("!document.getElementById('probe').hidden"))
print("---- probe text ----")
print(ev("document.getElementById('probe').textContent"))
print("hasOK:", ev("document.getElementById('probe').textContent.includes('OK')"))
print("errors:", errors[:5] if errors else "none")
ws.close()
proc.terminate()
print("done")
