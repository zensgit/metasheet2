/**
 * Structural scanner: which 5xx HTTP responses in a route source file carry the text of a caught
 * error (`err.message`, `err.stack`, `String(err)`, a template over `err`, the error object itself, or
 * any local derived from it)?
 *
 * Used by tests/unit/admin-tree-5xx-values-free.test.ts to keep the /api/admin router tree
 * values-free. It works on the TypeScript AST (ts.createSourceFile), not on regexes over lines, so:
 *   - a LOG call is never a sink — `logger.error(`x ${err.message}`, err)` is exactly where the
 *     original error is supposed to go, and it is not flagged;
 *   - only RESPONSE sinks are inspected: `<res>.status(S)…json|send|end(args)`, `jsonError(res, S, …)`,
 *     and the `extra` argument of the admin failure responders (sendAdminReadFailure /
 *     sendAdminWriteFailure), whose fields are spread into the 500 body;
 *   - a sink counts when S is a numeric literal >= 500 OR is not a literal at all (a dynamic status
 *     may well be a 5xx, so it is held to the same rule);
 *   - 4xx sinks are out of scope (their text is a separate decision and is not what this guard pins).
 *
 * What counts as "error text" inside a sink's arguments:
 *   - any `.message` / `.stack` property read (or `['message']` / `['stack']`), whatever the receiver;
 *   - any value reference to a TAINTED name: the variable of an enclosing `catch (x)`, the first
 *     parameter of an enclosing `.catch((x) => …)` callback or of a 4-parameter express error
 *     middleware whose first parameter is named like an error, and — propagated to a fixpoint — any
 *     local declared inside those scopes whose initializer references a tainted name
 *     (`const err = error as Error`, `const m = String(error)`, `const { message } = err`).
 */
import ts from 'typescript'

export type EchoSinkKind = 'status-chain' | 'jsonError' | 'responder-extra'

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

export interface EchoScanResult {
  sinks: EchoSink[]
  offenders: EchoOffender[]
  /** Every call to sendAdminReadFailure / sendAdminWriteFailure, with the call's source range. */
  responderCalls: Array<{ file: string; line: number; name: string; start: number; end: number; catchVar: string | null }>
}

const RESPONDER_NAMES = new Set(['sendAdminReadFailure', 'sendAdminWriteFailure'])
const BODY_METHODS = new Set(['json', 'send', 'end'])
const ERROR_TEXT_PROPS = new Set(['message', 'stack'])
const ERROR_LIKE_PARAM = /^(err|error|e|ex|exception)$/i

export function parseSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
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

function statusValue(arg: ts.Expression | undefined): number | 'dynamic' {
  if (!arg) return 'dynamic'
  const inner = unwrap(arg)
  if (ts.isNumericLiteral(inner)) return Number(inner.text)
  return 'dynamic'
}

function isFiveXx(status: number | 'dynamic'): boolean {
  return status === 'dynamic' || status >= 500
}

/** For `<recv>.json(...)`, walk down the call chain looking for a `.status(S)` link. */
function statusOfBodyCall(call: ts.CallExpression): number | 'dynamic' | null {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || !BODY_METHODS.has(callee.name.text)) return null
  let receiver = unwrap(callee.expression)
  while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
    if (receiver.expression.name.text === 'status') return statusValue(receiver.arguments[0])
    receiver = unwrap(receiver.expression.expression)
  }
  return null
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
  if (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) return false
  if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false
  return true
}

function referencesAny(node: ts.Node, names: Set<string>): boolean {
  let hit = false
  walk(node, (n) => {
    if (!hit && ts.isIdentifier(n) && names.has(n.text) && isValueReference(n)) hit = true
  })
  return hit
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text)
    return
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, out)
  }
}

/** Names bound to (or derived from) a caught error at `node`, plus the innermost catch variable. */
function taintAt(node: ts.Node): { names: Set<string>; catchVar: string | null } {
  const names = new Set<string>()
  const scopes: ts.Node[] = []
  let catchVar: string | null = null
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isCatchClause(p) && p.variableDeclaration) {
      const found: string[] = []
      bindingNames(p.variableDeclaration.name, found)
      for (const n of found) names.add(n)
      if (catchVar === null && found.length > 0) catchVar = found[0]
      scopes.push(p.block)
    }
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isFunctionDeclaration(p)) {
      const first = p.parameters[0]
      const parent = p.parent
      const isCatchCallback =
        parent !== undefined &&
        ts.isCallExpression(parent) &&
        ts.isPropertyAccessExpression(parent.expression) &&
        parent.expression.name.text === 'catch'
      const isErrorMiddleware =
        p.parameters.length === 4 && first !== undefined && ts.isIdentifier(first.name) && ERROR_LIKE_PARAM.test(first.name.text)
      if (first && (isCatchCallback || isErrorMiddleware)) {
        const found: string[] = []
        bindingNames(first.name, found)
        for (const n of found) names.add(n)
        if (p.body) scopes.push(p.body)
      }
    }
  }
  // Propagate through locals derived from a tainted name, to a fixpoint.
  let changed = names.size > 0
  while (changed) {
    changed = false
    for (const scope of scopes) {
      walk(scope, (n) => {
        if (!ts.isVariableDeclaration(n) || !n.initializer) return
        const declared: string[] = []
        bindingNames(n.name, declared)
        if (declared.every((d) => names.has(d))) return
        if (!referencesAny(n.initializer, names)) return
        for (const d of declared) {
          if (!names.has(d)) {
            names.add(d)
            changed = true
          }
        }
      })
    }
  }
  return { names, catchVar }
}

function errorTextIn(args: readonly ts.Expression[], tainted: Set<string>): string | null {
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
      } else if (ts.isIdentifier(n) && tainted.has(n.text) && isValueReference(n)) {
        reason = `references caught error '${n.text}'`
      }
    })
    if (reason) break
  }
  return reason
}

export function scanResponseErrorEcho(file: string, text: string): EchoScanResult {
  const sf = parseSource(file, text)
  const result: EchoScanResult = { sinks: [], offenders: [], responderCalls: [] }
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return
    const name = calleeName(n)

    let kind: EchoSinkKind | null = null
    let status: number | 'dynamic' | null = null
    let args: readonly ts.Expression[] = []

    const bodyStatus = statusOfBodyCall(n)
    if (bodyStatus !== null) {
      kind = 'status-chain'
      status = bodyStatus
      args = n.arguments
    } else if (name === 'jsonError') {
      kind = 'jsonError'
      status = statusValue(n.arguments[1])
      args = n.arguments.slice(2)
    } else if (name !== null && RESPONDER_NAMES.has(name)) {
      kind = 'responder-extra'
      status = 500
      args = n.arguments.slice(3)
      const { catchVar } = taintAt(n)
      result.responderCalls.push({ file, line: lineOf(n), name, start: n.getStart(sf), end: n.getEnd(), catchVar })
    }
    if (kind === null || status === null || !isFiveXx(status)) return

    const sink: EchoSink = { file, line: lineOf(n), kind, status }
    result.sinks.push(sink)
    const { names } = taintAt(n)
    const reason = errorTextIn(args, names)
    if (reason) {
      result.offenders.push({ ...sink, reason, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 160) })
    }
  })
  return result
}

/**
 * The router tree rooted at `rootFile`: the root plus every module it hands to `<x>.use(...)` through
 * a relative import (directly as an identifier, or as a factory call `x()`), followed recursively.
 * `read(rel)` returns the source of a file path relative to the routes directory.
 */
export function discoverMountedRouterFiles(rootFile: string, read: (rel: string) => string, resolveRel: (from: string, spec: string) => string): string[] {
  const seen: string[] = []
  const queue = [rootFile]
  while (queue.length > 0) {
    const rel = queue.shift() as string
    if (seen.includes(rel)) continue
    seen.push(rel)
    const sf = parseSource(rel, read(rel))
    const imported = new Map<string, string>()
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const spec = statement.moduleSpecifier.text
      if (!spec.startsWith('.')) continue
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly) continue
      if (clause.name) imported.set(clause.name.text, spec)
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) imported.set(element.name.text, spec)
      }
    }
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'use') return
      for (const arg of n.arguments) {
        const inner = unwrap(arg)
        const id = ts.isIdentifier(inner)
          ? inner
          : ts.isCallExpression(inner) && ts.isIdentifier(unwrap(inner.expression))
            ? (unwrap(inner.expression) as ts.Identifier)
            : null
        if (id && imported.has(id.text)) queue.push(resolveRel(rel, imported.get(id.text) as string))
      }
    })
  }
  return seen
}
