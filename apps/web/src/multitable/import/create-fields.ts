// Import → "create the missing column as a new text field" plumbing (shared by
// MetaImportModal.vue and MultitableWorkbench.vue).
//
// Call chain this sits in:
//   MetaImportModal  mapXlsxColumnsToFields / paste parse
//     → fieldMapping[columnIndex] = CREATE_FIELD_SENTINEL   (only when the modal was told the
//       caller holds manage-fields; the modal NEVER decides that on its own)
//     → buildImportedRecords() sees `createFieldPlaceholderId(columnIndex)` instead of the sentinel,
//       so the raw cell text lands under a key that can not collide with a real field id
//     → emit('import', { records, rowIndexes, failures, createFields })
//     → MultitableWorkbench.onBulkImport re-checks `caps.canManageFields` (the WRITE-side gate,
//       backed by the server's own 403 on POST /api/multitable/fields), plans the names, creates the
//       fields, rewrites the placeholder keys to the new field ids, and only then imports rows.
//
// The planner below is pure so the naming/limit rules can be tested (and mutated) without a DOM.

import type { ImportBuildResult } from './delimited'

export const CREATE_FIELD_SENTINEL = '__create__'
export const CREATE_FIELD_PLACEHOLDER_PREFIX = '__create__:'

/**
 * Backend caps `GET /api/multitable/fields` at `LIMIT 500` (univer-meta.ts, list fields), so a sheet
 * that grows past 500 fields starts hiding columns from every client. There is no server-side create
 * cap, so this is a FRONTEND pre-check only: it refuses to push a sheet over the line instead of
 * silently creating fields nobody can read back.
 */
export const MAX_SHEET_FIELDS = 500

/** Mirrors the backend zod schema `name: z.string().min(1).max(255)` on POST /api/multitable/fields. */
export const MAX_FIELD_NAME_LENGTH = 255

export type ImportCreateFieldRequest = {
  header: string
  columnIndex: number
}

/** What MetaImportModal emits on `import` — the existing build result plus the create requests. */
export type ImportSubmitPayload = ImportBuildResult & {
  createFields?: ImportCreateFieldRequest[]
}

export type CreateFieldPlan =
  | { ok: true; names: string[] }
  | { ok: false; reason: 'invalid-name'; header: string }
  | { ok: false; reason: 'name-too-long'; header: string }
  | { ok: false; reason: 'field-limit' }

export function createFieldPlaceholderId(columnIndex: number): string {
  return `${CREATE_FIELD_PLACEHOLDER_PREFIX}${columnIndex}`
}

export function isCreateFieldPlaceholderId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(CREATE_FIELD_PLACEHOLDER_PREFIX)
}

/**
 * Decide the field name for every requested column BEFORE any write happens.
 *
 * - Case-insensitive collision check against the sheet's existing field names AND against names
 *   already planned in this same batch (`meta_fields` has no (sheet_id, name) unique index, so the
 *   server would happily create a second "库位"; the 409 on that route only covers id conflicts).
 * - Collisions get a `名称 (2)` / `(3)` … suffix.
 * - Refuses (rather than truncating) when a planned name would exceed the backend's 255-char cap or
 *   when the batch would push the sheet past MAX_SHEET_FIELDS — fail closed, zero partial writes.
 */
export function planCreateFieldNames(params: {
  requests: ImportCreateFieldRequest[]
  existingNames: string[]
  existingFieldCount?: number
}): CreateFieldPlan {
  const { requests, existingNames } = params
  const existingFieldCount = params.existingFieldCount ?? existingNames.length
  if (existingFieldCount + requests.length > MAX_SHEET_FIELDS) {
    return { ok: false, reason: 'field-limit' }
  }

  const taken = new Set<string>()
  for (const name of existingNames) {
    const key = name.trim().toLowerCase()
    if (key) taken.add(key)
  }

  const names: string[] = []
  for (const request of requests) {
    const base = request.header.trim()
    if (!base) return { ok: false, reason: 'invalid-name', header: request.header }
    let candidate = base
    let suffix = 2
    while (taken.has(candidate.toLowerCase())) {
      candidate = `${base} (${suffix})`
      suffix += 1
    }
    if (candidate.length > MAX_FIELD_NAME_LENGTH) {
      return { ok: false, reason: 'name-too-long', header: request.header }
    }
    taken.add(candidate.toLowerCase())
    names.push(candidate)
  }
  return { ok: true, names }
}
