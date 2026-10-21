import { createHash } from 'node:crypto'

import {
  UUID_RE,
  validateElearningObjectiveQuestion,
  type ElearningObjectiveQuestion,
  type ElearningPublicQuestion,
} from './elearning-exam-domain'

export const ELEARNING_PRACTICE_REQUEST_HASH_VERSION = 1 as const
export const ELEARNING_PRACTICE_MAX_QUESTIONS = 2_000 as const

export type ElearningPracticeMode = 'sequential' | 'random' | 'wrong_book'
export type ElearningPracticeErrorCode =
  | 'disabled'
  | 'invalid_input'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'unavailable'

export class ElearningPracticeError extends Error {
  constructor(readonly code: ElearningPracticeErrorCode) {
    super(code)
    this.name = 'ElearningPracticeError'
  }
}

export interface ElearningPracticeQuestion extends ElearningPublicQuestion {
  questionId: string
}

export interface ElearningPracticeStoredQuestion extends ElearningPracticeQuestion {
  answerKey: { correct: string[] }
  explanation: string | null
}

function fail(code: ElearningPracticeErrorCode): never {
  throw new ElearningPracticeError(code)
}

export function requirePracticeText(value: unknown, max = 512): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > max || text.includes('\0')) fail('invalid_input')
  return text
}

export function requirePracticeUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

export function normalizePracticeMode(value: unknown): ElearningPracticeMode {
  if (value !== 'sequential' && value !== 'random' && value !== 'wrong_book') {
    fail('invalid_input')
  }
  return value
}

function canonicalize(value: unknown): string {
  const walk = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(walk)
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(
        Object.keys(candidate as Record<string, unknown>)
          .sort()
          .map((key) => [key, walk((candidate as Record<string, unknown>)[key])]),
      )
    }
    return candidate
  }
  return JSON.stringify(walk(value))
}

export function hashElearningPracticeRequest(
  domain: 'create_set' | 'start_session' | 'answer',
  payload: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(canonicalize({
      domain: `elearning.practice.${domain}.v1`,
      payload,
      version: ELEARNING_PRACTICE_REQUEST_HASH_VERSION,
    }), 'utf8')
    .digest('hex')
}

function randomRank(sessionId: string, revisionId: string): string {
  return createHash('sha256')
    .update(`${sessionId}:${revisionId}`, 'utf8')
    .digest('hex')
}

export function orderElearningPracticeQuestions(
  questions: readonly ElearningPracticeStoredQuestion[],
  mode: ElearningPracticeMode,
  sessionId: string,
  wrongRevisionIds: ReadonlySet<string> = new Set(),
): ElearningPracticeStoredQuestion[] {
  let selected = mode === 'wrong_book'
    ? questions.filter((question) => wrongRevisionIds.has(question.questionRevisionId))
    : [...questions]
  if (mode === 'random') {
    selected = selected.sort((left, right) => {
      const leftRank = randomRank(sessionId, left.questionRevisionId)
      const rightRank = randomRank(sessionId, right.questionRevisionId)
      return leftRank.localeCompare(rightRank)
        || left.questionRevisionId.localeCompare(right.questionRevisionId)
    })
  }
  return selected.map((question, index) => ({ ...question, position: index + 1 }))
}

export function parseElearningPracticeStoredQuestion(
  row: Record<string, unknown>,
): ElearningPracticeStoredQuestion {
  let question: ElearningObjectiveQuestion
  try {
    question = validateElearningObjectiveQuestion(row, 'unavailable')
  } catch {
    fail('unavailable')
  }
  return question
}

export function publicElearningPracticeQuestion(
  question: ElearningPracticeStoredQuestion,
): ElearningPracticeQuestion {
  return {
    questionId: question.questionId,
    questionRevisionId: question.questionRevisionId,
    questionType: question.questionType,
    prompt: question.prompt,
    options: question.options.map((option) => ({ ...option })),
    points: question.points,
    position: question.position,
  }
}

export function normalizePracticeSelectedOptionIds(
  question: ElearningPracticeStoredQuestion,
  value: unknown,
): string[] {
  if (!Array.isArray(value)) fail('invalid_input')
  const available = new Set(question.options.map((option) => option.id))
  const selected = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') fail('invalid_input')
    const optionId = raw.trim()
    if (optionId === '' || !available.has(optionId) || selected.has(optionId)) {
      fail('invalid_input')
    }
    selected.add(optionId)
  }
  if (question.questionType !== 'multiple_choice' && selected.size > 1) {
    fail('invalid_input')
  }
  return [...selected].sort()
}

export function isElearningPracticeAnswerCorrect(
  question: ElearningPracticeStoredQuestion,
  selectedOptionIds: readonly string[],
): boolean {
  const correct = [...question.answerKey.correct].sort()
  return selectedOptionIds.length === correct.length
    && selectedOptionIds.every((optionId, index) => optionId === correct[index])
}
