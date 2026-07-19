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
    if (num.ok) {
      expect(num.snapshot.values.amount).toBe('12.34')
      expect(typeof num.snapshot.values.amount).toBe('string')
    }

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

    // Strict real calendar dates — Feb 30 rejects.
    const dateFake = freezeDecisionValues(
      'n',
      1,
      ['d'],
      { d: '2026-02-30' },
      () => new Date(0),
      { d: { type: 'date' } },
    )
    expect(dateFake).toEqual({ ok: false, code: 'invalid_value' })
  })

  test('select validates against authoritative template options', () => {
    const ok = freezeDecisionValues(
      'n',
      1,
      ['grade'],
      { grade: 'A' },
      () => new Date(0),
      { grade: { type: 'select', selectOptions: ['A', 'B'] } },
    )
    expect(ok.ok).toBe(true)

    const bad = freezeDecisionValues(
      'n',
      1,
      ['grade'],
      { grade: 'Z' },
      () => new Date(0),
      { grade: { type: 'select', selectOptions: ['A', 'B'] } },
    )
    expect(bad).toEqual({ ok: false, code: 'invalid_value' })

    const noOpts = freezeDecisionValues(
      'n',
      1,
      ['grade'],
      { grade: 'A' },
      () => new Date(0),
      { grade: { type: 'select' } },
    )
    expect(noOpts).toEqual({ ok: false, code: 'invalid_value' })
  })

  test('datetime requires explicit Z/offset and canonicalizes to UTC ISO', () => {
    const withZ = freezeDecisionValues(
      'n',
      1,
      ['t'],
      { t: '2026-07-19T08:30:00.000Z' },
      () => new Date(0),
      { t: { type: 'datetime' } },
    )
    expect(withZ.ok).toBe(true)
    if (withZ.ok) expect(withZ.snapshot.values.t).toBe('2026-07-19T08:30:00.000Z')

    const withOffset = freezeDecisionValues(
      'n',
      1,
      ['t'],
      { t: '2026-07-19T16:30:00+08:00' },
      () => new Date(0),
      { t: { type: 'datetime' } },
    )
    expect(withOffset.ok).toBe(true)
    if (withOffset.ok) expect(withOffset.snapshot.values.t).toBe('2026-07-19T08:30:00.000Z')

    // Bare local datetime (no Z/offset) — never guess host timezone.
    const bare = freezeDecisionValues(
      'n',
      1,
      ['t'],
      { t: '2026-07-19T08:30:00' },
      () => new Date(0),
      { t: { type: 'datetime' } },
    )
    expect(bare).toEqual({ ok: false, code: 'invalid_value' })
  })
})

describe('normalizeDecisionFieldValue', () => {
  test('blank / invalid reject; text passthrough', () => {
    expect(normalizeDecisionFieldValue('')).toEqual({ ok: false, code: 'blank_value' })
    expect(normalizeDecisionFieldValue(undefined)).toEqual({ ok: false, code: 'blank_value' })
    expect(normalizeDecisionFieldValue({ x: 1 })).toEqual({ ok: false, code: 'invalid_value' })
    expect(normalizeDecisionFieldValue('ok')).toEqual({ ok: true, value: 'ok' })
  })

  test('number always freezes as string (never JS Number)', () => {
    const r = normalizeDecisionFieldValue(42, { type: 'number' })
    expect(r).toEqual({ ok: true, value: '42' })
    if (r.ok) expect(typeof r.value).toBe('string')
  })
})
