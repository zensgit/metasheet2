/**
 * Formula Engine for spreadsheet cell calculations
 * Provides basic formula parsing and evaluation
 */

export type CellValue = string | number | boolean | null

// Support both simple key-value context and function-based context
type CellContext = Record<string, CellValue> | {
  getCellValue?: (row: number, col: number) => CellValue
  [key: string]: any
}

interface FormulaEngine {
  evaluate: (formula: string, context?: CellContext) => CellValue
  parse: (formula: string) => ParsedFormula
  isFormula: (value: string) => boolean
}

interface ParsedFormula {
  type: 'function' | 'reference' | 'literal' | 'expression'
  value: string
  args?: ParsedFormula[]
}

/**
 * Basic math operations
 */
const mathFunctions: Record<string, (...args: number[]) => number> = {
  SUM: (...args) => args.reduce((a, b) => a + b, 0),
  AVERAGE: (...args) => args.reduce((a, b) => a + b, 0) / args.length,
  MIN: (...args) => Math.min(...args),
  MAX: (...args) => Math.max(...args),
  COUNT: (...args) => args.filter(v => typeof v === 'number').length,
  ABS: (x) => Math.abs(x),
  ROUND: (x, decimals = 0) => {
    const factor = Math.pow(10, decimals)
    return Math.round(x * factor) / factor
  },
  FLOOR: (x) => Math.floor(x),
  CEIL: (x) => Math.ceil(x),
  SQRT: (x) => Math.sqrt(x),
  POWER: (base, exp) => Math.pow(base, exp),
}

/**
 * String functions
 */
const stringFunctions: Record<string, (...args: any[]) => any> = {
  CONCAT: (...args) => args.join(''),
  UPPER: (s: string) => String(s).toUpperCase(),
  LOWER: (s: string) => String(s).toLowerCase(),
  TRIM: (s: string) => String(s).trim(),
  LEN: (s: string) => String(s).length,
  LEFT: (s: string, n: number) => String(s).slice(0, n),
  RIGHT: (s: string, n: number) => String(s).slice(-n),
  MID: (s: string, start: number, len: number) => String(s).slice(start - 1, start - 1 + len),
}

/**
 * Logic functions
 */
const logicFunctions: Record<string, (...args: any[]) => any> = {
  IF: (condition: boolean, trueVal: any, falseVal: any) => condition ? trueVal : falseVal,
  AND: (...args: boolean[]) => args.every(Boolean),
  OR: (...args: boolean[]) => args.some(Boolean),
  NOT: (val: boolean) => !val,
  ISBLANK: (val: any) => val === null || val === undefined || val === '',
  ISNUMBER: (val: any) => typeof val === 'number' && !isNaN(val),
}

/**
 * Parse cell reference (e.g., A1, B2)
 */
function parseCellReference(ref: string): { col: string; row: number } | null {
  const match = ref.match(/^([A-Z]+)(\d+)$/i)
  if (!match) return null
  return {
    col: match[1].toUpperCase(),
    row: parseInt(match[2], 10)
  }
}

/**
 * Convert column letter to number (A=0, B=1, etc.)
 */
function columnToNumber(col: string): number {
  let result = 0
  for (let i = 0; i < col.length; i++) {
    result = result * 26 + (col.charCodeAt(i) - 64)
  }
  return result - 1
}

/**
 * Get value from cell context
 */
function getCellValueFromContext(ref: string, context: CellContext): CellValue {
  const parsed = parseCellReference(ref)
  if (!parsed) return null

  // If context has getCellValue function, use it
  if (typeof (context as any).getCellValue === 'function') {
    const row = parsed.row - 1 // Convert to 0-based
    const col = columnToNumber(parsed.col)
    return (context as any).getCellValue(row, col)
  }

  // Otherwise use key-value lookup
  const key = `${parsed.col}${parsed.row}`
  return (context as Record<string, CellValue>)[key] ?? null
}

/**
 * Tokenize formula string
 */
function tokenize(formula: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inString = false
  let stringChar = ''

  for (let i = 0; i < formula.length; i++) {
    const char = formula[i]

    if (inString) {
      current += char
      if (char === stringChar) {
        tokens.push(current)
        current = ''
        inString = false
      }
    } else if (char === '"' || char === "'") {
      if (current) {
        tokens.push(current)
        current = ''
      }
      current = char
      inString = true
      stringChar = char
    } else if ('(),+-*/^<>=:'.includes(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      // Handle multi-char operators
      if ((char === '<' || char === '>') && formula[i + 1] === '=') {
        tokens.push(char + '=')
        i++
      } else if (char === '<' && formula[i + 1] === '>') {
        tokens.push('<>')
        i++
      } else {
        tokens.push(char)
      }
    } else if (char === ' ') {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

/**
 * Evaluate a parsed expression
 */
function evaluateExpression(tokens: string[], context: CellContext): CellValue {
  if (tokens.length === 0) return null

  // Handle single token
  if (tokens.length === 1) {
    const token = tokens[0]

    // String literal
    if ((token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1)
    }

    // Number
    if (!isNaN(Number(token))) {
      return Number(token)
    }

    // Boolean
    if (token.toUpperCase() === 'TRUE') return true
    if (token.toUpperCase() === 'FALSE') return false

    // Cell reference
    if (/^[A-Z]+\d+$/i.test(token)) {
      return getCellValueFromContext(token, context)
    }

    return token
  }

  // Handle function call: FUNC(args)
  if (tokens.length >= 3 && tokens[1] === '(') {
    const funcName = tokens[0].toUpperCase()
    const args: CellValue[] = []
    let depth = 0
    let argTokens: string[] = []

    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i]

      if (token === '(') {
        depth++
        argTokens.push(token)
      } else if (token === ')') {
        if (depth === 0) {
          if (argTokens.length > 0) {
            args.push(evaluateExpression(argTokens, context))
          }
          break
        }
        depth--
        argTokens.push(token)
      } else if (token === ',' && depth === 0) {
        if (argTokens.length > 0) {
          args.push(evaluateExpression(argTokens, context))
          argTokens = []
        }
      } else {
        argTokens.push(token)
      }
    }

    // Execute function
    const allFunctions = { ...mathFunctions, ...stringFunctions, ...logicFunctions }
    if (funcName in allFunctions) {
      try {
        return allFunctions[funcName](...args as any[])
      } catch {
        return '#ERROR!'
      }
    }

    return '#NAME?'
  }

  // Handle binary operations
  const operators = ['<>', '<=', '>=', '<', '>', '=', '+', '-', '*', '/', '^']
  for (const op of operators) {
    const opIndex = tokens.indexOf(op)
    if (opIndex > 0) {
      const left = evaluateExpression(tokens.slice(0, opIndex), context)
      const right = evaluateExpression(tokens.slice(opIndex + 1), context)

      const leftNum = Number(left)
      const rightNum = Number(right)

      switch (op) {
        case '+': return leftNum + rightNum
        case '-': return leftNum - rightNum
        case '*': return leftNum * rightNum
        case '/': return rightNum !== 0 ? leftNum / rightNum : '#DIV/0!'
        case '^': return Math.pow(leftNum, rightNum)
        case '=': return left === right
        case '<>': return left !== right
        case '<': return leftNum < rightNum
        case '>': return leftNum > rightNum
        case '<=': return leftNum <= rightNum
        case '>=': return leftNum >= rightNum
      }
    }
  }

  return '#ERROR!'
}

/**
 * Main formula engine instance
 */
export const formulaEngine: FormulaEngine = {
  /**
   * Check if a value is a formula (starts with =)
   */
  isFormula(value: string): boolean {
    return typeof value === 'string' && value.trim().startsWith('=')
  },

  /**
   * Parse a formula string into AST
   */
  parse(formula: string): ParsedFormula {
    const cleaned = formula.trim()
    if (cleaned.startsWith('=')) {
      return {
        type: 'expression',
        value: cleaned.slice(1)
      }
    }
    return {
      type: 'literal',
      value: formula
    }
  },

  /**
   * Evaluate a formula with optional cell context
   */
  evaluate(formula: string, context: CellContext = {}): CellValue {
    try {
      const trimmed = formula.trim()

      // Not a formula, return as-is
      if (!trimmed.startsWith('=')) {
        if (!isNaN(Number(trimmed))) {
          return Number(trimmed)
        }
        return trimmed
      }

      // Parse and evaluate
      const expression = trimmed.slice(1).trim()
      const tokens = tokenize(expression)
      return evaluateExpression(tokens, context)
    } catch (error) {
      return '#ERROR!'
    }
  }
}

export default formulaEngine
