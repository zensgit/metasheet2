/** FWB-3 — decision-value freezing goldens (pure, required lane). Closed field set, epoch semantics. */
import { describe, expect, test } from 'vitest'

import {
  freezeDecisionValues,
  normalizeDecisionFieldValue,
} from '../../src/multitable/approval-fwb-decision-values'

describe('FWB-3 freezeDecisionValues', () => {
  test('freezes declared values into an immutable epoch-keyed snapshot', () => {
    const r = freezeDecisionValues(
      'node_A',
      2,
      ['amount', 'grade'],
      { amount: '500', grade: 'A' },
      () => new Date(0),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.snapshot).toMatchObject({
        nodeKey: 'node_A',
        entryEpoch: 2,
        values: { amount: '500', grade: 'A' },
      })
      expect(Object.isFrozen(r.snapshot)).toBe(true)
      expect(Object.isFrozen(r.snapshot.values)).toBe(true)
      expect(() => {
        ;(r.snapshot.values as Record<string, unknown>).amount = 999
      }).toThrow()
    }
  })

  test('fail-closed: undeclared field, blank node_key, epoch<1, empty declared set all reject', () => {
    expect(freezeDecisionValues('node_A', 1, ['a'], { a: 1, smuggled: true })).toEqual({
      ok: false,
      code: 'undeclared_field',
    })
    expect(freezeDecisionValues('  ', 1, ['a'], { a: 1 })).toEqual({ ok: false, code: 'node_key_blank' })
    expect(freezeDecisionValues('n', 0, ['a'], { a: 1 })).toEqual({ ok: false, code: 'entry_epoch_invalid' })
    expect(freezeDecisionValues('n', 1.5, ['a'], { a: 1 })).toEqual({ ok: false, code: 'entry_epoch_invalid' })
    expect(freezeDecisionValues('n', 1, [], { a: 1 })).toEqual({ ok: false, code: 'no_declared_fields' })
  })

  test('require every declared field exactly once — missing / blank reject', () => {
    expect(freezeDecisionValues('n', 1, ['a', 'b'], { a: 1 })).toEqual({ ok: false, code: 'missing_field' })
    expect(freezeDecisionValues('n', 1, ['a'], { a: '' })).toEqual({ ok: false, code: 'blank_value' })
    expect(freezeDecisionValues('n', 1, ['a'], { a: null })).toEqual({ ok: false, code: 'blank_value' })
    expect(freezeDecisionValues('n', 1, ['a'], {})).toEqual({ ok: false, code: 'missing_field' })
  })

  test('D7/D8: number fields normalize to exact decimal string; invalid date rejects', () => {
    const num = freezeDecisionValues(
      'n',
      1,
      ['amount'],
      { amount: '12.3400' },
      () => new Date(0),
      { amount: { type: 'number', numberPrecision: 4 } },
    )
    expect(num.ok).toBe(true)
    if (num.ok) expect(num.snapshot.values.amount).toBe('12.34')

    const over = freezeDecisionValues(
      'n',
      1,
      ['amount'],
      { amount: '1.234' },
      () => new Date(0),
      { amount: { type: 'number', numberPrecision: 2 } },
    )
    expect(over).toEqual({ ok: false, code: 'invalid_value' })

    const dateOk = freezeDecisionValues(
      'n',
      1,
      ['d'],
      { d: '2026-07-19' },
      () => new Date(0),
      { d: { type: 'date' } },
    )
    expect(dateOk.ok).toBe(true)

    const dateBad = freezeDecisionValues(
      'n',
      1,
      ['d'],
      { d: 'not-a-date' },
      () => new Date(0),
      { d: { type: 'date' } },
    )
    expect(dateBad).toEqual({ ok: false, code: 'invalid_value' })
  })
})

describe('normalizeDecisionFieldValue', () => {
  test('blank / invalid reject; text passthrough', () => {
    expect(normalizeDecisionFieldValue('')).toEqual({ ok: false, code: 'blank_value' })
    expect(normalizeDecisionFieldValue(undefined)).toEqual({ ok: false, code: 'blank_value' })
    expect(normalizeDecisionFieldValue({ x: 1 })).toEqual({ ok: false, code: 'invalid_value' })
    expect(normalizeDecisionFieldValue('ok')).toEqual({ ok: true, value: 'ok' })
  })
})
