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
  // W1 G-10 (display layer only): '整表' -> '整张数据表' (Sheet = 数据表).
  RELSUMIF: { en: 'Sums a foreign field over linked records matching one criteria (relation-scoped, not whole-sheet SUMIF).', zh: '对满足条件的关联记录的某外部字段求和（关系范围，非整张数据表 SUMIF）。' },
  RELAVGIF: { en: 'Averages a foreign field over linked records matching one criteria (relation-scoped).', zh: '对满足条件的关联记录的某外部字段求平均（关系范围）。' },
  RELCOUNTIF: { en: 'Counts the linked records matching one criteria (relation-scoped).', zh: '统计满足条件的关联记录数（关系范围）。' },
  RELLOOKUP: { en: 'Returns a foreign field from the first linked record matching one criteria; #N/A if none.', zh: '返回首个满足条件的关联记录的某外部字段；无匹配时返回 #N/A。' },
  RELVALUES: { en: 'Returns the array of a foreign field across linked records matching one criteria (relation-scoped).', zh: '返回满足条件的关联记录的某外部字段值数组（关系范围）。' },
  STDEV: { en: 'Returns the sample standard deviation of numeric values.', zh: '返回数字值的样本标准差。' },
  VAR: { en: 'Returns the sample variance of numeric values.', zh: '返回数字值的样本方差。' },
  MEDIAN: { en: 'Returns the median of numeric values.', zh: '返回数字值的中位数。' },
  MODE: { en: 'Returns the most common numeric value.', zh: '返回最常见的数字值。' },
  // Cluster-C path-1 batch 1: 13 standard scalar functions.
  PRODUCT: { en: 'Multiplies numeric values together.', zh: '将数字值相乘。' },
  SIGN: { en: 'Returns 1, -1, or 0 depending on whether a number is positive, negative, or zero.', zh: '根据数字为正、负或零，返回 1、-1 或 0。' },
  PI: { en: 'Returns the value of pi.', zh: '返回圆周率 π 的值。' },
  RADIANS: { en: 'Converts a value in degrees to radians.', zh: '将角度值转换为弧度。' },
  DEGREES: { en: 'Converts a value in radians to degrees.', zh: '将弧度值转换为角度。' },
  GCD: { en: 'Returns the greatest common divisor of the given integers.', zh: '返回给定整数的最大公约数。' },
  LCM: { en: 'Returns the least common multiple of the given integers.', zh: '返回给定整数的最小公倍数。' },
  VALUE: { en: 'Converts text that looks like a number into a number.', zh: '将形似数字的文本转换为数字。' },
  PROPER: { en: 'Capitalizes the first letter of each word in text.', zh: '将文本中每个单词的首字母转换为大写。' },
  TEXTJOIN: { en: 'Joins text values with a delimiter, optionally skipping empty values.', zh: '使用分隔符拼接文本值，可选择跳过空值。' },
  STDEVP: { en: 'Returns the population standard deviation of numeric values.', zh: '返回数字值的总体标准差。' },
  VARP: { en: 'Returns the population variance of numeric values.', zh: '返回数字值的总体方差。' },
  CHOOSE: { en: 'Returns the value at the given 1-based position from a list of values.', zh: '从一组值中返回给定位置（从 1 开始）的值。' },
  IFERROR: { en: 'Returns a fallback value when the given value is an error, otherwise returns the value unchanged.', zh: '当给定值为错误时返回替代值，否则返回原值。' },
  ISERROR: { en: 'Returns true when the given value is an error result.', zh: '当给定值为错误结果时返回 true。' },
  ISBLANK: { en: 'Returns true when the value is empty (null, undefined, or an empty string).', zh: '当值为空（null、未定义或空字符串）时返回 true。' },
  ISNUMBER: { en: 'Returns true when the value is a valid number.', zh: '当值是有效数字时返回 true。' },
  IFS: { en: 'Evaluates condition/value pairs in order and returns the value for the first true condition; returns #N/A if none match.', zh: '依次判断条件/值对，返回第一个为 true 的条件对应的值；如果都不匹配则返回 #N/A。' },
  XOR: { en: 'Returns true when an odd number of the given values are truthy (exclusive OR).', zh: '当给定值中为真的数量为奇数时返回 true（异或）。' },
  ROUNDUP: { en: 'Rounds a number up, away from zero, to the requested decimal places.', zh: '将数字向上（远离零）舍入到指定小数位。' },
  ROUNDDOWN: { en: 'Rounds a number down, toward zero, to the requested decimal places.', zh: '将数字向下（趋近零）舍入到指定小数位。' },
  WEEKDAY: { en: 'Returns the day of the week as a number; by default Sunday=1…Saturday=7, or use type 2 for a Monday-start week (Monday=1…Sunday=7).', zh: '返回星期几对应的数字；默认周日=1…周六=7，type 为 2 时表示以周一为一周的第一天（周一=1…周日=7）。' },
  SECOND: { en: 'Returns the second (0–59) of a date-time value.', zh: '返回日期时间值中的秒（0–59）。' },
  EDATE: { en: 'Returns the date shifted by whole months, clamped to the end of the target month.', zh: '返回按整月偏移后的日期，并限制在目标月份的最后一天内。' },
  DAYS: { en: 'Returns the number of calendar days between two dates (end date minus start date).', zh: '返回两个日期之间的日历天数（结束日期减去开始日期）。' },
  // Cluster-C path-1 batch 2: 26 standard scalar functions.
  SIN: { en: 'Returns the sine of an angle given in radians.', zh: '返回以弧度表示的角度的正弦值。' },
  COS: { en: 'Returns the cosine of an angle given in radians.', zh: '返回以弧度表示的角度的余弦值。' },
  TAN: { en: 'Returns the tangent of an angle given in radians.', zh: '返回以弧度表示的角度的正切值。' },
  ASIN: { en: 'Returns the arcsine (in radians) of a number between -1 and 1.', zh: '返回介于 -1 到 1 之间的数字的反正弦值（弧度）。' },
  ACOS: { en: 'Returns the arccosine (in radians) of a number between -1 and 1.', zh: '返回介于 -1 到 1 之间的数字的反余弦值（弧度）。' },
  ATAN: { en: 'Returns the arctangent (in radians) of a number.', zh: '返回数字的反正切值（弧度）。' },
  ATAN2: { en: 'Returns the arctangent (in radians) of the specified x and y coordinates.', zh: '返回指定 x 和 y 坐标的反正切值（弧度）。' },
  LOG10: { en: 'Returns the base-10 logarithm of a number.', zh: '返回数字以 10 为底的对数。' },
  EVEN: { en: 'Rounds a number away from zero to the nearest even integer.', zh: '将数字向远离零的方向舍入到最接近的偶数。' },
  ODD: { en: 'Rounds a number away from zero to the nearest odd integer.', zh: '将数字向远离零的方向舍入到最接近的奇数。' },
  FACT: { en: 'Returns the factorial of a non-negative integer.', zh: '返回非负整数的阶乘。' },
  QUOTIENT: { en: 'Returns the integer portion of a division, truncated toward zero.', zh: '返回除法运算结果的整数部分（向零截断）。' },
  MROUND: { en: 'Rounds a number to the nearest multiple.', zh: '将数字舍入到最接近的指定倍数。' },
  ISEVEN: { en: 'Returns true when a number is even.', zh: '当数字为偶数时返回 true。' },
  ISODD: { en: 'Returns true when a number is odd.', zh: '当数字为奇数时返回 true。' },
  EXACT: { en: 'Compares two text values and returns true only for an exact, case-sensitive match.', zh: '比较两个文本值，仅在完全匹配（区分大小写）时返回 true。' },
  CHAR: { en: 'Returns the character for a given character code (1-255).', zh: '返回给定字符代码（1-255）对应的字符。' },
  CODE: { en: 'Returns the character code of the first character in a text value.', zh: '返回文本值中第一个字符的字符代码。' },
  CLEAN: { en: 'Removes non-printable ASCII control characters from text.', zh: '从文本中移除不可打印的 ASCII 控制字符。' },
  ISTEXT: { en: 'Returns true when the value is text.', zh: '当值为文本时返回 true。' },
  DATEVALUE: { en: 'Converts a date stored as text into a date value.', zh: '将以文本形式存储的日期转换为日期值。' },
  TIMEVALUE: { en: 'Converts a time stored as "HH:MM" or "HH:MM:SS" text into a time value.', zh: '将以 "HH:MM" 或 "HH:MM:SS" 文本形式存储的时间转换为时间值。' },
  TIME: { en: 'Builds a time value from hour, minute, and second numbers.', zh: '根据时、分、秒数字构建时间值。' },
  ISOWEEKNUM: { en: 'Returns the ISO-8601 week number of a date (weeks start Monday; week 1 holds the first Thursday of the year).', zh: '返回日期的 ISO-8601 周数（周一为一周的第一天；第 1 周为包含当年第一个周四的那一周）。' },
  YEARFRAC: { en: 'Returns the fraction of a year between two dates, using the US (NASD) 30/360 method (basis 0; other basis values are not supported).', zh: '使用 US（NASD）30/360 方法返回两个日期之间的年份比例（basis 为 0；不支持其他 basis 取值）。' },
  NETWORKDAYS: { en: 'Counts working days (Monday-Friday, inclusive of both dates) between two dates. Holiday exclusion is not supported.', zh: '统计两个日期之间（含首尾两端）的工作日数（周一至周五）。不支持排除节假日。' },
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

// Dry-run (#5b) diagnostics: localized by `kind`, interpolating structured context (fieldId / types /
// Excel-sentinel `code`, all language-neutral). The server `message` is NEVER rendered here.
export type DryRunDiagnosticInput = {
  kind: string
  code?: string
  fieldId?: string
  expectedType?: string
  actualType?: string
}

const DRY_RUN_DIAGNOSTIC_LABELS: Record<string, LocaleText> = {
  unknown_field: { en: 'Unknown field reference: {fieldId}', zh: '未知字段引用：{fieldId}' },
  unsupported: { en: 'Cell/range references (e.g. A1, A1:B3) are not supported in dry-run.', zh: '试算暂不支持单元格/区域引用（如 A1、A1:B3）。' },
  runtime: { en: 'Formula evaluated to an error: {code}', zh: '公式计算出错：{code}' },
  type_mismatch: { en: 'Sample for {fieldId} is {actualType}, but the field type is {expectedType}.', zh: '{fieldId} 的示例值类型为 {actualType}，但字段类型为 {expectedType}。' },
  missing_sample: { en: 'No sample value for {fieldId}; treated as empty.', zh: '{fieldId} 未提供示例值，按空值处理。' },
}

export function localizeDryRunDiagnostic(diagnostic: DryRunDiagnosticInput, isZh: boolean): string {
  const tpl = DRY_RUN_DIAGNOSTIC_LABELS[diagnostic.kind]
  // Unknown future kind → localized generic fallback showing only the raw kind token (language-neutral).
  // NEVER fall back to the server `message` (would leak English into the localized UI — strict-zero).
  if (!tpl) return isZh ? `诊断：${diagnostic.kind}` : `Diagnostic: ${diagnostic.kind}`
  return pick(tpl, isZh)
    .replace('{fieldId}', diagnostic.fieldId ?? '')
    .replace('{code}', diagnostic.code ?? '')
    .replace('{actualType}', diagnostic.actualType ?? '')
    .replace('{expectedType}', diagnostic.expectedType ?? '')
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
