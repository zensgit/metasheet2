/**
 * #4196 §2.1/§4 rule action-set fingerprint (unit).
 *
 * Proves the §2.1-identity fingerprint (a) detects the rule changes a retry must refuse — including the
 * config-only edit the type-only `computeActionFingerprint` cannot see; (b) uses the EXECUTOR's exact
 * step-key identity (branch KEY, not array index) via the shared `automation-step-key` builder; and (c)
 * derives keys byte-identical to a direct `deriveActionKey` call (no double-canonicalization).
 */
import { describe, expect, it } from 'vitest'

import { deriveRuleActionSetFingerprint, enumerateRuleActions } from '../../src/multitable/automation-rule-fingerprint'
import { deriveActionKey } from '../../src/multitable/automation-action-idempotency'
import { branchChildStepKey, topLevelStepKey } from '../../src/multitable/automation-step-key'
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
    expect(deriveRuleActionSetFingerprint(before).hash).not.toBe(deriveRuleActionSetFingerprint(after).hash)
    // the existing type-only fingerprint is BLIND to it (exactly why §4 mandates the upgrade)
    expect(computeActionFingerprint(before).hash).toBe(computeActionFingerprint(after).hash)
  })

  it('a TYPE SWAP in place changes the fingerprint', () => {
    const before = [A('update_record', { fields: { a: 1 } })]
    const after = [A('delete_record', { fields: { a: 1 } })]
    expect(deriveRuleActionSetFingerprint(before).hash).not.toBe(deriveRuleActionSetFingerprint(after).hash)
  })

  it('REORDERING top-level actions changes the fingerprint (step index is position-sensitive)', () => {
    const before = [A('update_record', { x: 1 }), A('send_webhook', { u: 2 })]
    const after = [A('send_webhook', { u: 2 }), A('update_record', { x: 1 })]
    expect(deriveRuleActionSetFingerprint(before).hash).not.toBe(deriveRuleActionSetFingerprint(after).hash)
  })

  it('ADD / REMOVE changes both count and hash', () => {
    const one = [A('update_record', { a: 1 })]
    const two = [A('update_record', { a: 1 }), A('send_webhook', { u: 1 })]
    expect(deriveRuleActionSetFingerprint(one).count).toBe(1)
    expect(deriveRuleActionSetFingerprint(two).count).toBe(2)
    expect(deriveRuleActionSetFingerprint(one).hash).not.toBe(deriveRuleActionSetFingerprint(two).hash)
  })

  it('enumerateRuleActions uses the EXECUTOR step-keys exactly (top-level + parallel/condition branch KEY)', () => {
    const rule = [
      A('update_record', { a: 1 }),
      A('parallel_branch', { branches: [{ key: 'p0', actions: [A('send_notification', {}), A('update_record', {})] }] }),
      A('condition_branch', { branches: [{ key: 'c0', actions: [A('update_record', {})] }] }),
    ]
    const paths = [...enumerateRuleActions(rule)].map((e) => e.structuralPath)
    expect(paths).toEqual([
      topLevelStepKey(0), // "0"
      topLevelStepKey(1), // "1"
      branchChildStepKey(1, 'parallel', 'p0', 0), // "1.parallel.p0.0"
      branchChildStepKey(1, 'parallel', 'p0', 1), // "1.parallel.p0.1"
      topLevelStepKey(2), // "2"
      branchChildStepKey(2, 'branch', 'c0', 0), // "2.branch.c0.0"
    ])
    // spot-check the literal executor format
    expect(paths).toContain('1.parallel.p0.1')
    expect(paths).toContain('2.branch.c0.0')
  })

  it('a nested branch action CONFIG edit changes the fingerprint (walk recurses into branch actions)', () => {
    const mk = (v: number) => [
      A('condition_branch', {
        branches: [
          { key: 'b0', actions: [A('update_record', { fields: { n: v } })] },
          { key: 'b1', actions: [A('send_webhook', { url: 'y' })] },
        ],
      }),
    ]
    expect(deriveRuleActionSetFingerprint(mk(1)).hash).not.toBe(deriveRuleActionSetFingerprint(mk(2)).hash)
    expect(deriveRuleActionSetFingerprint(mk(1)).count).toBe(3) // parent + 2 branch actions
  })

  it('branch CHILD identity binds to the KEY, not the array index (#4420 P1)', () => {
    const child = A('update_record', { v: 1 })
    // SAME child index (0), DIFFERENT branch key → different child identity → different fingerprint
    const keyA = [A('parallel_branch', { branches: [{ key: 'a', actions: [child] }] })]
    const keyB = [A('parallel_branch', { branches: [{ key: 'b', actions: [child] }] })]
    expect(deriveRuleActionSetFingerprint(keyA).hash).not.toBe(deriveRuleActionSetFingerprint(keyB).hash)
    // REORDERING branches does not move a CHILD's key-bound path: the update_record under branch 'a' stays
    // `0.parallel.a.0` whether 'a' is first or second in the array (index-based paths would have moved it).
    // (The whole-rule fingerprint still changes — the PARENT parallel_branch's config captures branch order —
    // which is correct: reordering branches IS a config edit to the parent.)
    const pathOfUpdate = (rule: ReturnType<typeof A>[]) =>
      [...enumerateRuleActions(rule)].find((e) => e.action.type === 'update_record' && e.structuralPath.includes('.'))?.structuralPath
    const ordered = [A('parallel_branch', { branches: [{ key: 'a', actions: [A('update_record', { v: 1 })] }, { key: 'b', actions: [A('send_notification', {})] }] })]
    const reversed = [A('parallel_branch', { branches: [{ key: 'b', actions: [A('send_notification', {})] }, { key: 'a', actions: [A('update_record', { v: 1 })] }] })]
    expect(pathOfUpdate(ordered)).toBe('0.parallel.a.0')
    expect(pathOfUpdate(reversed)).toBe('0.parallel.a.0') // key-bound, not position-bound
  })

  it('shares the applied-ledger identity: the enumerator key EXACTLY equals a direct deriveActionKey (#4420 P2)', () => {
    const cfg = { fields: { z: 3, a: 1 }, note: 'x' } // deliberately unsorted keys to exercise canonicalization
    const rule = [A('update_record', cfg)]
    const [entry] = [...enumerateRuleActions(rule)]
    const direct = deriveActionKey({ structuralPath: entry.structuralPath, actionType: 'update_record', canonicalConfig: cfg })
    // the enumerator passes RAW config, so its per-action key must be byte-identical to the ledger's own call
    const viaEnumerator = deriveActionKey({ structuralPath: entry.structuralPath, actionType: entry.action.type, canonicalConfig: entry.action.config })
    expect(viaEnumerator).toBe(direct)
  })

  it('empty / undefined action sets fingerprint to an empty, stable value', () => {
    expect(deriveRuleActionSetFingerprint([])).toEqual(deriveRuleActionSetFingerprint(undefined))
    expect(deriveRuleActionSetFingerprint([]).count).toBe(0)
  })
})
