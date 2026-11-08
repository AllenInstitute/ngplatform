"""A runner on another computer: reached through a forwarded port (--public-url), its /info (host, GPUs), and services behind /svc/."""

from __future__ import annotations

import http.client
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from forwarder import Forwarder
from helpers import TOKEN, Runner

from ngplatform_runner import hostinfo
from ngplatform_runner.server import public_netlocs
from ngplatform_runner.services import Service, Services, free_port, parse_spec

ECHO = [sys.executable, "-m", "ngplatform_runner.echo_service"]


def raw_request(port: int, method: str, path: str, *, host: str, token: str | None = TOKEN, headers: dict | None = None, body: bytes | None = None, timeout: float = 30):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    all_headers = {"Host": host}
    if token is not None:
        all_headers["Authorization"] = f"Bearer {token}"
    all_headers.update(headers or {})
    connection.request(method, path, body=body, headers=all_headers)
    return connection, connection.getresponse()


class PublicUrlTest(unittest.TestCase):
    """The runner as the browser sees it through ``ssh -L 7000:127.0.0.1:<port>``: at localhost:7000."""

    @classmethod
    def setUpClass(cls):
        cls.local = free_port()
        cls.runner = Runner(public_url=f"http://localhost:{cls.local}")
        cls.forwarder = Forwarder(cls.local, cls.runner.port).start()
        store = cls.runner.root / "small.zarr"
        (store / "0").mkdir(parents=True)
        (store / "zarr.json").write_text('{"zarr_format": 3}')
        (store / "0" / "c").write_bytes(bytes(range(50)))

    @classmethod
    def tearDownClass(cls):
        cls.forwarder.close()
        cls.runner.close()

    def through(self, method, path, body=None, *, token=TOKEN, host=None, headers=None):
        return self.runner.request(method, path, body, token=token, port=self.local, headers={"Host": host or f"localhost:{self.local}", **(headers or {})})

    def test_public_host_is_accepted(self):
        for host in (f"localhost:{self.local}", f"127.0.0.1:{self.local}", f"localhost:{self.runner.port}"):
            status, _, body = self.through("GET", "/info", host=host)
            self.assertEqual(status, 200, host)
            self.assertEqual(body["publicUrl"], f"http://localhost:{self.local}")
        # Other names and ports are still refused (DNS rebinding).
        for host in ("evil.example:7000", f"evil.example:{self.local}", "localhost:1"):
            self.assertEqual(self.through("GET", "/info", host=host)[0], 403, host)

    def test_without_public_url_the_tunnel_is_refused(self):
        plain = Runner()
        local = free_port()
        forwarder = Forwarder(local, plain.port).start()
        try:
            status, _, body = plain.request("GET", "/status", port=local, headers={"Host": f"localhost:{local}"})
            self.assertEqual(status, 403)
            self.assertIn("--public-url", body["error"])
        finally:
            forwarder.close()
            plain.close()

    def test_store_urls_through_the_tunnel(self):
        status, _, served = self.through("POST", "/serve", {"path": str(self.runner.root / "small.zarr")})
        self.assertEqual(status, 200, served)
        self.assertTrue(served["url"].startswith(f"http://localhost:{self.local}/stores/"), served["url"])
        self.assertTrue(served["source"].startswith(f"http://localhost:{self.local}/stores/"))
        # The viewer reads it through the tunnel, as the address says.
        path = served["url"].split(str(self.local), 1)[1]
        status, headers, body = self.through("GET", path + "zarr.json", token=None, headers={"Origin": "https://alleninstitute.github.io"})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"zarr_format": 3})
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://alleninstitute.github.io")
        status, headers, _ = self.through("GET", path + "0/c", token=None, headers={"Range": "bytes=5-9"})
        self.assertEqual((status, headers["Content-Range"]), (206, "bytes 5-9/50"))
        # Asked for directly, the same store has the direct address.
        _, _, direct = self.runner.request("GET", "/serve")
        self.assertTrue(all(s["url"].startswith(f"http://127.0.0.1:{self.runner.port}/") for s in direct["serves"]))
        # Both addresses resolve to the path (a job's input may be either).
        for source in (served["source"], direct["serves"][0]["source"]):
            _, _, resolved = self.through("GET", "/resolve?url=" + source.replace("|", "%7C"))
            self.assertEqual(resolved["path"], str((self.runner.root / "small.zarr").resolve()))
        _, _, resolved = self.through("GET", "/resolve?url=" + served["source"].replace(str(self.local), "1").replace("|", "%7C"))
        self.assertIsNone(resolved["path"])

    def test_info(self):
        status, _, info = self.through("GET", "/info")
        self.assertEqual(status, 200)
        for key in ("hostname", "platform", "gpus", "services", "roots", "version"):
            self.assertIn(key, info)
        self.assertIsInstance(info["gpus"], list)
        self.assertEqual(info["address"], f"http://localhost:{self.local}")
        self.assertEqual(self.through("GET", "/info", token=None)[0], 401)


class PublicUrlParseTest(unittest.TestCase):
    def test_netlocs(self):
        self.assertEqual(public_netlocs("http://localhost:7000"), {"localhost:7000", "127.0.0.1:7000", "[::1]:7000"})
        self.assertEqual(public_netlocs("localhost:7000"), {"localhost:7000", "127.0.0.1:7000", "[::1]:7000"})
        self.assertEqual(public_netlocs("https://runner.example.org"), {"runner.example.org:443", "runner.example.org"})
        self.assertEqual(public_netlocs(None), set())
        with self.assertRaises(ValueError):
            public_netlocs("ftp://x:1")


class GpuTest(unittest.TestCase):
    def test_parse(self):
        text = "0, NVIDIA RTX A6000, 49140, 1200, 00000000:2B:00.0\n1, [GPU requires reset], [GPU requires reset], [GPU requires reset], 00000000:41:00.0\n"
        gpus = hostinfo.parse_gpus(text)
        self.assertEqual(gpus[0], {"index": 0, "name": "NVIDIA RTX A6000", "memoryTotal": 49140, "memoryUsed": 1200, "memoryFree": 47940, "busId": "00000000:2B:00.0", "ok": True})
        self.assertEqual(gpus[1]["index"], 1)
        self.assertFalse(gpus[1]["ok"])
        self.assertEqual(gpus[1]["problem"], "GPU requires reset")
        self.assertIsNone(gpus[1]["memoryFree"])
        # A row of one message, and a name with a comma.
        gpus = hostinfo.parse_gpus("Unable to determine the device handle for GPU 0000:41:00.0: GPU requires reset\n2, Tesla, V100, 16000, 10, 0000:3B:00.0\n")
        self.assertFalse(gpus[0]["ok"])
        self.assertEqual(gpus[1]["name"], "Tesla, V100")
        self.assertEqual(hostinfo.parse_gpus(""), [])

    def test_cached(self):
        first = hostinfo.gpus()
        self.assertIsInstance(first, list)
        self.assertEqual(hostinfo.gpus(), first)


class ServiceSpecTest(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_spec('render=/env/bin/python -m ngplatform_render.server --x "a b"'), ("render", ["/env/bin/python", "-m", "ngplatform_render.server", "--x", "a b"]))
        for bad in ("render", "=python", "a b=python", "x=", "x='unclosed"):
            with self.assertRaises(ValueError, msg=bad):
                parse_spec(bad)
        with self.assertRaises(ValueError):
            Services([("a", ["x"]), ("a", ["y"])], roots=[], state_dir=Path(tempfile.gettempdir()))


class ServicesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="ngp-services-")
        state = Path(cls.tmp.name) / "state"
        cls.services = Services([("echo", ECHO), ("broken", [*ECHO, "--fail"]), ("missing", ["/no/such/program"])], roots=["/data/a", "/data/b"], state_dir=state, backoff=0.05)
        cls.runner = Runner(state=state, services=cls.services)
        cls.services.start()
        deadline = time.time() + 20
        while time.time() < deadline and not cls.services.get("echo").info()["ready"]:
            time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.services.stop()
        cls.runner.close()
        cls.tmp.cleanup()

    def svc(self, method, path, body=None, *, token=TOKEN, headers=None):
        return self.runner.request(method, "/svc/" + path, body, token=token, headers=headers)

    def test_ready_and_env(self):
        status, _, info = self.runner.request("GET", "/info")
        self.assertEqual(status, 200)
        self.assertTrue(info["services"]["echo"]["ready"])
        self.assertIsInstance(info["services"]["echo"]["pid"], int)
        status, _, env = self.svc("GET", "echo/env")
        self.assertEqual(status, 200)
        self.assertEqual(env["roots"], ["/data/a", "/data/b"])
        self.assertEqual(env["name"], "echo")
        self.assertEqual(Path(env["stateDir"]), self.runner.state / "services" / "echo")
        self.assertTrue((self.runner.state / "services" / "echo.log").is_file())
        self.assertIn("ready http://127.0.0.1:", (self.runner.state / "services" / "echo.log").read_text())

    def test_proxy(self):
        status, headers, echo = self.svc("POST", "echo/echo?a=1&b=two%20words", {"x": [1, 2]}, headers={"X-Session": "s1", "Origin": "http://localhost:5173"})
        self.assertEqual(status, 200)
        self.assertEqual(echo["method"], "POST")
        self.assertEqual(echo["query"], {"a": ["1"], "b": ["two words"]})
        self.assertEqual(json.loads(echo["body"]), {"x": [1, 2]})
        sent = {k.lower(): v for k, v in echo["headers"].items()}
        self.assertEqual(sent["x-session"], "s1")
        self.assertIn("x-ngp-service-token", sent)
        self.assertNotIn("authorization", sent)  # the runner's token stays with the runner
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:5173")
        self.assertIn("X-Echo-Pid", headers["Access-Control-Expose-Headers"])
        self.assertIn("X-Echo-Pid", headers)
        for method in ("PUT", "DELETE", "GET"):
            status, _, echo = self.svc(method, "echo/echo")
            self.assertEqual((status, echo["method"]), (200, method))
        status, _, body = self.svc("GET", "echo/nothing")
        self.assertEqual(status, 404)

    def test_token_and_origin(self):
        self.assertEqual(self.svc("GET", "echo/env", token=None)[0], 401)
        self.assertEqual(self.svc("GET", "echo/env", token="wrong")[0], 401)
        self.assertEqual(self.svc("GET", "echo/env", headers={"Origin": "https://evil.example"})[0], 403)
        # The service itself refuses what does not come through the runner.
        port, _ = self.services.get("echo").target()
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        connection.request("GET", "/env", headers={"X-NGP-Service-Token": "guess"})
        self.assertEqual(connection.getresponse().status, 403)
        connection.close()
        # A token sent by the page is replaced by the runner's.
        status, _, _ = self.svc("GET", "echo/env", headers={"X-NGP-Service-Token": "guess"})
        self.assertEqual(status, 200)

    def test_preflight(self):
        status, headers, _ = self.runner.request(
            "OPTIONS", "/svc/echo/echo", token=None,
            headers={"Origin": "https://alleninstitute.github.io", "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type,x-session,cookie"},
        )
        self.assertEqual(status, 204)
        self.assertIn("PUT", headers["Access-Control-Allow-Methods"])
        allowed = [h.strip().lower() for h in headers["Access-Control-Allow-Headers"].split(",")]
        self.assertIn("x-session", allowed)
        self.assertNotIn("cookie", allowed)

    def test_streaming(self):
        connection, response = raw_request(self.runner.port, "GET", "/svc/echo/stream?n=4&delay=0.3", host=f"127.0.0.1:{self.runner.port}")
        try:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Transfer-Encoding"), "chunked")
            self.assertEqual(response.getheader("X-Echo-Lines"), "4")
            first = response.readline()
            got_first = time.time()
            self.assertTrue(first.startswith(b"line 0 "))
            rest = response.read()
            done = time.time()
        finally:
            connection.close()
        # Each line came when the service sent it, not all at the end.
        self.assertGreater(done - got_first, 0.6)
        self.assertEqual(rest.count(b"\n"), 3)

    def test_large_answer_keeps_its_length(self):
        connection, response = raw_request(self.runner.port, "GET", "/svc/echo/bytes?n=3000000", host=f"127.0.0.1:{self.runner.port}")
        try:
            self.assertEqual(response.getheader("Content-Length"), "3000000")
            data = response.read()
        finally:
            connection.close()
        self.assertEqual(len(data), 3000000)
        self.assertEqual(data[:5], bytes([0, 1, 2, 3, 4]))

    def test_long_poll(self):
        results = []

        def poll():
            results.append(self.svc("GET", "echo/wait?seconds=2"))

        threads = [threading.Thread(target=poll) for _ in range(3)]
        started = time.time()
        for t in threads:
            t.start()
        # The runner answers other requests meanwhile.
        self.assertEqual(self.runner.request("GET", "/jobs")[0], 200)
        for t in threads:
            t.join()
        self.assertLess(time.time() - started, 5)
        self.assertEqual([r[2] for r in results], [{"waited": 2.0}] * 3)

    def test_unknown_and_failing_services(self):
        status, _, body = self.svc("GET", "nope/x")
        self.assertEqual(status, 404)
        self.assertIn("--service nope=", body["error"])
        deadline = time.time() + 20
        while time.time() < deadline and not (self.services.get("broken").gave_up and self.services.get("missing").gave_up):
            time.sleep(0.05)
        broken = self.services.get("broken")
        self.assertTrue(broken.gave_up)
        self.assertEqual(broken.starts, 5)
        info = self.runner.request("GET", "/info")[2]["services"]
        self.assertFalse(info["broken"]["ready"])
        self.assertIn("exit code 2", info["broken"]["error"])
        self.assertIn("failing on purpose", info["broken"]["error"])
        self.assertIn("could not be started", info["missing"]["error"])
        status, headers, body = self.svc("GET", "broken/x")
        self.assertEqual(status, 503)
        self.assertIn("exit code 2", body["error"])


class RestartTest(unittest.TestCase):
    def test_a_service_that_ends_is_started_again(self):
        with tempfile.TemporaryDirectory(prefix="ngp-services-") as tmp:
            service = Service("echo", ECHO, roots=[], state_dir=Path(tmp), backoff=0.05)
            service.start()
            try:
                self._wait(lambda: service.info()["ready"])
                first = service.info()["pid"]
                port, token = service.target()
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                connection.request("POST", "/exit", headers={"X-NGP-Service-Token": token, "Content-Length": "0"})
                connection.getresponse().read()
                connection.close()
                self._wait(lambda: service.info()["ready"] and service.info()["pid"] not in (None, first))
                self.assertEqual(service.starts, 2)
                self.assertIn("exit code 3", (Path(tmp) / "services" / "echo.log").read_text())
            finally:
                pid = service.info()["pid"]
                service.stop()
            self.assertIsNone(service.info()["pid"])
            from helpers import alive

            self.assertFalse(alive(pid))

    def _wait(self, condition, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if condition():
                return
            time.sleep(0.05)
        raise AssertionError("timed out")


if __name__ == "__main__":
    unittest.main()
