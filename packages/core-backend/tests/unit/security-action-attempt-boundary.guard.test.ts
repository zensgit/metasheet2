import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { listFiles, scanSource, SOURCE_EXTENSIONS } from '../helpers/authorization-input-scan'

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SRC = 'packages/core-backend/src'
const MODULE = `${SRC}/auth/security-action-attempt-admission.ts`
const ISSUER = `${SRC}/auth/security-action-proof.ts`
const GRANT_ISSUER = `${SRC}/auth/admin-grant-proof.ts`
const MIGRATION = `${SRC}/db/migrations/zzzz20261117120100_create_security_action_session_flight.ts`
const STEM = 'security-action-attempt-admission'
const ENTRY = 'runOwnedAttempt'
const TABLE = 'security_action_session_flight'

function inventoryFiles(): string[] {
  return listFiles(ROOT, { roots: [SRC, 'plugins'], exclude: [] }).filter(file => SOURCE_EXTENSIONS.has(path.extname(file)))
}

function constantReader(tree: ts.SourceFile): (node: ts.Node) => string | undefined {
  const bindings = new Map<ts.Node, Map<string, ts.Expression | undefined>>()
  function scope(node: ts.Node | undefined, functionOnly = false): ts.Node {
    let current = node
    while (current) {
      if (ts.isSourceFile(current) || ts.isFunctionLike(current)) return current
      if (!functionOnly && (ts.isBlock(current) || ts.isCatchClause(current) || ts.isForStatement(current)
        || ts.isForInStatement(current) || ts.isForOfStatement(current) || ts.isCaseBlock(current)
        || ts.isClassDeclaration(current) || ts.isClassExpression(current))) return current
      current = current.parent
    }
    return tree
  }
  function bind(owner: ts.Node, name: ts.BindingName, value?: ts.Expression): void {
    if (!ts.isIdentifier(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) bind(owner, element.name)
      return
    }
    let names = bindings.get(owner)
    if (!names) bindings.set(owner, names = new Map())
    names.set(name.text, names.has(name.text) ? undefined : value)
  }
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
      const flags = node.parent.flags
      bind(scope(node.parent, !(flags & ts.NodeFlags.BlockScoped)), node.name, flags & ts.NodeFlags.Const ? node.initializer : undefined)
    } else if (ts.isParameter(node)) bind(scope(node.parent), node.name)
    else if (ts.isCatchClause(node) && node.variableDeclaration) bind(node, node.variableDeclaration.name)
    else if (ts.isImportClause(node) && !node.isTypeOnly && node.name) bind(tree, node.name)
    else if (ts.isNamespaceImport(node) && !node.parent.isTypeOnly) bind(tree, node.name)
    else if (ts.isImportSpecifier(node) && !node.isTypeOnly && !node.parent.parent.isTypeOnly) bind(tree, node.name)
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) bind(scope(node.parent), node.name)
    else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) bind(node, node.name)
    ts.forEachChild(node, collect)
  }
  collect(tree)
  function read(node: ts.Node, active = new Set<ts.Node>()): string | undefined {
    if (active.has(node)) return undefined
    active.add(node)
    try {
      if (ts.isStringLiteralLike(node)) return node.text
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return read(node.expression, active)
      if (ts.isIdentifier(node)) {
        let owner = scope(node.parent)
        while (true) {
          const names = bindings.get(owner)
          if (names?.has(node.text)) {
            const initializer = names.get(node.text)
            return initializer ? read(initializer, active) : undefined
          }
          if (owner === tree) return undefined
          owner = scope(owner.parent)
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = read(node.left, active)
        const right = read(node.right, active)
        if (left !== undefined && right !== undefined) return left + right
      }
      if (ts.isTemplateExpression(node)) {
        let result = node.head.text
        for (const span of node.templateSpans) {
          const value = read(span.expression, active)
          if (value === undefined) return undefined
          result += value + span.literal.text
        }
        return result
      }
      return undefined
    } finally {
      active.delete(node)
    }
  }
  return node => read(node)
}

function migrationTargetProblems(source: string): string[] {
  const tree = ts.createSourceFile(MIGRATION, source, ts.ScriptTarget.Latest, true)
  const variables: ts.VariableDeclaration[] = []
  const functions: ts.FunctionDeclaration[] = []
  const tableNames: ts.Identifier[] = []
  let identifierUseValid = true
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) variables.push(node)
    if (ts.isFunctionDeclaration(node)) functions.push(node)
    if (ts.isIdentifier(node) && node.text === 'table') tableNames.push(node)
    if (ts.isIdentifier(node) && node.text === 'IDENT' && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === 'test'
        && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent)) identifierUseValid = false
    ts.forEachChild(node, collect)
  }
  collect(tree)
  const named = (name: string) => variables.filter(node => ts.isIdentifier(node.name) && node.name.text === name)
  const constant = (node: ts.VariableDeclaration) => ts.isVariableDeclarationList(node.parent) && !!(node.parent.flags & ts.NodeFlags.Const)
  const problems: string[] = []
  const fixed = new Map([['RELATION', TABLE], ['GUARD', 'security_action_session_flight_guard'], ['ACQUIRE', 'security_action_session_flight_acquire'], ['RELEASE', 'security_action_session_flight_release']])
  for (const [name, value] of fixed) {
    const declarations = named(name)
    const declaration = declarations[0]
    if (declarations.length !== 1 || !constant(declaration) || declaration.parent.parent.parent !== tree
      || !declaration.initializer || !ts.isStringLiteral(declaration.initializer) || declaration.initializer.text !== value) problems.push(`flight fixed ${name}`)
  }
  const ident = named('IDENT')
  if (ident.length !== 1 || !constant(ident[0]) || ident[0].parent.parent.parent !== tree
    || ident[0].initializer?.getText(tree) !== '/^[a-z_][a-z0-9_]*$/' || !identifierUseValid) problems.push('flight identifier validation')
  for (const [name, expected] of [['up', '2f54c974cf36b94257c0c848dc28a6eb725f1b94865abe950a6200c946626969'], ['quoteIdent', '5ea839ce8ae4809c0a3053a84946210d457afd2d3dd83722e903bb09472f96c4']]) {
    const declarations = functions.filter(node => node.name?.text === name)
    if (declarations.length !== 1 || declarations[0].parent !== tree
      || createHash('sha256').update(declarations[0].getText(tree)).digest('hex') !== expected) problems.push(`flight fixed ${name} grammar`)
  }
  if (named('quoteIdent').length !== 0) problems.push('flight qualifier binding')
  const downs = functions.filter(node => node.name?.text === 'down')
  if (downs.length !== 1 || downs[0].parent !== tree || downs[0].parameters.length !== 1
    || downs[0].parameters[0].name.getText(tree) !== 'db' || downs[0].parameters[0].initializer || downs[0].parameters[0].dotDotDotToken) problems.push('flight down owner')
  const ownerOf = (node: ts.Node): ts.Node | undefined => {
    let current = node.parent
    while (current && !ts.isFunctionLike(current)) current = current.parent
    return current
  }
  const tables = named('table')
  if (tables.length !== 2) problems.push('flight table declarations')
  for (const declaration of tables) {
    const owner = ownerOf(declaration)
    const value = declaration.initializer
    const schemas = named('schema').filter(candidate => ownerOf(candidate) === owner)
    if (!constant(declaration) || !owner || !ts.isFunctionDeclaration(owner) || !['up', 'down'].includes(owner.name?.text ?? '')
      || !value || !ts.isTemplateExpression(value) || value.head.text !== '' || value.templateSpans.length !== 2
      || !ts.isIdentifier(value.templateSpans[0].expression) || value.templateSpans[0].expression.text !== 'schema'
      || value.templateSpans[0].literal.text !== '.' || !ts.isIdentifier(value.templateSpans[1].expression)
      || value.templateSpans[1].expression.text !== 'RELATION' || value.templateSpans[1].literal.text !== '') problems.push('flight qualified table')
    const schema = schemas[0]?.initializer
    if (schemas.length !== 1 || !constant(schemas[0]) || !schema || !ts.isCallExpression(schema)
      || !ts.isIdentifier(schema.expression) || schema.expression.text !== 'quoteIdent' || schema.arguments.length !== 1) problems.push('flight validated schema')
  }
  for (const name of tableNames) {
    const parent = name.parent
    if (ts.isVariableDeclaration(parent) && parent.name === name && tables.includes(parent)) continue
    if (ts.isTemplateSpan(parent) && parent.expression === name && tables.some(declaration => ownerOf(declaration) === ownerOf(name))) continue
    if (ts.isCallExpression(parent) && parent.arguments.length === 1 && parent.arguments[0] === name && parent.expression.getText(tree) === 'sql.raw') continue
    problems.push('flight table alias')
  }
  const scan = scanSource(MIGRATION, source)
  if (scan.writes.length !== 0 || scan.dynamic.length !== 2 || scan.dynamic.some(target => target.form !== 'template_substitution')) problems.push('flight target coverage')
  return problems
}

function productionInitializer(node: ts.Node): boolean {
  let current = node
  while (ts.isCallExpression(current.parent) && current.parent.arguments.length === 1 && current.parent.arguments[0] === current
    && ts.isPropertyAccessExpression(current.parent.expression) && current.parent.expression.expression.getText() === 'Object'
    && current.parent.expression.name.text === 'freeze') current = current.parent
  return ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)
    && current.parent.name.text === 'PRODUCTION' && current.parent.initializer === current
}

function productionEntryProperty(node: ts.Node): boolean {
  const property = node.parent
  if (!ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property)) return false
  if (!ts.isIdentifier(property.name) || property.name.text !== ENTRY || !ts.isObjectLiteralExpression(property.parent)) return false
  if (ts.isPropertyAssignment(property) && (!ts.isIdentifier(property.initializer) || property.initializer.text !== ENTRY)) return false
  let argument: ts.Node = property.parent
  if (ts.isCallExpression(argument.parent) && argument.parent.arguments[0] === argument
    && ts.isPropertyAccessExpression(argument.parent.expression) && argument.parent.expression.expression.getText() === 'Object'
    && argument.parent.expression.name.text === 'freeze') argument = argument.parent
  const call = argument.parent
  return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'createSecurityActionProofService'
    && call.arguments.length === 1 && call.arguments[0] === argument && productionInitializer(call)
}

function grantAttemptImport(parent: ts.ImportDeclaration): boolean {
  const clause = parent.importClause
  const bindings = clause?.namedBindings
  if (!clause || clause.name || !bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== 1) return false
  const element = bindings.elements[0]
  if (element.propertyName) return false
  if (clause.isTypeOnly) return element.name.text === 'AdminGrantOwnedSteps' && !element.isTypeOnly
  return !element.isTypeOnly && element.name.text === ENTRY
}

function grantIssuerEntryReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName && !parent.isTypeOnly) {
    const clause = parent.parent.parent
    return ts.isImportClause(clause) && !clause.isTypeOnly
  }
  if (!ts.isCallExpression(parent) || parent.expression !== node || parent.questionDotToken || parent.arguments.length !== 3) return false
  const [sessionArg, passwordArg, stepsArg] = parent.arguments
  if (!ts.isPropertyAccessExpression(sessionArg) || sessionArg.questionDotToken || !ts.isIdentifier(sessionArg.expression) || sessionArg.expression.text !== 'session' || sessionArg.name.text !== 'sessionId') return false
  if (!ts.isPropertyAccessExpression(passwordArg) || passwordArg.questionDotToken || !ts.isIdentifier(passwordArg.expression) || passwordArg.expression.text !== 'captured' || passwordArg.name.text !== 'password') return false
  if (!ts.isIdentifier(stepsArg) || stepsArg.text !== 'steps') return false
  const awaited = parent.parent
  if (!ts.isAwaitExpression(awaited) || awaited.expression !== parent) return false
  const declaration = awaited.parent
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || declaration.name.text !== 'outcome' || declaration.initializer !== awaited) return false
  const list = declaration.parent
  if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1 || (list.flags & ts.NodeFlags.Const) === 0) return false
  const statement = list.parent
  if (!ts.isVariableStatement(statement)) return false
  const tryBlock = statement.parent
  if (!ts.isBlock(tryBlock)) return false
  const tryStatement = tryBlock.parent
  if (!ts.isTryStatement(tryStatement) || tryStatement.tryBlock !== tryBlock) return false
  const methodBody = tryStatement.parent
  if (!ts.isBlock(methodBody)) return false
  const method = methodBody.parent
  if (!ts.isMethodDeclaration(method) || method.body !== methodBody || !ts.isIdentifier(method.name) || method.name.text !== 'issue') return false
  if (!method.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false
  const literal = method.parent
  if (!ts.isObjectLiteralExpression(literal)) return false
  const freeze = literal.parent
  if (!ts.isCallExpression(freeze) || freeze.arguments.length !== 1 || freeze.arguments[0] !== literal || freeze.questionDotToken) return false
  if (!ts.isPropertyAccessExpression(freeze.expression) || freeze.expression.questionDotToken || freeze.expression.name.text !== 'freeze' || freeze.expression.expression.getText() !== 'Object') return false
  const returned = freeze.parent
  if (!ts.isReturnStatement(returned) || returned.expression !== freeze) return false
  let owner: ts.Node | undefined = returned.parent
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
  return !!owner && ts.isFunctionDeclaration(owner) && owner.name?.text === 'createAdminGrantProofService'
}

function issuerEntryReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName) return true
  if (ts.isTypeQueryNode(parent) || ts.isPropertySignature(parent) && parent.name === node || ts.isMethodSignature(parent) && parent.name === node) return true
  if (productionEntryProperty(node)) return true
  if (ts.isPropertyAccessExpression(parent) && parent.name === node && ts.isIdentifier(parent.expression) && parent.expression.text === 'deps'
    && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
    let owner: ts.Node | undefined = parent.parent.parent
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
    return !!owner && ts.isFunctionDeclaration(owner) && owner.name?.text === 'issue'
  }
  return false
}

function boundaryProblems(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const constantText = constantReader(tree)
  const problems: string[] = []
  let imports = 0
  let grantImports = 0
  let grantEntryRefs = 0
  function latchMetadata(node: ts.Node): boolean {
    if (file !== `${SRC}/rbac/authorization-input-writers.ts`) return false
    let property: ts.Node | undefined = node.parent
    while (property && !ts.isPropertyAssignment(property)) property = property.parent
    if (!property || !ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || !['file', 'reachableTables'].includes(property.name.text)) return false
    const object = property.parent
    if (!ts.isObjectLiteralExpression(object) || object.properties.length !== 6) return false
    const fields = new Map<string, ts.Expression>()
    for (const member of object.properties) {
      if (!ts.isPropertyAssignment(member) || !ts.isIdentifier(member.name)) return false
      fields.set(member.name.text, member.initializer)
    }
    if ([...fields.keys()].sort().join(',') !== 'count,file,form,id,reachableTables,reason') return false
    const tables = fields.get('reachableTables')!
    const count = fields.get('count')!
    if (constantText(fields.get('id')!) !== 'DX-15' || constantText(fields.get('file')!) !== MIGRATION
      || constantText(fields.get('form')!) !== 'template_substitution' || !ts.isNumericLiteral(count) || count.text !== '2'
      || !ts.isArrayLiteralExpression(tables) || tables.elements.length !== 1 || constantText(tables.elements[0]) !== TABLE
      || constantText(fields.get('reason')!) !== 'schema-qualified session latch from same-file table constant') return false
    const call = object.parent
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'exemption'
      || call.arguments.length !== 1 || call.arguments[0] !== object || !ts.isArrayLiteralExpression(call.parent)) return false
    const rows = call.parent.elements.filter(element => ts.isCallExpression(element) && element.arguments.length === 1
      && ts.isObjectLiteralExpression(element.arguments[0]) && element.arguments[0].properties.some(member => ts.isPropertyAssignment(member)
        && ts.isIdentifier(member.name) && member.name.text === 'id' && constantText(member.initializer) === 'DX-15'))
    if (rows.length !== 1) return false
    const freeze = call.parent.parent
    if (!ts.isCallExpression(freeze) || freeze.expression.getText(tree) !== 'Object.freeze'
      || freeze.arguments.length !== 1 || freeze.arguments[0] !== call.parent || !ts.isVariableDeclaration(freeze.parent)) return false
    const declaration = freeze.parent
    return ts.isIdentifier(declaration.name) && declaration.name.text === 'AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS'
      && ts.isVariableDeclarationList(declaration.parent) && !!(declaration.parent.flags & ts.NodeFlags.Const)
  }
  const visit = (node: ts.Node) => {
    const value = constantText(node)
    if (file !== MODULE && value?.includes(STEM)) {
      const parent = node.parent
      if (!ts.isStringLiteral(node) || !ts.isImportDeclaration(parent) || parent.moduleSpecifier !== node) problems.push('non-static attempt reference')
      else if (file === GRANT_ISSUER) {
        grantImports += 1
        if (value !== `./${STEM}` || !grantAttemptImport(parent)) problems.push('grant attempt importer shape')
      } else {
        imports += 1
        const clause = parent.importClause
        const bindings = clause?.namedBindings
        if (file !== ISSUER || value !== `./${STEM}` || !clause || clause.isTypeOnly || clause.name
          || !bindings || !ts.isNamedImports(bindings)
          || bindings.elements.filter(element => !element.isTypeOnly).length !== 1
          || bindings.elements.some(element => !element.isTypeOnly && element.propertyName)
          || !bindings.elements.some(element => !element.isTypeOnly && element.name.text === ENTRY)) problems.push('attempt importer shape')
      }
    }
    if (file !== MODULE && (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && node.text.includes(STEM)) problems.push('interpolated attempt reference')
    if (file === GRANT_ISSUER && ts.isIdentifier(node) && node.text === ENTRY) {
      if (!grantIssuerEntryReference(node)) problems.push('foreign attempt binding')
      else grantEntryRefs += 1
    } else if (file !== MODULE && file !== ISSUER && ts.isIdentifier(node) && node.text === ENTRY) problems.push('foreign attempt binding')
    if (file === ISSUER && ts.isIdentifier(node) && node.text === ENTRY && !issuerEntryReference(node)) problems.push('exposed issuer attempt')
    if (file !== MODULE && ts.isElementAccessExpression(node)
      && node.argumentExpression && constantText(node.argumentExpression) === ENTRY) problems.push('computed foreign attempt binding')
    if (file !== ISSUER && ts.isIdentifier(node) && node.text === 'createSecurityActionProofService') problems.push('foreign proof factory')
    if (file !== ISSUER && ts.isElementAccessExpression(node) && node.argumentExpression
      && constantText(node.argumentExpression) === 'createSecurityActionProofService') problems.push('computed foreign proof factory')
    if (file === ISSUER && ts.isIdentifier(node) && node.text === 'createSecurityActionProofService'
      && !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node)
      && !ts.isTypeQueryNode(node.parent)
      && !(ts.isCallExpression(node.parent) && node.parent.expression === node && productionInitializer(node.parent))) problems.push('exposed issuer factory')
    if (ts.isBindingElement(node) && node.propertyName) {
      const key = ts.isComputedPropertyName(node.propertyName) ? constantText(node.propertyName.expression)
        : ts.isIdentifier(node.propertyName) ? node.propertyName.text : constantText(node.propertyName)
      if (key === ENTRY && file !== MODULE || key === 'createSecurityActionProofService') problems.push('destructured protected member')
    }
    if (value?.toLowerCase().includes(TABLE) && file !== MODULE && file !== MIGRATION && !latchMetadata(node)) problems.push('foreign latch reference')
    if (file === ISSUER && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'bcryptjs') problems.push('issuer comparator import')
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (file === ISSUER && imports !== 1) problems.push('attempt import coverage')
  if (file === GRANT_ISSUER && grantImports !== 2) problems.push('grant attempt import coverage')
  if (file === GRANT_ISSUER && grantEntryRefs !== 2) problems.push('grant attempt entry coverage')
  return problems
}

function moduleProblems(source: string): string[] {
  const tree = ts.createSourceFile(MODULE, source, ts.ScriptTarget.Latest, true)
  const constantText = constantReader(tree)
  const problems: string[] = []
  const bcryptNamespaces = new Set<string>()
  const bcryptFunctions = new Set<string>()
  let exports = 0
  let comparisons = 0
  let comparatorImports = 0
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'bcryptjs') {
      const clause = statement.importClause
      if (clause?.isTypeOnly) continue
      comparatorImports += 1
      if (clause?.name) bcryptNamespaces.add(clause.name.text)
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) bcryptNamespaces.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue
          if ((element.propertyName ?? element.name).text === 'compare') bcryptFunctions.add(element.name.text)
          else problems.push('other comparator import')
        }
      }
    }
    if (ts.isExportAssignment(statement) || ts.isExportDeclaration(statement) && !statement.isTypeOnly
      && (!statement.exportClause || !ts.isNamedExports(statement.exportClause) || statement.exportClause.elements.some(element => !element.isTypeOnly))) problems.push('attempt re-export')
    if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === ENTRY && !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) exports += 1
      else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
        && ts.isIdentifier(statement.declarationList.declarations[0].name) && statement.declarationList.declarations[0].name.text === ENTRY
        && statement.declarationList.declarations[0].initializer && (ts.isArrowFunction(statement.declarationList.declarations[0].initializer) || ts.isFunctionExpression(statement.declarationList.declarations[0].initializer))) exports += 1
      else if (!ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) problems.push('other attempt value export')
    }
  }
  const visit = (node: ts.Node) => {
    if (constantText(node) === 'bcryptjs' && !(ts.isStringLiteral(node) && ts.isImportDeclaration(node.parent) && node.parent.moduleSpecifier === node)) problems.push('alternate comparator loader')
    if (ts.isIdentifier(node) && bcryptNamespaces.has(node.text)) {
      const parent = node.parent
      const declaration = ts.isNamespaceImport(parent) || ts.isImportClause(parent)
      const call = ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'compare'
        && ts.isCallExpression(parent.parent) && parent.parent.expression === parent
      if (!declaration && !call) problems.push('detached comparator namespace')
    }
    if (ts.isIdentifier(node) && bcryptFunctions.has(node.text) && !ts.isImportSpecifier(node.parent)
      && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) problems.push('detached comparator function')
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && bcryptFunctions.has(callee.text)
        || ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && bcryptNamespaces.has(callee.expression.text) && callee.name.text === 'compare') comparisons += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (exports !== 1) problems.push('attempt export coverage')
  if (comparisons !== 1) problems.push('fixed comparison coverage')
  if (comparatorImports !== 1) problems.push('fixed comparator import coverage')
  return problems
}

describe('security action attempt trusted-source boundary', () => {
  const importer = `import { ${ENTRY} } from './${STEM}';`
  const module = `import * as bcrypt from 'bcryptjs'; export async function ${ENTRY}(sessionId, password, steps) { return bcrypt.compare(password, hash); }`

  it('has the exact live importer, latch writer set and fixed comparison module', () => {
    const files = inventoryFiles()
    expect(files).toContain(MODULE)
    expect(files).toContain(MIGRATION)
    expect(files).toContain(ISSUER)
    expect(files.flatMap(file => boundaryProblems(file, fs.readFileSync(path.join(ROOT, file), 'utf8')))).toEqual([])
    expect(moduleProblems(fs.readFileSync(path.join(ROOT, MODULE), 'utf8'))).toEqual([])
    expect(migrationTargetProblems(fs.readFileSync(path.join(ROOT, MIGRATION), 'utf8'))).toEqual([])
  })

  it('admits only the admin grant issuer value import, separate type import, and issue call', () => {
    const source = fs.readFileSync(path.join(ROOT, GRANT_ISSUER), 'utf8')
    const valueImport = `import { ${ENTRY} } from './${STEM}'`
    const typeImport = "import type { AdminGrantOwnedSteps } from './security-action-attempt-admission'"
    const call = `const outcome = await ${ENTRY}(session.sessionId, captured.password, steps)`
    expect(source.split(valueImport)).toHaveLength(2)
    expect(source.split(typeImport)).toHaveLength(2)
    expect(source.split(call)).toHaveLength(2)
    expect(boundaryProblems(GRANT_ISSUER, source)).toEqual([])
    for (const candidate of [
      source.replace(valueImport, `import { ${ENTRY} as other } from './${STEM}'`),
      source.replace(typeImport, ''),
      source.replace(call, `const outcome = await ${ENTRY}(session.sessionId, captured.password, other)`),
      source + `\nconst again = await ${ENTRY}(session.sessionId, captured.password, steps)\n`,
    ]) {
      expect(candidate).not.toBe(source)
      expect(boundaryProblems(GRANT_ISSUER, candidate)).not.toEqual([])
    }
    expect(boundaryProblems(`${SRC}/auth/other-grant-proof.ts`, source)).not.toEqual([])
  })

  it('accepts one decoded unaliased internal import and type-only extra names', () => {
    expect(boundaryProblems(ISSUER, importer)).toEqual([])
    expect(boundaryProblems(ISSUER, importer.replace('attempt-admission', 'attempt-\\u0061dmission'))).toEqual([])
    expect(boundaryProblems(ISSUER, importer.replace(ENTRY, `${ENTRY}, type AttemptSteps`))).toEqual([])
    expect(moduleProblems(module)).toEqual([])
    expect(boundaryProblems(MIGRATION, `const table = '${TABLE}';`)).toEqual([])
  })

  it('rejects foreign, duplicate, aliased, namespace and missing imports', () => {
    expect(boundaryProblems(`${SRC}/other.ts`, importer)).not.toEqual([])
    for (const candidate of ['', importer + importer, importer.replace(ENTRY, `${ENTRY} as other`), importer.replace(`{ ${ENTRY} }`, '* as helpers'), importer.replace(`{ ${ENTRY} }`, ENTRY)]) {
      expect(boundaryProblems(ISSUER, candidate)).not.toEqual([])
    }
  })

  it('rejects loader, re-export, escaped and split module references', () => {
    for (const reference of [
      `export { ${ENTRY} } from './${STEM}';`,
      `const loaded = require('./${STEM}');`,
      `const modulePath = './${STEM}'; const loaded = import(modulePath);`,
      "const loaded = import('./security-action-attempt-' + 'admission');",
      "const loaded = require(`./security-action-attempt-\\u0061dmission${''}`);",
      "const loaded = import(`${''}./security-action-attempt-admission`);",
      `const loader = require; loader('./${STEM}');`,
    ]) expect(boundaryProblems(`${SRC}/other.ts`, reference)).not.toEqual([])
  })

  it('rejects foreign entry, proof-factory and latch access in the recognized syntax', () => {
    for (const reference of [
      `const alias = ${ENTRY};`,
      `const alias = loaded['run' + 'OwnedAttempt'];`,
      'const instance = createSecurityActionProofService(deps);',
      "const instance = loaded['createSecurityAction' + 'ProofService'](deps);",
      `const sql = 'DELETE FROM ${TABLE}';`,
      "const sql = 'TRUNCATE security_action_session_' + 'flight';",
      `const sql = 'DROP TABLE ${TABLE} CASCADE';`,
    ]) expect(boundaryProblems(`${SRC}/other.ts`, reference)).not.toEqual([])
    expect(boundaryProblems(ISSUER, importer + "\nimport * as bcrypt from 'bcryptjs';")).not.toEqual([])
  })

  it('rejects extra value exports and indirect or extra comparison calls', () => {
    for (const candidate of [
      module.replace('export async function', 'async function'),
      module + '\nexport const poolFactory = () => pool;',
      module + `\nexport { ${ENTRY} };`,
      module.replace('bcrypt.compare(password, hash)', 'bcrypt.compare(password, hash); return bcrypt.compare(password, hash)'),
      module.replace('return bcrypt.compare', 'const alias = bcrypt; return alias.compare'),
      module.replace('bcrypt.compare(password, hash)', "bcrypt['compare'](password, hash)"),
    ]) expect(moduleProblems(candidate)).not.toEqual([])
  })

  it('CG-01 exercises the inventory helper independently of unreleased modules', () => {
    const files = inventoryFiles()
    expect(files).toContain(ISSUER)
    expect(files.some(file => file.startsWith('plugins/'))).toBe(true)
  })

  it('CG-02 rejects issuer-local entry and factory value exposures', () => {
    for (const addition of [
      `export { ${ENTRY} };`,
      `export const publicAttempt = ${ENTRY};`,
      `export function expose() { return ${ENTRY}; }`,
      'export const make = createSecurityActionProofService;',
      'export function getFactory() { return createSecurityActionProofService; }',
    ]) expect(boundaryProblems(ISSUER, `${importer}\n${addition}`)).not.toEqual([])
    expect(boundaryProblems(ISSUER, importer + `\nexport function createSecurityActionProofService(deps) {}\nconst PRODUCTION = createSecurityActionProofService(Object.freeze({ ${ENTRY} }));`)).toEqual([])
  })

  it('CG-03 rejects quoted and computed destructuring of protected members', () => {
    for (const reference of [
      "const { 'createSecurityActionProofService': build } = require('./security-action-proof');",
      "const { ['createSecurityAction' + 'ProofService']: build } = loaded;",
      "const { 'runOwnedAttempt': invoke } = loaded;",
      "const { ['run' + 'OwnedAttempt']: invoke } = loaded;",
    ]) expect(boundaryProblems(`${SRC}/other.ts`, reference)).not.toEqual([])
  })

  it('CG-04 rejects an additional comparator through an alternate loader', () => {
    for (const addition of [
      "const extra = await import('bcryptjs'); await extra.compare(password, hash);",
      "const extra = require('bcryptjs'); await extra.compare(password, hash);",
      "const loader = require; const extra = loader('bcryptjs'); await extra.compare(password, hash);",
    ]) expect(moduleProblems(module.replace('return bcrypt.compare', `${addition} return bcrypt.compare`))).not.toEqual([])
    expect(moduleProblems("import extra = require('bcryptjs');\n" + module)).not.toEqual([])
  })

  it('CG-05 resolves scoped same-file const fragments without crossing shadowed bindings', () => {
    for (const reference of [
      "const prefix = './security-action-attempt-'; const loaded = await import(prefix + 'admission');",
      "const first = './security-action-'; const second = 'attempt-'; const loaded = import(first + second + 'admission');",
      "const prefix = 'security_action_session_'; executor.query('DELETE FROM ' + prefix + 'flight');",
      "const first = 'security_action_'; const second = 'session_'; executor.query(`DROP TABLE ${first}${second}flight`);",
    ]) expect(boundaryProblems(`${SRC}/other.ts`, reference)).not.toEqual([])
    expect(boundaryProblems(`${SRC}/other.ts`, "const prefix = './security-action-attempt-'; function load(prefix) { return import(prefix + 'admission'); }")).toEqual([])
    expect(boundaryProblems(`${SRC}/other.ts`, "const prefix = './security-action-attempt-'; { const prefix = './unrelated-'; const loaded = import(prefix + 'admission'); }")).toEqual([])
    expect(() => boundaryProblems(`${SRC}/other.ts`, "const first = second; const second = first; const loaded = import(first + 'admission');")).not.toThrow()
  })

  it('CG-06 permits an erased type-only alias without permitting a value alias', () => {
    expect(boundaryProblems(ISSUER, importer.replace(ENTRY, `${ENTRY}, type AttemptSteps as Steps`))).toEqual([])
    expect(boundaryProblems(ISSUER, importer.replace(ENTRY, `${ENTRY} as other`))).not.toEqual([])
  })

  it('CG-04b rejects an extra named synchronous comparison while retaining the fixed async call', () => {
    expect(moduleProblems(module.replace('import * as bcrypt', 'import bcrypt'))).toEqual([])
    const named = module.replace("import * as bcrypt from 'bcryptjs'", "import { compare } from 'bcryptjs'").replace('bcrypt.compare', 'compare')
    expect(moduleProblems(named)).toEqual([])
    expect(moduleProblems(named.replace('{ compare }', '{ compare, type CompareCallback as Callback }'))).toEqual([])
    expect(moduleProblems(named.replace('{ compare }', '{ compare, compareSync }').replace('return compare', 'compareSync(password, hash); return compare'))).not.toEqual([])
  })

  it('distinguishes the exact session-latch migration exemption from executable table references', () => {
    const file = `${SRC}/rbac/authorization-input-writers.ts`
    const metadata = `const SRC = 'packages/core-backend/src'; export const AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS = Object.freeze([exemption({ id: 'DX-15', file: \`\${SRC}/db/migrations/zzzz20261117120100_create_security_action_session_flight.ts\`, form: 'template_substitution', count: 2, reachableTables: ['${TABLE}'], reason: 'schema-qualified session latch from same-file table constant' })]);`
    const item = metadata.slice(metadata.indexOf('exemption('), metadata.lastIndexOf('])'))
    expect(boundaryProblems(file, metadata)).toEqual([])
    for (const candidate of [
      metadata.replace('count: 2', 'count: 3'),
      metadata.replace("'template_substitution'", "'concatenation'"),
      metadata.replace(`['${TABLE}']`, `['${TABLE}', 'users']`),
      metadata.replace('AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS', 'other'),
      metadata.replace(']);', `,${item}]);`),
      metadata + ` query('DELETE FROM ${TABLE}');`,
      metadata + ` const table = '${TABLE}';`,
    ]) expect(boundaryProblems(file, candidate)).not.toEqual([])
    expect(boundaryProblems(`${SRC}/routes/other.ts`, metadata)).not.toEqual([])
  })

  it('rejects same-count migration retargeting and schema or table aliases', () => {
    const source = fs.readFileSync(path.join(ROOT, MIGRATION), 'utf8')
    expect(migrationTargetProblems(source)).toEqual([])
    expect(migrationTargetProblems(source + '\n/* outside fixed helper */\n')).toEqual([])
    for (const candidate of [
      source.replace(`const RELATION = '${TABLE}'`, "const RELATION = 'users'"),
      source.replace('INSERT INTO ${table}', 'INSERT INTO ${other}'),
      source.replace('DELETE FROM ${table}', 'DELETE FROM ${other}'),
      source.replace('const table = `${schema}.${RELATION}`', "const table = 'users'"),
      source.replace('const schema = quoteIdent(await currentSchema(db))', "const schema = 'unvalidated'"),
      source.replace('return `"${ident}"`', 'return ident'),
      source.replace('export async function up', "IDENT.compile('.*'); export async function up"),
      source.replace('const IDENT = /^[a-z_][a-z0-9_]*$/', 'const IDENT = /^.*$/'),
      source.replace('INSERT INTO ${table}', 'INSERT INTO ${schema}.users'),
    ]) {
      expect(candidate).not.toBe(source)
      expect(migrationTargetProblems(candidate)).not.toEqual([])
    }
  })

  it.each([
    ['parameter shadow', (source: string) => source.replace('up(db: Kysely<unknown>)', "up(db: Kysely<unknown>, RELATION = 'users')")],
    ['destructured parameter shadow', (source: string) => source.replace('up(db: Kysely<unknown>)', "up(db: Kysely<unknown>, { RELATION } = { RELATION: 'users' })")],
    ['local qualifier shadow', (source: string) => source.replace('  const schema = quoteIdent(await currentSchema(db))', "  const quoteIdent = (_ident: string) => 'unvalidated'\n  const schema = quoteIdent(await currentSchema(db))")],
    ['local qualifier function shadow', (source: string) => source.replace('  const schema = quoteIdent(await currentSchema(db))', "  function quoteIdent(_ident: string) { return 'unvalidated' }\n  const schema = quoteIdent(await currentSchema(db))")],
    ['literal target suffix', (source: string) => source.replace('DELETE FROM ${table}', 'DELETE FROM ${table}_archive')],
    ['adjacent target interpolation', (source: string) => source.replace('DELETE FROM ${table}', 'DELETE FROM ${table}${suffix}')],
    ['block comment decoy', (source: string) => source.replace(/INSERT INTO \$\{table\} \(session_id, owner_token, state\)[\s\S]+?VALUES \(p_session_id, p_owner_token, 'active'\);/, matched => `/* ${matched} */`)],
    ['quoted string decoy', (source: string) => source.replace(/INSERT INTO \$\{table\} \(session_id, owner_token, state\)[\s\S]+?VALUES \(p_session_id, p_owner_token, 'active'\);/, "PERFORM 'INSERT INTO ${table}';")],
  ] as const)('rejects reported finite migration bypass: %s', (_label, mutate) => {
    const source = fs.readFileSync(path.join(ROOT, MIGRATION), 'utf8')
    expect(migrationTargetProblems(source)).toEqual([])
    const candidate = mutate(source)
    expect(candidate).not.toBe(source)
    expect(migrationTargetProblems(candidate)).not.toEqual([])
  })
})
