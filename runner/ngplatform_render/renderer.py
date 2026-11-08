"""The path tracer on a CUDA GPU, through CuPy.

A `Renderer` holds one volume (and optionally a label volume) on the GPU
and renders views of it: `set_view` with the camera and the look (a
`RenderState`), then `step()` adds one sample to every pixel and
`image()` is the mean so far, tone-mapped.  Changing anything but the
sample count starts the mean again.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from . import kernels
from .presets import Preset, transfer_table

BRICK = 8


def _cupy():
    import cupy  # imported late: the package also serves its metadata without a GPU

    return cupy


_module = None
_module_lock = threading.Lock()


def _kernels():
    global _module
    with _module_lock:
        if _module is None:
            cp = _cupy()
            _module = cp.RawModule(code=kernels.SOURCE, options=("--use_fast_math", "-std=c++14"))
        return _module


@dataclass
class Volume:
    """A volume as the renderer takes it: values 0..1 (uint8 or uint16 scaled), x fastest
    (array axes z, y, x), and the affine from voxel index coordinates (x, y, z; voxel centres
    at integers) to world (display) coordinates."""

    data: np.ndarray  # (nz, ny, nx), uint8 or uint16
    world_from_voxel: np.ndarray  # 4x4
    lo: float = 0.0  # the data value at texture 0 ..
    hi: float = 1.0  # .. and at texture 1
    percentiles: dict[float, float] = field(default_factory=dict)  # data value at each percentile (of non-background)


@dataclass
class Labels:
    data: np.ndarray  # (nz, ny, nx) integer labels
    world_from_voxel: np.ndarray  # 4x4


@dataclass
class Light:
    direction: tuple[float, float, float] = (0.4, 0.7, 0.6)  # towards the light, in camera space (x right, y up, z back)
    rgb: tuple[float, float, float] = (3.2, 3.0, 2.8)
    camera_space: bool = True


@dataclass
class RenderState:
    """Everything a frame depends on but the volume itself."""

    inv_view_projection: np.ndarray  # 4x4, clip -> world
    width: int
    height: int
    preset: Preset
    light: Light = field(default_factory=Light)
    clips: list[tuple[float, float, float, float]] = field(default_factory=list)  # world planes kept where n.x + d >= 0
    crop: tuple[tuple[float, float, float], tuple[float, float, float]] | None = None  # in voxel coordinates
    label_colors: dict[int, tuple[float, float, float, float]] | None = None  # label -> r, g, b, opacity scale
    keep_labels: set[int] = field(default_factory=set)  # labels left in place by cuts
    label_mix: float = 1.0
    background: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    max_bounces: int = 4
    aperture: float = 0.0
    focus: float = 0.0
    unit_mm: float = 1.0  # how many mm one world (display) unit is


def _tex_for(cp, data: np.ndarray):
    """A 3-D texture of `data` (uint8 or uint16), read as 0..1 floats with trilinear filtering."""
    from cupy.cuda import texture, runtime

    nz, ny, nx = data.shape
    bits = 8 if data.dtype == np.uint8 else 16
    desc = texture.ChannelFormatDescriptor(bits, 0, 0, 0, runtime.cudaChannelFormatKindUnsigned)
    arr = texture.CUDAarray(desc, nx, ny, nz)
    arr.copy_from(np.ascontiguousarray(data))
    res = texture.ResourceDescriptor(runtime.cudaResourceTypeArray, cuArr=arr)
    tdesc = texture.TextureDescriptor(
        addressModes=(runtime.cudaAddressModeClamp,) * 3,
        filterMode=runtime.cudaFilterModeLinear,
        readMode=runtime.cudaReadModeNormalizedFloat,
        normalizedCoords=0,
    )
    return texture.TextureObject(res, tdesc), arr


def brick_bounds(cp, data_gpu, brick: int = BRICK):
    """The least and greatest value (0..1) in each brick of `brick` voxels a side, with one
    voxel of overlap (trilinear samples near a face read the neighbour)."""
    nz, ny, nx = data_gpu.shape
    scale = 255.0 if data_gpu.dtype == cp.uint8 else 65535.0
    gz, gy, gx = (-(-n // brick) for n in (nz, ny, nx))
    pad = [(0, gz * brick - nz), (0, gy * brick - ny), (0, gx * brick - nx)]
    v = cp.pad(data_gpu, pad, mode="edge")
    b = v.reshape(gz, brick, gy, brick, gx, brick)
    mn = b.min(axis=(1, 3, 5)).astype(cp.float32)
    mx = b.max(axis=(1, 3, 5)).astype(cp.float32)
    # Overlap: a brick also takes its neighbours' extremes (conservative for interpolation).
    for ax in range(3):
        for s in (1, -1):
            mn = cp.minimum(mn, cp.roll(mn, s, axis=ax))
            mx = cp.maximum(mx, cp.roll(mx, s, axis=ax))
    return mn / scale, mx / scale, (gx, gy, gz)


def look_at(eye, target, up, fovy_deg: float, aspect: float, near: float, far: float) -> np.ndarray:
    """View-projection (column-major in the sense of OpenGL: returns the 4x4 as a numpy matrix M with clip = M @ p)."""
    eye, target, up = (np.asarray(a, np.float64) for a in (eye, target, up))
    f = target - eye
    f /= np.linalg.norm(f)
    s = np.cross(f, up)
    s /= np.linalg.norm(s)
    u = np.cross(s, f)
    view = np.eye(4)
    view[0, :3], view[1, :3], view[2, :3] = s, u, -f
    view[:3, 3] = -view[:3, :3] @ eye
    t = 1.0 / np.tan(np.radians(fovy_deg) / 2)
    proj = np.zeros((4, 4))
    proj[0, 0] = t / aspect
    proj[1, 1] = t
    proj[2, 2] = (far + near) / (near - far)
    proj[2, 3] = 2 * far * near / (near - far)
    proj[3, 2] = -1
    return proj @ view


class Renderer:
    def __init__(self, device: int = 0):
        cp = _cupy()
        self.cp = cp
        self.device = cp.cuda.Device(device)
        self.lock = threading.RLock()
        self.volume: Volume | None = None
        self.labels: Labels | None = None
        self._tex = None
        self._arr = None
        self._bmin = self._bmax = None
        self._grid = (1, 1, 1)
        self._lab = None
        self._lut = None
        self._lutflags = None
        self._nlut = 0
        self._tf = None
        self._maj = None
        self._accum = None
        self._params = None
        self._state: RenderState | None = None
        self._world_from_vox_label = None
        self.samples = 0
        self._frame = 0
        self._tf_key: Any = None

    # ------------------------------------------------------------ data
    def set_volume(self, volume: Volume) -> None:
        cp = self.cp
        with self.lock, self.device:
            tex, arr = _tex_for(cp, volume.data)
            g = cp.asarray(volume.data)
            bmin, bmax, grid = brick_bounds(cp, g)
            del g
            self._tex, self._arr = tex, arr
            self._bmin, self._bmax, self._grid = bmin.ravel(), bmax.ravel(), grid
            self._maj = cp.zeros(bmin.size, cp.float32)
            self.volume = volume
            self._tf_key = None
            self.reset()

    def set_labels(self, labels: Labels | None) -> None:
        cp = self.cp
        with self.lock, self.device:
            if labels is None:
                self.labels, self._lab = None, None
            else:
                self.labels = labels
                self._lab = cp.asarray(np.ascontiguousarray(labels.data.astype(np.uint16)))
            self._lut_key = None
            self.reset()

    # ------------------------------------------------------------ view
    def reset(self) -> None:
        self.samples = 0
        if self._accum is not None:
            self._accum.fill(0)

    def set_view(self, state: RenderState) -> None:
        """A new camera or look: the mean starts again."""
        cp = self.cp
        if self.volume is None:
            raise RuntimeError("no volume")
        with self.lock, self.device:
            W, H = int(state.width), int(state.height)
            if self._accum is None or self._accum.shape[:2] != (H, W):
                self._accum = cp.zeros((H, W, 4), cp.float32)
            self._state = state
            self._params = cp.asarray(self._pack(state))
            key = (state.preset.key(), self.volume.lo, self.volume.hi)
            if key != self._tf_key:
                self._tf = cp.asarray(transfer_table(state.preset, self.volume))
                self._tf_key = key
            self._update_lut(state)
            n = self._bmin.size
            _kernels().get_function("majorant")((-(-n // 256),), (256,), (self._params, self._tf, self._bmin, self._bmax, self._maj, np.int32(n)))
            self.reset()

    def _update_lut(self, state: RenderState) -> None:
        cp = self.cp
        if self.labels is None or state.label_colors is None:
            if self._lut is None:
                self._lut = cp.zeros(4, cp.float32)
                self._lutflags = cp.zeros(1, cp.float32)
            self._nlut = 0
            return
        top = max(max(state.label_colors.keys(), default=0), 1) + 1
        lut = np.zeros((top, 4), np.float32)
        lut[:, 0] = -1.0  # labels not given (0 among them) leave the image's own colour and opacity
        for k, (r, g, b, a) in state.label_colors.items():
            if 0 <= k < top:
                lut[k] = (r, g, b, a)
        flags = np.zeros(top, np.float32)
        for k in state.keep_labels:
            if 0 <= k < top:
                flags[k] = 1.0
        self._lut = cp.asarray(lut.ravel())
        self._lutflags = cp.asarray(flags)
        self._nlut = top

    def _pack(self, s: RenderState) -> np.ndarray:
        vol = self.volume
        assert vol is not None
        O = kernels.OFFSETS
        P = np.zeros(kernels.NPARAMS, np.float32)
        inv = np.asarray(s.inv_view_projection, np.float64).reshape(4, 4)
        vp = np.linalg.inv(inv)
        P[O["INVVP"]:O["INVVP"] + 16] = inv.T.ravel()  # column-major
        P[O["VP"]:O["VP"] + 16] = vp.T.ravel()
        wfv = np.asarray(vol.world_from_voxel, np.float64)
        vfw = np.linalg.inv(wfv)
        P[O["VOX_FROM_WORLD"]:O["VOX_FROM_WORLD"] + 12] = vfw[:3, :4].ravel()
        P[O["WORLD_NORMAL"]:O["WORLD_NORMAL"] + 9] = vfw[:3, :3].T.ravel()
        nz, ny, nx = vol.data.shape
        P[O["DIMS"]:O["DIMS"] + 3] = (nx, ny, nz)
        P[O["BRICK"]] = BRICK
        P[O["MGRID"]:O["MGRID"] + 3] = self._grid
        pr = s.preset
        # Density is given per mm; the world unit is unit_mm mm.
        P[O["DENSITY"]] = pr.density * s.unit_mm
        P[O["SHADE_MIX"]] = pr.shade_mix
        P[O["GRAD_SCALE"]] = pr.gradient_scale
        P[O["ROUGHNESS"]] = pr.roughness
        P[O["SPECULAR"]] = pr.specular
        P[O["PHASE_G"]] = pr.phase_g
        P[O["ALBEDO"]] = pr.albedo
        # Camera axes in world, for lights given in camera space.
        right, up, back = _camera_axes(inv)
        ld = np.asarray(s.light.direction, np.float64)
        if s.light.camera_space:
            ld = ld[0] * right + ld[1] * up + ld[2] * back
        ld /= np.linalg.norm(ld)
        P[O["LIGHT_DIR"]:O["LIGHT_DIR"] + 3] = ld
        P[O["LIGHT_RGB"]:O["LIGHT_RGB"] + 3] = np.asarray(s.light.rgb) * pr.light_scale
        env = pr.environment
        P[O["ENV_TOP"]:O["ENV_TOP"] + 3] = env["top"]
        P[O["ENV_HORIZON"]:O["ENV_HORIZON"] + 3] = env["horizon"]
        P[O["ENV_BOTTOM"]:O["ENV_BOTTOM"] + 3] = env["bottom"]
        P[O["ENV_UP"]:O["ENV_UP"] + 3] = up
        P[O["ENV_SCALE"]] = env.get("scale", 1.0)
        P[O["BG"]:O["BG"] + 4] = s.background
        P[O["EXPOSURE"]] = pr.exposure
        P[O["MAX_BOUNCES"]] = s.max_bounces
        clips = list(s.clips)[:6]
        P[O["NCLIP"]] = len(clips)
        for i, c in enumerate(clips):
            P[O["CLIPS"] + 4 * i:O["CLIPS"] + 4 * i + 4] = c
        lo, hi = s.crop if s.crop is not None else ((-1e9,) * 3, (1e9,) * 3)
        P[O["CROP_LO"]:O["CROP_LO"] + 3] = lo
        P[O["CROP_HI"]:O["CROP_HI"] + 3] = hi
        if self.labels is not None and s.label_colors is not None:
            P[O["HAS_LABELS"]] = 1
            lfw = np.linalg.inv(np.asarray(self.labels.world_from_voxel, np.float64))
            P[O["LABEL_FROM_WORLD"]:O["LABEL_FROM_WORLD"] + 12] = lfw[:3, :4].ravel()
            lz, ly, lx = self.labels.data.shape
            P[O["LDIMS"]:O["LDIMS"] + 3] = (lx, ly, lz)
            P[O["NLUT"]] = max(max(s.label_colors.keys(), default=0), 1) + 1
            P[O["LABEL_MIX"]] = s.label_mix
        P[O["STEP"]] = 0.5
        P[O["APERTURE"]] = s.aperture
        P[O["FOCUS"]] = s.focus
        P[O["OPAQUE_LIMIT"]] = 0.5
        return P

    # ------------------------------------------------------------ passes
    def _args(self):
        cp = self.cp
        lab = self._lab if self._lab is not None else cp.zeros(1, cp.uint16)
        return (self._params, self._tex, self._tf, self._maj, lab, self._lut, self._lutflags)

    def step(self, n: int = 1) -> int:
        """Adds n samples per pixel; returns the samples so far."""
        cp = self.cp
        s = self._state
        if s is None:
            raise RuntimeError("no view")
        with self.lock, self.device:
            W, H = s.width, s.height
            grid, block = (-(-W // 16), -(-H // 8)), (16, 8)
            f = _kernels().get_function("trace")
            O = kernels.OFFSETS["FRAME"]
            for _ in range(n):
                self._frame += 1
                self._params[O] = float(self._frame % 16777216)
                f(grid, block, self._args() + (self._accum, np.int32(W), np.int32(H)))
                self.samples += 1
            return self.samples

    def image(self) -> np.ndarray:
        """The mean so far, tone-mapped: (H, W, 4) uint8, premultiplied alpha."""
        cp = self.cp
        s = self._state
        assert s is not None
        with self.lock, self.device:
            W, H = s.width, s.height
            out = cp.zeros((H, W, 4), cp.uint8)
            _kernels().get_function("tonemap")(
                (-(-W // 16), -(-H // 8)), (16, 8),
                (self._accum, np.float32(1.0 / max(self.samples, 1)), np.float32(s.preset.exposure), out, np.int32(W), np.int32(H)),
            )
            return cp.asnumpy(out)

    def depth(self) -> np.ndarray:
        """(H, W, 2) float32: GL depth 0..1 where the view first becomes mostly opaque (1: nothing), and the world distance (-1)."""
        cp = self.cp
        s = self._state
        assert s is not None
        with self.lock, self.device:
            W, H = s.width, s.height
            out = cp.zeros((H, W, 2), cp.float32)
            _kernels().get_function("firsthit")(
                (-(-W // 16), -(-H // 8)), (16, 8), self._args() + (out, np.int32(W), np.int32(H))
            )
            return cp.asnumpy(out)

    def synchronize(self) -> None:
        with self.device:
            self.cp.cuda.Stream.null.synchronize()


def _camera_axes(inv: np.ndarray):
    """Right, up and back unit vectors of the camera an inverse view-projection describes (world)."""

    def unproject(x, y, z):
        p = inv @ np.array([x, y, z, 1.0])
        return p[:3] / p[3]

    c0, c1 = unproject(0, 0, -1), unproject(0, 0, 1)
    fwd = c1 - c0
    fwd /= np.linalg.norm(fwd)
    r = unproject(1, 0, -1) - c0
    r -= fwd * (r @ fwd)
    r /= np.linalg.norm(r)
    u = np.cross(r, fwd)
    return r, u, -fwd
