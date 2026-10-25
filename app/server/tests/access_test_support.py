"""Explicit test credentials in temporary files; never load production access keys."""
import hashlib
import json
from pathlib import Path
import time


TEST_TOKEN = 'daty_0123456789abcdef_' + 'A' * 43


def make_test_policy(bridge, directory, *, role='operator', token=TEST_TOKEN,
                     revoked=False, expired=False, origins=None):
    path = Path(directory) / 'isolated-access.json'
    now = time.time()
    path.write_text(json.dumps({
        'version': 1,
        'allowed_origins': origins or [],
        'keys': [{
            'id': '0123456789abcdef', 'name': 'Isolated test principal',
            'role': role, 'token_sha256': hashlib.sha256(token.encode()).hexdigest(),
            'created_at': now - 60, 'expires_at': now - 1 if expired else now + 3600,
            'revoked': revoked,
        }],
    }), encoding='utf-8')
    return type(bridge._access_policy)(path)


def authorized_headers(**extra):
    return {'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + TEST_TOKEN, **extra}
