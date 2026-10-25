#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DATY RF PRO static web service (v1.0.3).

The old launcher used ``python -m http.server`` directly.  Its Windows
``SO_REUSEADDR`` behaviour permits two scheduled tasks to listen on :8000 at
the same time, so a browser can randomly receive an old copy of the UI.  This
small wrapper deliberately owns port 8080 exclusively and adds no application
state; all device state remains in ``mqtt-bridge.py``.
"""

from __future__ import annotations

import argparse
import io
import ipaddress
import json
import os
import platform
import socket
import stat
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from tls_support import server_context, bind_https, TLSConfigurationError


APP_VERSION = "1.0.3"
WEB_VERSION = "1.0.3"
STATIC_ACCESS_POLICY = "public-assets-v1"

# Release asset manifest, not a directory/extension wildcard. A new script must
# be deliberately published here as part of its release. Runtime data, tests,
# configuration, source maps and backend source never become public merely by
# being copied beside the application. Native clients consume the API instead.
PUBLIC_ASSETS = frozenset({
    "src/platform/database-client.js",
    "src/platform/database-batch-client.js",
    "src/platform/business-repository.js",
    "src/app/business-database.js", "src/app/server-storage.js",
    "src/platform/alert-database.js",
    "src/app/alert-database.js",
    "src/platform/unified-project-sync.js",
    "unirf-app.html", "ws-probe.html", "browser-data-migration.html", "DATYlogo.png",
    "src/assets/daty-audio-logo.png",
    "src/styles/main.css", "src/styles/deploy-progress.css",
    "src/platform/database-connection.js", "src/platform/project-concurrency.js", "src/platform/project-sync.js", "src/modules/planning-project-storage.js",
    "src/platform/browser-platform.js", "src/platform/browser-data-migration.js",
    "src/modules/frequency.js", "src/modules/equipment-profiles.js",
    "src/modules/coordination.js", "src/modules/scan-csv.js",
    "src/modules/storage.js", "src/modules/alert-history.js",
    "src/modules/notification.js", "src/modules/dashboard.js",
    "src/modules/render.js", "src/modules/device-views.js",
    "src/modules/rf-simulation.js", "src/modules/rf-simulation-view.js",
    "src/modules/spectrum.js", "src/modules/navigation.js",
    "src/modules/planning-ui.js", "src/modules/dialogs.js",
    "src/modules/deploy-progress.js", "src/modules/planning-deploy.js",
    "src/modules/timeline.js", "src/modules/discovery.js",
    "src/modules/ip-detection.js", "src/modules/init.js",
    "src/modules/fashe.js",
})
PUBLIC_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
}


def public_route(request_target: str) -> str | None:
    """Return an exact public URL path, rejecting ambiguous path spellings.

    Release assets use ASCII names without escapes. Rejecting escaped paths
    avoids double decoding, Windows separators/ADS and normalization aliases;
    query strings remain available for cache-busting without affecting routing.
    """
    raw_path = request_target.split("?", 1)[0]
    if any(ord(char) < 32 or ord(char) > 126 for char in raw_path):
        return None
    try:
        parsed = urlsplit(request_target)
    except ValueError:
        return None
    path = parsed.path
    if (parsed.scheme or parsed.netloc or parsed.fragment
            or not path.startswith("/") or "%" in path or "\\" in path
            or any(ord(char) < 32 or ord(char) > 126 for char in path)):
        return None
    if path == "/":
        return "/unirf-app.html"
    if path in ("/health", "/local-ip.json") or path[1:] in PUBLIC_ASSETS:
        return path
    return None


def confined_file(root: str, relative_name: str) -> Path | None:
    """Resolve a regular release file without following descendant links.

    Reject Windows junctions/reparse points as well as symbolic links. The
    configured root itself may be an operator-selected deployment directory.
    Only exact manifest names or the internal sanitized IP cache use this.
    """
    try:
        base = Path(root).resolve(strict=True)
        candidate = base
        for part in relative_name.split("/"):
            if part in ("", ".", "..") or ":" in part or "\\" in part:
                return None
            candidate = candidate / part
            metadata = candidate.lstat()
            if stat.S_ISLNK(metadata.st_mode) or (
                getattr(metadata, "st_file_attributes", 0)
                & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
            ):
                return None
        resolved = candidate.resolve(strict=True)
        if (not resolved.is_relative_to(base)
                or os.path.normcase(str(resolved)) != os.path.normcase(str(candidate))
                or not stat.S_ISREG(metadata.st_mode)):
            return None
        return resolved
    except (OSError, RuntimeError, ValueError):
        return None


class ExclusiveThreadingHTTPServer(ThreadingHTTPServer):
    """Prevent duplicate listeners on Windows (see ``ip-service.py``)."""

    allow_reuse_address = False

    def server_bind(self):
        if platform.system() == "Windows":
            option = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
            if option is not None:
                self.socket.setsockopt(socket.SOL_SOCKET, option, 1)
        super().server_bind()


class DatyWebHandler(SimpleHTTPRequestHandler):
    server_version = "DATY-RF-PRO-Web/1.0.3"
    sys_version = ""

    def end_headers(self):
        # A release UI must not stay pinned to a stale cached JS module after
        # the server has been upgraded.  Query-string cache busting remains in
        # the HTML, while these headers also cover direct file requests.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "connect-src https: wss:")
        super().end_headers()

    def json_head(self, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        return io.BytesIO(body)

    def public_ip_snapshot(self):
        # Legacy browser fallback is a projected data response, not permission
        # to download configuration files. Do not expose hostname, platform or
        # any fields later added to the cache. The live IP API remains primary.
        result = {"success": False, "ip": None, "all_ips": []}
        path = confined_file(self.directory, "local-ip.json")
        if path is None:
            return result
        try:
            with path.open("r", encoding="utf-8-sig") as source:
                payload = json.loads(source.read(16385))
            if not isinstance(payload, dict):
                return result
            candidates = payload.get("all_ips", [])
            if isinstance(candidates, str):
                candidates = [candidates]
            if not isinstance(candidates, list):
                candidates = []
            for value in [payload.get("ip")] + candidates[:64]:
                try:
                    address = str(ipaddress.IPv4Address(value)) if isinstance(value, str) else None
                except ipaddress.AddressValueError:
                    address = None
                if address and address not in result["all_ips"]:
                    result["all_ips"].append(address)
            if payload.get("success") is True and result["all_ips"]:
                result["success"] = True
                result["ip"] = result["all_ips"][0]
        except (OSError, ValueError, UnicodeError):
            pass
        return result

    def send_head(self):
        # SimpleHTTPRequestHandler uses this method for BOTH GET and HEAD.
        # No fall-through to its translate_path/list_directory implementation.
        route = public_route(self.path)
        if route == "/health":
            return self.json_head({
                "status": "ok", "service": "DATY RF PRO Web",
                "version": APP_VERSION, "web_version": WEB_VERSION,
                "static_access_policy": STATIC_ACCESS_POLICY,
                "transport_security": getattr(self.server, "transport_security", None),
            })
        if route == "/local-ip.json":
            return self.json_head(self.public_ip_snapshot())
        if route is None:
            self.send_error(404, "Not Found")
            return None
        path = confined_file(self.directory, route[1:])
        if path is None:
            self.send_error(404, "Not Found")
            return None
        try:
            source = path.open("rb")
        except OSError:
            self.send_error(404, "Not Found")
            return None
        try:
            metadata = os.fstat(source.fileno())
            self.send_response(200)
            self.send_header("Content-Type", PUBLIC_CONTENT_TYPES[path.suffix])
            self.send_header("Content-Length", str(metadata.st_size))
            self.send_header("Last-Modified", self.date_time_string(metadata.st_mtime))
            self.end_headers()
            return source
        except Exception:
            source.close()
            raise

    def list_directory(self, path):
        self.send_error(404, "Not Found")
        return None

    def log_message(self, fmt, *args):
        # Keep scheduled-task logs concise but retain the request status for
        # troubleshooting.  SSE/API traffic is served by the bridge, not here.
        sys.stdout.write("[WEB] " + (fmt % args) + "\n")
        sys.stdout.flush()


def run_server(port: int = 8080, root: str | None = None):
    root = os.path.abspath(root or os.path.dirname(__file__))
    handler = partial(DatyWebHandler, directory=root)
    try:
        context = server_context()
        server = bind_https(ExclusiveThreadingHTTPServer, ("0.0.0.0", int(port)), handler, context)
    except TLSConfigurationError as error:
        print(f"[WEB] {error}", flush=True)
        return 2
    except OSError as error:
        print(f"[WEB] 端口 {port} 无法独占（可能已有实例运行）: {error}", flush=True)
        return 2

    print(f"DATY RF PRO Web v{WEB_VERSION} HTTPS listening on 0.0.0.0:{port} root={root}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def main():
    parser = argparse.ArgumentParser(description="DATY RF PRO static web service")
    parser.add_argument("--port", type=int, default=int(os.environ.get("DATY_WEB_PORT", "8080")))
    parser.add_argument("--root", default=os.path.dirname(__file__))
    args = parser.parse_args()
    raise SystemExit(run_server(args.port, args.root))


if __name__ == "__main__":
    main()
