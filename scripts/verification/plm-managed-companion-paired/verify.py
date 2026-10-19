"""Disposable native + Meta managed-login proof. Does not deploy, publish, or edit the native tree."""
import argparse, http.client, json, os, re, secrets, select, shutil, signal, socket, ssl, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if not __debug__:
    raise RuntimeError("Verification requires assertions enabled")

class PgCtlStatusUnproved(RuntimeError):
    pass

def classify_pg_ctl_status(returncode, signame=None, error=None):
    # Exit 0 is running. Exit 3 is the only proof the postmaster is stopped.
    # A signal, a timeout, a missing code, or any other exit does not prove that.
    if isinstance(returncode, int) and returncode < 0:
        signame = signame or str(-returncode)
        returncode = None
    if error or signame or returncode is None:
        detail = ''
        if signame:
            detail += ' signal ' + str(signame)
        if error:
            detail += ': ' + str(error)
        raise PgCtlStatusUnproved('pg_ctl status did not finish' + detail + '; retaining owned directory')
    if returncode == 0:
        return 'running'
    if returncode == 3:
        return 'stopped'
    raise PgCtlStatusUnproved(
        'pg_ctl status exited ' + str(returncode)
        + ' which does not prove the postmaster is stopped; retaining owned directory'
    )

def status_from_process(completed):
    if completed is None or completed.returncode is None:
        raise PgCtlStatusUnproved('pg_ctl status did not finish; retaining owned directory')
    return classify_pg_ctl_status(completed.returncode)

def path_kind(path):
    if path.is_symlink():
        return 'symlink'
    if not path.exists():
        return 'missing'
    if path.is_dir():
        return 'directory'
    return 'other'

def decide_postgres_cleanup(started, data_kind, socket_kind, status):
    if data_kind == 'symlink' or socket_kind == 'symlink':
        return False, 'refusing symlink data or socket; retaining owned directory'
    if data_kind == 'missing':
        if started:
            return False, 'missing data after start cannot prove the postmaster is stopped; retaining owned directory'
        return True, None
    if data_kind != 'directory':
        return False, 'data path is not a real directory; retaining owned directory'
    if status == 'stopped':
        return True, None
    if status == 'running':
        return False, 'postgres still running; retaining owned directory'
    return False, 'pg_ctl status did not prove the postmaster is stopped; retaining owned directory'

def prove_postgres_stopped(started, data, sock, status_reader, stop_runner):
    data_kind = path_kind(data)
    socket_kind = path_kind(sock)
    if data_kind != 'directory' or socket_kind == 'symlink':
        return decide_postgres_cleanup(started, data_kind, socket_kind, None)
    try:
        state = status_reader()
    except PgCtlStatusUnproved as exc:
        return False, str(exc)
    if state == 'stopped':
        return True, None
    if state != 'running':
        return False, 'pg_ctl status did not prove the postmaster is stopped; retaining owned directory'
    try:
        stopped_cmd = stop_runner()
    except subprocess.TimeoutExpired:
        return False, 'pg_ctl stop timed out; retaining owned directory'
    stop_failure = None
    if getattr(stopped_cmd, 'returncode', None) != 0:
        detail = (getattr(stopped_cmd, 'stderr', None) or getattr(stopped_cmd, 'stdout', None) or '')[-500:]
        stop_failure = 'pg_ctl stop: ' + detail
    try:
        state = status_reader()
    except PgCtlStatusUnproved as exc:
        text = str(exc)
        if stop_failure:
            text = stop_failure + '; ' + text
        return False, text
    if state != 'stopped':
        return False, stop_failure or 'postgres still running; retaining owned directory'
    return True, stop_failure

def may_remove_owned_directory(marker_matched, postgres_stopped, native_stopped, proxy_closed, node_stopped, started, data_kind, final_status):
    if not (marker_matched and postgres_stopped and native_stopped and proxy_closed and node_stopped):
        return False
    if data_kind == 'symlink' or data_kind == 'other':
        return False
    if data_kind == 'missing':
        return not started
    if data_kind != 'directory':
        return False
    return final_status == 'stopped'

def apply_owned_removal(owned, allowed):
    if not allowed:
        return False
    shutil.rmtree(owned)
    return not owned.exists()

def run_status_self_check():
    proof = {
        'ok': False,
        'command': 'self-check',
        'status0Running': False,
        'status3ProvesStopped': False,
        'unexpectedStatusRetained': False,
        'missingAfterStartRetained': False,
        'symlinkRetained': False,
        'timeoutRetained': False,
        'signalRetained': False,
        'directoryRemoved': False,
        'startedCluster': False,
    }
    failures = []
    owned = None
    target = None

    def fail(message):
        proof['ok'] = False
        proof['error'] = message
        proof['failures'] = failures
        if owned is not None:
            proof['owned'] = str(owned)
            proof['directoryRemoved'] = False
        Path('/tmp/plm-managed-paired-status-self-check.json').write_text(json.dumps(proof, indent=2) + '\n')
        print(json.dumps(proof))
        raise SystemExit(message)

    if classify_pg_ctl_status(0) != 'running':
        fail('pg_ctl status 0 was not classified as running')
    proof['status0Running'] = True
    if classify_pg_ctl_status(3) != 'stopped':
        fail('pg_ctl status 3 was not classified as stopped')
    proof['status3ProvesStopped'] = True
    rejected = [
        (1, None, None),
        (4, None, None),
        (-15, None, None),
        (None, 'SIGTERM', None),
        (None, None, 'ETIMEDOUT'),
        (None, None, None),
    ]
    for returncode, signame, error in rejected:
        try:
            classify_pg_ctl_status(returncode, signame=signame, error=error)
        except PgCtlStatusUnproved as exc:
            if 'retaining owned directory' not in str(exc):
                fail('pg_ctl status refusal omitted directory retention')
        else:
            fail('unexpected pg_ctl status was classified as stopped')
    decisions = [
        (True, 'missing', 'directory', None, False),
        (True, 'symlink', 'directory', None, False),
        (True, 'directory', 'symlink', 'stopped', False),
        (True, 'directory', 'directory', 'running', False),
        (False, 'missing', 'directory', None, True),
        (False, 'symlink', 'missing', None, False),
        (True, 'directory', 'directory', 'stopped', True),
    ]
    for started_flag, data_kind, socket_kind, status, expect_stopped in decisions:
        stopped, failure = decide_postgres_cleanup(started_flag, data_kind, socket_kind, status)
        if stopped != expect_stopped:
            fail('postgres cleanup decision mismatch for ' + data_kind)
        if not expect_stopped and not failure:
            fail('unproved postgres stop omitted a failure')
        if failure and 'retaining owned directory' not in failure:
            fail('unproved postgres stop omitted directory retention')
    nonce = secrets.token_hex(8)
    owned = Path(tempfile.mkdtemp(prefix='plm-managed-paired-status-' + nonce + '-', dir='/tmp'))
    target = Path(tempfile.mkdtemp(prefix='plm-managed-paired-status-target-' + nonce + '-', dir='/tmp'))
    proof['owned'] = str(owned)
    proof['nonce'] = nonce
    data = owned / 'data'
    sock = owned / 's'
    data.mkdir(mode=0o700)
    sock.mkdir(mode=0o700)
    (owned / '.plm-managed-paired-owned').write_text(json.dumps({
        'nonce': nonce,
        'kind': 'plm-managed-companion-paired-status-self-check',
    }) + '\n')

    def retain(stopped, failure, label):
        if stopped:
            fail(label + ' was treated as stopped')
        if not failure or 'retaining owned directory' not in failure:
            fail(label + ' omitted directory retention')
        if apply_owned_removal(owned, False):
            fail(label + ' removed the owned directory')
        if not owned.is_dir() or owned.is_symlink() or not data_present():
            fail(label + ' disturbed the owned directory')

    def data_present():
        return data.is_dir() and not data.is_symlink()

    class Completed:
        def __init__(self, returncode):
            self.returncode = returncode
            self.stdout = ''
            self.stderr = 'synthetic status'

    try:
        status_from_process(Completed(4))
    except PgCtlStatusUnproved as exc:
        retain(False, str(exc), 'status 4')
    else:
        fail('status 4 was classified as stopped')
    calls = {'status': 0}

    def refuse_status():
        calls['status'] += 1
        raise PgCtlStatusUnproved('pg_ctl status exited 4 which does not prove the postmaster is stopped; retaining owned directory')

    stopped, failure = prove_postgres_stopped(True, data, sock, refuse_status, lambda: fail('stop ran without a running proof'))
    retain(stopped, failure, 'status 4 cleanup')
    if calls['status'] != 1:
        fail('status 4 cleanup did not query once')

    def running_then_timeout():
        if calls.get('phase') == 'timeout':
            raise AssertionError('status read after a timed out stop')
        calls['phase'] = 'timeout'
        return 'running'

    def timeout_stop():
        raise subprocess.TimeoutExpired(cmd='pg_ctl', timeout=60)

    stopped, failure = prove_postgres_stopped(True, data, sock, running_then_timeout, timeout_stop)
    retain(stopped, failure, 'stop timeout')
    proof['timeoutRetained'] = True

    try:
        status_from_process(Completed(-15))
    except PgCtlStatusUnproved as exc:
        retain(False, str(exc), 'signal')
    else:
        fail('signal status was classified as stopped')
    proof['signalRetained'] = True

    shutil.rmtree(data)
    stopped, failure = prove_postgres_stopped(True, data, sock, lambda: fail('status ran for missing data'), lambda: fail('stop ran for missing data'))
    if stopped or not owned.is_dir():
        fail('missing data after start was treated as stopped')
    if not failure or 'missing data after start' not in failure:
        fail('missing data after start omitted the retention reason')
    if may_remove_owned_directory(True, True, True, True, True, True, 'missing', None):
        fail('missing data after start was removable')
    if may_remove_owned_directory(True, True, True, True, True, True, 'symlink', 'stopped'):
        fail('symlink data was removable')
    if may_remove_owned_directory(True, True, True, True, True, False, 'missing', None) is not True:
        fail('never-started missing data was not removable')
    if apply_owned_removal(owned, may_remove_owned_directory(True, stopped, True, True, True, True, 'missing', None)):
        fail('missing data after start removed the owned directory')
    proof['missingAfterStartRetained'] = True

    data.symlink_to(target, target_is_directory=True)
    stopped, failure = prove_postgres_stopped(True, data, sock, lambda: fail('status ran through a symlink'), lambda: fail('stop ran through a symlink'))
    if stopped or not target.is_dir() or not owned.is_dir():
        fail('symlink data was treated as a stopped server')
    if apply_owned_removal(owned, False):
        fail('symlink data removed the owned directory')
    proof['symlinkRetained'] = True
    data.unlink()
    if not target.is_dir():
        fail('symlink handling removed the target directory')
    data.mkdir(mode=0o700)

    sequence = ['running', 'stopped']

    def scripted_status():
        if not sequence:
            raise AssertionError('extra status read')
        return sequence.pop(0)

    class Stopped:
        returncode = 0
        stdout = ''
        stderr = ''

    stopped, failure = prove_postgres_stopped(True, data, sock, scripted_status, lambda: Stopped())
    if not stopped or failure:
        fail('status 3 after stop was not accepted')
    if sequence:
        fail('status 3 after stop did not consume both reads')
    allowed = may_remove_owned_directory(True, True, True, True, True, True, 'directory', 'stopped')
    refused = may_remove_owned_directory(True, True, True, True, True, True, 'directory', 'running')
    if not allowed or refused:
        fail('removal predicate did not require status 3')
    proof['unexpectedStatusRetained'] = True
    if not apply_owned_removal(owned, allowed):
        fail('proved stopped fixture could not be removed after the negative checks')
    if owned.exists() or not target.is_dir():
        fail('self-check removal disturbed the wrong directory')
    shutil.rmtree(target)
    if target.exists():
        fail('self-check target still present')
    proof['ok'] = True
    proof['directoryRemoved'] = True
    proof['owned'] = str(owned)
    Path('/tmp/plm-managed-paired-status-self-check.json').write_text(json.dumps(proof, indent=2) + '\n')
    print(json.dumps(proof))
    raise SystemExit(0)

if '--self-check' in sys.argv:
    run_status_self_check()

parser = argparse.ArgumentParser()
parser.add_argument('--meta-checkout', required=True)
parser.add_argument('--native-checkout', required=True)
parser.add_argument('--python', required=True)
parser.add_argument('--node', required=True)
parser.add_argument('--pg-bin', required=True)
parser.add_argument('--browser-cache', required=True)
parser.add_argument('--browser-module')
parser.add_argument('--package-renderer')
parser.add_argument('--output', required=True)
parser.add_argument('--browser-script', default='run.mts')
parser.add_argument('--workspace-entry', action='store_true')
parser.add_argument('--snapshot-share', action='store_true')
parser.add_argument('--snapshot-pre-review', action='store_true')
parser.add_argument('--snapshot-restore', action='store_true')
args = parser.parse_args()
if args.package_renderer and not args.snapshot_restore:
    parser.error('--package-renderer requires --snapshot-restore')
if args.snapshot_restore and not args.snapshot_share:
    parser.error('--snapshot-restore requires --snapshot-share')
if args.snapshot_pre_review and not args.snapshot_share:
    parser.error('--snapshot-pre-review requires --snapshot-share')
if args.snapshot_share and args.browser_script != 'entry-run.mts':
    parser.error('--snapshot-share requires --browser-script entry-run.mts')
if args.browser_module:
    module = Path(args.browser_module).resolve(strict=True)
    metadata = json.loads((module / 'package.json').read_text())
    assert metadata['name'] == 'playwright' and metadata['version'] == '1.57.0', 'Pinned Playwright module required'
meta = Path(args.meta_checkout).resolve()
native = Path(args.native_checkout).resolve()
pg = Path(args.pg_bin)
assert (native / 'src/yuantus/api/app.py').is_file()
assert (meta / 'packages/core-backend/src/services/plm-managed-companion-flow.ts').is_file()
tsx_candidates = [
    meta / 'node_modules/tsx/dist/cli.mjs',
    meta / 'node_modules/tsx/dist/cli.js',
]
tsx = next(path for path in tsx_candidates if path.is_file())
owned = Path(tempfile.mkdtemp(prefix='plm-managed-paired-', dir='/tmp'))
nonce = owned.name.removeprefix('plm-managed-paired-')
if not nonce or owned != Path('/tmp') / f'plm-managed-paired-{nonce}' or owned.is_symlink():
    raise SystemExit('refusing an owned path that is not the paired temp directory')
(owned / '.plm-managed-paired-owned').write_text(json.dumps({
    'nonce': nonce,
    'kind': 'plm-managed-companion-paired',
}) + '\n')
sock = owned / 's'
sock.mkdir(mode=0o700)
data = owned / 'data'
native_root = owned / 'native'
native_root.mkdir()
proof = {'owned': str(owned), 'nonce': nonce, 'ok': False}
started = False
child = None
proxy_server = None
native_sock = None
node = None
tests_ok = False
failure = None
log = None
node_log = None
secret = 'synthetic-client-secret-configured-control'
pg_env = os.environ.copy()
pg_env['LC_ALL'] = 'C'
pg_env['LANG'] = 'C'
cleanup = {
    'postgresStopped': False,
    'directoryRemoved': False,
    'markerMatched': False,
    'nativeChildStopped': False,
    'proxyClosed': False,
    'failures': [],
}

def run_pg(tool, args, timeout):
    completed = subprocess.run(
        [str(pg / tool), *args],
        check=False,
        timeout=timeout,
        env=pg_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or '')[-1500:]
        raise RuntimeError(tool + ' failed: ' + detail)
    return completed

def redact(text):
    text = re.sub(r'yur_[A-Za-z0-9._~-]+', '[read credential]', text)
    text = re.sub(r'yuw_[A-Za-z0-9._~-]+', '[write grant]', text)
    text = re.sub(r'yus_[A-Za-z0-9._~-]+', '[snapshot grant]', text)
    text = re.sub(r'code=[^&\s]+', 'code=[redacted]', text)
    return text.replace(secret, '[client secret]')

try:
    run_pg('initdb', ['-D', str(data), '-A', 'trust', '-U', 'plm_test'], 60)
    run_pg('pg_ctl', ['-D', str(data), '-l', str(owned / 'pg.log'), '-o', f"-h '' -k {sock} -p 5432", '-w', 'start'], 60)
    started = True
    run_pg('createdb', ['-h', str(sock), '-p', '5432', '-U', 'plm_test', 'plm_managed_paired'], 30)
    preview = socket.socket()
    preview.bind(('127.0.0.1', 0))
    vite_port = preview.getsockname()[1]
    preview.close()
    native_sock = socket.socket()
    native_sock.bind(('127.0.0.1', 0))
    native_sock.listen(128)
    native_sock.set_inheritable(True)
    native_port = native_sock.getsockname()[1]
    (owned / 'openssl.cnf').write_text(
        '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n'
        '[dn]\nCN=127.0.0.1\n'
        '[v3]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n'
        'basicConstraints=critical,CA:TRUE\n'
        'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n'
        'extendedKeyUsage=serverAuth\n'
    )
    subprocess.run(
        ['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
         '-keyout', str(owned / 'private.pem'), '-out', str(owned / 'cert.pem'),
         '-config', str(owned / 'openssl.cnf')],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True, timeout=30,
    )
    class NativeTlsProxy(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def log_message(self, *_args):
            return
        def do_GET(self): self._forward()
        def do_POST(self): self._forward()
        def do_PATCH(self): self._forward()
        def do_PUT(self): self._forward()
        def do_DELETE(self): self._forward()
        def do_OPTIONS(self): self._forward()
        def _forward(self):
            length = int(self.headers.get('Content-Length', '0') or '0')
            body = self.rfile.read(length) if length else None
            headers = {
                key: value for key, value in self.headers.items()
                if key.lower() not in ('connection', 'content-length', 'transfer-encoding', 'x-forwarded-proto')
            }
            # This loopback-only TLS terminator supplies the authenticated transport scheme.
            headers['X-Forwarded-Proto'] = 'https'
            upstream = http.client.HTTPConnection('127.0.0.1', native_port, timeout=30)
            try:
                upstream.request(self.command, self.path, body=body, headers=headers)
                response = upstream.getresponse()
                payload = response.read()
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in ('transfer-encoding', 'connection', 'content-length'):
                        self.send_header(key, value)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            finally:
                upstream.close()
    proxy_server = ThreadingHTTPServer(('127.0.0.1', 0), NativeTlsProxy)
    tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls_context.load_cert_chain(owned / 'cert.pem', owned / 'private.pem')
    proxy_server.socket = tls_context.wrap_socket(proxy_server.socket, server_side=True)
    threading.Thread(target=proxy_server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{vite_port}'
    native_origin = f'https://127.0.0.1:{proxy_server.server_address[1]}'
    config = {
        'root': str(native_root),
        'fd': native_sock.fileno(),
        'origin': origin,
        'callback': origin + '/api/plm/managed-login/callback',
        'issuer': native_origin + '/installation',
        'secret': secret,
        'root_part_id': 'yur_public-part' if args.workspace_entry else 'part',
        'snapshot_share': args.snapshot_share,
    }
    package_meta_env = None
    if args.package_renderer:
        import importlib.util
        import hashlib
        renderer = Path(args.package_renderer).resolve(strict=True)
        assert renderer.name == 'render_runtime_env.py'
        inputs = json.loads(renderer.with_name('package-inputs.example').read_text())
        native_head = subprocess.check_output(['git', '-C', str(native), 'rev-parse', 'HEAD'], text=True).strip()
        subprocess.run(['git', '-C', str(native), 'merge-base', '--is-ancestor', inputs['native_sha'], native_head], check=True)
        subprocess.run(['git', '-C', str(native), 'diff', '--exit-code', inputs['native_sha'], '--', 'src'], check=True, stdout=subprocess.DEVNULL)
        assert inputs['meta_sha'] == subprocess.check_output(['git', '-C', str(meta), 'rev-parse', 'HEAD'], text=True).strip()
        inputs.update(snapshot_share_enabled=True, clients=[{
            'client_id': 'managed-fixture', 'tenant_id': 'default', 'org_id': 'fixture-org',
            'origin': origin, 'callback': config['callback'], 'issuer': config['issuer'],
            'native_base_url': native_origin,
        }])
        inputs['images'] = {name: f'example.invalid/{name}@sha256:{index:064x}'
                            for index, name in enumerate(('postgres', 'redis', 'backend', 'web'), 1)}
        input_path = owned / 'package-inputs.json'
        input_path.write_text(json.dumps(inputs))
        rendered = owned / 'rendered-package'
        result = subprocess.run([args.python, str(renderer), '--inputs', str(input_path), '--out', str(rendered)],
                                capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, 'Package configuration rendering failed'
        spec = importlib.util.spec_from_file_location('paired_package_loader', renderer.with_name('check_compose_config.py'))
        loader = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(loader)
        manifest, _compose = loader._load_retained(rendered)
        hashes = manifest['file_sha256']
        config['package_native_env'] = loader._env_map(rendered / 'native.env', hashes['native_env'])
        package_meta_env = loader._env_map(rendered / 'meta.env', hashes['meta_env'])
        secret = json.loads(package_meta_env['PLM_MANAGED_COMPANION_CLIENTS_JSON'])[0]['clientSecret']
        config['secret'] = secret
        # Source fixture owns its transport/storage; consume all capability and identity values unchanged.
        excluded = ('NODE_ENV', 'HOST', 'PORT', 'STORAGE_PATH', 'DATABASE_URL',
                    'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REDIS_URL')
        package_meta_env = {key: value for key, value in package_meta_env.items() if key not in excluded}
        proof['rendered_package'] = {'ok': True, 'file_sha256': hashes,
            'renderer_sha256': hashlib.sha256(renderer.read_bytes()).hexdigest(),
            'native_source_pin': inputs['native_sha'], 'native_checkout': native_head, 'native_src_matches_pin': True,
            'meta_fixture_topology_exclusions': list(excluded),
            'native_config_keys': sorted(config['package_native_env']), 'meta_config_keys': sorted(package_meta_env),
            'images_launched': False}
    env = os.environ.copy()
    env['PYTHONPATH'] = str(native / 'src')
    env['PAIRED_MANAGED_CONFIG'] = json.dumps(config)
    env['HOME'] = str(owned)
    env['TMPDIR'] = str(owned)
    log = (owned / 'native.log').open('w')
    child = subprocess.Popen(
        [args.python, '-u', str(Path(__file__).with_name('native_server.py'))],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, env=env,
        pass_fds=(native_sock.fileno(),), cwd=owned,
    )
    if not args.snapshot_restore:
        native_sock.close()
    deadline = time.monotonic() + 60
    ready = ''
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError('native exited before ready: ' + (owned / 'native.log').read_text()[-2000:])
        readable, _, _ = select.select([child.stdout], [], [], 1)
        if readable:
            ready = child.stdout.readline()
            if ready.strip().startswith('{'):
                break
    assert json.loads(ready).get('ready') is True
    initial_native_report = None
    if args.snapshot_restore:
        child.stdin.write('report\n')
        child.stdin.flush()
        assert select.select([child.stdout], [], [], 15)[0]
        initial_native_report = json.loads(child.stdout.readline())
        assert initial_native_report['snapshot_source_unchanged'] is True
    node_env = os.environ.copy()
    node_env.pop('NODE_TLS_REJECT_UNAUTHORIZED', None)
    node_env['NODE_EXTRA_CA_CERTS'] = str(owned / 'cert.pem')
    node_env['PLAYWRIGHT_BROWSERS_PATH'] = str(Path(args.browser_cache).resolve())
    node_env['DATABASE_URL'] = f'postgresql://plm_test@localhost/plm_managed_paired?host={sock}&port=5432'
    payload = {
        'metaCheckout': str(meta),
        'pgUrl': node_env['DATABASE_URL'],
        'nativeOrigin': native_origin,
        'vitePort': vite_port,
        'origin': origin,
        'callback': config['callback'],
        'issuer': config['issuer'],
        'secret': secret,
        'nativePid': child.pid,
        'workspaceEntry': args.workspace_entry,
        'snapshotShare': args.snapshot_share,
        'snapshotPreReview': args.snapshot_pre_review,
        'snapshotRestore': args.snapshot_restore,
        'browserModule': str(module) if args.browser_module else None,
        'rootPartId': config['root_part_id'],
        'packageMetaEnv': package_meta_env,
    }
    node_log = (owned / 'node.log').open('w')
    script = Path(__file__).with_name(args.browser_script)
    if script.parent != Path(__file__).parent or not script.is_file() or script.suffix != '.mts':
        raise RuntimeError('browser script must be an owned paired runner')
    node = subprocess.Popen(
        [args.node, str(tsx), str(script)],
        stdin=subprocess.PIPE, stdout=node_log, stderr=subprocess.STDOUT, text=True, env=node_env, cwd=owned,
    )
    node.stdin.write(json.dumps(payload))
    node.stdin.close()
    try:
        result_code = node.wait(timeout=300 if args.browser_script != 'run.mts' else 240)
    except subprocess.TimeoutExpired:
        node.kill()
        try:
            node.wait(timeout=20)
        except subprocess.TimeoutExpired:
            node.send_signal(signal.SIGKILL)
            node.wait(timeout=20)
        if node_log is not None and not node_log.closed:
            node_log.close()
        timed = (owned / 'node.log').read_text()[-20000:] if (owned / 'node.log').is_file() else 'paired child timed out before node.log'
        Path(args.output + '.failure.log').write_text(redact(timed))
        raise SystemExit('paired child timed out')
    if node_log is not None and not node_log.closed:
        node_log.close()
    result_text = (owned / 'node.log').read_text()
    if result_code:
        Path(args.output + '.failure.log').write_text(redact(result_text)[-20000:])
        raise SystemExit('paired child failed')
    def one_line(prefix):
        matches = [item for item in result_text.splitlines() if item.startswith(prefix)]
        if len(matches) != 1:
            raise SystemExit('paired child missing ' + prefix.strip())
        return json.loads(matches[0][len(prefix):])
    proof['node_cleanup'] = one_line('CLEANUP_PROOF ')
    if proof['node_cleanup'].get('ok') is not True:
        Path(args.output + '.failure.log').write_text(redact(result_text)[-20000:])
        raise SystemExit('paired node cleanup incomplete')
    if args.snapshot_restore:
        proof['snapshot_cancel_pending'] = one_line('SNAPSHOT_CANCEL_PENDING_PROOF ')
        assert proof['snapshot_cancel_pending']['ok'] is True
        from snapshot_restore import restore_snapshot_pair
        proof['snapshot_restore'] = restore_snapshot_pair(
            child, config, payload, owned, native_root, native_sock, env, node_env,
            args.python, args.node, tsx, run_pg,
            lambda port: globals().__setitem__('native_port', port))
        native_report = proof['snapshot_restore'].pop('native_report')
        assert native_report['snapshot_items_hash'] == initial_native_report['snapshot_items_hash']
    else:
        child.stdin.write('report\n')
        child.stdin.flush()
        native_report = json.loads(child.stdout.readline())
    proof['native'] = native_report
    if args.snapshot_share:
        assert native_report['snapshot_source_unchanged'] is True
        proof['snapshot_share'] = one_line('SNAPSHOT_SHARE_PROOF ')
        assert proof['snapshot_share']['ok'] is True
        proof['snapshot_export'] = one_line('SNAPSHOT_EXPORT_PROOF ')
        assert proof['snapshot_export']['ok'] is True
        if args.snapshot_pre_review:
            proof['snapshot_pre_review'] = one_line('SNAPSHOT_PRE_REVIEW_PROOF ')
            assert proof['snapshot_pre_review']['ok'] is True
    if args.browser_script == 'run.mts':
        proof['meta'] = one_line('PAIRED_PROOF ')
        assert proof['meta']['ok'] is True
        assert proof['meta']['write_patch'] == 200
        assert proof['meta']['rebind_generation'] == 2
        assert proof['meta']['revoke_outage'] == 'pending-then-acked'
        assert proof['meta']['late_callback_open_sessions'] == 0
        assert native_report['write_audits'] >= 1
        assert native_report['write_subjects'] == [42]
    else:
        proof['meta'] = one_line('ENTRY_BOOTSTRAP_PROOF ')
        assert proof['meta']['ok'] is True
        assert proof['meta']['bom_line'] == 'line'
        assert proof['meta']['open_sessions'] == 1
        assert proof['meta']['dev_token_requests'] == 0
        assert proof['meta']['embed_requests'] == 0
        assert proof['meta']['ordinary_owner_start'] is True
        assert proof['meta']['meta_user'] == 'meta-owner'
        assert proof['meta']['native_subject_hint'] == '42'
        assert native_report['write_audits'] == 0
        assert native_report['write_subjects'] == []
    tests_ok = True
except SystemExit as exc:
    failure = str(exc)
except Exception as exc:
    failure = repr(exc)
finally:
    def wait_for(proc, timeout):
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return False
        return proc.poll() is not None

    def reap(proc, label, stop_stdin=False):
        if proc is None or proc.poll() is not None:
            return True
        if stop_stdin:
            try:
                if proc.stdin and not proc.stdin.closed:
                    proc.stdin.write('stop\n')
                    proc.stdin.flush()
            except Exception as exc:
                cleanup['failures'].append(label + ' stdin: ' + str(exc))
            if wait_for(proc, 20):
                return True
            cleanup['failures'].append(label + ' stop timed out')
        try:
            proc.kill()
        except Exception as exc:
            cleanup['failures'].append(label + ' kill: ' + str(exc))
        if wait_for(proc, 20):
            return True
        try:
            proc.send_signal(signal.SIGKILL)
        except Exception as exc:
            cleanup['failures'].append(label + ' sigkill: ' + str(exc))
        if wait_for(proc, 20):
            return True
        cleanup['failures'].append(label + ' missing exit')
        return False

    def marker_matches():
        if owned.is_symlink() or owned != Path('/tmp') / f'plm-managed-paired-{nonce}':
            return False
        marker_path = owned / '.plm-managed-paired-owned'
        if not marker_path.is_file() or marker_path.is_symlink():
            return False
        try:
            body = json.loads(marker_path.read_text())
        except Exception:
            return False
        return body.get('nonce') == nonce and body.get('kind') == 'plm-managed-companion-paired'

    def read_postmaster_state():
        if path_kind(data) != 'directory':
            raise PgCtlStatusUnproved('pg_ctl status was not run; retaining owned directory')
        try:
            completed = subprocess.run(
                [str(pg / 'pg_ctl'), '-D', str(data), 'status'],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=pg_env, timeout=20,
            )
        except subprocess.TimeoutExpired:
            raise PgCtlStatusUnproved('pg_ctl status timed out; retaining owned directory')
        return status_from_process(completed)

    def stop_postmaster():
        return subprocess.run(
            [str(pg / 'pg_ctl'), '-D', str(data), '-m', 'fast', '-w', 'stop'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=pg_env, timeout=60,
        )

    if log is not None and not log.closed:
        log.close()
    if node_log is not None and not node_log.closed:
        node_log.close()
    if not tests_ok:
        parts = []
        failure_log = Path(args.output + '.failure.log')
        if failure_log.is_file():
            parts.append(failure_log.read_text(errors='replace'))
        for name in ('node.log', 'native.log', 'pg.log'):
            source = owned / name
            if source.is_file() and not source.is_symlink():
                parts.append('----- ' + name + ' -----\n' + source.read_text(errors='replace')[-8000:])
        if failure and not parts:
            parts.append(failure)
        if parts:
            failure_log.write_text(redact('\n'.join(parts))[-40000:])
    if proxy_server is None:
        cleanup['proxyClosed'] = True
    else:
        try:
            proxy_server.shutdown()
            proxy_server.server_close()
            cleanup['proxyClosed'] = True
        except Exception as exc:
            cleanup['failures'].append('proxy: ' + str(exc))
            cleanup['proxyClosed'] = False
    if native_sock is not None:
        native_sock.close()
    cleanup['nativeChildStopped'] = reap(child, 'native', stop_stdin=True)
    node_stopped = reap(node, 'node', stop_stdin=False)
    if not node_stopped:
        cleanup['failures'].append('node missing exit')
    cleanup['markerMatched'] = marker_matches()
    try:
        postgres_stopped, postgres_failure = prove_postgres_stopped(
            started, data, sock, read_postmaster_state, stop_postmaster,
        )
        cleanup['postgresStopped'] = postgres_stopped
        if postgres_failure:
            cleanup['failures'].append(postgres_failure)
    except Exception as exc:
        cleanup['failures'].append('postgres: ' + str(exc))
        cleanup['postgresStopped'] = False
    cleanup['markerMatched'] = marker_matches()
    final_status = None
    if cleanup['postgresStopped'] and path_kind(data) == 'directory':
        try:
            final_status = read_postmaster_state()
        except PgCtlStatusUnproved as exc:
            cleanup['failures'].append(str(exc))
            cleanup['postgresStopped'] = False
            final_status = None
        else:
            if final_status != 'stopped':
                cleanup['postgresStopped'] = False
                cleanup['failures'].append('postgres stop was not proved by pg_ctl status 3; retaining owned directory')
                final_status = None
    elif cleanup['postgresStopped'] and started:
        cleanup['postgresStopped'] = False
        cleanup['failures'].append('missing data after start cannot prove the postmaster is stopped; retaining owned directory')
    can_remove = may_remove_owned_directory(
        cleanup['markerMatched'],
        cleanup['postgresStopped'],
        cleanup['nativeChildStopped'],
        cleanup['proxyClosed'],
        node_stopped,
        started,
        path_kind(data),
        final_status,
    )
    if can_remove:
        try:
            cleanup['directoryRemoved'] = apply_owned_removal(owned, True)
        except Exception as exc:
            cleanup['failures'].append('rmtree: ' + str(exc))
            cleanup['directoryRemoved'] = False
        if not cleanup['directoryRemoved']:
            cleanup['failures'].append('owned directory still present')
    else:
        cleanup['directoryRemoved'] = False
        cleanup['failures'].append('refusing to remove owned directory')

proof['cleanup'] = cleanup
proof['ok'] = bool(
    tests_ok
    and failure is None
    and cleanup['postgresStopped']
    and cleanup['directoryRemoved']
    and cleanup['markerMatched']
    and cleanup['nativeChildStopped']
    and cleanup['proxyClosed']
    and not cleanup['failures']
)
Path(args.output).write_text(json.dumps(proof, indent=2) + '\n')
if not proof['ok']:
    raise SystemExit(failure or 'paired cleanup incomplete')
print(json.dumps({'ok': True, 'output': args.output, 'cleanup': cleanup}))
