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


cmd("Page.enable")
cmd("Runtime.enable")
cmd("Page.navigate", {"url": "http://127.0.0.1:8123/index.html?debug"})
time.sleep(2)

print(ev("""
(async () => {
  const log = [];
  const el = new Audio();
  el.crossOrigin = 'anonymous';
  el.preload = 'auto';
  ['loadstart','progress','loadedmetadata','canplay','error','stalled','suspend','abort','emptied']
    .forEach(n => el.addEventListener(n, () => {
      log.push(n + ' rs=' + el.readyState + (n === 'error' ? ' code=' + (el.error && el.error.code) + ' msg=' + (el.error && el.error.message) : ''));
    }));
  el.src = 'http://127.0.0.1:8199/cors/tone.wav';
  el.load();
  await new Promise(r => setTimeout(r, 4000));
  return JSON.stringify({ log, rs: el.readyState, dur: el.duration,
    networkState: el.networkState, err: el.error && el.error.code }, null, 1);
})()
"""))

print("--- 用 fetch 看响应头是否真带 CORS ---")
print(ev("""
(async () => {
  try {
    const r = await fetch('http://127.0.0.1:8199/cors/tone.wav', { headers: { Range: 'bytes=0-1023' } });
    return JSON.stringify({ status: r.status, acao: r.headers.get('access-control-allow-origin'),
      ct: r.headers.get('content-type'), cr: r.headers.get('content-range'),
      len: r.headers.get('content-length') });
  } catch (e) { return 'FETCH ERR ' + e.message; }
})()
"""))

print("--- 无 CORS 属性的元素（对照）---")
print(ev("""
(async () => {
  const log = [];
  const el = new Audio();
  el.preload = 'auto';
  ['loadedmetadata','error','canplay'].forEach(n => el.addEventListener(n, () => log.push(n)));
  el.src = 'http://127.0.0.1:8199/cors/tone.wav';
  await new Promise(r => setTimeout(r, 2500));
  return JSON.stringify({ log, rs: el.readyState, dur: el.duration });
})()
"""))

ws.close()
proc.terminate()
print("done")
