"""``python -m ngplatform_runner tunnel [user@]HOST``: use a runner on another computer, over SSH.

Run on the computer the browser is on.  It opens ``ssh -N -L
7000:127.0.0.1:8765 HOST`` (opened again when it drops), so the browser
reaches the runner on HOST at ``http://localhost:7000``; reads the runner's
pairing token there (``ssh HOST cat ~/.ngplatform-runner/token``); with
``--start-remote 'COMMAND'`` starts the runner first if nothing answers;
checks the runner through the tunnel, prints HOST's GPUs and services, and
prints the link that pairs the app with it as a computer of its own name.

Nothing here needs more than the standard library and an ``ssh`` program.
Every ssh command goes through an ``Ssh`` object, which tests replace.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import shlex
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from typing import Any, Callable

from . import DEFAULT_APP

DEFAULT_STATE_DIR = "~/.ngplatform-runner"
QUICK_SECONDS = 10.0
GIVE_UP_AFTER = 5


# ---------------------------------------------------------------- commands


def _jump(jump: str | None) -> list[str]:
    return ["-J", jump] if jump else []


def forward_command(host: str, *, local_port: int = 7000, remote_port: int = 8765, jump: str | None = None, ssh: str = "ssh", options: list[str] | None = None) -> list[str]:
    """The ssh command that forwards ``127.0.0.1:local_port`` here to ``127.0.0.1:remote_port`` on HOST."""
    return [
        ssh,
        "-N",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-L", f"{local_port}:127.0.0.1:{remote_port}",
        *_jump(jump),
        *(options or []),
        host,
    ]  # fmt: skip


def remote_command(host: str, command: str, *, jump: str | None = None, ssh: str = "ssh", options: list[str] | None = None) -> list[str]:
    """The ssh command that runs ``command`` (a shell command line) on HOST."""
    return [ssh, *_jump(jump), *(options or []), host, command]


def remote_path(path: str) -> str:
    """A path for the remote shell: quoted, but a leading ``~/`` left for it to expand."""
    if path == "~":
        return "~"
    if path.startswith("~/"):
        return "~/" + shlex.quote(path[2:])
    return shlex.quote(path)


def _join(folder: str, name: str) -> str:
    return folder.rstrip("/") + "/" + name


def token_command(state_dir: str = DEFAULT_STATE_DIR) -> str:
    return f"cat {remote_path(_join(state_dir, 'token'))}"


def _has_option(words: list[str], option: str) -> bool:
    return any(w == option or w.startswith(option + "=") for w in words)


def start_command(start_remote: str, *, state_dir: str = DEFAULT_STATE_DIR, local_port: int = 7000, remote_port: int = 8765) -> str:
    """The remote shell command that starts the runner in the background, with what the tunnel needs added.

    ``--public-url http://localhost:LOCAL`` (so the runner takes requests
    through the tunnel), ``--port REMOTE`` and ``--state-dir`` are added
    when the command does not give them.  Its output goes to
    ``<state-dir>/remote.log``.
    """
    try:
        words = shlex.split(start_remote)
    except ValueError:
        words = start_remote.split()
    command = start_remote.strip()
    if not _has_option(words, "--public-url"):
        command += f" --public-url http://localhost:{local_port}"
    if not _has_option(words, "--port"):
        command += f" --port {remote_port}"
    if not _has_option(words, "--state-dir"):
        command += f" --state-dir {remote_path(state_dir)}"
    log = remote_path(_join(state_dir, "remote.log"))
    # sh -c: the command may be "cd somewhere && python -m ngplatform_runner ...".  Every stream is
    # redirected, so ssh returns at once instead of waiting for the runner to close them.
    return f"mkdir -p {remote_path(state_dir)} && nohup sh -c {shlex.quote(command)} > {log} 2>&1 < /dev/null &"


def pairing_link(app: str, local_port: int, token: str, name: str) -> str:
    address = f"http://localhost:{local_port}"
    return f"{app}#runner={urllib.parse.quote(address, safe='')}&token={urllib.parse.quote(token, safe='')}&name={urllib.parse.quote(name, safe='')}"


def host_name(host: str) -> str:
    """``user@host`` → ``host``."""
    return host.rsplit("@", 1)[-1]


def manual_commands(host: str, *, local_port: int, remote_port: int, jump: str | None) -> list[str]:
    forward = shlex.join(forward_command(host, local_port=local_port, remote_port=remote_port, jump=jump))
    login = jump or "LOGIN"
    return [
        "The same by hand:",
        f"  on {host_name(host)}:  python -m ngplatform_runner --root <folder> --public-url http://localhost:{local_port}",
        f"  here:  {forward}",
        "On a cluster, with the runner started inside an interactive job on node NODE:",
        f"  here:  ssh -N -J {login} -L {local_port}:127.0.0.1:{remote_port} NODE",
    ]


# ---------------------------------------------------------------- ssh


class Ssh:
    """Runs ssh commands; tests put a fake in its place."""

    def spawn(self, argv: list[str]) -> subprocess.Popen:
        """A long-lived command (the forward), with this terminal's streams (for a password or a second factor)."""
        return subprocess.Popen(argv)

    def run(self, argv: list[str], timeout: float = 120.0) -> subprocess.CompletedProcess:
        """A command whose output is wanted; its errors (and prompts) go to this terminal."""
        return subprocess.run(argv, stdout=subprocess.PIPE, text=True, timeout=timeout)


class Tunnel:
    """The forward, kept open: started again (after 1 s, 2 s, 4 s ... 30 s) when ssh ends."""

    def __init__(self, command: list[str], local_port: int, ssh: Ssh | None = None, say: Callable[[str], None] = print, backoff: float = 1.0):
        self.command = command
        self.local_port = local_port
        self.ssh = ssh or Ssh()
        self.say = say
        self.backoff = backoff
        self.stopping = threading.Event()
        self.lock = threading.Lock()
        self.process: subprocess.Popen | None = None
        self.connections = 0
        self.gave_up = False
        self.thread = threading.Thread(target=self._keep, name="tunnel", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def alive(self) -> bool:
        return self.thread.is_alive() and not self.gave_up

    def _keep(self) -> None:
        quick = 0
        while not self.stopping.is_set():
            started = time.monotonic()
            with self.lock:
                if self.stopping.is_set():
                    return
                try:
                    process = self.ssh.spawn(self.command)
                except OSError as e:
                    self.say(f"error: cannot run {self.command[0]}: {e}")
                    self.gave_up = True
                    return
                self.process = process
                self.connections += 1
            code = process.wait()
            if self.stopping.is_set():
                return
            quick = quick + 1 if time.monotonic() - started < QUICK_SECONDS else 0
            if quick >= GIVE_UP_AFTER:
                self.say(f"error: ssh ended (exit code {code}) {quick} times in a row soon after starting; giving up")
                self.gave_up = True
                return
            delay = min(30.0, self.backoff * 2 ** max(0, quick - 1))
            self.say(f"The tunnel closed (ssh exit code {code}); opening it again in {delay:g} s")
            if self.stopping.wait(delay):
                return

    def stop(self) -> None:
        with self.lock:
            self.stopping.set()
            process = self.process
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(5)
            except subprocess.TimeoutExpired:
                process.kill()
        if self.thread.is_alive():
            self.thread.join(5)

    def wait_listening(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not self.gave_up:
            if port_open(self.local_port):
                return True
            time.sleep(0.1)
        return False


def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


# ---------------------------------------------------------------- the runner through the tunnel


def request_info(local_port: int, token: str | None = None, timeout: float = 10.0) -> tuple[int, Any]:
    """``GET /info`` through the tunnel: the status and the JSON answer.  Raises OSError when nothing answers."""
    connection = http.client.HTTPConnection("127.0.0.1", local_port, timeout=timeout)
    headers = {"Host": f"localhost:{local_port}"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        connection.request("GET", "/info", headers=headers)
        response = connection.getresponse()
        raw = response.read()
    except http.client.HTTPException as e:
        # ssh accepts the connection and closes it when nothing listens on the other side.
        raise ConnectionError(str(e)) from e
    finally:
        connection.close()
    try:
        value = json.loads(raw) if raw else None
    except ValueError:
        value = raw.decode("utf-8", "replace")
    return response.status, value


def runner_answers(local_port: int) -> bool:
    try:
        request_info(local_port, timeout=5)
        return True
    except OSError:
        return False


def wait_for_runner(local_port: int, timeout: float | None, tunnel: Tunnel | None = None) -> bool:
    deadline = None if timeout is None else time.monotonic() + timeout
    while deadline is None or time.monotonic() < deadline:
        if tunnel is not None and tunnel.gave_up:
            return False
        if runner_answers(local_port):
            return True
        time.sleep(0.5)
    return False


def _gib(mib: int | None) -> str:
    return "?" if mib is None else f"{mib / 1024:.0f} GB"


def describe(info: dict[str, Any]) -> list[str]:
    """The host, its GPUs and services, in lines."""
    lines = [f"{info.get('hostname', '?')} ({info.get('platform', '?')}): runner {info.get('version', '?')}, PID {info.get('pid', '?')}, folders {', '.join(info.get('roots') or [])}"]
    gpus = info.get("gpus") or []
    if not gpus:
        lines.append("  no GPU (nvidia-smi is not there, or lists none)")
    for gpu in gpus:
        if gpu.get("ok"):
            lines.append(f"  GPU {gpu['index']}: {gpu['name']}, {_gib(gpu.get('memoryTotal'))}, {_gib(gpu.get('memoryFree'))} free")
        else:
            lines.append(f"  GPU {gpu['index']}: {gpu['name']} -- {gpu.get('problem') or 'does not answer'}")
    for name, state in (info.get("services") or {}).items():
        text = "ready" if state.get("ready") else "starting" if not state.get("error") else state["error"].splitlines()[0]
        lines.append(f"  service {name}: {text}")
    return lines


class TunnelError(Exception):
    pass


def connect(args: argparse.Namespace, ssh: Ssh | None = None, say: Callable[[str], None] = print) -> tuple[Tunnel, str, dict[str, Any], str]:
    """Opens the tunnel, starts the runner when asked, and checks it: the tunnel, token, /info and pairing link."""
    ssh = ssh or Ssh()
    options = [x for o in (args.ssh_option or []) for x in ("-o", o)]
    if port_open(args.local_port):
        raise TunnelError(f"port {args.local_port} on this computer is in use already (another tunnel?); choose another with --local-port")
    command = forward_command(args.host, local_port=args.local_port, remote_port=args.remote_port, jump=args.jump, ssh=args.ssh, options=options)
    say(f"Opening the tunnel: {shlex.join(command)}")
    tunnel = Tunnel(command, args.local_port, ssh=ssh, say=say)
    tunnel.start()
    try:
        if not tunnel.wait_listening(args.connect_timeout):
            raise TunnelError("ssh did not open the tunnel (see its messages above)")
        if not runner_answers(args.local_port):
            if args.start_remote:
                line = start_command(args.start_remote, state_dir=args.state_dir, local_port=args.local_port, remote_port=args.remote_port)
                say(f"Nothing answers on {host_name(args.host)}:{args.remote_port}; starting the runner there: {line}")
                done = ssh.run(remote_command(args.host, line, jump=args.jump, ssh=args.ssh, options=options))
                if done.returncode != 0:
                    raise TunnelError(f"starting the runner on {host_name(args.host)} failed (ssh exit code {done.returncode})")
                if not wait_for_runner(args.local_port, args.start_timeout, tunnel):
                    raise TunnelError(f"the runner on {host_name(args.host)} did not answer within {args.start_timeout:g} s; its output is in {_join(args.state_dir, 'remote.log')} there")
            else:
                say(
                    f"Nothing answers on {host_name(args.host)}:{args.remote_port} yet. Start the runner there:\n"
                    f"  python -m ngplatform_runner --root <folder> --port {args.remote_port} --public-url http://localhost:{args.local_port}\n"
                    "or give --start-remote 'COMMAND'. Waiting for it (Ctrl-C to stop)..."
                )
                if not wait_for_runner(args.local_port, None, tunnel):
                    raise TunnelError("the tunnel closed")
        done = ssh.run(remote_command(args.host, token_command(args.state_dir), jump=args.jump, ssh=args.ssh, options=options))
        token = (done.stdout or "").strip()
        if done.returncode != 0 or not token:
            raise TunnelError(f"could not read the runner's token on {host_name(args.host)} ({token_command(args.state_dir)}, exit code {done.returncode}); give its --state-dir with --state-dir")
        status, info = request_info(args.local_port, token)
        if status == 401:
            raise TunnelError(f"the runner refused the token in {_join(args.state_dir, 'token')}: is it started with another --state-dir?")
        if status == 403:
            raise TunnelError(f"the runner refuses requests through the tunnel: start it with --public-url http://localhost:{args.local_port} ({(info or {}).get('error') if isinstance(info, dict) else info})")
        if status != 200 or not isinstance(info, dict) or info.get("name") != "ngplatform-runner":
            raise TunnelError(f"what answers through the tunnel is not an ngplatform runner (HTTP {status})")
    except BaseException:
        tunnel.stop()
        raise
    link = pairing_link(args.app, args.local_port, token, args.name or host_name(args.host))
    return tunnel, token, info, link


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m ngplatform_runner tunnel",
        description="From the computer the browser is on: reach the ngplatform runner on another computer over SSH, and print the link that pairs the app with it.",
    )
    p.add_argument("host", metavar="[user@]HOST", help="the computer the runner is on (as you would give it to ssh)")
    p.add_argument("--jump", "-J", metavar="[user@]JUMP", help="reach HOST through this one (ssh -J), such as a cluster's login node")
    p.add_argument("--remote-port", type=int, default=8765, help="the runner's port on HOST (default 8765)")
    p.add_argument("--local-port", type=int, default=7000, help="the port on this computer the browser uses (default 7000)")
    p.add_argument("--app", default=DEFAULT_APP, help=f"the app's address, for the pairing link (default {DEFAULT_APP})")
    p.add_argument("--state-dir", default=DEFAULT_STATE_DIR, help=f"the runner's --state-dir on HOST, where its token is (default {DEFAULT_STATE_DIR})")
    p.add_argument("--start-remote", metavar="COMMAND", help="start the runner on HOST with this command when nothing answers (--public-url, --port and --state-dir are added)")
    p.add_argument("--name", help="the name the app shows for HOST (default: HOST)")
    p.add_argument("--ssh", default="ssh", help="the ssh program (default ssh)")
    p.add_argument("--ssh-option", "-o", action="append", metavar="OPTION", help="passed to ssh as -o OPTION (repeat for more)")
    p.add_argument("--connect-timeout", type=float, default=60.0, help="seconds to wait for ssh to open the tunnel (default 60)")
    p.add_argument("--start-timeout", type=float, default=120.0, help="seconds to wait for a runner --start-remote started (default 120)")
    return p


def main(argv: list[str] | None = None, ssh: Ssh | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        tunnel, _token, info, link = connect(args, ssh)
    except TunnelError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    print()
    for line in describe(info):
        print(line)
    print()
    print("Pair the app with it: open this link (it pairs this browser once)")
    print(f"  {link}")
    print()
    for line in manual_commands(args.host, local_port=args.local_port, remote_port=args.remote_port, jump=args.jump):
        print(line)
    print()
    print(f"The tunnel stays open while this runs (http://localhost:{args.local_port}); Ctrl-C closes it. The runner on {host_name(args.host)} keeps running.", flush=True)
    try:
        while tunnel.alive():
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        tunnel.stop()
    return 1 if tunnel.gave_up else 0


if __name__ == "__main__":
    raise SystemExit(main())
