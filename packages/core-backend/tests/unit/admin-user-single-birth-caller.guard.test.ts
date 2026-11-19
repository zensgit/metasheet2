import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { enclosingFunctionAt, isTestPath, listFiles, literalSqlTexts, queryReceiverAt, scanSource, SOURCE_EXTENSIONS } from '../helpers/authorization-input-scan'
import { AUTHORIZATION_INPUT_WRITERS } from '../../src/rbac/authorization-input-writers'

const BASE = path.resolve(__dirname, '../../../..')
const SRC = 'packages/core-backend/src'
const COMMAND = 'createAdminUserBirthCommand'
const STEM = 'admin-user-birth-command'
const COMMAND_FILE = `${SRC}/admin/${STEM}.ts`
const ROUTE_FILE = `${SRC}/routes/admin-users.ts`
const W4_FILE = `${SRC}/attendance/w4c0-identity.ts`
const REGISTRY_FILE = `${SRC}/rbac/authorization-input-writers.ts`
const ROOT = 'withAuthorizationInputTransaction'
const TRY = 'tryAcquireAttendanceCalculationRolloutLockForBirthV1'
const INPUTS = {
  actorId: 'adminUserId', userId: 'userId', email: 'cleanEmail || null', username: 'cleanUsername', name: 'cleanName',
  mobile: 'cleanMobile', employeeNo: 'cleanEmployeeNo', department: 'cleanDepartment', position: 'cleanPosition', hireDate: 'cleanHireDate',
  passwordHash: 'passwordHash', mustChangePassword: 'mustChangePassword', role: 'effectiveRole', directPermissions: 'directPermissions',
  isActive: 'isActive', roleId: 'roleId', admissionNamespaces: 'parsedAdmissionNamespaces', attendanceOrgId: 'attendanceOrgId',
  attendanceGroupId: 'cleanAttendanceGroupId', attendanceGroupName: 'attendanceGroupName', defaultShiftId: 'cleanDefaultShiftId',
  defaultShiftName: 'defaultShiftName', defaultShiftStartDate: 'defaultShiftStartDate',
}
const ROW = { id: 'userId', email: 'email', username: 'username', name: 'name', mobile: 'mobile', employee_no: 'employeeNo',
  department: 'department', position: 'position', hire_date: 'hireDate', password_hash: 'passwordHash', must_change_password: 'mustChangePassword',
  role: 'role', permissions: 'permissionsJson', is_active: 'isActive', is_admin: 'isAdmin' }
const ERROR_IMPORTS = ['AdminUserBirthAdmissionError', 'AttendanceDefaultShiftNotFoundError', 'AttendanceShiftReferenceUnavailableError', COMMAND]
const parse = (file: string, source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
const read = (file: string) => fs.readFileSync(path.join(BASE, file), 'utf8')
function nodes(node: ts.Node): ts.Node[] { const result: ts.Node[] = []; const visit = (child: ts.Node) => { result.push(child); ts.forEachChild(child, visit) }; visit(node); return result }
function owner(node: ts.Node): ts.Node | undefined { let current: ts.Node | undefined = node.parent; while (current && !ts.isFunctionLike(current)) current = current.parent; return current }
function shape(value: ts.Node | string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, typeof value === 'string' ? value : value.getText())
  const result: string[] = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SemicolonToken) result.push(`${token}:${token === ts.SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText()}`)
  }
  return result.join('|')
}
function fields(node: ts.Node | undefined): Map<string, ts.Expression> | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined
  const result = new Map<string, ts.Expression>()
  for (const field of node.properties) {
    if ((!ts.isPropertyAssignment(field) && !ts.isShorthandPropertyAssignment(field)) || !ts.isIdentifier(field.name) || result.has(field.name.text)) return undefined
    result.set(field.name.text, ts.isPropertyAssignment(field) ? field.initializer : field.name)
  }
  return result
}
function exactFields(node: ts.Node | undefined, expected: Record<string, string>): boolean {
  const actual = fields(node)
  return !!actual && actual.size === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => actual.has(key) && shape(actual.get(key)!) === shape(value))
}
function calls(node: ts.Node, name: string): ts.CallExpression[] { return nodes(node).filter(ts.isCallExpression).filter(call => call.expression.getText() === name) }
function fn(tree: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined { const found = tree.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name); return found.length === 1 ? found[0] : undefined }
function awaited(call: ts.CallExpression): boolean { return ts.isAwaitExpression(call.parent) && call.parent.expression === call }
// Deliberately finite constant-string grammar for import/property spellings, not arbitrary JS evaluation.
const constantBindings = new WeakMap<ts.SourceFile, Map<string, ts.VariableDeclaration[]>>()
function stringOf(node: ts.Node, tree: ts.SourceFile, seen = new Set<ts.Node>()): string | undefined {
  if (seen.has(node)) return undefined
  seen.add(node)
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return stringOf(node.expression, tree, seen)
  if (ts.isIdentifier(node)) {
    if (!constantBindings.has(tree)) {
      const bindings = new Map<string, ts.VariableDeclaration[]>()
      for (const declaration of nodes(tree).filter(ts.isVariableDeclaration)) bindings.set(declaration.name.getText(), [...(bindings.get(declaration.name.getText()) ?? []), declaration])
      constantBindings.set(tree, bindings)
    }
    const found = constantBindings.get(tree)!.get(node.text) ?? []
    const declaration = found[0]
    return found.length === 1 && declaration.initializer && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 ? stringOf(declaration.initializer, tree, seen) : undefined
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringOf(node.left, tree, new Set(seen)), right = stringOf(node.right, tree, new Set(seen))
    return left === undefined || right === undefined ? undefined : left + right
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text
    for (const span of node.templateSpans) { const value = stringOf(span.expression, tree, new Set(seen)); if (value === undefined) return undefined; result += value + span.literal.text }
    return result
  }
  return undefined
}
function metadata(tree: ts.SourceFile): ts.Node[] {
  const allowed: ts.Node[] = []
  for (const id of ['B-04', 'W-07b']) {
    const entries = calls(tree, 'entry').filter(call => stringOf(fields(call.arguments[0])?.get('id') ?? call, tree) === id)
    const entry = entries[0], data = entry && fields(entry.arguments[0])
    const array = entry?.parent, freeze = array?.parent, declaration = freeze?.parent
    if (entries.length !== 1 || !data || entry.arguments.length !== 1 || !array || !ts.isArrayLiteralExpression(array)
      || !freeze || !ts.isCallExpression(freeze) || freeze.expression.getText() !== 'Object.freeze' || freeze.arguments.length !== 1
      || !declaration || !ts.isVariableDeclaration(declaration) || declaration.name.getText() !== 'AUTHORIZATION_INPUT_WRITERS') continue
    const expected = { id, file: COMMAND_FILE, symbol: id === 'B-04' ? COMMAND : `callback:${ROOT}`, intent: 'BIRTH', class: 'B', actor: 'human', slice: 'AIS-2c' }
    if (!data.has('statements') || data.size !== Object.keys(expected).length + 1 + Number(data.has('status'))
      || Object.entries(expected).some(([key, value]) => !data.has(key) || stringOf(data.get(key)!, tree) !== value)
      || (data.has('status') && stringOf(data.get('status')!, tree) !== 'pending')
      || shape(data.get('statements')!) !== shape(id === 'B-04' ? '[]' : "[st('user_permissions', 'INSERT')]")) continue
    allowed.push(data.get('file')!, data.get('symbol')!)
  }
  return allowed
}
function references(file: string, source: string): string[] {
  const tree = parse(file, source), all = nodes(tree), errors: string[] = []
  const allowed = new Set<ts.Node>(file === REGISTRY_FILE ? metadata(tree) : [])
  for (const node of all) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings
      if (node.moduleSpecifier.text.includes(STEM)) {
        if (file !== ROUTE_FILE || node.moduleSpecifier.text !== `../admin/${STEM}` || node.importClause?.name || node.importClause?.isTypeOnly
          || !bindings || !ts.isNamedImports(bindings) || bindings.elements.some(binding => binding.propertyName || binding.isTypeOnly)
          || JSON.stringify(bindings.elements.map(binding => binding.name.text).sort()) !== JSON.stringify([...ERROR_IMPORTS].sort())) errors.push('command import')
        else { allowed.add(node.moduleSpecifier); bindings.elements.forEach(binding => allowed.add(binding.name)) }
      }
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements.filter(item => item.name.text === TRY || item.propertyName?.text === TRY)) {
        if (file !== COMMAND_FILE || node.moduleSpecifier.text !== '../attendance/w4c0-identity' || binding.propertyName || binding.isTypeOnly || node.importClause?.isTypeOnly) errors.push('try import')
        else allowed.add(binding.name)
      }
    }
    if (ts.isFunctionDeclaration(node) && ((file === COMMAND_FILE && node.name?.text === COMMAND) || (file === W4_FILE && node.name?.text === TRY))) allowed.add(node.name!)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && [COMMAND, TRY].includes(node.expression.text)) {
      const enclosing = owner(node)
      if (node.expression.text === COMMAND) {
        const route = enclosing?.parent
        if (file !== ROUTE_FILE || !enclosing || !ts.isArrowFunction(enclosing) || !route || !ts.isCallExpression(route)
          || shape(route.expression) !== shape('r.post') || route.arguments.length !== 3 || stringOf(route.arguments[0], tree) !== '/api/admin/users'
          || route.arguments[1].getText() !== 'authenticate' || route.arguments[2] !== enclosing || !awaited(node)
          || node.arguments.length !== 1 || !exactFields(node.arguments[0], INPUTS)) errors.push('data-only POST create')
        else {
          const body = enclosing.getText(), scan = scanSource(file, body)
          if (scan.writes.length || scan.dynamic.length || literalSqlTexts(file, body).some(sql => /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(sql))) errors.push('raw route DML')
          const pureFilter = "typeof code === 'string' && code.trim().length > 0"
          if (nodes(enclosing).some(child => child !== enclosing && ts.isFunctionLike(child)
            && !(ts.isArrowFunction(child) && child.parameters.length === 1 && child.parameters[0].name.getText() === 'code' && shape(child.body) === shape(pureFilter)
              && ts.isCallExpression(child.parent) && child.parent.expression.getText() === 'storedCodes.filter' && child.parent.arguments.length === 1))) errors.push('route callback')
          if (nodes(enclosing).some(child => ts.isIdentifier(child) && ['transaction', ROOT, 'connect', 'getInternalPool'].includes(child.text))) errors.push('route runner')
        }
      } else if (file !== COMMAND_FILE || enclosing !== fn(tree, 'admitShift') || !awaited(node)
        || node.arguments.length !== 2 || node.arguments[0].getText() !== 'tx' || node.arguments[1].getText() !== 'rolloutOrg') errors.push('closed try caller')
      allowed.add(node.expression)
    }
  }
  for (const node of all) {
    if (ts.isIdentifier(node) && [COMMAND, TRY].includes(node.text) && !allowed.has(node)) errors.push('detached reference')
    if (ts.isStringLiteralLike(node) || ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) {
      const value = stringOf(node, tree)
      if (value && (value.includes(STEM) || value === COMMAND || value === TRY) && !allowed.has(node)) errors.push('loader or computed reference')
    }
  }
  if (file === ROUTE_FILE && (calls(tree, COMMAND).length !== 1 || all.filter(ts.isImportDeclaration).filter(node => stringOf(node.moduleSpecifier, tree)?.includes(STEM)).length !== 1)) errors.push('one command caller')
  if (file === COMMAND_FILE && (calls(tree, TRY).length !== 1 || all.filter(ts.isImportSpecifier).filter(node => node.name.text === TRY).length !== 1)) errors.push('one try caller')
  return [...new Set(errors)]
}

const TOKEN_TERMS = ["tx.open !== true", 'tx.plan !== plan', "tx.world !== 'shared'", "plan.intent !== 'BIRTH'",
  ...['context', 'context.directPermissions', 'context.admissionNamespaces', 'context.roleIds', 'context.actorIds', 'plan', 'plan.roleIds'].map(value => `!Object.isFrozen(${value})`),
  'plan.witness === undefined', ...['plan.witness', 'plan.witness.userIds', 'plan.witness.admissionUserIds'].map(value => `!Object.isFrozen(${value})`),
  '!exactKeys(plan, PLAN_KEYS)', '!exactKeys(plan.witness, WITNESS_KEYS)', '!sameIds(plan.roleIds, context.roleIds)',
  '!sameIds(plan.witness.userIds, context.actorIds)', '!sameIds(plan.witness.admissionUserIds, context.actorIds)', "'userIds' in plan", "'admissionUserIds' in plan"]
const WITNESS_TERMS = ['context.userId === context.actorId', 'tx.locked.has(context.userId)', 'tx.witnessed.userIds.has(context.userId)',
  'tx.witnessed.admissionUserIds.has(context.userId)', 'tx.born.has(context.actorId)', '!sameMembers(tx.locked.keys(), context.actorIds)',
  '!sameMembers(tx.witnessed.userIds, context.actorIds)', '!sameMembers(tx.witnessed.admissionUserIds, context.actorIds)', '!sameMembers(tx.born, born)']
function commandProblems(source: string): string[] {
  const tree = parse(COMMAND_FILE, source), all = nodes(tree), errors = references(COMMAND_FILE, source)
  const entry = fn(tree, COMMAND), roots = calls(tree, ROOT), root = roots[0], work = root?.arguments[1]
  if (!entry?.body || entry.parameters.length !== 1 || shape(entry.parameters[0]) !== shape('input: AdminUserBirthInput')
    || entry.body.statements.length !== 2 || shape(entry.body.statements[0]) !== shape('const context = freezeBirth(input)')
    || !entry.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) errors.push('closed command entry')
  if (roots.length !== 1 || !root || owner(root) !== entry || !ts.isReturnStatement(root.parent) || root.arguments.length !== 2
    || root.arguments[0].getText() !== 'context.plan' || !work || !ts.isArrowFunction(work) || work.parameters.length !== 1
    || work.parameters[0].getText() !== 'tx' || !work.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) errors.push('single default root')
  if (all.filter(ts.isImportSpecifier).filter(node => node.name.text === ROOT).length !== 1) errors.push('one root import')
  const freeze = fn(tree, 'freezeBirth')
  const plan = freeze && nodes(freeze).filter(ts.isVariableDeclaration).find(node => node.name.getText() === 'plan')?.initializer
  const witness = freeze && nodes(freeze).filter(ts.isVariableDeclaration).find(node => node.name.getText() === 'witness')?.initializer
  if (!plan || shape(plan) !== shape("Object.freeze({ intent: 'BIRTH', roleIds, witness })")
    || !witness || shape(witness) !== shape('Object.freeze({ userIds: actorIds, admissionUserIds: actorIds })')) errors.push('actor-only BIRTH plan')
  for (const [name, expected] of Object.entries({ actorIds: 'Object.freeze([actorId])', roleIds: 'Object.freeze(roleId ? [roleId] : [])',
    directPermissions: "stringList(input.directPermissions, 'birth_input')", admissionNamespaces: "stringList(input.admissionNamespaces, 'birth_input')" })) {
    const value = freeze && nodes(freeze).filter(ts.isVariableDeclaration).find(node => node.name.getText() === name)?.initializer
    if (!value || shape(value) !== shape(expected)) errors.push('owned data and actor lists')
  }
  const input = tree.statements.filter(ts.isTypeAliasDeclaration).find(node => node.name.text === 'AdminUserBirthInput')?.type
  if (!input || !ts.isTypeLiteralNode(input) || JSON.stringify(input.members.map(member => member.name?.getText()).sort()) !== JSON.stringify(Object.keys(INPUTS).sort())) errors.push('closed data interface')
  const token = fn(tree, 'assertToken')?.body?.statements, witnessBody = fn(tree, 'assertWitness')?.body?.statements
  if (!token || token.length !== 3 || shape(token[0]) !== shape('assertAuthorizationInputTx(tx, { client: tx, userId: context.userId })')
    || shape(token[1]) !== shape('const plan = context.plan') || !ts.isIfStatement(token[2]) || shape(token[2].expression) !== shape(TOKEN_TERMS.join(' || '))
    || shape(token[2].thenStatement) !== shape("invalid('birth_context')") || token[2].elseStatement) errors.push('actual token checks')
  if (!witnessBody || witnessBody.length !== 2 || !ts.isIfStatement(witnessBody[0]) || shape(witnessBody[0].expression) !== shape(WITNESS_TERMS.join(' || '))
    || shape(witnessBody[0].thenStatement) !== shape("invalid('birth_actor_witness')") || witnessBody[0].elseStatement
    || shape(fn(tree, 'recheck')?.body ?? '') !== shape('{ assertToken(tx, context); assertWitness(tx, context, born) }')) errors.push('actual born witnesses')
  const inserts = calls(tree, 'tx.insertUserForBirth'), insert = inserts[0]
  if (inserts.length !== 1 || !insert || owner(insert) !== work || !awaited(insert) || insert.arguments.length !== 1
    || !exactFields(insert.arguments[0], { ...Object.fromEntries(Object.entries(ROW).map(([key, value]) => [key, `context.${value}`])), activation_status: "'activated'", local_password_set: 'true' })) errors.push('one owned birth insert')
  if (work && ts.isArrowFunction(work) && insert) {
    const sequence = ['assertToken', 'assertActor', 'assertAdmissions', 'freshRoleCodes', 'recheck', 'tryOrgLock', 'admitShift', 'recheck',
      'tx.insertUserForBirth', 'recheck', 'claimNonEmptyLoginAliasesOrThrow', 'recheck', 'assignUserRoles', 'recheck', 'grantNamespaceAdmissions',
      'recheck', 'writeUserNamespaceAdmission', 'recheck', 'tx.query', 'tx.query', 'tx.query', 'tx.query', 'recheck']
    const actual = nodes(work).filter(ts.isCallExpression).filter(call => owner(call) === work && sequence.includes(call.expression.getText())).map(call => call.expression.getText())
    if (JSON.stringify(actual) !== JSON.stringify(sequence)) errors.push('root lifecycle order')
    const checks = calls(work, 'recheck')
    if (checks.length !== 8 || checks.some(call => owner(call) !== work || shape(call) !== shape(`recheck(tx, context, ${call.pos < insert.pos ? '[]' : '[context.userId]'})`))
      || checks.filter(call => call.pos < insert.pos).length !== 2
      || !nodes(work).some(node => ts.isIfStatement(node) && shape(node) === shape("if (born.id !== context.userId) invalid('birth_returned_id')"))) errors.push('born lifecycle')
    for (const node of nodes(work)) {
      if (node !== work && ts.isFunctionLike(node) && !(ts.isArrowFunction(node) && shape(node) === shape('(_, index) => `($1, $${index + 2})`')
        && ts.isCallExpression(node.parent) && node.parent.expression.getText() === 'context.directPermissions.map' && node.parent.arguments.length === 1)) errors.push('hidden command callback')
      if ((ts.isParameter(node) && node !== work.parameters[0] || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) && node.name.getText() === 'tx') errors.push('token shadow')
    }
  }
  for (const node of all) {
    if (ts.isIdentifier(node) && [ROOT, 'insertUserForBirth'].includes(node.text)) {
      const declaration = ts.isImportSpecifier(node.parent) ? node.parent.parent.parent.parent : undefined
      const imported = node.text === ROOT && ts.isImportSpecifier(node.parent) && !node.parent.propertyName && node.parent.name === node
        && declaration && ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text === '../rbac/authorization-input-lock'
      const access = node.text === ROOT ? node : node.parent
      if (!imported && (!ts.isCallExpression(access.parent) || access.parent.expression !== access || (node.text !== ROOT && access.getText() !== 'tx.insertUserForBirth'))) errors.push('detached root or insert')
    }
    if (ts.isElementAccessExpression(node) && ['insertUserForBirth', 'query', 'acquire'].includes(stringOf(node.argumentExpression, tree) ?? '')) errors.push('computed token method')
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'query' && (node.expression.getText() !== 'tx' || !ts.isCallExpression(node.parent) || node.parent.expression !== node)) errors.push('raw or detached query')
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'acquire') errors.push('late acquire')
    if (ts.isVariableDeclaration(node) && node.initializer?.getText() === 'tx' || ts.isReturnStatement(node) && node.expression?.getText() === 'tx'
      || ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && (node.left.getText() === 'tx' || node.right.getText() === 'tx')) errors.push('token alias')
    if (ts.isImportDeclaration(node) && /\/(?:db\/pg|integration\/db\/connection-pool)$/.test(stringOf(node.moduleSpecifier, tree) ?? '')) errors.push('raw runner import')
    if (ts.isIdentifier(node) && ['transaction', 'enterAuthorizationInputTransaction', 'poolManager', '__rawClient'].includes(node.text)) errors.push('alternate runner')
    if ((ts.isStringLiteralLike(node) || ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) && stringOf(node, tree) === ROOT) errors.push('computed root')
  }
  const scan = scanSource(COMMAND_FILE, source)
  if (scan.dynamic.length || scan.writes.length !== 1 || scan.writes[0].table !== 'user_permissions' || scan.writes[0].verb !== 'INSERT'
    || queryReceiverAt(COMMAND_FILE, source, scan.writes[0].position) !== 'tx'
    || enclosingFunctionAt(COMMAND_FILE, source, scan.writes[0].position)?.name !== `callback:${ROOT}`) errors.push('W-07b ownership')
  return [...new Set(errors)]
}

const TRY_BODY = `{
  assertAuthorizationInputTx(tx, { client: tx })
  if (tx.plan?.intent !== 'BIRTH' || tx.world !== 'shared' || tx.open !== true) { fail('W4C0_BIRTH_ROLLOUT_TRY_CONTEXT_INVALID') }
  if (currentSettlementCoordinationContextV1()) fail('W4C0_BIRTH_ROLLOUT_TRY_COORDINATED')
  const key = buildAttendanceCalculationRolloutAdvisoryKey(org)
  const result = await tx.query('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS acquired', [key.toString()],)
  if (result.rows.length !== 1) fail('W4C0_BIRTH_ROLLOUT_TRY_RESULT_INVALID')
  const acquired = result.rows[0]?.acquired
  if (acquired !== true && acquired !== false) fail('W4C0_BIRTH_ROLLOUT_TRY_RESULT_INVALID')
  if (acquired !== true) throw busyError('rollout')
}`
function tryProblems(source: string): string[] {
  const tree = parse(W4_FILE, source), helper = fn(tree, TRY), errors = references(W4_FILE, source)
  if (!helper?.body || helper.parameters.length !== 2 || shape(helper.parameters[0]) !== shape('tx: AuthorizationInputTx')
    || shape(helper.parameters[1]) !== shape('org: CanonicalAttendanceRolloutOrgKeyV1') || shape(helper.body) !== shape(TRY_BODY)
    || !helper.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) errors.push('closed nonblocking try helper')
  for (const [name, module, typeOnly] of [['assertAuthorizationInputTx', '../rbac/authorization-input-brand', false], ['AuthorizationInputTx', '../rbac/authorization-input-lock', true]] as const) {
    const bindings = nodes(tree).filter(ts.isImportSpecifier).filter(node => node.name.text === name)
    const binding = bindings[0], declaration = binding?.parent.parent.parent
    if (bindings.length !== 1 || binding.propertyName || !declaration || !ts.isImportDeclaration(declaration)
      || stringOf(declaration.moduleSpecifier, tree) !== module || declaration.importClause?.isTypeOnly !== typeOnly) errors.push('canonical helper token dependency')
  }
  return errors
}

const ROUTE = read(ROUTE_FILE), PRODUCT = read(COMMAND_FILE), W4 = read(W4_FILE)
function changed(source: string, before: string, after: string): string { expect(source).toContain(before); return source.replace(before, after) }
describe('single user BIRTH producer and rollout try ownership', () => {
  it('records producer B-04 and direct-permission W-07b without a duplicate users INSERT', () => {
    for (const [id, symbol, statements] of [['B-04', COMMAND, []], ['W-07b', `callback:${ROOT}`, [{ table: 'user_permissions', verb: 'INSERT', count: 1 }]]] as const) {
      expect(AUTHORIZATION_INPUT_WRITERS.find(writer => writer.id === id)).toEqual({ id, file: COMMAND_FILE, symbol, intent: 'BIRTH', class: 'B', statements, actor: 'human', status: 'pending', slice: 'AIS-2c' })
    }
  })
  it('has exactly the static POST caller, default birth root and closed try helper', () => {
    for (const file of listFiles(BASE, { roots: [SRC, 'plugins'], exclude: [`${SRC}/db/migrations`] }).filter(file => SOURCE_EXTENSIONS.has(path.extname(file)) && !isTestPath(file))) {
      expect(references(file, read(file)), file).toEqual([])
    }
    expect(commandProblems(PRODUCT)).toEqual([])
    expect(tryProblems(W4)).toEqual([])
  })
  it('rejects aliases, property/element references, reexports and constant loader spellings', () => {
    for (const decoy of [
      `export { ${COMMAND} } from '../admin/${STEM}'`, `import { ${COMMAND} as alias } from '../admin/${STEM}'`,
      `const alias = ${COMMAND}`, `namespace.${COMMAND}({})`, `namespace['${COMMAND}']({})`,
      `const part = 'admin-user-'; const file = '../admin/' + part + 'birth-command'; const loader = require; loader(file)`,
      `const name = 'tryAcquireAttendanceCalculation' + 'RolloutLockForBirthV1'; namespace[name](tx, org)`,
      `import * as w4 from '../attendance/w4c0-identity'; const name = 'tryAcquireAttendanceCalculation' + ('RolloutLockForBirthV1'); w4[name](tx, org)`,
      `const file = '../admin/' + ('admin-user-' + ('birth-command')); const loader = require; loader(file)`,
      `const part = ('tryAcquireAttendanceCalculation' as const); const name = part + (('RolloutLockForBirthV1' satisfies string)!); namespace[name](tx, org)`,
      `const part = <string>'admin-user-'; const file = '../admin/' + part + ('birth-command'); import(file)`,
      `import { ${TRY} } from '../attendance/w4c0-identity'`,
    ]) expect(references('neighbor.ts', decoy).length, decoy).toBeGreaterThan(0)
    expect(references('neighbor.ts', `// import('${STEM}'); ${TRY}()`)).toEqual([])
  })
  it('permits only exact producer metadata while still scanning the rest of the registry', () => {
    const registry = read(REGISTRY_FILE)
    expect(references(REGISTRY_FILE, registry)).toEqual([])
    expect(references(REGISTRY_FILE, registry + `\nconst module = '../admin/${STEM}'; import(module)`)).not.toEqual([])
    expect(references(REGISTRY_FILE, changed(registry, "id: 'B-04'", "id: 'OTHER'"))).not.toEqual([])
    expect(references(REGISTRY_FILE, registry + `\nconst detached = '${COMMAND}'`)).not.toEqual([])
  })
  it('rejects altered route provenance, data, callback and raw transaction surfaces', () => {
    for (const [before, after] of [
      ["r.post('/api/admin/users',", "r.post('/api/admin/other',"], ['actorId: adminUserId,\n        userId,\n        email: cleanEmail || null,', 'actorId: req.user.id,\n        userId,\n        email: cleanEmail || null,'],
      ['const attendanceOnboarding = await createAdminUserBirthCommand({', 'await transaction(async client => {}); const attendanceOnboarding = await createAdminUserBirthCommand({'],
      ['defaultShiftStartDate,\n      })', 'defaultShiftStartDate, runner: callback,\n      })'],
      ['const attendanceOnboarding = await createAdminUserBirthCommand({', "await query('INSERT INTO users (id) VALUES ($1)', [userId]); const attendanceOnboarding = await createAdminUserBirthCommand({"],
    ]) expect(references(ROUTE_FILE, changed(ROUTE, before, after)).length).toBeGreaterThan(0)
  })
  it('rejects moved roots/inserts, weakened witnesses, raw clients and hidden callbacks', () => {
    for (const [before, after] of [
      ['return withAuthorizationInputTransaction(context.plan, async (tx) => {', 'const runner = withAuthorizationInputTransaction; return runner(context.plan, async (tx) => {'],
      ['return onboarding\n  })', 'return onboarding\n  }, { transaction: runner })'],
      ['const born = await tx.insertUserForBirth({', 'const born = await ((tx) => tx.insertUserForBirth) (tx)({'],
      ['const born = await tx.insertUserForBirth({', 'const insert = tx.insertUserForBirth; const born = await insert({'],
      ['const born = await tx.insertUserForBirth({', 'await run(async () => {}); const born = await tx.insertUserForBirth({'],
      ['const born = await tx.insertUserForBirth({', 'const alias = tx; const born = await tx.insertUserForBirth({'],
      ['const born = await tx.insertUserForBirth({', 'function shadow(tx) {}; const born = await tx.insertUserForBirth({'],
      ['const born = await tx.insertUserForBirth({', "await tx.query('INSERT INTO users (id) VALUES ($1)', [context.userId]); const born = await tx.insertUserForBirth({"],
      ['|| !sameMembers(tx.born, born)', ''], ['|| !sameMembers(tx.witnessed.userIds, context.actorIds)', ''], ['tx.plan !== plan', "tx.plan.intent !== plan.intent"],
      [") invalid('birth_actor_witness')", ') {}'], ['Object.freeze([actorId])', 'Object.freeze([userId])'],
      ["if (born.id !== context.userId) invalid('birth_returned_id')", ''], ['recheck(tx, context, [context.userId])', 'recheck(tx, context, [])'],
      ['intent: \'BIRTH\', roleIds, witness', "intent: 'BIRTH', roleIds, witness, userIds: [userId]"],
      [`${TRY}(tx, rolloutOrg)`, `${TRY}(raw, rolloutOrg)`], [`${TRY}(tx, rolloutOrg)`, `${TRY}(tx, rolloutOrg, 'shared')`],
      ['await tx.query(\n        `INSERT INTO user_permissions', 'await raw.query(\n        `INSERT INTO user_permissions'],
    ]) expect(commandProblems(changed(PRODUCT, before, after)).length, before).toBeGreaterThan(0)
  })
  it('rejects widening or weakening the new helper without pinning unrelated W4 helpers', () => {
    for (const [before, after] of [
      ['pg_try_advisory_xact_lock_shared($1::bigint) AS acquired', 'pg_advisory_xact_lock_shared($1::bigint) AS acquired'],
      ["if (currentSettlementCoordinationContextV1()) fail('W4C0_BIRTH_ROLLOUT_TRY_COORDINATED')", ''],
      ['assertAuthorizationInputTx(tx, { client: tx })', 'assertAuthorizationInputTx(tx)'],
      [`export async function ${TRY}(\n  tx: AuthorizationInputTx,\n  org: CanonicalAttendanceRolloutOrgKeyV1,`, `export async function ${TRY}(\n  tx: AuthorizationInputTx,\n  org: CanonicalAttendanceRolloutOrgKeyV1,\n  mode: string,`],
      ["tx.plan?.intent !== 'BIRTH'", "tx.plan?.intent !== 'SET_ADMISSION'"],
      ["if (acquired !== true) throw busyError('rollout')", ''],
      ["if (result.rows.length !== 1) fail('W4C0_BIRTH_ROLLOUT_TRY_RESULT_INVALID')", ''],
    ]) expect(tryProblems(changed(W4, before, after)).length, before).toBeGreaterThan(0)
  })
})
