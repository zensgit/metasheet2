"""Native PG backup/restore tests, synthetic data only; requires a disposable test cluster."""
import hashlib, importlib.util, json, os, pathlib, subprocess, tempfile, unittest, uuid
from unittest.mock import patch
CORE = pathlib.Path(__file__).resolve().parents[2]
ROOT = CORE.parents[1] / 'scripts/ops/repairs'
REAL_RUN = subprocess.run
spec = importlib.util.spec_from_file_location('restore_check', ROOT / 'dingtalk-group-backup-restore-check.py')
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)
class NativeBackupRestoreTests(unittest.TestCase):
    def setUp(self):
        from urllib.parse import urlsplit,urlunsplit
        self.uri=os.environ.get('DATABASE_URL')
        if not self.uri:raise AssertionError('DATABASE_URL required; never skip native backup validation')
        self.parts=urlsplit(self.uri);self.url=lambda name:urlunsplit(self.parts._replace(path='/'+name))
        self.bin=pathlib.Path(os.environ.get('PG_BIN_DIR', '/opt/homebrew/opt/postgresql@16/bin'))
        self.source='backup_source_'+uuid.uuid4().hex
        self.pgsql('CREATE DATABASE '+self.source+';')
        seed='CREATE TABLE public.dingtalk_group_destinations(id text PRIMARY KEY,webhook_url text NOT NULL,secret text,name text,enabled boolean);'
        for i in range(49):seed+="INSERT INTO public.dingtalk_group_destinations VALUES ('s%02d','https://example.invalid/synthetic-%d',%s,'Synthetic',true);"%(i,i,"NULL" if i==48 else "'SECsynthetic-%d'"%i)
        self.pgsql(seed,self.source)
        result=self.pgsql("SELECT json_agg(json_build_array(id,webhook_url,secret) ORDER BY id) FROM public.dingtalk_group_destinations",self.source)
        self.plan={'version':1,'scopeDigest':hashlib.sha256(json.dumps(json.loads(result),separators=(',',':')).encode()).hexdigest(),'canaryDigest':'a'*64,'databaseIdentityDigest':'b'*64}
        self.tmp=tempfile.TemporaryDirectory(prefix='ms2-backup-synthetic-');self.backup=pathlib.Path(self.tmp.name)
    def tearDown(self):
        self.pgsql('DROP DATABASE IF EXISTS '+self.source+';');self.tmp.cleanup()
    def pgsql(self,sql,database=None):
        r=REAL_RUN([str(self.bin/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','--dbname',self.url(database) if database else self.uri],input=sql.encode(),capture_output=True)
        if r.returncode:raise AssertionError('SYNTHETIC_PSQL_FAILED')
        return r.stdout.decode()
    def dump(self,schema_only=False):
        with (self.backup/'database.dump').open('wb') as f:
            cmd=[str(self.bin/'pg_dump'),'-Fc','--no-owner','--no-privileges','--table=public.dingtalk_group_destinations','--dbname',self.url(self.source)]
            if schema_only:cmd+=['--schema-only']
            r=REAL_RUN(cmd,stdout=f,stderr=subprocess.PIPE)
        self.assertEqual(r.returncode,0)
    def docker(self,cmd,**kw):
        # Strict mapping of the production Docker calls onto this private native PG instance.
        if cmd[:4]==['docker','exec','-i','synthetic-db']:
            if cmd[4:] == ['pg_restore','--list']:return REAL_RUN([str(self.bin/'pg_restore'),'--list'],**kw)
            if 'exec psql' in cmd[6]:return REAL_RUN([str(self.bin/'psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','--dbname',self.uri],**kw)
            if 'umask 077' in cmd[6]:
                pathlib.Path(cmd[8]).write_bytes(kw['input']);pathlib.Path(cmd[8]).chmod(0o600)
                return subprocess.CompletedProcess(cmd,0,b'',b'')
        if cmd[:3]==['docker','exec','synthetic-db']:
            if cmd[3] in ['mkdir','chmod','rm']:return REAL_RUN(cmd[3:],**kw)
            if cmd[3:5]==['sh','-c'] and 'exec pg_restore' in cmd[5]:
                return REAL_RUN([str(self.bin/'pg_restore'),'--exit-on-error','--no-owner','--no-privileges','--dbname',self.url(cmd[7]),'--use-list',cmd[8],cmd[9]],**kw)
        if cmd[:2]==['docker','cp']:return REAL_RUN(['cp',cmd[2],cmd[3].split(':',1)[1]],**kw)
        raise AssertionError('Unexpected Docker command in native test')
    def runtime_check(self,database):
        core=CORE
        code="const pg=require("+json.dumps(str(core/'node_modules/pg'))+");const tool=require("+json.dumps(str(ROOT/'dingtalk-group-credentials-20261030.cjs'))+");(async()=>{const c=new pg.Client({connectionString:"+json.dumps(self.url(database))+"});try{await c.connect();console.log(JSON.stringify(await tool.verifyBackup(c,"+json.dumps(self.plan)+")))}catch(e){console.log(JSON.stringify({error:e.code}))}finally{await c.end()}})()"
        r=REAL_RUN(['node','-e',code],capture_output=True,text=True)
        self.assertEqual(r.returncode,0)
        return json.loads(r.stdout)
    def test_real_custom_dump_restores_exactly_49_rows_97_fields(self):
        self.dump()
        with patch.object(restore.subprocess,'run',side_effect=self.docker):
            self.assertEqual(restore.verify_backup_dump(self.backup,'synthetic-db',self.runtime_check),{'rows':49,'fields':97,'backupMatchesPlan':True})
    def test_active_restore_session_is_forcibly_closed_and_cleanup_recorded(self):
        self.dump(); holders=[]
        def check(database):
            result=self.runtime_check(database)
            holders.append(subprocess.Popen([str(self.bin/'psql'),'-X','-q','--dbname',self.url(database),'-c','SELECT pg_sleep(60)'],stdout=subprocess.PIPE,stderr=subprocess.PIPE))
            import time
            for _ in range(100):
                if int(self.pgsql("SELECT count(*) FROM pg_stat_activity WHERE datname='"+database+"'"))>0:break
                time.sleep(0.01)
            else:raise AssertionError('holder did not connect')
            return result
        try:
            with patch.object(restore.subprocess,'run',side_effect=self.docker):
                self.assertEqual(restore.verify_backup_dump(self.backup,'synthetic-db',check)['rows'],49)
            marker=json.loads(next(self.backup.glob('restore-cleanup-*.json')).read_text())
            self.assertEqual(marker['state'],'complete');self.assertTrue(marker['databaseDropped']);self.assertTrue(marker['directoryRemoved'])
        finally:
            for holder in holders:
                try:holder.communicate(timeout=5)
                except subprocess.TimeoutExpired:holder.kill();holder.communicate()
    def test_drop_failure_still_removes_dump_and_blocks_another_attempt(self):
        self.dump(); dropped=[]
        def fault(cmd,**kw):
            if isinstance(kw.get('input'),bytes) and kw['input'].startswith(b'DROP DATABASE'):
                dropped.append(True);return subprocess.CompletedProcess(cmd,1,b'',b'synthetic cleanup failure')
            return self.docker(cmd,**kw)
        try:
            with patch.object(restore.subprocess,'run',side_effect=fault):
                with self.assertRaisesRegex(RuntimeError,'BACKUP_RESTORE_CLEANUP_REQUIRED'):restore.verify_backup_dump(self.backup,'synthetic-db',self.runtime_check)
            marker=json.loads(next(self.backup.glob('restore-cleanup-*.json')).read_text())
            self.assertEqual(dropped,[True]);self.assertFalse(marker['databaseDropped']);self.assertTrue(marker['directoryRemoved'])
            self.assertFalse(pathlib.Path(marker['directory']).exists())
            with self.assertRaisesRegex(RuntimeError,'BACKUP_RESTORE_CLEANUP_REQUIRED'):restore.verify_backup_dump(self.backup,'synthetic-db',lambda db:self.fail('must not retry'))
        finally:
            for path in self.backup.glob('restore-cleanup-*.json'):
                self.pgsql('DROP DATABASE IF EXISTS '+json.loads(path.read_text())['database']+' WITH (FORCE);')
    def test_schema_only_dump_is_rejected_before_restore(self):
        self.dump(schema_only=True)
        with patch.object(restore.subprocess,'run',side_effect=self.docker):
            with self.assertRaisesRegex(RuntimeError,'BACKUP_TABLE_DATA_REQUIRED'):restore.verify_backup_dump(self.backup,'synthetic-db',lambda db:self.fail('must not invoke runtime'))
    def test_real_restored_wrong_values_reject_even_with_correct_counts(self):
        self.pgsql("UPDATE public.dingtalk_group_destinations SET secret='SECchanged' WHERE id='s00';",self.source);self.dump()
        with patch.object(restore.subprocess,'run',side_effect=self.docker):
            with self.assertRaisesRegex(RuntimeError,'BACKUP_DATA_MISMATCH'):restore.verify_backup_dump(self.backup,'synthetic-db',self.runtime_check)
if __name__ == '__main__':
    unittest.main(verbosity=2)
