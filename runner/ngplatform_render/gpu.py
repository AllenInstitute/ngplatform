"""The render computer's GPU memory, shared by every session and job.

One `Budget` for the whole service: a session is let in only when what it
will hold fits (its volume, labels, finer detail and frame), and a job only
starts when its frame fits.  A volume is uploaded once (`Textures`): every
session and job on the same image and level renders from the same texture,
which goes when the last of them lets go of it.

What is counted is an estimate made before anything is allocated (see
renderer.volume_bytes and renderer.renderer_bytes), so the budget defaults
to a part of the memory the GPU has free when the service starts, leaving
room for what the estimates leave out.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass, field
from typing import Any, Callable

#: The part of the GPU's free memory the budget is, unless given.
DEFAULT_FRACTION = 0.8
MB = 1 << 20


class Refused(Exception):
    """A request the service cannot take now: its HTTP status (503: the GPU budget is taken; 429: too many jobs
    waiting; 507: too little disk), the words for the page, and how long to wait before trying again (s)."""

    def __init__(self, message: str, status: int = 503, retry_after: int | None = 30, **detail: Any):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after
        self.detail = detail

    def answer(self) -> dict[str, Any]:
        return {"error": str(self), **self.detail}


def parse_budget(text: str | None, free: int) -> int:
    """A budget as given: bytes, with K/M/G/T (powers of 1024), or a fraction (0-1] of `free`; none: the default."""
    if text is None or not str(text).strip():
        return int(free * DEFAULT_FRACTION)
    t = str(text).strip().upper().removesuffix("B")
    m = re.fullmatch(r"([0-9]*\.?[0-9]+)\s*([KMGT]?)", t)
    if m is None:
        raise ValueError(f"GPU budget {text!r}: bytes (24G, 12000M) or a fraction of the free memory (0.8)")
    x, unit = float(m.group(1)), m.group(2)
    if not unit and x <= 1.0:
        return int(free * x)
    return int(x * (1 << (10 * " KMGT".index(unit or " "))))


def free_memory(device: int) -> tuple[int, int]:
    """The GPU's free and total memory (bytes); (0, 0) without CuPy or a GPU."""
    try:
        import cupy

        with cupy.cuda.Device(device):
            free, total = cupy.cuda.runtime.memGetInfo()
        return int(free), int(total)
    except Exception:  # noqa: BLE001 - no GPU: nothing to share
        return 0, 0


def mb(n: int) -> int:
    return int(round(n / MB))


def gb(n: int) -> str:
    return f"{n / (1 << 30):.1f} GB"


class Reservation:
    """GPU memory counted against the budget for one holder, until released."""

    def __init__(self, budget: "Budget", nbytes: int, what: str):
        self.budget, self.bytes, self.what = budget, int(nbytes), what
        self.released = False

    def resize(self, nbytes: int) -> None:
        """Holds `nbytes` instead; growing past the budget is refused (Refused), and the reservation stays as it was."""
        self.budget._resize(self, int(nbytes))

    def release(self) -> None:
        self.budget._release(self)


class Budget:
    """The service's GPU memory budget: reservations are counted against `total` bytes."""

    def __init__(self, total: int):
        self.total = int(total)
        self.used = 0
        self._held: list[Reservation] = []
        self._lock = threading.Lock()

    def fits_ever(self, nbytes: int) -> bool:
        return nbytes <= self.total

    def reserve(self, nbytes: int, what: str, instead_of: tuple[Reservation, int] | None = None) -> Reservation:
        """Counts `nbytes` for `what`, or refuses (Refused, 503) when they do not fit beside what is held. With
        `instead_of` (a reservation, and bytes): that reservation shrinks by those bytes in the same step, so the
        memory it gives up is not taken by another in between."""
        nbytes = int(nbytes)
        with self._lock:
            back = min(instead_of[1], instead_of[0].bytes) if instead_of is not None and not instead_of[0].released else 0
            if self.used - back + nbytes > self.total:
                raise self._refusal(nbytes - back, what)
            if back:
                instead_of[0].bytes -= back
                self.used -= back
            r = Reservation(self, nbytes, what)
            self._held.append(r)
            self.used += nbytes
            return r

    def _refusal(self, need: int, what: str) -> Refused:
        free = max(0, self.total - self.used)
        return Refused(f"The render computer's GPU is busy: {what} needs about {gb(need)} of GPU memory and {gb(free)} of its "
                       f"{gb(self.total)} is free. Close another rendering tab or wait for a job to finish, then try again.",
                       503, 30, reason="gpu-budget", need_mb=mb(need), free_mb=mb(free), budget_mb=mb(self.total))

    def _resize(self, r: Reservation, nbytes: int) -> None:
        with self._lock:
            if r.released:
                return
            if nbytes > r.bytes and self.used - r.bytes + nbytes > self.total:
                raise self._refusal(nbytes - r.bytes, r.what)
            self.used += nbytes - r.bytes
            r.bytes = nbytes

    def _release(self, r: Reservation) -> None:
        with self._lock:
            if r.released:
                return
            r.released = True
            self.used -= r.bytes
            self._held.remove(r)

    def info(self) -> dict[str, Any]:
        with self._lock:
            return {"total_mb": mb(self.total), "used_mb": mb(self.used), "free_mb": mb(max(0, self.total - self.used)),
                    "held": [{"what": r.what, "mb": mb(r.bytes)} for r in self._held]}


@dataclass
class Shared:
    """One upload on the GPU (a volume's, or labels'), used by `refs` sessions and jobs."""

    key: tuple
    kind: str
    upload: Any = None  # renderer.OnGpu or renderer.LabelsOnGpu
    loaded: Any = None  # the host volume (volumes.Loaded) it was made from
    reservation: Reservation | None = None
    refs: int = 0
    spec_keys: set = field(default_factory=set)
    ready: threading.Event = field(default_factory=threading.Event)
    error: BaseException | None = None


class Textures:
    """The uploads on the GPU, by image and level: made once, shared, and let go of when the last user does."""

    def __init__(self, budget: Budget):
        self.budget = budget
        self._d: dict[tuple, Shared] = {}
        self._lock = threading.Lock()

    def find(self, spec_key: tuple) -> Shared | None:
        """The upload made for a session asked for in the same way (the same image, budget, level, channel...),
        when there is one: its volume need not be read or uploaded again."""
        with self._lock:
            return next((s for s in self._d.values() if spec_key in s.spec_keys and s.error is None), None)

    def acquire(self, key: tuple, kind: str, nbytes: int, make: Callable[[], Any], what: str, loaded: Any = None,
                spec_key: tuple | None = None, instead_of: tuple[Reservation, int] | None = None) -> Shared:
        """The upload of `key`, made by `make()` (counted as `nbytes` against the budget) when there is none yet, or
        shared (counted once); a reference the caller lets go of with release(). With `instead_of`, a reservation
        that gives up those bytes as this is counted (whether it is made now or was already)."""
        with self._lock:
            s = self._d.get(key)
            if s is None:
                s = self._d[key] = Shared(key, kind, loaded=loaded)
                owner = True
            else:
                owner = False
            s.refs += 1
            if spec_key is not None:
                s.spec_keys.add(spec_key)
        if not owner:
            s.ready.wait()
            if s.error is not None:
                self.release(s)
                raise s.error
            if instead_of is not None:
                instead_of[0].resize(max(0, instead_of[0].bytes - instead_of[1]))
            return s
        try:
            s.reservation = self.budget.reserve(nbytes, what, instead_of)
            s.upload = make()
        except BaseException as e:
            # Those waiting for it learn why; the next to ask makes it again (the entry is gone at once).
            s.error = e
            with self._lock:
                if self._d.get(key) is s:
                    del self._d[key]
            s.ready.set()
            self.release(s)
            raise
        s.ready.set()
        return s

    def ref(self, s: Shared) -> Shared:
        """Another reference to an upload already held (a job beside its session)."""
        with self._lock:
            s.refs += 1
        return s

    def release(self, s: Shared | None) -> None:
        if s is None:
            return
        with self._lock:
            s.refs -= 1
            if s.refs > 0:
                return
            if self._d.get(s.key) is s:
                del self._d[s.key]
        s.upload = None
        s.loaded = None
        if s.reservation is not None:
            s.reservation.release()

    def info(self) -> list[dict[str, Any]]:
        with self._lock:
            return [{"kind": s.kind, "image": str(s.key[1]), "level": str(s.key[2]), "users": s.refs,
                     "mb": mb(s.reservation.bytes) if s.reservation else 0} for s in self._d.values()]


class Gpu:
    """The device, its budget and its shared uploads: what every session and job of a service draws on."""

    def __init__(self, device: int, total: int | None = None):
        self.device = device
        if total is None:
            free, _ = free_memory(device)
            total = int(free * DEFAULT_FRACTION) if free else 1 << 62  # no GPU: nothing to count
        self.budget = Budget(total)
        self.textures = Textures(self.budget)

    def info(self) -> dict[str, Any]:
        return {**self.budget.info(), "uploads": self.textures.info()}
