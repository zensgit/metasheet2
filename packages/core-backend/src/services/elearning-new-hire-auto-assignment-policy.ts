import { createHash } from 'node:crypto'

import {
  ElearningCreditPolicyError,
  normalizeElearningCreditOccurredAt,
} from './elearning-credit-policy'

/**
 * Pure L6 new-hire auto-assignment decision.
 *
 * `membershipCreatedAt` is the first `user_orgs` membership timestamp. A
 * reactivation does not create a new hire generation because the current
 * membership store preserves that original timestamp. The persistence adapter
 * may retry candidates whose department or position data arrives later, then
 * pass the returned single-user rule and source key to
 * `assignElearningTrainingPlan`.
 */

export const ELEARNING_NEW_HIRE_AUTO_ASSIGNMENT_DOMAIN =
  'elearning.new_hire.auto_assignment.v1' as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TEXT_LENGTH = 512

const INPUT_KEYS = [
  'activatedAt',
  'audienceMatched',
  'enabled',
  'membershipActive',
  'membershipCreatedAt',
  'orgId',
  'planId',
  'programId',
  'userActive',
  'userId',
] as const

export type ElearningNewHireAutoAssignmentOutcome =
  | 'audience_not_matched'
  | 'disabled'
  | 'inactive_member'
  | 'preexisting_member'
  | 'ready'

export class ElearningNewHireAutoAssignmentPolicyError extends Error {
  constructor(readonly code: 'invalid_input') {
    super(code)
    this.name = 'ElearningNewHireAutoAssignmentPolicyError'
  }
}

export interface ElearningNewHireAutoAssignmentRule {
  readonly includeChildren: false
  readonly subjectRef: string
  readonly subjectType: 'user'
}

export interface ElearningNewHireAutoAssignmentPlan {
  readonly activatedAt: string
  readonly membershipCreatedAt: string
  readonly outcome: ElearningNewHireAutoAssignmentOutcome
  readonly planId: string
  readonly programId: string
  readonly rules: readonly ElearningNewHireAutoAssignmentRule[]
  readonly sourceKey: string | null
}

function fail(): never {
  throw new ElearningNewHireAutoAssignmentPolicyError('invalid_input')
}

function readExactObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail()
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail()
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== INPUT_KEYS.length
      || sorted.some((key, index) => key !== INPUT_KEYS[index])
    ) fail()
    return Object.fromEntries(
      INPUT_KEYS.map((key) => [key, (input as Record<string, unknown>)[key]]),
    )
  } catch (error) {
    if (error instanceof ElearningNewHireAutoAssignmentPolicyError) throw error
    fail()
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

function requireText(value: unknown): string {
  if (typeof value !== 'string') fail()
  const text = value.trim()
  if (
    text === ''
    || text.length > MAX_TEXT_LENGTH
    || text.includes('\0')
    || !isWellFormedUnicode(text)
  ) fail()
  return text
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail()
  return value.toLowerCase()
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail()
  return value
}

function normalizeInstant(value: unknown): string {
  try {
    return normalizeElearningCreditOccurredAt(value)
  } catch (error) {
    if (error instanceof ElearningCreditPolicyError) fail()
    fail()
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sourceKey(input: {
  membershipCreatedAt: string
  orgId: string
  programId: string
  userId: string
}): string {
  const digest = sha256(JSON.stringify({
    domain: ELEARNING_NEW_HIRE_AUTO_ASSIGNMENT_DOMAIN,
    membershipCreatedAt: input.membershipCreatedAt,
    orgId: input.orgId,
    programId: input.programId,
    userId: input.userId,
    version: 1,
  }))
  return `elearning-new-hire-v1:${digest}`
}

function decision(
  base: Omit<ElearningNewHireAutoAssignmentPlan, 'outcome' | 'rules' | 'sourceKey'>,
  outcome: Exclude<ElearningNewHireAutoAssignmentOutcome, 'ready'>,
): ElearningNewHireAutoAssignmentPlan {
  return Object.freeze({
    ...base,
    outcome,
    rules: Object.freeze([]),
    sourceKey: null,
  })
}

export function planElearningNewHireAutoAssignment(
  input: unknown,
): ElearningNewHireAutoAssignmentPlan {
  const values = readExactObject(input)
  const enabled = requireBoolean(values.enabled)
  const membershipActive = requireBoolean(values.membershipActive)
  const userActive = requireBoolean(values.userActive)
  const audienceMatched = requireBoolean(values.audienceMatched)
  const orgId = requireText(values.orgId)
  const userId = requireText(values.userId)
  const programId = requireUuid(values.programId)
  const planId = requireUuid(values.planId)
  const activatedAt = normalizeInstant(values.activatedAt)
  const membershipCreatedAt = normalizeInstant(values.membershipCreatedAt)
  const base = { activatedAt, membershipCreatedAt, planId, programId }

  if (!enabled) return decision(base, 'disabled')
  if (!membershipActive || !userActive) return decision(base, 'inactive_member')
  if (membershipCreatedAt < activatedAt) return decision(base, 'preexisting_member')
  if (!audienceMatched) return decision(base, 'audience_not_matched')

  const rules = Object.freeze([Object.freeze({
    includeChildren: false as const,
    subjectRef: userId,
    subjectType: 'user' as const,
  })])
  return Object.freeze({
    ...base,
    outcome: 'ready' as const,
    rules,
    sourceKey: sourceKey({ membershipCreatedAt, orgId, programId, userId }),
  })
}
