/**
 * Closed-world guard over writers of the privilege-classifier inputs and their cascade parents.
 *
 * The scan reads the syntax tree of every production source and plugin file and matches write
 * statements only in string and template literals; its per-file, per-table, per-verb counts must
 * equal the writer registry, and every dynamic write target must be a registered exemption whose
 * reachable tables exclude the inputs. Migrations that write an input are frozen by path; a new one
 * must carry the bounded try form of the world lock and every one of its writes must be judged
 * safe (the cases of that judgment are in `authorization-input-migration-rules.guard.test.ts`). Script
 * trees are classified by path. The guard also pins: the two table allowlists of the generic bulk
 * routes item for item; that no production module imports a contract module; that no production
 * call joins a contract transaction; that the world-lock key appears only in its three statement
 * forms and its two declarations; the function-level conversion ratchet; the table list closure
 * between the classifier's statement and its table constant; the birth-only shape of the one
 * user insert that stays outside the contract; the closed set of callers that take a role row late;
 * and the identifiers a work closure may not reference, which include the pull-source organisation
 * lock and the functions of its write gate. Three reviewed ports may pass one transaction runner:
 * ceremony runRoot, owned-attempt runOwnedAttempt.runAis, and strict issueOnRoot.
 *
 * The table list closure has one exception, and only one: the service reader left-joins `roles` to
 * show the name of each role a permission is inherited from. The exception is pinned by shape
 * (`ROLE_NAME_JOIN`): one mention in the literals of that reader, the mention is that join clause, its
 * alias is read only as the selected name, and the literal is the pinned statement. It is pinned by
 * place too (`ROLE_NAME_STATEMENT_SITE`): the literal is itself the first argument of a call of the
 * local executor, directly in the one function; the executor is declared once, as pinned text, and is
 * used only as the callee of such calls; and no other literal of the file carries the alias followed
 * by a dot (`r.` or `"r".`). So the text handed to the executor is the pinned statement, not a longer,
 * edited or second-hand one. The word as a whole literal is a permission resource name, pinned by
 * count and by place: none in the service reader, one in the namespace reader, and that one an
 * element of its list of resources that have no namespace.
 *
 * These reader rules are checked on the literals and the syntax of the two reader files only. SQL
 * that code produces at run time is outside the guard.
 *
 * Every pattern has a positive control on a real file mutated in memory, and every negative control
 * states what the scan deliberately does not count.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { importEdgeViolations } from '../helpers/import-edge-allowlist'
import { PRIVILEGE_GRANT_SOURCE_TABLES } from '../../src/auth/security-action-privilege'
import {
  AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS,
  AUTHORIZATION_INPUT_FROZEN_MIGRATIONS,
  AUTHORIZATION_INPUT_LATE_ROLE_ROW_CALLERS,
  AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE,
  AUTHORIZATION_INPUT_MIGRATION_LOCK_BLOCK_MARKS,
  AUTHORIZATION_INPUT_MIGRATION_LOCK_FORM,
  AUTHORIZATION_INPUT_SCRIPT_CLASSES,
  AUTHORIZATION_INPUT_SCRIPT_DYNAMIC_EXEMPTIONS,
  AUTHORIZATION_INPUT_TABLE_ALLOWLIST_RATCHET,
  AUTHORIZATION_INPUT_WORKFLOW_FIXTURES,
  AUTHORIZATION_INPUT_WRITERS,
  hasPendingWriters,
  registeredWriteCounts,
} from '../../src/rbac/authorization-input-writers'
import type { AuthorizationInputDynamicExemption, AuthorizationInputLateRoleRowCaller, AuthorizationInputWriterEntry } from '../../src/rbac/authorization-input-writers'
import { AUTHORIZATION_INPUT_TAKEOVER_CALLERS, AUTHORIZATION_INPUT_WORLD_LOCK_KEY1 } from '../../src/rbac/authorization-input-lock'
import { judgeMigrationInputWrites } from '../helpers/authorization-input-migration-judge'
import {
  AUTHORIZATION_INPUT_PINNED_STATEMENT_SETS,
  checkNewMigration,
  COMPLIANT_LOCK_BLOCK,
  exemptDynamicForms,
  isMigrationPath,
  JUDGED_ONLY_DYNAMIC_FORMS,
  judgedOnlyExemptionProblems,
  migrationRuleProblems,
  reachableTableProblems,
  traversalProblems,
} from '../helpers/authorization-input-migration-rules'
import {
  CASCADE_PARENT_TABLES,
  blankSqlComments,
  enclosingFunctionAt,
  INPUT_TABLES,
  isTestPath,
  listFiles,
  literalTexts,
  queryReceiverAt,
  scanFiles,
  scanSource,
  SCANNED_DYNAMIC_FORMS,
  SCANNED_TABLES,
  SOURCE_EXTENSIONS,
  tally,
} from '../helpers/authorization-input-scan'
import type { DynamicTarget, LiteralWrite } from '../helpers/authorization-input-scan'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SRC = 'packages/core-backend/src'
const CONTRACT_MODULES = ['brand', 'classes', 'lock', 'writers', 'consumers'].map((name) => `${SRC}/rbac/authorization-input-${name}.ts`)
const LOCK_MODULE = `${SRC}/rbac/authorization-input-lock.ts`
const KEY_REGISTRY_MODULE = `${SRC}/attendance/coordination/settlement-coordination-key.ts`
const CLASSIFIER_MODULE = `${SRC}/auth/security-action-privilege.ts`
const CONTROL_FILE = `${SRC}/routes/attendance-admin.ts`
const CONTROL_NEEDLE = 'const ATTENDANCE_ROLE_ID_BOUND'

const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')

const PRODUCTION = { roots: [SRC, 'plugins'], exclude: [`${SRC}/db/migrations`] }
const MIGRATIONS = { roots: [`${SRC}/db/migrations`, 'packages/core-backend/migrations'], exclude: [] }
const SCRIPTS = { roots: ['packages/core-backend/scripts', 'scripts'], exclude: [] }
const WORKFLOWS = { roots: ['.github/workflows'], exclude: [] }
const ALL_ROOTS = { roots: [SRC, 'plugins', 'packages/core-backend/scripts', 'scripts', 'packages/core-backend/migrations', '.github/workflows'], exclude: [] }

const productionFiles = listFiles(REPO_ROOT, PRODUCTION)
const production = scanFiles(REPO_ROOT, productionFiles.filter((file) => !CONTRACT_MODULES.includes(file)))
const contractScan = scanFiles(REPO_ROOT, CONTRACT_MODULES)
const migrations = scanFiles(REPO_ROOT, listFiles(REPO_ROOT, MIGRATIONS))
const scripts = scanFiles(REPO_ROOT, listFiles(REPO_ROOT, SCRIPTS))
const workflows = scanFiles(REPO_ROOT, listFiles(REPO_ROOT, WORKFLOWS))

function byFileAndForm(targets: readonly DynamicTarget[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const target of targets) counts.set(`${target.file}|${target.form}`, (counts.get(`${target.file}|${target.form}`) ?? 0) + 1)
  return counts
}

function sortedEntries(map: ReadonlyMap<string, number>): Array<[string, number]> {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

describe('domain floor', () => {
  it('the scan reads the real trees and the files the registry names', () => {
    expect(productionFiles.length).toBeGreaterThan(900)
    expect(productionFiles.some((file) => file.startsWith('plugins/'))).toBe(true)
    expect(productionFiles).toContain('plugins/plugin-attendance/index.cjs')
    for (const required of [`${SRC}/rbac/role-assignment.ts`, `${SRC}/routes/roles.ts`, `${SRC}/routes/permissions.ts`, `${SRC}/routes/admin-users.ts`, `${SRC}/routes/admin-routes.ts`, ...CONTRACT_MODULES]) {
      expect(productionFiles).toContain(required)
    }
    for (const writer of AUTHORIZATION_INPUT_WRITERS) expect(fs.existsSync(path.join(REPO_ROOT, writer.file)), writer.file).toBe(true)
    expect(migrations.files.length).toBeGreaterThan(400)
    expect(scripts.files.length).toBeGreaterThan(300)
    expect(workflows.files.length).toBeGreaterThan(50)
    expect(productionFiles.some(isTestPath)).toBe(false)
  })

  it('the scanned table set is the classifier\'s table constant plus the four cascade parents', () => {
    expect([...INPUT_TABLES]).toEqual([...PRIVILEGE_GRANT_SOURCE_TABLES])
    expect([...CASCADE_PARENT_TABLES].sort()).toEqual(['directory_departments', 'permissions', 'platform_member_groups', 'roles'])
    expect(SCANNED_TABLES.size).toBe(12)
  })
})

const DYNAMIC_BROWSER = `${SRC}/auth/admin-grant-browser-context.ts`
const DYNAMIC_CREDENTIAL = `${SRC}/auth/admin-grant-local-credential.ts`
const DYNAMIC_STORE = `${SRC}/auth/strict-login-grant-store.ts`
const DYNAMIC_BUNDLE = `${SRC}/auth/strict-login-grant-bundle.ts`
const DYNAMIC_SCOPE = `${SRC}/db/migrations/zzzz20261118120000_strict_login_grant_scope.ts`
const DYNAMIC_SCOPE_SPECIFIER = '../db/migrations/zzzz20261118120000_strict_login_grant_scope'
const BROWSER_QUALIFY = [
  'function qualify(schema: string, relation: string): string {',
  "  if (!IDENT.test(schema) || !IDENT.test(relation)) throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_UNAVAILABLE')",
  '  return `"${schema}"."${relation}"`',
  '}',
].join('\n')
const CREDENTIAL_QUALIFY = [
  'function qualify(schema: string, relation: string): string {',
  '  if (!IDENT.test(schema) || !IDENT.test(relation)) {',
  "    throw new AdminGrantActorInputError('ADMIN_GRANT_CREDENTIAL_UNAVAILABLE')",
  '  }',
  '  return `"${schema}"."${relation}"`',
  '}',
].join('\n')
const STORE_QUOTE_IDENT = [
  'function quoteIdent(identifier: string): string {',
  "  if (!IDENTIFIER.test(identifier)) refuse('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED')",
  '  return `"${identifier}"`',
  '}',
].join('\n')
const STORE_QUALIFIED = [
  'function qualified(schemaName: string, identifier: string): string {',
  '  return `${quoteIdent(schemaName)}.${quoteIdent(identifier)}`',
  '}',
].join('\n')
const STORE_TARGET_CONSTANT_NAMES = ['STRICT_LOGIN_GRANT_SCOPE_TABLE', 'STRICT_LOGIN_GRANT_GRANT_TABLE']
const BUNDLE_TARGET_CONSTANT_NAMES = ['STRICT_LOGIN_GRANT_GRANT_TABLE', 'STRICT_LOGIN_GRANT_RECEIPT_TABLE']
const USERS_CREDENTIAL_UPDATE = [
  'UPDATE ${users}',
  '   SET password_hash = $1,',
  '       must_change_password = FALSE,',
  '       local_password_set = TRUE,',
  '       updated_at = pg_catalog.clock_timestamp()',
  ' WHERE id = $2',
  '   AND must_change_password IS TRUE',
  'RETURNING local_credential_version::text AS local_credential_version',
].join('\n')
const BROWSER_TABLES = ['security_action_browser_bindings', 'user_session_revocations']
const CREDENTIAL_TABLES = ['user_local_credential_establishments', 'user_session_revocations']
const STORE_TABLES = ['directory_connection_login_scope', 'user_external_identity_evidence', 'user_external_identity_login_grants', 'user_session_revocations', 'user_sessions']
const BUNDLE_TABLES = ['admin_login_grant_command_receipts', 'user_external_identity_login_grants']
const CREDENTIAL_WRITE_TABLES = ['user_local_credential_establishments', 'user_session_revocations', 'user_session_revocations']
const STORE_WRITE_TABLES = ['directory_connection_login_scope', 'user_external_identity_evidence', 'user_external_identity_login_grants', 'user_session_revocations', 'user_session_revocations', 'user_sessions']

function dynamicClosedShapeProblems(overrides: Record<string, string> = {}): string[] {
  const problems: string[] = []
  const sourceOf = (file: string) => overrides[file] ?? read(file)
  const plainTable = (table: string) => {
    const parts = table.split('.').map((piece) => piece.trim().replace(/^"|"$/g, '')).filter((piece) => piece.length > 0)
    return (parts[parts.length - 1] ?? '').toLowerCase()
  }
  const sameTables = (left: readonly string[], right: readonly string[]) => [...left].sort().join('|') === [...right].sort().join('|')
  const parse = (file: string) => ts.createSourceFile(file, sourceOf(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const topFunction = (tree: ts.SourceFile, name: string) => tree.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)
  const nameBindings = (tree: ts.SourceFile, name: string): ts.Node[] => {
    const found: ts.Node[] = []
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node.name)
      else if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isEnumDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === name) found.push(node.name)
      else if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === name) found.push(node.name)
      else if (ts.isImportSpecifier(node) && node.name.text === name) found.push(node.name)
      else if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name) && node.variableDeclaration.name.text === name) found.push(node.variableDeclaration.name)
      ts.forEachChild(node, visit)
    }
    visit(tree)
    return found
  }
  const pinHelper = (tree: ts.SourceFile, name: string, text: string): boolean => {
    const declarations = topFunction(tree, name)
    const declaration = declarations[0]
    const nodes = nameBindings(tree, name)
    const trusted = declarations.length === 1 && !!declaration && declaration.getText(tree) === text && nodes.length === 1 && nodes[0] === declaration.name
    if (!trusted) problems.push(`${name} qualifier shape`)
    return trusted
  }
  const helperReferences = (tree: ts.SourceFile, names: readonly string[], allowedReferences: readonly ts.Node[] = []) => {
    const allowed = new Set(names)
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && allowed.has(node.text)) {
        const declared = ts.isFunctionDeclaration(node.parent) && node.parent.name === node
        const called = ts.isCallExpression(node.parent) && node.parent.expression === node && !node.parent.questionDotToken
        if (!declared && !called && !allowedReferences.includes(node)) problems.push(`${node.text} helper reference`)
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  const scopeOf = (tree: ts.SourceFile, node: ts.Node | undefined): ts.Node => {
    let current = node
    while (current) {
      if (ts.isSourceFile(current) || ts.isFunctionLike(current) || ts.isBlock(current) || ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)) return current
      current = current.parent
    }
    return tree
  }
  const constBindings = (tree: ts.SourceFile) => {
    const bindings = new Map<ts.Node, Map<string, ts.Expression | undefined>>()
    const slot = (owner: ts.Node) => {
      let names = bindings.get(owner)
      if (!names) bindings.set(owner, names = new Map())
      return names
    }
    const bindConst = (owner: ts.Node, name: string, value?: ts.Expression) => {
      const names = slot(owner)
      names.set(name, names.has(name) ? undefined : value)
    }
    const blockName = (owner: ts.Node, name: ts.BindingName) => {
      if (ts.isIdentifier(name)) {
        slot(owner).set(name.text, undefined)
        return
      }
      for (const element of name.elements) if (ts.isBindingElement(element)) blockName(owner, element.name)
    }
    const varOwner = (node: ts.Node) => {
      let current: ts.Node | undefined = node
      while (current) {
        if (ts.isSourceFile(current) || ts.isFunctionLike(current)) return current
        current = current.parent
      }
      return tree
    }
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
        const list = node.parent
        const isConst = (list.flags & ts.NodeFlags.Const) !== 0
        const owner = isConst || (list.flags & ts.NodeFlags.Let) !== 0 ? scopeOf(tree, list) : varOwner(list)
        if (isConst && ts.isIdentifier(node.name)) bindConst(owner, node.name.text, node.initializer)
        else blockName(owner, node.name)
      } else if (ts.isParameter(node) && ts.isFunctionLike(node.parent)) blockName(node.parent, node.name)
      else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) blockName(scopeOf(tree, node.parent), node.name)
      else if (ts.isCatchClause(node) && node.variableDeclaration) blockName(node.block, node.variableDeclaration.name)
      ts.forEachChild(node, collect)
    }
    collect(tree)
    return bindings
  }
  const migrationValues = (tree: ts.SourceFile) => {
    const values = new Map<string, string>()
    for (const statement of tree.statements) {
      if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteral(declaration.initializer)) values.set(declaration.name.text, declaration.initializer.text)
      }
    }
    return values
  }
  const importedValues = (tree: ts.SourceFile, values: ReadonlyMap<string, string>) => {
    const imported = new Map<string, string>()
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== DYNAMIC_SCOPE_SPECIFIER) continue
      const clause = statement.importClause
      const bindings = clause?.namedBindings
      if (!clause || clause.isTypeOnly || clause.name || !bindings || !ts.isNamedImports(bindings)) continue
      for (const element of bindings.elements) {
        if (element.isTypeOnly || element.propertyName) continue
        const value = values.get(element.name.text)
        if (value !== undefined) imported.set(element.name.text, value)
      }
    }
    return imported
  }
  const resolveTable = (expression: ts.Expression | undefined, tree: ts.SourceFile, bindings: ReadonlyMap<ts.Node, ReadonlyMap<string, ts.Expression | undefined>>, imported: ReadonlyMap<string, string>, qualifier: string, schemaName: string, trustQualifier: boolean) => {
    const seen = new Set<ts.Node>()
    const readExpression = (node: ts.Expression | undefined): string | undefined => {
      if (!node || seen.has(node)) return undefined
      seen.add(node)
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return readExpression(node.expression)
      if (ts.isCallExpression(node)) {
        if (!trustQualifier || node.questionDotToken || node.arguments.length !== 2 || !ts.isIdentifier(node.expression) || node.expression.text !== qualifier) return undefined
        const schema = node.arguments[0]
        if (!ts.isIdentifier(schema) || schema.text !== schemaName) return undefined
        return readExpression(node.arguments[1])
      }
      if (ts.isStringLiteral(node)) return node.text
      if (!ts.isIdentifier(node)) return undefined
      let owner = scopeOf(tree, node.parent)
      while (true) {
        const names = bindings.get(owner)
        if (names?.has(node.text)) {
          const initializer = names.get(node.text)
          return initializer ? readExpression(initializer) : undefined
        }
        if (owner === tree) return imported.get(node.text)
        owner = scopeOf(tree, owner.parent)
      }
    }
    return readExpression(expression)
  }
  const writeTargets = (tree: ts.SourceFile, bindings: ReadonlyMap<ts.Node, ReadonlyMap<string, ts.Expression | undefined>>, imported: ReadonlyMap<string, string>, qualifier: string, schemaName: string, trustQualifier: boolean) => {
    const writes: Array<{ table: string; text: string }> = []
    let unresolved = 0
    const visit = (node: ts.Node) => {
      if (ts.isTemplateExpression(node) && /^(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|COPY)\s+$/i.test(node.head.text)) {
        const table = resolveTable(node.templateSpans[0]?.expression, tree, bindings, imported, qualifier, schemaName, trustQualifier)
        if (table === undefined) unresolved += 1
        else writes.push({ table, text: node.getText(tree) })
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
    return { writes, unresolved }
  }
  const browserTree = parse(DYNAMIC_BROWSER)
  const credentialTree = parse(DYNAMIC_CREDENTIAL)
  const storeTree = parse(DYNAMIC_STORE)
  const bundleTree = parse(DYNAMIC_BUNDLE)
  const scopeTree = parse(DYNAMIC_SCOPE)
  const trustBrowserQualify = pinHelper(browserTree, 'qualify', BROWSER_QUALIFY)
  const trustCredentialQualify = pinHelper(credentialTree, 'qualify', CREDENTIAL_QUALIFY)
  const trustQualified = pinHelper(storeTree, 'qualified', STORE_QUALIFIED)
  pinHelper(storeTree, 'quoteIdent', STORE_QUOTE_IDENT)
  const qualifierExports = storeTree.statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)
      ? statement.exportClause.elements.filter((element) => !element.isTypeOnly && element.propertyName?.text === 'qualified' && element.name.text === 'strictLoginGrantQualified') : [])
  const qualifierImports = bundleTree.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== './strict-login-grant-store') return []
    const clause = statement.importClause
    return clause && !clause.isTypeOnly && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      ? clause.namedBindings.elements.filter((element) => !element.isTypeOnly && element.propertyName?.text === 'strictLoginGrantQualified' && element.name.text === 'qualified') : []
  })
  const qualifierBindings = nameBindings(bundleTree, 'qualified')
  const trustBundleQualified = trustQualified && qualifierExports.length === 1 && qualifierImports.length === 1
    && qualifierBindings.length === 1 && qualifierBindings[0] === qualifierImports[0]?.name
  if (!trustBundleQualified) problems.push('bundle qualifier binding')
  helperReferences(browserTree, ['qualify'])
  helperReferences(credentialTree, ['qualify'])
  helperReferences(storeTree, ['quoteIdent', 'qualified'], qualifierExports.map((element) => element.propertyName!))
  helperReferences(bundleTree, ['qualified'], qualifierImports.map((element) => element.name))
  const bundleExports = bundleTree.statements.filter((statement) => ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)
    || (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)))
  if (bundleExports.length !== 1 || !ts.isFunctionDeclaration(bundleExports[0]) || bundleExports[0].name?.text !== 'insertConsumedGrantBundle') problems.push('bundle public write entry')
  const storeImports = importedValues(storeTree, migrationValues(scopeTree))
  const bundleImports = importedValues(bundleTree, migrationValues(scopeTree))
  for (const [tree, names, imported] of [[storeTree, STORE_TARGET_CONSTANT_NAMES, storeImports], [bundleTree, BUNDLE_TARGET_CONSTANT_NAMES, bundleImports]] as const) {
    for (const name of names) {
      const nodes = nameBindings(tree, name)
      if (nodes.length !== 1 || !ts.isImportSpecifier(nodes[0]?.parent) || !imported.has(name)) {
        problems.push('shadowed target binding')
        imported.delete(name)
      }
    }
  }
  const browser = writeTargets(browserTree, constBindings(browserTree), new Map(), 'qualify', 'schema', trustBrowserQualify)
  const credential = writeTargets(credentialTree, constBindings(credentialTree), new Map(), 'qualify', 'schema', trustCredentialQualify)
  const store = writeTargets(storeTree, constBindings(storeTree), storeImports, 'qualified', 'schemaName', trustQualified)
  const bundle = writeTargets(bundleTree, constBindings(bundleTree), bundleImports, 'qualified', 'schemaName', trustBundleQualified)
  if (browser.unresolved !== 0 || credential.unresolved !== 0 || store.unresolved !== 0 || bundle.unresolved !== 0) problems.push('unresolved dynamic target')
  const usersWrites = credential.writes.filter((write) => plainTable(write.table) === 'users')
  const credentialWrites = credential.writes.filter((write) => plainTable(write.table) !== 'users').map((write) => write.table)
  if (browser.writes.length !== 2 || !sameTables(browser.writes.map((write) => write.table), BROWSER_TABLES) || browser.writes.some((write) => plainTable(write.table) === 'users')) problems.push('browser dynamic target shape')
  if (credential.writes.length !== 4 || usersWrites.length !== 1 || usersWrites[0]?.text !== `\`${USERS_CREDENTIAL_UPDATE}\`` || !sameTables(credentialWrites, CREDENTIAL_WRITE_TABLES)) problems.push('credential dynamic target shape')
  if (store.writes.length !== 6 || !sameTables(store.writes.map((write) => write.table), STORE_WRITE_TABLES) || store.writes.some((write) => plainTable(write.table) === 'users')) problems.push('store dynamic target shape')
  if (bundle.writes.length !== 2 || !sameTables(bundle.writes.map((write) => write.table), BUNDLE_TABLES)) problems.push('bundle dynamic target shape')
  const exemptionShape = (id: string, file: string, count: number, tables: readonly string[]) => {
    const rows = AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS.filter((exemption) => exemption.id === id)
    const row = rows[0]
    if (rows.length !== 1 || !row || row.file !== file || row.form !== 'template_substitution' || row.count !== count || row.reason.trim().length === 0
      || !sameTables(row.reachableTables, tables) || row.reachableTables.some((table) => plainTable(table) === 'users')) problems.push(`${id} registry shape`)
  }
  exemptionShape('DX-16', DYNAMIC_BROWSER, 2, BROWSER_TABLES)
  exemptionShape('DX-17', DYNAMIC_STORE, 6, STORE_TABLES)
  exemptionShape('DX-18', DYNAMIC_CREDENTIAL, 3, CREDENTIAL_TABLES)
  exemptionShape('DX-19', DYNAMIC_BUNDLE, 2, BUNDLE_TABLES)
  const writers = AUTHORIZATION_INPUT_WRITERS.filter((writer) => writer.id === 'D-01')
  const writer = writers[0]
  if (writers.length !== 1 || !writer || writer.file !== DYNAMIC_CREDENTIAL || writer.symbol !== 'adminGrantCredentialStatements' || writer.intent !== null
    || writer.class !== 'D' || writer.statements.length !== 0 || writer.actor !== 'human' || writer.status !== 'pending' || writer.slice !== 'none'
    || writer.dynamic?.form !== 'template_substitution' || writer.dynamic?.count !== 1) problems.push('D-01 registry shape')
  return problems
}

describe('production writers equal the registry', () => {
  it('per file, table and verb, the literal write counts equal the registered counts', () => {
    const scanned = sortedEntries(tally(production.writes))
    const registered = sortedEntries(registeredWriteCounts())
    expect(scanned).toEqual(registered)
    expect(scanned.length).toBeGreaterThan(40)
  })

  it('the contract modules issue exactly one write: the birth insert of the lock module', () => {
    expect(contractScan.writes.map((write) => [write.file, write.table, write.verb])).toEqual([[LOCK_MODULE, 'users', 'INSERT']])
    expect(contractScan.dynamic).toEqual([])
  })

  it('every registered symbol is still present in its file', () => {
    for (const writer of AUTHORIZATION_INPUT_WRITERS) {
      const source = read(writer.file)
      const callee = writer.symbol.startsWith('callback:') ? writer.symbol.slice('callback:'.length) : writer.symbol
      expect(source, `${writer.id} ${writer.symbol}`).toContain(`${callee}(`)
    }
  })

  it('every dynamic target is a registered exemption or the pinned allowlist route, and no exemption reaches an input', () => {
    const expected = new Map<string, number>()
    for (const exemption of AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS.filter((e) => !e.file.includes('/db/migrations/'))) expected.set(`${exemption.file}|${exemption.form}`, exemption.count)
    for (const writer of AUTHORIZATION_INPUT_WRITERS) {
      if (!writer.dynamic) continue
      const key = `${writer.file}|${writer.dynamic.form}`
      expected.set(key, (expected.get(key) ?? 0) + writer.dynamic.count)
    }
    expect(sortedEntries(byFileAndForm(production.dynamic))).toEqual(sortedEntries(expected))
    const registered = [...AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS, ...AUTHORIZATION_INPUT_SCRIPT_DYNAMIC_EXEMPTIONS]
    expect(reachableTableProblems(registered, AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE)).toEqual([])
    for (const exemption of registered) {
      expect(exemption.reachableTables.length, exemption.id).toBeGreaterThan(0)
      expect(exemption.reason.length).toBeGreaterThan(0)
    }
  })

  it('pins the browser, credential and strict-store dynamic targets, including the users column shape', () => {
    const browser = read(DYNAMIC_BROWSER)
    const credential = read(DYNAMIC_CREDENTIAL)
    const store = read(DYNAMIC_STORE)
    const scope = read(DYNAMIC_SCOPE)
    const bindings = "const bindings = qualify(schema, 'security_action_browser_bindings')"
    const scopeTable = "export const STRICT_LOGIN_GRANT_SCOPE_TABLE = 'directory_connection_login_scope'"
    const qualifyReturn = '  return `"${schema}"."${relation}"`'
    const qualifiedHead = 'function qualified(schemaName: string, identifier: string): string {'
    const nestedAliasOpen = '  return Object.freeze({\n    lockUser:'
    const nestedAliasClose = '  })\n}\n\nconst defaultTransaction: AdminGrantTransactionRunner'
    expect(browser.split(bindings)).toHaveLength(2)
    expect(browser.split(qualifyReturn)).toHaveLength(2)
    expect(browser.split(nestedAliasOpen)).toHaveLength(2)
    expect(browser.split(nestedAliasClose)).toHaveLength(2)
    expect(credential.split('password_hash = $1')).toHaveLength(2)
    expect(scope.split(scopeTable)).toHaveLength(2)
    expect(store.split(qualifiedHead)).toHaveLength(2)
    expect(dynamicClosedShapeProblems()).toEqual([])
    expect(dynamicClosedShapeProblems({ [DYNAMIC_CREDENTIAL]: credential.replace('password_hash = $1', 'role = $1') })).not.toEqual([])
    expect(dynamicClosedShapeProblems({ [DYNAMIC_BROWSER]: browser.replace(bindings, "const bindings = qualify(schema, 'users')") })).not.toEqual([])
    expect(dynamicClosedShapeProblems({ [DYNAMIC_SCOPE]: scope.replace(scopeTable, "export const STRICT_LOGIN_GRANT_SCOPE_TABLE = 'users'") })).not.toEqual([])
    expect(dynamicClosedShapeProblems({ [DYNAMIC_BROWSER]: browser.replace(bindings, "const qualify = (_schema: string, _relation: string) => 'users'\n  " + bindings) })).not.toEqual([])
    expect(dynamicClosedShapeProblems({ [DYNAMIC_BROWSER]: browser.replace(bindings, "qualify = (_schema, _relation) => 'users'\n  " + bindings) })).not.toEqual([])
    expect(dynamicClosedShapeProblems({ [DYNAMIC_BROWSER]: browser.replace(nestedAliasOpen, "  {\n    let bindings = 'users'\n    return Object.freeze({\n    lockUser:").replace(nestedAliasClose, '  })\n  }\n}\n\nconst defaultTransaction: AdminGrantTransactionRunner') })).not.toEqual([])
    expect(dynamicClosedShapeProblems({ [DYNAMIC_BROWSER]: browser.replace(nestedAliasOpen, "  {\n    class bindings { static toString() { return 'users' } }\n    return Object.freeze({\n    lockUser:").replace(nestedAliasClose, '  })\n  }\n}\n\nconst defaultTransaction: AdminGrantTransactionRunner') })).not.toEqual([])
    expect(dynamicClosedShapeProblems({ [DYNAMIC_BROWSER]: browser.replace(qualifyReturn, "  relation = 'users'\n" + qualifyReturn) })).not.toEqual([])
    expect(dynamicClosedShapeProblems({ [DYNAMIC_STORE]: store.replace(qualifiedHead, "let STRICT_LOGIN_GRANT_SCOPE_TABLE = 'users'\n" + qualifiedHead) })).not.toEqual([])
    expect(dynamicClosedShapeProblems({ [DYNAMIC_STORE]: store.replace(qualifiedHead, 'function shadowScope(STRICT_LOGIN_GRANT_SCOPE_TABLE: string) { return STRICT_LOGIN_GRANT_SCOPE_TABLE }\n' + qualifiedHead) })).not.toEqual([])
    expect(dynamicClosedShapeProblems({ [DYNAMIC_STORE]: store.replace(qualifiedHead, "const { STRICT_LOGIN_GRANT_SCOPE_TABLE } = { STRICT_LOGIN_GRANT_SCOPE_TABLE: 'users' }\n" + qualifiedHead) })).not.toEqual([])
  })

  it('pins the cold bundle to two targets and the genuine imported qualifier, without exporting a SQL executor', () => {
    const bundle = read(DYNAMIC_BUNDLE)
    const receipt = '  const receipts = qualified(schemaName, STRICT_LOGIN_GRANT_RECEIPT_TABLE)'
    expect(bundle.split(receipt)).toHaveLength(2)
    expect(dynamicClosedShapeProblems()).toEqual([])
    const mutations = [
      ['input-table target', receipt, "  const receipts = qualified(schemaName, 'users')"],
      ['local qualifier shadow', receipt, "  const qualified = (_schema: string, _table: string) => 'users'\n" + receipt],
      ['qualifier reassignment', receipt, "  qualified = (_schema, _table) => 'users'\n" + receipt],
      ['qualifier alias escape', receipt, '  const escaped = qualified\n' + receipt],
      ['mutable target shadow', receipt, "  let STRICT_LOGIN_GRANT_RECEIPT_TABLE = 'users'\n" + receipt],
      ['parameter target shadow', receipt, '  function shadow(STRICT_LOGIN_GRANT_RECEIPT_TABLE: string) { return STRICT_LOGIN_GRANT_RECEIPT_TABLE }\n' + receipt],
      ['destructured target shadow', receipt, "  const { STRICT_LOGIN_GRANT_RECEIPT_TABLE } = { STRICT_LOGIN_GRANT_RECEIPT_TABLE: 'users' }\n" + receipt],
      ['wrong import source', "} from './strict-login-grant-store'", "} from './unreviewed-qualifier'"],
      ['wrong imported symbol', 'strictLoginGrantQualified as qualified', 'strictLoginGrantRows as qualified'],
      ['SQL executor export', 'async function insertReturning(', 'export async function insertReturning('],
    ]
    for (const [name, from, to] of mutations) {
      const changed = bundle.replace(from, to)
      expect(changed, name).not.toBe(bundle)
      expect(dynamicClosedShapeProblems({ [DYNAMIC_BUNDLE]: changed }), name).not.toEqual([])
    }
    const thirdWrite = bundle + '\nconst third = `INSERT INTO ${qualified(schemaName, STRICT_LOGIN_GRANT_GRANT_TABLE)} (id) VALUES ($1)`\n'
    expect(dynamicClosedShapeProblems({ [DYNAMIC_BUNDLE]: thirdWrite })).toContain('bundle dynamic target shape')
    const store = read(DYNAMIC_STORE)
    const changedExport = store.replace('qualified as strictLoginGrantQualified', 'rowsOf as strictLoginGrantQualified')
    expect(changedExport).not.toBe(store)
    expect(dynamicClosedShapeProblems({ [DYNAMIC_STORE]: changedExport })).toContain('bundle qualifier binding')
  })

  it('the one exemption of the migration helper module is pinned, and sets no verdict aside when a migration is judged', () => {
    const ofHelper = AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS.filter((exemption) => exemption.file === AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE)
    expect(ofHelper.map((exemption) => [exemption.form, exemption.count, [...exemption.reachableTables]])).toEqual([['query_builder_non_literal', 1, ['<migration helper parameter>']]])
    expect([...exemptDynamicForms(AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE, new Map([['query_builder_non_literal', 1]]), AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS)]).toEqual([])
    // Every other exemption under the migration streams covers its form in its own file.
    const others = AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS.filter((exemption) => isMigrationPath(exemption.file) && exemption.file !== AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE)
    expect(others.length).toBeGreaterThan(0)
    for (const exemption of others) expect([...exemptDynamicForms(exemption.file, new Map([[exemption.form, exemption.count]]), AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS)], exemption.id).toEqual([exemption.form])
  })

  it('POSITIVE CONTROL — an exemption that reaches an input table or a cascade parent under another spelling, and a migration exemption that names a pattern, are problems', () => {
    const virtual = (id: string, file: string, reachableTables: string[]): AuthorizationInputDynamicExemption => ({ id, file, form: 'template_substitution', count: 1, reachableTables, reason: 'control' })
    const sourceFile = `${SRC}/admin/user-recycle.ts`
    const migration = `${SRC}/db/migrations/zzzz20270101000000_control.ts`
    const legacy = 'packages/core-backend/migrations/999_control.sql'
    const problemsOf = (...exemptions: AuthorizationInputDynamicExemption[]) => reachableTableProblems(exemptions, AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE)
    for (const [spelling, name] of [['users', 'users'], ['public.users', 'users'], ['"users"', 'users'], [' users', 'users'], ['user_roles ', 'user_roles'], ['"PUBLIC" . "Roles"', 'roles'], ['metasheet.public.permissions', 'permissions']]) {
      expect(problemsOf(virtual('V-1', sourceFile, ['audit_logs', spelling])), spelling).toEqual([`V-1: reaches ${name}`])
      expect(problemsOf(virtual('V-1', migration, [spelling])), spelling).toEqual([`V-1: reaches ${name}`])
    }
    for (const spelling of ['*', '<any table>', 'integration_*', 'audit logs', '']) {
      expect(problemsOf(virtual('V-2', migration, [spelling])), spelling).toEqual([`V-2: ${spelling} is not a plain table name`])
      expect(problemsOf(virtual('V-2', legacy, ['audit_x', spelling])), spelling).toEqual([`V-2: ${spelling} is not a plain table name`])
      // Outside the migration streams a reachable set may be a pattern: it sets no verdict aside there.
      expect(problemsOf(virtual('V-2', sourceFile, [spelling])), spelling).toEqual([])
    }
    expect(problemsOf(virtual('V-3', migration, ['audit_x', 'public.audit_y', '"Audit_Z"']))).toEqual([])
    // The helper module's own entry is the one place a placeholder stands under the migration streams.
    expect(problemsOf(virtual('V-4', AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE, ['<migration helper parameter>']))).toEqual([])
    expect(problemsOf(virtual('V-4', AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE, ['users']))).toEqual(['V-4: reaches users'])
  })

  it('dynamic entries and the closed birth producers register no duplicate literal statements', () => {
    for (const writer of AUTHORIZATION_INPUT_WRITERS) {
      if (writer.class === 'D') {
        expect(writer.statements).toEqual([])
        expect(writer.dynamic).toBeDefined()
      } else if (writer.id === 'B-04' || writer.id === 'B-05') {
        expect(writer).toEqual({
          id: writer.id,
          file: `${SRC}/admin/${writer.id === 'B-04' ? 'admin-user-birth-command' : 'admin-user-batch-birth-command'}.ts`,
          symbol: writer.id === 'B-04' ? 'createAdminUserBirthCommand' : 'createAdminBatchUserCommand',
          intent: 'BIRTH', class: 'B', statements: [], actor: 'human', status: 'pending', slice: 'AIS-2c',
        })
      } else {
        expect(writer.statements.length, writer.id).toBeGreaterThan(0)
        expect(writer.dynamic).toBeUndefined()
      }
    }
    expect(new Set(AUTHORIZATION_INPUT_WRITERS.map((writer) => writer.id)).size).toBe(AUTHORIZATION_INPUT_WRITERS.length)
  })

  it('every writer declares whether it has a human operator, with one of the two values', () => {
    const values: readonly string[] = ['human', 'n/a']
    for (const writer of AUTHORIZATION_INPUT_WRITERS) {
      expect(Object.hasOwn(writer, 'actor'), writer.id).toBe(true)
      expect(values, writer.id).toContain(writer.actor)
    }
    expect(AUTHORIZATION_INPUT_WRITERS.length).toBeGreaterThan(30)
  })

  it('only direct permissions, delegated scopes and legacy permission revoke are converted; other writers remain pending', () => {
    expect(hasPendingWriters()).toBe(true)
    expect(AUTHORIZATION_INPUT_WRITERS.filter((writer) => writer.status === 'converted').map(writer => writer.id)).toEqual(['W-04', 'W-05', 'W-12', 'W-13', 'W-14', 'W-26'])
    expect(AUTHORIZATION_INPUT_TABLE_ALLOWLIST_RATCHET.status).toBe('pending')
  })
})

describe('scan controls', () => {
  const original = read(CONTROL_FILE)
  const mutate = (replacement: string) => scanSource(CONTROL_FILE, original.replace(CONTROL_NEEDLE, replacement))
  const baseline = scanSource(CONTROL_FILE, original)

  it('the control file carries the needle and matches only its registered writes', () => {
    expect(original).toContain(CONTROL_NEEDLE)
    expect(baseline.writes).toEqual([])
    expect(baseline.dynamic).toEqual([])
  })

  const positives: Array<[string, string, string]> = [
    ['reintroduced permission catalogue INSERT', "const x = 'INSERT INTO permissions (code) VALUES ($1)'", 'permissions|INSERT'],
    ['reintroduced role permission INSERT', "const x = 'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)'", 'role_permissions|INSERT'],
    ['raw INSERT', "const x = 'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)'", 'user_roles|INSERT'],
    ['raw DELETE', "const x = 'DELETE FROM user_permissions WHERE user_id = $1'", 'user_permissions|DELETE'],
    ['users UPDATE of an input column', "const x = 'UPDATE users SET is_admin = TRUE WHERE id = $1'", 'users|UPDATE'],
    ['TRUNCATE', "const x = 'TRUNCATE TABLE role_permissions'", 'role_permissions|TRUNCATE'],
    ['TRUNCATE without TABLE', "const x = 'TRUNCATE delegated_role_admin_scopes'", 'delegated_role_admin_scopes|TRUNCATE'],
    ['MERGE', "const x = 'MERGE INTO user_roles USING x ON (TRUE)'", 'user_roles|MERGE'],
    ['COPY FROM', "const x = 'COPY user_roles (user_id, role_id) FROM STDIN'", 'user_roles|COPY'],
    ['quoted identifier', 'const x = \'INSERT INTO "user_roles" (user_id) VALUES ($1)\'', 'user_roles|INSERT'],
    ['public. prefix', "const x = 'DELETE FROM public.user_roles'", 'user_roles|DELETE'],
    ['ONLY', "const x = 'UPDATE ONLY users SET role = $1'", 'users|UPDATE'],
    ['cascade parent delete', "const x = 'DELETE FROM roles WHERE id = $1'", 'roles|DELETE'],
    ['template literal', 'const x = `INSERT INTO user_roles (user_id) VALUES (${1})`', 'user_roles|INSERT'],
    ['CTE body', "const x = 'WITH x AS (DELETE FROM user_roles WHERE user_id = $1 RETURNING *) SELECT 1'", 'user_roles|DELETE'],
    ['query builder literal', "const x = db.insertInto('user_roles').values({})", 'user_roles|INSERT'],
    ['query builder replaceInto', "const x = db.replaceInto('user_permissions').values({})", 'user_permissions|INSERT'],
    ['folded same-file constant', "const T = 'user_roles'; const x = `DELETE FROM ${T} WHERE 1=1`", 'user_roles|DELETE'],
    ['folded type assertion', "const x = db.deleteFrom('user_roles' as any)", 'user_roles|DELETE'],
    ['lower-case verb', "const x = 'insert into user_roles (user_id) values ($1)'", 'user_roles|INSERT'],
    ['two concatenated literals', "const x = 'INSERT INTO ' + 'user_roles (user_id, role_id) VALUES ($1, $2)'", 'user_roles|INSERT'],
    ['three concatenated literals', "const x = 'DELETE ' + 'FROM ' + 'user_permissions WHERE user_id = $1'", 'user_permissions|DELETE'],
    ['concatenation across lines', "const x = 'DELETE FROM ' +\n  'user_permissions WHERE user_id = $1'", 'user_permissions|DELETE'],
    ['literal + constant + literal', "const T = 'user_roles'; const x = 'INSERT INTO ' + T + ' (user_id) VALUES ($1)'", 'user_roles|INSERT'],
    ['quoted schema and table', 'const x = \'DELETE FROM "public"."user_roles" WHERE user_id = $1\'', 'user_roles|DELETE'],
    ['users UPDATE of a quoted input column', 'const x = \'UPDATE users SET "role" = $1 WHERE id = $2\'', 'users|UPDATE'],
    ['users UPDATE through a tuple assignment', "const x = 'UPDATE users SET (role, is_admin) = ($1, $2) WHERE id = $3'", 'users|UPDATE'],
    ['multi-table TRUNCATE', "const x = 'TRUNCATE audit_logs, user_roles, sessions'", 'user_roles|TRUNCATE'],
    ['schema with white space around the dot', "const x = 'DELETE FROM public . user_roles WHERE user_id = $1'", 'user_roles|DELETE'],
    ['SQL comment between the verb and the table', "const x = 'INSERT INTO /* note */ user_roles (user_id, role_id) VALUES ($1, $2)'", 'user_roles|INSERT'],
    ['SQL line comment between the verb and the table', "const x = 'DELETE FROM -- note\\n user_permissions WHERE user_id = $1'", 'user_permissions|DELETE'],
    ['query builder call with its method name in brackets', "const x = db['deleteFrom']('user_roles')", 'user_roles|DELETE'],
    ['query builder call with its method name as a template in brackets', 'const x = db[`insertInto`](\'public.user_permissions\').values({})', 'user_permissions|INSERT'],
    ['a table after a substituted schema', 'const x = `DELETE FROM ${schema}.user_roles WHERE user_id = $1`', 'user_roles|DELETE'],
    ['a lower-case write after a substituted schema', 'const x = `update "${schema}"."users" set role = $1`', 'users|UPDATE'],
    ['TRUNCATE past an item in another schema', "const x = 'TRUNCATE audit_logs, other.thing, user_roles'", 'user_roles|TRUNCATE'],
    ['TRUNCATE of a scanned name that directly follows the verb, with a dot after it', "const x = 'TRUNCATE users.archive'", 'users|TRUNCATE'],
    ['DELETE of a scanned name that directly follows the verb, with a dot after it', "const x = 'DELETE FROM user_roles.archive'", 'user_roles|DELETE'],
    ['TRUNCATE after an item that is not a plain name', 'const x = \'TRUNCATE "audit log", role_permissions\'', 'role_permissions|TRUNCATE'],
    ['TRUNCATE after a substituted item', 'const x = `TRUNCATE ${table}, user_permissions`', 'user_permissions|TRUNCATE'],
    ['TRUNCATE of a table after a substituted schema', 'const x = `TRUNCATE audit_logs, ${schema}.user_roles`', 'user_roles|TRUNCATE'],
    ['a table after a schema written as text against a substitution', 'const x = `INSERT INTO tenant_${id}.user_roles (user_id) VALUES ($1)`', 'user_roles|INSERT'],
    ['a table after a schema written as a substitution against text', 'const x = `DELETE FROM ${prefix}lic.user_permissions WHERE user_id = $1`', 'user_permissions|DELETE'],
    ['a table after a schema written as two substitutions', 'const x = `UPDATE ${a}${b}.users SET is_admin = TRUE`', 'users|UPDATE'],
    ['a table after a schema concatenated from text and an operand', "const x = 'DELETE FROM tenant_' + id + '.role_permissions'", 'role_permissions|DELETE'],
    ['a scanned name with a substitution written against it', 'const x = `DELETE FROM user_roles${where}`', 'user_roles|DELETE'],
    ['TRUNCATE after an item written in pieces', 'const x = `TRUNCATE audit_${suffix}, user_permissions`', 'user_permissions|TRUNCATE'],
    ['TRUNCATE of a table after a schema written in pieces', 'const x = `TRUNCATE audit_logs, tenant_${id}.user_roles`', 'user_roles|TRUNCATE'],
    ['TRUNCATE of a scanned name with a substitution written against it, later in the list', 'const x = `TRUNCATE audit_logs, users${suffix}`', 'users|TRUNCATE'],
    ['TRUNCATE of a scanned name that a schema in pieces begins with, later in the list', 'const x = `TRUNCATE audit_logs, users${suffix}.archive`', 'users|TRUNCATE'],
  ]
  for (const [name, replacement, expected] of positives) {
    it(`POSITIVE CONTROL — ${name} is counted`, () => {
      const result = mutate(replacement)
      expect(result.writes.map((w) => `${w.table}|${w.verb}`)).toContain(expected)
      expect(result.writes.length).toBe(baseline.writes.length + 1)
    })
  }

  const dynamicPositives: Array<[string, string, string]> = [
    ['template substitution after a verb', 'const x = `INSERT INTO ${table} (a) VALUES (1)`', 'template_substitution'],
    ['concatenation after a verb', "const x = 'DELETE FROM ' + table", 'concatenation'],
    ['concatenation after a verb in a longer chain', "const x = 'WITH x AS (DELETE FROM ' + table + ' WHERE id = $1) SELECT 1'", 'concatenation'],
    ['users UPDATE with a concatenated SET clause', "const x = 'UPDATE users SET ' + assignments + ' WHERE id = $1'", 'users_update_dynamic_set'],
    ['query builder non-literal table', 'const x = db.updateTable(table as any).set({})', 'query_builder_non_literal'],
    ['users UPDATE with a substituted SET clause', 'const x = `UPDATE users SET ${assignments} WHERE id = $1`', 'users_update_dynamic_set'],
    ['query builder call in brackets with a non-literal table', "const x = db['updateTable'](table as any).set({})", 'query_builder_non_literal'],
    ['a name of three parts that ends in a scanned table', "const x = 'DELETE FROM metasheet.public.user_roles WHERE user_id = $1'", 'multi_part_name'],
    ['a name of three parts that begins with the usual schema', "const x = 'DELETE FROM public.user_roles.archived'", 'multi_part_name'],
    ['a quoted name of three parts on a cascade parent', 'const x = \'UPDATE "my db"."public"."roles" SET id = $1\'', 'multi_part_name'],
    ['a name of three parts with a substituted part', 'const x = `INSERT INTO metasheet.public.${table} (id) VALUES ($1)`', 'multi_part_name'],
    ['a name of three parts in a TRUNCATE list', "const x = 'TRUNCATE audit_logs, metasheet.public.user_roles'", 'multi_part_name'],
    ['text against a substitution after a verb', 'const x = `INSERT INTO user_${suffix} (user_id, role_id) VALUES ($1, $2)`', 'template_substitution'],
    ['text against a substitution after a verb and the usual schema', 'const x = `UPDATE public.user${suffix} SET is_admin = TRUE`', 'template_substitution'],
    ['text against a substitution as the first item of a TRUNCATE list', 'const x = `TRUNCATE TABLE user_${suffix}`', 'template_substitution'],
    ['text against a concatenation operand after a verb', "const x = 'DELETE FROM user_' + suffix", 'concatenation'],
    ['a name of three parts with a part written in pieces', 'const x = `DELETE FROM metasheet.pub${suffix}.user_roles`', 'multi_part_name'],
  ]
  for (const [name, replacement, form] of dynamicPositives) {
    it(`POSITIVE CONTROL — ${name} is a dynamic target`, () => {
      const result = mutate(replacement)
      expect(result.dynamic.map((d) => d.form)).toContain(form)
      expect(result.writes.length).toBe(baseline.writes.length)
    })
  }

  const negatives: Array<[string, string]> = [
    ['a read of an input table', "const x = 'SELECT 1 FROM user_roles WHERE user_id = $1'"],
    ['a write inside a comment', "const x = 1 // INSERT INTO user_roles (user_id) VALUES ($1)"],
    ['a write inside a block comment', "/* DELETE FROM user_roles */ const x = 1"],
    ['a users UPDATE of a non-input column', "const x = 'UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2'"],
    ['a row lock clause', "const x = 'SELECT id FROM users WHERE id = $1 FOR UPDATE'"],
    ['a no-key row lock clause', "const x = 'SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE'"],
    ['an upsert action clause', "const x = 'INSERT INTO sessions (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET seen = NOW()'"],
    ['a COPY out', "const x = 'COPY users TO STDOUT'"],
    ['a table whose name only starts with an input name', "const x = 'DELETE FROM users_archive WHERE id = $1'"],
    ['a lower-case prose verb before a substitution', 'const x = `update ${count} rows`'],
    ['a template substitution after a non-verb', 'const x = `SELECT * FROM ${table}`'],
    ['concatenated literals naming a table outside the set', "const x = 'INSERT INTO ' + 'sessions (id) VALUES ($1)'"],
    ['a concatenation after a non-verb', "const x = 'SELECT * FROM ' + table"],
    ['a multi-table TRUNCATE naming no scanned table', "const x = 'TRUNCATE audit_logs, sessions'"],
    ['a write inside an SQL block comment of a literal', "const x = 'SELECT 1 /* DELETE FROM user_roles */'"],
    ['a write inside an SQL line comment of a literal', "const x = 'SELECT 1 -- INSERT INTO user_roles (user_id) VALUES (1)'"],
    ['a name of three parts none of which is a scanned table', "const x = 'INSERT INTO smoke_db.dbo.smoke_probe (id) VALUES (1)'"],
    ['a copy out of a name of three parts', "const x = 'COPY metasheet.public.users TO STDOUT'"],
    ['a TRUNCATE item in another schema', "const x = 'TRUNCATE audit_logs, app.user_roles'"],
    ['a later TRUNCATE item whose schema is spelled like a scanned table', "const x = 'TRUNCATE audit_logs, users.archive'"],
    ['text against a substitution after a non-verb', 'const x = `SELECT * FROM user_${suffix}`'],
    ['a lower-case prose verb before text against a substitution', 'const x = `update row_${count} of the list`'],
    ['a substitution after white space behind the table of a write', 'const x = `DELETE FROM sessions ${where}`'],
    ['a later TRUNCATE item written in pieces that names no scanned table', 'const x = `TRUNCATE audit_logs, user_${suffix}`'],
  ]
  for (const [name, replacement] of negatives) {
    it(`NEGATIVE CONTROL — ${name} is not counted`, () => {
      const result = mutate(replacement)
      expect(result.writes.length).toBe(baseline.writes.length)
      expect(result.dynamic).toEqual([])
    })
  }

  it('CONTROLS — the writes of one text are reported in the order of the text, however each of them is found', () => {
    const result = mutate('const x = `DELETE FROM user_permissions; TRUNCATE "audit log", user_roles; DELETE FROM ${schema}.delegated_role_admin_scopes; DELETE FROM users`')
    const added = result.writes.filter((write) => !baseline.writes.some((known) => known.table === write.table && known.verb === write.verb))
    expect(added.map((write) => `${write.table}|${write.verb}`)).toEqual(['user_permissions|DELETE', 'user_roles|TRUNCATE', 'delegated_role_admin_scopes|DELETE', 'users|DELETE'])
  })

  it('CONTROLS — a users upsert action counts an UPDATE only when it assigns an input column, and is dynamic when its SET clause is substituted', () => {
    const keyOf = (w: LiteralWrite) => `${w.table}|${w.verb}|${w.form}`
    const added = (result: ReturnType<typeof mutate>) => {
      const remaining = baseline.writes.map(keyOf)
      return result.writes.map(keyOf).filter((key) => {
        const index = remaining.indexOf(key)
        if (index < 0) return true
        remaining.splice(index, 1)
        return false
      }).sort()
    }
    expect(added(mutate("const x = 'INSERT INTO users (id, role) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role'"))).toEqual(['users|INSERT|sql', 'users|UPDATE|upsert'])
    expect(added(mutate("const x = 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name'"))).toEqual(['users|INSERT|sql'])
    expect(added(mutate("const x = 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING'"))).toEqual(['users|INSERT|sql'])
    const substituted = mutate('const x = `INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET ${assignments}`')
    expect(added(substituted)).toEqual(['users|INSERT|sql'])
    expect(substituted.dynamic.map((d) => d.form)).toEqual(['users_update_dynamic_set'])
  })
})

describe('table allowlists of the generic bulk routes', () => {
  it('both allowlists exist and equal the pinned items in order', () => {
    const ratchet = AUTHORIZATION_INPUT_TABLE_ALLOWLIST_RATCHET
    const source = read(ratchet.file)
    const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
    const arrays: string[][] = []
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === ratchet.identifier && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
        arrays.push(node.initializer.elements.map((element) => (ts.isStringLiteral(element) ? element.text : `<${ts.SyntaxKind[element.kind]}>`)))
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(arrays).toHaveLength(ratchet.occurrences)
    for (const items of arrays) expect(items).toEqual([...ratchet.items])
    const dynamicSites = production.dynamic.filter((target) => target.file === ratchet.file)
    expect(dynamicSites.map((target) => target.form)).toEqual(['query_builder_non_literal', 'query_builder_non_literal'])
  })

  it('POSITIVE CONTROL — adding or removing one item is detected (in memory)', () => {
    const ratchet = AUTHORIZATION_INPUT_TABLE_ALLOWLIST_RATCHET
    const source = read(ratchet.file)
    const parse = (text: string) => {
      const file = ts.createSourceFile('m.ts', text, ts.ScriptTarget.Latest, true)
      const arrays: string[][] = []
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === ratchet.identifier && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
          arrays.push(node.initializer.elements.map((element) => (ts.isStringLiteral(element) ? element.text : '?')))
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
      return arrays
    }
    const added = parse(source.replace("'users', 'cells',", "'users', 'user_roles', 'cells',"))
    expect(added.some((items) => items.join() !== ratchet.items.join())).toBe(true)
    const removed = parse(source.replace("'users', 'cells',", "'cells',"))
    expect(removed.some((items) => items.join() !== ratchet.items.join())).toBe(true)
  })
})

/* ───────────────────────────── migrations ───────────────────────────── */

const MIG = `${SRC}/db/migrations`
/** The frozen list is pinned by length and by the timestamp ceiling of its entries; the one entry without a timestamp is the legacy SQL file. */
const FROZEN_MIGRATION_COUNT = 25
const FROZEN_MIGRATION_CEILING = '20261012090000'
const FROZEN_MIGRATION_LEGACY = 'packages/core-backend/migrations/054_create_users_table.sql'

function migrationStamp(file: string): string | null {
  return /(?:^|\/)(?:zzzz)?(\d{14})_/.exec(file)?.[1] ?? null
}

/** Problems with a frozen list: wrong length, an entry past the ceiling, an entry that is not a writing migration. */
function frozenListProblems(frozen: readonly string[], writing: ReadonlySet<string>): string[] {
  const problems: string[] = []
  if (frozen.length !== FROZEN_MIGRATION_COUNT) problems.push(`frozen list has ${frozen.length} entries, pinned ${FROZEN_MIGRATION_COUNT}`)
  for (const file of frozen) {
    const stamp = migrationStamp(file)
    if (file === FROZEN_MIGRATION_LEGACY) continue
    if (stamp === null) problems.push(`${file}: no timestamp`)
    else if (stamp > FROZEN_MIGRATION_CEILING) problems.push(`${file}: past the ceiling ${FROZEN_MIGRATION_CEILING}`)
    if (!writing.has(file)) problems.push(`${file}: not a writing migration`)
  }
  return problems
}

describe('migrations', () => {
  const writing = new Set(migrations.writes.map((write) => write.file))

  it('the frozen list is pinned (length, timestamp ceiling), every frozen path exists and writes an input or a cascade parent', () => {
    expect(frozenListProblems(AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, writing)).toEqual([])
    for (const file of AUTHORIZATION_INPUT_FROZEN_MIGRATIONS) expect(fs.existsSync(path.join(REPO_ROOT, file)), file).toBe(true)
    expect(AUTHORIZATION_INPUT_FROZEN_MIGRATIONS).toContain(FROZEN_MIGRATION_LEGACY)
    // The forms the scan reports are pinned here; the two forms only the migration judgment finds are matched by count where a file is judged.
    const scannedForms: readonly string[] = SCANNED_DYNAMIC_FORMS
    const expected = sortedEntries(new Map(AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS.filter((e) => e.file.includes('/db/migrations/') && scannedForms.includes(e.form)).map((e) => [`${e.file}|${e.form}`, e.count])))
    expect(sortedEntries(byFileAndForm(migrations.dynamic))).toEqual(expected)
  })

  it('an exemption of a form only the judgment finds names an existing file in which the judgment finds that many targets', () => {
    const sourceOrNull = (file: string) => (fs.existsSync(path.join(REPO_ROOT, file)) ? read(file) : null)
    expect(judgedOnlyExemptionProblems(AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS, sourceOrNull)).toEqual([])
    // Every registered form is one the scan reports or one only the judgment finds, never both.
    const scannedForms: readonly string[] = SCANNED_DYNAMIC_FORMS
    expect(JUDGED_ONLY_DYNAMIC_FORMS.filter((form) => scannedForms.includes(form))).toEqual([])
    for (const exemption of AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS) expect([...scannedForms, ...JUDGED_ONLY_DYNAMIC_FORMS], exemption.id).toContain(exemption.form)
  })

  it('POSITIVE CONTROL — such an exemption for a file that does not exist, or with another count than the judgment finds, is a problem', () => {
    const helperFile = `${MIG}/zzzz20270101000000_control_helper.ts`
    const blockFile = `${MIG}/zzzz20270101000001_control_block.ts`
    const missing = `${MIG}/zzzz20270101000002_control_missing.ts`
    const sources: Record<string, string> = {
      [helperFile]: "import { checkTableExists } from './_patterns'\nexport async function up(db, tableName) {\n  await checkTableExists(db, tableName)\n}",
      [blockFile]: `export async function up(db) {\n  await db.query("DO $$ BEGIN EXECUTE format('DELETE FROM %I', t); EXECUTE format('DELETE FROM %I', u); END $$")\n}`,
    }
    const sourceOf = (file: string) => sources[file] ?? null
    const virtual = (id: string, file: string, form: AuthorizationInputDynamicExemption['form'], count: number): AuthorizationInputDynamicExemption => ({ id, file, form, count, reachableTables: ['audit_x'], reason: 'control' })
    expect(judgedOnlyExemptionProblems([virtual('V-1', helperFile, 'helper_table_argument', 1)], sourceOf)).toEqual([])
    expect(judgedOnlyExemptionProblems([virtual('V-1', blockFile, 'dynamic_statement', 2)], sourceOf)).toEqual([])
    expect(judgedOnlyExemptionProblems([virtual('V-1', blockFile, 'dynamic_statement', 1), virtual('V-2', blockFile, 'dynamic_statement', 1)], sourceOf)).toEqual([])
    expect(judgedOnlyExemptionProblems([virtual('V-1', helperFile, 'helper_table_argument', 2)], sourceOf)).toEqual([`${helperFile}|helper_table_argument: registered 2, found 1`])
    expect(judgedOnlyExemptionProblems([virtual('V-1', helperFile, 'dynamic_statement', 1)], sourceOf)).toEqual([`${helperFile}|dynamic_statement: registered 1, found 0`])
    expect(judgedOnlyExemptionProblems([virtual('V-1', blockFile, 'dynamic_statement', 1)], sourceOf)).toEqual([`${blockFile}|dynamic_statement: registered 1, found 2`])
    expect(judgedOnlyExemptionProblems([virtual('V-1', missing, 'helper_table_argument', 1)], sourceOf)).toEqual([`${missing}|helper_table_argument: the file does not exist`])
    // A form the scan reports is compared with the scan, not here.
    expect(judgedOnlyExemptionProblems([virtual('V-1', missing, 'template_substitution', 9)], sourceOf)).toEqual([])
  })

  it('every migration outside the frozen list is checked: one that writes an input carries the bounded try form and each of its writes is judged safe', () => {
    expect(traversalProblems(migrations.files, AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, read, writing.size)).toEqual([])
    expect(migrations.files.length).toBeGreaterThan(400)
  })

  it('the pinned statements set nothing aside in any migration but their own: judged as new or as it is, every other migration has the same problems with and without them, and none of them carries a pinned text', () => {
    const pinnedFiles = new Set(AUTHORIZATION_INPUT_PINNED_STATEMENT_SETS.map((set) => set.file))
    const pinnedTexts = new Set(AUTHORIZATION_INPUT_PINNED_STATEMENT_SETS.flatMap((set) => set.statements.map((statement) => statement.text)))
    const others = migrations.files.filter((file) => !pinnedFiles.has(file))
    expect(others.length).toBeGreaterThan(400)
    let refusedAsNew = 0
    for (const file of others) {
      const source = read(file)
      for (const isNew of [true, false]) {
        const withPins = checkNewMigration(file, source, isNew).problems
        expect(checkNewMigration(file, source, isNew, AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS, []).problems, file).toEqual(withPins)
        if (isNew) refusedAsNew += withPins.length
      }
      expect(judgeMigrationInputWrites(file, source).judgments.filter((judgment) => pinnedTexts.has(judgment.statement?.text ?? '')), file).toEqual([])
    }
    // The comparison is not vacuous: judged as new, the migrations of the tree carry problems the pins could have touched.
    expect(refusedAsNew).toBeGreaterThan(0)
  })

  it('pins the retry-loop marks of the bounded try block', () => {
    expect(AUTHORIZATION_INPUT_MIGRATION_LOCK_BLOCK_MARKS).toEqual(['LOOP', 'pg_sleep', 'RAISE', '55P03'])
  })

  it('POSITIVE CONTROL — through the real traversal: a compliant migration passes, a raising or lock-less one is rejected, and the frozen list cannot absorb a later file', () => {
    const compliant = `${MIG}/zzzz20261107000000_control_compliant.ts`
    const raising = `${MIG}/zzzz20261107000001_control_raising.ts`
    const lockless = `${MIG}/zzzz20261107000002_control_lockless.ts`
    const catalogueOnly = `${MIG}/zzzz20261107000003_control_catalogue.ts`
    const sql = `packages/core-backend/migrations/999_control.sql`
    const virtual: Record<string, string> = {
      [compliant]: `export async function up(db) {\n  await db.query(\`${COMPLIANT_LOCK_BLOCK}\`)\n  await db.query("INSERT INTO role_permissions (role_id, permission_code) VALUES ('viewer', 'docs:read') ON CONFLICT DO NOTHING")\n}`,
      [raising]: "export async function up(db) { await db.query(\"INSERT INTO role_permissions (role_id, permission_code) VALUES ('viewer', 'users:write')\") }",
      [lockless]: "export async function up(db) { await db.query(\"INSERT INTO role_permissions (role_id, permission_code) VALUES ('viewer', 'docs:read')\") }",
      [catalogueOnly]: "export async function up(db) { await db.query('INSERT INTO permissions (code) VALUES ($1)') }",
      [sql]: `-- ${COMPLIANT_LOCK_BLOCK}\nINSERT INTO user_permissions (user_id, permission_code) VALUES ('u', 'docs:read');`,
    }
    const sourceOf = (file: string) => virtual[file] ?? read(file)
    const files = [...migrations.files, ...Object.keys(virtual)]
    const problems = migrationRuleProblems(files, AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, sourceOf).problems
    expect(problems.filter((p) => p.startsWith(compliant))).toEqual([])
    expect(problems.filter((p) => p.startsWith(catalogueOnly))).toEqual([])
    expect(problems.filter((p) => p.startsWith(raising))).toEqual([`${raising}: missing world lock try form`, `${raising}: grants class-raising code users:write`])
    expect(problems.filter((p) => p.startsWith(lockless))).toEqual([`${lockless}: missing world lock try form`])
    expect(problems.filter((p) => p.startsWith(sql))).toEqual([`${sql}: missing world lock try form`])
    // A compliant new writing migration and a catalogue-only one leave the frozen-list pin green as
    // well, and the assertions of the real traversal hold with both added: a writing migration
    // outside the frozen list is not a failure in itself.
    expect(frozenListProblems(AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, new Set([...writing, compliant, catalogueOnly]))).toEqual([])
    expect(traversalProblems([...migrations.files, compliant, catalogueOnly], AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, sourceOf, writing.size + 2)).toEqual([])
    expect(traversalProblems([...migrations.files, raising], AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, sourceOf, writing.size + 1)).toEqual([`${raising}: missing world lock try form`, `${raising}: grants class-raising code users:write`])
    // A traversal that visits nothing, or only the frozen files, or loses a writing migration, is a failure.
    expect(traversalProblems([], AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, sourceOf, writing.size).length).toBeGreaterThan(0)
    expect(traversalProblems([...AUTHORIZATION_INPUT_FROZEN_MIGRATIONS], AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, sourceOf, writing.size)).toEqual(['checked 0 of 0 migrations outside the frozen list'])
    expect(traversalProblems(migrations.files, AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, sourceOf, writing.size + 1)).toEqual([`checked 0 writing migrations, expected 1`])
    // Appending the raising file to the frozen list skips the rule but breaks the pin.
    const absorbed = [...AUTHORIZATION_INPUT_FROZEN_MIGRATIONS, raising]
    expect(migrationRuleProblems(files, absorbed, sourceOf).problems.filter((p) => p.startsWith(raising))).toEqual([])
    expect(frozenListProblems(absorbed, new Set([...writing, raising]))).toEqual([
      `frozen list has ${FROZEN_MIGRATION_COUNT + 1} entries, pinned ${FROZEN_MIGRATION_COUNT}`,
      `${raising}: past the ceiling ${FROZEN_MIGRATION_CEILING}`,
    ])
    expect(frozenListProblems(AUTHORIZATION_INPUT_FROZEN_MIGRATIONS.slice(1), writing)).toHaveLength(1)
  })

  it('POSITIVE CONTROL — the lock form counts only inside a statement literal and only with its retry-loop marks; user-level raises are rejected', () => {
    const write = "await db.query(\"INSERT INTO role_permissions (role_id, permission_code) VALUES ('viewer', 'docs:read')\")"
    const checkNew = (file: string, source: string) => [...checkNewMigration(file, source, true).problems]
    const up = (body: string) => `export async function up(db) {\n${body}\n}`
    expect(checkNew('x.ts', up(`// ${COMPLIANT_LOCK_BLOCK}\n${write}`))).toEqual(['missing world lock try form'])
    expect(checkNew('x.ts', up(`/* ${COMPLIANT_LOCK_BLOCK} */\n${write}`))).toEqual(['missing world lock try form'])
    expect(checkNew('x.ts', up(`await db.query('SELECT ${AUTHORIZATION_INPUT_MIGRATION_LOCK_FORM}')\n${write}`))).toEqual([
      'world lock try form without LOOP',
      'world lock try form without pg_sleep',
      'world lock try form without RAISE',
      'world lock try form without 55P03',
    ])
    expect(checkNew('x.ts', up(`await db.query(\`${COMPLIANT_LOCK_BLOCK}\`)\n${write}`))).toEqual([])
    expect(checkNew('x.ts', up(`await db.query(\`${COMPLIANT_LOCK_BLOCK}\`)\nawait db.query('SELECT pg_advisory_xact_lock(20261106, 1)')\n${write}`))).toEqual(['blocking world lock form'])
    expect(checkNew('x.sql', `-- ${COMPLIANT_LOCK_BLOCK}\nINSERT INTO role_permissions (role_id, permission_code) VALUES ('viewer', 'docs:read');`)).toEqual(['missing world lock try form'])
    expect(checkNew('x.sql', `${COMPLIANT_LOCK_BLOCK};\nINSERT INTO role_permissions (role_id, permission_code) VALUES ('viewer', 'docs:read');`)).toEqual([])
    const locked = (statement: string) => up(`await db.query(\`${COMPLIANT_LOCK_BLOCK}\`)\nawait db.query("${statement}")`)
    expect(checkNew('x.ts', locked("INSERT INTO user_roles (user_id, role_id) VALUES ('u', 'admin')"))).toEqual(['writes user_roles: a migration does not change memberships; use the contract entry or the maintenance tool'])
    expect(checkNew('x.ts', locked("UPDATE users SET is_admin = TRUE WHERE id = 'u'"))).toEqual(['sets is_admin'])
    expect(checkNew('x.ts', locked("UPDATE users SET role = 'admin' WHERE id = 'u'"))).toEqual(['assigns class-raising role admin'])
    expect(checkNew('x.ts', locked("UPDATE role_permissions SET permission_code = 'users:write' WHERE role_id = 'viewer'"))).toEqual(['grants class-raising code users:write'])
    expect(checkNew('x.ts', locked("UPDATE users SET role = 'user' WHERE id = 'u'"))).toEqual([])
    expect(checkNew('x.ts', up("await db.query('INSERT INTO permissions (code) VALUES ($1)')"))).toEqual([])
  })
})

const classOf = (file: string) => AUTHORIZATION_INPUT_SCRIPT_CLASSES.filter((entry) => entry.paths.some((p) => file === p || file.startsWith(p)))

/**
 * Script rules: every touched script has exactly one class; a class with a verb list issues only
 * those verbs (a bootstrap's birth insert may carry an upsert action, which is the one UPDATE a
 * bootstrap may issue); a tool that writes an input table uses the contract entry or contains the
 * migration lock form; dynamic targets outside the fixture class are registered exemptions.
 */
function scriptProblems(writes: readonly LiteralWrite[], dynamic: readonly DynamicTarget[], sourceOf: (file: string) => string): string[] {
  const touched = new Set([...writes.map((w) => w.file), ...dynamic.map((d) => d.file)])
  const problems: string[] = []
  for (const file of [...touched].sort()) {
    const classes = classOf(file)
    if (classes.length !== 1) {
      problems.push(`${file}: ${classes.length} classes`)
      continue
    }
    const [entry] = classes
    const own = writes.filter((w) => w.file === file)
    if (entry.verbs) {
      for (const write of own) {
        if (entry.verbs.includes(write.verb)) continue
        if (entry.class === 'BOOTSTRAP' && write.table === 'users' && write.form === 'upsert') continue
        problems.push(`${file}: ${write.verb} outside ${entry.class}`)
      }
    }
    if (entry.class === 'TOOL' && own.some((w) => (INPUT_TABLES as readonly string[]).includes(w.table))) {
      const source = sourceOf(file)
      if (!/\bwithAuthorizationInputTransaction\s*\(/.test(source) && !literalTexts(file, source).some((text) => text.includes(AUTHORIZATION_INPUT_MIGRATION_LOCK_FORM))) {
        problems.push(`${file}: tool writes an input without the contract entry or the lock form`)
      }
    }
    if (entry.class !== 'FIXTURE') {
      const forms = byFileAndForm(dynamic.filter((d) => d.file === file))
      for (const [key, count] of forms) {
        const exemption = AUTHORIZATION_INPUT_SCRIPT_DYNAMIC_EXEMPTIONS.find((e) => `${e.file}|${e.form}` === key)
        if (!exemption || exemption.count !== count) problems.push(`${file}: unregistered dynamic target ${key} x${count}`)
      }
    }
  }
  return problems
}

describe('scripts and workflows', () => {
  it('every script with a write or a dynamic target satisfies its class rule', () => {
    const touched = new Set([...scripts.writes.map((w) => w.file), ...scripts.dynamic.map((d) => d.file)])
    expect(scriptProblems(scripts.writes, scripts.dynamic, read)).toEqual([])
    expect(touched.size).toBeGreaterThan(20)
    expect(scripts.writes.filter((w) => w.form === 'upsert').map((w) => w.file).sort()).toEqual(AUTHORIZATION_INPUT_SCRIPT_CLASSES.find((e) => e.class === 'BOOTSTRAP')!.paths.slice().sort())
    for (const entry of AUTHORIZATION_INPUT_SCRIPT_CLASSES) {
      for (const p of entry.paths) expect(fs.existsSync(path.join(REPO_ROOT, p)) || [...touched].some((file) => file.startsWith(p)), p).toBe(true)
    }
  })

  it('POSITIVE CONTROL — a bootstrap UPDATE, an unclassified script, and a tool writing an input without the lock form are problems', () => {
    const bootstrap = AUTHORIZATION_INPUT_SCRIPT_CLASSES.find((e) => e.class === 'BOOTSTRAP')!.paths[0]
    const tool = AUTHORIZATION_INPUT_SCRIPT_CLASSES.find((e) => e.class === 'TOOL')!.paths[0]
    const write = (file: string, table: string, verb: LiteralWrite['verb'], form: LiteralWrite['form'] = 'sql'): LiteralWrite => ({ file, line: 1, position: 0, table, verb, form })
    expect(scriptProblems([write(bootstrap, 'users', 'UPDATE')], [], () => '')).toEqual([`${bootstrap}: UPDATE outside BOOTSTRAP`])
    expect(scriptProblems([write(bootstrap, 'users', 'UPDATE', 'upsert')], [], () => '')).toEqual([])
    expect(scriptProblems([write(bootstrap, 'user_roles', 'UPDATE', 'upsert')], [], () => '')).toEqual([`${bootstrap}: UPDATE outside BOOTSTRAP`])
    expect(scriptProblems([write('scripts/ops/unclassified.sh', 'user_roles', 'INSERT')], [], () => '')).toEqual(['scripts/ops/unclassified.sh: 0 classes'])
    expect(scriptProblems([write(tool, 'user_roles', 'INSERT')], [], () => "await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)')")).toEqual([`${tool}: tool writes an input without the contract entry or the lock form`])
    expect(scriptProblems([write(tool, 'user_roles', 'INSERT')], [], () => `await client.query(\`${COMPLIANT_LOCK_BLOCK}\`)`)).toEqual([])
    expect(scriptProblems([write(tool, 'user_roles', 'INSERT')], [], () => `// ${AUTHORIZATION_INPUT_MIGRATION_LOCK_FORM}`)).toHaveLength(1)
    expect(scriptProblems([write(tool, 'user_roles', 'INSERT')], [], () => 'await withAuthorizationInputTransaction({ intent: "MAINTENANCE" }, work)')).toEqual([])
    expect(scriptProblems([write(tool, 'directory_integrations', 'UPDATE')], [], () => '')).toEqual([])
  })

  it('a converted `.mjs` tool copies the classifier statement verbatim and compares classes around its apply step', () => {
    const statement = classifierStatementText()
    for (const entry of AUTHORIZATION_INPUT_SCRIPT_CLASSES.filter((e) => e.class === 'OPS_MJS')) {
      for (const file of entry.paths) {
        const source = read(file)
        const satisfied = source.replace(/\s+/g, ' ').includes(statement.replace(/\s+/g, ' ')) && /--apply/.test(source)
        expect(satisfied, `${file} status`).toBe(entry.status === 'converted')
      }
    }
  })

  it('workflow fixtures equal the registry', () => {
    const expected = new Map<string, number>()
    for (const fixture of AUTHORIZATION_INPUT_WORKFLOW_FIXTURES) for (const s of fixture.statements) expected.set(`${fixture.file}|${s.table}|${s.verb}`, s.count)
    expect(sortedEntries(tally(workflows.writes))).toEqual(sortedEntries(expected))
    expect(workflows.dynamic).toEqual([])
  })
})

/* ───────────────────────────── import edges, takeover sites, key forms ───────────────────────────── */

/** Module specifiers of every `import … from`, `import type`, and `export … from` statement. */
function importSpecifiers(source: string): string[] {
  const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text)
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text)
  }
  return specifiers
}

const CONTRACT_SPECIFIER = /authorization-input-(?:brand|classes|lock|writers|consumers)/
const ROLE_PLAN_MODULE = `${SRC}/rbac/authorization-privilege-witness-plan.ts`
const ROLE_PLAN_IMPORTS = [
  "import { PrivilegeInputsUnavailableError, readPrivilegeInputs } from '../auth/security-action-privilege'",
  "import { assertAuthorizationInputTx, AuthorizationInputContractError } from './authorization-input-brand'",
  "import type { AuthorizationInputQueryable } from './authorization-input-brand'",
  "import type { AuthorizationInputPlan, AuthorizationInputTx } from './authorization-input-lock'",
  "import { normalizeAuthorizationInputIdentityRead } from './authorization-input-lock'",
  "import type { AuthorizationInputIdentityRead } from './authorization-input-lock'",
]
const ADMIN_GRANT_RECEIVING_READER_MODULE = `${SRC}/auth/admin-grant-receiving-reader.ts`
const ADMIN_GRANT_PROOF_MODULE = `${SRC}/auth/admin-grant-proof.ts`
const CONTRACT_IMPORT_ALLOWLIST: ReadonlyArray<readonly [string, string]> = [
  [`${SRC}/attendance/w4c0-identity.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/attendance/w4c0-identity.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/admin-user-birth-command.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/admin/admin-user-birth-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/admin-user-birth-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/admin-user-batch-birth-command.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/admin/admin-user-batch-birth-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/admin-user-batch-birth-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/role-delegation-namespace-admission-command.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/admin/role-delegation-namespace-admission-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/role-delegation-namespace-admission-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/legacy-permission-revoke.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/platform-namespace-admission-bulk-command.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/admin/platform-namespace-admission-bulk-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/platform-namespace-admission-bulk-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/platform-namespace-admission-command.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/admin/platform-namespace-admission-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/platform-namespace-admission-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/delegated-scope-commands.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/admin/delegated-scope-commands.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/delegated-scope-commands.ts`, '../rbac/authorization-input-lock'],
  [ADMIN_GRANT_RECEIVING_READER_MODULE, '../rbac/authorization-input-brand'],
  [ADMIN_GRANT_RECEIVING_READER_MODULE, '../rbac/authorization-input-lock'],
  [`${SRC}/auth/admin-grant-target-ceremony.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/auth/admin-grant-target-ceremony.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/auth/admin-grant-proof.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/auth/admin-grant-proof.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/auth/admin-grant-proof.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/auth/security-action-attempt-admission.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/auth/security-action-attempt-admission.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/auth/admin-login-grant-command.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/auth/admin-login-grant-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/auth/admin-login-grant-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/auth/strict-login-grant-bundle.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/auth/strict-dingtalk-entry.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/platform-role-assign-command.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/admin/platform-role-assign-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/platform-role-assign-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/platform-role-unassign-command.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/admin/platform-role-unassign-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/platform-role-unassign-command.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/attendance-role-commands.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/admin/attendance-role-commands.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/attendance-role-commands.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/routes/auth.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/routes/attendance-admin.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/routes/admin-users.ts`, '../rbac/authorization-input-lock'],
  [ROLE_PLAN_MODULE, './authorization-input-brand'],
  [ROLE_PLAN_MODULE, './authorization-input-brand'],
  [ROLE_PLAN_MODULE, './authorization-input-lock'],
  [`${SRC}/admin/direct-permission-authority.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/admin/direct-permission-authority.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/direct-permission-authority.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/authorization-exception-compat.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/authorization-exception-write.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/admin/authorization-operation-fence.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/admin/authorization-operation-service.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/db/migration-provider.ts`, '../rbac/authorization-input-lock'],
  [`${SRC}/routes/admin-users.ts`, '../rbac/authorization-input-brand'],
  [`${SRC}/routes/permissions.ts`, '../rbac/authorization-input-lock'],
  [ROLE_PLAN_MODULE, './authorization-input-lock'],
  [ROLE_PLAN_MODULE, './authorization-input-lock'],
]

function contractEdgeProblems(files: readonly string[], sourceOf: (file: string) => string): string[] {
  const problems = importEdgeViolations(contractEdges(files, sourceOf), CONTRACT_IMPORT_ALLOWLIST.filter(([file]) => files.includes(file)))
  if (files.includes(ROLE_PLAN_MODULE)) {
    const tree = ts.createSourceFile(ROLE_PLAN_MODULE, sourceOf(ROLE_PLAN_MODULE), ts.ScriptTarget.Latest, true)
    const imports = tree.statements.filter((statement) => ts.isImportDeclaration(statement) || (ts.isExportDeclaration(statement) && statement.moduleSpecifier))
      .map((statement) => statement.getText(tree).replace(/\s+/g, ' ')).sort()
    const expected = [...ROLE_PLAN_IMPORTS].sort()
    if (imports.length !== expected.length || imports.some((statement, index) => statement !== expected[index])) {
      problems.push('role-plan imports must match the exact static shapes')
    }
  }
  return problems.sort()
}

function contractEdges(files: readonly string[], sourceOf: (file: string) => string): Array<[string, string]> {
  const edges: Array<[string, string]> = []
  for (const file of files) {
    if (CONTRACT_MODULES.includes(file)) continue
    const source = sourceOf(file)
    if (!CONTRACT_SPECIFIER.test(source)) continue
    for (const specifier of importSpecifiers(source)) if (CONTRACT_SPECIFIER.test(specifier)) edges.push([file, specifier])
    if (/(?:require|import)\(\s*['"`][^'"`]*authorization-input-/.test(source)) edges.push([file, '<dynamic>'])
  }
  return edges
}

describe('contract module imports are exact', () => {
  it('only the read-only role-plan helper has the exact production contract edges', () => {
    const sourceFiles = listFiles(REPO_ROOT, { roots: [SRC, 'plugins'], exclude: [] }).filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
    expect(sourceFiles.length).toBeGreaterThan(productionFiles.length)
    expect(sourceFiles.some((file) => file.startsWith(`${SRC}/db/migrations/`))).toBe(true)
    expect(contractEdgeProblems(sourceFiles, read)).toEqual([])
  })

  it('rejects a missing, duplicate, value, namespace, mint, re-export, dynamic or other-file edge', () => {
    const baseline = ROLE_PLAN_IMPORTS.join('\n')
    expect(contractEdgeProblems([ROLE_PLAN_MODULE], () => baseline)).toEqual([])
    expect(contractEdgeProblems([ROLE_PLAN_MODULE], () => baseline.replace(ROLE_PLAN_IMPORTS[3], ''))).toEqual([
      `missing: ${ROLE_PLAN_MODULE} -> ./authorization-input-lock`,
      'role-plan imports must match the exact static shapes',
    ])
    for (const addition of [
      "import type { AuthorizationInputPlan } from './authorization-input-lock'",
      "import { mintAuthorizationInputBrand } from './authorization-input-brand'",
      "export * from './authorization-input-lock'",
      "const load = () => import('./authorization-input-lock')",
      "const load = () => require('./authorization-input-brand')",
    ]) expect(contractEdgeProblems([ROLE_PLAN_MODULE], () => `${baseline}\n${addition}`)).not.toEqual([])
    for (const replacement of [
      "import { AuthorizationInputPlan, AuthorizationInputTx } from './authorization-input-lock'",
      "import * as locks from './authorization-input-lock'",
      "export type { AuthorizationInputPlan, AuthorizationInputTx } from './authorization-input-lock'",
    ]) expect(contractEdgeProblems([ROLE_PLAN_MODULE], () => baseline.replace(ROLE_PLAN_IMPORTS[3], replacement))).toEqual(['role-plan imports must match the exact static shapes'])
    const other = `${SRC}/rbac/unexpected.ts`
    expect(contractEdgeProblems([ROLE_PLAN_MODULE, other], (file) => file === ROLE_PLAN_MODULE ? baseline : ROLE_PLAN_IMPORTS[3])).toEqual([
      `unexpected: ${other} -> ./authorization-input-lock`,
    ])
  })

  it('the brand is minted by the lock module only', () => {
    const minting = listFiles(REPO_ROOT, { roots: [SRC, 'plugins'], exclude: [] })
      .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)) && /\bmintAuthorizationInputBrand\b/.test(read(file)))
      .sort()
    expect(minting).toEqual([`${SRC}/rbac/authorization-input-brand.ts`, LOCK_MODULE])
  })

  it('POSITIVE CONTROL — a static import, a type import, a re-export and a dynamic load are each an edge', () => {
    const cases = [
      "import { x } from './authorization-input-brand'",
      "import type { AuthorizationInputTx } from '../rbac/authorization-input-lock'",
      "export { y } from './authorization-input-classes'",
      "const m = require('./authorization-input-writers')",
      "const m = await import('./authorization-input-consumers')",
    ]
    for (const source of cases) expect(contractEdges(['x.ts'], () => source), source).toHaveLength(1)
    expect(contractEdges(['x.ts'], () => "import { z } from './role-assignment'")).toEqual([])
  })
})

const DIRECT_COMPAT = `${SRC}/admin/authorization-exception-compat.ts`
const DIRECT_ROUTE = `${SRC}/routes/permissions.ts`
const DIRECT_WRITER = `${SRC}/admin/authorization-exception-write.ts`
const DIRECT_CONFIRM = `${SRC}/admin/authorization-operation-service.ts`
const DIRECT_AUTHORIZE = `${SRC}/admin/direct-permission-authority.ts`
const LEGACY_WRITER = `${SRC}/admin/legacy-permission-revoke.ts`
const DIRECT_MODULE_PATTERN = /(?:authorization-exception-(?:compat|write)|direct-permission-authority)/
const compact = (source: string) => source.replace(/\s+/g, ' ').trim()

// A single data-only compatibility root serves the four legacy routes. The confirmed command owns
// its separate receipt transaction. Both call the same branded writer with their own tx.
const DIRECT_IMPORTS: Record<string, string[]> = {
  [DIRECT_ROUTE]: [
    "import { LegacyExceptionReasonInvalid, readLegacyExceptionReason, writeLegacyAuthorizationException } from '../admin/authorization-exception-compat'",
    "import { AuthorizationExceptionWriteError } from '../admin/authorization-exception-write'",
  ],
  [DIRECT_COMPAT]: [
    "import { randomUUID } from 'node:crypto'",
    "import { withAuthorizationInputTransaction } from '../rbac/authorization-input-lock'",
    "import { invalidateUserPerms, listUserPermissions } from '../rbac/service'",
    "import { hasLiveRbacAdmin } from '../rbac/strict-principal'",
    "import { AuthorizationExceptionWriteError, writeAuthorizationException, type AuthorizationExceptionAction } from './authorization-exception-write'",
  ],
  [DIRECT_CONFIRM]: ["import { writeAuthorizationException } from './authorization-exception-write'"],
  [DIRECT_WRITER]: [
    "import { supersedeDeprovisionEvidenceForAccessGraphWrite } from '../directory/access-graph-mutex'",
    "import type { AuthorizationInputTx } from '../rbac/authorization-input-lock'",
    "import { assertPermissionExceptionRoot, checkPermissionExceptionAuthority, type PermissionExceptionRoot } from './direct-permission-authority'",
    "import { revokeLockedLegacyUserPermission } from './legacy-permission-revoke'",
  ],
  [DIRECT_AUTHORIZE]: [
    "import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'",
    "import { AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENTS } from '../rbac/authorization-input-lock'",
    "import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'",
    "import { AccessGraphUserUnavailableError } from '../directory/access-graph-mutex'",
    "import { PlatformActorAuthorityLost } from './platform-actor-authority'",
  ],
  [LEGACY_WRITER]: ["import { assertPermissionExceptionRoot, type PermissionExceptionRoot } from './direct-permission-authority'"],
}
const DIRECT_OWNERS = {
  writeLegacyAuthorizationException: DIRECT_COMPAT,
  writeAuthorizationException: DIRECT_WRITER,
  checkPermissionExceptionAuthority: DIRECT_AUTHORIZE,
} as const
const DIRECT_ROUTE_ACTIONS = [
  "{ kind: 'direct.grant', code: permission }",
  "{ kind: 'direct.revoke', code: permission }",
  "{ kind: 'legacy.revoke', code: permission }",
  "{ kind: 'template.apply', templateId: template.id, codes: template.permissions }",
]
function directPermissionProblems(files: readonly string[], sourceOf: (file: string) => string): string[] {
  const problems: string[] = []
  const declarations: string[] = []
  const calls: string[] = []
  const actions: string[] = []
  const compatibilityCalls: string[] = []
  for (const file of files) {
    const source = sourceOf(file)
    if (!DIRECT_MODULE_PATTERN.test(source) && !Object.keys(DIRECT_OWNERS).some(name => source.includes(name))) continue
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const imports: string[] = []
    function visit(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier &&
        ([DIRECT_COMPAT, DIRECT_WRITER, DIRECT_AUTHORIZE].includes(file) || DIRECT_MODULE_PATTERN.test(node.moduleSpecifier.getText(tree)))) {
        imports.push(compact(node.getText(tree)))
      }
      if (file === DIRECT_COMPAT && ts.isCallExpression(node) && node.expression.getText(tree) === 'withAuthorizationInputTransaction') {
        const callback = node.arguments[1]
        if (node.arguments.length !== 2 || node.arguments[0].getText(tree) !== 'plan' || !ts.isArrowFunction(callback)) problems.push('compatibility transaction')
        else {
          function collectCalls(child: ts.Node) {
            if (ts.isCallExpression(child)) compatibilityCalls.push(child.expression.getText(tree))
            ts.forEachChild(child, collectCalls)
          }
          collectCalls(callback)
        }
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(tree) === 'require')
        && (file === DIRECT_COMPAT || file === DIRECT_WRITER || DIRECT_MODULE_PATTERN.test(node.getText(tree)))) problems.push('dynamic permission command')
      if (ts.isIdentifier(node) && Object.hasOwn(DIRECT_OWNERS, node.text)) {
        const name = node.text as keyof typeof DIRECT_OWNERS
        const parent = node.parent
        if (ts.isFunctionDeclaration(parent) && parent.name === node) {
          declarations.push(`${file}|${name}`)
          const signature = parent.parameters.map(parameter => compact(parameter.getText(tree))).join(',')
          if (name === 'writeLegacyAuthorizationException' && signature !== 'input: { actorId: string userId: string action: CompatibilityAction reason?: string }') problems.push('compatibility input')
          if (name === 'writeAuthorizationException' && signature !== 'tx: AuthorizationInputTx,input: AuthorizationExceptionInput') problems.push('branded writer input')
        } else if (ts.isCallExpression(parent) && parent.expression === node) {
          calls.push(`${file}|${name}`)
          if (name === 'writeLegacyAuthorizationException') {
            const input = parent.arguments[0]
            if (parent.arguments.length !== 1 || !input || !ts.isObjectLiteralExpression(input)) problems.push('route input')
            else {
              const values = input.properties.map(prop => compact(prop.getText(tree)))
              if (values.length !== 4 || values[0] !== 'actorId: adminUserId' || values[1] !== 'userId' ||
                !['reason: readLegacyExceptionReason(reason)', 'reason: readLegacyExceptionReason(req.body.reason)'].includes(values[3])) problems.push('route fields')
              actions.push(values[2])
            }
          } else if (parent.arguments[0]?.getText(tree) !== 'tx') problems.push('permission writer receiver')
        } else if (!(ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName)) problems.push('permission command alias')
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
    if (JSON.stringify(imports.sort()) !== JSON.stringify([...(DIRECT_IMPORTS[file] ?? [])].sort())) problems.push(`permission imports ${file}`)
  }
  const expectedDeclarations = Object.entries(DIRECT_OWNERS).map(([name, file]) => `${file}|${name}`).sort()
  const expectedCalls = [
    ...DIRECT_ROUTE_ACTIONS.map(() => `${DIRECT_ROUTE}|writeLegacyAuthorizationException`),
    `${DIRECT_COMPAT}|writeAuthorizationException`, `${DIRECT_CONFIRM}|writeAuthorizationException`, `${DIRECT_WRITER}|checkPermissionExceptionAuthority`,
  ].sort()
  if (JSON.stringify(declarations.sort()) !== JSON.stringify(expectedDeclarations)) problems.push('permission declarations')
  if (JSON.stringify(calls.sort()) !== JSON.stringify(expectedCalls)) problems.push('permission caller union')
  if (JSON.stringify(actions) !== JSON.stringify(DIRECT_ROUTE_ACTIONS.map(action => 'action: ' + action))) problems.push('permission route actions')
  const expectedCompatibilityCalls = [
    'writeAuthorizationException', 'Object.freeze', 'listUserPermissions', 'hasLiveRbacAdmin', 'randomUUID',
    'changedCodes.map', 'tx.query', 'JSON.stringify', 'JSON.stringify', 'tx.query', 'JSON.stringify',
  ]
  if (JSON.stringify(compatibilityCalls) !== JSON.stringify(expectedCompatibilityCalls)) problems.push('compatibility transaction calls')
  const root = compact(sourceOf(DIRECT_COMPAT))
  for (const fragment of [
    'const subjects = Object.freeze([...new Set([actorId, userId])].sort())',
    "const plan = Object.freeze({ intent: revoking ? 'REVOKE_DIRECT' as const : 'GRANT_DIRECT' as const,",
    'roleIds: Object.freeze([] as string[]), userIds: subjects, admissionUserIds: subjects, witness: Object.freeze({ userIds: subjects, admissionUserIds: subjects }),',
    'withAuthorizationInputTransaction(plan, async (tx) => { const { changedCodes } = await writeAuthorizationException(tx, Object.freeze({ actorId, userId, plan,',
  ]) if (!root.includes(fragment)) problems.push('permission root or actor witnesses')
  return problems
}

describe('direct permission closed commands', () => {
  it('pins the four data-only route calls, two transaction owners, fixed writer and frozen subject witnesses', () => {
    expect(directPermissionProblems(productionFiles, read)).toEqual([])
  })

  it('rejects an undeclared importer, dynamic load, capability alias, injected callback, altered intent, receiver, plan or endpoint', () => {
    const rogue = `${SRC}/admin/unregistered-permission.ts`
    const files = [...new Set([...Object.values(DIRECT_OWNERS), ...Object.keys(DIRECT_IMPORTS)])]
    const mutations = [
      [rogue, '', "import { writeAuthorizationException } from './authorization-exception-write'"],
      [DIRECT_COMPAT, 'writeAuthorizationException, type', 'renamed, type'],
      [DIRECT_COMPAT, 'writeAuthorizationException, type', 'writeAuthorizationException as renamed, type'],
      [DIRECT_COMPAT, 'const { actorId, userId, reason }', "const load = () => import('./authorization-exception-write'); const { actorId, userId, reason }"],
      [DIRECT_COMPAT, 'const profile =', 'await hook(tx); const profile ='],
      [DIRECT_COMPAT, "revoking ? 'REVOKE_DIRECT'", "revoking ? 'GRANT_DIRECT'"],
      [DIRECT_COMPAT, 'userIds: subjects,', 'userIds: [actorId],'],
      [DIRECT_COMPAT, 'action: CompatibilityAction', 'action: CompatibilityAction; runner: Function'],
      [DIRECT_COMPAT, 'await writeAuthorizationException(tx,', 'await writeAuthorizationException(client,'],
      [DIRECT_COMPAT, 'const { changedCodes }', 'const alias = writeAuthorizationException; const { changedCodes }'],
      [DIRECT_WRITER, 'export async function writeAuthorizationException(', 'export async function anotherWrite('],
      [DIRECT_ROUTE, "kind: 'direct.grant', code: permission", "kind: 'direct.revoke', code: permission"],
      [DIRECT_ROUTE, 'actorId: adminUserId, userId, action:', 'actorId: adminUserId, userId, tx, action:'],
    ]
    for (const [file, before, after] of mutations) {
      const original = file === rogue ? '' : read(file)
      expect(original.includes(before)).toBe(true)
      const changed = original.replace(before, after)
      expect(directPermissionProblems(file === rogue ? [...files, rogue] : files, f => f === file ? changed : read(f)), after).not.toEqual([])
    }
    const writer = AUTHORIZATION_INPUT_WRITERS.find(entry => entry.id === 'W-04')!
    const source = read(writer.file)
    const bypass = source.replace(/tx\.query\((?=['"`]INSERT INTO user_permissions)/, 'pool.query(')
    expect(bypass).not.toBe(source)
    expect(conversionProblems(writer, bypass, scanSource(writer.file, bypass).writes)).not.toEqual([])
  })
})

const PLATFORM_ROLE_COMMAND = `${SRC}/admin/platform-role-assign-command.ts`
const PLATFORM_ROLE_UNASSIGN_COMMAND = `${SRC}/admin/platform-role-unassign-command.ts`
const PLATFORM_ROLE_ROUTE = `${SRC}/routes/admin-users.ts`
const PLATFORM_ROLE_IMPORTS: Record<string, readonly string[]> = {
  "packages/core-backend/src/admin/admin-user-birth-command.ts": [
    "import * as crypto from 'crypto'",
    "import { ATTENDANCE_SELF_SERVICE_NAMESPACE } from '../auth/attendanceSelfServiceBackfill'",
    "import { claimNonEmptyLoginAliasesOrThrow } from '../auth/login-alias-service'",
    "import { buildAttendanceTimezoneRuntimeOrgLockKeyV1 } from '../attendance/attendance-timezone-runtime-locks'",
    "import { parseCanonicalAttendanceRolloutOrgKeyV1, resolveSegmentCalculationPosture, tryAcquireAttendanceCalculationRolloutLockForBirthV1, } from '../attendance/w4c0-identity'",
    "import type { CanonicalAttendanceRolloutOrgKeyV1 } from '../attendance/w4c0-identity'",
    "import { PlatformActorAuthorityLost } from './platform-actor-authority'",
    "import { RoleRowMissingError } from './role-row-contract'",
    "import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'",
    "import { AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENTS, AuthorizationInputBusyError, withAuthorizationInputTransaction, } from '../rbac/authorization-input-lock'",
    "import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'",
    "import { deriveGrantNamespaces, grantNamespaceAdmissions, isNamespaceAdmissionControlledResource, writeUserNamespaceAdmission, } from '../rbac/namespace-admission'",
    "import { assignUserRoles } from '../rbac/role-assignment'",
  ],
  "packages/core-backend/src/admin/admin-user-batch-birth-command.ts": [
    "import { ATTENDANCE_SELF_SERVICE_NAMESPACE } from '../auth/attendanceSelfServiceBackfill'",
    "import { claimNonEmptyLoginAliasesOrThrow } from '../auth/login-alias-service'",
    "import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'",
    "import { AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENTS, withAuthorizationInputTransaction, } from '../rbac/authorization-input-lock'",
    "import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'",
    "import { writeUserNamespaceAdmission } from '../rbac/namespace-admission'",
    "import { assignUserRoles } from '../rbac/role-assignment'",
    "import { assertPlatformActorAuthority, PlatformActorAuthorityLost } from './platform-actor-authority'",
    "import { RoleRowMissingError } from './role-row-contract'",
  ],
  "packages/core-backend/src/admin/platform-role-unassign-command.ts": [
      "import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'",
      "import { AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENTS, withAuthorizationInputTransaction, } from '../rbac/authorization-input-lock'",
      "import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'",
      "import { unassignUserRoles } from '../rbac/role-assignment'",
      "import type { RoleAssignmentResult } from '../rbac/role-assignment'",
      "import { disableNamespaceAdmissionsWithoutRoles, listRoleNamespaces } from '../rbac/namespace-admission'",
      "import { AccessGraphUserUnavailableError } from '../directory/access-graph-mutex'",
      "import { assertPlatformActorAuthority, PlatformActorAuthorityLost } from './platform-actor-authority'",
      "import { isLastSignInPlatformAdmin } from './user-recycle'",
      "import { syncLegacyAdminProfile } from './legacy-admin-profile'"
  ],
  "packages/core-backend/src/admin/platform-role-assign-command.ts": [
    "import { assertAuthorizationInputTx, AuthorizationInputContractError } from '../rbac/authorization-input-brand'",
    "import { AUTHORIZATION_INPUT_LOCK_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENT_TIMEOUT_MS, AUTHORIZATION_INPUT_STATEMENTS, withAuthorizationInputTransaction, } from '../rbac/authorization-input-lock'",
    "import type { AuthorizationInputPlan, AuthorizationInputTx } from '../rbac/authorization-input-lock'",
    "import { assignUserRoles } from '../rbac/role-assignment'",
    "import type { RoleAssignmentResult } from '../rbac/role-assignment'",
    "import { AccessGraphUserUnavailableError } from '../directory/access-graph-mutex'",
    "import { assertPlatformActorAuthority, PlatformActorAuthorityLost } from './platform-actor-authority'",
    "import { lockRoleRowForShare, RoleRowMissingError } from './role-row-contract'",
    "import { syncLegacyAdminProfile } from './legacy-admin-profile'"
  ],
  "packages/core-backend/src/admin/role-row-contract.ts": [
    "import type { AccessGraphTransactionClient } from '../directory/access-graph-mutex'"
  ],
  "packages/core-backend/src/admin/legacy-admin-profile.ts": [],
  "packages/core-backend/src/routes/admin-users.ts": [
    "import { assignPlatformUserRoleCommand } from '../admin/platform-role-assign-command'",
    "import { unassignPlatformUserRoleCommand } from '../admin/platform-role-unassign-command'",
    "import { lockRoleRowForShare, RoleModifiedError, RoleRowMissingError } from '../admin/role-row-contract'",
    "import { syncLegacyAdminProfile } from '../admin/legacy-admin-profile'",
    "import { AuthorizationInputBusyError } from '../rbac/authorization-input-lock'"
  ]
}
const PLATFORM_ROLE_FUNCTION = "export async function assignPlatformUserRoleCommand(input: PlatformRoleAssignInput): Promise<RoleAssignmentResult> {\n  const { actorId, userId, roleId, expectedUpdatedAt } = input\n  const subjects = Object.freeze([...new Set([actorId, userId])].sort())\n  const plan: AuthorizationInputPlan = Object.freeze({\n    intent: 'GRANT_ROLE',\n    roleIds: Object.freeze([roleId]),\n    userIds: subjects,\n    admissionUserIds: subjects,\n    witness: Object.freeze({ userIds: subjects, admissionUserIds: subjects }),\n  })\n  const context = Object.freeze({ actorId, userId, roleId, expectedUpdatedAt, action: 'platform-role-assign' as const, plan })\n  return withAuthorizationInputTransaction(context.plan, async (tx) => {\n    assertContext(tx, context)\n    const roleState = tx.roleRows.get(context.roleId)\n    if (roleState === 'missing') throw new RoleRowMissingError()\n    if (roleState !== 'held') invalidContext()\n    if (!await lockRoleRowForShare(tx, context.roleId, context.expectedUpdatedAt)) throw new RoleRowMissingError()\n    const target = tx.locked.get(context.userId)\n    if (!target) throw new AccessGraphUserUnavailableError('NOT_FOUND')\n    if (target.deletedAt || target.purgedAt) throw new AccessGraphUserUnavailableError('USER_IN_RECYCLE_BIN')\n    const actor = tx.locked.get(context.actorId)\n    await assertPlatformActorAuthority(tx, actor)\n    if (actor!.role !== 'admin') await stabilizeMembership(tx, context)\n    assertContext(tx, context)\n    if (tx.roleRows.get(context.roleId) !== 'held'\n      || !tx.locked.has(context.actorId) || !tx.locked.has(context.userId)\n      || !tx.witnessed.userIds.has(context.actorId) || !tx.witnessed.userIds.has(context.userId)) invalidContext()\n    const assigned = await assignUserRoles({\n      userIds: [context.userId],\n      roleId: context.roleId,\n      assignmentSource: 'manual',\n      scope: { kind: 'platform-admin' },\n      executor: tx,\n    })\n    if (context.roleId === 'admin') {\n      await syncLegacyAdminProfile(context.userId, true, (sql, params) => tx.query(sql, params))\n    }\n    return assigned\n  })\n}"
const PLATFORM_ROLE_UNASSIGN_FUNCTION = "export async function unassignPlatformUserRoleCommand(input: PlatformRoleUnassignInput): Promise<PlatformRoleUnassignResult> {\n  const { actorId, userId, roleId } = input\n  const subjects = Object.freeze([...new Set([actorId, userId])].sort())\n  const plan: AuthorizationInputPlan = Object.freeze({\n    intent: 'REVOKE_ROLE',\n    roleIds: Object.freeze([roleId]),\n    userIds: subjects,\n    admissionUserIds: subjects,\n    witness: Object.freeze({ userIds: subjects, admissionUserIds: subjects }),\n    ...(roleId === 'admin' ? { platformAdminInvariant: true } : {}),\n  })\n  const context = Object.freeze({ actorId, userId, roleId, action: 'platform-role-unassign' as const, plan })\n  return withAuthorizationInputTransaction(context.plan, async (tx) => {\n    assertContext(tx, context)\n    if (context.roleId === 'admin' && await isLastSignInPlatformAdmin(tx, context.userId)) return { blocked: true }\n    const target = tx.locked.get(context.userId)\n    if (!target) throw new AccessGraphUserUnavailableError('NOT_FOUND')\n    if (target.deletedAt || target.purgedAt) throw new AccessGraphUserUnavailableError('USER_IN_RECYCLE_BIN')\n    const actor = tx.locked.get(context.actorId)\n    await assertPlatformActorAuthority(tx, actor)\n    if (actor!.role !== 'admin') await stabilizeMembership(tx, context)\n    assertContext(tx, context)\n    if (!tx.locked.has(context.actorId) || !tx.locked.has(context.userId)\n      || !tx.witnessed.userIds.has(context.actorId) || !tx.witnessed.userIds.has(context.userId)) invalidContext()\n    const membership = await unassignUserRoles({\n      userIds: [context.userId],\n      roleId: context.roleId,\n      scope: { kind: 'platform-admin' },\n      executor: tx,\n    })\n    const disabledNamespaces = await disableNamespaceAdmissionsWithoutRoles({\n      userId: context.userId,\n      namespaces: await listRoleNamespaces(context.roleId, tx.query),\n      actorId: context.actorId,\n      source: 'role_unassigned',\n      revokedRoleId: context.roleId,\n    }, tx.query)\n    if (context.roleId === 'admin') {\n      await syncLegacyAdminProfile(context.userId, false, (sql, params) => tx.query(sql, params))\n    }\n    return { blocked: false, membership, disabledNamespaces }\n  })\n}"
const PLATFORM_ROLE_MODULE = /platform-role-|role-row-contract|legacy-admin-profile/

function platformRoleAssignProblems(files: readonly string[], sourceOf: (file: string) => string): string[] {
  const problems: string[] = []
  const calls: Record<string, string[]> = {}
  let commandDeclarations = 0
  let unassignDeclarations = 0
  for (const file of files) {
    const source = sourceOf(file)
    if (!PLATFORM_ROLE_MODULE.test(source) && !Object.hasOwn(PLATFORM_ROLE_IMPORTS, file)
      && !source.includes('assignPlatformUserRoleCommand') && !source.includes('syncLegacyAdminProfile')) continue
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const imports: string[] = []
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : ''
        const selected = file === PLATFORM_ROLE_ROUTE ? PLATFORM_ROLE_MODULE.test(specifier) || /authorization-input-lock/.test(specifier)
          : Object.hasOwn(PLATFORM_ROLE_IMPORTS, file) || PLATFORM_ROLE_MODULE.test(specifier)
        if (selected) imports.push(compact(node.getText(tree)))
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(tree)
        if ((callee === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword)
          && ((file !== PLATFORM_ROLE_ROUTE && Object.hasOwn(PLATFORM_ROLE_IMPORTS, file)) || PLATFORM_ROLE_MODULE.test(node.getText(tree)))) problems.push('platform role dynamic load')
        if (['assignPlatformUserRoleCommand', 'unassignPlatformUserRoleCommand', 'syncLegacyAdminProfile', 'lockRoleRowForShare'].includes(callee)) {
          ;(calls[callee] ??= []).push(file)
          if (callee === 'assignPlatformUserRoleCommand'
            && (file !== PLATFORM_ROLE_ROUTE || node.arguments.length !== 1
              || compact(node.arguments[0].getText(tree)) !== '{ actorId: adminUserId, userId, roleId, expectedUpdatedAt }')) problems.push('platform role route data call')
          if (callee === 'unassignPlatformUserRoleCommand'
            && (file !== PLATFORM_ROLE_ROUTE || node.arguments.length !== 1
              || compact(node.arguments[0].getText(tree)) !== '{ actorId: adminUserId, userId, roleId }')) problems.push('platform role unassign data call')
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'assignPlatformUserRoleCommand') {
        commandDeclarations += 1
        if (file !== PLATFORM_ROLE_COMMAND || compact(node.getText(tree)) !== compact(PLATFORM_ROLE_FUNCTION)) problems.push('platform role fixed producer')
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'unassignPlatformUserRoleCommand') {
        unassignDeclarations += 1
        if (file !== PLATFORM_ROLE_UNASSIGN_COMMAND || compact(node.getText(tree)) !== compact(PLATFORM_ROLE_UNASSIGN_FUNCTION)) problems.push('platform role unassign fixed producer')
      }
      if (ts.isIdentifier(node) && ['assignPlatformUserRoleCommand', 'unassignPlatformUserRoleCommand'].includes(node.text)) {
        const parent = node.parent
        if (!((ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName)
          || (ts.isFunctionDeclaration(parent) && parent.name === node)
          || (ts.isCallExpression(parent) && parent.expression === node))) problems.push('platform role command alias')
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
    if (JSON.stringify(imports.sort()) !== JSON.stringify([...(PLATFORM_ROLE_IMPORTS[file] ?? [])].sort())) problems.push(`platform role exact imports ${file}`)
  }
  if (commandDeclarations !== 1) problems.push('platform role declaration census')
  if (unassignDeclarations !== 1) problems.push('platform role unassign declaration census')
  const expected: Record<string, string[]> = {
    assignPlatformUserRoleCommand: [PLATFORM_ROLE_ROUTE],
    unassignPlatformUserRoleCommand: [PLATFORM_ROLE_ROUTE],
    syncLegacyAdminProfile: [DIRECT_CONFIRM, PLATFORM_ROLE_COMMAND, PLATFORM_ROLE_UNASSIGN_COMMAND, PLATFORM_ROLE_ROUTE, PLATFORM_ROLE_ROUTE],
    lockRoleRowForShare: [PLATFORM_ROLE_COMMAND, PLATFORM_ROLE_ROUTE],
  }
  for (const [symbol, expectedFiles] of Object.entries(expected)) {
    if (JSON.stringify((calls[symbol] ?? []).sort()) !== JSON.stringify(expectedFiles.sort())) problems.push(`platform role caller union ${symbol}`)
  }
  return problems
}

describe('single platform role assign producer boundary', () => {
  it('rejects unassign capability injection, incomplete plans, missing R1 and a changed fixed receiver', () => {
    const baseline = read(PLATFORM_ROLE_UNASSIGN_COMMAND)
    const relevant = Object.keys(PLATFORM_ROLE_IMPORTS)
    const mutations = [
      baseline.replace('input: PlatformRoleUnassignInput', 'input: PlatformRoleUnassignInput, runner: Function'),
      baseline.replace("intent: 'REVOKE_ROLE'", "intent: 'GRANT_ROLE'"),
      baseline.replace('userIds: subjects,', 'userIds: [actorId],'),
      baseline.replace('roleIds: Object.freeze([roleId])', 'roleIds: Object.freeze([])'),
      baseline.replace("...(roleId === 'admin' ? { platformAdminInvariant: true } : {}),", ''),
      baseline.replace('executor: tx', 'executor: pool'),
      baseline.replace('async (tx) => {', 'async (tx) => { await hook(tx);'),
      baseline.replace("import { unassignUserRoles }", "import * as unassignUserRoles"),
      baseline + "\nconst load = () => import('./platform-role-unassign-command')",
      baseline + '\nconst alias = unassignPlatformUserRoleCommand',
      baseline.replace('await syncLegacyAdminProfile(context.userId, false, (sql, params) => tx.query(sql, params))', 'await pool.query(sql)'),
    ]
    expect(platformRoleAssignProblems(productionFiles, read)).toEqual([])
    for (const [index, changed] of mutations.entries()) {
      expect(changed, `unassign control ${index}`).not.toBe(baseline)
      expect(platformRoleAssignProblems(relevant, file => file === PLATFORM_ROLE_UNASSIGN_COMMAND ? changed : read(file)), `unassign control ${index}`).not.toEqual([])
    }
    const rogue = `${SRC}/admin/rogue-platform-role-unassign.ts`
    expect(platformRoleAssignProblems([...relevant, rogue], file => file === rogue ? "import { unassignPlatformUserRoleCommand } from './platform-role-unassign-command'" : read(file))).not.toEqual([])
    const duplicate = baseline + '\n' + PLATFORM_ROLE_UNASSIGN_FUNCTION
    expect(platformRoleAssignProblems(relevant, file => file === PLATFORM_ROLE_UNASSIGN_COMMAND ? duplicate : read(file))).not.toEqual([])
  })
  it('pins the one data-only producer and unchanged helper caller union without converting shared writers', () => {
    expect(platformRoleAssignProblems(productionFiles, read)).toEqual([])
    for (const id of ['W-01', 'W-02', 'W-03', 'W-08']) expect(AUTHORIZATION_INPUT_WRITERS.find(writer => writer.id === id)?.status).toBe('pending')
    expect(AUTHORIZATION_INPUT_WRITERS.find(writer => writer.id === 'W-08')?.file).toBe(`${SRC}/admin/legacy-admin-profile.ts`)
  })

  it('rejects altered producer shape, API, intent, plans, callback, receiver, imports or helper union', () => {
    const baseline = read(PLATFORM_ROLE_COMMAND)
    const relevant = Object.keys(PLATFORM_ROLE_IMPORTS)
    const rogue = `${SRC}/admin/rogue-platform-role.ts`
    const mutations = [
      baseline.replace('input: PlatformRoleAssignInput', 'input: PlatformRoleAssignInput, runner: Function'),
      baseline.replace("intent: 'GRANT_ROLE'", "intent: 'REVOKE_ROLE'"),
      baseline.replace('userIds: subjects,', 'userIds: [actorId],'),
      baseline.replace('roleIds: Object.freeze([roleId])', 'roleIds: Object.freeze([])'),
      baseline.replace('executor: tx', 'executor: pool'),
      baseline.replace('async (tx) => {', 'async (tx) => { await hook(tx);'),
      baseline.replace("import { assignUserRoles }", "import * as assignUserRoles"),
      baseline.replace("import { assignUserRoles }", "import assignUserRoles"),
      baseline + "\nconst load = () => import('./legacy-admin-profile')",
      baseline + "\nconst alias = assignPlatformUserRoleCommand",
      baseline.replace('await syncLegacyAdminProfile(context.userId, true, (sql, params) => tx.query(sql, params))', 'await pool.query(sql)'),
    ]
    for (const [index, changed] of mutations.entries()) expect(platformRoleAssignProblems(relevant, file => file === PLATFORM_ROLE_COMMAND ? changed : read(file)), `platform producer negative ${index}`).not.toEqual([])
    const duplicate = baseline + '\n' + PLATFORM_ROLE_FUNCTION
    expect(platformRoleAssignProblems(relevant, file => file === PLATFORM_ROLE_COMMAND ? duplicate : read(file))).not.toEqual([])
    expect(platformRoleAssignProblems([...relevant, rogue], file => file === rogue ? "import { assignPlatformUserRoleCommand } from './platform-role-assign-command'" : read(file))).not.toEqual([])
    const missingLegacy = read(PLATFORM_ROLE_ROUTE).replace('await syncLegacyAdminProfile(userId, false, runQuery)', 'await unrelated()')
    expect(platformRoleAssignProblems(relevant, file => file === PLATFORM_ROLE_ROUTE ? missingLegacy : read(file))).not.toEqual([])
  })
})

function preparedReaderIdentityProblems(tree: ts.SourceFile, uses: readonly ts.Node[]): string[] {
  const problems: string[] = []
  const owners = tree.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'resolveAdminGrantTargetSet')
  const owner = owners[0]
  if (owners.length !== 1 || !owner.body || !owner.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    || owner.parameters.map(parameter => parameter.name.getText(tree)).join(',') !== 'tx,context,intent,phase'
    || owner.parameters.some(parameter => parameter.initializer || parameter.questionToken || parameter.dotDotDotToken)) return ['prepared reader owner binding']
  const declarations = owner.body.statements.filter(ts.isVariableStatement).flatMap(statement =>
    statement.declarationList.declarations.map(declaration => ({ statement, declaration })))
  const normalized = declarations.filter(({ declaration }) => ts.isIdentifier(declaration.name) && declaration.name.text === 'normalized')
  const binding = normalized[0]
  const initializer = binding?.declaration.initializer
  if (normalized.length !== 1 || !(binding.statement.declarationList.flags & ts.NodeFlags.Const)
    || !initializer || !ts.isCallExpression(initializer) || initializer.questionDotToken
    || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'normalizeIntent'
    || initializer.arguments.length !== 1 || !ts.isIdentifier(initializer.arguments[0]) || initializer.arguments[0].text !== 'intent') problems.push('prepared reader normalized binding')
  const use = uses[0]
  const access = use?.parent
  const call = access?.parent
  const argument = call && ts.isCallExpression(call) ? call.arguments[0] : undefined
  const element = argument && ts.isArrayLiteralExpression(argument) ? argument.elements[0] : undefined
  let callOwner: ts.Node | undefined = call?.parent
  while (callOwner && !ts.isFunctionDeclaration(callOwner) && !ts.isFunctionExpression(callOwner) && !ts.isArrowFunction(callOwner) && !ts.isMethodDeclaration(callOwner)) callOwner = callOwner.parent
  if (uses.length !== 1 || !use || !ts.isIdentifier(use) || use.text !== 'requireIdentityRead'
    || !access || !ts.isPropertyAccessExpression(access) || access.questionDotToken || access.name !== use
    || !ts.isIdentifier(access.expression) || access.expression.text !== 'tx'
    || !call || !ts.isCallExpression(call) || call.expression !== access || call.questionDotToken || call.arguments.length !== 1
    || !argument || !ts.isArrayLiteralExpression(argument) || argument.elements.length !== 1
    || !element || !ts.isPropertyAccessExpression(element) || element.questionDotToken || element.name.text !== 'connectionId'
    || !ts.isIdentifier(element.expression) || element.expression.text !== 'normalized' || callOwner !== owner) problems.push('prepared reader exact identity assertion')
  let normalizedBindings = 0
  const protectedNames = new Set(['tx', 'intent', 'normalized', 'normalizeIntent'])
  const visitBindings = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      const name = node.name
      if (name && ts.isIdentifier(name) && protectedNames.has(name.text)) {
        if (ts.isVariableDeclaration(node) && name.text === 'normalized') normalizedBindings += 1
        else problems.push('prepared reader shadowed binding')
      } else if (name && /\b(?:tx|intent|normalized|normalizeIntent)\b/.test(name.getText(tree))) problems.push('prepared reader shadowed binding')
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && /^(?:tx|intent|normalized)(?:\.|\[|$)/.test(node.left.getText(tree))) problems.push('prepared reader reassigned binding')
    ts.forEachChild(node, visitBindings)
  }
  visitBindings(owner.body)
  if (normalizedBindings !== 1) problems.push('prepared reader shadowed normalization')
  const forbidden = new Set([...FORBIDDEN_IN_WORK, 'withAuthorizationInputTransaction', 'enterAuthorizationInputTransaction', 'acquireSourceSyncFreezeLock', 'lockUsersForAccessGraphWrite', 'lockNamespaceAdmissionWrites'])
  const visitAcquisitions = (node: ts.Node) => {
    if (ts.isIdentifier(node) && forbidden.has(node.text)) problems.push('prepared reader forbidden acquisition or side effect')
    if (ts.isStringLiteralLike(node) && (node.text === 'MAINTENANCE' || /\bpg_(?:try_)?advisory_(?:xact_)?lock(?:_shared)?\b|\bLOCK\s+TABLE\b|\b(?:INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i.test(blankSqlComments(node.text)))) problems.push('prepared reader direct lock or write')
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['acquire', 'transaction', 'insertInto', 'updateTable', 'deleteFrom'].includes(node.expression.name.text)) problems.push('prepared reader late acquisition or write')
    ts.forEachChild(node, visitAcquisitions)
  }
  visitAcquisitions(tree)
  return [...new Set(problems)]
}

function grantIssuerIdentityProblems(tree: ts.SourceFile, uses: readonly ts.Node[]): string[] {
  const problems: string[] = []
  const owners = tree.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'readIssueSnapshot')
  const owner = owners[0]
  const parameterNames = owner?.parameters.map((parameter) => parameter.name.getText(tree)) ?? []
  if (owners.length !== 1 || !owner || !owner.body || owner.parent !== tree
    || !owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    || parameterNames[0] !== 'tx' || !parameterNames.includes('intent')
    || owner.parameters.some((parameter) => parameter.initializer || parameter.questionToken || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name))) return ['grant issuer identity slot']
  const use = uses[0]
  const access = use?.parent
  const call = access?.parent
  const argument = call && ts.isCallExpression(call) ? call.arguments[0] : undefined
  const element = argument && ts.isArrayLiteralExpression(argument) ? argument.elements[0] : undefined
  if (uses.length !== 1 || !use || !ts.isIdentifier(use) || use.text !== 'requireIdentityRead'
    || !access || !ts.isPropertyAccessExpression(access) || access.questionDotToken || access.name !== use
    || !ts.isIdentifier(access.expression) || access.expression.text !== 'tx'
    || !call || !ts.isCallExpression(call) || call.expression !== access || call.questionDotToken || call.arguments.length !== 1 || call.typeArguments
    || !argument || !ts.isArrayLiteralExpression(argument) || argument.elements.length !== 1
    || !element || !ts.isPropertyAccessExpression(element) || element.questionDotToken || element.name.text !== 'connectionId'
    || !ts.isIdentifier(element.expression) || element.expression.text !== 'intent'
    || !ts.isExpressionStatement(call.parent) || call.parent.expression !== call || call.parent.parent !== owner.body) problems.push('grant issuer identity slot')
  const writesProtected = (node: ts.Node): boolean => {
    let found = false
    const visit = (current: ts.Node) => {
      if (found) return
      if (ts.isIdentifier(current) && (current.text === 'tx' || current.text === 'intent')) found = true
      else ts.forEachChild(current, visit)
    }
    visit(node)
    return found
  }
  const visitBindings = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      const name = node.name
      if (name && ts.isIdentifier(name) && (name.text === 'tx' || name.text === 'intent')) problems.push('grant issuer identity slot')
      else if (name && /\b(?:tx|intent)\b/.test(name.getText(tree))) problems.push('grant issuer identity slot')
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && writesProtected(node.left)) problems.push('grant issuer identity slot')
    ts.forEachChild(node, visitBindings)
  }
  visitBindings(owner.body)
  return [...new Set(problems)]
}

function assignmentWrites(root: ts.Node, name: string): boolean {
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      let writes = false
      const left = (current: ts.Node) => {
        if (writes) return
        if (ts.isIdentifier(current) && current.text === name) writes = true
        else ts.forEachChild(current, left)
      }
      left(node.left)
      if (writes) found = true
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function entryPortIdentityProblems(file: string, source: string): string[] {
  const port = ENTRY_OPTION_PORTS.find((item) => item.file === file && (item.owner === 'runRoot' || item.owner === 'issueOnRoot'))
  if (!port) return ['identity slot production caller']
  const problems = [...portFileProblems(file, source), ...entryOptionProblems(file, source)]
  const { tree, calls } = entryCalls(file, source)
  const identityUses: ts.Node[] = []
  const collect = (node: ts.Node) => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && ['identityRead', 'requireIdentityRead'].includes(node.text)) identityUses.push(node)
    ts.forEachChild(node, collect)
  }
  collect(tree)
  const counted = calls.filter((call) => call.counted && call.owner === port.owner)
  const use = identityUses[0]
  const entry = counted[0]?.node
  const work = entry?.arguments[1]
  const outerName = port.owner === 'runRoot' ? 'connectionId' : 'snapshot'
  if (identityUses.length !== 1 || counted.length !== 1 || !use || !ts.isIdentifier(use) || !entry || !work || !ts.isArrowFunction(work) || !ts.isBlock(work.body)) {
    problems.push('identity slot production caller')
    return [...new Set(problems)]
  }
  const access = use.parent
  const invocation = access?.parent
  const argument = invocation && ts.isCallExpression(invocation) ? invocation.arguments[0] : undefined
  const element = argument && ts.isArrayLiteralExpression(argument) ? argument.elements[0] : undefined
  const receiver = !!access && ts.isPropertyAccessExpression(access) && !access.questionDotToken && access.name === use && ts.isIdentifier(access.expression) && access.expression.text === 'tx'
  const target = port.owner === 'runRoot'
    ? !!element && ts.isIdentifier(element) && element.text === 'connectionId'
    : !!element && ts.isPropertyAccessExpression(element) && !element.questionDotToken && element.name.text === 'connectionId' && ts.isIdentifier(element.expression) && element.expression.text === 'snapshot'
  const direct = !!invocation && ts.isCallExpression(invocation) && invocation.expression === access && !invocation.questionDotToken && invocation.arguments.length === 1 && !invocation.typeArguments
    && !!argument && ts.isArrayLiteralExpression(argument) && argument.elements.length === 1
    && ts.isExpressionStatement(invocation.parent) && invocation.parent.expression === invocation && invocation.parent.parent === work.body
  const parameter = work.parameters[0]
  const callbackTx = work.parameters.length === 1 && !!parameter && ts.isIdentifier(parameter.name) && parameter.name.text === 'tx' && !parameter.initializer && !parameter.questionToken && !parameter.dotDotDotToken
  const outer = parentFunction(entry)
  const outerBody = outer?.body
  const outerParameter = !!outerBody && outer?.name?.text === port.owner && !!outer?.parameters.some((item) => ts.isIdentifier(item.name) && item.name.text === outerName)
  const shadowed = !callbackTx || !outerParameter || !outerBody
    || subtreeDeclares(work.body, 'tx') || assignmentWrites(work.body, 'tx')
    || subtreeDeclares(outerBody, outerName) || assignmentWrites(outerBody, outerName)
  if (!receiver || !target || !direct || shadowed) problems.push('identity slot production caller')
  return [...new Set(problems)]
}

function identitySlotProblems(file: string, source: string): string[] {
  const problems: string[] = []
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const identityShared = "SELECT pg_advisory_xact_lock_shared(hashtext('directory:identity-maintenance'))"
  const identityExclusive = "SELECT pg_advisory_xact_lock(hashtext('directory:identity-maintenance'))"
  const identitySites: Array<{ literal: string; owner: string | undefined }> = []
  let helperCalls = 0
  let identityUse = false
  const identityUses: ts.Node[] = []
  let sourceHelperImport = false
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && node.text.includes('directory:identity-maintenance')) {
      const sql = blankSqlComments(node.text)
      const calls = sql.includes('directory:identity-maintenance') ? sql.matchAll(/\bpg_(?:try_)?advisory_(?:xact_)?lock(?:_shared)?\b/gi) : []
      for (const _call of calls) {
        identitySites.push({ literal: node.text, owner: enclosingFunctionAt(file, source, node.getStart(tree))?.name })
      }
    }
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && ['identityRead', 'requireIdentityRead'].includes(node.text)) {
      identityUse = true
      identityUses.push(node)
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.endsWith('/source-sync-freeze-lock')) sourceHelperImport = true
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'acquireSourceSyncFreezeLock') helperCalls += 1
    ts.forEachChild(node, visit)
  }
  visit(tree)
  const helperSites: Record<string, number> = {
    [LOCK_MODULE]: 1,
    [`${SRC}/directory/controlled-handover.ts`]: 1,
    [`${SRC}/directory/org-transfer-service.ts`]: 2,
    [`${SRC}/directory/directory-sync.ts`]: 1,
    [`${SRC}/directory/source-sync-freeze-lock.ts`]: 0,
  }
  if (file === LOCK_MODULE) {
    if (identitySites.length !== 1 || identitySites[0].literal !== identityShared || identitySites[0].owner !== 'acquireLocks') problems.push('central shared R2 shape')
    if (!source.includes('await acquireSourceSyncFreezeLock({ query }, sourceId)')) problems.push('central R2F helper shape')
  } else {
    const legacyOwner = file === `${SRC}/auth/dingtalk-identity-repair.ts` ? 'lock'
      : file === `${SRC}/directory/controlled-handover.ts` ? 'lockPair' : undefined
    if (legacyOwner) {
      if (identitySites.length !== 1 || identitySites[0].literal !== identityExclusive || identitySites[0].owner !== legacyOwner) problems.push('legacy R2 shape')
    } else if (identitySites.length !== 0) problems.push('identity R2 bypass')
  }
  if (file === ADMIN_GRANT_RECEIVING_READER_MODULE) problems.push(...preparedReaderIdentityProblems(tree, identityUses))
  else if (file === ADMIN_GRANT_PROOF_MODULE) problems.push(...grantIssuerIdentityProblems(tree, identityUses))
  else if (file === ENTRY_OPTION_PORTS[0].file || file === ENTRY_OPTION_PORTS[2].file) problems.push(...entryPortIdentityProblems(file, source))
  else if (identityUse && file !== LOCK_MODULE && file !== ROLE_PLAN_MODULE) problems.push('identity slot production caller')
  if (helperCalls !== (helperSites[file] ?? 0) || (sourceHelperImport && !Object.hasOwn(helperSites, file))) problems.push('source helper sites')
  return problems
}

describe('identity slot acquisition is central and closed', () => {
  it('accepts the coherent production baseline', () => {
    for (const file of productionFiles) expect(identitySlotProblems(file, read(file)), file).toEqual([])
  })

  it('admits only the named dormant reader metadata assertion and rejects its altered bindings or acquisitions', () => {
    const baseline = 'export async function resolveAdminGrantTargetSet(tx, context, intent, phase) { const normalized = normalizeIntent(intent); tx.requireIdentityRead([normalized.connectionId]); }'
    expect(identitySlotProblems(ADMIN_GRANT_RECEIVING_READER_MODULE, baseline)).toEqual([])
    const assertion = 'tx.requireIdentityRead([normalized.connectionId])'
    const mutations = [
      baseline.replace(assertion, 'void 0'),
      baseline.replace(assertion, `${assertion}; ${assertion}`),
      baseline.replace(assertion, 'other.requireIdentityRead([normalized.connectionId])'),
      baseline.replace(assertion, 'tx.requireIdentityRead([])'),
      baseline.replace(assertion, 'tx.requireIdentityRead([context.connectionId])'),
      baseline.replace(assertion, 'tx.requireIdentityRead([normalized.connectionId, other])'),
      baseline.replace(assertion, 'const detached = tx.requireIdentityRead'),
      baseline.replace(assertion, `const nested = () => ${assertion}`),
      baseline.replace(assertion, `{ const normalized = intent; ${assertion} }`),
      baseline.replace(assertion, `((tx) => ${assertion})(other)`),
      baseline.replace('const normalized', 'let normalized'),
      baseline.replace(assertion, `normalized = intent; ${assertion}`),
      baseline.replace(assertion, 'tx?.requireIdentityRead([normalized.connectionId])'),
      baseline.replace(assertion, "tx['requireIdentityRead']([normalized.connectionId])"),
      baseline.replace('resolveAdminGrantTargetSet', 'differentOwner'),
      `${baseline}\nconst plan = { identityRead: { sourceIntegrationIds: [] } }`,
      `${baseline}\nwithAuthorizationInputTransaction(plan, work)`,
      `${baseline}\nenterAuthorizationInputTransaction(client, plan)`,
      `${baseline}\ntx.acquire({ userIds: [] })`,
      `${baseline}\nrunGatedPullSourceWrite()`,
      `${baseline}\nacquireSourceSyncFreezeLock(client, sourceId)`,
      `${baseline}\nawait tx.query("SELECT pg_advisory_xact_lock_shared(hashtext('directory:identity-maintenance'))")`,
    ]
    for (const [index, source] of mutations.entries()) expect(identitySlotProblems(ADMIN_GRANT_RECEIVING_READER_MODULE, source), `prepared metadata mutation ${index}`).not.toEqual([])
    expect(identitySlotProblems(`${SRC}/auth/other-prepared-reader.ts`, baseline)).not.toEqual([])
  })

  it('admits only the grant issuer metadata assertion inside readIssueSnapshot', () => {
    const baseline = read(ADMIN_GRANT_PROOF_MODULE)
    const assertion = 'tx.requireIdentityRead([intent.connectionId])'
    expect(baseline.split(assertion)).toHaveLength(2)
    expect(identitySlotProblems(ADMIN_GRANT_PROOF_MODULE, baseline)).toEqual([])
    const mutations = [
      baseline.replace(assertion, 'void 0'),
      baseline.replace(assertion, `${assertion}\n  ${assertion}`),
      baseline.replace(assertion, 'other.requireIdentityRead([intent.connectionId])'),
      baseline.replace(assertion, 'tx.requireIdentityRead([intent.orgId])'),
      baseline.replace(assertion, `const nested = () => { ${assertion} }`),
      baseline.replace('  const userIds = [intent.actorId', '  const tx = intent\n  const userIds = [intent.actorId'),
      baseline.replace(assertion, `intent = otherIntent\n  ${assertion}`),
      baseline.replace(assertion, `const { tx } = other\n  ${assertion}`),
      baseline.replace(assertion, `({ intent } = other)\n  ${assertion}`),
      `${baseline}\nawait tx.query("SELECT pg_advisory_xact_lock(hashtext('directory:identity-maintenance'))")`,
    ]
    for (const [index, source] of mutations.entries()) expect(identitySlotProblems(ADMIN_GRANT_PROOF_MODULE, source), `grant issuer identity mutation ${index}`).not.toEqual([])
    expect(identitySlotProblems(`${SRC}/auth/other-grant-proof.ts`, baseline)).not.toEqual([])
  })

  it('admits only the reviewed ceremony runRoot and strict-entry issueOnRoot identity reads', () => {
    const ceremony = ENTRY_OPTION_PORTS[0].file
    const runtime = ENTRY_OPTION_PORTS[2].file
    const ceremonySource = read(ceremony)
    const runtimeSource = read(runtime)
    const ceremonyCall = 'tx.requireIdentityRead([connectionId])'
    const runtimeCall = 'tx.requireIdentityRead([snapshot.connectionId])'
    const ceremonyShadow = '): Promise<T | CurrentAppCeremonyRefusal> {\n  try {'
    const runtimeShadow = '): Promise<StrictDingTalkSignInResult> {\n  const issued = await withAuthorizationInputTransaction'
    expect(ceremonySource.split(ceremonyCall)).toHaveLength(2)
    expect(runtimeSource.split(runtimeCall)).toHaveLength(2)
    expect(ceremonySource.split(ceremonyShadow)).toHaveLength(2)
    expect(runtimeSource.split(runtimeShadow)).toHaveLength(2)
    expect(identitySlotProblems(ceremony, ceremonySource)).toEqual([])
    expect(identitySlotProblems(runtime, runtimeSource)).toEqual([])
    const ceremonyMutants = [
      ceremonySource.replace(`      ${ceremonyCall}\n`, ''),
      ceremonySource.replace(ceremonyCall, `${ceremonyCall}\n      ${ceremonyCall}`),
      ceremonySource.replace(ceremonyCall, 'tx.requireIdentityRead([otherId])'),
      ceremonySource.replace(ceremonyCall, `const detached = () => ${ceremonyCall}`),
      ceremonySource.replace(ceremonyShadow, '): Promise<T | CurrentAppCeremonyRefusal> {\n  const connectionId = other\n  try {'),
    ]
    const runtimeMutants = [
      runtimeSource.replace(`    ${runtimeCall}\n`, ''),
      runtimeSource.replace(runtimeCall, `${runtimeCall}\n    ${runtimeCall}`),
      runtimeSource.replace(runtimeCall, 'tx.requireIdentityRead([snapshot.orgId])'),
      runtimeSource.replace(runtimeCall, `const detached = () => ${runtimeCall}`),
      runtimeSource.replace(runtimeShadow, '): Promise<StrictDingTalkSignInResult> {\n  snapshot = otherSnapshot\n  const issued = await withAuthorizationInputTransaction'),
    ]
    for (const [index, source] of ceremonyMutants.entries()) expect(identitySlotProblems(ceremony, source), `ceremony identity ${index}`).not.toEqual([])
    for (const [index, source] of runtimeMutants.entries()) expect(identitySlotProblems(runtime, source), `runtime identity ${index}`).not.toEqual([])
    expect(identitySlotProblems(`${SRC}/auth/other-grant-target-ceremony.ts`, ceremonySource)).not.toEqual([])
    expect(identitySlotProblems(`${SRC}/auth/other-strict-dingtalk-entry.ts`, runtimeSource)).not.toEqual([])
  })

  it('rejects one changed key, mode or helper from the passing central baseline', () => {
    const source = read(LOCK_MODULE)
    expect(identitySlotProblems(LOCK_MODULE, source)).toEqual([])
    for (const [before, after] of [
      ['directory:identity-maintenance', 'directory:identity-other'],
      ["pg_advisory_xact_lock_shared(hashtext('directory:identity-maintenance'))", "pg_advisory_xact_lock(hashtext('directory:identity-maintenance'))"],
      ['await acquireSourceSyncFreezeLock({ query }, sourceId)', 'await query("SELECT 1")'],
    ]) {
      expect(source.split(before)).toHaveLength(2)
      expect(identitySlotProblems(LOCK_MODULE, source.replace(before, after))).not.toEqual([])
    }
  })

  it.each([
    'const plan = { identityRead: { sourceIntegrationIds: [] } }',
    'tx.requireIdentityRead(ids)',
    "await client.query(\"SELECT pg_advisory_xact_lock_shared(hashtext('directory:identity-maintenance'))\")",
    "await client.query(\"SELECT  pg_advisory_xact_lock_shared(hashtext('directory:identity-maintenance'))\")",
    "await client.query(\"SELECT pg_advisory_xact_lock_shared ( hashtext ( 'directory:identity-maintenance' ) )\")",
    "await client.query(\"select PG_ADVISORY_XACT_LOCK_SHARED(HASHTEXT('directory:identity-maintenance'))\")",
    "await client.query(\"SELECT pg_advisory_xact_lock_shared/* gap */(hashtext('directory:identity-maintenance'))\")",
    "await client.query(\"SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtext('directory:identity-maintenance'))\")",
    "await client.query(\"SELECT pg_advisory_xact_lock_shared(hashtext(E'directory:identity-maintenance'))\")",
    "await client.query(\"SELECT pg_advisory_xact_lock_shared(hashtext(('directory:identity-maintenance')::text))\")",
    'await client.query(`SELECT "pg_advisory_xact_lock_shared"("hashtext"(\'directory:identity-maintenance\'))`)',
    "await client.query(\"SELECT pg_advisory_xact_lock(hashtext('directory:identity-maintenance'))\")",
    "await client.query(\"SELECT pg_try_advisory_xact_lock_shared(hashtext('directory:identity-maintenance'))\")",
    "await client.query(\"SELECT pg_advisory_lock_shared(hashtext('directory:identity-maintenance'))\")",
    "import { acquireSourceSyncFreezeLock as take } from '../directory/source-sync-freeze-lock'",
  ])('rejects a single new production path: %s', (addition) => {
    const file = `${SRC}/rbac/new-caller.ts`
    const baseline = 'export const unrelated = true'
    expect(identitySlotProblems(file, baseline)).toEqual([])
    expect(identitySlotProblems(file, `${baseline}\n${addition}`)).not.toEqual([])
  })
})

type TakeoverSite = { file: string; line: number; intent: string | null; caller: string | null }

function takeoverSites(file: string, source: string): TakeoverSite[] {
  const sites: TakeoverSite[] = []
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'enterAuthorizationInputTransaction') {
      const plan = node.arguments[1]
      let intent: string | null = null
      let caller: string | null = null
      if (plan && ts.isObjectLiteralExpression(plan)) {
        for (const property of plan.properties) {
          if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
            if (property.name.text === 'intent' && ts.isStringLiteral(property.initializer)) intent = property.initializer.text
            if (property.name.text === 'caller' && ts.isStringLiteral(property.initializer)) caller = property.initializer.text
          }
        }
      }
      sites.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, intent, caller })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return sites
}

const TAKEOVER_FILES: Readonly<Record<string, string>> = Object.freeze({
  directory_sync: `${SRC}/directory/directory-sync.ts`,
  controlled_handover: `${SRC}/directory/controlled-handover.ts`,
})

function takeoverProblems(sites: readonly TakeoverSite[]): string[] {
  const problems: string[] = []
  for (const site of sites) {
    const caller = site.caller === null ? null : (AUTHORIZATION_INPUT_TAKEOVER_CALLERS as Record<string, { intents: readonly string[] } | undefined>)[site.caller]
    if (!site.caller || !caller) problems.push(`${site.file}:${site.line}: caller is not a registered literal`)
    else if (TAKEOVER_FILES[site.caller] !== site.file) problems.push(`${site.file}:${site.line}: not the registered file of ${site.caller}`)
    else if (site.intent === null || !caller.intents.includes(site.intent)) problems.push(`${site.file}:${site.line}: intent is not a literal inside the closure`)
  }
  return problems
}

describe('takeover call sites', () => {
  it('no production file joins a contract transaction', () => {
    const sites = productionFiles
      .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)) && file !== LOCK_MODULE)
      .flatMap((file) => {
        const source = read(file)
        return source.includes('enterAuthorizationInputTransaction') ? takeoverSites(file, source) : []
      })
    expect(sites).toEqual([])
    expect(takeoverProblems(sites)).toEqual([])
  })

  it('POSITIVE CONTROL — a site outside the registered file, with a non-literal or out-of-closure intent, is a problem; a registered site is not', () => {
    const sync = TAKEOVER_FILES.directory_sync
    const ok = takeoverSites(sync, "enterAuthorizationInputTransaction(client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['isolation_pin'], work)")
    expect(takeoverProblems(ok)).toEqual([])
    const wrongFile = takeoverSites(`${SRC}/routes/roles.ts`, "enterAuthorizationInputTransaction(client, { intent: 'PROJECTION_GRANT', caller: 'directory_sync' }, ['isolation_pin'], work)")
    expect(takeoverProblems(wrongFile)).toHaveLength(1)
    const outside = takeoverSites(sync, "enterAuthorizationInputTransaction(client, { intent: 'EDIT_ROLE_CONTENT', caller: 'directory_sync' }, ['isolation_pin'], work)")
    expect(takeoverProblems(outside)).toHaveLength(1)
    const variable = takeoverSites(sync, "enterAuthorizationInputTransaction(client, { intent, caller: 'directory_sync' }, ['isolation_pin'], work)")
    expect(takeoverProblems(variable)).toHaveLength(1)
    const noCaller = takeoverSites(sync, "enterAuthorizationInputTransaction(client, { intent: 'PROJECTION_GRANT' }, ['isolation_pin'], work)")
    expect(takeoverProblems(noCaller)).toHaveLength(1)
  })
})

const KEY = String(AUTHORIZATION_INPUT_WORLD_LOCK_KEY1)
const PERMITTED_KEY_FORMS = [`pg_advisory_xact_lock_shared(${KEY}, 1)`, `pg_try_advisory_xact_lock_shared(${KEY}, 1)`, `pg_try_advisory_xact_lock(${KEY}, 1)`]
/** The key as the first argument of any advisory-lock call, in text; a date embedded in a migration name or a path is not a key. */
const KEY_IN_ADVISORY_CALL = new RegExp(`pg_[a-z_]*advisory[a-z_]*\\(\\s*${KEY}\\b`, 'g')
/** The key as a bare numeric token in text, as a parameter list or a SQL literal would spell it. */
const KEY_AS_TOKEN = new RegExp(`(?<![0-9A-Za-z_.\\-/])${KEY}(?![0-9A-Za-z_.\\-/])`, 'g')
const KEY_IDENTIFIERS = ['AUTHORIZATION_INPUT_WORLD_LOCK_KEY1', 'AUTHORIZATION_INPUT_WORLD_LOCK_KEY2']

/**
 * Every occurrence of the key that is not a permitted statement form or a declaration: in
 * TypeScript, string and template chunks, numeric literals and references to the key identifiers;
 * in other files, the text. Text occurrences count when the key is an advisory call's first
 * argument or a bare numeric token.
 */
function keyProblems(file: string, source: string): string[] {
  const problems: string[] = []
  const check = (text: string, where: string) => {
    const seen = new Set<number>()
    for (const match of [...text.matchAll(KEY_IN_ADVISORY_CALL), ...text.matchAll(KEY_AS_TOKEN)]) {
      const index = (match.index ?? 0) + match[0].indexOf(KEY)
      if (seen.has(index)) continue
      seen.add(index)
      const permitted = PERMITTED_KEY_FORMS.some((form) => text.startsWith(form, index - form.indexOf(KEY)))
      if (!permitted) problems.push(`${where}: ${text.slice(Math.max(0, index - 30), index + 20).replace(/\s+/g, ' ')}`)
    }
  }
  if (SOURCE_EXTENSIONS.has(path.extname(file))) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS)
    const lineOf = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        check(node.text, `${file}:${lineOf(node)}`)
      } else if (ts.isNumericLiteral(node) && Number(node.text) === AUTHORIZATION_INPUT_WORLD_LOCK_KEY1) {
        const parent = node.parent
        const declaration = parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.name.text === KEY_IDENTIFIERS[0] && file === LOCK_MODULE
        const registry = parent && ts.isPropertyAssignment(parent) && parent.name.getText(tree) === 'literal' && file === KEY_REGISTRY_MODULE
        if (!declaration && !registry) problems.push(`${file}:${lineOf(node)}: numeric key outside its declarations`)
      } else if (ts.isIdentifier(node) && KEY_IDENTIFIERS.includes(node.text)) {
        const parent = node.parent
        const declaration = parent && ts.isVariableDeclaration(parent) && parent.name === node && file === LOCK_MODULE
        if (!declaration) problems.push(`${file}:${lineOf(node)}: key identifier ${node.text} referenced outside its declaration`)
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  } else {
    check(source, file)
  }
  return problems
}

describe('world-lock key forms', () => {
  it('across every root the key appears only in the three permitted statement forms and its two declarations, and the key identifiers are never referenced', () => {
    const files = listFiles(REPO_ROOT, ALL_ROOTS)
    expect(files.length).toBeGreaterThan(2000)
    const problems: string[] = []
    let permittedSites = 0
    for (const file of files) {
      const source = read(file)
      if (!source.includes(KEY) && !KEY_IDENTIFIERS.some((name) => source.includes(name))) continue
      problems.push(...keyProblems(file, source))
      for (const form of PERMITTED_KEY_FORMS) permittedSites += source.split(form).length - 1
    }
    expect(problems).toEqual([])
    expect(permittedSites).toBeGreaterThanOrEqual(3)
  })

  it('POSITIVE CONTROL — the blocking form, the session form, a parameterised key, a key spelled through its identifier and a bare key token are each a problem', () => {
    expect(keyProblems('x.ts', `const s = 'SELECT pg_advisory_xact_lock(${KEY}, 1)'`)).toHaveLength(1)
    expect(keyProblems('x.ts', `const s = 'SELECT pg_advisory_lock(${KEY}, 1)'`)).toHaveLength(1)
    expect(keyProblems('x.ts', `await q('SELECT pg_advisory_xact_lock_shared($1, $2)', [${KEY}, 1])`)).toHaveLength(1)
    expect(keyProblems('x.ts', `await q('SELECT pg_advisory_xact_lock_shared($1, $2)', ['${KEY}', 1])`)).toHaveLength(1)
    expect(keyProblems('x.ts', 'const s = `SELECT pg_advisory_xact_lock(${AUTHORIZATION_INPUT_WORLD_LOCK_KEY1}, ${AUTHORIZATION_INPUT_WORLD_LOCK_KEY2})`')).toHaveLength(2)
    expect(keyProblems('x.ts', 'await q(\'SELECT pg_advisory_xact_lock_shared($1, $2)\', [AUTHORIZATION_INPUT_WORLD_LOCK_KEY1, 1])')).toHaveLength(1)
    expect(keyProblems('x.ts', `const s = 'SELECT pg_advisory_xact_lock_shared(${KEY}, 1)'`)).toEqual([])
    expect(keyProblems('x.sql', `SELECT pg_advisory_xact_lock(${KEY}, 1);`)).toHaveLength(1)
    expect(keyProblems('x.sql', `SELECT pg_advisory_lock( ${KEY} , 1);`)).toHaveLength(1)
    expect(keyProblems('x.sql', `SELECT pg_try_advisory_xact_lock(${KEY}, 1);`)).toEqual([])
    expect(keyProblems('x.sh', `psql -c "SELECT pg_advisory_xact_lock(${KEY}, 1)"`)).toHaveLength(1)
  })

  it('NEGATIVE CONTROL — the digits inside a migration name, a dated path or a dated identifier are not a key', () => {
    expect(keyProblems('x.ts', `const help = \`Likewise zzzz${KEY}120000_create_x.ts refuses\``)).toEqual([])
    expect(keyProblems('x.mjs', `const note = 'run migrate.js --confirm zzzz${KEY}120000_create_x first'`)).toEqual([])
    expect(keyProblems('x.ts', `const doc = 'docs/development/plan-${KEY}.md'`)).toEqual([])
    expect(keyProblems('x.ts', `const dir = 'artifacts/review-${KEY}/report.md'`)).toEqual([])
    expect(keyProblems('x.sh', `ls artifacts/review-${KEY}/`)).toEqual([])
    expect(keyProblems('x.ts', `const stamp = 'build_${KEY}'`)).toEqual([])
  })
})

/* ───────────────────────────── function-level ratchet, table closure, birth-only shape ───────────────────────────── */

const DELEGATED_SCOPE_COMMAND = `${SRC}/admin/delegated-scope-commands.ts`
const DELEGATED_SCOPE_WRITERS = [
  { id: 'W-12', symbol: 'writeDelegatedAdminScopeOnTx', statements: ['DELETE|delegated_role_admin_scopes', 'INSERT|delegated_role_admin_scopes'] },
  { id: 'W-13', symbol: 'writeDelegatedAdminMemberGroupsOnTx', statements: ['DELETE|delegated_role_admin_member_groups', 'INSERT|delegated_role_admin_member_groups'] },
  { id: 'W-14', symbol: 'applyDelegatedScopeTemplateOnTx', statements: ['DELETE|delegated_role_admin_member_groups', 'DELETE|delegated_role_admin_scopes', 'INSERT|delegated_role_admin_member_groups', 'INSERT|delegated_role_admin_scopes'] },
] as const
const DELEGATED_SCOPE_CALLERS = [
  ['writeDelegatedAdminScopeCommand', '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)'],
  ['writeDelegatedAdminMemberGroupsCommand', '/api/admin/role-delegation/users/:userId/scope-groups/:action(assign|unassign)'],
  ['applyDelegatedScopeTemplateCommand', '/api/admin/role-delegation/users/:userId/scope-templates/apply'],
] as const
const DELEGATED_SCOPE_REQUEST_KEYS: Readonly<Record<string, readonly string[]>> = {
  writeDelegatedAdminScopeCommand: ['action', 'actorId', 'directoryDepartmentId', 'includeChildrenIntent', 'namespace', 'userId'],
  writeDelegatedAdminMemberGroupsCommand: ['action', 'actorId', 'groupId', 'namespace', 'userId'],
  applyDelegatedScopeTemplateCommand: ['actorId', 'mode', 'namespace', 'templateId', 'userId'],
}

function delegatedScopeCallerProblems(file: string, source: string): string[] {
  const problems: string[] = []
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const unwrap = (expression: ts.Expression): ts.Expression => {
    while (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression
    return expression
  }
  const seen: string[] = []
  const expectedNames = DELEGATED_SCOPE_CALLERS.map(([name]) => name)
  for (const statement of tree.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier?.getText(tree).includes('delegated-scope-commands')) problems.push('delegated scope reexport')
    if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier.getText(tree).includes('delegated-scope-commands')) continue
    const bindings = statement.importClause?.namedBindings
    if (file !== `${SRC}/routes/admin-users.ts` || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== '../admin/delegated-scope-commands' || statement.importClause?.isTypeOnly
      || statement.importClause?.name || !bindings || !ts.isNamedImports(bindings)
      || bindings.elements.some(element => element.propertyName || element.isTypeOnly)
      || JSON.stringify(bindings.elements.map(element => element.name.text).sort()) !== JSON.stringify([...expectedNames].sort())) problems.push('delegated scope importer')
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.getText(tree).includes('delegated-scope-commands')) problems.push('delegated scope dynamic load')
    if (ts.isIdentifier(node) && expectedNames.some(name => name === node.text)) {
      const parent = node.parent
      if (ts.isImportSpecifier(parent)) return
      if (!ts.isCallExpression(parent) || parent.expression !== node) problems.push('delegated scope detached reference')
      else {
        const expected = DELEGATED_SCOPE_CALLERS.find(([name]) => name === node.text)!
        seen.push(node.text)
        const argument = parent.arguments[0]
        const fields = argument && ts.isObjectLiteralExpression(argument) ? fieldsOf(argument, tree) : undefined
        if (!fields || JSON.stringify([...fields.keys()].sort()) !== JSON.stringify(DELEGATED_SCOPE_REQUEST_KEYS[node.text])) problems.push('delegated scope data keys')
        if (argument && ts.isObjectLiteralExpression(argument) && argument.properties.some(property => {
          if (!ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property)) return true
          if (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) return true
          const key = property.name.text
          const value = unwrap(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer)
          if (key !== 'action') return !ts.isIdentifier(value) || value.text !== (key === 'actorId' ? 'adminUserId' : key)
          if (ts.isIdentifier(value)) return value.text !== 'action'
          if (!ts.isConditionalExpression(value)) return true
          const condition = unwrap(value.condition)
          if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return true
          const left = unwrap(condition.left)
          const right = unwrap(condition.right)
          const assigned = unwrap(value.whenTrue)
          const unassigned = unwrap(value.whenFalse)
          return !ts.isIdentifier(left) || left.text !== 'action'
            || !ts.isStringLiteral(right) || right.text !== 'assign'
            || !ts.isStringLiteral(assigned) || assigned.text !== 'assign'
            || !ts.isStringLiteral(unassigned) || unassigned.text !== 'unassign'
        })) problems.push('delegated scope data binding')
        let owner: ts.Node | undefined = parent.parent
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
        const registration = owner?.parent
        if (file !== `${SRC}/routes/admin-users.ts` || parent.arguments.length !== 1 || !ts.isObjectLiteralExpression(parent.arguments[0])
          || !owner || !ts.isArrowFunction(owner) || !registration || !ts.isCallExpression(registration)
          || !ts.isPropertyAccessExpression(registration.expression) || registration.expression.getText(tree) !== 'r.post'
          || registration.arguments[registration.arguments.length - 1] !== owner || !registration.arguments[0]
          || !ts.isStringLiteral(registration.arguments[0]) || registration.arguments[0].text !== expected[1]) problems.push('delegated scope call boundary')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (file === `${SRC}/routes/admin-users.ts` && JSON.stringify(seen.sort()) !== JSON.stringify([...expectedNames].sort())) problems.push('delegated scope caller coverage')
  return problems
}

function delegatedScopeConversionProblems(entries: readonly AuthorizationInputWriterEntry[], source: string, writes: readonly LiteralWrite[]): string[] {
  const problems: string[] = []
  const tree = ts.createSourceFile(DELEGATED_SCOPE_COMMAND, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions: ts.FunctionDeclaration[] = []
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node)) functions.push(node)
    if (ts.isIdentifier(node) && DELEGATED_SCOPE_WRITERS.some(expected => expected.symbol === node.text)) {
      if (!((ts.isFunctionDeclaration(node.parent) || ts.isFunctionExpression(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node)
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) problems.push('delegated scope private binding exposed')
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  const moduleWrites = writes.filter(write => write.file === DELEGATED_SCOPE_COMMAND)
  const ownership = moduleWrites.map(write => {
    let owner: ts.Node | undefined
    const findOwner = (node: ts.Node) => {
      if (node.getStart(tree) <= write.position && write.position < node.getEnd()) {
        if (ts.isFunctionLike(node) && !ts.isTypeNode(node)) owner = node
        ts.forEachChild(node, findOwner)
      }
    }
    findOwner(tree)
    return { write, owner }
  })
  if (entries.filter(entry => entry.file === DELEGATED_SCOPE_COMMAND).length !== DELEGATED_SCOPE_WRITERS.length) problems.push('delegated scope registry coverage')
  for (const expected of DELEGATED_SCOPE_WRITERS) {
    const declarations = functions.filter(declaration => declaration.name?.text === expected.symbol)
    const declaration = declarations[0]
    const token = declaration?.parameters.filter(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === 'tx')
    const tokenType = token?.[0]?.type
    if (declarations.length !== 1 || !declaration || declaration.parent !== tree
      || declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
      || token?.length !== 1 || !tokenType || !ts.isTypeReferenceNode(tokenType)
      || !ts.isIdentifier(tokenType.typeName) || tokenType.typeName.text !== 'AuthorizationInputTx' || tokenType.typeArguments) {
      problems.push(`${expected.id}: delegated scope private token writer`)
    }
    if (declaration?.body) {
      const referencesToken = (node: ts.Node): boolean => (ts.isIdentifier(node) && node.text === 'tx') || Boolean(ts.forEachChild(node, referencesToken))
      const checkTokenBinding = (node: ts.Node) => {
        if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
          && node.name && ts.isIdentifier(node.name) && node.name.text === 'tx') problems.push(`${expected.id}: delegated scope token shadow`)
        const target = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? node.left
          : (ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer) ? node.initializer
            : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) ? node.operand : undefined
        if (target && referencesToken(target)) problems.push(`${expected.id}: delegated scope token reassignment`)
        ts.forEachChild(node, checkTokenBinding)
      }
      checkTokenBinding(declaration.body)
    }
    const matching = entries.filter(entry => entry.id === expected.id)
    const entry = matching[0]
    if (matching.length !== 1 || !entry || entry.file !== DELEGATED_SCOPE_COMMAND || entry.symbol !== expected.symbol
      || entry.statements.some(statement => statement.count !== 1)
      || JSON.stringify(entry.statements.map(statement => `${statement.verb}|${statement.table}`).sort()) !== JSON.stringify(expected.statements)) {
      problems.push(`${expected.id}: delegated scope registry shape`)
    }
    const sites = ownership.filter(site => site.owner === declaration)
    if (JSON.stringify(sites.map(site => `${site.write.verb}|${site.write.table}`).sort()) !== JSON.stringify(expected.statements)) {
      problems.push(`${expected.id}: delegated scope owner multiset`)
    }
    for (const site of sites) {
      if (queryReceiverAt(DELEGATED_SCOPE_COMMAND, source, site.write.position) !== 'tx') problems.push(`${expected.id}: delegated scope query receiver`)
    }
  }
  if (ownership.some(site => !functions.some(declaration => declaration === site.owner && declaration.parent === tree
    && DELEGATED_SCOPE_WRITERS.some(expected => expected.symbol === declaration.name?.text)))) problems.push('delegated scope orphan statement')
  return problems
}

function conversionProblems(writer: AuthorizationInputWriterEntry, source: string, writes: readonly LiteralWrite[]): string[] {
  const problems: string[] = []
  if (writer.status !== 'converted') return problems
  if (writer.file === DELEGATED_SCOPE_COMMAND) return delegatedScopeConversionProblems(AUTHORIZATION_INPUT_WRITERS, source, writes)
  const sites = writes.filter((write) => write.file === writer.file && writer.statements.some((s) => s.table === write.table && s.verb === write.verb))
  if (sites.length === 0) problems.push(`${writer.id}: no statement site found`)
  for (const site of sites) {
    const fn = enclosingFunctionAt(writer.file, source, site.position)
    if (!fn || fn.name !== writer.symbol) {
      problems.push(`${writer.id}: statement at line ${site.line} is not inside ${writer.symbol}`)
      continue
    }
    if (!fn.brandedParameters.includes('tx')) problems.push(`${writer.id}: ${writer.symbol} does not take tx typed as the contract token`)
    const receiver = queryReceiverAt(writer.file, source, site.position)
    if (receiver !== 'tx') problems.push(`${writer.id}: statement at line ${site.line} is issued on ${receiver ?? 'no query receiver'}`)
  }
  return problems
}

describe('function-level conversion ratchet', () => {
  it('delegated scope commands have only their three registered direct data-only route callers', () => {
    const problems = productionFiles.filter(file => file !== DELEGATED_SCOPE_COMMAND).flatMap(file => {
      const source = read(file)
      return source.includes('delegated-scope-commands') || DELEGATED_SCOPE_CALLERS.some(([name]) => source.includes(name))
        ? delegatedScopeCallerProblems(file, source) : []
    })
    expect(problems).toEqual([])
    expect(productionFiles.flatMap(file => importSpecifiers(read(file)).filter(specifier => specifier.includes('delegated-scope-commands')).map(specifier => [file, specifier])))
      .toEqual([[`${SRC}/routes/admin-users.ts`, '../admin/delegated-scope-commands']])
  })

  it('delegated scope caller controls reject aliases, detached calls, loaders and wrong route/data boundaries', () => {
    const file = `${SRC}/routes/admin-users.ts`
    const imported = `import { ${DELEGATED_SCOPE_CALLERS.map(([name]) => name).join(', ')} } from '../admin/delegated-scope-commands'`
    const baseline = imported + '\n' + DELEGATED_SCOPE_CALLERS.map(([name, route]) => `r.post('${route}', authenticate, async (req, res) => { await ${name}({ ${DELEGATED_SCOPE_REQUEST_KEYS[name].map(key => key === 'actorId' ? 'actorId: adminUserId' : key).join(', ')} }); })`).join('\n')
    expect(delegatedScopeCallerProblems(file, baseline)).toEqual([])
    expect(delegatedScopeCallerProblems(file, baseline.replace('action, actorId:', 'action: action as "assign" | "unassign", actorId:'))).toEqual([])
    expect(delegatedScopeCallerProblems(file, baseline.replace('action, actorId:', "action: action === 'assign' ? 'assign' : 'unassign', actorId:"))).toEqual([])
    expect(delegatedScopeCallerProblems(file, baseline.replace('action, actorId:', 'action: (( action === "assign" ) ? ("assign" as const) : "unassign") as "assign" | "unassign", actorId:'))).toEqual([])
    for (const candidate of [
      baseline.replace('writeDelegatedAdminScopeCommand,', 'writeDelegatedAdminScopeCommand as aliased,'),
      baseline.replace(/\(\{ [^}]+ \}\)/, '(actorId, userId)'),
      baseline.replace(/\(\{ [^}]+ \}\)/, '(request)'),
      baseline.replace('action, actorId: adminUserId,', 'action, actorId: adminUserId, callback: () => {},'),
      baseline.replace('action, actorId: adminUserId,', 'action, actorId: adminUserId, ...extra,'),
      baseline.replace('action, actorId: adminUserId,', 'action, actorId: () => {},'),
      baseline.replace('action, actorId: adminUserId,', 'action, actorId() {},'),
      baseline.replace('actorId: adminUserId', 'actorId: userId'),
      baseline.replace('actorId: adminUserId', '"\'actorId\'": adminUserId'),
      baseline.replace('action, actorId:', "action: action === 'as sign' ? 'assign' : 'unassign', actorId:"),
      baseline.replace('action, actorId:', "action: action === ' assign ' ? 'assign' : 'unassign', actorId:"),
      baseline.replace('action, actorId:', "action: action === 'assign' ? 'as sign' : 'unassign', actorId:"),
      baseline.replace('action, actorId:', "action: action === 'assign' ? 'assign' : 'un assign', actorId:"),
      baseline.replace("r.post('/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)'", "r.post('/other'"),
      baseline + '\nconst detached = writeDelegatedAdminScopeCommand;',
      baseline + "\nconst loaded = import('../admin/delegated-scope-commands');",
      baseline + "\nexport * from '../admin/delegated-scope-commands';",
      baseline.replace('await writeDelegatedAdminScopeCommand', 'await Promise.resolve().then(async () => writeDelegatedAdminScopeCommand').replace(/(writeDelegatedAdminScopeCommand\(\{ [^}]+ \}\));/, '$1);'),
    ]) expect(delegatedScopeCallerProblems(file, candidate)).not.toEqual([])
    expect(delegatedScopeCallerProblems(`${SRC}/other.ts`, baseline)).not.toEqual([])
  })

  it('delegated scope writers have exact per-symbol multisets covering every module write', () => {
    const source = read(DELEGATED_SCOPE_COMMAND)
    expect(delegatedScopeConversionProblems(AUTHORIZATION_INPUT_WRITERS, source, scanSource(DELEGATED_SCOPE_COMMAND, source).writes)).toEqual([])
  })

  it('delegated scope ownership rejects moved, orphaned, duplicate, renamed, untyped and wrong-receiver statements', () => {
    const entries = DELEGATED_SCOPE_WRITERS.map(expected => ({
      ...AUTHORIZATION_INPUT_WRITERS.find(entry => entry.id === expected.id)!,
      file: DELEGATED_SCOPE_COMMAND,
      symbol: expected.symbol,
      statements: expected.statements.map(statement => {
        const [verb, table] = statement.split('|')
        return { verb, table, count: 1 }
      }),
    })) as AuthorizationInputWriterEntry[]
    const functions = DELEGATED_SCOPE_WRITERS.map(expected => `async function ${expected.symbol}(tx: AuthorizationInputTx) { ${expected.statements.map(statement => {
      const [verb, table] = statement.split('|')
      return `await tx.query('${verb === 'INSERT' ? 'INSERT INTO' : 'DELETE FROM'} ${table}');`
    }).join(' ')} }`)
    const baseline = functions.join('\n')
    const check = (source: string) => delegatedScopeConversionProblems(entries, source, scanSource(DELEGATED_SCOPE_COMMAND, source).writes)
    expect(check(baseline)).toEqual([])
    const statement = "await tx.query('INSERT INTO delegated_role_admin_scopes');"
    const firstBody = DELEGATED_SCOPE_WRITERS[0].statements.map(statement => {
      const [verb, table] = statement.split('|')
      return `await tx.query('${verb === 'INSERT' ? 'INSERT INTO' : 'DELETE FROM'} ${table}');`
    }).join(' ')
    const emptyFirst = baseline.replace(firstBody, '')
    for (const candidate of [
      baseline.replace(statement, ''),
      baseline.replace(statement, statement + statement),
      baseline.replace(statement, "await pool.query('INSERT INTO delegated_role_admin_scopes');"),
      baseline.replace('tx: AuthorizationInputTx', 'tx'),
      baseline.replace('tx: AuthorizationInputTx', 'tx: AuthorizationInputTx | undefined'),
      baseline.replace('tx: AuthorizationInputTx', 'tx: AuthorizationInputTx & any'),
      baseline.replace('async function writeDelegatedAdminScopeOnTx', 'export async function writeDelegatedAdminScopeOnTx'),
      baseline + '\nasync function writeDelegatedAdminScopeOnTx(tx: AuthorizationInputTx) {}',
      emptyFirst + `\nconst detachedWriter = async function writeDelegatedAdminScopeOnTx(tx: AuthorizationInputTx) { ${firstBody} };`,
      emptyFirst + `\nconst object = { async writeDelegatedAdminScopeOnTx(tx: AuthorizationInputTx) { ${firstBody} } };`,
      baseline.replace(firstBody, `{ const tx = { query }; ${firstBody} }`),
      baseline.replace(firstBody, `{ const { runner: tx } = { runner: { query } }; ${firstBody} }`),
      baseline.replace(firstBody, `tx = { query } as unknown as AuthorizationInputTx; ${firstBody}`),
      baseline.replace(firstBody, `({ tx } = { tx: { query } as unknown as AuthorizationInputTx }); ${firstBody}`),
      baseline.replace(firstBody, `for (tx of [{ query } as unknown as AuthorizationInputTx]) { ${firstBody} }`),
      baseline + '\nexport { writeDelegatedAdminScopeOnTx };',
      baseline + '\nexport { writeDelegatedAdminScopeOnTx as exposedWriter };',
      baseline + '\nexport default writeDelegatedAdminScopeOnTx;',
      baseline + '\nconst exposed = writeDelegatedAdminScopeOnTx; export { exposed };',
      baseline.replace('writeDelegatedAdminScopeOnTx', 'otherWriter'),
      baseline.replace(statement, '') + `\nasync function orphan(tx: AuthorizationInputTx) { ${statement} }`,
      baseline.replace(statement, '') + `\n${statement}`,
      baseline.replace(statement, '') + `\nasync function otherWriter(tx: AuthorizationInputTx) { ${statement} }`,
      baseline.replace(statement, `await Promise.resolve().then(async () => { ${statement} });`),
    ]) expect(check(candidate)).not.toEqual([])
    expect(delegatedScopeConversionProblems(entries.slice(1), baseline, scanSource(DELEGATED_SCOPE_COMMAND, baseline).writes)).not.toEqual([])
    expect(delegatedScopeConversionProblems([...entries, entries[0]], baseline, scanSource(DELEGATED_SCOPE_COMMAND, baseline).writes)).not.toEqual([])
    expect(delegatedScopeConversionProblems([...entries, { ...entries[0], id: 'W-extra' }], baseline, scanSource(DELEGATED_SCOPE_COMMAND, baseline).writes)).not.toEqual([])
    expect(delegatedScopeConversionProblems(entries.map(entry => entry.id === 'W-12' ? { ...entry, statements: entry.statements.map(statement => ({ ...statement, count: 2 })) } : entry), baseline, scanSource(DELEGATED_SCOPE_COMMAND, baseline).writes)).not.toEqual([])
    expect(delegatedScopeConversionProblems(entries.map(entry => entry.id === 'W-12' ? { ...entry, symbol: 'otherWriter' } : entry), baseline, scanSource(DELEGATED_SCOPE_COMMAND, baseline).writes)).not.toEqual([])
  })

  it('every converted entry issues its statements on the token inside the named function', () => {
    const problems = AUTHORIZATION_INPUT_WRITERS.flatMap((writer) => conversionProblems(writer, read(writer.file), production.writes))
    expect(problems).toEqual([])
  })

  it('POSITIVE CONTROL — a converted entry whose function takes a client, an untyped tx, or issues a statement on another receiver, is a problem', () => {
    const converted: AuthorizationInputWriterEntry = { ...AUTHORIZATION_INPUT_WRITERS[0], file: 'x.ts', symbol: 'grant', status: 'converted' }
    const good = "async function grant(tx: AuthorizationInputTx, userId: string) { await tx.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, 'r']) }"
    expect(conversionProblems(converted, good, scanSource('x.ts', good).writes)).toEqual([])
    const client = good.replace('grant(tx: AuthorizationInputTx,', 'grant(client: PoolClient,').replace('tx.query', 'client.query')
    expect(conversionProblems(converted, client, scanSource('x.ts', client).writes)).toHaveLength(2)
    const untyped = good.replace('tx: AuthorizationInputTx', 'tx')
    expect(conversionProblems(converted, untyped, scanSource('x.ts', untyped).writes)).toHaveLength(1)
    const otherReceiver = "async function grant(tx: AuthorizationInputTx, userId: string) { await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, 'r']) }"
    expect(conversionProblems(converted, otherReceiver, scanSource('x.ts', otherReceiver).writes)).toHaveLength(1)
    const elsewhere = "async function other(tx: AuthorizationInputTx) { await tx.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', ['u', 'r']) }\nasync function grant(tx: AuthorizationInputTx) {}"
    expect(conversionProblems(converted, elsewhere, scanSource('x.ts', elsewhere).writes)).toHaveLength(1)
  })
})

const PLATFORM_ADMISSION_COMMAND = `${SRC}/admin/platform-namespace-admission-command.ts`
const PLATFORM_ADMISSION_CALLER = `${SRC}/routes/admin-users.ts`
const PLATFORM_ADMISSION_EXPORT = 'writePlatformNamespaceAdmissionCommand'
const PLATFORM_ADMISSION_MODULE = '../admin/platform-namespace-admission-command'
const PLATFORM_ADMISSION_ROUTE = '/api/admin/users/:userId/namespaces/:namespace/admission'

function platformAdmissionCallerProblems(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const problems: string[] = []
  const unwrap = (expression: ts.Expression): ts.Expression => {
    while (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression
    return expression
  }
  const mentionsModule = (expression: ts.Expression): boolean => {
    const decoded = unwrap(expression)
    return expression.getText(tree).includes('platform-namespace-admission-command')
      || ((ts.isStringLiteral(decoded) || ts.isNoSubstitutionTemplateLiteral(decoded)) && decoded.text.includes('platform-namespace-admission-command'))
  }
  let imports = 0
  let calls = 0
  for (const statement of tree.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && mentionsModule(statement.moduleSpecifier)) problems.push('platform admission reexport')
    if (!ts.isImportDeclaration(statement) || !mentionsModule(statement.moduleSpecifier)) continue
    imports += 1
    const bindings = statement.importClause?.namedBindings
    if (file !== PLATFORM_ADMISSION_CALLER || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== PLATFORM_ADMISSION_MODULE
      || statement.importClause?.isTypeOnly || statement.importClause?.name || !bindings || !ts.isNamedImports(bindings)
      || bindings.elements.length !== 1 || bindings.elements[0].propertyName || bindings.elements[0].isTypeOnly
      || bindings.elements[0].name.text !== PLATFORM_ADMISSION_EXPORT) problems.push('platform admission import')
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && (node.getText(tree).includes('platform-namespace-admission-command') || (node.arguments[0] !== undefined && mentionsModule(node.arguments[0])))) problems.push('platform admission dynamic load')
    if (ts.isIdentifier(node) && node.text === PLATFORM_ADMISSION_EXPORT) {
      const parent = node.parent
      if (ts.isImportSpecifier(parent)) return
      if (!ts.isCallExpression(parent) || parent.expression !== node) problems.push('platform admission detached reference')
      else {
        calls += 1
        const argument = parent.arguments[0]
        if (parent.arguments.length !== 1 || !argument || !ts.isObjectLiteralExpression(argument)) problems.push('platform admission data argument')
        else {
          const keys: string[] = []
          for (const property of argument.properties) {
            if ((!ts.isShorthandPropertyAssignment(property) && !ts.isPropertyAssignment(property))
              || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
              problems.push('platform admission data property')
              continue
            }
            const key = property.name.text
            keys.push(key)
            const value = unwrap(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer)
            if (!ts.isIdentifier(value) || value.text !== (key === 'actorId' ? 'adminUserId' : key)) problems.push('platform admission data binding')
          }
          if (JSON.stringify(keys.sort()) !== JSON.stringify(['actorId', 'enabled', 'namespace', 'userId'])) problems.push('platform admission data keys')
        }
        let owner: ts.Node | undefined = parent.parent
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
        const registration = owner?.parent
        if (file !== PLATFORM_ADMISSION_CALLER || !owner || !ts.isArrowFunction(owner) || !registration || !ts.isCallExpression(registration)
          || !ts.isPropertyAccessExpression(registration.expression) || registration.expression.expression.getText(tree) !== 'r'
          || registration.expression.name.text !== 'patch' || registration.arguments.at(-1) !== owner
          || !registration.arguments[0] || !ts.isStringLiteral(registration.arguments[0]) || registration.arguments[0].text !== PLATFORM_ADMISSION_ROUTE) problems.push('platform admission registered route')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (file === PLATFORM_ADMISSION_CALLER && (imports !== 1 || calls !== 1)) problems.push('platform admission caller coverage')
  return problems
}

describe('platform namespace admission caller boundary', () => {
  const baseline = `import { ${PLATFORM_ADMISSION_EXPORT} } from '${PLATFORM_ADMISSION_MODULE}';\nr.patch('${PLATFORM_ADMISSION_ROUTE}', authenticate, async (req, res) => { await ${PLATFORM_ADMISSION_EXPORT}({ actorId: adminUserId, userId, namespace, enabled }); })`

  it('has only the registered direct data-only platform caller', () => {
    const candidates = productionFiles.filter(file => SOURCE_EXTENSIONS.has(path.extname(file)) && file !== PLATFORM_ADMISSION_COMMAND)
    expect(candidates.flatMap(file => platformAdmissionCallerProblems(file, read(file)))).toEqual([])
    expect(candidates.flatMap(file => importSpecifiers(read(file)).filter(specifier => specifier.includes('platform-namespace-admission-command')).map(specifier => [file, specifier])))
      .toEqual([[PLATFORM_ADMISSION_CALLER, PLATFORM_ADMISSION_MODULE]])
  })

  it('accepts literal data fields and TypeScript wrappers without changing their meaning', () => {
    expect(platformAdmissionCallerProblems(PLATFORM_ADMISSION_CALLER, baseline)).toEqual([])
    expect(platformAdmissionCallerProblems(PLATFORM_ADMISSION_CALLER, baseline.replace(PLATFORM_ADMISSION_MODULE, '../admin/platform-namespace-admission-\\u0063ommand'))).toEqual([])
    expect(platformAdmissionCallerProblems(PLATFORM_ADMISSION_CALLER, baseline.replace('actorId: adminUserId', "'actorId': (adminUserId as string)").replace('namespace, enabled', 'namespace, enabled: (enabled as boolean)'))).toEqual([])
  })

  it('rejects aliases, detached calls, wrong routes and wrong data bindings', () => {
    for (const candidate of [
      baseline.replace(`{ ${PLATFORM_ADMISSION_EXPORT} }`, `{ ${PLATFORM_ADMISSION_EXPORT} as other }`),
      baseline.replace("r.patch(", 'r.post('),
      baseline.replace(PLATFORM_ADMISSION_ROUTE, `${PLATFORM_ADMISSION_ROUTE} `),
      baseline.replace('actorId: adminUserId', 'actorId: userId'),
      baseline.replace('actorId: adminUserId', '"\'actorId\'": adminUserId'),
      baseline.replace('namespace, enabled', 'namespace, enabled: true'),
      baseline.replace('namespace, enabled', 'namespace, enabled, callback: () => {}'),
      baseline.replace('namespace, enabled', 'namespace, enabled, ...other'),
      baseline.replace('namespace, enabled', 'namespace, enabled() {}'),
      baseline.replace('namespace, enabled', 'namespace, enabled, actorId: adminUserId'),
      baseline.replace('namespace, enabled });', 'namespace, enabled }, tx);'),
      baseline.replace(`await ${PLATFORM_ADMISSION_EXPORT}`, `await Promise.resolve().then(async () => ${PLATFORM_ADMISSION_EXPORT}`).replace('namespace, enabled });', 'namespace, enabled }));'),
      baseline + `\nconst detached = ${PLATFORM_ADMISSION_EXPORT};`,
      baseline + `\nconst loaded = import('${PLATFORM_ADMISSION_MODULE}');`,
      baseline + "\nconst loaded = import('../admin/platform-namespace-admission-\\u0063ommand');",
      baseline + "\nconst loaded = require('../admin/platform-namespace-admission-\\u0063ommand');",
      baseline + "\nconst loaded = import(`../admin/platform-namespace-admission-\\u0063ommand`);",
      baseline + `\nexport * from '${PLATFORM_ADMISSION_MODULE}';`,
    ]) expect(platformAdmissionCallerProblems(PLATFORM_ADMISSION_CALLER, candidate)).not.toEqual([])
    expect(platformAdmissionCallerProblems(`${SRC}/other.ts`, baseline)).not.toEqual([])
  })
})

/** The classifier's data statement, read from its source text by the `FROM users u` mark. */
function classifierStatementText(): string {
  const source = read(CLASSIFIER_MODULE)
  const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
  let statement: string | null = null
  const visit = (node: ts.Node) => {
    if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) && node.text.includes('FROM users u')) statement = node.text
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (statement === null) throw new Error('classifier statement not found')
  return statement
}

const SERVICE_READER = `${SRC}/rbac/service.ts`
const NAMESPACE_READER = `${SRC}/rbac/namespace-admission.ts`
const AUTHORIZATION_READERS: readonly string[] = [SERVICE_READER, NAMESPACE_READER]
const GRANT_TABLE = /^(?:users|user_[a-z_]+|role_[a-z_]+|roles|delegated_[a-z_]+|platform_member_[a-z_]+)$/

/**
 * THE ONE EXCEPTION to the reader closure. The statement that lists a user's inherited permission
 * codes left-joins `roles` for the display name of each role, and that is the only place a reader may
 * name the table. The join is there to show a name: the codes come from `role_permissions`, and a left
 * join drops no row. So the exception is pinned by shape and not by table: the word is mentioned once
 * in the literals of the service reader; the mention is this join clause; outside the clause, in that
 * literal, its alias is read only as this select-list item; and the literal that carries the join is
 * this statement, whitespace apart (which also covers a column of the joined table named without the
 * alias). This judgment reads one literal at a time; where that literal stands, and that it is the
 * text handed to the executor, is the rule of `ROLE_NAME_STATEMENT_SITE` below. Every other grant
 * table outside the classifier's set is a problem after FROM or JOIN anywhere in a reader's text, as
 * before. Both rules are checked on the literals and the syntax of the two reader files only.
 */
const ROLE_NAME_JOIN = {
  reader: SERVICE_READER,
  table: 'roles',
  clause: 'LEFT JOIN roles r ON r.id = ur.role_id',
  projection: 'r.name AS role_name',
  statement: 'SELECT DISTINCT rp.permission_code AS code, ur.role_id AS role_id, r.name AS role_name FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id LEFT JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1',
} as const
const PINNED_STATEMENT_PROBLEM = `${ROLE_NAME_JOIN.reader}: the statement that joins roles is not the pinned statement`

/**
 * Literals whose whole text is the word, per reader. It is a permission resource name there, not a
 * table: the namespace reader lists it once among the resources that have no namespace. The count is
 * pinned, so the table named as an argument of a query builder is one literal too many; and the place
 * is pinned (`ROLES_RESOURCE_NAME_LIST`), so the one literal cannot leave the list and be that argument.
 */
const ROLES_RESOURCE_NAME_LITERALS: ReadonlyMap<string, number> = new Map([[NAMESPACE_READER, 1]])

/** The one place a literal whose whole text is the word may stand: an element of this list of this reader. */
const ROLES_RESOURCE_NAME_LIST = { reader: NAMESPACE_READER, name: 'NON_NAMESPACED_PERMISSION_RESOURCES' } as const

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The words of `text` from `before` words before the one at `index` to `after` words after it. */
function wordsAround(text: string, index: number, before: number, after: number): string {
  const words = [...text.matchAll(/\S+/g)]
  const at = words.findIndex((word) => (word.index ?? 0) <= index && index < (word.index ?? 0) + word[0].length)
  return words.slice(Math.max(0, at - before), at + after + 1).map((word) => word[0]).join(' ')
}

/** Replaces the one occurrence of `needle` in `source`; any other number of occurrences throws. */
function editOnce(source: string, needle: string | RegExp, replacement: string): string {
  const found = typeof needle === 'string'
    ? [...source.matchAll(new RegExp(escapeRegExp(needle), 'g'))]
    : [...source.matchAll(new RegExp(needle.source, 'g'))]
  if (found.length !== 1) throw new Error(`editOnce: the needle occurs ${found.length} times`)
  const index = found[0].index ?? 0
  return source.slice(0, index) + replacement + source.slice(index + found[0][0].length)
}

/** The grant tables a source names after FROM or JOIN, read from its whole text. */
function grantTablesRead(source: string): Set<string> {
  return new Set([...source.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((match) => match[1]).filter((table) => GRANT_TABLE.test(table)))
}

/** Problems of one statement of the service reader that mentions `roles`; `statement` is whitespace-squashed. */
function roleNameJoinProblems(statement: string): string[] {
  const { reader, clause, projection } = ROLE_NAME_JOIN
  const problems: string[] = []
  const joins = [...statement.matchAll(new RegExp(`(?<![\\w.])${escapeRegExp(clause)}(?![\\w.])`, 'g'))].map((match) => match.index ?? 0)
  const insideJoin = (index: number) => joins.some((from) => index >= from && index < from + clause.length)
  for (const mention of statement.matchAll(/\broles\b/gi)) {
    if (!insideJoin(mention.index ?? 0)) problems.push(`${reader}: roles is referenced as "${wordsAround(statement, mention.index ?? 0, 2, 1)}", not as "${clause}"`)
  }
  if (problems.length === 0) {
    const selectListEnd = statement.search(/\bFROM\b/)
    const selected = new RegExp(`(?<=(?:,|\\bSELECT|\\bDISTINCT) )${escapeRegExp(projection)}(?=,| FROM\\b)`, 'y')
    for (const use of statement.matchAll(/\br\b(?:\s*\.\s*(?:\*|\w+|"[^"]*"))?/gi)) {
      const index = use.index ?? 0
      if (insideJoin(index)) continue
      selected.lastIndex = index
      if (use[0] !== 'r.name') problems.push(`${reader}: the role-name join's alias is read as "${use[0]}", not as "r.name"`)
      else if (!(index < selectListEnd && selected.test(statement))) problems.push(`${reader}: r.name is used outside the select list, in "${wordsAround(statement, index, 1, 2)}"`)
    }
  }
  if (statement !== ROLE_NAME_JOIN.statement) problems.push(PINNED_STATEMENT_PROBLEM)
  return problems
}

/** Problems of the mentions of `roles` in the literals of one reader. */
function rolesMentionProblems(reader: string, source: string): string[] {
  const problems: string[] = []
  const literals = literalTexts(reader, source).map(squash)
  const resourceNames = literals.filter((text) => text === ROLE_NAME_JOIN.table).length
  const expectedResourceNames = ROLES_RESOURCE_NAME_LITERALS.get(reader) ?? 0
  if (resourceNames !== expectedResourceNames) problems.push(`${reader}: the word roles is the whole text of ${resourceNames} literal(s), not of ${expectedResourceNames}`)
  const statements = literals.filter((text) => text !== ROLE_NAME_JOIN.table && /\broles\b/i.test(text))
  const mentions = statements.reduce((count, text) => count + [...text.matchAll(/\broles\b/gi)].length, 0)
  if (reader !== ROLE_NAME_JOIN.reader) {
    if (mentions > 0) problems.push(`${reader}: statement text mentions roles ${mentions} time(s); only the role-name join may`)
    return problems
  }
  if (mentions !== 1) problems.push(`${reader}: statement text mentions roles ${mentions} time(s), not once`)
  for (const statement of statements) problems.push(...roleNameJoinProblems(statement))
  return problems
}

/**
 * Problems of one authorization reader: a grant table outside the classifier's set after FROM or JOIN
 * anywhere in its text, and any mention of `roles` other than the role-name join. The whole-text rule
 * steps aside for `roles` only in the service reader and only while that text names the table once.
 */
function readerClosureProblems(reader: string, source: string): string[] {
  const problems: string[] = []
  const namedOnce = [...source.matchAll(/\b(?:FROM|JOIN)\s+roles\b/g)].length === 1
  for (const table of grantTablesRead(source)) {
    if ((PRIVILEGE_GRANT_SOURCE_TABLES as readonly string[]).includes(table)) continue
    if (reader === ROLE_NAME_JOIN.reader && table === ROLE_NAME_JOIN.table && namedOnce) continue
    problems.push(`${reader} reads ${table}`)
  }
  problems.push(...rolesMentionProblems(reader, source))
  return problems
}

/**
 * WHERE THE EXCEPTION'S STATEMENT RUNS. In the service reader, a literal that names `roles` is itself
 * the first argument of a call of the local executor, and stands directly in the one function; no
 * other literal of the file carries the alias followed by a dot (`r.` or `"r".`); the function is
 * declared once with the pinned parameters; its first statement is the pinned declaration of the
 * executor; the executor's name appears nowhere else but as the callee of a direct call in that
 * function; and nothing in that function binds again a name the declaration reads. So the statement
 * is not kept in a constant, not joined to other text, not edited by code, not run through a wrapper
 * or a second time, and the local executor hands it on as it is.
 */
const ROLE_NAME_STATEMENT_SITE = {
  function: 'inspectUserPermissionGrants',
  parameters: 'userId: string, runQuery?: RbacPermissionQueryFn',
  executor: 'exec',
  reads: ['runQuery', 'pool'],
  declaration: "const exec: RbacPermissionQueryFn = typeof runQuery === 'function' ? runQuery : async (sql, params) => { if (!pool) return { rows: [] } return pool.query(sql, params) }",
} as const
const STATEMENT_NOT_AN_ARGUMENT_PROBLEM = `${SERVICE_READER}: a literal that names roles is not itself the first argument of a call`
const STATEMENT_OUTSIDE_FUNCTION_PROBLEM = `${SERVICE_READER}: a literal that names roles is not directly in ${ROLE_NAME_STATEMENT_SITE.function}`
const EXECUTOR_DECLARATION_PROBLEM = `${SERVICE_READER}: the first statement of ${ROLE_NAME_STATEMENT_SITE.function} is not the pinned declaration of ${ROLE_NAME_STATEMENT_SITE.executor}`
const SITE_PARAMETERS_PROBLEM = `${SERVICE_READER}: the parameters of ${ROLE_NAME_STATEMENT_SITE.function} are not the pinned parameters`
const statementCalleeProblem = (callee: string) => `${SERVICE_READER}: the statement that names roles is handed to ${callee}, not to ${ROLE_NAME_STATEMENT_SITE.executor}`
const aliasElsewhereProblem = (words: string) => `${SERVICE_READER}: a literal apart from the statement that names roles reads the alias r, in "${words}"`
const reboundProblem = (name: string) => `${SERVICE_READER}: ${name}, which the executor reads, is bound again inside ${ROLE_NAME_STATEMENT_SITE.function}`
const executorUseProblem =(use: string) => `${SERVICE_READER}: ${ROLE_NAME_STATEMENT_SITE.executor} appears as "${use}", not as the callee of a direct call in ${ROLE_NAME_STATEMENT_SITE.function}`
const siteFunctionCountProblem = (count: number) => `${SERVICE_READER}: ${ROLE_NAME_STATEMENT_SITE.function} is declared ${count} time(s), not once`

/** The text pieces of a string or template literal node, one per run between substitutions; null for any other node. */
function literalPieces(node: ts.Node): string[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
  return null
}

/** The innermost function a node stands in, or null at module level. */
function functionAround(node: ts.Node): ts.Node | null {
  for (let at = node.parent; at !== undefined; at = at.parent) if (ts.isFunctionLike(at) && !ts.isTypeNode(at)) return at
  return null
}

/** Whether an identifier is the name a declaration, a parameter or a binding pattern introduces. */
function bindsName(node: ts.Identifier): boolean {
  const parent = node.parent
  return (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)) && parent.name === node
}

/** Problems of the place of the role-name statement and of its executor in the service reader. */
function roleNameStatementSiteProblems(reader: string, source: string): string[] {
  if (reader !== ROLE_NAME_JOIN.reader) return []
  const site = ROLE_NAME_STATEMENT_SITE
  const file = ts.createSourceFile(reader, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declared = file.statements.filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === site.function)
  if (declared.length !== 1) return [siteFunctionCountProblem(declared.length)]
  const fn = declared[0]
  const problems: string[] = []
  if (squash(fn.parameters.map((parameter) => parameter.getText(file)).join(', ')) !== site.parameters) problems.push(SITE_PARAMETERS_PROBLEM)
  const first = fn.body?.statements[0]
  const firstDeclaration = first !== undefined && ts.isVariableStatement(first) && first.declarationList.declarations.length === 1 ? first.declarationList.declarations[0] : null
  if (first === undefined || firstDeclaration === null || squash(first.getText(file)) !== site.declaration) problems.push(EXECUTOR_DECLARATION_PROBLEM)
  const visit = (node: ts.Node) => {
    const pieces = literalPieces(node)
    if (pieces !== null && /\broles\b/i.test(pieces.join('\u0000'))) {
      const call = node.parent
      if (!(ts.isCallExpression(call) && call.arguments[0] === node)) problems.push(STATEMENT_NOT_AN_ARGUMENT_PROBLEM)
      else if (!(ts.isIdentifier(call.expression) && call.expression.text === site.executor)) problems.push(statementCalleeProblem(squash(call.expression.getText(file))))
      if (functionAround(node) !== fn) problems.push(STATEMENT_OUTSIDE_FUNCTION_PROBLEM)
    } else if (pieces !== null) {
      for (const piece of pieces) {
        for (const use of piece.matchAll(/\br"?\s*\./gi)) problems.push(aliasElsewhereProblem(wordsAround(piece, use.index ?? 0, 1, 1)))
      }
    }
    if (ts.isIdentifier(node) && node.text === site.executor && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      const isFirstDeclaration = firstDeclaration !== null && firstDeclaration.name === node
      const isDirectCall = ts.isCallExpression(node.parent) && node.parent.expression === node && functionAround(node) === fn
      if (!isFirstDeclaration && !isDirectCall) problems.push(executorUseProblem(squash(node.parent.getText(file)).slice(0, 48)))
    }
    if (ts.isIdentifier(node) && (site.reads as readonly string[]).includes(node.text) && bindsName(node) && node.pos >= fn.pos && node.end <= fn.end) {
      if (!(ts.isParameter(node.parent) && node.parent.parent === fn)) problems.push(reboundProblem(node.text))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return problems
}

/** Problems of the place of the literals whose whole text is `roles`: each is an element of the one list of the one reader. */
function rolesResourceNameSiteProblems(reader: string, source: string): string[] {
  const { reader: listReader, name } = ROLES_RESOURCE_NAME_LIST
  const file = ts.createSourceFile(reader, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const problems: string[] = []
  const inTheList = (node: ts.Node): boolean => {
    const list = node.parent
    if (reader !== listReader || !ts.isArrayLiteralExpression(list)) return false
    const set = list.parent
    if (!ts.isNewExpression(set) || !ts.isIdentifier(set.expression) || set.expression.text !== 'Set' || set.arguments?.length !== 1 || set.arguments[0] !== list) return false
    const declaration = set.parent
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== set || !ts.isIdentifier(declaration.name) || declaration.name.text !== name) return false
    const declarations = declaration.parent
    return ts.isVariableDeclarationList(declarations) && (declarations.flags & ts.NodeFlags.Const) !== 0 && ts.isVariableStatement(declarations.parent) && declarations.parent.parent === file
  }
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && squash(node.text) === ROLE_NAME_JOIN.table && !inTheList(node)) {
      problems.push(`${reader}: a literal whose whole text is roles is not an element of ${name}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return problems
}

/** Every reader rule on one reader: the closure with its one exception, the place of the exception's statement, and the place of the resource name. */
function readerProblems(reader: string, source: string): string[] {
  return [...readerClosureProblems(reader, source), ...roleNameStatementSiteProblems(reader, source), ...rolesResourceNameSiteProblems(reader, source)]
}

// Replacement anchors below use LF regardless of the checkout's line endings.
const serviceSource = read(SERVICE_READER).replaceAll('\r\n', '\n')
const namespaceSource = read(NAMESPACE_READER).replaceAll('\r\n', '\n')
const ROLE_NAME_TEMPLATE = /`SELECT DISTINCT rp\.permission_code AS code,[^`]*`/
const roleNameTemplate = (serviceSource.match(ROLE_NAME_TEMPLATE) ?? [''])[0]
const ROLE_NAME_CALL = /await exec\(\s*`SELECT DISTINCT rp\.permission_code AS code,[^`]*`,\s*\[userId\],\s*\)/
const LOGGER_LINE = "const logger = new Logger('RBACService')"

/** The service reader with the role-name statement kept in a module constant and `expression` handed to the executor in its place. */
function withStatementConstant(expression: string, appended = '', exported = false): string {
  const moved = editOnce(serviceSource, ROLE_NAME_TEMPLATE, expression)
  return editOnce(moved, LOGGER_LINE, `${LOGGER_LINE}\n${exported ? 'export ' : ''}const INHERITED_SQL = ${roleNameTemplate}`) + appended
}

describe('table list closure', () => {
  it('the tables the classifier statement reads equal its table constant, which is the scanner\'s input set', () => {
    const statement = classifierStatementText()
    const tables = new Set([...statement.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((match) => match[1]))
    expect([...tables].sort()).toEqual([...PRIVILEGE_GRANT_SOURCE_TABLES].sort())
    expect([...INPUT_TABLES].sort()).toEqual([...PRIVILEGE_GRANT_SOURCE_TABLES].sort())
  })

  it('the authorization readers reference no grant table outside the classifier\'s set', () => {
    // The one exception is the role-name join, pinned by shape and by place above: it shows a role's name.
    for (const reader of AUTHORIZATION_READERS) {
      const source = read(reader)
      expect(grantTablesRead(source).size, reader).toBeGreaterThanOrEqual(2)
      expect(readerClosureProblems(reader, source), reader).toEqual([])
      expect(roleNameStatementSiteProblems(reader, source), reader).toEqual([])
      expect(rolesResourceNameSiteProblems(reader, source), reader).toEqual([])
    }
  })

  it('CONTROL — the role-name join passes as production writes it and when the same statement is laid out on one line', () => {
    expect(squash(literalTexts(SERVICE_READER, serviceSource).find((text) => /\broles\b/.test(text)) ?? '')).toBe(ROLE_NAME_JOIN.statement)
    expect(readerProblems(SERVICE_READER, serviceSource)).toEqual([])
    const oneLine = editOnce(serviceSource, ROLE_NAME_TEMPLATE, `\`${ROLE_NAME_JOIN.statement}\``)
    expect(oneLine).not.toBe(serviceSource)
    expect(readerProblems(SERVICE_READER, oneLine)).toEqual([])
    expect(readerProblems(NAMESPACE_READER, namespaceSource)).toEqual([])
  })

  it('POSITIVE CONTROL — an inner join of roles is a problem, written with or without INNER', () => {
    const bare = editOnce(serviceSource, 'LEFT JOIN roles r', 'JOIN roles r')
    expect(readerClosureProblems(SERVICE_READER, bare)).toEqual([
      `${SERVICE_READER}: roles is referenced as "ur.role_id JOIN roles r", not as "${ROLE_NAME_JOIN.clause}"`,
      PINNED_STATEMENT_PROBLEM,
    ])
    const inner = editOnce(serviceSource, 'LEFT JOIN roles r', 'INNER JOIN roles r')
    expect(readerClosureProblems(SERVICE_READER, inner)).toEqual([
      `${SERVICE_READER}: roles is referenced as "INNER JOIN roles r", not as "${ROLE_NAME_JOIN.clause}"`,
      PINNED_STATEMENT_PROBLEM,
    ])
    const lower = editOnce(serviceSource, 'LEFT JOIN roles r', 'left join ROLES r')
    expect(readerClosureProblems(SERVICE_READER, lower)).toEqual([
      `${SERVICE_READER}: roles is referenced as "left join ROLES r", not as "${ROLE_NAME_JOIN.clause}"`,
      PINNED_STATEMENT_PROBLEM,
    ])
  })

  it('POSITIVE CONTROL — a second mention of roles is a problem, even as a copy of the pinned statement or of the pinned join', () => {
    const copy = `${serviceSource}\nconst again = \`${ROLE_NAME_JOIN.statement}\`\n`
    expect(readerClosureProblems(SERVICE_READER, copy)).toEqual([`${SERVICE_READER} reads roles`, `${SERVICE_READER}: statement text mentions roles 2 time(s), not once`])
    const elsewhere = editOnce(serviceSource, 'WHERE ur.user_id = $1 AND rp.permission_code = $2', `${ROLE_NAME_JOIN.clause} WHERE ur.user_id = $1 AND rp.permission_code = $2`)
    expect(readerClosureProblems(SERVICE_READER, elsewhere)).toEqual([`${SERVICE_READER} reads roles`, `${SERVICE_READER}: statement text mentions roles 2 time(s), not once`, PINNED_STATEMENT_PROBLEM])
    const commaJoin = editOnce(serviceSource, 'WHERE ur.user_id = $1 AND rp.permission_code = $2', ', roles x WHERE ur.user_id = $1 AND rp.permission_code = $2')
    expect(readerClosureProblems(SERVICE_READER, commaJoin)).toEqual([
      `${SERVICE_READER}: statement text mentions roles 2 time(s), not once`,
      `${SERVICE_READER}: roles is referenced as "ur.role_id , roles x", not as "${ROLE_NAME_JOIN.clause}"`,
      PINNED_STATEMENT_PROBLEM,
    ])
    const inComment = `${serviceSource}\n// an earlier form read: JOIN roles\n`
    expect(readerClosureProblems(SERVICE_READER, inComment)).toEqual([`${SERVICE_READER} reads roles`])
    const removed = editOnce(serviceSource, ROLE_NAME_JOIN.clause, '')
    expect(readerClosureProblems(SERVICE_READER, removed)).toEqual([`${SERVICE_READER}: statement text mentions roles 0 time(s), not once`])
    const resourceName = `${serviceSource}\nconst resources = ['roles']\n`
    expect(readerClosureProblems(SERVICE_READER, resourceName)).toEqual([`${SERVICE_READER}: the word roles is the whole text of 1 literal(s), not of 0`])
  })

  it('POSITIVE CONTROL — FROM roles is a problem, as the first table or inside a derived table', () => {
    const derived = editOnce(serviceSource, ROLE_NAME_JOIN.clause, 'LEFT JOIN (SELECT id, name FROM roles) r ON r.id = ur.role_id')
    expect(readerClosureProblems(SERVICE_READER, derived)).toEqual([
      `${SERVICE_READER}: roles is referenced as "name FROM roles) r", not as "${ROLE_NAME_JOIN.clause}"`,
      PINNED_STATEMENT_PROBLEM,
    ])
    const first = editOnce(serviceSource, /FROM user_roles ur\s+JOIN role_permissions rp ON rp\.role_id = ur\.role_id\s+LEFT JOIN roles r ON r\.id = ur\.role_id/, 'FROM roles r JOIN user_roles ur ON ur.role_id = r.id JOIN role_permissions rp ON rp.role_id = ur.role_id')
    expect(readerClosureProblems(SERVICE_READER, first)).toEqual([
      `${SERVICE_READER}: roles is referenced as "role_name FROM roles r", not as "${ROLE_NAME_JOIN.clause}"`,
      PINNED_STATEMENT_PROBLEM,
    ])
  })

  it('POSITIVE CONTROL — reading another column of the joined role, every column, or the row itself, is a problem', () => {
    const column = editOnce(serviceSource, ROLE_NAME_JOIN.projection, 'r.is_system AS role_name')
    expect(readerClosureProblems(SERVICE_READER, column)).toEqual([`${SERVICE_READER}: the role-name join's alias is read as "r.is_system", not as "r.name"`, PINNED_STATEMENT_PROBLEM])
    const star = editOnce(serviceSource, ROLE_NAME_JOIN.projection, 'r.*')
    expect(readerClosureProblems(SERVICE_READER, star)).toEqual([`${SERVICE_READER}: the role-name join's alias is read as "r.*", not as "r.name"`, PINNED_STATEMENT_PROBLEM])
    const row = editOnce(serviceSource, ROLE_NAME_JOIN.projection, 'r AS role_name')
    expect(readerClosureProblems(SERVICE_READER, row)).toEqual([`${SERVICE_READER}: the role-name join's alias is read as "r", not as "r.name"`, PINNED_STATEMENT_PROBLEM])
    const both = editOnce(serviceSource, ROLE_NAME_JOIN.projection, `${ROLE_NAME_JOIN.projection}, r.is_system AS role_is_system`)
    expect(readerClosureProblems(SERVICE_READER, both)).toEqual([`${SERVICE_READER}: the role-name join's alias is read as "r.is_system", not as "r.name"`, PINNED_STATEMENT_PROBLEM])
  })

  it('POSITIVE CONTROL — the joined role in a condition is a problem: in WHERE, in a longer ON, in a computed column, as a column named without the alias, or behind a substituted fragment', () => {
    const joinThenWhere = /LEFT JOIN roles r ON r\.id = ur\.role_id\s+WHERE ur\.user_id = \$1/
    const where = editOnce(serviceSource, joinThenWhere, `${ROLE_NAME_JOIN.clause} WHERE r.name = $2 AND ur.user_id = $1`)
    expect(readerClosureProblems(SERVICE_READER, where)).toEqual([`${SERVICE_READER}: r.name is used outside the select list, in "WHERE r.name = $2"`, PINNED_STATEMENT_PROBLEM])
    const on = editOnce(serviceSource, joinThenWhere, `${ROLE_NAME_JOIN.clause} AND r.name IS NOT NULL WHERE ur.user_id = $1`)
    expect(readerClosureProblems(SERVICE_READER, on)).toEqual([`${SERVICE_READER}: r.name is used outside the select list, in "AND r.name IS NOT"`, PINNED_STATEMENT_PROBLEM])
    const computed = editOnce(serviceSource, 'rp.permission_code AS code,', "CASE WHEN r.name = 'admin' THEN rp.permission_code END AS code,")
    expect(readerClosureProblems(SERVICE_READER, computed)).toEqual([`${SERVICE_READER}: r.name is used outside the select list, in "WHEN r.name = 'admin'"`, PINNED_STATEMENT_PROBLEM])
    const subquery = editOnce(serviceSource, joinThenWhere, `${ROLE_NAME_JOIN.clause} WHERE ur.user_id = $1 AND EXISTS (SELECT ${ROLE_NAME_JOIN.projection} FROM user_permissions)`)
    expect(readerClosureProblems(SERVICE_READER, subquery)).toEqual([`${SERVICE_READER}: r.name is used outside the select list, in "(SELECT r.name AS role_name"`, PINNED_STATEMENT_PROBLEM])
    const unqualified = editOnce(serviceSource, joinThenWhere, `${ROLE_NAME_JOIN.clause} WHERE ur.user_id = $1 AND name = $2`)
    expect(readerClosureProblems(SERVICE_READER, unqualified)).toEqual([PINNED_STATEMENT_PROBLEM])
    const substituted = editOnce(serviceSource, joinThenWhere, `${ROLE_NAME_JOIN.clause} WHERE ur.user_id = $1 \${extra}`)
    expect(readerClosureProblems(SERVICE_READER, substituted)).toEqual([PINNED_STATEMENT_PROBLEM])
  })

  it('POSITIVE CONTROL — the namespace reader mentioning roles is a problem, whichever way the table is named', () => {
    const commaJoin = editOnce(namespaceSource, 'FROM user_namespace_admissions', 'FROM user_namespace_admissions, roles')
    expect(readerClosureProblems(NAMESPACE_READER, commaJoin)).toEqual([`${NAMESPACE_READER}: statement text mentions roles 1 time(s); only the role-name join may`])
    const qualified = editOnce(namespaceSource, 'FROM user_namespace_admissions', 'FROM user_namespace_admissions JOIN public.roles r ON TRUE')
    expect(readerClosureProblems(NAMESPACE_READER, qualified)).toEqual([`${NAMESPACE_READER}: statement text mentions roles 1 time(s); only the role-name join may`])
    const pinnedJoin = editOnce(namespaceSource, 'FROM user_namespace_admissions', `FROM user_namespace_admissions ${ROLE_NAME_JOIN.clause}`)
    expect(readerClosureProblems(NAMESPACE_READER, pinnedJoin)).toEqual([
      `${NAMESPACE_READER} reads roles`,
      `${NAMESPACE_READER}: statement text mentions roles 1 time(s); only the role-name join may`,
    ])
    const resourceName = `${namespaceSource}\nconst resources = ['roles']\n`
    expect(readerClosureProblems(NAMESPACE_READER, resourceName)).toEqual([`${NAMESPACE_READER}: the word roles is the whole text of 2 literal(s), not of 1`])
  })

  it('POSITIVE CONTROL — every other grant table outside the classifier\'s set is still a problem in both readers', () => {
    const groups = editOnce(serviceSource, ROLE_NAME_JOIN.clause, `${ROLE_NAME_JOIN.clause} JOIN platform_member_groups g ON g.id = ur.role_id`)
    expect(readerClosureProblems(SERVICE_READER, groups)).toEqual([`${SERVICE_READER} reads platform_member_groups`, PINNED_STATEMENT_PROBLEM])
    const apart = `${serviceSource}\nconst other = 'SELECT 1 FROM role_templates'\n`
    expect(readerClosureProblems(SERVICE_READER, apart)).toEqual([`${SERVICE_READER} reads role_templates`])
    const namespace = editOnce(namespaceSource, 'FROM user_namespace_admissions', 'FROM user_namespace_admissions JOIN platform_member_groups g ON TRUE')
    expect(readerClosureProblems(NAMESPACE_READER, namespace)).toEqual([`${NAMESPACE_READER} reads platform_member_groups`])
    expect(() => editOnce(serviceSource, 'WHERE ur.user_id = $1', '')).toThrow('occurs')
    expect(() => editOnce(serviceSource, 'no such text', '')).toThrow('occurs 0 times')
  })

  it('POSITIVE CONTROL — the role-name statement kept in a constant is a problem, however the constant is then run; the shape judgment alone sees none of it', () => {
    expect(roleNameTemplate).not.toBe('')
    const kept = [STATEMENT_NOT_AN_ARGUMENT_PROBLEM, STATEMENT_OUTSIDE_FUNCTION_PROBLEM]
    const expectSite = (source: string, problems: string[]) => {
      expect(readerClosureProblems(SERVICE_READER, source)).toEqual([])
      expect(roleNameStatementSiteProblems(SERVICE_READER, source)).toEqual(problems)
    }
    expectSite(withStatementConstant('INHERITED_SQL'), kept)
    expectSite(withStatementConstant('`${INHERITED_SQL} AND NOT r.is_system`'), [...kept, aliasElsewhereProblem('NOT r.is_system')])
    expectSite(withStatementConstant("INHERITED_SQL + ' AND NOT r.is_system'"), [...kept, aliasElsewhereProblem('NOT r.is_system')])
    expectSite(withStatementConstant("INHERITED_SQL.replace('LEFT JOIN', 'JOIN')"), kept)
    expectSite(withStatementConstant("INHERITED_SQL.replace('r.name', 'r.is_system')"), [...kept, aliasElsewhereProblem('r.name'), aliasElsewhereProblem('r.is_system')])
    const decision = '\nexport async function hasSystemRole(userId: string): Promise<boolean> {\n  const { rows } = await pool!.query(`${INHERITED_SQL} AND r.is_system`, [userId])\n  return rows.length > 0\n}\n'
    expectSite(withStatementConstant('INHERITED_SQL', decision), [...kept, aliasElsewhereProblem('AND r.is_system')])
    const secondSite = '\nexport async function inheritedAgain(userId: string) {\n  return (await pool!.query(INHERITED_SQL, [userId])).rows\n}\n'
    expectSite(withStatementConstant('INHERITED_SQL', secondSite), kept)
    expectSite(withStatementConstant('INHERITED_SQL', '', true), kept)
  })

  it('POSITIVE CONTROL — text joined to the role-name statement where it is written is a problem', () => {
    const plus = editOnce(serviceSource, ROLE_NAME_TEMPLATE, `${roleNameTemplate} + ' AND NOT r.is_system'`)
    expect(readerClosureProblems(SERVICE_READER, plus)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, plus)).toEqual([STATEMENT_NOT_AN_ARGUMENT_PROBLEM, aliasElsewhereProblem('NOT r.is_system')])
    const concat = editOnce(serviceSource, ROLE_NAME_TEMPLATE, `${roleNameTemplate}.concat(' AND "r".is_system')`)
    expect(readerClosureProblems(SERVICE_READER, concat)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, concat)).toEqual([STATEMENT_NOT_AN_ARGUMENT_PROBLEM, aliasElsewhereProblem('AND "r".is_system')])
    const wrapped = editOnce(serviceSource, ROLE_NAME_TEMPLATE, `(${roleNameTemplate})`)
    expect(roleNameStatementSiteProblems(SERVICE_READER, wrapped)).toEqual([STATEMENT_NOT_AN_ARGUMENT_PROBLEM])
    const elsewhere = `${serviceSource}\nconst condition = 'r.is_system'\n`
    expect(readerClosureProblems(SERVICE_READER, elsewhere)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, elsewhere)).toEqual([aliasElsewhereProblem('r.is_system')])
  })

  it('POSITIVE CONTROL — the role-name statement handed to anything but a direct call of the executor in the one function is a problem', () => {
    const call = 'const inheritedResult = await exec('
    const appending = editOnce(serviceSource, call, "const run = (s: string, p: unknown[]) => exec(s + ' AND r.is_system', p)\n    const inheritedResult = await run(")
    expect(readerClosureProblems(SERVICE_READER, appending)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, appending)).toEqual([
      executorUseProblem("exec(s + ' AND r.is_system', p)"),
      aliasElsewhereProblem('AND r.is_system'),
      statementCalleeProblem('run'),
    ])
    const rewriting = editOnce(serviceSource, call, "const run = (s: string, p: unknown[]) => exec(s.replace('LEFT JOIN', 'JOIN'), p)\n    const inheritedResult = await run(")
    expect(readerClosureProblems(SERVICE_READER, rewriting)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, rewriting)).toEqual([executorUseProblem("exec(s.replace('LEFT JOIN', 'JOIN'), p)"), statementCalleeProblem('run')])
    const otherCallee = editOnce(serviceSource, call, 'const inheritedResult = await pool!.query(')
    expect(readerClosureProblems(SERVICE_READER, otherCallee)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, otherCallee)).toEqual([statementCalleeProblem('pool!.query')])
    const laterArgument = editOnce(serviceSource, ROLE_NAME_CALL, `await exec('SELECT 1', \`${ROLE_NAME_JOIN.statement}\`, [userId])`)
    expect(readerClosureProblems(SERVICE_READER, laterArgument)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, laterArgument)).toEqual([STATEMENT_NOT_AN_ARGUMENT_PROBLEM])
    const renamed =editOnce(serviceSource, call, 'const run = exec\n    const inheritedResult = await run(')
    expect(roleNameStatementSiteProblems(SERVICE_READER, renamed)).toEqual([executorUseProblem('run = exec'), statementCalleeProblem('run')])
    const nested = editOnce(serviceSource, ROLE_NAME_CALL, `await (async () => exec(\`${ROLE_NAME_JOIN.statement}\`, [userId]))()`)
    expect(readerClosureProblems(SERVICE_READER, nested)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, nested)).toEqual([
      executorUseProblem('exec(`SELECT DISTINCT rp.permission_code AS code'),
      STATEMENT_OUTSIDE_FUNCTION_PROBLEM,
    ])
    const otherFunction = `${editOnce(serviceSource, ROLE_NAME_CALL, 'await inheritedRows(exec, userId)')}\nasync function inheritedRows(exec: RbacPermissionQueryFn, userId: string) {\n  return exec(\`${ROLE_NAME_JOIN.statement}\`, [userId])\n}\n`
    expect(readerClosureProblems(SERVICE_READER, otherFunction)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, otherFunction)).toEqual([
      executorUseProblem('inheritedRows(exec, userId)'),
      executorUseProblem('exec: RbacPermissionQueryFn'),
      executorUseProblem('exec(`SELECT DISTINCT rp.permission_code AS code'),
      STATEMENT_OUTSIDE_FUNCTION_PROBLEM,
    ])
  })

  it('POSITIVE CONTROL — an executor other than the pinned one is a problem: rewritten, declared again, reassignable, behind an earlier statement or a changed parameter, or reading a name bound again', () => {
    const rewritten = editOnce(serviceSource, 'return pool.query(sql, params)', "return pool.query(sql.replace('LEFT JOIN', 'JOIN'), params)")
    expect(readerClosureProblems(SERVICE_READER, rewritten)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, rewritten)).toEqual([EXECUTOR_DECLARATION_PROBLEM])
    const again = editOnce(serviceSource, 'const inheritedResult = await exec(', "const exec = (s: string, p: unknown[]) => pool!.query(s.replace('LEFT JOIN', 'JOIN'), p)\n    const inheritedResult = await exec(")
    expect(readerClosureProblems(SERVICE_READER, again)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, again)).toEqual([executorUseProblem("exec = (s: string, p: unknown[]) => pool!.query(")])
    const reassignable = editOnce(serviceSource, 'const exec: RbacPermissionQueryFn', 'let exec: RbacPermissionQueryFn')
    expect(roleNameStatementSiteProblems(SERVICE_READER, reassignable)).toEqual([EXECUTOR_DECLARATION_PROBLEM])
    const earlier = editOnce(serviceSource, 'const exec: RbacPermissionQueryFn', 'runQuery = runQuery && rewriting(runQuery)\n  const exec: RbacPermissionQueryFn')
    expect(roleNameStatementSiteProblems(SERVICE_READER, earlier)).toEqual([EXECUTOR_DECLARATION_PROBLEM, executorUseProblem("exec: RbacPermissionQueryFn = typeof runQuery ==")])
    const parameter = editOnce(serviceSource, /runQuery\?: RbacPermissionQueryFn,\n\): Promise<UserPermissionGrantInspection>/, 'runQuery: RbacPermissionQueryFn = rewritingQuery,\n): Promise<UserPermissionGrantInspection>')
    expect(readerClosureProblems(SERVICE_READER, parameter)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, parameter)).toEqual([SITE_PARAMETERS_PROBLEM])
    const rebound = editOnce(serviceSource, "if (typeof runQuery !== 'function' && !pool) {", "const pool = rewritingPool\n  if (typeof runQuery !== 'function' && !pool) {")
    expect(readerClosureProblems(SERVICE_READER, rebound)).toEqual([])
    expect(roleNameStatementSiteProblems(SERVICE_READER, rebound)).toEqual([reboundProblem('pool')])
    const twice = `${serviceSource}\nfunction ${ROLE_NAME_STATEMENT_SITE.function}() {}\n`
    expect(roleNameStatementSiteProblems(SERVICE_READER, twice)).toEqual([siteFunctionCountProblem(2)])
    const none = editOnce(serviceSource, `export async function ${ROLE_NAME_STATEMENT_SITE.function}(`, 'export async function inspectGrants(')
    expect(roleNameStatementSiteProblems(SERVICE_READER, none)).toEqual([siteFunctionCountProblem(0)])
    // The executor's name as a property of something else is not the executor.
    expect(roleNameStatementSiteProblems(SERVICE_READER, `${serviceSource}\nconst found = /a/.exec('a')\n`)).toEqual([])
    expect(roleNameStatementSiteProblems(NAMESPACE_READER, rewritten)).toEqual([])
  })

  it('POSITIVE CONTROL — the resource name moved out of its list is a problem, though the count of such literals is unchanged', () => {
    const outside = `${NAMESPACE_READER}: a literal whose whole text is roles is not an element of ${ROLES_RESOURCE_NAME_LIST.name}`
    const withoutElement = editOnce(namespaceSource, "  'roles',\n", '')
    expect(rolesResourceNameSiteProblems(NAMESPACE_READER, withoutElement)).toEqual([])
    expect(readerClosureProblems(NAMESPACE_READER, withoutElement)).toEqual([`${NAMESPACE_READER}: the word roles is the whole text of 0 literal(s), not of 1`])
    const formatted = `${withoutElement}\nconst names = format('SELECT name FROM %I', 'roles')\n`
    expect(readerClosureProblems(NAMESPACE_READER, formatted)).toEqual([])
    expect(rolesResourceNameSiteProblems(NAMESPACE_READER, formatted)).toEqual([outside])
    const builder = `${withoutElement}\nconst names = db.selectFrom(' roles ').select('name')\n`
    expect(readerClosureProblems(NAMESPACE_READER, builder)).toEqual([])
    expect(rolesResourceNameSiteProblems(NAMESPACE_READER, builder)).toEqual([outside])
    const otherList = `${withoutElement}\nconst TABLES = new Set(['roles'])\n`
    expect(rolesResourceNameSiteProblems(NAMESPACE_READER, otherList)).toEqual([outside])
    const plainArray = editOnce(editOnce(namespaceSource, `const ${ROLES_RESOURCE_NAME_LIST.name} = new Set([`, `const ${ROLES_RESOURCE_NAME_LIST.name} = [`), "  'workflow',\n])", "  'workflow',\n]")
    expect(rolesResourceNameSiteProblems(NAMESPACE_READER, plainArray)).toEqual([outside])
    const localList = `${withoutElement}\nfunction tables() {\n  const ${ROLES_RESOURCE_NAME_LIST.name} = new Set(['roles'])\n  return ${ROLES_RESOURCE_NAME_LIST.name}\n}\n`
    expect(readerClosureProblems(NAMESPACE_READER, localList)).toEqual([])
    expect(rolesResourceNameSiteProblems(NAMESPACE_READER, localList)).toEqual([outside])
    const added = `${namespaceSource}\nconst names = format('SELECT name FROM %I', 'roles')\n`
    expect(readerProblems(NAMESPACE_READER, added)).toEqual([`${NAMESPACE_READER}: the word roles is the whole text of 2 literal(s), not of 1`, outside])
    const service = `${serviceSource}\nconst ${ROLES_RESOURCE_NAME_LIST.name} = new Set(['roles'])\n`
    expect(rolesResourceNameSiteProblems(SERVICE_READER, service)).toEqual([`${SERVICE_READER}: a literal whose whole text is roles is not an element of ${ROLES_RESOURCE_NAME_LIST.name}`])
  })
})

/** A `B0` insert: no admin or permission column, a literal `'user'` role in the VALUES list, and no `ON CONFLICT` action. */
function birthOnlyProblems(source: string): string[] {
  const problems: string[] = []
  const inserts = [...source.matchAll(/INSERT\s+INTO\s+users\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)([\s\S]{0,300})/gi)]
  if (inserts.length === 0) return ['no users insert found']
  for (const insert of inserts) {
    const columns = insert[1].split(',').map((column) => column.trim().toLowerCase())
    const values = insert[2].split(',').map((value) => value.trim())
    if (columns.includes('is_admin')) problems.push('inserts is_admin')
    if (columns.includes('permissions')) problems.push('inserts permissions')
    const role = columns.indexOf('role')
    if (role >= 0 && values[role] !== "'user'") problems.push(`role is ${values[role] ?? 'missing'}`)
    if (/^\s*ON\s+CONFLICT\b/i.test(insert[3])) problems.push('carries an ON CONFLICT action')
  }
  return problems
}

describe('birth-only writer shape', () => {
  it('the one user insert outside the contract creates a plain user and no input', () => {
    for (const writer of AUTHORIZATION_INPUT_WRITERS.filter((w) => w.class === 'B0')) {
      expect(birthOnlyProblems(read(writer.file)), writer.id).toEqual([])
    }
    expect(AUTHORIZATION_INPUT_WRITERS.filter((w) => w.class === 'B0')).toHaveLength(1)
  })

  it('POSITIVE CONTROL — an admin column, a permission column or a non-literal role is a problem', () => {
    expect(birthOnlyProblems("INSERT INTO users (id, role) VALUES ($1, 'user')")).toEqual([])
    expect(birthOnlyProblems('INSERT INTO users (id, role) VALUES ($1, $2)')).toEqual(['role is $2'])
    expect(birthOnlyProblems("INSERT INTO users (id, role, is_admin) VALUES ($1, 'user', TRUE)")).toEqual(['inserts is_admin'])
    expect(birthOnlyProblems("INSERT INTO users (id, permissions) VALUES ($1, '[]')")).toEqual(['inserts permissions'])
    expect(birthOnlyProblems("INSERT INTO users (id, role) VALUES ($1, 'user') ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role")).toEqual(['carries an ON CONFLICT action'])
    expect(birthOnlyProblems("INSERT INTO users (id, role) VALUES ($1, 'user') ON CONFLICT DO NOTHING")).toEqual(['carries an ON CONFLICT action'])
  })
})

/* ───────────────────────────── late role rows ───────────────────────────── */

/** The callers that take a role row late, as `file|function`; the registry must equal this list. */
const LATE_ROLE_ROW_CALLER_KEYS: readonly string[] = [
  `${SRC}/auth/AuthService.ts|insertUserRolesOnce`,
  `${SRC}/directory/directory-sync.ts|applyDirectoryProjectedMemberGroupGovernanceInTransaction`,
]

/** Names of the functions in `source` that enclose a call of `callee`. */
function callersOf(file: string, source: string, callee: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
      names.push(enclosingFunctionAt(file, source, node.getStart(tree))?.name ?? '<module>')
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return names
}

function lateRoleRowProblems(registry: readonly AuthorizationInputLateRoleRowCaller[], pinned: readonly string[], sourceOf: (file: string) => string): string[] {
  const problems: string[] = []
  const keys = registry.map((caller) => `${caller.file}|${caller.symbol}`)
  for (const key of keys) if (!pinned.includes(key)) problems.push(`${key}: late role row caller outside the pinned set`)
  for (const key of pinned) if (!keys.includes(key)) problems.push(`${key}: pinned late role row caller is not registered`)
  if (new Set(keys).size !== keys.length) problems.push('a late role row caller is registered twice')
  for (const caller of registry) {
    if (caller.roleRows !== 'late' || caller.callee !== 'assignUserRoles') problems.push(`${caller.id}: not a late caller of the role-membership writer`)
    const found = callersOf(caller.file, sourceOf(caller.file), caller.callee).filter((name) => name === caller.symbol).length
    if (found !== 1) problems.push(`${caller.id}: ${caller.symbol} calls ${caller.callee} ${found} time(s)`)
  }
  return problems
}

describe('late role row callers', () => {
  it('the registered callers are the pinned set, and each still calls the role-membership writer once', () => {
    expect(lateRoleRowProblems(AUTHORIZATION_INPUT_LATE_ROLE_ROW_CALLERS, LATE_ROLE_ROW_CALLER_KEYS, read)).toEqual([])
    expect(AUTHORIZATION_INPUT_LATE_ROLE_ROW_CALLERS).toHaveLength(2)
    expect(new Set(AUTHORIZATION_INPUT_LATE_ROLE_ROW_CALLERS.map((caller) => caller.id)).size).toBe(2)
    // The writer they call is the registered membership insert.
    const writer = AUTHORIZATION_INPUT_WRITERS.find((entry) => entry.symbol === 'assignUserRoles')
    expect(writer?.statements).toEqual([{ table: 'user_roles', verb: 'INSERT', count: 1 }])
  })

  it('POSITIVE CONTROL — a third caller, a removed caller, a caller that no longer calls the writer and a duplicate are each a problem', () => {
    const [first, second] = AUTHORIZATION_INPUT_LATE_ROLE_ROW_CALLERS
    const third: AuthorizationInputLateRoleRowCaller = { id: 'LR-X', file: `${SRC}/routes/admin-users.ts`, symbol: 'callback:transaction', callee: 'assignUserRoles', roleRows: 'late' }
    expect(lateRoleRowProblems([first, second, third], LATE_ROLE_ROW_CALLER_KEYS, read).some((p) => p.includes('outside the pinned set'))).toBe(true)
    expect(lateRoleRowProblems([first], LATE_ROLE_ROW_CALLER_KEYS, read)).toEqual([`${LATE_ROLE_ROW_CALLER_KEYS[1]}: pinned late role row caller is not registered`])
    expect(lateRoleRowProblems([first, second], LATE_ROLE_ROW_CALLER_KEYS, () => 'function insertUserRolesOnce() { return 1 }').length).toBe(2)
    expect(lateRoleRowProblems([first, second, second], LATE_ROLE_ROW_CALLER_KEYS, read)).toContain('a late role row caller is registered twice')
    const source = 'class A { private async insertUserRolesOnce() { await assignUserRoles({}) } }\nasync function applyDirectoryProjectedMemberGroupGovernanceInTransaction() { await assignUserRoles({}) }'
    expect(lateRoleRowProblems([first, second], LATE_ROLE_ROW_CALLER_KEYS, () => source)).toEqual([])
  })
})

/* ───────────────────────────── work closure body ───────────────────────────── */

/** The pull-source organisation lock: a contract transaction never takes it. */
const FORBIDDEN_PULL_SOURCE_LOCK = ['directoryOrgLockSql', 'directoryOrgLockKey', 'DIRECTORY_ORG_LOCK_KEY_PREFIX']
/** The functions of the pull-source write gate: a contract transaction never enters it. */
const FORBIDDEN_PULL_SOURCE_GATE = ['runGatedPullSourceWrite', 'runGatedRoutingPolicyClear', 'asPullSourceGateFailure']
const FORBIDDEN_IN_WORK = ['fetch', 'axios', 'bcrypt', 'setTimeout', 'sendMail', 'sendEmail', 'sendMessage', 'sendNotification', ...FORBIDDEN_PULL_SOURCE_LOCK, ...FORBIDDEN_PULL_SOURCE_GATE]
const PULL_SOURCE_RULE_MODULE = `${SRC}/directory/pull-source-rule.ts`
const PULL_SOURCE_GATE_MODULE = `${SRC}/directory/pull-source-write-gate.ts`

/** Names of the functions a module exports (declarations and `export const name = (…) =>`). */
function exportedFunctionNames(source: string): string[] {
  const tree = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  const exported = (node: ts.Node) => (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && exported(statement)) names.push(statement.name.text)
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) names.push(declaration.name.text)
      }
    }
  }
  return names
}

function workClosureProblems(file: string, source: string): string[] {
  const problems: string[] = []
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && /^(?:with|enter)AuthorizationInputTransaction$/.test(node.expression.getText(tree))) {
      const work = node.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
      if (work) {
        const identifiers = new Set<string>()
        const collect = (inner: ts.Node) => {
          if (ts.isIdentifier(inner)) identifiers.add(inner.text)
          ts.forEachChild(inner, collect)
        }
        collect(work)
        for (const forbidden of FORBIDDEN_IN_WORK) if (identifiers.has(forbidden)) problems.push(`${file}: work closure references ${forbidden}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return problems
}

/** Entry options a production caller may not supply, except one reviewed transaction runner at three ports. */
const TEST_ONLY_ENTRY_OPTIONS = ['transaction', 'afterAcquire']
const ENTRY_OPTION_PORTS = [
  { file: `${SRC}/auth/admin-grant-target-ceremony.ts`, owner: 'runRoot' },
  { file: `${SRC}/auth/security-action-attempt-admission.ts`, owner: 'runOwnedAttempt.runAis' },
  { file: `${SRC}/auth/strict-dingtalk-entry.ts`, owner: 'issueOnRoot' },
] as const
const CEREMONY_MOUNTS = ['startCurrentAppCeremony', 'completeCurrentAppCeremony']
const RUNTIME_MOUNTS = ['signInStrictDingTalkWeb', 'signInStrictDingTalkContainer', 'bindStrictDingTalkEntryLocal']
const PROVIDER_CALLS = ['exchangeCodeForUserAccessToken', 'fetchDingTalkCurrentUser', 'fetchDingTalkAppAccessTokenFresh', 'getDingTalkUserDetail', 'getDingTalkUserInfoByAuthCode']
const CEREMONY_WORK = ['assertGate(session)', 'await revalidatePrivilegeRolePlan(tx, plan)', 'tx.requireIdentityRead([connectionId])', 'return work(tx)']
const CEREMONY_OPTION = 'deps?.transaction ? { transaction: deps.transaction } : undefined'
const CEREMONY_DEPS = `export type CurrentAppCeremonyDeps = Readonly<{
  fetchFn?: typeof fetch
  transaction?: AuthorizationInputTransactionRunner
}>`
const CEREMONY_BINDER = `export function bindProductionTargetCeremony(): CurrentAppCeremonyRefusal {
  return { success: false, code: 'production_unavailable' }
}`
const ATTEMPT_ADAPTER = `async <U>(handler: (client: AuthorizationInputHandlerClient) => Promise<U>): Promise<U> => {
  rawOutcome.current = null
  if (!owner) {
    const error = new AttemptUnavailable()
    rawOutcome.current = { ok: false, error, rollbackAcked: true }
    throw error
  }
  const current = owner
  const result = await runStep((tx) => handler({
    query: (sql, params) => tx.query(sql, params),
    __rawClient: current.client,
  }))
  if (result.ok === true) {
    rawOutcome.current = { ok: true, value: result.value }
    return result.value
  }
  rawOutcome.current = { ok: false, error: result.error, rollbackAcked: result.rollbackAcked }
  throw result.error
}`
const ATTEMPT_CATCH = `catch (error) {
  const recorded = rawOutcome.current
  if (recorded !== null && recorded.ok === false) return recorded
  if (recorded !== null && recorded.ok === true) return { ok: false, error, rollbackAcked: false }
  return { ok: false, error, rollbackAcked: owner ? !owner.lost : true }
}`
const RUNTIME_RUNNER = `function runnerOf(transaction: AuthorizationInputTransactionRunner | undefined): AuthorizationInputTransactionRunner {
  if (transaction) return transaction
  return (handler) => poolManager.get().transaction((client) => handler({
    query: (sql, params) => client.query(sql, params),
    __rawClient: client.__rawClient,
  }))
}`
const RUNTIME_GATES = `export const STRICT_DINGTALK_ENTRY_GATES = Object.freeze({
  implementationPermit: false,
  productionAvailable: false,
  b2Complete: false,
  delivered: false,
  containerAdapterProved: false,
})`
const ENTRY_BINDING = 'withAuthorizationInputTransaction'
const ENTRY_MODULE = '../rbac/authorization-input-lock'
const AUTH_ROUTER_FILE = `${SRC}/routes/auth.ts`
const LOCAL_ENTRY = 'bindStrictDingTalkEntryLocal'
const LOCAL_ENTRY_MODULE = '../auth/strict-dingtalk-entry'
const LOCAL_ADAPTER = `function strictDingTalkSessionRunner(): AuthorizationInputTransactionRunner {
  return (handler) => transaction(async (client) => {
    const held = client as {
      query: (sql: string, params?: unknown[]) => Promise<import('pg').QueryResult>
      __rawClient?: import('pg').PoolClient
    }
    return handler({
      query: (sql, params) => held.query(sql, params),
      __rawClient: held.__rawClient,
    })
  })
}`
const LOCAL_FORWARDING = `const binding = await bindStrictDingTalkEntryLocal({
  fetchFn: input.fetchFn,
  env: input.env,
  transaction: strictDingTalkSessionRunner(),
})`
const LOCAL_FACTORY = `export async function bindStrictDingTalkEntryLocal(options: {
  fetchFn?: typeof fetch
  transaction?: AuthorizationInputTransactionRunner
  env?: Readonly<Record<string, string | undefined>>
} = {}): Promise<StrictDingTalkLocalBinding> {
  const auth = await import('./AuthService')
  const createToken: StrictTokenMinter = (user, tokenOptions) => auth.authService.createToken(user, tokenOptions)
  const readExp: StrictTokenExpReader = (token) => {
    const exp = auth.authService.readTokenPayload(token)?.exp
    return typeof exp === 'number' ? exp : null
  }
  const readIssuedAt: StrictTokenExpReader = (token) => {
    const issuedAt = auth.authService.readTokenPayload(token)?.iat
    return typeof issuedAt === 'number' ? issuedAt : null
  }
  const signInBound = (
    kind: 'web' | 'container',
    input: Omit<StrictDingTalkSignInInput, 'createToken' | 'readExp' | 'readIssuedAt' | 'transaction'>,
  ) => {
    const request = capturedSignInRequest(input)
    const call = kind === 'web' ? signInStrictDingTalkWeb : signInStrictDingTalkContainer
    return call({
      ...request,
      transport: {
        fetchFn: request.transport?.fetchFn ?? options.fetchFn,
        timeoutMs: request.transport?.timeoutMs,
        signal: request.transport?.signal,
      },
      env: request.env ?? options.env,
      transaction: options.transaction,
      createToken,
      readExp,
      readIssuedAt,
    })
  }
  return {
    gates: STRICT_DINGTALK_ENTRY_GATES,
    loginSourceEnv: Object.freeze({
      DINGTALK_CLIENT_ID: (options.env ?? process.env).DINGTALK_CLIENT_ID,
      DINGTALK_APP_KEY: (options.env ?? process.env).DINGTALK_APP_KEY,
      DINGTALK_CORP_ID: (options.env ?? process.env).DINGTALK_CORP_ID,
    }),
    currentStrictGrantUsable,
    signInWeb: (input) => signInBound('web', input),
    signInContainer: (input) => signInBound('container', input),
    verifyPersistedStrictSession,
    refreshStrictSession: (input) => refreshStrictSession({ ...input, createToken, readExp, env: input.env ?? options.env }),
    switchStrictSessionOrg: (input) => switchStrictSessionOrg({ ...input, createToken, readExp, env: input.env ?? options.env }),
  }
}`
const DISPATCH_PREFIXES = ['runAis:adminReads', 'runAis:adminAccounts', 'runStep:adminAccounts', 'runStep:reads', 'runStep:accounts']

function lexicalOwner(node: ts.Node): string {
  const names: string[] = []
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) names.push(current.name.text)
  }
  return names.reverse().join('.')
}

function functionsNamed(root: ts.Node, name: string): ts.FunctionDeclaration[] {
  const found: ts.FunctionDeclaration[] = []
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function parentFunction(node: ts.Node): ts.FunctionDeclaration | undefined {
  for (let current = node.parent; current; current = current.parent) if (ts.isFunctionDeclaration(current)) return current
  return undefined
}

function localsNamed(fn: ts.FunctionDeclaration, name: string): ts.VariableDeclaration[] {
  const found: ts.VariableDeclaration[] = []
  const visit = (node: ts.Node) => {
    if (node !== fn && ts.isFunctionLike(node)) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found.push(node)
    ts.forEachChild(node, visit)
  }
  if (fn.body) visit(fn.body)
  return found
}

function nodeTexts(root: ts.Node, tree: ts.SourceFile): Set<string> {
  const found = new Set<string>()
  const visit = (node: ts.Node) => {
    found.add(compact(node.getText(tree)))
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function oneFunction(tree: ts.SourceFile, name: string, parent: string): ts.FunctionDeclaration | undefined {
  const found = functionsNamed(tree, name)
  if (found.length !== 1) return undefined
  const enclosing = parentFunction(found[0])
  if ((enclosing?.name?.text ?? '') !== parent) return undefined
  return found[0]
}

function entryCalls(file: string, source: string): { tree: ts.SourceFile, calls: Array<{ node: ts.CallExpression, owner: string, counted: boolean }> } {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const calls: Array<{ node: ts.CallExpression, owner: string, counted: boolean }> = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'withAuthorizationInputTransaction') {
      const owner = lexicalOwner(node)
      const port = ENTRY_OPTION_PORTS.find(item => item.file === file && item.owner === owner)
      const helper = port ? enclosingFunctionAt(file, source, node.getStart(tree))?.name ?? '' : ''
      calls.push({ node, owner, counted: !!port && helper === (owner.split('.').pop() ?? '') })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return { tree, calls }
}

function genericOptionProblems(file: string, node: ts.CallExpression, tree: ts.SourceFile): string[] {
  const options = node.arguments[2]
  const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
  if (!options || !ts.isObjectLiteralExpression(options)) return [`${file}:${line}: entry options are not an object literal`]
  const problems: string[] = []
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      problems.push(`${file}:${line}: entry option <spread> is reserved for tests`)
      continue
    }
    if (!property.name || ts.isComputedPropertyName(property.name)) {
      problems.push(`${file}:${line}: entry option <computed> is reserved for tests`)
      continue
    }
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : property.name.getText(tree)
    if (TEST_ONLY_ENTRY_OPTIONS.includes(name)) problems.push(`${file}:${line}: entry option ${name} is reserved for tests`)
  }
  return problems
}

function reviewedShape(file: string, owner: string, node: ts.CallExpression, tree: ts.SourceFile): string[] {
  const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
  const fail = (reason: string) => `${file}:${line}: reviewed transaction port ${reason}`
  const problems: string[] = []
  const [plan, work, options] = node.arguments
  if (node.arguments.length !== 3 || !plan || compact(plan.getText(tree)) !== 'plan.lockPlan') problems.push(fail('plan'))
  if (owner === 'runRoot') {
    const statements = work && ts.isArrowFunction(work) && ts.isBlock(work.body) ? [...work.body.statements] : []
    if (!work || !ts.isArrowFunction(work) || !compact(work.getText(tree)).startsWith('async') || statements.length !== CEREMONY_WORK.length || statements.some((statement, index) => compact(statement.getText(tree)) !== CEREMONY_WORK[index])) problems.push(fail('ceremony work'))
    if (!options || compact(options.getText(tree)) !== CEREMONY_OPTION) problems.push(fail('ceremony transaction option'))
  } else if (owner === 'runOwnedAttempt.runAis') {
    const property = options && ts.isObjectLiteralExpression(options) && options.properties.length === 1 ? options.properties[0] : undefined
    if (!work || !ts.isIdentifier(work) || work.text !== 'work' || !property || !ts.isPropertyAssignment(property) || !property.name || !ts.isIdentifier(property.name) || property.name.text !== 'transaction' || compact(property.initializer.getText(tree)) !== compact(ATTEMPT_ADAPTER)) problems.push(fail('attempt adapter'))
  } else {
    const statements = work && ts.isArrowFunction(work) && ts.isBlock(work.body) ? [...work.body.statements] : []
    const property = options && ts.isObjectLiteralExpression(options) && options.properties.length === 1 ? options.properties[0] : undefined
    if (!work || !ts.isArrowFunction(work) || !compact(work.getText(tree)).startsWith('async') || compact(statements[0]?.getText(tree) ?? '') !== 'await revalidatePrivilegeRolePlan(tx, plan)' || compact(statements[1]?.getText(tree) ?? '') !== 'tx.requireIdentityRead([snapshot.connectionId])') problems.push(fail('runtime work'))
    if (!property || !ts.isPropertyAssignment(property) || !property.name || !ts.isIdentifier(property.name) || property.name.text !== 'transaction' || compact(property.initializer.getText(tree)) !== 'input.transaction') problems.push(fail('runtime transaction option'))
  }
  return problems
}

function statementNamed(tree: ts.SourceFile, name: string): ts.Statement | undefined {
  return tree.statements.find(statement => {
    if (ts.isTypeAliasDeclaration(statement) || ts.isFunctionDeclaration(statement)) return statement.name?.text === name
    if (!ts.isVariableStatement(statement)) return false
    return statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)
  })
}

function bindingNameHas(name: ts.BindingName, text: string): boolean {
  if (ts.isIdentifier(name)) return name.text === text
  for (const element of name.elements) if (ts.isBindingElement(element) && bindingNameHas(element.name, text)) return true
  return false
}

function nodeDeclares(node: ts.Node, text: string): boolean {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === text) return true
  if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && bindingNameHas(node.name, text)) return true
  return !!ts.isCatchClause(node) && !!node.variableDeclaration && bindingNameHas(node.variableDeclaration.name, text)
}

function subtreeDeclares(root: ts.Node, text: string): boolean {
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (nodeDeclares(node, text)) found = true
    else ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function callsNamed(root: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function hasTextOutsideFunctions(root: ts.Node, tree: ts.SourceFile, text: string): boolean {
  let found = false
  const visit = (node: ts.Node) => {
    if (found || ts.isFunctionLike(node)) return
    if (compact(node.getText(tree)) === text) found = true
    else ts.forEachChild(node, visit)
  }
  ts.forEachChild(root, visit)
  return found
}

function dispatchedPrefixes(root: ts.Node, tree: ts.SourceFile): string[] {
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'runAis' || node.expression.text === 'runStep')) {
      const arrow = node.arguments.find(argument => ts.isArrowFunction(argument))
      const body = arrow && ts.isArrowFunction(arrow) && ts.isBlock(arrow.body) ? arrow.body : undefined
      const statements = body?.statements
      const first = statements?.[0]
      const second = statements?.[1]
      const third = statements?.[2]
      const step = statements?.length === 3 && first ? compact(first.getText(tree)) : ''
      const name = step.endsWith(' += 1') ? step.slice(0, -' += 1'.length) : ''
      if (name && second && third && compact(second.getText(tree)) === `if (${name} !== 1) throw new AttemptUnavailable()` && ts.isReturnStatement(third)) found.push(`${node.expression.text}:${name}`)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(root, visit)
  return found
}

function localEntryNodes(tree: ts.SourceFile): Set<ts.Node> {
  const allowed = new Set<ts.Node>()
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== LOCAL_ENTRY_MODULE) continue
    const named = statement.importClause?.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const specifier of named.elements) if (!specifier.isTypeOnly && !specifier.propertyName && specifier.name.text === LOCAL_ENTRY) allowed.add(specifier.name)
  }
  const constructor = oneFunction(tree, 'createLocalStrictDingTalkAuthRouter', '')
  if (constructor) for (const call of callsNamed(constructor, LOCAL_ENTRY)) allowed.add(call.expression)
  return allowed
}

function localConstructorProblems(file: string, tree: ts.SourceFile): string[] {
  const fail = `${file}: local strict constructor`
  const adapter = statementNamed(tree, 'strictDingTalkSessionRunner')
  const constructor = oneFunction(tree, 'createLocalStrictDingTalkAuthRouter', '')
  const statements = constructor?.body?.statements ?? []
  const forwarding = statements[0]
  const returned = statements[1]
  const builds = callsNamed(tree, 'buildAuthRouter')
  const bare = builds.filter(call => call.arguments.length === 0)
  const bound = builds.filter(call => call.arguments.length === 1 && !!call.arguments[0] && ts.isIdentifier(call.arguments[0]) && call.arguments[0].text === 'binding')
  const exported = statementNamed(tree, 'authRouter')
  const initializer = exported && ts.isVariableStatement(exported)
    ? exported.declarationList.declarations.find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'authRouter')?.initializer
    : undefined
  const boundCall = bound[0]
  if (localEntryNodes(tree).size !== 2) return [fail]
  if (!adapter || compact(adapter.getText(tree)) !== compact(LOCAL_ADAPTER)) return [fail]
  if (!constructor || statements.length !== 2 || !forwarding || compact(forwarding.getText(tree)) !== compact(LOCAL_FORWARDING)) return [fail]
  if (!returned || !ts.isReturnStatement(returned) || !boundCall || returned.expression !== boundCall) return [fail]
  if (builds.length !== 2 || bare.length !== 1 || bound.length !== 1 || initializer !== bare[0]) return [fail]
  if (parentFunction(boundCall)?.name?.text !== 'createLocalStrictDingTalkAuthRouter') return [fail]
  return []
}

function ceremonyFileProblems(file: string, tree: ts.SourceFile): string[] {
  const problems: string[] = []
  const runRoot = oneFunction(tree, 'runRoot', '')
  const deps = runRoot?.parameters.find(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === 'deps')
  if (!runRoot || localsNamed(runRoot, 'deps').length !== 0 || !deps?.type || compact(deps.type.getText(tree)) !== 'CurrentAppCeremonyDeps | undefined') problems.push(`${file}: ceremony deps`)
  const depsType = statementNamed(tree, 'CurrentAppCeremonyDeps')
  if (!depsType || compact(depsType.getText(tree)) !== compact(CEREMONY_DEPS)) problems.push(`${file}: ceremony deps type`)
  const assertGate = oneFunction(tree, 'assertGate', '')
  const tried = assertGate?.body?.statements?.find(ts.isTryStatement)
  const asserted = !!tried?.tryBlock.statements.some(statement => compact(statement.getText(tree)) === 'assertAuthenticatedSessionContext(session)')
  if (!asserted) problems.push(`${file}: ceremony session assertion`)
  const binder = statementNamed(tree, 'bindProductionTargetCeremony')
  if (!binder || !ts.isFunctionDeclaration(binder) || binder.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || compact(binder.getText(tree)) !== compact(CEREMONY_BINDER)) problems.push(`${file}: ceremony production binder`)
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'runRoot') calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (calls.length !== 3 || calls.some(call => compact(call.arguments[3]?.getText(tree) ?? '') !== 'deps')) problems.push(`${file}: ceremony deps forwarding`)
  return problems
}

function attemptFileProblems(file: string, tree: ts.SourceFile): string[] {
  const problems: string[] = []
  const owned = oneFunction(tree, 'runOwnedAttempt', '')
  const names = owned?.parameters.map(parameter => ts.isIdentifier(parameter.name) ? parameter.name.text : '') ?? []
  if (!owned || names.join(',') !== 'sessionId,password,steps' || localsNamed(owned, 'owner').length !== 1) problems.push(`${file}: attempt owner`)
  const runAis = oneFunction(tree, 'runAis', 'runOwnedAttempt')
  const runAisStatements = runAis?.body?.statements
  const first = runAisStatements?.[0]
  const tryStatement = runAisStatements?.find(ts.isTryStatement)
  if (!runAis || localsNamed(runAis, 'owner').length !== 0 || !first || compact(first.getText(tree)) !== 'const rawOutcome: { current: RawStepOutcome | null } = { current: null }' || !tryStatement?.catchClause || compact(tryStatement.catchClause.getText(tree)) !== compact(ATTEMPT_CATCH)) problems.push(`${file}: attempt outcome`)
  const performBody = oneFunction(tree, 'perform', 'runOwnedAttempt')?.body
  const prefixes = performBody ? dispatchedPrefixes(performBody, tree) : []
  if (!performBody || !hasTextOutsideFunctions(performBody, tree, "steps.kind !== 'admin_grant_issue'") || prefixes.length !== DISPATCH_PREFIXES.length || DISPATCH_PREFIXES.some(prefix => !prefixes.includes(prefix))) problems.push(`${file}: attempt dispatch`)
  const runStep = oneFunction(tree, 'runStep', 'runOwnedAttempt')
  const stepTexts = runStep ? nodeTexts(runStep, tree) : new Set<string>()
  if (!stepTexts.has("runQuery(owner, 'BEGIN')") || !stepTexts.has("runQuery(owner, 'COMMIT')") || !stepTexts.has('rollback(owner)')) problems.push(`${file}: attempt settle`)
  const compares: ts.Node[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && compact(node.expression.getText(tree)) === 'bcrypt.compare') compares.push(node)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (compares.length !== 1 || parentFunction(compares[0])?.name?.text !== 'invokeCompare' || parentFunction(parentFunction(compares[0]) ?? compares[0])?.name?.text !== 'runOwnedAttempt') problems.push(`${file}: attempt compare`)
  return problems
}

function propertyText(property: ts.ObjectLiteralElementLike): string {
  if (!('name' in property) || !property.name) return ''
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : ''
}

function runtimeFileProblems(file: string, tree: ts.SourceFile): string[] {
  const problems: string[] = []
  const issueOnRoot = oneFunction(tree, 'issueOnRoot', '')
  const signIn = oneFunction(tree, 'signIn', '')
  if (!issueOnRoot || localsNamed(issueOnRoot, 'input').length !== 0) problems.push(`${file}: runtime input`)
  const runners = signIn ? localsNamed(signIn, 'runner') : []
  const runner = runners[0]
  const awaits: number[] = []
  const visitAwait = (node: ts.Node) => {
    if (ts.isAwaitExpression(node)) awaits.push(node.getStart(tree))
    ts.forEachChild(node, visitAwait)
  }
  if (signIn?.body) visitAwait(signIn.body)
  const firstAwait = awaits.reduce((left, right) => Math.min(left, right), Number.POSITIVE_INFINITY)
  const constRunner = !!runner && ts.isVariableDeclarationList(runner.parent) && (runner.parent.flags & ts.NodeFlags.Const) !== 0
  if (!signIn || localsNamed(signIn, 'input').length !== 0 || runners.length !== 1 || !runner?.initializer || !constRunner || compact(runner.initializer.getText(tree)) !== 'runnerOf(input.transaction)' || !Number.isFinite(firstAwait) || runner.getStart(tree) > firstAwait) problems.push(`${file}: runtime capture`)
  const handoffs: ts.CallExpression[] = []
  const visitHandoff = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'issueOnRoot') handoffs.push(node)
    ts.forEachChild(node, visitHandoff)
  }
  visitHandoff(tree)
  if (handoffs.length !== 1 || parentFunction(handoffs[0])?.name?.text !== 'signIn' || compact(handoffs[0].arguments[0]?.getText(tree) ?? '') !== '{ ...input, transaction: runner }') problems.push(`${file}: runtime handoff`)
  const runnerOf = statementNamed(tree, 'runnerOf')
  if (!runnerOf || compact(runnerOf.getText(tree)) !== compact(RUNTIME_RUNNER)) problems.push(`${file}: runtime runner`)
  const gates = statementNamed(tree, 'STRICT_DINGTALK_ENTRY_GATES')
  if (!gates || compact(gates.getText(tree)) !== compact(RUNTIME_GATES)) problems.push(`${file}: runtime gates`)
  const bind = oneFunction(tree, 'bindStrictDingTalkEntryLocal', '')
  if (!bind || compact(bind.getText(tree)) !== compact(LOCAL_FACTORY)) problems.push(`${file}: runtime factory`)
  const bindStatements = bind?.body?.statements
  const returned = bindStatements ? [...bindStatements].reverse().find(ts.isReturnStatement) : undefined
  const gatesProperty = returned?.expression && ts.isObjectLiteralExpression(returned.expression) ? returned.expression.properties.find(property => propertyText(property) === 'gates') : undefined
  if (!gatesProperty || !ts.isPropertyAssignment(gatesProperty) || compact(gatesProperty.initializer.getText(tree)) !== 'STRICT_DINGTALK_ENTRY_GATES') problems.push(`${file}: runtime gate binding`)
  const called: string[] = []
  const visitCall = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      called.push(ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '')
    }
    ts.forEachChild(node, visitCall)
  }
  if (issueOnRoot?.body) visitCall(issueOnRoot.body)
  if (PROVIDER_CALLS.some(name => called.includes(name))) problems.push(`${file}: runtime provider`)
  return problems
}

function entryBindingProblems(file: string, tree: ts.SourceFile): string[] {
  let valueImports = 0
  for (const statement of tree.statements) {
    if (nodeDeclares(statement, ENTRY_BINDING)) return [`${file}: entry binding`]
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => bindingNameHas(declaration.name, ENTRY_BINDING))) return [`${file}: entry binding`]
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== ENTRY_MODULE) continue
    const named = statement.importClause?.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const specifier of named.elements) {
      if (specifier.isTypeOnly || specifier.propertyName) continue
      if (specifier.name.text === ENTRY_BINDING) valueImports += 1
    }
  }
  if (valueImports !== 1) return [`${file}: entry binding`]
  for (const name of ['runRoot', 'runAis', 'issueOnRoot']) {
    if (functionsNamed(tree, name).some(fn => subtreeDeclares(fn, ENTRY_BINDING))) return [`${file}: entry binding`]
  }
  return []
}

function portFileProblems(file: string, source: string): string[] {
  const port = ENTRY_OPTION_PORTS.find(item => item.file === file)
  if (!port) return []
  const { tree, calls } = entryCalls(file, source)
  const count = calls.filter(call => call.counted).length
  const problems: string[] = []
  if (count !== 1) problems.push(`${file}|${port.owner}|withAuthorizationInputTransaction: expected one reviewed entry, found ${count}`)
  problems.push(...entryBindingProblems(file, tree))
  if (port.owner === 'runRoot') problems.push(...ceremonyFileProblems(file, tree))
  else if (port.owner === 'runOwnedAttempt.runAis') problems.push(...attemptFileProblems(file, tree))
  else problems.push(...runtimeFileProblems(file, tree))
  return problems
}

function mountedCallerProblems(files: readonly string[], sourceOf: (file: string) => string): string[] {
  const problems: string[] = []
  const names = [...CEREMONY_MOUNTS, ...RUNTIME_MOUNTS]
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue
    const source = sourceOf(file)
    if (!names.some(name => source.includes(name))) continue
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const allowed = file === AUTH_ROUTER_FILE ? localEntryNodes(tree) : new Set<ts.Node>()
    if (file === AUTH_ROUTER_FILE) problems.push(...localConstructorProblems(file, tree))
    const visit = (node: ts.Node) => {
      const text = ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : ''
      if (text && CEREMONY_MOUNTS.includes(text) && file !== ENTRY_OPTION_PORTS[0].file) problems.push(`${file}: mounted ceremony caller ${text}`)
      if (text && RUNTIME_MOUNTS.includes(text) && file !== ENTRY_OPTION_PORTS[2].file && !(text === LOCAL_ENTRY && allowed.has(node))) problems.push(`${file}: mounted strict sign-in ${text}`)
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  return problems
}

function entryOptionProblems(file: string, source: string): string[] {
  const problems: string[] = []
  const { tree, calls } = entryCalls(file, source)
  for (const call of calls) {
    if (call.counted) problems.push(...reviewedShape(file, call.owner, call.node, tree))
    else if (call.node.arguments.length > 2) problems.push(...genericOptionProblems(file, call.node, tree))
  }
  return problems
}

function productionEntryProblems(files: readonly string[], sourceOf: (file: string) => string): string[] {
  const problems: string[] = []
  const ports = new Set<string>(ENTRY_OPTION_PORTS.map(port => port.file))
  const checked = new Set<string>()
  for (const file of files) {
    if (!file.endsWith('.ts') || file === LOCK_MODULE) continue
    const source = sourceOf(file)
    if (!ports.has(file) && !source.includes('AuthorizationInputTransaction')) continue
    checked.add(file)
    problems.push(...workClosureProblems(file, source), ...entryOptionProblems(file, source))
  }
  for (const port of ENTRY_OPTION_PORTS) {
    if (!checked.has(port.file)) {
      const source = sourceOf(port.file)
      problems.push(...workClosureProblems(port.file, source), ...entryOptionProblems(port.file, source))
    }
    problems.push(...portFileProblems(port.file, sourceOf(port.file)))
  }
  problems.push(...mountedCallerProblems(files, sourceOf))
  return problems
}

describe('work closures make no external call, and production callers pass no test-only entry option', () => {
  it('no production work closure references a forbidden identifier; no production caller supplies a transaction runner or a post-acquire hook', () => {
    expect(productionEntryProblems(productionFiles, read)).toEqual([])
  })

  it('the forbidden pull-source names are the ones the organisation lock module exports, and every function the write gate exports is forbidden', () => {
    expect(FORBIDDEN_IN_WORK).toHaveLength(14)
    const rule = read(PULL_SOURCE_RULE_MODULE)
    for (const name of FORBIDDEN_PULL_SOURCE_LOCK) expect(new RegExp(`export (?:const|function) ${name}\\b`).test(rule), name).toBe(true)
    // Every exported name of the lock module that spells the organisation lock is on the list.
    const lockExports = [...rule.matchAll(/export (?:const|function) ([A-Za-z_0-9]*(?:OrgLock|ORG_LOCK)[A-Za-z_0-9]*)/g)].map((match) => match[1]).sort()
    expect(lockExports).toEqual([...FORBIDDEN_PULL_SOURCE_LOCK].sort())
    // The gate module exists, and the functions it exports are exactly the ones on the list: a function
    // added to it, or one of these renamed, fails here until the list follows.
    expect(fs.existsSync(path.join(REPO_ROOT, PULL_SOURCE_GATE_MODULE))).toBe(true)
    expect(exportedFunctionNames(read(PULL_SOURCE_GATE_MODULE)).sort()).toEqual([...FORBIDDEN_PULL_SOURCE_GATE].sort())
    expect(exportedFunctionNames('export async function runA() {}\nexport const runB = async () => 1\nfunction hidden() {}\nexport const VALUE = 1')).toEqual(['runA', 'runB'])
  })

  it('POSITIVE CONTROL — a closure that takes the pull-source organisation lock or enters its write gate is a problem', () => {
    for (const name of FORBIDDEN_PULL_SOURCE_LOCK) {
      expect(workClosureProblems('x.ts', `withAuthorizationInputTransaction(plan, async (tx) => { await tx.query(${name}('$1'), [org]) })`), name).toEqual([`x.ts: work closure references ${name}`])
    }
    for (const name of FORBIDDEN_PULL_SOURCE_GATE) {
      expect(workClosureProblems('x.ts', `enterAuthorizationInputTransaction(c, plan, [], async (tx) => { await gate.${name}(input) })`), name).toEqual([`x.ts: work closure references ${name}`])
    }
    expect(workClosureProblems('x.ts', "withAuthorizationInputTransaction(plan, async (tx) => tx.query('SELECT 1 FROM directory_integrations'))")).toEqual([])
  })

  it('POSITIVE CONTROL — a closure that calls fetch or setTimeout is a problem', () => {
    expect(workClosureProblems('x.ts', "withAuthorizationInputTransaction(plan, async (tx) => { await fetch(url); return 1 })")).toHaveLength(1)
    expect(workClosureProblems('x.ts', "enterAuthorizationInputTransaction(c, plan, [], async (tx) => { await new Promise((r) => setTimeout(r, 10)) })")).toHaveLength(1)
    expect(workClosureProblems('x.ts', "withAuthorizationInputTransaction(plan, async (tx) => tx.query('SELECT 1'))")).toEqual([])
  })

  it('POSITIVE CONTROL — a transaction runner, a post-acquire hook, a spread or a non-literal options argument is a problem; a budget is not', () => {
    expect(entryOptionProblems('x.ts', 'withAuthorizationInputTransaction(plan, work, { transaction: runner })')).toHaveLength(1)
    expect(entryOptionProblems('x.ts', 'withAuthorizationInputTransaction(plan, work, { afterAcquire: hook })')).toHaveLength(1)
    expect(entryOptionProblems('x.ts', 'withAuthorizationInputTransaction(plan, work, { ...options })')).toHaveLength(1)
    expect(entryOptionProblems('x.ts', 'withAuthorizationInputTransaction(plan, work, options)')).toHaveLength(1)
    expect(entryOptionProblems('x.ts', 'withAuthorizationInputTransaction(plan, work, { exclusive: { attempts: 3 } })')).toEqual([])
    expect(entryOptionProblems('x.ts', 'withAuthorizationInputTransaction(plan, work)')).toEqual([])
  })

  it('POSITIVE CONTROL — quoted and computed reserved entry options stay rejected', () => {
    expect(entryOptionProblems('x.ts', "withAuthorizationInputTransaction(plan, work, { 'transaction': runner })")).toEqual(['x.ts:1: entry option transaction is reserved for tests'])
    expect(entryOptionProblems('x.ts', "withAuthorizationInputTransaction(plan, work, { 'afterAcquire': hook })")).toEqual(['x.ts:1: entry option afterAcquire is reserved for tests'])
    expect(entryOptionProblems('x.ts', "withAuthorizationInputTransaction(plan, work, { ['transaction']: runner })")).toEqual(['x.ts:1: entry option <computed> is reserved for tests'])
    expect(entryOptionProblems('x.ts', "withAuthorizationInputTransaction(plan, work, { ['exclusive']: true })")).toEqual(['x.ts:1: entry option <computed> is reserved for tests'])
    expect(entryOptionProblems('x.ts', "withAuthorizationInputTransaction(plan, work, { 'exclusive': true })")).toEqual([])
  })

  it('POSITIVE CONTROL — the three reviewed ports reject a missing, duplicate, relocated, or altered runner', () => {
    expect(ENTRY_OPTION_PORTS.map(port => `${port.file}|${port.owner}|withAuthorizationInputTransaction`)).toEqual([
      `${SRC}/auth/admin-grant-target-ceremony.ts|runRoot|withAuthorizationInputTransaction`,
      `${SRC}/auth/security-action-attempt-admission.ts|runOwnedAttempt.runAis|withAuthorizationInputTransaction`,
      `${SRC}/auth/strict-dingtalk-entry.ts|issueOnRoot|withAuthorizationInputTransaction`,
    ])
    const ceremony = ENTRY_OPTION_PORTS[0].file
    const attempt = ENTRY_OPTION_PORTS[1].file
    const runtime = ENTRY_OPTION_PORTS[2].file
    const command = `${SRC}/auth/admin-login-grant-command.ts`
    const auth = `${SRC}/routes/auth.ts`
    const files = [ceremony, attempt, runtime, command, auth]
    const problemsOf = (overrides: Record<string, string> = {}) => productionEntryProblems(files, file => overrides[file] ?? read(file))
    expect(problemsOf()).toEqual([])
    const authSource = read(auth)
    expect(authSource.split('export const authRouter = buildAuthRouter()').length).toBe(2)
    expect(problemsOf({ [auth]: authSource.replace('export const authRouter = buildAuthRouter()', 'export const authRouter = buildAuthRouter(binding)') })).not.toEqual([])
    expect(authSource.split('fetchFn: input.fetchFn,').length).toBe(2)
    expect(problemsOf({ [auth]: authSource.replace('fetchFn: input.fetchFn,', 'fetchFn: fetch,') })).not.toEqual([])
    expect(authSource.split('__rawClient: held.__rawClient,').length).toBe(2)
    expect(problemsOf({ [auth]: authSource.replace('__rawClient: held.__rawClient,', '__rawClient: client,') })).not.toEqual([])
    expect(problemsOf({ [auth]: `${authSource}\nvoid bindStrictDingTalkEntryLocal\n` })).not.toEqual([])
    const otherCaller = `${SRC}/routes/other-strict-entry.ts`
    expect(productionEntryProblems([...files, otherCaller], file => file === otherCaller ? 'export const mounted = bindStrictDingTalkEntryLocal\n' : read(file))).not.toEqual([])
    const spacedCeremony = read(ceremony).replace('return await withAuthorizationInputTransaction(', 'return await withAuthorizationInputTransaction (')
    expect(spacedCeremony).not.toBe(read(ceremony))
    expect(problemsOf({ [ceremony]: spacedCeremony })).toEqual([])
    expect(problemsOf({ [ceremony]: read(ceremony).replace('return await withAuthorizationInputTransaction(', 'return await withAuthorizationInputTransaction /* reviewed */ (') })).toEqual([])
    expect(problemsOf({ [ceremony]: spacedCeremony.replace('      await revalidatePrivilegeRolePlan(tx, plan)\n', '') })).not.toEqual([])
    expect(problemsOf({ [ceremony]: spacedCeremony.replace(CEREMONY_OPTION, 'body?.transaction ? { transaction: body.transaction } : undefined') })).not.toEqual([])
    const spacedGeneric = `${SRC}/auth/spaced-generic-entry.ts`
    expect(productionEntryProblems([...files, spacedGeneric], file => file === spacedGeneric ? 'export function otherRoot(plan: { lockPlan: unknown }, work: unknown) {\n  return withAuthorizationInputTransaction (plan.lockPlan, work, { transaction: runner })\n}\n' : read(file))).not.toEqual([])
    const reject = (file: string, needle: string, replacement: string) => {
      const source = read(file)
      expect(source.split(needle).length, needle).toBe(2)
      const changed = source.replace(needle, replacement)
      expect(changed, needle).not.toBe(source)
      expect(problemsOf(), needle).toEqual([])
      expect(problemsOf({ [file]: changed }), needle).not.toEqual([])
    }
    const census = (file: string, owner: string, count: number) => `${file}|${owner}|withAuthorizationInputTransaction: expected one reviewed entry, found ${count}`
    const removedCeremony = read(ceremony).replace('return await withAuthorizationInputTransaction(', 'return await notAnEntry(')
    expect(/AuthorizationInputTransaction\(/.test(removedCeremony)).toBe(false)
    expect(entryOptionProblems(ceremony, removedCeremony)).toEqual([])
    expect(workClosureProblems(ceremony, removedCeremony)).toEqual([])
    expect(problemsOf({ [ceremony]: removedCeremony })).toContain(census(ceremony, 'runRoot', 0))
    const ceremonyCall = `    return await withAuthorizationInputTransaction(plan.lockPlan, async (tx) => {
      assertGate(session)
      await revalidatePrivilegeRolePlan(tx, plan)
      tx.requireIdentityRead([connectionId])
      return work(tx)
    }, deps?.transaction ? { transaction: deps.transaction } : undefined)`
    expect(read(ceremony).split(ceremonyCall).length).toBe(2)
    expect(problemsOf({ [ceremony]: read(ceremony).replace(ceremonyCall, `${ceremonyCall}\n${ceremonyCall}`) })).toContain(census(ceremony, 'runRoot', 2))
    reject(ceremony, 'async function runRoot', 'async function runRootMoved')
    reject(ceremony, CEREMONY_OPTION, 'deps?.transaction ? { transaction: deps.transaction } : deps')
    reject(ceremony, CEREMONY_OPTION, 'body?.transaction ? { transaction: body.transaction } : undefined')
    reject(ceremony, CEREMONY_OPTION, 'deps?.transaction ? { transaction: pool.transaction } : undefined')
    reject(ceremony, '{ transaction: deps.transaction }', '{ transaction: deps.transaction, afterAcquire: hook }')
    reject(ceremony, '{ transaction: deps.transaction }', '{ transaction: deps.transaction, exclusive: true }')
    reject(ceremony, '{ transaction: deps.transaction }', '{ ...deps, transaction: deps.transaction }')
    reject(ceremony, '{ transaction: deps.transaction }', "{ ['transaction']: deps.transaction }")
    reject(ceremony, '{ transaction: deps.transaction }', "{ 'transaction': deps.transaction }")
    reject(ceremony, '{ transaction: deps.transaction }', '{ transaction: runner }')
    reject(ceremony, '      assertGate(session)\n', '')
    reject(ceremony, '      await revalidatePrivilegeRolePlan(tx, plan)\n', '      revalidatePrivilegeRolePlan(tx, plan)\n')
    reject(ceremony, '      tx.requireIdentityRead([connectionId])\n', '')
    reject(ceremony, 'function assertGate(session: unknown): asserts session is AuthenticatedSessionContext {\n  try {\n    assertAuthenticatedSessionContext(session)\n', 'function assertGate(session: unknown): asserts session is AuthenticatedSessionContext {\n  try {\n    session\n')
    reject(ceremony, 'function assertGate(session: unknown): asserts session is AuthenticatedSessionContext {\n  try {\n    assertAuthenticatedSessionContext(session)\n', 'function assertGate(session: unknown): asserts session is AuthenticatedSessionContext {\n  try {\n    const unused = () => assertAuthenticatedSessionContext(session)\n')
    reject(ceremony, '  transaction?: AuthorizationInputTransactionRunner\n', '  transaction?: AuthorizationInputTransactionRunner\n  clock?: () => number\n')
    reject(ceremony, "return { success: false, code: 'production_unavailable' }", "return { success: true, code: 'production_unavailable' }")
    reject(ceremony, '  withAuthorizationInputTransaction,\n', '  withAuthorizationInputTransaction as entry,\n')
    reject(ceremony, '  withAuthorizationInputTransaction,\n', '  type withAuthorizationInputTransaction,\n')
    reject(ceremony, '      assertGate(session)\n', '      assertGate(session)\n      await fetch(url)\n')
    const fetchedCeremony = read(ceremony).replace('      assertGate(session)\n', '      assertGate(session)\n      await fetch(url)\n')
    expect(workClosureProblems(ceremony, fetchedCeremony)).toContain(`${ceremony}: work closure references fetch`)
    expect(entryOptionProblems(ceremony, fetchedCeremony).some(problem => problem.includes('ceremony work'))).toBe(true)
    const pooled = read(ceremony).replace(CEREMONY_OPTION, 'deps?.transaction ? { transaction: pool.transaction } : undefined')
    expect(workClosureProblems(ceremony, pooled)).toEqual([])
    expect(entryOptionProblems(ceremony, pooled).some(problem => problem.includes('ceremony transaction option'))).toBe(true)
    const otherFunction = `${read(ceremony)}\nasync function otherRoot(plan: { lockPlan: unknown }, work: unknown) {\n  return withAuthorizationInputTransaction(plan.lockPlan, work, { transaction: runner })\n}\n`
    expect(otherFunction).not.toBe(read(ceremony))
    expect(problemsOf({ [ceremony]: otherFunction })).not.toEqual([])
    const shadowed = `${read(ceremony)}\nfunction withAuthorizationInputTransaction() { return null }\n`
    expect(problemsOf({ [ceremony]: shadowed })).toContain(`${ceremony}: entry binding`)
    const nestedShadow = read(ceremony).replace('  try {\n    return await withAuthorizationInputTransaction(', '  try {\n    const { withAuthorizationInputTransaction } = { withAuthorizationInputTransaction: runner }\n    return await withAuthorizationInputTransaction(')
    expect(nestedShadow.split('const { withAuthorizationInputTransaction }').length).toBe(2)
    expect(problemsOf({ [ceremony]: nestedShadow })).toContain(`${ceremony}: entry binding`)
    const clone = `${SRC}/auth/cloned-transaction-port.ts`
    expect(productionEntryProblems([...files, clone], file => file === clone ? 'export function otherRoot(plan: { lockPlan: unknown }, work: unknown) {\n  return withAuthorizationInputTransaction(plan.lockPlan, work, { transaction: runner })\n}\n' : read(file))).not.toEqual([])
    const removedAttempt = read(attempt).replace('await withAuthorizationInputTransaction(plan.lockPlan, work, {', 'await notAnEntry(plan.lockPlan, work, {')
    expect(/AuthorizationInputTransaction\(/.test(removedAttempt)).toBe(false)
    expect(entryOptionProblems(attempt, removedAttempt)).toEqual([])
    expect(problemsOf({ [attempt]: removedAttempt })).toContain(census(attempt, 'runOwnedAttempt.runAis', 0))
    const attemptTwice = read(attempt).replace('    const rawOutcome: { current: RawStepOutcome | null } = { current: null }\n', '    const rawOutcome: { current: RawStepOutcome | null } = { current: null }\n    void withAuthorizationInputTransaction(plan.lockPlan, work, { transaction: runner })\n')
    expect(attemptTwice).not.toBe(read(attempt))
    expect(problemsOf({ [attempt]: attemptTwice })).toContain(census(attempt, 'runOwnedAttempt.runAis', 2))
    reject(attempt, 'export async function runOwnedAttempt', 'export async function runOwnedAttemptMoved')
    reject(attempt, '(sql, params) => tx.query(sql, params)', '(sql, params) => pool.query(sql, params)')
    reject(attempt, '__rawClient: current.client', '__rawClient: owner.client')
    reject(attempt, '          const result = await runStep((tx) => handler({\n            query: (sql, params) => tx.query(sql, params),\n            __rawClient: current.client,\n          }))', '          const result = await handler({\n            query: (sql, params) => tx.query(sql, params),\n            __rawClient: current.client,\n          })')
    reject(attempt, 'rollbackAcked: result.rollbackAcked', 'released: true')
    reject(attempt, 'if (recorded !== null && recorded.ok === true) return { ok: false, error, rollbackAcked: false }', 'if (recorded !== null && recorded.ok === true) return { ok: true, error, rollbackAcked: false }')
    reject(attempt, 'async <U>(handler:', 'async (handler:')
    reject(attempt, 'throw result.error', 'handler(null as never)\n          throw result.error')
    reject(attempt, 'if (adminReads !== 1) throw new AttemptUnavailable()', 'if (adminReads !== 1) {}')
    reject(attempt, `        const adminFirst = await runAis(adminSteps.privilegePlan, async (tx) => {
          adminReads += 1
          if (adminReads !== 1) throw new AttemptUnavailable()
          return adminSteps.readInputs(tx)
        })`, `        const adminFirst = await runAis(adminSteps.privilegePlan, async (tx) => {
          void adminSteps
          adminReads += 1
          if (adminReads !== 1) throw new AttemptUnavailable()
          return adminSteps.readInputs(tx)
        })`)
    reject(attempt, `        const adminFirst = await runAis(adminSteps.privilegePlan, async (tx) => {
          adminReads += 1
          if (adminReads !== 1) throw new AttemptUnavailable()
          return adminSteps.readInputs(tx)
        })`, `        const unused = async () => runAis(adminSteps.privilegePlan, async (tx) => {
          adminReads += 1
          if (adminReads !== 1) throw new AttemptUnavailable()
          return adminSteps.readInputs(tx)
        })
        void unused
        const adminFirst = await runAis(adminSteps.privilegePlan, async (tx) => {
          return adminSteps.readInputs(tx)
        })`)
    reject(attempt, 'steps: OwnedAttemptSteps<Snapshot, Outcome> | AdminGrantOwnedSteps<Snapshot, Outcome>,', 'steps: OwnedAttemptSteps<Snapshot, Outcome> | AdminGrantOwnedSteps<Snapshot, Outcome>,\n  runner?: unknown,')
    const topLevelAis = `${read(attempt)}\nasync function runAis() { return 0 }\n`
    expect(topLevelAis).not.toBe(read(attempt))
    expect(problemsOf({ [attempt]: topLevelAis })).not.toEqual([])
    const removedRuntime = read(runtime).replace('await withAuthorizationInputTransaction(plan.lockPlan, async (tx) => {', 'await notAnEntry(plan.lockPlan, async (tx) => {')
    expect(/AuthorizationInputTransaction\(/.test(removedRuntime)).toBe(false)
    expect(entryOptionProblems(runtime, removedRuntime)).toEqual([])
    expect(problemsOf({ [runtime]: removedRuntime })).toContain(census(runtime, 'issueOnRoot', 0))
    const runtimeTwice = read(runtime).replace('  const issued = await withAuthorizationInputTransaction', '  void withAuthorizationInputTransaction(plan.lockPlan, async (tx) => tx, { transaction: input.transaction })\n  const issued = await withAuthorizationInputTransaction')
    expect(runtimeTwice).not.toBe(read(runtime))
    expect(problemsOf({ [runtime]: runtimeTwice })).toContain(census(runtime, 'issueOnRoot', 2))
    reject(runtime, 'async function issueOnRoot', 'async function issueOnRootMoved')
    reject(runtime, '{ ...input, transaction: runner }', '{ transaction: input.transaction }')
    reject(runtime, '    __rawClient: client.__rawClient,\n', '')
    reject(runtime, '    return call({\n      ...request,\n', '    return call({\n      transaction: options.transaction,\n      createToken,\n      readExp,\n      readIssuedAt,\n      ...request,\n')
    reject(runtime, `    return call({
      ...request,
      transport: {
        fetchFn: request.transport?.fetchFn ?? options.fetchFn,
        timeoutMs: request.transport?.timeoutMs,
        signal: request.transport?.signal,
      },
      env: request.env ?? options.env,
      transaction: options.transaction,
      createToken,
      readExp,
      readIssuedAt,
    })`, `    const unused = {
      ...request,
      transaction: options.transaction,
      createToken,
      readExp,
      readIssuedAt,
    }
    return call({
      ...request,
      transport: {
        fetchFn: request.transport?.fetchFn ?? options.fetchFn,
        timeoutMs: request.transport?.timeoutMs,
        signal: request.transport?.signal,
      },
      env: request.env ?? options.env,
    })`)
    reject(runtime, `    return call({
      ...request,
      transport: {
        fetchFn: request.transport?.fetchFn ?? options.fetchFn,
        timeoutMs: request.transport?.timeoutMs,
        signal: request.transport?.signal,
      },
      env: request.env ?? options.env,
      transaction: options.transaction,
      createToken,
      readExp,
      readIssuedAt,
    })`, `    const unused = () => {
      return call({
        ...request,
        transport: {
          fetchFn: request.transport?.fetchFn ?? options.fetchFn,
          timeoutMs: request.transport?.timeoutMs,
          signal: request.transport?.signal,
        },
        env: request.env ?? options.env,
        transaction: options.transaction,
        createToken,
        readExp,
        readIssuedAt,
      })
    }
    void unused
    return request`)
    reject(runtime, '(user, tokenOptions) => auth.authService.createToken(user, tokenOptions)', '(user, tokenOptions) => auth.authService.readTokenPayload(user)')
    reject(runtime, 'refreshStrictSession({ ...input, createToken, readExp, env: input.env ?? options.env })', 'refreshStrictSession({ createToken, readExp, ...input, env: input.env ?? options.env })')
    reject(runtime, 'switchStrictSessionOrg({ ...input, createToken, readExp, env: input.env ?? options.env })', 'switchStrictSessionOrg({ createToken, readExp, ...input, env: input.env ?? options.env })')
    const runtimeFetch = read(runtime).replace('    tx.requireIdentityRead([snapshot.connectionId])\n', '    tx.requireIdentityRead([snapshot.connectionId])\n    await fetch(url)\n')
    expect(runtimeFetch).not.toBe(read(runtime))
    expect(entryOptionProblems(runtime, runtimeFetch)).toEqual([])
    expect(workClosureProblems(runtime, runtimeFetch)).toEqual([`${runtime}: work closure references fetch`])
    expect(problemsOf({ [runtime]: runtimeFetch })).not.toEqual([])
    reject(command, '    return work(tx, plan)\n  })', '    return work(tx, plan)\n  }, { transaction: runner })')
    reject(command, '      await insertCommandAudit(tx, inserted)\n      committedWork = true\n      return inserted\n    })', '      await insertCommandAudit(tx, inserted)\n      committedWork = true\n      return inserted\n    }, { transaction: runner })')
  })
})

const ATTENDANCE_COMMAND = `${SRC}/admin/attendance-role-commands.ts`
const ATTENDANCE_ROUTE = `${SRC}/routes/attendance-admin.ts`
const ATTENDANCE_SPEC = '../admin/attendance-role-commands'
const ASSIGN = 'assignAttendanceGlobalRolesCommand'
const UNASSIGN = 'unassignAttendanceGlobalRolesCommand'
const PLAN_KEYS = ['admissionUserIds', 'intent', 'roleIds', 'userIds', 'witness']
const INPUT_KEYS = ['actorId', 'includeProfile', 'legacyAdminClaim', 'roleId', 'userIds']
const EXPECTED_CALLS = [
  `${ASSIGN}|getAttendanceAdminRequestUserId(req)|userIds|finalRoleId|hasLegacyAdminClaim(req)|false`,
  `${UNASSIGN}|getAttendanceAdminRequestUserId(req)|userIds|finalRoleId|hasLegacyAdminClaim(req)|false`,
  `${ASSIGN}|getAttendanceAdminRequestUserId(req)|[userId]|finalRoleId|hasLegacyAdminClaim(req)|true`,
  `${UNASSIGN}|getAttendanceAdminRequestUserId(req)|[userId]|finalRoleId|hasLegacyAdminClaim(req)|true`,
]
const FORBIDDEN = ['requireRoleRows', 'lockRoleRowForShare', 'enterAuthorizationInputTransaction', 'MAINTENANCE', 'poolManager', 'pool.transaction']

function ownerName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
  return ''
}

function fieldsOf(object: ts.ObjectLiteralExpression, file: ts.SourceFile): Map<string, string> | undefined {
  const fields = new Map<string, string>()
  for (const property of object.properties) {
    if (ts.isShorthandPropertyAssignment(property)) fields.set(property.name.text, property.name.text)
    else if (ts.isPropertyAssignment(property) && property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) fields.set(property.name.getText(file).replace(/['"]/g, ''), compact(property.initializer.getText(file)))
    else return undefined
  }
  return fields.size === object.properties.length ? fields : undefined
}

function stringArray(expression: ts.Expression | undefined): string[] | undefined {
  const array = expression && ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'freeze' ? expression.arguments[0] : expression
  if (!array || !ts.isArrayLiteralExpression(array) || array.elements.some(element => !ts.isStringLiteral(element))) return undefined
  return array.elements.map(element => (element as ts.StringLiteral).text)
}

function dynamicCommandLoads(file: string, source: string): string[] {
  if (!source.includes('attendance-role-commands')) return []
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const problems: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const argument = node.arguments[0]
      const literal = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) ? argument.text : ''
      if (literal.includes('attendance-role-commands')) problems.push('attendance command dynamic load')
      else if (!literal && node.getText(tree).includes('attendance-role-commands')) problems.push('attendance command computed loader')
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return problems
}

function routeCallProblems(source: string): string[] {
  const problems: string[] = []
  const tree = ts.createSourceFile(ATTENDANCE_ROUTE, source, ts.ScriptTarget.Latest, true)
  const signatures: string[] = []
  let imports = 0
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === ATTENDANCE_SPEC) {
      imports += 1
      const named = node.importClause?.namedBindings
      const namedImports = named && ts.isNamedImports(named) ? named : undefined
      const imported = namedImports ? namedImports.elements.map(element => `${element.propertyName ? 'alias' : ''}${element.name.text}${element.isTypeOnly ? ':type' : ''}`) : []
      if (node.importClause?.isTypeOnly || node.importClause?.name || !namedImports || JSON.stringify(imported) !== JSON.stringify([ASSIGN, UNASSIGN])) problems.push('attendance command import shape')
    }
    if (ts.isIdentifier(node) && (node.text === ASSIGN || node.text === UNASSIGN)) {
      const parent = node.parent
      const ok = (ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName) || (ts.isCallExpression(parent) && parent.expression === node) || (ts.isFunctionDeclaration(parent) && parent.name === node)
      if (!ok) problems.push('attendance command alias')
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === ASSIGN || node.expression.text === UNASSIGN)) {
      const owner = enclosingFunctionAt(ATTENDANCE_ROUTE, source, node.getStart(tree))
      let body: ts.Node | undefined = node
      while (body && !ts.isFunctionLike(body)) body = body.parent
      let preflight = false
      const seek = (child: ts.Node) => {
        if (child !== body && ts.isFunctionLike(child)) return
        if (ts.isCallExpression(child) && child.getStart(tree) < node.getStart(tree) && ts.isIdentifier(child.expression) && child.expression.text === 'preflightAttendanceGlobalRoleWrite' && ts.isAwaitExpression(child.parent)) preflight = true
        ts.forEachChild(child, seek)
      }
      if (body) seek(body)
      if (owner?.name !== 'callback:r.post' || !preflight) problems.push('attendance command preflight order')
      const argument = node.arguments[0]
      const fields = node.arguments.length === 1 && argument && ts.isObjectLiteralExpression(argument) ? fieldsOf(argument, tree) : undefined
      if (!fields || [...fields.keys()].sort().join() !== INPUT_KEYS.join()) problems.push('attendance command call shape')
      else signatures.push(`${node.expression.text}|${fields.get('actorId')}|${fields.get('userIds')}|${fields.get('roleId')}|${fields.get('legacyAdminClaim')}|${fields.get('includeProfile')}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (imports !== 1) problems.push('attendance command import shape')
  if (JSON.stringify(signatures.sort()) !== JSON.stringify([...EXPECTED_CALLS].sort())) problems.push('attendance command call shape')
  return problems
}

function catalogRoleIds(source: string): string[] {
  const tree = ts.createSourceFile(ATTENDANCE_ROUTE, source, ts.ScriptTarget.Latest, true)
  const ids: string[] = []
  const visit = (node: ts.Node) => {
    const init = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'ATTENDANCE_ROLE_TEMPLATES' ? node.initializer : undefined
    if (init && ts.isObjectLiteralExpression(init)) for (const entry of init.properties) if (ts.isPropertyAssignment(entry) && ts.isObjectLiteralExpression(entry.initializer)) for (const field of entry.initializer.properties) if (ts.isPropertyAssignment(field) && ts.isIdentifier(field.name) && field.name.text === 'roleId' && ts.isStringLiteral(field.initializer)) ids.push(field.initializer.text)
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return ids
}

function producerProblems(command: string, route: string): string[] {
  const problems: string[] = []
  const tree = ts.createSourceFile(ATTENDANCE_COMMAND, command, ts.ScriptTarget.Latest, true)
  const exported: string[] = []
  let templates: string[] | undefined
  const counts = { transactions: 0, assignWrites: 0, unassignWrites: 0, scopeCalls: 0, plans: 0 }
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'ATTENDANCE_TEMPLATE_ROLE_IDS') templates = stringArray(node.initializer)
    if (ts.isFunctionDeclaration(node) && node.name && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      exported.push(node.name.text)
      if (node.parameters.length !== 1 || !node.parameters[0].type || !ts.isTypeReferenceNode(node.parameters[0].type)) problems.push('attendance command producer')
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'buildPlan') {
      counts.plans += 1
      const expression = node.body?.statements.find(ts.isReturnStatement)?.expression
      const object = expression && ts.isCallExpression(expression) ? expression.arguments[0] : expression
      const fields = object && ts.isObjectLiteralExpression(object) ? fieldsOf(object, tree) : undefined
      if (!fields || JSON.stringify([...fields.keys()].sort()) !== JSON.stringify(PLAN_KEYS)) problems.push('attendance command plan')
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'assignParentRoleIds' && compact(node.body?.getText(tree) ?? '') !== '{ return Object.freeze([...new Set([...ATTENDANCE_TEMPLATE_ROLE_IDS, roleId])].sort(compareCodeUnits)) }') problems.push('attendance command parents')
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'declaredParentRoleIds' && !compact(node.body?.getText(tree) ?? '').includes('return Object.freeze([context.roleId])')) problems.push('attendance command parents')
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'freezeRequestedUserIds' && compact(node.body?.getText(tree) ?? '') !== '{ return Object.freeze([...userIds]) }') problems.push('attendance command frozen input')
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'commandContext' && !compact(node.body?.getText(tree) ?? '').includes('const userIds = freezeRequestedUserIds(input.userIds)')) problems.push('attendance command frozen input')
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      if (name === 'withAuthorizationInputTransaction') {
        counts.transactions += 1
        const callback = node.arguments[1]
        const callbackText = callback?.getText(tree) ?? ''
        const asyncArrow = !!callback && ts.isArrowFunction(callback) && callback.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true && callback.parameters.map(parameter => parameter.name.getText(tree)).join() === 'tx'
        if (node.arguments.length !== 2 || compact(node.arguments[0]?.getText(tree) ?? '') !== 'context.plan' || !asyncArrow || /\binput\./.test(callbackText) || callbackText.includes('withAuthorizationInputTransaction')) problems.push('attendance command transaction')
        const names: string[] = []
        const calls = (child: ts.Node) => { if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) names.push(child.expression.text); ts.forEachChild(child, calls) }
        if (callback) calls(callback)
        const writer = ownerName(node)
        const sequence = writer === ASSIGN ? ['assertContext', 'assertLockedActorScope', 'assertWitnessedSubjects', 'assertContext', 'assignUserRoles'] : writer === UNASSIGN ? ['assertContext', 'assertLockedActorScope', 'assertWitnessedSubjects', 'assertContext', 'unassignUserRoles'] : ['missing-owner']
        let from = 0
        if (sequence.some(step => { const at = names.indexOf(step, from); if (at < 0) return true; from = at + 1; return false })) problems.push('attendance command context')
      }
      if (name === 'deriveAttendanceRoleAssignmentScope') {
        counts.scopeCalls += 1
        if (node.arguments.length !== 1 || compact(node.arguments[0].getText(tree)) !== "{ kind: 'global' }") problems.push('attendance command writer')
      }
      if (name === 'assignUserRoles' || name === 'unassignUserRoles') {
        counts[name === 'assignUserRoles' ? 'assignWrites' : 'unassignWrites'] += 1
        const fields = node.arguments.length === 1 && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0]) ? fieldsOf(node.arguments[0], tree) : undefined
        if (fields?.get('executor') !== 'tx' || fields.get('scope') !== 'roleWriteScope') problems.push('attendance command writer')
      }
      if (name === 'commandContext') {
        const third = compact(node.arguments[2]?.getText(tree) ?? '')
        const owner = ownerName(node)
        if ((owner === ASSIGN && third !== 'assignParentRoleIds(input.roleId)') || (owner === UNASSIGN && third !== 'Object.freeze([input.roleId])')) problems.push('attendance command parents')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  const alias = tree.statements.find((statement): statement is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'AttendanceGlobalRoleCommandInput')
  const literal = alias && ts.isTypeReferenceNode(alias.type) ? alias.type.typeArguments?.[0] : undefined
  const inputKeys = literal && ts.isTypeLiteralNode(literal) ? literal.members.flatMap(member => ts.isPropertySignature(member) && member.name ? [member.name.getText(tree)] : []) : []
  if (JSON.stringify(exported.sort()) !== JSON.stringify([ASSIGN, UNASSIGN].sort()) || JSON.stringify(inputKeys.sort()) !== JSON.stringify(INPUT_KEYS)) problems.push('attendance command producer')
  if (counts.transactions !== 2 || counts.assignWrites !== 1 || counts.unassignWrites !== 1 || counts.scopeCalls !== 2 || counts.plans !== 1) problems.push('attendance command transaction')
  for (const token of FORBIDDEN) if (command.includes(token)) problems.push('attendance command forbidden form')
  const catalog = catalogRoleIds(route).sort()
  if (!templates || JSON.stringify(templates.slice().sort()) !== JSON.stringify(catalog) || catalog.length === 0) problems.push('attendance command catalog')
  return problems
}

function attendanceCommandProblems(files: readonly string[], sourceOf: (file: string) => string): string[] {
  const found: Array<readonly [string, string]> = []
  const problems: string[] = []
  let command = ''
  let route = ''
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue
    const source = sourceOf(file)
    if (file === ATTENDANCE_COMMAND) command = source
    if (file === ATTENDANCE_ROUTE) route = source
    for (const specifier of importSpecifiers(source)) if (specifier.includes('attendance-role-commands')) found.push([file, specifier])
    problems.push(...dynamicCommandLoads(file, source))
  }
  problems.push(...importEdgeViolations(found, [[ATTENDANCE_ROUTE, ATTENDANCE_SPEC]]))
  if (!command || !route) return [...problems, 'attendance command pair missing']
  return [...problems, ...routeCallProblems(route), ...producerProblems(command, route)]
}

describe('attendance global role command caller boundary', () => {
  const relevant = [ATTENDANCE_COMMAND, ATTENDANCE_ROUTE]

  it('accepts the production pair once and an unrelated module', () => {
    expect(attendanceCommandProblems(productionFiles, read)).toEqual([])
    for (const id of ['W-01', 'W-02', 'W-03', 'W-15', 'W-17']) expect(AUTHORIZATION_INPUT_WRITERS.find(writer => writer.id === id)?.status).toBe('pending')
    const unrelated = `${SRC}/admin/platform-actor-authority.ts`
    expect(attendanceCommandProblems([...relevant, unrelated], file => file === unrelated ? 'export const untouched = 1\n' : read(file))).toEqual([])
  })

  it('rejects importer, shape, plan, parent, catalog, writer, context, and order edits', () => {
    const command = read(ATTENDANCE_COMMAND)
    const route = read(ATTENDANCE_ROUTE)
    const swapped = route.replace('await preflightAttendanceGlobalRoleWrite(req, [userId])\n      const written = await assignAttendanceGlobalRolesCommand({', 'const written = await assignAttendanceGlobalRolesCommand({').replace('includeProfile: true,\n      })', 'includeProfile: true,\n      })\n      await preflightAttendanceGlobalRoleWrite(req, [userId])')
    const edits: Array<readonly [string, string]> = [
      [ATTENDANCE_ROUTE, route.replace('assignAttendanceGlobalRolesCommand,\n  unassignAttendanceGlobalRolesCommand,', 'assignAttendanceGlobalRolesCommand as assignRoles,\n  unassignAttendanceGlobalRolesCommand,')],
      [ATTENDANCE_ROUTE, route.replace(`import {\n  ${ASSIGN},\n  ${UNASSIGN},\n} from '${ATTENDANCE_SPEC}'`, `import '${ATTENDANCE_SPEC}'`)],
      [ATTENDANCE_ROUTE, route.replace(`import {\n  ${ASSIGN},\n  ${UNASSIGN},\n} from '${ATTENDANCE_SPEC}'`, `import AttendanceRoleCommands from '${ATTENDANCE_SPEC}'`)],
      [ATTENDANCE_ROUTE, route.replace('includeProfile: false,\n      })', 'includeProfile: false,\n      }, () => undefined)')],
      [ATTENDANCE_ROUTE, route.replace('legacyAdminClaim: hasLegacyAdminClaim(req)', 'legacyAdminClaim: true')],
      [ATTENDANCE_COMMAND, command.replace('[...ATTENDANCE_TEMPLATE_ROLE_IDS, roleId]', '[...ATTENDANCE_TEMPLATE_ROLE_IDS]')],
      [ATTENDANCE_COMMAND, command.replace('Object.freeze([context.roleId])', 'Object.freeze([])')],
      [ATTENDANCE_COMMAND, command.replace('Object.freeze([context.roleId])', 'Object.freeze([...ATTENDANCE_TEMPLATE_ROLE_IDS])')],
      [ATTENDANCE_COMMAND, command.split('executor: tx').join('executor: pool')],
      [ATTENDANCE_COMMAND, command.replace('return Object.freeze({\n    intent,', 'return Object.freeze({\n    intent,\n    platformAdminInvariant: true,')],
      [ATTENDANCE_ROUTE, route.replace("roleId: 'attendance_employee'", "roleId: 'attendance_employee_x'")],
      [ATTENDANCE_COMMAND, command.replace('assertWitnessedSubjects(tx, context)\n', '')],
      [ATTENDANCE_COMMAND, command.replace('assertContext(tx, context)\n', '')],
      [ATTENDANCE_ROUTE, swapped],
      [ATTENDANCE_COMMAND, command.replace('input: AttendanceGlobalRoleCommandInput,\n): Promise<AttendanceGlobalRoleCommandResult>', 'input: AttendanceGlobalRoleCommandInput, runner?: unknown,\n): Promise<AttendanceGlobalRoleCommandResult>')],
      [ATTENDANCE_ROUTE, `${route}\nvoid import('${ATTENDANCE_SPEC}')\n`],
      [ATTENDANCE_COMMAND, `${command}\nvoid requireRoleRows\n`],
    ]
    for (const [index, [target, changed]] of edits.entries()) {
      expect(changed, `attendance control ${index}`).not.toBe(target === ATTENDANCE_COMMAND ? command : route)
      expect(attendanceCommandProblems(relevant, file => file === target ? changed : read(file)), `attendance control ${index}`).not.toEqual([])
    }
    const rogue = `${SRC}/admin/rogue-attendance-command.ts`
    expect(attendanceCommandProblems([...relevant, rogue], file => file === rogue ? `import { ${ASSIGN} } from '${ATTENDANCE_SPEC}'` : read(file))).not.toEqual([])
    expect(attendanceCommandProblems(relevant, file => file === ATTENDANCE_ROUTE ? `${route}\nimport { ${ASSIGN}, ${UNASSIGN} } from '${ATTENDANCE_SPEC}'\n` : read(file))).not.toEqual([])
  })
})
