import { describe, expect, it, vi } from 'vitest'
import { canonicalAttendanceJsonV1 } from '../w4c0-fingerprints'
import type {
  LegacyImportItemPlanV1,
  LegacyImportRecordWritePlanV1,
} from '../w4c3a-legacy-execution-plan'
import {
  applyAttendanceLegacyItemEffectsV1,
  AttendanceLegacyItemEffectError,
} from '../w4c3a-legacy-plan-item-effects'
import type { VerifiedAttendanceLegacyPlanV1 } from '../w4c3a-legacy-plan-worker'

const ORG_ID = 'org-a'
const USER_ID = 'user-a'
const BATCH_ID = '10000000-0000-4000-8000-000000000001'
const APPLY_ITEM_ID = '10000000-0000-4000-8000-000000000002'
const SKIP_ITEM_ID = '10000000-0000-4000-8000-000000000003'
const RECORD_ID = '10000000-0000-4000-8000-000000000004'
const WRITE_ID = '10000000-0000-4000-8000-000000000005'

function recordWrite(
  overrides: Partial<LegacyImportRecordWritePlanV1> = {},
): LegacyImportRecordWritePlanV1 {
  return {
    recordWriteId: WRITE_ID,
    orgId: ORG_ID,
    userId: USER_ID,
    workDate: '2026-07-30',
    sourceOrdinals: [0],
    mergeMode: 'merge',
    firstInAt: null,
    lastOutAt: null,
    workMinutes: null,
    lateMinutes: null,
    earlyLeaveMinutes: null,
    status: null,
    isWorkday: null,
    timezone: 'Asia/Taipei',
    targetRevision: 0,
    existingRecordPreconditionFingerprint:
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    expectedSourceOwnership: null,
    recordId: RECORD_ID,
    compatibilityMetadata: {},
    policySnapshot: {},
    profileSnapshot: {},
    multiPunchSnapshot: {},
    attributionSnapshot: {},
    sourceBatchId: BATCH_ID,
    resultSlots: {},
    ...overrides,
  }
}

function applyItem(
  overrides: Partial<Extract<LegacyImportItemPlanV1, { kind: 'apply' }>> = {},
): Extract<LegacyImportItemPlanV1, { kind: 'apply' }> {
  return {
    kind: 'apply',
    ordinal: 0,
    semanticOrdinal: 0,
    itemId: APPLY_ITEM_ID,
    targetRef: canonicalAttendanceJsonV1([ORG_ID, USER_ID, '2026-07-30']),
    previewSnapshot: { kind: 'apply-preview' },
    recordWriteRef: WRITE_ID,
    ...overrides,
  }
}

function skipItem(
  overrides: Partial<Extract<LegacyImportItemPlanV1, { kind: 'skip' }>> = {},
): Extract<LegacyImportItemPlanV1, { kind: 'skip' }> {
  return {
    kind: 'skip',
    ordinal: 1,
    semanticOrdinal: null,
    itemId: SKIP_ITEM_ID,
    resolvedUserId: 'user-b',
    resolvedWorkDate: '2026-07-31',
    reasonCode: 'invalid_row',
    warnings: [],
    previewSnapshot: { kind: 'skip-preview' },
    ...overrides,
  }
}

function plan(input: {
  items?: readonly LegacyImportItemPlanV1[]
  recordWrites?: readonly LegacyImportRecordWritePlanV1[]
  orgId?: string
  batchId?: string
} = {}): VerifiedAttendanceLegacyPlanV1 {
  return {
    manifest: {
      orgId: input.orgId ?? ORG_ID,
      batchId: input.batchId ?? BATCH_ID,
    },
    chunks: [],
    items: input.items ?? [applyItem(), skipItem()],
    recordWrites: input.recordWrites ?? [recordWrite()],
    groupEffects: [],
  } as unknown as VerifiedAttendanceLegacyPlanV1
}

function queryStub(rows: Array<Record<string, unknown>> = []) {
  const query = vi.fn(async () => ({ rows }))
  return { query }
}

function sqlOf(db: ReturnType<typeof queryStub>): string {
  return String(db.query.mock.calls[0]?.[0] ?? '')
}

function paramsOf(db: ReturnType<typeof queryStub>): unknown[] {
  return (db.query.mock.calls[0]?.[1] ?? []) as unknown[]
}

describe('applyAttendanceLegacyItemEffectsV1', () => {
  it('performs zero SQL for an empty item stream', async () => {
    const db = queryStub()
    await applyAttendanceLegacyItemEffectsV1(
      db,
      plan({ items: [], recordWrites: [] }),
    )
    expect(db.query).not.toHaveBeenCalled()
  })

  it('uses one fixed ordered INSERT and exact frozen column arrays', async () => {
    const db = queryStub([{ id: APPLY_ITEM_ID }, { id: SKIP_ITEM_ID }])
    await applyAttendanceLegacyItemEffectsV1(db, plan())

    expect(db.query).toHaveBeenCalledTimes(1)
    expect(sqlOf(db)).toMatch(/INSERT\s+INTO\s+attendance_import_items/i)
    expect(sqlOf(db)).toMatch(/FROM\s+unnest\(/i)
    expect(sqlOf(db)).toMatch(/ORDER\s+BY\s+input\.ordinal/i)
    expect(sqlOf(db)).not.toMatch(/ON\s+CONFLICT/i)
    expect(paramsOf(db)).toEqual([
      [APPLY_ITEM_ID, SKIP_ITEM_ID],
      [USER_ID, 'user-b'],
      ['2026-07-30', '2026-07-31'],
      [RECORD_ID, null],
      [
        JSON.stringify({ kind: 'apply-preview' }),
        JSON.stringify({ kind: 'skip-preview' }),
      ],
      BATCH_ID,
      ORG_ID,
    ])
  })

  it('fails before SQL when an apply item references no record write', async () => {
    const db = queryStub()
    await expect(
      applyAttendanceLegacyItemEffectsV1(db, plan({ recordWrites: [] })),
    ).rejects.toMatchObject({
      code: 'W4C3A_ITEM_EFFECT_PLAN_MISMATCH',
    })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('fails before SQL on duplicate record-write ids', async () => {
    const db = queryStub()
    await expect(
      applyAttendanceLegacyItemEffectsV1(
        db,
        plan({ recordWrites: [recordWrite(), recordWrite()] }),
      ),
    ).rejects.toBeInstanceOf(AttendanceLegacyItemEffectError)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('fails before SQL on duplicate item ids or non-dense order', async () => {
    const duplicate = skipItem({ itemId: APPLY_ITEM_ID })
    const db = queryStub()
    await expect(
      applyAttendanceLegacyItemEffectsV1(
        db,
        plan({ items: [applyItem(), duplicate] }),
      ),
    ).rejects.toMatchObject({
      code: 'W4C3A_ITEM_EFFECT_PLAN_MISMATCH',
    })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('fails before SQL when targetRef does not match frozen target fields', async () => {
    const db = queryStub()
    await expect(
      applyAttendanceLegacyItemEffectsV1(
        db,
        plan({ items: [applyItem({ targetRef: 'mutated' })] }),
      ),
    ).rejects.toMatchObject({
      code: 'W4C3A_ITEM_EFFECT_PLAN_MISMATCH',
    })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('fails before SQL when the source ordinal is not owned by the write', async () => {
    const db = queryStub()
    await expect(
      applyAttendanceLegacyItemEffectsV1(
        db,
        plan({ recordWrites: [recordWrite({ sourceOrdinals: [1] })] }),
      ),
    ).rejects.toMatchObject({
      code: 'W4C3A_ITEM_EFFECT_PLAN_MISMATCH',
    })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('fails before SQL when write org or batch identity differs from manifest', async () => {
    const db = queryStub()
    await expect(
      applyAttendanceLegacyItemEffectsV1(
        db,
        plan({ recordWrites: [recordWrite({ orgId: 'org-other' })] }),
      ),
    ).rejects.toMatchObject({
      code: 'W4C3A_ITEM_EFFECT_PLAN_MISMATCH',
    })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('fails closed when returned ids are missing, reordered, or changed', async () => {
    for (const rows of [
      [{ id: APPLY_ITEM_ID }],
      [{ id: SKIP_ITEM_ID }, { id: APPLY_ITEM_ID }],
      [{ id: APPLY_ITEM_ID }, { id: RECORD_ID }],
    ]) {
      const db = queryStub(rows)
      await expect(
        applyAttendanceLegacyItemEffectsV1(db, plan()),
      ).rejects.toMatchObject({
        code: 'W4C3A_ITEM_EFFECT_ROW_MISMATCH',
      })
    }
  })
})
