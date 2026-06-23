/**
 * Migration: approval delegation (委托) config store
 *
 * Purpose: persist time-boxed delegations so a delegator's resolved approval
 * assignments route to a delegatee. The runtime is read-only at resolve time —
 * active delegations are frozen into the instance snapshot at create and applied
 * inside ApprovalAssigneeResolver.pushResolved; this table is the config source.
 * Tables: approval_delegations (new).
 * Breaking: No — new table, additive.
 */

import { sql, type Kysely } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'approval_delegations')
  if (exists) return

  await sql`
    CREATE TABLE IF NOT EXISTS approval_delegations (
      id TEXT PRIMARY KEY,
      delegator_user_id TEXT NOT NULL,
      delegatee_user_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'all',
      scope_template_id TEXT,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_approval_delegations_window CHECK (end_at > start_at),
      CONSTRAINT chk_approval_delegations_not_self CHECK (delegator_user_id <> delegatee_user_id),
      CONSTRAINT chk_approval_delegations_scope CHECK (scope IN ('all', 'template')),
      -- Bidirectional: scope='template' REQUIRES a target, and scope='all' REQUIRES
      -- scope_template_id IS NULL (an 'all' row with a stray target would be ambiguous,
      -- since resolveActiveDelegationMap ignores scope_template_id for 'all' rows).
      CONSTRAINT chk_approval_delegations_scope_target
        CHECK ((scope = 'template') = (scope_template_id IS NOT NULL))
    )
  `.execute(db)

  // v1 semantics: at most ONE active delegation per (delegator, scope target) — i.e.
  // "one enabled row per scope target", NOT time-range-overlap scheduling. Two active
  // rows are rejected even with non-overlapping future windows; multi-window scheduling
  // (range-overlap exclusion / CRUD overlap validation) is a reopen-only enhancement.
  // COALESCE keeps 'all'-scope rows unique without a partial-null collision.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_delegations_active
      ON approval_delegations (delegator_user_id, scope, COALESCE(scope_template_id, ''))
      WHERE active
  `.execute(db)

  // Resolve-time lookup: active delegations matching a template + the create instant.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_delegations_lookup
      ON approval_delegations (active, scope, scope_template_id, start_at, end_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS approval_delegations`.execute(db)
}
