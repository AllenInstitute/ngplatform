"""A Zarr Vectors store as surfaces drawn with the volume (vectors.py): streamlines as tubes coloured by
their direction, points as spheres; a session that draws them in front of its volume."""

from __future__ import annotations

import json

import numpy as np
import pytest

import helpers  # noqa: F401 - puts the runner on the path

zv = pytest.importorskip("zarr_vectors")
cp = pytest.importorskip("cupy")
try:
    cp.cuda.runtime.getDeviceCount()
except Exception:  # pragma: no cover - no GPU
    pytest.skip("no CUDA device", allow_module_level=True)

from ngplatform_render import geometry, vectors  # noqa: E402
from test_precomputed import _write_unsharded  # noqa: E402


def _streamlines(path):
    """Two straight streamlines in mm: one along x at y = z = 24, one along z."""
    schema = zv.Schema(bounds=([0.0, 0.0, 0.0], [48.0, 48.0, 48.0]), kind="streamline", layout=zv.Layout(cells=2),
                       axes=[zv.Axis(n, "millimeter") for n in "xyz"])
    ds = zv.create(str(path), schema=schema)
    a = np.stack([np.linspace(4, 44, 21), np.full(21, 24.0), np.full(21, 24.0)], 1).astype("float32")
    b = np.stack([np.full(21, 10.0), np.full(21, 10.0), np.linspace(4, 44, 21)], 1).astype("float32")
    ds.add_polylines([a, b], streamlines=True)
    return str(path)


def test_streamlines_are_tubes_coloured_by_direction(tmp_path):
    s = vectors.load(_streamlines(tmp_path / "t.zarrvectors"), radius_mm=0.5)
    assert s.meta["kind"] == "streamline" and len(s.prims) == 40
    assert (s.kinds == geometry.CONE).all()
    # Along x: red; along z: blue.
    along_x = np.abs(s.prims[:, 4] - s.prims[:, 0]) > 0
    np.testing.assert_allclose(s.colours[s.objects[along_x]], [[1, 0, 0]] * along_x.sum(), atol=1e-5)
    np.testing.assert_allclose(s.colours[s.objects[~along_x]], [[0, 0, 1]] * (~along_x).sum(), atol=1e-5)
    np.testing.assert_allclose(s.prims[:, 3], 0.5)


def test_a_session_draws_a_stores_tubes_with_its_volume(tmp_path, monkeypatch):
    import threading
    import time
    import urllib.request
    import zlib

    from ngplatform_render import server
    from ngplatform_render.camera import framing_radius, orbit

    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    em = tmp_path / "em"
    em.mkdir()
    vol = np.zeros((48, 48, 48), np.uint8)  # an empty volume: only the tubes are drawn
    (em / "info").write_text(json.dumps({"type": "image", "data_type": "uint8", "num_channels": 1,
                                         "scales": [{"key": "s0", "size": [48, 48, 48], "resolution": [1e6, 1e6, 1e6],
                                                     "voxel_offset": [0, 0, 0], "chunk_sizes": [[16, 16, 16]], "encoding": "raw"}]}))
    _write_unsharded(em, "s0", vol, (16, 16, 16), (0, 0, 0))
    store = _streamlines(tmp_path / "t.zarrvectors")
    srv = server.RenderServer(0, "tok", [tmp_path], 0, tmp_path / "renders")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"

    def call(method, path, body=None, raw=False):
        r = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                   headers={"X-NGP-Service-Token": "tok", "Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=60) as f:
            return (f.headers, f.read()) if raw else json.loads(f.read() or b"null")

    s = call("POST", "/sessions", {"volume": {"url": f"precomputed://{em}"},
                                   "objects": {"url": store, "store": "zarr-vectors", "radius_mm": 1.5}})
    for _ in range(400):
        info = call("GET", f"/sessions/{s['id']}")
        if info["status"] != "loading":
            break
        time.sleep(0.05)
    assert info["status"] == "ready", info
    assert info["objects"]["kind"] == "streamline" and info["objects"]["segments"] == 40
    lo, hi = np.zeros(3), np.full(3, 48.0)
    cam = orbit((lo + hi) / 2, framing_radius(lo, hi, 30), 0, 0)  # looking along -z (from +z)
    view = {"inv_view_projection": np.linalg.inv(cam.view_projection(64, 64)).T.ravel().tolist(), "width": 64, "height": 64,
            "max_samples": 8, "objects": {"show": True}}
    call("PUT", f"/sessions/{s['id']}/view", view)
    call("GET", f"/sessions/{s['id']}/frame?after=0&timeout=20", raw=True)
    h, dz = call("GET", f"/sessions/{s['id']}/depth", raw=True)
    depth = np.frombuffer(zlib.decompress(dz), np.float16).reshape(int(h["X-Height"]), int(h["X-Width"]))
    # The x-streamline crosses the middle of the view; the corners show nothing.
    assert (depth[28:36, 20:44] < 1).any() and depth[0, 0] == 1
    srv.shutdown()
