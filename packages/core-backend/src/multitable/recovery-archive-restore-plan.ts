import { createHash } from 'node:crypto'

import type {
  ExactArchiveRecoveryIdentityClaims,
  ExactArchiveRecoveryScopeKind,
  ExactAnchorRecoveryMode,
} from './restore-preview-identity'

export const RECOVERY_ARCHIVE_ASYNC_THRESHOLD = 5000n
export const RECOVERY_ARCHIVE_MAX_CHUNK_RECORDS = 5000n

export type RecoveryArchiveRestorePlanErrorCode =
  | 'RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID'
  | 'RECOVERY_ARCHIVE_RESTORE_PLAN_NOT_ASYNC'
  | 'RECOVERY_ARCHIVE_RESTORE_PLAN_HASH_MISMATCH'

export class RecoveryArchiveRestorePlanError extends Error {
  readonly code: RecoveryArchiveRestorePlanErrorCode

  constructor(code: RecoveryArchiveRestorePlanErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveRestorePlanError'
    this.code = code
  }
}

export interface RecoveryArchiveRestoreChunkIdentityInput {
  chunkIndex: number
  chunkHash: string
  chunkObjectId: string
  chunkObjectSha256: string
  recordCount: string
}

export interface RecoveryArchiveRestorePlanInput {
  workspaceId: string
  baseId: string
  sheetId: string
  actorId: string
  recoveryMode: ExactAnchorRecoveryMode
  scopeKind: ExactArchiveRecoveryScopeKind
  scopeHash: string
  archiveGenerationId: string
  archiveRootHash: string
  sourceVectorHash: string
  keyId: string
  planObjectId: string
  planObjectSha256: string
  chunks: readonly RecoveryArchiveRestoreChunkIdentityInput[]
}

export interface RecoveryArchiveRestoreChunkIdentity {
  readonly chunkIndex: number
  readonly chunkHash: string
  readonly chunkObjectId: string
  readonly chunkObjectSha256: string
  readonly recordCount: string
}

export interface RecoveryArchiveRestorePlan {
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
  readonly planObjectSha256: string
  readonly totalCount: string
  readonly chunks: readonly RecoveryArchiveRestoreChunkIdentity[]
}

export function compileRecoveryArchiveRestorePlan(
  input: RecoveryArchiveRestorePlanInput,
): RecoveryArchiveRestorePlan {
  const admitted = admitPlanInput(input)
  const totalCount = admitted.chunks.reduce(
    (sum, chunk) => sum + BigInt(chunk.recordCount),
    0n,
  )
  if (totalCount <= RECOVERY_ARCHIVE_ASYNC_THRESHOLD) {
    fail('RECOVERY_ARCHIVE_RESTORE_PLAN_NOT_ASYNC')
  }
  const planHash = hashRecoveryArchiveRestorePlan(admitted)
  return Object.freeze({
    ...admitted,
    planHash,
    totalCount: totalCount.toString(),
    chunks: Object.freeze(admitted.chunks.map((chunk) => Object.freeze({ ...chunk }))),
  })
}

export function assertRecoveryArchiveRestorePlanMatchesClaims(
  plan: RecoveryArchiveRestorePlan,
  claims: ExactArchiveRecoveryIdentityClaims,
): void {
  if (
    plan.sheetId !== claims.sheetId ||
    plan.actorId !== claims.actorId ||
    plan.recoveryMode !== claims.mode ||
    plan.scopeKind !== claims.scopeKind ||
    plan.scopeHash !== claims.scopeHash ||
    plan.archiveGenerationId !== claims.archiveGenerationId ||
    plan.archiveRootHash !== claims.archiveRootHash ||
    plan.sourceVectorHash !== claims.archiveSourceVectorHash ||
    plan.keyId !== claims.archiveKeyId ||
    plan.planHash !== claims.archivePlanHash
  ) {
    fail('RECOVERY_ARCHIVE_RESTORE_PLAN_HASH_MISMATCH')
  }
}

export function hashRecoveryArchiveRestorePlan(
  input: Omit<RecoveryArchiveRestorePlan, 'planHash' | 'totalCount'>,
): string {
  const preimage = [
    'recovery-archive-restore-plan-v1',
    input.workspaceId,
    input.baseId,
    input.sheetId,
    input.actorId,
    input.recoveryMode,
    input.scopeKind,
    input.scopeHash,
    input.archiveGenerationId,
    input.archiveRootHash,
    input.sourceVectorHash,
    input.keyId,
    input.planObjectId,
    input.planObjectSha256,
    input.chunks.map((chunk) => [
      chunk.chunkIndex,
      chunk.chunkHash,
      chunk.chunkObjectId,
      chunk.chunkObjectSha256,
      chunk.recordCount,
    ]),
  ]
  return createHash('sha256').update(JSON.stringify(preimage)).digest('hex')
}

function admitPlanInput(input: RecoveryArchiveRestorePlanInput): Omit<
  RecoveryArchiveRestorePlan,
  'planHash' | 'totalCount'
> {
  if (!input || typeof input !== 'object') fail('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID')
  const workspaceId = opaque(input.workspaceId)
  const baseId = opaque(input.baseId)
  const sheetId = opaque(input.sheetId)
  const actorId = opaque(input.actorId)
  const archiveGenerationId = opaque(input.archiveGenerationId)
  const keyId = opaque(input.keyId)
  const planObjectId = opaque(input.planObjectId)
  if (input.recoveryMode !== 'revert' && input.recoveryMode !== 'reset') {
    fail('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID')
  }
  if (
    input.scopeKind !== 'whole_sheet' &&
    input.scopeKind !== 'selected_records' &&
    input.scopeKind !== 'selected_fields'
  ) {
    fail('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID')
  }
  const scopeHash = sha(input.scopeHash)
  const archiveRootHash = sha(input.archiveRootHash)
  const sourceVectorHash = sha(input.sourceVectorHash)
  const planObjectSha256 = sha(input.planObjectSha256)
  if (!Array.isArray(input.chunks) || input.chunks.length < 2) {
    fail('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID')
  }
  const chunks = input.chunks.map((chunk, index) => {
    if (!chunk || typeof chunk !== 'object' || chunk.chunkIndex !== index) {
      fail('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID')
    }
    const count = decimal(chunk.recordCount)
    if (count < 1n || count > RECOVERY_ARCHIVE_MAX_CHUNK_RECORDS) {
      fail('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID')
    }
    return {
      chunkIndex: index,
      chunkHash: sha(chunk.chunkHash),
      chunkObjectId: opaque(chunk.chunkObjectId),
      chunkObjectSha256: sha(chunk.chunkObjectSha256),
      recordCount: count.toString(),
    }
  })
  for (const values of [
    chunks.map((chunk) => chunk.chunkHash),
    chunks.map((chunk) => chunk.chunkObjectId),
    chunks.map((chunk) => chunk.chunkObjectSha256),
  ]) {
    if (new Set(values).size !== values.length) {
      fail('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID')
    }
  }
  return {
    workspaceId,
    baseId,
    sheetId,
    actorId,
    recoveryMode: input.recoveryMode,
    scopeKind: input.scopeKind,
    scopeHash,
    archiveGenerationId,
    archiveRootHash,
    sourceVectorHash,
    keyId,
    planObjectId,
    planObjectSha256,
    chunks,
  }
}

function opaque(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    fail('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID')
  }
  return value
}

function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    fail('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID')
  }
  return value
}

function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID')
  }
  return BigInt(value)
}

function fail(code: RecoveryArchiveRestorePlanErrorCode): never {
  throw new RecoveryArchiveRestorePlanError(code)
}
