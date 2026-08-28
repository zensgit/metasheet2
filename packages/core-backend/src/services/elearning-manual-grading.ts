import { randomUUID } from 'node:crypto'

import {
  assertElearningUsersWithinAdminScope,
  elearningAdminScopeLockKey,
  ElearningAdminAccessError,
  type ElearningAdminAccessQueryable,
} from './elearning-admin-access'
import {
  UUID_RE,
  asFiniteNumber,
  asSafeInt,
  elearningExamObjectiveMaxScore,
  validateElearningPaperSnapshot,
  type ElearningPaperSnapshot,
  type ElearningShortAnswerQuestion,
} from './elearning-exam-domain'
import { isElearningCreditSurfaceEnabled } from './elearning-credit-ledger'
import {
  awardElearningPassExamCreditInTransaction,
  type ElearningPassExamAwardOptions,
} from './elearning-credit-postgres'

export const ELEARNING_MANUAL_GRADE_DETAILS_DOMAIN =
  'elearning.manual-grade.v1' as const
export const ELEARNING_MANUAL_GRADE_DETAILS_VERSION = 1 as const
export const ELEARNING_MANUAL_GRADE_COMMENT_MAX = 4_000

export type ElearningManualGradingErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'unavailable'

export class ElearningManualGradingError extends Error {
  constructor(readonly code: ElearningManualGradingErrorCode) {
    super(code)
    this.name = 'ElearningManualGradingError'
  }
}

export interface ElearningManualGradingQueryable
  extends ElearningAdminAccessQueryable {}

export interface ElearningManualGradingDb
  extends ElearningManualGradingQueryable {
  transaction<T>(
    handler: (tx: ElearningManualGradingQueryable) => Promise<T>,
  ): Promise<T>
}

export interface ElearningManualGradeInput {
  orgId: string
  actorId: string
  isGlobalAdmin: boolean
  attemptId: string
  questionRevisionId: string
  requestId: string
  score: unknown
  comment: unknown
}

export interface ElearningManualGradeResult {
  attemptId: string
  questionRevisionId: string
  score: number
  maxScore: number
  status: 'awaiting_manual' | 'graded'
  gradedQuestions: number
  manualQuestions: number
  autoScore: number
  manualScore: number
  totalScore: number
  passed: boolean | null
  duplicate: boolean
}

type LockedAttempt = {
  id: string
  userId: string
  status: 'awaiting_manual' | 'graded'
  snapshot: ElearningPaperSnapshot
  autoScore: number
  manualScore: number
  totalScore: number | null
  passed: boolean | null
}

type RawLockedAttempt = {
  id: string
  userId: string
  row: Record<string, unknown>
}

type ManualLedgerRow = {
  questionRevisionId: string
  requestId: string
  kind: 'manual'
  score: number
  maxScore: number
  seq: number
  details: ManualGradeDetails
  graderId: string
}

type ManualGradeDetails = {
  domain: typeof ELEARNING_MANUAL_GRADE_DETAILS_DOMAIN
  version: typeof ELEARNING_MANUAL_GRADE_DETAILS_VERSION
  comment: string | null
}

function fail(code: ElearningManualGradingErrorCode): never {
  throw new ElearningManualGradingError(code)
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

function requireScore(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || !Number.isSafeInteger(value)
  ) {
    fail('invalid_input')
  }
  return Object.is(value, -0) ? 0 : value
}

function requireComment(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed.length > ELEARNING_MANUAL_GRADE_COMMENT_MAX) {
    fail('invalid_input')
  }
  return trimmed === '' ? null : trimmed
}

function storedText(value: unknown): string {
  if (typeof value !== 'string' || value === '') fail('unavailable')
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

function storedBooleanOrNull(value: unknown): boolean | null {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  fail('unavailable')
}

function storedDate(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(value.getTime())
  }
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (Number.isFinite(parsed.getTime())) return parsed
  }
  fail('unavailable')
}

function manualGradeDetails(comment: string | null): ManualGradeDetails {
  return {
    domain: ELEARNING_MANUAL_GRADE_DETAILS_DOMAIN,
    version: ELEARNING_MANUAL_GRADE_DETAILS_VERSION,
    comment,
  }
}

function parseDetails(value: unknown): ManualGradeDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('unavailable')
  }
  const row = value as Record<string, unknown>
  const comment = row.comment
  if (
    Object.keys(row).length !== 3
    || row.domain !== ELEARNING_MANUAL_GRADE_DETAILS_DOMAIN
    || row.version !== ELEARNING_MANUAL_GRADE_DETAILS_VERSION
  ) {
    fail('unavailable')
  }
  if (comment === null) return manualGradeDetails(null)
  if (typeof comment === 'string') return manualGradeDetails(comment)
  fail('unavailable')
}

function sameDetails(left: ManualGradeDetails, right: ManualGradeDetails): boolean {
  return left.domain === right.domain
    && left.version === right.version
    && left.comment === right.comment
}

function shortAnswerQuestions(
  snapshot: ElearningPaperSnapshot,
): ElearningShortAnswerQuestion[] {
  return snapshot.questions.filter(
    (question): question is ElearningShortAnswerQuestion =>
      question.questionType === 'short_answer',
  )
}

function totalPoints(snapshot: ElearningPaperSnapshot): number {
  return snapshot.questions.reduce((sum, question) => sum + question.points, 0)
}

async function lockAttemptRow(
  tx: ElearningManualGradingQueryable,
  orgId: string,
  attemptId: string,
): Promise<RawLockedAttempt> {
  const result = await tx.query(
    `/* elearning-manual-grading:lock-attempt */
     SELECT id, user_id, status, paper_snapshot, auto_score, manual_score,
            total_score, passed
       FROM elearning_exam_attempts
      WHERE org_id = $1 AND id = $2
      FOR UPDATE`,
    [orgId, attemptId],
  )
  const row = result.rows[0]
  if (!row) fail('not_found')
  return {
    id: storedUuid(row.id),
    userId: storedText(row.user_id),
    row,
  }
}

function parseLockedAttempt(raw: RawLockedAttempt): LockedAttempt {
  const { row } = raw
  if (row.status !== 'awaiting_manual' && row.status !== 'graded') {
    fail('conflict')
  }
  const snapshot = validateElearningPaperSnapshot(
    row.paper_snapshot,
    'unavailable',
  )
  const autoScore = storedNumber(row.auto_score)
  const manualScore = storedNumber(row.manual_score)
  const storedTotal = row.total_score === null
    ? null
    : storedNumber(row.total_score)
  const passed = storedBooleanOrNull(row.passed)
  if (
    (row.status === 'awaiting_manual'
      && (storedTotal !== null || passed !== null))
    || (row.status === 'graded' && (storedTotal === null || passed === null))
  ) {
    fail('unavailable')
  }
  return {
    id: raw.id,
    userId: raw.userId,
    status: row.status,
    snapshot,
    autoScore,
    manualScore,
    totalScore: storedTotal,
    passed,
  }
}

function manualScoreFromGrades(
  grades: ReadonlyMap<string, ManualLedgerRow>,
): number {
  return Array.from(grades.values()).reduce(
    (sum, grade) => sum + grade.score,
    0,
  )
}

function assertAttemptMatchesLedger(input: {
  attempt: LockedAttempt
  questions: readonly ElearningShortAnswerQuestion[]
  grades: ReadonlyMap<string, ManualLedgerRow>
}): void {
  const manualScore = manualScoreFromGrades(input.grades)
  const complete = input.grades.size === input.questions.length
  if (input.attempt.manualScore !== manualScore) fail('unavailable')
  if (input.attempt.status === 'awaiting_manual') {
    if (complete) fail('unavailable')
    return
  }
  if (
    !complete
    || input.attempt.totalScore !== totalPoints(input.attempt.snapshot)
    || input.attempt.passed
      !== (
        input.attempt.autoScore + manualScore
        >= input.attempt.snapshot.passScore
      )
  ) {
    fail('unavailable')
  }
}

function parseLedgerRow(row: Record<string, unknown>): ManualLedgerRow {
  if (row.kind !== 'manual') fail('unavailable')
  return {
    questionRevisionId: storedUuid(row.question_revision_id),
    requestId: storedUuid(row.request_id),
    kind: 'manual',
    score: storedNumber(row.score),
    maxScore: storedNumber(row.max_score),
    seq: storedInt(row.seq),
    details: parseDetails(row.details),
    graderId: storedText(row.grader_id),
  }
}

async function loadManualLedger(
  tx: ElearningManualGradingQueryable,
  orgId: string,
  attemptId: string,
): Promise<ManualLedgerRow[]> {
  const result = await tx.query(
    `/* elearning-manual-grading:load-ledger */
     SELECT kind, question_revision_id, request_id, score, max_score, seq,
            details, grader_id
       FROM elearning_grading_records
      WHERE org_id = $1
        AND attempt_id = $2
        AND kind IN ('manual', 'regrade')
      ORDER BY seq`,
    [orgId, attemptId],
  )
  return result.rows.map(parseLedgerRow)
}

async function assertAutoLedger(
  tx: ElearningManualGradingQueryable,
  orgId: string,
  attempt: LockedAttempt,
): Promise<void> {
  const result = await tx.query(
    `/* elearning-manual-grading:load-auto-ledger */
     SELECT score, max_score, seq, grader_id
       FROM elearning_grading_records
      WHERE org_id = $1 AND attempt_id = $2 AND kind = 'auto'`,
    [orgId, attempt.id],
  )
  const row = result.rows[0]
  if (
    result.rows.length !== 1
    || !row
    || storedNumber(row.score) !== attempt.autoScore
    || storedNumber(row.max_score)
      !== elearningExamObjectiveMaxScore(attempt.snapshot)
    || storedInt(row.seq) !== 1
    || row.grader_id !== 'system:auto'
  ) {
    fail('unavailable')
  }
}

function validateLedger(
  rows: readonly ManualLedgerRow[],
  questions: readonly ElearningShortAnswerQuestion[],
): Map<string, ManualLedgerRow> {
  const allowed = new Map(
    questions.map((question) => [question.questionRevisionId, question]),
  )
  const grades = new Map<string, ManualLedgerRow>()
  let previousSeq = 1
  for (const row of rows) {
    const question = allowed.get(row.questionRevisionId)
    if (
      !question
      || row.maxScore !== question.points
      || row.score > row.maxScore
      || row.seq <= previousSeq
      || grades.has(row.questionRevisionId)
    ) {
      fail('unavailable')
    }
    previousSeq = row.seq
    grades.set(row.questionRevisionId, row)
  }
  return grades
}

function resultFromState(input: {
  attempt: LockedAttempt
  questions: readonly ElearningShortAnswerQuestion[]
  grades: ReadonlyMap<string, ManualLedgerRow>
  command: ManualLedgerRow
  duplicate: boolean
}): ElearningManualGradeResult {
  assertAttemptMatchesLedger(input)
  const manualScore = manualScoreFromGrades(input.grades)
  const maximum = totalPoints(input.attempt.snapshot)
  return {
    attemptId: input.attempt.id,
    questionRevisionId: input.command.questionRevisionId,
    score: input.command.score,
    maxScore: input.command.maxScore,
    status: input.attempt.status,
    gradedQuestions: input.grades.size,
    manualQuestions: input.questions.length,
    autoScore: input.attempt.autoScore,
    manualScore,
    totalScore: maximum,
    passed: input.attempt.status === 'graded' ? input.attempt.passed : null,
    duplicate: input.duplicate,
  }
}

export async function submitElearningManualGrade(
  db: ElearningManualGradingDb,
  input: ElearningManualGradeInput,
  options: ElearningPassExamAwardOptions = {},
): Promise<ElearningManualGradeResult> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  if (typeof input.isGlobalAdmin !== 'boolean') fail('invalid_input')
  const attemptId = requireUuid(input.attemptId)
  const questionRevisionId = requireUuid(input.questionRevisionId)
  const requestId = requireUuid(input.requestId)
  const score = requireScore(input.score)
  const details = manualGradeDetails(requireComment(input.comment))
  const env = options.env ?? process.env

  return db.transaction(async (tx) => {
    try {
      if (!input.isGlobalAdmin) {
        await tx.query(
          `/* elearning-manual-grading:scope-lock */
           SELECT pg_advisory_xact_lock(hashtext($1))`,
          [elearningAdminScopeLockKey(orgId, actorId)],
        )
      }
      const rawAttempt = await lockAttemptRow(tx, orgId, attemptId)
      await assertElearningUsersWithinAdminScope(tx, {
        orgId,
        actorId,
        isGlobalAdmin: input.isGlobalAdmin,
        userIds: [rawAttempt.userId],
      })
      const attempt = parseLockedAttempt(rawAttempt)
      const questions = shortAnswerQuestions(attempt.snapshot)
      if (questions.length === 0) fail('unavailable')

      await assertAutoLedger(tx, orgId, attempt)
      const rows = await loadManualLedger(tx, orgId, attempt.id)
      const grades = validateLedger(rows, questions)
      assertAttemptMatchesLedger({ attempt, questions, grades })
      const existingRequest = rows.find((row) => row.requestId === requestId)
      if (existingRequest) {
        if (
          existingRequest.questionRevisionId !== questionRevisionId
          || existingRequest.score !== score
          || existingRequest.graderId !== actorId
          || !sameDetails(existingRequest.details, details)
        ) {
          fail('conflict')
        }
        return resultFromState({
          attempt,
          questions,
          grades,
          command: existingRequest,
          duplicate: true,
        })
      }
      const question = questions.find(
        (candidate) => candidate.questionRevisionId === questionRevisionId,
      )
      if (!question) fail('not_found')
      if (score > question.points) fail('invalid_input')
      if (attempt.status !== 'awaiting_manual') fail('conflict')
      if (grades.has(questionRevisionId)) fail('conflict')

      const seq = rows.length === 0 ? 2 : rows[rows.length - 1]!.seq + 1
      const command: ManualLedgerRow = {
        questionRevisionId,
        requestId,
        kind: 'manual',
        score,
        maxScore: question.points,
        seq,
        details,
        graderId: actorId,
      }
      const inserted = await tx.query(
        `/* elearning-manual-grading:append-grade */
         INSERT INTO elearning_grading_records (
           id, org_id, attempt_id, kind, question_revision_id, request_id,
           seq, score, max_score, details, grader_id
         ) VALUES ($1, $2, $3, 'manual', $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          randomUUID(),
          orgId,
          attempt.id,
          questionRevisionId,
          requestId,
          seq,
          score,
          question.points,
          JSON.stringify(details),
          actorId,
        ],
      )
      if (inserted.rowCount !== 1) fail('unavailable')
      grades.set(questionRevisionId, command)

      const manualScore = manualScoreFromGrades(grades)

      if (grades.size === questions.length) {
        const maximum = totalPoints(attempt.snapshot)
        const passed = attempt.autoScore + manualScore >= attempt.snapshot.passScore
        const finalized = await tx.query(
          `/* elearning-manual-grading:finalize-attempt */
           UPDATE elearning_exam_attempts
              SET status = 'graded',
                  manual_score = $1,
                  total_score = $2,
                  passed = $3,
                  graded_at = clock_timestamp()
            WHERE org_id = $4 AND id = $5
              AND status = 'awaiting_manual' AND manual_score = $6
           RETURNING graded_at`,
          [manualScore, maximum, passed, orgId, attempt.id, attempt.manualScore],
        )
        if (finalized.rowCount !== 1) fail('unavailable')
        const gradedAt = storedDate(finalized.rows[0]?.graded_at)
        if (passed && isElearningCreditSurfaceEnabled(env)) {
          await (options.awardPassExam ?? awardElearningPassExamCreditInTransaction)(
            tx,
            { attemptId: attempt.id, gradedAt, orgId, userId: attempt.userId },
            env,
          )
        }
        attempt.status = 'graded'
        attempt.manualScore = manualScore
        attempt.totalScore = maximum
        attempt.passed = passed
      } else {
        const updated = await tx.query(
          `/* elearning-manual-grading:update-manual-score */
           UPDATE elearning_exam_attempts
              SET manual_score = $1
            WHERE org_id = $2 AND id = $3
              AND status = 'awaiting_manual' AND manual_score = $4`,
          [manualScore, orgId, attempt.id, attempt.manualScore],
        )
        if (updated.rowCount !== 1) fail('unavailable')
        attempt.manualScore = manualScore
      }

      return resultFromState({
        attempt,
        questions,
        grades,
        command,
        duplicate: false,
      })
    } catch (error) {
      if (
        error instanceof ElearningManualGradingError
        || error instanceof ElearningAdminAccessError
      ) {
        throw error
      }
      fail('unavailable')
    }
  })
}
