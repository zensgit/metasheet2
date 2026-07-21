/**
 * FWB-1 — `resolveFwbRuntimeMappings` execute-time target-field recheck (no-DB lane, stubbed query).
 *
 * Contract (FWB0 §5 「字段类型 fire 时复验」 + D6/D7): the saved mapping's metadata is NEVER trusted at
 * execute time — select option membership and number precision are re-derived from the CURRENT
 * meta_fields rows inside the transaction, and every staleness shape fails CLOSED before
 * `mapApprovalFormValues` runs.
 *
 * MUTATION NOTES (discriminating assertions):
 *   - stale saved selectOptions containing the REMOVED option must NOT admit it: kills the mutant that
 *     keeps consulting the saved mapping's option set (the exact bug this seam exists to close).
 *   - an option ADDED after save remains unauthorized until the mapping is re-confirmed; the real-DB
 *     suite carries the re-save positive control so this does not degenerate into "reject everything".
 *   - property.options absent / unparseable-string / empty → fail closed: kills mutants that treat a
 *     missing option set as an open vocabulary (D6).
 *   - field row missing / type changed → fail closed: kills mutants that skip the count or type check.
 *   - numberPrecision comes from property.decimals only: kills the mutant that invents a second
 *     `precision` spelling (which would silently drop the execute-time cap, §11 Q5).
 *   - failure shape carries NO field values/options — identifiers-free, values-free.
 */
import { describe, expect, test } from 'vitest'

import { resolveFwbRuntimeMappings } from '../../src/multitable/approval-fwb-write-action'
import type { FwbFieldMapping } from '../../src/multitable/approval-form-value-mapping'

type Row = { id: string; type: string; property?: unknown }

const stubQuery = (rows: Row[]) => {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const query = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    expect(sql).toContain('FOR SHARE') // the recheck must hold the rows for the whole transaction
    return { rows: rows as unknown[] }
  }
  return { query, calls }
}

const M = (over: Partial<FwbFieldMapping>): FwbFieldMapping => ({
  formFieldId: 'f1',
  targetFieldId: 't1',
  targetType: 'select',
  ...over,
})

describe('resolveFwbRuntimeMappings — execute-time target-field recheck (fail closed)', () => {
  test('select mappings use confirmed-current intersection; added and removed options cannot bypass confirmation', async () => {
    const { query } = stubQuery([
      { id: 't1', type: 'select', property: JSON.stringify({ options: [{ value: '中' }, { value: '新' }] }) },
    ])
    const r = await resolveFwbRuntimeMappings(query, 'sheet1', [
      M({ selectOptions: ['低', '中', '高'] }), // saved set is stale — the field dropped '低'
    ])
    expect(r).toEqual({
      ok: true,
      // '新' exists now but was never confirmed; '低'/'高' were confirmed but no longer exist.
      mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'select', selectOptions: ['中'] }],
    })
  })

  test('fails closed when select field options are absent, unparseable, or empty (D6: no open vocabulary)', async () => {
    for (const property of [
      '{}', // options absent
      '{broken json', // unparseable
      JSON.stringify({ options: [] }), // empty
      JSON.stringify({ options: [{ name: 'no value key' }, 42, null] }), // no usable option values
    ]) {
      const { query } = stubQuery([{ id: 't1', type: 'select', property }])
      const r = await resolveFwbRuntimeMappings(query, 'sheet1', [M({ selectOptions: ['a'] })])
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.code).toBe('mapping_target_changed')
        expect(JSON.stringify(r)).not.toContain('no value key') // values-free failure
      }
    }
  })

  test('fails closed when a target field row is missing or its type changed since save', async () => {
    // missing row
    const missing = stubQuery([])
    expect(await resolveFwbRuntimeMappings(missing.query, 'sheet1', [M({ selectOptions: ['a'] })]))
      .toEqual({ ok: false, code: 'mapping_target_changed' })
    // type changed select → text
    const retyped = stubQuery([{ id: 't1', type: 'text', property: '{}' }])
    expect(await resolveFwbRuntimeMappings(retyped.query, 'sheet1', [M({ selectOptions: ['a'] })]))
      .toEqual({ ok: false, code: 'mapping_target_changed' })
  })

  test('number mappings attach numberPrecision from canonical property.decimals, including numeric strings', async () => {
    const { query } = stubQuery([
      { id: 't1', type: 'number', property: { decimals: '2', precision: 99 } },
      { id: 't2', type: 'number', property: '{}' },
    ])
    const r = await resolveFwbRuntimeMappings(query, 'sheet1', [
      M({ targetFieldId: 't1', targetType: 'number' }),
      M({ targetFieldId: 't2', targetType: 'number' }),
    ])
    expect(r).toEqual({
      ok: true,
      mappings: [
        { formFieldId: 'f1', targetFieldId: 't1', targetType: 'number', numberPrecision: 2 },
        { formFieldId: 'f1', targetFieldId: 't2', targetType: 'number' },
      ],
    })
  })

  test('number precision: current field metadata REPLACES saved numberPrecision — tightening applies, removal removes', async () => {
    // tightening: saved cap 5, field tightened to 1 after save → current 1 caps the execution (§11 Q5).
    const tightened = stubQuery([{ id: 't1', type: 'number', property: { decimals: 1 } }])
    expect(await resolveFwbRuntimeMappings(tightened.query, 'sheet1', [
      M({ targetFieldId: 't1', targetType: 'number', numberPrecision: 5 }),
    ])).toEqual({
      ok: true,
      mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'number', numberPrecision: 1 }],
    })
    // removal: saved cap 5, field cap REMOVED after save → the stale saved cap must NOT survive
    // (kills the mutant that spreads `...mapping` and keeps saved numberPrecision).
    const removed = stubQuery([{ id: 't1', type: 'number', property: '{}' }])
    expect(await resolveFwbRuntimeMappings(removed.query, 'sheet1', [
      M({ targetFieldId: 't1', targetType: 'number', numberPrecision: 5 }),
    ])).toEqual({
      ok: true,
      mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'number' }],
    })
  })

  test('number precision fails closed when present metadata cannot be canonicalized', async () => {
    for (const property of [
      { decimals: 'not-a-number' },
      { decimals: true },
      { decimals: null },
      { decimals: '' },
      { decimals: [] },
      { decimals: [2] },
      { decimals: '0x2' },
      { decimals: '1e2' },
      { decimals: -1 },
      { decimals: 7 },
      '{broken json',
    ]) {
      const invalid = stubQuery([{ id: 't1', type: 'number', property }])
      expect(await resolveFwbRuntimeMappings(invalid.query, 'sheet1', [
        M({ targetFieldId: 't1', targetType: 'number', numberPrecision: 5 }),
      ])).toEqual({ ok: false, code: 'mapping_target_changed' })
    }

    // The platform canonicalizer rounds a fractional field-property value at write time; preserve
    // that established metadata contract instead of inventing a second precision parser here.
    const fractional = stubQuery([{ id: 't1', type: 'number', property: { decimals: 1.6 } }])
    expect(await resolveFwbRuntimeMappings(fractional.query, 'sheet1', [
      M({ targetFieldId: 't1', targetType: 'number' }),
    ])).toEqual({
      ok: true,
      mappings: [{ formFieldId: 'f1', targetFieldId: 't1', targetType: 'number', numberPrecision: 2 }],
    })
  })

  test('text/date mappings pass through unchanged once existence + type are verified', async () => {
    const { query } = stubQuery([
      { id: 't1', type: 'string', property: '{}' },
      { id: 't2', type: 'date', property: '{}' },
    ])
    const r = await resolveFwbRuntimeMappings(query, 'sheet1', [
      M({ targetFieldId: 't1', targetType: 'text' }),
      M({ targetFieldId: 't2', targetType: 'date' }),
    ])
    expect(r).toEqual({
      ok: true,
      mappings: [
        { formFieldId: 'f1', targetFieldId: 't1', targetType: 'text' },
        { formFieldId: 'f1', targetFieldId: 't2', targetType: 'date' },
      ],
    })
  })
})
