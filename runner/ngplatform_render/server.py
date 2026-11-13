"""The render service: path-traced views of OME-Zarr volumes, over HTTP.

Started by the runner as a service (``--service render="<python> -m
ngplatform_render.server"``), which gives it a port and a token in its
environment and forwards ``/svc/render/...`` to it; or on its own with
``--port`` (and ``--token``) for tests.  It listens on 127.0.0.1 only.

A session holds one volume (and optionally a label volume) on the GPU.
Every session and job draws on one GPU budget (gpu.py): a session is let
in only when what it will hold fits (else a 503 that says why), sessions
and jobs on the same image and level share one upload of it, and stills,
movies and splats run one at a time from a queue (a 429 when too many
wait), each refused up front when the disk has too little room (507).
The page sends the view (camera, preset, cuts, lights, region colours)
whenever it changes; the session adds samples to the image in the
background and publishes it, refined, as it goes; the page long-polls
for frames newer than the last it has.  See the API section of
``runner/README.md``.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import traceback
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote

import numpy as np

from . import __version__
from .gpu import Gpu, Refused, gb
from .lightmaps import names as lightmap_names
from . import presets as presets_mod
from .presets import Preset, builtin

MAX_BODY = 8 << 20
_LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
# A session nothing has asked about for this long is closed: a page polls its frames every 20 s, so this is a
# tab closed without its close reaching the service, or a computer gone to sleep (the page opens a new one).
IDLE_SECONDS = 3 * 60
REAP_EVERY = 30.0
# A session stops rendering when no page has waited for its frames for this long (a closed tab), and
# goes on when one does.
UNWATCHED_SECONDS = 5.0


# Keeping a still view steady: when the camera stops (or the look changes) the frame shown stays until
# the new image has HOLD_STILL[0] samples or HOLD_STILL[1] s have passed; when finer detail comes, until
# it has as many samples as the frame shown (at most HOLD_SWAP[0]: past the denoiser's blur) or
# HOLD_SWAP[1] s have passed. (The page fades each frame of the same camera in over the one before.)
HOLD_STILL = (12, 0.4)  # 12: renderer.DENOISE_UNTIL, so the denoiser's blur is not shown and then lost
HOLD_SWAP = (24, 2.0)
# A still view's first samples are tracked fast (as the moving frames are), then exactly.
FAST_FIRST = 32
# While the camera moves, the detail is planned at most this often (s).
PLAN_MOVING_S = 0.3
# A detail region of more voxels than this is read at the next coarser level first.
COARSER_FIRST = 24e6


# What one request may ask of the GPU (beside the service's budget, gpu.py): a frame's side in pixels, samples
# per pixel, frames a second, and a still's or a movie's size (pixels, and pixels x samples).
MIN_SIDE, MAX_SIDE = 8, 8192
MAX_SAMPLES = 4096
MAX_FPS = 120
MAX_STILL_WORK = 8192 * 8192 * 256
MAX_MOVIE_FRAMES = 18_000
MAX_MOVIE_PIXELS = 3e10  # its frames' PNGs on disk, about a byte a pixel
MAX_MOVIE_WORK = 4e12
#: How many finished movies, stills and splats are listed.
KEEP_FINISHED = 20
FINISHED = ("done", "failed", "cancelled")
#: How many stills, movies and splats may wait for the one running (more: a 429).
MAX_WAITING_JOBS = 8
#: How long a job at the head of the queue waits for the GPU memory it needs (sessions hold it) before it fails (s).
JOB_GPU_WAIT = 600.0
#: The disk a job leaves free beyond what it is reckoned to write.
DISK_MARGIN = 1 << 30
#: The live view's frame a session's admission counts on; a larger view asks for more when it comes (PUT /view).
SESSION_FRAME = (1920, 1080)
#: How long a page is told to wait before asking again after a 503 or 429 (s).
RETRY_AFTER = 30
#: Downloads are sent this many bytes at a time.
FILE_CHUNK = 1 << 20


class BadRequest(Exception):
    pass


def number(v: Any, name: str) -> float:
    """`v` as a finite number, else a 400 that names it."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise BadRequest(f"{name}: a number") from None
    if not math.isfinite(x):
        raise BadRequest(f"{name}: a number")
    return x


def side(v: Any, name: str) -> int:
    """A frame's width or height, within MIN_SIDE..MAX_SIDE."""
    return max(MIN_SIDE, min(MAX_SIDE, int(round(number(v, name)))))


def samples_of(v: Any, default: int) -> int:
    """Samples per pixel, within 1..MAX_SAMPLES."""
    return max(1, min(MAX_SAMPLES, int(number(v if v is not None else default, "samples"))))


def gpu_failure(e: BaseException) -> str | None:
    """What to tell the page when `e` is the GPU failing (out of memory, a CUDA error); None for anything else."""
    name, text = type(e).__name__, str(e)
    if name == "OutOfMemoryError" or "out of memory" in text.lower() or "MemoryAllocation" in text:
        return f"The GPU ran out of memory: {text}"
    if (type(e).__module__ or "").startswith(("cupy", "cupy_backends")):
        return f"GPU error: {name}: {text}"
    return None


def free_gpu_pool() -> None:
    """Gives the GPU memory CuPy keeps for reuse back to the device (after a job, or a session that failed)."""
    try:
        import cupy

        cupy.get_default_memory_pool().free_all_blocks()
    except Exception:  # noqa: BLE001 - no CuPy: nothing held
        pass


def index_of(v: Any, name: str) -> int | None:
    """A channel or time point as asked for: a whole number from 0, or None when not given; else a 400."""
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != int(v) or v < 0:
        raise BadRequest(f"volume.{name}: a whole number from 0")
    return int(v)


def _cube(voxels: float) -> tuple[int, int, int]:
    n = max(1, round(float(voxels) ** (1 / 3)))
    return (n, n, n)


def objects_spec(o: Any) -> dict[str, Any]:
    """A session's objects as asked for: a precomputed segmentation (url), the segments (ids, at most 64), the
    meshes' level of detail, and the voxels the image within them may take."""
    if not isinstance(o, dict) or not o.get("url"):
        raise BadRequest("objects.url (a precomputed segmentation) is needed")
    ids = o.get("ids") or []
    if not isinstance(ids, list) or not ids or len(ids) > 64:
        raise BadRequest("objects.ids: 1 to 64 segment ids")
    try:
        ids = [int(str(i)) for i in ids]
    except ValueError:
        raise BadRequest("objects.ids: segment ids are integers") from None
    budget = int(number(o.get("budget", 300_000_000), "objects.budget"))
    if not 1_000_000 <= budget <= 4_000_000_000:
        raise BadRequest("objects.budget: 1 M to 4 G voxels")
    return {"url": str(o["url"]), "ids": ids, "lod": int(number(o.get("lod", 1), "objects.lod")), "budget": budget,
            **({"level": str(o["level"])} if o.get("level") else {})}


def spec_key(part: dict[str, Any], labels: bool = False) -> tuple:
    """What a volume (or labels) is asked for by: sessions asked for alike share what one of them read and uploaded."""
    from .volumes import http_url

    return ("labels" if labels else "volume", http_url(part["url"]), int(part.get("budget") or 400_000_000), part.get("level"),
            None if labels else part.get("cylinder"), part.get("channel"), part.get("time"))


def session_need(spec: dict[str, Any], gpu: Gpu) -> dict[str, int]:
    """What a session will hold on the GPU (bytes), reckoned before anything is read: its volume's upload (none when
    one asked for alike is already there, to share), its labels', the finer detail's and the live view's frame."""
    from . import renderer as rmod

    v = spec["volume"]
    budget = int(v.get("budget") or 400_000_000)
    shared = gpu.textures.find(spec_key(v)) is not None
    out = {"volume": 0 if shared else rmod.volume_bytes(_cube(budget), 2)}
    lab = spec.get("labels") or {}
    if lab.get("url"):
        lab = {**lab, "budget": lab.get("budget") or budget}
        out["labels"] = 0 if gpu.textures.find(spec_key(lab, True)) is not None else rmod.labels_bytes(_cube(int(lab["budget"])))
    detail = float(v.get("detail_budget", 256e6))
    out["detail"] = rmod.volume_bytes(_cube(detail), 2) if detail > 0 else 0
    out["frame"] = rmod.renderer_bytes(*SESSION_FRAME, _cube(budget))
    return out


def safe_name(name: Any, fallback: str = "movie") -> str:
    """A file name of letters, digits, dots, dashes and underscores only (no folders)."""
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", str(name or "")).strip("._")
    return s[:80] or fallback


def _mat(v, name: str) -> np.ndarray:
    a = np.asarray(v, np.float64)
    if a.size != 16:
        raise BadRequest(f"{name}: 16 numbers (a 4x4, column-major)")
    return a.reshape(4, 4).T  # column-major in, numpy (row-major) out


class Session:
    def __init__(self, sid: str, spec: dict[str, Any], device: int, gpu: Gpu | None = None, reservation=None,
                 need: dict[str, int] | None = None):
        self.id = sid
        self.spec = spec
        self.device = device
        # The service's GPU (none given: a budget of no limit), what this session was let in with (its reservation,
        # and the bytes of each part), and the uploads it shares.
        self.gpu = gpu if gpu is not None else Gpu(device, total=1 << 62)
        self.reservation = reservation
        self.need = dict(need or {})
        self.vol_share = None
        self.lab_share = None
        self._R = None  # the renderer, until torn down (self.renderer is let go of at close)
        self._torn = False
        self._teardown_lock = threading.Lock()
        self.status = "loading"
        self.progress = 0.0
        self.message = "starting"
        self.error: str | None = None
        self.meta: dict[str, Any] = {}
        self.label_meta: dict[str, Any] | None = None
        self.renderer = None
        self.loaded = None
        self.loaded_labels = None
        # Objects (objects.py): their meshes' BVH and the image within them, and what was read.
        self.loaded_objects: tuple[Any, Any, list[int]] | None = None
        self.objects_meta: dict[str, Any] | None = None
        self.cond = threading.Condition()
        self.view: dict[str, Any] | None = None
        self.view_version = 0
        self.applied_version = -1
        # number, samples, version, the encoded frame, w, h, its type, where its alpha plane starts (jpeg) or 0
        self.frame: tuple[int, int, int, bytes, int, int, str, int] | None = None
        self.frame_number = 0
        # version, GL depth (H, W float32), w, h, distance (H, W float32); packed for the page only when asked (packed()).
        self.depth: tuple[int, np.ndarray, int, int, np.ndarray] | None = None
        self._packed: dict[tuple[int, str], tuple[bytes, dict[str, str]]] = {}
        # A still view kept steady: the frame shown last (its version, camera, samples), and a hold on
        # publishing until the new image has a few samples.
        self._shown: tuple[int, Any, int] | None = None
        self._hold: tuple[int, float] | None = None
        self._last_plan = 0.0
        self.max_samples = 1024
        self.last_used = time.time()
        self._watchers = 0
        self._watched = time.time()
        self.closed = False
        self.passes_ms = 0.0
        # Finer detail where the view looks (detail.py): the levels finer than the loaded one, the loader,
        # a region read and waiting to be taken up, and the one held (its level, box, physical affine).
        self.detail_levels: list[tuple[int, Any]] = []
        self.detail_loader = None
        self._detail_pending: tuple[dict, Any] | None = None
        self.detail_meta: dict[str, Any] | None = None
        self._detail_affine: np.ndarray | None = None
        self._wfp = np.eye(4)
        # The thread that holds the GPU for the session: the load, then the loop; the last to run tears down.
        self._worker = threading.Thread(target=self._load, daemon=True)
        self._worker.start()

    # ---------------------------------------------------------------- loading
    def _set_progress(self, p: float, msg: str) -> None:
        self.progress, self.message = p, msg

    def _load_objects(self, spec: dict[str, Any], url: str, L, closed) -> None:
        """The objects' meshes (a precomputed segmentation's, by segment id), their BVH on the session's GPU, and the
        image within them at the finest level within spec["budget"] (objects.py)."""
        from . import geometry, objects, volumes
        from .meshes import MeshSource

        src = MeshSource(spec["url"])
        parts, ids = [], []
        for k, sid in enumerate(spec["ids"]):
            if closed():
                return
            self._set_progress(0.0, f"reading the mesh of {sid} ({k + 1} of {len(spec['ids'])})")
            m = src.mesh(int(sid), int(spec.get("lod", 1)))
            if m is None or len(m.faces) == 0:
                continue
            parts.append((m.vertices[m.faces] * 1e-6, len(ids)))  # nm -> physical mm
            ids.append(int(sid))
        if not parts:
            raise ValueError("none of the chosen segments has a mesh")
        tris = np.concatenate([t for t, _ in parts])
        obj = np.concatenate([np.full(len(t), i, np.int32) for t, i in parts])
        with self.gpu_device():
            bvh = geometry.build(tris.astype(np.float32), obj, self.device)
        ms = volumes.open_multiscale(url)
        lo, hi = float(L.lo), float(L.hi)

        def to_u8(a: np.ndarray) -> np.ndarray:
            if a.dtype == np.uint8 and lo == 0 and hi == 255:
                return a
            return np.clip((a.astype(np.float32) - lo) * (255.0 / max(hi - lo, 1e-12)), 0, 255).astype(np.uint8)

        with self.gpu_device():
            ob = objects.build(url, ms, tris, bvh, int(spec.get("budget") or 300_000_000), to_u8, self._set_progress, closed, spec.get("level"))
        self.loaded_objects = (bvh, ob, ids)
        self.objects_meta = {"url": spec["url"], "ids": [str(i) for i in ids], "triangles": int(len(tris)), "level": ob.level,
                             "page": list(ob.page), "bricks": ob.bricks, "inside_voxels": ob.inside_voxels, **ob.stats}

    def gpu_device(self):
        import cupy

        return cupy.cuda.Device(self.device)

    def _load(self) -> None:
        from . import renderer, volumes

        handed_on = False
        try:
            v = self.spec["volume"]
            url = v["url"]
            budget = int(v.get("budget") or 400_000_000)
            closed = lambda: self.closed  # noqa: E731 - a session closed while it loads stops reading
            shared = self.gpu.textures.find(spec_key(v))
            if shared is not None and shared.loaded is not None:
                # Another session shows the same image, asked for alike: its volume, not read again.
                L = shared.loaded
                self._set_progress(1.0, "shared with another view of this image")
            else:
                L = volumes.load(url, budget=budget, level=v.get("level"), progress=self._set_progress,
                                 channel=v.get("channel"), time=v.get("time"), cancelled=closed)
                if v.get("cylinder"):
                    # Only a cylinder about the scan's axis (the specimen inside its jar).
                    volumes.hide_outside_cylinder(L.data, float(v["cylinder"]))
            self.loaded = L
            self.meta = {
                "url": url, "level": L.level, "shape": list(L.data.shape), "dtype": str(L.data.dtype),
                "voxel_mm": list(L.voxel_mm), "affine": L.affine.T.ravel().tolist(), "lo": L.lo, "hi": L.hi,
                "percentiles": {str(k): v for k, v in sorted(L.percentiles.items())}, "source_shape": list(L.source_shape),
                "made": L.made, "from_cache": L.from_cache, "seconds": round(L.seconds, 2),
                "window": list(L.window) if L.window else None, "cylinder": v.get("cylinder"),
                "histogram_matched": L.quantiles is not None, "medium": L.medium,
                "histogram": presets_mod.histogram(L.data, L.lo, L.hi),
                "tissue_mm": volumes.tissue_box(L.data, L.affine, L.percentiles.get(0.0, L.lo), L.lo, L.hi),
                # The channel and time point shown, and how many the image has (volume.channel, volume.time).
                "channel": L.channel, "time": L.time, "channels": L.counts.get("channels", 1), "times": L.counts.get("times", 1),
                "axes": L.counts.get("axes", []),
            }
            lab = self.spec.get("labels")
            LB = None
            if lab and lab.get("url"):
                lab = {**lab, "budget": int(lab.get("budget") or budget)}
                lshared = self.gpu.textures.find(spec_key(lab, True))
                if lshared is not None and lshared.loaded is not None:
                    LB = lshared.loaded
                else:
                    self._set_progress(0.0, "reading labels")
                    LB = volumes.load(lab["url"], budget=lab["budget"], labels=True, progress=self._set_progress, cancelled=closed)
                self.loaded_labels = LB
                vals = np.unique(LB.data)
                self.label_meta = {"url": lab["url"], "level": LB.level, "shape": list(LB.data.shape), "values": [int(x) for x in vals[:4096]],
                                   "affine": LB.affine.T.ravel().tolist()}
            if self.spec.get("objects"):
                self._load_objects(self.spec["objects"], url, L, closed)
            if self.closed:
                self.status, self.message = "failed", "closed while loading"
                return
            self._start_detail(url, L, float(v.get("detail_budget", 256e6)), v.get("channel"), v.get("time"))
            if self.detail_loader is None and self.need.get("detail") and self.reservation is not None:
                # No finer levels (or no detail asked for): the memory counted for them is given back.
                self.reservation.resize(max(0, self.reservation.bytes - self.need["detail"]))
                self.need["detail"] = 0
            self._set_progress(1.0, "uploading to the GPU")
            # The volume (and labels) on the GPU once, shared by every session and job showing the same image and
            # level: counted against the budget once, in place of what this session's admission reckoned for it.
            name = (v["url"].rstrip("/").split("/")[-1] or "the image")[:60]
            vkey = ("volume", volumes.http_url(url), L.level, v.get("cylinder"), L.channel, L.time, self.device)
            self.vol_share = self.gpu.textures.acquire(
                vkey, "volume", renderer.volume_bytes(L.data.shape, L.data.dtype.itemsize),
                lambda: renderer.upload(L.data, self.device), f"the image {name}", loaded=L, spec_key=spec_key(v),
                instead_of=(self.reservation, self.need.get("volume", 0)) if self.reservation is not None else None)
            if LB is not None:
                lkey = ("labels", volumes.http_url(lab["url"]), LB.level, None, 0, 0, self.device)
                self.lab_share = self.gpu.textures.acquire(
                    lkey, "labels", renderer.labels_bytes(LB.data.shape), lambda: renderer.upload_labels(LB.data, self.device),
                    f"the labels of {name}", loaded=LB, spec_key=spec_key(lab, True),
                    instead_of=(self.reservation, self.need.get("labels", 0)) if self.reservation is not None else None)
            R = renderer.Renderer(self.device)
            self._R = R
            R.set_volume(renderer.Volume(L.data, L.affine, L.lo, L.hi, L.percentiles, L.window, L.quantiles, L.medium), self.vol_share.upload)
            if self.closed:
                return
            self.renderer = R
            self.status = "ready"
            self.message = f"level {L.level} {tuple(L.data.shape[::-1])} voxels of {', '.join(f'{x:.3g}' for x in L.voxel_mm)} mm"
            with self._teardown_lock:
                if not self._torn:
                    self._worker = threading.Thread(target=self._loop, daemon=True)
                    self._worker.start()
                    handed_on = True
        except volumes.Cancelled:
            self.status, self.message = "failed", "closed while loading"
        except Refused as e:
            # The budget filled while this one loaded: said as plainly as a refusal at the door.
            self.status, self.error = "failed", str(e)
        except Exception as e:  # noqa: BLE001 - reported to the page
            self.status = "failed"
            self.error = gpu_failure(e) or f"{type(e).__name__}: {e}"
            traceback.print_exc()
        finally:
            if not handed_on:
                self._teardown()

    # ---------------------------------------------------------------- detail
    def _start_detail(self, url: str, L, budget: float, channel: int | None = None, time_point: int | None = None) -> None:
        """A loader for regions of the levels finer than L, when the store has any (and budget > 0), at the channel
        and time point shown."""
        from . import detail, volumes

        self.detail_budget = budget
        if budget <= 0:
            return
        ms = volumes.open_multiscale(url)
        coarse = detail.voxel_size(L.affine)
        self.detail_levels = [(i, lv) for i, lv in enumerate(ms.levels) if detail.voxel_size(lv.affine) < 0.95 * coarse]
        if not self.detail_levels:
            return
        top = 255 if L.data.dtype == np.uint8 else 65535

        def quantize(a: np.ndarray) -> np.ndarray:
            # Onto the loaded level's scale (its texture reads 0..1 the same way).
            if a.dtype == L.data.dtype:
                return a
            f = (a.astype(np.float32) - L.lo) / max(L.hi - L.lo, 1e-12)
            return np.clip(f * top + 0.5, 0, top).astype(L.data.dtype)

        def arrived(req: dict, data: np.ndarray) -> None:
            with self.cond:
                self._detail_pending = (req, data)
                self.cond.notify_all()

        self.detail_loader = detail.DetailLoader(url, ms, arrived, quantize, ms.fixed(channel, time_point))

    def _take_detail(self, R) -> bool:
        """Hold the region read last, if one is waiting; True when the view should start again with it."""
        from . import renderer

        with self.cond:
            pending, self._detail_pending = self._detail_pending, None
        if pending is None:
            return False
        req, data = pending
        lv = self.detail_loader.ms.levels[req["level"]]
        cyl = self.spec["volume"].get("cylinder")
        if cyl:
            from . import volumes

            volumes.hide_outside_cylinder(data, float(cyl), req["lo"], tuple(lv.shape[a] for a in self.detail_loader.ms.spatial))
        T = np.eye(4)
        T[:3, 3] = req["lo"]
        self._detail_affine = lv.affine @ T  # region voxel -> physical mm
        R.set_detail(renderer.Detail(data, self._wfp @ self._detail_affine))
        self.detail_meta = {"level": req["level"], "path": lv.path, "lo": list(req["lo"]), "hi": list(req["hi"]),
                            "need_lo": list(req["need_lo"]), "need_hi": list(req["need_hi"]),
                            "voxel_mm": [round(x, 6) for x in lv.voxel_mm], "voxels": int(data.size)}
        return True

    def _plan_detail(self, R, st, dist: np.ndarray, width: int, height: int) -> None:
        """Ask for the detail this view needs (at its full size, `width` x `height`: a moving view is drawn
        smaller, but asks for what it will need when it stops), or let go of the one held when it needs none."""
        from . import detail

        L = self.loaded
        levels = []
        for _, lv in self.detail_levels:
            shape = tuple(lv.shape[a] for a in self.detail_loader.ms.spatial)  # x, y, z
            levels.append((shape, self._wfp @ lv.affine))
        held = next((k for k, (lvi, _) in enumerate(self.detail_levels) if self.detail_meta and lvi == self.detail_meta["level"]), None)
        p = detail.plan(st.inv_view_projection, width, height, dist, levels, detail.voxel_size(self._wfp @ L.affine), self.detail_budget, held=held)
        if p is None:
            self.detail_loader.cancel()
            if R.detail is not None:
                R.set_detail(None)
                self.detail_meta = None
                self._detail_affine = None
                R.set_view(st)
            return
        i, lo, hi, need_lo, need_hi = p
        level = self.detail_levels[i][0]
        cur = self.detail_meta
        if cur is not None and cur["level"] == level and detail.contains((cur["lo"], cur["hi"]), (need_lo, need_hi)):
            self.detail_loader.cancel()  # what is held will do
            return
        chain = [{"level": level, "lo": lo, "hi": hi, "need_lo": need_lo, "need_hi": need_hi}]
        j = i + 1
        if math.prod(h - l for l, h in zip(lo, hi)) > COARSER_FIRST and j < len(self.detail_levels) and (held is None or held > j):
            # A large region: the same region at the next coarser level first (an eighth of the bytes), so
            # the view sharpens in a second or two, then again when the finer one is read.
            k = self.detail_levels[j][0]
            if not (cur is not None and cur["level"] == k and detail.contains((cur["lo"], cur["hi"]), self._map_box(i, j, need_lo, need_hi))):
                blo, bhi = self._map_box(i, j, lo, hi)
                nlo, nhi = self._map_box(i, j, need_lo, need_hi)
                chain.insert(0, {"level": k, "lo": blo, "hi": bhi, "need_lo": nlo, "need_hi": nhi})
        self.detail_loader.request(chain)

    def _map_box(self, i: int, j: int, lo, hi) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
        """A box (lo, hi exclusive; x, y, z) of detail level i as a box of level j that holds it."""
        a, b = self.detail_levels[i][1], self.detail_levels[j][1]
        m = np.linalg.inv(b.affine) @ a.affine
        corners = np.array([[x, y, z, 1.0] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
        v = (corners @ m.T)[:, :3]
        n = np.array([b.shape[ax] for ax in self.detail_loader.ms.spatial], float)
        blo = np.clip(np.floor(v.min(0)), 0, n - 1).astype(int)
        bhi = np.clip(np.ceil(v.max(0)), 1, n).astype(int)
        return tuple(int(x) for x in blo), tuple(int(x) for x in bhi)

    def detail_text(self) -> str:
        """What detail is held or being read, in a few words (the X-Detail header)."""
        ld = self.detail_loader
        if ld is None:
            return ""
        st = ld.status
        if st.get("state") == "loading":
            return f"reading level {st['level']} ({min(st['voxel_mm']):.3g} mm): {st['progress'] * 100:.0f}%"
        if st.get("state") == "failed":
            return f"detail failed: {st.get('error', '')[:120]}"
        m = self.detail_meta
        if m is None:
            return "coarse level (no finer detail needed here)"
        return f"level {m['path']} ({min(m['voxel_mm']):.3g} mm) where you look, {m['voxels'] / 1e6:.0f} M voxels"

    def packed(self, version: int, kind: str) -> tuple[bytes, dict[str, str]] | None:
        """The view `version`'s depth for the page, deflated, with its headers (made once, when first asked):
        "depth" (GL depth, float16), "distance" (float32), or "distance16" (every second pixel, as float16
        of the distance over X-Distance-Scale: the frame's points, a quarter of the bytes)."""
        with self.cond:
            d = self.depth
            if d is None or d[0] != version:
                return None
            key = (version, kind)
            if key in self._packed:
                return self._packed[key]
            _, gl, w, h, dist = d
        if kind == "depth":
            out = (zlib.compress(gl.astype(np.float16).tobytes(), 1), {"X-Width": str(w), "X-Height": str(h), "X-Format": "float16-zlib"})
        elif kind == "distance":
            out = (zlib.compress(np.ascontiguousarray(dist, np.float32).tobytes(), 1), {"X-Width": str(w), "X-Height": str(h), "X-Format": "float32-zlib"})
        else:
            half = np.ascontiguousarray(dist[::2, ::2])
            scale = float(half.max()) if (half > 0).any() else 1.0
            q = np.where(half >= 0, half / scale, -1.0).astype(np.float16)
            out = (zlib.compress(q.tobytes(), 1), {"X-Distance-Width": str(half.shape[1]), "X-Distance-Height": str(half.shape[0]),
                                                   "X-Distance-Scale": repr(scale), "X-Distance-Format": "float16-zlib"})
        with self.cond:
            if self.depth is not None and self.depth[0] == version:
                self._packed = {k: v for k, v in self._packed.items() if k[0] == version}
                self._packed[(version, kind)] = out
        return out

    # ---------------------------------------------------------------- views
    def set_view(self, view: dict[str, Any]) -> int:
        most = samples_of(view.get("max_samples") or None, 1024)
        with self.cond:
            self.view = view
            self.view_version += 1
            self._watched = time.time()
            self.max_samples = most
            self.last_used = time.time()
            self.cond.notify_all()
            return self.view_version

    @staticmethod
    def _boxes(view: dict[str, Any], L) -> list:
        """The view's crops ({"lo", "hi": fractions of the volume along x, y, z; "keep": the inside, else it is
        cut out}) in voxel coordinates."""
        n = L.data.shape[::-1]
        out = []
        for b in (view.get("boxes") or [])[:8]:
            lo = tuple(float(b["lo"][a]) * n[a] - 0.5 for a in range(3))
            hi = tuple(float(b["hi"][a]) * n[a] - 0.5 for a in range(3))
            out.append((lo, hi, bool(b.get("keep", True))))
        return out

    def _state(self, view: dict[str, Any], R=None, detail_affine: np.ndarray | None = None):
        """The view as the renderer takes it, placing the volume and labels on `R` (the session's own by default;
        another's finer detail placed by its own `detail_affine`, region voxel to physical mm)."""
        from . import renderer
        from .luts import freesurfer

        L = self.loaded
        R = R if R is not None else self.renderer
        wfp = _mat(view["world_from_physical"], "world_from_physical") if view.get("world_from_physical") else np.eye(4)
        own = R is self.renderer
        if own:
            self._wfp = wfp
        affine = self._detail_affine if own else detail_affine
        if R.detail is not None and affine is not None:
            R.detail.world_from_voxel = wfp @ affine
        scale = min(1.0, max(0.05, number(view.get("scale") or 1.0, "scale")))
        W = side(number(view["width"], "width") * scale, "width")
        H = side(number(view["height"], "height") * scale, "height")
        inv = _mat(view["inv_view_projection"], "inv_view_projection")
        pr = view.get("preset") or "HiP-CT brain"
        if isinstance(pr, str):
            presets = builtin()
            if pr not in presets:
                raise BadRequest(f"no preset {pr!r}")
            preset = presets[pr]
        else:
            preset = Preset.from_dict(pr)
        if view.get("overrides"):
            preset = preset.with_overrides(**view["overrides"])
        if view.get("environment"):
            # The light: a light map by name ("" for the preset's sky colours), its turn and strength.
            env = {**preset.environment, **view["environment"]}
            if not env.get("map"):
                env.pop("map", None)
            elif env["map"] not in lightmap_names():
                raise BadRequest(f"no light map {env['map']!r}")
            preset = preset.with_overrides(environment=env)
        # The volume (and labels) in world coordinates.
        vol_world = wfp @ L.affine
        if R.volume is None or not np.allclose(R.volume.world_from_voxel, vol_world):
            R.volume.world_from_voxel = vol_world
        colors = None
        keep: set[int] = set()
        mix = 1.0
        lab_spec = view.get("labels")
        if self.loaded_labels is not None and lab_spec is not None and lab_spec.get("show", True):
            LB = self.loaded_labels
            lw = wfp @ LB.affine
            if R.labels is None:
                R.set_labels(renderer.Labels(LB.data, lw), self.lab_share.upload if self.lab_share is not None else None)
            else:
                R.labels.world_from_voxel = lw
            if lab_spec.get("colors"):
                colors = {int(k): tuple(float(x) for x in v) for k, v in lab_spec["colors"].items()}
            else:
                lut = freesurfer()
                vals = self.label_meta["values"] if self.label_meta else []
                colors = {k: (*lut[k][1], 1.0) for k in vals if k in lut and k != 0}
            hidden = {int(k) for k in lab_spec.get("hidden", [])}
            for k in hidden:
                c = colors.get(k, (1.0, 1.0, 1.0, 1.0))
                colors[k] = (c[0], c[1], c[2], 0.0)
            keep = {int(k) for k in lab_spec.get("keep", [])}
            mix = float(lab_spec.get("mix", 1.0))
        self._place_objects(R, view.get("objects"), wfp)
        light = view.get("light") or {}
        crop = view.get("crop")
        if crop is None and view.get("crop_fraction"):
            # A clip box as fractions (0..1) of the volume along its x, y, z, in voxel coordinates.
            lo_f, hi_f = view["crop_fraction"]
            n = L.data.shape[::-1]
            crop = [[float(lo_f[a]) * n[a] - 0.5 for a in range(3)], [float(hi_f[a]) * n[a] - 0.5 for a in range(3)]]
        return renderer.RenderState(
            inv_view_projection=inv, width=W, height=H, preset=preset,
            light=renderer.Light(tuple(light.get("direction", (0.4, 0.7, 0.6))), tuple(light.get("rgb", (3.2, 3.0, 2.8))), bool(light.get("camera_space", True))),
            clips=[tuple(float(x) for x in c) for c in view.get("clips", [])],
            crop=(tuple(crop[0]), tuple(crop[1])) if crop else None,
            boxes=self._boxes(view, L),
            label_colors=colors, keep_labels=keep, label_mix=mix,
            background=tuple(view.get("background", (0, 0, 0, 0))),
            # While the camera moves (frames below full size): fast tracking, with as many bounces as a still
            # view (at 2 the moving frames were 10-17 levels darker, a jump in colour each time the camera stopped).
            max_bounces=int(view.get("max_bounces", 4)),
            fast=1.0 if scale < 1 else 0.0,
            denoise=bool(view.get("denoise", True)),
            aperture=float(view.get("aperture", 0.0)), focus=float(view.get("focus", 0.0)),
            unit_mm=float(view.get("unit_mm", 1.0)),
        )

    def _place_objects(self, R, view: dict[str, Any] | None, wfp: np.ndarray) -> None:
        """The objects on the renderer as the view asks (shown or not, surfaces, the image within them, colours by id)."""
        from . import renderer

        if self.loaded_objects is None or R is None or not (view or {}).get("show", True):
            if R is not None and R.objects is not None:
                R.set_objects(None)
            return
        bvh, ob, ids = self.loaded_objects
        given = {str(k): v for k, v in (view.get("colors") or {}).items()}
        colours = np.array([[float(x) for x in given.get(str(i), (0.85, 0.6, 0.45))[:3]] for i in ids], np.float32)
        if R.objects is None or not np.array_equal(R.objects.colours, colours):
            R.set_objects(renderer.Objects(bvh, ob, colours, wfp))
        R.objects.world_from_physical = wfp
        R.set_object_look(float(view.get("surface", 0.3)), bool(view.get("image", True)), float(view.get("mix", 0.0)))

    # ---------------------------------------------------------------- the loop
    def _loop(self) -> None:
        try:
            failed = self._render()
        except Exception as e:  # noqa: BLE001 - never leaves the GPU held
            traceback.print_exc()
            failed = gpu_failure(e) or f"{type(e).__name__}: {e}"
        if failed is not None:
            # Out of memory, or the GPU in trouble: the page learns why from the session and its frame polls.
            self.status, self.error = "failed", failed
            with self.cond:
                self.closed = True
                self.cond.notify_all()
            self.renderer = None
        self._teardown()

    def _render(self) -> str | None:
        """Renders the views as they come until the session closes; on the GPU failing, what to tell the page."""
        R = self.renderer
        last_publish = 0.0
        batch = 1
        still_fast = False
        while not self.closed:
            with self.cond:
                while not self.closed and (self._unwatched() or (self._detail_pending is None and (
                        self.view is None or (self.applied_version == self.view_version and R.samples >= self.max_samples)))):
                    self.cond.wait(timeout=1.0)
                if self.closed:
                    return
                version, view = self.view_version, self.view
            try:
                swapped = self._take_detail(R)
                if swapped:
                    self.applied_version = -1  # the view starts again, with the detail
                if view is None:
                    continue
                if version != self.applied_version:
                    st = self._state(view)
                    R.set_view(st)
                    self.error = None
                    d = R.depth()
                    with self.cond:
                        self.depth = (version, d[..., 0], st.width, st.height, d[..., 1])
                    # Planned for a still view, and while moving (now and then: the read starts before the
                    # camera stops, from what the view is coming to).
                    if self.detail_loader is not None and (not st.fast or time.time() - self._last_plan > PLAN_MOVING_S):
                        self._plan_detail(R, st, d[..., 1], int(view["width"]), int(view["height"]))
                        self._last_plan = time.time()
                    self.applied_version = version
                    batch = 1
                    last_publish = 0.0
                    shown = self._shown
                    same_camera = shown is not None and np.allclose(shown[1], view["inv_view_projection"])
                    self._hold = None
                    if not st.fast and same_camera:
                        # The view the page shows already (the camera stopped, the look changed, finer detail
                        # came): no noisy first frames; the frame shown stays until the new image has a few
                        # samples (the page then fades it in).
                        if swapped:
                            self._hold = (max(1, min(shown[2], HOLD_SWAP[0])), time.time() + HOLD_SWAP[1])
                        else:
                            self._hold = (HOLD_STILL[0], time.time() + HOLD_STILL[1])
                    # (A still view of something else: its first pass is published at once, below.)
                    # A still view's first FAST_FIRST samples by fast tracking, then exact ones added to them:
                    # the image comes several times sooner, looks as the moving frames did, and goes over
                    # smoothly to exact tracking's (the fast samples' share of the mean shrinking).
                    still_fast = not st.fast
                    if still_fast:
                        R.set_fast(1.0)
                t = time.time()
                done = 0
                changed = lambda: self.view_version != version  # noqa: E731
                for _ in range(batch):
                    # A pass at a time, cut short when a new view comes (the camera moving).
                    R.step(1, stop=changed)
                    R.synchronize()
                    done += 1
                    if changed():
                        break
                    if still_fast and R.samples >= FAST_FIRST:
                        R.set_fast(0.0)
                        still_fast = False
                dt = (time.time() - t) / done
                self.passes_ms = dt * 1000
                # Batches of about 60 ms of work between frames published.
                batch = max(1, min(64, int(0.06 / max(dt, 1e-4))))
                if self.view_version != version:
                    continue
                n = R.samples
                if self._hold is not None:
                    if n < self._hold[0] and n < self.max_samples and time.time() < self._hold[1]:
                        continue
                    self._hold = None
                    last_publish = 0.0
                pow2 = n & (n - 1) == 0
                if pow2 or time.time() - last_publish > 0.25 or n >= self.max_samples:
                    self._publish(version, R, view)
                    last_publish = time.time()
            except Exception as e:  # noqa: BLE001
                if not isinstance(e, BadRequest):
                    traceback.print_exc()
                    failed = gpu_failure(e)
                    if failed is not None:
                        # Out of memory, or the GPU in trouble: not tried again pass after pass.
                        return failed
                # A view it cannot render: said to the page, and nothing more until the next view comes.
                self.error = str(e) if isinstance(e, BadRequest) else f"{type(e).__name__}: {e}"
                with self.cond:
                    self.applied_version = version
                    self.max_samples = 0
        return None

    def _publish(self, version: int, R=None, view: dict[str, Any] | None = None) -> None:
        from PIL import Image

        R = R if R is not None else self.renderer  # the loop's own (close() lets go of the session's)
        if R is None or self.closed:
            return
        b = io.BytesIO()
        if (self.view or {}).get("frame_format") == "jpeg":
            # Colour as a JPEG (divided by the alpha on the GPU), then the alpha plane deflated: several
            # times as quick to make as a WebP with alpha.
            rgb, alpha = R.image(premultiplied=False)
            Image.fromarray(rgb, "RGB").save(b, "JPEG", quality=88)
            offset = b.tell()
            b.write(zlib.compress(alpha.tobytes(), 1))
            kind, (h, w) = "image/jpeg", alpha.shape
        else:
            img = R.image()
            Image.fromarray(img, "RGBA").save(b, "WEBP", quality=88, method=0)
            offset, kind, (h, w) = 0, "image/webp", img.shape[:2]
        v = view if view is not None else self.view
        if v is not None:
            self._shown = (version, v["inv_view_projection"], R.samples)
        with self.cond:
            self.frame_number += 1
            self.frame = (self.frame_number, R.samples, version, b.getvalue(), w, h, kind, offset)
            self.cond.notify_all()

    def _unwatched(self) -> bool:
        """No page has waited for a frame for a while (called with the lock held)."""
        return self._watchers == 0 and time.time() - self._watched > UNWATCHED_SECONDS

    def wait_frame(self, after: int, timeout: float):
        end = time.time() + timeout
        with self.cond:
            self._watchers += 1
            self._watched = time.time()
            self.cond.notify_all()  # a session that had stopped for want of a page goes on
            try:
                while not self.closed and self.status != "failed" and (self.frame is None or self.frame[0] <= after):
                    left = end - time.time()
                    if left <= 0:
                        return None
                    self.cond.wait(timeout=left)
                self.last_used = time.time()
                return self.frame
            finally:
                self._watchers -= 1
                self._watched = time.time()

    def close(self) -> None:
        """Stops the session: a load stops reading (between blocks), the loop after its pass; whichever holds the
        GPU lets go of all of it as it ends (at once when neither runs)."""
        with self.cond:
            self.closed = True
            self.cond.notify_all()
        if self.detail_loader is not None:
            self.detail_loader.close()
        self.renderer = None
        w = self._worker
        if w is None or not w.is_alive() or w is threading.current_thread():
            self._teardown()

    def _teardown(self) -> None:
        """Lets go of everything the session holds on the GPU (its renderer, its share of the uploads, its part
        of the budget) and the finer detail it holds; once."""
        with self._teardown_lock:
            if self._torn:
                return
            self._torn = True
        if self.detail_loader is not None:
            self.detail_loader.close()
        R, self._R = self._R, None
        if R is not None and hasattr(R, "close"):
            R.close()
        with self.cond:
            self._detail_pending = None
            self.depth = None
            self._packed = {}
        self.detail_meta = None
        self._detail_affine = None
        self.gpu.textures.release(self.vol_share)
        self.gpu.textures.release(self.lab_share)
        self.vol_share = self.lab_share = None
        if self.reservation is not None:
            self.reservation.release()
        free_gpu_pool()

    def frame_bytes(self, width: int, height: int) -> None:
        """Counts a live view of `width` x `height` against the budget, when it is larger than what is counted
        (a 503 when it does not fit)."""
        from . import renderer as rmod

        if self.reservation is None:
            return
        shape = self.loaded.data.shape if self.loaded is not None else _cube(int(self.spec["volume"].get("budget") or 400_000_000))
        want = rmod.renderer_bytes(width, height, shape)
        have = self.need.get("frame", 0)
        if want > have:
            self.reservation.resize(self.reservation.bytes + want - have)
            self.need["frame"] = want

    def info(self) -> dict[str, Any]:
        R = self.renderer
        return {
            "id": self.id, "status": self.status, "progress": round(self.progress, 3), "message": self.message, "error": self.error,
            "volume": self.meta, "labels": self.label_meta, "objects": self.objects_meta, "samples": R.samples if R else 0, "ms_per_pass": round(self.passes_ms, 2),
            "view_version": self.view_version, "frame": self.frame[0] if self.frame else 0,
            "detail": {"held": self.detail_meta, "reading": self.detail_loader.status if self.detail_loader else None,
                       "levels": [lv.path for _, lv in self.detail_levels], "text": self.detail_text()},
        }


def flatten(img: np.ndarray, background: Any) -> np.ndarray:
    """An RGBA image (premultiplied) over a background colour (0..1): RGB."""
    bg = np.asarray(background, np.float32)[:3] * 255
    a = img[..., 3:4].astype(np.float32) / 255
    return np.clip(img[..., :3].astype(np.float32) + bg * (1 - a), 0, 255).astype(np.uint8)


def still_plan(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """A still's view at its size, and its samples, checked before anything is rendered (a 400 for what cannot be made)."""
    view = dict(body.get("view") or {})
    if "inv_view_projection" not in view:
        raise BadRequest("view.inv_view_projection is needed")
    w, h = (number(body.get(k, view.get(k, d)), k) for k, d in (("width", 1920), ("height", 1080)))
    if not (MIN_SIDE <= w <= MAX_SIDE and MIN_SIDE <= h <= MAX_SIDE):
        raise BadRequest(f"width and height must be {MIN_SIDE} to {MAX_SIDE}")
    w, h = int(w), int(h)
    samples = samples_of(body.get("samples"), 256)
    if w * h * samples > MAX_STILL_WORK:
        raise BadRequest(f"{w} x {h} at {samples} samples is more than one still may be: width x height x samples at most {MAX_STILL_WORK:.3g}")
    if (view.get("width"), view.get("height")) != (w, h) and view.get("width"):
        # The same camera at another shape: widen or narrow the view, not stretch it.
        from .movie import reshaped

        view["inv_view_projection"] = reshaped(view["inv_view_projection"], w / h, view.get("orbit_center"))
    view.update(width=w, height=h, scale=1.0)
    return view, samples


def movie_plan(spec: dict[str, Any], ffmpeg: str | None) -> dict[str, Any]:
    """A movie's settings checked before anything is rendered: its format, fps, samples, size (even for H.264),
    frames and quality, within the limits; a 400 for what cannot be made."""
    from .movie import keyframe_count, rotation_count

    fmt = str(spec.get("format", "mp4"))
    if fmt not in ("mp4", "png"):
        raise BadRequest("format: mp4 or png")
    if fmt == "mp4" and not ffmpeg:
        raise BadRequest("movies need ffmpeg on the render computer")
    fps = int(round(number(spec.get("fps", 25), "fps")))
    if not 1 <= fps <= MAX_FPS:
        raise BadRequest(f"fps must be 1 to {MAX_FPS}")
    samples = samples_of(spec.get("samples"), 256)
    w, h = (number(spec.get(k, d), k) for k, d in (("width", 1280), ("height", 720)))
    if not (MIN_SIDE <= w <= MAX_SIDE and MIN_SIDE <= h <= MAX_SIDE):
        raise BadRequest(f"width and height must be {MIN_SIDE} to {MAX_SIDE}")
    w, h = int(w), int(h)
    if fmt == "mp4":
        # H.264 (4:2:0) needs even sides: a pixel less here, not a failure once every frame is rendered.
        w, h = w - w % 2, h - h % 2
    keyframes = spec.get("keyframes")
    if not isinstance(keyframes, list) or not keyframes or not all(isinstance(k, dict) and isinstance(k.get("view"), dict) for k in keyframes):
        raise BadRequest("keyframes are needed: a list of {time, view}")
    r = spec.get("rotation")
    if r:
        if not isinstance(r, dict):
            raise BadRequest("rotation: {axis, degrees, step}")
        degrees, step = number(r.get("degrees", 360), "rotation.degrees"), number(r.get("step", 2), "rotation.step")
        if not (0 < degrees <= 360 and 0 < step <= 360):
            raise BadRequest("rotation: degrees and step must be above 0 and at most 360")
        frames = rotation_count(degrees, step)
    else:
        for k in keyframes:
            number(k.get("time", 0), "a keyframe's time")
        frames = keyframe_count(keyframes, fps)
    pixels = frames * w * h
    if frames > MAX_MOVIE_FRAMES or pixels > MAX_MOVIE_PIXELS or pixels * samples > MAX_MOVIE_WORK:
        raise BadRequest(f"{frames} frames of {w} x {h} at {samples} samples is more than one movie may be: at most {MAX_MOVIE_FRAMES} frames, "
                         f"{MAX_MOVIE_PIXELS:.3g} pixels and {MAX_MOVIE_WORK:.3g} pixel samples in all")
    crf = int(max(0, min(51, number(spec.get("crf", 18), "crf"))))
    return {"format": fmt, "fps": fps, "samples": samples, "width": w, "height": h, "frames": frames, "crf": crf}


def splat_plan(spec: dict[str, Any]) -> dict[str, Any]:
    """A splat's settings checked before anything is rendered: its views, their size and samples, and the fit's
    steps; a 400 for what cannot be made."""
    view = dict(spec.get("view") or {})
    if "inv_view_projection" not in view:
        raise BadRequest("view.inv_view_projection is needed")
    n = int(number(spec.get("views", 256), "views"))
    size = int(number(spec.get("size", 1024), "size"))
    samples = int(number(spec.get("samples", 512), "samples"))
    steps = int(number(spec.get("steps", 30000), "steps"))
    if not (8 <= n <= 4096 and 64 <= size <= 4096 and 1 <= samples <= 8192 and 0 <= steps <= 200000):
        raise BadRequest("views 8-4096, size 64-4096, samples 1-8192, steps 0-200000")
    # The images: the view's shape, `size` pixels along the longer side.
    aspect = float(view.get("width", 1)) / max(float(view.get("height", 1)), 1.0)
    width, height = (size, max(8, round(size / aspect))) if aspect >= 1 else (max(8, round(size * aspect)), size)
    return {"view": view, "views": n, "size": size, "samples": samples, "steps": steps, "width": width, "height": height,
            "points": int(number(spec.get("points", 300_000), "points"))}


# What a job is reckoned to write (bytes): a PNG of RGBA at most 4 bytes a pixel; a movie's frames (RGB PNGs of
# smooth renders) about a byte and a fifth a pixel, until the MP4 is made and they go; a splat's views, its points,
# and what the fit writes.
def still_disk(width: int, height: int) -> int:
    return width * height * 4 + (1 << 20)


def movie_disk(plan: dict[str, Any]) -> int:
    return int(plan["frames"] * plan["width"] * plan["height"] * 1.2) + (1 << 20)


def splat_disk(plan: dict[str, Any], fitting: bool) -> int:
    return plan["views"] * plan["width"] * plan["height"] * 2 + plan["points"] * 16 + ((1 << 30) if fitting else 0)


#: The GPU memory counted for a splat's fit (torch and gsplat, a process of its own): the Gaussians, their
#: optimiser's state and one view at a time.
SPLAT_FIT_BYTES = 4 << 30


class Job:
    """A still, movie or splat. It waits its turn in the service's queue (one runs at a time), then path-traces with
    a renderer of its own beside the live view. It draws on the session's upload of the volume through a share of
    its own, so the volume stays on the GPU for as long as the job needs it, whatever the session does; its own
    memory (its frame, and a copy of the finer detail the view held) is counted against the budget when it starts."""

    kind = "job"

    def __init__(self, jid: str, session: Session, out_dir: Path, width: int, height: int, detail: bool = False):
        from . import renderer as rmod

        self.id = jid
        self.session = session
        self.out_dir = out_dir
        self.status = "queued"
        self.progress = 0.0
        self.message = "waiting"
        self.error: str | None = None
        self.cancelled = False
        self.started = time.time()
        self.queue: JobQueue | None = None
        self.reservation = None
        self._R = None
        self._done = False
        self.gpu = session.gpu
        # The finer detail the view holds as the job is asked for: a still or splat is of the view in the page.
        held = session.renderer.detail if detail and session.renderer is not None else None
        self.detail = (held.data, session._detail_affine.copy()) if held is not None and session._detail_affine is not None else None
        shape = session.loaded.data.shape if session.loaded is not None else None
        self.gpu_need = rmod.renderer_bytes(width, height, shape)
        if self.detail is not None:
            self.gpu_need += rmod.volume_bytes(self.detail[0].shape, self.detail[0].dtype.itemsize)
        if session.loaded_objects is not None:
            # The objects' bricks and tables, uploaded again for the job's renderer (the BVH is shared).
            _, ob, _ = session.loaded_objects
            self.gpu_need += int(ob.atlas.nbytes + ob.top.nbytes + ob.sub.nbytes)
        if not self.gpu.budget.fits_ever(self.gpu_need):
            raise BadRequest(f"This {self.kind} needs about {gb(self.gpu_need)} of GPU memory, more than the render computer's "
                             f"budget of {gb(self.gpu.budget.total)}: make it smaller")
        self.vol_share = self.gpu.textures.ref(session.vol_share) if session.vol_share is not None else None
        self.lab_share = self.gpu.textures.ref(session.lab_share) if session.lab_share is not None else None

    # ------------------------------------------------------------ the GPU
    def renderer(self):
        """A renderer of the session's volume, beside the live view: the volume's upload shared, with the labels and
        the finer detail the view held."""
        from . import renderer as rmod

        S = self.session
        L = S.loaded
        R = rmod.Renderer(S.device)
        self._R = R
        R.set_volume(rmod.Volume(L.data, L.affine, L.lo, L.hi, L.percentiles, L.window, L.quantiles, L.medium), self.vol_share.upload if self.vol_share else None)
        LB = S.loaded_labels
        if LB is not None:
            R.set_labels(rmod.Labels(LB.data, LB.affine), self.lab_share.upload if self.lab_share else None)
        if self.detail is not None:
            R.set_detail(rmod.Detail(self.detail[0], self.detail[1].copy()))
        return R

    def state(self, view: dict[str, Any], R):
        return self.session._state(view, R, self.detail[1] if self.detail is not None else None)

    def close_renderer(self) -> None:
        R, self._R = self._R, None
        if R is not None:
            R.close()
        free_gpu_pool()

    def reserve(self, nbytes: int, what: str) -> None:
        """Counts `nbytes` against the budget for the job (in place of what it held), waiting while sessions hold it,
        up to JOB_GPU_WAIT s."""
        end = time.time() + JOB_GPU_WAIT
        while True:
            try:
                if self.reservation is None:
                    self.reservation = self.gpu.budget.reserve(nbytes, what)
                else:
                    self.reservation.resize(nbytes)
                return
            except Refused as e:
                if self.cancelled:
                    raise RuntimeError("cancelled") from None
                if time.time() > end:
                    raise RuntimeError(str(e)) from None
                self.message = f"waiting for GPU memory ({e.detail['need_mb']} MB; {e.detail['free_mb']} MB of the budget free)"
                time.sleep(0.5)

    # ------------------------------------------------------------ the run
    def run(self) -> None:
        """Runs the job (the queue calls this when its turn comes), and lets go of all it holds however it ends."""
        try:
            if self.cancelled:
                raise RuntimeError("cancelled")
            self.status = "running"
            self.message = "starting"
            self.started = time.time()
            self.reserve(self.gpu_need, f"a {self.kind}")
            self._run()
        except Exception as e:  # noqa: BLE001 - reported in the job's status
            self.status = "cancelled" if self.cancelled else "failed"
            self.error = gpu_failure(e) or f"{type(e).__name__}: {e}"
            if not self.cancelled:
                traceback.print_exc()
        finally:
            self.finish()

    def _run(self) -> None:
        raise NotImplementedError

    def finish(self) -> None:
        """Lets go of the renderer, the budget and the shares; once."""
        if self._done:
            return
        self._done = True
        try:
            self.close_renderer()
        except Exception:  # noqa: BLE001 - a GPU in trouble: what can be let go of still is
            traceback.print_exc()
        if self.reservation is not None:
            self.reservation.release()
        self.gpu.textures.release(self.vol_share)
        self.gpu.textures.release(self.lab_share)
        self.vol_share = self.lab_share = None
        self.detail = None
        self.session = None  # a finished job does not keep the session (and its volume) alive
        free_gpu_pool()

    def cancel(self) -> None:
        """Stops the job: at once when it waits its turn, else between passes."""
        self.cancelled = True
        if self.queue is not None and self.queue.remove(self):
            self.status, self.message, self.error = "cancelled", "cancelled before it started", "cancelled"
            self.finish()

    def info(self) -> dict[str, Any]:
        """Its state; while it waits, where it is in the queue: `queue_position` (1: next to start) and `jobs_ahead`
        (those waiting before it and the one running)."""
        pos, ahead = self.queue.place(self) if self.queue is not None and self.status == "queued" else (0, 0)
        message = self.message
        if pos:
            message = f"waiting for {ahead} job{'' if ahead == 1 else 's'} ahead" if ahead else "starting soon"
        return {"id": self.id, "kind": self.kind, "status": self.status, "progress": round(self.progress, 3), "message": message,
                "error": self.error, "queue_position": pos, "jobs_ahead": ahead}


class JobQueue:
    """The service's stills, movies and splats, run one at a time in the order they were asked for."""

    def __init__(self, max_waiting: int = MAX_WAITING_JOBS):
        self.max_waiting = max_waiting
        self._waiting: list[Job] = []
        self.running: Job | None = None
        self._cond = threading.Condition()
        threading.Thread(target=self._work, daemon=True).start()

    def submit(self, job: Job) -> None:
        """Queues a job, or refuses (429) when MAX_WAITING_JOBS wait already."""
        with self._cond:
            n = len(self._waiting)
            if n >= self.max_waiting:
                raise Refused(f"The render computer has {n} stills, movies or splats waiting already: try again when one has finished.",
                              429, RETRY_AFTER, reason="queue-full", waiting=n)
            job.queue = self
            self._waiting.append(job)
            self._cond.notify_all()

    def place(self, job: Job) -> tuple[int, int]:
        """(its position, 1 for next; the jobs ahead of it, the one running included), or (0, 0) when not waiting."""
        with self._cond:
            if job not in self._waiting:
                return 0, 0
            i = self._waiting.index(job)
            return i + 1, i + (1 if self.running is not None else 0)

    def remove(self, job: Job) -> bool:
        """Takes a job out of the queue before it starts: whether it was waiting."""
        with self._cond:
            if job in self._waiting:
                self._waiting.remove(job)
                return True
            return False

    def _work(self) -> None:
        while True:
            with self._cond:
                while not self._waiting:
                    self._cond.wait()
                job = self._waiting.pop(0)
                self.running = job
            try:
                job.run()
            except Exception:  # noqa: BLE001 - run() reports its own; the queue goes on
                traceback.print_exc()
            finally:
                with self._cond:
                    self.running = None

    def info(self) -> dict[str, Any]:
        with self._cond:
            r = self.running
            return {"running": {"kind": r.kind, "id": r.id} if r is not None else None,
                    "waiting": [{"kind": j.kind, "id": j.id} for j in self._waiting], "max_waiting": self.max_waiting}


class Still(Job):
    """One view path-traced to a sample count at a size, saved as a PNG: a job beside the live view, as movies
    are (inside its request it held the connection for as long as it rendered, with no way to stop it)."""

    kind = "still"

    def __init__(self, jid: str, session: Session, view: dict[str, Any], samples: int, spec: dict[str, Any], out_dir: Path):
        self.view = view
        self.samples = samples
        self.spec = spec
        self.file: Path | None = None
        super().__init__(jid, session, out_dir, view["width"], view["height"], detail=True)

    def _run(self) -> None:
        from PIL import Image

        if self.session.loaded is None:
            raise RuntimeError("the session's volume is not loaded")
        # The still is of the view in the page: the finer detail held for it too.
        R = self.renderer()
        R.set_view(self.state(self.view, R))
        n = self.samples
        while R.samples < n:
            if self.cancelled:
                raise RuntimeError("cancelled")
            R.step_beside(min(8, n - R.samples), lambda: self.cancelled)
            self.progress = 0.95 * R.samples / n
            self.message = f"{R.samples} of {n} samples"
        img = R.image()
        self.close_renderer()
        bg = self.spec.get("background")
        pic = Image.fromarray(flatten(img, bg)) if bg is not None else Image.fromarray(img, "RGBA")
        self.out_dir.mkdir(parents=True)
        out = self.out_dir / f"{safe_name(self.spec.get('name'), 'still')}.png"
        pic.save(out, "PNG")
        self.file = out
        self.progress = 1.0
        self.status = "done"
        self.message = f"{self.view['width']} x {self.view['height']} at {n} samples in {time.time() - self.started:.0f} s"

    def info(self) -> dict[str, Any]:
        return {**super().info(), "file": str(self.file) if self.file else None}


class Movie(Job):
    """A movie made from keyframes: frames path-traced to a sample count, then encoded with ffmpeg (the frames
    deleted once the MP4 is made)."""

    kind = "movie"

    def __init__(self, mid: str, session: Session, spec: dict[str, Any], plan: dict[str, Any], out_dir: Path, ffmpeg: str | None = None):
        self.spec = spec
        self.plan = plan
        self.ffmpeg = ffmpeg
        self.file: Path | None = None
        self.proc: subprocess.Popen | None = None
        super().__init__(mid, session, out_dir, plan["width"], plan["height"])

    def _run(self) -> None:
        from PIL import Image

        from .movie import frames_for, rotation_frames

        S = self.session
        if S.loaded is None:
            raise RuntimeError("the session's volume is not loaded")
        sp, pl = self.spec, self.plan
        width, height, samples = pl["width"], pl["height"], pl["samples"]
        mp4 = pl["format"] == "mp4"
        if sp.get("rotation"):
            r = sp["rotation"]
            views = rotation_frames(sp["keyframes"][0]["view"], r.get("axis", "vertical"), float(r.get("degrees", 360)), float(r.get("step", 2)), aspect=width / height)
        else:
            views = frames_for(sp["keyframes"], pl["fps"], sp.get("easing", "smooth"), aspect=width / height)
        # A renderer of its own, so the interactive view goes on.
        R = self.renderer()
        frames = self.out_dir / "frames"
        frames.mkdir(parents=True)  # the job's own folder: nothing of another's is overwritten
        background = sp.get("background", (0.08, 0.08, 0.09))
        for i, view in enumerate(views):
            if self.cancelled:
                raise RuntimeError("cancelled")
            view = dict(view)
            view["width"], view["height"], view["scale"] = width, height, 1.0
            R.set_view(self.state(view, R))
            R.step_beside(samples, lambda: self.cancelled)
            Image.fromarray(flatten(R.image(), background)).save(frames / f"{i:05d}.png")
            self.progress = (i + 1) / len(views) * (0.97 if mp4 else 1.0)
            self.message = f"frame {i + 1} of {len(views)}"
        self.close_renderer()
        if mp4:
            self.message = "encoding"
            self.file = self._encode(frames)
            # The MP4 is the movie: its frames would take many times its room.
            shutil.rmtree(frames, ignore_errors=True)
        else:
            self.file = frames
        self.progress = 1.0
        self.status = "done"
        self.message = f"{len(views)} frames of {width} x {height} in {time.time() - self.started:.0f} s"

    def _encode(self, frames: Path) -> Path:
        """The frames as an MP4 (H.264); ffmpeg's own words when it fails."""
        pl = self.plan
        out = self.out_dir / f"{safe_name(self.spec.get('name'))}.mp4"
        cmd = [self.ffmpeg or "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(pl["fps"]), "-i", str(frames / "%05d.png"),
               "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(pl["crf"]), str(out)]
        if self.cancelled:
            raise RuntimeError("cancelled")
        self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                                     preexec_fn=_die_with_parent)
        try:
            _, err = self.proc.communicate(timeout=3600)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.communicate()
            raise RuntimeError("ffmpeg took more than an hour") from None
        if self.cancelled:
            raise RuntimeError("cancelled")
        if self.proc.returncode != 0:
            raise RuntimeError(f"ffmpeg ended with {self.proc.returncode}: {err.strip()[-800:] or 'no message'}")
        return out

    def cancel(self) -> None:
        """Stops between frames, or stops ffmpeg when it is encoding (at once when it waits its turn)."""
        self.cancelled = True
        if getattr(self, "proc", None) is not None and self.proc.poll() is None:
            self.proc.terminate()
        if getattr(self, "queue", None) is not None:
            super().cancel()

    def info(self) -> dict[str, Any]:
        return {**super().info(), "file": str(self.file) if self.file else None,
                "width": self.plan["width"], "height": self.plan["height"], "frames": self.plan["frames"]}


def _die_with_parent() -> None:
    """In a child process (ffmpeg, the splat fit): ends when the render service ends, however it ends (Linux)."""
    try:
        import ctypes
        import signal

        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:  # noqa: BLE001 - elsewhere: the child is left to finish on its own
        pass


PROGRESS = re.compile(r"^\[progress\]\s+([0-9.]+)\s*(.*)$")
#: The files of a finished splat the page may fetch, and their types.
SPLAT_FILES = {"scene.splat": "application/octet-stream", "splat.ply": "application/octet-stream", "cameras.json": "application/json", "fit.json": "application/json"}


class Splat(Job):
    """Gaussian splats of the view: path-traced views from all round it (splat/views.py), then fitted to them
    (splat/fit.py) by the splat Python, a process of its own on the service's GPU; with `steps` 0, or no splat
    Python, only the views."""

    kind = "splat"

    def __init__(self, sid: str, session: Session, spec: dict[str, Any], out_dir: Path, python: str | None, plan: dict[str, Any] | None = None):
        self.spec = spec
        self.plan = plan if plan is not None else splat_plan(spec)
        self.python = python
        self.result: dict[str, Any] | None = None
        self.proc: subprocess.Popen | None = None
        super().__init__(sid, session, out_dir, self.plan["width"], self.plan["height"], detail=True)

    def _run(self) -> None:
        from PIL import Image

        from .splat import views as V

        S = self.session
        if S.loaded is None:
            raise RuntimeError("the session's volume is not loaded")
        sp, pl = self.spec, self.plan
        view = pl["view"]
        n, samples, steps, width, height = pl["views"], pl["samples"], pl["steps"], pl["width"], pl["height"]
        fitting = steps > 0 and self.python is not None
        share = 0.5 if fitting else 1.0
        cams, near, far, centre = V.capture_cameras(view, n, float(sp.get("cover", 180)), float(sp.get("closer", 0.25)))
        light = V.world_light(view)
        # A renderer of its own, so the interactive view goes on; the finer detail held for the view too.
        R = self.renderer()
        images = self.out_dir / "images"
        images.mkdir(parents=True)  # the job's own folder: nothing of another's is overwritten
        rng = np.random.default_rng(0)
        per_view = max(1, pl["points"] // n)
        records, xyz, rgbs = [], [], []
        for i, cam in enumerate(cams):
            if self.cancelled:
                raise RuntimeError("cancelled")
            v = V.capture_view(view, cam, width, height, near, far, light)
            R.set_view(self.state(v, R))
            R.step_beside(samples, lambda: self.cancelled)
            rgb, alpha = R.image(premultiplied=False)
            name = f"images/{i:05d}.png"
            Image.fromarray(np.dstack([rgb, alpha]), "RGBA").save(self.out_dir / name)
            p, c = V.seed_points(v["inv_view_projection"], R.depth()[..., 1], rgb, alpha, per_view, rng)
            xyz.append(p)
            rgbs.append(c)
            records.append(V.camera_record(name, cam, width, height))
            self.progress = share * (i + 1) / len(cams)
            left = (time.time() - self.started) / (i + 1) * (len(cams) - i - 1)
            self.message = f"view {i + 1} of {len(cams)} (about {left / 60:.0f} min more)"
        self.close_renderer()
        V.write_points(self.out_dir / "points.ply", np.concatenate(xyz), np.concatenate(rgbs))
        V.write_cameras(self.out_dir, records, centre, {"view": {k: view[k] for k in ("preset", "overrides", "environment", "clips", "boxes", "crop_fraction") if k in view}, "light": light, "samples": samples})
        if fitting:
            # The fit runs on the same GPU in a process of its own: counted in place of the views' renderer.
            self.reserve(SPLAT_FIT_BYTES, "a splat's fit")
            self._fit(steps, int(sp.get("sh", 3)), share)
        self.progress = 1.0
        self.status = "done"
        took = f"{(time.time() - self.started) / 60:.0f} min"
        if fitting:
            r = self.result or {}
            self.message = f"{r.get('gaussians', '?')} Gaussians from {len(cams)} views in {took}" + (f", held-out PSNR {r['psnr_held_out']} dB" if r.get("psnr_held_out") else "")
        else:
            why = "no splat Python on this computer (start the render service with --splat-python)" if steps > 0 else "fitting not asked for"
            self.message = f"{len(cams)} views in {took}; not fitted: {why}. Fit later: python -m ngplatform_render.splat.fit {self.out_dir}"

    def _fit(self, steps: int, sh: int, share: float) -> None:
        env = dict(os.environ)
        here = str(Path(__file__).resolve().parent.parent)
        env["PYTHONPATH"] = here + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        env["PATH"] = splat_path(self.python, env.get("PATH", ""))
        device = self.session.device if self.session is not None else 0
        cmd = [self.python, "-m", "ngplatform_render.splat.fit", str(self.out_dir), "--steps", str(steps), "--sh", str(max(0, min(3, sh))),
               "--device", f"cuda:{device}"]
        self.message = "fitting"
        tail: list[str] = []
        with open(self.out_dir / "fit.log", "w") as log:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env, bufsize=1,
                                         preexec_fn=_die_with_parent)
            assert self.proc.stdout is not None
            for line in self.proc.stdout:
                log.write(line)
                tail = (tail + [line.rstrip()])[-20:]
                found = PROGRESS.match(line.strip())
                if found is not None:
                    self.progress = share + (1 - share) * min(1.0, max(0.0, float(found.group(1))))
                    self.message = f"fitting: {found.group(2).strip()}"
                if self.cancelled:
                    self.proc.terminate()
            code = self.proc.wait()
        if self.cancelled:
            raise RuntimeError("cancelled")
        if code != 0:
            raise RuntimeError(f"the fit ended with {code}: " + " / ".join(tail[-4:]))
        self.result = json.loads((self.out_dir / "fit.json").read_text())

    def cancel(self) -> None:
        self.cancelled = True
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
        super().cancel()

    def info(self) -> dict[str, Any]:
        files = [f for f in SPLAT_FILES if (self.out_dir / f).is_file()] if self.status == "done" else []
        return {**super().info(), "folder": str(self.out_dir), "files": files, "result": self.result}


def splat_path(python: str, path: str) -> str:
    """The PATH for the splat Python: its own folder first. gsplat builds its CUDA kernels the first time it runs,
    with the ninja installed beside that Python (in a venv, not on the service's PATH) and nvcc (CUDA_HOME, or the
    PATH)."""
    own = str(Path(python).parent)
    return path if own in path.split(os.pathsep) else own + (os.pathsep + path if path else "")


def splat_python_check(python: str | None) -> dict[str, Any]:
    """Whether `python` can fit splats (torch with CUDA, and gsplat), and whether its gsplat is the version the fit
    is written for (splat.fit.GSPLAT_VERSION; another may work, and is said)."""
    from .splat.fit import GSPLAT_VERSION

    if not python:
        return {"python": None, "ready": False, "pinned": GSPLAT_VERSION,
                "error": "no splat Python (start the render service with --splat-python, or set NGP_SPLAT_PYTHON)"}
    try:
        r = subprocess.run([python, "-c", "import torch, gsplat; assert torch.cuda.is_available(), 'torch sees no GPU'; print(gsplat.__version__)"],
                           capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"python": python, "ready": False, "error": f"{type(e).__name__}: {e}"}
    if r.returncode != 0:
        return {"python": python, "ready": False, "error": (r.stderr.strip().splitlines() or ["failed"])[-1]}
    version = r.stdout.strip()
    out = {"python": python, "ready": True, "gsplat": version, "pinned": GSPLAT_VERSION}
    if version != GSPLAT_VERSION:
        out["warning"] = f"gsplat {version}: the fit is written for {GSPLAT_VERSION} (pip install gsplat=={GSPLAT_VERSION})"
    return out


class RenderServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port: int, token: str | None, roots: list[Path], device: int, out_root: Path, splat_python: str | None = None,
                 sources: list[str] | None = None, ffmpeg: str | None = None, gpu_budget: int | None = None,
                 max_waiting: int = MAX_WAITING_JOBS):
        super().__init__(("127.0.0.1", port), Handler)
        from .volumes import http_url

        # One GPU budget for every session and job (by default a part of the memory free now), the uploads they
        # share, and the queue the jobs run from one at a time.
        self.gpu_share = Gpu(device, gpu_budget)
        self.queue = JobQueue(max_waiting)
        self.token = token
        self.roots = roots
        self.device = device
        self.out_root = out_root
        # Remote stores (http(s), gs://, s3://) are read only from under these, when any are given.
        self.sources = [http_url(u) for u in (sources or []) if u.strip()]
        # Found now, not once a movie's every frame is rendered.
        self.ffmpeg = ffmpeg if ffmpeg is not None else shutil.which("ffmpeg")
        self.sessions: dict[str, Session] = {}
        self.movies: dict[str, Movie] = {}
        self.stills: dict[str, Still] = {}
        self.splats: dict[str, Splat] = {}
        self.splat_python = splat_python
        self.splat_check: dict[str, Any] = {"python": splat_python, "ready": False, "error": "checking"}
        self.lock = threading.Lock()

        def check() -> None:
            self.splat_check = splat_python_check(splat_python)

        threading.Thread(target=check, daemon=True).start()
        threading.Thread(target=self._reaper, daemon=True).start()

    def _reaper(self) -> None:
        while True:
            time.sleep(REAP_EVERY)
            self.reap()

    def reap(self, now: float | None = None) -> list[str]:
        """Closes the sessions nothing has asked about for IDLE_SECONDS; their ids."""
        now = time.time() if now is None else now
        with self.lock:
            idle = [self.sessions.pop(sid) for sid, s in list(self.sessions.items()) if now - s.last_used > IDLE_SECONDS]
        for s in idle:
            self.close_session(s)
        return [s.id for s in idle]

    def close_session(self, s: Session) -> None:
        """Closes a session (taken out of the table already), and lets go of the store's arrays when no other
        session shows it."""
        from . import detail

        s.close()
        url = (s.spec.get("volume") or {}).get("url")
        with self.lock:
            others = any((o.spec.get("volume") or {}).get("url") == url for o in self.sessions.values())
        if url and not others:
            detail.forget(url)

    def check_disk(self, folder: Path, need: int, what: str) -> None:
        """Refuses (507) a job that would leave less than DISK_MARGIN free where it writes."""
        p = folder
        while not p.exists() and p != p.parent:
            p = p.parent
        free = shutil.disk_usage(p).free
        if free < need + DISK_MARGIN:
            raise Refused(f"Too little disk on the render computer: {gb(free)} free in {p}, and this {what} needs about {gb(need)} "
                          f"with {gb(DISK_MARGIN)} kept spare. Free some space or choose another output folder.",
                          507, None, reason="disk", need_mb=need >> 20, free_mb=free >> 20)

    def submit(self, table: dict[str, Any], job: Job) -> None:
        """Queues a job and lists it; a job the queue refuses lets go of what it holds."""
        try:
            self.queue.submit(job)
        except Refused:
            job.finish()
            raise
        self.keep(table, job.id, job)

    def keep(self, table: dict[str, Any], jid: str, job: Any) -> None:
        """Lists a job, letting go of all but the last KEEP_FINISHED finished ones (under the lock: requests run in threads)."""
        with self.lock:
            table[jid] = job
            done = [k for k, v in table.items() if v.status in FINISHED]
            for k in done[:-KEEP_FINISHED]:
                del table[k]

    @staticmethod
    def disk_free(folder: Path) -> int:
        p = folder
        while not p.exists() and p != p.parent:
            p = p.parent
        return shutil.disk_usage(p).free

    def gpu(self) -> dict[str, Any]:
        try:
            import cupy

            with cupy.cuda.Device(self.device):
                p = cupy.cuda.runtime.getDeviceProperties(self.device)
                free, total = cupy.cuda.runtime.memGetInfo()
            return {"backend": "cuda", "name": p["name"].decode() if isinstance(p["name"], bytes) else p["name"], "free_mb": free >> 20, "total_mb": total >> 20}
        except Exception as e:  # noqa: BLE001
            return {"backend": "none", "error": f"{type(e).__name__}: {e}"}

    def check_source(self, url: str) -> None:
        """Stores on this computer are read only under the runner's folders; http(s), gs:// and s3:// stores as given,
        or only from under the allowed sources when there are any."""
        from .volumes import http_url

        u = http_url(url)
        if u.startswith(("http://", "https://")):
            if self.sources and not any(u == a or u.startswith(a + "/") for a in self.sources):
                raise BadRequest("this render service reads remote stores only from its allowed sources")
            return
        p = Path(u.removeprefix("file://")).expanduser().resolve()
        if not any(p == r or r in p.parents for r in self.roots):
            raise BadRequest("a store on this computer must be under one of the runner's folders")

    def output_dir(self, requested: str | None, name: str) -> Path:
        """A job's own new folder, `name` (its kind and id), in the folder asked for or the output root: a job never
        writes over files already there."""
        base = self.out_root
        if requested:
            base = Path(requested).expanduser().resolve()
            if not any(base == r or r in base.parents for r in self.roots):
                raise BadRequest("the output folder must be under one of the runner's folders")
        return base / name


class Handler(BaseHTTPRequestHandler):
    server: RenderServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet: the runner keeps the service's log
        if os.environ.get("NGP_RENDER_VERBOSE"):
            super().log_message(fmt, *args)

    def _send(self, code: int, body: bytes, ctype: str = "application/json", headers: dict[str, str] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        origin = self.headers.get("Origin") or ""
        if _LOCAL_ORIGIN.match(origin):
            # Straight from a page on this computer (without the runner, which adds its own).
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", ", ".join(k for k in (headers or {}) if k.startswith("X-")))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj: Any, headers: dict[str, str] | None = None) -> None:
        self._send(code, json.dumps(obj).encode(), headers=headers)

    def _file(self, path: Path, ctype: str, filename: str) -> None:
        """A file streamed (never read whole), with byte ranges (Range: bytes=a-b, a-, -n) for resuming a download."""
        size = path.stat().st_size
        start, end = 0, size  # end exclusive
        code = 200
        extra = {"Accept-Ranges": "bytes", "Content-Disposition": f'attachment; filename="{filename}"'}
        rng = (self.headers.get("Range") or "").strip()
        if rng:
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng)
            if m is None or (not m.group(1) and not m.group(2)):
                self._send(416, b"", "text/plain", {"Content-Range": f"bytes */{size}"})
                return
            if m.group(1):
                start = int(m.group(1))
                end = min(size, int(m.group(2)) + 1) if m.group(2) else size
            else:
                start = max(0, size - int(m.group(2)))
            if start >= size or end <= start:
                self._send(416, b"", "text/plain", {"Content-Range": f"bytes */{size}"})
                return
            code = 206
            extra["Content-Range"] = f"bytes {start}-{end - 1}/{size}"
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start))
        self.send_header("Cache-Control", "no-store")
        for k, v in extra.items():
            self.send_header(k, v)
        origin = self.headers.get("Origin") or ""
        if _LOCAL_ORIGIN.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start
            while left > 0:
                chunk = f.read(min(FILE_CHUNK, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def _body(self) -> dict[str, Any]:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise BadRequest("body too large")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError as e:
            raise BadRequest(f"bad JSON: {e}") from e

    def _authorised(self) -> bool:
        tok = self.server.token
        if not tok:
            return True
        got = self.headers.get("X-NGP-Service-Token") or ""
        auth = self.headers.get("Authorization") or ""
        if auth.startswith("Bearer "):
            got = got or auth[7:]
        return secrets.compare_digest(got, tok)

    def _route(self, method: str) -> None:
        if not self._authorised():
            self._json(401, {"error": "token"})
            return
        path, _, query = self.path.partition("?")
        q = dict(parse_qsl(query, keep_blank_values=True))
        parts = [unquote(p) for p in path.split("/") if p]
        S = self.server
        try:
            if method == "GET" and parts in ([], ["info"]):
                from .volumes import cache_info

                self._json(200, {"service": "render", "version": __version__, "gpu": S.gpu(), "presets": list(builtin()), "lightmaps": lightmap_names(), "splats": S.splat_check,
                                 "ffmpeg": S.ffmpeg is not None, "budget": S.gpu_share.info(), "queue": S.queue.info(),
                                 "disk": {"output": str(S.out_root), "free_mb": S.disk_free(S.out_root) >> 20}, "cache": cache_info()})
            elif method == "GET" and parts == ["presets"]:
                self._json(200, [p.to_dict() for p in builtin().values()])
            elif method == "POST" and parts == ["sessions"]:
                spec = self._body()
                if not (spec.get("volume") or {}).get("url"):
                    raise BadRequest("volume.url is needed")
                for part in ("volume", "labels", "objects"):
                    if (spec.get(part) or {}).get("url"):
                        S.check_source(spec[part]["url"])
                if spec.get("objects"):
                    spec["objects"] = objects_spec(spec["objects"])
                for k in ("channel", "time"):
                    spec["volume"][k] = index_of(spec["volume"].get(k), k)
                # Let in only when what it will hold fits the GPU budget beside the other sessions and jobs: a 503 that
                # says why otherwise (the page shows it, with Retry).
                need = session_need(spec, S.gpu_share)
                name = (spec["volume"]["url"].rstrip("/").split("/")[-1] or "this image")[:60]
                res = S.gpu_share.budget.reserve(sum(need.values()), f"a view of {name}")
                sid = uuid.uuid4().hex[:12]
                with S.lock:
                    s = Session(sid, spec, S.device, S.gpu_share, res, need)
                    S.sessions[sid] = s
                self._json(200, s.info())
            elif len(parts) >= 2 and parts[0] == "sessions":
                s = S.sessions.get(parts[1])
                if s is None:
                    self._json(404, {"error": "no such session"})
                    return
                s.last_used = time.time()
                rest = parts[2:]
                if method == "GET" and rest == []:
                    self._json(200, s.info())
                elif method == "DELETE" and rest == []:
                    with S.lock:
                        S.sessions.pop(s.id, None)
                    S.close_session(s)
                    self._json(200, {"closed": s.id})
                elif method in ("PUT", "POST") and rest == ["view"]:
                    view = self._body()
                    for k in ("inv_view_projection", "width", "height"):
                        if k not in view:
                            raise BadRequest(f"view.{k} is needed")
                    # Within the limits a still has, so one view cannot ask for more than the GPU holds.
                    view["width"], view["height"] = side(view["width"], "width"), side(view["height"], "height")
                    view["max_samples"] = samples_of(view.get("max_samples") or None, 1024)
                    # A view larger than the session's frame so far: counted against the budget first (a 503 if it does not fit).
                    s.frame_bytes(view["width"], view["height"])
                    self._json(200, {"version": s.set_view(view)})
                elif method == "GET" and rest == ["frame"]:
                    after = int(number(q.get("after", "0"), "after"))
                    timeout = max(0.0, min(60.0, number(q.get("timeout", "25"), "timeout")))
                    f = None if s.status == "failed" else s.wait_frame(after, timeout)
                    if s.status == "failed":
                        # Gone for good (out of GPU memory): the page stops asking and says why.
                        self._json(410, {"error": s.error or "the session failed", "status": "failed"})
                        return
                    if f is None:
                        self._send(204, b"", headers={"X-Status": s.status, "X-Error": (s.error or "")[:200]})
                        return
                    n, samples, version, data, w, h, kind, offset = f
                    extra = {"X-Alpha-Offset": str(offset)} if offset else {}
                    if s.detail_loader is not None:
                        extra["X-Detail"] = s.detail_text()
                    if q.get("have") is not None and int(number(q["have"], "have")) != version:
                        # The frame's points (each pixel's distance), for a page that has none for this view yet:
                        # in the same answer, so a moving view is one request a frame, not three.
                        pk = s.packed(version, "distance16")
                        if pk is not None:
                            extra["X-Distance-Offset"] = str(len(data))
                            extra.update(pk[1])
                            data = data + pk[0]
                    self._send(200, data, kind, {"X-Frame": str(n), "X-Samples": str(samples), "X-Version": str(version),
                                                 "X-Width": str(w), "X-Height": str(h), "X-Ms-Per-Pass": f"{s.passes_ms:.1f}", **extra})
                elif method == "POST" and rest == ["resolve"]:
                    # A preset (a name, or one given whole, with overrides) at this image's data values: for the editor.
                    if s.status != "ready":
                        raise BadRequest("the session's volume is not loaded")
                    body = self._body()
                    pr = body.get("preset") or "HiP-CT brain"
                    if isinstance(pr, str):
                        if pr not in builtin():
                            raise BadRequest(f"no preset {pr!r}")
                        p = builtin()[pr]
                    else:
                        p = Preset.from_dict(pr)
                    if body.get("overrides"):
                        p = p.with_overrides(**body["overrides"])
                    from . import renderer as rmod

                    L = s.loaded
                    vol = rmod.Volume(L.data[:1, :1, :1], L.affine, L.lo, L.hi, L.percentiles, L.window, L.quantiles, L.medium)
                    self._json(200, presets_mod.resolved(p, vol).to_dict())
                elif method == "GET" and rest == ["depth"]:
                    d = s.depth
                    pk = s.packed(d[0], "distance" if q.get("channel") == "distance" else "depth") if d is not None else None
                    if pk is None:
                        self._send(204, b"")
                        return
                    self._send(200, pk[0], "application/octet-stream", {"X-Version": str(d[0]), **pk[1]})
                elif method == "POST" and rest == ["stills"]:
                    # One view path-traced to a sample count at a size, as a PNG: a job (GET /stills/<id>).
                    if s.status != "ready":
                        raise BadRequest("the session's volume is not loaded")
                    body = self._body()
                    view, samples = still_plan(body)
                    jid = uuid.uuid4().hex[:12]
                    out = S.output_dir(body.get("output"), f"still-{jid}")
                    S.check_disk(out, still_disk(view["width"], view["height"]), "still")
                    j = Still(jid, s, view, samples, body, out)
                    S.submit(S.stills, j)
                    self._json(200, j.info())
                elif method == "POST" and rest == ["movies"]:
                    if s.status != "ready":
                        raise BadRequest("the session's volume is not loaded")
                    spec = self._body()
                    plan = movie_plan(spec, S.ffmpeg)
                    mid = uuid.uuid4().hex[:12]
                    out = S.output_dir(spec.get("output"), f"movie-{mid}")
                    S.check_disk(out, movie_disk(plan), "movie")
                    m = Movie(mid, s, spec, plan, out, S.ffmpeg)
                    S.submit(S.movies, m)
                    self._json(200, m.info())
                elif method == "POST" and rest == ["splats"]:
                    if s.status != "ready":
                        raise BadRequest("the session's volume is not loaded")
                    spec = self._body()
                    plan = splat_plan(spec)
                    pid = uuid.uuid4().hex[:12]
                    out = S.output_dir(spec.get("output"), f"splat-{pid}")
                    python = S.splat_python if S.splat_check.get("ready") else None
                    S.check_disk(out, splat_disk(plan, plan["steps"] > 0 and python is not None), "splat")
                    j = Splat(pid, s, spec, out, python, plan)
                    S.submit(S.splats, j)
                    self._json(200, j.info())
                else:
                    self._json(404, {"error": "not found"})
            elif len(parts) >= 2 and parts[0] == "splats":
                j = S.splats.get(parts[1])
                if j is None:
                    self._json(404, {"error": "no such splat"})
                elif method == "GET" and parts[2:] == []:
                    if j.session is not None:
                        j.session.last_used = time.time()  # a session making a splat is not idle
                    self._json(200, j.info())
                elif method == "DELETE" and parts[2:] == []:
                    j.cancel()
                    self._json(200, j.info())
                elif method == "GET" and len(parts) == 4 and parts[2] == "file" and parts[3] in SPLAT_FILES and j.status == "done" and (j.out_dir / parts[3]).is_file():
                    self._file(j.out_dir / parts[3], SPLAT_FILES[parts[3]], parts[3])
                else:
                    self._json(404, {"error": "not found"})
            elif len(parts) >= 2 and parts[0] == "movies":
                m = S.movies.get(parts[1])
                if m is None:
                    self._json(404, {"error": "no such movie"})
                elif method == "GET" and parts[2:] == []:
                    self._json(200, m.info())
                elif method == "DELETE" and parts[2:] == []:
                    m.cancel()
                    self._json(200, m.info())
                elif method == "GET" and parts[2:] == ["file"] and m.file and m.file.is_file():
                    self._file(m.file, "video/mp4", f"{safe_name(m.file.stem)}.mp4")
                else:
                    self._json(404, {"error": "not found"})
            elif len(parts) >= 2 and parts[0] == "stills":
                j = S.stills.get(parts[1])
                if j is None:
                    self._json(404, {"error": "no such still"})
                elif method == "GET" and parts[2:] == []:
                    self._json(200, j.info())
                elif method == "DELETE" and parts[2:] == []:
                    j.cancel()
                    self._json(200, j.info())
                elif method == "GET" and parts[2:] == ["file"] and j.file and j.file.is_file():
                    self._file(j.file, "image/png", f"{safe_name(j.file.stem, 'still')}.png")
                else:
                    self._json(404, {"error": "not found"})
            else:
                self._json(404, {"error": "not found"})
        except BadRequest as e:
            self._json(400, {"error": str(e)})
        except Refused as e:
            # Not now (the GPU budget taken, too many jobs waiting) or not here (too little disk): said plainly.
            self._json(e.status, e.answer(), {"Retry-After": str(e.retry_after)} if e.retry_after else None)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            try:
                self._json(500, {"error": f"{type(e).__name__}: {e}"})
            except Exception:  # noqa: BLE001
                pass

    def do_GET(self):
        self._route("GET")

    def do_HEAD(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")

    def do_OPTIONS(self):
        # Direct use from a page on this computer (without the runner): CORS for localhost only.
        origin = self.headers.get("Origin") or ""
        self.send_response(204)
        if _LOCAL_ORIGIN.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-NGP-Service-Token")
        self.send_header("Content-Length", "0")
        self.end_headers()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m ngplatform_render.server", description="Path-traced views of OME-Zarr volumes, for ngplatform.")
    p.add_argument("--port", type=int, default=int(os.environ.get("NGP_SERVICE_PORT", "0") or 0))
    p.add_argument("--token", default=os.environ.get("NGP_SERVICE_TOKEN"))
    p.add_argument("--device", type=int, default=0, help="the CUDA device (after CUDA_VISIBLE_DEVICES)")
    p.add_argument("--out", default=None, help="where movies and splats go by default (default <state-dir>/renders)")
    p.add_argument("--gpu-budget", default=os.environ.get("NGP_RENDER_GPU_BUDGET"), metavar="SIZE",
                   help="the GPU memory every session and job together may hold: bytes (24G, 12000M) or a part of what is free "
                        "at the start (0.6); default $NGP_RENDER_GPU_BUDGET, else 0.8 of the free memory")
    p.add_argument("--splat-python", default=os.environ.get("NGP_SPLAT_PYTHON"), help="a Python with torch and gsplat, which fits splats (default $NGP_SPLAT_PYTHON; none: splats are captured, not fitted)")
    p.add_argument("--allow-source", action="append", default=(os.environ.get("NGP_RENDER_SOURCES") or "").split(), metavar="URL",
                   help="read remote stores (http(s), gs://, s3://) only from under this address; may be given more than once "
                        "(default $NGP_RENDER_SOURCES, space-separated; none: any)")
    args = p.parse_args(argv)
    if not args.token:
        # Never open: any web page can send a simple POST to 127.0.0.1.
        args.token = secrets.token_urlsafe(24)
        print(f"token: {args.token}  (give it as the token; started without one)", flush=True)
    roots = [Path(r).expanduser().resolve() for r in json.loads(os.environ.get("NGP_ROOTS", "[]"))]
    state = Path(os.environ.get("NGP_STATE_DIR", "~/.ngplatform-runner")).expanduser()
    out_root = Path(args.out).expanduser().resolve() if args.out else state / "renders"
    roots.append(out_root)
    from .gpu import free_memory, parse_budget

    free = free_memory(args.device)[0]
    try:
        # No GPU and no budget given: nothing is counted (a session fails when it uploads).
        budget = parse_budget(args.gpu_budget, free) if free or args.gpu_budget else None
    except ValueError as e:
        p.error(str(e))
    srv = RenderServer(args.port, args.token, roots, args.device, out_root, args.splat_python, args.allow_source, gpu_budget=budget)
    print(f"ngplatform render {__version__}: GPU {srv.gpu()}; budget {gb(srv.gpu_share.budget.total)}", flush=True)
    if srv.ffmpeg is None:
        print("no ffmpeg on the PATH: movies cannot be made (stills and splats can)", flush=True)
    if srv.sources:
        print(f"remote stores only from: {', '.join(srv.sources)}", flush=True)
    if os.environ.get("NGP_SERVICE_TOKEN"):
        # Started by a runner: end with it, however it ends (a dropped ssh session, kill -9).
        parent = os.getppid()

        def watch() -> None:
            while os.getppid() == parent:
                time.sleep(2)
            os._exit(0)

        threading.Thread(target=watch, daemon=True).start()
    print(f"ready http://127.0.0.1:{srv.server_port}", flush=True)
    try:
        srv.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
