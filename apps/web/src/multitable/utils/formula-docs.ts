import type { MetaField } from '../types'

export interface FormulaFunctionDoc {
  name: string
  signature: string
  category: 'math' | 'text' | 'logic' | 'date' | 'aggregate'
  description: string
  example: string
}

export interface FormulaDiagnostic {
  severity: 'warning' | 'error'
  message: string
}

export const FORMULA_FUNCTION_DOCS: FormulaFunctionDoc[] = [
  {
    name: 'SUM',
    signature: 'SUM(number, ...)',
    category: 'aggregate',
    description: 'Adds numeric values together.',
    example: '=SUM({fld_price}, {fld_tax})',
  },
  {
    name: 'AVERAGE',
    signature: 'AVERAGE(number, ...)',
    category: 'aggregate',
    description: 'Returns the arithmetic mean of numeric values.',
    example: '=AVERAGE({fld_score_1}, {fld_score_2})',
  },
  {
    name: 'MIN',
    signature: 'MIN(number, ...)',
    category: 'aggregate',
    description: 'Returns the smallest numeric value.',
    example: '=MIN({fld_quote_a}, {fld_quote_b})',
  },
  {
    name: 'MAX',
    signature: 'MAX(number, ...)',
    category: 'aggregate',
    description: 'Returns the largest numeric value.',
    example: '=MAX({fld_quote_a}, {fld_quote_b})',
  },
  {
    name: 'IF',
    signature: 'IF(condition, value_if_true, value_if_false)',
    category: 'logic',
    description: 'Chooses one of two values based on a condition.',
    example: '=IF({fld_amount} > 1000, "Large", "Small")',
  },
  {
    name: 'AND',
    signature: 'AND(condition, ...)',
    category: 'logic',
    description: 'Returns true only when all conditions are true.',
    example: '=AND({fld_status} = "Open", {fld_amount} > 0)',
  },
  {
    name: 'OR',
    signature: 'OR(condition, ...)',
    category: 'logic',
    description: 'Returns true when any condition is true.',
    example: '=OR({fld_status} = "Open", {fld_status} = "Pending")',
  },
  {
    name: 'CONCAT',
    signature: 'CONCAT(text, ...)',
    category: 'text',
    description: 'Joins text values together.',
    example: '=CONCAT({fld_first_name}, " ", {fld_last_name})',
  },
  {
    name: 'LEN',
    signature: 'LEN(text)',
    category: 'text',
    description: 'Returns the length of a text value.',
    example: '=LEN({fld_description})',
  },
  {
    name: 'TODAY',
    signature: 'TODAY()',
    category: 'date',
    description: 'Returns the current date.',
    example: '=TODAY()',
  },
  {
    name: 'DATEDIFF',
    signature: 'DATEDIFF(end_date, start_date)',
    category: 'date',
    description: 'Returns the number of days between two dates.',
    example: '=DATEDIFF({fld_due_date}, {fld_start_date})',
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

