import http.client
import os
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent / "home"))
import login
import proxy

TOKEN = "t" * 40


class ProxyTests(unittest.TestCase):
    def setUp(self):
        os.environ["GARMIN_PROXY_TOKEN"] = TOKEN
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), proxy.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.upstream = MagicMock()
        response = self.upstream.return_value.getresponse.return_value
        response.status, response.read.return_value = 200, b"{}"
        response.getheaders.return_value = [("Set-Cookie", "a=1"), ("Set-Cookie", "b=2"), ("X-Other", "no")]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def call(self, method, path, token=TOKEN, body=None, **kwargs):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        self.addCleanup(conn.close)
        with (
            patch.object(proxy.http.client, "HTTPSConnection", self.upstream),
            patch.object(proxy.Handler, "log_message"),
        ):
            conn.request(
                method, path, body, {"Authorization": f"Bearer {token}", "Cookie": "c=1", "CF-Ray": "x"}, **kwargs
            )
            res = conn.getresponse()
            return res.status, res.getheader("X-Garmin-Proxy"), res.read(), res.headers.get_all("Set-Cookie")

    def test_forwards_allowed_requests_without_the_token_or_cloudflare_headers(self):
        self.assertEqual(self.call("GET", "/gc-api/x?date=1"), (200, "garmin", b"{}", ["a=1", "b=2"]))
        self.assertEqual(self.upstream.call_args.args, ("connect.garmin.com",))
        method, path, _, headers = self.upstream.return_value.request.call_args.args
        self.assertEqual((method, path), ("GET", "/gc-api/x?date=1"))
        self.assertEqual({k: v for k, v in headers.items() if k != "accept-encoding"}, {"cookie": "c=1"})

    def test_forwards_chunked_bodies(self):
        self.call("POST", proxy.GRAPHQL, body=iter([b'{"query":', b'"q"}']), encode_chunked=True)
        self.assertEqual(self.upstream.return_value.request.call_args.args[2], b'{"query":"q"}')

    def test_refuses_everything_else(self):
        self.assertEqual(self.call("GET", "/gc-api/x", token="wrong")[:2], (401, "refused"))
        self.assertEqual(self.call("POST", "/login", token="wrong")[0], 401)
        for method, path in [
            ("GET", "/"),
            ("GET", "/signin/"),
            ("GET", "/app/home/../../x"),
            ("GET", "/gc-api/%2e%2e/x"),
            ("GET", "//evil.example/gc-api/"),
            ("GET", "http://evil.example/gc-api/x"),
            ("POST", "/gc-api/workout-service/workout"),
        ]:
            self.assertEqual(self.call(method, path)[:2], (403, "refused"), path)
        self.assertEqual(self.call("POST", proxy.GRAPHQL, body=b"x" * (proxy.MAX_BODY + 1))[0], 413)
        self.upstream.assert_not_called()

    def test_a_dead_upstream_is_not_reported_as_garmin(self):
        self.upstream.return_value.request.side_effect = OSError("no route")
        self.assertEqual(self.call("GET", "/gc-api/x")[:2], (504, "upstream-error"))


class LoginTests(unittest.TestCase):
    def test_uploads_only_cookies_connect_receives(self):
        kept = {
            d: login.for_connect({"domain": d}) for d in ("connect.garmin.com", ".connect.garmin.com", ".garmin.com")
        }
        self.assertTrue(all(kept.values()))
        for domain in ("sso.garmin.com", ".sso.garmin.com", "xconnect.garmin.com", "evilgarmin.com"):
            self.assertFalse(login.for_connect({"domain": domain}), domain)

    def test_backs_off_after_failures(self):
        self.assertEqual(login.wait_left({}, 0), 0)
        self.assertEqual(login.wait_left({"count": 1, "at": 0}, 25 * 60), 0)
        self.assertEqual(login.wait_left({"count": 2, "at": 0}, 0), 3600)
        self.assertEqual(login.wait_left({"count": 99, "at": 0}, 0), 480 * 60)


if __name__ == "__main__":
    unittest.main()
