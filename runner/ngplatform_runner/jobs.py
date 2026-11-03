"""Jobs: subprocesses of known kinds, their state, logs and progress.

Each job is a process of its own (``python -m ngplatform_runner.child``,
which runs the kind's module in the same process), started in a new
process group so cancelling it ends everything it started.  Its output goes
to a log file in its folder (``<state>/jobs/<id>/log.txt``), which the
runner reads for progress; when it ends it writes ``result.json`` with its
exit code.  The job list is kept in ``<state>/state.json``, so a runner
started again shows the jobs it ran before and picks up those still running.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .kinds import BadRequest, Kind, Plan, plan_serve, progress_line

STATES = ("queued", "running", "done", "failed", "cancelled")
FINISHED = ("done", "failed", "cancelled")
PACKAGE_DIR = Path(__file__).resolve().parent


def _package_path(state_dir: Path) -> Path:
    """A folder holding only this package, for the jobs' PYTHONPATH.

    The package's own parent may be a whole site-packages, which must not
    leak into a job run with another Python (``--python``).
    """
    folder = state_dir / "pkg"
    folder.mkdir(parents=True, exist_ok=True)
    link = folder / "ngplatform_runner"
    try:
        if link.is_symlink() and link.resolve() == PACKAGE_DIR:
            return folder
        if link.is_symlink() or link.is_file():
            link.unlink()
        elif link.is_dir():
            shutil.rmtree(link)
        link.symlink_to(PACKAGE_DIR, target_is_directory=True)
    except OSError:
        shutil.copytree(PACKAGE_DIR, link, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__"))
    return folder


def _process_start(pid: int) -> str | None:
    """The process's start time as the OS records it (Linux), to tell it from a later process with the PID."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            text = f.read()
        return text.rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def _alive(pid: int, start: str | None) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return False
    if sys.platform.startswith("linux"):
        try:
            with open(f"/proc/{pid}/stat") as f:
                state = f.read().rsplit(")", 1)[1].split()[0]
            if state == "Z":
                return False
        except OSError:
            return False
        if start is not None and _process_start(pid) != start:
            return False
    return True


def _terminate_tree(pid: int, hard: bool = False) -> None:
    if os.name == "nt":  # pragma: no cover - Windows
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)
        return
    try:
        os.killpg(pid, signal.SIGKILL if hard else signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(pid, signal.SIGKILL if hard else signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass


class JobManager:
    """Starts, watches, cancels and remembers jobs."""

    def __init__(
        self,
        state_dir: Path,
        kinds: dict[str, Kind],
        *,
        python: str = sys.executable,
        max_running: int = 2,
        poll: float = 0.25,
        on_change: Callable[[], None] | None = None,
    ):
        self.state_dir = Path(state_dir)
        self.jobs_dir = self.state_dir / "jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.state_file = self.state_dir / "state.json"
        self.package_path = _package_path(self.state_dir)
        self.kinds = kinds
        self.python = python
        self.max_running = max_running
        self.poll = poll
        self.on_change = on_change
        self.lock = threading.RLock()
        self.jobs: dict[str, dict[str, Any]] = {}
        self.extra: dict[str, Any] = {}
        self.next_id = 1
        self.procs: dict[str, subprocess.Popen] = {}
        self.offsets: dict[str, int] = {}
        self.partial: dict[str, str] = {}
        self.line_hooks: dict[str, Callable[[str], None]] = {}
        self.last_saved = 0.0
        self.dirty = False
        self.stopping = threading.Event()
        self._load()
        self.thread = threading.Thread(target=self._watch, name="job watcher", daemon=True)
        self.thread.start()

    # ------------------------------------------------------------------ state

    def _load(self) -> None:
        if not self.state_file.is_file():
            return
        try:
            data = json.loads(self.state_file.read_text())
        except (OSError, ValueError):
            return
        self.next_id = int(data.get("next_id", 1))
        self.extra = data.get("extra", {}) or {}
        for job in data.get("jobs", []):
            self.jobs[job["id"]] = job
        for job in self.jobs.values():
            if job["state"] == "running":
                result = self._result(job)
                if result is not None:
                    self._finish(job, result)
                elif job.get("pid") and _alive(job["pid"], job.get("pid_start")):
                    # Still running: watched from its log and its PID.
                    self.offsets[job["id"]] = 0
                    job["adopted"] = True
                elif job.get("cancel_requested"):
                    self._finish(job, None)
                else:
                    job["state"] = "failed"
                    job["finished"] = job.get("finished") or time.time()
                    job["message"] = "The runner stopped while this job ran, and the job ended without a result."
        self._save(force=True)

    def _save(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self.last_saved < 2.0:
            self.dirty = True
            return
        self.last_saved = now
        self.dirty = False
        data = {"version": 1, "next_id": self.next_id, "jobs": list(self.jobs.values()), "extra": self.extra}
        tmp = self.state_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=1))
        os.replace(tmp, self.state_file)

    def save_extra(self, key: str, value: Any) -> None:
        with self.lock:
            self.extra[key] = value
            self._save(force=True)

    def _changed(self, force: bool = False) -> None:
        self._save(force=force)
        if self.on_change is not None:
            self.on_change()

    # ------------------------------------------------------------------ api

    def list(self) -> list[dict[str, Any]]:
        with self.lock:
            return [self.public(j) for j in sorted(self.jobs.values(), key=lambda j: int(j["id"]), reverse=True)]

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self.lock:
            job = self.jobs.get(job_id)
            return None if job is None else self.public(job)

    @staticmethod
    def public(job: dict[str, Any]) -> dict[str, Any]:
        keys = ("id", "kind", "title", "args", "pid", "state", "created", "started", "finished", "progress", "message", "outputs", "returncode", "serve")
        return {k: job.get(k) for k in keys if k in job}

    def submit(self, kind_name: str, plan: Plan, *, serve: dict | None = None) -> dict[str, Any]:
        with self.lock:
            job_id = str(self.next_id)
            self.next_id += 1
            folder = self.jobs_dir / job_id
            folder.mkdir(parents=True, exist_ok=True)
            for name, text in plan.files.items():
                (folder / name).write_text(text)
            job = {
                "id": job_id,
                "kind": kind_name,
                "title": plan.title,
                "args": plan.shown,
                "module": plan.module,
                "argv": [a.replace("{job}", str(folder)) for a in plan.argv],
                "state": "queued",
                "created": time.time(),
                "started": None,
                "finished": None,
                "progress": None,
                "message": "Waiting for a free slot" if serve is None else "",
                "outputs": plan.outputs,
                "pid": None,
            }
            if serve is not None:
                job["serve"] = serve
            self.jobs[job_id] = job
            self._start_queued()
            self._changed(force=True)
            return self.public(job)

    def start(self, kind_name: str, plan_args: dict) -> dict[str, Any]:
        kind = self.kinds.get(kind_name)
        if kind is None:
            raise BadRequest(f"unknown job kind {kind_name!r}; the kinds are {', '.join(self.kinds)}")
        return self.submit(kind_name, kind.plan(self.roots, plan_args))

    roots: Any = None  # set by the server

    def cancel(self, job_id: str) -> dict[str, Any] | None:
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                return None
            if job["state"] == "queued":
                job["state"] = "cancelled"
                job["finished"] = time.time()
                job["message"] = "Cancelled before it started"
                self._changed(force=True)
            elif job["state"] == "running":
                job["cancel_requested"] = time.time()
                job["message"] = "Cancelling…"
                _terminate_tree(job["pid"])
                self._changed(force=True)
            return self.public(job)

    def forget(self, job_id: str) -> bool:
        """Takes a finished job off the list (its outputs stay)."""
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None or job["state"] not in FINISHED:
                return False
            del self.jobs[job_id]
            self._changed(force=True)
            return True

    def log(self, job_id: str, tail: int = 65536) -> dict[str, Any] | None:
        with self.lock:
            job = self.jobs.get(job_id)
        if job is None:
            return None
        path = self.jobs_dir / job_id / "log.txt"
        try:
            size = path.stat().st_size
            with open(path, "rb") as f:
                f.seek(max(0, size - tail))
                data = f.read()
        except OSError:
            return {"id": job_id, "text": "", "size": 0, "truncated": False}
        return {"id": job_id, "text": data.decode("utf-8", "replace"), "size": size, "truncated": size > tail}

    def watch_lines(self, job_id: str, hook: Callable[[str], None]) -> None:
        """Calls ``hook`` with each line the job writes (for /serve's ready line)."""
        with self.lock:
            self.line_hooks[job_id] = hook

    def stop(self, cancel_running: bool = False) -> None:
        self.stopping.set()
        self.thread.join(timeout=5)
        with self.lock:
            if cancel_running:
                for job in self.jobs.values():
                    if job["state"] == "running" and job.get("pid"):
                        _terminate_tree(job["pid"])
            self._save(force=True)

    # ------------------------------------------------------------------ running

    def _running(self) -> int:
        return sum(1 for j in self.jobs.values() if j["state"] == "running" and "serve" not in j)

    def _start_queued(self) -> None:
        for job in sorted(self.jobs.values(), key=lambda j: int(j["id"])):
            if job["state"] != "queued":
                continue
            if "serve" not in job and self._running() >= self.max_running:
                continue
            self._launch(job)

    def _launch(self, job: dict[str, Any]) -> None:
        folder = self.jobs_dir / job["id"]
        log_path = folder / "log.txt"
        result = folder / "result.json"
        if result.exists():
            result.unlink()
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join([str(self.package_path), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])])
        env["PYTHONUNBUFFERED"] = "1"
        command = [self.python, "-m", "ngplatform_runner.child", str(result), job["module"], *job["argv"]]
        try:
            with open(log_path, "ab") as log:
                options: dict[str, Any] = {}
                if os.name == "nt":  # pragma: no cover - Windows
                    options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
                else:
                    options["start_new_session"] = True
                proc = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, cwd=str(folder), env=env, **options)
        except OSError as e:
            job["state"] = "failed"
            job["finished"] = time.time()
            job["message"] = f"Could not start: {e}"
            return
        self.procs[job["id"]] = proc
        self.offsets[job["id"]] = 0
        job["pid"] = proc.pid
        job["pid_start"] = _process_start(proc.pid)
        job["state"] = "running"
        job["started"] = time.time()
        job["message"] = "Started"

    def _result(self, job: dict[str, Any]) -> int | None:
        try:
            return int(json.loads((self.jobs_dir / job["id"] / "result.json").read_text())["returncode"])
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _finish(self, job: dict[str, Any], returncode: int | None) -> None:
        job["returncode"] = returncode
        job["finished"] = time.time()
        if job.get("cancel_requested"):
            job["state"] = "cancelled"
            job["message"] = "Cancelled"
        elif returncode == 0:
            job["state"] = "done"
            job["progress"] = 1.0
            job["message"] = "Done" if "serve" not in job else "Stopped"
        else:
            job["state"] = "failed"
            job["message"] = self._last_error(job) or f"Ended with exit code {returncode}"

    def _last_error(self, job: dict[str, Any]) -> str | None:
        log = self.log(job["id"], tail=8192)
        if log is None:
            return None
        lines = [l.strip() for l in log["text"].splitlines() if l.strip() and not l.startswith("[progress]")]
        for line in reversed(lines):
            if line.lower().startswith("error") or "Error" in line:
                return line[:500]
        return lines[-1][:500] if lines else None

    def _read_log(self, job: dict[str, Any]) -> None:
        job_id = job["id"]
        path = self.jobs_dir / job_id / "log.txt"
        offset = self.offsets.get(job_id, 0)
        try:
            with open(path, "rb") as f:
                f.seek(offset)
                data = f.read(1 << 20)
        except OSError:
            return
        if not data:
            return
        self.offsets[job_id] = offset + len(data)
        text = self.partial.pop(job_id, "") + data.decode("utf-8", "replace")
        lines = text.split("\n")
        if not text.endswith("\n"):
            self.partial[job_id] = lines.pop()
        kind = self.kinds.get(job["kind"])
        parse = kind.progress if kind is not None else progress_line
        hook = self.line_hooks.get(job_id)
        for line in lines:
            line = line.rstrip("\r")
            if not line:
                continue
            found = parse(line)
            if found is not None:
                job["progress"], message = found
                if message:
                    job["message"] = message
            if hook is not None:
                try:
                    hook(line)
                except Exception:  # noqa: BLE001 - a hook's failure is not the job's
                    pass
        self._changed()

    def _watch(self) -> None:
        while not self.stopping.wait(self.poll):
            with self.lock:
                changed = False
                for job in list(self.jobs.values()):
                    if job["state"] != "running":
                        continue
                    self._read_log(job)
                    proc = self.procs.get(job["id"])
                    ended = False
                    code: int | None = None
                    if proc is not None:
                        code = proc.poll()
                        ended = code is not None
                    elif not _alive(job["pid"], job.get("pid_start")):
                        ended = True
                        code = self._result(job)
                    if job.get("cancel_requested") and not ended and time.time() - job["cancel_requested"] > 5:
                        _terminate_tree(job["pid"], hard=True)
                    if ended:
                        self._read_log(job)
                        result = self._result(job)
                        self._finish(job, result if result is not None else code)
                        self.procs.pop(job["id"], None)
                        self.line_hooks.pop(job["id"], None)
                        changed = True
                before = sum(1 for j in self.jobs.values() if j["state"] == "queued")
                self._start_queued()
                if changed or before != sum(1 for j in self.jobs.values() if j["state"] == "queued"):
                    self._changed(force=True)
                elif self.dirty:
                    self._save()


def serve_plan(path: Path, port: int) -> Plan:
    return plan_serve(path, port)
