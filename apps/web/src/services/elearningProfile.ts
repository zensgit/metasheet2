import { apiFetch } from '../utils/api'
import { ElearningApiError } from './elearning'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANONICAL_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const STABLE_ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,62}$/
const FORBIDDEN_KEYS = new Set([
  'actorId', 'actor_id', 'answers', 'eventDigest', 'event_digest',
  'grading', 'paperSnapshot', 'paper_snapshot', 'requestHash', 'request_hash',
])

export interface ElearningLearningProfileExam {
  itemId: string
  earnedScore: number
  totalScore: number
  passedAt: string
}

export interface ElearningLearningProfileAssessmentCourse {
  courseId: string
  courseVersionId: string
  title: string
  kind: 'assessment'
  completedAt: string
  exams: ElearningLearningProfileExam[]
}

export interface ElearningLearningProfileContentCourse {
  courseId: string
  courseVersionId: string
  title: string
  kind: 'content'
  completedAt: string
}

export type ElearningLearningProfileCourse =
  | ElearningLearningProfileAssessmentCourse
  | ElearningLearningProfileContentCourse

export interface ElearningLearningProfile {
  userId: string
  summary: {
    completedCourses: number
    assessmentCourses: number
    contentCourses: number
  }
  courses: ElearningLearningProfileCourse[]
  nextCursor: string | null
}

function fail(code: string, status: number): never {
  throw new ElearningApiError(code, status)
}

function invalidResponse(status: number): never {
  fail('invalid_response', status)
}

function object(value: unknown, status: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidResponse(status)
  }
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function hasForbiddenKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKeys)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => FORBIDDEN_KEYS.has(key) || hasForbiddenKeys(child),
  )
}

function uuid(value: unknown, status: number): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) invalidResponse(status)
  return value.toLowerCase()
}

function text(value: unknown, status: number): string {
  if (typeof value !== 'string' || value.trim() === '') invalidResponse(status)
  return value
}

function timestamp(value: unknown, status: number): string {
  const candidate = text(value, status)
  const parsed = new Date(candidate)
  if (
    !CANONICAL_TIMESTAMP_RE.test(candidate)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString() !== candidate
  ) invalidResponse(status)
  return candidate
}

function integer(value: unknown, status: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidResponse(status)
  return value as number
}

function score(value: unknown, status: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    invalidResponse(status)
  }
  return value
}

function parseExam(value: unknown, status: number): ElearningLearningProfileExam {
  const row = object(value, status)
  if (!exact(row, ['itemId', 'earnedScore', 'totalScore', 'passedAt'])) {
    invalidResponse(status)
  }
  const earnedScore = score(row.earnedScore, status)
  const totalScore = score(row.totalScore, status)
  if (earnedScore > totalScore) invalidResponse(status)
  return {
    itemId: uuid(row.itemId, status),
    earnedScore,
    totalScore,
    passedAt: timestamp(row.passedAt, status),
  }
}

function parseCourse(value: unknown, status: number): ElearningLearningProfileCourse {
  const row = object(value, status)
  const common = {
    courseId: uuid(row.courseId, status),
    courseVersionId: uuid(row.courseVersionId, status),
    title: text(row.title, status),
    completedAt: timestamp(row.completedAt, status),
  }
  if (row.kind === 'assessment') {
    if (!exact(row, [
      'courseId', 'courseVersionId', 'title', 'kind', 'completedAt', 'exams',
    ]) || !Array.isArray(row.exams) || row.exams.length === 0) {
      invalidResponse(status)
    }
    return {
      ...common,
      kind: 'assessment',
      exams: row.exams.map((exam) => parseExam(exam, status)),
    }
  }
  if (row.kind === 'content' && exact(row, [
    'courseId', 'courseVersionId', 'title', 'kind', 'completedAt',
  ])) {
    return { ...common, kind: 'content' }
  }
  return invalidResponse(status)
}

function errorCode(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'request_failed'
  }
  const candidate = (payload as Record<string, unknown>).error
  if (candidate === 'ORG_CONTEXT_REQUIRED') return candidate
  return typeof candidate === 'string' && STABLE_ERROR_CODE_RE.test(candidate)
    ? candidate
    : 'request_failed'
}

function parseProfile(value: unknown, status: number): ElearningLearningProfile {
  if (hasForbiddenKeys(value)) invalidResponse(status)
  const row = object(value, status)
  if (!exact(row, ['userId', 'summary', 'courses', 'nextCursor'])) {
    invalidResponse(status)
  }
  const summary = object(row.summary, status)
  if (!exact(summary, [
    'completedCourses', 'assessmentCourses', 'contentCourses',
  ]) || !Array.isArray(row.courses)) invalidResponse(status)
  const completedCourses = integer(summary.completedCourses, status)
  const assessmentCourses = integer(summary.assessmentCourses, status)
  const contentCourses = integer(summary.contentCourses, status)
  if (assessmentCourses + contentCourses !== completedCourses) {
    invalidResponse(status)
  }
  const nextCursor = row.nextCursor === null
    ? null
    : typeof row.nextCursor === 'string'
      && row.nextCursor.length > 0
      && row.nextCursor.length <= 512
      && /^[A-Za-z0-9_-]+$/.test(row.nextCursor)
      ? row.nextCursor
      : invalidResponse(status)
  return {
    userId: text(row.userId, status),
    summary: { completedCourses, assessmentCourses, contentCourses },
    courses: row.courses.map((course) => parseCourse(course, status)),
    nextCursor,
  }
}

export async function getMyElearningLearningProfile(
  cursor: string | null = null,
  limit = 20,
): Promise<ElearningLearningProfile> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail('invalid_input', 400)
  }
  const query = new URLSearchParams({ limit: String(limit) })
  if (cursor !== null) {
    if (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      fail('invalid_input', 400)
    }
    query.set('cursor', cursor)
  }
  let response: Response
  try {
    response = await apiFetch(`/api/elearning/profile?${query.toString()}`, {
      method: 'GET',
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
  if (response.status !== 200) fail(errorCode(payload), response.status)
  return parseProfile(payload, response.status)
}
