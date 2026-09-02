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
 * THE ONE DELETE: A SCOPED RECONCILE OF THIS PORT'S OWN ROWS, NEVER A GENERAL REVOKE CHANNEL
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `applyRoleWriteScopes` is the ONLY MUTATING method. By default it only ever INSERTs / UPSERTs and
 * emits NO delete at all — every caller that passes no `reconcile` scope is byte-for-byte the
 * additive port this file used to be.
 *
 * A caller that owns a WHOLE (columns × roles) region may instead pass `reconcile`, and the same
 * transaction then also removes the rows in THAT REGION that the new declaration no longer wants.
 * This exists because upsert-only has one sharp, silent failure: a pack revision that MOVES a
 * column's owner (v1 says 采购 may not write 实际到货日期; v2 moves that column TO 采购) leaves v1's
 * denial standing beside v2's, and `loadFieldPermissionScopeMap` ORs `read_only` across a user's
 * rows — so the column becomes unwritable by EVERY declared role while the install reports success.
 * Reporting that is not enough: the deployment stays broken until a human notices.
 *
 * FIVE INDEPENDENT NARROWINGS make this a reconcile rather than a revoke channel. The DELETE fires
 * only on a row that satisfies ALL of:
 *   0. `sheet_id = <the target sheet>` — `field_permissions` carries NO tenant and NO project
 *      column, so this single clause is the entire project/tenant bound of the statement. It is
 *      listed first because it is the one whose absence would be widest, and it is pinned by the
 *      source guard and by a positional-decoding model, not merely present.
 *   1. `created_by = ANY(<this pack's marker, the legacy pack-less marker>)` — a row an OPERATOR
 *      authored is INVISIBLE to this statement, and so is a row written for ANOTHER customer pack.
 *      Two packs can legitimately govern overlapping (column, role) rectangles on one canonical
 *      sheet; the pack id inside the marker is what keeps one from retiring the other's denials.
 *      The pack-less legacy marker is adoptable because no pack can claim it.
 *   2. `read_only = true` — only an actual write denial. A row this port wrote and an operator later
 *      relaxed is no longer a denial and is left exactly as the operator left it.
 *   3. `field_id = ANY(<governed columns>) AND subject_id = ANY(<governed roles>)` — the caller's
 *      declared region, which `normalizeInput` REQUIRES to be a superset of the entries being
 *      written. The delete can therefore never reach a column or a role the same call is not
 *      simultaneously authoritative about.
 *   4. the row is not in the desired set this very call just wrote.
 * A row failing any one of the five survives. There is no input by which this becomes
 * "clear all for this sheet": with `reconcile` absent (or falsy) the statement does not run, and
 * with it present it is bounded by (3) to a region the caller is re-declaring in full.
 *
 * WHAT (1) CANNOT DO ON ITS OWN: `created_by` records who OWNS the row, and it stays that way only
 * because the UPSERT above refuses to re-stamp a row whose current provenance this statement could
 * not also delete. An unconditional `created_by = EXCLUDED.created_by` would launder an operator's
 * row into a plugin row the first time a pack re-declared the same pair, and (1) would then be
 * satisfied by a row the operator authored. That is why the two statements have to be read together.
 *
 * The removals are RETURNED (`removed`), so the caller can report exactly which restrictions were
 * dropped instead of dropping them silently — the audit-trail concern that motivated the original
 * no-revoke posture is answered by naming them, not by leaving the sheet wrong.
 *
 * PROVENANCE: every row this port writes carries
 * `created_by = 'plugin:plugin-integration-core/stock-preparation#<packId>'` (or the pack-less base
 * marker when the caller names no pack). `SELECT ... WHERE created_by LIKE '<base>%'` is therefore
 * an exact, operator-runnable census of what this plugin ever wrote, AND it attributes each row to
 * the pack that wrote it — which is what makes the reconcile above safe on a sheet two packs share.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO READ METHODS — WHY A REVOKE-FREE PORT STILL NEEDS TO BE READABLE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * `listRoleWriteScopes` and `findMissingRoleIds` are READ-ONLY (`SELECT` only; a source guard in the
 * unit suite asserts this file contains exactly one INSERT and exactly one — scoped — DELETE, and
 * that neither read method emits either). They exist because the write path's scoping has edges the
 * installer cannot see without them:
 *
 *   - `listRoleWriteScopes` runs the census the PROVENANCE paragraph describes, in-process. The
 *     reconcile above heals the orphans INSIDE the caller's governed region; this census is how the
 *     caller finds the ones OUTSIDE it — a column this port denied under an older, wider pack that
 *     the current declaration no longer governs at all. Those the installer can only REPORT
 *     (`staleWriteScopes`): clearing them is an operator action, because nothing in the current
 *     declaration establishes that they are wrong.
 *   - `findMissingRoleIds` lets a caller ask "does this role exist" BEFORE it starts writing schema.
 *     `applyRoleWriteScopes` already refuses an unknown role, but it is called LAST, after every
 *     column has been created and stamped; a pre-flight turns that into a refusal over an untouched
 *     sheet.
 *
 * Neither can hide a column, neither can drop a restriction, and neither takes a `visible`
 * argument — the load-bearing property above is unaffected by their existence.
 *
 * KNOWN, ACCEPTED CONSEQUENCE of the UPSERT: if an operator had previously used the authoring route
 * to HIDE this (sheet, field, role) triple, re-running this port resets that row's read dimension
 * back to the shared-read default. That direction is a read RELAXATION (never a restriction) and is
 * consistent with the property above — but it is a real overwrite of an operator decision, stated
 * here rather than discovered later.
 */

import { poolManager } from '../integration/db/connection-pool'

/**
 * BASE provenance marker — the plugin-family prefix, and the exact value written by a caller that
 * names no pack. See PROVENANCE above.
 *
 * A row stamped with exactly this value is a LEGACY row: written before the marker carried a pack
 * id, so there is no pack it can be attributed to. Such a row is adoptable by whichever pack
 * re-declares it (there is no other owner to protect it for) — that is the ONLY marker other than
 * its own that a pack's reconcile may touch, and it is stated here rather than left to inference.
 */
export const STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY =
  'plugin:plugin-integration-core/stock-preparation'

/**
 * The PER-PACK provenance marker: the base above plus `#<packId>`.
 *
 * Two customer packs can legitimately land on the same canonical sheet, and the platform row carries
 * no pack column — so without this the only "whose row is it" predicate available to the DELETE was
 * a single plugin-wide constant, and pack B's reconcile could retire a denial pack A still declares.
 * The pack id lives inside `created_by` because that is the one column the enforcement table already
 * has, and it stays PARSEABLE (single `#`, pack ids never contain one) so a census can attribute
 * every row without a schema change.
 */
export function stockPreparationFieldPermissionCreatedBy(packId?: string | null): string {
  if (typeof packId !== 'string' || packId.trim().length === 0) {
    return STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY
  }
  return `${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#${packId.trim()}`
}

/**
 * Read a `created_by` value back. `isPluginRow` false means the row belongs to somebody else — an
 * operator, another subsystem, or nobody (NULL) — and nothing in this file may delete it.
 */
export function parseStockPreparationFieldPermissionCreatedBy(
  createdBy: unknown,
): { isPluginRow: boolean; packId: string | null } {
  if (typeof createdBy !== 'string') return { isPluginRow: false, packId: null }
  if (createdBy === STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY) {
    return { isPluginRow: true, packId: null }
  }
  const prefix = `${STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY}#`
  if (createdBy.startsWith(prefix) && createdBy.length > prefix.length) {
    return { isPluginRow: true, packId: createdBy.slice(prefix.length) }
  }
  return { isPluginRow: false, packId: null }
}

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

/**
 * The (columns × roles) region a caller declares itself AUTHORITATIVE over for this call — the
 * bound on the reconcile DELETE, and the only thing that makes it a reconcile rather than a revoke.
 *
 * Both lists are REQUIRED and must be non-empty, and every `entries` pair must fall inside them
 * (`normalizeInput` enforces that, `ENTRIES_INVALID` otherwise). A caller therefore cannot delete
 * in a region it is not simultaneously re-declaring in full.
 */
export interface RoleWriteScopeReconcileRegion {
  /** Columns this call re-declares in full. Rows on any other column are untouchable. */
  fieldIds: readonly string[]
  /** Roles this call re-declares in full. Rows for any other role are untouchable. */
  roleIds: readonly string[]
}

export interface ApplyRoleWriteScopesInput {
  sheetId: string
  entries: Array<StockPreparationRoleWriteScopeEntry>
  /**
   * OPTIONAL pack identity. Present → every row written carries `<base>#<packId>` and the reconcile
   * DELETE is bounded to that marker (plus the pack-less LEGACY marker, which has no other owner).
   * Absent → the legacy marker is written and matched, exactly as before this option existed.
   */
  packId?: string
  /**
   * OPTIONAL. Absent (or `null` / `false` — every falsy value means "not asked for") → purely
   * additive: no DELETE statement is executed at all and `removed` is empty, which is byte-for-byte
   * the behaviour every caller had before this option existed.
   * Present → the same transaction also removes this pack's OWN, still-denying rows inside the
   * region that are not in `entries`. See the file header's narrowings.
   */
  reconcile?: RoleWriteScopeReconcileRegion | null | false
}

export interface ApplyRoleWriteScopesResult {
  /** Rows written. Always equals `entries.length` below (the de-duplicated, canonical set). */
  applied: number
  /** The canonical (de-duplicated, order-preserving) entries actually written. */
  entries: Array<StockPreparationRoleWriteScopeEntry>
  /**
   * The denials this call REMOVED — always `[]` without a `reconcile` region. Returned rather than
   * merely dropped so a caller can name every restriction it retired.
   */
  removed: Array<StockPreparationRoleWriteScopeEntry>
}

/** One row of the provenance census: a (column, role) pair THIS port previously denied. */
export interface ListRoleWriteScopesInput {
  sheetId: string
}

/** A census row this plugin wrote, attributed to the pack that wrote it (null = legacy, pack-less). */
export interface RoleWriteScopeCensusEntry extends StockPreparationRoleWriteScopeEntry {
  createdBy: string
  packId: string | null
}

/** A denial on this sheet that this plugin did NOT write. Reported, never claimed, never deleted. */
export interface RoleWriteScopeForeignEntry extends StockPreparationRoleWriteScopeEntry {
  createdBy: string | null
}

export interface ListRoleWriteScopesResult {
  sheetId: string
  /**
   * Every role-scoped write denial on this sheet stamped with a marker of THIS PLUGIN's family,
   * each attributed to the pack that wrote it. A caller diffs its own pack's rows against its plan;
   * another pack's rows are visible here precisely so they can be reported rather than clobbered.
   */
  entries: Array<RoleWriteScopeCensusEntry>
  /**
   * The same query's other half: role-scoped write denials this plugin did NOT write (an operator's
   * own rows, or anything else that ever writes this table). Separated rather than dropped because
   * a caller must be able to say "a human holds this (column, role)" without ever treating it as
   * installer debris — and must never claim or delete it.
   */
  foreignEntries: Array<RoleWriteScopeForeignEntry>
}

export interface FindMissingRoleIdsInput {
  roleIds: readonly string[]
}

export interface FindMissingRoleIdsResult {
  /** The subset of `roleIds` that is NOT a row in `roles`. Sorted; empty means all exist. */
  missing: string[]
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
  packId: string | null
  reconcile: { fieldIds: string[]; roleIds: string[] } | null
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
  // The pack id is a provenance token, not an addressable key: it must be a clean single segment so
  // `<base>#<packId>` stays parseable in both directions.
  let packId: string | null = null
  if (input.packId !== undefined && input.packId !== null) {
    if (!isNonEmptyString(input.packId) || input.packId.includes('#')) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        'packId must be a non-empty string containing no "#"',
      )
    }
    packId = input.packId.trim()
  }
  return {
    sheetId: input.sheetId,
    entries,
    packId,
    reconcile: normalizeReconcile(input.reconcile, entries),
  }
}

/**
 * Validate the reconcile region. Absent → `null`, and no DELETE is executed.
 *
 * The containment check is the load-bearing half: every entry being written must lie inside the
 * region, so the region can never be a set of columns/roles the same call is not re-declaring. A
 * caller that wants to write outside the region must widen the region — which is exactly the
 * statement "I am authoritative here" made explicit rather than assumed.
 */
function normalizeReconcile(
  reconcile: RoleWriteScopeReconcileRegion | null | false | undefined,
  entries: readonly StockPreparationRoleWriteScopeEntry[],
): { fieldIds: string[]; roleIds: string[] } | null {
  // EVERY falsy value means "no region asked for" — `undefined`, `null` and `false` alike. A caller
  // expressing "additive only" as a boolean must land on the additive path, not on a 422 over a
  // sheet whose columns were already created.
  if (!reconcile) return null
  if (typeof reconcile !== 'object') {
    throw new StockPreparationFieldPermissionsError('ENTRIES_INVALID', 'reconcile must be an object')
  }
  const readIds = (raw: unknown, name: string): string[] => {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        `reconcile.${name} must be a non-empty array`,
      )
    }
    for (const value of raw) {
      if (!isNonEmptyString(value)) {
        throw new StockPreparationFieldPermissionsError(
          'ENTRIES_INVALID',
          `every reconcile.${name} entry must be a non-empty string`,
        )
      }
    }
    return [...new Set(raw as string[])]
  }
  const fieldIds = readIds(reconcile.fieldIds, 'fieldIds')
  const roleIds = readIds(reconcile.roleIds, 'roleIds')

  const fieldSet = new Set(fieldIds)
  const roleSet = new Set(roleIds)
  for (const entry of entries) {
    if (!fieldSet.has(entry.fieldId)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        `entry field ${entry.fieldId} is outside the declared reconcile region`,
        [entry.fieldId],
      )
    }
    if (!roleSet.has(entry.roleId)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        `entry role ${entry.roleId} is outside the declared reconcile region`,
        [entry.roleId],
      )
    }
  }
  return { fieldIds, roleIds }
}

/**
 * The 备料 host capability: declare, per ROLE, which columns that role may NOT WRITE.
 *
 * Read the file header before changing anything here — in particular the load-bearing
 * write-only property.
 */
export class StockPreparationFieldPermissionsService {
  /**
   * CAPABILITY MARKER, not a feature flag. A duck-typed consumer cannot otherwise tell a host that
   * HONOURS `reconcile` from one that silently ignores it — and the difference is a rehearsal that
   * promises removals from one that promises nothing. Absent on every older host, so a consumer that
   * checks it degrades explicitly instead of assuming.
   */
  readonly supportsWriteScopeReconcile = true as const

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
    const { sheetId, entries, packId, reconcile } = normalizeInput(input)
    // NOTHING TO WRITE AND NO REGION is the one total no-op: no statement of any kind runs. It adds
    // no restriction and removes none, so it can never be the unsafe direction in either sense.
    //
    // NOTHING TO WRITE **WITH** A REGION IS NOT A NO-OP, and treating it as one was a real silent
    // failure: a pack revision that hands every governed column to every declared role derives ZERO
    // denials, so an entries-empty call is exactly how "this rectangle should now hold no denial at
    // all" is expressed. Short-circuiting it left the previous revision's rows in force and locked
    // those columns for every role the new revision names as their owner.
    if (entries.length === 0 && !reconcile) return { applied: 0, entries: [], removed: [] }

    /** What this call stamps, and — with the legacy marker — the whole of what it may retire. */
    const createdBy = stockPreparationFieldPermissionCreatedBy(packId)

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
        // DO UPDATE SET — it is not a bind parameter and never can be a caller's choice. The five
        // bind parameters are (sheet_id, field_id, subject_id, created_by, legacy_marker);
        // `subject_type`, `visible` and `read_only` are literals. See the file header's load-bearing
        // property before touching this statement.
        //
        // PROVENANCE IS NOT RE-STAMPED ON A ROW THIS PORT DOES NOT ALREADY OWN. An unconditional
        // `created_by = EXCLUDED.created_by` laundered an OPERATOR's row into a plugin row the
        // moment a pack happened to re-declare the same (column, role) — and a later revision's
        // reconcile then deleted the operator's decision, because `created_by` had become this
        // port's. The CASE adopts exactly the two markers the reconcile below may also delete
        // (this pack's own, and the pack-less LEGACY marker that has no other owner); every other
        // value — an operator's, another pack's, NULL — is left standing, which keeps
        // "never an operator's row" a property of the data rather than of the caller's luck.
        await query(
          `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only, created_by)
           VALUES ($1, $2, 'role', $3, true, true, $4)
           ON CONFLICT (sheet_id, field_id, subject_type, subject_id)
           DO UPDATE SET visible = true, read_only = true,
             created_by = CASE
               WHEN field_permissions.created_by = $4 THEN $4
               WHEN field_permissions.created_by = $5 THEN $4
               ELSE field_permissions.created_by
             END`,
          [
            sheetId,
            entry.fieldId,
            entry.roleId,
            createdBy,
            STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY,
          ],
        )
      }

      // THE SCOPED RECONCILE. Same transaction as the upserts above, so there is no instant at which
      // a denial has been dropped but its replacement not yet written. Read the file header's five
      // narrowings before touching this statement — each `AND` is one of them:
      //   sheet_id    → never another sheet (the ONLY project/tenant bound this table can carry);
      //   created_by  → never an operator's row, and never another PACK's row;
      //   read_only   → never a row an operator relaxed;
      //   field_id/subject_id = ANY(region) → never outside what this call re-declares in full;
      //   NOT EXISTS(desired) → never a row this same call just wrote.
      // `visible` appears nowhere here either: removing a row can only widen access, never hide.
      const removed: StockPreparationRoleWriteScopeEntry[] = []
      if (reconcile) {
        const removedRes = await query(
          `DELETE FROM field_permissions
            WHERE sheet_id = $1
              AND subject_type = 'role'
              AND created_by = ANY($2::text[])
              AND read_only = true
              AND field_id = ANY($3::text[])
              AND subject_id = ANY($4::text[])
              AND NOT EXISTS (
                SELECT 1 FROM unnest($5::text[], $6::text[]) AS desired(field_id, subject_id)
                 WHERE desired.field_id = field_permissions.field_id
                   AND desired.subject_id = field_permissions.subject_id
              )
            RETURNING field_id, subject_id`,
          [
            sheetId,
            // EXACTLY the two markers this call is entitled to retire: its own pack's rows, and
            // pack-less LEGACY rows (written before the marker carried a pack id, so no other pack
            // can claim them). A sibling pack's rows carry `<base>#<other>` and are unreachable.
            // When no packId was supplied both entries are the legacy marker, so the set is exactly
            // the old single-marker predicate — byte-equivalent for every pre-pack caller.
            [...new Set([createdBy, STOCK_PREPARATION_FIELD_PERMISSION_CREATED_BY])],
            reconcile.fieldIds,
            reconcile.roleIds,
            entries.map((entry) => entry.fieldId),
            entries.map((entry) => entry.roleId),
          ],
        )
        for (const row of removedRes.rows as Array<{ field_id?: unknown; subject_id?: unknown }>) {
          removed.push({ fieldId: String(row.field_id), roleId: String(row.subject_id) })
        }
        removed.sort((left, right) => (left.fieldId === right.fieldId
          ? left.roleId.localeCompare(right.roleId)
          : left.fieldId.localeCompare(right.fieldId)))
      }

      return { applied: entries.length, entries, removed }
    })
  }

  /**
   * THE PROVENANCE CENSUS, in-process: every (column, role) pair THIS port has ever denied on this
   * sheet. READ-ONLY — one `SELECT`, no lock, no write.
   *
   * TWO PROJECTIONS, ONE SELECT. `entries` is what THIS PLUGIN wrote, each row attributed to the
   * pack whose marker it carries (`packId: null` = a legacy, pack-less row). `foreignEntries` is
   * every other role-scoped denial on the sheet — an operator's own rows above all. They are
   * separated rather than merged because a caller must be able to say "a human holds this
   * (column, role)" without ever treating a deliberate operator decision as installer debris, and
   * must never claim or delete it; and they are separated rather than dropped because a caller that
   * cannot see them cannot report them either.
   *
   * `read_only = true` is part of the predicate: a row this port wrote and an operator later
   * relaxed is no longer a write denial, so it is in neither list.
   */
  async listRoleWriteScopes(input: ListRoleWriteScopesInput): Promise<ListRoleWriteScopesResult> {
    if (!input || !isNonEmptyString(input.sheetId)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        'sheetId must be a non-empty string',
      )
    }
    const sheetId = input.sheetId
    const pool = this.injectedPool ?? (poolManager.get() as unknown as StockPreparationFieldPermissionsPool)
    return pool.transaction(async ({ query }) => {
      // ONE SELECT, two projections. Every role-scoped write denial on the sheet is read, then split
      // by provenance in JS rather than by a second query — so "what this plugin wrote" and "what
      // somebody else wrote" are answered from the SAME snapshot and cannot disagree.
      const res = await query(
        `SELECT field_id, subject_id, created_by FROM field_permissions
          WHERE sheet_id = $1 AND subject_type = 'role' AND read_only = true
          ORDER BY field_id, subject_id`,
        [sheetId],
      )
      const entries: RoleWriteScopeCensusEntry[] = []
      const foreignEntries: RoleWriteScopeForeignEntry[] = []
      for (const raw of res.rows as Array<{ field_id?: unknown; subject_id?: unknown; created_by?: unknown }>) {
        const fieldId = String(raw.field_id)
        const roleId = String(raw.subject_id)
        const { isPluginRow, packId } = parseStockPreparationFieldPermissionCreatedBy(raw.created_by)
        if (isPluginRow) {
          entries.push({ fieldId, roleId, createdBy: String(raw.created_by), packId })
        } else {
          foreignEntries.push({
            fieldId,
            roleId,
            createdBy: typeof raw.created_by === 'string' ? raw.created_by : null,
          })
        }
      }
      return { sheetId, entries, foreignEntries }
    })
  }

  /**
   * "Which of these role ids does this host NOT have?" READ-ONLY — one `SELECT`, no lock, no write.
   *
   * Same question `applyRoleWriteScopes` answers internally (ROLE_NOT_FOUND), exposed so a caller
   * can ask it BEFORE it starts creating columns rather than discovering it after. An empty input
   * is a no-op that returns no missing ids.
   */
  async findMissingRoleIds(input: FindMissingRoleIdsInput): Promise<FindMissingRoleIdsResult> {
    if (!input || !Array.isArray(input.roleIds)) {
      throw new StockPreparationFieldPermissionsError(
        'ENTRIES_INVALID',
        'roleIds must be an array',
      )
    }
    const roleIds = [...new Set(input.roleIds)]
    for (const roleId of roleIds) {
      if (!isNonEmptyString(roleId)) {
        throw new StockPreparationFieldPermissionsError(
          'ENTRIES_INVALID',
          'every roleId must be a non-empty string',
        )
      }
    }
    if (roleIds.length === 0) return { missing: [] }

    const pool = this.injectedPool ?? (poolManager.get() as unknown as StockPreparationFieldPermissionsPool)
    return pool.transaction(async ({ query }) => {
      const res = await query('SELECT id FROM roles WHERE id = ANY($1::text[])', [roleIds])
      const known = new Set((res.rows as Array<{ id?: unknown }>).map((row) => String(row.id)))
      return { missing: roleIds.filter((roleId) => !known.has(roleId)).sort() }
    })
  }
}
