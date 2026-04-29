import type { MetaField } from '../types'

export type FormulaFunctionCategory =
  | 'aggregate'
  | 'math'
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
    name: 'ABS',
    signature: 'ABS(number)',
    category: 'math',
    description: 'Returns the absolute value of a number.',
    example: '=ABS({fld_delta})',
    insertText: 'ABS()',
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
    name: 'CONCAT',
    signature: 'CONCAT(text, ...)',
    category: 'text',
    description: 'Joins text values together.',
    example: '=CONCAT({fld_first_name}, " ", {fld_last_name})',
    insertText: 'CONCAT()',
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
    name: 'TODAY',
    signature: 'TODAY()',
    category: 'date',
    description: 'Returns the current date.',
    example: '=TODAY()',
    insertText: 'TODAY()',
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
    name: 'VLOOKUP',
    signature: 'VLOOKUP(value, table, column, approximate)',
    category: 'lookup',
    description: 'Looks up a value in the first column of a table-like range.',
    example: '=VLOOKUP({fld_sku}, {fld_table}, 2, FALSE)',
    insertText: 'VLOOKUP(, , , FALSE)',
  },
  {
    name: 'MEDIAN',
    signature: 'MEDIAN(number, ...)',
    category: 'statistical',
    description: 'Returns the median of numeric values.',
    example: '=MEDIAN({fld_score_1}, {fld_score_2})',
    insertText: 'MEDIAN()',
  },
]

const FUNCTION_CALL_PATTERN = /\b([A-Z][A-Z0-9_]*)\s*\(/g
const FIELD_REF_PATTERN = /\{([^{}]+)\}/g

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

export function validateFormulaExpression(expression: string, fields: MetaField[]): FormulaDiagnostic[] {
  const diagnostics: FormulaDiagnostic[] = []
  const trimmed = expression.trim()
  if (!trimmed) {
    diagnostics.push({ severity: 'warning', message: 'Formula expression is empty.' })
    return diagnostics
  }

  const openCount = (trimmed.match(/\(/g) ?? []).length
  const closeCount = (trimmed.match(/\)/g) ?? []).length
  if (openCount !== closeCount) {
    diagnostics.push({ severity: 'error', message: 'Parentheses are not balanced.' })
  }

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
