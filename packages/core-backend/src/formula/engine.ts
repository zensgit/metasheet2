/**
 * Formula Calculation Engine
 * Handles formula parsing, dependency resolution, and calculation
 */

import { db, DB } from '../db/db'
import { Logger } from '../core/logger'

const logger = new Logger('FormulaEngine')

export interface CellReference {
  sheet?: string
  row: number
  col: number
  absolute: boolean
}

export interface FormulaContext {
  sheetId: string
  spreadsheetId: string
  currentCell: { row: number; col: number }
  cache: Map<string, any>
}

export class FormulaEngine {
  private functions: Map<string, Function> = new Map()
  private calculationOrder: string[] = []
  private dependencyGraph: Map<string, Set<string>> = new Map()

  constructor() {
    this.registerBuiltinFunctions()
  }

  /**
   * Register built-in spreadsheet functions
   */
  private registerBuiltinFunctions() {
    // Math functions
    this.functions.set('SUM', this.sum.bind(this))
    this.functions.set('AVERAGE', this.average.bind(this))
    this.functions.set('COUNT', this.count.bind(this))
    this.functions.set('MAX', this.max.bind(this))
    this.functions.set('MIN', this.min.bind(this))
    this.functions.set('ABS', (x: number) => Math.abs(x))
    this.functions.set('ROUND', (x: number, digits = 0) => Math.round(x * Math.pow(10, digits)) / Math.pow(10, digits))
    this.functions.set('CEILING', Math.ceil)
    this.functions.set('FLOOR', Math.floor)
    this.functions.set('POWER', Math.pow)
    this.functions.set('SQRT', Math.sqrt)
    this.functions.set('MOD', (a: number, b: number) => a % b)

    // Text functions
    this.functions.set('CONCATENATE', this.concatenate.bind(this))
    this.functions.set('LEFT', (text: string, chars: number) => text.substring(0, chars))
    this.functions.set('RIGHT', (text: string, chars: number) => text.substring(text.length - chars))
    this.functions.set('MID', (text: string, start: number, length: number) => text.substring(start - 1, start - 1 + length))
    this.functions.set('LEN', (text: string) => text.length)
    this.functions.set('UPPER', (text: string) => text.toUpperCase())
    this.functions.set('LOWER', (text: string) => text.toLowerCase())
    this.functions.set('TRIM', (text: string) => text.trim())
    this.functions.set('SUBSTITUTE', (text: string, old: string, newText: string) => text.replace(new RegExp(old, 'g'), newText))

    // Logical functions
    this.functions.set('IF', this.ifFunction.bind(this))
    this.functions.set('AND', this.andFunction.bind(this))
    this.functions.set('OR', this.orFunction.bind(this))
    this.functions.set('NOT', (value: any) => !value)
    this.functions.set('TRUE', () => true)
    this.functions.set('FALSE', () => false)

    // Date functions
    this.functions.set('NOW', () => new Date())
    this.functions.set('TODAY', () => {
      const date = new Date()
      date.setHours(0, 0, 0, 0)
      return date
    })
    this.functions.set('DATE', (year: number, month: number, day: number) => new Date(year, month - 1, day))
    this.functions.set('YEAR', (date: Date) => date.getFullYear())
    this.functions.set('MONTH', (date: Date) => date.getMonth() + 1)
    this.functions.set('DAY', (date: Date) => date.getDate())

    // Lookup functions
    this.functions.set('VLOOKUP', this.vlookup.bind(this))
    this.functions.set('HLOOKUP', this.hlookup.bind(this))
    this.functions.set('INDEX', this.index.bind(this))
    this.functions.set('MATCH', this.match.bind(this))

    // Statistical functions
    this.functions.set('STDEV', this.stdev.bind(this))
    this.functions.set('VAR', this.variance.bind(this))
    this.functions.set('MEDIAN', this.median.bind(this))
    this.functions.set('MODE', this.mode.bind(this))
  }

  /**
   * Parse and calculate a formula
   */
  async calculate(formula: string, context: FormulaContext): Promise<any> {
    try {
      // Remove leading '=' if present
      if (formula.startsWith('=')) {
        formula = formula.substring(1)
      }

      // Parse the formula into an AST
      const ast = this.parseFormula(formula)

      // Evaluate the AST
      return await this.evaluateAST(ast, context)
    } catch (error) {
      logger.error('Formula calculation error:', error as Error)
      return '#ERROR!'
    }
  }

  /**
   * Parse formula string into AST
   */
  private parseFormula(formula: string): any {
    // Simple tokenizer and parser (simplified for demo)
    // In production, use a proper parser like PEG.js or write a full recursive descent parser

    // Check if it's a function call
    const functionMatch = formula.match(/^([A-Z]+)\((.*)\)$/)
    if (functionMatch) {
      const functionName = functionMatch[1]
      const args = this.parseArguments(functionMatch[2])
      return {
        type: 'function',
        name: functionName,
        arguments: args
      }
    }

    // Check if it's a cell reference
    const cellMatch = formula.match(/^([A-Z]+)(\d+)$/)
    if (cellMatch) {
      return {
        type: 'cell',
        col: this.columnLetterToIndex(cellMatch[1]),
        row: parseInt(cellMatch[2]) - 1
      }
    }

    // Check if it's a range
    const rangeMatch = formula.match(/^([A-Z]+\d+):([A-Z]+\d+)$/)
    if (rangeMatch) {
      const start = this.parseCellReference(rangeMatch[1])
      const end = this.parseCellReference(rangeMatch[2])
      return {
        type: 'range',
        start,
        end
      }
    }

    // Check if it's a number
    const num = parseFloat(formula)
    if (!isNaN(num)) {
      return { type: 'number', value: num }
    }

    // Check if it's a string (quoted)
    if (formula.startsWith('"') && formula.endsWith('"')) {
      return { type: 'string', value: formula.slice(1, -1) }
    }

    // Check for operators
    const operators = ['+', '-', '*', '/', '=', '>', '<', '>=', '<=', '<>']
    for (const op of operators) {
      const parts = formula.split(op)
      if (parts.length === 2) {
        return {
          type: 'operator',
          operator: op,
          left: this.parseFormula(parts[0].trim()),
          right: this.parseFormula(parts[1].trim())
        }
      }
    }

    // Default to string
    return { type: 'string', value: formula }
  }

  /**
   * Parse function arguments
   */
  private parseArguments(argsString: string): any[] {
    const args: any[] = []
    let current = ''
    let depth = 0
    let inQuotes = false

    for (let i = 0; i < argsString.length; i++) {
      const char = argsString[i]

      if (char === '"' && (i === 0 || argsString[i - 1] !== '\\')) {
        inQuotes = !inQuotes
      }

      if (!inQuotes) {
        if (char === '(') depth++
        if (char === ')') depth--
        if (char === ',' && depth === 0) {
          args.push(this.parseFormula(current.trim()))
          current = ''
          continue
        }
      }

      current += char
    }

    if (current.trim()) {
      args.push(this.parseFormula(current.trim()))
    }

    return args
  }

  /**
   * Evaluate AST node
   */
  private async evaluateAST(node: any, context: FormulaContext): Promise<any> {
    switch (node.type) {
      case 'number':
        return node.value

      case 'string':
        return node.value

      case 'cell':
        return await this.getCellValue(node.row, node.col, context)

      case 'range':
        return await this.getRangeValues(node.start, node.end, context)

      case 'function':
        const func = this.functions.get(node.name)
        if (!func) {
          throw new Error(`Unknown function: ${node.name}`)
        }
        const args = await Promise.all(
          node.arguments.map((arg: any) => this.evaluateAST(arg, context))
        )
        return func(...args)

      case 'operator':
        const left = await this.evaluateAST(node.left, context)
        const right = await this.evaluateAST(node.right, context)
        return this.evaluateOperator(node.operator, left, right)

      default:
        throw new Error(`Unknown node type: ${node.type}`)
    }
  }

  /**
   * Evaluate binary operator
   */
  private evaluateOperator(operator: string, left: any, right: any): any {
    switch (operator) {
      case '+': return left + right
      case '-': return left - right
      case '*': return left * right
      case '/': return right === 0 ? '#DIV/0!' : left / right
      case '=': return left === right
      case '>': return left > right
      case '<': return left < right
      case '>=': return left >= right
      case '<=': return left <= right
      case '<>': return left !== right
      default:
        throw new Error(`Unknown operator: ${operator}`)
    }
  }

  /**
   * Get cell value from database
   */
  private async getCellValue(row: number, col: number, context: FormulaContext): Promise<any> {
    const cacheKey = `${context.sheetId}:${row}:${col}`

    if (context.cache.has(cacheKey)) {
      return context.cache.get(cacheKey)
    }

    if (!db) return null

    const cell = await db
      .selectFrom('cells')
      .select(['value', 'formula', 'data_type'])
      .where('sheet_id', '=', context.sheetId)
      .where('row_index', '=', row)
      .where('column_index', '=', col)
      .executeTakeFirst()

    if (!cell) return null

    let value = cell.value

    // Convert based on data type
    if (cell.data_type === 'number') {
      value = parseFloat(value!)
    } else if (cell.data_type === 'boolean') {
      value = value === 'true' || value === '1'
    } else if (cell.data_type === 'date') {
      value = new Date(value!)
    }

    // If cell has a formula, calculate it
    if (cell.formula) {
      value = await this.calculate(cell.formula, context)
    }

    context.cache.set(cacheKey, value)
    return value
  }

  /**
   * Get range of cell values
   */
  private async getRangeValues(start: any, end: any, context: FormulaContext): Promise<any[][]> {
    const values: any[][] = []

    for (let row = start.row; row <= end.row; row++) {
      const rowValues: any[] = []
      for (let col = start.col; col <= end.col; col++) {
        const value = await this.getCellValue(row, col, context)
        rowValues.push(value)
      }
      values.push(rowValues)
    }

    return values
  }

  /**
   * Parse cell reference string
   */
  private parseCellReference(ref: string): { row: number; col: number } {
    const match = ref.match(/^([A-Z]+)(\d+)$/)
    if (!match) throw new Error(`Invalid cell reference: ${ref}`)

    return {
      col: this.columnLetterToIndex(match[1]),
      row: parseInt(match[2]) - 1
    }
  }

  /**
   * Convert column letter to index
   */
  private columnLetterToIndex(letter: string): number {
    return letter
      .split('')
      .reduce((acc, char) => acc * 26 + char.charCodeAt(0) - 64, 0) - 1
  }

  // Built-in function implementations

  private sum(...args: any[]): number {
    return this.flattenValues(args).reduce((acc, val) => acc + (parseFloat(val) || 0), 0)
  }

  private average(...args: any[]): number {
    const values = this.flattenValues(args)
    const sum = values.reduce((acc, val) => acc + (parseFloat(val) || 0), 0)
    return sum / values.length
  }

  private count(...args: any[]): number {
    return this.flattenValues(args).filter(val => val !== null && val !== '').length
  }

  private max(...args: any[]): number {
    return Math.max(...this.flattenValues(args).map(val => parseFloat(val) || 0))
  }

  private min(...args: any[]): number {
    return Math.min(...this.flattenValues(args).map(val => parseFloat(val) || 0))
  }

  private concatenate(...args: any[]): string {
    return this.flattenValues(args).join('')
  }

  private ifFunction(condition: any, trueValue: any, falseValue: any): any {
    return condition ? trueValue : falseValue
  }

  private andFunction(...args: any[]): boolean {
    return this.flattenValues(args).every(val => !!val)
  }

  private orFunction(...args: any[]): boolean {
    return this.flattenValues(args).some(val => !!val)
  }

  private vlookup(lookupValue: any, range: any[][], colIndex: number, exactMatch = true): any {
    for (const row of range) {
      if (exactMatch ? row[0] === lookupValue : row[0] >= lookupValue) {
        return row[colIndex - 1]
      }
    }
    return '#N/A'
  }

  private hlookup(lookupValue: any, range: any[][], rowIndex: number, exactMatch = true): any {
    if (!range[0]) return '#N/A'

    const colIndex = range[0].findIndex((val: any) =>
      exactMatch ? val === lookupValue : val >= lookupValue
    )

    if (colIndex === -1) return '#N/A'
    return range[rowIndex - 1]?.[colIndex] ?? '#N/A'
  }

  private index(range: any[][], row: number, col?: number): any {
    if (col === undefined) {
      return range[row - 1]
    }
    return range[row - 1]?.[col - 1] ?? '#REF!'
  }

  private match(lookupValue: any, lookupArray: any[], matchType = 0): number {
    for (let i = 0; i < lookupArray.length; i++) {
      if (matchType === 0 && lookupArray[i] === lookupValue) {
        return i + 1
      } else if (matchType === 1 && lookupArray[i] <= lookupValue) {
        if (i === lookupArray.length - 1 || lookupArray[i + 1] > lookupValue) {
          return i + 1
        }
      } else if (matchType === -1 && lookupArray[i] >= lookupValue) {
        return i + 1
      }
    }
    return -1
  }

  private stdev(...args: any[]): number {
    const values = this.flattenValues(args).map(val => parseFloat(val) || 0)
    const mean = values.reduce((a, b) => a + b) / values.length
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2))
    const variance = squaredDiffs.reduce((a, b) => a + b) / (values.length - 1)
    return Math.sqrt(variance)
  }

  private variance(...args: any[]): number {
    const values = this.flattenValues(args).map(val => parseFloat(val) || 0)
    const mean = values.reduce((a, b) => a + b) / values.length
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2))
    return squaredDiffs.reduce((a, b) => a + b) / values.length
  }

  private median(...args: any[]): number {
    const values = this.flattenValues(args)
      .map(val => parseFloat(val) || 0)
      .sort((a, b) => a - b)

    const mid = Math.floor(values.length / 2)
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2
  }

  private mode(...args: any[]): any {
    const values = this.flattenValues(args)
    const counts = new Map<any, number>()

    for (const val of values) {
      counts.set(val, (counts.get(val) || 0) + 1)
    }

    let maxCount = 0
    let mode = null

    for (const [val, count] of counts.entries()) {
      if (count > maxCount) {
        maxCount = count
        mode = val
      }
    }

    return mode
  }

  /**
   * Flatten nested arrays into single array
   */
  private flattenValues(args: any[]): any[] {
    const result: any[] = []

    for (const arg of args) {
      if (Array.isArray(arg)) {
        if (Array.isArray(arg[0])) {
          // 2D array (range)
          for (const row of arg) {
            result.push(...row)
          }
        } else {
          // 1D array
          result.push(...arg)
        }
      } else {
        result.push(arg)
      }
    }

    return result
  }

  /**
   * Build dependency graph for a sheet
   */
  async buildDependencyGraph(sheetId: string): Promise<void> {
    if (!db) return

    const formulas = await db
      .selectFrom('formulas')
      .select(['cell_id', 'dependencies', 'dependents'])
      .where('sheet_id', '=', sheetId)
      .execute()

    this.dependencyGraph.clear()

    for (const formula of formulas) {
      const deps = formula.dependencies as string[]
      this.dependencyGraph.set(formula.cell_id, new Set(deps))
    }

    // Calculate topological order for calculation
    this.calculationOrder = this.topologicalSort()
  }

  /**
   * Topological sort for calculation order
   */
  private topologicalSort(): string[] {
    const visited = new Set<string>()
    const result: string[] = []

    const visit = (node: string) => {
      if (visited.has(node)) return
      visited.add(node)

      const deps = this.dependencyGraph.get(node)
      if (deps) {
        for (const dep of deps) {
          visit(dep)
        }
      }

      result.push(node)
    }

    for (const node of this.dependencyGraph.keys()) {
      visit(node)
    }

    return result
  }
}

// Export singleton instance
export const formulaEngine = new FormulaEngine()