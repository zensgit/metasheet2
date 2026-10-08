import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ELEARNING_ASSIGNMENT_REQUEST_DOMAIN,
  ELEARNING_ASSIGNMENT_REQUEST_HASH_VERSION,
  assignElearningDirect,
  canonicalizeElearningAssignmentRequest,
  elearningDirectAssignmentLockKey,
  ElearningDirectAssignmentError,
  hashElearningAssignmentRequest,
  type ElearningDirectAssignmentDb,
  type ElearningDirectAssignmentQueryable,
} from '../../src/services/elearning-direct-assignment'

const ORG = 'org-assign-1'
const ORG_B = 'org-assign-2'
const ACTOR = 'actor-assign-1'
const TARGET = 'user-assign-1'
const TARGET_B = 'user-assign-2'
const SOURCE = 'src-assign-1'
const VERSION = '11111111-1111-4111-8111-111111111111'
const VERSION_B = '22222222-2222-4222-8222-222222222222'

interface AssignmentRow {
  id: string
  orgId: string
  versionId: string
  sourceKey: string
  requestHash: string
  requestHashVersion: number
  deadline: string | null
  assignedBy: string
}

interface MemberRow {
  id: string
  orgId: string
  assignmentId: string
  versionId: string
  userId: string
  source: string
}

interface MembershipRow {
  userId: string
  orgId: string
  isActive: boolean
}

interface UserRow {
  id: string
  isActive: boolean
}

interface CourseRow {
  orgId: string
  versionId: string
  versionStatus: string
  courseStatus: string
}

interface Mem {
  courses: CourseRow[]
  users: UserRow[]
  memberships: MembershipRow[]
  assignments: AssignmentRow[]
  members: MemberRow[]
  queries: string[]
}

function tagOf(sql: string): string | null {
  const match = /\/\* (elearning-assign:[a-z-]+) \*\//.exec(sql)
  return match ? match[1] : null
}

function createMemoryDb(seed: Partial<Mem> = {}): { db: ElearningDirectAssignmentDb; mem: Mem } {
  const mem: Mem = {
    courses: [{
      orgId: ORG,
      versionId: VERSION,
      versionStatus: 'published',
      courseStatus: 'active',
    }],
    users: [{ id: TARGET, isActive: true }],
    memberships: [{ userId: TARGET, orgId: ORG, isActive: true }],
    assignments: [],
    members: [],
    queries: [],
    ...seed,
  }
  if (seed.courses) mem.courses = seed.courses
  if (seed.users) mem.users = seed.users
  if (seed.memberships) mem.memberships = seed.memberships
  if (seed.assignments) mem.assignments = seed.assignments
  if (seed.members) mem.members = seed.members
  if (seed.users === undefined) {
    for (const membership of mem.memberships) {
      if (!mem.users.some((user) => user.id === membership.userId)) {
        mem.users.push({ id: membership.userId, isActive: true })
      }
    }
  }

  let lockTail = Promise.resolve()
  const query = async (sql: string, params: unknown[] = []) => {
    mem.queries.push(sql)
    const tag = tagOf(sql)
    if (tag === 'elearning-assign:lock') {
      expect(sql).toContain('pg_advisory_xact_lock')
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-assign:load-existing') {
      const row = mem.assignments.find(
        (item) => item.orgId === params[0] && item.sourceKey === params[1],
      )
      if (!row) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          id: row.id,
          request_hash: row.requestHash,
          request_hash_version: row.requestHashVersion,
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-assign:lock-course') {
      expect(sql).toContain('FOR SHARE OF c, v')
      const row = mem.courses.find(
        (item) => item.orgId === params[0] && item.versionId === params[1],
      )
      if (!row) return { rows: [], rowCount: 0 }
      return {
        rows: [{ version_status: row.versionStatus, course_status: row.courseStatus }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-assign:load-membership') {
      expect(sql).toContain('JOIN users')
      expect(sql).toContain('FOR SHARE OF u, uo')
      expect(sql).toMatch(/uo\.is_active\s*=\s*true/)
      expect(sql).toMatch(/u\.is_active\s*=\s*true/)
      const row = mem.memberships.find(
        (item) => item.userId === params[0] && item.orgId === params[1] && item.isActive,
      )
      const user = row && mem.users.find((item) => item.id === row.userId && item.isActive)
      if (!row || !user) return { rows: [], rowCount: 0 }
      return { rows: [{ ok: 1 }], rowCount: 1 }
    }
    if (tag === 'elearning-assign:insert-assignment') {
      mem.assignments.push({
        id: String(params[0]),
        orgId: String(params[1]),
        versionId: String(params[2]),
        sourceKey: String(params[3]),
        requestHash: String(params[4]),
        requestHashVersion: Number(params[5]),
        deadline: params[6] == null ? null : String(params[6]),
        assignedBy: String(params[7]),
      })
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-assign:insert-member') {
      expect(sql).toContain("'manual'")
      mem.members.push({
        id: String(params[0]),
        orgId: String(params[1]),
        assignmentId: String(params[2]),
        versionId: String(params[3]),
        userId: String(params[4]),
        source: 'manual',
      })
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-assign:load-member') {
      expect(sql).toContain("source = 'manual'")
      const row = mem.members.find(
        (item) =>
          item.orgId === params[0]
          && item.assignmentId === params[1]
          && item.versionId === params[2]
          && item.userId === params[3]
          && item.source === 'manual',
      )
      if (!row) return { rows: [], rowCount: 0 }
      return { rows: [{ id: row.id }], rowCount: 1 }
    }
    throw new Error('unhandled query')
  }

  const runTx = async <T>(handler: (tx: ElearningDirectAssignmentQueryable) => Promise<T>) => {
    const prev = lockTail
    let release!: () => void
    lockTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await prev
    try {
      return await handler({ query })
    } finally {
      release()
    }
  }

  return { mem, db: { query, transaction: runTx } }
}

function baseInput(over: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    targetUserId: TARGET,
    courseVersionId: VERSION,
    sourceKey: SOURCE,
    deadline: null as string | Date | null,
    ...over,
  }
}

function assertValuesFree(error: unknown): void {
  expect(error).toBeInstanceOf(ElearningDirectAssignmentError)
  const err = error as ElearningDirectAssignmentError
  const blob = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`
  expect(blob).not.toContain(ORG)
  expect(blob).not.toContain(ORG_B)
  expect(blob).not.toContain(ACTOR)
  expect(blob).not.toContain(TARGET)
  expect(blob).not.toContain(SOURCE)
  expect(blob).not.toContain(VERSION)
}

async function expectCode(
  db: ElearningDirectAssignmentDb,
  input: Record<string, unknown>,
  code: string,
): Promise<void> {
  try {
    await assignElearningDirect(db, input as never)
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect((error as ElearningDirectAssignmentError).code).toBe(code)
    assertValuesFree(error)
  }
}

describe('canonical assignment request hash v1', () => {
  it('deep-sorts keys, embeds domain/version, trims via assign, and normalizes UTC deadlines', async () => {
    const canonical = canonicalizeElearningAssignmentRequest({
      courseVersionId: VERSION,
      deadline: '2026-12-31T08:00:00.000Z',
      targetUserId: TARGET,
    })
    expect(canonical).toBe(JSON.stringify({
      courseVersionId: VERSION,
      deadline: '2026-12-31T08:00:00.000Z',
      domain: ELEARNING_ASSIGNMENT_REQUEST_DOMAIN,
      targetUserId: TARGET,
      version: ELEARNING_ASSIGNMENT_REQUEST_HASH_VERSION,
    }))
    expect(Object.keys(JSON.parse(canonical))).toEqual([
      'courseVersionId',
      'deadline',
      'domain',
      'targetUserId',
      'version',
    ])
    const hashed = hashElearningAssignmentRequest({
      courseVersionId: VERSION,
      deadline: '2026-12-31T08:00:00.000Z',
      targetUserId: TARGET,
    })
    expect(hashed).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'))
    expect(ELEARNING_ASSIGNMENT_REQUEST_DOMAIN).toBe('elearning.assignment.request.v1')
    expect(ELEARNING_ASSIGNMENT_REQUEST_HASH_VERSION).toBe(1)

    expect(hashElearningAssignmentRequest({
      courseVersionId: VERSION,
      deadline: null,
      targetUserId: TARGET,
    })).not.toBe(hashElearningAssignmentRequest({
      courseVersionId: VERSION,
      deadline: '2026-12-31T08:00:00.000Z',
      targetUserId: TARGET,
    }))

    const first = hashElearningAssignmentRequest({
      courseVersionId: VERSION,
      deadline: null,
      targetUserId: TARGET,
    })
    await new Promise((resolve) => setTimeout(resolve, 15))
    const second = hashElearningAssignmentRequest({
      courseVersionId: VERSION,
      deadline: null,
      targetUserId: TARGET,
    })
    expect(second).toBe(first)
    expect(canonical).not.toMatch(/attempt|assignedBy|orgId|sourceKey|createdAt/)

    const { db, mem } = createMemoryDb()
    await assignElearningDirect(db, baseInput({
      orgId: ` ${ORG} `,
      actorId: ` ${ACTOR} `,
      targetUserId: ` ${TARGET} `,
      courseVersionId: VERSION.toUpperCase(),
      sourceKey: ` ${SOURCE} `,
      deadline: ' 2026-12-31T16:00:00+08:00 ',
    }))
    expect(mem.assignments[0].orgId).toBe(ORG)
    expect(mem.assignments[0].sourceKey).toBe(SOURCE)
    expect(mem.assignments[0].deadline).toBe('2026-12-31T08:00:00.000Z')
    expect(mem.assignments[0].requestHash).toBe(hashElearningAssignmentRequest({
      courseVersionId: VERSION,
      deadline: '2026-12-31T08:00:00.000Z',
      targetUserId: TARGET,
    }))
    expect(mem.members[0].source).toBe('manual')
    expect(elearningDirectAssignmentLockKey(ORG, SOURCE)).toBe(`elearning-assign:${ORG}:${SOURCE}`)
  })
})

describe('assignElearningDirect', () => {
  it('rejects blank org/actor/target/source key and non-UUID versions without leaking values', async () => {
    const { db, mem } = createMemoryDb()
    for (const input of [
      baseInput({ orgId: '' }),
      baseInput({ orgId: '  ' }),
      baseInput({ actorId: '' }),
      baseInput({ targetUserId: ' ' }),
      baseInput({ sourceKey: '\t' }),
      baseInput({ courseVersionId: 'not-a-uuid' }),
      baseInput({ courseVersionId: VERSION.slice(0, 8) }),
      baseInput({ deadline: '' }),
      baseInput({ deadline: 'not-a-date' }),
      baseInput({ deadline: 1 }),
    ]) {
      await expectCode(db, input, 'invalid_input')
    }
    expect(mem.assignments).toHaveLength(0)
    expect(mem.members).toHaveLength(0)
  })

  it('requires same-org active user_orgs membership and an active platform user', async () => {
    await expectCode(createMemoryDb({ memberships: [] }).db, baseInput(), 'target_unavailable')
    await expectCode(createMemoryDb({
      memberships: [{ userId: TARGET, orgId: ORG, isActive: false }],
    }).db, baseInput(), 'target_unavailable')
    await expectCode(createMemoryDb({
      memberships: [{ userId: TARGET, orgId: ORG_B, isActive: true }],
    }).db, baseInput(), 'target_unavailable')
    await expectCode(createMemoryDb({
      users: [{ id: TARGET, isActive: false }],
      memberships: [{ userId: TARGET, orgId: ORG, isActive: true }],
    }).db, baseInput(), 'target_unavailable')
    await expectCode(createMemoryDb({
      users: [],
      memberships: [{ userId: TARGET, orgId: ORG, isActive: true }],
    }).db, baseInput(), 'target_unavailable')
  })

  it('requires an active course head and published version locked together', async () => {
    await expectCode(createMemoryDb({ courses: [] }).db, baseInput(), 'not_found')
    await expectCode(createMemoryDb({
      courses: [{ orgId: ORG, versionId: VERSION, versionStatus: 'published', courseStatus: 'archived' }],
    }).db, baseInput(), 'course_unavailable')
    await expectCode(createMemoryDb({
      courses: [{ orgId: ORG, versionId: VERSION, versionStatus: 'published', courseStatus: 'withdrawn' }],
    }).db, baseInput(), 'course_unavailable')
    await expectCode(createMemoryDb({
      courses: [{ orgId: ORG, versionId: VERSION, versionStatus: 'draft', courseStatus: 'active' }],
    }).db, baseInput(), 'course_unavailable')
    await expectCode(createMemoryDb({
      courses: [{ orgId: ORG, versionId: VERSION, versionStatus: 'retired', courseStatus: 'active' }],
    }).db, baseInput(), 'course_unavailable')
    await expectCode(createMemoryDb({
      courses: [{ orgId: ORG_B, versionId: VERSION, versionStatus: 'published', courseStatus: 'active' }],
    }).db, baseInput(), 'not_found')
  })

  it('inserts assignment and manual member atomically with exact deadline', async () => {
    const { db, mem } = createMemoryDb()
    const result = await assignElearningDirect(db, baseInput({
      deadline: '2026-01-15T00:00:00.000Z',
    }))
    expect(result.duplicate).toBe(false)
    expect(mem.assignments).toHaveLength(1)
    expect(mem.members).toHaveLength(1)
    expect(mem.assignments[0]).toEqual(expect.objectContaining({
      id: result.assignmentId,
      deadline: '2026-01-15T00:00:00.000Z',
      assignedBy: ACTOR,
      requestHashVersion: 1,
    }))
    expect(mem.members[0]).toEqual(expect.objectContaining({
      id: result.memberId,
      assignmentId: result.assignmentId,
      userId: TARGET,
      source: 'manual',
    }))
    expect(mem.queries[0]).toContain('elearning-assign:lock')
    expect(mem.queries.some((sql) => sql.includes('FOR SHARE OF c, v'))).toBe(true)
    expect(mem.queries.some((sql) => sql.includes('JOIN users') && sql.includes('FOR SHARE OF u, uo'))).toBe(true)
    expect(JSON.stringify(result)).not.toContain(ORG)
    expect(JSON.stringify(result)).not.toContain(TARGET)
    expect(JSON.stringify(result)).not.toContain(SOURCE)
  })

  it('replays the same source key and payload, conflicts on a different payload, and isolates orgs', async () => {
    const { db, mem } = createMemoryDb({
      courses: [
        { orgId: ORG, versionId: VERSION, versionStatus: 'published', courseStatus: 'active' },
        { orgId: ORG_B, versionId: VERSION_B, versionStatus: 'published', courseStatus: 'active' },
      ],
      memberships: [
        { userId: TARGET, orgId: ORG, isActive: true },
        { userId: TARGET_B, orgId: ORG_B, isActive: true },
      ],
    })
    const first = await assignElearningDirect(db, baseInput())
    const duplicate = await assignElearningDirect(db, baseInput({ actorId: 'other-actor' }))
    expect(duplicate).toEqual({
      assignmentId: first.assignmentId,
      memberId: first.memberId,
      duplicate: true,
    })
    expect(mem.assignments).toHaveLength(1)
    expect(mem.members).toHaveLength(1)

    await expectCode(db, baseInput({ targetUserId: TARGET_B }), 'conflict')
    await expectCode(db, baseInput({ deadline: '2026-12-31T00:00:00.000Z' }), 'conflict')
    expect(mem.assignments).toHaveLength(1)
    expect(mem.members).toHaveLength(1)

    const otherOrg = await assignElearningDirect(db, baseInput({
      orgId: ORG_B,
      targetUserId: TARGET_B,
      courseVersionId: VERSION_B,
    }))
    expect(otherOrg.duplicate).toBe(false)
    expect(otherOrg.assignmentId).not.toBe(first.assignmentId)
    expect(mem.assignments).toHaveLength(2)
    expect(mem.members).toHaveLength(2)
  })

  it('serializes concurrent duplicates onto one assignment and member', async () => {
    const { db, mem } = createMemoryDb()
    const raced = await Promise.all([
      assignElearningDirect(db, baseInput()),
      assignElearningDirect(db, baseInput()),
    ])
    expect(new Set(raced.map((row) => row.assignmentId)).size).toBe(1)
    expect(new Set(raced.map((row) => row.memberId)).size).toBe(1)
    expect(raced.filter((row) => row.duplicate)).toHaveLength(1)
    expect(mem.assignments).toHaveLength(1)
    expect(mem.members).toHaveLength(1)
    expect(mem.members[0].source).toBe('manual')
  })

  it('replays the matching manual member rather than LIMIT 1 over an unrelated sibling', async () => {
    const assignmentId = 'asg-replay-1'
    const matchingMemberId = 'mem-matching'
    const unrelatedMemberId = 'mem-unrelated'
    const { db, mem } = createMemoryDb({
      assignments: [{
        id: assignmentId,
        orgId: ORG,
        versionId: VERSION,
        sourceKey: SOURCE,
        requestHash: hashElearningAssignmentRequest({
          courseVersionId: VERSION,
          deadline: null,
          targetUserId: TARGET,
        }),
        requestHashVersion: 1,
        deadline: null,
        assignedBy: ACTOR,
      }],
      members: [
        {
          id: unrelatedMemberId,
          orgId: ORG,
          assignmentId,
          versionId: VERSION_B,
          userId: TARGET_B,
          source: 'rule',
        },
        {
          id: matchingMemberId,
          orgId: ORG,
          assignmentId,
          versionId: VERSION,
          userId: TARGET,
          source: 'manual',
        },
      ],
    })
    const replay = await assignElearningDirect(db, baseInput())
    expect(replay).toEqual({
      assignmentId,
      memberId: matchingMemberId,
      duplicate: true,
    })
    expect(mem.assignments).toHaveLength(1)
    expect(mem.members).toHaveLength(2)
    expect(mem.queries.some((sql) => (
      sql.includes('elearning-assign:load-member')
      && sql.includes('course_version_id')
      && sql.includes('user_id')
      && sql.includes("source = 'manual'")
    ))).toBe(true)
  })
})
