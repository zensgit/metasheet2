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
 * call, or a call written inside the file that declares a hook (Codex S3-CX-04). So the call sites are
 * also checked on the syntax tree (`checkCoordinationCallSitesV1`):
 *  - `dispatchAction(...)`: at most three arguments, no spread argument, no `.call` / `.apply` / `.bind`;
 *  - `createCancelRoundInstance(...)`: at most three arguments, no spread argument, and a third argument
 *    only as an object literal whose keys are plain and listed (`reason`), no spread, no computed key;
 *  - `allocateRequestNo(...)` with an argument only in `createCancelRoundInstance`, as exactly
 *    `handover ? client : undefined`;
 *  - the handed-over option's name only at its four declaration / read nodes inside the two methods,
 *    never as a string;
 *  - the activation functions and classes: no call, no `new`, no reference other than their own
 *    declaration, anywhere in production — the declaring file included.
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
  } catch {
    return
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
  const dynamic = /\bimport\(\s*['"]([^'"]*coordination\/[^'"]*)['"]\s*\)/g
  for (const match of text.matchAll(dynamic)) found.push({ specifier: match[1], names: ['<dynamic import>'] })
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
    ].join('\n')
    expect(coordinationImports(sample).flatMap((entry) => entry.names)).toEqual(['a', 'B', 'c', 'E', 'f', '*', '<require>', '<dynamic import>'])
  })
})

// ---------------------------------------------------------------------------
// Call sites on the syntax tree (Codex S3-CX-04)
// ---------------------------------------------------------------------------

const APS_FILE = 'packages/core-backend/src/services/ApprovalProductService.ts'
const AST_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])
const CREATE_OPTION_KEYS: ReadonlySet<string> = new Set(['reason'])
const HANDED_OVER_OPTION = 'settlementCoordinationHandover'
/** Where the option's name may appear: method → number of occurrences (parameter + read; type key + read). */
const HANDED_OVER_OPTION_SITES: Readonly<Record<string, number>> = { dispatchAction: 2, createCancelRoundInstance: 2 }
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
const WATCHED_TEXT = ['dispatchAction', 'createCancelRoundInstance', 'allocateRequestNo', HANDED_OVER_OPTION, 'SettlementCoordinat', 'coordinatedTransaction', 'HandedOverV1', 'handOverToSuspendedMethodV1']

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
}

function isActivationName(name: string): boolean {
  return ACTIVATION_NAMES.some((entry) => (typeof entry === 'string' ? entry === name : entry.test(name)))
}

/** The called name, for `f()`, `x.f()`, `x['f']()`, and `x.f.call / .apply / .bind(...)` (marked indirect). */
function calledName(callee: ts.Expression): { name: string | null; indirect: boolean } {
  if (ts.isIdentifier(callee)) return { name: callee.text, indirect: false }
  if (ts.isPropertyAccessExpression(callee)) {
    const member = callee.name.text
    if ((member === 'call' || member === 'apply' || member === 'bind') && !ts.isIdentifier(callee.expression)) {
      const inner = calledName(callee.expression)
      if (inner.name) return { name: inner.name, indirect: true }
    }
    if ((member === 'call' || member === 'apply' || member === 'bind') && ts.isIdentifier(callee.expression)) {
      return { name: callee.expression.text, indirect: true }
    }
    return { name: member, indirect: false }
  }
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return { name: callee.argumentExpression.text, indirect: false }
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

/** Checks every production call site and reference of the watched names; returns violations and a census. */
function checkCoordinationCallSitesV1(sources: ReadonlyArray<{ relative: string; text: string }>): { violations: CallSiteViolation[]; census: CallSiteCensus } {
  const violations: CallSiteViolation[] = []
  const census: CallSiteCensus = { dispatchCalls: 0, createCalls: 0, allocateCalls: 0, handedOverOptionSites: {} }
  for (const { relative, text } of sources) {
    if (!AST_EXTENSIONS.has(path.extname(relative))) continue
    if (!WATCHED_TEXT.some((word) => text.includes(word))) continue
    const kind = /\.[cm]?js$/.test(relative) ? ts.ScriptKind.JS : relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const sourceFile = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, kind)
    const report = (node: ts.Node, rule: string): void => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      violations.push({ file: relative, line: line + 1, rule, text: node.getText(sourceFile).slice(0, 160) })
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const { name, indirect } = calledName(node.expression)
        const args = node.arguments ? [...node.arguments] : []
        const spread = args.some((arg) => ts.isSpreadElement(arg))
        const watchedCall = name === 'dispatchAction' || name === 'createCancelRoundInstance' || name === 'allocateRequestNo'
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
        }
      }
      if (ts.isStringLiteralLike(node) && (node.text === HANDED_OVER_OPTION || isActivationName(node.text))) {
        report(node, 'watched name as a string')
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return { violations, census }
}

describe('settlement coordination call sites on the syntax tree (P11-A01, static; Codex S3-CX-04)', () => {
  const { violations, census } = checkCoordinationCallSitesV1(productionFiles())

  it('no production call can open the handed-over mode or reach an activation, and the scan is not vacuous', () => {
    expect(violations).toEqual([])
    // Floors, not pins: a parser that saw nothing would pass the rules above vacuously.
    expect(census.dispatchCalls).toBeGreaterThanOrEqual(5)
    expect(census.createCalls).toBeGreaterThanOrEqual(1)
    expect(census.allocateCalls).toBe(2)
    expect(census.handedOverOptionSites).toEqual(HANDED_OVER_OPTION_SITES)
  })

  it('negative and positive controls: each bypass is caught, the shapes production uses are not', () => {
    const route = 'packages/core-backend/src/routes/probe.ts'
    const registry = 'packages/core-backend/src/attendance/w4c0-operation-registry.ts'
    const check = (relative: string, text: string) => checkCoordinationCallSitesV1([{ relative, text }]).violations.map((violation) => violation.rule)
    // Positive controls (the shapes production has today).
    expect(check(route, 'void service.dispatchAction(id, { action, ...rest }, actor)')).toEqual([])
    expect(check(route, 'void service.createCancelRoundInstance(id, { userId, ...actor }, { reason })')).toEqual([])
    expect(check(route, 'void service.createCancelRoundInstance(id, actor)')).toEqual([])
    expect(check(APS_FILE, 'class A { async createCancelRoundInstance(a, b, options = {}) { const handover = options.settlementCoordinationHandover; const n = await this.allocateRequestNo(handover ? client : undefined); const m = await this.allocateRequestNo() } }')).toEqual([])
    expect(check(registry, 'export async function runAttendanceResultOperationHandedOverV1(connection, body) { return body(connection) }')).toEqual([])
    // Negative controls (Codex S3-CX-04 and the obvious neighbours).
    expect(check(route, "void service.dispatchAction(id, request, actor, { client, rolloutLock: { kind: 'none' }, commit: async () => {} })")).toEqual(['dispatchAction with a fourth argument'])
    expect(check(route, 'void service.dispatchAction(...args)')).toEqual(['dispatchAction with a spread argument'])
    expect(check(route, 'void service.dispatchAction.call(service, id, request, actor)')).toEqual(['dispatchAction called through call / apply / bind'])
    expect(check(route, "void service['dispatchAction'](id, request, actor, handover)")).toEqual(['dispatchAction with a fourth argument'])
    expect(check(route, 'void service.createCancelRoundInstance(id, actor, { ...options })')).toEqual(['createCancelRoundInstance options spread'])
    expect(check(route, 'void service.createCancelRoundInstance(id, actor, options)')).toEqual(['createCancelRoundInstance options not written as an object literal'])
    expect(check(route, 'void service.createCancelRoundInstance(id, actor, { reason, handover })')).toEqual(['createCancelRoundInstance option key not allowed'])
    expect(check(route, "void service.createCancelRoundInstance(id, actor, { ['settlement' + 'CoordinationHandover']: h })")).toEqual(['createCancelRoundInstance option key not allowed'])
    expect(check(APS_FILE, 'class A { async other() { await this.allocateRequestNo(client) } }')).toEqual(['allocateRequestNo with a connection outside the handed-over creation'])
    expect(check(APS_FILE, 'class A { async other() { this.dispatchAction(id, request, actor, settlementCoordinationHandover) } }')).toEqual([
      'dispatchAction with a fourth argument',
      'handed-over option outside its declaration',
    ])
    expect(check(registry, 'export async function runAttendanceResultOperationHandedOverV1(connection, body) { return body(connection) }\nexport async function caller(client, body) { return runAttendanceResultOperationHandedOverV1(client, body) }')).toEqual([
      'activation reference in production',
    ])
    expect(check(route, 'const open = coordinatedTransactionV1; void open')).toEqual(['activation reference in production'])
    expect(check(route, "const options = { ['settlementCoordinationHandover']: h }")).toEqual(['watched name as a string'])
    expect(check(route, 'void service.createCancelRoundInstance.apply(service, [id, actor, opts])')).toEqual(['createCancelRoundInstance called through call / apply / bind'])
  })
})

