import os,json,subprocess,tempfile,shutil,time,select,re,hashlib,argparse,secrets
from pathlib import Path
parser=argparse.ArgumentParser(description='Disposable Meta HTTP to native PLM personal-BOM verification; no production endpoints')
for name in ('meta-checkout','native-checkout','python','node','tsx','pg-bin','output'):
 parser.add_argument('--'+name,required=True)
parser.add_argument('--browser',action='store_true',help='Real Chromium/components to owned HTTP; separate fresh runtime')
parser.add_argument('--browser-cache',help='Existing Playwright browser cache; read only, never installs')
parser.add_argument('--customer-entry',action='store_true',help='Use the actual authenticated customer BOM route/component in the browser lane; not whole main.ts bootstrap')
args=parser.parse_args()
if args.customer_entry:assert args.browser,'--customer-entry requires --browser'
if args.browser:assert args.browser_cache and Path(args.browser_cache).is_dir(),'--browser requires existing --browser-cache'
meta_checkout=Path(args.meta_checkout).resolve();native_checkout=Path(args.native_checkout).resolve()
pg=Path(args.pg_bin).resolve();python=str(Path(args.python).absolute());node=str(Path(args.node).absolute());tsx=str(Path(args.tsx).absolute())
scripts=Path(__file__).resolve().parent
assert (meta_checkout/'packages/core-backend/src/services/PlmPersonalBomWriteBindingService.ts').is_file()
if args.customer_entry:assert (meta_checkout/'apps/web/src/views/PlmBomReviewWorkspaceView.vue').is_file()
assert (native_checkout/'src/yuantus/meta_engine/models/meta_bom_eco_intent_audit.py').is_file()
assert all(Path(path).is_file() for path in (python,node,tsx,pg/'initdb',pg/'pg_ctl'))
heads={name:subprocess.check_output(['git','rev-parse','HEAD'],cwd=path,text=True).strip() for name,path in [('meta',meta_checkout),('native',native_checkout)]}

owned=Path(tempfile.mkdtemp(prefix='plm-bom-paired-',dir='/tmp'));(owned/'.owner').write_text('paired-owned-only\n');sock=owned/'s';sock.mkdir(mode=0o700);data=owned/'data'
proof={'source_heads':heads};started=False;native=None;native_log=None;ready={}
(owned/'home').mkdir(mode=0o700);(owned/'tmp').mkdir(mode=0o700)
clean_env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'HOME':str(owned/'home'),'TMPDIR':str(owned/'tmp'),'LANG':'en_US.UTF-8','TZ':'UTC'}
def read_message(timeout=30):
 deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  if native.poll() is not None:raise RuntimeError('native child exited before message')
  readable,_,_=select.select([native.stdout],[],[],max(0,deadline-time.monotonic()))
  if readable:
   line=native.stdout.readline()
   try:return json.loads(line)
   except json.JSONDecodeError:continue
 raise TimeoutError('native message timeout')
source_files={
 'meta': ['packages/core-backend/src/services/PlmPersonalBomWriteBindingService.ts','packages/core-backend/src/services/plm-personal-bom-write-http.ts','packages/core-backend/src/services/plm-personal-bom-write-wire.ts','packages/core-backend/src/routes/plm-personal-bom-write-bindings.ts','packages/core-backend/src/routes/plm-workbench.ts','packages/core-backend/src/auth/AuthService.ts','packages/core-backend/src/auth/jwt-middleware.ts','packages/core-backend/src/auth/verified-tenant-claim.ts','packages/core-backend/src/data-adapters/PLMAdapter.ts'],
 'native': ['src/yuantus/meta_engine/web/bom_router.py','src/yuantus/meta_engine/models/meta_bom_eco_intent_audit.py','src/yuantus/meta_engine/web/bom_multitable_router.py','src/yuantus/api/dependencies/plm_bom_write.py','src/yuantus/meta_engine/models/meta_bom_writeback_audit.py','src/yuantus/meta_engine/services/bom_multitable_writeback_service.py','src/yuantus/security/auth/plm_approval_grant_service.py'],
}
if args.browser:
 source_files['meta'] += ['apps/web/src/components/plm/PlmBomReviewPanel.vue','apps/web/src/components/plm/PlmBomWriteBindingsPanel.vue','apps/web/src/services/plm/plmBomWriteBindings.ts','apps/web/src/services/plm/plmBomWritePending.ts','apps/web/src/services/integration/workbench.ts']
if args.customer_entry:
 source_files['meta'] += ['apps/web/src/views/PlmBomReviewWorkspaceView.vue','apps/web/src/router/appRoutes.ts','apps/web/src/router/guardPolicy.ts','apps/web/src/router/routeAccess.ts','apps/web/src/composables/authPrincipal.ts']
def fingerprints():
 return {name:{f:hashlib.sha256((checkout/f).read_bytes()).hexdigest() for f in files} for name,checkout,files in [('meta',meta_checkout,source_files['meta']),('native',native_checkout,source_files['native'])]}
source_before=fingerprints()
proof['source_sha256']=source_before
proof['harness_sha256']={name:hashlib.sha256((scripts/name).read_bytes()).hexdigest() for name in ('verify.py','native_server.py','meta_server.mts','browser_check.mts')}
try:
 with (owned/'init.log').open('w') as out:subprocess.run([str(pg/'initdb'),'-D',str(data),'-A','trust','-U','plm_test'],stdout=out,stderr=subprocess.STDOUT,check=True,timeout=60)
 subprocess.run([str(pg/'pg_ctl'),'-D',str(data),'-l',str(owned/'pg.log'),'-o',f"-h '' -k {sock} -p 5432",'-w','start'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True,timeout=60);started=True
 (owned/'openssl.cnf').write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=127.0.0.1\n[v3]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n')
 subprocess.run(['/usr/bin/openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(owned/'private.pem'),'-out',str(owned/'cert.pem'),'-config',str(owned/'openssl.cnf')],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True,timeout=30)
 (owned/'private.pem').chmod(0o600)
 env=dict(clean_env);env['PYTHONPATH']=str(native_checkout/'src');env['PAIRED_OWNED_ROOT']=str(owned);env['YUANTUS_JWT_SECRET_KEY']=secrets.token_urlsafe(48)
 env['PAIRED_TEST_CERT']=str(owned/'cert.pem');env['PAIRED_TEST_KEY']=str(owned/'private.pem')
 if args.browser:env['PAIRED_BROWSER_MODE']='1'
 native_log=(owned/'native.log').open('w+')
 native=subprocess.Popen([python,'-u',str(scripts/'native_server.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=native_log,text=True,env=env,cwd=owned)
 ready=read_message()
 assert 'origin' in ready and 'jwt' in ready,'native fixture ready protocol'
 begin=time.monotonic()
 node_input={'metaCheckout':str(meta_checkout),'origin':ready['origin'],'nativeJwt':ready['jwt'],'pgUrl':f'postgresql://plm_test@localhost/postgres?host={sock}&port=5432','customerEntry':args.customer_entry}
 runtime_env={**clean_env,'NODE_EXTRA_CA_CERTS':str(owned/'cert.pem')}
 runtime_env.pop('NODE_TLS_REJECT_UNAUTHORIZED',None)
 if args.browser:runtime_env['PLAYWRIGHT_BROWSERS_PATH']=str(Path(args.browser_cache).resolve())
 negative_env=dict(runtime_env);negative_env.pop('NODE_EXTRA_CA_CERTS',None)
 tls_control=subprocess.run([node,'-e',"fetch(process.argv[1]).then(()=>process.exit(2),()=>process.exit(0))",ready['origin']],env=negative_env,capture_output=True,text=True,timeout=15)
 assert tls_control.returncode==0,'untrusted test certificate must be rejected'
 proof['untrusted_certificate_rejected']=True
 proof['meta_phases']=[]
 for phase in (('browser',) if args.browser else ('line-unknown','eco-unknown','complete')):
  node_input['phase']=phase
  result=subprocess.run([node,tsx,str(scripts/'meta_server.mts')],input=json.dumps(node_input),capture_output=True,text=True,env=runtime_env,cwd=owned,timeout=180)
  if result.returncode:
   text=(result.stdout+result.stderr).replace(ready['jwt'],'[native JWT redacted]')
   text=re.sub(r'yu[aw]_[0-9a-f]{32}_[A-Za-z0-9_-]{43}','[personal grant redacted]',text)
   Path(str(args.output)+'.failure.log').write_text(text)
   raise RuntimeError('Meta child failed at '+phase+'; sanitized log saved beside output')
  lines=[line for line in result.stdout.splitlines() if line.startswith('PAIRED_PROOF ')]
  assert len(lines)==1,'Meta proof missing'
  phase_proof=json.loads(lines[0][len('PAIRED_PROOF '):]);assert phase_proof['phase']==phase
  phase_proof['child_exit']=result.returncode
  native.stdin.write('{"command":"report"}\n');native.stdin.flush();phase_proof['native_after_exit']=read_message()
  proof['meta_phases'].append(phase_proof)
 if args.browser:
  assert proof['meta_phases'][0]['browser']['actual_chromium']
 else:
  first,second,last=proof['meta_phases']
  assert len({p['meta_pid'] for p in proof['meta_phases']})==3,'Meta processes must really restart'
  assert first['lost_line_status']==503 and first['native_after_exit']['quantity']==8 and first['native_after_exit']['ecos']==0
  assert second['line_retry_denied']==401 and second['line_recovered']==200 and second['lost_eco_status']==503
  assert second['native_after_exit']['ecos']==1 and second['native_after_exit']['eco_receipts']==1
  assert last['eco_retry_denied']==401 and last['eco_recovered']==200
  keys=[{row['kind']:row['key_sha256'] for row in p['intents']} for p in proof['meta_phases']]
  assert keys[0]['line']==keys[1]['line']==keys[2]['line']
  assert keys[1]['eco-intent']==keys[2]['eco-intent']
  proof['same_provider_keys_across_process_restarts']=True
 proof['seconds']=round(time.monotonic()-begin,2)
 native.stdin.write('{"command":"report"}\n');native.stdin.flush();proof['native']=read_message()
 assert proof['native']['quantity']==(10 if args.browser else 8) and proof['native']['ecos']==1 and proof['native']['eco_receipts']==1 and proof['native']['domain_audits']==1,proof['native']
 line_audits=proof['native']['line_audits']
 assert len(line_audits)==(2 if args.browser else 1)
 assert all((a['auth_user_id'],a['tenant_id'],a['org_id'],a['part_id'],a['bom_line_id'],a['status'])==(42,'default','fixture-org','part','line','applied') for a in line_audits)
 assert [a['after']['quantity'] for a in line_audits]==([8,10] if args.browser else [8])
 assert line_audits[0]['before']['quantity']==1
 if args.browser:assert line_audits[1]['before']['quantity']==8
 # Native namespaces the raw provider key by verified purpose/connection/person/scope.
 assert len({a['key_sha256'] for a in line_audits})==len(line_audits)
 assert proof['native']['exact_audit_authority'] and proof['native']['no_tenant_authority_copies'] and proof['native']['dependency_overrides']==0
 assert proof['native']['grants']==(1 if args.browser else 3) and proof['native']['revoked_grants']==(1 if args.browser else 3) and proof['native']['exact_grant_authority']
 assert proof['native']['dropped_response_count']==2
 assert all(row['credential']=='bom_write' for row in proof['native']['traffic'] if row['mutation'])
 for path in {row['path'] for row in proof['native']['traffic'] if row['mutation']}:
  expected=2 if args.browser and not path.endswith('/eco-intent') else 1
  assert len({row['key_sha256'] for row in proof['native']['traffic'] if row['mutation'] and row['path']==path})==expected
 proof['native_mutations_use_only_personal_write_grants']=True
 proof['schema_limits']='Native official tenant provisioning metadata builder, not full native Alembic acceptance. Meta personal migrations actual, ancillary tables minimal fixture. HTTP application assembled from actual routes/global JWT middleware and actual DataSourceManager; no full index lifecycle acceptance.'
except Exception as error:
 proof['failure']=str(error)
 if native_log:
  native_log.flush();native_log.seek(0);text=native_log.read()
  if ready.get('jwt'):text=text.replace(ready['jwt'],'[native JWT redacted]')
  text=re.sub(r'yu[aw]_[0-9a-f]{32}_[A-Za-z0-9_-]{43}','[personal grant redacted]',text)
  proof['native_error_tail']=text[-1800:]
 if native is not None and native.poll() is None:
  try:
   native.stdin.write('{"command":"report"}\n');native.stdin.flush();proof['native_at_failure']=read_message(15)
  except Exception as report_error:proof['native_report_failure']=type(report_error).__name__
 raise
finally:
 if native is not None:
  if native.poll() is None:
   try:
    native.stdin.write('{"command":"stop"}\n');native.stdin.flush();proof['native_cleanup_message']=read_message(15)
   except Exception:pass
   try:native.wait(timeout=15)
   except subprocess.TimeoutExpired:native.terminate();native.wait(timeout=10)
  proof['native_child_exit']=native.returncode
  native.stdin.close();native.stdout.close()
 if native_log:native_log.close()
 if started or (data/'postmaster.pid').exists():
  stop=subprocess.run([str(pg/'pg_ctl'),'-D',str(data),'-m','fast','-w','stop'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=60);stopped=stop.returncode==0 and not (data/'postmaster.pid').exists()
 else:stopped=True
 if stopped and (owned/'.owner').read_text()=='paired-owned-only\n':shutil.rmtree(owned)
 proof.update(postgres_stopped=stopped,owned_runtime_removed=not owned.exists(),source_stable=source_before==fingerprints())
 Path(args.output).write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof))
 if 'failure' not in proof:
  assert proof.get('native_child_exit')==0,'native child shutdown failed'
  assert proof.get('native_cleanup_message',{}).get('native_cleanup') is True,'native store cleanup unconfirmed'
  assert stopped and not owned.exists(),'owned runtime cleanup failed'
  assert proof['source_stable'],'executed source changed during verification'
