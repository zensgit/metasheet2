import {
  asFiniteNumber,
  asSafeInt,
  asText,
  canonicalizeElearningExamAnswers,
  ElearningExamError,
  failElearningExam,
  hasElearningManualQuestions,
  requireActor,
  requireUuid,
  scoreElearningExam,
  validateElearningPaperSnapshot,
  type ElearningExamOption,
  type ElearningPublicQuestion,
} from './elearning-exam-domain'
import {
  ELEARNING_EXAM_DISCLOSURE_POLICIES,
  type ElearningExamDisclosurePolicy,
} from './elearning-paper-exam'
import {
  ElearningCourseAccessError,
  resolveElearningCourseAccess,
} from './elearning-course-access'

export type ElearningVisibleExamDisclosurePolicy = Exclude<
  ElearningExamDisclosurePolicy,
  'no_review'
>

export interface ElearningExamReviewQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface GetElearningExamReviewInput {
  orgId: string
  userId: string
  attemptId: string
}

export interface ElearningExamReviewQuestion extends ElearningPublicQuestion {
  selected: string[]
  correct: boolean
  awarded: number
}

export interface ElearningExamReviewResult {
  attemptId: string
  attemptNo: number
  status: 'graded'
  disclosurePolicy: ElearningVisibleExamDisclosurePolicy
  autoScore: number
  totalScore: number
  passed: boolean
  questions: ElearningExamReviewQuestion[]
}

function fail(code: ConstructorParameters<typeof ElearningExamError>[0]): never {
  failElearningExam(code)
}

function requireStoredUuid(value: unknown): string {
  if (typeof value !== 'string') fail('unavailable')
  try {
    return requireUuid(value)
  } catch {
    fail('unavailable')
  }
}

function requireStoredInt(value: unknown): number {
  const parsed = asSafeInt(value)
  if (parsed === null) fail('unavailable')
  return parsed
}

function requireStoredNumber(value: unknown): number {
  const parsed = asFiniteNumber(value)
  if (parsed === null) fail('unavailable')
  return parsed
}

function requireStoredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('unavailable')
  return value
}

function requireStoredDate(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(value.getTime())
  }
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (Number.isFinite(parsed.getTime())) return parsed
  }
  fail('unavailable')
}

function requireStoredPolicy(value: unknown): ElearningExamDisclosurePolicy {
  if (
    typeof value !== 'string'
    || !ELEARNING_EXAM_DISCLOSURE_POLICIES.includes(
      value as ElearningExamDisclosurePolicy,
    )
  ) {
    fail('unavailable')
  }
  return value as ElearningExamDisclosurePolicy
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function publicQuestion(
  question: ReturnType<typeof validateElearningPaperSnapshot>['questions'][number],
  selected: string[],
  awarded: number,
): ElearningExamReviewQuestion {
  return {
    position: question.position,
    questionRevisionId: question.questionRevisionId,
    questionType: question.questionType,
    prompt: question.prompt,
    options: question.options.map((option: ElearningExamOption) => ({ ...option })),
    points: question.points,
    selected: [...selected],
    correct: sameIds(selected, question.answerKey.correct),
    awarded,
  }
}

async function requireCurrentCourseAccess(
  db: ElearningExamReviewQueryable,
  orgId: string,
  userId: string,
  courseVersionId: string,
): Promise<void> {
  try {
    await resolveElearningCourseAccess(db, {
      orgId,
      userId,
      courseVersionId,
    })
  } catch (error) {
    if (!(error instanceof ElearningCourseAccessError)) fail('unavailable')
    if (error.code === 'withdrawn') fail('course_withdrawn')
    if (error.code === 'unsupported_version') fail('unsupported_item')
    if (error.code === 'denied') fail('assignment_unavailable')
    fail('unavailable')
  }
}

/**
 * Returns one learner's immutable, policy-filtered objective review. The query
 * binds org + user + attempt in one predicate; a caller can never select another
 * learner's row and the response never carries answer keys or explanations.
 */
export async function getElearningExamReview(
  db: ElearningExamReviewQueryable,
  input: GetElearningExamReviewInput,
): Promise<ElearningExamReviewResult> {
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)
  const attemptId = requireUuid(input.attemptId)
  let result: Awaited<ReturnType<ElearningExamReviewQueryable['query']>>
  try {
    result = await db.query(
      `/* elearning-exam-review:load */
       SELECT
         a.id,
         a.attempt_no,
         a.status,
         a.paper_snapshot,
         a.answers,
         a.auto_score,
         a.total_score,
         a.passed,
         a.course_version_id,
         e.disclosure_policy,
         e.window_ends_at,
         e.status AS exam_status,
         v.status AS version_status,
         c.status AS course_status,
         clock_timestamp() AS server_now
       FROM elearning_exam_attempts a
       JOIN elearning_course_version_items i
         ON i.org_id = a.org_id
        AND i.id = a.course_version_item_id
        AND i.course_version_id = a.course_version_id
        AND i.exam_id = a.exam_id
        AND i.item_type = 'exam'
       JOIN elearning_course_versions v
         ON v.org_id = a.org_id AND v.id = a.course_version_id
       JOIN elearning_courses c
         ON c.org_id = v.org_id AND c.id = v.course_id
       JOIN elearning_exams e
         ON e.org_id = a.org_id AND e.id = a.exam_id
      WHERE a.org_id = $1 AND a.id = $2 AND a.user_id = $3`,
      [orgId, attemptId, userId],
    )
  } catch {
    fail('unavailable')
  }

  const row = result.rows[0]
  if (!row) fail('not_found')
  if (result.rows.length !== 1) fail('unavailable')
  if (asText(row.course_status) === 'withdrawn') fail('course_withdrawn')
  if (asText(row.course_status) !== 'active' && asText(row.course_status) !== 'archived') {
    fail('unavailable')
  }
  const versionStatus = asText(row.version_status)
  const examStatus = asText(row.exam_status)
  if (versionStatus !== 'published' && versionStatus !== 'retired') fail('unsupported_item')
  if (examStatus !== 'published' && examStatus !== 'retired') fail('unsupported_item')
  if (asText(row.status) !== 'graded') fail('review_unavailable')
  const courseVersionId = requireStoredUuid(row.course_version_id)
  await requireCurrentCourseAccess(db, orgId, userId, courseVersionId)

  const disclosurePolicy = requireStoredPolicy(row.disclosure_policy)
  if (disclosurePolicy === 'no_review') fail('review_unavailable')
  if (disclosurePolicy === 'correctness_after_window') {
    const windowEndsAt = requireStoredDate(row.window_ends_at)
    const serverNow = requireStoredDate(row.server_now)
    if (serverNow < windowEndsAt) fail('review_unavailable')
  }

  let snapshot: ReturnType<typeof validateElearningPaperSnapshot>
  try {
    snapshot = validateElearningPaperSnapshot(row.paper_snapshot, 'unavailable')
  } catch (error) {
    if (error instanceof ElearningExamError) fail('unavailable')
    throw error
  }
  if (hasElearningManualQuestions(snapshot)) fail('review_unavailable')
  let answers: ReturnType<typeof canonicalizeElearningExamAnswers>
  try {
    answers = canonicalizeElearningExamAnswers(snapshot, row.answers)
  } catch (error) {
    if (error instanceof ElearningExamError) fail('unavailable')
    throw error
  }
  const grade = scoreElearningExam(snapshot, answers)
  const autoScore = requireStoredNumber(row.auto_score)
  const totalScore = requireStoredNumber(row.total_score)
  const passed = requireStoredBoolean(row.passed)
  if (
    grade.autoScore !== autoScore
    || grade.totalScore !== totalScore
    || grade.passed !== passed
  ) {
    fail('unavailable')
  }
  const scoreByRevision = new Map(
    grade.questions.map((question) => [question.questionRevisionId, question]),
  )
  const questions = snapshot.questions.flatMap((question) => {
    const score = scoreByRevision.get(question.questionRevisionId)
    if (!score) fail('unavailable')
    const publicRow = publicQuestion(question, score.selected, score.awarded)
    if (disclosurePolicy === 'wrong_items_after_submit' && publicRow.correct) return []
    return [publicRow]
  })

  return {
    attemptId: requireStoredUuid(row.id),
    attemptNo: requireStoredInt(row.attempt_no),
    status: 'graded',
    disclosurePolicy,
    autoScore,
    totalScore,
    passed,
    questions,
  }
}
