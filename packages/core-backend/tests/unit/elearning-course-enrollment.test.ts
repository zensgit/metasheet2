import { describe, expect, it } from 'vitest'

import {
  ELEARNING_COURSE_ENROLLMENT_REQUEST_HASH_VERSION,
  ElearningCourseEnrollmentError,
  enrollElearningCourse,
  prepareElearningCourseEnrollment,
  type ElearningCourseEnrollmentDb,
} from '../../src/services/elearning-course-enrollment'

const ORG = 'org-enrollment'
const USER = 'learner-enrollment'
const COURSE = '11111111-1111-4111-8111-111111111111'
const OTHER_COURSE = '11111111-1111-4111-8111-111111111112'
const VERSION = '22222222-2222-4222-8222-222222222222'
const SCOPE = '33333333-3333-4333-8333-333333333333'
const REVISION = '44444444-4444-4444-8444-444444444444'
const RULE = '55555555-5555-4555-8555-555555555555'
const REQUEST = '66666666-6666-4666-8666-666666666666'
const ENROLLMENT = '77777777-7777-4777-8777-777777777777'
const ENROLLED_AT = '2026-09-01T04:00:00.000Z'

type Handler = (
  sql: string,
  params: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>

function createDb(options: {
  assigned?: boolean
  visible?: boolean
  replay?: Record<string, unknown>
  existing?: Record<string, unknown>
  inserted?: Record<string, unknown> | null
} = {}): { db: ElearningCourseEnrollmentDb; sql: string[] } {
  const statements: string[] = []
  const handler: Handler = async (sql, params) => {
    statements.push(sql)
    if (sql.includes('elearning-enrollment:request-replay')) {
      return { rows: options.replay ? [options.replay] : [], rowCount: options.replay ? 1 : 0 }
    }
    if (sql.includes('elearning-enrollment:lock-course-head')) {
      return {
        rows: [{ active_version_id: VERSION, course_status: 'active' }],
        rowCount: 1,
      }
    }
    if (sql.includes('elearning-enrollment:lock-active-version')) {
      return { rows: [{ status: 'published' }], rowCount: 1 }
    }
    if (sql.includes('elearning-enrollment:reject-assigned-course')) {
      return { rows: options.assigned ? [{ id: ENROLLMENT }] : [], rowCount: options.assigned ? 1 : 0 }
    }
    if (sql.includes('elearning-access:lock-course')) {
      return {
        rows: [{
          course_id: COURSE,
          course_status: 'active',
          active_version_id: VERSION,
          scope_id: SCOPE,
          version_status: 'published',
        }],
        rowCount: 1,
      }
    }
    if (sql.includes('elearning-access:lock-assignment')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('elearning-access:lock-scope')) {
      return { rows: [{ active_revision_id: REVISION }], rowCount: 1 }
    }
    if (sql.includes('elearning-audience:load-revision-rules')) {
      return {
        rows: [{
          rule_id: RULE,
          scope_revision_id: REVISION,
          subject_type: 'all',
          subject_ref: null,
          include_children: false,
        }],
        rowCount: 1,
      }
    }
    if (sql.includes('elearning-audience:lock-principal')) {
      return { rows: [{ id: USER }], rowCount: 1 }
    }
    if (sql.includes('elearning-audience:resolve-membership')) {
      return options.visible === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{ rule_key: RULE, user_id: USER }], rowCount: 1 }
    }
    if (sql.includes('elearning-enrollment:existing-course')) {
      return { rows: options.existing ? [options.existing] : [], rowCount: options.existing ? 1 : 0 }
    }
    if (sql.includes('elearning-enrollment:append')) {
      const row = options.inserted === undefined
        ? { id: ENROLLMENT, course_id: COURSE, course_version_id: VERSION, enrolled_at: ENROLLED_AT }
        : options.inserted
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('elearning-enrollment:concurrent-result')) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`unexpected query ${String(params.length)}`)
  }
  const db: ElearningCourseEnrollmentDb = {
    transaction: async (callback) => callback({ query: (sql, params = []) => handler(sql, params) }),
  }
  return { db, sql: statements }
}

function input(courseId = COURSE) {
  return { orgId: ORG, userId: USER, requestId: REQUEST, courseId }
}

function storedReplay(courseId = COURSE, requestHash?: string): Record<string, unknown> {
  const prepared = prepareElearningCourseEnrollment(input(courseId), new Date(ENROLLED_AT))
  return {
    id: ENROLLMENT,
    course_id: courseId,
    course_version_id: VERSION,
    request_hash: requestHash ?? prepared.requestHash,
    request_hash_version: ELEARNING_COURSE_ENROLLMENT_REQUEST_HASH_VERSION,
    enrolled_at: ENROLLED_AT,
  }
}

describe('online course enrollment authority', () => {
  it('canonicalizes a versioned request hash and changes it with the course', () => {
    const first = prepareElearningCourseEnrollment(input(), new Date(ENROLLED_AT))
    const replay = prepareElearningCourseEnrollment(input(), new Date(ENROLLED_AT))
    const changed = prepareElearningCourseEnrollment(input(OTHER_COURSE), new Date(ENROLLED_AT))
    expect(first).toEqual(replay)
    expect(first.requestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(changed.requestHash).not.toBe(first.requestHash)
  })

  it('appends one audit-only enrollment from current visibility without assignment effects', async () => {
    const { db, sql } = createDb()
    await expect(enrollElearningCourse(db, input(), {
      now: () => new Date(ENROLLED_AT),
      id: () => ENROLLMENT,
    })).resolves.toEqual({
      enrollmentId: ENROLLMENT,
      courseId: COURSE,
      courseVersionId: VERSION,
      status: 'enrolled',
      enrolledAt: ENROLLED_AT,
    })
    expect(sql.some((statement) => statement.includes('elearning-enrollment:append'))).toBe(true)
    expect(sql.join('\n')).not.toMatch(/INSERT\s+INTO\s+elearning_(assignments|assignment_members|progress|credit)/i)
  })

  it('replays the exact stored result before access changes', async () => {
    const { db, sql } = createDb({ replay: storedReplay() })
    await expect(enrollElearningCourse(db, input())).resolves.toEqual({
      enrollmentId: ENROLLMENT,
      courseId: COURSE,
      courseVersionId: VERSION,
      status: 'enrolled',
      enrolledAt: ENROLLED_AT,
    })
    expect(sql).toHaveLength(1)
  })

  it('rejects the same request id with a different course as a values-free conflict', async () => {
    const priorHash = prepareElearningCourseEnrollment(input(), new Date(ENROLLED_AT)).requestHash
    const { db } = createDb({ replay: storedReplay(COURSE, priorHash) })
    await expect(enrollElearningCourse(db, input(OTHER_COURSE))).rejects.toMatchObject<
      Partial<ElearningCourseEnrollmentError>
    >({ code: 'conflict' })
  })

  it('rejects every active assignment for the course before writing enrollment', async () => {
    const { db, sql } = createDb({ assigned: true })
    await expect(enrollElearningCourse(db, input())).rejects.toMatchObject<
      Partial<ElearningCourseEnrollmentError>
    >({ code: 'already_assigned' })
    expect(sql.some((statement) => statement.includes('elearning-enrollment:append'))).toBe(false)
  })

  it('requires a current visibility match even when an immutable enrollment already exists', async () => {
    const { db, sql } = createDb({
      visible: false,
      existing: {
        id: ENROLLMENT,
        course_id: COURSE,
        course_version_id: VERSION,
        enrolled_at: ENROLLED_AT,
      },
    })
    await expect(enrollElearningCourse(db, {
      ...input(),
      requestId: '66666666-6666-4666-8666-666666666667',
    })).rejects.toMatchObject<Partial<ElearningCourseEnrollmentError>>({
      code: 'not_enrollable',
    })
    expect(sql.some((statement) => statement.includes('elearning-enrollment:existing-course'))).toBe(false)
  })

  it('returns the existing immutable enrollment for a new request only after rechecking visibility', async () => {
    const existing = {
      id: ENROLLMENT,
      course_id: COURSE,
      course_version_id: VERSION,
      enrolled_at: ENROLLED_AT,
    }
    const { db, sql } = createDb({ existing })
    await expect(enrollElearningCourse(db, {
      ...input(),
      requestId: '66666666-6666-4666-8666-666666666667',
    })).resolves.toMatchObject({ enrollmentId: ENROLLMENT, status: 'enrolled' })
    expect(sql.findIndex((statement) => statement.includes('elearning-audience:resolve-membership')))
      .toBeLessThan(sql.findIndex((statement) => statement.includes('elearning-enrollment:existing-course')))
    expect(sql.some((statement) => statement.includes('elearning-enrollment:append'))).toBe(false)
  })
})
