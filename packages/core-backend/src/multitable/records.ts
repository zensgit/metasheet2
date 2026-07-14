import { randomUUID } from 'crypto'
import { recordRecordRevision } from './record-history-service'

import {
  acquireAutoNumberSheetWriteLock,
  allocateAutoNumberValues,
} from './auto-number-service'
import { validateLongTextValue } from './field-codecs'
import { fieldTypeRegistry } from './field-type-registry'
import { loadFieldsForSheet, loadSheetRow } from './loaders'
import {
  MultitableRecordDeleteCapExceededError,
  MultitableRecordLockedError,
  MultitableRecordNotFoundError,
  MultitableRecordValidationError,
} from './record-errors'
import { ensureRecordNotLocked, mapRecordLockState } from './record-lock'
import { isFieldAlwaysReadOnly } from './permission-derivation'
import {
  assertTransactionalQuery,
  captureSideDoorInboundTombstones,
  insertSideDoorTrashRow,
  isSideDoorDeleteTrashEnabled,
  resolveSheetBaseIdForTrash,
} from './side-door-delete-trash'
import { TombstoneCaptureCapExceededError } from './tombstone-capture'
import {
  listRecords as listRecordsViaQueryService,
  queryRecords as queryRecordsViaQueryService,
  queryRecordsWithCursor as queryRecordsWithCursorViaQueryService,
  type CursorPaginatedResult,
  type CursorQueryInput,
  type ListMultitableRecordsInput,
  type LoadedMultitableRecord,
  type MultitableRecordsQueryFn,
  type QueryMultitableRecordsInput,
} from './query-service'

export {
  MultitableRecordDeleteCapExceededError,
  MultitableRecordNotFoundError,
  MultitableRecordValidationError,
} from './record-errors'
export { MultitableSideDoorDeleteNonTransactionalError } from './side-door-delete-trash'
export {
  buildRecordsCacheKey,
  decodeRecordCursor,
  encodeRecordCursor,
} from './query-service'
export type {
  CursorPaginatedResult,
  CursorQueryInput,
  ListMultitableRecordsInput,
  LoadedMultitableRecord,
  MultitableRecordFilterValue,
  MultitableRecordQueryOrder,
  MultitableRecordsQueryFn,
  QueryMultitableRecordsInput,
} from './query-service'

export type CreateMultitableRecordInput = {
  query: MultitableRecordsQueryFn
  sheetId: string
  data: Record<string, unknown>
}

export type GetMultitableRecordInput = {
  query: MultitableRecordsQueryFn
  sheetId: string
  recordId: string
}

export type DeleteMultitableRecordInput = {
  query: MultitableRecordsQueryFn
  sheetId: string
  recordId: string
}

export type PatchMultitableRecordInput = {
  query: MultitableRecordsQueryFn
  sheetId: string
  recordId: string
  changes: Record<string, unknown>
}

export type CreatedMultitableRecord = {
  id: string
  sheetId: string
  version: number
  data: Record<string, unknown>
}

export type DeletedMultitableRecord = {
  id: string
  sheetId: string
  version: number
}

type LoadedMultitableField = Awaited<ReturnType<typeof loadFieldsForSheet>>[number]
type LinkFieldConfig = {
  foreignSheetId: string
  limitSingleRecord: boolean
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeNumber(value: unknown, fieldId: string): number {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new MultitableRecordValidationError(`Number value must be finite: ${fieldId}`)
}

function normalizeSelectValue(
  value: unknown,
  fieldId: string,
  options: string[],
): string {
  if (typeof value !== 'string') {
    throw new MultitableRecordValidationError(`Select value must be string: ${fieldId}`)
  }
  if (value === '') return value
  const allowed = new Set(options)
  if (!allowed.has(value)) {
    throw new MultitableRecordValidationError(`Invalid select option for ${fieldId}: ${value}`)
  }
  return value
}

function normalizeMultiSelectValue(
  value: unknown,
  fieldId: string,
  options: string[],
): string[] {
  if (value === null || value === undefined || value === '') return []
  if (!Array.isArray(value)) {
    throw new MultitableRecordValidationError(`Multi-select value must be array: ${fieldId}`)
  }

  const allowed = new Set(options)
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      throw new MultitableRecordValidationError(`Multi-select option must be string: ${fieldId}`)
    }
    const option = String(item).trim()
    if (!option) continue
    if (!allowed.has(option)) {
      throw new MultitableRecordValidationError(`Invalid multi-select option for ${fieldId}: ${option}`)
    }
    if (!seen.has(option)) {
      seen.add(option)
      out.push(option)
    }
  }
  return out
}

function normalizeLinkIds(value: unknown): string[] {
  if (value === null || value === undefined) return []

  const raw: string[] = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') raw.push(item)
      else if (typeof item === 'number' && Number.isFinite(item)) raw.push(String(item))
    }
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    try {
      const parsed = JSON.parse(trimmed)
      raw.push(...normalizeLinkIds(parsed))
    } catch {
      if (trimmed.includes(',')) raw.push(...trimmed.split(','))
      else raw.push(trimmed)
    }
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    raw.push(String(value))
  }

  const seen = new Set<string>()
  return raw
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function readLinkFieldConfig(field: LoadedMultitableField): LinkFieldConfig | null {
  if (field.type !== 'link') return null

  const property = field.property
  const foreignSheetId =
    typeof property?.foreignSheetId === 'string' && property.foreignSheetId.trim()
      ? property.foreignSheetId.trim()
      : typeof property?.foreignDatasheetId === 'string' && property.foreignDatasheetId.trim()
        ? property.foreignDatasheetId.trim()
        : typeof property?.datasheetId === 'string' && property.datasheetId.trim()
          ? property.datasheetId.trim()
          : ''

  if (!foreignSheetId) return null
  return {
    foreignSheetId,
    limitSingleRecord: property?.limitSingleRecord === true,
  }
}

function normalizeFieldValue(
  field: LoadedMultitableField,
  value: unknown,
): unknown {
  if (value === null) {
    return null
  }

  switch (field.type) {
    case 'select':
      return normalizeSelectValue(
        value,
        field.id,
        (field.options ?? []).map((option) => option.value),
      )
    case 'multiSelect':
      return normalizeMultiSelectValue(
        value,
        field.id,
        (field.options ?? []).map((option) => option.value),
      )
    case 'number':
      if (value == null || value === '') return null
      return normalizeNumber(value, field.id)
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new MultitableRecordValidationError(`Boolean value must be boolean: ${field.id}`)
      }
      return value
    case 'string':
    case 'date':
      if (typeof value !== 'string') {
        throw new MultitableRecordValidationError(`String value must be string: ${field.id}`)
      }
      return value
    case 'longText':
      // Route the plugin-SDK record write through the SAME rich-longText sanitizer chokepoint
      // as the HTTP / form-submit / automation paths. Without this case the value fell to the
      // `default:` branch (no `longText` def is registered) and a `{rich:true}` value was stored
      // RAW — a stored-XSS bypass reachable via every plugin's `records.createRecord/patchRecord`.
      return validateLongTextValue(value, field.id, field.property)
    case 'formula':
      if (typeof value !== 'string') {
        throw new MultitableRecordValidationError(`Formula value must be string: ${field.id}`)
      }
      if (value !== '' && !value.startsWith('=')) {
        throw new MultitableRecordValidationError(`Formula must start with "=": ${field.id}`)
      }
      return value
    case 'autoNumber':
      throw new MultitableRecordValidationError(`Field is readonly: ${field.id}`)
    case 'lookup':
    case 'rollup':
    case 'attachment':
      throw new MultitableRecordValidationError(
        `Field type is not supported by multitable.records.createRecord yet: ${field.id}`,
      )
    default: {
      const customDef = fieldTypeRegistry.get(field.type)
      if (customDef) {
        return customDef.validate(value, field.id)
      }
      return value
    }
  }
}

function normalizeRecordData(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch (err) {
      console.warn('[multitable.records] Failed to parse meta_records.data JSON', err)
      return {}
    }
  }
  return {}
}

async function validateLinkIds(
  query: MultitableRecordsQueryFn,
  fieldId: string,
  config: LinkFieldConfig,
  ids: string[],
): Promise<void> {
  if (config.limitSingleRecord && ids.length > 1) {
    throw new MultitableRecordValidationError(`Only one linked record is allowed: ${fieldId}`)
  }
  const tooLong = ids.find((id) => id.length > 50)
  if (tooLong) {
    throw new MultitableRecordValidationError(`Link id too long: ${tooLong}`)
  }
  if (ids.length === 0) return

  const exists = await query(
    'SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
    [config.foreignSheetId, ids],
  )
  const found = new Set((exists.rows as any[]).map((row: any) => String(row.id)))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw new MultitableRecordValidationError(
      `Linked record(s) not found in sheet ${config.foreignSheetId}: ${missing.join(', ')}`,
    )
  }
}

async function buildNormalizedPatch(
  query: MultitableRecordsQueryFn,
  fields: LoadedMultitableField[],
  data: Record<string, unknown>,
): Promise<{
  patch: Record<string, unknown>
  linkUpdates: Map<string, string[]>
}> {
  const fieldById = new Map(fields.map((field) => [field.id, field]))
  const patch: Record<string, unknown> = {}
  const linkUpdates = new Map<string, string[]>()

  for (const [fieldId, rawValue] of Object.entries(data ?? {})) {
    const field = fieldById.get(fieldId)
    if (!field) {
      throw new MultitableRecordValidationError(`Unknown fieldId: ${fieldId}`)
    }
    // Mirror-read-only hardening (C2/I-1): reject a write to an always-read-only field — the mirror side of a
    // twoWay link (`property.mirrorOf`), plus formula/lookup/rollup/system/readOnly — via the CANONICAL guard,
    // parity with record-service.ts:532. Without this the link branch below would write a `meta_links` row keyed
    // by a mirror field id = a second canonical edge (spine-invariant break). A computed/mirror field write was
    // never valid through the SDK, so this only TIGHTENS.
    if (isFieldAlwaysReadOnly(field)) {
      throw new MultitableRecordValidationError(`Field is read-only and cannot be written: ${fieldId}`)
    }
    if (field.type === 'link') {
      const config = readLinkFieldConfig(field)
      if (!config) {
        throw new MultitableRecordValidationError(
          `Link field is missing foreign sheet configuration: ${fieldId}`,
        )
      }
      const ids = normalizeLinkIds(rawValue)
      await validateLinkIds(query, fieldId, config, ids)
      patch[fieldId] = ids
      linkUpdates.set(fieldId, ids)
      continue
    }
    patch[fieldId] = normalizeFieldValue(field, rawValue)
  }

  return { patch, linkUpdates }
}

async function replaceRecordLinks(
  query: MultitableRecordsQueryFn,
  recordId: string,
  linkUpdates: Map<string, string[]>,
): Promise<void> {
  for (const [fieldId, ids] of linkUpdates.entries()) {
    const currentLinks = await query(
      'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2',
      [fieldId, recordId],
    )
    const existingIds = (currentLinks.rows as any[]).map((row: any) => String(row.foreign_record_id))
    const existing = new Set(existingIds)
    const next = new Set(ids)
    const toDelete = existingIds.filter((id) => !next.has(id))
    const toInsert = ids.filter((id) => !existing.has(id))

    if (toDelete.length > 0) {
      await query(
        'DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY($3::text[])',
        [fieldId, recordId, toDelete],
      )
    }

    for (const foreignId of toInsert) {
      await query(
        `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [`lnk_${randomUUID()}`, fieldId, recordId, foreignId],
      )
    }
  }
}

async function loadSheetAndFields(
  query: MultitableRecordsQueryFn,
  sheetId: string,
): Promise<{
  sheet: Awaited<ReturnType<typeof loadSheetRow>>
  fields: LoadedMultitableField[]
}> {
  const sheet = await loadSheetRow(query, sheetId)
  if (!sheet) {
    throw new MultitableRecordNotFoundError(`Sheet not found: ${sheetId}`)
  }
  const fields = await loadFieldsForSheet({ query }, sheetId)
  if (fields.length === 0) {
    throw new MultitableRecordNotFoundError(`Sheet not found: ${sheetId}`)
  }
  return { sheet, fields }
}

export async function getRecord(
  input: GetMultitableRecordInput,
): Promise<LoadedMultitableRecord> {
  const recordRes = await input.query(
    'SELECT id, sheet_id, version, data, locked, locked_by, locked_at FROM meta_records WHERE id = $1 AND sheet_id = $2',
    [input.recordId, input.sheetId],
  )
  const row = (recordRes.rows as any[])[0]
  if (!row) {
    throw new MultitableRecordNotFoundError(`Record not found: ${input.recordId}`)
  }
  return {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    version: Number(row.version ?? 1),
    data: normalizeRecordData(row.data),
    ...mapRecordLockState(row),
  }
}

export async function listRecords(
  input: ListMultitableRecordsInput,
): Promise<LoadedMultitableRecord[]> {
  return listRecordsViaQueryService(input)
}

export async function queryRecords(
  input: QueryMultitableRecordsInput,
): Promise<LoadedMultitableRecord[]> {
  return queryRecordsViaQueryService(input)
}

export async function queryRecordsWithCursor(
  input: CursorQueryInput,
): Promise<CursorPaginatedResult<LoadedMultitableRecord>> {
  return queryRecordsWithCursorViaQueryService(input)
}

/**
 * Plugin-SDK record-lock chokepoint (rank-8 review M1). The plugin path is actor-less — it carries no
 * per-record actor — so `ensureRecordNotLocked(null, …)` rejects ANY edit/delete of a locked record
 * (`canEditWhileLocked(null, …)` is always false). The lock can only be lifted via the explicit unlock
 * action. Reads the lock columns through the same `query` so it participates in the caller's transaction.
 */
async function guardRecordNotLockedForPlugin(
  query: MultitableRecordsQueryFn,
  sheetId: string,
  recordId: string,
): Promise<void> {
  const res = await query(
    'SELECT locked, locked_by, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
    [recordId, sheetId],
  )
  const row = res.rows[0] as { locked?: unknown; locked_by?: unknown; created_by?: unknown } | undefined
  if (!row) return // not found — surfaced later by the caller's own missing-row handling
  ensureRecordNotLocked(null, row, () => new MultitableRecordLockedError('Record is locked'))
}

export async function patchRecord(
  input: PatchMultitableRecordInput,
): Promise<LoadedMultitableRecord> {
  const query = input.query
  const { fields } = await loadSheetAndFields(query, input.sheetId)

  const existing = await getRecord({
    query,
    sheetId: input.sheetId,
    recordId: input.recordId,
  })
  // Record-lock guard (rank-8 review M1; decision d/e). The plugin SDK carries no per-record actor
  // identity → `ensureRecordNotLocked(null, …)` makes a locked record hard read-only to plugins.
  await guardRecordNotLockedForPlugin(query, input.sheetId, input.recordId)
  const { patch, linkUpdates } = await buildNormalizedPatch(query, fields, input.changes)
  const nextData = {
    ...existing.data,
    ...patch,
  }

  // lock-guarded: plugin-SDK patchRecord (M1) — guardRecordNotLockedForPlugin(actor=null) rejected above.
  // revision-emitted: D-1c slice ② (A2) — recordRecordRevision(action:'update', source:'plugin') @559.
  const updated = await query(
    `UPDATE meta_records
     SET data = $1::jsonb, version = version + 1, updated_at = now()
     WHERE id = $2 AND sheet_id = $3
     RETURNING version`,
    [JSON.stringify(nextData), input.recordId, input.sheetId],
  )

  // W0 slice ② required fix (concurrent-delete fail-closed — recycled from Draft #4216's P1 review):
  // `existing` above was read via `getRecord` (a plain SELECT, no `FOR UPDATE`) and
  // `guardRecordNotLockedForPlugin` likewise takes no row lock — so this UPDATE is the FIRST point in
  // this function that actually locks the row, and a concurrent DELETE of this exact record IS reachable
  // in the window between those reads and this statement (unlike the form-submit EDIT branch fixed in
  // slice ①, which already holds a `SELECT ... FOR UPDATE` before its own UPDATE — no such lock exists
  // here). Under READ COMMITTED, if another transaction deletes and commits this row while this UPDATE is
  // blocked behind it, Postgres resumes the UPDATE against zero rows rather than erroring — the original
  // code's `?? existing.version + 1` fallback SILENTLY SYNTHESIZED a version for that case and fell
  // through to write a spurious `update` revision for a record that no longer exists. Because
  // `meta_record_revisions.record_id` carries no FK (migration zzzz20260430172000), that spurious
  // revision would persist forever and could RESURRECT the deleted record via `reconstructRecordsAtT`.
  // Fail closed instead: a zero-row RETURNING throws here, before any revision is written and before
  // `nextVersion` can be synthesized. Proven under genuine two-connection lock contention (not a sleep
  // heuristic) by the concurrent-delete golden in the real-DB suite.
  if ((updated.rows as unknown[]).length === 0) {
    throw new MultitableRecordNotFoundError(`Record not found: ${input.recordId}`)
  }

  const version = Number((updated.rows as any[])[0]?.version ?? existing.version + 1)
  const nextVersion = Number.isFinite(version) ? version : existing.version + 1

  if (linkUpdates.size > 0) {
    await replaceRecordLinks(query, input.recordId, linkUpdates)
  }

  // W0 slice ② (D-1c design-lock, RATIFIED 2026-07-13, §0.5 OD-1..OD-3, §0/§7a site A2 — audited &
  // end-to-end reproduced in the lock's §3 "SIBLING plugin" repro at this exact site): this UPDATE
  // mutated `data` and bumped `version` with NO `meta_record_revisions` row —
  // `reconstructRecordsAtT` (record-reconstructor.ts:34) derives existence+data PURELY from revisions,
  // so it kept returning the PRE-patch value at every T after this patch, forever (the "A2 PIT lie").
  // Emitted in the SAME transaction as the UPDATE above — `index.ts` wraps every plugin-SDK
  // `patchRecord` call in `poolManager.get().transaction(...)` (the SOLE production wiring, re-verified
  // for THIS slice via the real `MetaSheetServer.createCoreAPI()` entry point, not assumed from D-1/D-2)
  // — a failed revision INSERT rolls the UPDATE back too (no half-write).
  // source='plugin' (OD-2 — names the WRITE ENTRY POINT). actorId=null (OD-3): the plugin lane threads no
  // actor identity through this SDK boundary at all (`guardRecordNotLockedForPlugin` above already
  // treats the caller as actor-less, mirroring this module's own delete path's `actorId: null`) — this is
  // "no actor is available", not "a known actor was discarded"; never fabricate a system actor.
  // snapshot=nextData: the FULL merged row (NOT the raw `patch`) — `nextData` is computed above as
  // `{...existing.data, ...patch}` and is exactly what this UPDATE wrote into `data`
  // (`SET data = $1::jsonb` with that same JSON string), so it is the true post-write value, not a
  // re-read. A link-field write already lives inside it (`patch[fieldId] = ids`, buildNormalizedPatch
  // above) — OD-4: the ids land in the ordinary `data` snapshot like any other cell; edge-level
  // `meta_links` history remains a SEPARATE, still-unsolved design-lock, not claimed here.
  await recordRecordRevision(query, {
    sheetId: input.sheetId,
    recordId: input.recordId,
    version: nextVersion,
    action: 'update',
    source: 'plugin',
    actorId: null,
    changedFieldIds: Object.keys(patch),
    patch,
    snapshot: nextData,
  })

  return {
    id: existing.id,
    sheetId: existing.sheetId,
    version: nextVersion,
    data: nextData,
    locked: existing.locked,
    lockedBy: existing.lockedBy,
    lockedAt: existing.lockedAt,
  }
}

export async function createRecord(
  input: CreateMultitableRecordInput,
): Promise<CreatedMultitableRecord> {
  const query = input.query
  await acquireAutoNumberSheetWriteLock(query, input.sheetId)
  const { fields } = await loadSheetAndFields(query, input.sheetId)

  const { patch, linkUpdates } = await buildNormalizedPatch(query, fields, input.data)
  Object.assign(patch, await allocateAutoNumberValues(query, input.sheetId, fields.map((field) => ({
    id: field.id,
    type: field.type,
    property: field.property,
  }))))

  const recordId = `rec_${randomUUID()}`
  // revision-emitted: D-1c slice ② (A5) — recordRecordRevision(action:'create', source:'plugin') @628.
  const inserted = await query(
    `INSERT INTO meta_records (id, sheet_id, data, version)
     VALUES ($1, $2, $3::jsonb, 1)
     RETURNING version`,
    [recordId, input.sheetId, JSON.stringify(patch)],
  )

  // Unlike `patchRecord`'s UPDATE (see the fail-closed comment there), a bare `INSERT ... RETURNING`
  // with no `ON CONFLICT` clause cannot return zero rows without the statement itself throwing — there is
  // no "concurrently deleted" analogue for a row that does not exist yet. No zero-row guard is added here
  // (mirrors slice ①'s form-submit CREATE branch, which likewise added none) — a fabricated symmetry
  // would be dead code, not a fix.
  if (linkUpdates.size > 0) {
    await replaceRecordLinks(query, recordId, linkUpdates)
  }

  const version = Number((inserted.rows as any[])[0]?.version ?? 1)
  const nextVersion = Number.isFinite(version) ? version : 1

  // W0 slice ② (D-1c design-lock, RATIFIED 2026-07-13, §0.5 OD-1/OD-3, §0/§7a site A5): this INSERT
  // created a brand-new `meta_records` row with NO revision — `reconstructRecordsAtT` derives record
  // EXISTENCE purely from `meta_record_revisions`, so the record was invisible to it at every T, and a
  // Reset-to-T at any T after this create could not distinguish "created after T" from "created before T
  // but never captured" — `computeSheetReset` would push it into the unconditional delete-set and DESTROY
  // a record that legitimately existed at T (§0.5's corrected CREATE risk). Emitted in the SAME
  // transaction as the INSERT above (`index.ts` wraps every plugin-SDK `createRecord` call in
  // `poolManager.get().transaction(...)`, re-verified for THIS slice via the real
  // `MetaSheetServer.createCoreAPI()` entry point). source='plugin' (OD-2). actorId=null (OD-3 — the
  // plugin lane threads no actor identity through this SDK boundary; never fabricated). snapshot=patch:
  // a create's `data` IS the submitted+allocated patch (link ids already folded in via
  // `patch[fieldId]=ids` above, same as the auto-number values just assigned).
  await recordRecordRevision(query, {
    sheetId: input.sheetId,
    recordId,
    version: nextVersion,
    action: 'create',
    source: 'plugin',
    actorId: null,
    changedFieldIds: Object.keys(patch),
    patch,
    snapshot: patch,
  })

  return {
    id: recordId,
    sheetId: input.sheetId,
    version: nextVersion,
    data: patch,
  }
}

/**
 * D-2 flag-ON plugin delete (design-lock #4004 §2, owner-ratified). Full recoverability parity with the
 * UI path: pre-generated anchor → cap-checked inbound capture → links DELETE → delete revision → trash
 * INSERT → record DELETE, all inside the caller's transaction (OD-7 contract, asserted by golden G3).
 *
 * Kept as a SEPARATE function from the flag-off path on purpose (§1.9): the flag-off branch below is the
 * D-1 code verbatim, so byte-identity is guaranteed BY CONSTRUCTION rather than by argument. The two
 * orderings genuinely differ — flag-off keeps D-1's deliberate delete-then-emit fail-safe (safe without a
 * txn), flag-on must emit BEFORE the delete so trash/tombstones have an anchor to hang off (safe only
 * inside a txn, which this module's contract now requires).
 */
async function deleteRecordWithRecoverability(
  input: DeleteMultitableRecordInput,
): Promise<DeletedMultitableRecord> {
  const query = input.query

  // OD-7 LAYER 3 (review P2-1): refuse to run the reordered path outside a transaction, BEFORE any write.
  // Prose + G3 were not enough — G3 supplies its OWN transaction, so it proves atomicity GIVEN a txn, not
  // that the entry wiring provides one (unwrapping index.ts's transaction left every golden green). This
  // check is independent of the entry wiring: it also protects callers that do not exist yet. It is not
  // un-deletable — it is pinned by a no-transaction golden (G16).
  await assertTransactionalQuery(query, 'plugin')

  // FOR UPDATE + the extra columns the trash row needs (created_by / created_at / updated_at) AND the
  // lock columns (see the re-check below). The flag-off path reads only data+version and needs no row
  // lock (it destroys first, asks later).
  const snapshotRes = await query(
    `SELECT data, version, created_by, created_at, updated_at, locked, locked_by
       FROM meta_records
      WHERE id = $1 AND sheet_id = $2
      FOR UPDATE`,
    [input.recordId, input.sheetId],
  )
  const snapshotRow = (snapshotRes.rows as any[])[0] as
    | {
        data?: Record<string, unknown>
        version?: unknown
        created_by?: unknown
        created_at?: Date | string | null
        updated_at?: Date | string | null
        locked?: unknown
        locked_by?: unknown
      }
    | undefined
  // Missing record ⇒ same NotFound contract the flag-off path gets from its 0-row DELETE RETURNING.
  if (!snapshotRow) {
    throw new MultitableRecordNotFoundError(`Record not found: ${input.recordId}`)
  }

  // LOCK TOCTOU CLOSE (owner review, P1). `guardRecordNotLockedForPlugin` above is a PRE-CHECK on an
  // UNLOCKED snapshot — a plain `SELECT locked, locked_by, created_by` with NO `FOR UPDATE`, so it holds
  // no row lock. Between it and this statement a concurrent transaction can COMMIT a lock on the record;
  // the pre-check would still say "unlocked" and this path would destroy a locked row, violating rank-8
  // record-lock semantics. The `FOR UPDATE` above is the first point at which the row is actually pinned,
  // so THAT is where lock authority lives: re-verify here, under the row lock, before any capture /
  // links DELETE / revision / trash / record DELETE. The pre-check stays as a cheap fast path but is NOT
  // the authority. (The automation lane already had this shape: its FOR UPDATE selects the lock columns
  // and re-checks under the row lock.)
  ensureRecordNotLocked(null, snapshotRow, () => new MultitableRecordLockedError('Record is locked'))

  const version = Number(snapshotRow.version ?? 1)
  const serverVersion = Number.isFinite(version) ? version : 1
  const baseId = await resolveSheetBaseIdForTrash(query, input.sheetId)

  // §1.2 anchor: ONE uuid = delete-revision id = trash.delete_revision_id = tombstones.source_revision_id.
  const deleteRevisionId = randomUUID()

  // §1.3 capture BEFORE the links DELETE below destroys both edge directions. No-op unless BOTH flags are
  // on (§1.5 nesting). Over-cap ⇒ throws ⇒ the delete is refused (fail-closed, §1.4) — surfaced to SDK
  // callers as the typed MultitableRecordDeleteCapExceededError (OD-6).
  try {
    await captureSideDoorInboundTombstones(query, {
      sheetId: input.sheetId,
      recordId: input.recordId,
      sourceRevisionId: deleteRevisionId,
    })
  } catch (err) {
    if (err instanceof TombstoneCaptureCapExceededError) {
      throw new MultitableRecordDeleteCapExceededError(err.message, err.totalRows, err.cap)
    }
    throw err
  }

  await query('DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1', [input.recordId])

  await recordRecordRevision(query, {
    sheetId: input.sheetId,
    recordId: input.recordId,
    version: serverVersion,
    action: 'delete',
    source: 'plugin',
    actorId: null,
    changedFieldIds: [],
    patch: {},
    id: deleteRevisionId,
    snapshot: snapshotRow.data ?? null,
  })

  // Fail-closed on a missing trash schema (§1.8): NO 42P01/42703 swallow here, unlike the UI path's
  // never-fail degradation. An operator who opted into recoverability must not get a silent
  // unrecoverable delete — the whole txn rolls back instead (golden G11).
  await insertSideDoorTrashRow(query, {
    recordId: input.recordId,
    sheetId: input.sheetId,
    baseId,
    snapshot: snapshotRow.data ?? null,
    originalVersion: serverVersion,
    createdBy: typeof snapshotRow.created_by === 'string' ? snapshotRow.created_by : null,
    deletedBy: null, // OD-5: the plugin lane is actor-less.
    originalCreatedAt: snapshotRow.created_at ?? null,
    originalUpdatedAt: snapshotRow.updated_at ?? null,
    deleteRevisionId,
  })

  // The SAME guardRecordNotLockedForPlugin(actor=null) call in `deleteRecord` rejects a locked record
  // before EITHER branch is dispatched, so this DELETE carries the identical lock disposition as the
  // flag-off one below.
  // lock-guarded: plugin-SDK deleteRecord, D-2 flag-on path (M1) — guarded in `deleteRecord` above.
  // revision-emitted: plugin delete, D-2 flag-on — recordRecordRevision(action:'delete') @650.
  const deleted = await query(
    `DELETE FROM meta_records
     WHERE id = $1 AND sheet_id = $2
     RETURNING version`,
    [input.recordId, input.sheetId],
  )
  const row = (deleted.rows as any[])[0]
  if (!row) {
    throw new MultitableRecordNotFoundError(`Record not found: ${input.recordId}`)
  }

  return {
    id: input.recordId,
    sheetId: input.sheetId,
    version: Number(row.version ?? serverVersion),
  }
}

/**
 * TRANSACTION CONTRACT (D-2 design-lock OD-7 — normative): `input.query` MUST be transactional. The sole
 * production wiring already satisfies it (every plugin-SDK call is wrapped in
 * `poolManager.get().transaction`, index.ts:651). The D-2 flag-on path REORDERS this delete so the
 * revision + trash row are written BEFORE the record DELETE; without a real transaction a mid-sequence
 * failure would leave the "revision says dead, row still alive" half-state D-1's delete-then-emit
 * ordering was designed to avoid.
 *
 * Three layers enforce it, and you need all three — G3 ALONE DOES NOT GUARD THE WIRING, because it
 * supplies its own transaction and therefore proves atomicity only *given* one:
 *   1. G3a/G3b (real-DB goldens) — the sequence is atomic given a transaction.
 *   2. The real entry points must SUPPLY one, proven behaviourally: G18 drives the actual
 *      `createCoreAPI()` plugin-SDK factory (reds if this call site's `transaction` is unwrapped), and
 *      G15 drives the actual `AutomationService.exec` (reds if `deps.transaction` stops being supplied).
 *   3. `assertTransactionalQuery` — refuses at runtime if a caller does not (pinned by G16 on both lanes).
 * Unwrapping the transaction at the call site leaves G3 GREEN and turns layers 2+3 red. Do not "fix" a
 * red layer-2/3 by relaxing the guard; re-wire the caller.
 */
export async function deleteRecord(
  input: DeleteMultitableRecordInput,
): Promise<DeletedMultitableRecord> {
  const query = input.query
  await loadSheetAndFields(query, input.sheetId)

  // Record-lock guard (rank-8 review M1; decision d). Actor-less plugin path → a locked record cannot
  // be deleted via the SDK (it must be unlocked first through the explicit unlock action).
  await guardRecordNotLockedForPlugin(query, input.sheetId, input.recordId)

  // D-2 (side-door delete recoverability, #4004): opt-in recoverability parity with the UI path. Default
  // OFF ⇒ fall through to the D-1 code below, byte-identically (§1.9).
  if (isSideDoorDeleteTrashEnabled()) {
    return await deleteRecordWithRecoverability(input)
  }

  // D-1 (destruction-path gap audit, owner-ratified): read the row BEFORE destroying anything so the
  // delete revision below can carry the record's final snapshot. PIT/as-of-T existence is derived
  // PURELY from meta_record_revisions — without a delete revision this path left the record "alive"
  // in Global History and every PIT consumer forever.
  const snapshotRes = await query(
    'SELECT data, version FROM meta_records WHERE id = $1 AND sheet_id = $2',
    [input.recordId, input.sheetId],
  )
  const snapshotRow = (snapshotRes.rows as any[])[0] as { data?: Record<string, unknown>; version?: unknown } | undefined

  // 4c-2 scope boundary (design-lock §8) + D-1 update: with the D-2 flag OFF this plugin-SDK delete path
  // EMITS the delete revision (source:'plugin' — PIT correctness, D-1) but writes NO meta_records_trash
  // row and captures NO tombstones — the row stays irrecoverable, independent of
  // MULTITABLE_TOMBSTONE_CAPTURE_ENABLED (D-2 §1.5: capture on this path is NESTED under the D-2 flag, so
  // capture-on alone must not change this branch by so much as one row). Recoverability lives in
  // `deleteRecordWithRecoverability` above, behind MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED.
  await query('DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1', [input.recordId])

  // lock-guarded: plugin-SDK deleteRecord (M1) — guardRecordNotLockedForPlugin(actor=null) rejected above.
  // revision-emitted: plugin delete, D-1 flag-off — recordRecordRevision(action:'delete') @771.
  const deleted = await query(
    `DELETE FROM meta_records
     WHERE id = $1 AND sheet_id = $2
     RETURNING version`,
    [input.recordId, input.sheetId],
  )
  const row = (deleted.rows as any[])[0]
  if (!row) {
    throw new MultitableRecordNotFoundError(`Record not found: ${input.recordId}`)
  }

  // D-1: emit AFTER the hard delete. This ordering is D-1's deliberate fail-safe — if this INSERT fails
  // we degrade to today's missing-revision behavior for one record, never the reverse lie of a delete
  // revision for a row that still exists. Gated on the DELETE having actually removed a row. (D-2/OD-7
  // note: the module now pins a transactional-`query` contract — see `deleteRecord`'s doc-comment — but
  // this flag-off branch is preserved VERBATIM for §1.9 byte-identity, so it keeps the ordering that is
  // safe even without one. Only the flag-on branch relies on the txn.)
  await recordRecordRevision(query, {
    sheetId: input.sheetId,
    recordId: input.recordId,
    version: Number(row.version ?? 1),
    action: 'delete',
    source: 'plugin',
    actorId: null,
    changedFieldIds: [],
    patch: {},
    snapshot: snapshotRow?.data ?? null,
  })

  return {
    id: input.recordId,
    sheetId: input.sheetId,
    version: Number(row.version ?? 1),
  }
}
