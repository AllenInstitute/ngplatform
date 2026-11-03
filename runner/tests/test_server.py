"""The runner's API: the token, origins and preflights, jobs from start to end, cancelling, restarts, serving."""

from __future__ import annotations

import json
import re
import time
import unittest

from helpers import FIXTURES, TOKEN, Runner, alive, tools_available

SPHERE = {"format": "zvf-predicate", "version": 1, "tree": {"op": "passes", "mode": "path", "region": {"type": "sphere", "center": [0, -10, 0], "radius": 25}}}


class AccessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runner = Runner()

    @classmethod
    def tearDownClass(cls):
        cls.runner.close()

    def test_token_is_required(self):
        status, _, body = self.runner.request("GET", "/status", token=None)
        self.assertEqual(status, 401)
        self.assertIn("token", body["error"])
        self.assertEqual(self.runner.request("GET", "/jobs", token="wrong")[0], 401)
        status, _, body = self.runner.request("GET", "/status")
        self.assertEqual(status, 200)
        self.assertEqual(body["name"], "ngplatform-runner")
        self.assertIn("sleep", [k["kind"] for k in body["kinds"]])

    def test_origins(self):
        for origin in ["https://alleninstitute.github.io", "http://localhost:5173", "http://127.0.0.1:4240"]:
            status, headers, _ = self.runner.request("GET", "/status", headers={"Origin": origin})
            self.assertEqual(status, 200, origin)
            self.assertEqual(headers.get("Access-Control-Allow-Origin"), origin)
        status, headers, _ = self.runner.request("GET", "/status", headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_preflight_with_private_network_access(self):
        status, headers, _ = self.runner.request(
            "OPTIONS", "/jobs", token=None,
            headers={"Origin": "https://alleninstitute.github.io", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type", "Access-Control-Request-Private-Network": "true"},
        )
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://alleninstitute.github.io")
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")
        self.assertIn("Authorization", headers["Access-Control-Allow-Headers"])
        self.assertIn("POST", headers["Access-Control-Allow-Methods"])
        status, headers, _ = self.runner.request("OPTIONS", "/jobs", token=None, headers={"Origin": "https://evil.example", "Access-Control-Request-Private-Network": "true"})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Private-Network", headers)

    def test_host_must_be_this_computer(self):
        status, _, _ = self.runner.request("GET", "/status", headers={"Host": "attacker.example:80"})
        self.assertEqual(status, 403)

    def test_only_known_kinds(self):
        status, _, body = self.runner.request("POST", "/jobs", {"kind": "shell", "args": {"command": "rm -rf /"}})
        self.assertEqual(status, 400)
        self.assertIn("unknown job kind", body["error"])
        status, _, body = self.runner.request("POST", "/jobs", {"kind": "serve", "args": {}})
        self.assertEqual(status, 400)

    def test_paths_outside_the_roots_are_refused(self):
        status, _, body = self.runner.request("GET", "/files?path=/etc")
        self.assertEqual(status, 403)
        status, _, _ = self.runner.request("POST", "/jobs", {"kind": "filter", "args": {"input": "/etc/passwd", "filter": SPHERE, "trk": str(self.runner.root / "x.trk")}})
        self.assertEqual(status, 403)
        status, _, _ = self.runner.request("POST", "/jobs", {"kind": "sleep", "args": {"output": "/tmp/elsewhere.txt"}})
        self.assertEqual(status, 403)
        status, _, body = self.runner.request("GET", "/files")
        self.assertEqual(status, 200)
        self.assertEqual(body["entries"][0]["path"], str(self.runner.root.resolve()))


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.runner = Runner(max_running=1)

    def tearDown(self):
        self.runner.close()

    def test_a_job_runs_to_the_end(self):
        out = self.runner.root / "slept.txt"
        status, _, job = self.runner.request("POST", "/jobs", {"kind": "sleep", "args": {"seconds": 0.4, "steps": 4, "output": str(out)}})
        self.assertEqual(status, 201)
        self.assertIn(job["state"], ("queued", "running"))
        self.assertIsInstance(job["pid"], int)
        seen = set()
        deadline = time.time() + 30
        while time.time() < deadline:
            _, _, now = self.runner.request("GET", f"/jobs/{job['id']}")
            if now["progress"] is not None:
                seen.add(now["progress"])
            if now["state"] == "done":
                break
            time.sleep(0.03)
        self.assertEqual(now["state"], "done")
        self.assertEqual(now["progress"], 1.0)
        self.assertEqual(now["returncode"], 0)
        self.assertTrue(any(0 < p < 1 for p in seen), seen)
        self.assertEqual(now["outputs"], [{"path": str(out.resolve()), "type": "file"}])
        self.assertTrue(out.is_file())
        _, _, log = self.runner.request("GET", f"/jobs/{job['id']}/log")
        self.assertIn("Step 4 of 4", log["text"])
        _, _, listed = self.runner.request("GET", "/jobs")
        self.assertEqual(listed["jobs"][0]["id"], job["id"])
        self.assertEqual(self.runner.request("DELETE", f"/jobs/{job['id']}")[0], 200)
        self.assertEqual(self.runner.request("GET", "/jobs")[2]["jobs"], [])

    def test_a_failing_job(self):
        _, _, job = self.runner.request("POST", "/jobs", {"kind": "sleep", "args": {"seconds": 0.1, "steps": 1, "fail": True}})
        job = self.runner.wait(job["id"])
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["returncode"], 3)
        self.assertIn("failed as asked", job["message"])

    def test_queue(self):
        _, _, first = self.runner.request("POST", "/jobs", {"kind": "sleep", "args": {"seconds": 1, "steps": 2}})
        _, _, second = self.runner.request("POST", "/jobs", {"kind": "sleep", "args": {"seconds": 0.1, "steps": 1}})
        self.assertEqual(second["state"], "queued")
        self.assertIsNone(second["pid"])
        self.runner.wait(first["id"])
        self.assertEqual(self.runner.wait(second["id"])["state"], "done")

    def test_cancel_ends_the_process_tree(self):
        _, _, job = self.runner.request("POST", "/jobs", {"kind": "sleep", "args": {"seconds": 60, "steps": 60, "child": True}})
        deadline = time.time() + 20
        child = None
        while child is None and time.time() < deadline:
            _, _, log = self.runner.request("GET", f"/jobs/{job['id']}/log")
            m = re.search(r"child pid (\d+)", log["text"])
            child = int(m.group(1)) if m else None
            time.sleep(0.05)
        self.assertIsNotNone(child)
        self.assertTrue(alive(job["pid"]))
        self.assertTrue(alive(child))
        status, _, cancelled = self.runner.request("POST", f"/jobs/{job['id']}/cancel")
        self.assertEqual(status, 200)
        job = self.runner.wait(job["id"])
        self.assertEqual(job["state"], "cancelled")
        deadline = time.time() + 10
        while alive(child) and time.time() < deadline:
            time.sleep(0.05)
        self.assertFalse(alive(job["pid"]))
        self.assertFalse(alive(child))

    def test_cancel_a_queued_job(self):
        _, _, first = self.runner.request("POST", "/jobs", {"kind": "sleep", "args": {"seconds": 1, "steps": 2}})
        _, _, second = self.runner.request("POST", "/jobs", {"kind": "sleep", "args": {"seconds": 1, "steps": 1}})
        _, _, cancelled = self.runner.request("POST", f"/jobs/{second['id']}/cancel")
        self.assertEqual(cancelled["state"], "cancelled")
        self.assertIsNone(cancelled["pid"])
        self.runner.wait(first["id"])


class RestartTest(unittest.TestCase):
    def test_state_survives_a_restart(self):
        runner = Runner()
        try:
            _, _, done = runner.request("POST", "/jobs", {"kind": "sleep", "args": {"seconds": 0.1, "steps": 1}})
            runner.wait(done["id"])
            _, _, long = runner.request("POST", "/jobs", {"kind": "sleep", "args": {"seconds": 1.5, "steps": 3}})
            runner.wait(long["id"], states=("running",))
            runner.stop()  # the runner stops; the job carries on
            self.assertTrue(alive(long["pid"]))
            runner.start()
            _, _, listed = runner.request("GET", "/jobs")
            by_id = {j["id"]: j for j in listed["jobs"]}
            self.assertEqual(by_id[done["id"]]["state"], "done")
            self.assertEqual(by_id[long["id"]]["state"], "running")
            self.assertEqual(by_id[long["id"]]["pid"], long["pid"])
            finished = runner.wait(long["id"])
            self.assertEqual(finished["state"], "done")
            self.assertEqual(finished["returncode"], 0)
            self.assertEqual(finished["progress"], 1.0)
            # New jobs get new ids.
            _, _, third = runner.request("POST", "/jobs", {"kind": "sleep", "args": {"seconds": 0.1, "steps": 1}})
            self.assertNotIn(third["id"], by_id)
        finally:
            runner.close()

    def test_cancel_after_a_restart(self):
        runner = Runner()
        try:
            _, _, job = runner.request("POST", "/jobs", {"kind": "sleep", "args": {"seconds": 60, "steps": 60}})
            runner.wait(job["id"], states=("running",))
            runner.stop()
            runner.start()
            runner.request("POST", f"/jobs/{job['id']}/cancel")
            self.assertEqual(runner.wait(job["id"])["state"], "cancelled")
            deadline = time.time() + 10
            while alive(job["pid"]) and time.time() < deadline:
                time.sleep(0.05)
            self.assertFalse(alive(job["pid"]))
        finally:
            runner.close()

    def test_a_job_that_died_unseen_is_failed(self):
        runner = Runner()
        try:
            state = runner.state / "state.json"
            runner.stop()
            data = json.loads(state.read_text())
            data["jobs"].append({"id": "99", "kind": "sleep", "title": "Lost", "args": {}, "state": "running", "pid": 2 ** 22 + 7, "outputs": []})
            state.write_text(json.dumps(data))
            runner.start()
            _, _, job = runner.request("GET", "/jobs/99")
            self.assertEqual(job["state"], "failed")
            self.assertIn("runner stopped", job["message"])
        finally:
            runner.close()


class ServeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runner = Runner()
        store = cls.runner.root / "small.zarr"
        (store / "0" / "vertices").mkdir(parents=True)
        (store / "zarr.json").write_text('{"zarr_format": 3}')
        (store / "0" / "vertices" / "c").write_bytes(bytes(range(100)))
        (cls.runner.root / "secret.txt").write_text("not served")

    @classmethod
    def tearDownClass(cls):
        cls.runner.close()

    def test_a_store(self):
        status, _, served = self.runner.request("POST", "/serve", {"path": str(self.runner.root / "small.zarr")})
        self.assertEqual(status, 200, served)
        self.assertTrue(served["ready"])
        self.assertTrue(served["source"].endswith("/small.zarr/|zarr-vectors:"))
        path = served["url"].split(str(self.runner.port), 1)[1]
        status, headers, body = self.runner.request("GET", path + "zarr.json", token=None, headers={"Origin": "https://alleninstitute.github.io"})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"zarr_format": 3})
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        status, headers, _ = self.runner.request("GET", path + "0/vertices/c", token=None, headers={"Range": "bytes=10-19"})
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Range"], "bytes 10-19/100")
        status, _, listing = self.runner.request("GET", path + "0/", token=None)
        self.assertIn('href="vertices/"', listing)
        # Nothing outside the served store, and nothing without the id.
        self.assertEqual(self.runner.request("GET", path + "../secret.txt", token=None)[0], 404)
        self.assertEqual(self.runner.request("GET", path + "%2E%2E/secret.txt", token=None)[0], 404)
        self.assertEqual(self.runner.request("GET", "/stores/" + "0" * 32 + "/small.zarr/zarr.json", token=None)[0], 404)
        # The same path is served once; a served URL resolves to its path.
        _, _, again = self.runner.request("POST", "/serve", {"path": str(self.runner.root / "small.zarr")})
        self.assertEqual(again["id"], served["id"])
        _, _, resolved = self.runner.request("GET", "/resolve?url=" + served["source"].replace("|", "%7C"))
        self.assertEqual(resolved["path"], str((self.runner.root / "small.zarr").resolve()))
        _, _, listed = self.runner.request("GET", "/serve")
        self.assertIn(served["id"], [s["id"] for s in listed["serves"]])

    def test_preflight_for_stores(self):
        status, headers, _ = self.runner.request("OPTIONS", "/stores/x/y", token=None, headers={"Origin": "https://anywhere.example", "Access-Control-Request-Private-Network": "true"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")

    def test_refused(self):
        self.assertEqual(self.runner.request("POST", "/serve", {"path": str(self.runner.root / "secret.txt")})[0], 403)
        self.assertEqual(self.runner.request("POST", "/serve", {"path": "/etc/hosts"})[0], 403)


@unittest.skipUnless(tools_available(), "zarr-vectors-tools is not importable")
class ToolsTest(unittest.TestCase):
    """Real jobs, with zarr-vectors-tools, on a small tractogram."""

    @classmethod
    def setUpClass(cls):
        cls.runner = Runner()
        (cls.runner.root / "ras.trk").write_bytes((FIXTURES / "ras.trk").read_bytes())

    @classmethod
    def tearDownClass(cls):
        cls.runner.close()

    def test_filter_then_serve_the_results(self):
        root = self.runner.root
        status, _, job = self.runner.request("POST", "/jobs", {"kind": "filter", "args": {"input": str(root / "ras.trk"), "filter": SPHERE, "trk": str(root / "f.trk"), "store": str(root / "f.zarr"), "levels": 1, "name": "sphere"}})
        self.assertEqual(status, 201, job)
        self.assertEqual(job["title"], "Filter ras.trk: sphere")
        job = self.runner.wait(job["id"], timeout=120)
        self.assertEqual(job["state"], "done", job["message"])
        self.assertEqual([o["type"] for o in job["outputs"]], ["trk", "zarr-vectors"])
        _, _, log = self.runner.request("GET", f"/jobs/{job['id']}/log")
        self.assertIn("3 of 60 streamlines pass", log["text"])
        self.assertTrue((root / "f.zarr" / "zarr.json").is_file())
        # The .trk served as a virtual store, through a process of its own.
        _, _, served = self.runner.request("POST", "/serve", {"path": str(root / "f.trk")})
        self.assertEqual(served["mode"], "virtual")
        deadline = time.time() + 60
        while not served["ready"] and time.time() < deadline:
            time.sleep(0.1)
            served = next(s for s in self.runner.request("GET", "/serve")[2]["serves"] if s["id"] == served["id"])
        self.assertTrue(served["ready"], served)
        path = served["url"].split(str(self.runner.port), 1)[1]
        status, _, meta = self.runner.request("GET", path + "zarr.json", token=None)
        self.assertEqual(status, 200)
        self.assertEqual(meta["attributes"]["zarr_vectors"]["geometry_types"], ["streamline"])
        # A served URL is a job's input.
        status, _, density = self.runner.request("POST", "/jobs", {"kind": "density", "args": {"input": served["source"], "filter": {"format": "zvf-predicate", "version": 1, "tree": {"op": "all"}}, "output": str(root / "d.nii.gz")}})
        self.assertEqual(status, 201, density)
        self.assertEqual(density["args"]["input"], str((root / "f.trk").resolve()))
        self.assertEqual(self.runner.wait(density["id"], timeout=120)["state"], "done")
        self.assertEqual(self.runner.request("DELETE", f"/serve/{served['id']}")[0], 200)
        self.assertEqual(self.runner.wait(served["job"])["state"], "cancelled")

    def test_convert(self):
        root = self.runner.root
        _, _, job = self.runner.request("POST", "/jobs", {"kind": "convert", "args": {"input": str(root / "ras.trk"), "output": str(root / "c.zarr"), "levels": 2}})
        job = self.runner.wait(job["id"], timeout=120)
        self.assertEqual(job["state"], "done", job["message"])
        self.assertEqual(job["progress"], 1.0)
        self.assertTrue((root / "c.zarr" / "2").is_dir())


if __name__ == "__main__":
    unittest.main()
