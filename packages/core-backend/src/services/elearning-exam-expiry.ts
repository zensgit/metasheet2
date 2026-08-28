import {
  ELEARNING_EXAM_AUTO_GRADER,
  ELEARNING_EXAM_GRADE_KIND,
  UUID_RE,
  asText,
  canonicalizeElearningExamAnswers,
  elearningExamObjectiveMaxScore,
  ElearningExamError,
  failElearningExam,
  hasElearningManualQuestions,
  requireActor,
  requireUuid,
  scoreElearningExam,
  validateElearningPaperSnapshot,
  type ElearningExamAnswers,
  type ElearningPaperSnapshot,
} from './elearning-exam-domain'
import { isElearningCreditSurfaceEnabled } from './elearning-credit-ledger'
import {
  awardElearningPassExamCreditInTransaction,
  type ElearningPassExamAwardOptions,
} from './elearning-credit-postgres'

export const ELEARNING_EXAM_EXPIRY_JOB_KIND = 'exam_attempt_expiry' as const
export const ELEARNING_EXAM_GRACE_SECONDS = 0 as const

export interface ElearningExamExpiryQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningExamExpiryDb extends ElearningExamExpiryQueryable {
  transaction<T>(
    handler: (tx: ElearningExamExpiryQueryable) => Promise<T>,
  ): Promise<T>
}

export interface TimedElearningExamRules {
  windowStartsAt: Date | null
  windowEndsAt: Date | null
  durationSeconds: number | null
}

export interface ExpirableElearningExamAttempt {
  id: string
  userId: string
  status: string
  paperSnapshot: unknown
  answers: unknown
  deadlineAt: Date | null
  expiredAt: Date | null
}

export interface SettleExpiredElearningExamAttemptInput {
  orgId: string
  attemptId: string
}

export interface SettleExpiredElearningExamAttemptResult {
  outcome: 'settled' | 'duplicate' | 'not_due'
}

export interface InsertTimedElearningExamAttemptInput {
  attemptId: string
  orgId: string
  examId: string
  versionId: string
  itemId: string
  userId: string
  attemptNo: number
  snapshot: ElearningPaperSnapshot
  rules: TimedElearningExamRules
}

function fail(code: ConstructorParameters<typeof ElearningExamError>[0]): never {
  failElearningExam(code)
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

function optionalStoredDate(value: unknown): Date | null {
  if (value === null) return null
  return requireStoredDate(value)
}

function timestamp(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

function parseStoredSnapshot(value: unknown): ElearningPaperSnapshot {
  return validateElearningPaperSnapshot(value, 'unavailable')
}

function parseStoredAnswers(
  snapshot: ElearningPaperSnapshot,
  value: unknown,
): ElearningExamAnswers {
  try {
    return canonicalizeElearningExamAnswers(snapshot, value)
  } catch (error) {
    if (error instanceof ElearningExamError && error.code === 'invalid_input') {
      fail('unavailable')
    }
    throw error
  }
}

function gradeDetails(
  snapshot: ElearningPaperSnapshot,
  grade: ReturnType<typeof scoreElearningExam>,
): Record<string, unknown> {
  return {
    version: snapshot.version,
    questions: grade.questions,
  }
}

export function hasTimedElearningExamRules(
  rules: TimedElearningExamRules,
): boolean {
  return rules.windowStartsAt !== null || rules.durationSeconds !== null
}

export async function elearningExamDatabaseNow(
  tx: ElearningExamExpiryQueryable,
): Promise<Date> {
  const result = await tx.query(
    `/* elearning-exam:database-now */
     SELECT clock_timestamp() AS server_now`,
  )
  return requireStoredDate(result.rows[0]?.server_now)
}

export function assertElearningExamWindowOpen(
  rules: TimedElearningExamRules,
  serverNow: Date,
): void {
  if (rules.windowStartsAt !== null && serverNow < rules.windowStartsAt) {
    fail('exam_not_open')
  }
  if (rules.windowEndsAt !== null && serverNow >= rules.windowEndsAt) {
    fail('exam_closed')
  }
}

export async function insertTimedElearningExamAttempt(
  tx: ElearningExamExpiryQueryable,
  input: InsertTimedElearningExamAttemptInput,
): Promise<Date> {
  const durationWithGrace = input.rules.durationSeconds === null
    ? null
    : input.rules.durationSeconds + ELEARNING_EXAM_GRACE_SECONDS
  const result = await tx.query(
    `/* elearning-exam:insert-timed-attempt */
     WITH current_clock AS (
       SELECT clock_timestamp() AS started_at
     )
     INSERT INTO elearning_exam_attempts (
       id, org_id, exam_id, course_version_id, user_id, attempt_no,
       paper_snapshot, answers, status, course_version_item_id,
       started_at, deadline_at
     )
     SELECT
       $1, $2, $3, $4, $5, $6,
       $7::jsonb, NULL, 'started', $8,
       current_clock.started_at,
       CASE
         WHEN $10::timestamptz IS NOT NULL AND $11::integer IS NOT NULL THEN
           LEAST(
             $10::timestamptz,
             current_clock.started_at + ($11::integer * interval '1 second')
           )
         WHEN $10::timestamptz IS NOT NULL THEN $10::timestamptz
         ELSE current_clock.started_at + ($11::integer * interval '1 second')
       END
       FROM current_clock
      WHERE ($9::timestamptz IS NULL OR current_clock.started_at >= $9::timestamptz)
        AND ($10::timestamptz IS NULL OR current_clock.started_at < $10::timestamptz)
     RETURNING deadline_at`,
    [
      input.attemptId,
      input.orgId,
      input.examId,
      input.versionId,
      input.userId,
      input.attemptNo,
      JSON.stringify(input.snapshot),
      input.itemId,
      timestamp(input.rules.windowStartsAt),
      timestamp(input.rules.windowEndsAt),
      durationWithGrace,
    ],
  )
  if (result.rowCount !== 1) {
    assertElearningExamWindowOpen(input.rules, await elearningExamDatabaseNow(tx))
    fail('unavailable')
  }
  const deadlineAt = optionalStoredDate(result.rows[0]?.deadline_at)
  if (deadlineAt === null) fail('unavailable')
  return deadlineAt
}

export async function enqueueElearningExamExpiry(
  tx: ElearningExamExpiryQueryable,
  orgId: string,
  attemptId: string,
  deadlineAt: Date,
): Promise<void> {
  const result = await tx.query(
    `/* elearning-exam:enqueue-expiry */
     INSERT INTO elearning_jobs (
       org_id, kind, occurrence_key, ref, payload, due_at
     ) VALUES ($1, $2, $3, $4, '{}'::jsonb, $5::timestamptz)
     ON CONFLICT (org_id, kind, occurrence_key) DO NOTHING
     RETURNING id`,
    [
      orgId,
      ELEARNING_EXAM_EXPIRY_JOB_KIND,
      `attempt:${attemptId}`,
      attemptId,
      deadlineAt.toISOString(),
    ],
  )
  if (result.rowCount !== 1) fail('unavailable')
}

export async function settleExpiredElearningExamAttemptInTransaction(
  tx: ElearningExamExpiryQueryable,
  orgId: string,
  attempt: ExpirableElearningExamAttempt,
  options: ElearningPassExamAwardOptions = {},
): Promise<'settled' | 'duplicate' | 'not_due'> {
  if (attempt.status === 'graded' || attempt.status === 'awaiting_manual') {
    return 'duplicate'
  }
  if (attempt.status !== 'started' && attempt.status !== 'expired') {
    fail('unavailable')
  }
  if (attempt.deadlineAt === null) return 'not_due'

  const snapshot = parseStoredSnapshot(attempt.paperSnapshot)
  const answers = parseStoredAnswers(snapshot, attempt.answers)
  if (attempt.status === 'started') {
    const expired = await tx.query(
      `/* elearning-exam:expire-attempt */
       UPDATE elearning_exam_attempts
          SET status = 'expired',
              answers = $1::jsonb,
              submitted_at = deadline_at,
              expired_at = clock_timestamp()
        WHERE org_id = $2
          AND id = $3
          AND status = 'started'
          AND deadline_at IS NOT NULL
          AND deadline_at <= clock_timestamp()
       RETURNING id`,
      [JSON.stringify(answers), orgId, attempt.id],
    )
    if (expired.rowCount !== 1) return 'not_due'
  } else if (attempt.expiredAt === null) {
    fail('unavailable')
  }

  const grade = scoreElearningExam(snapshot, answers)
  await tx.query(
    `/* elearning-exam:insert-expiry-grade */
     INSERT INTO elearning_grading_records (
       org_id, attempt_id, kind, score, max_score, details, grader_id
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      orgId,
      attempt.id,
      ELEARNING_EXAM_GRADE_KIND,
      grade.autoScore,
      elearningExamObjectiveMaxScore(snapshot),
      JSON.stringify(gradeDetails(snapshot, grade)),
      ELEARNING_EXAM_AUTO_GRADER,
    ],
  )
  if (hasElearningManualQuestions(snapshot)) {
    const awaiting = await tx.query(
      `/* elearning-exam:await-manual-after-expiry */
       UPDATE elearning_exam_attempts
          SET status = 'awaiting_manual',
              auto_score = $1
        WHERE org_id = $2 AND id = $3 AND status = 'expired'`,
      [grade.autoScore, orgId, attempt.id],
    )
    if (awaiting.rowCount !== 1) fail('unavailable')
  } else {
    if (grade.passed === null) fail('unavailable')
    const graded = await tx.query(
      `/* elearning-exam:grade-expired-attempt */
       UPDATE elearning_exam_attempts
          SET status = 'graded',
              auto_score = $1,
              total_score = $2,
              passed = $3,
              graded_at = clock_timestamp()
        WHERE org_id = $4 AND id = $5 AND status = 'expired'
       RETURNING graded_at`,
      [grade.autoScore, grade.totalScore, grade.passed, orgId, attempt.id],
    )
    if (graded.rowCount !== 1) fail('unavailable')
    const gradedAt = requireStoredDate(graded.rows[0]?.graded_at)
    const env = options.env ?? process.env
    if (grade.passed && isElearningCreditSurfaceEnabled(env)) {
      await (options.awardPassExam ?? awardElearningPassExamCreditInTransaction)(
        tx,
        { attemptId: attempt.id, gradedAt, orgId, userId: attempt.userId },
        env,
      )
    }
  }
  return 'settled'
}

async function lockAttemptForExpirySettlement(
  tx: ElearningExamExpiryQueryable,
  orgId: string,
  attemptId: string,
): Promise<ExpirableElearningExamAttempt> {
  const result = await tx.query(
    `/* elearning-exam:lock-expiry-attempt */
     SELECT id, user_id, status, paper_snapshot, answers, deadline_at, expired_at
       FROM elearning_exam_attempts
      WHERE org_id = $1 AND id = $2
      FOR UPDATE`,
    [orgId, attemptId],
  )
  const row = result.rows[0]
  if (!row) fail('not_found')
  const id = asText(row.id)
  const userId = asText(row.user_id)
  const status = asText(row.status)
  if (!id || !userId || !status || !UUID_RE.test(id)) fail('unavailable')
  return {
    id: id.toLowerCase(),
    userId,
    status,
    paperSnapshot: row.paper_snapshot,
    answers: row.answers,
    deadlineAt: optionalStoredDate(row.deadline_at),
    expiredAt: optionalStoredDate(row.expired_at),
  }
}

/**
 * Worker-facing, same-org expiry materializer. API save/submit paths invoke the
 * same transaction helper, so correctness never depends on this worker call.
 */
export async function settleExpiredElearningExamAttempt(
  db: ElearningExamExpiryDb,
  input: SettleExpiredElearningExamAttemptInput,
  options: ElearningPassExamAwardOptions = {},
): Promise<SettleExpiredElearningExamAttemptResult> {
  const orgId = requireActor(input.orgId)
  const attemptId = requireUuid(input.attemptId)
  return db.transaction(async (tx) => {
    try {
      const attempt = await lockAttemptForExpirySettlement(tx, orgId, attemptId)
      if (attempt.deadlineAt === null) return { outcome: 'not_due' as const }
      return {
        outcome: await settleExpiredElearningExamAttemptInTransaction(
          tx,
          orgId,
          attempt,
          options,
        ),
      }
    } catch (error) {
      if (error instanceof ElearningExamError) throw error
      fail('unavailable')
    }
  })
}
