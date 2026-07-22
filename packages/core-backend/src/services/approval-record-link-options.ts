/**
 * FWB-0 Layer 2 — dedicated approval record-link candidate picker (server).
 *
 * Scoped to a server-pinned (baseId, sheetId) pair from the form field. Does NOT reuse the
 * multitable link-field /fields/:fieldId/link-options endpoint (no fabricated MetaField).
 *
 * Contract:
 *   - base-read AND sheet-read required (txn-local resolveRecordLinkTargetAuthOnQuery /
 *     resolveBaseReadableForUserOnQuery + resolveSheetCapabilitiesForUserOnQuery);
 *   - sheet must belong to base;
 *   - only rows the actor can read (row-level deny excluded in SQL via one deny-set load);
 *   - display labels ONLY from server-derived visible, non-computed source fields
 *     (loadFieldPermissionScopeMap + deriveFieldPermissions for the actor always — including admins);
 *   - search uses the same effective display expression as response labels, including the
 *     generic '未命名记录' fallback and treating a visible value equal to the record id as blank
 *     (no first-field-only drift; no raw-id fallback / raw-id search leak);
 *   - exact total / hasMore via DB COUNT + LIMIT/OFFSET with shared search WHERE
 *     (P3: under concurrent writes this is non-snapshot — COUNT and SELECT are separate
 *     statements; page membership may drift slightly mid-write, not a frozen MVCC snapshot);
 *   - missing sheet / base mismatch / existing-but-unreadable share one public error shape
 *     (no existence oracle) and run the same base+sheet auth query depth before refusing;
 *   - DB failures return a fixed values-free 503 (never host/port/user/query/raw err.message).
 */
import { pool } from '../db/pg'
import {
  deriveFieldPermissions,
  type FieldLike,
} from '../multitable/permission-derivation'
import { isSystemFieldType } from '../multitable/field-codecs'
import {
  loadDeniedRecordIds,
  loadFieldPermissionScopeMap,
  loadRowLevelReadDenyEnabledStrict,
  type QueryFn,
} from '../multitable/permission-service'
import {
  RECORD_LINK_TARGET_AUTH_STAGES,
  resolveRecordLinkTargetAuthOnQuery,
} from './approval-record-link-txn-auth'

export type ApprovalRecordLinkOption = {
  id: string
  /** Human label only — never a raw record id. */
  display: string
}

export type ApprovalRecordLinkOptionsResult =
  | {
      ok: true
      records: ApprovalRecordLinkOption[]
      page: { limit: number; offset: number; total: number; hasMore: boolean }
    }
  | { ok: false; status: number; code: string; message: string }

/** Values-free label when no allowed visible field has a usable value (never the record id). */
export const APPROVAL_RECORD_LINK_GENERIC_LABEL = '未命名记录'

/** Fixed values-free 503 message — never includes host, port, user, SQL, or raw err.message. */
export const APPROVAL_RECORD_LINK_DATABASE_UNAVAILABLE_MESSAGE = 'Database not available'

/**
 * Multitable display source types eligible for candidate labels.
 * Canonical scalar text type in meta_fields is `string` (field-codecs MultitableFieldType).
 * Legacy aliases (`text`, `singleLineText`, …) remain accepted when present in older fixtures.
 */
const DISPLAY_SOURCE_TYPES = new Set([
  'string',
  'text',
  'textarea',
  'select',
  'number',
  'singleLineText',
  'longText',
])

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parseFieldProperty(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  return {}
}

/** Floor + clamp a numeric page parameter (rejects NaN/∞/fractional SQL LIMIT/OFFSET). */
export function clampPageInt(
  value: unknown,
  fallback: number,
  min: number,
  max?: number,
): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const floored = Math.floor(n)
  if (typeof max === 'number') return Math.min(Math.max(floored, min), max)
  return Math.max(floored, min)
}

/** Computed / system fields must never contribute display values (source fields only). */
export function isComputedOrSystemFieldType(type: string): boolean {
  return type === 'formula' || type === 'lookup' || type === 'rollup' || isSystemFieldType(type)
}

/**
 * Pick a display string from record data using ONLY the allowed preferred field ids
 * (already filtered to visible non-computed source fields). Mirrors the SQL COALESCE chain.
 * Never scans arbitrary JSON keys; never returns the record id.
 * A non-blank visible value that equals `recordId` is treated as blank (same as SQL NULLIF … id).
 */
export function formatApprovalRecordLinkDisplay(
  data: Record<string, unknown> | null | undefined,
  preferredFieldIds: readonly string[],
  recordId?: string,
): string {
  const id = typeof recordId === 'string' ? recordId.trim() : ''
  if (data && typeof data === 'object' && preferredFieldIds.length > 0) {
    for (const fieldId of preferredFieldIds) {
      const raw = data[fieldId]
      if (typeof raw === 'string' && raw.trim()) {
        const trimmed = raw.trim()
        // Effective-label parity: value === record id is not a usable human label.
        if (id && trimmed === id) continue
        return trimmed
      }
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        const asText = String(raw)
        if (id && asText === id) continue
        return asText
      }
    }
  }
  return APPROVAL_RECORD_LINK_GENERIC_LABEL
}

/**
 * Build a parameterized SQL expression for the *effective* display label — the same text the
 * response returns, including the generic fallback and id-equals-value collapse:
 *   COALESCE(NULLIF(NULLIF(BTRIM(data->>$f1), ''), id), …, $<generic>)
 * Empty preferred list → just the bound generic label (never the record id).
 *
 * `startParamIndex` is the next $N (1-based). `bindParams` are appended in order: preferred
 * field ids, then the generic label constant. The row `id` column is referenced by name (not
 * bound) so search / SELECT / COUNT share one expression with response post-processing.
 */
export function buildDisplayLabelSqlExpression(
  preferredFieldIds: readonly string[],
  startParamIndex: number,
): { expression: string; bindParams: string[]; fieldParams: string[] } {
  const fieldParams: string[] = []
  const parts: string[] = []
  let idx = startParamIndex
  for (const fieldId of preferredFieldIds) {
    fieldParams.push(fieldId)
    // Treat blank OR value-equal-to-row-id as missing so search cannot match raw ids that only
    // appear as a field value, and list/search/COUNT share the same effective label.
    parts.push(`NULLIF(NULLIF(BTRIM(data->>$${idx}), ''), id)`)
    idx += 1
  }
  // Final COALESCE arm is the same generic label response rendering uses (parameterized).
  const bindParams = [...fieldParams, APPROVAL_RECORD_LINK_GENERIC_LABEL]
  parts.push(`$${idx}`)
  return {
    expression: parts.length === 1 ? parts[0]! : `COALESCE(${parts.join(', ')})`,
    bindParams,
    fieldParams,
  }
}

/** Public refuse shape for missing sheet / base mismatch / unreadable target (no existence oracle). */
export const APPROVAL_RECORD_LINK_TARGET_UNAVAILABLE = {
  ok: false as const,
  status: 404,
  code: 'NOT_FOUND',
  message: 'Target sheet not found',
}

/**
 * Resolve ordered preferred display field ids the actor may read for labels.
 * Always applies loadFieldPermissionScopeMap for the actor (including admins) — no admin bypass.
 * Only non-computed source fields with layer-2/3 visible=true.
 */
export async function resolveVisibleDisplayFieldIds(
  queryFn: QueryFn,
  sheetId: string,
  userId: string,
  capabilities: { canEditRecord: boolean; canCreateRecord: boolean },
): Promise<string[]> {
  const fieldResult = await queryFn(
    `SELECT id, type, property FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC`,
    [sheetId],
  )
  const fields: FieldLike[] = (fieldResult.rows as Array<{ id?: unknown; type?: unknown; property?: unknown }>)
    .filter((row): row is { id: string; type: string; property?: unknown } => (
      typeof row.id === 'string' && typeof row.type === 'string'
    ))
    .map((row) => ({ id: row.id, type: row.type, property: parseFieldProperty(row.property) }))

  if (fields.length === 0) return []

  // Parity with records-summary / loadAllowedFieldIds: layer-3 scope applies to every actor.
  const fieldScopeMap = await loadFieldPermissionScopeMap(queryFn, sheetId, userId)
  const permissions = deriveFieldPermissions(fields, capabilities, { fieldScopeMap })

  return fields
    .filter((field) => {
      if (isComputedOrSystemFieldType(field.type)) return false
      if (!DISPLAY_SOURCE_TYPES.has(field.type)) return false
      return permissions[field.id]?.visible === true
    })
    .map((field) => field.id)
}

export async function listApprovalRecordLinkOptions(input: {
  userId: string
  baseId: string
  sheetId: string
  search?: string
  limit?: number
  offset?: number
}): Promise<ApprovalRecordLinkOptionsResult> {
  if (!pool) {
    return {
      ok: false,
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: APPROVAL_RECORD_LINK_DATABASE_UNAVAILABLE_MESSAGE,
    }
  }
  const userId = input.userId.trim()
  const baseId = input.baseId.trim()
  const sheetId = input.sheetId.trim()
  if (!userId) {
    return { ok: false, status: 401, code: 'APPROVAL_USER_REQUIRED', message: 'User ID not found in token' }
  }
  if (!baseId || !sheetId) {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'baseId and sheetId are required' }
  }
  const limit = clampPageInt(input.limit, 20, 1, 100)
  const offset = clampPageInt(input.offset, 0, 0)
  const searchRaw = typeof input.search === 'string' ? input.search.trim() : ''
  const search = searchRaw.toLowerCase()

  const queryFn = (sql: string, params?: unknown[]) => pool!.query(sql, params)

  // Constant-shape dual base+sheet auth via txn-local path (no global RBAC cache).
  // Missing sheet / base mismatch / missing base / unreadable always run the same ordered
  // stages (RECORD_LINK_TARGET_AUTH_STAGES) — including admin + permission probes even when
  // the base row is absent — so query depth cannot form an existence oracle.
  const targetAuth = await resolveRecordLinkTargetAuthOnQuery(queryFn, {
    userId,
    baseId,
    sheetId,
  })
  // Defensive: stages length is fixed for parity tests (helper guarantees it).
  if (targetAuth.stages.length !== RECORD_LINK_TARGET_AUTH_STAGES.length) {
    return { ...APPROVAL_RECORD_LINK_TARGET_UNAVAILABLE }
  }
  if (!targetAuth.ok) {
    return { ...APPROVAL_RECORD_LINK_TARGET_UNAVAILABLE }
  }
  const isAdminRole = targetAuth.isAdminRole
  const capabilities = targetAuth.capabilities

  // Visible non-computed source fields for THIS actor (admin included — no field_permissions bypass).
  let preferredFieldIds: string[] = []
  try {
    preferredFieldIds = await resolveVisibleDisplayFieldIds(
      queryFn,
      sheetId,
      userId,
      capabilities,
    )
  } catch {
    preferredFieldIds = []
  }

  // One deny-set load (no per-row N+1). Admins skip deny filtering.
  let deniedIds: string[] = []
  if (!isAdminRole) {
    try {
      const denyEnabled = await loadRowLevelReadDenyEnabledStrict(queryFn, sheetId)
      if (denyEnabled) {
        deniedIds = [...(await loadDeniedRecordIds(queryFn, sheetId, userId))]
      }
    } catch {
      return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' }
    }
  }

  // Base WHERE: sheet + deny exclusion. Display-field params are appended only for queries that
  // reference the COALESCE expression (search WHERE + SELECT label) so COUNT never gets extra binds.
  const baseParams: unknown[] = [sheetId]
  let baseWhere = `sheet_id = $1`
  if (deniedIds.length > 0) {
    baseParams.push(deniedIds)
    baseWhere += ` AND NOT (id = ANY($${baseParams.length}::text[]))`
  }

  // Full param list for SELECT (and search): base + COALESCE binds (fields + generic) + optional
  // pattern + limit/offset. COUNT without search keeps baseParams only so unused binds never land.
  const selectParams: unknown[] = [...baseParams]
  const displaySql = buildDisplayLabelSqlExpression(preferredFieldIds, selectParams.length + 1)
  for (const bind of displaySql.bindParams) selectParams.push(bind)
  const displayExpr = displaySql.expression

  let where = baseWhere
  if (search) {
    selectParams.push(`%${search}%`)
    const patternParam = selectParams.length
    // Same effective display text as SELECT label / response (incl. generic fallback).
    where += ` AND lower(${displayExpr}) LIKE $${patternParam}`
  }

  let total = 0
  try {
    // COUNT uses only baseParams when not searching; search COUNT shares the same WHERE/binds
    // as SELECT (minus limit/offset) for exact total parity.
    const countWhere = search ? where : baseWhere
    const countParams = search ? selectParams : baseParams
    const countRes = await queryFn(
      `SELECT COUNT(*)::int AS n FROM meta_records WHERE ${countWhere}`,
      countParams,
    )
    total = Number((countRes.rows[0] as { n?: unknown } | undefined)?.n ?? 0)
  } catch {
    // Values-free: never echo host/port/user/query/raw driver text to the client.
    return {
      ok: false,
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: APPROVAL_RECORD_LINK_DATABASE_UNAVAILABLE_MESSAGE,
    }
  }

  selectParams.push(limit, offset)
  const limitParam = selectParams.length - 1
  const offsetParam = selectParams.length
  let rows: Array<{ id: string; data: unknown; display_label?: unknown }> = []
  try {
    const recRes = await queryFn(
      `SELECT id, data, ${displayExpr} AS display_label FROM meta_records
       WHERE ${where}
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      selectParams,
    )
    rows = (recRes.rows as Array<{ id?: unknown; data?: unknown; display_label?: unknown }>).map((r) => ({
      id: typeof r.id === 'string' ? r.id : '',
      data: r.data,
      display_label: r.display_label,
    })).filter((r) => r.id)
  } catch {
    // Values-free: never echo host/port/user/query/raw driver text to the client.
    return {
      ok: false,
      status: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: APPROVAL_RECORD_LINK_DATABASE_UNAVAILABLE_MESSAGE,
    }
  }

  const records: ApprovalRecordLinkOption[] = rows.map((row) => {
    // Prefer the SQL effective label (same expression as search); fall back to pure formatter.
    let display = typeof row.display_label === 'string' && row.display_label.trim()
      ? row.display_label.trim()
      : (() => {
          const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data)
            ? (row.data as Record<string, unknown>)
            : {}
          return formatApprovalRecordLinkDisplay(data, preferredFieldIds, row.id)
        })()
    // Never surface a raw record id as the label (belt after SQL effective-label collapse).
    if (display === row.id || !nonBlank(display)) {
      display = APPROVAL_RECORD_LINK_GENERIC_LABEL
    }
    return { id: row.id, display }
  })

  return {
    ok: true,
    records,
    page: {
      limit,
      offset,
      total,
      hasMore: offset + records.length < total,
    },
  }
}
