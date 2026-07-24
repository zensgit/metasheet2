import { randomUUID } from 'node:crypto'
import type { QueryResult, QueryResultRow } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #4561 W1 P2 hardening: proves assertTimelineIntegrity is independently
// load-bearing on the READ path, even when the DB EXCLUDE constraint
// (attendance_calc_group_memberships_no_overlap) cannot protect it, such as rows
// written while the constraint was absent, or served from a replica/cache.
// The failure cases must turn RED if assertTimelineIntegrity becomes an immediate
// return (mutation-verified 2026-07-24).

const { clientQueryMock, executedStatements } = vi.hoisted(() => ({
  clientQueryMock: vi.fn(),
  executedStatements: [] as string[],
}))

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(),
  transaction: vi.fn(
    async (callback: (client: { query: typeof clientQueryMock }) => unknown) =>
      callback({ query: clientQueryMock }),
  ),
}))

import {
  AttendanceCalculationGroupMembershipError,
  listAttendanceCalculationGroupMemberships,
  transitionAttendanceCalculationGroupMembership,
} from '../../src/services/AttendanceCalculationGroupMembership'

type Executor = (
  statement: string,
  params?: unknown[],
) => Promise<QueryResult<QueryResultRow>>

const ORG_ID = 'org-corrupt-timeline'
const USER_ID = 'user-corrupt-timeline'
const ACTOR_ID = 'actor-corrupt-timeline'
const GROUP_A = randomUUID()
const GROUP_B = randomUUID()
const GROUP_C = randomUUID()

function membershipRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: randomUUID(),
    org_id: ORG_ID,
    user_id: USER_ID,
    group_id: GROUP_A,
    effective_from: '2026-01-01',
    effective_to: null,
    assigned_by: ACTOR_ID,
    assigned_reason: 'seed',
    assigned_correlation_id: `seed-${randomUUID()}`,
    closed_by: null,
    closed_reason: null,
    closed_correlation_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

// Two rows whose effective intervals overlap ([01-01..06-30] vs [03-01..null]).
// The EXCLUDE constraint would refuse this pair on INSERT, so reaching the read
// path with these rows means the constraint was bypassed or absent, exactly the
// gap assertTimelineIntegrity must close.
const overlappingTimeline = [
  membershipRow({ group_id: GROUP_A, effective_from: '2026-01-01', effective_to: '2026-06-30' }),
  membershipRow({ group_id: GROUP_B, effective_from: '2026-03-01', effective_to: null }),
]

function executorReturning(rows: Record<string, unknown>[]): Executor {
  return (async () => ({ rows })) as unknown as Executor
}

describe('W1 timeline integrity guard without DB EXCLUDE protection (service level)', () => {
  beforeEach(() => {
    executedStatements.length = 0
    clientQueryMock.mockReset()
    clientQueryMock.mockImplementation(async (statement: string) => {
      executedStatements.push(statement)
      if (statement.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (statement.includes('attendance_calculation_group_membership_operations')) {
        return { rows: [] }
      }
      if (statement.includes('FROM attendance_groups')) {
        return { rows: [{ id: GROUP_C }] }
      }
      if (statement.includes('FROM attendance_calculation_group_memberships')) {
        return { rows: overlappingTimeline }
      }
      if (statement.includes('FROM users u')) return { rows: [{ '?column?': 1 }] }
      if (statement.trimStart().startsWith('UPDATE')) return { rows: [], rowCount: 1 }
      if (statement.includes('RETURNING *')) {
        return {
          rows: [
            membershipRow({
              group_id: GROUP_C,
              effective_from: '2026-05-01',
              effective_to: null,
            }),
          ],
        }
      }
      return { rows: [] }
    })
  })

  it('rejects the list read path with the typed corrupt error on overlapping rows', async () => {
    const failure = await listAttendanceCalculationGroupMemberships(
      ORG_ID,
      USER_ID,
      executorReturning(overlappingTimeline),
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AttendanceCalculationGroupMembershipError)
    expect(failure).toMatchObject({
      code: 'ATTENDANCE_CALCULATION_GROUP_TIMELINE_CORRUPT',
      status: 409,
    })
  })

  it('rejects the list read path on an inverted interval (effective_to < effective_from)', async () => {
    const inverted = [
      membershipRow({ effective_from: '2026-02-01', effective_to: '2026-01-15' }),
    ]
    const failure = await listAttendanceCalculationGroupMemberships(
      ORG_ID,
      USER_ID,
      executorReturning(inverted),
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AttendanceCalculationGroupMembershipError)
    expect(failure).toMatchObject({
      code: 'ATTENDANCE_CALCULATION_GROUP_TIMELINE_CORRUPT',
      status: 409,
    })
  })

  it('still serves a contiguous timeline (positive control for the stub path)', async () => {
    const contiguous = [
      membershipRow({ effective_from: '2026-01-01', effective_to: '2026-01-31' }),
      membershipRow({ group_id: GROUP_B, effective_from: '2026-02-01', effective_to: null }),
    ]
    const result = await listAttendanceCalculationGroupMemberships(
      ORG_ID,
      USER_ID,
      executorReturning(contiguous),
    )
    expect(result).toHaveLength(2)
  })

  it('fails the transition closed with the typed corrupt error and writes nothing', async () => {
    const failure = await transitionAttendanceCalculationGroupMembership({
      orgId: ORG_ID,
      userId: USER_ID,
      targetGroupId: GROUP_C,
      // Lands strictly inside the first overlapping interval, so a neutered guard
      // would proceed to close row 1 and INSERT a new membership + operation row.
      effectiveOn: '2026-05-01',
      actorId: ACTOR_ID,
      reason: 'Must refuse to write on top of a corrupt timeline',
      correlationId: `corrupt-timeline-${randomUUID()}`,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AttendanceCalculationGroupMembershipError)
    expect(failure).toMatchObject({
      code: 'ATTENDANCE_CALCULATION_GROUP_TIMELINE_CORRUPT',
      status: 409,
    })

    // No attendance-result write of any kind: no membership close-out UPDATE, no
    // membership INSERT, no idempotency/operation INSERT.
    const writes = executedStatements.filter((statement) =>
      /^\s*(INSERT|UPDATE|DELETE)/i.test(statement),
    )
    expect(writes).toEqual([])
  })
})
