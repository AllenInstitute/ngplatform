"""Rendering presets: a transfer function and the material and light around it.

A preset's transfer function is a list of stops, each a value, a colour
and an opacity, interpolated linearly between them.  Values are in one
of two domains:

* ``"data"``: the source's own values (Hounsfield units for a CT, the
  stored integers of an 8-bit image), for modalities whose values mean
  the same in every scan;
* ``"percentile"``: percentiles of the volume's tissue (its values above
  the background), for modalities whose values do not (MR, HiP-CT,
  histology, light-sheet), so one preset suits scans of different
  scaling; for a specimen in a mounting medium (volumes.medium_side), of
  the tissue alone (the volume's quantiles, the medium left out), and
  clear outside it;
* ``"window"``: fractions of a window of the data's values, 0 at its low
  end and 1 at its high end, for a specimen in a mounting medium (an
  organ scanned by HiP-CT), whose medium can fill most of the scan and
  sit above or below the tissue. The window is the page's (set as one
  sets a window in a viewer), or else a guess from the volume: from just
  past the medium seen at the scan's sides, with the tissue's commonest
  value at 0.5 (denser tissue, calcium or metal run past 1).

A "percentile" or "window" preset can name classes in the tissue (grey and
white matter; CSF too): each scan's classes are found from its own tissue
(class_splits), and each class of the preset is placed on the same class of
the scan, so the steps between them fall where each scan's are.

Presets are JSON (``presets/*.json`` here, or given whole by the app);
``Preset.from_dict`` reads one.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from . import kernels

HERE = Path(__file__).parent / "presets"

DEFAULT_ENV = {"top": [0.85, 0.9, 1.0], "horizon": [0.55, 0.55, 0.6], "bottom": [0.12, 0.11, 0.1], "scale": 0.6}


@dataclass
class Stop:
    value: float
    color: tuple[float, float, float]
    opacity: float
    tissue: str = ""  # what it colours, where a preset names it
    # The surface's gloss here (wet tissue is glossier than fat), when not the preset's own.
    specular: float | None = None
    roughness: float | None = None


@dataclass
class Preset:
    name: str
    domain: str = "percentile"  # "data" or "percentile"
    stops: list[Stop] = field(default_factory=list)
    density: float = 20.0  # extinction per mm at opacity 1
    shade_mix: float = 0.8
    gradient_scale: float = 40.0
    roughness: float = 0.45
    specular: float = 0.15
    phase_g: float = 0.0
    albedo: float = 0.9
    # Voxels inwards (along the gradient, to the more opaque side) at which a collision takes its
    # colour: a surface then shows the tissue beneath it, not the values between it and the
    # medium around it (0: the colour where it is).
    surface_inset: float = 0.0
    exposure: float = 1.0
    light_scale: float = 1.0
    environment: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_ENV))
    modality: str = ""  # what it is for: "CT", "MR", "HiP-CT", "histology", "light-sheet", "labels"
    description: str = ""
    window: list[float] | None = None  # data values at 0 and 1 of a "window" preset (else the volume's guess)
    organ: str = ""
    # Where the colours came from: photographs (title, page, author, licence) and the colours measured on them.
    reference: list[dict[str, Any]] = field(default_factory=list)
    measured: dict[str, Any] = field(default_factory=dict)  # tissue -> its colour on the photographs (sRGB), and which
    # The tissue's histogram on the scan the preset was made on: its values (window units) at volumes.QUANTILES.
    # With it, a "window" preset's stops follow each scan's own histogram (the same quantiles), not the
    # window's two anchors alone: HiP-CT values are not calibrated, but an organ's histogram keeps its shape.
    histogram: list[float] | None = None
    design_scan: str = ""  # the scan the preset was made on (its histogram)
    # Classes (grey and white matter; or CSF, grey and white matter): the tissue splits into them (class_splits),
    # and each class is matched to its own on another scan, so the steps between them stay at the splits; one
    # histogram matched whole carries the splits' percentiles instead, where another brain's are not. `split`: the
    # percentiles at which the preset's classes meet (a "percentile" preset states them; a "window" one has them
    # from its histogram).
    classes: int = 1
    split: list[float] | None = None

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Preset":
        d = dict(d)
        opt = lambda s, k: None if s.get(k) is None else float(s[k])  # noqa: E731
        stops = [Stop(float(s["value"]), tuple(float(c) for c in s["color"]), float(s["opacity"]), str(s.get("tissue", "")),
                      opt(s, "specular"), opt(s, "roughness")) for s in d.pop("stops", [])]
        env = dict(DEFAULT_ENV)
        env.update(d.pop("environment", {}) or {})
        known = {f for f in Preset.__dataclass_fields__}
        p = Preset(**{k: v for k, v in d.items() if k in known}, stops=stops, environment=env)
        if p.window is not None:
            w = [float(x) for x in p.window]
            if len(w) != 2 or not w[1] > w[0]:
                raise ValueError(f"preset {p.name!r}: window must be [low, high] with high > low")
            p.window = w
        if p.domain not in ("data", "percentile", "window"):
            raise ValueError(f"preset {p.name!r}: domain must be 'data', 'percentile' or 'window'")
        if p.classes not in (1, 2, 3):
            raise ValueError(f"preset {p.name!r}: classes must be 1, 2 or 3")
        if p.split is not None:
            p.split = [float(x) for x in (p.split if isinstance(p.split, (list, tuple)) else [p.split])]
            if len(p.split) != p.classes - 1 or any(b <= a for a, b in zip(p.split, p.split[1:])):
                raise ValueError(f"preset {p.name!r}: split must be {p.classes - 1} increasing percentiles")
        return p

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def key(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True)

    def with_overrides(self, **kw) -> "Preset":
        d = self.to_dict()
        d.update({k: v for k, v in kw.items() if v is not None})
        return Preset.from_dict(d)


def builtin() -> dict[str, Preset]:
    out: dict[str, Preset] = {}
    for path in sorted(HERE.glob("*.json")):
        for d in json.loads(path.read_text()):
            p = Preset.from_dict(d)
            out[p.name] = p
    return out


RANKS = np.arange(1.0, 100.0)  # the percentiles a tissue's quantiles are at (volumes.QUANTILES)


def class_splits(q, classes: int = 2) -> list[float]:
    """Where a tissue's values split into classes (2: grey and white matter; 3: CSF too): Otsu's thresholds on its
    values at percentiles 1..99, each of the same weight, over the 5th to the 95th (not the tails, where partial
    volume, vessels and the jar's wall are), each as the percentile between its two classes' nearest quantiles.
    Each class holds 3 quantiles at least; ties go to the first (the browser's classSplits does the same sums)."""
    t = [float(x) for x in np.asarray(q, np.float64)[4:95]]
    n = len(t)
    c = [0.0]
    for x in t:
        c.append(c[-1] + x)
    part = lambda a, b: (c[b] - c[a]) * (c[b] - c[a]) / (b - a)  # noqa: E731 (a class's share of the between-class variance)
    best, out = -1.0, [3]
    if classes == 2:
        for i in range(3, n - 2):
            s = part(0, i) + part(i, n)
            if s > best:
                best, out = s, [i]
    else:
        for i in range(3, n - 5):
            for j in range(i + 3, n - 2):
                s = part(0, i) + part(i, j) + part(j, n)
                if s > best:
                    best, out = s, [i, j]
    return [k + 4.5 for k in out]  # t[k - 1] is the (k + 4)th percentile, t[k] the (k + 5)th


def class_rank(r: float, design: list[float], scan: list[float], lo: float, hi: float) -> float:
    """A percentile on the preset's scan as the same place in its class on this scan: each class's span of
    percentiles (lo, the splits, hi) to its span here."""
    return float(np.interp(r, [lo, *design, hi], [lo, *scan, hi]))


def _tissue_percentile(p: float, preset: Preset, mine: np.ndarray) -> float:
    """A percentile of a specimen's tissue where it lies in a mounting medium: from the tissue's values alone (the
    volume's quantiles, the medium left out, as for matching histograms), past the 1st and 99th at their ends'
    slopes. The medium's cut also takes away what lies against it (a three-class preset's lowest class: partial
    volume at the surface, CSF), so there a preset's lowest two classes count as one."""
    if preset.classes > 1 and preset.split is not None:
        design = preset.split[1:] if preset.classes == 3 else preset.split
        p = class_rank(p, design, class_splits(mine, len(design) + 1), 0.0, 100.0)
    if p <= 1.0:
        return float(mine[0] - (1.0 - p) * (mine[1] - mine[0]))
    if p >= 99.0:
        return float(mine[-1] + (p - 99.0) * (mine[-1] - mine[-2]))
    return float(np.interp(p, RANKS, mine))


def _to_texture(value: float, preset: Preset, volume) -> float:
    """A stop's value as a texture value 0..1 of `volume`."""
    if preset.domain == "percentile" and getattr(volume, "medium", "") and getattr(volume, "quantiles", None):
        value = _tissue_percentile(value, preset, np.asarray(volume.quantiles, np.float64))
    elif preset.domain == "percentile":
        pc = volume.percentiles
        if not pc:
            raise ValueError("percentile presets need the volume's percentiles")
        ks = np.array(sorted(pc))
        vs = np.array([pc[k] for k in ks])
        if preset.classes > 1 and preset.split is not None:
            # Each class to its own: the scan's splits from its tissue's percentiles (at 1..99, between them as stored).
            value = class_rank(value, preset.split, class_splits(np.interp(RANKS, ks, vs), preset.classes), 0.0, 100.0)
        value = float(np.interp(value, ks, vs))
    elif preset.domain == "window":
        w = preset.window or getattr(volume, "window", None)
        if not w:
            raise ValueError("window presets need a window (the page's, or the volume's guess)")
        qs = getattr(volume, "quantiles", None)
        if preset.histogram and qs and not preset.window:
            # Histogram matching: the stop's quantile on the preset's scan, then this scan's value there;
            # past either end, the window's scale.
            ref = np.asarray(preset.histogram, np.float64)
            mine = np.asarray(qs, np.float64)
            width = w[1] - w[0]
            if value <= ref[0]:
                value = mine[0] + (value - ref[0]) * width
            elif value >= ref[-1]:
                value = mine[-1] + (value - ref[-1]) * width
            elif preset.classes > 1:
                # Each class matched to its own: the percentile on the preset's scan, moved within its class.
                design = preset.split if preset.split is not None else class_splits(ref, preset.classes)
                r = class_rank(float(np.interp(value, ref, RANKS)), design, class_splits(mine, preset.classes), 1.0, 99.0)
                value = float(np.interp(r, RANKS, mine))
            else:
                value = float(np.interp(value, ref, mine))
        else:
            value = w[0] + value * (w[1] - w[0])
    span = volume.hi - volume.lo
    return (value - volume.lo) / span if span else 0.0


def _placed(preset: Preset, volume) -> list[tuple[float, Stop]]:
    """The preset's stops at texture values of `volume`, in the preset's order. A percentile preset on a specimen in a mounting
    medium describes the tissue alone, so it is clear outside it, as the organ presets are: from the medium's edge
    of the window to 2.5 windows from it (past which is the jar's wall), closed at each end by a stop of opacity 0,
    after one holding the map's colour and opacity a tenth of a window (at the medium) or 0.3 (at the far end)
    inside; stops outside go."""
    out = [(_to_texture(s.value, preset, volume), s) for s in preset.stops]
    side, w = getattr(volume, "medium", ""), preset.window or getattr(volume, "window", None)
    if preset.domain != "percentile" or not side or not w or not getattr(volume, "quantiles", None) or not out:
        return out
    out.sort(key=lambda xs: xs[0])
    span = volume.hi - volume.lo
    tex = lambda v: (v - volume.lo) / span if span else 0.0  # noqa: E731
    W = w[1] - w[0]
    # (edge, inner) at each end, low end first.
    ends = [(tex(w[0]), tex(w[0] + 0.1 * W)), (tex(w[0] + 2.5 * W), tex(w[0] + 2.2 * W))] if side == "above" else \
        [(tex(w[1] - 2.5 * W), tex(w[1] - 2.2 * W)), (tex(w[1]), tex(w[1] - 0.1 * W))]
    xs = [x for x, _ in out]
    at = lambda x, f: float(np.interp(x, xs, [f(s) for _, s in out]))  # noqa: E731
    def stop(x: float, opacity: float | None) -> tuple[float, Stop]:
        near = min(out, key=lambda xs_: abs(xs_[0] - x))[1]
        col = tuple(at(x, lambda s, c=c: s.color[c]) for c in range(3))
        return x, Stop(near.value, col, at(x, lambda s: s.opacity) if opacity is None else opacity, near.tissue, near.specular, near.roughness)
    (e0, i0), (e1, i1) = ends
    return [stop(e0, 0.0), stop(i0, None)] + [(x, s) for x, s in out if i0 < x < i1] + [stop(i1, None), stop(e1, 0.0)]


def transfer_table(preset: Preset, volume) -> np.ndarray:
    """The preset's transfer function sampled at TF_SIZE texture values: (TF_SIZE * 4,) float32 r, g, b, opacity."""
    n = kernels.TF_SIZE
    t = np.linspace(0.0, 1.0, n)
    if not preset.stops:
        tab = np.zeros((n, 4), np.float32)
        tab[:, :3] = 1.0
        tab[:, 3] = t
        return tab.ravel()
    placed = sorted(_placed(preset, volume), key=lambda xs: xs[0])
    xs = np.array([x for x, _ in placed])
    cols = np.array([s.color for _, s in placed], np.float64)
    ops = np.array([s.opacity for _, s in placed], np.float64)
    tab = np.zeros((n, 4), np.float32)
    for c in range(3):
        tab[:, c] = np.interp(t, xs, cols[:, c])
    # Outside the stops the opacity is the end stop's (a preset ends at 0 to be transparent there).
    tab[:, 3] = np.interp(t, xs, ops)
    return tab.ravel()


def resolved(preset: Preset, volume) -> Preset:
    """The preset with its stops at this volume's data values ("data" domain): where its window (or
    histogram matching, or percentiles) puts them here. What the page's editor shows and moves."""
    span = volume.hi - volume.lo
    d = preset.to_dict()
    d.update(domain="data", window=None, histogram=None, classes=1, split=None)
    d["stops"] = [dict(asdict(st), value=volume.lo + x * span) for x, st in _placed(preset, volume)]
    return Preset.from_dict(d)


def histogram(q: np.ndarray, lo: float, hi: float, bins: int = 256) -> dict:
    """Counts of the volume's values (every 2nd voxel) in `bins` bins over its data range, for the page's editor:
    `lo` and `hi` the bins' outer edges, half a step of the stored values past the data values stored as 0
    and as the top, so each bin is centred on the values it counts."""
    top = 255 if q.dtype == np.uint8 else 65535
    h, _ = np.histogram(q[::2, ::2, ::2], bins=bins, range=(0, top + 1))
    half = (float(hi) - float(lo)) / top / 2
    return {"lo": float(lo) - half, "hi": float(hi) + half, "counts": h.tolist()}


def material_table(preset: Preset, volume) -> np.ndarray:
    """The surface's specular and roughness at TF_SIZE texture values: (TF_SIZE * 2,) float32, from the
    stops that give them (the preset's own elsewhere)."""
    n = kernels.TF_SIZE
    t = np.linspace(0.0, 1.0, n)
    tab = np.empty((n, 2), np.float32)
    tab[:, 0], tab[:, 1] = preset.specular, preset.roughness
    if preset.stops:
        placed = sorted(_placed(preset, volume), key=lambda xs: xs[0])
        xs = np.array([x for x, _ in placed])
        for k, name, own in ((0, "specular", preset.specular), (1, "roughness", preset.roughness)):
            v = np.array([getattr(s, name) if getattr(s, name) is not None else own for _, s in placed], np.float64)
            tab[:, k] = np.interp(t, xs, v)
    return tab.ravel()
