"""``ngplatform``: the app on this computer, as one command.

    ngplatform [FILE ...]          the app in a window of its own, the files opened as layers
    ngplatform update              bring the app level with the deployed site now
    ngplatform --no-window         serve it only (print the address), e.g. for an SSH tunnel

It starts the runner (ngplatform_runner) on 127.0.0.1, serving the app's files at /app/ beside its API, with
the CUDA render service when the render dependencies are installed; opens the app (window.py), which pairs
with the runner that served it without asking; and stops everything when the window closes (or on Ctrl-C).

The app served is the newest build here (app_source.py: the one in this package, or one downloaded from the
deployed site). At each start, unless --offline, the deployed site's build is checked in the background and
downloaded when newer, for the next start.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import signal
import socket
import sys
import threading
import time
import urllib.parse
from pathlib import Path

from ngplatform_runner import RUNNER_API, __version__
from ngplatform_runner.__main__ import _token, _tools_version
from ngplatform_runner.jobs import JobManager
from ngplatform_runner.kinds import kinds_for
from ngplatform_runner.paths import Roots
from ngplatform_runner.server import RunnerServer
from ngplatform_runner.services import Services, parse_spec

from . import app_source, window

#: The port the app is served at: always the same, as the browser keeps the app's settings and pairing per
#: address (a new port would start afresh). Another port only when this one is taken.
PORT = 8766
#: A window whose browser exits this soon handed the page to a browser already open with the profile.
HANDOFF_SECONDS = 5.0


def _home() -> Path:
    return Path(os.environ.get("NGPLATFORM_HOME") or os.path.expanduser("~/.ngplatform")).resolve()


def _site(args: argparse.Namespace) -> str:
    site = args.site or app_source.CHANNELS[args.channel]
    return site if site.endswith("/") else site + "/"


def _free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _render_available() -> bool:
    """The CUDA render service can run here: its package and CuPy are importable."""
    return importlib.util.find_spec("ngplatform_render") is not None and importlib.util.find_spec("cupy") is not None


def _update(home: Path, site: str, quiet: bool) -> int:
    def progress(done: int, total: int) -> None:
        if not quiet and total:
            print(f"\r  downloading the app: {done * 100 // total}%", end="", flush=True)

    try:
        result = app_source.update(home, site, progress=progress)
    except Exception as e:  # noqa: BLE001 - said, not a crash
        print(f"{'' if quiet else chr(10)}Could not check the deployed app at {site}: {e}", file=sys.stderr)
        return 1
    if not quiet and result.state == "downloaded":
        print()
    print(result.message())
    return 0


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ngplatform", description="ngplatform on this computer: the app in a window of its own, its runner and its renderer here.")
    p.add_argument("files", nargs="*", metavar="FILE", help="files or folders to open as layers (NIfTI, OME-Zarr, Zarr Vectors, .trk, …); `update` checks the deployed app now")
    p.add_argument("--root", action="append", default=[], metavar="FOLDER", help="a folder the app may open files under (repeat for more); the files' folders are added, or else the current folder")
    p.add_argument("--port", type=int, default=PORT, help=f"port on 127.0.0.1 (default {PORT}; keep it the same so the app's settings stay)")
    p.add_argument("--no-window", action="store_true", help="serve the app only and print its address")
    p.add_argument("--browser", metavar="PATH", help="the Chrome, Chromium or Edge to open the window with (default: the first found)")
    p.add_argument("--offline", action="store_true", help="do not check the deployed site for a newer app")
    p.add_argument("--channel", choices=sorted(app_source.CHANNELS), default="stable", help="which deployed app to keep level with: stable (the site's root) or dev (/dev/)")
    p.add_argument("--site", metavar="URL", help=argparse.SUPPRESS)
    p.add_argument("--no-gpu", action="store_true", help="do not start the CUDA render service")
    p.add_argument("--version", action="store_true", help="print the versions and exit")
    return p


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else list(argv)
    args = _parser().parse_args(argv)
    home = _home()
    site = _site(args)
    if args.files[:1] == ["update"] and len(args.files) == 1:
        return _update(home, site, quiet=False)
    build = app_source.choose(home)
    if args.version:
        print(f"ngplatform {__version__} (runner API {RUNNER_API})")
        print(f"  app: {build.describe() if build else 'none'}")
        return 0
    if build is None:
        print("There is no build of the app here: run `ngplatform update` (it downloads the deployed app), or install a wheel made with it.", file=sys.stderr)
        return 1

    files = [Path(f).expanduser().resolve() for f in args.files]
    missing = [str(f) for f in files if not f.exists()]
    if missing:
        print(f"error: no such file: {', '.join(missing)}", file=sys.stderr)
        return 2
    roots_given = [*args.root, *sorted({str(f.parent) for f in files})] or [os.getcwd()]
    try:
        roots = Roots(roots_given)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    port = args.port
    if port and not _free(port):
        print(f"note: port {port} is taken (another ngplatform?); using another, so this window starts with the app's default settings")
        port = 0
    state_dir = home / "runner"
    state_dir.mkdir(parents=True, exist_ok=True)
    token = _token(state_dir, False)
    manager = JobManager(state_dir, kinds_for(False), python=sys.executable)
    specs = [] if args.no_gpu or not _render_available() else [parse_spec(f"render={sys.executable} -m ngplatform_render.server")]
    services = Services(specs, roots=[str(r) for r in roots], state_dir=state_dir)
    try:
        server = RunnerServer(port, token, roots, manager, python=sys.executable, tools=_tools_version(sys.executable), services=services, app_dir=build.dir)
    except OSError as e:
        manager.stop()
        print(f"error: cannot listen on 127.0.0.1:{port}: {e}", file=sys.stderr)
        return 1
    services.start()
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.25}, daemon=True).start()

    base = server.local_base
    fragment = urllib.parse.urlencode([("runner", base), ("token", token), *(("open", str(f)) for f in files)], quote_via=urllib.parse.quote)
    url = f"{base}/app/#{fragment}"
    print(f"ngplatform {__version__}: the app {build.describe()}")
    print(f"  at:     {base}/app/")
    print(f"  roots:  {', '.join(str(r) for r in roots)}")
    print(f"  render: {'the CUDA render service' if specs else 'in the window only (no CUDA render service' + (': --no-gpu)' if args.no_gpu else ': pip install ngplatform[gpu])')}")
    if not args.offline:
        threading.Thread(target=_update, args=(home, site, True), daemon=True).start()

    def stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, stop)
    try:
        if args.no_window:
            print(f"Open {url}")
            print("Ctrl-C stops it.", flush=True)
            while True:
                time.sleep(3600)
        browser = window.find_browser(args.browser)
        proc = window.open_window(url, home / "browser", browser)
        if proc is None:
            print("No Chrome, Chromium or Edge found: opened in the default browser. Ctrl-C here stops the app.", flush=True)
            while True:
                time.sleep(3600)
        print("Close the window (or Ctrl-C here) to stop.", flush=True)
        started = time.monotonic()
        proc.wait()
        if time.monotonic() - started < HANDOFF_SECONDS and proc.returncode == 0:
            # The page went to a browser already open with this profile (another ngplatform's window).
            print("The app opened in a window that was already open. Ctrl-C here stops this one.", flush=True)
            while True:
                time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        for serve in list(server.serves.values()):
            if serve.get("job"):
                manager.cancel(serve["job"])
        services.stop()
        server.shutdown()
        server.server_close()
        manager.stop()
        print("ngplatform stopped", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
