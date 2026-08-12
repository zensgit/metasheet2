import * as ts from 'typescript'

/**
 * AST registration-site model over `MetaSheetServer`'s Express app assembly
 * in `src/index.ts`.
 *
 * REPLACES a prior text-offset implementation of this module that had two
 * named bugs, both structural: `occurrencesOf` counted `text.indexOf` hits,
 * so a commented-out registration still "occurred"; and
 * `enclosingFunctionLikeAt` tested `pos < node.getFullStart()`, which
 * *includes leading trivia*, so a position inside a comment resolved into
 * whatever node that comment leads. A third bug was never named as a bug:
 * the claim was EXISTENTIAL, not universal — `occurrences === 1` on one
 * fixed needle, compared by FIRST index. A second registration written in
 * any other text shape left `occurrences` at 1 and the comparison still
 * passed, so the guard never quantified over the registration set at all.
 *
 * This module never reads raw text for its verdicts. It walks the real AST:
 * every `CallExpression` whose callee is a member access on `this.app`
 * naming an Express verb is a *registration site* (`R`, `model.sites`);
 * every other read of `this.app` — assignment, computed dispatch
 * (`this.app[x](...)`), or the value escaping into some other call or
 * constructor — is separately collected (`C`, `model.escapes`), so a mount
 * this module cannot itself order is at least visible and pinnable, not
 * silently invisible. A comment produces no AST node in either set, so
 * "commented out" and "deleted" are the same state by construction, not by
 * a special case that could itself be wrong.
 */

const REGISTRAR_VERBS = new Set([
  'use', 'get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head',
])

export type SubjectState = 'NO_SITE' | 'UNCONDITIONAL_SITE' | 'CONDITIONAL_SITE' | 'MULTIPLE_SITES'

export interface RegistrationSite {
  readonly verb: string
  readonly start: number
  readonly line: number
  /** Method/constructor name this call is lexically inside, or `<anonymous>`
   *  if not inside any named function-like at all (should not occur for
   *  this file — a `<anonymous>` entry is itself worth a reviewer's eye). */
  readonly enclosingMethod: string
  /** True iff this call is a bare `ExpressionStatement` that is itself a
   *  direct statement of its enclosing method's body block — see
   *  `classifyUnconditional` for why this whitelist form, not an
   *  ancestor-kind blacklist, is what the shipped predicate uses. */
  readonly unconditional: boolean
  /** Diagnostic only when `unconditional` is false: the syntax-kind name of
   *  the nearest structure that breaks the whitelist (e.g. `IfStatement`,
   *  `ConditionalExpression`, `BinaryExpression`, `ArrowFunction`). */
  readonly blockingAncestorKind: string | null
  /** One projected string per call argument — see `projectArgument`. Used
   *  only to build stable, readable pin signatures; never evaluated. */
  readonly argProjection: readonly string[]
  /** Retained so `subjectState` can test argument membership. Not part of
   *  any `toEqual` pin — callers project the plain fields above. */
  readonly call: ts.CallExpression
}

export type AppEscapeKind = 'ASSIGN' | 'COMPUTED_REGISTRATION' | 'ESCAPE'

export interface AppEscape {
  readonly kind: AppEscapeKind
  readonly start: number
  readonly line: number
  readonly enclosingMethod: string
  /** A short, deterministic, human-readable description of where/how
   *  `this.app` was read — e.g. `"= express()"`, `"createServer(...) arg0"`,
   *  `"[methodLower](...)"`. Frozen into census pins; any change in shape
   *  changes the string and reds the pin. */
  readonly signature: string
}

export interface AssemblyModel {
  /** Every `this.app.<verb>(...)` call site in the file, in source order. */
  readonly sites: readonly RegistrationSite[]
  /** Every OTHER read of `this.app` in the file, in source order. */
  readonly escapes: readonly AppEscape[]
}

function isNamedFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isConstructorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    (ts.isFunctionDeclaration(node) && node.name !== undefined)
  )
}

function functionLikeLabel(node: ts.Node): string {
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) return node.name.text
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text
  return '<anonymous>'
}

/**
 * The innermost NAMED constructor/method/function enclosing `node`, found by
 * climbing `.parent` links — never by comparing text positions, so leading
 * trivia (comments) cannot be resolved into the wrong node. `null` only if
 * `node` is not inside any named function-like (not expected for this file).
 */
function enclosingNamedFunction(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (isNamedFunctionBoundary(current)) return current
    current = current.parent
  }
  return null
}

/**
 * A call is UNCONDITIONAL iff it is *itself* the whole expression of a bare
 * `ExpressionStatement` that is *itself* a direct statement of its enclosing
 * method's body block — i.e. zero hops between the call and the method body.
 *
 * This is a WHITELIST of the one unconditional shape, not a blacklist of
 * conditional ancestor kinds. The blacklist form was tried and was wrong
 * twice during design: a naive "nearest enclosing *statement* is a direct
 * body element" check is satisfied by `cond && this.app.use(x())` — the
 * nearest STATEMENT ancestor of that call is the `ExpressionStatement`
 * wrapping the whole `&&` expression, which *is* a direct body element,
 * even though the call itself only runs when `cond` is truthy. The call's
 * own immediate `.parent` there is a `BinaryExpression`, not an
 * `ExpressionStatement` — which is exactly what this whitelist form checks
 * for and rejects. The same argument applies to `||`, `??`, and the
 * ternary: all three are EXPRESSIONS, so "nearest enclosing statement"
 * walks straight past them, but "is my own immediate parent a statement"
 * does not.
 */
function classifyUnconditional(call: ts.CallExpression): { unconditional: boolean; blockingAncestorKind: string | null } {
  const stmt = call.parent
  if (!ts.isExpressionStatement(stmt) || stmt.expression !== call) {
    return { unconditional: false, blockingAncestorKind: ts.SyntaxKind[stmt.kind] }
  }
  const body = stmt.parent
  if (!ts.isBlock(body)) {
    return { unconditional: false, blockingAncestorKind: ts.SyntaxKind[body.kind] }
  }
  const owner = body.parent
  const ownerBody = (owner as { body?: ts.Node }).body
  if (!isNamedFunctionBoundary(owner) || ownerBody !== body) {
    return { unconditional: false, blockingAncestorKind: ts.SyntaxKind[owner.kind] }
  }
  return { unconditional: true, blockingAncestorKind: null }
}

function calleeLabel(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return 'this'
  if (ts.isPropertyAccessExpression(expr)) return `${calleeLabel(expr.expression)}.${expr.name.text}`
  if (ts.isElementAccessExpression(expr)) return `${calleeLabel(expr.expression)}[...]`
  return `<${ts.SyntaxKind[expr.kind]}>`
}

/**
 * A short, TOTAL (every node produces some string — there is no
 * "undecidable" state) projection of one call argument, deliberately
 * coarse: it names the argument's own shape, not every identifier
 * transitively reachable inside it. Walking every identifier in an
 * argument subtree for a census signature would make renaming an unrelated
 * local parameter (`_req`/`res`/`next`) in nearby pre-gate middleware change
 * the signature — exactly the kind of maintenance pain that gets a guard's
 * census narrowed or deleted later.
 */
function projectArgument(node: ts.Node): string {
  if (ts.isStringLiteralLike(node)) return JSON.stringify(node.text)
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return calleeLabel(node)
  if (ts.isCallExpression(node)) return `${calleeLabel(node.expression)}()`
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return '<inline>'
  return `<${ts.SyntaxKind[node.kind]}>`
}

function isThisAppPropertyAccess(node: ts.Node): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'app' &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword
  )
}

function lineOf(source: ts.SourceFile, pos: number): number {
  return source.getLineAndCharacterOfPosition(pos).line + 1
}

/** Every identifier subtree reachable from any of `call`'s arguments whose
 *  text equals `name`. Deliberately name-based (not symbol-resolved) — see
 *  the module docblock's residual note on this. Because it walks the WHOLE
 *  argument subtree (not just top-level identifiers), a path-prefixed
 *  (`this.app.use('/', S())`) or wrapped (`this.app.use('/', wrap(S()))`)
 *  mount still names `S` somewhere in its arguments and is found. */
function argumentsReachIdentifier(call: ts.CallExpression, name: string): boolean {
  let found = false
  const walk = (node: ts.Node): void => {
    if (found) return
    if (ts.isIdentifier(node) && node.text === name) {
      found = true
      return
    }
    node.forEachChild(walk)
  }
  call.arguments.forEach(walk)
  return found
}

/** Builds the full registration-site (`R`) and escape (`C`) model for the
 *  WHOLE file — not scoped to any one method — so a registration reachable
 *  only through a computed dispatch (`this.app[verb](...)`, used by the
 *  plugin runtime's dynamic route registration) or a mount outside
 *  `setupMiddleware` is visible as a pinned fact rather than silently
 *  unmodelled. */
export function buildAssemblyModel(source: ts.SourceFile): AssemblyModel {
  const sites: RegistrationSite[] = []
  const siteCalleeExpressions = new Set<ts.PropertyAccessExpression>()

  const visitForSites = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (
        ts.isPropertyAccessExpression(callee) &&
        isThisAppPropertyAccess(callee.expression) &&
        REGISTRAR_VERBS.has(callee.name.text)
      ) {
        siteCalleeExpressions.add(callee.expression)
        const { unconditional, blockingAncestorKind } = classifyUnconditional(node)
        const enclosing = enclosingNamedFunction(node)
        sites.push({
          call: node,
          verb: callee.name.text,
          start: node.getStart(source),
          line: lineOf(source, node.getStart(source)),
          enclosingMethod: enclosing ? functionLikeLabel(enclosing) : '<anonymous>',
          unconditional,
          blockingAncestorKind,
          argProjection: node.arguments.map(projectArgument),
        })
      }
    }
    node.forEachChild(visitForSites)
  }
  visitForSites(source)
  sites.sort((a, b) => a.start - b.start)

  const escapes: AppEscape[] = []
  const visitForEscapes = (node: ts.Node): void => {
    if (isThisAppPropertyAccess(node) && !siteCalleeExpressions.has(node)) {
      const enclosing = enclosingNamedFunction(node)
      const enclosingMethod = enclosing ? functionLikeLabel(enclosing) : '<anonymous>'
      const parent = node.parent
      let kind: AppEscapeKind
      let signature: string
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === node) {
        kind = 'ASSIGN'
        signature = `= ${projectArgument(parent.right)}`
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        kind = 'COMPUTED_REGISTRATION'
        signature = `[${parent.argumentExpression.getText(source)}](...)`
      } else if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.some((a) => a === node)) {
        kind = 'ESCAPE'
        const idx = parent.arguments!.findIndex((a) => a === node)
        const prefix = ts.isNewExpression(parent) ? 'new ' : ''
        signature = `${prefix}${calleeLabel(parent.expression)}(...) arg${idx}`
      } else {
        kind = 'ESCAPE'
        signature = `<${ts.SyntaxKind[parent.kind]}>`
      }
      escapes.push({ kind, start: node.getStart(source), line: lineOf(source, node.getStart(source)), enclosingMethod, signature })
    }
    node.forEachChild(visitForEscapes)
  }
  visitForEscapes(source)
  escapes.sort((a, b) => a.start - b.start)

  return { sites, escapes }
}

/** All registration sites whose `enclosingMethod` equals `label`, in source
 *  order — a valid LOCAL execution order (sequential statements in one
 *  function body run in that order regardless of `await` points), used for
 *  ordering and pre-gate-prefix assertions. Cross-method order is NOT
 *  derivable from this alone — see the guard test's own docblock. */
export function sitesInMethod(model: AssemblyModel, label: string): RegistrationSite[] {
  return model.sites.filter((s) => s.enclosingMethod === label)
}

/** The subject's classification and its matching sites, by walking each
 *  site's ARGUMENT subtree (not the call's own text) for an identifier
 *  named `subject`. See `argumentsReachIdentifier`'s docblock for why this
 *  is name-based and what that trades away (module docblock's residual). */
export function subjectState(
  model: AssemblyModel,
  subject: string,
): { state: SubjectState; sites: RegistrationSite[] } {
  const matches = model.sites.filter((s) => argumentsReachIdentifier(s.call, subject))
  const state: SubjectState =
    matches.length === 0 ? 'NO_SITE'
      : matches.length > 1 ? 'MULTIPLE_SITES'
        : matches[0].unconditional ? 'UNCONDITIONAL_SITE' : 'CONDITIONAL_SITE'
  return { state, sites: matches }
}

export interface MethodCallSite {
  readonly start: number
  readonly line: number
  readonly enclosingMethod: string
  readonly unconditional: boolean
  readonly blockingAncestorKind: string | null
}

/** Every `this.<methodName>()` call in the file — used to prove
 *  `setupMiddleware()` itself is invoked exactly once, unconditionally,
 *  from the constructor, using the same whitelist predicate as registration
 *  sites (see `classifyUnconditional`). General over any method name so it
 *  is testable against fixtures independent of `index.ts`. */
export function findThisMethodCalls(source: ts.SourceFile, methodName: string): MethodCallSite[] {
  const out: MethodCallSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === methodName &&
        callee.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const { unconditional, blockingAncestorKind } = classifyUnconditional(node)
        const enclosing = enclosingNamedFunction(node)
        out.push({
          start: node.getStart(source),
          line: lineOf(source, node.getStart(source)),
          enclosingMethod: enclosing ? functionLikeLabel(enclosing) : '<anonymous>',
          unconditional,
          blockingAncestorKind,
        })
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  out.sort((a, b) => a.start - b.start)
  return out
}

/**
 * DIAGNOSTIC ONLY — never assert on this. Raw non-overlapping substring
 * occurrences of `needle` in `text`, including inside comments and string
 * literals. Exists solely so a `NO_SITE` failure message can say "commented
 * out or otherwise inert" (mentions > 0) instead of "removed" (mentions ===
 * 0). Asserting on this count is exactly the bug this module replaces: a
 * comment is text, and text is not the domain this module reasons over.
 */
export function textMentions(text: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const idx = text.indexOf(needle, from)
    if (idx === -1) break
    count += 1
    from = idx + needle.length
  }
  return count
}
