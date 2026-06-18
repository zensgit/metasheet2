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
import { BATCH1_FIELD_TYPES, coerceBatch1Value, isPersonSingleRecord, normalizeMultiSelectValue, validateLongTextValue, validatePersonValue } from './field-codecs'
import { createPersonMemberResolver, personRestrictGroupIds } from './person-field-restriction'
import {
  HierarchyCycleError,
  assertNoHierarchyParentCycle,
  buildHierarchyParentOverridesByField,
  collectSameSheetLinkChangeFieldIds,
  loadHierarchyParentFieldIds,
} from './hierarchy-cycle-guard'
import { recordRecordRevision } from './record-history-service'
import {
  notifyRecordSubscribersBestEffort,
  type NotifyRecordSubscribersInput,
} from './record-subscription-service'
import { ensureRecordNotLocked } from './record-lock'

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
    | 'dateTime'
    | 'formula'
    | 'select'
    | 'multiSelect'
    | 'link'
    | 'person'
    | 'lookup'
    | 'rollup'
    | 'attachment'
    | 'currency'
    | 'percent'
    | 'rating'
    | 'duration'
    | 'url'
    | 'email'
    | 'phone'
    | 'barcode'
    | 'qrcode'
    | 'location'
    | 'longText'
    | 'autoNumber'
    | 'createdTime'
    | 'modifiedTime'
    | 'createdBy'
    | 'modifiedBy'
    | 'button'
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
  // Bidirectional / mirror links (design 2026-06-14). `twoWay` + `mirrorFieldId` on the forward side drive
  // the reverse-projection invalidation fan-out; `mirrorOf` marks the derived (read-only) side. See the
  // route-layer LinkFieldConfig (univer-meta.ts) for the full semantics — this is the write-service mirror.
  foreignBaseId?: string
  twoWay?: boolean
  mirrorFieldId?: string
  mirrorOf?: string
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
  /**
   * Mutation op. Default (undefined) = 'set'. 'unset' removes the field key from
   * `meta_records.data` entirely (used by record-level version restore — Layer 1 —
   * to reproduce a prior version that did not have the field). For 'unset', `value`
   * is ignored. Removal is gated by the same writability rules as a set (not hidden,
   * not readOnly, not computed) and additionally forbidden for link/attachment types,
   * whose authoritative state lives outside `data`.
   */
  op?: 'set' | 'unset'
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
  /**
   * Echo / read-back field set ONLY (NOT the writable set). Callers pass the layer-2 ∧ layer-3 readable
   * fields (F3, #2106 §3 F3) so a field_permissions-denied value is never echoed. Write gating is `fieldById`.
   */
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
    sourceSheetId: string,
    fields: UniverMetaField[],
    rows: UniverMetaRecord[],
    relationalLinkFields: RelationalLinkField[],
    linkValuesByRecord: Map<string, Map<string, string[]>>,
  ) => Promise<void>
  /**
   * Recompute related (linked) records' lookup/rollup echoes — and, A-full (design #2410),
   * one-hop formula propagation: related records whose lookup/rollup resolve to the edited
   * source sheet AND whose targetFieldId is in `changedFieldIds` get their formulas
   * recomputed + materialized. Returned `data` is masked per the related sheet's field-read
   * gate (echo only — the recompute itself runs on the full hydrated row). FOL-1 (followups
   * design 2026-06-10 §2.1): `affectedFieldIds` is per-record UNMASKED metadata (affected
   * lookup/rollup + actually-recomputed formula ids) gating the related-sheet realtime
   * fan-out + Yjs invalidation in Steps 4/6 below; it never reaches the HTTP echo.
   */
  computeDependentLookupRollupRecords: (
    query: QueryFn,
    sourceSheetId: string,
    updatedRecordIds: string[],
    changedFieldIds: string[],
  ) => Promise<Array<{ sheetId: string; recordId: string; data: Record<string, unknown>; affectedFieldIds: string[] }>>
  /**
   * Recalculate `formula` fields for the given just-updated records when a
   * changed field has a dependent formula (per `formula_dependencies`). Returns
   * the recomputed formula values per record so the caller can surface them in
   * the response + realtime patch. Returns `[]` when nothing depends on the
   * change. Intra-sheet / intra-record only (no cross-sheet read → no perm gate).
   */
  recalculateFormulaFields: (
    query: QueryFn,
    sheetId: string,
    fields: UniverMetaField[],
    updatedRecordIds: string[],
    changedFieldIds: string[],
    // A-min (design #2246): optional pre-hydrated row data per record (lookup/rollup resolved
    // in-memory) so formula-over-lookup evals against the actual value. Absent → raw reload.
    hydratedDataByRecord?: Map<string, Record<string, unknown>>,
  ) => Promise<Array<{ recordId: string; data: Record<string, unknown> }>>
  loadLinkValuesByRecord: (
    query: QueryFn,
    recordIds: string[],
    relationalLinkFields: RelationalLinkField[],
  ) => Promise<Map<string, Map<string, string[]>>>
  buildLinkSummaries: (
    query: QueryFn,
    // ②b — the SOURCE sheet id, required so buildLinkSummaries can resolve the source base and apply
    // the cross-base base-read gate (Sink B-1). Positional + required so every caller is forced to pass
    // it (a missing arg would silently re-open the cross-base summary leak).
    sourceSheetId: string,
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
  /**
   * Native person (人员, design 2026-06-16) membership boundary. Returns the flat set of
   * valid member `userId`s for a sheet (the same set the person picker offers) so person
   * cell writes reject non-member userIds. Resolved ONCE per patch op (only when a person
   * field is written), parallel to the link-target-exists hot-path.
   */
  loadSheetMemberUserIds: (query: QueryFn, sheetId: string) => Promise<Set<string>>
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

        // formula/lookup/rollup are computed (readonly) fields — their values are
        // derived server-side, never written by clients. `deriveFieldPermissions`
        // already marks them readonly for the UI; reject here too as the backend
        // backstop so a non-UI client can't pollute record data with a written value.
        // button (B1) joins this non-data class: it stores no value and is a click
        // trigger, never a written cell — reject writes as the same backend backstop.
        if (field.type === 'formula' || field.type === 'lookup' || field.type === 'rollup' || field.type === 'button') {
          throw new RecordFieldForbiddenError(`Field is readonly: ${change.fieldId}`, change.fieldId)
        }

        // Unset (key removal) is gated by the same writability rules above, but its
        // value is ignored so it skips the per-type value-shape checks below. link /
        // attachment are forbidden — their authoritative state lives outside `data`
        // (meta_links / attachment store), so a bare `data` key removal would desync it.
        if (change.op === 'unset') {
          if (field.type === 'link' || field.type === 'attachment') {
            throw new RecordFieldForbiddenError(`Field type cannot be unset: ${change.fieldId}`, change.fieldId)
          }
          continue
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

        if (field.type === 'person') {
          // Step-0 SHAPE-only pre-check (array / single-record cap / id length). The authoritative
          // MEMBERSHIP rejection runs in the txn loop with the once-resolved member set (no member-set
          // query in this pre-pass). Passing the empty set here would false-reject valid ids, so use a
          // null set = closed only against itself: validatePersonValue with `null` would reject ALL ids,
          // so instead we validate shape by checking the non-membership invariants directly.
          if (change.value !== null && change.value !== undefined && change.value !== '') {
            if (!Array.isArray(change.value)) {
              throw new RecordValidationError(`Person value must be an array for ${change.fieldId}`)
            }
            const ids = change.value.map((v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : null))
            if (ids.some((v) => v === null)) {
              throw new RecordValidationError(`Person value must be an array of user ids for ${change.fieldId}`)
            }
            const nonEmpty = ids.filter((v): v is string => !!v)
            const tooLong = nonEmpty.find((id) => id.length > 50)
            if (tooLong) {
              throw new RecordValidationError(`Person user id too long (>50) for ${change.fieldId}: ${tooLong}`)
            }
            if (isPersonSingleRecord(field.property) && new Set(nonEmpty).size > 1) {
              throw new RecordValidationError(`Person field only allows a single user for ${change.fieldId}`)
            }
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
            validateLongTextValue(change.value, change.fieldId, field.property)
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
          normalizeLinkIds: h.normalizeLinkIds,
        })
      : new Map<string, Map<string, string[]>>()

    // -----------------------------------------------------------------------
    // Step 1: DB transaction
    // -----------------------------------------------------------------------
    const pendingSubscriberNotifications: NotifyRecordSubscribersInput[] = []
    // Bidirectional / mirror links (design 2026-06-14 §4) — a forward link write changes what the paired
    // mirror field RESOLVES TO for the touched foreign records. Collect, per mirror-side sheet (= the
    // forward field's foreignSheetId), the affected foreign record ids (toInsert ∪ toDelete) + the mirror
    // field id; after commit they join the FOL-1 invalidation fan-out (read-invalidation only — never a
    // write-back, so no loop). Declared outside the txn closure so it survives to the post-commit fan-out.
    const mirrorInvalidationBySheet = new Map<string, { recordIds: Set<string>; mirrorFieldIds: Set<string> }>()
    const collectMirrorInvalidation = (cfg: LinkFieldConfig, foreignRecordIds: string[]): void => {
      if (cfg.twoWay !== true || !cfg.mirrorFieldId || foreignRecordIds.length === 0) return
      const mirrorSheetId = cfg.foreignSheetId // the mirror field lives on the forward link's foreign sheet
      const group = mirrorInvalidationBySheet.get(mirrorSheetId) ?? { recordIds: new Set<string>(), mirrorFieldIds: new Set<string>() }
      for (const id of foreignRecordIds) group.recordIds.add(id)
      group.mirrorFieldIds.add(cfg.mirrorFieldId)
      mirrorInvalidationBySheet.set(mirrorSheetId, group)
    }
    const updates = await this.pool.transaction(async ({ query }) => {
      const updated: Array<{ recordId: string; version: number }> = []

      // Native person (人员): resolve the sheet member set ONCE per patch op (lazily, only when a
      // person field value is actually written), then reuse it for every person cell's write-time
      // membership validation (SECURITY boundary) — parallel to the link-target-exists hot-path.
      //
      // #16 org-member directory: when a person field carries `restrictToMemberGroupIds`, the allowed
      // set narrows to (sheet members ∩ users in those member groups) — a NEW assignment must be both a
      // sheet member AND in an allowed group (fail-closed). Unrestricted fields keep the sheet set.
      // Read-back is unaffected (validation is write-only), so pre-existing out-of-scope values are
      // grandfathered. Resolved sets are cached per restrict-key so a bulk patch hits the DB once.
      // Shared SINGLE source of truth (person-field-restriction.ts) — identical to the REST/form path
      // in RecordService, so a restricted person field can't be bypassed via any write path. Keeps the
      // injected sheet-member loader (h.loadSheetMemberUserIds) so the existing unit seam is preserved.
      const resolvePersonMemberUserIds = createPersonMemberResolver(query, sheetId, h.loadSheetMemberUserIds)

      // #16: source each person field's restrictToMemberGroupIds from the property-bearing `fields`
      // list (the per-change `fieldById` guard does not carry property). Built once per patch op.
      const personRestrictByFieldId = new Map<string, string[]>()
      for (const f of fields as Array<{ id?: unknown; type?: unknown; property?: unknown }>) {
        if (!f || f.type !== 'person') continue
        const ids = personRestrictGroupIds(f)
        const fid = typeof f.id === 'string' ? f.id : ''
        if (fid && ids.length > 0) personRestrictByFieldId.set(fid, ids)
      }

      for (const [recordId, changes] of changesByRecord.entries()) {
        const expectedVersion = Array.from(
          new Set(changes.map((c) => c.expectedVersion).filter((v): v is number => typeof v === 'number')),
        )[0]

        const recordRes = await query(
          'SELECT id, version, data, created_by, locked, locked_by FROM meta_records WHERE sheet_id = $1 AND id = $2 FOR UPDATE',
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

        // Record-lock guard (decision d/e): a locked record is read-only unless the actor is the
        // locker or owner. No silent admin bypass — an admin must explicitly unlock first. Routed
        // through the ONE shared rule (`ensureRecordNotLocked`) so every mutation path matches.
        if (recordRow) {
          ensureRecordNotLocked(
            actorId,
            recordRow,
            () => new RecordValidationError(`Record is locked: ${recordId}`, 'FORBIDDEN'),
          )
        }

        const serverVersion = Number(recordRow?.version ?? 1)
        if (typeof expectedVersion === 'number' && expectedVersion !== serverVersion) {
          throw new VersionConflictError(recordId, serverVersion)
        }
        const previousData = h.normalizeJson(recordRow?.data)

        const patch: Record<string, unknown> = {}
        const unsetIds: string[] = []
        const linkUpdates = new Map<string, { ids: string[]; cfg: LinkFieldConfig }>()
        let applied = 0

        for (const change of changes) {
          const field = fieldById.get(change.fieldId)
          if (!field) continue
          // Note: formula/lookup/rollup are rejected up-front in validateChanges
          // (Step 0), so no computed-field change reaches this write loop.

          // Unset (key removal) — validated in Step 0 (writability + not link/attachment).
          // Collected separately so the UPDATE can subtract the keys; never added to `patch`.
          if (change.op === 'unset') {
            unsetIds.push(change.fieldId)
            applied += 1
            continue
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

          if (field.type === 'person') {
            try {
              // NB: `field` here is the fieldById GUARD (type/readOnly/hidden), which does NOT carry
              // `property`. The restrict config is sourced from `personRestrictByFieldId`, built from the
              // full `fields` list (which does carry property) once per patch op.
              const allowed = await resolvePersonMemberUserIds(personRestrictByFieldId.get(change.fieldId) ?? [])
              patch[change.fieldId] = validatePersonValue(change.value, change.fieldId, allowed, isPersonSingleRecord(field.property))
            } catch (error) {
              throw new RecordValidationError(error instanceof Error ? error.message : String(error))
            }
            applied += 1
            continue
          }

          if (field.type === 'longText') {
            try {
              patch[change.fieldId] = validateLongTextValue(change.value, change.fieldId, field.property)
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
        for (const [fieldId, { ids, cfg }] of linkUpdates.entries()) {
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
          if (guardedHierarchyParentFieldIds.has(fieldId) && cfg.foreignSheetId === sheetId) {
            try {
              await assertNoHierarchyParentCycle({
                query,
                sheetId,
                recordId,
                fieldId,
                parentRecordIds: ids,
                parentOverridesByRecord: hierarchyParentOverridesByField.get(fieldId) ?? new Map(),
                normalizeLinkIds: h.normalizeLinkIds,
              })
            } catch (error) {
              if (error instanceof HierarchyCycleError) {
                throw new RecordValidationError(error.message, error.code)
              }
              throw error
            }
          }
        }

        // bulk/multi-record PATCH (+restore unset path): the lock rule is enforced per record above via
        // ensureRecordNotLocked. When there are unset keys, subtract them first: `(data - keys) || patch`;
        // the empty-array case is branched so existing set-only writes keep byte-identical SQL. Each UPDATE
        // template below carries its own adjacent lock-guarded marker for the RANK-8 structural scanner.
        const updateRes = unsetIds.length > 0
          // lock-guarded: ensureRecordNotLocked enforced per record above (unset+set path)
          ? await query(
              `UPDATE meta_records
               SET data = (data - $5::text[]) || $1::jsonb, updated_at = now(), version = version + 1, modified_by = $4
               WHERE sheet_id = $2 AND id = $3
               RETURNING version`,
              [JSON.stringify(patch), sheetId, recordId, actorId, unsetIds],
            )
          // lock-guarded: ensureRecordNotLocked enforced per record above (set-only path)
          : await query(
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
        // After-image MUST drop the removed keys (not just the live row) so a later
        // restore-of-this-revision reproduces the absence; `changedFieldIds` lists the
        // removed ids and the revision `patch` marks each removal with the `null` sentinel.
        const afterImage: Record<string, unknown> = { ...previousData, ...patch }
        const revisionPatch: Record<string, unknown> = { ...patch }
        for (const removedId of unsetIds) {
          delete afterImage[removedId]
          revisionPatch[removedId] = null
        }
        const revisionId = await recordRecordRevision(query, {
          sheetId,
          recordId,
          version: nextVersion,
          action: 'update',
          source: source ?? 'rest',
          actorId,
          changedFieldIds: [...Object.keys(patch), ...unsetIds],
          patch: revisionPatch,
          snapshot: afterImage,
        })
        pendingSubscriberNotifications.push({
          sheetId,
          recordId,
          eventType: 'record.updated',
          actorId,
          revisionId,
        })

        // Sync link table
        if (linkUpdates.size > 0) {
          for (const [fieldId, { ids, cfg }] of linkUpdates.entries()) {
            if (ids.length === 0) {
              // Full clear — every currently-linked foreign record loses this edge, so its mirror
              // projection changed. Read the existing set first (for the twoWay fan-out) THEN delete.
              let clearedIds: string[] = []
              if (cfg.twoWay === true && cfg.mirrorFieldId) {
                const current = await query(
                  'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2',
                  [fieldId, recordId],
                )
                clearedIds = (current as any).rows.map((r: any) => String(r.foreign_record_id))
              }
              try {
                await query('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2', [fieldId, recordId])
              } catch (err) {
                throw err
              }
              collectMirrorInvalidation(cfg, clearedIds)
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
            // The mirror projection of any foreign record gained OR lost from this forward field changed.
            collectMirrorInvalidation(cfg, [...toInsert, ...toDelete])

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
    // Step 2: Subscriber notifications (best effort, after commit)
    // -----------------------------------------------------------------------
    for (const notification of pendingSubscriberNotifications) {
      await notifyRecordSubscribersBestEffort(
        this.pool.query.bind(this.pool),
        notification,
        'record-write',
      )
    }

    // -----------------------------------------------------------------------
    // Step 3: Post-commit hooks (best effort, immediately after commit)
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
    // Step 4: Computed field recalculation (lookup / rollup)
    // -----------------------------------------------------------------------
    let computedRecords: Array<{ recordId: string; data: Record<string, unknown> }> | undefined
    let updatedRowsForSummaries: UniverMetaRecord[] = []
    // A-min (design #2246): full hydrated row data (lookup/rollup resolved in-memory) for the
    // updated records, captured in Step 4 and fed into the Step 4c formula recalc.
    let hydratedDataByRecord: Map<string, Record<string, unknown>> | undefined
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
        sheetId,
        fields,
        rows,
        relationalLinkFields,
        linkValuesByRecord,
      )

      // A-min: snapshot the FULL hydrated data BEFORE the visibility filter below mutates
      // row.data — the formula recalc (Step 4c) evals against this so a formula referencing a
      // lookup sees the actual lookup value instead of the absent-on-reload `undefined → '0'`.
      hydratedDataByRecord = new Map(rows.map((row) => [row.id, { ...row.data }]))

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
    // Step 4: Related record recomputation (cross-sheet). A-full (design #2410):
    // the helper also propagates this PATCH one hop into the related records'
    // formulas, gated by the source sheet + changed field ids below.
    // -----------------------------------------------------------------------
    const changedFieldIds = [
      ...new Set(
        Array.from(changesByRecord.values()).flatMap((changes) => changes.map((change) => change.fieldId)),
      ),
    ]
    const relatedRecords =
      updates.length > 0
        ? await h.computeDependentLookupRollupRecords(
            this.pool.query.bind(this.pool),
            sheetId,
            updates.map((u) => u.recordId),
            changedFieldIds,
          )
        : []

    const sameSheetRelated = relatedRecords
      .filter((record) => record.sheetId === sheetId)
      .map((record) => ({
        recordId: record.recordId,
        data: h.filterRecordDataByFieldIds(record.data, visiblePropertyFieldIds),
      }))
    const crossSheetRelated = relatedRecords
      .filter((record) => record.sheetId !== sheetId)
      // The HTTP echo keeps its exact pre-FOL-1 shape — `affectedFieldIds` is unmasked
      // fan-out metadata, never part of the response contract.
      .map((record) => ({ sheetId: record.sheetId, recordId: record.recordId, data: record.data }))

    // FOL-1 (followups design 2026-06-10 §2.1): group the related records whose computed
    // values this PATCH actually invalidated (non-empty UNMASKED affected metadata — the
    // publish gate is the AFFECTED gate, NOT echo presence: the helper echoes every readable
    // linked sheet, and broadcasting on echo would fan any edit out to all of them).
    const affectedRelatedBySheet = new Map<string, { recordIds: string[]; fieldIds: Set<string> }>()
    for (const record of relatedRecords) {
      if (record.affectedFieldIds.length === 0) continue
      let group = affectedRelatedBySheet.get(record.sheetId)
      if (!group) {
        group = { recordIds: [], fieldIds: new Set<string>() }
        affectedRelatedBySheet.set(record.sheetId, group)
      }
      group.recordIds.push(record.recordId)
      for (const fieldId of record.affectedFieldIds) group.fieldIds.add(fieldId)
    }

    // Bidirectional / mirror links (design 2026-06-14 §4) — fold the forward-write mirror invalidation
    // (collected in Step 1) into the SAME affected map, so the mirror records on the paired sheet ride the
    // existing FOL-1 fan-out: post-commit Yjs invalidation (below) + the realtime invalidation broadcast
    // (Step 6). The fieldIds carry the mirror field id (a pure invalidation signal — receivers refetch
    // under their own mask; no values, no recordPatches, no forward write → no loop). De-dup recordIds vs
    // any already-present FOL-1 record on the same sheet (the affected map uses arrays).
    for (const [mirrorSheetId, group] of mirrorInvalidationBySheet.entries()) {
      let existing = affectedRelatedBySheet.get(mirrorSheetId)
      if (!existing) {
        existing = { recordIds: [], fieldIds: new Set<string>() }
        affectedRelatedBySheet.set(mirrorSheetId, existing)
      }
      const seen = new Set(existing.recordIds)
      for (const recordId of group.recordIds) {
        if (seen.has(recordId)) continue
        seen.add(recordId)
        existing.recordIds.push(recordId)
      }
      for (const mirrorFieldId of group.mirrorFieldIds) existing.fieldIds.add(mirrorFieldId)
    }

    // FOL-1 (§2.1 decision 5): the helper just materialized fresh formula values onto the
    // affected related records, so any cached Y.Doc for them is now stale. Send their ids
    // through the same post-commit seam as the source records (Step 3) — the Yjs hook is
    // record-id keyed and itself skips `source === 'yjs-bridge'`, mirroring source-record
    // behavior (the bridge additionally stubs the helper to [], a natural no-op).
    if (this.postCommitHooks.length > 0 && affectedRelatedBySheet.size > 0) {
      for (const [relatedSheetId, group] of affectedRelatedBySheet.entries()) {
        const relatedContext: RecordPostCommitContext = {
          recordIds: group.recordIds,
          sheetId: relatedSheetId,
          actorId,
          source: input.source,
        }
        for (const hook of this.postCommitHooks) {
          try {
            await hook(relatedContext)
          } catch (err) {
            console.error(
              `[record-write] Post-commit hook failed for related records ${relatedContext.recordIds.join(',')} — downstream state may be stale until the next successful sync:`,
              err,
            )
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step 4c: Formula field recalculation (field.property.expression-based).
    // Unlike lookup/rollup (computed-on-read), formula values are materialized
    // back to the record by the helper; here we collect the recomputed values to
    // surface in the response + realtime patch so the editing client AND other
    // clients refresh after a source field changes via this write path.
    // -----------------------------------------------------------------------
    const formulaRecords =
      updates.length > 0
        ? (
            await h.recalculateFormulaFields(
              this.pool.query.bind(this.pool),
              sheetId,
              fields,
              updates.map((update) => update.recordId),
              changedFieldIds,
              hydratedDataByRecord,
            )
          ).map((record) => ({
            recordId: record.recordId,
            data: h.filterRecordDataByFieldIds(record.data, visiblePropertyFieldIds),
          }))
        : []
    const formulaByRecord = new Map(formulaRecords.map((record) => [record.recordId, record.data]))

    const mergedRecords = h.mergeComputedRecords(
      h.mergeComputedRecords(computedRecords, sameSheetRelated),
      formulaRecords,
    )

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
                sheetId,
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
          ...new Set([
            ...changedFieldIds,
            ...formulaRecords.flatMap((record) => Object.keys(record.data)),
          ]),
        ],
        recordPatches: updates.map((update) => ({
          recordId: update.recordId,
          version: update.version,
          patch: {
            ...Object.fromEntries(
              (changesByRecord.get(update.recordId) ?? []).map((change) => [change.fieldId, change.value]),
            ),
            // Recomputed formula values ride along for call-payload parity with fieldIds,
            // but recordPatches NEVER reaches other clients: the shared publisher strips it
            // before broadcast and the frontend deliberately consumes no values from
            // realtime events — receivers refetch affected records under their own mask.
            ...(formulaByRecord.get(update.recordId) ?? {}),
          },
        })),
      })

      // FOL-1 (§2.1): related-record invalidation fan-out — one event per AFFECTED related
      // sheet, pure invalidation signal: fieldIds carry the UNMASKED affected ids (metadata,
      // never values — an actor-masked echo key set would hide invalidations from readers who
      // CAN see the field) and the call MUST NOT construct recordPatches. Cross-sheet events
      // omit actorId (the editor made no local edit there, so their own other tabs must
      // refetch too); the same-sheet self-link event carries it (the editor's tab already
      // merged the response echo — actorId prevents a redundant self-GET). No cycle: these
      // events only ever trigger reads on receivers, never a write path.
      for (const [relatedSheetId, group] of affectedRelatedBySheet.entries()) {
        publishMultitableSheetRealtime({
          spreadsheetId: relatedSheetId,
          ...(relatedSheetId === sheetId ? { actorId } : {}),
          source: 'multitable',
          kind: 'record-updated',
          recordIds: group.recordIds,
          fieldIds: [...group.fieldIds],
        })
      }

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
