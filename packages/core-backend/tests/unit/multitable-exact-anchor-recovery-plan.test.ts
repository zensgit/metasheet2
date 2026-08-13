import { describe, expect, test } from 'vitest'

import * as exactAnchorPlan from '../../src/multitable/exact-anchor-recovery-plan'

const { classifyExactAnchorRecoveryPlan, ExactAnchorPlanDataError } = exactAnchorPlan

describe('W0 L7 exact-anchor recovery plan hardening', () => {
  test('the public runtime surface is pure classification only (no autocommit multi-read builder)', () => {
    expect(Object.keys(exactAnchorPlan).sort()).toEqual([
      'ExactAnchorPlanDataError',
      'classifyExactAnchorRecoveryPlan',
    ])
  })

  test('nested object key order is semantic-equal, so an unchanged record is not reverted', () => {
    const state = new Map([
      [
        'r1',
        {
          recordId: 'r1',
          exists: true,
          data: { f1: { a: 1, b: { x: 2, y: 3 } } },
          version: 4,
        },
      ],
    ])
    const live = new Map([
      ['r1', { data: { f1: { b: { y: 3, x: 2 }, a: 1 } }, version: 4 }],
    ])

    const plan = classifyExactAnchorRecoveryPlan(state, live, new Set(['f1']))

    expect(plan.unchangedCount).toBe(1)
    expect(plan.reverts).toEqual([])
  })

  test('all record-id arrays and candidates are deterministic across reverse map insertion order', () => {
    const state = new Map([
      [
        'z-revert',
        {
          recordId: 'z-revert',
          exists: true,
          data: { f1: 'old-z' },
          version: 1,
        },
      ],
      [
        'a-revert',
        {
          recordId: 'a-revert',
          exists: true,
          data: { f1: 'old-a' },
          version: 1,
        },
      ],
      [
        'z-resurrect',
        {
          recordId: 'z-resurrect',
          exists: true,
          data: { f1: 'gone-z' },
          version: 1,
        },
      ],
      [
        'a-resurrect',
        {
          recordId: 'a-resurrect',
          exists: true,
          data: { f1: 'gone-a' },
          version: 1,
        },
      ],
      [
        'z-deleted',
        { recordId: 'z-deleted', exists: false, data: null, version: 2 },
      ],
      [
        'a-deleted',
        { recordId: 'a-deleted', exists: false, data: null, version: 2 },
      ],
    ])
    const live = new Map([
      ['z-created', { data: { f1: 'new-z' }, version: 1 }],
      ['a-created', { data: { f1: 'new-a' }, version: 1 }],
      ['z-deleted', { data: { f1: 'live-z' }, version: 3 }],
      ['a-deleted', { data: { f1: 'live-a' }, version: 3 }],
      ['z-revert', { data: { f1: 'new-z' }, version: 2 }],
      ['a-revert', { data: { f1: 'new-a' }, version: 2 }],
    ])

    const plan = classifyExactAnchorRecoveryPlan(state, live, new Set(['f1']))

    expect(plan.reverts.map((item) => item.recordId)).toEqual([
      'a-revert',
      'z-revert',
    ])
    expect(plan.resurrects.map((item) => item.recordId)).toEqual([
      'a-resurrect',
      'z-resurrect',
    ])
    expect(plan.deletedAtAnchorLiveNow).toEqual(['a-deleted', 'z-deleted'])
    expect(plan.createdAfterAnchor).toEqual(['a-created', 'z-created'])
  })

  test('an invalid live version fails closed before it can become an apply anchor', () => {
    const state = new Map([
      [
        'r1',
        {
          recordId: 'r1',
          exists: true,
          data: { f1: 'old' },
          version: 1,
        },
      ],
    ])
    const live = new Map([['r1', { data: { f1: 'new' }, version: null }]])

    expect(() => classifyExactAnchorRecoveryPlan(state, live, new Set(['f1']))).toThrow(
      ExactAnchorPlanDataError,
    )
  })

  test('an existing target with no trustworthy snapshot fails closed instead of becoming an empty write', () => {
    const state = new Map([
      [
        'r1',
        {
          recordId: 'r1',
          exists: true,
          data: null,
          version: 1,
        },
      ],
    ])
    const live = new Map([['r1', { data: { f1: 'live' }, version: 2 }]])

    expect(() => classifyExactAnchorRecoveryPlan(state, live, new Set(['f1']))).toThrow(
      ExactAnchorPlanDataError,
    )
  })

  test('an existing target with no trustworthy version fails closed', () => {
    const state = new Map([
      [
        'r1',
        {
          recordId: 'r1',
          exists: true,
          data: { f1: 'old' },
          version: null,
        },
      ],
    ])
    const live = new Map([['r1', { data: { f1: 'live' }, version: 2 }]])

    expect(() => classifyExactAnchorRecoveryPlan(state, live, new Set(['f1']))).toThrow(
      ExactAnchorPlanDataError,
    )
  })

  test('an unchanged stale-key record is a no-op, not whole-plan schema drift', () => {
    const state = new Map([
      [
        'r1',
        {
          recordId: 'r1',
          exists: true,
          data: { removedField: 'same' },
          version: 1,
        },
      ],
    ])
    const live = new Map([['r1', { data: { removedField: 'same' }, version: 1 }]])

    const plan = classifyExactAnchorRecoveryPlan(state, live, new Set())

    expect(plan.unchangedCount).toBe(1)
    expect(plan.driftCount).toBe(0)
    expect(plan.reverts).toEqual([])
  })
})
