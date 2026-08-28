import { describe, expect, test } from 'vitest'

import {
  compileRecoveryArchiveRestorePlan,
  assertRecoveryArchiveRestorePlanMatchesClaims,
  RecoveryArchiveRestorePlanError,
} from '../../src/multitable/recovery-archive-restore-plan'
import {
  hashArchiveRecoveryAuthorizationScope,
  mintExactAnchorRecoveryIdentity,
  mintExactArchiveRecoveryIdentity,
  verifyExactArchiveRecoveryIdentity,
  type ExactArchiveRecoveryIdentityClaims,
} from '../../src/multitable/restore-preview-identity'

const SHA = (value: string): string => value.repeat(64).slice(0, 64)

function planInput() {
  return {
    workspaceId: 'workspace_d5_unit',
    baseId: 'base_d5_unit',
    sheetId: 'sheet_d5_unit',
    actorId: 'actor_d5_unit',
    recoveryMode: 'revert' as const,
    scopeKind: 'selected_records' as const,
    scopeHash: SHA('a'),
    archiveGenerationId: '11111111-1111-4111-8111-111111111111',
    archiveRootHash: SHA('b'),
    sourceVectorHash: SHA('c'),
    keyId: 'key_d5_unit',
    planObjectId: 'plan_object_d5_unit',
    planObjectVersion: 'plan_version_d5_unit',
    planObjectSha256: SHA('d'),
    planObjectSize: '2048',
    planObjectExpiresAt: '2026-09-05T00:00:00.000Z',
    chunks: [
      {
        chunkIndex: 0,
        chunkHash: SHA('e'),
        chunkObjectId: 'chunk_object_0',
        chunkObjectVersion: 'chunk_version_0',
        chunkObjectSha256: SHA('f'),
        chunkObjectSize: '1024',
        chunkObjectExpiresAt: '2026-09-05T00:00:00.000Z',
        recordCount: '5000',
      },
      {
        chunkIndex: 1,
        chunkHash: SHA('1'),
        chunkObjectId: 'chunk_object_1',
        chunkObjectVersion: 'chunk_version_1',
        chunkObjectSha256: SHA('2'),
        chunkObjectSize: '512',
        chunkObjectExpiresAt: '2026-09-05T00:00:00.000Z',
        recordCount: '1',
      },
    ],
  }
}

function claims(planHash: string): ExactArchiveRecoveryIdentityClaims {
  return {
    sheetId: 'sheet_d5_unit',
    anchorOperationId: '22222222-2222-4222-8222-222222222222',
    anchorSeq: '9007199254740993',
    checkpointId: 'checkpoint_d5_unit',
    scopeHash: SHA('a'),
    liveSetHash: SHA('3'),
    schemaHash: SHA('4'),
    actorId: 'actor_d5_unit',
    mode: 'revert',
    authorizedScopeHash: SHA('5'),
    archiveGenerationId: '11111111-1111-4111-8111-111111111111',
    archiveRootHash: SHA('b'),
    archiveSourceVectorHash: SHA('c'),
    archiveKeyId: 'key_d5_unit',
    archivePlanHash: planHash,
    scopeKind: 'selected_records',
  }
}

describe('D5 archive restore identity and frozen plan', () => {
  test('compiles an ordered async plan and binds every archive/chunk identity into its hash', () => {
    const plan = compileRecoveryArchiveRestorePlan(planInput())
    expect(plan.totalCount).toBe('5001')
    expect(plan.chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1])
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/)

    const changed = compileRecoveryArchiveRestorePlan({
      ...planInput(),
      chunks: [
        planInput().chunks[0],
        { ...planInput().chunks[1], chunkObjectId: 'changed_object' },
      ],
    })
    expect(changed.planHash).not.toBe(plan.planHash)

    const changedVersion = compileRecoveryArchiveRestorePlan({
      ...planInput(),
      chunks: [
        planInput().chunks[0],
        { ...planInput().chunks[1], chunkObjectVersion: 'changed_version' },
      ],
    })
    expect(changedVersion.planHash).not.toBe(plan.planHash)
  })

  test('rejects noncanonical object sizes and timestamps', () => {
    for (const invalid of [
      { planObjectSize: '01' },
      { planObjectSize: '0' },
      { planObjectExpiresAt: '2026-09-05T00:00:00Z' },
      {
        chunks: [
          { ...planInput().chunks[0], chunkObjectSize: '-1' },
          planInput().chunks[1],
        ],
      },
    ]) {
      expect(() => compileRecoveryArchiveRestorePlan({
        ...planInput(),
        ...invalid,
      })).toThrowError(new RecoveryArchiveRestorePlanError('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID'))
    }
  })

  test('scope kind is separate from reset/revert semantics and malformed combinations fail closed', () => {
    const selected = hashArchiveRecoveryAuthorizationScope({
      sheetId: 'sheet_d5_unit',
      actorId: 'actor_d5_unit',
      scopeKind: 'selected_fields',
      recordIds: ['record_b', 'record_a'],
      fieldIds: ['field_b', 'field_a'],
    })
    const reordered = hashArchiveRecoveryAuthorizationScope({
      sheetId: 'sheet_d5_unit',
      actorId: 'actor_d5_unit',
      scopeKind: 'selected_fields',
      recordIds: ['record_a', 'record_b'],
      fieldIds: ['field_a', 'field_b'],
    })
    expect(selected).toBe(reordered)
    expect(() => hashArchiveRecoveryAuthorizationScope({
      sheetId: 'sheet_d5_unit',
      actorId: 'actor_d5_unit',
      scopeKind: 'whole_sheet',
      recordIds: ['record_a'],
    })).toThrow(TypeError)
  })

  test('refuses sync-sized, noncontiguous, oversized, or duplicate-shaped chunk plans', () => {
    expect(() => compileRecoveryArchiveRestorePlan({
      ...planInput(),
      chunks: [
        { ...planInput().chunks[0], recordCount: '4999' },
        { ...planInput().chunks[1], recordCount: '1' },
      ],
    })).toThrowError(new RecoveryArchiveRestorePlanError('RECOVERY_ARCHIVE_RESTORE_PLAN_NOT_ASYNC'))
    expect(() => compileRecoveryArchiveRestorePlan({
      ...planInput(),
      chunks: [planInput().chunks[0], { ...planInput().chunks[1], chunkIndex: 3 }],
    })).toThrowError(new RecoveryArchiveRestorePlanError('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID'))
    expect(() => compileRecoveryArchiveRestorePlan({
      ...planInput(),
      chunks: [{ ...planInput().chunks[0], recordCount: '5001' }, planInput().chunks[1]],
    })).toThrowError(new RecoveryArchiveRestorePlanError('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID'))
    for (const duplicate of [
      { chunkHash: planInput().chunks[0].chunkHash },
      { chunkObjectId: planInput().chunks[0].chunkObjectId },
      { chunkObjectSha256: planInput().chunks[0].chunkObjectSha256 },
    ]) {
      expect(() => compileRecoveryArchiveRestorePlan({
        ...planInput(),
        chunks: [
          planInput().chunks[0],
          { ...planInput().chunks[1], ...duplicate },
        ],
      })).toThrowError(new RecoveryArchiveRestorePlanError('RECOVERY_ARCHIVE_RESTORE_PLAN_INVALID'))
    }
  })

  test('archive token is type-disjoint, binds exact plan/generation/root/source/key/scope, and carries expiry', () => {
    const plan = compileRecoveryArchiveRestorePlan(planInput())
    const boundClaims = claims(plan.planHash)
    const token = mintExactArchiveRecoveryIdentity(boundClaims, '10m')
    const verified = verifyExactArchiveRecoveryIdentity(token, {
      sheetId: boundClaims.sheetId,
      actorId: boundClaims.actorId,
    })
    expect(verified.valid).toBe(true)
    expect(verified.claims).toEqual(boundClaims)
    expect(new Date(verified.expiresAt ?? '').getTime()).toBeGreaterThan(Date.now())
    expect(() => assertRecoveryArchiveRestorePlanMatchesClaims(plan, verified.claims!)).not.toThrow()

    const hotToken = mintExactAnchorRecoveryIdentity(boundClaims)
    expect(verifyExactArchiveRecoveryIdentity(hotToken, {
      sheetId: boundClaims.sheetId,
      actorId: boundClaims.actorId,
    })).toMatchObject({ valid: false, reason: 'wrong_type' })
  })

  test('a token-bound plan cannot be swapped across actor, scope, generation, or chunk plan', () => {
    const plan = compileRecoveryArchiveRestorePlan(planInput())
    for (const mismatch of [
      { ...claims(plan.planHash), actorId: 'other_actor' },
      { ...claims(plan.planHash), scopeKind: 'whole_sheet' as const },
      { ...claims(plan.planHash), archiveGenerationId: '33333333-3333-4333-8333-333333333333' },
      { ...claims(plan.planHash), archivePlanHash: SHA('9') },
    ]) {
      expect(() => assertRecoveryArchiveRestorePlanMatchesClaims(plan, mismatch))
        .toThrowError(new RecoveryArchiveRestorePlanError('RECOVERY_ARCHIVE_RESTORE_PLAN_HASH_MISMATCH'))
    }
  })

  test('malformed archive-only claims fail closed without echoing values', () => {
    const plan = compileRecoveryArchiveRestorePlan(planInput())
    const token = mintExactArchiveRecoveryIdentity({
      ...claims(plan.planHash),
      archiveRootHash: 'not-a-hash',
    })
    const result = verifyExactArchiveRecoveryIdentity(token, {
      sheetId: 'sheet_d5_unit',
      actorId: 'actor_d5_unit',
    })
    expect(result).toEqual({ valid: false, reason: 'malformed_archive_claims' })
    expect(JSON.stringify(result)).not.toContain('not-a-hash')
  })
})
