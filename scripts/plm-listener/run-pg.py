import json,os,pathlib,socket,subprocess,tempfile,time,hashlib,sys,shutil
root=pathlib.Path.cwd()
name=sys.argv[1]
out=root/'artifacts/plm-listener-review-20261015'/name
out.mkdir()
pg=pathlib.Path(os.environ.get('PG_BIN') or pathlib.Path(shutil.which('pg_ctl') or '/opt/homebrew/opt/postgresql@15/bin/pg_ctl').parent);node=os.environ.get('NODE_BINARY') or shutil.which('node') or 'node'
tmp=pathlib.Path(tempfile.mkdtemp(prefix='w20-bom-pg-'));sock=tmp/'socket';sock.mkdir()
s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
paths=[p for base in ['src','tests/plm-bom-review'] for p in (root/'packages/core-backend'/base).rglob('*.ts')]+list((root/'packages/core-backend/tests').rglob('plm-bom-review*.ts'))
def hashes():return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(set(paths))}
before=hashes();(out/'source-before.json').write_text(json.dumps(before,indent=2));commands=[]
def run(args,**kw):
 commands.append(args)
 return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,**kw)
started=False;test_exit=1
try:
 r=run([str(pg/'initdb'),'-D',str(tmp/'data'),'-A','trust','--no-locale','-U','w20']);(out/'initdb.log').write_text(r.stdout);r.check_returncode()
 r=run([str(pg/'pg_ctl'),'-D',str(tmp/'data'),'-l',str(out/'postgres.log'),'-o',f'-h 127.0.0.1 -p {port} -k {sock}','-w','start']);(out/'start.log').write_text(r.stdout);r.check_returncode();started=True
 r=run([str(pg/'createdb'),'-h','127.0.0.1','-p',str(port),'-U','w20','w20']);r.check_returncode()
 env=os.environ.copy();env.update(DATABASE_URL=f'postgresql://w20@127.0.0.1:{port}/w20',EXPECT_DB='1',NODE_ENV='test')
 cmd=[node,'node_modules/vitest/vitest.mjs','run','--config','vitest.plm-bom-review.config.ts','--reporter=verbose','--reporter=junit',f'--outputFile.junit={out}/junit.xml']
 start=time.monotonic();r=run(cmd,cwd=root/'packages/core-backend',env=env);test_exit=r.returncode;(out/'test.log').write_text(r.stdout)
 (out/'result.json').write_text(json.dumps({'exit':r.returncode,'durationSeconds':time.monotonic()-start,'commands':commands,'port':port,'privateCluster':str(tmp),'sourceStable':hashes()==before},indent=2));print(r.stdout[-12000:]);print('EXIT',r.returncode)
finally:
 if started:
  r=run([str(pg/'pg_ctl'),'-D',str(tmp/'data'),'-m','fast','-w','stop']);(out/'stop.log').write_text(r.stdout)
  s=socket.socket();stopped=s.connect_ex(('127.0.0.1',port))!=0;s.close();(out/'cleanup.json').write_text(json.dumps({'stopExit':r.returncode,'portClosed':stopped,'privateCluster':str(tmp),'retainedOnlyDisposableFiles':True},indent=2))
 (out/'source-after.json').write_text(json.dumps(hashes(),indent=2))

raise SystemExit(test_exit)
