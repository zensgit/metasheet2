import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Canonical Org MVP — B4 (department binding table), #4215 §5.5.
 *
 * `directory_department_bindings` binds a LOCAL department to an external-provider (e.g. DingTalk)
 * department so routing/reconciliation can resolve across the canonical local org and a provider
 * directory. The owner design goal is that a **cross-org binding is impossible to INSERT** — not
 * enforced by service convention, but by a BUILDABLE FK CHAIN in the schema itself.
 *
 * How the chain makes cross-org FK-impossible: the binding carries a SINGLE `org_id` column, and
 * BOTH integration ids are FK'd to `directory_integrations (id, org_id)` against that same column.
 * A binding whose local integration lives in org A and remote integration lives in org B therefore
 * has NO satisfying `org_id` value — `org_id = A` fails the remote FK, `org_id = B` fails the local
 * FK — so the row cannot be inserted. (Postgres composite FKs are MATCH SIMPLE, so this only holds
 * because every FK-participating column is NOT NULL: a NULL in any of them would skip the FK check
 * entirely and let a cross-org row slip past. All seven such columns are NOT NULL below.)
 *
 * provider-role (one side local, the other a provider) is likewise FK-enforced, not triggered: the
 * binding carries redundant `local_provider`/`remote_provider` columns, each FK'd to
 * `directory_integrations (id, provider)`, plus a CHECK that local_provider='local' AND
 * remote_provider<>'local'. So the local side must be a `provider='local'` integration and the
 * remote side must not be — with no trigger.
 *
 * Each department is pinned to its own integration AND to the role's provider via the THREE-column
 * `(department_id, integration_id, provider) -> directory_departments (id, integration_id,
 * provider)` (owner P2 round): the integration-level provider FKs alone say nothing about the
 * DEPARTMENT row's own `provider` column, so a provider-mislabeled department under a
 * correctly-labeled integration — the malformed-but-real shape B3/PB4-2 already treat as existing
 * and reject on their write paths — could otherwise occupy either side of a binding. The provider
 * leg closes that: dept.provider must equal the binding's role provider.
 *
 * The three parent-side UNIQUE constraints this needs — `directory_integrations (id, org_id)`,
 * `directory_integrations (id, provider)`, `directory_departments (id, integration_id, provider)` — are all
 * REDUNDANT supersets of an existing primary key (`id` is already unique), so they reject no
 * existing row and are safe to add; a composite FK requires a real UNIQUE CONSTRAINT on exactly the
 * referenced columns (a plain unique INDEX is not referenceable), which is why they are ADD
 * CONSTRAINT, not CREATE UNIQUE INDEX.
 *
 * ON DELETE CASCADE on every FK matches the existing `directory_departments`/`directory_accounts`
 * → integration cascade: a binding is meaningless once either referenced integration or department
 * is hard-deleted. Archive-not-delete means this rarely fires; when a real delete happens the
 * binding is removed rather than left dangling. Multiple cascade paths to one binding row (via the
 * integration and via its department) are fine — Postgres deletes the row once.
 *
 * `status` is 'active' | 'stale' for the B7 suggest-only reconciliation (a vanished external
 * department marks its binding 'stale', never deactivating the local department).
 *
 * `directory_integrations`/`directory_departments` are created by a zzzz migration, so this MUST
 * also be zzzz-prefixed (a plain 0xx SQL migration runs before those tables exist). Postgres has no
 * `ADD CONSTRAINT IF NOT EXISTS`, so each parent constraint is guarded by a `pg_constraint`
 * existence probe pinned to conname + conrelid + contype (a bare conname probe would false-positive
 * on a same-named constraint elsewhere — mirrors zzzz20260715090000). The table itself is
 * `CREATE TABLE IF NOT EXISTS` (atomic: all its inline constraints exist or none do), which keeps
 * the whole migration idempotent on replay.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1) Parent UNIQUE constraints the composite FKs reference (redundant supersets of the PKs).
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
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'uq_directory_departments_id_integration_provider'
           AND conrelid = 'directory_departments'::regclass
           AND contype = 'u'
      ) THEN
        ALTER TABLE directory_departments
        ADD CONSTRAINT uq_directory_departments_id_integration_provider UNIQUE (id, integration_id, provider);
      END IF;
    END $$;
  `.execute(db)

  // 2) The binding table + its buildable FK chain, provider-role CHECK, and status CHECK.
  await sql`
    CREATE TABLE IF NOT EXISTS directory_department_bindings (
      id                     uuid        NOT NULL DEFAULT gen_random_uuid(),
      org_id                 text        NOT NULL,
      local_integration_id   uuid        NOT NULL,
      local_department_id    uuid        NOT NULL,
      local_provider         text        NOT NULL,
      remote_integration_id  uuid        NOT NULL,
      remote_department_id   uuid        NOT NULL,
      remote_provider        text        NOT NULL,
      status                 text        NOT NULL DEFAULT 'active',
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT directory_department_bindings_pkey PRIMARY KEY (id),

      CONSTRAINT ddb_provider_role_chk CHECK (local_provider = 'local' AND remote_provider <> 'local'),
      CONSTRAINT ddb_status_chk        CHECK (status IN ('active', 'stale')),

      -- one binding per external/remote department
      CONSTRAINT ddb_remote_dept_uniq UNIQUE (remote_integration_id, remote_department_id),

      -- same-org chain: both integrations FK'd to the SAME org_id column => cross-org FK-impossible
      CONSTRAINT ddb_local_int_org_fk FOREIGN KEY (local_integration_id, org_id)
        REFERENCES directory_integrations (id, org_id) ON DELETE CASCADE,
      CONSTRAINT ddb_remote_int_org_fk FOREIGN KEY (remote_integration_id, org_id)
        REFERENCES directory_integrations (id, org_id) ON DELETE CASCADE,

      -- provider-role, FK-backed
      CONSTRAINT ddb_local_int_provider_fk FOREIGN KEY (local_integration_id, local_provider)
        REFERENCES directory_integrations (id, provider) ON DELETE CASCADE,
      CONSTRAINT ddb_remote_int_provider_fk FOREIGN KEY (remote_integration_id, remote_provider)
        REFERENCES directory_integrations (id, provider) ON DELETE CASCADE,

      -- each department belongs to its named integration AND carries the role's provider itself
      -- (owner P2: integration-level provider FKs alone do NOT constrain the DEPARTMENT row's own
      -- provider column — a provider-mislabeled department under a correctly-labeled integration
      -- (the malformed-but-real shape B3/PB4-2 already reject on their write paths) could otherwise
      -- occupy either side of a binding. The provider leg pins dept.provider = the binding's role.)
      CONSTRAINT ddb_local_dept_fk FOREIGN KEY (local_department_id, local_integration_id, local_provider)
        REFERENCES directory_departments (id, integration_id, provider) ON DELETE CASCADE,
      CONSTRAINT ddb_remote_dept_fk FOREIGN KEY (remote_department_id, remote_integration_id, remote_provider)
        REFERENCES directory_departments (id, integration_id, provider) ON DELETE CASCADE
    )
  `.execute(db)

  // Lookup index for the local side (the remote side is already covered by ddb_remote_dept_uniq).
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ddb_local_department
    ON directory_department_bindings (local_integration_id, local_department_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ddb_org
    ON directory_department_bindings (org_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop the table first (removes its FKs), then the redundant parent constraints.
  await sql`DROP TABLE IF EXISTS directory_department_bindings`.execute(db)
  await sql`ALTER TABLE directory_departments DROP CONSTRAINT IF EXISTS uq_directory_departments_id_integration_provider`.execute(db)
  await sql`ALTER TABLE directory_integrations DROP CONSTRAINT IF EXISTS uq_directory_integrations_id_provider`.execute(db)
  await sql`ALTER TABLE directory_integrations DROP CONSTRAINT IF EXISTS uq_directory_integrations_id_org`.execute(db)
}
