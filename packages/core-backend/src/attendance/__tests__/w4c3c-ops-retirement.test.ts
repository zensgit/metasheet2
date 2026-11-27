import crypto from 'node:crypto'
import { canonicalAttendanceJsonV1 } from '../w4c0-fingerprints'
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'
import { appendOperatorRetirementCalculationV1 } from '../w4c3c-ops-retirement'
import { describe, expect, it } from 'vitest'
import {
  assertParentNotOperatorRetiredV1,
  assertParentNotRetiredForAuthoritativePunchV1,
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

  // Gate D2 (#4556 / #4844) — the AUTHORITATIVE live-punch retirement guard.
  //
  // ANTI-ENUMERATION PIN. This guard's whole point is that it is DEFAULT-REFUSE with one named
  // carve-out, not an enumerate-the-known-reasons-with-implicit-proceed structure. The synthetic
  // reason leg below cannot be driven through a real DB insert — `chk_ar_visibility_reason` blocks
  // an out-of-domain value at the row level — so it is exercised at the FUNCTION seam, which is
  // exactly what proves the guard is not merely parasitic on that CHECK.
  describe('Gate D2 authoritative-punch retirement guard (default refuse, one carve-out)', () => {
    it('proceeds for a non-retired parent', () => {
      expect(() =>
        assertParentNotRetiredForAuthoritativePunchV1({
          visibility_state: 'active',
          visibility_reason: 'active',
        }),
      ).not.toThrow()
    })

    it('CARVE-OUT: proceeds for retired/review_placeholder (the F6 create-if-absent steady state)', () => {
      // The one reason that MUST pass: a completed outcome promotes this parent via the core's
      // own pointer UPDATE, and a review outcome preserves it. Refusing here would break F6.
      expect(() =>
        assertParentNotRetiredForAuthoritativePunchV1({
          visibility_state: 'retired',
          visibility_reason: 'review_placeholder',
        }),
      ).not.toThrow()
    })

    it('TERMINAL, distinctly coded: operator_retirement refuses with ATTENDANCE_RECORD_OPERATOR_RETIRED, not the generic code', () => {
      expect(() =>
        assertParentNotRetiredForAuthoritativePunchV1({
          visibility_state: 'retired',
          visibility_reason: 'operator_retirement',
        }),
      ).toThrowError(ATTENDANCE_OPERATOR_RETIREMENT_ERROR_CODES.OPERATOR_RETIRED)
    })

    it('DEFAULT REFUSE: import_rollback refuses with ATTENDANCE_RECORD_RETIRED', () => {
      expect(() =>
        assertParentNotRetiredForAuthoritativePunchV1({
          visibility_state: 'retired',
          visibility_reason: 'import_rollback',
        }),
      ).toThrowError(/ATTENDANCE_RECORD_RETIRED/)
    })

    it('[anti-enumeration pin] DEFAULT REFUSE: a SYNTHETIC / unlisted retired reason refuses with ATTENDANCE_RECORD_RETIRED rather than falling through to the core reactivation', () => {
      // A reason outside {review_placeholder, import_rollback, operator_retirement} — i.e. any
      // reason a future migration adds. Falling through here would reach the core, whose
      // completed-path pointer UPDATE reactivates the parent to w4/active/active UNCONDITIONALLY.
      for (const reason of ['some_future_reason', 'gdpr_erasure', '', 'ACTIVE']) {
        expect(() =>
          assertParentNotRetiredForAuthoritativePunchV1({
            visibility_state: 'retired',
            visibility_reason: reason,
          }),
        ).toThrowError(/ATTENDANCE_RECORD_RETIRED/)
      }
    })

    it('reads both the snake_case row shape and the camelCase boundary shape', () => {
      expect(() =>
        assertParentNotRetiredForAuthoritativePunchV1({
          visibilityState: 'retired',
          visibilityReason: 'import_rollback',
        }),
      ).toThrowError(/ATTENDANCE_RECORD_RETIRED/)
      expect(() =>
        assertParentNotRetiredForAuthoritativePunchV1({
          visibilityState: 'retired',
          visibilityReason: 'review_placeholder',
        }),
      ).not.toThrow()
    })
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


describe('ops retirement timestamp precision regression', () => {
  const timestampCases = [
    {
      name: 'driver Date milliseconds',
      first: new Date('2026-10-20T01:02:03.123Z'),
      last: new Date('2026-10-20T09:04:05.987Z'),
      expectedFirst: '2026-10-20T01:02:03.123Z',
      expectedLast: '2026-10-20T09:04:05.987Z',
    },
    {
      name: 'equivalent ISO milliseconds',
      first: '2026-10-20T01:02:03.123Z',
      last: '2026-10-20T09:04:05.987Z',
      expectedFirst: '2026-10-20T01:02:03.123Z',
      expectedLast: '2026-10-20T09:04:05.987Z',
    },
    {
      name: 'whole-second Date control',
      first: new Date('2026-10-20T01:02:03.000Z'),
      last: new Date('2026-10-20T09:04:05.000Z'),
      expectedFirst: '2026-10-20T01:02:03.000Z',
      expectedLast: '2026-10-20T09:04:05.000Z',
    },
    {
      name: 'null control',
      first: null,
      last: null,
      expectedFirst: null,
      expectedLast: null,
    },
  ]

  for (const owner of ['w4', 'legacy_untracked'] as const) {
    it.each(timestampCases)(`${owner}: preserves $name in append SQL and baseline preimage`, async ({
      first, last, expectedFirst, expectedLast,
    }) => {
      const recordId = '22222222-2222-4222-8222-222222222222'
      const priorId = owner === 'w4' ? '33333333-3333-4333-8333-333333333333' : null
      const parent = {
        id: recordId, org_id: 'org-precision', user_id: 'user-precision',
        work_date: '2026-10-20', current_calculation_id: priorId,
        projection_owner: owner, visibility_state: 'active', visibility_reason: 'active',
        status: 'normal', first_in_at: first, last_out_at: last,
        work_minutes: 480, late_minutes: 0, early_leave_minutes: 0,
        timezone: 'UTC', is_workday: true, meta: null,
      }
      const parentBefore = JSON.stringify(parent)
      const calls: Array<{ sql: string; params: unknown[] }> = []
      const client: AttendanceW4TransactionClientV1 = {
        async query(sql, params = []) {
          calls.push({ sql, params: [...params] })
          if (/FROM attendance_records/.test(sql)) return { rows: [parent] }
          if (/SELECT id::text AS id, version/.test(sql)) {
            return { rows: [{
              id: priorId, version: 1,
              attribution_snapshot: {
                posture: 'unsupported', sourceSchemaVersion: null,
                reason: 'missing', sourceFingerprint: null,
              },
              context_snapshot: { schemaVersion: 1, kind: 'legacy_projection_baseline' },
              evidence_snapshot: [], approved_facts_snapshot: [], manual_override_snapshot: null,
              semantic_input_fingerprint: '0'.repeat(64),
              provenance_fingerprint: '0'.repeat(64),
              source_definition_fingerprint: '0'.repeat(64),
            }] }
          }
          if (/SELECT id::text AS id/.test(sql)) return { rows: [] }
          if (/INSERT INTO attendance_record_calculations/.test(sql)) return { rows: [] }
          if (/UPDATE attendance_records/.test(sql)) return { rows: [{ id: recordId }] }
          throw new Error('Unexpected retirement SQL')
        },
      }
      const result = await appendOperatorRetirementCalculationV1({
        client, orgId: 'org-precision', recordId,
        expectedCalculationId: priorId, expectedCalculationVersion: priorId ? 1 : null,
        operationId: '11111111-1111-4111-8111-111111111111',
        actorId: 'actor-precision', correlationId: 'correlation-precision',
        reason: 'precision regression', ticket: 'PRECISION-1', mode: 'authoritative',
      })
      expect(result).toEqual({
        kind: 'appended', calculationId: expect.any(String), priorCalculationId: priorId,
        baselineCalculationId: priorId ? null : expect.any(String),
        visibilityReason: 'operator_retirement',
      })
      const projection = {
        status: 'normal', firstInAt: expectedFirst, lastOutAt: expectedLast,
        workMinutes: 480, lateMinutes: 0, earlyLeaveMinutes: 0,
      }
      const fingerprint = crypto.createHash('sha256')
        .update(canonicalAttendanceJsonV1(projection), 'utf8').digest('hex')
      const inserts = calls.filter(({ sql }) => /INSERT INTO attendance_record_calculations/.test(sql))
      expect(inserts).toHaveLength(priorId ? 1 : 2)
      const reversal = inserts[inserts.length - 1]
      expect(reversal.sql).toContain("'reversal'")
      // $19/$20 are projected first/last; $24 seals the unchanged daily projection.
      expect(reversal.params.slice(17, 24)).toEqual([
        'normal', expectedFirst, expectedLast, 480, 0, 0, fingerprint,
      ])
      if (!priorId) {
        const baseline = inserts[0]
        expect(baseline.sql).toContain("'legacy_baseline'")
        // $11/$12 preserve precision in the restore witness, independently of reversal.
        expect(baseline.params.slice(9, 16)).toEqual([
          'normal', expectedFirst, expectedLast, 480, 0, 0, fingerprint,
        ])
        expect(baseline.params[5]).toBe(fingerprint)
        expect(baseline.params[16]).toBe(canonicalAttendanceJsonV1({
          posture: 'present', projection, projectionOwner: owner,
          currentCalculationId: null, visibilityState: 'active', visibilityReason: 'active',
          compatibilityFingerprint: fingerprint,
        }))
        expect(JSON.parse(String(baseline.params[8])).treatsFirstLastAsPunchEvidence).toBe(false)
      }
      const updates = calls.filter(({ sql }) => /UPDATE attendance_records/.test(sql))
      expect(updates).toHaveLength(1)
      expect(updates[0].params).toEqual([
        recordId, 'org-precision', result.calculationId, priorId,
      ])
      expect(updates[0].sql).not.toMatch(/\b(?:first_in_at|last_out_at)\s*=/)
      expect(JSON.stringify(parent)).toBe(parentBefore)
    })
  }
})
