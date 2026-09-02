/**
 * 备料按部门列写权限 — the stock-preparation (备料) WRITE-SCOPE port into the platform's REAL,
 * server-enforced per-column permission model (`field_permissions`).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS (and why it is not `PluginRbacProvisioningService.applyRoleMatrix`)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * The grid's write gate reads exactly ONE table: `field_permissions`, via
 * `loadFieldPermissionScopeMap` (multitable/permission-service.ts) → `deriveFieldPermissions` →
 * `isFieldWriteForbidden` (multitable/permission-derivation.ts), enforced at
 * `POST /api/multitable/patch`, `PATCH /records/:recordId`, and the Yjs bridge write-input builder.
 * Before this port, the ONLY writers of that table were two inline SQL statements inside
 * `routes/univer-meta.ts` (the operator-facing authoring PUT and the de-escalation restore path) —
 * there was NO in-process, callable writer at all.
 *
 * `PluginRbacProvisioningService.applyRoleMatrix`'s `fieldPolicies` writes a DIFFERENT table
 * (`plugin_field_policy_registry`) which the grid NEVER reads. Declaring a 备料 column policy there
 * would produce a policy row that enforces nothing — a paper guarantee. This port therefore writes
 * the table the enforcement chain actually consults, and nothing else.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LOAD-BEARING PROPERTY — THIS PORT SCOPES **WRITE** ONLY, AND CAN NEVER RESTRICT **READ**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `field_permissions` carries TWO independent dimensions: `visible` (read) and `read_only` (write).
 * This port sets `read_only` and pins `visible` to the hardcoded literal `true`. `visible` is NOT a
 * parameter of `applyRoleWriteScopes`, is NOT bound to a placeholder, and appears nowhere in this
 * file as anything other than that literal — so this capability is STRUCTURALLY incapable of
 * emitting a read restriction. It is not a convention a caller can forget or violate; there is no
 * input, no flag and no overload by which a hidden column can come out of this file.
 *
 * That is a business requirement, not a stylistic one. In the 备料 flow the PRODUCTION band
 * (材料类型 / 毛胚类型 / 需求日期 / 提前周期 …) is precisely what tells 采购 WHAT to buy and BY
 * WHEN, and tells 仓库 what to prepare and when it is due; 采购 and 仓库 must also keep SEEING each
 * other's response columns to coordinate. Hiding those columns from a department would break the
 * actual business flow and be strictly WORSE than the status quo (today every column is writable by
 * everyone, which is at least workable). The failure mode this port removes is a department
 * OVERWRITING another department's column — not a department READING it.
 *
 * Anything that genuinely needs read scoping must go through the existing operator-facing route
 * `PUT /api/multitable/sheets/:sheetId/field-permissions` (routes/univer-meta.ts), which is the
 * full-authority, audited surface (it records a config revision and takes the same meta_sheets row
 * lock). It is deliberately NOT reachable from here.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * PURELY ADDITIVE — NO DELETE / REVOKE PATH
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `applyRoleWriteScopes` is the ONLY public method and it only ever INSERTs / UPSERTs. There is no
 * delete, no revoke, no "clear all for this sheet". Removing a scope is an OPERATOR action, done
 * through the same authoring route named above (`{ remove: true }`), which writes the config-history
 * revision that a permission REMOVAL must leave behind. A plugin-facing port that could silently
 * drop write restrictions would be a de-escalation channel with no audit trail; that is why the
 * asymmetry is deliberate.
 *
 * PROVENANCE: every row this port writes carries
 * `created_by = 'plugin:plugin-integration-core/stock-preparation'`. The column exists and is
 * currently populated by NO other writer, so `SELECT ... WHERE created_by = <that marker>` is an
 * exact, operator-runnable census of what this port ever wrote — which is what makes a later
 * converge/cleanup step (or a manual audit) possible at all.
 *
 * KNOWN, ACCEPTED CONSEQUENCE of the UPSERT: if an operator had previously used the authoring route
 * to HIDE this (sheet, field, role) triple, re-running this port resets that row's read dimension
 * back to the shared-read default. That direction is a read RELAXATION (never a restriction) and is
 * consistent with the property above — but it is a real overwrite of an operator decision, stated
 * here rather than discovered later.
 */

import { poolManager } from '../integration/db/connection-pool'

/** Provenance marker stamped on every row this port writes. See PROVENANCE above. */
export const STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY =
  'plugin:plugin-integration-core/stock-preparation'

/** Hard cap on entries per call — a foot-gun guard, not a business limit. */
export const STOCK_PREPARATION_FIELD_PERMISSION_MAX_ENTRIES = 500

/**
 * Closed failure vocabulary. Every rejection is one of these four; there is no generic/unknown
 * member, so a caller can exhaustively switch on it.
 * - `ENTRIES_INVALID`    — input SHAPE is wrong (bad sheetId, non-string/empty id, over the cap).
 * - `SHEET_NOT_FOUND`    — `sheetId` is not a row in `meta_sheets`.
 * - `FIELD_NOT_ON_SHEET` — a `fieldId` is not a `meta_fields` row FOR THAT sheet.
 * - `ROLE_NOT_FOUND`     — a `roleId` is not a row in `roles`.
 */
export type StockPreparationFieldPermissionsErrorReason =
  | 'ENTRIES_INVALID'
  | 'SHEET_NOT_FOUND'
  | 'FIELD_NOT_ON_SHEET'
  | 'ROLE_NOT_FOUND'

/** Named, typed failure. Fail-closed: thrown BEFORE any row is written (see applyRoleWriteScopes). */
export class StockPreparationFieldPermissionsError extends Error {
  readonly reason: StockPreparationFieldPermissionsErrorReason
  /** The offending ids, when the reason is about specific ids. Never contains values, only ids. */
  readonly offending: readonly string[]

  constructor(
    reason: StockPreparationFieldPermissionsErrorReason,
    message: string,
    offending: readonly string[] = [],
  ) {
    super(message)
    this.name = 'StockPreparationFieldPermissionsError'
    this.reason = reason
    this.offending = offending
  }
}

/** One "this ROLE may NOT WRITE this column" declaration. */
export interface StockPreparationRoleWriteScopeEntry {
  fieldId: string
  roleId: string
}

export interface ApplyRoleWriteScopesInput {
  sheetId: string
  entries: Array<StockPreparationRoleWriteScopeEntry>
}

export interface ApplyRoleWriteScopesResult {
  /** Rows written. Always equals `entries.length` below (the de-duplicated, canonical set). */
  applied: number
  /** The canonical (de-duplicated, order-preserving) entries actually written. */
  entries: Array<StockPreparationRoleWriteScopeEntry>
}

/** Minimal query seam — same shape as `multitable/permission-service.ts`'s `QueryFn`. */
export type StockPreparationFieldPermissionsQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/** Minimal transaction seam — the one primitive this port needs from the pool. */
export interface StockPreparationFieldPermissionsPool {
  transaction<T>(
    handler: (client: { query: StockPreparationFieldPermissionsQueryFn }) => Promise<T>,
  ): Promise<T>
}

export interface StockPreparationFieldPermissionsServiceDeps {
  /**
   * Optional pool override. Same posture as `GovernedAiService`'s injected client: production
   * constructs the service with NO arguments and the pool is resolved LAZILY per call via
   * `poolManager.get()` (matching every other `poolManager.get().transaction(...)` call site in
   * index.ts, so construction order never matters); tests inject a fake.
   */
  pool?: StockPreparationFieldPermissionsPool
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Shape validation + de-duplication. Throws ENTRIES_INVALID; never touches the database.
 *
 * Deliberately a MODULE-LEVEL function, not a private method: `applyRoleWriteScopes` must be the
 * only member on the class prototype, so the port's public surface is provably one method wide (a
 * unit witness asserts exactly that — TypeScript's `private` is erased at runtime and would leave a
 * second callable member behind).
 */
function normalizeInput(input: ApplyRoleWriteScopesInput): {
  sheetId: string
  entries: StockPreparationRoleWriteScopeEntry[]
} {
  if (!input || typeof input !== 'object') {
    throw new StockPreparationFieldPermissionsError('ENTRIES_INVALID', 'Input must be an object')
  }
  if (!isNonEmptyString(input.sheetId)) {
    throw new StockPreparationFieldPermissionsError(
      'ENTRIES_INVALID',
      'sheetId must be a non-empty string',
    )
  }
  if (!Array.isArray(input.entries)) {
    throw new StockPreparationFieldPermissionsError('ENTRIES_INVALID', 'entries must be an array')
  }
  if (input.entries.length > STOCK_PREPARATION_FIELD_PERMISSION_MAX_ENTRIES) {
    throw new StockPreparationFieldPermissionsError(
      'ENTRIES_INVALID',
      `entries exceeds the cap of ${STOCK_PREPARATION_FIELD_PERMISSION_MAX_ENTRIES} (got ${input.entries.length})`,
    )
  }

  const seen = new Set<string>()
  const entries: StockPreparationRoleWriteScopeEntry[] = []
  for (const [index, raw] of input.entries.entries()) {
    if (!raw || typeof raw !== 'object') {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        `entries[${index}] must be an object`,
      )
    }
    const { fieldId, roleId } = raw as { fieldId?: unknown; roleId?: unknown }
    if (!isNonEmptyString(fieldId)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        `entries[${index}].fieldId must be a non-empty string`,
      )
    }
    if (!isNonEmptyString(roleId)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        `entries[${index}].roleId must be a non-empty string`,
      )
    }
    const key = `${fieldId} ${roleId}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ fieldId, roleId })
  }
  return { sheetId: input.sheetId, entries }
}

/**
 * The 备料 host capability: declare, per ROLE, which columns that role may NOT WRITE.
 *
 * Read the file header before changing anything here — in particular the load-bearing
 * write-only property.
 */
export class StockPreparationFieldPermissionsService {
  private readonly injectedPool?: StockPreparationFieldPermissionsPool

  constructor(deps: StockPreparationFieldPermissionsServiceDeps = {}) {
    this.injectedPool = deps.pool
  }

  /**
   * THE ONLY entry point. Each entry means "this ROLE may NOT WRITE this column".
   *
   * Fail-closed and all-or-nothing: sheet, every field and every role are validated INSIDE the
   * transaction BEFORE the first INSERT, and a single bad entry aborts the whole call with nothing
   * written. Idempotent: re-running with the same entries upserts the same rows.
   */
  async applyRoleWriteScopes(input: ApplyRoleWriteScopesInput): Promise<ApplyRoleWriteScopesResult> {
    const { sheetId, entries } = normalizeInput(input)
    // Empty is an explicit, documented no-op (a caller with nothing to declare must not need a
    // special case). It adds NO restriction, so it can never be the unsafe direction.
    if (entries.length === 0) return { applied: 0, entries: [] }

    const pool = this.injectedPool ?? (poolManager.get() as unknown as StockPreparationFieldPermissionsPool)

    // ONE transaction for validation + every write.
    return pool.transaction(async ({ query }) => {
      // Existence check AND the never-escalate-under-concurrency row lock in one statement — the
      // SAME `meta_sheets` lock the operator authoring route and the permission-revert path take, so
      // this write serializes against a concurrent revert instead of racing it.
      const sheetRes = await query('SELECT id FROM meta_sheets WHERE id = $1 FOR UPDATE', [sheetId])
      if (sheetRes.rows.length === 0) {
        throw new StockPreparationFieldPermissionsError(
          'SHEET_NOT_FOUND',
          `Sheet not found: ${sheetId}`,
          [sheetId],
        )
      }

      const fieldIds = [...new Set(entries.map((entry) => entry.fieldId))]
      const fieldRes = await query(
        'SELECT id FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])',
        [sheetId, fieldIds],
      )
      const knownFieldIds = new Set(
        (fieldRes.rows as Array<{ id?: unknown }>).map((row) => String(row.id)),
      )
      const missingFieldIds = fieldIds.filter((fieldId) => !knownFieldIds.has(fieldId))
      if (missingFieldIds.length > 0) {
        throw new StockPreparationFieldPermissionsError(
          'FIELD_NOT_ON_SHEET',
          `Field(s) not on sheet ${sheetId}: ${missingFieldIds.join(', ')}`,
          missingFieldIds,
        )
      }

      const roleIds = [...new Set(entries.map((entry) => entry.roleId))]
      const roleRes = await query('SELECT id FROM roles WHERE id = ANY($1::text[])', [roleIds])
      const knownRoleIds = new Set(
        (roleRes.rows as Array<{ id?: unknown }>).map((row) => String(row.id)),
      )
      const missingRoleIds = roleIds.filter((roleId) => !knownRoleIds.has(roleId))
      if (missingRoleIds.length > 0) {
        throw new StockPreparationFieldPermissionsError(
          'ROLE_NOT_FOUND',
          `Role(s) not found: ${missingRoleIds.join(', ')}`,
          missingRoleIds,
        )
      }

      for (const entry of entries) {
        // WRITE-ONLY SCOPE. `visible` is the hardcoded literal `true` in BOTH the VALUES list and the
        // DO UPDATE SET — it is not a bind parameter and never can be a caller's choice. The four
        // bind parameters are (sheet_id, field_id, subject_id, created_by); `subject_type`,
        // `visible` and `read_only` are literals. See the file header's load-bearing property before
        // touching this statement.
        await query(
          `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)
           VALUES ($1, $2, 'role', $3, true, true, $4)
           ON CONFLICT (sheet_id, field_id, subject_type, subject_id)
           DO UPDATE SET visible = true, read_only = true, created_by = EXCLUDED.created_by`,
          [sheetId, entry.fieldId, entry.roleId, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY],
        )
      }

      return { applied: entries.length, entries }
    })
  }
}
