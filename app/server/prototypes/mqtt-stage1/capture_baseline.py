"""Explicit read-only baseline. Never imports Bridge or copies private material."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
FASHE = ROOT.parent / 'FAshe'
SKIP = {'security-bundle', 'logs', 'sync', '__pycache__', '.git', 'prototypes'}
EXT = {'.py', '.js', '.cjs', '.html', '.css', '.json', '.ts', '.ps1', '.bat', '.md', '.txt'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inventory(root):
    entries = {}
    for p in sorted(root.rglob('*')):
        relative = p.relative_to(root)
        if p.is_file() and not set(relative.parts) & SKIP and p.suffix.lower() in EXT:
            # Only source metadata is saved. No configs or source are copied here.
            entries[relative.as_posix()] = {'bytes': p.stat().st_size, 'sha256': sha(p.read_bytes())}
    return entries


def live(path):
    result = subprocess.run(['curl.exe', '--ssl-no-revoke', '--noproxy', '*', '--fail',
        '--silent', '--show-error', '--max-time', '15', 'https://192.0.2.16:8802' + path],
        capture_output=True, check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return json.loads(result.stdout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--output', required=True)
    args = ap.parse_args()
    out = Path(args.output).resolve()
    if any(out.is_relative_to(p.resolve()) for p in (ROOT, FASHE, Path('C:/ProgramData/DATY RF PRO'))):
        raise ValueError('Baseline must be outside production directories')
    out.mkdir(parents=True, exist_ok=False)
    result = {'schema': 'daty-mqtt-stage1-baseline-v1', 'captured_at': datetime.now(timezone.utc).isoformat(),
        'server_source': inventory(ROOT), 'fashe_source': inventory(FASHE), 'live': {}}
    for name, path in [('health', '/health'), ('stats', '/api/stats'),
                       ('database_status', '/api/database/status'), ('devices', '/api/devices')]:
        try:
            result['live'][name] = live(path)
        except Exception as error:
            result['live'][name] = {'capture_error': type(error).__name__}
    # Public identity projection only. Never serialize the registry or secret digests.
    security = Path('C:/ProgramData/DATY RF PRO/security')
    registry = json.loads((security / 'receiver-pairings.json').read_text(encoding='utf-8'))
    fields = ('credential_id', 'receiver_id', 'receiver_mac', 'brand', 'max_channels', 'revoked', 'enrollment')
    result['identity'] = {'receiver_groups': registry.get('receiver_groups', {}), 'receivers': []}
    for record in registry['receivers']:
        public = {key: record[key] for key in fields if key in record}
        if record.get('public_key'):
            public['public_key_sha256'] = sha(json.dumps(record['public_key'], sort_keys=True).encode())
        result['identity']['receivers'].append(public)
    # Public CA only. No TLS private key/config reads.
    result['identity']['ca_pem_sha256'] = sha((security / 'root-ca.pem').read_bytes())
    (out / 'baseline.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'output': str(out / 'baseline.json'), 'server_files': len(result['server_source']),
        'fashe_files': len(result['fashe_source']), 'live_captures': list(result['live']),
        'channels': len(result['live'].get('devices', {}).get('devices', []))}, ensure_ascii=False))


if __name__ == '__main__':
    main()
