/**
 * SOURCE-DERIVED route ledger for the after-sales object-sheet refusal (#5835).
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * `tests/unit/after-sales-object-sheet-liveness.test.ts` drives 21 routes through the DELETED /
 * ABSENT states and asserts the guided hint. That population used to be a literal array declared by
 * the spec itself, so "covers every route that resolves an object sheet" was a statement about the
 * spec, not about the plugin: a 22nd route that resolves an object sheet through `findObjectSheetId`
 * and forgets the `isObjectSheetUnavailableError(err)` branch answers 500 INTERNAL_ERROR (a strict
 * regression from the 404 the same state produced before #5835 — now that the helper THROWS instead of
 * falling back) and every test stayed green.
 *
 * This scanner reads the plugin source instead, the same way
 * `tests/utils/sheet-liveness-route-scan.ts` does for core route files: the population becomes a fact
 * about `plugins/plugin-after-sales/index.cjs`.
 *
 * ── What it decides, and on the tree (never on text) ──────────────────────────
 *  - a REGISTRATION is `<expr>.addRoute('<VERB>', '<path>', <handler>)` (the plugin HTTP API). A
 *    registration whose verb, path or handler cannot be read is OPAQUE: it is recorded, never dropped,
 *    and the guard test demands the list be empty (fail closed).
 *  - REACHING means the handler calls `findObjectSheetId` directly, or calls a same-file function that
 *    does, transitively. Helpers are resolved BY BODY, never by name; a name with more than one
 *    declaration reaches if ANY of its declarations reaches (fail closed).
 *  - GUARDED means the handler's `catch (err)` holds `if (isObjectSheetUnavailableError(err)) { …
 *    sendObjectSheetUnavailable(…) … return }` — the call, the same catch binding, the send AND the
 *    return. A branch that tests the right thing and then falls through does not count.
 *  - EXEMPT-SHAPED means the handler's catch instead maps `err.code === 'AFTER_SALES_OBJECT_UNAVAILABLE'`
 *    to `sendObjectUnavailable(…)` + `return`. That is the part-inventory contract the web client keys
 *    on (apps/web AfterSalesView hides the parts tab), deliberately kept — the guard test names those
 *    routes as exemptions with their reason instead of letting them disappear from the population.
 *
 * CRLF: the source is normalized to LF before parsing, so a CRLF checkout yields the identical verdict
 * (the #3365 tripwire once found zero routes on a CRLF tree).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'

export const AFTER_SALES_PLUGIN_ENTRY = join(
  __dirname,
  '../../../../plugins/plugin-after-sales/index.cjs',
)

export interface ScannedAfterSalesRoute {
  key: string
  method: string
  path: string
  line: number
  /** calls `findObjectSheetId`, directly or through a same-file helper */
  reaches: boolean
  /** catch maps OBJECT_SHEET_UNAVAILABLE to the guided hint and returns */
  guarded: boolean
  /** catch maps AFTER_SALES_OBJECT_UNAVAILABLE to the install-state refusal and returns */
  mapsObjectUnavailable: boolean
}

export interface OpaqueAfterSalesRegistration {
  line: number
  text: string
}

export interface AfterSalesRouteScan {
  routes: ScannedAfterSalesRoute[]
  opaque: OpaqueAfterSalesRegistration[]
  routeKeys: string[]
  reachingKeys: string[]
  guardedKeys: string[]
  /** reaches `findObjectSheetId` but has no OBJECT_SHEET_UNAVAILABLE mapping */
  unguardedReachingKeys: string[]
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration

const isFunctionLike = (node: ts.Node | undefined): node is FunctionLike =>
  Boolean(
    node &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)),
  )

const walk = (node: ts.Node, visit: (node: ts.Node) => void): void => {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

const literalText = (node: ts.Node | undefined): string | null =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null

/** Every function-like declaration in the file, by name — a name may have several. */
function collectFunctions(sourceFile: ts.SourceFile): Map<string, FunctionLike[]> {
  const functions = new Map<string, FunctionLike[]>()
  const add = (name: string, node: FunctionLike) => {
    const existing = functions.get(name)
    if (existing) existing.push(node)
    else functions.set(name, [node])
  }
  walk(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name.text, node)
      return
    }
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      add(node.name.text, node)
      return
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isFunctionLike(node.initializer)
    ) {
      add(node.name.text, node.initializer)
    }
  })
  return functions
}

/** Names called inside a node: `foo(…)` and `x.foo(…)` alike. */
function calleeNames(node: ts.Node): Set<string> {
  const names = new Set<string>()
  walk(node, (inner) => {
    if (!ts.isCallExpression(inner)) return
    const callee = inner.expression
    if (ts.isIdentifier(callee)) names.add(callee.text)
    else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      names.add(callee.name.text)
    }
  })
  return names
}

function reachesTarget(
  node: ts.Node,
  target: string,
  functions: Map<string, FunctionLike[]>,
  seen: Set<string> = new Set(),
): boolean {
  const names = calleeNames(node)
  if (names.has(target)) return true
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const declarations = functions.get(name)
    if (!declarations) continue
    for (const declaration of declarations) {
      if (reachesTarget(declaration, target, functions, seen)) return true
    }
  }
  return false
}

function catchClauses(node: ts.Node): ts.CatchClause[] {
  const clauses: ts.CatchClause[] = []
  walk(node, (inner) => {
    if (ts.isCatchClause(inner)) clauses.push(inner)
  })
  return clauses
}

/** Does `then` both call `sender(…)` and leave the handler? */
function sendsAndReturns(thenStatement: ts.Statement, sender: string): boolean {
  let sends = false
  let returns = false
  walk(thenStatement, (inner) => {
    if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === sender) {
      sends = true
    }
    if (ts.isReturnStatement(inner)) returns = true
  })
  return sends && returns
}

/** `catch (err) { if (isObjectSheetUnavailableError(err)) { sendObjectSheetUnavailable(res, err); return } … }` */
function hasObjectSheetUnavailableMapping(handler: ts.Node): boolean {
  for (const clause of catchClauses(handler)) {
    const declaration = clause.variableDeclaration
    if (!declaration || !ts.isIdentifier(declaration.name)) continue
    const bound = declaration.name.text
    let found = false
    walk(clause.block, (inner) => {
      if (found || !ts.isIfStatement(inner)) return
      const test = inner.expression
      if (!ts.isCallExpression(test)) return
      if (!ts.isIdentifier(test.expression) || test.expression.text !== 'isObjectSheetUnavailableError') return
      const [argument] = test.arguments
      if (!argument || !ts.isIdentifier(argument) || argument.text !== bound) return
      if (sendsAndReturns(inner.thenStatement, 'sendObjectSheetUnavailable')) found = true
    })
    if (found) return true
  }
  return false
}

/** `catch (err) { if (err && err.code === 'AFTER_SALES_OBJECT_UNAVAILABLE') { sendObjectUnavailable(…); return } … }` */
function hasObjectUnavailableMapping(handler: ts.Node, sourceFile: ts.SourceFile): boolean {
  for (const clause of catchClauses(handler)) {
    let found = false
    walk(clause.block, (inner) => {
      if (found || !ts.isIfStatement(inner)) return
      const test = inner.expression.getText(sourceFile).replace(/\s+/g, ' ')
      if (!test.includes("=== 'AFTER_SALES_OBJECT_UNAVAILABLE'")) return
      if (sendsAndReturns(inner.thenStatement, 'sendObjectUnavailable')) found = true
    })
    if (found) return true
  }
  return false
}

export function scanAfterSalesObjectSheetRoutes(
  entry: string = AFTER_SALES_PLUGIN_ENTRY,
): AfterSalesRouteScan {
  const source = readFileSync(entry, 'utf8').replace(/\r\n/g, '\n')
  const sourceFile = ts.createSourceFile('index.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const functions = collectFunctions(sourceFile)

  const routes: ScannedAfterSalesRoute[] = []
  const opaque: OpaqueAfterSalesRegistration[] = []

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee)) return
    if (!ts.isIdentifier(callee.name) || callee.name.text !== 'addRoute') return

    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    const method = literalText(node.arguments[0])
    const path = literalText(node.arguments[1])
    let handler: ts.Node | undefined = node.arguments[node.arguments.length - 1]
    if (handler && ts.isIdentifier(handler)) {
      const declarations = functions.get(handler.text)
      handler = declarations && declarations.length === 1 ? declarations[0] : undefined
    }
    if (!method || !path || !isFunctionLike(handler)) {
      opaque.push({
        line,
        text: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 160),
      })
      return
    }

    routes.push({
      key: `${method} ${path}`,
      method,
      path,
      line,
      reaches: reachesTarget(handler, 'findObjectSheetId', functions),
      guarded: hasObjectSheetUnavailableMapping(handler),
      mapsObjectUnavailable: hasObjectUnavailableMapping(handler, sourceFile),
    })
  })

  const reaching = routes.filter((route) => route.reaches)
  return {
    routes,
    opaque,
    routeKeys: routes.map((route) => route.key),
    reachingKeys: reaching.map((route) => route.key),
    guardedKeys: reaching.filter((route) => route.guarded).map((route) => route.key),
    unguardedReachingKeys: reaching.filter((route) => !route.guarded).map((route) => route.key),
  }
}
