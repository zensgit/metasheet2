import { describe, expect, it } from 'vitest'
import {
  formulaCategoryLabel,
  formulaDiagnosticLabel,
  formulaEmptyArgument,
  formulaFieldNameReference,
  formulaFunctionDescription,
  formulaMaxArgs,
  formulaMinArgs,
  formulaUndocumentedFunction,
  formulaUnknownFieldReference,
} from '../src/multitable/utils/meta-formula-labels'

describe('meta formula labels', () => {
  it('localizes formula categories', () => {
    expect(formulaCategoryLabel('aggregate', false)).toEqual({
      id: 'aggregate',
      label: 'Aggregate',
      description: 'Summarize numeric or non-empty values.',
    })
    expect(formulaCategoryLabel('aggregate', true)).toEqual({
      id: 'aggregate',
      label: '聚合',
      description: '汇总数字或非空值。',
    })
    expect(formulaCategoryLabel('operator', true).label).toBe('运算符')
    expect(formulaCategoryLabel('statistical', true).description).toBe('计算分布类辅助值。')
  })

  it('localizes formula function descriptions and returns empty for unknown functions', () => {
    expect(formulaFunctionDescription('SUM', false)).toBe('Adds numeric values together.')
    expect(formulaFunctionDescription('SUM', true)).toBe('将数字值相加。')
    expect(formulaFunctionDescription('PERCENT_OPERATOR', true)).toBe('将数字转换为百分比值，例如 50% 会变为 0.5。')
    expect(formulaFunctionDescription('FOO', true)).toBe('')
  })

  it('localizes every static diagnostic label', () => {
    expect(formulaDiagnosticLabel('diagnostic.unexpectedClosingParenthesis', false)).toBe('Unexpected closing parenthesis.')
    expect(formulaDiagnosticLabel('diagnostic.unexpectedClosingParenthesis', true)).toBe('意外的右括号。')
    expect(formulaDiagnosticLabel('diagnostic.unexpectedClosingArrayBracket', true)).toBe('意外的右方括号。')
    expect(formulaDiagnosticLabel('diagnostic.unexpectedClosingFieldReferenceBrace', true)).toBe('意外的字段引用右花括号。')
    expect(formulaDiagnosticLabel('diagnostic.quotedStringNotClosed', true)).toBe('引号字符串未闭合。')
    expect(formulaDiagnosticLabel('diagnostic.parenthesesNotBalanced', true)).toBe('圆括号不匹配。')
    expect(formulaDiagnosticLabel('diagnostic.arrayBracketsNotBalanced', true)).toBe('方括号不匹配。')
    expect(formulaDiagnosticLabel('diagnostic.fieldReferenceBracesNotBalanced', true)).toBe('字段引用花括号不匹配。')
    expect(formulaDiagnosticLabel('diagnostic.trailingBinaryOperator', true)).toBe('公式不能以二元运算符结尾。')
    expect(formulaDiagnosticLabel('diagnostic.emptyExpression', true)).toBe('公式表达式为空。')
  })

  it('preserves raw values in dynamic diagnostics', () => {
    expect(formulaEmptyArgument('ROUND', false)).toBe('ROUND has an empty argument.')
    expect(formulaEmptyArgument('ROUND', true)).toBe('ROUND 存在空参数。')
    expect(formulaMinArgs('IF', 3, false)).toBe('IF expects at least 3 arguments.')
    expect(formulaMinArgs('IF', 1, false)).toBe('IF expects at least 1 argument.')
    expect(formulaMinArgs('IF', 3, true)).toBe('IF 至少需要 3 个参数。')
    expect(formulaMaxArgs('TODAY', 0, false)).toBe('TODAY expects at most 0 arguments.')
    expect(formulaMaxArgs('ROUND', 2, true)).toBe('ROUND 最多接受 2 个参数。')
    expect(formulaFieldNameReference('Price', true)).toBe('字段引用 {Price} 使用了名称。请使用字段标签插入稳定的 {fld_xxx} 令牌。')
    expect(formulaUnknownFieldReference('fld_missing', true)).toBe('未知字段引用 {fld_missing}。')
    expect(formulaUndocumentedFunction('FOO', true)).toBe('FOO 尚未在此编辑器中记录。')
  })
})
