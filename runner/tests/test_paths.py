"""The roots: what the runner may read, write and list."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from helpers import RUNNER  # noqa: F401 - puts the package on the path

from ngplatform_runner.paths import PathRefused, Roots, find, listing


class RootsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.root = base / "root"
        self.outside = base / "outside"
        (self.root / "sub").mkdir(parents=True)
        self.outside.mkdir()
        (self.root / "a.trk").write_bytes(b"x")
        (self.root / "sub" / "b.trk").write_bytes(b"yy")
        (self.root / "store.zarr").mkdir()
        (self.root / "store.zarr" / "zarr.json").write_text("{}")
        (self.outside / "secret.trk").write_bytes(b"z")
        os.symlink(self.outside, self.root / "escape")
        self.roots = Roots([self.root])

    def tearDown(self):
        self.tmp.cleanup()

    def test_inside(self):
        self.assertEqual(self.roots.resolve(str(self.root / "sub" / "b.trk")), (self.root / "sub" / "b.trk").resolve())
        self.assertEqual(self.roots.resolve(str(self.root)), self.root.resolve())

    def test_outside_is_refused(self):
        for path in [str(self.outside / "secret.trk"), "/etc/passwd", str(self.root / ".." / "outside" / "secret.trk"), str(self.root / "escape" / "secret.trk"), "relative/path", ""]:
            with self.assertRaises(PathRefused, msg=path):
                self.roots.resolve(path)

    def test_output_rules(self):
        self.assertEqual(self.roots.output(str(self.root / "new.trk"), suffixes=(".trk",)).name, "new.trk")
        with self.assertRaises(PathRefused):
            self.roots.output(str(self.root / "a.trk"), suffixes=(".trk",))
        self.roots.output(str(self.root / "a.trk"), suffixes=(".trk",), overwrite=True)
        with self.assertRaises(PathRefused):
            self.roots.output(str(self.root / "new.exe"), suffixes=(".trk",))
        with self.assertRaises(PathRefused):
            self.roots.output(str(self.root / "missing" / "new.trk"), suffixes=(".trk",))

    def test_listing(self):
        top = listing(self.roots, "")
        self.assertEqual([e["path"] for e in top["entries"]], [str(self.root.resolve())])
        inside = listing(self.roots, str(self.root))
        kinds = {e["name"]: e["type"] for e in inside["entries"]}
        self.assertEqual(kinds["a.trk"], "file")
        self.assertEqual(kinds["sub"], "dir")
        self.assertEqual(kinds["store.zarr"], "store")
        self.assertIsNone(inside["parent"])
        self.assertEqual(listing(self.roots, str(self.root / "sub"))["parent"], str(self.root.resolve()))
        with self.assertRaises(PathRefused):
            listing(self.roots, str(self.outside))

    def test_find(self):
        found = find(self.roots, "b.trk")
        self.assertEqual([m["path"] for m in found["matches"]], [str(self.root.resolve() / "sub" / "b.trk")])
        self.assertEqual(found["matches"][0]["size"], 2)
        # A symbolic link out of the roots is not followed.
        self.assertEqual(find(self.roots, "secret.trk")["matches"], [])
        with self.assertRaises(PathRefused):
            find(self.roots, "../secret.trk")


if __name__ == "__main__":
    unittest.main()
