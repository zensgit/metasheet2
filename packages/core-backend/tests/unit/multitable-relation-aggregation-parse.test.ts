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
      kind: 'aggregation',
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

  it('A.3 — parses RELAVGIF (avg) with the same 5-arg signature as RELSUMIF', () => {
    expect(parseRelationAggregationCall('RELAVGIF("fld_link","fld_amt","fld_status","is","paid")')).toEqual({
      fnName: 'RELAVGIF', kind: 'aggregation', aggregation: 'avg', linkFieldId: 'fld_link', targetFieldId: 'fld_amt',
      criteria: { fieldId: 'fld_status', operator: 'is', valueExpr: '"paid"' },
    })
  })

  it('A.3 — parses RELCOUNTIF (countall, 4-arg, no sum target → targetFieldId = criteria for the readability gate)', () => {
    expect(parseRelationAggregationCall('RELCOUNTIF("fld_link","fld_status","is","paid")')).toEqual({
      fnName: 'RELCOUNTIF', kind: 'aggregation', aggregation: 'countall', linkFieldId: 'fld_link', targetFieldId: 'fld_status',
      criteria: { fieldId: 'fld_status', operator: 'is', valueExpr: '"paid"' },
    })
  })

  it('B — parses RELLOOKUP (kind=lookup, 5-arg: link, returnField→target, matchField→criteria, op, value)', () => {
    expect(parseRelationAggregationCall('RELLOOKUP("fld_link","fld_name","fld_status","is","paid")')).toEqual({
      fnName: 'RELLOOKUP', kind: 'lookup', aggregation: null, linkFieldId: 'fld_link', targetFieldId: 'fld_name',
      criteria: { fieldId: 'fld_status', operator: 'is', valueExpr: '"paid"' },
    })
    expect(parseRelationAggregationCall('RELLOOKUP("a","b","c","is")')).toBeNull() // 4 args → null (lookup is 5-arg)
  })

  it('C — parses RELVALUES (kind=array, 5-arg) — same shape, array-return (aggregation null)', () => {
    expect(parseRelationAggregationCall('RELVALUES("fld_link","fld_amt","fld_status","is","paid")')).toEqual({
      fnName: 'RELVALUES', kind: 'array', aggregation: null, linkFieldId: 'fld_link', targetFieldId: 'fld_amt',
      criteria: { fieldId: 'fld_status', operator: 'is', valueExpr: '"paid"' },
    })
    expect(parseRelationAggregationCall('RELVALUES("a","b","c","is")')).toBeNull() // 4 args → null (array is 5-arg)
  })

  it('A.3 — per-function arity: RELCOUNTIF needs 4 (5→null); RELAVGIF/RELSUMIF need 5 (4→null)', () => {
    expect(parseRelationAggregationCall('RELCOUNTIF("a","b","c","is","x")')).toBeNull() // 5 args → not COUNTIF
    expect(parseRelationAggregationCall('RELAVGIF("a","b","c","is")')).toBeNull() // 4 args → not AVGIF
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
