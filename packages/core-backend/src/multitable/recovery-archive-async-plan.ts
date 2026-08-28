import { createHash } from 'node:crypto'

import type { ExactAnchorRevertWriteIntent } from './exact-anchor-recovery-execute'
import type { AuthoritativeLiveLinkEdge } from './live-link-projection-integrity'
import { canonicalizeRecoveryArchiveJson } from './recovery-archive-manifest'
import {
  createTransactionGuardedRecoveryArchiveObjectStore,
  RecoveryArchiveObjectStoreError,
  type RecoveryArchiveObjectDescriptor,
  type RecoveryArchiveObjectExpectedBinding,
  type RecoveryArchiveObjectStore,
  type RecoveryArchiveObjectStoreProvider,
} from './recovery-archive-object-store'
import {
  compileRecoveryArchiveRestorePlan,
  type RecoveryArchiveRestorePlan,
  type RecoveryArchiveRestorePlanInput,
} from './recovery-archive-restore-plan'
import {
  acceptRecoveryArchiveRestoreJob,
  RecoveryArchiveRestoreJobError,
  type RecoveryArchiveRestoreJobQuery,
  type RecoveryArchiveRestoreJobSnapshot,
  type RecoveryArchiveRestoreJobTransaction,
  type RecoveryArchiveRestoreRequestIdentity,
} from './recovery-archive-restore-jobs'
import type { RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'
import {
  hashAnchorRecoveryScope,
  hashExactAnchorLiveSet,
  type ExactArchiveRecoveryIdentityClaims,
  type ExactArchiveRecoveryScopeKind,
  type ExactAnchorRecoveryMode,
  verifyExactArchiveRecoveryIdentity,
} from './restore-preview-identity'

const PLAN_FORMAT = 'metasheet.recovery-archive.restore-plan.v1'
const CHUNK_FORMAT = 'metasheet.recovery-archive.restore-chunk.v1'
const PLAN_OBJECT_VERSION = 'recovery-archive-restore-plan-v1'
const CHUNK_OBJECT_VERSION = 'recovery-archive-restore-chunk-v1'
const MAX_CHUNK_WRITES = 5000
const SHA_PATTERN = /^[0-9a-f]{64}$/
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/

export type RecoveryArchiveAsyncPlanErrorCode =
  | 'RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID'
  | 'RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID'
  | 'RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_MISMATCH'

export class RecoveryArchiveAsyncPlanError extends Error {
  readonly code: RecoveryArchiveAsyncPlanErrorCode

  constructor(code: RecoveryArchiveAsyncPlanErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveAsyncPlanError'
    this.code = code
  }
}

export type RecoveryArchiveAsyncChunkOperation =
  | {
      readonly kind: 'revert'
      readonly recordId: string
      readonly expectedVersion: number
      readonly changedFieldIds: readonly string[]
    }
  | {
      readonly kind: 'delete'
      readonly recordId: string
      readonly expectedVersion: number
    }

export interface RecoveryArchiveAsyncChunkPayload {
  readonly format: typeof CHUNK_FORMAT
  readonly chunkIndex: number
  readonly expectedAnchorScopeHash: string
  readonly expectedLiveSetHash: string
  readonly expectedFinalLiveSetHash: string
  readonly schemaHash: string
  readonly operations: readonly RecoveryArchiveAsyncChunkOperation[]
}

export interface RecoveryArchiveAsyncPlanChunkDescriptor {
  readonly chunkIndex: number
  readonly chunkHash: string
  readonly objectId: string
  readonly version: string
  readonly sha256: string
  readonly size: string
  readonly expiresAt: string
  readonly recordCount: string
}

export interface RecoveryArchiveAsyncPlanPayload {
  readonly format: typeof PLAN_FORMAT
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly actorId: string
  readonly recoveryMode: ExactAnchorRecoveryMode
  readonly scopeKind: ExactArchiveRecoveryScopeKind
  readonly scopeHash: string
  readonly archiveGenerationId: string
  readonly archiveRootHash: string
  readonly sourceVectorHash: string
  readonly keyId: string
  readonly anchorOperationId: string
  readonly anchorSeq: string
  readonly checkpointId: string
  readonly schemaHash: string
  readonly authorizedScopeHash: string
  readonly initialLiveSetHash: string
  readonly finalLiveSetHash: string
  readonly selectedRecordIds: readonly string[]
  readonly selectedFieldIds: readonly string[]
  readonly chunks: readonly RecoveryArchiveAsyncPlanChunkDescriptor[]
}

export interface RecoveryArchiveAsyncPlanObject<T> {
  readonly payload: T
  readonly descriptor: RecoveryArchiveObjectDescriptor
  readonly bytes: Uint8Array
}

export interface RecoveryArchiveAsyncPlanBundle {
  readonly plan: RecoveryArchiveRestorePlan
  readonly planObject: RecoveryArchiveAsyncPlanObject<RecoveryArchiveAsyncPlanPayload>
  readonly chunkObjects: readonly RecoveryArchiveAsyncPlanObject<RecoveryArchiveAsyncChunkPayload>[]
}

export interface RecoveryArchiveAsyncPlanPersistedBinding {
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly actorId: string
  readonly recoveryMode: ExactAnchorRecoveryMode
  readonly scopeKind: ExactArchiveRecoveryScopeKind
  readonly scopeHash: string
  readonly archiveGenerationId: string
  readonly archiveRootHash: string
  readonly sourceVectorHash: string
  readonly keyId: string
  readonly planHash: string
  readonly planObjectId: string
  readonly planObjectVersion: string
  readonly planObjectSha256: string
  readonly planObjectSize: string
  readonly planObjectExpiresAt: string
}

export interface BuildRecoveryArchiveAsyncPlanInput {
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly actorId: string
  readonly recoveryMode: ExactAnchorRecoveryMode
  readonly scopeKind: ExactArchiveRecoveryScopeKind
  readonly scopeHash: string
  readonly archiveGenerationId: string
  readonly archiveRootHash: string
  readonly sourceVectorHash: string
  readonly keyId: string
  readonly anchorOperationId: string
  readonly anchorSeq: string
  readonly checkpointId: string
  readonly schemaHash: string
  readonly authorizedScopeHash: string
  readonly selectedRecordIds: readonly string[]
  readonly selectedFieldIds: readonly string[]
  readonly liveRecords: ReadonlyMap<string, { readonly version: number }>
  readonly targetRecords: ReadonlyMap<string, {
    readonly recordId: string
    readonly exists: boolean
    readonly version: number | null
  }>
  readonly liveLinks: readonly AuthoritativeLiveLinkEdge[]
  readonly revertWrites: readonly ExactAnchorRevertWriteIntent[]
  readonly deleteRecordIds: readonly string[]
  readonly expiresAt: string
}

export function buildRecoveryArchiveAsyncPlan(
  input: BuildRecoveryArchiveAsyncPlanInput,
): RecoveryArchiveAsyncPlanBundle {
  const admitted = admitBuildInput(input)
  const operations = buildOperations(admitted)
  if (operations.length <= MAX_CHUNK_WRITES) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')

  const versions = new Map(admitted.liveRecords)
  let links = admitted.liveLinks.map((edge) => ({ ...edge }))
  const chunkObjects: RecoveryArchiveAsyncPlanObject<RecoveryArchiveAsyncChunkPayload>[] = []
  for (let offset = 0; offset < operations.length; offset += MAX_CHUNK_WRITES) {
    const chunkIndex = chunkObjects.length
    const chunkOperations = operations.slice(offset, offset + MAX_CHUNK_WRITES)
    const expectedLiveSetHash = hashLiveState(versions, links)
    const expectedAnchorScopeHash = hashAnchorRecoveryScope(
      chunkOperations.map((operation) => admitted.targetRecords.get(operation.recordId)!),
    )
    for (const operation of chunkOperations) {
      const currentVersion = versions.get(operation.recordId)
      if (currentVersion !== operation.expectedVersion) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
      if (operation.kind === 'delete') {
        versions.delete(operation.recordId)
        links = links.filter(
          (edge) => edge.recordId !== operation.recordId && edge.foreignRecordId !== operation.recordId,
        )
        continue
      }
      versions.set(operation.recordId, currentVersion + 1)
      const write = admitted.revertWriteByRecordId.get(operation.recordId)
      if (!write) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
      for (const update of write.linkUpdates) {
        links = links.filter(
          (edge) => edge.recordId !== operation.recordId || edge.fieldId !== update.fieldId,
        )
        for (const foreignRecordId of update.targetIds) {
          links.push({ fieldId: update.fieldId, recordId: operation.recordId, foreignRecordId })
        }
      }
    }
    const payload: RecoveryArchiveAsyncChunkPayload = Object.freeze({
      format: CHUNK_FORMAT,
      chunkIndex,
      expectedAnchorScopeHash,
      expectedLiveSetHash,
      expectedFinalLiveSetHash: hashLiveState(versions, links),
      schemaHash: admitted.schemaHash,
      operations: Object.freeze(chunkOperations.map(freezeOperation)),
    })
    chunkObjects.push(objectForPayload(
      admitted.archiveGenerationId,
      CHUNK_OBJECT_VERSION,
      admitted.expiresAt,
      payload,
    ))
  }

  const chunks = chunkObjects.map((object, chunkIndex) => Object.freeze({
    chunkIndex,
    chunkHash: object.descriptor.sha256,
    objectId: object.descriptor.objectId,
    version: object.descriptor.version,
    sha256: object.descriptor.sha256,
    size: object.descriptor.size,
    expiresAt: object.descriptor.expiresAt,
    recordCount: String(object.payload.operations.length),
  }))
  const initialLiveSetHash = chunkObjects[0]?.payload.expectedLiveSetHash
  if (!initialLiveSetHash) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  const planPayload: RecoveryArchiveAsyncPlanPayload = Object.freeze({
    format: PLAN_FORMAT,
    workspaceId: admitted.workspaceId,
    baseId: admitted.baseId,
    sheetId: admitted.sheetId,
    actorId: admitted.actorId,
    recoveryMode: admitted.recoveryMode,
    scopeKind: admitted.scopeKind,
    scopeHash: admitted.scopeHash,
    archiveGenerationId: admitted.archiveGenerationId,
    archiveRootHash: admitted.archiveRootHash,
    sourceVectorHash: admitted.sourceVectorHash,
    keyId: admitted.keyId,
    anchorOperationId: admitted.anchorOperationId,
    anchorSeq: admitted.anchorSeq,
    checkpointId: admitted.checkpointId,
    schemaHash: admitted.schemaHash,
    authorizedScopeHash: admitted.authorizedScopeHash,
    initialLiveSetHash,
    finalLiveSetHash: hashLiveState(versions, links),
    selectedRecordIds: Object.freeze([...admitted.selectedRecordIds]),
    selectedFieldIds: Object.freeze([...admitted.selectedFieldIds]),
    chunks: Object.freeze(chunks),
  })
  const planObject = objectForPayload(
    admitted.archiveGenerationId,
    PLAN_OBJECT_VERSION,
    admitted.expiresAt,
    planPayload,
  )
  const plan = compileRecoveryArchiveRestorePlan(planInputFromPayload(planPayload, planObject.descriptor))
  return Object.freeze({
    plan,
    planObject,
    chunkObjects: Object.freeze(chunkObjects),
  })
}

export async function persistRecoveryArchiveAsyncPlan(
  store: RecoveryArchiveObjectStore,
  bundle: RecoveryArchiveAsyncPlanBundle,
): Promise<void> {
  for (const object of bundle.chunkObjects) await putExactObject(store, object)
  await putExactObject(store, bundle.planObject)
}

export async function loadRecoveryArchiveAsyncPlan(
  provider: RecoveryArchiveObjectStoreProvider,
  transactionDepth: RecoveryArchiveTransactionDepthProbe,
  claims: ExactArchiveRecoveryIdentityClaims,
): Promise<{
  readonly plan: RecoveryArchiveRestorePlan
  readonly payload: RecoveryArchiveAsyncPlanPayload
}> {
  const binding = claims.archivePlanObject
  if (!binding) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  const loaded = await loadRecoveryArchiveAsyncPlanObject(provider, transactionDepth, {
    workspaceId: '',
    baseId: '',
    sheetId: claims.sheetId,
    actorId: claims.actorId,
    recoveryMode: claims.mode,
    scopeKind: claims.scopeKind,
    scopeHash: claims.scopeHash,
    archiveGenerationId: claims.archiveGenerationId,
    archiveRootHash: claims.archiveRootHash,
    sourceVectorHash: claims.archiveSourceVectorHash,
    keyId: claims.archiveKeyId,
    planHash: claims.archivePlanHash,
    planObjectId: binding.objectId,
    planObjectVersion: binding.version,
    planObjectSha256: binding.sha256,
    planObjectSize: binding.size,
    planObjectExpiresAt: binding.expiresAt,
  }, false)
  const { payload } = loaded
  if (
    payload.anchorOperationId !== claims.anchorOperationId ||
    payload.anchorSeq !== claims.anchorSeq ||
    payload.checkpointId !== claims.checkpointId ||
    payload.schemaHash !== claims.schemaHash ||
    payload.authorizedScopeHash !== claims.authorizedScopeHash ||
    payload.initialLiveSetHash !== claims.liveSetHash
  ) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_MISMATCH')
  }
  return loaded
}

/** Load one immutable plan from the accepted job binding; no raw JWT is required by the worker. */
export async function loadRecoveryArchiveAsyncPlanByBinding(
  provider: RecoveryArchiveObjectStoreProvider,
  transactionDepth: RecoveryArchiveTransactionDepthProbe,
  binding: RecoveryArchiveAsyncPlanPersistedBinding,
): Promise<{
  readonly plan: RecoveryArchiveRestorePlan
  readonly payload: RecoveryArchiveAsyncPlanPayload
}> {
  return loadRecoveryArchiveAsyncPlanObject(provider, transactionDepth, binding, true)
}

async function loadRecoveryArchiveAsyncPlanObject(
  provider: RecoveryArchiveObjectStoreProvider,
  transactionDepth: RecoveryArchiveTransactionDepthProbe,
  binding: RecoveryArchiveAsyncPlanPersistedBinding,
  verifyWorkspaceAndBase: boolean,
): Promise<{
  readonly plan: RecoveryArchiveRestorePlan
  readonly payload: RecoveryArchiveAsyncPlanPayload
}> {
  const store = createTransactionGuardedRecoveryArchiveObjectStore(provider, transactionDepth)
  const expected: RecoveryArchiveObjectExpectedBinding = {
    generationId: binding.archiveGenerationId,
    objectId: binding.planObjectId,
    expectedVersion: binding.planObjectVersion,
    expectedSha256: binding.planObjectSha256,
    expectedSize: binding.planObjectSize,
    expectedExpiresAt: binding.planObjectExpiresAt,
  }
  const read = await store.get(expected)
  const payload = parsePlanPayload(read.bytes)
  if (
    (verifyWorkspaceAndBase && (
      payload.workspaceId !== binding.workspaceId || payload.baseId !== binding.baseId
    )) ||
    payload.sheetId !== binding.sheetId ||
    payload.actorId !== binding.actorId ||
    payload.recoveryMode !== binding.recoveryMode ||
    payload.scopeKind !== binding.scopeKind ||
    payload.scopeHash !== binding.scopeHash ||
    payload.archiveGenerationId !== binding.archiveGenerationId ||
    payload.archiveRootHash !== binding.archiveRootHash ||
    payload.sourceVectorHash !== binding.sourceVectorHash ||
    payload.keyId !== binding.keyId
  ) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_MISMATCH')
  }
  const descriptor = descriptorFromRead(read)
  const plan = compileRecoveryArchiveRestorePlan(planInputFromPayload(payload, descriptor))
  if (plan.planHash !== binding.planHash) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_MISMATCH')
  return Object.freeze({ plan, payload })
}

export async function acceptFrozenRecoveryArchiveRestoreJob(
  transaction: RecoveryArchiveRestoreJobTransaction,
  provider: RecoveryArchiveObjectStoreProvider,
  transactionDepth: RecoveryArchiveTransactionDepthProbe,
  input: {
    readonly identity: RecoveryArchiveRestoreRequestIdentity
    readonly token: string
    readonly resumeDeadline: Date | string
    readonly recheckAuthority: (query: RecoveryArchiveRestoreJobQuery) => Promise<boolean>
  },
): Promise<RecoveryArchiveRestoreJobSnapshot> {
  const { identity, token } = input
  const verified = verifyExactArchiveRecoveryIdentity(token, {
    sheetId: identity.sheetId,
    actorId: identity.actorId,
  })
  if (!verified.valid || !verified.claims?.archivePlanObject) {
    throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_IDENTITY_INVALID')
  }
  let loaded
  try {
    loaded = await loadRecoveryArchiveAsyncPlan(provider, transactionDepth, verified.claims)
  } catch (error) {
    if (error instanceof RecoveryArchiveObjectStoreError) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_PERSISTENCE_INVALID')
    }
    if (error instanceof RecoveryArchiveAsyncPlanError) {
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_IDENTITY_INVALID')
    }
    throw error
  }
  return acceptRecoveryArchiveRestoreJob(transaction, {
    token,
    plan: loaded.plan,
    identity,
    resumeDeadline: input.resumeDeadline,
    recheckAuthority: async (query) => input.recheckAuthority(query),
  })
}

export async function loadRecoveryArchiveAsyncChunk(
  provider: RecoveryArchiveObjectStoreProvider,
  transactionDepth: RecoveryArchiveTransactionDepthProbe,
  generationId: string,
  descriptor: RecoveryArchiveAsyncPlanChunkDescriptor,
): Promise<RecoveryArchiveAsyncChunkPayload> {
  const store = createTransactionGuardedRecoveryArchiveObjectStore(provider, transactionDepth)
  const read = await store.get({
    generationId,
    objectId: descriptor.objectId,
    expectedVersion: descriptor.version,
    expectedSha256: descriptor.sha256,
    expectedSize: descriptor.size,
    expectedExpiresAt: descriptor.expiresAt,
  })
  const payload = parseChunkPayload(read.bytes)
  if (
    payload.chunkIndex !== descriptor.chunkIndex ||
    payload.operations.length.toString() !== descriptor.recordCount ||
    read.sha256 !== descriptor.chunkHash
  ) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_MISMATCH')
  }
  return payload
}

function admitBuildInput(input: BuildRecoveryArchiveAsyncPlanInput) {
  if (!input || typeof input !== 'object') fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  const recoveryMode = input.recoveryMode
  if (recoveryMode !== 'revert' && recoveryMode !== 'reset') fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  const scopeKind = input.scopeKind
  if (scopeKind !== 'whole_sheet' && scopeKind !== 'selected_records' && scopeKind !== 'selected_fields') {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  }
  const expiresAt = timestamp(input.expiresAt)
  const liveRecords = new Map<string, number>()
  for (const [recordId, live] of input.liveRecords) {
    const id = opaque(recordId)
    if (!live || !Number.isSafeInteger(live.version) || live.version < 0 || liveRecords.has(id)) {
      fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
    }
    liveRecords.set(id, live.version)
  }
  const targetRecords = new Map<string, { recordId: string; exists: boolean; version: number | null }>()
  for (const [recordId, target] of input.targetRecords) {
    const id = opaque(recordId)
    if (
      !target || target.recordId !== id || typeof target.exists !== 'boolean' || targetRecords.has(id) ||
      (target.exists
        ? !Number.isSafeInteger(target.version) || (target.version as number) < 0
        : target.version !== null)
    ) {
      fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
    }
    targetRecords.set(id, { recordId: id, exists: target.exists, version: target.version })
  }
  const liveLinks = input.liveLinks.map((edge) => ({
    fieldId: opaque(edge.fieldId),
    recordId: opaque(edge.recordId),
    foreignRecordId: opaque(edge.foreignRecordId),
  }))
  const linkKeys = liveLinks.map((edge) => JSON.stringify([edge.fieldId, edge.recordId, edge.foreignRecordId]))
  if (new Set(linkKeys).size !== linkKeys.length) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')

  const revertWriteByRecordId = new Map<string, ExactAnchorRevertWriteIntent>()
  for (const write of input.revertWrites) {
    const recordId = opaque(write.recordId)
    if (
      revertWriteByRecordId.has(recordId) ||
      !Number.isSafeInteger(write.liveVersion) ||
      write.liveVersion < 0 ||
      liveRecords.get(recordId) !== write.liveVersion ||
      !Array.isArray(write.changedFieldIds) ||
      write.changedFieldIds.length === 0
    ) {
      fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
    }
    const changedFieldIds = sortedUniqueIds(write.changedFieldIds)
    const linkUpdates = write.linkUpdates.map((update) => ({
      fieldId: opaque(update.fieldId),
      targetIds: sortedUniqueIds(update.targetIds),
    }))
    if (new Set(linkUpdates.map((update) => update.fieldId)).size !== linkUpdates.length) {
      fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
    }
    revertWriteByRecordId.set(recordId, {
      ...write,
      recordId,
      changedFieldIds,
      linkUpdates,
    })
  }
  const deleteRecordIds = sortedUniqueIds(input.deleteRecordIds)
  if (deleteRecordIds.some((recordId) => !liveRecords.has(recordId) || revertWriteByRecordId.has(recordId))) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  }
  if (recoveryMode === 'reset') {
    for (const recordId of deleteRecordIds) {
      if (!targetRecords.has(recordId)) {
        targetRecords.set(recordId, { recordId, exists: false, version: null })
      }
    }
  }
  if (
    [...revertWriteByRecordId.keys()].some((recordId) => targetRecords.get(recordId)?.exists !== true) ||
    deleteRecordIds.some((recordId) => targetRecords.get(recordId)?.exists !== false)
  ) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  }

  return {
    workspaceId: opaque(input.workspaceId),
    baseId: opaque(input.baseId),
    sheetId: opaque(input.sheetId),
    actorId: opaque(input.actorId),
    recoveryMode,
    scopeKind,
    scopeHash: sha(input.scopeHash),
    archiveGenerationId: uuid(input.archiveGenerationId),
    archiveRootHash: sha(input.archiveRootHash),
    sourceVectorHash: sha(input.sourceVectorHash),
    keyId: opaque(input.keyId),
    anchorOperationId: uuid(input.anchorOperationId),
    anchorSeq: decimal(input.anchorSeq),
    checkpointId: opaque(input.checkpointId),
    schemaHash: sha(input.schemaHash),
    authorizedScopeHash: sha(input.authorizedScopeHash),
    selectedRecordIds: sortedUniqueIds(input.selectedRecordIds),
    selectedFieldIds: sortedUniqueIds(input.selectedFieldIds),
    liveRecords,
    targetRecords,
    liveLinks,
    revertWriteByRecordId,
    deleteRecordIds,
    expiresAt,
  }
}

function buildOperations(admitted: ReturnType<typeof admitBuildInput>): RecoveryArchiveAsyncChunkOperation[] {
  const operations: RecoveryArchiveAsyncChunkOperation[] = []
  for (const write of admitted.revertWriteByRecordId.values()) {
    operations.push({
      kind: 'revert',
      recordId: write.recordId,
      expectedVersion: write.liveVersion,
      changedFieldIds: Object.freeze([...write.changedFieldIds]),
    })
  }
  for (const recordId of admitted.deleteRecordIds) {
    const expectedVersion = admitted.liveRecords.get(recordId)
    if (expectedVersion === undefined) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
    operations.push({ kind: 'delete', recordId, expectedVersion })
  }
  return operations.sort((left, right) => left.recordId.localeCompare(right.recordId))
}

function objectForPayload<T>(
  generationId: string,
  version: string,
  expiresAt: string,
  payload: T,
): RecoveryArchiveAsyncPlanObject<T> {
  const bytes = new TextEncoder().encode(canonicalizeRecoveryArchiveJson(payload))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const descriptor = Object.freeze({
    generationId,
    objectId: sha256,
    version,
    sha256,
    size: String(bytes.byteLength),
    expiresAt,
    pinned: false,
  })
  return Object.freeze({ payload, descriptor, bytes })
}

async function putExactObject<T>(
  store: RecoveryArchiveObjectStore,
  object: RecoveryArchiveAsyncPlanObject<T>,
): Promise<void> {
  const result = await store.put({ ...object.descriptor, bytes: object.bytes })
  if (
    result.object.objectId !== object.descriptor.objectId ||
    result.object.version !== object.descriptor.version ||
    result.object.sha256 !== object.descriptor.sha256 ||
    result.object.size !== object.descriptor.size ||
    result.object.expiresAt !== object.descriptor.expiresAt ||
    result.object.pinned !== false
  ) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_MISMATCH')
  }
}

function planInputFromPayload(
  payload: RecoveryArchiveAsyncPlanPayload,
  descriptor: RecoveryArchiveObjectDescriptor,
): RecoveryArchiveRestorePlanInput {
  return {
    workspaceId: payload.workspaceId,
    baseId: payload.baseId,
    sheetId: payload.sheetId,
    actorId: payload.actorId,
    recoveryMode: payload.recoveryMode,
    scopeKind: payload.scopeKind,
    scopeHash: payload.scopeHash,
    archiveGenerationId: payload.archiveGenerationId,
    archiveRootHash: payload.archiveRootHash,
    sourceVectorHash: payload.sourceVectorHash,
    keyId: payload.keyId,
    planObjectId: descriptor.objectId,
    planObjectVersion: descriptor.version,
    planObjectSha256: descriptor.sha256,
    planObjectSize: descriptor.size,
    planObjectExpiresAt: descriptor.expiresAt,
    chunks: payload.chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      chunkHash: chunk.chunkHash,
      chunkObjectId: chunk.objectId,
      chunkObjectVersion: chunk.version,
      chunkObjectSha256: chunk.sha256,
      chunkObjectSize: chunk.size,
      chunkObjectExpiresAt: chunk.expiresAt,
      recordCount: chunk.recordCount,
    })),
  }
}

function parsePlanPayload(bytes: Uint8Array): RecoveryArchiveAsyncPlanPayload {
  const value = parseCanonicalJson(bytes)
  const row = exactRecord(value, [
    'actorId', 'anchorOperationId', 'anchorSeq', 'archiveGenerationId', 'archiveRootHash',
    'authorizedScopeHash', 'baseId', 'checkpointId', 'chunks', 'finalLiveSetHash', 'format', 'initialLiveSetHash',
    'keyId', 'recoveryMode', 'schemaHash', 'scopeHash', 'scopeKind', 'selectedFieldIds',
    'selectedRecordIds', 'sheetId', 'sourceVectorHash', 'workspaceId',
  ])
  if (row.format !== PLAN_FORMAT || !Array.isArray(row.chunks) || row.chunks.length < 2) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  const chunks = row.chunks.map((value, index) => parseChunkDescriptor(value, index))
  return Object.freeze({
    format: PLAN_FORMAT,
    workspaceId: objectOpaque(row.workspaceId),
    baseId: objectOpaque(row.baseId),
    sheetId: objectOpaque(row.sheetId),
    actorId: objectOpaque(row.actorId),
    recoveryMode: objectMode(row.recoveryMode),
    scopeKind: objectScopeKind(row.scopeKind),
    scopeHash: objectSha(row.scopeHash),
    archiveGenerationId: objectUuid(row.archiveGenerationId),
    archiveRootHash: objectSha(row.archiveRootHash),
    sourceVectorHash: objectSha(row.sourceVectorHash),
    keyId: objectOpaque(row.keyId),
    anchorOperationId: objectUuid(row.anchorOperationId),
    anchorSeq: objectDecimal(row.anchorSeq),
    checkpointId: objectOpaque(row.checkpointId),
    schemaHash: objectSha(row.schemaHash),
    authorizedScopeHash: objectSha(row.authorizedScopeHash),
    initialLiveSetHash: objectSha(row.initialLiveSetHash),
    finalLiveSetHash: objectSha(row.finalLiveSetHash),
    selectedRecordIds: Object.freeze(objectIdArray(row.selectedRecordIds)),
    selectedFieldIds: Object.freeze(objectIdArray(row.selectedFieldIds)),
    chunks: Object.freeze(chunks),
  })
}

function parseChunkPayload(bytes: Uint8Array): RecoveryArchiveAsyncChunkPayload {
  const value = parseCanonicalJson(bytes)
  const row = exactRecord(value, [
    'chunkIndex', 'expectedAnchorScopeHash', 'expectedFinalLiveSetHash', 'expectedLiveSetHash',
    'format', 'operations', 'schemaHash',
  ])
  if (
    row.format !== CHUNK_FORMAT ||
    !Number.isSafeInteger(row.chunkIndex) ||
    (row.chunkIndex as number) < 0 ||
    !Array.isArray(row.operations) ||
    row.operations.length < 1 ||
    row.operations.length > MAX_CHUNK_WRITES
  ) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  const operations = row.operations.map(parseOperation)
  if (new Set(operations.map((operation) => operation.recordId)).size !== operations.length) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  return Object.freeze({
    format: CHUNK_FORMAT,
    chunkIndex: row.chunkIndex as number,
    expectedAnchorScopeHash: objectSha(row.expectedAnchorScopeHash),
    expectedLiveSetHash: objectSha(row.expectedLiveSetHash),
    expectedFinalLiveSetHash: objectSha(row.expectedFinalLiveSetHash),
    schemaHash: objectSha(row.schemaHash),
    operations: Object.freeze(operations),
  })
}

function parseChunkDescriptor(value: unknown, index: number): RecoveryArchiveAsyncPlanChunkDescriptor {
  const row = exactRecord(value, [
    'chunkHash', 'chunkIndex', 'expiresAt', 'objectId', 'recordCount', 'sha256', 'size', 'version',
  ])
  if (row.chunkIndex !== index) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  const descriptor = Object.freeze({
    chunkIndex: index,
    chunkHash: objectSha(row.chunkHash),
    objectId: objectSha(row.objectId),
    version: objectOpaque(row.version),
    sha256: objectSha(row.sha256),
    size: objectPositiveDecimal(row.size),
    expiresAt: objectTimestamp(row.expiresAt),
    recordCount: objectPositiveDecimal(row.recordCount),
  })
  if (
    descriptor.chunkHash !== descriptor.sha256 ||
    BigInt(descriptor.recordCount) > BigInt(MAX_CHUNK_WRITES)
  ) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  return descriptor
}

function parseOperation(value: unknown): RecoveryArchiveAsyncChunkOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'delete') {
    const row = exactRecord(value, ['expectedVersion', 'kind', 'recordId'])
    return Object.freeze({
      kind,
      recordId: objectOpaque(row.recordId),
      expectedVersion: objectVersion(row.expectedVersion),
    })
  }
  if (kind === 'revert') {
    const row = exactRecord(value, ['changedFieldIds', 'expectedVersion', 'kind', 'recordId'])
    const changedFieldIds = objectIdArray(row.changedFieldIds)
    if (changedFieldIds.length === 0) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
    return Object.freeze({
      kind,
      recordId: objectOpaque(row.recordId),
      expectedVersion: objectVersion(row.expectedVersion),
      changedFieldIds: Object.freeze(changedFieldIds),
    })
  }
  fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
}

function parseCanonicalJson(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const value = JSON.parse(text) as unknown
    if (canonicalizeRecoveryArchiveJson(value) !== text) {
      fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
    }
    return value
  } catch (error) {
    if (error instanceof RecoveryArchiveAsyncPlanError) throw error
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
}

function descriptorFromRead(read: {
  generationId: string
  objectId: string
  version: string
  sha256: string
  size: string
  expiresAt: string
  pinned: boolean
}): RecoveryArchiveObjectDescriptor {
  if (read.objectId !== read.sha256 || read.pinned) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_MISMATCH')
  return {
    generationId: read.generationId,
    objectId: read.objectId,
    version: read.version,
    sha256: read.sha256,
    size: read.size,
    expiresAt: read.expiresAt,
    pinned: false,
  }
}

function hashLiveState(
  versions: ReadonlyMap<string, number>,
  links: readonly AuthoritativeLiveLinkEdge[],
): string {
  return hashExactAnchorLiveSet(
    [...versions].map(([recordId, version]) => ({ recordId, version })),
    links.map((edge) => ({ ...edge })),
  )
}

function freezeOperation(operation: RecoveryArchiveAsyncChunkOperation): RecoveryArchiveAsyncChunkOperation {
  return operation.kind === 'delete'
    ? Object.freeze({ ...operation })
    : Object.freeze({ ...operation, changedFieldIds: Object.freeze([...operation.changedFieldIds]) })
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Object.keys(descriptors).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  const row: Record<string, unknown> = {}
  for (const key of expected) {
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor)) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
    row[key] = descriptor.value
  }
  return row
}

function sortedUniqueIds(values: readonly string[]): string[] {
  if (!Array.isArray(values)) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  const result = values.map(opaque).sort()
  if (new Set(result).size !== result.length) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  return result
}

function objectIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  const result = value.map(objectOpaque)
  if (new Set(result).size !== result.length || result.some((id, index) => index > 0 && result[index - 1]! >= id)) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  return result
}

function opaque(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  }
  return value
}

function uuid(value: unknown): string {
  const admitted = opaque(value)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(admitted)) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  }
  return admitted.toLowerCase()
}

function sha(value: unknown): string {
  const admitted = opaque(value)
  if (!SHA_PATTERN.test(admitted)) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  return admitted
}

function decimal(value: unknown): string {
  const admitted = opaque(value)
  if (!DECIMAL_PATTERN.test(admitted)) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  return admitted
}

function timestamp(value: unknown): string {
  const admitted = opaque(value)
  const parsed = new Date(admitted)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== admitted) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_INVALID')
  }
  return admitted
}

function objectOpaque(value: unknown): string {
  try {
    return opaque(value)
  } catch {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
}

function objectUuid(value: unknown): string {
  try {
    return uuid(value)
  } catch {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
}

function objectSha(value: unknown): string {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  return value
}

function objectDecimal(value: unknown): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  return value
}

function objectPositiveDecimal(value: unknown): string {
  const admitted = objectDecimal(value)
  if (BigInt(admitted) < 1n) fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  return admitted
}

function objectTimestamp(value: unknown): string {
  if (typeof value !== 'string') fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  return value
}

function objectMode(value: unknown): ExactAnchorRecoveryMode {
  if (value !== 'revert' && value !== 'reset') fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  return value
}

function objectScopeKind(value: unknown): ExactArchiveRecoveryScopeKind {
  if (value !== 'whole_sheet' && value !== 'selected_records' && value !== 'selected_fields') {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  return value
}

function objectVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('RECOVERY_ARCHIVE_ASYNC_PLAN_OBJECT_INVALID')
  }
  return value as number
}

function fail(code: RecoveryArchiveAsyncPlanErrorCode): never {
  throw new RecoveryArchiveAsyncPlanError(code)
}
