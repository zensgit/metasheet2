import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { listFiles, scanSource, SOURCE_EXTENSIONS } from '../helpers/authorization-input-scan'
import { AUTHORIZATION_INPUT_WRITERS } from '../../src/rbac/authorization-input-writers'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SRC = 'packages/core-backend/src'
const COMMAND = 'createAdminBatchUserCommand'
const STEM = 'admin-user-batch-birth-command'
const MODULE = `../admin/${STEM}`
const COMMAND_FILE = `${SRC}/admin/${STEM}.ts`
const CALLER_FILE = `${SRC}/routes/admin-user-batch.ts`
const REGISTRY_FILE = `${SRC}/rbac/authorization-input-writers.ts`
const ROOT = 'withAuthorizationInputTransaction'
const FIELDS = ['actorId', 'department', 'email', 'name', 'passwordHash', 'roleId', 'userId']

function unwrap(value: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression
  return value
}

function nodes(tree: ts.Node): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (node: ts.Node) => { found.push(node); ts.forEachChild(node, visit) }
  visit(tree)
  return found
}

function owner(node: ts.Node): ts.Node | undefined {
  let current = node.parent
  while (current && !ts.isFunctionLike(current)) current = current.parent
  return current
}

// Resolve only immutable same-file scalar/object constants. Ambiguous bindings remain unresolved.
function initializer(identifier: ts.Identifier): ts.Expression | undefined {
  let scope: ts.Node | undefined = identifier.parent
  while (scope) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isFunctionLike(scope)) {
      const declarations = nodes(scope).filter(node => {
        if (!ts.isVariableDeclaration(node) && !ts.isParameter(node) && !ts.isBindingElement(node)) return false
        if (!ts.isIdentifier(node.name) || node.name.text !== identifier.text) return false
        let current: ts.Node | undefined = node.parent
        while (current && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) current = current.parent
        return current === scope
      })
      if (declarations.length) {
        const declaration = declarations[0]
        return declarations.length === 1 && ts.isVariableDeclaration(declaration)
          && ts.isVariableDeclarationList(declaration.parent)
          && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 ? declaration.initializer : undefined
      }
    }
    scope = scope.parent
  }
  return undefined
}

function textOf(expression: ts.Expression, seen = new Set<ts.Node>()): string | undefined {
  const value = unwrap(expression)
  if (seen.has(value)) return undefined
  seen.add(value)
  if (ts.isStringLiteralLike(value)) return value.text
  if (ts.isIdentifier(value)) {
    const declared = initializer(value)
    return declared ? textOf(declared, seen) : undefined
  }
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = textOf(value.left, new Set(seen))
    const right = textOf(value.right, new Set(seen))
    return left === undefined || right === undefined ? undefined : left + right
  }
  if (ts.isTemplateExpression(value)) {
    let text = value.head.text
    for (const span of value.templateSpans) {
      const part = textOf(span.expression, new Set(seen))
      if (part === undefined) return undefined
      text += part + span.literal.text
    }
    return text
  }
  return undefined
}

function objectOf(expression: ts.Expression, seen = new Set<ts.Node>()): ts.ObjectLiteralExpression | undefined {
  const value = unwrap(expression)
  if (seen.has(value)) return undefined
  seen.add(value)
  if (ts.isObjectLiteralExpression(value)) return value
  if (ts.isIdentifier(value)) {
    const declared = initializer(value)
    return declared ? objectOf(declared, seen) : undefined
  }
  if (ts.isCallExpression(value) && value.expression.getText() === 'Object.freeze' && value.arguments.length === 1) return objectOf(value.arguments[0], seen)
  if (ts.isPropertyAccessExpression(value)) {
    const object = objectOf(value.expression, seen)
    const member = object && fieldsOf(object)?.get(value.name.text)
    if (member) return objectOf(member, seen)
  }
  return undefined
}

function fieldsOf(object: ts.ObjectLiteralExpression): Map<string, ts.Expression> | undefined {
  const fields = new Map<string, ts.Expression>()
  for (const property of object.properties) {
    if ((!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) || !ts.isIdentifier(property.name)) return undefined
    const key = property.name.text
    if (fields.has(key)) return undefined
    fields.set(key, ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer)
  }
  return fields
}

function bindingMatches(expression: ts.Expression, expected: string, seen = new Set<ts.Node>()): boolean {
  const value = unwrap(expression)
  if (value.getText() === expected) return true
  if (!ts.isIdentifier(value) || seen.has(value)) return false
  seen.add(value)
  const declared = initializer(value)
  return declared !== undefined && bindingMatches(declared, expected, seen)
}

function named(value: ts.Expression, name: string): boolean {
  const expression = unwrap(value)
  return ts.isIdentifier(expression) && expression.text === name
}

function stringValue(value: ts.Expression, text: string): boolean {
  const expression = unwrap(value)
  return ts.isStringLiteral(expression) && expression.text === text
}

function privateDataFunction(tree: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  const functions = nodes(tree).filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name)
  const declaration = functions[0]
  if (functions.length !== 1 || !declaration || declaration.parent !== tree || declaration.modifiers?.length
    || declaration.asteriskToken || declaration.typeParameters?.length || declaration.parameters.length !== 1
    || !ts.isIdentifier(declaration.parameters[0].name) || declaration.parameters[0].dotDotDotToken
    || declaration.parameters[0].initializer || !declaration.body) return undefined
  return declaration
}

// This accepts only the local closed row constructor, never a caller-supplied map or callback.
function closedBirthRow(argument: ts.Expression, tree: ts.SourceFile, entry: ts.FunctionDeclaration | undefined, plan: ts.ObjectLiteralExpression | undefined): boolean {
  const call = unwrap(argument)
  if (!ts.isCallExpression(call) || !named(call.expression, 'birthRow') || call.arguments.length !== 1) return false
  const context = unwrap(call.arguments[0])
  const declared = ts.isIdentifier(context) ? initializer(context) : undefined
  if (!declared || owner(declared) !== entry || !ts.isCallExpression(declared)
    || declared.expression.getText() !== 'Object.freeze' || declared.arguments.length !== 1) return false
  const contextObject = objectOf(declared)
  const contextPlan = contextObject && fieldsOf(contextObject)?.get('plan')
  if (!contextPlan || objectOf(contextPlan) !== plan) return false
  const helper = privateDataFunction(tree, 'birthRow')
  const display = privateDataFunction(tree, 'displayRole')
  if (!helper?.body || !display?.body || helper.body.statements.length !== 2 || display.body.statements.length !== 1) return false
  const parameter = helper.parameters[0].name.getText()
  const roleParameter = display.parameters[0].name.getText()
  const roleStatement = helper.body.statements[0]
  const returned = helper.body.statements[1]
  const displayReturn = display.body.statements[0]
  if (!ts.isVariableStatement(roleStatement) || (roleStatement.declarationList.flags & ts.NodeFlags.Const) === 0
    || roleStatement.declarationList.declarations.length !== 1 || !ts.isReturnStatement(returned) || !returned.expression
    || !ts.isReturnStatement(displayReturn) || !displayReturn.expression) return false
  const role = roleStatement.declarationList.declarations[0]
  const roleCall = role.initializer && unwrap(role.initializer)
  if (!ts.isIdentifier(role.name) || role.name.text === parameter || !roleCall || !ts.isCallExpression(roleCall)
    || !named(roleCall.expression, 'displayRole') || roleCall.arguments.length !== 1
    || unwrap(roleCall.arguments[0]).getText() !== `${parameter}.roleId`) return false
  const formula = unwrap(displayReturn.expression)
  if (!ts.isConditionalExpression(formula)) return false
  const condition = unwrap(formula.condition)
  const fallback = unwrap(formula.whenFalse)
  if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
    || !named(condition.left, roleParameter) || !stringValue(condition.right, 'admin') || !stringValue(formula.whenTrue, 'admin')
    || !ts.isBinaryExpression(fallback) || fallback.operatorToken.kind !== ts.SyntaxKind.BarBarToken
    || !named(fallback.left, roleParameter) || !stringValue(fallback.right, 'user')) return false
  for (const [name, declaration, use] of [['birthRow', helper, call.expression], ['displayRole', display, roleCall.expression]] as const) {
    if (nodes(tree).some(node => ts.isIdentifier(node) && node.text === name && node !== declaration.name && node !== use)) return false
  }
  const literal = unwrap(returned.expression)
  const row = ts.isObjectLiteralExpression(literal) ? fieldsOf(literal) : undefined
  const sources = new Map([
    ['id', `${parameter}.userId`], ['email', `${parameter}.email`], ['name', `${parameter}.name`],
    ['department', `${parameter}.department`], ['password_hash', `${parameter}.passwordHash`], ['role', role.name.text],
  ])
  const nulls = ['username', 'mobile', 'employee_no', 'position', 'hire_date']
  const truths = ['must_change_password', 'is_active', 'local_password_set']
  const keys = [...sources.keys(), ...nulls, ...truths, 'permissions', 'is_admin', 'activation_status'].sort()
  if (!row || JSON.stringify([...row.keys()].sort()) !== JSON.stringify(keys)) return false
  for (const [key, source] of sources) if (unwrap(row.get(key)!).getText() !== source) return false
  if (nulls.some(key => unwrap(row.get(key)!).kind !== ts.SyntaxKind.NullKeyword)
    || truths.some(key => unwrap(row.get(key)!).kind !== ts.SyntaxKind.TrueKeyword)
    || !stringValue(row.get('permissions')!, '[]') || !stringValue(row.get('activation_status')!, 'activated')) return false
  const admin = unwrap(row.get('is_admin')!)
  return ts.isBinaryExpression(admin) && admin.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && named(admin.left, role.name.text) && stringValue(admin.right, 'admin')
}

function immediateAwait(call: ts.CallExpression): boolean {
  return ts.isAwaitExpression(call.parent) && call.parent.expression === call
}

// B-05 describes the producer; only its exact array entry's two data values are references.
function registryReferences(tree: ts.SourceFile): ts.Expression[] {
  const declarations = tree.statements.filter(ts.isVariableStatement)
    .filter(statement => statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
      && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0)
    .flatMap(statement => [...statement.declarationList.declarations])
    .filter(declaration => declaration.name.getText() === 'AUTHORIZATION_INPUT_WRITERS')
  const declared = declarations[0]?.initializer
  if (declarations.length !== 1 || !declared || !ts.isCallExpression(declared)
    || declared.expression.getText() !== 'Object.freeze' || declared.arguments.length !== 1
    || !ts.isArrayLiteralExpression(declared.arguments[0])) return []
  const candidates = declared.arguments[0].elements.filter(ts.isCallExpression)
    .filter(call => named(call.expression, 'entry') && call.arguments.length === 1 && ts.isObjectLiteralExpression(call.arguments[0]))
    .map(call => fieldsOf(call.arguments[0] as ts.ObjectLiteralExpression))
    .filter(fields => fields?.get('id') && textOf(fields.get('id')!) === 'B-05')
  const fields = candidates[0]
  if (candidates.length !== 1 || !fields) return []
  const expected = new Map([['id', 'B-05'], ['file', COMMAND_FILE], ['symbol', COMMAND], ['intent', 'BIRTH'],
    ['class', 'B'], ['actor', 'human'], ['slice', 'AIS-2c']])
  if (fields.has('status')) expected.set('status', 'pending')
  if (JSON.stringify([...fields.keys()].sort()) !== JSON.stringify([...expected.keys(), 'statements'].sort())) return []
  for (const [key, value] of expected) {
    const expression = fields.get(key)!
    if ((!ts.isStringLiteralLike(expression) && !(key === 'file' && ts.isTemplateExpression(expression))) || textOf(expression) !== value) return []
  }
  const statements = fields.get('statements')!
  if (!ts.isArrayLiteralExpression(statements) || statements.elements.length) return []
  return [fields.get('file')!, fields.get('symbol')!]
}

function callerProblems(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const problems: string[] = []
  const allowed = new Set<ts.Node>(file === REGISTRY_FILE ? registryReferences(tree) : [])
  let imports = 0
  let calls = 0
  for (const node of nodes(tree)) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.includes(STEM)) {
      imports++
      const bindings = node.importClause?.namedBindings
      if (file !== CALLER_FILE || node.moduleSpecifier.text !== MODULE || ![JSON.stringify(MODULE), `'${MODULE}'`].includes(node.moduleSpecifier.getText())
        || node.importClause?.isTypeOnly || node.importClause?.name || !bindings || !ts.isNamedImports(bindings)
        || bindings.elements.length !== 1 || bindings.elements[0].name.text !== COMMAND
        || bindings.elements[0].propertyName || bindings.elements[0].isTypeOnly) problems.push('static importer')
      else {
        allowed.add(node.moduleSpecifier)
        allowed.add(bindings.elements[0].name)
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === COMMAND) {
      calls++
      allowed.add(node.expression)
      const enclosing = owner(node)
      const argument = node.arguments[0]
      const fields = argument && ts.isObjectLiteralExpression(argument) ? fieldsOf(argument) : undefined
      if (file !== CALLER_FILE || !enclosing || !ts.isFunctionDeclaration(enclosing) || enclosing.name?.text !== 'createOne'
        || enclosing.parent !== tree || !immediateAwait(node) || node.arguments.length !== 1
        || !fields || JSON.stringify([...fields.keys()].sort()) !== JSON.stringify(FIELDS)) problems.push('data-only createOne caller')
      if (fields) for (const [key, value] of fields) {
        const expected = key === 'actorId' ? 'adminUserId' : ['email', 'name', 'department', 'roleId'].includes(key) ? `row.${key}` : key
        if (!bindingMatches(value, expected)) problems.push('data binding')
      }
      if (enclosing && ts.isFunctionDeclaration(enclosing)) {
        const scan = scanSource(CALLER_FILE, enclosing.getText())
        if (scan.writes.length || scan.dynamic.length) problems.push('raw createOne DML')
        if (nodes(enclosing).some(child => child !== enclosing && (ts.isFunctionLike(child)
          || (ts.isIdentifier(child) && ['query', 'transaction', 'connect', 'getInternalPool'].includes(child.text))))) problems.push('alternate createOne runner')
      }
    }
  }
  for (const node of nodes(tree)) {
    if (ts.isIdentifier(node) && node.text === COMMAND && !allowed.has(node)) problems.push('detached command reference')
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      const value = textOf(node)
      if (value !== undefined && (value.includes(STEM) || value === COMMAND) && !allowed.has(node)) problems.push('computed or non-static module reference')
    }
  }
  if (file === CALLER_FILE && (imports !== 1 || calls !== 1)) problems.push('caller coverage')
  return [...new Set(problems)].sort()
}

function commandProblems(source: string): string[] {
  const tree = ts.createSourceFile(COMMAND_FILE, source, ts.ScriptTarget.Latest, true)
  const all = nodes(tree)
  const problems: string[] = []
  const declarations = all.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === COMMAND)
  const entry = declarations[0]
  if (declarations.length !== 1 || !entry || entry.parent !== tree || entry.parameters.length !== 1 || !ts.isIdentifier(entry.parameters[0].name)
    || entry.parameters[0].dotDotDotToken || entry.parameters[0].initializer || !entry.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) problems.push('data-only command entry')
  const roots = all.filter(ts.isCallExpression).filter(node => ts.isIdentifier(node.expression) && node.expression.text === ROOT)
  const rootImports = all.filter(ts.isImportDeclaration).filter(node => node.importClause?.namedBindings
    && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.some(binding => binding.name.text === ROOT))
  const rootImport = rootImports[0]
  if (rootImports.length !== 1 || !rootImport || !ts.isStringLiteral(rootImport.moduleSpecifier)
    || rootImport.moduleSpecifier.text !== '../rbac/authorization-input-lock') problems.push('canonical root import')
  const root = roots[0]
  const work = root?.arguments[1]
  if (roots.length !== 1 || !root || owner(root) !== entry || root.arguments.length !== 2
    || (!immediateAwait(root) && !ts.isReturnStatement(root.parent))
    || !work || !ts.isArrowFunction(work) || work.parameters.length !== 1 || !ts.isIdentifier(work.parameters[0].name)
    || work.parameters[0].name.text !== 'tx' || work.parameters[0].dotDotDotToken || work.parameters[0].initializer) problems.push('one default root')
  const plan = root?.arguments[0] && objectOf(root.arguments[0])
  const fields = plan && fieldsOf(plan)
  if (!fields || JSON.stringify([...fields.keys()].sort()) !== JSON.stringify(['intent', 'roleIds', 'witness'])
    || textOf(fields.get('intent')!) !== 'BIRTH') problems.push('closed BIRTH plan')
  let inserts = 0
  for (const node of all) {
    if (entry && node !== entry && node !== work && ts.isFunctionLike(node)
      && node.getStart() > entry.getStart() && node.getEnd() < entry.getEnd()) problems.push('hidden command callback')
    if (ts.isIdentifier(node) && node.text === ROOT) {
      if (ts.isImportSpecifier(node.parent) && !node.parent.propertyName && node.parent.name === node) continue
      if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) problems.push('detached root')
    }
    if (ts.isImportDeclaration(node) && (/\/(?:db\/pg|integration\/db\/connection-pool)$/.test((node.moduleSpecifier as ts.StringLiteral).text ?? '')
      || node.importClause?.getText().match(/\b(?:PoolClient|enterAuthorizationInputTransaction|poolManager|transaction)\b/))) problems.push('raw transaction surface')
    if (ts.isIdentifier(node) && node.text === 'insertUserForBirth') {
      const access = node.parent
      const call = access.parent
      inserts++
      if (!ts.isPropertyAccessExpression(access) || access.name !== node || !ts.isIdentifier(access.expression) || access.expression.text !== 'tx'
        || !ts.isCallExpression(call) || call.expression !== access || call.arguments.length !== 1
        || owner(call) !== work || !immediateAwait(call)) problems.push('owned born insertion')
      else {
        const argument = unwrap(call.arguments[0])
        if (!(ts.isObjectLiteralExpression(argument) && fieldsOf(argument)) && !closedBirthRow(argument, tree, entry, plan)) problems.push('closed birth row constructor')
      }
    }
    if (ts.isElementAccessExpression(node) && textOf(node.argumentExpression) === 'insertUserForBirth') problems.push('computed born insertion')
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && node.expression.getText() === 'tx') {
      const member = ts.isPropertyAccessExpression(node) ? node.name.text : textOf(node.argumentExpression)
      if (member === 'acquire') problems.push('late acquire')
      if (member === 'query' && (!ts.isCallExpression(node.parent) || node.parent.expression !== node)) problems.push('detached token query')
    }
    if (work && ts.isArrowFunction(work) && node !== work.parameters[0] && (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
      && node.getStart() > work.getStart() && node.getEnd() < work.getEnd() && node.name.getText() === 'tx') problems.push('token shadow')
    if ((ts.isVariableDeclaration(node) && node.initializer && unwrap(node.initializer).getText() === 'tx')
      || (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && (node.left.getText() === 'tx' || node.right.getText() === 'tx'))
      || (ts.isSpreadAssignment(node) && node.expression.getText() === 'tx')
      || (ts.isReturnStatement(node) && node.expression && unwrap(node.expression).getText() === 'tx')) problems.push('token alias or reassignment')
  }
  if (inserts !== 1) problems.push('one born insertion')
  const scan = scanSource(COMMAND_FILE, source)
  if (scan.writes.length || scan.dynamic.length) problems.push('copied or dynamic input DML')
  return [...new Set(problems)].sort()
}

const GOOD_CALLER = `import { ${COMMAND} } from '${MODULE}'
async function createOne(adminUserId, row) {
  const userId = 'synthetic'
  const passwordHash = 'synthetic'
  await ${COMMAND}({ actorId: adminUserId, userId, email: row.email, name: row.name, department: row.department, passwordHash, roleId: row.roleId })
}`
const GOOD_COMMAND = `import { ${ROOT} } from '../rbac/authorization-input-lock'
export async function ${COMMAND}(input) {
  const plan = Object.freeze({ intent: 'BIRTH', roleIds: [], witness: {} })
  return ${ROOT}(plan, async (tx) => {
    const born = await tx.insertUserForBirth({ id: input.userId })
    return born.id
  })
}`
const BIRTH_ROW = `{
    id: context.userId, email: context.email, username: null, name: context.name, mobile: null,
    employee_no: null, department: context.department, position: null, hire_date: null,
    password_hash: context.passwordHash, must_change_password: true, role, permissions: '[]',
    is_active: true, is_admin: role === 'admin', activation_status: 'activated', local_password_set: true,
  }`
const GOOD_HELPER_COMMAND = `function displayRole(roleId) { return roleId === 'admin' ? 'admin' : (roleId || 'user') }
function birthRow(context) {
  const role = displayRole(context.roleId)
  return ${BIRTH_ROW}
}
${GOOD_COMMAND.replace(`return ${ROOT}(plan`, `const context = Object.freeze({ userId: input.userId, email: input.email, name: input.name, department: input.department, passwordHash: input.passwordHash, roleId: input.roleId, plan }); return ${ROOT}(plan`)
    .replace('tx.insertUserForBirth({ id: input.userId })', 'tx.insertUserForBirth(birthRow(context))')}`
const SNAPSHOT_CALLER = GOOD_CALLER.replace("const userId = 'synthetic'", `const userId = 'synthetic'
  const email = row.email
  const name = row.name
  const department = row.department
  const roleId = row.roleId`)
  .replace('email: row.email, name: row.name, department: row.department', 'email, name, department')
  .replace('roleId: row.roleId', 'roleId')
const REGISTRY_ENTRY = `entry({ id: 'B-05', file: \`\${SRC}/admin/${STEM}.ts\`, symbol: '${COMMAND}', intent: 'BIRTH', class: 'B', statements: [], actor: 'human', slice: 'AIS-2c' })`
const GOOD_REGISTRY = `const SRC = '${SRC}'; export const AUTHORIZATION_INPUT_WRITERS = Object.freeze([${REGISTRY_ENTRY}])`

describe('admin batch birth caller and root boundary', () => {
  it('records B-05 as the birth producer edge without inventing a second literal insert', () => {
    expect(AUTHORIZATION_INPUT_WRITERS.find(writer => writer.id === 'B-05')).toEqual({
      id: 'B-05', file: COMMAND_FILE, symbol: COMMAND, intent: 'BIRTH', class: 'B',
      statements: [], actor: 'human', status: 'pending', slice: 'AIS-2c',
    })
  })

  it('has one static data-only caller in production and no raw birth alternative', () => {
    const files = listFiles(REPO_ROOT, { roots: [SRC, 'plugins'], exclude: [`${SRC}/db/migrations`] })
      .filter(file => SOURCE_EXTENSIONS.has(path.extname(file)))
    expect(files).toContain(CALLER_FILE)
    expect(files).toContain(COMMAND_FILE)
    for (const file of files.filter(file => file !== COMMAND_FILE && !/(?:^|\/)(?:__tests__|tests|fixtures)(?:\/|$)|\.(?:test|spec)\./.test(file))) {
      expect(callerProblems(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')), file).toEqual([])
    }
    expect(commandProblems(fs.readFileSync(path.join(REPO_ROOT, COMMAND_FILE), 'utf8'))).toEqual([])
  })

  it('accepts the finite valid grammar and ignores a comment decoy', () => {
    expect(callerProblems(CALLER_FILE, GOOD_CALLER)).toEqual([])
    expect(callerProblems('neighbor.ts', `// require('${MODULE}'); ${COMMAND}()`)).toEqual([])
    expect(commandProblems(GOOD_COMMAND)).toEqual([])
  })

  it('accepts immutable scalar snapshots and the private closed row constructor', () => {
    expect(callerProblems(CALLER_FILE, SNAPSHOT_CALLER)).toEqual([])
    expect(callerProblems(CALLER_FILE, SNAPSHOT_CALLER.replace('const email = row.email', 'const capturedEmail = row.email; const email = capturedEmail'))).toEqual([])
    expect(commandProblems(GOOD_HELPER_COMMAND)).toEqual([])
    expect(commandProblems(GOOD_HELPER_COMMAND.replace(`${ROOT}(plan,`, `${ROOT}(context.plan,`))).toEqual([])
    expect(commandProblems(GOOD_HELPER_COMMAND.replace('roleId: input.roleId, plan', 'roleId: input.roleId, plan: plan').replace(`${ROOT}(plan,`, `${ROOT}(context.plan,`))).toEqual([])
  })

  it('allows only the exact B-05 metadata entry while scanning the rest of its file', () => {
    expect(callerProblems(REGISTRY_FILE, GOOD_REGISTRY)).toEqual([])
    expect(callerProblems(REGISTRY_FILE, GOOD_REGISTRY.replace("slice: 'AIS-2c'", "slice: 'AIS-2c', status: 'pending'"))).toEqual([])
    for (const source of [
      GOOD_REGISTRY + `; const decoy = '${COMMAND}'`,
      GOOD_REGISTRY + `; const file = '${MODULE}'; import(file)`,
      GOOD_REGISTRY + `; import { ${COMMAND} } from '${MODULE}'`,
      GOOD_REGISTRY.replace("id: 'B-05'", "id: 'B-06'"),
      GOOD_REGISTRY.replace("slice: 'AIS-2c'", "slice: 'AIS-2c', status: 'converted'"),
      GOOD_REGISTRY.replace('statements: []', 'statements: [], callback: run'),
      GOOD_REGISTRY.replace(REGISTRY_ENTRY, `${REGISTRY_ENTRY}, ${REGISTRY_ENTRY}`),
    ]) expect(callerProblems(REGISTRY_FILE, source).length, source).toBeGreaterThan(0)
    expect(callerProblems('neighbor.ts', GOOD_REGISTRY).length).toBeGreaterThan(0)
  })

  it.each([
    SNAPSHOT_CALLER.replace('const email = row.email', 'let email = row.email'),
    SNAPSHOT_CALLER.replace('const email = row.email', 'const email = row.name'),
    SNAPSHOT_CALLER.replace('const email = row.email', 'const email = readEmail(row)'),
    SNAPSHOT_CALLER.replace('const email = row.email', 'const email = (() => row.email)()'),
    SNAPSHOT_CALLER.replace(`await ${COMMAND}`, `{ const email = row.name; await ${COMMAND}`).replace('roleId })', 'roleId }) }'),
    SNAPSHOT_CALLER.replace('const email = row.email', 'const email = row.email; const email = row.name'),
  ])('rejects mutable, ambiguous or foreign scalar snapshots %#', source => {
    expect(callerProblems(CALLER_FILE, source).length).toBeGreaterThan(0)
  })

  it.each([
    GOOD_HELPER_COMMAND.replace('function birthRow', 'export function birthRow'),
    GOOD_HELPER_COMMAND.replace('function birthRow', 'async function birthRow'),
    GOOD_HELPER_COMMAND.replace('function birthRow(context)', 'function birthRow(context, runner)'),
    GOOD_HELPER_COMMAND.replace('const role = displayRole', 'context.after(); const role = displayRole'),
    GOOD_HELPER_COMMAND.replace(`return ${BIRTH_ROW}`, 'return context.row'),
    GOOD_HELPER_COMMAND.replace('id: context.userId, email:', 'unexpected: true, id: context.userId, email:'),
    GOOD_HELPER_COMMAND.replace('email: context.email', 'email: context.userId'),
    GOOD_HELPER_COMMAND.replace('email: context.email', 'email: readEmail(context)'),
    GOOD_HELPER_COMMAND.replace('id: context.userId, email:', '...context, id: context.userId, email:'),
    GOOD_HELPER_COMMAND.replace('email: context.email,', 'get email() { return context.email },'),
    GOOD_HELPER_COMMAND.replace("permissions: '[]'", "permissions: '[\"*\"]'"),
    GOOD_HELPER_COMMAND.replace("roleId === 'admin' ? 'admin' : (roleId || 'user')", "(record(roleId), roleId === 'admin' ? 'admin' : (roleId || 'user'))"),
    GOOD_HELPER_COMMAND.replace('birthRow(context))', 'birthRow(tx))'),
    GOOD_HELPER_COMMAND.replace('birthRow(context))', 'birthRow(input))'),
    GOOD_HELPER_COMMAND.replace('const born = await', 'const builder = birthRow; const born = await').replace('birthRow(context))', 'builder(context))'),
    GOOD_HELPER_COMMAND.replace('const role = displayRole', 'const derive = displayRole; const role = derive'),
    GOOD_HELPER_COMMAND.replace('Object.freeze({ userId: input.userId', 'makeContext({ userId: input.userId'),
  ])('rejects an impure, exposed or widened birth row helper %#', source => {
    expect(commandProblems(source).length).toBeGreaterThan(0)
  })

  it.each([
    GOOD_CALLER.replace(`{ ${COMMAND} }`, `{ ${COMMAND} as create }`).replace(`await ${COMMAND}`, 'await create'),
    GOOD_CALLER.replace(`{ ${COMMAND} }`, '* as birth').replace(`await ${COMMAND}`, `await birth.${COMMAND}`),
    GOOD_CALLER.replace(`await ${COMMAND}`, `const detached = ${COMMAND}; await detached`),
    GOOD_CALLER.replace('async function createOne', 'async function alternate'),
    GOOD_CALLER.replace(`await ${COMMAND}`, COMMAND),
    GOOD_CALLER.replace('actorId: adminUserId', 'actorId: row.userId'),
    GOOD_CALLER.replace('roleId: row.roleId', 'roleId: row.roleId, runner: callback'),
    GOOD_CALLER.replace('roleId: row.roleId })', 'roleId: row.roleId }, callback)'),
    GOOD_CALLER.replace('passwordHash, roleId', '...extra, passwordHash, roleId'),
    GOOD_CALLER.replace(`await ${COMMAND}`, `await transaction(async client => {}); await ${COMMAND}`),
    GOOD_CALLER.replace(`await ${COMMAND}`, `await query('INSERT INTO users (id) VALUES ($1)', [userId]); await ${COMMAND}`),
    GOOD_CALLER + `\nconst file = '../admin/admin-user-' + 'batch-birth-command'; const loader = require; loader(file)`,
    GOOD_CALLER + `\nconst file = '../admin/'; const part = 'admin-user-batch-'; import(file + part + 'birth-command')`,
    GOOD_CALLER + `\nconst method = 'createAdmin' + 'BatchUserCommand'; namespace[method]({})`,
    GOOD_CALLER + `\nexport { ${COMMAND} } from '${MODULE}'`,
  ])('rejects an alternate caller or module surface %#', source => {
    expect(callerProblems(CALLER_FILE, source).length).toBeGreaterThan(0)
  })

  it.each([
    GOOD_COMMAND.replace('(input)', '(input, runner)'),
    GOOD_COMMAND.replace('intent: \'BIRTH\'', 'intent: \'SET_ADMISSION\''),
    GOOD_COMMAND.replace('roleIds: []', 'roleIds: [], userIds: []'),
    GOOD_COMMAND.replace(`export async function ${COMMAND}`, 'async function alternate') + `\nexport async function ${COMMAND}(input) { return alternate(input) }`,
    GOOD_COMMAND.replace('  })', '  }, { transaction: runner })'),
    GOOD_COMMAND.replace('const born = await tx.insertUserForBirth({ id: input.userId })', 'const born = await insert(tx, input)') + '\nasync function insert(tx, input) { return await tx.insertUserForBirth({ id: input.userId }) }',
    GOOD_COMMAND.replace(`return ${ROOT}(plan, async (tx) => {`, `const runner = ${ROOT}; return runner(plan, async (tx) => {`),
    GOOD_COMMAND.replace('const born = await tx.insertUserForBirth', 'const insert = tx.insertUserForBirth; const born = await insert'),
    GOOD_COMMAND.replace('tx.insertUserForBirth', "tx['insertUserForBirth']"),
    GOOD_COMMAND.replace('const born = await', 'async function outside(tx) { return tx.insertUserForBirth({ id: input.userId }) }; const born = await'),
    GOOD_COMMAND.replace('const born = await', 'const alias = tx; const born = await'),
    GOOD_COMMAND.replace('const born = await', 'tx = other; const born = await'),
    GOOD_COMMAND.replace('const born = await', 'function shadow(tx) {}; const born = await'),
    GOOD_COMMAND.replace('const born = await', 'await run(async () => {}); const born = await'),
    GOOD_COMMAND.replace(`return ${ROOT}`, `await run(async () => {}); return ${ROOT}`),
    GOOD_COMMAND.replace('const born = await', "await tx.query('INSERT INTO users (id) VALUES ($1)', [input.userId]); const born = await"),
    GOOD_COMMAND.replace('const born = await', 'await tx.acquire({ userIds: [] }); const born = await'),
    GOOD_COMMAND.replace('const born = await', "await tx['acquire']({ userIds: [] }); const born = await"),
    GOOD_COMMAND.replace('const born = await', 'const rawQuery = tx.query; const born = await'),
    GOOD_COMMAND.replace('return born.id', 'return tx'),
    `import { transaction } from '../db/pg'\n${GOOD_COMMAND}`,
  ])('rejects a raw, moved, detached or widened birth root %#', source => {
    expect(commandProblems(source).length).toBeGreaterThan(0)
  })
})
