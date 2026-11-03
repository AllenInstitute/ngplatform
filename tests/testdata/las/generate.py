"""Makes the LAS test files with laspy: point formats 1 (LAS 1.2) and 6
(LAS 1.4), scaled and offset coordinates, intensity and classification.
Each is also written compressed (.laz, the same points), which needs
lazrs. Run with a Python that has laspy and lazrs: python generate.py"""
import json
import laspy
import numpy as np

rng = np.random.default_rng(5)
expected = {}
for name, version, fmt in [("points_v12.las", "1.2", 1), ("points_v14.las", "1.4", 6)]:
    header = laspy.LasHeader(point_format=fmt, version=version)
    header.scales = np.array([0.01, 0.01, 0.001])
    header.offsets = np.array([1000.0, -20.0, 5.0])
    las = laspy.LasData(header)
    n = 37
    las.x = rng.uniform(1000, 1100, n)
    las.y = rng.uniform(-20, 30, n)
    las.z = rng.uniform(5, 8, n)
    las.intensity = rng.integers(0, 65535, n)
    las.classification = rng.integers(0, 20, n)
    las.write(name)
    back = laspy.read(name)
    expected[name] = {
        "positions": np.stack([back.x, back.y, back.z], axis=1).ravel().round(6).tolist(),
        "intensity": np.asarray(back.intensity).tolist(),
        "classification": np.asarray(back.classification).tolist(),
    }
json.dump(expected, open("expected.json", "w"))

# The same points compressed: LAZ.
for name in ["points_v12.las", "points_v14.las"]:
    laspy.read(name).write(name.replace(".las", ".laz"), laz_backend=laspy.LazBackend.Lazrs)
