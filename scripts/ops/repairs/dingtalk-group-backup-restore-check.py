"""Restore only the reviewed table in a temporary database on the original host."""
import datetime,json,os,pathlib,re,subprocess,uuid

def verify_backup_dump(backup, database_container, runtime_check):
    # runtime_check reads restored rows via the app's actual connection with only dbname changed.
    def command(args, data=None):
        r=subprocess.run(args,input=data,capture_output=True,timeout=120)
        if r.returncode: raise RuntimeError('BACKUP_RESTORE_FAILED')
        return r.stdout
    def sql(text):
        return command(['docker','exec','-i',database_container,'sh','-c',
          'exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}"'],text.encode())
    for previous in backup.glob('restore-cleanup-*.json'):
        if json.loads(previous.read_text()).get('state')!='complete': raise RuntimeError('BACKUP_RESTORE_CLEANUP_REQUIRED')
    with (backup/'database.dump').open('rb') as f:
        toc=subprocess.run(['docker','exec','-i',database_container,'pg_restore','--list'],stdin=f,capture_output=True,timeout=120)
    if toc.returncode: raise RuntimeError('BACKUP_UNREADABLE')
    selected=[]; kinds=[]
    for line in toc.stdout.decode().splitlines():
        if re.match(r'^\d+; \d+ \d+ TABLE(?: DATA)? public dingtalk_group_destinations ',line):
            selected.append(line); kinds.append('data' if ' TABLE DATA ' in line else 'schema')
    if sorted(kinds)!=['data','schema']: raise RuntimeError('BACKUP_TABLE_DATA_REQUIRED')
    token=uuid.uuid4().hex
    database='ms2_backup_check_'+token
    directory='/tmp/ms2_backup_check_'+token
    record={'database':database,'directory':directory,'containerId':database_container,'state':'pending'}
    marker=backup/('restore-cleanup-'+token+'.json')
    with open(marker,'x',opener=lambda path,flags:os.open(path,flags,0o600)) as f:json.dump(record,f)
    try:
        command(['docker','exec',database_container,'mkdir','-m','700',directory])
        command(['docker','cp',str(backup/'database.dump'),database_container+':'+directory+'/database.dump'])
        command(['docker','exec',database_container,'chmod','600',directory+'/database.dump'])
        # This list is TOC metadata only, with no values. Restore no triggers, functions or constraints.
        command(['docker','exec','-i',database_container,'sh','-c','umask 077; cat > "$1"','sh',directory+'/restore.list'], ('\n'.join(selected)+'\n').encode())
        sql('CREATE DATABASE '+database+';')
        sql('REVOKE CONNECT ON DATABASE '+database+' FROM PUBLIC;')
        command(['docker','exec',database_container,'sh','-c',
          'exec pg_restore --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" --dbname "$1" --use-list "$2" "$3"',
          'sh',database,directory+'/restore.list',directory+'/database.dump'])
        result=runtime_check(database)
        if result!={'rows':49,'fields':97,'backupMatchesPlan':True}: raise RuntimeError('BACKUP_DATA_MISMATCH')
        return result
    finally:
        # Always try both. A private marker lets the operator find leftovers after timeout/disconnect.
        errors=[]
        try: sql('DROP DATABASE IF EXISTS '+database+' WITH (FORCE);');record['databaseDropped']=True
        except Exception: errors.append('database');record['databaseDropped']=False
        try: command(['docker','exec',database_container,'rm','-rf',directory]);record['directoryRemoved']=True
        except Exception: errors.append('directory');record['directoryRemoved']=False
        record['state']='cleanup_required' if errors else 'complete'
        record['finishedAtUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        with marker.open('w') as f:json.dump(record,f)
        if errors: raise RuntimeError('BACKUP_RESTORE_CLEANUP_REQUIRED')
