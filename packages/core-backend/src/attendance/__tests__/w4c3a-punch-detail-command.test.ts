import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertAttendancePunchDetailCanonicalBranchV1,
  fingerprintAttendancePunchDetailCommandV1,
  parseAttendanceImportJobEnvelopeV1,
  readAttendancePunchDetailEnvelopeV1,
  requireAttendancePunchDetailPlanBindingV1,
  requireAttendancePunchDetailStoredPlanBindingV1,
  type AttendancePunchDetailJobEnvelopeV1,
  type AttendancePunchDetailPlanBindingInputV1,
} from '../w4c3a-punch-detail-command'
import { parseLegacyImportPublicJobEnvelopeV1 } from '../w4c3a-legacy-execution-plan'
import { expandAttendancePunchDetailEvidenceV1 } from '../w4c3a-punch-detail-evidence'
import { createAttendanceSyncImportHostV1, type CommitAttendanceSyncImportPlanFromHostInputV1 } from '../w4c3a-sync-import-host'
import { createAttendanceLegacyPlanReservationHostV1 } from '../w4c3a-legacy-plan-reservation-host'
import type { AttendanceLegacyPlanWorkerJobV1, VerifiedAttendanceLegacyPlanV1 } from '../w4c3a-legacy-plan-worker'

const batchId = 'b62fe9a4-821f-4a2c-b917-0380dd12bd98'
const scope = { orgId: '2ec9914b-5352-4f9a-a4ef-4c344c045ef1', actorId: 'synthetic-admin',
  actorPosture: 'platform_admin', tokenSubjectUserId: 'synthetic-admin' }
const legacy = { __jobType: 'commit', idempotencyKey: 'synthetic-key', __importEngine: 'standard',
  recordUpsertStrategy: 'values', itemsInsertStrategy: 'values', __w4ContractVersion: 1 } as const
function envelope(): AttendancePunchDetailJobEnvelopeV1 {
  return { ...legacy, __punchDetailInput: { inputKind: 'punch_events_v1', userId: 'synthetic-employee',
    workDate: '2025-11-02', timezone: 'America/New_York', punches: [
      { direction: 'check_in', occurredAt: '2025-11-02T04:30:00.000Z' },
      { direction: 'check_out', occurredAt: '2025-11-02T04:45:00.000Z' },
      { direction: 'check_in', occurredAt: '2025-11-02T05:30:00.000Z' },
      { direction: 'check_out', occurredAt: '2025-11-02T08:00:00.000Z' },
    ] } }
}
function fixture(): AttendancePunchDetailPlanBindingInputV1 {
  const payload = envelope(), command = payload.__punchDetailInput
  const fp = fingerprintAttendancePunchDetailCommandV1(scope, payload)
  return { ...scope, batchId, envelope: payload,
    batch: { kind: 'normal', source: 'manual', ruleSetId: null,
      mappingSnapshot: { kind: 'punch_events_v1', envelope: payload, requestFingerprint: fp },
      sourceRowCount: 4, status: 'committed', idempotencyKey: legacy.idempotencyKey, visibilityRule: 'org',
      engine: 'standard', chunkConfig: {}, recordUpsertStrategy: 'values', itemsInsertStrategy: 'values',
      mappingProfileId: null, compatibilityMetadata: { punchDetailRequestFingerprint: fp }, groupSync: null,
      itemReturnPolicy: { returnItems: false, itemsLimit: null }, skippedSamplePolicy: { limit: 50 },
      resultSlots: { groupCreated: 'ensure_group_returned_row_count', groupMembersAdded: 'ensure_member_inserted_row_count' } },
    items: expandAttendancePunchDetailEvidenceV1(command, batchId).map((rawEvidence, ordinal) => ({
      kind: 'apply', ordinal, semanticOrdinal: ordinal, targetRef: JSON.stringify([scope.orgId, command.userId, command.workDate]),
      rawEvidence, previewSnapshot: {},
    })),
    recordWrites: [{ orgId: scope.orgId, userId: command.userId, workDate: command.workDate, timezone: command.timezone,
      sourceBatchId: batchId, sourceOrdinals: [0, 1, 2, 3], mergeMode: 'override',
      firstInAt: null, lastOutAt: null, workMinutes: null, lateMinutes: null, earlyLeaveMinutes: null,
      status: null, isWorkday: null, compatibilityMetadata: {}, policySnapshot: {}, attributionSnapshot: {},
      profileSnapshot: {}, multiPunchSnapshot: {}, resultSlots: {} }],
    groupEffects: [],
  }
}
function hostInput(): CommitAttendanceSyncImportPlanFromHostInputV1 {
  const f = fixture()
  return { ...f, actorPosture: 'platform_admin', payload: f.envelope as AttendancePunchDetailJobEnvelopeV1,
    idempotencyKey: legacy.idempotencyKey, legacyRowSourceKind: 'direct_rows', legacySourceRowLimit: null,
    batch: f.batch as Extract<typeof f.batch, { kind: 'normal' }>,
    artifactCleanup: { kind: 'none' }, groupEffects: [], itemReturnPolicy: { returnItems: true, itemsLimit: null } }
}
afterEach(() => vi.unstubAllEnvs())

function dailyHostInput(): CommitAttendanceSyncImportPlanFromHostInputV1 {
  const f = hostInput()
  return { ...f, payload: legacy,
    batch: { ...f.batch, mappingSnapshot: {}, compatibilityMetadata: {} },
    items: f.items.map((item) => ({ ...item, rawEvidence: {
      ...item.rawEvidence, provenance: { ...item.rawEvidence.provenance, sourceRef: 'legacy-source' },
    } })),
  }
}

function replayHost(meta: Record<string, unknown>, posture = 'authoritative') {
  vi.stubEnv('ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED', scope.orgId)
  const calls: { text: string; values: unknown }[] = []
  const release = vi.fn()
  const host = createAttendanceSyncImportHostV1({ acquireConnection: async () => ({
    release,
    client: { query: async (text: string, values?: unknown) => {
      calls.push({ text, values })
      if (text === 'SAVEPOINT w4c5_idle_probe') {
        throw Object.assign(new Error('no_active_sql_transaction'), { code: '25P01' })
      }
      if (text === 'SELECT state, scope FROM attendance_calculation_rollout_state WHERE org_id = $1') {
        return { rows: [{ state: posture, scope: 'synthetic_staging' }] }
      }
      if (text.startsWith('SELECT 1 FROM users WHERE') || text.startsWith('SELECT 1 FROM user_orgs WHERE')) {
        return { rows: [{ '?column?': 1 }] }
      }
      if (text.includes('FROM attendance_import_batches')) {
        expect(values).toEqual([scope.orgId, legacy.idempotencyKey])
        return { rows: [{ id: batchId, row_count: 4, meta }] }
      }
      if (['BEGIN ISOLATION LEVEL SERIALIZABLE', 'COMMIT', 'ROLLBACK'].includes(text)
        || text.startsWith('SELECT set_config(') || text.startsWith('SELECT pg_advisory_xact_lock')) {
        return { rows: [] }
      }
      throw new Error('unexpected replay SQL')
    } },
  }) })
  return { host, calls, release }
}

function assertReplayBoundary(h: ReturnType<typeof replayHost>, committed: boolean) {
  expect(h.calls.some((call) => call.text.includes('FROM attendance_import_batches'))).toBe(true)
  expect(h.calls.filter((call) => /^(INSERT|UPDATE|DELETE|COPY|TRUNCATE)\b/i.test(call.text))).toEqual([])
  expect(h.calls.at(-1)?.text).toBe(committed ? 'COMMIT' : 'ROLLBACK')
  expect(h.release).toHaveBeenCalledTimes(1)
}

function reboundPunchInput(actorId = scope.actorId, changedInput = false) {
  const f = hostInput(), original = envelope()
  const payload: AttendancePunchDetailJobEnvelopeV1 = changedInput
    ? { ...original, __punchDetailInput: { ...original.__punchDetailInput, punches: [
      ...original.__punchDetailInput.punches.slice(0, 3),
      { direction: 'check_out', occurredAt: '2025-11-02T08:01:00.000Z' },
    ] } } : original
  const nextBatchId = 'f62fe9a4-821f-4a2c-b917-0380dd12bd98'
  const nextScope = { ...scope, actorId, tokenSubjectUserId: actorId }
  const fp = fingerprintAttendancePunchDetailCommandV1(nextScope, payload)
  const raw = expandAttendancePunchDetailEvidenceV1(payload.__punchDetailInput, nextBatchId)
  return { ...f, ...nextScope, actorPosture: 'platform_admin' as const, batchId: nextBatchId, payload,
    batch: { ...f.batch, mappingSnapshot: { kind: 'punch_events_v1', envelope: payload, requestFingerprint: fp },
      compatibilityMetadata: { punchDetailRequestFingerprint: fp } },
    items: f.items.map((item, i) => ({ ...item, rawEvidence: raw[i] })),
    recordWrites: f.recordWrites.map((write) => ({ ...write, sourceBatchId: nextBatchId })),
  }
}

const reject = (f: AttendancePunchDetailPlanBindingInputV1) =>
  expect(() => requireAttendancePunchDetailPlanBindingV1(f)).toThrowError('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')

describe('explicit punch-detail durable command binding', () => {
  it('preserves the legacy envelope and does not extend its parser', () => {
    expect(parseAttendanceImportJobEnvelopeV1(legacy)).toEqual(parseLegacyImportPublicJobEnvelopeV1(legacy))
    expect(readAttendancePunchDetailEnvelopeV1(legacy)).toBeNull()
    expect(() => parseLegacyImportPublicJobEnvelopeV1(envelope())).toThrowError('W4C3A_PUBLIC_JOB_ENVELOPE_INVALID')
  })
  it('roundtrips a detached immutable durable command without losing its second pair', () => {
    const original = envelope(), parsed = parseAttendanceImportJobEnvelopeV1(JSON.parse(JSON.stringify(original)))
    expect(parsed).toEqual(original)
    expect(readAttendancePunchDetailEnvelopeV1(parsed)?.__punchDetailInput.punches[2])
      .toEqual({ direction: 'check_in', occurredAt: '2025-11-02T05:30:00.000Z' })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(readAttendancePunchDetailEnvelopeV1(parsed)?.__punchDetailInput.punches)).toBe(true)
  })
  it.each([null, undefined, {}, { ...envelope().__punchDetailInput, inputKind: 'daily' }])(
    'rejects a present invalid extension instead of falling back', (value) => {
      expect(() => parseAttendanceImportJobEnvelopeV1({ ...legacy, __punchDetailInput: value })).toThrow()
    })
  it('rejects getters without invoking them', () => {
    const getter = vi.fn(() => envelope().__punchDetailInput)
    expect(() => parseAttendanceImportJobEnvelopeV1(Object.defineProperty({ ...legacy }, '__punchDetailInput', { get: getter }))).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
  it('does not interpret arbitrary legacy metadata as an event command', () => {
    const f = fixture()
    const old = { ...f, envelope: legacy, batch: { ...f.batch, mappingSnapshot: {} } as typeof f.batch, items: f.items.map((item) => ({
      ...item, rawEvidence: { ...item.rawEvidence, provenance: { ...item.rawEvidence.provenance, sourceRef: 'legacy-source' } },
    })) }
    expect(requireAttendancePunchDetailPlanBindingV1(old)).toBeNull()
  })
  it('accepts exact ordered events bound to one target', () => {
    const result = requireAttendancePunchDetailPlanBindingV1(fixture())
    expect(result).toEqual({ envelope: envelope(), requestFingerprint: fingerprintAttendancePunchDetailCommandV1(scope, envelope()) })
  })
  it('rejects a stripped command discriminator even with otherwise valid old envelope', () => {
    reject({ ...fixture(), envelope: legacy })
  })
  it.each(['orgId', 'actorId', 'actorPosture', 'tokenSubjectUserId'] as const)(
    'binds request replay to identity %s', (key) => {
      const changed = { ...scope, [key]: 'different-synthetic-value' }
      expect(fingerprintAttendancePunchDetailCommandV1(changed, envelope()))
        .not.toBe(fingerprintAttendancePunchDetailCommandV1(scope, envelope()))
      reject({ ...fixture(), [key]: changed[key] })
    })
  it('binds the second pair and existing transport options independently of a new batch UUID', () => {
    const e = envelope(), changed = { ...e, __punchDetailInput: { ...e.__punchDetailInput, punches: e.__punchDetailInput.punches.map((p, i) =>
      i === 2 ? { ...p, occurredAt: '2025-11-02T05:31:00.000Z' } : p) } }
    const fp = fingerprintAttendancePunchDetailCommandV1(scope, e)
    expect(fingerprintAttendancePunchDetailCommandV1(scope, changed)).not.toBe(fp)
    expect(fingerprintAttendancePunchDetailCommandV1(scope, { ...e, idempotencyKey: 'other-key' })).not.toBe(fp)
    expect(fingerprintAttendancePunchDetailCommandV1(scope, { ...e, recordUpsertStrategy: 'unnest' })).not.toBe(fp)
    reject({ ...fixture(), batchId: 'f62fe9a4-821f-4a2c-b917-0380dd12bd98' })
  })
  it('rejects event loss even if counts and target membership are changed together', () => {
    const f = fixture()
    reject({ ...f, batch: { ...f.batch, sourceRowCount: 2 } as typeof f.batch, items: f.items.slice(0, 2),
      recordWrites: [{ ...f.recordWrites[0], sourceOrdinals: [0, 1] }] })
  })
  it('rejects a changed second-pair instant against the frozen declared command', () => {
    const f = fixture(), other = envelope().__punchDetailInput
    const raw = expandAttendancePunchDetailEvidenceV1({ ...other, punches: other.punches.map((p, i) =>
      i === 2 ? { ...p, occurredAt: '2025-11-02T05:31:00.000Z' } : p) }, batchId)
    reject({ ...f, items: f.items.map((item, i) => ({ ...item, rawEvidence: raw[i] })) })
  })
  it.each(['orgId', 'userId', 'workDate', 'timezone', 'sourceBatchId'] as const)(
    'rejects target substitution %s', (key) => {
      const f = fixture()
      reject({ ...f, recordWrites: [{ ...f.recordWrites[0], [key]: 'substituted' }] })
    })
  it('rejects collapsed semantic ordinals and target references', () => {
    const f = fixture()
    reject({ ...f, items: f.items.map((item) => item.kind === 'apply' ? { ...item, semanticOrdinal: 0 } : item) })
    reject({ ...f, items: f.items.map((item) => item.kind === 'apply' ? { ...item, targetRef: 'other-target' } : item) })
  })
  it('rejects descriptor and committed-replay fingerprint tampering', () => {
    const f = fixture()
    expect(f.batch.kind).toBe('normal')
    if (f.batch.kind !== 'normal') throw new Error('fixture')
    reject({ ...f, batch: { ...f.batch, mappingSnapshot: { kind: 'punch_events_v1', requestFingerprint: '0'.repeat(64) } } })
    reject({ ...f, batch: { ...f.batch, compatibilityMetadata: {} } })
  })
  it.each(['legacy_projection_only', 'blocked'])('rejects canonical downgrade to %s', (posture) => {
    expect(() => assertAttendancePunchDetailCanonicalBranchV1({}, posture, 'strict_targeted')).toThrowError('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
  })
  it.each(['operational_only_batch_limit', 'operational_only_no_target', 'operational_only_idempotent_replay'])(
    'rejects operational fallback %s', (branch) => {
      expect(() => assertAttendancePunchDetailCanonicalBranchV1({}, 'shadow', branch)).toThrowError('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
    })
  it('keeps legacy admission unchanged and admits both canonical postures', () => {
    expect(() => assertAttendancePunchDetailCanonicalBranchV1(null, 'legacy_projection_only', 'operational_only_batch_limit')).not.toThrow()
    for (const posture of ['shadow', 'authoritative']) {
      expect(() => assertAttendancePunchDetailCanonicalBranchV1({}, posture, 'strict_targeted')).not.toThrow()
    }
  })
  it('rechecks the durable request fingerprint before recovery effects', () => {
    const f = fixture(), requestFingerprint = fingerprintAttendancePunchDetailCommandV1(scope, envelope())
    const plan = { manifest: { batch: f.batch, legacyInputFingerprint: requestFingerprint },
      items: f.items, recordWrites: f.recordWrites, groupEffects: [] } as unknown as VerifiedAttendanceLegacyPlanV1
    const job = { ...scope, batchId, legacyInputFingerprint: requestFingerprint,
      acceptedWritePosture: 'authoritative', operationalBranch: 'strict_targeted' } as AttendanceLegacyPlanWorkerJobV1
    expect(requireAttendancePunchDetailStoredPlanBindingV1(job, plan)?.requestFingerprint).toBe(requestFingerprint)
    expect(() => requireAttendancePunchDetailStoredPlanBindingV1({ ...job, legacyInputFingerprint: '0'.repeat(64) }, plan))
      .toThrowError('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
  })
  it('rejects malformed sync commands before acquiring a connection', async () => {
    const acquireConnection = vi.fn(async () => { throw new Error('unexpected connection') })
    const input = hostInput()
    await expect(createAttendanceSyncImportHostV1({ acquireConnection }).commitSyncImportPlanV1({
      ...input, payload: { ...input.payload, __punchDetailInput: null } as never,
    })).rejects.toThrow()
    expect(acquireConnection).not.toHaveBeenCalled()
  })
  it('rejects a reservation replay fingerprint mismatch before acquiring a connection', async () => {
    const acquireConnection = vi.fn(async () => { throw new Error('unexpected connection') })
    await expect(createAttendanceLegacyPlanReservationHostV1({ acquireConnection }).reserveLegacyImportPlanV1({
      ...hostInput(), legacyInputFingerprint: '0'.repeat(64),
    })).rejects.toThrowError('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
    expect(acquireConnection).not.toHaveBeenCalled()
  })
})

describe('command review regressions', () => {
  it('CB01 rejects a reserved descriptor without an explicit command or raw marker', () => {
    const daily = dailyHostInput(), source = hostInput()
    reject({ ...daily, envelope: daily.payload, batch: source.batch })
  })
  it.each(['sync', 'reservation'])('CB01 refuses descriptor-only %s admission before connection', async (kind) => {
    const acquireConnection = vi.fn(async () => { throw new Error('unexpected connection') })
    const input = { ...dailyHostInput(), batch: hostInput().batch }
    if (kind === 'sync') {
      await expect(createAttendanceSyncImportHostV1({ acquireConnection }).commitSyncImportPlanV1(input))
        .rejects.toThrowError('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
    } else {
      await expect(createAttendanceLegacyPlanReservationHostV1({ acquireConnection }).reserveLegacyImportPlanV1({
        ...input, legacyInputFingerprint: '0'.repeat(64),
      })).rejects.toThrowError('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
    }
    expect(acquireConnection).not.toHaveBeenCalled()
  })
  it.each(['synthetic-admin', 'other-active-admin'])('CB02 rejects daily replay of a stored punch command for %s', async (actorId) => {
    const h = replayHost({ punchDetailRequestFingerprint: fingerprintAttendancePunchDetailCommandV1(scope, envelope()) })
    await expect(h.host.commitSyncImportPlanV1({ ...dailyHostInput(), actorId, tokenSubjectUserId: actorId }))
      .rejects.toThrowError('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
    assertReplayBoundary(h, false)
  })
  it('CB02 retains exact punch retry with a new server batch ID', async () => {
    const meta = { punchDetailRequestFingerprint: fingerprintAttendancePunchDetailCommandV1(scope, envelope()) }
    const h = replayHost(meta)
    await expect(h.host.commitSyncImportPlanV1(reboundPunchInput())).resolves.toEqual({
      batchId, imported: 4, processedRows: 4, failedRows: 0, elapsedMs: expect.any(Number),
      engine: 'standard', recordUpsertStrategy: 'values', items: [], itemsTruncated: false,
      skipped: [], csvWarnings: [], groupWarnings: [], meta, idempotent: true,
    })
    assertReplayBoundary(h, true)
  })
  it.each(['actor', 'input'])('CB02 rejects changed punch %s on committed replay', async (change) => {
    const h = replayHost({ punchDetailRequestFingerprint: fingerprintAttendancePunchDetailCommandV1(scope, envelope()) })
    await expect(h.host.commitSyncImportPlanV1(reboundPunchInput(change === 'actor' ? 'other-active-admin' : scope.actorId, change === 'input')))
      .rejects.toThrowError('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
    assertReplayBoundary(h, false)
  })
  it('CB02 preserves ordinary daily replay under legacy posture', async () => {
    const meta = { skippedCount: 1, engine: 'standard', recordUpsertStrategy: 'values' }
    const h = replayHost(meta, 'legacy')
    await expect(h.host.commitSyncImportPlanV1(dailyHostInput())).resolves.toEqual({
      batchId, imported: 3, processedRows: 3, failedRows: 1, elapsedMs: expect.any(Number),
      engine: 'standard', recordUpsertStrategy: 'values', items: [], itemsTruncated: false,
      skipped: [], csvWarnings: [], groupWarnings: [], meta, idempotent: true,
    })
    assertReplayBoundary(h, true)
  })
  it('CB02 rejects punch replay over an ordinary daily batch', async () => {
    const h = replayHost({})
    await expect(h.host.commitSyncImportPlanV1(reboundPunchInput()))
      .rejects.toThrowError('ATTENDANCE_PUNCH_DETAIL_COMMAND_MISMATCH')
    assertReplayBoundary(h, false)
  })
})
