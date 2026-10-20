"""Owned synthetic extension to the existing separated Native PostgreSQL fixture."""
import hashlib
import io
import os
import json
import shutil
import subprocess
import uuid
from pathlib import Path
import sys
from PIL import Image
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from yuantus.meta_engine.bootstrap import import_all_models
import_all_models()
from yuantus.meta_engine.app_framework.store_models import AppLicense
from yuantus.meta_engine.models.file import FileContainer
from yuantus.meta_engine.models.item import Item
from yuantus.meta_engine.permission.models import Access
from yuantus.meta_engine.version.models import ItemVersion, VersionFile

root = Path(os.environ['PLM_MANAGED_VISUAL_FIXTURE_ROOT'])
assert root.parent == Path('/tmp') and root.name.startswith('plm-mdpg-s-') and (root / '.owner').is_file()
engine = create_engine(os.environ['PLM_DISCUSSION_TENANT_DATABASE_URL'])
try:
    with Session(engine) as db:
        command = sys.argv[1]
        if command == 'seed':
            storage = root / 'visual-storage'
            storage.mkdir(mode=0o700)
            content = io.BytesIO()
            Image.new('RGB', (4, 5), (61, 87, 99)).save(content, format='PNG')
            data = content.getvalue()
            (storage / 'owned.png').write_bytes(data)
            db.add(AppLicense(id='owned-visual', app_name='plm.visual_collaboration', license_key='synthetic-visual',
                              status='Active', tenant_id='default', org_id='fixture-org'))
            db.add(ItemVersion(id='managed-visual-v1', item_id='part', generation=1, revision='A', is_current=True))
            db.add(FileContainer(id='managed-visual-file', filename='owned.png', system_path='owned.png',
                                 checksum=hashlib.sha256(data).hexdigest(), preview_path='owned.png'))
            db.add(VersionFile(id='managed-visual-link', version_id='managed-visual-v1', file_id='managed-visual-file'))
            db.flush()
            db.get(Item, 'part').current_version_id = 'managed-visual-v1'
        elif command in ('revoke-acl', 'restore-acl'):
            db.get(Access, 'discussion-ace').can_get = command == 'restore-acl'
        elif command in ('disable-license', 'restore-license'):
            db.get(AppLicense, 'owned-visual').status = 'Active' if command == 'restore-license' else 'Suspended'
        elif command in ('stale-version', 'restore-version'):
            version = db.get(ItemVersion, 'managed-visual-v1')
            version.is_current = command == 'restore-version'
            db.get(Item, 'part').current_version_id = 'managed-visual-v1' if version.is_current else None
        elif command == 'restore-domain':
            thread = str(uuid.UUID(sys.argv[2]))
            url = make_url(os.environ['PLM_DISCUSSION_TENANT_DATABASE_URL'])
            assert url.query['host'] == str(root) and url.database == 'native_default_fixture-org'
            pg = Path(os.environ['PLM_MANAGED_VISUAL_PG_BIN'])
            target_name = 'restored_native_default_fixture-org'
            dump = root / 'native-visual-domain.dump'
            assert not dump.exists()
            common = ['-h', str(root), '-U', 'plm_fixture']
            subprocess.run([pg / 'pg_dump', *common, '-Fc', '-f', dump, url.database], check=True, capture_output=True, timeout=60)
            subprocess.run([pg / 'createdb', *common, target_name], check=True, capture_output=True, timeout=30)
            subprocess.run([pg / 'pg_restore', *common, '--exit-on-error', '--single-transaction', '-d', target_name, dump], check=True, capture_output=True, timeout=60)
            restored = create_engine(url.set(database=target_name))
            def domain(connection):
                connection.execute(text("SET TIME ZONE 'UTC'"))
                values = {}
                for table, clause in [
                    ('meta_discussion_threads', 'id=:thread'),
                    ('meta_discussion_comments', 'thread_id=:thread'),
                    ('meta_discussion_markups', 'comment_id IN (SELECT id FROM meta_discussion_comments WHERE thread_id=:thread)'),
                    (FileContainer.__tablename__, "id='managed-visual-file'"),
                    (ItemVersion.__tablename__, "id='managed-visual-v1'"),
                    (Item.__tablename__, "id='part'"),
                ]:
                    values[table] = connection.execute(text(f'SELECT row_to_json(x) FROM {table} x WHERE {clause} ORDER BY id'), {'thread': thread}).scalars().all()
                assert len(values['meta_discussion_threads']) == len(values['meta_discussion_comments']) == len(values['meta_discussion_markups']) == 1
                return values
            try:
                with engine.connect() as original, restored.connect() as target:
                    before, after = domain(original), domain(target)
                    assert before == after
                restore_storage = root / 'visual-restored-storage'
                restore_storage.mkdir(mode=0o700)
                original_image = root / 'visual-storage/owned.png'
                target_image = restore_storage / 'owned.png'
                shutil.copyfile(original_image, target_image)
                assert target_image.read_bytes() == original_image.read_bytes()
                receipt = {'thread_id': thread, 'domain_sha256': hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest(),
                           'dump_sha256': hashlib.sha256(dump.read_bytes()).hexdigest(), 'image_sha256': hashlib.sha256(target_image.read_bytes()).hexdigest(),
                           'restored_database': target_name, 'domain_equal': True}
                print(json.dumps(receipt))
            finally:
                restored.dispose()
        else:
            raise ValueError('Unknown owned fixture command')
        db.commit()
finally:
    engine.dispose()
