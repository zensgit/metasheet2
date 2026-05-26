/**
 * Multitable Formula Engine
 * Wraps the base FormulaEngine to resolve field references in multitable records
 * and support cross-table LOOKUP.
 */

import { FormulaEngine, type CellValue, type FormulaContext } from '../formula/engine'
import type { MultitableField } from './field-codecs'
import type { MultitableRecordsQueryFn } from './records'
import { Logger } from '../core/logger'

const logger = new Logger('MultitableFormulaEngine')

/** Regex matching multitable field references like {fld_abc123} */
const FIELD_REF_PATTERN = /\{(fld_[a-zA-Z0-9_]+)\}/g

/** Dry-run (#5a / design #1860): diagnostics + result for an UNSAVED formula expression. */
export type DryRunDiagnosticKind = 'unknown_field' | 'unsupported' | 'runtime' | 'type_mismatch' | 'missing_sample'
export interface DryRunDiagnostic {
  severity: 'error' | 'warning' | 'info'
  kind: DryRunDiagnosticKind
  message: string
  code?: string
}
export interface DryRunResult {
  success: boolean
  result?: CellValue | string
  resultType?: 'number' | 'string' | 'boolean' | 'date' | 'null'
  referencedFields: string[]
  diagnostics: DryRunDiagnostic[]
}

// Excel-style error sentinels the core engine RETURNS (we classify on these — never modify the core).
const EXCEL_ERROR_SENTINELS: ReadonlySet<string> = new Set([
  '#ERROR!', '#DIV/0!', '#N/A', '#VALUE!', '#NAME?', '#NUM!', '#REF!', '#NULL!',
])
// Field types that hold numeric values (for the type-mismatch warning).
const NUMERIC_FIELD_TYPES: ReadonlySet<string> = new Set(['number', 'currency', 'percent', 'rating', 'autoNumber'])

/**
 * Best-effort detector for spreadsheet A1/cell and A1:B3 range references, which dry-run does NOT
 * support (they would resolve via the engine's default DB — design #1860 §3.3). Masks {fld_*} refs
 * and "string" literals first, then looks for a column-letter+row-number token NOT immediately
 * followed by '(' (which would make it a function call like LOG10(...)). Conservative: the no-DB
 * engine is the hard backstop, this gate just gives a clear diagnostic for the common case.
 */
export function detectUnsupportedReferences(expression: string): boolean {
  const masked = expression
    .replace(FIELD_REF_PATTERN, '0')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  // range, e.g. A1:B3 or absolute $A$1:$B$3
  if (/\$?[A-Za-z]{1,3}\$?[0-9]+\s*:\s*\$?[A-Za-z]{1,3}\$?[0-9]+/.test(masked)) return true
  // bare cell ref, e.g. A1 or $A$1 — not immediately followed by '(' (which would make it a function call)
  return /(?:^|[^A-Za-z0-9_$])\$?[A-Za-z]{1,3}\$?[0-9]+(?![0-9A-Za-z_(])/.test(masked)
}

export class MultitableFormulaEngine {
  private engine: FormulaEngine

  constructor(engine?: FormulaEngine) {
    this.engine = engine ?? new FormulaEngine({ db: undefined as any })
  }

  /**
   * Extract all field IDs referenced in a formula expression.
   * Matches patterns like {fld_xxx}.
   */
  extractFieldReferences(formulaExpression: string): string[] {
    const refs: string[] = []
    const seen = new Set<string>()
    let match: RegExpExecArray | null

    // Reset regex lastIndex
    FIELD_REF_PATTERN.lastIndex = 0
    while ((match = FIELD_REF_PATTERN.exec(formulaExpression)) !== null) {
      const fieldId = match[1]
      if (!seen.has(fieldId)) {
        seen.add(fieldId)
        refs.push(fieldId)
      }
    }
    return refs
  }

  /**
   * Evaluate a formula expression in multitable context.
   * Resolves {fieldId} references from recordData before passing to the engine.
   */
  async evaluateField(
    formulaExpression: string,
    recordData: Record<string, unknown>,
    fields: MultitableField[],
  ): Promise<CellValue | string | CellValue[][]> {
    // Strip leading '=' if present
    let expression = formulaExpression
    if (expression.startsWith('=')) {
      expression = expression.substring(1)
    }

    // Replace {fld_xxx} references with actual values from recordData
    const resolved = expression.replace(FIELD_REF_PATTERN, (_match, fieldId: string) => {
      const value = recordData[fieldId]
      if (value === null || value === undefined) return '0'
      if (typeof value === 'string') return JSON.stringify(value)
      if (typeof value === 'number') return String(value)
      if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
      return String(value)
    })

    const context: FormulaContext = {
      sheetId: '',
      spreadsheetId: '',
      currentCell: { row: 0, col: 0 },
      cache: new Map(),
    }

    return this.engine.calculate(`=${resolved}`, context)
  }

  /**
   * Dry-run an UNSAVED formula expression against caller-supplied sample values (design #1860).
   * Runs pre-eval gates (reference-existence + A1/range rejection) BEFORE evaluating, then classifies
   * the engine outcome on what it already exposes (Excel sentinels + a defensive catch). The eval path
   * is in-memory because only {fldId} refs survive the gates; construct this engine with a no-DB
   * FormulaEngine for a hard backstop. NEVER touches the frozen formula/engine.ts core.
   */
  async dryRun(
    expression: string,
    sampleValues: Record<string, unknown>,
    fields: Array<{ id: string; type: string }>,
  ): Promise<DryRunResult> {
    const referencedFields = this.extractFieldReferences(expression)
    const diagnostics: DryRunDiagnostic[] = []

    // Gate (a): every {fldId} reference must exist on the sheet — else evaluateField would substitute
    // a missing ref with '0' and produce a false-green success.
    const fieldById = new Map(fields.map((f) => [f.id, f.type]))
    for (const ref of referencedFields) {
      if (!fieldById.has(ref)) {
        diagnostics.push({ severity: 'error', kind: 'unknown_field', message: `Unknown field reference: {${ref}}` })
      }
    }
    // Gate (b): A1/cell/range references are unsupported (would reach the DB).
    if (detectUnsupportedReferences(expression)) {
      diagnostics.push({ severity: 'error', kind: 'unsupported', message: 'Cell/range references (e.g. A1, A1:B3) are not supported in dry-run' })
    }
    // Either gate failing → do NOT evaluate.
    if (diagnostics.some((d) => d.severity === 'error')) {
      return { success: false, referencedFields, diagnostics }
    }

    // Non-blocking advisories: type mismatch + missing sample (no silent coercion).
    for (const ref of referencedFields) {
      if (!(ref in sampleValues)) {
        diagnostics.push({ severity: 'info', kind: 'missing_sample', message: `No sample value for {${ref}}; treated as empty` })
        continue
      }
      const declared = fieldById.get(ref)!
      const v = sampleValues[ref]
      if (NUMERIC_FIELD_TYPES.has(declared) && v !== null && v !== undefined && typeof v !== 'number') {
        diagnostics.push({ severity: 'warning', kind: 'type_mismatch', message: `Sample for {${ref}} is ${typeof v}, but the field type is ${declared}` })
      }
    }

    let raw: CellValue | string | CellValue[][]
    try {
      raw = await this.evaluateField(expression, sampleValues, fields as MultitableField[])
    } catch (err) {
      // Defensive only: the current engine's calculate() wraps all parse/eval throws into '#ERROR!',
      // so this is unreachable today — kept as a guard against future engine changes.
      diagnostics.push({ severity: 'error', kind: 'runtime', code: 'THROWN', message: (err as Error)?.message ?? String(err) })
      return { success: false, referencedFields, diagnostics }
    }

    // Classify: Excel error sentinel → runtime error; otherwise success with a typed result.
    if (typeof raw === 'string' && EXCEL_ERROR_SENTINELS.has(raw)) {
      diagnostics.push({ severity: 'error', kind: 'runtime', code: raw, message: `Formula evaluated to ${raw}` })
      return { success: false, result: raw, referencedFields, diagnostics }
    }
    if (Array.isArray(raw)) {
      diagnostics.push({ severity: 'error', kind: 'unsupported', message: 'Array/range results are not supported in dry-run' })
      return { success: false, referencedFields, diagnostics }
    }
    const result = raw
    let resultType: DryRunResult['resultType'] = 'null'
    if (typeof result === 'number') resultType = 'number'
    else if (typeof result === 'string') resultType = 'string'
    else if (typeof result === 'boolean') resultType = 'boolean'
    else if (result instanceof Date) resultType = 'date'
    return { success: true, result: result ?? null, resultType, referencedFields, diagnostics }
  }

  /**
   * Cross-table LOOKUP: find exact match in another sheet's records.
   */
  async lookup(
    query: MultitableRecordsQueryFn,
    value: unknown,
    sheetId: string,
    searchFieldId: string,
    resultFieldId: string,
  ): Promise<unknown> {
    try {
      const result = await query(
        `SELECT data FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = $3 LIMIT 1`,
        [sheetId, searchFieldId, String(value)],
      )
      const row = (result.rows as any[])[0]
      if (!row) return '#N/A'

      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
      const fieldValue = data?.[resultFieldId]
      return fieldValue !== undefined ? fieldValue : '#N/A'
    } catch (error) {
      logger.error('Cross-table LOOKUP failed:', error as Error)
      return '#ERROR!'
    }
  }

  /**
   * Recalculate all formula fields for a given record.
   * Loads the record, finds formula fields, evaluates them, and writes computed values back.
   */
  async recalculateRecord(
    query: MultitableRecordsQueryFn,
    sheetId: string,
    recordId: string,
    fields: MultitableField[],
  ): Promise<Record<string, unknown> | null> {
    try {
      const recordRes = await query(
        'SELECT id, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [recordId, sheetId],
      )
      const row = (recordRes.rows as any[])[0]
      if (!row) return null

      const data: Record<string, unknown> =
        typeof row.data === 'string' ? JSON.parse(row.data) : (row.data ?? {})

      const formulaFields = fields.filter(
        (f) => f.type === 'formula' && typeof data[f.id] === 'string' && (data[f.id] as string).startsWith('='),
      )

      if (formulaFields.length === 0) return data

      const updates: Record<string, unknown> = {}
      let changed = false

      for (const field of formulaFields) {
        const expression = data[field.id] as string
        try {
          const result = await this.evaluateField(expression, data, fields)
          updates[field.id] = result
          changed = true
        } catch (error) {
          logger.error(`Failed to evaluate formula for field ${field.id}:`, error as Error)
          updates[field.id] = '#ERROR!'
          changed = true
        }
      }

      if (changed) {
        const nextData = { ...data, ...updates }
        await query(
          `UPDATE meta_records SET data = $1::jsonb, updated_at = now() WHERE id = $2 AND sheet_id = $3`,
          [JSON.stringify(nextData), recordId, sheetId],
        )
        return nextData
      }

      return data
    } catch (error) {
      logger.error('recalculateRecord failed:', error as Error)
      return null
    }
  }
}
