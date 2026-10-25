"""Explicit offline history clearing; creates a checked compact database.

Never called by application startup. Requires stopped runtime, exclusive runtime
lease, expected epoch, and a new backup destination. Settings, identities,
resource versions, plugin registry, and command receipts remain unchanged.
"""
from pathlib import Path
from contextlib import closing
import argparse,hashlib,json,os,shutil,sqlite3,sys,time

ROOT=Path(__file__).resolve().parents[1]
S=ROOT/'app/server'
sys.path[:0]=[str(S),str(S/'prototypes/mqtt-stage3'),str(S/'prototypes/mqtt-stage6')]
from m6_scope import RuntimeScope,plain_path
from unified_schema import validate_schema

CLEAR=('live_sample_payloads','live_sample_blocks','live_samples','telemetry_samples',
       'live_events','timeline_events','scan_datasets','coordination_runs')

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        while chunk:=f.read(4*1024*1024):h.update(chunk)
    return h.hexdigest()

def quote(name):return '"'+name.replace('"','""')+'"'

def compact(config,expected_epoch,backup,report):
    config=plain_path(str(config));settings=json.loads(config.read_text('utf-8-sig'))
    state_path=Path(settings['runtime_directory'])/'runtime-status.json'
    state=json.loads(state_path.read_bytes())
    if state['state']!='stopped':raise ValueError('Graceful server stop required')
    if expected_epoch!=settings['database_epoch']:raise ValueError('Wrong database epoch')
    backup=Path(backup).absolute();report=Path(report).absolute()
    if backup.exists() or report.exists():raise ValueError('New backup/report paths required')
    scope=RuntimeScope(config)
    temp=scope.database.with_name(scope.database.name+'.history-compact.partial')
    try:
        original=scope.database
        if backup==original or backup.parent==original.parent or backup.is_relative_to(scope.public_directory):raise ValueError('Backup must be outside database/public directories')
        if temp.exists():raise ValueError('Prior incomplete compact file exists; inspect first')
        if shutil.disk_usage(backup.parent).free<original.stat().st_size+1024**3:raise ValueError('Backup disk space insufficient')
        for suffix in ('-wal','-journal'):
            p=Path(str(original)+suffix)
            if p.exists() and p.stat().st_size:raise ValueError('Nonempty journal after stop; inspect before replacing')
        backup.parent.mkdir(parents=True,exist_ok=True)
        started=time.monotonic();shutil.copy2(original,backup)
        with backup.open('r+b') as durable_backup:
            durable_backup.flush();os.fsync(durable_backup.fileno())
        if digest(original)!=digest(backup):raise ValueError('Pre-cleanup backup checksum failed')
        print('Stopped database backup verified',flush=True)
        before_bytes=original.stat().st_size;counts={};kept={}
        with closing(sqlite3.connect(original.as_uri()+'?mode=ro',uri=True)) as source, closing(sqlite3.connect(temp)) as target:
            source.execute('PRAGMA query_only=ON');metadata=validate_schema(source)
            if metadata['epoch']!=expected_epoch:raise ValueError('Source epoch changed')
            schema=source.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,rowid").fetchall()
            target.execute('PRAGMA foreign_keys=ON');target.execute('PRAGMA synchronous=FULL')
            target.execute('PRAGMA journal_mode=DELETE')
            with target:
                target.execute('BEGIN IMMEDIATE');target.execute('PRAGMA defer_foreign_keys=ON')
                for _,_,sql in schema:target.execute(sql)
                for kind,name,_ in schema:
                    if kind!='table':continue
                    counts[name]=source.execute('SELECT count(*) FROM '+quote(name)).fetchone()[0]
                    if name in CLEAR:continue
                    cursor=source.execute('SELECT * FROM '+quote(name)+' ORDER BY rowid')
                    width=len(cursor.description);insert='INSERT INTO '+quote(name)+' VALUES('+','.join('?' for _ in range(width))+')'
                    rows=cursor.fetchmany(500)
                    while rows:
                        target.executemany(insert,rows);rows=cursor.fetchmany(500)
                    # EXCEPT compares original typed values; both directions and counts.
                    kept[name]=counts[name]
                target.execute('DELETE FROM sqlite_sequence')
                target.executemany('INSERT INTO sqlite_sequence VALUES(?,?)',source.execute('SELECT name,seq FROM sqlite_sequence').fetchall())
                target.execute('PRAGMA user_version='+str(source.execute('PRAGMA user_version').fetchone()[0]))
                target.execute('PRAGMA application_id='+str(source.execute('PRAGMA application_id').fetchone()[0]))
            target.execute('PRAGMA journal_mode=WAL')
            if validate_schema(target)!=metadata:raise ValueError('Compact schema/identity changed')
            if target.execute('PRAGMA quick_check').fetchall()!=[('ok',)] or target.execute('PRAGMA foreign_key_check').fetchall():raise ValueError('Compact integrity failure')
            target.execute('ATTACH DATABASE ? AS source_check',(str(original),))
            for name,count in kept.items():
                table=quote(name)
                if target.execute('SELECT count(*) FROM '+table).fetchone()[0]!=count:raise ValueError('Retained count differs: '+name)
                for a,b in [('main','source_check'),('source_check','main')]:
                    if target.execute('SELECT * FROM '+a+'.'+table+' EXCEPT SELECT * FROM '+b+'.'+table+' LIMIT 1').fetchone() is not None:raise ValueError('Retained values differ: '+name)
            target.execute('DETACH DATABASE source_check')
            target.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        after_bytes=temp.stat().st_size
        result={'epoch':expected_epoch,'beforeBytes':before_bytes,'afterBytes':after_bytes,
                'cleared':{n:counts[n] for n in CLEAR if n in counts},'retained':kept,
                'backup':str(backup),'backupSHA256':digest(backup),'allRetainedValuesEqual':True,
                'quickCheck':'ok','foreignKeys':'ok','elapsedSeconds':round(time.monotonic()-started,2)}
        # Checked absolute single-file replacement only; never recursive removal.
        if temp.resolve().parent!=original.resolve().parent:raise ValueError('Wrong compact target')
        for suffix in ('-wal','-shm'):
            p=Path(str(original)+suffix)
            if p.exists():
                if suffix=='-wal' and p.stat().st_size:raise ValueError('Journal changed while leased')
                p.unlink()
        os.replace(temp,original)
        report.write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
        print(json.dumps(result,ensure_ascii=False),flush=True)
        return result
    finally:scope.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config',type=Path,required=True)
    parser.add_argument('--expected-epoch',required=True);parser.add_argument('--backup',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True);parser.add_argument('--clear-past-samples',action='store_true',required=True)
    args=parser.parse_args();compact(args.config,args.expected_epoch,args.backup,args.report)
