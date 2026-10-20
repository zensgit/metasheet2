"""Owned synthetic extension to the existing separated Native PostgreSQL fixture."""
import hashlib
import io
import os
from pathlib import Path
import sys
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from yuantus.meta_engine.bootstrap import import_all_models
import_all_models()
from yuantus.meta_engine.app_framework.store_models import AppLicense
from yuantus.meta_engine.models.file import FileContainer
from yuantus.meta_engine.models.item import Item
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
        elif command in ('disable-license', 'restore-license'):
            db.get(AppLicense, 'owned-visual').status = 'Active' if command == 'restore-license' else 'Suspended'
        elif command in ('stale-version', 'restore-version'):
            version = db.get(ItemVersion, 'managed-visual-v1')
            version.is_current = command == 'restore-version'
            db.get(Item, 'part').current_version_id = 'managed-visual-v1' if version.is_current else None
        else:
            raise ValueError('Unknown owned fixture command')
        db.commit()
finally:
    engine.dispose()
