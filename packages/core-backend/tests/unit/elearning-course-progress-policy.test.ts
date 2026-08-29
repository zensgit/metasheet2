import { describe, expect, it } from 'vitest'

import {
  ELEARNING_COURSE_PROGRESS_MAX_ITEMS,
  ELEARNING_COURSE_PROGRESS_POLICY_VERSION,
  ElearningCourseProgressPolicyError,
  evaluateElearningCourseProgress,
} from '../../src/services/elearning-course-progress-policy'

const SENTINEL = 'secret-course-progress-value'

function evaluate(itemStates: unknown) {
  return evaluateElearningCourseProgress({
    itemStates,
    policyVersion: ELEARNING_COURSE_PROGRESS_POLICY_VERSION,
  })
}

function expectInvalid(action: () => unknown): void {
  try {
    action()
    throw new Error('expected course progress policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningCourseProgressPolicyError)
    const policyError = error as ElearningCourseProgressPolicyError
    expect(policyError.code).toBe('invalid_input')
    expect(policyError.message).toBe('invalid_input')
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning course progress policy', () => {
  it('keeps a course not started only while every required item is untouched', () => {
    expect(evaluate(['not_started', 'not_started'])).toEqual({
      completedItemCount: 0,
      itemCount: 2,
      policyVersion: ELEARNING_COURSE_PROGRESS_POLICY_VERSION,
      startedItemCount: 0,
      status: 'not_started',
    })
  })

  it('marks any partially started or partially completed version in progress', () => {
    expect(evaluate(['completed', 'not_started', 'in_progress'])).toEqual({
      completedItemCount: 1,
      itemCount: 3,
      policyVersion: ELEARNING_COURSE_PROGRESS_POLICY_VERSION,
      startedItemCount: 2,
      status: 'in_progress',
    })
    expect(evaluate(['completed', 'not_started']).status).toBe('in_progress')
    expect(evaluate(['in_progress', 'not_started']).status).toBe('in_progress')
  })

  it('completes only when every required version item is completed', () => {
    const result = evaluate(['completed', 'completed', 'completed'])
    expect(result).toEqual({
      completedItemCount: 3,
      itemCount: 3,
      policyVersion: ELEARNING_COURSE_PROGRESS_POLICY_VERSION,
      startedItemCount: 3,
      status: 'completed',
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('rejects empty, invalid, sparse, oversized, and decorated state arrays', () => {
    expectInvalid(() => evaluate([]))
    expectInvalid(() => evaluate(['completed', 'passed']))
    expectInvalid(() => evaluate(new Array(2)))
    expectInvalid(() => evaluate(
      new Array(ELEARNING_COURSE_PROGRESS_MAX_ITEMS + 1).fill('not_started'),
    ))
    const decorated = ['completed'] as string[] & { extra?: string }
    decorated.extra = SENTINEL
    expectInvalid(() => evaluate(decorated))
  })

  it('rejects open inputs and client completion assertions values-free', () => {
    for (const value of [
      null,
      {},
      {
        completed: true,
        itemStates: ['completed'],
        policyVersion: ELEARNING_COURSE_PROGRESS_POLICY_VERSION,
      },
      {
        itemStates: ['completed'],
        policyVersion: 'course-required-items-v2',
      },
      {
        itemStates: ['completed'],
        policyVersion: ELEARNING_COURSE_PROGRESS_POLICY_VERSION,
        secret: SENTINEL,
      },
    ]) expectInvalid(() => evaluateElearningCourseProgress(value))
  })

  it('does not retain a mutable caller state array', () => {
    const itemStates = ['completed', 'not_started']
    const result = evaluate(itemStates)
    itemStates[1] = 'completed'
    itemStates.push('completed')
    expect(result).toMatchObject({
      completedItemCount: 1,
      itemCount: 2,
      startedItemCount: 1,
      status: 'in_progress',
    })
  })
})
