/**
 * Pure L1 course-level statistics policy for one immutable course version.
 *
 * Adapters must supply server-owned counts deduplicated by user and course
 * version. Assignment access wins when a learner also matches visibility, so
 * assignedLearnerCount and selfStudyLearnerCount are mutually exclusive.
 */

export const ELEARNING_COURSE_STATS_POLICY_VERSION =
  'elearning.course-stats.v1' as const

const MAX_KEY_LENGTH = 512
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INPUT_KEYS = [
  'counters',
  'courseId',
  'courseVersionId',
  'orgId',
  'sourceVersion',
] as const
const COUNTER_KEYS = [
  'assignedLearnerCount',
  'completedCount',
  'inProgressCount',
  'notStartedCount',
  'overdueCount',
  'selfStudyLearnerCount',
] as const

export type ElearningCourseStatsPolicyErrorCode =
  | 'inconsistent_counters'
  | 'invalid_counters'
  | 'invalid_input'

export class ElearningCourseStatsPolicyError extends Error {
  constructor(readonly code: ElearningCourseStatsPolicyErrorCode) {
    super(code)
    this.name = 'ElearningCourseStatsPolicyError'
  }
}

export interface ElearningCourseStatsMetrics {
  readonly assignedLearnerCount: number
  readonly completedCount: number
  readonly completionRate: number
  readonly inProgressCount: number
  readonly learnerCount: number
  readonly notStartedCount: number
  readonly overdueCount: number
  readonly selfStudyLearnerCount: number
  readonly startedCount: number
}

export interface ElearningCourseStatsSnapshot {
  readonly courseId: string
  readonly courseVersionId: string
  readonly metrics: ElearningCourseStatsMetrics
  readonly orgId: string
  readonly policyVersion: typeof ELEARNING_COURSE_STATS_POLICY_VERSION
  readonly sourceVersion: string
}

function fail(code: ElearningCourseStatsPolicyErrorCode): never {
  throw new ElearningCourseStatsPolicyError(code)
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: ElearningCourseStatsPolicyErrorCode,
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail(code)
  }
  try {
    const ownKeys = Reflect.ownKeys(input)
    if (ownKeys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail(code)
    const sorted = (ownKeys as string[]).sort()
    if (
      sorted.length !== expectedKeys.length
      || sorted.some((key, index) => key !== expectedKeys[index])
    ) fail(code)
    return Object.fromEntries(
      expectedKeys.map((key) => [
        key,
        (input as Record<string, unknown>)[key],
      ]),
    )
  } catch (error) {
    if (error instanceof ElearningCourseStatsPolicyError) throw error
    fail(code)
  }
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
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

function requireKey(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (
    text === ''
    || text.length > MAX_KEY_LENGTH
    || text.includes('\0')
    || !isWellFormedUnicode(text)
  ) fail('invalid_input')
  return text
}

function requireCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('invalid_counters')
  }
  return value
}

function checkedAdd(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total)) fail('invalid_counters')
  return total
}

export function buildElearningCourseStatsSnapshot(
  input: unknown,
): ElearningCourseStatsSnapshot {
  const values = readExactObject(input, INPUT_KEYS, 'invalid_input')
  const counters = readExactObject(
    values.counters,
    COUNTER_KEYS,
    'invalid_counters',
  )
  const assignedLearnerCount = requireCount(counters.assignedLearnerCount)
  const selfStudyLearnerCount = requireCount(counters.selfStudyLearnerCount)
  const notStartedCount = requireCount(counters.notStartedCount)
  const inProgressCount = requireCount(counters.inProgressCount)
  const completedCount = requireCount(counters.completedCount)
  const overdueCount = requireCount(counters.overdueCount)
  const learnerCount = checkedAdd(assignedLearnerCount, selfStudyLearnerCount)
  const startedCount = checkedAdd(inProgressCount, completedCount)
  const progressCount = checkedAdd(notStartedCount, startedCount)
  if (progressCount !== learnerCount || overdueCount > assignedLearnerCount) {
    fail('inconsistent_counters')
  }

  const metrics = Object.freeze({
    assignedLearnerCount,
    completedCount,
    completionRate: learnerCount === 0 ? 0 : completedCount / learnerCount,
    inProgressCount,
    learnerCount,
    notStartedCount,
    overdueCount,
    selfStudyLearnerCount,
    startedCount,
  })
  return Object.freeze({
    courseId: requireUuid(values.courseId),
    courseVersionId: requireUuid(values.courseVersionId),
    metrics,
    orgId: requireKey(values.orgId),
    policyVersion: ELEARNING_COURSE_STATS_POLICY_VERSION,
    sourceVersion: requireKey(values.sourceVersion),
  })
}
