import { createHash } from 'node:crypto'

import {
  ElearningCreditPolicyError,
  normalizeElearningCreditOccurredAt,
  normalizeElearningCreditTimeZone,
} from './elearning-credit-policy'

/**
 * Pure L5 new-hire weekly-report schedule and recipient policy. Persistence,
 * program aggregation, tracking-permission lookup, job claims, notification
 * delivery, routes, UI, and flags stay in later adapters. The adapter must
 * supply current tracking authorization for every configured recipient at
 * each scheduled occurrence.
 */

export const ELEARNING_NEW_HIRE_WEEKLY_REPORT_DOMAIN =
  'elearning.new_hire.weekly_report.v1' as const
export const ELEARNING_NEW_HIRE_WEEKLY_REPORT_DELIVERY_DOMAIN =
  'elearning.new_hire.weekly_report.delivery.v1' as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOCAL_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const MAX_ORG_ID_LENGTH = 256
const MAX_RECIPIENTS = 100

const POLICY_KEYS = [
  'enabled',
  'localTime',
  'orgId',
  'policyRevisionId',
  'programId',
  'recipientUserIds',
  'timeZone',
  'weekday',
] as const
const DISPATCH_KEYS = ['recipientAuthorizations', 'scheduledFor'] as const
const AUTHORIZATION_KEYS = ['trackingAuthorized', 'userId'] as const

export type ElearningNewHireWeeklyReportPolicyErrorCode =
  | 'invalid_authorization'
  | 'invalid_dispatch'
  | 'invalid_policy'

export class ElearningNewHireWeeklyReportPolicyError extends Error {
  constructor(readonly code: ElearningNewHireWeeklyReportPolicyErrorCode) {
    super(code)
    this.name = 'ElearningNewHireWeeklyReportPolicyError'
  }
}

declare const normalizedNewHireWeeklyReportPolicy: unique symbol

export interface ElearningNewHireWeeklyReportPolicy {
  readonly enabled: boolean
  readonly localTime: string
  readonly orgId: string
  readonly policyRevisionId: string
  readonly programId: string
  readonly recipientUserIds: readonly string[]
  readonly timeZone: string
  readonly weekday: number
  readonly [normalizedNewHireWeeklyReportPolicy]: true
}

export type ElearningNewHireWeeklyReportPlanOutcome =
  | 'disabled'
  | 'no_authorized_recipients'
  | 'not_due'
  | 'ready'

export interface ElearningNewHireWeeklyReportDelivery {
  readonly deliveryKey: string
  readonly recipientUserId: string
}

export interface ElearningNewHireWeeklyReportPlan {
  readonly deliveries: readonly ElearningNewHireWeeklyReportDelivery[]
  readonly jobOccurrenceKey: string | null
  readonly outcome: ElearningNewHireWeeklyReportPlanOutcome
  readonly policyRevisionId: string
  readonly programId: string
  readonly reportWeek: string | null
  readonly scheduledFor: string | null
  readonly suppressedRecipientCount: number
}

interface LocalScheduleParts {
  readonly isoWeek: string
  readonly localTime: string
  readonly weekday: number
}

function fail(code: ElearningNewHireWeeklyReportPolicyErrorCode): never {
  throw new ElearningNewHireWeeklyReportPolicyError(code)
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: ElearningNewHireWeeklyReportPolicyErrorCode,
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
    if (error instanceof ElearningNewHireWeeklyReportPolicyError) throw error
    fail(code)
  }
}

function readDenseArray(
  input: unknown,
  code: ElearningNewHireWeeklyReportPolicyErrorCode,
): readonly unknown[] {
  try {
    if (!Array.isArray(input)) fail(code)
    const length = input.length
    if (length > MAX_RECIPIENTS || Reflect.ownKeys(input).length !== length + 1) {
      fail(code)
    }
    const values: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail(code)
      values.push(input[index])
    }
    return values
  } catch (error) {
    if (error instanceof ElearningNewHireWeeklyReportPolicyError) throw error
    fail(code)
  }
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

function requireOrgId(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_policy')
  const text = value.trim()
  if (
    text === ''
    || text.length > MAX_ORG_ID_LENGTH
    || text.includes('\0')
    || !isWellFormedUnicode(text)
  ) fail('invalid_policy')
  return text
}

function requireUuid(
  value: unknown,
  code: ElearningNewHireWeeklyReportPolicyErrorCode,
): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail(code)
  return value.toLowerCase()
}

function normalizeTimeZone(value: unknown): string {
  try {
    return normalizeElearningCreditTimeZone(value)
  } catch (error) {
    if (error instanceof ElearningCreditPolicyError) fail('invalid_policy')
    fail('invalid_policy')
  }
}

function normalizeScheduledFor(value: unknown): string {
  try {
    return normalizeElearningCreditOccurredAt(value)
  } catch (error) {
    if (error instanceof ElearningCreditPolicyError) fail('invalid_dispatch')
    fail('invalid_dispatch')
  }
}

function readRecipientUserIds(input: unknown): readonly string[] {
  const values = readDenseArray(input, 'invalid_policy')
  const recipients: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const userId = requireUuid(value, 'invalid_policy')
    if (seen.has(userId)) fail('invalid_policy')
    seen.add(userId)
    recipients.push(userId)
  }
  return Object.freeze(recipients.sort())
}

export function createElearningNewHireWeeklyReportPolicy(
  input: unknown,
): ElearningNewHireWeeklyReportPolicy {
  const values = readExactObject(input, POLICY_KEYS, 'invalid_policy')
  if (typeof values.enabled !== 'boolean') fail('invalid_policy')
  if (
    typeof values.weekday !== 'number'
    || !Number.isInteger(values.weekday)
    || values.weekday < 1
    || values.weekday > 7
  ) fail('invalid_policy')
  if (typeof values.localTime !== 'string' || !LOCAL_TIME_RE.test(values.localTime)) {
    fail('invalid_policy')
  }
  const recipientUserIds = readRecipientUserIds(values.recipientUserIds)
  if (values.enabled && recipientUserIds.length === 0) fail('invalid_policy')
  return Object.freeze({
    enabled: values.enabled,
    localTime: values.localTime,
    orgId: requireOrgId(values.orgId),
    policyRevisionId: requireUuid(values.policyRevisionId, 'invalid_policy'),
    programId: requireUuid(values.programId, 'invalid_policy'),
    recipientUserIds,
    timeZone: normalizeTimeZone(values.timeZone),
    weekday: values.weekday,
  }) as ElearningNewHireWeeklyReportPolicy
}

function isoWeek(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day))
  const weekday = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - weekday)
  const isoYear = date.getUTCFullYear()
  const yearStart = new Date(Date.UTC(isoYear, 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

function localScheduleParts(
  scheduledFor: string,
  timeZone: string,
): LocalScheduleParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(new Date(scheduledFor))
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const year = Number(lookup.year)
  const month = Number(lookup.month)
  const day = Number(lookup.day)
  const date = new Date(Date.UTC(year, month - 1, day))
  return Object.freeze({
    isoWeek: isoWeek(year, month, day),
    localTime: `${lookup.hour}:${lookup.minute}`,
    weekday: date.getUTCDay() || 7,
  })
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function jobOccurrenceKey(
  policy: ElearningNewHireWeeklyReportPolicy,
  reportWeek: string,
): string {
  return `${ELEARNING_NEW_HIRE_WEEKLY_REPORT_DOMAIN}:${hash({
    domain: ELEARNING_NEW_HIRE_WEEKLY_REPORT_DOMAIN,
    orgId: policy.orgId,
    programId: policy.programId,
    reportWeek,
  })}`
}

function deliveryKey(
  policy: ElearningNewHireWeeklyReportPolicy,
  reportWeek: string,
  recipientUserId: string,
): string {
  return `${ELEARNING_NEW_HIRE_WEEKLY_REPORT_DELIVERY_DOMAIN}:${hash({
    domain: ELEARNING_NEW_HIRE_WEEKLY_REPORT_DELIVERY_DOMAIN,
    orgId: policy.orgId,
    programId: policy.programId,
    recipientUserId,
    reportWeek,
  })}`
}

function emptyPlan(
  policy: ElearningNewHireWeeklyReportPolicy,
  outcome: 'disabled' | 'not_due',
  scheduledFor: string | null,
): ElearningNewHireWeeklyReportPlan {
  return Object.freeze({
    deliveries: Object.freeze([]),
    jobOccurrenceKey: null,
    outcome,
    policyRevisionId: policy.policyRevisionId,
    programId: policy.programId,
    reportWeek: null,
    scheduledFor,
    suppressedRecipientCount: 0,
  })
}

export function planElearningNewHireWeeklyReport(
  policyInput: unknown,
  dispatchInput: unknown,
): ElearningNewHireWeeklyReportPlan {
  const policy = createElearningNewHireWeeklyReportPolicy(policyInput)
  const dispatch = readExactObject(dispatchInput, DISPATCH_KEYS, 'invalid_dispatch')
  if (!policy.enabled) return emptyPlan(policy, 'disabled', null)

  const scheduledFor = normalizeScheduledFor(dispatch.scheduledFor)
  const schedule = localScheduleParts(scheduledFor, policy.timeZone)
  if (schedule.weekday !== policy.weekday || schedule.localTime !== policy.localTime) {
    return emptyPlan(policy, 'not_due', scheduledFor)
  }

  const authorizations = new Map<string, boolean>()
  for (const item of readDenseArray(
    dispatch.recipientAuthorizations,
    'invalid_authorization',
  )) {
    const values = readExactObject(item, AUTHORIZATION_KEYS, 'invalid_authorization')
    const userId = requireUuid(values.userId, 'invalid_authorization')
    if (typeof values.trackingAuthorized !== 'boolean' || authorizations.has(userId)) {
      fail('invalid_authorization')
    }
    authorizations.set(userId, values.trackingAuthorized)
  }
  if (
    authorizations.size !== policy.recipientUserIds.length
    || policy.recipientUserIds.some((userId) => !authorizations.has(userId))
  ) fail('invalid_authorization')

  const deliveries = policy.recipientUserIds
    .filter((userId) => authorizations.get(userId) === true)
    .map((recipientUserId) => Object.freeze({
      deliveryKey: deliveryKey(policy, schedule.isoWeek, recipientUserId),
      recipientUserId,
    }))
  const occurrenceKey = jobOccurrenceKey(policy, schedule.isoWeek)
  return Object.freeze({
    deliveries: Object.freeze(deliveries),
    jobOccurrenceKey: occurrenceKey,
    outcome: deliveries.length === 0 ? 'no_authorized_recipients' : 'ready',
    policyRevisionId: policy.policyRevisionId,
    programId: policy.programId,
    reportWeek: schedule.isoWeek,
    scheduledFor,
    suppressedRecipientCount: policy.recipientUserIds.length - deliveries.length,
  })
}
