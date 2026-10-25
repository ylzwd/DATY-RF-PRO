"""HTTPS request framing and browser-origin checks; no user authorization.

Receiver MQTT pairing is handled independently in receiver_pairing.py.
HTTP audit records describe the observed network peer, not an authenticated user.
"""
from __future__ import annotations
import ipaddress
import json
import re
import socket
from urllib.parse import urlsplit

PROTOCOL = 'daty-direct-control-v1'
MAX_BODY_BYTES = 4 * 1024 * 1024

class HttpRequestError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code

def canonical_origin(value):
    """Exact origins, never globs, Origin:null, credentials, or URL paths."""
    if not isinstance(value, str) or value != value.strip() or any(c.isspace() for c in value):
        return None
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.path or parsed.query or parsed.fragment or '\\' in value):
            return None
        host = parsed.hostname.lower()
        if parsed.netloc.endswith(':') or '%' in host:
            return None
        try:
            host = str(ipaddress.ip_address(host))
        except ValueError:
            if (len(host) > 253 or re.fullmatch(r'[0-9.]+', host)
                    or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                           for label in host.split('.'))):
                return None
        port = parsed.port if parsed.port is not None else (443 if parsed.scheme == 'https' else 80)
        if not 1 <= port <= 65535:
            return None
        host = '[' + host + ']' if ':' in host else host
        default = 443 if parsed.scheme == 'https' else 80
        return f'{parsed.scheme}://{host}' + (f':{port}' if port != default else '')
    except ValueError:
        return None


def origin_allowed(origin, local_host):
    if origin is None:
        return True  # Native API clients do not have browser Origin headers.
    canonical = canonical_origin(origin)
    if canonical is None or not canonical.startswith('https://'):
        return False
    allowed = {'https://localhost:8080', 'https://127.0.0.1:8080', 'https://[::1]:8080'}
    try:
        address = ipaddress.ip_address(local_host.split('%', 1)[0])
        if not address.is_unspecified:
            host = f'[{address}]' if address.version == 6 else str(address)
            allowed.add(f'https://{host}:8080')
    except ValueError:
        pass
    name = socket.gethostname().lower()
    if re.fullmatch(r'[a-z0-9][a-z0-9.-]*', name):
        allowed.add(f'https://{name}:8080')
    return canonical in allowed

class HttpTransportMixin:
    def _origin_allowed(self):
        origins = self.headers.get_all('Origin', [])
        return len(origins) <= 1 and origin_allowed(origins[0] if origins else None, self.connection.getsockname()[0])

    def _http_headers(self):
        origin = self.headers.get('Origin')
        if origin and self._origin_allowed():
            self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Vary', 'Origin, Sec-Fetch-Site, Sec-Fetch-Mode')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')

    def _http_failure(self, error):
        self.close_connection = True
        self._json({'success': False, 'accepted': False, 'code': error.code, 'error': str(error)}, status=error.status)

    def _check_origin(self):
        # Browsers must use an API fetch, not a navigation/image or cross-site no-Origin request.
        browser_context_invalid = (self.headers.get('Sec-Fetch-Mode') in ('navigate', 'no-cors')
            or (not self.headers.get('Origin') and self.headers.get('Sec-Fetch-Site') == 'cross-site'))
        if browser_context_invalid or not self._origin_allowed():
            self._http_failure(HttpRequestError(403, 'ORIGIN_FORBIDDEN', '此网页来源未被服务器允许'))
            return False
        return True

    def _http_options(self):
        if not self._check_origin():
            return
        method = self.headers.get('Access-Control-Request-Method', 'GET')
        requested = {part.strip().lower() for part in self.headers.get('Access-Control-Request-Headers', '').split(',') if part.strip()}
        if method not in ('GET', 'POST') or requested - {'content-type'}:
            self._http_failure(HttpRequestError(403, 'CORS_FORBIDDEN', '不支持的跨域请求'))
            return
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self._http_headers()
        self.end_headers()

    def _request_actor(self):
        return {'kind': 'network-peer', 'authenticated': False, 'ip': self.client_address[0]}

    def _read_json_body(self):
        """Bounded JSON framing before any database operation or device command."""
        lengths = self.headers.get_all('Content-Length', [])
        if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,10}', lengths[0]):
            raise HttpRequestError(400, 'INVALID_BODY', '需要单一有效的 Content-Length')
        length = int(lengths[0])
        if length > MAX_BODY_BYTES:
            raise HttpRequestError(413, 'BODY_TOO_LARGE', '请求超过 4 MiB 限制')
        if len(self.headers.get_all('Content-Type', [])) != 1 or self.headers.get_content_type() != 'application/json':
            raise HttpRequestError(415, 'JSON_REQUIRED', '请求必须使用 application/json')
        self.connection.settimeout(10)
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('Incomplete body')
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError('Object required')
            return body
        except (ValueError, UnicodeError, OSError):
            raise HttpRequestError(400, 'INVALID_BODY', '请求必须是完整的 JSON 对象') from None
