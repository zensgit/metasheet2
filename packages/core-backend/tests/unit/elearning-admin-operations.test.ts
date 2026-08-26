import { describe, expect, it } from 'vitest'

import {
  assignElearningDirectAuthorized,
  assignElearningTrainingPlanAuthorized,
  listElearningAssignmentProgressAuthorized,
  setElearningCourseScopeAuthorized,
  type ElearningAdminOperationDb,
  type ElearningAdminOperationQueryable,
} from '../../src/services/elearning-admin-operations'
import {
  elearningAdminScopeLockKey,
  ElearningAdminAccessError,
  elearningObjectAclLockKey,
} from '../../src/services/elearning-admin-access'

const ORG = 'org-admin-operations'
const ACTOR = 'actor-admin-operations'
const OWNER = 'owner-admin-operations'
const TARGET = 'target-admin-operations'
const COURSE = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'
const ASSIGNMENT = '33333333-3333-4333-8333-333333333333'
const PLAN = '44444444-4444-4444-8444-444444444444'

function result(
  rows: Array<Record<string, unknown>> = [],
  rowCount = rows.length,
) {
  return { rows, rowCount }
}

function marker(sql: string): string | undefined {
  return sql.match(/\/\* ([^*]+) \*\//)?.[1]
}

class ScriptDb implements ElearningAdminOperationDb {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(
    private readonly handler: (
      sql: string,
      params?: unknown[],
    ) => ReturnType<typeof result>,
  ) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params })
    return this.handler(sql, params)
  }

  async transaction<T>(
    handler: (tx: ElearningAdminOperationQueryable) => Promise<T>,
  ): Promise<T> {
    return handler(this)
  }
}

function authorizationDb(input: {
  objectAction?: boolean
  coveredTarget?: boolean
  planChild?: boolean
} = {}): ScriptDb {
  return new ScriptDb((sql) => {
    switch (marker(sql)) {
      case 'elearning-admin-operations:repeatable-read':
      case 'elearning-admin-access:operation-lock':
        return result([], 1)
      case 'elearning-admin-operations:course-by-version':
        return result([{ course_id: COURSE }])
      case 'elearning-admin-operations:assignment-object':
        return result([{
          course_id: COURSE,
          training_plan_id: input.planChild ? PLAN : null,
          user_id: null,
          member_user_ids: [TARGET],
        }])
      case 'elearning-admin-access:active-membership':
        return result([{ '?column?': 1 }])
      case 'elearning-admin-access:load-object':
        return result([{ created_by: OWNER }])
      case 'elearning-admin-access:object-action':
        return input.objectAction === false ? result() : result([{ '?column?': 1 }])
      case 'elearning-admin-access:user-scope':
        return result([{
          scope_count: '1',
          target_count: '1',
          covered_count: input.coveredTarget === false ? '0' : '1',
        }])
      case 'elearning-admin-access:scope-configured':
        return result([{ scope_count: '1' }])
      case 'elearning-lifecycle:lock-assignment':
        return result([{
          id: ASSIGNMENT,
          course_version_id: VERSION,
          deadline: null,
        }])
      case 'elearning-lifecycle:page-members':
        return result()
      default:
        return result([], 1)
    }
  })
}

function expectAccessCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningAdminAccessError)
  expect((error as ElearningAdminAccessError).code).toBe(code)
  expect(`${(error as Error).message}\n${(error as Error).stack ?? ''}`)
    .not.toContain(ORG)
}

describe('e-learning delegated operation authorization', () => {
  it('requires the exact assign action before direct assignment reaches its domain lock', async () => {
    const db = authorizationDb({ objectAction: false })
    let caught: unknown
    try {
      await assignElearningDirectAuthorized(db, {
        orgId: ORG,
        actorId: ACTOR,
        isGlobalAdmin: false,
        targetUserId: TARGET,
        courseVersionId: VERSION,
        sourceKey: 'admin-operation-direct',
      })
    } catch (error) {
      caught = error
    }
    expectAccessCode(caught, 'forbidden')
    expect(db.calls.some((call) => marker(call.sql) === 'elearning-assign:lock'))
      .toBe(false)
  })

  it('does not let an assign ACL bypass target management scope', async () => {
    const db = authorizationDb({ coveredTarget: false })
    await expect(assignElearningDirectAuthorized(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      targetUserId: TARGET,
      courseVersionId: VERSION,
      sourceKey: 'admin-operation-outside',
    })).rejects.toMatchObject({ code: 'target_out_of_scope' })
    expect(db.calls.some((call) => marker(call.sql) === 'elearning-assign:lock'))
      .toBe(false)
  })

  it('does not let assign-only or track-only collaborators perform scope/assign', async () => {
    const scopeDb = authorizationDb({ objectAction: false })
    await expect(setElearningCourseScopeAuthorized(scopeDb, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      courseId: COURSE,
      reason: 'delegated scope change',
      rules: [{ subjectType: 'user', subjectRef: TARGET }],
    })).rejects.toMatchObject({ code: 'forbidden' })
    expect(scopeDb.calls.some((call) => marker(call.sql) === 'elearning-scope:lock'))
      .toBe(false)

    const planDb = authorizationDb({ objectAction: false })
    await expect(assignElearningTrainingPlanAuthorized(planDb, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      planId: PLAN,
      sourceKey: 'admin-operation-plan',
      rules: [{ subjectType: 'user', subjectRef: TARGET }],
    })).rejects.toMatchObject({ code: 'forbidden' })
    expect(planDb.calls.some(
      (call) => marker(call.sql) === 'elearning-training-plan-assign:lock',
    )).toBe(false)
  })

  it('filters delegated progress in SQL and uses a plan ACL for plan children', async () => {
    const db = authorizationDb({ planChild: true })
    await expect(listElearningAssignmentProgressAuthorized(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      assignmentId: ASSIGNMENT,
      limit: 20,
    })).resolves.toEqual({
      assignmentId: ASSIGNMENT,
      courseVersionId: VERSION,
      deadline: null,
      members: [],
      nextCursor: null,
    })

    expect(db.calls.map((call) => marker(call.sql)).slice(0, 8)).toEqual([
      'elearning-admin-operations:repeatable-read',
      'elearning-admin-operations:assignment-object',
      'elearning-admin-access:operation-lock',
      'elearning-admin-access:operation-lock',
      'elearning-admin-access:active-membership',
      'elearning-admin-access:load-object',
      'elearning-admin-access:object-action',
      'elearning-admin-access:user-scope',
    ])
    const actionCall = db.calls.find(
      (call) => marker(call.sql) === 'elearning-admin-access:object-action',
    )
    expect(actionCall?.sql).toContain('training_plan_id')
    expect(actionCall?.params).toEqual([ORG, PLAN, ACTOR, 'track'])
    const lockKeys = db.calls
      .filter((call) => marker(call.sql) === 'elearning-admin-access:operation-lock')
      .map((call) => call.params?.[0])
    expect(lockKeys).toEqual([
      elearningAdminScopeLockKey(ORG, ACTOR),
      elearningObjectAclLockKey(ORG, 'training_plan', PLAN, ACTOR),
    ].sort())
    const pageCall = db.calls.find(
      (call) => marker(call.sql) === 'elearning-lifecycle:page-members',
    )
    expect(pageCall?.params).toEqual([ORG, ASSIGNMENT, null, 21, ACTOR])
    expect(pageCall?.sql).toContain('elearning_admin_scopes')
    expect(pageCall?.sql).toContain('directory_account_departments')
  })

  it('keeps global admin progress unfiltered while retaining same-org object lookup', async () => {
    const db = authorizationDb()
    await listElearningAssignmentProgressAuthorized(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      assignmentId: ASSIGNMENT,
    })
    expect(db.calls.some(
      (call) => marker(call.sql) === 'elearning-admin-access:user-scope',
    )).toBe(false)
    const pageCall = db.calls.find(
      (call) => marker(call.sql) === 'elearning-lifecycle:page-members',
    )
    expect(pageCall?.params?.[4]).toBeNull()
  })
})
