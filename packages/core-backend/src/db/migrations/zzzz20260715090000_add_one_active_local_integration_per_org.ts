import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Canonical Org MVP — B1 (local-provider bootstrap), #4215 §5.1.
 *
 * Enforce "at most one ACTIVE local directory integration per org" in the DB, not by service
 * convention: a partial unique index on `directory_integrations(org_id)` scoped to
 * `provider = 'local' AND status = 'active'`. Two concurrent `getOrCreateLocalIntegration`
 * calls for the same org can therefore never both create a row — the loser gets a
 * unique-violation (23505) and re-reads the winner (see directory-sync.ts).
 *
 * "At least one" is deliberately NOT enforced here — that is the bootstrap service's
 * responsibility (create-on-first-use); a partial unique index can only cap the upper bound.
 *
 * `directory_integrations` was created by a zzzz migration
 * (`zzzz20260324150000_create_directory_sync_tables.ts`), so this index addition MUST also be a
 * zzzz-prefixed TS migration — a plain 0xx SQL migration would run before the table exists and
 * silently no-op (same rule as the sibling `schedule_timezone` / run-lease additions).
 *
 * IF NOT EXISTS keeps it idempotent on replay. Existing rows are unaffected: no production org
 * has a `provider='local'` integration yet (this milestone introduces the concept), so the
 * partial predicate matches nothing at creation time and the index cannot conflict with any
 * current data.
 *
 * Owner round P2-1: `local_integration_corp_id_shape` — a CHECK constraint proving the
 * `corp_id = 'local:' || org_id` CONSISTENCY RELATION for every `provider = 'local'` row. This is
 * NOT full corp_id immutability by itself (a single UPDATE that rewrites BOTH `org_id` and
 * `corp_id` together, keeping the relation, still passes the CHECK) — see the corrected comment
 * on `getOrCreateLocalIntegration` in directory-sync.ts for the full two-half guarantee. Postgres
 * has no `ADD CONSTRAINT IF NOT EXISTS`, so idempotency is a `pg_constraint` existence probe
 * (mirrors `zzzz20260422225000_add_dingtalk_person_delivery_status.ts`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_local_integration_per_org
    ON directory_integrations (org_id)
    WHERE provider = 'local' AND status = 'active'
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'local_integration_corp_id_shape'
           -- conname is NOT database-unique: a same-named constraint on ANY other table would
           -- make a bare-conname probe falsely report "already installed" and silently skip
           -- adding the CHECK here. Pin the probe to this table and to CHECK constraints.
           AND conrelid = 'directory_integrations'::regclass
           AND contype = 'c'
      ) THEN
        ALTER TABLE directory_integrations
        ADD CONSTRAINT local_integration_corp_id_shape
        CHECK (provider <> 'local' OR corp_id = 'local:' || org_id);
      END IF;
    END $$;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE directory_integrations
    DROP CONSTRAINT IF EXISTS local_integration_corp_id_shape
  `.execute(db)

  await sql`DROP INDEX IF EXISTS one_active_local_integration_per_org`.execute(db)
}
