"""The render service: path-traced views of OME-Zarr volumes, over HTTP.

Started by the runner as a service (``--service render="<python> -m
ngplatform_render.server"``), which gives it a port and a token in its
environment and forwards ``/svc/render/...`` to it; or on its own with
``--port`` (and ``--token``) for tests.  It listens on 127.0.0.1 only.

A session holds one volume (and optionally a label volume) on the GPU.
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

import numpy as np

from . import __version__
from .lightmaps import names as lightmap_names
from .presets import Preset, builtin

MAX_BODY = 8 << 20
_LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
IDLE_SECONDS = 20 * 60


class BadRequest(Exception):
    pass


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
    def __init__(self, sid: str, spec: dict[str, Any], device: int):
        self.id = sid
        self.spec = spec
        self.device = device
        self.status = "loading"
        self.progress = 0.0
        self.message = "starting"
        self.error: str | None = None
        self.meta: dict[str, Any] = {}
        self.label_meta: dict[str, Any] | None = None
        self.renderer = None
        self.loaded = None
        self.loaded_labels = None
        self.cond = threading.Condition()
        self.view: dict[str, Any] | None = None
        self.view_version = 0
        self.applied_version = -1
        self.frame: tuple[int, int, int, bytes, int, int] | None = None  # number, samples, version, webp, w, h
        self.frame_number = 0
        self.depth: tuple[int, bytes, int, int] | None = None
        self.max_samples = 1024
        self.last_used = time.time()
        self.closed = False
        self.passes_ms = 0.0
        threading.Thread(target=self._load, daemon=True).start()

    # ---------------------------------------------------------------- loading
    def _set_progress(self, p: float, msg: str) -> None:
        self.progress, self.message = p, msg

    def _load(self) -> None:
        from . import renderer, volumes

        try:
            v = self.spec["volume"]
            url = v["url"]
            budget = int(v.get("budget") or 400_000_000)
            L = volumes.load(url, budget=budget, level=v.get("level"), progress=self._set_progress)
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
                "tissue_mm": volumes.tissue_box(L.data, L.affine, L.percentiles.get(0.0, L.lo), L.lo, L.hi),
            }
            lab = self.spec.get("labels")
            if lab and lab.get("url"):
                self._set_progress(0.0, "reading labels")
                LB = volumes.load(lab["url"], budget=int(lab.get("budget") or budget), labels=True, progress=self._set_progress)
                self.loaded_labels = LB
                vals = np.unique(LB.data)
                self.label_meta = {"url": lab["url"], "level": LB.level, "shape": list(LB.data.shape), "values": [int(x) for x in vals[:4096]],
                                   "affine": LB.affine.T.ravel().tolist()}
            if self.closed:
                self.status, self.message = "failed", "closed while loading"
                return
            self._set_progress(1.0, "uploading to the GPU")
            R = renderer.Renderer(self.device)
            R.set_volume(renderer.Volume(L.data, L.affine, L.lo, L.hi, L.percentiles, L.window))
            if self.closed:
                return
            self.renderer = R
            self.status = "ready"
            self.message = f"level {L.level} {tuple(L.data.shape[::-1])} voxels of {', '.join(f'{x:.3g}' for x in L.voxel_mm)} mm"
            threading.Thread(target=self._loop, daemon=True).start()
        except Exception as e:  # noqa: BLE001 - reported to the page
            self.status = "failed"
            self.error = f"{type(e).__name__}: {e}"
            traceback.print_exc()

    # ---------------------------------------------------------------- views
    def set_view(self, view: dict[str, Any]) -> int:
        with self.cond:
            self.view = view
            self.view_version += 1
            self.max_samples = int(view.get("max_samples") or 1024)
            self.last_used = time.time()
            self.cond.notify_all()
            return self.view_version

    def _state(self, view: dict[str, Any], R=None):
        """The view as the renderer takes it, placing the volume and labels on `R` (the session's own by default)."""
        from . import renderer
        from .luts import freesurfer

        L = self.loaded
        R = R if R is not None else self.renderer
        wfp = _mat(view["world_from_physical"], "world_from_physical") if view.get("world_from_physical") else np.eye(4)
        scale = float(view.get("scale") or 1.0)
        W = max(8, int(round(int(view["width"]) * scale)))
        H = max(8, int(round(int(view["height"]) * scale)))
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
                R.set_labels(renderer.Labels(LB.data, lw))
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
            label_colors=colors, keep_labels=keep, label_mix=mix,
            background=tuple(view.get("background", (0, 0, 0, 0))),
            max_bounces=int(view.get("max_bounces", 4)),
            denoise=bool(view.get("denoise", True)),
            aperture=float(view.get("aperture", 0.0)), focus=float(view.get("focus", 0.0)),
            unit_mm=float(view.get("unit_mm", 1.0)),
        )

    # ---------------------------------------------------------------- the loop
    def _loop(self) -> None:
        R = self.renderer
        last_publish = 0.0
        batch = 1
        while not self.closed:
            with self.cond:
                while not self.closed and (self.view is None or (self.applied_version == self.view_version and R.samples >= self.max_samples)):
                    self.cond.wait(timeout=1.0)
                if self.closed:
                    return
                version, view = self.view_version, self.view
            try:
                if version != self.applied_version:
                    st = self._state(view)
                    R.set_view(st)
                    d = R.depth()
                    dz = zlib.compress(d[..., 0].astype(np.float16).tobytes(), 1)
                    with self.cond:
                        self.depth = (version, dz, st.width, st.height)
                    self.applied_version = version
                    batch = 1
                    last_publish = 0.0
                t = time.time()
                R.step(batch)
                R.synchronize()
                dt = (time.time() - t) / batch
                self.passes_ms = dt * 1000
                # Grow batches to about 60 ms of work, so a new view is taken up quickly.
                batch = max(1, min(64, int(0.06 / max(dt, 1e-4))))
                n = R.samples
                pow2 = n & (n - 1) == 0
                if pow2 or time.time() - last_publish > 0.25 or n >= self.max_samples:
                    self._publish(version)
                    last_publish = time.time()
            except BadRequest as e:
                self.error = str(e)
                with self.cond:
                    self.applied_version = version
                    self.max_samples = 0
            except Exception as e:  # noqa: BLE001
                self.error = f"{type(e).__name__}: {e}"
                traceback.print_exc()
                time.sleep(0.5)

    def _publish(self, version: int) -> None:
        from PIL import Image

        R = self.renderer
        img = R.image()
        b = io.BytesIO()
        Image.fromarray(img, "RGBA").save(b, "WEBP", quality=88, method=0)
        with self.cond:
            self.frame_number += 1
            self.frame = (self.frame_number, R.samples, version, b.getvalue(), img.shape[1], img.shape[0])
            self.cond.notify_all()

    def wait_frame(self, after: int, timeout: float):
        end = time.time() + timeout
        with self.cond:
            while not self.closed and (self.frame is None or self.frame[0] <= after):
                left = end - time.time()
                if left <= 0:
                    return None
                self.cond.wait(timeout=left)
            self.last_used = time.time()
            return self.frame

    def close(self) -> None:
        with self.cond:
            self.closed = True
            self.cond.notify_all()
        self.renderer = None

    def info(self) -> dict[str, Any]:
        R = self.renderer
        return {
            "id": self.id, "status": self.status, "progress": round(self.progress, 3), "message": self.message, "error": self.error,
            "volume": self.meta, "labels": self.label_meta, "samples": R.samples if R else 0, "ms_per_pass": round(self.passes_ms, 2),
            "view_version": self.view_version, "frame": self.frame[0] if self.frame else 0,
        }


class Movie:
    """A movie made from keyframes: frames path-traced to a sample count, then encoded with ffmpeg."""

    def __init__(self, mid: str, session: Session, spec: dict[str, Any], out_dir: Path):
        self.id = mid
        self.session = session
        self.spec = spec
        self.out_dir = out_dir
        self.status = "queued"
        self.progress = 0.0
        self.message = ""
        self.error: str | None = None
        self.file: Path | None = None
        self.cancelled = False
        self.started = time.time()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        from PIL import Image

        from . import renderer as rmod
        from .movie import frames_for, rotation_frames

        try:
            self.status = "running"
            S = self.session
            if S.status != "ready":
                raise RuntimeError("the session's volume is not loaded")
            # A renderer of its own, so the interactive view goes on.
            R = rmod.Renderer(S.device)
            L = S.loaded
            R.set_volume(rmod.Volume(L.data, L.affine, L.lo, L.hi, L.percentiles, L.window))
            sp = self.spec
            fps = int(sp.get("fps", 25))
            samples = int(sp.get("samples", 256))
            width, height = int(sp.get("width", 1280)), int(sp.get("height", 720))
            if not (8 <= width <= 8192 and 8 <= height <= 8192):
                raise BadRequest("width and height must be 8 to 8192")
            if sp.get("rotation"):
                r = sp["rotation"]
                views = rotation_frames(sp["keyframes"][0]["view"], r.get("axis", "vertical"), float(r.get("degrees", 360)), float(r.get("step", 2)), aspect=width / height)
            else:
                views = frames_for(sp["keyframes"], fps, sp.get("easing", "smooth"), aspect=width / height)
            self.out_dir.mkdir(parents=True, exist_ok=True)
            frames = self.out_dir / "frames"
            frames.mkdir(exist_ok=True)
            for old in frames.glob("[0-9][0-9][0-9][0-9][0-9].png"):
                old.unlink()  # a shorter movie in the same folder must not pick up an earlier one's frames
            for i, view in enumerate(views):
                if self.cancelled:
                    raise RuntimeError("cancelled")
                view = dict(view)
                view["width"], view["height"], view["scale"] = width, height, 1.0
                st = S._state(view, R)
                R.set_view(st)
                R.step(samples)
                img = R.image()
                bg = np.asarray(sp.get("background", (0.08, 0.08, 0.09)), np.float32) * 255
                a = img[..., 3:4].astype(np.float32) / 255
                rgb = np.clip(img[..., :3].astype(np.float32) + bg * (1 - a), 0, 255).astype(np.uint8)
                Image.fromarray(rgb).save(frames / f"{i:05d}.png")
                self.progress = (i + 1) / len(views) * (0.97 if sp.get("format", "mp4") == "mp4" else 1.0)
                self.message = f"frame {i + 1} of {len(views)}"
            if sp.get("format", "mp4") == "mp4":
                self.message = "encoding"
                ff = shutil.which("ffmpeg") or "ffmpeg"
                out = self.out_dir / f"{safe_name(sp.get('name'))}.mp4"
                cmd = [ff, "-y", "-loglevel", "error", "-framerate", str(fps), "-i", str(frames / "%05d.png"),
                       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(sp.get("crf", 18)), str(out)]
                subprocess.run(cmd, check=True, capture_output=True, timeout=3600)
                self.file = out
            else:
                self.file = frames
            self.progress = 1.0
            self.status = "done"
            self.message = f"{len(views)} frames in {time.time() - self.started:.0f} s"
        except Exception as e:  # noqa: BLE001
            self.status = "cancelled" if self.cancelled else "failed"
            self.error = f"{type(e).__name__}: {e}"
            traceback.print_exc()
        finally:
            self.session = None  # a finished movie does not keep the session (and its volume) alive

    def info(self) -> dict[str, Any]:
        return {"id": self.id, "status": self.status, "progress": round(self.progress, 3), "message": self.message,
                "error": self.error, "file": str(self.file) if self.file else None}


class RenderServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port: int, token: str | None, roots: list[Path], device: int, out_root: Path):
        super().__init__(("127.0.0.1", port), Handler)
        self.token = token
        self.roots = roots
        self.device = device
        self.out_root = out_root
        self.sessions: dict[str, Session] = {}
        self.movies: dict[str, Movie] = {}
        self.lock = threading.Lock()
        threading.Thread(target=self._reaper, daemon=True).start()

    def _reaper(self) -> None:
        while True:
            time.sleep(30)
            now = time.time()
            with self.lock:
                for sid, s in list(self.sessions.items()):
                    if now - s.last_used > IDLE_SECONDS:
                        s.close()
                        del self.sessions[sid]

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
        """Stores on this computer are read only under the runner's folders; http(s), gs:// and s3:// stores are read as given."""
        from .volumes import http_url

        u = http_url(url)
        if u.startswith(("http://", "https://")):
            return
        p = Path(u.removeprefix("file://")).expanduser().resolve()
        if not any(p == r or r in p.parents for r in self.roots):
            raise BadRequest("a store on this computer must be under one of the runner's folders")

    def output_dir(self, requested: str | None, mid: str) -> Path:
        if not requested:
            return self.out_root / mid
        p = Path(requested).expanduser().resolve()
        if not any(p == r or r in p.parents for r in self.roots):
            raise BadRequest("the output folder must be under one of the runner's folders")
        return p


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

    def _json(self, code: int, obj: Any) -> None:
        self._send(code, json.dumps(obj).encode())

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
        q = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
        parts = [p for p in path.split("/") if p]
        S = self.server
        try:
            if method == "GET" and parts in ([], ["info"]):
                self._json(200, {"service": "render", "version": __version__, "gpu": S.gpu(), "presets": list(builtin()), "lightmaps": lightmap_names()})
            elif method == "GET" and parts == ["presets"]:
                self._json(200, [p.to_dict() for p in builtin().values()])
            elif method == "POST" and parts == ["sessions"]:
                spec = self._body()
                if not (spec.get("volume") or {}).get("url"):
                    raise BadRequest("volume.url is needed")
                for part in ("volume", "labels"):
                    if (spec.get(part) or {}).get("url"):
                        S.check_source(spec[part]["url"])
                sid = uuid.uuid4().hex[:12]
                with S.lock:
                    s = Session(sid, spec, S.device)
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
                    s.close()
                    self._json(200, {"closed": s.id})
                elif method in ("PUT", "POST") and rest == ["view"]:
                    view = self._body()
                    for k in ("inv_view_projection", "width", "height"):
                        if k not in view:
                            raise BadRequest(f"view.{k} is needed")
                    self._json(200, {"version": s.set_view(view)})
                elif method == "GET" and rest == ["frame"]:
                    after = int(q.get("after", "0"))
                    timeout = min(60.0, float(q.get("timeout", "25")))
                    f = s.wait_frame(after, timeout)
                    if f is None:
                        self._send(204, b"", headers={"X-Status": s.status, "X-Error": (s.error or "")[:200]})
                        return
                    n, samples, version, data, w, h = f
                    self._send(200, data, "image/webp", {"X-Frame": str(n), "X-Samples": str(samples), "X-Version": str(version),
                                                         "X-Width": str(w), "X-Height": str(h), "X-Ms-Per-Pass": f"{s.passes_ms:.1f}"})
                elif method == "GET" and rest == ["depth"]:
                    d = s.depth
                    if d is None:
                        self._send(204, b"")
                        return
                    version, dz, w, h = d
                    self._send(200, dz, "application/octet-stream", {"X-Version": str(version), "X-Width": str(w), "X-Height": str(h),
                                                                     "X-Format": "float16-zlib"})
                elif method == "POST" and rest == ["still"]:
                    # One view, path-traced to a sample count at a size, as a PNG (a renderer of its own).
                    from PIL import Image

                    from . import renderer as rmod

                    if s.status != "ready":
                        raise BadRequest("the session's volume is not loaded")
                    body = self._body()
                    view = dict(body.get("view") or {})
                    w, h = int(body.get("width", view.get("width", 1920))), int(body.get("height", view.get("height", 1080)))
                    if not (8 <= w <= 8192 and 8 <= h <= 8192):
                        raise BadRequest("width and height must be 8 to 8192")
                    if "inv_view_projection" not in view:
                        raise BadRequest("view.inv_view_projection is needed")
                    if (view.get("width"), view.get("height")) != (w, h) and view.get("width"):
                        # The same camera at another shape: widen or narrow the view, not stretch it.
                        from .movie import reshaped

                        view["inv_view_projection"] = reshaped(view["inv_view_projection"], w / h, view.get("orbit_center"))
                    view.update(width=w, height=h, scale=1.0)
                    R = rmod.Renderer(s.device)
                    L = s.loaded
                    R.set_volume(rmod.Volume(L.data, L.affine, L.lo, L.hi, L.percentiles, L.window))
                    R.set_view(s._state(view, R))
                    R.step(max(1, min(4096, int(body.get("samples", 256)))))
                    img = R.image()
                    bg = body.get("background")
                    if bg is not None:
                        a = img[..., 3:4].astype(np.float32) / 255
                        rgb = np.clip(img[..., :3].astype(np.float32) + np.asarray(bg[:3], np.float32) * 255 * (1 - a), 0, 255).astype(np.uint8)
                        pic = Image.fromarray(rgb)
                    else:
                        pic = Image.fromarray(img, "RGBA")
                    out = io.BytesIO()
                    pic.save(out, "PNG")
                    del R
                    self._send(200, out.getvalue(), "image/png", {"Content-Disposition": f'attachment; filename="{safe_name(body.get("name"), "still")}.png"'})
                elif method == "POST" and rest == ["movies"]:
                    spec = self._body()
                    if not spec.get("keyframes"):
                        raise BadRequest("keyframes are needed")
                    mid = uuid.uuid4().hex[:12]
                    out = S.output_dir(spec.get("output"), mid)
                    m = Movie(mid, s, spec, out)
                    S.movies[mid] = m
                    done = [k for k, v in S.movies.items() if v.status in ("done", "failed", "cancelled")]
                    for k in done[:-20]:
                        del S.movies[k]
                    self._json(200, m.info())
                else:
                    self._json(404, {"error": "not found"})
            elif len(parts) >= 2 and parts[0] == "movies":
                m = S.movies.get(parts[1])
                if m is None:
                    self._json(404, {"error": "no such movie"})
                elif method == "GET" and parts[2:] == []:
                    self._json(200, m.info())
                elif method == "DELETE" and parts[2:] == []:
                    m.cancelled = True
                    self._json(200, m.info())
                elif method == "GET" and parts[2:] == ["file"] and m.file and m.file.is_file():
                    data = m.file.read_bytes()
                    self._send(200, data, "video/mp4", {"Content-Disposition": f'attachment; filename="{safe_name(m.file.stem)}.mp4"'})
                else:
                    self._json(404, {"error": "not found"})
            else:
                self._json(404, {"error": "not found"})
        except BadRequest as e:
            self._json(400, {"error": str(e)})
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
    p.add_argument("--out", default=None, help="where movies go by default (default <state-dir>/renders)")
    args = p.parse_args(argv)
    if not args.token:
        # Never open: any web page can send a simple POST to 127.0.0.1.
        args.token = secrets.token_urlsafe(24)
        print(f"token: {args.token}  (give it as the token; started without one)", flush=True)
    roots = [Path(r).expanduser().resolve() for r in json.loads(os.environ.get("NGP_ROOTS", "[]"))]
    state = Path(os.environ.get("NGP_STATE_DIR", "~/.ngplatform-runner")).expanduser()
    out_root = Path(args.out).expanduser().resolve() if args.out else state / "renders"
    roots.append(out_root)
    srv = RenderServer(args.port, args.token, roots, args.device, out_root)
    print(f"ngplatform render {__version__}: GPU {srv.gpu()}", flush=True)
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
