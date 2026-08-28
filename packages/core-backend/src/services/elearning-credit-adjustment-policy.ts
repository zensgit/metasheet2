/**
 * Pure L4 manual credit-adjustment command policy. Persistence stays out of
 * this module; the ledger keeps rejecting manual_adjust until a later slice
 * wires these commands in.
 */
import {
  ELEARNING_CREDIT_EFFECT_HASH_VERSION,
  ElearningCreditPolicyError,
  hashElearningCreditEffect,
  normalizeElearningCreditOccurredAt,
  type ElearningCreditPolicyErrorCode,
} from './elearning-credit-policy'

const ADJUSTMENT_KEYS = [
  'actorId',
  'effectKey',
  'occurredAt',
  'orgId',
  'points',
  'reason',
  'userId',
] as const

const ADJUSTMENT_TEXT_MAX = 512

export interface ElearningCreditManualAdjustmentCommand {
  readonly actorId: string
  readonly behavior: 'manual_adjust'
  readonly effectKey: string
  readonly occurredAt: string
  readonly orgId: string
  readonly points: number
  readonly reason: string
  readonly requestHash: string
  readonly requestHashVersion: typeof ELEARNING_CREDIT_EFFECT_HASH_VERSION
  readonly userId: string
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

function requireText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > ADJUSTMENT_TEXT_MAX) fail('invalid_input')
  assertSupportedText(text)
  return text
}

function requireAdjustmentPoints(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value === 0) {
    fail('invalid_input')
  }
  return value
}

/** Snapshot each own enumerable string key exactly once; getters stay hostile. */
function readAdjustmentInput(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_input')
  }
  let enumerableKeys: PropertyKey[]
  try {
    enumerableKeys = Reflect.ownKeys(input).filter((key) => (
      Object.prototype.propertyIsEnumerable.call(input, key)
    ))
  } catch {
    fail('invalid_input')
  }
  if (enumerableKeys.some((key) => typeof key !== 'string')) fail('invalid_input')
  const keys = (enumerableKeys as string[]).sort()
  if (
    keys.length !== ADJUSTMENT_KEYS.length
    || keys.some((key, index) => key !== ADJUSTMENT_KEYS[index])
  ) fail('invalid_input')
  const values: Record<string, unknown> = {}
  try {
    for (const key of ADJUSTMENT_KEYS) {
      values[key] = (input as Record<string, unknown>)[key]
    }
  } catch {
    fail('invalid_input')
  }
  return values
}

export function normalizeElearningCreditManualAdjustment(
  input: unknown,
): ElearningCreditManualAdjustmentCommand {
  const values = readAdjustmentInput(input)
  const actorId = requireText(values.actorId)
  const effectKey = requireText(values.effectKey)
  const occurredAt = normalizeElearningCreditOccurredAt(values.occurredAt)
  const orgId = requireText(values.orgId)
  const points = requireAdjustmentPoints(values.points)
  const reason = requireText(values.reason)
  const userId = requireText(values.userId)
  const requestHash = hashElearningCreditEffect({
    behavior: 'manual_adjust',
    effectKey,
    occurredAt,
    orgId,
    reference: { actorId, points, reason },
    userId,
  })
  return Object.freeze({
    actorId,
    behavior: 'manual_adjust' as const,
    effectKey,
    occurredAt,
    orgId,
    points,
    reason,
    requestHash,
    requestHashVersion: ELEARNING_CREDIT_EFFECT_HASH_VERSION,
    userId,
  })
}
