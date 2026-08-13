import * as ts from 'typescript'

/**
 * Gate E (#4844) — DB-free static-AST classifier for "who owns this transaction". #4844 says
 * verbatim: "Enumerating known offenders converges no better here than it did the last two
 * times — the guard has to walk the exported table." This module IS that walk: given a parsed
 * `packages/core-backend/src/attendance/*.ts` file, it finds every EXPORTED function that opens
 * a transaction (`BEGIN` / `START TRANSACTION`) on one of its OWN parameters typed
 * `AttendanceW4TransactionClientV1` — i.e. a connection the CALLER supplied, not one this
 * function acquired itself — and partitions each such site into exactly one of
 * `{OWNS, JOINS, NESTED, UNKNOWN}`, fail-closed: a shape nobody reviewed lands in UNKNOWN.
 *
 * Modelled on the existing F1 assembly guard
 * (`tests/helpers/attendance-w6-index-assembly-order.ts` + its test,
 * `tests/unit/attendance-w6-group-effective-policy-authorization.test.ts`): the same TypeScript
 * compiler AST-walk idiom (never text/regex over the raw file), the same "whitelist the ONE
 * unconditional shape, don't blacklist conditional ancestor kinds" discipline (this module's
 * `isTopLevelStatementOfFunctionBody`, modelled on that file's `classifyUnconditional`), and the
 * same context key discipline: `enclosing-symbol + ancestor-KIND path`, never line/column (those
 * drift on unrelated edits elsewhere in the file).
 *
 * Domain (narrower than F1's "every `this` use"): a `BEGIN`-site is OWNS iff the SAME exported
 * function calls `assertConnectionIsIdleV1(<sameConnectionParam>)` as a genuinely UNCONDITIONAL
 * top-level statement of its OWN body block — i.e. a direct statement of the function's body,
 * not nested inside any `if`/loop/`try`/`switch`/logical-short-circuit — occurring textually
 * BEFORE the `BEGIN` call (which MAY itself be arbitrarily nested, e.g. inside a retry loop's
 * `try` block: only the PROOF must be unconditional, not the `BEGIN` it dominates). This exactly
 * matches both converted first-batch sites ("once before the retry loop"; "before the bare
 * `BEGIN`") and the pre-existing correct sibling
 * (`planAttendanceCalculationRolloutTransitionV1` in w4c3a-rollout-control.ts).
 *
 * Scope boundaries (documented residuals, matching this repo's convention of NAMING what a
 * static walker cannot decide rather than silently guessing):
 *  - The BEGIN/idle-proof detector never crosses into a NESTED function-like boundary (arrow
 *    function, function expression, method, accessor, constructor) — a `.query('BEGIN')` issued
 *    inside a callback passed to `body` (the retry wrapper's own generic parameter) belongs to
 *    the CALLER's closure, not to this function's own transaction-management responsibility, and
 *    is correctly invisible here (it is that OTHER exported function's own site, if any).
 *  - Connection-parameter identity is NAME-based (no `TypeChecker`/symbol resolution) — a local
 *    alias (`const conn = connection`) or destructure would not be recognized as the same
 *    identity. Verified empirically (grep) that no function in `src/attendance/*.ts` does this
 *    today; a future one would surface as a NEW, unmatched `BEGIN` call with a differently-named
 *    receiver, which this walker simply does not collect at all (not silently OWNS) — it is
 *    invisible rather than misclassified, the same trade-off F1's own `argumentsReachIdentifier`
 *    documents for its domain.
 *  - `BEGIN`/`START TRANSACTION` detection only matches a `StringLiteral` or
 *    `NoSubstitutionTemplateLiteral` first argument (`ts.isStringLiteralLike`) — a dynamically
 *    interpolated query string (`TemplateExpression` with substitutions) is undecidable
 *    statically and is not detected as a BEGIN site at all (same invisible-not-misclassified
 *    trade-off). No site in this module's actual surface does this today.
 */

const CONNECTION_TYPE_NAME = 'AttendanceW4TransactionClientV1'
const IDLE_PROOF_CALLEE_NAME = 'assertConnectionIsIdleV1'
const BEGIN_STATEMENT_PATTERN = /^\s*(BEGIN\b|START\s+TRANSACTION\b)/i

export type TxnOwnershipBucket = 'OWNS' | 'JOINS' | 'NESTED' | 'UNKNOWN'

export interface TxnOwnershipAllowlistEntryV1 {
  /** Basename of the file under `src/attendance/`, e.g. `'w4c3b-request-snapshots.ts'`. */
  readonly file: string
  /** The exported function's own name. */
  readonly enclosingFunction: string
  readonly bucket: 'JOINS' | 'NESTED'
  /** Required, reviewed justification — never optional. A function that legitimately runs
   *  inside the caller's already-open transaction (JOINS), or that opens its own NAMED,
   *  released savepoint nested inside the caller's transaction (NESTED), belongs here with the
   *  reviewer's reasoning, not silently inferred by the walker. */
  readonly reason: string
}

/**
 * Gate E (#4844) first-batch allowlist. EMPTY BY DESIGN: a full sweep of
 * `packages/core-backend/src/attendance/*.ts` (the guard test's own discovery) finds exactly
 * three `BEGIN`-on-caller-connection sites total, and all three are category-1 (OWNS) — the two
 * converted this batch plus the one sibling (`planAttendanceCalculationRolloutTransitionV1`)
 * that already did this correctly (W4C-5 NEW-B / PR #4839). Any FUTURE JOINS/NESTED site must be
 * added here, reviewed, with a `reason` — it must never be inferred by the walker itself, and an
 * un-added new BEGIN site lands in UNKNOWN and reds the guard, exactly as designed.
 */
export const TXN_OWNERSHIP_ALLOWLIST_V1: readonly TxnOwnershipAllowlistEntryV1[] = []

export interface BeginSiteV1 {
  /** `enclosing-function // ancestor-KIND-path // BEGIN // #occurrence-ordinal` — stable under
   *  unrelated edits elsewhere in the same function; changes only if this SITE itself moves to a
   *  different syntactic context. NEVER line/column. */
  readonly key: string
  readonly file: string
  readonly enclosingFunction: string
  readonly connParamName: string
  /** The literal BEGIN statement text, e.g. `'BEGIN ISOLATION LEVEL SERIALIZABLE'`. */
  readonly statementText: string
  readonly bucket: TxnOwnershipBucket
  readonly reason?: string
  /** Diagnostic only — never asserted on by key/identity, only used to order/dedupe within one
   *  file during collection. */
  readonly start: number
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false
  const mods = ts.getModifiers(node)
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

/** Every top-level `export function` / `export async function` declaration in the file — the
 *  "whole exported surface" this guard walks. Deliberately top-level-statements only: nothing in
 *  this codebase's `src/attendance/*.ts` exports a function any other way (verified: zero
 *  `export const x = (...) => ...` arrow exports across the directory), and a TypeScript
 *  namespace/module-nested export is not a shape this directory uses either. */
function exportedFunctionDeclarations(source: ts.SourceFile): ts.FunctionDeclaration[] {
  const out: ts.FunctionDeclaration[] = []
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body && hasExportModifier(stmt)) {
      out.push(stmt)
    }
  }
  return out
}

/** Parameters of `fn` typed exactly `AttendanceW4TransactionClientV1` (a plain `TypeReference` by
 *  name — no aliasing/renaming import exists anywhere in this directory today, verified by
 *  grep). These are the "caller-supplied connection" identities this guard reasons about. */
function connectionParams(fn: ts.FunctionDeclaration): ts.ParameterDeclaration[] {
  return fn.parameters.filter((p) => {
    const t = p.type
    return !!t && ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === CONNECTION_TYPE_NAME
  })
}

function paramName(p: ts.ParameterDeclaration): string | null {
  return ts.isIdentifier(p.name) ? p.name.text : null
}

/** A rebinding/closure boundary this walk does not cross — see the module docblock's first
 *  residual note. */
function isFunctionLikeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  )
}

interface RawCall {
  readonly node: ts.CallExpression
  readonly start: number
}

/** Every `CallExpression` in `fn`'s OWN scope (its body, recursing through control-flow
 *  constructs but never into a nested function-like) matching `predicate`, in source order. */
function collectOwnScopeCalls(
  fn: ts.FunctionDeclaration,
  predicate: (call: ts.CallExpression) => boolean,
): RawCall[] {
  const out: RawCall[] = []
  const visit = (node: ts.Node, isRoot: boolean): void => {
    if (!isRoot && isFunctionLikeBoundary(node)) return
    if (ts.isCallExpression(node) && predicate(node)) {
      out.push({ node, start: node.getStart() })
    }
    node.forEachChild((child) => visit(child, false))
  }
  if (fn.body) visit(fn.body, true)
  out.sort((a, b) => a.start - b.start)
  return out
}

/** `<connName>.query(<string-literal-like matching BEGIN|START TRANSACTION>, ...)` — the
 *  transaction-opening statement shape this guard targets. Returns the literal statement text on
 *  a match, `null` otherwise (including the "undecidable" cases named in the module docblock). */
function matchBeginCall(call: ts.CallExpression, connName: string): string | null {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  if (callee.name.text !== 'query') return null
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== connName) return null
  const arg0 = call.arguments[0]
  if (!arg0 || !ts.isStringLiteralLike(arg0)) return null
  return BEGIN_STATEMENT_PATTERN.test(arg0.text) ? arg0.text : null
}

/** `assertConnectionIsIdleV1(<connName>)` — bare identifier callee, bare identifier first
 *  argument matching the SAME connection identity by name. */
function isIdleProofCallOnConn(call: ts.CallExpression, connName: string): boolean {
  const callee = call.expression
  if (!ts.isIdentifier(callee) || callee.text !== IDLE_PROOF_CALLEE_NAME) return false
  const arg0 = call.arguments[0]
  return !!arg0 && ts.isIdentifier(arg0) && arg0.text === connName
}

/**
 * WHITELIST (not blacklist) of the one unconditional shape, modelled directly on the F1 guard's
 * `classifyUnconditional`: `node` (after unwrapping at most one enclosing `await`) must be the
 * whole expression of a bare `ExpressionStatement` that is ITSELF a direct statement of `fn`'s
 * own body `Block` — zero hops. A call inside an `if`/loop/`try`/`catch`/short-circuit does NOT
 * qualify, even if it happens to run before the `BEGIN` on every path THIS version of the code
 * takes — that requires case-by-case reasoning this guard deliberately declines to do; such a
 * shape is exactly what the JOINS/NESTED allowlist (with a reviewed `reason`) exists for.
 */
function isTopLevelStatementOfFunctionBody(fn: ts.FunctionDeclaration, call: ts.CallExpression): boolean {
  let expr: ts.Node = call
  const parent: ts.Node | undefined = expr.parent
  if (parent && ts.isAwaitExpression(parent) && parent.expression === expr) {
    expr = parent
  }
  const stmt = expr.parent
  if (!stmt || !ts.isExpressionStatement(stmt) || stmt.expression !== expr) return false
  const body = stmt.parent
  return !!body && ts.isBlock(body) && body === fn.body
}

/** Ancestor-KIND path from (excluding) `fn` down to (including) `node`, root-to-node order.
 *  NEVER line/column — see the module docblock. Matches F1's `baseKeyOf` idiom exactly. */
function ancestorKindPath(fn: ts.FunctionDeclaration, node: ts.Node): string {
  const kinds: string[] = []
  let current: ts.Node = node
  while (current.parent && current.parent !== fn) {
    current = current.parent
    kinds.push(ts.SyntaxKind[current.kind])
  }
  kinds.reverse()
  return kinds.join('>')
}

/**
 * Walk the WHOLE exported surface of one already-parsed source file and partition every
 * BEGIN-on-caller-connection site into `{OWNS, JOINS, NESTED, UNKNOWN}`. `fileLabel` is the
 * basename used both for allowlist matching and for the returned sites' `file`/`key` fields — the
 * caller (the guard test) owns filesystem access; this function is pure and DB-free.
 */
export function discoverBeginSitesV1(
  source: ts.SourceFile,
  fileLabel: string,
  allowlist: readonly TxnOwnershipAllowlistEntryV1[] = TXN_OWNERSHIP_ALLOWLIST_V1,
): BeginSiteV1[] {
  const out: BeginSiteV1[] = []
  const keyOrdinal = new Map<string, number>()

  for (const fn of exportedFunctionDeclarations(source)) {
    const fnName = fn.name!.text
    for (const param of connectionParams(fn)) {
      const connName = paramName(param)
      if (!connName) continue

      const beginCalls = collectOwnScopeCalls(fn, (c) => matchBeginCall(c, connName) !== null)
      if (beginCalls.length === 0) continue

      const dominatingIdleStarts = collectOwnScopeCalls(fn, (c) => isIdleProofCallOnConn(c, connName))
        .filter((c) => isTopLevelStatementOfFunctionBody(fn, c.node))
        .map((c) => c.start)

      for (const { node: beginNode, start } of beginCalls) {
        const statementText = matchBeginCall(beginNode, connName)!
        const dominated = dominatingIdleStarts.some((idleStart) => idleStart < start)

        const baseKey = `${fnName}//${ancestorKindPath(fn, beginNode)}//BEGIN`
        const ordinal = keyOrdinal.get(baseKey) ?? 0
        keyOrdinal.set(baseKey, ordinal + 1)
        const key = `${baseKey}//#${ordinal}`

        let bucket: TxnOwnershipBucket
        let reason: string | undefined
        if (dominated) {
          bucket = 'OWNS'
        } else {
          const allow = allowlist.find((a) => a.file === fileLabel && a.enclosingFunction === fnName)
          if (allow) {
            bucket = allow.bucket
            reason = allow.reason
          } else {
            bucket = 'UNKNOWN'
          }
        }

        out.push({
          key,
          file: fileLabel,
          enclosingFunction: fnName,
          connParamName: connName,
          statementText,
          bucket,
          reason,
          start,
        })
      }
    }
  }

  return out
}
