import {
  elearningAdminScopeLockKey,
  ElearningAdminAccessError,
  type ElearningAdminAccessQueryable,
} from './elearning-admin-access'
import {
  UUID_RE,
  asFiniteNumber,
  asSafeInt,
  canonicalizeElearningExamAnswers,
  ElearningExamError,
  validateElearningPaperSnapshot,
  type ElearningPaperSnapshot,
  type ElearningShortAnswerQuestion,
} from './elearning-exam-domain'
import {
  ELEARNING_MANUAL_GRADE_DETAILS_DOMAIN,
  ELEARNING_MANUAL_GRADE_DETAILS_VERSION,
} from './elearning-manual-grading'

export const ELEARNING_MANUAL_GRADING_PAGE_DEFAULT = 1 as const
export const ELEARNING_MANUAL_GRADING_PAGE_MAX = 10_000 as const
export const ELEARNING_MANUAL_GRADING_PAGE_SIZE_DEFAULT = 20 as const
export const ELEARNING_MANUAL_GRADING_PAGE_SIZE_MAX = 100 as const

export type ElearningManualGradingReadErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'unavailable'

export class ElearningManualGradingReadError extends Error {
  constructor(readonly code: ElearningManualGradingReadErrorCode) {
    super(code)
    this.name = 'ElearningManualGradingReadError'
  }
}

export interface ElearningManualGradingReadQueryable
  extends ElearningAdminAccessQueryable {}

export interface ElearningManualGradingReadDb
  extends ElearningManualGradingReadQueryable {
  transaction<T>(
    handler: (tx: ElearningManualGradingReadQueryable) => Promise<T>,
  ): Promise<T>
}

export interface ListElearningManualGradingQueueInput {
  orgId: string
  actorId: string
  isGlobalAdmin: boolean
  page?: number
  pageSize?: number
}

export interface GetElearningManualGradingDetailInput {
  orgId: string
  actorId: string
  isGlobalAdmin: boolean
  attemptId: string
}

export interface ElearningManualGradingQueueItem {
  attemptId: string
  userId: string
  examId: string
  examTitle: string
  courseId: string
  courseTitle: string
  attemptNo: number
  submittedAt: string
  autoScore: number
  manualScore: number
  paperMaxScore: number
  gradedQuestions: number
  manualQuestions: number
}

export interface ElearningManualGradingQueueResult {
  items: ElearningManualGradingQueueItem[]
  page: number
  pageSize: number
  hasMore: boolean
}

export interface ElearningManualGradingQuestionGrade {
  score: number
  maxScore: number
  comment: string | null
  graderId: string
  gradedAt: string
}

export interface ElearningManualGradingQuestionDetail {
  questionRevisionId: string
  position: number
  prompt: string
  points: number
  learnerAnswer: string
  grade: ElearningManualGradingQuestionGrade | null
}

export interface ElearningManualGradingDetail {
  attemptId: string
  userId: string
  examId: string
  examTitle: string
  courseId: string
  courseTitle: string
  attemptNo: number
  status: 'awaiting_manual'
  submittedAt: string
  autoScore: number
  manualScore: number
  paperMaxScore: number
  passScore: number
  gradedQuestions: number
  manualQuestions: number
  questions: ElearningManualGradingQuestionDetail[]
}

type StoredManualGrade = {
  questionRevisionId: string
  score: number
  maxScore: number
  seq: number
  comment: string | null
  graderId: string
  gradedAt: string
}

function fail(code: ElearningManualGradingReadErrorCode): never {
  throw new ElearningManualGradingReadError(code)
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '') fail('invalid_input')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function requirePage(value: unknown): number {
  if (value === undefined || value === null) {
    return ELEARNING_MANUAL_GRADING_PAGE_DEFAULT
  }
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > ELEARNING_MANUAL_GRADING_PAGE_MAX
  ) {
    fail('invalid_input')
  }
  return value
}

function requirePageSize(value: unknown): number {
  if (value === undefined || value === null) {
    return ELEARNING_MANUAL_GRADING_PAGE_SIZE_DEFAULT
  }
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > ELEARNING_MANUAL_GRADING_PAGE_SIZE_MAX
  ) {
    fail('invalid_input')
  }
  return value
}

function storedText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') fail('unavailable')
  return value
}

function storedUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function storedNumber(value: unknown): number {
  const parsed = asFiniteNumber(value)
  if (parsed === null || parsed < 0) fail('unavailable')
  return parsed
}

function storedInt(value: unknown): number {
  const parsed = asSafeInt(value)
  if (parsed === null || parsed < 1) fail('unavailable')
  return parsed
}

function storedCount(value: unknown): number {
  const parsed = asSafeInt(value)
  if (parsed === null || parsed < 0) fail('unavailable')
  return parsed
}

function storedDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(storedText(value))
  if (!Number.isFinite(date.getTime())) fail('unavailable')
  return date.toISOString()
}

function paperSnapshot(value: unknown): ElearningPaperSnapshot {
  try {
    return validateElearningPaperSnapshot(value, 'unavailable')
  } catch (error) {
    if (error instanceof ElearningExamError) fail('unavailable')
    throw error
  }
}

function shortAnswerQuestions(
  snapshot: ElearningPaperSnapshot,
): ElearningShortAnswerQuestion[] {
  const questions = snapshot.questions.filter(
    (question): question is ElearningShortAnswerQuestion =>
      question.questionType === 'short_answer',
  )
  if (questions.length === 0) fail('unavailable')
  return questions
}

function paperMaxScore(snapshot: ElearningPaperSnapshot): number {
  return snapshot.questions.reduce((sum, question) => sum + question.points, 0)
}

function objectiveMaxScore(snapshot: ElearningPaperSnapshot): number {
  return snapshot.questions.reduce(
    (sum, question) =>
      question.questionType === 'short_answer' ? sum : sum + question.points,
    0,
  )
}

function parseGradeDetails(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('unavailable')
  }
  const row = value as Record<string, unknown>
  const comment = row.comment
  if (comment !== null && typeof comment !== 'string') fail('unavailable')
  if (
    Object.keys(row).length !== 3
    || row.domain !== ELEARNING_MANUAL_GRADE_DETAILS_DOMAIN
    || row.version !== ELEARNING_MANUAL_GRADE_DETAILS_VERSION
  ) {
    fail('unavailable')
  }
  return typeof comment === 'string' ? comment : null
}

const ACTIVE_SCOPE_COUNT_SQL = `/* elearning-manual-grading-read:active-scope-count */
SELECT count(*)::bigint AS scope_count
  FROM elearning_admin_scopes scope
  JOIN directory_integrations integration
    ON integration.id = scope.directory_integration_id
   AND integration.org_id = scope.org_id
   AND integration.status = 'active'
  JOIN directory_departments department
    ON department.id = scope.directory_department_id
   AND department.integration_id = scope.directory_integration_id
   AND department.is_active = TRUE
 WHERE scope.org_id = $1
   AND scope.user_id = $2
   AND scope.revoked_at IS NULL`

const SCOPE_CTE = `WITH RECURSIVE allowed_departments AS (
  SELECT
    scope.directory_integration_id AS integration_id,
    scope.directory_department_id AS department_id,
    scope.include_children,
    ARRAY[scope.directory_department_id]::uuid[] AS path
  FROM elearning_admin_scopes scope
  JOIN directory_integrations integration
    ON integration.id = scope.directory_integration_id
   AND integration.org_id = scope.org_id
   AND integration.status = 'active'
  JOIN directory_departments department
    ON department.id = scope.directory_department_id
   AND department.integration_id = scope.directory_integration_id
   AND department.is_active = TRUE
  WHERE scope.org_id = $1
    AND scope.user_id = $2
    AND scope.revoked_at IS NULL
  UNION ALL
  SELECT
    parent.integration_id,
    child.id,
    parent.include_children,
    parent.path || child.id
  FROM allowed_departments parent
  JOIN directory_departments parent_department
    ON parent_department.id = parent.department_id
   AND parent_department.integration_id = parent.integration_id
  JOIN directory_departments child
    ON child.integration_id = parent.integration_id
   AND child.external_parent_department_id =
     parent_department.external_department_id
   AND child.is_active = TRUE
  WHERE parent.include_children = TRUE
    AND NOT child.id = ANY(parent.path)
)`

const SCOPE_ATTEMPT_FILTER = `(
  $2::text IS NULL
  OR EXISTS (
    SELECT 1
      FROM users platform_user
      JOIN user_orgs membership
        ON membership.user_id = platform_user.id
       AND membership.org_id = a.org_id
       AND membership.is_active = TRUE
      JOIN directory_account_links link
        ON link.local_user_id = platform_user.id
       AND link.link_status = 'linked'
      JOIN directory_accounts account
        ON account.id = link.directory_account_id
       AND account.is_active = TRUE
      JOIN directory_account_departments account_department
        ON account_department.directory_account_id = account.id
      JOIN allowed_departments allowed
        ON allowed.integration_id = account.integration_id
       AND allowed.department_id = account_department.directory_department_id
     WHERE platform_user.id = a.user_id
       AND platform_user.is_active = TRUE
  )
)`

const QUEUE_SQL = `${SCOPE_CTE}
SELECT
  a.id,
  a.user_id,
  a.exam_id,
  a.attempt_no,
  a.submitted_at,
  a.paper_snapshot,
  a.auto_score,
  a.manual_score,
  e.title AS exam_title,
  v.course_id,
  v.title AS course_title,
  count(g.id) FILTER (WHERE g.kind = 'manual')::bigint AS grade_row_count,
  count(DISTINCT g.question_revision_id)
    FILTER (WHERE g.kind = 'manual')::bigint AS graded_question_count,
  COALESCE(sum(g.score) FILTER (WHERE g.kind = 'manual'), 0)
    AS ledger_manual_score,
  count(g.id) FILTER (WHERE g.kind = 'regrade')::bigint AS regrade_row_count,
  count(g.id) FILTER (WHERE g.kind = 'auto')::bigint AS auto_row_count,
  max(g.score) FILTER (WHERE g.kind = 'auto') AS ledger_auto_score,
  max(g.max_score) FILTER (WHERE g.kind = 'auto') AS ledger_auto_max_score,
  max(g.seq) FILTER (WHERE g.kind = 'auto') AS auto_seq,
  max(g.grader_id) FILTER (WHERE g.kind = 'auto') AS auto_grader_id
FROM elearning_exam_attempts a
JOIN elearning_exams e
  ON e.org_id = a.org_id AND e.id = a.exam_id
JOIN elearning_course_versions v
  ON v.org_id = a.org_id AND v.id = a.course_version_id
LEFT JOIN elearning_grading_records g
  ON g.org_id = a.org_id
 AND g.attempt_id = a.id
WHERE a.org_id = $1
  AND a.status = 'awaiting_manual'
  AND ${SCOPE_ATTEMPT_FILTER}
GROUP BY
  a.id,
  a.user_id,
  a.exam_id,
  a.attempt_no,
  a.submitted_at,
  a.paper_snapshot,
  a.auto_score,
  a.manual_score,
  e.title,
  v.course_id,
  v.title
ORDER BY a.submitted_at ASC, a.id ASC
LIMIT $3 OFFSET $4`

const DETAIL_SQL = `${SCOPE_CTE}
SELECT
  a.id,
  a.user_id,
  a.exam_id,
  a.attempt_no,
  a.status,
  a.submitted_at,
  a.paper_snapshot,
  a.answers,
  a.auto_score,
  a.manual_score,
  a.total_score,
  a.passed,
  e.title AS exam_title,
  v.course_id,
  v.title AS course_title
FROM elearning_exam_attempts a
JOIN elearning_exams e
  ON e.org_id = a.org_id AND e.id = a.exam_id
JOIN elearning_course_versions v
  ON v.org_id = a.org_id AND v.id = a.course_version_id
WHERE a.org_id = $1
  AND a.id = $3
  AND a.status = 'awaiting_manual'
  AND ${SCOPE_ATTEMPT_FILTER}
FOR SHARE OF a`

const DETAIL_GRADES_SQL = `/* elearning-manual-grading-read:detail-grades */
SELECT kind, question_revision_id, score, max_score, seq, details,
       grader_id, created_at
  FROM elearning_grading_records
 WHERE org_id = $1
   AND attempt_id = $2
 ORDER BY seq ASC`

async function withAuthorizedRead<T>(
  db: ElearningManualGradingReadDb,
  input: { orgId: string; actorId: string; isGlobalAdmin: boolean },
  read: (
    tx: ElearningManualGradingReadQueryable,
    scopeActorId: string | null,
  ) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const scopeActorId = input.isGlobalAdmin ? null : input.actorId
    if (scopeActorId) {
      await tx.query(
        `/* elearning-manual-grading-read:scope-lock */
         SELECT pg_advisory_xact_lock_shared(hashtext($1))`,
        [elearningAdminScopeLockKey(input.orgId, scopeActorId)],
      )
      const result = await tx.query(ACTIVE_SCOPE_COUNT_SQL, [
        input.orgId,
        scopeActorId,
      ])
      const row = result.rows[0]
      if (!row) fail('unavailable')
      if (storedCount(row.scope_count) === 0) {
        throw new ElearningAdminAccessError('scope_required')
      }
    }
    return read(tx, scopeActorId)
  })
}

function mapQueueItem(row: Record<string, unknown>): ElearningManualGradingQueueItem {
  const snapshot = paperSnapshot(row.paper_snapshot)
  const manualQuestions = shortAnswerQuestions(snapshot)
  const gradeRows = storedCount(row.grade_row_count)
  const gradedQuestions = storedCount(row.graded_question_count)
  const autoScore = storedNumber(row.auto_score)
  const manualScore = storedNumber(row.manual_score)
  if (
    storedCount(row.auto_row_count) !== 1
    || storedCount(row.regrade_row_count) !== 0
    || storedNumber(row.ledger_auto_score) !== autoScore
    || storedNumber(row.ledger_auto_max_score) !== objectiveMaxScore(snapshot)
    || storedInt(row.auto_seq) !== 1
    || row.auto_grader_id !== 'system:auto'
    || gradeRows !== gradedQuestions
    || gradedQuestions > manualQuestions.length
    || storedNumber(row.ledger_manual_score) !== manualScore
  ) {
    fail('unavailable')
  }
  return {
    attemptId: storedUuid(row.id),
    userId: storedText(row.user_id),
    examId: storedUuid(row.exam_id),
    examTitle: storedText(row.exam_title),
    courseId: storedUuid(row.course_id),
    courseTitle: storedText(row.course_title),
    attemptNo: storedInt(row.attempt_no),
    submittedAt: storedDate(row.submitted_at),
    autoScore,
    manualScore,
    paperMaxScore: paperMaxScore(snapshot),
    gradedQuestions,
    manualQuestions: manualQuestions.length,
  }
}

function mapStoredGrade(row: Record<string, unknown>): StoredManualGrade {
  if (row.kind !== 'manual') fail('unavailable')
  return {
    questionRevisionId: storedUuid(row.question_revision_id),
    score: storedNumber(row.score),
    maxScore: storedNumber(row.max_score),
    seq: storedInt(row.seq),
    comment: parseGradeDetails(row.details),
    graderId: storedText(row.grader_id),
    gradedAt: storedDate(row.created_at),
  }
}

function assertAutoGrade(
  row: Record<string, unknown> | undefined,
  expectedScore: number,
  expectedMaxScore: number,
): void {
  if (
    !row
    || row.kind !== 'auto'
    || row.question_revision_id !== null
    || storedNumber(row.score) !== expectedScore
    || storedNumber(row.max_score) !== expectedMaxScore
    || storedInt(row.seq) !== 1
    || row.grader_id !== 'system:auto'
  ) {
    fail('unavailable')
  }
}

export async function listElearningManualGradingQueue(
  db: ElearningManualGradingReadDb,
  input: ListElearningManualGradingQueueInput,
): Promise<ElearningManualGradingQueueResult> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  if (typeof input.isGlobalAdmin !== 'boolean') fail('invalid_input')
  const page = requirePage(input.page)
  const pageSize = requirePageSize(input.pageSize)
  const offset = (page - 1) * pageSize
  if (!Number.isSafeInteger(offset)) fail('invalid_input')

  try {
    return await withAuthorizedRead(db, {
      orgId,
      actorId,
      isGlobalAdmin: input.isGlobalAdmin,
    }, async (tx, scopeActorId) => {
      const result = await tx.query(QUEUE_SQL, [
        orgId,
        scopeActorId,
        pageSize + 1,
        offset,
      ])
      if (result.rows.length > pageSize + 1) fail('unavailable')
      const hasMore = result.rows.length > pageSize
      const rows = hasMore ? result.rows.slice(0, pageSize) : result.rows
      return {
        items: rows.map(mapQueueItem),
        page,
        pageSize,
        hasMore,
      }
    })
  } catch (error) {
    if (
      error instanceof ElearningManualGradingReadError
      || error instanceof ElearningAdminAccessError
    ) {
      throw error
    }
    fail('unavailable')
  }
}

export async function getElearningManualGradingDetail(
  db: ElearningManualGradingReadDb,
  input: GetElearningManualGradingDetailInput,
): Promise<ElearningManualGradingDetail> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  if (typeof input.isGlobalAdmin !== 'boolean') fail('invalid_input')
  const attemptId = requireUuid(input.attemptId)

  try {
    return await withAuthorizedRead(db, {
      orgId,
      actorId,
      isGlobalAdmin: input.isGlobalAdmin,
    }, async (tx, scopeActorId) => {
      const result = await tx.query(DETAIL_SQL, [
        orgId,
        scopeActorId,
        attemptId,
      ])
      const row = result.rows[0]
      if (!row) fail('not_found')
      if (result.rows.length !== 1 || row.status !== 'awaiting_manual') {
        fail('unavailable')
      }
      if (row.total_score !== null || row.passed !== null) fail('unavailable')

      const snapshot = paperSnapshot(row.paper_snapshot)
      const manualQuestions = shortAnswerQuestions(snapshot)
      let answers: ReturnType<typeof canonicalizeElearningExamAnswers>
      try {
        answers = canonicalizeElearningExamAnswers(snapshot, row.answers)
      } catch (error) {
        if (error instanceof ElearningExamError) fail('unavailable')
        throw error
      }

      const gradeResult = await tx.query(DETAIL_GRADES_SQL, [orgId, attemptId])
      const autoScore = storedNumber(row.auto_score)
      assertAutoGrade(
        gradeResult.rows[0],
        autoScore,
        objectiveMaxScore(snapshot),
      )
      const grades = new Map<string, StoredManualGrade>()
      let previousSeq = 1
      for (const gradeRow of gradeResult.rows.slice(1)) {
        const grade = mapStoredGrade(gradeRow)
        const question = manualQuestions.find(
          (candidate) => candidate.questionRevisionId === grade.questionRevisionId,
        )
        if (
          !question
          || grade.seq <= previousSeq
          || grade.maxScore !== question.points
          || grade.score > grade.maxScore
          || grades.has(grade.questionRevisionId)
        ) {
          fail('unavailable')
        }
        previousSeq = grade.seq
        grades.set(grade.questionRevisionId, grade)
      }

      const manualScore = Array.from(grades.values()).reduce(
        (sum, grade) => sum + grade.score,
        0,
      )
      if (storedNumber(row.manual_score) !== manualScore) fail('unavailable')
      const questions = manualQuestions.map((question) => {
        const learnerAnswer = answers[question.questionRevisionId]
        if (typeof learnerAnswer !== 'string') fail('unavailable')
        const grade = grades.get(question.questionRevisionId)
        return {
          questionRevisionId: question.questionRevisionId,
          position: question.position,
          prompt: question.prompt,
          points: question.points,
          learnerAnswer,
          grade: grade
            ? {
                score: grade.score,
                maxScore: grade.maxScore,
                comment: grade.comment,
                graderId: grade.graderId,
                gradedAt: grade.gradedAt,
              }
            : null,
        }
      })

      return {
        attemptId: storedUuid(row.id),
        userId: storedText(row.user_id),
        examId: storedUuid(row.exam_id),
        examTitle: storedText(row.exam_title),
        courseId: storedUuid(row.course_id),
        courseTitle: storedText(row.course_title),
        attemptNo: storedInt(row.attempt_no),
        status: 'awaiting_manual',
        submittedAt: storedDate(row.submitted_at),
        autoScore,
        manualScore,
        paperMaxScore: paperMaxScore(snapshot),
        passScore: snapshot.passScore,
        gradedQuestions: grades.size,
        manualQuestions: manualQuestions.length,
        questions,
      }
    })
  } catch (error) {
    if (
      error instanceof ElearningManualGradingReadError
      || error instanceof ElearningAdminAccessError
    ) {
      throw error
    }
    fail('unavailable')
  }
}
