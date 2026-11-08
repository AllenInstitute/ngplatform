"""Label colours from FreeSurfer-style lookup tables (``id name r g b a`` per line)."""

from __future__ import annotations

from pathlib import Path


def read_lut(path: str | Path) -> dict[int, tuple[str, tuple[float, float, float]]]:
    out: dict[int, tuple[str, tuple[float, float, float]]] = {}
    for line in Path(path).read_text().splitlines():
        parts = line.split()
        if len(parts) < 5 or line.lstrip().startswith("#") or not parts[0].isdigit():
            continue
        out[int(parts[0])] = (parts[1], (int(parts[2]) / 255.0, int(parts[3]) / 255.0, int(parts[4]) / 255.0))
    return out


def freesurfer() -> dict[int, tuple[str, tuple[float, float, float]]]:
    """The FreeSurfer colour table that comes with ngplatform (data/lookup-tables), when it is there."""
    here = Path(__file__).resolve()
    for root in here.parents:
        p = root / "data" / "lookup-tables" / "FreeSurferColorLUT.txt"
        if p.is_file():
            return read_lut(p)
    return {}
