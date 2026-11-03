#!/usr/bin/env python3
"""Offline synthetic examples only. No HTTP/provider/DB or configuration changes."""
from pathlib import Path
import subprocess,json,sys,re,os,tempfile,hashlib
A=Path(__file__).resolve().parent
ROOT=A.parent.parent
DOC=ROOT/'docs/development/dingtalk-default-off-staging-smoke-20260708.md'
private='SYNTHETIC_PRIVATE_MUST_NOT_ECHO'
disabled={'success':False,'error':'DingTalk container login is not enabled','code':'container_login_disabled'}
login={'success':True,'data':{'mode':'login','user':{'id':private,'email':private,'name':private,'role':'admin','permissions':[]},'token':private,'features':{}}}
def wire(body,status,transport):return (body if isinstance(body,str) else json.dumps(body))+'\n'+str(status)+'\n'+str(transport)
rows=[]
def probe(name,mode,body,status=404,transport=0,match=False,fields=None):
 p=subprocess.run([sys.executable,str(A/'e1_response_filter.py'),mode],input=wire(body,status,transport),capture_output=True,text=True)
 assert private not in p.stdout+p.stderr,(name,'private echo')
 result=json.loads(p.stdout);key='default_off_contract_match' if mode=='default-off' else 'login_envelope_match';assert result[key] is match and p.returncode==(0 if match else 1),(name,result,p.returncode)
 for k,v in (fields or {}).items():assert result[k]==v,(name,k,result[k])
 rows.append({'name':name,'exit':p.returncode,'result':result})
probe('disabled exact','default-off',disabled,match=True)
probe('disabled numeric0 is not false','default-off',{**disabled,'success':0})
probe('disabled extra key','default-off',{**disabled,'private':private})
probe('complete disabled body but incomplete transfer','default-off',disabled,transport=18,fields={'transport_exit':18})
probe('complete disabled body but timeout','default-off',disabled,transport=28)
probe('wrong status','default-off',disabled,status=401)
probe('nonJSON','default-off','not-json')
probe('success exact','login',login,status=200,match=True)
probe('success numeric1 is not true','login',{**login,'success':1},status=200)
probe('complete login body but incomplete transfer','login',login,status=200,transport=18)
probe('JWT refusal bounded code','login',{'ok':False,'error':{'code':'UNAUTHORIZED','message':private}},status=401,fields={'http_status':401,'code':'UNAUTHORIZED'})
probe('provider rejection bounded code','login',{'success':False,'code':'invalid_auth_code','error':private},status=401,fields={'code':'invalid_auth_code'})
probe('recovery retains nested retryability','login',{'ok':False,'error':{'code':'RECOVERY_AUTHORITY_BUSY','message':private,'details':{'retryable':True,'private':private}}},status=409,fields={'http_status':409,'code':'RECOVERY_AUTHORITY_BUSY','retryable':True})
probe('rate limit numeric retryAfter','login',{'success':False,'error':private,'retryAfter':12},status=429,fields={'retry_after_seconds':12})
probe('boolean retryAfter is not a number','login',{'success':False,'retryAfter':True},status=429,fields={'retry_after_seconds':None})
probe('unknown code does not echo','login',{'success':False,'code':private},status=500,fields={'code':'UNRECOGNIZED'})
probe('unlinked enabled local policy code retained','login',{'success':False,'code':'unlinked_enabled_local_user','error':private},status=403,fields={'code':'unlinked_enabled_local_user'})
probe('unlinked local policy code retained','login',{'success':False,'code':'unlinked_local_user','error':private},status=403,fields={'code':'unlinked_local_user'})
for policy_code in ['auto_provision_alias_conflict', 'auto_provision_corp_required', 'auto_provision_email_conflict', 'directory_managed_identity', 'identity_already_bound', 'identity_mismatch']:
    probe('retains fixed current policy '+policy_code,'login',{'success':False,'code':policy_code,'error':private},status=403,fields={'code':policy_code})
probe('unbounded retryAfter hidden','login',{'success':False,'retryAfter':10**400},status=429,fields={'retry_after_seconds':None})
text=DOC.read_text();section=text.split('## 1. E1 ',1)[1].split('## 2.',1)[0];blocks=re.findall(r'```bash\n(.*?)```',section,re.S);assert len(blocks)==3
for block in blocks:subprocess.run(['/bin/bash','-n'],input=block,text=True,check=True)
# Exercise the actual default-OFF shell block with a private mock executable, never curl/network.
scratch_root=ROOT/'tmp'/'e1-doc-examples';scratch_root.mkdir(parents=True,exist_ok=True)
scratch=Path(tempfile.mkdtemp(prefix='e1-doc-no-network-',dir=scratch_root));fake=scratch/'curl';fake.write_text('#!/usr/bin/env python3\nimport os,sys\nsys.stdout.write(os.environ["E1_SYNTHETIC_BODY"]+"\\n404")\nraise SystemExit(int(os.environ["E1_SYNTHETIC_EXIT"]))\n');fake.chmod(0o755)
pipeline=[]
for code,body,match in [(0,disabled,True),(18,disabled,False),(0,{**disabled,'success':0},False)]:
 env=dict(os.environ,PATH=str(scratch)+':'+os.environ.get('PATH',''),STAGING_BASE_URL='http://synthetic.invalid',E1_SYNTHETIC_BODY=json.dumps(body),E1_SYNTHETIC_EXIT=str(code))
 p=subprocess.run(['/bin/bash'],input=blocks[0],cwd=ROOT,env=env,capture_output=True,text=True);assert private not in p.stdout+p.stderr;result=json.loads(p.stdout);assert result['default_off_contract_match'] is match and (p.returncode==0) is match,(code,result,p.returncode);assert result['transport_exit']==code;pipeline.append({'mock_curl_exit':code,'pipeline_exit':p.returncode,'match':match})
manifest=json.loads((A/'source-evidence-disposition.json').read_text())
outside={'before':hashlib.sha256(text.split('## 1. E1 ',1)[0].encode()).hexdigest(),'after':hashlib.sha256(text.split('## 2.',1)[1].encode()).hexdigest()}
assert outside==manifest['outside_E1_sha256']
subprocess.run(['git','diff','--check'],cwd=ROOT,check=True)
report={'scope':'offline synthetic CLI filters, actual Bash example with fake curl, source doc assertions; no real HTTP/TS/backend execution','filter_probes':rows,'shell_blocks_syntax':len(blocks),'actual_shell_fake_curl_probes':pipeline,'outside_E1_identical':True,'real_HTTP_calls':0,'scratch_retained':str(scratch.relative_to(ROOT)),'filter_sha256':hashlib.sha256((A/'e1_response_filter.py').read_bytes()).hexdigest(),'document_sha256':hashlib.sha256(DOC.read_bytes()).hexdigest(),'pass':True}
(A/'filter-review-fix-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'filter_probes':len(rows),'actual_shell_fake_curl_probes':len(pipeline),'shell_syntax_blocks':len(blocks),'outside_E1_identical':True,'real_HTTP_calls':0,'pass':True}))
