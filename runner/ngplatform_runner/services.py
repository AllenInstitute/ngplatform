"""Services: long-lived programs the runner starts beside it, and reaches for the app at ``/svc/<name>/``.

``--service NAME=COMMAND`` (the command split as a shell would, but run
without one) is started as a child process with:

- ``NGP_SERVICE_PORT``: a free port on 127.0.0.1 it should listen on,
- ``NGP_SERVICE_TOKEN``: a random token; every request the runner passes on
  carries it as ``X-NGP-Service-Token``, and the service should refuse
  requests without it (other programs on the computer can reach its port),
- ``NGP_ROOTS``: the runner's roots, a JSON list of paths,
- ``NGP_STATE_DIR``: a folder of its own, ``<state-dir>/services/<name>/``.

It runs in the runner's working folder, with this package importable
(``python -m ngplatform_runner.echo_service`` is a small one for trying it).

It prints a line containing ``ready http://127.0.0.1:<port>`` once it
answers there.  Its output goes to ``<state-dir>/services/<name>.log``.  If
it ends, it is started again (after 1 s, 2 s, 4 s ...); after 5 ends in a
row each within 30 s of starting, the runner gives up and reports the error
with the log's last lines.  It is stopped (SIGTERM, then SIGKILL after 5 s)
when the runner stops.
"""

from __future__ import annotations

import collections
import json
import os
import re
import secrets
import shlex
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from .jobs import _package_path

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
READY = re.compile(r"ready (http://127\.0\.0\.1:(\d+))")
QUICK_SECONDS = 30.0
GIVE_UP_AFTER = 5
LAST_LINES = 20


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def parse_spec(text: str) -> tuple[str, list[str]]:
    """``NAME=COMMAND`` as given to ``--service``: the name and the command's arguments."""
    name, sep, command = text.partition("=")
    name = name.strip()
    if not sep or not NAME.match(name):
        raise ValueError(f"--service takes NAME=COMMAND, NAME of letters, digits, '.', '_' or '-' (not {text!r})")
    try:
        argv = shlex.split(command)
    except ValueError as e:
        raise ValueError(f"--service {name}: the command cannot be read: {e}") from e
    if not argv:
        raise ValueError(f"--service {name}: the command is empty")
    return name, argv


class Service:
    """One service: its process, started again when it ends."""

    def __init__(self, name: str, argv: list[str], *, roots: list[str], state_dir: Path, backoff: float = 1.0, quick: float = QUICK_SECONDS):
        self.name = name
        self.argv = argv
        self.roots = roots
        self.folder = state_dir / "services" / name
        self.log_path = state_dir / "services" / f"{name}.log"
        self.backoff = backoff
        self.quick = quick
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.process: subprocess.Popen | None = None
        self.port: int | None = None
        self.token = ""
        self.ready = False
        self.error: str | None = None
        self.starts = 0
        self.gave_up = False
        self.last = collections.deque(maxlen=LAST_LINES)
        self.thread = threading.Thread(target=self._supervise, name=f"service-{name}", daemon=True)

    def start(self) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        self.thread.start()

    def info(self) -> dict[str, Any]:
        with self.lock:
            pid = self.process.pid if self.process is not None and self.process.poll() is None else None
            return {"ready": self.ready, "error": self.error, "pid": pid}

    def target(self) -> tuple[int, str] | None:
        """The port and token to reach it at, while it is ready."""
        with self.lock:
            if not self.ready or self.port is None:
                return None
            return self.port, self.token

    # ---------------------------------------------------------------- process

    def _spawn(self) -> subprocess.Popen:
        port = free_port()
        token = secrets.token_urlsafe(32)
        env = dict(os.environ)
        env.update(
            NGP_SERVICE_PORT=str(port),
            NGP_SERVICE_TOKEN=token,
            NGP_ROOTS=json.dumps(self.roots),
            NGP_STATE_DIR=str(self.folder),
            NGP_SERVICE_NAME=self.name,
            PYTHONUNBUFFERED="1",
        )
        # This package can be imported (python -m ngplatform_runner.echo_service) without leaking the runner's site-packages.
        package = str(_package_path(self.folder.parent.parent))
        env["PYTHONPATH"] = package + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        with self.lock:
            # Under the lock with stop(), so a service being stopped is never started again.
            if self.stopping.is_set():
                raise OSError("the runner is stopping")
            process = subprocess.Popen(
                self.argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                start_new_session=True,
            )
            self.process = process
            self.port = port
            self.token = token
            self.ready = False
            self.starts += 1
        return process

    def _supervise(self) -> None:
        quick_ends = 0
        while not self.stopping.is_set():
            started = time.monotonic()
            try:
                process = self._spawn()
            except OSError as e:
                code: int | None = None
                reason = f"could not be started: {e}"
            else:
                self._read(process)
                code = process.wait()
                reason = f"ended with exit code {code}"
            if self.stopping.is_set():
                break
            with self.lock:
                self.ready = False
            quick_ends = quick_ends + 1 if time.monotonic() - started < self.quick else 0
            tail = "\n".join(self.last)
            if quick_ends >= GIVE_UP_AFTER:
                with self.lock:
                    self.gave_up = True
                    self.error = f"{self.name} {reason}, {quick_ends} times in a row soon after starting; not started again (log: {self.log_path})" + (f"\n{tail}" if tail else "")
                self._log(f"[runner] {self.error}\n")
                return
            delay = min(30.0, self.backoff * 2 ** max(0, quick_ends - 1))
            with self.lock:
                self.error = f"{self.name} {reason}; starting it again in {delay:g} s" + (f"\n{tail}" if tail else "")
            self._log(f"[runner] {self.name} {reason}; starting it again in {delay:g} s\n")
            if self.stopping.wait(delay):
                break

    def _log(self, text: str) -> None:
        try:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(text)
        except OSError:
            pass

    def _read(self, process: subprocess.Popen) -> None:
        """Copies its output to the log, and marks it ready at its ready line."""
        assert process.stdout is not None
        with open(self.log_path, "ab") as log:
            log.write(f"[runner] {time.strftime('%Y-%m-%d %H:%M:%S')} starting {shlex.join(self.argv)} (PID {process.pid})\n".encode())
            log.flush()
            for raw in iter(process.stdout.readline, b""):
                log.write(raw)
                log.flush()
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                self.last.append(line)
                m = READY.search(line)
                if m is not None:
                    with self.lock:
                        if not self.ready:
                            self.port = int(m.group(2))
                            self.ready = True
                            self.error = None
        process.stdout.close()

    def stop(self, wait: float = 5.0) -> None:
        with self.lock:
            self.stopping.set()
            process = self.process
            self.ready = False
        if process is not None and process.poll() is None:
            self._end(process, wait)
        if self.thread.is_alive():
            self.thread.join(5.0)

    @staticmethod
    def _end(process: subprocess.Popen, wait: float) -> None:
        for sig, seconds in ((signal.SIGTERM, wait), (signal.SIGKILL, 2.0)):
            try:
                os.killpg(process.pid, sig)
            except (ProcessLookupError, PermissionError):
                return
            try:
                process.wait(seconds)
                return
            except subprocess.TimeoutExpired:
                continue


class Services:
    """The runner's services, by name."""

    def __init__(self, specs: list[tuple[str, list[str]]], *, roots: list[str], state_dir: Path, backoff: float = 1.0, quick: float = QUICK_SECONDS):
        self.services: dict[str, Service] = {}
        for name, argv in specs:
            if name in self.services:
                raise ValueError(f"--service {name} is given twice")
            self.services[name] = Service(name, argv, roots=roots, state_dir=state_dir, backoff=backoff, quick=quick)

    def start(self) -> None:
        for service in self.services.values():
            service.start()

    def stop(self) -> None:
        threads = [threading.Thread(target=s.stop) for s in self.services.values()]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    def get(self, name: str) -> Service | None:
        return self.services.get(name)

    def info(self) -> dict[str, dict[str, Any]]:
        return {name: s.info() for name, s in self.services.items()}

    def wait_ready(self, timeout: float = 30.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if all(s.info()["ready"] for s in self.services.values()):
                return True
            time.sleep(0.05)
        return False
