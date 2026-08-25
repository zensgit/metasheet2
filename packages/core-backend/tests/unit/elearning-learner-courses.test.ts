import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ELEARNING_MEDIA_MIME } from '../../src/services/elearning-media-validation'
import {
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
} from '../../src/services/elearning-watch-progress'
import {
  ELEARNING_LEARNER_COURSES_LIMIT,
  ElearningLearnerCoursesError,
  listElearningLearnerCourses,
  type ElearningLearnerCourse,
  type ElearningLearnerCoursesQueryable,
} from '../../src/services/elearning-learner-courses'

const ORG = 'org-learner-1'
const ORG_B = 'org-learner-2'
const USER = 'user-learner-1'
const USER_B = 'user-learner-2'
const COURSE = '11111111-1111-4111-8111-111111111111'
const COURSE_B = '12121212-1212-4121-8121-121212121212'
const VERSION = '22222222-2222-4222-8222-222222222222'
const VERSION_B = '23232323-2323-4232-8232-232323232323'
const VIDEO = '33333333-3333-4333-8333-333333333333'
const EXAM_ITEM = '44444444-4444-4444-8444-444444444444'
const ATTEMPT = '55555555-5555-4555-8555-555555555555'
const ATTEMPT_B = '56565656-5656-4565-8565-565656565656'
const ASSIGNED_AT = '2026-01-02T03:04:05.000Z'
const DEADLINE = '2026-12-31T08:00:00.000Z'
const COMPLETED_AT = '2026-01-03T04:05:06.000Z'
const STARTED_AT = '2026-01-04T05:06:07.000Z'
const SUBMITTED_AT = '2026-01-04T05:16:07.000Z'
const GRADED_AT = '2026-01-04T05:16:08.000Z'
const TITLE = 'Pilot assigned course'

const SERVICE_SOURCE = path.join(
  __dirname,
  '../../src/services/elearning-learner-courses.ts',
)

const PUBLIC_COURSE_KEYS = [
  'courseId',
  'courseVersionId',
  'title',
  'assignment',
  'video',
  'exam',
  'completed',
] as const

const PUBLIC_ASSIGNMENT_KEYS = ['deadline', 'assignedAt'] as const
const PUBLIC_VIDEO_KEYS = [
  'itemId',
  'durationMs',
  'status',
  'effectiveMs',
  'maxPositionMs',
  'completedAt',
] as const
const PUBLIC_EXAM_KEYS = ['itemId', 'latestAttempt'] as const
const PUBLIC_ATTEMPT_KEYS = [
  'attemptId',
  'attemptNo',
  'status',
  'autoScore',
  'totalScore',
  'passed',
  'startedAt',
  'submittedAt',
  'gradedAt',
] as const

const SECRET_TOKENS = [
  'storage_key',
  'sha256',
  'paper_snapshot',
  'answers',
  'answer_key',
  'answerKey',
  'explanation',
  'details',
  ORG,
  ORG_B,
  USER,
  USER_B,
]

function tagOf(sql: string): string | null {
  const match = /\/\* (elearning-learner-courses:[a-z-]+) \*\//.exec(sql)
  return match ? match[1] : null
}

function assertValuesFree(error: unknown): void {
  expect(error).toBeInstanceOf(ElearningLearnerCoursesError)
  const err = error as ElearningLearnerCoursesError
  const blob = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`
  for (const token of SECRET_TOKENS) {
    expect(blob).not.toContain(token)
  }
  expect(err.message).toBe(err.code)
}

async function expectAsyncCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect((error as ElearningLearnerCoursesError).code).toBe(code)
    assertValuesFree(error)
  }
}

function assertPublicCourse(payload: unknown): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
  expect(Object.keys(raw)).toEqual([...PUBLIC_COURSE_KEYS])
  const assignment = raw.assignment as Record<string, unknown>
  const video = raw.video as Record<string, unknown>
  const exam = raw.exam as Record<string, unknown>
  expect(Object.keys(assignment)).toEqual([...PUBLIC_ASSIGNMENT_KEYS])
  expect(Object.keys(video)).toEqual([...PUBLIC_VIDEO_KEYS])
  expect(Object.keys(exam)).toEqual([...PUBLIC_EXAM_KEYS])
  if (exam.latestAttempt !== null) {
    expect(Object.keys(exam.latestAttempt as Record<string, unknown>)).toEqual([
      ...PUBLIC_ATTEMPT_KEYS,
    ])
  }
  const blob = JSON.stringify(raw)
  for (const token of SECRET_TOKENS) {
    expect(blob).not.toContain(token)
  }
  expect(blob).not.toContain('storageKey')
  expect(blob).not.toContain('paperSnapshot')
  expect(blob).not.toContain('answerKey')
  return raw
}

function baseRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    course_id: COURSE,
    course_version_id: VERSION,
    title: TITLE,
    assignment_deadline: DEADLINE,
    assignment_assigned_at: ASSIGNED_AT,
    video_item_id: VIDEO,
    video_duration_ms: 10_000,
    video_status: null,
    video_effective_ms: null,
    video_max_position_ms: null,
    video_completed_at: null,
    exam_item_id: EXAM_ITEM,
    attempt_id: null,
    attempt_no: null,
    attempt_status: null,
    attempt_auto_score: null,
    attempt_total_score: null,
    attempt_passed: null,
    attempt_started_at: null,
    attempt_submitted_at: null,
    attempt_graded_at: null,
    any_passed: false,
    ...over,
  }
}

function createMemoryDb(rows: Array<Record<string, unknown>> | Error): {
  db: ElearningLearnerCoursesQueryable
  queries: string[]
  params: unknown[][]
} {
  const queries: string[] = []
  const params: unknown[][] = []
  return {
    queries,
    params,
    db: {
      query: async (sql, queryParams = []) => {
        queries.push(sql)
        params.push(queryParams)
        expect(tagOf(sql)).toBe('elearning-learner-courses:list')
        if (rows instanceof Error) throw rows
        return { rows, rowCount: rows.length }
      },
    },
  }
}

describe('elearning learner courses source SQL', () => {
  it('pins one bounded DISTINCT ON list with explicit aliases, V0.1 media, and redacted columns', async () => {
    const source = await fs.readFile(SERVICE_SOURCE, 'utf8')
    expect(source).toContain('/* elearning-learner-courses:list */')
    expect(source).toContain('SELECT DISTINCT ON (m.course_version_id)')
    expect(source).toContain('m.org_id = $1')
    expect(source).toContain('m.user_id = $2')
    expect(source).toContain('m.revoked_at IS NULL')
    expect(source).toContain("c.status IN ('active', 'archived')")
    expect(source).toContain("v.status IN ('published', 'retired')")
    expect(source).toContain("i.item_type = 'video'")
    expect(source).toContain("i.item_type = 'exam'")
    expect(source).toContain('i.completion_policy_version = \'${ELEARNING_WATCH_POLICY_VERSION}\'')
    expect(source).toContain('i.completion_threshold_bps = ${ELEARNING_WATCH_THRESHOLD_BPS}')
    expect(source).toContain("media.status = 'ready'")
    expect(source).toContain('media.mime_type = \'${ELEARNING_MEDIA_MIME}\'')
    expect(source).toContain('media.magic_mime_type = \'${ELEARNING_MEDIA_MIME}\'')
    expect(source).toContain('media.duration_ms IS NOT NULL')
    expect(source).toContain('media.duration_ms > 0')
    expect(source).toContain('ORDER BY i.position ASC, i.id ASC')
    expect(source).toContain("e.status IN ('published', 'retired')")
    expect(source).toContain('ORDER BY att.attempt_no DESC, att.id DESC')
    expect(source).toContain('EXISTS (')
    expect(source).toContain('any_pass.org_id = $1')
    expect(source).toContain('any_pass.user_id = $2')
    expect(source).toContain('any_pass.exam_id = exam.exam_id')
    expect(source).toContain('any_pass.course_version_id = v.id')
    expect(source).toContain('any_pass.course_version_item_id = exam.item_id')
    expect(source).toContain('att.course_version_item_id = exam.item_id')
    expect(source).toContain("any_pass.status = 'graded'")
    expect(source).toContain('any_pass.passed IS TRUE')
    expect(source).toContain(') AS any_passed')
    expect(source).toContain('ORDER BY assigned_heads.assigned_at ASC, assigned_heads.course_version_id ASC')
    expect(source).toContain('LIMIT ${ELEARNING_LEARNER_COURSES_LIMIT}')
    expect(source).toContain('c.id AS course_id')
    expect(source).toContain('v.id AS course_version_id')
    expect(source).toContain('c.title AS title')
    expect(source).toContain('assigned_heads.deadline AS assignment_deadline')
    expect(source).toContain('assigned_heads.assigned_at AS assignment_assigned_at')
    expect(source).toContain('video.item_id AS video_item_id')
    expect(source).toContain('exam.item_id AS exam_item_id')
    expect(source).not.toMatch(/SELECT\s+\*/)
    expect(source).not.toContain('storage_key')
    expect(source).not.toContain('sha256')
    expect(source).not.toContain('paper_snapshot')
    expect(source).not.toContain('answers')
    expect(source).not.toContain('answer_key')
    expect(source).not.toContain('explanation')
    expect(source).not.toContain('grading')
    expect(source).not.toMatch(/deadline\s*[<>]/)
    expect(source).not.toContain('now()')
    expect(ELEARNING_LEARNER_COURSES_LIMIT).toBe(100)
  })
})

describe('elearning learner courses input and SQL dispatch', () => {
  it('rejects blank actors as values-free invalid_input without querying', async () => {
    const { db, queries } = createMemoryDb([])
    await expectAsyncCode(
      () => listElearningLearnerCourses(db, { orgId: ' ', userId: USER }),
      'invalid_input',
    )
    await expectAsyncCode(
      () => listElearningLearnerCourses(db, { orgId: ORG, userId: '' }),
      'invalid_input',
    )
    await expectAsyncCode(
      () => listElearningLearnerCourses(db, { orgId: ORG as unknown as string, userId: 1 as unknown as string }),
      'invalid_input',
    )
    expect(queries).toEqual([])
  })

  it('sends exact org+user params and the tagged list SQL once', async () => {
    const { db, queries, params } = createMemoryDb([])
    await expect(listElearningLearnerCourses(db, {
      orgId: ` ${ORG} `,
      userId: ` ${USER} `,
    })).resolves.toEqual([])
    expect(queries).toHaveLength(1)
    expect(tagOf(queries[0])).toBe('elearning-learner-courses:list')
    expect(params).toEqual([[ORG, USER]])
    expect(queries[0]).toContain('LIMIT 100')
    expect(queries[0]).toContain('DISTINCT ON (m.course_version_id)')
    expect(queries[0]).toContain('revoked_at IS NULL')
    expect(queries[0]).toContain(`i.completion_policy_version = '${ELEARNING_WATCH_POLICY_VERSION}'`)
    expect(queries[0]).toContain(`i.completion_threshold_bps = ${ELEARNING_WATCH_THRESHOLD_BPS}`)
    expect(queries[0]).toContain(`media.mime_type = '${ELEARNING_MEDIA_MIME}'`)
    expect(queries[0]).toContain(`media.magic_mime_type = '${ELEARNING_MEDIA_MIME}'`)
    expect(queries[0]).toContain('EXISTS (')
    expect(queries[0]).toContain("any_pass.status = 'graded'")
    expect(queries[0]).toContain('any_pass.passed IS TRUE')
    expect(queries[0]).toContain(') AS any_passed')
  })

  it('maps query failures to values-free unavailable', async () => {
    const { db } = createMemoryDb(new Error(`${ORG} ${USER} storage_key leaked`))
    await expectAsyncCode(
      () => listElearningLearnerCourses(db, { orgId: ORG, userId: USER }),
      'unavailable',
    )
  })
})

describe('elearning learner courses public mapping', () => {
  it('returns the exact public DTO for an assigned not-started course and keeps expired deadlines', async () => {
    const { db } = createMemoryDb([baseRow({
      assignment_deadline: '2000-01-01T00:00:00.000Z',
      course_id: COURSE.toUpperCase(),
      course_version_id: VERSION.toUpperCase(),
      video_item_id: VIDEO.toUpperCase(),
      exam_item_id: EXAM_ITEM.toUpperCase(),
      storage_key: 'secret/key',
      sha256: 'abc',
      paper_snapshot: { explanation: 'no' },
      answers: { a: ['b'] },
      answer_key: { correct: ['a'] },
      explanation: 'secret rationale',
      org_id: ORG,
      user_id: USER,
    })])
    const rows = await listElearningLearnerCourses(db, { orgId: ORG, userId: USER })
    expect(rows).toHaveLength(1)
    const publicRow = assertPublicCourse(rows[0])
    expect(publicRow).toEqual({
      courseId: COURSE,
      courseVersionId: VERSION,
      title: TITLE,
      assignment: {
        deadline: '2000-01-01T00:00:00.000Z',
        assignedAt: ASSIGNED_AT,
      },
      video: {
        itemId: VIDEO,
        durationMs: 10_000,
        status: 'not_started',
        effectiveMs: 0,
        maxPositionMs: 0,
        completedAt: null,
      },
      exam: {
        itemId: EXAM_ITEM,
        latestAttempt: null,
      },
      completed: false,
    })
  })

  it('preserves assigned_at, version id order and collapses duplicate versions fail-closed', async () => {
    const { db } = createMemoryDb([
      baseRow({
        course_id: COURSE,
        course_version_id: VERSION,
        assignment_assigned_at: '2026-01-01T00:00:00.000Z',
      }),
      baseRow({
        course_id: COURSE_B,
        course_version_id: VERSION_B,
        assignment_assigned_at: '2026-01-02T00:00:00.000Z',
        video_item_id: 'abababab-abab-4aba-8aba-abababababab',
        exam_item_id: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd',
      }),
    ])
    const rows = await listElearningLearnerCourses(db, { orgId: ORG, userId: USER })
    expect(rows.map((row) => row.courseVersionId)).toEqual([VERSION, VERSION_B])

    const dup = createMemoryDb([baseRow(), baseRow()])
    await expectAsyncCode(
      () => listElearningLearnerCourses(dup.db, { orgId: ORG, userId: USER }),
      'unavailable',
    )
  })

  it('maps in-progress video and a started latest attempt without completing the course', async () => {
    const { db } = createMemoryDb([baseRow({
      video_status: 'in_progress',
      video_effective_ms: '1200',
      video_max_position_ms: 900,
      video_completed_at: null,
      attempt_id: ATTEMPT,
      attempt_no: 1,
      attempt_status: 'started',
      attempt_auto_score: null,
      attempt_total_score: null,
      attempt_passed: null,
      attempt_started_at: new Date(STARTED_AT),
      attempt_submitted_at: null,
      attempt_graded_at: null,
      any_passed: true,
    })])
    const [row] = await listElearningLearnerCourses(db, { orgId: ORG, userId: USER })
    const publicRow = assertPublicCourse(row) as unknown as ElearningLearnerCourse
    expect(publicRow.video).toEqual({
      itemId: VIDEO,
      durationMs: 10_000,
      status: 'in_progress',
      effectiveMs: 1200,
      maxPositionMs: 900,
      completedAt: null,
    })
    expect(publicRow.exam.latestAttempt).toEqual({
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      autoScore: null,
      totalScore: null,
      passed: null,
      startedAt: STARTED_AT,
      submittedAt: null,
      gradedAt: null,
    })
    expect(publicRow.completed).toBe(false)
  })

  it('sets completed true when video is completed and any graded attempt passed', async () => {
    const passing = createMemoryDb([baseRow({
      video_status: 'completed',
      video_effective_ms: 9000,
      video_max_position_ms: 10_000,
      video_completed_at: COMPLETED_AT,
      attempt_id: ATTEMPT_B,
      attempt_no: 2,
      attempt_status: 'graded',
      attempt_auto_score: '10.00',
      attempt_total_score: '10.00',
      attempt_passed: true,
      attempt_started_at: STARTED_AT,
      attempt_submitted_at: SUBMITTED_AT,
      attempt_graded_at: GRADED_AT,
      any_passed: true,
    })])
    const [done] = await listElearningLearnerCourses(passing.db, { orgId: ORG, userId: USER })
    assertPublicCourse(done)
    expect(done.completed).toBe(true)
    expect(done.exam.latestAttempt).toEqual({
      attemptId: ATTEMPT_B,
      attemptNo: 2,
      status: 'graded',
      autoScore: 10,
      totalScore: 10,
      passed: true,
      startedAt: STARTED_AT,
      submittedAt: SUBMITTED_AT,
      gradedAt: GRADED_AT,
    })

    const failed = createMemoryDb([baseRow({
      video_status: 'completed',
      video_effective_ms: 9000,
      video_max_position_ms: 10_000,
      video_completed_at: COMPLETED_AT,
      attempt_id: ATTEMPT,
      attempt_no: 1,
      attempt_status: 'graded',
      attempt_auto_score: 0,
      attempt_total_score: 10,
      attempt_passed: false,
      attempt_started_at: STARTED_AT,
      attempt_submitted_at: SUBMITTED_AT,
      attempt_graded_at: GRADED_AT,
      any_passed: false,
    })])
    const [notDone] = await listElearningLearnerCourses(failed.db, { orgId: ORG, userId: USER })
    expect(notDone.completed).toBe(false)

    const noAttempt = createMemoryDb([baseRow({
      video_status: 'completed',
      video_effective_ms: 9000,
      video_max_position_ms: 10_000,
      video_completed_at: COMPLETED_AT,
    })])
    const [videoOnly] = await listElearningLearnerCourses(noAttempt.db, { orgId: ORG, userId: USER })
    expect(videoOnly.completed).toBe(false)
  })

  it('keeps completed true across a started retake when any graded attempt already passed', async () => {
    const { db } = createMemoryDb([baseRow({
      video_status: 'completed',
      video_effective_ms: 9000,
      video_max_position_ms: 10_000,
      video_completed_at: COMPLETED_AT,
      attempt_id: ATTEMPT_B,
      attempt_no: 2,
      attempt_status: 'started',
      attempt_auto_score: null,
      attempt_total_score: null,
      attempt_passed: null,
      attempt_started_at: STARTED_AT,
      attempt_submitted_at: null,
      attempt_graded_at: null,
      any_passed: true,
    })])
    const [row] = await listElearningLearnerCourses(db, { orgId: ORG, userId: USER })
    const publicRow = assertPublicCourse(row) as unknown as ElearningLearnerCourse
    expect(publicRow.exam.latestAttempt).toEqual({
      attemptId: ATTEMPT_B,
      attemptNo: 2,
      status: 'started',
      autoScore: null,
      totalScore: null,
      passed: null,
      startedAt: STARTED_AT,
      submittedAt: null,
      gradedAt: null,
    })
    expect(publicRow.completed).toBe(true)
  })

  it('fail-closes malformed rows and over-limit results as unavailable', async () => {
    await expectAsyncCode(
      () => listElearningLearnerCourses(createMemoryDb([baseRow({ video_duration_ms: 0 })]).db, {
        orgId: ORG,
        userId: USER,
      }),
      'unavailable',
    )
    await expectAsyncCode(
      () => listElearningLearnerCourses(createMemoryDb([baseRow({ video_status: 'watched' })]).db, {
        orgId: ORG,
        userId: USER,
      }),
      'unavailable',
    )
    await expectAsyncCode(
      () => listElearningLearnerCourses(createMemoryDb([baseRow({
        video_status: 'completed',
        video_effective_ms: 1,
        video_max_position_ms: 1,
        video_completed_at: null,
      })]).db, { orgId: ORG, userId: USER }),
      'unavailable',
    )
    await expectAsyncCode(
      () => listElearningLearnerCourses(createMemoryDb([baseRow({
        attempt_id: ATTEMPT,
        attempt_no: 1,
        attempt_status: 'graded',
        attempt_auto_score: 10,
        attempt_total_score: 10,
        attempt_passed: true,
        attempt_started_at: STARTED_AT,
        attempt_submitted_at: SUBMITTED_AT,
        attempt_graded_at: null,
      })]).db, { orgId: ORG, userId: USER }),
      'unavailable',
    )
    await expectAsyncCode(
      () => listElearningLearnerCourses(createMemoryDb([baseRow({ title: '   ' })]).db, {
        orgId: ORG,
        userId: USER,
      }),
      'unavailable',
    )
    await expectAsyncCode(
      () => listElearningLearnerCourses(createMemoryDb([baseRow({ any_passed: 'true' })]).db, {
        orgId: ORG,
        userId: USER,
      }),
      'unavailable',
    )
    await expectAsyncCode(
      () => listElearningLearnerCourses(createMemoryDb([baseRow({ any_passed: 1 })]).db, {
        orgId: ORG,
        userId: USER,
      }),
      'unavailable',
    )
    await expectAsyncCode(
      () => listElearningLearnerCourses(createMemoryDb([baseRow({ any_passed: 't' })]).db, {
        orgId: ORG,
        userId: USER,
      }),
      'unavailable',
    )
    await expectAsyncCode(
      () => listElearningLearnerCourses(createMemoryDb([baseRow({ any_passed: null })]).db, {
        orgId: ORG,
        userId: USER,
      }),
      'unavailable',
    )
    const missingFlag = baseRow()
    delete missingFlag.any_passed
    await expectAsyncCode(
      () => listElearningLearnerCourses(createMemoryDb([missingFlag]).db, {
        orgId: ORG,
        userId: USER,
      }),
      'unavailable',
    )
    const overLimit = Array.from({ length: ELEARNING_LEARNER_COURSES_LIMIT + 1 }, (_, index) => {
      const suffix = index.toString(16).padStart(12, '0')
      return baseRow({
        course_id: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
        course_version_id: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
      })
    })
    await expectAsyncCode(
      () => listElearningLearnerCourses(createMemoryDb(overLimit).db, { orgId: ORG, userId: USER }),
      'unavailable',
    )
  })
})
