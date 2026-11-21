/**
 * Realtime revalidation on a real PostgreSQL, real Socket.IO transport and real session tokens.
 *
 * Connects only when EXPECT_DB=1 and DATABASE_URL are both set; a skip is not a pass.
 *
 * WHAT THIS FILE IS. Two collaboration instances inside ONE test process, each with its own
 * protection runtime and its own dedicated listening session, sharing the migrated test database
 * and the process pool. It exercises the production wiring (credential binder, authority reader,
 * installation probe, listener) end to end. It is NOT the two-process acceptance: both instances
 * live in one Node process.
 *
 * The token-claim trust shortcut is switched off for the whole file, so no case can pass through it.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { Pool } from 'pg'
import type { Socket as ClientSocket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { authService, type User } from '../../src/auth/AuthService'
import { revokeUserSession } from '../../src/auth/session-registry'
import { revokeUserSessions } from '../../src/auth/session-revocation'
import { EventBus } from '../../src/integration/events/event-bus'
import { ORDINARY_SESSION_AUTHORITY_SQL, ORDINARY_SUBJECT_AUTHORITY_SQL } from '../../src/realtime-authz/authority-read'
import { DATABASE_IDENTITY_SQL, readDatabaseIdentity } from '../../src/realtime-authz/database-identity'
import { createRealtimeDiagnostics } from '../../src/realtime-authz/diagnostics'
import {
  REALTIME_INVALIDATION_CHANNEL,
  notifyRealtimeInvalidation,
  notifyRealtimeInvalidations,
  type InvalidationTarget,
} from '../../src/realtime-authz/invalidation-notify'
import { createProductionRealtimeProtection, type ProductionRealtimeProtection } from '../../src/realtime-authz/production'
import { SESSION_ENDED_EVENT, type SessionEndedPayload } from '../../src/realtime-authz/protected-connections'
import type { ProtectionEvent } from '../../src/realtime-authz/protection'
import { REALTIME_REVALIDATION_FLAG } from '../../src/realtime-authz/revalidation-flag'
import { poolManager } from '../../src/integration/db/connection-pool'
import { CollabService, buildAuthenticatedUserRoom } from '../../src/services/CollabService'
import { collect, connectClient, listen, once, settle, until } from '../helpers/realtime-protection-harness'

const databaseUrl = process.env.DATABASE_URL ?? ''
if (process.env.EXPECT_DB === '1' && databaseUrl.length === 0) {
  throw new Error('EXPECT_DB=1 requires DATABASE_URL for realtime-revalidation.db.test.ts')
}
const describeDb = process.env.EXPECT_DB === '1' ? describe : describe.skip

const RUN = `a2e2e${randomBytes(5).toString('hex')}`
const ORG = `${RUN}-org`
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }
let admin: Pool
let previousTrust: string | undefined

interface Instance {
  name: string
  collab: CollabService
  production: ProductionRealtimeProtection
  httpServer: HttpServer
  url: string
  eventBus: EventBus
  events: ProtectionEvent[]
  listenerSuffix: string
}

const instances: Instance[] = []
const clients: ClientSocket[] = []

async function instance(name: string, options: { on: boolean; sweepIntervalMs?: number }): Promise<Instance> {
  const listenerSuffix = `-${RUN}-${name}`
  const env = { ...process.env, [REALTIME_REVALIDATION_FLAG]: options.on ? 'true' : undefined } as NodeJS.ProcessEnv
  const production = createProductionRealtimeProtection({
    env: () => env,
    diagnostics: createRealtimeDiagnostics(),
    listenerApplicationNameSuffix: listenerSuffix,
    sweepIntervalMs: options.sweepIntervalMs,
    reprobeIntervalMs: 3_600_000,
  })
  const eventBus = new EventBus()
  const collab = new CollabService(quietLogger as never, eventBus)
  collab.setTokenVerifier(async (token) => (await authService.verifyToken(token))?.id?.toString() ?? null)
  collab.setSheetRoomAuthChecker(async () => true)
  collab.setRealtimeProtection(production.protection, production.connections)
  const events: ProtectionEvent[] = []
  production.protection.subscribe((event) => events.push(event))
  await production.protection.start()
  const { httpServer, url } = await listen()
  collab.initialize(httpServer)
  const created: Instance = { name, collab, production, httpServer, url, eventBus, events, listenerSuffix }
  instances.push(created)
  return created
}

async function listenerSessions(suffix: string): Promise<number[]> {
  const result = await admin.query('SELECT pid FROM pg_stat_activity WHERE application_name LIKE $1 AND pid <> pg_backend_pid()', [`%${suffix}`])
  return result.rows.map((row) => Number(row.pid))
}

async function makeUser(label: string, options: { member?: boolean } = {}): Promise<User> {
  const id = `${RUN}-${label}`
  await admin.query(
    `INSERT INTO users(
       id, username, email, name, password_hash, role, is_admin, is_active,
       activation_status, must_change_password, local_password_set, created_at, updated_at
     ) VALUES ($1, $1, $2, 'Synthetic user', 'x', 'user', FALSE, TRUE, 'activated', FALSE, TRUE, NOW(), NOW())`,
    [id, `${id}@synthetic.invalid`],
  )
  if (options.member) await admin.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [id, ORG])
  return {
    id, email: `${id}@synthetic.invalid`, name: 'Synthetic user', role: 'user', permissions: [],
    ...(options.member ? { tenantId: ORG } : {}),
    created_at: new Date(), updated_at: new Date(),
  }
}

async function registeredSession(userId: string): Promise<string> {
  const sid = `${RUN}-${randomUUID()}`
  await admin.query(
    `INSERT INTO user_sessions (id, user_id, issued_at, expires_at, last_seen_at) VALUES ($1, $2, NOW(), NOW() + interval '1 hour', NOW())`,
    [sid, userId],
  )
  return sid
}

function open(target: Instance, token?: string): ClientSocket {
  const socket = connectClient(target.url, token)
  clients.push(socket)
  return socket
}

async function connected(target: Instance, user: User, token: string): Promise<ClientSocket> {
  const socket = open(target, token)
  await once(socket, 'connect', 5000)
  await until(async () => (await target.collab.getRoomMembers(buildAuthenticatedUserRoom(user.id))).includes(user.id), 5000, `user room of ${user.id} on ${target.name}`)
  return socket
}

async function joinSheet(socket: ClientSocket, sheetId: string): Promise<void> {
  const joined = once(socket, 'joined', 5000)
  socket.emit('join-sheet', sheetId)
  await joined
}

/** Seconds are the resolution of a credential issue time: a watermark written now covers tokens issued this second. */
async function nextSecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100))
}

beforeAll(async () => {
  if (process.env.EXPECT_DB !== '1') return
  previousTrust = process.env.RBAC_TOKEN_TRUST
  process.env.RBAC_TOKEN_TRUST = 'false'
  admin = new Pool({ connectionString: databaseUrl, max: 3 })
})

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.close()
  for (const target of instances.splice(0)) {
    target.production.connections.dispose()
    await target.production.protection.stop()
    target.collab.getIO()?.close()
    await new Promise<void>((resolve) => target.httpServer.close(() => resolve()))
  }
})

afterAll(async () => {
  if (process.env.EXPECT_DB !== '1') return
  if (previousTrust === undefined) delete process.env.RBAC_TOKEN_TRUST
  else process.env.RBAC_TOKEN_TRUST = previousTrust
  try {
    await admin.query('DELETE FROM user_sessions WHERE id LIKE $1', [`${RUN}-%`])
    await admin.query('DELETE FROM user_session_revocations WHERE user_id LIKE $1', [`${RUN}-%`])
    await admin.query('DELETE FROM user_orgs WHERE user_id LIKE $1', [`${RUN}-%`])
    await admin.query('DELETE FROM users WHERE id LIKE $1', [`${RUN}-%`])
  } finally {
    await admin.end()
  }
})

describeDb('switch off on the migrated database: baseline', () => {
  it('opens no listening session and issues none of the revalidation statements', async () => {
    const off = await instance('off', { on: false })
    expect(off.production.protection.decision().row).toBe('off-baseline')
    expect(await listenerSessions(off.listenerSuffix)).toEqual([])

    const pool = poolManager.get().getInternalPool()
    const statements: string[] = []
    const original = pool.query.bind(pool) as (...args: unknown[]) => unknown
    ;(pool as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const first = args[0]
      statements.push(typeof first === 'string' ? first : String((first as { text?: unknown })?.text ?? ''))
      return original(...args)
    }
    try {
      const a = await makeUser('off-a')
      const b = await makeUser('off-b')
      const socketA = await connected(off, a, authService.createToken(a))
      const socketB = await connected(off, b, authService.createToken(b))
      await joinSheet(socketA, 'sheet-1')
      await joinSheet(socketB, 'sheet-1')
      const ops = collect(socketB, 'sheet:op')
      await off.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
      off.collab.sendTo(b.id, 'direct', { n: 1 })
      await until(() => ops.length === 1, 5000)
    } finally {
      ;(pool as unknown as { query: unknown }).query = original
    }
    expect(statements.length).toBeGreaterThan(0)
    for (const forbidden of [ORDINARY_SUBJECT_AUTHORITY_SQL, ORDINARY_SESSION_AUTHORITY_SQL, DATABASE_IDENTITY_SQL]) {
      expect(statements.includes(forbidden)).toBe(false)
    }
    expect(off.production.connections.size()).toBe(0)
    expect(await listenerSessions(off.listenerSuffix)).toEqual([])
  })
})

describeDb('switch on: two instances on one database', () => {
  it('each instance holds exactly one dedicated listening session, outside the pool, on the same database as the pool', async () => {
    const a = await instance('a', { on: true })
    const b = await instance('b', { on: true })
    expect(a.production.protection.decision()).toMatchObject({ row: 'on-without-scope', established: 'revalidate', listenerRequired: true })
    expect(b.production.protection.decision().row).toBe('on-without-scope')
    const pidsA = await listenerSessions(a.listenerSuffix)
    const pidsB = await listenerSessions(b.listenerSuffix)
    expect(pidsA).toHaveLength(1)
    expect(pidsB).toHaveLength(1)
    expect(pidsA[0]).not.toBe(pidsB[0])
    const listening = await admin.query(
      `SELECT pid, query FROM pg_stat_activity WHERE pid = ANY($1::int[])`, [[...pidsA, ...pidsB]],
    )
    expect(listening.rows).toHaveLength(2)
    const pool = poolManager.get().getInternalPool()
    const viaPool = await readDatabaseIdentity(async (sql) => pool.query(sql))
    const viaAdmin = await readDatabaseIdentity(async (sql) => admin.query(sql))
    expect(viaPool).toEqual(viaAdmin)
    expect(viaPool.inRecovery).toBe(false)
  })

  it('a committed watermark closes the idle connections of that user on both instances within five seconds, with no notice sent', async () => {
    const a = await instance('a', { on: true })
    const b = await instance('b', { on: true })
    const kept = await makeUser('idle-kept')
    const gone = await makeUser('idle-gone')
    const goneToken = authService.createToken(gone)
    const keptA = await connected(a, kept, authService.createToken(kept))
    const goneA = await connected(a, gone, goneToken)
    const goneB = await connected(b, gone, goneToken)
    await nextSecond()

    const endedA = once<SessionEndedPayload>(goneA, SESSION_ENDED_EVENT, 5000)
    const endedB = once<SessionEndedPayload>(goneB, SESSION_ENDED_EVENT, 5000)
    const closedA = once(goneA, 'disconnect', 5000)
    const closedB = once(goneB, 'disconnect', 5000)
    const committedAt = Date.now()
    // The existing writer: one committed statement, no notice.
    expect(await revokeUserSessions(gone.id, { updatedBy: 'fixture', reason: 'fixture' })).not.toBeNull()
    expect(await endedA).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
    expect(await endedB).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
    await Promise.all([closedA, closedB])
    expect(Date.now() - committedAt).toBeLessThan(5000)
    expect(keptA.connected).toBe(true)

    // The old credential is refused on a new handshake, on the other instance too.
    for (const target of [a, b]) {
      const again = open(target, goneToken)
      expect(await once<SessionEndedPayload>(again, SESSION_ENDED_EVENT, 5000)).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
      expect(await target.collab.getRoomMembers(buildAuthenticatedUserRoom(gone.id))).toEqual([])
    }
    // A credential issued after the watermark is a new session and is served.
    await nextSecond()
    const fresh = await connected(b, gone, authService.createToken(gone))
    expect(fresh.connected).toBe(true)
  })

  it('a notice committed with the fact closes the connections on both instances at once; a rolled-back one sends nothing', async () => {
    const a = await instance('a', { on: true, sweepIntervalMs: 3_600_000 })
    const b = await instance('b', { on: true, sweepIntervalMs: 3_600_000 })
    const kept = await makeUser('notice-kept')
    const gone = await makeUser('notice-gone')
    const goneToken = authService.createToken(gone)
    const keptB = await connected(b, kept, authService.createToken(kept))
    const goneA = await connected(a, gone, goneToken)
    const goneB = await connected(b, gone, goneToken)
    await nextSecond()

    const invalidationsBefore = a.events.filter((event) => event.type === 'invalidate').length
    const rolledBack = await admin.connect()
    try {
      await rolledBack.query('BEGIN')
      await rolledBack.query(
        `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason) VALUES ($1, NOW(), NOW(), 'fixture', 'fixture')`,
        [gone.id],
      )
      await notifyRealtimeInvalidation(rolledBack, { kind: 'user', userId: gone.id })
      await rolledBack.query('ROLLBACK')
    } finally {
      rolledBack.release()
    }
    await settle(400)
    expect(a.events.filter((event) => event.type === 'invalidate')).toHaveLength(invalidationsBefore)
    expect(goneA.connected).toBe(true)
    expect(goneB.connected).toBe(true)

    const closedA = once(goneA, 'disconnect', 3000)
    const closedB = once(goneB, 'disconnect', 3000)
    const committed = await admin.connect()
    let committedAt = 0
    try {
      await committed.query('BEGIN')
      await committed.query(
        `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at, updated_by, reason) VALUES ($1, NOW(), NOW(), 'fixture', 'fixture')`,
        [gone.id],
      )
      await notifyRealtimeInvalidation(committed, { kind: 'user', userId: gone.id })
      // Not committed yet: nothing has been delivered to the listeners.
      await settle(300)
      expect(goneA.connected).toBe(true)
      await committed.query('COMMIT')
      committedAt = Date.now()
    } finally {
      committed.release()
    }
    await Promise.all([closedA, closedB])
    // The sweep interval of both instances is one hour: only the notice can have closed them.
    expect(Date.now() - committedAt).toBeLessThan(2000)
    expect(keptB.connected).toBe(true)
    expect(a.events.some((event) => event.type === 'invalidate' && event.scope.kind === 'user')).toBe(true)
    expect(b.events.some((event) => event.type === 'invalidate' && event.scope.kind === 'user')).toBe(true)
  })

  it('a transaction that changes two hundred users sends one notice, and each instance re-reads once', async () => {
    const a = await instance('a', { on: true, sweepIntervalMs: 3_600_000 })
    const users = Array.from({ length: 200 }, (_unused, index) => `${RUN}-bulk-${index}`)
    const targets: InvalidationTarget[] = users.map((userId) => ({ kind: 'user', userId }))
    const before = a.events.filter((event) => event.type === 'invalidate').length
    const client = await admin.connect()
    try {
      await client.query('BEGIN')
      const sent = await notifyRealtimeInvalidations(client, targets)
      expect(sent).toEqual([{ kind: 'global' }])
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    await until(() => a.events.filter((event) => event.type === 'invalidate').length > before, 3000, 'the aggregated notice')
    await settle(300)
    const received = a.events.filter((event) => event.type === 'invalidate').slice(before)
    expect(received).toEqual([{ type: 'invalidate', scope: { kind: 'global' } }])
  })

  it('revoking one registered session ends that session only', async () => {
    const a = await instance('a', { on: true })
    const user = await makeUser('two-sessions')
    const sidOne = await registeredSession(user.id)
    const sidTwo = await registeredSession(user.id)
    const one = await connected(a, user, authService.createToken(user, { sid: sidOne }))
    const two = await connected(a, user, authService.createToken(user, { sid: sidTwo }))
    const closed = once(one, 'disconnect', 5000)
    expect(await revokeUserSession(sidOne, { revokedBy: 'fixture', reason: 'fixture' })).not.toBeNull()
    await closed
    await settle(2500)
    expect(two.connected).toBe(true)
    const direct = collect(two, 'direct')
    a.collab.sendTo(user.id, 'direct', { n: 1 })
    await until(() => direct.length === 1, 5000)
  })

  it('a deactivated user and a lost membership stop deliveries on the instance that did not see the change', async () => {
    const a = await instance('a', { on: true, sweepIntervalMs: 3_600_000 })
    const kept = await makeUser('fact-kept', { member: true })
    const deactivated = await makeUser('fact-deactivated', { member: true })
    const removed = await makeUser('fact-removed', { member: true })
    const sockets = {
      kept: await connected(a, kept, authService.createToken(kept)),
      deactivated: await connected(a, deactivated, authService.createToken(deactivated)),
      removed: await connected(a, removed, authService.createToken(removed)),
    }
    for (const socket of Object.values(sockets)) await joinSheet(socket, 'sheet-1')
    const received = {
      kept: collect<{ data: { n: number } }>(sockets.kept, 'sheet:op'),
      deactivated: collect(sockets.deactivated, 'sheet:op'),
      removed: collect(sockets.removed, 'sheet:op'),
    }
    await a.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 1 })
    await until(() => received.kept.length === 1 && received.deactivated.length === 1 && received.removed.length === 1, 5000)

    await admin.query('UPDATE users SET is_active = false WHERE id = $1', [deactivated.id])
    await admin.query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [removed.id, ORG])
    const closedDeactivated = once(sockets.deactivated, 'disconnect', 5000)
    const closedRemoved = once(sockets.removed, 'disconnect', 5000)
    await a.eventBus.emit('spreadsheet.cell.updated', { spreadsheetId: 'sheet-1', n: 2 })
    await Promise.all([closedDeactivated, closedRemoved])
    await until(() => received.kept.length === 2, 5000)
    expect(received.kept.map((op) => op.data.n)).toEqual([1, 2])
    expect(received.deactivated).toHaveLength(1)
    expect(received.removed).toHaveLength(1)
  })

  it('a credential that carries role claims gets no shortcut: its deactivated user is refused', async () => {
    const a = await instance('a', { on: true })
    const user = await makeUser('claims')
    await admin.query('UPDATE users SET is_active = false WHERE id = $1', [user.id])
    const token = authService.createToken({ ...user, role: 'admin', roles: ['admin'], perms: ['*:*'] } as User)
    const socket = open(a, token)
    expect(await once<SessionEndedPayload>(socket, SESSION_ENDED_EVENT, 5000)).toEqual({ code: 'SESSION_NOT_CURRENT', retry: false })
  })

  it('when the listening session of one instance is lost, that instance re-reads every connection after it is back; the other instance is not disturbed', async () => {
    const a = await instance('a', { on: true, sweepIntervalMs: 3_600_000 })
    const b = await instance('b', { on: true, sweepIntervalMs: 3_600_000 })
    const kept = await makeUser('outage-kept')
    const gone = await makeUser('outage-gone')
    const keptA = await connected(a, kept, authService.createToken(kept))
    const goneA = await connected(a, gone, authService.createToken(gone))
    const keptB = await connected(b, kept, authService.createToken(kept))
    const directA = collect<{ n: number }>(keptA, 'direct')
    await nextSecond()

    const generationBefore = a.production.protection.generation()
    const eventsBeforeB = b.events.length
    const [pidA] = await listenerSessions(a.listenerSuffix)
    const closed = once(goneA, 'disconnect', 8000)
    // The session of `gone` ends with no notice, and the listening session of instance A is cut.
    expect(await revokeUserSessions(gone.id, { updatedBy: 'fixture', reason: 'fixture' })).not.toBeNull()
    await admin.query('SELECT pg_terminate_backend($1)', [pidA])

    await until(() => a.events.some((event) => event.type === 'decision' && event.decision.notices.includes('LISTENER_NOT_READY')), 5000, 'instance A not ready')
    await until(() => a.production.protection.decision().row === 'on-without-scope', 8000, 'instance A ready again')
    // With an hour between sweeps and no notice, only the re-read after recovery can close it.
    await closed
    expect(a.production.protection.generation()).toBeGreaterThan(generationBefore)
    const [pidAfter] = await listenerSessions(a.listenerSuffix)
    expect(pidAfter).toBeDefined()
    expect(pidAfter).not.toBe(pidA)
    expect(await listenerSessions(a.listenerSuffix)).toHaveLength(1)

    await until(() => {
      a.collab.sendTo(kept.id, 'direct', { n: directA.length + 1 })
      return directA.length > 0
    }, 5000, 'instance A serving again')
    expect(keptA.connected).toBe(true)
    expect(keptB.connected).toBe(true)
    expect(b.events.slice(eventsBeforeB).filter((event) => event.type === 'decision')).toEqual([])
  })

  it('reads the database identity as an ordinary role, and the channel name is the registered one', async () => {
    const role = `a2e2e_reader_${randomBytes(6).toString('hex')}`
    await admin.query(`CREATE ROLE "${role}" NOLOGIN`)
    const client = await admin.connect()
    try {
      await client.query(`SET ROLE "${role}"`)
      const identity = await readDatabaseIdentity(async (sql) => client.query(sql))
      expect(identity.systemIdentifier).toMatch(/^[0-9]+$/)
      expect(identity.inRecovery).toBe(false)
    } finally {
      await client.query('RESET ROLE').catch(() => undefined)
      client.release()
      await admin.query(`DROP ROLE IF EXISTS "${role}"`)
    }
    expect(REALTIME_INVALIDATION_CHANNEL).toBe('metasheet_realtime_invalidation_v1')
  })
})
