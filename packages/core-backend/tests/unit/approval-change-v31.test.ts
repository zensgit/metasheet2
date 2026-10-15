import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  defaultAttendanceChangePolicyV1,
  interpretAttendanceChangePolicyValueV1,
  readAttendanceChangePolicyV1,
  readAttendanceCorrectionWindowV1,
} from '../../src/attendance/approval-change-policy'
import {
  ApprovalRoundAlreadyPendingError,
  closePendingApprovalRoundFromSweepV1,
  closePendingApprovalRoundV1,
  CLOSE_PENDING_APPROVAL_ROUND_SQL_V1,
  supersedePendingRoundThenInsertV1,
} from '../../src/attendance/approval-change-round-close'
import {
  leaveRevisionReversalSourceIdV1,
  legacyRequestReversalShortCircuitsV1,
  revisionReversalShortCircuitsV1,
} from '../../src/attendance/approval-change-leave-reversal'
import {
  planApprovedLeaveDayRecalcV1,
  recalcWritesCompanionV1,
} from '../../src/attendance/approval-change-legacy-repair'
import { ATTENDANCE_SETTLED_WORK_DATE_SQL_V1 } from '../../src/attendance/approval-change-settled-period'
import { projectCancelRoundCloseReasonForReadV1 } from '../../src/core/attendance-cancellation-execution-port'
import {
  acquireAttendanceCalculationRolloutLockSessionV1,
  releaseAttendanceCalculationRolloutLockSessionV1,
} from '../../src/attendance/w4c0-identity'
import { runAttendanceResultOperationTransactionV1 } from '../../src/attendance/w4c0-operation-registry'
import { parseCanonicalAttendanceRolloutOrgKeyV1 } from '../../src/attendance/w4c0-identity'

const require = createRequire(import.meta.url)

describe('change policy reader is tri-state and does not use the settings cache', () => {
  it('zero rows are the code defaults, and those defaults do not open the after-event path', async () => {
    const read = await readAttendanceChangePolicyV1(async () => [], '11111111-1111-4111-8111-111111111111')
    expect(read).toEqual({ status: 'ready', source: 'code_default', policy: defaultAttendanceChangePolicyV1() })
    if (read.status === 'ready') {
      expect(read.policy.leave).toEqual({ beforeEvent: true, afterEvent: false })
      expect(read.policy.businessTrip).toEqual({ beforeEvent: true, afterEvent: false })
    }
  })

  it('an invalid confirmation mode is off, and a thrown query is a fault', async () => {
    expect(interpretAttendanceChangePolicyValueV1({
      leave: { beforeEvent: true, afterEvent: false },
      businessTrip: { beforeEvent: true, afterEvent: false },
      confirmationMode: 'banana',
    })).toEqual({ status: 'off', reason: 'invalid_enum' })
    const fault = await readAttendanceChangePolicyV1(async () => {
      throw new Error('timeout')
    }, 'default')
    expect(fault).toEqual({ status: 'fault' })
  })

  it('the correction-window reader does not invent a 30-day limit when no row exists', async () => {
    expect(await readAttendanceCorrectionWindowV1(async () => ({ rows: [] }), 'default')).toEqual({ status: 'not_enforced' })
  })

  it('the reader source does not call loadSettings or getSettings', () => {
    const source = readFileSync(new URL('../../src/attendance/approval-change-policy.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(source).not.toMatch(/loadSettings|getSettings/)
  })
})

describe('pending round close has one statement', () => {
  it('the sweep and the action path are the same function, and a second close loses', async () => {
    expect(closePendingApprovalRoundFromSweepV1).toBe(closePendingApprovalRoundV1)
    const calls: string[] = []
    const client = {
      async query(sql: string) {
        calls.push(sql)
        return { rows: calls.length === 1 ? [{ id: 'round-1' }] : [] }
      },
    }
    expect(await closePendingApprovalRoundV1(client, {
      engineInstanceId: 'engine-1',
      outcome: 'blocked',
      blockReason: 'superseded_by_revision',
      policySnapshotAtDecision: '{}',
    })).toEqual({ id: 'round-1' })
    expect(calls[0]).toBe(CLOSE_PENDING_APPROVAL_ROUND_SQL_V1)
    expect(calls[0]).toContain("outcome = 'pending'")
    expect(calls[0]).toContain('RETURNING id')
    expect(await closePendingApprovalRoundV1(client, {
      engineInstanceId: 'engine-1',
      outcome: 'expired',
      blockReason: null,
      policySnapshotAtDecision: null,
    })).toBeNull()
  })

  it('a revision swap closes the old round before inserting, and maps the pending unique violation', async () => {
    const order: string[] = []
    const client = {
      async query(sql: string) {
        order.push(sql)
        return { rows: [{ id: 'old-round' }] }
      },
    }
    await supersedePendingRoundThenInsertV1(client, {
      engineInstanceId: 'engine-1',
      policySnapshotAtDecision: '{}',
      insertPending: async () => {
        order.push('insert')
      },
    })
    expect(order).toEqual([CLOSE_PENDING_APPROVAL_ROUND_SQL_V1, 'insert'])

    const racing = {
      async query() {
        return { rows: [{ id: 'old-round' }] }
      },
    }
    await expect(supersedePendingRoundThenInsertV1(racing, {
      engineInstanceId: 'engine-1',
      policySnapshotAtDecision: '{}',
      insertPending: async () => {
        const error = new Error('duplicate') as Error & { code: string; constraint: string }
        error.code = '23505'
        error.constraint = 'uq_approval_rounds_pending_document'
        throw error
      },
    })).rejects.toBeInstanceOf(ApprovalRoundAlreadyPendingError)
  })
})

describe('leave reversal idempotency is not the request id', () => {
  it('a prior request-id reverse does not short-circuit a different revision operation', () => {
    const requestId = 'request-1'
    const events = [{ sourceId: requestId, eventType: 'reverse' }]
    expect(legacyRequestReversalShortCircuitsV1(events, requestId)).toBe(true)
    const key = leaveRevisionReversalSourceIdV1({
      documentId: requestId,
      revisionId: 'rev-2',
      operationId: 'op-2',
    })
    expect(key).not.toBe(requestId)
    expect(revisionReversalShortCircuitsV1(events, key)).toBe(false)
    expect(revisionReversalShortCircuitsV1([...events, { sourceId: key, eventType: 'reverse' }], key)).toBe(true)
  })

  it('the new helper module does not call reverseLeaveBalanceDeduction', () => {
    const source = readFileSync(new URL('../../src/attendance/approval-change-leave-reversal.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(source).not.toContain('reverseLeaveBalanceDeduction')
  })
})

describe('legacy repair frames are recognized and not backfilled again', () => {
  it('uses the repair frame and refuses a second companion write', () => {
    const plan = planApprovedLeaveDayRecalcV1({
      activeRecord: true,
      companion: { source: 'legacy_repair', fingerprint: 'abc' },
    })
    expect(plan).toEqual({ action: 'use_legacy_repair_frame', fingerprint: 'abc' })
    expect(recalcWritesCompanionV1(plan)).toBe(false)
    expect(planApprovedLeaveDayRecalcV1({ activeRecord: true, companion: null })).toEqual({ action: 'migration_required' })
    expect(planApprovedLeaveDayRecalcV1({ activeRecord: false, companion: null })).toEqual({ action: 'no_record' })
  })
})

describe('close-reason projection accepts the new block reasons', () => {
  it('keeps round_expired and business_blocked, and adds the exact tokens', () => {
    expect(projectCancelRoundCloseReasonForReadV1('round_expired')).toBe('round_expired')
    expect(projectCancelRoundCloseReasonForReadV1('business_blocked:ATTENDANCE_PERIOD_SETTLED')).toBe('business_blocked:ATTENDANCE_PERIOD_SETTLED')
    expect(projectCancelRoundCloseReasonForReadV1('event_started')).toBe('event_started')
    expect(projectCancelRoundCloseReasonForReadV1('superseded_by_revision')).toBe('superseded_by_revision')
    expect(projectCancelRoundCloseReasonForReadV1('please close this')).toBeNull()
  })
})

describe('settled-period SQL is the same string in core and the plugin', () => {
  it('matches the plugin copy', () => {
    const gate = require('../../../../plugins/plugin-attendance/lib/attendance-period-gate.cjs') as {
      ATTENDANCE_SETTLED_WORK_DATE_SQL_V1: string
    }
    expect(gate.ATTENDANCE_SETTLED_WORK_DATE_SQL_V1).toBe(ATTENDANCE_SETTLED_WORK_DATE_SQL_V1)
  })
})

describe('rollout session lock is acquired before BEGIN', () => {
  it('shared mode waits, then the transaction lock takes over, then the body runs', async () => {
    const orgId = '22222222-2222-4222-8222-222222222222'
    parseCanonicalAttendanceRolloutOrgKeyV1(orgId)
    const seen: string[] = []
    const client = {
      async query(sqlText: string) {
        seen.push(sqlText)
        if (sqlText.startsWith('SAVEPOINT ')) {
          const error = new Error('idle') as Error & { code: string }
          error.code = '25P01'
          throw error
        }
        if (sqlText.includes('pg_advisory_unlock_shared')) return { rows: [{ released: true }] }
        return { rows: [] }
      },
    }
    let bodySawLock = false
    await runAttendanceResultOperationTransactionV1(client, async () => {
      bodySawLock = seen.some((sql) => sql.includes('pg_advisory_xact_lock_shared'))
      return 'ok'
    }, { rolloutSnapshotLock: { orgId, mode: 'shared' } })
    const shared = seen.findIndex((sql) => sql.includes('pg_advisory_lock_shared'))
    const begin = seen.findIndex((sql) => sql.includes('BEGIN ISOLATION LEVEL SERIALIZABLE'))
    const xact = seen.findIndex((sql) => sql.includes('pg_advisory_xact_lock_shared'))
    const unlock = seen.findIndex((sql) => sql.includes('pg_advisory_unlock_shared'))
    expect(shared).toBeGreaterThanOrEqual(0)
    expect(shared).toBeLessThan(begin)
    expect(begin).toBeLessThan(xact)
    expect(xact).toBeLessThan(unlock)
    expect(bodySawLock).toBe(true)
    expect(typeof acquireAttendanceCalculationRolloutLockSessionV1).toBe('function')
    expect(typeof releaseAttendanceCalculationRolloutLockSessionV1).toBe('function')
  })
})
