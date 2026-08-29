import { describe, expect, it } from 'vitest'

import {
  assertAnyElearningUserWithinAdminScope,
  assertElearningRulesWithinAdminScope,
  assertElearningUsersWithinAdminScope,
  authorizeElearningObjectAction,
  ElearningAdminAccessError,
  normalizeElearningAdminScopes,
  normalizeElearningObjectActions,
  replaceElearningAdminScopes,
  replaceElearningObjectAcl,
  type ElearningAdminAccessDb,
  type ElearningAdminAccessQueryable,
} from '../../src/services/elearning-admin-access'

const ORG = 'org-admin-access'
const ACTOR = 'actor-admin-access'
const TARGET = 'target-admin-access'
const DEPARTMENT = '11111111-1111-4111-8111-111111111111'
const COURSE = '22222222-2222-4222-8222-222222222222'
const ROW = '33333333-3333-4333-8333-333333333333'

function result(
  rows: Array<Record<string, unknown>> = [],
  rowCount = rows.length,
) {
  return { rows, rowCount }
}

class ScriptDb implements ElearningAdminAccessDb {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(
    private readonly handler: (
      sql: string,
      params?: unknown[],
    ) => ReturnType<typeof result> = () => result(),
  ) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params })
    return this.handler(sql, params)
  }

  async transaction<T>(
    handler: (tx: ElearningAdminAccessQueryable) => Promise<T>,
  ): Promise<T> {
    return handler(this)
  }
}

function marker(sql: string): string | undefined {
  return sql.match(/\/\* ([^*]+) \*\//)?.[1]
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningAdminAccessError)
  expect((error as ElearningAdminAccessError).code).toBe(code)
  expect(`${(error as Error).message}\n${(error as Error).stack ?? ''}`)
    .not.toContain(ORG)
}

describe('e-learning admin access input contracts', () => {
  it('normalizes deterministic scopes and the closed collaboration action set', () => {
    expect(normalizeElearningAdminScopes([
      { departmentId: DEPARTMENT.toUpperCase(), includeChildren: true },
    ])).toEqual([{ departmentId: DEPARTMENT, includeChildren: true }])
    expect(normalizeElearningObjectActions(['track', 'assign'])).toEqual([
      'assign',
      'track',
    ])
  })

  it('rejects duplicates, unknown keys, invalid booleans, and undeclared actions', () => {
    const invalidScopes: unknown[] = [
      null,
      [{ departmentId: DEPARTMENT, includeChildren: 'yes' }],
      [{ departmentId: DEPARTMENT, includeChildren: false, extra: true }],
      [
        { departmentId: DEPARTMENT, includeChildren: false },
        { departmentId: DEPARTMENT, includeChildren: true },
      ],
    ]
    for (const value of invalidScopes) {
      expect(() => normalizeElearningAdminScopes(value)).toThrowError(
        new ElearningAdminAccessError('invalid_input'),
      )
    }
    for (const value of [['edit'], ['assign', 'assign'], ['assign', 1], null]) {
      expect(() => normalizeElearningObjectActions(value)).toThrowError(
        new ElearningAdminAccessError('invalid_input'),
      )
    }
  })
})

describe('e-learning delegated admin state changes', () => {
  it('replaces admin scopes transactionally and reports an exact replay as duplicate', async () => {
    const writeDb = new ScriptDb((sql) => {
      switch (marker(sql)) {
        case 'elearning-admin-access:active-membership':
          return result([{ '?column?': 1 }])
        case 'elearning-admin-scopes:departments':
          return result([{
            id: DEPARTMENT,
            integration_id: ROW,
            provider: 'test',
          }])
        case 'elearning-admin-scopes:load-current':
          return result()
        case 'elearning-admin-scopes:insert':
          return result([{ id: ROW }])
        default:
          return result([], 1)
      }
    })
    await expect(replaceElearningAdminScopes(writeDb, {
      orgId: ORG,
      actorId: ACTOR,
      targetUserId: TARGET,
      reason: 'delegated administration',
      scopes: [{ departmentId: DEPARTMENT, includeChildren: true }],
    })).resolves.toEqual({
      targetUserId: TARGET,
      scopeCount: 1,
      duplicate: false,
    })
    expect(writeDb.calls.map((call) => marker(call.sql))).toEqual([
      'elearning-admin-scopes:lock',
      'elearning-admin-access:active-membership',
      'elearning-admin-access:active-membership',
      'elearning-admin-scopes:departments',
      'elearning-admin-scopes:load-current',
      'elearning-admin-scopes:insert',
    ])

    const replayDb = new ScriptDb((sql) => {
      if (marker(sql) === 'elearning-admin-access:active-membership') {
        return result([{ '?column?': 1 }])
      }
      if (marker(sql) === 'elearning-admin-scopes:departments') {
        return result([{ id: DEPARTMENT }])
      }
      if (marker(sql) === 'elearning-admin-scopes:load-current') {
        return result([{
          id: ROW,
          directory_department_id: DEPARTMENT,
          include_children: true,
        }])
      }
      return result([], 1)
    })
    await expect(replaceElearningAdminScopes(replayDb, {
      orgId: ORG,
      actorId: ACTOR,
      targetUserId: TARGET,
      reason: 'same request',
      scopes: [{ departmentId: DEPARTMENT, includeChildren: true }],
    })).resolves.toMatchObject({ duplicate: true, scopeCount: 1 })
    expect(replayDb.calls.some((call) => marker(call.sql) === 'elearning-admin-scopes:insert'))
      .toBe(false)
  })

  it('allows only an active owner or global admin to replace an object ACL', async () => {
    const ownerDb = new ScriptDb((sql) => {
      if (marker(sql) === 'elearning-admin-access:active-membership') {
        return result([{ '?column?': 1 }])
      }
      if (marker(sql) === 'elearning-admin-access:load-object') {
        return result([{ created_by: ACTOR }])
      }
      if (marker(sql) === 'elearning-object-acl:load-current') return result()
      if (marker(sql) === 'elearning-object-acl:insert') return result([{ id: ROW }])
      return result([], 1)
    })
    await expect(replaceElearningObjectAcl(ownerDb, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      object: { courseId: COURSE },
      granteeUserId: TARGET,
      reason: 'course collaborator',
      actions: ['track'],
    })).resolves.toEqual({
      objectType: 'course',
      objectId: COURSE,
      granteeUserId: TARGET,
      actions: ['track'],
      duplicate: false,
    })

    const nonOwnerDb = new ScriptDb((sql) => {
      if (marker(sql) === 'elearning-admin-access:active-membership') {
        return result([{ '?column?': 1 }])
      }
      if (marker(sql) === 'elearning-admin-access:load-object') {
        return result([{ created_by: 'another-owner' }])
      }
      return result([], 1)
    })
    let caught: unknown
    try {
      await replaceElearningObjectAcl(nonOwnerDb, {
        orgId: ORG,
        actorId: ACTOR,
        isGlobalAdmin: false,
        object: { courseId: COURSE },
        granteeUserId: TARGET,
        reason: 'forbidden grant',
        actions: ['assign'],
      })
    } catch (error) {
      caught = error
    }
    expectCode(caught, 'forbidden')
    expect(nonOwnerDb.calls.filter((call) => marker(call.sql) === 'elearning-admin-access:active-membership'))
      .toHaveLength(1)
  })
})

describe('e-learning delegated action and management-scope checks', () => {
  it('requires the exact ACL action and an active same-org actor', async () => {
    const db = new ScriptDb((sql, params) => {
      if (marker(sql) === 'elearning-admin-access:active-membership') {
        return result([{ '?column?': 1 }])
      }
      if (marker(sql) === 'elearning-admin-access:load-object') {
        return result([{ created_by: 'owner' }])
      }
      if (marker(sql) === 'elearning-admin-access:object-action') {
        return params?.[3] === 'track' ? result([{ '?column?': 1 }]) : result()
      }
      return result()
    })
    await expect(authorizeElearningObjectAction(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      object: { courseId: COURSE },
      action: 'track',
    })).resolves.toBeUndefined()
    await expect(authorizeElearningObjectAction(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      object: { courseId: COURSE },
      action: 'assign',
    })).rejects.toMatchObject({ code: 'forbidden' })

    const inactive = new ScriptDb()
    await expect(authorizeElearningObjectAction(inactive, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      object: { courseId: COURSE },
      action: 'scope',
    })).rejects.toMatchObject({ code: 'not_found' })
    expect(inactive.calls.some((call) => marker(call.sql) === 'elearning-admin-access:load-object'))
      .toBe(false)
  })

  it('fails closed when users are uncovered or the delegated administrator has no scope', async () => {
    const uncovered = new ScriptDb(() => result([{
      scope_count: '1',
      target_count: '2',
      covered_count: '1',
    }]))
    await expect(assertElearningUsersWithinAdminScope(uncovered, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      userIds: ['user-a', 'user-b'],
    })).rejects.toMatchObject({ code: 'target_out_of_scope' })
    await expect(assertAnyElearningUserWithinAdminScope(uncovered, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      userIds: ['user-a', 'user-b'],
    })).resolves.toBeUndefined()
    expect(uncovered.calls[0]?.sql).toMatch(/NOT child\.id = ANY\(parent\.path\)/)

    const noScope = new ScriptDb(() => result([{
      scope_count: 0n,
      target_count: 1n,
      covered_count: 0n,
    }]))
    await expect(assertElearningUsersWithinAdminScope(noScope, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      userIds: ['user-a'],
    })).rejects.toMatchObject({ code: 'scope_required' })

    const noneCovered = new ScriptDb(() => result([{
      scope_count: 1n,
      target_count: 1n,
      covered_count: 0n,
    }]))
    await expect(assertAnyElearningUserWithinAdminScope(noneCovered, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      userIds: ['user-a'],
    })).rejects.toMatchObject({ code: 'target_out_of_scope' })
  })

  it('denies dynamic rules and proves department expansion structurally', async () => {
    const untouched = new ScriptDb()
    for (const rule of [
      { subjectType: 'all', subjectRef: null, includeChildren: false },
      { subjectType: 'role', subjectRef: 'manager', includeChildren: false },
      { subjectType: 'position', subjectRef: 'engineer', includeChildren: false },
    ] as const) {
      await expect(assertElearningRulesWithinAdminScope(untouched, {
        orgId: ORG,
        actorId: ACTOR,
        isGlobalAdmin: false,
        rules: [rule],
      })).rejects.toMatchObject({ code: 'target_out_of_scope' })
    }
    expect(untouched.calls).toEqual([])

    const covered = new ScriptDb(() => result([{
      scope_count: '1',
      rule_count: '1',
      covered_count: '1',
    }]))
    await expect(assertElearningRulesWithinAdminScope(covered, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      rules: [{
        subjectType: 'department',
        subjectRef: DEPARTMENT,
        includeChildren: true,
      }],
    })).resolves.toBeUndefined()
    expect(covered.calls[0]?.sql).toMatch(
      /input\.include_children = FALSE\s+OR allowed\.can_include_children = TRUE/,
    )
  })
})
