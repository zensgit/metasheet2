import { describe, expect, test } from 'vitest'

import {
  assertRecoveryArchiveSyncPlanMatchesClaims,
  compileRecoveryArchiveSyncPlan,
  RecoveryArchiveSyncPlanError,
  type RecoveryArchiveSyncPlanInput,
} from '../../src/multitable/recovery-archive-sync-plan'
import type { ExactArchiveRecoveryIdentityClaims } from '../../src/multitable/restore-preview-identity'

const SHA = (character: string): string => character.repeat(64)

function input(overrides: Partial<RecoveryArchiveSyncPlanInput> = {}): RecoveryArchiveSyncPlanInput {
  return {
    workspaceId: 'workspace-sync',
    baseId: 'base-sync',
    sheetId: 'sheet-sync',
    actorId: 'actor-sync',
    recoveryMode: 'revert',
    scopeKind: 'whole_sheet',
    scopeHash: SHA('1'),
    archiveGenerationId: 'generation-sync',
    archiveRootHash: SHA('2'),
    sourceVectorHash: SHA('3'),
    keyId: 'key-sync',
    selectedRecordIds: [],
    selectedFieldIds: [],
    ...overrides,
  }
}

function claims(plan = compileRecoveryArchiveSyncPlan(input())): ExactArchiveRecoveryIdentityClaims {
  return {
    sheetId: plan.sheetId,
    anchorOperationId: '00000000-0000-4000-8000-000000000001',
    anchorSeq: '9007199254740993',
    checkpointId: 'checkpoint-sync',
    scopeHash: plan.scopeHash,
    liveSetHash: SHA('4'),
    schemaHash: SHA('5'),
    actorId: plan.actorId,
    mode: plan.recoveryMode,
    authorizedScopeHash: SHA('6'),
    archiveGenerationId: plan.archiveGenerationId,
    archiveRootHash: plan.archiveRootHash,
    archiveSourceVectorHash: plan.sourceVectorHash,
    archiveKeyId: plan.keyId,
    archivePlanHash: plan.planHash,
    scopeKind: plan.scopeKind,
  }
}

describe('recovery archive sync plan', () => {
  test.each([
    input(),
    input({
      scopeKind: 'selected_records',
      selectedRecordIds: ['record-b', 'record-a'],
    }),
    input({
      scopeKind: 'selected_fields',
      selectedRecordIds: ['record-b', 'record-a'],
      selectedFieldIds: ['field-b', 'field-a'],
    }),
  ])('compiles one canonical closed plan and binds all identity axes', (candidate) => {
    const plan = compileRecoveryArchiveSyncPlan(candidate)
    expect(plan.selectedRecordIds).toEqual([...candidate.selectedRecordIds].sort())
    expect(plan.selectedFieldIds).toEqual([...candidate.selectedFieldIds].sort())
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/)
    expect(() => assertRecoveryArchiveSyncPlanMatchesClaims(plan, claims(plan))).not.toThrow()
  })

  test('rejects extra keys, duplicate ids, and scope/list shape mismatches', () => {
    expect(() => compileRecoveryArchiveSyncPlan({ ...input(), extra: true })).toThrow(RecoveryArchiveSyncPlanError)
    expect(() => compileRecoveryArchiveSyncPlan(input({
      scopeKind: 'selected_records',
      selectedRecordIds: ['record-a', 'record-a'],
    }))).toThrow(RecoveryArchiveSyncPlanError)
    expect(() => compileRecoveryArchiveSyncPlan(input({
      scopeKind: 'selected_fields',
      selectedFieldIds: ['field-a'],
    }))).toThrow(RecoveryArchiveSyncPlanError)
  })

  test('keeps selected-record sync at or below the L8 ceiling', () => {
    const atCeiling = Array.from({ length: 5000 }, (_, index) => `record-${String(index).padStart(4, '0')}`)
    expect(compileRecoveryArchiveSyncPlan(input({
      scopeKind: 'selected_records',
      selectedRecordIds: atCeiling,
    })).selectedRecordIds).toHaveLength(5000)
    expect(() => compileRecoveryArchiveSyncPlan(input({
      scopeKind: 'selected_records',
      selectedRecordIds: [...atCeiling, 'record-over-ceiling'],
    }))).toThrow(RecoveryArchiveSyncPlanError)
  })

  test('rejects every token-bound mismatch through one values-free code', () => {
    const plan = compileRecoveryArchiveSyncPlan(input({
      scopeKind: 'selected_fields',
      selectedRecordIds: ['record-a'],
      selectedFieldIds: ['field-a'],
    }))
    expect(() => assertRecoveryArchiveSyncPlanMatchesClaims(plan, {
      ...claims(plan),
      archivePlanHash: SHA('9'),
    })).toThrowError('RECOVERY_ARCHIVE_SYNC_PLAN_HASH_MISMATCH')
  })
})
