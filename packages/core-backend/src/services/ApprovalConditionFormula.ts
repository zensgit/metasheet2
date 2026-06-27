import type { FormField, FormSchema } from '../types/approval-product'

export const APPROVAL_CONDITION_FORMULA_LIMITS = {
  maxExpressionLength: 512,
  maxAstNodes: 128,
  maxDepth: 16,
  maxFieldReferences: 64,
  maxFunctionCalls: 32,
  /** RA-1b: cap on string elements in an `in [...]` array literal (DoS bound). */
  maxInArrayElements: 32,
} as const

export class ApprovalConditionFormulaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalConditionFormulaError'
  }
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'field'; path: string[]; raw: string }
  | { kind: 'requester'; attr: string; raw: string }
  | { kind: 'identifier'; value: string }
  | { kind: 'operator'; value: '+' | '-' | '*' | '/' | '==' | '!=' | '>' | '>=' | '<' | '<=' }
  | { kind: 'paren'; value: '(' | ')' }
  | { kind: 'bracket'; value: '[' | ']' }
  | { kind: 'comma' }
  | { kind: 'eof' }

type OperatorTokenValue = Extract<Token, { kind: 'operator' }>['value']

type FormulaAst =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'field'; path: string[]; raw: string }
  | { kind: 'requester'; attr: string; raw: string }
  | { kind: 'aggregate'; fn: 'SUM' | 'COUNT' | 'MIN' | 'MAX'; path: string[]; raw: string }
  | { kind: 'unary'; op: 'NEG' | 'NOT'; expr: FormulaAst }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/' | 'AND' | 'OR'; left: FormulaAst; right: FormulaAst }
  | { kind: 'compare'; op: '==' | '!=' | '>' | '>=' | '<' | '<='; left: FormulaAst; right: FormulaAst }
  // RA-1b: `requester.<role-attr> in [ "a", "b" ]` — role-set membership, comparison-precedence, boolean.
  // The ONLY valid shape of `in`; `attr` is the role attr, `elements` the string literals (1..32).
  | { kind: 'membership'; attr: string; raw: string; elements: string[] }

type FormulaValue = number | string | boolean | null
type FormulaType = 'number' | 'string' | 'boolean' | 'null'

/** The frozen, server-resolved requester attributes the evaluator may read: `department` (RA-1a) and
 *  `title` (next slice — string `==`/`!=` only). Every other attribute (level/role/unknown) is rejected at
 *  PARSE (see parsePrimary), so it never reaches runtime. Values come from ApprovalDirectoryOrg's directory
 *  snapshot, NOT actor/JWT. */
export interface RequesterFormulaContext {
  department?: string | null
  title?: string | null
  /** RA-1b: the requester's frozen, server-resolved ROLE-ID SET (from `user_roles`, NOT token claims).
   *  Read ONLY by `requester.role in [...]` membership; null/absent fails closed at eval. */
  roles?: string[] | null
}
/** Scalar requester attributes (string `==`/`!=`). `role` is NOT here — it is a LIST attr handled by
 *  membership (`ROLE_REQUESTER_ATTRS`), so a scalar `requester.role == "x"` type-rejects. */
const RA1A_REQUESTER_ATTRS: Record<string, FormulaType> = { department: 'string', title: 'string' }
/** RA-1b: LIST-valued requester attributes — usable ONLY as the LHS of `in [...]` membership. */
const ROLE_REQUESTER_ATTRS: Record<string, true> = { role: true }

function fail(message: string): never {
  throw new ApprovalConditionFormulaError(message)
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char)
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char)
}

function tokenize(expression: string): Token[] {
  if (expression.length > APPROVAL_CONDITION_FORMULA_LIMITS.maxExpressionLength) {
    fail(`expression exceeds ${APPROVAL_CONDITION_FORMULA_LIMITS.maxExpressionLength} characters`)
  }

  const tokens: Token[] = []
  let i = 0
  while (i < expression.length) {
    const char = expression[i]
    if (/\s/.test(char)) {
      i += 1
      continue
    }

    if (char === '{') {
      const end = expression.indexOf('}', i + 1)
      if (end < 0) fail('field reference is missing closing brace')
      const raw = expression.slice(i + 1, end).trim()
      if (!raw) fail('field reference cannot be empty')
      if (raw.includes('{') || raw.includes('}')) fail('field reference cannot contain braces')
      const path = raw.split('.').map((part) => part.trim())
      if (path.length < 1 || path.length > 2 || path.some((part) => !part)) {
        fail(`field reference is invalid: ${raw}`)
      }
      tokens.push({ kind: 'field', path, raw })
      i = end + 1
      continue
    }

    if (char === '"' || char === "'") {
      const quote = char
      let value = ''
      let closed = false
      i += 1
      while (i < expression.length) {
        const current = expression[i]
        if (current === quote) {
          i += 1
          tokens.push({ kind: 'string', value })
          closed = true
          break
        }
        if (current === '\\') {
          const escaped = expression[i + 1]
          if (escaped === undefined) fail('string literal has a dangling escape')
          const mapped = escaped === 'n'
            ? '\n'
            : escaped === 'r'
              ? '\r'
              : escaped === 't'
                ? '\t'
                : escaped
          value += mapped
          i += 2
          continue
        }
        value += current
        i += 1
      }
      if (!closed) {
        fail('string literal is missing closing quote')
      }
      continue
    }

    if (/[0-9.]/.test(char)) {
      const rest = expression.slice(i)
      const match = rest.match(/^(?:\d+(?:\.\d+)?|\.\d+)/)
      if (!match) fail(`unexpected token: ${char}`)
      const value = Number(match[0])
      if (!Number.isFinite(value)) fail(`number literal is not finite: ${match[0]}`)
      tokens.push({ kind: 'number', value })
      i += match[0].length
      continue
    }

    if (isIdentifierStart(char)) {
      let raw = char
      i += 1
      while (i < expression.length && isIdentifierPart(expression[i])) {
        raw += expression[i]
        i += 1
      }
      const upper = raw.toUpperCase()
      if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({ kind: 'boolean', value: upper === 'TRUE' })
      } else if (upper === 'NULL') {
        tokens.push({ kind: 'null' })
      } else if (raw === 'requester' && expression[i] === '.') {
        // RA-1a requester namespace: `requester.<attr>` — a reserved token resolved from the frozen
        // requester context, never from formData (so a form field named `requester` cannot spoof it).
        i += 1 // consume '.'
        let attr = ''
        while (i < expression.length && isIdentifierPart(expression[i])) {
          attr += expression[i]
          i += 1
        }
        if (!attr) fail('requester reference is missing an attribute (e.g. requester.department)')
        tokens.push({ kind: 'requester', attr, raw: `requester.${attr}` })
      } else {
        tokens.push({ kind: 'identifier', value: upper })
      }
      continue
    }

    const two = expression.slice(i, i + 2)
    if (two === '==' || two === '!=' || two === '>=' || two === '<=') {
      tokens.push({ kind: 'operator', value: two })
      i += 2
      continue
    }
    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '>' || char === '<') {
      tokens.push({ kind: 'operator', value: char })
      i += 1
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push({ kind: 'paren', value: char })
      i += 1
      continue
    }
    // RA-1b: array-literal delimiters + separator for `requester.role in [ "a", "b" ]`.
    // `in` itself needs no dedicated token — it tokenizes as the identifier 'IN' (case-insensitive,
    // uppercased above), matched in the parser exactly like the AND/OR/NOT keywords.
    if (char === '[' || char === ']') {
      tokens.push({ kind: 'bracket', value: char })
      i += 1
      continue
    }
    if (char === ',') {
      tokens.push({ kind: 'comma' })
      i += 1
      continue
    }
    fail(`unexpected token: ${char}`)
  }

  tokens.push({ kind: 'eof' })
  return tokens
}

class FormulaParser {
  private index = 0
  private astNodes = 0
  private fieldReferences = 0
  private functionCalls = 0
  private parenDepth = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): FormulaAst {
    const expr = this.parseOr()
    if (this.peek().kind !== 'eof') {
      fail('unexpected trailing token')
    }
    const depth = astDepth(expr)
    if (depth > APPROVAL_CONDITION_FORMULA_LIMITS.maxDepth) {
      fail(`formula AST depth exceeds ${APPROVAL_CONDITION_FORMULA_LIMITS.maxDepth}`)
    }
    return expr
  }

  private node<T extends FormulaAst>(ast: T): T {
    this.astNodes += 1
    if (this.astNodes > APPROVAL_CONDITION_FORMULA_LIMITS.maxAstNodes) {
      fail(`formula AST exceeds ${APPROVAL_CONDITION_FORMULA_LIMITS.maxAstNodes} nodes`)
    }
    if (ast.kind === 'field' || ast.kind === 'aggregate') {
      this.fieldReferences += 1
      if (this.fieldReferences > APPROVAL_CONDITION_FORMULA_LIMITS.maxFieldReferences) {
        fail(`formula references more than ${APPROVAL_CONDITION_FORMULA_LIMITS.maxFieldReferences} fields`)
      }
    }
    if (ast.kind === 'aggregate') {
      this.functionCalls += 1
      if (this.functionCalls > APPROVAL_CONDITION_FORMULA_LIMITS.maxFunctionCalls) {
        fail(`formula calls more than ${APPROVAL_CONDITION_FORMULA_LIMITS.maxFunctionCalls} functions`)
      }
    }
    return ast
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { kind: 'eof' }
  }

  private advance(): Token {
    const token = this.peek()
    this.index += 1
    return token
  }

  private matchIdentifier(value: string): boolean {
    const token = this.peek()
    if (token.kind === 'identifier' && token.value === value) {
      this.index += 1
      return true
    }
    return false
  }

  private matchOperator(value: OperatorTokenValue): boolean {
    const token = this.peek()
    if (token.kind === 'operator' && token.value === value) {
      this.index += 1
      return true
    }
    return false
  }

  private matchParen(value: '(' | ')'): boolean {
    const token = this.peek()
    if (token.kind === 'paren' && token.value === value) {
      this.index += 1
      return true
    }
    return false
  }

  private matchBracket(value: '[' | ']'): boolean {
    const token = this.peek()
    if (token.kind === 'bracket' && token.value === value) {
      this.index += 1
      return true
    }
    return false
  }

  private matchComma(): boolean {
    if (this.peek().kind === 'comma') {
      this.index += 1
      return true
    }
    return false
  }

  private parseOr(): FormulaAst {
    let left = this.parseAnd()
    while (this.matchIdentifier('OR')) {
      left = this.node({ kind: 'binary', op: 'OR', left, right: this.parseAnd() })
    }
    return left
  }

  private parseAnd(): FormulaAst {
    let left = this.parseNot()
    while (this.matchIdentifier('AND')) {
      left = this.node({ kind: 'binary', op: 'AND', left, right: this.parseNot() })
    }
    return left
  }

  private parseNot(): FormulaAst {
    if (this.matchIdentifier('NOT')) {
      return this.node({ kind: 'unary', op: 'NOT', expr: this.parseNot() })
    }
    return this.parseComparison()
  }

  private parseComparison(): FormulaAst {
    const left = this.parseAdditive()
    // RA-1b: `in` membership (comparison-precedence, yields boolean) — matched as the keyword identifier
    // 'IN' (like AND/OR/NOT). Scoped to `requester.role in [...]` ONLY; everything else fails closed.
    if (this.matchIdentifier('IN')) {
      return this.parseMembership(left)
    }
    const token = this.peek()
    if (token.kind !== 'operator' || !['==', '!=', '>', '>=', '<', '<='].includes(token.value)) {
      return left
    }
    this.advance()
    return this.node({
      kind: 'compare',
      op: token.value as Extract<FormulaAst, { kind: 'compare' }>['op'],
      left,
      right: this.parseAdditive(),
    })
  }

  /**
   * RA-1b membership: the LHS of `in` MUST be `requester.<role-attr>` (v1 scopes `in` to role membership
   * only) and the RHS MUST be a non-empty bracketed array of string literals. Every other shape — `in` on
   * a scalar/field/literal LHS, a non-array RHS — fails closed here at parse.
   */
  private parseMembership(left: FormulaAst): FormulaAst {
    if (left.kind !== 'requester' || !(left.attr in ROLE_REQUESTER_ATTRS)) {
      fail('the `in` operator is only supported for requester.role membership (e.g. requester.role in ["a"])')
    }
    const elements = this.parseStringArrayLiteral()
    return this.node({ kind: 'membership', attr: left.attr, raw: left.raw, elements })
  }

  /**
   * Parse `[ "a", "b", ... ]` — comma-separated STRING literals only. Rejects (fail-closed) a non-array
   * RHS, an empty array, a trailing/missing comma, any non-string element (number / nested array / token),
   * and more than `maxInArrayElements` (32) elements.
   */
  private parseStringArrayLiteral(): string[] {
    if (!this.matchBracket('[')) {
      fail('the `in` operator requires a bracketed array literal of string values (e.g. ["a", "b"])')
    }
    if (this.matchBracket(']')) fail('the `in` array literal must not be empty')
    const elements: string[] = []
    while (true) {
      const token = this.advance()
      if (token.kind !== 'string') {
        if (token.kind === 'eof') fail('the `in` array literal is missing its closing `]`')
        fail('the `in` array literal accepts string literals only (no nested arrays, numbers, or expressions)')
      }
      if (!token.value.trim()) fail('the `in` array literal must not contain blank string elements')
      elements.push(token.value)
      if (elements.length > APPROVAL_CONDITION_FORMULA_LIMITS.maxInArrayElements) {
        fail(`the \`in\` array literal exceeds ${APPROVAL_CONDITION_FORMULA_LIMITS.maxInArrayElements} elements`)
      }
      if (this.matchBracket(']')) break
      if (!this.matchComma()) fail('the `in` array literal elements must be comma-separated')
    }
    return elements
  }

  private parseAdditive(): FormulaAst {
    let left = this.parseMultiplicative()
    while (true) {
      if (this.matchOperator('+')) {
        left = this.node({ kind: 'binary', op: '+', left, right: this.parseMultiplicative() })
        continue
      }
      if (this.matchOperator('-')) {
        left = this.node({ kind: 'binary', op: '-', left, right: this.parseMultiplicative() })
        continue
      }
      return left
    }
  }

  private parseMultiplicative(): FormulaAst {
    let left = this.parseUnary()
    while (true) {
      if (this.matchOperator('*')) {
        left = this.node({ kind: 'binary', op: '*', left, right: this.parseUnary() })
        continue
      }
      if (this.matchOperator('/')) {
        left = this.node({ kind: 'binary', op: '/', left, right: this.parseUnary() })
        continue
      }
      return left
    }
  }

  private parseUnary(): FormulaAst {
    if (this.matchOperator('-')) {
      return this.node({ kind: 'unary', op: 'NEG', expr: this.parseUnary() })
    }
    if (this.matchOperator('+')) {
      return this.parseUnary()
    }
    return this.parsePrimary()
  }

  private parsePrimary(): FormulaAst {
    const token = this.advance()
    switch (token.kind) {
      case 'number':
        return this.node({ kind: 'number', value: token.value })
      case 'string':
        return this.node({ kind: 'string', value: token.value })
      case 'boolean':
        return this.node({ kind: 'boolean', value: token.value })
      case 'null':
        return this.node({ kind: 'null' })
      case 'field':
        return this.node({ kind: 'field', path: token.path, raw: token.raw })
      case 'requester':
        // The allowlist IS the parse/publish fail-closed gate: anything outside the scalar set
        // {department, title} OR the list set {role} (level/unknown) is rejected here, so it never reaches
        // runtime as absent-in-context. A `role` token is accepted as a requester node so the parser can
        // see it as the LHS of `in`; a scalar use of `requester.role` is then TYPE-rejected in
        // inferFormulaType (so `requester.role == "x"` fails publish, while `requester.role in [...]` lives).
        if (!(token.attr in RA1A_REQUESTER_ATTRS) && !(token.attr in ROLE_REQUESTER_ATTRS)) {
          fail(`unsupported requester attribute: ${token.raw} (supports requester.department / requester.title / requester.role only)`)
        }
        return this.node({ kind: 'requester', attr: token.attr, raw: token.raw })
      case 'identifier':
        return this.parseFunction(token.value)
      case 'paren': {
        if (token.value !== '(') fail('unexpected closing parenthesis')
        this.parenDepth += 1
        if (this.parenDepth > APPROVAL_CONDITION_FORMULA_LIMITS.maxDepth) {
          fail(`formula nesting depth exceeds ${APPROVAL_CONDITION_FORMULA_LIMITS.maxDepth}`)
        }
        try {
          const expr = this.parseOr()
          if (!this.matchParen(')')) fail('missing closing parenthesis')
          return expr
        } finally {
          this.parenDepth -= 1
        }
      }
      case 'operator':
        fail(`unexpected operator: ${token.value}`)
      case 'eof':
        fail('unexpected end of expression')
      default:
        fail('unexpected token')
    }
  }

  private parseFunction(name: string): FormulaAst {
    if (name !== 'SUM' && name !== 'COUNT' && name !== 'MIN' && name !== 'MAX') {
      fail(`unsupported identifier: ${name}`)
    }
    if (!this.matchParen('(')) fail(`${name} requires parentheses`)
    const token = this.advance()
    if (token.kind !== 'field') fail(`${name} requires a field reference argument`)
    if (!this.matchParen(')')) fail(`${name} accepts exactly one argument`)
    return this.node({ kind: 'aggregate', fn: name, path: token.path, raw: token.raw })
  }
}

function astDepth(ast: FormulaAst): number {
  switch (ast.kind) {
    case 'unary':
      return 1 + astDepth(ast.expr)
    case 'binary':
    case 'compare':
      return 1 + Math.max(astDepth(ast.left), astDepth(ast.right))
    default:
      return 1
  }
}

function parseFormula(expression: string): FormulaAst {
  const trimmed = expression.trim()
  if (!trimmed) fail('expression is required')
  return new FormulaParser(tokenize(trimmed)).parse()
}

function astReferencesRequesterAttribute(ast: FormulaAst, attr: string): boolean {
  switch (ast.kind) {
    case 'requester':
      return ast.attr === attr
    // RA-1b: a `requester.role in [...]` node carries its role attr directly (no child requester node), so
    // role usage is invisible to the wedge guard unless detected here. KEYSTONE: omitting this case silently
    // disables the role create-time fail-closed guard.
    case 'membership':
      return ast.attr === attr
    case 'unary':
      return astReferencesRequesterAttribute(ast.expr, attr)
    case 'binary':
    case 'compare':
      return astReferencesRequesterAttribute(ast.left, attr) || astReferencesRequesterAttribute(ast.right, attr)
    default:
      return false
  }
}

/**
 * Token-aware: does the formula reference `requester.<attr>` as an actual reserved requester TOKEN —
 * not a string literal like "requester.department" or a field name that merely contains the text?
 * Parses to the AST and walks for a `{ kind: 'requester', attr }` node, so quoting can never trip it.
 * Returns false on a parse error (callers scan already-published, parseable formulas, so this is
 * defensive only — and false-on-error avoids over-firing the RA-1a create-time wedge guard).
 */
export function formulaReferencesRequesterAttribute(expression: string, attr: string): boolean {
  let ast: FormulaAst
  try {
    ast = parseFormula(expression)
  } catch {
    return false
  }
  return astReferencesRequesterAttribute(ast, attr)
}

function formFieldTypeToFormulaType(field: FormField): FormulaType | 'unsupported' {
  switch (field.type) {
    case 'number':
      return 'number'
    case 'text':
    case 'textarea':
    case 'date':
    case 'datetime':
    case 'select':
    case 'user':
      return 'string'
    default:
      return 'unsupported'
  }
}

function findTopLevelField(schema: FormSchema, fieldId: string): FormField | undefined {
  return schema.fields.find((field) => field.id === fieldId)
}

function findDetailColumn(schema: FormSchema, detailId: string, columnId: string): { detail: FormField; column: FormField } | undefined {
  const detail = findTopLevelField(schema, detailId)
  if (!detail || detail.type !== 'detail') return undefined
  const column = detail.columns?.find((entry) => entry.id === columnId)
  return column ? { detail, column } : undefined
}

function inferFormulaType(ast: FormulaAst, schema: FormSchema): FormulaType {
  switch (ast.kind) {
    case 'number':
      return 'number'
    case 'string':
      return 'string'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'field': {
      if (ast.path.length !== 1) {
        fail(`detail sub-field reference must be used inside an aggregate: ${ast.raw}`)
      }
      const field = findTopLevelField(schema, ast.path[0])
      if (!field) fail(`unknown field reference: ${ast.raw}`)
      if (field.type === 'detail') fail(`detail field reference must use an aggregate: ${ast.raw}`)
      const type = formFieldTypeToFormulaType(field)
      if (type === 'unsupported') fail(`field type is not supported in formula: ${field.id}`)
      return type
    }
    case 'requester': {
      // RA-1b: a list attr (`role`) reaching scalar type-inference means it was used WITHOUT `in`
      // (e.g. `requester.role == "x"`) — TYPE-reject at publish; `in` produces a `membership` node instead.
      if (ast.attr in ROLE_REQUESTER_ATTRS) {
        fail(`requester.${ast.attr} can only be used with the \`in\` operator (e.g. requester.role in ["a"])`)
      }
      const requesterType = RA1A_REQUESTER_ATTRS[ast.attr]
      if (!requesterType) fail(`unsupported requester attribute: ${ast.raw}`)
      return requesterType
    }
    case 'membership':
      return 'boolean'
    case 'aggregate':
      validateAggregateReference(ast, schema)
      return 'number'
    case 'unary': {
      const inner = inferFormulaType(ast.expr, schema)
      if (ast.op === 'NOT') {
        if (inner !== 'boolean') fail('NOT requires a boolean expression')
        return 'boolean'
      }
      if (inner !== 'number') fail('unary +/- requires a numeric expression')
      return 'number'
    }
    case 'binary': {
      const left = inferFormulaType(ast.left, schema)
      const right = inferFormulaType(ast.right, schema)
      if (ast.op === 'AND' || ast.op === 'OR') {
        if (left !== 'boolean' || right !== 'boolean') fail(`${ast.op} requires boolean operands`)
        return 'boolean'
      }
      if (left !== 'number' || right !== 'number') {
        fail(`operator ${ast.op} requires numeric operands`)
      }
      return 'number'
    }
    case 'compare': {
      const left = inferFormulaType(ast.left, schema)
      const right = inferFormulaType(ast.right, schema)
      if (ast.op === '==' || ast.op === '!=') {
        if (left !== right && left !== 'null' && right !== 'null') {
          fail(`operator ${ast.op} requires compatible operand types`)
        }
        return 'boolean'
      }
      if (left !== 'number' || right !== 'number') {
        fail(`operator ${ast.op} requires numeric operands`)
      }
      return 'boolean'
    }
    default:
      fail('unsupported expression')
  }
}

function validateAggregateReference(ast: Extract<FormulaAst, { kind: 'aggregate' }>, schema: FormSchema): void {
  if (ast.fn === 'COUNT') {
    if (ast.path.length !== 1) fail(`COUNT requires a detail field reference: ${ast.raw}`)
    const detail = findTopLevelField(schema, ast.path[0])
    if (!detail || detail.type !== 'detail') fail(`COUNT requires a detail field reference: ${ast.raw}`)
    return
  }

  if (ast.path.length !== 2) fail(`${ast.fn} requires a detail sub-field reference: ${ast.raw}`)
  const resolved = findDetailColumn(schema, ast.path[0], ast.path[1])
  if (!resolved) fail(`${ast.fn} references an unknown detail sub-field: ${ast.raw}`)
  if (resolved.column.type !== 'number') {
    fail(`${ast.fn} requires a numeric detail sub-field: ${ast.raw}`)
  }
}

function assertFiniteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${context} must be a finite number`)
  }
  return value
}

function assertBoolean(value: FormulaValue, context: string): boolean {
  if (typeof value !== 'boolean') fail(`${context} must be boolean`)
  return value
}

function evaluateField(path: string[], raw: string, formData: Record<string, unknown>): FormulaValue {
  if (path.length !== 1) fail(`detail sub-field reference must be used inside an aggregate: ${raw}`)
  if (!Object.prototype.hasOwnProperty.call(formData, path[0])) {
    fail(`field ${raw} is missing`)
  }
  const value = formData[path[0]]
  if (value === null) return null
  if (value === undefined) fail(`field ${raw} is missing`)
  if (typeof value === 'number') return assertFiniteNumber(value, `field ${raw}`)
  if (typeof value === 'string' || typeof value === 'boolean') return value
  fail(`field ${raw} has an unsupported runtime value`)
}

function evaluateAggregate(ast: Extract<FormulaAst, { kind: 'aggregate' }>, formData: Record<string, unknown>): number {
  const detailValue = formData[ast.path[0]]
  if (!Array.isArray(detailValue)) fail(`aggregate ${ast.fn} requires a detail array: ${ast.path[0]}`)
  if (ast.fn === 'COUNT') {
    if (ast.path.length !== 1) fail(`COUNT requires a detail field reference: ${ast.raw}`)
    if (detailValue.some((row) => row === null || typeof row !== 'object' || Array.isArray(row))) {
      fail('COUNT requires detail rows to be objects')
    }
    return detailValue.length
  }
  if (ast.path.length !== 2) fail(`${ast.fn} requires a detail sub-field reference: ${ast.raw}`)
  const numbers = detailValue.map((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      fail(`${ast.fn} row ${index + 1} must be an object`)
    }
    return assertFiniteNumber((row as Record<string, unknown>)[ast.path[1]], `${ast.fn} value ${ast.raw}`)
  })
  if (ast.fn === 'SUM') {
    return numbers.reduce((sum, value) => assertFiniteNumber(sum + value, 'SUM result'), 0)
  }
  if (numbers.length === 0) fail(`${ast.fn} requires at least one numeric detail value`)
  return ast.fn === 'MIN' ? Math.min(...numbers) : Math.max(...numbers)
}

/** Resolve a `requester.<attr>` value from the frozen, server-resolved requester context: `department`
 *  and `title` (the parser already rejected every other attr). Fail-closed on ROW-LEVEL absence: a
 *  null/undefined context, or a missing/blank value, rejects rather than routing on a phantom. */
function evaluateRequester(attr: string, raw: string, requester: RequesterFormulaContext | null): FormulaValue {
  if (!requester) fail(`requester context unavailable for ${raw}`)
  if (attr === 'department') {
    const value = requester.department
    if (value === null || value === undefined || value === '') fail(`requester department is missing for ${raw}`)
    if (typeof value !== 'string') fail(`requester department has an unsupported value for ${raw}`)
    return value
  }
  if (attr === 'title') {
    const value = requester.title
    if (value === null || value === undefined || value === '') fail(`requester title is missing for ${raw}`)
    if (typeof value !== 'string') fail(`requester title has an unsupported value for ${raw}`)
    return value
  }
  // RA-1b: `role` is a list attr — never resolved as a scalar value. Reaching here means a scalar use of
  // `requester.role` slipped past type-check (defensive; inferFormulaType already rejects it at publish).
  if (attr in ROLE_REQUESTER_ATTRS) {
    fail(`requester.${attr} can only be used with the \`in\` operator`)
  }
  fail(`unsupported requester attribute: ${raw}`)
}

/** RA-1b: `requester.role in [...]` — TRUE iff the requester's frozen role set INTERSECTS the literal
 *  array. Fail-closed on ROW-LEVEL absence: a null/undefined context or a null/absent role set rejects
 *  rather than routing on a phantom. A genuinely-empty role set simply intersects nothing (false) — but
 *  the create-time wedge guard already rejects an empty set on a role-routed template, so this is
 *  defensive only at eval. */
function evaluateRequesterMembership(
  ast: Extract<FormulaAst, { kind: 'membership' }>,
  requester: RequesterFormulaContext | null,
): boolean {
  if (!requester) fail(`requester context unavailable for ${ast.raw}`)
  const roles = requester.roles
  if (roles === null || roles === undefined) fail(`requester roles are missing for ${ast.raw}`)
  if (!Array.isArray(roles)) fail(`requester roles have an unsupported value for ${ast.raw}`)
  const held = new Set(roles.filter((role): role is string => typeof role === 'string'))
  return ast.elements.some((element) => held.has(element))
}

function evaluateAst(ast: FormulaAst, formData: Record<string, unknown>, requester: RequesterFormulaContext | null): FormulaValue {
  switch (ast.kind) {
    case 'number':
    case 'string':
    case 'boolean':
      return ast.value
    case 'null':
      return null
    case 'field':
      return evaluateField(ast.path, ast.raw, formData)
    case 'aggregate':
      return evaluateAggregate(ast, formData)
    case 'requester':
      return evaluateRequester(ast.attr, ast.raw, requester)
    case 'membership':
      return evaluateRequesterMembership(ast, requester)
    case 'unary': {
      const value = evaluateAst(ast.expr, formData, requester)
      if (ast.op === 'NOT') return !assertBoolean(value, 'NOT operand')
      return assertFiniteNumber(-assertFiniteNumber(value, 'unary operand'), 'unary result')
    }
    case 'binary': {
      if (ast.op === 'AND') {
        const left = assertBoolean(evaluateAst(ast.left, formData, requester), 'AND left operand')
        const right = assertBoolean(evaluateAst(ast.right, formData, requester), 'AND right operand')
        return left && right
      }
      if (ast.op === 'OR') {
        const left = assertBoolean(evaluateAst(ast.left, formData, requester), 'OR left operand')
        const right = assertBoolean(evaluateAst(ast.right, formData, requester), 'OR right operand')
        return left || right
      }
      const left = assertFiniteNumber(evaluateAst(ast.left, formData, requester), `${ast.op} left operand`)
      const right = assertFiniteNumber(evaluateAst(ast.right, formData, requester), `${ast.op} right operand`)
      if (ast.op === '/' && right === 0) fail('division by zero')
      const result = ast.op === '+'
        ? left + right
        : ast.op === '-'
          ? left - right
          : ast.op === '*'
            ? left * right
            : left / right
      return assertFiniteNumber(result, `${ast.op} result`)
    }
    case 'compare': {
      const left = evaluateAst(ast.left, formData, requester)
      const right = evaluateAst(ast.right, formData, requester)
      if (ast.op === '==') return left === right
      if (ast.op === '!=') return left !== right
      const numericLeft = assertFiniteNumber(left, `${ast.op} left operand`)
      const numericRight = assertFiniteNumber(right, `${ast.op} right operand`)
      if (ast.op === '>') return numericLeft > numericRight
      if (ast.op === '>=') return numericLeft >= numericRight
      if (ast.op === '<') return numericLeft < numericRight
      return numericLeft <= numericRight
    }
    default:
      fail('unsupported expression')
  }
}

export function parseApprovalConditionFormula(expression: string): void {
  parseFormula(expression)
}

export function assertApprovalConditionFormulaValidForSchema(expression: string, schema: FormSchema): void {
  const ast = parseFormula(expression)
  const resultType = inferFormulaType(ast, schema)
  if (resultType !== 'boolean') {
    fail('formula must return boolean')
  }
}

export function evaluateApprovalConditionFormula(
  expression: string,
  formData: Record<string, unknown>,
  requester: RequesterFormulaContext | null = null,
): boolean {
  const result = evaluateAst(parseFormula(expression), formData, requester)
  if (typeof result !== 'boolean') {
    fail('formula must return boolean')
  }
  return result
}
