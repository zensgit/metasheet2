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
 * The codes are read with the TypeScript parser, never retyped here:
 *   route handler (routes/automation.ts):
 *     - every `return` is `undefined`/bare or a call; every `.json(x)` body is an object literal (its
 *       `error.code`, a conditional of object literals, or a string `error` with no code) or the sample
 *       loader's `loaded.body`; anything else fails the test;
 *     - a call that passes `res` must be a known responder helper, whose own `.json` bodies are read the
 *       same way (a helper parameter used as a code is bound to the call's string-literal argument);
 *     - `err.code` is the pass-through of `AutomationTestRunRejectedError`, resolved from testRun;
 *   testRun (multitable/automation-service.ts): every `throw` must be `new AutomationTestRunRejectedError(
 *     <number>, <code>, …)`; `eligibility.code` resolves to realFireTestRunEligibility()'s returned codes;
 *     and no other place in src may construct that error;
 *   sample loader (routes/automation-test-run-sample.ts): every return is `{ ok:true, … }` or carries a
 *     `body` read like a `.json` body.
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

/** Walk `body` without entering nested functions (their returns/throws are not this function's). */
function walk(body: ts.Node, visit: (node: ts.Node) => void): void {
  const step = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
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
  if (!error) {
    const ok = initializerOf(props.get('ok'), where)
    if (ok && ok.kind === ts.SyntaxKind.FalseKeyword) throw new Error(`${where}: ok:false without error`)
    return // success body
  }
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

/** `.json(...)` bodies and responder-helper calls inside one function body. */
function collectResponses(body: ts.Node, ctx: Ctx, out: Collected): void {
  walk(body, (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'json') {
      if (node.arguments.length !== 1) throw new Error(`${ctx.rel}: .json call with ${node.arguments.length} args`)
      readBody(node.arguments[0], ctx, out)
      return
    }
    const passesRes = node.arguments.some((a) => ts.isIdentifier(a) && a.text === 'res')
    if (!passesRes) return
    if (!ts.isIdentifier(callee) || !(callee.text in RESPONDER_HELPERS)) {
      throw new Error(`${ctx.rel}: res passed to an unknown responder ${node.getText()}`)
    }
    const helperFile = RESPONDER_HELPERS[callee.text]
    const helper = findFunction(helperFile, callee.text)
    const bindings = new Map<string, string>()
    helper.parameters.forEach((param, index) => {
      const arg = node.arguments[index]
      if (ts.isIdentifier(param.name) && arg && ts.isStringLiteral(arg)) bindings.set(param.name.text, arg.text)
    })
    collectResponses(helper.body!, { ...ctx, rel: helperFile, bindings }, out)
  })
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
  collectResponses(handler.body, {
    rel: ROUTE_FILE,
    bindings: new Map(),
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
