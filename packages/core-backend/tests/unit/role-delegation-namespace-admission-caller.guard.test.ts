import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { listFiles, SOURCE_EXTENSIONS } from '../helpers/authorization-input-scan'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SRC = 'packages/core-backend/src'
const COMMAND_FILE = `${SRC}/admin/role-delegation-namespace-admission-command.ts`
const CALLER_FILE = `${SRC}/routes/admin-users.ts`
const GUARD_FILE = 'packages/core-backend/tests/unit/role-delegation-namespace-admission-caller.guard.test.ts'
const COMMAND_NAME = 'writeRoleDelegationNamespaceAdmissionCommand'
const MODULE_STEM = 'role-delegation-namespace-admission-command'
const MODULE_NAME = `../admin/${MODULE_STEM}`
const ROUTE = '/api/admin/role-delegation/users/:userId/namespaces/:namespace/admission'
const INPUT_KEYS = ['actorId', 'enabled', 'isPlatformAdmin', 'namespace', 'userId']
const PRODUCTION_TITLE = 'has one static data-only caller across production and plugins'
const PROBLEM_CODES = [
  'decoded string literal',
  'non-static module reference',
  'computed module reference',
  'computed command reference',
  'import shape',
  'detached command reference',
  'direct await',
  'data argument',
  'data property',
  'data binding',
  'data keys',
  'registered route',
  'caller coverage',
]
const ROUTE_VERBS = new Set(['all', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'use'])

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression
  return expression
}

function rawQuoted(node: ts.StringLiteral): string | undefined {
  const text = node.getText()
  const quote = text[0]
  if ((quote !== "'" && quote !== '"') || text.length < 2 || text[text.length - 1] !== quote) return undefined
  return text.slice(1, -1)
}

type ScalarBindings = Map<ts.Node, Map<string, ts.Expression | undefined>>

function scopeOwner(node: ts.Node | undefined, functionOnly = false): ts.Node | undefined {
  let current = node
  while (current) {
    if (ts.isSourceFile(current) || ts.isFunctionLike(current) || ts.isClassDeclaration(current) || ts.isClassExpression(current)) return current
    if (!functionOnly && (ts.isBlock(current) || ts.isModuleBlock(current) || ts.isCatchClause(current) || ts.isCaseBlock(current)
      || ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current))) return current
    current = current.parent
  }
  return undefined
}

function bindScalar(bindings: ScalarBindings, owner: ts.Node, name: ts.BindingName, value?: ts.Expression): void {
  if (!ts.isIdentifier(name)) {
    for (const element of name.elements) if (ts.isBindingElement(element)) bindScalar(bindings, owner, element.name)
    return
  }
  let names = bindings.get(owner)
  if (!names) bindings.set(owner, names = new Map())
  names.set(name.text, names.has(name.text) ? undefined : value)
}

function collectScalarBindings(tree: ts.SourceFile): ScalarBindings {
  const bindings: ScalarBindings = new Map()
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
      const flags = node.parent.flags
      const owner = scopeOwner(node.parent, (flags & ts.NodeFlags.BlockScoped) === 0)
      if (owner) bindScalar(bindings, owner, node.name, (flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const ? node.initializer : undefined)
    } else if (ts.isParameter(node)) {
      const owner = scopeOwner(node)
      if (owner) bindScalar(bindings, owner, node.name)
    } else if (ts.isCatchClause(node) && node.variableDeclaration) bindScalar(bindings, node, node.variableDeclaration.name)
    else if (ts.isFunctionDeclaration(node) && node.name) {
      const owner = scopeOwner(node.parent)
      if (owner) bindScalar(bindings, owner, node.name)
    } else if ((ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
      const owner = scopeOwner(node.parent)
      if (owner) bindScalar(bindings, owner, node.name)
      if (ts.isClassDeclaration(node)) bindScalar(bindings, node, node.name)
    } else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      bindScalar(bindings, node, node.name)
    } else if (ts.isImportClause(node) && node.name) bindScalar(bindings, tree, node.name)
    else if (ts.isNamespaceImport(node)) bindScalar(bindings, tree, node.name)
    else if (ts.isImportSpecifier(node)) bindScalar(bindings, tree, node.name)
    ts.forEachChild(node, collect)
  }
  collect(tree)
  return bindings
}

function scalarInitializer(identifier: ts.Identifier, scalars: ScalarBindings): ts.Expression | undefined {
  let owner = scopeOwner(identifier.parent)
  while (owner) {
    const names = scalars.get(owner)
    if (names?.has(identifier.text)) return names.get(identifier.text)
    if (ts.isSourceFile(owner)) return undefined
    owner = scopeOwner(owner.parent)
  }
  return undefined
}

function constantText(expression: ts.Expression, scalars: ScalarBindings, stack = new Set<ts.Expression>()): string | undefined {
  const value = unwrap(expression)
  if (ts.isStringLiteralLike(value)) return value.text
  if (ts.isIdentifier(value)) {
    const initializer = scalarInitializer(value, scalars)
    if (!initializer || stack.has(initializer)) return undefined
    stack.add(initializer)
    const text = constantText(initializer, scalars, stack)
    stack.delete(initializer)
    return text
  }
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantText(value.left, scalars, stack)
    const right = constantText(value.right, scalars, stack)
    if (left !== undefined && right !== undefined) return left + right
  }
  if (ts.isTemplateExpression(value)) {
    let result = value.head.text
    for (const span of value.templateSpans) {
      const text = constantText(span.expression, scalars, stack)
      if (text === undefined) return undefined
      result += text + span.literal.text
    }
    return result
  }
  return undefined
}

function identifierExact(node: ts.Node, expected: string): node is ts.Identifier {
  return ts.isIdentifier(node) && node.text === expected && node.getText() === expected
}

function isDelegationField(expression: ts.Expression, field: 'actorId' | 'isPlatformAdmin'): boolean {
  const value = unwrap(expression)
  if (!ts.isPropertyAccessExpression(value) || value.questionDotToken) return false
  return identifierExact(unwrap(value.expression), 'delegation') && identifierExact(value.name, field)
}

function isSameIdentifier(expression: ts.Expression, name: string): boolean {
  const value = unwrap(expression)
  return identifierExact(value, name)
}

function valueMatches(key: string, value: ts.Expression): boolean {
  if (key === 'actorId') return isDelegationField(value, 'actorId')
  if (key === 'isPlatformAdmin') return isDelegationField(value, 'isPlatformAdmin')
  if (key === 'userId' || key === 'namespace' || key === 'enabled') return isSameIdentifier(value, key)
  return false
}

function isRouteHandler(node: ts.Node, tree: ts.SourceFile): boolean {
  const parent = node.parent
  if (!parent || !ts.isCallExpression(parent) || parent.arguments.at(-1) !== node) return false
  if (!ts.isPropertyAccessExpression(parent.expression) || parent.expression.expression.getText(tree) !== 'r') return false
  return identifierExact(parent.expression.name, parent.expression.name.text) && ROUTE_VERBS.has(parent.expression.name.text)
}

function isNestedRoute(registration: ts.Node, tree: ts.SourceFile): boolean {
  let cursor = registration.parent
  while (cursor) {
    if (ts.isFunctionLike(cursor) && isRouteHandler(cursor, tree)) return true
    cursor = cursor.parent
  }
  return false
}

function callerProblems(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const scalars = collectScalarBindings(tree)
  const problems: string[] = []
  let imports = 0
  let calls = 0
  const visit = (node: ts.Node) => {
    if ((ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) && constantText(node, scalars)?.includes(MODULE_STEM)) problems.push('computed module reference')
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const argument = node.argumentExpression
      if (ts.isStringLiteral(argument)) {
        const raw = rawQuoted(argument)
        if (argument.text === COMMAND_NAME && raw !== argument.text) problems.push('decoded string literal')
      }
      if (constantText(argument, scalars) === COMMAND_NAME) problems.push('computed command reference')
    }
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && node.text.includes(MODULE_STEM)) {
      if (ts.isStringLiteral(node)) {
        const raw = rawQuoted(node)
        if (raw !== node.text) problems.push('decoded string literal')
      }
      const parent = node.parent
      if (!ts.isImportDeclaration(parent) || parent.moduleSpecifier !== node) problems.push('non-static module reference')
      else {
        imports += 1
        const clause = parent.importClause
        const bindings = clause?.namedBindings
        const imported = bindings && ts.isNamedImports(bindings) && bindings.elements.length === 1 ? bindings.elements[0] : undefined
        const raw = ts.isStringLiteral(node) ? rawQuoted(node) : undefined
        if (file !== CALLER_FILE || !ts.isStringLiteral(node) || raw !== MODULE_NAME || !clause || clause.isTypeOnly || clause.name
          || !imported || imported.propertyName || imported.isTypeOnly || imported.name.text !== COMMAND_NAME || imported.name.getText() !== COMMAND_NAME) problems.push('import shape')
      }
    }
    if (ts.isIdentifier(node) && node.text === COMMAND_NAME && !ts.isImportSpecifier(node.parent)) {
      const parent = node.parent
      if (!ts.isCallExpression(parent) || parent.expression !== node || node.getText() !== COMMAND_NAME) problems.push('detached command reference')
      else {
        calls += 1
        const rawArgument = parent.arguments[0]
        const argument = rawArgument && unwrap(rawArgument)
        if (parent.arguments.length !== 1 || !argument || !ts.isObjectLiteralExpression(argument)) problems.push('data argument')
        else {
          const keys: string[] = []
          for (const property of argument.properties) {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
              problems.push('data property')
              continue
            }
            const name = property.name
            if (ts.isStringLiteral(name)) {
              const raw = rawQuoted(name)
              if (raw !== name.text) problems.push('decoded string literal')
              if (raw === undefined) {
                problems.push('data property')
                continue
              }
              keys.push(raw)
              const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer
              if ((raw === 'actorId' || raw === 'isPlatformAdmin' || raw === 'userId' || raw === 'namespace' || raw === 'enabled') && !valueMatches(raw, value)) problems.push('data binding')
            } else if (ts.isIdentifier(name) && identifierExact(name, name.text)) {
              keys.push(name.text)
              const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer
              if ((name.text === 'actorId' || name.text === 'isPlatformAdmin' || name.text === 'userId' || name.text === 'namespace' || name.text === 'enabled') && !valueMatches(name.text, value)) problems.push('data binding')
            } else problems.push('data property')
          }
          if (JSON.stringify(keys.sort()) !== JSON.stringify(INPUT_KEYS)) problems.push('data keys')
        }
        if (!ts.isAwaitExpression(parent.parent) || parent.parent.expression !== parent) problems.push('direct await')
        let owner: ts.Node | undefined = parent.parent
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
        const registration = owner?.parent
        const routeArg = registration && ts.isCallExpression(registration) ? registration.arguments[0] : undefined
        if (routeArg && ts.isStringLiteral(routeArg) && routeArg.text === ROUTE && rawQuoted(routeArg) !== routeArg.text) problems.push('decoded string literal')
        const verb = registration && ts.isCallExpression(registration) && ts.isPropertyAccessExpression(registration.expression) && identifierExact(registration.expression.name, 'patch')
        if (file !== CALLER_FILE || !owner || !ts.isArrowFunction(owner) || !owner.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
          || !registration || !ts.isCallExpression(registration) || registration.arguments.at(-1) !== owner || !verb
          || registration.expression.expression.getText(tree) !== 'r'
          || !routeArg || !ts.isStringLiteral(routeArg) || rawQuoted(routeArg) !== ROUTE
          || isNestedRoute(registration, tree)) problems.push('registered route')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (file === CALLER_FILE && (imports !== 1 || calls !== 1)) problems.push('caller coverage')
  return problems
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let cursor: ts.Node | undefined = node.parent
  while (cursor && !ts.isFunctionLike(cursor)) cursor = cursor.parent
  return cursor
}

function sourceGuardProblems(source: string): string[] {
  const tree = ts.createSourceFile(GUARD_FILE, source, ts.ScriptTarget.Latest, true)
  const faults: string[] = []
  const functions = tree.statements.filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && identifierExact(statement.name ?? ts.factory.createIdentifier(''), 'callerProblems'))
  if (functions.length !== 1 || !functions[0].body) faults.push('caller guard shape')
  const guard = functions[0]
  if (guard?.body) {
    const pushed: string[] = []
    let returns = 0
    const visit = (node: ts.Node) => {
      if (ts.isReturnStatement(node) && enclosingFunction(node) === guard) {
        returns += 1
        const value = node.expression && unwrap(node.expression)
        if (!value || !identifierExact(value, 'problems')) faults.push('caller guard shape')
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && enclosingFunction(node) === guard) {
        const left = node.left
        if ((ts.isIdentifier(left) && left.text === 'problems')
          || (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === 'problems')) faults.push('problems reassigned')
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'problems' && identifierExact(node.expression.name, 'push')
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && rawQuoted(node.arguments[0]) === node.arguments[0].text) pushed.push(node.arguments[0].text)
      ts.forEachChild(node, visit)
    }
    visit(guard.body)
    if (returns < 1) faults.push('caller guard shape')
    for (const code of PROBLEM_CODES) if (!pushed.includes(code)) faults.push('caller guard shape')
    const body = guard.body.getText(tree)
    for (const name of ['CALLER_FILE', 'COMMAND_NAME', 'INPUT_KEYS', 'MODULE_NAME', 'ROUTE']) if (!body.includes(name)) faults.push('caller guard shape')
    const binding = tree.statements.find((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'isDelegationField')
    if (!body.includes("'patch'") || !body.includes('valueMatches') || !binding?.body?.getText(tree).includes("'delegation'")) faults.push('caller guard shape')
  }
  let production = 0
  let negatives = 0
  const visitTree = (node: ts.Node) => {
    const expected = ts.isCallExpression(node) && node.arguments[0] ? unwrap(node.arguments[0]) : undefined
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      if (method === 'trim' || method === 'trimStart' || method === 'trimEnd' || method === 'trimLeft' || method === 'trimRight') faults.push('whitespace stripped')
    }
    if (ts.isCallExpression(node) && identifierExact(node.expression, 'it') && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && rawQuoted(node.arguments[0]) === PRODUCTION_TITLE) {
      production += 1
      const callback = node.arguments[1]
      const callbackText = callback?.getText(tree) ?? ''
      const closed = !!callback && ts.isFunctionLike(callback) && callbackText.includes('listFiles') && callbackText.includes('SOURCE_EXTENSIONS')
        && callbackText.includes('db/migrations') && callbackText.includes('!== COMMAND_FILE') && callbackText.includes('plugins')
        && callbackText.includes('callerProblems') && callbackText.includes('.toEqual([])')
      if (!closed) faults.push('production assertion')
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toEqual'
      && node.arguments.length === 1 && expected && ts.isArrayLiteralExpression(expected) && expected.elements.length === 0) {
      const notAccess = node.expression.expression
      if (ts.isPropertyAccessExpression(notAccess) && notAccess.name.text === 'not' && ts.isCallExpression(notAccess.expression)
        && identifierExact(notAccess.expression.expression, 'expect') && (notAccess.expression.arguments[0]?.getText(tree).includes('callerProblems') ?? false)) negatives += 1
    }
    ts.forEachChild(node, visitTree)
  }
  visitTree(tree)
  if (production !== 1) faults.push('production assertion')
  if (negatives < 1) faults.push('pure negative')
  return faults
}

describe('role delegation namespace admission caller boundary', () => {
  const argument = '{ actorId: delegation.actorId, userId, namespace, enabled, isPlatformAdmin: delegation.isPlatformAdmin }'
  const baseline = `import { ${COMMAND_NAME} } from '${MODULE_NAME}';\nr.patch('${ROUTE}', authenticate, async (req, res) => { await ${COMMAND_NAME}(${argument}); })`
  const wrapped = `import { ${COMMAND_NAME} } from "${MODULE_NAME}";\nr.patch("${ROUTE}", authenticate, async (req, res) => {\n  await ${COMMAND_NAME}(({\n    "actorId": ((delegation).actorId as string),\n    'userId': (userId as string),\n    namespace: (namespace satisfies string),\n    "enabled": ((enabled)),\n    'isPlatformAdmin': (delegation.isPlatformAdmin satisfies boolean),\n  } satisfies Record<string, unknown>));\n});\n`

  it('has one static data-only caller across production and plugins', () => {
    const files = listFiles(REPO_ROOT, { roots: [SRC, 'plugins'], exclude: [`${SRC}/db/migrations`] })
      .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)) && file !== COMMAND_FILE)
    expect(files).toContain(CALLER_FILE)
    expect(files.some((file) => file.startsWith('plugins/'))).toBe(true)
    expect(files).not.toContain(COMMAND_FILE)
    expect(files.flatMap((file) => callerProblems(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')))).toEqual([])
  })

  it('accepts quoted data keys, formatting and TypeScript value wrappers', () => {
    expect(callerProblems(CALLER_FILE, baseline)).toEqual([])
    expect(callerProblems(CALLER_FILE, wrapped)).toEqual([])
  })

  it('rejects decoded unicode string literals and whitespace that exact text would hide', () => {
    for (const candidate of [
      baseline.replace(MODULE_STEM, 'role-delegation-namespace-admission-\\u0063ommand'),
      baseline.replace(`'${ROUTE}'`, `'${ROUTE.replace('admission', '\\u0061dmission')}'`),
      baseline.replace('actorId:', "'\\u0061ctorId':"),
      baseline.replace(`'${MODULE_NAME}'`, `'${MODULE_NAME} '`),
      baseline.replace(ROUTE, `${ROUTE} `),
      baseline.replace('actorId:', "'actorId ':"),
      baseline.replace('actorId:', '"\'actorId\'":'),
      baseline + "\nconst invoke = loaded['writeRoleDelegationNamespaceAdmission\\u0043ommand'];",
    ]) expect(callerProblems(CALLER_FILE, candidate)).not.toEqual([])
  })

  it.each([
    'import(modulePrefix + moduleSuffix)',
    'import(`${modulePrefix}${moduleSuffix}`)',
  ])('rejects immutable local split module bindings: %s', (load) => {
    const source = "const modulePrefix = '../admin/role-delegation-namespace-admission-'; const moduleSuffix = 'command'; export const loaded = " + load
    expect(callerProblems(`${SRC}/other.ts`, source)).not.toEqual([])
  })

  it('does not borrow protected outer constants across shadowed module bindings', () => {
    const source = "const modulePrefix = '../admin/role-delegation-namespace-admission-'; const moduleSuffix = 'command'; function load(modulePrefix: string) { return import(modulePrefix + moduleSuffix) } function other() { const modulePrefix = '../ordinary/'; return import(`${modulePrefix}${moduleSuffix}`) }"
    expect(callerProblems(`${SRC}/other.ts`, source)).toEqual([])
    expect(() => callerProblems(`${SRC}/other.ts`, "const prefix = suffix; const suffix = prefix; export const loaded = import(prefix + suffix)")).not.toThrow()
  })

  it.each([
    ['class declaration', 'function load() { class modulePrefix {} return import(modulePrefix + moduleSuffix) }'],
    ['enum declaration', 'function load() { enum modulePrefix { Ordinary } return import(modulePrefix + moduleSuffix) }'],
    ['named function', 'const load = function modulePrefix() { return import(modulePrefix + moduleSuffix) }'],
    ['named class', 'const load = class modulePrefix { run() { return import(modulePrefix + moduleSuffix) } }'],
  ])('does not borrow an outer constant across a %s binding', (_name, body) => {
    const source = "const modulePrefix = '../admin/role-delegation-namespace-admission-'; const moduleSuffix = 'command'; " + body
    expect(callerProblems(`${SRC}/other.ts`, source)).toEqual([])
  })

  it('resolves finite immutable aliases without a silent depth cutoff', () => {
    const bindings = ["const piece0 = '../admin/role-delegation-namespace-admission-';"]
    for (let index = 1; index <= 20; index += 1) bindings.push(`const piece${index} = piece${index - 1};`)
    const source = bindings.join('\n') + "\nexport const loaded = import(piece20 + 'command')"
    expect(callerProblems(`${SRC}/other.ts`, source)).not.toEqual([])
  })

  it('rejects other importers, aliases, exports and decoded dynamic module references', () => {
    expect(callerProblems(`${SRC}/other.ts`, baseline)).not.toEqual([])
    for (const candidate of [
      baseline.replace(`{ ${COMMAND_NAME} }`, `{ ${COMMAND_NAME} as other }`),
      baseline.replace(`{ ${COMMAND_NAME} }`, `{ ${COMMAND_NAME}, other }`),
      baseline.replace(`import { ${COMMAND_NAME} }`, `import ${COMMAND_NAME}`),
      baseline.replace(`import { ${COMMAND_NAME} } from`, 'import * as namespace from'),
      baseline.replace(`import { ${COMMAND_NAME} }`, `import type { ${COMMAND_NAME} }`),
      baseline.replace(`import { ${COMMAND_NAME} }`, `import ${COMMAND_NAME}, { ${COMMAND_NAME} }`),
      baseline + `\nexport { ${COMMAND_NAME} } from '${MODULE_NAME}';`,
      baseline + `\nexport * from '${MODULE_NAME}';`,
      baseline + `\nconst loaded = import('${MODULE_NAME}');`,
      baseline + `\nconst loaded = require('${MODULE_NAME}');`,
      baseline + "\nconst loaded = import(`../admin/role-delegation-namespace-admission-\\u0063ommand`);",
      baseline + `\nconst loader = require; const loaded = loader('${MODULE_NAME}');`,
      baseline + `\nconst modulePath = '${MODULE_NAME}'; await import(modulePath);`,
    ]) expect(callerProblems(CALLER_FILE, candidate)).not.toEqual([])
  })

  it('rejects template and concatenated module references, including folded escapes', () => {
    for (const reference of [
      "const loaded = import(`../admin/role-delegation-namespace-admission-command${''}`);",
      "const loaded = require(`../admin/role-delegation-namespace-admission-\\u0063ommand${''}`);",
      "const loaded = import(`${''}../admin/role-delegation-namespace-admission-command`);",
      "const loaded = require(`${''}../admin/role-delegation-namespace-admission-\\u0063ommand`);",
      "const loaded = import(`${''}../admin/role-delegation-namespace-admission-command${''}`);",
      "const loaded = import('../admin/role-delegation-' + 'namespace-admission-command');",
      "const loaded = require('../admin/' + `role-delegation-namespace-admission-${'command'}`);",
      "const loaded = import(`../admin/role-${'delegation-namespace-admission-command'}`);",
      "const loaded = import(`../admin/${'role-delegation-namespace-admission-command'}`);",
    ]) {
      expect(callerProblems(CALLER_FILE, `${baseline}\n${reference}`)).not.toEqual([])
      expect(callerProblems(`${SRC}/other.ts`, reference)).not.toEqual([])
    }
  })

  it('rejects element, detached and nested-helper references', () => {
    for (const candidate of [
      baseline.replace(`await ${COMMAND_NAME}(${argument})`, `const detached = ${COMMAND_NAME}; await detached(${argument})`),
      baseline.replace(`await ${COMMAND_NAME}(${argument})`, `await refs['${COMMAND_NAME}'](${argument})`),
      baseline.replace(`await ${COMMAND_NAME}(${argument})`, `await Promise.resolve().then(() => ${COMMAND_NAME}(${argument}))`),
      baseline + `\nconst detached = ${COMMAND_NAME};`,
      baseline + `\nconst invoke = loaded['writeRoleDelegation' + 'NamespaceAdmissionCommand'];`,
      baseline + `\nrefs['${COMMAND_NAME}'];`,
      `import { ${COMMAND_NAME} } from '${MODULE_NAME}';\nr.patch('${ROUTE}', authenticate, async (req, res) => { const fallback = async () => { await ${COMMAND_NAME}(${argument}); }; await fallback(); })`,
    ]) expect(callerProblems(CALLER_FILE, candidate)).not.toEqual([])
  })

  it('rejects nested, unregistered, wrong-method and wrong-path routes', () => {
    for (const candidate of [
      baseline.replace('r.patch(', 'r.post('),
      baseline.replace('r.patch(', 'r.get('),
      baseline.replace('r.patch(', 'router.patch('),
      baseline.replace('r.patch(', "r['patch']("),
      baseline.replace('r.patch(', '(r).patch('),
      baseline.replace(ROUTE, `${ROUTE}/extra`),
      baseline.replace(`'${ROUTE}'`, `\`\${'${ROUTE}'}\``),
      baseline.replace('async (req, res)', '(req, res)'),
      baseline.replace('async (req, res) =>', 'async function (req, res)'),
      baseline.replace(`await ${COMMAND_NAME}`, COMMAND_NAME),
      `import { ${COMMAND_NAME} } from '${MODULE_NAME}';\nconst handler = async (req, res) => { await ${COMMAND_NAME}(${argument}); };\nr.patch('${ROUTE}', authenticate, handler);`,
      `import { ${COMMAND_NAME} } from '${MODULE_NAME}';\nr.get('/api/other', authenticate, async (req, res) => { r.patch('${ROUTE}', authenticate, async (req, res) => { await ${COMMAND_NAME}(${argument}); }); });`,
      baseline.replace(', authenticate, async (req, res) => {', ', async (req, res) => {').replace('); })', '); }, authenticate)'),
    ]) expect(callerProblems(CALLER_FILE, candidate)).not.toEqual([])
  })

  it('rejects spreads, duplicates, computed keys and non-data bindings', () => {
    for (const candidate of [
      baseline.replace('actorId: delegation.actorId', 'actorId: userId'),
      baseline.replace('actorId: delegation.actorId', 'actorId: delegation.userId'),
      baseline.replace('actorId: delegation.actorId', 'actorId: delegation?.actorId'),
      baseline.replace('actorId: delegation.actorId', "actorId: delegation['actorId']"),
      baseline.replace('isPlatformAdmin: delegation.isPlatformAdmin', 'isPlatformAdmin: isPlatformAdmin'),
      baseline.replace('isPlatformAdmin: delegation.isPlatformAdmin', 'isPlatformAdmin: delegation.actorId'),
      baseline.replace('userId,', 'userId: other,'),
      baseline.replace('namespace,', 'namespace: delegation.namespace,'),
      baseline.replace('enabled,', 'enabled: true,'),
      baseline.replace('enabled,', 'enabled, tx,'),
      baseline.replace('enabled,', 'enabled, runner,'),
      baseline.replace('enabled,', 'enabled, callback: () => {},'),
      baseline.replace('enabled,', 'enabled, hook: () => {},'),
      baseline.replace('enabled,', 'enabled, ...other,'),
      baseline.replace('enabled,', 'enabled, enabled,'),
      baseline.replace('actorId:', '[actorId]:'),
      baseline.replace('enabled,', 'enabled() {},'),
      baseline.replace(argument, 'input'),
      baseline.replace(argument, `${argument}, tx`),
      baseline.replace(argument, `({ ...${argument} })`),
    ]) expect(callerProblems(CALLER_FILE, candidate)).not.toEqual([])
  })

  it('requires exactly one import and one invocation in the registered caller', () => {
    expect(callerProblems(CALLER_FILE, '')).not.toEqual([])
    expect(callerProblems(CALLER_FILE, baseline + baseline)).not.toEqual([])
    expect(callerProblems(CALLER_FILE, baseline.replace(`await ${COMMAND_NAME}(${argument});`, ''))).not.toEqual([])
    expect(callerProblems(COMMAND_FILE, fs.readFileSync(path.join(REPO_ROOT, COMMAND_FILE), 'utf8'))).not.toEqual([])
  })

  it('does not treat other namespace-admission writers as this command', () => {
    const other = [
      "import { writeUserNamespaceAdmission } from '../rbac/namespace-admission'",
      'await writeUserNamespaceAdmission(tx, { userId, namespace, enabled })',
      "import { writePlatformNamespaceAdmissionCommand } from '../admin/platform-namespace-admission-command'",
      'await writePlatformNamespaceAdmissionCommand({ actorId: adminUserId, userId, namespace, enabled })',
      "import { writePlatformNamespaceAdmissionBulkCommand } from '../admin/platform-namespace-admission-bulk-command'",
      'await writePlatformNamespaceAdmissionBulkCommand({ actorId: adminUserId, userIds, namespace, enabled })',
    ].join('\n')
    expect(callerProblems(`${SRC}/rbac/namespace-admission.ts`, other)).toEqual([])
    expect(callerProblems(CALLER_FILE, `${baseline}\n${other}`)).toEqual([])
    for (const file of [
      `${SRC}/rbac/namespace-admission.ts`,
      `${SRC}/admin/platform-namespace-admission-command.ts`,
      `${SRC}/admin/platform-namespace-admission-bulk-command.ts`,
    ]) expect(callerProblems(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))).toEqual([])
  })

  it('keeps a structural source guard that a permissive bypass turns red', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, GUARD_FILE), 'utf8')
    expect(sourceGuardProblems(source)).toEqual([])
    const marker = 'const problems: string[] = []'
    expect(source.includes(marker)).toBe(true)
    expect(sourceGuardProblems(source.replace(marker, `${marker}; return []`))).not.toEqual([])
    expect(sourceGuardProblems(source.replace(`it('${PRODUCTION_TITLE}'`, `it.skip('${PRODUCTION_TITLE}'`))).not.toEqual([])
    expect(sourceGuardProblems(source.replace('return text.slice(1, -1)', 'return text.slice(1, -1).trim()'))).not.toEqual([])
  })
})
