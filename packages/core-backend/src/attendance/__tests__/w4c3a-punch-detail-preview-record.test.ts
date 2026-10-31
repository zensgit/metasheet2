import { describe, expect, it, vi } from 'vitest'
import { sha256HexOfCanonicalJsonV1, parseLegacyImportPublicJobEnvelopeV1 } from '../w4c3a-legacy-execution-plan'
import { fingerprintAttendancePunchDetailCommandV1, parseAttendanceImportJobEnvelopeV1 } from '../w4c3a-punch-detail-command'
import {
  buildAttendancePunchDetailPreviewRecordV1,
  fingerprintAttendancePunchDetailPreviewRequestV1,
  verifyAttendancePunchDetailPreviewRecordV1,
  type AttendancePunchDetailPreviewBindingV1,
} from '../w4c3a-punch-detail-preview-record'
import { punchDetailPreparationFixture, type PunchDetailFixtureKind } from './helpers/punch-detail-plan-fixture'

const jobId = '56c27935-1790-4cf9-8b8e-e799afc88439'
const otherId = '7836366e-0d20-48df-b70e-54282783e657'
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function fixture(kind: PunchDetailFixtureKind = 'fold_start', previewLimit = 4) {
  const preparation = punchDetailPreparationFixture(kind)
  const stored = buildAttendancePunchDetailPreviewRecordV1({ jobId, preparation, previewLimit })
  const expected: AttendancePunchDetailPreviewBindingV1 = { jobId, batchId: preparation.batchId,
    scope: preparation.scope, requestFingerprint: stored.record.requestFingerprint, snapshotDigest: stored.snapshotDigest }
  return { preparation, ...stored, expected }
}

describe('punch-detail frozen preview record', () => {
  it.each([['fold_start', 165], ['fold_end', 195]] as const)(
    'rehydrates %s from frozen facts with four events and literal minutes', (kind, minutes) => {
      const { record, expected } = fixture(kind)
      const reloaded = verifyAttendancePunchDetailPreviewRecordV1(clone(record), expected)
      expect(reloaded).toEqual(record)
      expect(reloaded.preview.items).toEqual(record.envelope.__punchDetailInput.punches
        .map((punch, sourceOrdinal) => ({ sourceOrdinal, ...punch })))
      expect(reloaded.preview).toMatchObject({ inputKind: 'punch_events_v1', eventCount: 4, targetCount: 1,
        total: 4, rowCount: 4, processedRows: 4, failedRows: 0, previewLimit: 4, truncated: false,
        csvWarnings: [], groupWarnings: [], targets: [{ outcome: 'completed', dailyProjection: { workedMinutes: minutes } }] })
      expect(reloaded.preview.targets[0].segments).toHaveLength(2)
      expect(reloaded).not.toHaveProperty('recordWrites')
      expect(reloaded).not.toHaveProperty('plan')
    })

  it.each([['gap', 'dst_gap_local_time'], ['shared_fold', 'dst_fold_shared_boundary_ambiguous']] as const)(
    'keeps %s review without manufacturing daily minutes', (kind, reason) => {
      const { record, expected } = fixture(kind)
      expect(verifyAttendancePunchDetailPreviewRecordV1(record, expected).preview.targets).toEqual([
        { userId: record.envelope.__punchDetailInput.userId, workDate: record.envelope.__punchDetailInput.workDate,
          outcome: 'review_required', reasonCode: reason, dailyProjection: null, segments: record.preview.targets[0].segments },
      ])
    })

  it('truncates displayed events only, while the frozen command and calculation retain all four', () => {
    const { record, expected } = fixture('fold_start', 1)
    const result = verifyAttendancePunchDetailPreviewRecordV1(record, expected)
    expect(result.envelope.__punchDetailInput.punches).toHaveLength(4)
    expect(result.preview.items).toEqual([{ sourceOrdinal: 0, direction: 'check_in', occurredAt: '2025-11-02T04:30:00.000Z' }])
    expect(result.preview).toMatchObject({ total: 4, previewLimit: 1, truncated: true })
    expect(result.preview.targets[0].dailyProjection?.workedMinutes).toBe(165)
  })

  it('excludes new server IDs and freeze timestamps from retry identity, but binds them in storage', () => {
    const original = fixture()
    const preparation = clone(original.preparation)
    Object.assign(preparation, { batchId: otherId })
    Object.assign(preparation.attribution.attribution.value, { resolvedAt: '2025-11-02T13:00:00.000Z' })
    const second = buildAttendancePunchDetailPreviewRecordV1({ jobId: otherId, preparation, previewLimit: 4 })
    expect(second.record.requestFingerprint).toBe(original.record.requestFingerprint)
    expect(second.snapshotDigest).not.toBe(original.snapshotDigest)
  })

  it('uses a preview-specific fingerprint, separate from the commit command', () => {
    const { record, preparation } = fixture()
    expect(record.requestFingerprint).not.toBe(fingerprintAttendancePunchDetailCommandV1(preparation.scope, preparation.envelope))
  })

  it.each(['orgId', 'actorId', 'actorPosture', 'tokenSubjectUserId'] as const)(
    'binds request identity field %s', (field) => {
      const { preparation, record } = fixture()
      const scope = { ...preparation.scope, [field]: field === 'actorPosture' ? 'attendance_admin' : field === 'orgId' ? otherId : 'other-actor' }
      expect(fingerprintAttendancePunchDetailPreviewRequestV1(scope, preparation.envelope, 4)).not.toBe(record.requestFingerprint)
    })

  it.each(['previewLimit', 'idempotencyKey', 'events', 'engine', 'recordStrategy', 'itemStrategy'])(
    'binds accepted request field %s', (field) => {
      const { preparation, record } = fixture()
      const envelope = clone(preparation.envelope)
      if (field === 'idempotencyKey') Object.assign(envelope, { idempotencyKey: 'different-key' })
      if (field === 'events') Object.assign(envelope.__punchDetailInput.punches[1], { occurredAt: '2025-11-02T04:46:00.000Z' })
      if (field === 'engine') Object.assign(envelope, { __importEngine: 'bulk' })
      if (field === 'recordStrategy') Object.assign(envelope, { recordUpsertStrategy: 'unnest' })
      if (field === 'itemStrategy') Object.assign(envelope, { itemsInsertStrategy: 'unnest' })
      expect(fingerprintAttendancePunchDetailPreviewRequestV1(preparation.scope, envelope, field === 'previewLimit' ? 3 : 4))
        .not.toBe(record.requestFingerprint)
    })

  it.each(['jobId', 'batchId', 'scope', 'requestFingerprint'])(
    'rejects trusted job binding mismatch %s before returning a preview', (field) => {
      const { record, expected } = fixture()
      const changed = { ...expected, [field]: field === 'scope' ? { ...expected.scope, orgId: otherId }
        : field === 'requestFingerprint' ? 'a'.repeat(64) : otherId }
      expect(() => verifyAttendancePunchDetailPreviewRecordV1(record, changed)).toThrow('PREVIEW_IDENTITY_MISMATCH')
    })

  it('rejects another valid record when its independent digest anchor is unchanged', () => {
    const first = fixture()
    const second = fixture('fold_start', 3)
    expect(() => verifyAttendancePunchDetailPreviewRecordV1(second.record, { ...second.expected, snapshotDigest: first.snapshotDigest }))
      .toThrow('PREVIEW_DIGEST_MISMATCH')
  })

  it('rejects forged result even with a self-consistent JSON digest', () => {
    const { record, expected } = fixture()
    const forged = clone(record)
    Object.assign(forged.preview.targets[0].dailyProjection!, { workedMinutes: 999 })
    expect(() => verifyAttendancePunchDetailPreviewRecordV1(forged, { ...expected, snapshotDigest: sha256HexOfCanonicalJsonV1(forged) }))
      .toThrow('PREVIEW_RESULT_MISMATCH')
  })

  it.each(['context', 'attribution', 'policySourceProof'] as const)(
    'revalidates the frozen %s even with a recomputed record digest', (field) => {
      const { record, expected } = fixture()
      const forged = clone(record)
      if (field === 'context') Object.assign(forged.frozenTarget.context, { timezone: 'UTC' })
      if (field === 'attribution') Object.assign(forged.frozenTarget.attribution.attribution.value.absoluteWindow, { endAt: '2025-11-02T09:00:00.000Z' })
      if (field === 'policySourceProof') Object.assign(forged.frozenTarget.policySourceProof.sourceDefinition.rule, { roundingMinutes: 30 })
      expect(() => verifyAttendancePunchDetailPreviewRecordV1(forged, { ...expected, snapshotDigest: sha256HexOfCanonicalJsonV1(forged) })).toThrow()
    })

  it.each(['version', 'kind', 'unknownKey', 'frozenUnknownKey', 'scopeUnknownKey', 'invalidPosture', 'invalidLimit', 'whitespaceKey'])(
    'rejects invalid closed record %s without legacy fallback', (variant) => {
      const { record, expected } = fixture()
      const changed = clone(record)
      if (variant === 'version') Object.assign(changed, { schemaVersion: 2 })
      if (variant === 'kind') Object.assign(changed, { kind: 'commit' })
      if (variant === 'unknownKey') Object.assign(changed, { effect: {} })
      if (variant === 'frozenUnknownKey') Object.assign(changed.frozenTarget, { scheduleLoader: 'mutable' })
      if (variant === 'scopeUnknownKey') Object.assign(changed.scope, { admin: true })
      if (variant === 'invalidPosture') Object.assign(changed.scope, { actorPosture: 'unknown' })
      if (variant === 'invalidLimit') Object.assign(changed, { previewLimit: 0 })
      if (variant === 'whitespaceKey') Object.assign(changed.envelope, { idempotencyKey: ' key ' })
      expect(() => verifyAttendancePunchDetailPreviewRecordV1(changed, { ...expected, snapshotDigest: sha256HexOfCanonicalJsonV1(changed) })).toThrow()
    })

  it('does not execute a getter used as a record field', () => {
    const { record, expected } = fixture()
    const getter = vi.fn(() => jobId)
    const changed = { ...record }
    Object.defineProperty(changed, 'jobId', { get: getter, enumerable: true })
    expect(() => verifyAttendancePunchDetailPreviewRecordV1(changed, expected)).toThrow('PREVIEW_INVALID')
    expect(getter).not.toHaveBeenCalled()
  })

  it('detaches all frozen source and result data from the caller', () => {
    const { record, expected, preparation } = fixture()
    const before = JSON.stringify(record)
    Object.assign(preparation.context.segments[0], { endTime: '00:40' })
    Object.assign(preparation.envelope.__punchDetailInput.punches[1], { occurredAt: '2025-11-02T04:40:00.000Z' })
    expect(JSON.stringify(verifyAttendancePunchDetailPreviewRecordV1(record, expected))).toBe(before)
    expect(Object.isFrozen(record.frozenTarget.context.segments[0])).toBe(true)
    expect(Object.isFrozen(record.preview.targets[0].dailyProjection)).toBe(true)
  })

  it('cannot be parsed as either a daily or punch-detail commit envelope', () => {
    const { record } = fixture()
    expect(() => parseLegacyImportPublicJobEnvelopeV1(record)).toThrow()
    expect(() => parseAttendanceImportJobEnvelopeV1(record)).toThrow()
  })

  it.each(['build', 'read'])('rejects extra policy proof keys at the %s boundary', (boundary) => {
    const { record, expected, preparation } = fixture()
    if (boundary === 'build') {
      const changed = clone(preparation)
      Object.assign(changed.policySourceProof, { extra: true })
      expect(() => buildAttendancePunchDetailPreviewRecordV1({ jobId, preparation: changed, previewLimit: 4 }))
        .toThrow('PREVIEW_INVALID')
    } else {
      const changed = clone(record)
      Object.assign(changed.frozenTarget.policySourceProof, { extra: true })
      expect(() => verifyAttendancePunchDetailPreviewRecordV1(changed, { ...expected, snapshotDigest: sha256HexOfCanonicalJsonV1(changed) }))
        .toThrow('PREVIEW_INVALID')
    }
  })
})
