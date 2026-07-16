import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Canonical Org MVP — B3 (normalized manager relation), #4215 §5.4.
 *
 * The manager/department-head link becomes a FIRST-CLASS, provider-neutral relation instead of
 * living hidden inside a provider's raw JSON (`directory_accounts.raw.leader_in_dept`). Owner
 * ruling (Wave 3, 2026-07-12): approval routing must read product truth, not parse provider raw.
 * This adds the typed flag on the membership row — `is_manager = true` on
 * `directory_account_departments(account = M, department = D)` means "M is a manager/leader of
 * department D", the same per-department semantic DingTalk models as `leader_in_dept`, now lifted
 * into a queryable column an admin can set on a LOCAL org.
 *
 * `directory_account_departments` was created by a zzzz migration
 * (`zzzz20260324150000_create_directory_sync_tables.ts`), so this addition MUST also be a
 * zzzz-prefixed TS migration — a plain 0xx SQL migration would run before the table exists and
 * silently no-op (same ordering rule as the sibling B1 index / schedule_timezone additions).
 *
 * DEFAULT false is load-bearing for the DingTalk bit-identical guarantee: the DingTalk sync
 * writer never sets this column, so every provider-synced membership row keeps `is_manager =
 * false`, which makes `ApprovalDirectoryOrg`'s dual-source resolver fall through to the existing
 * `raw.leader_in_dept` path for those integrations (see the resolver comment). The flag is
 * populated for LOCAL rows only, via `setLocalMembershipManager`.
 *
 * IF NOT EXISTS on both the column and the index keeps replay idempotent. No backfill is needed:
 * the column is added with `DEFAULT false`, and `false` is the correct value for every existing
 * row regardless of provider — `is_manager` only ever becomes `true` through the new B3 writer
 * (`setLocalMembershipManager`), which no pre-B3 row could have gone through.
 *
 * Index: the resolver looks up managers by department filtered to `is_manager = true`
 * (`... WHERE d.external_department_id = $2 AND ad.is_manager = true`). A partial index keyed on
 * `directory_department_id WHERE is_manager` keeps that lookup cheap and the index tiny — it holds
 * only the (few) manager rows, not every membership.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE directory_account_departments
    ADD COLUMN IF NOT EXISTS is_manager boolean NOT NULL DEFAULT false
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_directory_account_departments_manager_by_dept
    ON directory_account_departments (directory_department_id)
    WHERE is_manager
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_directory_account_departments_manager_by_dept`.execute(db)
  await sql`
    ALTER TABLE directory_account_departments
    DROP COLUMN IF EXISTS is_manager
  `.execute(db)
}
