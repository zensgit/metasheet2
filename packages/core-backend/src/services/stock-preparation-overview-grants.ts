/**
 * 一个项目一张备料表 — S3 fix round 1 (R1): G1 FOR THE PROJECT OVERVIEW, THE WRITE HALF (ADR
 * adr-stock-prep-project-sheets-20261008 §5 「只读（Q5）」 + §2 G1; register R-37). Grants the
 * server-configured `stock-prep` roles `spreadsheet:read` on the tenant's ONE project-overview sheet, so the
 * floor can open the read-only overview the home page offers. Read
 * multitable/stock-preparation-overview-contract.ts and the S1 G1 service
 * (services/stock-preparation-project-sheet-grants.ts) first: this file is the overview twin of the latter
 * and differs in exactly two load-bearing places.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LOAD-BEARING PROPERTIES — WHAT THIS FILE CAN AND CANNOT WRITE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *   * ONE INSERT, ZERO DELETE, ZERO UPDATE of spreadsheet_permissions. Add-only (`ON CONFLICT DO NOTHING`):
 *     an existing grant on the sheet is never lowered or removed. The unit suite pins the census.
 *   * `perm_code` IS A LITERAL — `STOCK_PREPARATION_OVERVIEW_GRANT_PERM_CODE` (`spreadsheet:read`). Not a
 *     parameter of any function here; a write or admin grant is structurally unrepresentable. (Difference
 *     one from the S1 service, whose literal is `spreadsheet:write`: the overview is read-only.)
 *   * `subject_type` IS THE LITERAL 'role'; `user_id` IS NULL. No user or member-group grant.
 *   * THE SHEET MUST CARRY THE OVERVIEW KIND, re-read INSIDE this transaction after the row lock
 *     (difference two). The plugin-scope wrapper already proved the objectId is the overview's, the sheet id
 *     is the derived one and the registry owns it for this plugin and project; this binds the DATA: a sheet
 *     that is not stamped `stock_prep_overview` (an older host's sheet, an unstamped twin) is refused with
 *     nothing written, so this port can never hand a read grant on an ordinary sheet.
 *   * A HISTORY ROW PER LANDED GRANT THAT CHANGES THE ROLE'S LEVEL, in the same transaction (the T9-L4 rule
 *     the operator route and the S1 service follow). A role that already held a higher level gets the read
 *     row and no history row (the clamp makes that higher level read-only in effect anyway).
 */

import { recordConfigRevision } from '../multitable/config-revision-recorder'
import {
  MANAGED_SHEET_PERMISSION_CODES,
  deriveSheetAccessLevel,
} from '../multitable/permission-service'
import { assertSheetLiveForUpdate } from '../multitable/sheet-liveness'
import {
  StockPreparationProjectSheetGrantError,
  normalizeStockPreparationGrantRoleIds,
} from '../multitable/stock-preparation-project-sheet-grant-contract'
import {
  STOCK_PREPARATION_OVERVIEW_GRANT_PERM_CODE,
  STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND,
} from '../multitable/stock-preparation-overview-contract'

export type StockPreparationOverviewGrantQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export interface GrantStockPreparationOverviewRoleReadInput {
  sheetId: string
  roleIds: string[]
  actorId?: string | null
  /** Groups the history rows of one grant call; a fresh uuid when omitted. */
  batchId?: string | null
}

export interface GrantStockPreparationOverviewRoleReadResult {
  sheetId: string
  /** Role ids whose `spreadsheet:read` row this call INSERTED. */
  granted: string[]
  /** Role ids that already held the row (ON CONFLICT DO NOTHING matched); nothing was written. */
  alreadyGranted: string[]
}

/** The history row's entity id — the operator route's `permissionConfigEntityId('sheet', ['role', id])` shape. */
export function stockPreparationOverviewGrantEntityId(roleId: string): string {
  return `sheet:${JSON.stringify(['role', roleId])}`
}

const SHEET_PERMISSION_HISTORY_KEYS = ['subjectType', 'subjectId', 'accessLevel'] as const

function generateBatchId(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto')
  return randomUUID()
}

/**
 * Grant every listed role `spreadsheet:read` on the overview sheet `sheetId`, inside the caller's
 * transaction. Fail-closed and all-or-nothing: roles validated before any statement, the sheet row-locked,
 * proven live and proven to carry the overview kind, every role proven to exist; one bad role aborts the
 * call with nothing written. Idempotent: a repeat inserts nothing and reports every role `alreadyGranted`.
 */
export async function grantStockPreparationOverviewRoleRead(
  query: StockPreparationOverviewGrantQueryFn,
  input: GrantStockPreparationOverviewRoleReadInput,
): Promise<GrantStockPreparationOverviewRoleReadResult> {
  const sheetId = typeof input.sheetId === 'string' ? input.sheetId.trim() : ''
  if (!sheetId) {
    throw new StockPreparationProjectSheetGrantError(422, 'STOCK_PREP_PROJECT_SHEET_GRANT_SHEET_INVALID', 'sheetId is required', { field: 'sheetId' })
  }
  const roleIds = normalizeStockPreparationGrantRoleIds(input.roleIds)
  if (roleIds.length === 0) {
    return { sheetId, granted: [], alreadyGranted: [] }
  }
  const actorId = typeof input.actorId === 'string' && input.actorId.trim() ? input.actorId.trim() : null
  const batchId = typeof input.batchId === 'string' && input.batchId.trim() ? input.batchId.trim() : generateBatchId()

  // LIVENESS + the never-escalate-under-concurrency row lock, in one statement (the #5938 shape).
  await assertSheetLiveForUpdate(query as never, sheetId)

  // THE KIND, re-read under the lock (column-tolerant: a database without the column answers null and is
  // refused like any other unstamped sheet). Values-free refusal.
  const kindRow = await query(
    `SELECT (to_jsonb(meta_sheets) ->> 'system_kind') AS system_kind FROM meta_sheets WHERE id = $1`,
    [sheetId],
  )
  const kind = (kindRow.rows as Array<{ system_kind?: unknown }>)[0]?.system_kind
  if (kind !== STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND) {
    throw new StockPreparationProjectSheetGrantError(
      409,
      'STOCK_PREP_OVERVIEW_GRANT_NOT_OVERVIEW',
      'the overview read grant may target only a sheet the host stamped as the stock-preparation project overview',
      { field: 'sheetId' },
    )
  }

  const existing = await query('SELECT id FROM roles WHERE id = ANY($1::text[])', [roleIds])
  const found = new Set(
    (existing.rows as Array<{ id?: unknown }>).map((row) => (typeof row.id === 'string' ? row.id : '')).filter(Boolean),
  )
  const missing = roleIds.filter((roleId) => !found.has(roleId))
  if (missing.length > 0) {
    throw new StockPreparationProjectSheetGrantError(
      404,
      'STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_NOT_FOUND',
      'a configured project-sheet grant role does not exist',
      { field: 'roleIds', missingRoleIds: missing },
    )
  }

  const granted: string[] = []
  const alreadyGranted: string[] = []
  for (const roleId of roleIds) {
    const before = await query(
      `SELECT perm_code FROM spreadsheet_permissions
       WHERE sheet_id = $1 AND subject_type = 'role' AND subject_id = $2 AND perm_code = ANY($3::text[])`,
      [sheetId, roleId, MANAGED_SHEET_PERMISSION_CODES],
    )
    const beforeCodes = (before.rows as Array<{ perm_code?: unknown }>).map((row) => String(row.perm_code ?? ''))
    const beforeLevel = deriveSheetAccessLevel(beforeCodes)
    // THE ONE INSERT. ADD-ONLY.
    const inserted = await query(
      `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
       VALUES ($1, NULL, 'role', $2, $3)
       ON CONFLICT (sheet_id, subject_type, subject_id, perm_code) DO NOTHING
       RETURNING subject_id`,
      [sheetId, roleId, STOCK_PREPARATION_OVERVIEW_GRANT_PERM_CODE],
    )
    if ((inserted.rows as unknown[]).length === 0) {
      alreadyGranted.push(roleId)
      continue
    }
    granted.push(roleId)
    const afterLevel = deriveSheetAccessLevel([...beforeCodes, STOCK_PREPARATION_OVERVIEW_GRANT_PERM_CODE])
    if (afterLevel && afterLevel !== beforeLevel) {
      await recordConfigRevision(query as never, {
        sheetId,
        entityType: 'permission',
        entityId: stockPreparationOverviewGrantEntityId(roleId),
        action: beforeLevel ? 'update' : 'create',
        before: beforeLevel ? { accessLevel: beforeLevel } : null,
        after: beforeLevel
          ? { accessLevel: afterLevel }
          : { subjectType: 'role', subjectId: roleId, accessLevel: afterLevel },
        changedKeys: beforeLevel ? ['accessLevel'] : [...SHEET_PERMISSION_HISTORY_KEYS],
        batchId,
        actorId,
      })
    }
  }
  return { sheetId, granted, alreadyGranted }
}
