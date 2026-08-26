import { createHash } from 'node:crypto'

/**
 * Pure V0.1 exam paper helpers: canonicalization, snapshot validation, grading.
 * No I/O. Public types never include answer_key, correct ids, or explanation.
 */

export const ELEARNING_EXAM_PAPER_DOMAIN = 'elearning.exam.paper.v1' as const
export const ELEARNING_EXAM_PAPER_VERSION = 1 as const
export const ELEARNING_EXAM_PAPER_VERSION_MIXED = 2 as const
export const ELEARNING_EXAM_AUTO_GRADER = 'system:auto' as const
export const ELEARNING_EXAM_GRADE_KIND = 'auto' as const
export const ELEARNING_SHORT_ANSWER_MAX_CHARS = 10_000 as const

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const OBJECTIVE_QUESTION_TYPES = [
  'single_choice',
  'multiple_choice',
  'true_false',
] as const
const SECRET_KEYS = new Set(['answer_key', 'answerKey', 'correct', 'explanation'])

export type ElearningObjectiveQuestionType =
  (typeof OBJECTIVE_QUESTION_TYPES)[number]
export type ElearningQuestionType = ElearningObjectiveQuestionType | 'short_answer'
export type ElearningExamAnswer = string[] | string
export type ElearningExamAnswers = Record<string, ElearningExamAnswer>

export type ElearningExamErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'assignment_unavailable'
  | 'course_withdrawn'
  | 'unsupported_item'
  | 'prerequisite_incomplete'
  | 'max_attempts'
  | 'exam_not_open'
  | 'exam_closed'
  | 'attempt_expired'
  | 'review_unavailable'
  | 'conflict'
  | 'unavailable'

export class ElearningExamError extends Error {
  constructor(readonly code: ElearningExamErrorCode) {
    super(code)
    this.name = 'ElearningExamError'
  }
}

export interface ElearningExamOption {
  id: string
  text: string
}

export interface ElearningObjectiveAnswerKey {
  correct: string[]
}

export interface ElearningObjectiveQuestion {
  position: number
  questionRevisionId: string
  questionId: string
  questionType: ElearningObjectiveQuestionType
  prompt: string
  options: ElearningExamOption[]
  points: number
  answerKey: ElearningObjectiveAnswerKey
  explanation: string | null
}

export interface ElearningShortAnswerQuestion {
  position: number
  questionRevisionId: string
  questionId: string
  questionType: 'short_answer'
  prompt: string
  options: []
  points: number
  answerKey: Record<string, never>
  explanation: string | null
}

export type ElearningExamQuestion =
  | ElearningObjectiveQuestion
  | ElearningShortAnswerQuestion

export interface ElearningPaperSnapshot {
  domain: typeof ELEARNING_EXAM_PAPER_DOMAIN
  version:
    | typeof ELEARNING_EXAM_PAPER_VERSION
    | typeof ELEARNING_EXAM_PAPER_VERSION_MIXED
  examId: string
  passScore: number
  questions: ElearningExamQuestion[]
}

export interface ElearningPublicQuestion {
  position: number
  questionRevisionId: string
  questionType: ElearningQuestionType
  prompt: string
  options: ElearningExamOption[]
  points: number
}

export interface ElearningPublicPaper {
  domain: typeof ELEARNING_EXAM_PAPER_DOMAIN
  version:
    | typeof ELEARNING_EXAM_PAPER_VERSION
    | typeof ELEARNING_EXAM_PAPER_VERSION_MIXED
  questions: ElearningPublicQuestion[]
}

export interface ElearningExamQuestionScore {
  questionRevisionId: string
  selected: string[]
  awarded: number
  points: number
}

export interface ElearningExamGrade {
  autoScore: number
  totalScore: number
  passed: boolean | null
  answers: ElearningExamAnswers
  questions: ElearningExamQuestionScore[]
}

export function elearningExamLockKey(orgId: string, userId: string, itemId: string): string {
  return `elearning-exam:${orgId}:${userId}:${itemId}`
}

export function failElearningExam(code: ElearningExamErrorCode): never {
  throw new ElearningExamError(code)
}

function fail(code: ElearningExamErrorCode): never {
  failElearningExam(code)
}

export function requireActor(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '') fail('invalid_input')
  return trimmed
}

export function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

export function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value
}

export function asSafeInt(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null
    return value
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^-?\d+$/.test(text)) return null
    const parsed = Number(text)
    if (!Number.isSafeInteger(parsed)) return null
    return parsed
  }
  return null
}

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^-?\d+(\.\d+)?$/.test(text)) return null
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return null
    return parsed
  }
  return null
}

function isObjectiveQuestionType(
  value: unknown,
): value is ElearningObjectiveQuestionType {
  return value === 'single_choice' || value === 'multiple_choice' || value === 'true_false'
}

function uniqueSorted(ids: string[]): string[] | null {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) return null
    seen.add(id)
  }
  return [...ids].sort()
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

export function validateElearningObjectiveQuestion(
  input: unknown,
  storedFault: ElearningExamErrorCode = 'invalid_input',
): ElearningObjectiveQuestion {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(storedFault)
  const row = input as Record<string, unknown>
  const position = asSafeInt(row.position)
  if (position === null || position < 1) fail(storedFault)
  const questionRevisionId = asText(row.questionRevisionId) ?? asText(row.question_revision_id)
  const questionId = asText(row.questionId) ?? asText(row.question_id)
  if (!questionRevisionId || !UUID_RE.test(questionRevisionId) || !questionId || !UUID_RE.test(questionId)) {
    fail(storedFault)
  }
  const questionType = row.questionType ?? row.question_type
  if (!isObjectiveQuestionType(questionType)) fail(storedFault)
  const prompt = asText(row.prompt)
  if (!prompt || prompt.trim() === '') fail(storedFault)
  const points = asSafeInt(row.points)
  if (points === null || points < 0) fail(storedFault)

  const rawOptions = row.options
  if (!Array.isArray(rawOptions) || rawOptions.length < 1) fail(storedFault)
  const options: ElearningExamOption[] = []
  const optionIds = new Set<string>()
  for (const raw of rawOptions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(storedFault)
    const option = raw as Record<string, unknown>
    if (typeof option.id !== 'string' || typeof option.text !== 'string') fail(storedFault)
    const id = option.id.trim()
    const text = option.text.trim()
    if (id === '' || text === '') fail(storedFault)
    if (optionIds.has(id)) fail(storedFault)
    optionIds.add(id)
    options.push({ id, text })
  }

  const rawKey = row.answerKey ?? row.answer_key
  if (!rawKey || typeof rawKey !== 'object' || Array.isArray(rawKey)) fail(storedFault)
  const key = rawKey as Record<string, unknown>
  if (!Array.isArray(key.correct)) fail(storedFault)
  const correctRaw: string[] = []
  for (const entry of key.correct) {
    if (typeof entry !== 'string') fail(storedFault)
    const id = entry.trim()
    if (id === '') fail(storedFault)
    correctRaw.push(id)
  }
  const correct = uniqueSorted(correctRaw)
  if (!correct) fail(storedFault)
  if (questionType === 'multiple_choice') {
    if (correct.length < 1) fail(storedFault)
  } else if (correct.length !== 1) {
    fail(storedFault)
  }
  for (const id of correct) {
    if (!optionIds.has(id)) fail(storedFault)
  }

  const explanationRaw = row.explanation
  let explanation: string | null = null
  if (explanationRaw != null) {
    if (typeof explanationRaw !== 'string') fail(storedFault)
    explanation = explanationRaw
  }

  return {
    position,
    questionRevisionId: questionRevisionId.toLowerCase(),
    questionId: questionId.toLowerCase(),
    questionType,
    prompt: prompt.trim(),
    options,
    points,
    answerKey: { correct },
    explanation,
  }
}

export function validateElearningExamQuestion(
  input: unknown,
  storedFault: ElearningExamErrorCode = 'invalid_input',
): ElearningExamQuestion {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(storedFault)
  }
  const row = input as Record<string, unknown>
  const questionType = row.questionType ?? row.question_type
  if (questionType !== 'short_answer') {
    return validateElearningObjectiveQuestion(input, storedFault)
  }

  const position = asSafeInt(row.position)
  if (position === null || position < 1) fail(storedFault)
  const questionRevisionId =
    asText(row.questionRevisionId) ?? asText(row.question_revision_id)
  const questionId = asText(row.questionId) ?? asText(row.question_id)
  if (
    !questionRevisionId
    || !UUID_RE.test(questionRevisionId)
    || !questionId
    || !UUID_RE.test(questionId)
  ) {
    fail(storedFault)
  }
  const prompt = asText(row.prompt)
  if (!prompt || prompt.trim() === '') fail(storedFault)
  const points = asSafeInt(row.points)
  if (points === null || points < 0) fail(storedFault)
  if (!Array.isArray(row.options) || row.options.length !== 0) fail(storedFault)
  const rawKey = row.answerKey ?? row.answer_key
  if (
    !rawKey
    || typeof rawKey !== 'object'
    || Array.isArray(rawKey)
    || Object.keys(rawKey as Record<string, unknown>).length !== 0
  ) {
    fail(storedFault)
  }
  let explanation: string | null = null
  if (row.explanation != null) {
    if (typeof row.explanation !== 'string') fail(storedFault)
    explanation = row.explanation
  }
  return {
    position,
    questionRevisionId: questionRevisionId.toLowerCase(),
    questionId: questionId.toLowerCase(),
    questionType,
    prompt: prompt.trim(),
    options: [],
    points,
    answerKey: {},
    explanation,
  }
}

export function validateElearningPaperSnapshot(
  input: unknown,
  storedFault: ElearningExamErrorCode = 'invalid_input',
): ElearningPaperSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(storedFault)
  const row = input as Record<string, unknown>
  if (row.domain !== ELEARNING_EXAM_PAPER_DOMAIN) fail(storedFault)
  const version = asSafeInt(row.version)
  if (
    version !== ELEARNING_EXAM_PAPER_VERSION
    && version !== ELEARNING_EXAM_PAPER_VERSION_MIXED
  ) {
    fail(storedFault)
  }
  const examId = asText(row.examId)
  if (!examId || !UUID_RE.test(examId)) fail(storedFault)
  const passScore = asFiniteNumber(row.passScore)
  if (passScore === null || passScore < 0) fail(storedFault)
  if (!Array.isArray(row.questions) || row.questions.length < 1) fail(storedFault)

  const questions: ElearningExamQuestion[] = []
  const positions = new Set<number>()
  const revisionIds = new Set<string>()
  let hasShortAnswer = false
  for (const raw of row.questions) {
    const question = validateElearningExamQuestion(raw, storedFault)
    if (
      version === ELEARNING_EXAM_PAPER_VERSION
      && question.questionType === 'short_answer'
    ) {
      fail(storedFault)
    }
    if (question.questionType === 'short_answer') hasShortAnswer = true
    if (positions.has(question.position) || revisionIds.has(question.questionRevisionId)) fail(storedFault)
    positions.add(question.position)
    revisionIds.add(question.questionRevisionId)
    questions.push(question)
  }
  if (version === ELEARNING_EXAM_PAPER_VERSION_MIXED && !hasShortAnswer) {
    fail(storedFault)
  }
  questions.sort((a, b) => a.position - b.position)
  const totalScore = questions.reduce((sum, question) => sum + question.points, 0)
  if (!(passScore <= totalScore)) fail(storedFault)
  return {
    domain: ELEARNING_EXAM_PAPER_DOMAIN,
    version,
    examId: examId.toLowerCase(),
    passScore,
    questions,
  }
}

export function freezeElearningPaperSnapshot(
  examId: string,
  passScore: number,
  questions: ElearningExamQuestion[],
): ElearningPaperSnapshot {
  const version = questions.some(
    (question) => question.questionType === 'short_answer',
  )
    ? ELEARNING_EXAM_PAPER_VERSION_MIXED
    : ELEARNING_EXAM_PAPER_VERSION
  return validateElearningPaperSnapshot({
    domain: ELEARNING_EXAM_PAPER_DOMAIN,
    version,
    examId,
    passScore,
    questions,
  }, 'unavailable')
}

function seededRank(seed: string, scope: string, id: string): string {
  return createHash('sha256')
    .update(`${ELEARNING_EXAM_PAPER_DOMAIN}:${seed}:${scope}:${id}`)
    .digest('hex')
}

function compareStableText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Materializes one attempt's visible order without changing stable ids.
 * The attempt id is the deterministic seed and the realized order is persisted
 * in paper_snapshot, so retries never reshuffle and grading remains id-based.
 */
export function materializeElearningExamQuestions(
  questions: ElearningExamQuestion[],
  attemptId: string,
  shuffleQuestions: boolean,
  shuffleOptions: boolean,
): ElearningExamQuestion[] {
  const seed = requireUuid(attemptId)
  const materialized: ElearningExamQuestion[] = questions.map((question) =>
    question.questionType === 'short_answer'
      ? {
        ...question,
        options: [],
        answerKey: {} as Record<string, never>,
      }
      : {
        ...question,
        options: question.options.map((option) => ({ ...option })),
        answerKey: { correct: [...question.answerKey.correct] },
      },
  )

  if (shuffleQuestions) {
    materialized.sort((left, right) => {
      const leftRank = seededRank(seed, 'question', left.questionRevisionId)
      const rightRank = seededRank(seed, 'question', right.questionRevisionId)
      return compareStableText(leftRank, rightRank)
        || compareStableText(left.questionRevisionId, right.questionRevisionId)
    })
    for (let index = 0; index < materialized.length; index += 1) {
      materialized[index] = { ...materialized[index], position: index + 1 }
    }
  }

  if (shuffleOptions) {
    for (let index = 0; index < materialized.length; index += 1) {
      const question = materialized[index]
      if (question.questionType === 'short_answer') continue
      const options = [...question.options].sort((left, right) => {
        const scope = `option:${question.questionRevisionId}`
        const leftRank = seededRank(seed, scope, left.id)
        const rightRank = seededRank(seed, scope, right.id)
        return compareStableText(leftRank, rightRank)
          || compareStableText(left.id, right.id)
      })
      materialized[index] = { ...question, options }
    }
  }

  return materialized.map((question) =>
    validateElearningExamQuestion(question, 'unavailable'),
  )
}

export function redactElearningPaperSnapshot(snapshot: ElearningPaperSnapshot): ElearningPublicPaper {
  return {
    domain: snapshot.domain,
    version: snapshot.version,
    questions: snapshot.questions.map((question) => ({
      position: question.position,
      questionRevisionId: question.questionRevisionId,
      questionType: question.questionType,
      prompt: question.prompt,
      options: question.options.map((option) => ({ id: option.id, text: option.text })),
      points: question.points,
    })),
  }
}

export function stripElearningExamSecrets<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .filter(([key]) => !SECRET_KEYS.has(key))
          .map(([key, child]) => [key, walk(child)]),
      )
    }
    return node
  }
  return walk(value) as T
}

export function canonicalizeElearningExamAnswers(
  snapshot: ElearningPaperSnapshot,
  raw: unknown,
): ElearningExamAnswers {
  if (raw == null) {
    return Object.fromEntries(
      snapshot.questions.map((question) => [
        question.questionRevisionId,
        question.questionType === 'short_answer' ? '' : [],
      ]),
    )
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_input')
  const incoming = raw as Record<string, unknown>
  const allowed = new Set(snapshot.questions.map((question) => question.questionRevisionId))
  const remapped = new Map<string, unknown>()
  for (const key of Object.keys(incoming)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('invalid_input')
    if (!UUID_RE.test(key)) fail('invalid_input')
    const normalized = key.toLowerCase()
    if (!allowed.has(normalized)) fail('invalid_input')
    if (remapped.has(normalized)) fail('invalid_input')
    remapped.set(normalized, incoming[key])
  }

  const canonical: ElearningExamAnswers = {}
  for (const question of snapshot.questions) {
    const value = remapped.get(question.questionRevisionId)
    if (value === undefined) {
      canonical[question.questionRevisionId] =
        question.questionType === 'short_answer' ? '' : []
      continue
    }
    if (question.questionType === 'short_answer') {
      if (typeof value !== 'string') fail('invalid_input')
      const normalized = value.replace(/\r\n?/g, '\n').trim()
      if (normalized.length > ELEARNING_SHORT_ANSWER_MAX_CHARS) {
        fail('invalid_input')
      }
      canonical[question.questionRevisionId] = normalized
      continue
    }
    if (!Array.isArray(value)) fail('invalid_input')
    const selected: string[] = []
    const optionIds = new Set(question.options.map((option) => option.id))
    for (const entry of value) {
      if (typeof entry !== 'string') fail('invalid_input')
      const id = entry.trim()
      if (id === '') fail('invalid_input')
      if (!optionIds.has(id)) fail('invalid_input')
      selected.push(id)
    }
    const unique = uniqueSorted(selected)
    if (!unique) fail('invalid_input')
    canonical[question.questionRevisionId] = unique
  }
  return canonical
}

export function scoreElearningExam(
  snapshot: ElearningPaperSnapshot,
  answers: ElearningExamAnswers,
): ElearningExamGrade {
  const passScore = snapshot.passScore
  let autoScore = 0
  let totalScore = 0
  const questions: ElearningExamQuestionScore[] = []
  for (const question of snapshot.questions) {
    totalScore += question.points
    if (question.questionType === 'short_answer') {
      questions.push({
        questionRevisionId: question.questionRevisionId,
        selected: [],
        awarded: 0,
        points: question.points,
      })
      continue
    }
    const selected = answers[question.questionRevisionId]
    if (!Array.isArray(selected)) fail('unavailable')
    const awarded = sameStringSet(selected, question.answerKey.correct) ? question.points : 0
    autoScore += awarded
    questions.push({
      questionRevisionId: question.questionRevisionId,
      selected,
      awarded,
      points: question.points,
    })
  }
  if (!(passScore >= 0 && passScore <= totalScore)) fail('unavailable')
  return {
    autoScore,
    totalScore,
    passed: snapshot.questions.some(
      (question) => question.questionType === 'short_answer',
    )
      ? null
      : autoScore >= passScore,
    answers,
    questions,
  }
}

export function elearningExamAnswersEqual(
  left: ElearningExamAnswers,
  right: ElearningExamAnswers,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    const other = right[key]
    const value = left[key]
    if (typeof value === 'string' || typeof other === 'string') {
      if (typeof value !== 'string' || typeof other !== 'string' || value !== other) {
        return false
      }
      continue
    }
    if (!Array.isArray(value) || !Array.isArray(other)) return false
    if (!sameStringSet(value, other)) return false
  }
  return true
}

export function hasElearningManualQuestions(
  snapshot: ElearningPaperSnapshot,
): boolean {
  return snapshot.questions.some(
    (question) => question.questionType === 'short_answer',
  )
}

export function elearningExamObjectiveMaxScore(
  snapshot: ElearningPaperSnapshot,
): number {
  return snapshot.questions.reduce(
    (total, question) =>
      question.questionType === 'short_answer' ? total : total + question.points,
    0,
  )
}
