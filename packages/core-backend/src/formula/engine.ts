/**
 * Formula Calculation Engine
 * Handles formula parsing, dependency resolution, and calculation
 */

import type { Kysely } from 'kysely'
import { db as defaultDb } from '../db/db'
import type { Database } from '../db/types'
import { Logger } from '../core/logger'

const logger = new Logger('FormulaEngine')

export interface CellReference {
  sheet?: string
  row: number
  col: number
  absolute: boolean
}

// Cell value can be various types
export type CellValue = string | number | boolean | Date | null | undefined

export interface FormulaContext {
  sheetId: string
  spreadsheetId: string
  currentCell: { row: number; col: number }
  cache: Map<string, CellValue>
}

// AST Node Types
export interface ASTNode {
  type: 'number' | 'boolean' | 'null' | 'array' | 'string' | 'cell' | 'range' | 'error' | 'function' | 'operator'
}

export interface NumberNode extends ASTNode {
  type: 'number'
  value: number
}

export interface BooleanNode extends ASTNode {
  type: 'boolean'
  value: boolean
}

export interface NullNode extends ASTNode {
  type: 'null'
  value: null
}

export interface ArrayNode extends ASTNode {
  type: 'array'
  value: unknown[]
}

export interface StringNode extends ASTNode {
  type: 'string'
  value: string
}

export interface CellNode extends ASTNode {
  type: 'cell'
  row: number
  col: number
}

export interface RangeNode extends ASTNode {
  type: 'range'
  start: { row: number; col: number }
  end: { row: number; col: number }
}

export interface ErrorNode extends ASTNode {
  type: 'error'
  value: string
}

export interface FunctionNode extends ASTNode {
  type: 'function'
  name: string
  arguments: ASTNodeUnion[]
}

export interface OperatorNode extends ASTNode {
  type: 'operator'
  operator: string
  left: ASTNodeUnion
  right: ASTNodeUnion
}

export type ASTNodeUnion =
  | NumberNode
  | BooleanNode
  | NullNode
  | ArrayNode
  | StringNode
  | CellNode
  | RangeNode
  | ErrorNode
  | FunctionNode
  | OperatorNode

// Function type for spreadsheet functions
type SpreadsheetFunction = (...args: unknown[]) => unknown

export class FormulaEngine {
  private db: Pick<Kysely<Database>, 'selectFrom'> | null
  private functions: Map<string, SpreadsheetFunction> = new Map()
  private calculationOrder: string[] = []
  private dependencyGraph: Map<string, Set<string>> = new Map()

  constructor(options: { db?: Pick<Kysely<Database>, 'selectFrom'> } = {}) {
    this.db = options.db ?? defaultDb
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
    this.functions.set('ABS', (x: unknown) => Math.abs(Number(x)))
    this.functions.set('ROUND', (x: unknown, digits: unknown = 0) => {
      const num = Number(x)
      const d = Number(digits)
      return Math.round(num * Math.pow(10, d)) / Math.pow(10, d)
    })
    this.functions.set('CEILING', (x: unknown) => Math.ceil(Number(x)))
    this.functions.set('FLOOR', (x: unknown) => Math.floor(Number(x)))
    this.functions.set('POWER', (a: unknown, b: unknown) => Math.pow(Number(a), Number(b)))
    this.functions.set('SQRT', (x: unknown) => Math.sqrt(Number(x)))
    this.functions.set('MOD', (a: unknown, b: unknown) => Number(a) % Number(b))

    // Text functions
    this.functions.set('CONCATENATE', this.concatenate.bind(this))
    this.functions.set('LEFT', (text: unknown, chars: unknown) => String(text).substring(0, Number(chars)))
    this.functions.set('RIGHT', (text: unknown, chars: unknown) => {
      const str = String(text)
      return str.substring(str.length - Number(chars))
    })
    this.functions.set('MID', (text: unknown, start: unknown, length: unknown) => {
      const str = String(text)
      const s = Number(start)
      const l = Number(length)
      return str.substring(s - 1, s - 1 + l)
    })
    this.functions.set('LEN', (text: unknown) => String(text).length)
    this.functions.set('UPPER', (text: unknown) => String(text).toUpperCase())
    this.functions.set('LOWER', (text: unknown) => String(text).toLowerCase())
    this.functions.set('TRIM', (text: unknown) => String(text).trim())
    this.functions.set('SUBSTITUTE', (text: unknown, old: unknown, newText: unknown) =>
      String(text).replace(new RegExp(String(old), 'g'), String(newText))
    )

    // Logical functions
    this.functions.set('IF', this.ifFunction.bind(this))
    this.functions.set('AND', this.andFunction.bind(this))
    this.functions.set('OR', this.orFunction.bind(this))
    this.functions.set('NOT', (value: unknown) => !value)
    this.functions.set('TRUE', () => true)
    this.functions.set('FALSE', () => false)

    // Date functions
    this.functions.set('NOW', () => new Date())
    this.functions.set('TODAY', () => {
      const date = new Date()
      date.setHours(0, 0, 0, 0)
      return date
    })
    this.functions.set('DATE', (year: unknown, month: unknown, day: unknown) =>
      new Date(Number(year), Number(month) - 1, Number(day))
    )
    this.functions.set('YEAR', (date: unknown) => {
      const d = date instanceof Date ? date : new Date(String(date))
      return d.getFullYear()
    })
    this.functions.set('MONTH', (date: unknown) => {
      const d = date instanceof Date ? date : new Date(String(date))
      return d.getMonth() + 1
    })
    this.functions.set('DAY', (date: unknown) => {
      const d = date instanceof Date ? date : new Date(String(date))
      return d.getDate()
    })

    // Lookup functions - these need wrapper functions for proper typing
    this.functions.set('VLOOKUP', (...args: unknown[]) => this.vlookup(args[0], args[1], args[2], args[3]))
    this.functions.set('HLOOKUP', (...args: unknown[]) => this.hlookup(args[0], args[1], args[2], args[3]))
    this.functions.set('INDEX', (...args: unknown[]) => this.index(args[0], args[1], args[2]))
    this.functions.set('MATCH', (...args: unknown[]) => this.match(args[0], args[1], args[2]))

    // Statistical functions
    this.functions.set('STDEV', this.stdev.bind(this))
    this.functions.set('VAR', this.variance.bind(this))
    this.functions.set('MEDIAN', this.median.bind(this))
    this.functions.set('MODE', this.mode.bind(this))
  }

  /**
   * Parse and calculate a formula
   */
  async calculate(formula: string, context: FormulaContext): Promise<CellValue | string | CellValue[][]> {
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
  private parseFormula(formula: string): ASTNodeUnion {
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

    // Check for operators
    // Sort operators by length descending to match >= before >
    const operators = ['>=', '<=', '<>', '+', '-', '*', '/', '=', '>', '<']
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

    // Check if it's a boolean
    if (formula.toUpperCase() === 'TRUE') return { type: 'boolean', value: true }
    if (formula.toUpperCase() === 'FALSE') return { type: 'boolean', value: false }
    if (formula.toUpperCase() === 'NULL') return { type: 'null', value: null }

    // Check if it's a number
    const num = parseFloat(formula)
    if (!isNaN(num) && isFinite(num) && !formula.includes(' ')) {
       // Only treat as number if it parses fully and doesn't contain spaces (to avoid "5 + 3" -> 5)
       // Actually parseFloat("5 + 3") is 5.
       // We want to avoid treating "5 + 3" as number 5.
       // If the string contains spaces and parses as number, it might be partial match.
       // But " 5 " is valid number.
       // "5 + 3" is NOT a valid number representation in strict sense.
       // Number() constructor is stricter than parseFloat.
       const strictNum = Number(formula)
       if (!isNaN(strictNum)) {
         return { type: 'number', value: strictNum }
       }
    }

    // Check if it's a string (quoted)
    if (formula.startsWith('"') && formula.endsWith('"')) {
      return { type: 'string', value: formula.slice(1, -1) }
    }

    // Check if it's an array literal (e.g. [[1, 2], [3, 4]])
    if (formula.startsWith('[') && formula.endsWith(']')) {
      try {
        const arr = JSON.parse(formula)
        if (Array.isArray(arr)) {
          return { type: 'array', value: arr }
        }
      } catch (e) {
        // Not valid JSON array, continue
      }
    }

    // Check for invalid syntax (e.g. unclosed parenthesis)
    if (formula.includes('(') && !formula.includes(')')) {
      return { type: 'error', value: '#ERROR!' }
    }

    // Default to string (identifier or unquoted string)
    if (!formula.startsWith('"') && /^[A-Z_][A-Z0-9_]*$/.test(formula)) {
       // Looks like identifier but wasn't matched as function or cell
       return { type: 'error', value: '#ERROR!' }
    }

    return { type: 'string', value: formula }
  }

  /**
   * Parse function arguments
   */
  private parseArguments(argsString: string): ASTNodeUnion[] {
    const args: ASTNodeUnion[] = []
    let current = ''
    let depth = 0
    let inQuotes = false

    for (let i = 0; i < argsString.length; i++) {
      const char = argsString[i]

      if (char === '"' && (i === 0 || argsString[i - 1] !== '\\')) {
        inQuotes = !inQuotes
      }

      if (!inQuotes) {
        if (char === '(' || char === '[') depth++
        if (char === ')' || char === ']') depth--
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
  private async evaluateAST(node: ASTNodeUnion, context: FormulaContext): Promise<CellValue | string | CellValue[][]> {
    switch (node.type) {
      case 'number':
        return node.value

      case 'boolean':
        return node.value

      case 'null':
        return null

      case 'array':
        return node.value as CellValue[][]

      case 'string':
        return node.value

      case 'cell':
        return await this.getCellValue(node.row, node.col, context)

      case 'range':
        return await this.getRangeValues(node.start, node.end, context)

      case 'error':
        return node.value

      case 'function': {
        const func = this.functions.get(node.name)
        if (!func) {
          throw new Error(`Unknown function: ${node.name}`)
        }
        const args = await Promise.all(
          node.arguments.map((arg: ASTNodeUnion) => this.evaluateAST(arg, context))
        )
        return func(...args) as CellValue | string | CellValue[][]
      }

      case 'operator': {
        const left = await this.evaluateAST(node.left, context)
        const right = await this.evaluateAST(node.right, context)
        return this.evaluateOperator(node.operator, left, right)
      }

      default:
        throw new Error(`Unknown node type: ${(node as ASTNode).type}`)
    }
  }

  /**
   * Evaluate binary operator
   */
  private evaluateOperator(operator: string, left: unknown, right: unknown): number | boolean | string {
    switch (operator) {
      case '+': return (left as number) + (right as number)
      case '-': return (left as number) - (right as number)
      case '*': return (left as number) * (right as number)
      case '/': return right === 0 ? '#DIV/0!' : (left as number) / (right as number)
      case '=': return left === right
      case '>': return (left as number) > (right as number)
      case '<': return (left as number) < (right as number)
      case '>=': return (left as number) >= (right as number)
      case '<=': return (left as number) <= (right as number)
      case '<>': return left !== right
      default:
        throw new Error(`Unknown operator: ${operator}`)
    }
  }

  /**
   * Get cell value from database
   */
  private async getCellValue(row: number, col: number, context: FormulaContext): Promise<CellValue | string> {
    const cacheKey = `${context.sheetId}:${row}:${col}`

    if (context.cache.has(cacheKey)) {
      return context.cache.get(cacheKey)!
    }

    if (!this.db) {
      logger.warn('getCellValue: db is undefined')
      return null
    }

    const cell = await this.db
      .selectFrom('cells')
      .select(['value', 'formula', 'data_type'])
      .where('sheet_id', '=', context.sheetId)
      .where('row_index', '=', row)
      .where('column_index', '=', col)
      .executeTakeFirst()

    if (!cell) {
      return '#ERROR!'
    }

    // Extract actual value from JSONB column - may be stored as {value: x} or directly as primitive
    const rawValue = cell.value
    let value: CellValue | string = rawValue === null ? null :
      typeof rawValue === 'object' && 'value' in rawValue ? (rawValue as { value: CellValue }).value :
      rawValue as unknown as CellValue

    // Convert based on data type
    if (cell.data_type === 'number' && typeof value === 'string') {
      value = parseFloat(value)
    } else if (cell.data_type === 'boolean' && typeof value === 'string') {
      value = value === 'true' || value === '1'
    } else if (cell.data_type === 'date' && typeof value === 'string') {
      value = new Date(value)
    }

    // If cell has a formula, calculate it
    if (cell.formula) {
      const calculated = await this.calculate(cell.formula, context)
      // Only store simple cell values in cache, not arrays
      if (!Array.isArray(calculated)) {
        value = calculated
      }
    }

    // Only cache simple cell values
    if (!Array.isArray(value)) {
      context.cache.set(cacheKey, value as CellValue)
    }
    return value
  }

  /**
   * Get range of cell values
   */
  private async getRangeValues(start: { row: number; col: number }, end: { row: number; col: number }, context: FormulaContext): Promise<CellValue[][]> {
    const values: CellValue[][] = []

    for (let row = start.row; row <= end.row; row++) {
      const rowValues: CellValue[] = []
      for (let col = start.col; col <= end.col; col++) {
        const value = await this.getCellValue(row, col, context)
        // Arrays shouldn't be nested in ranges, take first value if array
        if (Array.isArray(value)) {
          rowValues.push(value[0]?.[0] ?? null)
        } else {
          rowValues.push(value as CellValue)
        }
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

  private sum(...args: unknown[]): number {
    const values = this.flattenValues(args)
    return values.reduce<number>((acc, val) => acc + (parseFloat(String(val)) || 0), 0)
  }

  private average(...args: unknown[]): number {
    const values = this.flattenValues(args)
    const sum = values.reduce<number>((acc, val) => acc + (parseFloat(String(val)) || 0), 0)
    return sum / values.length
  }

  private count(...args: unknown[]): number {
    return this.flattenValues(args).filter(val => val !== null && val !== '').length
  }

  private max(...args: unknown[]): number {
    return Math.max(...this.flattenValues(args).map(val => parseFloat(String(val)) || 0))
  }

  private min(...args: unknown[]): number {
    return Math.min(...this.flattenValues(args).map(val => parseFloat(String(val)) || 0))
  }

  private concatenate(...args: unknown[]): string {
    return this.flattenValues(args).join('')
  }

  private ifFunction(condition: unknown, trueValue: unknown, falseValue: unknown): unknown {
    return condition ? trueValue : falseValue
  }

  private andFunction(...args: unknown[]): boolean {
    return this.flattenValues(args).every(val => !!val)
  }

  private orFunction(...args: unknown[]): boolean {
    return this.flattenValues(args).some(val => !!val)
  }

  private vlookup(lookupValue: unknown, range: unknown, colIndex: unknown, exactMatch: unknown = true): unknown {
    const rangeArray = range as unknown[][]
    const colIdx = Number(colIndex)
    const exact = Boolean(exactMatch)

    for (const row of rangeArray) {
      const rowArray = row as unknown[]
      if (exact ? rowArray[0] === lookupValue : (rowArray[0] as number) >= (lookupValue as number)) {
        return rowArray[colIdx - 1]
      }
    }
    return '#N/A'
  }

  private hlookup(lookupValue: unknown, range: unknown, rowIndex: unknown, exactMatch: unknown = true): unknown {
    const rangeArray = range as unknown[][]
    const rowIdx = Number(rowIndex)
    const exact = Boolean(exactMatch)

    if (!rangeArray[0]) return '#N/A'

    const firstRow = rangeArray[0] as unknown[]
    const colIndex = firstRow.findIndex((val: unknown) =>
      exact ? val === lookupValue : (val as number) >= (lookupValue as number)
    )

    if (colIndex === -1) return '#N/A'
    const targetRow = rangeArray[rowIdx - 1] as unknown[] | undefined
    return targetRow?.[colIndex] ?? '#N/A'
  }

  private index(range: unknown, row: unknown, col?: unknown): unknown {
    const rangeArray = range as unknown[][]
    const rowNum = Number(row)

    if (col === undefined) {
      return rangeArray[rowNum - 1]
    }
    const colNum = Number(col)
    const targetRow = rangeArray[rowNum - 1] as unknown[] | undefined
    return targetRow?.[colNum - 1] ?? '#REF!'
  }

  private match(lookupValue: unknown, lookupArray: unknown, matchType: unknown = 0): number {
    const array = lookupArray as unknown[]
    const type = Number(matchType)

    for (let i = 0; i < array.length; i++) {
      if (type === 0 && array[i] === lookupValue) {
        return i + 1
      } else if (type === 1 && (array[i] as number) <= (lookupValue as number)) {
        if (i === array.length - 1 || (array[i + 1] as number) > (lookupValue as number)) {
          return i + 1
        }
      } else if (type === -1 && (array[i] as number) >= (lookupValue as number)) {
        return i + 1
      }
    }
    return -1
  }

  private stdev(...args: unknown[]): number {
    const values = this.flattenValues(args).map(val => parseFloat(String(val)) || 0)
    const mean = values.reduce((a, b) => a + b) / values.length
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2))
    const variance = squaredDiffs.reduce((a, b) => a + b) / (values.length - 1)
    return Math.sqrt(variance)
  }

  private variance(...args: unknown[]): number {
    const values = this.flattenValues(args).map(val => parseFloat(String(val)) || 0)
    const mean = values.reduce((a, b) => a + b) / values.length
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2))
    return squaredDiffs.reduce((a, b) => a + b) / (values.length - 1)
  }

  private median(...args: unknown[]): number {
    const values = this.flattenValues(args)
      .map(val => parseFloat(String(val)) || 0)
      .sort((a, b) => a - b)

    const mid = Math.floor(values.length / 2)
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2
  }

  private mode(...args: unknown[]): unknown {
    const values = this.flattenValues(args)
    const counts = new Map<unknown, number>()

    for (const val of values) {
      counts.set(val, (counts.get(val) || 0) + 1)
    }

    let maxCount = 0
    let mode: unknown = null

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
  private flattenValues(args: unknown[]): unknown[] {
    const result: unknown[] = []

    for (const arg of args) {
      if (Array.isArray(arg)) {
        if (Array.isArray(arg[0])) {
          // 2D array (range)
          for (const row of arg) {
            if (Array.isArray(row)) {
              result.push(...row)
            }
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
    if (!this.db) return

    const formulas = await this.db
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
