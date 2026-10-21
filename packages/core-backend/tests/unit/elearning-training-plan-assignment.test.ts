import { describe, expect, it } from 'vitest'

import {
  assignElearningTrainingPlan,
  deriveElearningTrainingPlanChildSourceKey,
  ElearningTrainingPlanAssignmentError,
  hashElearningTrainingPlanAssignmentRequest,
  type ElearningTrainingPlanAssignmentDb,
  type ElearningTrainingPlanAssignmentQueryable,
} from '../../src/services/elearning-training-plan-assignment'

const ORG = 'org-plan-assignment'
const ACTOR = 'admin-1'
const PLAN_ID = '10000000-0000-4000-8000-000000000001'
const PLAN_VERSION_ID = '10000000-0000-4000-8000-000000000002'
const ITEM_A = '10000000-0000-4000-8000-000000000003'
const ITEM_B = '10000000-0000-4000-8000-000000000004'
const COURSE_A = '10000000-0000-4000-8000-000000000005'
const COURSE_B = '10000000-0000-4000-8000-000000000006'
const GROUP_ID = '10000000-0000-4000-8000-000000000007'
const RULES = [{
  subjectType: 'user' as const,
  subjectRef: 'learner-1',
  includeChildren: false as const,
}]

type QueryResult = {
  rows: Array<Record<string, unknown>>
  rowCount: number | null
}

class ScriptedDb implements ElearningTrainingPlanAssignmentDb {
  readonly sql: string[] = []

  constructor(
    private readonly respond: (
      sql: string,
      params: unknown[] | undefined,
    ) => QueryResult,
  ) {}

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.sql.push(sql)
    return this.respond(sql, params)
  }

  async transaction<T>(
    handler: (tx: ElearningTrainingPlanAssignmentQueryable) => Promise<T>,
  ): Promise<T> {
    return handler({ query: (sql, params) => this.query(sql, params) })
  }
}

function request(overrides: Partial<Parameters<typeof assignElearningTrainingPlan>[1]> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    planId: PLAN_ID,
    sourceKey: 'plan-run-1',
    deadline: null,
    rules: RULES,
    ...overrides,
  }
}

function successResponder(sql: string): QueryResult {
  if (sql.includes(':load-existing')) return { rows: [], rowCount: 0 }
  if (sql.includes(':lock-plan-version')) {
    return { rows: [{ status: 'published' }], rowCount: 1 }
  }
  if (sql.includes(':lock-plan')) {
    return {
      rows: [{ status: 'active', active_version_id: PLAN_VERSION_ID }],
      rowCount: 1,
    }
  }
  if (sql.includes(':lock-items')) {
    return {
      rows: [
        {
          item_id: ITEM_A,
          course_version_id: COURSE_A,
          position: 1,
          course_status: 'active',
          version_status: 'published',
        },
        {
          item_id: ITEM_B,
          course_version_id: COURSE_B,
          position: 2,
          course_status: 'active',
          version_status: 'published',
        },
      ],
      rowCount: 2,
    }
  }
  if (sql.includes('elearning-audience:validate-users')) {
    return { rows: [{ id: 'learner-1' }], rowCount: 1 }
  }
  if (sql.includes('elearning-audience:resolve-membership')) {
    return {
      rows: [{ rule_key: '__member__', user_id: 'learner-1' }],
      rowCount: 1,
    }
  }
  if (sql.includes(':lock-members')) {
    return { rows: [{ id: 'learner-1' }], rowCount: 1 }
  }
  if (sql.includes(':insert-members')) return { rows: [], rowCount: 1 }
  return { rows: [], rowCount: 1 }
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningTrainingPlanAssignmentError)
  expect((error as ElearningTrainingPlanAssignmentError).code).toBe(code)
}

describe('atomic training-plan assignment service', () => {
  it('resolves once and creates one assignment/member/link set per pinned item', async () => {
    const db = new ScriptedDb(successResponder)
    const result = await assignElearningTrainingPlan(db, request())

    expect(result).toEqual({
      planAssignmentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      planVersionId: PLAN_VERSION_ID,
      assignmentCount: 2,
      memberCount: 1,
      duplicate: false,
    })
    expect(db.sql.filter((sql) => sql.includes('resolve-membership'))).toHaveLength(1)
    expect(db.sql.filter((sql) => sql.includes(':lock */'))).toHaveLength(1)
    const itemLock = db.sql.find((sql) => sql.includes(':lock-items'))
    expect(itemLock).toMatch(/FOR SHARE OF item, course_version, course/)
    expect(db.sql.filter((sql) => sql.includes(':insert-group'))).toHaveLength(1)
    expect(db.sql.filter((sql) => sql.includes(':insert-assignment'))).toHaveLength(2)
    expect(db.sql.filter((sql) => sql.includes(':insert-members'))).toHaveLength(2)
    expect(db.sql.filter((sql) => sql.includes(':insert-link'))).toHaveLength(2)
  })

  it('replays from the frozen group before reading plan or audience state', async () => {
    const requestHash = hashElearningTrainingPlanAssignmentRequest({
      planId: PLAN_ID,
      deadline: null,
      rules: RULES,
    })
    const db = new ScriptedDb((sql) => {
      if (sql.includes(':load-existing')) {
        return {
          rows: [{
            id: GROUP_ID,
            training_plan_version_id: PLAN_VERSION_ID,
            request_hash: requestHash,
            request_hash_version: 1,
            target_snapshot: RULES,
            course_count: 2,
            member_count: 1,
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 1 }
    })

    await expect(assignElearningTrainingPlan(db, request())).resolves.toEqual({
      planAssignmentId: GROUP_ID,
      planVersionId: PLAN_VERSION_ID,
      assignmentCount: 2,
      memberCount: 1,
      duplicate: true,
    })
    expect(db.sql.some((sql) => sql.includes(':lock-plan'))).toBe(false)
    expect(db.sql.some((sql) => sql.includes('elearning-audience:'))).toBe(false)
  })

  it('rejects changed payload under the same source key without resolving again', async () => {
    const originalHash = hashElearningTrainingPlanAssignmentRequest({
      planId: PLAN_ID,
      deadline: null,
      rules: RULES,
    })
    const db = new ScriptedDb((sql) => ({
      rows: sql.includes(':load-existing')
        ? [{
            id: GROUP_ID,
            training_plan_version_id: PLAN_VERSION_ID,
            request_hash: originalHash,
            request_hash_version: 1,
            target_snapshot: RULES,
            course_count: 2,
            member_count: 1,
          }]
        : [],
      rowCount: 1,
    }))

    await assignElearningTrainingPlan(
      db,
      request({ deadline: '2030-01-01T00:00:00.000Z' }),
    ).then(
      () => { throw new Error('expected conflict') },
      (error) => expectCode(error, 'conflict'),
    )
    expect(db.sql.some((sql) => sql.includes('elearning-audience:'))).toBe(false)
  })

  it('rejects archived plans and unavailable course heads before audience resolution', async () => {
    const archived = new ScriptedDb((sql) => {
      if (sql.includes(':load-existing')) return { rows: [], rowCount: 0 }
      if (sql.includes(':lock-plan')) {
        return {
          rows: [{ status: 'archived', active_version_id: PLAN_VERSION_ID }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
    await assignElearningTrainingPlan(archived, request()).then(
      () => { throw new Error('expected plan_unavailable') },
      (error) => expectCode(error, 'plan_unavailable'),
    )

    const unavailableCourse = new ScriptedDb((sql) => {
      const result = successResponder(sql)
      if (sql.includes(':lock-items')) {
        result.rows[1].course_status = 'archived'
      }
      return result
    })
    await assignElearningTrainingPlan(unavailableCourse, request()).then(
      () => { throw new Error('expected course_unavailable') },
      (error) => expectCode(error, 'course_unavailable'),
    )
    expect(unavailableCourse.sql.some((sql) => sql.includes('elearning-audience:'))).toBe(false)
  })

  it('derives stable domain-versioned child keys without time or attempt inputs', () => {
    const input = {
      orgId: ORG,
      parentSourceKey: 'plan-run-1',
      planVersionId: PLAN_VERSION_ID,
      planItemId: ITEM_A,
    }
    const first = deriveElearningTrainingPlanChildSourceKey(input)
    expect(first).toBe(deriveElearningTrainingPlanChildSourceKey(input))
    expect(first).toMatch(/^elearning-plan-item-v1:[a-f0-9]{64}$/)
    expect(deriveElearningTrainingPlanChildSourceKey({
      ...input,
      planItemId: ITEM_B,
    })).not.toBe(first)
  })

  it('keeps the bounded 100-course by 10,000-member envelope in one transaction', async () => {
    const members = Array.from({ length: 10_000 }, (_, index) =>
      `scale-member-${String(index + 1).padStart(5, '0')}`)
    const items = Array.from({ length: 100 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, '0')
      return {
        item_id: `30000000-0000-4000-8000-${suffix}`,
        course_version_id: `40000000-0000-4000-8000-${suffix}`,
        position: index + 1,
        course_status: 'active',
        version_status: 'published',
      }
    })
    const scaleDb = new ScriptedDb((sql) => {
      if (sql.includes(':load-existing')) return { rows: [], rowCount: 0 }
      if (sql.includes(':lock-plan-version')) {
        return { rows: [{ status: 'published' }], rowCount: 1 }
      }
      if (sql.includes(':lock-plan')) {
        return {
          rows: [{ status: 'active', active_version_id: PLAN_VERSION_ID }],
          rowCount: 1,
        }
      }
      if (sql.includes(':lock-items')) return { rows: items, rowCount: items.length }
      if (sql.includes('elearning-audience:resolve-membership')) {
        return {
          rows: members.map((user_id) => ({ rule_key: '__member__', user_id })),
          rowCount: members.length,
        }
      }
      if (sql.includes(':lock-members')) {
        return { rows: members.map((id) => ({ id })), rowCount: members.length }
      }
      if (sql.includes(':insert-members')) return { rows: [], rowCount: members.length }
      return { rows: [], rowCount: 1 }
    })

    await expect(assignElearningTrainingPlan(scaleDb, request({
      sourceKey: 'scale-envelope',
      rules: [{ subjectType: 'all' }],
    }))).resolves.toMatchObject({
      assignmentCount: 100,
      memberCount: 10_000,
      duplicate: false,
    })
    expect(scaleDb.sql.filter((sql) => sql.includes('resolve-membership'))).toHaveLength(1)
    expect(scaleDb.sql.filter((sql) => sql.includes(':insert-assignment'))).toHaveLength(100)
    expect(scaleDb.sql.filter((sql) => sql.includes(':insert-members'))).toHaveLength(100)
    expect(scaleDb.sql.filter((sql) => sql.includes(':insert-link'))).toHaveLength(100)
  })

  it('fails closed for invalid identity, source, deadline, and unsupported role rules', async () => {
    const db = new ScriptedDb(() => ({ rows: [], rowCount: 0 }))
    const cases: Array<[
      Parameters<typeof assignElearningTrainingPlan>[1],
      'invalid_input' | 'unsupported_subject',
    ]> = [
      [request({ orgId: ' ' }), 'invalid_input'],
      [request({ planId: 'not-a-uuid' }), 'invalid_input'],
      [request({ sourceKey: '' }), 'invalid_input'],
      [request({ deadline: 'not-a-date' }), 'invalid_input'],
      [request({ rules: [{ subjectType: 'role', subjectRef: 'admin' }] }), 'unsupported_subject'],
    ]
    for (const [input, code] of cases) {
      await assignElearningTrainingPlan(db, input).then(
        () => { throw new Error('expected invalid_input') },
        (error) => expectCode(error, code),
      )
    }
    expect(db.sql).toEqual([])
  })
})
