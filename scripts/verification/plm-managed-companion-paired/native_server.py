"""Owned native managed-login process. Reads no customer data and does not edit the native tree."""
import json, os, sys, threading, hashlib
from pathlib import Path

cfg = json.loads(os.environ['PAIRED_MANAGED_CONFIG'])
root = Path(cfg['root'])
origin = cfg['origin']
callback = cfg['callback']
issuer = cfg['issuer']
secret = cfg['secret']
root_part_id = cfg.get('root_part_id', 'part')
for key, value in {
    'JWT_SECRET_KEY': 'synthetic-native-managed-read-configured-only',
    'DATABASE_URL': 'sqlite:///' + str(root / 'global.db'),
    'IDENTITY_DATABASE_URL': 'sqlite:///' + str(root / 'identity.db'),
    'DATABASE_URL_TEMPLATE': 'sqlite:///' + str(root / 'tenant_{tenant_id}_{org_id}.db'),
    'TENANCY_MODE': 'db-per-tenant-org',
    'ENVIRONMENT': 'test',
    'SCHEMA_MODE': 'migrations',
    'AUTH_MODE': 'required',
    'ENABLE_METASHEET': 'true',
    'PLM_MANAGED_LOGIN_ENABLED': 'true',
    'PLM_BOM_READ_SESSION_ENABLED': 'true',
    'PLM_BOM_SNAPSHOT_SHARE_ENABLED': 'true' if cfg.get('snapshot_share') else 'false',
    'PLM_BOM_WRITE_GRANT_ENABLED': 'true',
    'PLM_APPROVAL_CARD_ENABLED': 'true',
    'PLM_RECORD_PUSH_ENABLED': 'false',
    'PLM_CHANGE_EVENTS_ENABLED': 'false',
    'A1_SINGLE_TENANT_ORG_GATE': 'false',
    'AUDIT_ENABLED': 'false',
    'PLM_BOM_READ_CLIENTS_JSON': json.dumps([{
        'client_id': 'managed-fixture', 'tenant_id': 'default', 'org_id': 'fixture-org', 'origin': origin,
    }]),
    'PLM_APPROVAL_CARD_CONNECTIONS_JSON': json.dumps([{
        'connection_id': 'personal-fixture', 'tenant_id': 'default', 'org_id': 'fixture-org',
    }]),
    'PLM_MANAGED_LOGIN_CLIENTS_JSON': json.dumps([{
        'client_id': 'managed-fixture', 'tenant_id': 'default', 'org_id': 'fixture-org',
        'origin': origin, 'callback': callback, 'issuer': issuer,
        'secret_sha256': hashlib.sha256(secret.encode()).hexdigest(),
    }]),
}.items():
    os.environ['YUANTUS_' + key] = value

from sqlalchemy.orm import sessionmaker
from yuantus.security.auth.models import AuthCredential, Tenant, Organization, AuthUser, OrgMembership
from yuantus.security.auth.passwords import hash_password
from yuantus import database as business_db
from yuantus.security.auth import database as identity_db
from yuantus.meta_engine.bootstrap import import_all_models
from yuantus.models.base import Base
from yuantus.scripts.tenant_schema import build_tenant_provisioning_metadata
from yuantus.api.app import create_app
from yuantus.meta_engine.models.item import Item
from yuantus.meta_engine.models.meta_schema import ItemType
from yuantus.meta_engine.app_framework.store_models import AppLicense
from yuantus.meta_engine.permission.models import Access, Permission
from yuantus.security.rbac.models import RBACUser
from yuantus.meta_engine.models.meta_bom_writeback_audit import MetaBomWritebackAudit

import_all_models()
tenant_engine = business_db.create_db_engine('sqlite:///' + str(root / 'tenant_default_fixture-org.db'))
identity_engine = identity_db.get_identity_engine()
for eng in (business_db.engine, identity_engine, tenant_engine):
    with eng.begin() as connection:
        connection.exec_driver_sql('BEGIN')
        (build_tenant_provisioning_metadata() if eng is tenant_engine else Base.metadata).create_all(connection)
identity = identity_db.get_identity_sessionmaker()
tenant = sessionmaker(bind=tenant_engine, expire_on_commit=False)
with identity() as db:
    db.add(Tenant(id='default', is_active=True))
    db.commit()
    db.add(Organization(id='fixture-org', tenant_id='default', is_active=True))
    db.add(AuthUser(id=42, tenant_id='default', username='writer', is_active=True))
    db.commit()
    db.add(OrgMembership(tenant_id='default', org_id='fixture-org', user_id=42, roles=['engineer'], is_active=True))
    db.add(AuthCredential(user_id=42, password_hash=hash_password('synthetic-browser-password')))
    db.commit()
with business_db.SessionLocal() as db:
    db.add(RBACUser(id=900, user_id=42, username='writer', is_active=True))
    db.commit()
with tenant() as db:
    db.add(Permission(id='permission'))
    db.add(Access(id='ace', permission_id='permission', identity_id='900', can_get=True, can_update=True))
    db.add_all([
        ItemType(id='Part', permission_id='permission'),
        ItemType(id='Part BOM', is_relationship=True, permission_id='permission'),
    ])
    db.commit()
    db.add_all([
        Item(id=root_part_id, item_type_id='Part', config_id=root_part_id, generation=1, is_current=True, state='Draft', properties={'item_number': 'P-001', 'name': 'Fixture assembly'}),
        Item(id='child', item_type_id='Part', config_id='child', generation=1, is_current=True, state='Draft', properties={'item_number': 'C-001', 'name': 'Fixture child'}),
    ])
    db.commit()
    db.add(Item(id='line', item_type_id='Part BOM', config_id='line', generation=1, is_current=True, source_id=root_part_id, related_id='child', properties={'quantity': 1}))
    db.add(AppLicense(id='read-lic', app_name='plm.bom_multitable', license_key='fixture-read', status='Active', tenant_id='default', org_id='fixture-org'))
    db.add(AppLicense(id='line-lic', app_name='plm.bom_multitable_writeback', license_key='fixture-line', status='Active', tenant_id='default', org_id='fixture-org'))
    db.commit()

app = create_app()
assert not app.dependency_overrides
import uvicorn
server = uvicorn.Server(uvicorn.Config(app, fd=int(cfg['fd']), log_level='warning', lifespan='off', proxy_headers=True, forwarded_allow_ips='127.0.0.1'))
thread = threading.Thread(target=server.run, daemon=True)
thread.start()
deadline = __import__('time').monotonic() + 40
while not server.started:
    if __import__('time').monotonic() > deadline:
        raise SystemExit('native server did not start')
    __import__('time').sleep(0.05)
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    command = line.strip()
    if command == 'report':
        with tenant() as db:
            audits = db.query(MetaBomWritebackAudit).all()
            report = {
                'write_audits': len(audits),
                'write_subjects': sorted({row.user_id for row in audits}),
                'write_lines': sorted({row.bom_line_id for row in audits}),
            }
        print(json.dumps(report), flush=True)
    elif command == 'stop':
        server.should_exit = True
        break
thread.join(20)
