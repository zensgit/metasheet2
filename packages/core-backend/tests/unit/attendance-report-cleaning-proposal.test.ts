import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  AttendanceMultitableCleaningAuthorityError,
  buildAttendanceCanonicalSourceDigest,
  refreshAttendanceReportProjectionAnchor as refreshAnchor,
  type AttendanceCleaningAuthorityQuery,
  type RefreshAttendanceReportProjectionAnchorInput,
} from '../../src/attendance/attendance-multitable-cleaning-authority'
import { getObjectFieldId } from '../../src/multitable/provisioning'

// These unit cases isolate selector/digest behavior; real lock contention is
// exercised by attendance-report-cleaning-proposal.db.test.ts.
function refreshAttendanceReportProjectionAnchor(query: AttendanceCleaningAuthorityQuery, input: RefreshAttendanceReportProjectionAnchorInput) {
  const fieldId = getObjectFieldId('org-a:attendance', 'attendance_report_records', 'row_key')
  return refreshAnchor(async (statement, params) => {
    if (statement.includes('SELECT registry.sheet_id, registry.project_id')) return { rows: [{ sheet_id: 'sheet-a', project_id: 'org-a:attendance' }] }
    if (statement.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (statement.includes('SELECT id, data FROM meta_records')) return { rows: [{ id: input.projectionRecordId, data: { [fieldId]: 'synthetic-row' } }] }
    if (statement.includes('SELECT id FROM meta_fields')) return { rows: [{ id: fieldId }] }
    return query(statement, params)
  }, input)
}

const require = createRequire(import.meta.url)
const {
  buildAttendanceCleaningProposal,
  buildAttendanceCleaningProposalDigest,
  buildAttendanceCleaningProposalCleanup,
  buildAttendanceCleaningOperationIdentity,
  normalizeAttendanceMultitableCleaningPolicy,
  assertAttendanceCleaningFreshSource,
  createAttendanceCleaningOperationAdapter,
  verifyAttendanceCleaningCompletedRecovery,
  readAttendanceCleaningReviewDescriptor,
} = require('../../../../plugins/plugin-attendance/lib/attendance-report-cleaning-proposal.cjs')

describe('attendance report cleaning proposal', () => {
  it('exposes a review descriptor only for an enabled existing daily projection', async () => {
    let lookups = 0
    const provisioning = {
      findObjectSheet: async (input: unknown) => { lookups++; expect(input).toEqual({ projectId: 'org-a:attendance', objectId: 'attendance_report_records' }); return { id: 'sheet_daily' } },
      getFieldId: (_project: string, _object: string, code: string) => `fld_${code}`,
      isSheetOwnedByProject: async () => true,
    }
    expect(await readAttendanceCleaningReviewDescriptor({ orgId: 'org-a', settings: {}, provisioning })).toEqual({ enabled: false })
    expect(lookups).toBe(0)
    const settings = { attendanceMultitableCleaningPolicy: { enabled: true } }
    const authorize = async () => undefined
    const descriptor = await readAttendanceCleaningReviewDescriptor({ orgId: 'org-a', settings, provisioning, authorize })
    expect(descriptor).toMatchObject({ enabled: true, orgId: 'org-a', sheetId: 'sheet_daily', fieldIds: { cleaning_requested: 'fld_cleaning_requested', cleaning_reason: 'fld_cleaning_reason' } })
    expect(await readAttendanceCleaningReviewDescriptor({ orgId: 'org-a', settings: { ...settings, attendanceResultEditPolicy: { enabled: false } }, provisioning })).toEqual({ enabled: false })
    expect(await readAttendanceCleaningReviewDescriptor({ orgId: 'org-a', settings, authorize, provisioning: { ...provisioning, findObjectSheet: async () => null } })).toEqual({ enabled: false })
    const beforeDenied = lookups
    expect(await readAttendanceCleaningReviewDescriptor({ orgId: 'org-a', settings, provisioning,
      authorize: async () => { throw new Error('DENIED') } })).toEqual({ enabled: false })
    expect(lookups).toBe(beforeDenied)
  })
  it('recovers only the original actor and exact audit proposal on the still-selected calculation', () => {
    const proposal = { requested: true, reason: 'synthetic review', targetStatus: 'normal' }
    const identity = buildAttendanceCleaningOperationIdentity({ orgId: 'org-a', projectionRecordId: 'rec_a', sourceFingerprint: 'a'.repeat(40), proposal })
    const input = { orgId: 'org-a', actorId: 'actor-a', tokenSubjectUserId: 'actor-a', proposal,
      sourceRef: identity.sourceRef, canonicalRecordId: 'canonical-a', anchorCreatedAt: '2026-09-01T00:00:00Z', selectedCalculationId: 'applied-calc' }
    const operation = { org_id: 'org-a', actor_id: 'actor-a', token_subject_user_id: 'actor-a', actor_posture: 'attendance_admin',
      operation_id: identity.operationId, source_ref: identity.sourceRef, entrypoint: 'manual_edit', capability: 'manual_edit', identity_source_kind: 'direct_manual_edit',
      state: 'completed', resolved_record_id: 'canonical-a', resolved_calculation_id: 'applied-calc', created_at: '2026-09-02T00:00:00Z', anchor_epoch_matches: true }
    const audit = { org_id: 'org-a', record_id: 'canonical-a', actor_user_id: 'actor-a', idempotency_key: identity.operationId,
      reason: proposal.reason, evidence: [{ type: 'text', text: identity.reviewedProposalRef }] }
    expect(verifyAttendanceCleaningCompletedRecovery({ input, operation, audit })).toEqual({
      operationId: identity.operationId, proposalDigest: identity.proposalDigest,
      sourceRef: identity.sourceRef, reviewedProposalRef: identity.reviewedProposalRef,
    })
    for (const changed of [
      { ...input, actorId: 'other-admin', tokenSubjectUserId: 'other-admin' },
      { ...input, proposal: { ...proposal, reason: 'later proposal' } },
      { ...input, proposal: { ...proposal, requested: false } },
      { ...input, selectedCalculationId: 'newer-calculation' },
      { ...input, anchorCreatedAt: '2026-09-03T00:00:00Z' },
      { ...input, canonicalRecordId: 'other-canonical' },
    ]) expect(() => verifyAttendanceCleaningCompletedRecovery({ input: changed, operation, audit })).toThrow('ATTENDANCE_CLEANING_CONFLICT')
    expect(() => verifyAttendanceCleaningCompletedRecovery({ input, operation: { ...operation, operation_id: 'forged' }, audit: { ...audit, idempotency_key: 'forged' } })).toThrow('ATTENDANCE_CLEANING_CONFLICT')
    expect(() => verifyAttendanceCleaningCompletedRecovery({ input, operation, audit: { ...audit, evidence: [...audit.evidence, ...audit.evidence] } })).toThrow('ATTENDANCE_CLEANING_CONFLICT')
    expect(() => verifyAttendanceCleaningCompletedRecovery({ input, operation: { ...operation, identity_source_kind: 'direct_recompute' }, audit })).toThrow('ATTENDANCE_CLEANING_CONFLICT')
    expect(() => verifyAttendanceCleaningCompletedRecovery({ input, operation: { ...operation, anchor_epoch_matches: false }, audit })).toThrow('ATTENDANCE_CLEANING_CONFLICT')
  })
  it('prepares only server-derived manual input and refuses a prior source before a second apply', async () => {
    let prior = true
    let manual: Record<string, unknown> | undefined
    let sourceLocks = 0
    const adapter = createAttendanceCleaningOperationAdapter({
      loadSettings: async () => ({ attendanceMultitableCleaningPolicy: { enabled: true },
        attendanceResultEditPolicy: { enabled: true, editWindowDays: 180, notifyAffectedEmployee: true } }),
      authority: { lockSource: async () => { sourceLocks += 1; throw new Error('IDENTITY_MUST_NOT_LOCK_SOURCE') } },
      manualEditAdapter: { prepareIdentity: async (_trx: unknown, input: Record<string, unknown>) => { manual = input; return { commandPayload: input } } },
    })
    const input = { orgId: 'org-a', actorId: 'actor-a', tokenSubjectUserId: 'actor-a', projectionRecordId: 'rec_a',
      seed: { canonicalRecordId: 'canonical-a', sourceCalculationId: 'calc-a', sourceCalculationVersion: 2 },
      proposal: { reason: 'synthetic review' }, identity: { operationId: 'operation-a', reviewedProposalRef: 'bounded-reference', sourceRef: 'source-a' },
      targetStatus: 'absent', overrideMetrics: { workMinutes: 99999 }, notifyAffectedEmployee: true,
    }
    const trx = { query: async () => prior ? [{ operation_id: 'original-operation' }] : [] }
    await expect(adapter.prepareIdentity(trx, input)).rejects.toThrow('ATTENDANCE_CLEANING_CONFLICT')
    expect(sourceLocks).toBe(0)
    prior = false
    expect((await adapter.prepareIdentity(trx, input)).attendanceCleaningReplay).toBe('allow-new')
    expect(manual).toMatchObject({ recordId: 'canonical-a', expectedCalculationId: 'calc-a', expectedCalculationVersion: 2,
      targetStatus: 'normal', overrideMetrics: null, notifyAffectedEmployee: false, reason: 'synthetic review',
      evidence: [{ type: 'text', text: 'bounded-reference' }], idempotencyKey: 'operation-a' })
  })
  it('refuses source, proposal and calculation drift before producing a fresh apply command', () => {
    const proposal = { requested: true, reason: 'synthetic review', targetStatus: 'normal' }
    const identity = buildAttendanceCleaningOperationIdentity({ orgId: 'org-a', projectionRecordId: 'rec_a', sourceFingerprint: 'a'.repeat(40), proposal })
    const valid = {
      orgId: 'org-a', projectionRecordId: 'rec_a', expectedVersion: 3,
      identity, computedFingerprint: 'a'.repeat(40), storedFingerprint: 'a'.repeat(40),
      seed: { canonicalRecordId: 'canonical-a', sourceFingerprint: 'a'.repeat(40), sourceCalculationId: 'calc-a', sourceCalculationVersion: 1 },
      locked: {
        projection: { id: 'rec_a', version: 3, data: { requested: true, reason: 'synthetic review' } },
        fieldIds: { requested: 'requested', reason: 'reason' },
        record: { canonical_record_id: 'canonical-a', org_id: 'org-a', status: 'late' },
        anchor: { canonical_record_id: 'canonical-a', org_id: 'org-a', source_selector: 'current_calculation',
          source_fingerprint: 'a'.repeat(40), canonical_source_digest: 'b'.repeat(64), source_calculation_id: 'calc-a', source_calculation_version: 1 },
        canonicalSourceDigest: 'b'.repeat(64),
        selected: { selector: 'current_calculation', calculation: { id: 'calc-a', version: 1 } },
      },
    }
    expect(assertAttendanceCleaningFreshSource(valid)).toEqual({ proposal, identity })
    const cases = [
      { ...valid, computedFingerprint: 'c'.repeat(40) },
      { ...valid, storedFingerprint: 'c'.repeat(40) },
      { ...valid, expectedVersion: 4 },
      { ...valid, identity: { ...identity, operationId: 'different' } },
      { ...valid, seed: { ...valid.seed, canonicalRecordId: 'other-canonical' } },
      { ...valid, locked: { ...valid.locked, canonicalSourceDigest: 'c'.repeat(64) } },
      { ...valid, locked: { ...valid.locked, selected: { selector: 'current_calculation', calculation: { id: 'calc-a', version: 2 } } } },
      { ...valid, locked: { ...valid.locked, record: { ...valid.locked.record, status: 'normal' } } },
      { ...valid, locked: { ...valid.locked, projection: { ...valid.locked.projection, data: { requested: false, reason: 'synthetic review' } } } },
      { ...valid, locked: { ...valid.locked, projection: { ...valid.locked.projection, data: { requested: true, reason: 'later proposal' } } } },
    ]
    for (const input of cases) expect(() => assertAttendanceCleaningFreshSource(input)).toThrow('ATTENDANCE_CLEANING_CONFLICT')
  })
  it('keeps cleanup source stable across resync while binding fresh operations to proposal content', () => {
    const input = {
      orgId: 'org-a', projectionRecordId: 'rec-a', sourceFingerprint: 'a'.repeat(40),
      proposal: { requested: true, reason: 'verified exception', targetStatus: 'normal' },
    }
    const original = buildAttendanceCleaningOperationIdentity(input)
    const customEdit = buildAttendanceCleaningOperationIdentity({ ...input, projectionVersion: 99, custom: 'ignored' })
    expect(customEdit).toEqual(original)
    expect(original.operationId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    const reprojected = buildAttendanceCleaningOperationIdentity({ ...input, sourceFingerprint: 'b'.repeat(40) })
    expect(reprojected.sourceRef).toBe(original.sourceRef)
    expect(reprojected.operationId).not.toBe(original.operationId)
    expect(reprojected.reviewedProposalRef).not.toBe(original.reviewedProposalRef)
    const newReason = buildAttendanceCleaningOperationIdentity({ ...input, proposal: { ...input.proposal, reason: 'new proposal' } })
    expect(newReason.operationId).not.toBe(original.operationId)
    const otherOrg = buildAttendanceCleaningOperationIdentity({ ...input, orgId: 'org-b' })
    expect(otherOrg.sourceRef).not.toBe(original.sourceRef)
    expect(otherOrg.operationId).not.toBe(original.operationId)
    expect(JSON.stringify(original)).not.toContain('verified exception')
    expect(JSON.stringify(original)).not.toContain('org-a')
  })

  it('enables the ACP gate only for literal true', () => {
    expect(normalizeAttendanceMultitableCleaningPolicy({ enabled: true })).toEqual({ enabled: true })
    expect(normalizeAttendanceMultitableCleaningPolicy({ enabled: 'true' })).toEqual({ enabled: false })
    expect(normalizeAttendanceMultitableCleaningPolicy(undefined)).toEqual({ enabled: false })
  })

  it('accepts only a bounded, trimmed requested proposal with a fixed normal target', () => {
    expect(buildAttendanceCleaningProposal({
      cleaning_requested: true,
      cleaning_reason: '  normalize verified exception  ',
      target_status: 'absent',
    })).toEqual({ requested: true, reason: 'normalize verified exception', targetStatus: 'normal' })
    expect(buildAttendanceCleaningProposal({ cleaning_requested: true, cleaning_reason: '   ' })).toBeNull()
    expect(buildAttendanceCleaningProposal({ cleaning_requested: 'true', cleaning_reason: 'valid' })).toBeNull()
    expect(buildAttendanceCleaningProposal({ cleaning_requested: true, cleaning_reason: 'x'.repeat(501) })).toBeNull()
  })

  it('uses only proposal identity inputs in the digest and cleanup changes', () => {
    const proposal = { requested: true, reason: 'normalize verified exception', targetStatus: 'normal' }
    const input = {
      orgId: 'org-a',
      projectionRecordId: 'rec-a',
      sourceFingerprint: 'a'.repeat(40),
      proposal,
    }
    expect(buildAttendanceCleaningProposalDigest(input)).toBe(
      buildAttendanceCleaningProposalDigest({ ...input, projectionVersion: 99, customField: 'ignored' }),
    )
    expect(buildAttendanceCleaningProposalDigest({ ...input, sourceFingerprint: 'b'.repeat(40) }))
      .not.toBe(buildAttendanceCleaningProposalDigest(input))
    expect(buildAttendanceCleaningProposalCleanup()).toEqual({
      cleaning_requested: false,
      cleaning_reason: null,
    })
  })

  it('derives the anchor digest from closed canonical facts, not a projection timestamp', () => {
    const facts = {
      projection_record_id: 'rec_anchor',
      canonical_record_id: '00000000-0000-4000-8000-000000000001',
      org_id: 'org-a',
      user_id: 'user-a',
      work_date: '2026-09-07',
      timezone: 'UTC',
      first_in_at: '2026-09-07T09:00:00.000Z',
      last_out_at: '2026-09-07T18:00:00.000Z',
      work_minutes: 480,
      late_minutes: 0,
      early_leave_minutes: 0,
      status: 'late',
      is_workday: true,
      projection_owner: 'w4',
      current_calculation_id: '00000000-0000-4000-8000-000000000002',
      visibility_state: 'active',
      visibility_reason: 'active',
    }
    expect(buildAttendanceCanonicalSourceDigest({ ...facts, updated_at: 'ignored' } as never))
      .toBe(buildAttendanceCanonicalSourceDigest({ ...facts, updated_at: 'also-ignored' } as never))
    expect(buildAttendanceCanonicalSourceDigest({ ...facts, status: 'absent' } as never))
      .not.toBe(buildAttendanceCanonicalSourceDigest(facts))
    expect(() => buildAttendanceCanonicalSourceDigest({ ...facts, status: '' } as never))
      .toThrow(AttendanceMultitableCleaningAuthorityError)
  })

  it('refreshes only a DB-selected authoritative calculation and revokes a true legacy binding', async () => {
    const baseRow = {
      projection_record_id: 'rec_anchor', canonical_record_id: '00000000-0000-4000-8000-000000000001',
      org_id: 'org-a', user_id: 'user-a', work_date: '2026-09-07', timezone: 'UTC',
      first_in_at: null, last_out_at: null, work_minutes: 0, late_minutes: 0, early_leave_minutes: 0,
      status: 'late', is_workday: true, projection_owner: 'w4',
      current_calculation_id: '00000000-0000-4000-8000-000000000002', visibility_state: 'active', visibility_reason: 'active',
    }
    const statements: string[] = []
    await refreshAttendanceReportProjectionAnchor(async (statement) => {
      statements.push(statement)
      if (statement.includes('FROM meta_records projection')) return { rows: [baseRow] }
      if (statement.includes("WHERE id = $1")) return { rows: [{ id: baseRow.current_calculation_id, version: 2, mode: 'authoritative', outcome: 'completed' }] }
      if (statement.includes('FROM attendance_report_projection_anchors')) return { rows: [] }
      if (statement.includes('INSERT INTO attendance_report_projection_anchors')) return { rows: [{ projection_record_id: baseRow.projection_record_id }] }
      throw new Error('unexpected query')
    }, {
      projectionRecordId: baseRow.projection_record_id,
      canonicalRecordId: baseRow.canonical_record_id,
      sourceFingerprint: 'a'.repeat(40),
    })
    expect(statements.some(statement => statement.includes('INSERT INTO attendance_report_projection_anchors'))).toBe(true)

    const groupStatements: string[] = []
    await refreshAttendanceReportProjectionAnchor(async (statement) => {
      groupStatements.push(statement)
      if (statement.includes('FROM meta_records projection')) return { rows: [{ ...baseRow, projection_owner: 'w4_group' }] }
      if (statement.includes('WHERE id = $1')) return { rows: [{ id: baseRow.current_calculation_id, version: 2, mode: 'authoritative', outcome: 'completed' }] }
      if (statement.includes('FROM attendance_report_projection_anchors')) return { rows: [] }
      if (statement.includes('INSERT INTO attendance_report_projection_anchors')) return { rows: [{ projection_record_id: baseRow.projection_record_id }] }
      throw new Error('unexpected query')
    }, { projectionRecordId: baseRow.projection_record_id, canonicalRecordId: baseRow.canonical_record_id, sourceFingerprint: 'a'.repeat(40) })
    expect(groupStatements.some(statement => statement.includes('ORDER BY version DESC'))).toBe(false)

    const invalidCurrentStatements: string[] = []
    await expect(refreshAttendanceReportProjectionAnchor(async (statement) => {
      invalidCurrentStatements.push(statement)
      if (statement.includes('FROM meta_records projection')) return { rows: [baseRow] }
      if (statement.includes('WHERE id = $1')) return { rows: [] }
      throw new Error('unexpected query')
    }, { projectionRecordId: baseRow.projection_record_id, canonicalRecordId: baseRow.canonical_record_id, sourceFingerprint: 'a'.repeat(40) }))
      .rejects.toThrow(AttendanceMultitableCleaningAuthorityError)
    expect(invalidCurrentStatements.some(statement => statement.includes('ORDER BY version DESC'))).toBe(false)

    const legacyStatements: string[] = []
    await refreshAttendanceReportProjectionAnchor(async (statement) => {
      legacyStatements.push(statement)
      if (statement.includes('SELECT projection.id AS projection_record_id, registry.project_id')) return { rows: [{ projection_record_id: baseRow.projection_record_id, project_id: 'org-a:attendance' }] }
      if (statement.includes('FROM meta_records projection')) return { rows: [{ ...baseRow, projection_owner: 'legacy_untracked', current_calculation_id: null }] }
      if (statement.includes("outcome = 'completed'")) return { rows: [] }
      if (statement.includes('DELETE FROM attendance_report_projection_anchors')) return { rows: [] }
      throw new Error('unexpected query')
    }, {
      projectionRecordId: baseRow.projection_record_id,
      canonicalRecordId: baseRow.canonical_record_id,
      sourceFingerprint: 'a'.repeat(40),
    })
    expect(legacyStatements.some(statement => statement.includes('DELETE FROM attendance_report_projection_anchors'))).toBe(true)

    const rebindStatements: string[] = []
    await expect(refreshAttendanceReportProjectionAnchor(async (statement) => {
      rebindStatements.push(statement)
      if (statement.includes('FROM meta_records projection')) return { rows: [baseRow] }
      if (statement.includes("WHERE id = $1")) return { rows: [{ id: baseRow.current_calculation_id, version: 2, mode: 'authoritative', outcome: 'completed' }] }
      if (statement.includes('FROM attendance_report_projection_anchors')) return { rows: [{ canonical_record_id: '00000000-0000-4000-8000-000000000099' }] }
      throw new Error('unexpected query')
    }, {
      projectionRecordId: baseRow.projection_record_id,
      canonicalRecordId: baseRow.canonical_record_id,
      sourceFingerprint: 'a'.repeat(40),
    })).rejects.toThrow(AttendanceMultitableCleaningAuthorityError)
    expect(rebindStatements.some(statement => statement.includes('INSERT INTO attendance_report_projection_anchors'))).toBe(false)
  })
})
