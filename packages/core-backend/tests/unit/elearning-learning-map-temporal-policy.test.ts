import { describe, expect, it } from 'vitest'
import {
  ElearningLearningMapTemporalPolicyError,
  createElearningLearningMapTemporalPolicy,
  evaluateElearningLearningMapEffectiveState,
  evaluateElearningLearningMapTemporalPolicy,
} from '../../src/services/elearning-learning-map-temporal-policy'

const SENTINEL = 'secret-temporal-value'

function mapPolicy() {
  return {
    policyRevision: 'map-v1',
    stages: [
      { stageKey: 'stage-1', tasks: [{ taskKey: 'task-1' }, { taskKey: 'task-2' }] },
      { stageKey: 'stage-2', tasks: [{ taskKey: 'task-3' }] },
    ],
    unlockMode: 'task_sequential',
  }
}

function temporalPolicy(overrides: Record<string, unknown> = {}) {
  return {
    mapWindow: {
      closesAt: '2026-09-01T00:00:00.000Z',
      opensAt: '2026-08-01T00:00:00.000Z',
    },
    policyRevision: 'map-v1',
    stages: [
      {
        stageKey: 'stage-1',
        window: {
          closesAt: '2026-08-20T00:00:00.000Z',
          opensAt: '2026-08-05T00:00:00.000Z',
        },
      },
      {
        stageKey: 'stage-2',
        window: { closesAt: null, opensAt: '2026-08-10T00:00:00.000Z' },
      },
    ],
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected temporal policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningLearningMapTemporalPolicyError)
    const policyError = error as ElearningLearningMapTemporalPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning learning-map temporal policy', () => {
  it('uses half-open UTC windows at exact boundaries', () => {
    const policy = createElearningLearningMapTemporalPolicy(temporalPolicy())
    expect(evaluateElearningLearningMapTemporalPolicy(policy, {
      now: '2026-08-01T00:00:00.000Z',
    })).toEqual({
      evaluatedAt: '2026-08-01T00:00:00.000Z',
      mapGate: 'open',
      policyRevision: 'map-v1',
      stages: [
        { gate: 'not_open', stageKey: 'stage-1' },
        { gate: 'not_open', stageKey: 'stage-2' },
      ],
    })
    expect(evaluateElearningLearningMapTemporalPolicy(policy, {
      now: '2026-08-20T00:00:00.000Z',
    }).stages).toEqual([
      { gate: 'closed', stageKey: 'stage-1' },
      { gate: 'open', stageKey: 'stage-2' },
    ])
    expect(evaluateElearningLearningMapTemporalPolicy(policy, {
      now: '2026-09-01T00:00:00.000Z',
    })).toMatchObject({
      mapGate: 'closed',
      stages: [
        { gate: 'closed', stageKey: 'stage-1' },
        { gate: 'closed', stageKey: 'stage-2' },
      ],
    })
  })

  it('supports unbounded and single-bound windows without inventing defaults', () => {
    const policy = createElearningLearningMapTemporalPolicy(temporalPolicy({
      mapWindow: { closesAt: null, opensAt: null },
      stages: [
        { stageKey: 'stage-1', window: { closesAt: null, opensAt: null } },
        {
          stageKey: 'stage-2',
          window: { closesAt: '2026-08-10T00:00:00.000Z', opensAt: null },
        },
      ],
    }))
    expect(evaluateElearningLearningMapTemporalPolicy(policy, {
      now: '2026-08-10T00:00:00.000Z',
    }).stages).toEqual([
      { gate: 'open', stageKey: 'stage-1' },
      { gate: 'closed', stageKey: 'stage-2' },
    ])
  })

  it('combines temporal and sequence gates without changing completion evidence', () => {
    const effective = evaluateElearningLearningMapEffectiveState(
      mapPolicy(),
      temporalPolicy(),
      { completedTaskKeys: ['task-1', 'task-2'] },
      { now: '2026-08-21T00:00:00.000Z' },
    )
    expect(effective).toEqual({
      completedTaskCount: 2,
      evaluatedAt: '2026-08-21T00:00:00.000Z',
      mapAccessAllowed: true,
      mapGate: 'open',
      policyRevision: 'map-v1',
      stages: [
        {
          accessAllowed: false,
          stageKey: 'stage-1',
          status: 'completed',
          tasks: [
            {
              accessAllowed: false,
              status: 'completed',
              taskKey: 'task-1',
              temporalGate: 'closed',
            },
            {
              accessAllowed: false,
              status: 'completed',
              taskKey: 'task-2',
              temporalGate: 'closed',
            },
          ],
          temporalGate: 'closed',
        },
        {
          accessAllowed: true,
          stageKey: 'stage-2',
          status: 'available',
          tasks: [{
            accessAllowed: true,
            status: 'available',
            taskKey: 'task-3',
            temporalGate: 'open',
          }],
          temporalGate: 'open',
        },
      ],
      status: 'in_progress',
      totalTaskCount: 3,
      unlockMode: 'task_sequential',
    })
  })

  it('denies every task when the map window is not open', () => {
    const effective = evaluateElearningLearningMapEffectiveState(
      mapPolicy(),
      temporalPolicy(),
      { completedTaskKeys: [] },
      { now: '2026-07-31T23:59:59.999Z' },
    )
    expect(effective.mapAccessAllowed).toBe(false)
    expect(effective.mapGate).toBe('not_open')
    expect(effective.stages.every((stage) => (
      stage.temporalGate === 'not_open'
      && stage.accessAllowed === false
      && stage.tasks.every((task) => task.accessAllowed === false)
    ))).toBe(true)
  })

  it('keeps sequence-locked work inaccessible inside an open time window', () => {
    const policy = temporalPolicy({
      mapWindow: { closesAt: null, opensAt: null },
      stages: [
        { stageKey: 'stage-1', window: { closesAt: null, opensAt: null } },
        { stageKey: 'stage-2', window: { closesAt: null, opensAt: null } },
      ],
    })
    const effective = evaluateElearningLearningMapEffectiveState(
      mapPolicy(),
      policy,
      { completedTaskKeys: [] },
      { now: '2026-08-28T00:00:00.000Z' },
    )
    expect(effective.stages[0].tasks.map((task) => task.accessAllowed)).toEqual([true, false])
    expect(effective.stages[1].accessAllowed).toBe(false)
    expect(effective.stages[1].temporalGate).toBe('open')
  })

  it('rejects temporal policies that drift from the map revision or stage order', () => {
    expectCode(() => evaluateElearningLearningMapEffectiveState(
      mapPolicy(),
      temporalPolicy({ policyRevision: 'map-v2' }),
      { completedTaskKeys: [] },
      { now: '2026-08-10T00:00:00.000Z' },
    ), 'policy_mismatch')
    expectCode(() => evaluateElearningLearningMapEffectiveState(
      mapPolicy(),
      temporalPolicy({
        stages: [...temporalPolicy().stages].reverse(),
      }),
      { completedTaskKeys: [] },
      { now: '2026-08-10T00:00:00.000Z' },
    ), 'policy_mismatch')
  })

  it('rejects malformed windows, non-canonical instants, and extra fields', () => {
    for (const policy of [
      temporalPolicy({ extra: SENTINEL }),
      temporalPolicy({ mapWindow: null }),
      temporalPolicy({
        mapWindow: {
          closesAt: '2026-08-01T00:00:00.000Z',
          opensAt: '2026-08-01T00:00:00.000Z',
        },
      }),
      temporalPolicy({
        mapWindow: { closesAt: null, opensAt: '2026-08-01T00:00:00Z' },
      }),
      temporalPolicy({
        mapWindow: { closesAt: null, opensAt: 'not-a-date' },
      }),
      temporalPolicy({
        mapWindow: { closesAt: null, opensAt: '+010000-01-01T00:00:00.000Z' },
      }),
      temporalPolicy({ policyRevision: '\ud800' }),
      temporalPolicy({
        stages: [{
          stageKey: 'stage-1',
          window: { closesAt: null, opensAt: null, extra: SENTINEL },
        }],
      }),
    ]) {
      expectCode(() => createElearningLearningMapTemporalPolicy(policy), (
        policy && typeof policy === 'object' && 'extra' in policy
        || (policy as { mapWindow?: unknown }).mapWindow === null
        || Array.isArray((policy as { stages?: unknown }).stages)
          && ((policy as { stages: Array<{ window?: unknown }> }).stages[0]?.window as object)
          && 'extra' in ((policy as { stages: Array<{ window: object }> }).stages[0].window)
      ) ? 'invalid_input' : 'invalid_policy')
    }
  })

  it('rejects malformed evaluation clocks and does not read an implicit clock', () => {
    const policy = createElearningLearningMapTemporalPolicy(temporalPolicy())
    for (const input of [
      null,
      {},
      { now: '2026-08-10T00:00:00Z' },
      { now: 'not-a-date' },
      { now: '2026-08-10T00:00:00.000Z', extra: SENTINEL },
    ]) {
      expectCode(() => evaluateElearningLearningMapTemporalPolicy(policy, input), 'invalid_input')
    }
  })

  it('rejects duplicate stages, sparse arrays, and hostile accessors values-free', () => {
    expectCode(() => createElearningLearningMapTemporalPolicy(temporalPolicy({
      stages: [temporalPolicy().stages[0], temporalPolicy().stages[0]],
    })), 'invalid_policy')
    expectCode(() => createElearningLearningMapTemporalPolicy(temporalPolicy({
      stages: new Array(1),
    })), 'invalid_input')

    const throwing = Object.defineProperty(temporalPolicy(), 'policyRevision', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => createElearningLearningMapTemporalPolicy(throwing), 'invalid_input')
    expectCode(() => createElearningLearningMapTemporalPolicy(new Proxy(temporalPolicy(), {
      ownKeys(): never { throw new Error(SENTINEL) },
    })), 'invalid_input')
  })

  it('returns immutable policy and evaluation snapshots', () => {
    const policy = createElearningLearningMapTemporalPolicy(temporalPolicy())
    const state = evaluateElearningLearningMapTemporalPolicy(policy, {
      now: '2026-08-10T00:00:00.000Z',
    })
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.mapWindow)).toBe(true)
    expect(Object.isFrozen(policy.stages)).toBe(true)
    expect(policy.stages.every((stage) => Object.isFrozen(stage.window))).toBe(true)
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.stages)).toBe(true)
  })
})
