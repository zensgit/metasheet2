import { describe, expect, it } from 'vitest'

import {
  canonicalizeElearningTrainingPlanInput,
  canonicalizeElearningTrainingPlanRequest,
  ElearningTrainingPlanError,
  getElearningTrainingPlan,
  hashElearningTrainingPlanRequest,
  publishElearningTrainingPlan,
  type ElearningTrainingPlanDb,
  type ElearningTrainingPlanQueryable,
  type PublishElearningTrainingPlanInput,
} from '../../src/services/elearning-training-plan'

const ORG = 'org-training-plan'
const ACTOR = 'actor-training-plan'
const REQUEST = '11111111-1111-4111-8111-111111111111'
const COURSE_A = '22222222-2222-4222-8222-222222222222'
const COURSE_B = '33333333-3333-4333-8333-333333333333'
const PLAN = '44444444-4444-4444-8444-444444444444'
const PLAN_VERSION = '55555555-5555-4555-8555-555555555555'

function input(
  override: Partial<PublishElearningTrainingPlanInput> = {},
): PublishElearningTrainingPlanInput {
  return {
    orgId: ORG,
    actorId: ACTOR,
    requestId: REQUEST,
    title: 'Onboarding plan',
    items: [
      { courseVersionId: COURSE_A, required: true },
      { courseVersionId: COURSE_B, required: false },
    ],
    ...override,
  }
}

function queryResult(
  rows: Array<Record<string, unknown>> = [],
  rowCount = rows.length,
) {
  return { rows, rowCount }
}

class ScriptDb implements ElearningTrainingPlanDb {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(
    private readonly handler: (
      sql: string,
      params?: unknown[],
    ) => ReturnType<typeof queryResult> = (sql) => {
      if (sql.includes('load-request')) return queryResult()
      if (sql.includes('lock-course-versions')) {
        return queryResult([{ id: COURSE_A }, { id: COURSE_B }])
      }
      return queryResult([], 1)
    },
  ) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params })
    return this.handler(sql, params)
  }

  async transaction<T>(
    handler: (tx: ElearningTrainingPlanQueryable) => Promise<T>,
  ): Promise<T> {
    return handler(this)
  }
}

describe('e-learning training-plan input and hash', () => {
  it('normalizes text/UUIDs, preserves ordered items, and uses a domain-version hash', () => {
    const canonical = canonicalizeElearningTrainingPlanInput({
      ...input(),
      orgId: ` ${ORG} `,
      actorId: ` ${ACTOR} `,
      title: '  Onboarding plan  ',
      requestId: REQUEST.toUpperCase(),
    })
    expect(canonical).toEqual(input())
    expect(canonicalizeElearningTrainingPlanRequest(canonical)).toContain(
      'elearning.training-plan.publish.request.v1',
    )
    expect(hashElearningTrainingPlanRequest(canonical)).toMatch(/^[a-f0-9]{64}$/)

    const actorChanged = canonicalizeElearningTrainingPlanInput({
      ...input(),
      actorId: 'retry-actor',
    })
    expect(hashElearningTrainingPlanRequest(actorChanged)).toBe(
      hashElearningTrainingPlanRequest(canonical),
    )
    const reordered = canonicalizeElearningTrainingPlanInput({
      ...input(),
      items: [...input().items].reverse(),
    })
    expect(hashElearningTrainingPlanRequest(reordered)).not.toBe(
      hashElearningTrainingPlanRequest(canonical),
    )
    expect(canonicalizeElearningTrainingPlanRequest(canonical)).toBe(
      '{"domain":"elearning.training-plan.publish.request.v1","items":[{"courseVersionId":"22222222-2222-4222-8222-222222222222","required":true},{"courseVersionId":"33333333-3333-4333-8333-333333333333","required":false}],"title":"Onboarding plan","version":1}',
    )
    expect(hashElearningTrainingPlanRequest(canonical)).toBe(
      '72ee1513d69a8a59303eccc2b2d55b161abd62c9284eaddd273a6b5ebedc2bc3',
    )
  })

  it('rejects unknown/missing keys, invalid bounds, duplicates, and non-boolean required', () => {
    const invalid: unknown[] = [
      null,
      { ...input(), extra: true },
      { ...input(), title: ' ' },
      { ...input(), title: 'x'.repeat(201) },
      { ...input(), requestId: 'not-a-uuid' },
      { ...input(), items: [] },
      { ...input(), items: Array.from({ length: 101 }, (_, index) => ({
        courseVersionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        required: true,
      })) },
      { ...input(), items: [input().items[0], input().items[0]] },
      { ...input(), items: [{ courseVersionId: COURSE_A, required: 'yes' }] },
      { ...input(), items: [{ courseVersionId: COURSE_A, required: true, extra: 1 }] },
    ]
    for (const value of invalid) {
      expect(() => canonicalizeElearningTrainingPlanInput(value)).toThrowError(
        new ElearningTrainingPlanError('invalid_input'),
      )
    }
  })
})

describe('publishElearningTrainingPlan', () => {
  it('locks eligible course versions, writes ordered items, and returns a closed result', async () => {
    const db = new ScriptDb()
    const result = await publishElearningTrainingPlan(db, input())
    expect(result).toEqual({
      planId: expect.any(String),
      planVersionId: expect.any(String),
      status: 'published',
      itemCount: 2,
      duplicate: false,
    })
    const markers = db.calls.map((call) =>
      call.sql.match(/\/\* ([^*]+) \*\//)?.[1],
    )
    expect(markers).toEqual([
      'elearning-training-plan:lock',
      'elearning-training-plan:load-request',
      'elearning-training-plan:lock-course-versions',
      'elearning-training-plan:insert-head',
      'elearning-training-plan:insert-version',
      'elearning-training-plan:insert-item',
      'elearning-training-plan:insert-item',
      'elearning-training-plan:publish-version',
      'elearning-training-plan:set-pointers',
      'elearning-training-plan:insert-request',
    ])
    const itemCalls = db.calls.filter((call) => call.sql.includes('insert-item'))
    expect(itemCalls.map((call) => call.params?.slice(3))).toEqual([
      [COURSE_A, 1, true],
      [COURSE_B, 2, false],
    ])
    expect(db.calls.find((call) => call.sql.includes('lock-course-versions'))?.sql)
      .toMatch(/FOR SHARE OF cv, c/)
  })

  it('returns the stored result for same-payload replay and conflicts on changed payload', async () => {
    const canonical = canonicalizeElearningTrainingPlanInput(input())
    const stored = {
      training_plan_id: PLAN,
      training_plan_version_id: PLAN_VERSION,
      item_count: 2,
      request_hash: hashElearningTrainingPlanRequest(canonical),
      request_hash_version: 1,
    }
    const replayDb = new ScriptDb((sql) =>
      sql.includes('load-request') ? queryResult([stored]) : queryResult([], 1),
    )
    await expect(publishElearningTrainingPlan(replayDb, {
      ...input(),
      actorId: 'retry-actor',
    })).resolves.toEqual({
      planId: PLAN,
      planVersionId: PLAN_VERSION,
      status: 'published',
      itemCount: 2,
      duplicate: true,
    })
    expect(replayDb.calls.some((call) => call.sql.includes('lock-course-versions')))
      .toBe(false)

    const conflictDb = new ScriptDb((sql) =>
      sql.includes('load-request') ? queryResult([stored]) : queryResult([], 1),
    )
    await expect(publishElearningTrainingPlan(conflictDb, {
      ...input(),
      title: 'Changed',
    })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('fails before writes when any course version is unavailable', async () => {
    const db = new ScriptDb((sql) => {
      if (sql.includes('load-request')) return queryResult()
      if (sql.includes('lock-course-versions')) return queryResult([{ id: COURSE_A }])
      return queryResult([], 1)
    })
    await expect(publishElearningTrainingPlan(db, input())).rejects.toMatchObject({
      code: 'course_unavailable',
    })
    expect(db.calls.some((call) => call.sql.includes('insert-head'))).toBe(false)
  })
})

describe('getElearningTrainingPlan', () => {
  it('returns the active published version and ordered closed item DTO', async () => {
    const db: ElearningTrainingPlanQueryable = {
      query: async (sql) => {
        if (sql.includes('get-head')) {
          return queryResult([{
            plan_id: PLAN,
            title: 'Onboarding plan',
            status: 'active',
            plan_version_id: PLAN_VERSION,
            version: 1,
            version_status: 'published',
          }])
        }
        return queryResult([
          { course_version_id: COURSE_A, position: 1, required: true },
          { course_version_id: COURSE_B, position: 2, required: false },
        ])
      },
    }
    await expect(getElearningTrainingPlan(db, {
      orgId: ORG,
      planId: PLAN,
    })).resolves.toEqual({
      planId: PLAN,
      title: 'Onboarding plan',
      status: 'active',
      activeVersion: {
        planVersionId: PLAN_VERSION,
        version: 1,
        status: 'published',
        items: [
          { courseVersionId: COURSE_A, position: 1, required: true },
          { courseVersionId: COURSE_B, position: 2, required: false },
        ],
      },
    })
  })

  it('returns not_found when the org-scoped head is absent', async () => {
    const db: ElearningTrainingPlanQueryable = {
      query: async () => queryResult(),
    }
    await expect(getElearningTrainingPlan(db, {
      orgId: 'other-org',
      planId: PLAN,
    })).rejects.toMatchObject({ code: 'not_found' })
  })
})
