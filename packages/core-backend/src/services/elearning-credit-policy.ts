/**
 * Pure L4-A credit policy primitives. Persistence and event producers stay out
 * of this module so later ledger writes can use one deterministic policy.
 */
import { createHash } from 'node:crypto'

export const ELEARNING_CREDIT_BEHAVIORS = [
  'login',
  'complete_course',
  'complete_plan',
  'pass_exam',
  'submit_survey',
  'complete_map',
  'complete_offline',
  'manual_adjust',
] as const

const ABSOLUTE_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/
const ELEARNING_CREDIT_TEXT_MAX = 512
const ELEARNING_CREDIT_REFERENCE_MAX_BYTES = 16 * 1024
const ELEARNING_CREDIT_REFERENCE_MAX_DEPTH = 16
const ELEARNING_CREDIT_REFERENCE_MAX_ITEMS = 1_000

export const ELEARNING_CREDIT_EFFECT_DOMAIN = 'elearning.credit.effect.v1' as const
export const ELEARNING_CREDIT_EFFECT_HASH_VERSION = 1 as const

export type ElearningCreditBehavior = (typeof ELEARNING_CREDIT_BEHAVIORS)[number]

export type ElearningCreditPolicyErrorCode =
  | 'invalid_behavior'
  | 'invalid_occurred_at'
  | 'invalid_time_zone'
  | 'invalid_input'

export class ElearningCreditPolicyError extends Error {
  constructor(readonly code: ElearningCreditPolicyErrorCode) {
    super(code)
    this.name = 'ElearningCreditPolicyError'
  }
}

export interface ElearningCreditAwardInput {
  behavior: ElearningCreditBehavior
  requestedPoints: number
  awardedToday: number
  dailyCap?: number | null
}

export interface ElearningCreditAward {
  requestedPoints: number
  awardedPoints: number
  remainingDailyCap: number | null
  status: 'awarded' | 'capped' | 'exhausted' | 'adjusted'
}

type JsonValue = boolean | null | number | string | JsonObject | JsonValue[]
type JsonObject = { [key: string]: JsonValue }

export interface ElearningCreditEffectInput {
  orgId: string
  userId: string
  behavior: ElearningCreditBehavior
  effectKey: string
  occurredAt: string | Date
  reference: JsonObject
}

export interface ElearningCreditRuleSnapshotInput {
  id: string
  version: number
  points: number
  dailyCap: number | null
  timeZone: string
}

export interface ElearningCreditRuleSnapshot {
  id: string
  version: number
  points: number
  dailyCap: number | null
  timeZone: string
}

function fail(code: ElearningCreditPolicyErrorCode): never {
  throw new ElearningCreditPolicyError(code)
}

function assertSupportedText(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0) fail('invalid_input')
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        fail('invalid_input')
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('invalid_input')
    }
  }
}

function requireNonEmptyText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > ELEARNING_CREDIT_TEXT_MAX) fail('invalid_input')
  assertSupportedText(text)
  return text
}

function requireSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('invalid_input')
  return value
}

function requirePositiveInteger(value: unknown): number {
  const number = requireSafeInteger(value)
  if (number <= 0) fail('invalid_input')
  return number
}

function normalizeRequestedPoints(behavior: ElearningCreditBehavior, value: unknown): number {
  const points = requireSafeInteger(value)
  if (points === 0 || (behavior !== 'manual_adjust' && points < 0)) fail('invalid_input')
  return points
}

export function normalizeElearningCreditBehavior(value: unknown): ElearningCreditBehavior {
  if (typeof value !== 'string' || !ELEARNING_CREDIT_BEHAVIORS.includes(value as ElearningCreditBehavior)) {
    fail('invalid_behavior')
  }
  return value as ElearningCreditBehavior
}

/** Accept only an absolute timestamp, then return its millisecond UTC spelling. */
export function normalizeElearningCreditOccurredAt(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail('invalid_occurred_at')
    return value.toISOString()
  }
  if (typeof value !== 'string' || !ABSOLUTE_TIMESTAMP_RE.test(value)) fail('invalid_occurred_at')
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) fail('invalid_occurred_at')
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0'] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (
    month < 1 || month > 12
    || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59
  ) fail('invalid_occurred_at')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) fail('invalid_occurred_at')
  return date.toISOString()
}

/** Resolve aliases to Intl's canonical IANA name; never consult the host timezone. */
export function normalizeElearningCreditTimeZone(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || value.length > ELEARNING_CREDIT_TEXT_MAX
  ) fail('invalid_time_zone')
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() })
      .resolvedOptions()
      .timeZone
  } catch {
    fail('invalid_time_zone')
  }
}

export function elearningCreditDay(occurredAt: string | Date, timeZone: string): string {
  const instant = new Date(normalizeElearningCreditOccurredAt(occurredAt))
  const normalizedTimeZone = normalizeElearningCreditTimeZone(timeZone)
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: normalizedTimeZone,
    year: 'numeric',
  }).formatToParts(instant)
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${lookup.year}-${lookup.month}-${lookup.day}`
}

export function computeElearningCreditAward(input: ElearningCreditAwardInput): ElearningCreditAward {
  const behavior = normalizeElearningCreditBehavior(input.behavior)
  const requestedPoints = normalizeRequestedPoints(behavior, input.requestedPoints)
  const awardedToday = requireSafeInteger(input.awardedToday)
  if (awardedToday < 0) fail('invalid_input')
  const dailyCap = input.dailyCap === undefined || input.dailyCap === null
    ? null
    : requirePositiveInteger(input.dailyCap)
  const remainingDailyCap = dailyCap === null ? null : Math.max(0, dailyCap - awardedToday)

  if (requestedPoints < 0) {
    return {
      requestedPoints,
      awardedPoints: requestedPoints,
      remainingDailyCap,
      status: 'adjusted',
    }
  }
  if (remainingDailyCap === null) {
    return {
      requestedPoints,
      awardedPoints: requestedPoints,
      remainingDailyCap,
      status: behavior === 'manual_adjust' ? 'adjusted' : 'awarded',
    }
  }
  if (remainingDailyCap === 0) {
    return { requestedPoints, awardedPoints: 0, remainingDailyCap, status: 'exhausted' }
  }
  const awardedPoints = Math.min(requestedPoints, remainingDailyCap)
  return {
    requestedPoints,
    awardedPoints,
    remainingDailyCap: remainingDailyCap - awardedPoints,
    status: awardedPoints === requestedPoints
      ? (behavior === 'manual_adjust' ? 'adjusted' : 'awarded')
      : 'capped',
  }
}

export function normalizeElearningCreditRuleSnapshot(
  behavior: ElearningCreditBehavior,
  input: ElearningCreditRuleSnapshotInput,
): ElearningCreditRuleSnapshot {
  return {
    dailyCap: input.dailyCap === null ? null : requirePositiveInteger(input.dailyCap),
    id: requireNonEmptyText(input.id),
    points: normalizeRequestedPoints(normalizeElearningCreditBehavior(behavior), input.points),
    timeZone: normalizeElearningCreditTimeZone(input.timeZone),
    version: requirePositiveInteger(input.version),
  }
}

function canonicalizeJson(value: unknown, depth = 0): JsonValue {
  if (depth > ELEARNING_CREDIT_REFERENCE_MAX_DEPTH) fail('invalid_input')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    assertSupportedText(value)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_input')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > ELEARNING_CREDIT_REFERENCE_MAX_ITEMS) fail('invalid_input')
    return Array.from({ length: value.length }, (_, index) => {
      if (!Object.prototype.hasOwnProperty.call(value, index)) fail('invalid_input')
      return canonicalizeJson(value[index], depth + 1)
    })
  }
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const keys = Object.keys(value as Record<string, unknown>)
    if (keys.length > ELEARNING_CREDIT_REFERENCE_MAX_ITEMS) fail('invalid_input')
    return Object.fromEntries(
      keys
        .sort()
        .map((key) => {
          assertSupportedText(key)
          return [key, canonicalizeJson((value as Record<string, unknown>)[key], depth + 1)]
        }),
    ) as JsonObject
  }
  fail('invalid_input')
}

export function canonicalizeElearningCreditEffect(input: ElearningCreditEffectInput): string {
  const behavior = normalizeElearningCreditBehavior(input.behavior)
  const occurredAt = normalizeElearningCreditOccurredAt(input.occurredAt)
  const reference = canonicalizeJson(input.reference)
  if (Array.isArray(reference) || reference === null || typeof reference !== 'object') fail('invalid_input')
  if (Buffer.byteLength(JSON.stringify(reference), 'utf8') > ELEARNING_CREDIT_REFERENCE_MAX_BYTES) {
    fail('invalid_input')
  }

  return JSON.stringify(canonicalizeJson({
    behavior,
    domain: ELEARNING_CREDIT_EFFECT_DOMAIN,
    effectKey: requireNonEmptyText(input.effectKey),
    occurredAt,
    orgId: requireNonEmptyText(input.orgId),
    reference,
    userId: requireNonEmptyText(input.userId),
    version: ELEARNING_CREDIT_EFFECT_HASH_VERSION,
  }))
}

export function hashElearningCreditEffect(input: ElearningCreditEffectInput): string {
  return createHash('sha256')
    .update(canonicalizeElearningCreditEffect(input), 'utf8')
    .digest('hex')
}
