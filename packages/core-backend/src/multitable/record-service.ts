import { randomUUID } from 'crypto'

import type { EventBus } from '../integration/events/event-bus'
import type { MultitableCapabilities } from './access'
import {
  ensureAttachmentIdsExist as ensureAttachmentIdsExistShared,
  normalizeAttachmentIds as normalizeAttachmentIdsShared,
} from './attachment-service'
import {
  BATCH1_FIELD_TYPES,
  coerceBatch1Value,
  extractSelectOptions,
  isPersonSingleRecord,
  normalizeMultiSelectValue,
  normalizeJson,
  normalizeJsonArray,
  validateLongTextValue,
  validatePersonValue,
  type MultitableField,
} from './field-codecs'
import { loadSheetMemberUserIdSet } from './permission-service'
import {
  HierarchyCycleError,
  assertNoHierarchyParentCycle,
  buildHierarchyParentOverridesByField,
  collectSameSheetLinkChangeFieldIds,
  loadHierarchyParentFieldIds,
} from './hierarchy-cycle-guard'
import {
  acquireAutoNumberSheetWriteLock,
  allocateAutoNumberValues,
} from './auto-number-service'
import { getDefaultValidationRules, validateRecord } from './field-validation-engine'
import type { FieldValidationConfig } from './field-validation'
import { loadFieldsForSheet } from './loaders'
import {
  createYjsInvalidationPostCommitHook,
  type RecordPostCommitContext,
  type RecordPostCommitHook,
  type YjsInvalidator,
} from './post-commit-hooks'
import { isFieldAlwaysReadOnly, isFieldPermissionHidden } from './permission-derivation'
import { publishMultitableSheetRealtime } from './realtime-publish'
import { recordRecordRevision } from './record-history-service'
import {
  notifyRecordSubscribersBestEffort,
  type NotifyRecordSubscribersInput,
} from './record-subscription-service'
import { ensureRecordWriteAllowed, type AccessInfo, type SheetPermissionScope } from './sheet-capabilities'
import { ensureRecordNotLocked } from './record-lock'

export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type TransactionHandler<T> = (client: { query: QueryFn }) => Promise<T>

export interface ConnectionPool {
  query: QueryFn
  transaction: <T>(handler: TransactionHandler<T>) => Promise<T>
}

export type UniverMetaField = MultitableField

export type LinkFieldConfig = {
  foreignSheetId: string
  limitSingleRecord: boolean
  // Bidirectional / mirror links (design 2026-06-14) — same fields as the route-layer LinkFieldConfig, so
  // the shared parseLinkFieldConfig output type-checks here. On this single-record path `mirrorOf` IS
  // consumed (it is carried into the field guard so isFieldAlwaysReadOnly rejects a write to the derived
  // mirror side); `twoWay`/`mirrorFieldId` are carried for type-parity — the mirror invalidation fan-out
  // they drive lives on the bulk `/patch` path (RecordWriteService), matching the FOL-1 realtime precedent.
  foreignBaseId?: string
  twoWay?: boolean
  mirrorFieldId?: string
  mirrorOf?: string
}

type CreateFieldGuard = {
  type: UniverMetaField['type']
  options?: string[]
  link?: LinkFieldConfig | null
  /**
   * Sanitized property carried for types whose write path or validation
   * needs field-level configuration.
   */
  property?: Record<string, unknown>
}

type FieldMutationGuard = {
  type: UniverMetaField['type']
  options?: string[]
  readOnly: boolean
  hidden: boolean
  link?: LinkFieldConfig | null
  /** Normalized property — carries the longText `rich` flag for the write-path sanitizer. */
  property?: Record<string, unknown>
}

export class VersionConflictError extends Error {
  constructor(
    public recordId: string,
    public serverVersion: number,
  ) {
    super(`Version conflict for ${recordId}`)
    this.name = 'VersionConflictError'
  }
}

export class RecordNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecordNotFoundError'
  }
}

export class RecordValidationError extends Error {
  constructor(
    message: string,
    public code: string = 'VALIDATION_ERROR',
  ) {
    super(message)
    this.name = 'RecordValidationError'
  }
}

export class RecordFieldForbiddenError extends Error {
  constructor(
    message: string,
    public fieldId: string,
    public code: string = 'FIELD_READONLY',
  ) {
    super(message)
    this.name = 'RecordFieldForbiddenError'
  }
}

export class RecordPermissionError extends Error {
  constructor(message = 'Insufficient permissions') {
    super(message)
    this.name = 'RecordPermissionError'
  }
}

export class RecordValidationFailedError extends Error {
  public readonly code = 'VALIDATION_ERROR'
  public readonly statusCode = 422

  constructor(public fieldErrors: unknown) {
    super('Record validation failed')
    this.name = 'RecordValidationFailedError'
  }
}

// #15 recycle bin: undelete attempted on a record id that is currently occupied (id was reused by a new
// CREATE after the delete). Maps to 409 at the route. Conservative default: reject rather than overwrite.
export class RecordRestoreConflictError extends Error {
  public readonly code = 'CONFLICT'
  public readonly statusCode = 409

  constructor(message: string) {
    super(message)
    this.name = 'RecordRestoreConflictError'
  }
}

export class RecordPatchFieldValidationError extends Error {
  public readonly code: string
  public readonly statusCode: number

  constructor(public readonly fieldErrors: Record<string, string>) {
    const messages = Object.values(fieldErrors)
    const hiddenOnly = messages.length > 0 && messages.every((message) => message === 'Field is hidden')
    const readonlyOnly = messages.length > 0 && messages.every((message) => message === 'Field is readonly')
    super(hiddenOnly ? 'Hidden field update rejected' : readonlyOnly ? 'Readonly field update rejected' : 'Validation failed')
    this.name = 'RecordPatchFieldValidationError'
    this.code = hiddenOnly ? 'FIELD_HIDDEN' : readonlyOnly ? 'FIELD_READONLY' : 'VALIDATION_ERROR'
    this.statusCode = hiddenOnly || readonlyOnly ? 403 : 400
  }
}

export type RecordCreateInput = {
  sheetId: string
  data: Record<string, unknown>
  actorId: string | null
  capabilities: MultitableCapabilities
}

export type RecordCreateResult = {
  recordId: string
  version: number
  data: Record<string, unknown>
}

export type RecordDeleteInput = {
  recordId: string
  expectedVersion?: number
  actorId: string | null
  access: AccessInfo
  resolveSheetAccess: (
    sheetId: string,
  ) => Promise<{ capabilities: MultitableCapabilities; sheetScope?: SheetPermissionScope }>
}

export type RecordDeleteResult = {
  recordId: string
  sheetId: string
}

export type RecordPatchInput = {
  recordId: string
  sheetId: string
  data: Record<string, unknown>
  expectedVersion?: number
  actorId?: string | null
  access: AccessInfo
  capabilities: MultitableCapabilities
  sheetScope?: SheetPermissionScope
}

export type RecordPatchResult = {
  recordId: string
  sheetId: string
  version: number
  fields: UniverMetaField[]
  patch: Record<string, unknown>
}

function isUndefinedTableError(err: unknown, tableName: string): boolean {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : null
  const message = typeof (err as { message?: unknown })?.message === 'string' ? (err as { message: string }).message : ''
  if (code === '42P01') return message.includes(tableName)
  return message.includes(`relation \"${tableName}\" does not exist`)
}

// Postgres unique_violation (e.g. a primary-key collision from a TOCTOU race on restore).
function isUniqueViolation(err: unknown): boolean {
  return typeof (err as { code?: unknown })?.code === 'string' && (err as { code: string }).code === '23505'
}

function mapFieldType(type: string): UniverMetaField['type'] {
  const normalized = type.trim().toLowerCase()
  if (normalized === 'number') return 'number'
  if (normalized === 'boolean' || normalized === 'checkbox') return 'boolean'
  if (normalized === 'date') return 'date'
  if (
    normalized === 'datetime' ||
    normalized === 'date_time' ||
    normalized === 'date-time' ||
    normalized === 'timestamp'
  ) {
    return 'dateTime'
  }
  if (normalized === 'formula') return 'formula'
  if (normalized === 'select') return 'select'
  if (
    normalized === 'multiselect' ||
    normalized === 'multi_select' ||
    normalized === 'multi-select'
  ) {
    return 'multiSelect'
  }
  if (normalized === 'link') return 'link'
  // Native person field (人员, design 2026-06-16): first-class type='person' (userId[]),
  // no longer aliased to 'link'. Legacy person stays type='link'+refKind:user (coexistence).
  if (normalized === 'person') return 'person'
  if (normalized === 'lookup') return 'lookup'
  if (normalized === 'rollup') return 'rollup'
  if (normalized === 'attachment') return 'attachment'
  if (normalized === 'currency') return 'currency'
  if (normalized === 'percent') return 'percent'
  if (normalized === 'rating') return 'rating'
  // Native duration (时长, design 2026-06-16): seconds-backed number. This dup mapFieldType
  // has NO registry fallback (returns 'string'), so duration needs an explicit branch here or
  // the runtime read path would silently downgrade it to text. Mirrors the percent/rating lines.
  if (normalized === 'duration') return 'duration'
  if (normalized === 'url') return 'url'
  if (normalized === 'email') return 'email'
  if (normalized === 'phone') return 'phone'
  if (normalized === 'barcode' || normalized === 'bar_code' || normalized === 'bar-code') return 'barcode'
  if (normalized === 'qrcode' || normalized === 'qr_code' || normalized === 'qr-code' || normalized === 'qr') return 'qrcode'
  if (
    normalized === 'location' ||
    normalized === 'geo' ||
    normalized === 'geolocation' ||
    normalized === 'geo_location' ||
    normalized === 'geo-location'
  ) {
    return 'location'
  }
  if (normalized === 'autonumber' || normalized === 'auto_number' || normalized === 'auto-number') return 'autoNumber'
  if (normalized === 'createdtime' || normalized === 'created_time' || normalized === 'created-time') return 'createdTime'
  if (normalized === 'modifiedtime' || normalized === 'modified_time' || normalized === 'modified-time') return 'modifiedTime'
  if (normalized === 'createdby' || normalized === 'created_by' || normalized === 'created-by') return 'createdBy'
  if (normalized === 'modifiedby' || normalized === 'modified_by' || normalized === 'modified-by') return 'modifiedBy'
  if (
    normalized === 'longtext' ||
    normalized === 'long_text' ||
    normalized === 'long-text' ||
    normalized === 'textarea' ||
    normalized === 'multi_line_text' ||
    normalized === 'multiline'
  ) {
    return 'longText'
  }
  return 'string'
}

function parseLinkFieldConfig(property: unknown): LinkFieldConfig | null {
  const obj = normalizeJson(property)
  const foreign = obj.foreignDatasheetId ?? obj.foreignSheetId ?? obj.datasheetId
  if (typeof foreign !== 'string' || foreign.trim().length === 0) return null

  return {
    foreignSheetId: foreign.trim(),
    limitSingleRecord: obj.limitSingleRecord === true,
  }
}

function normalizeLinkIds(value: unknown): string[] {
  if (value === null || value === undefined) return []

  const raw: string[] = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') raw.push(entry)
      else if (typeof entry === 'number' && Number.isFinite(entry)) raw.push(String(entry))
    }
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return []
    const jsonParsed = normalizeJsonArray(trimmed)
    if (jsonParsed.length > 0) raw.push(...jsonParsed)
    else if (trimmed.includes(',')) raw.push(...trimmed.split(','))
    else raw.push(trimmed)
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    raw.push(String(value))
  }

  const seen = new Set<string>()
  return raw
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      if (seen.has(entry)) return false
      seen.add(entry)
      return true
    })
}

function buildCreateFieldGuardMap(rows: unknown[]): Map<string, CreateFieldGuard> {
  const guards = new Map<string, CreateFieldGuard>()

  for (const row of rows as Array<Record<string, unknown>>) {
    const fieldId = typeof row.id === 'string' ? row.id : ''
    if (!fieldId) continue

    const type = mapFieldType(String(row.type ?? 'string'))
    if (type === 'select' || type === 'multiSelect') {
      guards.set(fieldId, {
        type,
        options: extractSelectOptions(row.property)?.map((option) => option.value) ?? [],
      })
      continue
    }

    if (type === 'link') {
      guards.set(fieldId, {
        type,
        link: parseLinkFieldConfig(row.property),
        // Carry the raw property so isFieldAlwaysReadOnly can see `mirrorOf` and reject a write to the
        // DERIVED (mirror) side on the single-record create/patch path (bidirectional links MVP).
        property: normalizeJson(row.property),
      })
      continue
    }

    // Native person (人员) — carry property so the write path reads `limitSingleRecord`.
    if (type === 'person') {
      guards.set(fieldId, { type, property: normalizeJson(row.property) })
      continue
    }

  if (BATCH1_FIELD_TYPES.has(type)) {
      guards.set(fieldId, { type, property: normalizeJson(row.property) })
      continue
    }

    if (type === 'autoNumber') {
      guards.set(fieldId, { type, property: normalizeJson(row.property) })
      continue
    }

    guards.set(fieldId, { type })
  }

  return guards
}

function buildFieldMutationGuardMap(fields: UniverMetaField[]): Map<string, FieldMutationGuard> {
  return new Map(
    fields.map((field) => {
      const property = normalizeJson(field.property)
      const base: FieldMutationGuard = {
        type: field.type,
        readOnly: isFieldAlwaysReadOnly(field),
        hidden: isFieldPermissionHidden(field),
        property,
      }
      if (field.type === 'select') {
        return [field.id, { ...base, options: field.options?.map((option) => option.value) ?? [] }] as const
      }
      if (field.type === 'multiSelect') {
        return [field.id, { ...base, options: field.options?.map((option) => option.value) ?? [] }] as const
      }
      if (field.type === 'link') {
        return [field.id, { ...base, link: parseLinkFieldConfig(property) }] as const
      }
      return [field.id, base] as const
    }),
  )
}

function buildDirectValidationFields(rows: unknown[]) {
  return (rows as Array<Record<string, unknown>>).map((row) => {
    const property = normalizeJson(row.property)
    const fieldType = mapFieldType(String(row.type ?? 'string'))
    const explicitRules = Array.isArray(property.validation) ? property.validation as FieldValidationConfig : undefined
    const defaultRules = getDefaultValidationRules(fieldType, property)
    const mergedRules = explicitRules ?? defaultRules

    return {
      id: String(row.id),
      name: typeof row.name === 'string' && row.name.length > 0 ? row.name : String(row.id),
      type: fieldType,
      config: mergedRules.length > 0 ? { validation: mergedRules } : undefined,
    }
  })
}

/**
 * Optional hook (A-min-create, design #2255) to compute a NEW record's same-record formula
 * fields after insert + meta_links. Injected by the route layer with a req-bound implementation
 * (hydrate lookup/rollup → recalculateRecordFromData); the service never learns req / RBAC /
 * applyLookupRollup. Returns the recomputed formula values per record. Unset = current behavior.
 */
export type FormulaRecalcHook = (
  query: QueryFn,
  sheetId: string,
  recordIds: string[],
) => Promise<Array<{ recordId: string; data: Record<string, unknown> }>>

export class RecordService {
  private formulaRecalcHook?: FormulaRecalcHook

  constructor(
    private pool: ConnectionPool,
    private eventBus: EventBus,
    private postCommitHooks: RecordPostCommitHook[] = [],
  ) {}

  setPostCommitHooks(hooks: RecordPostCommitHook[]): void {
    this.postCommitHooks = [...hooks]
  }

  /** A-min-create: inject the route-supplied formula recalc hook (null clears it). */
  setFormulaRecalcHook(hook: FormulaRecalcHook | null): void {
    this.formulaRecalcHook = hook ?? undefined
  }

  setYjsInvalidator(invalidator: YjsInvalidator | null): void {
    this.setPostCommitHooks(invalidator ? [createYjsInvalidationPostCommitHook(invalidator)] : [])
  }

  async createRecord(input: RecordCreateInput): Promise<RecordCreateResult> {
    const { sheetId, data, actorId, capabilities } = input

    const sheetRes = await this.pool.query(
      'SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
      [sheetId],
    )
    if (sheetRes.rows.length === 0) {
      throw new RecordNotFoundError(`Sheet not found: ${sheetId}`)
    }

    if (!capabilities.canCreateRecord) {
      throw new RecordPermissionError('Insufficient permissions')
    }

    const patch: Record<string, unknown> = {}
    const recordId = `rec_${randomUUID()}`
    const recordRes = await this.pool.transaction(async ({ query }) => {
      await acquireAutoNumberSheetWriteLock(query, sheetId)

      const fieldRes = await query(
        'SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1',
        [sheetId],
      )
      if (fieldRes.rows.length === 0) {
        throw new RecordNotFoundError(`Sheet not found: ${sheetId}`)
      }

      const fieldById = buildCreateFieldGuardMap(fieldRes.rows)
      const linkUpdates = new Map<string, { ids: string[]; cfg: LinkFieldConfig }>()

      // Native person (人员): resolve the sheet member set ONCE (lazily, only on the first person
      // cell write) and reuse it for membership validation — parallel to the link-exists query.
      let personMemberUserIds: Set<string> | null = null
      const resolvePersonMemberUserIds = async (): Promise<Set<string>> => {
        if (personMemberUserIds === null) {
          personMemberUserIds = await loadSheetMemberUserIdSet(query, sheetId)
        }
        return personMemberUserIds
      }

      for (const [fieldId, value] of Object.entries(data)) {
        const field = fieldById.get(fieldId)
        if (!field) {
          throw new RecordValidationError(`Unknown fieldId: ${fieldId}`)
        }

        if (isFieldAlwaysReadOnly(field)) {
          throw new RecordFieldForbiddenError(`Field is readonly: ${fieldId}`, fieldId)
        }

        if (field.type === 'person') {
          try {
            const allowed = await resolvePersonMemberUserIds()
            patch[fieldId] = validatePersonValue(value, fieldId, allowed, isPersonSingleRecord(field.property))
          } catch (error) {
            throw new RecordValidationError(error instanceof Error ? error.message : String(error))
          }
          continue
        }

        if (field.type === 'select') {
          if (typeof value !== 'string') {
            throw new RecordValidationError(`Select value must be string: ${fieldId}`)
          }
          const allowed = new Set(field.options ?? [])
          if (value !== '' && !allowed.has(value)) {
            throw new RecordValidationError(`Invalid select option for ${fieldId}: ${value}`)
          }
        }
        if (field.type === 'multiSelect') {
          try {
            patch[fieldId] = normalizeMultiSelectValue(value, fieldId, field.options ?? [])
          } catch (error) {
            throw new RecordValidationError(error instanceof Error ? error.message : String(error))
          }
          continue
        }

        if (field.type === 'link') {
          if (field.link) {
            const ids = normalizeLinkIds(value)
            if (field.link.limitSingleRecord && ids.length > 1) {
              throw new RecordValidationError(`Link field only allows a single record: ${fieldId}`)
            }
            const tooLong = ids.find((id) => id.length > 50)
            if (tooLong) {
              throw new RecordValidationError(`Link id too long (>50): ${tooLong}`)
            }

            if (ids.length > 0) {
              const exists = await query(
                'SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
                [field.link.foreignSheetId, ids],
              )
              const found = new Set(
                (exists.rows as Array<Record<string, unknown>>)
                  .map((row) => (typeof row.id === 'string' ? row.id : ''))
                  .filter((id) => id.length > 0),
              )
              const missing = ids.filter((id) => !found.has(id))
              if (missing.length > 0) {
                throw new RecordValidationError(
                  `Linked record(s) not found in sheet ${field.link.foreignSheetId}: ${missing.join(', ')}`,
                )
              }
            }

            patch[fieldId] = ids
            linkUpdates.set(fieldId, { ids, cfg: field.link })
            continue
          }

          if (typeof value !== 'string') {
            throw new RecordValidationError(`Link value must be string: ${fieldId}`)
          }
        }

        if (field.type === 'attachment') {
          const ids = normalizeAttachmentIdsShared(value)
          const tooLong = ids.find((id) => id.length > 100)
          if (tooLong) {
            throw new RecordValidationError(`Attachment id too long: ${tooLong}`)
          }
          const attachmentError = await ensureAttachmentIdsExistShared({
            query,
            sheetId,
            fieldId,
            attachmentIds: ids,
          })
          if (attachmentError) {
            throw new RecordValidationError(attachmentError)
          }
          patch[fieldId] = ids
          continue
        }

        if (field.type === 'formula') {
          if (typeof value !== 'string') continue
          if (value !== '' && !value.startsWith('=')) continue
        }

        if (field.type === 'longText') {
          try {
            patch[fieldId] = validateLongTextValue(value, fieldId, field.property)
          } catch (error) {
            throw new RecordValidationError(error instanceof Error ? error.message : String(error))
          }
          continue
        }

        if (BATCH1_FIELD_TYPES.has(field.type)) {
          try {
            patch[fieldId] = coerceBatch1Value(field.type, field.property, fieldId, value)
          } catch (error) {
            throw new RecordValidationError(error instanceof Error ? error.message : String(error))
          }
          continue
        }

        patch[fieldId] = value
      }

      const directValidationResult = validateRecord(
        buildDirectValidationFields(fieldRes.rows),
        patch,
      )
      if (!directValidationResult.valid) {
        throw new RecordValidationFailedError(directValidationResult.errors)
      }

      Object.assign(patch, await allocateAutoNumberValues(query, sheetId, Array.from(fieldById, ([id, field]) => ({
        id,
        type: field.type,
        property: field.property,
      }))))
      const inserted = await query(
        `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
         VALUES ($1, $2, $3::jsonb, 1, $4, $4)
         RETURNING version`,
        [recordId, sheetId, JSON.stringify(patch), actorId],
      )

      if (linkUpdates.size > 0) {
        // Bidirectional / mirror links (design 2026-06-14 §4): a forward link write here changes what the
        // paired mirror RESOLVES TO, but the mirror-sheet realtime invalidation fan-out is wired only on
        // the bulk `/patch` path (RecordWriteService) — which is the grid's write path. This single-record
        // create/patch path, like the existing FOL-1 related-record fan-out (also `/patch`-only — this class
        // has no computeDependentLookupRollupRecords), does NOT push the mirror invalidation. The reverse
        // READ is correct on every path (resolved in loadLinkValuesByRecord), so mirror data is right on the
        // next refetch; only the push is deferred, consistent with the established realtime precedent.
        for (const [fieldId, { ids }] of linkUpdates.entries()) {
          for (const foreignId of ids) {
            await query(
              `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT DO NOTHING`,
              [`lnk_${randomUUID()}`.slice(0, 50), fieldId, recordId, foreignId],
            )
          }
        }
      }

      const version = Number((inserted.rows[0] as { version?: unknown } | undefined)?.version ?? 1)
      await recordRecordRevision(query, {
        sheetId,
        recordId,
        version,
        action: 'create',
        source: 'rest',
        actorId,
        changedFieldIds: Object.keys(patch),
        patch,
        snapshot: patch,
      })

      return inserted
    })

    const version = Number((recordRes.rows[0] as { version?: unknown } | undefined)?.version ?? 1)

    // A-min-create (#2255): compute the new record's same-record formula fields (lookup/rollup
    // hydrated) now that insert + meta_links are committed, and merge the formula values into the
    // response echo. Persistence is done by the hook (recalculateRecordFromData writes formula keys
    // only — lookups are NOT materialized). Best-effort: the record is already committed, so a
    // recalc failure must not fail the create. Hook unset → unchanged behavior.
    let responseData: Record<string, unknown> = patch
    if (this.formulaRecalcHook) {
      try {
        const recomputed = await this.formulaRecalcHook(this.pool.query.bind(this.pool), sheetId, [recordId])
        const formulaValues = recomputed.find((entry) => entry.recordId === recordId)?.data
        if (formulaValues && Object.keys(formulaValues).length > 0) {
          responseData = { ...patch, ...formulaValues }
        }
      } catch (err) {
        console.error(`[record-service] formula recalc hook failed for ${recordId}:`, err)
      }
    }

    publishMultitableSheetRealtime({
      spreadsheetId: sheetId,
      actorId,
      source: 'multitable',
      kind: 'record-created',
      recordId,
      recordIds: [recordId],
      fieldIds: Object.keys(patch),
      recordPatches: [{
        recordId,
        version,
        patch,
      }],
    })
    this.eventBus.emit('multitable.record.created', {
      sheetId,
      recordId,
      data: patch,
      actorId,
    })

    return {
      recordId,
      version,
      data: responseData,
    }
  }

  async deleteRecord(input: RecordDeleteInput): Promise<RecordDeleteResult> {
    const { recordId, expectedVersion, actorId, access, resolveSheetAccess } = input

    const recordRes = await this.pool.query(
      'SELECT id, sheet_id, created_by, locked, locked_by, created_at, updated_at FROM meta_records WHERE id = $1',
      [recordId],
    )
    if (recordRes.rows.length === 0) {
      throw new RecordNotFoundError(`Record not found: ${recordId}`)
    }

    const recordRow = recordRes.rows[0] as Record<string, unknown>
    const sheetId = typeof recordRow.sheet_id === 'string' ? recordRow.sheet_id : ''
    const createdBy = typeof recordRow.created_by === 'string' ? recordRow.created_by : null
    // Captured for the trash row so restore preserves original timestamps (pg returns Date|string).
    const originalCreatedAt = (recordRow.created_at as Date | string | null) ?? null
    const originalUpdatedAt = (recordRow.updated_at as Date | string | null) ?? null
    const { capabilities, sheetScope } = await resolveSheetAccess(sheetId)

    if (!capabilities.canDeleteRecord) {
      throw new RecordPermissionError('Insufficient permissions')
    }

    if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, createdBy, 'delete')) {
      throw new RecordPermissionError('Record deletion is not allowed for this row')
    }

    // Record-lock guard (decision d/e): a locked record cannot be deleted unless the actor is the
    // locker or owner. No silent admin bypass — an admin must explicitly unlock first. Routed through
    // the ONE shared rule (`ensureRecordNotLocked`) so every mutation path enforces it identically.
    ensureRecordNotLocked(actorId, recordRow, () => new RecordPermissionError('Record is locked'))

    await this.pool.transaction(async ({ query }) => {
      const lockedRecordRes = await query(
        'SELECT id, sheet_id, version, data FROM meta_records WHERE id = $1 FOR UPDATE',
        [recordId],
      )
      if (lockedRecordRes.rows.length === 0) {
        throw new RecordNotFoundError(`Record not found: ${recordId}`)
      }

      const currentRow = lockedRecordRes.rows[0] as Record<string, unknown>
      const serverVersion = Number(currentRow.version ?? 1)
      if (typeof expectedVersion === 'number' && expectedVersion !== serverVersion) {
        throw new VersionConflictError(recordId, serverVersion)
      }
      const snapshot = normalizeJson(currentRow.data)

      try {
        await query(
          'DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1',
          [recordId],
        )
      } catch (err) {
        if (!isUndefinedTableError(err, 'meta_links')) throw err
      }

      await recordRecordRevision(query, {
        sheetId,
        recordId,
        version: serverVersion,
        action: 'delete',
        source: 'rest',
        actorId,
        changedFieldIds: [],
        patch: {},
        snapshot,
      })

      // #15 recycle bin: copy the row into the trash table in the SAME txn before the hard delete, so it
      // can be listed + restored. base_id is best-effort. Guarded by isUndefinedTableError so a DB that
      // predates the migration still deletes cleanly (degrades to no-trash, the revision snapshot remains).
      try {
        const baseRow = (await query('SELECT base_id FROM meta_sheets WHERE id = $1', [sheetId])).rows[0] as
          | Record<string, unknown>
          | undefined
        const baseId = baseRow && typeof baseRow.base_id === 'string' ? baseRow.base_id : null
        await query(
          `INSERT INTO meta_records_trash
             (record_id, sheet_id, base_id, data, original_version, created_by, deleted_by, original_created_at, original_updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
          [recordId, sheetId, baseId, JSON.stringify(snapshot), serverVersion, createdBy, actorId, originalCreatedAt, originalUpdatedAt],
        )
      } catch (err) {
        if (!isUndefinedTableError(err, 'meta_records_trash')) throw err
      }

      // lock-guarded: single DELETE — ensureRecordNotLocked enforced above (rejects before this txn).
      await query('DELETE FROM meta_records WHERE id = $1', [recordId])
    })

    publishMultitableSheetRealtime({
      spreadsheetId: sheetId,
      actorId,
      source: 'multitable',
      kind: 'record-deleted',
      recordId,
      recordIds: [recordId],
    })
    this.eventBus.emit('multitable.record.deleted', {
      sheetId,
      recordId,
      actorId,
    })

    return {
      recordId,
      sheetId,
    }
  }

  // #15 recycle bin — list the records deleted from a sheet (newest first). Gated on canDeleteRecord
  // (whoever may delete may view/restore the trash). Returns empty if the trash table predates migration.
  async listDeletedRecords(input: {
    sheetId: string
    access: AccessInfo
    resolveSheetAccess: RecordDeleteInput['resolveSheetAccess']
    limit?: number
    offset?: number
  }): Promise<{
    records: Array<{ recordId: string; sheetId: string; data: Record<string, unknown>; originalVersion: number; createdBy: string | null; deletedBy: string | null; deletedAt: string }>
    total: number
  }> {
    const { sheetId, resolveSheetAccess } = input
    const { capabilities } = await resolveSheetAccess(sheetId)
    if (!capabilities.canDeleteRecord) {
      throw new RecordPermissionError('Insufficient permissions to view deleted records')
    }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
    const offset = Math.max(input.offset ?? 0, 0)
    try {
      const totalRes = await this.pool.query('SELECT COUNT(*)::int AS n FROM meta_records_trash WHERE sheet_id = $1', [sheetId])
      const total = Number((totalRes.rows[0] as { n?: number } | undefined)?.n ?? 0)
      const rowsRes = await this.pool.query(
        `SELECT record_id, sheet_id, data, original_version, created_by, deleted_by, deleted_at
         FROM meta_records_trash WHERE sheet_id = $1 ORDER BY deleted_at DESC LIMIT $2 OFFSET $3`,
        [sheetId, limit, offset],
      )
      const records = (rowsRes.rows as Array<Record<string, unknown>>).map((r) => ({
        recordId: String(r.record_id),
        sheetId: String(r.sheet_id),
        data: normalizeJson(r.data),
        originalVersion: Number(r.original_version ?? 1),
        createdBy: typeof r.created_by === 'string' ? r.created_by : null,
        deletedBy: typeof r.deleted_by === 'string' ? r.deleted_by : null,
        deletedAt: r.deleted_at instanceof Date ? r.deleted_at.toISOString() : String(r.deleted_at ?? ''),
      }))
      return { records, total }
    } catch (err) {
      if (isUndefinedTableError(err, 'meta_records_trash')) return { records: [], total: 0 }
      throw err
    }
  }

  // #15 recycle bin — restore the most-recently-deleted trash row for a record id back into meta_records.
  // Rejects (409) if the id is currently occupied (conservative default: never overwrite a live record).
  async restoreRecord(input: {
    recordId: string
    actorId: string | null
    access: AccessInfo
    resolveSheetAccess: RecordDeleteInput['resolveSheetAccess']
  }): Promise<{ recordId: string; sheetId: string }> {
    const { recordId, actorId, resolveSheetAccess } = input
    const trashRes = await this.pool
      .query(
        `SELECT id, record_id, sheet_id, data, created_by, original_created_at, original_updated_at
         FROM meta_records_trash WHERE record_id = $1 ORDER BY deleted_at DESC LIMIT 1`,
        [recordId],
      )
      .catch((err: unknown) => {
        if (isUndefinedTableError(err, 'meta_records_trash')) return { rows: [] as Array<Record<string, unknown>> }
        throw err
      })
    if (trashRes.rows.length === 0) {
      throw new RecordNotFoundError(`No deleted record to restore: ${recordId}`)
    }
    const trashRow = trashRes.rows[0] as Record<string, unknown>
    const sheetId = String(trashRow.sheet_id)
    const { capabilities } = await resolveSheetAccess(sheetId)
    if (!capabilities.canDeleteRecord) {
      throw new RecordPermissionError('Insufficient permissions to restore records')
    }
    const trashPk = String(trashRow.id)
    const snapshot = normalizeJson(trashRow.data)
    const createdBy = typeof trashRow.created_by === 'string' ? trashRow.created_by : null
    const originalCreatedAt = (trashRow.original_created_at as Date | string | null) ?? null
    const originalUpdatedAt = (trashRow.original_updated_at as Date | string | null) ?? null

    // Orphan guard: refuse to resurrect into a sheet that no longer exists. Sheet delete is a hard delete
    // and meta_records_trash has no FK to meta_sheets, so a trash row can outlive its sheet's cascade.
    const sheetAlive = await this.pool.query('SELECT 1 FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
    if (sheetAlive.rows.length === 0) {
      throw new RecordRestoreConflictError(`Cannot restore: sheet no longer exists: ${sheetId}`)
    }

    // Outbound links: deleteRecord dropped this record's meta_links rows, but the snapshot still carries the
    // link-field arrays (createRecord writes them into data). Rebuild meta_links on restore so link values
    // aren't silently empty on read (loadLinkValuesByRecord reads from meta_links, not data).
    const sheetFields = await loadFieldsForSheet(this.pool.query.bind(this.pool), sheetId)
    const linkFieldIds = sheetFields.filter((f) => f.type === 'link').map((f) => f.id)

    await this.pool.transaction(async ({ query }) => {
      const occupied = await query('SELECT 1 FROM meta_records WHERE id = $1 FOR UPDATE', [recordId])
      if (occupied.rows.length > 0) {
        throw new RecordRestoreConflictError(`Record id is occupied, cannot restore: ${recordId}`)
      }
      let inserted: { rows: Array<{ version?: number }> }
      try {
        inserted = await query(
          `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, created_at, updated_at)
           VALUES ($1, $2, $3::jsonb, 1, $4, $5, COALESCE($6, now()), COALESCE($7, now()))
           RETURNING version`,
          [recordId, sheetId, JSON.stringify(snapshot), createdBy, actorId, originalCreatedAt, originalUpdatedAt],
        )
      } catch (err) {
        // TOCTOU: a concurrent create/restore can take the id between the FOR UPDATE check and this INSERT.
        // The PK still blocks it; map unique_violation to a clean 409 instead of letting a raw 23505 → 500.
        if (isUniqueViolation(err)) {
          throw new RecordRestoreConflictError(`Record id is occupied, cannot restore: ${recordId}`)
        }
        throw err
      }
      // Rebuild outbound meta_links from the restored snapshot (same insert shape as create/patch).
      for (const fieldId of linkFieldIds) {
        for (const foreignId of normalizeLinkIds(snapshot[fieldId])) {
          await query(
            `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [`lnk_${randomUUID()}`.slice(0, 50), fieldId, recordId, foreignId],
          )
        }
      }
      const restoredVersion = Number((inserted.rows[0] as { version?: number } | undefined)?.version ?? 1)
      await recordRecordRevision(query, {
        sheetId,
        recordId,
        version: restoredVersion,
        action: 'create',
        source: 'rest',
        actorId,
        changedFieldIds: Object.keys(snapshot),
        patch: snapshot,
        snapshot,
      })
      await query('DELETE FROM meta_records_trash WHERE id = $1', [trashPk])
    })

    publishMultitableSheetRealtime({
      spreadsheetId: sheetId,
      actorId,
      source: 'multitable',
      kind: 'record-created',
      recordId,
      recordIds: [recordId],
    })
    this.eventBus.emit('multitable.record.created', { sheetId, recordId, actorId })

    return { recordId, sheetId }
  }

  async patchRecord(input: RecordPatchInput): Promise<RecordPatchResult> {
    const { recordId, sheetId, data, expectedVersion, access, capabilities, sheetScope } = input

    if (!capabilities.canEditRecord) {
      throw new RecordPermissionError('Insufficient permissions')
    }
    const patchActorId = input.actorId ?? access.userId ?? null

    const fields = await loadFieldsForSheet(this.pool.query.bind(this.pool), sheetId)
    if (fields.length === 0) {
      throw new RecordNotFoundError(`Sheet not found: ${sheetId}`)
    }

    const fieldById = buildFieldMutationGuardMap(fields)
    const fieldErrors: Record<string, string> = {}
    const patch: Record<string, unknown> = {}
    const linkUpdates = new Map<string, { ids: string[]; cfg: LinkFieldConfig }>()

    // Native person (人员): resolve the sheet member set ONCE (lazily on the first person cell)
    // and reuse it for membership validation.
    let personMemberUserIds: Set<string> | null = null
    const resolvePersonMemberUserIds = async (): Promise<Set<string>> => {
      if (personMemberUserIds === null) {
        personMemberUserIds = await loadSheetMemberUserIdSet(this.pool.query.bind(this.pool), sheetId)
      }
      return personMemberUserIds
    }

    for (const [fieldId, value] of Object.entries(data)) {
      const field = fieldById.get(fieldId)
      if (!field) {
        fieldErrors[fieldId] = 'Unknown field'
        continue
      }
      if (field.hidden) {
        fieldErrors[fieldId] = 'Field is hidden'
        continue
      }
      if (field.readOnly === true || field.type === 'lookup' || field.type === 'rollup') {
        fieldErrors[fieldId] = 'Field is readonly'
        continue
      }
      if (field.type === 'person') {
        try {
          const allowed = await resolvePersonMemberUserIds()
          patch[fieldId] = validatePersonValue(value, fieldId, allowed, isPersonSingleRecord(field.property))
        } catch (error) {
          fieldErrors[fieldId] = error instanceof Error ? error.message : String(error)
        }
        continue
      }
      if (field.type === 'select') {
        if (typeof value !== 'string') {
          fieldErrors[fieldId] = 'Select value must be a string'
          continue
        }
        const allowed = new Set(field.options ?? [])
        if (value !== '' && !allowed.has(value)) {
          fieldErrors[fieldId] = 'Invalid select option'
          continue
        }
      }
      if (field.type === 'multiSelect') {
        try {
          patch[fieldId] = normalizeMultiSelectValue(value, fieldId, field.options ?? [])
        } catch (error) {
          fieldErrors[fieldId] = error instanceof Error ? error.message : String(error)
        }
        continue
      }
      if (field.type === 'link') {
        if (!field.link) {
          fieldErrors[fieldId] = 'Link field is missing foreign sheet configuration'
          continue
        }
        const ids = normalizeLinkIds(value)
        if (field.link.limitSingleRecord && ids.length > 1) {
          fieldErrors[fieldId] = 'Only one linked record is allowed'
          continue
        }
        const tooLong = ids.find((id) => id.length > 50)
        if (tooLong) {
          fieldErrors[fieldId] = `Link id too long: ${tooLong}`
          continue
        }
        if (ids.length > 0) {
          const exists = await this.pool.query(
            'SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
            [field.link.foreignSheetId, ids],
          )
          const found = new Set(
            (exists.rows as Array<Record<string, unknown>>)
              .map((row) => (typeof row.id === 'string' ? row.id : ''))
              .filter((id) => id.length > 0),
          )
          const missing = ids.filter((id) => !found.has(id))
          if (missing.length > 0) {
            fieldErrors[fieldId] = `Linked record not found: ${missing.join(', ')}`
            continue
          }
        }
        patch[fieldId] = ids
        linkUpdates.set(fieldId, { ids, cfg: field.link })
        continue
      }
      if (field.type === 'attachment') {
        const ids = normalizeAttachmentIdsShared(value)
        const tooLong = ids.find((id) => id.length > 100)
        if (tooLong) {
          fieldErrors[fieldId] = `Attachment id too long: ${tooLong}`
          continue
        }
        const attachmentError = await ensureAttachmentIdsExistShared({
          query: this.pool.query.bind(this.pool),
          sheetId,
          fieldId,
          attachmentIds: ids,
        })
        if (attachmentError) {
          fieldErrors[fieldId] = attachmentError
          continue
        }
        patch[fieldId] = ids
        continue
      }
      if (field.type === 'formula') {
        if (typeof value !== 'string') {
          fieldErrors[fieldId] = 'Formula value must be a string'
          continue
        }
        if (value !== '' && !value.startsWith('=')) {
          fieldErrors[fieldId] = 'Formula must start with ='
          continue
        }
      }
      if (field.type === 'longText') {
        try {
          patch[fieldId] = validateLongTextValue(value, fieldId, field.property)
        } catch (error) {
          fieldErrors[fieldId] = error instanceof Error ? error.message : String(error)
        }
        continue
      }
      patch[fieldId] = value
    }

    if (Object.keys(fieldErrors).length > 0) {
      throw new RecordPatchFieldValidationError(fieldErrors)
    }

    const changesByRecord = new Map<string, Array<{ fieldId: string; value: unknown }>>([
      [recordId, Object.entries(data).map(([fieldId, value]) => ({ fieldId, value }))],
    ])
    const sameSheetLinkChangeFieldIds = collectSameSheetLinkChangeFieldIds({
      changesByRecord,
      fieldById,
      sheetId,
    })
    const hierarchyParentFieldIds = sameSheetLinkChangeFieldIds.size > 0
      ? await loadHierarchyParentFieldIds({
          query: this.pool.query.bind(this.pool),
          sheetId,
          fields,
        })
      : new Set<string>()
    const guardedHierarchyParentFieldIds = new Set(
      [...sameSheetLinkChangeFieldIds].filter((fieldId) => hierarchyParentFieldIds.has(fieldId)),
    )
    const hierarchyParentOverridesByField = guardedHierarchyParentFieldIds.size > 0
      ? buildHierarchyParentOverridesByField({
          changesByRecord,
          hierarchyParentFieldIds: guardedHierarchyParentFieldIds,
          normalizeLinkIds,
        })
      : new Map<string, Map<string, string[]>>()

    let nextVersion = 1
    let pendingSubscriberNotification: NotifyRecordSubscribersInput | null = null
    await this.pool.transaction(async ({ query }) => {
      const currentRes = await query(
        'SELECT id, version, data, created_by, locked, locked_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE',
        [recordId, sheetId],
      )
      if (currentRes.rows.length === 0) {
        throw new RecordNotFoundError(`Record not found: ${recordId}`)
      }
      const currentRow = currentRes.rows[0] as Record<string, unknown>
      if (!ensureRecordWriteAllowed(
        capabilities,
        sheetScope,
        access,
        typeof currentRow.created_by === 'string' ? currentRow.created_by : null,
        'edit',
      )) {
        throw new RecordPermissionError('Record editing is not allowed for this row')
      }
      // Record-lock guard (decision d/e): a locked record is read-only unless the actor is the locker
      // or owner. No silent admin bypass — an admin must explicitly unlock first. Routed through the
      // ONE shared rule (`ensureRecordNotLocked`) so every mutation path enforces it identically.
      ensureRecordNotLocked(patchActorId, currentRow, () => new RecordPermissionError('Record is locked'))

      const serverVersion = Number(currentRow.version ?? 1)
      if (typeof expectedVersion === 'number' && expectedVersion !== serverVersion) {
        throw new VersionConflictError(recordId, serverVersion)
      }
      const previousData = normalizeJson(currentRow.data)

      for (const [fieldId, { ids, cfg }] of linkUpdates.entries()) {
        if (ids.length === 0 || !guardedHierarchyParentFieldIds.has(fieldId) || cfg.foreignSheetId !== sheetId) {
          continue
        }
        try {
          await assertNoHierarchyParentCycle({
            query,
            sheetId,
            recordId,
            fieldId,
            parentRecordIds: ids,
            parentOverridesByRecord: hierarchyParentOverridesByField.get(fieldId) ?? new Map(),
            normalizeLinkIds,
          })
        } catch (error) {
          if (error instanceof HierarchyCycleError) {
            throw new RecordValidationError(error.message, error.code)
          }
          throw error
        }
      }

      if (Object.keys(patch).length > 0) {
        // lock-guarded: single PATCH — ensureRecordNotLocked enforced above in this txn.
        const updateRes = await query(
          `UPDATE meta_records
           SET data = data || $1::jsonb, updated_at = now(), version = version + 1, modified_by = $4
           WHERE id = $2 AND sheet_id = $3
           RETURNING version`,
          [JSON.stringify(patch), recordId, sheetId, patchActorId],
        )
        nextVersion = Number((updateRes.rows[0] as { version?: unknown } | undefined)?.version ?? serverVersion)
        const revisionId = await recordRecordRevision(query, {
          sheetId,
          recordId,
          version: nextVersion,
          action: 'update',
          source: 'rest',
          actorId: patchActorId,
          changedFieldIds: Object.keys(patch),
          patch,
          snapshot: { ...previousData, ...patch },
        })
        pendingSubscriberNotification = {
          sheetId,
          recordId,
          eventType: 'record.updated',
          actorId: patchActorId,
          revisionId,
        }
      } else {
        nextVersion = serverVersion
      }

      // Bidirectional / mirror links (design 2026-06-14 §4): same as the create path above — the mirror
      // realtime invalidation fan-out is `/patch`-only (the grid's write path), matching the existing
      // FOL-1 precedent. The reverse READ stays correct here; only the single-record realtime push is deferred.
      for (const [fieldId, { ids }] of linkUpdates.entries()) {
        const currentLinks = await query(
          'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2',
          [fieldId, recordId],
        )
        const existingIds = (currentLinks.rows as Array<Record<string, unknown>>).map((row) => String(row.foreign_record_id))
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
            [`lnk_${randomUUID()}`.slice(0, 50), fieldId, recordId, foreignId],
          )
        }
        if (ids.length === 0) {
          await query('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2', [fieldId, recordId])
        }
      }
    })

    if (pendingSubscriberNotification) {
      await notifyRecordSubscribersBestEffort(
        this.pool.query.bind(this.pool),
        pendingSubscriberNotification,
        'record-service',
      )
    }

    if (this.postCommitHooks.length > 0) {
      const context: RecordPostCommitContext = {
        recordIds: [recordId],
        sheetId,
        actorId: access.userId ?? 'system',
        source: 'rest',
      }
      for (const hook of this.postCommitHooks) {
        try {
          await hook(context)
        } catch (err) {
          console.error(
            `[record-service] Post-commit hook failed for record ${recordId} — downstream state may be stale until the next successful sync:`,
            err,
          )
        }
      }
    }

    const actorId = access.userId ?? 'system'
    publishMultitableSheetRealtime({
      spreadsheetId: sheetId,
      actorId,
      source: 'multitable',
      kind: 'record-updated',
      recordId,
      recordIds: [recordId],
      fieldIds: Object.keys(patch),
      recordPatches: [{
        recordId,
        version: nextVersion,
        patch,
      }],
    })
    this.eventBus.emit('multitable.record.updated', {
      sheetId,
      recordId,
      data: patch,
      actorId,
    })

    return {
      recordId,
      sheetId,
      version: nextVersion,
      fields,
      patch,
    }
  }
}
