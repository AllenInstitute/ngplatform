"""A job that waits, reporting progress: for the runner's tests."""

from __future__ import annotations

import argparse
import sys
import time

from . import progress


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="sleep")
    p.add_argument("--seconds", type=float, default=1.0)
    p.add_argument("--steps", type=int, default=4)
    p.add_argument("--fail", action="store_true")
    p.add_argument("--output", default=None)
    p.add_argument("--child", action="store_true", help="start a process of its own that sleeps too (cancelling must end it)")
    args = p.parse_args(argv)
    if args.child:
        import subprocess

        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
        print(f"child pid {child.pid}", flush=True)
    for step in range(args.steps):
        progress(step / args.steps, f"Step {step + 1} of {args.steps}")
        time.sleep(args.seconds / args.steps)
    if args.fail:
        print("error: failed as asked", file=sys.stderr)
        return 3
    if args.output:
        with open(args.output, "w") as f:
            f.write("slept\n")
    progress(1.0, "Finished")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
