"""Validated, immutable handover snapshots. No service or network side effects.

Snapshot directories contain receiver pairing secrets: the caller must provision
the root with SYSTEM/Administrators-only ACLs and use authenticated transport.
CA private keys are never packaged. A snapshot is published only after checks.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import time
import uuid
from contextlib import closing

ID = re.compile(r'[0-9]{13}-[a-f0-9]{32}')
FILES = {'database.sqlite3', 'security/receiver-pairings.json', 'security/root-ca.pem'}

def checked_path(path):
    path = Path(path).absolute()
    for item in (path, *path.parents):
        if item.is_symlink() or (hasattr(item, 'is_junction') and item.is_junction()):
            raise ValueError('Snapshot paths cannot contain links')
    return path

def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()

def atomic_json(path, value):
    path = checked_path(path)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.pending')
    with temporary.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)
        stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)

def check_database(path):
    with closing(sqlite3.connect(checked_path(path).as_uri() + '?mode=ro', uri=True)) as c:
        c.execute('PRAGMA query_only=ON')
        if c.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('Database integrity check failed')
        if c.execute('PRAGMA foreign_key_check').fetchone() is not None:
            raise ValueError('Database foreign key check failed')

def backup_sqlite(source, dest, timeout=60.0):
    source, dest = checked_path(source), checked_path(dest)
    if source == dest or dest.exists(): raise ValueError('Backup requires a new destination')
    started = time.monotonic()
    def progress(status, remaining, total):
        if time.monotonic() - started > timeout: raise TimeoutError('Backup deadline exceeded')
    with closing(sqlite3.connect(source.as_uri()+'?mode=ro', uri=True)) as src, closing(sqlite3.connect(dest)) as dst:
        src.backup(dst, pages=4096, progress=progress, sleep=0.05)
        dst.execute('PRAGMA journal_mode=DELETE')
    check_database(dest)

def ca_fingerprint(path):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    return x509.load_pem_x509_certificate(Path(path).read_bytes()).fingerprint(hashes.SHA256()).hex()

def create_snapshot(workdir, syncdir, securitydir, *, deadline=300):
    workdir, syncdir, securitydir = map(checked_path, (workdir, syncdir, securitydir))
    syncdir.mkdir(parents=True, exist_ok=True)
    identifier = str(int(time.time()*1000)) + '-' + uuid.uuid4().hex
    pending = checked_path(syncdir / ('.pending-' + identifier))
    pending.mkdir()
    backup_sqlite(workdir/'daty-rf.sqlite3', pending/'database.sqlite3', deadline)
    from receiver_pairing import ReceiverPairingPolicy
    from security_storage import secure_directory
    secure_directory(pending/'security')
    # Validate the exact staged bytes, rather than a separately read version.
    for name in ('receiver-pairings.json', 'root-ca.pem'):
        shutil.copyfile(securitydir/name, pending/'security'/name)
    if ReceiverPairingPolicy(pending/'security/receiver-pairings.json')._load() is None:
        raise ValueError('Snapshot pairing registry is missing')
    manifest = {'protocol':'daty-handover-snapshot-v1', 'id':identifier,
        'created_at_ms':int(time.time()*1000), 'ca_sha256':ca_fingerprint(pending/'security/root-ca.pem'),
        'files':{name:{'sha256':digest(pending/name),'bytes':(pending/name).stat().st_size} for name in sorted(FILES)}}
    atomic_json(pending/'manifest.json', manifest)
    destination = syncdir/identifier
    os.replace(pending,destination)
    atomic_json(syncdir/'latest.json', {'id':identifier})
    return manifest

def verify_snapshot(folder, expected_ca, *, max_age=900, now=None):
    folder = checked_path(folder)
    if not ID.fullmatch(folder.name): raise ValueError('Invalid snapshot directory name')
    path = checked_path(folder/'manifest.json')
    if path.stat().st_size > 16384: raise ValueError('Snapshot manifest too large')
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if manifest.get('protocol') != 'daty-handover-snapshot-v1' or manifest.get('id') != folder.name or set(manifest.get('files',{})) != FILES:
        raise ValueError('Invalid snapshot manifest')
    now = time.time() if now is None else now
    age = now-manifest['created_at_ms']/1000
    if age < -30 or age > max_age: raise ValueError('Snapshot stale or timestamp in future')
    if manifest.get('ca_sha256') != expected_ca: raise ValueError('Snapshot belongs to another CA; no implicit identity change')
    for name, metadata in manifest['files'].items():
        file = checked_path(folder/name)
        if file.stat().st_size != metadata['bytes'] or digest(file) != metadata['sha256']:
            raise ValueError('Incomplete or changed snapshot: '+name)
    if ca_fingerprint(folder/'security/root-ca.pem') != expected_ca: raise ValueError('CA fingerprint mismatch')
    check_database(folder/'database.sqlite3')
    from receiver_pairing import ReceiverPairingPolicy
    if ReceiverPairingPolicy(folder/'security/receiver-pairings.json')._load() is None:
        raise ValueError('Snapshot pairing registry is missing')
    return manifest

def restore_snapshot(folder, workdir, securitydir, *, max_age=900):
    """Caller has stopped every writer and owns the maintenance lock.

    Prepare and validate both files first. Old DB/WAL/SHM and pairings are kept;
    failure restores them. No startup, device replay or CA rotation happens here.
    """
    folder, workdir, securitydir = map(checked_path,(folder,workdir,securitydir))
    manifest = verify_snapshot(folder,ca_fingerprint(securitydir/'root-ca.pem'),max_age=max_age)
    db = checked_path(workdir/'daty-rf.sqlite3')
    pairing = checked_path(securitydir/'receiver-pairings.json')
    backup = checked_path(securitydir/('handover-rollback-'+uuid.uuid4().hex));backup.mkdir()
    db_temp = checked_path(workdir/('restore-'+uuid.uuid4().hex+'.sqlite3'))
    pair_temp = checked_path(securitydir/('restore-'+uuid.uuid4().hex+'.json'))
    shutil.copyfile(folder/'database.sqlite3',db_temp);shutil.copyfile(folder/'security/receiver-pairings.json',pair_temp)
    if digest(db_temp)!=manifest['files']['database.sqlite3']['sha256'] or digest(pair_temp)!=manifest['files']['security/receiver-pairings.json']['sha256']:
        raise ValueError('Restore staging copy mismatch')
    previous=[];installed=[]
    try:
        for file in (db,Path(str(db)+'-wal'),Path(str(db)+'-shm'),pairing):
            file=checked_path(file)
            if file.exists():
                saved=backup/file.name
                # copy + replace works across a project volume and ProgramData.
                shutil.copyfile(file,saved)
                if digest(saved)!=digest(file):raise ValueError('Rollback copy mismatch')
                previous.append((file,saved))
        for sidecar in (Path(str(db)+'-wal'),Path(str(db)+'-shm')):
            if sidecar.exists(): sidecar.unlink()
        os.replace(db_temp,db);installed.append(db)
        os.replace(pair_temp,pairing);installed.append(pairing)
    except BaseException:
        for file,saved in previous: shutil.copyfile(saved,file)
        for file in installed:
            if not any(old==file for old,_ in previous):file.unlink()
        raise
    return {'restored':manifest['id'],'rollback':str(backup)}
