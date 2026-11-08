"""Stands in for ``ssh`` in the tunnel's tests: "the other computer" is this one.

- ``fake_ssh.py -N ... -L LOCAL:127.0.0.1:REMOTE ... HOST``: forwards LOCAL to REMOTE (forwarder.py) until ended,
- ``fake_ssh.py [options] HOST COMMAND``: runs COMMAND with ``sh -c`` here.

Each call is appended (as JSON) to the file named by FAKE_SSH_LOG, when set.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TAKES_VALUE = {"-o", "-J", "-L", "-p", "-i", "-l", "-F"}


def main(argv: list[str]) -> int:
    if os.environ.get("FAKE_SSH_LOG"):
        with open(os.environ["FAKE_SSH_LOG"], "a") as f:
            f.write(json.dumps(argv) + "\n")
    forward = None
    words: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in TAKES_VALUE:
            if a == "-L":
                forward = argv[i + 1]
            i += 2
            continue
        if a.startswith("-") and not words:
            i += 1
            continue
        words.append(a)
        i += 1
    if not words:
        print("fake ssh: no host", file=sys.stderr)
        return 255
    if "-N" in argv:
        if forward is None:
            return 255
        local, _, remote = forward.split(":")
        os.execv(sys.executable, [sys.executable, str(HERE / "forwarder.py"), local, remote])
    command = " ".join(words[1:])
    return subprocess.call(["sh", "-c", command])


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
