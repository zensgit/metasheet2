import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'

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
  test('keeps scalar/link v1 hash byte-equivalent and distinguishes an empty attachment plan', () => {
    const plan = compileRecoveryArchiveSyncPlan(input())
    expect(plan.planHash).toBe(createHash('sha256').update(JSON.stringify([
      'recovery-archive-sync-plan-v1', 'workspace-sync', 'base-sync', 'sheet-sync', 'actor-sync',
      'revert', 'whole_sheet', SHA('1'), 'generation-sync', SHA('2'), SHA('3'), 'key-sync', [], [],
    ])).digest('hex'))
    const attachments = compileRecoveryArchiveSyncPlan(input({ attachmentMetadata: [] }))
    expect(attachments.planHash).not.toBe(plan.planHash)
    expect(() => assertRecoveryArchiveSyncPlanMatchesClaims(attachments, claims(plan))).toThrow(RecoveryArchiveSyncPlanError)
  })

  test('binds every attachment metadata axis and detaches canonical roster from its source', () => {
    const row = { attachmentId: 'att-b', recordId: 'r', fieldId: 'f', metadataHash: SHA('a') }
    const roster = [row, { ...row, attachmentId: 'att-a' }]
    const plan = compileRecoveryArchiveSyncPlan(input({ attachmentMetadata: roster }))
    expect(plan.attachmentMetadata?.map(item => item.attachmentId)).toEqual(['att-a', 'att-b'])
    expect(compileRecoveryArchiveSyncPlan(input({ attachmentMetadata: [...roster].reverse() })).planHash).toBe(plan.planHash)
    for (const replacement of [
      { attachmentId: 'att-other' }, { recordId: 'other-record' },
      { fieldId: 'other-field' }, { metadataHash: SHA('b') },
    ]) {
      const changed = compileRecoveryArchiveSyncPlan(input({ attachmentMetadata: [roster[1]!, { ...row, ...replacement }] }))
      expect(() => assertRecoveryArchiveSyncPlanMatchesClaims(changed, claims(plan))).toThrow(RecoveryArchiveSyncPlanError)
    }
    row.metadataHash = SHA('c')
    expect(plan.attachmentMetadata?.[1]?.metadataHash).toBe(SHA('a'))
    expect(Object.isFrozen(plan.attachmentMetadata)).toBe(true)
    expect(Object.isFrozen(plan.attachmentMetadata?.[0])).toBe(true)
  })

  test('rejects ambiguous, malformed and out-of-scope attachment bindings', () => {
    const row = { attachmentId: 'att', recordId: 'r', fieldId: 'f', metadataHash: SHA('a') }
    for (const attachmentMetadata of [undefined, null, {}, [row, row], [{ ...row, extra: true }],
      [{ ...row, metadataHash: 'bad' }], [{ ...row, recordId: ' r' }]]) {
      expect(() => compileRecoveryArchiveSyncPlan({ ...input(), attachmentMetadata })).toThrow(RecoveryArchiveSyncPlanError)
    }
    expect(() => compileRecoveryArchiveSyncPlan(input({ scopeKind: 'selected_records', selectedRecordIds: ['other'],
      attachmentMetadata: [row] }))).toThrow(RecoveryArchiveSyncPlanError)
    expect(() => compileRecoveryArchiveSyncPlan(input({ scopeKind: 'selected_fields', selectedRecordIds: ['r'],
      selectedFieldIds: ['other'], attachmentMetadata: [row] }))).toThrow(RecoveryArchiveSyncPlanError)
  })
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
