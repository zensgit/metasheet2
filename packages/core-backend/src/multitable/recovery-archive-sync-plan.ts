import { createHash } from 'node:crypto'

import type {
  ExactArchiveRecoveryIdentityClaims,
  ExactArchiveRecoveryScopeKind,
  ExactAnchorRecoveryMode,
} from './restore-preview-identity'
import { RECOVERY_ARCHIVE_ASYNC_THRESHOLD } from './recovery-archive-restore-plan'

const INPUT_KEYS = [
  'actorId',
  'archiveGenerationId',
  'archiveRootHash',
  'baseId',
  'keyId',
  'recoveryMode',
  'scopeHash',
  'scopeKind',
  'selectedFieldIds',
  'selectedRecordIds',
  'sheetId',
  'sourceVectorHash',
  'workspaceId',
] as const

export type RecoveryArchiveSyncPlanErrorCode =
  | 'RECOVERY_ARCHIVE_SYNC_PLAN_INVALID'
  | 'RECOVERY_ARCHIVE_SYNC_PLAN_HASH_MISMATCH'

export class RecoveryArchiveSyncPlanError extends Error {
  readonly code: RecoveryArchiveSyncPlanErrorCode

  constructor(code: RecoveryArchiveSyncPlanErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveSyncPlanError'
    this.code = code
  }
}

export interface RecoveryArchiveSyncPlanInput {
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
  selectedRecordIds: readonly string[]
  selectedFieldIds: readonly string[]
}

export interface RecoveryArchiveSyncPlan extends RecoveryArchiveSyncPlanInput {
  readonly planHash: string
}

export function compileRecoveryArchiveSyncPlan(input: unknown): RecoveryArchiveSyncPlan {
  const source = exactRecord(input, INPUT_KEYS)
  const plan = {
    workspaceId: opaque(source.workspaceId),
    baseId: opaque(source.baseId),
    sheetId: opaque(source.sheetId),
    actorId: opaque(source.actorId),
    recoveryMode: mode(source.recoveryMode),
    scopeKind: scopeKind(source.scopeKind),
    scopeHash: sha(source.scopeHash),
    archiveGenerationId: opaque(source.archiveGenerationId),
    archiveRootHash: sha(source.archiveRootHash),
    sourceVectorHash: sha(source.sourceVectorHash),
    keyId: opaque(source.keyId),
    selectedRecordIds: opaqueIdSet(source.selectedRecordIds),
    selectedFieldIds: opaqueIdSet(source.selectedFieldIds),
  }
  assertSelectionShape(plan)
  return Object.freeze({
    ...plan,
    selectedRecordIds: Object.freeze(plan.selectedRecordIds),
    selectedFieldIds: Object.freeze(plan.selectedFieldIds),
    planHash: hashRecoveryArchiveSyncPlan(plan),
  })
}

export function assertRecoveryArchiveSyncPlanMatchesClaims(
  plan: RecoveryArchiveSyncPlan,
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
    fail('RECOVERY_ARCHIVE_SYNC_PLAN_HASH_MISMATCH')
  }
}

export function hashRecoveryArchiveSyncPlan(
  plan: Omit<RecoveryArchiveSyncPlan, 'planHash'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'recovery-archive-sync-plan-v1',
      plan.workspaceId,
      plan.baseId,
      plan.sheetId,
      plan.actorId,
      plan.recoveryMode,
      plan.scopeKind,
      plan.scopeHash,
      plan.archiveGenerationId,
      plan.archiveRootHash,
      plan.sourceVectorHash,
      plan.keyId,
      plan.selectedRecordIds,
      plan.selectedFieldIds,
    ]))
    .digest('hex')
}

function assertSelectionShape(plan: Omit<RecoveryArchiveSyncPlan, 'planHash'>): void {
  if (plan.scopeKind === 'whole_sheet') {
    if (plan.selectedRecordIds.length !== 0 || plan.selectedFieldIds.length !== 0) invalid()
    return
  }
  if (plan.scopeKind === 'selected_records') {
    if (
      plan.selectedRecordIds.length === 0 ||
      BigInt(plan.selectedRecordIds.length) > RECOVERY_ARCHIVE_ASYNC_THRESHOLD ||
      plan.selectedFieldIds.length !== 0
    ) {
      invalid()
    }
    return
  }
  if (
    plan.selectedRecordIds.length === 0 ||
    BigInt(plan.selectedRecordIds.length) > RECOVERY_ARCHIVE_ASYNC_THRESHOLD ||
    plan.selectedFieldIds.length === 0
  ) {
    invalid()
  }
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== expectedKeys.length) invalid()
  const expected = new Set(expectedKeys)
  const admitted: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string' || !expected.has(key)) invalid()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid()
    admitted[key] = descriptor.value
  }
  return admitted
}

function opaque(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) invalid()
  return value
}

function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid()
  return value
}

function mode(value: unknown): ExactAnchorRecoveryMode {
  if (value !== 'revert' && value !== 'reset') invalid()
  return value
}

function scopeKind(value: unknown): ExactArchiveRecoveryScopeKind {
  if (value !== 'whole_sheet' && value !== 'selected_records' && value !== 'selected_fields') invalid()
  return value
}

function opaqueIdSet(value: unknown): string[] {
  if (!Array.isArray(value)) invalid()
  const admitted = value.map(opaque)
  const sorted = [...admitted].sort()
  if (new Set(sorted).size !== sorted.length) invalid()
  return sorted
}

function invalid(): never {
  fail('RECOVERY_ARCHIVE_SYNC_PLAN_INVALID')
}

function fail(code: RecoveryArchiveSyncPlanErrorCode): never {
  throw new RecoveryArchiveSyncPlanError(code)
}
