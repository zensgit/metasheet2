/**
 * Pure L6 offline-training reward trigger policy. Attendance and reward
 * policies must come from the learning-domain SoR. Credit/certificate ledgers
 * remain the effect authorities and combine these intents with org/user data.
 */
import { createHash } from 'node:crypto'

import {
  createElearningOfflineAttendancePolicy,
  ElearningOfflineAttendancePolicyError,
  evaluateElearningOfflineAttendanceCompletion,
  type ElearningOfflineAttendancePolicy,
} from './elearning-offline-attendance-policy'

const MAX_KEY_LENGTH = 512
const REWARD_POLICY_KEYS = [
  'certificateTemplateRevisionId',
  'creditEnabled',
  'rewardPolicyRevision',
] as const
const TRANSITION_KEYS = [
  'afterAttendanceStates',
  'beforeAttendanceStates',
  'trainingKey',
] as const
const ATTENDANCE_STATE_KEYS = [
  'checkedInAt',
  'checkedOutAt',
  'policyRevision',
  'targetKey',
] as const

export const ELEARNING_OFFLINE_REWARD_DOMAIN =
  'elearning.offline.reward.v1' as const

export type ElearningOfflineRewardPolicyErrorCode =
  | 'invalid_input'
  | 'invalid_policy'
  | 'invalid_transition'

export class ElearningOfflineRewardPolicyError extends Error {
  constructor(readonly code: ElearningOfflineRewardPolicyErrorCode) {
    super(code)
    this.name = 'ElearningOfflineRewardPolicyError'
  }
}

export interface ElearningOfflineRewardPolicy {
  readonly certificateTemplateRevisionId: string | null
  readonly creditEnabled: boolean
  readonly rewardPolicyRevision: string
}

export interface ElearningOfflineRewardReference {
  readonly attendancePolicyRevision: string
  readonly rewardPolicyRevision: string
  readonly trainingKey: string
}

interface ElearningOfflineRewardEffectBase {
  readonly completedAt: string
  readonly effectKey: string
  readonly reference: ElearningOfflineRewardReference
}

export interface ElearningOfflineCreditRewardEffect
  extends ElearningOfflineRewardEffectBase {
  readonly behavior: 'complete_offline'
  readonly kind: 'credit'
}

export interface ElearningOfflineCertificateRewardEffect
  extends ElearningOfflineRewardEffectBase {
  readonly certificateTemplateRevisionId: string
  readonly kind: 'certificate'
}

export interface ElearningOfflineRewardDecision {
  readonly attendancePolicyRevision: string
  readonly certificateEffects: readonly ElearningOfflineCertificateRewardEffect[]
  readonly completedAt: string | null
  readonly completedNow: boolean
  readonly creditEffects: readonly ElearningOfflineCreditRewardEffect[]
  readonly rewardPolicyRevision: string
}

interface AttendanceStateSnapshot {
  readonly checkedInAt: string | null
  readonly checkedOutAt: string | null
  readonly policyRevision: string
  readonly targetKey: string
}

function fail(code: ElearningOfflineRewardPolicyErrorCode): never {
  throw new ElearningOfflineRewardPolicyError(code)
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
    if (error instanceof ElearningOfflineRewardPolicyError) throw error
    fail('invalid_input')
  }
}

function readDenseArray(input: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(input)) fail('invalid_input')
    if (Reflect.ownKeys(input).length !== input.length + 1) fail('invalid_input')
    const values: unknown[] = []
    for (let index = 0; index < input.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail('invalid_input')
      values.push(input[index])
    }
    return Object.freeze(values)
  } catch (error) {
    if (error instanceof ElearningOfflineRewardPolicyError) throw error
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

export function createElearningOfflineRewardPolicy(
  input: unknown,
): ElearningOfflineRewardPolicy {
  let values: Record<string, unknown>
  try {
    values = readExactObject(input, REWARD_POLICY_KEYS)
  } catch {
    fail('invalid_policy')
  }
  if (typeof values.creditEnabled !== 'boolean') fail('invalid_policy')
  const certificateTemplateRevisionId = values.certificateTemplateRevisionId === null
    ? null
    : requireKey(values.certificateTemplateRevisionId, 'invalid_policy')
  return Object.freeze({
    certificateTemplateRevisionId,
    creditEnabled: values.creditEnabled,
    rewardPolicyRevision: requireKey(values.rewardPolicyRevision, 'invalid_policy'),
  })
}

function normalizeAttendancePolicy(input: unknown): ElearningOfflineAttendancePolicy {
  try {
    return createElearningOfflineAttendancePolicy(input)
  } catch {
    fail('invalid_policy')
  }
}

function attendancePolicyInput(policy: ElearningOfflineAttendancePolicy): unknown {
  return {
    attendanceMode: policy.attendanceMode,
    policyRevision: policy.policyRevision,
    targets: policy.targets.map((target) => ({
      checkInWindow: { ...target.checkInWindow },
      checkOutWindow: { ...target.checkOutWindow },
      endsAt: target.endsAt,
      startsAt: target.startsAt,
      targetKey: target.targetKey,
    })),
  }
}

function readAttendanceStates(input: unknown): readonly AttendanceStateSnapshot[] {
  return Object.freeze(readDenseArray(input).map((stateInput) => {
    const values = readExactObject(stateInput, ATTENDANCE_STATE_KEYS)
    return Object.freeze({
      checkedInAt: values.checkedInAt,
      checkedOutAt: values.checkedOutAt,
      policyRevision: values.policyRevision,
      targetKey: values.targetKey,
    }) as AttendanceStateSnapshot
  }))
}

function evaluateCompletion(
  policyInput: unknown,
  attendanceStates: readonly AttendanceStateSnapshot[],
) {
  try {
    return evaluateElearningOfflineAttendanceCompletion(policyInput, {
      attendanceStates,
    })
  } catch (error) {
    if (error instanceof ElearningOfflineAttendancePolicyError) fail('invalid_transition')
    fail('invalid_transition')
  }
}

function assertMonotonicTransition(
  before: readonly AttendanceStateSnapshot[],
  after: readonly AttendanceStateSnapshot[],
): void {
  const afterByTarget = new Map(after.map((state) => [state.targetKey, state]))
  for (const beforeState of before) {
    const afterState = afterByTarget.get(beforeState.targetKey)
    if (!afterState) fail('invalid_transition')
    if (
      (beforeState.checkedInAt !== null
        && afterState.checkedInAt !== beforeState.checkedInAt)
      || (beforeState.checkedOutAt !== null
        && afterState.checkedOutAt !== beforeState.checkedOutAt)
    ) fail('invalid_transition')
  }
}

function completedAt(states: readonly AttendanceStateSnapshot[]): string {
  const checkOuts = states.map((state) => state.checkedOutAt)
  if (checkOuts.some((instant) => instant === null)) fail('invalid_transition')
  // Completion uses event time: delayed persistence of an earlier session must
  // not move the training's completion day away from its latest required exit.
  return checkOuts.reduce((latest, instant) => (
    Date.parse(instant as string) > Date.parse(latest as string) ? instant : latest
  )) as string
}

// Subject-relative by design. The effect authorities add org/user identity to
// their unique keys; trainingKey must be the authoritative learning-domain key.
function rewardEffectKey(
  kind: 'certificate' | 'credit',
  trainingKey: string,
): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({
      domain: ELEARNING_OFFLINE_REWARD_DOMAIN,
      kind,
      trainingKey,
    }), 'utf8')
    .digest('hex')
  return `${ELEARNING_OFFLINE_REWARD_DOMAIN}:${hash}`
}

export function deriveElearningOfflineRewards(
  attendancePolicyInputValue: unknown,
  rewardPolicyInput: unknown,
  transitionInput: unknown,
): ElearningOfflineRewardDecision {
  const attendancePolicy = normalizeAttendancePolicy(attendancePolicyInputValue)
  const rewardPolicy = createElearningOfflineRewardPolicy(rewardPolicyInput)
  const transition = readExactObject(transitionInput, TRANSITION_KEYS)
  const trainingKey = requireKey(transition.trainingKey, 'invalid_input')
  const beforeStates = readAttendanceStates(transition.beforeAttendanceStates)
  const afterStates = readAttendanceStates(transition.afterAttendanceStates)
  const normalizedAttendancePolicyInput = attendancePolicyInput(attendancePolicy)
  const before = evaluateCompletion(normalizedAttendancePolicyInput, beforeStates)
  const after = evaluateCompletion(normalizedAttendancePolicyInput, afterStates)
  assertMonotonicTransition(beforeStates, afterStates)

  const completedNow = before.status !== 'completed' && after.status === 'completed'
  const completionInstant = completedNow ? completedAt(afterStates) : null
  const reference = Object.freeze({
    attendancePolicyRevision: attendancePolicy.policyRevision,
    rewardPolicyRevision: rewardPolicy.rewardPolicyRevision,
    trainingKey,
  })

  const creditEffects: readonly ElearningOfflineCreditRewardEffect[] = Object.freeze(
    completedNow && rewardPolicy.creditEnabled
      ? [Object.freeze({
          behavior: 'complete_offline' as const,
          completedAt: completionInstant as string,
          effectKey: rewardEffectKey('credit', trainingKey),
          kind: 'credit' as const,
          reference,
        })]
      : [],
  )
  const certificateEffects: readonly ElearningOfflineCertificateRewardEffect[] = Object.freeze(
    completedNow && rewardPolicy.certificateTemplateRevisionId !== null
      ? [Object.freeze({
          certificateTemplateRevisionId: rewardPolicy.certificateTemplateRevisionId,
          completedAt: completionInstant as string,
          effectKey: rewardEffectKey('certificate', trainingKey),
          kind: 'certificate' as const,
          reference,
        })]
      : [],
  )

  return Object.freeze({
    attendancePolicyRevision: attendancePolicy.policyRevision,
    certificateEffects,
    completedAt: completionInstant,
    completedNow,
    creditEffects,
    rewardPolicyRevision: rewardPolicy.rewardPolicyRevision,
  })
}
