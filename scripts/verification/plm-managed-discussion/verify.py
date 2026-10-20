"""Owned PostgreSQL/Redis/Native HTTP proof of the managed Discussion relay.

Meta session rows are provisioned fixtures against real Native first-party
login/authorize/exchange/status/revoke. The actual global JWT middleware and
mounted router run. This is not the Meta OAuth callback, browser, complete
migration chain, service installation or production acceptance.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
import uuid

NATIVE_REF = 'ee067d96a51c041aeee7154701db14d98180949a'
META = Path(__file__).resolve().parents[3]
NATIVE_PATHS = ['src', 'requirements.lock', 'scripts/verification/plm-managed-package/discussion_native_fixture.py']


def verify(args):
    if not __debug__:
        raise RuntimeError('Optimized Python is refused')
    os.umask(0o077)
    native, pg = Path(args.native_repo).resolve(strict=True), Path(args.pg_bin).resolve(strict=True)
    redis, out = Path(args.redis_server).resolve(strict=True), Path(args.out)
    assert hashlib.sha256(redis.read_bytes()).hexdigest() == args.redis_sha256, 'Redis pin refused'
    assert subprocess.check_output([args.node, '--version'], text=True).startswith('v20.'), 'Node20 required'
    subprocess.run(['git', 'diff', '--quiet', NATIVE_REF, 'HEAD', '--', *NATIVE_PATHS], cwd=native, check=True)
    assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all', '--', *NATIVE_PATHS], cwd=native, text=True)
    assert shutil.disk_usage('/tmp').free >= 4 * 1024**3, 'Existing 4GiB floor'
    out.parent.mkdir(parents=True, exist_ok=True)
    tests, log = out.with_suffix('.tests.json'), out.with_suffix('.log')
    assert all(not p.exists() and not p.is_symlink() for p in [out, tests, log]), 'Existing evidence refused'
    root = Path(tempfile.mkdtemp(prefix='plm-mdpg-s-', dir='/tmp'))
    root.chmod(0o700)
    owner = uuid.uuid4().hex
    (root / '.owner').write_text(owner)
    for name in ['home', 'tmp', 'redis']:
        (root / name).mkdir(mode=0o700)
    env = {k: v for k, v in os.environ.items() if k in ['PATH', 'LANG', 'LC_ALL', 'TZ', 'LD_LIBRARY_PATH']}
    env.update(PATH=str(Path(args.node).parent) + ':' + env.get('PATH', ''), HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'),
               NODE_ENV='test', DB_SSL='false', REDIS_URL=str(root / 'redis.sock'), PYTHONPATH=str(native / 'src'), PYTHONUNBUFFERED='1',
               DATABASE_URL='postgresql://plm_fixture@localhost/postgres?host=' + str(root),
               PLM_MANAGED_DISCUSSION_TEST_PG_URL='postgresql://plm_fixture@localhost/postgres?host=' + str(root),
               JWT_SECRET='owned-meta-jwt-' + owner, ENCRYPTION_KEY='owned-meta-encryption-' + owner, ENCRYPTION_SALT='owned-meta-salt-' + owner)
    keys = json.loads(subprocess.check_output([args.python, '-c',
        'import json,base64;from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey;'
        'k=Ed25519PrivateKey.generate();print(json.dumps([base64.b64encode(k.private_bytes_raw()).decode(),base64.b64encode(k.public_key().public_bytes_raw()).decode()]))'], text=True))
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        proxy_port = sock.getsockname()[1]
    proxy_url = 'http://127.0.0.1:' + str(proxy_port)
    env['PLM_MANAGED_DISCUSSION_PROXY_PORT'] = str(proxy_port)
    dburl, query = 'postgresql+psycopg://plm_fixture@/', '?host=' + str(root)
    config = {'JWT_SECRET_KEY': 'owned-native-' + owner, 'DATABASE_URL': dburl + 'native_global' + query,
        'IDENTITY_DATABASE_URL': dburl + 'native_identity' + query, 'DATABASE_URL_TEMPLATE': dburl + 'native_{tenant_id}_{org_id}' + query,
        'TENANCY_MODE': 'db-per-tenant-org', 'ENVIRONMENT': 'test', 'SCHEMA_MODE': 'migrations', 'AUTH_MODE': 'required',
        'ENABLE_METASHEET': 'true', 'DISCUSSION_SESSION_ENABLED': 'true', 'DISCUSSION_READ_SESSION_ENABLED': 'true',
        'EMBED_TOKEN_SIGNING_KEY': keys[0], 'EMBED_TOKEN_KEY_ID': 'managed-pg', 'EMBED_TOKEN_AUDIENCE': 'metasheet2.embed',
        'EMBED_ALLOWED_ORIGINS': 'https://meta.example.test', 'AUDIT_ENABLED': 'false', 'A1_SINGLE_TENANT_ORG_GATE': 'false',
        'PLM_RECORD_PUSH_ENABLED': 'false', 'PLM_CHANGE_EVENTS_ENABLED': 'false', 'PLM_MANAGED_LOGIN_ENABLED': 'true',
        'PLM_BOM_READ_SESSION_ENABLED': 'true', 'PLM_BOM_READ_CLIENTS_JSON': json.dumps([{'client_id': 'discussion-client',
            'tenant_id': 'default', 'org_id': 'fixture-org', 'origin': 'https://meta.example.test'}]),
        'PLM_MANAGED_LOGIN_CLIENTS_JSON': json.dumps([{'issuer': proxy_url, 'client_id': 'discussion-client',
            'callback': 'https://meta.example.test/api/plm/managed-login/callback', 'tenant_id': 'default', 'org_id': 'fixture-org',
            'origin': 'https://meta.example.test', 'secret_sha256': hashlib.sha256(b'owned-client-secret').hexdigest()}])}
    env.update({'YUANTUS_' + k: v for k, v in config.items()})
    env.update(YUANTUS_EMBED_PUBLIC_KEY=keys[1], YUANTUS_EMBED_KEY_ID='managed-pg', PLM_EMBED_AUDIENCE='metasheet2.embed',
               PLM_DISCUSSION_TENANT_DATABASE_URL=dburl + 'native_default_fixture-org' + query,
               PLM_MANAGED_DISCUSSION_EXPIRY_PROOF=str(out.with_suffix('.expiry.json')),
               PLM_MANAGED_DISCUSSION_WORKER_PROOF=str(out.with_suffix('.workers.json')))
    source_files = [*sorted((META / 'packages/core-backend/src').rglob('*.ts')),
        META / 'packages/core-backend/tests/integration/plm-managed-discussion-pg.realdb.ts',
        META / 'packages/core-backend/vitest.plm-managed-discussion.config.ts',
        META / 'packages/core-backend/tests/integration/fixtures/plm-managed-discussion-worker.cjs', Path(__file__).resolve()]
    def hashes():
        return {str(p.relative_to(META)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files}
    before = hashes()
    def digest(values):
        return {'files': len(values), 'sha256': hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()}
    critical = ['packages/core-backend/src/services/plm-managed-discussion.ts',
        'packages/core-backend/src/routes/plm-managed-companion.ts',
        'packages/core-backend/src/services/plm-managed-bom-authority.ts',
        'packages/core-backend/src/auth/jwt-middleware.ts', 'packages/core-backend/src/auth/plm-managed-session.ts',
        'packages/core-backend/src/auth/visual-review-markup.ts',
        'packages/core-backend/tests/integration/plm-managed-discussion-pg.realdb.ts',
        'packages/core-backend/vitest.plm-managed-discussion.config.ts',
        'packages/core-backend/tests/integration/fixtures/plm-managed-discussion-worker.cjs',
        'scripts/verification/plm-managed-discussion/verify.py']
    processes = {}
    result = {'scope': __doc__, 'passed': False, 'native_api_ref': NATIVE_REF,
        'native_checkout_head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=native, text=True).strip(),
        'meta_checkout_head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=META, text=True).strip(),
        'source_before': digest(before), 'critical_source': {name: before[name] for name in critical}, 'root': str(root), 'owner': owner, 'cleanup_errors': []}
    def command(argv):
        with (root / 'commands.private.log').open('ab') as output:
            subprocess.run([str(x) for x in argv], env=env, cwd=root, stdout=output, stderr=output, check=True, timeout=90)
    def start(name, argv):
        output = (root / (name + '.private.log')).open('ab')
        processes[name] = subprocess.Popen([str(x) for x in argv], env=env, cwd=root, stdout=output, stderr=output), output
    def wait(name, predicate):
        deadline = time.monotonic() + 45
        while not predicate():
            assert processes[name][0].poll() is None, name + ' exited'
            assert time.monotonic() < deadline, name + ' startup timeout'
            time.sleep(.1)
    try:
        command([pg / 'initdb', '-D', root / 'pgdata', '-U', 'plm_fixture', '-A', 'trust', '--no-locale', '--encoding=UTF8'])
        start('pg', [pg / 'postgres', '-D', root / 'pgdata', '-k', root, '-c', 'listen_addresses='])
        wait('pg', lambda: (root / '.s.PGSQL.5432').exists())
        for name in ['native_global', 'native_identity', 'native_default_fixture-org', 'native_default_other-org', 'native_foreign_foreign-org']:
            command([pg / 'createdb', '-h', root, '-U', 'plm_fixture', name])
        start('redis', [redis, '--port', '0', '--unixsocket', root / 'redis.sock', '--unixsocketperm', '700', '--dir', root / 'redis',
            '--save', '', '--appendonly', 'yes', '--appendfsync', 'always'])
        wait('redis', lambda: (root / 'redis.sock').exists())
        command([args.python, native / NATIVE_PATHS[2], 'seed'])
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        url = 'http://127.0.0.1:' + str(port)
        env['PLM_MANAGED_DISCUSSION_NATIVE_URL'] = url
        start('native', [args.python, '-m', 'uvicorn', 'yuantus.api.app:app', '--host', '127.0.0.1', '--port', str(port)])
        def healthy():
            try:
                with urllib.request.urlopen(url + '/api/v1/health', timeout=1) as response:
                    return response.status == 200
            except OSError:
                return False
        wait('native', healthy)
        with log.open('x') as output:
            child = subprocess.Popen([args.node, str(META / 'node_modules/vitest/vitest.mjs'), 'run', '--config',
                'vitest.plm-managed-discussion.config.ts', '--reporter=json', '--outputFile=' + str(tests.resolve())],
                cwd=META / 'packages/core-backend', env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                result['test_exit'] = child.wait(timeout=180)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)
                raise RuntimeError('Owned Vitest process group exceeded its deadline; evidence retained')
        report = json.loads(tests.read_text())
        assertions = [a for suite in report['testResults'] for a in suite.get('assertionResults', [])]
        assert result['test_exit'] == 0 and report['success'] and len(assertions) == 27
        assert all(a['status'] == 'passed' for a in assertions), 'No skips/todo/failed tests permitted'
        worker_proof = json.loads(out.with_suffix('.workers.json').read_text())
        workers = worker_proof['workers']
        assert len(workers) == 2 and len({w['pid'] for w in workers}) == 2
        assert all(w['exit'] == 0 and w['stopped'] is True for w in workers)
        result['meta_workers'] = workers
        result['checks'] = 27
        after = hashes()
        result['source_after'] = digest(after)
        assert after == before
        subprocess.run(['git', 'diff', '--quiet', NATIVE_REF, 'HEAD', '--', *NATIVE_PATHS], cwd=native, check=True)
        assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all', '--', *NATIVE_PATHS], cwd=native, text=True)
        result['passed'] = True
    finally:
        for name, (proc, output) in reversed(list(processes.items())):
            try:
                if proc.poll() is None:
                    proc.terminate()
                code = proc.wait(timeout=20)
                if name == 'native' and code == -15:
                    text = (root / (name + '.private.log')).read_text()
                    assert 'Application shutdown complete.' in text and 'Finished server process [' + str(proc.pid) + ']' in text
                else:
                    assert code == 0, (name, code)
            except Exception as error:
                result['cleanup_errors'].append(name + ': ' + str(error))
            finally:
                output.close()
        assert (root / '.owner').read_text() == owner and not root.is_symlink()
        if result['passed'] and not result['cleanup_errors']:
            shutil.rmtree(root)
        result['directory_removed'] = not root.exists()
        out.write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ['native-repo', 'python', 'node', 'pg-bin', 'redis-server', 'redis-sha256', 'out']:
        parser.add_argument('--' + key, required=True)
    result = verify(parser.parse_args())
    print(json.dumps({key: result.get(key) for key in ['passed', 'checks', 'directory_removed', 'cleanup_errors']}))
    raise SystemExit(0 if result['passed'] and result['directory_removed'] and not result['cleanup_errors'] else 1)
