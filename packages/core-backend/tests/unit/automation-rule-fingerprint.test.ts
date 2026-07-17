/**
 * #4196 §2.1/§4 rule action-set fingerprint (unit).
 *
 * Proves the §2.1-identity fingerprint detects the rule changes a retry must refuse — including the
 * config-only edit that the existing type-only `computeActionFingerprint` (suspend/resume guard) CANNOT see.
 */
import { describe, expect, it } from 'vitest'

import { deriveRuleActionSetFingerprint, enumerateRuleActions } from '../../src/multitable/automation-rule-fingerprint'
import { computeActionFingerprint } from '../../src/multitable/automation-suspension-service'

const A = (type: string, config: Record<string, unknown> = {}) => ({ type, config })

describe('#4196 §2.1 rule action-set fingerprint', () => {
  it('identical action sets fingerprint identically', () => {
    const r1 = [A('update_record', { fields: { a: 1 } }), A('send_webhook', { url: 'x' })]
    const r2 = [A('update_record', { fields: { a: 1 } }), A('send_webhook', { url: 'x' })]
    expect(deriveRuleActionSetFingerprint(r1)).toEqual(deriveRuleActionSetFingerprint(r2))
  })

  it('a CONFIG-ONLY edit changes the fingerprint — the gap the type-only guard misses', () => {
    const before = [A('update_record', { fields: { a: 1 } })]
    const after = [A('update_record', { fields: { a: 2 } })] // same type, changed config
    // the NEW fingerprint sees the change...
    expect(deriveRuleActionSetFingerprint(before).hash).not.toBe(deriveRuleActionSetFingerprint(after).hash)
    // ...while the existing type-only fingerprint is BLIND to it (this is exactly why §4 mandates the upgrade)
    expect(computeActionFingerprint(before).hash).toBe(computeActionFingerprint(after).hash)
  })

  it('a TYPE SWAP in place changes the fingerprint', () => {
    const before = [A('update_record', { fields: { a: 1 } })]
    const after = [A('delete_record', { fields: { a: 1 } })] // same path + config, different type
    expect(deriveRuleActionSetFingerprint(before).hash).not.toBe(deriveRuleActionSetFingerprint(after).hash)
  })

  it('REORDERING actions changes the fingerprint (structural path is position-sensitive)', () => {
    const before = [A('update_record', { x: 1 }), A('send_webhook', { u: 2 })]
    const after = [A('send_webhook', { u: 2 }), A('update_record', { x: 1 })]
    expect(deriveRuleActionSetFingerprint(before).hash).not.toBe(deriveRuleActionSetFingerprint(after).hash)
  })

  it('ADD / REMOVE changes both count and hash', () => {
    const one = [A('update_record', { a: 1 })]
    const two = [A('update_record', { a: 1 }), A('send_webhook', { u: 1 })]
    const fp1 = deriveRuleActionSetFingerprint(one)
    const fp2 = deriveRuleActionSetFingerprint(two)
    expect(fp1.count).toBe(1)
    expect(fp2.count).toBe(2)
    expect(fp1.hash).not.toBe(fp2.hash)
  })

  it('a NESTED branch action config edit changes the fingerprint (walk recurses config.branches[].actions[])', () => {
    const mk = (v: number) => [
      A('condition_branch', {
        branches: [
          { key: 'b0', actions: [A('update_record', { fields: { n: v } })] },
          { key: 'b1', actions: [A('send_webhook', { url: 'y' })] },
        ],
      }),
    ]
    expect(deriveRuleActionSetFingerprint(mk(1)).hash).not.toBe(deriveRuleActionSetFingerprint(mk(2)).hash)
    // the nested walk counts the parent + both branch actions
    expect(deriveRuleActionSetFingerprint(mk(1)).count).toBe(3)
  })

  it('enumerateRuleActions assigns canonical, position-sensitive paths incl. nested', () => {
    const rule = [
      A('update_record', { a: 1 }),
      A('parallel_branch', {
        branches: [{ key: 'b0', actions: [A('send_notification', {}), A('update_record', {})] }],
      }),
    ]
    const paths = [...enumerateRuleActions(rule)].map((e) => e.structuralPath)
    expect(paths).toEqual([
      'actions[0]',
      'actions[1]',
      'actions[1].branches[0].actions[0]',
      'actions[1].branches[0].actions[1]',
    ])
  })

  it('empty / undefined action sets fingerprint to an empty, stable value', () => {
    expect(deriveRuleActionSetFingerprint([])).toEqual(deriveRuleActionSetFingerprint(undefined))
    expect(deriveRuleActionSetFingerprint([]).count).toBe(0)
  })
})
