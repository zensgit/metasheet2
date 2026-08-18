import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists, createIndexIfNotExists } from './_patterns'

/**
 * Lock-1 §K1 / OD-L1-2(a) — CURATED PER-ORG BINDING TABLE for `user_group` assignee sources.
 *
 * `platform_member_groups` (`zzzz20260409154000_create_platform_member_groups_and_delegated_group_scopes.ts:11-26`)
 * has NO org column and a GLOBALLY UNIQUE name — it cannot itself answer "which org may this
 * approval template reference this group for". Rather than add `org_id` to that shipped table
 * (rejected OD-L1-2(b) — it is owned by the delegated-scope line and hand-created groups have no
 * authoritative backfill source) or trust the unconstrained free-text `description` projection
 * marker (rejected OD-L1-2(c) — a hand-created group can forge it), this EXTENDS the RA-1b
 * curated-vocabulary pattern (`roles.approval_usable`,
 * `zzzz20260627150000_add_approval_usable_to_roles.ts`) to an approver kind: a dedicated
 * association table, EMPTY BY DEFAULT (secure-by-default — no group is publish-usable until an
 * admin explicitly binds it), re-validated at publish on the publishing transaction's client
 * (`assertUserGroupSourcesBoundToOrg` in ApprovalProductService.ts).
 *
 * `org_id` is a free-text scope id (NOT a foreign key — no `orgs` table exists in this codebase;
 * mirrors the `org_id TEXT NOT NULL DEFAULT 'default'` idiom used across
 * `directory_integrations`/`attendance_groups`/etc.). The publishing request's `orgId` (optional,
 * defaults to `'default'` — see `PublishApprovalTemplateRequest.orgId`) is checked against this
 * table's rows for the SAME `org_id`; a `user_group` source referencing a group with no row for
 * that org — dangling (no binding at all) or foreign (bound to a DIFFERENT org only) — fails
 * publish 400, never at dispatch (§K1 / §2.2).
 *
 * Shape mirrors the shipped `delegated_role_scope_template_member_groups(template_id, group_id)`
 * association table (same migration file) byte-for-byte, with `org_id TEXT` standing in for
 * `template_id UUID`. Composite PK `(org_id, group_id)` — one binding row per (org, group) pair;
 * re-binding is idempotent (`ON CONFLICT DO NOTHING` at the write site, not here).
 *
 * Idempotent: guarded by `checkTableExists` so re-runs and environments where
 * `platform_member_groups` has not yet been created are safe. DDL only — no data backfill, no
 * flag, no runtime authorization (§1 Non-effects — this migration is mergeable/deployable but the
 * curated set starts and stays empty until an admin explicitly binds a group via the curated
 * bind/unbind path).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const memberGroupsExists = await checkTableExists(db, 'platform_member_groups')
  if (!memberGroupsExists) return

  const bindingExists = await checkTableExists(db, 'approval_usable_member_groups')
  if (!bindingExists) {
    await db.schema
      .createTable('approval_usable_member_groups')
      .ifNotExists()
      .addColumn('org_id', 'text', (col) => col.notNull())
      .addColumn('group_id', 'uuid', (col) => col.notNull().references('platform_member_groups.id').onDelete('cascade'))
      .addColumn('created_by', 'text', (col) => col.references('users.id').onDelete('set null'))
      .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
      .execute()
  }

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'approval_usable_member_groups_pkey'
          AND conrelid = 'approval_usable_member_groups'::regclass
      ) THEN
        ALTER TABLE approval_usable_member_groups
        ADD PRIMARY KEY (org_id, group_id);
      END IF;
    END $$;
  `.execute(db)

  await createIndexIfNotExists(
    db,
    'idx_approval_usable_member_groups_group_id',
    'approval_usable_member_groups',
    'group_id',
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('approval_usable_member_groups').ifExists().cascade().execute()
}
