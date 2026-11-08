"""A small service for trying and testing ``--service``: ``--service echo="python -m ngplatform_runner.echo_service"``.

It listens where the runner says (``NGP_SERVICE_PORT``), refuses requests
without the runner's ``X-NGP-Service-Token``, and prints the ready line.
Through the runner, at ``/svc/echo/``:

- ``GET|POST|PUT|DELETE /echo``: the request as JSON (method, path, query, body, headers it was sent),
- ``GET /env``: what the runner gave it (roots, state folder, name),
- ``GET /stream?n=5&delay=0.2``: n lines, one every delay seconds, with no Content-Length (chunked),
- ``GET /wait?seconds=2``: answers after that long (a long poll),
- ``GET /bytes?n=1000000``: n bytes, with a Content-Length,
- ``POST /exit``: ends the process (code 3), so the runner starts it again.

``--fail`` ends at once with code 2, before the ready line (for the runner's give-up).
"""

from __future__ import annotations

import hmac
import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    token = ""

    def log_message(self, format, *args):  # noqa: A002
        pass

    def _send(self, status: int, body: bytes, content_type: str = "application/json", extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Echo-Pid", str(os.getpid()))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, value) -> None:
        self._send(status, json.dumps(value).encode())

    def _handle(self) -> None:
        given = self.headers.get("X-NGP-Service-Token") or ""
        if not given or not hmac.compare_digest(given.encode(), self.token.encode()):
            self._json(403, {"error": "no service token"})
            return
        split = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(split.query)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if split.path == "/echo":
            self._json(200, {"method": self.command, "path": split.path, "query": query, "body": body.decode("utf-8", "replace"), "headers": dict(self.headers.items())})
        elif split.path == "/env":
            self._json(200, {"roots": json.loads(os.environ.get("NGP_ROOTS", "[]")), "stateDir": os.environ.get("NGP_STATE_DIR"), "name": os.environ.get("NGP_SERVICE_NAME"), "cwd": os.getcwd()})
        elif split.path == "/stream":
            n = int((query.get("n") or ["5"])[0])
            delay = float((query.get("delay") or ["0.2"])[0])
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("X-Echo-Lines", str(n))
            self.end_headers()
            for i in range(n):
                data = f"line {i} {time.time():.3f}\n".encode()
                self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                self.wfile.flush()
                time.sleep(delay)
            self.wfile.write(b"0\r\n\r\n")
        elif split.path == "/wait":
            seconds = float((query.get("seconds") or ["1"])[0])
            time.sleep(seconds)
            self._json(200, {"waited": seconds})
        elif split.path == "/bytes":
            n = int((query.get("n") or ["1000"])[0])
            self._send(200, bytes(i % 251 for i in range(n)), "application/octet-stream")
        elif split.path == "/exit" and self.command == "POST":
            self._json(200, {"exiting": os.getpid()})
            self.wfile.flush()
            threading.Timer(0.05, lambda: os._exit(3)).start()
        else:
            self._json(404, {"error": f"no {self.command} {split.path}"})

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = _handle


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "--fail" in argv:
        print("echo service: failing on purpose", flush=True)
        return 2
    port = int(os.environ.get("NGP_SERVICE_PORT") or 0)
    Handler.token = os.environ.get("NGP_SERVICE_TOKEN") or ""
    if not Handler.token:
        print("echo service: NGP_SERVICE_TOKEN is not set (it is started by the runner's --service)", file=sys.stderr)
        return 1
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    print(f"echo service ready http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
