/**
 * Pure L6 offline-training hours trigger. It emits a subject-relative intent;
 * a future append-only hours ledger must add authoritative org/user identity.
 * Attendance, persistence, routes, and feature flags stay outside this module.
 */
import { createHash } from 'node:crypto'

import {
  deriveElearningOfflineRewards,
  ElearningOfflineRewardPolicyError,
} from './elearning-offline-reward-policy'

const MAX_KEY_LENGTH = 512
const HOURS_POLICY_KEYS = ['creditedMinutes', 'hoursPolicyRevision'] as const
const TRANSITION_KEYS = [
  'afterAttendanceStates',
  'beforeAttendanceStates',
  'trainingKey',
] as const

export const ELEARNING_OFFLINE_HOURS_DOMAIN =
  'elearning.offline.hours.v1' as const

export type ElearningOfflineHoursPolicyErrorCode =
  | 'invalid_input'
  | 'invalid_policy'
  | 'invalid_transition'

export class ElearningOfflineHoursPolicyError extends Error {
  constructor(readonly code: ElearningOfflineHoursPolicyErrorCode) {
    super(code)
    this.name = 'ElearningOfflineHoursPolicyError'
  }
}

export interface ElearningOfflineHoursPolicy {
  readonly creditedMinutes: number | null
  readonly hoursPolicyRevision: string
}

export interface ElearningOfflineHoursReference {
  readonly attendancePolicyRevision: string
  readonly hoursPolicyRevision: string
  readonly trainingKey: string
}

export interface ElearningOfflineHoursEffect {
  readonly completedAt: string
  readonly creditedMinutes: number
  readonly effectKey: string
  readonly kind: 'learning_hours'
  readonly reference: ElearningOfflineHoursReference
}

export interface ElearningOfflineHoursDecision {
  readonly attendancePolicyRevision: string
  readonly completedAt: string | null
  readonly completedNow: boolean
  readonly hourEffects: readonly ElearningOfflineHoursEffect[]
  readonly hoursPolicyRevision: string
}

interface ElearningOfflineHoursTransition {
  readonly afterAttendanceStates: unknown
  readonly beforeAttendanceStates: unknown
  readonly trainingKey: string
}

function fail(code: ElearningOfflineHoursPolicyErrorCode): never {
  throw new ElearningOfflineHoursPolicyError(code)
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_input')
  }
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail('invalid_input')
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== expectedKeys.length
      || sorted.some((key, index) => key !== expectedKeys[index])
    ) fail('invalid_input')
    const values: Record<string, unknown> = {}
    for (const key of expectedKeys) values[key] = (input as Record<string, unknown>)[key]
    return values
  } catch (error) {
    if (error instanceof ElearningOfflineHoursPolicyError) throw error
    fail('invalid_input')
  }
}

function requireKey(value: unknown, code: 'invalid_input' | 'invalid_policy'): string {
  if (typeof value !== 'string') fail(code)
  const text = value.trim()
  if (text === '' || text.length > MAX_KEY_LENGTH || text.includes('\0')) fail(code)
  for (let index = 0; index < text.length; index += 1) {
    const point = text.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail(code)
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      fail(code)
    }
  }
  return text
}

export function createElearningOfflineHoursPolicy(
  input: unknown,
): ElearningOfflineHoursPolicy {
  let values: Record<string, unknown>
  try {
    values = readExactObject(input, HOURS_POLICY_KEYS)
  } catch {
    fail('invalid_policy')
  }
  const creditedMinutes = values.creditedMinutes
  if (
    creditedMinutes !== null
    && (
      typeof creditedMinutes !== 'number'
      || !Number.isSafeInteger(creditedMinutes)
      || creditedMinutes <= 0
    )
  ) fail('invalid_policy')
  return Object.freeze({
    creditedMinutes,
    hoursPolicyRevision: requireKey(values.hoursPolicyRevision, 'invalid_policy'),
  }) as ElearningOfflineHoursPolicy
}

function readTransition(input: unknown): ElearningOfflineHoursTransition {
  const values = readExactObject(input, TRANSITION_KEYS)
  return Object.freeze({
    afterAttendanceStates: values.afterAttendanceStates,
    beforeAttendanceStates: values.beforeAttendanceStates,
    trainingKey: requireKey(values.trainingKey, 'invalid_input'),
  })
}

function wrapRewardError(error: unknown): never {
  if (error instanceof ElearningOfflineRewardPolicyError) {
    fail(error.code)
  }
  fail('invalid_transition')
}

function hoursEffectKey(trainingKey: string): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({
      domain: ELEARNING_OFFLINE_HOURS_DOMAIN,
      trainingKey,
    }), 'utf8')
    .digest('hex')
  return `${ELEARNING_OFFLINE_HOURS_DOMAIN}:${hash}`
}

export function deriveElearningOfflineHours(
  attendancePolicyInput: unknown,
  hoursPolicyInput: unknown,
  transitionInput: unknown,
): ElearningOfflineHoursDecision {
  const hoursPolicy = createElearningOfflineHoursPolicy(hoursPolicyInput)
  const transition = readTransition(transitionInput)
  let attendanceDecision: ReturnType<typeof deriveElearningOfflineRewards>
  try {
    // Reuse the hardened attendance-transition authority without emitting a
    // credit or certificate candidate from this hours-only slice.
    attendanceDecision = deriveElearningOfflineRewards(
      attendancePolicyInput,
      {
        certificateTemplateRevisionId: null,
        creditEnabled: false,
        rewardPolicyRevision: hoursPolicy.hoursPolicyRevision,
      },
      transition,
    )
  } catch (error) {
    wrapRewardError(error)
  }

  const reference = Object.freeze({
    attendancePolicyRevision: attendanceDecision.attendancePolicyRevision,
    hoursPolicyRevision: hoursPolicy.hoursPolicyRevision,
    trainingKey: transition.trainingKey,
  })
  const hourEffects: readonly ElearningOfflineHoursEffect[] = Object.freeze(
    attendanceDecision.completedNow && hoursPolicy.creditedMinutes !== null
      ? [Object.freeze({
          completedAt: attendanceDecision.completedAt as string,
          creditedMinutes: hoursPolicy.creditedMinutes,
          effectKey: hoursEffectKey(transition.trainingKey),
          kind: 'learning_hours' as const,
          reference,
        })]
      : [],
  )

  return Object.freeze({
    attendancePolicyRevision: attendanceDecision.attendancePolicyRevision,
    completedAt: attendanceDecision.completedAt,
    completedNow: attendanceDecision.completedNow,
    hourEffects,
    hoursPolicyRevision: hoursPolicy.hoursPolicyRevision,
  })
}
