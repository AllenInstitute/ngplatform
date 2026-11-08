"""``python -m ngplatform_runner tunnel``: the ssh commands it builds, and the whole thing with a fake ssh.

There is no ssh login in the test environment: fake_ssh.py stands in for
ssh, with "the other computer" being this one (its -L is forwarder.py, a
TCP forwarder, as ``ssh -L`` would be).
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.parse
from pathlib import Path

from helpers import RUNNER, alive

from ngplatform_runner import tunnel
from ngplatform_runner.services import free_port

HERE = Path(__file__).resolve().parent


class CommandsTest(unittest.TestCase):
    def test_forward(self):
        self.assertEqual(
            tunnel.forward_command("me@ws", local_port=7000, remote_port=8765),
            ["ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-L", "7000:127.0.0.1:8765", "me@ws"],
        )
        command = tunnel.forward_command("node12", local_port=7001, remote_port=9000, jump="me@login.cluster", ssh="/usr/bin/ssh", options=["-o", "User=x"])
        self.assertEqual(command[0], "/usr/bin/ssh")
        self.assertEqual(command[-5:], ["-J", "me@login.cluster", "-o", "User=x", "node12"])
        self.assertIn("7001:127.0.0.1:9000", command)

    def test_remote(self):
        self.assertEqual(tunnel.remote_command("ws", "cat x", jump="login"), ["ssh", "-J", "login", "ws", "cat x"])
        self.assertEqual(tunnel.token_command(), "cat ~/.ngplatform-runner/token")
        self.assertEqual(tunnel.token_command("/scratch/my runner/"), "cat '/scratch/my runner/token'")
        self.assertEqual(tunnel.remote_path("~/a b"), "~/'a b'")

    def test_start(self):
        line = tunnel.start_command("/env/bin/python -m ngplatform_runner --root /data", local_port=7000, remote_port=8765)
        self.assertTrue(line.startswith("mkdir -p ~/.ngplatform-runner && nohup sh -c "), line)
        self.assertTrue(line.endswith(" > ~/.ngplatform-runner/remote.log 2>&1 < /dev/null &"), line)
        inner = shlex.split(line.split("nohup sh -c ", 1)[1].split(" > ", 1)[0])[0]
        self.assertEqual(inner, "/env/bin/python -m ngplatform_runner --root /data --public-url http://localhost:7000 --port 8765 --state-dir ~/.ngplatform-runner")
        # What the command gives already is not given twice.
        line = tunnel.start_command("python -m ngplatform_runner --root /d --port=9000 --public-url http://localhost:7100 --state-dir /s", state_dir="/s")
        inner = shlex.split(line.split("nohup sh -c ", 1)[1].split(" > ", 1)[0])[0]
        self.assertEqual(inner, "python -m ngplatform_runner --root /d --port=9000 --public-url http://localhost:7100 --state-dir /s")

    def test_link_and_help(self):
        link = tunnel.pairing_link("https://app.example/", 7000, "tok_en-1", "workstation")
        self.assertEqual(link, "https://app.example/#runner=http%3A%2F%2Flocalhost%3A7000&token=tok_en-1&name=workstation")
        lines = "\n".join(tunnel.manual_commands("me@node1", local_port=7000, remote_port=8765, jump="login"))
        self.assertIn("ssh -N -J login -L 7000:127.0.0.1:8765 NODE", lines)
        self.assertIn("--public-url http://localhost:7000", lines)
        described = "\n".join(tunnel.describe({"hostname": "czi001", "platform": "Linux", "version": "0.1.0", "pid": 1, "roots": ["/d"], "gpus": [
            {"index": 0, "name": "NVIDIA RTX A6000", "memoryTotal": 49140, "memoryFree": 48000, "ok": True},
            {"index": 1, "name": "GPU", "ok": False, "problem": "GPU requires reset"},
        ], "services": {"render": {"ready": True, "error": None, "pid": 5}}}))
        self.assertIn("GPU 0: NVIDIA RTX A6000, 48 GB, 47 GB free", described)
        self.assertIn("GPU 1: GPU -- GPU requires reset", described)
        self.assertIn("service render: ready", described)

    def test_the_cli_dispatches(self):
        out = subprocess.run([sys.executable, "-m", "ngplatform_runner", "tunnel", "--help"], cwd=RUNNER, capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("--start-remote", out.stdout)
        out = subprocess.run([sys.executable, "-m", "ngplatform_runner", "--help"], cwd=RUNNER, capture_output=True, text=True, timeout=60)
        self.assertIn("--public-url", out.stdout)
        self.assertIn("--service", out.stdout)


class Recorder(tunnel.Ssh):
    """The real Ssh's behaviour on the fake ssh, recording what was asked."""

    def __init__(self):
        self.spawned: list[list[str]] = []
        self.ran: list[list[str]] = []
        self.processes: list[subprocess.Popen] = []

    def spawn(self, argv):
        self.spawned.append(argv)
        process = subprocess.Popen(argv, stdout=subprocess.DEVNULL)
        self.processes.append(process)
        return process

    def run(self, argv, timeout=120.0):
        self.ran.append(argv)
        return subprocess.run(argv, stdout=subprocess.PIPE, text=True, timeout=timeout)


class EndToEndTest(unittest.TestCase):
    """The tunnel to a runner it starts itself, through the fake ssh."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ngp-tunnel-")
        base = Path(self.tmp.name)
        self.state = base / "remote state"
        self.root = base / "data"
        self.root.mkdir()
        self.fake = base / "ssh"
        self.fake.write_text(f"#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(HERE / 'fake_ssh.py'))} \"$@\"\n")
        self.fake.chmod(0o755)
        self.local = free_port()
        self.remote = free_port()
        self.runner_pid = None
        self.tunnel = None

    def tearDown(self):
        if self.tunnel is not None:
            self.tunnel.stop()
        if self.runner_pid and alive(self.runner_pid):
            os.kill(self.runner_pid, signal.SIGTERM)
            deadline = time.time() + 10
            while time.time() < deadline and alive(self.runner_pid):
                time.sleep(0.05)
        self.tmp.cleanup()

    def args(self, **extra):
        start = f"cd {shlex.quote(str(RUNNER))} && {shlex.quote(sys.executable)} -m ngplatform_runner --root {shlex.quote(str(self.root))} --service echo={shlex.quote(sys.executable + ' -m ngplatform_runner.echo_service')}"
        values = dict(host="me@workstation", jump=None, remote_port=self.remote, local_port=self.local, app="https://app.example/", state_dir=str(self.state), start_remote=start, name=None, ssh=str(self.fake), ssh_option=None, connect_timeout=20, start_timeout=60)
        values.update(extra)
        return argparse.Namespace(**values)

    def test_start_check_pair_and_reconnect(self):
        ssh = Recorder()
        said: list[str] = []
        self.tunnel, token, info, link = tunnel.connect(self.args(), ssh, say=said.append)
        self.runner_pid = info["pid"]
        self.assertEqual(info["name"], "ngplatform-runner")
        self.assertEqual(info["publicUrl"], f"http://localhost:{self.local}")
        self.assertEqual(token, (self.state / "token").read_text().strip())
        self.assertIn("echo", info["services"])
        self.assertTrue((self.state / "remote.log").is_file())
        fragment = urllib.parse.parse_qs(link.split("#", 1)[1])
        self.assertEqual(fragment, {"runner": [f"http://localhost:{self.local}"], "token": [token], "name": ["workstation"]})
        # The forward is ssh -N -L, and the runner was started with what the tunnel needs.
        self.assertIn(f"{self.local}:127.0.0.1:{self.remote}", ssh.spawned[0])
        started = ssh.ran[0][-1]
        self.assertIn(f"--public-url http://localhost:{self.local}", started)
        self.assertIn(f"--port {self.remote}", started)
        self.assertTrue(ssh.ran[1][-1].startswith("cat "))
        # The app's requests through the tunnel: the service, as the browser would address it.
        deadline = time.time() + 20
        while time.time() < deadline:
            status, value = self._get("/info", token)
            if value["services"]["echo"]["ready"]:
                break
            time.sleep(0.1)
        status, env = self._get("/svc/echo/env", token)
        self.assertEqual(status, 200)
        self.assertEqual(env["roots"], [str(self.root.resolve())])
        # The tunnel drops (ssh ended): it is opened again.
        ssh.processes[0].kill()
        deadline = time.time() + 20
        while time.time() < deadline and self.tunnel.connections < 2:
            time.sleep(0.05)
        self.assertEqual(self.tunnel.connections, 2)
        self.assertTrue(self.tunnel.wait_listening(10))
        self.assertEqual(self._get("/info", token)[0], 200)
        self.assertTrue(any("opening it again" in s for s in said))
        # A second connect finds the runner running: it is not started again.
        self.tunnel.stop()
        self.tunnel = None
        again = Recorder()
        self.tunnel, token2, info2, _ = tunnel.connect(self.args(name="ws"), again, say=lambda _: None)
        self.assertEqual(info2["pid"], self.runner_pid)
        self.assertEqual(token2, token)
        self.assertEqual(len(again.ran), 1)  # only the token

    def test_a_port_in_use_and_a_runner_without_public_url(self):
        import socket

        busy = socket.socket()
        busy.bind(("127.0.0.1", self.local))
        busy.listen(1)
        try:
            with self.assertRaisesRegex(tunnel.TunnelError, "in use"):
                tunnel.connect(self.args(), Recorder(), say=lambda _: None)
        finally:
            busy.close()
        # A runner started by hand without --public-url refuses the tunnel; the error says what to add.
        start = f"cd {shlex.quote(str(RUNNER))} && {shlex.quote(sys.executable)} -m ngplatform_runner --root {shlex.quote(str(self.root))} --port {self.remote} --state-dir {shlex.quote(str(self.state))} --public-url http://localhost:1"
        with self.assertRaisesRegex(tunnel.TunnelError, f"--public-url http://localhost:{self.local}"):
            tunnel.connect(self.args(start_remote=start), Recorder(), say=lambda _: None)
        self.runner_pid = self._runner_pid_from_log()

    def test_main_prints_the_link(self):
        ssh = Recorder()
        out = io.StringIO()
        argv = ["me@ws", "--remote-port", str(self.remote), "--local-port", str(self.local), "--state-dir", str(self.state), "--ssh", str(self.fake), "--app", "https://app.example/", "--name", "workstation", "--start-remote", self.args().start_remote]
        original = tunnel.Tunnel.alive
        tunnel.Tunnel.alive = lambda self: False  # print, then close at once
        try:
            with contextlib.redirect_stdout(out):
                code = tunnel.main(argv, ssh)
        finally:
            tunnel.Tunnel.alive = original
        text = out.getvalue()
        self.runner_pid = self._runner_pid_from_log()
        self.assertEqual(code, 0, text)
        self.assertIn("&name=workstation", text)
        self.assertIn("https://app.example/#runner=http%3A%2F%2Flocalhost%3A", text)
        self.assertIn("GPU", text)
        self.assertIn("ssh -N -J LOGIN -L", text)

    def _runner_pid_from_log(self):
        log = self.state / "remote.log"
        deadline = time.time() + 5
        while time.time() < deadline:
            if log.is_file():
                for line in log.read_text().splitlines():
                    if "(PID " in line and "listening" in line:
                        return int(line.rsplit("(PID ", 1)[1].rstrip(")"))
            time.sleep(0.1)
        return None

    def _get(self, path, token):
        import http.client

        connection = http.client.HTTPConnection("127.0.0.1", self.local, timeout=20)
        connection.request("GET", path, headers={"Host": f"localhost:{self.local}", "Authorization": f"Bearer {token}", "Origin": "https://alleninstitute.github.io"})
        response = connection.getresponse()
        value = json.loads(response.read() or b"null")
        connection.close()
        return response.status, value


if __name__ == "__main__":
    unittest.main()
