import { describe, expect, it } from 'vitest'
import {
  parseColumnWidths,
  parseRowDensity,
  parseGroupCollapse,
  resolveActiveCollapsedKeys,
  mergeColumnWidths,
  mergeRowDensity,
  mergeGroupCollapse,
  DEFAULT_ROW_DENSITY,
} from '../src/multitable/utils/view-display-prefs'

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
