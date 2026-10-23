import { sql, type Kysely } from 'kysely'

/**
 * 备料分批拉取第一期 — step 3, PR A (core): the SHEET-LEVEL GRID-EXPORT CLOSURE STAMP.
 *
 * WHAT IT ADDS. Three nullable columns on `meta_sheets`:
 *   - `grid_export_closure`   text, CHECK-closed to ('stock_prep_pilot'): the one reason a sheet's generic grid
 *                             export can be closed today (a stock-preparation pilot project sheet);
 *   - `grid_export_closed_at` timestamptz: when the host stamped it;
 *   - `grid_export_closed_by` text: the actor the plugin named when it asked (values-free: an id, never a name).
 * and a pairing CHECK: the reason and the time are set together or not at all.
 *
 * WHO WRITES IT. Only the host service multitable/sheet-grid-export-closure.ts `closeSheetGridExport`, reached
 * only through the `provisioning.closeSheetGridExport` port that the plugin-scope wrapper hands to
 * `plugin-integration-core` alone (same gate shape as `grantSheetRoleWrite`). It sets the stamp once
 * (`WHERE grid_export_closure IS NULL`); there is NO reopen / unset verb anywhere in the host. A mistaken
 * stamp is repaired by an owner-approved runbook DB operation (register row for 2026-10-22).
 *
 * WHAT IT CAN DO. The stamp can only TAKE EXPORT AWAY: every capability resolver turns `canExport` off on a
 * stamped sheet and the export route answers 403 MULTITABLE_GRID_EXPORT_CLOSED. Nothing reads it to grant.
 * So adding the column (all NULL) changes nothing for any existing sheet.
 *
 * zzzz-ordering: `meta_sheets` is created by `zzz20251231_create_meta_schema.ts` (three z's), which sorts before
 * every four-z name, so this ALTER always finds the table.
 *
 * up()   — idempotent: ADD COLUMN IF NOT EXISTS ×3, then each CHECK only when absent (pg_constraint probe).
 * down() — REFUSES while any sheet carries a closure (throws; the migration transaction rolls back and the
 *          columns stay). Dropping the columns would silently REOPEN the generic export of a pilot sheet, which
 *          is exactly the unset path this increment does not have. With no stamped sheet it drops the two
 *          constraints and the three columns.
 *
 * VALUES-FREE: the refusal names a count only.
 */

export const GRID_EXPORT_CLOSURE_REASONS = Object.freeze(['stock_prep_pilot'] as const)
export const GRID_EXPORT_CLOSURE_REASON_CONSTRAINT = 'chk_meta_sheets_grid_export_closure_reason'
export const GRID_EXPORT_CLOSURE_PAIRING_CONSTRAINT = 'chk_meta_sheets_grid_export_closure_pairing'
export const GRID_EXPORT_CLOSURE_DOWN_REFUSED_CODE = 'MULTITABLE_GRID_EXPORT_CLOSURE_ROWS_PRESENT'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_sheets ADD COLUMN IF NOT EXISTS grid_export_closure text`.execute(db)
  await sql`ALTER TABLE meta_sheets ADD COLUMN IF NOT EXISTS grid_export_closed_at timestamptz`.execute(db)
  await sql`ALTER TABLE meta_sheets ADD COLUMN IF NOT EXISTS grid_export_closed_by text`.execute(db)
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_meta_sheets_grid_export_closure_reason'
      ) THEN
        ALTER TABLE meta_sheets
          ADD CONSTRAINT chk_meta_sheets_grid_export_closure_reason
          CHECK (grid_export_closure IS NULL OR grid_export_closure IN ('stock_prep_pilot'));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_meta_sheets_grid_export_closure_pairing'
      ) THEN
        ALTER TABLE meta_sheets
          ADD CONSTRAINT chk_meta_sheets_grid_export_closure_pairing
          CHECK ((grid_export_closure IS NULL) = (grid_export_closed_at IS NULL));
      END IF;
    END $$;
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM meta_sheets
     WHERE grid_export_closure IS NOT NULL
  `.execute(db)
  const closedSheets = Number(result.rows[0]?.count ?? 0)
  if (closedSheets > 0) {
    const error = new Error(
      `[zzzz20261022150000_add_meta_sheets_grid_export_closure] down() refused: ${closedSheets} sheet(s) carry a grid-export closure; dropping the column would reopen their generic export. Nothing was changed.`,
    )
    ;(error as Error & { code?: string }).code = GRID_EXPORT_CLOSURE_DOWN_REFUSED_CODE
    throw error
  }
  await sql`ALTER TABLE meta_sheets DROP CONSTRAINT IF EXISTS chk_meta_sheets_grid_export_closure_pairing`.execute(db)
  await sql`ALTER TABLE meta_sheets DROP CONSTRAINT IF EXISTS chk_meta_sheets_grid_export_closure_reason`.execute(db)
  await sql`ALTER TABLE meta_sheets DROP COLUMN IF EXISTS grid_export_closed_by`.execute(db)
  await sql`ALTER TABLE meta_sheets DROP COLUMN IF EXISTS grid_export_closed_at`.execute(db)
  await sql`ALTER TABLE meta_sheets DROP COLUMN IF EXISTS grid_export_closure`.execute(db)
}
