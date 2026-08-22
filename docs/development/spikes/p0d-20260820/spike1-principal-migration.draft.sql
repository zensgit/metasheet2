-- =====================================================================
-- SPIKE 1 (DRAFT — DO NOT RUN) — service_principals + writer_grants
-- Baseline: main @ c5a4a94f7 (frozen).  Design spike only.
--
-- This file lives under docs/development/spikes/, NOT the real migrations
-- dir (packages/core-backend/src/db/migrations). It is illustrative and
-- idempotent so it can be dry-read / linted, but it is NOT wired into the
-- Kysely migration runner.
--
-- Grounding (frozen baseline):
--   * multitable_api_tokens.revoked_at ......... revoke precedent
--       (zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts:16-17)
--   * meta_record_revisions.actor_id text (no FK) intentionally left as-is
--       (zzzz20260430172000_create_meta_record_revisions.ts:15)
--   * meta_bases.owner_id/workspace_id, data_sources.owner_id/workspace_id
--       are the current (unenforced) tenant analog.
--   * DataSourceManager.assertAccess ignores workspaceId (DataSourceManager.ts:380)
--       -> motivation for a DB-enforced tenant FK below.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid(), matches existing migrations

-- ---------------------------------------------------------------------
-- 1) service_principals — the unified non-human identity registry.
--    Reverse-FK target. Never physically deleted; retired via revoked_at.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_principals (
    id           uuid        NOT NULL DEFAULT gen_random_uuid(),
    -- tenant_id is opaque text for the spike (reconcile with workspace_id /
    -- shard tenantId later — see ADR open question 1). NOT NULL: every
    -- principal is tenant-scoped, no global principals.
    tenant_id    text        NOT NULL,
    kind         text        NOT NULL
                             CHECK (kind IN ('automation','integration','connector','system_migration','service')),
    display_name text        NOT NULL,
    -- Soft-revoke. NULL = active. Mirrors multitable_api_tokens.revoked_at.
    -- Revocation kills AUTHORITY, never IDENTITY/HISTORY.
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    created_by   text,

    CONSTRAINT service_principals_pkey PRIMARY KEY (id),

    -- Composite UNIQUE exists ONLY to be the target of the composite FK
    -- below. It is logically redundant (id is already unique) but is what
    -- lets a child row pin BOTH id AND tenant_id in a single reference.
    CONSTRAINT service_principals_id_tenant_uniq UNIQUE (id, tenant_id)
);

-- id is never reused. UUID default makes accidental reuse effectively
-- impossible; deliberate reuse is forbidden by policy (ADR 2.4).
CREATE INDEX IF NOT EXISTS idx_service_principals_tenant
    ON service_principals (tenant_id);
CREATE INDEX IF NOT EXISTS idx_service_principals_kind
    ON service_principals (tenant_id, kind);
-- Fast audit resolution: meta_record_revisions.actor_id (text) -> principal.
-- Advisory only; there is deliberately NO FK from revisions (history must
-- never be breakable by a principal state change).
CREATE INDEX IF NOT EXISTS idx_service_principals_id_text
    ON service_principals ((id::text));

-- ---------------------------------------------------------------------
-- 2) writer_grants — a binding that authorizes a principal to write a
--    target. Reverse FK: the grant points INTO service_principals.
--    Carries its OWN tenant_id so the composite FK can enforce that a
--    grant and its principal share a tenant.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS writer_grants (
    id            uuid        NOT NULL DEFAULT gen_random_uuid(),
    tenant_id     text        NOT NULL,
    principal_id  uuid        NOT NULL,           -- single-valued: 1 grant -> exactly 1 principal
    -- What the grant authorizes writing. Opaque for the spike (e.g. a
    -- base_id / sheet_id). One principal MAY hold many grants (1:N).
    target_kind   text        NOT NULL
                             CHECK (target_kind IN ('base','sheet','data_source')),
    target_id     text        NOT NULL,
    revoked_at    timestamptz,                    -- delete-binding == revoke, not physical delete
    created_at    timestamptz NOT NULL DEFAULT now(),
    created_by    text,

    CONSTRAINT writer_grants_pkey PRIMARY KEY (id),

    -- === TENANT-CONSISTENCY GUARANTEE (composite FK) ===================
    -- A grant can only reference a principal in the SAME tenant. If
    -- (principal_id, tenant_id) has no matching (id, tenant_id) parent,
    -- PostgreSQL REJECTS the write. Cross-tenant grant is impossible at
    -- the storage layer, no app check required.
    CONSTRAINT writer_grants_principal_tenant_fkey
        FOREIGN KEY (principal_id, tenant_id)
        REFERENCES service_principals (id, tenant_id)
        ON DELETE RESTRICT,     -- principals are never hard-deleted anyway

    -- One active binding per (principal, target). Revoked rows excluded so
    -- a target can be re-granted after revocation without collision.
    CONSTRAINT writer_grants_active_uniq
        UNIQUE (tenant_id, principal_id, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_writer_grants_principal
    ON writer_grants (principal_id);
CREATE INDEX IF NOT EXISTS idx_writer_grants_target
    ON writer_grants (tenant_id, target_kind, target_id)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- 3) Rebinding forbidden — principal_id is immutable on a grant.
--    To "move" a grant: revoke it and create a new one (auditable break),
--    never silently re-point (ADR 2.3).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION writer_grants_forbid_rebind()
RETURNS trigger AS $$
BEGIN
    IF NEW.principal_id <> OLD.principal_id THEN
        RAISE EXCEPTION
            'writer_grants.principal_id is immutable (rebinding forbidden); revoke and re-create instead';
    END IF;
    -- tenant_id is likewise immutable (would break the composite-FK invariant).
    IF NEW.tenant_id <> OLD.tenant_id THEN
        RAISE EXCEPTION 'writer_grants.tenant_id is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_writer_grants_forbid_rebind ON writer_grants;
CREATE TRIGGER trg_writer_grants_forbid_rebind
    BEFORE UPDATE ON writer_grants
    FOR EACH ROW EXECUTE FUNCTION writer_grants_forbid_rebind();

-- ---------------------------------------------------------------------
-- DOWN (draft, for symmetry — not executed):
--   DROP TRIGGER IF EXISTS trg_writer_grants_forbid_rebind ON writer_grants;
--   DROP FUNCTION IF EXISTS writer_grants_forbid_rebind();
--   DROP TABLE IF EXISTS writer_grants;      -- child first (composite FK)
--   DROP TABLE IF EXISTS service_principals;
-- ---------------------------------------------------------------------

-- =====================================================================
-- ACCEPTANCE (illustrated as comments — how the constraints behave):
--
-- (A) Cross-tenant FK rejected:
--   INSERT INTO service_principals (id, tenant_id, kind, display_name)
--     VALUES ('11111111-1111-1111-1111-111111111111','tenantA','connector','c');
--   INSERT INTO writer_grants (tenant_id, principal_id, target_kind, target_id)
--     VALUES ('tenantB','11111111-1111-1111-1111-111111111111','base','b1');
--   -> ERROR: insert or update on table "writer_grants" violates foreign key
--      constraint "writer_grants_principal_tenant_fkey"   (tenant mismatch)
--
-- (B) Revoke -> new grants fail, history still resolves:
--   UPDATE service_principals SET revoked_at = now() WHERE id = '1111...';
--   -- authorization is evaluated in app/pure logic (see prototype): a
--   -- revoked principal denies new writes. But:
--   SELECT display_name FROM service_principals WHERE id::text = <old actor_id>;
--   -- still returns the row (never deleted) -> historical revision resolves.
--
-- (C) Principal id non-reuse:
--   ids are gen_random_uuid(); rows are soft-revoked, never deleted, so an
--   id is never freed for reuse. Old meta_record_revisions.actor_id values
--   keep pointing at the same immutable identity.
-- =====================================================================
