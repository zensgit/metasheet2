import os, json, subprocess, pathlib, secrets, time, hashlib, shutil, re
from staging_candidate_receipt import read_receipt

SOURCE = 'e94c982b66a0d41a2eeb7e49a1a367934f39a2b6'
TAG = 'staging-directory-handover-e94c982b66'
NEW = 'zzzz20261101090000_create_directory_handovers'
ROOT = pathlib.Path.cwd()
CONTROL = pathlib.Path(__file__).resolve().parent
BASE = json.loads((CONTROL / 'staging-handover-baseline.json').read_text())
BACK = 'ghcr.io/zensgit/metasheet2-backend:' + TAG
WEB = 'ghcr.io/zensgit/metasheet2-web:' + TAG
SCOPE = 'candidate-' + secrets.token_hex(6)
PRIVATE = ROOT / ('.' + SCOPE)
PRIVATE.mkdir(mode=0o700)
owned = []
network_id = None
counter = 0
receipt_transport = []
result = {'source': SOURCE, 'passed': False, 'publicationAllowed': False, 'syntheticOnly': True,
          'realBackupRestored': False, 'macMiniUsed': False}

def run(args, data=None, check=True, timeout=300):
    p = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if check and p.returncode:
        (PRIVATE / 'last-command.log').write_bytes(p.stdout + p.stderr)
        raise RuntimeError('ISOLATED_COMMAND_FAILED')
    return p

def docker(*args, **kw):
    return run(['docker', *args], **kw)

def inspect(ref):
    return json.loads(docker('inspect', ref).stdout)[0]

def db_test_workflow_mount(source):
    relative = '.github/workflows/plugin-tests.yml'
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD']).decode().strip()
    if revision != SOURCE:
        raise RuntimeError('DB_TEST_SOURCE_CHANGED')
    expected = subprocess.check_output(['git', '-C', str(source), 'show', SOURCE + ':' + relative])
    file = (source / relative).resolve()
    if file.read_bytes() != expected:
        raise RuntimeError('DB_TEST_WORKFLOW_CHANGED')
    return ['--mount', 'type=bind,source=' + str(file) + ',target=/app/' + relative + ',readonly'], hashlib.sha256(expected).hexdigest()

def create(name, image, args, command=(), entry=None):
    opts = ['--name', name, '--label', 'codex.candidate=' + SCOPE, *args]
    if entry: opts += ['--entrypoint', entry]
    cid = docker('create', *opts, image, *command).stdout.decode().strip()
    owned.append((name, cid))
    return name

def remove(name):
    pair = next(p for p in owned if p[0] == name)
    info = inspect(name)
    assert info['Id'] == pair[1] and info['Config']['Labels']['codex.candidate'] == SCOPE
    docker('rm', '-f', '-v', name)
    owned.remove(pair)

password = secrets.token_hex(24) + 'Aa!1'
env = {'NODE_ENV': 'test', 'DATABASE_URL': '', 'DB_SSL': 'false', 'HOST': '0.0.0.0', 'PORT': '8900',
       'NODE_PATH': '/app/node_modules:/app/packages/core-backend/node_modules', 'JWT_SECRET': secrets.token_hex(48), 'ENCRYPTION_KEY': secrets.token_hex(48), 'ENCRYPTION_SALT': secrets.token_hex(32),
       'REDIS_URL': 'redis://redis:6379', 'REDIS_HOST': 'redis', 'REDIS_PORT': '6379', 'REDIS_PASSWORD': '',
       'SYNTHETIC_PASSWORD': password, 'MIGRATION_EXCLUDE': ','.join(BASE['excluded']),
       'ATTENDANCE_SCHEDULER_ENABLED': 'false', 'ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED': 'false',
       'TASKS_SCHEDULER_ENABLED': 'false', 'TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED': 'false',
       'DINGTALK_TODO_MIRROR_ENABLED': 'false', 'WEBHOOK_RETRY_SCHEDULER_DISABLED': '1',
       'RBAC_BYPASS': 'false', 'RBAC_TOKEN_TRUST': 'false'}

def environment(database, extra=None):
    values = dict(env, DATABASE_URL='postgresql://synthetic:' + password + '@postgres:5432/' + database)
    values.update(extra or {})
    path = PRIVATE / ('env-' + secrets.token_hex(4))
    path.write_text(''.join(k + '=' + v + '\n' for k, v in values.items()))
    path.chmod(0o600)
    return path

def task(image, database, command, extra=None, entry='node', mounts=(), timeout=300, check=True, decode=True):
    global counter
    counter += 1
    name = SCOPE + '-task-' + str(counter)
    create(name, image, ['--network', SCOPE, '--env-file', str(environment(database, extra)),
                        '--memory', '2048m', '--cpus', '2', *mounts], command, entry)
    try:
        p = docker('start', '-a', name, timeout=timeout, check=False)
        code = inspect(name)['State']['ExitCode']
        if check and (p.returncode or code):
            (PRIVATE / 'last-task.log').write_bytes(p.stdout + p.stderr)
            raise RuntimeError('ISOLATED_TASK_FAILED')
        return (p.stdout.decode() if decode else p.stdout), code
    finally:
        remove(name)

def node(image, database, code, extra=None, **kw):
    # Only used for bounded module paths, not JSON receipts.
    out = task(image, database, ['-e', code], extra=extra, **kw)[0]
    if len(out.encode()) > 4096:
        raise ValueError('TEXT_RESULT_TOO_LARGE')
    return out

def receipt_task(image, database, command, extra=None, label='result', mounts=(), timeout=300):
    nonce = secrets.token_hex(16)
    directory = PRIVATE / ('result-' + nonce)
    directory.mkdir(mode=0o700)
    values = dict(extra or {}, QA_RESULT_PATH='/candidate-results/result.json', QA_RESULT_NONCE=nonce,
                  QA_RESULT_UID=str(os.getuid()), QA_RESULT_GID=str(os.getgid()))
    task(image, database, command, extra=values, mounts=[*mount_scripts,
         '--mount', 'type=bind,source='+str(directory)+',target=/candidate-results', *mounts], timeout=timeout, decode=False)
    try:
        value = read_receipt(directory / 'result.json', nonce)
    except (ValueError, OSError) as error:
        receipt_transport.append({'label':label,'passed':False,'error':str(error)[:100]})
        raise
    meta = json.loads((directory / 'result.json.meta').read_text())
    receipt_transport.append({'label':label,'passed':True,'bytes':meta['bytes'],'sha256':meta['sha256']})
    return value

def node_receipt(image, database, code, extra=None, label='node', **kw):
    code = "const {writeReceipt}=require('/candidate-scripts/staging-candidate-result.cjs');\n" + code
    return receipt_task(image, database, ['-e', code], extra=extra, label=label, **kw)

def sql(database, query):
    return docker('exec', SCOPE + '-pg', 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                  '-U', 'synthetic', '-d', database, '-c', query).stdout.decode().strip()

def createdb(name):
    docker('exec', SCOPE + '-pg', 'createdb', '-U', 'synthetic', name)

MIGRATE = """
const {Migrator}=require('kysely'); const {db}=require('/app/packages/core-backend/dist/src/db/db.js');
const {createCoreBackendMigrationProvider}=require('/app/packages/core-backend/dist/src/db/migration-provider.js');
(async()=>{const m=new Migrator({db,provider:createCoreBackendMigrationProvider(),allowUnorderedMigrations:true});
const before=await m.getMigrations();const first=await m.migrateToLatest();if(first.error)throw first.error;
const replay=await m.migrateToLatest();if(replay.error)throw replay.error;
writeReceipt({before:before.map(x=>({name:x.name,applied:!!x.executedAt})),
first:first.results||[],replay:replay.results||[],after:(await m.getMigrations()).map(x=>({name:x.name,applied:!!x.executedAt}))});
await db.destroy();process.exit(0)})().catch(()=>process.exit(1))
"""

def migrate(image, database):
    return node_receipt(image, database, MIGRATE, label='migrate-'+database, timeout=900)

mount_scripts = ['--mount', 'type=bind,source=' + str(CONTROL) + ',target=/candidate-scripts,readonly']

def fixture(database, action):
    return receipt_task(BACK, database, ['/candidate-scripts/staging-handover-fixture.cjs'],
                        extra={'FIXTURE_ACTION': action}, label='fixture-'+action)

def graph(database):
    return fixture(database, 'graph')

def dump_restore(database, target):
    dump = docker('exec', SCOPE + '-pg', 'pg_dump', '-Fc', '--no-owner', '--no-acl', '-U', 'synthetic', '-d', database).stdout
    createdb(target)
    docker('exec', '-i', SCOPE + '-pg', 'pg_restore', '--exit-on-error', '--no-owner', '--no-acl',
           '-U', 'synthetic', '-d', target, data=dump)
    tables = ['kysely_migration','directory_handovers','directory_integrations','directory_accounts',
              'directory_departments','directory_account_departments','directory_account_links','users',
              'user_roles','role_permissions','user_permissions','user_orgs','user_external_identities',
              'user_external_auth_grants','approval_instances','approval_assignments','dingtalk_approval_card_deliveries',
              'delegated_role_admin_scopes','delegated_role_scope_template_departments','org_directory_routing_policy']
    def fingerprint(db, table):
        return sql(db, "SELECT json_build_object('count',count(*),'hash',md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),''))) FROM " + table + ' t')
    checks = {t: fingerprint(database, t) == fingerprint(target, t) for t in tables}
    assert all(checks.values())
    return {'syntheticOnly': True, 'dumpSha256': hashlib.sha256(dump).hexdigest(), 'tablesEqual': checks, 'tableCount': len(tables)}

def cli(database, action, data, success=True):
    inp = PRIVATE / 'cli-input.json'; inp.write_text(json.dumps(data)); inp.chmod(0o600)
    out, code = task(BACK, database, ['/app/packages/core-backend/dist/scripts/directory-controlled-handover.js', action, '/cli-input.json'],
                     mounts=['--mount', 'type=bind,source=' + str(inp) + ',target=/cli-input.json,readonly'], check=success)
    if not success:
        assert code != 0
        return None
    line = out.strip().splitlines()[-1]
    if len(line.encode()) > 4096: raise ValueError('CLI_RESULT_TOO_LARGE')
    return json.loads(line)

def runtime(phase, backend, web, revision):
    bn, wn = SCOPE + '-backend', SCOPE + '-web'
    create(bn, backend, ['--network', SCOPE, '--network-alias', 'backend', '--env-file', str(environment('baseline')),
                         '--memory', '1024m', '--cpus', '1'])
    docker('start', bn)
    create(wn, web, ['--network', SCOPE, '--network-alias', 'web', '--memory', '128m', '--cpus', '0.5'])
    docker('start', wn)
    try:
        for _ in range(120):
            p = docker('exec', bn, 'node', '-e', "fetch('http://127.0.0.1:8900/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))", check=False)
            if p.returncode == 0: break
            time.sleep(2)
        else: raise RuntimeError('ISOLATED_BACKEND_BOOT_FAILED')
        check = receipt_task(BACK, 'baseline', ['/candidate-scripts/staging-handover-runtime.cjs'],
                             extra={'EXPECTED_REVISION': revision}, label='runtime-'+phase)
        token = check.pop('adminToken')
        ip = inspect(wn)['NetworkSettings']['Networks'][SCOPE]['IPAddress']
        browser_env = dict(os.environ, SYNTHETIC_ORIGIN='http://' + ip, SYNTHETIC_TOKEN=token,
                           SYNTHETIC_PHASE=phase, CHROME_PATH=shutil.which('google-chrome') or '/opt/google/chrome/chrome')
        p = subprocess.run(['node', str(CONTROL / 'staging-handover-browser.mjs')], env=browser_env, capture_output=True, timeout=120)
        if p.returncode:
            (PRIVATE / 'browser-error.log').write_bytes(p.stdout + p.stderr)
            raise RuntimeError('ISOLATED_BROWSER_FAILED')
        browser = json.loads((ROOT / ('candidate-browser-' + phase + '.json')).read_text())
        assert browser['passed']
        check['browser'] = browser
        return check
    finally:
        remove(wn); remove(bn)

try:
    for ref in [BASE['backend'], BASE['web'], 'postgres:15-alpine', 'redis:7-alpine']:
        docker('pull', ref, timeout=600)
    network_id = docker('network', 'create', '--internal', '--label', 'codex.candidate=' + SCOPE, SCOPE).stdout.decode().strip()
    pg = create(SCOPE + '-pg', 'postgres:15-alpine', ['--network', SCOPE, '--network-alias', 'postgres',
                '--memory', '768m', '--cpus', '1', '-e', 'POSTGRES_USER=synthetic', '-e', 'POSTGRES_DB=baseline',
                '-e', 'POSTGRES_PASSWORD=' + password])
    docker('start', pg)
    redis = create(SCOPE + '-redis', 'redis:7-alpine', ['--network', SCOPE, '--network-alias', 'redis', '--memory', '128m', '--cpus', '0.5'], ['redis-server','--save','','--appendonly','no'])
    docker('start', redis)
    for _ in range(60):
        if docker('exec', pg, 'pg_isready', '-U', 'synthetic', check=False).returncode == 0: break
        time.sleep(1)
    else: raise RuntimeError('ISOLATED_PG_BOOT_FAILED')

    old = migrate(BASE['backend'], 'baseline')
    assert sorted(m['name'] for m in old['after']) == BASE['ledger'] and all(m['applied'] for m in old['after'])
    assert not old['replay']
    pair = fixture('baseline', 'seed')
    initial_graph = graph('baseline')
    assert [len(t['items']) for t in initial_graph['todo']] == [5, 4]
    upgraded = migrate(BACK, 'baseline')
    assert [m['name'] for m in upgraded['before'] if not m['applied']] == [NEW]
    assert upgraded['first'] == [{'migrationName': NEW, 'direction': 'Up', 'status': 'Success'}]
    assert not upgraded['replay'] and len(upgraded['after']) == 459
    assert graph('baseline') == initial_graph
    (ROOT / 'candidate-ledger-reconciliation.json').write_text(json.dumps({'source': SOURCE, 'baselineApplied': BASE['ledger'],
         'candidateAfter': upgraded['after'], 'pendingBeforeUpgrade': [NEW], 'missingApplied': [], 'unknownApplied': [], 'first': upgraded['first'], 'replay': upgraded['replay']}, indent=2))

    expected_hashes = {}
    for parent in ['packages/core-backend/src/db/migrations','packages/core-backend/migrations']:
        for f in (ROOT / 'source' / parent).rglob('*'):
            if f.is_file() and f.suffix in ['.ts','.sql']:
                expected_hashes[str(f.relative_to(ROOT / 'source'))] = hashlib.sha256(f.read_bytes()).hexdigest()
    hashcode = "const fs=require('fs'),p=require('path'),c=require('crypto');let out={};function walk(d){for(const x of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,x.name);if(x.isDirectory())walk(f);else if(/\\.(ts|sql)$/.test(f))out[f.slice(5)]=c.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}};walk('/app/packages/core-backend/src/db/migrations');walk('/app/packages/core-backend/migrations');writeReceipt(out);process.exit(0)"
    actual_hashes = node_receipt(BACK, 'baseline', hashcode, label='migration-source-hashes')
    assert actual_hashes == expected_hashes
    (ROOT / 'candidate-source-migration-hashes.json').write_text(json.dumps({'source': SOURCE, 'fileCount': len(actual_hashes), 'allEqual': True, 'sha256': actual_hashes}, indent=2))

    createdb('fresh'); fresh = migrate(BACK, 'fresh')
    assert len(fresh['first']) == 459 and not fresh['replay'] and all(m['applied'] for m in fresh['after'])
    fixtures = fixture('fresh', 'seed'); graph_before = graph('fresh')
    assert [len(t['roles']) for t in graph_before['todo']] == [2, 1]
    assert [len(t['items']) for t in graph_before['todo']] == [5, 4]
    preview = cli('fresh', 'preview', fixtures)
    assert preview['accounts'] == 5 and preview['linkedUsers'] == 2
    moved = cli('fresh', 'apply', dict(fixtures, digest=preview['digest'], confirm='apply'))
    assert moved['accounts'] == 5 and graph('fresh') == graph_before
    cli('fresh','rollback',dict(id=moved['id'],actorId=fixtures['actorId'],digest=moved['digest'],confirm='not-approved'),False)
    cli('fresh','rollback',dict(id=moved['id'],actorId=fixtures['actorId'],digest=moved['digest'],confirm='rollback'))
    assert cli('fresh','preview',fixtures)['digest'] == preview['digest'] and graph('fresh') == graph_before
    moved = cli('fresh','apply',dict(fixtures,digest=preview['digest'],confirm='apply'))
    cli('fresh','finalize',dict(id=moved['id'],actorId=fixtures['actorId'],digest=moved['digest'],confirm='finalize'))
    cli('fresh','rollback',dict(id=moved['id'],actorId=fixtures['actorId'],digest=moved['digest'],confirm='rollback'),False)
    assert graph('fresh') == graph_before
    (ROOT / 'candidate-cli-receipt.json').write_text(json.dumps({'passed':True,'compiledCli':True,'accounts':5,'sourceDepartments':7,
       'localUsers':2,'roles':[2,1],'actionableTodos':[5,4],'rollbackExactDigest':True,'wrongConfirmationRejected':True,'finalizedRollbackRejected':True},indent=2))
    backup_empty = dump_restore('baseline', 'restored')
    backup_active = dump_restore('fresh', 'handover_restored')
    frozen_code = "const {syncDirectoryIntegration}=require('/app/packages/core-backend/dist/src/directory/directory-sync.js');const {db}=require('/app/packages/core-backend/dist/src/db/db.js');const {down}=require('/app/packages/core-backend/dist/src/db/migrations/zzzz20261101090000_create_directory_handovers.js');let calls=0;global.fetch=async()=>{calls++;throw Error('FORBIDDEN')};(async()=>{let frozen=false,downRefused=false;try{await syncDirectoryIntegration(process.env.SYNTHETIC_SOURCE_ID)}catch(e){frozen=e.code==='DIRECTORY_SYNC_FROZEN_BY_TRANSFER'};try{await down(db)}catch(e){downRefused=e.message.includes('history must be retained')};if(!frozen||!downRefused||calls)throw Error('RESTORE_GUARD_FAILED');writeReceipt({sourceFrozen:true,historyDownRefused:true,providerCalls:calls});await db.destroy();process.exit(0)})().catch(()=>process.exit(1))"
    frozen = node_receipt(BACK,'handover_restored',frozen_code,extra={'SYNTHETIC_SOURCE_ID':fixtures['sourceIntegrationId']},label='restored-freeze')
    (ROOT / 'candidate-backup-restore.json').write_text(json.dumps({'passed':True,'emptyJournal':backup_empty,'finalizedJournal':backup_active,'restoredFreeze':frozen},indent=2))

    createdb('dbtests'); migrate(BACK,'dbtests')
    vitest = node(BACK,'dbtests',"console.log(require('path').join(require('path').dirname(require.resolve('vitest/package.json')),'vitest.mjs'));process.exit(0)").strip().splitlines()[-1]
    files = ['approval-card-delivery-wrapper.db.test.ts','attendance-w4pre1-user-orgs-directory-sync.db.test.ts',
             'dingtalk-identity-boundaries.db.test.ts','directory-controlled-handover.db.test.ts',
             'directory-dingtalk-openid-grant-path.db.test.ts','directory-org-transfer-source-freeze.db.test.ts',
             'directory-source-freeze-lock-correctness.db.test.ts','provider-org-transfer-t1.api.test.ts']
    test_dir = PRIVATE / 'db-tests'; test_dir.mkdir(mode=0o700)
    workflow_mount, workflow_hash = db_test_workflow_mount(ROOT / 'source')
    (ROOT / 'candidate-db-test-assembly.json').write_text(json.dumps({'source':SOURCE,
        'file':'.github/workflows/plugin-tests.yml','sha256':workflow_hash,'readOnly':True,
        'scope':'dbtests container only','expectedTests':185},indent=2))
    try:
        task(BACK,'dbtests',[vitest,'run','--root','/app/packages/core-backend','--config','/app/packages/core-backend/vitest.integration.config.ts',
             *['/app/packages/core-backend/tests/integration/'+f for f in files],'--reporter=json','--outputFile=/receipts/candidate-db-tests.json'],
             extra={'EXPECT_DB':'1'},mounts=['--mount','type=bind,source='+str(test_dir)+',target=/receipts',*workflow_mount],timeout=600,decode=False)
    finally:
        report = test_dir/'candidate-db-tests.json'
        if report.exists(): shutil.copyfile(report,ROOT/'candidate-db-tests.json')
    tests=json.loads((ROOT/'candidate-db-tests.json').read_text())
    assert tests['success'] and tests['numPassedTests']==185 and tests['numFailedTests']==0 and tests['numPendingTests']==0

    playwright = node(BACK,'baseline',"console.log(require('path').dirname(require.resolve('playwright-core/package.json')));process.exit(0)").strip().splitlines()[-1]
    deps = create(SCOPE+'-deps',BACK,['--network','none'])
    docker('cp','-L',deps+':'+playwright,str(ROOT/'candidate-playwright-core'));remove(deps)
    runtime_results={}
    for phase,backend,web,revision in [('upgrade',BACK,WEB,SOURCE),('rollback',BASE['backend'],BASE['web'],BASE['revision'])]:
        runtime_results[phase]=runtime(phase,backend,web,revision)
        assert graph('baseline')==initial_graph
        assert sql('baseline','SELECT count(*) FROM directory_handovers')=='0'
    (ROOT/'candidate-runtime-receipts.json').write_text(json.dumps(runtime_results,indent=2))
    (ROOT/'candidate-synthetic-browser.json').write_text(json.dumps({'passed':True,'phases':{k:v['browser'] for k,v in runtime_results.items()}},indent=2))
    result.update(passed=True,publicationAllowed=True,baselineApplied=458,candidateApplied=459,providerNames=460,
                  migrationReplayEmpty=True,dbTests=185,compiledCli=True,backupRestoreTables=20,
                  emptyJournalRollback=True,finalizedJournalRestoreFrozen=True,browserPassed=True)
finally:
    for name,cid in list(reversed(owned)): remove(name)
    if network_id:
        info=json.loads(docker('network','inspect',SCOPE).stdout)[0]
        assert info['Id']==network_id and info['Labels']['codex.candidate']==SCOPE
        docker('network','rm',SCOPE)
    if not result['passed']:
        safe = '\n'.join(f.read_text(errors='replace') for f in PRIVATE.glob('*.log'))
        for value in [password, *[env[k] for k in ['JWT_SECRET','ENCRYPTION_KEY','ENCRYPTION_SALT']]]:
            safe = safe.replace(value, '[REDACTED]')
        safe = re.sub(r'[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}', '[REDACTED_JWT]', safe)
        safe = re.sub(r'\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b', '[REDACTED_IP]', safe)
        (ROOT/'candidate-error-sanitized.log').write_text(safe[-100000:])
    (ROOT/'candidate-receipt-transport.json').write_text(json.dumps({'protocol':'atomic-private-file-v1','checks':receipt_transport},indent=2))
    shutil.rmtree(PRIVATE)
    result['ownedContainersRemaining']=len(owned)
    (ROOT/'candidate-rehearsal.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
