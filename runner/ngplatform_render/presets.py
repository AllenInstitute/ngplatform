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
  scaling;
* ``"window"``: fractions of a window of the data's values, 0 at its low
  end and 1 at its high end, for a specimen in a mounting medium (an
  organ scanned by HiP-CT), whose medium can fill most of the scan and
  sit above or below the tissue. The window is the page's (set as one
  sets a window in a viewer), or else a guess from the volume: from just
  past the medium seen at the scan's sides, with the tissue's commonest
  value at 0.5 (denser tissue, calcium or metal run past 1).

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

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Preset":
        d = dict(d)
        stops = [Stop(float(s["value"]), tuple(float(c) for c in s["color"]), float(s["opacity"]), str(s.get("tissue", ""))) for s in d.pop("stops", [])]
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


def _to_texture(value: float, preset: Preset, volume) -> float:
    """A stop's value as a texture value 0..1 of `volume`."""
    if preset.domain == "percentile":
        pc = volume.percentiles
        if not pc:
            raise ValueError("percentile presets need the volume's percentiles")
        ks = np.array(sorted(pc))
        vs = np.array([pc[k] for k in ks])
        value = float(np.interp(value, ks, vs))
    elif preset.domain == "window":
        w = preset.window or getattr(volume, "window", None)
        if not w:
            raise ValueError("window presets need a window (the page's, or the volume's guess)")
        value = w[0] + value * (w[1] - w[0])
    span = volume.hi - volume.lo
    return (value - volume.lo) / span if span else 0.0


def transfer_table(preset: Preset, volume) -> np.ndarray:
    """The preset's transfer function sampled at TF_SIZE texture values: (TF_SIZE * 4,) float32 r, g, b, opacity."""
    n = kernels.TF_SIZE
    t = np.linspace(0.0, 1.0, n)
    if not preset.stops:
        tab = np.zeros((n, 4), np.float32)
        tab[:, :3] = 1.0
        tab[:, 3] = t
        return tab.ravel()
    xs = np.array([_to_texture(s.value, preset, volume) for s in preset.stops])
    order = np.argsort(xs, kind="stable")
    xs = xs[order]
    cols = np.array([preset.stops[i].color for i in order], np.float64)
    ops = np.array([preset.stops[i].opacity for i in order], np.float64)
    tab = np.zeros((n, 4), np.float32)
    for c in range(3):
        tab[:, c] = np.interp(t, xs, cols[:, c])
    # Outside the stops the opacity is the end stop's (a preset ends at 0 to be transparent there).
    tab[:, 3] = np.interp(t, xs, ops)
    return tab.ravel()
