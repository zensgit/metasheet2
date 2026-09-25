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
 *     same receiver symbol;
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
 *     rejection handler `.then(_, cb)`, of an `.on|once('error', cb)` listener (inline or an in-file
 *     function), and of a 4-parameter express error middleware whose first parameter is named like an
 *     error; the third (`error`) parameter of a function that DEFINES sendAdminReadFailure /
 *     sendAdminWriteFailure — by the responder contract it is the caught value, so the envelope
 *     module itself is held to the same rule;
 *   flows — a declaration whose initializer references a tainted symbol (`const err = error as Error`,
 *     `const m = String(error)`, `const { message } = err`); an ASSIGNMENT whose right side does
 *     (`x = …`, `x += …`, `obj.p = …` / `obj[k] = …` taints `obj`, destructuring assignment);
 *     `Object.assign(target, …tainted)`; `arr.push|unshift|splice(…tainted)`; a tainted receiver's
 *     array callback (`errs.map((e) => …)` taints `e`); an ARGUMENT passed to a function declared in
 *     the same file taints the matching parameter (`function fail(res, e) {…}` called as
 *     `fail(res, error)`); a function whose body captures a tainted symbol from outside it.
 *
 * NOT modelled — pinned only by the runtime probes of the routes that exist today:
 *   - a helper declared in ANOTHER module that writes the body (the scanner reads one file at a time;
 *     the admin failure responders are the one cross-module writer in the tree: at the call site
 *     their `extra` argument is a sink, and their own module is scanned with the `error` parameter
 *     tainted, see sources);
 *   - a status set in a different function than the body call (e.g. an earlier middleware);
 *   - a value that becomes error text only through a function's RETURN (a function that builds the
 *     text from its own internal catch) unless the call site's arguments reference the taint;
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
const ERROR_LIKE_PARAM = /^(err|error|e|ex|exception)$/i
const ERROR_EVENT_METHODS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'])
const ARRAY_MUTATORS = new Set(['push', 'unshift', 'splice'])
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

/** A function declared in THIS file that `expr` names (directly, or through a local alias). */
function resolveLocalFunction(a: Analysis, expr: ts.Expression, depth = 0): FunctionLike | null {
  if (depth > MAX_ALIAS_DEPTH) return null
  const inner = unwrap(expr)
  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner
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
      const first = n.parameters[0]
      if (n.parameters.length === 4 && first && ts.isIdentifier(first.name) && ERROR_LIKE_PARAM.test(first.name.text)) {
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
        } else if (ARRAY_MUTATORS.has(method)) {
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

function receiverKey(a: Analysis, expr: ts.Expression): ReceiverKey {
  const inner = unwrap(expr)
  if (ts.isIdentifier(inner)) return a.symbolOf(inner) ?? inner.text
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

/** For `<recv>.json(...)`, the status set down its call chain (or on the local it was bound from). */
function statusOfChain(a: Analysis, receiverExpr: ts.Expression): number | 'dynamic' | null {
  let receiver = unwrap(receiverExpr)
  for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth++) {
    if (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
      if (STATUS_METHODS.has(receiver.expression.name.text)) return statusValue(receiver.arguments[0])
      receiver = unwrap(receiver.expression.expression)
      continue
    }
    if (ts.isIdentifier(receiver)) {
      const declaration = a.symbolOf(receiver)?.valueDeclaration
      if (declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer) {
        receiver = unwrap(declaration.initializer)
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
      if (chained !== null) {
        kind = 'status-chain'
        status = chained
      } else {
        const key = receiverKey(a, callee.expression)
        const scope = enclosingFunction(n)
        const start = n.getStart(sf)
        const earlier = setters.filter((s) => s.key === key && s.pos < start && isWithin(scope, s.scope))
        const split = worstStatus(earlier.map((s) => s.status))
        if (split !== null) {
          kind = 'status-split'
          status = split
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
  /** File whose `.use(...)` call this is. */
  from: string
  line: number
  /** Which argument of the `.use(...)` call. */
  arg: number
  /** Files that argument resolves to (the mounting file itself for a Router built in place). */
  targets: string[]
  /** True when some target is a Router: built in place, or a module that constructs one. */
  router: boolean
}

export interface RouterTree {
  files: string[]
  mounts: RouterMount[]
}

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
 * The router tree rooted at `rootFile`: the root plus every module an argument of `<x>.use(...)`
 * resolves to, followed recursively. An argument is resolved through: an imported binding (default,
 * named, or a namespace member `ns.x`), a factory call on one (`createX(deps)`), a local
 * `const`/`let` alias or a later assignment to it, a destructure, a conditional / `||` / `??`, an
 * array of handlers, a function declared in the file (through its `return`s), and a relative
 * `import()` / `require()`. A `Router()` built in place counts as a mount of the file itself.
 * `read(rel)` returns the source of a path relative to the routes directory; `resolveRel(from, spec)`
 * maps an import specifier to such a path.
 *
 * Static resolution cannot see every way code can hand a router to `.use()`; the caller is expected
 * to cross-check `mounts.filter((m) => m.router).length` against the routers nested in the LIVE
 * mounted stack, so a mount this walk cannot follow turns red there instead of silently shrinking
 * the scanned tree.
 */
export function discoverMountedRouterTree(
  rootFile: string,
  read: (rel: string) => string,
  resolveRel: (from: string, spec: string) => string
): RouterTree {
  const files: string[] = []
  const mounts: RouterMount[] = []
  const routerModule = new Map<string, boolean>()
  const isRouterModule = (rel: string) => {
    if (!routerModule.has(rel)) routerModule.set(rel, constructsRouter(rel, read(rel)))
    return routerModule.get(rel) as boolean
  }
  const queue = [rootFile]
  while (queue.length > 0) {
    const rel = queue.shift() as string
    if (files.includes(rel)) continue
    files.push(rel)
    const a = analyze(rel, read(rel))

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

    walk(a.sf, (n) => {
      if (!ts.isCallExpression(n)) return
      const callee = unwrap(n.expression)
      if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'use') return
      n.arguments.forEach((arg, index) => {
        const targets = new Set<string>()
        let router = false
        for (const target of resolve(arg, new Set())) {
          if (target.kind === 'local-router') {
            targets.add(rel)
            router = true
          } else {
            const to = resolveRel(rel, target.spec)
            targets.add(to)
            if (isRouterModule(to)) router = true
            queue.push(to)
          }
        }
        if (targets.size > 0) {
          mounts.push({
            from: rel,
            line: a.sf.getLineAndCharacterOfPosition(n.getStart(a.sf)).line + 1,
            arg: index,
            targets: [...targets],
            router,
          })
        }
      })
    })
  }
  return { files, mounts }
}

/** The files of discoverMountedRouterTree(). */
export function discoverMountedRouterFiles(
  rootFile: string,
  read: (rel: string) => string,
  resolveRel: (from: string, spec: string) => string
): string[] {
  return discoverMountedRouterTree(rootFile, read, resolveRel).files
}
