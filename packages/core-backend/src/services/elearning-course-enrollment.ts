import { createHash, randomUUID } from 'node:crypto'

import {
  ElearningCourseAccessError,
  resolveElearningCourseAccess,
} from './elearning-course-access'

export const ELEARNING_COURSE_ENROLLMENT_REQUEST_DOMAIN =
  'elearning.course.enrollment.request.v1' as const
export const ELEARNING_COURSE_ENROLLMENT_REQUEST_HASH_VERSION = 1 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTOR_MAX = 256

export type ElearningCourseEnrollmentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'not_enrollable'
  | 'already_assigned'
  | 'conflict'
  | 'unavailable'

export class ElearningCourseEnrollmentError extends Error {
  constructor(readonly code: ElearningCourseEnrollmentErrorCode) {
    super(code)
    this.name = 'ElearningCourseEnrollmentError'
  }
}

export interface ElearningCourseEnrollmentQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningCourseEnrollmentDb {
  transaction<T>(
    handler: (tx: ElearningCourseEnrollmentQueryable) => Promise<T>,
  ): Promise<T>
}

export interface EnrollElearningCourseInput {
  orgId: string
  userId: string
  requestId: string
  courseId: string
}

export interface ElearningCourseEnrollmentResult {
  enrollmentId: string
  courseId: string
  courseVersionId: string
  status: 'enrolled'
  enrolledAt: string
}

interface CanonicalEnrollmentInput {
  orgId: string
  userId: string
  requestId: string
  courseId: string
}

interface PreparedEnrollmentInput extends CanonicalEnrollmentInput {
  requestHash: string
  enrolledAt: string
}

function fail(code: ElearningCourseEnrollmentErrorCode): never {
  throw new ElearningCourseEnrollmentError(code)
}

function requireActor(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const normalized = value.trim()
  if (normalized === '' || normalized.length > ACTOR_MAX || normalized.includes('\0')) {
    fail('invalid_input')
  }
  return normalized
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function storedUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function storedText(value: unknown): string {
  if (typeof value !== 'string' || value === '') fail('unavailable')
  return value
}

function storedInteger(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : null
  if (parsed === null || !Number.isSafeInteger(parsed)) fail('unavailable')
  return parsed
}

function storedTimestamp(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value !== 'string') fail('unavailable')
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) fail('unavailable')
  return parsed.toISOString()
}

function canonicalizeInput(input: EnrollElearningCourseInput): CanonicalEnrollmentInput {
  return {
    orgId: requireActor(input.orgId),
    userId: requireActor(input.userId),
    requestId: requireUuid(input.requestId),
    courseId: requireUuid(input.courseId),
  }
}

function hashCanonicalInput(input: CanonicalEnrollmentInput): string {
  return createHash('sha256').update(JSON.stringify({
    courseId: input.courseId,
    domain: ELEARNING_COURSE_ENROLLMENT_REQUEST_DOMAIN,
    userId: input.userId,
    version: ELEARNING_COURSE_ENROLLMENT_REQUEST_HASH_VERSION,
  }), 'utf8').digest('hex')
}

export function prepareElearningCourseEnrollment(
  input: EnrollElearningCourseInput,
  now: Date = new Date(),
): PreparedEnrollmentInput {
  const canonical = canonicalizeInput(input)
  if (Number.isNaN(now.getTime())) fail('invalid_input')
  return {
    ...canonical,
    requestHash: hashCanonicalInput(canonical),
    enrolledAt: now.toISOString(),
  }
}

function mapEnrollment(row: Record<string, unknown>): ElearningCourseEnrollmentResult {
  return {
    enrollmentId: storedUuid(row.id),
    courseId: storedUuid(row.course_id),
    courseVersionId: storedUuid(row.course_version_id),
    status: 'enrolled',
    enrolledAt: storedTimestamp(row.enrolled_at),
  }
}

function assertReplay(
  row: Record<string, unknown>,
  prepared: PreparedEnrollmentInput,
): ElearningCourseEnrollmentResult {
  if (
    storedText(row.request_hash) !== prepared.requestHash
    || storedInteger(row.request_hash_version)
      !== ELEARNING_COURSE_ENROLLMENT_REQUEST_HASH_VERSION
  ) fail('conflict')
  return mapEnrollment(row)
}

async function readRequestReplay(
  tx: ElearningCourseEnrollmentQueryable,
  prepared: PreparedEnrollmentInput,
): Promise<ElearningCourseEnrollmentResult | null> {
  const replay = await tx.query(
    `/* elearning-enrollment:request-replay */
     SELECT id, course_id, course_version_id, request_hash,
            request_hash_version, enrolled_at
       FROM elearning_course_enrollments
      WHERE org_id = $1 AND user_id = $2 AND request_id = $3
      FOR SHARE`,
    [prepared.orgId, prepared.userId, prepared.requestId],
  )
  const row = replay.rows[0]
  return row ? assertReplay(row, prepared) : null
}

async function resolveCurrentVisibleCourse(
  tx: ElearningCourseEnrollmentQueryable,
  prepared: PreparedEnrollmentInput,
): Promise<{ courseVersionId: string; scopeRevisionRuleId: string }> {
  const head = await tx.query(
    `/* elearning-enrollment:lock-course-head */
     SELECT c.active_version_id, c.status AS course_status
       FROM elearning_courses c
      WHERE c.org_id = $1 AND c.id = $2
      FOR SHARE OF c`,
    [prepared.orgId, prepared.courseId],
  )
  const row = head.rows[0]
  if (!row) fail('not_found')
  if (row.course_status !== 'active' || row.active_version_id === null) {
    fail('not_enrollable')
  }
  const courseVersionId = storedUuid(row.active_version_id)
  const version = await tx.query(
    `/* elearning-enrollment:lock-active-version */
     SELECT status
       FROM elearning_course_versions
      WHERE org_id = $1 AND course_id = $2 AND id = $3
      FOR SHARE`,
    [prepared.orgId, prepared.courseId, courseVersionId],
  )
  if (version.rows[0]?.status !== 'published') fail('not_enrollable')

  const assignment = await tx.query(
    `/* elearning-enrollment:reject-assigned-course */
     SELECT member.id
       FROM elearning_assignment_members member
       JOIN elearning_course_versions version
         ON version.org_id = member.org_id
        AND version.id = member.course_version_id
      WHERE member.org_id = $1
        AND member.user_id = $2
        AND version.course_id = $3
        AND member.revoked_at IS NULL
      ORDER BY member.assigned_at ASC, member.id ASC
      LIMIT 1
      FOR SHARE OF member`,
    [prepared.orgId, prepared.userId, prepared.courseId],
  )
  if (assignment.rows[0]) fail('already_assigned')

  try {
    const access = await resolveElearningCourseAccess(tx, {
      orgId: prepared.orgId,
      userId: prepared.userId,
      courseVersionId,
    })
    if (
      access.courseId !== prepared.courseId
      || access.courseVersionId !== courseVersionId
      || access.basis.kind !== 'visibility'
    ) fail('not_enrollable')
    return {
      courseVersionId,
      scopeRevisionRuleId: access.basis.scopeRevisionRuleId,
    }
  } catch (error) {
    if (error instanceof ElearningCourseEnrollmentError) throw error
    if (error instanceof ElearningCourseAccessError) {
      if (error.code === 'not_found') fail('not_found')
      if (
        error.code === 'denied'
        || error.code === 'withdrawn'
        || error.code === 'unsupported_version'
      ) fail('not_enrollable')
      fail('unavailable')
    }
    throw error
  }
}

async function readConcurrentResult(
  tx: ElearningCourseEnrollmentQueryable,
  prepared: PreparedEnrollmentInput,
): Promise<ElearningCourseEnrollmentResult> {
  const result = await tx.query(
    `/* elearning-enrollment:concurrent-result */
     SELECT id, course_id, course_version_id, request_id, request_hash,
            request_hash_version, enrolled_at
       FROM elearning_course_enrollments
      WHERE org_id = $1
        AND user_id = $2
        AND (request_id = $3 OR course_id = $4)
      ORDER BY (request_id = $3) DESC, enrolled_at ASC, id ASC
      FOR SHARE`,
    [prepared.orgId, prepared.userId, prepared.requestId, prepared.courseId],
  )
  const requestRow = result.rows.find(
    (row) => storedUuid(row.request_id) === prepared.requestId,
  )
  if (requestRow) return assertReplay(requestRow, prepared)
  const courseRow = result.rows.find(
    (row) => storedUuid(row.course_id) === prepared.courseId,
  )
  if (courseRow) return mapEnrollment(courseRow)
  fail('unavailable')
}

export async function enrollElearningCourse(
  db: ElearningCourseEnrollmentDb,
  input: EnrollElearningCourseInput,
  options: { now?: () => Date; id?: () => string } = {},
): Promise<ElearningCourseEnrollmentResult> {
  const prepared = prepareElearningCourseEnrollment(input, options.now?.() ?? new Date())
  try {
    return await db.transaction(async (tx) => {
      const replay = await readRequestReplay(tx, prepared)
      if (replay) return replay

      const access = await resolveCurrentVisibleCourse(tx, prepared)
      const existing = await tx.query(
        `/* elearning-enrollment:existing-course */
         SELECT id, course_id, course_version_id, enrolled_at
           FROM elearning_course_enrollments
          WHERE org_id = $1 AND user_id = $2 AND course_id = $3
          FOR SHARE`,
        [prepared.orgId, prepared.userId, prepared.courseId],
      )
      if (existing.rows[0]) return mapEnrollment(existing.rows[0])

      const inserted = await tx.query(
        `/* elearning-enrollment:append */
         INSERT INTO elearning_course_enrollments (
           id, org_id, user_id, course_id, course_version_id,
           scope_revision_rule_id, request_id, request_hash,
           request_hash_version, enrolled_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)
         ON CONFLICT DO NOTHING
         RETURNING id, course_id, course_version_id, enrolled_at`,
        [
          options.id?.() ?? randomUUID(),
          prepared.orgId,
          prepared.userId,
          prepared.courseId,
          access.courseVersionId,
          access.scopeRevisionRuleId,
          prepared.requestId,
          prepared.requestHash,
          ELEARNING_COURSE_ENROLLMENT_REQUEST_HASH_VERSION,
          prepared.enrolledAt,
        ],
      )
      return inserted.rows[0]
        ? mapEnrollment(inserted.rows[0])
        : readConcurrentResult(tx, prepared)
    })
  } catch (error) {
    if (error instanceof ElearningCourseEnrollmentError) throw error
    fail('unavailable')
  }
}
