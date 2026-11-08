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

Through an SSH tunnel (``ssh -L 7000:127.0.0.1:8765 host``) the browser
addresses the runner as ``localhost:7000``: ``--public-url
http://localhost:7000`` lets the Host check take that too, and the
addresses the runner hands back (served stores) are made from the address
each request reached, so they work through the tunnel.

Services (``--service NAME=COMMAND``, services.py) are programs of their
own beside the runner; ``/svc/<name>/<rest>`` passes requests to them
(behind the token like the rest of the API), streaming their answers back.
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

from . import __version__, hostinfo
from .jobs import JobManager
from .kinds import BadRequest, check_servable, plan_serve
from .paths import PathRefused, Roots, find, listing
from .services import Services

DEFAULT_ORIGINS = ("https://alleninstitute.github.io",)
LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
MAX_BODY = 64 << 20
LOOPBACK_NAMES = ("127.0.0.1", "localhost", "[::1]")
STORE_URL = re.compile(r"^(?:[a-z+]+://)?https?://([^/]+)/stores/([0-9a-f]{32})(/.*)?$")
#: Seconds a service may take to answer (or between parts of a streamed answer): long polls wait a while.
SERVICE_TIMEOUT = 300.0
#: Request headers passed on to a service, besides X-* (the runner's own token is not).
SERVICE_REQUEST_HEADERS = {"accept", "accept-encoding", "accept-language", "cache-control", "content-type", "if-match", "if-modified-since", "if-none-match", "last-event-id", "range"}
#: Answer headers passed back from a service, besides X-*.
SERVICE_ANSWER_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Content-Encoding", "Content-Disposition", "Accept-Ranges", "Cache-Control", "ETag", "Last-Modified", "Retry-After", "Location")
NO_BODY = {204, 304}


class TooLarge(Exception):
    pass


def public_netlocs(public_url: str | None) -> set[str]:
    """The Host headers a public address (``http://localhost:7000``) is reached by."""
    if not public_url:
        return set()
    split = urllib.parse.urlsplit(public_url if "://" in public_url else f"http://{public_url}")
    if split.scheme not in ("http", "https") or not split.hostname:
        raise ValueError(f"--public-url takes an address such as http://localhost:7000 (not {public_url!r})")
    host = split.hostname.lower()
    host = f"[{host}]" if ":" in host else host
    port = split.port or (443 if split.scheme == "https" else 80)
    names = [host]
    if host in LOOPBACK_NAMES:
        names = list(LOOPBACK_NAMES)
    found = {f"{n}:{port}" for n in names}
    if split.port is None:
        found |= set(names)
    return found


def normalise_public_url(public_url: str | None) -> str | None:
    if not public_url:
        return None
    text = public_url if "://" in public_url else f"http://{public_url}"
    split = urllib.parse.urlsplit(text)
    return f"{split.scheme}://{split.netloc}"


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
        public_url: str | None = None,
        services: Services | None = None,
    ):
        public_hosts = public_netlocs(public_url)
        super().__init__(("127.0.0.1", port), Handler)
        self.public_url = normalise_public_url(public_url)
        self.hosts = {f"{n}:{self.server_port}" for n in LOOPBACK_NAMES} | public_hosts
        self.services = services
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
    def local_base(self) -> str:
        return f"http://127.0.0.1:{self.server_port}"

    @property
    def base(self) -> str:
        """The address to print and pair with: the public one (through a tunnel), else 127.0.0.1's."""
        return self.public_url or self.local_base

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

    def serve(self, path_text: str, base: str | None = None) -> dict[str, Any]:
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
                    return self.serve_info(serve, base)
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
            return self.serve_info(serve, base)

    def serve_info(self, serve: dict[str, Any], base: str | None = None) -> dict[str, Any]:
        """A serve as the app sees it; its url and source made from ``base``, the address the request reached."""
        info = {k: serve.get(k) for k in ("id", "path", "name", "mode", "url", "source", "ready", "job", "created")}
        if base is not None:
            m = STORE_URL.match(serve["url"])
            if m is not None:
                old = serve["url"][: m.start(2) - len("/stores/")]
                info["url"] = base + serve["url"][len(old):]
                info["source"] = serve["source"].replace(old + "/stores/", base + "/stores/", 1)
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
        m = STORE_URL.match(url.split("|")[0])
        if m is None or m.group(1).lower() not in self.hosts:
            return None
        serve = self.serves.get(m.group(2))
        return None if serve is None else serve["path"]

    def status(self, base: str | None = None) -> dict[str, Any]:
        return {
            "name": "ngplatform-runner",
            "version": __version__,
            "pid": os.getpid(),
            "started": self.started,
            "address": base or self.base,
            "publicUrl": self.public_url,
            **hostinfo.host(),
            "gpus": hostinfo.gpus(),
            "services": self.services.info() if self.services is not None else {},
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
        return (self.headers.get("Host") or "").lower() in self.server.hosts

    def _reached(self) -> str:
        """The address this request was sent to (``http://localhost:7000`` through a tunnel), for URLs handed back."""
        return f"http://{(self.headers.get('Host') or '').lower()}"

    def _cors(self, public: bool = False, expose: list[str] | None = None) -> None:
        # Served stores too answer only the allowed origins (the app's): their addresses travel in shared
        # links, and another site that learned one must not read the files while the runner runs.
        origin = self._origin()
        if public or expose:
            self.send_header("Access-Control-Expose-Headers", ", ".join(["Content-Range", "Content-Length", *(expose or [])]))
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

    def _json(self, status: int, value: Any, extra: dict | None = None) -> None:
        self._send(status, json.dumps(value).encode(), "application/json", extra=extra)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _authorised(self) -> bool:
        header = self.headers.get("Authorization") or ""
        given = header[7:].strip() if header.lower().startswith("bearer ") else ""
        return bool(given) and hmac.compare_digest(given.encode(), self.server.token.encode())

    def _raw_body(self) -> bytes | None:
        """The request's body (None when it has none), at most MAX_BODY bytes."""
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            out = bytearray()
            while True:
                line = self.rfile.readline(1024)
                try:
                    size = int(line.split(b";")[0].strip() or b"0", 16)
                except ValueError as e:
                    raise BadRequest("the request's chunked body cannot be read") from e
                if size == 0:
                    while self.rfile.readline(1024) not in (b"\r\n", b"\n", b""):
                        pass
                    return bytes(out)
                if len(out) + size > MAX_BODY:
                    raise TooLarge()
                out += self.rfile.read(size)
                self.rfile.readline(4)
        if self.headers.get("Content-Length") is None:
            return None
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError as e:
            raise BadRequest("Content-Length is not a number") from e
        if length > MAX_BODY:
            raise TooLarge()
        return self.rfile.read(length) if length > 0 else b""

    def _body(self) -> Any:
        raw = self._raw_body()
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
        allowed = ["Authorization", "Content-Type", "Range"]
        # A service's requests may carry headers of their own (X-*) and the usual request headers.
        for name in (self.headers.get("Access-Control-Request-Headers") or "").split(","):
            name = name.strip()
            lower = name.lower()
            if name and lower not in (a.lower() for a in allowed) and (lower.startswith("x-") or lower in SERVICE_REQUEST_HEADERS) and re.match(r"^[A-Za-z0-9-]+$", name):
                allowed.append(name)
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", ", ".join(allowed))
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

    def do_PUT(self) -> None:
        self._route("PUT")

    def do_DELETE(self) -> None:
        self._route("DELETE")

    def _route(self, method: str) -> None:
        try:
            if not self._host_allowed():
                self._error(403, "this runner answers only requests addressed to 127.0.0.1 or localhost at its port (or its --public-url)")
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
            if path.startswith("/svc/"):
                self._service(method, path[len("/svc/"):], split.query)
                return
            self._api(method, path, query)
        except TooLarge:
            self.close_connection = True
            self._error(413, f"the request is larger than {MAX_BODY >> 20} MB")
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
        if parts in (["status"], ["info"]) and method == "GET":
            self._json(200, s.status(self._reached()))
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
                self._json(200, {"serves": [s.serve_info(v, self._reached()) for v in s.serves.values()]})
        elif parts == ["serve"] and method == "POST":
            body = self._body()
            self._json(200, s.serve(body.get("path") or "", self._reached()))
        elif len(parts) == 2 and parts[0] == "serve" and method == "DELETE":
            self._json(200, {"stopped": parts[1]}) if s.stop_serving(parts[1]) else self._error(404, "nothing served with that id")
        else:
            self._error(404, f"no {method} {path}")

    # ---------------------------------------------------------------- services

    def _service(self, method: str, rest: str, query: str) -> None:
        """Passes ``/svc/<name>/<rest>?<query>`` to the service, and streams its answer back."""
        name, _, rest = rest.partition("/")
        services = self.server.services
        service = services.get(urllib.parse.unquote(name)) if services is not None else None
        body = self._raw_body()
        if service is None:
            self._error(404, f"this runner has no service {urllib.parse.unquote(name)!r} (start it with --service {urllib.parse.unquote(name)}=COMMAND)")
            return
        target = service.target()
        if target is None:
            info = service.info()
            self._json(503, {"error": info["error"] or f"the service {service.name} is starting", "service": info}, extra={"Retry-After": "2"})
            return
        port, token = target
        headers = {"X-NGP-Service-Token": token}
        for key, value in self.headers.items():
            lower = key.lower()
            if lower == "x-ngp-service-token":
                continue
            if lower in SERVICE_REQUEST_HEADERS or lower.startswith("x-"):
                headers[key] = value
        if body is not None:
            headers["Content-Length"] = str(len(body))
        target_path = "/" + rest + (f"?{query}" if query else "")
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=SERVICE_TIMEOUT)
        try:
            try:
                connection.request(method, target_path, body=body, headers=headers)
                response = connection.getresponse()
            except (OSError, http.client.HTTPException) as e:
                self._error(502, f"the service {service.name} did not answer: {e}")
                return
            self._stream_back(response, method)
        finally:
            connection.close()

    def _stream_back(self, response: http.client.HTTPResponse, method: str) -> None:
        passed = [(k, v) for k, v in ((h, response.getheader(h)) for h in SERVICE_ANSWER_HEADERS) if v is not None]
        own = [(k, v) for k, v in response.getheaders() if k.lower().startswith("x-")]
        self.send_response(response.status, response.reason)
        self._cors(expose=sorted({k for k, _ in own}))
        for k, v in passed + own:
            self.send_header(k, v)
        if response.getheader("Cache-Control") is None:
            self.send_header("Cache-Control", "no-store")
        length = response.getheader("Content-Length")
        empty = method == "HEAD" or response.status in NO_BODY or 100 <= response.status < 200
        chunked = not empty and length is None
        if chunked:
            self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        if empty:
            return
        try:
            sent = 0
            while True:
                data = response.read1(1 << 16)
                if not data:
                    break
                sent += len(data)
                if chunked:
                    self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                else:
                    self.wfile.write(data)
            if chunked:
                self.wfile.write(b"0\r\n\r\n")
            elif length is not None and sent < int(length):
                # The service ended before the length it promised: closing tells the browser the answer is cut short.
                self.close_connection = True
        except (OSError, http.client.HTTPException):
            # The service or the browser went away mid-answer: nothing more can be said on this connection.
            self.close_connection = True

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
