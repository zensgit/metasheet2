import { describe, expect, it } from 'vitest'
import {
  ElearningLearningMapPolicyError,
  createElearningLearningMapPolicy,
  evaluateElearningLearningMap,
} from '../../src/services/elearning-learning-map-policy'

const SENTINEL = 'secret-map-value'

function mapPolicy(overrides: Record<string, unknown> = {}) {
  return {
    policyRevision: 'map-v1',
    stages: [
      { stageKey: 'stage-1', tasks: [{ taskKey: 'task-1' }, { taskKey: 'task-2' }] },
      { stageKey: 'stage-2', tasks: [{ taskKey: 'task-3' }, { taskKey: 'task-4' }] },
    ],
    unlockMode: 'task_sequential',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected learning-map policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningLearningMapPolicyError)
    const policyError = error as ElearningLearningMapPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

function statuses(state: ReturnType<typeof evaluateElearningLearningMap>) {
  return state.stages.map((stage) => ({
    stage: stage.status,
    tasks: stage.tasks.map((task) => task.status),
  }))
}

describe('elearning learning-map policy', () => {
  it('enforces task order across stages', () => {
    const policy = createElearningLearningMapPolicy(mapPolicy())
    const initial = evaluateElearningLearningMap(policy, { completedTaskKeys: [] })
    expect(statuses(initial)).toEqual([
      { stage: 'available', tasks: ['available', 'locked'] },
      { stage: 'locked', tasks: ['locked', 'locked'] },
    ])

    const progressed = evaluateElearningLearningMap(policy, {
      completedTaskKeys: ['task-1', 'task-2'],
    })
    expect(statuses(progressed)).toEqual([
      { stage: 'completed', tasks: ['completed', 'completed'] },
      { stage: 'available', tasks: ['available', 'locked'] },
    ])
  })

  it('unlocks every task in the first incomplete stage for stage-sequential maps', () => {
    const policy = createElearningLearningMapPolicy(mapPolicy({
      unlockMode: 'stage_sequential',
    }))
    expect(statuses(evaluateElearningLearningMap(policy, {
      completedTaskKeys: ['task-2'],
    }))).toEqual([
      { stage: 'available', tasks: ['available', 'completed'] },
      { stage: 'locked', tasks: ['locked', 'locked'] },
    ])
  })

  it('opens all incomplete tasks in free mode', () => {
    const policy = createElearningLearningMapPolicy(mapPolicy({ unlockMode: 'free' }))
    expect(statuses(evaluateElearningLearningMap(policy, {
      completedTaskKeys: ['task-3'],
    }))).toEqual([
      { stage: 'available', tasks: ['available', 'available'] },
      { stage: 'available', tasks: ['completed', 'available'] },
    ])
  })

  it('returns an immutable completed state with a pinned policy revision', () => {
    const policy = createElearningLearningMapPolicy(mapPolicy({
      policyRevision: '  map-v7  ',
    }))
    const state = evaluateElearningLearningMap(policy, {
      completedTaskKeys: ['task-1', 'task-2', 'task-3', 'task-4'],
    })
    expect(state).toEqual({
      completedTaskCount: 4,
      policyRevision: 'map-v7',
      stages: [
        {
          stageKey: 'stage-1',
          status: 'completed',
          tasks: [
            { status: 'completed', taskKey: 'task-1' },
            { status: 'completed', taskKey: 'task-2' },
          ],
        },
        {
          stageKey: 'stage-2',
          status: 'completed',
          tasks: [
            { status: 'completed', taskKey: 'task-3' },
            { status: 'completed', taskKey: 'task-4' },
          ],
        },
      ],
      status: 'completed',
      totalTaskCount: 4,
      unlockMode: 'task_sequential',
    })
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.stages)).toBe(true)
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.stages)).toBe(true)
    expect(state.stages.every((stage) => Object.isFrozen(stage.tasks))).toBe(true)
  })

  it('accepts exactly ten stages with twenty tasks each', () => {
    const policy = createElearningLearningMapPolicy(mapPolicy({
      stages: Array.from({ length: 10 }, (_, stageIndex) => ({
        stageKey: `stage-${stageIndex}`,
        tasks: Array.from({ length: 20 }, (_, taskIndex) => ({
          taskKey: `task-${stageIndex}-${taskIndex}`,
        })),
      })),
    }))
    expect(policy.stages).toHaveLength(10)
    expect(policy.stages.every((stage) => stage.tasks.length === 20)).toBe(true)
  })

  it('rejects maps above either size limit and duplicate stable keys', () => {
    expectCode(() => createElearningLearningMapPolicy(mapPolicy({
      stages: Array.from({ length: 11 }, (_, index) => ({
        stageKey: `stage-${index}`,
        tasks: [{ taskKey: `task-${index}` }],
      })),
    })), 'invalid_policy')
    expectCode(() => createElearningLearningMapPolicy(mapPolicy({
      stages: [{
        stageKey: 'stage-1',
        tasks: Array.from({ length: 21 }, (_, index) => ({ taskKey: `task-${index}` })),
      }],
    })), 'invalid_policy')
    expectCode(() => createElearningLearningMapPolicy(mapPolicy({
      stages: [
        { stageKey: 'stage-1', tasks: [{ taskKey: 'task-1' }] },
        { stageKey: 'stage-1', tasks: [{ taskKey: 'task-2' }] },
      ],
    })), 'invalid_policy')
    expectCode(() => createElearningLearningMapPolicy(mapPolicy({
      stages: [
        { stageKey: 'stage-1', tasks: [{ taskKey: 'task-1' }] },
        { stageKey: 'stage-2', tasks: [{ taskKey: 'task-1' }] },
      ],
    })), 'invalid_policy')
  })

  it('fails closed on impossible sequential progress', () => {
    const taskSequential = createElearningLearningMapPolicy(mapPolicy())
    expectCode(() => evaluateElearningLearningMap(taskSequential, {
      completedTaskKeys: ['task-2'],
    }), 'invalid_progress')

    const stageSequential = createElearningLearningMapPolicy(mapPolicy({
      unlockMode: 'stage_sequential',
    }))
    expectCode(() => evaluateElearningLearningMap(stageSequential, {
      completedTaskKeys: ['task-3'],
    }), 'invalid_progress')
  })

  it('rejects unknown, duplicate, malformed, and extra completion evidence', () => {
    const policy = createElearningLearningMapPolicy(mapPolicy())
    for (const progress of [
      null,
      {},
      { completedTaskKeys: ['unknown'] },
      { completedTaskKeys: ['task-1', 'task-1'] },
      { completedTaskKeys: [1] },
      { completedTaskKeys: [], extra: SENTINEL },
    ] as const) {
      expectCode(() => evaluateElearningLearningMap(policy, progress), (
        progress && typeof progress === 'object' && 'completedTaskKeys' in progress
        && Object.keys(progress).length === 1
      ) ? 'invalid_progress' : 'invalid_input')
    }
  })

  it('revalidates persisted policy snapshots before evaluating progress', () => {
    const policy = createElearningLearningMapPolicy(mapPolicy())
    for (const [forgedPolicy, code] of [
      [{ ...policy, extra: SENTINEL }, 'invalid_input'],
      [{ ...policy, unlockMode: 'unknown' }, 'invalid_policy'],
      [{ ...policy, stages: [{ stageKey: 'stage-1', tasks: [] }] }, 'invalid_policy'],
      [{ ...policy, stages: [{
        stageKey: 'stage-1',
        tasks: [{ taskKey: 'task-1' }, { taskKey: 'task-1' }],
      }] }, 'invalid_policy'],
    ] as const) {
      expectCode(() => evaluateElearningLearningMap(forgedPolicy, {
        completedTaskKeys: [],
      }), code)
    }
  })

  it('rejects sparse arrays before holes can become phantom stages or tasks', () => {
    const sparseStages = new Array(1)
    const sparseTasks = new Array(1)
    const sparseProgress = new Array(1)
    expectCode(() => createElearningLearningMapPolicy(mapPolicy({
      stages: sparseStages,
    })), 'invalid_input')
    expectCode(() => createElearningLearningMapPolicy(mapPolicy({
      stages: [{ stageKey: 'stage-1', tasks: sparseTasks }],
    })), 'invalid_input')

    const policy = createElearningLearningMapPolicy(mapPolicy())
    expectCode(() => evaluateElearningLearningMap(policy, {
      completedTaskKeys: sparseProgress,
    }), 'invalid_input')
  })

  it('rejects malformed policies and hostile accessors with values-free errors', () => {
    for (const input of [
      null,
      {},
      mapPolicy({ extra: SENTINEL }),
      mapPolicy({ unlockMode: 'unknown' }),
      mapPolicy({ stages: [] }),
      mapPolicy({ stages: [{ stageKey: 'stage-1', tasks: [] }] }),
      mapPolicy({ policyRevision: SENTINEL + '\0' }),
      mapPolicy({ policyRevision: '\ud800' }),
    ]) {
      expectCode(() => createElearningLearningMapPolicy(input), (
        input && typeof input === 'object' && 'policyRevision' in input
        && ((input as { policyRevision?: unknown }).policyRevision === SENTINEL + '\0'
          || (input as { policyRevision?: unknown }).policyRevision === '\ud800'
          || (input as { unlockMode?: unknown }).unlockMode === 'unknown'
          || (input as { stages?: unknown }).stages instanceof Array
          && ((input as { stages: unknown[] }).stages.length === 0
            || (input as { stages: Array<{ tasks?: unknown[] }> }).stages[0]?.tasks?.length === 0))
      ) ? 'invalid_policy' : 'invalid_input')
    }

    const throwing = Object.defineProperty(mapPolicy(), 'policyRevision', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => createElearningLearningMapPolicy(throwing), 'invalid_input')
    expectCode(() => createElearningLearningMapPolicy(new Proxy(mapPolicy(), {
      ownKeys(): never { throw new Error(SENTINEL) },
    })), 'invalid_input')
  })

  it('accepts valid Unicode and enforces the stable-key length boundary', () => {
    const policy = createElearningLearningMapPolicy(mapPolicy({
      policyRevision: '🔥',
      stages: [{ stageKey: 's'.repeat(512), tasks: [{ taskKey: '任务' }] }],
    }))
    expect(policy.policyRevision).toBe('🔥')
    expect(policy.stages[0].stageKey).toHaveLength(512)
    expectCode(() => createElearningLearningMapPolicy(mapPolicy({
      policyRevision: 'x'.repeat(513),
    })), 'invalid_policy')
  })

  it('rejects a non-array completion set as malformed input', () => {
    const policy = createElearningLearningMapPolicy(mapPolicy())
    expectCode(() => evaluateElearningLearningMap(policy, {
      completedTaskKeys: 'task-1',
    }), 'invalid_input')
  })
})
