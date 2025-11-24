/**
 * Minimal unit tests for ProtectionRuleService condition evaluation
 * These tests avoid DB by calling private helpers via `any` cast.
 */
import { describe, it, expect } from 'vitest'
import { ProtectionRuleService } from '../../src/services/ProtectionRuleService'

describe('ProtectionRuleService — condition evaluation (unit, no DB)', () => {
  const svc = new ProtectionRuleService() as any

  it('eq/ne operator on scalar fields', () => {
    const props = { protection_level: 'critical' }
    expect(svc.evaluateCondition({ field: 'protection_level', operator: 'eq', value: 'critical' }, props)).toBe(true)
    expect(svc.evaluateCondition({ field: 'protection_level', operator: 'eq', value: 'protected' }, props)).toBe(false)
    expect(svc.evaluateCondition({ field: 'protection_level', operator: 'ne', value: 'protected' }, props)).toBe(true)
  })

  it('contains / not_contains with arrays and strings', () => {
    const props = { tags: ['production', 'stable'], name: 'release-stable' }
    expect(svc.evaluateCondition({ field: 'tags', operator: 'contains', value: 'production' }, props)).toBe(true)
    expect(svc.evaluateCondition({ field: 'tags', operator: 'not_contains', value: 'beta' }, props)).toBe(true)
    expect(svc.evaluateCondition({ field: 'name', operator: 'contains', value: 'stable' }, props)).toBe(true)
    expect(svc.evaluateCondition({ field: 'name', operator: 'not_contains', value: 'beta' }, props)).toBe(true)
  })

  it('in / not_in operator over whitelists', () => {
    const props = { release_channel: 'canary' }
    expect(svc.evaluateCondition({ field: 'release_channel', operator: 'in', value: ['canary', 'beta'] }, props)).toBe(true)
    expect(svc.evaluateCondition({ field: 'release_channel', operator: 'not_in', value: ['stable', 'experimental'] }, props)).toBe(true)
  })

  it('composite conditions: all / any / not', () => {
    const props = { protection_level: 'critical', tags: ['production'], size: 5 }
    expect(
      svc.evaluateConditions(
        { all: [ { field: 'protection_level', operator: 'eq', value: 'critical' }, { field: 'tags', operator: 'contains', value: 'production' } ] },
        props
      )
    ).toBe(true)

    expect(
      svc.evaluateConditions(
        { any: [ { field: 'size', operator: 'gt', value: 10 }, { field: 'size', operator: 'lte', value: 5 } ] },
        props
      )
    ).toBe(true)

    expect(
      svc.evaluateConditions(
        { not: { field: 'tags', operator: 'contains', value: 'beta' } },
        props
      )
    ).toBe(true)
  })
})

