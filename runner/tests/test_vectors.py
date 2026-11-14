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


def _cells(path):
    """Points in mm, as an atlas of cells: two groups (left half group 0 in red, right half group 1 in blue),
    a value rising along x, and many attributes besides (as a gene panel)."""
    schema = zv.Schema(bounds=([0.0, 0.0, 0.0], [48.0, 48.0, 48.0]), kind="point_cloud", layout=zv.Layout(cells=2),
                       axes=[zv.Axis(n, "millimeter") for n in "xyz"])
    ds = zv.create(str(path), schema=schema)
    g = np.mgrid[4:45:4, 4:45:4, 24:25].reshape(3, -1).T.astype("float32")
    left = g[:, 0] < 24
    attrs = {"class_index": np.where(left, 0, 1).astype("float32"),
             "class_color": np.where(left, 0xFF0000, 0x0000FF).astype("uint32"),
             "gene_A": g[:, 0].astype("float32")}
    attrs.update({f"gene_{k}": np.zeros(len(g), "float32") for k in range(20)})
    ds.add_points(g, attributes=attrs)
    return str(path), g


def test_points_read_only_the_attributes_a_look_names(tmp_path):
    url, g = _cells(tmp_path / "c.zarrvectors")
    s = vectors.load(url, radius_mm=1.0, attributes=["class_index", "class_color", "no_such"])
    assert s.meta["kind"] == "point_cloud" and len(s.prims) == len(g)
    assert set(s.values) == {"class_index", "class_color"}
    assert vectors.shader_id("obj:group") == "obj_group" and vectors.shader_id("2x") == "a_2x"


def test_points_coloured_as_the_layer(tmp_path):
    url, g = _cells(tmp_path / "c.zarrvectors")
    s = vectors.load(url, radius_mm=1.0, attributes=["class_index", "class_color", "gene_A"])
    left = s.prims[:, 0] < 24
    # By group, in the store's colours; the second group alone shown.
    look = {"by": "group", "group": {"attribute": "class_index", "colorAttribute": "class_color", "colours": "stored", "shown": [1]}}
    c, hide = vectors.colour(s, look)
    np.testing.assert_allclose(c[left], [[1, 0, 0]] * left.sum())
    np.testing.assert_allclose(c[~left], [[0, 0, 1]] * (~left).sum())
    assert (hide == left).all()
    # In the palette: as the shader's zvPalette (group 0: hue 0 at 0.75; group 1 the golden ratio's).
    c, hide = vectors.colour(s, {"by": "group", "group": {"attribute": "class_index", "colours": "palette"}})
    assert hide is None
    np.testing.assert_allclose(c[left][0], [1.0, 0.25, 0.25], atol=1e-6)
    # By an attribute through a table between low and high, outside hidden.
    look = {"by": "attribute", "attribute": "gene_A", "lut": [[0, 0, 0], [1, 1, 1]], "low": 8, "high": 40, "hideOutside": True}
    c, hide = vectors.colour(s, look)
    x = s.prims[:, 0]
    np.testing.assert_allclose(c[:, 0], np.clip((x - 8) / 32, 0, 1), atol=1e-6)
    assert (hide.astype(bool) == ((x < 8) | (x > 40))).all()
    # A look naming an attribute not read: the store's own colours.
    c, hide = vectors.colour(s, {"by": "attribute", "attribute": "gene_3"})
    assert hide is None and c.shape == (len(s.prims), 3)


def test_a_session_of_points_alone_hides_the_groups_not_shown(tmp_path, monkeypatch):
    import threading
    import time
    import urllib.request
    import zlib

    from ngplatform_render import server
    from ngplatform_render.camera import framing_radius, orbit

    monkeypatch.setenv("NGP_RENDER_CACHE", str(tmp_path / "cache"))
    url, g = _cells(tmp_path / "c.zarrvectors")
    srv = server.RenderServer(0, "tok", [tmp_path], 0, tmp_path / "renders")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"

    def call(method, path, body=None, raw=False):
        r = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                   headers={"X-NGP-Service-Token": "tok", "Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=60) as f:
            return (f.headers, f.read()) if raw else json.loads(f.read() or b"null")

    # No image: the volume is the objects alone.
    s = call("POST", "/sessions", {"volume": {"url": server.OBJECTS_ONLY},
                                   "objects": {"url": url, "store": "zarr-vectors", "radius_mm": 1.5, "attributes": ["class_index", "class_color"]}})
    for _ in range(400):
        info = call("GET", f"/sessions/{s['id']}")
        if info["status"] != "loading":
            break
        time.sleep(0.05)
    assert info["status"] == "ready", info
    assert info["objects"]["kind"] == "point_cloud" and info["objects"]["points"] == len(g)
    assert info["objects"]["attributes"] == ["class_color", "class_index"]
    lo, hi = g.min(0), g.max(0)
    cam = orbit((lo + hi) / 2, framing_radius(lo, hi, 30), 0, 0)  # looking along -z (from +z)

    def depth(look):
        view = {"inv_view_projection": np.linalg.inv(cam.view_projection(64, 64)).T.ravel().tolist(), "width": 64, "height": 64,
                "max_samples": 4, "objects": {"show": True, "colour": look}}
        version = call("PUT", f"/sessions/{s['id']}/view", view)["version"]
        n = 0
        for _ in range(100):
            h, _ = call("GET", f"/sessions/{s['id']}/frame?after={n}&timeout=20", raw=True)
            n = int(h["X-Frame"])
            if int(h["X-Version"]) >= version:
                break
        h, dz = call("GET", f"/sessions/{s['id']}/depth", raw=True)
        return np.frombuffer(zlib.decompress(dz), np.float16).reshape(int(h["X-Height"]), int(h["X-Width"]))

    every = depth(None)
    # Points over both halves of the view (x from left to right on screen).
    assert (every[:, :24] < 1).any() and (every[:, 40:] < 1).any()
    right = depth({"by": "group", "group": {"attribute": "class_index", "colorAttribute": "class_color", "colours": "stored", "shown": [1]}})
    # Only group 1 (x > 24, the right half): the left half is empty now.
    assert (right[:, 40:] < 1).any() and not (right[:, :24] < 1).any()
    srv.shutdown()
