"""What every job process runs: ``python -m ngplatform_runner.child RESULT MODULE [ARGS...]``.

It runs ``python -m MODULE ARGS...`` in this same process (so the job's PID
is the work's own), then writes ``{"returncode": N}`` to RESULT, which is how
a runner started again later learns how a job it did not start ended.
"""

from __future__ import annotations

import json
import os
import runpy
import signal
import sys
import time
import traceback


def _write(path: str, returncode: int) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump({"returncode": returncode, "finished": time.time()}, f)
    os.replace(tmp, path)


def main() -> None:
    if len(sys.argv) < 3:
        print("usage: python -m ngplatform_runner.child RESULT MODULE [ARGS...]", file=sys.stderr)
        raise SystemExit(2)
    result, module, args = sys.argv[1], sys.argv[2], sys.argv[3:]
    sys.argv = [module, *args]

    def terminated(signum, frame):
        # Cancelled: unwind, so the work's cleanup runs (a part-written file is deleted).
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminated)
    code = 0
    try:
        runpy.run_module(module, run_name="__main__", alter_sys=True)
    except SystemExit as exit_:
        value = exit_.code
        code = value if isinstance(value, int) else (0 if value is None else 1)
        if not isinstance(value, int) and value is not None:
            print(value, file=sys.stderr)
    except KeyboardInterrupt:
        code = 130
    except BaseException:  # noqa: BLE001 - every failure ends the job with its traceback in the log
        traceback.print_exc()
        code = 1
    sys.stdout.flush()
    sys.stderr.flush()
    _write(result, code)
    raise SystemExit(code)


if __name__ == "__main__":
    main()
