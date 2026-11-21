# -*- coding: utf-8 -*-
"""诊断：crossorigin=anonymous 的 <audio> 到底卡在哪一步。"""
import json
import os
import random
import shutil
import subprocess
import time
import urllib.request

import websocket

PORT = random.randint(9700, 9799)
PROFILE = rf"C:\Users\Cling\AppData\Local\Temp\cdp-diag-{PORT}"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

shutil.rmtree(PROFILE, ignore_errors=True)
proc = subprocess.Popen([
    CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
    f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader",
    "--window-size=1200,800", "about:blank",
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

ws = websocket.create_connection(ws_url, timeout=60)
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


def ev(expr, await_promise=True):
    r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                 "awaitPromise": await_promise, "userGesture": True})
    if r.get("exceptionDetails"):
        return {"__err": str(r["exceptionDetails"].get("exception", {}).get("description"))}
    return r["result"].get("value")



cmd("Page.enable"); cmd("Runtime.enable")
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
time.sleep(2.5)
print("A: 走 AudioEngine 的 _ensureEl")
print(ev("""
(async () => {
  const a = window.__app.audio;
  a.ensureContext();
  const log = [];
  const el = a._ensureEl(true, 'anonymous');
  ['loadstart','progress','loadedmetadata','canplay','error','stalled','suspend','abort','emptied']
    .forEach(n => el.addEventListener(n, () => log.push(n + '/' + el.readyState + (n==='error' ? ' code=' + (el.error&&el.error.code) : ''))));
  el.src = 'http://127.0.0.1:8199/cors/tone.wav';
  el.load();
  await new Promise(r => setTimeout(r, 3000));
  return JSON.stringify({ co: el.crossOrigin, log, rs: el.readyState, dur: el.duration,
    net: el.networkState, err: el.error && el.error.code, ctx: a.ctx.state });
})()
"""))
print("B: 同一个 ctx 协议，但不 createMediaElementSource")
print(ev("""
(async () => {
  const log = [];
  const el = new Audio();
  el.crossOrigin = 'anonymous';
  el.preload = 'auto';
  ['loadedmetadata','error','canplay'].forEach(n => el.addEventListener(n, () => log.push(n)));
  el.src = 'http://127.0.0.1:8199/cors/tone.wav';
  await new Promise(r => setTimeout(r, 2000));
  return JSON.stringify({ log, rs: el.readyState, dur: el.duration, err: el.error && el.error.code });
})()
"""))
ws.close(); proc.terminate()
print("done")
