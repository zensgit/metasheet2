import { describe, expect, test } from 'vitest'

import {
  buildExactAnchorRecoveryPlan,
  classifyExactAnchorRecoveryPlan,
  ExactAnchorPlanDataError,
} from '../../src/multitable/exact-anchor-recovery-plan'
import type { QueryFn } from '../../src/multitable/permission-service'

describe('W0 L7 exact-anchor recovery plan hardening', () => {
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

  test('an invalid live version fails closed before reconstruction can produce an apply anchor', async () => {
    let queryCount = 0
    const query: QueryFn = async () => {
      queryCount++
      if (queryCount === 1) return { rows: [{ id: 'f1' }] }
      if (queryCount === 2)
        return { rows: [{ id: 'r1', data: { f1: 'v' }, version: null }] }
      throw new Error(
        'reconstruction must not run after an invalid live version',
      )
    }

    await expect(
      buildExactAnchorRecoveryPlan(query, 'sheet-1', '10'),
    ).rejects.toThrow(ExactAnchorPlanDataError)
    expect(queryCount).toBe(2)
  })
})
