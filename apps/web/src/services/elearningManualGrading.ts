// L3 initial manual-grading client (queue + attempt detail + one-shot grade submit).
// Sibling to elearningAssessmentAdmin.ts rather than folded into it: this surface is
// gated by `elearning:grade` (not `elearning:admin`) and is read/mutated by a
// different audience (graders, not course authors).
//
// Closed-response discipline mirrors the backend contract (packages/openapi/src/
// base.yml ElearningManualGrading*): the queue, detail, and submit responses never
// carry objective questions, answer keys, explanations, rubrics, raw paper
// snapshots, regrade history, or another learner's attempt — enforced here with
// exact-key parsing at every object level plus a forbidden-key deep-walk as
// defense in depth.

import { apiFetch } from '../utils/api'
import { ElearningApiError } from './elearning'

export const ELEARNING_MANUAL_GRADING_PAGE_DEFAULT = 1 as const
export const ELEARNING_MANUAL_GRADING_PAGE_MAX = 10_000 as const
export const ELEARNING_MANUAL_GRADING_PAGE_SIZE_DEFAULT = 20 as const
export const ELEARNING_MANUAL_GRADING_PAGE_SIZE_MAX = 100 as const
export const ELEARNING_MANUAL_GRADE_COMMENT_MAX = 4_000 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STABLE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,62}$/
const FORBIDDEN_KEYS = new Set([
  'answerKey',
  'answer_key',
  'correct',
  'explanation',
  'rubric',
  'storageKey',
  'storage_key',
  'paperSnapshot',
  'snapshot',
  'regradeHistory',
])

export type ElearningManualGradingAttemptStatus = 'awaiting_manual' | 'graded'

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

export interface ElearningManualGradeSubmitRequest {
  requestId: string
  questionRevisionId: string
  score: number
  comment: string | null
}

export interface ElearningManualGradeSubmitResult {
  attemptId: string
  questionRevisionId: string
  score: number
  maxScore: number
  status: ElearningManualGradingAttemptStatus
  gradedQuestions: number
  manualQuestions: number
  autoScore: number
  manualScore: number
  totalScore: number
  passed: boolean | null
  duplicate: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function hasForbiddenKeys(value: unknown): boolean {
  const walk = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(walk)
    if (!isPlainObject(node)) return false
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(key)) return true
      if (walk(child)) return true
    }
    return false
  }
  return walk(value)
}

function fail(code: string, status: number): never {
  throw new ElearningApiError(code, status)
}

function failShape(status: number): never {
  fail('invalid_response', status)
}

function requireUuid(value: unknown, status: number): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) failShape(status)
  return value.toLowerCase()
}

function requireInputUuid(value: string): string {
  if (!UUID_RE.test(value)) fail('invalid_input', 400)
  return value.toLowerCase()
}

function requireString(value: unknown, status: number): string {
  if (typeof value !== 'string') failShape(status)
  return value
}

function requireNonEmptyString(value: unknown, status: number): string {
  if (typeof value !== 'string' || value.trim() === '') failShape(status)
  return value
}

function requireIsoTimestamp(value: unknown, status: number): string {
  const text = requireNonEmptyString(value, status)
  if (!Number.isFinite(Date.parse(text))) failShape(status)
  return text
}

function requireSafeInt(value: unknown, status: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) failShape(status)
  return value
}

function requireFiniteNumber(value: unknown, status: number, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) failShape(status)
  return value
}

function requireBoolean(value: unknown, status: number): boolean {
  if (value !== true && value !== false) failShape(status)
  return value
}

function requireNullableBoolean(value: unknown, status: number): boolean | null {
  if (value === null) return null
  return requireBoolean(value, status)
}

function requireNullableComment(value: unknown, status: number): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > ELEARNING_MANUAL_GRADE_COMMENT_MAX) failShape(status)
  return value
}

function requireAttemptStatus(value: unknown, status: number): ElearningManualGradingAttemptStatus {
  if (value !== 'awaiting_manual' && value !== 'graded') failShape(status)
  return value
}

function requirePageBound(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('invalid_input', 400)
  return value
}

function requireResponseBound(value: unknown, status: number, max: number): number {
  const parsed = requireSafeInt(value, status, 1)
  if (parsed > max) failShape(status)
  return parsed
}

function requireInputScore(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid_input', 400)
  return value
}

function requireInputComment(value: string | null): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > ELEARNING_MANUAL_GRADE_COMMENT_MAX) {
    fail('invalid_input', 400)
  }
  return value
}

function readErrorCode(payload: unknown): string {
  if (!isPlainObject(payload) || typeof payload.error !== 'string') return 'request_failed'
  const code = payload.error.trim()
  if (code === 'ORG_CONTEXT_REQUIRED') return code
  return STABLE_ERROR_CODE_RE.test(code) ? code : 'request_failed'
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

async function requestJson(
  path: string,
  expectedStatus: number,
  init: RequestInit,
): Promise<unknown> {
  let response: Response
  try {
    response = await apiFetch(path, init)
  } catch {
    fail('network_error', 0)
  }
  const payload = await readPayload(response)
  if (response.status !== expectedStatus) {
    fail(readErrorCode(payload), response.status)
  }
  if (hasForbiddenKeys(payload)) failShape(response.status)
  return payload
}

function parseQueueItem(value: unknown, status: number): ElearningManualGradingQueueItem {
  const keys = [
    'attemptId', 'userId', 'examId', 'examTitle', 'courseId', 'courseTitle',
    'attemptNo', 'submittedAt', 'autoScore', 'manualScore', 'paperMaxScore',
    'gradedQuestions', 'manualQuestions',
  ] as const
  if (!isPlainObject(value) || !exactKeys(value, keys)) failShape(status)
  return {
    attemptId: requireUuid(value.attemptId, status),
    userId: requireNonEmptyString(value.userId, status),
    examId: requireUuid(value.examId, status),
    examTitle: requireNonEmptyString(value.examTitle, status),
    courseId: requireUuid(value.courseId, status),
    courseTitle: requireNonEmptyString(value.courseTitle, status),
    attemptNo: requireSafeInt(value.attemptNo, status, 1),
    submittedAt: requireIsoTimestamp(value.submittedAt, status),
    autoScore: requireSafeInt(value.autoScore, status, 0),
    manualScore: requireSafeInt(value.manualScore, status, 0),
    paperMaxScore: requireSafeInt(value.paperMaxScore, status, 0),
    gradedQuestions: requireSafeInt(value.gradedQuestions, status, 0),
    manualQuestions: requireSafeInt(value.manualQuestions, status, 1),
  }
}

function parseQueueResult(value: unknown, status: number): ElearningManualGradingQueueResult {
  if (!isPlainObject(value) || !exactKeys(value, ['items', 'page', 'pageSize', 'hasMore'])) failShape(status)
  if (!Array.isArray(value.items)) failShape(status)
  return {
    items: value.items.map((item) => parseQueueItem(item, status)),
    page: requireResponseBound(value.page, status, ELEARNING_MANUAL_GRADING_PAGE_MAX),
    pageSize: requireResponseBound(
      value.pageSize,
      status,
      ELEARNING_MANUAL_GRADING_PAGE_SIZE_MAX,
    ),
    hasMore: requireBoolean(value.hasMore, status),
  }
}

function parseQuestionGrade(value: unknown, status: number): ElearningManualGradingQuestionGrade {
  if (!isPlainObject(value) || !exactKeys(value, ['score', 'maxScore', 'comment', 'graderId', 'gradedAt'])) {
    failShape(status)
  }
  return {
    score: requireSafeInt(value.score, status, 0),
    maxScore: requireSafeInt(value.maxScore, status, 0),
    comment: requireNullableComment(value.comment, status),
    graderId: requireNonEmptyString(value.graderId, status),
    gradedAt: requireIsoTimestamp(value.gradedAt, status),
  }
}

function parseQuestionDetail(value: unknown, status: number): ElearningManualGradingQuestionDetail {
  const keys = ['questionRevisionId', 'position', 'prompt', 'points', 'learnerAnswer', 'grade'] as const
  if (!isPlainObject(value) || !exactKeys(value, keys)) failShape(status)
  return {
    questionRevisionId: requireUuid(value.questionRevisionId, status),
    position: requireSafeInt(value.position, status, 1),
    prompt: requireNonEmptyString(value.prompt, status),
    points: requireSafeInt(value.points, status, 0),
    learnerAnswer: requireString(value.learnerAnswer, status),
    grade: value.grade === null ? null : parseQuestionGrade(value.grade, status),
  }
}

function parseDetail(value: unknown, status: number): ElearningManualGradingDetail {
  const keys = [
    'attemptId', 'userId', 'examId', 'examTitle', 'courseId', 'courseTitle',
    'attemptNo', 'status', 'submittedAt', 'autoScore', 'manualScore',
    'paperMaxScore', 'passScore', 'gradedQuestions', 'manualQuestions', 'questions',
  ] as const
  if (!isPlainObject(value) || !exactKeys(value, keys)) failShape(status)
  if (value.status !== 'awaiting_manual') failShape(status)
  if (!Array.isArray(value.questions) || value.questions.length < 1) failShape(status)
  return {
    attemptId: requireUuid(value.attemptId, status),
    userId: requireNonEmptyString(value.userId, status),
    examId: requireUuid(value.examId, status),
    examTitle: requireNonEmptyString(value.examTitle, status),
    courseId: requireUuid(value.courseId, status),
    courseTitle: requireNonEmptyString(value.courseTitle, status),
    attemptNo: requireSafeInt(value.attemptNo, status, 1),
    status: 'awaiting_manual',
    submittedAt: requireIsoTimestamp(value.submittedAt, status),
    autoScore: requireSafeInt(value.autoScore, status, 0),
    manualScore: requireSafeInt(value.manualScore, status, 0),
    paperMaxScore: requireSafeInt(value.paperMaxScore, status, 0),
    passScore: requireSafeInt(value.passScore, status, 0),
    gradedQuestions: requireSafeInt(value.gradedQuestions, status, 0),
    manualQuestions: requireSafeInt(value.manualQuestions, status, 1),
    questions: value.questions.map((question) => parseQuestionDetail(question, status)),
  }
}

function parseSubmitResult(value: unknown, status: number): ElearningManualGradeSubmitResult {
  const keys = [
    'attemptId', 'questionRevisionId', 'score', 'maxScore', 'status',
    'gradedQuestions', 'manualQuestions', 'autoScore', 'manualScore',
    'totalScore', 'passed', 'duplicate',
  ] as const
  if (!isPlainObject(value) || !exactKeys(value, keys)) failShape(status)
  return {
    attemptId: requireUuid(value.attemptId, status),
    questionRevisionId: requireUuid(value.questionRevisionId, status),
    score: requireSafeInt(value.score, status, 0),
    maxScore: requireSafeInt(value.maxScore, status, 0),
    status: requireAttemptStatus(value.status, status),
    gradedQuestions: requireSafeInt(value.gradedQuestions, status, 1),
    manualQuestions: requireSafeInt(value.manualQuestions, status, 1),
    autoScore: requireFiniteNumber(value.autoScore, status, 0),
    manualScore: requireSafeInt(value.manualScore, status, 0),
    totalScore: requireFiniteNumber(value.totalScore, status, 0),
    passed: requireNullableBoolean(value.passed, status),
    duplicate: requireBoolean(value.duplicate, status),
  }
}

export async function listElearningManualGradingQueue(
  page: number = ELEARNING_MANUAL_GRADING_PAGE_DEFAULT,
  pageSize: number = ELEARNING_MANUAL_GRADING_PAGE_SIZE_DEFAULT,
): Promise<ElearningManualGradingQueueResult> {
  const query = new URLSearchParams({
    page: String(requirePageBound(page, ELEARNING_MANUAL_GRADING_PAGE_MAX)),
    pageSize: String(requirePageBound(pageSize, ELEARNING_MANUAL_GRADING_PAGE_SIZE_MAX)),
  })
  const payload = await requestJson(
    `/api/elearning/assessment/manual-grading/attempts?${query.toString()}`,
    200,
    { method: 'GET' },
  )
  return parseQueueResult(payload, 200)
}

export async function getElearningManualGradingDetail(
  attemptId: string,
): Promise<ElearningManualGradingDetail> {
  const id = encodeURIComponent(requireInputUuid(attemptId))
  const payload = await requestJson(
    `/api/elearning/assessment/manual-grading/attempts/${id}`,
    200,
    { method: 'GET' },
  )
  return parseDetail(payload, 200)
}

export async function submitElearningManualGrade(
  attemptId: string,
  input: ElearningManualGradeSubmitRequest,
): Promise<ElearningManualGradeSubmitResult> {
  const id = encodeURIComponent(requireInputUuid(attemptId))
  const requestId = requireInputUuid(input.requestId)
  const questionRevisionId = requireInputUuid(input.questionRevisionId)
  const score = requireInputScore(input.score)
  const comment = requireInputComment(input.comment)
  const payload = await requestJson(
    `/api/elearning/assessment/attempts/${id}/manual-grades`,
    200,
    {
      method: 'POST',
      body: JSON.stringify({
        requestId,
        questionRevisionId,
        score,
        comment,
      }),
    },
  )
  return parseSubmitResult(payload, 200)
}
