/**
 * Pure L6 watch-challenge scheduling policy. Challenge entropy must come from
 * a server-side cryptographically secure source; this module only maps it into
 * deterministic, stratified trusted-watch checkpoints. Persistence, transport,
 * challenge IDs, and feature flags stay outside this module.
 */

const MAX_CHALLENGES = 10
const MAX_RESPONSE_WINDOW_MS = 120_000
const MAX_TEXT_LENGTH = 512
const MAX_ENTROPY = 0xffff_ffff

const SCHEDULE_INPUT_KEYS = [
  'challengeCount',
  'entropy',
  'minimumVideoDurationMs',
  'policyRevision',
  'responseWindowMs',
  'videoDurationMs',
] as const

const DUE_INPUT_KEYS = ['issuedCount', 'trustedMs'] as const

export type ElearningWatchChallengeScheduleMode =
  | 'disabled'
  | 'scheduled'
  | 'short_video_exempt'

export type ElearningWatchChallengeScheduleErrorCode =
  | 'insufficient_duration'
  | 'invalid_entropy'
  | 'invalid_input'
  | 'invalid_policy'

export class ElearningWatchChallengeScheduleError extends Error {
  constructor(readonly code: ElearningWatchChallengeScheduleErrorCode) {
    super(code)
    this.name = 'ElearningWatchChallengeScheduleError'
  }
}

export interface ElearningWatchChallengeCheckpoint {
  readonly ordinal: number
  readonly targetTrustedMs: number
}

declare const normalizedSchedule: unique symbol

export interface ElearningWatchChallengeSchedule {
  readonly checkpoints: readonly ElearningWatchChallengeCheckpoint[]
  readonly mode: ElearningWatchChallengeScheduleMode
  readonly policyRevision: string
  readonly responseWindowMs: number
  readonly videoDurationMs: number
  readonly [normalizedSchedule]: true
}

export interface ElearningWatchChallengeDue {
  readonly ordinal: number
  readonly policyRevision: string
  readonly responseWindowMs: number
  readonly targetTrustedMs: number
}

function fail(code: ElearningWatchChallengeScheduleErrorCode): never {
  throw new ElearningWatchChallengeScheduleError(code)
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
    if (error instanceof ElearningWatchChallengeScheduleError) throw error
    fail('invalid_input')
  }
}

function requireSafeInteger(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail('invalid_input')
  return value as number
}

function requirePolicyText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_policy')
  const text = value.trim()
  if (text === '' || text.length > MAX_TEXT_LENGTH || text.includes('\0')) {
    fail('invalid_policy')
  }
  for (let index = 0; index < text.length; index += 1) {
    const point = text.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        fail('invalid_policy')
      }
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      fail('invalid_policy')
    }
  }
  return text
}

function requireEntropy(input: unknown, expectedLength: number): readonly number[] {
  if (!Array.isArray(input) || input.length !== expectedLength) fail('invalid_entropy')
  const entropy = input.map((value) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ENTROPY) {
      fail('invalid_entropy')
    }
    return value
  })
  return Object.freeze(entropy)
}

function stratifiedCheckpoint(
  videoDurationMs: number,
  challengeCount: number,
  index: number,
  entropy: number,
): ElearningWatchChallengeCheckpoint {
  const availablePositions = videoDurationMs - 1
  const available = BigInt(availablePositions)
  const count = BigInt(challengeCount)
  const start = Number((available * BigInt(index)) / count)
  const end = Number((available * BigInt(index + 1)) / count)
  const width = end - start
  return Object.freeze({
    ordinal: index + 1,
    targetTrustedMs: 1 + start + (entropy % width),
  })
}

/**
 * Build one immutable, server-only schedule for a video learning session.
 * `minimumVideoDurationMs` is explicit because the ratified contract requires
 * short-video exemption without inventing a global product threshold.
 */
export function createElearningWatchChallengeSchedule(
  input: unknown,
): ElearningWatchChallengeSchedule {
  const values = readExactObject(input, SCHEDULE_INPUT_KEYS)
  const challengeCount = requireSafeInteger(values.challengeCount, 0)
  const minimumVideoDurationMs = requireSafeInteger(values.minimumVideoDurationMs, 1)
  const responseWindowMs = requireSafeInteger(values.responseWindowMs, 1)
  const videoDurationMs = requireSafeInteger(values.videoDurationMs, 1)
  const policyRevision = requirePolicyText(values.policyRevision)

  if (challengeCount > MAX_CHALLENGES || responseWindowMs > MAX_RESPONSE_WINDOW_MS) {
    fail('invalid_policy')
  }

  const mode: ElearningWatchChallengeScheduleMode = challengeCount === 0
    ? 'disabled'
    : videoDurationMs < minimumVideoDurationMs
      ? 'short_video_exempt'
      : 'scheduled'
  const expectedEntropy = mode === 'scheduled' ? challengeCount : 0
  const entropy = requireEntropy(values.entropy, expectedEntropy)

  if (mode === 'scheduled' && videoDurationMs - 1 < challengeCount) {
    fail('insufficient_duration')
  }

  const checkpoints = mode === 'scheduled'
    ? entropy.map((value, index) => stratifiedCheckpoint(
      videoDurationMs,
      challengeCount,
      index,
      value,
    ))
    : []

  return Object.freeze({
    checkpoints: Object.freeze(checkpoints),
    mode,
    policyRevision,
    responseWindowMs,
    videoDurationMs,
  }) as ElearningWatchChallengeSchedule
}

/**
 * Resolve the next due checkpoint. The caller issues only when no challenge is
 * already active, creates an unpredictable challenge ID, and persists the exact
 * schedule snapshot with its issued count. A persistence adapter must reconstruct
 * this branded input through this module's creator or an equivalent closed-shape
 * decoder; arbitrary stored JSON is not trusted state.
 */
export function resolveElearningWatchChallengeDue(
  schedule: ElearningWatchChallengeSchedule,
  input: unknown,
): ElearningWatchChallengeDue | null {
  const values = readExactObject(input, DUE_INPUT_KEYS)
  const issuedCount = requireSafeInteger(values.issuedCount, 0)
  const trustedMs = requireSafeInteger(values.trustedMs, 0)
  if (issuedCount > schedule.checkpoints.length) fail('invalid_input')
  const checkpoint = schedule.checkpoints[issuedCount]
  if (checkpoint === undefined || trustedMs < checkpoint.targetTrustedMs) return null
  return Object.freeze({
    ordinal: checkpoint.ordinal,
    policyRevision: schedule.policyRevision,
    responseWindowMs: schedule.responseWindowMs,
    targetTrustedMs: checkpoint.targetTrustedMs,
  })
}
