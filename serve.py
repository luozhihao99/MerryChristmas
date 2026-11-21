#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
带 gzip 与缓存头的本地静态服务器，用来替代 `python -m http.server`。

为什么需要它：
  MediaPipe 的 wasm(9.2MB) + 模型(7.6MB) 默认是明文传输的，
  python 自带服务器不做压缩、也不发缓存头 —— 手机通过局域网访问时尤其慢。
  这里做四件事：
    1. 对 js/wasm/task 实时 gzip（wasm 通常能压到 35% 左右）
    2. 给 /vendor /assets 发一年 immutable 缓存，第二次打开不再下载
    3. 补上 .wasm / .task / .mjs 的 MIME，并把访问日志压到最低
    4. /__audio?url= 远端音频同源代理：直链不发 CORS 头时，浏览器既 fetch 不到、
       跨域 <audio> 又会被判成「污染」静音；由本地代取一份同源副本就能读频谱。
       代理**透传 Range 并边收边发**，所以 <audio> 仍然可以边下边播，
       不会等到整个文件下完才吐出第一个字节。
"""

import argparse
import gzip
import io
import os
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))

COMPRESSIBLE = {'.js', '.mjs', '.css', '.html', '.json', '.wasm', '.task', '.svg', '.txt'}
CACHE_DIRS = ('vendor', 'assets')          # 内容不变，可以长缓存
MIME = {
    '.wasm': 'application/wasm',
    '.task': 'application/octet-stream',
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
}

# 远端音频代理：默认音乐那种直链一般不发 CORS 头，浏览器 fetch 会被拦；
# 跨域 <audio> 又接不进 Web Audio（会被判成「污染」直接静音）。
# 由本地服务器代取，同源交给前端，就能读频谱驱动呼吸。
#
# 注意：**不做整段缓存、不整段 read**。以前那版会把整个文件读进内存再一次性吐出，
# 结果浏览器要等「全部下完」才拿到第一字节，一首 2MB 的歌要卡好几秒 ——
# 这里改成透传 Range + 64KB 边收边发，<audio> 就能真正边下边播。
AUDIO_PROXY = '/__audio'

_gz_cache = {}
_gz_lock = threading.Lock()


def open_remote_audio(url, range_header=None, method='GET'):
    """打开远端音频流（不读 body，交给调用方一块块转发）。"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (local preview audio proxy)',
        'Accept': 'audio/*,*/*',
    }
    if range_header:
        headers['Range'] = range_header
    req = urllib.request.Request(url, headers=headers, method='HEAD' if method == 'HEAD' else 'GET')
    return urllib.request.urlopen(req, timeout=20)


def gzip_bytes(path, data, st):
    key = (path, st.st_mtime_ns, st.st_size)
    with _gz_lock:
        hit = _gz_cache.get(key)
    if hit is not None:
        return hit
    out = gzip.compress(data, 6)
    with _gz_lock:
        if len(_gz_cache) > 32:
            _gz_cache.clear()
        _gz_cache[key] = out
    return out


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        if os.environ.get('SERVE_VERBOSE'):
            super().log_message(fmt, *args)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext) or super().guess_type(path)

    def _cache_control(self, path):
        rel = os.path.relpath(path, ROOT).replace('\\', '/')
        if any(rel.startswith(d + '/') for d in CACHE_DIRS):
            return 'public, max-age=31536000, immutable'
        return 'no-cache'

    # ---- 远端音频代理 ----

    def do_GET(self):
        if self.path.startswith(AUDIO_PROXY):
            return self._serve_audio()
        return super().do_GET()

    def do_HEAD(self):
        if self.path.startswith(AUDIO_PROXY):
            return self._serve_audio()
        return super().do_HEAD()

    def _serve_audio(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        url = (query.get('url') or [''])[0]
        if not url.lower().startswith(('http://', 'https://')):
            self.send_error(400, 'url 参数必须是 http(s) 地址')
            return

        # 浏览器的 <audio> 一定会先发 Range: bytes=0- 探路，拖动进度条时再发别的区间。
        # 原样透传给远端，让它只回需要的片段 —— 这是「边下边播」的前提。
        rng = self.headers.get('Range')
        is_head = self.command == 'HEAD'
        try:
            resp = open_remote_audio(url, rng, method='HEAD' if is_head else 'GET')
        except urllib.error.HTTPError as exc:
            # 416（区间越界）/ 404 之类：如实转回去，浏览器才知道该怎么退
            self.send_error(exc.code, f'远端音频返回 {exc.code}')
            return
        except Exception as exc:                      # noqa: BLE001
            self.send_error(502, f'代理取音频失败: {exc}')
            return

        ctype = resp.headers.get('Content-Type') or 'audio/mpeg'
        length = resp.headers.get('Content-Length')
        content_range = resp.headers.get('Content-Range')
        status = getattr(resp, 'status', None) or 200

        self.send_response(status)
        self.send_header('Content-Type', ctype)
        if length:
            self.send_header('Content-Length', length)
        else:
            # 远端用 chunked 时没有长度：HTTP/1.1 下必须关连接，否则浏览器会一直等结尾
            self.send_header('Connection', 'close')
            self.close_connection = True
        if content_range:
            self.send_header('Content-Range', content_range)
        # 告诉浏览器「这里支持按区间取」，否则它不会发 Range，也就没得流式
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'public, max-age=86400')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
        self.end_headers()

        if is_head:
            resp.close()
            return

        # 64KB 一块往下倒：第一块到手浏览器就能开始解码播放，
        # 不必等整个文件落盘。
        try:
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            # 用户切歌、拖动进度条、关页面都会主动断开，属正常
            pass
        except Exception:                             # noqa: BLE001
            pass
        finally:
            resp.close()

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(404, 'Not found')
            return None

        st = os.fstat(f.fileno())
        ext = os.path.splitext(path)[1].lower()
        raw_len = st.st_size
        body = f
        encoding = None

        if raw_len > 1400 and ext in COMPRESSIBLE and 'gzip' in self.headers.get('Accept-Encoding', ''):
            data = f.read()
            f.close()
            gz = gzip_bytes(path, data, st)
            body = io.BytesIO(gz)
            encoding = 'gzip'
            size = len(gz)
        else:
            size = raw_len

        self.send_response(200)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control', self._cache_control(path))
        self.send_header('Last-Modified', self.date_time_string(st.st_mtime))
        if encoding:
            self.send_header('Content-Encoding', encoding)
            self.send_header('Vary', 'Accept-Encoding')
            self.send_header('X-Uncompressed-Length', str(raw_len))
        self.end_headers()
        return body


def prewarm():
    """启动时把大文件预压缩一遍，避免第一个请求等 gzip。"""
    for rel in ('vendor/mediapipe/wasm/vision_wasm_internal.wasm',
                'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
                'assets/hand_landmarker.task',
                'vendor/three/three.module.js'):
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path):
            continue
        st = os.stat(path)
        with open(path, 'rb') as fh:
            data = fh.read()
        gz = gzip_bytes(path, data, st)
        print(f'  {rel:52s} {st.st_size/1048576:5.1f}MB → {len(gz)/1048576:5.1f}MB')


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ips)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8123)
    ap.add_argument('--host', default='0.0.0.0')
    args = ap.parse_args()

    print('预压缩静态资源：')
    prewarm()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'\n本地：http://127.0.0.1:{args.port}/index.html')
    for ip in lan_ips():
        print(f'局域网：http://{ip}:{args.port}/index.html   （手机需 https 才能开摄像头）')
    print('Ctrl+C 停止\n')

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
