"""Local-only synthetic raster/version fixture for the cross-service browser test."""

import hashlib
import io
import os
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
from yuantus.meta_engine.permission.models import Access
from yuantus.security.auth.models import AuthUser, AuthCredential, OrgMembership
from yuantus.security.auth.passwords import hash_password
from yuantus.security.rbac.models import RBACUser


def main() -> None:
    db_path, storage_path = sys.argv[1:3]
    os.makedirs(storage_path, exist_ok=True)
    engine = create_engine(f"sqlite:///{db_path}")
    with Session(engine) as db:
        db.add(AppLicense(id="lic-visual", app_name="plm.visual_collaboration",
                          license_key="local-visual", status="Active", tenant_id="default"))
        db.add(AppLicense(id="lic-visual-discussion-write", app_name="plm.metasheet_review_writeback",
                          license_key="local-visual-write", status="Active", tenant_id="default"))
        db.add(Item(id="item-2", item_type_id="Part", config_id="item-2", generation=1,
                    is_current=True, state="active", created_by_id=42))
        for part_no, part_id in ((1, "item-1"), (2, "item-2")):
            for index in range(10):
                fmt = "PNG" if index % 2 == 0 else "JPEG"
                suffix = "png" if fmt == "PNG" else "jpg"
                file_id = f"visual-file-{part_no}-{index:02d}"
                version_id = f"visual-version-{part_no}-{index:02d}"
                name = f"part-{part_no}-revision-{index:02d}.{suffix}"
                content = io.BytesIO()
                Image.new("RGB", (5 + index, 6 + part_no),
                          ((part_no * 61 + index * 7) % 256, index * 19 % 256, 87)).save(content, format=fmt)
                data = content.getvalue()
                with open(os.path.join(storage_path, name), "wb") as output:
                    output.write(data)
                db.add(ItemVersion(id=version_id, item_id=part_id, generation=index + 1,
                                   revision=chr(ord("A") + index), is_current=index == 9))
                db.add(FileContainer(id=file_id, filename=name, system_path=name,
                                     checksum=hashlib.sha256(data).hexdigest(), preview_path=name))
                db.add(VersionFile(id=f"visual-link-{part_no}-{index:02d}",
                                   version_id=version_id, file_id=file_id))
            db.flush()
            db.get(Item, part_id).current_version_id = f"visual-version-{part_no}-09"
        for user_id in (42, 43):
            db.add(Access(id=f"visual-write-{user_id}", permission_id="perm-world-get", identity_id=str(user_id), can_get=True, can_update=True))
        db.commit()
    engine.dispose()
    # The browser proves two distinct reviewers, with authority databases separate
    # from tenant business storage. Every path is a private test fixture.
    for authority_path in sys.argv[3:]:
        authority = create_engine(f"sqlite:///{authority_path}")
        with Session(authority) as db:
            db.merge(AuthUser(id=43, tenant_id="default", username="u43", email="u43@x.io"))
            db.merge(AuthCredential(user_id=43, password_hash=hash_password("e2e-pw-43")))
            db.merge(OrgMembership(id=43, tenant_id="default", org_id="org-1", user_id=43, roles=[], is_active=True))
            db.merge(RBACUser(id=43, user_id=43, username="u43", is_active=True))
            db.commit()
        authority.dispose()


if __name__ == "__main__":
    main()
