"""The kinds of job the runner starts.  Nothing else runs: no shell, no commands.

Each kind checks the arguments a request gives (paths under the roots, the
right file types, numbers in range) and turns them into the module a job
process runs and its arguments, the outputs it will write, and how to read
its progress from its log.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .paths import PathRefused, Roots, is_store

TRACTOGRAMS = (".trk", ".tck", ".trx")
STORES = (".zarr", ".zarrvectors", ".zv")
NIFTI = (".nii", ".nii.gz")
# What zvtools virtual serve reads.
SERVABLE = (".trk", ".tck", ".trx", ".obj", ".stl", ".ply", ".gii", ".swc", ".csv", ".tsv", ".xyz")

PROGRESS = re.compile(r"^\[progress\]\s+([0-9.]+)\s*(.*)$")


class BadRequest(ValueError):
    """Arguments a kind does not accept."""


@dataclass
class Plan:
    """What a job process runs, and what it writes."""

    module: str
    argv: list[str]
    title: str
    outputs: list[dict[str, str]]
    #: Files to write into the job's folder before it starts: name -> text.
    files: dict[str, str] = field(default_factory=dict)
    #: The arguments as the job list shows them (large values left out).
    shown: dict[str, Any] = field(default_factory=dict)


def progress_line(line: str) -> tuple[float, str] | None:
    """A ``[progress] 0.42 message`` line, which the runner's own tasks print."""
    m = PROGRESS.match(line.strip())
    if m is None:
        return None
    try:
        value = float(m.group(1))
    except ValueError:
        return None
    return max(0.0, min(1.0, value)), m.group(2).strip()


# zvtools convert's phases (a .trk ingest), and the share of the work done when each starts.
_CONVERT_PHASES = [
    (re.compile(r"^Phase 0"), 0.01, "Reading the header"),
    (re.compile(r"^Phase 1"), 0.03, "Indexing the streamlines"),
    (re.compile(r"^Phase A"), 0.10, "Binning streamlines into chunks"),
    (re.compile(r"^Creating zarr-vectors store"), 0.45, "Creating the store"),
    (re.compile(r"^Phase B"), 0.50, "Writing level 0"),
    (re.compile(r"^Coordinator"), 0.70, "Writing the object index and links"),
    (re.compile(r"^Phase 6"), 0.80, "Building the coarser levels"),
    (re.compile(r"^Done\."), 0.97, "Finishing"),
    (re.compile(r"^ingested "), 0.99, "Written"),
]


def convert_progress(line: str) -> tuple[float, str] | None:
    found = progress_line(line)
    if found is not None:
        return found
    for pattern, value, message in _CONVERT_PHASES:
        if pattern.match(line.strip()):
            return value, message
    return None


def _bool(args: dict, key: str, default: bool = False) -> bool:
    value = args.get(key, default)
    if not isinstance(value, bool):
        raise BadRequest(f"{key} must be true or false")
    return value


def _int(args: dict, key: str, default: int, lo: int, hi: int) -> int:
    value = args.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise BadRequest(f"{key} must be a whole number from {lo} to {hi}")
    return value


def _float(args: dict, key: str, default: float, lo: float, hi: float) -> float:
    value = args.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi:
        raise BadRequest(f"{key} must be a number from {lo} to {hi}")
    return float(value)


def _text(args: dict, key: str) -> str | None:
    value = args.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise BadRequest(f"{key} must be text")
    return value


def _input(roots: Roots, args: dict) -> Path:
    path = _text(args, "input")
    if path is None:
        raise BadRequest("input is missing")
    resolved = roots.existing(path)
    if resolved.is_dir():
        if not is_store(resolved):
            raise BadRequest(f"{path} is a folder but not a Zarr store")
    elif not resolved.name.lower().endswith(TRACTOGRAMS):
        raise BadRequest(f"{path}: the input must be a tractogram ({', '.join(TRACTOGRAMS)}) or a Zarr Vectors store")
    return resolved


def _sparsity(levels: int) -> list[str]:
    return ["--sparsity", ",".join(["2"] * levels)] if levels > 0 else []


def _filter_document(args: dict) -> str:
    doc = args.get("filter")
    if not isinstance(doc, dict) or doc.get("format") != "zvf-predicate" or not isinstance(doc.get("tree"), dict):
        raise BadRequest('filter must be a zvf-predicate document: {"format": "zvf-predicate", "version": 1, "tree": {...}}')
    return json.dumps(doc)


def _leaves(tree: Any) -> int:
    if not isinstance(tree, dict):
        return 0
    if "args" in tree:
        return sum(_leaves(a) for a in tree["args"])
    if "arg" in tree:
        return _leaves(tree["arg"])
    return 1


def plan_convert(roots: Roots, args: dict) -> Plan:
    source = _input(roots, args)
    if source.is_dir():
        raise BadRequest("convert reads a tractogram file; the input is a store already")
    overwrite = _bool(args, "overwrite")
    output = roots.output(_text(args, "output") or "", suffixes=STORES, overwrite=overwrite)
    levels = _int(args, "levels", 3, 0, 8)
    argv = ["convert", str(source), str(output), *_sparsity(levels)]
    chunk = args.get("chunk_shape")
    if chunk is not None:
        if not (isinstance(chunk, list) and len(chunk) == 3 and all(isinstance(c, (int, float)) and not isinstance(c, bool) and c > 0 for c in chunk)):
            raise BadRequest("chunk_shape must be three positive numbers")
        argv += ["--chunk-shape", ",".join(str(c) for c in chunk)]
    elif not source.name.lower().endswith(".trk"):
        # zvtools needs a chunk shape for every format but .trk.
        argv += ["--chunk-shape", "32,32,32"]
    if overwrite:
        argv.append("--overwrite")
    return Plan(
        module="zarr_vectors_tools",
        argv=argv,
        title=f"Convert {source.name}",
        outputs=[{"path": str(output), "type": "zarr-vectors"}],
        shown={"input": str(source), "output": str(output), "levels": levels, "overwrite": overwrite},
    )


def plan_filter(roots: Roots, args: dict, *, density_only: bool = False) -> Plan:
    source = _input(roots, args)
    overwrite = _bool(args, "overwrite")
    document = _filter_document(args)
    argv = [str(source), "--filter", "{job}/filter.json"]
    outputs: list[dict[str, str]] = []
    shown: dict[str, Any] = {"input": str(source), "filter": f"{_leaves(json.loads(document)['tree'])} leaves"}
    if density_only:
        out = roots.output(_text(args, "output") or "", suffixes=NIFTI, overwrite=overwrite)
        voxel = _float(args, "voxel", 1.0, 0.01, 100.0)
        argv += ["--density", str(out), "--voxel", str(voxel)]
        outputs.append({"path": str(out), "type": "nifti"})
        shown.update(output=str(out), voxel=voxel)
    else:
        trk = _text(args, "trk")
        store = _text(args, "store")
        density = _text(args, "density")
        if trk is None and store is None and density is None:
            raise BadRequest("give at least one output: trk, store or density")
        if trk is not None:
            out = roots.output(trk, suffixes=(".trk",), overwrite=overwrite)
            argv += ["--trk", str(out)]
            outputs.append({"path": str(out), "type": "trk"})
            shown["trk"] = str(out)
        if store is not None:
            out = roots.output(store, suffixes=STORES, overwrite=overwrite)
            levels = _int(args, "levels", 3, 0, 8)
            argv += ["--store", str(out), "--levels", str(levels)]
            outputs.append({"path": str(out), "type": "zarr-vectors"})
            shown.update(store=str(out), levels=levels)
        if density is not None:
            out = roots.output(density, suffixes=NIFTI, overwrite=overwrite)
            voxel = _float(args, "voxel", 1.0, 0.01, 100.0)
            argv += ["--density", str(out), "--voxel", str(voxel)]
            outputs.append({"path": str(out), "type": "nifti"})
            shown.update(density=str(out), voxel=voxel)
        paths = [o["path"] for o in outputs]
        if len(set(paths)) != len(paths):
            raise BadRequest("the outputs must be different files")
    if overwrite:
        argv.append("--overwrite")
    name = _text(args, "name")
    title = f"{'Density map' if density_only else 'Filter'} {source.name}" + (f": {name}" if name else "")
    return Plan(
        module="ngplatform_runner.tasks.filter",
        argv=argv,
        title=title,
        outputs=outputs,
        files={"filter.json": document},
        shown={**shown, "overwrite": overwrite, **({"name": name} if name else {})},
    )


def plan_sleep(roots: Roots, args: dict) -> Plan:
    seconds = _float(args, "seconds", 1.0, 0.0, 3600.0)
    steps = _int(args, "steps", 4, 1, 1000)
    argv = ["--seconds", str(seconds), "--steps", str(steps)]
    if _bool(args, "fail"):
        argv.append("--fail")
    if _bool(args, "child"):
        argv.append("--child")
    outputs = []
    output = _text(args, "output")
    if output is not None:
        out = roots.output(output, suffixes=(".txt",), overwrite=True)
        argv += ["--output", str(out)]
        outputs.append({"path": str(out), "type": "file"})
    return Plan("ngplatform_runner.tasks.sleep", argv, f"Sleep {seconds:g} s", outputs, shown={"seconds": seconds, "steps": steps})


def plan_serve(path: Path, port: int) -> Plan:
    return Plan(
        module="zarr_vectors_tools",
        argv=["virtual", "serve", str(path), "--host", "127.0.0.1", "--port", str(port)],
        title=f"Serve {path.name}",
        outputs=[],
        shown={"path": str(path)},
    )


@dataclass
class Kind:
    name: str
    title: str
    description: str
    plan: Callable[[Roots, dict], Plan]
    progress: Callable[[str], tuple[float, str] | None] = progress_line
    test_only: bool = False


KINDS: dict[str, Kind] = {
    "convert": Kind(
        "convert", "Convert a tractogram",
        "A .trk, .tck or .trx file to a Zarr Vectors store with coarser levels (zvtools convert). "
        "Arguments: input, output (a .zarr folder to make), levels (coarser levels, each half the "
        "streamlines of the one below; default 3), chunk_shape (mm; default for .trk: chosen from the file), overwrite.",
        plan_convert, convert_progress,
    ),
    "filter": Kind(
        "filter", "Filter streamlines",
        "The streamlines of a tractogram or store that pass a filter (a zvf-predicate document: regions "
        "with path or endpoint modes, combined with and, or, not; attribute comparisons), written as a "
        ".trk (trk), a Zarr Vectors store with levels (store, levels) and/or a density map (density, voxel).",
        plan_filter,
    ),
    "density": Kind(
        "density", "Density map",
        "How many of the streamlines that pass a filter go through each voxel, as a NIfTI image "
        "(output, voxel in mm; default 1).",
        lambda roots, args: plan_filter(roots, args, density_only=True),
    ),
    "sleep": Kind("sleep", "Sleep (test)", "Waits, reporting progress; for tests.", plan_sleep, test_only=True),
}


def kinds_for(test_kinds: bool) -> dict[str, Kind]:
    return {k: v for k, v in KINDS.items() if test_kinds or not v.test_only}


def check_servable(path: Path) -> str:
    """How /serve serves a path: "store" (a folder), "file" (a NIfTI, as it is) or "virtual"."""
    name = path.name.lower()
    if path.is_dir():
        if not is_store(path):
            raise PathRefused(f"{path} is a folder but not a Zarr store")
        return "store"
    if name.endswith(NIFTI):
        return "file"
    if name.endswith(SERVABLE):
        return "virtual"
    raise PathRefused(f"{path.name}: the runner serves Zarr stores, NIfTI images and {', '.join(SERVABLE)} files")
