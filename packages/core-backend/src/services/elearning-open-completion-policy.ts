import { createHash } from 'node:crypto'

/**
 * Pure L1 completion policy for article opens and external-link launches.
 *
 * Both signals are intentionally weak: an authenticated server-recorded open
 * proves neither that an article was read nor that external content was
 * consumed. The adapter owns authentication and server time; clients never
 * submit completed, event ids, or receipt timestamps as authority.
 */

export const ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION = 'article-open-v1' as const
export const ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION =
  'external-link-launch-v1' as const
export const ELEARNING_OPEN_COMPLETION_EVALUATOR_VERSION =
  'elearning-open-eval-v1' as const
export const ELEARNING_OPEN_COMPLETION_DIGEST_DOMAIN =
  'elearning.open.completion.v1' as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(?:Z|([+-])(\d{2}):(\d{2}))$/
const POLICY_KEYS = [
  'contentRevisionId',
  'courseVersionItemId',
  'itemType',
  'policyVersion',
] as const
const OBSERVATION_KEYS = ['eventId', 'eventKind', 'serverReceivedAt'] as const

export type ElearningOpenCompletionItemType = 'article' | 'external_link'
export type ElearningOpenCompletionPolicyVersion =
  | typeof ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION
  | typeof ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION
export type ElearningOpenCompletionEventKind = 'article_open' | 'external_link_launch'
export type ElearningOpenCompletionAssurance =
  | 'weak_server_recorded_open'
  | 'weak_server_recorded_launch'

const POLICY_BY_ITEM_TYPE = {
  article: ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION,
  external_link: ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION,
} as const satisfies Record<
  ElearningOpenCompletionItemType,
  ElearningOpenCompletionPolicyVersion
>
const EVENT_BY_ITEM_TYPE = {
  article: 'article_open',
  external_link: 'external_link_launch',
} as const satisfies Record<
  ElearningOpenCompletionItemType,
  ElearningOpenCompletionEventKind
>
const ASSURANCE_BY_ITEM_TYPE = {
  article: 'weak_server_recorded_open',
  external_link: 'weak_server_recorded_launch',
} as const satisfies Record<
  ElearningOpenCompletionItemType,
  ElearningOpenCompletionAssurance
>

export class ElearningOpenCompletionPolicyError extends Error {
  constructor(readonly code: 'invalid_input') {
    super(code)
    this.name = 'ElearningOpenCompletionPolicyError'
  }
}

export interface ElearningOpenCompletionPolicy {
  readonly contentRevisionId: string
  readonly courseVersionItemId: string
  readonly itemType: ElearningOpenCompletionItemType
  readonly policyVersion: ElearningOpenCompletionPolicyVersion
}

export interface ElearningOpenCompletionEvaluation {
  readonly assurance: ElearningOpenCompletionAssurance
  readonly completed: boolean
  readonly completedAt: string | null
  readonly contentRevisionId: string
  readonly courseVersionItemId: string
  readonly evaluatorVersion: typeof ELEARNING_OPEN_COMPLETION_EVALUATOR_VERSION
  readonly evidenceDigest: string | null
  readonly eventId: string | null
  readonly eventKind: ElearningOpenCompletionEventKind
  readonly itemType: ElearningOpenCompletionItemType
  readonly policyVersion: ElearningOpenCompletionPolicyVersion
}

function fail(): never {
  throw new ElearningOpenCompletionPolicyError('invalid_input')
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail()
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail()
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== expectedKeys.length
      || sorted.some((key, index) => key !== expectedKeys[index])
    ) fail()
    return Object.fromEntries(
      expectedKeys.map((key) => [key, (input as Record<string, unknown>)[key]]),
    )
  } catch (error) {
    if (error instanceof ElearningOpenCompletionPolicyError) throw error
    fail()
  }
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail()
  return value.toLowerCase()
}

function requireItemType(value: unknown): ElearningOpenCompletionItemType {
  if (value !== 'article' && value !== 'external_link') fail()
  return value
}

function requireServerTime(value: unknown): string {
  if (typeof value !== 'string') fail()
  const match = ISO_INSTANT_RE.exec(value)
  if (!match) fail()
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    offsetSign, offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const offsetHour = offsetSign ? Number(offsetHourText) : 0
  const offsetMinute = offsetSign ? Number(offsetMinuteText) : 0
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) fail()
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) fail()
  return new Date(timestamp).toISOString()
}

export function createElearningOpenCompletionPolicy(
  input: unknown,
): ElearningOpenCompletionPolicy {
  const values = readExactObject(input, POLICY_KEYS)
  const itemType = requireItemType(values.itemType)
  const policyVersion = POLICY_BY_ITEM_TYPE[itemType]
  if (values.policyVersion !== policyVersion) fail()
  return Object.freeze({
    contentRevisionId: requireUuid(values.contentRevisionId),
    courseVersionItemId: requireUuid(values.courseVersionItemId),
    itemType,
    policyVersion,
  })
}

function eventDigest(input: {
  contentRevisionId: string
  courseVersionItemId: string
  eventId: string
  eventKind: ElearningOpenCompletionEventKind
  itemType: ElearningOpenCompletionItemType
  policyVersion: ElearningOpenCompletionPolicyVersion
  serverReceivedAt: string
}): string {
  return createHash('sha256').update(JSON.stringify({
    contentRevisionId: input.contentRevisionId,
    courseVersionItemId: input.courseVersionItemId,
    domain: ELEARNING_OPEN_COMPLETION_DIGEST_DOMAIN,
    evaluatorVersion: ELEARNING_OPEN_COMPLETION_EVALUATOR_VERSION,
    eventId: input.eventId,
    eventKind: input.eventKind,
    itemType: input.itemType,
    policyVersion: input.policyVersion,
    serverReceivedAt: input.serverReceivedAt,
  }), 'utf8').digest('hex')
}

export function evaluateElearningOpenCompletion(
  policy: ElearningOpenCompletionPolicy,
  observation: unknown,
): ElearningOpenCompletionEvaluation {
  const normalizedPolicy = createElearningOpenCompletionPolicy(policy)
  const eventKind = EVENT_BY_ITEM_TYPE[normalizedPolicy.itemType]
  const assurance = ASSURANCE_BY_ITEM_TYPE[normalizedPolicy.itemType]
  if (observation === null) {
    return Object.freeze({
      assurance,
      completed: false,
      completedAt: null,
      contentRevisionId: normalizedPolicy.contentRevisionId,
      courseVersionItemId: normalizedPolicy.courseVersionItemId,
      evaluatorVersion: ELEARNING_OPEN_COMPLETION_EVALUATOR_VERSION,
      evidenceDigest: null,
      eventId: null,
      eventKind,
      itemType: normalizedPolicy.itemType,
      policyVersion: normalizedPolicy.policyVersion,
    })
  }
  const values = readExactObject(observation, OBSERVATION_KEYS)
  if (values.eventKind !== eventKind) fail()
  const eventId = requireUuid(values.eventId)
  const serverReceivedAt = requireServerTime(values.serverReceivedAt)
  return Object.freeze({
    assurance,
    completed: true,
    completedAt: serverReceivedAt,
    contentRevisionId: normalizedPolicy.contentRevisionId,
    courseVersionItemId: normalizedPolicy.courseVersionItemId,
    evaluatorVersion: ELEARNING_OPEN_COMPLETION_EVALUATOR_VERSION,
    evidenceDigest: eventDigest({
      ...normalizedPolicy,
      eventId,
      eventKind,
      serverReceivedAt,
    }),
    eventId,
    eventKind,
    itemType: normalizedPolicy.itemType,
    policyVersion: normalizedPolicy.policyVersion,
  })
}
