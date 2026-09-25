import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
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
 * what keeps that a TESTED property rather than a coincidence: it goes red the moment either of
 * the two revival paths opens —
 *
 *   1. a THIRD `expectedVersion` write point appears (in particular inside the `/actions` handler,
 *      which carries no `rejectIfCancelRound`), or
 *   2. `rejectIfCancelRound` is removed from, or moved behind the dispatch in, either legacy door.
 *
 * It also pins the two owner-named orders statically, as a complement to the real-DB legs:
 * F4 (i) — in each legacy door the seat gate precedes the cancel-round outlet guard; F4 (ii) — in
 * `dispatchAction` the version precondition precedes the cancel-round action gate, and both follow
 * the attendance fail-closed guard.
 *
 * WHAT THE WRITE-POINT CENSUS PINS (its scope, stated so nobody reads more into it):
 *
 *   It pins the `expectedVersion` PROPERTY OF AN OBJECT LITERAL handed to a rider entry — not every
 *   data flow that could reach the rider. The routes file is parsed with the TypeScript compiler
 *   API; every call to a rider entry (`RIDER_ENTRIES` below: any `<receiver>.dispatchAction(...)`
 *   and the shared settlement helper, whose `precondition` argument the helper forwards) has its
 *   request argument walked as an object literal, and a property named `expectedVersion` counts
 *   whatever its spelling — `expectedVersion: x`, the shorthand `expectedVersion,`, the string key
 *   `'expectedVersion': x`, the computed key `['expectedVersion']: x`, or a method/accessor of that
 *   name. Comments are not nodes, so a docblock that mentions the rider never counts.
 *
 *   Spreads inside such an object are resolved STATICALLY and fail closed: an inline object
 *   literal, a conditional over object literals (`...(c ? { k } : {})` — the only spread shape the
 *   rider entries carry today), `&&`/`||`/`??` over those, and an identifier whose initializer is
 *   one of those in an enclosing scope of the SAME file are expanded to their keys; anything else
 *   (a call result, a member access, an imported or parameter-bound name) is an UNDETERMINED write
 *   point and is red unless it is registered by name in `ACCEPTED_UNRESOLVED_SPREADS` with a
 *   reason. A request argument that is not an object literal (after the same resolution) is
 *   undetermined for the same reason. A computed key that is not a string literal is undetermined.
 *
 *   As a second net over the whole routes file, EVERY identifier or string-literal mention of
 *   `expectedVersion` outside those censused properties must be one of the helper's two known
 *   sites (its parameter type member and its `precondition.expectedVersion` read); any other
 *   mention — a new `const expectedVersion = ...`, a `request.expectedVersion = ...`, an
 *   `Object.assign(req, { expectedVersion })` — is red on the mention alone, before it reaches a
 *   call. Out of reach by construction: a request object built elsewhere under another name and
 *   passed through a non-literal argument (that is a data-flow property, and it trips the
 *   fail-closed rule above only where it surfaces as a non-literal request argument or spread).
 *
 *   The order checks below are a plain source census on comment-stripped text (comment-only lines
 *   are blanked, offsets preserved), because they pin the relative position of three statements,
 *   not a property name.
 */
const backendRoot = path.resolve(__dirname, '..', '..')
const routesPath = path.join(backendRoot, 'src', 'routes', 'approvals.ts')
const servicePath = path.join(backendRoot, 'src', 'services', 'ApprovalProductService.ts')

/**
 * The entries whose request object carries the rider, and which argument is that request.
 *   - `<any receiver>.dispatchAction(id, request, actor)` — the service entry itself, matched on the
 *     member name so a second receiver (`bridgeService`, a renamed local) is censused too.
 *   - `settleLegacyDecisionThroughSharedPath(productService, id, action, comment, actor,
 *     precondition)` — the shared settlement helper; its `precondition` object IS the door's write
 *     point (the helper forwards `precondition.expectedVersion` into its own dispatch).
 */
const RIDER_ENTRIES = [
  { kind: 'member', name: 'dispatchAction', requestArg: 1 },
  { kind: 'function', name: 'settleLegacyDecisionThroughSharedPath', requestArg: 5 },
] as const

/**
 * Spreads the census cannot resolve statically that are ACCEPTED by name. EMPTY today: every spread
 * in a rider-entry request is an inline conditional over object literals, so nothing needs
 * registering. Adding an entry needs its `reason` — a spread of a helper's return value hides the
 * rider's keys from this file, which is precisely what the fail-closed rule exists to surface.
 */
const ACCEPTED_UNRESOLVED_SPREADS: ReadonlyArray<{ entry: string; spreadText: string; reason: string }> = []

const HELPER_NAME = 'settleLegacyDecisionThroughSharedPath'
const RIDER = 'expectedVersion'

type Spelling = 'identifier' | 'shorthand' | 'string' | 'computed' | 'method'
type RiderWrite = { entry: string; handler: string | null; line: number; spelling: Spelling; via: string[]; valueText: string }
type Undetermined = { entry: string; handler: string | null; line: number; why: string; text: string }
type Mention = { line: number; text: string; kind: string }
type RiderCall = { entry: string; receiver: string | null; handler: string | null; line: number }
type Census = { calls: RiderCall[]; writes: RiderWrite[]; undetermined: Undetermined[]; unclassifiedMentions: Mention[] }

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('approvals.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
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

/** Same-file, lexically nearest `const/let/var <name> = <initializer>` above `from`; null when none (or when the name is a parameter). */
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

function censusRiderWrites(source: string): Census {
  const sf = parse(source)
  const census: Census = { calls: [], writes: [], undetermined: [], unclassifiedMentions: [] }
  /** Name nodes of censused `expectedVersion` properties, so the mention closure can recognise them. */
  const censusedNameNodes = new Set<ts.Node>()

  function walkObject(obj: ts.ObjectLiteralExpression, entry: string, handler: string | null, via: string[], seen: Set<string>) {
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        resolveSpread(prop.expression, entry, handler, [...via, prop.getText(sf)], seen)
        continue
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (prop.name.text === RIDER) {
          censusedNameNodes.add(prop.name)
          census.writes.push({ entry, handler, line: lineOfNode(sf, prop), spelling: 'shorthand', via, valueText: prop.name.text })
        }
        continue
      }
      const named = propertyName(prop.name)
      if (!named) {
        census.undetermined.push({ entry, handler, line: lineOfNode(sf, prop), why: 'computed property name is not a string literal', text: prop.getText(sf) })
        continue
      }
      if (named.text !== RIDER) continue
      censusedNameNodes.add(ts.isComputedPropertyName(prop.name) ? unwrap(prop.name.expression) : prop.name)
      if (ts.isPropertyAssignment(prop)) {
        census.writes.push({ entry, handler, line: lineOfNode(sf, prop), spelling: named.spelling, via, valueText: prop.initializer.getText(sf) })
      } else {
        // method / get / set accessor named `expectedVersion`
        census.writes.push({ entry, handler, line: lineOfNode(sf, prop), spelling: 'method', via, valueText: prop.getText(sf).slice(0, 40) })
      }
    }
  }

  function resolveSpread(expr: ts.Expression, entry: string, handler: string | null, via: string[], seen: Set<string>) {
    const e = unwrap(expr)
    if (ts.isObjectLiteralExpression(e)) return walkObject(e, entry, handler, via, seen)
    if (ts.isConditionalExpression(e)) {
      resolveSpread(e.whenTrue, entry, handler, via, seen)
      resolveSpread(e.whenFalse, entry, handler, via, seen)
      return
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return resolveSpread(e.right, entry, handler, via, seen)
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        resolveSpread(e.left, entry, handler, via, seen)
        resolveSpread(e.right, entry, handler, via, seen)
        return
      }
    }
    if (ts.isIdentifier(e) && !seen.has(e.text)) {
      const init = resolveIdentifierInitializer(e, e.text)
      if (init) return resolveSpread(init, entry, handler, [...via, `${e.text} = ${init.getText(sf).slice(0, 60)}`], new Set([...seen, e.text]))
    }
    const text = expr.getText(sf)
    if (ACCEPTED_UNRESOLVED_SPREADS.some((a) => a.entry === entry && a.spreadText === text)) return
    census.undetermined.push({ entry, handler, line: lineOfNode(sf, expr), why: 'spread / request source is not statically resolvable in this file', text })
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      let entry: (typeof RIDER_ENTRIES)[number] | undefined
      let receiver: string | null = null
      if (ts.isPropertyAccessExpression(callee)) {
        entry = RIDER_ENTRIES.find((r) => r.kind === 'member' && r.name === callee.name.text)
        receiver = callee.expression.getText(sf)
      } else if (ts.isIdentifier(callee)) {
        entry = RIDER_ENTRIES.find((r) => r.kind === 'function' && r.name === callee.text)
      }
      if (entry) {
        const handler = enclosingRoute(node)
        census.calls.push({ entry: entry.name, receiver, handler, line: lineOfNode(sf, node) })
        const request = node.arguments[entry.requestArg]
        if (!request) {
          census.undetermined.push({ entry: entry.name, handler, line: lineOfNode(sf, node), why: `request argument #${entry.requestArg} is missing`, text: node.getText(sf).slice(0, 80) })
        } else {
          // The request argument is walked fail-closed (a non-literal is undetermined); every OTHER
          // argument is walked only when it is itself an inline object literal.
          resolveSpread(request, entry.name, handler, [], new Set())
          node.arguments.forEach((arg, i) => {
            if (i === entry!.requestArg) return
            const e = unwrap(arg)
            if (ts.isObjectLiteralExpression(e)) walkObject(e, entry!.name, handler, [`arg#${i}`], new Set())
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  // Mention closure: every other `expectedVersion` identifier / string literal in the file.
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
      if (kind) census.unclassifiedMentions.push({ line: lineOfNode(sf, node), text: node.parent ? node.parent.getText(sf).split('\n')[0].slice(0, 100) : node.getText(sf), kind })
    }
    ts.forEachChild(node, visitMentions)
  }
  visitMentions(sf)
  return census
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
// In-memory positive controls: splice a third write point into the `/actions` handler's own
// `productService.dispatchAction` request and run the SAME census on the result.

const ACTIONS_ROUTE = 'POST /api/approvals/:id/actions'
const APPROVE_ROUTE = 'POST /api/approvals/:id/approve'
const REJECT_ROUTE = 'POST /api/approvals/:id/reject'

function spliceIntoActionsDispatch(source: string, edit: { statementBefore?: string; firstProperty: string }): string {
  const sf = parse(source)
  let target: ts.CallExpression | undefined
  const find = (node: ts.Node) => {
    if (!target && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'dispatchAction'
      && node.expression.expression.getText(sf) === 'productService' && enclosingRoute(node) === ACTIONS_ROUTE) target = node
    ts.forEachChild(node, find)
  }
  find(sf)
  if (!target) throw new Error('control: /actions productService.dispatchAction call not found')
  const request = target.arguments[1]
  if (!request || !ts.isObjectLiteralExpression(request)) throw new Error('control: /actions request is not an object literal')
  let statement: ts.Node = target
  while (statement.parent && !ts.isExpressionStatement(statement) && !ts.isVariableStatement(statement)) statement = statement.parent
  const braceEnd = request.getStart(sf) + 1
  const stmtStart = statement.getStart(sf)
  // Later offset first so the earlier one stays valid.
  let out = source.slice(0, braceEnd) + '\n' + edit.firstProperty + source.slice(braceEnd)
  if (edit.statementBefore) out = out.slice(0, stmtStart) + edit.statementBefore + '\n' + out.slice(stmtStart)
  return out
}

describe('v3b action 3 — `expectedVersion` is written by exactly the two legacy decision doors, and each door refuses a cancel-round instance before it dispatches', () => {
  const routesSource = readFileSync(routesPath, 'utf8')
  const routes = stripCommentLines(routesSource)
  const spans = routeHandlerSpans(routes)
  const approve = spans.find((s) => s.name === APPROVE_ROUTE)
  const reject = spans.find((s) => s.name === REJECT_ROUTE)
  const actions = spans.find((s) => s.name === ACTIONS_ROUTE)
  const census = censusRiderWrites(routesSource)

  it('the three legacy-decision handlers are located (self-check: a renamed route must not silently vacate this guard)', () => {
    expect(approve, 'legacy /approve handler').toBeTruthy()
    expect(reject, 'legacy /reject handler').toBeTruthy()
    expect(actions, '/actions handler').toBeTruthy()
    expect(spans.length).toBeGreaterThan(10)
    // The AST census saw the same three handlers, and at least one rider-entry call in each.
    for (const route of [APPROVE_ROUTE, REJECT_ROUTE, ACTIONS_ROUTE]) {
      expect(census.calls.filter((c) => c.handler === route).length, `rider-entry calls inside ${route}`).toBeGreaterThanOrEqual(1)
    }
  })

  it('WRITE POINTS (negative control on the real source): exactly two, one inside each legacy door, spelled any way; zero undetermined; every other mention of the rider is the helper\'s own', () => {
    const inHandlers = census.writes.filter((w) => w.handler !== null)
    const outside = census.writes.filter((w) => w.handler === null)
    expect(census.undetermined, 'undetermined write points (unresolvable spread / non-literal request)').toEqual([])
    expect(census.unclassifiedMentions, 'mentions of `expectedVersion` outside the censused sites').toEqual([])
    expect(inHandlers.map((w) => w.handler).sort(), 'write points inside route handlers').toEqual([APPROVE_ROUTE, REJECT_ROUTE])
    for (const w of inHandlers) {
      // Each door binds its OWN validated `version` to the rider, on the shared settlement helper's
      // precondition argument — the helper is the door's dispatch.
      expect(w.entry).toBe(HELPER_NAME)
      expect(w.valueText, `${w.handler}: rider value`).toBe('requestedVersion')
      expect(w.via, `${w.handler}: reached without a spread`).toEqual([])
    }
    expect(census.writes.filter((w) => w.handler === ACTIONS_ROUTE), 'write points inside /actions').toEqual([])
    // Outside every handler: the ONE forwarding site inside the shared settlement helper.
    expect(outside).toHaveLength(1)
    expect(outside[0].entry).toBe('dispatchAction')
    expect(outside[0].valueText).toBe('precondition.expectedVersion')
    const helperCalls = census.calls.filter((c) => c.entry === HELPER_NAME)
    expect(helperCalls.map((c) => c.handler).sort(), 'the helper is called from exactly the two doors').toEqual([APPROVE_ROUTE, REJECT_ROUTE])
  })

  describe('WRITE POINTS (positive controls): the same census on the real source with a third write point spliced into /actions', () => {
    const value = 'Number(req.body?.version)'
    const cases: Array<{ name: string; statementBefore?: string; firstProperty: string; expectSpelling?: Spelling; expectVia?: number; expectUndetermined?: number; expectMention?: boolean }> = [
      { name: 'shorthand `expectedVersion,` behind a local `const expectedVersion = ...` (gate MG-a2 shape)', statementBefore: `const expectedVersion = ${value} as number | undefined`, firstProperty: 'expectedVersion,', expectSpelling: 'shorthand', expectMention: true },
      { name: 'colon `expectedVersion: <expr>,`', firstProperty: `expectedVersion: ${value},`, expectSpelling: 'identifier' },
      { name: "string key `'expectedVersion': <expr>,`", firstProperty: `'expectedVersion': ${value},`, expectSpelling: 'string' },
      { name: "computed key `['expectedVersion']: <expr>,`", firstProperty: `['expectedVersion']: ${value},`, expectSpelling: 'computed' },
      { name: 'spread of a same-file `const rider = { expectedVersion: ... }` (gate MG-a3 shape)', statementBefore: `const rider = { expectedVersion: ${value} }`, firstProperty: '...rider,', expectSpelling: 'identifier', expectVia: 2 },
      { name: 'inline conditional spread `...(c ? { expectedVersion } : {})`', statementBefore: `const expectedVersion = ${value}`, firstProperty: `...(req.body?.version !== undefined ? { expectedVersion } : {}),`, expectSpelling: 'shorthand', expectVia: 1, expectMention: true },
    ]
    for (const c of cases) {
      it(`a third write point spelled as ${c.name} is reported`, () => {
        const mutated = censusRiderWrites(spliceIntoActionsDispatch(routesSource, c))
        const inActions = mutated.writes.filter((w) => w.handler === ACTIONS_ROUTE)
        expect(inActions, 'write points inside /actions after the splice').toHaveLength(1)
        expect(inActions[0].spelling).toBe(c.expectSpelling)
        expect(inActions[0].via).toHaveLength(c.expectVia ?? 0)
        expect(mutated.writes.filter((w) => w.handler !== null)).toHaveLength(3)
        expect(mutated.undetermined).toEqual([])
        if (c.expectMention) expect(mutated.unclassifiedMentions.length, 'the local declaration is itself an unclassified mention').toBeGreaterThanOrEqual(1)
        else expect(mutated.unclassifiedMentions).toEqual([])
      })
    }
    const failClosed: Array<{ name: string; statementBefore?: string; firstProperty: string }> = [
      { name: 'a spread of a call result `...buildRider(req),`', firstProperty: '...buildRider(req),' },
      { name: 'a spread of a parameter-bound name', statementBefore: 'const riderOf = (r: typeof req) => ({ ...r.body })', firstProperty: '...riderOf(req),' },
      { name: 'a computed key that is not a string literal `[riderKey]: 1,`', statementBefore: "const riderKey = 'expectedVersion'", firstProperty: '[riderKey]: 1,' },
    ]
    for (const c of failClosed) {
      it(`${c.name} is an UNDETERMINED write point (fail-closed)`, () => {
        const mutated = censusRiderWrites(spliceIntoActionsDispatch(routesSource, c))
        expect(mutated.undetermined.length).toBeGreaterThanOrEqual(1)
        expect(mutated.undetermined[0].handler).toBe(ACTIONS_ROUTE)
        expect(mutated.writes.filter((w) => w.handler !== null)).toHaveLength(2)
      })
    }
    it('a non-literal request argument is UNDETERMINED (fail-closed)', () => {
      const sf = parse(routesSource)
      let call: ts.CallExpression | undefined
      const find = (node: ts.Node) => {
        if (!call && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'dispatchAction'
          && node.expression.expression.getText(sf) === 'bridgeService' && enclosingRoute(node) === ACTIONS_ROUTE) call = node
        ts.forEachChild(node, find)
      }
      find(sf)
      expect(call, 'control: /actions bridgeService.dispatchAction call').toBeTruthy()
      const request = call!.arguments[1]
      const mutated = routesSource.slice(0, request.getStart(sf)) + 'buildRequest(req)' + routesSource.slice(request.getEnd())
      const result = censusRiderWrites(mutated)
      expect(result.undetermined).toHaveLength(1)
      expect(result.undetermined[0]).toMatchObject({ entry: 'dispatchAction', handler: ACTIONS_ROUTE, text: 'buildRequest(req)' })
    })
  })

  it('EACH legacy door: seat gate, THEN cancel-round outlet guard, THEN the write point (F4 (i) order pinned statically; removing or moving the guard is red)', () => {
    for (const [door, tag] of [
      [approve!, 'legacy POST /:id/approve'],
      [reject!, 'legacy POST /:id/reject'],
    ] as const) {
      const gate = occurrences(routes, 'await resolveLegacyDecisionSeat(', door.start, door.end)
      const guard = occurrences(routes, `rejectIfCancelRound(instance, '${tag}')`, door.start, door.end)
      const write = census.writes.filter((w) => w.handler === door.name)
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
    const service = stripCommentLines(readFileSync(servicePath, 'utf8'))
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
