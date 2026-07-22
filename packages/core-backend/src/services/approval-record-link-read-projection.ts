/**
 * FWB-0 Layer 2 — project record-link formSnapshot values for a viewer.
 *
 * Stored form_snapshot freezes `{ recordId }` at submit. On detail/list READ, that raw id
 * must not be returned to a viewer who lacks a FRESH base + sheet + row read authorization
 * on the field's pinned target. Positive control: authorized viewers keep `{ recordId }`.
 *
 * Fail-closed:
 *   - unresolved / null / malformed frozen schema → redact every record-link-shaped value
 *     (top-level and nested detail rows) without relying on schema pins;
 *   - probe error / unreadable → RECORD_LINK_INACCESSIBLE_VALUE (never embeds stored id).
 *
 * Authorization uses the transaction-local record-link path (`approval-record-link-txn-auth`):
 * admin / permission / owner / sheet-scope reads go through the supplied queryFn only.
 */
import type { FormSchema } from '../types/approval-product'
import {
  probeRecordLinkSubmitAuthConstantShape,
  type RecordLinkSubmitAuthDeps,
} from '../multitable/approval-fwb-record-link'
import {
  isRecordReadDeniedForUserStrict,
  loadDeniedRecordIds,
  loadRowLevelReadDenyEnabledStrict,
  type QueryFn,
} from '../multitable/permission-service'
import { acquireRecordLinkRowAuthLockOnQuery } from './approval-record-link-row-auth-lock'
import {
  lockRecordLinkAuthorityRowsOnQuery,
  resolveBaseReadableForUserOnQuery,
  resolveRecordLinkTargetAuthOnQuery,
  resolveSheetCapabilitiesForUserOnQuery,
  userHasApprovalsWriteOnQuery,
} from './approval-record-link-txn-auth'

/** Local structural parse — same contract as ApprovalGraphExecutor.parseRecordLinkFormValue. */
export function parseStoredRecordLinkValue(
  value: unknown,
): { ok: true; recordId: string } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false }
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== 'recordId') return { ok: false }
  const recordId = (value as { recordId?: unknown }).recordId
  if (typeof recordId !== 'string' || !recordId.trim()) return { ok: false }
  return { ok: true, recordId: recordId.trim() }
}

/** True when value is exactly `{ recordId: non-blank string }` (canonical stored shape). */
export function isRecordLinkShapedValue(value: unknown): boolean {
  return parseStoredRecordLinkValue(value).ok
}

/** Values-free redacted shape — never contains a stored recordId. */
export const RECORD_LINK_INACCESSIBLE_VALUE = Object.freeze({ inaccessible: true as const })

function recordLinkAccessKey(baseId: string, sheetId: string, recordId: string): string {
  return JSON.stringify([baseId, sheetId, recordId])
}

/**
 * Fail-closed redaction without schema: walk top-level keys and detail-row arrays,
 * replace every record-link-shaped value with RECORD_LINK_INACCESSIBLE_VALUE.
 * Used when frozen schema is null/unavailable/malformed so raw ids cannot fail-open.
 */
export function redactRecordLinkShapedValuesWithoutSchema(
  formSnapshot: Record<string, unknown>,
): Record<string, unknown> {
  let projected: Record<string, unknown> | null = null
  for (const [key, raw] of Object.entries(formSnapshot)) {
    if (isRecordLinkShapedValue(raw)) {
      if (!projected) projected = { ...formSnapshot }
      projected[key] = RECORD_LINK_INACCESSIBLE_VALUE
      continue
    }
    // Nested detail rows: array of plain objects that may embed record-link shapes.
    if (Array.isArray(raw)) {
      let rowChanged = false
      const nextRows = raw.map((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return row
        const rec = row as Record<string, unknown>
        let nextRow: Record<string, unknown> | null = null
        for (const [cellKey, cell] of Object.entries(rec)) {
          if (isRecordLinkShapedValue(cell)) {
            if (!nextRow) nextRow = { ...rec }
            nextRow[cellKey] = RECORD_LINK_INACCESSIBLE_VALUE
          }
        }
        if (nextRow) {
          rowChanged = true
          return nextRow
        }
        return row
      })
      if (rowChanged) {
        if (!projected) projected = { ...formSnapshot }
        projected[key] = nextRows
      }
    }
  }
  return projected ?? formSnapshot
}

function isWellFormedFormSchema(schema: FormSchema | null | undefined): schema is FormSchema {
  if (!schema || typeof schema !== 'object') return false
  if (!Array.isArray(schema.fields)) return false
  return schema.fields.every(
    (f) => f && typeof f === 'object' && typeof f.id === 'string' && typeof f.type === 'string',
  )
}

function buildSubmitAuthDeps(
  queryFn: QueryFn,
  options: { lockTargetRow: boolean; lockAuthorityRows: boolean; lockRowAuth: boolean },
): RecordLinkSubmitAuthDeps {
  return {
    async sheetBelongsToBase(sheetId, baseId) {
      const sheet = await queryFn(
        `SELECT id FROM meta_sheets WHERE id = $1 AND base_id = $2 AND deleted_at IS NULL`,
        [sheetId, baseId],
      )
      return sheet.rows.length > 0
    },
    lockAuthorityRows: options.lockAuthorityRows
      ? (userId, sheetId, baseId) =>
        lockRecordLinkAuthorityRowsOnQuery(queryFn, { userId, sheetId, baseId })
      : undefined,
    lockRowAuth: options.lockRowAuth
      ? (sheetId, recordId) => acquireRecordLinkRowAuthLockOnQuery(queryFn, sheetId, recordId)
      : undefined,
    async baseReadable(userId, baseId) {
      return resolveBaseReadableForUserOnQuery(queryFn, userId, baseId)
    },
    async resolveSheetCapabilities(sheetId, userId) {
      const resolved = await resolveSheetCapabilitiesForUserOnQuery(queryFn, sheetId, userId)
      return {
        isAdminRole: resolved.isAdminRole,
        capabilities: { canRead: resolved.capabilities.canRead === true },
      }
    },
    isRecordReadDeniedStrict: (sheetId, recordId, userId) =>
      isRecordReadDeniedForUserStrict(queryFn, sheetId, recordId, userId),
    async recordExistsOnSheet(sheetId, recordId) {
      const sql = options.lockTargetRow
        ? `SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE`
        : `SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2`
      const rec = await queryFn(sql, [recordId, sheetId])
      return rec.rows.length > 0
    },
  }
}

/**
 * Shared constant-shape auth probe for one linked record (submit + read projection).
 * When lockTargetRow/lockAuthorityRows are true (create final recheck), authority grant rows,
 * the sheet+record row-auth advisory, and the target record are locked before auth evaluation.
 * Final approvals:write uses txn-local DB/admin only (no request/JWT grants).
 */
export async function probeRecordLinkReadableForUser(
  queryFn: QueryFn,
  input: {
    userId: string
    baseId: string
    sheetId: string
    recordId: string
    lockTargetRow?: boolean
    lockAuthorityRows?: boolean
    /** When true, also require approvals:write from txn-local DB/admin only. */
    requireApprovalsWrite?: boolean
  },
  transcript?: string[],
): Promise<boolean> {
  // Authority locks and target-row locks are independent. Create final recheck enables both
  // explicitly; do NOT couple them (that made lockAuthorityRows:false a no-op and hid broken
  // race tests that only slept).
  const lockTargetRow = input.lockTargetRow === true
  const lockAuthorityRows = input.lockAuthorityRows === true
  // Row-auth advisory accompanies the final create path (target lock) so deny INSERT serializes.
  const lockRowAuth = lockTargetRow
  const deps = buildSubmitAuthDeps(queryFn, { lockTargetRow, lockAuthorityRows, lockRowAuth })
  const ok = await probeRecordLinkSubmitAuthConstantShape(
    deps,
    {
      userId: input.userId,
      baseId: input.baseId,
      sheetId: input.sheetId,
      recordId: input.recordId,
    },
    transcript,
  )
  if (!ok) return false
  if (input.requireApprovalsWrite) {
    transcript?.push('approvals_write')
    return userHasApprovalsWriteOnQuery(queryFn, input.userId)
  }
  return true
}

/**
 * Project (or redact) every top-level record-link field in a form snapshot for `viewerUserId`.
 * - Unresolved schema → fail-closed schema-free redaction of all record-link shapes.
 * - Authorized → keep canonical `{ recordId }`.
 * - Unauthorized / missing / error → RECORD_LINK_INACCESSIBLE_VALUE.
 */
async function projectRecordLinkFormSnapshotWithResolver(
  formSnapshot: Record<string, unknown> | null | undefined,
  formSchema: FormSchema | null | undefined,
  resolveReadable: (baseId: string, sheetId: string, recordId: string) => Promise<boolean>,
): Promise<Record<string, unknown> | null> {
  if (!formSnapshot || typeof formSnapshot !== 'object') return formSnapshot ?? null

  // P1-1: null / malformed / unavailable frozen schema must NOT fail-open raw ids.
  if (!isWellFormedFormSchema(formSchema)) {
    return redactRecordLinkShapedValuesWithoutSchema(formSnapshot)
  }

  const recordLinkFields = formSchema.fields.filter((field) => field.type === 'record-link')
  // Schema present but no declared record-link fields: still strip any leaked shapes.
  if (recordLinkFields.length === 0) {
    return redactRecordLinkShapedValuesWithoutSchema(formSnapshot)
  }

  let projected: Record<string, unknown> | null = null
  const handledFieldIds = new Set<string>()

  for (const field of recordLinkFields) {
    if (!Object.prototype.hasOwnProperty.call(formSnapshot, field.id)) continue
    handledFieldIds.add(field.id)
    const raw = formSnapshot[field.id]
    const parsed = parseStoredRecordLinkValue(raw)
    if (!parsed.ok) {
      if (!projected) projected = { ...formSnapshot }
      projected[field.id] = RECORD_LINK_INACCESSIBLE_VALUE
      continue
    }

    const baseId = typeof field.props?.baseId === 'string' ? field.props.baseId.trim() : ''
    const sheetId = typeof field.props?.sheetId === 'string' ? field.props.sheetId.trim() : ''
    let readable = false
    if (baseId && sheetId) {
      try {
        readable = await resolveReadable(baseId, sheetId, parsed.recordId)
      } catch {
        readable = false
      }
    }

    if (!projected) projected = { ...formSnapshot }
    projected[field.id] = readable
      ? { recordId: parsed.recordId }
      : RECORD_LINK_INACCESSIBLE_VALUE
  }

  // Belt: redact undeclared / nested record-link shapes, but do NOT re-redact fields we
  // already projected under schema pins (authorized { recordId } must survive).
  const base = projected ?? formSnapshot
  const leftover: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(base)) {
    if (handledFieldIds.has(key)) continue
    leftover[key] = value
  }
  if (Object.keys(leftover).length === 0) return base
  const redactedLeftover = redactRecordLinkShapedValuesWithoutSchema(leftover)
  if (redactedLeftover === leftover) return base
  return { ...base, ...redactedLeftover }
}

export async function projectRecordLinkFormSnapshotForViewer(
  formSnapshot: Record<string, unknown> | null | undefined,
  formSchema: FormSchema | null | undefined,
  viewerUserId: string | null | undefined,
  queryFn: QueryFn,
): Promise<Record<string, unknown> | null> {
  const viewer = typeof viewerUserId === 'string' ? viewerUserId.trim() : ''
  return projectRecordLinkFormSnapshotWithResolver(
    formSnapshot,
    formSchema,
    async (baseId, sheetId, recordId) => {
      if (!viewer) return false
      return probeRecordLinkReadableForUser(queryFn, {
        userId: viewer,
        baseId,
        sheetId,
        recordId,
      })
    },
  )
}

/**
 * Batch-project form snapshots for list reads. Loads form schemas by template_version_id
 * when needed so pinned base/sheet props are available. Missing schema → fail-closed redaction.
 */
export async function projectRecordLinkFormSnapshotsForViewerBatch(
  rows: Array<{
    formSnapshot: Record<string, unknown> | null
    templateVersionId: string | null | undefined
  }>,
  viewerUserId: string | null | undefined,
  queryFn: QueryFn,
  formSchemaByVersionId?: Map<string, FormSchema | null>,
): Promise<Array<Record<string, unknown> | null>> {
  const schemaMap = formSchemaByVersionId ?? new Map<string, FormSchema | null>()
  const missingVersionIds = [
    ...new Set(
      rows
        .map((row) => (typeof row.templateVersionId === 'string' ? row.templateVersionId.trim() : ''))
        .filter((id) => id && !schemaMap.has(id)),
    ),
  ]
  if (missingVersionIds.length > 0) {
    const result = await queryFn(
      `SELECT id, form_schema FROM approval_template_versions WHERE id = ANY($1::text[])`,
      [missingVersionIds],
    )
    for (const id of missingVersionIds) schemaMap.set(id, null)
    for (const row of result.rows as Array<{ id?: unknown; form_schema?: unknown }>) {
      if (typeof row.id !== 'string') continue
      const schema = row.form_schema && typeof row.form_schema === 'object' && !Array.isArray(row.form_schema)
        ? (row.form_schema as FormSchema)
        : null
      schemaMap.set(row.id, schema)
    }
  }

  const viewer = typeof viewerUserId === 'string' ? viewerUserId.trim() : ''
  const groups = new Map<string, { baseId: string; sheetId: string; recordIds: Set<string> }>()
  if (viewer) {
    for (const row of rows) {
      if (!row.formSnapshot || typeof row.formSnapshot !== 'object') continue
      const versionId = typeof row.templateVersionId === 'string' ? row.templateVersionId.trim() : ''
      const schema = versionId ? (schemaMap.get(versionId) ?? null) : null
      if (!isWellFormedFormSchema(schema)) continue
      for (const field of schema.fields) {
        if (field.type !== 'record-link') continue
        const parsed = parseStoredRecordLinkValue(row.formSnapshot[field.id])
        const baseId = typeof field.props?.baseId === 'string' ? field.props.baseId.trim() : ''
        const sheetId = typeof field.props?.sheetId === 'string' ? field.props.sheetId.trim() : ''
        if (!parsed.ok || !baseId || !sheetId) continue
        const groupKey = JSON.stringify([baseId, sheetId])
        const group = groups.get(groupKey) ?? { baseId, sheetId, recordIds: new Set<string>() }
        group.recordIds.add(parsed.recordId)
        groups.set(groupKey, group)
      }
    }
  }

  // Approval lists may contain many links into the same sheet. Resolve target authority and the
  // conditional/grant-deny set once per pinned target, then fetch all referenced rows in one query.
  // This avoids N repeated rule evaluations/full-sheet scans while preserving fail-closed output.
  const readableKeys = new Set<string>()
  for (const group of groups.values()) {
    try {
      const auth = await resolveRecordLinkTargetAuthOnQuery(queryFn, {
        userId: viewer,
        baseId: group.baseId,
        sheetId: group.sheetId,
      })
      if (!auth.ok) continue

      let denied = new Set<string>()
      if (!auth.isAdminRole && await loadRowLevelReadDenyEnabledStrict(queryFn, group.sheetId)) {
        denied = await loadDeniedRecordIds(queryFn, group.sheetId, viewer)
      }

      const recordIds = [...group.recordIds]
      const existing = await queryFn(
        `SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])`,
        [group.sheetId, recordIds],
      )
      for (const row of existing.rows as Array<{ id?: unknown }>) {
        const recordId = typeof row.id === 'string' ? row.id : ''
        if (!recordId || denied.has(recordId) || !group.recordIds.has(recordId)) continue
        readableKeys.add(recordLinkAccessKey(group.baseId, group.sheetId, recordId))
      }
    } catch {
      // Whole target group fails closed. No stored id reaches the response.
    }
  }

  const out: Array<Record<string, unknown> | null> = []
  for (const row of rows) {
    const versionId = typeof row.templateVersionId === 'string' ? row.templateVersionId.trim() : ''
    // Explicit null when version missing OR map seeded null — never fail-open.
    const schema = versionId ? (schemaMap.get(versionId) ?? null) : null
    out.push(
      await projectRecordLinkFormSnapshotWithResolver(
        row.formSnapshot,
        schema,
        async (baseId, sheetId, recordId) => (
          readableKeys.has(recordLinkAccessKey(baseId, sheetId, recordId))
        ),
      ),
    )
  }
  return out
}
