import { describe, expect, it } from 'vitest'
import {
  ELEARNING_LEARNING_MAP_REWARD_DOMAIN,
  ElearningLearningMapRewardPolicyError,
  deriveElearningLearningMapRewards,
} from '../../src/services/elearning-learning-map-reward-policy'
import { createElearningLearningMapPolicy } from '../../src/services/elearning-learning-map-policy'

const SENTINEL = 'secret-reward-value'

function policy(overrides: Record<string, unknown> = {}) {
  return createElearningLearningMapPolicy({
    policyRevision: 'map-v1',
    stages: [
      { stageKey: 'stage-1', tasks: [{ taskKey: 'task-1' }, { taskKey: 'task-2' }] },
      { stageKey: 'stage-2', tasks: [{ taskKey: 'task-3' }, { taskKey: 'task-4' }] },
    ],
    unlockMode: 'task_sequential',
    ...overrides,
  })
}

function rewardInput(overrides: Record<string, unknown> = {}) {
  return {
    afterCompletedTaskKeys: ['task-1', 'task-2'],
    beforeCompletedTaskKeys: ['task-1'],
    certificateMode: 'stage',
    creditMode: 'stage',
    mapKey: 'map-1',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected learning-map reward error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningLearningMapRewardPolicyError)
    const rewardError = error as ElearningLearningMapRewardPolicyError
    expect(rewardError.code).toBe(code)
    expect(rewardError.message).toBe(code)
    expect(rewardError.cause).toBeUndefined()
    expect(`${rewardError.message}\n${rewardError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning learning-map reward policy', () => {
  it('emits one stable credit and certificate effect for a newly completed stage', () => {
    const decision = deriveElearningLearningMapRewards(policy(), rewardInput())
    expect(decision.newlyCompletedStageKeys).toEqual(['stage-1'])
    expect(decision.mapCompletedNow).toBe(false)
    expect(decision.creditEffects).toEqual([{
      effectKey: expect.stringMatching(new RegExp(`^${ELEARNING_LEARNING_MAP_REWARD_DOMAIN}:[a-f0-9]{64}$`)),
      kind: 'credit',
      scope: 'stage',
      stageKey: 'stage-1',
    }])
    expect(decision.certificateEffects).toEqual([{
      effectKey: expect.stringMatching(new RegExp(`^${ELEARNING_LEARNING_MAP_REWARD_DOMAIN}:[a-f0-9]{64}$`)),
      kind: 'certificate',
      scope: 'stage',
      stageKey: 'stage-1',
    }])
    expect(decision.creditEffects[0].effectKey).not.toBe(decision.certificateEffects[0].effectKey)
  })

  it('emits map-scoped effects only on the transition to full completion', () => {
    const input = rewardInput({
      afterCompletedTaskKeys: ['task-1', 'task-2', 'task-3', 'task-4'],
      beforeCompletedTaskKeys: ['task-1', 'task-2', 'task-3'],
      certificateMode: 'map',
      creditMode: 'map',
    })
    const first = deriveElearningLearningMapRewards(policy(), input)
    const replay = deriveElearningLearningMapRewards(policy(), input)
    expect(first).toEqual(replay)
    expect(first.mapCompletedNow).toBe(true)
    expect(first.newlyCompletedStageKeys).toEqual(['stage-2'])
    expect(first.creditEffects).toEqual([{
      effectKey: expect.any(String),
      kind: 'credit',
      scope: 'map',
      stageKey: null,
    }])
    expect(first.certificateEffects).toEqual([{
      effectKey: expect.any(String),
      kind: 'certificate',
      scope: 'map',
      stageKey: null,
    }])
  })

  it('supports no certificate while preserving required credit behavior', () => {
    const decision = deriveElearningLearningMapRewards(policy(), rewardInput({
      certificateMode: 'none',
    }))
    expect(decision.certificateEffects).toEqual([])
    expect(decision.creditEffects).toHaveLength(1)
  })

  it('returns no effects when the authoritative completion set did not change', () => {
    const decision = deriveElearningLearningMapRewards(policy(), rewardInput({
      afterCompletedTaskKeys: ['task-1'],
      beforeCompletedTaskKeys: ['task-1'],
    }))
    expect(decision).toMatchObject({
      certificateEffects: [],
      creditEffects: [],
      mapCompletedNow: false,
      newlyCompletedStageKeys: [],
      policyRevision: 'map-v1',
    })
  })

  it('fails closed on completion regression or impossible sequential progress', () => {
    expectCode(() => deriveElearningLearningMapRewards(policy(), rewardInput({
      afterCompletedTaskKeys: ['task-1'],
      beforeCompletedTaskKeys: ['task-1', 'task-2'],
    })), 'invalid_transition')
    expectCode(() => deriveElearningLearningMapRewards(policy(), rewardInput({
      afterCompletedTaskKeys: ['task-2'],
      beforeCompletedTaskKeys: [],
    })), 'invalid_transition')
  })

  it('changes effect identity across map, revision, reward kind, and scope', () => {
    const stage = deriveElearningLearningMapRewards(policy(), rewardInput())
    const otherMap = deriveElearningLearningMapRewards(policy(), rewardInput({ mapKey: 'map-2' }))
    const otherRevision = deriveElearningLearningMapRewards(policy({
      policyRevision: 'map-v2',
    }), rewardInput())
    const mapScope = deriveElearningLearningMapRewards(policy(), rewardInput({
      afterCompletedTaskKeys: ['task-1', 'task-2', 'task-3', 'task-4'],
      beforeCompletedTaskKeys: ['task-1', 'task-2', 'task-3'],
      certificateMode: 'map',
      creditMode: 'map',
    }))
    const keys = [
      stage.creditEffects[0].effectKey,
      stage.certificateEffects[0].effectKey,
      otherMap.creditEffects[0].effectKey,
      otherRevision.creditEffects[0].effectKey,
      mapScope.creditEffects[0].effectKey,
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('returns deeply immutable decisions and effects', () => {
    const decision = deriveElearningLearningMapRewards(policy(), rewardInput())
    expect(Object.isFrozen(decision)).toBe(true)
    expect(Object.isFrozen(decision.newlyCompletedStageKeys)).toBe(true)
    expect(Object.isFrozen(decision.creditEffects)).toBe(true)
    expect(Object.isFrozen(decision.certificateEffects)).toBe(true)
    expect(decision.creditEffects.every(Object.isFrozen)).toBe(true)
  })

  it('rejects malformed commands and forged policy snapshots with values-free errors', () => {
    for (const [input, code] of [
      [null, 'invalid_input'],
      [{}, 'invalid_input'],
      [rewardInput({ extra: SENTINEL }), 'invalid_input'],
      [rewardInput({ mapKey: SENTINEL + '\0' }), 'invalid_input'],
      [rewardInput({ creditMode: 'none' }), 'invalid_input'],
      [rewardInput({ certificateMode: 'unknown' }), 'invalid_input'],
    ] as const) {
      expectCode(() => deriveElearningLearningMapRewards(policy(), input), code)
    }
    expectCode(() => deriveElearningLearningMapRewards({
      ...policy(),
      unlockMode: 'unknown',
    }, rewardInput()), 'invalid_input')

    const throwing = Object.defineProperty(rewardInput(), 'mapKey', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => deriveElearningLearningMapRewards(policy(), throwing), 'invalid_input')
  })
})
