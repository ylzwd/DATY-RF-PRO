"""Original FULL writer with bounded, SQLite-coordinated WAL maintenance.

The SQLite checkpoint API may reclaim committed WAL pages only when no reader
needs them. No filesystem deletion, reader cancellation or business retention
change. A pinned snapshot returns busy and remains usable.
"""
from pathlib import Path
import sqlite3
import time
from wal_checkpoint import WalCheckpointer
from m6_process_runtime import ProcessRuntime

class Checkpointer(WalCheckpointer):
    def __init__(self,path,writer_lock):
        super().__init__(path)
        self.writer_lock=writer_lock
        self._state.update(protocol='daty-mqtt6-checkpoint-v1',reclaims=0,reclaim_busy=0)

    @staticmethod
    def query(connection,sql):
        cursor=connection.execute(sql)
        try:return cursor.fetchone()
        finally:cursor.close()

    def _run(self):
        connection=None
        try:
            connection=sqlite3.connect(self.path.as_uri()+'?mode=rw',uri=True,timeout=0,isolation_level=None)
            if self.query(connection,'PRAGMA journal_mode')[0].lower()!='wal':raise RuntimeError('WAL required')
            self.query(connection,'PRAGMA synchronous=FULL');self.query(connection,'PRAGMA busy_timeout=0')
            with self._lock:self._state['state']='running'
            self._ready.set()
            while not self._stop.wait(self.interval):
                try:
                    wal=Path(str(self.path)+'-wal');size=wal.stat().st_size if wal.exists() else 0
                    with self._lock:self._state['wal_bytes']=size
                    if size<self.threshold:continue
                    began=time.monotonic()
                    busy,log,saved=self.query(connection,'PRAGMA wal_checkpoint(PASSIVE)')
                    # Wait at most 50 ms in this maintenance thread for a writer
                    # boundary; a zero-wait try can starve under continuous load.
                    # SQLite checks every other reader and reports BUSY without
                    # cancelling or waiting for its snapshot to finish.
                    if not busy and log==saved and size>=128*1024*1024 and self.writer_lock.acquire(timeout=.05):
                        try:
                            reclaimed,_,_=self.query(connection,'PRAGMA wal_checkpoint(TRUNCATE)')
                            with self._lock:
                                self._state['reclaims']+=int(not reclaimed)
                                self._state['reclaim_busy']+=int(bool(reclaimed))
                        finally:self.writer_lock.release()
                    with self._lock:
                        self._state.update(runs=self._state['runs']+1,busy=self._state['busy']+int(bool(busy)),
                            wal_bytes=wal.stat().st_size if wal.exists() else 0,log_frames=log,checkpointed_frames=saved,
                            pending_frames=max(0,log-saved),max_duration_ms=round(max(self._state['max_duration_ms'],(time.monotonic()-began)*1000),3))
                except (sqlite3.Error,OSError):
                    with self._lock:
                        self._state['failures']+=1;self._state['last_error']='CHECKPOINT_UNCONFIRMED'
        except Exception:
            with self._lock:self._state.update(state='failed',last_error='CHECKPOINT_STARTUP_FAILED')
        finally:
            self._ready.set()
            if connection is not None:connection.close()
            with self._lock:
                if self._state['state']!='failed':self._state['state']='stopped'

def start(bridge):
    if bridge._unified_runtime is not None:raise RuntimeError('Persistence already started')
    checkpointer=Checkpointer(bridge._db_path,bridge._db_lock)
    try:
        checkpointer.start()
        with bridge._db_session() as connection:
            connection.execute('PRAGMA wal_autocheckpoint=0').close()
            # Retain the bounded cache on the shared administrative connection.
            # The isolated observation writer sets the same 32 MiB cache itself;
            # neither connection lowers FULL/WAL or changes stored samples.
            connection.execute('PRAGMA cache_size=-32768').close()
        runtime=ProcessRuntime(bridge,
            on_error=lambda event:bridge._log('DB','业务持久化未完整确认: '+event['code']))
        # The integrated stream keeps every sample; allow a 50 ms FIFO writer
        # slice (still at most 128 observations) to amortize FULL fsync. This is
        # a commit budget, not a sampling interval or an acknowledgement bypass.
        runtime._batch_budget_s=.05
        runtime.start()
    except Exception:
        checkpointer.stop();raise
    bridge._unified_runtime,bridge._wal_checkpointer=runtime,checkpointer
    return runtime
