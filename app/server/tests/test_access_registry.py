"""Local access-v1 provisioning contracts, isolated from production credentials.

All writes/ACL changes use a newly created daty-security-* OS temporary folder.
Neither ProgramData, production SQLite, services nor receiver controls are used.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
from access_control import AccessError, AccessPolicy, ROLE_PERMISSIONS, canonical_origin

spec = importlib.util.spec_from_file_location("daty_manage_access_test", PROJECT_ROOT / "manage-access.py")
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


def fixture_key(role="operator", **changes):
    identity = secrets.token_hex(8)
    token = f"daty_{identity}_{secrets.token_urlsafe(32)}"
    record = {"id": identity, "name": "fixture", "role": role,
              "token_sha256": hashlib.sha256(token.encode("ascii")).hexdigest(),
              "created_at": time.time(), "expires_at": time.time() + 3600,
              "revoked": False}
    record.update(changes)
    return token, record


class AccessRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="daty-security-registry-test-")
        self.directory = Path(self.temp.name)
        self.registry = self.directory / "access-control.json"
        self.policy = AccessPolicy(self.registry)

    def tearDown(self):
        self.temp.cleanup()

    def write_registry(self, keys, **changes):
        registry = {"version": 1, "allowed_origins": [], "keys": keys}
        registry.update(changes)
        self.registry.write_text(json.dumps(registry), encoding="utf-8")

    def assert_access_error(self, policy, token, status, permission="device.control"):
        with self.assertRaises(AccessError) as raised:
            policy.authenticate("Bearer " + token if token else None, permission)
        self.assertEqual(raised.exception.status, status)

    def cli(self, *arguments, registry=None):
        environment = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
        return subprocess.run(
            [sys.executable, "-B", str(PROJECT_ROOT / "manage-access.py"),
             "--registry", str(registry or self.registry), *arguments],
            capture_output=True, encoding="utf-8", errors="replace", env=environment,
            timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def issue(self, role="operator", name="test fixture"):
        before = set(self.directory.glob("key-*.txt"))
        result = self.cli("issue", "--name", name, "--role", role, "--days", "1")
        self.assertEqual(result.returncode, 0, result.stderr)
        created = set(self.directory.glob("key-*.txt")) - before
        self.assertEqual(len(created), 1)
        path = created.pop()
        token = path.read_text(encoding="ascii").strip()
        self.assertRegex(token, r"^daty_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$")
        self.assertNotIn(token, result.stdout + result.stderr)
        return token, path, result

    def test_missing_and_empty_registry_fail_closed_without_creating_files(self):
        self.assertFalse(self.policy.configured())
        self.assert_access_error(self.policy, None, 503)
        self.assertFalse(self.registry.exists())
        self.write_registry([])
        self.assertFalse(self.policy.configured())
        self.assert_access_error(self.policy, None, 503)

    def test_corrupt_registry_invalidates_previously_authenticated_cache(self):
        token, record = fixture_key()
        self.write_registry([record])
        self.assertEqual(self.policy.authenticate("Bearer " + token)["id"], record["id"])
        for payload in ("{broken", "[]", "null", "{" * (512 * 1024 + 1)):
            with self.subTest(length=len(payload)):
                self.registry.write_text(payload, encoding="utf-8")
                self.assertFalse(self.policy.configured())
                self.assert_access_error(self.policy, token, 503)
        self.registry.unlink()
        self.assert_access_error(self.policy, token, 503)

    def test_invalid_registry_records_fail_closed(self):
        token, record = fixture_key()
        mutations = ({"role": "administrator"}, {"id": "../bad"},
                     {"token_sha256": "z" * 64}, {"token_sha256": token},
                     {"name": ""}, {"expires_at": True}, {"expires_at": float("nan")},
                     {"expires_at": float("inf")}, {"revoked": "false"})
        for mutation in mutations:
            with self.subTest(mutation=next(iter(mutation))):
                self.write_registry([{**record, **mutation}])
                self.assert_access_error(self.policy, token, 503)
        self.write_registry([record, record])
        self.assert_access_error(self.policy, token, 503)
        self.write_registry([record], allowed_origins=["null"])
        self.assert_access_error(self.policy, token, 503)

    def test_expired_revoked_and_permission_limited_credentials(self):
        token, record = fixture_key()
        for changes in ({"expires_at": time.time() - 1}, {"revoked": True}):
            self.write_registry([{**record, **changes}])
            self.assertTrue(self.policy.configured())
            self.assert_access_error(self.policy, token, 401)
        viewer, viewer_record = fixture_key("viewer")
        self.write_registry([viewer_record, record])
        self.assertEqual(self.policy.authenticate("Bearer " + viewer)["role"], "viewer")
        for permission in ROLE_PERMISSIONS["operator"]:
            self.assert_access_error(self.policy, viewer, 403, permission)
            self.assertEqual(self.policy.authenticate("Bearer " + token, permission)["role"], "operator")
        self.assert_access_error(self.policy, token, 403, "unknown.permission")

    def test_bearer_format_and_registry_digest_are_not_credentials(self):
        token, record = fixture_key()
        self.write_registry([record])
        for authorization in (None, "", token, "Basic " + token, "bearer " + token,
                              "Bearer " + record["token_sha256"], "Bearer " + token + " ",
                              "Bearer " + token + "\n", "Bearer token-in-query"):
            with self.subTest(format=type(authorization).__name__):
                with self.assertRaises(AccessError) as raised:
                    self.policy.authenticate(authorization, "device.control")
                self.assertEqual(raised.exception.status, 401)
        self.assertNotIn(token, self.registry.read_text(encoding="utf-8"))

    def test_origin_validation_has_no_wildcard_path_or_ambiguous_port(self):
        valid = {"http://localhost:8080": "http://localhost:8080",
                 "https://example.com:443": "https://example.com",
                 "http://192.0.2.16:8080": "http://192.0.2.16:8080",
                 "http://[::1]:8080": "http://[::1]:8080"}
        for value, canonical in valid.items():
            self.assertEqual(canonical_origin(value), canonical)
        for value in (None, "null", "*", "http://*.example.com", "http://*",
                      "https://user:secret@example.com", "http://example.com/",
                      "http://example.com?query=1", "http://example.com#fragment",
                      "http://example.com:0", "http://example.com:", "http://example.com:65536",
                      "http://example.com,attacker.com", "http://%65xample.com",
                      "http://example.com\\path", " http://example.com", "http://exam\nple.com"):
            with self.subTest(origin=value):
                self.assertIsNone(canonical_origin(value))

    def test_origin_allowance_never_grants_control_permission(self):
        self.assertTrue(self.policy.origin_allowed(None, "127.0.0.1"))
        self.assertTrue(self.policy.origin_allowed("https://localhost:8080", "127.0.0.1"))
        self.assertTrue(self.policy.origin_allowed("https://192.0.2.16:8080", "192.0.2.16"))
        self.assertFalse(self.policy.origin_allowed("http://localhost:8080", "127.0.0.1"))
        self.assertFalse(self.policy.origin_allowed("http://192.0.2.16:8080", "192.0.2.16"))
        self.assertFalse(self.policy.origin_allowed("http://192.0.2.102:8080", "192.0.2.16"))
        self.assertFalse(self.policy.origin_allowed("null", "127.0.0.1"))
        self.assert_access_error(self.policy, None, 503)
        token, record = fixture_key()
        self.write_registry([record], allowed_origins=["https://control.example.com"])
        self.assertTrue(self.policy.origin_allowed("https://control.example.com", "127.0.0.1"))
        self.assertFalse(self.policy.origin_allowed("https://attacker.example.com", "127.0.0.1"))
        self.assert_access_error(self.policy, None, 401)

    def test_cli_generates_unique_keys_registry_has_hash_only_and_list_has_neither(self):
        first, _, _ = self.issue()
        second, _, _ = self.issue("viewer")
        self.assertNotEqual(first, second)
        content = self.registry.read_text(encoding="utf-8")
        self.assertNotIn(first, content)
        self.assertNotIn(second, content)
        registry = json.loads(content)
        self.assertEqual(len(registry["keys"]), 2)
        self.assertEqual({key["token_sha256"] for key in registry["keys"]},
                         {hashlib.sha256(value.encode("ascii")).hexdigest() for value in (first, second)})
        result = self.cli("list")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)["keys"]), 2)
        for private_value in (first, second, *[key["token_sha256"] for key in registry["keys"]]):
            self.assertNotIn(private_value, result.stdout + result.stderr)

    def test_cli_revocation_is_effective_on_next_request_without_new_policy(self):
        token, _, _ = self.issue()
        principal = self.policy.authenticate("Bearer " + token, "device.control")
        result = self.cli("revoke", "--id", principal["id"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(token, result.stdout + result.stderr)
        self.assert_access_error(self.policy, token, 401)

    def test_cli_never_overwrites_corrupt_registry_or_creates_plaintext_key(self):
        original = b"{broken-existing-registry"
        self.registry.write_bytes(original)
        with self.assertRaises(ValueError):
            manager.read_registry(self.registry)
        result = self.cli("issue", "--name", "fixture")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.registry.read_bytes(), original)
        self.assertEqual(list(self.directory.glob("key-*.txt")), [])
        self.assertFalse((self.directory / ".access-admin.lock").exists())

    def test_cli_denies_public_and_broad_directories_before_writing(self):
        public = PROJECT_ROOT / "security" / "test-must-never-exist.json"
        receiver_public = PROJECT_ROOT.parent / "FAshe" / "security" / "test-must-never-exist.json"
        broad = self.directory.parent / "test-must-never-exist.json"
        for path in (public, receiver_public, broad):
            with self.subTest(path=str(path)):
                existed = path.exists()
                with self.assertRaises(ValueError):
                    manager.validate_path(path)
                result = self.cli("issue", "--name", "fixture", registry=path)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(path.exists(), existed)

    def test_cli_invalid_name_expiry_and_origin_do_not_create_registry(self):
        for args in (("issue", "--name", "bad\nname"), ("issue", "--name", "fixture", "--days", "0"),
                     ("issue", "--name", "fixture", "--days", "366"),
                     ("allow-origin", "--origin", "http://example.com/path"),
                     ("allow-origin", "--origin", "http://localhost:8080")):
            with self.subTest(args=args):
                result = self.cli(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.registry.exists())
                self.assertEqual(list(self.directory.glob("key-*.txt")), [])

    @unittest.skipUnless(os.name == "nt", "Windows ACL contract")
    def test_cli_windows_acl_allows_only_current_user_system_and_administrators(self):
        token, key_path, _ = self.issue()
        script = r"""$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$acl = Get-Acl -LiteralPath $env:DATY_TEST_ACL_PATH
$rules = @($acl.Access | ForEach-Object {
  @{sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;
    type=$_.AccessControlType.ToString(); inherited=$_.IsInherited;
    rights=[int]$_.FileSystemRights}
})
@{current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
  protected=$acl.AreAccessRulesProtected; rules=$rules} | ConvertTo-Json -Depth 4 -Compress
"""
        for path in (self.directory, self.registry, key_path):
            with self.subTest(path=path.name):
                result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                    env=dict(os.environ, DATY_TEST_ACL_PATH=str(path)), capture_output=True,
                    text=True, encoding='utf-8', errors='replace', timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
                self.assertEqual(result.returncode, 0, result.stderr)
                acl = json.loads(result.stdout)
                expected = {acl["current"], "S-1-5-18", "S-1-5-32-544"}
                self.assertEqual({rule["sid"] for rule in acl["rules"]}, expected)
                self.assertTrue(all(rule["type"] == "Allow" for rule in acl["rules"]))
                self.assertTrue(all(rule["rights"] & 0x1F01FF == 0x1F01FF for rule in acl["rules"]))
                if path == self.directory:
                    self.assertTrue(acl["protected"])
                self.assertNotIn(token, result.stdout + result.stderr)

    @unittest.skipUnless(os.name == "nt", "Windows junction guard")
    def test_cli_rejects_junction_before_acl_or_file_creation(self):
        import _winapi
        target = self.directory / "daty-security-actual"
        target.mkdir()
        link = self.directory / "daty-security-link"
        _winapi.CreateJunction(str(target), str(link))
        try:
            registry = link / "access-control.json"
            with self.assertRaises(ValueError):
                manager.validate_path(registry)
            result = self.cli("issue", "--name", "fixture", registry=registry)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((target / "access-control.json").exists())
            self.assertEqual(list(target.iterdir()), [])
        finally:
            # Unlink only the junction; never recursively delete a link target.
            link.rmdir()


if __name__ == "__main__":
    unittest.main(verbosity=2)
