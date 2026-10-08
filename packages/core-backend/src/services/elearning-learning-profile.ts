/**
 * Learner-owned historical archive derived from authoritative completion and
 * exam ledgers. This service never creates a second completion truth.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANONICAL_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CURSOR_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/

export const ELEARNING_LEARNING_PROFILE_PAGE_DEFAULT = 50 as const
export const ELEARNING_LEARNING_PROFILE_PAGE_MAX = 100 as const

export type ElearningLearningProfileErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'unavailable'

export class ElearningLearningProfileError extends Error {
  constructor(readonly code: ElearningLearningProfileErrorCode) {
    super(code)
    this.name = 'ElearningLearningProfileError'
  }
}

export interface ElearningLearningProfileQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export type ElearningLearningProfileDb = ElearningLearningProfileQueryable

export interface GetElearningLearningProfileInput {
  orgId: string
  userId: string
  cursor?: string
  limit?: number
}

export interface ElearningLearningProfileExam {
  itemId: string
  earnedScore: number
  totalScore: number
  passedAt: string
}

export interface ElearningLearningProfileAssessmentCourse {
  courseId: string
  courseVersionId: string
  title: string
  kind: 'assessment'
  completedAt: string
  exams: ElearningLearningProfileExam[]
}

export interface ElearningLearningProfileContentCourse {
  courseId: string
  courseVersionId: string
  title: string
  kind: 'content'
  completedAt: string
}

export type ElearningLearningProfileCourse =
  | ElearningLearningProfileAssessmentCourse
  | ElearningLearningProfileContentCourse

export interface ElearningLearningProfileResult {
  userId: string
  summary: {
    completedCourses: number
    assessmentCourses: number
    contentCourses: number
  }
  courses: ElearningLearningProfileCourse[]
  nextCursor: string | null
}

interface Cursor {
  completedAt: string
  courseVersionId: string
}

const PROFILE_SQL = `/* elearning-learning-profile:list */
WITH membership AS (
  SELECT EXISTS (
    SELECT 1
      FROM user_orgs membership_row
      JOIN users account
        ON account.id = membership_row.user_id
     WHERE membership_row.org_id = $1
       AND membership_row.user_id = $2
       AND membership_row.is_active IS TRUE
       AND account.is_active IS TRUE
  ) AS active
),
item_state AS (
  SELECT
    c.id AS course_id,
    v.id AS course_version_id,
    v.title AS title,
    i.id AS item_id,
    i.item_type AS item_type,
    i.position AS position,
    evidence.completed_at AS evidence_completed_at,
    first_pass.graded_at AS first_passed_at,
    best_pass.earned_score AS best_earned_score,
    best_pass.total_score AS best_total_score,
    best_pass.graded_at AS best_passed_at
  FROM elearning_course_versions v
  JOIN elearning_courses c
    ON c.org_id = v.org_id AND c.id = v.course_id
  JOIN elearning_course_version_items i
    ON i.org_id = v.org_id AND i.course_version_id = v.id
  LEFT JOIN elearning_completion_evidence evidence
    ON evidence.org_id = v.org_id
   AND evidence.user_id = $2
   AND evidence.course_version_id = v.id
   AND evidence.course_version_item_id = i.id
   AND evidence.item_type = i.item_type
  LEFT JOIN LATERAL (
    SELECT attempt.graded_at
      FROM elearning_exam_attempts attempt
     WHERE attempt.org_id = v.org_id
       AND attempt.user_id = $2
       AND attempt.course_version_id = v.id
       AND attempt.course_version_item_id = i.id
       AND attempt.status = 'graded'
       AND attempt.passed IS TRUE
     ORDER BY attempt.graded_at ASC, attempt.id ASC
     LIMIT 1
  ) first_pass ON i.item_type = 'exam'
  LEFT JOIN LATERAL (
    SELECT
      attempt.auto_score + attempt.manual_score AS earned_score,
      attempt.total_score,
      attempt.graded_at
      FROM elearning_exam_attempts attempt
     WHERE attempt.org_id = v.org_id
       AND attempt.user_id = $2
       AND attempt.course_version_id = v.id
       AND attempt.course_version_item_id = i.id
       AND attempt.status = 'graded'
       AND attempt.passed IS TRUE
     ORDER BY attempt.auto_score + attempt.manual_score DESC,
              attempt.graded_at DESC,
              attempt.id DESC
     LIMIT 1
  ) best_pass ON i.item_type = 'exam'
  WHERE v.org_id = $1
    AND v.status IN ('published', 'retired')
),
course_rollup AS (
  SELECT
    course_id,
    course_version_id,
    title,
    CASE
      WHEN count(*) FILTER (WHERE item_type = 'video') >= 1
       AND count(*) FILTER (WHERE item_type = 'exam') >= 1
       AND count(*) FILTER (WHERE item_type IN ('video', 'exam')) = count(*)
        THEN 'assessment'
      WHEN count(*) >= 1
       AND count(*) FILTER (WHERE item_type IN ('article', 'external_link')) = count(*)
        THEN 'content'
      ELSE NULL
    END AS kind,
    max(
      CASE
        WHEN item_type IN ('video', 'article', 'external_link')
          THEN evidence_completed_at
        WHEN item_type = 'exam' THEN first_passed_at
        ELSE NULL
      END
    ) AS completed_at,
    bool_and(
      CASE
        WHEN item_type IN ('video', 'article', 'external_link')
          THEN evidence_completed_at IS NOT NULL
        WHEN item_type = 'exam' THEN first_passed_at IS NOT NULL
        ELSE FALSE
      END
    ) AS completed,
    jsonb_agg(
      jsonb_build_object(
        'itemId', item_id,
        'earnedScore', best_earned_score,
        'totalScore', best_total_score,
        'passedAt', to_char(
          best_passed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      ) ORDER BY position ASC, item_id ASC
    ) FILTER (WHERE item_type = 'exam') AS exams
  FROM item_state
  GROUP BY course_id, course_version_id, title
),
eligible AS (
  SELECT *
    FROM course_rollup
   WHERE kind IS NOT NULL
     AND completed IS TRUE
     AND completed_at IS NOT NULL
),
overall AS (
  SELECT
    count(*)::text AS completed_courses,
    count(*) FILTER (WHERE kind = 'assessment')::text AS assessment_courses,
    count(*) FILTER (WHERE kind = 'content')::text AS content_courses
  FROM eligible
),
page AS (
  SELECT *
    FROM eligible
   WHERE ($3::timestamptz IS NULL OR (completed_at, course_version_id) < ($3::timestamptz, $4::uuid))
   ORDER BY completed_at DESC, course_version_id DESC
   LIMIT $5
)
SELECT
  membership.active AS membership_active,
  overall.completed_courses,
  overall.assessment_courses,
  overall.content_courses,
  page.course_id,
  page.course_version_id,
  page.title,
  page.kind,
  page.completed_at,
  to_char(
    page.completed_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS cursor_completed_at,
  page.exams
FROM membership
CROSS JOIN overall
LEFT JOIN page ON membership.active IS TRUE
ORDER BY page.completed_at DESC NULLS LAST, page.course_version_id DESC NULLS LAST`

function fail(code: ElearningLearningProfileErrorCode): never {
  throw new ElearningLearningProfileError(code)
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') fail('unavailable')
  return value
}

function uuid(value: unknown): string {
  const valueText = text(value)
  if (!UUID_RE.test(valueText)) fail('unavailable')
  return valueText
}

function timestamp(value: unknown): string {
  const candidate = value instanceof Date ? value.toISOString() : value
  if (
    typeof candidate !== 'string'
    || !CANONICAL_TIMESTAMP_RE.test(candidate)
    || Number.isNaN(Date.parse(candidate))
    || new Date(candidate).toISOString() !== candidate
  ) fail('unavailable')
  return candidate
}

function cursorTimestamp(value: unknown): {
  value: string
  completedAt: string
} {
  if (typeof value !== 'string') fail('unavailable')
  const match = CURSOR_TIMESTAMP_RE.exec(value)
  if (!match) fail('unavailable')
  const millisecondValue = `${match[1]}Z`
  if (
    Number.isNaN(Date.parse(millisecondValue))
    || new Date(millisecondValue).toISOString() !== millisecondValue
  ) fail('unavailable')
  return { value, completedAt: millisecondValue }
}

function count(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    fail('unavailable')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) fail('unavailable')
  return parsed
}

function score(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(parsed) || parsed < 0) fail('unavailable')
  return parsed
}

function decodeCursor(value: string): Cursor {
  try {
    if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      fail('invalid_input')
    }
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    const separator = decoded.indexOf('|')
    if (separator <= 0 || separator !== decoded.lastIndexOf('|')) {
      fail('invalid_input')
    }
    const completedAt = decoded.slice(0, separator)
    const courseVersionId = decoded.slice(separator + 1)
    const match = CURSOR_TIMESTAMP_RE.exec(completedAt)
    const millisecondValue = match ? `${match[1]}Z` : ''
    if (
      !match
      || Number.isNaN(Date.parse(millisecondValue))
      || new Date(millisecondValue).toISOString() !== millisecondValue
      || !UUID_RE.test(courseVersionId)
    ) fail('invalid_input')
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) {
      fail('invalid_input')
    }
    return { completedAt, courseVersionId }
  } catch (error) {
    if (error instanceof ElearningLearningProfileError) throw error
    return fail('invalid_input')
  }
}

function encodeCursor(courseVersionId: string, completedAt: string): string {
  return Buffer.from(
    `${completedAt}|${courseVersionId}`,
    'utf8',
  ).toString('base64url')
}

function parseExams(value: unknown): ElearningLearningProfileExam[] {
  if (!Array.isArray(value) || value.length === 0) fail('unavailable')
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return fail('unavailable')
    }
    const row = candidate as Record<string, unknown>
    const keys = Object.keys(row).sort()
    if (keys.join(',') !== 'earnedScore,itemId,passedAt,totalScore') {
      return fail('unavailable')
    }
    const earnedScore = score(row.earnedScore)
    const totalScore = score(row.totalScore)
    if (earnedScore > totalScore) fail('unavailable')
    return {
      itemId: uuid(row.itemId),
      earnedScore,
      totalScore,
      passedAt: timestamp(row.passedAt),
    }
  })
}

export async function getElearningLearningProfile(
  db: ElearningLearningProfileDb,
  input: GetElearningLearningProfileInput,
): Promise<ElearningLearningProfileResult> {
  const orgId = typeof input.orgId === 'string' ? input.orgId.trim() : ''
  const userId = typeof input.userId === 'string' ? input.userId.trim() : ''
  const limit = input.limit ?? ELEARNING_LEARNING_PROFILE_PAGE_DEFAULT
  if (
    !orgId
    || !userId
    || !Number.isInteger(limit)
    || limit < 1
    || limit > ELEARNING_LEARNING_PROFILE_PAGE_MAX
  ) fail('invalid_input')
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor)

  let result: Awaited<ReturnType<ElearningLearningProfileDb['query']>>
  try {
    result = await db.query(PROFILE_SQL, [
      orgId,
      userId,
      cursor?.completedAt ?? null,
      cursor?.courseVersionId ?? null,
      limit + 1,
    ])
  } catch {
    return fail('unavailable')
  }
  const first = result.rows[0]
  if (!first || typeof first.membership_active !== 'boolean') fail('unavailable')
  if (!first.membership_active) fail('forbidden')
  const summary = {
    completedCourses: count(first.completed_courses),
    assessmentCourses: count(first.assessment_courses),
    contentCourses: count(first.content_courses),
  }
  if (
    summary.assessmentCourses + summary.contentCourses
    !== summary.completedCourses
  ) fail('unavailable')

  const entries: Array<{
    course: ElearningLearningProfileCourse
    cursorCompletedAt: string
  }> = []
  for (const row of result.rows) {
    if (row.course_id == null) continue
    const cursor = cursorTimestamp(row.cursor_completed_at)
    const common = {
      courseId: uuid(row.course_id),
      courseVersionId: uuid(row.course_version_id),
      title: text(row.title),
      completedAt: timestamp(row.completed_at),
    }
    if (cursor.completedAt !== common.completedAt) fail('unavailable')
    if (row.kind === 'assessment') {
      entries.push({
        course: {
          ...common,
          kind: 'assessment',
          exams: parseExams(row.exams),
        },
        cursorCompletedAt: cursor.value,
      })
    } else if (row.kind === 'content' && row.exams == null) {
      entries.push({
        course: { ...common, kind: 'content' },
        cursorCompletedAt: cursor.value,
      })
    } else {
      fail('unavailable')
    }
  }
  const hasMore = entries.length > limit
  if (hasMore) entries.pop()
  const courses = entries.map(({ course }) => course)
  const last = entries.at(-1)
  return {
    userId,
    summary,
    courses,
    nextCursor: hasMore && last
      ? encodeCursor(last.course.courseVersionId, last.cursorCompletedAt)
      : null,
  }
}
