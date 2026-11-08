"""Shared by the runner's tests: a runner in a thread, and requests to it."""

from __future__ import annotations

import http.client
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

RUNNER = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RUNNER))

from ngplatform_runner.jobs import JobManager  # noqa: E402
from ngplatform_runner.kinds import kinds_for  # noqa: E402
from ngplatform_runner.paths import Roots  # noqa: E402
from ngplatform_runner.server import RunnerServer  # noqa: E402

FIXTURES = RUNNER.parent / "plugins" / "zarr-vectors" / "testdata" / "tractograms"
TOKEN = "t" * 43


def tools_available() -> bool:
    try:
        import zarr_vectors_tools  # noqa: F401
    except ImportError:
        return False
    return True


class Runner:
    """A runner on a free port, with a temporary root and state folder."""

    def __init__(self, state: Path | None = None, root: Path | None = None, max_running: int = 2, public_url: str | None = None, services=None):
        self.tmp = tempfile.TemporaryDirectory(prefix="ngp-runner-")
        base = Path(self.tmp.name)
        self.state = state or base / "state"
        self.root = root or base / "root"
        self.root.mkdir(parents=True, exist_ok=True)
        self.public_url = public_url
        self.services = services
        self.start(max_running)

    def start(self, max_running: int = 2) -> None:
        self.manager = JobManager(self.state, kinds_for(True), python=sys.executable, max_running=max_running, poll=0.05)
        self.server = RunnerServer(0, TOKEN, Roots([self.root]), self.manager, python=sys.executable, tools=None, public_url=self.public_url, services=self.services)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def stop(self, cancel_running: bool = False) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.manager.stop(cancel_running=cancel_running)

    def close(self) -> None:
        self.stop(cancel_running=True)
        self.tmp.cleanup()

    def request(self, method: str, path: str, body=None, *, token: str | None = TOKEN, headers: dict | None = None, port: int | None = None):
        port = port or self.port
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        all_headers = {"Host": f"127.0.0.1:{port}"}
        if token is not None:
            all_headers["Authorization"] = f"Bearer {token}"
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            all_headers["Content-Type"] = "application/json"
        all_headers.update(headers or {})
        connection.request(method, path, body=data, headers=all_headers)
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        text = raw.decode("utf-8", "replace")
        try:
            value = json.loads(text) if text else None
        except ValueError:
            value = text
        return response.status, dict(response.getheaders()), value

    def wait(self, job_id: str, states=("done", "failed", "cancelled"), timeout: float = 60.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            status, _, job = self.request("GET", f"/jobs/{job_id}")
            assert status == 200, job
            if job["state"] in states:
                return job
            time.sleep(0.05)
        raise AssertionError(f"job {job_id} did not reach {states}: {job}")


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return True
