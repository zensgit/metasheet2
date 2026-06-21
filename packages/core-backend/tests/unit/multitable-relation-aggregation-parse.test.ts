/**
 * 1b Slice A — relation-scoped criteria aggregation: PURE parser/grammar tests.
 *
 * Slice A's first cut is SOLE-CALL only: a formula expression that IS exactly one
 * relation-aggregation call (e.g. RELSUMIF). Composition (`RELSUMIF(...)+1`) is a
 * deferred follow-up and MUST be detected as a fail-loud cliff — never silently
 * mis-evaluated nor a raw #NAME? from the pure engine. These tests pin the grammar
 * + the cliff detector; the permission/aggregation/fan-out behavior is covered by
 * the real-DB goldens.
 */
import { describe, expect, it } from 'vitest'
import {
  parseRelationAggregationCall,
  expressionHasRelationAggregationButNotSole,
} from '../../src/routes/univer-meta'

describe('parseRelationAggregationCall — sole-call grammar', () => {
  it('parses a well-formed RELSUMIF sole call (sum aggregation)', () => {
    const c = parseRelationAggregationCall('RELSUMIF("fld_link", "fld_amt", "fld_status", "is", "paid")')
    expect(c).toEqual({
      fnName: 'RELSUMIF',
      aggregation: 'sum',
      linkFieldId: 'fld_link',
      targetFieldId: 'fld_amt',
      criteria: { fieldId: 'fld_status', operator: 'is', valueExpr: '"paid"' },
    })
  })

  it('preserves a current-record {fld} criteria value verbatim (resolved later against the record)', () => {
    const c = parseRelationAggregationCall('RELSUMIF("fld_link","fld_amt","fld_due","greater",{fld_today})')
    expect(c?.criteria.valueExpr).toBe('{fld_today}')
  })

  it('accepts a bare numeric criteria value', () => {
    const c = parseRelationAggregationCall('RELSUMIF("fld_link","fld_amt","fld_qty","greaterequal",10)')
    expect(c?.criteria).toEqual({ fieldId: 'fld_qty', operator: 'greaterequal', valueExpr: '10' })
  })

  it('tolerates a leading = and surrounding whitespace', () => {
    // caller strips '=' but be defensive on whitespace
    expect(parseRelationAggregationCall('  RELSUMIF("a","b","c","is","x")  ')?.linkFieldId).toBe('a')
  })

  it('returns null for a normal (non-relation-aggregation) formula', () => {
    expect(parseRelationAggregationCall('{fld_a}+{fld_b}')).toBeNull()
    expect(parseRelationAggregationCall('SUM(1,2,3)')).toBeNull()
    expect(parseRelationAggregationCall('IF({fld_a}>0,1,0)')).toBeNull()
  })

  it('returns null on wrong arity or unquoted field ids', () => {
    expect(parseRelationAggregationCall('RELSUMIF("a","b","c","is")')).toBeNull() // 4 args
    expect(parseRelationAggregationCall('RELSUMIF("a","b","c","is","x","y")')).toBeNull() // 6 args
    expect(parseRelationAggregationCall('RELSUMIF(a,b,c,is,x)')).toBeNull() // unquoted ids
  })

  it('returns null when a nested paren appears (outside the Slice A grammar)', () => {
    expect(parseRelationAggregationCall('RELSUMIF("a","b","c","is",SUM(1,2))')).toBeNull()
  })

  it('does not treat a comma inside a quoted value as an arg separator', () => {
    const c = parseRelationAggregationCall('RELSUMIF("a","b","c","is","a,b")')
    expect(c?.criteria.valueExpr).toBe('"a,b"')
  })
})

describe('expressionHasRelationAggregationButNotSole — composition cliff', () => {
  it('false for a sole call (the supported shape)', () => {
    expect(expressionHasRelationAggregationButNotSole('RELSUMIF("a","b","c","is","x")')).toBe(false)
  })
  it('true when the relation aggregation is composed with other operators (deferred → fail loud)', () => {
    expect(expressionHasRelationAggregationButNotSole('RELSUMIF("a","b","c","is","x")+1')).toBe(true)
    expect(expressionHasRelationAggregationButNotSole('IF(RELSUMIF("a","b","c","is","x")>0,1,0)')).toBe(true)
    expect(expressionHasRelationAggregationButNotSole('2*RELSUMIF("a","b","c","is","x")')).toBe(true)
  })
  it('false for a normal formula with no relation aggregation', () => {
    expect(expressionHasRelationAggregationButNotSole('{fld_a}+1')).toBe(false)
    expect(expressionHasRelationAggregationButNotSole('SUM(1,2)')).toBe(false)
  })
})
