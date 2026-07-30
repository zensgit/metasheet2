import { describe, expect, it, vi } from 'vitest'
import {
  LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
  type LegacyImportRecordWritePlanV1,
} from '../w4c3a-legacy-execution-plan'
import {
  applyAttendanceLegacyRecordEffectsV1,
  AttendanceLegacyRecordEffectError,
} from '../w4c3a-legacy-plan-record-effects'
import type { VerifiedAttendanceLegacyPlanV1 } from '../w4c3a-legacy-plan-worker'

const ORG_ID = 'org-a'
const USER_ID = 'user-a'
const RECORD_ID = '10000000-0000-4000-8000-000000000001'
const MISSING_RECORD_ID = '10000000-0000-4000-8000-000000000004'
const BATCH_ID = '10000000-0000-4000-8000-000000000002'
const WRITE_ID = '10000000-0000-4000-8000-000000000003'
const EXISTING_FINGERPRINT =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const COMPAT_META = Object.freeze({
  allowlisted: true,
  source: 'import',
  marker: 'compatibility-only',
})
const POLICY_SNAPSHOT = Object.freeze({ kind: 'policy', value: 'must-not-write' })
const PROFILE_SNAPSHOT = Object.freeze({ kind: 'profile', value: 'must-not-write' })
const MULTI_PUNCH_SNAPSHOT = Object.freeze({ kind: 'multi', value: 'must-not-write' })
const ATTRIBUTION_SNAPSHOT = Object.freeze({
  kind: 'attribution',
  value: 'must-not-write',
})

function existingWrite(
  overrides: Partial<LegacyImportRecordWritePlanV1> = {},
): LegacyImportRecordWritePlanV1 {
  return {
    recordWriteId: WRITE_ID,
    orgId: ORG_ID,
    userId: USER_ID,
    workDate: '2026-07-30',
    sourceOrdinals: [0],
    mergeMode: 'merge',
    firstInAt: '2026-07-30T01:00:00.000Z',
    lastOutAt: '2026-07-30T09:00:00.000Z',
    workMinutes: 480,
    lateMinutes: 5,
    earlyLeaveMinutes: 0,
    status: 'normal',
    isWorkday: true,
    timezone: 'Asia/Taipei',
    targetRevision: 4,
    existingRecordPreconditionFingerprint: EXISTING_FINGERPRINT,
    expectedSourceOwnership: BATCH_ID,
    recordId: RECORD_ID,
    compatibilityMetadata: COMPAT_META,
    policySnapshot: POLICY_SNAPSHOT,
    profileSnapshot: PROFILE_SNAPSHOT,
    multiPunchSnapshot: MULTI_PUNCH_SNAPSHOT,
    attributionSnapshot: ATTRIBUTION_SNAPSHOT,
    sourceBatchId: BATCH_ID,
    resultSlots: {},
    ...overrides,
  }
}

function missingWrite(
  overrides: Partial<LegacyImportRecordWritePlanV1> = {},
): LegacyImportRecordWritePlanV1 {
  return existingWrite({
    targetRevision: 0,
    existingRecordPreconditionFingerprint:
      LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
    expectedSourceOwnership: null,
    recordId: MISSING_RECORD_ID,
    ...overrides,
  })
}

function plan(
  recordWrites: readonly LegacyImportRecordWritePlanV1[],
): VerifiedAttendanceLegacyPlanV1 {
  return {
    manifest: {},
    chunks: [],
    items: [],
    recordWrites,
    groupEffects: [],
  } as unknown as VerifiedAttendanceLegacyPlanV1
}

function queryStub(rowsByCall: Array<Array<Record<string, unknown>>> = []) {
  const query = vi.fn(async () => ({ rows: rowsByCall.shift() ?? [] }))
  return { query }
}

function sqlOf(call: unknown): string {
  return String((call as unknown[])?.[0] ?? '')
}

function paramsOf(call: unknown): unknown[] {
  return ((call as unknown[])?.[1] ?? []) as unknown[]
}

describe('applyAttendanceLegacyRecordEffectsV1', () => {
  it('performs zero SQL for empty recordWrites', async () => {
    const db = queryStub()
    await applyAttendanceLegacyRecordEffectsV1(db, plan([]))
    expect(db.query).not.toHaveBeenCalled()
  })

  it('UPDATEs an existing branch with full identity predicates and frozen fields', async () => {
    const write = existingWrite()
    const db = queryStub([[{ id: RECORD_ID }]])
    await applyAttendanceLegacyRecordEffectsV1(db, plan([write]))

    expect(db.query).toHaveBeenCalledTimes(1)
    const sql = sqlOf(db.query.mock.calls[0])
    const params = paramsOf(db.query.mock.calls[0])

    expect(sql).toMatch(/UPDATE\s+attendance_records/i)
    expect(sql).not.toMatch(/\bINSERT\b/i)
    expect(sql).not.toMatch(/ON\s+CONFLICT/i)
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1::uuid/i)
    expect(sql).toMatch(/org_id\s*=\s*\$2/)
    expect(sql).toMatch(/user_id\s*=\s*\$3/)
    expect(sql).toMatch(/work_date\s*=\s*\$4::date/)
    expect(sql).toMatch(/RETURNING\s+id::text\s+AS\s+id/i)

    expect(params).toEqual([
      RECORD_ID,
      ORG_ID,
      USER_ID,
      '2026-07-30',
      'Asia/Taipei',
      '2026-07-30T01:00:00.000Z',
      '2026-07-30T09:00:00.000Z',
      480,
      5,
      0,
      'normal',
      true,
      JSON.stringify(COMPAT_META),
      BATCH_ID,
    ])
  })

  it('INSERTs a missing branch with the server-minted id and no ON CONFLICT', async () => {
    const write = missingWrite()
    const db = queryStub([[{ id: MISSING_RECORD_ID }]])
    await applyAttendanceLegacyRecordEffectsV1(db, plan([write]))

    expect(db.query).toHaveBeenCalledTimes(1)
    const sql = sqlOf(db.query.mock.calls[0])
    const params = paramsOf(db.query.mock.calls[0])

    expect(sql).toMatch(/INSERT\s+INTO\s+attendance_records/i)
    expect(sql).not.toMatch(/\bUPDATE\b/i)
    expect(sql).not.toMatch(/ON\s+CONFLICT/i)
    expect(sql).toMatch(/\(id,\s*user_id,\s*org_id,\s*work_date/i)
    expect(sql).toMatch(/RETURNING\s+id::text\s+AS\s+id/i)

    expect(params[0]).toBe(MISSING_RECORD_ID)
    expect(params).toEqual([
      MISSING_RECORD_ID,
      USER_ID,
      ORG_ID,
      '2026-07-30',
      'Asia/Taipei',
      '2026-07-30T01:00:00.000Z',
      '2026-07-30T09:00:00.000Z',
      480,
      5,
      0,
      'normal',
      true,
      JSON.stringify(COMPAT_META),
      BATCH_ID,
    ])
  })

  it('kills using UPDATE for a missing branch', async () => {
    const db = queryStub([[{ id: MISSING_RECORD_ID }]])
    await applyAttendanceLegacyRecordEffectsV1(db, plan([missingWrite()]))
    const sql = sqlOf(db.query.mock.calls[0])
    expect(sql).not.toMatch(/\bUPDATE\b/i)
    expect(sql).toMatch(/\bINSERT\b/i)
  })

  it('kills INSERT/UPSERT for an existing branch', async () => {
    const db = queryStub([[{ id: RECORD_ID }]])
    await applyAttendanceLegacyRecordEffectsV1(db, plan([existingWrite()]))
    const sql = sqlOf(db.query.mock.calls[0])
    expect(sql).not.toMatch(/\bINSERT\b/i)
    expect(sql).not.toMatch(/ON\s+CONFLICT/i)
    expect(sql).toMatch(/\bUPDATE\b/i)
  })

  it('kills dropping one identity predicate from the existing UPDATE', async () => {
    const db = queryStub([[{ id: RECORD_ID }]])
    await applyAttendanceLegacyRecordEffectsV1(db, plan([existingWrite()]))
    const sql = sqlOf(db.query.mock.calls[0])
    const where = sql.slice(sql.toUpperCase().indexOf('WHERE'))

    expect(where).toMatch(/\bid\s*=\s*\$1::uuid\b/i)
    expect(where).toMatch(/\borg_id\s*=\s*\$2\b/)
    expect(where).toMatch(/\buser_id\s*=\s*\$3\b/)
    expect(where).toMatch(/\bwork_date\s*=\s*\$4::date\b/)

    // Each identity bind is present once in WHERE — dropping any fails this suite.
    for (const token of ['$1', '$2', '$3', '$4']) {
      expect(where.split(token).length - 1).toBeGreaterThanOrEqual(1)
    }
  })

  it('kills replacing a frozen parameter with a live/default value', async () => {
    const write = existingWrite({
      timezone: 'Asia/Shanghai',
      workMinutes: 420,
      status: 'late',
      isWorkday: false,
      firstInAt: null,
      lastOutAt: null,
    })
    const db = queryStub([[{ id: RECORD_ID }]])
    await applyAttendanceLegacyRecordEffectsV1(db, plan([write]))
    const params = paramsOf(db.query.mock.calls[0])

    expect(params[4]).toBe('Asia/Shanghai')
    expect(params[4]).not.toBe('UTC')
    expect(params[5]).toBeNull()
    expect(params[6]).toBeNull()
    expect(params[7]).toBe(420)
    expect(params[10]).toBe('late')
    expect(params[11]).toBe(false)
    // Identity + frozen bindings stay exact; no default substitution.
    expect(params).toEqual([
      RECORD_ID,
      ORG_ID,
      USER_ID,
      '2026-07-30',
      'Asia/Shanghai',
      null,
      null,
      420,
      5,
      0,
      'late',
      false,
      JSON.stringify(COMPAT_META),
      BATCH_ID,
    ])
  })

  it('fails closed on zero-row DML through one typed error', async () => {
    const db = queryStub([[]])
    await expect(
      applyAttendanceLegacyRecordEffectsV1(db, plan([existingWrite()])),
    ).rejects.toBeInstanceOf(AttendanceLegacyRecordEffectError)
    await expect(
      applyAttendanceLegacyRecordEffectsV1(db, plan([existingWrite()])),
    ).rejects.toMatchObject({
      name: 'AttendanceLegacyRecordEffectError',
      code: 'W4C3A_RECORD_EFFECT_ROW_MISMATCH',
    })
  })

  it('fails closed when RETURNING yields the wrong id', async () => {
    const db = queryStub([[{ id: '00000000-0000-4000-8000-000000000099' }]])
    await expect(
      applyAttendanceLegacyRecordEffectsV1(db, plan([missingWrite()])),
    ).rejects.toMatchObject({
      code: 'W4C3A_RECORD_EFFECT_ROW_MISMATCH',
    })
  })

  it('kills reading compatibility snapshots instead of compatibilityMetadata', async () => {
    const write = existingWrite({
      compatibilityMetadata: { keep: 'compat' },
      policySnapshot: { keep: 'policy' },
      profileSnapshot: { keep: 'profile' },
      multiPunchSnapshot: { keep: 'multi' },
      attributionSnapshot: { keep: 'attr' },
    })
    const db = queryStub([[{ id: RECORD_ID }]])
    await applyAttendanceLegacyRecordEffectsV1(db, plan([write]))
    const params = paramsOf(db.query.mock.calls[0])
    const metaJson = params[12]

    expect(metaJson).toBe(JSON.stringify({ keep: 'compat' }))
    expect(metaJson).not.toBe(JSON.stringify({ keep: 'policy' }))
    expect(metaJson).not.toBe(JSON.stringify({ keep: 'profile' }))
    expect(metaJson).not.toBe(JSON.stringify({ keep: 'multi' }))
    expect(metaJson).not.toBe(JSON.stringify({ keep: 'attr' }))
    expect(JSON.stringify(params)).not.toContain('policy')
    expect(JSON.stringify(params)).not.toContain('profile')
    expect(JSON.stringify(params)).not.toContain('multi')
    expect(JSON.stringify(params)).not.toContain('attr')
  })

  it('applies mixed existing then missing writes in plan order', async () => {
    const writes = [existingWrite(), missingWrite()]
    const db = queryStub([[{ id: RECORD_ID }], [{ id: MISSING_RECORD_ID }]])
    await applyAttendanceLegacyRecordEffectsV1(db, plan(writes))

    expect(db.query).toHaveBeenCalledTimes(2)
    expect(sqlOf(db.query.mock.calls[0])).toMatch(/\bUPDATE\b/i)
    expect(sqlOf(db.query.mock.calls[1])).toMatch(/\bINSERT\b/i)
    expect(paramsOf(db.query.mock.calls[0])[0]).toBe(RECORD_ID)
    expect(paramsOf(db.query.mock.calls[1])[0]).toBe(MISSING_RECORD_ID)
  })
})
