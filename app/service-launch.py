"""Windows task entry for the fixed r19 data-management candidate runtime; no auto replay."""
import argparse, hashlib, io, json, os, runpy, sys
from datetime import datetime, timezone
from pathlib import Path

parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);args=parser.parse_args()
root=Path(__file__).resolve().parent
config=Path(args.config).resolve()
settings=json.loads(config.read_text('utf-8-sig'))
runtime=Path(settings['runtime_directory'])
runtime.mkdir(parents=True,exist_ok=True)
log=runtime/('service-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+str(os.getpid())+'.log')
with log.open('xb') as stream:
    os.dup2(stream.fileno(),1);os.dup2(stream.fileno(),2)
sys.stdout=io.TextIOWrapper(os.fdopen(os.dup(1),'wb'),encoding='utf-8',line_buffering=True)
sys.stderr=io.TextIOWrapper(os.fdopen(os.dup(2),'wb'),encoding='utf-8',line_buffering=True)
manifest=json.loads((root/'package-manifest.json').read_text('utf-8'))
for name,digest in manifest['files'].items():
    target=root/name
    if not target.resolve().is_relative_to(root) or hashlib.sha256(target.read_bytes()).hexdigest()!=digest:
        raise ValueError('PACKAGE_HASH_MISMATCH: '+name)
runner=root/'server/prototypes/mqtt-stage6/m6_runner.py'
sys.argv=[str(runner),'--config',str(config),'--broker',str(root/'tools/broker/mosquitto.exe'),
          '--paho-root',str(root/'tools/pylib')]
runpy.run_path(str(runner),run_name='__main__')
