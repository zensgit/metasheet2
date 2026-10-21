import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * 客户反馈 2026-09-24 #4a — keep the `stock-prep:admin` DESCRIPTION honest.
 *
 * The seed (zzzz20260830100000_add_stock_prep_permissions) described the code as
 * "Workbench-scoped stock-preparation administration (no provisioning, no pack install)". The
 * managed-table relabel (「把系统表的英文表头改成中文」) adds ONE write to that tier: renaming
 * still-English managed-table headers to their template Chinese names, compare-and-set, behind the
 * default-OFF operator switch MULTITABLE_MANAGED_TABLE_RELABEL_ENABLED. An administrator deciding
 * whom to grant the code must read that in the role editor, not discover it later — and the seed
 * used ON CONFLICT DO NOTHING, so editing the seed text could never reach an existing deployment.
 *
 * COMPARE-AND-SET, both ways: up() rewrites the row only while it still carries the seed's text, and
 * down() restores the seed text only while the row carries this migration's text. An administrator
 * who already edited the description by hand keeps their wording in both directions. No code, name,
 * role binding or grant is touched. The new text is byte-identical to the descriptor in
 * plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs (a plugin suite pins
 * the two against each other).
 */

export const STOCK_PREP_ADMIN_DESCRIPTION_BEFORE =
  'Workbench-scoped stock-preparation administration (no provisioning, no pack install)'
export const STOCK_PREP_ADMIN_DESCRIPTION_AFTER =
  'Workbench-scoped stock-preparation administration (no provisioning, no pack install; may relabel still-English managed-table headers to their Chinese template names when the operator switch is on)'

async function swapDescription(db: Kysely<unknown>, from: string, to: string): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'permissions'
      ) THEN
        UPDATE permissions
        SET description = ${sql.lit(to)}
        WHERE code = 'stock-prep:admin' AND description = ${sql.lit(from)};
      END IF;
    END $$;
  `.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await swapDescription(db, STOCK_PREP_ADMIN_DESCRIPTION_BEFORE, STOCK_PREP_ADMIN_DESCRIPTION_AFTER)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await swapDescription(db, STOCK_PREP_ADMIN_DESCRIPTION_AFTER, STOCK_PREP_ADMIN_DESCRIPTION_BEFORE)
}
