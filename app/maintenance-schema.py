"""Explicit offline r19 index maintenance; inspect is read-only by default.

Do not point upgrade/rollback at a running server. This utility does not stop
tasks or prove writers are stopped; the operator must establish that first.
"""
import argparse,json,sqlite3,sys
from pathlib import Path

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--database',required=True)
    parser.add_argument('--action',choices=('inspect','upgrade','rollback'),default='inspect')
    parser.add_argument('--expected-epoch')
    parser.add_argument('--writers-stopped',action='store_true')
    args=parser.parse_args()
    database=Path(args.database).resolve(strict=True)
    if not database.is_file():raise ValueError('Database must be an existing file')
    if args.action!='inspect' and (not args.writers_stopped or not args.expected_epoch):
        parser.error('Offline writes require --writers-stopped and --expected-epoch after stopping every writer')
    root=Path(__file__).resolve().parent
    sys.path.insert(0,str(root/'server'))
    import unified_database as db
    from unified_schema import validate_schema
    with sqlite3.connect(database.as_uri()+('?mode=ro' if args.action=='inspect' else '?mode=rw'),uri=True,timeout=0) as c:
        c.execute('PRAGMA foreign_keys=ON')
        if args.action=='inspect':
            c.execute('PRAGMA query_only=ON');print(json.dumps(validate_schema(c,allow_legacy=False),ensure_ascii=True));return
        c.execute('PRAGMA synchronous=FULL')
        if c.execute('PRAGMA journal_mode').fetchone()[0]!='wal':raise ValueError('Expected existing WAL database; no automatic journal-mode conversion')
        c.execute('BEGIN EXCLUSIVE')
        before=validate_schema(c,allow_legacy=False)
        if before['epoch']!=args.expected_epoch:raise ValueError('Database epoch mismatch')
        if args.action=='rollback':result=db.rollback_index_migration(c,args.expected_epoch)
        else:
            import time
            result=db.migrate(c,int(time.time()*1000))
        c.commit()  # Never print successful migration before actual commit.
        print(json.dumps({'success':True,'action':args.action,**result},ensure_ascii=True))

if __name__=='__main__':main()
