/**
 * State machine of one owned security-action attempt. The pool and bcrypt module are stand-ins.
 * They do not establish physical coordination.
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

type QueryCall = { client: number; sql: string; params: unknown[] }
type Gate = { resolve: (value: { rows: unknown[]; rowCount: number }) => void; reject: (error: unknown) => void }

const hook = vi.hoisted(() => ({
  connectionString: 'postgres://unit' as string | undefined,
  connect: (async () => {
    throw new Error('connect unset')
  }) as () => Promise<EventEmitter>,
}))

vi.mock('../../src/db/pg', () => ({
  get pool() {
    if (hook.connectionString === undefined && hook.connect === null) return null
    return {
      connect: () => hook.connect(),
      options: { connectionString: hook.connectionString },
    }
  },
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ query: vi.fn(), transaction: vi.fn(), getInternalPool: () => null }) },
}))

const bcryptHook = vi.hoisted(() => ({
  compare: vi.fn(async (_password: string, _hash: string) => true),
}))

vi.mock('bcryptjs', () => ({
  compare: (password: string, hash: string) => bcryptHook.compare(password, hash),
}))

import { runOwnedAttempt } from '../../src/auth/security-action-attempt-admission'

const SESSION = 'sid-owned-attempt'
const PASSWORD = 'secret-password'
const HASH = 'hash-1'
const SOURCE = readFileSync(path.resolve(__dirname, '../../src/auth/security-action-attempt-admission.ts'), 'utf8')
const PROOF = readFileSync(path.resolve(__dirname, '../../src/auth/security-action-proof.ts'), 'utf8')
const MIGRATION = readFileSync(path.resolve(__dirname, '../../src/db/migrations/zzzz20261117120100_create_security_action_session_flight.ts'), 'utf8')

function parsed(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
}

function modifierKinds(node: ts.Node): Set<ts.SyntaxKind> {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []
  return new Set(modifiers.map((modifier) => modifier.kind))
}

function exportedRuntimeValueNames(text: string): string[] {
  const names: string[] = []
  for (const statement of parsed('security-action-attempt-admission.ts', text).statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      const clause = statement.exportClause
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) if (!element.isTypeOnly) names.push(element.name.text)
      }
      continue
    }
    const kinds = modifierKinds(statement)
    if (!kinds.has(ts.SyntaxKind.ExportKeyword)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name) names.push(statement.name.text)
    if (ts.isClassDeclaration(statement) && statement.name) names.push(statement.name.text)
    if (ts.isEnumDeclaration(statement)) names.push(statement.name.text)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
      }
    }
  }
  return names
}

function exportedAsyncFunctionNames(text: string): string[] {
  const names: string[] = []
  for (const statement of parsed('security-action-attempt-admission.ts', text).statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue
    const kinds = modifierKinds(statement)
    if (kinds.has(ts.SyntaxKind.ExportKeyword) && kinds.has(ts.SyntaxKind.AsyncKeyword)) names.push(statement.name.text)
  }
  return names
}

function callStart(root: ts.Node, name: string): number | undefined {
  let found: number | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      found = node.getStart()
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function literalStart(root: ts.Node, needle: string): number | undefined {
  let found: number | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isStringLiteral(node) && node.text.includes(needle)) {
      found = node.getStart()
      return
    }
    if (ts.isNoSubstitutionTemplateLiteral(node) && node.text.includes(needle)) {
      found = node.getStart()
      return
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (node.text.includes(needle)) {
        found = node.getStart()
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function hasExactString(root: ts.Node, text: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isStringLiteral(node) && node.text === text) found = true
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function templateText(root: ts.Node): string {
  const parts: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(node)) parts.push(node.text)
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) parts.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return parts.join('\n')
}

function functionNamed(file: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function identifierNames(node: ts.Node): Set<string> {
  const names = new Set<string>()
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) names.add(child.text)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return names
}

function productionBindings(file: ts.SourceFile): Map<string, string> | undefined {
  let literal: ts.ObjectLiteralExpression | undefined
  const visit = (node: ts.Node): void => {
    if (literal) return
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'PRODUCTION'
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && node.initializer.arguments[0]
      && ts.isCallExpression(node.initializer.arguments[0])
      && node.initializer.arguments[0].arguments[0]
      && ts.isObjectLiteralExpression(node.initializer.arguments[0].arguments[0])
    ) {
      literal = node.initializer.arguments[0].arguments[0]
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!literal) return undefined
  const bindings = new Map<string, string>()
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property)) bindings.set(property.name.getText(file), property.initializer.getText(file))
    else if (ts.isShorthandPropertyAssignment(property)) bindings.set(property.name.text, property.name.text)
    else return undefined
  }
  return bindings
}

class DomainRefusal extends Error {
  readonly code: string
  constructor(code: string) {
    super('Security action refused')
    this.name = 'SecurityActionProofError'
    this.code = code
  }
}

class FakeClient extends EventEmitter {
  readonly id: number
  released = false
  discarded = false
  constructor(id: number) {
    super()
    this.id = id
  }
  query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    calls.push({ client: this.id, sql, params })
    const decided = beforeQuery(sql, params, this)
    if (decided === 'lose') {
      const error = new Error('connection lost')
      this.emit('error', error)
      return Promise.reject(error)
    }
    if (decided instanceof Error) return Promise.reject(decided)
    if (decided && typeof decided === 'object' && 'hang' in decided) return decided.hang
    if (decided && typeof decided === 'object' && 'rows' in decided) return Promise.resolve({ rows: decided.rows, rowCount: decided.rowCount })
    return Promise.resolve(answer(sql))
  }
  release(err?: Error | boolean): void {
    this.released = true
    this.discarded = err instanceof Error || err === true
    releases.push({ client: this.id, discard: this.discarded })
  }
}

let nextId = 0
let calls: QueryCall[] = []
let releases: Array<{ client: number; discard: boolean }> = []
let clients: FakeClient[] = []
let acquired = true
let releasedRow = true
let unlocked = true
let beforeQuery: (
  sql: string,
  params: unknown[],
  client: FakeClient,
) => 'lose' | Error | { hang: Promise<{ rows: unknown[]; rowCount: number }> } | { rows: unknown[]; rowCount: number } | undefined = () => undefined

function catalogRow(overrides: { schema_name?: string; rel_oid?: string; relkind?: string; relpersistence?: string } = {}) {
  return {
    schema_name: 'sa_flight_unit',
    rel_oid: '12001',
    relkind: 'r',
    relpersistence: 'p',
    ...overrides,
  }
}

function answer(sql: string): { rows: unknown[]; rowCount: number } {
  if (sql.includes("set_config('lock_timeout'")) return { rows: [{}], rowCount: 1 }
  if (sql.includes('pg_catalog.pg_class')) return { rows: [catalogRow()], rowCount: 1 }
  if (sql.includes('current_schemas')) return { rows: [{ schema_name: 'sa_flight_unit' }], rowCount: 1 }
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
  if (sql.includes('pg_advisory_lock(')) return { rows: [{}], rowCount: 1 }
  if (sql.includes('pg_advisory_unlock(')) return { rows: [{ unlocked }], rowCount: 1 }
  if (sql.includes('security_action_session_flight_acquire')) return { rows: [{ acquired }], rowCount: 1 }
  if (sql.includes('security_action_session_flight_release')) return { rows: [{ released: releasedRow }], rowCount: 1 }
  if (sql.startsWith('RESET ')) return { rows: [], rowCount: 0 }
  return { rows: [{ present: 1 }], rowCount: 1 }
}

function sqlError(code: string): Error {
  const error = new Error('sqlstate ' + code)
  ;(error as Error & { code: string }).code = code
  return error
}

function hang(): { hang: Promise<{ rows: unknown[]; rowCount: number }>; gate: Gate } {
  let gate!: Gate
  const promise = new Promise<{ rows: unknown[]; rowCount: number }>((resolve, reject) => {
    gate = { resolve, reject }
  })
  return { hang: promise, gate }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return
    await flush()
  }
  throw new Error('timed out waiting for the attempt')
}

function sqlOf(client?: number): string[] {
  return calls.filter((call) => client === undefined || call.client === client).map((call) => call.sql)
}

function commits(): number {
  return calls.filter((call) => call.sql === 'COMMIT').length
}

function compared(): number {
  return bcryptHook.compare.mock.calls.length
}

type AttemptOptions = {
  sessionId?: string
  password?: string
  hash?: string
  readInputs?: (tx: Queryable) => Promise<{ passwordHash: string }>
  account?: (tx: Queryable, snapshot: { passwordHash: string }, verified: boolean) => Promise<{ kind: string }>
}

function attempt(options: AttemptOptions = {}) {
  const seen: { snapshot?: { passwordHash: string }; verified?: boolean; queryKeys?: string[] } = {}
  const promise = runOwnedAttempt(options.sessionId ?? SESSION, options.password ?? PASSWORD, {
    readInputs: options.readInputs ?? (async (tx) => {
      seen.queryKeys = Object.keys(tx)
      await tx.query('SELECT read_inputs')
      return { passwordHash: options.hash ?? HASH }
    }),
    account: options.account ?? (async (tx, snapshot, verified) => {
      seen.snapshot = snapshot
      seen.verified = verified
      await tx.query('SELECT account')
      return { kind: verified ? 'issued' : 'rejected' }
    }),
  })
  return { promise, seen }
}

beforeEach(() => {
  nextId = 0
  calls = []
  releases = []
  clients = []
  acquired = true
  releasedRow = true
  unlocked = true
  hook.connectionString = 'postgres://unit'
  beforeQuery = () => undefined
  bcryptHook.compare.mockReset()
  bcryptHook.compare.mockImplementation(async () => true)
  hook.connect = async () => {
    const client = new FakeClient(++nextId)
    clients.push(client)
    return client
  }
})

afterEach(() => {
  for (const client of clients) client.removeAllListeners()
})

describe('closed entry', () => {
  it('refuses before connect when the pool has no connection string', async () => {
    hook.connectionString = ''
    await expect(attempt().promise).rejects.toThrow('Security action refused')
    expect(clients).toHaveLength(0)
    expect(compared()).toBe(0)
  })

  it('refuses before connect when the pool does not expose a connection string', async () => {
    hook.connectionString = undefined
    await expect(attempt({ sessionId: '' }).promise).rejects.toThrow('Security action refused')
    expect(clients).toHaveLength(0)
  })

  it('compares once after the owned latch commit and before accounting, on one client', async () => {
    const { promise, seen } = attempt()
    await expect(promise).resolves.toEqual({ kind: 'issued' })
    expect(compared()).toBe(1)
    expect(bcryptHook.compare).toHaveBeenCalledWith(PASSWORD, HASH)
    expect(seen.verified).toBe(true)
    expect(seen.snapshot).toEqual({ passwordHash: HASH })
    expect(seen.queryKeys).toEqual(['query'])
    expect(clients).toHaveLength(1)
    expect(releases).toEqual([{ client: 1, discard: false }])
    const compareAt = bcryptHook.compare.mock.invocationCallOrder[0]
    const readAt = calls.findIndex((call) => call.sql === 'SELECT read_inputs')
    const accountAt = calls.findIndex((call) => call.sql === 'SELECT account')
    expect(readAt).toBeGreaterThanOrEqual(0)
    expect(accountAt).toBeGreaterThan(readAt)
    const claimCommit = calls.findIndex((call, index) => call.sql === 'COMMIT' && index > calls.findIndex((item) => item.sql.includes('_acquire')))
    expect(claimCommit).toBeGreaterThanOrEqual(0)
    expect(claimCommit).toBeLessThan(accountAt)
    expect(sqlOf(1).some((sql) => sql.includes('pg_advisory_lock('))).toBe(true)
    expect(calls.find((call) => call.sql.includes('pg_advisory_lock('))?.params).toEqual(['security-action-sid:' + SESSION])
    expect(SOURCE.split('bcrypt.compare(')).toHaveLength(2)
    expect(PROOF).not.toContain('bcrypt.compare(')
    expect(compareAt).toBeGreaterThan(0)
  })

  it('does not compare when the first step raises a domain refusal, and still releases the owned token', async () => {
    const refusal = new DomainRefusal('SECURITY_ACTION_RATE_LIMITED')
    const { promise } = attempt({
      readInputs: async () => {
        throw refusal
      },
    })
    await expect(promise).rejects.toBe(refusal)
    expect(compared()).toBe(0)
    expect(sqlOf().some((sql) => sql.includes('_release'))).toBe(true)
    expect(sqlOf().some((sql) => sql === 'SELECT account')).toBe(false)
    expect(releases).toEqual([{ client: 1, discard: false }])
  })

  it('does not compare or delete a foreign latch', async () => {
    acquired = false
    const { promise } = attempt()
    await expect(promise).rejects.toThrow('Security action refused')
    expect(compared()).toBe(0)
    expect(sqlOf().some((sql) => sql.includes('_release'))).toBe(false)
    expect(sqlOf().some((sql) => sql.includes('pg_advisory_unlock('))).toBe(true)
    expect(releases[0]?.discard).toBe(false)
  })

  it('counts a synchronous compare throw as one invocation and skips accounting', async () => {
    bcryptHook.compare.mockImplementation(() => {
      throw new Error('sync compare')
    })
    const { promise } = attempt()
    await expect(promise).rejects.toThrow('Security action refused')
    expect(compared()).toBe(1)
    expect(sqlOf().some((sql) => sql === 'SELECT account')).toBe(false)
    expect(sqlOf().some((sql) => sql.includes('_release'))).toBe(true)
    expect(JSON.stringify(calls)).not.toContain(PASSWORD)
  })

  it('counts a rejected compare once, drains it, and skips accounting', async () => {
    bcryptHook.compare.mockImplementation(async () => {
      throw new Error('compare failed')
    })
    const { promise } = attempt()
    await expect(promise).rejects.toThrow('Security action refused')
    expect(compared()).toBe(1)
    expect(sqlOf().some((sql) => sql === 'SELECT account')).toBe(false)
  })

  it('does not invoke the comparison a second time when accounting returns', async () => {
    bcryptHook.compare.mockImplementation(async () => {
      if (bcryptHook.compare.mock.calls.length > 1) throw new Error('second compare')
      return false
    })
    const { promise, seen } = attempt()
    await expect(promise).resolves.toEqual({ kind: 'rejected' })
    expect(compared()).toBe(1)
    expect(seen.verified).toBe(false)
  })
})

describe('query epochs', () => {
  it('drains an unawaited step query before commit', async () => {
    const deferred = hang()
    beforeQuery = (sql) => (sql === 'SELECT slow' ? { hang: deferred.hang } : undefined)
    const { promise } = attempt({
      readInputs: async (tx) => {
        void tx.query('SELECT slow')
        return { passwordHash: HASH }
      },
    })
    await waitFor(() => calls.some((call) => call.sql === 'SELECT slow'))
    expect(commits()).toBe(2)
    deferred.gate.resolve({ rows: [], rowCount: 0 })
    await expect(promise).resolves.toEqual({ kind: 'issued' })
    expect(commits()).toBeGreaterThanOrEqual(4)
  })

  it('rolls back when a drained step query fails and does not compare', async () => {
    const deferred = hang()
    beforeQuery = (sql) => (sql === 'SELECT slow' ? { hang: deferred.hang } : undefined)
    const { promise } = attempt({
      readInputs: async (tx) => {
        void tx.query('SELECT slow')
        return { passwordHash: HASH }
      },
    })
    await waitFor(() => calls.some((call) => call.sql === 'SELECT slow'))
    deferred.gate.reject(sqlError('23505'))
    await expect(promise).rejects.toThrow('Security action refused')
    expect(compared()).toBe(0)
    expect(sqlOf().some((sql) => sql === 'ROLLBACK')).toBe(true)
    const slowAt = calls.findIndex((call) => call.sql === 'SELECT slow')
    const rollbackAt = calls.findIndex((call) => call.sql === 'ROLLBACK')
    const commitBeforeRollback = calls.findIndex((call, index) => index > slowAt && index < rollbackAt && call.sql === 'COMMIT')
    expect(rollbackAt).toBeGreaterThan(slowAt)
    expect(commitBeforeRollback).toBe(-1)
  })

  it('rejects a query retained after the step returns without sending it', async () => {
    let retained: Queryable | null = null
    const { promise } = attempt({
      readInputs: async (tx) => {
        retained = tx
        await tx.query('SELECT read_inputs')
        return { passwordHash: HASH }
      },
    })
    await promise
    const before = calls.length
    await expect(retained!.query('SELECT later')).rejects.toThrow('Security action refused')
    expect(calls).toHaveLength(before)
  })

  it('rejects transaction control and advisory unlock from a step', async () => {
    const { promise } = attempt({
      readInputs: async (tx) => {
        await expect(tx.query('BEGIN')).rejects.toThrow('Security action refused')
        await expect(tx.query('COMMIT')).rejects.toThrow('Security action refused')
        await expect(tx.query('SELECT pg_advisory_unlock(1)')).rejects.toThrow('Security action refused')
        return { passwordHash: HASH }
      },
    })
    await expect(promise).resolves.toEqual({ kind: 'issued' })
    expect(calls.filter((call) => call.sql === 'BEGIN').length).toBeGreaterThan(0)
    expect(calls.some((call) => call.sql === 'SELECT pg_advisory_unlock(1)')).toBe(false)
  })
})

describe('loss and cleanup', () => {
  it('returns the accounting result when a later latch release is uncertain', async () => {
    beforeQuery = (sql, _params, client) => {
      if (client.id === 1 && sql.includes('_release')) return sqlError('40001')
      return undefined
    }
    const { promise } = attempt()
    await expect(promise).resolves.toEqual({ kind: 'issued' })
    expect(compared()).toBe(1)
    expect(clients.length).toBeGreaterThanOrEqual(1)
    const cleanupRelease = calls.find((call) => call.client > 1 && call.sql.includes('_release'))
    const ownerAcquire = calls.find((call) => call.sql.includes('_acquire'))
    expect(ownerAcquire?.params?.[1]).toMatch(/^[0-9a-f]{64}$/)
    expect(cleanupRelease?.params?.[1]).toBe(ownerAcquire?.params?.[1])
  })

  it('discards the client when the exact unlock does not return true', async () => {
    unlocked = false
    const { promise } = attempt()
    await expect(promise).resolves.toEqual({ kind: 'issued' })
    expect(releases.some((release) => release.discard)).toBe(true)
    expect(releases.every((release) => release.discard)).toBe(true)
  })

  it('cleans up the original token only after a paused comparison settles', async () => {
    let finish: (value: boolean) => void = () => undefined
    bcryptHook.compare.mockImplementation(() => new Promise<boolean>((resolve) => {
      finish = resolve
    }))
    const { promise } = attempt()
    await waitFor(() => compared() === 1)
    expect(sqlOf().some((sql) => sql.includes('_release'))).toBe(false)
    expect(clients).toHaveLength(1)
    clients[0].emit('error', new Error('backend exited'))
    await flush()
    expect(clients).toHaveLength(1)
    expect(sqlOf().some((sql) => sql.includes('_release'))).toBe(false)
    finish(true)
    await expect(promise).rejects.toThrow('Security action refused')
    expect(compared()).toBe(1)
    expect(sqlOf().some((sql) => sql === 'SELECT account')).toBe(false)
    const releaseAt = releases.findIndex((release) => release.client === 1)
    const cleanupConnect = clients.findIndex((client) => client.id === 2)
    expect(releaseAt).toBeGreaterThanOrEqual(0)
    expect(cleanupConnect).toBeGreaterThanOrEqual(0)
    expect(releases[0]).toEqual({ client: 1, discard: true })
    const ownerToken = calls.find((call) => call.sql.includes('_acquire'))?.params?.[1]
    const cleanup = calls.filter((call) => call.client === 2)
    expect(cleanup.some((call) => call.sql.includes('pg_advisory_lock('))).toBe(true)
    expect(cleanup.find((call) => call.sql.includes('_release'))?.params).toEqual([SESSION, ownerToken])
    expect(cleanup.some((call) => call.sql.includes('FROM users') || call.sql.includes('security_action_challenges'))).toBe(false)
    const lockAt = cleanup.findIndex((call) => call.sql.includes('pg_advisory_lock('))
    const deleteAt = cleanup.findIndex((call) => call.sql.includes('_release'))
    expect(lockAt).toBeGreaterThanOrEqual(0)
    expect(deleteAt).toBeGreaterThan(lockAt)
  })

  it('does not compare when the claim commit is lost and cleans up with the same token', async () => {
    let seenCommits = 0
    beforeQuery = (sql, _params, client) => {
      if (sql !== 'COMMIT' || client.id !== 1) return undefined
      seenCommits += 1
      if (seenCommits === 2) return 'lose'
      return undefined
    }
    const { promise } = attempt()
    await expect(promise).rejects.toThrow('Security action refused')
    expect(compared()).toBe(0)
    const token = calls.find((call) => call.sql.includes('_acquire'))?.params?.[1]
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(calls.find((call) => call.client === 2 && call.sql.includes('_release'))?.params?.[1]).toBe(token)
    expect(JSON.stringify(calls)).not.toContain(PASSWORD)
    expect(JSON.stringify(calls)).not.toContain(HASH)
  })

  it('does not compare when the session lock commit is lost, then serializes the original token', async () => {
    beforeQuery = (sql, _params, client) => (client.id === 1 && sql === 'COMMIT' ? 'lose' : undefined)
    const { promise } = attempt()
    await expect(promise).rejects.toThrow('Security action refused')
    expect(compared()).toBe(0)
    expect(sqlOf(1).some((sql) => sql.includes('_acquire'))).toBe(false)
    const cleanupToken = calls.find((call) => call.client === 2 && call.sql.includes('_release'))?.params?.[1]
    expect(cleanupToken).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps a known domain refusal when owner cleanup is uncertain', async () => {
    const refusal = new DomainRefusal('SECURITY_ACTION_METHOD_UNAVAILABLE')
    beforeQuery = (sql, _params, client) => (client.id === 1 && sql.includes('_release') ? 'lose' : undefined)
    const { promise } = attempt({
      readInputs: async () => {
        throw refusal
      },
    })
    await expect(promise).rejects.toBe(refusal)
    expect(compared()).toBe(0)
  })

  it('does not return an accounting value when that commit acknowledgement is lost', async () => {
    let seenCommits = 0
    beforeQuery = (sql, _params, client) => {
      if (sql !== 'COMMIT' || client.id !== 1) return undefined
      seenCommits += 1
      if (seenCommits === 4) return 'lose'
      return undefined
    }
    const { promise } = attempt()
    await expect(promise).rejects.toThrow('Security action refused')
    expect(compared()).toBe(1)
    expect(sqlOf().some((sql) => sql === 'SELECT account')).toBe(true)
    expect(calls.filter((call) => call.sql.includes('security_action_challenges'))).toHaveLength(0)
  })

  it('treats a known lock timeout as unavailable without a comparison or a discard', async () => {
    beforeQuery = (sql) => (sql.includes('pg_advisory_lock(') ? sqlError('55P03') : undefined)
    const { promise } = attempt()
    await expect(promise).rejects.toThrow('Security action refused')
    expect(compared()).toBe(0)
    expect(sqlOf().some((sql) => sql.includes('_acquire') || sql.includes('_release'))).toBe(false)
    expect(clients).toHaveLength(1)
    expect(releases).toEqual([{ client: 1, discard: false }])
  })

  it('does not compare when the snapshot has no password hash, and releases the owned token', async () => {
    const { promise } = attempt({
      readInputs: async () => ({ passwordHash: '' }),
    })
    await expect(promise).rejects.toThrow('Security action refused')
    expect(compared()).toBe(0)
    expect(sqlOf().some((sql) => sql.includes('_release'))).toBe(true)
  })
})

describe('query rejection while the read is still waiting', () => {
  it('rejects an unawaited read query before the read returns, with an acknowledged rollback and no comparison', async () => {
    const slow = hang()
    const hold = hang()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    beforeQuery = (sql) => (sql === 'SELECT slow' ? { hang: slow.hang } : undefined)
    const { promise } = attempt({
      readInputs: async (tx) => {
        void tx.query('SELECT slow')
        await hold.hang
        return { passwordHash: HASH }
      },
    })
    try {
      await waitFor(() => calls.some((call) => call.sql === 'SELECT slow'))
      slow.gate.reject(sqlError('23505'))
      await flush()
      await flush()
      expect(unhandled).toEqual([])
      hold.gate.resolve({ rows: [], rowCount: 0 })
      await expect(promise).rejects.toThrow('Security action refused')
      expect(compared()).toBe(0)
      expect(sqlOf().some((sql) => sql === 'SELECT account')).toBe(false)
      expect(sqlOf().some((sql) => sql === 'ROLLBACK')).toBe(true)
      const slowAt = calls.findIndex((call) => call.sql === 'SELECT slow')
      const rollbackAt = calls.findIndex((call) => call.sql === 'ROLLBACK')
      const commitBeforeRollback = calls.findIndex((call, index) => index > slowAt && index < rollbackAt && call.sql === 'COMMIT')
      expect(rollbackAt).toBeGreaterThan(slowAt)
      expect(commitBeforeRollback).toBe(-1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
      slow.gate.reject(sqlError('23505'))
      hold.gate.resolve({ rows: [], rowCount: 0 })
      await promise.catch(() => undefined)
    }
  })
})

describe('lost checkout while the comparison is paused', () => {
  function installSingleSlot(): void {
    let busy = false
    const waiting: Array<() => void> = []
    hook.connect = async () => {
      if (busy) await new Promise<void>((resolve) => { waiting.push(resolve) })
      busy = true
      const client = new FakeClient(++nextId)
      clients.push(client)
      const release = client.release.bind(client)
      client.release = (error?: Error | boolean) => {
        release(error)
        busy = false
        waiting.shift()?.()
      }
      return client
    }
  }

  it.each([
    ['error', 'true'],
    ['error', 'false'],
    ['error', 'error'],
    ['end', 'true'],
    ['end', 'false'],
    ['end', 'error'],
  ] as const)('discards the owned client when it emits %s during a paused comparison, serves another session, and cleans the original token only after the comparison %s', async (signal, outcome) => {
    installSingleSlot()
    const parked: Array<{ resolve: (value: boolean) => void; reject: (error: Error) => void }> = []
    let settled = false
    bcryptHook.compare.mockImplementation(() => {
      if (parked.length === 0) {
        return new Promise<boolean>((resolve, reject) => { parked.push({ resolve, reject }) })
      }
      return Promise.resolve(true)
    })
    const releaseCompare = () => {
      if (settled) return
      settled = true
      const gate = parked[0]
      if (!gate) {
        bcryptHook.compare.mockResolvedValue(true)
        return
      }
      if (outcome === 'error') gate.reject(new Error('compare failed'))
      else gate.resolve(outcome === 'true')
    }
    const owner = attempt({ sessionId: 'sid-loss-owner' })
    let other: ReturnType<typeof attempt> | undefined
    try {
      await waitFor(() => compared() === 1 && clients.length === 1)
      const ownerToken = calls.find((call) => call.client === 1 && call.sql.includes('_acquire'))?.params?.[1]
      expect(ownerToken).toMatch(/^[0-9a-f]{64}$/)
      if (signal === 'error') clients[0].emit('error', new Error('backend exited'))
      else clients[0].emit('end')
      await flush()
      expect(releases.filter((item) => item.client === 1)).toEqual([{ client: 1, discard: true }])
      expect(calls.some((call) => call.params?.[0] === 'sid-loss-owner' && String(call.sql).includes('_release'))).toBe(false)
      expect(sqlOf(1).some((sql) => sql === 'SELECT account')).toBe(false)
      expect(clients).toHaveLength(1)
      other = attempt({ sessionId: 'sid-loss-other' })
      await waitFor(() => clients.length >= 2)
      expect(calls.some((call) => call.params?.[0] === 'sid-loss-owner' && String(call.sql).includes('_release'))).toBe(false)
      expect(sqlOf(1).some((sql) => sql === 'SELECT account')).toBe(false)
      await expect(other.promise).resolves.toEqual({ kind: 'issued' })
      expect(calls.some((call) => call.params?.[0] === 'sid-loss-owner' && String(call.sql).includes('_release'))).toBe(false)
      expect(releases.filter((item) => item.client === 1)).toEqual([{ client: 1, discard: true }])
      releaseCompare()
      await expect(owner.promise).rejects.toThrow('Security action refused')
      expect(sqlOf(1).some((sql) => sql === 'SELECT account')).toBe(false)
      expect(releases.filter((item) => item.client === 1)).toEqual([{ client: 1, discard: true }])
      const cleanup = calls.filter((call) => call.params?.[0] === 'sid-loss-owner' && call.sql.includes('_release'))
      expect(cleanup).toHaveLength(1)
      expect(cleanup[0]?.params?.[1]).toBe(ownerToken)
      expect(cleanup[0]?.client).not.toBe(1)
      expect(sqlOf(cleanup[0]?.client).some((sql) => sql.includes('FROM users') || sql.includes('security_action_challenges') || sql === 'SELECT account')).toBe(false)
    } finally {
      releaseCompare()
      await owner.promise.catch(() => undefined)
      if (other) await other.promise.catch(() => undefined)
    }
  })

  it('discards the owned checkout when an unawaited read query rejects with a non-SQLSTATE read timeout and no client event, serves another session, and cleans the original token only after the read returns', async () => {
    installSingleSlot()
    const slow = hang()
    const hold = hang()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    let slowSettled = false
    beforeQuery = (sql) => (sql === 'SELECT slow' ? { hang: slow.hang } : undefined)
    const owner = attempt({
      sessionId: 'sid-loss-owner',
      readInputs: async (tx) => {
        void tx.query('SELECT slow')
        await hold.hang
        return { passwordHash: HASH }
      },
    })
    let other: ReturnType<typeof attempt> | undefined
    const rejectSlow = () => {
      if (slowSettled) return
      slowSettled = true
      slow.gate.reject(new Error('Query read timeout'))
    }
    const releaseHold = () => {
      hold.gate.resolve({ rows: [], rowCount: 0 })
    }
    try {
      await waitFor(() => calls.some((call) => call.sql === 'SELECT slow'))
      const ownerToken = calls.find((call) => call.client === 1 && call.sql.includes('_acquire'))?.params?.[1]
      expect(ownerToken).toMatch(/^[0-9a-f]{64}$/)
      rejectSlow()
      await flush()
      await flush()
      expect(unhandled).toEqual([])
      expect(releases.filter((item) => item.client === 1)).toEqual([{ client: 1, discard: true }])
      expect(compared()).toBe(0)
      expect(sqlOf(1).some((sql) => sql === 'SELECT account')).toBe(false)
      expect(calls.some((call) => call.params?.[0] === 'sid-loss-owner' && String(call.sql).includes('_release'))).toBe(false)
      expect(clients).toHaveLength(1)
      other = attempt({ sessionId: 'sid-loss-other' })
      await expect(other.promise).resolves.toEqual({ kind: 'issued' })
      expect(compared()).toBe(1)
      expect(sqlOf(1).some((sql) => sql === 'SELECT account')).toBe(false)
      expect(calls.some((call) => call.params?.[0] === 'sid-loss-owner' && String(call.sql).includes('_release'))).toBe(false)
      expect(releases.filter((item) => item.client === 1)).toEqual([{ client: 1, discard: true }])
      releaseHold()
      await expect(owner.promise).rejects.toThrow('Security action refused')
      expect(compared()).toBe(1)
      expect(sqlOf(1).some((sql) => sql === 'SELECT account')).toBe(false)
      expect(releases.filter((item) => item.client === 1)).toEqual([{ client: 1, discard: true }])
      const cleanup = calls.filter((call) => call.params?.[0] === 'sid-loss-owner' && call.sql.includes('_release'))
      expect(cleanup).toHaveLength(1)
      expect(cleanup[0]?.params?.[1]).toBe(ownerToken)
      expect(cleanup[0]?.client).not.toBe(1)
      expect(sqlOf(cleanup[0]?.client).some((sql) => sql.includes('FROM users') || sql.includes('security_action_challenges') || sql === 'SELECT account')).toBe(false)
      expect(JSON.stringify(calls)).not.toContain(PASSWORD)
      expect(JSON.stringify(calls)).not.toContain(HASH)
    } finally {
      process.off('unhandledRejection', onUnhandled)
      if (!slowSettled) {
        if (calls.some((call) => call.sql === 'SELECT slow')) rejectSlow()
        else slow.gate.resolve({ rows: [], rowCount: 0 })
      }
      releaseHold()
      await owner.promise.catch(() => undefined)
      if (other) await other.promise.catch(() => undefined)
    }
  })
})

describe('selected namespace shape', () => {
  it('refuses a catalog row in information_schema or a temporary schema before acquire or compare', async () => {
    for (const schemaName of ['information_schema', 'pg_temp_3']) {
      calls = []
      releases = []
      clients = []
      nextId = 0
      bcryptHook.compare.mockClear()
      beforeQuery = (sql) => (
        sql.includes('pg_catalog.pg_class')
          ? { rows: [catalogRow({ schema_name: schemaName })], rowCount: 1 }
          : undefined
      )
      await expect(attempt().promise).rejects.toThrow('Security action refused')
      expect(compared()).toBe(0)
      expect(calls.some((call) => call.sql.includes('_acquire'))).toBe(false)
    }
  })

  it('does not accept an unscoped public latch row when the selected application schema has none', async () => {
    beforeQuery = (sql, params) => {
      if (sql.includes('current_schemas')) return { rows: [{ schema_name: 'sa_owned' }], rowCount: 1 }
      if (sql.includes('pg_catalog.pg_class')) {
        const scoped = sql.includes('sa_owned') || params.includes('sa_owned')
        if (scoped) return { rows: [], rowCount: 0 }
        return { rows: [catalogRow({ schema_name: 'public' })], rowCount: 1 }
      }
      return undefined
    }
    await expect(attempt().promise).rejects.toThrow('Security action refused')
    expect(compared()).toBe(0)
    expect(calls.some((call) => call.sql.includes('_acquire'))).toBe(false)
  })

  it('refuses an unsupported relation in the selected schema before acquire or compare', async () => {
    for (const fault of [{ relkind: 'v' }, { relpersistence: 't' }, { rel_oid: '0' }]) {
      calls = []
      releases = []
      clients = []
      nextId = 0
      bcryptHook.compare.mockClear()
      beforeQuery = (sql) => (
        sql.includes('pg_catalog.pg_class')
          ? { rows: [catalogRow(fault)], rowCount: 1 }
          : undefined
      )
      await expect(attempt().promise).rejects.toThrow('Security action refused')
      expect(compared()).toBe(0)
      expect(calls.some((call) => call.sql.includes('_acquire'))).toBe(false)
    }
  })

  it('does not ask the catalog again when the cleanup connection deletes the original token', async () => {
    let finish: (value: boolean) => void = () => undefined
    bcryptHook.compare.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve }))
    const { promise } = attempt()
    try {
      await waitFor(() => compared() === 1)
      clients[0].emit('error', new Error('backend exited'))
      finish(true)
      await expect(promise).rejects.toThrow('Security action refused')
      const lookups = calls.filter((call) => call.sql.includes('pg_catalog.pg_class'))
      expect(lookups).toHaveLength(1)
      expect(lookups[0]?.client).toBe(1)
    } finally {
      finish(true)
      await promise.catch(() => undefined)
    }
  })

  it('names the first explicit application schema in the admission and migration source text', () => {
    const admission = parsed('security-action-attempt-admission.ts', SOURCE)
    const migration = parsed('security-action-session-flight.ts', MIGRATION)
    const resolveSchema = functionNamed(admission, 'resolveSchema')
    const cleanup = functionNamed(admission, 'cleanupConnection')
    const locate = functionNamed(migration, 'locateRelation')
    const migrateUp = functionNamed(migration, 'up')
    const migrateDown = functionNamed(migration, 'down')
    const currentSchema = functionNamed(migration, 'currentSchema')
    const assertCaller = functionNamed(migration, 'assertCallerTransaction')
    expect(resolveSchema).toBeDefined()
    expect(cleanup).toBeDefined()
    expect(locate).toBeDefined()
    expect(migrateUp).toBeDefined()
    expect(migrateDown).toBeDefined()
    expect(currentSchema).toBeDefined()
    expect(assertCaller).toBeDefined()
    expect(literalStart(resolveSchema!, 'current_schemas(false)')).toBeDefined()
    expect(literalStart(resolveSchema!, 'information_schema')).toBeDefined()
    expect(identifierNames(resolveSchema!).has('relkind')).toBe(true)
    expect(identifierNames(resolveSchema!).has('relpersistence')).toBe(true)
    expect(hasExactString(resolveSchema!, 'r')).toBe(true)
    expect(hasExactString(resolveSchema!, 'p')).toBe(true)
    expect(templateText(resolveSchema!)).not.toContain("relkind = 'r'")
    expect(templateText(resolveSchema!)).not.toContain("relpersistence = 'p'")
    expect(literalStart(cleanup!, 'pg_class')).toBeUndefined()
    expect(literalStart(cleanup!, 'current_schemas')).toBeUndefined()
    expect(callStart(cleanup!, 'resolveSchema')).toBeUndefined()
    expect(callStart(cleanup!, 'currentSchema')).toBeUndefined()
    expect(callStart(locate!, 'currentSchema')).toBeDefined()
    expect(literalStart(currentSchema!, 'current_schemas(false)')).toBeDefined()
    expect(literalStart(currentSchema!, 'information_schema')).toBeDefined()
    expect(identifierNames(locate!).has('relkind')).toBe(true)
    expect(identifierNames(locate!).has('relpersistence')).toBe(true)
    expect(hasExactString(locate!, 'r')).toBe(true)
    expect(hasExactString(locate!, 'p')).toBe(true)
    expect(templateText(locate!)).not.toContain("relkind = 'r'")
    expect(templateText(locate!)).not.toContain("relpersistence = 'p'")
    expect(callStart(migrateUp!, 'currentSchema')).toBeDefined()
    expect(literalStart(migrateUp!, 'current_schemas(false)')).toBeUndefined()
    const isolation = literalStart(assertCaller!, 'transaction_isolation')
    const caller = callStart(migrateDown!, 'assertCallerTransaction')
    const located = callStart(migrateDown!, 'locateRelation')
    const exclusive = literalStart(migrateDown!, 'ACCESS EXCLUSIVE')
    const exists = literalStart(migrateDown!, 'SELECT EXISTS')
    const drop = literalStart(migrateDown!, 'DROP TABLE')
    expect(isolation).toBeDefined()
    expect(literalStart(migrateDown!, 'transaction_isolation')).toBeUndefined()
    expect(caller).toBeLessThan(located!)
    expect(located).toBeLessThan(exclusive!)
    expect(exclusive).toBeLessThan(exists!)
    expect(exists).toBeLessThan(drop!)
    expect(literalStart(migrateDown!, 'COMMIT')).toBeUndefined()
  })
})

describe('static binding', () => {
  it('keeps the comparison and the latch statements in the admission module', () => {
    expect(SOURCE.split('bcrypt.compare(')).toHaveLength(2)
    expect(SOURCE).toContain('security_action_session_flight')
    expect(SOURCE).not.toContain('security_action_challenges')
    expect(SOURCE).not.toContain('DELETE FROM users')
    expect(SOURCE).not.toContain('pg_advisory_unlock_all')
    expect(exportedRuntimeValueNames(SOURCE)).toEqual(['runOwnedAttempt'])
    expect(exportedAsyncFunctionNames(SOURCE)).toEqual(['runOwnedAttempt'])
    const proof = parsed('security-action-proof.ts', PROOF)
    const issue = functionNamed(proof, 'issue')
    expect(issue).toBeDefined()
    const issueNames = identifierNames(issue!)
    expect(issueNames.has('runOwnedAttempt')).toBe(true)
    expect(issueNames.has('runTransaction')).toBe(false)
    expect(issueNames.has('verifyPassword')).toBe(false)
    const bindings = productionBindings(proof)
    expect(bindings).toBeDefined()
    expect(bindings!.get('runOwnedAttempt')).toBe('runOwnedAttempt')
    expect(bindings!.has('runTransaction')).toBe(false)
    expect(bindings!.has('verifyPassword')).toBe(false)
  })
})
