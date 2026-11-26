#!/usr/bin/env python3
"""Garmin forward proxy for via-server: lets the Cloudflare Worker read Garmin from the home IP.

It only ever connects to connect.garmin.com, only for the paths the sync reads, and only with
the shared token. It holds no Garmin credentials: the cookies come with each request.

POST /login starts garmin-login.service, so a dead session is fixed without waiting for the timer.

Env: GARMIN_PROXY_TOKEN (required), GARMIN_PROXY_PORT (8791), GARMIN_PROXY_BIND (127.0.0.1)
"""

import hmac
import http.client
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "connect.garmin.com"
GRAPHQL = "/gc-api/graphql-gateway/graphql"
TIMEOUT = 15
MAX_BODY = 64 * 1024
# Everything else stays behind, including the headers Cloudflare adds on the way here.
FORWARD = ("cookie", "connect-csrf-token", "accept", "accept-encoding", "content-type", "sec-fetch-site", "user-agent")
RETURN = ("content-type", "content-encoding", "location", "cf-mitigated", "set-cookie")


def allowed(method: str, path: str) -> bool:
    # Dots and escapes could climb out of /gc-api/.
    bare = path.split("?", 1)[0]
    if ".." in bare or "%" in bare or "\\" in bare or "//" in bare:
        return False
    if method == "GET":
        return bare == "/app/home" or bare.startswith("/gc-api/")
    return method == "POST" and path == GRAPHQL


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 60

    def log_request(self, code="-", size="-"):
        if not str(code).startswith("2"):
            super().log_request(code, size)

    def read_body(self) -> bytes:
        if self.headers.get("Transfer-Encoding", "").lower() != "chunked":
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 <= length <= MAX_BODY:
                raise ValueError
            return self.rfile.read(length)
        # cloudflared chunks a body whose length it wasn't told.
        body = b""
        while size := int(self.rfile.readline(20).split(b";")[0], 16):
            if not 0 < size <= MAX_BODY - len(body):
                raise ValueError
            body += self.rfile.read(size)
            self.rfile.readline(4)
        while self.rfile.readline(1024).strip():
            pass  # trailers
        return body

    def reply(self, status: int, origin: str, body: bytes, headers=()):
        self.send_response(status)
        # Tells the Worker whether a status came from Garmin or from this proxy.
        self.send_header("X-Garmin-Proxy", origin)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_request(self):
        try:
            body = self.read_body()
        except ValueError:
            self.close_connection = True
            return self.reply(413, "refused", b"bad or oversized body")

        sent = self.headers.get("Authorization", "").encode()
        if not hmac.compare_digest(sent, f"Bearer {os.environ['GARMIN_PROXY_TOKEN']}".encode()):
            return self.reply(401, "refused", b"bad token")
        if self.command == "POST" and self.path == "/login":
            subprocess.run(
                ["systemctl", "--user", "start", "--no-block", "garmin-login.service"], timeout=10, check=False
            )
            return self.reply(202, "refused", b"login requested")
        if not allowed(self.command, self.path):
            return self.reply(403, "refused", b"not a Garmin sync path")

        conn = http.client.HTTPSConnection(UPSTREAM, timeout=TIMEOUT)
        try:
            headers = {name: self.headers[name] for name in FORWARD if self.headers[name] is not None}
            conn.request(self.command, self.path, body or None, headers)
            res = conn.getresponse()
            data = res.read()
        except (OSError, http.client.HTTPException) as exc:
            return self.reply(504, "upstream-error", f"{type(exc).__name__}: {exc}".encode())
        finally:
            conn.close()
        self.reply(res.status, "garmin", data, [(k, v) for k, v in res.getheaders() if k.lower() in RETURN])

    do_GET = do_POST = handle_request


if __name__ == "__main__":
    if len(os.environ.get("GARMIN_PROXY_TOKEN", "")) < 32:
        raise SystemExit("GARMIN_PROXY_TOKEN must be at least 32 characters")
    address = (os.environ.get("GARMIN_PROXY_BIND", "127.0.0.1"), int(os.environ.get("GARMIN_PROXY_PORT", "8791")))
    print(f"proxying {UPSTREAM} on {address[0]}:{address[1]}", flush=True)
    ThreadingHTTPServer(address, Handler).serve_forever()
