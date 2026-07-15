"""PLM-COLLAB Discussion read-auth line — sub-slice 6 (capstone dual-service E2E).

Standalone seed script for the TEMP Yuantus provider used by the local dual-service E2E
(`plm-discussion-read-e2e.test.ts`). Run with the Yuantus venv python and PYTHONPATH pointed at
the yuantus-readauth worktree src (the Node harness sets both). It boots the SAME DB the uvicorn
provider process will serve (a shared temp sqlite file via `YUANTUS_DATABASE_URL`), so seeding
here is visible to the live API. Because `IDENTITY_DATABASE_URL` defaults to `DATABASE_URL`, the
single sqlite file backs BOTH the main and the identity schema — one create_all covers every
table (all models hang off the shared `Base`/`WorkflowBase`).

Mirrors the provider's own read-gate tests' seeding (`test_discussion_router.py`):
`_seed_membership` (Tenant/Organization/OrgMembership + AuthUser/RBACUser), a readable Part item
(item/`item-1`), the `metasheet_review` read entitlement (`plm.metasheet_review`), and discussion
threads on the bound part — one OPEN + one RESOLVED (to exercise include_resolved) — plus an
off-part thread and a foreign-tenant thread for the negative cases.

CI wiring is DEFERRED (build-then-HOLD): the harness hard-codes local worktree/venv paths via env
with sensible defaults; the owner will wire this to CI as the final merge gate.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime


def main() -> int:
    db_url = os.environ.get("YUANTUS_DATABASE_URL")
    if not db_url:
        print("seed_yuantus: YUANTUS_DATABASE_URL must be set", file=sys.stderr)
        return 2

    # Register every ORM model so create_all builds the full schema and FK targets resolve.
    from sqlalchemy import create_engine
    from yuantus.meta_engine.bootstrap import import_all_models
    from yuantus.models.base import Base, WorkflowBase

    import_all_models()
    # Core `users` table is an FK target (e.g. meta_effectivities.created_by_id) that
    # import_all_models does not pull in — init_db imports it explicitly, so we must too.
    import yuantus.models.user as _user  # noqa: F401
    # Identity models live under the same Base but are imported by init_identity_db, not by
    # import_all_models — pull them in explicitly so their tables are created in the shared file.
    import yuantus.security.auth.models as _auth_models  # noqa: F401
    import yuantus.security.auth.sso_models as _sso_models  # noqa: F401

    from sqlalchemy.orm import sessionmaker

    from yuantus.security.auth.models import (
        AuthUser,
        OrgMembership,
        Organization,
        Tenant,
    )
    from yuantus.security.auth.models import AuthCredential
    from yuantus.security.auth.passwords import hash_password
    from yuantus.security.rbac.models import RBACUser
    from yuantus.meta_engine.models.meta_schema import ItemType
    from yuantus.meta_engine.models.item import Item
    from yuantus.meta_engine.permission.models import Access, Permission
    from yuantus.meta_engine.app_framework.store_models import AppLicense
    from yuantus.meta_engine.discussion.models import (
        DiscussionThread,
        THREAD_STATUS_OPEN,
        THREAD_STATUS_RESOLVED,
    )

    TENANT = "default"
    ORG = "org-1"
    USER_ID = 42
    USER_NAME = "u42"
    USER_PASSWORD = "e2e-pw-42"  # seeded so the HTTP mint route can be reached via a real login
    PART = "item-1"
    PART_OTHER = "item-ro"
    BOM_LINE_TYPE = "Part BOM"  # the mint route checks GET permission on this type too

    # Plain engine with FK enforcement OFF — mirrors the provider's own read-gate test fixture
    # (`test_discussion_router.py::db`), whose seeding order these rows follow. The live uvicorn uses
    # its own FK-enforcing engine for its runtime writes; the seed just needs the rows present.
    url = db_url[len("sqlite:///"):] if db_url.startswith("sqlite:///") else db_url
    engine = create_engine(
        f"sqlite:///{url}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(bind=engine, checkfirst=True)
    WorkflowBase.metadata.create_all(bind=engine, checkfirst=True)

    Session = sessionmaker(bind=engine, expire_on_commit=False)
    s = Session()
    try:
        # Identity: the REAL get_current_user path needs an AuthUser + an active OrgMembership
        # (AuthService.get_roles_for_user_org), not just an RBACUser.
        s.merge(AuthUser(id=USER_ID, tenant_id=TENANT, username=USER_NAME, email="u42@x.io"))
        s.merge(RBACUser(id=USER_ID, user_id=USER_ID, username=USER_NAME, is_active=True))
        # A password credential so the E2E can log in via the REAL POST /api/v1/auth/login and
        # then call the REAL mint route (P2-1) — not the direct mint service.
        s.merge(AuthCredential(user_id=USER_ID, password_hash=hash_password(USER_PASSWORD)))
        s.merge(Tenant(id=TENANT))
        s.merge(Organization(id=ORG, tenant_id=TENANT))
        s.merge(
            OrgMembership(
                tenant_id=TENANT, org_id=ORG, user_id=USER_ID, roles=[], is_active=True
            )
        )

        # Surgical world GET grant so the mint route's permission checks (Part + Part BOM, action
        # get) pass — check_permission returns False for a type with no permission set, so this is
        # required to reach the real mint. It grants ONLY get; it does NOT touch the discussion read
        # gate (that is credential/part-scoped, not MetaPermissionService-gated), so the negative
        # read cases still fail closed.
        s.merge(Permission(id="perm-world-get", name="world get"))
        s.merge(
            Access(
                id="perm-world-get:world",
                permission_id="perm-world-get",
                identity_id="world",
                can_get=True,
                can_update=False,
            )
        )

        # A readable Part item (the bound part) + a second Part used only as an off-part target.
        # The BOM-line type must exist + be gettable for the mint route's second permission check.
        s.merge(ItemType(id="Part", label="Part", is_versionable=True, permission_id="perm-world-get"))
        s.merge(ItemType(id=BOM_LINE_TYPE, label=BOM_LINE_TYPE, permission_id="perm-world-get"))
        s.merge(
            Item(
                id=PART,
                item_type_id="Part",
                config_id=PART,
                generation=1,
                is_current=True,
                state="active",
                created_by_id=USER_ID,
            )
        )
        s.merge(
            Item(
                id=PART_OTHER,
                item_type_id="Part",
                config_id=PART_OTHER,
                generation=1,
                is_current=True,
                state="active",
                created_by_id=USER_ID,
            )
        )

        # The READ entitlement SKU (base review key `metasheet_review` -> app `plm.metasheet_review`),
        # active for the tenant. Re-checked per read by the route gate.
        s.merge(
            AppLicense(
                id="lic-msr-read",
                app_name="plm.metasheet_review",
                license_key="k-msr-read",
                status="Active",
                tenant_id=TENANT,
            )
        )
        # The mint route gates on is_entitled("bom_multitable") -> app `plm.bom_multitable`.
        s.merge(
            AppLicense(
                id="lic-bom-multitable",
                app_name="plm.bom_multitable",
                license_key="k-bom-mt",
                status="Active",
                tenant_id=TENANT,
            )
        )

        # Threads on the bound part: one OPEN + one RESOLVED. The relay's read list sends a fixed
        # include_resolved=true, so BOTH must come back — the E2E asserts the resolved one is present.
        s.merge(
            DiscussionThread(
                id="T-open-1",
                tenant_id=TENANT,
                org_id=ORG,
                target_type="item",
                target_id=PART,
                title="open thread",
                status=THREAD_STATUS_OPEN,
                created_by_id=USER_ID,
                comment_count=0,
            )
        )
        s.merge(
            DiscussionThread(
                id="T-resolved-1",
                tenant_id=TENANT,
                org_id=ORG,
                target_type="item",
                target_id=PART,
                title="resolved thread",
                status=THREAD_STATUS_RESOLVED,
                created_by_id=USER_ID,
                resolved_by_id=USER_ID,
                resolved_at=datetime.utcnow(),
                comment_count=0,
            )
        )
        # A thread on ANOTHER part (for the cross-Part detail 404 case).
        s.merge(
            DiscussionThread(
                id="T-otherpart-1",
                tenant_id=TENANT,
                org_id=ORG,
                target_type="item",
                target_id=PART_OTHER,
                title="off-part thread",
                status=THREAD_STATUS_OPEN,
                created_by_id=USER_ID,
                comment_count=0,
            )
        )
        # A thread in a DIFFERENT tenant whose target_id COLLIDES with the bound part (for the
        # provider-side cross-tenant 404: the tenant-scoped lookup must never surface it).
        s.merge(
            DiscussionThread(
                id="T-foreign-tenant-1",
                tenant_id="other-tenant",
                org_id="other-org",
                target_type="item",
                target_id=PART,
                title="foreign tenant thread",
                status=THREAD_STATUS_OPEN,
                created_by_id=USER_ID,
                comment_count=0,
            )
        )

        s.commit()
    finally:
        s.close()

    print("seed_yuantus: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
