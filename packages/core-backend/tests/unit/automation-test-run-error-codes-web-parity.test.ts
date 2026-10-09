/**
 * Test-run refusal codes: the automation manager's test button must know every one the route can answer
 * (#5817 follow-up).
 *
 * `POST /api/multitable/sheets/:sheetId/automations/:ruleId/test` answers `{ ok:false, error:{ code, message } }`
 * with fixed English messages. apps/web/src/multitable/components/MetaAutomationManager.vue maps each code
 * to localized copy (`TEST_RUN_ERROR_LABELS`); an unmapped code falls back to a generic label, so a new
 * server code without a label would silently lose its meaning. Modelled on
 * automation-retry-resume-refusal-codes-web-parity.test.ts.
 *
 * The codes are read with the TypeScript parser, never retyped here. What the parse cannot read fails the
 * test; it is never skipped:
 *   route handler (routes/automation.ts):
 *     - every `return` is `undefined`/bare or a call; every `.json(x)` body is an object literal with an
 *       `error` (its `error.code`, a conditional of object literals, or a string `error` with no code) or
 *       the sample loader's `loaded.body`. The ONE body allowed without `error` is the handler's final
 *       success call — found by position and shape (the `return res.json({…})` ending the `try` that ends
 *       the handler, with no `error`/`ok` key), not by "has no error key";
 *     - a call that passes the bare `res` must be a known responder helper, whose own bodies are read the
 *       same way (a helper parameter used as a code is bound to the call's string-literal argument);
 *     - a raw writer (`.send`/`.end`/`.sendStatus`/… on any receiver), a computed member access `x[k]`, an
 *       argument that mentions `res` without being it (`res as Response`, `req.res`, a callback), and `res`
 *       (or `req.res`) used as anything but a receiver or a bare argument (`const r = res`,
 *       `const { res: r } = req`) fail the test;
 *     - `err.code` is the pass-through of `AutomationTestRunRejectedError`, resolved from testRun;
 *   testRun (multitable/automation-service.ts): every `throw` must be `new AutomationTestRunRejectedError(
 *     <number>, <code>, …)`; `eligibility.code` resolves to realFireTestRunEligibility()'s returned codes;
 *     and no other place in src may construct that error;
 *   sample loader (routes/automation-test-run-sample.ts): every return is `{ ok:true, … }` or carries a
 *     `body` read like a `.json` body.
 * Nested functions are not walked (their returns/throws are not the enclosing function's), so a nested
 * function that could answer or reject — it calls `.json`, names AutomationTestRunRejectedError, or (in a
 * responder) mentions `res` or calls a raw writer — fails the test instead of being skipped.
 * A code is a string literal, a same-file `const NAME = '<literal>'`, or an identifier resolved from its
 * real export (`SHEET_DELETED_CODE`). Anything else fails the test.
 *
 * Pinned: server codes == TEST_RUN_ERROR_LABELS keys. The only responses without a code are the two
 * string-`error` bodies in KNOWN_UNCODED_ERRORS; the web client keys those by their text, so they reach
 * the generic label. That list must stay exact.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { SHEET_DELETED_CODE } from '../../src/multitable/sheet-liveness'

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const ROUTE_FILE = 'packages/core-backend/src/routes/automation.ts'
const SERVICE_FILE = 'packages/core-backend/src/multitable/automation-service.ts'
const SAMPLE_FILE = 'packages/core-backend/src/routes/automation-test-run-sample.ts'
const REFUSALS_FILE = 'packages/core-backend/src/multitable/sheet-refusals.ts'
const ELIGIBILITY_FILE = 'packages/core-backend/src/multitable/automation-retry-eligibility.ts'
const SRC_DIR = 'packages/core-backend/src'
const WEB_FILE = 'apps/web/src/multitable/components/MetaAutomationManager.vue'
const WEB_LABELS_FILE = 'apps/web/src/multitable/utils/meta-automation-labels.ts'
const TEST_RUN_PATH = '/sheets/:sheetId/automations/:ruleId/test'

/** Identifiers used as a `code` that are not same-file consts, resolved from their real exports. */
const CODE_IDENTIFIERS: Readonly<Record<string, string>> = { SHEET_DELETED_CODE }

/** Responder helpers the handler may pass `res` to, and the file that declares each. */
const RESPONDER_HELPERS: Readonly<Record<string, string>> = {
  sendForbidden: REFUSALS_FILE,
  sendSheetNotLive: REFUSALS_FILE,
  sendFailClosedResolutionError: ROUTE_FILE,
  getService: ROUTE_FILE,
}

/** Express response methods that write a body this test does not read. A call to one fails the test. */
const RESPONSE_WRITERS: ReadonlySet<string> = new Set([
  'send', 'end', 'sendStatus', 'jsonp', 'write', 'redirect', 'render', 'sendFile', 'download', 'format',
])

const REJECTION_CLASS = 'AutomationTestRunRejectedError'

/** Responses whose `error` is a plain string (no code). The web client keys them by that text. */
const KNOWN_UNCODED_ERRORS: readonly string[] = [
  'Automation service is not initialized yet',
  'sheetId and ruleId are required',
]

/** Repo file as text, line endings normalized (the Windows checkout is CRLF, CI is LF). */
function readRepoText(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

const sourceCache = new Map<string, ts.SourceFile>()
function parse(rel: string, text?: string): ts.SourceFile {
  const cached = text === undefined ? sourceCache.get(rel) : undefined
  if (cached) return cached
  const source = ts.createSourceFile(rel, text ?? readRepoText(rel), ts.ScriptTarget.Latest, true)
  if (text === undefined) sourceCache.set(rel, source)
  return source
}

function findNode<T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T | undefined {
  let found: T | undefined
  const visit = (node: ts.Node): void => {
    if (found) return
    if (match(node)) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function findFunction(rel: string, name: string): ts.FunctionDeclaration {
  const fn = findNode(parse(rel), (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name)
  if (!fn?.body) throw new Error(`${rel}: function ${name} not found`)
  return fn
}

/** The member a call invokes (`x.m()`, `x?.m()`, `x['m']()`), '' for a plain call, null for `x[k]()`. */
function calledMember(call: ts.CallExpression): string | null {
  const callee = call.expression
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  if (ts.isElementAccessExpression(callee)) {
    return ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : null
  }
  return ''
}

/** Why a nested function could answer or reject, if it could. */
type NestedCheck = (fn: ts.Node) => string | undefined

function nestedAnswerOrRejection(fn: ts.Node): string | undefined {
  const text = fn.getText()
  if (text.includes('.json(')) return 'calls .json('
  if (text.includes(REJECTION_CLASS)) return `names ${REJECTION_CLASS}`
  const json = findNode(fn, (n): n is ts.CallExpression => ts.isCallExpression(n) && calledMember(n) === 'json')
  return json ? `calls ${json.getText()}` : undefined
}

/**
 * Walk `body` without entering nested functions (their returns/throws are not this function's). A nested
 * function that could still answer or reject for this one fails the test instead of being skipped.
 */
function walk(body: ts.Node, visit: (node: ts.Node) => void, nestedCheck?: NestedCheck): void {
  const step = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      const reason = nestedAnswerOrRejection(node) ?? nestedCheck?.(node)
      if (reason) {
        throw new Error(`${body.getSourceFile().fileName}: a nested function ${reason}, which the test does not read: ${node.getText()}`)
      }
      return
    }
    visit(node)
    ts.forEachChild(node, step)
  }
  ts.forEachChild(body, step)
}

function propMap(obj: ts.ObjectLiteralExpression, where: string): Map<string, ts.ObjectLiteralElementLike> {
  const props = new Map<string, ts.ObjectLiteralElementLike>()
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) continue
    if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
      throw new Error(`${where}: unreadable property in ${obj.getText()}`)
    }
    props.set(p.name.text, p)
  }
  return props
}

function initializerOf(prop: ts.ObjectLiteralElementLike | undefined, where: string): ts.Expression | undefined {
  if (!prop) return undefined
  if (!ts.isPropertyAssignment(prop)) throw new Error(`${where}: non-assignment property ${prop.getText()}`)
  return prop.initializer
}

type Bindings = ReadonlyMap<string, string>

function sameFileConst(source: ts.SourceFile, name: string): string | undefined {
  const decl = findNode(
    source,
    (n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name,
  )
  return decl?.initializer && ts.isStringLiteral(decl.initializer) ? decl.initializer.text : undefined
}

type Ctx = { rel: string; bindings: Bindings; passThrough: () => string[]; sampleBody: () => Collected }
type Collected = { codes: Set<string>; uncoded: string[] }

function codeValues(expr: ts.Expression, ctx: Ctx): string[] {
  const where = `${ctx.rel}: code ${expr.getText()}`
  if (ts.isStringLiteral(expr)) return [expr.text]
  if (ts.isParenthesizedExpression(expr)) return codeValues(expr.expression, ctx)
  if (ts.isConditionalExpression(expr)) return [...codeValues(expr.whenTrue, ctx), ...codeValues(expr.whenFalse, ctx)]
  if (ts.isIdentifier(expr)) {
    const bound = ctx.bindings.get(expr.text)
      ?? (expr.text in CODE_IDENTIFIERS ? CODE_IDENTIFIERS[expr.text] : undefined)
      ?? sameFileConst(parse(ctx.rel), expr.text)
    if (bound === undefined) throw new Error(`${where}: unresolvable identifier`)
    return [bound]
  }
  if (ts.isPropertyAccessExpression(expr) && expr.getText() === 'err.code') return ctx.passThrough()
  throw new Error(`${where}: unresolvable code expression`)
}

function readBody(expr: ts.Expression, ctx: Ctx, out: Collected): void {
  const where = `${ctx.rel}: response body ${expr.getText()}`
  if (ts.isPropertyAccessExpression(expr) && expr.getText() === 'loaded.body') {
    const sample = ctx.sampleBody()
    for (const c of sample.codes) out.codes.add(c)
    out.uncoded.push(...sample.uncoded)
    return
  }
  if (ts.isParenthesizedExpression(expr)) return readBody(expr.expression, ctx, out)
  if (ts.isConditionalExpression(expr)) {
    readBody(expr.whenTrue, ctx, out)
    readBody(expr.whenFalse, ctx, out)
    return
  }
  if (!ts.isObjectLiteralExpression(expr)) throw new Error(`${where}: not an object literal`)
  const props = propMap(expr, where)
  const error = initializerOf(props.get('error'), where)
  // The handler's final success call is never read (collectResponses skips it); any other body must answer
  // with `error`, or the test cannot tell what the client receives.
  if (!error) throw new Error(`${where}: a body without error that is not the handler's final success call`)
  const readError = (e: ts.Expression): void => {
    if (ts.isParenthesizedExpression(e)) return readError(e.expression)
    if (ts.isConditionalExpression(e)) {
      readError(e.whenTrue)
      readError(e.whenFalse)
      return
    }
    if (ts.isStringLiteral(e)) {
      out.uncoded.push(e.text)
      return
    }
    if (!ts.isObjectLiteralExpression(e)) throw new Error(`${where}: unreadable error ${e.getText()}`)
    const code = initializerOf(propMap(e, where).get('code'), where)
    if (!code) throw new Error(`${where}: error object without code`)
    for (const c of codeValues(code, ctx)) out.codes.add(c)
  }
  readError(error)
}

type ResponseCtx = Ctx & {
  /** The response parameter's name in this function (the handler's or the helper's). */
  resName: string
  /** The handler's final success call (see finalSuccessCall), the one `.json` whose body is not read. */
  successCall?: ts.CallExpression
}

/**
 * A name in an object-literal key or member-declaration position, not a reference (`{ res: 1 }`). A
 * destructuring `{ res: out } = req` is NOT one: it takes the response out under another name.
 */
function isDeclaredName(id: ts.Identifier): boolean {
  const p = id.parent
  if (ts.isQualifiedName(p)) return p.right === id
  return (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)
    || ts.isPropertySignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && p.name === id
}

/**
 * Every response one function body can write. `.json(x)` bodies are read (except the handler's final
 * success call); a call passing the bare response to a known responder helper reads that helper. Anything
 * else that could write or hand off the response fails the test: a raw writer on any receiver, a computed
 * member access `x[k]`, an argument that mentions the response without being it, the response (or
 * `req.res`) used other than as a receiver or a bare argument, and a nested function that mentions it or
 * writes.
 */
function collectResponses(body: ts.Node, ctx: ResponseCtx, out: Collected): void {
  const { rel, resName } = ctx
  const mentionsRes = (node: ts.Node): boolean =>
    findNode(node, (n): n is ts.Identifier => ts.isIdentifier(n) && n.text === resName) !== undefined
  const nestedCheck: NestedCheck = (fn) => {
    if (mentionsRes(fn)) return `mentions ${resName}`
    const writer = findNode(fn, (n): n is ts.CallExpression => ts.isCallExpression(n) && RESPONSE_WRITERS.has(calledMember(n) ?? ''))
    return writer ? `calls ${writer.getText()}` : undefined
  }
  walk(body, (node) => {
    if (
      ts.isElementAccessExpression(node)
      && !ts.isStringLiteralLike(node.argumentExpression)
      && !ts.isNumericLiteral(node.argumentExpression)
    ) {
      throw new Error(`${rel}: a computed member access the test cannot read: ${node.getText()}`)
    }
    if (ts.isIdentifier(node) && node.text === resName && !isDeclaredName(node)) {
      // `res` itself, or a `.res` member (`req.res` is the same response): only a receiver or a bare argument.
      const use = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node
      const p = use.parent
      const receiver = (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === use
      const bareArgument = use === node && ts.isCallExpression(p) && p.arguments.some((a) => a === node)
      if (!receiver && !bareArgument) {
        throw new Error(`${rel}: ${use.getText()} is used where the test cannot follow it: ${p.getText()}`)
      }
      return
    }
    if (!ts.isCallExpression(node)) return
    // A computed callee (`x[k]()`, null here) fails the test when the walk reaches its element access.
    const member = calledMember(node) ?? ''
    if (RESPONSE_WRITERS.has(member)) {
      throw new Error(`${rel}: .${member}() writes a response the test does not read: ${node.getText()}`)
    }
    let resIndex = -1
    node.arguments.forEach((arg, index) => {
      if (ts.isIdentifier(arg) && arg.text === resName) {
        if (resIndex < 0) resIndex = index
      } else if (mentionsRes(arg)) {
        throw new Error(`${rel}: an argument mentions ${resName} without being it: ${arg.getText()} in ${node.getText()}`)
      }
    })
    if (member === 'json') {
      if (node.arguments.length !== 1) throw new Error(`${rel}: .json call with ${node.arguments.length} args`)
      if (node !== ctx.successCall) readBody(node.arguments[0], ctx, out)
      return
    }
    if (resIndex < 0) return
    const callee = node.expression
    if (!ts.isIdentifier(callee) || !(callee.text in RESPONDER_HELPERS)) {
      throw new Error(`${rel}: ${resName} passed to an unknown responder ${node.getText()}`)
    }
    const helperFile = RESPONDER_HELPERS[callee.text]
    const helper = findFunction(helperFile, callee.text)
    const resParam = helper.parameters[resIndex]
    if (!resParam || !ts.isIdentifier(resParam.name)) {
      throw new Error(`${helperFile}: ${callee.text} has no named parameter at ${resName}'s position`)
    }
    const bindings = new Map<string, string>()
    helper.parameters.forEach((param, index) => {
      const arg = node.arguments[index]
      if (ts.isIdentifier(param.name) && arg && ts.isStringLiteral(arg)) bindings.set(param.name.text, arg.text)
    })
    collectResponses(helper.body!, { ...ctx, rel: helperFile, bindings, resName: resParam.name.text, successCall: undefined }, out)
  }, nestedCheck)
}

/**
 * The handler's final success call: the `return <res>.json({…})` ending the `try` block that ends the
 * handler, with no `error` and no `ok` key. A call of that shape anywhere else, or a last call of another
 * shape, is not it — its body is read like any other (and fails the test if it has no `error`).
 */
function finalSuccessCall(handler: ts.FunctionLikeDeclaration & { body: ts.Block }, resName: string): ts.CallExpression | undefined {
  const statements = handler.body.statements
  const last = statements[statements.length - 1]
  if (!last || !ts.isTryStatement(last)) return undefined
  const tried = last.tryBlock.statements
  const ret = tried[tried.length - 1]
  const call = ret && ts.isReturnStatement(ret) ? ret.expression : undefined
  if (!call || !ts.isCallExpression(call) || call.arguments.length !== 1) return undefined
  const callee = call.expression
  if (
    !ts.isPropertyAccessExpression(callee)
    || callee.questionDotToken
    || callee.name.text !== 'json'
    || !ts.isIdentifier(callee.expression)
    || callee.expression.text !== resName
  ) {
    return undefined
  }
  const body = call.arguments[0]
  if (!ts.isObjectLiteralExpression(body)) return undefined
  const props = propMap(body, `${ROUTE_FILE}: success body ${body.getText()}`)
  return props.has('error') || props.has('ok') ? undefined : call
}

function eligibilityCodes(): string[] {
  const fn = findFunction(ELIGIBILITY_FILE, 'realFireTestRunEligibility')
  const codes: string[] = []
  walk(fn.body!, (node) => {
    if (!ts.isReturnStatement(node)) return
    const where = `${ELIGIBILITY_FILE}: ${node.getText()}`
    if (!node.expression || !ts.isObjectLiteralExpression(node.expression)) throw new Error(`${where}: non-literal return`)
    const props = propMap(node.expression, where)
    const ok = initializerOf(props.get('ok'), where)
    if (ok?.kind === ts.SyntaxKind.TrueKeyword && props.size === 1) return
    const code = initializerOf(props.get('code'), where)
    if (ok?.kind !== ts.SyntaxKind.FalseKeyword || !code || !ts.isStringLiteral(code)) throw new Error(`${where}: unreadable`)
    codes.push(code.text)
  })
  return codes
}

function testRunMethod(): ts.MethodDeclaration {
  const cls = findNode(
    parse(SERVICE_FILE),
    (n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'AutomationService',
  )
  const method = cls?.members.find(
    (m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'testRun',
  )
  if (!method?.body) throw new Error('AutomationService.testRun not found')
  return method
}

type Rejection = { status: number; code: string }

function testRunRejections(): Rejection[] {
  const method = testRunMethod()
  const ctx: Ctx = {
    rel: SERVICE_FILE,
    bindings: new Map(),
    passThrough: () => { throw new Error('testRun: err.code is not a testRun code') },
    sampleBody: () => { throw new Error('testRun: loaded.body is not a testRun code') },
  }
  const eligibilityDecl = findNode(
    method.body!,
    (n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'eligibility',
  )
  const rejections: Rejection[] = []
  walk(method.body!, (node) => {
    if (!ts.isThrowStatement(node)) return
    const where = `testRun: ${node.getText()}`
    const expr = node.expression
    if (
      !ts.isNewExpression(expr)
      || !ts.isIdentifier(expr.expression)
      || expr.expression.text !== 'AutomationTestRunRejectedError'
      || expr.arguments?.length !== 3
    ) {
      throw new Error(`${where}: not a typed AutomationTestRunRejectedError`)
    }
    const [status, code] = expr.arguments
    if (!ts.isNumericLiteral(status)) throw new Error(`${where}: non-literal status`)
    let codes: string[]
    if (ts.isPropertyAccessExpression(code) && code.getText() === 'eligibility.code') {
      const init = eligibilityDecl?.initializer
      if (!init || !ts.isCallExpression(init) || init.expression.getText() !== 'realFireTestRunEligibility') {
        throw new Error(`${where}: eligibility is not realFireTestRunEligibility(...)`)
      }
      codes = eligibilityCodes()
    } else {
      codes = codeValues(code, ctx)
    }
    for (const c of codes) rejections.push({ status: Number(status.text), code: c })
  })
  return rejections
}

function listSourceFiles(rel: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(REPO_ROOT, rel))) {
    const child = `${rel}/${name}`
    if (statSync(join(REPO_ROOT, child)).isDirectory()) out.push(...listSourceFiles(child))
    else if (name.endsWith('.ts')) out.push(child)
  }
  return out
}

function sampleLoaderResponses(): Collected {
  const fn = findFunction(SAMPLE_FILE, 'loadReadableAutomationSampleRecord')
  const out: Collected = { codes: new Set(), uncoded: [] }
  const ctx: Ctx = {
    rel: SAMPLE_FILE,
    bindings: new Map(),
    passThrough: () => { throw new Error('sample loader: err.code is not readable here') },
    sampleBody: () => { throw new Error('sample loader: loaded.body is not readable here') },
  }
  walk(fn.body!, (node) => {
    if (!ts.isReturnStatement(node)) return
    const where = `${SAMPLE_FILE}: ${node.getText()}`
    if (!node.expression || !ts.isObjectLiteralExpression(node.expression)) throw new Error(`${where}: non-literal return`)
    const props = propMap(node.expression, where)
    const ok = initializerOf(props.get('ok'), where)
    if (ok?.kind === ts.SyntaxKind.TrueKeyword) return
    const body = initializerOf(props.get('body'), where)
    if (ok?.kind !== ts.SyntaxKind.FalseKeyword || !body) throw new Error(`${where}: neither ok:true nor a refusal body`)
    readBody(body, ctx, out)
  })
  return out
}

function testRunHandler(): ts.FunctionLikeDeclaration & { body: ts.Block } {
  const call = findNode(
    parse(ROUTE_FILE),
    (n): n is ts.CallExpression => ts.isCallExpression(n)
      && ts.isPropertyAccessExpression(n.expression)
      && n.expression.getText() === 'router.post'
      && n.arguments.length > 0
      && ts.isStringLiteral(n.arguments[0])
      && n.arguments[0].text === TEST_RUN_PATH,
  )
  const handler = call?.arguments[call.arguments.length - 1]
  if (!handler || !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) || !ts.isBlock(handler.body)) {
    throw new Error(`test-run handler for ${TEST_RUN_PATH} not found`)
  }
  return handler as ts.FunctionLikeDeclaration & { body: ts.Block }
}

function routeResponses(): Collected {
  const handler = testRunHandler()
  let passThroughUsed = false
  let sampleUsed = false
  const out: Collected = { codes: new Set(), uncoded: [] }
  walk(handler.body, (node) => {
    if (!ts.isReturnStatement(node) || !node.expression) return
    const expr = node.expression
    if (ts.isIdentifier(expr) && expr.text === 'undefined') return
    if (!ts.isCallExpression(expr)) throw new Error(`test-run handler: unreadable return ${node.getText()}`)
  })
  const handlerText = handler.body.getText()
  const resParam = handler.parameters[1]
  if (!resParam || !ts.isIdentifier(resParam.name)) throw new Error('test-run handler: no named response parameter')
  const resName = resParam.name.text
  collectResponses(handler.body, {
    rel: ROUTE_FILE,
    bindings: new Map(),
    resName,
    successCall: finalSuccessCall(handler, resName),
    passThrough: () => {
      if (!handlerText.includes('err instanceof AutomationTestRunRejectedError')) {
        throw new Error('err.code pass-through is not gated on AutomationTestRunRejectedError')
      }
      passThroughUsed = true
      return testRunRejections().map((r) => r.code)
    },
    sampleBody: () => {
      if (!handlerText.includes('loadReadableAutomationSampleRecord(')) {
        throw new Error('loaded.body is not the sample loader result')
      }
      sampleUsed = true
      return sampleLoaderResponses()
    },
  }, out)
  if (!passThroughUsed) throw new Error('the handler no longer passes testRun rejections through')
  if (!sampleUsed) throw new Error('the handler no longer answers with the sample loader body')
  return out
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

/** `code -> label key` entries of TEST_RUN_ERROR_LABELS, read from the component's script with the parser. */
function webTestRunLabels(): [string, string][] {
  const vue = readRepoText(WEB_FILE)
  const match = /<script setup lang="ts">([\s\S]*?)<\/script>/.exec(vue)
  if (!match) throw new Error('script setup block not found in the component')
  const source = parse(`${WEB_FILE}#script`, match[1])
  const decl = findNode(
    source,
    (n): n is ts.VariableDeclaration => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'TEST_RUN_ERROR_LABELS',
  )
  if (!decl?.initializer || !ts.isObjectLiteralExpression(decl.initializer)) {
    throw new Error('TEST_RUN_ERROR_LABELS object literal not found in the component')
  }
  return decl.initializer.properties.map((p): [string, string] => {
    if (
      !ts.isPropertyAssignment(p)
      || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
      || !ts.isStringLiteral(p.initializer)
    ) {
      throw new Error(`TEST_RUN_ERROR_LABELS: unreadable entry ${p.getText()}`)
    }
    return [p.name.text, p.initializer.text]
  })
}

describe('test-run response codes are read from the source', () => {
  it('testRun: every rejection is typed and the parse finds the known codes', () => {
    const codes = testRunRejections().map((r) => r.code)
    expect(codes).toContain('TEST_RUN_RULE_NOT_FOUND')
    expect(codes).toContain(SHEET_DELETED_CODE)
    expect(codes).toContain('INVALID_TEST_RUN_OPERATION_ID')
    expect(codes).toContain('TEST_RUN_CLASS_A_PROTECTION_DISABLED')
  })

  it('no other place in src constructs AutomationTestRunRejectedError', () => {
    let total = 0
    for (const file of listSourceFiles(SRC_DIR)) {
      total += readRepoText(file).split('new AutomationTestRunRejectedError(').length - 1
    }
    const inTestRun = testRunMethod().getText().split('new AutomationTestRunRejectedError(').length - 1
    expect(inTestRun).toBeGreaterThan(0)
    expect(total).toBe(inTestRun)
  })

  it('route: the parse finds handler, helper, sample-loader and pass-through codes', () => {
    const { codes, uncoded } = routeResponses()
    for (const code of ['FORBIDDEN', 'NOT_FOUND', 'PERMISSION_CHECK_FAILED', 'DB_NOT_READY', 'INVALID_TEST_RUN_RECORD_ID',
      'UNAUTHENTICATED', 'INVALID_SAMPLE_RECORD_DATA', 'TEST_RUN_FAILED', 'TEST_RUN_RULE_NOT_FOUND', SHEET_DELETED_CODE]) {
      expect([...codes], code).toContain(code)
    }
    expect(uniqueSorted(uncoded)).toEqual([...KNOWN_UNCODED_ERRORS].sort())
  })
})

describe('MetaAutomationManager knows every test-run refusal code', () => {
  it('TEST_RUN_ERROR_LABELS keys == the codes the route can answer, with no duplicates', () => {
    const server = uniqueSorted(routeResponses().codes)
    const mapped = webTestRunLabels().map(([code]) => code)
    expect(new Set(mapped).size).toBe(mapped.length)
    expect(uniqueSorted(mapped)).toEqual(server)
  })

  it('every mapped label key exists in the automation label table', () => {
    const labels = readRepoText(WEB_LABELS_FILE)
    for (const [code, key] of webTestRunLabels()) {
      expect(labels.includes(`'${key}': {`), `${code} -> ${key}`).toBe(true)
    }
  })

  it('SHEET_DELETED and TEST_RUN_RULE_NOT_FOUND have their own labels', () => {
    const map = new Map(webTestRunLabels())
    expect(map.get(SHEET_DELETED_CODE)).toBe('manager.testRunError.sheetDeleted')
    expect(map.get('TEST_RUN_RULE_NOT_FOUND')).toBe('manager.testRunError.ruleNotFound')
  })
})
