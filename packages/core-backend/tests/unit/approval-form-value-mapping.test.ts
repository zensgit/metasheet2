/** FWB-1 slice ① — pure mapping goldens (runs in the required no-DB lane). Fail-closed all-or-nothing. */
import { describe, expect, test } from 'vitest'

import { mapApprovalFormValues, type FwbFieldMapping } from '../../src/multitable/approval-form-value-mapping'

const M = (over: Partial<FwbFieldMapping>): FwbFieldMapping => ({
  formFieldId: 'f1',
  targetFieldId: 't1',
  targetType: 'text',
  ...over,
})

describe('FWB-1 form-value mapping (pure, fail-closed)', () => {
  test('happy path: text/number/date/dateTime/select; numbers stay exact and dateTime becomes UTC', () => {
    const r = mapApprovalFormValues(
      [
        M({ formFieldId: 'a', targetFieldId: 'ta', targetType: 'text' }),
        M({ formFieldId: 'b', targetFieldId: 'tb', targetType: 'number' }),
        M({ formFieldId: 'c', targetFieldId: 'tc', targetType: 'date' }),
        M({ formFieldId: 'd', targetFieldId: 'td', targetType: 'dateTime' }),
        M({ formFieldId: 'e', targetFieldId: 'te', targetType: 'select', selectOptions: ['低', '中', '高'] }),
      ],
      { a: 42, b: '3.5', c: '2026-07-15', d: '2026-07-15T09:30:00+08:00', e: '高' },
    )
    expect(r).toEqual({
      ok: true,
      values: {
        ta: '42',
        tb: '3.5',
        tc: '2026-07-15',
        td: '2026-07-15T01:30:00.000Z',
        te: '高',
      },
    })
  })

  test('ALL-OR-NOTHING: one bad mapping rejects the whole action with per-mapping codes', () => {
    const r = mapApprovalFormValues(
      [
        M({ formFieldId: 'good', targetFieldId: 'tg', targetType: 'text' }),
        M({ formFieldId: 'bad', targetFieldId: 'tb', targetType: 'number' }),
      ],
      { good: 'ok', bad: 'NaN-ish' },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors).toEqual([{ formFieldId: 'bad', targetFieldId: 'tb', code: 'not_a_number' }])
  })

  test('fail-closed vocabulary: select outside options / options missing / unsupported type / object-as-text all reject', () => {
    const cases: Array<[FwbFieldMapping, unknown, string]> = [
      [M({ targetType: 'select', selectOptions: ['a'] }), 'z', 'select_value_not_in_options'],
      [M({ targetType: 'select' }), 'a', 'select_options_missing'],
      [M({ targetType: 'formula' as never }), 'x', 'unsupported_target_type'],
      [M({ targetType: 'text' }), { nested: true }, 'not_text'],
      [M({ targetType: 'date' }), '15/07/2026', 'not_a_date'],
      [M({ targetType: 'dateTime' }), '2026-07-15T09:30:00', 'not_a_datetime'],
      [M({ targetType: 'dateTime' }), '2026-02-30T09:30:00Z', 'not_a_datetime'],
    ]
    for (const [m, v, code] of cases) {
      const r = mapApprovalFormValues([m], { f1: v })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0].code).toBe(code)
    }
  })

  test('missing/blank form values are errors (never silently skipped)', () => {
    for (const v of [undefined, null, '   ']) {
      const r = mapApprovalFormValues([M({})], { f1: v })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors[0].code).toBe('missing_required_value')
    }
  })

  test('rich longText is sanitized while plain text remains byte-for-byte unchanged', () => {
    const hostile = '<p>ok</p><img src=x onerror="alert(1)"><script>alert(2)</script>'
    const rich = mapApprovalFormValues(
      [M({ targetType: 'text', richLongText: true })],
      { f1: hostile },
    )
    expect(rich.ok).toBe(true)
    if (rich.ok) {
      expect(rich.values.t1).toContain('<p>ok</p>')
      expect(rich.values.t1).not.toContain('onerror')
      expect(rich.values.t1).not.toContain('<script')
    }

    const plain = mapApprovalFormValues([M({ targetType: 'text' })], { f1: hostile })
    expect(plain).toEqual({ ok: true, values: { t1: hostile } })
  })
})
