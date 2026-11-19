/**
 * Production wiring of the action proof service: with the switch on and the production binding,
 * every purpose is refused before any statement; the table, the service module and the route module
 * have exactly the expected readers, importers and mount; the real-PG suite is wired into CI; and the
 * OpenAPI source declares the route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import ts from 'typescript'
import { requiredSuiteJob } from '../../../../scripts/ops/plugin-tests-workflow-contract.mjs'

const dbMocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), poolQuery: vi.fn(), poolTransaction: vi.fn(), audit: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ pool: null, query: dbMocks.query, transaction: dbMocks.transaction }))
vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ query: dbMocks.poolQuery, transaction: dbMocks.poolTransaction, getInternalPool: () => null }) },
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: dbMocks.audit }))
const bcryptMocks = vi.hoisted(() => ({ compare: vi.fn() }))
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>()
  bcryptMocks.compare.mockImplementation(actual.compare)
  return { ...actual, compare: bcryptMocks.compare }
})
// The classifier the service calls, wrapped so that a call is observable and behaves as the original.
const classifierMocks = vi.hoisted(() => ({ assess: vi.fn(), read: vi.fn() }))
vi.mock('../../src/auth/security-action-privilege', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/security-action-privilege')>()
  classifierMocks.assess.mockImplementation(actual.assessSecurityActionPrivilege)
  classifierMocks.read.mockImplementation(actual.readPrivilegeInputs)
  return { ...actual, assessSecurityActionPrivilege: classifierMocks.assess, readPrivilegeInputs: classifierMocks.read }
})

import { isSecurityActionPurposeAvailable, SECURITY_ACTION_PURPOSES } from '../../src/auth/external-login-assurance'
import type { SecurityActionPurpose } from '../../src/auth/external-login-assurance'
import { consumeSecurityActionProof, issueSecurityActionProof, SecurityActionProofError } from '../../src/auth/security-action-proof'
import type { SecurityActionConsumeInput, SecurityActionVerifyRequest } from '../../src/auth/security-action-proof'
import { securityActionsRouter } from '../../src/routes/security-actions'
import { importSpecifiers, listSourceFiles } from '../helpers/import-edge-allowlist'
import { CONNECTION, contextFor, ORG, TARGET_IDENTITY, TARGET_WITNESS, tokenFor, USER } from '../helpers/security-action-proof-harness'

const pinned = usePinnedServer()

/** Sends through this suite's pinned server, with `app` installed for the request. */
function via(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const BACKEND = path.join(ROOT, 'packages', 'core-backend')
const SRC = path.join(BACKEND, 'src')
const SERVICE = path.join(SRC, 'auth', 'security-action-proof.ts')
const ROUTE = path.join(SRC, 'routes', 'security-actions.ts')
const INDEX = path.join(SRC, 'index.ts')
const MIGRATION = path.join(SRC, 'db', 'migrations', 'zzzz20261106120000_create_security_action_challenges.ts')
const PROOF_STORAGE = path.join(SRC, 'auth', 'admin-grant-proof-storage.ts')
const PROOF_SET_MIGRATION = path.join(SRC, 'db', 'migrations', 'zzzz20261118100000_admin_grant_proof_sets.ts')
const SCOPE_MIGRATION = path.join(SRC, 'db', 'migrations', 'zzzz20261118120000_strict_login_grant_scope.ts')
const GRANT_PROOF = path.join(SRC, 'auth', 'admin-grant-proof.ts')
const DB_SPEC = 'tests/integration/security-action-proof.db.test.ts'
const TABLE = 'security_action_challenges'

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

function databaseArmingProblems(source: string): string[] {
  const tree = ts.createSourceFile(DB_SPEC, source, ts.ScriptTarget.Latest, true)
  const declarations = tree.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
  const named = (name: string) => declarations.filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)
  const problems: string[] = []
  const captures = named('capture')
  const initializer = captures.length === 1 ? captures[0].initializer : undefined
  const callback = initializer && ts.isCallExpression(initializer) && initializer.expression.getText(tree) === 'vi.hoisted'
    && initializer.arguments.length === 1 ? initializer.arguments[0] : undefined
  const first = callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body) ? callback.body.statements[0] : undefined
  const refusal = first && ts.isIfStatement(first) && ts.isBlock(first.thenStatement)
    && first.thenStatement.statements.length === 1 ? first.thenStatement.statements[0] : undefined
  const thrown = refusal && ts.isThrowStatement(refusal) ? refusal.expression : undefined
  const arming = first && ts.isIfStatement(first) && !first.elseStatement
    && first.expression.getText(tree).replace(/\s+/g, '') === "process.env.EXPECT_DB!=='1'||!process.env.DATABASE_URL"
    && thrown && ts.isNewExpression(thrown) && ts.isIdentifier(thrown.expression) && thrown.expression.text === 'Error'
    && thrown.arguments?.length === 1 && ts.isStringLiteral(thrown.arguments[0])
    && thrown.arguments[0].text === 'security-action-proof.db.test.ts requires EXPECT_DB=1 and DATABASE_URL'
  if (!arming) problems.push('arming')
  const suites = named('suite')
  const suite = suites.length === 1 ? suites[0] : undefined
  if (!suite || !(suite.parent.flags & ts.NodeFlags.Const) || !suite.initializer
    || !ts.isIdentifier(suite.initializer) || suite.initializer.text !== 'describe') problems.push('suite')
  let suiteCalls = 0
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'suite') suiteCalls += 1
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && ts.isIdentifier(node.expression) && ['it', 'describe', 'suite'].includes(node.expression.text)) {
      const skip = ts.isPropertyAccessExpression(node) ? node.name.text === 'skip'
        : ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'skip'
      if (skip) problems.push('skip')
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (suiteCalls === 0) problems.push('suite call')
  return problems
}

/** Module specifiers of every module load in the file (see the import-edge helper). */
function importEdges(file: string): string[] {
  return importSpecifiers(readFileSync(file, 'utf8'), file)
}

function importedNames(file: string, specifier: string): string[] {
  const source = parse(file)
  const names: string[] = []
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== specifier) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.push(element.name.text)
  }
  return names.sort()
}

function identifierCount(file: string, name: string): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) count += 1
    ts.forEachChild(node, visit)
  }
  visit(parse(file))
  return count
}

function exportedRuntimeNames(file: string): string[] {
  const names: string[] = []
  for (const statement of parse(file).statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!element.isTypeOnly) names.push(element.name.text)
        }
      }
      continue
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : []
    if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name) names.push(statement.name.text)
    if (ts.isClassDeclaration(statement) && statement.name) names.push(statement.name.text)
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
  }
  return names.sort()
}

let saved: string | undefined
beforeEach(() => {
  saved = process.env.SECURITY_ACTION_PROOF_ENABLED
  process.env.SECURITY_ACTION_PROOF_ENABLED = 'true'
  for (const mock of Object.values(dbMocks)) mock.mockClear()
  bcryptMocks.compare.mockClear()
  classifierMocks.assess.mockClear()
  classifierMocks.read.mockClear()
})
afterEach(() => {
  if (saved === undefined) delete process.env.SECURITY_ACTION_PROOF_ENABLED
  else process.env.SECURITY_ACTION_PROOF_ENABLED = saved
})

/** Every statement the service could have issued through either database entry point, in order. */
function statementsIssued(): string[] {
  const sql: string[] = []
  for (const mock of [dbMocks.query, dbMocks.poolQuery]) for (const call of mock.mock.calls) sql.push(String(call[0]))
  return sql
}

function expectNothingHappened(): void {
  // Statements, transactions, the classifier read, the password comparison and the audit row are
  // all counted from the route handler and the service onward. The session gate in front of the
  // route is a stub in these tests and is outside the count.
  expect(statementsIssued()).toEqual([])
  expect(dbMocks.transaction).not.toHaveBeenCalled()
  expect(dbMocks.poolTransaction).not.toHaveBeenCalled()
  expect(classifierMocks.read).not.toHaveBeenCalled()
  expect(classifierMocks.assess).not.toHaveBeenCalled()
  expect(bcryptMocks.compare).not.toHaveBeenCalled()
  expect(dbMocks.audit).not.toHaveBeenCalled()
}

function verifyBodyFor(purpose: SecurityActionPurpose): Record<string, unknown> {
  return purpose === 'external_identity_bind'
    ? { purpose, connectionId: CONNECTION, method: 'local_password', password: 'pw' }
    : { purpose, connectionId: CONNECTION, targetIdentityId: TARGET_IDENTITY, expectedBindingRevision: 0, method: 'local_password', password: 'pw' }
}

describe('production binding', () => {
  it('with the switch on and the production registry, every purpose is unavailable', () => {
    for (const purpose of SECURITY_ACTION_PURPOSES) expect(isSecurityActionPurposeAvailable(purpose)).toBe(false)
  })

  it('route: with the switch on, verify refuses every purpose with 403 before the classifier is read and before any statement; nothing is issued, consumed, superseded or audited (counted from the route handler onward; the session gate is a stub outside the count)', async () => {
    const app = express()
    app.use(express.json())
    // The stub stands in for the session gate: it issues no statement and is not part of the count.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { id: USER }
      req.authenticatedTenantId = ORG
      next()
    })
    const router = securityActionsRouter()
    expect(router).not.toBeNull()
    app.use('/api/auth/security-actions', router!)
    const token = tokenFor(USER, 'sid-inert', ORG)
    for (const purpose of SECURITY_ACTION_PURPOSES) {
      const response = await via(app).post('/api/auth/security-actions/verify').set('Authorization', `Bearer ${token}`).send(verifyBodyFor(purpose))
      expect(response.status).toBe(403)
      expect(response.body).toEqual({ ok: false, error: { code: 'SECURITY_ACTION_PURPOSE_UNAVAILABLE', message: 'Security action refused' } })
      expect(response.headers['cache-control']).toBe('no-store')
    }
    expectNothingHappened()
  })

  it('service: with the switch on, issue and consume refuse every purpose with 403 before the classifier is read and before any statement; nothing is issued, consumed, superseded or audited (no gate is involved at this level)', async () => {
    const client = { query: vi.fn() }
    for (const purpose of SECURITY_ACTION_PURPOSES) {
      const request = verifyBodyFor(purpose) as unknown as SecurityActionVerifyRequest
      const refusal = await issueSecurityActionProof(contextFor(USER, 'sid-inert', ORG), request).then(() => null, (error: unknown) => error)
      expect(refusal).toBeInstanceOf(SecurityActionProofError)
      expect((refusal as SecurityActionProofError).code).toBe('SECURITY_ACTION_PURPOSE_UNAVAILABLE')
      expect((refusal as SecurityActionProofError).status).toBe(403)
      const input: SecurityActionConsumeInput = {
        proof: 'sap1.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.' + 'b'.repeat(43),
        purpose,
        connectionId: CONNECTION,
        target: { kind: purpose === 'external_identity_bind' ? 'empty_slot' : 'identity_revision', witness: TARGET_WITNESS },
        lockedUser: { id: USER } as SecurityActionConsumeInput['lockedUser'],
      }
      const consumed = await consumeSecurityActionProof(client as never, contextFor(USER, 'sid-inert', ORG), input).then(() => null, (error: unknown) => error)
      expect(consumed).toBeInstanceOf(SecurityActionProofError)
      expect((consumed as SecurityActionProofError).code).toBe('SECURITY_ACTION_PURPOSE_UNAVAILABLE')
    }
    expect(client.query).not.toHaveBeenCalled()
    expectNothingHappened()
  })

  it('binds the production dependencies without an injection point', () => {
    const source = parse(SERVICE)
    const production = source.statements.find((statement): statement is ts.VariableStatement =>
      ts.isVariableStatement(statement) && statement.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === 'PRODUCTION'))
    expect(production).toBeDefined()
    const initializer = production!.declarationList.declarations[0].initializer
    expect(initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'createSecurityActionProofService').toBe(true)
    const freeze = (initializer as ts.CallExpression).arguments[0]
    expect(ts.isCallExpression(freeze) && freeze.expression.getText(source) === 'Object.freeze').toBe(true)
    const literal = (freeze as ts.CallExpression).arguments[0]
    expect(ts.isObjectLiteralExpression(literal)).toBe(true)
    const bindings = new Map<string, string>()
    for (const property of (literal as ts.ObjectLiteralExpression).properties) {
      expect(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)).toBe(true)
      if (ts.isPropertyAssignment(property)) bindings.set(property.name.getText(source), property.initializer.getText(source))
      if (ts.isShorthandPropertyAssignment(property)) bindings.set(property.name.text, property.name.text)
    }
    expect(bindings.get('isPurposeAvailable')).toBe('isSecurityActionPurposeAvailable')
    expect(bindings.get('resolvers')).toBe('Object.freeze({})')
    expect(bindings.get('runOwnedAttempt')).toBe('runOwnedAttempt')
    expect(bindings.get('recordAudit')).toBe('auditSecurityAction')
    expect(bindings.get('policyRevision')).toBe('SECURITY_ACTION_POLICY_REVISION')
    expect([...bindings.keys()].sort()).toEqual(['isPurposeAvailable', 'policyRevision', 'recordAudit', 'resolvers', 'runOwnedAttempt'])
    const users = listSourceFiles(SRC).filter((file) => readFileSync(file, 'utf8').includes('createSecurityActionProofService'))
    expect(users).toEqual([SERVICE])
    const availabilityUsers = listSourceFiles(SRC).filter((file) => readFileSync(file, 'utf8').includes('evaluateSecurityActionPurposeAvailability'))
    expect(availabilityUsers).toEqual([path.join(SRC, 'auth', 'external-login-assurance.ts')])
  })
})

describe('module boundaries', () => {
  it('names the table only in the audited modules; the migration runner mentions it in its help text only', () => {
    const files = listSourceFiles(SRC).filter((file) => readFileSync(file, 'utf8').includes(TABLE))
    const runner = path.join(SRC, 'db', 'migrate.ts')
    // Service statements, the admin-grant storage writer, the creating migration, the proof-set
    // constraint migration, the scope migration, and the runner help text. No other file.
    expect(files.sort()).toEqual([SERVICE, PROOF_STORAGE, MIGRATION, PROOF_SET_MIGRATION, SCOPE_MIGRATION, runner].sort())
    const help = readFileSync(runner, 'utf8')
    expect(help).not.toMatch(new RegExp(`(?:FROM|INTO|UPDATE|TABLE|JOIN|regclass\\(')\\s*${TABLE}`))
    expect(help.split(TABLE)).toHaveLength(3)
    expect(help).toContain(`zzzz20261106120000_create_${TABLE}.ts refuses while`)
  })

  it('has exactly the expected importers: the audited proof consumers, and index imports the route', () => {
    const serviceImporters: string[] = []
    const routeImporters: string[] = []
    for (const file of listSourceFiles(SRC)) {
      for (const edge of importEdges(file)) {
        if (/security-action-proof(?:\.ts)?$/.test(edge) && !/security-action-proof-flag/.test(edge)) serviceImporters.push(path.relative(SRC, file))
        if (/routes\/security-actions(?:\.ts)?$/.test(edge)) routeImporters.push(path.relative(SRC, file))
      }
    }
    // One entry per load. Two entries means a value import and a separate type import, not a blanket.
    expect(serviceImporters.sort()).toEqual([
      'auth/admin-grant-browser-context.ts',
      'auth/admin-grant-local-credential.ts',
      'auth/admin-grant-proof.ts',
      'auth/admin-grant-proof.ts',
      'auth/admin-grant-target-ceremony.ts',
      'auth/admin-login-grant-command.ts',
      'auth/admin-login-grant-command.ts',
      'auth/strict-login-grant-bundle.ts',
      'routes/admin-grant-proofs.ts',
      'routes/auth.ts',
      'routes/security-actions.ts',
    ])
    const importedBy: Record<string, readonly string[]> = {
      'auth/admin-grant-browser-context.ts': ['AuthenticatedSessionContext', 'SecurityActionProofContractError', 'assertAuthenticatedSessionContext', 'readAuthenticatedSessionContext'],
      'auth/admin-grant-local-credential.ts': ['AuthenticatedSessionContext', 'SecurityActionProofContractError', 'assertAuthenticatedSessionContext'],
      'auth/admin-grant-proof.ts': ['AuthenticatedSessionContext', 'SECURITY_ACTION_FAILURE_LIMIT', 'SECURITY_ACTION_FAILURE_WINDOW_SECONDS', 'SECURITY_ACTION_SQL', 'SecurityActionProofError', 'assertAuthenticatedSessionContext', 'computeCredentialWitness'],
      'auth/admin-grant-target-ceremony.ts': ['AuthenticatedSessionContext', 'assertAuthenticatedSessionContext'],
      'auth/admin-login-grant-command.ts': ['AuthenticatedSessionContext', 'assertAuthenticatedSessionContext'],
      'auth/strict-login-grant-bundle.ts': ['AuthenticatedSessionContext'],
      'routes/admin-grant-proofs.ts': ['SecurityActionProofContractError', 'readAuthenticatedSessionContext'],
      'routes/auth.ts': ['readAuthenticatedSessionContext'],
      'routes/security-actions.ts': ['SecurityActionProofError', 'issueSecurityActionProof', 'parseSecurityActionVerifyRequest', 'readAuthenticatedSessionContext'],
    }
    for (const [file, names] of Object.entries(importedBy)) {
      const specifier = file.startsWith('routes/') ? '../auth/security-action-proof' : './security-action-proof'
      expect(importedNames(path.join(SRC, file), specifier), file).toEqual(names)
    }
    expect(routeImporters).toEqual(['index.ts'])
  })

  it('exports only the expected runtime names from the service module, and the route imports only four of them', () => {
    expect(exportedRuntimeNames(SERVICE)).toEqual([
      'SECURITY_ACTION_CREDENTIAL_WITNESS_DOMAIN', 'SECURITY_ACTION_FAILURE_CODES', 'SECURITY_ACTION_FAILURE_LIMIT', 'SECURITY_ACTION_FAILURE_WINDOW_SECONDS',
      'SECURITY_ACTION_NEXT_STEPS', 'SECURITY_ACTION_PROOF_HASH_DOMAIN', 'SECURITY_ACTION_PROOF_STATUSES', 'SECURITY_ACTION_PROOF_TTL_SECONDS', 'SECURITY_ACTION_SQL',
      'SecurityActionProofContractError', 'SecurityActionProofError', 'assertAuthenticatedSessionContext', 'clientBindingDigestOf', 'computeCredentialWitness', 'consumeSecurityActionProof',
      'createSecurityActionProofService', 'hashProofSecret', 'issueSecurityActionProof', 'parseProof', 'parseSecurityActionVerifyRequest', 'readAuthenticatedSessionContext',
    ])
    expect(importedNames(ROUTE, '../auth/security-action-proof')).toEqual(['SecurityActionProofError', 'issueSecurityActionProof', 'parseSecurityActionVerifyRequest', 'readAuthenticatedSessionContext'])
  })

  it('keeps consumption inside the service module and limits statement reuse to four audited members', () => {
    for (const file of listSourceFiles(SRC)) {
      if (file === SERVICE) continue
      expect(identifierCount(file, 'consumeSecurityActionProof'), file).toBe(0)
      if (file === GRANT_PROOF) continue
      expect(identifierCount(file, 'SECURITY_ACTION_SQL'), file).toBe(0)
    }
    const members: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'SECURITY_ACTION_SQL') members.push(node.name.text)
      ts.forEachChild(node, visit)
    }
    visit(parse(GRANT_PROOF))
    // Import plus these four accesses. failureCount, the read-committed set, the advisory lock, the user key share.
    expect(members.sort()).toEqual(['advisoryLock', 'failureCount', 'setReadCommitted', 'userKeyShare'])
    expect(identifierCount(GRANT_PROOF, 'SECURITY_ACTION_SQL')).toBe(5)
    expect(identifierCount(SERVICE, 'SECURITY_ACTION_SQL')).toBeGreaterThan(1)
  })

  it('imports a fixed set of modules and never a cache, a request field, the environment or a session helper', () => {
    expect(importEdges(SERVICE).sort()).toEqual([
      '../audit/audit', '../directory/access-graph-mutex', '../directory/access-graph-mutex', '../multitable/automation-durable-dispatcher',
      '../multitable/pg-transaction-guard', './AuthService', './external-login-assurance', './external-login-assurance', './security-action-attempt-admission',
      './security-action-privilege', './security-action-proof-flag', './user-activation', 'express', 'node:crypto',
    ])
    expect(importEdges(ROUTE).sort()).toEqual(['../auth/security-action-proof', '../auth/security-action-proof-flag', '../core/logger', 'express', 'express'])
    for (const file of [SERVICE, ROUTE]) {
      const source = readFileSync(file, 'utf8')
      for (const forbidden of ['isUserSessionActive', 'resolveSessionTenantId', 'getUserById', 'verifyToken', 'listUserPermissions', 'req.user.tenantId', 'process.env', 'rbac/service']) {
        expect(source, `${path.basename(file)} must not reference ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('registers a session context at exactly one construction point', () => {
    const source = readFileSync(SERVICE, 'utf8')
    expect(source.split('sessionContexts.add(')).toHaveLength(2)
    expect(source).not.toMatch(/export\s+(?:const|let|var)\s+sessionContexts/)
    expect(identifierCount(SERVICE, 'sessionContexts')).toBe(3)
  })

  it('mounts the router and its error handler in index.ts only inside the switch condition, after the auth router', () => {
    const source = parse(INDEX)
    const text = readFileSync(INDEX, 'utf8')
    const calls: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'securityActionsRouter') calls.push(node)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(calls).toHaveLength(1)
    const declaration = calls[0].parent
    expect(ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)).toBe(true)
    const variable = ((declaration as ts.VariableDeclaration).name as ts.Identifier).text
    const statement = declaration.parent.parent
    expect(ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0).toBe(true)
    const uses: ts.Identifier[] = []
    const collect = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === variable && node !== (declaration as ts.VariableDeclaration).name) uses.push(node)
      ts.forEachChild(node, collect)
    }
    collect(source)
    expect(uses).toHaveLength(2)
    const [condition, mountArgument] = uses
    expect(ts.isIfStatement(condition.parent) && condition.parent.expression === condition).toBe(true)
    const ifStatement = condition.parent as ts.IfStatement
    expect(ifStatement.elseStatement).toBeUndefined()
    const block = ifStatement.thenStatement
    expect(ts.isBlock(block)).toBe(true)
    // The router first, then the error handler for the same prefix, and nothing else in the block.
    expect((block as ts.Block).statements.map((entry) => entry.getText(source))).toEqual([
      `this.app.use('/api/auth/security-actions', ${variable})`,
      "this.app.use('/api/auth/security-actions', securityActionParseErrorHandler)",
    ])
    expect(mountArgument.parent.getText(source)).toBe(`this.app.use('/api/auth/security-actions', ${variable})`)
    expect(text.indexOf("this.app.use('/api/auth', authRouter)")).toBeLessThan(text.indexOf('securityActionsRouter()'))
    expect(text.split("'/api/auth/security-actions'")).toHaveLength(3)
    // The error handler is named at its import and its mount only.
    expect(text.split('securityActionParseErrorHandler')).toHaveLength(3)
    expect(importedNames(INDEX, './routes/security-actions')).toEqual(['securityActionParseErrorHandler', 'securityActionsRouter'])
  })

  it('leaves the global body parsers, the application settings and the order of the pipeline before the route as they are, and the route module parses nothing itself', () => {
    const source = parse(INDEX)
    const text = readFileSync(INDEX, 'utf8')
    const parsers: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && ['express', 'bodyParser'].includes(node.expression.expression.text) && ['json', 'urlencoded', 'text', 'raw'].includes(node.expression.name.text)) {
        parsers.push(node.getText(source))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(parsers).toEqual([
      'express.json({ limit: attendanceImportJsonLimit })',
      "express.json({ limit: '2mb', strict: true })",
      "express.json({ limit: '10mb' })",
      'express.urlencoded({ extended: true })',
    ])
    expect(text).not.toMatch(/\bthis\.app\.(?:set|enable|disable)\(/)
    // The order the route tests rebuild: correlation id, global parsers, session gate, auth router,
    // this route and its handler, then the application's error handler.
    const order = [
      'this.app.use(correlationIdMiddleware)',
      "this.app.use(express.json({ limit: '10mb' }))",
      'this.app.use(express.urlencoded({ extended: true }))',
      'if (isWhitelisted(req.path)) return next()',
      'if (isApiPath(req.path)) return jwtAuthMiddleware(req, res, next)',
      "this.app.use('/api/auth', authRouter)",
      "this.app.use('/api/auth/security-actions', securityActionRoutes)",
      "this.app.use('/api/auth/security-actions', securityActionParseErrorHandler)",
      'this.app.use(correlationErrorHandler(this.logger))',
    ]
    for (const anchor of order) expect(text.split(anchor), anchor).toHaveLength(2)
    const positions = order.map((anchor) => text.indexOf(anchor))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    const route = readFileSync(ROUTE, 'utf8')
    for (const forbidden of ['express.json', 'express.urlencoded', 'express.text', 'express.raw', 'bodyParser', 'body-parser', '.app', 'app.set', 'app.use']) {
      expect(route, `the route module must not reference ${forbidden}`).not.toContain(forbidden)
    }
  })
})

describe('wiring', () => {
  it('registers the whole real-PG suite in the approval real-DB step, excludes it from the no-DB runner, and the file carries the arming sentinel', () => {
    const workflow = yaml.load(readFileSync(path.join(ROOT, '.github/workflows/plugin-tests.yml'), 'utf8')) as Parameters<typeof requiredSuiteJob>[0]
    const step = requiredSuiteJob(workflow, 'approval-db').steps.find((entry: { id?: string }) => entry.id === 'approval-real-db-integration') as
      { id?: string; if?: string; env?: Record<string, string>; run?: string; 'continue-on-error'?: unknown } | undefined
    expect(step?.if).toBe("matrix.node-version == '20.x'")
    expect(step?.env?.EXPECT_DB).toBe('1')
    expect(step?.env?.DATABASE_URL).toMatch(/^postgres(?:ql)?:\/\//)
    expect(step?.['continue-on-error']).toBeUndefined()
    const command = (step?.run ?? '').replace(/\\\r?\n/g, ' ')
    expect(command).toMatch(/vitest --config vitest\.integration\.config\.ts run /)
    expect(command.split(/\s+/).filter((token) => token === DB_SPEC)).toHaveLength(1)
    expect(command).not.toMatch(/(?:^|\s)(?:-t|--testNamePattern|--passWithNoTests)(?:\s|=|$)/)
    const config = parse(path.join(BACKEND, 'vitest.config.ts'))
    let excluded = false
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(config) === 'exclude' && ts.isArrayLiteralExpression(node.initializer)) {
        excluded ||= node.initializer.elements.some((entry) => ts.isStringLiteral(entry) && entry.text === DB_SPEC)
      }
      ts.forEachChild(node, visit)
    }
    visit(config)
    expect(excluded).toBe(true)
    const spec = path.join(BACKEND, DB_SPEC)
    expect(existsSync(spec)).toBe(true)
    expect(databaseArmingProblems(readFileSync(spec, 'utf8'))).toEqual([])
  })

  it.each([
    ['bracket skip', (source: string) => source.replace('const suite = describe', "const suite = describe['skip']")],
    ['comment decoy', (source: string) => source.replace('const suite = describe', "const suite = 'describe'; /* const suite = describe */")],
    ['missing URL', (source: string) => source.replace("process.env.EXPECT_DB !== '1' || !process.env.DATABASE_URL", "process.env.EXPECT_DB !== '1'")],
    ['weakened arming', (source: string) => source.replace("process.env.EXPECT_DB !== '1' || !process.env.DATABASE_URL", "process.env.EXPECT_DB !== '1' && !process.env.DATABASE_URL")],
  ] as const)('refuses a malformed database suite sentinel: %s', (_name, mutate) => {
    const source = readFileSync(path.join(ROOT, 'packages/core-backend', DB_SPEC), 'utf8')
    expect(databaseArmingProblems(source)).toEqual([])
    expect(databaseArmingProblems(mutate(source))).not.toEqual([])
  })

  it('declares the route in the OpenAPI source with the closed purpose set and a closed request schema', () => {
    const doc = yaml.load(readFileSync(path.join(ROOT, 'packages/openapi/src/paths/auth.yml'), 'utf8')) as { paths: Record<string, Record<string, Record<string, unknown>>> }
    const operation = doc.paths['/api/auth/security-actions/verify']?.post as Record<string, unknown> | undefined
    expect(operation).toBeDefined()
    expect(operation?.security).toEqual([{ bearerAuth: [] }])
    const schema = ((operation?.requestBody as { content: Record<string, { schema: Record<string, unknown> }> }).content['application/json']).schema
    expect(schema.additionalProperties).toBe(false)
    const properties = schema.properties as Record<string, Record<string, unknown>>
    expect(properties.purpose.enum).toEqual([...SECURITY_ACTION_PURPOSES])
    expect(properties.method.enum).toEqual(['local_password'])
    expect(schema.required).toEqual(['purpose', 'connectionId', 'method', 'password'])
    expect(Object.keys(properties).sort()).toEqual(['clientBindingDigest', 'connectionId', 'expectedBindingRevision', 'method', 'password', 'purpose', 'targetIdentityId'])
    expect(Object.keys(operation?.responses as object).sort()).toEqual(['200', '401', '403', '409', '422', '429', '503'])
  })
})
