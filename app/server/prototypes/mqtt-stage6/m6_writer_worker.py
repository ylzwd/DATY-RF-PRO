"""Internal M6 writer entry point. Original domain functions and schema only."""
import json
from pathlib import Path
import sys
import time

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[2])]
from m6_writer_process import read_frame, write_frame, safe_error
import unified_bootstrap
import unified_live
import unified_database


def commit_batch(connection, boot_id, items, budget):
    if (type(items) is not list or not 1 <= len(items) <= 128
            or type(budget) not in (int, float) or not 0 < budget <= .05):
        raise ValueError('Invalid writer batch')
    started, cpu = time.monotonic(), time.thread_time()
    successes = []
    connection.execute('BEGIN IMMEDIATE')
    for item in items:
        sequence, kind, observed, encoded, size = item
        connection.execute('SAVEPOINT observation')
        try:
            payload = json.loads(encoded)
            if kind == 'snapshot':
                unified_live.record_snapshot(connection, boot_id, payload['devices'], observed, full=payload['full'])
            elif kind == 'device_history':
                unified_live.record_device_history(connection, payload['record'])
            elif kind == 'command':
                unified_live.record_command(connection, payload['record'], observed)
            else:
                raise ValueError('Invalid observation kind')
        except Exception:
            connection.execute('ROLLBACK TO observation')
            successes.append(False)
        else:
            successes.append(True)
        connection.execute('RELEASE observation')
        if time.monotonic() - started >= budget:
            break
    commit_started, commit_cpu = time.monotonic(), time.thread_time()
    connection.commit()  # FULL commit precedes the only positive reply.
    return {'committed': True, 'successes': successes,
            'work_ms': (commit_started - started) * 1000,
            'work_cpu_ms': (commit_cpu - cpu) * 1000,
            'commit_ms': (time.monotonic() - commit_started) * 1000,
            'commit_cpu_ms': (time.thread_time() - commit_cpu) * 1000}


def serve(database, boot_id, incoming, outgoing):
    # The owning runtime already validated/initialized this exact database.
    # An internal worker must never bootstrap a missing replacement file.
    if not Path(database).is_file():
        raise ValueError('Existing database required')
    connection = unified_bootstrap.open_database(database)
    try:
        if connection.execute('PRAGMA journal_mode').fetchone()[0].lower() != 'wal':
            raise ValueError('WAL required')
        connection.execute('PRAGMA synchronous=FULL')
        connection.execute('PRAGMA wal_autocheckpoint=0')
        connection.execute('PRAGMA cache_size=-32768')
        booted, sequence = False, 0
        while True:
            try:
                request = read_frame(incoming)
            except EOFError:
                return
            try:
                if type(request) is not dict or request.get('sequence') != sequence + 1:
                    raise ValueError('Writer request order changed')
                sequence += 1
                if request.get('operation') == 'boot' and not booted:
                    unified_live.record_snapshot(connection, boot_id, [], request['observed'], full=False)
                    connection.commit()
                    booted = True
                    result = {'committed': True, 'boot_id': boot_id,
                              'epoch': unified_database.status(connection)['epoch'],
                              'synchronous': connection.execute('PRAGMA synchronous').fetchone()[0]}
                elif request.get('operation') == 'resume' and not booted:
                    # Restore only the same already-active boot, never start a new one.
                    connection.execute('BEGIN IMMEDIATE')
                    if unified_database.status(connection)['epoch'] != request.get('epoch'):
                        raise ValueError('Recovery database epoch mismatch')
                    current = connection.execute('SELECT boot_id FROM live_boots WHERE ended_at_ms IS NULL').fetchall()
                    if len(current) != 1 or current[0][0] != boot_id:
                        raise ValueError('Recovery boot mismatch')
                    connection.execute('UPDATE live_boots SET ended_at_ms=NULL WHERE boot_id=?', (boot_id,))
                    connection.commit()
                    booted = True
                    result = {'committed': True, 'boot_id': boot_id, 'epoch': request['epoch'],
                              'synchronous': connection.execute('PRAGMA synchronous').fetchone()[0]}
                elif request.get('operation') == 'batch' and booted:
                    result = commit_batch(connection, boot_id, request['items'], request['budget'])
                else:
                    raise ValueError('Invalid writer phase')
                write_frame(outgoing, {'sequence': sequence, **result})
            except BaseException as error:
                connection.rollback()
                # Never include exception text, raw SQL or observations.
                write_frame(outgoing, {'sequence': sequence, 'committed': False, 'error': safe_error(error)})
                return
    finally:
        connection.close()


if __name__ == '__main__':
    try:
        serve(sys.argv[1], sys.argv[2], sys.stdin.buffer, sys.stdout.buffer)
    except BaseException as error:
        print(json.dumps(safe_error(error)), file=sys.stderr, flush=True)
        sys.exit(1)
