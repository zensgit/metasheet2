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
  normalizeMultiSelectValue,
  normalizeJson,
  normalizeJsonArray,
  validateLongTextValue,
  type MultitableField,
} from './field-codecs'
import { allocateAutoNumberValues } from './auto-number-service'
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
  constructor(public fieldErrors: unknown) {
    super('Record validation failed')
    this.name = 'RecordValidationFailedError'
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

function mapFieldType(type: string): UniverMetaField['type'] {
  const normalized = type.trim().toLowerCase()
  if (normalized === 'number') return 'number'
  if (normalized === 'boolean' || normalized === 'checkbox') return 'boolean'
  if (normalized === 'date' || normalized === 'datetime') return 'date'
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
  if (normalized === 'lookup') return 'lookup'
  if (normalized === 'rollup') return 'rollup'
  if (normalized === 'attachment') return 'attachment'
  if (normalized === 'currency') return 'currency'
  if (normalized === 'percent') return 'percent'
  if (normalized === 'rating') return 'rating'
  if (normalized === 'url') return 'url'
  if (normalized === 'email') return 'email'
  if (normalized === 'phone') return 'phone'
  if (normalized === 'barcode' || normalized === 'bar_code' || normalized === 'bar-code') return 'barcode'
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
      })
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

export class RecordService {
  constructor(
    private pool: ConnectionPool,
    private eventBus: EventBus,
    private postCommitHooks: RecordPostCommitHook[] = [],
  ) {}

  setPostCommitHooks(hooks: RecordPostCommitHook[]): void {
    this.postCommitHooks = [...hooks]
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

    const fieldRes = await this.pool.query(
      'SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1',
      [sheetId],
    )
    if (fieldRes.rows.length === 0) {
      throw new RecordNotFoundError(`Sheet not found: ${sheetId}`)
    }

    const fieldById = buildCreateFieldGuardMap(fieldRes.rows)
    const patch: Record<string, unknown> = {}
    const linkUpdates = new Map<string, { ids: string[]; cfg: LinkFieldConfig }>()

    for (const [fieldId, value] of Object.entries(data)) {
      const field = fieldById.get(fieldId)
      if (!field) {
        throw new RecordValidationError(`Unknown fieldId: ${fieldId}`)
      }

      if (isFieldAlwaysReadOnly(field)) {
        throw new RecordFieldForbiddenError(`Field is readonly: ${fieldId}`, fieldId)
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
          query: this.pool.query.bind(this.pool),
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
          patch[fieldId] = validateLongTextValue(value, fieldId)
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

    const recordId = `rec_${randomUUID()}`
    const recordRes = await this.pool.transaction(async ({ query }) => {
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
      data: patch,
    }
  }

  async deleteRecord(input: RecordDeleteInput): Promise<RecordDeleteResult> {
    const { recordId, expectedVersion, actorId, access, resolveSheetAccess } = input

    const recordRes = await this.pool.query(
      'SELECT id, sheet_id, created_by FROM meta_records WHERE id = $1',
      [recordId],
    )
    if (recordRes.rows.length === 0) {
      throw new RecordNotFoundError(`Record not found: ${recordId}`)
    }

    const recordRow = recordRes.rows[0] as Record<string, unknown>
    const sheetId = typeof recordRow.sheet_id === 'string' ? recordRow.sheet_id : ''
    const createdBy = typeof recordRow.created_by === 'string' ? recordRow.created_by : null
    const { capabilities, sheetScope } = await resolveSheetAccess(sheetId)

    if (!capabilities.canDeleteRecord) {
      throw new RecordPermissionError('Insufficient permissions')
    }

    if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, createdBy, 'delete')) {
      throw new RecordPermissionError('Record deletion is not allowed for this row')
    }

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
          patch[fieldId] = validateLongTextValue(value, fieldId)
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

    let nextVersion = 1
    let pendingSubscriberNotification: NotifyRecordSubscribersInput | null = null
    await this.pool.transaction(async ({ query }) => {
      const currentRes = await query(
        'SELECT id, version, data, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE',
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

      const serverVersion = Number(currentRow.version ?? 1)
      if (typeof expectedVersion === 'number' && expectedVersion !== serverVersion) {
        throw new VersionConflictError(recordId, serverVersion)
      }
      const previousData = normalizeJson(currentRow.data)

      if (Object.keys(patch).length > 0) {
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
