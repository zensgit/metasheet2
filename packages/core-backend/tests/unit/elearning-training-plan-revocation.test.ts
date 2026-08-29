import { describe, expect, it } from 'vitest'

import {
  elearningTrainingPlanRevocationLockKey,
  ElearningTrainingPlanRevocationError,
  revokeElearningTrainingPlanAssignment,
  type ElearningTrainingPlanRevocationDb,
  type ElearningTrainingPlanRevocationQueryable,
} from '../../src/services/elearning-training-plan-revocation'

const ORG = 'org-plan-revoke'
const ACTOR = 'actor-plan-revoke'
const PLAN_ASSIGNMENT = '11111111-1111-4111-8111-111111111111'

type Group = {
  id: string
  orgId: string
  courseCount: number
  memberCount: number
  revokedAt: string | null
  revokedBy: string | null
  revocationReason: string | null
}

type State = {
  group: Group | null
  childMemberCount: number
  updateCount?: number
  queries: string[]
}

function tagOf(sql: string): string | null {
  return /\/\* (elearning-training-plan-revoke:[a-z-]+) \*\//.exec(sql)?.[1] ?? null
}

function createDb(seed: Partial<State> = {}): { db: ElearningTrainingPlanRevocationDb; state: State } {
  const state: State = {
    group: {
      id: PLAN_ASSIGNMENT,
      orgId: ORG,
      courseCount: 2,
      memberCount: 3,
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
    },
    childMemberCount: 6,
    queries: [],
    ...seed,
  }

  const transaction = async <T>(
    handler: (tx: ElearningTrainingPlanRevocationQueryable) => Promise<T>,
  ): Promise<T> => {
    const before = state.group ? { ...state.group } : null
    try {
      return await handler({
        query: async (sql, params = []) => {
          state.queries.push(sql)
          const tag = tagOf(sql)
          if (tag === 'elearning-training-plan-revoke:lock') {
            expect(params).toEqual([
              elearningTrainingPlanRevocationLockKey(ORG, PLAN_ASSIGNMENT),
            ])
            return { rows: [], rowCount: 1 }
          }
          if (tag === 'elearning-training-plan-revoke:load') {
            const group = state.group
            if (!group || group.orgId !== params[0] || group.id !== params[1]) {
              return { rows: [], rowCount: 0 }
            }
            return {
              rows: [{
                id: group.id,
                course_count: group.courseCount,
                member_count: group.memberCount,
                revoked_at: group.revokedAt,
                revocation_reason: group.revocationReason,
              }],
              rowCount: 1,
            }
          }
          if (tag === 'elearning-training-plan-revoke:group') {
            const group = state.group
            if (!group || group.revokedAt != null) return { rows: [], rowCount: 0 }
            group.revokedAt = '2026-08-26T00:00:00.000Z'
            group.revokedBy = String(params[2])
            group.revocationReason = String(params[3])
            return { rows: [{ id: group.id }], rowCount: 1 }
          }
          if (tag === 'elearning-training-plan-revoke:members') {
            return {
              rows: [{
                revoked_count: String(state.updateCount ?? state.childMemberCount),
              }],
              rowCount: 1,
            }
          }
          throw new Error('unexpected SQL')
        },
      })
    } catch (error) {
      state.group = before
      throw error
    }
  }

  return {
    state,
    db: {
      query: async () => ({ rows: [], rowCount: 0 }),
      transaction,
    },
  }
}

function input(reason = 'assigned in error') {
  return {
    orgId: ORG,
    actorId: ACTOR,
    planAssignmentId: PLAN_ASSIGNMENT,
    reason,
  }
}

describe('atomic training-plan revocation', () => {
  it('writes the plan triplet before revoking the complete child-member set', async () => {
    const { db, state } = createDb()
    await expect(revokeElearningTrainingPlanAssignment(db, input())).resolves.toEqual({
      planAssignmentId: PLAN_ASSIGNMENT,
      revoked: true,
      revokedMemberCount: 6,
      duplicate: false,
    })
    expect(state.group).toMatchObject({
      revokedBy: ACTOR,
      revocationReason: 'assigned in error',
    })
    expect(state.queries.map(tagOf)).toEqual([
      'elearning-training-plan-revoke:lock',
      'elearning-training-plan-revoke:load',
      'elearning-training-plan-revoke:group',
      'elearning-training-plan-revoke:members',
    ])
  })

  it('replays the same normalized reason without rewriting members', async () => {
    const { db, state } = createDb({
      group: {
        id: PLAN_ASSIGNMENT,
        orgId: ORG,
        courseCount: 2,
        memberCount: 3,
        revokedAt: '2026-08-26T00:00:00.000Z',
        revokedBy: 'first-actor',
        revocationReason: 'assigned in error',
      },
    })
    await expect(revokeElearningTrainingPlanAssignment(
      db,
      input('  assigned in error  '),
    )).resolves.toEqual({
      planAssignmentId: PLAN_ASSIGNMENT,
      revoked: true,
      revokedMemberCount: 6,
      duplicate: true,
    })
    expect(state.queries.some((sql) => tagOf(sql)?.endsWith(':members'))).toBe(false)
    expect(state.group?.revokedBy).toBe('first-actor')
  })

  it('conflicts on a different replay reason', async () => {
    const { db } = createDb({
      group: {
        id: PLAN_ASSIGNMENT,
        orgId: ORG,
        courseCount: 1,
        memberCount: 1,
        revokedAt: '2026-08-26T00:00:00.000Z',
        revokedBy: ACTOR,
        revocationReason: 'first reason',
      },
    })
    await expect(revokeElearningTrainingPlanAssignment(
      db,
      input('different reason'),
    )).rejects.toEqual(new ElearningTrainingPlanRevocationError('conflict'))
  })

  it('rolls back the group triplet when the child-member count is incomplete', async () => {
    const { db, state } = createDb({ updateCount: 5 })
    await expect(revokeElearningTrainingPlanAssignment(db, input()))
      .rejects.toEqual(new ElearningTrainingPlanRevocationError('unavailable'))
    expect(state.group?.revokedAt).toBeNull()
    expect(state.group?.revokedBy).toBeNull()
    expect(state.group?.revocationReason).toBeNull()
  })

  it('fails closed for invalid identity, missing rows, and corrupt counts', async () => {
    const { db, state } = createDb()
    await expect(revokeElearningTrainingPlanAssignment(db, {
      ...input(),
      planAssignmentId: 'not-a-uuid',
    })).rejects.toEqual(new ElearningTrainingPlanRevocationError('invalid_input'))
    expect(state.queries).toEqual([])

    const missing = createDb({ group: null })
    await expect(revokeElearningTrainingPlanAssignment(missing.db, input()))
      .rejects.toEqual(new ElearningTrainingPlanRevocationError('not_found'))

    const corrupt = createDb({
      group: {
        id: PLAN_ASSIGNMENT,
        orgId: ORG,
        courseCount: 101,
        memberCount: 1,
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
      },
    })
    await expect(revokeElearningTrainingPlanAssignment(corrupt.db, input()))
      .rejects.toEqual(new ElearningTrainingPlanRevocationError('unavailable'))
  })
})
