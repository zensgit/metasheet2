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
  message: string // English; for logs/debug only — the client localizes by kind/code (design #1869 §3a)
  code?: string
  // Structured context so the client can render fully-localized templates without parsing `message`.
  fieldId?: string
  expectedType?: string
  actualType?: string
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

    // Replace {fld_xxx} references with actual values from recordData. Complex values must become
    // SAFE literals, never raw-substituted — the old `String(value)` injected `[object Object]`
    // (object) or an unquoted `a,b` (array) straight into the expression, polluting/breaking the
    // parse (A2b hardening; `evaluateField` is shared by record recalc + dry-run).
    let hasUnusableValue = false
    const resolved = expression.replace(FIELD_REF_PATTERN, (_match, fieldId: string) => {
      const value = recordData[fieldId]
      if (value === null || value === undefined) return '0'
      if (typeof value === 'string') return JSON.stringify(value)
      if (typeof value === 'number') return String(value)
      if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
      // multi-value lookup / multiSelect of SCALARS → quoted joined string literal. An array that
      // holds an object/array (e.g. a multi-value lookup of an object/location-valued field — a real
      // lookup shape) is NOT coercible → #VALUE!, never a fake "[object Object]" join.
      if (Array.isArray(value)) {
        const allScalar = value.every(
          (v) => v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
        )
        if (allScalar) return JSON.stringify(value.join(','))
        hasUnusableValue = true
        return '0'
      }
      // any other complex value (e.g. a person/location object) is not a valid formula operand →
      // propagate as an error rather than injecting it (placeholder keeps the replace well-formed)
      hasUnusableValue = true
      return '0'
    })
    // An object-valued reference makes the whole field error (Excel-style propagation) instead of
    // computing against a placeholder.
    if (hasUnusableValue) return '#VALUE!'

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
        diagnostics.push({ severity: 'error', kind: 'unknown_field', fieldId: ref, message: `Unknown field reference: {${ref}}` })
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
        diagnostics.push({ severity: 'info', kind: 'missing_sample', fieldId: ref, message: `No sample value for {${ref}}; treated as empty` })
        continue
      }
      const declared = fieldById.get(ref)!
      const v = sampleValues[ref]
      if (NUMERIC_FIELD_TYPES.has(declared) && v !== null && v !== undefined && typeof v !== 'number') {
        diagnostics.push({ severity: 'warning', kind: 'type_mismatch', fieldId: ref, expectedType: declared, actualType: typeof v, message: `Sample for {${ref}} is ${typeof v}, but the field type is ${declared}` })
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
   * Loads the record (raw) and delegates to recalculateRecordFromData. Use this for callers
   * without an already-hydrated row (e.g. form-submit). The PATCH write-path uses
   * recalculateRecordFromData directly with a row whose lookup/rollup values were hydrated
   * in-memory, so formula-over-lookup sees the actual lookup value (A-min, design #2246).
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

      return await this.recalculateRecordFromData(query, sheetId, recordId, data, fields)
    } catch (error) {
      logger.error('recalculateRecord failed:', error as Error)
      return null
    }
  }

  /**
   * Evaluate + materialize a record's formula fields against PROVIDED `data` (no DB reload).
   * The write-path recalc passes a row whose lookup/rollup values were already hydrated
   * in-memory (via applyLookupRollup) so formulas reference the actual lookup value instead of
   * the absent-on-reload `undefined → '0'` (A-min, design #2246). Only formula keys are written
   * back (`data || $keys`) — lookup/rollup values are NOT materialized. Note: a scalar-array
   * lookup reaches `evaluateField` as a joined string literal per the existing A2b contract;
   * exact numeric arithmetic over lookups is Option D (parser), out of A-min scope.
   */
  async recalculateRecordFromData(
    query: MultitableRecordsQueryFn,
    sheetId: string,
    recordId: string,
    data: Record<string, unknown>,
    fields: MultitableField[],
  ): Promise<Record<string, unknown> | null> {
    try {
      // Resolve each formula field's expression. Field-defined formulas store the
      // expression in `field.property.expression` (the authoring surface + the
      // source `formula_dependencies` is built from). Fall back to a legacy `=…`
      // string persisted directly in the record data so older records / direct
      // writes still compute.
      const formulaTargets = fields.flatMap((field) => {
        if (field.type !== 'formula') return []
        const property = field.property as Record<string, unknown> | undefined
        // The legacy data-string fallback applies ONLY when the field has no
        // `expression` property key at all (older records). If the key is present
        // — even as null / a number / an empty string — the field "defines" an
        // expression and that is the source of truth: a non-empty string is the
        // formula; anything else means "no formula" and must NOT fall through to a
        // possibly-stale `=…` string sitting in record data.
        const hasExpressionKey = !!property && Object.prototype.hasOwnProperty.call(property, 'expression')
        let expression: string | null = null
        if (hasExpressionKey) {
          const fromProperty = property!.expression
          expression = typeof fromProperty === 'string' && fromProperty.trim().length > 0 ? fromProperty : null
        } else if (typeof data[field.id] === 'string' && (data[field.id] as string).startsWith('=')) {
          expression = data[field.id] as string
        }
        return expression ? [{ field, expression }] : []
      })

      if (formulaTargets.length === 0) return data

      const updates: Record<string, unknown> = {}
      for (const { field, expression } of formulaTargets) {
        try {
          updates[field.id] = await this.evaluateField(expression, data, fields)
        } catch (error) {
          logger.error(`Failed to evaluate formula for field ${field.id}:`, error as Error)
          updates[field.id] = '#ERROR!'
        }
      }

      // Merge only the computed formula keys (`data || $patch`) so a concurrent
      // write to other fields between this SELECT and UPDATE is not clobbered. No
      // version bump: formula values are derived, not an authoritative user edit.
      await query(
        `UPDATE meta_records SET data = data || $1::jsonb, updated_at = now() WHERE id = $2 AND sheet_id = $3`,
        [JSON.stringify(updates), recordId, sheetId],
      )
      return { ...data, ...updates }
    } catch (error) {
      logger.error('recalculateRecordFromData failed:', error as Error)
      return null
    }
  }
}
