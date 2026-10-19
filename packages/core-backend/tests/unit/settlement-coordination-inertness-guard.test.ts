/**
 * P11-A01 production inertness, static half: in P1-1 the settlement coordination package stays out
 * of every production call path.
 *
 *  - Production files may import from the coordination modules only as `ALLOWED_IMPORTS` says, file
 *    by file and export by export.
 *  - No production file builds a coordinator, opens a coordinated transaction or runs a coordination
 *    context: the identifiers that do so (`ACTIVATION`) appear only inside the coordination modules,
 *    tests and the declaration sites listed with them.
 *  - No production call site passes the handed-over option to the runner, `dispatchAction` or
 *    `createCancelRoundInstance`: that option's identifier appears only where it is declared.
 *
 * "Production" is every source file under the walked roots except the coordination modules and
 * tests. The population is walked from disk, and the walk asserts it reached known files, so a scan
 * of the wrong tree fails instead of passing.
 *
 * Identifier matching alone cannot see a fourth positional argument, an options object spread into a
 * call, or a call written inside the file that declares a hook (Codex S3-CX-04). So every production
 * script file (.ts / .tsx / .mts / .cts / .js / .mjs / .cjs; not .vue) is also checked on the syntax
 * tree (`checkCoordinationCallSitesV1`):
 *  - a callee is named after parentheses, `as` / `satisfies` / `<T>` assertions, `!` and the last
 *    operand of a comma expression are taken off, and an element access is named when its key is a
 *    string literal or a concatenation / template of string literals;
 *  - `dispatchAction(...)`: at most three arguments, no spread argument, no `.call` / `.apply` / `.bind`;
 *  - `createCancelRoundInstance(...)`: at most three arguments, no spread argument, and a third argument
 *    only as an object literal whose keys are plain and listed (`reason`), no spread, no computed key;
 *  - `allocateRequestNo(...)` with an argument only in `createCancelRoundInstance`, as exactly
 *    `handover ? client : undefined`;
 *  - the three method names above appear nowhere else in an expression: not assigned, passed as an
 *    argument (`Reflect.apply`, `Reflect.construct`, `Function.prototype.call.call`, …), destructured,
 *    shorthand-referenced, nor written as a string or a constant string concatenation outside a type.
 *    Allowed besides the direct call: their declarations (method, function, signature, property,
 *    import / export specifier) and any position inside a type (`Pick<…, 'dispatchAction'>`);
 *  - the handed-over option's name only at its four declaration / read nodes inside the two methods,
 *    never as a string; and each method binds `handover` exactly once, from exactly that option
 *    (`settlementCoordinationHandover`; `options.settlementCoordinationHandover`), never reassigned;
 *  - the activation functions and classes: no call, no `new`, no reference other than their own
 *    declaration, anywhere in production — the declaring file included.
 *
 * Not claimed: a method name assembled at run time from non-literal pieces (`[a, b].join('')`) is out
 * of reach of a syntax check, and `.vue` files are only covered by the text rules above.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const ROOTS = ['packages', 'plugins', 'scripts', 'apps']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.turbo', '.vite', '.next', 'out'])
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.cjs', '.mjs', '.vue'])
const COORDINATION_DIR = 'packages/core-backend/src/attendance/coordination/'

/** Production file → the coordination exports it may import (dormant hooks; read-only context access). */
const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  // The handed-over runner: refuses outside the context, turns 40001 / 40P01 into the restart signal.
  'packages/core-backend/src/attendance/w4c0-operation-registry.ts': ['SettlementCoordinationRestartSignalV1', 'currentSettlementCoordinationContextV1'],
  // The class-00 helper: re-entrant no-op only inside an active context whose credential covers it.
  'packages/core-backend/src/attendance/w4c0-identity.ts': ['currentSettlementCoordinationContextV1'],
  // dispatchAction's handed-over mode: a recheck mismatch asks the port for a restart.
  'packages/core-backend/src/services/ApprovalProductService.ts': ['SettlementCoordinationRecheckMismatchV1'],
  // The production nesting guard (count mode): every main-pool connect is noted.
  'packages/core-backend/src/integration/db/connection-pool.ts': ['noteSettlementCoordinationMainPoolAccessV1'],
}

/** Identifiers that activate the coordination path → production files allowed to declare them. */
const ACTIVATION: ReadonlyArray<Readonly<{ name: string; pattern: RegExp; declaredIn: readonly string[] }>> = [
  { name: 'createSettlementCoordinatorV1', pattern: /\bcreateSettlementCoordinatorV1\b/, declaredIn: [] },
  { name: 'new SettlementCoordinatorV1', pattern: /\bnew\s+SettlementCoordinatorV1\b/, declaredIn: [] },
  { name: 'coordinated transaction port', pattern: /\bcoordinatedTransaction\w*\b/, declaredIn: [] },
  { name: 'coordination context run', pattern: /\brunInSettlementCoordinationContextV1\b/, declaredIn: [] },
  { name: 'CLI coordinator factory', pattern: /\bcreateSettlementCoordinationCliCoordinatorV1\b/, declaredIn: [] },
  { name: 'handed-over option', pattern: /\bsettlementCoordinationHandover\b/, declaredIn: ['packages/core-backend/src/services/ApprovalProductService.ts'] },
  {
    name: 'handed-over runner',
    pattern: /\brunAttendanceResultOperationHandedOverV1\b/,
    declaredIn: ['packages/core-backend/src/attendance/w4c0-operation-registry.ts'],
  },
]

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // Only a root that does not exist is skipped; any other failure would shrink the population silently.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out)
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
}

function isProduction(relative: string): boolean {
  if (relative.startsWith(COORDINATION_DIR)) return false
  if (relative.split('/').includes('__tests__')) return false
  if (relative.startsWith('packages/core-backend/tests/')) return false
  return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(relative)
}

/** Named imports per coordination module specifier, from `import … from '…/coordination/…'` (and `export … from`). */
function coordinationImports(text: string): Array<{ specifier: string; names: string[] }> {
  const found: Array<{ specifier: string; names: string[] }> = []
  // The clause is one of the import grammar's shapes (`{…}`, `*`, `* as X`, `X`, `X, {…}`), so a match
  // never runs across another statement.
  const statement = /\b(?:import|export)\s+(?:type\s+)?((?:[\w$]+\s*,\s*)?(?:\{[^{}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+))\s+from\s+['"]([^'"]*coordination\/[^'"]*)['"]/g
  for (const match of text.matchAll(statement)) {
    const clause = match[1]
    const braces = clause.match(/\{([^{}]*)\}/)
    const names = braces
      ? braces[1].split(',').map((part) => part.replace(/\btype\s+/, '').trim().split(/\s+as\s+/)[0]).filter(Boolean)
      : [clause.trim()]
    found.push({ specifier: match[2], names })
  }
  const required = /\brequire\(\s*['"]([^'"]*coordination\/[^'"]*)['"]\s*\)/g
  for (const match of text.matchAll(required)) found.push({ specifier: match[1], names: ['<require>'] })
  const dynamic = /\bimport\(\s*['"`]([^'"`]*coordination\/[^'"`]*)['"`]\s*\)/g
  for (const match of text.matchAll(dynamic)) found.push({ specifier: match[1], names: ['<dynamic import>'] })
  // A bare side-effect import runs the module without naming anything it exports.
  const bare = /(?:^|[;\n])\s*import\s+['"]([^'"]*coordination\/[^'"]*)['"]/g
  for (const match of text.matchAll(bare)) found.push({ specifier: match[1], names: ['<side-effect import>'] })
  return found
}

function productionFiles(): Array<{ relative: string; text: string }> {
  const files: string[] = []
  for (const root of ROOTS) walk(path.join(REPO_ROOT, root), files)
  const relative = files.map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
  // The walk must cover the real tree.
  expect(relative).toContain('packages/core-backend/src/attendance/coordination/settlement-coordinator.ts')
  expect(relative).toContain('packages/core-backend/src/attendance/w4c0-operation-registry.ts')
  expect(relative).toContain('packages/core-backend/src/services/ApprovalProductService.ts')
  expect(relative).toContain('packages/core-backend/src/index.ts')
  expect(relative).toContain('plugins/plugin-attendance/index.cjs')
  expect(relative.length).toBeGreaterThan(1000)
  return relative.filter(isProduction).map((file) => ({ relative: file, text: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') }))
}

describe('settlement coordination stays out of production call paths (P11-A01, static)', () => {
  const files = productionFiles()

  it('production files import coordination exports only as allowlisted', () => {
    const seen: Record<string, string[]> = {}
    for (const { relative, text } of files) {
      for (const { names } of coordinationImports(text)) (seen[relative] ??= []).push(...names)
    }
    for (const [file, names] of Object.entries(seen)) {
      const allowed = new Set(ALLOWED_IMPORTS[file] ?? [])
      expect({ file, notAllowed: names.filter((name) => !allowed.has(name)) }).toEqual({ file, notAllowed: [] })
    }
    // Every allowlisted file still imports what it is allowed to (a stale allowlist hides drift).
    for (const [file, names] of Object.entries(ALLOWED_IMPORTS)) {
      expect({ file, imports: [...new Set(seen[file] ?? [])].sort() }).toEqual({ file, imports: [...names].sort() })
    }
  })

  it('no production file builds a coordinator, opens a coordinated transaction, runs a context or passes the handed-over option', () => {
    for (const activation of ACTIVATION) {
      const hits = files.filter(({ text }) => activation.pattern.test(text)).map(({ relative }) => relative)
      expect({ activation: activation.name, hits: hits.filter((file) => !activation.declaredIn.includes(file)) }).toEqual({
        activation: activation.name,
        hits: [],
      })
    }
  })

  it('the import scanner sees named, type-only, aliased, re-exported, required and dynamic imports', () => {
    const sample = [
      "import { performance } from 'node:perf_hooks'",
      "export interface Unrelated { a: string }",
      "import { a, type B, c as d } from '../attendance/coordination/settlement-coordinator'",
      "import type { E } from './coordination/settlement-coordination-context'",
      "export { f } from './coordination/settlement-coordination-port'",
      "export * from './coordination/settlement-coordination-budget'",
      "const g = require('../coordination/settlement-coordination-key')",
      "const h = await import('./coordination/settlement-coordination-clock')",
      'const i = await import(`./coordination/settlement-coordination-cli`)',
      "import './attendance/coordination/settlement-coordination-cli'",
    ].join('\n')
    expect(coordinationImports(sample).flatMap((entry) => entry.names)).toEqual([
      'a',
      'B',
      'c',
      'E',
      'f',
      '*',
      '<require>',
      '<dynamic import>',
      '<dynamic import>',
      '<side-effect import>',
    ])
  })
})


// ---------------------------------------------------------------------------
// Call sites on the syntax tree (Codex S3-CX-04; Opus S3 closure P3-N1)
// ---------------------------------------------------------------------------

const APS_FILE = 'packages/core-backend/src/services/ApprovalProductService.ts'
const AST_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])
const CREATE_OPTION_KEYS: ReadonlySet<string> = new Set(['reason'])
const HANDED_OVER_OPTION = 'settlementCoordinationHandover'
/** Where the option's name may appear: method → number of occurrences (parameter + read; type key + read). */
const HANDED_OVER_OPTION_SITES: Readonly<Record<string, number>> = { dispatchAction: 2, createCancelRoundInstance: 2 }
/** The one `handover` binding of each method, by the exact source text of its initializer. */
const HANDOVER_BINDINGS: Readonly<Record<string, readonly string[]>> = {
  dispatchAction: ['settlementCoordinationHandover'],
  createCancelRoundInstance: ['options.settlementCoordinationHandover'],
}
/** Methods whose arguments can carry the handed-over mode or its connection. */
const WATCHED_METHODS: ReadonlySet<string> = new Set(['dispatchAction', 'createCancelRoundInstance', 'allocateRequestNo'])
const ACTIVATION_NAMES: ReadonlyArray<string | RegExp> = [
  'createSettlementCoordinatorV1',
  'SettlementCoordinatorV1',
  'SettlementCoordinationUnitV1',
  /^coordinatedTransaction\w*$/,
  'runInSettlementCoordinationContextV1',
  'createSettlementCoordinationCliCoordinatorV1',
  'handOverToSuspendedMethodV1',
  'runAttendanceResultOperationHandedOverV1',
]

interface CallSiteViolation {
  readonly file: string
  readonly line: number
  readonly rule: string
  readonly text: string
}

interface CallSiteCensus {
  dispatchCalls: number
  createCalls: number
  allocateCalls: number
  handedOverOptionSites: Record<string, number>
  handoverBindings: Record<string, string[]>
}

function isActivationName(name: string): boolean {
  return ACTIVATION_NAMES.some((entry) => (typeof entry === 'string' ? entry === name : entry.test(name)))
}

/** `=`, `+=`, `??=`, … (the public API has no predicate for the operator kinds). */
function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

/** Wrappers that pass a value through unchanged: `(x)`, `x as T`, `x satisfies T`, `<T>x`, `x!`, `(a, x)`. */
function isValueWrapper(parent: ts.Node, child: ts.Node): boolean {
  if (
    ts.isParenthesizedExpression(parent)
    || ts.isAsExpression(parent)
    || ts.isSatisfiesExpression(parent)
    || ts.isTypeAssertionExpression(parent)
    || ts.isNonNullExpression(parent)
  ) {
    return parent.expression === child
  }
  return ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.CommaToken && parent.right === child
}

/** Takes the value wrappers off an expression. */
function unwrapValue(expression: ts.Expression): ts.Expression {
  for (;;) {
    if (
      ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isSatisfiesExpression(expression)
      || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression)
    ) {
      expression = expression.expression
    } else if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      expression = expression.right
    } else {
      return expression
    }
  }
}

/** The outermost wrapper whose value is `node`'s value. */
function outermostValue(node: ts.Node): ts.Node {
  let current = node
  while (current.parent && isValueWrapper(current.parent, current)) current = current.parent
  return current
}

/** The string a string literal, or a `+` concatenation / template of string literals, always evaluates to. */
function constantString(expression: ts.Expression): string | null {
  const inner = unwrapValue(expression)
  if (ts.isStringLiteralLike(inner)) return inner.text
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantString(inner.left)
    const right = left === null ? null : constantString(inner.right)
    return left !== null && right !== null ? left + right : null
  }
  if (ts.isTemplateExpression(inner)) {
    let text = inner.head.text
    for (const span of inner.templateSpans) {
      const part = constantString(span.expression)
      if (part === null) return null
      text += part + span.literal.text
    }
    return text
  }
  return null
}

/**
 * The called name, for `f()`, `x.f()`, `x['f']()` (or a constant string key), and `x.f.call / .apply /
 * .bind(...)` (marked indirect), after the value wrappers are taken off the callee.
 */
function calledName(callee: ts.Expression): { name: string | null; indirect: boolean } {
  const target = unwrapValue(callee)
  if (ts.isIdentifier(target)) return { name: target.text, indirect: false }
  if (ts.isPropertyAccessExpression(target)) {
    const member = target.name.text
    if (member === 'call' || member === 'apply' || member === 'bind') {
      const receiver = unwrapValue(target.expression)
      const inner = ts.isIdentifier(receiver) ? receiver.text : calledName(receiver).name
      if (inner) return { name: inner, indirect: true }
    }
    return { name: member, indirect: false }
  }
  if (ts.isElementAccessExpression(target)) {
    const key = constantString(target.argumentExpression)
    if (key !== null) return { name: key, indirect: false }
  }
  return { name: null, indirect: false }
}

function enclosingMethodName(node: ts.Node): string | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && current.name && ts.isIdentifier(current.name)) return current.name.text
  }
  return null
}

function isOwnDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent
  return (
    ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
    || ts.isImportSpecifier(parent)
    || ts.isExportSpecifier(parent)
    || ts.isImportClause(parent)
    || ts.isNamespaceImport(parent)
  )
}

/** Inside a type annotation, a type argument, an interface or a type alias: erased, never run. */
function inTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isExpressionWithTypeArguments(current)) continue
    if (ts.isTypeNode(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return true
  }
  return false
}

/** `node` (an identifier or a string naming a member) is the name a declaration gives its member or binding. */
function isDeclaredMemberName(node: ts.Node): boolean {
  const parent = node.parent
  return (
    ((ts.isMethodDeclaration(parent)
      || ts.isFunctionDeclaration(parent)
      || ts.isMethodSignature(parent)
      || ts.isPropertySignature(parent)
      || ts.isPropertyDeclaration(parent)
      || ts.isPropertyAssignment(parent)
      || ts.isGetAccessorDeclaration(parent)
      || ts.isSetAccessorDeclaration(parent))
      && parent.name === node)
    || ts.isImportSpecifier(parent)
    || ts.isExportSpecifier(parent)
  )
}

/**
 * Whether a watched method's name at `node` stands where a call is made: the member name (or the key
 * of an element access) whose value, through the value wrappers, is the callee of a call or `new`, or
 * the receiver of a `.call` / `.apply` / `.bind` that is itself called (reported by its own rule).
 */
function isDirectCallee(node: ts.Node): boolean {
  let reference: ts.Node = node
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    reference = parent
  } else if (!ts.isIdentifier(node)) {
    const key = outermostValue(node)
    if (!ts.isElementAccessExpression(key.parent) || key.parent.argumentExpression !== key) return false
    reference = key.parent
  }
  const value = outermostValue(reference)
  const user = value.parent
  if ((ts.isCallExpression(user) || ts.isNewExpression(user)) && user.expression === value) return true
  if (ts.isPropertyAccessExpression(user) && user.expression === value && ['call', 'apply', 'bind'].includes(user.name.text)) {
    const called = outermostValue(user)
    return ts.isCallExpression(called.parent) && called.parent.expression === called
  }
  return false
}

/** Checks every production call site and reference of the watched names; returns violations and a census. */
function checkCoordinationCallSitesV1(sources: ReadonlyArray<{ relative: string; text: string }>): { violations: CallSiteViolation[]; census: CallSiteCensus } {
  const violations: CallSiteViolation[] = []
  const census: CallSiteCensus = { dispatchCalls: 0, createCalls: 0, allocateCalls: 0, handedOverOptionSites: {}, handoverBindings: {} }
  for (const { relative, text } of sources) {
    if (!AST_EXTENSIONS.has(path.extname(relative))) continue
    // Every file is parsed: a name assembled from string pieces need not contain any watched word.
    const kind = /\.[cm]?js$/.test(relative) ? ts.ScriptKind.JS : relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const sourceFile = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, kind)
    const report = (node: ts.Node, rule: string): void => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      violations.push({ file: relative, line: line + 1, rule, text: node.getText(sourceFile).slice(0, 160) })
    }
    const checkReference = (node: ts.Node, name: string): void => {
      if (inTypePosition(node) || isDeclaredMemberName(node) || isDirectCallee(node)) return
      report(node, `${name} referenced outside a direct call`)
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const { name, indirect } = calledName(node.expression)
        const args = node.arguments ? [...node.arguments] : []
        const spread = args.some((arg) => ts.isSpreadElement(arg))
        const watchedCall = name !== null && WATCHED_METHODS.has(name)
        if (watchedCall && indirect) {
          // `.call` / `.apply` / `.bind` move the arguments; none of them is used in production today.
          if (name === 'dispatchAction') census.dispatchCalls += 1
          if (name === 'createCancelRoundInstance') census.createCalls += 1
          if (name === 'allocateRequestNo') census.allocateCalls += 1
          report(node, `${name} called through call / apply / bind`)
        } else if (name === 'dispatchAction') {
          census.dispatchCalls += 1
          if (args.length > 3) report(node, 'dispatchAction with a fourth argument')
          if (spread) report(node, 'dispatchAction with a spread argument')
        } else if (name === 'createCancelRoundInstance') {
          census.createCalls += 1
          if (args.length > 3) report(node, 'createCancelRoundInstance with a fourth argument')
          if (spread) report(node, 'createCancelRoundInstance with a spread argument')
          const options = args[2]
          if (options && !ts.isSpreadElement(options)) {
            if (!ts.isObjectLiteralExpression(options)) {
              report(node, 'createCancelRoundInstance options not written as an object literal')
            } else {
              for (const property of options.properties) {
                if (ts.isSpreadAssignment(property)) report(property, 'createCancelRoundInstance options spread')
                else if (!property.name || !ts.isIdentifier(property.name) || !CREATE_OPTION_KEYS.has(property.name.text)) {
                  report(property, 'createCancelRoundInstance option key not allowed')
                }
              }
            }
          }
        } else if (name === 'allocateRequestNo') {
          census.allocateCalls += 1
          if (args.length > 0) {
            const allowed = relative === APS_FILE
              && enclosingMethodName(node) === 'createCancelRoundInstance'
              && args.length === 1
              && args[0].getText(sourceFile) === 'handover ? client : undefined'
            if (!allowed) report(node, 'allocateRequestNo with a connection outside the handed-over creation')
          }
        }
      }
      if (ts.isIdentifier(node)) {
        if (node.text === HANDED_OVER_OPTION) {
          const method = enclosingMethodName(node)
          if (relative === APS_FILE && method && method in HANDED_OVER_OPTION_SITES) {
            census.handedOverOptionSites[method] = (census.handedOverOptionSites[method] ?? 0) + 1
          } else {
            report(node, 'handed-over option outside its declaration')
          }
        } else if (isActivationName(node.text) && !isOwnDeclarationName(node)) {
          report(node, 'activation reference in production')
        } else if (node.text === 'ApprovalSettlementCoordinationHandoverV1' && relative !== APS_FILE) {
          report(node, 'handover type outside the approval service')
        } else if (WATCHED_METHODS.has(node.text)) {
          checkReference(node, node.text)
        }
      }
      if (ts.isStringLiteralLike(node)) {
        if (node.text === HANDED_OVER_OPTION || isActivationName(node.text)) report(node, 'watched name as a string')
        else if (WATCHED_METHODS.has(node.text)) checkReference(node, node.text)
      }
      if ((ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) || ts.isTemplateExpression(node)) {
        const folded = constantString(node)
        const parent = node.parent
        const partOfLarger = ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken && constantString(parent) !== null
        if (folded !== null && !partOfLarger) {
          if (folded === HANDED_OVER_OPTION || isActivationName(folded)) report(node, 'watched name as a string')
          else if (WATCHED_METHODS.has(folded)) checkReference(node, folded)
        }
      }
      if (relative === APS_FILE) {
        const method = enclosingMethodName(node)
        if (method !== null && method in HANDOVER_BINDINGS) {
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'handover') {
            const initializer = node.initializer?.getText(sourceFile) ?? '<none>'
            ;(census.handoverBindings[method] ??= []).push(initializer)
            if (!HANDOVER_BINDINGS[method].includes(initializer)) report(node, 'handed-over binding read from somewhere else')
          } else if ((ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name) && node.name.text === 'handover') {
            report(node, 'handed-over binding declared again')
          } else if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
            const target = unwrapValue(node.left)
            if (ts.isIdentifier(target) && target.text === 'handover') report(node, 'handed-over binding reassigned')
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return { violations, census }
}

describe('settlement coordination call sites on the syntax tree (P11-A01, static; Codex S3-CX-04; Opus S3 closure P3-N1)', () => {
  const { violations, census } = checkCoordinationCallSitesV1(productionFiles())

  it('every production call of the three methods has the shapes listed in the header, their names appear nowhere else in an expression, each handed-over binding reads its own option, and the scan is not vacuous', () => {
    expect(violations).toEqual([])
    // Floors, not pins: a parser that saw nothing would pass the rules above vacuously.
    expect(census.dispatchCalls).toBeGreaterThanOrEqual(5)
    expect(census.createCalls).toBeGreaterThanOrEqual(1)
    expect(census.allocateCalls).toBe(2)
    expect(census.handedOverOptionSites).toEqual(HANDED_OVER_OPTION_SITES)
    expect(census.handoverBindings).toEqual(HANDOVER_BINDINGS)
  })

  it('negative and positive controls: each bypass is caught, the shapes production uses are not', () => {
    const route = 'packages/core-backend/src/routes/probe.ts'
    const registry = 'packages/core-backend/src/attendance/w4c0-operation-registry.ts'
    const check = (relative: string, text: string) => checkCoordinationCallSitesV1([{ relative, text }]).violations.map((violation) => violation.rule)
    // Positive controls (the shapes production has today).
    expect(check(route, 'void service.dispatchAction(id, { action, ...rest }, actor)')).toEqual([])
    expect(check(route, 'void service.createCancelRoundInstance(id, { userId, ...actor }, { reason })')).toEqual([])
    expect(check(route, 'void service.createCancelRoundInstance(id, actor)')).toEqual([])
    expect(check(route, 'await this.approvalBridge.dispatchAction(\n  id,\n  request,\n  actor,\n)')).toEqual([])
    expect(check(route, "type Deps = { approvals: Pick<ApprovalProductService, 'dispatchAction'> }\nexport function make(deps: { approvals: Pick<ApprovalProductService, 'dispatchAction'> }) { return deps.approvals.dispatchAction(id, request, actor) }")).toEqual([])
    expect(check(route, "type Dispatch = ApprovalProductService['dispatchAction']\ntype Params = Parameters<typeof service.dispatchAction>")).toEqual([])
    expect(check(route, 'interface Bridge { dispatchAction(id: string, request: unknown, actor: unknown): Promise<unknown> }\nclass B { async dispatchAction(id: string, request: unknown, actor: unknown) { return null } }')).toEqual([])
    expect(check('apps/web/src/approvals/store.ts', "import { dispatchAction, other } from './api'\nexport async function act(id, req) { return dispatchAction(id, req) }")).toEqual([])
    expect(check('apps/web/src/approvals/api.ts', 'export async function dispatchAction(id: string, req: unknown) { return post(id, req) }')).toEqual([])
    expect(check(route, "const label = 'product.dispatchAction('")).toEqual([])
    expect(check(route, 'void service.dispatchAction?.(id, request, actor)\nvoid service?.dispatchAction(id, request, actor)')).toEqual([])
    expect(check(APS_FILE, 'class A { async createCancelRoundInstance(a, b, options = {}) { const handover = options.settlementCoordinationHandover; const n = await this.allocateRequestNo(handover ? client : undefined); const m = await this.allocateRequestNo() } }')).toEqual([])
    expect(check(APS_FILE, 'class A { async dispatchAction(id, request, actor, settlementCoordinationHandover) { const handover = settlementCoordinationHandover; if (handover) client = handover.client } }')).toEqual([])
    expect(check(registry, 'export async function runAttendanceResultOperationHandedOverV1(connection, body) { return body(connection) }')).toEqual([])
    // Negative controls (Codex S3-CX-04 and the obvious neighbours).
    expect(check(route, "void service.dispatchAction(id, request, actor, { client, rolloutLock: { kind: 'none' }, commit: async () => {} })")).toEqual(['dispatchAction with a fourth argument'])
    expect(check(route, 'void service.dispatchAction(...args)')).toEqual(['dispatchAction with a spread argument'])
    expect(check(route, 'void service.dispatchAction.call(service, id, request, actor)')).toEqual(['dispatchAction called through call / apply / bind'])
    expect(check(route, "void service['dispatchAction'](id, request, actor, handover)")).toEqual(['dispatchAction with a fourth argument'])
    expect(check(route, 'void service.createCancelRoundInstance(id, actor, { ...options })')).toEqual(['createCancelRoundInstance options spread'])
    expect(check(route, 'void service.createCancelRoundInstance(id, actor, options)')).toEqual(['createCancelRoundInstance options not written as an object literal'])
    expect(check(route, 'void service.createCancelRoundInstance(id, actor, { reason, handover })')).toEqual(['createCancelRoundInstance option key not allowed'])
    expect(check(route, "void service.createCancelRoundInstance(id, actor, { ['settlement' + 'CoordinationHandover']: h })")).toEqual([
      'createCancelRoundInstance option key not allowed',
      'watched name as a string',
    ])
    expect(check(APS_FILE, 'class A { async other() { await this.allocateRequestNo(client) } }')).toEqual(['allocateRequestNo with a connection outside the handed-over creation'])
    expect(check(APS_FILE, 'class A { async other() { this.dispatchAction(id, request, actor, settlementCoordinationHandover) } }')).toEqual([
      'dispatchAction with a fourth argument',
      'handed-over option outside its declaration',
    ])
    expect(check(registry, 'export async function runAttendanceResultOperationHandedOverV1(connection, body) { return body(connection) }\nexport async function caller(client, body) { return runAttendanceResultOperationHandedOverV1(client, body) }')).toEqual([
      'activation reference in production',
    ])
    expect(check(route, 'const open = coordinatedTransactionV1; void open')).toEqual(['activation reference in production'])
    expect(check(route, 'const h: ApprovalSettlementCoordinationHandoverV1 = make()')).toEqual(['handover type outside the approval service'])
    expect(check(route, "const options = { ['settlementCoordinationHandover']: h }")).toEqual(['watched name as a string'])
    expect(check(route, 'void service.createCancelRoundInstance.apply(service, [id, actor, opts])')).toEqual(['createCancelRoundInstance called through call / apply / bind'])

    // Opus S3 closure P3-N1: callee shapes behind value wrappers (oscl_15 and the §C.6 list).
    expect(check(route, 'void (service.dispatchAction as (...args: unknown[]) => unknown)(id, request, actor, extra)')).toEqual(['dispatchAction with a fourth argument'])
    expect(check(route, 'void (<(...args: unknown[]) => unknown>service.dispatchAction)(id, request, actor, extra)')).toEqual(['dispatchAction with a fourth argument'])
    expect(check(route, 'void (service.dispatchAction satisfies unknown as never as (...a: unknown[]) => unknown)(id, request, actor, extra)')).toEqual(['dispatchAction with a fourth argument'])
    expect(check(route, 'void service.dispatchAction!(id, request, actor, extra)')).toEqual(['dispatchAction with a fourth argument'])
    expect(check(route, 'void (0, service.dispatchAction)(id, request, actor, extra)')).toEqual(['dispatchAction with a fourth argument'])
    expect(check(route, "void service['dispatch' + 'Action'](id, request, actor, extra)")).toEqual(['dispatchAction with a fourth argument'])
    expect(check(route, 'void service[`dispatch${"Action"}`](id, request, actor, extra)')).toEqual(['dispatchAction with a fourth argument'])
    expect(check(route, 'void (service.createCancelRoundInstance as Function).apply(service, [id, actor, opts])')).toEqual(['createCancelRoundInstance called through call / apply / bind'])
    // A reference anywhere but the callee (oscl_14 and the §C.6 list).
    expect(check(route, 'void Reflect.apply(service.dispatchAction, service, [id, request, actor, extra])')).toEqual(['dispatchAction referenced outside a direct call'])
    expect(check(route, 'void Reflect.apply(service.createCancelRoundInstance, service, [id, actor, options])')).toEqual(['createCancelRoundInstance referenced outside a direct call'])
    expect(check(route, 'void Reflect.construct(service.allocateRequestNo, [client])')).toEqual(['allocateRequestNo referenced outside a direct call'])
    expect(check(route, 'void Function.prototype.call.call(service.dispatchAction, service, id, request, actor, extra)')).toEqual(['dispatchAction referenced outside a direct call'])
    expect(check(route, 'const run = service.dispatchAction; void run.call(service, id, request, actor, extra)')).toEqual(['dispatchAction referenced outside a direct call'])
    expect(check(route, 'const { dispatchAction: run } = service; void run.call(service, id, request, actor, extra)')).toEqual(['dispatchAction referenced outside a direct call'])
    expect(check(route, 'const { dispatchAction } = service; void dispatchAction.call(service, id, request, actor, extra)')).toEqual([
      'dispatchAction referenced outside a direct call',
      'dispatchAction called through call / apply / bind',
    ])
    expect(check(route, 'void forward({ dispatchAction })')).toEqual(['dispatchAction referenced outside a direct call'])
    expect(check(route, "const name = 'dispatchAction'; void (service as any)[name](id, request, actor, extra)")).toEqual(['dispatchAction referenced outside a direct call'])
    expect(check(route, "const name = 'dispatch' + 'Action'; void (service as any)[name](id, request, actor, extra)")).toEqual(['dispatchAction referenced outside a direct call'])
    expect(check(route, "const name = `create${'CancelRound'}Instance`; void (service as any)[name](id, actor, options)")).toEqual(['createCancelRoundInstance referenced outside a direct call'])
    expect(check(route, 'void (cond ? service.dispatchAction : other)(id, request, actor, extra)')).toEqual(['dispatchAction referenced outside a direct call'])
    expect(check(route, 'void service.dispatchAction`${id}`')).toEqual(['dispatchAction referenced outside a direct call'])
    expect(check(route, "if (typeof service.dispatchAction === 'function') void 0")).toEqual(['dispatchAction referenced outside a direct call'])
    expect(check(route, 'const bound = service.dispatchAction.bind(service)')).toEqual(['dispatchAction called through call / apply / bind'])
    // Opus S3 closure P3-N1: the handed-over binding read from another key (oscl_16, OM-G3).
    expect(check(APS_FILE, 'class A { async dispatchAction(id, request, actor, settlementCoordinationHandover) { const handover = settlementCoordinationHandover ?? (request as { coordination?: unknown }).coordination } }')).toEqual([
      'handed-over binding read from somewhere else',
    ])
    expect(check(APS_FILE, 'class A { async dispatchAction(id, request, actor, settlementCoordinationHandover) { const handover = (request as { coordination?: unknown }).coordination } }')).toEqual([
      'handed-over binding read from somewhere else',
    ])
    expect(check(APS_FILE, 'class A { async createCancelRoundInstance(a, b, options = {}) { const handover = options.coordination } }')).toEqual([
      'handed-over binding read from somewhere else',
    ])
    expect(check(APS_FILE, 'class A { async dispatchAction(id, request, actor, settlementCoordinationHandover) { let handover = settlementCoordinationHandover; handover = request.coordination } }')).toEqual([
      'handed-over binding reassigned',
    ])
    expect(check(APS_FILE, 'class A { async dispatchAction(id, request, actor, settlementCoordinationHandover) { const handover = settlementCoordinationHandover; const run = ({ handover } = request) => handover } }')).toEqual([
      'handed-over binding declared again',
    ])
  })
})

// ---------------------------------------------------------------------------
// The coordination modules themselves do nothing at import time (Opus S3 P3-6; S3 closure P3-N2)
// ---------------------------------------------------------------------------

/** Constructors whose `new` with inert arguments builds an empty, private value and runs nothing else. */
const INERT_CONSTRUCTORS: ReadonlySet<string> = new Set(['AsyncLocalStorage', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Error'])
/** Calls that only build a value from their (inert) arguments. */
const INERT_CALLS: ReadonlySet<string> = new Set(['Symbol', 'Symbol.for', 'Object.freeze'])
/** Globals a property read may start from: their members are plain functions and constants. */
const INERT_PROPERTY_ROOTS: ReadonlySet<string> = new Set(['Object', 'Symbol', 'Number', 'String', 'Math'])
/** Globals that may be read by name (not `process`, `globalThis`, `global`, `window`, …). */
const INERT_GLOBALS: ReadonlySet<string> = new Set([...INERT_PROPERTY_ROOTS, 'Error', 'undefined', 'NaN', 'Infinity'])

interface InertScope {
  /** Every name the module binds at its top level: imports and declarations. */
  readonly bindings: ReadonlySet<string>
  /** Names the module itself declares at its top level (not imports): a property read may start there. */
  readonly constants: ReadonlySet<string>
  /** Top-level function declarations: a call to one is inert when its body is. */
  readonly functions: ReadonlyMap<string, ts.FunctionDeclaration>
  /** Parameters and locals of the helper body being checked. */
  readonly locals: ReadonlySet<string>
  /** Helpers on the current check path (a helper that reaches itself is not inert). */
  readonly visiting: ReadonlySet<string>
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)))
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind) : false
}

function hasDecorators(node: ts.Node): boolean {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []).length > 0 : false
}

/** Names a list of statements binds at its own level. */
function declaredNames(statements: readonly ts.Statement[]): { declared: string[]; imported: string[] } {
  const declared: string[] = []
  const imported: string[] = []
  for (const statement of statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause
      if (clause.name) imported.push(clause.name.text)
      const bindings = clause.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) imported.push(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings)) imported.push(...bindings.elements.map((element) => element.name.text))
    } else if (ts.isImportEqualsDeclaration(statement)) {
      imported.push(statement.name.text)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) declared.push(...bindingNames(declaration.name))
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      declared.push(statement.name.text)
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      declared.push(statement.name.text)
    }
  }
  return { declared, imported }
}

/** A property read whose root is a same-module declaration, a helper's own local or a listed global. */
function isInertPropertyRead(node: ts.Expression, scope: InertScope): boolean {
  let current: ts.Expression = node
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression
    } else if (ts.isElementAccessExpression(current)) {
      if (!isInertExpression(current.argumentExpression, scope)) return false
      current = current.expression
    } else if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression
    } else {
      break
    }
  }
  if (!ts.isIdentifier(current)) return false
  return scope.constants.has(current.text) || scope.locals.has(current.text) || INERT_PROPERTY_ROOTS.has(current.text)
}

/**
 * A helper's body is inert when it only declares locals with inert initializers and returns an inert
 * value; parameters (and their defaults, which must be inert) are its locals. Async and generator
 * helpers are not inert, and neither is a helper that reaches itself.
 */
function isInertHelper(name: string, scope: InertScope): boolean {
  const helper = scope.functions.get(name)
  if (!helper || !helper.body || scope.visiting.has(name)) return false
  if (helper.asteriskToken || hasModifier(helper, ts.SyntaxKind.AsyncKeyword)) return false
  const locals = new Set<string>()
  for (const parameter of helper.parameters) bindingNames(parameter.name).forEach((local) => locals.add(local))
  const inner: InertScope = { ...scope, locals, visiting: new Set([...scope.visiting, name]) }
  for (const parameter of helper.parameters) {
    if (parameter.initializer && !isInertExpression(parameter.initializer, inner)) return false
  }
  for (const statement of helper.body.statements) {
    if (ts.isReturnStatement(statement)) {
      if (statement.expression && !isInertExpression(statement.expression, inner)) return false
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && !isInertExpression(declaration.initializer, inner)) return false
        bindingNames(declaration.name).forEach((local) => locals.add(local))
      }
    } else {
      return false
    }
  }
  return true
}

/** Decorators, `extends` expressions, computed member names and static initializers run when the class is defined. */
function isInertClass(node: ts.ClassLikeDeclaration, scope: InertScope): boolean {
  if (hasDecorators(node)) return false
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
    if (!clause.types.every((type) => isInertExpression(type.expression, scope))) return false
  }
  for (const member of node.members) {
    if (hasDecorators(member)) return false
    if (ts.isClassStaticBlockDeclaration(member)) {
      if (member.body.statements.length > 0) return false
      continue
    }
    if (member.name && ts.isComputedPropertyName(member.name) && !isInertExpression(member.name.expression, scope)) return false
    if (ts.isPropertyDeclaration(member) && hasModifier(member, ts.SyntaxKind.StaticKeyword) && member.initializer && !isInertExpression(member.initializer, scope)) return false
  }
  return true
}

/**
 * Values a module may compute while it loads: literals, functions, frozen literals, empty collections,
 * symbols, reads of its own bindings and of a few listed globals, property reads rooted at its own
 * declarations or at `Object` / `Symbol` / `Number` / `String` / `Math`, and calls to a function
 * declared at the top of the same module whose body is itself inert. Never inert: an assignment
 * (`=`, `+=`, `??=`, …), `++` / `--`, any other call, `new` of anything else, `process.*`,
 * `globalThis.*`, `this`, `delete`, `await`, a tagged template, a computed key or class member that
 * is not inert, a class with decorators, static initializers or a non-empty `static {}` block.
 */
function isInertExpression(node: ts.Expression, scope: InertScope): boolean {
  const inert = (inner: ts.Expression): boolean => isInertExpression(inner, scope)
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return inert(node.expression)
  }
  if (ts.isLiteralExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return true
  if (ts.isIdentifier(node)) return scope.bindings.has(node.text) || scope.locals.has(node.text) || INERT_GLOBALS.has(node.text)
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return isInertPropertyRead(node, scope)
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true
  if (ts.isClassExpression(node)) return isInertClass(node, scope)
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) return false
    return inert(node.operand)
  }
  if (ts.isBinaryExpression(node)) {
    if (isAssignmentOperator(node.operatorToken.kind)) return false
    return inert(node.left) && inert(node.right)
  }
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => inert(span.expression))
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) => ts.isOmittedExpression(element) || (ts.isSpreadElement(element) ? inert(element.expression) : inert(element)))
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((property) => {
      if (ts.isSpreadAssignment(property)) return inert(property.expression)
      if (ts.isShorthandPropertyAssignment(property)) return inert(property.name)
      if (property.name && ts.isComputedPropertyName(property.name) && !inert(property.name.expression)) return false
      if (ts.isPropertyAssignment(property)) return inert(property.initializer)
      return ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)
    })
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && INERT_CONSTRUCTORS.has(node.expression.text)) {
    return (node.arguments ?? []).every((argument) => inert(argument))
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? `${callee.expression.text}.${callee.name.text}` : null
    if (name === null || !node.arguments.every((argument) => inert(argument))) return false
    if (INERT_CALLS.has(name)) return true
    return ts.isIdentifier(callee) && isInertHelper(name, scope)
  }
  return false
}

/** The statements of a module (or a namespace body) that would do something when it is loaded. */
function importTimeOffending(relative: string, sourceFile: ts.SourceFile, statements: readonly ts.Statement[], outer: InertScope | null): string[] {
  const { declared, imported } = declaredNames(statements)
  const functions = new Map(outer?.functions ?? [])
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement)
  }
  const scope: InertScope = {
    bindings: new Set([...(outer?.bindings ?? []), ...declared, ...imported]),
    constants: new Set([...(outer?.constants ?? []), ...declared]),
    functions,
    locals: new Set(),
    visiting: new Set(),
  }
  const offending: string[] = []
  const flag = (node: ts.Node): void => {
    offending.push(`${relative}: ${node.getText(sourceFile).slice(0, 120)}`)
  }
  for (const statement of statements) {
    if (
      ts.isImportDeclaration(statement)
      || ts.isExportDeclaration(statement)
      || ts.isFunctionDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
    ) {
      continue
    }
    if (ts.isClassDeclaration(statement)) {
      if (!isInertClass(statement, scope)) flag(statement)
      continue
    }
    if (ts.isEnumDeclaration(statement)) {
      if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue
      const members: InertScope = { ...scope, constants: new Set([...scope.constants, ...statement.members.flatMap((member) => (ts.isIdentifier(member.name) ? [member.name.text] : []))]) }
      const withMembers: InertScope = { ...members, bindings: new Set([...members.bindings, ...members.constants]) }
      for (const member of statement.members) {
        if (member.initializer && !isInertExpression(member.initializer, withMembers)) flag(member)
      }
      continue
    }
    if (ts.isModuleDeclaration(statement)) {
      if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue
      let body = statement.body
      while (body && ts.isModuleDeclaration(body)) body = body.body
      if (body && ts.isModuleBlock(body)) offending.push(...importTimeOffending(relative, sourceFile, body.statements, scope))
      continue
    }
    if (ts.isVariableStatement(statement)) {
      if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && !isInertExpression(declaration.initializer, scope)) flag(declaration)
      }
      continue
    }
    flag(statement)
  }
  return offending
}

function importTimeStatements(relative: string, text: string): string[] {
  const sourceFile = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return importTimeOffending(relative, sourceFile, sourceFile.statements, null)
}

describe('the coordination modules do nothing at import time (Opus S3 P3-6; S3 closure P3-N2)', () => {
  it('in every coordination module, top-level initializers, class definitions (decorators, extends, computed names, static members), namespace bodies and enum initializers are inert', () => {
    const dir = path.join(REPO_ROOT, COORDINATION_DIR)
    const modules = fs.readdirSync(dir).filter((name) => name.endsWith('.ts'))
    expect(modules.length).toBeGreaterThanOrEqual(15)
    const offending = modules.flatMap((name) => importTimeStatements(`${COORDINATION_DIR}${name}`, fs.readFileSync(path.join(dir, name), 'utf8')))
    expect(offending).toEqual([])
  })

  it('controls: each import-time effect is caught; the shapes the modules use are not', () => {
    const probe = 'packages/core-backend/src/attendance/coordination/probe.ts'
    const offending = (text: string) => importTimeStatements(probe, text).length
    // Positive controls (the shapes the modules use today).
    expect(importTimeStatements(probe, "import { AsyncLocalStorage } from 'node:async_hooks'\nconst storage = new AsyncLocalStorage<number>()\nconst MARK = Symbol.for('x')\nexport const LIMITS = Object.freeze([1, 2])\nconst guard = { mode: 'count', counted: 0 }")).toEqual([])
    expect(importTimeStatements(probe, "function entry(name: string) { return Object.freeze({ name }) }\nexport const REGISTRY = Object.freeze([entry('a')])")).toEqual([])
    expect(importTimeStatements(probe, "type K = Readonly<{ literal: number }>\nfunction fixedKey1(name: string, key1: K, source: string) {\n  return Object.freeze({ name, key1: Object.freeze({ ...key1 }), source })\n}\nconst BASE = 'packages'\nexport const KEY1 = 0x12345678\nexport const R = Object.freeze([fixedKey1('a', { literal: KEY1 }, `${BASE}/a.ts`)])")).toEqual([])
    expect(importTimeStatements(probe, "import { KEY1 } from './key'\nconst LITERAL = `(${KEY1})::int4`\nconst MIN = -2147483648\nconst LABEL = /^[a-z]+$/\nconst ISOLATIONS = new Set(['READ COMMITTED'])\nconst CODES = Object.freeze({ 'class-00': 'BUSY', dedicated: 'BUSY' })")).toEqual([])
    expect(importTimeStatements(probe, "export class CodedError extends Error {\n  readonly code = 'X'\n  #n = 0\n  static isOne(value: unknown): boolean { return value === 1 }\n}\nclass Recorder { readonly events: string[] = []; readonly #id = Symbol('r'); readonly #run = (): void => undefined }")).toEqual([])
    expect(importTimeStatements(probe, 'namespace Probe { export const x = 1 }\nenum Mode { A = 1, B = A, C = Mode.A + 1 }\ndeclare const injected: number\nconst LIMIT = Number.MAX_SAFE_INTEGER\nconst HALF = Math.PI / 2\nconst MODE_TABLE = { short: 1 }\nconst SAME = MODE_TABLE.short')).toEqual([])
    // Negative controls (Opus S3 P3-6).
    expect(offending('registerGlobally()')).toBe(1)
    expect(offending('export const handle = startTimer()')).toBe(1)
    expect(offending('const pool = new Pool()')).toBe(1)
    expect(offending("import { register } from './elsewhere'\nexport const REGISTRY = Object.freeze([register('a')])")).toBe(1)
    // Opus S3 closure P3-N2: oscl_12 (an assignment in an initializer) and oscl_13 (an environment read).
    expect(offending('export function runInSettlementCoordinationContextV1() { return 0 }\nexport const SETTLEMENT_COORDINATION_ARMED_V1 = ((globalThis as Record<string, unknown>).__ms2SettlementCoordinationProbe = runInSettlementCoordinationContextV1)')).toBe(1)
    expect(offending('export const SETTLEMENT_COORDINATION_ENV_V1 = process.env.SETTLEMENT_COORDINATION_PROBE')).toBe(1)
    expect(offending("export const SETTLEMENT_COORDINATION_ENV_V1 = process.env['SETTLEMENT_COORDINATION_PROBE']")).toBe(1)
    expect(offending('export const P = process')).toBe(1)
    expect(offending('export const G = globalThis.setTimeout')).toBe(1)
    expect(offending('const box = { n: 0 }\nexport const B = (box.n = 1)')).toBe(1)
    expect(offending('const box = { n: 0 }\nexport const B = (box.n += 1)')).toBe(1)
    expect(offending('let n = 0\nexport const B = ++n')).toBe(1)
    expect(offending('let n = 0\nexport const B = n++')).toBe(1)
    expect(offending('export const B = this')).toBe(1)
    // A same-module helper is inert only when its own body is (§C.6).
    expect(offending('function arm() { registerGlobally(); return 0 }\nexport const A = arm()')).toBe(1)
    expect(offending('function arm() { return process.env.X }\nexport const A = arm()')).toBe(1)
    expect(offending('function arm(): number { return arm() }\nexport const A = arm()')).toBe(1)
    expect(offending('async function arm() { return 0 }\nexport const A = arm()')).toBe(1)
    expect(offending('const arm = () => registerGlobally()\nexport const A = arm()')).toBe(1)
    // Class definitions (§C.6).
    expect(offending('class P { static { registerGlobally() } }')).toBe(1)
    expect(offending('class P { static readonly t = setInterval(() => undefined, 1000) }')).toBe(1)
    expect(offending('class P { [registerGlobally()]() { return 0 } }')).toBe(1)
    expect(offending('class P extends mixin() {}')).toBe(1)
    expect(offending('@register class P {}')).toBe(1)
    expect(offending('class P { @observe m() { return 0 } }')).toBe(1)
    expect(offending('export const C = class { static t = registerGlobally() }')).toBe(1)
    // Namespace bodies, enum initializers and computed keys (§C.6).
    expect(offending('namespace P { registerGlobally() }')).toBe(1)
    expect(offending('namespace P.Q { export const x = process.env.X }')).toBe(1)
    expect(offending('enum E { A = registerGlobally() }')).toBe(1)
    expect(offending('export const T = { [registerGlobally()]: 1 }')).toBe(1)
    expect(offending('export const T = { [registerGlobally()]() { return 1 } }')).toBe(1)
    expect(offending('export const T = { ...load() }')).toBe(1)
  })
})
