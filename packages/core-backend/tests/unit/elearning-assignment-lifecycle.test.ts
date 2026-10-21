import { describe, expect, it } from 'vitest'

import {
  ELEARNING_ASSIGNMENT_PROGRESS_LIMIT,
  ELEARNING_REVOCATION_REASON_MAX,
  elearningAssignmentRevokeLockKey,
  ElearningAssignmentLifecycleError,
  listElearningAssignmentProgress,
  revokeElearningAssignmentMember,
  type ElearningAssignmentLifecycleDb,
  type ElearningAssignmentLifecycleQueryable,
} from '../../src/services/elearning-assignment-lifecycle'

const ORG = 'org-lifecycle-1'
const ORG_B = 'org-lifecycle-2'
const ACTOR = 'actor-lifecycle-1'
const USER_A = 'user-lifecycle-a'
const USER_B = 'user-lifecycle-b'
const USER_C = 'user-lifecycle-c'
const ASSIGNMENT = '11111111-1111-4111-8111-111111111111'
const ASSIGNMENT_B = '22222222-2222-4222-8222-222222222222'
const VERSION = '33333333-3333-4333-8333-333333333333'
const MEMBER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MEMBER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MEMBER_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const MEMBER_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

type AssignmentRow = {
  id: string
  orgId: string
  courseVersionId: string
  deadline: string | null
}

type MemberRow = {
  id: string
  orgId: string
  assignmentId: string
  userId: string
  source: 'manual' | 'rule' | 'import'
  assignedAt: string
  revokedAt: string | null
  revokedBy: string | null
  revocationReason: string | null
  overdue: boolean
  videoStatus: 'in_progress' | 'completed' | null
  examStatus: 'started' | 'submitted' | 'awaiting_manual' | 'graded' | 'expired' | null
  passed: boolean
}

type ProgressRow = { memberId: string; status: string }
type AttemptRow = { memberId: string; status: string }
type EvidenceRow = { memberId: string }

type Mem = {
  assignments: AssignmentRow[]
  members: MemberRow[]
  progress: ProgressRow[]
  attempts: AttemptRow[]
  evidence: EvidenceRow[]
  planAssignmentByChild: Record<string, string>
  queries: string[]
  failTag?: string
}

function tagOf(sql: string): string | null {
  return /\/\* (elearning-lifecycle:[a-z-]+) \*\//.exec(sql)?.[1] ?? null
}

function createMemoryDb(seed: Partial<Mem> = {}): { db: ElearningAssignmentLifecycleDb; mem: Mem } {
  const mem: Mem = {
    assignments: [
      {
        id: ASSIGNMENT,
        orgId: ORG,
        courseVersionId: VERSION,
        deadline: '2026-01-01T00:00:00.000Z',
      },
    ],
    members: [
      {
        id: MEMBER_A,
        orgId: ORG,
        assignmentId: ASSIGNMENT,
        userId: USER_A,
        source: 'manual',
        assignedAt: '2026-01-02T00:00:00.000Z',
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
        overdue: true,
        videoStatus: null,
        examStatus: null,
        passed: false,
      },
    ],
    progress: [{ memberId: MEMBER_A, status: 'in_progress' }],
    attempts: [],
    evidence: [{ memberId: MEMBER_A }],
    planAssignmentByChild: {},
    queries: [],
    ...seed,
  }
  if (seed.assignments) mem.assignments = seed.assignments
  if (seed.members) mem.members = seed.members
  if (seed.progress) mem.progress = seed.progress
  if (seed.attempts) mem.attempts = seed.attempts
  if (seed.evidence) mem.evidence = seed.evidence

  const query = async (sql: string, params: unknown[] = []) => {
    mem.queries.push(sql)
    const tag = tagOf(sql)
    if (mem.failTag && tag === mem.failTag) throw new Error('db boom host secret')
    if (tag === 'elearning-lifecycle:lock-assignment') {
      expect(sql).toContain('FOR SHARE')
      const row = mem.assignments.find(
        (item) => item.orgId === params[0] && item.id === params[1],
      )
      if (!row) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          id: row.id,
          course_version_id: row.courseVersionId,
          deadline: row.deadline,
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-lifecycle:page-members') {
      expect(sql).toContain('ORDER BY m.id ASC')
      expect(sql).toContain('m.revoked_at IS NULL')
      expect(sql).not.toMatch(/revocation_reason|revoked_by|auto_score|total_score|answers|answer_key|storage_key|progress_events/)
      const limit = Number(params[3])
      const cursor = params[2] as string | null
      const rows = mem.members
        .filter((item) => item.orgId === params[0] && item.assignmentId === params[1])
        .filter((item) => cursor == null || item.id > cursor)
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit)
        .map((item) => ({
          member_id: item.id,
          user_id: item.userId,
          source: item.source,
          assigned_at: item.assignedAt,
          revoked_at: item.revokedAt,
          overdue: item.overdue,
          video_status: item.videoStatus,
          exam_status: item.examStatus,
          passed: item.passed,
        }))
      return { rows, rowCount: rows.length }
    }
    if (tag === 'elearning-lifecycle:revoke-lock') {
      expect(sql).toContain('pg_advisory_xact_lock')
      expect(params[0]).toBe(
        elearningAssignmentRevokeLockKey(
          String(params[0]).split(':')[1] ?? '',
          String(params[0]).split(':')[2] ?? '',
          String(params[0]).split(':')[3] ?? '',
        ),
      )
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-lifecycle:load-member') {
      expect(sql).toContain('FOR UPDATE')
      expect(sql).toContain('assignment_id = $2')
      const row = mem.members.find(
        (item) =>
          item.orgId === params[0]
          && item.assignmentId === params[1]
          && item.id === params[2],
      )
      if (!row) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          id: row.id,
          assignment_id: row.assignmentId,
          revocation_reason: row.revocationReason,
          revoked_at: row.revokedAt,
          training_plan_assignment_id:
            mem.planAssignmentByChild[row.assignmentId] ?? null,
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-lifecycle:revoke-member') {
      expect(sql).toContain('revoked_at IS NULL')
      expect(sql).not.toMatch(/DELETE|elearning_progress|elearning_completion_evidence|elearning_exam_attempts|elearning_assignments SET/i)
      const row = mem.members.find(
        (item) =>
          item.orgId === params[0]
          && item.assignmentId === params[1]
          && item.id === params[2]
          && item.revokedAt == null,
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.revokedAt = '2026-08-26T00:00:00.000Z'
      row.revokedBy = String(params[3])
      row.revocationReason = String(params[4])
      return {
        rows: [{ id: row.id, assignment_id: row.assignmentId }],
        rowCount: 1,
      }
    }
    throw new Error(`unexpected sql tag ${tag}`)
  }

  const db: ElearningAssignmentLifecycleDb = {
    query,
    transaction: async <T>(handler: (tx: ElearningAssignmentLifecycleQueryable) => Promise<T>) =>
      handler({ query }),
  }
  return { db, mem }
}

describe('listElearningAssignmentProgress', () => {
  it('keeps an awaiting-manual exam in progress', async () => {
    const { db, mem } = createMemoryDb()
    mem.members[0].examStatus = 'awaiting_manual'
    const result = await listElearningAssignmentProgress(db, {
      orgId: ORG,
      assignmentId: ASSIGNMENT,
    })
    expect(result.members[0]).toMatchObject({
      examStatus: 'awaiting_manual',
      courseStatus: 'in_progress',
      passed: false,
    })
  })

  it('returns a closed assignment DTO plus member progress without hidden values', async () => {
    const { db, mem } = createMemoryDb({
      members: [
        {
          id: MEMBER_C,
          orgId: ORG,
          assignmentId: ASSIGNMENT,
          userId: USER_C,
          source: 'import',
          assignedAt: '2026-01-01T00:00:00.000Z',
          revokedAt: '2026-02-01T00:00:00.000Z',
          revokedBy: ACTOR,
          revocationReason: 'left the team',
          overdue: false,
          videoStatus: 'completed',
          examStatus: 'graded',
          passed: true,
        },
        {
          id: MEMBER_A,
          orgId: ORG,
          assignmentId: ASSIGNMENT,
          userId: USER_A,
          source: 'manual',
          assignedAt: '2026-01-03T00:00:00.000Z',
          revokedAt: null,
          revokedBy: null,
          revocationReason: null,
          overdue: true,
          videoStatus: null,
          examStatus: null,
          passed: false,
        },
        {
          id: MEMBER_B,
          orgId: ORG,
          assignmentId: ASSIGNMENT,
          userId: USER_B,
          source: 'rule',
          assignedAt: '2026-01-02T00:00:00.000Z',
          revokedAt: null,
          revokedBy: null,
          revocationReason: null,
          overdue: true,
          videoStatus: 'in_progress',
          examStatus: 'started',
          passed: false,
        },
      ],
    })
    const result = await listElearningAssignmentProgress(db, {
      orgId: ` ${ORG} `,
      assignmentId: ASSIGNMENT.toUpperCase(),
    })
    expect(result).toEqual({
      assignmentId: ASSIGNMENT,
      courseVersionId: VERSION,
      deadline: '2026-01-01T00:00:00.000Z',
      members: [
        {
          memberId: MEMBER_A,
          userId: USER_A,
          source: 'manual',
          assignedAt: '2026-01-03T00:00:00.000Z',
          revokedAt: null,
          overdue: true,
          videoStatus: 'not_started',
          examStatus: 'not_started',
          passed: false,
          courseStatus: 'not_started',
        },
        {
          memberId: MEMBER_B,
          userId: USER_B,
          source: 'rule',
          assignedAt: '2026-01-02T00:00:00.000Z',
          revokedAt: null,
          overdue: true,
          videoStatus: 'in_progress',
          examStatus: 'started',
          passed: false,
          courseStatus: 'in_progress',
        },
        {
          memberId: MEMBER_C,
          userId: USER_C,
          source: 'import',
          assignedAt: '2026-01-01T00:00:00.000Z',
          revokedAt: '2026-02-01T00:00:00.000Z',
          overdue: false,
          videoStatus: 'completed',
          examStatus: 'graded',
          passed: true,
          courseStatus: 'completed',
        },
      ],
      nextCursor: null,
    })
    expect(JSON.stringify(result)).not.toMatch(/revocation_reason|revoked_by|left the team|auto_score|answer/i)
    expect(mem.queries[0]).toContain('elearning-lifecycle:lock-assignment')
  })

  it('paginates members with a deterministic UUID keyset and a max of 100', async () => {
    const members: MemberRow[] = [MEMBER_A, MEMBER_B, MEMBER_C, MEMBER_D].map((id, index) => ({
      id,
      orgId: ORG,
      assignmentId: ASSIGNMENT,
      userId: `user-${index}`,
      source: 'manual',
      assignedAt: `2026-01-0${4 - index}T00:00:00.000Z`,
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
      overdue: false,
      videoStatus: null,
      examStatus: null,
      passed: false,
    }))
    const { db } = createMemoryDb({ members })
    const first = await listElearningAssignmentProgress(db, {
      orgId: ORG,
      assignmentId: ASSIGNMENT,
      limit: 2,
    })
    expect(first.members.map((row) => row.memberId)).toEqual([MEMBER_A, MEMBER_B])
    expect(first.nextCursor).toBe(MEMBER_B)
    const second = await listElearningAssignmentProgress(db, {
      orgId: ORG,
      assignmentId: ASSIGNMENT,
      cursor: first.nextCursor,
      limit: 2,
    })
    expect(second.members.map((row) => row.memberId)).toEqual([MEMBER_C, MEMBER_D])
    expect(second.nextCursor).toBeNull()
    expect(ELEARNING_ASSIGNMENT_PROGRESS_LIMIT).toBe(100)
  })

  it('treats an expired deadline as overdue without implying revocation', async () => {
    const { db } = createMemoryDb()
    const result = await listElearningAssignmentProgress(db, {
      orgId: ORG,
      assignmentId: ASSIGNMENT,
    })
    expect(result.members[0]?.overdue).toBe(true)
    expect(result.members[0]?.revokedAt).toBeNull()
  })

  it('derives in-progress course status when video is complete but the exam is not passed', async () => {
    const { db } = createMemoryDb({
      members: [{
        id: MEMBER_A,
        orgId: ORG,
        assignmentId: ASSIGNMENT,
        userId: USER_A,
        source: 'manual',
        assignedAt: '2026-01-02T00:00:00.000Z',
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
        overdue: false,
        videoStatus: 'completed',
        examStatus: 'graded',
        passed: false,
      }],
    })
    const result = await listElearningAssignmentProgress(db, {
      orgId: ORG,
      assignmentId: ASSIGNMENT,
    })
    expect(result.members[0]?.courseStatus).toBe('in_progress')
    expect(result.members[0]?.passed).toBe(false)
  })

  it('returns not_found for a missing or cross-org assignment', async () => {
    const { db } = createMemoryDb()
    await expect(listElearningAssignmentProgress(db, {
      orgId: ORG_B,
      assignmentId: ASSIGNMENT,
    })).rejects.toMatchObject({ code: 'not_found' })
    await expect(listElearningAssignmentProgress(db, {
      orgId: ORG,
      assignmentId: ASSIGNMENT_B,
    })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects invalid identity, cursor, and limit before querying', async () => {
    const { db, mem } = createMemoryDb()
    await expect(listElearningAssignmentProgress(db, {
      orgId: ' ',
      assignmentId: ASSIGNMENT,
    })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(listElearningAssignmentProgress(db, {
      orgId: ORG,
      assignmentId: 'not-a-uuid',
    })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(listElearningAssignmentProgress(db, {
      orgId: ORG,
      assignmentId: ASSIGNMENT,
      cursor: 'bad',
    })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(listElearningAssignmentProgress(db, {
      orgId: ORG,
      assignmentId: ASSIGNMENT,
      limit: 0,
    })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(listElearningAssignmentProgress(db, {
      orgId: ORG,
      assignmentId: ASSIGNMENT,
      limit: 101,
    })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(mem.queries).toHaveLength(0)
  })

  it('maps unexpected database failures to unavailable without leaking values', async () => {
    const { db } = createMemoryDb({ failTag: 'elearning-lifecycle:lock-assignment' })
    await expect(listElearningAssignmentProgress(db, {
      orgId: ORG,
      assignmentId: ASSIGNMENT,
    })).rejects.toEqual(new ElearningAssignmentLifecycleError('unavailable'))
  })
})

describe('revokeElearningAssignmentMember', () => {
  it('sets the revoke triplet once and replays the same normalized reason as duplicate', async () => {
    const { db, mem } = createMemoryDb()
    const first = await revokeElearningAssignmentMember(db, {
      orgId: ORG,
      actorId: ACTOR,
      assignmentId: ASSIGNMENT,
      memberId: MEMBER_A,
      reason: '  left team  ',
    })
    expect(first).toEqual({
      assignmentId: ASSIGNMENT,
      memberId: MEMBER_A,
      revoked: true,
      duplicate: false,
    })
    expect(mem.members[0]?.revokedBy).toBe(ACTOR)
    expect(mem.members[0]?.revocationReason).toBe('left team')
    expect(mem.members[0]?.revokedAt).toBeTruthy()
    expect(mem.progress).toEqual([{ memberId: MEMBER_A, status: 'in_progress' }])
    expect(mem.evidence).toEqual([{ memberId: MEMBER_A }])
    expect(mem.assignments).toHaveLength(1)

    const replay = await revokeElearningAssignmentMember(db, {
      orgId: ORG,
      actorId: 'other-actor',
      assignmentId: ASSIGNMENT,
      memberId: MEMBER_A,
      reason: 'left team',
    })
    expect(replay.duplicate).toBe(true)
    expect(mem.members[0]?.revokedBy).toBe(ACTOR)
    expect(mem.members.filter((row) => row.id === MEMBER_A)).toHaveLength(1)
  })

  it('conflicts when a later reason does not match the stored normalized reason', async () => {
    const { db } = createMemoryDb({
      members: [{
        id: MEMBER_A,
        orgId: ORG,
        assignmentId: ASSIGNMENT,
        userId: USER_A,
        source: 'manual',
        assignedAt: '2026-01-02T00:00:00.000Z',
        revokedAt: '2026-02-01T00:00:00.000Z',
        revokedBy: ACTOR,
        revocationReason: 'left team',
        overdue: false,
        videoStatus: null,
        examStatus: null,
        passed: false,
      }],
    })
    await expect(revokeElearningAssignmentMember(db, {
      orgId: ORG,
      actorId: ACTOR,
      assignmentId: ASSIGNMENT,
      memberId: MEMBER_A,
      reason: 'different reason',
    })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('requires the plan-level operation for a training-plan child member', async () => {
    const { db, mem } = createMemoryDb({
      planAssignmentByChild: {
        [ASSIGNMENT]: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      },
    })
    await expect(revokeElearningAssignmentMember(db, {
      orgId: ORG,
      actorId: ACTOR,
      assignmentId: ASSIGNMENT,
      memberId: MEMBER_A,
      reason: 'wrong cohort',
    })).rejects.toEqual(new ElearningAssignmentLifecycleError('conflict'))
    expect(mem.members[0]?.revokedAt).toBeNull()
    expect(mem.queries.some((query) => query.includes('elearning-lifecycle:revoke-member')))
      .toBe(false)
  })

  it('returns not_found for a cross-org row or a member that belongs to another assignment', async () => {
    const { db } = createMemoryDb({
      assignments: [
        {
          id: ASSIGNMENT,
          orgId: ORG,
          courseVersionId: VERSION,
          deadline: null,
        },
        {
          id: ASSIGNMENT_B,
          orgId: ORG,
          courseVersionId: VERSION,
          deadline: null,
        },
      ],
      members: [
        {
          id: MEMBER_A,
          orgId: ORG,
          assignmentId: ASSIGNMENT,
          userId: USER_A,
          source: 'manual',
          assignedAt: '2026-01-02T00:00:00.000Z',
          revokedAt: null,
          revokedBy: null,
          revocationReason: null,
          overdue: false,
          videoStatus: null,
          examStatus: null,
          passed: false,
        },
        {
          id: MEMBER_B,
          orgId: ORG,
          assignmentId: ASSIGNMENT_B,
          userId: USER_B,
          source: 'manual',
          assignedAt: '2026-01-02T00:00:00.000Z',
          revokedAt: null,
          revokedBy: null,
          revocationReason: null,
          overdue: false,
          videoStatus: null,
          examStatus: null,
          passed: false,
        },
      ],
    })
    await expect(revokeElearningAssignmentMember(db, {
      orgId: ORG_B,
      actorId: ACTOR,
      assignmentId: ASSIGNMENT,
      memberId: MEMBER_A,
      reason: 'left team',
    })).rejects.toMatchObject({ code: 'not_found' })
    await expect(revokeElearningAssignmentMember(db, {
      orgId: ORG,
      actorId: ACTOR,
      assignmentId: ASSIGNMENT,
      memberId: MEMBER_B,
      reason: 'left team',
    })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects an empty, oversized, or non-string reason before writing', async () => {
    const { db, mem } = createMemoryDb()
    await expect(revokeElearningAssignmentMember(db, {
      orgId: ORG,
      actorId: ACTOR,
      assignmentId: ASSIGNMENT,
      memberId: MEMBER_A,
      reason: '   ',
    })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(revokeElearningAssignmentMember(db, {
      orgId: ORG,
      actorId: ACTOR,
      assignmentId: ASSIGNMENT,
      memberId: MEMBER_A,
      reason: 'x'.repeat(ELEARNING_REVOCATION_REASON_MAX + 1),
    })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(revokeElearningAssignmentMember(db, {
      orgId: ORG,
      actorId: ACTOR,
      assignmentId: ASSIGNMENT,
      memberId: MEMBER_A,
      reason: 1 as never,
    })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(mem.members[0]?.revokedAt).toBeNull()
    expect(mem.queries).toHaveLength(0)
  })

  it('locks the same-org member row and maps database failures to unavailable', async () => {
    const { db, mem } = createMemoryDb()
    await revokeElearningAssignmentMember(db, {
      orgId: ORG,
      actorId: ACTOR,
      assignmentId: ASSIGNMENT,
      memberId: MEMBER_A,
      reason: 'left team',
    })
    expect(mem.queries[0]).toContain('elearning-lifecycle:revoke-lock')
    expect(elearningAssignmentRevokeLockKey(ORG, ASSIGNMENT, MEMBER_A)).toBe(
      `elearning-revoke:${ORG}:${ASSIGNMENT}:${MEMBER_A}`,
    )

    const failing = createMemoryDb({ failTag: 'elearning-lifecycle:load-member' })
    await expect(revokeElearningAssignmentMember(failing.db, {
      orgId: ORG,
      actorId: ACTOR,
      assignmentId: ASSIGNMENT,
      memberId: MEMBER_A,
      reason: 'left team',
    })).rejects.toEqual(new ElearningAssignmentLifecycleError('unavailable'))
  })
})
