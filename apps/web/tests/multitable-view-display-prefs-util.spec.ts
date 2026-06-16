import { describe, expect, it } from 'vitest'
import {
  parseColumnWidths,
  parseRowDensity,
  parseGroupCollapse,
  resolveActiveCollapsedKeys,
  resolveActiveCollapsedKeysForFields,
  mergeColumnWidths,
  mergeRowDensity,
  mergeGroupCollapse,
  DEFAULT_ROW_DENSITY,
} from '../src/multitable/utils/view-display-prefs'

// The grid joins nested composite collapse keys with U+001F (see MetaGridTable GROUP_KEY_SEP).
const SEP = '\u001f'

describe('parseColumnWidths (narrow helper — dirty config never reaches layout math)', () => {
  it('passes a valid record of positive finite numbers', () => {
    expect(parseColumnWidths({ columnWidths: { f1: 100, f2: 240 } })).toEqual({ f1: 100, f2: 240 })
  })
  it('drops non-number / non-finite / non-positive entries', () => {
    expect(parseColumnWidths({ columnWidths: { f1: 100, f2: '240', f3: NaN, f4: Infinity, f5: 0, f6: -10 } })).toEqual({ f1: 100 })
  })
  it('→ {} for missing / non-object / array config', () => {
    expect(parseColumnWidths({})).toEqual({})
    expect(parseColumnWidths({ columnWidths: 'x' })).toEqual({})
    expect(parseColumnWidths({ columnWidths: [1, 2] })).toEqual({})
    expect(parseColumnWidths(null)).toEqual({})
    expect(parseColumnWidths(undefined)).toEqual({})
  })
})

describe('parseRowDensity (union narrow — anything else → default)', () => {
  it('passes the three valid densities', () => {
    expect(parseRowDensity({ rowDensity: 'compact' })).toBe('compact')
    expect(parseRowDensity({ rowDensity: 'normal' })).toBe('normal')
    expect(parseRowDensity({ rowDensity: 'expanded' })).toBe('expanded')
  })
  it('→ default for absent / invalid', () => {
    expect(parseRowDensity({})).toBe(DEFAULT_ROW_DENSITY)
    expect(parseRowDensity({ rowDensity: 'huge' })).toBe(DEFAULT_ROW_DENSITY)
    expect(parseRowDensity({ rowDensity: 3 })).toBe(DEFAULT_ROW_DENSITY)
    expect(parseRowDensity(null)).toBe(DEFAULT_ROW_DENSITY)
    expect(parseRowDensity(undefined)).toBe(DEFAULT_ROW_DENSITY)
  })
  it('DEFAULT_ROW_DENSITY is the pre-arc default', () => {
    expect(DEFAULT_ROW_DENSITY).toBe('normal')
  })
})

describe('parseGroupCollapse (scoped {fieldId, collapsedKeys})', () => {
  it('passes object with string[] collapsedKeys + string fieldId', () => {
    expect(parseGroupCollapse({ groupCollapse: { fieldId: 'fA', collapsedKeys: ['x', 'y'] } }))
      .toEqual({ fieldId: 'fA', collapsedKeys: ['x', 'y'] })
  })
  it('carries collapsedKeys without a fieldId (fieldId undefined)', () => {
    expect(parseGroupCollapse({ groupCollapse: { collapsedKeys: ['x'] } }))
      .toEqual({ fieldId: undefined, collapsedKeys: ['x'] })
  })
  it('empty / non-string fieldId → undefined fieldId', () => {
    expect(parseGroupCollapse({ groupCollapse: { fieldId: '', collapsedKeys: [] } }).fieldId).toBeUndefined()
    expect(parseGroupCollapse({ groupCollapse: { fieldId: 7, collapsedKeys: [] } }).fieldId).toBeUndefined()
  })
  it('→ empty for missing / non-array collapsedKeys / non-string element', () => {
    expect(parseGroupCollapse({})).toEqual({ collapsedKeys: [] })
    expect(parseGroupCollapse({ groupCollapse: { collapsedKeys: 'x' } })).toEqual({ collapsedKeys: [] })
    expect(parseGroupCollapse({ groupCollapse: { collapsedKeys: ['x', 2] } })).toEqual({ collapsedKeys: [] })
    expect(parseGroupCollapse({ groupCollapse: [] })).toEqual({ collapsedKeys: [] })
    expect(parseGroupCollapse(null)).toEqual({ collapsedKeys: [] })
  })
})

describe('resolveActiveCollapsedKeys (stale-key guard)', () => {
  const config = { groupCollapse: { fieldId: 'fA', collapsedKeys: ['x', 'y'] } }
  it('applies the saved keys only when the active groupField matches', () => {
    expect(resolveActiveCollapsedKeys(config, 'fA')).toEqual(['x', 'y'])
  })
  it('ignores a saved set authored on a DIFFERENT field (no wrong collapse after regroup)', () => {
    expect(resolveActiveCollapsedKeys(config, 'fB')).toEqual([])
  })
  it('returns [] when no groupField is active', () => {
    expect(resolveActiveCollapsedKeys(config, null)).toEqual([])
    expect(resolveActiveCollapsedKeys(config, undefined)).toEqual([])
  })
})

describe('merge builders (whole-replace-safe: preserve every sibling key)', () => {
  const existing = {
    frozenLeftColumnIds: ['f1'],
    aggregations: { fld_qty: 'sum' },
    conditionalFormattingRules: [{ id: 'r1' }],
  }
  it('mergeColumnWidths replaces ONLY columnWidths, keeps siblings', () => {
    const next = mergeColumnWidths(existing, { f1: 120 })
    expect(next).toEqual({ ...existing, columnWidths: { f1: 120 } })
    expect(next.frozenLeftColumnIds).toEqual(['f1'])
    expect(next.aggregations).toEqual({ fld_qty: 'sum' })
  })
  it('mergeRowDensity replaces ONLY rowDensity, keeps siblings', () => {
    const next = mergeRowDensity(existing, 'compact')
    expect(next).toEqual({ ...existing, rowDensity: 'compact' })
  })
  it('mergeGroupCollapse replaces ONLY groupCollapse, keeps siblings', () => {
    const next = mergeGroupCollapse(existing, { fieldId: 'fA', collapsedKeys: ['x'] })
    expect(next).toEqual({ ...existing, groupCollapse: { fieldId: 'fA', collapsedKeys: ['x'] } })
  })
  it('merge builders tolerate null/undefined existing config', () => {
    expect(mergeColumnWidths(null, { f1: 1 })).toEqual({ columnWidths: { f1: 1 } })
    expect(mergeRowDensity(undefined, 'expanded')).toEqual({ rowDensity: 'expanded' })
  })
})

describe('parseGroupCollapse (nested: fieldIds[])', () => {
  it('carries a non-empty string[] fieldIds', () => {
    expect(parseGroupCollapse({ groupCollapse: { fieldId: 'fA', fieldIds: ['fA', 'fB'], collapsedKeys: [`x${SEP}y`] } }))
      .toEqual({ fieldId: 'fA', fieldIds: ['fA', 'fB'], collapsedKeys: [`x${SEP}y`] })
  })
  it('omits fieldIds when empty / non-array / non-string element (never returns [])', () => {
    expect(parseGroupCollapse({ groupCollapse: { fieldIds: [], collapsedKeys: ['x'] } }).fieldIds).toBeUndefined()
    expect(parseGroupCollapse({ groupCollapse: { fieldIds: 'fA', collapsedKeys: ['x'] } }).fieldIds).toBeUndefined()
    expect(parseGroupCollapse({ groupCollapse: { fieldIds: ['fA', 2], collapsedKeys: ['x'] } }).fieldIds).toBeUndefined()
    expect(parseGroupCollapse({ groupCollapse: { fieldIds: ['fA', ''], collapsedKeys: ['x'] } }).fieldIds).toBeUndefined()
  })
})

describe('resolveActiveCollapsedKeysForFields (nested ordered-list stale-key guard)', () => {
  const nested = { groupCollapse: { fieldId: 'fA', fieldIds: ['fA', 'fB'], collapsedKeys: [`x${SEP}y`] } }
  it('applies a composite set only on the EXACT same ordered field list', () => {
    expect(resolveActiveCollapsedKeysForFields(nested, ['fA', 'fB'])).toEqual([`x${SEP}y`])
  })
  it('ignores it after a REORDER (same fields, different order)', () => {
    expect(resolveActiveCollapsedKeysForFields(nested, ['fB', 'fA'])).toEqual([])
  })
  it('ignores it when a level changes (different 2nd field)', () => {
    expect(resolveActiveCollapsedKeysForFields(nested, ['fA', 'fC'])).toEqual([])
  })
  it('returns [] when no group fields are active', () => {
    expect(resolveActiveCollapsedKeysForFields(nested, [])).toEqual([])
    expect(resolveActiveCollapsedKeysForFields(nested, null)).toEqual([])
    expect(resolveActiveCollapsedKeysForFields(nested, undefined)).toEqual([])
  })
  it('legacy single-fieldId config applies ONLY to a single-level grouping by that same field', () => {
    const legacy = { groupCollapse: { fieldId: 'fA', collapsedKeys: ['x'] } } // no fieldIds (pre-nested)
    expect(resolveActiveCollapsedKeysForFields(legacy, ['fA'])).toEqual(['x']) // single-level by fA → applies
    expect(resolveActiveCollapsedKeysForFields(legacy, ['fA', 'fB'])).toEqual([]) // now nested → legacy can't apply
    expect(resolveActiveCollapsedKeysForFields(legacy, ['fB'])).toEqual([]) // different field → no
  })
})

describe('composite collapse keys are jsonb-storable (regression: NUL would break the PATCH)', () => {
  // Postgres jsonb REJECTS U+0000 in string values; the grid separator must NOT be NUL. These keys are
  // persisted into view.config.groupCollapse.collapsedKeys (jsonb), so a NUL separator would 500 every
  // nested-collapse write. JSON round-trip is the proxy for storability (only U+0000 is jsonb-forbidden).
  it('the U+001F separator is NOT U+0000', () => {
    expect(SEP).not.toBe('\u0000')
    expect(SEP).toBe('\u001f')
  })
  it('a merged config with a composite key contains NO U+0000 and round-trips through JSON', () => {
    const compositeKey = `todo${SEP}east` // a real 2-level path
    const merged = mergeGroupCollapse({ frozenLeftColumnIds: ['f1'] }, {
      fieldId: 'fld_status',
      fieldIds: ['fld_status', 'fld_region'],
      collapsedKeys: [compositeKey],
    })
    const serialized = JSON.stringify(merged)
    expect(serialized).not.toContain('\u0000') // would make Postgres jsonb throw
    // parse-back fidelity: the composite key survives the wire intact
    const round = JSON.parse(serialized)
    expect(round.groupCollapse.collapsedKeys[0]).toBe(compositeKey)
    expect(round.frozenLeftColumnIds).toEqual(['f1']) // siblings preserved
  })
})
