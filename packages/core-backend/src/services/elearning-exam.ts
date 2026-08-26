/**
 * Transactional V0.1 objective-exam engine (assignment-only named pilot).
 * Start/submit/autograde are server-derived. Returned values and errors are
 * values-free: public types never include answer_key, correct ids, or explanation.
 */
import { randomUUID } from 'node:crypto'

import {
  ElearningCourseAccessError,
  resolveElearningCourseAccess,
} from './elearning-course-access'
import {
  ELEARNING_EXAM_AUTO_GRADER,
  ELEARNING_EXAM_GRADE_KIND,
  ELEARNING_EXAM_PAPER_VERSION,
  UUID_RE,
  asFiniteNumber,
  asSafeInt,
  asText,
  canonicalizeElearningExamAnswers,
  elearningExamAnswersEqual,
  elearningExamLockKey,
  ElearningExamError,
  failElearningExam,
  freezeElearningPaperSnapshot,
  materializeElearningExamQuestions,
  redactElearningPaperSnapshot,
  requireActor,
  requireUuid,
  scoreElearningExam,
  validateElearningObjectiveQuestion,
  validateElearningPaperSnapshot,
  type ElearningExamErrorCode,
  type ElearningExamGrade,
  type ElearningObjectiveQuestion,
  type ElearningPaperSnapshot,
  type ElearningPublicPaper,
} from './elearning-exam-domain'

export {
  ELEARNING_EXAM_AUTO_GRADER,
  ELEARNING_EXAM_GRADE_KIND,
  ELEARNING_EXAM_PAPER_DOMAIN,
  ELEARNING_EXAM_PAPER_VERSION,
  canonicalizeElearningExamAnswers,
  elearningExamLockKey,
  ElearningExamError,
  failElearningExam,
  materializeElearningExamQuestions,
  redactElearningPaperSnapshot,
  scoreElearningExam,
  stripElearningExamSecrets,
  validateElearningObjectiveQuestion,
  validateElearningPaperSnapshot,
} from './elearning-exam-domain'

export type {
  ElearningExamErrorCode,
  ElearningExamGrade,
  ElearningExamOption,
  ElearningExamQuestionScore,
  ElearningObjectiveAnswerKey,
  ElearningObjectiveQuestion,
  ElearningPaperSnapshot,
  ElearningPublicPaper,
  ElearningPublicQuestion,
  ElearningQuestionType,
} from './elearning-exam-domain'

export interface ElearningExamQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningExamDb extends ElearningExamQueryable {
  transaction<T>(handler: (tx: ElearningExamQueryable) => Promise<T>): Promise<T>
}

export interface StartElearningExamInput {
  orgId: string
  userId: string
  itemId: string
}

export interface SubmitElearningExamInput {
  orgId: string
  userId: string
  attemptId: string
  answers: unknown
}

export type SaveElearningExamAnswersInput = SubmitElearningExamInput

export interface ElearningExamStartResult {
  attemptId: string
  attemptNo: number
  status: 'started'
  paper: ElearningPublicPaper
  answers: Record<string, string[]>
  duplicate: boolean
}

export interface ElearningExamSubmitResult {
  attemptId: string
  attemptNo: number
  status: 'graded'
  autoScore: number
  totalScore: number
  passed: boolean
  duplicate: boolean
}

function fail(code: ElearningExamErrorCode): never {
  failElearningExam(code)
}

function requireRowInt(value: unknown): number {
  const parsed = asSafeInt(value)
  if (parsed === null) fail('unavailable')
  return parsed
}

function requireRowNumber(value: unknown): number {
  const parsed = asFiniteNumber(value)
  if (parsed === null) fail('unavailable')
  return parsed
}

function requireRowBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('unavailable')
  return value
}

function hasStoredTimestamp(value: unknown): boolean {
  if (value === null) return false
  if (value instanceof Date && Number.isFinite(value.getTime())) return true
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return true
  fail('unavailable')
}

function requireStoredUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function ownAnswers(answers: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [key, [...value]]),
  )
}

function publicStartResult(
  attemptId: string,
  attemptNo: number,
  snapshot: ElearningPaperSnapshot,
  answers: Record<string, string[]>,
  duplicate: boolean,
): ElearningExamStartResult {
  return {
    attemptId,
    attemptNo,
    status: 'started',
    paper: redactElearningPaperSnapshot(snapshot),
    answers: ownAnswers(answers),
    duplicate,
  }
}

function publicSubmitResult(
  attemptId: string,
  attemptNo: number,
  grade: ElearningExamGrade,
  duplicate: boolean,
): ElearningExamSubmitResult {
  return {
    attemptId,
    attemptNo,
    status: 'graded',
    autoScore: grade.autoScore,
    totalScore: grade.totalScore,
    passed: grade.passed,
    duplicate,
  }
}

function gradeDetails(grade: ElearningExamGrade): Record<string, unknown> {
  return {
    version: ELEARNING_EXAM_PAPER_VERSION,
    questions: grade.questions,
  }
}

function parseStoredSnapshot(value: unknown): ElearningPaperSnapshot {
  return validateElearningPaperSnapshot(value, 'unavailable')
}

function parseStoredAnswers(
  snapshot: ElearningPaperSnapshot,
  value: unknown,
): Record<string, string[]> {
  try {
    return canonicalizeElearningExamAnswers(snapshot, value)
  } catch (error) {
    if (error instanceof ElearningExamError && error.code === 'invalid_input') fail('unavailable')
    throw error
  }
}

async function advisoryLock(
  tx: ElearningExamQueryable,
  orgId: string,
  userId: string,
  itemId: string,
): Promise<void> {
  await tx.query(
    `/* elearning-exam:lock */
     SELECT pg_advisory_xact_lock(hashtext($1))`,
    [elearningExamLockKey(orgId, userId, itemId)],
  )
}

interface ExamItem {
  itemId: string
  versionId: string
  examId: string
  position: number
  passScore: number
  maxAttempts: number
  paperId: string | null
  hasTemporalRules: boolean
  shuffleQuestions: boolean
  shuffleOptions: boolean
}

async function peekExamIdFromItem(
  tx: ElearningExamQueryable,
  orgId: string,
  itemId: string,
): Promise<string> {
  const result = await tx.query(
    `/* elearning-exam:peek-item */
     SELECT item_type, exam_id
       FROM elearning_course_version_items
      WHERE org_id = $1 AND id = $2`,
    [orgId, itemId],
  )
  const row = result.rows[0]
  if (!row) fail('not_found')
  if (asText(row.item_type) !== 'exam') fail('unsupported_item')
  return requireStoredUuid(row.exam_id)
}

async function lockExamItem(
  tx: ElearningExamQueryable,
  orgId: string,
  itemId: string,
): Promise<ExamItem> {
  const result = await tx.query(
    `/* elearning-exam:load-item */
     SELECT
       i.id,
       i.course_version_id,
       i.item_type,
       i.position,
       i.exam_id,
       v.status AS version_status,
       c.status AS course_status
     FROM elearning_course_version_items i
     JOIN elearning_course_versions v
       ON v.org_id = i.org_id AND v.id = i.course_version_id
     JOIN elearning_courses c
       ON c.org_id = v.org_id AND c.id = v.course_id
     WHERE i.org_id = $1 AND i.id = $2
     FOR SHARE OF c, v FOR UPDATE OF i`,
    [orgId, itemId],
  )
  const row = result.rows[0]
  if (!row) fail('not_found')
  if (asText(row.course_status) === 'withdrawn') fail('course_withdrawn')
  if (asText(row.item_type) !== 'exam') fail('unsupported_item')
  const versionStatus = asText(row.version_status)
  if (versionStatus !== 'published' && versionStatus !== 'retired') fail('unsupported_item')
  const versionId = asText(row.course_version_id)
  const loadedId = asText(row.id)
  if (!versionId || !loadedId) fail('unavailable')
  const examId = requireStoredUuid(row.exam_id)
  const exam = await tx.query(
    `/* elearning-exam:lock-exam */
     SELECT status, pass_score, max_attempts, paper_id,
            window_starts_at, window_ends_at, duration_seconds,
            shuffle_questions, shuffle_options
       FROM elearning_exams
      WHERE org_id = $1 AND id = $2
      FOR SHARE`,
    [orgId, examId],
  )
  const examRow = exam.rows[0]
  if (!examRow) fail('unavailable')
  const examStatus = asText(examRow.status)
  if (examStatus !== 'published' && examStatus !== 'retired') fail('unsupported_item')
  const paperId = examRow.paper_id == null
    ? null
    : requireStoredUuid(examRow.paper_id)
  const hasWindowStart = hasStoredTimestamp(examRow.window_starts_at)
  const hasWindowEnd = hasStoredTimestamp(examRow.window_ends_at)
  const durationSeconds = examRow.duration_seconds == null
    ? null
    : requireRowInt(examRow.duration_seconds)
  if (durationSeconds !== null && durationSeconds < 1) fail('unavailable')
  if ((hasWindowStart && !hasWindowEnd) || (!hasWindowStart && hasWindowEnd)) {
    fail('unavailable')
  }
  return {
    itemId: loadedId,
    versionId,
    examId,
    position: requireRowInt(row.position),
    passScore: requireRowNumber(examRow.pass_score),
    maxAttempts: requireRowInt(examRow.max_attempts),
    paperId,
    hasTemporalRules: hasWindowStart || durationSeconds !== null,
    shuffleQuestions: requireRowBoolean(examRow.shuffle_questions),
    shuffleOptions: requireRowBoolean(examRow.shuffle_options),
  }
}

async function requireCourseAccess(
  tx: ElearningExamQueryable,
  orgId: string,
  userId: string,
  versionId: string,
): Promise<void> {
  try {
    await resolveElearningCourseAccess(tx, {
      orgId,
      userId,
      courseVersionId: versionId,
    })
  } catch (error) {
    if (!(error instanceof ElearningCourseAccessError)) fail('unavailable')
    if (error.code === 'withdrawn') fail('course_withdrawn')
    if (error.code === 'unsupported_version') fail('unsupported_item')
    if (error.code === 'denied') fail('assignment_unavailable')
    fail('unavailable')
  }
}

async function requireCompletedPriorVideos(
  tx: ElearningExamQueryable,
  orgId: string,
  userId: string,
  versionId: string,
  examPosition: number,
): Promise<void> {
  const result = await tx.query(
    `/* elearning-exam:load-prior-videos */
     SELECT i.id
       FROM elearning_course_version_items i
       LEFT JOIN elearning_progress p
         ON p.org_id = i.org_id
        AND p.user_id = $2
        AND p.course_version_item_id = i.id
        AND p.status = 'completed'
      WHERE i.org_id = $1
        AND i.course_version_id = $3
        AND i.item_type = 'video'
        AND i.position < $4
        AND p.id IS NULL
      ORDER BY i.position ASC
      LIMIT 1`,
    [orgId, userId, versionId, examPosition],
  )
  if (result.rows[0]) fail('prerequisite_incomplete')
}

interface AttemptRow {
  id: string
  attemptNo: number
  status: string
  paperSnapshot: unknown
  answers: unknown
  autoScore: number | null
  totalScore: number | null
  passed: boolean | null
}

async function lockUserAttempts(
  tx: ElearningExamQueryable,
  orgId: string,
  examId: string,
  userId: string,
  itemId: string,
): Promise<AttemptRow[]> {
  const result = await tx.query(
    `/* elearning-exam:load-attempts */
     SELECT id, attempt_no, status, paper_snapshot, answers, auto_score, total_score, passed
       FROM elearning_exam_attempts
      WHERE org_id = $1
        AND exam_id = $2
        AND user_id = $3
        AND course_version_item_id = $4
      ORDER BY attempt_no ASC
      FOR UPDATE`,
    [orgId, examId, userId, itemId],
  )
  return result.rows.map((row) => {
    const id = asText(row.id)
    const status = asText(row.status)
    if (!id || !status) fail('unavailable')
    const passed = row.passed
    return {
      id,
      attemptNo: requireRowInt(row.attempt_no),
      status,
      paperSnapshot: row.paper_snapshot,
      answers: row.answers,
      autoScore: row.auto_score == null ? null : requireRowNumber(row.auto_score),
      totalScore: row.total_score == null ? null : requireRowNumber(row.total_score),
      passed: passed === true || passed === false ? passed : passed == null ? null : fail('unavailable'),
    }
  })
}

async function loadExamQuestions(
  tx: ElearningExamQueryable,
  orgId: string,
  examId: string,
  paperId: string | null,
): Promise<ElearningObjectiveQuestion[]> {
  const result = paperId === null
    ? await tx.query(
      `/* elearning-exam:load-questions */
     SELECT
       eq.position,
       eq.points,
       eq.question_revision_id,
       qr.question_id,
       qr.question_type,
       qr.prompt,
       qr.options,
       qr.answer_key,
       qr.explanation
     FROM elearning_exam_questions eq
     JOIN elearning_question_revisions qr
       ON qr.org_id = eq.org_id AND qr.id = eq.question_revision_id
    WHERE eq.org_id = $1 AND eq.exam_id = $2
    ORDER BY eq.position ASC
    FOR SHARE OF eq, qr`,
      [orgId, examId],
    )
    : await tx.query(
      `/* elearning-exam:load-paper-questions */
       SELECT
         pq.position,
         pq.points,
         pq.question_revision_id,
         qr.question_id,
         qr.question_type,
         qr.prompt,
         qr.options,
         qr.answer_key,
         qr.explanation
       FROM elearning_paper_questions pq
       JOIN elearning_question_revisions qr
         ON qr.org_id = pq.org_id
        AND qr.question_id = pq.question_id
        AND qr.id = pq.question_revision_id
      WHERE pq.org_id = $1 AND pq.paper_id = $2
      ORDER BY pq.position ASC
      FOR SHARE OF pq, qr`,
      [orgId, paperId],
    )
  if (result.rows.length < 1) fail('unavailable')
  const questions: ElearningObjectiveQuestion[] = []
  const positions = new Set<number>()
  const revisionIds = new Set<string>()
  for (const row of result.rows) {
    let question: ElearningObjectiveQuestion
    try {
      question = validateElearningObjectiveQuestion({
        position: row.position,
        points: row.points,
        questionRevisionId: row.question_revision_id,
        questionId: row.question_id,
        questionType: row.question_type,
        prompt: row.prompt,
        options: row.options,
        answerKey: row.answer_key,
        explanation: row.explanation,
      }, 'invalid_input')
    } catch (error) {
      if (error instanceof ElearningExamError && error.code === 'invalid_input') fail('unavailable')
      throw error
    }
    if (positions.has(question.position) || revisionIds.has(question.questionRevisionId)) fail('unavailable')
    positions.add(question.position)
    revisionIds.add(question.questionRevisionId)
    questions.push(question)
  }
  return questions
}

export async function startElearningExam(
  db: ElearningExamDb,
  input: StartElearningExamInput,
): Promise<ElearningExamStartResult> {
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)
  const itemId = requireUuid(input.itemId)

  return db.transaction(async (tx) => {
    try {
      const examId = await peekExamIdFromItem(tx, orgId, itemId)
      await advisoryLock(tx, orgId, userId, itemId)
      const item = await lockExamItem(tx, orgId, itemId)
      if (item.examId !== examId || item.itemId !== itemId) fail('unavailable')
      await requireCourseAccess(tx, orgId, userId, item.versionId)
      await requireCompletedPriorVideos(tx, orgId, userId, item.versionId, item.position)
      // Deadline enforcement requires atomic expiry + grading. Until that
      // dedicated slice lands, refuse configured windows/durations instead of
      // silently running an untimed attempt.
      if (item.hasTemporalRules) fail('unsupported_item')

      const attempts = await lockUserAttempts(tx, orgId, item.examId, userId, item.itemId)
      const started = attempts.find((row) => row.status === 'started')
      if (started) {
        const snapshot = parseStoredSnapshot(started.paperSnapshot)
        const answers = parseStoredAnswers(snapshot, started.answers)
        return publicStartResult(started.id, started.attemptNo, snapshot, answers, true)
      }
      if (attempts.length >= item.maxAttempts) fail('max_attempts')

      const attemptNo = attempts.reduce((max, row) => Math.max(max, row.attemptNo), 0) + 1
      const attemptId = randomUUID()
      const questions = await loadExamQuestions(
        tx,
        orgId,
        item.examId,
        item.paperId,
      )
      const materialized = materializeElearningExamQuestions(
        questions,
        attemptId,
        item.shuffleQuestions,
        item.shuffleOptions,
      )
      const snapshot = freezeElearningPaperSnapshot(
        item.examId,
        item.passScore,
        materialized,
      )
      await tx.query(
        `/* elearning-exam:insert-attempt */
         INSERT INTO elearning_exam_attempts (
           id, org_id, exam_id, course_version_id, user_id, attempt_no,
           paper_snapshot, answers, status, course_version_item_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NULL, 'started', $8)`,
        [
          attemptId,
          orgId,
          item.examId,
          item.versionId,
          userId,
          attemptNo,
          JSON.stringify(snapshot),
          item.itemId,
        ],
      )
      return publicStartResult(
        attemptId,
        attemptNo,
        snapshot,
        canonicalizeElearningExamAnswers(snapshot, null),
        false,
      )
    } catch (error) {
      if (error instanceof ElearningExamError) throw error
      fail('unavailable')
    }
  })
}

async function peekAttemptLockTarget(
  tx: ElearningExamQueryable,
  orgId: string,
  attemptId: string,
  userId: string,
): Promise<{ examId: string; itemId: string }> {
  const result = await tx.query(
    `/* elearning-exam:peek-attempt */
     SELECT user_id, exam_id, course_version_item_id
       FROM elearning_exam_attempts
      WHERE org_id = $1 AND id = $2`,
    [orgId, attemptId],
  )
  const row = result.rows[0]
  if (!row) fail('not_found')
  if (asText(row.user_id) !== userId) fail('not_found')
  return {
    examId: requireStoredUuid(row.exam_id),
    itemId: requireStoredUuid(row.course_version_item_id),
  }
}

interface LockedAttempt {
  id: string
  attemptNo: number
  status: string
  versionId: string
  examId: string
  itemId: string
  paperSnapshot: unknown
  answers: unknown
  autoScore: number | null
  totalScore: number | null
  passed: boolean | null
}

async function lockAttempt(
  tx: ElearningExamQueryable,
  orgId: string,
  attemptId: string,
  userId: string,
): Promise<LockedAttempt> {
  const result = await tx.query(
    `/* elearning-exam:lock-attempt */
     SELECT
       a.id,
       a.attempt_no,
       a.status,
       a.course_version_id,
       a.exam_id,
       a.course_version_item_id,
       a.paper_snapshot,
       a.answers,
       a.auto_score,
       a.total_score,
       a.passed,
       a.user_id,
       c.status AS course_status,
       v.status AS version_status,
       e.status AS exam_status
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
     WHERE a.org_id = $1 AND a.id = $2
     FOR UPDATE OF a FOR SHARE OF i, c, v, e`,
    [orgId, attemptId],
  )
  const row = result.rows[0]
  if (!row) fail('not_found')
  if (asText(row.user_id) !== userId) fail('not_found')
  if (asText(row.course_status) === 'withdrawn') fail('course_withdrawn')
  const versionStatus = asText(row.version_status)
  const examStatus = asText(row.exam_status)
  if (versionStatus !== 'published' && versionStatus !== 'retired') fail('unsupported_item')
  if (examStatus !== 'published' && examStatus !== 'retired') fail('unsupported_item')
  const id = asText(row.id)
  const status = asText(row.status)
  const versionId = asText(row.course_version_id)
  if (!id || !status || !versionId) fail('unavailable')
  const passed = row.passed
  return {
    id,
    attemptNo: requireRowInt(row.attempt_no),
    status,
    versionId,
    examId: requireStoredUuid(row.exam_id),
    itemId: requireStoredUuid(row.course_version_item_id),
    paperSnapshot: row.paper_snapshot,
    answers: row.answers,
    autoScore: row.auto_score == null ? null : requireRowNumber(row.auto_score),
    totalScore: row.total_score == null ? null : requireRowNumber(row.total_score),
    passed: passed === true || passed === false ? passed : passed == null ? null : fail('unavailable'),
  }
}

function gradeFromStored(attempt: LockedAttempt, snapshot: ElearningPaperSnapshot): ElearningExamGrade {
  if (
    attempt.autoScore === null
    || attempt.totalScore === null
    || attempt.passed === null
  ) {
    fail('unavailable')
  }
  const answers = parseStoredAnswers(snapshot, attempt.answers)
  const recomputed = scoreElearningExam(snapshot, answers)
  if (
    recomputed.autoScore !== attempt.autoScore
    || recomputed.totalScore !== attempt.totalScore
    || recomputed.passed !== attempt.passed
  ) {
    fail('unavailable')
  }
  return recomputed
}

export async function submitElearningExam(
  db: ElearningExamDb,
  input: SubmitElearningExamInput,
): Promise<ElearningExamSubmitResult> {
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)
  const attemptId = requireUuid(input.attemptId)

  return db.transaction(async (tx) => {
    try {
      const peeked = await peekAttemptLockTarget(tx, orgId, attemptId, userId)
      await advisoryLock(tx, orgId, userId, peeked.itemId)
      const attempt = await lockAttempt(tx, orgId, attemptId, userId)
      if (attempt.examId !== peeked.examId || attempt.itemId !== peeked.itemId) fail('unavailable')
      await requireCourseAccess(tx, orgId, userId, attempt.versionId)
      const snapshot = parseStoredSnapshot(attempt.paperSnapshot)

      if (attempt.status === 'graded') {
        const incoming = canonicalizeElearningExamAnswers(snapshot, input.answers)
        const stored = parseStoredAnswers(snapshot, attempt.answers)
        if (!elearningExamAnswersEqual(incoming, stored)) fail('conflict')
        return publicSubmitResult(attempt.id, attempt.attemptNo, gradeFromStored(attempt, snapshot), true)
      }
      const canonical = canonicalizeElearningExamAnswers(snapshot, input.answers)
      const grade = scoreElearningExam(snapshot, canonical)
      const answersJson = JSON.stringify(canonical)
      const submitted = await tx.query(
        `/* elearning-exam:submit-attempt */
         UPDATE elearning_exam_attempts
            SET status = 'submitted',
                answers = $1::jsonb,
                submitted_at = clock_timestamp()
          WHERE org_id = $2 AND id = $3 AND status = 'started'`,
        [answersJson, orgId, attempt.id],
      )
      if (submitted.rowCount !== 1) fail('unavailable')
      await tx.query(
        `/* elearning-exam:insert-grade */
         INSERT INTO elearning_grading_records (
           org_id, attempt_id, kind, score, max_score, details, grader_id
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          orgId,
          attempt.id,
          ELEARNING_EXAM_GRADE_KIND,
          grade.autoScore,
          grade.totalScore,
          JSON.stringify(gradeDetails(grade)),
          ELEARNING_EXAM_AUTO_GRADER,
        ],
      )
      const graded = await tx.query(
        `/* elearning-exam:grade-attempt */
         UPDATE elearning_exam_attempts
            SET status = 'graded',
                auto_score = $1,
                total_score = $2,
                passed = $3,
                graded_at = clock_timestamp()
          WHERE org_id = $4 AND id = $5 AND status = 'submitted'`,
        [grade.autoScore, grade.totalScore, grade.passed, orgId, attempt.id],
      )
      if (graded.rowCount !== 1) fail('unavailable')
      return publicSubmitResult(attempt.id, attempt.attemptNo, grade, false)
    } catch (error) {
      if (error instanceof ElearningExamError) throw error
      fail('unavailable')
    }
  })
}

export async function saveElearningExamAnswers(
  db: ElearningExamDb,
  input: SaveElearningExamAnswersInput,
): Promise<ElearningExamStartResult> {
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)
  const attemptId = requireUuid(input.attemptId)

  return db.transaction(async (tx) => {
    try {
      const peeked = await peekAttemptLockTarget(tx, orgId, attemptId, userId)
      await advisoryLock(tx, orgId, userId, peeked.itemId)
      const attempt = await lockAttempt(tx, orgId, attemptId, userId)
      if (attempt.examId !== peeked.examId || attempt.itemId !== peeked.itemId) fail('unavailable')
      await requireCourseAccess(tx, orgId, userId, attempt.versionId)
      const snapshot = parseStoredSnapshot(attempt.paperSnapshot)
      if (attempt.status !== 'started') fail('conflict')

      const canonical = canonicalizeElearningExamAnswers(snapshot, input.answers)
      const stored = parseStoredAnswers(snapshot, attempt.answers)
      if (elearningExamAnswersEqual(canonical, stored)) {
        return publicStartResult(attempt.id, attempt.attemptNo, snapshot, canonical, true)
      }
      const saved = await tx.query(
        `/* elearning-exam:save-answers */
         UPDATE elearning_exam_attempts
            SET answers = $1::jsonb
          WHERE org_id = $2 AND id = $3 AND status = 'started'`,
        [JSON.stringify(canonical), orgId, attempt.id],
      )
      if (saved.rowCount !== 1) fail('unavailable')
      return publicStartResult(attempt.id, attempt.attemptNo, snapshot, canonical, false)
    } catch (error) {
      if (error instanceof ElearningExamError) throw error
      fail('unavailable')
    }
  })
}
