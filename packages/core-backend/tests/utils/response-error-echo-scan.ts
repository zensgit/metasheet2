/**
 * Structural scanner: which 5xx HTTP responses in a route source file carry the text of a caught
 * error (`err.message`, `err.stack`, `String(err)`, a template over `err`, the error object itself, or
 * any value derived from it)?
 *
 * Used by tests/unit/admin-tree-5xx-values-free.test.ts to keep the /api/admin router tree
 * values-free. It works on the TypeScript AST plus the TypeScript checker's SYMBOLS (a one-file
 * program, no lib, no module resolution), not on regexes over lines and not on bare names, so:
 *   - a LOG call is never a sink — `logger.error(`x ${err.message}`, err)` is exactly where the
 *     original error is supposed to go, and it is not flagged;
 *   - two unrelated variables that happen to share a name are two symbols: a `const error = 'fixed'`
 *     in one handler is not tainted by a `catch (error)` in another.
 *
 * SINKS (only responses are inspected; 4xx is out of scope — its text is a separate decision):
 *   - `<res>.status(S)…json|jsonp|send|end|write(args)` — `.status(S)` (or `.writeHead(S)`) anywhere
 *     down the call chain, or on a local the receiver was bound to (`const r = res.status(500)`);
 *   - SPLIT status: a body call on a receiver whose status was set by an earlier `<res>.status(S)`,
 *     `<res>.writeHead(S)` or `<res>.statusCode = S` in the same function (or an enclosing one) on the
 *     same receiver. "Same receiver" is decided on the ROOT of the receiver expression: method calls
 *     made on it are walked back (`res.set('X', v).json(…)` and `res.type('json').send(…)` write to
 *     `res` — express's chainable setters return the response; any method chain is walked, an
 *     over-approximation), and so are locals bound straight to it or to such a chain (`const r = res`,
 *     `const r = res.set('X', v)`, `const r = res.status(400)`, chains of such bindings); the root is
 *     then compared by symbol. A status found down the chain decides alone when it is a 5xx or is
 *     chained straight onto the body call (`res.status(200).json(…)`: no statement runs in between —
 *     only the body call's own arguments, and a status set inside them is not modelled, see below);
 *     when it is a NON-5xx reached through a local's binding (`const out = res.status(400)`), a
 *     separate setter on the same receiver placed after that status call and before the body counts
 *     too, and the worst one decides (`const out = res.status(400); out.status(500); out.json(…)`,
 *     also `res.status(500)`, `res.statusCode = 500`, `out.writeHead(500)` in between). "Earlier",
 *     "after" and "before" are SOURCE positions, not execution order;
 *   - `jsonError(res, S, …)`;
 *   - the `extra` argument of the admin failure responders (sendAdminReadFailure /
 *     sendAdminWriteFailure, also when called through a local alias or a renamed destructure), whose
 *     fields are spread into the 500 body.
 *   A sink counts when S is a numeric literal >= 500 OR is not a literal at all (a dynamic status may
 *   well be a 5xx, so it is held to the same rule).
 *
 * What counts as "error text" inside a sink's arguments:
 *   - any `.message` / `.stack` property read (or `['message']` / `['stack']`), whatever the receiver;
 *   - any value reference to a TAINTED symbol.
 *
 * TAINT, file-wide and flow-insensitive, propagated to a fixpoint:
 *   sources — the binding of every `catch (x)`; the first parameter of a `.catch(cb)` callback, of the
 *     rejection handler `.then(_, cb)`, of an `.on|once|addListener|prependListener|
 *     prependOnceListener('error', cb)` listener (the callback inline or resolved as a same-file
 *     function, see below); the first parameter of EVERY function Express would call as an error
 *     middleware, i.e. whose arity is 4 (`fn.length === 4`: four parameters before the first one with
 *     a default or a rest parameter; whatever the parameters are called, registered or not —
 *     over-approximating: a non-handler 4-parameter function, e.g. a `reduce` callback with index
 *     and array, is treated the same); the third (`error`) parameter of a function that DEFINES
 *     sendAdminReadFailure / sendAdminWriteFailure — by the responder contract it is the caught
 *     value, so the envelope module itself is held to the same rule;
 *   flows — a declaration whose initializer references a tainted symbol (`const err = error as Error`,
 *     `const m = String(error)`, `const { message } = err`); an ASSIGNMENT whose right side does
 *     (`x = …`, `x += …`, `obj.p = …` / `obj[k] = …` taints `obj`, destructuring assignment);
 *     `Object.assign(target, …tainted)`; a container write `c.push|unshift|splice|set|add(…tainted)`
 *     taints `c` (arrays, Map, Set); a `for (… of tainted)` loop binding; a tainted receiver's array
 *     callback (`errs.map((e) => …)` taints `e`); an ARGUMENT passed to a SAME-FILE function taints
 *     the matching parameter — the callee resolved as: a function declaration or a `const`/`let`
 *     bound to a function (`fail(res, error)`, through local aliases), or a member `obj.m` of a
 *     same-file object literal (method, function-valued or shorthand property, or a later
 *     `obj.m = fn` assignment) or class (method, static method, function-valued property:
 *     `Fail.send(res, error)`); a function whose body captures a tainted symbol from outside it
 *     (function declarations and functions bound to a `const`/`let`).
 *
 * NOT modelled — pinned only by the runtime probes of the routes that exist today, not by this scan:
 *   - a helper declared in ANOTHER module that writes the body, and a route handler imported from
 *     another module or registered on a scanned router from another module (the scanner reads one
 *     file at a time; the admin failure responders are the one cross-module writer in the tree: at
 *     the call site their `extra` argument is a sink, and their own module is scanned with the
 *     `error` parameter tainted, see sources);
 *   - a same-file callee reached any other way than listed above: `this.m(…)`, an instance method
 *     through `new C().m(…)` or an instance variable, a computed member `obj[k](…)`, a member of an
 *     object that is itself a parameter or a container element;
 *   - a status set in a different function than the body call (e.g. an earlier middleware), other
 *     than an enclosing one;
 *   - split status by EXECUTION order: the pairing is by source position, so a body call written
 *     before the setter in the source is not paired with it even when it runs after it (a body in a
 *     closure or function declared first and called later: `const reply = (b) => res.json(b);
 *     res.status(500); reply(…)`), and a status set inside the body call's own arguments
 *     (`res.status(400).json({ _: res.status(500), … })`) is not seen;
 *   - a receiver bound other than by a `const`/`let` initializer straight to it or to a method chain
 *     on it: a later assignment (`let r; r = res.status(500); r.json(…)`), a destructure, a
 *     conditional or other expression (`const r = ok ? res : other`), a parameter default;
 *   - a status written other than by `.status(S)` / `.writeHead(S)` / `statusCode = S`
 *     (`statusCode += …`, `Object.assign(res, { statusCode: 500 })`);
 *   - a status or body method reached through `.call` / `.apply` / `.bind`, `Reflect.apply`, or a
 *     computed member name (`res['status'](500)`);
 *   - a value that becomes error text only through a function's RETURN (a function that builds the
 *     text from its own internal catch) unless the call site's arguments reference the taint;
 *   - error values that do not enter through the sources above: a `Promise.allSettled` result's
 *     `.reason`, an error some other module stored on an object (e.g. a plugin runtime's `error`
 *     field), a container read back through a DIFFERENT object than the one written;
 *   - `for (… in …)` loops (keys, not values) and any other flow not listed above;
 *   - response HEADERS (`res.set`, `res.setHeader`, `res.writeHead(S, headers)`): only bodies are
 *     sinks;
 *   - `next(err)` into an error handler, and any exception that escapes to Express's final handler.
 */
import ts from 'typescript'

export type EchoSinkKind = 'status-chain' | 'status-split' | 'jsonError' | 'responder-extra'

export interface EchoSink {
  file: string
  line: number
  kind: EchoSinkKind
  status: number | 'dynamic'
}

export interface EchoOffender extends EchoSink {
  reason: string
  text: string
}

export interface ResponderCall {
  file: string
  line: number
  /** Canonical responder name (sendAdminReadFailure / sendAdminWriteFailure), even through an alias. */
  name: string
  /** Source range of the call expression. */
  start: number
  end: number
  /** Source range of the statement the call is (`f(…);` or `return f(…)`), or null when it is not one. */
  stmtStart: number | null
  stmtEnd: number | null
  /** The innermost enclosing `catch (x)` binding, if any. */
  catchVar: string | null
  /** Source text of the call's first argument (the response object). */
  resText: string
}

export interface EchoScanResult {
  sinks: EchoSink[]
  offenders: EchoOffender[]
  /** Every call to sendAdminReadFailure / sendAdminWriteFailure, with the call's source range. */
  responderCalls: ResponderCall[]
}

const RESPONDER_NAMES = new Set(['sendAdminReadFailure', 'sendAdminWriteFailure'])
const BODY_METHODS = new Set(['json', 'jsonp', 'send', 'end', 'write'])
const STATUS_METHODS = new Set(['status', 'writeHead'])
const ERROR_TEXT_PROPS = new Set(['message', 'stack'])
const ERROR_EVENT_METHODS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'])
/** Calls that store their arguments in the receiver: arrays, and Map / Set (`m.set(k, v)`, `s.add(v)`). */
const CONTAINER_WRITERS = new Set(['push', 'unshift', 'splice', 'set', 'add'])
const ARRAY_CALLBACKS = new Set([
  'forEach', 'map', 'flatMap', 'filter', 'find', 'findLast', 'findIndex', 'some', 'every', 'reduce', 'reduceRight',
])
const MAX_ALIAS_DEPTH = 8

export function parseSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

// ── one-file program: AST + symbols ──────────────────────────────────────────

interface Analysis {
  sf: ts.SourceFile
  checker: ts.TypeChecker
  symbolOf(id: ts.Identifier): ts.Symbol | undefined
}

function analyze(file: string, text: string): Analysis {
  const virtualName = `/__echo_scan__/${file.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/\.tsx?$/, '')}.ts`
  const sf = ts.createSourceFile(virtualName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const host: ts.CompilerHost = {
    getSourceFile: (f) => (f === virtualName ? sf : undefined),
    getDefaultLibFileName: () => '/__echo_scan__/lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/__echo_scan__',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => f === virtualName,
    readFile: (f) => (f === virtualName ? text : undefined),
  }
  const program = ts.createProgram({
    rootNames: [virtualName],
    options: { noLib: true, noResolve: true, types: [], skipLibCheck: true },
    host,
  })
  const checker = program.getTypeChecker()
  const cache = new Map<ts.Identifier, ts.Symbol | undefined>()
  const symbolOf = (id: ts.Identifier): ts.Symbol | undefined => {
    if (cache.has(id)) return cache.get(id)
    const parent = id.parent
    const symbol =
      parent && ts.isShorthandPropertyAssignment(parent) && parent.name === id
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(id)
    cache.set(id, symbol)
    return symbol
  }
  return { sf, checker, symbolOf }
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression
    else if (ts.isAsExpression(current)) current = current.expression
    else if (ts.isTypeAssertionExpression(current)) current = current.expression
    else if (ts.isNonNullExpression(current)) current = current.expression
    else if (ts.isSatisfiesExpression(current)) current = current.expression
    else return current
  }
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

function enclosingFunction(node: ts.Node): ts.Node {
  for (let p = node.parent; p; p = p.parent) {
    if (isFunctionLike(p) || ts.isSourceFile(p)) return p
  }
  return node.getSourceFile()
}

function isWithin(inner: ts.Node, outer: ts.Node): boolean {
  for (let p: ts.Node | undefined = inner; p; p = p.parent) if (p === outer) return true
  return false
}

function statusValue(arg: ts.Expression | undefined): number | 'dynamic' {
  if (!arg) return 'dynamic'
  const inner = unwrap(arg)
  if (ts.isNumericLiteral(inner)) return Number(inner.text)
  return 'dynamic'
}

function isFiveXx(status: number | 'dynamic'): boolean {
  return status === 'dynamic' || status >= 500
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrap(call.expression)
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return null
}

/** Is `id` a VALUE reference (not a property name, not a declaration name)? */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent
  if (!parent) return true
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false
  if (ts.isVariableDeclaration(parent) && parent.name === id) return false
  if (ts.isBindingElement(parent) && (parent.name === id || parent.propertyName === id)) return false
  if (ts.isParameter(parent) && parent.name === id) return false
  if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)) && parent.name === id) return false
  if (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)) return false
  if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false
  return true
}

function referencedSymbols(a: Analysis, node: ts.Node, out = new Set<ts.Symbol>()): Set<ts.Symbol> {
  walk(node, (n) => {
    if (ts.isIdentifier(n) && isValueReference(n)) {
      const symbol = a.symbolOf(n)
      if (symbol) out.add(symbol)
    }
  })
  return out
}

function bindingSymbols(a: Analysis, name: ts.BindingName, out: ts.Symbol[] = []): ts.Symbol[] {
  if (ts.isIdentifier(name)) {
    const symbol = a.checker.getSymbolAtLocation(name)
    if (symbol) out.push(symbol)
    return out
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingSymbols(a, element.name, out)
  }
  return out
}

function firstBindingName(name: ts.BindingName): string | null {
  if (ts.isIdentifier(name)) return name.text
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      const found = firstBindingName(element.name)
      if (found) return found
    }
  }
  return null
}

/** The symbols an assignment to `target` writes: a name, the ROOT of `obj.p` / `obj[k]`, or a pattern. */
function assignmentTargets(a: Analysis, target: ts.Expression, out: ts.Symbol[] = []): ts.Symbol[] {
  const inner = unwrap(target)
  if (ts.isIdentifier(inner)) {
    const symbol = a.symbolOf(inner)
    if (symbol) out.push(symbol)
  } else if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
    assignmentTargets(a, inner.expression, out)
  } else if (ts.isObjectLiteralExpression(inner)) {
    for (const property of inner.properties) {
      if (ts.isPropertyAssignment(property)) assignmentTargets(a, property.initializer, out)
      else if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = a.symbolOf(property.name)
        if (symbol) out.push(symbol)
      } else if (ts.isSpreadAssignment(property)) assignmentTargets(a, property.expression, out)
    }
  } else if (ts.isArrayLiteralExpression(inner)) {
    for (const element of inner.elements) {
      if (ts.isSpreadElement(element)) assignmentTargets(a, element.expression, out)
      else if (!ts.isOmittedExpression(element)) assignmentTargets(a, element, out)
    }
  } else if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    // default value inside a destructuring pattern: `[x = 1] = …`
    assignmentTargets(a, inner.left, out)
  }
  return out
}

/**
 * A function declared in THIS file that `expr` names: directly, through a local alias, or as a member
 * `obj.m` of a same-file object or class — an object literal's method / function-valued property /
 * shorthand property (`const helpers = { fail(r, e) {…} }`, `{ fail: (r, e) => … }`), a later
 * assignment `obj.m = fn`, or a class's (static) method or function-valued property (`Fail.send`).
 */
function resolveLocalFunction(a: Analysis, expr: ts.Expression, depth = 0): FunctionLike | null {
  if (depth > MAX_ALIAS_DEPTH) return null
  const inner = unwrap(expr)
  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner
  if (ts.isPropertyAccessExpression(inner)) return resolveLocalMember(a, inner.expression, inner.name.text, depth + 1)
  if (!ts.isIdentifier(inner)) return null
  const symbol = a.symbolOf(inner)
  for (const declaration of symbol?.declarations ?? []) {
    if (declaration.getSourceFile() !== a.sf) continue
    if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const resolved = resolveLocalFunction(a, declaration.initializer, depth + 1)
      if (resolved) return resolved
    }
  }
  return null
}

/** The function member `name` of a same-file object literal or class that `objectExpr` names. */
function resolveLocalMember(a: Analysis, objectExpr: ts.Expression, name: string, depth: number): FunctionLike | null {
  if (depth > MAX_ALIAS_DEPTH) return null
  const object = unwrap(objectExpr)
  const fromMembers = (members: ts.NodeArray<ts.ObjectLiteralElementLike> | ts.NodeArray<ts.ClassElement>): FunctionLike | null => {
    for (const member of members) {
      const memberName = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : null
      if (memberName !== name) continue
      if (ts.isMethodDeclaration(member) && member.body) return member
      if (ts.isPropertyAssignment(member) || ts.isPropertyDeclaration(member)) {
        const resolved = member.initializer ? resolveLocalFunction(a, member.initializer, depth + 1) : null
        if (resolved) return resolved
      }
      if (ts.isShorthandPropertyAssignment(member)) {
        const resolved = resolveLocalFunction(a, member.name, depth + 1)
        if (resolved) return resolved
      }
    }
    return null
  }
  if (ts.isObjectLiteralExpression(object)) return fromMembers(object.properties)
  if (ts.isClassExpression(object)) return fromMembers(object.members)
  if (!ts.isIdentifier(object)) return null
  const symbol = a.symbolOf(object)
  if (!symbol) return null
  for (const declaration of symbol.declarations ?? []) {
    if (declaration.getSourceFile() !== a.sf) continue
    if (ts.isClassDeclaration(declaration)) {
      const resolved = fromMembers(declaration.members)
      if (resolved) return resolved
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const resolved = resolveLocalMember(a, declaration.initializer, name, depth + 1)
      if (resolved) return resolved
    }
  }
  // A later assignment `obj.name = fn` anywhere in the file.
  for (const right of memberAssignments(a).get(symbol)?.get(name) ?? []) {
    const resolved = resolveLocalFunction(a, right, depth + 1)
    if (resolved) return resolved
  }
  return null
}

const memberAssignmentIndex = new WeakMap<ts.SourceFile, Map<ts.Symbol, Map<string, ts.Expression[]>>>()

/** Every `obj.name = value` assignment in the file, by the symbol of `obj` and then `name`. */
function memberAssignments(a: Analysis): Map<ts.Symbol, Map<string, ts.Expression[]>> {
  const cached = memberAssignmentIndex.get(a.sf)
  if (cached) return cached
  const index = new Map<ts.Symbol, Map<string, ts.Expression[]>>()
  walk(a.sf, (n) => {
    if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return
    const left = unwrap(n.left)
    if (!ts.isPropertyAccessExpression(left)) return
    const target = unwrap(left.expression)
    if (!ts.isIdentifier(target)) return
    const symbol = a.symbolOf(target)
    if (!symbol) return
    const byName = index.get(symbol) ?? new Map<string, ts.Expression[]>()
    byName.set(left.name.text, [...(byName.get(left.name.text) ?? []), n.right])
    index.set(symbol, byName)
  })
  memberAssignmentIndex.set(a.sf, index)
  return index
}

/**
 * Express's own test for an error-handling middleware: `fn.length === 4`, i.e. four parameters before
 * the first one with a default value or a rest parameter (a TypeScript `this` parameter is erased).
 */
function expressArity(fn: FunctionLike): number {
  let arity = 0
  for (const parameter of fn.parameters) {
    if (ts.isIdentifier(parameter.name) && parameter.name.text === 'this') continue
    if (parameter.initializer || parameter.dotDotDotToken) break
    arity += 1
  }
  return arity
}

function firstParamSymbols(a: Analysis, handler: ts.Expression | undefined): ts.Symbol[] {
  if (!handler) return []
  const fn = resolveLocalFunction(a, handler)
  const first = fn?.parameters[0]
  return first ? bindingSymbols(a, first.name) : []
}

/** Parameter symbols of `fn` that argument `index` (a spread when `spread`) binds. */
function parameterSymbolsFor(a: Analysis, fn: FunctionLike, index: number, spread: boolean): ts.Symbol[] {
  const out: ts.Symbol[] = []
  fn.parameters.forEach((parameter, i) => {
    const binds = spread ? i >= index : i === index || (parameter.dotDotDotToken !== undefined && i <= index)
    if (binds) bindingSymbols(a, parameter.name, out)
  })
  return out
}

/**
 * When `n` DEFINES an admin failure responder (`sendAdminReadFailure: (res, context, error, extra) =>
 * …`, a method, a const or a function of that name), the function whose third parameter is, by the
 * responder contract, the caught value.
 */
function responderDefinition(n: ts.Node): FunctionLike | null {
  const named = (name: ts.Node | undefined) => name !== undefined && ts.isIdentifier(name) && RESPONDER_NAMES.has(name.text)
  if ((ts.isPropertyAssignment(n) || ts.isVariableDeclaration(n)) && named(n.name) && n.initializer) {
    const initializer = unwrap(n.initializer)
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer
  }
  if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && named(n.name) && n.body) return n
  return null
}

interface Flow {
  refs: Set<ts.Symbol>
  to: ts.Symbol[]
}

/** Every symbol that carries (or is derived from) a caught error, file-wide. */
function computeTaint(a: Analysis): Set<ts.Symbol> {
  const tainted = new Set<ts.Symbol>()
  const flows: Flow[] = []
  const addFlow = (from: ts.Node, to: ts.Symbol[], excludeDeclaredWithin?: ts.Node) => {
    if (to.length === 0) return
    let refs = referencedSymbols(a, from)
    if (excludeDeclaredWithin) {
      // A function only carries what it CAPTURES: its own params / locals / catch bindings stay inside.
      refs = new Set(
        [...refs].filter((s) => !(s.declarations ?? []).some((d) => d.getSourceFile() === a.sf && isWithin(d, excludeDeclaredWithin)))
      )
    }
    if (refs.size > 0) flows.push({ refs, to })
  }

  walk(a.sf, (n) => {
    if (ts.isCatchClause(n) && n.variableDeclaration) {
      for (const s of bindingSymbols(a, n.variableDeclaration.name)) tainted.add(s)
    }
    const responder = responderDefinition(n)
    const caughtParam = responder?.parameters[2]
    if (caughtParam) {
      for (const s of bindingSymbols(a, caughtParam.name)) tainted.add(s)
    }
    if (isFunctionLike(n)) {
      // Any function Express would treat as an error handler (arity 4), whatever its first
      // parameter is called — over-approximating: a 4-parameter function that is not an error
      // handler (a `reduce` callback with index and array) has its first parameter treated the same.
      const first = n.parameters.find((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'))
      if (first && expressArity(n) === 4) {
        for (const s of bindingSymbols(a, first.name)) tainted.add(s)
      }
      if (ts.isFunctionDeclaration(n) && n.name && n.body) {
        const symbol = a.checker.getSymbolAtLocation(n.name)
        if (symbol) addFlow(n.body, [symbol], n)
      }
    }
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const initializer = unwrap(n.initializer)
      const isFn = ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
      addFlow(n.initializer, bindingSymbols(a, n.name), isFn ? initializer : undefined)
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      addFlow(n.right, assignmentTargets(a, n.left))
    }
    if (ts.isForOfStatement(n)) {
      // `for (const e of [error])` / `for (x of errs)`: the loop binding carries what it iterates.
      const init = n.initializer
      const targets = ts.isVariableDeclarationList(init)
        ? init.declarations.flatMap((d) => bindingSymbols(a, d.name))
        : assignmentTargets(a, init)
      addFlow(n.expression, targets)
    }
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression)
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text
        if (method === 'catch') {
          for (const s of firstParamSymbols(a, n.arguments[0])) tainted.add(s)
        } else if (method === 'then') {
          for (const s of firstParamSymbols(a, n.arguments[1])) tainted.add(s)
        } else if (ERROR_EVENT_METHODS.has(method)) {
          const event = n.arguments[0]
          if (event && ts.isStringLiteralLike(event) && event.text === 'error') {
            for (const s of firstParamSymbols(a, n.arguments[1])) tainted.add(s)
          }
        } else if (CONTAINER_WRITERS.has(method)) {
          for (const arg of n.arguments) addFlow(arg, assignmentTargets(a, callee.expression))
        } else if (ARRAY_CALLBACKS.has(method)) {
          const fn = n.arguments[0] ? resolveLocalFunction(a, n.arguments[0]) : null
          if (fn) {
            const params = method.startsWith('reduce') ? fn.parameters.slice(0, 2) : fn.parameters.slice(0, 1)
            addFlow(callee.expression, params.flatMap((p) => bindingSymbols(a, p.name)))
          }
        } else if (method === 'assign' && ts.isIdentifier(unwrap(callee.expression)) && (unwrap(callee.expression) as ts.Identifier).text === 'Object') {
          const [target, ...sources] = n.arguments
          if (target) for (const source of sources) addFlow(source, assignmentTargets(a, target))
        }
      }
      const fn = resolveLocalFunction(a, n.expression)
      if (fn) {
        n.arguments.forEach((arg, i) => {
          const spread = ts.isSpreadElement(arg)
          addFlow(spread ? arg.expression : arg, parameterSymbolsFor(a, fn, i, spread))
        })
      }
    }
  })

  let changed = true
  while (changed) {
    changed = false
    for (const flow of flows) {
      if (flow.to.every((s) => tainted.has(s))) continue
      let hit = false
      for (const s of flow.refs) {
        if (tainted.has(s)) {
          hit = true
          break
        }
      }
      if (!hit) continue
      for (const s of flow.to) {
        if (!tainted.has(s)) {
          tainted.add(s)
          changed = true
        }
      }
    }
  }
  return tainted
}

// ── sinks ────────────────────────────────────────────────────────────────────

type ReceiverKey = ts.Symbol | string

/**
 * Walk a receiver back through method calls made ON it to the expression they start from:
 * `res.set('X', v).type('json')` → `res`. Express's chainable response methods (`set`, `type`,
 * `append`, `cookie`, `location`, `vary`, …) return the response itself, so the body call at the end
 * of such a chain writes to the same response. Over-approximating: any method chain is walked.
 */
function chainRoot(expr: ts.Expression): ts.Expression {
  let current = unwrap(expr)
  for (let depth = 0; depth <= MAX_ALIAS_DEPTH * 4; depth++) {
    if (!ts.isCallExpression(current)) break
    const callee = unwrap(current.expression)
    if (!ts.isPropertyAccessExpression(callee)) break
    current = unwrap(callee.expression)
  }
  return current
}

/**
 * The identity of a response receiver. A method chain on it is the same receiver
 * (`res.status(500); res.set('X', v).json(…)`), and so is a local bound straight to it or to such a
 * chain (`const r = res`, `const r = res.set('X', v)`, chains of such bindings), so
 * `res.status(500); r.json(…)` is one split-status sink.
 */
function receiverKey(a: Analysis, expr: ts.Expression, depth = 0): ReceiverKey {
  const inner = chainRoot(expr)
  if (ts.isIdentifier(inner)) {
    const symbol = a.symbolOf(inner)
    const declaration = symbol?.valueDeclaration
    if (
      depth < MAX_ALIAS_DEPTH &&
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      ts.isIdentifier(chainRoot(declaration.initializer))
    ) {
      return receiverKey(a, declaration.initializer, depth + 1)
    }
    return symbol ?? inner.text
  }
  return inner.getText(a.sf).replace(/\s+/g, '')
}

interface StatusSetter {
  key: ReceiverKey
  status: number | 'dynamic'
  pos: number
  scope: ts.Node
}

function collectStatusSetters(a: Analysis): StatusSetter[] {
  const setters: StatusSetter[] = []
  walk(a.sf, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && STATUS_METHODS.has(n.expression.name.text)) {
      setters.push({
        key: receiverKey(a, n.expression.expression),
        status: statusValue(n.arguments[0]),
        pos: n.getStart(a.sf),
        scope: enclosingFunction(n),
      })
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(unwrap(n.left)) &&
      (unwrap(n.left) as ts.PropertyAccessExpression).name.text === 'statusCode'
    ) {
      setters.push({
        key: receiverKey(a, (unwrap(n.left) as ts.PropertyAccessExpression).expression),
        status: statusValue(n.right),
        pos: n.getStart(a.sf),
        scope: enclosingFunction(n),
      })
    }
  })
  return setters
}

interface ChainStatus {
  status: number | 'dynamic'
  /** Source offset where the `.status(S)` / `.writeHead(S)` call found down the chain ends. */
  end: number
  /**
   * True when that call was reached only by following a local's binding (`const out = res.status(400);
   * … out.json(…)`): statements can run between the binding and the body call, so a status set
   * separately in between (`out.status(500)`) may be the one the response is sent with.
   */
  viaBinding: boolean
}

/** For `<recv>.json(...)`, the status set down its call chain (or on the local it was bound from). */
function statusOfChain(a: Analysis, receiverExpr: ts.Expression): ChainStatus | null {
  let receiver = unwrap(receiverExpr)
  let viaBinding = false
  for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth++) {
    if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
      if (STATUS_METHODS.has(receiver.expression.name.text)) {
        return { status: statusValue(receiver.arguments[0]), end: receiver.getEnd(), viaBinding }
      }
      receiver = unwrap(receiver.expression.expression)
      continue
    }
    if (ts.isIdentifier(receiver)) {
      const declaration = a.symbolOf(receiver)?.valueDeclaration
      if (declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer) {
        receiver = unwrap(declaration.initializer)
        viaBinding = true
        continue
      }
    }
    return null
  }
  return null
}

function worstStatus(statuses: Array<number | 'dynamic'>): number | 'dynamic' | null {
  const five = statuses.filter(isFiveXx)
  if (five.length === 0) return null
  if (five.includes('dynamic')) return 'dynamic'
  return Math.max(...(five as number[]))
}

/** Canonical responder name when `call` invokes one (directly, via `x.responder`, or via an alias). */
function responderName(a: Analysis, calleeExpr: ts.Expression, depth = 0): string | null {
  const callee = unwrap(calleeExpr)
  if (ts.isPropertyAccessExpression(callee)) return RESPONDER_NAMES.has(callee.name.text) ? callee.name.text : null
  if (!ts.isIdentifier(callee)) return null
  if (RESPONDER_NAMES.has(callee.text)) return callee.text
  if (depth > MAX_ALIAS_DEPTH) return null
  for (const declaration of a.symbolOf(callee)?.declarations ?? []) {
    if (ts.isBindingElement(declaration)) {
      const property = declaration.propertyName
      if (property && ts.isIdentifier(property) && RESPONDER_NAMES.has(property.text)) return property.text
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const resolved = responderName(a, declaration.initializer, depth + 1)
      if (resolved) return resolved
    }
  }
  return null
}

function errorTextIn(a: Analysis, args: readonly ts.Expression[], tainted: Set<ts.Symbol>): string | null {
  let reason: string | null = null
  for (const arg of args) {
    walk(arg, (n) => {
      if (reason) return
      if (ts.isPropertyAccessExpression(n) && ERROR_TEXT_PROPS.has(n.name.text)) {
        reason = `reads .${n.name.text}`
      } else if (
        ts.isElementAccessExpression(n) &&
        ts.isStringLiteralLike(n.argumentExpression) &&
        ERROR_TEXT_PROPS.has(n.argumentExpression.text)
      ) {
        reason = `reads ['${n.argumentExpression.text}']`
      } else if (ts.isIdentifier(n) && isValueReference(n)) {
        const symbol = a.symbolOf(n)
        if (symbol && tainted.has(symbol)) reason = `references caught error '${n.text}'`
      }
    })
    if (reason) break
  }
  return reason
}

function innermostCatchVar(node: ts.Node): string | null {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCatchClause(p) && p.variableDeclaration) return firstBindingName(p.variableDeclaration.name)
  }
  return null
}

export function scanResponseErrorEcho(file: string, text: string): EchoScanResult {
  const a = analyze(file, text)
  const sf = a.sf
  const result: EchoScanResult = { sinks: [], offenders: [], responderCalls: [] }
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const tainted = computeTaint(a)
  const setters = collectStatusSetters(a)

  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return
    const name = calleeName(n)
    const callee = unwrap(n.expression)

    let kind: EchoSinkKind | null = null
    let status: number | 'dynamic' | null = null
    let args: readonly ts.Expression[] = []

    const responder = responderName(a, n.expression)
    if (ts.isPropertyAccessExpression(callee) && BODY_METHODS.has(callee.name.text)) {
      const chained = statusOfChain(a, callee.expression)
      if (chained !== null && (isFiveXx(chained.status) || !chained.viaBinding)) {
        // A 5xx down the chain, or a status chained straight onto this body call
        // (`res.status(200).json(…)`): no statement runs in between (only this call's own arguments,
        // not modelled — see the header), the chain decides.
        kind = 'status-chain'
        status = chained.status
      } else {
        // No status down the chain, or a non-5xx one reached through a local's binding
        // (`const out = res.status(400)`): a status set separately on the same receiver AFTER that
        // (after the binding's status call, before this body call — by SOURCE position — in the same
        // or an enclosing function) may be the one sent — `out.status(500)`, `res.statusCode = 500`,
        // `out.writeHead(500)`. The worst of them counts.
        const key = receiverKey(a, callee.expression)
        const scope = enclosingFunction(n)
        const start = n.getStart(sf)
        const after = chained === null ? -1 : chained.end
        const earlier = setters.filter((s) => s.key === key && s.pos >= after && s.pos < start && isWithin(scope, s.scope))
        const split = worstStatus(earlier.map((s) => s.status))
        if (split !== null) {
          kind = 'status-split'
          status = split
        } else if (chained !== null) {
          kind = 'status-chain'
          status = chained.status
        }
      }
      args = n.arguments
    } else if (name === 'jsonError') {
      kind = 'jsonError'
      status = statusValue(n.arguments[1])
      args = n.arguments.slice(2)
    } else if (responder !== null) {
      kind = 'responder-extra'
      status = 500
      args = n.arguments.slice(3)
      const statement =
        n.parent && (ts.isExpressionStatement(n.parent) || ts.isReturnStatement(n.parent)) ? n.parent : null
      result.responderCalls.push({
        file,
        line: lineOf(n),
        name: responder,
        start: n.getStart(sf),
        end: n.getEnd(),
        stmtStart: statement ? statement.getStart(sf) : null,
        stmtEnd: statement ? statement.getEnd() : null,
        catchVar: innermostCatchVar(n),
        resText: n.arguments[0] ? n.arguments[0].getText(sf) : 'res',
      })
    }
    if (kind === null || status === null || !isFiveXx(status)) return

    const sink: EchoSink = { file, line: lineOf(n), kind, status }
    result.sinks.push(sink)
    const reason = errorTextIn(a, args, tainted)
    if (reason) {
      result.offenders.push({ ...sink, reason, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 160) })
    }
  })
  return result
}

// ── router tree discovery ────────────────────────────────────────────────────

export interface RouterMount {
  /** File whose mount call this is. */
  from: string
  line: number
  /**
   * `use` for `<x>.use(...)`; `route` for a route method (`get` / `post` / `put` / `patch` / `delete`
   * / `all` / `options` / `head`, also `<x>.route(p).get(...)`) called on a router — Express accepts a
   * Router as a route handler, and it then lives INSIDE the route layer (`layer.route.stack`).
   */
  via: 'use' | 'route'
  /** Which argument of the call. */
  arg: number
  /**
   * Files the argument itself resolves to (the mounting file itself for a Router built in place).
   * For `use` every resolved module; for `route` only Router modules (a route method's other
   * arguments are handlers, and a handler defined in another module is not followed).
   */
  targets: string[]
  /**
   * Router modules the argument reaches only THROUGH a function: a closure or a same-file function
   * that the argument is or calls, whose body refers to a binding that resolves to a Router module
   * (`(req, res, next) => sub(req, res, next)`). Such a router is not itself a layer of the live
   * stack, so the live cross-check cannot see it; this static rule is the only thing that does.
   */
  wrapped: string[]
  /** True when some target is a Router: built in place, or a Router module (builds one, or re-exports one). */
  router: boolean
  /**
   * True when some target is a `Router()` built in place in the mounting file. Such a router has no
   * module export a live router can be compared against, so a live cross-check can only COUNT it.
   */
  inPlace: boolean
}

/** A discovered module re-exports values from a Router module, which is then followed too. */
export interface RouterReexport {
  from: string
  to: string
}

export interface RouterTree {
  files: string[]
  mounts: RouterMount[]
  reexports: RouterReexport[]
}

/** Route methods Express accepts a Router (or any handler) on. */
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head'])

type MountTarget = { kind: 'module'; spec: string } | { kind: 'local-router' }

function isRouterConstruction(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression)
  return (
    (ts.isIdentifier(callee) && callee.text === 'Router') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'Router')
  )
}

function constructsRouter(file: string, text: string): boolean {
  let found = false
  walk(parseSource(file, text), (n) => {
    if (!found && ts.isCallExpression(n) && isRouterConstruction(n)) found = true
  })
  return found
}

function relativeSpecOf(call: ts.CallExpression): string | null {
  const callee = call.expression
  const isImportCall = callee.kind === ts.SyntaxKind.ImportKeyword
  const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
  const first = call.arguments[0]
  if ((isImportCall || isRequire) && first && ts.isStringLiteralLike(first) && first.text.startsWith('.')) return first.text
  return null
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

/**
 * The relative specifiers a module RE-EXPORTS values from (syntactic, top level): `export … from
 * './m'`, `export * from './m'`, `export * as ns from './m'`, and an export whose value is a binding
 * imported from './m' — `export { x }`, `export { x as y }`, `export default x`, `export const y = x`,
 * also through top-level `const`/`let` aliases of it (`const y = x; export { y }`), a namespace member
 * (`import * as ns from './m'; export const y = ns.x`), or a relative `require()` / awaited `import()`
 * (`export const y = require('./m').x`, `export default (await import('./m')).default`) — each form
 * pinned by the discovery self-check. Type-only exports are skipped. NOT followed: a destructured
 * alias (`const { default: x } = ns; export { x }`, also `= await import('./m')`), and any export
 * assembled otherwise (see discoverMountedRouterTree's not-followed list).
 */
function reexportedSpecs(file: string, text: string): string[] {
  const sf = parseSource(file, text)
  const imported = new Map<string, string>()
  const aliases = new Map<string, ts.Expression>()
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text
      const clause = statement.importClause
      if (!spec.startsWith('.') || !clause || clause.isTypeOnly) continue
      if (clause.name) imported.set(clause.name.text, spec)
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) imported.set(clause.namedBindings.name.text, spec)
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) imported.set(element.name.text, spec)
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) aliases.set(declaration.name.text, declaration.initializer)
      }
    }
  }
  const specOf = (expr: ts.Expression, depth: number): string | null => {
    if (depth > MAX_ALIAS_DEPTH) return null
    let e = unwrap(expr)
    while (ts.isAwaitExpression(e)) e = unwrap(e.expression)
    if (ts.isIdentifier(e)) {
      const spec = imported.get(e.text)
      if (spec) return spec
      const alias = aliases.get(e.text)
      return alias ? specOf(alias, depth + 1) : null
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return specOf(e.expression, depth + 1)
    if (ts.isCallExpression(e)) return relativeSpecOf(e)
    return null
  }
  const out = new Set<string>()
  const add = (spec: string | null) => {
    if (spec) out.add(spec)
  }
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (statement.moduleSpecifier) {
        if (ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('.')) add(statement.moduleSpecifier.text)
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue
          const local = element.propertyName ?? element.name
          if (ts.isIdentifier(local)) add(specOf(local, 0))
        }
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) add(specOf(statement.expression, 0))
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer) add(specOf(declaration.initializer, 0))
      }
    }
  }
  return [...out]
}

/**
 * The names under which a module exports a Router it BUILT ITSELF: the export's binding holds, on
 * every value it is ever given in the file (its initializer and every later `x = …`, through local
 * `const`/`let` aliases), the result of a `Router()` / `x.Router()` call made in this module —
 * `const router = Router(); export default router`, `export const r = express.Router()`,
 * `export default Router()`, `export { router as sub }`. NOT counted: anything re-exported
 * (`export … from`, `export *`), an export whose binding is an import or an alias of one
 * (`import x from './m'; export { x }`, `const y = x; export default y`), a binding that is also
 * given another value (`r = imported`) or is written by a destructuring assignment or a `for` loop
 * head, a factory's return value, a function, a class, a binding never given a value.
 *
 * "A `Router()` call" is decided by the callee's NAME (`Router` / `.Router`), not by resolving it to
 * express: any call named `Router` counts, including one that hands back an imported router
 * (`const holder = { Router: () => imported }; export default holder.Router()` is counted — there is
 * no such identifier in src/ today). Within that limit this is the key of the live identity
 * cross-check: a live router matched to a module through this list came out of a call named
 * `Router` in that module, so that module's source is the one the scan read — a router a scanned
 * module merely passes on (a barrel) does not match its own scanned file.
 */
export function localRouterExportNames(file: string, text: string): string[] {
  const a = analyze(file, text)
  const values = new Map<ts.Symbol, ts.Expression[]>()
  const opaque = new Set<ts.Symbol>()
  const markOpaque = (target: ts.Expression) => {
    const inner = unwrap(target)
    if (ts.isIdentifier(inner)) {
      const symbol = a.symbolOf(inner)
      if (symbol) opaque.add(symbol)
    } else if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) {
      for (const symbol of assignmentTargets(a, inner)) opaque.add(symbol)
    }
  }
  walk(a.sf, (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = unwrap(n.left)
      if (ts.isIdentifier(left)) {
        const symbol = a.symbolOf(left)
        if (symbol) values.set(symbol, [...(values.get(symbol) ?? []), n.right])
      } else {
        markOpaque(left)
      }
    }
    if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) markOpaque(n.initializer)
  })
  const builtHere = (symbol: ts.Symbol | undefined, seen: Set<ts.Symbol>): boolean => {
    if (!symbol || seen.has(symbol) || opaque.has(symbol)) return false
    seen.add(symbol)
    const given: ts.Expression[] = []
    for (const declaration of symbol.declarations ?? []) {
      if (declaration.getSourceFile() !== a.sf || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false
      const list = declaration.parent
      if (ts.isVariableDeclarationList(list) && (ts.isForOfStatement(list.parent) || ts.isForInStatement(list.parent))) return false
      if (declaration.initializer) given.push(declaration.initializer)
    }
    given.push(...(values.get(symbol) ?? []))
    return given.length > 0 && given.every((value) => isBuilt(value, new Set(seen)))
  }
  const isBuilt = (expr: ts.Expression, seen: Set<ts.Symbol>): boolean => {
    const e = unwrap(expr)
    if (ts.isCallExpression(e)) return isRouterConstruction(e)
    if (ts.isIdentifier(e)) return builtHere(a.symbolOf(e), seen)
    return false
  }
  const out = new Set<string>()
  for (const statement of a.sf.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && isBuilt(statement.expression, new Set())) out.add('default')
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && builtHere(a.checker.getSymbolAtLocation(declaration.name), new Set())) {
          out.add(declaration.name.text)
        }
      }
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue
        if (builtHere(a.checker.getExportSpecifierLocalTargetSymbol(element), new Set())) out.add(element.name.text)
      }
    }
  }
  return [...out]
}

function returnedExpressions(fn: FunctionLike): ts.Expression[] {
  if (!fn.body) return []
  if (!ts.isBlock(fn.body)) return [fn.body]
  const out: ts.Expression[] = []
  const visit = (n: ts.Node) => {
    if (n !== fn && isFunctionLike(n)) return
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression)
    n.forEachChild(visit)
  }
  fn.body.forEachChild(visit)
  return out
}

/**
 * The router tree rooted at `rootFile`: the root plus, followed recursively,
 *   - every module an argument of `<x>.use(...)` resolves to;
 *   - every ROUTER module an argument of a route method called on a router resolves to
 *     (`router.get(path, gate, sub)`, `router.all(path, sub)`, `router.route(path).post(sub)`);
 *   - every router module a `.use` / route-method argument reaches THROUGH a function: the argument
 *     is, or calls, an inline closure or a same-file function whose body (following further same-file
 *     functions it refers to) refers to a binding that resolves to a Router module, or holds a
 *     relative `import()` / `require()` of one (`(req, res, next) => sub(req, res, next)`);
 *   - every Router module a discovered module RE-EXPORTS (see reexportedSpecs: `export … from`,
 *     `export *`, an export of an imported binding, of a top-level alias of one, of a namespace
 *     member, of a relative `require()` / awaited `import()`) — so a router mounted through a barrel
 *     is scanned in the module that builds it, not only in the barrel.
 * An argument or binding is resolved through: an imported binding (default, named, or a namespace
 * member `ns.x`), a factory call on one (`createX(deps)`), a local `const`/`let` alias or a later
 * assignment to it, a destructure, a conditional / `||` / `??`, an array of handlers, a function
 * declared in the file (through its `return`s), and a relative `import()` / `require()`. A `Router()`
 * built in place counts as a mount of the file itself. A "Router module" is a module whose own source
 * has a call NAMED `Router` (`Router()` / `x.Router()` — by name, not resolved to express), or that
 * re-exports (as above, transitively: a barrel of a barrel of one) from a Router module.
 * `read(rel)` returns the source of a path relative to the routes directory; `resolveRel(from, spec)`
 * maps an import specifier to such a path (index files and extensions are its business).
 *
 * Not followed (the list is not exhaustive): a `for…of` / `forEach` binding, a value read back out of
 * a container, a `.call` / `.apply`, a non-relative or computed specifier, a re-export that is not one
 * of the syntactic top-level forms reexportedSpecs lists (e.g. an export assembled inside a function,
 * an exported object literal holding an imported router, a destructured alias
 * `const { default: x } = ns; export { x }`), a router handed to a wrapper defined in ANOTHER module
 * (`import { wrap } from './wrap'; router.use(wrap)` where `wrap` calls the router), a router reached
 * through a function parameter, and — as a route-method argument or from inside a function — a router
 * built in a module that is not a "Router module" by the name rule above (`import { Router as
 * makeRouter } from 'express'`, or a factory imported from another module): only `.use` follows a
 * module whatever it is.
 *
 * Static resolution cannot see every way code can hand a router to Express; the caller is expected
 * to cross-check the routers nested in the LIVE mounted stack BY IDENTITY — the router objects that
 * are themselves a layer's handle, at any depth, including a route layer's handles
 * (`layer.route.stack[i].handle`): every one must be a Router that some discovered module BUILT AND
 * exports under a name localRouterExportNames returns (a re-export does not count: a barrel or a
 * scanned module passing on another module's router does not stand in for the module that builds
 * it; "builds" is by the callee name `Router`, see localRouterExportNames), except at most as many as
 * there are in-place `Router()` mounts (`inPlace`), which have no export and can only be counted — and
 * that allowance, being a count, can be cancelled the same way (a switched-off in-place mount lets one
 * unfollowed live router through). A router the walk cannot follow then turns red there instead of
 * silently shrinking the scanned tree. (A count-only comparison is not enough: a static mount that is
 * switched off at runtime cancels a live router the walk never saw.) A router that is only CALLED from
 * inside a function layer (a closure or wrapper) is not in the live stack at all: the cross-check
 * cannot see it, and only the static rule above (`wrapped`) can.
 */
export function discoverMountedRouterTree(
  rootFile: string,
  read: (rel: string) => string,
  resolveRel: (from: string, spec: string) => string
): RouterTree {
  const files: string[] = []
  const mounts: RouterMount[] = []
  const reexports: RouterReexport[] = []
  const reexportCache = new Map<string, string[]>()
  /** Paths (relative to the routes directory) that `rel` re-exports values from. */
  const reexportTargets = (rel: string): string[] => {
    if (!reexportCache.has(rel)) reexportCache.set(rel, reexportedSpecs(rel, read(rel)).map((spec) => resolveRel(rel, spec)))
    return reexportCache.get(rel) as string[]
  }
  const builds = new Map<string, boolean>()
  const buildsRouter = (rel: string): boolean => {
    if (!builds.has(rel)) builds.set(rel, constructsRouter(rel, read(rel)))
    return builds.get(rel) as boolean
  }
  const routerModule = new Map<string, boolean>()
  /** Builds a Router, or re-exports (transitively, cycles cut) from a module that does. */
  const isRouterModule = (rel: string): boolean => {
    const known = routerModule.get(rel)
    if (known !== undefined) return known
    const seen = new Set<string>([rel])
    const pending = [rel]
    let result = false
    while (pending.length > 0 && !result) {
      const next = pending.shift() as string
      if (buildsRouter(next)) result = true
      for (const to of reexportTargets(next)) {
        if (!seen.has(to)) {
          seen.add(to)
          pending.push(to)
        }
      }
    }
    routerModule.set(rel, result)
    return result
  }
  const queue = [rootFile]
  while (queue.length > 0) {
    const rel = queue.shift() as string
    if (files.includes(rel)) continue
    files.push(rel)
    const a = analyze(rel, read(rel))

    for (const to of reexportTargets(rel)) {
      if (!isRouterModule(to)) continue
      reexports.push({ from: rel, to })
      queue.push(to)
    }

    const importSpec = new Map<ts.Symbol, string>()
    for (const statement of a.sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const spec = statement.moduleSpecifier.text
      const clause = statement.importClause
      if (!spec.startsWith('.') || !clause || clause.isTypeOnly) continue
      const bind = (id: ts.Identifier) => {
        const symbol = a.checker.getSymbolAtLocation(id)
        if (symbol) importSpec.set(symbol, spec)
      }
      if (clause.name) bind(clause.name)
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bind(clause.namedBindings.name)
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) bind(element.name)
      }
    }

    const assigned = new Map<ts.Symbol, ts.Expression[]>()
    walk(a.sf, (n) => {
      if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return
      const left = unwrap(n.left)
      if (!ts.isIdentifier(left)) return
      const symbol = a.symbolOf(left)
      if (!symbol) return
      assigned.set(symbol, [...(assigned.get(symbol) ?? []), n.right])
    })

    const resolve = (expr: ts.Expression, seen: Set<ts.Node>): MountTarget[] => {
      let e = unwrap(expr)
      while (ts.isAwaitExpression(e)) e = unwrap(e.expression)
      if (seen.has(e) || seen.size > 256) return []
      seen.add(e)
      if (ts.isIdentifier(e)) {
        const symbol = a.symbolOf(e)
        if (!symbol) return []
        const spec = importSpec.get(symbol)
        if (spec) return [{ kind: 'module', spec }]
        const out: MountTarget[] = []
        for (const declaration of symbol.declarations ?? []) {
          if (ts.isVariableDeclaration(declaration) && declaration.initializer) out.push(...resolve(declaration.initializer, seen))
          if (ts.isBindingElement(declaration)) {
            let p: ts.Node | undefined = declaration.parent
            while (p && !ts.isVariableDeclaration(p)) p = p.parent
            if (p && ts.isVariableDeclaration(p) && p.initializer) out.push(...resolve(p.initializer, seen))
          }
        }
        for (const right of assigned.get(symbol) ?? []) out.push(...resolve(right, seen))
        return out
      }
      if (ts.isCallExpression(e)) {
        const spec = relativeSpecOf(e)
        if (spec) return [{ kind: 'module', spec }]
        if (isRouterConstruction(e)) return [{ kind: 'local-router' }]
        const out = resolve(e.expression, seen)
        const fn = resolveLocalFunction(a, e.expression)
        if (fn) for (const returned of returnedExpressions(fn)) out.push(...resolve(returned, seen))
        return out
      }
      if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return resolve(e.expression, seen)
      if (ts.isConditionalExpression(e)) return [...resolve(e.whenTrue, seen), ...resolve(e.whenFalse, seen)]
      if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken.kind
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
          return [...resolve(e.left, seen), ...resolve(e.right, seen)]
        }
        return []
      }
      if (ts.isArrayLiteralExpression(e)) {
        return e.elements.flatMap((el) => resolve(ts.isSpreadElement(el) ? el.expression : el, seen))
      }
      if (ts.isObjectLiteralExpression(e)) {
        // `const { sub } = { sub: imported }` — over-approximate: any value the literal holds.
        return e.properties.flatMap((property) => {
          if (ts.isPropertyAssignment(property)) return resolve(property.initializer, seen)
          if (ts.isShorthandPropertyAssignment(property)) return resolve(property.name, seen)
          if (ts.isSpreadAssignment(property)) return resolve(property.expression, seen)
          return []
        })
      }
      return []
    }

    /** Is `expr` (the receiver of a route-method call) a router: built in place, or a Router module? */
    const isRouterValue = (expr: ts.Expression): boolean =>
      resolve(expr, new Set()).some((t) => t.kind === 'local-router' || isRouterModule(resolveRel(rel, t.spec)))

    /**
     * Router modules `node` reaches through what it refers to from outside itself: a binding that
     * resolves to a Router module, a relative `import()` / `require()` of one, and — followed — the
     * body of any same-file function it refers to.
     */
    const reachedRouterModules = (node: ts.Node, visited: Set<ts.Node>, out = new Set<string>()): Set<string> => {
      walk(node, (n) => {
        if (ts.isCallExpression(n)) {
          const spec = relativeSpecOf(n)
          if (spec) {
            const to = resolveRel(rel, spec)
            if (isRouterModule(to)) out.add(to)
          }
          return
        }
        if (ts.isPropertyAccessExpression(n)) {
          // `helpers.mount` — a function member of a same-file object or class.
          const member = resolveLocalFunction(a, n)
          if (member && !visited.has(member)) {
            visited.add(member)
            reachedRouterModules(member, visited, out)
          }
          return
        }
        if (!ts.isIdentifier(n) || !isValueReference(n)) return
        const symbol = a.symbolOf(n)
        if (!symbol) return
        // Its own parameters and locals are not references from outside.
        if ((symbol.declarations ?? []).some((d) => d.getSourceFile() === a.sf && d !== node && isWithin(d, node))) return
        for (const target of resolve(n, new Set())) {
          if (target.kind !== 'module') continue
          const to = resolveRel(rel, target.spec)
          if (isRouterModule(to)) out.add(to)
        }
        const fn = resolveLocalFunction(a, n)
        if (fn && !visited.has(fn)) {
          visited.add(fn)
          reachedRouterModules(fn, visited, out)
        }
      })
      return out
    }

    walk(a.sf, (n) => {
      if (!ts.isCallExpression(n)) return
      const callee = unwrap(n.expression)
      if (!ts.isPropertyAccessExpression(callee)) return
      const method = callee.name.text
      let via: RouterMount['via']
      if (method === 'use') via = 'use'
      else if (ROUTE_METHODS.has(method) && isRouterValue(callee.expression)) via = 'route'
      else return
      n.arguments.forEach((arg, index) => {
        const targets = new Set<string>()
        let router = false
        let inPlace = false
        for (const target of resolve(arg, new Set())) {
          if (target.kind === 'local-router') {
            targets.add(rel)
            router = true
            inPlace = true
          } else {
            const to = resolveRel(rel, target.spec)
            const isRouter = isRouterModule(to)
            // A route method's non-router arguments are handlers: another module's handler is not
            // followed (see the scanner header). A `.use` argument is followed whatever it is.
            if (via === 'route' && !isRouter) continue
            targets.add(to)
            if (isRouter) router = true
            queue.push(to)
          }
        }
        const wrapped = [...reachedRouterModules(arg, new Set())].filter((to) => !targets.has(to))
        for (const to of wrapped) queue.push(to)
        if (targets.size > 0 || wrapped.length > 0) {
          mounts.push({
            from: rel,
            line: a.sf.getLineAndCharacterOfPosition(n.getStart(a.sf)).line + 1,
            via,
            arg: index,
            targets: [...targets],
            wrapped,
            router,
            inPlace,
          })
        }
      })
    })
  }
  return { files, mounts, reexports }
}

/** The files of discoverMountedRouterTree(). */
export function discoverMountedRouterFiles(
  rootFile: string,
  read: (rel: string) => string,
  resolveRel: (from: string, spec: string) => string
): string[] {
  return discoverMountedRouterTree(rootFile, read, resolveRel).files
}
