"""What the runner tells the app about the computer it runs on: its name, system and GPUs.

The GPUs come from ``nvidia-smi`` (kept for 10 s, since the app asks every
few seconds).  A computer without it has none.  A GPU that cannot answer
("[GPU requires reset]", "[N/A]") is listed with ``ok`` false and the
reason, so the app does not choose it.
"""

from __future__ import annotations

import platform
import shutil
import socket
import subprocess
import threading
import time
from typing import Any

QUERY = ["--query-gpu=index,name,memory.total,memory.used,pci.bus_id", "--format=csv,noheader,nounits"]
CACHE_SECONDS = 10.0

_lock = threading.Lock()
_cache: tuple[float, list[dict[str, Any]]] | None = None


def _number(text: str) -> int | None:
    try:
        return int(float(text))
    except ValueError:
        return None


def parse_gpus(text: str) -> list[dict[str, Any]]:
    """The GPUs in ``nvidia-smi --query-gpu=index,name,memory.total,memory.used,pci.bus_id --format=csv,noheader,nounits`` output.

    Memory is in MiB.  A field in brackets (``[GPU requires reset]``,
    ``[N/A]``, ``[Unknown Error]``) is no value; a GPU with one is not ``ok``.
    """
    gpus: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        fields = [f.strip() for f in line.split(",")]
        if len(fields) < 5:
            # A card that cannot answer may print one message for the whole row.
            gpus.append({"index": len(gpus), "name": line, "memoryTotal": None, "memoryUsed": None, "memoryFree": None, "busId": "", "ok": False, "problem": line.strip("[]")})
            continue
        index, name, total, used, bus = fields[0], ", ".join(fields[1:-3]), fields[-3], fields[-2], fields[-1]
        problems = [f.strip("[]") for f in fields if f.startswith("[") and f.endswith("]")]
        total_n, used_n = _number(total), _number(used)
        gpu: dict[str, Any] = {
            "index": _number(index) if _number(index) is not None else len(gpus),
            "name": name if not (name.startswith("[") and name.endswith("]")) else "GPU",
            "memoryTotal": total_n,
            "memoryUsed": used_n,
            "memoryFree": total_n - used_n if total_n is not None and used_n is not None else None,
            "busId": bus if not bus.startswith("[") else "",
            "ok": not problems and total_n is not None,
        }
        if problems:
            gpu["problem"] = problems[0]
        gpus.append(gpu)
    return gpus


def _query() -> list[dict[str, Any]]:
    exe = shutil.which("nvidia-smi")
    if exe is None:
        return []
    try:
        out = subprocess.run([exe, *QUERY], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return []
    # nvidia-smi exits non-zero when one card cannot answer, and still lists the others.
    return parse_gpus(out.stdout)


def gpus(refresh: bool = False) -> list[dict[str, Any]]:
    """This computer's NVIDIA GPUs (an empty list without nvidia-smi), at most 10 s old."""
    global _cache
    with _lock:
        now = time.monotonic()
        if refresh or _cache is None or now - _cache[0] > CACHE_SECONDS:
            _cache = (now, _query())
        return [dict(g) for g in _cache[1]]


def host() -> dict[str, Any]:
    return {"hostname": socket.gethostname(), "platform": f"{platform.system()} {platform.release()} ({platform.machine()})"}
