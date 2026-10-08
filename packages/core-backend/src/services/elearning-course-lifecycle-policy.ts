/**
 * Pure L1 authority for course-head and immutable-version lifecycle changes.
 *
 * Adapters remain responsible for authenticated organization scope, same-org
 * row locks, audit persistence, and executing a publish plan in one transaction.
 */

export const ELEARNING_COURSE_LIFECYCLE_ACTOR_MAX = 256 as const
export const ELEARNING_COURSE_LIFECYCLE_REASON_MAX = 2_000 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEAD_TRANSITION_KEYS = [
  'actorId',
  'courseId',
  'fromStatus',
  'reason',
  'toStatus',
] as const
const DRAFT_POINTER_KEYS = [
  'activeVersionId',
  'courseId',
  'draftVersionId',
  'latestVersionId',
] as const
const PUBLISH_POINTER_KEYS = [
  'activeVersionId',
  'courseId',
  'draftVersionId',
  'draftVersionStatus',
  'latestVersionId',
  'previousActiveVersionStatus',
] as const
const VERSION_TRANSITION_KEYS = [
  'fromStatus',
  'isActiveVersion',
  'toStatus',
] as const

export const ELEARNING_COURSE_HEAD_STATUSES = [
  'active',
  'archived',
  'withdrawn',
] as const
export const ELEARNING_COURSE_VERSION_STATUSES = [
  'draft',
  'published',
  'retired',
] as const

export type ElearningCourseHeadStatus =
  (typeof ELEARNING_COURSE_HEAD_STATUSES)[number]
export type ElearningCourseVersionStatus =
  (typeof ELEARNING_COURSE_VERSION_STATUSES)[number]
export type ElearningCourseLifecyclePolicyErrorCode =
  | 'illegal_transition'
  | 'invalid_input'
  | 'reason_required'

export class ElearningCourseLifecyclePolicyError extends Error {
  constructor(readonly code: ElearningCourseLifecyclePolicyErrorCode) {
    super(code)
    this.name = 'ElearningCourseLifecyclePolicyError'
  }
}

export interface ElearningCourseHeadTransition {
  readonly actorId: string
  readonly courseId: string
  readonly fromStatus: ElearningCourseHeadStatus
  readonly reason: string | null
  readonly toStatus: ElearningCourseHeadStatus
}

export interface ElearningCourseDraftPointerPlan {
  readonly activeVersionId: string | null
  readonly courseId: string
  readonly draftVersionId: string
  readonly latestVersionId: string
}

export interface ElearningCoursePublishPointerPlan {
  readonly courseId: string
  readonly nextActiveVersionId: string
  readonly nextLatestVersionId: string
  readonly previousActiveVersionId: string | null
  readonly publishVersionId: string
  readonly retireAfterPointerMoveVersionId: string | null
}

export interface ElearningCourseVersionTransition {
  readonly fromStatus: ElearningCourseVersionStatus
  readonly toStatus: ElearningCourseVersionStatus
}

function fail(code: ElearningCourseLifecyclePolicyErrorCode): never {
  throw new ElearningCourseLifecyclePolicyError(code)
}

function readExactObject(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_input')
  }
  try {
    const ownKeys = Reflect.ownKeys(input)
    if (ownKeys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail('invalid_input')
    const sorted = (ownKeys as string[]).sort()
    if (
      sorted.length !== keys.length
      || sorted.some((key, index) => key !== keys[index])
    ) fail('invalid_input')
    return Object.fromEntries(
      keys.map((key) => [key, (input as Record<string, unknown>)[key]]),
    )
  } catch (error) {
    if (error instanceof ElearningCourseLifecyclePolicyError) throw error
    fail('invalid_input')
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) return false
  }
  return true
}

function requireText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (
    text === ''
    || text.length > maxLength
    || text.includes('\0')
    || !isWellFormedUnicode(text)
  ) fail('invalid_input')
  return text
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : requireUuid(value)
}

function requireHeadStatus(value: unknown): ElearningCourseHeadStatus {
  if (!ELEARNING_COURSE_HEAD_STATUSES.includes(value as ElearningCourseHeadStatus)) {
    fail('invalid_input')
  }
  return value as ElearningCourseHeadStatus
}

function requireVersionStatus(value: unknown): ElearningCourseVersionStatus {
  if (!ELEARNING_COURSE_VERSION_STATUSES.includes(value as ElearningCourseVersionStatus)) {
    fail('invalid_input')
  }
  return value as ElearningCourseVersionStatus
}

function nullableReason(value: unknown): string | null {
  return value === null
    ? null
    : requireText(value, ELEARNING_COURSE_LIFECYCLE_REASON_MAX)
}

export function planElearningCourseHeadTransition(
  input: unknown,
): ElearningCourseHeadTransition {
  const values = readExactObject(input, HEAD_TRANSITION_KEYS)
  const fromStatus = requireHeadStatus(values.fromStatus)
  const toStatus = requireHeadStatus(values.toStatus)
  const allowed = (
    (fromStatus === 'active' && (toStatus === 'archived' || toStatus === 'withdrawn'))
    || (fromStatus === 'archived' && (toStatus === 'active' || toStatus === 'withdrawn'))
    || (fromStatus === 'withdrawn' && toStatus === 'active')
  )
  if (!allowed) fail('illegal_transition')
  const reason = nullableReason(values.reason)
  if ((fromStatus === 'withdrawn' || toStatus === 'withdrawn') && reason === null) {
    fail('reason_required')
  }
  return Object.freeze({
    actorId: requireText(values.actorId, ELEARNING_COURSE_LIFECYCLE_ACTOR_MAX),
    courseId: requireUuid(values.courseId),
    fromStatus,
    reason,
    toStatus,
  })
}

export function planElearningCourseDraftPointers(
  input: unknown,
): ElearningCourseDraftPointerPlan {
  const values = readExactObject(input, DRAFT_POINTER_KEYS)
  const courseId = requireUuid(values.courseId)
  const activeVersionId = nullableUuid(values.activeVersionId)
  const latestVersionId = nullableUuid(values.latestVersionId)
  const draftVersionId = requireUuid(values.draftVersionId)
  if (
    latestVersionId !== activeVersionId
    || draftVersionId === activeVersionId
    || draftVersionId === latestVersionId
  ) fail('illegal_transition')
  return Object.freeze({
    activeVersionId,
    courseId,
    draftVersionId,
    latestVersionId: draftVersionId,
  })
}

export function planElearningCoursePublishPointers(
  input: unknown,
): ElearningCoursePublishPointerPlan {
  const values = readExactObject(input, PUBLISH_POINTER_KEYS)
  const courseId = requireUuid(values.courseId)
  const activeVersionId = nullableUuid(values.activeVersionId)
  const draftVersionId = requireUuid(values.draftVersionId)
  const latestVersionId = requireUuid(values.latestVersionId)
  const draftVersionStatus = requireVersionStatus(values.draftVersionStatus)
  const previousActiveVersionStatus = values.previousActiveVersionStatus === null
    ? null
    : requireVersionStatus(values.previousActiveVersionStatus)
  if (
    draftVersionStatus !== 'draft'
    || latestVersionId !== draftVersionId
    || activeVersionId === draftVersionId
    || (activeVersionId === null) !== (previousActiveVersionStatus === null)
    || (activeVersionId !== null && previousActiveVersionStatus !== 'published')
  ) fail('illegal_transition')
  return Object.freeze({
    courseId,
    nextActiveVersionId: draftVersionId,
    nextLatestVersionId: draftVersionId,
    previousActiveVersionId: activeVersionId,
    publishVersionId: draftVersionId,
    retireAfterPointerMoveVersionId: activeVersionId,
  })
}

export function validateElearningCourseVersionTransition(
  input: unknown,
): ElearningCourseVersionTransition {
  const values = readExactObject(input, VERSION_TRANSITION_KEYS)
  const fromStatus = requireVersionStatus(values.fromStatus)
  const toStatus = requireVersionStatus(values.toStatus)
  if (typeof values.isActiveVersion !== 'boolean') fail('invalid_input')
  const allowed = (
    fromStatus === 'draft'
    && toStatus === 'published'
    && !values.isActiveVersion
  ) || (
    fromStatus === 'published'
    && toStatus === 'retired'
    && !values.isActiveVersion
  )
  if (!allowed) fail('illegal_transition')
  return Object.freeze({ fromStatus, toStatus })
}
