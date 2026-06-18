/**
 * 2b-S1 — pure conditional-rule parser/evaluator unit matrix.
 *
 * Covers: parser author-time rejection; every (field type x allowed operator) positive + negative;
 * the FAIL-CLOSED paths (missing field, deleted field, operator-not-allowed-for-type, malformed value,
 * thrown predicate -> DENIED); OR-combination; and the no-value-leak reason invariant.
 */
import { describe, expect, test } from 'vitest'

import {
  evaluateRecordDenied,
  parseConditionalRules,
  type ConditionalRule,
  type FieldMeta,
} from '../../src/multitable/permission-rule-evaluator'

const fields = (...defs: Array<[string, string]>): Record<string, FieldMeta> =>
  Object.fromEntries(defs.map(([id, type]) => [id, { id, type }]))

const rule = (over: Partial<ConditionalRule> & Pick<ConditionalRule, 'fieldId' | 'operator'>): ConditionalRule => ({
  id: over.id ?? 'r1',
  effect: 'deny_read',
  value: over.value,
  ...over,
})

const rec = (data: Record<string, unknown>) => ({ data })

describe('parseConditionalRules — author-time rejection', () => {
  test('valid rule parses', () => {
    const { rules, rejected } = parseConditionalRules([{ id: 'a', fieldId: 'f1', operator: 'eq', value: 'x', effect: 'deny_read' }])
    expect(rules).toHaveLength(1)
    expect(rejected).toHaveLength(0)
    expect(rules[0]).toMatchObject({ id: 'a', fieldId: 'f1', operator: 'eq', effect: 'deny_read' })
  })

  test.each([
    ['not an object', 5],
    ['null entry', null],
    ['array entry', []],
    ['missing id', { fieldId: 'f1', operator: 'eq', effect: 'deny_read' }],
    ['missing fieldId', { id: 'a', operator: 'eq', effect: 'deny_read' }],
    ['unsupported effect', { id: 'a', fieldId: 'f1', operator: 'eq', effect: 'allow_read' }],
    ['unknown operator', { id: 'a', fieldId: 'f1', operator: 'regex', effect: 'deny_read' }],
  ])('rejects %s', (_label, bad) => {
    const { rules, rejected } = parseConditionalRules([bad])
    expect(rules).toHaveLength(0)
    expect(rejected).toHaveLength(1)
  })

  test('non-array payload rejected (null is a no-op, not an error)', () => {
    expect(parseConditionalRules(null).rejected).toHaveLength(0)
    expect(parseConditionalRules({ id: 'a' }).rejected).toHaveLength(1)
  })

  test('id and fieldId are trimmed', () => {
    const { rules } = parseConditionalRules([{ id: '  a  ', fieldId: '  f1 ', operator: 'eq', value: 1, effect: 'deny_read' }])
    expect(rules[0]).toMatchObject({ id: 'a', fieldId: 'f1' })
  })
})

describe('evaluator — text/select operators', () => {
  const f = fields(['f1', 'select'])
  test('eq matches -> denied', () => {
    expect(evaluateRecordDenied(rec({ f1: 'secret' }), [rule({ fieldId: 'f1', operator: 'eq', value: 'secret' })], f).denied).toBe(true)
  })
  test('eq no match -> not denied', () => {
    expect(evaluateRecordDenied(rec({ f1: 'public' }), [rule({ fieldId: 'f1', operator: 'eq', value: 'secret' })], f).denied).toBe(false)
  })
  test('neq matches -> denied', () => {
    expect(evaluateRecordDenied(rec({ f1: 'public' }), [rule({ fieldId: 'f1', operator: 'neq', value: 'secret' })], f).denied).toBe(true)
  })
  test('contains', () => {
    expect(evaluateRecordDenied(rec({ f1: 'top secret memo' }), [rule({ fieldId: 'f1', operator: 'contains', value: 'secret' })], f).denied).toBe(true)
    expect(evaluateRecordDenied(rec({ f1: 'public memo' }), [rule({ fieldId: 'f1', operator: 'contains', value: 'secret' })], f).denied).toBe(false)
  })
  test('isEmpty / isNotEmpty', () => {
    expect(evaluateRecordDenied(rec({ f1: '' }), [rule({ fieldId: 'f1', operator: 'isEmpty' })], f).denied).toBe(true)
    expect(evaluateRecordDenied(rec({}), [rule({ fieldId: 'f1', operator: 'isEmpty' })], f).denied).toBe(true)
    expect(evaluateRecordDenied(rec({ f1: 'x' }), [rule({ fieldId: 'f1', operator: 'isNotEmpty' })], f).denied).toBe(true)
    expect(evaluateRecordDenied(rec({ f1: 'x' }), [rule({ fieldId: 'f1', operator: 'isEmpty' })], f).denied).toBe(false)
  })
})

describe('evaluator — number operators', () => {
  const f = fields(['n', 'number'])
  test.each([
    ['gt', 5, 3, true],
    ['gt', 2, 3, false],
    ['lt', 2, 3, true],
    ['gte', 3, 3, true],
    ['lte', 3, 3, true],
    ['eq', 3, 3, true],
    ['neq', 4, 3, true],
  ] as Array<[string, number, number, boolean]>)('%s(%d,%d) -> %s', (op, recVal, ruleVal, expected) => {
    expect(evaluateRecordDenied(rec({ n: recVal }), [rule({ fieldId: 'n', operator: op as ConditionalRule['operator'], value: ruleVal })], f).denied).toBe(expected)
  })
})

describe('evaluator — boolean / date / array operators', () => {
  test('boolean eq', () => {
    const f = fields(['b', 'boolean'])
    expect(evaluateRecordDenied(rec({ b: true }), [rule({ fieldId: 'b', operator: 'eq', value: true })], f).denied).toBe(true)
    expect(evaluateRecordDenied(rec({ b: false }), [rule({ fieldId: 'b', operator: 'eq', value: true })], f).denied).toBe(false)
  })
  test('date before / after', () => {
    const f = fields(['d', 'date'])
    expect(evaluateRecordDenied(rec({ d: '2026-01-01' }), [rule({ fieldId: 'd', operator: 'before', value: '2026-06-01' })], f).denied).toBe(true)
    expect(evaluateRecordDenied(rec({ d: '2026-12-01' }), [rule({ fieldId: 'd', operator: 'before', value: '2026-06-01' })], f).denied).toBe(false)
    expect(evaluateRecordDenied(rec({ d: '2026-12-01' }), [rule({ fieldId: 'd', operator: 'after', value: '2026-06-01' })], f).denied).toBe(true)
  })
  test('multiSelect / person hasAny / hasNone', () => {
    const f = fields(['m', 'multiSelect'], ['p', 'person'])
    expect(evaluateRecordDenied(rec({ m: ['a', 'b'] }), [rule({ fieldId: 'm', operator: 'hasAny', value: ['b', 'c'] })], f).denied).toBe(true)
    expect(evaluateRecordDenied(rec({ m: ['a'] }), [rule({ fieldId: 'm', operator: 'hasAny', value: ['b', 'c'] })], f).denied).toBe(false)
    expect(evaluateRecordDenied(rec({ p: ['u1'] }), [rule({ fieldId: 'p', operator: 'hasNone', value: ['u2'] })], f).denied).toBe(true)
    expect(evaluateRecordDenied(rec({ p: ['u2'] }), [rule({ fieldId: 'p', operator: 'hasNone', value: ['u2'] })], f).denied).toBe(false)
  })
})

describe('FAIL-CLOSED — un-evaluable rules DENY (never fail open)', () => {
  test('missing field -> denied', () => {
    expect(evaluateRecordDenied(rec({ f1: 'x' }), [rule({ fieldId: 'GONE', operator: 'eq', value: 'x' })], fields(['f1', 'select'])).denied).toBe(true)
  })
  test('deleted field -> denied', () => {
    const f: Record<string, FieldMeta> = { f1: { id: 'f1', type: 'select', deleted: true } }
    expect(evaluateRecordDenied(rec({ f1: 'public' }), [rule({ fieldId: 'f1', operator: 'eq', value: 'secret' })], f).denied).toBe(true)
  })
  test('operator not allowed for field type -> denied (gt on a select)', () => {
    expect(evaluateRecordDenied(rec({ f1: 'x' }), [rule({ fieldId: 'f1', operator: 'gt', value: 1 })], fields(['f1', 'select'])).denied).toBe(true)
  })
  test('malformed value: gt with a non-number record value -> denied', () => {
    expect(evaluateRecordDenied(rec({ n: 'not-a-number' }), [rule({ fieldId: 'n', operator: 'gt', value: 1 })], fields(['n', 'number'])).denied).toBe(true)
  })
  test('malformed value: contains where record value is not a string -> denied', () => {
    expect(evaluateRecordDenied(rec({ f1: 123 }), [rule({ fieldId: 'f1', operator: 'contains', value: 'x' })], fields(['f1', 'select'])).denied).toBe(true)
  })
  test('malformed value: hasAny where rule value is not an array -> denied', () => {
    expect(evaluateRecordDenied(rec({ m: ['a'] }), [rule({ fieldId: 'm', operator: 'hasAny', value: 'a' })], fields(['m', 'multiSelect'])).denied).toBe(true)
  })
  test('malformed value: before with an unparseable date -> denied', () => {
    expect(evaluateRecordDenied(rec({ d: 'garbage' }), [rule({ fieldId: 'd', operator: 'before', value: '2026-06-01' })], fields(['d', 'date'])).denied).toBe(true)
  })
  test('unknown field type (no operators) -> denied', () => {
    expect(evaluateRecordDenied(rec({ x: 'v' }), [rule({ fieldId: 'x', operator: 'eq', value: 'v' })], fields(['x', 'formula'])).denied).toBe(true)
  })
})

describe('OR-combination + no-leak reason', () => {
  test('any matching rule denies (OR)', () => {
    const f = fields(['a', 'select'], ['b', 'number'])
    const rules = [rule({ id: 'r-a', fieldId: 'a', operator: 'eq', value: 'no' }), rule({ id: 'r-b', fieldId: 'b', operator: 'gt', value: 10 })]
    expect(evaluateRecordDenied(rec({ a: 'yes', b: 99 }), rules, f).denied).toBe(true) // second rule matches
  })
  test('no rule matches -> not denied', () => {
    const f = fields(['a', 'select'])
    expect(evaluateRecordDenied(rec({ a: 'yes' }), [rule({ id: 'r-a', fieldId: 'a', operator: 'eq', value: 'no' })], f).denied).toBe(false)
  })
  test('reason carries only the rule id, never the record value', () => {
    const f = fields(['a', 'select'])
    const res = evaluateRecordDenied(rec({ a: 'SUPER_SECRET_VALUE' }), [rule({ id: 'r-leak', fieldId: 'a', operator: 'isNotEmpty' })], f)
    expect(res.denied).toBe(true)
    expect(res.reason).toBe('rule:r-leak')
    expect(res.reason).not.toContain('SUPER_SECRET_VALUE')
  })
  test('empty rule set -> not denied', () => {
    expect(evaluateRecordDenied(rec({ a: 'x' }), [], fields(['a', 'select'])).denied).toBe(false)
  })
})
