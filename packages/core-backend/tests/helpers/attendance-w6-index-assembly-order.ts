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
 * naming an Express verb is a *registration site* (`R`, `model.sites`). The
 * `this` RECEIVER of that `.app` read is normalized through
 * `unwrapNoOpWrappers` first — see that function's own doc for the closed,
 * finite set of wrapper kinds it strips (`this!.app`, `(this).app`,
 * `this as X`, `<X>this`, `this satisfies X`, and any composition of them)
 * — so a receiver written through any of those forms is a site exactly as
 * if it had been written as bare `this.app`. This is RECEIVER normalization
 * only: a wrapper around the WHOLE `this.app` VALUE, after the property
 * read (`(this.app).use(...)`, `this.app!.use(...)`), is a structurally
 * different position — `callee.expression` there is the wrapper node, not
 * a `this.app` `PropertyAccessExpression` at all — and is NOT promoted to a
 * site; it is still collected as an ESCAPE (`<ParenthesizedExpression>`,
 * `<NonNullExpression>`, etc.), per the very next paragraph. That split is
 * a deliberate, verified fixture (see "receiver vs. whole-value wrapping"
 * below), not an oversight.
 *
 * EVERY OTHER READ of the `app` property off `this` is separately collected
 * (`C`, `model.escapes`) — assignment, computed dispatch
 * (`this.app[x](...)`), the value escaping into some other call or
 * constructor, a wrapper around the whole `this.app` VALUE rather than its
 * `this` receiver (`(this.app).use(...)`, `this.app!.use(...)` — see above),
 * OR the SAME property reached through a syntax this module does not treat
 * as a registration site: a bare `this.app` used as an initializer/argument
 * (`const a = this.app`), string-literal bracket notation naming the same
 * property (`this['app']`, in any of the shapes above — INCLUDING through a
 * no-op receiver wrapper, e.g. `this!['app']`, `(this as any)['app']`), or
 * a direct `const`/`let`/`var` destructure of `this` — itself optionally
 * behind a no-op wrapper (`const { app } = this!`, `const { app } = (this
 * as any)`) — that binds `app` — by name (`const { app } = this`), by
 * rename (`const { app: a } = this`), or via a rest element that captures
 * it along with every other own property (`const { ...rest } = this`). So a
 * mount this module cannot itself order is at least visible and pinnable,
 * not silently invisible. A comment produces no AST node in either set, so
 * "commented out" and "deleted" are the same state by construction, not by
 * a special case that could itself be wrong.
 *
 * NOT collected, named rather than silently missed (the property-identity
 * problem does not converge past this point — see the design note above
 * `isThisAppElementAccess` and `bindingElementSourceName`):
 *  - a NON-literal bracket index on `this` (`this[computedExpr]`) — this
 *    module cannot decide whether `computedExpr` evaluates to `'app'`
 *    without executing it, so it collects neither a site nor an escape for
 *    that read (a negative fixture proves this residual, not merely that
 *    it happens not to trigger). This residual is unaffected by receiver
 *    unwrapping: `(this as any)[computedExpr]` is exactly as undecidable as
 *    the unwrapped form.
 *  - destructuring `this` on the LEFT side of a plain ASSIGNMENT
 *    (`({ app } = this)`) — that parses as an object/array LITERAL
 *    expression, a structurally different node from the `const`/`let`/`var`
 *    `BindingPattern` this module walks. Also unaffected by receiver
 *    unwrapping: `({ app } = this as any)` is the same LITERAL-expression
 *    shape, not a `BindingPattern`.
 *  - `this` itself escaping bare (not `.app`, not `['app']`, not
 *    destructured) into another call, constructor, or closure that might
 *    read `.app` out of band (`Reflect.get(this, 'app')`, `{...this}`,
 *    `for...in this`, `.bind`/`.call`/`.apply`, a `Proxy` over `this`) — an
 *    unbounded family; naming it here is the intended fail-closed posture,
 *    not an attempt to enumerate it.
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

/**
 * Strips a NO-OP wrapper node — one that changes nothing about which
 * runtime value the expression evaluates to — to reach the underlying
 * expression, looping to a fixed point so a composition of wrappers
 * (`((this as any))`, `this! as X`, …) is fully unwrapped, not just the
 * outermost layer.
 *
 * The set is closed and finite BY THE TYPESCRIPT GRAMMAR, not by this
 * module's enumeration effort: every kind switched on below has exactly one
 * `.expression` child that spans strictly fewer source tokens than the
 * wrapper itself, so each iteration strictly descends and the loop
 * terminates in at most the wrapper's own nesting depth. Membership is
 * decided purely by `node.kind` — no type information, no execution:
 *  - `ParenthesizedExpression`   — `(this)`
 *  - `NonNullExpression`         — `this!`
 *  - `AsExpression`              — `this as X`
 *  - `TypeAssertionExpression`   — `<X>this` (legacy angle-bracket form;
 *                                  valid in a `.ts` file, this module's own
 *                                  target)
 *  - `SatisfiesExpression`       — `this satisfies X`
 *
 * `ts.createSourceFile` (this module's only entry point into the AST) can
 * never produce a `PartiallyEmittedExpression` — that kind exists solely as
 * a transform-synthetic marker inserted by the emitter, not by the parser —
 * so it is correctly absent from this switch, not an oversight.
 *
 * This unwraps the RECEIVER of a read (the `this` a `.app` access, a
 * `this.<method>()` call, or a destructure pulls from), never the whole
 * read's VALUE — see the module docblock for why a wrapper around the whole
 * `this.app` expression (`(this.app).use(...)`) is a structurally different
 * position that stays escape-only, not promoted to a site by this function.
 */
function unwrapNoOpWrappers(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node
  for (;;) {
    switch (current.kind) {
      case ts.SyntaxKind.ParenthesizedExpression:
        current = (current as ts.ParenthesizedExpression).expression
        continue
      case ts.SyntaxKind.NonNullExpression:
        current = (current as ts.NonNullExpression).expression
        continue
      case ts.SyntaxKind.AsExpression:
        current = (current as ts.AsExpression).expression
        continue
      case ts.SyntaxKind.TypeAssertionExpression:
        current = (current as ts.TypeAssertion).expression
        continue
      case ts.SyntaxKind.SatisfiesExpression:
        current = (current as ts.SatisfiesExpression).expression
        continue
      default:
        return current
    }
  }
}

/** `node.expression` is `this`, directly OR through any composition of the
 *  no-op wrappers `unwrapNoOpWrappers` strips (`this!`, `(this)`,
 *  `this as X`, `<X>this`, `this satisfies X`). Shared by every predicate
 *  below that keys on "the receiver is `this`" so the wrapper set is
 *  enumerated in exactly one place. */
function hasUnwrappedThisReceiver(node: { expression: ts.Expression }): boolean {
  return unwrapNoOpWrappers(node.expression).kind === ts.SyntaxKind.ThisKeyword
}

function isThisAppPropertyAccess(node: ts.Node): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'app' &&
    hasUnwrappedThisReceiver(node)
  )
}

/**
 * `this['app']` (or `this["app"]`) — the SAME property, reached through
 * string-literal bracket notation instead of dot notation. Deliberately
 * decidable-only: a NON-literal index (`this[computedExpr]`) cannot be
 * proven to name `'app'` without executing it, so this predicate declines
 * rather than guessing — see the module docblock's residual note. A literal
 * index naming any OTHER property (`this['foo']`) is provably not this
 * property and also declines; the negative fixture for this shape asserts
 * exactly zero collected entries, distinguishing "matches string literals"
 * from "matches every bracket access on `this`". The receiver is unwrapped
 * the same way as `isThisAppPropertyAccess`, so `this!['app']`,
 * `(this as any)['app']`, etc. match too.
 */
function isThisAppElementAccess(node: ts.Node): node is ts.ElementAccessExpression {
  return (
    ts.isElementAccessExpression(node) &&
    hasUnwrappedThisReceiver(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === 'app'
  )
}

/** Either spelling of a read of the `app` property off `this` — the union
 *  this module's SITE and ESCAPE collectors both key on. */
function isThisAppRead(node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  return isThisAppPropertyAccess(node) || isThisAppElementAccess(node)
}

function lineOf(source: ts.SourceFile, pos: number): number {
  return source.getLineAndCharacterOfPosition(pos).line + 1
}

/**
 * The statically-knowable SOURCE property name a `BindingElement` reads —
 * `null` when it genuinely cannot be decided (a non-literal computed
 * property name), which callers must treat as "not provably `app`", not as
 * "definitely not `app`" (see the module docblock's residual note; this
 * mirrors `isThisAppElementAccess`'s same refusal-to-guess posture).
 */
function bindingElementSourceName(el: ts.BindingElement): string | null {
  const key = el.propertyName ?? el.name
  if (ts.isComputedPropertyName(key)) {
    return ts.isStringLiteralLike(key.expression) ? key.expression.text : null
  }
  if (ts.isIdentifier(key)) return key.text
  if (ts.isStringLiteralLike(key)) return key.text
  return null
}

/**
 * Direct `const`/`let`/`var` destructuring of `this` — or of `this` behind
 * any of the same no-op receiver wrappers `unwrapNoOpWrappers` strips
 * elsewhere in this module (`const { app } = this!`, `const { app } =
 * (this as any)`) — that binds `app`: by name, by rename, or via a rest
 * element (which captures every property NOT otherwise named in the same
 * pattern, `app` included). A separate pass from `visitForEscapes` because
 * the read here is of `this` (a `ThisKeyword`, possibly wrapped) flowing
 * into a `BindingPattern`, not a `this.app`-shaped node — see the module
 * docblock's residual note on the ASSIGNMENT form (`({ app } = this)`),
 * which is a structurally different node this pass does not visit.
 */
function collectThisDestructuringEscapes(source: ts.SourceFile): AppEscape[] {
  const found: AppEscape[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      unwrapNoOpWrappers(node.initializer).kind === ts.SyntaxKind.ThisKeyword &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const enclosing = enclosingNamedFunction(node)
      const enclosingMethod = enclosing ? functionLikeLabel(enclosing) : '<anonymous>'
      for (const el of node.name.elements) {
        const isRest = el.dotDotDotToken !== undefined
        const sourceName = bindingElementSourceName(el)
        if (!isRest && sourceName !== 'app') continue
        const local = ts.isIdentifier(el.name) ? el.name.text : '<pattern>'
        const signature = isRest
          ? `{ ...${local} } = this`
          : el.propertyName
            ? `{ app: ${local} } = this`
            : `{ app } = this`
        found.push({
          kind: 'ESCAPE',
          start: node.getStart(source),
          line: lineOf(source, node.getStart(source)),
          enclosingMethod,
          signature,
        })
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return found
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
  // Typed `Set<ts.Node>`, not `Set<ts.PropertyAccessExpression>`, purely so
  // the exclusion check below (`!siteCalleeExpressions.has(node)`) can be
  // asked of the widened `isThisAppRead` union without a cast. Every value
  // actually inserted is still a genuine SITE callee (a `this.app`
  // `PropertyAccessExpression`) — `visitForSites` below never adds an
  // `ElementAccessExpression`, since the SITE definition itself stays
  // dot-notation-only (see `isThisAppRead`'s own doc for why `this['app']`
  // is escape-only, never promoted to an orderable site).
  const siteCalleeExpressions = new Set<ts.Node>()

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
    if (isThisAppRead(node) && !siteCalleeExpressions.has(node)) {
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
  escapes.push(...collectThisDestructuringEscapes(source))
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
 *  sites (see `classifyUnconditional`). The receiver is unwrapped the same
 *  way as `isThisAppPropertyAccess` (`this!.setupMiddleware()`, `(this as
 *  any).setupMiddleware()`, etc. all count), so this shares the SAME
 *  wrapper-blindness fix, not a separate one — a wrapped ADDITIONAL call
 *  site would otherwise be invisible to this function while the "exactly
 *  one call site" assertion built on it stayed green. General over any
 *  method name so it is testable against fixtures independent of
 *  `index.ts`. */
export function findThisMethodCalls(source: ts.SourceFile, methodName: string): MethodCallSite[] {
  const out: MethodCallSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === methodName &&
        hasUnwrappedThisReceiver(callee)
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

// ---------------------------------------------------------------------------
// Round 4 — the FOUR-BUCKET partition with an UNKNOWN census (owner-specified).
//
// Rounds 1-3 enumerated wrapper/alias shapes and never converged. This closes
// the class by COMPLEMENT: every `this` use in the file is placed in exactly
// one of {SITE, ESCAPE, SAFE, UNKNOWN}, and UNKNOWN is asserted empty. A shape
// nobody enumerated lands in UNKNOWN by default and reds, rather than slipping
// through. SAFE is NOT a set of property names — it is a FROZEN census of exact
// OCCURRENCES keyed by (enclosing symbol + AST path + access shape), never by
// line/column, so an unrelated insert elsewhere does not false-red, while a
// duplicate / move / re-context of a safe access mints a new key -> UNKNOWN.
// ---------------------------------------------------------------------------

export type ThisBucket = 'SITE' | 'ESCAPE' | 'SAFE' | 'UNKNOWN'

export interface ThisOccurrence {
  readonly key: string
  readonly bucket: ThisBucket
  readonly shape: string
  readonly start: number
}

export interface ThisPartition {
  readonly total: number
  readonly site: readonly ThisOccurrence[]
  readonly escape: readonly ThisOccurrence[]
  readonly safe: readonly ThisOccurrence[]
  readonly unknown: readonly ThisOccurrence[]
  /** every occurrence, one per ThisKeyword node, classification multiplicity 1 by construction */
  readonly all: readonly ThisOccurrence[]
}

/** Outermost no-op wrapper of `node` — the node whose `.parent` is the real
 *  consumer of the `this` value (`(this as X)` -> the `AsExpression`). */
function outermostWrapperOf(node: ts.Node): ts.Node {
  let current: ts.Node = node
  for (;;) {
    const parent = current.parent
    if (!parent) return current
    const isWrapper =
      parent.kind === ts.SyntaxKind.ParenthesizedExpression ||
      parent.kind === ts.SyntaxKind.NonNullExpression ||
      parent.kind === ts.SyntaxKind.AsExpression ||
      parent.kind === ts.SyntaxKind.TypeAssertionExpression ||
      parent.kind === ts.SyntaxKind.SatisfiesExpression
    if (isWrapper && (parent as { expression?: ts.Node }).expression === current) {
      current = parent
      continue
    }
    return current
  }
}

/** Base occurrence key: enclosing named symbol + the ANCESTOR-KIND path from
 *  that symbol (or the source root) down to the node + the access shape. The
 *  path records `SyntaxKind` names, never child ORDINALS — so an unrelated
 *  sibling insertion in the SAME method (which shifts ordinals) does NOT move a
 *  key (P2-b fix), while nesting the access under a different construct
 *  (re-context) DOES. No line/column anywhere. Occurrences that share a base
 *  key are disambiguated by a source-order occurrence ordinal in
 *  `collectOccurrences`, so a duplicate still mints a distinct final key. */
function baseKeyOf(node: ts.Node, source: ts.SourceFile, shape: string): string {
  const enclosing = enclosingNamedFunction(node)
  const stop: ts.Node = enclosing ?? source
  const label = enclosing ? functionLikeLabel(enclosing) : '<file>'
  const kinds: string[] = []
  let current: ts.Node = node
  while (current.parent && current.parent !== stop) {
    current = current.parent
    kinds.push(ts.SyntaxKind[current.kind])
  }
  kinds.reverse()
  return `${label}//${kinds.join('>')}//${shape}`
}

/** The constructor/method nodes whose label is in `scopeSymbols`. The reference
 *  set T is EVERY `ThisKeyword` textually inside these subtrees (including
 *  nested functions) — no scope pruning, so a `this` a bucket rule forgets
 *  cannot silently leave T (P2-a/P2-c fix). */
function findTargetMethods(source: ts.SourceFile, scopeSymbols: ReadonlySet<string>): ts.Node[] {
  const targets: ts.Node[] = []
  const walk = (node: ts.Node): void => {
    if (
      (ts.isConstructorDeclaration(node) || ts.isMethodDeclaration(node)) &&
      scopeSymbols.has(functionLikeLabel(node))
    ) {
      targets.push(node)
    }
    node.forEachChild(walk)
  }
  walk(source)
  return targets
}

/** True iff the `this` at `node` binds to `target`'s instance `this` — i.e. NO
 *  `this`-rebinding boundary lies strictly between `node` and `target`. A
 *  boundary rebinds `this` unless it is an `ArrowFunction` (arrows do not rebind).
 *  The rebinding boundaries are:
 *   - a non-arrow function-like (function decl/expr, object-literal or class
 *     method, get/set accessor, constructor);
 *   - a class static block;
 *   - a class field / static-field `PropertyDeclaration` — its initializer's
 *     `this` is the (nested) instance being constructed, NOT the assembly
 *     instance (P3-1: this is NOT function-like, so `isFunctionLike` alone
 *     walked past it and mis-reported instance-bound; the census caught it, but
 *     the classification door must own its own property).
 *  Expressed as a COMPLEMENT (a boundary is fine only if it is an arrow) so any
 *  new `this`-rebinding construct fails closed to UNKNOWN by default. Note the
 *  slight over-conservatism: a `this` inside a class field's COMPUTED NAME is
 *  actually the outer `this`, yet is forced UNKNOWN here — fail-closed, safe. */
function isThisRebindingBoundary(node: ts.Node): boolean {
  if (ts.isArrowFunction(node)) return false
  return (
    ts.isFunctionLike(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  )
}

function thisBindsToTarget(node: ts.Node, target: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent
  while (current && current !== target) {
    if (isThisRebindingBoundary(current)) return false
    current = current.parent
  }
  return current === target
}

/** Is `access` (a `this.app` PropertyAccessExpression) the receiver of a
 *  registrar-verb call `this.app.<verb>(...)`? */
function isRegistrarCallReceiver(access: ts.Node): boolean {
  const verbAccess = access.parent
  if (!verbAccess || !ts.isPropertyAccessExpression(verbAccess) || verbAccess.expression !== access) return false
  if (!REGISTRAR_VERBS.has(verbAccess.name.text)) return false
  const call = verbAccess.parent
  return !!call && ts.isCallExpression(call) && call.expression === verbAccess
}

/** True when `node` (a ThisKeyword) is the initializer of a destructuring
 *  variable DECLARATION (`const {app} = this`) — round-2/3 handling keeps this
 *  as ESCAPE (reading (a)); the ASSIGNMENT form `({app} = this)` is NOT this
 *  and falls through to UNKNOWN. */
function isDeclDestructureOfThis(outer: ts.Node): boolean {
  const parent = outer.parent
  if (!parent || !ts.isVariableDeclaration(parent) || parent.initializer !== outer) return false
  return ts.isObjectBindingPattern(parent.name) || ts.isArrayBindingPattern(parent.name)
}

/** Preliminary classification of one `ThisKeyword`, before the census consult.
 *  `SITE`/`ESCAPE` are decided by shape alone; `FORCED_UNKNOWN` ([computed] or a
 *  rebound `this`) NEVER consults the census (must never become SAFE);
 *  `SAFE_ELIGIBLE` consults the frozen census once the final key is known. */
type RawKind = 'SITE' | 'ESCAPE' | 'FORCED_UNKNOWN' | 'SAFE_ELIGIBLE'

function classifyThis(
  node: ts.Node,
  source: ts.SourceFile,
  boundToInstance: boolean,
): { shape: string; baseKey: string; kind: RawKind } {
  const outer = outermostWrapperOf(node)
  const p = outer.parent
  const keyOf = (shape: string): string => baseKeyOf(node, source, shape)
  // A `this` rebound by a non-arrow function on the path to the method cannot be
  // proven to be the assembly instance -> UNKNOWN regardless of shape (P2-a).
  if (!boundToInstance) {
    const shape = 'rebound-this'
    return { shape, baseKey: keyOf(shape), kind: 'FORCED_UNKNOWN' }
  }
  if (p && ts.isPropertyAccessExpression(p) && p.expression === outer && p.name.text === 'app') {
    const shape = '.app'
    return { shape, baseKey: keyOf(shape), kind: isRegistrarCallReceiver(p) ? 'SITE' : 'ESCAPE' }
  }
  if (
    p && ts.isElementAccessExpression(p) && p.expression === outer &&
    ts.isStringLiteralLike(p.argumentExpression) && p.argumentExpression.text === 'app'
  ) {
    const shape = "['app']" // element-access this['app'] is escape-only, never an orderable site (round 3)
    return { shape, baseKey: keyOf(shape), kind: 'ESCAPE' }
  }
  if (isDeclDestructureOfThis(outer)) {
    const shape = 'destructure-decl'
    return { shape, baseKey: keyOf(shape), kind: 'ESCAPE' }
  }
  if (p && ts.isPropertyAccessExpression(p) && p.expression === outer) {
    const shape = `.${p.name.text}`
    return { shape, baseKey: keyOf(shape), kind: 'SAFE_ELIGIBLE' }
  }
  if (
    p && ts.isElementAccessExpression(p) && p.expression === outer &&
    ts.isStringLiteralLike(p.argumentExpression)
  ) {
    const shape = `['${p.argumentExpression.text}']`
    return { shape, baseKey: keyOf(shape), kind: 'SAFE_ELIGIBLE' }
  }
  if (p && ts.isElementAccessExpression(p) && p.expression === outer) {
    const shape = '[computed]' // computed member on this: undecidable, fail closed
    return { shape, baseKey: keyOf(shape), kind: 'FORCED_UNKNOWN' }
  }
  const shape = 'bare'
  return { shape, baseKey: keyOf(shape), kind: 'SAFE_ELIGIBLE' }
}

interface FinalOccurrence {
  readonly key: string
  readonly shape: string
  readonly start: number
  readonly kind: RawKind
}

/** Collect EVERY `ThisKeyword` textually inside the `scopeSymbols` subtrees
 *  (no pruning), classify each, and assign a per-base-key source-order
 *  occurrence ordinal so the final key is unique per occurrence yet stable under
 *  unrelated sibling insertion. Shared by `buildThisPartition` and
 *  `deriveSafeCensus` so they can never diverge on domain or key. */
function collectOccurrences(source: ts.SourceFile, scopeSymbols?: ReadonlySet<string>): FinalOccurrence[] {
  const targets = scopeSymbols ? findTargetMethods(source, scopeSymbols) : [source]
  const raw: { shape: string; baseKey: string; kind: RawKind; start: number }[] = []
  for (const target of targets) {
    const boundTarget = scopeSymbols ? target : null
    const collect = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.ThisKeyword) {
        const bound = boundTarget ? thisBindsToTarget(node, boundTarget) : true
        const c = classifyThis(node, source, bound)
        raw.push({ ...c, start: node.getStart(source) })
      }
      node.forEachChild(collect)
    }
    collect(target)
  }
  raw.sort((a, b) => a.start - b.start)
  const seen = new Map<string, number>()
  return raw.map((r) => {
    const n = seen.get(r.baseKey) ?? 0
    seen.set(r.baseKey, n + 1)
    return { key: `${r.baseKey}//#${n}`, shape: r.shape, start: r.start, kind: r.kind }
  })
}

/**
 * Partition every `ThisKeyword` textually inside the `scopeSymbols` method
 * subtrees into {SITE, ESCAPE, SAFE, UNKNOWN}. T is built by an UN-PRUNED walk
 * of those subtrees, so a `this` a bucket rule does not recognise stays in T and
 * lands in UNKNOWN — never dropped. `frozenSafeKeys` is the census of occurrence
 * keys reviewed-and-frozen as SAFE; a safe-eligible `this` whose final key is
 * not in it lands in UNKNOWN. A rebound `this` and a `this[computed]` are forced
 * UNKNOWN and never consult the census.
 */
export function buildThisPartition(
  source: ts.SourceFile,
  frozenSafeKeys: ReadonlySet<string>,
  scopeSymbols?: ReadonlySet<string>,
): ThisPartition {
  const all: ThisOccurrence[] = collectOccurrences(source, scopeSymbols).map((o) => {
    let bucket: ThisBucket
    if (o.kind === 'SITE') bucket = 'SITE'
    else if (o.kind === 'ESCAPE') bucket = 'ESCAPE'
    else if (o.kind === 'FORCED_UNKNOWN') bucket = 'UNKNOWN'
    else bucket = frozenSafeKeys.has(o.key) ? 'SAFE' : 'UNKNOWN'
    return { key: o.key, bucket, shape: o.shape, start: o.start }
  })
  return {
    total: all.length,
    site: all.filter((o) => o.bucket === 'SITE'),
    escape: all.filter((o) => o.bucket === 'ESCAPE'),
    safe: all.filter((o) => o.bucket === 'SAFE'),
    unknown: all.filter((o) => o.bucket === 'UNKNOWN'),
    all,
  }
}

/** The occurrence START positions of every `ThisKeyword` textually inside the
 *  `scopeSymbols` subtrees, computed by an INDEPENDENT un-pruned walk that does
 *  NO bucketing. The test compares this to the partition's node set member-by-
 *  member, so a pruning bug in `buildThisPartition` cannot hide (the old proof
 *  compared the buckets to `part.all` from the SAME builder — a self-proof;
 *  P2-c fix). */
export function independentThisStarts(source: ts.SourceFile, scopeSymbols: ReadonlySet<string>): number[] {
  const targets = findTargetMethods(source, scopeSymbols)
  const starts: number[] = []
  const collect = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.ThisKeyword) starts.push(node.getStart(source))
    node.forEachChild(collect)
  }
  for (const t of targets) collect(t)
  return starts.sort((a, b) => a - b)
}

/** The SAFE-eligible census: final keys of the safe-eligible occurrences (a
 *  one-shot bootstrap the test freezes literally). Forced-UNKNOWN shapes
 *  ([computed], rebound-this) are EXCLUDED — they must never become SAFE even if
 *  a matching key were frozen. Exported so the census lives beside the
 *  partitioner it pins. */
export function deriveSafeCensus(source: ts.SourceFile, scopeSymbols?: ReadonlySet<string>): string[] {
  return collectOccurrences(source, scopeSymbols).filter((o) => o.kind === 'SAFE_ELIGIBLE').map((o) => o.key)
}
