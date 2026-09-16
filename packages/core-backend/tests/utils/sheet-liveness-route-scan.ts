/**
 * AST scanner behind the ALL-ROUTES sheet-liveness closed world
 * (tests/unit/multitable-sheet-liveness-closure-all-routes.guard.test.ts), and the route population the
 * per-file behaviour tests tie their route tables to (`sheetAddressedRouteKeys`).
 *
 * The sibling guard over `routes/univer-meta.ts` finds handlers with a per-line regex and cuts each body
 * at its own closing `})`. That works for one file written in one style. The other route files are not:
 * `router.post(\n  '/path',` registrations, path ARRAYS or strings held in a const, template paths,
 * wrapped handlers (`asyncHandler(async (req, res) => …)`), one-line delegations, helper functions nested
 * inside the router factory, and a helper handed in through dependency injection. So this scanner reads
 * the syntax tree instead (ts.createSourceFile — syntax only, no type checking, the same approach as
 * supertest-app-mode-scan.ts):
 *
 *   - a REGISTRATION is `<expr>.<get|post|put|patch|delete|all>(<path>, …, <handler>)` (or
 *     `<expr>['get'](…)`) where <path> is a '/'-rooted string or template, an array of strings, or an
 *     identifier bound to one of those in scope; or `<expr>.addRoute('<VERB>', '<path>', <handler>)` (the
 *     plugin HTTP API). A call whose last argument is a data literal (object, string, number) is an HTTP
 *     CLIENT call, not a registration. A handler behind a path that cannot be read (`P.list`,
 *     `buildPath(…)`) is still recorded — as OPAQUE, below.
 *   - the HANDLER is the last argument: an inline function, an identifier bound to a same-file function
 *     (or to a const holding one of these), a wrapper call around function arguments (`asyncHandler(fn)`,
 *     `run(fn)`), which is unwrapped, or a call to a same-file handler factory, whose body is read.
 *     Anything else — an imported handler, `controller.method`, an imported factory — is OPAQUE: it is
 *     recorded (fail closed), never silently dropped, and the guard demands it be named.
 *   - a handler's HELPERS are resolved LEXICALLY from each call site (`foo(…)` → the declaration of `foo`
 *     visible from that call), transitively, and only inside the same file. A helper is never classified
 *     by its name: its body is read.
 *   - CODE text is printed from the tree with comments removed, so prose can never satisfy a pattern. The
 *     sibling guard learned that the hard way (a restore route was "guarded" by its own docblock).
 *   - LIVENESS is decided on the tree (`analyzeHandler`), not on text: a refusal is an `if` whose test is
 *     exactly `<liveness> !== 'live'`, whose branch always leaves, and which runs whenever the binding
 *     ran; a gate's result must be acted on by the very next statement; the gate runs before any other
 *     awaited work; and (routes) a capability 403 sits between the resolver call and the liveness 404.
 *
 * CRLF: the source is normalized to LF before parsing. The parser would cope with CRLF, but the printed
 * code and every regex the guard applies to it would then carry `\r` — and a per-line `(.*)$` pattern
 * silently matches nothing on a CRLF tree (the #3365 tripwire defect). Normalizing here keeps one
 * definition of "the source" for every assertion.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'

export const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all'])

/** Resolvers whose result carries `sheetLiveness` (permission-service.ts). */
export const LIVENESS_CARRYING_RESOLVERS = new Set([
  'resolveSheetCapabilities',
  'resolveSheetReadableCapabilities',
  'resolveSheetCapabilitiesForAccess',
])

/** Resolvers whose result does NOT carry liveness (sheet-capabilities.ts) — the caller must ask separately. */
export const LIVENESS_BLIND_RESOLVERS = new Set(['resolveSheetCapabilitiesForUser'])

export type FnNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration

export interface HandlerUnit {
  /** `handler` for an inline handler argument, else the helper's declared name. */
  label: string
  node: FnNode
  /** Code-only text (comments removed). */
  code: string
}

export interface RouteHandler {
  file: string
  verb: string
  /** The literal path, or `[identifier]` when the path is held in a const. */
  pathLabel: string
  paths: string[]
  key: string
  line: number
  /** Code-only text of the handler's own function argument(s). */
  code: string
  /** Handler text verbatim, comments included — for prose assertions only. */
  raw: string
  /** Code-only text of the registration's other arguments (middleware such as `requireAdminRole()`). */
  middleware: string
  /** Same-file helper functions reached transitively from the handler: name → code-only text. */
  helpers: Map<string, string>
  /** Code-only text of same-file NON-function declarations referenced (schemas, path arrays). */
  referenced: string
  /** The handler function(s) and every resolved helper, each as its own unit (per-function rules). */
  units: HandlerUnit[]
}

/** A registration whose handler the scanner cannot read. Recorded so it can never be skipped silently. */
export interface OpaqueRegistration {
  file: string
  verb: string
  key: string
  line: number
  /** What the handler argument is, printed. */
  handler: string
}

export interface ScannedRouteFile {
  file: string
  /** LF-normalized source. */
  source: string
  sourceFile: ts.SourceFile
  handlers: RouteHandler[]
  opaque: OpaqueRegistration[]
}

export function normalizeEol(source: string): string {
  return source.replace(/\r\n?/g, '\n')
}

const printer = ts.createPrinter({ removeComments: true })

export function codeOf(node: ts.Node, sf: ts.SourceFile): string {
  return normalizeEol(printer.printNode(ts.EmitHint.Unspecified, node, sf))
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

export function isFnNode(node: ts.Node | undefined): node is FnNode {
  return !!node && (
    ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
  )
}

type Resolution =
  | { kind: 'function'; name: string; node: FnNode; declaration: ts.Node }
  | { kind: 'value'; name: string; declaration: ts.VariableDeclaration }
  | { kind: 'shadowed' }
  | { kind: 'unresolved' }

function bindingDeclares(name: ts.BindingName, wanted: string): boolean {
  if (ts.isIdentifier(name)) return name.text === wanted
  return name.elements.some((element) => !ts.isOmittedExpression(element) && bindingDeclares(element.name, wanted))
}

function lookupInStatements(statements: ts.NodeArray<ts.Statement>, wanted: string): Resolution | null {
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === wanted) {
      return { kind: 'function', name: wanted, node: statement, declaration: statement }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!bindingDeclares(declaration.name, wanted)) continue
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          const init = unwrap(declaration.initializer)
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            return { kind: 'function', name: wanted, node: init, declaration }
          }
          return { kind: 'value', name: wanted, declaration }
        }
        return { kind: 'shadowed' }
      }
    }
  }
  return null
}

/**
 * Lexical lookup of `name` as seen from `from`: walk outward through blocks and function scopes; a
 * parameter or destructured local of the same name SHADOWS any outer helper (→ not resolvable).
 */
export function resolveIdentifier(from: ts.Node, name: string): Resolution {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (isFnNode(scope)) {
      if (scope.parameters.some((param) => bindingDeclares(param.name, name))) return { kind: 'shadowed' }
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
      const found = lookupInStatements(scope.statements, name)
      if (found) return found
    }
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))
      && scope.initializer && ts.isVariableDeclarationList(scope.initializer)
      && scope.initializer.declarations.some((d) => bindingDeclares(d.name, name))) {
      return { kind: 'shadowed' }
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration && bindingDeclares(scope.variableDeclaration.name, name)) {
      return { kind: 'shadowed' }
    }
  }
  return { kind: 'unresolved' }
}

function contains(outer: ts.Node, inner: ts.Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end
}

function literalPath(expr: ts.Expression): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text.startsWith('/') ? expr.text : null
  }
  if (ts.isTemplateExpression(expr)) {
    // `/${UUID_PARAM}/state` — the path as written, placeholders included.
    return expr.head.text.startsWith('/') ? normalizeEol(expr.getText()).slice(1, -1) : null
  }
  return null
}

function routePathsOf(arg: ts.Expression): { label: string; paths: string[] } | null {
  const expr = unwrap(arg)
  const direct = literalPath(expr)
  if (direct !== null) return { label: direct, paths: [direct] }
  const fromArray = (array: ts.ArrayLiteralExpression): string[] | null => {
    const out: string[] = []
    for (const element of array.elements) {
      const path = literalPath(unwrap(element as ts.Expression))
      if (path === null) return null
      out.push(path)
    }
    return out.length > 0 ? out : null
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const paths = fromArray(expr)
    return paths ? { label: `[${paths.join(', ')}]`, paths } : null
  }
  if (ts.isIdentifier(expr)) {
    const resolved = resolveIdentifier(expr, expr.text)
    if (resolved.kind === 'value' && resolved.declaration.initializer) {
      const init = unwrap(resolved.declaration.initializer)
      const single = literalPath(init)
      if (single !== null) return { label: `[${expr.text}]`, paths: [single] }
      if (ts.isArrayLiteralExpression(init)) {
        const paths = fromArray(init)
        return paths ? { label: `[${expr.text}]`, paths } : null
      }
    }
  }
  return null
}

/** A last argument no Express handler can be: the call is an HTTP client call (`client.post('/x', body)`). */
function isDataLiteral(expr: ts.Expression): boolean {
  return ts.isObjectLiteralExpression(expr)
    || ts.isStringLiteral(expr)
    || ts.isNoSubstitutionTemplateLiteral(expr)
    || ts.isTemplateExpression(expr)
    || ts.isNumericLiteral(expr)
    || expr.kind === ts.SyntaxKind.TrueKeyword
    || expr.kind === ts.SyntaxKind.FalseKeyword
    || expr.kind === ts.SyntaxKind.NullKeyword
}

interface Registration {
  call: ts.CallExpression
  verb: string
  label: string
  paths: string[]
  handlerArgs: ts.Expression[]
  /** The path argument as written, when it cannot be read (a call, a property, a parameter). */
  unreadablePath: string | null
}

function methodNameOf(callee: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  if (ts.isElementAccessExpression(callee)) {
    const arg = unwrap(callee.argumentExpression)
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text
  }
  return null
}

/** Does this argument read as a request handler (so an unreadable path must not hide the route)? */
function looksLikeHandler(arg: ts.Expression): boolean {
  const expr = unwrap(arg)
  if (isFnNode(expr)) return true
  if (ts.isIdentifier(expr)) return resolveIdentifier(expr, expr.text).kind === 'function'
  if (ts.isCallExpression(expr)) return expr.arguments.some((a) => isFnNode(unwrap(a)))
  return false
}

function registrationOf(node: ts.Node): Registration | null {
  if (!ts.isCallExpression(node)) return null
  const method = methodNameOf(node.expression)
  if (method === null) return null
  const args = node.arguments
  let verb: string
  let pathArg: ts.Expression
  let handlerArgs: ts.Expression[]
  if (method === 'addRoute') {
    if (args.length < 3) return null
    const verbArg = unwrap(args[0]!)
    if (!ts.isStringLiteral(verbArg) || !ROUTE_VERBS.has(verbArg.text.toLowerCase())) return null
    verb = verbArg.text.toUpperCase()
    pathArg = args[1]!
    handlerArgs = args.slice(2)
  } else {
    if (!ROUTE_VERBS.has(method) || args.length < 2) return null
    verb = method.toUpperCase()
    pathArg = args[0]!
    handlerArgs = args.slice(1)
  }
  if (isDataLiteral(unwrap(handlerArgs[handlerArgs.length - 1]!))) return null
  const path = routePathsOf(pathArg)
  if (path) return { call: node, verb, label: path.label, paths: path.paths, handlerArgs, unreadablePath: null }
  // A handler behind a path we cannot read is still a route: record it (opaque) instead of dropping it.
  if (!looksLikeHandler(handlerArgs[handlerArgs.length - 1]!)) return null
  const written = normalizeEol(pathArg.getText())
  return { call: node, verb, label: `<path ${written}>`, paths: [], handlerArgs, unreadablePath: written }
}

/**
 * The function(s) a handler argument stands for: an inline function, a same-file function identifier
 * (or a const whose initializer is one of these), a wrapper call around function arguments
 * (`asyncHandler(fn)`), a call to a same-file handler FACTORY (`wallet(false)` — the factory body, which
 * contains the returned handler, is read), or an array of those. null when none can be read.
 */
function handlerFunctionsOf(arg: ts.Expression, depth = 0): { roots: FnNode[]; wrapper: string | null } | null {
  if (depth > 4) return null
  const expr = unwrap(arg)
  if (isFnNode(expr)) return { roots: [expr], wrapper: null }
  if (ts.isIdentifier(expr)) {
    const resolved = resolveIdentifier(expr, expr.text)
    if (resolved.kind === 'function') return { roots: [resolved.node], wrapper: null }
    if (resolved.kind === 'value' && resolved.declaration.initializer) {
      return handlerFunctionsOf(resolved.declaration.initializer, depth + 1)
    }
    return null
  }
  if (ts.isCallExpression(expr) || ts.isArrayLiteralExpression(expr)) {
    const inner = ts.isCallExpression(expr) ? expr.arguments : expr.elements
    const roots: FnNode[] = []
    for (const element of inner) {
      const found = ts.isSpreadElement(element) ? null : handlerFunctionsOf(element, depth + 1)
      if (found) roots.push(...found.roots)
    }
    const wrapper = ts.isCallExpression(expr) ? normalizeEol(expr.expression.getText()) : null
    if (roots.length > 0) return { roots, wrapper }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      const factory = resolveIdentifier(expr.expression, expr.expression.text)
      if (factory.kind === 'function') return { roots: [factory.node], wrapper: `${wrapper} (handler factory)` }
    }
    return null
  }
  return null
}

function middlewareFunctionOf(arg: ts.Expression): { roots: FnNode[]; wrapper: string | null } | null {
  const expr = unwrap(arg)
  if (isFnNode(expr)) return { roots: [expr], wrapper: null }
  if (ts.isIdentifier(expr)) {
    const resolved = resolveIdentifier(expr, expr.text)
    if (resolved.kind === 'function') return { roots: [resolved.node], wrapper: null }
  }
  return null
}

function collectUnitsAndReferences(
  sf: ts.SourceFile,
  roots: FnNode[],
): { units: HandlerUnit[]; helpers: Map<string, string>; referenced: string } {
  const units: HandlerUnit[] = roots.map((node) => ({ label: 'handler', node, code: codeOf(node, sf) }))
  const helpers = new Map<string, string>()
  const referencedDecls = new Map<ts.VariableDeclaration, string>()
  const queue = [...units]
  while (queue.length > 0) {
    const unit = queue.shift()!
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        const resolved = resolveIdentifier(node, node.text)
        if (resolved.kind === 'function' && !units.some((u) => contains(u.node, resolved.node))) {
          const isCallee = ts.isCallExpression(node.parent) && node.parent.expression === node
          if (isCallee) {
            const helper: HandlerUnit = { label: resolved.name, node: resolved.node, code: codeOf(resolved.node, sf) }
            units.push(helper)
            helpers.set(resolved.name, helper.code)
            queue.push(helper)
          }
        } else if (resolved.kind === 'value' && !units.some((u) => contains(u.node, resolved.declaration))) {
          if (!referencedDecls.has(resolved.declaration)) referencedDecls.set(resolved.declaration, codeOf(resolved.declaration, sf))
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(unit.node, visit)
  }
  return { units, helpers, referenced: [...referencedDecls.values()].join('\n') }
}

export function scanRouteSource(file: string, rawSource: string): ScannedRouteFile {
  const source = normalizeEol(rawSource)
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const handlers: RouteHandler[] = []
  const opaque: OpaqueRegistration[] = []
  const visit = (node: ts.Node): void => {
    const registration = registrationOf(node)
    if (registration) {
      const roots: FnNode[] = []
      const middleware: string[] = []
      const key = `${registration.verb} ${registration.label}`
      const line = sf.getLineAndCharacterOfPosition(registration.call.getStart(sf)).line + 1
      let opaqueHandler: string | null = null
      registration.handlerArgs.forEach((arg, index) => {
        const isLast = index === registration.handlerArgs.length - 1
        // Middleware positions keep the narrow reading (an inline function or a same-file function
        // name); only the HANDLER position unwraps wrappers, consts and factories.
        const found = isLast ? handlerFunctionsOf(arg) : middlewareFunctionOf(arg)
        if (found) {
          roots.push(...found.roots)
          if (found.wrapper) middleware.push(found.wrapper)
        } else if (isLast) {
          opaqueHandler = codeOf(arg, sf)
        } else {
          middleware.push(codeOf(arg, sf))
        }
      })
      if (registration.unreadablePath !== null || opaqueHandler !== null || roots.length === 0) {
        opaque.push({ file, verb: registration.verb, key, line, handler: opaqueHandler ?? roots.map((r) => codeOf(r, sf).slice(0, 40)).join(', ') })
      } else {
        const { units, helpers, referenced } = collectUnitsAndReferences(sf, roots)
        const handlerRoots = units.filter((u) => u.label === 'handler')
        handlers.push({
          file,
          verb: registration.verb,
          pathLabel: registration.label,
          paths: registration.paths,
          key,
          line,
          code: handlerRoots.map((u) => u.code).join('\n'),
          raw: handlerRoots.map((u) => u.node.getText(sf)).join('\n'),
          middleware: middleware.join('\n'),
          helpers,
          referenced,
          units,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { file, source, sourceFile: sf, handlers, opaque }
}

// ── Population: which handlers address a sheet ──────────────────────────────

/**
 * Names under which a request carries a sheet id. Deliberately wide (`…SheetId`, `tableId`): a false
 * positive costs a named exemption, a false negative is a route nobody looks at.
 */
const SHEET_ID_NAME = String.raw`(?:sheetIds?|spreadsheetIds?|tableIds?|\w+SheetIds?|\w+TableIds?)`

export const SHEET_ID_PATH_PARAM = new RegExp(String.raw`:${SHEET_ID_NAME}\b`)

export const SHEET_ID_INPUTS: RegExp[] = [
  new RegExp(String.raw`\breq\.(query|body|params)\??\.${SHEET_ID_NAME}\b`),
  // element access, on any object: `req.query['sheetId']`, `q['sheetId']`
  new RegExp(String.raw`\[\s*['"\x60]${SHEET_ID_NAME}['"\x60]\s*\]`),
  new RegExp(String.raw`\b${SHEET_ID_NAME}\s*:\s*z\.`),
  new RegExp(String.raw`\b(body|input|payload|parsed\.data|parse\.data)\??\.${SHEET_ID_NAME}\b`),
  new RegExp(String.raw`\{[^}]*\b${SHEET_ID_NAME}\b[^}]*\}\s*=\s*(req\.(body|query|params)|parsed?\.data)\b`),
  /\b(resolveSheetCapabilities|resolveSheetReadableCapabilities|resolveSheetCapabilitiesForUser|resolveSheetCapabilitiesForAccess|requireRecordReadable|loadSheetLiveness|assertSheetLive|loadSheetRow)\(/,
  // SQL keyed by sheet: `sheet_id = $1`, `= ANY($1)`, `IN (…)`, `<> $1`
  /\bsheet_id\s*(=\s*(\$\d|ANY\s*\()|IN\s*\(|<>|!=)/i,
  // query builders: where('sheet_id', …), whereIn('t.sheet_id', …)
  /\bwhere\w*\(\s*['"](\w+\.)?sheet_id['"]/,
]

export function addressesASheet(h: RouteHandler): boolean {
  if (h.paths.some((p) => SHEET_ID_PATH_PARAM.test(p))) return true
  const text = [h.code, ...h.helpers.values(), h.referenced].join('\n')
  return SHEET_ID_INPUTS.some((re) => re.test(text))
}

const SRC_ROOT = join(__dirname, '../../src')

/**
 * The route keys the closed-world guard treats as sheet-addressed in `src/<rel>`. A behaviour test that
 * pins a route table for one file asserts its table against this list, so a route added to the file
 * reds that test until it gets a row (or a named reason for not having one).
 */
export function sheetAddressedRouteKeys(rel: string): string[] {
  const scanned = scanRouteSource(rel, readFileSync(join(SRC_ROOT, ...rel.split('/')), 'utf8'))
  return scanned.handlers.filter(addressesASheet).map((h) => h.key)
}

// ── Syntax-tree helpers ─────────────────────────────────────────────────────

/** Named ES imports of the file: local binding name → module specifier as written. */
export function namedImports(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>()
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) out.set(element.name.text, statement.moduleSpecifier.text)
    }
  }
  return out
}

/** Every function-like declaration (or class method) named `name` anywhere in the file (for cross-file proofs). */
export function findFunctionsNamed(sf: ts.SourceFile, name: string): FnNode[] {
  const out: FnNode[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === name) {
      out.push(node)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      const init = unwrap(node.initializer)
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) out.push(init)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * Dependency-injection proof: find `<registrar>(…, { <property>: <identifier>, … })` calls and resolve each
 * `<identifier>` lexically from the call site. Returns the resolved function declarations.
 */
export function resolveInjectedFunctions(sf: ts.SourceFile, registrar: string, property: string): FnNode[] {
  const out: FnNode[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === registrar) {
      for (const arg of node.arguments) {
        const obj = unwrap(arg)
        if (!ts.isObjectLiteralExpression(obj)) continue
        for (const prop of obj.properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === property) {
            const value = unwrap(prop.initializer)
            if (ts.isIdentifier(value)) {
              const resolved = resolveIdentifier(value, value.text)
              if (resolved.kind === 'function') out.push(resolved.node)
            } else if (isFnNode(value)) {
              out.push(value)
            }
          } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === property) {
            const resolved = resolveIdentifier(prop, prop.name.text)
            if (resolved.kind === 'function') out.push(resolved.node)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * Functions handed to a `<receiver>.set…Checker(fn)` / `set…Checker(fn)` call — the socket / Yjs / notify
 * authorization seams, which are sheet-addressed request surfaces without being route registrations.
 */
export function checkerRegistrations(sf: ts.SourceFile): Array<{ name: string; line: number; fn: FnNode }> {
  const out: Array<{ name: string; line: number; fn: FnNode }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      if (/^set\w*Checker$/.test(name)) {
        const receiver = ts.isPropertyAccessExpression(callee) ? `${normalizeEol(callee.expression.getText())}.` : ''
        for (const arg of node.arguments) {
          const found = handlerFunctionsOf(arg)
          for (const fn of found?.roots ?? []) {
            out.push({ name: `${receiver}${name}`, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, fn })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function stripParens(expr: ts.Expression): ts.Expression {
  let current = expr
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) current = current.expression
  return current
}

function calleeName(call: ts.CallExpression): string {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return ''
}

function enclosingFunction(node: ts.Node): FnNode | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (isFnNode(current)) return current
  }
  return null
}

/** How a branch leaves: `falsy` = bare return / return null|false|undefined; `value` = any other return. */
export type Exit = 'falsy' | 'value' | 'throw' | 'loop'

function exitOf(stmt: ts.Statement | undefined): Exit | null {
  if (!stmt) return null
  if (ts.isReturnStatement(stmt)) {
    const e = stmt.expression ? stripParens(stmt.expression) : undefined
    if (!e) return 'falsy'
    if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return 'falsy'
    if (ts.isIdentifier(e) && e.text === 'undefined') return 'falsy'
    if (ts.isVoidExpression(e)) return 'falsy'
    return 'value'
  }
  if (ts.isThrowStatement(stmt)) return 'throw'
  if (ts.isContinueStatement(stmt) || ts.isBreakStatement(stmt)) return 'loop'
  if (ts.isBlock(stmt)) return exitOf(stmt.statements[stmt.statements.length - 1])
  if (ts.isIfStatement(stmt) && stmt.elseStatement) {
    const a = exitOf(stmt.thenStatement)
    const b = exitOf(stmt.elseStatement)
    if (!a || !b) return null
    return a === b ? a : (a === 'loop' || b === 'loop') ? 'loop' : 'value'
  }
  return null
}

/**
 * The statements that contain `node`, innermost first, as (block, index) pairs — climbing only through
 * blocks and try-blocks. A conditional, loop or function boundary ends the climb: a refusal found in
 * any of these blocks after the given index runs whenever `node` ran and did not throw.
 */
function flowChain(node: ts.Node): Array<{ block: ts.Block; index: number }> {
  const out: Array<{ block: ts.Block; index: number }> = []
  let current: ts.Node = node
  while (current.parent && !(ts.isBlock(current.parent) && ts.isStatement(current))) {
    if (isFnNode(current.parent)) return out
    current = current.parent
  }
  while (current.parent && ts.isBlock(current.parent)) {
    const block = current.parent
    out.push({ block, index: block.statements.indexOf(current as ts.Statement) })
    const owner = block.parent
    if (owner && ts.isTryStatement(owner) && owner.tryBlock === block && owner.parent && ts.isBlock(owner.parent)) {
      current = owner
      continue
    }
    break
  }
  return out
}

function isLiveLiteral(e: ts.Expression): boolean {
  const s = stripParens(e)
  return (ts.isStringLiteral(s) || ts.isNoSubstitutionTemplateLiteral(s)) && s.text === 'live'
}

type SubjectMatcher = (e: ts.Expression) => boolean

function exactNotLive(test: ts.Expression, subject: SubjectMatcher): boolean {
  const e = stripParens(test)
  return ts.isBinaryExpression(e)
    && e.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    && ((subject(stripParens(e.left)) && isLiveLiteral(e.right)) || (subject(stripParens(e.right)) && isLiveLiteral(e.left)))
}

function findRefusal(from: ts.Node, subject: SubjectMatcher): { stmt: ts.IfStatement; block: ts.Block; index: number; exit: Exit } | null {
  for (const { block, index } of flowChain(from)) {
    for (let j = index + 1; j < block.statements.length; j += 1) {
      const stmt = block.statements[j]!
      if (ts.isIfStatement(stmt) && exactNotLive(stmt.expression, subject)) {
        const exit = exitOf(stmt.thenStatement)
        if (exit) return { stmt, block, index: j, exit }
      }
    }
  }
  return null
}

function identifiersIn(node: ts.Node): string[] {
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.push(n.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

/** Names assigned from a `.can<X>` read anywhere in `fn` (`const allowed = capabilities.canRead`). */
function capabilityAliases(fn: FnNode, sf: ts.SourceFile): Set<string> {
  const out = new Set<string>()
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && /\.can[A-Z]\w*\b/.test(codeOf(n.initializer, sf))) {
      out.add(n.name.text)
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)
      && /\.can[A-Z]\w*\b/.test(codeOf(n.right, sf))) {
      out.add(n.left.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(fn)
  return out
}

/** `if (<reads a capability>) { …403…; return }` */
function isCapabilityRefusal(stmt: ts.Statement, aliases: Set<string>, sf: ts.SourceFile): boolean {
  if (!ts.isIfStatement(stmt) || !exitOf(stmt.thenStatement)) return false
  const test = codeOf(stmt.expression, sf)
  const readsCapability = /\.can[A-Z]\w*\b/.test(test)
    || identifiersIn(stmt.expression).some((id) => /^can[A-Z]/.test(id) || aliases.has(id))
  return readsCapability && /\b403\b|\bsendForbidden\(|'FORBIDDEN'/.test(codeOf(stmt.thenStatement, sf))
}

/** Does `test` refuse when `x` (the gate's result) signals a refusal? */
function testsResult(test: ts.Expression, x: string, sf: ts.SourceFile): 'refuse' | 'accept' | null {
  const text = codeOf(stripParens(test), sf).replace(/\s+/g, ' ')
  const id = x.replace(/[$]/g, '\\$')
  const path = String.raw`(?:\??\.\w+|\[\d+\])*`
  const refuse = new RegExp(String.raw`^(?:!\s*${id}${path}|${id}${path} ={2,3} (?:null|undefined|false|0)|${id}${path} < 1|['"]\w+['"] in ${id}|${id}${path} !== true)$`)
  const accept = new RegExp(String.raw`^${id}\.ok(?: === true)?$`)
  if (accept.test(text)) return 'accept'
  if (text.includes('&&')) return null
  if (text.split(' || ').some((part) => refuse.test(part.trim()))) return 'refuse'
  return null
}

export type SiteKind =
  | 'resolver' | 'blind-resolver' | 'liveness-load' | 'assert-live'
  | 'vetted' | 'delegated' | 'inline-sheet-query' | 'gate-helper'

export interface GateSite {
  kind: SiteKind
  name: string
  call: ts.CallExpression
  /** The function the call sits in (the unit itself, or a closure inside it). */
  enclosing: FnNode | null
  line: number
}

/** `FROM meta_sheets [alias] … <alias.>deleted_at IS NULL` — a liveness filter on the SHEET table only. */
export function sheetTableLivenessFilter(sql: string): boolean {
  const re = /\bFROM\s+(?:public\.)?meta_sheets\b(?:\s+(?:AS\s+)?(?!WHERE\b|JOIN\b|LEFT\b|INNER\b|ON\b)(\w+))?([^;]*)/gi
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    const alias = m[1]
    const tail = m[2] ?? ''
    const qualified = alias ? new RegExp(String.raw`\b${alias}\.deleted_at\s+IS\s+NULL\b`, 'i') : null
    const bare = /(?<![.\w])deleted_at\s+IS\s+NULL\b/i
    if ((qualified && qualified.test(tail)) || bare.test(tail)) return true
  }
  return false
}

function firstStringArg(call: ts.CallExpression): string | null {
  const first = call.arguments[0]
  if (!first) return null
  const e = unwrap(first)
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
  if (ts.isTemplateExpression(e)) return normalizeEol(e.getText())
  return null
}

export interface AnalyzeOptions {
  /** Imported guards usable in this file (import already verified by the caller): name → label. */
  vetted: Map<string, string>
  /** `<object>.<method>` of a dependency-injected resolver (`dependencies.resolveContext`), or null. */
  delegated: string | null
  /** Callees that may be awaited before the first gate (rate limiting, the caller's own job lookup). */
  preGateCalls: Set<string>
  /** Routes: a capability 403 must sit between each resolver call and its liveness refusal. */
  requireOrder: boolean
  /** Routes: nothing but `preGateCalls` is awaited (and no service/pool/db call is made) before the gate. */
  gateFirst: boolean
}

export interface HandlerAnalysis {
  /** Proven mechanisms that stop the HANDLER on a non-live sheet. */
  sources: string[]
  violations: string[]
  /** Helper name → role, for reports and self-tests. */
  roles: Map<string, 'gate' | 'decision' | 'plain'>
}

function collectSites(unit: HandlerUnit, sf: ts.SourceFile, options: AnalyzeOptions, gateHelpers: Map<FnNode, string>): GateSite[] {
  const out: GateSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      const calleeText = normalizeEol(node.expression.getText())
      let kind: SiteKind | null = null
      if (ts.isIdentifier(node.expression)) {
        if (LIVENESS_CARRYING_RESOLVERS.has(name)) kind = 'resolver'
        else if (LIVENESS_BLIND_RESOLVERS.has(name)) kind = 'blind-resolver'
        else if (name === 'loadSheetLiveness') kind = 'liveness-load'
        else if (name === 'assertSheetLive') kind = 'assert-live'
        else if (options.vetted.has(name) && resolveIdentifier(node.expression, name).kind === 'unresolved') kind = 'vetted'
        else {
          const resolved = resolveIdentifier(node.expression, name)
          if (resolved.kind === 'function' && gateHelpers.has(resolved.node)) kind = 'gate-helper'
        }
      }
      if (!kind && options.delegated && calleeText === options.delegated) kind = 'delegated'
      if (!kind) {
        const sql = firstStringArg(node)
        if (sql !== null && sheetTableLivenessFilter(sql)) kind = 'inline-sheet-query'
      }
      if (kind) {
        out.push({
          kind,
          name: kind === 'inline-sheet-query' ? 'meta_sheets … deleted_at IS NULL' : calleeText,
          call: node,
          enclosing: enclosingFunction(node),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(unit.node, visit)
  return out
}

/** The variable a call's awaited result is bound to (`const x = await f()` / `x = await f()`). */
function boundName(call: ts.CallExpression): { name: string; holder: ts.Node } | null {
  let holder: ts.Node = call.parent
  while (ts.isAwaitExpression(holder) || ts.isParenthesizedExpression(holder) || ts.isAsExpression(holder) || ts.isNonNullExpression(holder)) {
    holder = holder.parent
  }
  if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return { name: holder.name.text, holder }
  if (ts.isBinaryExpression(holder) && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(holder.left)) {
    return { name: holder.left.text, holder }
  }
  return null
}

/** The liveness a carrying-resolver call binds: destructured `sheetLiveness` (maybe renamed) or `<id>.sheetLiveness`. */
function livenessBinding(call: ts.CallExpression): SubjectMatcher | null {
  let holder: ts.Node = call.parent
  while (ts.isAwaitExpression(holder) || ts.isParenthesizedExpression(holder)) holder = holder.parent
  if (!ts.isVariableDeclaration(holder)) return null
  if (ts.isIdentifier(holder.name)) {
    const id = holder.name.text
    return (e) => ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === id && e.name.text === 'sheetLiveness'
  }
  if (ts.isObjectBindingPattern(holder.name)) {
    for (const element of holder.name.elements) {
      const prop = element.propertyName && ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : ts.isIdentifier(element.name) ? element.name.text : ''
      if (prop === 'sheetLiveness' && ts.isIdentifier(element.name)) {
        const id = element.name.text
        return (e) => ts.isIdentifier(e) && e.text === id
      }
    }
  }
  return null
}

type Honour = { shape: 'if'; exit: Exit; stmt: ts.Statement } | { shape: 'tail' } | { shape: 'throws' }

function honourOf(site: GateSite, sf: ts.SourceFile): Honour | string {
  const call = site.call
  if (site.kind === 'assert-live') {
    let holder: ts.Node = call.parent
    while (ts.isAwaitExpression(holder) || ts.isParenthesizedExpression(holder)) holder = holder.parent
    return ts.isExpressionStatement(holder) ? { shape: 'throws' } : 'assertSheetLive must be its own statement'
  }
  // (A) const X = await gate(…) — the NEXT statement must act on X.
  const bound = boundName(call)
  if (bound) {
    const [first] = flowChain(bound.holder)
    if (!first) return `the result of ${site.name}(…) is bound outside a statement block`
    const next = first.block.statements[first.index + 1]
    if (!next || !ts.isIfStatement(next)) {
      return `the result of ${site.name}(…) (\`${bound.name}\`) is not checked by the very next statement`
    }
    const verdict = testsResult(next.expression, bound.name, sf)
    const exit = exitOf(next.thenStatement)
    if (!verdict || !exit) {
      return `the statement after ${site.name}(…) does not refuse on \`${bound.name}\` (\`if (${codeOf(next.expression, sf)})\`)`
    }
    if (verdict === 'refuse') return { shape: 'if', exit, stmt: next.thenStatement }
    // Inverted: `if (X.ok === true) return X.context` — the rest of the block is the refusal path.
    const rest = first.block.statements.slice(first.index + 2)
    const restExit = exitOf(rest[rest.length - 1])
    if (exit === 'loop' || !restExit) return `the refusal path after ${site.name}(…) does not leave`
    return { shape: 'if', exit: restExit, stmt: rest[rest.length - 1]! }
  }
  // (B) if ([cond &&] !await gate(…)) return
  let node: ts.Node = call
  while (ts.isAwaitExpression(node.parent) || ts.isParenthesizedExpression(node.parent)) node = node.parent
  if (ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.ExclamationToken) {
    let up: ts.Node = node.parent
    while (ts.isParenthesizedExpression(up.parent)
      || (ts.isBinaryExpression(up.parent) && up.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && up.parent.right === up)) {
      up = up.parent
    }
    if (ts.isIfStatement(up.parent) && up.parent.expression === up) {
      const exit = exitOf(up.parent.thenStatement)
      if (exit) return { shape: 'if', exit, stmt: up.parent.thenStatement }
    }
    return `the negated result of ${site.name}(…) does not guard a leaving branch`
  }
  // (C) tail position: nothing in this function runs after the gate.
  if (ts.isReturnStatement(node.parent)) return { shape: 'tail' }
  if (isFnNode(node.parent) && (node.parent as ts.ArrowFunction).body === node) return { shape: 'tail' }
  if (ts.isExpressionStatement(node.parent)) {
    const fn = site.enclosing
    const body = fn && fn.body && ts.isBlock(fn.body) ? fn.body : null
    if (body && body.statements[body.statements.length - 1] === node.parent) return { shape: 'tail' }
  }
  return `the result of ${site.name}(…) is ignored`
}

/**
 * Tree-level liveness analysis of one route handler (or any function set: pass a synthetic handler).
 * See the header for the rules; `sources` is empty when nothing proven stops the handler.
 */
export function analyzeHandler(h: Pick<RouteHandler, 'units'>, sf: ts.SourceFile, options: AnalyzeOptions): HandlerAnalysis {
  const violations = new Set<string>()
  const roles = new Map<string, 'gate' | 'decision' | 'plain'>()
  const roots = new Set(h.units.filter((u) => u.label === 'handler').map((u) => u.node))
  const gateHelpers = new Map<FnNode, string>()

  interface UnitResult { unit: HandlerUnit; sites: GateSite[]; exits: Array<{ site: GateSite; exit: Exit | 'tail' | 'throws' }> }
  const evaluate = (): UnitResult[] => {
    violations.clear()
    const results: UnitResult[] = []
    for (const unit of h.units) {
      const sites = collectSites(unit, sf, options, gateHelpers)
      const exits: UnitResult['exits'] = []
      const aliases = capabilityAliases(unit.node, sf)
      for (const site of sites) {
        const where = `${unit.label}: ${site.name}(…) at line ${site.line}`
        if (site.kind === 'resolver' || site.kind === 'blind-resolver' || site.kind === 'liveness-load') {
          let refusal: ReturnType<typeof findRefusal> = null
          if (site.kind === 'resolver') {
            const subject = livenessBinding(site.call)
            if (!subject) { violations.add(`${where} does not bind the sheetLiveness it returns`); continue }
            refusal = findRefusal(site.call, subject)
          } else if (site.kind === 'liveness-load') {
            const bound = boundName(site.call)
            if (!bound) { violations.add(`${where} does not bind the liveness it loads`); continue }
            refusal = findRefusal(bound.holder, (e) => ts.isIdentifier(e) && e.text === bound.name)
          } else {
            const loads = sites.filter((s) => s.kind === 'liveness-load' && s.enclosing === site.enclosing)
            if (loads.length === 0) {
              violations.add(`${where} returns no liveness and the function never loads it (loadSheetLiveness)`)
              continue
            }
            for (const load of loads) {
              const bound = boundName(load.call)
              refusal = bound ? findRefusal(bound.holder, (e) => ts.isIdentifier(e) && e.text === bound.name) : null
              if (refusal) break
            }
            if (refusal && !flowChain(site.call).some((c) => c.block === refusal!.block)) {
              violations.add(`${where}: its liveness refusal is not on the same path as the capability lookup`)
              continue
            }
          }
          if (!refusal) {
            violations.add(`${where} never refuses on the liveness it binds (an \`if (<liveness> !== 'live')\` that always leaves, on the same path)`)
            continue
          }
          exits.push({ site, exit: refusal.exit })
          if (options.requireOrder && site.kind !== 'liveness-load') {
            const at = flowChain(site.call).find((c) => c.block === refusal!.block)
            const between = at ? refusal.block.statements.slice(at.index + 1, refusal.index) : []
            if (!between.some((stmt) => isCapabilityRefusal(stmt, aliases, sf))) {
              violations.add(`${where} refuses on liveness BEFORE any capability 403 (403 must come first — no liveness oracle)`)
            }
          }
          continue
        }
        const honour = honourOf(site, sf)
        if (typeof honour === 'string') { violations.add(`${where}: ${honour}`); continue }
        exits.push({ site, exit: honour.shape === 'if' ? honour.exit : honour.shape })
      }
      results.push({ unit, sites, exits })
    }
    return results
  }

  // A helper is a GATE when every refusal in its own body tells the caller by a falsy return (or a
  // throw, or by tail-returning another gate). A helper whose refusals return a value (a per-row
  // verdict such as 'skipped_no_perm') is a DECISION helper: it does not stop the handler.
  const exitClass = (e: UnitResult['exits'][number]): 'falsy' | 'value' | 'neutral' => {
    if (e.exit === 'falsy') return 'falsy'
    if (e.exit === 'tail') return e.site.kind === 'gate-helper' ? 'falsy' : 'value'
    if (e.exit === 'value') return 'value'
    return 'neutral'
  }
  const ownExits = (r: UnitResult) => r.exits.filter((e) => e.site.enclosing === r.unit.node)
  let results = evaluate()
  for (let round = 0; round < h.units.length + 1; round += 1) {
    let changed = false
    for (const r of results) {
      if (roots.has(r.unit.node) || gateHelpers.has(r.unit.node)) continue
      const classes = ownExits(r).map(exitClass)
      if (classes.includes('falsy') && !classes.includes('value')) {
        gateHelpers.set(r.unit.node, r.unit.label)
        changed = true
      }
    }
    if (!changed) break
    results = evaluate()
  }

  const sources: string[] = []
  for (const r of results) {
    const own = ownExits(r)
    if (roots.has(r.unit.node)) {
      for (const e of own) if (e.exit !== 'loop') sources.push(`${e.site.kind} ${e.site.name}`)
      continue
    }
    const classes = own.map(exitClass)
    if (gateHelpers.has(r.unit.node)) roles.set(r.unit.label, 'gate')
    else if (own.length > 0) {
      roles.set(r.unit.label, 'decision')
      if (classes.includes('falsy') && classes.includes('value')) {
        violations.add(`${r.unit.label}: refuses a non-live sheet with a falsy return on some paths and a value on others — callers cannot tell a refusal apart`)
      }
    } else roles.set(r.unit.label, 'plain')
  }

  // GATE FIRST: in every function that gates, nothing but the allowed pre-gate calls is awaited before it.
  for (const r of options.gateFirst ? results : []) {
    const isRoot = roots.has(r.unit.node)
    if (!isRoot && !gateHelpers.has(r.unit.node)) continue
    const own = r.sites.filter((s) => s.enclosing === r.unit.node)
    if (own.length === 0) continue
    const first = own.reduce((a, b) => (a.call.getStart(sf) <= b.call.getStart(sf) ? a : b))
    const firstAt = first.call.getStart(sf)
    const visit = (node: ts.Node): void => {
      if (node.getStart(sf) >= firstAt) return
      if (isFnNode(node)) return
      if (ts.isCallExpression(node) && !contains(node, first.call)) {
        const name = calleeName(node)
        const awaited = ts.isAwaitExpression(node.parent)
        const serviceCall = ts.isPropertyAccessExpression(node.expression) && /(?:service|Service|pool|db)$/.test(normalizeEol(node.expression.expression.getText()))
        if ((awaited || serviceCall) && !options.preGateCalls.has(name)) {
          violations.add(`${r.unit.label}: \`${normalizeEol(node.getText()).slice(0, 60)}\` runs before the sheet gate ${first.name}(…) at line ${first.line}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    const body = r.unit.node.body
    if (body) ts.forEachChild(body, visit)
  }

  return { sources, violations: [...violations], roles }
}
