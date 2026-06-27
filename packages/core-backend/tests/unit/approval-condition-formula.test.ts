import { describe, expect, it } from 'vitest'
import {
  APPROVAL_CONDITION_FORMULA_LIMITS,
  assertApprovalConditionFormulaValidForSchema,
  evaluateApprovalConditionFormula,
  parseApprovalConditionFormula,
} from '../../src/services/ApprovalConditionFormula'
import type { FormSchema } from '../../src/types/approval-product'

const schema: FormSchema = {
  fields: [
    { id: 'amount', type: 'number', label: 'Amount' },
    { id: 'expense_type', type: 'select', label: 'Expense Type', options: [{ label: 'Travel', value: 'travel' }] },
    { id: 'receipt', type: 'attachment', label: 'Receipt' },
    { id: 'items', type: 'detail', label: 'Items', columns: [
      { id: 'amount', type: 'number', label: 'Line Amount' },
      { id: 'memo', type: 'text', label: 'Memo' },
    ] },
  ],
}

describe('approval condition formula evaluator (FC-1)', () => {
  it('evaluates boolean formulas with detail aggregates and AND/OR/NOT', () => {
    const formData = {
      amount: 12000,
      expense_type: 'travel',
      items: [{ amount: 5000 }, { amount: 7000 }],
    }

    expect(evaluateApprovalConditionFormula(
      'SUM({items.amount}) >= 10000 AND {expense_type} == "travel"',
      formData,
    )).toBe(true)
    expect(evaluateApprovalConditionFormula(
      'COUNT({items}) > 1 AND NOT ({amount} < 10000)',
      formData,
    )).toBe(true)
    expect(evaluateApprovalConditionFormula(
      'SUM({items.amount}) >= 20000 OR {expense_type} == "office"',
      formData,
    )).toBe(false)
  })

  it('validates schema references and requires a boolean result', () => {
    expect(() => assertApprovalConditionFormulaValidForSchema('SUM({items.amount}) >= 10000', schema)).not.toThrow()
    expect(() => assertApprovalConditionFormulaValidForSchema('{missing} == 1', schema)).toThrow(/unknown field/)
    expect(() => assertApprovalConditionFormulaValidForSchema('{items.amount} >= 1', schema)).toThrow(/inside an aggregate/)
    expect(() => assertApprovalConditionFormulaValidForSchema('SUM({items.memo}) >= 1', schema)).toThrow(/numeric detail sub-field/)
    expect(() => assertApprovalConditionFormulaValidForSchema('SUM({items.amount})', schema)).toThrow(/must return boolean/)
    expect(() => assertApprovalConditionFormulaValidForSchema('{receipt} == "yes"', schema)).toThrow(/not supported/)
  })

  it('fails closed on unsafe numeric states and malformed runtime aggregates', () => {
    expect(() => evaluateApprovalConditionFormula('10 / {amount} > 1', { amount: 0 })).toThrow(/division by zero/)
    expect(() => evaluateApprovalConditionFormula('{amount} == null', {})).toThrow(/field amount is missing/)
    expect(evaluateApprovalConditionFormula('{amount} == null', { amount: null })).toBe(true)
    expect(() => evaluateApprovalConditionFormula('SUM({items.amount}) >= 1', { items: [{ amount: '10' }] })).toThrow(/finite number/)
    expect(() => evaluateApprovalConditionFormula('MIN({items.amount}) >= 1', { items: [] })).toThrow(/at least one/)
  })

  it('does not let boolean short-circuiting hide malformed aggregate data', () => {
    expect(() => evaluateApprovalConditionFormula(
      '{expense_type} == "travel" AND SUM({items.amount}) >= 1',
      { expense_type: 'office', items: [{ amount: 'bad' }] },
    )).toThrow(/finite number/)
    expect(() => evaluateApprovalConditionFormula(
      '{expense_type} == "office" OR SUM({items.amount}) >= 1',
      { expense_type: 'office', items: [{ amount: 'bad' }] },
    )).toThrow(/finite number/)
  })

  it('rejects concrete DoS bounds before runtime', () => {
    expect(() => parseApprovalConditionFormula(`${'1+'.repeat(130)}1 > 0`)).toThrow(/AST exceeds/)
    expect(() => parseApprovalConditionFormula(`${'NOT '.repeat(17)}TRUE`)).toThrow(/depth exceeds/)
    expect(() => parseApprovalConditionFormula(`${'('.repeat(17)}TRUE${')'.repeat(17)}`)).toThrow(/nesting depth exceeds/)
    expect(() => parseApprovalConditionFormula(`${'1'.repeat(513)} == 1`)).toThrow(/exceeds 512/)
  })

  it('counts aggregate references against the field-reference cap', () => {
    const limits = APPROVAL_CONDITION_FORMULA_LIMITS as { maxFieldReferences: number }
    const original = limits.maxFieldReferences
    limits.maxFieldReferences = 1
    try {
      expect(() => parseApprovalConditionFormula('SUM({items.amount}) + {amount} > 0')).toThrow(/references more than 1 fields/)
    } finally {
      limits.maxFieldReferences = original
    }
  })
})

describe('requester namespace (RA-1a — department only)', () => {
  it('evaluates requester.department ==/!= from the frozen context', () => {
    expect(evaluateApprovalConditionFormula('requester.department == "财务"', {}, { department: '财务' })).toBe(true)
    expect(evaluateApprovalConditionFormula('requester.department == "财务"', {}, { department: '技术' })).toBe(false)
    expect(evaluateApprovalConditionFormula('requester.department != "财务"', {}, { department: '技术' })).toBe(true)
  })

  it('combines with form fields (AND)', () => {
    expect(evaluateApprovalConditionFormula('requester.department == "财务" AND {amount} >= 5000', { amount: 6000 }, { department: '财务' })).toBe(true)
    expect(evaluateApprovalConditionFormula('requester.department == "财务" AND {amount} >= 5000', { amount: 6000 }, { department: '技术' })).toBe(false)
  })

  it('PARSE-rejects every attr outside {department, title, role} — fail-closed, never runtime-absent', () => {
    expect(() => parseApprovalConditionFormula('requester.level >= 5')).toThrow(/unsupported requester attribute/)
    expect(() => parseApprovalConditionFormula('requester.foo == "x"')).toThrow(/unsupported requester attribute/)
    // RA-1b: `requester.role` is now an accepted token (LHS of `in`); a scalar `requester.role == "x"`
    // type-rejects at publish (asserted in the role block), so it is no longer an unknown-attr parse error.
  })

  it('PARSE-rejects the `in` operator + array literals (RA-1b grammar), bare requester, and empty attr', () => {
    expect(() => parseApprovalConditionFormula('requester.department in ["a", "b"]')).toThrow()
    expect(() => parseApprovalConditionFormula('requester.department == ["a"]')).toThrow()
    expect(() => parseApprovalConditionFormula('requester == "x"')).toThrow()
    expect(() => parseApprovalConditionFormula('requester. == "x"')).toThrow(/missing an attribute/)
  })

  it('RUNTIME fail-closed: absent context / missing department rejects (no phantom routing)', () => {
    expect(() => evaluateApprovalConditionFormula('requester.department == "财务"', {}, null)).toThrow(/context unavailable/)
    expect(() => evaluateApprovalConditionFormula('requester.department == "财务"', {}, {})).toThrow(/department is missing/)
    expect(() => evaluateApprovalConditionFormula('requester.department == "财务"', {}, { department: '' })).toThrow(/department is missing/)
    expect(() => evaluateApprovalConditionFormula('requester.department == "财务"', {}, { department: null })).toThrow(/department is missing/)
  })

  it('a form field named `requester` cannot spoof it — token reads context, never formData', () => {
    expect(evaluateApprovalConditionFormula('requester.department == "财务"', { requester: { department: '财务' } }, { department: '技术' })).toBe(false)
  })

  it('publish: compared requester.department → boolean OK; bare → non-boolean reject; level → unsupported', () => {
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.department == "财务"', schema)).not.toThrow()
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.department', schema)).toThrow(/must return boolean/)
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.level >= 5', schema)).toThrow(/unsupported requester attribute/)
  })

  it('pins the operator restriction: department is ==/!= only (ordering ops fail publish type-check)', () => {
    // department is string-typed, so ordering operators fail the numeric-operand check at publish.
    // This is enforced via typing, not an explicit operator allowlist — RA-1b will auto-enable ordering
    // for any future numeric attr, so this pin guards the RA-1a as-built contract.
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.department >= "财务"', schema)).toThrow(/numeric operands/)
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.department > "财务"', schema)).toThrow(/numeric operands/)
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.department < "财务"', schema)).toThrow(/numeric operands/)
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.department <= "财务"', schema)).toThrow(/numeric operands/)
  })
})

describe('requester namespace (requester.title — string ==/!= only)', () => {
  it('evaluates requester.title ==/!= from the frozen context', () => {
    expect(evaluateApprovalConditionFormula('requester.title == "经理"', {}, { title: '经理' })).toBe(true)
    expect(evaluateApprovalConditionFormula('requester.title == "经理"', {}, { title: '专员' })).toBe(false)
    expect(evaluateApprovalConditionFormula('requester.title != "经理"', {}, { title: '专员' })).toBe(true)
  })

  it('combines with form fields (AND)', () => {
    expect(evaluateApprovalConditionFormula('requester.title == "经理" AND {amount} >= 5000', { amount: 6000 }, { title: '经理' })).toBe(true)
    expect(evaluateApprovalConditionFormula('requester.title == "经理" AND {amount} >= 5000', { amount: 6000 }, { title: '专员' })).toBe(false)
  })

  it('PARSE-allowlist now PERMITS title but still rejects level/unknown', () => {
    expect(() => parseApprovalConditionFormula('requester.title == "经理"')).not.toThrow()
    expect(() => parseApprovalConditionFormula('requester.level >= 5')).toThrow(/unsupported requester attribute/)
    expect(() => parseApprovalConditionFormula('requester.grade == "x"')).toThrow(/unsupported requester attribute/)
    // RA-1b: `requester.role` now parses as a token (it is the LHS of `in`); a SCALAR use like
    // `requester.role == "x"` is a TYPE-reject at publish, not a parse-reject (covered in the role block).
  })

  it('RUNTIME fail-closed: absent context / missing title rejects (no phantom routing)', () => {
    expect(() => evaluateApprovalConditionFormula('requester.title == "经理"', {}, null)).toThrow(/context unavailable/)
    expect(() => evaluateApprovalConditionFormula('requester.title == "经理"', {}, {})).toThrow(/title is missing/)
    expect(() => evaluateApprovalConditionFormula('requester.title == "经理"', {}, { title: '' })).toThrow(/title is missing/)
    expect(() => evaluateApprovalConditionFormula('requester.title == "经理"', {}, { title: null })).toThrow(/title is missing/)
  })

  it('token-aware: a string literal "requester.title" reads neither context nor formData', () => {
    // The token reads the frozen context; a quoted literal is just a string, and a form field named
    // `requester` cannot spoof it.
    expect(evaluateApprovalConditionFormula('requester.title == "经理"', { requester: { title: '经理' } }, { title: '专员' })).toBe(false)
    expect(evaluateApprovalConditionFormula('"requester.title" == "requester.title"', {}, { title: '专员' })).toBe(true)
  })

  it('pins the operator restriction: title is ==/!= only (ordering ops fail publish type-check)', () => {
    // title is string-typed, so ordering operators fail the numeric-operand check at publish.
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.title == "经理"', schema)).not.toThrow()
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.title', schema)).toThrow(/must return boolean/)
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.title >= "经理"', schema)).toThrow(/numeric operands/)
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.title > "经理"', schema)).toThrow(/numeric operands/)
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.title < "经理"', schema)).toThrow(/numeric operands/)
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.title <= "经理"', schema)).toThrow(/numeric operands/)
  })
})

describe('requester namespace (requester.role — membership via `in [...]`)', () => {
  it('evaluates requester.role in [...] as role-set INTERSECTION (at least one held)', () => {
    // intersection non-empty -> true
    expect(evaluateApprovalConditionFormula('requester.role in ["a","b"]', {}, { roles: ['a'] })).toBe(true)
    expect(evaluateApprovalConditionFormula('requester.role in ["a","b"]', {}, { roles: ['x', 'b'] })).toBe(true)
    expect(evaluateApprovalConditionFormula('requester.role in ["a","b"]', {}, { roles: ['a', 'b'] })).toBe(true)
    // intersection empty -> false (held but none listed)
    expect(evaluateApprovalConditionFormula('requester.role in ["a","b"]', {}, { roles: ['x', 'y'] })).toBe(false)
    // genuinely-empty held set -> false (no match; create-time guard prevents this on a role-routed graph)
    expect(evaluateApprovalConditionFormula('requester.role in ["a","b"]', {}, { roles: [] })).toBe(false)
    // single-element literal
    expect(evaluateApprovalConditionFormula('requester.role in ["admin"]', {}, { roles: ['admin'] })).toBe(true)
  })

  it('combines with form fields + AND/OR/NOT (membership yields boolean)', () => {
    expect(evaluateApprovalConditionFormula('requester.role in ["finance"] AND {amount} >= 5000', { amount: 6000 }, { roles: ['finance'] })).toBe(true)
    expect(evaluateApprovalConditionFormula('requester.role in ["finance"] AND {amount} >= 5000', { amount: 6000 }, { roles: ['eng'] })).toBe(false)
    expect(evaluateApprovalConditionFormula('NOT (requester.role in ["finance"])', {}, { roles: ['eng'] })).toBe(true)
  })

  it('RUNTIME fail-closed: absent context / null role set rejects (no phantom routing)', () => {
    expect(() => evaluateApprovalConditionFormula('requester.role in ["a"]', {}, null)).toThrow(/context unavailable/)
    expect(() => evaluateApprovalConditionFormula('requester.role in ["a"]', {}, {})).toThrow(/roles are missing/)
    expect(() => evaluateApprovalConditionFormula('requester.role in ["a"]', {}, { roles: null })).toThrow(/roles are missing/)
  })

  it('type-checks the role-in form to boolean at publish', () => {
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.role in ["a","b"]', schema)).not.toThrow()
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.role in ["a"] AND {amount} >= 5', schema)).not.toThrow()
  })

  it('PARSE/TYPE-rejects every malformed form, fail-closed', () => {
    // `requester.role` with any operator OTHER than `in` -> TYPE-reject at publish (parses as a token first)
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.role == "x"', schema)).toThrow(/can only be used with the `in` operator/)
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.role != "x"', schema)).toThrow(/can only be used with the `in` operator/)
    expect(() => assertApprovalConditionFormulaValidForSchema('requester.role', schema)).toThrow(/can only be used with the `in` operator/)
    // `in` on a NON-role LHS -> PARSE-reject
    expect(() => parseApprovalConditionFormula('requester.department in ["a"]')).toThrow(/only supported for requester.role/)
    expect(() => parseApprovalConditionFormula('requester.title in ["a"]')).toThrow(/only supported for requester.role/)
    expect(() => parseApprovalConditionFormula('{amount} in ["a"]')).toThrow(/only supported for requester.role/)
    expect(() => parseApprovalConditionFormula('5 in ["a"]')).toThrow(/only supported for requester.role/)
    // non-array RHS -> PARSE-reject
    expect(() => parseApprovalConditionFormula('requester.role in "a"')).toThrow(/requires a bracketed array literal/)
    expect(() => parseApprovalConditionFormula('requester.role in 5')).toThrow(/requires a bracketed array literal/)
    // empty array -> PARSE-reject
    expect(() => parseApprovalConditionFormula('requester.role in []')).toThrow(/must not be empty/)
    // non-string element -> PARSE-reject
    expect(() => parseApprovalConditionFormula('requester.role in [1, 2]')).toThrow(/string literals only/)
    expect(() => parseApprovalConditionFormula('requester.role in ["a", 2]')).toThrow(/string literals only/)
    // nested array -> PARSE-reject
    expect(() => parseApprovalConditionFormula('requester.role in [["a"]]')).toThrow(/string literals only/)
    expect(() => parseApprovalConditionFormula('requester.role in ["a", ["b"]]')).toThrow(/string literals only/)
    // malformed separators -> PARSE-reject
    expect(() => parseApprovalConditionFormula('requester.role in ["a" "b"]')).toThrow(/comma-separated/)
    expect(() => parseApprovalConditionFormula('requester.role in ["a",]')).toThrow(/string literals only/)
  })

  it('caps the array literal length at maxInArrayElements (DoS bound)', () => {
    const within = Array.from({ length: APPROVAL_CONDITION_FORMULA_LIMITS.maxInArrayElements }, (_, i) => `"r${i}"`).join(',')
    const over = Array.from({ length: APPROVAL_CONDITION_FORMULA_LIMITS.maxInArrayElements + 1 }, (_, i) => `"r${i}"`).join(',')
    expect(() => parseApprovalConditionFormula(`requester.role in [${within}]`)).not.toThrow()
    expect(() => parseApprovalConditionFormula(`requester.role in [${over}]`)).toThrow(/exceeds .* elements/)
  })

  it('token-aware: a quoted "requester.role" literal is NOT a requester token', () => {
    // A quoted "requester.role" is just a string; as an `in` LHS it is a string literal, so the whole
    // expression PARSE-rejects (LHS not a requester.role token) rather than reading the role set.
    expect(() => parseApprovalConditionFormula('"requester.role" in ["a"]')).toThrow(/only supported for requester.role/)
    // and a bare quoted literal evaluates as a plain string (no context read, no formData spoof).
    expect(evaluateApprovalConditionFormula('"requester.role" == "requester.role"', {}, { roles: ['a'] })).toBe(true)
  })
})
