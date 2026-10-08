import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Transfer MVP — T1 (schema), Canonical Org & Provider Transfer v1 sequencing plan §2 row T1;
 * data model per `provider-org-transfer-development-plan-20260709.md` §7.1/§7.2.
 *
 * `provider_org_transfers` is the explicit transfer record (never ad-hoc JSON on integration
 * rows, and NEVER a direct `corp_id` edit — §12.1 made corp_id immutable). Two schema-level
 * guarantees are borrowed from the B4 binding-table doctrine (constraints in the schema, not
 * service convention):
 *
 *   - **Cross-org transfer is FK-impossible**: the row carries ONE `org_id` column and BOTH
 *     integration ids are FK'd to `directory_integrations (id, org_id)` against that same
 *     column. A source in org A and a target in org B leaves no satisfying `org_id` value.
 *     (Holds because every FK-participating column is NOT NULL — MATCH SIMPLE would skip the
 *     check on any NULL.)
 *   - **Provider mismatch is FK-impossible**: both integration ids are also FK'd to
 *     `directory_integrations (id, provider)` against the row's single `provider` column, so
 *     both ends must BE the transfer's provider; `CHECK (provider <> 'local')` additionally
 *     rules out a local end (a transfer moves between EXTERNAL provider tenants — the local
 *     canonical org is the anchor that never moves).
 *
 * Transfer FKs are deliberately NOT ON DELETE CASCADE (unlike B4's bindings): a transfer row is
 * an auditable history record referencing two integrations; default NO ACTION blocks a hard
 * integration delete while transfer history references it (archive-not-delete makes this rare).
 *
 * The "at most one ACTIVE transfer per source integration" rule (§7.1) is a partial unique
 * index over non-terminal statuses — it also caps the per-pair rule. `dry_run_at` is additive
 * to §7.1: §12.3 (dry-run required) needs a durable "a dry-run happened since the last scan"
 * marker the apply guard can check; scan clears it.
 *
 * The two parent-side UNIQUE constraints referenced here were introduced by the B4 migration
 * (`zzzz20260717100000`); the guarded ADD CONSTRAINT blocks are repeated verbatim so this
 * migration is also self-sufficient in isolated schemas that replay a subset (probe pinned to
 * conname + conrelid + contype, mirroring B4). `directory_integrations` is created by a zzzz
 * migration, so this MUST also be zzzz-prefixed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'uq_directory_integrations_id_org'
           AND conrelid = 'directory_integrations'::regclass
           AND contype = 'u'
      ) THEN
        ALTER TABLE directory_integrations
        ADD CONSTRAINT uq_directory_integrations_id_org UNIQUE (id, org_id);
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'uq_directory_integrations_id_provider'
           AND conrelid = 'directory_integrations'::regclass
           AND contype = 'u'
      ) THEN
        ALTER TABLE directory_integrations
        ADD CONSTRAINT uq_directory_integrations_id_provider UNIQUE (id, provider);
      END IF;
    END $$;
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS provider_org_transfers (
      id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
      org_id                 text        NOT NULL,
      provider               text        NOT NULL,
      source_integration_id  uuid        NOT NULL,
      target_integration_id  uuid        NOT NULL,
      source_tenant_key      text,
      target_tenant_key      text,
      status                 text        NOT NULL DEFAULT 'draft',
      freeze_source_sync     boolean     NOT NULL DEFAULT true,
      dry_run_stats          jsonb       NOT NULL DEFAULT '{}'::jsonb,
      dry_run_at             timestamptz,
      -- §7.1 sketches uuid here, but this codebase's users.id is TEXT — created_by records the
      -- acting platform admin's user id, so it must match that type.
      created_by             text,
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now(),
      scanned_at             timestamptz,
      applied_at             timestamptz,
      cancelled_at           timestamptz,
      last_error             text,

      CONSTRAINT provider_org_transfers_pkey PRIMARY KEY (id),

      CONSTRAINT pot_status_chk CHECK (status IN ('draft', 'scanned', 'applying', 'applied', 'cancelled', 'failed')),
      CONSTRAINT pot_distinct_ends_chk CHECK (source_integration_id <> target_integration_id),
      CONSTRAINT pot_provider_not_local_chk CHECK (provider <> 'local'),

      CONSTRAINT pot_source_org_fk FOREIGN KEY (source_integration_id, org_id)
        REFERENCES directory_integrations (id, org_id),
      CONSTRAINT pot_target_org_fk FOREIGN KEY (target_integration_id, org_id)
        REFERENCES directory_integrations (id, org_id),

      CONSTRAINT pot_source_provider_fk FOREIGN KEY (source_integration_id, provider)
        REFERENCES directory_integrations (id, provider),
      CONSTRAINT pot_target_provider_fk FOREIGN KEY (target_integration_id, provider)
        REFERENCES directory_integrations (id, provider)
    )
  `.execute(db)

  // At most one ACTIVE (non-terminal) transfer per source integration; this also caps the
  // per-(source,target) pair rule. 'applied' and 'cancelled' are the two terminal statuses.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pot_active_source
    ON provider_org_transfers (source_integration_id)
    WHERE status NOT IN ('applied', 'cancelled')
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_pot_org ON provider_org_transfers (org_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_pot_target ON provider_org_transfers (target_integration_id)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS provider_org_transfer_decisions (
      id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
      transfer_id         uuid        NOT NULL,
      binding_kind        text        NOT NULL,
      source_anchor_type  text        NOT NULL,
      source_anchor_id    text        NOT NULL,
      source_handle       jsonb       NOT NULL DEFAULT '{}'::jsonb,
      proposed_target     jsonb       NOT NULL DEFAULT '{}'::jsonb,
      decision            text        NOT NULL DEFAULT 'pending',
      apply_status        text        NOT NULL DEFAULT 'pending',
      -- text for the same users.id-type reason as provider_org_transfers.created_by.
      decided_by          text,
      decided_at          timestamptz,
      applied_at          timestamptz,
      apply_attempts      integer     NOT NULL DEFAULT 0,
      last_error          text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT provider_org_transfer_decisions_pkey PRIMARY KEY (id),

      CONSTRAINT potd_transfer_fk FOREIGN KEY (transfer_id)
        REFERENCES provider_org_transfers (id) ON DELETE CASCADE,

      CONSTRAINT potd_decision_chk CHECK (decision IN ('pending', 'rebind', 'drop', 'skip')),
      CONSTRAINT potd_apply_status_chk CHECK (apply_status IN ('pending', 'applied', 'failed', 'skipped')),

      CONSTRAINT potd_anchor_uniq UNIQUE (transfer_id, binding_kind, source_anchor_type, source_anchor_id)
    )
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Decisions first (FK), then transfers. The two parent UNIQUE constraints on
  // directory_integrations are owned by the B4 migration's down() — not dropped here.
  await sql`DROP TABLE IF EXISTS provider_org_transfer_decisions`.execute(db)
  await sql`DROP TABLE IF EXISTS provider_org_transfers`.execute(db)
}
