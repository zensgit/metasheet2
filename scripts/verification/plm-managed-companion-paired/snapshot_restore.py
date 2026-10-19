"""Quiesced source-process restore with frozen snapshot cancellation, not installed acceptance."""
import hashlib
import json
from pathlib import Path
import select
import signal
import socket
import sqlite3
import subprocess


def restore_snapshot_pair(child, config, payload, owned, native_root, listener, env, node_env,
                          python, node, tsx, run_pg, set_native_port):
    if not __debug__:
        raise RuntimeError("Verification requires assertions enabled")
    ownership = json.loads((owned / '.plm-managed-paired-owned').read_text())
    assert ownership['kind'] == 'plm-managed-companion-paired' and not owned.is_symlink()
    assert ownership['nonce'] and owned == Path('/tmp') / ('plm-managed-paired-' + ownership['nonce'])
    assert child.poll() is None
    # The owned process is deliberately paused during the transport outage.
    # Terminate it before resuming so queued timed-out requests cannot commit late.
    child.send_signal(signal.SIGTERM)
    child.send_signal(signal.SIGCONT)
    child.wait(timeout=25)
    assert child.returncode == -signal.SIGTERM, 'Owned outage termination failed'
    listener.close()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(128)
        set_native_port(listener.getsockname()[1])
        sock = owned / 's'
        pg_args = ['-h', str(sock), '-p', '5432', '-U', 'plm_test']

        def pg_fingerprints(database):
            tables = run_pg('psql', [*pg_args, '-d', database, '-At', '-c',
                "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"], 30).stdout.splitlines()
            result = {}
            for table in tables:
                quoted = '"' + table.replace('"', '""') + '"'
                sql = f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM {quoted} t"
                content = run_pg('psql', [*pg_args, '-d', database, '-At', '-c', sql], 30).stdout
                result[table] = hashlib.sha256(content.encode()).hexdigest()
            assert 'plm_snapshot_share_intents' in result and 'meta_records' in result
            return result

        def sqlite_fingerprints(directory):
            result = {}
            for name in ('global.db', 'identity.db', 'tenant_default_fixture-org.db'):
                with sqlite3.connect('file:' + str(directory / name) + '?mode=ro', uri=True) as source:
                    result[name] = hashlib.sha256('\n'.join(source.iterdump()).encode()).hexdigest()
            return result

        before_meta = pg_fingerprints('plm_managed_paired')
        dump = owned / 'snapshot-quiesced.dump'
        run_pg('pg_dump', [*pg_args, '-d', 'plm_managed_paired', '-Fc', '-f', str(dump)], 60)
        run_pg('createdb', [*pg_args, 'plm_snapshot_restored'], 30)
        run_pg('pg_restore', [*pg_args, '--exit-on-error', '-d', 'plm_snapshot_restored', str(dump)], 60)
        assert pg_fingerprints('plm_snapshot_restored') == before_meta, 'Meta restored rows differ'
        before_native = sqlite_fingerprints(native_root)
        restored = owned / 'restored-native'
        restored.mkdir(mode=0o700)
        for name in before_native:
            with sqlite3.connect('file:' + str(native_root / name) + '?mode=ro', uri=True) as source:
                with sqlite3.connect(restored / name) as target:
                    source.backup(target)
        assert sqlite_fingerprints(restored) == before_native
        native_root.rename(owned / 'retired-native')
        assert not native_root.exists()
        # Retire the original Meta database too: a stale connection cannot mask bad restore routing.
        run_pg('psql', [*pg_args, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
            'ALTER DATABASE plm_managed_paired RENAME TO plm_snapshot_retired'], 30)
        restored_config = dict(config, root=str(restored), fd=listener.fileno(), restore_existing=True,
                               sharing_enabled=False, managed_enabled=False)
        restored_env = dict(env, PAIRED_MANAGED_CONFIG=json.dumps(restored_config))
        proof = {'ok': False, 'native_stopped': False}
        with (owned / 'native-restored.log').open('w') as log:
            fresh = subprocess.Popen([python, '-u', str(Path(__file__).with_name('native_server.py'))],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True,
                env=restored_env, pass_fds=(listener.fileno(),))
            try:
                assert select.select([fresh.stdout], [], [], 45)[0], 'Restored native readiness timeout'
                assert json.loads(fresh.stdout.readline())['ready'] is True
                assert sqlite_fingerprints(restored) == before_native, 'Native restore reseeded data'
                restored_payload = dict(payload, pgUrl=payload['pgUrl'].replace('/plm_managed_paired?', '/plm_snapshot_restored?'))
                result = subprocess.run([node, str(tsx), str(Path(__file__).with_name('snapshot-restored-run.mts'))],
                    input=json.dumps(restored_payload), text=True, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, env=node_env, cwd=owned, timeout=120)
                (owned / 'restored-node.log').write_text(result.stdout)
                assert result.returncode == 0, 'Restored Meta scenario failed; see owned restored-node.log'
                lines = [line[len('SNAPSHOT_RESTORE_PROOF '):] for line in result.stdout.splitlines()
                         if line.startswith('SNAPSHOT_RESTORE_PROOF ')]
                assert len(lines) == 1
                proof.update(json.loads(lines[0]))
                assert proof['ok'] is True
                with sqlite3.connect('file:' + str(restored / 'identity.db') + '?mode=ro', uri=True) as source:
                    row = source.execute('SELECT revoked_at,authorized_at,exported_at FROM auth_bom_snapshot_shares WHERE id=?',
                                         [proof['pending_native_intent_id']]).fetchone()
                assert row and row[0] is not None and row[1:] == (None, None), 'Frozen native cancellation not committed'
                fresh.stdin.write('report\n')
                fresh.stdin.flush()
                assert select.select([fresh.stdout], [], [], 15)[0]
                native_report = json.loads(fresh.stdout.readline())
                assert native_report['snapshot_sharing_enabled'] is False
                assert native_report['snapshot_source_unchanged'] and native_report['write_audits'] == 0
                proof['native_report'] = native_report
                after_native = sqlite_fingerprints(restored)
                assert after_native['tenant_default_fixture-org.db'] == before_native['tenant_default_fixture-org.db']
                proof.update(meta_table_count=len(before_meta), all_restored_meta_rows_equal_before_start=True,
                    native_store_count=3, native_rows_equal_before_start=True,
                    original_native_path_unavailable=True, original_meta_database_unavailable=True,
                    native_business_unchanged=True, native_write_audits=0,
                    scope='Actual source-process PostgreSQL/native SQLite restore and real HTTP; not installed image/volume/host acceptance')
            finally:
                if fresh.poll() is None:
                    fresh.stdin.write('stop\n')
                    fresh.stdin.flush()
                    try:
                        fresh.wait(timeout=25)
                    except subprocess.TimeoutExpired:
                        fresh.kill()
                        fresh.wait(timeout=15)
                        proof['ok'] = False
                proof['native_stopped'] = fresh.returncode == 0
                fresh.stdin.close()
                fresh.stdout.close()
        assert proof['ok'] and proof['native_stopped']
        return proof
