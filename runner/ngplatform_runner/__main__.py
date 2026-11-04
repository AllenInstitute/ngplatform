"""``python -m ngplatform_runner --root ~/data``: start the runner and print how to pair the app with it."""

from __future__ import annotations

import argparse
import os
import secrets
import signal
import subprocess
import sys
import urllib.parse
from pathlib import Path

from . import __version__
from .jobs import JobManager
from .kinds import kinds_for
from .paths import Roots
from .server import RunnerServer

DEFAULT_APP = "https://alleninstitute.github.io/ngplatform/"


def _token(state_dir: Path, new: bool) -> str:
    path = state_dir / "token"
    if not new and path.is_file():
        token = path.read_text().strip()
        if len(token) >= 32:
            return token
    token = secrets.token_urlsafe(32)
    # Made readable by its owner alone from the start (not written, then narrowed).
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token + "\n")
    return token


def _tools_version(python: str) -> str | None:
    """zarr-vectors-tools' version in the Python jobs run with, or None when it is missing."""
    code = "import importlib.metadata as m, zarr_vectors_tools; print(m.version('zarr-vectors-tools'))"
    try:
        out = subprocess.run([python, "-c", code], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m ngplatform_runner",
        description="Runs zarr-vectors-tools jobs on this computer for ngplatform, and serves files under the roots to its viewer.",
    )
    p.add_argument("--root", action="append", default=[], metavar="FOLDER", help="a folder jobs may read and write, and the app may list (repeat for more); required")
    p.add_argument("--port", type=int, default=8765, help="port on 127.0.0.1 (default 8765; 0 picks a free one)")
    p.add_argument("--state-dir", default=os.path.join("~", ".ngplatform-runner"), help="where the job list, logs and token are kept (default ~/.ngplatform-runner)")
    p.add_argument("--python", default=sys.executable, help="the Python jobs run with; it needs zarr-vectors-tools (default: this one)")
    p.add_argument("--max-jobs", type=int, default=2, help="jobs run at once; more wait in a queue (default 2)")
    p.add_argument("--allow-origin", action="append", default=[], metavar="ORIGIN", help="another site the app is served from (https://alleninstitute.github.io and localhost are allowed)")
    p.add_argument("--app", default=DEFAULT_APP, help=f"the app's address, for the pairing link (default {DEFAULT_APP})")
    p.add_argument("--new-token", action="store_true", help="make a new pairing token (apps paired before must pair again)")
    p.add_argument("--test-kinds", action="store_true", help="also offer the 'sleep' job kind, for tests")
    p.add_argument("--version", action="version", version=f"ngplatform-runner {__version__}")
    args = p.parse_args(argv)
    if not args.root:
        p.error("give at least one --root FOLDER: jobs read and write only under the roots")
    try:
        roots = Roots(args.root)
    except ValueError as e:
        p.error(str(e))
    state_dir = Path(os.path.expanduser(args.state_dir)).resolve()
    state_dir.mkdir(parents=True, exist_ok=True)
    token = _token(state_dir, args.new_token)
    tools = _tools_version(args.python)
    manager = JobManager(state_dir, kinds_for(args.test_kinds), python=args.python, max_running=max(1, args.max_jobs))
    try:
        server = RunnerServer(args.port, token, roots, manager, origins=args.allow_origin, python=args.python, tools=tools)
    except OSError as e:
        manager.stop()
        print(f"error: cannot listen on 127.0.0.1:{args.port}: {e}", file=sys.stderr)
        return 1
    address = server.base
    link = f"{args.app}#runner={urllib.parse.quote(address, safe='')}&token={token}"
    print(f"ngplatform runner {__version__} listening on {address} (PID {os.getpid()})")
    print(f"  roots:  {', '.join(str(r) for r in roots)}")
    print(f"  jobs:   {args.python}" + (f" (zarr-vectors-tools {tools})" if tools else "  -- zarr-vectors-tools is NOT importable there; jobs will fail"))
    print(f"  state:  {state_dir}")
    print()
    print("Pair the app with it: open this link (it pairs this browser once)")
    print(f"  {link}")
    print("or in the app's Jobs tab, under 'This computer', enter")
    print(f"  address: {address}")
    print(f"  token:   {token}")
    print()
    print("Ctrl-C stops the runner; jobs still running carry on and show again when it starts.", flush=True)

    def stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        # Files served by a process stop with the runner; they start again with it.
        for serve in list(server.serves.values()):
            if serve.get("job"):
                manager.cancel(serve["job"])
        server.server_close()
        manager.stop()
        print("runner stopped", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
