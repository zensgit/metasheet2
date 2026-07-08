import { describe, expect, it } from 'vitest'
import { findDuplicateFieldKeys, parseOptionSets, serializeOptionSets } from '../../src/utils/optionSetsStructured'

// D2 (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-5, site 5):
// pure-function coverage for the structured<->JSON contract behind
// `IntegrationOptionSetsStructuredEditor.vue`. These are the tests that pin the byte-equivalence
// guarantee ("edit in structured -> serialize to the SAME JSON the textarea would hold, and vice
// versa") without mounting any component.
describe('parseOptionSets', () => {
  it('treats blank/whitespace-only text as an empty, wrapped, zero-row document', () => {
    expect(parseOptionSets('')).toEqual({ ok: true, wrapped: true, rows: [], originalRecord: {} })
    expect(parseOptionSets('   \n ')).toEqual({ ok: true, wrapped: true, rows: [], originalRecord: {} })
  })

  it('structures a wrapped { optionSets: {...} } document', () => {
    const source = { optionSets: { material_type: [{ value: 'plate', label: 'Plate' }] } }
    const text = JSON.stringify(source, null, 2)
    const result = parseOptionSets(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.wrapped).toBe(true)
    expect(result.rows).toEqual([{ fieldKey: 'material_type', options: [{ value: 'plate', label: 'Plate' }] }])
  })

  it('structures a bare { fieldKey: [...] } document (no optionSets wrapper)', () => {
    const source = { material_type: [{ value: 'plate', label: 'Plate' }] }
    const text = JSON.stringify(source, null, 2)
    const result = parseOptionSets(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.wrapped).toBe(false)
    expect(result.rows).toEqual([{ fieldKey: 'material_type', options: [{ value: 'plate', label: 'Plate' }] }])
  })

  it('preserves multiple field rows in source order', () => {
    const source = {
      optionSets: {
        material_type: [{ value: 'plate', label: 'Plate' }],
        blank_type: [{ value: 'casting', label: 'Casting' }],
      },
    }
    const result = parseOptionSets(JSON.stringify(source, null, 2))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows.map((r) => r.fieldKey)).toEqual(['material_type', 'blank_type'])
  })

  it('preserves unmodeled extra option keys (e.g. actionBindings) and their key order', () => {
    const source = {
      optionSets: {
        stock_preparation_status: [
          { value: 'pending', label: 'Pending', actionBindings: [{ actionId: 'plm.stock-preparation.pull-bom.v1' }] },
        ],
      },
    }
    const result = parseOptionSets(JSON.stringify(source, null, 2))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows[0].options[0]).toEqual(source.optionSets.stock_preparation_status[0])
    expect(Object.keys(result.rows[0].options[0])).toEqual(['value', 'label', 'actionBindings'])
  })

  it('rejects invalid JSON', () => {
    expect(parseOptionSets('{ not valid')).toEqual({ ok: false })
  })

  it('rejects a non-object top-level document', () => {
    expect(parseOptionSets('[1,2,3]')).toEqual({ ok: false })
    expect(parseOptionSets('"a string"')).toEqual({ ok: false })
    expect(parseOptionSets('42')).toEqual({ ok: false })
  })

  it('rejects the legacy optionSources/configInfo alias shape (a different data model)', () => {
    expect(parseOptionSets(JSON.stringify({ optionSources: [], configInfo: {} }))).toEqual({ ok: false })
    expect(parseOptionSets(JSON.stringify({ optionSets: {}, configInfo: {} }))).toEqual({ ok: false })
  })

  it('rejects a field whose value is not an array', () => {
    expect(parseOptionSets(JSON.stringify({ optionSets: { material_type: 'not-an-array' } }))).toEqual({ ok: false })
  })

  it('rejects an option entry missing value or label', () => {
    expect(parseOptionSets(JSON.stringify({ optionSets: { material_type: [{ value: 'plate' }] } }))).toEqual({ ok: false })
    expect(parseOptionSets(JSON.stringify({ optionSets: { material_type: [{ label: 'Plate' }] } }))).toEqual({ ok: false })
    expect(parseOptionSets(JSON.stringify({ optionSets: { material_type: ['plate'] } }))).toEqual({ ok: false })
  })

  it('rejects non-string value/label (closed shape is strict about types)', () => {
    expect(parseOptionSets(JSON.stringify({ optionSets: { material_type: [{ value: 1, label: 'Plate' }] } }))).toEqual({ ok: false })
  })
})

describe('serializeOptionSets', () => {
  it('is byte-identical to the raw textarea path for a fresh document (structured -> JSON)', () => {
    const rows = [{ fieldKey: 'material_type', options: [{ value: 'plate', label: 'Plate' }] }]
    const result = serializeOptionSets(rows, true, {})
    // What a user directly typing the same shape into the raw textarea would produce.
    const expected = JSON.stringify({ optionSets: { material_type: [{ value: 'plate', label: 'Plate' }] } }, null, 2)
    expect(result).toBe(expected)
  })

  it('round-trips a wrapped document with zero edits (idempotent, canonical formatting)', () => {
    const source = { optionSets: { material_type: [{ value: 'plate', label: 'Plate' }] } }
    const text = JSON.stringify(source, null, 2)
    const parsed = parseOptionSets(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(serializeOptionSets(parsed.rows, parsed.wrapped, parsed.originalRecord)).toBe(text)
  })

  it('round-trips a bare document with zero edits', () => {
    const source = { material_type: [{ value: 'plate', label: 'Plate' }], blank_type: [{ value: 'casting', label: 'Casting' }] }
    const text = JSON.stringify(source, null, 2)
    const parsed = parseOptionSets(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(serializeOptionSets(parsed.rows, parsed.wrapped, parsed.originalRecord)).toBe(text)
  })

  it('preserves sibling top-level keys AND their original relative order around optionSets', () => {
    // `optionSets` sits BETWEEN two sibling keys in the source — a naive `{ ...extra, optionSets }`
    // rebuild that always appends `optionSets` last would silently reorder this on a zero-edit
    // round trip. Pin the correct behavior: JS object-literal semantics keep a duplicate key's
    // FIRST position (the spread's) and only update its value.
    const source = { alpha: 1, optionSets: { material_type: [{ value: 'plate', label: 'Plate' }] }, zeta: 2 }
    const text = JSON.stringify(source, null, 2)
    const parsed = parseOptionSets(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(serializeOptionSets(parsed.rows, parsed.wrapped, parsed.originalRecord)).toBe(text)
    expect(Object.keys(JSON.parse(serializeOptionSets(parsed.rows, parsed.wrapped, parsed.originalRecord)))).toEqual(['alpha', 'optionSets', 'zeta'])
  })

  it('reflects row edits (add field / add option / rename) in the serialized JSON', () => {
    const rows = [
      { fieldKey: 'material_type', options: [{ value: 'plate', label: 'Plate' }, { value: 'bar', label: 'Bar' }] },
      { fieldKey: 'blank_type', options: [{ value: 'casting', label: 'Casting' }] },
    ]
    const result = serializeOptionSets(rows, true, {})
    expect(JSON.parse(result)).toEqual({
      optionSets: {
        material_type: [{ value: 'plate', label: 'Plate' }, { value: 'bar', label: 'Bar' }],
        blank_type: [{ value: 'casting', label: 'Casting' }],
      },
    })
  })

  it('produces a minimal wrapped document for zero rows ({ "optionSets": {} })', () => {
    expect(serializeOptionSets([], true, {})).toBe('{\n  "optionSets": {}\n}')
  })
})

describe('findDuplicateFieldKeys', () => {
  it('returns an empty list when all field keys are unique', () => {
    expect(findDuplicateFieldKeys([
      { fieldKey: 'a', options: [] },
      { fieldKey: 'b', options: [] },
    ])).toEqual([])
  })

  it('flags a field key that appears on more than one row', () => {
    expect(findDuplicateFieldKeys([
      { fieldKey: 'a', options: [] },
      { fieldKey: 'a', options: [] },
      { fieldKey: 'b', options: [] },
    ])).toEqual(['a'])
  })

  it('SENTINEL: duplicate-key detection never echoes option value/label content, only structural facts', () => {
    const secret = 'sk-SECRET-TOKEN-do-not-leak-9f8e7d6c5b4a'
    const duplicates = findDuplicateFieldKeys([
      { fieldKey: 'a', options: [{ value: secret, label: secret }] },
      { fieldKey: 'a', options: [{ value: secret, label: secret }] },
    ])
    expect(duplicates).toEqual(['a'])
    expect(JSON.stringify(duplicates)).not.toContain(secret)
  })
})
