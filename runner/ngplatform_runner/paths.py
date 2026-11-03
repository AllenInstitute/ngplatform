"""The folders the runner may read and write: the roots given when it starts.

Every path a request names is resolved (symbolic links followed, ``..``
removed) and must then lie under one of the roots; anything else is refused.
"""

from __future__ import annotations

import os
import time
from pathlib import Path


class PathRefused(ValueError):
    """A path outside the roots, or one that does not fit what was asked."""


class Roots:
    def __init__(self, roots: list[str | Path]):
        resolved = []
        for root in roots:
            path = Path(os.path.expanduser(str(root))).resolve()
            if not path.is_dir():
                raise ValueError(f"{root}: not a folder")
            resolved.append(path)
        self.roots: list[Path] = resolved

    def __iter__(self):
        return iter(self.roots)

    def resolve(self, path: str | Path) -> Path:
        """``path`` resolved, if it is under a root; else PathRefused."""
        if path is None or str(path).strip() == "":
            raise PathRefused("no path given")
        text = os.path.expanduser(str(path))
        if "\0" in text:
            raise PathRefused("a path with a NUL byte")
        candidate = Path(text)
        if not candidate.is_absolute():
            raise PathRefused(f"{path}: give an absolute path")
        resolved = candidate.resolve()
        for root in self.roots:
            if resolved == root or root in resolved.parents:
                return resolved
        raise PathRefused(f"{path} is outside the folders this runner may use ({', '.join(map(str, self.roots))})")

    def existing(self, path: str | Path, *, folder: bool | None = None) -> Path:
        """An existing file or folder under a root."""
        resolved = self.resolve(path)
        if not resolved.exists():
            raise PathRefused(f"{path} does not exist")
        if folder is True and not resolved.is_dir():
            raise PathRefused(f"{path} is not a folder")
        if folder is False and resolved.is_dir():
            raise PathRefused(f"{path} is a folder, not a file")
        return resolved

    def output(self, path: str | Path, *, suffixes: tuple[str, ...], overwrite: bool = False) -> Path:
        """A path to write under a root: its folder must exist; it must not, unless ``overwrite``."""
        resolved = self.resolve(path)
        name = resolved.name.lower()
        if not any(name.endswith(s) for s in suffixes):
            raise PathRefused(f"{path}: the name must end in {' or '.join(suffixes)}")
        if not resolved.parent.is_dir():
            raise PathRefused(f"{resolved.parent} does not exist")
        if resolved.exists() and not overwrite:
            raise PathRefused(f"{path} exists already")
        if resolved in self.roots:
            raise PathRefused("a root itself cannot be an output")
        return resolved


def is_store(path: Path) -> bool:
    """Whether a folder is a Zarr store (has zarr.json or .zgroup)."""
    return path.is_dir() and ((path / "zarr.json").is_file() or (path / ".zgroup").is_file())


def listing(roots: Roots, path: str | None, limit: int = 2000) -> dict:
    """The entries of a folder under a root, or the roots themselves when ``path`` is empty."""
    if not path:
        return {
            "path": "",
            "parent": None,
            "entries": [{"name": str(r), "path": str(r), "type": "store" if is_store(r) else "dir"} for r in roots],
            "truncated": False,
        }
    folder = roots.existing(path, folder=True)
    entries = []
    truncated = False
    with os.scandir(folder) as it:
        for entry in sorted(it, key=lambda e: e.name.lower()):
            if entry.name.startswith("."):
                continue
            if len(entries) >= limit:
                truncated = True
                break
            try:
                full = Path(entry.path)
                if entry.is_dir():
                    kind = "store" if is_store(full) else "dir"
                    entries.append({"name": entry.name, "path": str(full), "type": kind})
                else:
                    stat = entry.stat()
                    entries.append({"name": entry.name, "path": str(full), "type": "file", "size": stat.st_size, "modified": stat.st_mtime})
            except OSError:
                continue
    parent = None if folder in roots.roots else str(folder.parent)
    return {"path": str(folder), "parent": parent, "entries": entries, "truncated": truncated}


def find(roots: Roots, name: str, *, max_depth: int = 6, max_dirs: int = 20000, seconds: float = 3.0) -> dict:
    """Files (or stores) called ``name`` under the roots: a bounded breadth-first search."""
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise PathRefused("give a file name, not a path")
    found = []
    deadline = time.monotonic() + seconds
    visited = 0
    queue: list[tuple[Path, int]] = [(r, 0) for r in roots]
    complete = True
    while queue:
        folder, depth = queue.pop(0)
        if visited >= max_dirs or time.monotonic() > deadline:
            complete = False
            break
        visited += 1
        try:
            with os.scandir(folder) as it:
                for entry in it:
                    if entry.name.startswith("."):
                        continue
                    try:
                        if entry.name == name:
                            stat = entry.stat()
                            found.append({"path": entry.path, "type": "dir" if entry.is_dir() else "file", "size": stat.st_size})
                        if entry.is_dir(follow_symlinks=False) and depth + 1 <= max_depth and not is_store(Path(entry.path)):
                            queue.append((Path(entry.path), depth + 1))
                    except OSError:
                        continue
        except OSError:
            continue
    return {"name": name, "matches": found, "complete": complete}
