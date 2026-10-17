import os,json,tempfile,shutil,hashlib
from pathlib import Path
root=Path(tempfile.mkdtemp(prefix='native-eco-tenant-owned-',dir=os.environ['PAIRED_OWNED_ROOT']));(root/'.owner').write_text('native-eco-topology-control\n')
for key,value in {
 'DATABASE_URL':'sqlite:///'+str(root/'global.db'),
 'IDENTITY_DATABASE_URL':'sqlite:///'+str(root/'identity.db'),
 'DATABASE_URL_TEMPLATE':'sqlite:///'+str(root/'tenant_{tenant_id}_{org_id}.db'),
 'TENANCY_MODE':'db-per-tenant-org','ENVIRONMENT':'test','SCHEMA_MODE':'migrations','AUTH_MODE':'required',
 'ENABLE_METASHEET':'false','PLM_RECORD_PUSH_ENABLED':'false','PLM_CHANGE_EVENTS_ENABLED':'false',
 'PLM_APPROVAL_CARD_ENABLED':'true','PLM_BOM_WRITE_GRANT_ENABLED':'true',
 'PLM_APPROVAL_CARD_CONNECTIONS_JSON':json.dumps([{'connection_id':'personal-fixture','tenant_id':'default','org_id':'fixture-org'}]),
}.items():os.environ['YUANTUS_'+key]=value
from sqlalchemy import inspect,event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.engine import Engine
from fastapi.testclient import TestClient
from yuantus import database as business_db
from yuantus.security.auth import database as identity_db
from yuantus.meta_engine.models.meta_bom_eco_intent_audit import MetaBomEcoIntentAudit
from yuantus.meta_engine.models.meta_bom_writeback_audit import MetaBomWritebackAudit
from yuantus.security.auth.plm_approval_grant_models import PlmApprovalGrant
from yuantus.meta_engine.bootstrap import import_all_models
from yuantus.models.base import Base
from yuantus.scripts.tenant_schema import build_tenant_provisioning_metadata
from yuantus.api.tests.test_plm_bom_write_grant_http import Item,ItemType,AppLicense,Permission,Access,Tenant,Organization,AuthUser,OrgMembership,RBACUser,create_grant,create_app,AuditLog
from yuantus.api.tests.test_plm_bom_eco_intent_personal import _jwt, LifecycleState,ECO,PlmBomEcoIntentReceipt
import_all_models()
tenant_engine=business_db.create_db_engine('sqlite:///'+str(root/'tenant_default_fixture-org.db'))
identity_engine=identity_db.get_identity_engine()
engines=[business_db.engine,identity_engine,tenant_engine];proof={'dependency_overrides':0,'mode':'db-per-tenant-org','schema_mode':'migrations','schema_setup':'full global/identity metadata; official seed-meta tenant provisioning builder, not Alembic acceptance'}
errors=[]
routed=set()
def before_cursor(conn,cursor,statement,parameters,context,executemany):
 flat=statement.lower()
 for table in ("auth_users","rbac_users","meta_items","meta_eco","audit_logs","meta_bom_eco_intent_audits"):
  if table in flat:routed.add((Path(conn.engine.url.database).name,table,flat.split()[0]))
def on_error(ctx):errors.append({'error':str(ctx.original_exception),'statement':ctx.statement.split('VALUES')[0],'database':Path(ctx.engine.url.database).name})
try:
 for eng in engines:
  with eng.begin() as c:
   c.exec_driver_sql('BEGIN')
   (build_tenant_provisioning_metadata() if eng is tenant_engine else Base.metadata).create_all(c)
  event.listen(eng,'handle_error',on_error)
 identity=identity_db.get_identity_sessionmaker();tenant=sessionmaker(bind=tenant_engine,expire_on_commit=False)
 with identity() as d:
  d.add(Tenant(id='default',is_active=True));d.commit()
  d.add(Organization(id='fixture-org',tenant_id='default',is_active=True));d.add(AuthUser(id=42,tenant_id='default',username='writer',is_active=True));d.commit()
  d.add(OrgMembership(tenant_id='default',org_id='fixture-org',user_id=42,roles=['engineer'],is_active=True));d.commit()
  d.commit()
 with business_db.SessionLocal() as d:
  d.add(RBACUser(id=900,user_id=42,username='writer',is_active=True));d.commit()
 with tenant() as d:
  d.add(Permission(id='permission'));d.add(Access(id='ace',permission_id='permission',identity_id='900',can_get=True,can_update=True));d.add_all([ItemType(id='Part',permission_id='permission'),ItemType(id='Part BOM',is_relationship=True,permission_id='permission')]);d.commit()
  d.add_all([Item(id='part',item_type_id='Part',config_id='part',generation=1,is_current=True,state='Draft',properties={'item_number':'P-001','name':'Fixture assembly'}),Item(id='child',item_type_id='Part',config_id='child',generation=1,is_current=True,state='Draft',properties={'item_number':'C-001','name':'Fixture child'}),LifecycleState(id='LS-REL',name='Released',version_lock=True)]);d.commit()
  d.add(Item(id='locked-part',item_type_id='Part',config_id='locked-part',generation=1,is_current=True,current_state='LS-REL',state='Released',is_versionable=True,properties={'item_number':'LOCK-001','name':'Fixture locked assembly'}));d.get(Item,'part').is_versionable=True
  d.add(Item(id='line',item_type_id='Part BOM',config_id='line',generation=1,is_current=True,source_id='part',related_id='child',properties={'quantity':1}));d.add_all([AppLicense(id='line-lic',app_name='plm.bom_multitable_writeback',license_key='fixture-line',status='Active',tenant_id='default'),AppLicense(id='eco-lic',app_name='plm.bom_eco_revision',license_key='fixture-eco',status='Active',tenant_id='default')]);d.commit()
 if os.environ.get('PAIRED_BROWSER_MODE')=='1':
  with tenant() as d:
   d.add(AppLicense(id='read-lic',app_name='plm.bom_multitable',license_key='fixture-read',status='Active',tenant_id='default'));d.commit()
 tables=inspect(tenant_engine).get_table_names();assert 'rbac_users' not in tables and 'audit_logs' not in tables
 event.listen(Engine,'handle_error',on_error)
 event.listen(Engine,'before_cursor_execute',before_cursor)
 app=create_app();assert not app.dependency_overrides
 import sys,socket,threading,time,http.client,uvicorn
 from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
 native_sock=socket.socket();native_sock.bind(('127.0.0.1',0));native_sock.listen(128)
 native_port=native_sock.getsockname()[1]
 server=uvicorn.Server(uvicorn.Config(app,log_level='error',lifespan='off'))
 thread=threading.Thread(target=lambda:server.run(sockets=[native_sock]),daemon=True);thread.start()
 deadline=time.monotonic()+15
 while not server.started:
  assert time.monotonic()<deadline,'owned native startup deadline'
  time.sleep(.02)
 traffic=[]; dropped=set()
 class Proxy(BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def do_GET(self):self.forward()
  def do_POST(self):self.forward()
  def do_PATCH(self):self.forward()
  def do_DELETE(self):self.forward()
  def forward(self):
   length=int(self.headers.get('content-length','0'));body=self.rfile.read(length) if length else None
   headers={k:v for k,v in self.headers.items() if k.lower() not in ('host','connection','content-length')}
   conn=http.client.HTTPConnection('127.0.0.1',native_port,timeout=20)
   try:
    conn.request(self.command,self.path,body,headers);response=conn.getresponse();data=response.read()
    mutation=self.command=='PATCH' or (self.command=='POST' and self.path.endswith('/eco-intent'))
    auth=self.headers.get('Authorization','')
    traffic.append({'method':self.command,'path':self.path,'status':response.status,'credential':'bom_write' if auth.startswith('Bearer yuw_') else 'other','mutation':mutation,**({'key_sha256':hashlib.sha256(self.headers.get('Idempotency-Key','').encode()).hexdigest()} if mutation else {})})
    if mutation and response.status==200 and self.path not in dropped:
     dropped.add(self.path);self.close_connection=True
     try:self.connection.shutdown(socket.SHUT_RDWR)
     except OSError:pass
     self.connection.close();return
    self.send_response(response.status)
    for key,value in response.getheaders():
     if key.lower() not in ('transfer-encoding','connection','content-length'):self.send_header(key,value)
    self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
   finally:conn.close()
 proxy=ThreadingHTTPServer(('127.0.0.1',0),Proxy)
 import ssl
 tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(os.environ['PAIRED_TEST_CERT'],os.environ['PAIRED_TEST_KEY'])
 proxy.socket=tls.wrap_socket(proxy.socket,server_side=True)
 proxy_thread=threading.Thread(target=proxy.serve_forever,daemon=True);proxy_thread.start()
 print(json.dumps({'origin':'https://127.0.0.1:'+str(proxy.server_port),'jwt':_jwt()}),flush=True)
 for raw in sys.stdin:
  command=json.loads(raw)
  if command['command']=='report':
   with tenant() as d:
    audits=d.query(MetaBomEcoIntentAudit).all()
    report={'quantity':d.get(Item,'line').properties['quantity'],'ecos':d.query(ECO).count(),'eco_receipts':d.query(PlmBomEcoIntentReceipt).count(),'domain_audits':len(audits),'exact_audit_authority':all((a.auth_subject_id,a.rbac_actor_id,a.tenant_id,a.org_id)==(42,900,'default','fixture-org') for a in audits),'no_tenant_authority_copies':not any(t in inspect(tenant_engine).get_table_names() for t in ('rbac_users','auth_users','audit_logs')),'traffic':traffic,'dropped_response_count':len(dropped),'dependency_overrides':len(app.dependency_overrides)}
   with tenant() as d:
    report['line_audits']=[{'auth_user_id':a.user_id,'tenant_id':a.tenant_id,'org_id':a.org_id,'part_id':a.part_id,'bom_line_id':a.bom_line_id,'before':a.before,'after':a.after,'status':a.status,'key_sha256':hashlib.sha256(a.idempotency_key.encode()).hexdigest()} for a in d.query(MetaBomWritebackAudit).order_by(MetaBomWritebackAudit.created_at,MetaBomWritebackAudit.id)]
   with identity() as d:
    rows=d.query(PlmApprovalGrant).all();report.update(grants=len(rows),revoked_grants=sum(r.revoked_at is not None for r in rows),exact_grant_authority=all((r.user_id,r.tenant_id,r.org_id,r.purpose)==(42,'default','fixture-org','bom_write') for r in rows))
   print(json.dumps(report),flush=True)
  if command['command']=='stop':break
finally:
 if globals().get('proxy_thread') is not None and proxy_thread.is_alive():
  proxy.shutdown();proxy.server_close();proxy_thread.join(10)
 if globals().get('server') is not None:server.should_exit=True
 if globals().get('thread') is not None:thread.join(10)
 if globals().get('native_sock') is not None:native_sock.close()
 assert not (globals().get('thread') and thread.is_alive()),'owned native server shutdown'
 assert not (globals().get('proxy_thread') and proxy_thread.is_alive()),'owned proxy shutdown'
 for eng in list(business_db._tenant_engines.values())+engines:eng.dispose()
 if (root/'.owner').read_text()=='native-eco-topology-control\n':shutil.rmtree(root)
 print(json.dumps({'native_cleanup':not root.exists()}),flush=True)
