/**
 * Pure L6 watch-challenge policy. It consumes watch-time deltas that the
 * existing server-side progress engine has already clamped and validated.
 * Persistence, challenge scheduling, transport, routes, and feature flags are
 * deliberately outside this module.
 */

const TEXT_MAX = 512

const EVENT_KEYS = {
  ack: ['atMs', 'challengeId', 'eligibleMs', 'type'],
  complete: ['atMs', 'type'],
  heartbeat: ['atMs', 'eligibleMs', 'type'],
  issue: ['challengeId', 'deadlineAtMs', 'issuedAtMs', 'policyRevision', 'type'],
  timeout: ['atMs', 'type'],
} as const

export type ElearningWatchChallengeStatus =
  | 'watching'
  | 'challenged'
  | 'paused'
  | 'completed'

export type ElearningWatchChallengePolicyErrorCode =
  | 'already_completed'
  | 'arithmetic_overflow'
  | 'challenge_active'
  | 'challenge_mismatch'
  | 'challenge_pending'
  | 'challenge_stale'
  | 'event_out_of_order'
  | 'invalid_input'

export class ElearningWatchChallengePolicyError extends Error {
  constructor(readonly code: ElearningWatchChallengePolicyErrorCode) {
    super(code)
    this.name = 'ElearningWatchChallengePolicyError'
  }
}

export interface ElearningActiveWatchChallenge {
  readonly challengeId: string
  readonly deadlineAtMs: number
  readonly issuedAtMs: number
  readonly policyRevision: string
  readonly provisionalMs: number
}

export interface ElearningWatchChallengeState {
  readonly activeChallenge: ElearningActiveWatchChallenge | null
  readonly completedAtMs: number | null
  readonly observedAtMs: number
  readonly status: ElearningWatchChallengeStatus
  readonly trustedMs: number
}

export interface ElearningWatchChallengeTransition {
  readonly creditedMs: number
  readonly discardedMs: number
  readonly state: ElearningWatchChallengeState
}

type ParsedEvent =
  | { readonly atMs: number; readonly eligibleMs: number; readonly type: 'heartbeat' }
  | {
    readonly challengeId: string
    readonly deadlineAtMs: number
    readonly issuedAtMs: number
    readonly policyRevision: string
    readonly type: 'issue'
  }
  | {
    readonly atMs: number
    readonly challengeId: string
    readonly eligibleMs: number
    readonly type: 'ack'
  }
  | { readonly atMs: number; readonly type: 'timeout' }
  | { readonly atMs: number; readonly type: 'complete' }

function fail(code: ElearningWatchChallengePolicyErrorCode): never {
  throw new ElearningWatchChallengePolicyError(code)
}

function requireSafeNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('invalid_input')
  return value as number
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > TEXT_MAX || text.includes('\0')) fail('invalid_input')
  for (let index = 0; index < text.length; index += 1) {
    const point = text.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail('invalid_input')
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      fail('invalid_input')
    }
  }
  return text
}

function checkedAdd(left: number, right: number): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) fail('arithmetic_overflow')
  return result
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  knownValues: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_input')
  }
  let keys: PropertyKey[]
  try {
    keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail('invalid_input')
  } catch (error) {
    if (error instanceof ElearningWatchChallengePolicyError) throw error
    fail('invalid_input')
  }
  const sorted = (keys as string[]).sort()
  if (
    sorted.length !== expectedKeys.length
    || sorted.some((key, index) => key !== expectedKeys[index])
  ) fail('invalid_input')

  const values: Record<string, unknown> = {}
  try {
    for (const key of expectedKeys) {
      values[key] = Object.prototype.hasOwnProperty.call(knownValues, key)
        ? knownValues[key]
        : (input as Record<string, unknown>)[key]
    }
  } catch {
    fail('invalid_input')
  }
  return values
}

function parseEvent(input: unknown): ParsedEvent {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_input')
  }
  let type: unknown
  try {
    type = (input as { type?: unknown }).type
  } catch {
    fail('invalid_input')
  }
  if (type === 'heartbeat') {
    const values = readExactObject(input, EVENT_KEYS.heartbeat, { type })
    return {
      atMs: requireSafeNonNegativeInteger(values.atMs),
      eligibleMs: requireSafeNonNegativeInteger(values.eligibleMs),
      type,
    }
  }
  if (type === 'issue') {
    const values = readExactObject(input, EVENT_KEYS.issue, { type })
    return {
      challengeId: requireText(values.challengeId),
      deadlineAtMs: requireSafeNonNegativeInteger(values.deadlineAtMs),
      issuedAtMs: requireSafeNonNegativeInteger(values.issuedAtMs),
      policyRevision: requireText(values.policyRevision),
      type,
    }
  }
  if (type === 'ack') {
    const values = readExactObject(input, EVENT_KEYS.ack, { type })
    return {
      atMs: requireSafeNonNegativeInteger(values.atMs),
      challengeId: requireText(values.challengeId),
      eligibleMs: requireSafeNonNegativeInteger(values.eligibleMs),
      type,
    }
  }
  if (type === 'timeout' || type === 'complete') {
    const values = readExactObject(input, EVENT_KEYS[type], { type })
    return { atMs: requireSafeNonNegativeInteger(values.atMs), type }
  }
  fail('invalid_input')
}

function freezeChallenge(
  challenge: ElearningActiveWatchChallenge | null,
): ElearningActiveWatchChallenge | null {
  return challenge === null ? null : Object.freeze({ ...challenge })
}

function freezeState(state: ElearningWatchChallengeState): ElearningWatchChallengeState {
  return Object.freeze({
    activeChallenge: freezeChallenge(state.activeChallenge),
    completedAtMs: state.completedAtMs,
    observedAtMs: state.observedAtMs,
    status: state.status,
    trustedMs: state.trustedMs,
  })
}

function transition(
  state: ElearningWatchChallengeState,
  creditedMs: number,
  discardedMs: number,
): ElearningWatchChallengeTransition {
  return Object.freeze({ creditedMs, discardedMs, state: freezeState(state) })
}

export function createElearningWatchChallengeState(input: unknown): ElearningWatchChallengeState {
  const values = readExactObject(input, ['observedAtMs', 'trustedMs'])
  return freezeState({
    activeChallenge: null,
    completedAtMs: null,
    observedAtMs: requireSafeNonNegativeInteger(values.observedAtMs),
    status: 'watching',
    trustedMs: requireSafeNonNegativeInteger(values.trustedMs),
  })
}

export function advanceElearningWatchChallenge(
  state: ElearningWatchChallengeState,
  input: unknown,
): ElearningWatchChallengeTransition {
  const event = parseEvent(input)
  if (state.status === 'completed') fail('already_completed')

  if (event.type === 'timeout') {
    if (
      state.status !== 'challenged'
      || state.activeChallenge === null
      || event.atMs <= state.activeChallenge.deadlineAtMs
    ) return transition(state, 0, 0)
    const discardedMs = state.activeChallenge.provisionalMs
    return transition({
      ...state,
      activeChallenge: { ...state.activeChallenge, provisionalMs: 0 },
      status: 'paused',
    }, 0, discardedMs)
  }

  if (event.type === 'issue') {
    if (state.activeChallenge !== null || state.status !== 'watching') fail('challenge_active')
    if (
      event.issuedAtMs !== state.observedAtMs
      || event.deadlineAtMs <= event.issuedAtMs
    ) fail('invalid_input')
    return transition({
      ...state,
      activeChallenge: {
        challengeId: event.challengeId,
        deadlineAtMs: event.deadlineAtMs,
        issuedAtMs: event.issuedAtMs,
        policyRevision: event.policyRevision,
        provisionalMs: 0,
      },
      status: 'challenged',
    }, 0, 0)
  }

  if (event.atMs < state.observedAtMs) fail('event_out_of_order')
  const elapsedMs = event.atMs - state.observedAtMs
  if ('eligibleMs' in event && event.eligibleMs > elapsedMs) fail('invalid_input')

  if (event.type === 'complete') {
    if (state.status !== 'watching' || state.activeChallenge !== null) {
      fail('challenge_pending')
    }
    return transition({
      ...state,
      completedAtMs: event.atMs,
      observedAtMs: event.atMs,
      status: 'completed',
    }, 0, 0)
  }

  if (event.type === 'heartbeat') {
    if (state.status === 'watching') {
      return transition({
        ...state,
        observedAtMs: event.atMs,
        trustedMs: checkedAdd(state.trustedMs, event.eligibleMs),
      }, event.eligibleMs, 0)
    }
    if (state.activeChallenge === null) fail('invalid_input')
    if (
      state.status === 'challenged'
      && event.atMs <= state.activeChallenge.deadlineAtMs
    ) {
      return transition({
        ...state,
        activeChallenge: {
          ...state.activeChallenge,
          provisionalMs: checkedAdd(
            state.activeChallenge.provisionalMs,
            event.eligibleMs,
          ),
        },
        observedAtMs: event.atMs,
      }, 0, 0)
    }
    const discardedMs = checkedAdd(
      state.activeChallenge.provisionalMs,
      event.eligibleMs,
    )
    return transition({
      ...state,
      activeChallenge: { ...state.activeChallenge, provisionalMs: 0 },
      observedAtMs: event.atMs,
      status: 'paused',
    }, 0, discardedMs)
  }

  const challenge = state.activeChallenge
  if (challenge === null) fail('challenge_stale')
  if (event.challengeId !== challenge.challengeId) fail('challenge_mismatch')

  const pendingMs = checkedAdd(challenge.provisionalMs, event.eligibleMs)
  const onTime = state.status === 'challenged' && event.atMs <= challenge.deadlineAtMs
  return transition({
    ...state,
    activeChallenge: null,
    observedAtMs: event.atMs,
    status: 'watching',
    trustedMs: onTime ? checkedAdd(state.trustedMs, pendingMs) : state.trustedMs,
  }, onTime ? pendingMs : 0, onTime ? 0 : pendingMs)
}
