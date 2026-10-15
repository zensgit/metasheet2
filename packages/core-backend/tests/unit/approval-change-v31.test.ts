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
import { decideLeaveDayRecalcV1, type LeaveDayRecalcFactsV1 } from '../../src/attendance/approval-change-day-recalc'
import {
  ATTENDANCE_RECOMPUTE_OBLIGATION_SQL_V1,
  ATTENDANCE_SETTLED_WORK_DATE_SQL_V1,
} from '../../src/attendance/approval-change-settled-period'
import { projectCancelRoundCloseReasonForReadV1 } from '../../src/core/attendance-cancellation-execution-port'
import {
  applyLeaveRevisionCorrectionV1,
  AttendanceRevisionCorrectionBlockedError,
  closeApprovalRoundAsAdminV1,
} from '../../src/attendance/approval-change-revision-writer'
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

  it('the revision writer does not call the old reversal or prior-calculation recompute', () => {
    const source = readFileSync(new URL('../../src/attendance/approval-change-revision-writer.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(source).not.toContain('reverseLeaveBalanceDeduction')
    expect(source).not.toContain('appendRecomputeCalculationV1')
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
    expect(planApprovedLeaveDayRecalcV1({
      activeRecord: true,
      companion: { source: 'published_shift', fingerprint: 'def' },
    })).toEqual({ action: 'use_existing_frame', fingerprint: 'def' })
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
    expect(projectCancelRoundCloseReasonForReadV1('admin_closed')).toBe('admin_closed')
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

describe('day recalculation is planned before any write', () => {
  function scripted(reply: (sql: string) => Array<Record<string, unknown>>) {
    const sqls: string[] = []
    return {
      sqls,
      async query(sql: string) {
        sqls.push(sql)
        return { rows: reply(sql) }
      },
    }
  }

  it('refuses an active row with no companion before inserting a revision or reversing balance', async () => {
    const db = scripted((sql) => (sql.includes('attendance_timezone_context_companions') ? [] : [{ present: 1 }]))
    await expect(applyLeaveRevisionCorrectionV1(db, {
      orgId: 'default',
      userId: 'user-1',
      documentId: 'doc-1',
      revisionId: 'rev-1',
      operationId: 'op-1',
      workDate: '2049-06-02',
      fingerprint: 'fp',
    })).rejects.toBeInstanceOf(AttendanceRevisionCorrectionBlockedError)
    expect(db.sqls.some((sql) => sql.includes('INSERT'))).toBe(false)
  })

  it('records an open obligation for a reused frame and does not rewrite the day row', async () => {
    const db = scripted((sql) => {
      if (sql.includes('attendance_timezone_context_companions')) {
        return [{ frame_snapshot: { identity: { source: 'legacy_repair' }, fingerprint: 'abc' } }]
      }
      if (sql.includes('RETURNING id')) return [{ id: 'rev-row' }]
      if (sql.includes("event_type = 'reverse'")) return []
      if (sql.includes("event_type = 'deduct'")) return []
      return []
    })
    const result = await applyLeaveRevisionCorrectionV1(db, {
      orgId: 'default',
      userId: 'user-1',
      documentId: 'doc-1',
      revisionId: 'rev-1',
      operationId: 'op-1',
      workDate: '2049-06-03',
      fingerprint: 'fp',
    })
    expect(result.plan).toEqual({ action: 'use_legacy_repair_frame', fingerprint: 'abc' })
    expect(result.reversal).toEqual({ reversed: 0, alreadyReversed: false })
    const obligation = db.sqls.find((sql) => sql.includes('attendance_recompute_obligations')) ?? ''
    expect(obligation).toContain("'pending'")
    expect(obligation).toContain('superseded_by IS NULL')
    expect(ATTENDANCE_RECOMPUTE_OBLIGATION_SQL_V1).toContain("status IN ('pending', 'leased', 'failed')")
    expect(db.sqls.some((sql) => /INSERT INTO attendance_records/i.test(sql))).toBe(false)
    expect(db.sqls.some((sql) => /INSERT INTO attendance_timezone_context_companions/i.test(sql))).toBe(false)
    expect(db.sqls.some((sql) => /UPDATE attendance_records/i.test(sql))).toBe(false)
  })

  it('admin close uses the shared pending-round statement and does not touch the business row', async () => {
    const db = scripted(() => [{ id: 'round-1' }])
    const closed = await closeApprovalRoundAsAdminV1(db, 'engine-1')
    expect(closed).toEqual({ id: 'round-1' })
    expect(db.sqls).toEqual([CLOSE_PENDING_APPROVAL_ROUND_SQL_V1])
    expect(CLOSE_PENDING_APPROVAL_ROUND_SQL_V1).toContain("outcome = 'pending'")
    expect(db.sqls[0]).not.toContain('attendance_requests')
  })
})

describe('leave day recalc decides absence only for a finished uncovered workday', () => {
  const base: LeaveDayRecalcFactsV1 = {
    now: new Date('2049-06-04T12:00:00.000Z'),
    shiftEndAt: new Date('2049-06-04T08:00:00.000Z'),
    isWorkday: true,
    hasFrozenFrame: true,
    hasRecord: true,
    projectionOwner: 'legacy_untracked',
    visibilityState: 'active',
    manualEdit: false,
    hasFirstIn: false,
    hasLastOut: false,
    otherCoverage: false,
  }

  it('a finished workday with no punches and no other coverage is absent', () => {
    expect(decideLeaveDayRecalcV1(base)).toEqual({
      action: 'apply', status: 'absent', workMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0,
    })
  })

  it('an open shift and a missing schedule do not become absence', () => {
    expect(decideLeaveDayRecalcV1({
      ...base,
      now: new Date('2049-06-04T07:00:00.000Z'),
    })).toEqual({ action: 'defer', reason: 'shift_open' })
    expect(decideLeaveDayRecalcV1({ ...base, isWorkday: false })).toEqual({
      action: 'apply', status: 'off', workMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0,
    })
    expect(decideLeaveDayRecalcV1({ ...base, hasRecord: false, hasFrozenFrame: false, isWorkday: null })).toEqual({
      action: 'defer', reason: 'schedule_unknown',
    })
  })

  it('punches and other coverage are not rewritten into absence', () => {
    expect(decideLeaveDayRecalcV1({ ...base, hasFirstIn: true, hasLastOut: true }).action).toBe('retain_punches')
    expect(decideLeaveDayRecalcV1({ ...base, otherCoverage: true })).toMatchObject({ action: 'apply', status: 'adjusted' })
    expect(decideLeaveDayRecalcV1({ ...base, hasFirstIn: true })).toMatchObject({ action: 'apply', status: 'partial' })
  })
})

describe('v3.1 acceptance ids that this slice can observe', () => {
  const cases: Array<[string, 'passed' | 'partial' | 'gap', string]> = [
    ['DAY-01', 'passed', 'a finished legacy workday with a frozen frame, no punches, and no other coverage is projected absent in the correction transaction'],
    ['DAY-02', 'passed', 'an open shift stays a pending obligation and the existing row is not marked absent; a rowless day is not given an absence row'],
    ['DAY-03', 'gap', 'days that already have both punches are not recalculated into a new late or early status'],
    ['DAY-04', 'partial', 'a due pending obligation is leased and applied once by consumeOneDueRecomputeObligationV1; a second call finds nothing. No timer is registered'],
    ['DAY-05', 'partial', 'an active row without a companion throws before any write'],
    ['DAY-06', 'partial', 'a successful correction inserts a pending obligation the payroll barrier selects'],
    ['DAY-07', 'partial', 'the projection update and the completed receipt share the caller transaction; a rollback undoes both'],
    ['DAY-08', 'gap', 'payroll and writer lock interleaving is not executed here'],
    ['EXP-01', 'gap', 'deadline equality is unchanged in this slice'],
    ['EXP-02', 'gap', 'post-event successor rounds are not created'],
    ['EXP-03', 'gap', 'no backlog sweep was added'],
    ['EXP-04', 'partial', 'admin close is a single pending-row winner; the other three racers are not executed'],
    ['EXP-05', 'gap', 'crash injection at seat and outbox writes is not executed'],
    ['EXP-06', 'gap', 'external retirement retry is not executed'],
    ['EXP-07', 'gap', 'cross-org sweep isolation is not executed'],
    ['EXP-08', 'gap', 'no load or EXPLAIN evidence'],
    ['EXP-09', 'gap', 'create-versus-close interleaving is not executed in this slice'],
    ['EXP-10', 'gap', 'policy read fault versus off is covered by the reader unit, not by a decision transaction'],
    ['EXP-11', 'gap', 'window refresh against a pending round is not executed'],
    ['EXP-12', 'gap', 'external close outcome_unknown is not executed'],
    ['EXP-13', 'gap', 'in-flight todo cleanup is not executed'],
    ['EXP-14', 'gap', 'old-snapshot negative control is not executed'],
    ['EXP-15', 'gap', 'connection-lifecycle proof is not executed'],
    ['AMD-01', 'gap', 'candidate rejection does not yet keep a stable business identity'],
    ['AMD-02', 'gap', 'field-level revision swap is not executed'],
    ['AMD-03', 'partial', 'a request-id reverse does not short-circuit a later revision reversal'],
    ['AMD-04', 'gap', 'two-session version race is not executed'],
    ['AMD-05', 'gap', 'savepoint failure injection is not executed'],
    ['AMD-06', 'gap', 'stale vote rejection is not executed'],
    ['AMD-07', 'partial', 'missing frozen context refuses before balance or revision writes'],
    ['AMD-08', 'gap', 'cross-org visibility is not executed'],
    ['AMD-09', 'gap', 'responsibility evidence across revisions is not executed'],
    ['AMD-10', 'gap', 'future-to-past revision is not executed'],
    ['AMD-11', 'gap', 'legal content swap of round and engine is not executed'],
    ['AMD-12', 'gap', 'inherited hard deadline is not executed'],
    ['AMD-13', 'gap', 'revision swap versus close race is not executed'],
    ['COR-01', 'partial', 'admin close sets blocked/admin_closed and does not update the business row'],
    ['COR-02', 'gap', 'expired-lot loss and day-record consistency are not both proven'],
    ['COR-03', 'gap', 'in-progress trip truncation is not implemented'],
    ['COR-04', 'partial', 'the route requires attendance:admin and refuses the actor own request'],
    ['COR-05', 'gap', 'responsibility lookup after revision is not executed'],
    ['COR-06', 'gap', 'close-then-failed-correct crash injection is not executed'],
    ['COR-07', 'gap', 'payroll and correction interleaving is not executed'],
    ['COR-08', 'gap', 'day rewrite and notification are omitted, so full correction is not claimed'],
    ['COR-09', 'gap', 'settled-period wait-after-lock proof is not executed'],
  ]

  it('the admin route requires attendance:admin, refuses the actor own request, and checks the settled period inside the lock', () => {
    const source = readFileSync(new URL('../../../../plugins/plugin-attendance/index.cjs', import.meta.url), 'utf8')
    const marker = "'/api/attendance/requests/:id/admin-correction'"
    const at = source.indexOf(marker)
    expect(at).toBeGreaterThan(0)
    const nextRoute = source.indexOf('context.api.http.addRoute', at + marker.length)
    const slice = source.slice(Math.max(0, at - 200), nextRoute === -1 ? at + 8000 : nextRoute)
    expect(slice).toContain("withPermission('attendance:admin'")
    expect(slice).toContain('Admin correction does not apply to your own request')
    expect(slice).toContain('rejectSettledWorkDate')
    expect(slice).toContain('FOR UPDATE')
  })

  it('names each of the 45 cases once and does not mark a gap as passed', () => {
    expect(cases).toHaveLength(45)
    expect(new Set(cases.map(([id]) => id)).size).toBe(45)
    expect(cases.filter(([, status]) => status === 'passed').map(([id]) => id)).toEqual(['DAY-01', 'DAY-02'])
    expect(cases.filter(([, status]) => status === 'partial').map(([id]) => id)).toEqual([
      'DAY-04',
      'DAY-05',
      'DAY-06',
      'DAY-07',
      'EXP-04',
      'AMD-03',
      'AMD-07',
      'COR-01',
      'COR-04',
    ])
    for (const [, status, observation] of cases) {
      expect(observation.length).toBeGreaterThan(0)
      expect(status === 'passed' || status === 'partial' || status === 'gap').toBe(true)
    }
  })
})
