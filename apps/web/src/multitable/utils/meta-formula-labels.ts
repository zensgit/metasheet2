// Formula reference and validation chrome.
//
// Scope: formula catalog category names/descriptions, formula function
// descriptions, and frontend formula diagnostics. Formula names, signatures,
// examples, insertion snippets, field refs, and unknown formula tokens stay raw.

import type {
  FormulaFunctionCategory,
  FormulaFunctionCategoryDoc,
  FormulaFunctionDoc,
} from './formula-docs'

type LocaleText = { en: string; zh: string }
type FormulaFunctionName = FormulaFunctionDoc['name']

export type FormulaDiagnosticLabelKey =
  | 'diagnostic.unexpectedClosingParenthesis'
  | 'diagnostic.unexpectedClosingArrayBracket'
  | 'diagnostic.unexpectedClosingFieldReferenceBrace'
  | 'diagnostic.quotedStringNotClosed'
  | 'diagnostic.parenthesesNotBalanced'
  | 'diagnostic.arrayBracketsNotBalanced'
  | 'diagnostic.fieldReferenceBracesNotBalanced'
  | 'diagnostic.trailingBinaryOperator'
  | 'diagnostic.emptyExpression'

const CATEGORY_LABELS: Record<FormulaFunctionCategory, { label: LocaleText; description: LocaleText }> = {
  aggregate: {
    label: { en: 'Aggregate', zh: '聚合' },
    description: { en: 'Summarize numeric or non-empty values.', zh: '汇总数字或非空值。' },
  },
  math: {
    label: { en: 'Math', zh: '数学' },
    description: { en: 'Round, transform, and compare numbers.', zh: '对数字进行舍入、转换和比较。' },
  },
  operator: {
    label: { en: 'Operators', zh: '运算符' },
    description: { en: 'Combine values with spreadsheet operators.', zh: '使用表格运算符合并值。' },
  },
  logic: {
    label: { en: 'Logic', zh: '逻辑' },
    description: { en: 'Branch and combine conditions.', zh: '分支处理并组合条件。' },
  },
  text: {
    label: { en: 'Text', zh: '文本' },
    description: { en: 'Join, slice, and normalize text.', zh: '拼接、截取并规范化文本。' },
  },
  date: {
    label: { en: 'Date', zh: '日期' },
    description: { en: 'Create or extract date values.', zh: '创建或提取日期值。' },
  },
  lookup: {
    label: { en: 'Lookup', zh: '查找' },
    description: { en: 'Find values from arrays or ranges.', zh: '从数组或范围中查找值。' },
  },
  statistical: {
    label: { en: 'Statistical', zh: '统计' },
    description: { en: 'Calculate distribution helpers.', zh: '计算分布类辅助值。' },
  },
}

const FUNCTION_DESCRIPTIONS: Record<FormulaFunctionName, LocaleText> = {
  SUM: { en: 'Adds numeric values together.', zh: '将数字值相加。' },
  AVERAGE: { en: 'Returns the arithmetic mean of numeric values.', zh: '返回数字值的算术平均值。' },
  COUNT: { en: 'Counts numeric values.', zh: '统计数字值。' },
  COUNTA: { en: 'Counts values that are not empty.', zh: '统计非空值。' },
  MIN: { en: 'Returns the smallest numeric value.', zh: '返回最小的数字值。' },
  MAX: { en: 'Returns the largest numeric value.', zh: '返回最大的数字值。' },
  ROUND: { en: 'Rounds a number to the requested decimal places.', zh: '将数字舍入到指定小数位。' },
  CEILING: { en: 'Rounds a number up to the nearest integer.', zh: '将数字向上舍入到最接近的整数。' },
  FLOOR: { en: 'Rounds a number down to the nearest integer.', zh: '将数字向下舍入到最接近的整数。' },
  POWER: { en: 'Raises a number to a power.', zh: '返回数字的乘方结果。' },
  SQRT: { en: 'Returns the square root of a number.', zh: '返回数字的平方根。' },
  MOD: { en: 'Returns the remainder after division.', zh: '返回除法后的余数。' },
  ABS: { en: 'Returns the absolute value of a number.', zh: '返回数字的绝对值。' },
  ADD: { en: 'Adds two numeric values. Text numbers are coerced to numbers.', zh: '将两个数字值相加。文本数字会被转换为数字。' },
  SUBTRACT: { en: 'Subtracts the right numeric value from the left value.', zh: '从左侧值中减去右侧数字值。' },
  MULTIPLY: { en: 'Multiplies two numeric values.', zh: '将两个数字值相乘。' },
  DIVIDE: { en: 'Divides the left numeric value by the right value.', zh: '将左侧数字值除以右侧值。' },
  POWER_OPERATOR: { en: 'Raises the left numeric value to the power of the right value.', zh: '将左侧数字值提升到右侧值指定的幂。' },
  PERCENT_OPERATOR: { en: 'Converts a number to a percentage value, for example 50% becomes 0.5.', zh: '将数字转换为百分比值，例如 50% 会变为 0.5。' },
  CONCAT_OPERATOR: { en: 'Concatenates values as text.', zh: '将值按文本拼接。' },
  COMPARISON: { en: 'Compares two values and returns TRUE or FALSE.', zh: '比较两个值并返回 TRUE 或 FALSE。' },
  IF: { en: 'Chooses one of two values based on a condition.', zh: '根据条件在两个值中选择一个。' },
  AND: { en: 'Returns true only when all conditions are true.', zh: '仅当所有条件都为 true 时返回 true。' },
  OR: { en: 'Returns true when any condition is true.', zh: '任一条件为 true 时返回 true。' },
  NOT: { en: 'Reverses a boolean value.', zh: '反转布尔值。' },
  TRUE: { en: 'Returns the boolean value TRUE.', zh: '返回布尔值 TRUE。' },
  FALSE: { en: 'Returns the boolean value FALSE.', zh: '返回布尔值 FALSE。' },
  SWITCH: { en: 'Returns the result for the first matching value, with an optional default.', zh: '返回第一个匹配值对应的结果，可包含默认值。' },
  CONCAT: { en: 'Joins text values together.', zh: '将文本值拼接在一起。' },
  CONCATENATE: { en: 'Joins text values together.', zh: '将文本值拼接在一起。' },
  LEFT: { en: 'Returns characters from the start of a text value.', zh: '返回文本值开头的字符。' },
  RIGHT: { en: 'Returns characters from the end of a text value.', zh: '返回文本值末尾的字符。' },
  MID: { en: 'Returns characters from the middle of a text value.', zh: '返回文本值中间位置的字符。' },
  LEN: { en: 'Returns the length of a text value.', zh: '返回文本值的长度。' },
  UPPER: { en: 'Converts text to uppercase.', zh: '将文本转换为大写。' },
  LOWER: { en: 'Converts text to lowercase.', zh: '将文本转换为小写。' },
  TRIM: { en: 'Removes leading and trailing whitespace from text.', zh: '移除文本开头和结尾的空白。' },
  SUBSTITUTE: { en: 'Replaces all occurrences of old text with new text.', zh: '将旧文本的所有出现位置替换为新文本。' },
  NOW: { en: 'Returns the current date and time.', zh: '返回当前日期和时间。' },
  TODAY: { en: 'Returns the current date.', zh: '返回当前日期。' },
  DATE: { en: 'Creates a date from year, month, and day numbers.', zh: '根据年、月、日数字创建日期。' },
  DATEDIF: { en: 'Returns the difference between two dates using unit D, M, or Y.', zh: '使用 D、M 或 Y 单位返回两个日期之间的差值。' },
  DATEDIFF: { en: 'Returns the number of days between two dates.', zh: '返回两个日期之间的天数。' },
  YEAR: { en: 'Returns the year from a date value.', zh: '返回日期值中的年份。' },
  MONTH: { en: 'Returns the month from a date value.', zh: '返回日期值中的月份。' },
  DAY: { en: 'Returns the day of month from a date value.', zh: '返回日期值中的日。' },
  VLOOKUP: { en: 'Looks up a value in the first column of a table-like range.', zh: '在类似表格的范围第一列中查找值。' },
  HLOOKUP: { en: 'Looks up a value in the first row of a table-like range.', zh: '在类似表格的范围第一行中查找值。' },
  INDEX: { en: 'Returns a value from a range by row and column position.', zh: '按行列位置从范围中返回值。' },
  MATCH: { en: 'Returns the position of a value in a range.', zh: '返回值在范围中的位置。' },
  STDEV: { en: 'Returns the sample standard deviation of numeric values.', zh: '返回数字值的样本标准差。' },
  VAR: { en: 'Returns the sample variance of numeric values.', zh: '返回数字值的样本方差。' },
  MEDIAN: { en: 'Returns the median of numeric values.', zh: '返回数字值的中位数。' },
  MODE: { en: 'Returns the most common numeric value.', zh: '返回最常见的数字值。' },
}

const DIAGNOSTIC_LABELS: Record<FormulaDiagnosticLabelKey, LocaleText> = {
  'diagnostic.unexpectedClosingParenthesis': { en: 'Unexpected closing parenthesis.', zh: '意外的右括号。' },
  'diagnostic.unexpectedClosingArrayBracket': { en: 'Unexpected closing array bracket.', zh: '意外的右方括号。' },
  'diagnostic.unexpectedClosingFieldReferenceBrace': { en: 'Unexpected closing field-reference brace.', zh: '意外的字段引用右花括号。' },
  'diagnostic.quotedStringNotClosed': { en: 'Quoted string is not closed.', zh: '引号字符串未闭合。' },
  'diagnostic.parenthesesNotBalanced': { en: 'Parentheses are not balanced.', zh: '圆括号不匹配。' },
  'diagnostic.arrayBracketsNotBalanced': { en: 'Array brackets are not balanced.', zh: '方括号不匹配。' },
  'diagnostic.fieldReferenceBracesNotBalanced': { en: 'Field reference braces are not balanced.', zh: '字段引用花括号不匹配。' },
  'diagnostic.trailingBinaryOperator': { en: 'Formula cannot end with a binary operator.', zh: '公式不能以二元运算符结尾。' },
  'diagnostic.emptyExpression': { en: 'Formula expression is empty.', zh: '公式表达式为空。' },
}

function pick(text: LocaleText, isZh: boolean): string {
  return isZh ? text.zh : text.en
}

export function formulaCategoryLabel(category: FormulaFunctionCategory, isZh: boolean): FormulaFunctionCategoryDoc {
  const entry = CATEGORY_LABELS[category]
  if (!entry) {
    const raw = String(category)
    return { id: category, label: raw, description: raw }
  }
  return {
    id: category,
    label: pick(entry.label, isZh),
    description: pick(entry.description, isZh),
  }
}

export function formulaFunctionDescription(name: string, isZh: boolean): string {
  const entry = FUNCTION_DESCRIPTIONS[name]
  if (!entry) return ''
  return pick(entry, isZh)
}

export function formulaDiagnosticLabel(key: FormulaDiagnosticLabelKey, isZh: boolean): string {
  return pick(DIAGNOSTIC_LABELS[key], isZh)
}

export function formulaEmptyArgument(functionName: string, isZh: boolean): string {
  return isZh
    ? `${functionName} 存在空参数。`
    : `${functionName} has an empty argument.`
}

export function formulaMinArgs(functionName: string, count: number, isZh: boolean): string {
  return isZh
    ? `${functionName} 至少需要 ${count} 个参数。`
    : `${functionName} expects at least ${count} argument${count === 1 ? '' : 's'}.`
}

export function formulaMaxArgs(functionName: string, count: number, isZh: boolean): string {
  return isZh
    ? `${functionName} 最多接受 ${count} 个参数。`
    : `${functionName} expects at most ${count} argument${count === 1 ? '' : 's'}.`
}

export function formulaFieldNameReference(ref: string, isZh: boolean): string {
  return isZh
    ? `字段引用 {${ref}} 使用了名称。请使用字段标签插入稳定的 {fld_xxx} 令牌。`
    : `Field reference {${ref}} uses a name. Use the field chip to insert a stable {fld_xxx} token.`
}

export function formulaUnknownFieldReference(ref: string, isZh: boolean): string {
  return isZh
    ? `未知字段引用 {${ref}}。`
    : `Unknown field reference {${ref}}.`
}

export function formulaUndocumentedFunction(functionName: string, isZh: boolean): string {
  return isZh
    ? `${functionName} 尚未在此编辑器中记录。`
    : `${functionName} is not documented in this editor yet.`
}
