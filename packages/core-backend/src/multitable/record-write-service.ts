/**
 * RecordWriteService — shared write-path for multitable record mutations.
 *
 * Extracts the 6-step record-patch pipeline from the PATCH route handler
 * in `univer-meta.ts` so that both REST and the future Yjs CRDT bridge
 * can share the same transactional write semantics.
 *
 * Steps:
 * 1. DB transaction (SELECT FOR UPDATE → version check → field-type handling → data || patch::jsonb → link mutation → version++)
 * 2. Computed field recalculation (lookup/rollup via applyLookupRollup)
 * 3. Related record recomputation (cross-sheet dependent lookup/rollup)
 * 4. Link/attachment summary rebuild
 * 5. Realtime broadcast
 * 6. EventBus emit (webhook/automation trigger)
 */

import type { EventBus } from '../integration/events/event-bus'
import { publishMultitableSheetRealtime } from './realtime-publish'
import {
  createYjsInvalidationPostCommitHook,
  type RecordPostCommitContext,
  type RecordPostCommitHook,
  type YjsInvalidator,
} from './post-commit-hooks'
import { BATCH1_FIELD_TYPES, coerceBatch1Value, normalizeMultiSelectValue, validateLongTextValue } from './field-codecs'
import { recordRecordRevision } from './record-history-service'

// ---------------------------------------------------------------------------
// Shared types (mirrors the ones in univer-meta.ts to avoid coupling)
// ---------------------------------------------------------------------------

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type TransactionHandler<T> = (client: { query: QueryFn }) => Promise<T>

/** Minimal pool interface required by the service. */
export interface ConnectionPool {
  query: QueryFn
  transaction: <T>(handler: TransactionHandler<T>) => Promise<T>
}

export type UniverMetaField = {
  id: string
  name: string
  type:
    | 'string'
    | 'number'
    | 'boolean'
    | 'date'
    | 'formula'
    | 'select'
    | 'multiSelect'
    | 'link'
    | 'lookup'
    | 'rollup'
    | 'attachment'
    | 'currency'
    | 'percent'
    | 'rating'
    | 'url'
    | 'email'
    | 'phone'
    | 'longText'
    | 'createdTime'
    | 'modifiedTime'
    | 'createdBy'
    | 'modifiedBy'
  options?: Array<{ value: string; color?: string }>
  order?: number
  property?: Record<string, unknown>
}

export type UniverMetaRecord = {
  id: string
  version: number
  data: Record<string, unknown>
  createdBy?: string | null
}

export type LinkFieldConfig = {
  foreignSheetId: string
  limitSingleRecord: boolean
}

export type RelationalLinkField = { fieldId: string; cfg: LinkFieldConfig }

export type LinkedRecordSummary = {
  id: string
  display: string
}

export type MultitableAttachment = {
  id: string
  filename: string
  mimeType: string
  size: number
  url: string
  thumbnailUrl: string | null
  uploadedAt: string | null
}

// ---------------------------------------------------------------------------
// Error types (re-exported so callers don't need to import from univer-meta)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export type RecordChange = {
  recordId?: string
  fieldId: string
  value: unknown
  expectedVersion?: number
}

export type MultitableCapabilities = {
  canRead: boolean
  canCreateRecord: boolean
  canEditRecord: boolean
  canDeleteRecord: boolean
  canManageFields: boolean
  canManageSheetAccess: boolean
  canManageViews: boolean
  canComment: boolean
  canManageAutomation: boolean
  canExport: boolean
}

export type SheetPermissionScope = {
  hasAssignments: boolean
  canRead: boolean
  canWrite: boolean
  canWriteOwn: boolean
  canAdmin: boolean
}

export type AccessInfo = {
  userId: string
  permissions: string[]
  isAdminRole: boolean
}

export type FieldMutationGuard = {
  type: UniverMetaField['type']
  options?: string[]
  readOnly: boolean
  hidden: boolean
  link?: LinkFieldConfig | null
  /** Sanitized property for field types whose write path needs config. */
  property?: Record<string, unknown>
}

export interface RecordPatchInput {
  sheetId: string
  changesByRecord: Map<string, RecordChange[]>
  actorId: string | null
  fields: UniverMetaField[]
  visiblePropertyFields: UniverMetaField[]
  visiblePropertyFieldIds: Set<string>
  attachmentFields: UniverMetaField[]
  fieldById: Map<string, FieldMutationGuard>
  capabilities: MultitableCapabilities
  sheetScope?: SheetPermissionScope
  access: AccessInfo
  /**
   * Write origin. Default (unset or `'rest'`) triggers post-commit Yjs
   * invalidation so any persisted Y.Doc state for the affected records
   * is wiped — next `getOrCreateDoc` re-seeds from `meta_records.data`.
   *
   * The `YjsRecordBridge` sets this to `'yjs-bridge'` on its own flushes
   * because those writes originate from the in-memory Y.Doc; destroying
   * that doc immediately after would tear out a live editor's state.
   */
  source?: RecordPostCommitContext['source']
}

export interface RecordPatchResult {
  updated: Array<{ recordId: string; version: number }>
  records?: Array<{ recordId: string; data: Record<string, unknown> }>
  linkSummaries?: Record<string, unknown>
  attachmentSummaries?: Record<string, unknown>
  relatedRecords?: Array<{ sheetId: string; recordId: string; data: Record<string, unknown> }>
}

// ---------------------------------------------------------------------------
// Injectable helpers — these live in univer-meta.ts and depend on `req`
// ---------------------------------------------------------------------------

/** Helpers injected at construction time so we don't couple to Express `req`. */
export interface RecordWriteHelpers {
  normalizeLinkIds: (value: unknown) => string[]
  normalizeAttachmentIds: (value: unknown) => string[]
  normalizeJson: (value: unknown) => Record<string, unknown>
  parseLinkFieldConfig: (property: unknown) => LinkFieldConfig | null
  buildId: (prefix: string) => string
  ensureRecordWriteAllowed: (
    capabilities: MultitableCapabilities,
    sheetScope: SheetPermissionScope | undefined,
    access: AccessInfo,
    createdBy: string | null | undefined,
    action: 'edit' | 'delete',
  ) => boolean
  filterRecordDataByFieldIds: (data: unknown, allowedFieldIds: Set<string>) => Record<string, unknown>
  extractLookupRollupData: (fields: UniverMetaField[], rowData: Record<string, unknown>) => Record<string, unknown>
  mergeComputedRecords: (
    base: Array<{ recordId: string; data: Record<string, unknown> }> | undefined,
    extra: Array<{ recordId: string; data: Record<string, unknown> }>,
  ) => Array<{ recordId: string; data: Record<string, unknown> }> | undefined
  filterRecordFieldSummaryMap: <T>(
    summaryMap: Record<string, Record<string, T>> | undefined,
    allowedFieldIds: Set<string>,
  ) => Record<string, Record<string, T>> | undefined
  serializeLinkSummaryMap: (
    linkSummaries: Map<string, Map<string, LinkedRecordSummary[]>>,
  ) => Record<string, Record<string, LinkedRecordSummary[]>>
  serializeAttachmentSummaryMap: (
    attachmentSummaries: Map<string, Map<string, MultitableAttachment[]>>,
  ) => Record<string, Record<string, MultitableAttachment[]>>

  /** Async helpers that depend on `req` context (permission resolution). */
  applyLookupRollup: (
    query: QueryFn,
    fields: UniverMetaField[],
    rows: UniverMetaRecord[],
    relationalLinkFields: RelationalLinkField[],
    linkValuesByRecord: Map<string, Map<string, string[]>>,
  ) => Promise<void>
  computeDependentLookupRollupRecords: (
    query: QueryFn,
    updatedRecordIds: string[],
  ) => Promise<Array<{ sheetId: string; recordId: string; data: Record<string, unknown> }>>
  loadLinkValuesByRecord: (
    query: QueryFn,
    recordIds: string[],
    relationalLinkFields: RelationalLinkField[],
  ) => Promise<Map<string, Map<string, string[]>>>
  buildLinkSummaries: (
    query: QueryFn,
    rows: UniverMetaRecord[],
    relationalLinkFields: RelationalLinkField[],
    linkValuesByRecord: Map<string, Map<string, string[]>>,
  ) => Promise<Map<string, Map<string, LinkedRecordSummary[]>>>
  buildAttachmentSummaries: (
    query: QueryFn,
    sheetId: string,
    rows: UniverMetaRecord[],
    attachmentFields: UniverMetaField[],
  ) => Promise<Map<string, Map<string, MultitableAttachment[]>>>
  ensureAttachmentIdsExist: (
    query: QueryFn,
    sheetId: string,
    fieldId: string,
    ids: string[],
  ) => Promise<string | null>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class RecordWriteService {
  constructor(
    private pool: ConnectionPool,
    private eventBus: EventBus,
    private helpers: RecordWriteHelpers,
    /**
     * Post-commit hooks run after the DB transaction succeeds but before
     * realtime + eventBus notifications fan out. This keeps authoritative
     * state cleanup in one seam without coupling the service to Yjs.
     */
    private postCommitHooks: RecordPostCommitHook[] = [],
  ) {}

  /**
   * Replace post-commit hooks after construction. Used when downstream
   * infrastructure (for example Yjs invalidation) wires later in boot.
   */
  setPostCommitHooks(hooks: RecordPostCommitHook[]): void {
    this.postCommitHooks = [...hooks]
  }

  /**
   * Back-compat shim for callers that still think in terms of "the Yjs
   * invalidator". New wiring should prefer `setPostCommitHooks(...)`.
   */
  setYjsInvalidator(invalidator: YjsInvalidator | null): void {
    this.setPostCommitHooks(invalidator ? [createYjsInvalidationPostCommitHook(invalidator)] : [])
  }

  /**
   * Validate all changes before executing the write pipeline.
   *
   * Checks:
   * - expectedVersion consistency (no multiple different versions per record)
   * - Field existence (fieldId must be in fieldById)
   * - Field writability (not hidden, not readOnly, not lookup/rollup)
   * - Select option whitelist
   * - Link single-record constraint and ID length
   * - Attachment ID length and existence
   *
   * Throws RecordValidationError or RecordFieldForbiddenError on failure.
   */
  async validateChanges(input: {
    sheetId: string
    changesByRecord: Map<string, RecordChange[]>
    fieldById: Map<string, FieldMutationGuard>
  }): Promise<void> {
    const { sheetId, changesByRecord, fieldById } = input
    const h = this.helpers

    for (const [recordId, changes] of changesByRecord.entries()) {
      // expectedVersion consistency: reject multiple different values for same record
      const expectedVersions = Array.from(
        new Set(changes.map((c) => c.expectedVersion).filter((v): v is number => typeof v === 'number')),
      )
      if (expectedVersions.length > 1) {
        throw new RecordValidationError(
          `Multiple expectedVersion values provided for ${recordId}`,
        )
      }

      for (const change of changes) {
        const field = fieldById.get(change.fieldId)
        if (!field) {
          throw new RecordValidationError(`Unknown fieldId: ${change.fieldId}`)
        }

        if (field.hidden) {
          throw new RecordFieldForbiddenError(`Field is hidden: ${change.fieldId}`, change.fieldId, 'FIELD_HIDDEN')
        }

        if (field.readOnly === true) {
          throw new RecordFieldForbiddenError(`Field is readonly: ${change.fieldId}`, change.fieldId)
        }

        if (field.type === 'lookup' || field.type === 'rollup') {
          throw new RecordFieldForbiddenError(`Field is readonly: ${change.fieldId}`, change.fieldId)
        }

        if (field.type === 'select') {
          if (typeof change.value !== 'string') {
            throw new RecordValidationError(`Select value must be string: ${change.fieldId}`)
          }
          const allowed = new Set(field.options ?? [])
          if (change.value !== '' && !allowed.has(change.value)) {
            throw new RecordValidationError(`Invalid select option for ${change.fieldId}: ${change.value}`)
          }
        }

        if (field.type === 'multiSelect') {
          try {
            normalizeMultiSelectValue(change.value, change.fieldId, field.options ?? [])
          } catch (error) {
            throw new RecordValidationError(error instanceof Error ? error.message : String(error))
          }
        }

        if (field.type === 'link') {
          if (field.link) {
            const ids = h.normalizeLinkIds(change.value)
            if (field.link.limitSingleRecord && ids.length > 1) {
              throw new RecordValidationError(`Link field only allows a single record: ${change.fieldId}`)
            }
            const tooLong = ids.find((id) => id.length > 50)
            if (tooLong) {
              throw new RecordValidationError(`Link id too long (>50): ${tooLong}`)
            }
          } else if (typeof change.value !== 'string') {
            throw new RecordValidationError(`Link value must be string: ${change.fieldId}`)
          }
        }

        if (field.type === 'attachment') {
          const ids = h.normalizeAttachmentIds(change.value)
          const tooLong = ids.find((id) => id.length > 100)
          if (tooLong) {
            throw new RecordValidationError(`Attachment id too long: ${tooLong}`)
          }
          const attachmentError = await h.ensureAttachmentIdsExist(
            this.pool.query.bind(this.pool) as unknown as QueryFn,
            sheetId,
            change.fieldId,
            ids,
          )
          if (attachmentError) {
            throw new RecordValidationError(attachmentError)
          }
        }

        if (field.type === 'longText') {
          try {
            validateLongTextValue(change.value, change.fieldId)
          } catch (error) {
            throw new RecordValidationError(error instanceof Error ? error.message : String(error))
          }
        }
      }
    }
  }

  /**
   * Complete record-patch pipeline.
   *
   * Steps:
   * 0. Validate changes (field writability, value constraints, expectedVersion consistency)
   * 1. DB transaction: SELECT FOR UPDATE → version check → field-type handling
   *    → `data || patch::jsonb` → link mutation → version++
   * 2. Post-commit hooks (best effort, immediately after commit)
   * 3. Computed field recalculation (lookup/rollup)
   * 4. Related record recomputation (cross-sheet)
   * 5. Link/attachment summary rebuild for response
   * 6. Realtime broadcast via `publishMultitableSheetRealtime()`
   * 7. EventBus emit → webhook/automation trigger
   */
  async patchRecords(input: RecordPatchInput): Promise<RecordPatchResult> {
    const {
      sheetId,
      changesByRecord,
      actorId,
      fields,
      visiblePropertyFields,
      visiblePropertyFieldIds,
      attachmentFields,
      fieldById,
      capabilities,
      sheetScope,
      access,
      source,
    } = input

    const h = this.helpers

    // -----------------------------------------------------------------------
    // Step 0: Validate changes (field writability + value constraints)
    // -----------------------------------------------------------------------
    await this.validateChanges({ sheetId, changesByRecord, fieldById })

    // -----------------------------------------------------------------------
    // Step 1: DB transaction
    // -----------------------------------------------------------------------
    const updates = await this.pool.transaction(async ({ query }) => {
      const updated: Array<{ recordId: string; version: number }> = []

      for (const [recordId, changes] of changesByRecord.entries()) {
        const expectedVersion = Array.from(
          new Set(changes.map((c) => c.expectedVersion).filter((v): v is number => typeof v === 'number')),
        )[0]

        const recordRes = await query(
          'SELECT id, version, data, created_by FROM meta_records WHERE sheet_id = $1 AND id = $2 FOR UPDATE',
          [sheetId, recordId],
        )
        if ((recordRes.rows as any[]).length === 0) {
          throw new RecordNotFoundError(`Record not found: ${recordId}`)
        }
        const recordRow: any = (recordRes.rows as any[])[0]

        if (
          !h.ensureRecordWriteAllowed(
            capabilities,
            sheetScope,
            access,
            typeof recordRow?.created_by === 'string' ? recordRow.created_by : null,
            'edit',
          )
        ) {
          throw new RecordValidationError(`Record editing is not allowed for ${recordId}`)
        }

        const serverVersion = Number(recordRow?.version ?? 1)
        if (typeof expectedVersion === 'number' && expectedVersion !== serverVersion) {
          throw new VersionConflictError(recordId, serverVersion)
        }
        const previousData = h.normalizeJson(recordRow?.data)

        const patch: Record<string, unknown> = {}
        const linkUpdates = new Map<string, { ids: string[]; cfg: LinkFieldConfig }>()
        let applied = 0

        for (const change of changes) {
          const field = fieldById.get(change.fieldId)
          if (!field) continue

          if (field.type === 'formula') {
            if (typeof change.value !== 'string') continue
            if (change.value !== '' && !change.value.startsWith('=')) continue
          }

          if (field.type === 'link' && field.link) {
            const ids = h.normalizeLinkIds(change.value)
            patch[change.fieldId] = ids
            linkUpdates.set(change.fieldId, { ids, cfg: field.link })
            applied += 1
            continue
          }

          if (field.type === 'attachment') {
            patch[change.fieldId] = h.normalizeAttachmentIds(change.value)
            applied += 1
            continue
          }

          if (field.type === 'multiSelect') {
            try {
              patch[change.fieldId] = normalizeMultiSelectValue(change.value, change.fieldId, field.options ?? [])
            } catch (error) {
              throw new RecordValidationError(error instanceof Error ? error.message : String(error))
            }
            applied += 1
            continue
          }

          if (field.type === 'longText') {
            try {
              patch[change.fieldId] = validateLongTextValue(change.value, change.fieldId)
            } catch (error) {
              throw new RecordValidationError(error instanceof Error ? error.message : String(error))
            }
            applied += 1
            continue
          }

          if (BATCH1_FIELD_TYPES.has(field.type)) {
            try {
              patch[change.fieldId] = coerceBatch1Value(field.type, field.property, change.fieldId, change.value)
            } catch (error) {
              throw new RecordValidationError(error instanceof Error ? error.message : String(error))
            }
            applied += 1
            continue
          }

          patch[change.fieldId] = change.value
          applied += 1
        }

        if (applied === 0) continue

        // Validate link targets exist
        for (const { ids, cfg } of linkUpdates.values()) {
          if (ids.length === 0) continue
          const exists = await query(
            'SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
            [cfg.foreignSheetId, ids],
          )
          const found = new Set((exists as any).rows.map((r: any) => String(r.id)))
          const missing = ids.filter((id) => !found.has(id))
          if (missing.length > 0) {
            throw new RecordValidationError(
              `Linked record(s) not found in sheet ${cfg.foreignSheetId}: ${missing.join(', ')}`,
            )
          }
        }

        // Apply patch
        const updateRes = await query(
          `UPDATE meta_records
           SET data = data || $1::jsonb, updated_at = now(), version = version + 1, modified_by = $4
           WHERE sheet_id = $2 AND id = $3
           RETURNING version`,
          [JSON.stringify(patch), sheetId, recordId, actorId],
        )
        if ((updateRes.rows as any[]).length === 0) {
          throw new RecordNotFoundError(`Record not found: ${recordId}`)
        }
        const nextVersion = Number((updateRes.rows[0] as any).version)
        await recordRecordRevision(query, {
          sheetId,
          recordId,
          version: nextVersion,
          action: 'update',
          source: source ?? 'rest',
          actorId,
          changedFieldIds: Object.keys(patch),
          patch,
          snapshot: { ...previousData, ...patch },
        })

        // Sync link table
        if (linkUpdates.size > 0) {
          for (const [fieldId, { ids }] of linkUpdates.entries()) {
            if (ids.length === 0) {
              try {
                await query('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2', [fieldId, recordId])
              } catch (err) {
                throw err
              }
              continue
            }

            let existingIds: string[] = []
            try {
              const current = await query(
                'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2',
                [fieldId, recordId],
              )
              existingIds = (current as any).rows.map((r: any) => String(r.foreign_record_id))
            } catch (err) {
              throw err
            }

            const existing = new Set(existingIds)
            const next = new Set(ids)
            const toDelete = existingIds.filter((id) => !next.has(id))
            const toInsert = ids.filter((id) => !existing.has(id))

            if (toDelete.length > 0) {
              try {
                await query(
                  'DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY($3::text[])',
                  [fieldId, recordId, toDelete],
                )
              } catch (err) {
                throw err
              }
            }

            for (const foreignId of toInsert) {
              try {
                await query(
                  `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT DO NOTHING`,
                  [h.buildId('lnk').slice(0, 50), fieldId, recordId, foreignId],
                )
              } catch (err) {
                throw err
              }
            }
          }
        }

        updated.push({ recordId, version: nextVersion })
      }

      return updated
    })

    // -----------------------------------------------------------------------
    // Step 2: Post-commit hooks (best effort, immediately after commit)
    // -----------------------------------------------------------------------
    if (this.postCommitHooks.length > 0 && updates.length > 0) {
      const context: RecordPostCommitContext = {
        recordIds: updates.map((update) => update.recordId),
        sheetId,
        actorId,
        source: input.source,
      }
      for (const hook of this.postCommitHooks) {
        try {
          await hook(context)
        } catch (err) {
          console.error(
            `[record-write] Post-commit hook failed for records ${context.recordIds.join(',')} — downstream state may be stale until the next successful sync:`,
            err,
          )
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step 3: Computed field recalculation (lookup / rollup)
    // -----------------------------------------------------------------------
    let computedRecords: Array<{ recordId: string; data: Record<string, unknown> }> | undefined
    let updatedRowsForSummaries: UniverMetaRecord[] = []
    const computedFieldIds = visiblePropertyFields.filter((f) => f.type === 'lookup' || f.type === 'rollup')

    if (updates.length > 0 && (computedFieldIds.length > 0 || attachmentFields.length > 0)) {
      const recordIds = updates.map((u) => u.recordId)
      const recordRes = await this.pool.query(
        'SELECT id, version, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
        [sheetId, recordIds],
      )
      const rows = (recordRes.rows as any[]).map((row) => ({
        id: String(row.id),
        version: Number(row.version ?? 0),
        data: h.normalizeJson(row.data),
      })) as UniverMetaRecord[]
      updatedRowsForSummaries = rows

      const relationalLinkFields = fields
        .map((f) => (f.type === 'link' ? { fieldId: f.id, cfg: h.parseLinkFieldConfig(f.property) } : null))
        .filter((v): v is { fieldId: string; cfg: LinkFieldConfig } => !!v && !!v.cfg)

      const linkValuesByRecord = await h.loadLinkValuesByRecord(
        this.pool.query.bind(this.pool),
        rows.map((r) => r.id),
        relationalLinkFields,
      )

      await h.applyLookupRollup(
        this.pool.query.bind(this.pool),
        fields,
        rows,
        relationalLinkFields,
        linkValuesByRecord,
      )

      for (const row of rows) {
        row.data = h.filterRecordDataByFieldIds(row.data, visiblePropertyFieldIds)
      }

      if (computedFieldIds.length > 0) {
        computedRecords = rows.map((row) => ({
          recordId: row.id,
          data: h.extractLookupRollupData(visiblePropertyFields, row.data),
        }))
      }
    }

    // -----------------------------------------------------------------------
    // Step 4: Related record recomputation (cross-sheet)
    // -----------------------------------------------------------------------
    const relatedRecords =
      updates.length > 0
        ? await h.computeDependentLookupRollupRecords(
            this.pool.query.bind(this.pool),
            updates.map((u) => u.recordId),
          )
        : []

    const sameSheetRelated = relatedRecords
      .filter((record) => record.sheetId === sheetId)
      .map((record) => ({
        recordId: record.recordId,
        data: h.filterRecordDataByFieldIds(record.data, visiblePropertyFieldIds),
      }))
    const crossSheetRelated = relatedRecords.filter((record) => record.sheetId !== sheetId)
    const mergedRecords = h.mergeComputedRecords(computedRecords, sameSheetRelated)

    // -----------------------------------------------------------------------
    // Step 5: Link / attachment summary rebuild
    // -----------------------------------------------------------------------
    const relationalLinkFields = fields
      .map((field) => (field.type === 'link' ? { fieldId: field.id, cfg: h.parseLinkFieldConfig(field.property) } : null))
      .filter((value): value is RelationalLinkField => !!value && !!value.cfg)

    const patchLinkSummaries =
      relationalLinkFields.length > 0 && updates.length > 0
        ? h.filterRecordFieldSummaryMap(
            h.serializeLinkSummaryMap(
              await h.buildLinkSummaries(
                this.pool.query.bind(this.pool),
                updates.map((update) => ({ id: update.recordId, version: 0, data: {} })),
                relationalLinkFields,
                await h.loadLinkValuesByRecord(
                  this.pool.query.bind(this.pool),
                  updates.map((update) => update.recordId),
                  relationalLinkFields,
                ),
              ),
            ),
            visiblePropertyFieldIds,
          )
        : undefined

    const patchAttachmentSummaries =
      attachmentFields.length > 0 && updatedRowsForSummaries.length > 0
        ? h.filterRecordFieldSummaryMap(
            h.serializeAttachmentSummaryMap(
              await h.buildAttachmentSummaries(
                this.pool.query.bind(this.pool),
                sheetId,
                updatedRowsForSummaries,
                attachmentFields,
              ),
            ),
            visiblePropertyFieldIds,
          )
        : undefined

    // -----------------------------------------------------------------------
    // Step 6: Realtime broadcast
    // -----------------------------------------------------------------------
    if (updates.length > 0) {
      publishMultitableSheetRealtime({
        spreadsheetId: sheetId,
        actorId,
        source: 'multitable',
        kind: 'record-updated',
        recordIds: updates.map((update) => update.recordId),
        fieldIds: [
          ...new Set(
            Array.from(changesByRecord.values()).flatMap((changes) => changes.map((change) => change.fieldId)),
          ),
        ],
        recordPatches: updates.map((update) => ({
          recordId: update.recordId,
          version: update.version,
          patch: Object.fromEntries(
            (changesByRecord.get(update.recordId) ?? []).map((change) => [change.fieldId, change.value]),
          ),
        })),
      })

      // -------------------------------------------------------------------
      // Step 7: EventBus emit
      // -------------------------------------------------------------------
      for (const update of updates) {
        const changes = Object.fromEntries(
          (changesByRecord.get(update.recordId) ?? []).map((change) => [change.fieldId, change.value]),
        )
        this.eventBus.emit('multitable.record.updated', {
          sheetId,
          recordId: update.recordId,
          changes,
          actorId,
        })
      }
    }

    return {
      updated: updates,
      ...(mergedRecords ? { records: mergedRecords } : {}),
      ...(patchLinkSummaries ? { linkSummaries: patchLinkSummaries } : {}),
      ...(patchAttachmentSummaries ? { attachmentSummaries: patchAttachmentSummaries } : {}),
      ...(crossSheetRelated.length > 0 ? { relatedRecords: crossSheetRelated } : {}),
    }
  }

  // TODO: Extract createRecord() and deleteRecord() methods in a follow-up.
  // The CREATE handler (line ~7050-7080 in univer-meta.ts) and DELETE handler
  // (line ~7130-7160) share a similar eventBus + realtime pattern but have
  // simpler transaction logic. They should be extracted in a future PR to
  // complete the shared write seam.
}
