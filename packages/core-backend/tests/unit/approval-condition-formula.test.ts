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

  it('PARSE-rejects every attr outside {department} — fail-closed, never runtime-absent', () => {
    expect(() => parseApprovalConditionFormula('requester.level >= 5')).toThrow(/unsupported requester attribute/)
    expect(() => parseApprovalConditionFormula('requester.role == "x"')).toThrow(/unsupported requester attribute/)
    expect(() => parseApprovalConditionFormula('requester.title == "经理"')).toThrow(/unsupported requester attribute/)
    expect(() => parseApprovalConditionFormula('requester.foo == "x"')).toThrow(/unsupported requester attribute/)
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
