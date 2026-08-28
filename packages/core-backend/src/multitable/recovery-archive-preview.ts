import {
  buildPreviewPlanDetails,
  loadFieldSurfaceForPreview,
  loadLiveByIdForPreview,
  type PreviewPlanSummary,
} from './exact-anchor-recovery-route'
import {
  prepareMaterializedArchiveRecoveryPreviewScopeInternal,
  type EvaluatePlanAuthorization,
  type MaterializedArchiveLink,
} from './exact-anchor-recovery-execute'
import {
  hydrateLiveLinkProjection,
  LiveLinkProjectionDataError,
  loadAuthoritativeLiveLinkEdgesForSheet,
} from './live-link-projection-integrity'
import type { QueryFn } from './permission-service'
import {
  RECOVERY_ARCHIVE_ASYNC_THRESHOLD,
} from './recovery-archive-restore-plan'
import {
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  isMultitableRecoveryArchiveEnabled,
} from './recovery-archive-contract'
import type { RecoveryArchiveKeyCustodyAdapter, RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'
import {
  createTransactionGuardedRecoveryArchiveObjectStore,
  type RecoveryArchiveObjectExpectedBinding,
  type RecoveryArchiveObjectStoreProvider,
} from './recovery-archive-object-store'
import {
  readRecoveryArchiveCompleteSectionState,
  RecoveryArchiveReaderError,
  type RecoveryArchiveSelectedBinding,
} from './recovery-archive-reader'
import {
  buildRecoveryArchiveAsyncPlan,
  persistRecoveryArchiveAsyncPlan,
} from './recovery-archive-async-plan'
import { prepareRecoveryArchiveRestorePlan } from './recovery-archive-restore-jobs'
import { materializeRecoveryArchiveLinksForSync, RecoveryArchiveSyncRestoreError } from './recovery-archive-sync-restore'
import { compileRecoveryArchiveSyncPlan } from './recovery-archive-sync-plan'
import {
  hashAnchorRecoveryScope,
  hashExactAnchorLiveSet,
  hashExactAnchorSchema,
  hashRecoveryAuthorizationScope,
  mintExactArchiveRecoveryIdentity,
  verifyExactArchiveRecoveryIdentity,
  type ExactArchiveRecoveryScopeKind,
  type ExactAnchorRecoveryMode,
} from './restore-preview-identity'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA_PATTERN = /^[0-9a-f]{64}$/
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/

export type RecoveryArchivePreviewErrorCode =
  | 'RECOVERY_ARCHIVE_PREVIEW_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_PREVIEW_DISABLED'
  | 'RECOVERY_ARCHIVE_PREVIEW_AUTHORITY_DENIED'
  | 'RECOVERY_ARCHIVE_PREVIEW_NOT_FOUND'
  | 'RECOVERY_ARCHIVE_PREVIEW_RUNTIME_UNAVAILABLE'
  | 'RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID'

export class RecoveryArchivePreviewError extends Error {
  readonly code: RecoveryArchivePreviewErrorCode

  constructor(code: RecoveryArchivePreviewErrorCode) {
    super(code)
    this.name = 'RecoveryArchivePreviewError'
    this.code = code
  }
}

export type RecoveryArchivePreviewQuery = QueryFn

export type RecoveryArchivePreviewTransaction = <T>(
  work: (query: RecoveryArchivePreviewQuery) => Promise<T>,
) => Promise<T>

export interface RecoveryArchivePreviewRuntime {
  readonly keyCustody: RecoveryArchiveKeyCustodyAdapter
  readonly objectStore: RecoveryArchiveObjectStoreProvider
  readonly transactionDepth: RecoveryArchiveTransactionDepthProbe
}

export type RecoveryArchivePreviewScope =
  | { readonly kind: 'whole_sheet' }
  | { readonly kind: 'selected_records'; readonly recordIds: readonly string[] }
  | {
      readonly kind: 'selected_fields'
      readonly recordIds: readonly string[]
      readonly fieldIds: readonly string[]
    }

export interface RecoveryArchivePreviewInput {
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly actorId: string
  readonly generationId: string
  readonly mode: ExactAnchorRecoveryMode
  readonly scope: RecoveryArchivePreviewScope
  readonly recheckAuthority: (query: RecoveryArchivePreviewQuery) => Promise<boolean>
  readonly evaluatePlanAuthorization: EvaluatePlanAuthorization
  readonly env?: NodeJS.ProcessEnv
}

export type RecoveryArchivePreviewBlockedReason =
  | 'no_changes'
  | 'schema_drift'
  | 'inbound_unprovable'
  | 'async_plan_required'

export interface RecoveryArchivePreviewResult {
  readonly generationId: string
  readonly mode: ExactAnchorRecoveryMode
  readonly scopeKind: ExactArchiveRecoveryScopeKind
  readonly executionKind: 'sync' | 'async'
  readonly executable: boolean
  readonly blockedReason: RecoveryArchivePreviewBlockedReason | null
  readonly previewIdentity: string | null
  readonly summary: PreviewPlanSummary
}

type ArchiveRow = {
  generation_id?: unknown
  workspace_id?: unknown
  base_id?: unknown
  sheet_id?: unknown
  anchor_operation_id?: unknown
  anchor_seq?: unknown
  checkpoint_id?: unknown
  root_hash?: unknown
  source_vector_hash?: unknown
  key_id?: unknown
  expires_at?: unknown
}

type ObjectRow = {
  generation_id?: unknown
  object_id?: unknown
  object_class?: unknown
  section_name?: unknown
  key_id?: unknown
  provider_version?: unknown
  ciphertext_sha256?: unknown
  size_bytes?: unknown
}

export interface RecoveryArchiveAuthorityInput {
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly generationId: string
  readonly recheckAuthority: (query: RecoveryArchivePreviewQuery) => Promise<boolean>
}

export type LoadedArchiveAuthority = {
  selectedBinding: RecoveryArchiveSelectedBinding
  keyId: string
  manifestObject: RecoveryArchiveObjectExpectedBinding
  sectionObjects: readonly RecoveryArchiveObjectExpectedBinding[]
}

/**
 * D5 preview authority. The request supplies only generation/mode/scope. Root, key, source vector,
 * object roster, anchor, checkpoint, and every plan hash come from the verified catalog and D4.
 */
export async function previewRecoveryArchive(
  transaction: RecoveryArchivePreviewTransaction,
  query: RecoveryArchivePreviewQuery,
  runtime: RecoveryArchivePreviewRuntime | undefined,
  input: RecoveryArchivePreviewInput,
): Promise<RecoveryArchivePreviewResult> {
  const admitted = normalizeInput(input)
  if (!isMultitableRecoveryArchiveEnabled(input.env ?? process.env)) {
    fail('RECOVERY_ARCHIVE_PREVIEW_DISABLED')
  }
  if (!runtime) fail('RECOVERY_ARCHIVE_PREVIEW_RUNTIME_UNAVAILABLE')

  const archive = await loadRecoveryArchiveAuthorityInternal(transaction, admitted)
  let complete
  try {
    complete = await readRecoveryArchiveCompleteSectionState({
      selectedBinding: archive.selectedBinding,
      keyCustody: runtime.keyCustody,
      objectStore: runtime.objectStore,
      transactionDepth: runtime.transactionDepth,
      manifestObject: archive.manifestObject,
      sectionObjects: archive.sectionObjects,
      query,
    })
  } catch (error) {
    if (error instanceof RecoveryArchiveReaderError) {
      fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
    }
    throw error
  }

  let targetLinks: readonly MaterializedArchiveLink[]
  try {
    targetLinks = materializeRecoveryArchiveLinksForSync(complete.links)
  } catch (error) {
    if (error instanceof RecoveryArchiveSyncRestoreError) {
      fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
    }
    throw error
  }

  const liveLoaded = await loadLiveByIdForPreview(query, admitted.sheetId)
  if (!liveLoaded.ok) fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
  const surface = await loadFieldSurfaceForPreview(query, admitted.sheetId)
  let authoritativeLiveById
  try {
    authoritativeLiveById = await hydrateLiveLinkProjection(
      query,
      liveLoaded.liveById,
      surface.writableLinkFieldIds,
    )
  } catch (error) {
    if (error instanceof LiveLinkProjectionDataError) {
      fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
    }
    throw error
  }

  const selectedRecordIds = selectedRecords(admitted.scope)
  const selectedFieldIds = selectedFields(admitted.scope)
  const prepared = prepareMaterializedArchiveRecoveryPreviewScopeInternal({
    scopeKind: admitted.scope.kind,
    targetRecords: complete.records,
    targetLinks,
    liveById: authoritativeLiveById,
    selectedRecordIds,
    selectedFieldIds,
    writableLinkFieldIds: surface.writableLinkFieldIds,
    restorableFieldIds: new Set(surface.fieldById.keys()),
  })
  if (prepared.ok === false) {
    if (prepared.reason === 'schema-drift') {
      return blockedResult(admitted, 'schema_drift', emptySummary())
    }
    fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
  }

  let details
  try {
    details = buildPreviewPlanDetails(
      prepared.targetRecords,
      prepared.liveById,
      surface.fieldIds,
      admitted.mode,
      { fieldById: surface.fieldById, rawTypeById: surface.rawTypeById },
    )
  } catch {
    fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
  }

  if (!(await admitted.evaluatePlanAuthorization(query, {
    mode: admitted.mode,
    sheetId: admitted.sheetId,
    actorId: admitted.actorId,
    plan: details.plan,
    revertWrites: details.revertWrites,
    deleteRecordIds: details.deleteRecordIds,
  }))) {
    fail('RECOVERY_ARCHIVE_PREVIEW_AUTHORITY_DENIED')
  }

  if (details.summary.driftCount > 0) {
    return blockedResult(admitted, 'schema_drift', details.summary)
  }
  if (details.summary.resurrectIds.length > 0) {
    return blockedResult(admitted, 'inbound_unprovable', details.summary)
  }
  if (details.summary.effectiveWriteCount === 0) {
    return blockedResult(admitted, 'no_changes', details.summary)
  }

  const scopeHash = hashAnchorRecoveryScope(
    [...prepared.anchorTarget.values()].map((state) => ({
      recordId: state.recordId,
      exists: state.exists,
      version: state.version,
    })),
  )
  const schemaRows = (await query(
    'SELECT id, type, property FROM meta_fields WHERE sheet_id = $1',
    [admitted.sheetId],
  )).rows as Array<{ id?: unknown; type?: unknown; property?: unknown }>
  const liveLinks = await loadAuthoritativeLiveLinkEdgesForSheet(query, admitted.sheetId)
  const liveSetHash = hashExactAnchorLiveSet(
    [...liveLoaded.liveById.entries()].map(([recordId, live]) => ({
      recordId,
      version: live.version,
    })),
    liveLinks,
  )
  const schemaHash = hashExactAnchorSchema(schemaRows.map((row) => ({
    id: String(row.id),
    type: String(row.type ?? ''),
    property: row.property,
  })))
  const authorizedScopeHash = hashRecoveryAuthorizationScope({
    sheetId: admitted.sheetId,
    actorId: admitted.actorId,
  })
  if (BigInt(details.summary.effectiveWriteCount) > RECOVERY_ARCHIVE_ASYNC_THRESHOLD) {
    const bundle = buildRecoveryArchiveAsyncPlan({
      workspaceId: admitted.workspaceId,
      baseId: admitted.baseId,
      sheetId: admitted.sheetId,
      actorId: admitted.actorId,
      recoveryMode: admitted.mode,
      scopeKind: admitted.scope.kind,
      scopeHash,
      archiveGenerationId: archive.selectedBinding.generationId,
      archiveRootHash: archive.selectedBinding.rootHash,
      sourceVectorHash: archive.selectedBinding.sourceVectorHash,
      keyId: archive.keyId,
      anchorOperationId: archive.selectedBinding.anchorOperationId,
      anchorSeq: archive.selectedBinding.anchorSeq,
      checkpointId: archive.selectedBinding.checkpointId,
      schemaHash,
      selectedRecordIds,
      selectedFieldIds,
      liveRecords: liveLoaded.liveById,
      liveLinks,
      revertWrites: details.revertWrites,
      deleteRecordIds: details.deleteRecordIds,
      expiresAt: archive.manifestObject.expectedExpiresAt,
    })
    const store = createTransactionGuardedRecoveryArchiveObjectStore(
      runtime.objectStore,
      runtime.transactionDepth,
    )
    await persistRecoveryArchiveAsyncPlan(store, bundle)
    const identityTtlSeconds = asyncIdentityTtlSeconds(bundle.planObject.descriptor.expiresAt)
    const previewIdentity = mintExactArchiveRecoveryIdentity({
      sheetId: admitted.sheetId,
      anchorOperationId: archive.selectedBinding.anchorOperationId,
      anchorSeq: archive.selectedBinding.anchorSeq,
      checkpointId: archive.selectedBinding.checkpointId,
      scopeHash,
      liveSetHash,
      schemaHash,
      actorId: admitted.actorId,
      mode: admitted.mode,
      authorizedScopeHash,
      archiveGenerationId: archive.selectedBinding.generationId,
      archiveRootHash: archive.selectedBinding.rootHash,
      archiveSourceVectorHash: archive.selectedBinding.sourceVectorHash,
      archiveKeyId: archive.keyId,
      archivePlanHash: bundle.plan.planHash,
      archivePlanObject: {
        objectId: bundle.planObject.descriptor.objectId,
        version: bundle.planObject.descriptor.version,
        sha256: bundle.planObject.descriptor.sha256,
        size: bundle.planObject.descriptor.size,
        expiresAt: bundle.planObject.descriptor.expiresAt,
      },
      scopeKind: admitted.scope.kind,
    }, identityTtlSeconds)
    const verified = verifyExactArchiveRecoveryIdentity(previewIdentity, {
      sheetId: admitted.sheetId,
      actorId: admitted.actorId,
    })
    if (
      !verified.valid ||
      !verified.expiresAt ||
      verified.expiresAt > bundle.planObject.descriptor.expiresAt
    ) {
      fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
    }
    await prepareRecoveryArchiveRestorePlan(transaction, {
      token: previewIdentity,
      plan: bundle.plan,
      identity: {
        workspaceId: admitted.workspaceId,
        baseId: admitted.baseId,
        sheetId: admitted.sheetId,
        actorId: admitted.actorId,
      },
    })
    return Object.freeze({
      generationId: archive.selectedBinding.generationId,
      mode: admitted.mode,
      scopeKind: admitted.scope.kind,
      executionKind: 'async',
      executable: true,
      blockedReason: null,
      previewIdentity,
      summary: details.summary,
    })
  }

  const plan = compileRecoveryArchiveSyncPlan({
    workspaceId: admitted.workspaceId,
    baseId: admitted.baseId,
    sheetId: admitted.sheetId,
    actorId: admitted.actorId,
    recoveryMode: admitted.mode,
    scopeKind: admitted.scope.kind,
    scopeHash,
    archiveGenerationId: archive.selectedBinding.generationId,
    archiveRootHash: archive.selectedBinding.rootHash,
    sourceVectorHash: archive.selectedBinding.sourceVectorHash,
    keyId: archive.keyId,
    selectedRecordIds,
    selectedFieldIds,
  })
  const previewIdentity = mintExactArchiveRecoveryIdentity({
    sheetId: admitted.sheetId,
    anchorOperationId: archive.selectedBinding.anchorOperationId,
    anchorSeq: archive.selectedBinding.anchorSeq,
    checkpointId: archive.selectedBinding.checkpointId,
    scopeHash,
    liveSetHash,
    schemaHash,
    actorId: admitted.actorId,
    mode: admitted.mode,
    authorizedScopeHash,
    archiveGenerationId: archive.selectedBinding.generationId,
    archiveRootHash: archive.selectedBinding.rootHash,
    archiveSourceVectorHash: archive.selectedBinding.sourceVectorHash,
    archiveKeyId: archive.keyId,
    archivePlanHash: plan.planHash,
    scopeKind: admitted.scope.kind,
  })
  return Object.freeze({
    generationId: archive.selectedBinding.generationId,
    mode: admitted.mode,
    scopeKind: admitted.scope.kind,
    executionKind: 'sync',
    executable: true,
    blockedReason: null,
    previewIdentity,
    summary: details.summary,
  })
}

function asyncIdentityTtlSeconds(expiresAt: string): number {
  const remainingSeconds = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000) - 1
  if (!Number.isSafeInteger(remainingSeconds) || remainingSeconds < 1) {
    fail('RECOVERY_ARCHIVE_PREVIEW_NOT_FOUND')
  }
  return Math.min(600, remainingSeconds)
}

function normalizeInput(input: RecoveryArchivePreviewInput): RecoveryArchivePreviewInput {
  if (!input || typeof input !== 'object') fail('RECOVERY_ARCHIVE_PREVIEW_INVALID_INPUT')
  if (typeof input.recheckAuthority !== 'function' || typeof input.evaluatePlanAuthorization !== 'function') {
    fail('RECOVERY_ARCHIVE_PREVIEW_INVALID_INPUT')
  }
  const mode = input.mode
  if (mode !== 'revert' && mode !== 'reset') fail('RECOVERY_ARCHIVE_PREVIEW_INVALID_INPUT')
  return Object.freeze({
    workspaceId: opaque(input.workspaceId),
    baseId: opaque(input.baseId),
    sheetId: opaque(input.sheetId),
    actorId: opaque(input.actorId),
    generationId: uuid(input.generationId),
    mode,
    scope: normalizeRecoveryArchiveScopeInternal(input.scope),
    recheckAuthority: input.recheckAuthority,
    evaluatePlanAuthorization: input.evaluatePlanAuthorization,
    env: input.env,
  })
}

export function normalizeRecoveryArchiveScopeInternal(
  value: RecoveryArchivePreviewScope,
): RecoveryArchivePreviewScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  if (value.kind === 'whole_sheet') {
    if (Reflect.ownKeys(value).length !== 1) invalid()
    return Object.freeze({ kind: 'whole_sheet' })
  }
  if (value.kind === 'selected_records') {
    if (Reflect.ownKeys(value).length !== 2) invalid()
    return Object.freeze({ kind: 'selected_records', recordIds: opaqueIdSet(value.recordIds) })
  }
  if (value.kind === 'selected_fields') {
    if (Reflect.ownKeys(value).length !== 3) invalid()
    return Object.freeze({
      kind: 'selected_fields',
      recordIds: opaqueIdSet(value.recordIds),
      fieldIds: opaqueIdSet(value.fieldIds),
    })
  }
  invalid()
}

/** @internal Shared server-owned catalog/object receipt authority for preview and sync execute. */
export async function loadRecoveryArchiveAuthorityInternal(
  transaction: RecoveryArchivePreviewTransaction,
  input: RecoveryArchiveAuthorityInput,
): Promise<LoadedArchiveAuthority> {
  return transaction(async (query) => {
    if (await input.recheckAuthority(query) !== true) {
      fail('RECOVERY_ARCHIVE_PREVIEW_AUTHORITY_DENIED')
    }
    const archiveResult = await query(
      `SELECT generation_id::text AS generation_id, workspace_id, base_id, sheet_id,
              anchor_operation_id::text AS anchor_operation_id, anchor_seq::text AS anchor_seq,
              checkpoint_id, root_hash, source_vector_hash, key_id, expires_at
         FROM public.meta_recovery_archives
        WHERE generation_id = $1::uuid
          AND workspace_id = $2
          AND base_id = $3
          AND sheet_id = $4
          AND state = 'verified'
          AND build_status = 'finalized'
          AND coverage_status = 'complete'
          AND expires_at > clock_timestamp()
          AND NOT EXISTS (
            SELECT 1
              FROM public.meta_recovery_archive_legal_holds hold_row
             WHERE hold_row.generation_id = meta_recovery_archives.generation_id
               AND hold_row.state = 'active'
          )`,
      [input.generationId, input.workspaceId, input.baseId, input.sheetId],
    )
    if (archiveResult.rows.length !== 1) fail('RECOVERY_ARCHIVE_PREVIEW_NOT_FOUND')
    const row = archiveResult.rows[0] as ArchiveRow
    const expiresAt = timestamp(row.expires_at)
    const selectedBinding: RecoveryArchiveSelectedBinding = Object.freeze({
      generationId: uuid(row.generation_id),
      workspaceId: exact(row.workspace_id, input.workspaceId),
      baseId: exact(row.base_id, input.baseId),
      sheetId: exact(row.sheet_id, input.sheetId),
      anchorOperationId: uuid(row.anchor_operation_id),
      anchorSeq: decimal(row.anchor_seq),
      checkpointId: opaque(row.checkpoint_id),
      rootHash: sha(row.root_hash),
      sourceVectorHash: sha(row.source_vector_hash),
    })
    const keyId = opaque(row.key_id)
    const objectResult = await query(
      `SELECT generation_id::text AS generation_id, object_id, object_class, section_name,
              key_id, provider_version, ciphertext_sha256, size_bytes::text AS size_bytes
         FROM public.meta_recovery_archive_objects
        WHERE generation_id = $1::uuid
          AND state = 'verified'
          AND object_class IN ('manifest', 'section')
        ORDER BY object_class, section_name NULLS FIRST`,
      [selectedBinding.generationId],
    )
    const objects = objectResult.rows.map((candidate) => objectBinding(
      candidate as ObjectRow,
      selectedBinding.generationId,
      keyId,
      expiresAt,
    ))
    const manifests = objects.filter((candidate) => candidate.objectClass === 'manifest')
    if (manifests.length !== 1) fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
    const sections = objects.filter((candidate) => candidate.objectClass === 'section')
    const sectionByName = new Map(
      sections.map((candidate) => [candidate.sectionName, candidate.binding] as const),
    )
    if (
      sections.length !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length ||
      sectionByName.size !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length ||
      RECOVERY_ARCHIVE_V1_SECTION_NAMES.some((name) => !sectionByName.has(name))
    ) {
      fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
    }
    return Object.freeze({
      selectedBinding,
      keyId,
      manifestObject: manifests[0].binding,
      sectionObjects: Object.freeze(
        RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((name) => sectionByName.get(name)!),
      ),
    })
  })
}

function objectBinding(
  row: ObjectRow,
  generationId: string,
  keyId: string,
  expiresAt: string,
) {
  if (exact(row.generation_id, generationId) !== generationId || exact(row.key_id, keyId) !== keyId) {
    fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
  }
  const objectClass = row.object_class
  if (objectClass !== 'manifest' && objectClass !== 'section') {
    fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
  }
  const sectionName = objectClass === 'manifest'
    ? row.section_name === null ? null : fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
    : typeof row.section_name === 'string' && RECOVERY_ARCHIVE_V1_SECTION_NAMES.includes(row.section_name as never)
      ? row.section_name
      : fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
  return Object.freeze({
    objectClass,
    sectionName,
    binding: Object.freeze({
      generationId,
      objectId: sha(row.object_id),
      expectedVersion: opaque(row.provider_version),
      expectedSha256: sha(row.ciphertext_sha256),
      expectedSize: decimal(row.size_bytes),
      expectedExpiresAt: expiresAt,
    }) satisfies RecoveryArchiveObjectExpectedBinding,
  })
}

function selectedRecords(scope: RecoveryArchivePreviewScope): readonly string[] {
  return scope.kind === 'whole_sheet' ? [] : scope.recordIds
}

function selectedFields(scope: RecoveryArchivePreviewScope): readonly string[] {
  return scope.kind === 'selected_fields' ? scope.fieldIds : []
}

function blockedResult(
  input: RecoveryArchivePreviewInput,
  blockedReason: RecoveryArchivePreviewBlockedReason,
  summary: PreviewPlanSummary,
  executionKind: 'sync' | 'async' = 'sync',
): RecoveryArchivePreviewResult {
  return Object.freeze({
    generationId: input.generationId,
    mode: input.mode,
    scopeKind: input.scope.kind,
    executionKind,
    executable: false,
    blockedReason,
    previewIdentity: null,
    summary,
  })
}

function emptySummary(): PreviewPlanSummary {
  return Object.freeze({
    reverts: [],
    resurrectIds: [],
    deleteIds: [],
    effectiveWriteCount: 0,
    keptCreatedAfterAnchorCount: 0,
    driftCount: 1,
  })
}

function opaqueIdSet(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) invalid()
  const ids = value.map(opaque).sort()
  if (new Set(ids).size !== ids.length) invalid()
  return Object.freeze(ids)
}

function opaque(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) invalid()
  return value
}

function exact(value: unknown, expected: string): string {
  if (value !== expected) fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
  return expected
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid()
  return value.toLowerCase()
}

function sha(value: unknown): string {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
  }
  return value
}

function decimal(value: unknown): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
  }
  return value
}

function timestamp(value: unknown): string {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    fail('RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID')
  }
  return parsed.toISOString()
}

function invalid(): never {
  fail('RECOVERY_ARCHIVE_PREVIEW_INVALID_INPUT')
}

function fail(code: RecoveryArchivePreviewErrorCode): never {
  throw new RecoveryArchivePreviewError(code)
}
