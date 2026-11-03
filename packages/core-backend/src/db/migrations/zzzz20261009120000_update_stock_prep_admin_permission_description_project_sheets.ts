import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * S1 of ADR adr-stock-prep-project-sheets-20261008 (decision register R-35) — keep the
 * `stock-prep:admin` DESCRIPTION honest, second round.
 *
 * zzzz20260927120000 rewrote the seed's text to mention the relabel write. That text still opened
 * with "no provisioning", which was true of R-11 and is no longer true of the ladder: the ADMIN tier
 * short-circuits into the PULL tier (`satisfiesStockPrepAccess`), and S1 gives a 拉取人员 ONE
 * provisioning verb — `POST /api/integration/stock-preparation/projects/:projectNo/target` creates a
 * per-project sheet from the frozen template, with every identifier derived server-side, an empty
 * request body, a 200-row cap and an audit row, behind the default-OFF switch
 * MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED. An administrator deciding whom to grant the code
 * must read that in the role editor, so the words come out and the exception goes in.
 *
 * COMPARE-AND-SET, both ways, exactly as 0927: up() rewrites the row only while it still carries
 * 0927's text, and down() restores 0927's text only while the row carries this migration's. An
 * administrator who already edited the description by hand keeps their wording in both directions.
 * No code, name, role binding or grant is touched. The new text is byte-identical to the descriptor
 * in plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs, and the plugin's
 * permission-matrix suite pins the whole chain (seed → 0927 → this file → descriptor).
 */

export const STOCK_PREP_ADMIN_DESCRIPTION_BEFORE =
  'Workbench-scoped stock-preparation administration (no provisioning, no pack install; may relabel still-English managed-table headers to their Chinese template names when the operator switch is on)'
export const STOCK_PREP_ADMIN_DESCRIPTION_AFTER =
  'Workbench-scoped stock-preparation administration (no pack install; may relabel still-English managed-table headers to their Chinese template names when the operator switch is on; includes the puller tier, which may create one per-project stock-preparation sheet from the frozen template when the project-sheets switch is on)'

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
