"""The local app (ngplatform_local): the runner serving the app's files, keeping the app level with the
deployed site (a site served here from a folder), and the `ngplatform` command started without a window."""

from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from helpers import RUNNER, TOKEN, Runner

from ngplatform_local import app_source  # noqa: E402
from ngplatform_runner import RUNNER_API  # noqa: E402


def make_build(folder: Path, commit: str, date: str, runner_api: int = RUNNER_API, extra: dict[str, bytes] | None = None) -> dict:
    """A build of the app in `folder`: index.html, an asset, build.json and files.json (as vite.config.ts writes them)."""
    files = {"index.html": f"<!doctype html><title>ngplatform {commit}</title>".encode(), "assets/main-abc.js": f"console.log('{commit}')".encode(), **(extra or {})}
    info = {"version": "0.1.0", "commit": commit, "date": date, "runnerApi": runner_api}
    files["build.json"] = json.dumps(info).encode()
    for rel, data in files.items():
        (folder / rel).parent.mkdir(parents=True, exist_ok=True)
        (folder / rel).write_bytes(data)
    manifest = {"commit": commit, "files": [{"path": rel, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()} for rel, data in sorted(files.items())]}
    (folder / "files.json").write_text(json.dumps(manifest))
    return info


class Site:
    """A deployed site: a folder served over HTTP."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ngp-site-")
        self.dir = Path(self.tmp.name)
        handler = partial(SimpleHTTPRequestHandler, directory=str(self.dir))
        handler.log_message = lambda *a, **k: None
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()


class ServingTest(unittest.TestCase):
    """The runner serves the app's files at /app/, without the token, and nothing beside them."""

    @classmethod
    def setUpClass(cls):
        cls.app = tempfile.TemporaryDirectory(prefix="ngp-app-")
        make_build(Path(cls.app.name), "c1", "2026-11-18T00:00:00Z", extra={"theme.js": b"// theme", ".secret": b"no"})
        (Path(cls.app.name).parent / "outside.txt").write_text("no")
        cls.runner = Runner(app_dir=Path(cls.app.name))

    @classmethod
    def tearDownClass(cls):
        cls.runner.close()
        cls.app.cleanup()

    def test_page_and_assets(self):
        status, headers, _ = self.runner.request("GET", "/", token=None)
        self.assertEqual((status, headers.get("Location")), (302, "/app/"))
        status, headers, body = self.runner.request("GET", "/app/", token=None)
        self.assertEqual(status, 200)
        self.assertIn("ngplatform c1", body)
        self.assertTrue(headers["Content-Type"].startswith("text/html"))
        self.assertEqual(headers["Cache-Control"], "no-cache")
        status, headers, _ = self.runner.request("GET", "/app/assets/main-abc.js", token=None)
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("text/javascript"))
        self.assertIn("immutable", headers["Cache-Control"])
        status, headers, _ = self.runner.request("HEAD", "/app/theme.js", token=None)
        self.assertEqual(status, 200)

    def test_nothing_else(self):
        for path in ["/app/../outside.txt", "/app/%2e%2e/outside.txt", "/app/.secret", "/app/nope.js"]:
            self.assertEqual(self.runner.request("GET", path, token=None)[0], 404, path)

    def test_api_still_needs_the_token(self):
        self.assertEqual(self.runner.request("GET", "/status", token=None)[0], 401)
        status, _, body = self.runner.request("GET", "/status")
        self.assertEqual(status, 200)
        self.assertEqual(body["runnerApi"], RUNNER_API)

    def test_a_runner_without_an_app_serves_none(self):
        plain = Runner()
        try:
            self.assertEqual(plain.request("GET", "/app/", token=None)[0], 401)
        finally:
            plain.close()


class UpdateTest(unittest.TestCase):
    """Builds here kept level with the deployed site."""

    def setUp(self):
        self.site = Site()
        self.home = tempfile.TemporaryDirectory(prefix="ngp-home-")
        self.bundled = tempfile.TemporaryDirectory(prefix="ngp-bundled-")
        info = make_build(Path(self.bundled.name), "old", "2026-11-01T00:00:00Z")
        patcher = mock.patch.object(app_source, "bundled", lambda: app_source.Build(Path(self.bundled.name), info, "bundled"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.site.close()
        self.home.cleanup()
        self.bundled.cleanup()

    def test_downloads_a_newer_deployed_build_and_serves_it(self):
        home = Path(self.home.name)
        self.assertEqual(app_source.choose(home).commit, "old")
        make_build(self.site.dir, "new", "2026-11-18T00:00:00Z")
        result = app_source.update(home, self.site.url)
        self.assertEqual(result.state, "downloaded")
        chosen = app_source.choose(home)
        self.assertEqual((chosen.commit, chosen.where), ("new", "downloaded"))
        self.assertEqual((chosen.dir / "assets" / "main-abc.js").read_text(), "console.log('new')")
        # Level now: nothing more to fetch.
        self.assertEqual(app_source.update(home, self.site.url).state, "current")

    def test_keeps_the_newest_builds(self):
        home = Path(self.home.name)
        for i in range(4):
            make_build(self.site.dir, f"b{i}", f"2026-11-1{i + 2}T00:00:00Z")
            app_source.update(home, self.site.url)
        self.assertEqual([b.commit for b in app_source.downloaded(home)], ["b3", "b2"])

    def test_a_file_not_as_described_is_refused(self):
        home = Path(self.home.name)
        make_build(self.site.dir, "new", "2026-11-18T00:00:00Z")
        (self.site.dir / "assets" / "main-abc.js").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "not the file files.json describes"):
            app_source.update(home, self.site.url)
        self.assertEqual(app_source.choose(home).commit, "old")
        self.assertEqual(list((home / "app").iterdir()), [])

    def test_paths_outside_the_app_are_refused(self):
        home = Path(self.home.name)
        make_build(self.site.dir, "new", "2026-11-18T00:00:00Z")
        manifest = json.loads((self.site.dir / "files.json").read_text())
        manifest["files"].append({"path": "../escape.txt", "size": 1, "sha256": "0" * 64})
        (self.site.dir / "files.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "outside the app"):
            app_source.update(home, self.site.url)
        self.assertFalse((home / "escape.txt").exists())

    def test_a_build_needing_a_newer_runner_is_not_taken(self):
        home = Path(self.home.name)
        make_build(self.site.dir, "future", "2026-11-18T00:00:00Z", runner_api=RUNNER_API + 1)
        result = app_source.update(home, self.site.url)
        self.assertEqual(result.state, "needs-runner")
        self.assertIn("pip install -U ngplatform", result.message())
        self.assertEqual(app_source.choose(home).commit, "old")

    def test_a_manifest_of_another_build_is_refused(self):
        home = Path(self.home.name)
        make_build(self.site.dir, "new", "2026-11-18T00:00:00Z")
        manifest = json.loads((self.site.dir / "files.json").read_text())
        manifest["commit"] = "other"
        (self.site.dir / "files.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "another build"):
            app_source.update(home, self.site.url)


class CommandTest(unittest.TestCase):
    """`ngplatform --no-window`: the runner up with the app, the files' folders its roots; stopped by SIGTERM."""

    def test_serves_the_app_and_stops(self):
        with tempfile.TemporaryDirectory(prefix="ngp-cmd-") as tmp:
            home = Path(tmp) / "home"
            build = home / "app" / "c9"
            build.mkdir(parents=True)
            make_build(build, "c9", "2999-01-01T00:00:00Z")
            (build / app_source.COMPLETE).write_text("{}")
            data = Path(tmp) / "data"
            data.mkdir()
            image = data / "t1.nii.gz"
            image.write_bytes(b"\x1f\x8b")
            env = {**os.environ, "NGPLATFORM_HOME": str(home), "PYTHONPATH": str(RUNNER)}
            proc = subprocess.Popen([sys.executable, "-m", "ngplatform_local", "--no-window", "--offline", "--no-gpu", "--port", "0", str(image)],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env, cwd=tmp)
            try:
                lines = []
                url = None
                deadline = time.time() + 60
                while url is None and time.time() < deadline:
                    line = proc.stdout.readline()
                    if not line:
                        break
                    lines.append(line)
                    m = re.match(r"Open (http://127\.0\.0\.1:(\d+)/app/#(.*))", line.strip())
                    if m:
                        url = m
                self.assertIsNotNone(url, "".join(lines))
                self.assertIn("c9", "".join(lines))
                port = int(url.group(2))
                fragment = url.group(3)
                params = urllib.parse.parse_qs(fragment)
                self.assertEqual(params["open"], [str(image)])
                self.assertEqual(params["runner"], [f"http://127.0.0.1:{port}"])
                token = params["token"][0]
                client = Runner.__new__(Runner)
                client.port = port
                status, _, page = client.request("GET", "/app/", token=None)
                self.assertEqual(status, 200)
                self.assertIn("ngplatform c9", page)
                status, _, info = client.request("GET", "/status", token=token)
                self.assertEqual(status, 200)
                self.assertEqual(info["roots"], [str(data.resolve())])
            finally:
                proc.send_signal(signal.SIGTERM)
                out, _ = proc.communicate(timeout=30)
            self.assertIn("ngplatform stopped", out)
            self.assertNotEqual(TOKEN, token)


if __name__ == "__main__":
    unittest.main()
