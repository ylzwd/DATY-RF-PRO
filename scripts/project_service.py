"""Desktop-owned backend with graceful orphan cleanup, never a forced kill."""
from pathlib import Path
import argparse, json, os, runpy, sys, threading

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT/'scripts'), str(ROOT/'app/tools/pylib'), str(ROOT/'app/server'),
               str(ROOT/'app/server/prototypes/mqtt-stage3')]
from project_desktop import ProcessLifetime, native_processes
from command_journal import ProcessLease, CommandError
from server_archive import atomic_json


def stop_orphan(root, runtime, pid):
    """Serialize with launches; preserve another window and another backend boot."""
    try:
        lease = ProcessLease(str(runtime/'project-launch.lock'))
    except CommandError:
        return False
    try:
        if native_processes(root): return False
        try:
            status = json.loads((runtime/'runtime-status.json').read_text('utf-8'))
        except (OSError, ValueError):
            return False
        boot = status.get('boot_id')
        if status.get('pid') != pid or not isinstance(boot, str) or len(boot) != 32 or any(c not in '0123456789abcdef' for c in boot):
            return False
        atomic_json(runtime/'stop.request.json', {'boot_id': boot})
        return True
    finally:
        lease.close()


def watch_owner(owner, root, runtime, done):
    while not done.wait(.5):
        try:
            if owner.exited and stop_orphan(root, runtime, os.getpid()): return
        except OSError:
            # Transient local contention must not turn into an unowned process kill.
            continue


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--desktop-owner', type=int, required=True)
    args = parser.parse_args()
    from project_identity import instance_root
    local = instance_root(ROOT)
    if args.config.resolve() != (local/'config/runtime-config.json').resolve():
        raise ValueError('Desktop backend must use its own project configuration')
    owner = ProcessLifetime(args.desktop_owner, [ROOT/'app/tools/python'/n for n in ('python.exe','pythonw.exe')])
    done = threading.Event()
    worker = threading.Thread(target=watch_owner, args=(owner, ROOT, local/'runtime', done), daemon=True)
    try:
        if owner.exited: return
        worker.start()
        sys.argv = [str(ROOT/'app/service-launch.py'), '--config', str(args.config)]
        runpy.run_path(sys.argv[0], run_name='__main__')
    finally:
        done.set()
        if worker.ident is not None: worker.join(timeout=2)
        owner.close()


if __name__ == '__main__': main()
