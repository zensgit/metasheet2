from pathlib import Path
import subprocess,os,json,uuid,time,tempfile,hashlib,sys,shutil
root=Path.cwd();script_dir=Path(__file__).resolve().parent;out=root/'artifacts/plm-listener-review-20261015'/sys.argv[1];out.mkdir(parents=True);work=Path(tempfile.mkdtemp(prefix='w20-app-'))
label='w20-app-'+uuid.uuid4().hex[:12];password=uuid.uuid4().hex;resources=[];steps=[];status=1;started=time.monotonic()
node=os.environ.get('NODE_BINARY') or shutil.which('node') or 'node';loader=root/'node_modules/tsx/dist/loader.mjs'
paths=sorted((root/'packages/core-backend/src').rglob('*.ts'))
def hashes():return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
before=hashes();(out/'source-before.json').write_text(json.dumps(before,indent=2))
def run(args,name,env=None,timeout=180):
 try:
  r=subprocess.run([str(x) for x in args],cwd=work,env=env,capture_output=True,text=True,timeout=timeout)
 except subprocess.TimeoutExpired as error:
  captured=(error.stdout or b'')+(error.stderr or b'')
  if isinstance(captured,bytes):captured=captured.decode('utf8',errors='replace')
  (out/name).write_text(captured.replace(password,'[fixture-secret-redacted]'))
  steps.append({'name':name,'exit':'timeout','timeoutSeconds':timeout})
  raise
 (out/name).write_text((r.stdout+r.stderr).replace(password,'[fixture-secret-redacted]'))
 steps.append({'name':name,'exit':r.returncode});r.check_returncode();return r.stdout.strip()
env={k:os.environ[k] for k in ['PATH','HOME','TMPDIR'] if k in os.environ}
try:
 for image,alias,port in [('postgres:16','pg',5432),('redis:7-alpine','redis',6379)]:
  name=label+'-'+alias;resources.append(name)
  image_id=run(['docker','image','inspect','--format','{{.Id}}',image],alias+'-image.log')
  args=['docker','run','--detach','--pull=never','--name',name,'--label','io.yuantus.rehearsal='+label,'--publish',f'127.0.0.1::{port}','--memory','512m','--cpus','1']
  process_env=os.environ.copy()
  if alias=='pg':
   args+=['--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,size=512m','--env','POSTGRES_USER=w20','--env','POSTGRES_DB=w20','--env','POSTGRES_PASSWORD'];process_env['POSTGRES_PASSWORD']=password
  else: args+=['--tmpfs','/data:rw,nosuid,nodev,size=32m']
  run(args+[image_id],alias+'-start.log',process_env,60)
  host_port=int(run(['docker','inspect','--format',f'{{{{(index (index .NetworkSettings.Ports "{port}/tcp") 0).HostPort}}}}',name],alias+'-port.log'))
  if alias=='pg':
   ready=False
   for _ in range(40):
    if subprocess.run(['docker','exec',name,'pg_isready','-U','w20','-d','w20'],capture_output=True).returncode==0:ready=True;break
    time.sleep(.5)
   assert ready
   env['DATABASE_URL']=f'postgresql://w20:{password}@127.0.0.1:{host_port}/w20'
  else:env.update(REDIS_URL=f'redis://127.0.0.1:{host_port}',REDIS_HOST='127.0.0.1',REDIS_PORT=str(host_port))
 env.update(IDEMPOTENCY_STORE='redis',NODE_ENV='test',DB_SSL='false',JWT_SECRET='w20-full-app-synthetic-not-production',PRODUCT_MODE='plm-workbench',ENABLE_PLM='true',
  PLM_BOM_REVIEW_ENABLED='true',MULTITABLE_ENABLE_WRITER_FENCE='true',AUTOMATION_DURABLE_DELIVERY_ENABLED='true',
  W20_META_ROOT=str(root),W20_APP_RESULT=str(out/'app-result.json'))
 run([node,'--import',loader,root/'packages/core-backend/src/db/migrate.ts','--latest'],'migration.log',env)
 run([node,'--import',loader,root/'packages/core-backend/src/db/migrate.ts','--list'],'migration-list.log',env)
 run([node,'--import',loader,script_dir/'app.mts'],'application.log',env,45)
 status=0
finally:
 cleanup={}
 for name in resources:
  inspected=subprocess.run(['docker','inspect','--format','{{index .Config.Labels "io.yuantus.rehearsal"}}',name],capture_output=True,text=True)
  if inspected.returncode==0 and inspected.stdout.strip()==label:
   subprocess.run(['docker','rm','--force',name],capture_output=True)
  cleanup[name]=subprocess.run(['docker','inspect',name],capture_output=True).returncode!=0
 after=hashes();(out/'source-after.json').write_text(json.dumps(after,indent=2))
 (out/'result.json').write_text(json.dumps({'exit':status,'seconds':time.monotonic()-started,'sourceStable':before==after,'steps':steps,'cleanup':cleanup,'fixtureDir':str(work),'limits':['No enterprise data or external send','pluginDirs empty: core server only, not production plugin deployment']},indent=2))
 print(json.dumps({'exit':status,'sourceStable':before==after,'cleanup':cleanup}))
raise SystemExit(status)
