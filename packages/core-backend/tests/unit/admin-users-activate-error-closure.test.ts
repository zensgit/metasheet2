import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ACTIVATE_ERROR_FALLBACK, ACTIVATE_ERROR_POLICY } from '../../src/routes/admin-users'

/**
 * ⚠️ STANDING CAVEAT — THIS FILE IS NOT A BEHAVIOUR PROOF. ⚠️
 *
 * Everything here is a STATIC-CONSISTENCY check between parsed syntax and a runtime table. It
 * asserts what the source says, not what the program does. A source or AST assertion is not
 * evidence about runtime behaviour — that is a separate class of test and it lives in
 * `admin-users-activate-error-mapping.test.ts` (calls `mapActivateError`) and
 * `admin-users-activate-error-leak.test.ts` (drives the route and walks the response body).
 * If those two are deleted, these assertions keep passing over dead code. Read them together.
 *
 * The scan is done with the TypeScript compiler API (`ts.createSourceFile` + node walk) rather
 * than regex, per the owner's ruling: the reason set must come from parsed syntax, not text.
 */

const SRC_ROOT = resolve(__dirname, '../../src')
const USER_ACTIVATE = resolve(SRC_ROOT, 'auth/user-activate.ts')
const ADMIN_USERS = resolve(SRC_ROOT, 'routes/admin-users.ts')

const ACTIVATE_ROUTE_PATH = '/api/admin/users/:id/activate'

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

/** Strip parens / `as T` / `<T>x` / `x!` so `(error as X)?.code` still resolves to `error`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression
    else if (ts.isAsExpression(current)) current = current.expression
    else if (ts.isTypeAssertionExpression(current)) current = current.expression
    else if (ts.isNonNullExpression(current)) current = current.expression
    else if (ts.isSatisfiesExpression(current)) current = current.expression
    else return current
  }
}

function lineOf(node: ts.Node): number {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1
}

/** Every reason passed as `throwCoded(message, <reason>)`, from parsed syntax. */
function collectThrownReasons(sourceFile: ts.SourceFile): {
  reasons: Set<string>
  sites: Array<{ reason: string; line: number }>
  nonLiteral: Array<{ line: number; text: string }>
} {
  const reasons = new Set<string>()
  const sites: Array<{ reason: string; line: number }> = []
  const nonLiteral: Array<{ line: number; text: string }> = []

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = unwrap(node.expression)
    if (!ts.isIdentifier(callee) || callee.text !== 'throwCoded') return

    const arg = node.arguments[1]
    if (arg === undefined) {
      nonLiteral.push({ line: lineOf(node), text: '<missing second argument>' })
      return
    }
    const reasonNode = unwrap(arg)
    if (ts.isStringLiteral(reasonNode) || ts.isNoSubstitutionTemplateLiteral(reasonNode)) {
      reasons.add(reasonNode.text)
      sites.push({ reason: reasonNode.text, line: lineOf(node) })
      return
    }
    // Fail LOUD. Skipping an unreadable site would silently shrink the thrown set and turn the
    // set-equality below into a false pass.
    nonLiteral.push({ line: lineOf(node), text: reasonNode.getText() })
  })

  return { reasons, sites, nonLiteral }
}

function findFunctionBody(sourceFile: ts.SourceFile, name: string): ts.Block {
  let found: ts.Block | undefined
  walk(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) {
      found = node.body
    }
  })
  if (!found) {
    throw new Error(
      `AST scan could not find function '${name}' in ${sourceFile.fileName}. `
      + 'This is a scan failure, NOT a pass: refusing to report a green on an unparsed target.',
    )
  }
  return found
}

/** The `catch (e) { … }` clause of the activate route handler, located by its route-path literal. */
function findActivateCatchClause(sourceFile: ts.SourceFile): ts.CatchClause {
  let routeCall: ts.CallExpression | undefined
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return
    const first = node.arguments[0]
    if (first && ts.isStringLiteral(first) && first.text === ACTIVATE_ROUTE_PATH) {
      routeCall = node
    }
  })
  if (!routeCall) {
    throw new Error(
      `AST scan could not find the route registration for '${ACTIVATE_ROUTE_PATH}' in `
      + `${sourceFile.fileName}. Scan failure, NOT a pass.`,
    )
  }

  let catchClause: ts.CatchClause | undefined
  walk(routeCall, (node) => {
    if (ts.isCatchClause(node)) catchClause = node
  })
  if (!catchClause) {
    throw new Error(
      `AST scan found the '${ACTIVATE_ROUTE_PATH}' registration but no catch clause inside it. `
      + 'Scan failure, NOT a pass.',
    )
  }
  return catchClause
}

/**
 * Destructuring reads a property without a PropertyAccessExpression, so `const { message } = err`
 * would slip past a property-access-only scan. Collect binding names destructured off `receiver`.
 */
function collectDestructuredFrom(scope: ts.Node, receiverName: string): Array<{ names: string[]; line: number; text: string }> {
  const found: Array<{ names: string[]; line: number; text: string }> = []
  walk(scope, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return
    if (!ts.isObjectBindingPattern(node.name)) return
    const init = unwrap(node.initializer)
    if (!ts.isIdentifier(init) || init.text !== receiverName) return
    found.push({
      names: node.name.elements.map((el) => el.propertyName?.getText() ?? el.name.getText()),
      line: lineOf(node),
      text: node.getText(),
    })
  })
  return found
}

/** Property names read off any expression inside `scope` — both `x.name` and `x['name']`. */
function collectPropertyReads(scope: ts.Node): Array<{ name: string; line: number; text: string }> {
  const reads: Array<{ name: string; line: number; text: string }> = []
  walk(scope, (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      reads.push({ name: node.name.text, line: lineOf(node), text: node.getText() })
      return
    }
    if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        reads.push({ name: arg.text, line: lineOf(node), text: node.getText() })
      } else if (arg) {
        // Computed access could be anything, including 'message'. Record it so the assertion
        // below cannot pass by pretending a dynamic read is not a read.
        reads.push({ name: `<computed:${arg.getText()}>`, line: lineOf(node), text: node.getText() })
      }
    }
  })
  return reads
}

/** Property reads whose receiver is exactly the identifier `paramName`. */
function collectReadsOnParam(scope: ts.Node, paramName: string): Array<{ name: string; line: number }> {
  const reads: Array<{ name: string; line: number }> = []
  walk(scope, (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const receiver = unwrap(node.expression)
      if (ts.isIdentifier(receiver) && receiver.text === paramName) {
        reads.push({ name: node.name.text, line: lineOf(node) })
      }
      return
    }
    if (ts.isElementAccessExpression(node)) {
      const receiver = unwrap(node.expression)
      if (!ts.isIdentifier(receiver) || receiver.text !== paramName) return
      const arg = node.argumentExpression
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        reads.push({ name: arg.text, line: lineOf(node) })
      } else if (arg) {
        reads.push({ name: `<computed:${arg.getText()}>`, line: lineOf(node) })
      }
    }
  })
  return reads
}

describe('activate error closure — LAYER 3: static consistency, NOT a behaviour proof', () => {
  const userActivateAst = parse(USER_ACTIVATE)
  const adminUsersAst = parse(ADMIN_USERS)

  it('parses both targets with the TypeScript compiler API (no regex source scanning)', () => {
    // Guards against the scan silently running over an empty/unparsed file and reporting green.
    expect(ts.version.length).toBeGreaterThan(0)
    expect(userActivateAst.statements.length).toBeGreaterThan(0)
    expect(adminUsersAst.statements.length).toBeGreaterThan(0)
  })

  it('reads every throwCoded reason as a string literal, or fails loud', () => {
    const { nonLiteral, sites } = collectThrownReasons(userActivateAst)
    expect(
      nonLiteral,
      'STATIC CHECK (not behaviour): a throwCoded() call passes a non-literal reason, so the '
      + 'AST cannot determine the thrown set. Refusing to report set-equality as satisfied. '
      + `Sites: ${JSON.stringify(nonLiteral)}`,
    ).toEqual([])
    expect(
      sites.length,
      'STATIC CHECK (not behaviour): found no throwCoded() call sites at all — the scan is '
      + 'looking at the wrong file or the callee was renamed.',
    ).toBeGreaterThan(0)
  })

  it('set-equality: {reasons thrown at call sites} === {policy table keys}, ACTIVATE_FAILED excluded from both', () => {
    const { reasons } = collectThrownReasons(userActivateAst)
    const tableKeys = new Set(Object.keys(ACTIVATE_ERROR_POLICY))

    // The fallback is NOT a throwable reason. If it ever appears on either side the equality
    // stops discriminating, so assert its absence explicitly before comparing.
    expect(
      tableKeys.has(ACTIVATE_ERROR_FALLBACK.code),
      `STATIC CHECK (not behaviour): '${ACTIVATE_ERROR_FALLBACK.code}' is the FALLBACK and must `
      + 'not be a key of ACTIVATE_ERROR_POLICY; conflating them makes this closure vacuous.',
    ).toBe(false)
    expect(
      reasons.has(ACTIVATE_ERROR_FALLBACK.code),
      `STATIC CHECK (not behaviour): '${ACTIVATE_ERROR_FALLBACK.code}' is thrown at a call site; `
      + 'it is the fallback for unauthored failures and must not be throwable.',
    ).toBe(false)

    const thrownNotInTable = [...reasons].filter((r) => !tableKeys.has(r)).sort()
    const tableNotThrown = [...tableKeys].filter((k) => !reasons.has(k)).sort()

    expect(
      thrownNotInTable,
      'STATIC CHECK (not behaviour): these reasons are thrown by user-activate.ts but have NO row '
      + `in ACTIVATE_ERROR_POLICY, so they would collapse to the generic fallback: ${JSON.stringify(thrownNotInTable)}`,
    ).toEqual([])
    expect(
      tableNotThrown,
      'STATIC CHECK (not behaviour): these ACTIVATE_ERROR_POLICY keys have NO throwCoded() call '
      + `site, so their row is unreachable and untested: ${JSON.stringify(tableNotThrown)}`,
    ).toEqual([])

    expect(reasons.size).toBe(13)
  })

  it('mapActivateError reads ONLY `.code` off its error parameter — never `.message`', () => {
    let paramName: string | undefined
    walk(adminUsersAst, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'mapActivateError') {
        paramName = node.parameters[0]?.name.getText()
      }
    })
    expect(
      paramName,
      'STATIC CHECK (not behaviour): mapActivateError has no first parameter to scan.',
    ).toBeTruthy()

    const body = findFunctionBody(adminUsersAst, 'mapActivateError')
    const reads = collectReadsOnParam(body, paramName as string)
    const names = [...new Set(reads.map((r) => r.name))].sort()

    expect(
      names,
      'STATIC CHECK (not behaviour): mapActivateError must read exactly one property off the '
      + `thrown value — 'code'. Found: ${JSON.stringify(reads)}. Reading '.message' is the `
      + 'fail-open the owner banned: a forged legal code would smuggle driver text.',
    ).toEqual(['code'])

    expect(
      collectDestructuredFrom(body, paramName as string),
      'STATIC CHECK (not behaviour): mapActivateError destructures its error parameter, which '
      + 'reads properties without a property-access node and would evade the check above.',
    ).toEqual([])
  })

  it('mapActivateError itself never reads a `message` property off ANY receiver (aliasing belt)', () => {
    // `const e = error; e.message` has a receiver of `e`, not the parameter, so the
    // receiver-scoped check above would miss it. Inside this function there is no legitimate
    // `.message` read at all — the table value is spread, never dotted.
    const body = findFunctionBody(adminUsersAst, 'mapActivateError')
    const offenders = collectPropertyReads(body)
      .filter((r) => r.name === 'message' || r.name.startsWith('<computed:'))
    expect(
      offenders,
      "STATIC CHECK (not behaviour): mapActivateError must not READ a 'message' property (nor a "
      + 'computed property name, which could evaluate to it). The response message comes from the '
      + `closed policy table by spread. Found: ${JSON.stringify(offenders)}`,
    ).toEqual([])
  })

  it('the activate catch clause passes the caught error ONLY to mapActivateError — no property read at all', () => {
    // Strongest form of "error.message is never read on the response path": in the catch clause
    // the caught value has exactly one permitted use — being handed whole to mapActivateError.
    // Any other appearance (`err.message`, `const {message} = err`, `${err}` in a body, handing
    // it to a formatter) fails here, so no evasion route needs to be enumerated one by one.
    const catchClause = findActivateCatchClause(adminUsersAst)
    const caughtName = catchClause.variableDeclaration?.name.getText()
    expect(
      caughtName,
      'STATIC CHECK (not behaviour): the activate catch clause binds no variable to scan.',
    ).toBeTruthy()

    const misuses: Array<{ line: number; context: string }> = []
    let mapperCalls = 0
    walk(catchClause.block, (node) => {
      if (!ts.isIdentifier(node) || node.text !== caughtName) return
      const parent = node.parent
      const isMapperArgument = parent
        && ts.isCallExpression(parent)
        && ts.isIdentifier(unwrap(parent.expression))
        && (unwrap(parent.expression) as ts.Identifier).text === 'mapActivateError'
        && parent.arguments.some((a) => unwrap(a) === node)
      if (isMapperArgument) {
        mapperCalls += 1
        return
      }
      misuses.push({ line: lineOf(node), context: parent ? parent.getText() : '<no parent>' })
    })

    expect(
      misuses,
      `STATIC CHECK (not behaviour): inside the POST ${ACTIVATE_ROUTE_PATH} catch clause the `
      + `caught value '${String(caughtName)}' may ONLY be passed to mapActivateError(). Every `
      + 'other use is a potential read of driver-authored text onto the response. '
      + `Found: ${JSON.stringify(misuses)}`,
    ).toEqual([])
    expect(
      mapperCalls,
      'STATIC CHECK (not behaviour): the caught value is never handed to mapActivateError — the '
      + 'scan is anchored to the wrong catch clause, so its green means nothing.',
    ).toBeGreaterThan(0)

    expect(
      collectDestructuredFrom(catchClause.block, caughtName as string),
      'STATIC CHECK (not behaviour): the activate catch clause destructures the caught error.',
    ).toEqual([])
  })

  it('no prefix test survives in mapActivateError (both startsWith calls are deleted)', () => {
    const body = findFunctionBody(adminUsersAst, 'mapActivateError')
    const prefixCalls: Array<{ line: number; text: string }> = []
    walk(body, (node) => {
      if (!ts.isCallExpression(node)) return
      const callee = unwrap(node.expression)
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'startsWith') {
        prefixCalls.push({ line: lineOf(node), text: node.getText() })
      }
    })
    expect(
      prefixCalls,
      'STATIC CHECK (not behaviour): a startsWith() prefix test is back in mapActivateError. '
      + 'Owner ruling 2026-07-27: a prefix test in EITHER the code-selecting branch or the status '
      + `branch is the same fail-open defect. Found: ${JSON.stringify(prefixCalls)}`,
    ).toEqual([])
  })

  it('throwCoded is declared with the ActivateErrorCode type, not a bare string', () => {
    let reasonParamType: string | undefined
    walk(userActivateAst, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'throwCoded') {
        reasonParamType = node.parameters[1]?.type?.getText()
      }
    })
    expect(
      reasonParamType,
      'STATIC CHECK (not behaviour): LAYER 2 requires throwCoded\'s reason parameter to be typed '
      + `ActivateErrorCode so an unauthored reason is a compile error. Found: ${String(reasonParamType)}`,
    ).toBe('ActivateErrorCode')
  })
})
