/** FWB-3 — decision-value freezing goldens (pure, required lane). Closed field set, epoch semantics. */
import { describe, expect, test } from 'vitest'

import { freezeDecisionValues } from '../../src/multitable/approval-fwb-decision-values'

describe('FWB-3 freezeDecisionValues', () => {
  test('freezes declared values into an immutable epoch-keyed snapshot', () => {
    const r = freezeDecisionValues('node_A', 2, ['amount', 'grade'], { amount: 500, grade: 'A' }, () => new Date(0))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.snapshot).toMatchObject({ nodeKey: 'node_A', entryEpoch: 2, values: { amount: 500, grade: 'A' } })
      expect(Object.isFrozen(r.snapshot)).toBe(true)
      expect(Object.isFrozen(r.snapshot.values)).toBe(true)
      expect(() => {
        ;(r.snapshot.values as Record<string, unknown>).amount = 999
      }).toThrow() // immutable — the frozen value can never drift after the decision
    }
  })

  test('fail-closed: undeclared field, blank node_key, epoch<1, empty declared set all reject', () => {
    expect(freezeDecisionValues('node_A', 1, ['a'], { a: 1, smuggled: true })).toEqual({ ok: false, code: 'undeclared_field' })
    expect(freezeDecisionValues('  ', 1, ['a'], { a: 1 })).toEqual({ ok: false, code: 'node_key_blank' })
    expect(freezeDecisionValues('n', 0, ['a'], { a: 1 })).toEqual({ ok: false, code: 'entry_epoch_invalid' }) // real scope starts at 1
    expect(freezeDecisionValues('n', 1.5, ['a'], { a: 1 })).toEqual({ ok: false, code: 'entry_epoch_invalid' })
    expect(freezeDecisionValues('n', 1, [], { a: 1 })).toEqual({ ok: false, code: 'no_declared_fields' })
  })
})
