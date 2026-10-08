/**
 * W4C-2 P1-2 (#4556) — unit gates for the per-user outbox enqueue surface's NEW
 * behavior (w4c0-operation-registry.ts, amendment sections 1.4/1.4.1): writing
 * `identity_kind='operation'` and rejecting the two run-level kinds even though they
 * are now members of the eight-member closed set. These are TS-boundary legs of gate 1
 * that the real-DB suites only exercise via raw SQL against the DB CHECK, not via this
 * function itself — this file closes that gap with a stubbed transaction (no live DB).
 */
import { describe, expect, it } from 'vitest'
import {
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  type AttendanceW4TransactionClientV1,
  type ResolvedSegmentCalculationPostureV1,
} from '../w4c0-identity'
import { enqueueAttendanceResultEventOutboxV1 } from '../w4c0-operation-registry'
import { enqueueAttendanceScheduledRunEventOutboxV1 } from '../w4c2-scheduled-run'

const ORG = '55555555-5555-4555-8555-555555555555'
const DIRECT_ID = '66666666-6666-4666-8666-666666666666'
const HEX64_A = 'a'.repeat(64)

function stubTrx(rows: Array<Record<string, unknown>> = []): AttendanceW4TransactionClientV1 & {
  calls: Array<{ sqlText: string; params: unknown[] }>
} {
  const calls: Array<{ sqlText: string; params: unknown[] }> = []
  return {
    calls,
    async query(sqlText: string, params: unknown[] = []) {
      calls.push({ sqlText, params })
      if (sqlText.startsWith('SELECT state, scope FROM attendance_calculation_rollout_state')) {
        return { rows }
      }
      return { rows: [] }
    },
  }
}

function noQueryTrx(): AttendanceW4TransactionClientV1 {
  return {
    async query() {
      throw new Error('UNEXPECTED_SQL: this trx must never be queried on a rejection path')
    },
  }
}

// Minimal local reimplementation of resolveSegmentCalculationPosture's shape for a
// legacy-row-absent org (writePosture: 'shadow' requires capability+allowlist, which is
// env-gated — using the ALREADY-published resolver keeps this test honest rather than
// hand-rolling a posture witness bypassing the real resolver's own door).
import { resolveSegmentCalculationPosture } from '../w4c0-identity'

async function shadowOrgIdentity(): Promise<ReturnType<typeof createVerifiedAttendanceOrgIdentityV1>> {
  const priorEnv = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ORG
  try {
    const trx = stubTrx([{ state: 'shadow', scope: 'synthetic_staging' }])
    const posture: ResolvedSegmentCalculationPostureV1 = await resolveSegmentCalculationPosture(trx, ORG)
    return createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG, posture })
  } finally {
    if (priorEnv === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorEnv
  }
}

describe('enqueueAttendanceResultEventOutboxV1 — W4C-2 amendment section 1.4/1.4.1 new behavior', () => {
  it('rejects both run-level kinds even though they are members of the (now eight-member) closed set — BEFORE any SQL', async () => {
    const org = await shadowOrgIdentity()
    const identity = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'live_punch',
      source: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID },
    })
    const trx = noQueryTrx()
    for (const runLevelKind of ['attendance.absence.generated', 'attendance.work_date.review_required'] as const) {
      await expect(
        enqueueAttendanceResultEventOutboxV1(trx, identity, [
          { eventKind: runLevelKind, payload: { total: 0 }, payloadSchemaVersion: 1, businessKeyFingerprint: HEX64_A },
        ]),
      ).rejects.toMatchObject({ code: 'W4C0_OUTBOX_EVENT_KIND_INVALID' })
    }
    // A per-user kind on the SAME identity still succeeds (the rejection is scoped to
    // the two run-level kinds, not a blanket regression).
    const okTrx = stubTrx()
    await enqueueAttendanceResultEventOutboxV1(okTrx, identity, [
      { eventKind: 'attendance.punched', payload: { v: 1 }, payloadSchemaVersion: 1, businessKeyFingerprint: HEX64_A },
    ])
    expect(okTrx.calls.some((c) => c.sqlText.includes('INSERT INTO attendance_result_event_outbox'))).toBe(true)
  })

  it('writes identity_kind=\'operation\' on every insert (section 1.4)', async () => {
    const org = await shadowOrgIdentity()
    const identity = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'live_punch',
      source: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID },
    })
    const trx = stubTrx()
    await enqueueAttendanceResultEventOutboxV1(trx, identity, [
      { eventKind: 'attendance.punched', payload: { v: 1 }, payloadSchemaVersion: 1, businessKeyFingerprint: HEX64_A },
    ])
    const insertCall = trx.calls.find((c) => c.sqlText.includes('INSERT INTO attendance_result_event_outbox'))
    expect(insertCall).toBeDefined()
    expect(insertCall?.sqlText).toContain('identity_kind')
    expect(insertCall?.sqlText).toContain("'operation'")
  })

  it('cross-witness-type isolation: a REAL operation identity is rejected by the run-scoped enqueue surface', async () => {
    const org = await shadowOrgIdentity()
    const operationIdentity = createVerifiedAttendanceOperationIdentityV1({
      org,
      kind: 'item',
      entrypoint: 'live_punch',
      source: { sourceKind: 'direct_live_punch', clientOperationId: DIRECT_ID },
    })
    const trx = noQueryTrx()
    await expect(
      enqueueAttendanceScheduledRunEventOutboxV1(trx, operationIdentity, [
        {
          eventKind: 'attendance.absence.generated',
          payload: { total: 0 },
          payloadSchemaVersion: 1,
          businessKeyFingerprint: HEX64_A,
        },
      ]),
    ).rejects.toMatchObject({ code: 'W4C2_SCHEDULED_RUN_WITNESS_REQUIRED' })
  })
})
