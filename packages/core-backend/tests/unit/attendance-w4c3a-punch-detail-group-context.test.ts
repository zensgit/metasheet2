import { describe, expect, it, vi } from 'vitest'
import { claimAttendanceCanonicalImportRegistryV1 } from '../../src/attendance/w4c3a-canonical-import-kernel'
import { buildAttendancePunchDetailPreparedPlanV1 } from '../../src/attendance/w4c3a-punch-detail-prepare'
import { buildAttendancePunchDetailPreviewRecordV1, verifyAttendancePunchDetailPreviewRecordV1 } from '../../src/attendance/w4c3a-punch-detail-preview-record'
import { isSupportedFrozenAttendanceContextV1 } from '../../src/attendance/w4c1-segment-calculator'
import type { AttendanceLegacyPlanWorkerJobV1, VerifiedAttendanceLegacyPlanV1 } from '../../src/attendance/w4c3a-legacy-plan-worker'
import type { FrozenAttendanceContextV2 } from '../../src/attendance/w7-resolver/w7-group-effective-context-issuance'
import { punchDetailPreparationFixture } from '../../src/attendance/__tests__/helpers/punch-detail-plan-fixture'

function groupContext(): FrozenAttendanceContextV2 {
  return { ...punchDetailPreparationFixture().context, schemaVersion: 2,
    selector: 'group_effective', calculationGroupId: 'punch-detail-calculation-group' }
}

async function claimWithFrozenContext(context: unknown) {
  // The durable plan has already passed its digest gate. This focused probe stops at the
  // subsequent identity gate, before any registry SQL; it does not claim full worker execution.
  const input = punchDetailPreparationFixture()
  const prepared = buildAttendancePunchDetailPreparedPlanV1(input).plan
  const plan = JSON.parse(JSON.stringify({ manifest: { batch: prepared.batch,
    legacyInputFingerprint: prepared.legacyInputFingerprint }, items: prepared.items,
  recordWrites: prepared.recordWrites, groupEffects: [] })) as VerifiedAttendanceLegacyPlanV1
  const snapshot = plan.recordWrites[0].attributionSnapshot as { sources: Array<{ context: unknown }> }
  snapshot.sources.forEach(source => { source.context = context })
  const job = { ...input.scope, batchId: input.batchId, itemCount: 4,
    legacyInputFingerprint: prepared.legacyInputFingerprint,
    acceptedWritePosture: 'authoritative', operationalBranch: 'strict_targeted' } as AttendanceLegacyPlanWorkerJobV1
  const query = vi.fn(async () => { throw new Error('UNEXPECTED_REGISTRY_SQL') })
  const promise = claimAttendanceCanonicalImportRegistryV1({ query }, { job, plan, identities: [] })
  return { promise, query }
}

describe('punch-detail supported frozen-context routing', () => {
  it('prepares a group-effective context without dropping group identity or physical events', () => {
    const input = punchDetailPreparationFixture()
    const context = groupContext()
    expect(isSupportedFrozenAttendanceContextV1(context)).toBe(true)
    const { plan, calculation } = buildAttendancePunchDetailPreparedPlanV1({ ...input, context })
    expect(calculation.outcome).toBe('completed')
    expect(calculation.dailyProjection?.workedMinutes).toBe(165)
    expect(plan.items.flatMap(item => item.rawEvidence.punches)).toEqual(input.envelope.__punchDetailInput.punches)
    expect(plan.recordWrites[0].attributionSnapshot.sources.map(source => source.context))
      .toEqual([context, context, context, context])
  })

  it('reconstructs a frozen group preview through the same supported context domain', () => {
    const input = punchDetailPreparationFixture()
    const context = groupContext()
    const jobId = '94cd2fb4-320f-4cbc-b806-4d04f97ff576'
    const built = buildAttendancePunchDetailPreviewRecordV1({ jobId, preparation: { ...input, context }, previewLimit: 4 })
    const read = verifyAttendancePunchDetailPreviewRecordV1(JSON.parse(JSON.stringify(built.record)), {
      jobId, batchId: input.batchId, scope: input.scope,
      requestFingerprint: built.record.requestFingerprint, snapshotDigest: built.snapshotDigest,
    })
    expect(read).toEqual(built.record)
    expect(read.frozenTarget.context).toEqual(context)
    expect(read.preview.targets[0].dailyProjection?.workedMinutes).toBe(165)
  })

  it('accepts the persisted group context before the unchanged registry identity gate', async () => {
    const { promise, query } = await claimWithFrozenContext(groupContext())
    await expect(promise).rejects.toThrow('W4C3A_PROCESSOR_IDENTITY_PROOF_INVALID')
    expect(query).not.toHaveBeenCalled()
  })

  it('preserves the optional V1 strict flex-policy field in preparation and persisted validation', async () => {
    const input = punchDetailPreparationFixture()
    const context = { ...input.context, flexPolicy: { mode: 'strict' as const } }
    const { plan, calculation } = buildAttendancePunchDetailPreparedPlanV1({ ...input, context })
    expect(calculation.dailyProjection?.workedMinutes).toBe(165)
    expect(plan.recordWrites[0].attributionSnapshot.sources[0].context).toEqual(context)
    const { promise, query } = await claimWithFrozenContext(context)
    await expect(promise).rejects.toThrow('W4C3A_PROCESSOR_IDENTITY_PROOF_INVALID')
    expect(query).not.toHaveBeenCalled()
  })

  it.each(['missing_group', 'legacy_with_group', 'v1_with_group', 'unknown_selector', 'unknown_schema', 'extra_key', 'v2_flex'] as const)(
    'refuses invalid context %s in both preparation and persisted validation', async (kind) => {
      const input = punchDetailPreparationFixture()
      const context = groupContext()
      if (kind === 'missing_group') Object.assign(context, { calculationGroupId: null })
      if (kind === 'legacy_with_group') Object.assign(context, { selector: 'legacy' })
      if (kind === 'v1_with_group') Object.assign(context, { schemaVersion: 1 })
      if (kind === 'unknown_selector') Object.assign(context, { selector: 'unknown' })
      if (kind === 'unknown_schema') Object.assign(context, { schemaVersion: 3 })
      if (kind === 'extra_key') Object.assign(context, { extra: true })
      if (kind === 'v2_flex') Object.assign(context, { flexPolicy: { mode: 'strict' } })
      expect(isSupportedFrozenAttendanceContextV1(context)).toBe(false)
      expect(() => buildAttendancePunchDetailPreparedPlanV1({ ...input, context }))
        .toThrow('ATTENDANCE_PUNCH_DETAIL_FROZEN_TARGET_MISMATCH')
      const { promise, query } = await claimWithFrozenContext(context)
      await expect(promise).rejects.toThrow('W4C3A_IMPORT_FREEZE_INVALID')
      expect(query).not.toHaveBeenCalled()
    })
})
