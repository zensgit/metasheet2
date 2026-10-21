import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  assignElearningBatch,
  canonicalizeElearningBatchAssignmentRequest,
  ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT,
  ELEARNING_BATCH_ASSIGNMENT_REQUEST_DOMAIN,
  ELEARNING_BATCH_ASSIGNMENT_REQUEST_HASH_VERSION,
  ElearningBatchAssignmentError,
  hashElearningBatchAssignmentRequest,
  normalizeElearningBatchAssignmentRules,
  type ElearningBatchAssignmentDb,
  type ElearningBatchAssignmentQueryable,
} from '../../src/services/elearning-batch-assignment'

const ORG = 'org-batch-1'
const ORG_B = 'org-batch-2'
const ACTOR = 'actor-batch-1'
const SOURCE = 'source-batch-1'
const VERSION = '11111111-1111-4111-8111-111111111111'

type Assignment = {
  id: string
  orgId: string
  sourceKey: string
  versionId: string
  requestHash: string
  requestHashVersion: number
  targetSnapshot: unknown
}

type Member = {
  orgId: string
  assignmentId: string
  versionId: string
  userId: string
  source: string
}

type Mem = {
  assignments: Assignment[]
  members: Member[]
  audience: string[]
  courseStatus: string
  versionStatus: string
  courseExists: boolean
  queries: string[]
}

function tag(sql: string): string | null {
  return /\/\* ([a-z-]+:[a-z-]+) \*\//.exec(sql)?.[1] ?? null
}

function createMemoryDb(seed: Partial<Mem> = {}): { db: ElearningBatchAssignmentDb; mem: Mem } {
  const mem: Mem = {
    assignments: [],
    members: [],
    audience: ['user-batch-1', 'user-batch-2'],
    courseStatus: 'active',
    versionStatus: 'published',
    courseExists: true,
    queries: [],
    ...seed,
  }
  let transactionTail = Promise.resolve()
  const query = async (sql: string, params: unknown[] = []) => {
    mem.queries.push(sql)
    const queryTag = tag(sql)
    if (queryTag === 'elearning-batch-assign:lock') {
      expect(sql).toContain('pg_advisory_xact_lock')
      expect(params[0]).toBe(`elearning-assign:${ORG}:${SOURCE}`)
      return { rows: [], rowCount: 1 }
    }
    if (queryTag === 'elearning-batch-assign:load-existing') {
      const row = mem.assignments.find(
        (assignment) => assignment.orgId === params[0] && assignment.sourceKey === params[1],
      )
      return row
        ? {
            rows: [{
              id: row.id,
              request_hash: row.requestHash,
              request_hash_version: row.requestHashVersion,
              target_snapshot: row.targetSnapshot,
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 }
    }
    if (queryTag === 'elearning-batch-assign:count-members') {
      const count = mem.members.filter(
        (member) => member.orgId === params[0]
          && member.assignmentId === params[1]
          && member.versionId === params[2]
          && member.source === 'rule',
      ).length
      return { rows: [{ member_count: String(count) }], rowCount: 1 }
    }
    if (queryTag === 'elearning-batch-assign:lock-course') {
      expect(sql).toContain('FOR SHARE OF c, v')
      if (!mem.courseExists || params[0] !== ORG || params[1] !== VERSION) {
        return { rows: [], rowCount: 0 }
      }
      return {
        rows: [{ course_status: mem.courseStatus, version_status: mem.versionStatus }],
        rowCount: 1,
      }
    }
    if (queryTag === 'elearning-audience:resolve-membership') {
      expect(params[3]).toBe(ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT + 1)
      expect(params[4]).toBe(true)
      return {
        rows: mem.audience.map((userId) => ({ rule_key: '__member__', user_id: userId })),
        rowCount: mem.audience.length,
      }
    }
    if (queryTag === 'elearning-batch-assign:lock-members') {
      expect(sql).toContain('FOR SHARE OF platform_user, membership')
      expect(params).toEqual([ORG, mem.audience])
      return {
        rows: mem.audience.map((userId) => ({ id: userId })),
        rowCount: mem.audience.length,
      }
    }
    if (queryTag === 'elearning-batch-assign:insert-assignment') {
      mem.assignments.push({
        id: String(params[0]),
        orgId: String(params[1]),
        versionId: String(params[2]),
        sourceKey: String(params[3]),
        requestHash: String(params[4]),
        requestHashVersion: Number(params[5]),
        targetSnapshot: JSON.parse(String(params[8])),
      })
      return { rows: [], rowCount: 1 }
    }
    if (queryTag === 'elearning-batch-assign:insert-members') {
      expect(sql).toContain("'rule'")
      expect(sql).toContain('unnest($4::text[])')
      const users = params[3] as string[]
      for (const userId of users) {
        mem.members.push({
          orgId: String(params[0]),
          assignmentId: String(params[1]),
          versionId: String(params[2]),
          userId,
          source: 'rule',
        })
      }
      return { rows: [], rowCount: users.length }
    }
    throw new Error(`unhandled query ${queryTag ?? 'untagged'}`)
  }
  const transaction = async <T>(
    handler: (tx: ElearningBatchAssignmentQueryable) => Promise<T>,
  ): Promise<T> => {
    const previous = transactionTail
    let release!: () => void
    transactionTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await handler({ query })
    } finally {
      release()
    }
  }
  return { db: { query, transaction }, mem }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    courseVersionId: VERSION,
    sourceKey: SOURCE,
    deadline: null,
    rules: [{ subjectType: 'all' }],
    ...overrides,
  }
}

function assertValuesFree(error: unknown): void {
  expect(error).toBeInstanceOf(ElearningBatchAssignmentError)
  const actual = error as ElearningBatchAssignmentError
  const blob = `${actual.message}\n${actual.stack ?? ''}\n${JSON.stringify(actual)}`
  for (const value of [ORG, ORG_B, ACTOR, SOURCE, VERSION]) {
    expect(blob).not.toContain(value)
  }
}

async function expectCode(
  db: ElearningBatchAssignmentDb,
  value: Record<string, unknown>,
  code: string,
): Promise<void> {
  try {
    await assignElearningBatch(db, value as never)
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect((error as ElearningBatchAssignmentError).code).toBe(code)
    assertValuesFree(error)
  }
}

describe('batch assignment canonical request', () => {
  it('sorts and deduplicates rules, deep-sorts JSON, and hashes an independent domain', () => {
    const rules = normalizeElearningBatchAssignmentRules([
      { subjectType: 'position', subjectRef: ' Engineer ', includeChildren: false },
      { subjectType: 'all', subjectRef: null },
      { subjectType: 'position', subjectRef: 'Engineer' },
    ])
    expect(rules).toEqual([
      { subjectType: 'all', subjectRef: null, includeChildren: false },
      { subjectType: 'position', subjectRef: 'Engineer', includeChildren: false },
    ])
    const canonical = canonicalizeElearningBatchAssignmentRequest({
      courseVersionId: VERSION,
      deadline: '2026-12-31T08:00:00.000Z',
      rules,
    })
    expect(JSON.parse(canonical)).toEqual({
      courseVersionId: VERSION,
      deadline: '2026-12-31T08:00:00.000Z',
      domain: ELEARNING_BATCH_ASSIGNMENT_REQUEST_DOMAIN,
      rules,
      version: ELEARNING_BATCH_ASSIGNMENT_REQUEST_HASH_VERSION,
    })
    expect(hashElearningBatchAssignmentRequest({
      courseVersionId: VERSION,
      deadline: '2026-12-31T08:00:00.000Z',
      rules,
    })).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'))
    expect(ELEARNING_BATCH_ASSIGNMENT_REQUEST_DOMAIN).not.toBe('elearning.assignment.request.v1')
  })
})

describe('assignElearningBatch', () => {
  it('materializes one bounded rule assignment with a private response', async () => {
    const { db, mem } = createMemoryDb()
    const result = await assignElearningBatch(db, input({
      orgId: ` ${ORG} `,
      actorId: ` ${ACTOR} `,
      sourceKey: ` ${SOURCE} `,
      courseVersionId: VERSION.toUpperCase(),
      deadline: ' 2026-12-31T16:00:00+08:00 ',
    }))
    expect(result).toEqual({
      assignmentId: expect.any(String),
      memberCount: 2,
      duplicate: false,
    })
    expect(mem.assignments).toHaveLength(1)
    expect(mem.assignments[0]).toEqual(expect.objectContaining({
      orgId: ORG,
      sourceKey: SOURCE,
      versionId: VERSION,
      requestHashVersion: 1,
      targetSnapshot: [{ subjectType: 'all', subjectRef: null, includeChildren: false }],
    }))
    expect(mem.members.map((member) => member.userId)).toEqual([
      'user-batch-1',
      'user-batch-2',
    ])
    expect(JSON.stringify(result)).not.toContain('user-batch')
    expect(mem.queries.filter((sql) => sql.includes('insert-members'))).toHaveLength(1)
  })

  it('replays without resolving, conflicts on changed payload, and serializes concurrency', async () => {
    const { db, mem } = createMemoryDb()
    const [first, concurrentReplay] = await Promise.all([
      assignElearningBatch(db, input()),
      assignElearningBatch(db, input({ actorId: 'another-actor' })),
    ])
    expect(concurrentReplay).toEqual({ ...first, duplicate: true })
    const resolveCount = mem.queries.filter(
      (sql) => sql.includes('elearning-audience:resolve-membership'),
    ).length
    expect(resolveCount).toBe(1)
    expect(mem.assignments).toHaveLength(1)
    expect(mem.members).toHaveLength(2)

    await expectCode(db, input({
      rules: [{ subjectType: 'position', subjectRef: 'Engineer' }],
    }), 'conflict')
    expect(mem.assignments).toHaveLength(1)

    mem.assignments[0].targetSnapshot = null
    await expectCode(db, input(), 'unavailable')
    expect(mem.queries.filter(
      (sql) => sql.includes('elearning-audience:resolve-membership'),
    )).toHaveLength(resolveCount)
  })

  it('fails closed for invalid, unavailable, unsupported, empty, and oversized targets', async () => {
    for (const invalid of [
      input({ orgId: '' }),
      input({ actorId: ' ' }),
      input({ sourceKey: '' }),
      input({ courseVersionId: 'not-a-uuid' }),
      input({ deadline: 'not-a-date' }),
      input({ rules: 'all' }),
      input({ rules: new Array(101).fill({ subjectType: 'all' }) }),
    ]) {
      await expectCode(createMemoryDb().db, invalid, 'invalid_input')
    }
    await expectCode(createMemoryDb().db, input({
      rules: [{ subjectType: 'role', subjectRef: 'manager' }],
    }), 'unsupported_subject')
    await expectCode(createMemoryDb({ audience: [] }).db, input(), 'empty_audience')
    await expectCode(createMemoryDb({
      audience: Array.from(
        { length: ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT + 1 },
        (_, index) => `user-${index}`,
      ),
    }).db, input(), 'audience_too_large')
    await expectCode(createMemoryDb({ courseExists: false }).db, input(), 'not_found')
    await expectCode(createMemoryDb({ courseStatus: 'archived' }).db, input(), 'course_unavailable')
    await expectCode(createMemoryDb({ courseStatus: 'withdrawn' }).db, input(), 'course_unavailable')
    await expectCode(createMemoryDb({ versionStatus: 'draft' }).db, input(), 'course_unavailable')
    await expectCode(createMemoryDb({ versionStatus: 'retired' }).db, input(), 'course_unavailable')
  })
})
