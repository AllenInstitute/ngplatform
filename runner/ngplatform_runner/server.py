"""The runner's HTTP server: the job API for the web app, and the files it serves to the viewer.

Only 127.0.0.1 is listened on.  Every API request must carry the pairing
token (``Authorization: Bearer <token>``) and, when it comes from a page,
an Origin the runner allows (ngplatform's site and localhost); the Host
header must name this computer (against DNS rebinding).  Preflights get
CORS headers and Chrome's Private Network Access header, since an https
page is calling http://127.0.0.1.

Files the viewer reads (``/stores/<id>/...``) are not behind the token,
because Neuroglancer cannot send one; each served path has a random id of
128 bits instead, given only to the app that asked for it.
"""

from __future__ import annotations

import hmac
import html
import http.client
import json
import os
import re
import secrets
import socket
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import __version__
from .jobs import JobManager
from .kinds import BadRequest, check_servable, plan_serve
from .paths import PathRefused, Roots, find, listing

DEFAULT_ORIGINS = ("https://alleninstitute.github.io",)
LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
MAX_BODY = 64 << 20


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class RunnerServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        port: int,
        token: str,
        roots: Roots,
        manager: JobManager,
        *,
        origins: list[str] | None = None,
        python: str = "",
        tools: str | None = None,
    ):
        super().__init__(("127.0.0.1", port), Handler)
        self.token = token
        self.roots = roots
        self.manager = manager
        manager.roots = roots
        self.origins = set(DEFAULT_ORIGINS) | set(o.rstrip("/") for o in (origins or []))
        self.python = python
        self.tools = tools
        self.started = time.time()
        self.serves_lock = threading.RLock()
        self.serves: dict[str, dict[str, Any]] = {s["id"]: s for s in manager.extra.get("serves", [])}
        self._restore_serves()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.server_port}"

    # ---------------------------------------------------------------- serving

    def _save_serves(self) -> None:
        self.manager.save_extra("serves", list(self.serves.values()))

    def _restore_serves(self) -> None:
        """Serves from before a restart: files served by a process are started again if it ended."""
        with self.serves_lock:
            for serve in list(self.serves.values()):
                if serve["mode"] != "virtual":
                    continue
                job = self.manager.jobs.get(serve.get("job") or "")
                if job is not None and job["state"] in ("queued", "running"):
                    self._watch_ready(serve, job["id"], already=True)
                    continue
                path = Path(serve["path"])
                if not path.exists():
                    del self.serves[serve["id"]]
                    continue
                self._start_virtual(serve)
            self._save_serves()

    def _start_virtual(self, serve: dict[str, Any]) -> None:
        port = free_port()
        job = self.manager.submit("serve", plan_serve(Path(serve["path"]), port), serve={"id": serve["id"], "url": serve["url"]})
        serve.update(job=job["id"], port=port, ready=False, error=None)
        self._watch_ready(serve, job["id"])

    def _watch_ready(self, serve: dict[str, Any], job_id: str, already: bool = False) -> None:
        def hook(line: str) -> None:
            if "http://127.0.0.1:" in line and not serve.get("ready"):
                serve["ready"] = True
                job = self.manager.jobs.get(job_id)
                if job is not None:
                    job["message"] = f"Serving {serve['name']}"
                self._save_serves()

        if already and serve.get("ready"):
            return
        self.manager.watch_lines(job_id, hook)

    def serve(self, path_text: str) -> dict[str, Any]:
        path = self.roots.existing(path_text)
        mode = check_servable(path)
        with self.serves_lock:
            for serve in self.serves.values():
                if serve["path"] == str(path):
                    if serve["mode"] == "virtual":
                        job = self.manager.jobs.get(serve.get("job") or "")
                        if job is None or job["state"] not in ("queued", "running"):
                            self._start_virtual(serve)
                            self._save_serves()
                    return self.serve_info(serve)
            sid = secrets.token_hex(16)
            name = path.name
            quoted = urllib.parse.quote(name)
            if mode == "file":
                url = f"{self.base}/stores/{sid}/{quoted}"
                source = f"nifti://{url}"
            else:
                url = f"{self.base}/stores/{sid}/{quoted}/"
                source = f"{url}|zarr-vectors:"
            serve = {"id": sid, "path": str(path), "name": name, "mode": mode, "url": url, "source": source, "created": time.time(), "ready": mode != "virtual"}
            self.serves[sid] = serve
            if mode == "virtual":
                self._start_virtual(serve)
            self._save_serves()
            return self.serve_info(serve)

    def serve_info(self, serve: dict[str, Any]) -> dict[str, Any]:
        info = {k: serve.get(k) for k in ("id", "path", "name", "mode", "url", "source", "ready", "job", "created")}
        if serve["mode"] == "virtual":
            job = self.manager.jobs.get(serve.get("job") or "")
            if job is not None and job["state"] in ("failed", "cancelled", "done"):
                info["ready"] = False
                info["error"] = job.get("message") or f"The serving process {job['state']}"
        return info

    def stop_serving(self, sid: str) -> bool:
        with self.serves_lock:
            serve = self.serves.pop(sid, None)
            if serve is None:
                return False
            if serve.get("job"):
                self.manager.cancel(serve["job"])
            self._save_serves()
            return True

    def resolve_url(self, url: str) -> str | None:
        """The path a URL this runner serves reads (a layer's source), if it is one."""
        m = re.match(r"^(?:[a-z+]+://)?https?://(?:127\.0\.0\.1|localhost):(\d+)/stores/([0-9a-f]{32})(/.*)?$", url.split("|")[0])
        if m is None or int(m.group(1)) != self.server_port:
            return None
        serve = self.serves.get(m.group(2))
        return None if serve is None else serve["path"]

    def status(self) -> dict[str, Any]:
        return {
            "name": "ngplatform-runner",
            "version": __version__,
            "pid": os.getpid(),
            "started": self.started,
            "address": self.base,
            "roots": [str(r) for r in self.roots],
            "python": self.python,
            "tools": self.tools,
            "maxRunning": self.manager.max_running,
            "kinds": [{"kind": k.name, "title": k.title, "description": k.description} for k in self.manager.kinds.values()],
        }


class Handler(BaseHTTPRequestHandler):
    server: RunnerServer
    protocol_version = "HTTP/1.1"
    server_version = f"ngplatform-runner/{__version__}"

    def log_message(self, format, *args):  # noqa: A002 - BaseHTTPRequestHandler's name
        pass

    # ---------------------------------------------------------------- checks

    def _origin(self) -> str | None:
        return self.headers.get("Origin")

    def _origin_allowed(self, origin: str | None) -> bool:
        if origin is None:
            return True
        origin = origin.rstrip("/")
        return origin in self.server.origins or LOCAL_ORIGIN.match(origin) is not None

    def _host_allowed(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        port = self.server.server_port
        return host in (f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}")

    def _cors(self, public: bool = False) -> None:
        # Served stores too answer only the allowed origins (the app's): their addresses travel in shared
        # links, and another site that learned one must not read the files while the runner runs.
        origin = self._origin()
        if public:
            self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length")
        if origin is not None and self._origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _send(self, status: int, body: bytes, content_type: str, public: bool = False, extra: dict | None = None) -> None:
        self.send_response(status)
        self._cors(public)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, value: Any) -> None:
        self._send(status, json.dumps(value).encode(), "application/json")

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _authorised(self) -> bool:
        header = self.headers.get("Authorization") or ""
        given = header[7:].strip() if header.lower().startswith("bearer ") else ""
        return bool(given) and hmac.compare_digest(given.encode(), self.server.token.encode())

    def _body(self) -> Any:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise BadRequest("the request is too large")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError as e:
            raise BadRequest(f"the body is not JSON: {e}") from e

    # ---------------------------------------------------------------- methods

    def do_OPTIONS(self) -> None:
        if not self._host_allowed():
            self._send(403, b"", "text/plain")
            return
        path = urllib.parse.urlsplit(self.path).path
        public = path.startswith("/stores/")
        origin = self._origin()
        if not self._origin_allowed(origin):
            self._send(403, b"", "text/plain")
            return
        self.send_response(204)
        self._cors(public)
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
        self.send_header("Access-Control-Max-Age", "600")
        if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self) -> None:
        self._route("HEAD")

    def do_GET(self) -> None:
        self._route("GET")

    def do_POST(self) -> None:
        self._route("POST")

    def do_DELETE(self) -> None:
        self._route("DELETE")

    def _route(self, method: str) -> None:
        try:
            if not self._host_allowed():
                self._error(403, "this runner answers only requests addressed to 127.0.0.1 or localhost")
                return
            split = urllib.parse.urlsplit(self.path)
            path = split.path
            query = urllib.parse.parse_qs(split.query)
            if path.startswith("/stores/") and method in ("GET", "HEAD"):
                self._stores(path)
                return
            if not self._origin_allowed(self._origin()):
                self._error(403, f"the origin {self._origin()} is not allowed (start the runner with --allow-origin {self._origin()})")
                return
            if not self._authorised():
                self._error(401, "the pairing token is missing or wrong")
                return
            self._api(method, path, query)
        except PathRefused as e:
            self._error(403, str(e))
        except BadRequest as e:
            self._error(400, str(e))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001 - reported to the app, not a crash
            self._error(500, f"{type(e).__name__}: {e}")

    def _api(self, method: str, path: str, query: dict) -> None:
        s = self.server
        m = s.manager
        parts = [p for p in path.split("/") if p]
        if parts == ["status"] and method == "GET":
            self._json(200, s.status())
        elif parts == ["jobs"] and method == "GET":
            self._json(200, {"jobs": m.list()})
        elif parts == ["jobs"] and method == "POST":
            body = self._body()
            kind = body.get("kind")
            if not isinstance(kind, str):
                raise BadRequest("kind is missing")
            args = body.get("args") or {}
            if not isinstance(args, dict):
                raise BadRequest("args must be an object")
            if "input" in args and isinstance(args["input"], str):
                served = s.resolve_url(args["input"])
                if served is not None:
                    args["input"] = served
            self._json(201, m.start(kind, args))
        elif len(parts) == 2 and parts[0] == "jobs" and method == "GET":
            job = m.get(parts[1])
            self._json(200, job) if job else self._error(404, "no such job")
        elif len(parts) == 2 and parts[0] == "jobs" and method == "DELETE":
            if m.forget(parts[1]):
                self._json(200, {"forgotten": parts[1]})
            else:
                self._error(409 if m.get(parts[1]) else 404, "only a finished job can be taken off the list")
        elif len(parts) == 3 and parts[0] == "jobs" and parts[2] == "log" and method == "GET":
            try:
                tail = int((query.get("tail") or ["65536"])[0])
            except ValueError as e:
                raise BadRequest("tail must be a whole number of bytes") from e
            log = m.log(parts[1], tail=max(1, min(tail, 4 << 20)))
            self._json(200, log) if log else self._error(404, "no such job")
        elif len(parts) == 3 and parts[0] == "jobs" and parts[2] == "cancel" and method == "POST":
            job = m.cancel(parts[1])
            self._json(200, job) if job else self._error(404, "no such job")
        elif parts == ["files"] and method == "GET":
            self._json(200, listing(s.roots, (query.get("path") or [""])[0]))
        elif parts == ["find"] and method == "GET":
            self._json(200, find(s.roots, (query.get("name") or [""])[0]))
        elif parts == ["resolve"] and method == "GET":
            url = (query.get("url") or [""])[0]
            self._json(200, {"url": url, "path": s.resolve_url(url)})
        elif parts == ["serve"] and method == "GET":
            with s.serves_lock:
                self._json(200, {"serves": [s.serve_info(v) for v in s.serves.values()]})
        elif parts == ["serve"] and method == "POST":
            body = self._body()
            self._json(200, s.serve(body.get("path") or ""))
        elif len(parts) == 2 and parts[0] == "serve" and method == "DELETE":
            self._json(200, {"stopped": parts[1]}) if s.stop_serving(parts[1]) else self._error(404, "nothing served with that id")
        else:
            self._error(404, f"no {method} {path}")

    # ---------------------------------------------------------------- stores

    def _stores(self, path: str) -> None:
        parts = path.split("/", 3)  # "", "stores", id, rest
        sid = parts[2] if len(parts) > 2 else ""
        rest = urllib.parse.unquote(parts[3]) if len(parts) > 3 else ""
        serve = self.server.serves.get(sid)
        if serve is None:
            self._send(404, b"not served", "text/plain", public=True)
            return
        if serve["mode"] == "virtual":
            self._proxy(serve, parts[3] if len(parts) > 3 else "")
            return
        base = Path(serve["path"])
        if serve["mode"] == "file":
            if rest != serve["name"]:
                self._send(404, b"", "text/plain", public=True)
                return
            self._file(base)
            return
        name, _, key = rest.partition("/")
        if name != serve["name"]:
            self._send(404, b"", "text/plain", public=True)
            return
        target = (base / key).resolve() if key else base
        if target != base and base not in target.parents:
            self._send(404, b"", "text/plain", public=True)
            return
        if target.is_dir():
            if key and not key.endswith("/"):
                self._send(404, b"", "text/plain", public=True)
                return
            names = sorted(n + ("/" if (target / n).is_dir() else "") for n in os.listdir(target) if not n.startswith("."))
            body = ("<!DOCTYPE html><html><body><ul>" + "".join(f'<li><a href="{html.escape(urllib.parse.quote(n))}">{html.escape(n)}</a></li>' for n in names) + "</ul></body></html>").encode()
            self._send(200, body, "text/html", public=True)
        elif target.is_file():
            self._file(target)
        else:
            self._send(404, b"", "text/plain", public=True)

    def _file(self, target: Path) -> None:
        size = target.stat().st_size
        start, end = 0, size
        status = 200
        extra = {"Accept-Ranges": "bytes"}
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range", "") or "")
        if m:
            if m.group(1) == "":
                start = max(0, size - int(m.group(2) or 0))
            else:
                start = int(m.group(1))
                end = min(size, int(m.group(2)) + 1) if m.group(2) else size
            if start >= size and size > 0:
                self._send(416, b"", "text/plain", public=True, extra={"Content-Range": f"bytes */{size}"})
                return
            status = 206
            extra["Content-Range"] = f"bytes {start}-{max(start, end - 1)}/{size}"
        length = max(0, end - start)
        self.send_response(status)
        self._cors(public=True)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(length))
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(target, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(left, 1 << 20))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def _proxy(self, serve: dict[str, Any], rest: str) -> None:
        if not serve.get("ready") or not serve.get("port"):
            self._send(503, b"still reading the file", "text/plain", public=True, extra={"Retry-After": "2"})
            return
        connection = http.client.HTTPConnection("127.0.0.1", serve["port"], timeout=60)
        headers = {}
        if self.headers.get("Range"):
            headers["Range"] = self.headers["Range"]
        try:
            connection.request(self.command, "/" + rest, headers=headers)
            response = connection.getresponse()
            body = response.read()
        except OSError as e:
            self._send(502, f"the serving process did not answer: {e}".encode(), "text/plain", public=True)
            return
        finally:
            connection.close()
        extra = {}
        for name in ("Content-Range", "Accept-Ranges"):
            if response.getheader(name):
                extra[name] = response.getheader(name)
        self.send_response(response.status)
        self._cors(public=True)
        self.send_header("Content-Type", response.getheader("Content-Type") or "application/octet-stream")
        self.send_header("Content-Length", response.getheader("Content-Length") or str(len(body)))
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
