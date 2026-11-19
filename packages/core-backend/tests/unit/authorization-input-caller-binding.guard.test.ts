/**
 * Caller-binding bridge for the raw authorization writers. The pinned multiset is direct
 * identifier calls only. A comment, a string, a renamed import, a property or element
 * access, or a detached value does not count as one of those calls. Each kept call's
 * executor is the last explicit parameter binding. A later spread, computed name, or
 * overwrite does not count. A conflict rejection is a direct throw of
 * DirectoryConflictError. The host returns both the transaction promise and
 * applyRoleMatrix. Handover awaits lockPair as a direct statement of the callback.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { hasPendingConsumers } from '../../src/rbac/authorization-input-consumers'
import { enclosingFunctionAt, listFiles, SOURCE_EXTENSIONS } from '../helpers/authorization-input-scan'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SRC = 'packages/core-backend/src'
const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')

const HELPERS = [
  'assignUserRoles',
  'unassignUserRoles',
  'grantNamespaceAdmissions',
  'disableNamespaceAdmissionsWithoutRoles',
  'syncLegacyAdminProfile',
] as const
type HelperName = (typeof HELPERS)[number]
const HELPER_SET = new Set<string>(HELPERS)

const ROLE_FILE = `${SRC}/rbac/role-assignment.ts`
const ADMISSION_FILE = `${SRC}/rbac/namespace-admission.ts`
const LEGACY_FILE = `${SRC}/admin/legacy-admin-profile.ts`
const CONSUMER_FILE = `${SRC}/rbac/authorization-input-consumers.ts`
const INDEX_FILE = `${SRC}/index.ts`
const DIRECTORY_FILE = `${SRC}/directory/directory-sync.ts`
const HANDOVER_FILE = `${SRC}/directory/controlled-handover.ts`

const BIRTH = `${SRC}/admin/admin-user-birth-command.ts`
const BATCH_BIRTH = `${SRC}/admin/admin-user-batch-birth-command.ts`
const ATTENDANCE = `${SRC}/admin/attendance-role-commands.ts`
const PLATFORM_ASSIGN = `${SRC}/admin/platform-role-assign-command.ts`
const PLATFORM_UNASSIGN = `${SRC}/admin/platform-role-unassign-command.ts`
const RECYCLE = `${SRC}/admin/user-recycle.ts`
const AUTH = `${SRC}/auth/AuthService.ts`
const ADMIN_USERS = `${SRC}/routes/admin-users.ts`
const OPERATION = `${SRC}/admin/authorization-operation-service.ts`
const ADMIN_BATCH = `${SRC}/routes/admin-user-batch.ts`
const ROLES = `${SRC}/routes/roles.ts`

const TX_CALLBACK = 'callback:withAuthorizationInputTransaction'
const POOL_CALLBACK = 'callback:transaction'

/** `file|owner|callee|executor`. Legacy executor is `param.query|true` or `param.query|false`. */
const CALLER_BINDINGS: readonly string[] = [
  `${OPERATION}|${TX_CALLBACK}|assignUserRoles|tx`,
  `${OPERATION}|${TX_CALLBACK}|unassignUserRoles|tx`,
  `${OPERATION}|${TX_CALLBACK}|disableNamespaceAdmissionsWithoutRoles|tx.query`,
  `${OPERATION}|${TX_CALLBACK}|syncLegacyAdminProfile|tx.query|role.assign`,
  `${BATCH_BIRTH}|${TX_CALLBACK}|assignUserRoles|tx`,
  `${BIRTH}|${TX_CALLBACK}|assignUserRoles|tx`,
  `${ATTENDANCE}|${TX_CALLBACK}|assignUserRoles|tx`,
  `${PLATFORM_ASSIGN}|${TX_CALLBACK}|assignUserRoles|tx`,
  `${AUTH}|insertUserRolesOnce|assignUserRoles|client`,
  `${DIRECTORY_FILE}|applyDirectoryProjectedMemberGroupGovernanceInTransaction|assignUserRoles|client`,
  `${ADMIN_BATCH}|${POOL_CALLBACK}|assignUserRoles|client`,
  `${ADMIN_USERS}|${POOL_CALLBACK}|assignUserRoles|client`,
  `${ATTENDANCE}|${TX_CALLBACK}|unassignUserRoles|tx`,
  `${PLATFORM_UNASSIGN}|${TX_CALLBACK}|unassignUserRoles|tx`,
  `${RECYCLE}|applyRecyclePurge|unassignUserRoles|client`,
  `${ADMIN_BATCH}|${POOL_CALLBACK}|unassignUserRoles|client`,
  `${ADMIN_USERS}|${POOL_CALLBACK}|unassignUserRoles|client`,
  `${ROLES}|${POOL_CALLBACK}|unassignUserRoles|client`,
  `${ATTENDANCE}|${TX_CALLBACK}|disableNamespaceAdmissionsWithoutRoles|tx.query`,
  `${PLATFORM_UNASSIGN}|${TX_CALLBACK}|disableNamespaceAdmissionsWithoutRoles|tx.query`,
  `${RECYCLE}|applyRecyclePurge|disableNamespaceAdmissionsWithoutRoles|client.query`,
  `${ADMIN_BATCH}|${POOL_CALLBACK}|disableNamespaceAdmissionsWithoutRoles|client.query`,
  `${ADMIN_USERS}|${POOL_CALLBACK}|disableNamespaceAdmissionsWithoutRoles|client.query`,
  `${BIRTH}|${TX_CALLBACK}|grantNamespaceAdmissions|tx`,
  `${PLATFORM_ASSIGN}|${TX_CALLBACK}|syncLegacyAdminProfile|tx.query|true`,
  `${PLATFORM_UNASSIGN}|${TX_CALLBACK}|syncLegacyAdminProfile|tx.query|false`,
  `${ADMIN_USERS}|${POOL_CALLBACK}|syncLegacyAdminProfile|client.query|true`,
  `${ADMIN_USERS}|${POOL_CALLBACK}|syncLegacyAdminProfile|client.query|false`,
]

const K04_REASON = 'unmounted prepared receiver may only refuse; success neither authorizes nor enables a purpose'
const K05_REASON = 'Prepares the actor privilege witness on the same locked receiving transaction; does not authorize a proof or grant'

type SourceMap = ReadonlyMap<string, string>

function parse(file: string, source: string): ts.SourceFile {
  const kind = /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
}

function productionSources(edit?: (file: string, source: string) => string): Map<string, string> {
  const files = listFiles(REPO_ROOT, { roots: [SRC], exclude: [] }).filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
  const sources = new Map<string, string>()
  for (const file of files) {
    const source = read(file)
    sources.set(file, edit ? edit(file, source) : source)
  }
  return sources
}

function once(source: string, from: string, to: string): string {
  const parts = source.split(from)
  if (parts.length !== 2) throw new Error(`expected one occurrence, found ${parts.length - 1}`)
  return parts.join(to)
}

function edit(file: string, from: string, to: string): (candidate: string, source: string) => string {
  return (candidate, source) => (candidate === file ? once(source, from, to) : source)
}

function walkAll(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node) => {
    visit(node)
    ts.forEachChild(node, walk)
  }
  walk(root)
}

function visitOwn(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node) => {
    if (node !== root && ts.isFunctionLike(node)) return
    visit(node)
    ts.forEachChild(node, walk)
  }
  walk(root)
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  const names: string[] = []
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) names.push(...bindingNames(element.name))
  }
  return names
}

function parameterNames(fn: ts.SignatureDeclaration): Set<string> {
  return new Set(fn.parameters.flatMap((parameter) => bindingNames(parameter.name)))
}

function innermostFunction(node: ts.Node): ts.SignatureDeclaration | null {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isFunctionLike(current)) return current
    current = current.parent
  }
  return null
}

function inTypeOrDoc(node: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isTypeNode(current)) return true
    if (current.kind >= ts.SyntaxKind.FirstJSDocNode && current.kind <= ts.SyntaxKind.LastJSDocNode) return true
    current = current.parent
  }
  return false
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function ownCalls(root: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  visitOwn(root, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found.push(node)
  })
  return found
}

function namedFunction(tree: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | null {
  const found: ts.FunctionLikeDeclaration[] = []
  walkAll(tree, (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === name && node.body) {
      found.push(node)
    }
  })
  return found.length === 1 ? found[0] : null
}

function isParameterName(fn: ts.SignatureDeclaration, name: string): boolean {
  return parameterNames(fn).has(name)
}

function booleanText(node: ts.Expression): 'true' | 'false' | null {
  if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true'
  if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false'
  return null
}

function sqlText(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text
  if (ts.isTemplateExpression(expression)) {
    return expression.head.text + expression.templateSpans.map((span) => span.literal.text).join('')
  }
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) return sqlText(expression.expression)
  return null
}

function isNegated(node: ts.Node): boolean {
  let current = node
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent
  return ts.isPrefixUnaryExpression(current.parent) && current.parent.operator === ts.SyntaxKind.ExclamationToken
}

function hasReceiver(call: ts.CallExpression, receiver: string): boolean {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'has') return false
  const object = call.expression.expression
  if (receiver === 'lockedUsers') return ts.isIdentifier(object) && object.text === 'lockedUsers'
  if (receiver === 'syncAccess.lockedUserIds') {
    return ts.isPropertyAccessExpression(object)
      && object.name.text === 'lockedUserIds'
      && ts.isIdentifier(object.expression)
      && object.expression.text === 'syncAccess'
  }
  return false
}

function isDirectoryConflictConstruction(expression: ts.Expression): boolean {
  let current = expression
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return ts.isNewExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'DirectoryConflictError'
}

function throwsDirectoryConflict(node: ts.Node): boolean {
  const statements = ts.isBlock(node) ? node.statements : ts.isThrowStatement(node) ? [node] : []
  return statements.some((statement) => ts.isThrowStatement(statement) && !!statement.expression && isDirectoryConflictConstruction(statement.expression))
}

function rejectionIf(root: ts.Node, receiver: string): ts.IfStatement | null {
  const found: ts.IfStatement[] = []
  visitOwn(root, (node) => {
    if (!ts.isIfStatement(node)) return
    let matched = false
    walkAll(node.expression, (child) => {
      if (ts.isCallExpression(child) && isNegated(child) && hasReceiver(child, receiver)) matched = true
    })
    if (matched && throwsDirectoryConflict(node.thenStatement)) found.push(node)
  })
  return found.length === 1 ? found[0] : null
}

function arrowQueryCall(fn: ts.ArrowFunction | ts.FunctionExpression): ts.CallExpression | null {
  if (ts.isCallExpression(fn.body)) return fn.body
  if (!ts.isBlock(fn.body)) return null
  const statements = fn.body.statements.filter((statement) => !ts.isEmptyStatement(statement))
  if (statements.length !== 1 || !ts.isReturnStatement(statements[0]) || !statements[0].expression) return null
  return ts.isCallExpression(statements[0].expression) ? statements[0].expression : null
}

function forwardedQuery(expression: ts.Expression, fn: ts.SignatureDeclaration): string | null {
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return null
  const call = arrowQueryCall(expression)
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'query') return null
  if (!ts.isIdentifier(call.expression.expression)) return null
  const receiver = call.expression.expression.text
  if (!isParameterName(fn, receiver)) return null
  return `${receiver}.query`
}

function localForwarder(fn: ts.SignatureDeclaration, name: string): string | null {
  const initializers: ts.Expression[] = []
  visitOwn(fn, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      initializers.push(node.initializer)
    }
  })
  if (initializers.length !== 1) return null
  return forwardedQuery(initializers[0], fn)
}

function staticPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  if (!ts.isComputedPropertyName(name)) return null
  const expression = name.expression
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || ts.isNumericLiteral(expression)) return expression.text
  return null
}

function namedOption(item: ts.ObjectLiteralElement): item is ts.PropertyAssignment | ts.ShorthandPropertyAssignment | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration {
  return ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item) || ts.isMethodDeclaration(item) || ts.isGetAccessor(item) || ts.isSetAccessor(item)
}

function roleExecutor(call: ts.CallExpression, fn: ts.SignatureDeclaration): string | null {
  const argument = call.arguments[0]
  if (!argument || !ts.isObjectLiteralExpression(argument)) return null
  let last: ts.ObjectLiteralElement | null = null
  let blocked = false
  for (const item of argument.properties) {
    if (ts.isSpreadAssignment(item)) {
      if (last) blocked = true
      continue
    }
    if (!namedOption(item)) continue
    const name = staticPropertyName(item.name)
    if (name === null) {
      if (last) blocked = true
      continue
    }
    if (name !== 'executor') continue
    last = item
    blocked = false
  }
  if (!last || blocked) return null
  const value = ts.isShorthandPropertyAssignment(last) ? last.name : ts.isPropertyAssignment(last) ? last.initializer : null
  if (!value || !ts.isIdentifier(value) || !isParameterName(fn, value.text)) return null
  return value.text
}

function queryArgument(expression: ts.Expression | undefined, fn: ts.SignatureDeclaration): string | null {
  if (!expression || !ts.isPropertyAccessExpression(expression) || expression.name.text !== 'query') return null
  if (!ts.isIdentifier(expression.expression) || !isParameterName(fn, expression.expression.text)) return null
  return `${expression.expression.text}.query`
}

function enclosingThen(node: ts.Node, condition: string): ts.Block | null {
  for (let current = node; !ts.isFunctionLike(current); current = current.parent) {
    if (ts.isBlock(current) && ts.isIfStatement(current.parent)
      && current.parent.thenStatement === current && current.parent.expression.getText() === condition) return current
  }
  return null
}

function operationProfileExecutor(call: ts.CallExpression, fn: ts.SignatureDeclaration): string | null {
  const roleBlock = enclosingThen(call, "roleId === 'admin'")
  const actionBlock = roleBlock && enclosingThen(roleBlock, 'isRoleAction(request.action)')
  const enclosing = innermostFunction(fn.parent)
  if (!actionBlock || !enclosing || !ts.isFunctionDeclaration(enclosing)
    || enclosing.name?.text !== 'commitAuthorizationOperationWithinDeadline'
    || enclosing.parameters[2]?.name.getText() !== 'syncLegacyAdminProfile' || declares(fn, 'syncLegacyAdminProfile')
    || !actionBlock.statements.some(statement => ts.isVariableStatement(statement)
      && statement.declarationList.getText() === 'const { roleId, kind } = request.action')) return null
  if (call.arguments.length !== 3 || call.arguments[0].getText() !== 'request.targetUserId'
    || call.arguments[1].getText() !== "kind === 'role.assign'"
    || queryArgument(call.arguments[2], fn) !== 'tx.query') return null
  return 'tx.query|role.assign'
}

function executorToken(file: string, call: ts.CallExpression, helper: HelperName, fn: ts.SignatureDeclaration): { token: string | null, problem: 'omitted executor' | 'wrong executor' | null } {
  if (helper === 'assignUserRoles' || helper === 'unassignUserRoles') {
    const argument = call.arguments[0]
    if (!argument || !ts.isObjectLiteralExpression(argument)) return { token: null, problem: 'omitted executor' }
    const present = argument.properties.some((item) => (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) && propertyNameText(item.name) === 'executor')
    if (!present) return { token: null, problem: 'omitted executor' }
    const token = roleExecutor(call, fn)
    return token ? { token, problem: null } : { token: null, problem: 'wrong executor' }
  }
  if (helper === 'grantNamespaceAdmissions') {
    const argument = call.arguments[0]
    if (!argument) return { token: null, problem: 'omitted executor' }
    if (!ts.isIdentifier(argument) || !isParameterName(fn, argument.text)) return { token: null, problem: 'wrong executor' }
    return { token: argument.text, problem: null }
  }
  if (helper === 'disableNamespaceAdmissionsWithoutRoles') {
    const argument = call.arguments[1]
    if (!argument) return { token: null, problem: 'omitted executor' }
    const token = queryArgument(argument, fn)
    return token ? { token, problem: null } : { token: null, problem: 'wrong executor' }
  }
  if (file === OPERATION) {
    const token = operationProfileExecutor(call, fn)
    return { token, problem: token ? null : 'wrong executor' }
  }
  const query = call.arguments[2]
  const enabled = call.arguments[1] ? booleanText(call.arguments[1]) : null
  if (!query || !enabled) return { token: null, problem: 'omitted executor' }
  const forwarded = ts.isIdentifier(query) ? localForwarder(fn, query.text) : forwardedQuery(query, fn)
  if (!forwarded) return { token: null, problem: 'wrong executor' }
  return { token: `${forwarded}|${enabled}`, problem: null }
}

function declarationName(node: ts.Identifier): boolean {
  const parent = node.parent
  if (!parent) return false
  if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isMethodDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return true
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  return false
}

function helperNamespaceNames(tree: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  walkAll(tree, (node) => {
    if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly || !ts.isStringLiteral(node.moduleSpecifier)) return
    const bindings = node.importClause?.namedBindings
    if (!bindings || !ts.isNamespaceImport(bindings)) return
    const specifier = node.moduleSpecifier.text.replace(/\.(?:js|mjs|cjs|ts)$/, '')
    if (specifier.endsWith('/rbac/role-assignment') || specifier.endsWith('/rbac/namespace-admission') || specifier.endsWith('/admin/legacy-admin-profile')) {
      names.add(bindings.name.text)
    }
  })
  return names
}

function importsBinding(tree: ts.SourceFile, moduleName: string, name: string): boolean {
  return tree.statements.some(statement => {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly
      || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleName) return false
    const bindings = statement.importClause?.namedBindings
    return bindings && ts.isNamedImports(bindings) && bindings.elements.some(item =>
      !item.isTypeOnly && !item.propertyName && item.name.text === name)
  })
}

// The route passes its imported writer into the public entry; that entry passes the same parameter
// through its deadline callback. Each edge has one destination and one allowed argument position.
function operationProfileForwarder(file: string, call: ts.CallExpression): boolean {
  const fn = innermostFunction(call)
  if (!fn || !ts.isArrowFunction(fn) || !ts.isCallExpression(fn.parent)) return false
  const outer = fn.parent
  if (file === ADMIN_USERS) {
    return call.expression.getText() === 'commitAuthorizationOperation' && call.arguments.length === 3
      && call.arguments[0].getText() === 'actorId' && call.arguments[1].getText() === 'parseAuthorizationOperation(req.body, true)'
      && call.arguments[2].getText() === 'syncLegacyAdminProfile'
      && outer.expression.getText() === 'r.post' && outer.arguments.length === 3 && outer.arguments[2] === fn
      && ts.isStringLiteral(outer.arguments[0]) && outer.arguments[0].text === '/api/admin/authorization-operations'
      && outer.arguments[1].getText() === 'readOnlyAuthorizationJwtAuth' && !declares(fn, 'syncLegacyAdminProfile')
      && importsBinding(call.getSourceFile(), '../admin/legacy-admin-profile', 'syncLegacyAdminProfile')
      && importsBinding(call.getSourceFile(), '../admin/authorization-operation-service', 'commitAuthorizationOperation')
  }
  const enclosing = innermostFunction(outer)
  return file === OPERATION && call.expression.getText() === 'commitAuthorizationOperationWithinDeadline'
    && call.arguments.map(arg => arg.getText()).join(',') === 'actorId,input,syncLegacyAdminProfile,signal,deadlineAt'
    && fn.body === call && fn.parameters.map(param => param.name.getText()).join(',') === 'signal,deadlineAt'
    && outer.expression.getText() === 'withOperationDeadline' && outer.arguments.length === 2
    && outer.arguments[0].kind === ts.SyntaxKind.TrueKeyword && outer.arguments[1] === fn
    && ts.isReturnStatement(outer.parent) && !!enclosing && ts.isFunctionDeclaration(enclosing)
    && enclosing.name?.text === 'commitAuthorizationOperation' && enclosing.parameters[2]?.name.getText() === 'syncLegacyAdminProfile'
}

function escapeProblems(file: string, source: string): string[] {
  const tree = parse(file, source)
  const namespaces = helperNamespaceNames(tree)
  let forwarded = 0
  const problems: string[] = []
  walkAll(tree, (node) => {
    if (inTypeOrDoc(node)) return
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && ['commitAuthorizationOperation', 'commitAuthorizationOperationWithinDeadline'].includes(node.expression.text)) {
      if (operationProfileForwarder(file, node)) forwarded += 1
      else problems.push(`operation profile forwarding: ${file}`)
    }
    if (ts.isImportSpecifier(node)) {
      const clause = node.parent.parent
      if (node.isTypeOnly || (ts.isImportClause(clause) && clause.isTypeOnly)) return
      const imported = (node.propertyName ?? node.name).text
      if (HELPER_SET.has(imported) && node.name.text !== imported) problems.push(`alias ${file}: import ${node.name.text} binds ${imported}`)
      return
    }
    if (ts.isExportSpecifier(node) && node.propertyName) {
      const local = node.name.text
      const exported = node.propertyName.text
      if (HELPER_SET.has(local) || HELPER_SET.has(exported)) problems.push(`alias ${file}: export ${local} as ${exported}`)
      return
    }
    if (ts.isPropertyAccessExpression(node) && HELPER_SET.has(node.name.text) && !inTypeOrDoc(node.name)) {
      const called = ts.isCallExpression(node.parent) && node.parent.expression === node
      problems.push(`${called ? 'alias' : 'detached'} ${file}: property ${node.name.text}`)
      return
    }
    if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression
      const literal = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) && HELPER_SET.has(argument.text) ? argument.text : null
      const receiver = ts.isIdentifier(node.expression) && namespaces.has(node.expression.text) ? node.expression.text : null
      if (!literal && !receiver) return
      const called = ts.isCallExpression(node.parent) && node.parent.expression === node
      problems.push(`${called ? 'alias' : 'detached'} ${file}: ${literal ? `element ${literal}` : `namespace ${receiver}`}`)
      return
    }
    if (!ts.isIdentifier(node) || !HELPER_SET.has(node.text) || declarationName(node)) return
    if (ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent)) return
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) return
    if (node.text === 'syncLegacyAdminProfile' && ts.isCallExpression(node.parent)
      && node.parent.arguments[2] === node && operationProfileForwarder(file, node.parent)) return
    problems.push(`detached ${file}: ${node.text}`)
  })
  if ((file === ADMIN_USERS || file === OPERATION) && forwarded !== 1) problems.push(`operation profile forwarding count: ${file} x${forwarded}`)
  return problems
}

function callerBindingProblems(sources: SourceMap): string[] {
  const problems: string[] = []
  const found: string[] = []
  for (const [file, source] of sources) {
    problems.push(...escapeProblems(file, source))
    const tree = parse(file, source)
    walkAll(tree, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || !HELPER_SET.has(node.expression.text)) return
      const helper = node.expression.text as HelperName
      const owner = enclosingFunctionAt(file, source, node.getStart(tree))?.name ?? '<module>'
      const fn = innermostFunction(node)
      if (!fn) {
        problems.push(`omitted executor ${file}|${owner}|${helper}`)
        return
      }
      const executor = executorToken(file, node, helper, fn)
      if (executor.problem || !executor.token) {
        problems.push(`${executor.problem ?? 'wrong executor'} ${file}|${owner}|${helper}`)
        return
      }
      found.push(`${file}|${owner}|${helper}|${executor.token}`)
    })
  }
  const want = new Map<string, number>()
  const got = new Map<string, number>()
  for (const key of CALLER_BINDINGS) want.set(key, (want.get(key) ?? 0) + 1)
  for (const key of found) got.set(key, (got.get(key) ?? 0) + 1)
  for (const [key, count] of want) {
    const have = got.get(key) ?? 0
    if (have < count) problems.push(`missing ${key} x${count - have}`)
  }
  for (const [key, count] of got) {
    const have = want.get(key) ?? 0
    if (count > have) problems.push(`new caller ${key} x${count - have}`)
  }
  return problems.sort()
}

function plainQueryParameter(fn: ts.SignatureDeclaration): boolean {
  return fn.parameters.some((parameter) => {
    if (!ts.isObjectBindingPattern(parameter.name) || parameter.initializer || parameter.dotDotDotToken) return false
    return parameter.name.elements.some((element) => ts.isBindingElement(element)
      && ts.isIdentifier(element.name)
      && element.name.text === 'query'
      && !element.propertyName
      && !element.initializer
      && !element.dotDotDotToken)
  })
}

function declares(root: ts.Node, name: string): boolean {
  let found = false
  visitOwn(root, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = true
    if (ts.isParameter(node) && bindingNames(node.name).includes(name)) found = true
  })
  return found
}

function unconditional(node: ts.Node, stop: ts.Node): boolean {
  let current = node.parent
  while (current && current !== stop) {
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isCatchClause(current) || ts.isSwitchStatement(current)) return false
    if (ts.isBinaryExpression(current)) {
      const kind = current.operatorToken.kind
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken) return false
    }
    current = current.parent
  }
  return true
}

function skipParens(node: ts.Node): ts.Node {
  let current = node
  while (ts.isParenthesizedExpression(current.parent) && current.parent.expression === current) current = current.parent
  return current
}

function returnedCall(call: ts.CallExpression): boolean {
  let current = skipParens(call)
  if (ts.isAwaitExpression(current.parent) && current.parent.expression === current) current = skipParens(current.parent)
  return ts.isReturnStatement(current.parent) && current.parent.expression === current && !ts.isVoidExpression(current)
}

function directAwaitedCall(body: ts.ConciseBody, call: ts.CallExpression): boolean {
  if (!ts.isBlock(body)) return false
  return body.statements.some((statement) => ts.isExpressionStatement(statement)
    && ts.isAwaitExpression(statement.expression)
    && statement.expression.expression === call)
}

function hostBindingProblems(source: string): string[] {
  const tree = parse(INDEX_FILE, source)
  const hosts: ts.ArrowFunction[] = []
  walkAll(tree, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== 'rbacProvisioning' || !node.initializer || !ts.isObjectLiteralExpression(node.initializer)) return
    for (const property of node.initializer.properties) {
      if (!ts.isPropertyAssignment(property) || propertyNameText(property.name) !== 'applyRoleMatrix') continue
      if (ts.isArrowFunction(property.initializer)) hosts.push(property.initializer)
    }
  })
  if (hosts.length !== 1) return ['host: applyRoleMatrix wrapper']
  const host = hosts[0]
  const transactions: ts.CallExpression[] = []
  visitOwn(host, (node) => {
    if (!ts.isCallExpression(node) || node.expression.getText(tree).replace(/\s+/g, '') !== 'poolManager.get().transaction') return
    const callback = node.arguments[0]
    if (callback && ts.isArrowFunction(callback)) transactions.push(node)
  })
  const transactionCall = transactions.length === 1 ? transactions[0] : null
  const transactionArgument = transactionCall?.arguments[0]
  const callback = transactionArgument && ts.isArrowFunction(transactionArgument) ? transactionArgument : null
  if (!transactionCall || !callback || !plainQueryParameter(callback) || !returnedCall(transactionCall) || !unconditional(transactionCall, host)) return ['host: transaction']
  const forwarders: ts.ArrowFunction[] = []
  visitOwn(callback, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'txQuery' && node.initializer && ts.isArrowFunction(node.initializer)) {
      forwarders.push(node.initializer)
    }
  })
  if (forwarders.length !== 1) return ['host: txQuery forwarding']
  const forwarder = forwarders[0]
  const direct: ts.CallExpression[] = []
  const propertyQueries: ts.CallExpression[] = []
  visitOwn(forwarder, (node) => {
    if (!ts.isCallExpression(node)) return
    if (ts.isIdentifier(node.expression) && node.expression.text === 'query') direct.push(node)
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'query') propertyQueries.push(node)
  })
  if (declares(forwarder, 'query') || propertyQueries.length !== 0 || !direct.some((call) => unconditional(call, forwarder))) return ['host: txQuery forwarding']
  const applications: ts.CallExpression[] = []
  visitOwn(callback, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'applyRoleMatrix') applications.push(node)
  })
  if (applications.length !== 1) return ['host: applyRoleMatrix call']
  const application = applications[0]
  const first = application.arguments[0]
  const second = application.arguments[1]
  if (!first || !ts.isIdentifier(first) || first.text !== 'txQuery' || !second || !ts.isIdentifier(second) || second.text !== 'input') return ['host: applyRoleMatrix call']
  if (!returnedCall(application) || !unconditional(application, callback) || declares(forwarder, 'txQuery')) return ['host: applyRoleMatrix call']
  const txQuerySeen = { value: false }
  visitOwn(callback, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'txQuery') txQuerySeen.value = true
  })
  if (!txQuerySeen.value) return ['host: applyRoleMatrix call']
  return []
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElement | undefined {
  return object.properties.find((property) => (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && propertyNameText(property.name) === name)
}

function passesIdentifier(property: ts.ObjectLiteralElement | undefined, name: string): boolean {
  if (!property) return false
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text === name
  return ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer) && property.initializer.text === name
}

function transactionCallbacks(root: ts.Node): ts.ArrowFunction[] {
  const found: ts.ArrowFunction[] = []
  walkAll(root, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'transaction') return
    for (const argument of node.arguments) if (ts.isArrowFunction(argument)) found.push(argument)
  })
  return found
}

function variableInitializedBy(root: ts.Node, name: string, initializer: ts.Expression): boolean {
  let found = false
  visitOwn(root, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer === initializer) found = true
  })
  return found
}

function projectionChainProblems(source: string): string[] {
  const tree = parse(DIRECTORY_FILE, source)
  const problems: string[] = []
  const lock = namedFunction(tree, 'lockDirectorySyncAccessGraphUsers')
  const sync = namedFunction(tree, 'syncDirectoryIntegration')
  const project = namedFunction(tree, 'syncProjectedDepartmentMemberGroupsInTransaction')
  const govern = namedFunction(tree, 'applyDirectoryProjectedMemberGroupGovernanceInTransaction')
  if (!lock || !sync || !project || !govern) return ['projection: missing function']

  const inventory = ownCalls(lock, 'lockUsersForAccessGraphWrite')
  const inventoryCall = inventory.length === 1 ? inventory[0] : null
  const inventoryArg = inventoryCall?.arguments[0]
  if (!inventoryCall || !inventoryArg || !ts.isIdentifier(inventoryArg) || !isParameterName(lock, inventoryArg.text)) problems.push('projection: inventory receiver')
  const changed = rejectionIf(lock, 'lockedUsers')
  if (!changed || !inventoryCall || changed.getStart(tree) < inventoryCall.getEnd()) problems.push('projection: changed-link rejection')

  const callbacks = transactionCallbacks(sync).filter((callback) => ownCalls(callback, 'lockDirectorySyncAccessGraphUsers').length === 1)
  if (callbacks.length !== 1) return [...problems, 'projection: sync transaction']
  const callback = callbacks[0]
  const locked = ownCalls(callback, 'lockDirectorySyncAccessGraphUsers')[0]
  const lockedArg = locked.arguments[0]
  if (!lockedArg || !ts.isIdentifier(lockedArg) || !isParameterName(callback, lockedArg.text)) problems.push('projection: sync receiver')
  const resolved = rejectionIf(callback, 'syncAccess.lockedUserIds')
  if (!resolved || resolved.getStart(tree) < locked.getEnd()) problems.push('projection: resolved-user rejection')

  const maps: ts.VariableDeclaration[] = []
  visitOwn(callback, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'linkedUserIdByExternalUserId' && node.initializer && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'Map') {
      maps.push(node)
    }
  })
  const sets: ts.CallExpression[] = []
  visitOwn(callback, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'set' && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'linkedUserIdByExternalUserId') {
      sets.push(node)
    }
  })
  if (maps.length !== 1 || sets.length < 1 || !resolved || maps[0].getStart(tree) > sets[0].getStart(tree) || sets[0].getStart(tree) > resolved.getStart(tree)) {
    problems.push('projection: linked-user map')
  }

  const plans = ownCalls(callback, 'buildDirectoryProjectedMemberGroupPlans')
  const plan = plans.length === 1 ? plans[0] : null
  const planArg = plan?.arguments[0]
  const linkedProperty = planArg && ts.isObjectLiteralExpression(planArg) ? objectProperty(planArg, 'linkedUserIdByExternalUserId') : undefined
  if (!plan || !resolved || plan.getStart(tree) < resolved.getEnd() || !passesIdentifier(linkedProperty, 'linkedUserIdByExternalUserId')) {
    problems.push('projection: plan order')
  }
  const projections = ownCalls(callback, 'syncProjectedDepartmentMemberGroupsInTransaction')
  const projection = projections.length === 1 ? projections[0] : null
  const projectionClient = projection?.arguments[0]
  const projectionPlans = projection?.arguments[1]
  if (!projection || !plan || projection.getStart(tree) < plan.getEnd()
    || !projectionClient || !ts.isIdentifier(projectionClient) || !isParameterName(callback, projectionClient.text)
    || !projectionPlans || !ts.isIdentifier(projectionPlans) || projectionPlans.text !== 'memberGroupPlans'
    || !variableInitializedBy(callback, 'memberGroupPlans', plan)) {
    problems.push('projection: projection receiver')
  }

  const governanceCalls = ownCalls(project, 'applyDirectoryProjectedMemberGroupGovernanceInTransaction')
  const governanceCall = governanceCalls.length === 1 ? governanceCalls[0] : null
  const governanceClient = governanceCall?.arguments[0]
  const governanceOptions = governanceCall?.arguments[1]
  const plansProperty = governanceOptions && ts.isObjectLiteralExpression(governanceOptions) ? objectProperty(governanceOptions, 'plans') : undefined
  if (!governanceCall || !governanceClient || !ts.isIdentifier(governanceClient) || !isParameterName(project, governanceClient.text) || !passesIdentifier(plansProperty, 'plans') || !isParameterName(project, 'plans')) {
    problems.push('projection: governance receiver')
  }
  const grants = ownCalls(govern, 'assignUserRoles')
  const grant = grants.length === 1 ? grants[0] : null
  if (!grant || roleExecutor(grant, govern) !== [...parameterNames(govern)][0]) problems.push('projection: grant receiver')
  return problems
}

function queryCalls(root: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  visitOwn(root, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'query') found.push(node)
  })
  return found
}

function receiverParameter(call: ts.CallExpression, fn: ts.SignatureDeclaration): boolean {
  if (!ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression)) return false
  return isParameterName(fn, call.expression.expression.text)
}

function rollbackIf(node: ts.Node, stop: ts.Node): ts.IfStatement | null {
  let current: ts.Node | undefined = node
  while (current && current !== stop) {
    if (ts.isIfStatement(current)) {
      const condition = current.expression
      if (ts.isBinaryExpression(condition)
        && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && ts.isIdentifier(condition.left)
        && condition.left.text === 'action'
        && ts.isStringLiteral(condition.right)
        && condition.right.text === 'rollback') return current
    }
    current = current.parent
  }
  return null
}

function handoverPair(fn: ts.FunctionLikeDeclaration, effect: string, rollback: boolean, tree: ts.SourceFile): string | null {
  const callbacks = transactionCallbacks(fn)
  if (callbacks.length !== 1) return 'handover: transaction'
  const callback = callbacks[0]
  const locks = ownCalls(callback, 'lockPair')
  if (locks.length !== 1) return 'handover: lock'
  const lock = locks[0]
  if (!directAwaitedCall(callback.body, lock)) return 'handover: lock completion'
  const first = lock.arguments[0]
  if (!first || !ts.isIdentifier(first) || !isParameterName(callback, first.text)) return 'handover: lock receiver'
  const effects = queryCalls(callback).filter((call) => {
    const sql = call.arguments[0] ? sqlText(call.arguments[0]) : null
    return sql !== null && sql.includes(effect) && receiverParameter(call, callback)
  })
  if (effects.length !== 1 || effects[0].getStart(tree) < lock.getEnd()) return 'handover: effect'
  if (rollback && !rollbackIf(effects[0], callback)) return 'handover: rollback effect'
  return null
}

function handoverProblems(source: string): string[] {
  const tree = parse(HANDOVER_FILE, source)
  const problems: string[] = []
  const lock = namedFunction(tree, 'lockPair')
  const apply = namedFunction(tree, 'applyDirectoryHandover')
  const finish = namedFunction(tree, 'finishDirectoryHandover')
  if (!lock || !apply || !finish) return ['handover: missing function']
  const queries = queryCalls(lock)
  const identity = queries.filter((call) => {
    const sql = call.arguments[0] ? sqlText(call.arguments[0]) : null
    return sql !== null && sql.includes('directory:identity-maintenance')
  })
  if (identity.length !== 1 || !receiverParameter(identity[0], lock)) problems.push('handover: identity receiver')
  if (identity.length === 1 && queries.some((call) => call !== identity[0] && call.getStart(tree) < identity[0].getStart(tree))) {
    problems.push('handover: identity order')
  }
  const applyProblem = handoverPair(apply, 'INSERT INTO directory_departments', false, tree)
  const finishProblem = handoverPair(finish, 'DELETE FROM directory_departments', true, tree)
  if (applyProblem) problems.push(`handover: apply ${applyProblem}`)
  if (finishProblem) problems.push(`handover: finish ${finishProblem}`)
  return problems
}

function typeLiteral(parameter: ts.ParameterDeclaration | undefined): ts.TypeLiteralNode | null {
  const type = parameter?.type
  if (!type) return null
  if (ts.isTypeLiteralNode(type)) return type
  if (ts.isParenthesizedTypeNode(type)) {
    return ts.isTypeLiteralNode(type.type) ? type.type : null
  }
  return null
}

function optionalProperty(parameter: ts.ParameterDeclaration | undefined, name: string): boolean {
  const type = typeLiteral(parameter)
  if (!type) return false
  const property = type.members.find((member) => ts.isPropertySignature(member) && propertyNameText(member.name) === name)
  return !!property && ts.isPropertySignature(property) && !!property.questionToken
}

function requiredParameter(parameter: ts.ParameterDeclaration | undefined, name: string): boolean {
  return !!parameter && ts.isIdentifier(parameter.name) && parameter.name.text === name && !parameter.questionToken && !parameter.initializer && !parameter.dotDotDotToken
}

function signatureProblems(roleSource: string, admissionSource: string, legacySource: string): string[] {
  const problems: string[] = []
  const role = parse(ROLE_FILE, roleSource)
  const admission = parse(ADMISSION_FILE, admissionSource)
  const legacy = parse(LEGACY_FILE, legacySource)
  for (const name of ['assignUserRoles', 'unassignUserRoles'] as const) {
    const fn = namedFunction(role, name)
    if (!fn || fn.parameters.length !== 1 || !requiredParameter(fn.parameters[0], 'options') || !optionalProperty(fn.parameters[0], 'executor')) {
      problems.push(`signature: ${name}`)
    }
  }
  const grant = namedFunction(admission, 'grantNamespaceAdmissions')
  if (!grant || grant.parameters.length !== 2 || !requiredParameter(grant.parameters[0], 'executor') || !requiredParameter(grant.parameters[1], 'options')) {
    problems.push('signature: grantNamespaceAdmissions')
  }
  const disable = namedFunction(admission, 'disableNamespaceAdmissionsWithoutRoles')
  if (!disable || disable.parameters.length !== 2 || !requiredParameter(disable.parameters[0], 'options') || !requiredParameter(disable.parameters[1], 'runQuery')) {
    problems.push('signature: disableNamespaceAdmissionsWithoutRoles')
  }
  const sync = namedFunction(legacy, 'syncLegacyAdminProfile')
  if (!sync || sync.parameters.length !== 3 || !requiredParameter(sync.parameters[0], 'userId') || !requiredParameter(sync.parameters[1], 'enabled') || !requiredParameter(sync.parameters[2], 'runQuery')) {
    problems.push('signature: syncLegacyAdminProfile')
  }
  return problems
}

function unwrapObject(expression: ts.Expression): ts.ObjectLiteralExpression | null {
  let current = expression
  for (let depth = 0; depth < 4; depth += 1) {
    if (ts.isObjectLiteralExpression(current)) return current
    if (ts.isAsExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression
      continue
    }
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === 'freeze' && current.arguments[0]) {
      current = current.arguments[0]
      continue
    }
    return null
  }
  return ts.isObjectLiteralExpression(current) ? current : null
}

function stringProperty(object: ts.ObjectLiteralExpression, name: string, constants: ReadonlyMap<string, string>): string | null {
  const property = objectProperty(object, name)
  if (!property || !ts.isPropertyAssignment(property)) return null
  const value = property.initializer
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text
  if (ts.isIdentifier(value)) return constants.get(value.text) ?? null
  return null
}

function consumerObjects(source: string): { objects: ts.ObjectLiteralExpression[], constants: Map<string, string>, pendingShape: boolean } {
  const tree = parse(CONSUMER_FILE, source)
  const constants = new Map<string, string>()
  const objects: ts.ObjectLiteralExpression[] = []
  let pendingShape = false
  walkAll(tree, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) {
      constants.set(node.name.text, node.initializer.text)
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'hasPendingConsumers') {
      walkAll(node, (child) => {
        if (!ts.isBinaryExpression(child) || child.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return
        if (ts.isPropertyAccessExpression(child.left) && child.left.name.text === 'mode' && ts.isStringLiteral(child.right) && child.right.text === 'PENDING_LOCKED') {
          pendingShape = true
        }
      })
    }
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== 'AUTHORIZATION_INPUT_CONSUMERS' || !node.initializer) return
    const frozen = node.initializer
    const list = ts.isCallExpression(frozen) && frozen.arguments[0] && ts.isArrayLiteralExpression(frozen.arguments[0]) ? frozen.arguments[0] : null
    if (!list) return
    for (const element of list.elements) {
      const object = unwrapObject(element)
      if (object) objects.push(object)
    }
  })
  return { objects, constants, pendingShape }
}

function consumerModeProblems(source: string): string[] {
  const { objects, constants, pendingShape } = consumerObjects(source)
  const problems: string[] = []
  const byId = new Map<string, ts.ObjectLiteralExpression>()
  for (const object of objects) {
    const id = stringProperty(object, 'id', constants)
    if (id && (id === 'K-02' || id === 'K-04' || id === 'K-05')) {
      if (byId.has(id)) problems.push(`consumer: duplicate ${id}`)
      byId.set(id, object)
    }
  }
  const expectEntry = (id: string, fields: Record<string, string | undefined>) => {
    const object = byId.get(id)
    if (!object) {
      problems.push(`consumer: missing ${id}`)
      return
    }
    for (const [name, expected] of Object.entries(fields)) {
      const actual = stringProperty(object, name, constants)
      if (expected === undefined) {
        if (objectProperty(object, name)) problems.push(`consumer: ${id} ${name}`)
      } else if (actual !== expected) problems.push(`consumer: ${id} ${name}`)
    }
  }
  expectEntry('K-02', {
    file: `${SRC}/auth/security-action-proof.ts`,
    symbol: 'consume',
    call: 'assessSecurityActionPrivilege',
    mode: 'PENDING_LOCKED',
    slice: 'AIS-3b',
    reason: undefined,
  })
  expectEntry('K-04', {
    file: `${SRC}/auth/admin-grant-receiving-reader.ts`,
    symbol: 'readPreparedTarget',
    call: 'assessSecurityActionPrivilege',
    mode: 'ADVISORY',
    reason: K04_REASON,
    slice: undefined,
  })
  expectEntry('K-05', {
    file: `${SRC}/auth/admin-grant-receiving-reader.ts`,
    symbol: 'resolveAdminGrantTargetSet',
    call: 'assessSecurityActionPrivilege',
    mode: 'ADVISORY',
    reason: K05_REASON,
    slice: undefined,
  })
  if (!pendingShape) problems.push('consumer: hasPendingConsumers')
  return problems
}

describe('authorization input caller binding', () => {
  it('pins the production caller multiset, same-transaction executors, and legacy union', () => {
    expect(CALLER_BINDINGS).toHaveLength(28)
    expect(CALLER_BINDINGS.filter((key) => key.includes('|syncLegacyAdminProfile|'))).toHaveLength(5)
    expect(callerBindingProblems(productionSources())).toEqual([])
  })

  it('requires both operation forwarding edges and the admin-role decision on the committing transaction', () => {
    const route = read(ADMIN_USERS)
    const service = read(OPERATION)
    const routeEdge = 'commitAuthorizationOperation(actorId, parseAuthorizationOperation(req.body, true), syncLegacyAdminProfile)'
    const serviceEdge = 'commitAuthorizationOperationWithinDeadline(actorId, input, syncLegacyAdminProfile, signal, deadlineAt)'
    for (const [file, source, from, to] of [
      [ADMIN_USERS, route, routeEdge, routeEdge.replace('syncLegacyAdminProfile', 'otherWriter')],
      [ADMIN_USERS, route, routeEdge, routeEdge.replace('commitAuthorizationOperation(', 'other.commitAuthorizationOperation(')],
      [OPERATION, service, serviceEdge, serviceEdge.replace('syncLegacyAdminProfile', 'otherWriter')],
      [ADMIN_USERS, route, 'try { return res.json(await ' + routeEdge, 'const syncLegacyAdminProfile = otherWriter; try { return res.json(await ' + routeEdge],
      [OPERATION, service, 'withOperationDeadline(true, (signal, deadlineAt) =>', 'otherDeadline(true, (signal, deadlineAt) =>'],
    ]) {
      expect(escapeProblems(file, once(source, from, to))).toContain(`operation profile forwarding count: ${file} x0`)
    }
    const profileCall = "syncLegacyAdminProfile(request.targetUserId, kind === 'role.assign', tx.query)"
    for (const [from, to] of [
      [profileCall, profileCall.replace('request.targetUserId', 'actorId')],
      [profileCall, profileCall.replace('role.assign', 'role.revoke')],
      [profileCall, profileCall.replace('tx.query', 'pool.query')],
      ["if (roleId === 'admin') {", "if (roleId !== 'admin') {"],
    ]) {
      const sources = new Map([[OPERATION, once(service, from, to)]])
      expect(callerBindingProblems(sources)).toContain(`wrong executor ${OPERATION}|${TX_CALLBACK}|syncLegacyAdminProfile`)
    }
  })

  it('rejects an omitted executor, a pool receiver, a new caller, and an alias', () => {
    const omitted = productionSources(edit(PLATFORM_ASSIGN, '      executor: tx,\n', ''))
    expect(callerBindingProblems(omitted).some((problem) => problem.startsWith('omitted executor') || problem.startsWith('missing '))).toBe(true)
    const pooled = productionSources(edit(PLATFORM_ASSIGN, '      executor: tx,\n', '      executor: pool,\n'))
    expect(callerBindingProblems(pooled).some((problem) => problem.includes('wrong executor'))).toBe(true)
    const disabled = productionSources(edit(
      PLATFORM_UNASSIGN,
      '      revokedRoleId: context.roleId,\n    }, tx.query)',
      '      revokedRoleId: context.roleId,\n    }, pool.query)',
    ))
    expect(callerBindingProblems(disabled).some((problem) => problem.includes('wrong executor'))).toBe(true)
    const legacy = productionSources(edit(
      PLATFORM_ASSIGN,
      '(sql, params) => tx.query(sql, params)',
      '(sql, params) => pool.query(sql, params)',
    ))
    expect(callerBindingProblems(legacy).some((problem) => problem.includes('wrong executor'))).toBe(true)
    const added = productionSources((file, source) => (file === PLATFORM_ASSIGN
      ? `${source}\nexport async function extraPlatformAssign(tx: { query(sql: string, params?: unknown[]): Promise<unknown> }) {\n  await assignUserRoles({ userIds: ['u'], roleId: 'r', scope: { kind: 'platform-admin' }, executor: tx })\n}\n`
      : source))
    expect(callerBindingProblems(added).some((problem) => problem.startsWith('new caller '))).toBe(true)
    const aliased = productionSources((file, source) => (file === PLATFORM_ASSIGN
      ? `${source}\nimport { assignUserRoles as grantRoles } from '../rbac/role-assignment'\nfunction handOff(pool: { assignUserRoles(value: unknown): unknown }) {\n  const grant = assignUserRoles\n  return pool.assignUserRoles({ executor: grant })\n}\n`
      : source))
    const aliasProblems = callerBindingProblems(aliased)
    expect(aliasProblems.some((problem) => problem.startsWith('alias '))).toBe(true)
    expect(aliasProblems.some((problem) => problem.startsWith('detached '))).toBe(true)
  })

  it('does not accept a comment, a string, or an unrelated method as a caller', () => {
    const noise = `\nfunction unrelatedMethod(tx: unknown) {\n  /* await assignUserRoles({ userIds: [], roleId: 'r', scope: { kind: 'platform-admin' }, executor: tx }) */\n  const text = "await assignUserRoles({ executor: tx })"\n  return text ?? tx\n}\n`
    expect(callerBindingProblems(productionSources((file, source) => (file === PLATFORM_ASSIGN ? source + noise : source)))).toEqual([])
    const removed = productionSources((file, source) => (file === BIRTH ? once(source, 'await assignUserRoles({', 'await retiredAssign({') + noise : source))
    expect(callerBindingProblems(removed).some((problem) => problem.startsWith('missing ') && problem.includes('|assignUserRoles|'))).toBe(true)
  })

  it('pins index applyRoleMatrix to the host transaction query', () => {
    expect(hostBindingProblems(read(INDEX_FILE))).toEqual([])
    const pooled = once(
      read(INDEX_FILE),
      'const txQuery: RbacProvisioningQueryFn = async (sql, params) => {\n            const result = await query(sql, params)',
      'const txQuery: RbacProvisioningQueryFn = async (sql, params) => {\n            const result = await pool.query(sql, params)',
    )
    expect(hostBindingProblems(pooled)).not.toEqual([])
    const commented = once(
      read(INDEX_FILE),
      'const txQuery: RbacProvisioningQueryFn = async (sql, params) => {\n            const result = await query(sql, params)',
      'const txQuery: RbacProvisioningQueryFn = async (sql, params) => {\n            /* const result = await query(sql, params) */\n            const result = await pool.query(sql, params)',
    )
    expect(hostBindingProblems(commented)).not.toEqual([])
    const replaced = once(read(INDEX_FILE), 'return applyRoleMatrix(txQuery, input)', 'return applyRoleMatrix(poolQuery, input)')
    expect(hostBindingProblems(replaced)).toEqual(['host: applyRoleMatrix call'])
  })

  it('pins the checked directory map, plan, and same-client projection', () => {
    const source = read(DIRECTORY_FILE)
    expect(projectionChainProblems(source)).toEqual([])
    const unchecked = once(source, '!syncAccess.lockedUserIds.has(localUserId)', '!syncAccess.lockedUserIds.missing(localUserId)')
    expect(projectionChainProblems(unchecked)).toContain('projection: resolved-user rejection')
    const commented = once(
      source,
      '!syncAccess.lockedUserIds.has(localUserId)',
      'false /* !syncAccess.lockedUserIds.has(localUserId) */',
    )
    expect(projectionChainProblems(commented)).toContain('projection: resolved-user rejection')
    const pooled = once(
      source,
      'syncProjectedDepartmentMemberGroupsInTransaction(\n        client,\n        memberGroupPlans,',
      'syncProjectedDepartmentMemberGroupsInTransaction(\n        pool,\n        memberGroupPlans,',
    )
    expect(projectionChainProblems(pooled)).toContain('projection: projection receiver')
    const inventory = once(
      source,
      'if (row.local_user_id && !lockedUsers.has(row.local_user_id))',
      'if (row.local_user_id && row.local_user_id)',
    )
    expect(projectionChainProblems(inventory)).toContain('projection: changed-link rejection')
  })

  it('pins handover apply and rollback to lockPair before the department effect', () => {
    const source = read(HANDOVER_FILE)
    expect(handoverProblems(source)).toEqual([])
    const identity = once(
      source,
      'await c.query("SELECT pg_advisory_xact_lock(hashtext(\'directory:identity-maintenance\'))")',
      'await pool.query("SELECT pg_advisory_xact_lock(hashtext(\'directory:identity-maintenance\'))")',
    )
    expect(handoverProblems(identity)).toContain('handover: identity receiver')
    const applyReceiver = once(
      source,
      '    await lockPair(c, p, actorId)\n    await assertOperator(c, actorId)\n    const before = await snapshot(c, p)',
      '    await lockPair(pool, p, actorId)\n    await assertOperator(c, actorId)\n    const before = await snapshot(c, p)',
    )
    expect(handoverProblems(applyReceiver).some((problem) => problem.startsWith('handover: apply '))).toBe(true)
    const rollbackGone = once(
      source,
      '    await lockPair(c, p, actorId)\n    await assertOperator(c, actorId)\n    const journal = (',
      '    await assertOperator(c, actorId)\n    const journal = (',
    )
    expect(handoverProblems(rollbackGone).some((problem) => problem.startsWith('handover: finish '))).toBe(true)
    const deleteReceiver = once(
      source,
      "await c.query(\n          'DELETE FROM directory_departments",
      "await pool.query(\n          'DELETE FROM directory_departments",
    )
    expect(handoverProblems(deleteReceiver).some((problem) => problem.includes('effect'))).toBe(true)
  })

  it('preserves the raw helper signatures, pending K-02, and advisory K-04 and K-05', () => {
    expect(signatureProblems(read(ROLE_FILE), read(ADMISSION_FILE), read(LEGACY_FILE))).toEqual([])
    expect(consumerModeProblems(read(CONSUMER_FILE))).toEqual([])
    expect(hasPendingConsumers()).toBe(true)
    const requiredExecutor = once(
      read(ROLE_FILE),
      'export async function assignUserRoles(options: {\n  userIds: readonly string[]\n  roleId: string\n  assignmentSource?: RoleAssignmentSource\n  scope: RoleAssignmentScope\n  executor?: RoleAssignmentExecutor',
      'export async function assignUserRoles(options: {\n  userIds: readonly string[]\n  roleId: string\n  assignmentSource?: RoleAssignmentSource\n  scope: RoleAssignmentScope\n  executor: RoleAssignmentExecutor',
    )
    expect(signatureProblems(requiredExecutor, read(ADMISSION_FILE), read(LEGACY_FILE))).toContain('signature: assignUserRoles')
    const locked = once(
      read(CONSUMER_FILE),
      "symbol: 'consume', call: 'assessSecurityActionPrivilege', count: 1, mode: 'PENDING_LOCKED', slice: 'AIS-3b'",
      "symbol: 'consume', call: 'assessSecurityActionPrivilege', count: 1, mode: 'LOCKED_DECISION', slice: 'AIS-3b'",
    )
    expect(consumerModeProblems(locked)).toContain('consumer: K-02 mode')
    const k04Reason = once(read(CONSUMER_FILE), K04_REASON, K04_REASON.replace('only refuse', 'authorize'))
    expect(consumerModeProblems(k04Reason)).toContain('consumer: K-04 reason')
    const reason = once(read(CONSUMER_FILE), K05_REASON, K05_REASON.replace('does not authorize', 'does authorize'))
    expect(consumerModeProblems(reason)).toContain('consumer: K-05 reason')
  })

  it('rejects an element access, a later executor override, an unthrown conflict, and a call that does not complete', () => {
    const indexed = productionSources((file, source) => (file === PLATFORM_ASSIGN
      ? `${source}\nimport * as roleWriters from '../rbac/role-assignment'\nexport async function hiddenGrant(key: string) {\n  await roleWriters['assignUserRoles']({ userIds: ['u'], roleId: 'r', scope: { kind: 'platform-admin' } })\n  return roleWriters[key]({ userIds: ['u'], roleId: 'r', scope: { kind: 'platform-admin' } })\n}\n`
      : source))
    const indexedProblems = callerBindingProblems(indexed)
    expect(indexedProblems.some((problem) => problem.startsWith('alias ') && problem.includes('element assignUserRoles'))).toBe(true)
    expect(indexedProblems.some((problem) => problem.startsWith('alias ') && problem.includes('namespace roleWriters'))).toBe(true)
    const indexedText = productionSources((file, source) => (file === PLATFORM_ASSIGN
      ? `${source}\nfunction hiddenGrant() {\n  /* return roleWriters['assignUserRoles']({}) */\n  const text = "roleWriters['assignUserRoles']"\n  return text\n}\n`
      : source))
    expect(callerBindingProblems(indexedText)).toEqual([])

    const executorNeedle = '      scope: { kind: \'platform-admin\' },\n      executor: tx,\n    })'
    const spread = productionSources(edit(
      PLATFORM_ASSIGN,
      executorNeedle,
      '      scope: { kind: \'platform-admin\' },\n      executor: tx,\n      ...{ executor: undefined },\n    })',
    ))
    expect(callerBindingProblems(spread).some((problem) => problem.includes('wrong executor'))).toBe(true)
    const replaced = productionSources(edit(
      PLATFORM_ASSIGN,
      executorNeedle,
      '      scope: { kind: \'platform-admin\' },\n      executor: tx,\n      executor: undefined,\n    })',
    ))
    expect(callerBindingProblems(replaced).some((problem) => problem.includes('wrong executor'))).toBe(true)
    const computed = productionSources(edit(
      PLATFORM_ASSIGN,
      executorNeedle,
      '      scope: { kind: \'platform-admin\' },\n      executor: tx,\n      [key]: undefined,\n    })',
    ))
    expect(callerBindingProblems(computed).some((problem) => problem.includes('wrong executor'))).toBe(true)
    const spreadBefore = productionSources(edit(
      PLATFORM_ASSIGN,
      executorNeedle,
      '      scope: { kind: \'platform-admin\' },\n      ...{ executor: undefined },\n      executor: tx,\n    })',
    ))
    expect(callerBindingProblems(spreadBefore)).toEqual([])

    const directory = read(DIRECTORY_FILE)
    const unthrown = once(
      directory,
      "throw new DirectoryConflictError('Directory sync account binding changed before the user mutex was acquired; retry the run')",
      "/* throw new DirectoryConflictError('Directory sync account binding changed before the user mutex was acquired; retry the run') */\n      new DirectoryConflictError('Directory sync account binding changed before the user mutex was acquired; retry the run')",
    )
    expect(projectionChainProblems(unthrown)).toContain('projection: changed-link rejection')
    const resolvedUnthrown = once(
      directory,
      "throw new DirectoryConflictError(\n            'Directory sync resolved a local user after the mutex inventory; retry the run',",
      "/* throw new DirectoryConflictError(\n            'Directory sync resolved a local user after the mutex inventory; retry the run', */\n          new DirectoryConflictError(\n            'Directory sync resolved a local user after the mutex inventory; retry the run',",
    )
    expect(projectionChainProblems(resolvedUnthrown)).toContain('projection: resolved-user rejection')
    const nestedInventory = once(
      directory,
      "throw new DirectoryConflictError('Directory sync account binding changed before the user mutex was acquired; retry the run')",
      "if (false) throw new DirectoryConflictError('Directory sync account binding changed before the user mutex was acquired; retry the run')",
    )
    expect(projectionChainProblems(nestedInventory)).toContain('projection: changed-link rejection')
    const nestedResolved = once(
      directory,
      "throw new DirectoryConflictError(\n            'Directory sync resolved a local user after the mutex inventory; retry the run',",
      "if (false) throw new DirectoryConflictError(\n            'Directory sync resolved a local user after the mutex inventory; retry the run',",
    )
    expect(projectionChainProblems(nestedResolved)).toContain('projection: resolved-user rejection')

    const voided = once(
      read(INDEX_FILE),
      'return applyRoleMatrix(txQuery, input)',
      '/* return applyRoleMatrix(txQuery, input) */\n          void applyRoleMatrix(txQuery, input)',
    )
    expect(hostBindingProblems(voided)).toEqual(['host: applyRoleMatrix call'])
    const handover = read(HANDOVER_FILE)
    const dominated = once(
      handover,
      '    await lockPair(c, p, actorId)\n    await assertOperator(c, actorId)\n    const before = await snapshot(c, p)',
      '    /* await lockPair(c, p, actorId) */\n    if (false) await lockPair(c, p, actorId)\n    await assertOperator(c, actorId)\n    const before = await snapshot(c, p)',
    )
    expect(handoverProblems(dominated)).toContain('handover: apply handover: lock completion')
    const looped = once(
      handover,
      '    await lockPair(c, p, actorId)\n    await assertOperator(c, actorId)\n    const before = await snapshot(c, p)',
      '    while (false) { await lockPair(c, p, actorId) }\n    await assertOperator(c, actorId)\n    const before = await snapshot(c, p)',
    )
    expect(handoverProblems(looped)).toContain('handover: apply handover: lock completion')
  })
})
