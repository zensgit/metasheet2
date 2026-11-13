/**
 * Guard over the functions a caller hands to the pull-source write gate (no database).
 *
 * A gate transaction holds an organisation's pull-source lock, which is outside the authorization-input
 * lock order: while it is held, no authorization-input lock may be taken, on the gate's connection or on
 * any other. What the gate module itself does is fixed by its imports. What a caller's function does
 * inside the transaction is fixed here, by shape:
 *
 *  1. The gate module's imports are an exact set: the database module, the pull-source rule module and
 *     the pull-source gate marker module, each with the listed names. One more import fails.
 *  2. Among everything the gate module exports, a parameter of function type exists in two places and
 *     no other: `write` and `options.joins` of `runGatedPullSourceWrite`. A third fails, and so does a
 *     parameter whose type the scan cannot read.
 *  3. Every call of `runGatedPullSourceWrite` in production source hands over functions of these shapes
 *     and nothing else. Anything not listed fails:
 *       - `write`: `(client, context) => client.query(SQL, PARAMS)` and nothing more. SQL is a complete
 *         literal that starts with an INSERT into, or an UPDATE of, the integration table and holds no
 *         row-lock clause, no advisory-lock call and no second statement. PARAMS is a constant computed
 *         before the call, or such constants written in a list. A constant spread into a list is one
 *         whose initial value is an array literal, so the spread iterates an array. `context` is read
 *         in one pair only, both halves together or neither: SQL as `context.gated ? literal : literal`
 *         with PARAMS as `context.gated ? [...C, context.lockedStatus] : C`. C is one constant, the
 *         same in both lists, whose initial value is an array literal. The locked status stands once,
 *         last, and in the gated list alone. The highest `$n` of the gated text is one above that of
 *         the other text, and every `$n` of the two texts is a parameter: neither text holds a
 *         comment, a quote, a `$` inside a name or a `$` that no number follows. Written any other
 *         way, the pair fails, and so does `context.lockedStatus` in parameters the pair does not
 *         choose.
 *       - `joins`: `(lockedStatus) => expression` over its own parameter and literals, with `===`, `!==`,
 *         `&&`, `||`, `??`, `!` and `?:`. No call, no `await`, no other name.
 *     The function must be visible: written in the call, or held in a name. A name is read the way the
 *     compiler binds it at the place it is used, so the function checked is the one the gate is handed
 *     and never an outer one of the same name. The name must be bound by exactly one `const` statement
 *     whose initial value is a function expression. A name bound in any other way fails: a parameter,
 *     plain or destructured; a destructuring declaration; the head of a loop; a catch clause; `var`,
 *     `let` or `using`; a function or class declaration; the name of a function expression; an import;
 *     a second declaration; nothing; or any other declaration. The parameter constants are read the
 *     same way. The options are an object literal with the known keys.
 *  4. The gate's names are reached by a plain named import and a direct call only, so no call is hidden
 *     behind another name.
 *
 * Under 3, the body of a function handed to the gate holds no call but the one statement on the gate's
 * connection: it does not call an authorization-input entry point or a lock helper, directly or through
 * another function, on that connection or on a second one.
 *
 * Not read here: the values a call passes as data, which are the target, the row id, and what the
 * parameter constants hold. An accessor or a serialisation hook on such a value is code of the caller
 * that runs inside the gate transaction, and this guard does not see it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(__dirname, '../../src')
const GATE_MODULE = 'directory/pull-source-write-gate.ts'
const SYNC = 'directory/directory-sync.ts'
const ROUTING_POLICY_ROUTE = 'routes/admin-directory-routing-policy.ts'
const GATED_WRITE = 'runGatedPullSourceWrite'
const GATED_CLEAR = 'runGatedRoutingPolicyClear'
const TABLE = 'directory_integrations'

type SourceFile = { path: string; text: string }

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const

function walk(root: string, directory: string = root, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(root, path, out)
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) && !/\.d\.[cm]?ts$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

/** Every production source file, with no directory left out. */
const SOURCE: SourceFile[] = walk(SRC_ROOT).map((file) => ({
  path: relative(SRC_ROOT, file).split('\\').join('/'),
  text: readFileSync(file, 'utf8'),
}))
const GATE_SOURCE = SOURCE.find((file) => file.path === GATE_MODULE)?.text ?? ''

const parse = (path: string, text: string): ts.SourceFile => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
const isExported = (node: ts.Node): boolean =>
  (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
const isFunctionLike = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(node) || ts.isFunctionExpression(node)

function edited(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, to)
  expect(out, String(from)).not.toBe(text)
  return out
}

// ── 1. the gate module's imports ───────────────────────────────────────────────────────────────────

/** What the gate module imports: module specifier → the names it takes, sorted. */
const GATE_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  '../db/pg': ['query as poolQuery', 'transaction'],
  './pull-source-gate-context': ['runInsidePullSourceGate'],
  './pull-source-rule': [
    'APPROVAL_ROUTING_POLICY_EXISTS_SQL',
    'DirectoryRoutingPolicyRequiredError',
    'PULL_SOURCE_THRESHOLD',
    'PullSourceCountUnavailableError',
    'countActivePullSources',
    'countOtherActivePullSources',
    'directoryOrgLockSql',
    'isApprovalRoutingRequirePolicyEnabled',
  ],
}

/** The imports of a module, and every other way it could load one. */
function importsOf(text: string): { named: Record<string, string[]>; problems: string[] } {
  const source = parse('module.ts', text)
  const named: Record<string, string[]> = {}
  const problems: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : node.moduleSpecifier.getText(source)
      const clause = node.importClause
      if (node.parent !== source) problems.push(`import of ${specifier} is not at module level`)
      if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
        problems.push(`import of ${specifier} does not name what it imports`)
        named[specifier] = [...(named[specifier] ?? []), '*']
      } else {
        const names = clause.namedBindings.elements.map((element) => (element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text))
        named[specifier] = [...(named[specifier] ?? []), ...names].sort()
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) problems.push(`re-export from ${node.moduleSpecifier.getText(source)}`)
    if (ts.isImportEqualsDeclaration(node)) problems.push(`import assignment ${node.name.text}`)
    if (ts.isImportTypeNode(node)) problems.push(`import type expression ${node.getText(source)}`)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      problems.push(`module loaded at run time: ${node.getText(source)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { named, problems }
}

describe('the gate module imports an exact set', () => {
  it('the database module, the rule module and the gate marker module, with the listed names and nothing else', () => {
    expect(GATE_SOURCE.length).toBeGreaterThan(1000)
    const { named, problems } = importsOf(GATE_SOURCE)
    expect(problems).toEqual([])
    expect(named).toEqual(GATE_IMPORTS)
    // The same set as the compiler's own pre-processing reads it, so no import form is missed above.
    expect(ts.preProcessFile(GATE_SOURCE, true, true).importedFiles.map((file) => file.fileName).sort()).toEqual(Object.keys(GATE_IMPORTS).sort())
  })

  const FURTHER_IMPORTS: ReadonlyArray<{ form: string; code: string; expected: RegExp | null }> = [
    { form: 'a user-row lock helper', code: "import { lockUsersForAccessGraphWrite } from './access-graph-mutex'", expected: null },
    { form: 'the authorization-input entry points', code: "import { withAuthorizationInputTransaction } from '../rbac/authorization-input-lock'", expected: null },
    { form: 'the directory sync module', code: "import { DirectoryConflictError } from './directory-sync'", expected: null },
    { form: 'one more name from the rule module', code: "import { directoryOrgLockKey } from './pull-source-rule'", expected: null },
    { form: 'the marker read from the marker module', code: "import { isInsidePullSourceGate } from './pull-source-gate-context'", expected: null },
    { form: 'a type-only import', code: "import type { PoolClient } from 'pg'", expected: null },
    { form: 'a namespace import', code: "import * as mutex from './access-graph-mutex'", expected: /does not name what it imports/ },
    { form: 'a default import', code: "import mutex from './access-graph-mutex'", expected: /does not name what it imports/ },
    { form: 'a side-effect import', code: "import './access-graph-mutex'", expected: /does not name what it imports/ },
    { form: 'a re-export', code: "export { lockUsersForAccessGraphWrite } from './access-graph-mutex'", expected: /re-export from/ },
    { form: 'a runtime require', code: "const mutex = require('./access-graph-mutex')", expected: /module loaded at run time/ },
    { form: 'a dynamic import', code: "export const load = () => import('../rbac/authorization-input-lock')", expected: /module loaded at run time/ },
    { form: 'an import type expression', code: "export type Tx = import('../rbac/authorization-input-lock').AuthorizationInputTx", expected: /import type expression/ },
    { form: 'an import assignment', code: "import mutex = require('./access-graph-mutex')", expected: /import assignment/ },
  ]
  for (const { form, code, expected } of FURTHER_IMPORTS) {
    it(`positive control (${form}) changes the set or is reported`, () => {
      const { named, problems } = importsOf(`${GATE_SOURCE}\n${code}\n`)
      if (expected) expect(problems.join('\n')).toMatch(expected)
      else expect(named).not.toEqual(GATE_IMPORTS)
    })
  }

  it('positive control: a dropped import changes the set', () => {
    const without = edited(GATE_SOURCE, "import { runInsidePullSourceGate } from './pull-source-gate-context'\n", '')
    expect(importsOf(without).named).not.toEqual(GATE_IMPORTS)
  })
})

// ── 2. parameters of function type among the gate module's exports ─────────────────────────────────

/** Type references that are data, not functions. */
const DATA_TYPE_REFERENCES = new Set(['NodeJS.ProcessEnv'])
/** Generic wrappers whose function-typed inputs are those of their type arguments. */
const TRANSPARENT_WRAPPERS = new Set(['Array', 'ReadonlyArray', 'Readonly', 'Partial', 'Required', 'Promise'])
const DATA_KEYWORDS = new Set([
  ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword, ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.UnknownKeyword, ts.SyntaxKind.UndefinedKeyword, ts.SyntaxKind.NullKeyword, ts.SyntaxKind.NeverKeyword,
  ts.SyntaxKind.VoidKeyword, ts.SyntaxKind.SymbolKeyword,
])

interface ModuleSurface {
  /** Names of the functions and classes the module exports. */
  callables: string[]
  /** Every other value the module exports. */
  values: string[]
  /** `function(path)` of every parameter position that has a function type. */
  functionInputs: string[]
  /** Parameter positions and exports the scan cannot read; any entry fails the guard. */
  unreadable: string[]
}

/** The exported surface of a module, read from its own text: no type of another module is resolved. */
function surfaceOf(text: string): ModuleSurface {
  const source = parse('module.ts', text)
  const interfaces = new Map<string, ts.InterfaceDeclaration[]>()
  const aliases = new Map<string, ts.TypeAliasDeclaration>()
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, [...(interfaces.get(statement.name.text) ?? []), statement])
    if (ts.isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement)
  }
  const surface: ModuleSurface = { callables: [], values: [], functionInputs: [], unreadable: [] }

  const classify = (type: ts.TypeNode | undefined, at: string, typeParameters: ReadonlySet<string>, seen: ReadonlySet<string>): void => {
    if (!type) {
      surface.unreadable.push(`${at}: no type annotation`)
      return
    }
    if (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type)) {
      surface.functionInputs.push(at)
      return
    }
    if (ts.isParenthesizedTypeNode(type) || ts.isTypeOperatorNode(type) || ts.isArrayTypeNode(type) || ts.isOptionalTypeNode(type) || ts.isRestTypeNode(type)) {
      classify(ts.isArrayTypeNode(type) ? type.elementType : type.type, at, typeParameters, seen)
      return
    }
    if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
      for (const member of type.types) classify(member, at, typeParameters, seen)
      return
    }
    if (ts.isTupleTypeNode(type)) {
      for (const element of type.elements) classify(ts.isNamedTupleMember(element) ? element.type : element, at, typeParameters, seen)
      return
    }
    if (ts.isLiteralTypeNode(type) || DATA_KEYWORDS.has(type.kind)) return
    if (ts.isTypeLiteralNode(type)) {
      members(type.members, at, typeParameters, seen)
      return
    }
    if (ts.isTypeReferenceNode(type)) {
      reference(type.typeName.getText(source), type.typeArguments, at, typeParameters, seen)
      return
    }
    surface.unreadable.push(`${at}: type ${ts.SyntaxKind[type.kind]} is not read`)
  }

  /** A type named in the module: an interface (with what it extends), an alias, or one of the known names. */
  const reference = (name: string, typeArguments: ts.NodeArray<ts.TypeNode> | undefined, at: string, typeParameters: ReadonlySet<string>, seen: ReadonlySet<string>): void => {
    if (name === 'Function') {
      surface.functionInputs.push(at)
      return
    }
    if (typeParameters.has(name)) {
      surface.unreadable.push(`${at}: a bare type parameter ${name} can be a function`)
      return
    }
    if (DATA_TYPE_REFERENCES.has(name)) return
    if (TRANSPARENT_WRAPPERS.has(name) && typeArguments?.length) {
      for (const argument of typeArguments) classify(argument, at, typeParameters, seen)
      return
    }
    if (seen.has(name)) return
    const next = new Set([...seen, name])
    const declared = interfaces.get(name)
    if (declared) {
      for (const declaration of declared) {
        for (const clause of declaration.heritageClauses ?? []) {
          for (const parent of clause.types) reference(parent.expression.getText(source), parent.typeArguments, at, typeParameters, next)
        }
        members(declaration.members, at, typeParameters, next)
      }
      return
    }
    const alias = aliases.get(name)
    if (alias) {
      classify(alias.type, at, typeParameters, next)
      return
    }
    surface.unreadable.push(`${at}: type ${name} is not declared in the module`)
  }

  const members = (list: ts.NodeArray<ts.TypeElement>, at: string, typeParameters: ReadonlySet<string>, seen: ReadonlySet<string>): void => {
    for (const member of list) {
      const name = member.name ? member.name.getText(source) : '[]'
      const inner = `${at.replace(/\)$/, '')}.${name})`
      if (ts.isPropertySignature(member)) classify(member.type, inner, typeParameters, seen)
      else if (ts.isIndexSignatureDeclaration(member)) classify(member.type, inner, typeParameters, seen)
      else surface.functionInputs.push(ts.isMethodSignature(member) ? inner : at)
    }
  }

  const parameters = (owner: string, declaration: ts.SignatureDeclaration): void => {
    const typeParameters = new Set((declaration.typeParameters ?? []).map((parameter) => parameter.name.text))
    for (const parameter of declaration.parameters) {
      const name = ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText(source)
      if (!ts.isIdentifier(parameter.name)) surface.unreadable.push(`${owner}(${name}): the parameter is destructured`)
      else classify(parameter.type, `${owner}(${name})`, typeParameters, new Set())
    }
  }

  const containsFunction = (node: ts.Node): boolean => {
    let found = false
    const visit = (inner: ts.Node): void => {
      if (isFunctionLike(inner) || ts.isMethodDeclaration(inner) || ts.isClassExpression(inner) || ts.isGetAccessor(inner) || ts.isSetAccessor(inner)) found = true
      ts.forEachChild(inner, visit)
    }
    visit(node)
    return found
  }

  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) surface.unreadable.push('the module has a default or assignment export')
    if (ts.isExportDeclaration(statement)) surface.unreadable.push(`the module exports through a clause: ${statement.getText(source)}`)
    if (!isExported(statement)) continue
    if ((ts.getModifiers(statement as ts.HasModifiers) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      surface.unreadable.push('the module has a default export')
    }
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? '<anonymous>'
      surface.callables.push(name)
      parameters(name, statement)
    } else if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? '<anonymous>'
      surface.callables.push(name)
      for (const member of statement.members) {
        if (ts.isConstructorDeclaration(member)) parameters(`${name}.constructor`, member)
        else if (ts.isMethodDeclaration(member) || ts.isSetAccessor(member)) parameters(`${name}.${member.name.getText(source)}`, member)
        else if (ts.isPropertyDeclaration(member) && member.initializer && containsFunction(member.initializer)) {
          surface.unreadable.push(`${name}.${member.name.getText(source)}: a property holds a function`)
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(source)
        if (declaration.initializer && isFunctionLike(declaration.initializer)) {
          surface.callables.push(name)
          parameters(name, declaration.initializer)
        } else {
          surface.values.push(name)
          if (declaration.initializer && containsFunction(declaration.initializer)) surface.unreadable.push(`${name}: an exported value holds a function`)
          if (declaration.type) classify(declaration.type, `${name}(value)`, new Set(), new Set())
        }
      }
    }
  }
  surface.callables.sort()
  surface.values.sort()
  surface.functionInputs.sort()
  return surface
}

/** The two places a caller hands the gate a function. */
const GATE_FUNCTION_INPUTS = [`${GATED_WRITE}(options.joins)`, `${GATED_WRITE}(write)`]

describe('the gate module takes a function from its caller in two places only', () => {
  it('among everything it exports, a parameter of function type is `write` or `options.joins` of the gated write', () => {
    const surface = surfaceOf(GATE_SOURCE)
    expect(surface.unreadable).toEqual([])
    expect(surface.functionInputs).toEqual(GATE_FUNCTION_INPUTS)
    expect(surface.callables).toEqual([
      'DirectoryRoutingGateBusyError',
      'DirectoryRoutingGateUnavailableError',
      'PullSourceGateRowMovedError',
      'asPullSourceGateFailure',
      GATED_WRITE,
      GATED_CLEAR,
    ])
    expect(surface.values).toEqual([
      'DIRECTORY_ROUTING_GATE_BUSY_CODE',
      'DIRECTORY_ROUTING_GATE_BUSY_MESSAGE',
      'DIRECTORY_ROUTING_GATE_UNAVAILABLE_CODE',
      'DIRECTORY_ROUTING_GATE_UNAVAILABLE_MESSAGE',
      'PULL_SOURCE_GATE_BUSY_SQLSTATES',
      'PULL_SOURCE_GATE_LOCK_TIMEOUT',
      'PULL_SOURCE_GATE_STATEMENT_TIMEOUT',
    ])
  })

  it('the function that opens a gate transaction is private to the module and is the only one that takes a transaction body', () => {
    const source = parse(GATE_MODULE, GATE_SOURCE)
    const opener = source.statements.filter((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'runPullSourceGateTransaction')
    expect(opener).toHaveLength(1)
    expect(isExported(opener[0])).toBe(false)
    // The transaction of the database module is opened in that function and nowhere else.
    const opens: string[] = []
    const visit = (node: ts.Node, owner: string): void => {
      const name = ts.isFunctionDeclaration(node) && node.name ? node.name.text : owner
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'transaction') opens.push(name)
      ts.forEachChild(node, (child) => visit(child, name))
    }
    visit(source, '<module>')
    expect(opens).toEqual(['runPullSourceGateTransaction'])
  })

  const FURTHER_INPUTS: ReadonlyArray<{ form: string; edit: (text: string) => string; expected: RegExp }> = [
    {
      form: 'a row-lock function among the write options',
      edit: (text) => edited(text, '  lockRowId?: string\n', '  lockRowId?: string\n  lockTarget?: (client: PullSourceGateClient) => Promise<string | null>\n'),
      expected: /runGatedPullSourceWrite\(options\.lockTarget\)/,
    },
    {
      form: 'a method among the write options',
      edit: (text) => edited(text, '  lockRowId?: string\n', '  lockRowId?: string\n  before?(client: PullSourceGateClient): Promise<void>\n'),
      expected: /runGatedPullSourceWrite\(options\.before\)/,
    },
    {
      form: 'the transaction opener exported',
      edit: (text) => edited(text, 'async function runPullSourceGateTransaction<T>(', 'export async function runPullSourceGateTransaction<T>('),
      expected: /runPullSourceGateTransaction\(body\)/,
    },
    {
      form: 'a transaction body handed to the policy clear',
      edit: (text) => edited(text, 'export async function runGatedRoutingPolicyClear(orgId: string, purpose: string)', 'export async function runGatedRoutingPolicyClear(orgId: string, purpose: string, after?: (client: PullSourceGateClient) => Promise<void>)'),
      expected: /runGatedRoutingPolicyClear\(after\)/,
    },
    {
      form: 'a function behind a type alias',
      edit: (text) => `${edited(text, '  lockRowId?: string\n', '  lockRowId?: string\n  hook?: GateHook\n')}\ntype GateHook = { run: (() => void) | null }\n`,
      expected: /runGatedPullSourceWrite\(options\.hook\.run\)/,
    },
    {
      form: 'a function behind an interface the options extend',
      edit: (text) => `${edited(text, 'export interface PullSourceWriteGateOptions {', 'export interface PullSourceWriteGateOptions extends GateHooks {')}\ninterface GateHooks { onLocked?: Array<() => void> }\n`,
      expected: /runGatedPullSourceWrite\(options\.onLocked\)/,
    },
    {
      form: 'a further exported function that takes a callback',
      edit: (text) => `${text}\nexport const withGate = async (orgId: string, work: () => Promise<void>): Promise<void> => runPullSourceGateTransaction(orgId, work)\n`,
      expected: /withGate\(work\)/,
    },
    {
      form: 'a callback in a class constructor',
      edit: (text) => `${text}\nexport class GateHandle { constructor(readonly run: Function) {} }\n`,
      expected: /GateHandle\.constructor\(run\)/,
    },
  ]
  for (const { form, edit, expected } of FURTHER_INPUTS) {
    it(`positive control (${form}) is a third function input`, () => {
      const surface = surfaceOf(edit(GATE_SOURCE))
      expect(surface.functionInputs).not.toEqual(GATE_FUNCTION_INPUTS)
      expect(surface.functionInputs.join('\n')).toMatch(expected)
    })
  }

  const UNREADABLE: ReadonlyArray<{ form: string; edit: (text: string) => string; expected: RegExp }> = [
    { form: 'a type declared in another module', edit: (text) => edited(text, '  lockRowId?: string\n', '  lockRowId?: string\n  hook?: ForeignHook\n'), expected: /options\.hook\): type ForeignHook is not declared in the module/ },
    { form: 'the type any', edit: (text) => edited(text, '  lockRowId?: string\n', '  lockRowId?: string\n  hook?: any\n'), expected: /options\.hook\): type AnyKeyword is not read/ },
    { form: 'the type object', edit: (text) => edited(text, '  lockRowId?: string\n', '  lockRowId?: string\n  hook?: object\n'), expected: /options\.hook\): type ObjectKeyword is not read/ },
    { form: 'a bare type parameter', edit: (text) => `${text}\nexport function withAnything<W>(orgId: string, work: W): W { return work }\n`, expected: /withAnything\(work\): a bare type parameter W can be a function/ },
    { form: 'a parameter without a type', edit: (text) => `${text}\nexport function withUntyped(work = () => undefined) { return work }\n`, expected: /withUntyped\(work\): no type annotation/ },
    { form: 'a destructured parameter', edit: (text) => `${text}\nexport function withParts({ work }: { work: () => void }) { return work }\n`, expected: /the parameter is destructured/ },
    { form: 'an exported object that holds a function', edit: (text) => `${text}\nexport const gate = { run: (work: () => void) => work() }\n`, expected: /gate: an exported value holds a function/ },
    { form: 'an export clause', edit: (text) => `${text}\nexport { runPullSourceGateTransaction }\n`, expected: /the module exports through a clause/ },
    { form: 'a default export', edit: (text) => `${text}\nexport default runPullSourceGateTransaction\n`, expected: /default or assignment export/ },
  ]
  for (const { form, edit, expected } of UNREADABLE) {
    it(`positive control (${form}) is reported as unreadable`, () => {
      expect(surfaceOf(edit(GATE_SOURCE)).unreadable.join('\n')).toMatch(expected)
    })
  }
})

// ── 3. the functions each call site hands over ─────────────────────────────────────────────────────

const WRITE_OPTION_KEYS = ['lockRowId', 'joins', 'env'] as const
const SQL_START = new RegExp(`^\\s*(?:INSERT\\s+INTO|UPDATE)\\s+${TABLE}(?![A-Za-z0-9_])`, 'i')
/** What a write statement may not contain: a row-lock clause, an advisory-lock call, a table lock, a second statement. */
const SQL_FORBIDDEN: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: 'a row-lock clause', pattern: /\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/i },
  { what: 'an advisory-lock call', pattern: /pg_(?:try_)?advisory/i },
  { what: 'a table lock', pattern: /\bLOCK\s+TABLE\b/i },
  { what: 'a second statement', pattern: /;/ },
]

interface CallSite { path: string; line: number; callee: string; owner: string }

function ownerOf(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text
  }
  return '<module>'
}

const unwrap = (node: ts.Expression): ts.Expression => {
  let cur = node
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression
  return cur
}

const CHECKERS = new WeakMap<ts.SourceFile, ts.TypeChecker>()

/**
 * The compiler's own name resolution over one source file, built from the text in hand and never from
 * the disk. No import is followed and no library is loaded, so what a name is bound to is read from
 * that text alone.
 */
function checkerOf(source: ts.SourceFile): ts.TypeChecker {
  const known = CHECKERS.get(source)
  if (known) return known
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === source.fileName ? source : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === source.fileName,
    readFile: (name) => (name === source.fileName ? source.text : undefined),
  }
  const program = ts.createProgram([source.fileName], { allowJs: true, noResolve: true, noLib: true, types: [], target: ts.ScriptTarget.Latest }, host)
  if (program.getSourceFile(source.fileName) !== source) throw new Error(`the compiler did not read ${source.fileName} from the text it was given`)
  const checker = program.getTypeChecker()
  CHECKERS.set(source, checker)
  return checker
}

/**
 * The declaration that binds a name at the place it is used, when that is exactly one `const` statement;
 * otherwise how the name is bound instead. The binding is the one the compiler resolves, so a nearer
 * binding of the same name is the one judged, in whatever form it is written.
 */
function constStatementOf(identifier: ts.Identifier): ts.VariableDeclaration | string {
  const declarations = checkerOf(identifier.getSourceFile()).getSymbolAtLocation(identifier)?.declarations ?? []
  if (declarations.length === 0) return 'does not resolve to a declaration'
  if (declarations.length > 1) return 'has more than one declaration'
  const declaration = declarations[0]
  if (ts.isBindingElement(declaration)) {
    let root: ts.Node = declaration
    while (ts.isBindingElement(root) || ts.isObjectBindingPattern(root) || ts.isArrayBindingPattern(root)) root = root.parent
    return ts.isParameter(root) ? 'is bound by a destructured parameter' : 'is bound by a destructuring declaration'
  }
  if (ts.isParameter(declaration)) return 'is a parameter'
  if (ts.isFunctionDeclaration(declaration)) return 'is a function declaration'
  if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration) || ts.isImportEqualsDeclaration(declaration)) return 'is an import'
  if (!ts.isVariableDeclaration(declaration)) return `is not bound by a const statement (${ts.SyntaxKind[declaration.kind]})`
  if (ts.isCatchClause(declaration.parent)) return 'is the variable of a catch clause'
  if (!ts.isVariableStatement(declaration.parent.parent)) return 'is bound in the head of a loop'
  if ((declaration.parent.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const) return 'is not declared with const'
  return declaration
}

/** What follows the way a name is bound, in the two sentences that name what was expected instead. */
const NOT_A_WRITTEN_FUNCTION: Readonly<Record<string, string>> = {
  'is a parameter': ', not a function written here',
  'is a function declaration': ', not a constant holding a function expression',
}

/**
 * The function an argument is: written in place, or the initial value of the one `const` statement that
 * binds the name (a `const` cannot be assigned again). Anything else is not resolved.
 */
function resolveFunction(argument: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | string {
  const expression = unwrap(argument)
  if (isFunctionLike(expression)) return expression
  if (!ts.isIdentifier(expression)) return `${ts.SyntaxKind[expression.kind]} is not a function written in the call or a constant of the calling function`
  const bound = constStatementOf(expression)
  if (typeof bound === 'string') return `${expression.text} ${bound}${NOT_A_WRITTEN_FUNCTION[bound] ?? ''}`
  const initializer = bound.initializer ? unwrap(bound.initializer) : undefined
  if (!initializer || !isFunctionLike(initializer)) return `${expression.text} is not initialised with a function expression`
  return initializer
}

const plainParameters = (fn: ts.ArrowFunction | ts.FunctionExpression, max: number): string[] | string => {
  if (fn.parameters.length > max) return `takes ${fn.parameters.length} parameters`
  const names: string[] = []
  for (const parameter of fn.parameters) {
    if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) return 'has a parameter that is not a plain name'
    names.push(parameter.name.text)
  }
  return names
}

/** The single expression a function returns, or why it has none. */
function soleExpression(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression | string {
  if ((ts.getModifiers(fn) ?? []).length > 0 || fn.asteriskToken) return 'is async or a generator'
  if (!ts.isBlock(fn.body)) return unwrap(fn.body)
  if (fn.body.statements.length !== 1) return `has ${fn.body.statements.length} statements`
  const only = fn.body.statements[0]
  if (!ts.isReturnStatement(only) || !only.expression) return 'does not consist of one return'
  return unwrap(only.expression)
}

const isLiteralText = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
const isMemberOf = (node: ts.Expression, object: string | undefined, member: string): boolean =>
  object !== undefined && ts.isPropertyAccessExpression(node) && !node.questionDotToken && ts.isIdentifier(node.expression) && node.expression.text === object && node.name.text === member

/**
 * Why an expression is not a constant computed before the call; empty when it is one: a name bound by
 * exactly one `const` statement whose initial value is not a function. A constant that is spread is
 * iterated inside the function, so its initial value must be an array literal.
 */
function notAConstant(node: ts.Expression, spread = false): string {
  if (!ts.isIdentifier(node)) return 'it is not a name'
  const bound = constStatementOf(node)
  if (typeof bound === 'string') return `${node.text} ${bound}`
  const initializer = bound.initializer ? unwrap(bound.initializer) : undefined
  if (!initializer) return `${node.text} has no initial value`
  if (isFunctionLike(initializer) || ts.isClassExpression(initializer)) return `${node.text} holds a function`
  if (spread && !ts.isArrayLiteralExpression(initializer)) return `${node.text} is spread and its initial value is not an array literal`
  return ''
}

/** The highest `$n` a statement text names; 0 when it names none. */
const highestPlaceholder = (text: string): number => Math.max(0, ...(text.match(/\$\d+/g) ?? []).map((name) => Number(name.slice(1))))
/**
 * Where a `$n` in a statement text is not a parameter of the statement: in a comment, in a quoted text
 * or a quoted name, in a name that is not quoted, in a dollar-quoted text. A text that holds none of
 * the marks below holds no such place, so every `$n` in it is a parameter.
 */
const NOT_A_PARAMETER: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: 'a line comment', pattern: /--/ },
  { what: 'a block comment', pattern: /\/\*/ },
  { what: 'a single quote', pattern: /'/ },
  { what: 'a double quote', pattern: /"/ },
  { what: 'a `$` inside a name', pattern: /(?<=[A-Za-z0-9_\u0080-\uffff])\$/ },
  { what: 'a `$` that no number follows', pattern: /\$(?![0-9])/ },
]

/** Why a function is not a `write` of the allowed shape; empty when it is. */
function writeShapeProblems(fn: ts.ArrowFunction | ts.FunctionExpression): string[] {
  const names = plainParameters(fn, 2)
  if (typeof names === 'string') return [`write ${names}`]
  const [client, context] = names
  const body = soleExpression(fn)
  if (typeof body === 'string') return [`write ${body}`]
  if (!ts.isCallExpression(body) || body.questionDotToken || !isMemberOf(body.expression, client, 'query')) {
    return ['write is not one call of query on the connection it is given']
  }
  if (body.arguments.length < 1 || body.arguments.length > 2) return [`write passes ${body.arguments.length} arguments to query`]
  const problems: string[] = []
  const sql = unwrap(body.arguments[0])
  const params = body.arguments.length === 2 ? unwrap(body.arguments[1]) : undefined
  // `context.gated` chooses the statement and the parameters together, or neither of them.
  if (ts.isConditionalExpression(sql) !== (params !== undefined && ts.isConditionalExpression(params))) {
    problems.push('the statement and the parameters are not chosen by context.gated together')
  }

  /** The text of a statement written as a complete literal; null, with the reason reported, when it is not one. */
  const sqlText = (node: ts.Expression): string | null => {
    if (!isLiteralText(node)) {
      problems.push(`the statement is not a complete literal (${ts.SyntaxKind[node.kind]})`)
      return null
    }
    if (!SQL_START.test(node.text)) problems.push(`the statement does not start with an INSERT into, or an UPDATE of, ${TABLE}`)
    for (const { what, pattern } of SQL_FORBIDDEN) if (pattern.test(node.text)) problems.push(`the statement holds ${what}`)
    return node.text
  }
  if (ts.isConditionalExpression(sql)) {
    if (!isMemberOf(unwrap(sql.condition), context, 'gated')) problems.push('the statement is chosen by something other than context.gated')
    const gated = sqlText(unwrap(sql.whenTrue))
    const plain = sqlText(unwrap(sql.whenFalse))
    // What is compared below is the parameters of the two texts, so each `$n` in them must be one.
    for (const [where, text] of [['inside', gated], ['outside', plain]] as const) {
      for (const { what, pattern } of NOT_A_PARAMETER) {
        if (text !== null && pattern.test(text)) problems.push(`the statement ${where} a gate transaction holds ${what}, where a $n is not a parameter`)
      }
    }
    // The gated text takes the locked status as one parameter more, after the parameters of the other text.
    if (gated !== null && plain !== null && highestPlaceholder(gated) !== highestPlaceholder(plain) + 1) {
      problems.push(`the statement inside a gate transaction does not name exactly one parameter more than the statement outside one ($${highestPlaceholder(gated)} against $${highestPlaceholder(plain)})`)
    }
  } else {
    sqlText(sql)
  }

  /** Parameters `context.gated` does not choose: a constant, or constants written in a list. Nothing is read off `context`. */
  const parameterList = (node: ts.Expression): void => {
    const whole = notAConstant(node)
    if (!whole) return
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        const why = ts.isSpreadElement(element) ? notAConstant(unwrap(element.expression), true) : notAConstant(element)
        if (why) problems.push(`a parameter is computed inside write (${ts.SyntaxKind[element.kind]}): ${why}`)
      }
      return
    }
    problems.push(`the parameters are not a constant computed before the call (${ts.SyntaxKind[node.kind]}): ${whole}`)
  }

  /** The one pair of parameter lists `context.gated` chooses between: `[...C, context.lockedStatus]` and `C`. */
  const chosenParameters = (chosen: ts.ConditionalExpression): void => {
    if (!isMemberOf(unwrap(chosen.condition), context, 'gated')) problems.push('the parameters are chosen by something other than context.gated')
    const gated = unwrap(chosen.whenTrue)
    const plain = unwrap(chosen.whenFalse)
    let spread: ts.Identifier | undefined
    if (!ts.isArrayLiteralExpression(gated)) {
      problems.push(`the parameters inside a gate transaction are not a list written in place (${ts.SyntaxKind[gated.kind]})`)
    } else if (gated.elements.length !== 2) {
      problems.push(`the parameters inside a gate transaction are ${gated.elements.length} elements, not one constant spread and then context.lockedStatus`)
    } else {
      const [first, last] = gated.elements
      const operand = ts.isSpreadElement(first) ? unwrap(first.expression) : undefined
      if (operand && ts.isIdentifier(operand)) spread = operand
      else problems.push('the parameters inside a gate transaction do not start with one constant spread')
      if (!isMemberOf(last, context, 'lockedStatus')) problems.push('the parameters inside a gate transaction do not end with context.lockedStatus')
    }
    if (!ts.isIdentifier(plain)) {
      problems.push(`the parameters outside a gate transaction are not a constant on its own (${ts.SyntaxKind[plain.kind]})`)
    } else if (spread && spread.text !== plain.text) {
      problems.push(`the parameters are built on two constants: ${spread.text} inside a gate transaction, ${plain.text} outside one`)
    }
    // The two names stand in one expression, so one name is one binding and is read once. It is spread,
    // so its initial value must be an array literal.
    const built: ts.Identifier[] = []
    if (spread) built.push(spread)
    if (ts.isIdentifier(plain) && plain.text !== spread?.text) built.push(plain)
    for (const name of built) {
      const why = notAConstant(name, true)
      if (why) problems.push(`the parameters chosen by context.gated are not built on a list computed before the call: ${why}`)
    }
  }
  if (params !== undefined) {
    if (ts.isConditionalExpression(params)) chosenParameters(params)
    else parameterList(params)
  }
  return problems
}

const JOINS_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
])

/** Why a function is not a `joins` of the allowed shape; empty when it is. */
function joinsShapeProblems(fn: ts.ArrowFunction | ts.FunctionExpression): string[] {
  const names = plainParameters(fn, 1)
  if (typeof names === 'string') return [`joins ${names}`]
  const body = soleExpression(fn)
  if (typeof body === 'string') return [`joins ${body}`]
  const problems: string[] = []
  const check = (node: ts.Expression): void => {
    const expression = unwrap(node)
    if (ts.isIdentifier(expression)) {
      if (!names.includes(expression.text)) problems.push(`joins reads ${expression.text}`)
    } else if (isLiteralText(expression) || ts.isNumericLiteral(expression)
      || expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword) {
      // a literal
    } else if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
      check(expression.operand)
    } else if (ts.isBinaryExpression(expression) && JOINS_OPERATORS.has(expression.operatorToken.kind)) {
      check(expression.left)
      check(expression.right)
    } else if (ts.isConditionalExpression(expression)) {
      check(expression.condition)
      check(expression.whenTrue)
      check(expression.whenFalse)
    } else {
      problems.push(`joins contains ${ts.SyntaxKind[expression.kind]}`)
    }
  }
  check(body)
  return problems
}

interface GateUse { sites: CallSite[]; problems: string[] }

/** Every use of the gate's two entry functions in the given files, and what is wrong with each. */
function gateUse(files: SourceFile[]): GateUse {
  const sites: CallSite[] = []
  const problems: string[] = []
  for (const file of files) {
    if (!file.text.includes(GATED_WRITE) && !file.text.includes(GATED_CLEAR)) continue
    const source = parse(file.path, file.text)
    const at = (node: ts.Node): string => `${file.path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
    const visit = (node: ts.Node): void => {
      const named = ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null
      if (named === GATED_WRITE || named === GATED_CLEAR) {
        const parent = node.parent
        const isCall = ts.isIdentifier(node) && ts.isCallExpression(parent) && parent.expression === node
        const isPlainImport = ts.isIdentifier(node) && ts.isImportSpecifier(parent) && parent.name === node && parent.propertyName === undefined
        const isDeclaration = file.path === GATE_MODULE && ts.isIdentifier(node) && ts.isFunctionDeclaration(parent) && parent.name === node
        if (isCall) {
          sites.push({ path: file.path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, callee: named, owner: ownerOf(node) })
          for (const problem of callProblems(parent, named)) problems.push(`${at(node)} ${problem}`)
        } else if (!isPlainImport && !isDeclaration) {
          problems.push(`${at(node)} uses ${named} other than by importing it under its own name and calling it`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { sites, problems }
}

function callProblems(call: ts.CallExpression, callee: string): string[] {
  if (call.arguments.some((argument) => ts.isSpreadElement(argument))) return ['spreads its arguments']
  if (callee === GATED_CLEAR) {
    return call.arguments.length === 2 && !call.arguments.some((argument) => isFunctionLike(unwrap(argument)))
      ? []
      : ['is not a policy clear of an organisation and a purpose']
  }
  if (call.arguments.length < 2 || call.arguments.length > 3) return [`passes ${call.arguments.length} arguments`]
  const problems: string[] = []
  const write = resolveFunction(call.arguments[1])
  if (typeof write === 'string') problems.push(`write: ${write}`)
  else problems.push(...writeShapeProblems(write))
  if (call.arguments.length === 3) {
    const options = unwrap(call.arguments[2])
    if (!ts.isObjectLiteralExpression(options)) return [...problems, 'options are not an object literal']
    for (const property of options.properties) {
      const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null
      if (key === null) {
        problems.push('options hold a spread or a computed key')
        continue
      }
      if (!(WRITE_OPTION_KEYS as readonly string[]).includes(key)) {
        problems.push(`options hold the unknown key ${key}`)
        continue
      }
      if (!ts.isPropertyAssignment(property)) {
        problems.push(`options hold ${key} in a form other than key: value`)
        continue
      }
      if (key !== 'joins') {
        if (isFunctionLike(unwrap(property.initializer))) problems.push(`options.${key} is a function`)
        continue
      }
      const joins = resolveFunction(property.initializer)
      if (typeof joins === 'string') problems.push(`joins: ${joins}`)
      else problems.push(...joinsShapeProblems(joins))
    }
  }
  return problems
}

/** A caller module around one call of the gated write, for the controls below. */
function callerWith(write: string, options?: string, prelude = ''): SourceFile[] {
  const text = [
    "import { runGatedPullSourceWrite, type PullSourceGateClient, type PullSourceWriteContext } from '../directory/pull-source-write-gate'",
    "import { lockUsersForAccessGraphWrite } from '../directory/access-graph-mutex'",
    "import { enterAuthorizationInputTransaction, withAuthorizationInputTransaction } from '../rbac/authorization-input-lock'",
    "import { pool, query, transaction } from '../db/pg'",
    'declare const plan: never',
    'declare const target: never',
    'declare const userIds: string[]',
    'async function lockThenWrite(client: PullSourceGateClient) { await lockUsersForAccessGraphWrite(client as never, userIds); return client.query(`UPDATE directory_integrations SET name = $1`, []) }',
    'async function lockOnSecondConnection() { return transaction((other) => lockUsersForAccessGraphWrite(other as never, userIds)) }',
    'async function enterIndirectly() { return withAuthorizationInputTransaction(plan, async () => 1) }',
    'export async function syntheticEntry(injected: (client: PullSourceGateClient) => Promise<unknown>) {',
    '  const params: unknown[] = [1]',
    '  let rebound = (client: PullSourceGateClient) => client.query(`UPDATE directory_integrations SET name = $1`, params)',
    prelude,
    `  return runGatedPullSourceWrite(target, ${write}${options === undefined ? '' : `, ${options}`})`,
    '}',
  ].join('\n')
  return [{ path: 'directory/synthetic-entry.ts', text }]
}

const INSERT = '`INSERT INTO directory_integrations (org_id) VALUES ($1) RETURNING id`'
const UPDATE = '`UPDATE directory_integrations SET name = $1 WHERE id = $2`'
/** The same update as it runs inside a gate transaction: one parameter more, the status read under the row lock. */
const GATED_UPDATE = '`UPDATE directory_integrations SET name = $1 WHERE id = $2 AND status = $3`'
/** Problems without the place they are reported at. */
const unplaced = (problems: string[]): string[] => problems.map((problem) => problem.replace(/^\S+:\d+ /, ''))

describe('every function handed to the gate has an allowed shape', () => {
  it('production source calls the gated write twice and the policy clear once, and each call passes', () => {
    const use = gateUse(SOURCE)
    expect(SOURCE.length).toBeGreaterThan(100)
    expect(use.sites.map((site) => `${site.path}:${site.owner}:${site.callee}`).sort()).toEqual([
      `${SYNC}:createDirectoryIntegration:${GATED_WRITE}`,
      `${SYNC}:updateDirectoryIntegration:${GATED_WRITE}`,
      `${ROUTING_POLICY_ROUTE}:${'adminDirectoryRoutingPolicyRouter'}:${GATED_CLEAR}`,
    ].sort())
    expect(use.problems).toEqual([])
  })

  it('the two production writes are read as the functions they are: one statement each, on the connection they are given', () => {
    const file = SOURCE.find((entry) => entry.path === SYNC)!
    const source = parse(file.path, file.text)
    const found: Array<{ owner: string; sql: string[]; joins: boolean }> = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === GATED_WRITE) {
        const write = resolveFunction(node.arguments[1])
        expect(typeof write).not.toBe('string')
        const body = soleExpression(write as ts.ArrowFunction)
        const sql: string[] = []
        const collect = (inner: ts.Node): void => {
          if (isLiteralText(inner)) sql.push(inner.text.trim().split(/\s+/).slice(0, 3).join(' '))
          ts.forEachChild(inner, collect)
        }
        collect(body as ts.Expression)
        found.push({ owner: ownerOf(node), sql, joins: node.arguments.length === 3 && node.arguments[2].getText(source).includes('joins:') })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(found).toEqual([
      { owner: 'createDirectoryIntegration', sql: ['INSERT INTO directory_integrations'], joins: false },
      { owner: 'updateDirectoryIntegration', sql: ['UPDATE directory_integrations SET', 'UPDATE directory_integrations SET'], joins: true },
    ])
  })

  const ALLOWED: ReadonlyArray<{ form: string; write: string; options?: string; prelude?: string }> = [
    { form: 'an insert written in the call', write: `(client) => client.query(${INSERT}, params)` },
    { form: 'an update held in a constant of the calling function', write: 'update', prelude: `  const update = (client: PullSourceGateClient) => client.query(${UPDATE}, params)` },
    { form: 'a function expression with one return', write: `function (client) { return client.query(${UPDATE}, params) }` },
    { form: 'a statement without parameters', write: `(client) => client.query(${INSERT})` },
    {
      form: 'a statement and parameters chosen by context.gated together: one parameter more inside a gate transaction, the locked status, last',
      write: `(client, context) => client.query(context.gated ? ${GATED_UPDATE} : ${UPDATE}, context.gated ? [...params, context.lockedStatus] : params)`,
    },
    // The parameters of the two texts are what they name, and the highest is compared: not the last one
    // named, and not how many times one is named.
    {
      form: 'the pair with the parameters of its texts named in another order',
      write: '(client, context) => client.query(context.gated ? `UPDATE directory_integrations SET name = $2 WHERE id = $1 AND status = $3` : `UPDATE directory_integrations SET name = $2 WHERE id = $1`, context.gated ? [...params, context.lockedStatus] : params)',
    },
    {
      form: 'the pair with the one parameter more named twice',
      write: `(client, context) => client.query(context.gated ? \`UPDATE directory_integrations SET name = $1 WHERE id = $2 AND status = $3 AND $3 IS NOT NULL\` : ${UPDATE}, context.gated ? [...params, context.lockedStatus] : params)`,
    },
    {
      form: 'the pair with parameters against a cast, a bracket and an operator',
      write: '(client, context) => client.query(context.gated ? `UPDATE directory_integrations SET name = $1::text WHERE id IN ($2) AND status=$3` : `UPDATE directory_integrations SET name = $1::text WHERE id IN ($2)`, context.gated ? [...params, context.lockedStatus] : params)',
    },
    { form: 'constants written in a list, one of them spread', write: `(client) => client.query(${UPDATE}, [...params, extra])`, prelude: '  const extra = 2' },
    { form: 'a double-quoted literal', write: '(client) => client.query("UPDATE directory_integrations SET name = $1", params)' },
    { form: 'a judgement over the locked status', write: `(client) => client.query(${UPDATE}, params)`, options: "{ lockRowId: 'id', joins: (lockedStatus) => lockedStatus !== null && lockedStatus !== 'active' }" },
    { form: 'a judgement that is a constant answer', write: `(client) => client.query(${UPDATE}, params)`, options: '{ joins: () => false, env: process.env }' },
    { form: 'a judgement held in a constant', write: `(client) => client.query(${UPDATE}, params)`, options: '{ joins: judge }', prelude: "  const judge = (status: string | null) => (status === 'paused' ? true : !status)" },
  ]
  for (const { form, write, options, prelude } of ALLOWED) {
    it(`control (${form}) passes`, () => {
      const use = gateUse(callerWith(write, options, prelude))
      expect(use.sites).toHaveLength(1)
      expect(use.problems).toEqual([])
    })
  }

  const REFUSED_WRITES: ReadonlyArray<{ form: string; write: string; prelude?: string; expected: RegExp }> = [
    // The five ways a caller's function could take an authorization-input lock.
    { form: 'an authorization-input entry point called in the body', write: `async (client) => { await withAuthorizationInputTransaction(plan, async () => 1); return client.query(${UPDATE}, params) }`, expected: /write is async or a generator/ },
    { form: 'the takeover entry point on the gate connection', write: `(client) => enterAuthorizationInputTransaction(client as never, plan, [], async () => client.query(${UPDATE}, params))`, expected: /write is not one call of query on the connection it is given/ },
    { form: 'a user-row lock helper called in the body', write: `(client) => { lockUsersForAccessGraphWrite(client as never, userIds); return client.query(${UPDATE}, params) }`, expected: /write has 2 statements/ },
    { form: 'an entry point reached through another function', write: '() => enterIndirectly()', expected: /write is not one call of query on the connection it is given/ },
    { form: 'an entry point on a second connection', write: `(client) => transaction((other) => other.query(${UPDATE}, params))`, expected: /write is not one call of query on the connection it is given/ },
    { form: 'a lock helper reached through another function, on the gate connection', write: '(client) => lockThenWrite(client)', expected: /write is not one call of query on the connection it is given/ },
    { form: 'a lock helper reached through another function, on a second connection', write: '() => lockOnSecondConnection()', expected: /write is not one call of query on the connection it is given/ },
    { form: 'a named function that locks first', write: 'lockThenWrite', expected: /write: lockThenWrite is a function declaration/ },
    // Statements on anything but the connection the gate hands over.
    { form: 'the pool instead of the gate connection', write: `() => query(${UPDATE}, params)`, expected: /write is not one call of query on the connection it is given/ },
    { form: 'a pool object', write: `() => pool.query(${UPDATE}, params)`, expected: /write is not one call of query on the connection it is given/ },
    { form: 'the second parameter used as the connection', write: `(client, context) => (context as never as PullSourceGateClient).query(${UPDATE}, params)`, expected: /write is not one call of query on the connection it is given/ },
    { form: 'another method of the connection', write: `(client) => (client as never as { release: (sql: string) => Promise<unknown> }).release(${UPDATE})`, expected: /write is not one call of query on the connection it is given/ },
    { form: 'an element access', write: `(client) => client['query'](${UPDATE}, params)`, expected: /write is not one call of query on the connection it is given/ },
    { form: 'an optional call', write: `(client) => client?.query(${UPDATE}, params)`, expected: /write is not one call of query on the connection it is given/ },
    // More than the one statement.
    { form: 'two statements', write: `(client) => Promise.all([client.query(${UPDATE}, params), client.query(${INSERT}, params)])`, expected: /write is not one call of query on the connection it is given/ },
    { form: 'a statement then a mapping', write: `(client) => client.query(${UPDATE}, params).then((result) => result.rows[0])`, expected: /write is not one call of query on the connection it is given/ },
    { form: 'an awaited statement', write: `async (client) => (await client.query(${UPDATE}, params)).rows`, expected: /write is async or a generator/ },
    { form: 'an async function', write: `async (client) => client.query(${UPDATE}, params)`, expected: /write is async or a generator/ },
    { form: 'a body with a declaration', write: `(client) => { const sql = ${UPDATE}; return client.query(sql, params) }`, expected: /write has 2 statements/ },
    { form: 'a body that returns nothing', write: `(client) => { void client.query(${UPDATE}, params) }`, expected: /write does not consist of one return/ },
    { form: 'a third argument to query', write: `(client) => client.query(${UPDATE}, params, 1)`, expected: /write passes 3 arguments to query/ },
    { form: 'three parameters', write: `(client, context, extra) => client.query(${UPDATE}, params)`, expected: /write takes 3 parameters/ },
    { form: 'a destructured parameter', write: `({ query: run }) => run(${UPDATE}, params)`, expected: /write has a parameter that is not a plain name/ },
    { form: 'a default parameter', write: `(client, context = { gated: false, lockedStatus: null, joined: false }) => client.query(${UPDATE}, params)`, expected: /write has a parameter that is not a plain name/ },
    // The statement text.
    { form: 'a row-lock read', write: '(client) => client.query(`SELECT id FROM directory_integrations WHERE id = $1 FOR UPDATE`, params)', expected: /the statement does not start with an INSERT into, or an UPDATE of, directory_integrations[\s\S]*the statement holds a row-lock clause/ },
    { form: 'an update with a FOR SHARE subquery', write: '(client) => client.query(`UPDATE directory_integrations SET name = (SELECT name FROM users WHERE id = $1 FOR SHARE)`, params)', expected: /the statement holds a row-lock clause/ },
    { form: 'an update with a FOR NO KEY UPDATE subquery', write: '(client) => client.query(`UPDATE directory_integrations SET name = (SELECT name FROM users WHERE id = $1 for no key update)`, params)', expected: /the statement holds a row-lock clause/ },
    { form: 'an insert that takes an advisory lock', write: '(client) => client.query(`INSERT INTO directory_integrations (org_id) SELECT $1 FROM (SELECT pg_advisory_xact_lock(1)) AS held`, params)', expected: /the statement holds an advisory-lock call/ },
    { form: 'a second statement', write: '(client) => client.query(`UPDATE directory_integrations SET name = $1; SELECT 1`, params)', expected: /the statement holds a second statement/ },
    { form: 'a table lock', write: '(client) => client.query(`UPDATE directory_integrations SET name = $1 /* then */ ; LOCK TABLE users`, params)', expected: /the statement holds a table lock/ },
    { form: 'another table', write: '(client) => client.query(`UPDATE users SET name = $1`, params)', expected: /the statement does not start with an INSERT into, or an UPDATE of, directory_integrations/ },
    { form: 'a table whose name only starts the same', write: '(client) => client.query(`UPDATE directory_integrations_archive SET name = $1`, params)', expected: /the statement does not start with/ },
    { form: 'a delete', write: '(client) => client.query(`DELETE FROM directory_integrations WHERE id = $1`, params)', expected: /the statement does not start with/ },
    { form: 'a CTE in front', write: '(client) => client.query(`WITH held AS (SELECT 1) UPDATE directory_integrations SET name = $1`, params)', expected: /the statement does not start with/ },
    { form: 'a template with a substitution', write: '(client, context) => client.query(`UPDATE directory_integrations SET name = $1${context.gated ? " AND status = $2" : ""}`, params)', expected: /the statement is not a complete literal \(TemplateExpression\)/ },
    { form: 'a concatenated statement', write: "(client) => client.query('UPDATE directory_integrations ' + 'SET name = $1', params)", expected: /the statement is not a complete literal \(BinaryExpression\)/ },
    { form: 'a statement held in a name', write: '(client) => client.query(sql, params)', prelude: `  const sql = ${UPDATE}`, expected: /the statement is not a complete literal \(Identifier\)/ },
    // The parameters.
    { form: 'parameters built in the body', write: `(client) => client.query(${UPDATE}, [JSON.stringify(userIds)])`, expected: /a parameter is computed inside write \(CallExpression\)/ },
    { form: 'parameters returned by a call', write: `(client) => client.query(${UPDATE}, userIds.slice())`, expected: /the parameters are not a constant computed before the call \(CallExpression\)/ },
    { form: 'a parameter read off the context other than the locked status', write: `(client, context) => client.query(${UPDATE}, [...params, context.joined])`, expected: /a parameter is computed inside write \(PropertyAccessExpression\)/ },
    { form: 'the locked status as the parameters themselves', write: `(client, context) => client.query(${UPDATE}, context.lockedStatus as never)`, expected: /the parameters are not a constant computed before the call \(PropertyAccessExpression\): it is not a name/ },
    { form: 'the context as the parameters themselves', write: `(client, context) => client.query(${UPDATE}, context as never)`, expected: /the parameters are not a constant computed before the call \(Identifier\): context is a parameter/ },
    { form: 'the context among the parameters', write: `(client, context) => client.query(${UPDATE}, [...params, context])`, expected: /a parameter is computed inside write \(Identifier\): context is a parameter/ },
    { form: 'the context spread into the parameters', write: `(client, context) => client.query(${UPDATE}, [...(context as never as unknown[])])`, expected: /a parameter is computed inside write \(SpreadElement\): context is a parameter/ },
    { form: 'a function among the parameters', write: `(client) => client.query(${UPDATE}, [lockThenWrite])`, expected: /a parameter is computed inside write \(Identifier\)/ },
    { form: 'parameters that are a parameter of the calling function', write: `(client) => client.query(${UPDATE}, injected as never)`, expected: /the parameters are not a constant computed before the call/ },
    { form: 'a constant among the parameters that holds a function', write: `(client) => client.query(${UPDATE}, [holder])`, prelude: '  const holder = () => userIds', expected: /a parameter is computed inside write \(Identifier\): holder holds a function/ },
    {
      form: 'a spread of a constant that is an object with its own iteration',
      write: `(client) => client.query(${UPDATE}, [...iterable])`,
      prelude: '  const iterable = { *[Symbol.iterator]() { yield userIds } }',
      expected: /a parameter is computed inside write \(SpreadElement\): iterable is spread and its initial value is not an array literal/,
    },
    {
      form: 'a spread of a constant that holds a call result',
      write: `(client) => client.query(${UPDATE}, [...copied])`,
      prelude: '  const copied = userIds.slice()',
      expected: /a parameter is computed inside write \(SpreadElement\): copied is spread and its initial value is not an array literal/,
    },
    { form: 'parameters held in a constant that has no initial value', write: `(client) => client.query(${UPDATE}, plan)`, expected: /the parameters are not a constant computed before the call \(Identifier\): plan has no initial value/ },
    { form: 'parameters that are an import', write: `(client) => client.query(${UPDATE}, pool as never)`, expected: /the parameters are not a constant computed before the call \(Identifier\): pool is an import/ },
    { form: 'a spread of an import', write: `(client) => client.query(${UPDATE}, [...(pool as never as unknown[])])`, expected: /a parameter is computed inside write \(SpreadElement\): pool is an import/ },
    { form: 'parameters that are declared nowhere', write: `(client) => client.query(${UPDATE}, undeclaredParams)`, expected: /the parameters are not a constant computed before the call \(Identifier\): undeclaredParams does not resolve to a declaration/ },
    { form: 'a spread of a name that is declared nowhere', write: `(client) => client.query(${UPDATE}, [...undeclaredParams])`, expected: /a parameter is computed inside write \(SpreadElement\): undeclaredParams does not resolve to a declaration/ },
    // A function the guard cannot see.
    { form: 'a parameter of the calling function', write: 'injected', expected: /write: injected is a parameter, not a function written here/ },
    { form: 'an imported function', write: 'query as never', expected: /write: query is an import/ },
    { form: 'a name that is declared nowhere', write: 'undeclaredWriter', expected: /write: undeclaredWriter does not resolve to a declaration/ },
    { form: 'a let binding', write: 'rebound', expected: /write: rebound is not declared with const/ },
    { form: 'a var binding', write: 'hoisted', prelude: `  var hoisted = (client: PullSourceGateClient) => client.query(${UPDATE}, params)`, expected: /write: hoisted is not declared with const/ },
    { form: 'a constant that holds a call result', write: 'made', prelude: '  const made = ((): never => lockThenWrite as never)()', expected: /write: made is not initialised with a function expression/ },
    { form: 'a member of an object', write: 'writers.update', prelude: `  const writers = { update: (client: PullSourceGateClient) => client.query(${UPDATE}, params) }`, expected: /write: PropertyAccessExpression is not a function written in the call/ },
    { form: 'a bound function', write: 'lockThenWrite.bind(null)', expected: /write: CallExpression is not a function written in the call/ },
    { form: 'a conditional between two functions', write: `userIds.length ? lockThenWrite : (client: PullSourceGateClient) => client.query(${UPDATE}, params)`, expected: /write: ConditionalExpression is not a function written in the call/ },
  ]
  for (const { form, write, prelude, expected } of REFUSED_WRITES) {
    it(`positive control, write (${form}) fails`, () => {
      const use = gateUse(callerWith(write, undefined, prelude))
      expect(use.sites).toHaveLength(1)
      expect(use.problems.join('\n')).toMatch(expected)
      for (const problem of use.problems) expect(problem).toContain('directory/synthetic-entry.ts:')
    })
  }

  // The one pair `context.gated` chooses: the statement and the parameters, together. Each control below
  // is that pair with the difference it names, and lists every problem the difference is reported as.
  const PAIRED_SQL = `context.gated ? ${GATED_UPDATE} : ${UPDATE}`
  const PAIRED_PARAMS = 'context.gated ? [...params, context.lockedStatus] : params'
  const paired = (sql: string, parameters?: string): string => `(client, context) => client.query(${sql}${parameters === undefined ? '' : `, ${parameters}`})`
  const NOT_TOGETHER = 'the statement and the parameters are not chosen by context.gated together'
  const SQL_NOT_BY_GATED = 'the statement is chosen by something other than context.gated'
  const PARAMS_NOT_BY_GATED = 'the parameters are chosen by something other than context.gated'
  const NO_SPREAD_FIRST = 'the parameters inside a gate transaction do not start with one constant spread'
  const NO_STATUS_LAST = 'the parameters inside a gate transaction do not end with context.lockedStatus'
  const notOneMore = (gated: number, plain: number): string => `the statement inside a gate transaction does not name exactly one parameter more than the statement outside one ($${gated} against $${plain})`
  const holds = (where: 'inside' | 'outside', what: string): string => `the statement ${where} a gate transaction holds ${what}, where a $n is not a parameter`
  /** The pair with more at the end of the text inside a gate transaction, which otherwise names $1 and $2. */
  const gatedEnding = (ending: string): string => paired('context.gated ? `UPDATE directory_integrations SET name = $1 WHERE id = $2' + ending + '` : ' + UPDATE, PAIRED_PARAMS)
  /** The pair with a column of the text inside a gate transaction under another name; the text names $1 and $2. */
  const gatedColumn = (column: string): string => paired('context.gated ? `UPDATE directory_integrations SET ' + column + ' = $1 WHERE id = $2` : ' + UPDATE, PAIRED_PARAMS)
  const elements = (count: number): string => `the parameters inside a gate transaction are ${count} elements, not one constant spread and then context.lockedStatus`
  const gatedNotAList = (kind: string): string => `the parameters inside a gate transaction are not a list written in place (${kind})`
  const plainNotAlone = (kind: string): string => `the parameters outside a gate transaction are not a constant on its own (${kind})`
  const notBuiltOn = (why: string): string => `the parameters chosen by context.gated are not built on a list computed before the call: ${why}`
  const OTHER = '  const other: unknown[] = [2]'

  it('control (the pair, as the controls below start from it) passes', () => {
    const use = gateUse(callerWith(paired(PAIRED_SQL, PAIRED_PARAMS), undefined, OTHER))
    expect(use.sites).toHaveLength(1)
    expect(use.problems).toEqual([])
  })

  const REFUSED_PAIRS: ReadonlyArray<{ form: string; write: string; prelude?: string; problems: string[] }> = [
    // The parameters inside a gate transaction: the constant spread, then the locked status, and no more.
    { form: 'the locked status first', write: paired(PAIRED_SQL, 'context.gated ? [context.lockedStatus, ...params] : params'), problems: [NO_SPREAD_FIRST, NO_STATUS_LAST] },
    { form: 'the locked status twice', write: paired(PAIRED_SQL, 'context.gated ? [...params, context.lockedStatus, context.lockedStatus] : params'), problems: [elements(3)] },
    { form: 'a second constant spread', write: paired(PAIRED_SQL, 'context.gated ? [...params, ...other, context.lockedStatus] : params'), prelude: OTHER, problems: [elements(3)] },
    { form: 'a further constant before the locked status', write: paired(PAIRED_SQL, 'context.gated ? [...params, other, context.lockedStatus] : params'), prelude: OTHER, problems: [elements(3)] },
    { form: 'a further constant after the locked status', write: paired(PAIRED_SQL, 'context.gated ? [...params, context.lockedStatus, other] : params'), prelude: OTHER, problems: [elements(3)] },
    { form: 'the constant spread and no locked status', write: paired(PAIRED_SQL, 'context.gated ? [...params] : params'), problems: [elements(1)] },
    { form: 'the constant as one element, not spread', write: paired(PAIRED_SQL, 'context.gated ? [params, context.lockedStatus] : params'), problems: [NO_SPREAD_FIRST] },
    { form: 'a spread of something that is not a name', write: paired(PAIRED_SQL, 'context.gated ? [...[1], context.lockedStatus] : params'), problems: [NO_SPREAD_FIRST] },
    { form: 'another member of context last', write: paired(PAIRED_SQL, 'context.gated ? [...params, context.joined] : params'), problems: [NO_STATUS_LAST] },
    { form: 'a constant last', write: paired(PAIRED_SQL, 'context.gated ? [...params, other] : params'), prelude: OTHER, problems: [NO_STATUS_LAST] },
    { form: 'the locked status read through an optional chain', write: paired(PAIRED_SQL, 'context.gated ? [...params, context?.lockedStatus] : params'), problems: [NO_STATUS_LAST] },
    { form: 'the constant itself inside a gate transaction', write: paired(PAIRED_SQL, 'context.gated ? params : params'), problems: [gatedNotAList('Identifier')] },
    // The parameters outside a gate transaction: the same constant, on its own.
    { form: 'the locked status outside a gate transaction and not inside one', write: paired(PAIRED_SQL, 'context.gated ? params : [...params, context.lockedStatus]'), problems: [gatedNotAList('Identifier'), plainNotAlone('ArrayLiteralExpression')] },
    { form: 'the locked status in both lists', write: paired(PAIRED_SQL, 'context.gated ? [...params, context.lockedStatus] : [...params, context.lockedStatus]'), problems: [plainNotAlone('ArrayLiteralExpression')] },
    { form: 'a copy of the constant outside a gate transaction', write: paired(PAIRED_SQL, 'context.gated ? [...params, context.lockedStatus] : [...params]'), problems: [plainNotAlone('ArrayLiteralExpression')] },
    { form: 'a different constant outside a gate transaction', write: paired(PAIRED_SQL, 'context.gated ? [...params, context.lockedStatus] : other'), prelude: OTHER, problems: ['the parameters are built on two constants: params inside a gate transaction, other outside one'] },
    { form: 'a different constant inside a gate transaction', write: paired(PAIRED_SQL, 'context.gated ? [...other, context.lockedStatus] : params'), prelude: OTHER, problems: ['the parameters are built on two constants: other inside a gate transaction, params outside one'] },
    // What chooses.
    { form: 'the parameters chosen by the negation of context.gated', write: paired(PAIRED_SQL, '!context.gated ? [...params, context.lockedStatus] : params'), problems: [PARAMS_NOT_BY_GATED] },
    { form: 'the parameters chosen by another member of context', write: paired(PAIRED_SQL, 'context.joined ? [...params, context.lockedStatus] : params'), problems: [PARAMS_NOT_BY_GATED] },
    { form: 'the parameters chosen by a comparison of context.gated', write: paired(PAIRED_SQL, 'context.gated === true ? [...params, context.lockedStatus] : params'), problems: [PARAMS_NOT_BY_GATED] },
    { form: 'the statement chosen by the negation of context.gated', write: paired(`!context.gated ? ${GATED_UPDATE} : ${UPDATE}`, PAIRED_PARAMS), problems: [SQL_NOT_BY_GATED] },
    { form: 'the statement chosen by another member of context', write: paired(`context.joined ? ${GATED_UPDATE} : ${UPDATE}`, PAIRED_PARAMS), problems: [SQL_NOT_BY_GATED] },
    // The constant the two lists are built on.
    { form: 'a constant that holds a call result', write: paired(PAIRED_SQL, 'context.gated ? [...copied, context.lockedStatus] : copied'), prelude: '  const copied = userIds.slice()', problems: [notBuiltOn('copied is spread and its initial value is not an array literal')] },
    { form: 'a constant that is an object with its own iteration', write: paired(PAIRED_SQL, 'context.gated ? [...iterable, context.lockedStatus] : iterable'), prelude: '  const iterable = { *[Symbol.iterator]() { yield userIds } }', problems: [notBuiltOn('iterable is spread and its initial value is not an array literal')] },
    { form: 'a constant that holds a function', write: paired(PAIRED_SQL, 'context.gated ? [...holder, context.lockedStatus] : holder'), prelude: '  const holder = () => userIds', problems: [notBuiltOn('holder holds a function')] },
    { form: 'a constant that has no initial value', write: paired(PAIRED_SQL, 'context.gated ? [...userIds, context.lockedStatus] : userIds'), problems: [notBuiltOn('userIds has no initial value')] },
    { form: 'an import', write: paired(PAIRED_SQL, 'context.gated ? [...pool, context.lockedStatus] : pool'), problems: [notBuiltOn('pool is an import')] },
    { form: 'a parameter of the calling function', write: paired(PAIRED_SQL, 'context.gated ? [...injected, context.lockedStatus] : injected'), problems: [notBuiltOn('injected is a parameter')] },
    { form: 'a name that is declared nowhere', write: paired(PAIRED_SQL, 'context.gated ? [...undeclaredParams, context.lockedStatus] : undeclaredParams'), problems: [notBuiltOn('undeclaredParams does not resolve to a declaration')] },
    { form: 'two constants, neither of them a list computed before the call', write: paired(PAIRED_SQL, 'context.gated ? [...injected, context.lockedStatus] : pool'), problems: ['the parameters are built on two constants: injected inside a gate transaction, pool outside one', notBuiltOn('injected is a parameter'), notBuiltOn('pool is an import')] },
    // The two texts.
    { form: 'the two texts the other way round', write: paired(`context.gated ? ${UPDATE} : ${GATED_UPDATE}`, PAIRED_PARAMS), problems: [notOneMore(2, 3)] },
    { form: 'the same text twice', write: paired(`context.gated ? ${UPDATE} : ${UPDATE}`, PAIRED_PARAMS), problems: [notOneMore(2, 2)] },
    { form: 'two parameters more inside a gate transaction', write: paired('context.gated ? `UPDATE directory_integrations SET name = $1 WHERE id = $2 AND status = $3 AND corp_id = $4` : ' + UPDATE, PAIRED_PARAMS), problems: [notOneMore(4, 2)] },
    { form: 'a text that names no parameter inside a gate transaction', write: paired('context.gated ? `UPDATE directory_integrations SET name = NULL` : ' + UPDATE, PAIRED_PARAMS), problems: [notOneMore(0, 2)] },
    { form: 'one text held in a name', write: paired(`context.gated ? ${GATED_UPDATE} : sql`, PAIRED_PARAMS), prelude: `  const sql = ${UPDATE}`, problems: ['the statement is not a complete literal (Identifier)'] },
    { form: 'both texts held in names', write: paired('context.gated ? gatedSql : sql', PAIRED_PARAMS), prelude: `  const sql = ${UPDATE}\n  const gatedSql = ${GATED_UPDATE}`, problems: ['the statement is not a complete literal (Identifier)', 'the statement is not a complete literal (Identifier)'] },
    { form: 'one text that is not an integration write', write: paired(`context.gated ? ${GATED_UPDATE} : \`SELECT $1, $2\``, PAIRED_PARAMS), problems: ['the statement does not start with an INSERT into, or an UPDATE of, directory_integrations'] },
    { form: 'one text with a row-lock clause', write: paired('context.gated ? `UPDATE directory_integrations SET name = (SELECT name FROM users WHERE id = $1 FOR SHARE) WHERE id = $2 AND status = $3` : ' + UPDATE, PAIRED_PARAMS), problems: ['the statement holds a row-lock clause'] },
    { form: 'a choice inside a choice', write: paired(`context.gated ? (context.joined ? ${GATED_UPDATE} : ${GATED_UPDATE}) : ${UPDATE}`, PAIRED_PARAMS), problems: ['the statement is not a complete literal (ConditionalExpression)'] },
    // A `$n` that is not a parameter of its text. Counted as one, each of the texts below would pass:
    // the highest `$n` inside a gate transaction is one above the highest outside one.
    { form: 'the one parameter more named in a line comment and nowhere else', write: gatedEnding(' -- AND status = $3'), problems: [holds('inside', 'a line comment')] },
    { form: 'the one parameter more named in a block comment and nowhere else', write: gatedEnding(' /* AND status = $3 */'), problems: [holds('inside', 'a block comment')] },
    {
      form: 'the two texts the other way round, the one inside a gate transaction with a comment that names a higher parameter',
      write: paired('context.gated ? `UPDATE directory_integrations SET name = $1 WHERE id = $2 /* $4 */` : ' + GATED_UPDATE, PAIRED_PARAMS),
      problems: [holds('inside', 'a block comment')],
    },
    { form: 'the one parameter more named in a quoted text and nowhere else', write: gatedEnding(" AND name <> '$3'"), problems: [holds('inside', 'a single quote')] },
    { form: 'the one parameter more named in a quoted name and nowhere else', write: gatedColumn('"$3"'), problems: [holds('inside', 'a double quote')] },
    { form: 'the one parameter more named at the end of a name, after a letter', write: gatedColumn('name$3'), problems: [holds('inside', 'a `$` inside a name')] },
    { form: 'the one parameter more named at the end of a name, after a digit', write: gatedColumn('line1$3'), problems: [holds('inside', 'a `$` inside a name')] },
    { form: 'the one parameter more named at the end of a name, after an underscore', write: gatedColumn('name_$3'), problems: [holds('inside', 'a `$` inside a name')] },
    { form: 'the one parameter more named at the end of a name, after a letter outside ASCII', write: gatedColumn('cl\u00e9$3'), problems: [holds('inside', 'a `$` inside a name')] },
    { form: 'the one parameter more named in a dollar-quoted text and nowhere else', write: gatedEnding(' AND name <> $$ $3 $$'), problems: [holds('inside', 'a `$` that no number follows')] },
    {
      form: 'the one parameter more named in a dollar-quoted text with a tag and nowhere else',
      write: gatedEnding(' AND name <> $t$ $3 $t$'),
      problems: [holds('inside', 'a `$` inside a name'), holds('inside', 'a `$` that no number follows')],
    },
    { form: 'a `$` with a word after it and no number', write: gatedEnding(' AND status = $3 AND name <> $name'), problems: [holds('inside', 'a `$` that no number follows')] },
    {
      form: 'a comment that names no parameter',
      write: paired('context.gated ? `UPDATE directory_integrations SET name = $1 WHERE id = $2 AND status = $3 -- the status read under the row lock` : ' + UPDATE, PAIRED_PARAMS),
      problems: [holds('inside', 'a line comment')],
    },
    {
      form: 'a parameter of the text outside a gate transaction named in a comment and nowhere else',
      write: paired('context.gated ? `UPDATE directory_integrations SET name = $1 WHERE id = $2 AND status = $4` : `UPDATE directory_integrations SET name = $1 WHERE id = $2 /* $3 */`', PAIRED_PARAMS),
      problems: [holds('outside', 'a block comment')],
    },
    {
      form: 'a quoted text in the text outside a gate transaction',
      write: paired(`context.gated ? ${GATED_UPDATE} : ` + "`UPDATE directory_integrations SET name = $1 WHERE id = $2 AND name <> 'none'`", PAIRED_PARAMS),
      problems: [holds('outside', 'a single quote')],
    },
    {
      form: 'a comment in each of the two texts',
      write: paired('context.gated ? `UPDATE directory_integrations SET name = $1 WHERE id = $2 AND status = $3 -- inside` : `UPDATE directory_integrations SET name = $1 WHERE id = $2 -- outside`', PAIRED_PARAMS),
      problems: [holds('inside', 'a line comment'), holds('outside', 'a line comment')],
    },
    // One half without the other.
    { form: 'the statement chosen and the parameters not', write: paired(PAIRED_SQL, 'params'), problems: [NOT_TOGETHER] },
    { form: 'the statement chosen and no parameters', write: paired(PAIRED_SQL), problems: [NOT_TOGETHER] },
    { form: 'the parameters chosen and the statement not', write: paired(GATED_UPDATE, PAIRED_PARAMS), problems: [NOT_TOGETHER] },
    { form: 'the locked status in parameters that are not chosen', write: paired(GATED_UPDATE, '[...params, context.lockedStatus]'), problems: ['a parameter is computed inside write (PropertyAccessExpression): it is not a name'] },
    { form: 'the locked status as the one parameter, not chosen', write: paired(GATED_UPDATE, '[context.lockedStatus]'), problems: ['a parameter is computed inside write (PropertyAccessExpression): it is not a name'] },
    { form: 'the statement chosen by the negation, the texts the other way round, the parameters not chosen', write: paired(`!context.gated ? ${UPDATE} : ${GATED_UPDATE}`, 'params'), problems: [NOT_TOGETHER, SQL_NOT_BY_GATED, notOneMore(2, 3)] },
  ]
  for (const { form, write, prelude, problems } of REFUSED_PAIRS) {
    it(`positive control, the pair chosen by context.gated (${form}) fails`, () => {
      const use = gateUse(callerWith(write, undefined, prelude))
      expect(use.sites).toHaveLength(1)
      expect(unplaced(use.problems)).toEqual(problems)
      for (const problem of use.problems) expect(problem).toContain('directory/synthetic-entry.ts:')
    })
  }

  const REFUSED_OPTIONS: ReadonlyArray<{ form: string; options: string; prelude?: string; expected: RegExp }> = [
    { form: 'a judgement that calls an entry point', options: '{ joins: () => { void withAuthorizationInputTransaction(plan, async () => 1); return true } }', expected: /joins has 2 statements/ },
    { form: 'a judgement that calls a function', options: '{ joins: (status) => userIds.includes(String(status)) }', expected: /joins contains CallExpression/ },
    { form: 'a judgement that calls a method of its parameter', options: "{ joins: (status) => status?.startsWith('a') === true }", expected: /joins contains CallExpression/ },
    { form: 'a judgement that reads a property', options: '{ joins: (status) => status?.length === 6 }', expected: /joins contains PropertyAccessExpression/ },
    { form: 'a judgement that awaits', options: '{ joins: (async (status: string | null) => (await enterIndirectly()) === 1) as never }', expected: /joins is async or a generator/ },
    { form: 'a judgement that reads an outer name', options: '{ joins: (status) => status === String }', expected: /joins reads String/ },
    { form: 'a judgement that reads undefined by name', options: '{ joins: (status) => status !== undefined }', expected: /joins reads undefined/ },
    { form: 'a judgement with a template', options: '{ joins: (status) => `${status}` === "paused" }', expected: /joins contains TemplateExpression/ },
    { form: 'a judgement that constructs', options: '{ joins: (status) => new Boolean(status) as never }', expected: /joins contains NewExpression/ },
    { form: 'a judgement that assigns', options: '{ joins: (status) => (userIds.length = 0) === 0 }', expected: /joins contains BinaryExpression/ },
    { form: 'a judgement with two parameters', options: '{ joins: ((status: string | null, extra: unknown) => status === extra) as never }', expected: /joins takes 2 parameters/ },
    { form: 'a judgement the guard cannot see', options: '{ joins: injected as never }', expected: /joins: injected is a parameter, not a function written here/ },
    { form: 'a judgement that is an import', options: '{ joins: query as never }', expected: /joins: query is an import/ },
    { form: 'a judgement that is declared nowhere', options: '{ joins: undeclaredJudge }', expected: /joins: undeclaredJudge does not resolve to a declaration/ },
    { form: 'a judgement written as a method', options: '{ joins() { return true } }', expected: /options hold joins in a form other than key: value/ },
    { form: 'a judgement in shorthand', options: '{ joins }', prelude: '  const joins = () => true', expected: /options hold joins in a form other than key: value/ },
    { form: 'spread options', options: '{ ...extra }', prelude: '  const extra = { joins: () => true }', expected: /options hold a spread or a computed key/ },
    { form: 'a computed key', options: "{ ['joins']: () => true }", expected: /options hold a spread or a computed key/ },
    { form: 'an unknown key', options: '{ lockTarget: async () => null } as never', expected: /options hold the unknown key lockTarget/ },
    { form: 'a function under a data key', options: '{ lockRowId: (() => "id") as never }', expected: /options\.lockRowId is a function/ },
    { form: 'options held in a name', options: 'extra', prelude: '  const extra = { joins: () => true }', expected: /options are not an object literal/ },
  ]
  for (const { form, options, prelude, expected } of REFUSED_OPTIONS) {
    it(`positive control, options (${form}) fails`, () => {
      const use = gateUse(callerWith(`(client) => client.query(${UPDATE}, params)`, options, prelude))
      expect(use.sites).toHaveLength(1)
      expect(use.problems.join('\n')).toMatch(expected)
    })
  }

  // A name is read the way the compiler binds it where it is used, so a nearer binding of the same name
  // is the one judged. In every control below the module holds a constant of that name that would pass,
  // and the call sits where another binding of the name takes its place.
  const NAMED: ReadonlyArray<{ place: string; name: string; passing: string; call: string; reported: string }> = [
    { place: 'write', name: 'update', passing: `(client: PullSourceGateClient) => client.query(${UPDATE}, params)`, call: 'runGatedPullSourceWrite(target, update)', reported: 'write: update ' },
    { place: 'joins', name: 'judge', passing: "(status: string | null) => status !== 'active'", call: 'runGatedPullSourceWrite(target, update, { joins: judge })', reported: 'joins: judge ' },
    {
      place: 'the parameters',
      name: 'params',
      passing: '[1]',
      call: `runGatedPullSourceWrite(target, (client) => client.query(${UPDATE}, params))`,
      reported: 'the parameters are not a constant computed before the call (Identifier): params ',
    },
    {
      place: 'parameters spread into a list',
      name: 'params',
      passing: '[1]',
      call: `runGatedPullSourceWrite(target, (client) => client.query(${UPDATE}, [...params]))`,
      reported: 'a parameter is computed inside write (SpreadElement): params ',
    },
    {
      place: 'the parameters chosen by context.gated',
      name: 'params',
      passing: '[1]',
      call: `runGatedPullSourceWrite(target, (client, context) => client.query(context.gated ? ${GATED_UPDATE} : ${UPDATE}, context.gated ? [...params, context.lockedStatus] : params))`,
      reported: 'the parameters chosen by context.gated are not built on a list computed before the call: params ',
    },
  ]
  const callerOfNamed = (entry: string): SourceFile[] => [{
    path: 'directory/synthetic-named.ts',
    text: [
      "import { runGatedPullSourceWrite, type PullSourceGateClient } from '../directory/pull-source-write-gate'",
      'declare const target: never',
      'const params: unknown[] = [1]',
      `const update = (client: PullSourceGateClient) => client.query(${UPDATE}, params)`,
      "const judge = (status: string | null) => status !== 'active'",
      entry,
    ].join('\n'),
  }]
  const NEARER_BINDINGS: ReadonlyArray<{ form: string; bound: string; entry: (name: string, passing: string, call: string) => string }> = [
    { form: 'a destructured parameter', bound: 'is bound by a destructured parameter', entry: (name, _passing, call) => `export async function entry({ ${name} }: Record<string, never>) {\n  return ${call}\n}` },
    {
      form: 'a destructured parameter, nested and renamed',
      bound: 'is bound by a destructured parameter',
      entry: (name, _passing, call) => `export async function entry({ given: [{ inner: ${name} }] }: { given: [{ inner: never }] }) {\n  return ${call}\n}`,
    },
    { form: 'a parameter of an arrow function around the call', bound: 'is a parameter', entry: (name, _passing, call) => `export const entry = async (${name}: never) => ${call}` },
    { form: 'a destructuring declaration', bound: 'is bound by a destructuring declaration', entry: (name, _passing, call) => `export async function entry(given: Record<string, never>) {\n  const { ${name} } = given\n  return ${call}\n}` },
    { form: 'an array destructuring declaration', bound: 'is bound by a destructuring declaration', entry: (name, _passing, call) => `export async function entry(given: never[]) {\n  const [${name}] = given\n  return ${call}\n}` },
    { form: 'the head of a for-of loop', bound: 'is bound in the head of a loop', entry: (name, _passing, call) => `export async function entry(given: never[]) {\n  for (const ${name} of given) return ${call}\n}` },
    { form: 'the head of a for-in loop', bound: 'is bound in the head of a loop', entry: (name, _passing, call) => `export async function entry(given: Record<string, never>) {\n  for (const ${name} in given) return ${call}\n}` },
    { form: 'the head of a for loop, with an initial value that would pass', bound: 'is bound in the head of a loop', entry: (name, passing, call) => `export async function entry() {\n  for (const ${name} = ${passing}; ;) return ${call}\n}` },
    { form: 'the variable of a catch clause', bound: 'is the variable of a catch clause', entry: (name, _passing, call) => `export async function entry() {\n  try {\n    throw new Error('thrown')\n  } catch (${name}) {\n    return ${call}\n  }\n}` },
    {
      form: 'a var hoisted out of a nested block, with an initial value that would pass',
      bound: 'is not declared with const',
      entry: (name, passing, call) => `export async function entry(flag: boolean) {\n  if (flag) {\n    var ${name} = ${passing}\n  }\n  return ${call}\n}`,
    },
    { form: 'a let, with an initial value that would pass', bound: 'is not declared with const', entry: (name, passing, call) => `export async function entry() {\n  let ${name} = ${passing}\n  return ${call}\n}` },
    { form: 'a using declaration, with an initial value that would pass', bound: 'is not declared with const', entry: (name, passing, call) => `export async function entry() {\n  using ${name} = ${passing}\n  return ${call}\n}` },
    { form: 'an await using declaration, with an initial value that would pass', bound: 'is not declared with const', entry: (name, passing, call) => `export async function entry() {\n  await using ${name} = ${passing}\n  return ${call}\n}` },
    { form: 'a function declaration', bound: 'is a function declaration', entry: (name, _passing, call) => `export async function entry() {\n  function ${name}() { return undefined }\n  return ${call}\n}` },
    { form: 'the name of a function expression around the call', bound: 'is not bound by a const statement (FunctionExpression)', entry: (name, _passing, call) => `export const entry = async function ${name}() {\n  return ${call}\n}` },
    { form: 'a class declaration', bound: 'is not bound by a const statement (ClassDeclaration)', entry: (name, _passing, call) => `export async function entry() {\n  class ${name} {}\n  return ${call}\n}` },
    { form: 'a second declaration, a namespace of the same name', bound: 'has more than one declaration', entry: (name, _passing, call) => `namespace ${name} { export type Kind = string }\nexport async function entry() {\n  return ${call}\n}` },
  ]
  for (const { place, name, passing, call, reported } of NAMED) {
    it(`control (${place}: the constant of the module, with no nearer binding of its name) passes`, () => {
      const use = gateUse(callerOfNamed(`export async function entry() {\n  return ${call}\n}`))
      expect(use.sites).toHaveLength(1)
      expect(use.problems).toEqual([])
    })
    for (const { form, bound, entry } of NEARER_BINDINGS) {
      it(`positive control, ${place} (the name is bound nearer the call by ${form}) fails`, () => {
        const use = gateUse(callerOfNamed(entry(name, passing, call)))
        expect(use.sites).toHaveLength(1)
        expect(use.problems).toHaveLength(1)
        expect(use.problems[0]).toContain(`directory/synthetic-named.ts:`)
        expect(use.problems[0]).toContain(`${reported}${bound}`)
      })
    }
  }

  it('a JavaScript source is read the same way: the nearer binding is the one judged', () => {
    const script = (parameters: string): SourceFile[] => [{
      path: 'legacy/synthetic-named.js',
      text: [
        "import { runGatedPullSourceWrite } from '../directory/pull-source-write-gate'",
        'const params = [1]',
        `const update = (client) => client.query(${UPDATE}, params)`,
        `export async function entry(${parameters}) {`,
        '  return runGatedPullSourceWrite(target, update)',
        '}',
      ].join('\n'),
    }]
    const plain = gateUse(script('target'))
    expect(plain.sites).toHaveLength(1)
    expect(plain.problems).toEqual([])
    expect(gateUse(script('target, { update }')).problems).toEqual(['legacy/synthetic-named.js:5 write: update is bound by a destructured parameter'])
  })

  const HIDDEN_CALLS: ReadonlyArray<{ form: string; code: string; expected: RegExp }> = [
    { form: 'the gated write under another name', code: "import { runGatedPullSourceWrite as gated } from '../directory/pull-source-write-gate'\nexport const hidden0 = gated", expected: /uses runGatedPullSourceWrite other than by importing it under its own name and calling it/ },
    { form: 'the gated write bound to a constant', code: 'declare function runGatedPullSourceWrite(...a: unknown[]): unknown\nexport const hidden1 = runGatedPullSourceWrite', expected: /uses runGatedPullSourceWrite other than by importing it under its own name and calling it/ },
    { form: 'the gated write read by its name as a string', code: "declare const gateModule: Record<string, unknown>\nexport const hidden2 = gateModule['runGatedPullSourceWrite']", expected: /uses runGatedPullSourceWrite other than by importing it under its own name and calling it/ },
    { form: 'the gated write re-exported', code: "export { runGatedPullSourceWrite } from '../directory/pull-source-write-gate'", expected: /uses runGatedPullSourceWrite other than by importing it under its own name and calling it/ },
    { form: 'spread arguments', code: 'declare function runGatedPullSourceWrite(...a: unknown[]): unknown\ndeclare const args: unknown[]\nexport const hidden3 = () => runGatedPullSourceWrite(...args)', expected: /spreads its arguments/ },
    { form: 'the policy clear handed a function', code: 'declare function runGatedRoutingPolicyClear(...a: unknown[]): unknown\nexport const hidden4 = () => runGatedRoutingPolicyClear("org", async () => undefined)', expected: /is not a policy clear of an organisation and a purpose/ },
    { form: 'the policy clear under another name', code: "import { runGatedRoutingPolicyClear as clear } from '../directory/pull-source-write-gate'\nexport const hidden5 = clear", expected: /uses runGatedRoutingPolicyClear other than by importing it under its own name and calling it/ },
  ]
  for (const { form, code, expected } of HIDDEN_CALLS) {
    it(`positive control (${form}) fails wherever it is added`, () => {
      for (const path of ['routes/admin-directory.ts', 'directory/controlled-handover.ts', 'services/ApprovalDirectoryOrg.ts']) {
        expect(SOURCE.some((file) => file.path === path), path).toBe(true)
        const problems = gateUse(SOURCE.map((file) => (file.path === path ? { ...file, text: `${file.text}\n${code}\n` } : file))).problems.join('\n')
        expect(problems, path).toMatch(expected)
        expect(problems, path).toContain(`${path}:`)
      }
      // A JavaScript source file is read the same way.
      const javascript = code.split('\n').filter((line) => !line.startsWith('declare ')).join('\n')
      expect(gateUse([...SOURCE, { path: 'legacy/hidden.js', text: javascript }]).problems.join('\n')).toMatch(expected)
    })
  }

  it('positive control: the pair of the production save written any other way fails', () => {
    const sync = SOURCE.find((file) => file.path === SYNC)!
    const problemsOf = (text: string): string[] => unplaced(gateUse(SOURCE.map((file) => (file.path === SYNC ? { ...file, text } : file))).problems)
    const chosen = '    context.gated ? [...updateParams, context.lockedStatus] : updateParams,\n'
    expect(problemsOf(sync.text)).toEqual([])
    // The locked status first: every parameter of the statement would move one place.
    expect(problemsOf(edited(sync.text, chosen, '    context.gated ? [context.lockedStatus, ...updateParams] : updateParams,\n'))).toEqual([NO_SPREAD_FIRST, NO_STATUS_LAST])
    // The locked status outside a gate transaction, and not inside one.
    expect(problemsOf(edited(sync.text, chosen, '    context.gated ? updateParams : [...updateParams, context.lockedStatus],\n'))).toEqual([gatedNotAList('Identifier'), plainNotAlone('ArrayLiteralExpression')])
    // The locked status twice: one parameter more than the statement names.
    expect(problemsOf(edited(sync.text, chosen, '    context.gated ? [...updateParams, context.lockedStatus, context.lockedStatus] : updateParams,\n'))).toEqual([elements(3)])
    // The parameters no longer chosen, the statement still chosen.
    expect(problemsOf(edited(sync.text, chosen, '    updateParams,\n'))).toEqual([NOT_TOGETHER])
    // The text inside a gate transaction without the status it is guarded by.
    expect(problemsOf(edited(sync.text, ' AND corp_id = $11 AND status = $12\n', ' AND corp_id = $11\n'))).toEqual([notOneMore(11, 11)])
    // The text outside a gate transaction guarded by a status it is given no parameter for.
    expect(problemsOf(edited(sync.text, ' AND corp_id = $11\n', ' AND corp_id = $11 AND status = $12\n'))).toEqual([notOneMore(12, 12)])
    // The status guard of the text inside a gate transaction turned into a comment: the text still reads $12.
    expect(problemsOf(edited(sync.text, ' AND corp_id = $11 AND status = $12\n', ' AND corp_id = $11 /* AND status = $12 */\n'))).toEqual([holds('inside', 'a block comment')])
    // The same guard turned into a comparison with a quoted text that reads $12.
    expect(problemsOf(edited(sync.text, ' AND corp_id = $11 AND status = $12\n', " AND corp_id = $11 AND name <> '$12'\n"))).toEqual([holds('inside', 'a single quote')])
    // The two texts the other way round, and a comment that reads $13 in the one now inside a gate transaction.
    const guardMovedOut = edited(
      edited(sync.text, ' AND corp_id = $11 AND status = $12\n', ' AND corp_id = $11 /* $13 */\n'),
      ' AND corp_id = $11\n',
      ' AND corp_id = $11 AND status = $12\n',
    )
    expect(guardMovedOut.indexOf(' AND corp_id = $11 /* $13 */\n')).toBeLessThan(guardMovedOut.indexOf(' AND corp_id = $11 AND status = $12\n'))
    expect(problemsOf(guardMovedOut)).toEqual([holds('inside', 'a block comment')])
  })

  it('positive control: each production write turned into a function that does more fails', () => {
    const sync = SOURCE.find((file) => file.path === SYNC)!
    const withSync = (text: string): SourceFile[] => SOURCE.map((file) => (file.path === SYNC ? { ...file, text } : file))
    // The create statement with its parameters built in the function again.
    const inlineParams = edited(sync.text, '`,\n    insertParams,\n  )', '`,\n    [...insertParams, normalizeStoredSecretValue(normalized.appSecret)],\n  )')
    expect(gateUse(withSync(inlineParams)).problems.join('\n')).toMatch(/a parameter is computed inside write \(CallExpression\)/)
    // The save preceded by a user-row lock on the gate connection.
    const lockFirst = edited(
      sync.text,
      'const update = (client: PullSourceGateClient, context: PullSourceWriteContext) => client.query(',
      'const update = async (client: PullSourceGateClient, context: PullSourceWriteContext) => (await lockUsersForAccessGraphWrite(client as never, [integrationId]), client).query(',
    )
    expect(gateUse(withSync(lockFirst)).problems.join('\n')).toMatch(/write is async or a generator/)
    // The judgement reading the status from the row read before the transaction.
    const staleJudgement = edited(sync.text, "joins: (lockedStatus) => lockedStatus !== null && lockedStatus !== 'active',", "joins: () => current.status !== 'active',")
    expect(gateUse(withSync(staleJudgement)).problems.join('\n')).toMatch(/joins contains PropertyAccessExpression/)
    // The save called where a destructured parameter of the same name stands in for its statement: the
    // function the gate is handed is the one passed in, which locks first.
    const callOpens = "      ? runGatedPullSourceWrite(\n        { orgId: current.org_id, provider: current.provider, corpId: normalized.corpId, enforce: 'flagged' },\n        update,\n"
    const callCloses = "          joins: (lockedStatus) => lockedStatus !== null && lockedStatus !== 'active',\n        },\n      )\n"
    const beforeTheCall = '  // A save whose resulting status is active may add a pull source: it goes through the gate, which runs\n'
    const withLocking = edited(
      sync.text,
      beforeTheCall,
      `  const locking = async (client: PullSourceGateClient, context: PullSourceWriteContext) => (await lockUsersForAccessGraphWrite(client as never, [integrationId]), update(client, context))\n${beforeTheCall}`,
    )
    const standIn = edited(
      edited(withLocking, callOpens, callOpens.replace('? runGatedPullSourceWrite(', '? (({ update }: { update: typeof locking }) => runGatedPullSourceWrite(')),
      callCloses,
      callCloses.replace('      )\n', '      ))({ update: locking })\n'),
    )
    const standInProblems = gateUse(withSync(standIn)).problems
    expect(standInProblems).toHaveLength(1)
    expect(standInProblems[0]).toContain('write: update is bound by a destructured parameter')
    // The same call inside a loop whose head binds the name.
    const loopHead = edited(
      edited(withLocking, callOpens, callOpens.replace('? runGatedPullSourceWrite(', '? (() => {\n        for (const update of [locking]) return runGatedPullSourceWrite(')),
      callCloses,
      callCloses.replace('      )\n', "      )\n        throw new Error('unreachable') })()\n"),
    )
    const loopHeadProblems = gateUse(withSync(loopHead)).problems
    expect(loopHeadProblems).toHaveLength(1)
    expect(loopHeadProblems[0]).toContain('write: update is bound in the head of a loop')
  })
})
