import { createHash } from 'node:crypto'

import {
  UUID_RE,
  validateElearningObjectiveQuestion,
  type ElearningObjectiveQuestion,
  type ElearningPublicQuestion,
} from './elearning-exam-domain'

/**
 * Pure L3.5 question-practice policy. A future adapter must load an
 * org-authorized immutable snapshot and persist wrong-book intents. This
 * module never exposes answer keys or explanations. The future adapter also
 * owns learner-access and server-issued-session checks.
 */

export const ELEARNING_QUESTION_PRACTICE_DOMAIN =
  'elearning.question-practice.v1' as const
export const ELEARNING_QUESTION_PRACTICE_VERSION = 1 as const

const MAX_QUESTIONS = 2_000
const MAX_ACTOR_LENGTH = 512

const SNAPSHOT_KEYS = [
  'domain',
  'orgId',
  'practiceId',
  'practiceRevisionId',
  'questions',
  'version',
] as const
const STANDARD_REQUEST_KEYS = ['mode', 'sessionId'] as const
const WRONG_BOOK_REQUEST_KEYS = [
  'mode',
  'sessionId',
  'wrongQuestionRevisionIds',
] as const
const ANSWER_REQUEST_KEYS = [
  'questionRevisionId',
  'selectedOptionIds',
  'sessionId',
  'userId',
] as const

export type ElearningQuestionPracticeMode =
  | 'sequential'
  | 'random'
  | 'wrong_book'

export type ElearningQuestionPracticePolicyErrorCode =
  | 'invalid_snapshot'
  | 'invalid_request'
  | 'question_not_found'

export class ElearningQuestionPracticePolicyError extends Error {
  constructor(readonly code: ElearningQuestionPracticePolicyErrorCode) {
    super(code)
    this.name = 'ElearningQuestionPracticePolicyError'
  }
}

declare const normalizedQuestionPracticeSnapshot: unique symbol

export interface ElearningQuestionPracticeSnapshot {
  readonly domain: typeof ELEARNING_QUESTION_PRACTICE_DOMAIN
  readonly orgId: string
  readonly practiceId: string
  readonly practiceRevisionId: string
  readonly questions: readonly ElearningObjectiveQuestion[]
  readonly version: typeof ELEARNING_QUESTION_PRACTICE_VERSION
  readonly [normalizedQuestionPracticeSnapshot]: true
}

export interface ElearningPublicQuestionPractice {
  readonly domain: typeof ELEARNING_QUESTION_PRACTICE_DOMAIN
  readonly mode: ElearningQuestionPracticeMode
  readonly practiceId: string
  readonly practiceRevisionId: string
  readonly questions: readonly ElearningPublicQuestion[]
  readonly sessionId: string
  readonly version: typeof ELEARNING_QUESTION_PRACTICE_VERSION
}

export interface ElearningQuestionPracticeWrongBookReference {
  readonly orgId: string
  readonly practiceId: string
  readonly practiceRevisionId: string
  readonly questionRevisionId: string
  readonly sessionId: string
  readonly userId: string
}

export interface ElearningQuestionPracticeWrongBookIntent {
  readonly entryKey: string
  readonly kind: 'practice_wrong_answer'
  readonly occurrenceKey: string
  readonly payloadDigest: string
  readonly reference: ElearningQuestionPracticeWrongBookReference
}

export interface ElearningQuestionPracticeAnswerDecision {
  readonly correct: boolean
  readonly practiceRevisionId: string
  readonly questionRevisionId: string
  readonly wrongBookIntent: ElearningQuestionPracticeWrongBookIntent | null
}

function fail(code: ElearningQuestionPracticePolicyErrorCode): never {
  throw new ElearningQuestionPracticePolicyError(code)
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: ElearningQuestionPracticePolicyErrorCode,
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(code)
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail(code)
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== expectedKeys.length
      || sorted.some((key, index) => key !== expectedKeys[index])
    ) fail(code)
    const values: Record<string, unknown> = {}
    for (const key of expectedKeys) values[key] = (input as Record<string, unknown>)[key]
    return values
  } catch (error) {
    if (error instanceof ElearningQuestionPracticePolicyError) throw error
    fail(code)
  }
}

function readDenseArray(
  input: unknown,
  code: ElearningQuestionPracticePolicyErrorCode,
): readonly unknown[] {
  try {
    if (!Array.isArray(input)) fail(code)
    const length = input.length
    if (Reflect.ownKeys(input).length !== length + 1) fail(code)
    const result: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail(code)
      result.push(input[index])
    }
    return result
  } catch (error) {
    if (error instanceof ElearningQuestionPracticePolicyError) throw error
    fail(code)
  }
}

function requireUuid(
  value: unknown,
  code: ElearningQuestionPracticePolicyErrorCode,
): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail(code)
  return value.toLowerCase()
}

function requireActor(
  value: unknown,
  code: ElearningQuestionPracticePolicyErrorCode,
): string {
  if (typeof value !== 'string') fail(code)
  const text = value.trim()
  if (
    text === ''
    || text.length > MAX_ACTOR_LENGTH
    || text.includes('\0')
    || !isWellFormedUnicode(text)
  ) fail(code)
  return text
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      return false
    }
  }
  return true
}

function hash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex')
}

function cloneQuestion(question: ElearningObjectiveQuestion): ElearningObjectiveQuestion {
  const answerKey = { correct: [...question.answerKey.correct] }
  const options = question.options.map((option) => ({ ...option }))
  Object.freeze(answerKey.correct)
  Object.freeze(answerKey)
  options.forEach(Object.freeze)
  Object.freeze(options)
  const copy: ElearningObjectiveQuestion = {
    ...question,
    answerKey,
    options,
  }
  return Object.freeze(copy)
}

export function createElearningQuestionPracticeSnapshot(
  input: unknown,
): ElearningQuestionPracticeSnapshot {
  const values = readExactObject(input, SNAPSHOT_KEYS, 'invalid_snapshot')
  if (
    values.domain !== ELEARNING_QUESTION_PRACTICE_DOMAIN
    || values.version !== ELEARNING_QUESTION_PRACTICE_VERSION
  ) fail('invalid_snapshot')
  const questionInputs = readDenseArray(values.questions, 'invalid_snapshot')
  if (questionInputs.length === 0 || questionInputs.length > MAX_QUESTIONS) {
    fail('invalid_snapshot')
  }

  const positions = new Set<number>()
  const revisionIds = new Set<string>()
  const questions = questionInputs.map((questionInput) => {
    let question: ElearningObjectiveQuestion
    try {
      question = validateElearningObjectiveQuestion(questionInput, 'unavailable')
    } catch {
      fail('invalid_snapshot')
    }
    if (positions.has(question.position) || revisionIds.has(question.questionRevisionId)) {
      fail('invalid_snapshot')
    }
    positions.add(question.position)
    revisionIds.add(question.questionRevisionId)
    return cloneQuestion(question)
  }).sort((left, right) => left.position - right.position)

  return Object.freeze({
    domain: ELEARNING_QUESTION_PRACTICE_DOMAIN,
    orgId: requireActor(values.orgId, 'invalid_snapshot'),
    practiceId: requireUuid(values.practiceId, 'invalid_snapshot'),
    practiceRevisionId: requireUuid(values.practiceRevisionId, 'invalid_snapshot'),
    questions: Object.freeze(questions),
    version: ELEARNING_QUESTION_PRACTICE_VERSION,
  }) as ElearningQuestionPracticeSnapshot
}

function publicQuestion(
  question: ElearningObjectiveQuestion,
  index: number,
): ElearningPublicQuestion {
  const options = question.options.map((option) => ({ ...option }))
  options.forEach(Object.freeze)
  Object.freeze(options)
  const copy: ElearningPublicQuestion = {
    options,
    points: question.points,
    position: index + 1,
    prompt: question.prompt,
    questionRevisionId: question.questionRevisionId,
    questionType: question.questionType,
  }
  return Object.freeze(copy)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function randomRank(sessionId: string, questionRevisionId: string): string {
  return hash({
    domain: ELEARNING_QUESTION_PRACTICE_DOMAIN,
    questionRevisionId,
    sessionId,
  })
}

export function materializeElearningQuestionPractice(
  snapshotInput: unknown,
  requestInput: unknown,
): ElearningPublicQuestionPractice {
  const snapshot = createElearningQuestionPracticeSnapshot(snapshotInput)
  if (requestInput === null || typeof requestInput !== 'object' || Array.isArray(requestInput)) {
    fail('invalid_request')
  }
  let rawMode: unknown
  try {
    rawMode = (requestInput as Record<string, unknown>).mode
  } catch {
    fail('invalid_request')
  }
  const expectedKeys = rawMode === 'wrong_book'
    ? WRONG_BOOK_REQUEST_KEYS
    : STANDARD_REQUEST_KEYS
  const values = readExactObject(requestInput, expectedKeys, 'invalid_request')
  const mode = values.mode
  if (mode !== 'sequential' && mode !== 'random' && mode !== 'wrong_book') {
    fail('invalid_request')
  }
  const sessionId = requireUuid(values.sessionId, 'invalid_request')
  let questions = [...snapshot.questions]

  if (mode === 'random') {
    questions.sort((left, right) => (
      compareText(
        randomRank(sessionId, left.questionRevisionId),
        randomRank(sessionId, right.questionRevisionId),
      ) || compareText(left.questionRevisionId, right.questionRevisionId)
    ))
  } else if (mode === 'wrong_book') {
    const wrongInputs = readDenseArray(values.wrongQuestionRevisionIds, 'invalid_request')
    if (wrongInputs.length > MAX_QUESTIONS) fail('invalid_request')
    const wrongIds = new Set<string>()
    for (const input of wrongInputs) {
      const id = requireUuid(input, 'invalid_request')
      if (wrongIds.has(id)) fail('invalid_request')
      wrongIds.add(id)
    }
    questions = questions.filter((question) => wrongIds.has(question.questionRevisionId))
  }

  return Object.freeze({
    domain: snapshot.domain,
    mode,
    practiceId: snapshot.practiceId,
    practiceRevisionId: snapshot.practiceRevisionId,
    questions: Object.freeze(questions.map(publicQuestion)),
    sessionId,
    version: snapshot.version,
  })
}

function readSelectedOptionIds(
  question: ElearningObjectiveQuestion,
  input: unknown,
): readonly string[] {
  const inputs = readDenseArray(input, 'invalid_request')
  const optionIds = new Set(question.options.map((option) => option.id))
  const selected = new Set<string>()
  for (const value of inputs) {
    if (typeof value !== 'string') fail('invalid_request')
    const id = value.trim()
    if (id === '' || !optionIds.has(id) || selected.has(id)) fail('invalid_request')
    selected.add(id)
  }
  if (question.questionType !== 'multiple_choice' && selected.size > 1) {
    fail('invalid_request')
  }
  return [...selected].sort(compareText)
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

export function evaluateElearningQuestionPracticeAnswer(
  snapshotInput: unknown,
  requestInput: unknown,
): ElearningQuestionPracticeAnswerDecision {
  const snapshot = createElearningQuestionPracticeSnapshot(snapshotInput)
  const values = readExactObject(requestInput, ANSWER_REQUEST_KEYS, 'invalid_request')
  const questionRevisionId = requireUuid(values.questionRevisionId, 'invalid_request')
  const question = snapshot.questions.find(
    (candidate) => candidate.questionRevisionId === questionRevisionId,
  )
  if (!question) fail('question_not_found')
  const sessionId = requireUuid(values.sessionId, 'invalid_request')
  const userId = requireActor(values.userId, 'invalid_request')
  const selected = readSelectedOptionIds(question, values.selectedOptionIds)
  const correct = sameIds(selected, [...question.answerKey.correct].sort(compareText))
  if (correct) {
    return Object.freeze({
      correct: true,
      practiceRevisionId: snapshot.practiceRevisionId,
      questionRevisionId,
      wrongBookIntent: null,
    })
  }

  const entryIdentity = {
    domain: ELEARNING_QUESTION_PRACTICE_DOMAIN,
    orgId: snapshot.orgId,
    practiceId: snapshot.practiceId,
    questionRevisionId,
    userId,
  }
  const reference = Object.freeze({
    orgId: snapshot.orgId,
    practiceId: snapshot.practiceId,
    practiceRevisionId: snapshot.practiceRevisionId,
    questionRevisionId,
    sessionId,
    userId,
  })
  const wrongBookIntent = Object.freeze({
    entryKey: `${ELEARNING_QUESTION_PRACTICE_DOMAIN}:entry:${hash(entryIdentity)}`,
    kind: 'practice_wrong_answer' as const,
    occurrenceKey: `${ELEARNING_QUESTION_PRACTICE_DOMAIN}:occurrence:${hash({
      ...entryIdentity,
      sessionId,
    })}`,
    payloadDigest: hash({
      domain: ELEARNING_QUESTION_PRACTICE_DOMAIN,
      kind: 'practice_wrong_answer',
      reference,
    }),
    reference,
  })
  return Object.freeze({
    correct: false,
    practiceRevisionId: snapshot.practiceRevisionId,
    questionRevisionId,
    wrongBookIntent,
  })
}
