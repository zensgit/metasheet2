/**
 * #5455 — stamp the OWNING PACK ID onto the 备料 write-scope rows written before the provenance
 * marker carried one.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * Until #5455, `StockPreparationFieldPermissionsService` stamped every row it wrote with the
 * plugin-wide marker `plugin:plugin-integration-core/stock-preparation` — no pack id. So on every
 * host in the field TODAY, a row written by pack A and a row written by pack B are literally
 * identical, and "this pack-less row can have no other owner, therefore it is mine" — the rule the
 * first revision of the reconcile used — was false for the entire installed base. It licensed pack B
 * to DELETE pack A's live, enforced write denials and report them as its own history.
 *
 * The fix has two halves and this script is the second:
 *   1. The port now REFUSES (422 CUSTOMER_PACK_FIELD_WRITE_SCOPE_LEGACY_UNATTRIBUTED) when an
 *      unattributable pack-less row sits inside the rectangle a pack is about to reconcile. Nothing
 *      is guessed and nothing is deleted — the install stops.
 *   2. This script attributes the rows that CAN be attributed, so those installs stop being refused.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ONE INFERENCE IT MAKES, AND THE ONLY EVIDENCE IT ACCEPTS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `field_permissions` has no pack column, so the pack id cannot be read off the row. The only
 * record of who installed what is `integration_stock_prep_pack_installs`, the customer-pack install
 * ledger (migration 076), keyed by (tenant_id, project_id, object_id, pack_id).
 *
 *   IF exactly ONE pack has ever been installed on a (project, object) — every status, including
 *   'failed', because a run that failed after the port call still wrote rows — THEN a pack-less
 *   write-scope row on that sheet is that pack's, because no other pack has ever written one there.
 *
 * A (project, object) with TWO OR MORE packs is AMBIGUOUS and is left alone: those rows stay
 * unattributed, the install keeps refusing, and a human decides. That is the whole point — guessing
 * here would delete another pack's enforced permission rows, which is exactly the defect this
 * change exists to close.
 *
 * The sheet id is derived with the platform's OWN `getObjectSheetId` rather than re-implemented in
 * SQL. It is `'sheet_' || substr(sha1(projectId || ':' || objectId), 1, 24)`, and a second copy of
 * that formula (in a migration's SQL, say) is a copy that can drift from the one the installer uses.
 * Importing it means the mapping this script writes is the mapping the installer reads, by
 * construction.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY A SCRIPT AND NOT A MIGRATION
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * A migration would run itself on upgrade, which sounds convenient and is the wrong shape here:
 *   · IT REWRITES A SECURITY-RELEVANT COLUMN ON AN INFERENCE. `created_by` is what decides whether a
 *     later install may DELETE a row. A change of that kind deserves an operator looking at the
 *     dry-run first, not a side effect of `db:migrate` that nobody sees.
 *   · THE DERIVATION LIVES IN TYPESCRIPT. `getObjectSheetId` is a sha1 in application code; a SQL
 *     migration would have to re-implement it (and depend on pgcrypto's `digest()`, an extension
 *     whose availability is a host property, not a repo property).
 *   · NOTHING BREAKS IF IT IS NOT RUN. The port fails CLOSED: un-backfilled hosts refuse the install
 *     with a coded 422 that names this script. Deferring is safe; guessing is not.
 * This follows the repository's existing one-time-backfill pattern
 * (`scripts/backfill-directory-primary-department.ts`, `scripts/ops/backfill-dingtalk-corp-identities.sh`):
 * an operator-invoked, idempotent, dry-run-first script with an exported runner a test can drive.
 *
 * IDEMPOTENT BY CONSTRUCTION: the UPDATE matches only rows whose `created_by` is still exactly the
 * bare marker. A second run finds none of them and changes nothing.
 *
 * Usage:
 *   DATABASE_URL=… pnpm dlx tsx \
 *     packages/core-backend/scripts/backfill-stock-preparation-write-scope-pack-ids.ts [--apply]
 *
 * DRY RUN IS THE DEFAULT. `--apply` is required to write.
 */
// TYPE-ONLY. The runtime `pg` import lives inside `main()` so this module can be IMPORTED — by the
// unit witness for `selectSoleOwnerSheets`, and by a real-DB test that supplies its own pool —
// without a database driver being installed at all.
import type { Pool, QueryResult, QueryResultRow } from 'pg'

import { getObjectSheetId } from '../src/multitable/provisioning'
import {
  STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
  stockPreparationFieldPermissionCreatedBy,
} from '../src/services/stock-preparation-field-permissions'

/** One (project, object) target and the pack ids the ledger has ever recorded against it. */
export type LedgerTarget = {
  projectId: string
  objectId: string
  packIds: string[]
}

/** A target this script CAN attribute: exactly one pack has ever landed there. */
export type SoleOwnerSheet = {
  projectId: string
  objectId: string
  packId: string
  sheetId: string
  createdBy: string
}

export type BackfillSummary = {
  /** (project, object) pairs the ledger knows about. */
  targets: number
  /** Of those, the ones with exactly one pack — the only ones this script touches. */
  soleOwnerSheets: number
  /** Left alone because two or more packs have landed there. Reported, never guessed. */
  ambiguousSheets: number
  /** Pack-less write-scope rows stamped (or, in a dry run, that would be stamped). */
  rowsStamped: number
  /** Pack-less rows on AMBIGUOUS sheets: still unattributed, still refusing installs. */
  rowsLeftUnattributed: number
}

/**
 * THE INFERENCE, as a pure function — no database, so it can be exercised exhaustively.
 *
 * `soleOwners` is every target with exactly one distinct pack id; `ambiguous` is everything else.
 * A target with ZERO pack ids cannot appear (the ledger row IS the pack id), but it is handled as
 * ambiguous rather than trusted, because an empty list is not evidence of anything.
 */
export function selectSoleOwnerSheets(targets: readonly LedgerTarget[]): {
  soleOwners: SoleOwnerSheet[]
  ambiguous: LedgerTarget[]
} {
  const soleOwners: SoleOwnerSheet[] = []
  const ambiguous: LedgerTarget[] = []
  for (const target of targets) {
    const packIds = [...new Set(target.packIds.filter((id) => typeof id === 'string' && id.trim()))]
    if (packIds.length !== 1) {
      ambiguous.push({ ...target, packIds })
      continue
    }
    const packId = packIds[0]
    soleOwners.push({
      projectId: target.projectId,
      objectId: target.objectId,
      packId,
      // The platform's OWN derivation. See the header: a second copy of this formula is a copy that
      // can drift from the one the installer resolves its rectangle with.
      sheetId: getObjectSheetId(target.projectId, target.objectId),
      createdBy: stockPreparationFieldPermissionCreatedBy(packId),
    })
  }
  soleOwners.sort((left, right) => left.sheetId.localeCompare(right.sheetId))
  ambiguous.sort((left, right) => (left.projectId === right.projectId
    ? left.objectId.localeCompare(right.objectId)
    : left.projectId.localeCompare(right.projectId)))
  return { soleOwners, ambiguous }
}

/** Just enough of `pg.Pool` to run the backfill — lets a test pass a scoped pool. */
type BackfillPool = {
  query: <R extends QueryResultRow>(text: string, values?: unknown[]) => Promise<QueryResult<R>>
}

/**
 * Exported so a real-DB test can drive the actual loop rather than a re-description of it.
 *
 * READ-ONLY unless `apply` is true. In a dry run every count below is what a real run WOULD do,
 * computed from the same statements minus the UPDATE — so the operator's go/no-go is a rehearsal of
 * the write, not a model of it.
 */
export async function runWriteScopePackIdBackfill(
  pool: BackfillPool,
  options: { apply?: boolean; log?: (message: string) => void } = {},
): Promise<BackfillSummary> {
  const log = options.log ?? (() => undefined)
  const apply = options.apply === true

  // EVERY status counts. A 'failed' ledger row records a run that may still have written permission
  // rows before it failed, and counting it can only make a sheet AMBIGUOUS — the safe direction.
  const { rows: ledgerRows } = await pool.query<{ project_id: string; object_id: string; pack_ids: string[] }>(
    `SELECT project_id, object_id, array_agg(DISTINCT pack_id) AS pack_ids
       FROM integration_stock_prep_pack_installs
      GROUP BY project_id, object_id
      ORDER BY project_id, object_id`,
  )
  const targets: LedgerTarget[] = ledgerRows.map((row) => ({
    projectId: String(row.project_id),
    objectId: String(row.object_id),
    packIds: Array.isArray(row.pack_ids) ? row.pack_ids.map((id) => String(id)) : [],
  }))
  const { soleOwners, ambiguous } = selectSoleOwnerSheets(targets)

  const summary: BackfillSummary = {
    targets: targets.length,
    soleOwnerSheets: soleOwners.length,
    ambiguousSheets: ambiguous.length,
    rowsStamped: 0,
    rowsLeftUnattributed: 0,
  }

  for (const sheet of soleOwners) {
    if (apply) {
      // THE ONLY WRITE. `created_by` must still be EXACTLY the bare marker: a row already stamped
      // with a pack id (this one's or another's), an operator's row, and a NULL row are all outside
      // this predicate, which is what makes a second run a no-op and makes it impossible for this
      // script to touch anything but the rows it was written for.
      const { rowCount } = await pool.query(
        `UPDATE field_permissions
            SET created_by = $2
          WHERE sheet_id = $1
            AND subject_type = 'role'
            AND created_by = $3`,
        [sheet.sheetId, sheet.createdBy, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY],
      )
      const stamped = rowCount ?? 0
      summary.rowsStamped += stamped
      if (stamped > 0) {
        log(`[apply] sheet ${sheet.sheetId} (${sheet.projectId}/${sheet.objectId}): ${stamped} row(s) → pack ${sheet.packId}`)
      }
    } else {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM field_permissions
          WHERE sheet_id = $1
            AND subject_type = 'role'
            AND created_by = $2`,
        [sheet.sheetId, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY],
      )
      const stamped = Number(rows[0]?.count ?? 0)
      summary.rowsStamped += stamped
      if (stamped > 0) {
        log(`[dry-run] sheet ${sheet.sheetId} (${sheet.projectId}/${sheet.objectId}): ${stamped} row(s) would become pack ${sheet.packId}`)
      }
    }
  }

  for (const target of ambiguous) {
    const sheetId = getObjectSheetId(target.projectId, target.objectId)
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM field_permissions
        WHERE sheet_id = $1
          AND subject_type = 'role'
          AND created_by = $2`,
      [sheetId, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY],
    )
    const left = Number(rows[0]?.count ?? 0)
    summary.rowsLeftUnattributed += left
    if (left > 0) {
      log(
        `[skip] sheet ${sheetId} (${target.projectId}/${target.objectId}): ${left} pack-less row(s) left `
        + `UNATTRIBUTED — ${target.packIds.length} packs have landed here (${target.packIds.join(', ')}). `
        + 'A customer-pack install on this sheet will keep refusing with '
        + 'CUSTOMER_PACK_FIELD_WRITE_SCOPE_LEGACY_UNATTRIBUTED until a human decides who owns them.',
      )
    }
  }

  return summary
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  // DRY RUN IS THE DEFAULT: this rewrites the column that decides whether a later install may DELETE
  // a permission row, so writing has to be asked for.
  const apply = process.argv.includes('--apply')

  const { default: pg } = await import('pg')
  const pool: Pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  if (!apply) console.log('[dry-run] no rows will be written — pass --apply to write')

  try {
    const summary = await runWriteScopePackIdBackfill(pool, { apply, log: (message) => console.log(message) })
    console.log(
      `${apply ? '' : '[dry-run] '}done: ${summary.rowsStamped} row(s) `
      + `${apply ? 'stamped' : 'would be stamped'} across ${summary.soleOwnerSheets} sole-owner sheet(s); `
      + `${summary.rowsLeftUnattributed} row(s) left unattributed on ${summary.ambiguousSheets} ambiguous sheet(s); `
      + `${summary.targets} ledger target(s) scanned`,
    )
    if (summary.rowsLeftUnattributed > 0) {
      console.log(
        'ACTION REQUIRED: the unattributed rows above will keep refusing customer-pack installs on '
        + 'those sheets. Decide who owns each row and either stamp it by hand or clear it with '
        + 'PUT /api/multitable/sheets/:sheetId/field-permissions { remove: true }.',
      )
    }
  } finally {
    await pool.end()
  }
}

// Importing this module (a test does) must not run the backfill.
if (process.argv[1]?.includes('backfill-stock-preparation-write-scope-pack-ids')) {
  main().catch((err) => {
    console.error('backfill failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
