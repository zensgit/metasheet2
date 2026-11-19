import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { listFiles, SOURCE_EXTENSIONS } from '../helpers/authorization-input-scan'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SRC = 'packages/core-backend/src'
const COMMAND_FILE = `${SRC}/admin/platform-namespace-admission-bulk-command.ts`
const CALLER_FILE = `${SRC}/routes/admin-users.ts`
const COMMAND_NAME = 'writePlatformNamespaceAdmissionBulkCommand'
const COMMAND_STEM = 'platform-namespace-admission-bulk-command'
const MODULE_NAME = `../admin/${COMMAND_STEM}`
const ROUTE = '/api/admin/users/namespaces/:namespace/admission/bulk'
const INPUT_KEYS = ['actorId', 'enabled', 'namespace', 'userIds']

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression
  return expression
}

function callerProblems(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const problems: string[] = []
  let imports = 0
  let calls = 0
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && node.text.includes(COMMAND_STEM)) {
      const parent = node.parent
      if (!ts.isImportDeclaration(parent) || parent.moduleSpecifier !== node) problems.push('non-static module reference')
      else {
        imports += 1
        const clause = parent.importClause
        const bindings = clause?.namedBindings
        if (file !== CALLER_FILE || !ts.isStringLiteral(node) || node.text !== MODULE_NAME || !clause || clause.isTypeOnly || clause.name
          || !bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== 1
          || bindings.elements[0].propertyName || bindings.elements[0].isTypeOnly || bindings.elements[0].name.text !== COMMAND_NAME) problems.push('import shape')
      }
    }
    if (ts.isIdentifier(node) && node.text === COMMAND_NAME) {
      const parent = node.parent
      if (ts.isImportSpecifier(parent)) return
      if (!ts.isCallExpression(parent) || parent.expression !== node) problems.push('detached command reference')
      else {
        calls += 1
        const argument = parent.arguments[0]
        if (parent.arguments.length !== 1 || !argument || !ts.isObjectLiteralExpression(argument)) problems.push('data argument')
        else {
          const keys: string[] = []
          for (const property of argument.properties) {
            if ((!ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property))
              || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
              problems.push('data property')
              continue
            }
            const key = property.name.text
            keys.push(key)
            const value = unwrap(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer)
            if (!ts.isIdentifier(value) || value.text !== (key === 'actorId' ? 'adminUserId' : key)) problems.push('data binding')
          }
          if (JSON.stringify(keys.sort()) !== JSON.stringify(INPUT_KEYS)) problems.push('data keys')
        }
        let owner: ts.Node | undefined = parent.parent
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
        const registration = owner?.parent
        if (file !== CALLER_FILE || !owner || !ts.isArrowFunction(owner) || !registration || !ts.isCallExpression(registration)
          || !ts.isPropertyAccessExpression(registration.expression) || registration.expression.expression.getText(tree) !== 'r'
          || registration.expression.name.text !== 'post' || registration.arguments.at(-1) !== owner
          || !registration.arguments[0] || !ts.isStringLiteral(registration.arguments[0]) || registration.arguments[0].text !== ROUTE) problems.push('registered route')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (file === CALLER_FILE && (imports !== 1 || calls !== 1)) problems.push('caller coverage')
  return problems
}

describe('platform namespace admission bulk caller boundary', () => {
  const baseline = `import { ${COMMAND_NAME} } from '${MODULE_NAME}';\nr.post('${ROUTE}', authenticate, async (req, res) => { await ${COMMAND_NAME}({ actorId: adminUserId, userIds, namespace, enabled }); })`

  it('has one static data-only caller across production and plugins', () => {
    const files = listFiles(REPO_ROOT, { roots: [SRC, 'plugins'], exclude: [`${SRC}/db/migrations`] })
      .filter(file => SOURCE_EXTENSIONS.has(path.extname(file)) && file !== COMMAND_FILE)
    expect(files).toContain(CALLER_FILE)
    expect(files.some(file => file.startsWith('plugins/'))).toBe(true)
    expect(files.flatMap(file => callerProblems(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')))).toEqual([])
  })

  it('accepts quoted data keys, formatting and TypeScript value wrappers', () => {
    expect(callerProblems(CALLER_FILE, baseline)).toEqual([])
    expect(callerProblems(CALLER_FILE, baseline.replace(COMMAND_STEM, 'platform-namespace-admission-bulk-\\u0063ommand'))).toEqual([])
    expect(callerProblems(CALLER_FILE, baseline.replace('actorId: adminUserId', "'actorId': (adminUserId as string)").replace('userIds, namespace', "'userIds': (userIds satisfies string[]), namespace"))).toEqual([])
  })

  it('rejects other importers, aliases, exports and decoded dynamic module references', () => {
    expect(callerProblems(`${SRC}/other.ts`, baseline)).not.toEqual([])
    for (const candidate of [
      baseline.replace(`{ ${COMMAND_NAME} }`, `{ ${COMMAND_NAME} as other }`),
      baseline.replace(`{ ${COMMAND_NAME} }`, `{ ${COMMAND_NAME}, other }`),
      baseline.replace(`{ ${COMMAND_NAME} }`, COMMAND_NAME),
      baseline + `\nexport { ${COMMAND_NAME} } from '${MODULE_NAME}';`,
      baseline + `\nconst loaded = import('${MODULE_NAME}');`,
      baseline + "\nconst loaded = import('../admin/platform-namespace-admission-bulk-\\u0063ommand');",
      baseline + "\nconst loaded = require(`../admin/platform-namespace-admission-bulk-\\u0063ommand`);",
      baseline + `\nconst loader = require; const loaded = loader('${MODULE_NAME}');`,
    ]) expect(callerProblems(CALLER_FILE, candidate)).not.toEqual([])
  })

  it('rejects interpolated-template module heads and spans, including decoded escapes', () => {
    for (const reference of [
      "const loaded = import(`../admin/platform-namespace-admission-bulk-command${''}`);",
      "const loaded = require(`../admin/platform-namespace-admission-bulk-command${''}`);",
      "const loaded = import(`../admin/platform-namespace-admission-bulk-\\u0063ommand${''}`);",
      "const loaded = require(`../admin/platform-namespace-admission-bulk-\\u0063ommand${''}`);",
      "const loaded = import(`${''}../admin/platform-namespace-admission-bulk-command`);",
      "const loaded = require(`${''}../admin/platform-namespace-admission-bulk-\\u0063ommand`);",
      "const loaded = import(`${''}../admin/platform-namespace-admission-bulk-command${''}`);",
      "const loaded = require(`${''}../admin/platform-namespace-admission-bulk-\\u0063ommand${''}`);",
    ]) {
      expect(callerProblems(CALLER_FILE, `${baseline}\n${reference}`)).not.toEqual([])
      expect(callerProblems(`${SRC}/other.ts`, reference)).not.toEqual([])
    }
  })

  it('rejects wrong registrations and non-data-only argument bindings', () => {
    for (const candidate of [
      baseline.replace('r.post(', 'r.patch('),
      baseline.replace(ROUTE, `${ROUTE} `),
      baseline.replace('actorId: adminUserId', 'actorId: userIds'),
      baseline.replace('actorId: adminUserId', "\"'actorId'\": adminUserId"),
      baseline.replace('namespace, enabled', 'namespace, enabled: true'),
      baseline.replace('userIds, namespace', 'userIds: otherIds, namespace'),
      baseline.replace('namespace, enabled', 'namespace, enabled, callback: () => {}'),
      baseline.replace('namespace, enabled', 'namespace, enabled, ...other'),
      baseline.replace('namespace, enabled', 'namespace, enabled, tx'),
      baseline.replace('namespace, enabled', 'namespace, enabled() {}'),
      baseline.replace('{ actorId: adminUserId, userIds, namespace, enabled }', 'input'),
      baseline.replace('{ actorId: adminUserId, userIds, namespace, enabled }', '{ actorId: adminUserId, userIds, namespace, enabled }, tx'),
    ]) expect(callerProblems(CALLER_FILE, candidate)).not.toEqual([])
  })

  it('rejects detached and nested callback references', () => {
    for (const candidate of [
      baseline.replace(`await ${COMMAND_NAME}`, `const detached = ${COMMAND_NAME}; await detached`),
      baseline.replace(`await ${COMMAND_NAME}`, `await Promise.resolve().then(() => ${COMMAND_NAME}`).replace('enabled });', 'enabled }));'),
      baseline + `\nconst detached = ${COMMAND_NAME};`,
    ]) expect(callerProblems(CALLER_FILE, candidate)).not.toEqual([])
  })

  it('requires exactly one import and one invocation in the registered caller', () => {
    expect(callerProblems(CALLER_FILE, '')).not.toEqual([])
    expect(callerProblems(CALLER_FILE, baseline + baseline)).not.toEqual([])
    expect(callerProblems(CALLER_FILE, baseline.replace(`await ${COMMAND_NAME}({ actorId: adminUserId, userIds, namespace, enabled });`, ''))).not.toEqual([])
  })
})
