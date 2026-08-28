import { ELEARNING_DOCUMENT_MAX_PAGES } from './elearning-document-completion-policy'
import {
  ELEARNING_COURSE_VERSION_MAX_ITEMS,
  normalizeElearningCourseVersionItems,
  type ElearningCourseVersionItem,
  type ElearningCourseVersionItemType,
} from './elearning-course-version-items-policy'

/**
 * Pure L1 publication-readiness authority for a mixed-content course version.
 *
 * Adapters must derive authority rows from same-org locked storage. In
 * particular, revision_verified means the immutable article/external revision
 * was loaded and its stored digest was revalidated; server_probe means the
 * page count or duration came from the platform probe rather than the client.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INPUT_KEYS = ['authorities', 'items'] as const
const AUTHORITY_KEYS = [
  'itemId',
  'itemType',
  'measurementAuthority',
  'referenceId',
  'referenceState',
  'serverDurationMs',
  'serverPageCount',
] as const
const ITEM_TYPES = [
  'article',
  'document',
  'exam',
  'external_link',
  'video',
] as const
const REFERENCE_STATES = [
  'draft',
  'published',
  'probing',
  'ready',
  'rejected',
  'retired',
  'revision_verified',
  'revision_unverified',
  'uploading',
] as const

export type ElearningCoursePublishReferenceState =
  (typeof REFERENCE_STATES)[number]
export type ElearningCoursePublishMeasurementAuthority = 'server_probe' | null
export type ElearningCoursePublishReadinessErrorCode =
  | 'invalid_input'
  | 'reference_unavailable'

export class ElearningCoursePublishReadinessError extends Error {
  constructor(readonly code: ElearningCoursePublishReadinessErrorCode) {
    super(code)
    this.name = 'ElearningCoursePublishReadinessError'
  }
}

export interface ElearningCoursePublishReferenceAuthority {
  readonly itemId: string
  readonly itemType: ElearningCourseVersionItemType
  readonly measurementAuthority: ElearningCoursePublishMeasurementAuthority
  readonly referenceId: string
  readonly referenceState: ElearningCoursePublishReferenceState
  readonly serverDurationMs: number | null
  readonly serverPageCount: number | null
}

export interface ElearningCoursePublishReadiness {
  readonly authorities: readonly ElearningCoursePublishReferenceAuthority[]
  readonly items: readonly ElearningCourseVersionItem[]
}

function fail(code: ElearningCoursePublishReadinessErrorCode): never {
  throw new ElearningCoursePublishReadinessError(code)
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
    if (error instanceof ElearningCoursePublishReadinessError) throw error
    fail('invalid_input')
  }
}

function readDenseAuthorities(input: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(input)) fail('invalid_input')
    const length = input.length
    if (
      length > ELEARNING_COURSE_VERSION_MAX_ITEMS
      || Reflect.ownKeys(input).length !== length + 1
    ) fail('invalid_input')
    const values: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail('invalid_input')
      values.push(input[index])
    }
    return values
  } catch (error) {
    if (error instanceof ElearningCoursePublishReadinessError) throw error
    fail('invalid_input')
  }
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function requireItemType(value: unknown): ElearningCourseVersionItemType {
  if (!ITEM_TYPES.includes(value as ElearningCourseVersionItemType)) {
    fail('invalid_input')
  }
  return value as ElearningCourseVersionItemType
}

function requireReferenceState(value: unknown): ElearningCoursePublishReferenceState {
  if (!REFERENCE_STATES.includes(value as ElearningCoursePublishReferenceState)) {
    fail('invalid_input')
  }
  return value as ElearningCoursePublishReferenceState
}

function nullablePositiveSafeInteger(value: unknown): number | null {
  if (value === null) return null
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
  ) fail('invalid_input')
  return value
}

function expectedReferenceState(
  itemType: ElearningCourseVersionItemType,
): ElearningCoursePublishReferenceState {
  if (itemType === 'article' || itemType === 'external_link') {
    return 'revision_verified'
  }
  if (itemType === 'exam') return 'published'
  return 'ready'
}

function itemReferenceId(item: ElearningCourseVersionItem): string {
  const referenceId = item.articleRevisionId
    ?? item.examId
    ?? item.externalLinkRevisionId
    ?? item.mediaId
  if (referenceId === null) fail('reference_unavailable')
  return referenceId
}

function normalizeAuthority(input: unknown): ElearningCoursePublishReferenceAuthority {
  const values = readExactObject(input, AUTHORITY_KEYS)
  const itemType = requireItemType(values.itemType)
  const referenceState = requireReferenceState(values.referenceState)
  if (referenceState !== expectedReferenceState(itemType)) {
    fail('reference_unavailable')
  }
  const measurementAuthority = values.measurementAuthority
  if (measurementAuthority !== null && measurementAuthority !== 'server_probe') {
    fail('invalid_input')
  }
  const serverDurationMs = nullablePositiveSafeInteger(values.serverDurationMs)
  const serverPageCount = nullablePositiveSafeInteger(values.serverPageCount)
  if (itemType === 'document') {
    if (
      measurementAuthority !== 'server_probe'
      || serverDurationMs !== null
      || serverPageCount === null
      || serverPageCount > ELEARNING_DOCUMENT_MAX_PAGES
    ) fail('reference_unavailable')
  } else if (itemType === 'video') {
    if (
      measurementAuthority !== 'server_probe'
      || serverDurationMs === null
      || serverPageCount !== null
    ) fail('reference_unavailable')
  } else if (
    measurementAuthority !== null
    || serverDurationMs !== null
    || serverPageCount !== null
  ) fail('reference_unavailable')

  return Object.freeze({
    itemId: requireUuid(values.itemId),
    itemType,
    measurementAuthority,
    referenceId: requireUuid(values.referenceId),
    referenceState,
    serverDurationMs,
    serverPageCount,
  })
}

export function assertElearningCoursePublishReadiness(
  input: unknown,
): ElearningCoursePublishReadiness {
  const values = readExactObject(input, INPUT_KEYS)
  let items: readonly ElearningCourseVersionItem[]
  try {
    items = normalizeElearningCourseVersionItems(values.items)
  } catch {
    fail('invalid_input')
  }
  const authorityInputs = readDenseAuthorities(values.authorities)
  if (authorityInputs.length !== items.length) fail('reference_unavailable')
  const authoritiesByItemId = new Map<string, ElearningCoursePublishReferenceAuthority>()
  for (const authorityInput of authorityInputs) {
    const authority = normalizeAuthority(authorityInput)
    if (authoritiesByItemId.has(authority.itemId)) fail('reference_unavailable')
    authoritiesByItemId.set(authority.itemId, authority)
  }
  const authorities = items.map((item) => {
    const authority = authoritiesByItemId.get(item.itemId)
    if (
      !authority
      || authority.itemType !== item.itemType
      || authority.referenceId !== itemReferenceId(item)
    ) fail('reference_unavailable')
    return authority
  })
  return Object.freeze({
    authorities: Object.freeze(authorities),
    items,
  })
}
