import { apiFetch } from '../utils/api'
import {
  ElearningApiError,
  type ElearningCapabilities,
} from './elearning'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/
const CANONICAL_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const FORBIDDEN_KEYS = new Set([
  'answerKey',
  'answer_key',
  'correctIds',
  'correctOptionIds',
  'explanation',
  'rubric',
  'solution',
])

export type ElearningPracticeMode = 'sequential' | 'random' | 'wrong_book'
export type ElearningPracticeQuestionType = 'single_choice' | 'multiple_choice' | 'true_false'

export interface ElearningPracticeSet {
  practiceSetId: string
  paperId: string
  title: string
  status: 'active'
  createdAt: string
}

export interface ElearningPracticeQuestion {
  questionId: string
  questionRevisionId: string
  questionType: ElearningPracticeQuestionType
  prompt: string
  options: Array<{ id: string; text: string }>
  points: number
  position: number
}

export interface ElearningPracticeSession {
  sessionId: string
  practiceSetId: string
  mode: ElearningPracticeMode
  questions: ElearningPracticeQuestion[]
  createdAt: string
  duplicate: boolean
}

export interface ElearningPracticeAnswerResult {
  answerId: string
  sessionId: string
  questionRevisionId: string
  correct: boolean
  wrongState: 'wrong' | 'resolved' | 'unchanged'
  createdAt: string
  duplicate: boolean
}

export interface ElearningPracticeRequestIds {
  forSet(paperId: string, title: string): string
  forSession(practiceSetId: string, mode: ElearningPracticeMode): string
  forAnswer(sessionId: string, questionRevisionId: string, selectedOptionIds: readonly string[]): string
}

function fail(code: string, status: number): never {
  throw new ElearningApiError(code, status)
}

function failShape(status: number): never {
  fail('invalid_response', status)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKey)
  if (!isObject(value)) return false
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_KEYS.has(key) || hasForbiddenKey(child)
  ))
}

function uuid(value: unknown, status: number): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) failShape(status)
  return value.toLowerCase()
}

function text(value: unknown, status: number, max = 512): string {
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || value.length > max
    || value.includes('\0')
  ) failShape(status)
  return value
}

function canonicalInstant(value: unknown, status: number): string {
  if (typeof value !== 'string' || !CANONICAL_INSTANT_RE.test(value)) failShape(status)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) failShape(status)
  return value
}

function safeInteger(value: unknown, status: number, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) failShape(status)
  return value
}

function bool(value: unknown, status: number): boolean {
  if (value !== true && value !== false) failShape(status)
  return value
}

function mode(value: unknown, status: number): ElearningPracticeMode {
  if (value !== 'sequential' && value !== 'random' && value !== 'wrong_book') failShape(status)
  return value
}

function questionType(value: unknown, status: number): ElearningPracticeQuestionType {
  if (value !== 'single_choice' && value !== 'multiple_choice' && value !== 'true_false') {
    failShape(status)
  }
  return value
}

function parseQuestion(value: unknown, status: number): ElearningPracticeQuestion {
  if (!isObject(value) || !exactKeys(value, [
    'questionId',
    'questionRevisionId',
    'questionType',
    'prompt',
    'options',
    'points',
    'position',
  ]) || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 20) {
    failShape(status)
  }
  const parsedOptions = value.options.map((option) => {
    if (!isObject(option) || !exactKeys(option, ['id', 'text'])) failShape(status)
    return { id: text(option.id, status, 128), text: text(option.text, status, 1_000) }
  })
  if (new Set(parsedOptions.map((option) => option.id)).size !== parsedOptions.length) failShape(status)
  return {
    questionId: uuid(value.questionId, status),
    questionRevisionId: uuid(value.questionRevisionId, status),
    questionType: questionType(value.questionType, status),
    prompt: text(value.prompt, status, 10_000),
    options: parsedOptions,
    points: safeInteger(value.points, status, 0),
    position: safeInteger(value.position, status, 1),
  }
}

function parseQuestions(value: unknown, status: number): ElearningPracticeQuestion[] {
  if (!Array.isArray(value) || value.length > 2_000) failShape(status)
  const questions = value.map((question) => parseQuestion(question, status))
  const ids = new Set<string>()
  const revisions = new Set<string>()
  for (const [index, question] of questions.entries()) {
    if (
      question.position !== index + 1
      || ids.has(question.questionId)
      || revisions.has(question.questionRevisionId)
    ) failShape(status)
    ids.add(question.questionId)
    revisions.add(question.questionRevisionId)
  }
  return questions
}

function parseSet(value: unknown, status: number): ElearningPracticeSet {
  if (!isObject(value) || !exactKeys(value, [
    'practiceSetId',
    'paperId',
    'title',
    'status',
    'createdAt',
  ]) || value.status !== 'active') failShape(status)
  return {
    practiceSetId: uuid(value.practiceSetId, status),
    paperId: uuid(value.paperId, status),
    title: text(value.title, status, 200),
    status: 'active',
    createdAt: canonicalInstant(value.createdAt, status),
  }
}

function parseError(payload: unknown): string {
  if (isObject(payload) && exactKeys(payload, ['error']) && typeof payload.error === 'string') {
    const code = payload.error.trim()
    if (ERROR_CODE_RE.test(code)) return code
  }
  return 'request_failed'
}

async function requestJson(
  path: string,
  method: 'GET' | 'POST',
  expectedStatuses: readonly number[],
  body?: Record<string, unknown>,
): Promise<{ payload: unknown; status: number }> {
  let response: Response
  try {
    response = await apiFetch(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    fail('network_error', 0)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (!expectedStatuses.includes(response.status)) fail(parseError(payload), response.status)
  if (hasForbiddenKey(payload)) failShape(response.status)
  return { payload, status: response.status }
}

function newRequestId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    fail('request_failed', 0)
  }
  return crypto.randomUUID()
}

function requestIdentity(parts: readonly unknown[]): string {
  return JSON.stringify(parts)
}

export function isElearningPracticeReady(payload: ElearningCapabilities): boolean {
  return payload.enabled === true && payload.capabilities.assessment === true
}

export function createElearningPracticeRequestIds(): ElearningPracticeRequestIds {
  const ids = new Map<string, string>()
  const forIdentity = (identity: string): string => {
    const existing = ids.get(identity)
    if (existing) return existing
    const created = newRequestId()
    ids.set(identity, created)
    return created
  }
  return {
    forSet: (paperId, title) => forIdentity(requestIdentity(['set', paperId.toLowerCase(), title.trim()])),
    forSession: (practiceSetId, practiceMode) => (
      forIdentity(requestIdentity(['session', practiceSetId.toLowerCase(), practiceMode]))
    ),
    forAnswer: (sessionId, questionRevisionId, selectedOptionIds) => forIdentity(requestIdentity([
      'answer',
      sessionId.toLowerCase(),
      questionRevisionId.toLowerCase(),
      [...selectedOptionIds].sort(),
    ])),
  }
}

export async function createElearningPracticeSet(input: {
  requestId: string
  paperId: string
  title: string
}): Promise<ElearningPracticeSet & { duplicate: boolean }> {
  const { payload, status } = await requestJson(
    '/api/elearning/admin/practice-sets',
    'POST',
    [200, 201],
    input,
  )
  if (!isObject(payload) || !exactKeys(payload, [
    'practiceSetId', 'paperId', 'title', 'status', 'createdAt', 'duplicate',
  ])) failShape(status)
  return {
    ...parseSet({
      practiceSetId: payload.practiceSetId,
      paperId: payload.paperId,
      title: payload.title,
      status: payload.status,
      createdAt: payload.createdAt,
    }, status),
    duplicate: bool(payload.duplicate, status),
  }
}

export async function listElearningPracticeSets(): Promise<{ practiceSets: ElearningPracticeSet[] }> {
  const { payload, status } = await requestJson('/api/elearning/me/practice-sets', 'GET', [200])
  if (!isObject(payload) || !exactKeys(payload, ['practiceSets']) || !Array.isArray(payload.practiceSets)) {
    failShape(status)
  }
  const practiceSets = payload.practiceSets.map((set) => parseSet(set, status))
  if (new Set(practiceSets.map((set) => set.practiceSetId)).size !== practiceSets.length) failShape(status)
  return { practiceSets }
}

export async function startElearningPracticeSession(input: {
  requestId: string
  practiceSetId: string
  mode: ElearningPracticeMode
}): Promise<ElearningPracticeSession> {
  const { payload, status } = await requestJson(
    '/api/elearning/me/practice-sessions',
    'POST',
    [200, 201],
    input,
  )
  if (!isObject(payload) || !exactKeys(payload, [
    'sessionId', 'practiceSetId', 'mode', 'questions', 'createdAt', 'duplicate',
  ])) failShape(status)
  return {
    sessionId: uuid(payload.sessionId, status),
    practiceSetId: uuid(payload.practiceSetId, status),
    mode: mode(payload.mode, status),
    questions: parseQuestions(payload.questions, status),
    createdAt: canonicalInstant(payload.createdAt, status),
    duplicate: bool(payload.duplicate, status),
  }
}

export async function submitElearningPracticeAnswer(
  sessionId: string,
  input: {
    requestId: string
    questionRevisionId: string
    selectedOptionIds: string[]
  },
): Promise<ElearningPracticeAnswerResult> {
  const { payload, status } = await requestJson(
    `/api/elearning/me/practice-sessions/${encodeURIComponent(sessionId)}/answers`,
    'POST',
    [200],
    input,
  )
  if (!isObject(payload) || !exactKeys(payload, [
    'answerId',
    'sessionId',
    'questionRevisionId',
    'correct',
    'wrongState',
    'createdAt',
    'duplicate',
  ])) failShape(status)
  if (
    payload.wrongState !== 'wrong'
    && payload.wrongState !== 'resolved'
    && payload.wrongState !== 'unchanged'
  ) failShape(status)
  return {
    answerId: uuid(payload.answerId, status),
    sessionId: uuid(payload.sessionId, status),
    questionRevisionId: uuid(payload.questionRevisionId, status),
    correct: bool(payload.correct, status),
    wrongState: payload.wrongState,
    createdAt: canonicalInstant(payload.createdAt, status),
    duplicate: bool(payload.duplicate, status),
  }
}

export async function listElearningWrongQuestions(
  practiceSetId: string,
): Promise<{ practiceSetId: string; questions: ElearningPracticeQuestion[] }> {
  const { payload, status } = await requestJson(
    `/api/elearning/me/practice-sets/${encodeURIComponent(practiceSetId)}/wrong-questions`,
    'GET',
    [200],
  )
  if (!isObject(payload) || !exactKeys(payload, ['practiceSetId', 'questions'])) failShape(status)
  return {
    practiceSetId: uuid(payload.practiceSetId, status),
    questions: parseQuestions(payload.questions, status),
  }
}
