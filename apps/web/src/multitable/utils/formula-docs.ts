import type { MetaField } from '../types'

export type FormulaFunctionCategory =
  | 'aggregate'
  | 'math'
  | 'operator'
  | 'logic'
  | 'text'
  | 'date'
  | 'lookup'
  | 'statistical'

export interface FormulaFunctionDoc {
  name: string
  signature: string
  category: FormulaFunctionCategory
  description: string
  example: string
  insertText?: string
}

export interface FormulaFunctionCategoryDoc {
  id: FormulaFunctionCategory
  label: string
  description: string
}

export interface FormulaFunctionCatalogSection {
  category: FormulaFunctionCategory
  label: string
  description: string
  functions: FormulaFunctionDoc[]
}

export interface FormulaDiagnostic {
  severity: 'warning' | 'error'
  message: string
}

export const FORMULA_FUNCTION_CATEGORIES: FormulaFunctionCategoryDoc[] = [
  { id: 'aggregate', label: 'Aggregate', description: 'Summarize numeric or non-empty values.' },
  { id: 'math', label: 'Math', description: 'Round, transform, and compare numbers.' },
  { id: 'operator', label: 'Operators', description: 'Combine values with spreadsheet operators.' },
  { id: 'logic', label: 'Logic', description: 'Branch and combine conditions.' },
  { id: 'text', label: 'Text', description: 'Join, slice, and normalize text.' },
  { id: 'date', label: 'Date', description: 'Create or extract date values.' },
  { id: 'lookup', label: 'Lookup', description: 'Find values from arrays or ranges.' },
  { id: 'statistical', label: 'Statistical', description: 'Calculate distribution helpers.' },
]

export const FORMULA_FUNCTION_DOCS: FormulaFunctionDoc[] = [
  {
    name: 'SUM',
    signature: 'SUM(number, ...)',
    category: 'aggregate',
    description: 'Adds numeric values together.',
    example: '=SUM({fld_price}, {fld_tax})',
    insertText: 'SUM()',
  },
  {
    name: 'AVERAGE',
    signature: 'AVERAGE(number, ...)',
    category: 'aggregate',
    description: 'Returns the arithmetic mean of numeric values.',
    example: '=AVERAGE({fld_score_1}, {fld_score_2})',
    insertText: 'AVERAGE()',
  },
  {
    name: 'COUNT',
    signature: 'COUNT(value, ...)',
    category: 'aggregate',
    description: 'Counts numeric values.',
    example: '=COUNT({fld_score_1}, {fld_score_2})',
    insertText: 'COUNT()',
  },
  {
    name: 'COUNTA',
    signature: 'COUNTA(value, ...)',
    category: 'aggregate',
    description: 'Counts values that are not empty.',
    example: '=COUNTA({fld_name}, {fld_status})',
    insertText: 'COUNTA()',
  },
  {
    name: 'MIN',
    signature: 'MIN(number, ...)',
    category: 'aggregate',
    description: 'Returns the smallest numeric value.',
    example: '=MIN({fld_quote_a}, {fld_quote_b})',
    insertText: 'MIN()',
  },
  {
    name: 'MAX',
    signature: 'MAX(number, ...)',
    category: 'aggregate',
    description: 'Returns the largest numeric value.',
    example: '=MAX({fld_quote_a}, {fld_quote_b})',
    insertText: 'MAX()',
  },
  {
    name: 'ROUND',
    signature: 'ROUND(number, digits)',
    category: 'math',
    description: 'Rounds a number to the requested decimal places.',
    example: '=ROUND({fld_amount}, 2)',
    insertText: 'ROUND(, 2)',
  },
  {
    name: 'CEILING',
    signature: 'CEILING(number)',
    category: 'math',
    description: 'Rounds a number up to the nearest integer.',
    example: '=CEILING({fld_amount})',
    insertText: 'CEILING()',
  },
  {
    name: 'FLOOR',
    signature: 'FLOOR(number)',
    category: 'math',
    description: 'Rounds a number down to the nearest integer.',
    example: '=FLOOR({fld_amount})',
    insertText: 'FLOOR()',
  },
  {
    name: 'POWER',
    signature: 'POWER(number, power)',
    category: 'math',
    description: 'Raises a number to a power.',
    example: '=POWER({fld_base}, 2)',
    insertText: 'POWER(, 2)',
  },
  {
    name: 'SQRT',
    signature: 'SQRT(number)',
    category: 'math',
    description: 'Returns the square root of a number.',
    example: '=SQRT({fld_area})',
    insertText: 'SQRT()',
  },
  {
    name: 'MOD',
    signature: 'MOD(number, divisor)',
    category: 'math',
    description: 'Returns the remainder after division.',
    example: '=MOD({fld_index}, 2)',
    insertText: 'MOD(, )',
  },
  {
    name: 'ABS',
    signature: 'ABS(number)',
    category: 'math',
    description: 'Returns the absolute value of a number.',
    example: '=ABS({fld_delta})',
    insertText: 'ABS()',
  },
  {
    name: 'ADD',
    signature: 'left + right',
    category: 'operator',
    description: 'Adds two numeric values. Text numbers are coerced to numbers.',
    example: '={fld_price} + {fld_tax}',
    insertText: '+',
  },
  {
    name: 'SUBTRACT',
    signature: 'left - right',
    category: 'operator',
    description: 'Subtracts the right numeric value from the left value.',
    example: '={fld_budget} - {fld_actual}',
    insertText: '-',
  },
  {
    name: 'MULTIPLY',
    signature: 'left * right',
    category: 'operator',
    description: 'Multiplies two numeric values.',
    example: '={fld_qty} * {fld_price}',
    insertText: '*',
  },
  {
    name: 'DIVIDE',
    signature: 'left / right',
    category: 'operator',
    description: 'Divides the left numeric value by the right value.',
    example: '={fld_total} / {fld_count}',
    insertText: '/',
  },
  {
    name: 'POWER_OPERATOR',
    signature: 'left ^ right',
    category: 'operator',
    description: 'Raises the left numeric value to the power of the right value.',
    example: '={fld_base} ^ 2',
    insertText: '^',
  },
  {
    name: 'PERCENT_OPERATOR',
    signature: 'value%',
    category: 'operator',
    description: 'Converts a number to a percentage value, for example 50% becomes 0.5.',
    example: '={fld_price} * 10%',
    insertText: '10%',
  },
  {
    name: 'CONCAT_OPERATOR',
    signature: 'left & right',
    category: 'operator',
    description: 'Concatenates values as text.',
    example: '={fld_first_name} & " " & {fld_last_name}',
    insertText: '&',
  },
  {
    name: 'COMPARISON',
    signature: '=, <>, >, >=, <, <=',
    category: 'operator',
    description: 'Compares two values and returns TRUE or FALSE.',
    example: '={fld_amount} >= 1000',
    insertText: '>=',
  },
  {
    name: 'IF',
    signature: 'IF(condition, value_if_true, value_if_false)',
    category: 'logic',
    description: 'Chooses one of two values based on a condition.',
    example: '=IF({fld_amount} > 1000, "Large", "Small")',
    insertText: 'IF(, , )',
  },
  {
    name: 'AND',
    signature: 'AND(condition, ...)',
    category: 'logic',
    description: 'Returns true only when all conditions are true.',
    example: '=AND({fld_status} = "Open", {fld_amount} > 0)',
    insertText: 'AND()',
  },
  {
    name: 'OR',
    signature: 'OR(condition, ...)',
    category: 'logic',
    description: 'Returns true when any condition is true.',
    example: '=OR({fld_status} = "Open", {fld_status} = "Pending")',
    insertText: 'OR()',
  },
  {
    name: 'NOT',
    signature: 'NOT(value)',
    category: 'logic',
    description: 'Reverses a boolean value.',
    example: '=NOT({fld_done})',
    insertText: 'NOT()',
  },
  {
    name: 'TRUE',
    signature: 'TRUE()',
    category: 'logic',
    description: 'Returns the boolean value TRUE.',
    example: '=TRUE()',
    insertText: 'TRUE()',
  },
  {
    name: 'FALSE',
    signature: 'FALSE()',
    category: 'logic',
    description: 'Returns the boolean value FALSE.',
    example: '=FALSE()',
    insertText: 'FALSE()',
  },
  {
    name: 'SWITCH',
    signature: 'SWITCH(value, match, result, ..., default)',
    category: 'logic',
    description: 'Returns the result for the first matching value, with an optional default.',
    example: '=SWITCH({fld_status}, "open", "Open", "closed", "Closed", "Other")',
    insertText: 'SWITCH(, , , )',
  },
  {
    name: 'CONCAT',
    signature: 'CONCAT(text, ...)',
    category: 'text',
    description: 'Joins text values together.',
    example: '=CONCAT({fld_first_name}, " ", {fld_last_name})',
    insertText: 'CONCAT()',
  },
  {
    name: 'CONCATENATE',
    signature: 'CONCATENATE(text, ...)',
    category: 'text',
    description: 'Joins text values together.',
    example: '=CONCATENATE({fld_first_name}, " ", {fld_last_name})',
    insertText: 'CONCATENATE()',
  },
  {
    name: 'LEFT',
    signature: 'LEFT(text, chars)',
    category: 'text',
    description: 'Returns characters from the start of a text value.',
    example: '=LEFT({fld_code}, 3)',
    insertText: 'LEFT(, )',
  },
  {
    name: 'RIGHT',
    signature: 'RIGHT(text, chars)',
    category: 'text',
    description: 'Returns characters from the end of a text value.',
    example: '=RIGHT({fld_code}, 4)',
    insertText: 'RIGHT(, )',
  },
  {
    name: 'MID',
    signature: 'MID(text, start, length)',
    category: 'text',
    description: 'Returns characters from the middle of a text value.',
    example: '=MID({fld_code}, 2, 3)',
    insertText: 'MID(, , )',
  },
  {
    name: 'LEN',
    signature: 'LEN(text)',
    category: 'text',
    description: 'Returns the length of a text value.',
    example: '=LEN({fld_description})',
    insertText: 'LEN()',
  },
  {
    name: 'UPPER',
    signature: 'UPPER(text)',
    category: 'text',
    description: 'Converts text to uppercase.',
    example: '=UPPER({fld_code})',
    insertText: 'UPPER()',
  },
  {
    name: 'LOWER',
    signature: 'LOWER(text)',
    category: 'text',
    description: 'Converts text to lowercase.',
    example: '=LOWER({fld_code})',
    insertText: 'LOWER()',
  },
  {
    name: 'TRIM',
    signature: 'TRIM(text)',
    category: 'text',
    description: 'Removes leading and trailing whitespace from text.',
    example: '=TRIM({fld_name})',
    insertText: 'TRIM()',
  },
  {
    name: 'SUBSTITUTE',
    signature: 'SUBSTITUTE(text, old_text, new_text)',
    category: 'text',
    description: 'Replaces all occurrences of old text with new text.',
    example: '=SUBSTITUTE({fld_code}, "-", "")',
    insertText: 'SUBSTITUTE(, , )',
  },
  {
    name: 'NOW',
    signature: 'NOW()',
    category: 'date',
    description: 'Returns the current date and time.',
    example: '=NOW()',
    insertText: 'NOW()',
  },
  {
    name: 'TODAY',
    signature: 'TODAY()',
    category: 'date',
    description: 'Returns the current date.',
    example: '=TODAY()',
    insertText: 'TODAY()',
  },
  {
    name: 'DATE',
    signature: 'DATE(year, month, day)',
    category: 'date',
    description: 'Creates a date from year, month, and day numbers.',
    example: '=DATE(2026, 5, 5)',
    insertText: 'DATE(, , )',
  },
  {
    name: 'DATEDIF',
    signature: 'DATEDIF(start_date, end_date, unit)',
    category: 'date',
    description: 'Returns the difference between two dates using unit D, M, or Y.',
    example: '=DATEDIF({fld_start_date}, {fld_due_date}, "D")',
    insertText: 'DATEDIF(, , "D")',
  },
  {
    name: 'DATEDIFF',
    signature: 'DATEDIFF(end_date, start_date)',
    category: 'date',
    description: 'Returns the number of days between two dates.',
    example: '=DATEDIFF({fld_due_date}, {fld_start_date})',
    insertText: 'DATEDIFF(, )',
  },
  {
    name: 'YEAR',
    signature: 'YEAR(date)',
    category: 'date',
    description: 'Returns the year from a date value.',
    example: '=YEAR({fld_due_date})',
    insertText: 'YEAR()',
  },
  {
    name: 'MONTH',
    signature: 'MONTH(date)',
    category: 'date',
    description: 'Returns the month from a date value.',
    example: '=MONTH({fld_due_date})',
    insertText: 'MONTH()',
  },
  {
    name: 'DAY',
    signature: 'DAY(date)',
    category: 'date',
    description: 'Returns the day of month from a date value.',
    example: '=DAY({fld_due_date})',
    insertText: 'DAY()',
  },
  {
    name: 'VLOOKUP',
    signature: 'VLOOKUP(value, table, column, approximate)',
    category: 'lookup',
    description: 'Looks up a value in the first column of a table-like range.',
    example: '=VLOOKUP({fld_sku}, {fld_table}, 2, FALSE)',
    insertText: 'VLOOKUP(, , , FALSE)',
  },
  {
    name: 'HLOOKUP',
    signature: 'HLOOKUP(value, table, row, approximate)',
    category: 'lookup',
    description: 'Looks up a value in the first row of a table-like range.',
    example: '=HLOOKUP({fld_month}, {fld_table}, 2, FALSE)',
    insertText: 'HLOOKUP(, , , FALSE)',
  },
  {
    name: 'INDEX',
    signature: 'INDEX(range, row, column)',
    category: 'lookup',
    description: 'Returns a value from a range by row and column position.',
    example: '=INDEX({fld_table}, 2, 1)',
    insertText: 'INDEX(, , )',
  },
  {
    name: 'MATCH',
    signature: 'MATCH(value, range, match_type)',
    category: 'lookup',
    description: 'Returns the position of a value in a range.',
    example: '=MATCH({fld_sku}, {fld_table}, 0)',
    insertText: 'MATCH(, , 0)',
  },
  {
    name: 'STDEV',
    signature: 'STDEV(number, ...)',
    category: 'statistical',
    description: 'Returns the sample standard deviation of numeric values.',
    example: '=STDEV({fld_score_1}, {fld_score_2})',
    insertText: 'STDEV()',
  },
  {
    name: 'VAR',
    signature: 'VAR(number, ...)',
    category: 'statistical',
    description: 'Returns the sample variance of numeric values.',
    example: '=VAR({fld_score_1}, {fld_score_2})',
    insertText: 'VAR()',
  },
  {
    name: 'MEDIAN',
    signature: 'MEDIAN(number, ...)',
    category: 'statistical',
    description: 'Returns the median of numeric values.',
    example: '=MEDIAN({fld_score_1}, {fld_score_2})',
    insertText: 'MEDIAN()',
  },
  {
    name: 'MODE',
    signature: 'MODE(number, ...)',
    category: 'statistical',
    description: 'Returns the most common numeric value.',
    example: '=MODE({fld_score_1}, {fld_score_2})',
    insertText: 'MODE()',
  },
]

const FUNCTION_CALL_PATTERN = /\b([A-Z][A-Z0-9_]*)\s*\(/g
const FIELD_REF_PATTERN = /\{([^{}]+)\}/g
const TRAILING_BINARY_OPERATOR_PATTERN = /(?:>=|<=|<>|[+\-*/^&=><])$/

export function searchFormulaFunctionDocs(query: string): FormulaFunctionDoc[] {
  const normalized = query.trim().toUpperCase()
  if (!normalized) return FORMULA_FUNCTION_DOCS
  return FORMULA_FUNCTION_DOCS.filter((doc) =>
    doc.name.includes(normalized)
    || doc.signature.toUpperCase().includes(normalized)
    || doc.description.toUpperCase().includes(normalized),
  )
}

export function getFormulaFunctionCatalog(
  query = '',
  category: FormulaFunctionCategory | 'all' = 'all',
): FormulaFunctionCatalogSection[] {
  const docs = searchFormulaFunctionDocs(query).filter((doc) => category === 'all' || doc.category === category)
  return FORMULA_FUNCTION_CATEGORIES
    .map((categoryDoc) => ({
      category: categoryDoc.id,
      label: categoryDoc.label,
      description: categoryDoc.description,
      functions: docs.filter((doc) => doc.category === categoryDoc.id),
    }))
    .filter((section) => section.functions.length > 0)
}

export function appendFormulaToken(expression: string, token: string): string {
  const current = expression.trimEnd()
  if (!current) return token
  return `${current}${current.endsWith(' ') ? '' : ' '}${token}`
}

export function buildFormulaFieldTokenInsertion(expression: string, fieldId: string): string {
  return appendFormulaToken(expression, `{${fieldId}}`)
}

export function buildFormulaFunctionInsertion(
  expression: string,
  docOrName: FormulaFunctionDoc | string,
): string {
  const token = typeof docOrName === 'string'
    ? `${docOrName.toUpperCase()}()`
    : (docOrName.insertText ?? `${docOrName.name}()`)
  const normalizedToken = expression.trim() ? token : `=${token}`
  return appendFormulaToken(expression, normalizedToken)
}

export function extractFormulaFieldRefs(expression: string): string[] {
  const refs: string[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null
  FIELD_REF_PATTERN.lastIndex = 0
  while ((match = FIELD_REF_PATTERN.exec(expression)) !== null) {
    const ref = match[1]?.trim()
    if (ref && !seen.has(ref)) {
      seen.add(ref)
      refs.push(ref)
    }
  }
  return refs
}

function getFormulaSyntaxDiagnostics(expression: string): FormulaDiagnostic[] {
  const diagnostics: FormulaDiagnostic[] = []
  let parenthesesDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let inQuotes = false
  let escaped = false

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i]

    if (inQuotes) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inQuotes = false
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }

    if (char === '(') {
      parenthesesDepth++
      continue
    }
    if (char === ')') {
      if (parenthesesDepth === 0) {
        diagnostics.push({ severity: 'error', message: 'Unexpected closing parenthesis.' })
      } else {
        parenthesesDepth--
      }
      continue
    }

    if (char === '[') {
      bracketDepth++
      continue
    }
    if (char === ']') {
      if (bracketDepth === 0) {
        diagnostics.push({ severity: 'error', message: 'Unexpected closing array bracket.' })
      } else {
        bracketDepth--
      }
      continue
    }

    if (char === '{') {
      braceDepth++
      continue
    }
    if (char === '}') {
      if (braceDepth === 0) {
        diagnostics.push({ severity: 'error', message: 'Unexpected closing field-reference brace.' })
      } else {
        braceDepth--
      }
    }
  }

  if (inQuotes) {
    diagnostics.push({ severity: 'error', message: 'Quoted string is not closed.' })
  }
  if (parenthesesDepth > 0) {
    diagnostics.push({ severity: 'error', message: 'Parentheses are not balanced.' })
  }
  if (bracketDepth > 0) {
    diagnostics.push({ severity: 'error', message: 'Array brackets are not balanced.' })
  }
  if (braceDepth > 0) {
    diagnostics.push({ severity: 'error', message: 'Field reference braces are not balanced.' })
  }

  const withoutWhitespace = expression.trimEnd()
  if (TRAILING_BINARY_OPERATOR_PATTERN.test(withoutWhitespace)) {
    diagnostics.push({ severity: 'error', message: 'Formula cannot end with a binary operator.' })
  }

  return diagnostics
}

export function validateFormulaExpression(expression: string, fields: MetaField[]): FormulaDiagnostic[] {
  const diagnostics: FormulaDiagnostic[] = []
  const trimmed = expression.trim()
  if (!trimmed) {
    diagnostics.push({ severity: 'warning', message: 'Formula expression is empty.' })
    return diagnostics
  }

  diagnostics.push(...getFormulaSyntaxDiagnostics(trimmed))

  const fieldIds = new Set(fields.map((field) => field.id))
  const fieldNames = new Set(fields.map((field) => field.name))
  for (const ref of extractFormulaFieldRefs(trimmed)) {
    if (fieldIds.has(ref)) continue
    if (fieldNames.has(ref)) {
      diagnostics.push({
        severity: 'warning',
        message: `Field reference {${ref}} uses a name. Use the field chip to insert a stable {fld_xxx} token.`,
      })
      continue
    }
    diagnostics.push({ severity: 'error', message: `Unknown field reference {${ref}}.` })
  }

  const knownFunctions = new Set(FORMULA_FUNCTION_DOCS.map((doc) => doc.name))
  let match: RegExpExecArray | null
  FUNCTION_CALL_PATTERN.lastIndex = 0
  while ((match = FUNCTION_CALL_PATTERN.exec(trimmed.toUpperCase())) !== null) {
    const fn = match[1]
    if (fn && !knownFunctions.has(fn)) {
      diagnostics.push({ severity: 'warning', message: `${fn} is not documented in this editor yet.` })
    }
  }

  return diagnostics
}
