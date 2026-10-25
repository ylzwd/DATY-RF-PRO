"""Public-resource contract tests: isolated temp roots, loopback ephemeral HTTP.

No production process, database, receiver or configured service port is used.
"""

import functools
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("daty_web_access_test", PROJECT_ROOT / "web-service.py")
web = importlib.util.module_from_spec(spec)
spec.loader.exec_module(web)


class QuietHandler(web.DatyWebHandler):
    def log_message(self, *args):
        pass


class StaticAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="daty-public-access-")
        cls.root = Path(cls.temp.name) / "public"
        cls.root.mkdir()
        for relative in web.PUBLIC_ASSETS:
            target = cls.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(("public:" + relative).encode("utf-8"))
        for relative in ("daty-rf.sqlite3", "daty-rf.sqlite3-wal", "mqtt-bridge.py",
                         "receiver_pairing.py", "manage-pairings.py", "tls_support.py",
                         "receiver-pairings.json", "access-control.json", "tls-config.json",
                         "root-ca-key.pem", "server-key.pem",
                         "mqtt-config.json", ".env", "version.json", "logs/bridge.log",
                         "tests/fixture.js", "src/modules/unpublished.js",
                         "src/modules/render.js.map", "src/assets/secret.png",
                         "profiles/equipment-profile.template.json"):
            target = cls.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("PRIVATE_SENTINEL", encoding="utf-8")
        cls.ip_path = cls.root / "local-ip.json"
        cls.http = web.ExclusiveThreadingHTTPServer(
            ("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(cls.root)))
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.worker.join(timeout=3)
        cls.temp.cleanup()

    def request(self, target, method="GET", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=3)
        try:
            connection.request(method, target, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_01_entire_public_manifest_get_and_head(self):
        for relative in sorted(web.PUBLIC_ASSETS):
            with self.subTest(relative=relative):
                get = self.request("/" + relative + "?v=release-test")
                head = self.request("/" + relative, "HEAD")
                self.assertEqual(get[0], 200)
                self.assertEqual(head[0], 200)
                self.assertEqual(get[2], ("public:" + relative).encode())
                self.assertEqual(head[2], b"")
                self.assertEqual(head[1]["Content-Length"], str(len(get[2])))
                self.assertEqual(get[1]["Content-Type"], web.PUBLIC_CONTENT_TYPES[Path(relative).suffix])

    def test_02_root_is_application_not_directory(self):
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"public:unirf-app.html")
        self.assertNotIn(b"Directory listing", body)
        self.assertNotIn("Location", headers)

    def test_03_sensitive_and_unpublished_resources_are_not_public(self):
        for target in ("/daty-rf.sqlite3", "/daty-rf.sqlite3-wal", "/daty-rf.sqlite3-shm",
                       "/mqtt-bridge.py", "/web-service.py", "/mqtt-config.json", "/.env",
                       "/receiver_pairing.py", "/manage-pairings.py", "/tls_support.py",
                       "/receiver-pairings.json", "/access-control.json", "/tls-config.json",
                       "/root-ca-key.pem", "/server-key.pem", "/security/",
                       "/version.json", "/logs/bridge.log", "/tests/fixture.js",
                       "/src/modules/unpublished.js", "/src/modules/render.js.map",
                       "/src/assets/secret.png", "/profiles/equipment-profile.template.json",
                       "/src", "/src/", "/src/modules/", "/logs/", "/profiles/"):
            for method in ("GET", "HEAD"):
                with self.subTest(target=target, method=method):
                    status, headers, body = self.request(target, method)
                    self.assertEqual(status, 404)
                    self.assertNotIn(b"PRIVATE_SENTINEL", body)
                    self.assertNotIn(str(self.root).encode(), body)
                    self.assertNotIn("Location", headers)
                    if method == "HEAD":
                        self.assertEqual(body, b"")

    def test_04_path_normalization_and_windows_aliases_are_rejected(self):
        targets = ("/../unirf-app.html", "/src/../unirf-app.html", "/./unirf-app.html",
                   "/%75nirf-app.html", "/%2e%2e/unirf-app.html", "/%252e%252e/mqtt-bridge.py",
                   "/src%2fmodules%2frender.js", "/src\\modules\\render.js",
                   "/src/%5c../mqtt-bridge.py", "/DATYlogo.png::$DATA", "/DATYlogo.png.",
                   "/DATYlogo.png%20", "/DATYlogo.png%00.py", "/src//modules/render.js",
                   "/UNIRF-APP.HTML", "/unirf-app.html/", "/unirf-app.html;fake",
                   "/C:/Windows/win.ini", "/%", "/%FF", "/health/", "/health#fragment",
                   "http://example.invalid/unirf-app.html")
        for target in targets:
            for method in ("GET", "HEAD"):
                with self.subTest(target=target, method=method):
                    self.assertEqual(self.request(target, method)[0], 404)
        # The stdlib strips leading // during request parsing. The independent
        # policy still rejects it so reverse-proxy/native contract is explicit.
        self.assertIsNone(web.public_route("//example.invalid/unirf-app.html"))
        self.assertIsNone(web.public_route("/unirf-\tapp.html"))

    def test_05_health_has_shared_head_semantics_and_no_filesystem_details(self):
        get = self.request("/health?probe=readonly")
        head = self.request("/health", "HEAD")
        self.assertEqual(get[0], 200)
        self.assertEqual(head[0], 200)
        payload = json.loads(get[2])
        self.assertEqual(payload["static_access_policy"], "public-assets-v1")
        self.assertEqual(payload["status"], "ok")
        self.assertNotIn("root", payload)
        self.assertNotIn("pid", payload)
        self.assertEqual(head[2], b"")
        self.assertEqual(head[1]["Content-Length"], get[1]["Content-Length"])

    def test_06_no_wildcard_cors_and_security_headers_every_response(self):
        for target in ("/unirf-app.html", "/health", "/mqtt-bridge.py"):
            status, headers, body = self.request(target, headers={"Origin": "https://attacker.invalid"})
            self.assertNotIn("Access-Control-Allow-Origin", headers)
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(headers["X-Frame-Options"], "DENY")
            self.assertEqual(headers["Referrer-Policy"], "no-referrer")
            self.assertEqual(headers["Content-Security-Policy"], "connect-src https: wss:")
            self.assertNotIn("Python", headers["Server"])

    def test_07_ip_fallback_is_a_validated_projection_not_raw_config(self):
        self.ip_path.write_text(json.dumps({"success": True, "ip": "1",
            "all_ips": "192.0.2.16", "hostname": "PRIVATE_SENTINEL",
            "token": "PRIVATE_SENTINEL", "platform": "PRIVATE_SENTINEL"}), encoding="utf-8")
        get = self.request("/local-ip.json?t=1")
        head = self.request("/local-ip.json", "HEAD")
        self.assertEqual(get[0], 200)
        self.assertEqual(json.loads(get[2]), {"success": True, "ip": "192.0.2.16", "all_ips": ["192.0.2.16"]})
        self.assertNotIn(b"PRIVATE_SENTINEL", get[2])
        self.assertEqual(head[1]["Content-Length"], get[1]["Content-Length"])
        self.assertEqual(head[2], b"")

    def test_08_ip_fallback_invalid_json_is_safe(self):
        for raw in ("not-json", "[]", '{"success":true,"ip":"not-an-ip"}', "{" * 17000):
            self.ip_path.write_text(raw, encoding="utf-8")
            self.assertEqual(json.loads(self.request("/local-ip.json")[2]),
                             {"success": False, "ip": None, "all_ips": []})

    def test_09_file_symlink_cannot_publish_private_content(self):
        public_file = self.root / "DATYlogo.png"
        original = public_file.read_bytes()
        public_file.unlink()
        try:
            try:
                public_file.symlink_to(self.root / "daty-rf.sqlite3")
            except OSError as error:
                self.skipTest("File symlinks unavailable in this Windows session: " + str(error))
            for method in ("GET", "HEAD"):
                self.assertEqual(self.request("/DATYlogo.png", method)[0], 404)
        finally:
            if public_file.is_symlink():
                public_file.unlink()
            public_file.write_bytes(original)

    def test_10_directory_symlink_cannot_escape_root(self):
        directory = self.root / "src/assets"
        backup = self.root / "src/assets-link-test-backup"
        outside = Path(self.temp.name) / "outside"
        outside.mkdir(exist_ok=True)
        (outside / "daty-audio-logo.png").write_bytes(b"PRIVATE_SENTINEL")
        directory.rename(backup)
        try:
            try:
                directory.symlink_to(outside, target_is_directory=True)
            except OSError as error:
                self.skipTest("Directory symlinks unavailable in this Windows session: " + str(error))
            for method in ("GET", "HEAD"):
                self.assertEqual(self.request("/src/assets/daty-audio-logo.png", method)[0], 404)
        finally:
            if directory.is_symlink():
                directory.unlink()
            backup.rename(directory)

    def test_11_release_html_dependencies_are_explicitly_published(self):
        html = (PROJECT_ROOT / "unirf-app.html").read_text(encoding="utf-8")
        dependencies = re.findall(r'(?:src|href)=["\']([^"\']+)["\']', html)
        for dependency in dependencies:
            if dependency.startswith(("http:", "https:", "data:", "#")):
                continue
            relative = dependency.split("?", 1)[0]
            with self.subTest(asset=relative):
                self.assertIn(relative, web.PUBLIC_ASSETS)
                self.assertTrue((PROJECT_ROOT / relative).is_file())

    def test_12_directories_disguised_as_manifest_files_are_rejected(self):
        public_file = self.root / "DATYlogo.png"
        original = public_file.read_bytes()
        public_file.unlink()
        public_file.mkdir()
        try:
            for method in ("GET", "HEAD"):
                self.assertEqual(self.request("/DATYlogo.png", method)[0], 404)
        finally:
            public_file.rmdir()
            public_file.write_bytes(original)

    @unittest.skipUnless(os.name == "nt", "Windows junction test")
    def test_13_real_windows_junction_cannot_escape_root(self):
        import _winapi
        directory = self.root / "src/assets"
        backup = self.root / "src/assets-junction-test-backup"
        outside = Path(self.temp.name) / "junction-outside"
        outside.mkdir(exist_ok=True)
        (outside / "daty-audio-logo.png").write_bytes(b"PRIVATE_SENTINEL")
        directory.rename(backup)
        linked = False
        try:
            _winapi.CreateJunction(str(outside), str(directory))
            linked = True
            for method in ("GET", "HEAD"):
                self.assertEqual(self.request("/src/assets/daty-audio-logo.png", method)[0], 404)
        finally:
            if linked:
                # Remove ONLY the link, never recurse into its target.
                directory.rmdir()
            backup.rename(directory)
        self.assertEqual((outside / "daty-audio-logo.png").read_bytes(), b"PRIVATE_SENTINEL")

    def test_14_file_reparse_and_symbolic_flags_fail_closed_without_privilege(self):
        original = Path.lstat
        for flag in ("symbolic", "reparse"):
            def fake_lstat(path, *args, **kwargs):
                result = original(path, *args, **kwargs)
                if path.name == "DATYlogo.png":
                    return SimpleNamespace(
                        st_mode=web.stat.S_IFLNK if flag == "symbolic" else result.st_mode,
                        st_file_attributes=0x400 if flag == "reparse" else 0)
                return result
            with self.subTest(flag=flag), mock.patch.object(Path, "lstat", fake_lstat):
                self.assertIsNone(web.confined_file(str(self.root), "DATYlogo.png"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
