"""The work behind the runner's own job kinds, each run as ``python -m ngplatform_runner.tasks.<name>``.

They report progress as lines ``[progress] <0..1> <message>`` on stdout.
"""


def progress(fraction: float, message: str = "") -> None:
    print(f"[progress] {max(0.0, min(1.0, fraction)):.4f} {message}".rstrip(), flush=True)
