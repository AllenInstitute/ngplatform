"""How the render service reads stores on a server: a sharded level a whole shard per request (a large shard as
ranges read at once), and stored levels kept on disk by their stamp so a second session downloads nothing."""

from __future__ import annotations

import hashlib
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest
import zarr

import helpers  # noqa: F401 - puts the runner on the path

from ngplatform_render import volumes


class Files(ThreadingHTTPServer):
    """A folder over HTTP with ranges, HEAD and an ETag of each file's time and size; every GET logged."""

    daemon_threads = True

    def __init__(self, root: Path):
        self.root = root
        self.log: list[tuple[str, str | None]] = []  # (path, Range)
        self.lock = threading.Lock()
        super().__init__(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_port}"

    def gets(self, under: str) -> list[tuple[str, str | None]]:
        with self.lock:
            return [g for g in self.log if g[0].startswith(under)]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # quiet
        pass

    def _file(self) -> Path | None:
        p = self.server.root / self.path.split("?")[0].lstrip("/")
        return p if p.is_file() else None

    def _head(self, p: Path, status: int, length: int, extra: dict[str, str] | None = None) -> None:
        st = p.stat()
        self.send_response(status)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", '"' + hashlib.sha1(f"{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest() + '"')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def _missing(self) -> None:
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        p = self._file()
        if p is None:
            return self._missing()
        self._head(p, 200, p.stat().st_size)

    def do_GET(self):
        rng = self.headers.get("Range")
        with self.server.lock:
            self.server.log.append((self.path, rng))
        p = self._file()
        if p is None:
            return self._missing()
        body = p.read_bytes()
        if not rng:
            self._head(p, 200, len(body))
            self.wfile.write(body)
            return
        spec = rng.removeprefix("bytes=")
        a, _, b = spec.partition("-")
        if a == "":  # a suffix: the last b bytes
            start, end = max(0, len(body) - int(b)), len(body) - 1
        else:
            start, end = int(a), min(len(body) - 1, int(b) if b else len(body) - 1)
        part = body[start:end + 1]
        self._head(p, 206, len(part), {"Content-Range": f"bytes {start}-{end}/{len(body)}"})
        self.wfile.write(part)


def sharded_store(path: Path, data: np.ndarray, chunks: int, shards: int) -> None:
    g = zarr.open_group(str(path), mode="w", zarr_format=3)
    g.create_array("0", data=data, chunks=(chunks,) * 3, shards=(shards,) * 3, compressors=zarr.codecs.ZstdCodec(level=3))
    g.attrs["ome"] = {"version": "0.5", "multiscales": [{"axes": [{"name": n, "type": "space", "unit": "micrometer"} for n in "zyx"],
                                                         "datasets": [{"path": "0", "coordinateTransformations": [{"type": "scale", "scale": [20, 20, 20]}]}]}]}


@pytest.fixture
def files(tmp_path):
    srv = Files(tmp_path)
    yield srv
    srv.shutdown()
    srv.server_close()


def test_a_sharded_level_on_a_server_is_read_a_whole_shard_at_a_time(tmp_path, files):
    rng = np.random.default_rng(0)
    data = rng.integers(0, 255, (64, 64, 64), dtype=np.uint8)
    data[:32, :32, :32] = 0  # a shard of nothing: not written, read as the fill value
    sharded_store(tmp_path / "s.ome.zarr", data, chunks=8, shards=32)
    url = f"{files.url}/s.ome.zarr"
    ms = volumes.open_multiscale(url)
    out = volumes._read(url, ms.levels[0], ms, None)
    assert (out == data).all()
    gets = files.gets("/s.ome.zarr/0/c/")
    # Eight shards, seven written: one request each, the missing one read as its fill value.
    assert len(gets) == 8 and len({p for p, _ in gets}) == 8


def test_a_large_shard_is_read_as_ranges_at_once(tmp_path, files, monkeypatch):
    data = np.random.default_rng(1).integers(0, 255, (32, 32, 32), dtype=np.uint8)  # 32 KB that do not compress
    sharded_store(tmp_path / "s.ome.zarr", data, chunks=8, shards=32)
    monkeypatch.setattr(volumes, "PART_BYTES", 4096)
    url = f"{files.url}/s.ome.zarr"
    ms = volumes.open_multiscale(url)
    assert (volumes._read(url, ms.levels[0], ms, None) == data).all()
    gets = files.gets("/s.ome.zarr/0/c/0/0/0")
    size = (tmp_path / "s.ome.zarr/0/c/0/0/0").stat().st_size
    assert len(gets) == -(-size // 4096) and gets[0][1] == "bytes=0-4095"
    assert sorted(int(r.removeprefix("bytes=").split("-")[0]) for _, r in gets) == list(range(0, size, 4096))


def test_stored_levels_on_a_server_are_kept_on_disk_until_the_store_changes(tmp_path, files, monkeypatch):
    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    data = np.random.default_rng(2).integers(0, 255, (64, 64, 64), dtype=np.uint8)
    sharded_store(tmp_path / "s.ome.zarr", data, chunks=16, shards=32)
    url = f"{files.url}/s.ome.zarr"
    first = volumes.load(url)
    n = len(files.gets("/s.ome.zarr/0/c/"))
    again = volumes.load(url)
    assert not first.from_cache and again.from_cache and not again.made
    assert len(files.gets("/s.ome.zarr/0/c/")) == n  # the second read downloads nothing
    assert (again.data == first.data).all() and (first.data == data).all()
    # Written again (a new ETag on its metadata): read again, not served from the cache.
    sharded_store(tmp_path / "s.ome.zarr", 255 - data, chunks=16, shards=32)
    st = (tmp_path / "s.ome.zarr/0/zarr.json").stat()
    os.utime(tmp_path / "s.ome.zarr/0/zarr.json", ns=(st.st_atime_ns, st.st_mtime_ns + 10**9))
    third = volumes.load(url)
    assert not third.from_cache and (third.data == 255 - data).all()


def test_stores_on_this_computer_are_not_copied_into_the_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    sharded_store(tmp_path / "s.ome.zarr", np.ones((32, 32, 32), np.uint8), chunks=8, shards=16)
    volumes.load(str(tmp_path / "s.ome.zarr"))
    assert not volumes.load(str(tmp_path / "s.ome.zarr")).from_cache and volumes.cache_entries() == []
