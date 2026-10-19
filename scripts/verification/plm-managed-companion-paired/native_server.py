"""Owned native managed-login process. Reads no customer data and does not edit the native tree."""
import json, os, sys, threading, hashlib
from pathlib import Path

if not __debug__:
    raise RuntimeError("Verification requires assertions enabled")

cfg = json.loads(os.environ['PAIRED_MANAGED_CONFIG'])
root = Path(cfg['root'])
origin = cfg['origin']
callback = cfg['callback']
issuer = cfg['issuer']
secret = cfg['secret']
root_part_id = cfg.get('root_part_id', 'part')
managed_enabled = cfg.get('managed_enabled', True)
assert type(managed_enabled) is bool, 'managed_enabled must be boolean'
sharing_enabled = cfg.get('sharing_enabled', bool(cfg.get('snapshot_share')))
assert type(sharing_enabled) is bool, 'sharing_enabled must be boolean'
for key, value in {
    'JWT_SECRET_KEY': 'synthetic-native-managed-read-configured-only',
    'DATABASE_URL': 'sqlite:///' + str(root / 'global.db'),
    'IDENTITY_DATABASE_URL': 'sqlite:///' + str(root / 'identity.db'),
    'DATABASE_URL_TEMPLATE': 'sqlite:///' + str(root / 'tenant_{tenant_id}_{org_id}.db'),
    'TENANCY_MODE': 'db-per-tenant-org',
    'ENVIRONMENT': 'test',
    'SCHEMA_MODE': 'migrations',
    'AUTH_MODE': 'required',
    'ENABLE_METASHEET': 'true' if managed_enabled else 'false',
    'PLM_MANAGED_LOGIN_ENABLED': 'true' if managed_enabled else 'false',
    'PLM_BOM_READ_SESSION_ENABLED': 'true',
    'PLM_BOM_SNAPSHOT_SHARE_ENABLED': 'true' if sharing_enabled else 'false',
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

if cfg.get('package_native_env') is not None:
    package_env = cfg['package_native_env']
    assert all(key.startswith('YUANTUS_') for key in package_env)
    assert package_env['YUANTUS_PLM_BOM_WRITE_GRANT_ENABLED'] == ('true' if cfg.get('package_personal_write') else 'false')
    assert package_env['YUANTUS_PLM_APPROVAL_CARD_ENABLED'] == ('true' if cfg.get('package_personal_approval') else 'false')
    os.environ.update(package_env)
    if cfg.get('restore_existing') is True:
        for key in ('YUANTUS_ENABLE_METASHEET', 'YUANTUS_PLM_MANAGED_LOGIN_ENABLED', 'YUANTUS_PLM_BOM_SNAPSHOT_SHARE_ENABLED'):
            os.environ[key] = 'false'

if cfg.get('package_personal_approval'):
    os.environ['YUANTUS_ECO_AUTHZ_MODE'] = 'enforce'

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
identity = identity_db.get_identity_sessionmaker()
tenant = sessionmaker(bind=tenant_engine, expire_on_commit=False)
if cfg.get('restore_existing') is True:
    marker = root.parent / '.plm-managed-paired-owned'
    assert root.name == 'restored-native' and marker.is_file() and not root.is_symlink(), 'owned restored root required'
    ownership = json.loads(marker.read_text())
    assert ownership['kind'] == 'plm-managed-companion-paired'
    assert root.parent.name == 'plm-managed-paired-' + ownership['nonce']
    for name in ('global.db', 'identity.db', 'tenant_default_fixture-org.db'):
        database = root / name
        assert database.is_file() and not database.is_symlink(), 'missing or linked restored database'
else:
    for eng in (business_db.engine, identity_engine, tenant_engine):
        with eng.begin() as connection:
            connection.exec_driver_sql('BEGIN')
            (build_tenant_provisioning_metadata() if eng is tenant_engine else Base.metadata).create_all(connection)
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
        if cfg.get('package_personal_write'):
            from yuantus.meta_engine.lifecycle.models import LifecycleMap, LifecycleState
            db.add(LifecycleMap(id='fixture-lifecycle', name='Fixture lifecycle'))
            db.flush()
            db.add_all([
                LifecycleState(id='fixture-draft', lifecycle_map_id='fixture-lifecycle', name='Draft', is_start_state=True, version_lock=False),
                LifecycleState(id='fixture-released', lifecycle_map_id='fixture-lifecycle', name='Released', is_released=True, version_lock=True),
            ])
            db.get(ItemType, 'Part').lifecycle_map_id = 'fixture-lifecycle'
            db.add(Item(id='eco-part', item_type_id='Part', config_id='eco-part', generation=1,
                is_current=True, state='Released', current_state='fixture-released',
                properties={'item_number': 'ECO-P-001', 'name': 'Owned locked ECO assembly'}))
            db.flush()
        db.add(Item(id='line', item_type_id='Part BOM', config_id='line', generation=1, is_current=True, source_id=root_part_id, related_id='child', properties={'quantity': 1}))
        db.add(AppLicense(id='read-lic', app_name='plm.bom_multitable', license_key='fixture-read', status='Active', tenant_id='default', org_id='fixture-org'))
        if cfg.get('package_personal_write'):
            db.add(AppLicense(id='eco-lic', app_name='plm.bom_eco_revision', license_key='fixture-eco', status='Active', tenant_id='default', org_id='fixture-org'))
        db.add(AppLicense(id='line-lic', app_name='plm.bom_multitable_writeback', license_key='fixture-line', status='Active', tenant_id='default', org_id='fixture-org'))
        db.commit()

if cfg.get('package_personal_approval'):
    import uuid
    from yuantus.security.rbac.models import RBACRole, RBACPermission, RBACResource
    from yuantus.meta_engine.models.eco import ECO, ECOStage
    from yuantus.meta_engine.services.eco_service import ECOApprovalService
    approval_eco_id, approval_stage_id = str(uuid.uuid4()), str(uuid.uuid4())
    with business_db.SessionLocal() as db:
        resource = RBACResource(id=21, name='ECO', resource_type='business')
        db.add(resource)
        role = RBACRole(id=1, name='engineer', is_active=True)
        role.permissions.append(RBACPermission(id=21, name='eco.auto_assign', action='execute', resource_id=21, is_active=True))
        db.add(role)
        native_actor = db.get(RBACUser, 900)
        native_actor.roles.append(role)
        db.commit()
    with tenant() as db:
        db.add(ItemType(id='ECO', permission_id='permission'))
        ace = db.get(Access, 'ace')
        ace.can_create = ace.can_delete = True
        db.add(ECOStage(id=approval_stage_id, name='Owned review', sequence=10,
            approval_type='mandatory', approval_roles=['engineer'], min_approvals=2, auto_progress=False))
        db.add(ECO(id=approval_eco_id, name='Owned approval fixture', eco_type='product',
            state='progress', stage_id=approval_stage_id, tenant_id='default', org_id='fixture-org', created_by_id=900))
        db.commit()
    with tenant() as db, identity() as auth, business_db.SessionLocal() as rbac:
        ECOApprovalService(db, identity_db=auth, rbac_db=rbac, tenant_id='default', org_id='fixture-org').auto_assign_stage_approvers(approval_eco_id, 900)
        db.commit()

def item_snapshot(db):
    return sorted([{'id': item.id, 'generation': item.generation, 'state': item.state,
                    'properties': item.properties} for item in db.query(Item).all()], key=lambda item: item['id'])

with tenant() as db:
    initial_items = item_snapshot(db) if cfg.get('snapshot_share') else None

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
                'snapshot_sharing_enabled': __import__('yuantus.config.settings', fromlist=['get_settings']).get_settings().PLM_BOM_SNAPSHOT_SHARE_ENABLED,
                'snapshot_items_hash': hashlib.sha256(json.dumps(item_snapshot(db), sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                'write_subjects': sorted({row.user_id for row in audits}),
                'write_lines': sorted({row.bom_line_id for row in audits}),
                **({'snapshot_source_unchanged': item_snapshot(db) == initial_items} if initial_items is not None else {}),
            }
        if cfg.get('package_personal_write'):
            from yuantus.meta_engine.models.eco import ECO
            from yuantus.meta_engine.version.models import ItemVersion
            with tenant() as db:
                ecos = db.query(ECO).filter_by(product_id='eco-part').all()
                targets = [db.get(ItemVersion, eco.target_version_id) for eco in ecos if eco.target_version_id]
                sources = [db.get(ItemVersion, eco.source_version_id) for eco in ecos if eco.source_version_id]
                report['personal_package_eco'] = {'count': len(ecos),
                    'rbac_creators': sorted({eco.created_by_id for eco in ecos}),
                    'target_versions': sum(target is not None for target in targets),
                    'source_versions': sum(source is not None for source in sources),
                    'distinct_product_versions': all(
                        source is not None and target is not None
                        and source.id != target.id
                        and source.item_id == target.item_id == eco.product_id
                        for eco, source, target in zip(ecos, sources, targets)
                    ) and len(sources) == len(targets) == len(ecos),
                    'target_generations': [target.generation for target in targets if target is not None],
                    'target_creators': sorted({target.created_by_id for target in targets if target is not None}),
                    'line_quantity': (db.get(Item, 'line').properties or {}).get('quantity')}
            from yuantus.security.auth.plm_approval_grant_models import PlmApprovalGrant
            from yuantus.models.audit import AuditLog
            with identity() as identity_db_session:
                report['personal_grants_revoked'] = identity_db_session.query(PlmApprovalGrant).filter(
                    PlmApprovalGrant.purpose == 'bom_write', PlmApprovalGrant.revoked_at.isnot(None)).count()
                report['personal_revoke_audits'] = identity_db_session.query(AuditLog).filter_by(
                    path='/api/v1/plm-bom-write-grant/grant', method='DELETE').count()
        if cfg.get('package_personal_approval'):
            from yuantus.meta_engine.models.plm_approval_card import PlmApprovalCardCommand
            from yuantus.meta_engine.models.eco import ECOApproval
            with tenant() as db:
                commands = db.query(PlmApprovalCardCommand).all()
                votes = db.query(ECOApproval).filter_by(eco_id=approval_eco_id, user_id=900).all()
                report['personal_package_approval'] = {'commands': len(commands),
                    'subjects': sorted({row.actor_auth_user_id for row in commands}),
                    'rbac_actors': sorted({row.actor_rbac_user_id for row in commands}),
                    'votes': [row.status for row in votes]}
        print(json.dumps(report), flush=True)
    elif command == 'stop':
        server.should_exit = True
        break
thread.join(20)
