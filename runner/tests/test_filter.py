"""The filter job's work: the same answer as zarr-vectors-tools' reference engine, from every kind of input."""

from __future__ import annotations

import base64
import gzip
import json
import struct
import tempfile
import unittest
from pathlib import Path

from helpers import FIXTURES, tools_available

if tools_available():
    import numpy as np

    from ngplatform_runner.tasks import filter as task
    from ngplatform_runner.tasks.tractograms import open_source, open_trk


def doc(tree):
    return {"format": "zvf-predicate", "version": 1, "tree": tree}


SPHERE = {"op": "passes", "mode": "path", "region": {"type": "sphere", "center": [0, -10, 0], "radius": 25}}
ENDS = {"op": "passes", "mode": "endpoints", "region": {"type": "box", "min": [-70, -90, -40], "max": [0, 0, 0]}}


@unittest.skipUnless(tools_available(), "zarr-vectors-tools is not importable")
class FilterTaskTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_task(self, source, tree, *extra):
        path = self.dir / "filter.json"
        path.write_text(json.dumps(doc(tree)))
        code = task.main([str(source), "--filter", str(path), *extra])
        self.assertEqual(code, 0)

    def oracle(self, source, tree):
        from zarr_vectors_tools.filtering import Tractogram, evaluate, from_json

        whole = open_source(Path(source))
        batches = list(whole.batches())
        points = np.concatenate([b.points for b in batches])
        offsets = [0]
        for b in batches:
            offsets.extend((b.offsets[1:] + offsets[-1]).tolist())
        t = Tractogram(points, np.asarray(offsets), groups=whole.groups)
        return t, evaluate(from_json(doc(tree)), t)

    def test_trk_records_are_copied(self):
        source = FIXTURES / "ras.trk"
        for tree in (SPHERE, ENDS, {"op": "and", "args": [SPHERE, {"op": "not", "arg": ENDS}]}):
            out = self.dir / "out.trk"
            self.run_task(source, tree, "--trk", str(out), "--overwrite")
            t, mask = self.oracle(source, tree)
            got = next(open_trk(out).batches(), None)
            expected = [t.polyline(k) for k in np.flatnonzero(mask)]
            if not expected:
                self.assertIsNone(got)
                continue
            self.assertEqual(len(got.offsets) - 1, int(mask.sum()))
            self.assertTrue(np.array_equal(got.points, np.concatenate(expected)))
            head = out.read_bytes()[:1000]
            original = source.read_bytes()[:1000]
            self.assertEqual(head[:988], original[:988])
            self.assertEqual(struct.unpack("<i", head[988:992])[0], int(mask.sum()))

    def test_tck_written_in_ras(self):
        source = FIXTURES / "tracks.tck"
        t, _ = self.oracle(source, {"op": "all"})
        centre = t.vertices[len(t.vertices) // 2].astype(float).tolist()
        tree = {"op": "passes", "mode": "path", "region": {"type": "sphere", "center": centre, "radius": 10}}
        out = self.dir / "out.trk"
        self.run_task(source, tree, "--trk", str(out))
        t, mask = self.oracle(source, tree)
        self.assertGreater(mask.sum(), 0)
        got = next(open_trk(out).batches())
        expected = np.concatenate([t.polyline(k) for k in np.flatnonzero(mask)])
        self.assertEqual(len(got.offsets) - 1, int(mask.sum()))
        self.assertTrue(np.allclose(got.points, expected, atol=1e-4))

    def test_store_input_in_stored_coordinates(self):
        from zarr_vectors_tools.cli import main as zvtools

        store = self.dir / "in.zarr"
        self.assertEqual(zvtools(["convert", str(FIXTURES / "ras.trk"), str(store), "--sparsity", "2"]), 0)
        # This store keeps TrackVis voxel millimetres: regions are in those.
        t, _ = self.oracle(store, {"op": "all"})
        self.assertGreater(t.vertices[:, 0].min(), 0)
        centre = t.vertices[len(t.vertices) // 3].astype(float).tolist()
        tree = {"op": "passes", "mode": "path", "region": {"type": "sphere", "center": centre, "radius": 8}}
        _, mask = self.oracle(store, tree)
        out = self.dir / "out.trk"
        nii = self.dir / "d.nii.gz"
        self.run_task(store, tree, "--trk", str(out), "--store", str(self.dir / "out.zarr"), "--levels", "1", "--density", str(nii))
        import nibabel as nib

        self.assertEqual(len(nib.streamlines.load(str(out)).streamlines), int(mask.sum()))
        self.assertTrue((self.dir / "out.zarr" / "1").is_dir())
        image = nib.load(str(nii))
        self.assertEqual(int(image.get_fdata().max()), int(mask.sum()) if mask.sum() else 0)

    def stored_points(self, store):
        from zarr_vectors.types.polylines import read_polylines

        r = read_polylines(str(store), level=0)
        order = np.argsort(np.asarray(r["object_ids"]))
        return np.concatenate([np.concatenate(r["polylines"][k]) for k in order])

    def test_a_store_output_lines_up_with_its_input(self):
        from zarr_vectors_tools.cli import main as zvtools

        # From a file: RAS+ mm, as the viewer shows the file.
        source = FIXTURES / "las.trk"
        t, _ = self.oracle(source, {"op": "all"})
        centre = t.vertices[len(t.vertices) // 2].astype(float).tolist()
        tree = {"op": "passes", "mode": "path", "region": {"type": "sphere", "center": centre, "radius": 15}}
        t, mask = self.oracle(source, tree)
        self.run_task(source, tree, "--store", str(self.dir / "from_file.zarr"), "--levels", "0")
        expected = np.concatenate([t.polyline(k) for k in np.flatnonzero(mask)])
        self.assertTrue(np.allclose(self.stored_points(self.dir / "from_file.zarr"), expected, atol=1e-4))
        self.assertFalse((self.dir / ".from_file.zarr.filtered.trk").exists())
        # From a store in voxel mm, and one in RAS mm: each keeps its own space.
        for name, extra in (("vox.zarr", []), ("ras.zarr", ["--apply-affine"])):
            store = self.dir / name
            self.assertEqual(zvtools(["convert", str(source), str(store), *extra]), 0)
            t, _ = self.oracle(store, {"op": "all"})
            centre = t.vertices[len(t.vertices) // 2].astype(float).tolist()
            tree = {"op": "passes", "mode": "path", "region": {"type": "sphere", "center": centre, "radius": 15}}
            t, mask = self.oracle(store, tree)
            out = self.dir / f"out_{name}"
            self.run_task(store, tree, "--store", str(out), "--levels", "0")
            expected = np.concatenate([t.polyline(k) for k in np.flatnonzero(mask)])
            self.assertTrue(np.allclose(self.stored_points(out), expected, atol=1e-3), name)

    def test_density_counts_each_streamline_once_per_voxel(self):
        source = FIXTURES / "ras.trk"
        nii = self.dir / "d.nii"
        self.run_task(source, SPHERE, "--density", str(nii), "--voxel", "2")
        t, mask = self.oracle(source, SPHERE)
        import nibabel as nib

        image = nib.load(str(nii))
        data = image.get_fdata()
        self.assertEqual(image.header.get_zooms()[:3], (2.0, 2.0, 2.0))
        # Every vertex of a passing streamline lies in a voxel it counted.
        inverse = np.linalg.inv(image.affine)
        for k in np.flatnonzero(mask):
            ijk = np.rint(t.polyline(k) @ inverse[:3, :3].T + inverse[:3, 3]).astype(int)
            self.assertTrue(np.all(data[tuple(ijk.T)] >= 1))
        self.assertLessEqual(data.max(), mask.sum())
        # A streamline crossing a voxel twice still counts once there.
        single = task.Density(np.zeros(3), np.full(3, 4.0), 1.0)
        back_and_forth = np.array([[0.5, 0.5, 0.5], [3.5, 0.5, 0.5], [0.5, 0.5, 0.5]], np.float32)
        single.add(back_and_forth, np.array([0, 3]))
        self.assertEqual(int(single.counts.max()), 1)
        self.assertEqual(int(single.counts.sum()), 4)

    def test_nothing_passes(self):
        far = {"op": "passes", "mode": "path", "region": {"type": "sphere", "center": [1000, 1000, 1000], "radius": 1}}
        out = self.dir / "none.trk"
        self.run_task(FIXTURES / "ras.trk", far, "--trk", str(out))
        self.assertEqual(struct.unpack("<i", out.read_bytes()[988:992])[0], 0)
        path = self.dir / "filter.json"
        path.write_text(json.dumps(doc(far)))
        with self.assertRaises(SystemExit):
            task.main([str(FIXTURES / "ras.trk"), "--filter", str(path), "--density", str(self.dir / "none.nii")])

    def test_groups_the_document_carries(self):
        # Tags from the browser: the rows they choose, as a set the tree's group node tests.
        source = FIXTURES / "ras.trk"
        t, everything = self.oracle(source, {"op": "all"})
        chosen = np.arange(0, len(everything), 3)
        packed = np.packbits(np.isin(np.arange(len(everything)), chosen))
        group = {"size": len(everything), "bits": base64.b64encode(packed.tobytes()).decode()}
        for tree, expected in (
            ({"op": "group", "ids": [0]}, chosen),
            ({"op": "and", "args": [SPHERE, {"op": "group", "ids": [0]}]}, np.intersect1d(chosen, np.flatnonzero(self.oracle(source, SPHERE)[1]))),
        ):
            path = self.dir / "filter.json"
            path.write_text(json.dumps({**doc(tree), "groups": [group]}))
            out = self.dir / "groups.trk"
            self.assertEqual(task.main([str(source), "--filter", str(path), "--trk", str(out), "--overwrite"]), 0)
            got = next(open_trk(out).batches(), None)
            self.assertEqual(0 if got is None else len(got.offsets) - 1, len(expected))
            if len(expected):
                self.assertTrue(np.array_equal(got.points, np.concatenate([t.polyline(k) for k in expected])))

    def test_gzip_nifti_is_readable(self):
        nii = self.dir / "d.nii.gz"
        self.run_task(FIXTURES / "ras.trk", SPHERE, "--density", str(nii))
        with gzip.open(nii) as f:
            self.assertEqual(struct.unpack("<i", f.read(4))[0], 348)


class CarriedGroupsTest(unittest.TestCase):
    """The row sets a filter document carries, read without zarr-vectors-tools."""

    def setUp(self):
        global np, filter_task
        import numpy as np

        from ngplatform_runner.tasks import filter as filter_task

    def test_bits_to_rows(self):
        bits = base64.b64encode(bytes([0b10010000, 0b01000000])).decode()
        rows = filter_task.document_groups({"groups": [{"size": 10, "bits": bits}, {"size": 0, "bits": ""}]})
        self.assertEqual([r.tolist() for r in rows], [[0, 3, 9], []])
        self.assertIsNone(filter_task.document_groups({"tree": {"op": "all"}}))
        # Bits beyond the size are not rows.
        self.assertEqual(filter_task.document_groups({"groups": [{"size": 4, "bits": bits}]})[0].tolist(), [0, 3])
        for bad in ({"groups": {}}, {"groups": [{"size": 20, "bits": bits}]}, {"groups": [{"bits": bits}]}, {"groups": [{"size": 1, "bits": "!!"}]}):
            with self.assertRaises(ValueError):
                filter_task.document_groups(bad)

    def test_rows_within_a_batch(self):
        groups = [np.array([0, 3, 9, 12]), np.array([], np.int64)]
        self.assertEqual([g.tolist() for g in filter_task.batch_groups(groups, 3, 7)], [[0, 6], []])


if __name__ == "__main__":
    unittest.main()
