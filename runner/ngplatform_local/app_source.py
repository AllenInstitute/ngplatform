"""Which build of the app a local ngplatform serves, and keeping it current with the deployed site.

Two places hold a build, each a folder of the app's files with its ``build.json`` (vite.config.ts writes
it: version, commit, date, and the runner API the app needs, ``runnerApi``):

- **bundled**: the build inside this package (``ngplatform_local/app/``), put there when the wheel was
  made, from the same commit as the runner beside it;
- **downloaded**: builds of the deployed site, fetched by :func:`update` into ``~/.ngplatform/app/<commit>/``
  (a folder is complete once its ``.complete`` marker is written, after every file's hash was checked
  against the site's ``files.json``).

:func:`choose` serves the newest of them (by build date) whose ``runnerApi`` this runner meets. So an
install stays as current as the deployed site without a new release of the package, until the app comes
to need a newer runner: then the newest build this runner can serve is kept, and the user is told to
upgrade the package.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from ngplatform_runner import DEFAULT_APP, RUNNER_API

#: The deployed site, as each release channel publishes it.
CHANNELS = {"stable": DEFAULT_APP, "dev": DEFAULT_APP + "dev/"}
#: The marker a downloaded build's folder gets once every file is in and checked.
COMPLETE = ".complete"
#: How many downloaded builds are kept (the newest).
KEEP = 2
#: A file of the app at most (bytes), as a guard on what a site may make us write.
MAX_FILE = 256 << 20


@dataclass(frozen=True)
class Build:
    """A build of the app on this computer: its folder, what it is, and where it came from."""

    dir: Path
    info: dict[str, Any]
    where: str  # "bundled" or "downloaded"

    @property
    def commit(self) -> str:
        return str(self.info.get("commit", "unknown"))

    @property
    def date(self) -> str:
        return str(self.info.get("date", ""))

    @property
    def runner_api(self) -> int:
        return runner_api_of(self.info)

    def describe(self) -> str:
        return f"{self.info.get('version', '?')} ({self.commit}, built {self.date[:10] or 'at an unknown date'}, {self.where})"


def runner_api_of(info: dict[str, Any]) -> int:
    """The runner API a build needs (1 for builds from before it was said)."""
    v = info.get("runnerApi", 1)
    return v if isinstance(v, int) and v >= 1 else 1


def read_build(folder: Path) -> dict[str, Any] | None:
    """A folder's build.json, when it holds a build of the app (index.html and build.json); else None."""
    try:
        if not (folder / "index.html").is_file():
            return None
        info = json.loads((folder / "build.json").read_text())
    except (OSError, ValueError):
        return None
    return info if isinstance(info, dict) else None


def bundled() -> Build | None:
    """The build inside this package, if the wheel was made with one."""
    folder = Path(__file__).resolve().parent / "app"
    info = read_build(folder)
    return Build(folder, info, "bundled") if info is not None else None


def downloaded(home: Path) -> list[Build]:
    """The complete builds downloaded under ``home``, newest first."""
    out = []
    root = home / "app"
    if root.is_dir():
        for folder in root.iterdir():
            if folder.is_dir() and (folder / COMPLETE).is_file():
                info = read_build(folder)
                if info is not None:
                    out.append(Build(folder, info, "downloaded"))
    return sorted(out, key=lambda b: b.date, reverse=True)


def choose(home: Path) -> Build | None:
    """The build to serve: the newest this runner can serve, bundled or downloaded."""
    builds = [b for b in [bundled(), *downloaded(home)] if b is not None and b.runner_api <= RUNNER_API]
    return max(builds, key=lambda b: b.date, default=None)


# ----------------------------------------------------------------------------- the deployed site


def _get(url: str, timeout: float) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "ngplatform-local", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - the site's https address
        return r.read(MAX_FILE + 1)


def deployed(site: str, timeout: float = 5.0) -> dict[str, Any]:
    """The deployed site's build.json."""
    info = json.loads(_get(urllib.parse.urljoin(site, "build.json"), timeout))
    if not isinstance(info, dict) or "commit" not in info:
        raise ValueError(f"{site}build.json is not a build's description")
    return info


def _safe(path: str) -> PurePosixPath:
    p = PurePosixPath(path)
    if p.is_absolute() or not p.parts or any(part in ("", ".", "..") or part.startswith(".") for part in p.parts):
        raise ValueError(f"files.json names a path outside the app: {path!r}")
    return p


@dataclass
class UpdateResult:
    """What :func:`update` did: ``state`` is "current", "downloaded" or "needs-runner"."""

    state: str
    build: Build | None
    deployed: dict[str, Any]

    def message(self) -> str:
        d = self.deployed
        if self.state == "current":
            return f"The app is current with the deployed site ({d.get('commit')})."
        if self.state == "needs-runner":
            return (f"The deployed app ({d.get('commit')}) needs a newer ngplatform than this one "
                    f"(runner API {runner_api_of(d)}, this has {RUNNER_API}): pip install -U ngplatform")
        return f"Downloaded the deployed app {self.build.describe() if self.build else d.get('commit')}."


def update(home: Path, site: str, progress: Callable[[int, int], None] | None = None, timeout: float = 30.0) -> UpdateResult:
    """Brings the newest build here level with the deployed site: downloads it when it is newer than every
    build here (each file checked against files.json), unless it needs a newer runner."""
    info = deployed(site, timeout=min(timeout, 10.0))
    have = [b for b in [bundled(), *downloaded(home)] if b is not None]
    if any(b.commit == info["commit"] for b in have) or any(b.date >= str(info.get("date", "")) for b in have if b.runner_api <= RUNNER_API and not b.commit.endswith("+changes")):
        return UpdateResult("current", None, info)
    if runner_api_of(info) > RUNNER_API:
        return UpdateResult("needs-runner", None, info)
    manifest = json.loads(_get(urllib.parse.urljoin(site, "files.json"), timeout))
    if manifest.get("commit") != info["commit"]:
        raise ValueError("the site's files.json is of another build than its build.json (a deploy under way?): try again shortly")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("the site's files.json lists no files")
    root = home / "app"
    root.mkdir(parents=True, exist_ok=True)
    name = "".join(c for c in str(info["commit"]) if c.isalnum() or c in "-+_")
    part = root / f"{name}.partial"
    shutil.rmtree(part, ignore_errors=True)
    try:
        total = sum(int(f.get("size", 0)) for f in files)
        done = 0
        for f in files:
            rel = _safe(str(f["path"]))
            data = _get(urllib.parse.urljoin(site, urllib.parse.quote(str(rel))), timeout)
            if len(data) > MAX_FILE or len(data) != int(f["size"]) or hashlib.sha256(data).hexdigest() != f["sha256"]:
                raise ValueError(f"{rel} is not the file files.json describes (a deploy under way?): try again shortly")
            out = part / Path(*rel.parts)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
            done += len(data)
            if progress:
                progress(done, total)
        if read_build(part) is None:
            raise ValueError("the deployed app has no index.html or build.json")
        (part / COMPLETE).write_text(json.dumps({"site": site}) + "\n")
        final = root / name
        shutil.rmtree(final, ignore_errors=True)
        part.rename(final)
    except BaseException:
        shutil.rmtree(part, ignore_errors=True)
        raise
    for old in downloaded(home)[KEEP:]:
        shutil.rmtree(old.dir, ignore_errors=True)
    return UpdateResult("downloaded", Build(final, read_build(final) or info, "downloaded"), info)
