import { describe, expect, it } from 'vitest'
import {
  assertParentNotOperatorRetiredV1,
  assertParentNotRetiredForOrdinaryWriterV1,
  assertToolingOnlyNonW4FixtureTeardownAllowedV1,
  buildLegacyRetirementBaselineProvenanceV1,
  buildOperatorRetirementCleanupPlanSqlV1,
  computeOpsRetirementPayloadFingerprintV1,
  ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES,
} from '../w4c3c-ops-retirement'
import {
  assertRecordOperationCapabilityMatchV1,
  recordOperationCapabilityForKindV1,
} from '../w4c3c-record-operation-boundary'
import {
  parseAttendanceRecomputePolicyV1,
  recomputeOperationIdentityLabelV1,
  ATTENDANCE_RECOMPUTE_ERROR_CODES,
} from '../w4c3c-recompute'

describe('W4C-3c ops retirement + recompute identity', () => {
  it('blocks ordinary writers on operator-retired parents with required code', () => {
    expect(() =>
      assertParentNotOperatorRetiredV1({
        visibility_state: 'retired',
        visibility_reason: 'operator_retirement',
      }),
    ).toThrowError(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.OPERATOR_RETIRED)
    // Narrow helper only targets operator_retirement.
    expect(() =>
      assertParentNotOperatorRetiredV1({
        visibility_state: 'retired',
        visibility_reason: 'import_rollback',
      }),
    ).not.toThrow()
  })

  it('ordinary writer retired guard: operator_retirement code + any other retired reason', () => {
    expect(() =>
      assertParentNotRetiredForOrdinaryWriterV1({
        visibility_state: 'retired',
        visibility_reason: 'operator_retirement',
      }),
    ).toThrowError(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.OPERATOR_RETIRED)
    expect(() =>
      assertParentNotRetiredForOrdinaryWriterV1({
        visibility_state: 'retired',
        visibility_reason: 'import_rollback',
      }),
    ).toThrowError(/ATTENDANCE_RECORD_RETIRED/)
    expect(() =>
      assertParentNotRetiredForOrdinaryWriterV1({
        visibility_state: 'active',
        visibility_reason: 'active',
      }),
    ).not.toThrow()
  })

  it('requires the closed tooling-only non-W4 fixture teardown guard', () => {
    expect(() =>
      assertToolingOnlyNonW4FixtureTeardownAllowedV1({
        purpose: 'tooling_only_non_w4_fixture_teardown',
        orgId: 'org',
        recordIds: [],
        w4ImmutableRowCount: 0,
        explicitGuardToken: 'ATTENDANCE_TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN',
      }),
    ).not.toThrow()
    expect(() =>
      assertToolingOnlyNonW4FixtureTeardownAllowedV1({
        purpose: 'tooling_only_non_w4_fixture_teardown',
        orgId: 'org',
        recordIds: ['x'],
        w4ImmutableRowCount: 1,
        explicitGuardToken: 'ATTENDANCE_TOOLING_ONLY_NON_W4_FIXTURE_TEARDOWN',
      }),
    ).toThrowError(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.TOOLING_TEARDOWN_FORBIDDEN)
    expect(() =>
      assertToolingOnlyNonW4FixtureTeardownAllowedV1({
        purpose: 'tooling_only_non_w4_fixture_teardown',
        orgId: 'org',
        recordIds: [],
        w4ImmutableRowCount: 0,
        explicitGuardToken: 'WRONG',
      } as never),
    ).toThrowError(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.TOOLING_TEARDOWN_FORBIDDEN)
  })

  it('cleanup plan SQL never deletes attendance_records and names ops_retirement', () => {
    const sql = buildOperatorRetirementCleanupPlanSqlV1({
      orgId: 'org-a',
      sourceTag: 'dingtalk_csv_test',
    })
    expect(sql).toMatch(/ops_retirement/)
    expect(sql).toMatch(/operationId/)
    // Structural: strip SQL line comments, then forbid live DELETE.
    const withoutComments = sql
      .split(/\r?\n/)
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n')
    expect(withoutComments).not.toMatch(/\bDELETE\s+FROM\s+attendance_records\b/i)
  })

  it('legacy baseline provenance marks first/last as non-evidence', () => {
    const marker = buildLegacyRetirementBaselineProvenanceV1({
      ticket: 'T-1',
      reason: 'cleanup',
      operationId: '11111111-1111-4111-8111-111111111111',
      recordId: '22222222-2222-4222-8222-222222222222',
    })
    expect(marker.treatsFirstLastAsPunchEvidence).toBe(false)
    expect(marker.provenanceQuality).toBe('legacy_projection_only_no_punch_evidence')
    // Discriminating mutation: fabricating punch evidence would set this true.
    expect(marker.treatsFirstLastAsPunchEvidence).not.toBe(true)
  })

  it('ops retirement payload fingerprint is command-stable and record-bound', () => {
    const base = {
      recordId: '11111111-1111-4111-8111-111111111111',
      expectedCalculationId: null,
      expectedCalculationVersion: null,
      reason: 'staging cleanup',
      ticket: 'TICKET-1',
    }
    expect(computeOpsRetirementPayloadFingerprintV1(base)).toBe(
      computeOpsRetirementPayloadFingerprintV1(base),
    )
    expect(
      computeOpsRetirementPayloadFingerprintV1({ ...base, ticket: 'TICKET-2' }),
    ).not.toBe(computeOpsRetirementPayloadFingerprintV1(base))
  })

  it('distinguishes prior-policy and current-policy recompute identities', () => {
    expect(parseAttendanceRecomputePolicyV1('frozen_prior')).toBe('frozen_prior')
    expect(parseAttendanceRecomputePolicyV1('current_policy')).toBe('current_policy')
    expect(recomputeOperationIdentityLabelV1('frozen_prior')).toBe('recompute:frozen_prior')
    expect(recomputeOperationIdentityLabelV1('current_policy')).toBe('recompute:current_policy')
    expect(recomputeOperationIdentityLabelV1('frozen_prior')).not.toBe(
      recomputeOperationIdentityLabelV1('current_policy'),
    )
  })

  it('exposes current-policy incomplete + operationId-required codes for mutation tests', () => {
    expect(ATTENDANCE_RECOMPUTE_ERROR_CODES.CURRENT_POLICY_INCOMPLETE).toBe(
      'W4C3C_RECOMPUTE_CURRENT_POLICY_INCOMPLETE',
    )
    expect(ATTENDANCE_RECOMPUTE_ERROR_CODES.OPERATION_ID_REQUIRED).toBe(
      'W4C3C_RECOMPUTE_OPERATION_ID_REQUIRED',
    )
    expect(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.OPERATION_ID_REQUIRED).toBe(
      'W4C3C_OPS_RETIREMENT_OPERATION_ID_REQUIRED',
    )
  })

  it('kills entrypoint/capability mismatch', () => {
    expect(recordOperationCapabilityForKindV1('manual_edit')).toBe('manual_edit')
    expect(recordOperationCapabilityForKindV1('recompute')).toBe('recompute')
    expect(recordOperationCapabilityForKindV1('ops_retirement')).toBe('retirement')
    expect(() => assertRecordOperationCapabilityMatchV1('manual_edit', 'punch')).toThrowError(
      /ATTENDANCE_ENTRYPOINT_CAPABILITY_MISMATCH/,
    )
    expect(() => assertRecordOperationCapabilityMatchV1('ops_retirement', 'retirement')).not.toThrow()
  })
})
