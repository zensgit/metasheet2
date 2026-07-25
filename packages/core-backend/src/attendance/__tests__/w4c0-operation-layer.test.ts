/**
 * W4C-0 (#4556) Stage C unit legs — contract constants, canonical fingerprints
 * (lock 4.3), closed evidence/fact comparators (lock 4.2), branded authorization
 * witness (lock 4.1), and strict source-command validators (lock 4.1 variant
 * matrix). Real-DB claim/seal/replay/congruence legs live in
 * tests/integration/attendance-w4c0-operation-registry.db.test.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_W4_OPERATION_ERROR_HTTP_STATUS_V1,
  AttendanceW4OperationError,
  W4_ADVISORY_HELPER_WAIT_MS,
  W4_MAX_BATCH_ITEMS,
  W4_MAX_DISTINCT_TARGETS,
  W4_TRANSACTION_LOCK_TIMEOUT_MS,
  W4_TRANSACTION_MAX_RETRIES,
  W4_TRANSACTION_STATEMENT_TIMEOUT_MS,
} from '../w4c0-operation-contract'
import {
  canonicalAttendanceJsonV1,
  compareAttendanceEvidenceV1,
  computeAttendanceBusinessKeyFingerprintV1,
  computeAttendanceCommandFingerprintV1,
  computeAttendanceItemSequenceFingerprintV1,
  computeAttendanceItemSetFingerprintV1,
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
  sortApprovedAttendanceFactsV1,
  sortAttendanceEvidenceV1,
  AttendanceW4FingerprintError,
} from '../w4c0-fingerprints'
import {
  ATTENDANCE_ENTRYPOINT_CAPABILITY_MATRIX_V1,
  createAuthorizedAttendanceWriteContextV1,
  requireAuthorizedCapabilityForEntrypointV1,
  verifyAuthorizedAttendanceWriteContextV1,
  AttendanceW4AuthorizationError,
} from '../w4c0-authorization'
import {
  normalizeAttendanceSourceOperationEnvelopeV1,
  AttendanceW4CommandError,
} from '../w4c0-source-commands'
import { ATTENDANCE_SOURCE_ENTRYPOINTS_V1 } from '../w4c0-identity'

const HEX64_A = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)
const UUID_1 = '11111111-1111-4111-8111-111111111111'
const UUID_2 = '22222222-2222-4222-8222-222222222222'
const ORG = '55555555-5555-4555-8555-555555555555'

describe('W4C-0 Stage C — exported operation contract', () => {
  it('pins the exact section 7.1 constants', () => {
    expect(W4_MAX_BATCH_ITEMS).toBe(5000)
    expect(W4_MAX_DISTINCT_TARGETS).toBe(5000)
    expect(W4_TRANSACTION_STATEMENT_TIMEOUT_MS).toBe(180000)
    expect(W4_TRANSACTION_LOCK_TIMEOUT_MS).toBe(5000)
    expect(W4_ADVISORY_HELPER_WAIT_MS).toBe(5000)
    expect(W4_TRANSACTION_MAX_RETRIES).toBe(2)
  })

  it('pins the closed code -> HTTP mapping and values-free error shape', () => {
    expect(ATTENDANCE_W4_OPERATION_ERROR_HTTP_STATUS_V1).toEqual({
      ATTENDANCE_OPERATION_CONFLICT: 409,
      ATTENDANCE_OPERATION_BATCH_CONFLICT: 409,
      ATTENDANCE_OPERATION_IN_PROGRESS: 409,
      ATTENDANCE_CALCULATION_ROLLOUT_BUSY: 503,
      ATTENDANCE_CALCULATION_TARGET_BUSY: 503,
      SEGMENT_CALCULATION_SUSPENDED: 503,
      ATTENDANCE_ASYNC_JOB_POSTURE_CONFLICT: 409,
      W4_BATCH_LIMIT_EXCEEDED: 422,
      ATTENDANCE_WRITE_NOT_AUTHORIZED: 403,
      W4_ATTRIBUTION_UNSUPPORTED: 422,
    })
    const error = new AttendanceW4OperationError('ATTENDANCE_OPERATION_IN_PROGRESS', 'operation')
    expect(error.message).toBe('ATTENDANCE_OPERATION_IN_PROGRESS') // message IS the code
    expect(error.httpStatus).toBe(409)
    expect(error.lockClass).toBe('operation')
  })
})

describe('W4C-0 Stage C — canonical JSON + fingerprint domains', () => {
  it('is key-order insensitive and rejects undefined/NaN/class instances/symbol keys', () => {
    expect(canonicalAttendanceJsonV1({ b: 1, a: [true, null, 'x'] })).toBe(
      canonicalAttendanceJsonV1({ a: [true, null, 'x'], b: 1 }),
    )
    expect(() => canonicalAttendanceJsonV1({ a: undefined })).toThrow(AttendanceW4FingerprintError)
    expect(() => canonicalAttendanceJsonV1({ a: Number.NaN })).toThrow(AttendanceW4FingerprintError)
    expect(() => canonicalAttendanceJsonV1(new Date())).toThrow(AttendanceW4FingerprintError)
    const smuggle: Record<PropertyKey, unknown> = { a: 1 }
    smuggle[Symbol('x')] = 2
    expect(() => canonicalAttendanceJsonV1(smuggle)).toThrow(AttendanceW4FingerprintError)
  })

  it('separates fingerprint domains: identical bytes hash differently per domain', () => {
    const value = { k: 'v' }
    const command = computeAttendanceCommandFingerprintV1(value)
    const businessKey = computeAttendanceBusinessKeyFingerprintV1(value)
    expect(command).toMatch(/^[0-9a-f]{64}$/)
    expect(businessKey).toMatch(/^[0-9a-f]{64}$/)
    expect(command).not.toBe(businessKey)
  })

  it('sequence fingerprint is order-sensitive; set fingerprint is order-insensitive', () => {
    const a = { ordinal: '0', operationId: UUID_1, commandFingerprint: HEX64_A }
    const b = { ordinal: '1', operationId: UUID_2, commandFingerprint: HEX64_B }
    expect(computeAttendanceItemSequenceFingerprintV1([a, b])).not.toBe(
      computeAttendanceItemSequenceFingerprintV1([b, a]),
    )
    expect(computeAttendanceItemSetFingerprintV1([a, b])).toBe(computeAttendanceItemSetFingerprintV1([b, a]))
    // Changing a row changes BOTH.
    const changed = { ...b, commandFingerprint: HEX64_A }
    expect(computeAttendanceItemSetFingerprintV1([a, changed])).not.toBe(
      computeAttendanceItemSetFingerprintV1([a, b]),
    )
    // Duplicate ordinal / malformed entries fail closed.
    expect(() => computeAttendanceItemSequenceFingerprintV1([a, { ...b, ordinal: '0' }])).toThrow(
      AttendanceW4FingerprintError,
    )
    expect(() => computeAttendanceItemSequenceFingerprintV1([{ ...a, commandFingerprint: 'zz' }])).toThrow(
      AttendanceW4FingerprintError,
    )
    expect(() => computeAttendanceItemSequenceFingerprintV1([])).toThrow(AttendanceW4FingerprintError)
  })
})

describe('W4C-0 Stage C — section 4.2 comparators', () => {
  const punchIn = { kind: 'punch', ref: 'e2', direction: 'check_in', occurredAt: '2026-03-01T01:00:00Z', source: 'attendance_event' }
  const punchOut = { kind: 'punch', ref: 'e1', direction: 'check_out', occurredAt: '2026-03-01T01:00:00Z', source: 'attendance_event' }
  const adj = { kind: 'approved_adjustment', ref: 'a1', direction: 'check_in', occurredAt: '2026-03-01T00:30:00Z', source: 'correction' }
  const absence = { kind: 'scheduled_absence', ref: 's1' }

  it('orders timed evidence by (occurredAt,direction,kind,ref) then untimed by (kind,ref)', () => {
    const sorted = sortAttendanceEvidenceV1([absence, punchOut, punchIn, adj])
    expect(sorted).toEqual([adj, punchIn, punchOut, absence])
  })

  it('fails closed on missing timed fields and unknown kinds', () => {
    expect(() => compareAttendanceEvidenceV1(punchIn, { kind: 'punch', ref: 'x' })).toThrow(
      AttendanceW4FingerprintError,
    )
    expect(() => compareAttendanceEvidenceV1(punchIn, { kind: 'mystery', ref: 'x' })).toThrow(
      AttendanceW4FingerprintError,
    )
  })

  it('ranks facts by closed kind rank then request/snapshot/approval identity', () => {
    const base = {
      requestId: 'r1',
      requestSnapshotVersion: 1,
      requestSnapshotFingerprint: HEX64_A,
      approvalVersion: 1,
      approvalRecordId: '10',
    }
    const overtime = { ...base, kind: 'overtime', coverage: { kind: 'bounded_interval', startAt: 'a', endAt: 'b', minutes: 5 } }
    const leave = { ...base, kind: 'leave', coverage: { kind: 'minutes_only_unbounded', minutes: 60, source: 'explicit_minutes' }, leaveType: 'annual' }
    const reversal = { ...base, kind: 'reversal', reversesApprovalRecordId: '9' }
    expect(sortApprovedAttendanceFactsV1([reversal, overtime, leave])).toEqual([leave, overtime, reversal])
    expect(() => sortApprovedAttendanceFactsV1([{ ...base, kind: 'unknown' }])).toThrow(AttendanceW4FingerprintError)
  })
})

describe('W4C-0 Stage C — semantic vs provenance fingerprints (section 4.3)', () => {
  const attribution = {
    posture: 'resolved_v2',
    value: {
      schemaVersion: 2,
      resolverVersion: 'w2.1',
      orgId: ORG,
      userId: UUID_1,
      workDate: '2026-03-01',
      shiftId: 'shift-1',
      reasonCode: 'assigned',
      resolvedAt: '2026-03-01T09:00:00Z',
      absoluteWindow: { startAt: '2026-02-28T16:00:00Z', endAt: '2026-03-01T16:00:00Z' },
      attributionWindow: { startAt: '2026-02-28T20:00:00Z', endAt: '2026-03-01T12:00:00Z' },
      attributionTailMinutes: 240,
      extendedByApprovedOvertime: false,
      windowEvidenceFingerprint: HEX64_A,
      source: 'live_resolution',
    },
  }
  const evidenceA = { kind: 'punch', ref: 'e1', direction: 'check_in', occurredAt: '2026-03-01T01:00:00Z', source: 'attendance_event' }
  const evidenceB = { kind: 'punch', ref: 'e2', direction: 'check_out', occurredAt: '2026-03-01T10:00:00Z', source: 'attendance_event' }
  const semanticInput = (overrides: Record<string, unknown> = {}) => ({
    attribution,
    context: null,
    evidence: [evidenceA, evidenceB],
    approvedFacts: [],
    manualOverride: null,
    mergePolicy: 'append',
    calculationTier: 'legacy_shadow',
    engineVersion: 'w4.0',
    snapshotSchemaVersion: 1,
    ...overrides,
  })

  it('caller evidence order cannot change the hash; business-time change must', () => {
    const forward = computeAttendanceSemanticInputFingerprintV1(semanticInput())
    const reversed = computeAttendanceSemanticInputFingerprintV1(semanticInput({ evidence: [evidenceB, evidenceA] }))
    expect(forward).toBe(reversed)
    const movedPunch = { ...evidenceA, occurredAt: '2026-03-01T01:00:01Z' }
    expect(
      computeAttendanceSemanticInputFingerprintV1(semanticInput({ evidence: [movedPunch, evidenceB] })),
    ).not.toBe(forward)
    expect(computeAttendanceSemanticInputFingerprintV1(semanticInput({ mergePolicy: 'merge' }))).not.toBe(forward)
  })

  it('excludes ONLY operational audit time: resolvedAt drift preserves the hash', () => {
    const shifted = {
      ...attribution,
      value: { ...attribution.value, resolvedAt: '2026-03-02T23:59:59Z' },
    }
    expect(computeAttendanceSemanticInputFingerprintV1(semanticInput({ attribution: shifted }))).toBe(
      computeAttendanceSemanticInputFingerprintV1(semanticInput()),
    )
    // ...but a business window move changes it.
    const movedWindow = {
      ...attribution,
      value: {
        ...attribution.value,
        attributionWindow: { startAt: '2026-02-28T21:00:00Z', endAt: '2026-03-01T12:00:00Z' },
      },
    }
    expect(computeAttendanceSemanticInputFingerprintV1(semanticInput({ attribution: movedWindow }))).not.toBe(
      computeAttendanceSemanticInputFingerprintV1(semanticInput()),
    )
  })

  it('rejects missing/extra top-level keys (exact nine-key projection)', () => {
    const { context: _context, ...missing } = semanticInput()
    expect(() => computeAttendanceSemanticInputFingerprintV1(missing)).toThrow(AttendanceW4FingerprintError)
    expect(() => computeAttendanceSemanticInputFingerprintV1(semanticInput({ extra: 1 }))).toThrow(
      AttendanceW4FingerprintError,
    )
  })

  it('provenance: per-variant required/forbidden keys; transports differ in hash', () => {
    const csvUpload = {
      transport: 'csv_upload',
      sourceRef: 'batch-1',
      artifactSha256: HEX64_A,
      normalizedCsvSha256: HEX64_B,
      convertedSheetName: null,
    }
    const xlsx = {
      transport: 'xlsx_client_converted_csv',
      sourceRef: 'batch-1',
      artifactSha256: HEX64_A,
      normalizedCsvSha256: HEX64_B,
      convertedSheetName: 'Sheet1',
    }
    expect(computeAttendanceProvenanceFingerprintV1(csvUpload)).not.toBe(
      computeAttendanceProvenanceFingerprintV1(xlsx),
    )
    // live_event forbids artifact metadata.
    expect(() =>
      computeAttendanceProvenanceFingerprintV1({
        transport: 'live_event',
        sourceRef: 'evt-1',
        artifactSha256: HEX64_A,
        normalizedCsvSha256: null,
        convertedSheetName: null,
      }),
    ).toThrow(AttendanceW4FingerprintError)
    // csv_upload requires the artifact hash.
    expect(() =>
      computeAttendanceProvenanceFingerprintV1({ ...csvUpload, artifactSha256: null }),
    ).toThrow(AttendanceW4FingerprintError)
    // unknown transport fails closed.
    expect(() =>
      computeAttendanceProvenanceFingerprintV1({ ...csvUpload, transport: 'ftp' }),
    ).toThrow(AttendanceW4FingerprintError)
  })
})

describe('W4C-0 Stage C — branded authorization witness (lock 4.1)', () => {
  const mintInput = () => ({
    actorId: 'user-1',
    actorPosture: 'self' as const,
    tokenSubjectUserId: 'user-1',
    orgId: ORG,
    subjectScope: { kind: 'self' as const, userId: 'user-1' },
    capability: 'punch' as const,
    sourceRef: 'route:test',
  })

  it('mints and verifies; JSON clone/spread/plain-shape fabrication fails with the closed 403 code', () => {
    const witness = createAuthorizedAttendanceWriteContextV1(mintInput())
    expect(verifyAuthorizedAttendanceWriteContextV1(witness)).toBe(witness)
    for (const forged of [
      JSON.parse(JSON.stringify(witness)),
      { ...witness },
      mintInput(),
      Object.assign(Object.create(null), witness),
      null,
      'witness',
    ]) {
      let caught: unknown
      try {
        verifyAuthorizedAttendanceWriteContextV1(forged)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AttendanceW4OperationError)
      expect((caught as AttendanceW4OperationError).code).toBe('ATTENDANCE_WRITE_NOT_AUTHORIZED')
    }
  })

  it('the minted witness is deep-frozen: post-mint mutation attempts cannot change fields', () => {
    const witness = createAuthorizedAttendanceWriteContextV1(mintInput())
    expect(() => {
      ;(witness as { orgId: string }).orgId = 'other'
    }).toThrow(TypeError)
    expect(() => {
      ;(witness.subjectScope as { userId: string }).userId = 'other'
    }).toThrow(TypeError)
    expect(verifyAuthorizedAttendanceWriteContextV1(witness)).toBe(witness)
  })

  it('rejects unknown keys, closed-enum drift, self-override, and token-subject mismatch', () => {
    expect(() => createAuthorizedAttendanceWriteContextV1({ ...mintInput(), extra: 1 })).toThrow(
      AttendanceW4AuthorizationError,
    )
    expect(() =>
      createAuthorizedAttendanceWriteContextV1({ ...mintInput(), actorPosture: 'root' }),
    ).toThrow(AttendanceW4AuthorizationError)
    expect(() =>
      createAuthorizedAttendanceWriteContextV1({ ...mintInput(), capability: 'superuser' }),
    ).toThrow(AttendanceW4AuthorizationError)
    // Self writes reject any requested user override.
    expect(() =>
      createAuthorizedAttendanceWriteContextV1({
        ...mintInput(),
        subjectScope: { kind: 'self', userId: 'someone-else' },
      }),
    ).toThrow(/W4C0_SELF_SCOPE_USER_MISMATCH/)
    expect(() =>
      createAuthorizedAttendanceWriteContextV1({ ...mintInput(), tokenSubjectUserId: 'other' }),
    ).toThrow(/W4C0_TOKEN_SUBJECT_MISMATCH/)
    // Scheduler scope only with the scheduler posture.
    expect(() =>
      createAuthorizedAttendanceWriteContextV1({
        ...mintInput(),
        subjectScope: { kind: 'org_scheduler' },
      }),
    ).toThrow(/W4C0_SCHEDULER_SCOPE_POSTURE_MISMATCH/)
  })

  it('capability<->entrypoint matrix is total over the 12 command entrypoints and enforced', () => {
    expect(Object.keys(ATTENDANCE_ENTRYPOINT_CAPABILITY_MATRIX_V1).sort()).toEqual(
      [...ATTENDANCE_SOURCE_ENTRYPOINTS_V1].sort(),
    )
    const witness = createAuthorizedAttendanceWriteContextV1(mintInput())
    expect(requireAuthorizedCapabilityForEntrypointV1(witness, 'live_punch')).toBe(witness)
    let caught: unknown
    try {
      requireAuthorizedCapabilityForEntrypointV1(witness, 'manual_edit')
    } catch (error) {
      caught = error
    }
    expect((caught as AttendanceW4OperationError).code).toBe('ATTENDANCE_WRITE_NOT_AUTHORIZED')
  })
})

describe('W4C-0 Stage C — strict source-command validators (lock 4.1 matrix)', () => {
  const livePunchEnvelope = (operationId: string | null = UUID_1) => ({
    schemaVersion: 1,
    orgId: ORG,
    correlationId: 'corr-1',
    command: {
      schemaVersion: 1,
      kind: 'live_punch',
      subjectUserId: 'user-1',
      operationId,
      payload: {
        eventType: 'check_in',
        occurredAt: '2026-03-01T01:00:00Z',
        timezone: 'Asia/Shanghai',
        source: 'mobile',
        location: { lat: 1, lng: 2 },
        meta: null,
        photoFileRef: null,
      },
    },
    batch: null,
  })

  it('normalizes a live punch: frozen output, stable fingerprint, caller mutation cannot leak in', () => {
    const input = livePunchEnvelope()
    const normalized = normalizeAttendanceSourceOperationEnvelopeV1(input)
    const again = normalizeAttendanceSourceOperationEnvelopeV1(livePunchEnvelope())
    expect(normalized.commands[0].commandFingerprint).toBe(again.commands[0].commandFingerprint)
    expect(normalized.entrypoint).toBe('live_punch')
    expect(Object.isFrozen(normalized.commands[0])).toBe(true)
    expect(Object.isFrozen(normalized.commands[0].payload)).toBe(true)
    // Mutating the caller-owned object after entry cannot alter the claimed command.
    ;(input.command.payload as { eventType: string }).eventType = 'check_out'
    expect(normalized.commands[0].payload.eventType).toBe('check_in')
    // Registry input carries the direct source tuple / fingerprint.
    expect(normalized.registryInput.commands[0].source).toEqual({
      sourceKind: 'direct_live_punch',
      clientOperationId: UUID_1,
    })
  })

  it('rejects unknown keys, unknown kinds, closed-enum drift, and command+batch ambiguity', () => {
    const extraKey = livePunchEnvelope()
    ;(extraKey.command.payload as Record<string, unknown>).surprise = true
    expect(() => normalizeAttendanceSourceOperationEnvelopeV1(extraKey)).toThrow(AttendanceW4CommandError)
    const badKind = livePunchEnvelope()
    ;(badKind.command as { kind: string }).kind = 'mystery'
    expect(() => normalizeAttendanceSourceOperationEnvelopeV1(badKind)).toThrow(AttendanceW4CommandError)
    const badEnum = livePunchEnvelope()
    ;(badEnum.command.payload as { eventType: string }).eventType = 'clock_in'
    expect(() => normalizeAttendanceSourceOperationEnvelopeV1(badEnum)).toThrow(AttendanceW4CommandError)
    expect(() =>
      normalizeAttendanceSourceOperationEnvelopeV1({ ...livePunchEnvelope(), batch: {} }),
    ).toThrow(AttendanceW4CommandError)
    expect(() =>
      normalizeAttendanceSourceOperationEnvelopeV1({ ...livePunchEnvelope(), command: null }),
    ).toThrow(AttendanceW4CommandError)
  })

  it('uppercase UUID input canonicalizes to the same lowercase identity/fingerprint', () => {
    const upper = normalizeAttendanceSourceOperationEnvelopeV1(livePunchEnvelope(UUID_1.toUpperCase()))
    expect(upper.commands[0].operationId).toBe(UUID_1)
    expect(upper.commands[0].commandFingerprint).toBe(
      normalizeAttendanceSourceOperationEnvelopeV1(livePunchEnvelope()).commands[0].commandFingerprint,
    )
  })

  it('null-ID legacy command stays parseable with a null registry source', () => {
    const normalized = normalizeAttendanceSourceOperationEnvelopeV1(livePunchEnvelope(null))
    expect(normalized.commands[0].operationId).toBeNull()
    expect(normalized.registryInput.commands[0].source).toBeNull()
  })

  it('verified-channel decision requires the delivery-ledger UUID and binds action into the fingerprint', () => {
    const decision = (action: 'approve' | 'reject', operationId: string | null) => ({
      schemaVersion: 1,
      orgId: ORG,
      correlationId: 'corr-2',
      command: {
        schemaVersion: 1,
        kind: 'request_decision',
        subjectUserId: 'user-2',
        operationId,
        payload: {
          requestId: UUID_2,
          approvalRef: '77',
          expectedApprovalVersion: 3,
          expectedApprovalNode: 'node-1',
          action,
          decisionChannel: 'verified_delivery',
          comment: null,
          meta: null,
        },
      },
      batch: null,
    })
    expect(() => normalizeAttendanceSourceOperationEnvelopeV1(decision('approve', null))).toThrow(
      AttendanceW4CommandError,
    )
    const approve = normalizeAttendanceSourceOperationEnvelopeV1(decision('approve', UUID_1))
    const reject = normalizeAttendanceSourceOperationEnvelopeV1(decision('reject', UUID_1))
    expect(approve.registryInput.commands[0].source).toEqual({
      sourceKind: 'verified_delivery',
      deliveryLedgerId: UUID_1,
    })
    // Reusing one delivery ID for a different action conflicts via the fingerprint.
    expect(approve.commands[0].commandFingerprint).not.toBe(reject.commands[0].commandFingerprint)
  })

  it('scheduled command derives its identity and rejects a caller-supplied operation ID', () => {
    const scheduled = (operationId: string | null) => ({
      schemaVersion: 1,
      orgId: ORG,
      correlationId: 'corr-3',
      command: {
        schemaVersion: 1,
        kind: 'scheduled',
        subjectUserId: UUID_2,
        operationId,
        payload: {
          scheduledRunId: UUID_1,
          userId: UUID_2,
          workDate: '2026-03-01',
          expectedRunVersion: 1,
          scheduledAbsenceSource: 'cron',
        },
      },
      batch: null,
    })
    expect(() => normalizeAttendanceSourceOperationEnvelopeV1(scheduled(UUID_2))).toThrow(AttendanceW4CommandError)
    const normalized = normalizeAttendanceSourceOperationEnvelopeV1(scheduled(null))
    expect(normalized.registryInput.commands[0].source).toEqual({
      sourceKind: 'scheduled',
      scheduledRunId: UUID_1,
      userId: UUID_2,
      workDate: '2026-03-01',
    })
  })

  it('import batch: ordered items with ordinal===index; ordinal drift fails closed', () => {
    const batchEnvelope = (ordinals: [number, number]) => ({
      schemaVersion: 1,
      orgId: ORG,
      correlationId: 'corr-4',
      command: null,
      batch: {
        schemaVersion: 1,
        kind: 'import_batch',
        payload: { batchCommandId: UUID_1, transportKind: 'csv_upload', batchFingerprint: HEX64_A },
        items: [
          { ordinal: ordinals[0], subjectUserId: 'user-1', semanticFingerprint: HEX64_A, normalizedBusinessInput: { row: 1 } },
          { ordinal: ordinals[1], subjectUserId: 'user-2', semanticFingerprint: HEX64_B, normalizedBusinessInput: { row: 2 } },
        ],
      },
    })
    const normalized = normalizeAttendanceSourceOperationEnvelopeV1(batchEnvelope([0, 1]))
    expect(normalized.entrypoint).toBe('import_batch')
    expect(normalized.batch?.batchCommandId).toBe(UUID_1)
    expect(normalized.registryInput.batch?.items).toHaveLength(2)
    expect(normalized.registryInput.batch?.items[0].source).toEqual({
      sourceKind: 'import_item',
      batchCommandId: UUID_1,
      ordinal: '0',
      semanticFingerprint: HEX64_A,
    })
    expect(() => normalizeAttendanceSourceOperationEnvelopeV1(batchEnvelope([1, 0]))).toThrow(
      /W4C0_BATCH_ITEM_ORDINAL_MISMATCH/,
    )
  })
})
