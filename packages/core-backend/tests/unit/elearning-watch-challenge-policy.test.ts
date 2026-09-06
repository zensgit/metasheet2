import { describe, expect, it } from 'vitest'
import {
  ElearningWatchChallengePolicyError,
  advanceElearningWatchChallenge,
  createElearningWatchChallengeState,
  type ElearningWatchChallengeState,
} from '../../src/services/elearning-watch-challenge-policy'

function issue(state: ElearningWatchChallengeState, overrides: Record<string, unknown> = {}) {
  return advanceElearningWatchChallenge(state, {
    challengeId: 'challenge-1',
    deadlineAtMs: 20_000,
    issuedAtMs: state.observedAtMs,
    policyRevision: 'policy-1',
    type: 'issue',
    ...overrides,
  }).state
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected watch challenge policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningWatchChallengePolicyError)
    const policyError = error as ElearningWatchChallengePolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain('secret')
  }
}

describe('elearning watch challenge policy', () => {
  it('credits normal server-eligible heartbeat time', () => {
    const initial = createElearningWatchChallengeState({ observedAtMs: 1_000, trustedMs: 500 })
    const result = advanceElearningWatchChallenge(initial, {
      atMs: 4_000,
      eligibleMs: 2_000,
      type: 'heartbeat',
    })

    expect(result).toEqual({
      creditedMs: 2_000,
      discardedMs: 0,
      state: {
        activeChallenge: null,
        completedAtMs: null,
        observedAtMs: 4_000,
        status: 'watching',
        trustedMs: 2_500,
      },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.state)).toBe(true)
  })

  it('holds eligible time provisionally and commits it after an on-time ack', () => {
    let state = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 1_000 })
    state = issue(state)
    const pending = advanceElearningWatchChallenge(state, {
      atMs: 14_000,
      eligibleMs: 3_000,
      type: 'heartbeat',
    })
    expect(pending.creditedMs).toBe(0)
    expect(pending.state.trustedMs).toBe(1_000)
    expect(pending.state.activeChallenge?.provisionalMs).toBe(3_000)

    const acknowledged = advanceElearningWatchChallenge(pending.state, {
      atMs: 16_000,
      challengeId: 'challenge-1',
      eligibleMs: 1_500,
      type: 'ack',
    })
    expect(acknowledged).toEqual({
      creditedMs: 4_500,
      discardedMs: 0,
      state: {
        activeChallenge: null,
        completedAtMs: null,
        observedAtMs: 16_000,
        status: 'watching',
        trustedMs: 5_500,
      },
    })
  })

  it('accepts an ack exactly at the deadline', () => {
    let state = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 0 })
    state = issue(state)
    const result = advanceElearningWatchChallenge(state, {
      atMs: 20_000,
      challengeId: 'challenge-1',
      eligibleMs: 10_000,
      type: 'ack',
    })
    expect(result.creditedMs).toBe(10_000)
    expect(result.discardedMs).toBe(0)
    expect(result.state.status).toBe('watching')
  })

  it('discards the whole challenge interval on a late ack and resumes only at ack time', () => {
    let state = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 1_000 })
    state = issue(state)
    state = advanceElearningWatchChallenge(state, {
      atMs: 15_000,
      eligibleMs: 4_000,
      type: 'heartbeat',
    }).state

    const late = advanceElearningWatchChallenge(state, {
      atMs: 20_001,
      challengeId: 'challenge-1',
      eligibleMs: 4_000,
      type: 'ack',
    })
    expect(late.creditedMs).toBe(0)
    expect(late.discardedMs).toBe(8_000)
    expect(late.state).toEqual({
      activeChallenge: null,
      completedAtMs: null,
      observedAtMs: 20_001,
      status: 'watching',
      trustedMs: 1_000,
    })

    const resumed = advanceElearningWatchChallenge(late.state, {
      atMs: 22_001,
      eligibleMs: 2_000,
      type: 'heartbeat',
    })
    expect(resumed.creditedMs).toBe(2_000)
    expect(resumed.state.trustedMs).toBe(3_000)
  })

  it('materializes timeout without moving the watch cursor and later resumes on matching ack', () => {
    let state = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 900 })
    state = issue(state)
    state = advanceElearningWatchChallenge(state, {
      atMs: 15_000,
      eligibleMs: 4_000,
      type: 'heartbeat',
    }).state

    const timedOut = advanceElearningWatchChallenge(state, { atMs: 20_001, type: 'timeout' })
    expect(timedOut.discardedMs).toBe(4_000)
    expect(timedOut.state.observedAtMs).toBe(15_000)
    expect(timedOut.state.status).toBe('paused')
    expect(timedOut.state.activeChallenge?.provisionalMs).toBe(0)

    const pausedHeartbeat = advanceElearningWatchChallenge(timedOut.state, {
      atMs: 23_000,
      eligibleMs: 5_000,
      type: 'heartbeat',
    })
    expect(pausedHeartbeat.creditedMs).toBe(0)
    expect(pausedHeartbeat.discardedMs).toBe(5_000)
    expect(pausedHeartbeat.state.trustedMs).toBe(900)

    const acknowledged = advanceElearningWatchChallenge(pausedHeartbeat.state, {
      atMs: 25_000,
      challengeId: 'challenge-1',
      eligibleMs: 2_000,
      type: 'ack',
    })
    expect(acknowledged.creditedMs).toBe(0)
    expect(acknowledged.discardedMs).toBe(2_000)
    expect(acknowledged.state.status).toBe('watching')
    expect(acknowledged.state.observedAtMs).toBe(25_000)
  })

  it('turns a post-deadline heartbeat into a retroactive pause', () => {
    let state = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 600 })
    state = issue(state)
    const result = advanceElearningWatchChallenge(state, {
      atMs: 30_000,
      eligibleMs: 15_000,
      type: 'heartbeat',
    })
    expect(result.creditedMs).toBe(0)
    expect(result.discardedMs).toBe(15_000)
    expect(result.state.status).toBe('paused')
    expect(result.state.trustedMs).toBe(600)
    expect(result.state.activeChallenge?.challengeId).toBe('challenge-1')
  })

  it('rejects wrong and stale acknowledgements without awarding time', () => {
    let state = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 0 })
    state = issue(state)
    expectCode(() => advanceElearningWatchChallenge(state, {
      atMs: 12_000,
      challengeId: 'secret-wrong-id',
      eligibleMs: 1_000,
      type: 'ack',
    }), 'challenge_mismatch')
    expect(state.activeChallenge?.provisionalMs).toBe(0)

    state = advanceElearningWatchChallenge(state, {
      atMs: 12_000,
      challengeId: 'challenge-1',
      eligibleMs: 1_000,
      type: 'ack',
    }).state
    expectCode(() => advanceElearningWatchChallenge(state, {
      atMs: 13_000,
      challengeId: 'challenge-1',
      eligibleMs: 1_000,
      type: 'ack',
    }), 'challenge_stale')
    expect(state.trustedMs).toBe(1_000)
  })

  it('rejects a second challenge and invalid challenge anchors', () => {
    const initial = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 0 })
    const challenged = issue(initial)
    expectCode(() => issue(challenged, { challengeId: 'challenge-2' }), 'challenge_active')
    expectCode(() => issue(initial, { issuedAtMs: 9_999 }), 'invalid_input')
    expectCode(() => issue(initial, { deadlineAtMs: 10_000 }), 'invalid_input')
  })

  it('prevents challenge bypass through completion and freezes completed learning', () => {
    const initial = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 5_000 })
    const challenged = issue(initial)
    expectCode(() => advanceElearningWatchChallenge(challenged, {
      atMs: 11_000,
      type: 'complete',
    }), 'challenge_pending')

    const completed = advanceElearningWatchChallenge(initial, {
      atMs: 11_000,
      type: 'complete',
    }).state
    expect(completed).toEqual({
      activeChallenge: null,
      completedAtMs: 11_000,
      observedAtMs: 11_000,
      status: 'completed',
      trustedMs: 5_000,
    })
    for (const event of [
      { atMs: 12_000, eligibleMs: 1_000, type: 'heartbeat' },
      {
        challengeId: 'challenge-2',
        deadlineAtMs: 14_000,
        issuedAtMs: 11_000,
        policyRevision: 'policy-2',
        type: 'issue',
      },
    ]) {
      expectCode(() => advanceElearningWatchChallenge(completed, event), 'already_completed')
    }
    expect(completed.trustedMs).toBe(5_000)
  })

  it('pins the policy revision on the active challenge', () => {
    const initial = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 0 })
    const challenged = issue(initial, { policyRevision: 'policy-v1' })
    expect(challenged.activeChallenge?.policyRevision).toBe('policy-v1')
    expect(Object.isFrozen(challenged.activeChallenge)).toBe(true)

    const acknowledged = advanceElearningWatchChallenge(challenged, {
      atMs: 11_000,
      challengeId: 'challenge-1',
      eligibleMs: 1_000,
      type: 'ack',
    }).state
    const next = issue(acknowledged, {
      challengeId: 'challenge-2',
      deadlineAtMs: 25_000,
      policyRevision: 'policy-v2',
    })
    expect(next.activeChallenge?.policyRevision).toBe('policy-v2')
  })

  it('rejects out-of-order or over-crediting events', () => {
    const state = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 0 })
    expectCode(() => advanceElearningWatchChallenge(state, {
      atMs: 9_999,
      eligibleMs: 0,
      type: 'heartbeat',
    }), 'event_out_of_order')
    expectCode(() => advanceElearningWatchChallenge(state, {
      atMs: 11_000,
      eligibleMs: 1_001,
      type: 'heartbeat',
    }), 'invalid_input')
  })

  it('rejects unsafe arithmetic before trusted time can wrap', () => {
    const state = createElearningWatchChallengeState({
      observedAtMs: 0,
      trustedMs: Number.MAX_SAFE_INTEGER,
    })
    expectCode(() => advanceElearningWatchChallenge(state, {
      atMs: 1,
      eligibleMs: 1,
      type: 'heartbeat',
    }), 'arithmetic_overflow')
  })

  it('rejects malformed and extra event fields with values-free errors', () => {
    const state = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 0 })
    for (const event of [
      null,
      [],
      {},
      { atMs: 11_000, eligibleMs: 1_000, extra: 'secret', type: 'heartbeat' },
      { atMs: 11_000, eligibleMs: -1, type: 'heartbeat' },
      { atMs: 11_000, eligibleMs: 0.5, type: 'heartbeat' },
      { type: 'unknown' },
    ]) {
      expectCode(() => advanceElearningWatchChallenge(state, event), 'invalid_input')
    }
    expectCode(() => issue(state, { challengeId: 'secret\0id' }), 'invalid_input')
    expectCode(() => issue(state, { policyRevision: '\ud800' }), 'invalid_input')
  })

  it('fails closed on hostile event objects', () => {
    const state = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 0 })
    const throwingType = Object.defineProperty({}, 'type', {
      enumerable: true,
      get() { throw new Error('secret-type') },
    })
    expectCode(() => advanceElearningWatchChallenge(state, throwingType), 'invalid_input')
    expectCode(() => advanceElearningWatchChallenge(state, new Proxy({
      atMs: 11_000,
      eligibleMs: 1_000,
      type: 'heartbeat',
    }, {
      ownKeys() { throw new Error('secret-own-keys') },
    })), 'invalid_input')
  })

  it('reads a stateful event type getter exactly once', () => {
    const state = createElearningWatchChallengeState({ observedAtMs: 10_000, trustedMs: 0 })
    let reads = 0
    const event = {
      atMs: 11_000,
      eligibleMs: 1_000,
      get type() {
        reads += 1
        return reads === 1 ? 'heartbeat' : 'issue'
      },
    }
    const result = advanceElearningWatchChallenge(state, event)
    expect(reads).toBe(1)
    expect(result.creditedMs).toBe(1_000)
    expect(result.state.status).toBe('watching')
  })
})
