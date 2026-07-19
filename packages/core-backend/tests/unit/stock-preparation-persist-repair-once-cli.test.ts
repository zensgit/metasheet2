import { describe, expect, test } from 'vitest'

import {
  APPLY_CONFIRMATION,
  buildRepairInvocation,
  buildValuesFreeCliFailure,
  buildValuesFreeCliSummary,
  normalizeRepairManifest,
  parseRepairCliArgs,
} from '../../scripts/stock-preparation-persist-repair-once'

describe('stock-preparation one-shot repair CLI contract', () => {
  test('defaults to dry-run and requires the exact typed confirmation for apply', () => {
    expect(parseRepairCliArgs(['--input', './repair.json'])).toMatchObject({ apply: false })
    expect(() => parseRepairCliArgs(['--input', './repair.json', '--apply']))
      .toThrow('REPAIR_CONFIRMATION_INVALID')
    expect(parseRepairCliArgs([
      '--input', './repair.json', '--apply', '--confirm', APPLY_CONFIRMATION,
    ])).toMatchObject({ apply: true })
    expect(() => parseRepairCliArgs(['--input', './repair.json', '--confirm', APPLY_CONFIRMATION]))
      .toThrow('REPAIR_CONFIRMATION_WITHOUT_APPLY')
  })

  test('manifest cannot steer scope or inject runtime capabilities', () => {
    for (const key of [
      'targetProjectId', 'lockTenantId', 'permission', 'recordsApi', 'provisioning', 'auditStore', 'apply',
    ]) {
      expect(() => normalizeRepairManifest({ tenantId: 'tenant_1', actorId: 'user_1', [key]: 'hostile' }))
        .toThrow('REPAIR_MANIFEST_FORBIDDEN_KEY')
    }
  })

  test('tenant-bound staging scope and admin capability are derived, never caller supplied', () => {
    const manifest = normalizeRepairManifest({
      tenantId: 'tenant_1',
      actorId: 'user_1',
      projectId: 'project_1',
      snapshotBatchId: 'batch_1',
    })
    const invocation = buildRepairInvocation(
      manifest,
      { recordsApi: 'records', provisioning: 'provisioning', auditStore: 'audit' },
      false,
    )
    expect(invocation).toMatchObject({
      permission: 'admin',
      lockTenantId: 'tenant_1',
      targetProjectId: 'tenant_1:integration-core',
      auditActor: 'user_1',
      apply: false,
    })
    expect(invocation).not.toHaveProperty('tenantId')
    expect(invocation).not.toHaveProperty('actorId')
  })

  test('success and failure stdout projections are values-free closed shapes', () => {
    const secret = 'MAT-001-SECRET'
    const enumShapedSecret = 'MAT_SECRET_123'
    const result = {
      persisted: false,
      mode: 'dry_run' as const,
      repairable: true,
      applied: false,
      created: { lines: 0, run: 0, project: 0 },
      patched: { project: 0 },
      evidence: {
        expectedLineCount: 2,
        existingPrefixLineCount: 1,
        missing: { lines: 1, run: 1, project: 1 },
        staleProjectPointer: false,
        advancedProjectPointerPreserved: false,
        externalWrite: false as const,
        valuesFree: true as const,
      },
      ignoredBusinessValue: secret,
    }
    const success = buildValuesFreeCliSummary('dry_run', result)
    const failure = buildValuesFreeCliFailure('apply', {
      code: 'PERSIST_REPAIR_REFUSED',
      status: 409,
      message: secret,
      details: { planted: secret },
    })
    expect(JSON.stringify(success)).not.toContain(secret)
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(failure).toEqual({
      status: 'FAIL',
      operation: 'stock_preparation_persist_repair_once',
      mode: 'apply',
      code: 'PERSIST_REPAIR_REFUSED',
      failureStatus: 409,
      externalWrite: false,
      valuesFree: true,
    })
    expect(buildValuesFreeCliFailure('apply', { code: enumShapedSecret, status: 409 })).toMatchObject({
      code: 'REPAIR_FAILED',
    })
    expect(buildValuesFreeCliFailure('apply', new Error(enumShapedSecret))).toMatchObject({
      code: 'REPAIR_FAILED',
    })
  })
})
