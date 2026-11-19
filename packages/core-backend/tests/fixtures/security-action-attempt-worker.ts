/**
 * One OS process for a real security-action attempt. The parent supplies the database url and the
 * attempt inputs. This process loads the product pool and the real admission entry. Each attempt
 * prints one JSON result line and nothing else about the password, the proof or the owner token.
 * The closed audit mode prints one trace line before that same result line.
 * The closed audit-fault mode may print one commit-gate line before that trace.
 */
import { createHash } from 'node:crypto'
import type { Request } from 'express'
import { Pool, type PoolClient } from 'pg'
import { authService } from '../../src/auth/AuthService'
import { SECURITY_ACTION_POLICY_REVISION, SECURITY_ACTION_PURPOSE_REGISTRY, SECURITY_ACTION_PURPOSES } from '../../src/auth/external-login-assurance'
import type { SecurityActionPurpose } from '../../src/auth/external-login-assurance'
import { runOwnedAttempt } from '../../src/auth/security-action-attempt-admission'
import { AuditRepository, type AuditLogData } from '../../src/audit/AuditRepository'
import {
  createSecurityActionProofService,
  readAuthenticatedSessionContext,
  SecurityActionProofError,
} from '../../src/auth/security-action-proof'
import type { AuthenticatedSessionContext, SecurityActionAuditEvent, SecurityActionTargetResolver, SecurityActionVerifyRequest } from '../../src/auth/security-action-proof'
import { pool } from '../../src/db/pg'
import { poolManager } from '../../src/integration/db/connection-pool'

const IDENT = /^[a-z_][a-z0-9_]*$/

function write(value: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, () => resolve())
  })
}

function contextOf(userId: string, sid: string, org: string): AuthenticatedSessionContext {
  const token = authService.createToken(
    { id: userId, email: null, name: userId, role: 'user', permissions: [], created_at: new Date(), updated_at: new Date(), tenantId: org },
    { sid },
  )
  const req = { user: { id: userId }, authenticatedTenantId: org, headers: { authorization: `Bearer ${token}` } } as unknown as Request
  const context = readAuthenticatedSessionContext(req)
  if (!context) throw new Error('context')
  return context
}

function resolver(purpose: SecurityActionPurpose): SecurityActionTargetResolver {
  const revision = process.env.SA_REVISION ?? 'r1'
  return async (_executor, request) => ({
    ok: true,
    kind: SECURITY_ACTION_PURPOSE_REGISTRY[purpose].targetKind,
    witness: createHash('sha256').update(JSON.stringify([purpose, request, revision])).digest('hex'),
  })
}

async function issue(): Promise<void> {
  const userId = process.env.SA_USER_ID ?? ''
  const sid = process.env.SA_SESSION_ID ?? ''
  const org = process.env.SA_ORG_ID ?? ''
  const purpose = (process.env.SA_PURPOSE ?? 'external_identity_unbind') as SecurityActionPurpose
  const connectionId = process.env.SA_CONNECTION_ID ?? ''
  const targetIdentityId = process.env.SA_TARGET_IDENTITY_ID ?? ''
  const revision = Number(process.env.SA_BINDING_REVISION ?? '2')
  const password = process.env.SA_PASSWORD ?? ''
  const resolvers = Object.fromEntries(SECURITY_ACTION_PURPOSES.map((item) => [item, resolver(item)])) as Record<SecurityActionPurpose, SecurityActionTargetResolver>
  const service = createSecurityActionProofService({
    isPurposeAvailable: () => true,
    resolvers,
    runOwnedAttempt,
    recordAudit: async () => undefined,
    policyRevision: SECURITY_ACTION_POLICY_REVISION,
  })
  const body: SecurityActionVerifyRequest = purpose === 'external_identity_bind'
    ? { purpose, connectionId, method: 'local_password', password }
    : { purpose, connectionId, targetIdentityId, expectedBindingRevision: revision, method: 'local_password', password }
  try {
    const issued = await service.issue(contextOf(userId, sid, org), body)
    await write({ event: 'result', ok: true, ttlSeconds: issued.ttlSeconds, status: 200 })
  } catch (error) {
    const code = error instanceof SecurityActionProofError ? error.code : 'SECURITY_ACTION_UNAVAILABLE'
    const status = error instanceof SecurityActionProofError ? error.status : 503
    await write({ event: 'result', ok: false, code, status })
  }
}

type Slot = 'primary' | 'other' | 'holder' | 'waiter'

function slotFrom(value: string | undefined, fallback: Slot): Slot {
  if (value === undefined || value === '') return fallback
  if (value === 'primary' || value === 'other' || value === 'holder' || value === 'waiter') return value
  throw new Error('slot')
}

async function waitForAdvisory(key: string | undefined): Promise<void> {
  if (!key) return
  const gate = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 })
  try {
    await gate.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1::text, 0))', [key])
    await gate.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1::text, 0))', [key])
  } finally {
    await gate.end()
  }
}

async function runAttempt(sessionId: string, slot: Slot): Promise<void> {
  const schema = process.env.SA_SCHEMA ?? ''
  const password = process.env.SA_PASSWORD ?? ''
  const hash = process.env.SA_PASSWORD_HASH ?? ''
  if (schema && !IDENT.test(schema)) {
    await write({ event: 'owned', ok: false, name: 'AttemptUnavailable', slot, workerPid: process.pid })
    return
  }
  try {
    const outcome = await runOwnedAttempt(sessionId, password, {
      readInputs: async (tx) => {
        const pid = Number((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
        if (schema) {
          const updated = await tx.query(
            `UPDATE "${schema}".security_action_attempt_session SET read_pid = $2 WHERE slot = $1 AND read_pid IS NULL`,
            [slot, pid],
          )
          if (updated.rowCount !== 1) throw new Error('session row')
        }
        await write({ event: 'read', slot, workerPid: process.pid, backendPid: pid })
        await waitForAdvisory(process.env.SA_READ_GATE)
        return { passwordHash: hash, pid }
      },
      account: async (tx, snapshot, verified) => {
        const pid = Number((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)
        if (schema) {
          const updated = await tx.query(
            `UPDATE "${schema}".security_action_attempt_session SET account_pid = $2, verified = $3 WHERE slot = $1 AND read_pid IS NOT NULL`,
            [slot, pid, verified],
          )
          if (updated.rowCount !== 1) throw new Error('session row')
          await tx.query(`INSERT INTO "${schema}".security_action_attempt_effect (slot) VALUES ($1)`, [slot])
        }
        return { verified, sameBackend: pid === snapshot.pid }
      },
    })
    await write({ event: 'owned', ok: true, verified: outcome.verified === true, sameBackend: outcome.sameBackend === true, slot, workerPid: process.pid })
  } catch (error) {
    await write({ event: 'owned', ok: false, name: error instanceof Error ? error.name : 'Error', slot, workerPid: process.pid })
  }
}

async function owned(): Promise<void> {
  await waitForAdvisory(process.env.SA_START_GATE)
  await runAttempt(process.env.SA_SESSION_ID ?? '', slotFrom(process.env.SA_SLOT, 'primary'))
}

async function capacity(): Promise<void> {
  const schema = process.env.SA_SCHEMA ?? ''
  if (schema && !IDENT.test(schema)) {
    failed = true
    await write({ event: 'crash' })
    return
  }
  await Promise.all([
    runAttempt(process.env.SA_SESSION_ID ?? '', 'primary'),
    runAttempt(process.env.SA_SESSION_ID_OTHER ?? '', 'other'),
  ])
}

type Release = (err?: Error | boolean) => unknown
type ConnectCallback = (err: Error | undefined, client: PoolClient | undefined, done: Release) => void
type AuditStep = {
  kind: 'checkout' | 'release' | 'audit-entry' | 'insert' | 'terminal'
  ordinal?: number
  pid?: number
  form?: 'promise' | 'callback'
  open?: number
  duringAudit?: boolean
  total?: number
  idle?: number
  waiting?: number
  ok?: boolean
  sqlstate?: string | null
  constraint?: boolean
  queryConfig?: boolean
  attempt?: number
  discard?: boolean
}
type AuditTrace = {
  open: number
  ordinal: number
  steps: AuditStep[]
  auditAttempts: number
  insertAttempts: number
  partitionHeal: number
  maxTotal: number
  inAudit: boolean
  ownerLoss: boolean
}

function readCompareCount(): number {
  const read = (globalThis as Record<symbol, unknown>)[Symbol.for('metasheet.security-action-audit-bcrypt-count')]
  if (typeof read !== 'function') throw new Error('compare observer missing')
  const count = read()
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new Error('compare observer missing')
  return count
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

function sqlText(config: unknown): { text: string; queryConfig: boolean } {
  if (typeof config === 'string') return { text: config, queryConfig: false }
  if (typeof config === 'object' && config !== null && 'text' in config && typeof (config as { text?: unknown }).text === 'string') {
    return { text: (config as { text: string }).text, queryConfig: true }
  }
  return { text: '', queryConfig: false }
}

function sqlStateOf(error: unknown): { code: string | null; constraint: boolean } {
  if (typeof error !== 'object' || error === null) return { code: null, constraint: false }
  const code = 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : null
  const constraint = 'constraint' in error && typeof (error as { constraint?: unknown }).constraint === 'string' && (error as { constraint: string }).constraint.length > 0
  return { code, constraint }
}

function auditDataOf(event: SecurityActionAuditEvent): AuditLogData {
  const parsedUserId = Number(event.meta.userId)
  return {
    eventType: event.action.toUpperCase(),
    eventCategory: 'SYSTEM',
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    userId: Number.isFinite(parsedUserId) ? parsedUserId : undefined,
    actionDetails: {
      userId: event.meta.userId,
      purpose: event.meta.purpose,
      method: event.meta.method,
      result: event.meta.result,
      code: event.meta.code,
      connectionId: event.meta.connectionId,
      privilegeClass: event.meta.privilegeClass,
    },
  }
}

const NATIVE_DUPLICATE_RELEASE = 'Release called on client which has already been released to the pool.'

function acquiredTrue(result: unknown): boolean {
  if (!result || typeof result !== 'object' || !('rows' in result)) return false
  const rows = (result as { rows?: unknown }).rows
  if (!Array.isArray(rows) || rows.length === 0 || !rows[0] || typeof rows[0] !== 'object') return false
  return (rows[0] as { acquired?: unknown }).acquired === true
}

function waitForReleaseAck(): Promise<void> {
  return new Promise((resolve) => {
    let buffer = ''
    const onData = (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.startsWith('{')) continue
        try {
          const value = JSON.parse(line) as { event?: unknown }
          if (value.event !== 'release-ack') continue
          process.stdin.off('data', onData)
          resolve()
          return
        } catch {
          // A line that is not the release ack stays ignored.
        }
      }
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
    process.stdin.resume()
  })
}

function installProductPoolTrace(product: Pool, fault = false): { trace: AuditTrace; usedRelease: () => Release | null } {
  const trace: AuditTrace = { open: 0, ordinal: 0, steps: [], auditAttempts: 0, insertAttempts: 0, partitionHeal: 0, maxTotal: 0, inAudit: false, ownerLoss: false }
  let used: Release | null = null
  let ownerPid = 0
  let ownerArmed = false
  let lossNoted = false
  let resolveLoss: () => void = () => undefined
  const lossDelivered = new Promise<void>((resolve) => { resolveLoss = resolve })
  const noteOwnerLoss = () => {
    trace.ownerLoss = true
    if (lossNoted) return
    lossNoted = true
    resolveLoss()
  }
  if (fault) product.on('error', noteOwnerLoss)
  const savedConnect = product.connect.bind(product) as (...args: unknown[]) => unknown
  const seenQueries = new WeakSet<PoolClient>()
  const noteCapacity = () => {
    trace.maxTotal = Math.max(trace.maxTotal, product.totalCount)
  }
  const completeRelease = (ordinal: number, pid: number, err?: unknown) => {
    trace.open -= 1
    noteCapacity()
    const step: AuditStep = {
      kind: 'release', ordinal, pid, open: trace.open, duringAudit: trace.inAudit,
      total: product.totalCount, idle: product.idleCount, waiting: product.waitingCount,
    }
    if (err) step.discard = true
    trace.steps.push(step)
  }
  const observeQueries = (client: PoolClient, gateOwner: boolean) => {
    if (seenQueries.has(client)) return
    seenQueries.add(client)
    const savedQuery = client.query.bind(client) as (...args: unknown[]) => unknown
    let acquireSeen = false
    let held = false
    const noteQuery = (kind: 'insert' | 'heal' | 'other', error: unknown, queryConfig: boolean) => {
      if (kind === 'heal') return
      if (kind !== 'insert') return
      const parsed = sqlStateOf(error)
      trace.steps.push({
        kind: 'insert', ok: error == null, sqlstate: parsed.code, constraint: parsed.constraint, queryConfig,
        duringAudit: trace.inAudit, open: trace.open,
      })
    }
    const deliverCommit = async (result: unknown) => {
      if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error('pid')
      const ack = waitForReleaseAck()
      await write({ event: 'commit-gate', pid: ownerPid })
      await ack
      if (!trace.ownerLoss) await lossDelivered
      return result
    }
    ;(client as { query: (...args: unknown[]) => unknown }).query = (...queryArgs: unknown[]) => {
      const observed = sqlText(queryArgs[0])
      const kind = /INSERT\s+INTO\s+audit_logs\b/i.test(observed.text)
        ? 'insert'
        : (/PARTITION\s+OF\s+audit_logs\b/i.test(observed.text) || /audit_logs_partition/i.test(observed.text) ? 'heal' : 'other')
      if (kind === 'insert') trace.insertAttempts += 1
      if (kind === 'heal') trace.partitionHeal += 1
      const callbackIndex = queryArgs.findIndex((arg) => typeof arg === 'function')
      if (callbackIndex >= 0) {
        const args = queryArgs.slice()
        const originalCallback = args[callbackIndex] as (err: Error | undefined, result?: unknown) => void
        args[callbackIndex] = (err: Error | undefined, result?: unknown) => {
          noteQuery(kind, err ?? null, observed.queryConfig)
          originalCallback(err, result)
        }
        try {
          return savedQuery(...args)
        } catch (error) {
          noteQuery(kind, error, observed.queryConfig)
          throw error
        }
      }
      try {
        const pending = savedQuery(...queryArgs)
        if (!isThenable(pending)) return pending
        return pending.then((result) => {
          noteQuery(kind, null, observed.queryConfig)
          if (!gateOwner || held) return result
          if (!acquireSeen && /security_action_session_flight_acquire\b/.test(observed.text) && acquiredTrue(result)) {
            acquireSeen = true
            return result
          }
          if (acquireSeen && /^\s*COMMIT\b/i.test(observed.text)) {
            held = true
            return deliverCommit(result)
          }
          return result
        }, (error: unknown) => {
          noteQuery(kind, error, observed.queryConfig)
          throw error
        })
      } catch (error) {
        noteQuery(kind, error, observed.queryConfig)
        throw error
      }
    }
  }
  const arm = async (client: PoolClient, form: 'promise' | 'callback'): Promise<PoolClient> => {
    const gateOwner = fault && form === 'promise' && !ownerArmed
    if (gateOwner) {
      ownerArmed = true
      client.on('error', noteOwnerLoss)
      client.on('end', noteOwnerLoss)
    }
    const original = client.release.bind(client) as Release
    let published = false
    try {
      observeQueries(client, gateOwner)
      const pidResult = await client.query('SELECT pg_backend_pid() AS pid')
      const pid = Number(pidResult.rows[0]?.pid)
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid')
      if (gateOwner) ownerPid = pid
      const ordinal = ++trace.ordinal
      let completed = false
      const wrapped: Release = (err) => {
        const result = original(err)
        const note = () => {
          if (completed) return
          completed = true
          completeRelease(ordinal, pid, err)
          if (used === null) used = wrapped
        }
        if (isThenable(result)) {
          return Promise.resolve(result).then((value) => {
            note()
            return value
          })
        }
        note()
        return result
      }
      client.release = wrapped as PoolClient['release']
      trace.open += 1
      published = true
      noteCapacity()
      trace.steps.push({
        kind: 'checkout', ordinal, pid, form, open: trace.open, duringAudit: trace.inAudit,
        total: product.totalCount, idle: product.idleCount, waiting: product.waitingCount,
      })
      return client
    } catch (error) {
      if (!published) {
        try {
          original(error instanceof Error ? error : new Error('checkout'))
        } catch {
          // The pool still owns disposal when the original release itself fails.
        }
      }
      throw error
    }
  }
  product.connect = ((...args: unknown[]) => {
    const callback = args.find((arg): arg is ConnectCallback => typeof arg === 'function')
    if (callback) {
      const pending = savedConnect((err: Error | undefined, client: PoolClient | undefined, done: Release) => {
        if (err || !client) {
          callback(err, client, done)
          return
        }
        arm(client, 'callback').then(
          () => callback(undefined, client, (releaseErr) => client.release(releaseErr)),
          (error: unknown) => callback(error instanceof Error ? error : new Error('checkout'), undefined, () => undefined),
        )
      })
      if (isThenable(pending)) pending.then(() => undefined, () => undefined)
      return undefined
    }
    return Promise.resolve(savedConnect() as Promise<PoolClient>).then((client) => arm(client, 'promise'))
  }) as Pool['connect']
  return { trace, usedRelease: () => used }
}

async function observeNativeDuplicateRelease(trace: AuditTrace, used: Release | null): Promise<{
  nativeDuplicate: boolean
  openUnchanged: boolean
  stepsUnchanged: boolean
  releaseCountUnchanged: boolean
}> {
  const open = trace.open
  const steps = JSON.stringify(trace.steps)
  const releaseCount = trace.steps.filter((step) => step.kind === 'release').length
  let nativeDuplicate = false
  if (used) {
    try {
      const result = used()
      if (isThenable(result)) await result
    } catch (error) {
      nativeDuplicate = error instanceof Error && error.message === NATIVE_DUPLICATE_RELEASE
    }
  }
  return {
    nativeDuplicate,
    openUnchanged: trace.open === open,
    stepsUnchanged: JSON.stringify(trace.steps) === steps,
    releaseCountUnchanged: trace.steps.filter((step) => step.kind === 'release').length === releaseCount,
  }
}

type AuditDestination = { owned: boolean; path: boolean; ordinary: boolean; partitioned: boolean; markerRows: number; visibleRows: number }

async function readAuditDestination(observer: Pool, schema: string): Promise<AuditDestination> {
  const found = await observer.query(
    `SELECT n.nspname = $1 AS owned,
            current_schema() = $1 AS path,
            c.relkind = 'r' AS ordinary,
            c.relispartition AS partitioned
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = to_regclass('audit_logs')`,
    [schema],
  )
  const row = found.rows[0]
  const marked = await observer.query(
    `SELECT count(*)::int AS visible,
            count(*) FILTER (WHERE n.nspname = $1)::int AS marker
       FROM audit_logs t
       JOIN pg_class c ON c.oid = t.tableoid
       JOIN pg_namespace n ON n.oid = c.relnamespace`,
    [schema],
  )
  return {
    owned: row?.owned === true,
    path: row?.path === true,
    ordinary: row?.ordinary === true,
    partitioned: row?.partitioned === true,
    markerRows: Number(marked.rows[0]?.marker ?? 0),
    visibleRows: Number(marked.rows[0]?.visible ?? 0),
  }
}

async function auditIssue(fault = false): Promise<void> {
  const schema = process.env.SA_AUDIT_SCHEMA ?? ''
  const userId = process.env.SA_USER_ID ?? ''
  const sid = process.env.SA_SESSION_ID ?? ''
  const org = process.env.SA_ORG_ID ?? ''
  const purpose = (process.env.SA_PURPOSE ?? 'external_identity_unbind') as SecurityActionPurpose
  const connectionId = process.env.SA_CONNECTION_ID ?? ''
  const targetIdentityId = process.env.SA_TARGET_IDENTITY_ID ?? ''
  const revision = Number(process.env.SA_BINDING_REVISION ?? '2')
  const password = process.env.SA_PASSWORD ?? ''
  const internal = pool ? poolManager.get().getInternalPool() : null
  const samePool = pool !== null && internal === pool
  const max = pool?.options.max ?? null
  const min = pool?.options.min ?? null
  const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 })
  const fail = async (destination: Partial<AuditDestination> = {}): Promise<void> => {
    failed = true
    await write({
      event: 'audit-trace', samePool, max, min, auditAttempts: 0, insertAttempts: 0, partitionHeal: 0, maxTotal: 0,
      destinationOwned: destination.owned === true, searchPathOwned: destination.path === true, ordinary: destination.ordinary === true,
      partitioned: destination.partitioned === true, markerRows: destination.markerRows ?? 0, visibleRows: destination.visibleRows ?? 0, steps: [],
    })
    await write({ event: 'crash' })
  }
  try {
    if (!pool || !IDENT.test(schema) || !samePool || max !== 1 || min !== 0) {
      await fail()
      return
    }
    const product = pool
    const ready = await readAuditDestination(observer, schema)
    if (!ready.owned || !ready.path || !ready.ordinary || ready.partitioned) {
      await fail(ready)
      return
    }
    const traced = installProductPoolTrace(product, fault)
    const trace = traced.trace
    const repository = new AuditRepository()
    const resolvers = Object.fromEntries(SECURITY_ACTION_PURPOSES.map((item) => [item, resolver(item)])) as Record<SecurityActionPurpose, SecurityActionTargetResolver>
    const service = createSecurityActionProofService({
      isPurposeAvailable: () => true,
      resolvers,
      runOwnedAttempt,
      recordAudit: async (event) => {
        trace.auditAttempts += 1
        trace.maxTotal = Math.max(trace.maxTotal, product.totalCount)
        trace.steps.push({
          kind: 'audit-entry', open: trace.open, attempt: trace.auditAttempts, duringAudit: false,
          total: product.totalCount, idle: product.idleCount, waiting: product.waitingCount,
        })
        trace.inAudit = true
        try {
          await repository.createAuditLog(auditDataOf(event))
        } finally {
          trace.inAudit = false
        }
      },
      policyRevision: SECURITY_ACTION_POLICY_REVISION,
    })
    const body: SecurityActionVerifyRequest = purpose === 'external_identity_bind'
      ? { purpose, connectionId, method: 'local_password', password }
      : { purpose, connectionId, targetIdentityId, expectedBindingRevision: revision, method: 'local_password', password }
    if (readCompareCount() !== 0) throw new Error('compare observer missing')
    let result: { event: 'result'; ok: boolean; ttlSeconds?: number; status: number; code?: string }
    try {
      const issued = await service.issue(contextOf(userId, sid, org), body)
      result = { event: 'result', ok: true, ttlSeconds: issued.ttlSeconds, status: 200 }
    } catch (error) {
      const code = error instanceof SecurityActionProofError ? error.code : 'SECURITY_ACTION_UNAVAILABLE'
      const status = error instanceof SecurityActionProofError ? error.status : 503
      result = { event: 'result', ok: false, code, status }
    }
    trace.steps.push({ kind: 'terminal' })
    const releaseControl = await observeNativeDuplicateRelease(trace, traced.usedRelease())
    const marked = await readAuditDestination(observer, schema)
    await write({
      event: 'audit-trace', samePool: true, max, min, auditAttempts: trace.auditAttempts, insertAttempts: trace.insertAttempts,
      partitionHeal: trace.partitionHeal, maxTotal: trace.maxTotal, destinationOwned: marked.owned, searchPathOwned: marked.path,
      ordinary: marked.ordinary, partitioned: marked.partitioned, markerRows: marked.markerRows, visibleRows: marked.visibleRows,
      steps: trace.steps, releaseControl, ownerLoss: trace.ownerLoss === true, compareCount: readCompareCount(),
    })
    await write(result)
  } catch {
    failed = true
    await write({ event: 'crash' })
  } finally {
    await observer.end()
  }
}

let failed = false

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    failed = true
    await write({ event: 'crash' })
    return
  }
  const probe = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 })
  try {
    await probe.query('SELECT 1')
  } finally {
    await probe.end()
  }
  if (process.env.SA_WORKER_MODE === 'issue') await issue()
  else if (process.env.SA_WORKER_MODE === 'owned') await owned()
  else if (process.env.SA_WORKER_MODE === 'capacity') await capacity()
  else if (process.env.SA_WORKER_MODE === 'audit') await auditIssue()
  else if (process.env.SA_WORKER_MODE === 'audit-fault') await auditIssue(true)
  else {
    failed = true
    await write({ event: 'crash' })
  }
}

main().then(async () => {
  await pool?.end().catch(() => undefined)
  process.exit(failed ? 1 : 0)
}, async () => {
  await write({ event: 'crash' })
  await pool?.end().catch(() => undefined)
  process.exit(1)
})
