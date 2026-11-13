"""The path tracer on a CUDA GPU, through CuPy.

A `Renderer` holds one volume (and optionally a label volume) on the GPU
and renders views of it: `set_view` with the camera and the look (a
`RenderState`), then `step()` adds one sample to every pixel and
`image()` is the mean so far, tone-mapped.  Changing anything but the
sample count starts the mean again.
"""

from __future__ import annotations

import ctypes
import threading
import time
import weakref
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from . import kernels
from .presets import Preset, material_table, transfer_table

BRICK = 4  # majorant bricks: 4 voxels a side (8 took about 60% longer a pass, its majorants looser at surfaces)
DENOISE_UNTIL = 12


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
    window: tuple[float, float] | None = None  # the guessed window (data values), for "window" presets
    quantiles: list[float] | None = None  # the tissue's values at volumes.QUANTILES, for matching histograms
    medium: str = ""  # the specimen lies in a mounting medium, the tissue "above" or "below" it (volumes.medium_side)


@dataclass
class Detail:
    """A region of a finer level than the volume's, held beside it (see detail.py): values as the
    volume's (the same 0..1 scale), and the affine from its voxel index coordinates to world."""

    data: np.ndarray  # (nz, ny, nx), uint8 or uint16
    world_from_voxel: np.ndarray  # 4x4


@dataclass
class Labels:
    data: np.ndarray  # (nz, ny, nx) integer labels
    world_from_voxel: np.ndarray  # 4x4


@dataclass
class Objects:
    """Meshes drawn as surfaces and the image within them (objects.py), in place of the volume: their BVH and
    bricks (physical mm), each object's colour, and how they are drawn."""

    bvh: Any  # geometry.Bvh
    bricks: Any  # objects.ObjectBricks, or None: surfaces alone (a tractogram's tubes, points)
    colours: np.ndarray  # (objects, 3) 0..1
    world_from_physical: np.ndarray  # 4x4
    surface: float = 0.35  # the chance a path meeting a surface is scattered by it
    image: bool = True  # the image within the objects is a medium
    mix: float = 0.0  # how much the object's colour tints the image within it


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
    # Crops (up to 8): (lo, hi) in voxel coordinates, and True to keep the inside (False cuts it out).
    boxes: list[tuple[tuple[float, float, float], tuple[float, float, float], bool]] = field(default_factory=list)
    label_colors: dict[int, tuple[float, float, float, float]] | None = None  # label -> r, g, b, opacity scale
    keep_labels: set[int] = field(default_factory=set)  # labels left in place by cuts
    label_mix: float = 1.0
    background: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    max_bounces: int = 4
    denoise: bool = True  # filter the image while it has few samples (none from DENOISE_UNTIL samples on)
    aperture: float = 0.0
    focus: float = 0.0
    unit_mm: float = 1.0  # how many mm one world (display) unit is
    # A frame while the camera moves: approximate tracking through dense tissue, a voxel at a time
    # (kernels.track); it is not accumulated into a still view's samples.
    fast: float = 0.0  # > 0: the step, in voxels


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


@dataclass
class OnGpu:
    """A volume's texture and its bricks' bounds on the GPU: uploaded once (`upload`), and shared by every
    renderer of the same image and level (see gpu.Textures), which each keep only their own majorants."""

    tex: Any
    arr: Any
    bmin: Any
    bmax: Any
    grid: tuple[int, int, int]
    nbytes: int


@dataclass
class LabelsOnGpu:
    """A label volume on the GPU (each voxel's index among the distinct labels), shared as OnGpu is."""

    index: Any
    ids: np.ndarray
    nbytes: int


def bricks(shape) -> int:
    """How many majorant bricks a volume of `shape` (z, y, x) has."""
    return math.prod(-(-int(n) // BRICK) for n in shape)


def volume_bytes(shape, itemsize: int) -> int:
    """The GPU memory a volume's upload holds (its texture and its bricks' bounds), and what making the
    bounds takes for a while (a slab at a time)."""
    nz, ny, nx = (int(n) for n in shape)
    slab = (16 * BRICK + 2) * ny * nx * itemsize * 5
    return nz * ny * nx * itemsize + 8 * bricks(shape) + slab


def labels_bytes(shape) -> int:
    """The GPU memory a label volume's upload holds (an index of 2 bytes a voxel)."""
    return 2 * math.prod(int(n) for n in shape)


#: GPU memory a renderer takes for each pixel of its frame: the running mean, the depth, the image and
#: the denoiser's buffers while it filters.
BYTES_PER_PIXEL = 112
#: A renderer's own memory beyond its frame: its parameters, transfer table, light map and kernels' scratch.
RENDERER_OVERHEAD = 64 << 20


def renderer_bytes(width: int, height: int, shape=None) -> int:
    """The GPU memory one renderer takes of its own (the volume's upload is shared): its frame at
    `width` x `height`, the majorants of a volume of `shape` (z, y, x), and the rest."""
    return int(width) * int(height) * BYTES_PER_PIXEL + RENDERER_OVERHEAD + (4 * bricks(shape) if shape is not None else 0)


def upload(data: np.ndarray, device: int = 0) -> OnGpu:
    """`data` (z, y, x; uint8 or uint16) as a texture on the GPU, with its bricks' bounds."""
    cp = _cupy()
    with cp.cuda.Device(device):
        tex, arr = _tex_for(cp, data)
        bmin, bmax, grid = brick_bounds(cp, data)
        return OnGpu(tex, arr, bmin.ravel(), bmax.ravel(), grid, data.nbytes + 8 * bricks(data.shape))


def upload_labels(data: np.ndarray, device: int = 0) -> LabelsOnGpu:
    """A label volume on the GPU: its distinct labels and each voxel's index among them."""
    cp = _cupy()
    with cp.cuda.Device(device):
        ids, index = label_index(data)
        return LabelsOnGpu(cp.asarray(np.ascontiguousarray(index)), ids, labels_bytes(data.shape))


def brick_bounds(cp, data, brick: int = BRICK, slab_bricks: int = 16):
    """The least and greatest value (0..1) in each brick of `brick` voxels a side and the one voxel
    around it (a trilinear sample in the brick reads no further). `data` is a host (numpy) or GPU
    array; it goes to the GPU a slab of bricks at a time, so the memory this takes beyond the
    volume's texture is a slab's, not the volume's again.

    (Bricks once took their whole neighbours' extremes: one bright voxel of noise in a mounting
    medium then set the majorant of 27 bricks, 12 voxels a side, and a view through the medium
    took tens of times as long.)"""
    from cupyx.scipy import ndimage

    nz, ny, nx = data.shape
    scale = 255.0 if data.dtype == np.uint8 else 65535.0
    gz, gy, gx = (-(-n // brick) for n in (nz, ny, nx))
    mn = cp.empty((gz, gy, gx), cp.float32)
    mx = cp.empty((gz, gy, gx), cp.float32)
    for z0 in range(0, gz, slab_bricks):
        z1 = min(gz, z0 + slab_bricks)
        # The slab's voxels and one more on each side (z), so the filters see across slabs.
        a0, a1 = z0 * brick, min(nz, z1 * brick)
        h0, h1 = max(0, a0 - 1), min(nz, a1 + 1)
        v = cp.asarray(data[h0:h1])
        lo = ndimage.minimum_filter(v, size=3, mode="nearest")[a0 - h0:a0 - h0 + (a1 - a0)]
        hi = ndimage.maximum_filter(v, size=3, mode="nearest")[a0 - h0:a0 - h0 + (a1 - a0)]
        del v
        pad = [(0, (z1 - z0) * brick - (a1 - a0)), (0, gy * brick - ny), (0, gx * brick - nx)]
        if any(p[1] for p in pad):
            lo = cp.pad(lo, pad, mode="edge")
            hi = cp.pad(hi, pad, mode="edge")
        mn[z0:z1] = lo.reshape(z1 - z0, brick, gy, brick, gx, brick).min(axis=(1, 3, 5)).astype(cp.float32)
        mx[z0:z1] = hi.reshape(z1 - z0, brick, gy, brick, gx, brick).max(axis=(1, 3, 5)).astype(cp.float32)
        del lo, hi
    return mn / scale, mx / scale, (gx, gy, gz)


def label_index(data: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The distinct labels (sorted) and each voxel's index among them, as uint16.  Labels 0..65535
    are their own index; larger ones (Allen CCF's, say) are numbered in order."""
    lo, hi = int(data.min()), int(data.max())
    if lo >= 0 and hi < 65536:
        return np.arange(hi + 1, dtype=np.int64), data.astype(np.uint16, copy=False)
    ids, inverse = np.unique(data, return_inverse=True)
    if len(ids) > 65536:
        raise ValueError(f"{len(ids)} different labels: at most 65536 can be coloured")
    return ids.astype(np.int64), inverse.reshape(data.shape).astype(np.uint16)


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
        self.detail: Detail | None = None
        self._dtex = self._darr = self._dmaj = None
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
        # A pass is cut short by writing its number here: an int in host memory the GPU reads (step with stop).
        # Mapped and portable; with unified addressing (64-bit Linux and Windows) the GPU uses the same address.
        # Freed by close(), or when the renderer goes (the array over it names no owner, so nothing keeps the
        # renderer alive in a cycle).
        self._cut_host = cp.cuda.runtime.hostAlloc(4, 3)  # cudaHostAllocPortable | cudaHostAllocMapped
        self._free_host = weakref.finalize(self, cp.cuda.runtime.freeHost, self._cut_host)
        ctypes.c_int32.from_address(self._cut_host).value = 0
        self._cut = cp.ndarray((1,), cp.int32, cp.cuda.MemoryPointer(cp.cuda.UnownedMemory(self._cut_host, 4, None, device_id=device), 0))
        self.closed = False
        self._pass = 0
        self._tf_key: Any = None
        # What the majorant grids were last made from (the transfer function and density): a new camera alone
        # leaves them as they are.
        self._maj_key: Any = None
        self._dmaj_key: Any = None
        self._label_ids = np.zeros(0, np.int64)
        self._env_tex = None
        self._env_arr = None
        self._env_name: str | None = None
        self.objects: Objects | None = None
        self._obj_gpu: dict[str, Any] | None = None
        self._tf_host: np.ndarray | None = None

    # ------------------------------------------------------------ data
    def set_volume(self, volume: Volume, on_gpu: OnGpu | None = None) -> None:
        """The volume to render; uploaded here, or `on_gpu`: its upload, shared with other renderers."""
        cp = self.cp
        with self.lock, self.device:
            g = on_gpu if on_gpu is not None else upload(volume.data, self.device.id)
            self._tex, self._arr = g.tex, g.arr
            self._bmin, self._bmax, self._grid = g.bmin, g.bmax, g.grid
            self._maj = cp.zeros(g.bmin.size, cp.float32)
            self.volume = volume
            self._tf_key = None
            self._maj_key = None
            self.reset()

    def set_detail(self, detail: Detail | None) -> None:
        """Hold a finer level's region (or none); takes effect at the next set_view."""
        cp = self.cp
        with self.lock, self.device:
            self.detail = None
            self._dtex = self._darr = self._dmaj = self._dbmin = self._dbmax = None
            self._dmaj_key = None
            if detail is None:
                return
            tex, arr = _tex_for(cp, detail.data)
            bmin, bmax, grid = brick_bounds(cp, detail.data)
            self._dtex, self._darr = tex, arr
            self._dbmin, self._dbmax, self._dgrid = bmin.ravel(), bmax.ravel(), grid
            self._dmaj = cp.zeros(bmin.size, cp.float32)
            self.detail = detail

    def set_objects(self, objects: Objects | None) -> None:
        """Draw objects (their meshes, and the image within them) in place of the volume, or the volume again
        (None); takes effect at the next set_view.  The bricks are uploaded here."""
        cp = self.cp
        with self.lock, self.device:
            self.objects, self._obj_gpu = None, None
            if objects is None:
                return
            b = objects.bricks
            tex, arr = _tex_for(cp, b.atlas if b is not None else np.zeros((1, 1, 1), np.uint8))
            self._obj_gpu = {
                "tex": tex, "arr": arr, "top": cp.asarray(np.ascontiguousarray(b.top, np.int32) if b is not None else np.full(1, -1, np.int32)),
                "sub": cp.asarray(np.ascontiguousarray(b.sub, np.int32) if b is not None else np.full(1, -1, np.int32)),
                "col": cp.asarray(np.ascontiguousarray(objects.colours, np.float32).ravel() if len(objects.colours) else np.ones(3, np.float32)),
            }
            self.objects = objects

    def _objects_volume(self) -> Volume:
        """The volume as a preset is placed on it, with the values inside the objects in place of the whole's."""
        v, b = self.volume, self.objects.bricks
        if b is None:
            return v
        to_data = lambda t: v.lo + t * (v.hi - v.lo)  # noqa: E731
        pct = {k: to_data(t) for k, t in b.percentiles.items()} or v.percentiles
        win = (to_data(b.window[0]), to_data(b.window[1])) if b.window else v.window
        return Volume(v.data, v.world_from_voxel, v.lo, v.hi, pct, win, None, "")

    def set_object_look(self, surface: float, image: bool, mix: float) -> None:
        """How the objects are drawn (surfaces, the image within them, its tint); takes effect at the next set_view."""
        if self.objects is not None:
            self.objects.surface, self.objects.image, self.objects.mix = float(surface), bool(image), float(mix)

    def set_labels(self, labels: Labels | None, on_gpu: LabelsOnGpu | None = None) -> None:
        """The labels to colour by (or none); uploaded here, or `on_gpu`: their upload, shared."""
        with self.lock, self.device:
            if labels is None:
                self.labels, self._lab = None, None
                self._label_ids = np.zeros(0, np.int64)
            else:
                self.labels = labels
                g = on_gpu if on_gpu is not None else upload_labels(labels.data, self.device.id)
                self._label_ids = g.ids
                self._lab = g.index
            self._lut_key = None
            self.reset()

    # ------------------------------------------------------------ view
    def set_fast(self, step: float) -> None:
        """Fast tracking (steps of `step` voxels through dense bricks), or exact tracking (0), for the passes to come."""
        with self.lock, self.device:
            self._params[kernels.OFFSETS["FAST"]] = float(step)

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
            packed = self._pack(state)
            self._params = cp.asarray(packed)
            key = (state.preset.key(), self.volume.lo, self.volume.hi, id(self.objects))
            if key != self._tf_key:
                # Colour and opacity, then (after TF_SIZE of them) the surface's specular and roughness.
                # With objects, the preset is placed on the values inside them (their percentiles and window).
                placed = self._objects_volume() if self.objects is not None else self.volume
                self._tf_host = np.concatenate([transfer_table(state.preset, placed), material_table(state.preset, placed)])
                self._tf = cp.asarray(self._tf_host)
                self._tf_key = key
                if self.objects is not None:
                    packed = self._pack(state)
                    self._params = cp.asarray(packed)
            self._update_lut(state)
            self._set_env(state.preset.environment.get("map") or None)
            # The first opaque point of each pixel: the denoiser's guide, and the depth the page draws with.
            self._depth_gpu = cp.zeros((H, W, 2), cp.float32)
            mkey = (self._tf_key, float(packed[kernels.OFFSETS["DENSITY"]]))
            if mkey != self._maj_key:
                n = self._bmin.size
                _kernels().get_function("majorant")((-(-n // 256),), (256,), (self._params, self._tf, self._bmin, self._bmax, self._maj, np.int32(n)))
                self._maj_key = mkey
            if self.detail is not None and mkey != self._dmaj_key:
                n = self._dbmin.size
                _kernels().get_function("majorant")((-(-n // 256),), (256,), (self._params, self._tf, self._dbmin, self._dbmax, self._dmaj, np.int32(n)))
                self._dmaj_key = mkey
            if self.objects is not None and self.objects.bricks is not None:
                _kernels().get_function("firsthit_obj")((-(-W // 16), -(-H // 8)), (16, 8), self._geo_args() + (self._depth_gpu, np.int32(W), np.int32(H)))
            else:
                _kernels().get_function("firsthit")((-(-W // 16), -(-H // 8)), (16, 8), self._args() + (self._depth_gpu, np.int32(W), np.int32(H)))
            self.reset()

    def _update_lut(self, state: RenderState) -> None:
        cp = self.cp
        if self.labels is None or state.label_colors is None:
            if self._lut is None:
                self._lut = cp.zeros(4, cp.float32)
                self._lutflags = cp.zeros(1, cp.float32)
            self._nlut = 0
            return
        # One entry per distinct label in the volume (the GPU holds each voxel's index among them).
        ids = self._label_ids
        top = max(len(ids), 1)
        lut = np.zeros((top, 4), np.float32)
        lut[:, 0] = -1.0  # labels not given (0 among them) leave the image's own colour and opacity
        flags = np.zeros(top, np.float32)

        def where(k: int) -> int:
            i = int(np.searchsorted(ids, k))
            return i if i < len(ids) and ids[i] == k else -1

        for k, (r, g, b, a) in state.label_colors.items():
            i = where(int(k))
            if i >= 0:
                lut[i] = (r, g, b, a)
        for k in state.keep_labels:
            i = where(int(k))
            if i >= 0:
                flags[i] = 1.0
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
        det = self.detail
        if det is not None:
            dwfv = np.asarray(det.world_from_voxel, np.float64)
            dvfw = np.linalg.inv(dwfv)
            P[O["DETAIL"]] = 1
            P[O["DETAIL_FROM_WORLD"]:O["DETAIL_FROM_WORLD"] + 12] = dvfw[:3, :4].ravel()
            P[O["DETAIL_NORMAL"]:O["DETAIL_NORMAL"] + 9] = dvfw[:3, :3].T.ravel()
            dz, dy, dx = det.data.shape
            P[O["DETAIL_DIMS"]:O["DETAIL_DIMS"] + 3] = (dx, dy, dz)
            P[O["DETAIL_MGRID"]:O["DETAIL_MGRID"] + 3] = self._dgrid
            P[O["DETAIL_GSCALE"]] = abs(np.linalg.det(wfv[:3, :3]) / np.linalg.det(dwfv[:3, :3])) ** (1 / 3)
        pr = s.preset
        # Density is given per mm; the world unit is unit_mm mm.
        P[O["DENSITY"]] = pr.density * s.unit_mm
        P[O["SHADE_MIX"]] = pr.shade_mix
        P[O["GRAD_SCALE"]] = pr.gradient_scale
        P[O["ROUGHNESS"]] = pr.roughness
        P[O["SPECULAR"]] = pr.specular
        P[O["PHASE_G"]] = pr.phase_g
        P[O["ALBEDO"]] = pr.albedo
        P[O["INSET"]] = pr.surface_inset
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
        if env.get("map"):
            # The light map turns with the camera (as the key light does), about its up, by `rotation`.
            P[O["ENVMAP"]] = 1
            P[O["ENV_RIGHT"]:O["ENV_RIGHT"] + 3] = right
            P[O["ENV_BACK"]:O["ENV_BACK"] + 3] = back
            P[O["ENV_ROT"]] = np.radians(float(env.get("rotation", 0.0)))
        P[O["BG"]:O["BG"] + 4] = s.background
        P[O["EXPOSURE"]] = pr.exposure
        P[O["MAX_BOUNCES"]] = s.max_bounces
        P[O["FAST"]] = float(s.fast)
        clips = list(s.clips)[:6]
        P[O["NCLIP"]] = len(clips)
        for i, c in enumerate(clips):
            P[O["CLIPS"] + 4 * i:O["CLIPS"] + 4 * i + 4] = c
        lo, hi = s.crop if s.crop is not None else ((-1e9,) * 3, (1e9,) * 3)
        P[O["CROP_LO"]:O["CROP_LO"] + 3] = lo
        boxes = s.boxes[:8]
        P[O["NBOX"]] = len(boxes)
        for i, (blo, bhi, keep) in enumerate(boxes):
            P[O["BOXES"] + 7 * i:O["BOXES"] + 7 * i + 7] = (*blo, *bhi, 1.0 if keep else -1.0)
        P[O["CROP_HI"]:O["CROP_HI"] + 3] = hi
        if self.labels is not None and s.label_colors is not None:
            P[O["HAS_LABELS"]] = 1
            lfw = np.linalg.inv(np.asarray(self.labels.world_from_voxel, np.float64))
            P[O["LABEL_FROM_WORLD"]:O["LABEL_FROM_WORLD"] + 12] = lfw[:3, :4].ravel()
            lz, ly, lx = self.labels.data.shape
            P[O["LDIMS"]:O["LDIMS"] + 3] = (lx, ly, lz)
            P[O["NLUT"]] = max(len(self._label_ids), 1)
            P[O["LABEL_MIX"]] = s.label_mix
        P[O["STEP"]] = 0.5
        P[O["APERTURE"]] = s.aperture
        P[O["FOCUS"]] = s.focus
        P[O["OPAQUE_LIMIT"]] = 0.5
        if self.objects is not None:
            self._pack_objects(P, s, inv)
        return P

    def _pack_objects(self, P: np.ndarray, s: RenderState, inv: np.ndarray) -> None:
        from . import objects as omod

        O = kernels.OFFSETS
        ob = self.objects
        assert ob is not None
        b = ob.bricks
        wfp = np.asarray(ob.world_from_physical, np.float64)
        pfw = np.linalg.inv(wfp)
        P[O["OBJ"]] = 1
        P[O["OBJ_PHYS_FROM_WORLD"]:O["OBJ_PHYS_FROM_WORLD"] + 12] = pfw[:3, :4].ravel()
        P[O["OBJ_SURF"]] = min(max(ob.surface, 0.0), 1.0)
        # A thousandth of the scene's size, how far past a surface a path goes on (without bricks: their voxel's).
        span = float(np.linalg.norm(np.asarray(ob.bvh.hi) - np.asarray(ob.bvh.lo))) * abs(np.linalg.det(wfp[:3, :3])) ** (1 / 3)
        P[O["OBJ_EPS"]] = 1e-6 * max(span, 1e-12)
        eye = inv @ np.array([0.0, 0.0, -1.0, 1.0])
        eye = (pfw @ np.append(eye[:3] / eye[3], 1.0))[:3]
        if b is None:
            P[O["OBJ_EM"]] = 0.0
            P[O["OBJ_PAGE"]:O["OBJ_PAGE"] + 3] = (1, 1, 1)
            P[O["OBJ_TOPDIMS"]:O["OBJ_TOPDIMS"] + 3] = (1, 1, 1)
            P[O["OBJ_ATLAS"]:O["OBJ_ATLAS"] + 3] = (1, 1, 1)
            P[O["OBJ_EYE_INSIDE"]] = 0.0
            return
        wfv = wfp @ np.asarray(b.phys_from_voxel, np.float64)
        vfw = np.linalg.inv(wfv)
        P[O["OBJ"]] = 1
        P[O["OBJ_PHYS_FROM_WORLD"]:O["OBJ_PHYS_FROM_WORLD"] + 12] = pfw[:3, :4].ravel()
        P[O["OBJ_VOX_FROM_WORLD"]:O["OBJ_VOX_FROM_WORLD"] + 12] = vfw[:3, :4].ravel()
        P[O["OBJ_NORMAL"]:O["OBJ_NORMAL"] + 9] = vfw[:3, :3].T.ravel()
        P[O["OBJ_PAGE"]:O["OBJ_PAGE"] + 3] = b.page
        P[O["OBJ_ORIGIN"]:O["OBJ_ORIGIN"] + 3] = b.origin
        P[O["OBJ_TOPDIMS"]:O["OBJ_TOPDIMS"] + 3] = b.top.shape[::-1]
        P[O["OBJ_ATLAS"]:O["OBJ_ATLAS"] + 3] = b.atlas_grid
        # The majorant: the density times the greatest opacity over the values the bricks hold.
        tf = self._tf_host
        lo, hi = b.value_range
        if tf is not None and hi >= lo:
            a = int(np.floor(lo * (kernels.TF_SIZE - 1))), int(np.ceil(hi * (kernels.TF_SIZE - 1)))
            P[O["OBJ_MAJ"]] = P[O["DENSITY"]] * float(tf[4 * a[0] + 3:4 * a[1] + 4:4].max(initial=0.0))
        P[O["OBJ_SURF"]] = min(max(ob.surface, 0.0), 1.0)
        P[O["OBJ_EM"]] = 1.0 if ob.image else 0.0
        P[O["OBJ_MIX"]] = min(max(ob.mix, 0.0), 1.0)
        vox = abs(np.linalg.det(wfv[:3, :3])) ** (1 / 3)
        P[O["OBJ_EPS"]] = 1e-3 * vox
        # Whether the camera is in an object: the parity of a ray's crossings from it.
        eye = inv @ np.array([0.0, 0.0, -1.0, 1.0])
        eye = (pfw @ np.append(eye[:3] / eye[3], 1.0))[:3]
        P[O["OBJ_EYE_INSIDE"]] = 1.0 if bool(omod.inside_points(ob.bvh, eye[None])[0]) else 0.0

    # ------------------------------------------------------------ passes
    def _args(self):
        cp = self.cp
        lab = self._lab if self._lab is not None else cp.zeros(1, cp.uint16)
        if self._env_tex is None:
            self._set_env(None)
        if self.detail is not None:
            det, dmaj = self._dtex, self._dmaj
        else:
            det, dmaj = self._tex, self._maj  # unused (P_DETAIL is 0), but the kernels take them
        # Surfaces drawn with the volume: objects without an image within them (tubes, spheres, meshes), else none.
        if self.objects is not None and self.objects.bricks is None:
            g, o = self.objects.bvh, self._obj_gpu
            geo = (g.tris, g.kind if g.kind is not None else np.uintp(0), g.tobj, g.nodes, g.kids, np.int32(g.n), o["col"])
        else:
            z = np.uintp(0)
            geo = (z, z, z, z, z, np.int32(0), z)
        return (self._params, self._tex, self._tf, self._maj, lab, self._lut, self._lutflags, self._env_tex, det, dmaj) + geo

    def _geo_args(self):
        g = self.objects.bvh
        return (self._params, g.tris, g.kind if g.kind is not None else np.uintp(0), g.tobj, g.nodes, g.kids, np.int32(g.n))

    def _obj_args(self):
        g, o = self.objects.bvh, self._obj_gpu
        if self._env_tex is None:
            self._set_env(None)
        return (self._params, self._tf, self._env_tex, g.tris, g.kind if g.kind is not None else np.uintp(0), g.tobj, g.nodes, g.kids, np.int32(g.n), o["tex"], o["top"], o["sub"], o["col"])

    def _set_env(self, name: str | None) -> None:
        """The light map on the GPU (a 2 x 1 black one when there is none, so the kernels always have a texture)."""
        from cupy.cuda import runtime, texture

        from .lightmaps import load

        if name == self._env_name and self._env_tex is not None:
            return
        img = np.minimum(load(name), 64.0) if name else np.zeros((1, 2, 3), np.float32)  # suns clamped: no fireflies
        h, w = img.shape[:2]
        rgba = np.concatenate([img, np.ones((h, w, 1), np.float32)], axis=2).astype(np.float32)
        desc = texture.ChannelFormatDescriptor(32, 32, 32, 32, runtime.cudaChannelFormatKindFloat)
        arr = texture.CUDAarray(desc, w, h)
        arr.copy_from(np.ascontiguousarray(rgba).reshape(h, w * 4))  # CuPy takes the channels flattened along a row
        res = texture.ResourceDescriptor(runtime.cudaResourceTypeArray, cuArr=arr)
        tdesc = texture.TextureDescriptor(
            addressModes=(runtime.cudaAddressModeWrap, runtime.cudaAddressModeClamp),
            filterMode=runtime.cudaFilterModeLinear, readMode=runtime.cudaReadModeElementType, normalizedCoords=1,
        )
        self._env_tex, self._env_arr, self._env_name = texture.TextureObject(res, tdesc), arr, name

    def step(self, n: int = 1, stop=None) -> int:
        """Adds n samples per pixel; returns the samples so far. With `stop` (a function), `stop()` is
        asked while each pass runs: when it is true the pass is cut short and not counted (the view has
        changed; set_view starts again). Each pass is one launch over the whole frame (passes in bands of
        rows left the GPU idle at the end of every band, waiting for its slowest paths)."""
        s = self._state
        if s is None:
            raise RuntimeError("no view")
        cp = self.cp
        with self.lock, self.device:
            W, H = s.width, s.height
            # Objects with an image within them are drawn alone; surfaces alone are drawn with the volume.
            objects = self.objects is not None and self.objects.bricks is not None
            f = _kernels().get_function("trace_obj" if objects else "trace")
            O = kernels.OFFSETS["FRAME"]
            for _ in range(n):
                self._frame += 1
                self._pass += 1
                self._params[O] = float(self._frame % 16777216)
                args = self._obj_args() if objects else self._args()
                f((-(-W // 16), -(-H // 8)), (16, 8), args + (self._accum, np.int32(W), np.int32(H), self._cut, np.int32(self._pass)))
                if stop is not None:
                    done = cp.cuda.Event(disable_timing=True)
                    done.record()
                    while True:
                        if stop():
                            ctypes.c_int32.from_address(self._cut_host).value = self._pass
                            done.synchronize()
                            return self.samples
                        if done.done:
                            break
                        time.sleep(0.0005)
                self.samples += 1
            return self.samples

    def step_beside(self, n: int, cancelled=None) -> int:
        """`step(n)` for work beside the interactive view (movies, stills, splats): a pass at a time, each
        waited for before the next is queued, so the view's own passes (on the same GPU queue) wait for at
        most one of these, not for all n. With `cancelled` (a function), stops between passes when true."""
        cp = self.cp
        for _ in range(n):
            if cancelled is not None and cancelled():
                break
            self.step(1)
            with self.device:
                done = cp.cuda.Event(disable_timing=True)
                done.record()
            while not done.done:
                time.sleep(0.001)
        return self.samples

    def image(self, premultiplied: bool = True):
        """The mean so far, tone-mapped: (H, W, 4) uint8, premultiplied alpha; or (not premultiplied)
        the colour divided by the alpha, (H, W, 3) uint8, and the alpha, (H, W) uint8 (made on the GPU)."""
        cp = self.cp
        s = self._state
        assert s is not None
        with self.lock, self.device:
            W, H = s.width, s.height
            out = cp.zeros((H, W, 4), cp.uint8)
            src, inv_n = self._accum, np.float32(1.0 / max(self.samples, 1))
            if s.denoise and 0 < self.samples < DENOISE_UNTIL:
                mean = self._accum * inv_n
                a, b = mean, cp.empty_like(mean)
                f = _kernels().get_function("atrous")
                for it, step in enumerate((1, 2, 4)):
                    f((-(-W // 16), -(-H // 8)), (16, 8), (a, b, self._depth_gpu, np.int32(W), np.int32(H), np.int32(step), np.float32(0.3 / 2**it), np.float32(1.0 / max(s.unit_mm, 1e-6))))
                    a, b = b, a
                # Less of the filtered image as samples come: none at DENOISE_UNTIL.
                keep = self.samples / DENOISE_UNTIL
                src, inv_n = a * (1 - keep) + mean * keep, np.float32(1.0)
            _kernels().get_function("tonemap")(
                (-(-W // 16), -(-H // 8)), (16, 8),
                (src, inv_n, np.float32(s.preset.exposure), out, np.int32(W), np.int32(H)),
            )
            if premultiplied:
                return cp.asnumpy(out)
            a = out[..., 3:4].astype(cp.uint16)
            rgb = cp.where(a > 0, cp.minimum((out[..., :3].astype(cp.uint16) * 255 + a // 2) // cp.maximum(a, 1), 255), 0).astype(cp.uint8)
            return cp.asnumpy(rgb), cp.asnumpy(out[..., 3])

    def depth(self) -> np.ndarray:
        """(H, W, 2) float32: GL depth 0..1 where the view first becomes mostly opaque (1: nothing), and the world distance (-1)."""
        cp = self.cp
        s = self._state
        assert s is not None
        with self.lock, self.device:
            W, H = s.width, s.height
            return cp.asnumpy(self._depth_gpu)

    def synchronize(self) -> None:
        with self.device:
            self.cp.cuda.Stream.null.synchronize()

    def close(self) -> None:
        """Lets go of everything this renderer holds on the GPU and its pinned host memory (an upload shared with
        other renderers stays theirs). Once the work queued is done; the renderer cannot be used after."""
        if self.closed:
            return
        with self.lock, self.device:
            self.cp.cuda.Stream.null.synchronize()
            self.closed = True
            for k in ("_tex", "_arr", "_bmin", "_bmax", "_maj", "_lab", "_lut", "_lutflags", "_tf", "_accum", "_params",
                      "_dtex", "_darr", "_dmaj", "_dbmin", "_dbmax", "_env_tex", "_env_arr", "_depth_gpu", "_cut"):
                setattr(self, k, None)
            self.volume = self.detail = self.labels = self.objects = None
            self._obj_gpu = None
            self._state = None
        self._free_host()


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
