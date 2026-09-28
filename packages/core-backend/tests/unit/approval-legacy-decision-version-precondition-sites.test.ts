import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import ts from 'typescript'

/**
 * Merge-train dry run v3b §5.2.1, action 3 — a STATIC guard on the `expectedVersion` rider.
 *
 * `ApprovalActionRequest.expectedVersion` is the optional optimistic-lock precondition
 * `ApprovalProductService.dispatchAction` re-checks under its own row lock. Today it is SET by
 * exactly two call sites — the legacy `POST /api/approvals/:id/approve` and `/:id/reject` doors —
 * and both doors refuse a cancel-round instance (`rejectIfCancelRound`) BEFORE they dispatch, so
 * the version precondition and the cancel-round action gate inside `dispatchAction` do not both
 * fire on one call under today's two write points. The relative order of those two checks
 * (owner-named: version gate first) is therefore observationally inert today, and this file is
 * what keeps that a TESTED property rather than a coincidence, within the caliber stated below:
 * it goes red when —
 *
 *   1. a third `expectedVersion` write point OF THE CENSUSED KIND appears in any `dispatchAction`
 *      call under `packages/core-backend/src` — in particular inside the `/actions` handler or the
 *      DingTalk card wrapper (`services/ApprovalCardDeliveryAction.ts`), neither of which carries a
 *      `rejectIfCancelRound` — or
 *   2. `rejectIfCancelRound` is removed from, or moved behind the dispatch in, either legacy door.
 *
 * It also pins the two owner-named orders statically, as a complement to the real-DB legs:
 * F4 (i) — in each legacy door the seat gate precedes the cancel-round outlet guard; F4 (ii) — in
 * `dispatchAction` the version precondition precedes the cancel-round action gate, and both follow
 * the attendance fail-closed guard.
 *
 * CALIBER OF THE WRITE-POINT CENSUS (stated so nobody reads more into a green run):
 *
 *   Population — discovered, not listed. Every `.ts` file under `packages/core-backend/src` is
 *   parsed with the TypeScript compiler API, and every call whose callee is a property access named
 *   `dispatchAction` (`x.dispatchAction(...)`) or an element access on the string literal
 *   `'dispatchAction'` (`x['dispatchAction'](...)`) is a censused call, whatever the receiver. In
 *   the routes file the shared settlement helper `settleLegacyDecisionThroughSharedPath(...)` is a
 *   censused call too: its `precondition` argument IS the door's write point (the helper forwards
 *   `precondition.expectedVersion` into its own dispatch). The population is self-checked: the
 *   discovered caller files and call sites are printed and asserted against a LOWER BOUND (today's
 *   reading), and the three caller files known today must be among them — a new caller is pulled
 *   INTO the census rather than left outside it, and a scanner that finds nothing is red.
 *
 *   Property — the `expectedVersion` property of an OBJECT LITERAL that a censused call passes as
 *   its request argument (or as any other argument that is itself an inline object literal),
 *   resolved in the SAME file by initializer alone. A property counts whatever its spelling —
 *   `expectedVersion: x`, the shorthand `expectedVersion,`, the string key `'expectedVersion': x`,
 *   the computed key `['expectedVersion']: x`, or a method/accessor of that name. A spread is
 *   followed only where it resolves to object literals: an inline literal, a conditional / `&&` /
 *   `||` / `??` over such, or an identifier whose `const`/`let`/`var` INITIALIZER is one of those
 *   in an enclosing scope of the same file. A request argument or spread that does not resolve this
 *   way (a call result, a member access, an imported or parameter-bound name, a computed key that
 *   is not a string literal) is REPORTED as undetermined — the negative control asserts zero of
 *   them today — unless it is registered by name in `ACCEPTED_UNRESOLVED_SPREADS` with a reason
 *   (empty today).
 *
 *   Second net, routes file only: every other identifier / string-literal mention of
 *   `expectedVersion` in `routes/approvals.ts` must be one of the helper's two known sites (its
 *   parameter type member and its `precondition.expectedVersion` read); a stray declaration or a
 *   `request.expectedVersion = ...` there is red on the mention alone. The net is not applied to
 *   the other files, which legitimately mention the rider (its type declaration, the service's read).
 *
 *   OUT OF CALIBER — not seen by this file; code review owns them: a value written to an identifier
 *   AFTER its declaration (`let r = {}; r = build(req)`, `Object.assign(r, build(req))`,
 *   `r['expected' + 'Version'] = v`), a key assembled at runtime, a callee reached other than by the
 *   literal member name (`x[name](...)`), and an object built in ANOTHER file and passed in. The
 *   census resolves initializers, not data flow; it is a static census of a stated population and a
 *   stated property, and a green run means exactly that. Comments are not nodes, so a docblock that
 *   mentions the rider never counts.
 *
 *   The order checks below are a plain source census on comment-stripped text (comment-only lines
 *   are blanked, offsets preserved), because they pin the relative position of three statements,
 *   not a property name.
 */
const backendRoot = path.resolve(__dirname, '..', '..')
const srcRoot = path.join(backendRoot, 'src')

/** Files are named relative to `src`, POSIX-style, everywhere below. */
const ROUTES_FILE = 'routes/approvals.ts'
const SERVICE_FILE = 'services/ApprovalProductService.ts'
const CARD_WRAPPER_FILE = 'services/ApprovalCardDeliveryAction.ts'
const AFTER_SALES_BRIDGE_FILE = 'services/AfterSalesApprovalBridgeService.ts'

/**
 * Population self-check inputs. `KNOWN_CALLER_FILES` are the files that carry a censused call
 * today; `POPULATION_FLOOR` is today's reading written as a LOWER BOUND, so a new caller can only
 * raise the counts (and is censused), never drop below them. The reading itself is recorded in
 * the stack's verification MD; this file carries the bound only.
 */
const KNOWN_CALLER_FILES = [ROUTES_FILE, CARD_WRAPPER_FILE, AFTER_SALES_BRIDGE_FILE] as const
const POPULATION_FLOOR = { callerFiles: 3, dispatchActionCalls: 5, helperCalls: 2 } as const
/** Sanity floor on the scanned tree (a lister pointed at an empty or wrong directory is red). Not a reading. */
const SCANNED_FILES_SANITY_FLOOR = 500

/**
 * The entries whose request object carries the rider, and which argument is that request.
 *   - `<any receiver>.dispatchAction(id, request, actor)` / `<any receiver>['dispatchAction'](...)`
 *     — the service entry itself, matched on the member name so every receiver (`productService`,
 *     `bridgeService`, `deps.approvals`, `this.approvalBridge`, a renamed local) is censused.
 *   - `settleLegacyDecisionThroughSharedPath(productService, id, action, comment, actor,
 *     precondition)` — the shared settlement helper; its `precondition` object IS the door's write
 *     point (the helper forwards `precondition.expectedVersion` into its own dispatch).
 */
const RIDER_ENTRIES = [
  { kind: 'member', name: 'dispatchAction', requestArg: 1 },
  { kind: 'function', name: 'settleLegacyDecisionThroughSharedPath', requestArg: 5 },
] as const
type RiderEntry = (typeof RIDER_ENTRIES)[number]

/**
 * Spreads the census cannot resolve statically that are ACCEPTED by name. EMPTY today: every spread
 * in a censused request is an inline conditional over object literals, so nothing needs registering.
 * Adding an entry needs its `reason` — a spread of a helper's return value hides the rider's keys
 * from this file, which is precisely what the undetermined report exists to surface.
 */
const ACCEPTED_UNRESOLVED_SPREADS: ReadonlyArray<{ file: string; entry: string; spreadText: string; reason: string }> = []

const HELPER_NAME = 'settleLegacyDecisionThroughSharedPath'
const RIDER = 'expectedVersion'

type Spelling = 'identifier' | 'shorthand' | 'string' | 'computed' | 'method'
type RiderWrite = { file: string; entry: string; handler: string | null; fn: string | null; line: number; spelling: Spelling; via: string[]; valueText: string }
type Undetermined = { file: string; entry: string; handler: string | null; line: number; why: string; text: string }
type Mention = { file: string; line: number; text: string; kind: string }
type RiderCall = { file: string; entry: string; receiver: string | null; handler: string | null; fn: string | null; line: number }
type Census = { calls: RiderCall[]; writes: RiderWrite[]; undetermined: Undetermined[]; unclassifiedMentions: Mention[] }

function parse(source: string, fileName = 'file.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function lineOfNode(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) {
      e = e.expression
      continue
    }
    return e
  }
}

const ROUTE_VERBS = new Set(['post', 'get', 'put', 'patch', 'delete'])

/** `VERB /path` of the route registration enclosing `node`, or null when it sits outside every handler. */
function enclosingRoute(node: ts.Node): string | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (!ts.isCallExpression(p)) continue
    const callee = p.expression
    if (!ts.isPropertyAccessExpression(callee) || !ROUTE_VERBS.has(callee.name.text)) continue
    const first = p.arguments[0]
    if (!first || !ts.isStringLiteral(first) || !first.text.startsWith('/')) continue
    return `${callee.name.text.toUpperCase()} ${first.text}`
  }
  return null
}

/** Name of the nearest enclosing function declaration/expression, for "is this inside the helper?" */
function enclosingFunctionName(node: ts.Node): string | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text
    if ((ts.isFunctionExpression(p) || ts.isArrowFunction(p)) && p.parent && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text
  }
  return null
}

/**
 * Same-file, lexically nearest `const/let/var <name> = <initializer>` above `from`; null when none
 * (or when the name is a parameter). Initializer only: a value written to the name AFTER its
 * declaration is out of caliber (see the file header).
 */
function resolveIdentifierInitializer(from: ts.Node, name: string): ts.Expression | null {
  for (let p: ts.Node | undefined = from.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p) && p.parameters.some((param) => ts.isIdentifier(param.name) && param.name.text === name)) return null
    const statements: ts.NodeArray<ts.Statement> | null = ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p) ? p.statements : null
    if (!statements) continue
    for (const st of statements) {
      if (!ts.isVariableStatement(st)) continue
      for (const decl of st.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl.initializer ?? null
      }
    }
  }
  return null
}

function propertyName(name: ts.PropertyName): { text: string; spelling: Spelling } | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return { text: name.text, spelling: 'identifier' }
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return { text: name.text, spelling: 'string' }
  if (ts.isNumericLiteral(name)) return { text: name.text, spelling: 'string' }
  if (ts.isComputedPropertyName(name)) {
    const e = unwrap(name.expression)
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { text: e.text, spelling: 'computed' }
    return null
  }
  return null
}

/** The rider entry a call's callee names, if any: `x.dispatchAction`, `x['dispatchAction']`, or the helper by identifier. */
function riderEntryOf(callee: ts.LeftHandSideExpression, sf: ts.SourceFile): { entry: RiderEntry; receiver: string | null } | null {
  if (ts.isPropertyAccessExpression(callee)) {
    const entry = RIDER_ENTRIES.find((r) => r.kind === 'member' && r.name === callee.name.text)
    return entry ? { entry, receiver: callee.expression.getText(sf) } : null
  }
  if (ts.isElementAccessExpression(callee)) {
    const arg = unwrap(callee.argumentExpression)
    if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) return null
    const entry = RIDER_ENTRIES.find((r) => r.kind === 'member' && r.name === arg.text)
    return entry ? { entry, receiver: callee.expression.getText(sf) } : null
  }
  if (ts.isIdentifier(callee)) {
    const entry = RIDER_ENTRIES.find((r) => r.kind === 'function' && r.name === callee.text)
    return entry ? { entry, receiver: null } : null
  }
  return null
}

function emptyCensus(): Census {
  return { calls: [], writes: [], undetermined: [], unclassifiedMentions: [] }
}

/** The write-point census of ONE file (`file` is its `src`-relative name). The mention net runs on the routes file only. */
function censusFile(source: string, file: string): Census {
  const sf = parse(source, file)
  const census = emptyCensus()
  /** Name nodes of censused `expectedVersion` properties, so the mention closure can recognise them. */
  const censusedNameNodes = new Set<ts.Node>()

  function walkObject(obj: ts.ObjectLiteralExpression, entry: string, handler: string | null, fn: string | null, via: string[], seen: Set<string>) {
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        resolveSpread(prop.expression, entry, handler, fn, [...via, prop.getText(sf)], seen)
        continue
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (prop.name.text === RIDER) {
          censusedNameNodes.add(prop.name)
          census.writes.push({ file, entry, handler, fn, line: lineOfNode(sf, prop), spelling: 'shorthand', via, valueText: prop.name.text })
        }
        continue
      }
      const named = propertyName(prop.name)
      if (!named) {
        census.undetermined.push({ file, entry, handler, line: lineOfNode(sf, prop), why: 'computed property name is not a string literal', text: prop.getText(sf) })
        continue
      }
      if (named.text !== RIDER) continue
      censusedNameNodes.add(ts.isComputedPropertyName(prop.name) ? unwrap(prop.name.expression) : prop.name)
      if (ts.isPropertyAssignment(prop)) {
        census.writes.push({ file, entry, handler, fn, line: lineOfNode(sf, prop), spelling: named.spelling, via, valueText: prop.initializer.getText(sf) })
      } else {
        // method / get / set accessor named `expectedVersion`
        census.writes.push({ file, entry, handler, fn, line: lineOfNode(sf, prop), spelling: 'method', via, valueText: prop.getText(sf).slice(0, 40) })
      }
    }
  }

  function resolveSpread(expr: ts.Expression, entry: string, handler: string | null, fn: string | null, via: string[], seen: Set<string>) {
    const e = unwrap(expr)
    if (ts.isObjectLiteralExpression(e)) return walkObject(e, entry, handler, fn, via, seen)
    if (ts.isConditionalExpression(e)) {
      resolveSpread(e.whenTrue, entry, handler, fn, via, seen)
      resolveSpread(e.whenFalse, entry, handler, fn, via, seen)
      return
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return resolveSpread(e.right, entry, handler, fn, via, seen)
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        resolveSpread(e.left, entry, handler, fn, via, seen)
        resolveSpread(e.right, entry, handler, fn, via, seen)
        return
      }
    }
    if (ts.isIdentifier(e) && !seen.has(e.text)) {
      const init = resolveIdentifierInitializer(e, e.text)
      if (init) return resolveSpread(init, entry, handler, fn, [...via, `${e.text} = ${init.getText(sf).slice(0, 60)}`], new Set([...seen, e.text]))
    }
    const text = expr.getText(sf)
    if (ACCEPTED_UNRESOLVED_SPREADS.some((a) => a.file === file && a.entry === entry && a.spreadText === text)) return
    census.undetermined.push({ file, entry, handler, line: lineOfNode(sf, expr), why: 'spread / request source is not statically resolvable in this file', text })
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const hit = riderEntryOf(node.expression, sf)
      if (hit) {
        const { entry, receiver } = hit
        const handler = enclosingRoute(node)
        const fn = enclosingFunctionName(node)
        census.calls.push({ file, entry: entry.name, receiver, handler, fn, line: lineOfNode(sf, node) })
        const request = node.arguments[entry.requestArg]
        if (!request) {
          census.undetermined.push({ file, entry: entry.name, handler, line: lineOfNode(sf, node), why: `request argument #${entry.requestArg} is missing`, text: node.getText(sf).slice(0, 80) })
        } else {
          // The request argument is walked and reported when it does not resolve; every OTHER
          // argument is walked only when it is itself an inline object literal.
          resolveSpread(request, entry.name, handler, fn, [], new Set())
          node.arguments.forEach((arg, i) => {
            if (i === entry.requestArg) return
            const e = unwrap(arg)
            if (ts.isObjectLiteralExpression(e)) walkObject(e, entry.name, handler, fn, [`arg#${i}`], new Set())
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (file !== ROUTES_FILE) return census

  // Mention closure (routes file only): every other `expectedVersion` identifier / string literal.
  function classifyMention(node: ts.Node): string | null {
    if (censusedNameNodes.has(node)) return null
    const parent = node.parent
    if (parent && ts.isPropertySignature(parent) && parent.name === node && enclosingFunctionName(node) === HELPER_NAME) return null
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node && parent.expression.getText(sf) === 'precondition' && enclosingFunctionName(node) === HELPER_NAME) return null
    if (parent && ts.isPropertySignature(parent)) return 'type member outside the settlement helper'
    if (parent && ts.isPropertyAccessExpression(parent)) return `member access \`${parent.getText(sf)}\``
    if (parent && ts.isVariableDeclaration(parent)) return 'variable declaration'
    if (parent && ts.isBindingElement(parent)) return 'destructuring binding'
    if (parent && ts.isParameter(parent)) return 'parameter'
    if (parent && (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent))) return 'object property outside every rider entry'
    return `${ts.SyntaxKind[parent?.kind ?? 0]}`
  }
  function visitMentions(node: ts.Node) {
    const isName = (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === RIDER
    if (isName) {
      const kind = classifyMention(node)
      if (kind) census.unclassifiedMentions.push({ file, line: lineOfNode(sf, node), text: node.parent ? node.parent.getText(sf).split('\n')[0].slice(0, 100) : node.getText(sf), kind })
    }
    ts.forEachChild(node, visitMentions)
  }
  visitMentions(sf)
  return census
}

// ---------------------------------------------------------------------------------------------
// Population: every `.ts` under `src`, discovered by listing the tree, censused file by file.

function listSourceFiles(dir: string = srcRoot, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) listSourceFiles(p, out)
    else if (entry.isFile() && p.endsWith('.ts')) out.push(p)
  }
  return out.sort()
}

function relFile(abs: string): string {
  return path.relative(srcRoot, abs).split(path.sep).join('/')
}

const sourceCache = new Map<string, string>()
function readSource(abs: string): string {
  let s = sourceCache.get(abs)
  if (s === undefined) {
    s = readFileSync(abs, 'utf8')
    sourceCache.set(abs, s)
  }
  return s
}

type Tree = { scannedFiles: number; census: Census }

/** Memo of the per-file census keyed by file, valid while the source text is unchanged (controls override one file at a time). */
const fileCensusMemo = new Map<string, { source: string; census: Census }>()

/**
 * The census of the whole population. `override` substitutes one file's text IN PLACE — a file that
 * the listing does not reach is not censused, override or not, which is what makes the population
 * controls below honest about the population and not only about the property.
 */
function censusTree(override?: { file: string; source: string }): Tree {
  const census = emptyCensus()
  let scannedFiles = 0
  for (const abs of listSourceFiles()) {
    const file = relFile(abs)
    scannedFiles += 1
    const source = override && override.file === file ? override.source : readSource(abs)
    const memo = fileCensusMemo.get(file)
    let c: Census
    if (memo && memo.source === source) c = memo.census
    else {
      c = censusFile(source, file)
      fileCensusMemo.set(file, { source, census: c })
    }
    census.calls.push(...c.calls)
    census.writes.push(...c.writes)
    census.undetermined.push(...c.undetermined)
    census.unclassifiedMentions.push(...c.unclassifiedMentions)
  }
  return { scannedFiles, census }
}

function absPath(file: string): string {
  return path.join(srcRoot, ...file.split('/'))
}

// ---------------------------------------------------------------------------------------------
// Order checks: plain source census on comment-stripped text.

type Span = { name: string; start: number; end: number }

function stripCommentLines(source: string): string {
  // Blank every comment-only line (same length, spaces) so character offsets and line numbers stay
  // aligned with the original file: spans computed on one text are valid on the other.
  return source
    .split('\n')
    .map((line) => {
      const t = line.trimStart()
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? ' '.repeat(line.length) : line
    })
    .join('\n')
}

/** Handler spans: from each top-level `  r.<verb>(` registration to the next one (or EOF). */
function routeHandlerSpans(code: string): Span[] {
  const re = /\n {2}r\.(post|get|put|patch|delete)\(\s*'([^']+)'/g
  const starts: Array<{ name: string; index: number }> = []
  for (let m = re.exec(code); m; m = re.exec(code)) starts.push({ name: `${m[1].toUpperCase()} ${m[2]}`, index: m.index })
  return starts.map((s, i) => ({ name: s.name, start: s.index, end: i + 1 < starts.length ? starts[i + 1].index : code.length }))
}

function occurrences(code: string, needle: string, from = 0, to = code.length): number[] {
  const out: number[] = []
  let i = code.indexOf(needle, from)
  while (i !== -1 && i < to) {
    out.push(i)
    i = code.indexOf(needle, i + needle.length)
  }
  return out
}

function lineOfOffset(code: string, offset: number): number {
  return code.slice(0, offset).split('\n').length
}

// ---------------------------------------------------------------------------------------------
// In-memory positive controls: splice a third write point into a real `dispatchAction` request
// (the `/actions` handler's, the card wrapper's, the after-sales bridge's) and run the SAME census
// on the result. The call is located independently of the census's own callee matcher.

const ACTIONS_ROUTE = 'POST /api/approvals/:id/actions'
const APPROVE_ROUTE = 'POST /api/approvals/:id/approve'
const REJECT_ROUTE = 'POST /api/approvals/:id/reject'

type DispatchLocator = { receiver: string; route: string | null }

/** Is `callee` the member `dispatchAction` on `receiver`, written as `receiver.dispatchAction` or `receiver['dispatchAction']`? (Independent of `riderEntryOf`.) */
function isDispatchCalleeOn(callee: ts.LeftHandSideExpression, receiver: string, sf: ts.SourceFile): callee is ts.PropertyAccessExpression | ts.ElementAccessExpression {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'dispatchAction' && callee.expression.getText(sf) === receiver
  if (ts.isElementAccessExpression(callee)) {
    const arg = callee.argumentExpression
    return ts.isStringLiteral(arg) && arg.text === 'dispatchAction' && callee.expression.getText(sf) === receiver
  }
  return false
}

function locateDispatchCall(sf: ts.SourceFile, where: DispatchLocator): ts.CallExpression {
  let target: ts.CallExpression | undefined
  const find = (node: ts.Node) => {
    if (!target && ts.isCallExpression(node) && isDispatchCalleeOn(node.expression, where.receiver, sf) && enclosingRoute(node) === where.route) target = node
    ts.forEachChild(node, find)
  }
  find(sf)
  if (!target) throw new Error(`control: ${where.receiver}.dispatchAction call not found in ${where.route ?? 'the file'}`)
  return target
}

/**
 * Splice `firstProperty` as the first property of the located call's request object literal
 * (through an `as` cast when there is one), optionally a statement before the enclosing statement,
 * and optionally rewrite the callee to the element-access form `receiver['dispatchAction']`.
 */
function spliceIntoDispatch(source: string, where: DispatchLocator, edit: { statementBefore?: string; firstProperty: string; elementAccessCallee?: boolean }): string {
  const sf = parse(source)
  const target = locateDispatchCall(sf, where)
  const request = target.arguments[1] ? unwrap(target.arguments[1]) : undefined
  if (!request || !ts.isObjectLiteralExpression(request)) throw new Error(`control: ${where.receiver}.dispatchAction request is not an object literal`)
  let statement: ts.Node = target
  while (statement.parent && !ts.isExpressionStatement(statement) && !ts.isVariableStatement(statement)) statement = statement.parent
  const callee = target.expression as ts.PropertyAccessExpression | ts.ElementAccessExpression
  const braceEnd = request.getStart(sf) + 1
  const memberStart = callee.expression.getEnd() // the `.dispatchAction` / `['dispatchAction']` text runs from here to the callee's end
  const memberEnd = callee.getEnd()
  const stmtStart = statement.getStart(sf)
  // Later offsets first so the earlier ones stay valid.
  let out = source.slice(0, braceEnd) + '\n' + edit.firstProperty + source.slice(braceEnd)
  if (edit.elementAccessCallee) out = out.slice(0, memberStart) + "['dispatchAction']" + out.slice(memberEnd)
  if (edit.statementBefore) out = out.slice(0, stmtStart) + edit.statementBefore + '\n' + out.slice(stmtStart)
  return out
}

/** Identifier mentions of `name` inside the given route handler, so a control's own local cannot be shadowed by a real one. */
function identifierMentionsInRoute(sf: ts.SourceFile, name: string, route: string): number {
  let n = 0
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === name && enclosingRoute(node) === route) n += 1
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return n
}

/** The write points this guard ALLOWS: the two doors' precondition objects and the helper's one forwarding site, all in the routes file. */
function isAllowedWrite(w: RiderWrite): boolean {
  if (w.file !== ROUTES_FILE) return false
  if (w.handler === APPROVE_ROUTE || w.handler === REJECT_ROUTE) return w.entry === HELPER_NAME && w.valueText === 'requestedVersion' && w.via.length === 0
  return w.handler === null && w.fn === HELPER_NAME && w.entry === 'dispatchAction' && w.valueText === 'precondition.expectedVersion'
}

describe('v3b action 3 — `expectedVersion` is written by exactly the two legacy decision doors, and each door refuses a cancel-round instance before it dispatches', () => {
  const routesSource = readSource(absPath(ROUTES_FILE))
  const routes = stripCommentLines(routesSource)
  const spans = routeHandlerSpans(routes)
  const approve = spans.find((s) => s.name === APPROVE_ROUTE)
  const reject = spans.find((s) => s.name === REJECT_ROUTE)
  const actions = spans.find((s) => s.name === ACTIONS_ROUTE)
  const tree = censusTree()
  const census = tree.census
  const dispatchCalls = census.calls.filter((c) => c.entry === 'dispatchAction')
  const helperCalls = census.calls.filter((c) => c.entry === HELPER_NAME)
  const callerFiles = [...new Set(census.calls.map((c) => c.file))].sort()

  it('the three legacy-decision handlers are located (self-check: a renamed route must not silently vacate this guard)', () => {
    expect(approve, 'legacy /approve handler').toBeTruthy()
    expect(reject, 'legacy /reject handler').toBeTruthy()
    expect(actions, '/actions handler').toBeTruthy()
    expect(spans.length).toBeGreaterThan(10)
    // The AST census saw the same three handlers, and at least one rider-entry call in each.
    for (const route of [APPROVE_ROUTE, REJECT_ROUTE, ACTIONS_ROUTE]) {
      expect(census.calls.filter((c) => c.file === ROUTES_FILE && c.handler === route).length, `rider-entry calls inside ${route}`).toBeGreaterThanOrEqual(1)
    }
  })

  it('POPULATION (self-check): every .ts under src is scanned; the censused callers are printed and are at least today\'s reading; the three callers known today are among them', () => {
    const sites = census.calls.map((c) => `${c.file}:${c.line} ${c.entry === HELPER_NAME ? HELPER_NAME : `${c.receiver}.dispatchAction`}${c.handler ? ` [${c.handler}]` : ''}`)
    const population = { scannedFiles: tree.scannedFiles, callerFiles, dispatchActionCalls: dispatchCalls.length, helperCalls: helperCalls.length, sites }
    // Printed on every run so the reading is visible in the log, not only on failure.
    console.log(`[v3b action 3] population ${JSON.stringify(population)}`)
    expect(tree.scannedFiles, 'scanned .ts files under src (lister sanity)').toBeGreaterThanOrEqual(SCANNED_FILES_SANITY_FLOOR)
    for (const known of KNOWN_CALLER_FILES) expect(callerFiles, `known caller ${known} is in the discovered population`).toContain(known)
    expect(callerFiles.length, `caller files (lower bound ${POPULATION_FLOOR.callerFiles}): ${callerFiles.join(', ')}`).toBeGreaterThanOrEqual(POPULATION_FLOOR.callerFiles)
    expect(dispatchCalls.length, `dispatchAction call sites (lower bound ${POPULATION_FLOOR.dispatchActionCalls}): ${sites.join('; ')}`).toBeGreaterThanOrEqual(POPULATION_FLOOR.dispatchActionCalls)
    expect(helperCalls.length, `${HELPER_NAME} call sites (lower bound ${POPULATION_FLOOR.helperCalls})`).toBeGreaterThanOrEqual(POPULATION_FLOOR.helperCalls)
    // The helper is a routes-file construct; a copy of it elsewhere would be a second settlement path.
    expect(helperCalls.every((c) => c.file === ROUTES_FILE), 'helper calls are all in the routes file').toBe(true)
  })

  it('WRITE POINTS (negative control on the real tree): exactly two, one inside each legacy door, spelled any way; none in any other caller; zero undetermined; every other mention of the rider in the routes file is the helper\'s own', () => {
    const inHandlers = census.writes.filter((w) => w.handler !== null)
    const outside = census.writes.filter((w) => w.handler === null)
    expect(census.undetermined, 'undetermined write points (unresolvable spread / non-literal request) anywhere in the population').toEqual([])
    expect(census.unclassifiedMentions, 'mentions of `expectedVersion` in the routes file outside the censused sites').toEqual([])
    expect(census.writes.filter((w) => !isAllowedWrite(w)), 'write points outside the allowed set (the two doors + the helper\'s forwarding site)').toEqual([])
    expect(inHandlers.map((w) => w.handler).sort(), 'write points inside route handlers').toEqual([APPROVE_ROUTE, REJECT_ROUTE])
    for (const w of inHandlers) {
      // Each door binds its OWN validated `version` to the rider, on the shared settlement helper's
      // precondition argument — the helper is the door's dispatch.
      expect(w.file).toBe(ROUTES_FILE)
      expect(w.entry).toBe(HELPER_NAME)
      expect(w.valueText, `${w.handler}: rider value`).toBe('requestedVersion')
      expect(w.via, `${w.handler}: reached without a spread`).toEqual([])
    }
    expect(census.writes.filter((w) => w.handler === ACTIONS_ROUTE), 'write points inside /actions').toEqual([])
    expect(census.writes.filter((w) => w.file !== ROUTES_FILE), 'write points in callers other than the routes file').toEqual([])
    // Outside every handler: the ONE forwarding site inside the shared settlement helper.
    expect(outside).toHaveLength(1)
    expect(outside[0]).toMatchObject({ file: ROUTES_FILE, entry: 'dispatchAction', fn: HELPER_NAME, valueText: 'precondition.expectedVersion' })
    expect(helperCalls.map((c) => c.handler).sort(), 'the helper is called from exactly the two doors').toEqual([APPROVE_ROUTE, REJECT_ROUTE])
  })

  describe('WRITE POINTS (positive controls): the same census on the real tree with a third write point spliced into /actions', () => {
    const where: DispatchLocator = { receiver: 'productService', route: ACTIONS_ROUTE }
    const value = 'Number(req.body?.version)'
    // Control locals carry names no real declaration uses (`__ctl*`), and each case asserts that
    // before splicing, so `resolveIdentifierInitializer` can never bind a control's name to a real
    // one. The shorthand case must be named `expectedVersion` by definition; the negative control
    // above already proves the routes file declares no such name.
    const cases: Array<{ name: string; local?: string; statementBefore?: string; firstProperty: string; expectSpelling?: Spelling; expectVia?: number; expectMention?: boolean }> = [
      { name: 'shorthand `expectedVersion,` behind a local `const expectedVersion = ...` (gate MG-a2 shape)', local: RIDER, statementBefore: `const expectedVersion = ${value} as number | undefined`, firstProperty: 'expectedVersion,', expectSpelling: 'shorthand', expectMention: true },
      { name: 'colon `expectedVersion: <expr>,`', firstProperty: `expectedVersion: ${value},`, expectSpelling: 'identifier' },
      { name: "string key `'expectedVersion': <expr>,`", firstProperty: `'expectedVersion': ${value},`, expectSpelling: 'string' },
      { name: "computed key `['expectedVersion']: <expr>,`", firstProperty: `['expectedVersion']: ${value},`, expectSpelling: 'computed' },
      { name: 'spread of a same-file `const __ctlRider = { expectedVersion: ... }` (gate MG-a3 shape)', local: '__ctlRider', statementBefore: `const __ctlRider = { expectedVersion: ${value} }`, firstProperty: '...__ctlRider,', expectSpelling: 'identifier', expectVia: 2 },
      { name: 'inline conditional spread `...(c ? { expectedVersion } : {})`', local: RIDER, statementBefore: `const expectedVersion = ${value}`, firstProperty: `...(req.body?.version !== undefined ? { expectedVersion } : {}),`, expectSpelling: 'shorthand', expectVia: 1, expectMention: true },
    ]
    for (const c of cases) {
      it(`a third write point spelled as ${c.name} is reported`, () => {
        if (c.local) expect(identifierMentionsInRoute(parse(routesSource), c.local, ACTIONS_ROUTE), `control local \`${c.local}\` is unused in /actions before the splice`).toBe(0)
        const mutated = censusTree({ file: ROUTES_FILE, source: spliceIntoDispatch(routesSource, where, c) }).census
        const inActions = mutated.writes.filter((w) => w.handler === ACTIONS_ROUTE)
        expect(inActions, 'write points inside /actions after the splice').toHaveLength(1)
        expect(inActions[0].file).toBe(ROUTES_FILE)
        expect(inActions[0].spelling).toBe(c.expectSpelling)
        expect(inActions[0].via).toHaveLength(c.expectVia ?? 0)
        expect(mutated.writes.filter((w) => w.handler !== null)).toHaveLength(3)
        expect(mutated.writes.filter((w) => !isAllowedWrite(w))).toHaveLength(1)
        expect(mutated.undetermined).toEqual([])
        if (c.expectMention) expect(mutated.unclassifiedMentions.length, 'the local declaration is itself an unclassified mention').toBeGreaterThanOrEqual(1)
        else expect(mutated.unclassifiedMentions).toEqual([])
      })
    }
    const undeterminedShapes: Array<{ name: string; local?: string; statementBefore?: string; firstProperty: string }> = [
      { name: 'a spread of a call result `...buildRider(req),`', firstProperty: '...buildRider(req),' },
      { name: 'a spread of a parameter-bound name', local: '__ctlRiderOf', statementBefore: 'const __ctlRiderOf = (r: typeof req) => ({ ...r.body })', firstProperty: '...__ctlRiderOf(req),' },
      { name: 'a computed key that is not a string literal `[__ctlRiderKey]: 1,`', local: '__ctlRiderKey', statementBefore: "const __ctlRiderKey = 'expectedVersion'", firstProperty: '[__ctlRiderKey]: 1,' },
    ]
    for (const c of undeterminedShapes) {
      it(`${c.name} is reported as an UNDETERMINED write point (reported, not resolved)`, () => {
        if (c.local) expect(identifierMentionsInRoute(parse(routesSource), c.local, ACTIONS_ROUTE), `control local \`${c.local}\` is unused in /actions before the splice`).toBe(0)
        const mutated = censusTree({ file: ROUTES_FILE, source: spliceIntoDispatch(routesSource, where, c) }).census
        expect(mutated.undetermined.length).toBeGreaterThanOrEqual(1)
        expect(mutated.undetermined[0]).toMatchObject({ file: ROUTES_FILE, handler: ACTIONS_ROUTE })
        expect(mutated.writes.filter((w) => w.handler !== null)).toHaveLength(2)
      })
    }
    it('a non-literal request argument is reported as UNDETERMINED (reported, not resolved)', () => {
      const sf = parse(routesSource)
      const call = locateDispatchCall(sf, { receiver: 'bridgeService', route: ACTIONS_ROUTE })
      const request = call.arguments[1]
      const mutated = routesSource.slice(0, request.getStart(sf)) + 'buildRequest(req)' + routesSource.slice(request.getEnd())
      const result = censusTree({ file: ROUTES_FILE, source: mutated }).census
      expect(result.undetermined).toHaveLength(1)
      expect(result.undetermined[0]).toMatchObject({ file: ROUTES_FILE, entry: 'dispatchAction', handler: ACTIONS_ROUTE, text: 'buildRequest(req)' })
    })
  })

  describe('WRITE POINTS (population controls): the same census with a third write point spliced into a caller OTHER than the routes file', () => {
    const populationCases: Array<{ name: string; file: string; where: DispatchLocator; elementAccessCallee?: boolean }> = [
      { name: 'the DingTalk card wrapper `deps.approvals.dispatchAction(...)` (gate P3-A / G6 shape)', file: CARD_WRAPPER_FILE, where: { receiver: 'deps.approvals', route: null } },
      { name: "the card wrapper's call rewritten to the element-access callee `deps.approvals['dispatchAction'](...)` (gate NIT-b shape)", file: CARD_WRAPPER_FILE, where: { receiver: 'deps.approvals', route: null }, elementAccessCallee: true },
      { name: 'the after-sales bridge `this.approvalBridge.dispatchAction(...)`, whose request is an `as ApprovalActionRequest` cast', file: AFTER_SALES_BRIDGE_FILE, where: { receiver: 'this.approvalBridge', route: null } },
    ]
    for (const c of populationCases) {
      it(`\`expectedVersion: 1,\` spliced into ${c.name} is reported by the census, not only by this control`, () => {
        const source = readSource(absPath(c.file))
        const mutatedSource = spliceIntoDispatch(source, c.where, { firstProperty: 'expectedVersion: 1,', elementAccessCallee: c.elementAccessCallee })
        expect(mutatedSource).not.toBe(source)
        const mutated = censusTree({ file: c.file, source: mutatedSource }).census
        const extra = mutated.writes.filter((w) => !isAllowedWrite(w))
        expect(extra, `write points outside the allowed set after splicing into ${c.file}`).toHaveLength(1)
        expect(extra[0]).toMatchObject({ file: c.file, entry: 'dispatchAction', handler: null, spelling: 'identifier', valueText: '1', via: [] })
        // The call itself was censused under the spliced callee, with its real receiver.
        expect(mutated.calls.filter((k) => k.file === c.file && k.receiver === c.where.receiver).length).toBeGreaterThanOrEqual(1)
        expect(mutated.undetermined).toEqual([])
        // The routes file is untouched by this splice: its own two doors are still the only handler writes.
        expect(mutated.writes.filter((w) => w.handler !== null).map((w) => w.handler).sort()).toEqual([APPROVE_ROUTE, REJECT_ROUTE])
      })
    }
  })

  it('EACH legacy door: seat gate, THEN cancel-round outlet guard, THEN the write point (F4 (i) order pinned statically; removing or moving the guard is red)', () => {
    for (const [door, tag] of [
      [approve!, 'legacy POST /:id/approve'],
      [reject!, 'legacy POST /:id/reject'],
    ] as const) {
      const gate = occurrences(routes, 'await resolveLegacyDecisionSeat(', door.start, door.end)
      const guard = occurrences(routes, `rejectIfCancelRound(instance, '${tag}')`, door.start, door.end)
      const write = census.writes.filter((w) => w.file === ROUTES_FILE && w.handler === door.name)
      expect(gate, `${door.name}: seat gate`).toHaveLength(1)
      expect(guard, `${door.name}: cancel-round outlet guard`).toHaveLength(1)
      expect(write, `${door.name}: write point`).toHaveLength(1)
      const gateLine = lineOfOffset(routes, gate[0])
      const guardLine = lineOfOffset(routes, guard[0])
      expect(gateLine).toBeLessThan(guardLine)
      expect(guardLine).toBeLessThan(write[0].line)
      expect(write[0].line).toBeLessThanOrEqual(lineOfOffset(routes, door.end))
    }
    // The /actions door carries no outlet guard of its own (its cancel-round judgment lives in
    // `dispatchAction`) — which is exactly why a write point there would revive the latent order.
    expect(occurrences(routes, 'rejectIfCancelRound(', actions!.start, actions!.end)).toHaveLength(0)
  })

  it('dispatchAction: attendance fail-closed guard, THEN the version precondition, THEN the cancel-round action gate (F4 (ii) order pinned statically); the rider is read at exactly one site', () => {
    const service = stripCommentLines(readSource(absPath(SERVICE_FILE)))
    const reads = occurrences(service, 'request.expectedVersion')
    // `request.expectedVersion !== undefined && instance.version !== request.expectedVersion` is one
    // statement with two mentions; both must sit on the same line.
    expect(reads.length).toBeGreaterThanOrEqual(1)
    const readLine = service.slice(0, reads[0]).split('\n').length
    for (const r of reads) expect(service.slice(0, r).split('\n').length).toBe(readLine)
    const methodStart = service.indexOf('async dispatchAction(')
    expect(methodStart).toBeGreaterThan(-1)
    const nextMethod = service.indexOf('\n  async ', methodStart + 1)
    const nextPrivate = service.indexOf('\n  private ', methodStart + 1)
    const methodEnd = Math.min(...[nextMethod, nextPrivate].filter((i) => i > -1))
    expect(reads[0]).toBeGreaterThan(methodStart)
    expect(reads[0]).toBeLessThan(methodEnd)
    const attendance = occurrences(service, 'await guardAttendanceCentralMutationOrThrow(client, instance)', methodStart, methodEnd)
    const actionGate = occurrences(service, 'assertCancelRoundActionAllowed(instance, request.action)', methodStart, methodEnd)
    expect(attendance.length).toBeGreaterThanOrEqual(1)
    expect(actionGate).toHaveLength(1)
    expect(attendance[0]).toBeLessThan(reads[0])
    expect(reads[0]).toBeLessThan(actionGate[0])
  })
})
