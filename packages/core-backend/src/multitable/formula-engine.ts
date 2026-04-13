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
      if (typeof value === 'string') return `"${value}"`
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
