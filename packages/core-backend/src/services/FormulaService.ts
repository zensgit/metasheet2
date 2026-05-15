import { FormulaEngine } from '../formula/engine'

const AVAILABLE_FUNCTIONS = Object.freeze([
  'SUM',
  'AVERAGE',
  'COUNT',
  'MAX',
  'MIN',
  'ABS',
  'ROUND',
  'CEILING',
  'FLOOR',
  'IF',
  'AND',
  'OR',
  'NOT',
  'DATE',
  'YEAR',
  'MONTH',
  'DAY',
  'DATEDIF',
  'DATEDIFF',
  'CONCAT',
  'CONCATENATE',
  'LEFT',
  'RIGHT',
  'MID',
  'LEN',
  'TRIM',
  'UPPER',
  'LOWER',
])

function formulaLiteral(value: unknown): string {
  if (value === null || value === undefined || value === '') return '0'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  const parsed = Number(value)
  if (Number.isFinite(parsed) && String(value).trim() !== '') return String(parsed)
  return JSON.stringify(String(value))
}

export class FormulaService {
  private readonly engine = new FormulaEngine()

  async calculate(functionName: string, ...args: unknown[]): Promise<unknown> {
    const name = String(functionName || '').trim()
    if (!name) return '#ERROR!'
    const expression = `=${name}(${args.map(formulaLiteral).join(',')})`
    return this.calculateFormula(expression)
  }

  async calculateFormula(expression: string, contextResolver?: (key: string) => unknown): Promise<unknown> {
    const resolved = String(expression || '').replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
      if (!contextResolver) return '0'
      return formulaLiteral(contextResolver(key))
    })
    const formula = resolved.trim().startsWith('=') ? resolved.trim() : `=${resolved.trim()}`
    return this.engine.calculate(formula, {
      sheetId: 'plugin-formula',
      spreadsheetId: 'plugin-formula',
      currentCell: { row: 0, col: 0 },
      cache: new Map(),
    })
  }

  getAvailableFunctions(): string[] {
    return [...AVAILABLE_FUNCTIONS]
  }
}
