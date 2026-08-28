import { describe, expect, it } from 'vitest'

import {
  ElearningBlendedProjectPolicyError,
  createElearningBlendedProjectPolicy,
  evaluateElearningBlendedProject,
} from '../../src/services/elearning-blended-project-policy'

const SENTINEL = 'secret-blended-project-value'

function mapPolicy(overrides: Record<string, unknown> = {}) {
  return {
    policyRevision: 'map-v1',
    stages: [
      {
        stageKey: 'stage-1',
        tasks: [{ taskKey: 'online-1' }, { taskKey: 'offline-1' }],
      },
      {
        stageKey: 'stage-2',
        tasks: [{ taskKey: 'exam-1' }, { taskKey: 'survey-1' }],
      },
    ],
    unlockMode: 'free',
    ...overrides,
  }
}

function projectPolicy(overrides: Record<string, unknown> = {}) {
  return {
    cohorts: [
      {
        cohortKey: 'cohort-a',
        homeroomTeacherUserId: 'teacher-a',
        requiredTaskKeys: ['online-1', 'offline-1', 'exam-1'],
      },
      {
        cohortKey: 'cohort-b',
        homeroomTeacherUserId: 'teacher-b',
        requiredTaskKeys: ['online-1', 'survey-1'],
      },
    ],
    createdByUserId: 'creator-1',
    mapPolicyRevision: 'map-v1',
    projectKey: 'blended-project-1',
    projectOwnerUserId: 'owner-1',
    projectPolicyRevision: 'project-v1',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected blended project policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningBlendedProjectPolicyError)
    const policyError = error as ElearningBlendedProjectPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning blended project policy', () => {
  it('pins project roles and cohort-required task subsets to the map revision', () => {
    const policy = createElearningBlendedProjectPolicy(mapPolicy(), projectPolicy())
    expect(policy).toEqual({
      cohorts: [
        {
          cohortKey: 'cohort-a',
          homeroomTeacherUserId: 'teacher-a',
          requiredTaskKeys: ['online-1', 'offline-1', 'exam-1'],
        },
        {
          cohortKey: 'cohort-b',
          homeroomTeacherUserId: 'teacher-b',
          requiredTaskKeys: ['online-1', 'survey-1'],
        },
      ],
      createdByUserId: 'creator-1',
      mapPolicyRevision: 'map-v1',
      projectKey: 'blended-project-1',
      projectOwnerUserId: 'owner-1',
      projectPolicyRevision: 'project-v1',
    })
  })

  it('computes cohort completion from required tasks while preserving map states', () => {
    const state = evaluateElearningBlendedProject(
      mapPolicy(),
      projectPolicy(),
      {
        cohortKey: 'cohort-a',
        completedTaskKeys: ['online-1', 'survey-1'],
      },
    )
    expect(state).toEqual({
      cohortKey: 'cohort-a',
      completedRequiredTaskCount: 1,
      mapPolicyRevision: 'map-v1',
      projectKey: 'blended-project-1',
      projectPolicyRevision: 'project-v1',
      stages: [
        {
          stageKey: 'stage-1',
          tasks: [
            { required: true, status: 'completed', taskKey: 'online-1' },
            { required: true, status: 'available', taskKey: 'offline-1' },
          ],
        },
        {
          stageKey: 'stage-2',
          tasks: [
            { required: true, status: 'available', taskKey: 'exam-1' },
            { required: false, status: 'completed', taskKey: 'survey-1' },
          ],
        },
      ],
      status: 'in_progress',
      totalRequiredTaskCount: 3,
    })
  })

  it('completes a cohort without requiring optional project tasks', () => {
    const state = evaluateElearningBlendedProject(
      mapPolicy(),
      projectPolicy(),
      {
        cohortKey: 'cohort-b',
        completedTaskKeys: ['online-1', 'survey-1'],
      },
    )
    expect(state).toMatchObject({
      completedRequiredTaskCount: 2,
      status: 'completed',
      totalRequiredTaskCount: 2,
    })
  })

  it('keeps each cohort result isolated to its own required subset', () => {
    const completedTaskKeys = ['online-1', 'survey-1']
    const cohortA = evaluateElearningBlendedProject(
      mapPolicy(),
      projectPolicy(),
      { cohortKey: 'cohort-a', completedTaskKeys },
    )
    const cohortB = evaluateElearningBlendedProject(
      mapPolicy(),
      projectPolicy(),
      { cohortKey: 'cohort-b', completedTaskKeys },
    )
    expect(cohortA.status).toBe('in_progress')
    expect(cohortB.status).toBe('completed')
  })

  it('rejects unknown, duplicate, or empty cohort task subsets', () => {
    for (const requiredTaskKeys of [
      [],
      ['unknown-task'],
      ['online-1', 'online-1'],
    ]) {
      expectCode(() => createElearningBlendedProjectPolicy(
        mapPolicy(),
        projectPolicy({
          cohorts: [{
            cohortKey: 'cohort-a',
            homeroomTeacherUserId: 'teacher-a',
            requiredTaskKeys,
          }],
        }),
      ), 'invalid_policy')
    }
    expectCode(() => createElearningBlendedProjectPolicy(
      mapPolicy(),
      projectPolicy({
        cohorts: [
          projectPolicy().cohorts[0],
          { ...projectPolicy().cohorts[1], cohortKey: 'cohort-a' },
        ],
      }),
    ), 'invalid_policy')
  })

  it('inherits impossible sequential progress rejection from the learning map', () => {
    expectCode(() => evaluateElearningBlendedProject(
      mapPolicy({ unlockMode: 'task_sequential' }),
      projectPolicy(),
      { cohortKey: 'cohort-a', completedTaskKeys: ['exam-1'] },
    ), 'invalid_progress')
  })

  it('rejects project policies pinned to another map revision', () => {
    expectCode(() => createElearningBlendedProjectPolicy(
      mapPolicy({ policyRevision: 'map-v2' }),
      projectPolicy(),
    ), 'policy_mismatch')
    expectCode(() => evaluateElearningBlendedProject(
      mapPolicy({ policyRevision: 'map-v2' }),
      projectPolicy(),
      { cohortKey: 'cohort-a', completedTaskKeys: [] },
    ), 'policy_mismatch')
  })

  it('rejects unknown cohorts without returning another cohort state', () => {
    expectCode(() => evaluateElearningBlendedProject(
      mapPolicy(),
      projectPolicy(),
      { cohortKey: 'cohort-missing', completedTaskKeys: [] },
    ), 'unknown_cohort')
  })

  it('returns deeply immutable policy and learner state', () => {
    const policy = createElearningBlendedProjectPolicy(mapPolicy(), projectPolicy())
    const state = evaluateElearningBlendedProject(
      mapPolicy(),
      projectPolicy(),
      { cohortKey: 'cohort-a', completedTaskKeys: [] },
    )
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.cohorts)).toBe(true)
    expect(policy.cohorts.every(Object.isFrozen)).toBe(true)
    expect(policy.cohorts.every((cohort) => Object.isFrozen(cohort.requiredTaskKeys))).toBe(true)
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.stages)).toBe(true)
    expect(state.stages.every(Object.isFrozen)).toBe(true)
    expect(state.stages.every((stage) => Object.isFrozen(stage.tasks))).toBe(true)
    expect(state.stages.flatMap((stage) => stage.tasks).every(Object.isFrozen)).toBe(true)
  })

  it('fails closed with values-free errors for malformed roles and shapes', () => {
    for (const input of [null, {}, projectPolicy({ extra: SENTINEL })]) {
      expectCode(() => createElearningBlendedProjectPolicy(mapPolicy(), input), 'invalid_input')
    }
    for (const input of [
      projectPolicy({ cohorts: [] }),
      projectPolicy({ createdByUserId: `${SENTINEL}\0` }),
      projectPolicy({ projectOwnerUserId: '' }),
      projectPolicy({ projectPolicyRevision: '   ' }),
    ]) {
      expectCode(() => createElearningBlendedProjectPolicy(mapPolicy(), input), 'invalid_policy')
    }
    expectCode(() => createElearningBlendedProjectPolicy(
      { ...mapPolicy(), unlockMode: SENTINEL },
      projectPolicy(),
    ), 'invalid_policy')
    expectCode(() => evaluateElearningBlendedProject(
      mapPolicy(),
      projectPolicy(),
      { cohortKey: `${SENTINEL}\0`, completedTaskKeys: [] },
    ), 'invalid_input')

    const throwing = Object.defineProperty(projectPolicy(), 'projectKey', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => createElearningBlendedProjectPolicy(mapPolicy(), throwing), 'invalid_input')
  })
})
