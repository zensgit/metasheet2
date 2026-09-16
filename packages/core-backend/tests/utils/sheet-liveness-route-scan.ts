/**
 * AST scanner behind the ALL-ROUTES sheet-liveness closed world
 * (tests/unit/multitable-sheet-liveness-closure-all-routes.guard.test.ts).
 *
 * The sibling guard over `routes/univer-meta.ts` finds handlers with a per-line regex and cuts each body
 * at its own closing `})`. That works for one file written in one style. The other route files are not:
 * `router.post(\n  '/path',` registrations, path ARRAYS held in a const (`router.get(tokenListPaths, …)`),
 * one-line delegations, helper functions nested inside the router factory, and a helper handed in through
 * dependency injection. So this scanner reads the syntax tree instead (ts.createSourceFile — syntax only,
 * no type checking, the same approach as supertest-app-mode-scan.ts):
 *
 *   - a REGISTRATION is `<expr>.<get|post|put|patch|delete>(<path>, …, <handler>)` where <path> is a
 *     '/'-rooted string, an array of them, or an identifier bound to such an array in scope; or
 *     `<expr>.addRoute('<VERB>', '<path>', <handler>)` (the plugin HTTP API);
 *   - a handler's HELPERS are resolved LEXICALLY from each call site (`foo(…)` → the declaration of `foo`
 *     visible from that call), transitively, and only inside the same file. A helper is never classified by
 *     its name: its body is read.
 *   - CODE text is printed from the tree with comments removed, so prose can never satisfy a pattern. The
 *     sibling guard learned that the hard way (a restore route was "guarded" by its own docblock).
 *
 * CRLF: the source is normalized to LF before parsing. The parser would cope with CRLF, but the printed
 * code and every regex the guard applies to it would then carry `\r` — and a per-line `(.*)$` pattern
 * silently matches nothing on a CRLF tree (the #3365 tripwire defect). Normalizing here keeps one
 * definition of "the source" for every assertion.
 */
import ts from 'typescript'

export const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete'])

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
  /** The literal path, or `[identifier]` when the path is an array held in a const. */
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

export interface ScannedRouteFile {
  file: string
  /** LF-normalized source. */
  source: string
  sourceFile: ts.SourceFile
  handlers: RouteHandler[]
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

function isFnNode(node: ts.Node | undefined): node is FnNode {
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

function routePathsOf(arg: ts.Expression): { label: string; paths: string[] } | null {
  const expr = unwrap(arg)
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text.startsWith('/') ? { label: expr.text, paths: [expr.text] } : null
  }
  const fromArray = (array: ts.ArrayLiteralExpression): string[] | null => {
    const out: string[] = []
    for (const element of array.elements) {
      const e = unwrap(element as ts.Expression)
      if ((ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && e.text.startsWith('/')) out.push(e.text)
      else return null
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
      if (ts.isArrayLiteralExpression(init)) {
        const paths = fromArray(init)
        return paths ? { label: `[${expr.text}]`, paths } : null
      }
    }
  }
  return null
}

interface Registration {
  call: ts.CallExpression
  verb: string
  label: string
  paths: string[]
  handlerArgs: ts.Expression[]
}

function registrationOf(node: ts.Node): Registration | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null
  const method = node.expression.name.text
  const args = node.arguments
  if (method === 'addRoute') {
    if (args.length < 3) return null
    const verbArg = unwrap(args[0]!)
    if (!ts.isStringLiteral(verbArg) || !ROUTE_VERBS.has(verbArg.text.toLowerCase())) return null
    const path = routePathsOf(args[1]!)
    if (!path) return null
    return { call: node, verb: verbArg.text.toUpperCase(), label: path.label, paths: path.paths, handlerArgs: args.slice(2) }
  }
  if (!ROUTE_VERBS.has(method) || args.length < 2) return null
  const last = unwrap(args[args.length - 1]!)
  if (!isFnNode(last) && !ts.isIdentifier(last)) return null
  const path = routePathsOf(args[0]!)
  if (!path) return null
  return { call: node, verb: method.toUpperCase(), label: path.label, paths: path.paths, handlerArgs: args.slice(1) }
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
  const visit = (node: ts.Node): void => {
    const registration = registrationOf(node)
    if (registration) {
      const roots: FnNode[] = []
      const middleware: string[] = []
      for (const arg of registration.handlerArgs) {
        const expr = unwrap(arg)
        if (isFnNode(expr)) roots.push(expr)
        else if (ts.isIdentifier(expr)) {
          const resolved = resolveIdentifier(expr, expr.text)
          if (resolved.kind === 'function') roots.push(resolved.node)
          else middleware.push(codeOf(expr, sf))
        } else {
          middleware.push(codeOf(expr, sf))
        }
      }
      if (roots.length > 0) {
        const { units, helpers, referenced } = collectUnitsAndReferences(sf, roots)
        const handlerRoots = units.filter((u) => u.label === 'handler')
        handlers.push({
          file,
          verb: registration.verb,
          pathLabel: registration.label,
          paths: registration.paths,
          key: `${registration.verb} ${registration.label}`,
          line: sf.getLineAndCharacterOfPosition(registration.call.getStart(sf)).line + 1,
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
  return { file, source, sourceFile: sf, handlers }
}

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

/** Every function-like declaration named `name` anywhere in the file (for cross-file proofs). */
export function findFunctionsNamed(sf: ts.SourceFile, name: string): FnNode[] {
  const out: FnNode[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) out.push(node)
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

export interface ResolverCallSite {
  resolver: string
  line: number
  /**
   * How the liveness of THIS call is bound:
   *   - `name`   — destructured `sheetLiveness` (possibly renamed), refuse on `<name>`
   *   - `member` — the whole result bound to an identifier, refuse on `<id>.sheetLiveness`
   *   - null     — the result was not bound in a way that keeps liveness (destructured without it, or
   *                not assigned at all)
   */
  binding: { kind: 'name' | 'member'; name: string } | null
}

/**
 * Resolver call sites DIRECTLY inside `unit` (calls inside nested functions belong to those functions,
 * which are units of their own only if they were resolved as helpers — so nested closures are included
 * here, as their text is part of this unit's code).
 */
export function resolverCallSites(unit: FnNode, sf: ts.SourceFile): ResolverCallSite[] {
  const out: ResolverCallSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && (LIVENESS_CARRYING_RESOLVERS.has(node.expression.text) || LIVENESS_BLIND_RESOLVERS.has(node.expression.text))) {
      let holder: ts.Node = node.parent
      while (ts.isAwaitExpression(holder) || ts.isParenthesizedExpression(holder)) holder = holder.parent
      let binding: ResolverCallSite['binding'] = null
      if (ts.isVariableDeclaration(holder)) {
        if (ts.isIdentifier(holder.name)) {
          binding = { kind: 'member', name: holder.name.text }
        } else if (ts.isObjectBindingPattern(holder.name)) {
          for (const element of holder.name.elements) {
            const propName = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : ts.isIdentifier(element.name) ? element.name.text : ''
            if (propName === 'sheetLiveness' && ts.isIdentifier(element.name)) {
              binding = { kind: 'name', name: element.name.text }
            }
          }
        }
      }
      out.push({
        resolver: node.expression.text,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        binding,
      })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(unit, visit)
  return out
}
