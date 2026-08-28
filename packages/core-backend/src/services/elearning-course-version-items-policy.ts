import { ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION } from './elearning-document-completion-policy'
import {
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
} from './elearning-watch-progress'

/**
 * Pure authority for the ordered items frozen into one course version.
 *
 * A series course is an ordered mixture of these rows, not a mutable container
 * that points at the latest child content. Adapters must resolve each reference
 * to the same organization and immutable parent version before using this
 * policy. Article/external-link revision persistence is added by the later L1
 * SQL slice; this module fixes their closed item shapes first.
 */

export const ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION = 'article-open-v1' as const
export const ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION =
  'external-link-launch-v1' as const
export const ELEARNING_COURSE_VERSION_MAX_ITEMS = 10_000 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ITEM_TYPES = [
  'article',
  'document',
  'exam',
  'external_link',
  'video',
] as const
const ITEM_KEYS = [
  'articleRevisionId',
  'completionPolicyVersion',
  'completionThresholdBps',
  'examId',
  'externalLinkRevisionId',
  'itemId',
  'itemType',
  'mediaId',
  'position',
] as const

export type ElearningCourseVersionItemType = (typeof ITEM_TYPES)[number]
export type ElearningCourseVersionCompletionPolicy =
  | typeof ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION
  | typeof ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION
  | typeof ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION
  | typeof ELEARNING_WATCH_POLICY_VERSION
  | null

const REFERENCE_KEYS = [
  'articleRevisionId',
  'examId',
  'externalLinkRevisionId',
  'mediaId',
] as const
const REFERENCE_KEY_BY_TYPE = {
  article: 'articleRevisionId',
  document: 'mediaId',
  exam: 'examId',
  external_link: 'externalLinkRevisionId',
  video: 'mediaId',
} as const satisfies Record<
  ElearningCourseVersionItemType,
  (typeof REFERENCE_KEYS)[number]
>
const COMPLETION_POLICY_BY_TYPE = {
  article: ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION,
  document: ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
  exam: null,
  external_link: ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION,
  video: ELEARNING_WATCH_POLICY_VERSION,
} as const satisfies Record<
  ElearningCourseVersionItemType,
  ElearningCourseVersionCompletionPolicy
>

export class ElearningCourseVersionItemsPolicyError extends Error {
  constructor(readonly code: 'invalid_input') {
    super(code)
    this.name = 'ElearningCourseVersionItemsPolicyError'
  }
}

export interface ElearningCourseVersionItem {
  readonly articleRevisionId: string | null
  readonly completionPolicyVersion: ElearningCourseVersionCompletionPolicy
  readonly completionThresholdBps: number | null
  readonly examId: string | null
  readonly externalLinkRevisionId: string | null
  readonly itemId: string
  readonly itemType: ElearningCourseVersionItemType
  readonly mediaId: string | null
  readonly position: number
}

function fail(): never {
  throw new ElearningCourseVersionItemsPolicyError('invalid_input')
}

function readExactItem(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail()
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail()
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== ITEM_KEYS.length
      || sorted.some((key, index) => key !== ITEM_KEYS[index])
    ) fail()
    return Object.fromEntries(
      ITEM_KEYS.map((key) => [key, (input as Record<string, unknown>)[key]]),
    )
  } catch (error) {
    if (error instanceof ElearningCourseVersionItemsPolicyError) throw error
    fail()
  }
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail()
  return value.toLowerCase()
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : requireUuid(value)
}

function requirePosition(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > ELEARNING_COURSE_VERSION_MAX_ITEMS
  ) fail()
  return value
}

function requireThreshold(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > 10_000
  ) fail()
  return value
}

function normalizeItem(input: unknown): ElearningCourseVersionItem {
  const values = readExactItem(input)
  if (!(ITEM_TYPES as readonly unknown[]).includes(values.itemType)) fail()
  const itemType = values.itemType as ElearningCourseVersionItemType
  const articleRevisionId = nullableUuid(values.articleRevisionId)
  const examId = nullableUuid(values.examId)
  const externalLinkRevisionId = nullableUuid(values.externalLinkRevisionId)
  const mediaId = nullableUuid(values.mediaId)
  const references = {
    articleRevisionId,
    examId,
    externalLinkRevisionId,
    mediaId,
  }
  const expectedReferenceKey = REFERENCE_KEY_BY_TYPE[itemType]
  for (const key of REFERENCE_KEYS) {
    if ((key === expectedReferenceKey) !== (references[key] !== null)) fail()
  }
  const completionPolicyVersion = COMPLETION_POLICY_BY_TYPE[itemType]
  if (values.completionPolicyVersion !== completionPolicyVersion) fail()
  let completionThresholdBps: number | null = null
  if (itemType === 'document') {
    completionThresholdBps = requireThreshold(values.completionThresholdBps)
  } else if (itemType === 'video') {
    if (values.completionThresholdBps !== ELEARNING_WATCH_THRESHOLD_BPS) fail()
    completionThresholdBps = ELEARNING_WATCH_THRESHOLD_BPS
  } else if (values.completionThresholdBps !== null) fail()

  return Object.freeze({
    articleRevisionId,
    completionPolicyVersion,
    completionThresholdBps,
    examId,
    externalLinkRevisionId,
    itemId: requireUuid(values.itemId),
    itemType,
    mediaId,
    position: requirePosition(values.position),
  })
}

export function normalizeElearningCourseVersionItems(
  input: unknown,
): readonly ElearningCourseVersionItem[] {
  try {
    if (
      !Array.isArray(input)
      || input.length < 1
      || input.length > ELEARNING_COURSE_VERSION_MAX_ITEMS
      || Reflect.ownKeys(input).length !== input.length + 1
    ) fail()
    const items = input.map(normalizeItem)
    const itemIds = new Set<string>()
    const positions = new Set<number>()
    for (const item of items) {
      if (itemIds.has(item.itemId) || positions.has(item.position)) fail()
      itemIds.add(item.itemId)
      positions.add(item.position)
    }
    return Object.freeze([...items].sort((left, right) => left.position - right.position))
  } catch (error) {
    if (error instanceof ElearningCourseVersionItemsPolicyError) throw error
    fail()
  }
}
