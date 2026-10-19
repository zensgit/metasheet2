"""Verify the paired fixture reopens only explicitly owned restored native stores.

A prerequisite for the dual-system scenario, not installed product acceptance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import urllib.request


def verify(native, python, output):
    if not __debug__:
        raise RuntimeError("Verification requires assertions enabled")
    native = Path(native).resolve(strict=True)
    output = Path(output)
    assert not output.exists() and not output.is_symlink(), 'new report required'
    root = Path(tempfile.mkdtemp(prefix='plm-managed-paired-', dir='/tmp'))
    nonce = root.name.removeprefix('plm-managed-paired-')
    marker = root / '.plm-managed-paired-owned'
    marker.write_text(json.dumps({'nonce': nonce, 'kind': 'plm-managed-companion-paired'}))
    (root / 'home').mkdir()
    stores = ('global.db', 'identity.db', 'tenant_default_fixture-org.db')
    processes = []
    logs = []
    proof = {'passed': False, 'cleanup': False, 'scope': __doc__}
    env = {k: v for k, v in os.environ.items() if k in ('PATH', 'LANG', 'LC_ALL', 'TZ')}
    env.update(PYTHONPATH=str(native / 'src'), HOME=str(root / 'home'), TMPDIR=str(root))

    def start(directory, restored, sharing, label):
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(128)
        config = {'root': str(directory), 'fd': listener.fileno(), 'restore_existing': restored,
                  'snapshot_share': True, 'sharing_enabled': sharing,
                  'origin': 'https://meta.example.invalid',
                  'callback': 'https://meta.example.invalid/api/plm/managed-login/callback',
                  'issuer': 'https://native.example.invalid/installation', 'secret': 'synthetic-restore-secret'}
        log = (root / (label + '.log')).open('w')
        logs.append(log)
        child = subprocess.Popen([python, '-u', str(Path(__file__).with_name('native_server.py'))],
            env=dict(env, PAIRED_MANAGED_CONFIG=json.dumps(config)), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=log, text=True, pass_fds=(listener.fileno(),))
        processes.append(child)
        port = listener.getsockname()[1]
        listener.close()
        assert select.select([child.stdout], [], [], 45)[0], 'native readiness timeout'
        return child, child.stdout.readline(), port

    def stop(child):
        if child.poll() is None:
            child.stdin.write('stop\n')
            child.stdin.flush()
            child.wait(timeout=25)
        assert child.returncode == 0, 'native graceful stop failed'

    def report(child):
        child.stdin.write('report\n')
        child.stdin.flush()
        assert select.select([child.stdout], [], [], 15)[0]
        return json.loads(child.stdout.readline())

    def fingerprints(directory):
        result = {}
        for name in stores:
            with sqlite3.connect('file:' + str(directory / name) + '?mode=ro', uri=True) as db:
                payload = '\n'.join(db.iterdump()).encode()
            result[name] = hashlib.sha256(payload).hexdigest()
        return result

    try:
        original = root / 'native'
        original.mkdir()
        child, ready, _ = start(original, False, True, 'original')
        assert json.loads(ready)['ready'] is True
        assert report(child)['snapshot_sharing_enabled'] is True
        stop(child)
        before = fingerprints(original)
        restored = root / 'restored-native'
        restored.mkdir()
        for name in stores:
            with sqlite3.connect('file:' + str(original / name) + '?mode=ro', uri=True) as source:
                with sqlite3.connect(restored / name) as target:
                    source.backup(target)
        assert fingerprints(restored) == before
        original.rename(root / 'retired-native')
        assert not original.exists()
        child, ready, port = start(restored, True, False, 'restored')
        assert json.loads(ready)['ready'] is True
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/v1/health', timeout=5) as response:
            assert response.status == 200
        observed = report(child)
        assert observed['snapshot_sharing_enabled'] is False
        assert observed['snapshot_source_unchanged'] and observed['write_audits'] == 0
        stop(child)
        assert fingerprints(restored) == before
        saved = restored / 'identity.saved'
        (restored / 'identity.db').rename(saved)
        for label, linked in [('missing', False), ('linked', True)]:
            if linked:
                (restored / 'identity.db').symlink_to(saved)
            rejected, ready, _ = start(restored, True, False, label)
            assert ready == '', 'unsafe restored store started'
            rejected.wait(timeout=10)
            assert rejected.returncode != 0
            assert 'missing or linked restored database' in (root / (label + '.log')).read_text()
            if linked:
                (restored / 'identity.db').unlink()
        saved.rename(restored / 'identity.db')
        assert fingerprints(restored) == before
        proof.update(passed=True, restored_store_count=3, fresh_native_process=True,
            original_root_unavailable=True, sharing_disabled_in_actual_settings=True,
            database_logical_hashes=before, no_fixture_reseeding=True,
            missing_and_linked_database_refused=True)
    finally:
        for child in reversed(processes):
            if child.poll() is None:
                child.kill()
                child.wait(timeout=15)
                proof['passed'] = False
        for child in processes:
            child.stdin.close()
            child.stdout.close()
        for log in logs:
            log.close()
        assert json.loads(marker.read_text())['nonce'] == nonce and not root.is_symlink()
        if proof['passed']:
            shutil.rmtree(root)
            proof['cleanup'] = not root.exists()
        else:
            proof['retained_owned_root'] = str(root)
        with output.open('x') as out:
            os.chmod(output, 0o600)
            json.dump(proof, out, indent=2)
            out.write('\n')
    return proof


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('native-checkout', 'python', 'output'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    result = verify(args.native_checkout, args.python, args.output)
    print(json.dumps({'passed': result['passed'], 'cleanup': result['cleanup']}))
    raise SystemExit(0 if result['passed'] and result['cleanup'] else 1)
