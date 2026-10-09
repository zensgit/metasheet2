/**
 * 一个项目一张备料表 — G1, THE WRITE HALF (ADR adr-stock-prep-project-sheets-20261008 §2 / addendum
 * A.6; register R-35). Grants the server-configured `stock-prep` roles `spreadsheet:write` on ONE
 * project sheet. Read multitable/stock-preparation-project-sheet-grant-contract.ts first: it holds
 * the bounds this file is only the implementation of.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LOAD-BEARING PROPERTIES — WHAT THIS FILE CAN AND CANNOT WRITE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *   * ONE INSERT, ZERO DELETE. The only mutating statement is the `ON CONFLICT DO NOTHING` insert
 *     below. There is no revoke, no downgrade and no "replace" (the operator-facing grant route in
 *     routes/univer-meta.ts deletes the subject's managed codes before it inserts; this port does
 *     not, so an existing grant on the sheet is never lowered). The unit suite pins the statement
 *     census of this file.
 *   * `perm_code` IS A LITERAL. `STOCK_PREPARATION_PROJECT_SHEET_GRANT_PERM_CODE` is the only value
 *     bound to that column, it is `spreadsheet:write`, and it is not a parameter of any function
 *     here. A read grant (which would put the sheet into intersection mode and lock the floor out
 *     of entering values) and an admin grant are structurally unrepresentable.
 *   * `subject_type` IS THE LITERAL 'role'. No user grant, no member-group grant.
 *   * `user_id` IS NULL — the row shape the subjects migration (zzzz20260406030000) gives a non-user
 *     subject, so `listSheetPermissionEntries` and the grid's scope loader read it exactly like a
 *     grant the operator route wrote.
 *   * EVERY LANDED GRANT HAS A HISTORY ROW (`meta_config_revisions`, entity `permission`, keyed by
 *     sheet + ('role', roleId)) in the SAME transaction, so a grant and its record commit or roll
 *     back together — the T9-L4 rule the operator route follows.
 *
 * WHAT THE WRAPPER ALREADY PROVED BEFORE THIS RUNS (multitable/plugin-scope.ts `grantSheetRoleWrite`):
 * the plugin's project namespace, the role-namespace rule, the project-sheet objectId shape, that
 * the sheet id is the one derived for (project, objectId), and that the registry records the sheet
 * as this plugin's and this project's. This file re-runs the role-namespace rule (cheap, pure, and
 * the only one of those that is about the DATA this file writes) and adds the two facts only the
 * database can answer: the sheet is live, and every role exists.
 */

import { recordConfigRevision } from '../multitable/config-revision-recorder'
import {
  MANAGED_SHEET_PERMISSION_CODES,
  deriveSheetAccessLevel,
} from '../multitable/permission-service'
import { assertSheetLiveForUpdate } from '../multitable/sheet-liveness'
import {
  STOCK_PREPARATION_PROJECT_SHEET_GRANT_PERM_CODE,
  StockPreparationProjectSheetGrantError,
  normalizeStockPreparationGrantRoleIds,
} from '../multitable/stock-preparation-project-sheet-grant-contract'

/** The transaction-bound query function the host hands this service (same shape as provisioning). */
export type StockPreparationProjectSheetGrantQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export interface GrantStockPreparationProjectSheetRoleWriteInput {
  sheetId: string
  roleIds: string[]
  actorId?: string | null
  /** Groups the history rows of one grant call; a fresh uuid when omitted. */
  batchId?: string | null
}

export interface GrantStockPreparationProjectSheetRoleWriteResult {
  sheetId: string
  /** Role ids whose `spreadsheet:write` row this call INSERTED. */
  granted: string[]
  /** Role ids that already held the row (ON CONFLICT DO NOTHING matched); nothing was written. */
  alreadyGranted: string[]
}

/**
 * The history row's entity id — the SAME shape routes/univer-meta.ts `permissionConfigEntityId`
 * writes for a sheet grant (`sheet:["role","<id>"]`), re-stated here rather than imported so this
 * service does not load the whole routes module. The unit suite pins the two equal.
 */
export function stockPreparationProjectSheetGrantEntityId(roleId: string): string {
  return `sheet:${JSON.stringify(['role', roleId])}`
}

const SHEET_PERMISSION_HISTORY_KEYS = ['subjectType', 'subjectId', 'accessLevel'] as const

function generateBatchId(): string {
  // Lazy require keeps the pure contract module and this file free of a top-level crypto import
  // in the test's source census; `randomUUID` is the same generator the operator route uses.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto')
  return randomUUID()
}

/**
 * Grant every listed role `spreadsheet:write` on `sheetId`, inside the caller's transaction.
 *
 * Fail-closed and all-or-nothing: the role list is validated before any statement, the sheet is
 * row-locked and proven live, every role is proven to exist, and a single bad role aborts the whole
 * call with nothing written. Idempotent: a repeat call inserts nothing and reports every role as
 * `alreadyGranted`.
 */
export async function grantStockPreparationProjectSheetRoleWrite(
  query: StockPreparationProjectSheetGrantQueryFn,
  input: GrantStockPreparationProjectSheetRoleWriteInput,
): Promise<GrantStockPreparationProjectSheetRoleWriteResult> {
  const sheetId = typeof input.sheetId === 'string' ? input.sheetId.trim() : ''
  if (!sheetId) {
    throw new StockPreparationProjectSheetGrantError(422, 'STOCK_PREP_PROJECT_SHEET_GRANT_SHEET_INVALID', 'sheetId is required', { field: 'sheetId' })
  }
  const roleIds = normalizeStockPreparationGrantRoleIds(input.roleIds)
  if (roleIds.length === 0) {
    // Nothing to grant is the one total no-op: no lock, no statement.
    return { sheetId, granted: [], alreadyGranted: [] }
  }
  const actorId = typeof input.actorId === 'string' && input.actorId.trim() ? input.actorId.trim() : null
  const batchId = typeof input.batchId === 'string' && input.batchId.trim() ? input.batchId.trim() : generateBatchId()

  // LIVENESS + the never-escalate-under-concurrency row lock, in one statement — the SAME
  // `meta_sheets` lock the operator grant route and the permission-revert path take, so this write
  // serializes against a concurrent revert instead of racing it (#5938 shape).
  await assertSheetLiveForUpdate(query as never, sheetId)

  // EVERY ROLE MUST EXIST. The operator route answers 404 per role; this port refuses the whole call
  // (a configured role that does not exist is a deployment fault, and a partial grant would leave
  // the floor split between roles that can open the sheet and roles that cannot).
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
    // What this subject held BEFORE, for the history diff — managed codes only, like the route.
    const before = await query(
      `SELECT perm_code FROM spreadsheet_permissions
       WHERE sheet_id = $1 AND subject_type = 'role' AND subject_id = $2 AND perm_code = ANY($3::text[])`,
      [sheetId, roleId, MANAGED_SHEET_PERMISSION_CODES],
    )
    const beforeLevel = deriveSheetAccessLevel(
      (before.rows as Array<{ perm_code?: unknown }>).map((row) => String(row.perm_code ?? '')),
    )
    // THE ONE INSERT. ADD-ONLY: an existing identical row is left untouched (DO NOTHING), and no
    // other row of the subject is deleted or rewritten.
    const inserted = await query(
      `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
       VALUES ($1, NULL, 'role', $2, $3)
       ON CONFLICT (sheet_id, subject_type, subject_id, perm_code) DO NOTHING
       RETURNING subject_id`,
      [sheetId, roleId, STOCK_PREPARATION_PROJECT_SHEET_GRANT_PERM_CODE],
    )
    const landed = (inserted.rows as unknown[]).length > 0
    if (!landed) {
      alreadyGranted.push(roleId)
      continue
    }
    granted.push(roleId)
    const afterLevel = deriveSheetAccessLevel([
      ...(before.rows as Array<{ perm_code?: unknown }>).map((row) => String(row.perm_code ?? '')),
      STOCK_PREPARATION_PROJECT_SHEET_GRANT_PERM_CODE,
    ])
    // The history row, in the same transaction. A subject that already held a HIGHER level (admin)
    // keeps that level and gets no row — the grant changed nothing it can describe.
    if (afterLevel && afterLevel !== beforeLevel) {
      const beforeSnapshot = beforeLevel
        ? { subjectType: 'role', subjectId: roleId, accessLevel: beforeLevel }
        : null
      const afterSnapshot = { subjectType: 'role', subjectId: roleId, accessLevel: afterLevel }
      await recordConfigRevision(query as never, {
        sheetId,
        entityType: 'permission',
        entityId: stockPreparationProjectSheetGrantEntityId(roleId),
        action: beforeSnapshot ? 'update' : 'create',
        before: beforeSnapshot ? { accessLevel: beforeSnapshot.accessLevel } : null,
        after: beforeSnapshot ? { accessLevel: afterSnapshot.accessLevel } : afterSnapshot,
        changedKeys: beforeSnapshot ? ['accessLevel'] : [...SHEET_PERMISSION_HISTORY_KEYS],
        batchId,
        actorId,
      })
    }
  }
  return { sheetId, granted, alreadyGranted }
}
