# -*- coding: utf-8 -*-
"""
模拟一个音频 CDN：支持 Range、支持限速、分「带 CORS」和「不带 CORS」两条路径。
用来验证前端是真流式（首字节到就播）还是整首下完才播。
"""
import math
import os
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8199
RATE = 300 * 1024          # 字节/秒，模拟 2.4Mbps 的网
FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mock-tone.wav")
SECONDS = 40
SR = 22050


def build_wav(path):
    if os.path.exists(path):
        return
    n = SR * SECONDS
    frames = bytearray()
    for i in range(n):
        # 每 2 秒换一个音高，方便听出是不是连续播
        f = 220 if (i // (SR * 2)) % 2 == 0 else 330
        v = int(12000 * math.sin(2 * math.pi * f * i / SR))
        frames += struct.pack("<h", v)
    data = bytes(frames)
    with open(path, "wb") as fh:
        fh.write(b"RIFF")
        fh.write(struct.pack("<I", 36 + len(data)))
        fh.write(b"WAVEfmt ")
        fh.write(struct.pack("<IHHIIHH", 16, 1, 1, SR, SR * 2, 2, 16))
        fh.write(b"data")
        fh.write(struct.pack("<I", len(data)))
        fh.write(data)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        cors = self.path.startswith("/cors/")
        size = os.path.getsize(FILE)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        partial = False
        if rng and rng.startswith("bytes="):
            spec = rng.split("=", 1)[1].split(",")[0]
            a, _, b = spec.partition("-")
            if a:
                start = int(a)
            if b:
                end = min(int(b), size - 1)
            partial = True
        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if cors:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        self.end_headers()

        chunk = 32 * 1024
        pos = start
        with open(FILE, "rb") as fh:
            fh.seek(start)
            while pos <= end:
                data = fh.read(min(chunk, end - pos + 1))
                if not data:
                    break
                try:
                    self.wfile.write(data)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    return
                pos += len(data)
                time.sleep(len(data) / RATE)   # 限速：模拟真实网络


if __name__ == "__main__":
    build_wav(FILE)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"mock cdn on http://127.0.0.1:{PORT}  size={os.path.getsize(FILE)}", flush=True)
    srv.serve_forever()
