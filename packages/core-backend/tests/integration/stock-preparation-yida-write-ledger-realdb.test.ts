// SA05B1: real PostgreSQL proof for the private, per-row Yida delivery ledger.
// This is NOT a transport or external-send E2E. No network sender is imported.
// Production db.cjs + production store, actual 088 DDL, distinct pg clients,
// database-observed blocking, and database-raised audit failures are deliberate.
// Run only in the EXPECT_DB lane / a freshly-created disposable synthetic DB.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const requireCjs = createRequire(import.meta.url)
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
const pluginLib = path.join(repoRoot, 'plugins', 'plugin-integration-core', 'lib')
const LEDGER = 'integration_yida_delivery_ledger'
const AUDIT = 'integration_yida_delivery_audit'
const PIN = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
const migration = path.join(repoRoot, 'packages', 'core-backend', 'migrations', '090_create_integration_yida_delivery_ledger.sql')

type Input = Record<string, unknown>
type Row = Record<string, unknown>
type PublicRecord = Row & { id: string; status: string }
type Preparation = { record: PublicRecord; reused: boolean }
type Store = {
  prepare(input: Input): Promise<Preparation>
  get(input: Input): Promise<PublicRecord | null>
  claim(input: Input): Promise<{ record: PublicRecord; claimToken: string }>
  recordAcknowledgement(input: Input): Promise<PublicRecord>
  markUnknown(input: Input): Promise<PublicRecord>
  cancelPrepared(input: Input): Promise<PublicRecord>
}
type Database = {
  query(sql: string, params?: unknown[]): Promise<Row[]>
  transaction<T>(callback: (trx: Pick<Database, 'query'>) => Promise<T>): Promise<T>
}
type Gate = { reached: Promise<void>; release(): void }
type Session = {
  client: PoolClient
  pid: number
  store: Store
  database: Database
  statements: string[]
  gateBefore(prefix: string): Gate
  releaseGates(): void
  failAfterNextCommit(): void
}
type Outcome<T> = { ok: true; value: T } | { ok: false; code: string }

// OUTSIDE the conditional describe. An accidentally unarmed / missing-DB run is
// RED, never a file whose only database assertions silently disappear.
it('sentinel: this whole-file proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})

const describeIfDatabase = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

describeIfDatabase('SA05B1 Yida delivery ledger — real PostgreSQL, no transport', () => {
  let pool: Pool
  let owner: PoolClient
  let schema = ''
  let first: Session
  let second: Session
  let createDb: (args: { database: Database }) => unknown
  let createStore: (args: { db: unknown }) => Store
  let migrationSql = ''
  const sessions: Session[] = []

  function ident(value: string): string {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Invalid synthetic identifier')
    return `"${value}"`
  }

  function fixture(overrides: Input = {}): Input {
    return {
      tenantId: 'synthetic-tenant-a', workspaceId: null,
      operationId: 'synthetic-operation-a', rowKey: 'synthetic-row-a', ownerId: 'synthetic-owner-a',
      targetRef: 'synthetic-target-a', targetRevision: 'synthetic-target-revision-a', planRevision: 'synthetic-plan-revision-a',
      payloadDigest: 'a'.repeat(64), businessKeyDigest: 'b'.repeat(64),
      credentialRef: 'synthetic-credential-ref-a', credentialGeneration: 1,
      intent: 'create', ...overrides,
    }
  }

  function scope(input: Input = fixture()): Input {
    return Object.fromEntries(['tenantId', 'workspaceId', 'operationId', 'rowKey', 'ownerId'].map((key) => [key, input[key]]))
  }

  function actor(input: Input = fixture()): Input {
    return { ...scope(input), actorId: 'synthetic-actor-a' }
  }

  function acknowledgement(claimToken: string, input: Input = fixture(), overrides: Input = {}): Input {
    return { ...actor(input), claimToken, ack: { statusCode: 200, instanceId: 'synthetic-instance-a', ...overrides } }
  }

  function errorCode(error: unknown): string {
    return error && typeof error === 'object' && 'code' in error ? String(error.code) : 'NO_FIXED_CODE'
  }

  async function outcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
    try { return { ok: true, value: await promise } } catch (error) { return { ok: false, code: errorCode(error) } }
  }

  async function rejected(promise: Promise<unknown>, code: string): Promise<void> {
    const result = await outcome(promise)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(code)
  }

  async function openSession(isolation: 'read committed' | 'repeatable read' | 'serializable' = 'read committed'): Promise<Session> {
    const client = await pool.connect()
    // Never fall through to public tables, even in the CI database that has
    // already run application migrations. All identifiers below are generated.
    await client.query(`SET search_path TO ${ident(schema)}`)
    await client.query(`SET SESSION default_transaction_isolation = '${isolation}'`)
    await client.query("SET statement_timeout = '10s'")
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const statements: string[] = []
    let failAfterCommit = false
    const gates = new Map<string, Gate & { arrive(): void; open: Promise<void> }>()
    const activeGates = new Set<Gate>()
    async function before(sql: string): Promise<void> {
      statements.push(sql) // Shapes only; never SQL parameters or driver errors.
      for (const [prefix, gate] of gates) {
        if (sql.startsWith(prefix)) {
          gates.delete(prefix)
          gate.arrive()
          await gate.open
          activeGates.delete(gate)
          break
        }
      }
    }
    const query = async (sql: string, params?: unknown[]): Promise<Row[]> => {
      await before(sql)
      return (await client.query(sql, params)).rows as Row[]
    }
    const database: Database = {
      query,
      async transaction(callback) {
        await query('BEGIN')
        try {
          const result = await callback({ query })
          await query('COMMIT')
          if (failAfterCommit) {
            failAfterCommit = false
            throw new Error('Synthetic host failure after committed transaction')
          }
          return result
        } catch (error) {
          await query('ROLLBACK')
          throw error
        }
      },
    }
    const session: Session = {
      client, pid, statements, database, store: createStore({ db: createDb({ database }) }),
      gateBefore(prefix) {
        let arrive!: () => void
        let release!: () => void
        const reached = new Promise<void>((resolve) => { arrive = resolve })
        const open = new Promise<void>((resolve) => { release = resolve })
        const gate = { reached, release, arrive, open }
        gates.set(prefix, gate)
        activeGates.add(gate)
        return gate
      },
      releaseGates() {
        for (const gate of activeGates) gate.release()
        gates.clear()
        activeGates.clear()
      },
      failAfterNextCommit() { failAfterCommit = true },
    }
    sessions.push(session)
    return session
  }

  async function reach(gate: Gate): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        gate.reached,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic statement gate was not reached')), 5000) }),
      ])
    } finally { clearTimeout(timer) }
  }

  async function assertBlocked(blocked: Session, blocker: Session): Promise<void> {
    expect(blocked.pid).not.toBe(blocker.pid)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const result = await owner.query(
        "SELECT wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1",
        [blocked.pid, blocker.pid],
      )
      if (result.rows[0]?.blocked === true) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('Expected real PostgreSQL lock wait was not observed')
  }

  async function rows(table: string): Promise<Row[]> {
    return (await owner.query(`SELECT * FROM ${ident(table)} ORDER BY id`)).rows as Row[]
  }

  async function insertRow(table: string, row: Row): Promise<void> {
    const columns = Object.keys(row)
    await owner.query(
      `INSERT INTO ${ident(table)} (${columns.map(ident).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      columns.map((column) => row[column]),
    )
  }

  async function counts(): Promise<{ ledger: number; audit: number }> {
    return { ledger: (await rows(LEDGER)).length, audit: (await rows(AUDIT)).length }
  }

  async function rejectAudit<T>(callback: () => Promise<T>, session?: Session): Promise<T> {
    // A real database CHECK failure aborts the transaction after the store has
    // written its state. No fake transaction facade or simulated rollback.
    const condition = session ? "current_setting('synthetic.reject_audit', true) IS DISTINCT FROM 'true'" : 'false'
    await owner.query(`ALTER TABLE ${ident(AUDIT)} ADD CONSTRAINT synthetic_audit_reject CHECK (${condition}) NOT VALID`)
    if (session) await session.client.query("SET synthetic.reject_audit = 'true'")
    try { return await callback() } finally {
      if (session) await session.client.query('RESET synthetic.reject_audit')
      await owner.query(`ALTER TABLE ${ident(AUDIT)} DROP CONSTRAINT synthetic_audit_reject`)
    }
  }

  function assertNoClaimToken(record: unknown): void {
    expect(JSON.stringify(record)).not.toMatch(/claimToken|claim_token/)
  }

  function assertPinned(session: Session): void {
    const starts = session.statements.flatMap((sql, index) => sql === 'BEGIN' ? [index] : [])
    expect(starts.length).toBeGreaterThan(0)
    for (const index of starts) expect(session.statements[index + 1]).toBe(PIN)
  }

  beforeAll(async () => {
    createDb = requireCjs(path.join(pluginLib, 'db.cjs')).createDb
    createStore = requireCjs(path.join(pluginLib, 'yida-delivery-store.cjs')).createYidaDeliveryStore
    migrationSql = readFileSync(migration, 'utf8')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 7, connectionTimeoutMillis: 5000 })
    owner = await pool.connect()
    await owner.query("SET statement_timeout = '10s'")
  }, 30000)

  beforeEach(async () => {
    // Production guards reject TRUNCATE and DELETE. Each case therefore owns
    // a fresh schema with the actual guards enabled throughout its assertions.
    schema = `yida_delivery_${randomUUID().replaceAll('-', '')}`
    await owner.query(`CREATE SCHEMA ${ident(schema)}`)
    await owner.query(`SET search_path TO ${ident(schema)}`)
    await owner.query(migrationSql)
    await owner.query(migrationSql) // Migration replay must preserve the actual contract.
    first = await openSession()
    second = await openSession()
  }, 30000)

  afterEach(async () => {
    for (const session of sessions) {
      session.releaseGates()
      await session.client.query('ROLLBACK').catch(() => {})
      session.client.release()
    }
    sessions.length = 0
    if (owner && schema) {
      await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`)
      schema = ''
    }
  })

  afterAll(async () => {
    if (owner) {
      if (schema) await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`)
      owner.release()
    }
    await pool?.end()
  })

  it('executes and replays the actual migration in a schema with no public fallback', async () => {
    expect((await owner.query('SHOW search_path')).rows[0].search_path).toBe(schema)
    expect(await counts()).toEqual({ ledger: 0, audit: 0 })
    expect(first.pid).not.toBe(second.pid)
    const result = await owner.query('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [schema])
    expect(result.rows.map((row: { tablename: string }) => row.tablename)).toEqual([AUDIT, LEDGER])
  })

  it('migration replay preserves prepared, dispatched, unknown, acknowledged, and cancelled evidence', async () => {
    const inputs = ['prepared', 'dispatching', 'outcome_unknown', 'acknowledged', 'not_sent']
      .map((status) => fixture({ rowKey: `synthetic-row-${status}` }))
    for (const input of inputs) await first.store.prepare(input)
    await first.store.claim(actor(inputs[1]))
    const unknown = await first.store.claim(actor(inputs[2]))
    await first.store.markUnknown({ ...actor(inputs[2]), claimToken: unknown.claimToken, reason: 'transport_unknown' })
    const acknowledged = await first.store.claim(actor(inputs[3]))
    await first.store.recordAcknowledgement(acknowledgement(acknowledged.claimToken, inputs[3]))
    await first.store.cancelPrepared(actor(inputs[4]))
    const ledger = await rows(LEDGER)
    const audit = await rows(AUDIT)
    await owner.query(migrationSql)
    expect(await rows(LEDGER)).toEqual(ledger)
    expect(await rows(AUDIT)).toEqual(audit)
    for (const input of inputs.slice(1)) await rejected(second.store.claim(actor(input)), 'YIDA_DELIVERY_STATE')
    expect((await second.store.claim(actor(inputs[0]))).record.status).toBe('dispatching')
  })

  it('reuses a durable identical preparation without a second identity or dispatch opportunity', async () => {
    const original = await first.store.prepare(fixture())
    const before = await counts()
    const reused = await second.store.prepare(fixture())
    expect(original.reused).toBe(false)
    expect(reused.reused).toBe(true)
    expect(reused.record.id).toBe(original.record.id)
    expect(reused.record.status).toBe('prepared')
    expect((await counts()).ledger).toBe(1)
    expect((await counts()).audit).toBe(before.audit)
    assertNoClaimToken(reused)
  })

  it.each([
    ['ownerId', 'synthetic-owner-b'], ['targetRef', 'synthetic-target-b'], ['targetRevision', 'synthetic-target-revision-b'],
    ['planRevision', 'synthetic-plan-revision-b'], ['payloadDigest', 'c'.repeat(64)], ['businessKeyDigest', 'd'.repeat(64)],
    ['credentialRef', 'synthetic-credential-ref-b'], ['credentialGeneration', 2],
  ])('same identity with changed %s conflicts instead of creating another row', async (field, value) => {
    await first.store.prepare(fixture())
    await rejected(second.store.prepare(fixture({ [String(field)]: value })), 'YIDA_DELIVERY_CONFLICT')
    expect((await counts()).ledger).toBe(1)
  })

  it('intent and explicit update instance are immutable snapshots', async () => {
    await first.store.prepare(fixture())
    await rejected(second.store.prepare(fixture({ intent: 'update', instanceId: 'synthetic-instance-a' })), 'YIDA_DELIVERY_CONFLICT')
    const update = fixture({ rowKey: 'synthetic-row-update', intent: 'update', instanceId: 'synthetic-instance-a' })
    await first.store.prepare(update)
    await rejected(second.store.prepare({ ...update, instanceId: 'synthetic-instance-b' }), 'YIDA_DELIVERY_CONFLICT')
  })

  it('null/workspace and tenant scopes are independent; reads never fall back', async () => {
    const inputs = [fixture(), fixture({ workspaceId: 'synthetic-workspace-a' }), fixture({ tenantId: 'synthetic-tenant-b' })]
    const records: PublicRecord[] = []
    for (const input of inputs) records.push((await first.store.prepare(input)).record)
    expect(new Set(records.map((record) => record.id)).size).toBe(3)
    for (let index = 0; index < inputs.length; index += 1) {
      expect((await second.store.get(scope(inputs[index])))?.id).toBe(records[index].id)
    }
    expect(await first.store.get(scope(fixture({ workspaceId: 'synthetic-workspace-missing' })))).toBeNull()
    expect(await first.store.get(scope(fixture({ ownerId: 'synthetic-owner-b' })))).toBeNull()
  })

  it('two prepare connections block on the unique identity and converge after COMMIT in a fresh transaction', async () => {
    const gate = first.gateBefore(`INSERT INTO "${AUDIT}"`)
    const a = outcome(first.store.prepare(fixture()))
    let b: Promise<Outcome<Preparation>> | undefined
    try {
      await reach(gate)
      b = outcome(second.store.prepare(fixture()))
      await assertBlocked(second, first)
    } finally { gate.release() }
    const [left, right] = await Promise.all([a, b!])
    expect(left.ok && right.ok).toBe(true)
    if (left.ok && right.ok) {
      expect(left.value.record.id).toBe(right.value.record.id)
      expect(left.value.reused).toBe(false)
      expect(right.value.reused).toBe(true)
    }
    expect((await counts()).ledger).toBe(1)
    expect(second.statements).toContain('ROLLBACK')
    const rollback = second.statements.indexOf('ROLLBACK')
    expect(second.statements.slice(rollback + 1)).toContain('BEGIN')
    assertPinned(first)
    assertPinned(second)
  })

  it('a real prepare/audit failure rolls back the row; a subsequent connection can prepare it', async () => {
    await rejectAudit(async () => {
      await rejected(first.store.prepare(fixture()), 'YIDA_DELIVERY_UNAVAILABLE')
      expect(await counts()).toEqual({ ledger: 0, audit: 0 })
    })
    expect((await second.store.prepare(fixture())).record.status).toBe('prepared')
  })

  it.each(['prepare', 'claim'] as const)('a waiting %s succeeds after the first connection really rolls back its audit failure', async (transition) => {
    if (transition === 'claim') await first.store.prepare(fixture())
    await rejectAudit(async () => {
      const gate = first.gateBefore(`INSERT INTO "${AUDIT}"`)
      const left = outcome<unknown>(transition === 'prepare' ? first.store.prepare(fixture()) : first.store.claim(actor()))
      let right: Promise<Outcome<unknown>> | undefined
      try {
        await reach(gate)
        right = outcome<unknown>(transition === 'prepare' ? second.store.prepare(fixture()) : second.store.claim(actor()))
        await assertBlocked(second, first)
      } finally { gate.release() }
      expect(await left).toEqual({ ok: false, code: 'YIDA_DELIVERY_UNAVAILABLE' })
      expect((await right)?.ok).toBe(true)
      expect(first.statements).toContain('ROLLBACK')
      expect((await second.store.get(scope()))?.status).toBe(transition === 'prepare' ? 'prepared' : 'dispatching')
      expect(await counts()).toEqual({ ledger: 1, audit: transition === 'prepare' ? 1 : 2 })
    }, first)
  })

  it('a concurrent preparation cannot replace the winning immutable snapshot after its unique-key wait', async () => {
    const gate = first.gateBefore(`INSERT INTO "${AUDIT}"`)
    const left = outcome(first.store.prepare(fixture()))
    let right: Promise<Outcome<Preparation>> | undefined
    try {
      await reach(gate)
      right = outcome(second.store.prepare(fixture({ credentialGeneration: 2 })))
      await assertBlocked(second, first)
    } finally { gate.release() }
    expect((await left).ok).toBe(true)
    expect(await right).toEqual({ ok: false, code: 'YIDA_DELIVERY_CONFLICT' })
    expect(await counts()).toEqual({ ledger: 1, audit: 1 })
    expect((await rows(LEDGER))[0].credential_generation).toBe(1)
  })

  it('two claim connections observe a row-lock wait and return exactly one committed private token', async () => {
    await first.store.prepare(fixture())
    const gate = first.gateBefore(`INSERT INTO "${AUDIT}"`)
    const a = outcome(first.store.claim(actor()))
    let b: ReturnType<typeof outcome<{ record: PublicRecord; claimToken: string }>> | undefined
    try {
      await reach(gate)
      expect((await second.store.get(scope()))?.status).toBe('prepared')
      b = outcome(second.store.claim(actor()))
      await assertBlocked(second, first)
    } finally { gate.release() }
    const [left, right] = await Promise.all([a, b!])
    expect(left.ok).toBe(true)
    expect(right).toEqual({ ok: false, code: 'YIDA_DELIVERY_STATE' })
    if (left.ok) {
      expect(left.value.claimToken.length).toBeGreaterThan(16)
      expect(left.value.record.status).toBe('dispatching')
      assertNoClaimToken(left.value.record)
    }
    expect((await second.store.get(scope()))?.status).toBe('dispatching')
    assertPinned(first)
    assertPinned(second)
  })

  it('claim/audit database failure leaves prepared with no token and another connection can claim', async () => {
    await first.store.prepare(fixture())
    const before = await counts()
    await rejectAudit(async () => {
      await rejected(first.store.claim(actor()), 'YIDA_DELIVERY_UNAVAILABLE')
      expect(await counts()).toEqual(before)
      expect((await second.store.get(scope()))?.status).toBe('prepared')
      expect((await rows(LEDGER))[0].claim_token).toBeNull()
    })
    expect((await second.store.claim(actor())).record.status).toBe('dispatching')
  })

  it('a new store and a new connection cannot reclaim committed dispatching, even without an actual send', async () => {
    await first.store.prepare(fixture())
    const claimed = await first.store.claim(actor())
    const restarted = await openSession()
    await rejected(restarted.store.claim(actor()), 'YIDA_DELIVERY_STATE')
    assertNoClaimToken(await restarted.store.get(scope()))
    await restarted.store.markUnknown({ ...actor(), claimToken: claimed.claimToken, reason: 'manual_recovery' })
    await rejected(first.store.claim(actor()), 'YIDA_DELIVERY_STATE')
    expect((await first.store.get(scope()))?.status).toBe('outcome_unknown')
  })

  it('a host failure after actual claim COMMIT returns no token and a restarted store cannot reclaim', async () => {
    await first.store.prepare(fixture())
    first.failAfterNextCommit()
    const failed = await outcome(first.store.claim(actor()))
    expect(failed).toEqual({ ok: false, code: 'YIDA_DELIVERY_UNAVAILABLE' })
    assertNoClaimToken(failed)
    const restarted = await openSession()
    expect((await restarted.store.get(scope()))?.status).toBe('dispatching')
    assertNoClaimToken(await restarted.store.get(scope()))
    await rejected(restarted.store.claim(actor()), 'YIDA_DELIVERY_STATE')
    await rejected(restarted.store.cancelPrepared(actor()), 'YIDA_DELIVERY_STATE')
    expect(await counts()).toEqual({ ledger: 1, audit: 2 })
    const persisted = (await rows(LEDGER))[0]
    expect(persisted.status).toBe('dispatching')
    expect(persisted.claim_token).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each(['tenantId', 'workspaceId', 'ownerId'])('wrong %s cannot read, claim, finish, or cancel a row', async (field) => {
    await first.store.prepare(fixture())
    const wrong = { ...actor(), [field]: 'synthetic-other-scope' }
    expect(await second.store.get({ ...scope(), [field]: 'synthetic-other-scope' })).toBeNull()
    await rejected(second.store.claim(wrong), 'YIDA_DELIVERY_NOT_FOUND')
    await rejected(second.store.cancelPrepared(wrong), 'YIDA_DELIVERY_NOT_FOUND')
    const claimed = await first.store.claim(actor())
    await rejected(second.store.markUnknown({ ...wrong, claimToken: claimed.claimToken, reason: 'transport_unknown' }), 'YIDA_DELIVERY_NOT_FOUND')
    await rejected(second.store.recordAcknowledgement({ ...acknowledgement(claimed.claimToken), [field]: 'synthetic-other-scope' }), 'YIDA_DELIVERY_NOT_FOUND')
    expect((await first.store.get(scope()))?.status).toBe('dispatching')
  })

  it('wrong private tokens cannot ACK or mark unknown and cannot leak in public projections', async () => {
    await first.store.prepare(fixture())
    const claimed = await first.store.claim(actor())
    const token = 'f'.repeat(claimed.claimToken.length)
    await rejected(second.store.recordAcknowledgement(acknowledgement(token)), 'YIDA_DELIVERY_TOKEN')
    await rejected(second.store.markUnknown({ ...actor(), claimToken: token, reason: 'transport_unknown' }), 'YIDA_DELIVERY_TOKEN')
    expect((await second.store.get(scope()))?.status).toBe('dispatching')
    assertNoClaimToken(await second.store.get(scope()))
  })

  it('a correct private token is still bound to the original claim actor and operation row', async () => {
    const other = fixture({ operationId: 'synthetic-operation-b' })
    await first.store.prepare(fixture())
    await second.store.prepare(other)
    const claimed = await first.store.claim(actor())
    await second.store.claim(actor(other))
    const before = await counts()
    await rejected(second.store.recordAcknowledgement({ ...acknowledgement(claimed.claimToken), actorId: 'synthetic-other-actor' }), 'YIDA_DELIVERY_TOKEN')
    await rejected(second.store.markUnknown({ ...actor(), actorId: 'synthetic-other-actor', claimToken: claimed.claimToken, reason: 'transport_unknown' }), 'YIDA_DELIVERY_TOKEN')
    await rejected(second.store.recordAcknowledgement(acknowledgement(claimed.claimToken, other)), 'YIDA_DELIVERY_TOKEN')
    await rejected(second.store.markUnknown({ ...actor(other), claimToken: claimed.claimToken, reason: 'transport_unknown' }), 'YIDA_DELIVERY_TOKEN')
    expect(await counts()).toEqual(before)
    expect((await rows(LEDGER)).every((row) => row.status === 'dispatching')).toBe(true)
  })

  it('create ACK needs an explicit 2xx status and instance; acknowledgement is not business success', async () => {
    await first.store.prepare(fixture())
    const claimed = await first.store.claim(actor())
    const result = await second.store.recordAcknowledgement(acknowledgement(claimed.claimToken, fixture(), { statusCode: 201 }))
    expect(result.status).toBe('acknowledged')
    expect(result).not.toHaveProperty('success')
    expect(result).not.toHaveProperty('delivered')
    assertNoClaimToken(result)
    expect(JSON.stringify(result)).not.toContain('synthetic-instance-a')
    await rejected(first.store.claim(actor()), 'YIDA_DELIVERY_STATE')
    await rejected(first.store.recordAcknowledgement(acknowledgement(claimed.claimToken)), 'YIDA_DELIVERY_STATE')
  })

  it('update ACK uses the exact persisted requested instance without assuming a result body', async () => {
    const input = fixture({ intent: 'update', instanceId: 'synthetic-instance-a' })
    await first.store.prepare(input)
    const claimed = await first.store.claim(actor(input))
    await rejected(second.store.recordAcknowledgement(acknowledgement(claimed.claimToken, input, { instanceId: 'synthetic-instance-b' })), 'YIDA_DELIVERY_ACK')
    expect((await second.store.recordAcknowledgement(acknowledgement(claimed.claimToken, input, { statusCode: 204 }))).status).toBe('acknowledged')
  })

  it.each([
    [{ statusCode: 199, instanceId: 'synthetic-instance-a' }, 'ACK'],
    [{ statusCode: 300, instanceId: 'synthetic-instance-a' }, 'ACK'],
    [{ statusCode: 500, instanceId: 'synthetic-instance-a' }, 'ACK'],
    [{ statusCode: 200.5, instanceId: 'synthetic-instance-a' }, 'ACK'],
    [{ statusCode: '200', instanceId: 'synthetic-instance-a' }, 'ACK'],
    [{ statusCode: 200 }, 'INPUT'], [{ instanceId: 'synthetic-instance-a' }, 'INPUT'],
    [{ statusCode: 200, instanceId: '' }, 'ACK'],
    [{ statusCode: 200, instanceId: 'x'.repeat(129) }, 'ACK'],
    [{ statusCode: 200, instanceId: 'synthetic-instance-a', verified: true }, 'INPUT'],
    [{ statusCode: 200, instanceId: 'synthetic-instance-a', body: { syntheticSecret: 'DO_NOT_PERSIST' } }, 'INPUT'],
  ] as const)('rejects invalid/unproven ACK shape %# without changing dispatching', async (ack, code) => {
    await first.store.prepare(fixture())
    const claimed = await first.store.claim(actor())
    const before = await counts()
    await rejected(second.store.recordAcknowledgement({ ...actor(), claimToken: claimed.claimToken, ack }), `YIDA_DELIVERY_${code}`)
    expect((await second.store.get(scope()))?.status).toBe('dispatching')
    expect(await counts()).toEqual(before)
  })

  it('ACK/audit failure rolls the acknowledgement back to dispatching', async () => {
    await first.store.prepare(fixture())
    const claimed = await first.store.claim(actor())
    const before = await counts()
    await rejectAudit(async () => {
      await rejected(second.store.recordAcknowledgement(acknowledgement(claimed.claimToken)), 'YIDA_DELIVERY_UNAVAILABLE')
      expect(await counts()).toEqual(before)
      expect((await first.store.get(scope()))?.status).toBe('dispatching')
      const persisted = (await rows(LEDGER))[0]
      expect(persisted.ack_status_code).toBeNull()
      expect(persisted.ack_instance_id).toBeNull()
    })
    expect((await first.store.recordAcknowledgement(acknowledgement(claimed.claimToken))).status).toBe('acknowledged')
  })

  it.each(['unknown', 'cancel'] as const)('%s and its audit either both commit or both roll back', async (transition) => {
    await first.store.prepare(fixture())
    const claimed = transition === 'unknown' ? await first.store.claim(actor()) : null
    const before = await counts()
    await rejectAudit(async () => {
      const action = claimed
        ? second.store.markUnknown({ ...actor(), claimToken: claimed.claimToken, reason: 'transport_unknown' })
        : second.store.cancelPrepared(actor())
      await rejected(action, 'YIDA_DELIVERY_UNAVAILABLE')
      expect(await counts()).toEqual(before)
      expect((await first.store.get(scope()))?.status).toBe(claimed ? 'dispatching' : 'prepared')
    })
  })

  it('unknown is terminal: late ACK and repeated claims cannot turn it into prepared or success', async () => {
    await first.store.prepare(fixture())
    const claimed = await first.store.claim(actor())
    expect((await second.store.markUnknown({ ...actor(), claimToken: claimed.claimToken, reason: 'transport_unknown' })).status).toBe('outcome_unknown')
    const before = await counts()
    await rejected(first.store.recordAcknowledgement(acknowledgement(claimed.claimToken)), 'YIDA_DELIVERY_STATE')
    await rejected(first.store.claim(actor()), 'YIDA_DELIVERY_STATE')
    await rejected(first.store.cancelPrepared(actor()), 'YIDA_DELIVERY_STATE')
    await rejected(first.store.markUnknown({ ...actor(), claimToken: claimed.claimToken, reason: 'manual_recovery' }), 'YIDA_DELIVERY_STATE')
    expect((await second.store.prepare(fixture())).record.status).toBe('outcome_unknown')
    expect((await counts()).ledger).toBe(before.ledger)
  })

  it('cancel before dispatch is terminal not_sent; cancellation cannot relabel a dispatched request', async () => {
    await first.store.prepare(fixture())
    expect((await first.store.cancelPrepared(actor())).status).toBe('not_sent')
    await rejected(second.store.claim(actor()), 'YIDA_DELIVERY_STATE')
    const input = fixture({ rowKey: 'synthetic-row-b' })
    await first.store.prepare(input)
    await first.store.claim(actor(input))
    await rejected(second.store.cancelPrepared(actor(input)), 'YIDA_DELIVERY_STATE')
  })

  it.each(['claim', 'cancel'] as const)('%s wins its row-lock race; the other transition is refused', async (winner) => {
    await first.store.prepare(fixture())
    const gate = first.gateBefore(`INSERT INTO "${AUDIT}"`)
    const left = outcome<unknown>(winner === 'claim' ? first.store.claim(actor()) : first.store.cancelPrepared(actor()))
    let right: Promise<Outcome<unknown>> | undefined
    try {
      await reach(gate)
      right = outcome<unknown>(winner === 'claim' ? second.store.cancelPrepared(actor()) : second.store.claim(actor()))
      await assertBlocked(second, first)
    } finally { gate.release() }
    expect((await left).ok).toBe(true)
    expect(await right).toEqual({ ok: false, code: 'YIDA_DELIVERY_STATE' })
    expect((await second.store.get(scope()))?.status).toBe(winner === 'claim' ? 'dispatching' : 'not_sent')
  })

  it('per-row partial completion leaves other rows independently prepared and cannot replay completed/unknown rows', async () => {
    const inputs = ['a', 'b', 'c'].map((suffix) => fixture({ rowKey: `synthetic-row-${suffix}` }))
    for (const input of inputs) await first.store.prepare(input)
    const a = await first.store.claim(actor(inputs[0]))
    await first.store.recordAcknowledgement(acknowledgement(a.claimToken, inputs[0]))
    const b = await first.store.claim(actor(inputs[1]))
    await first.store.markUnknown({ ...actor(inputs[1]), claimToken: b.claimToken, reason: 'commit_unknown' })
    expect((await second.store.get(scope(inputs[2])))?.status).toBe('prepared')
    await rejected(second.store.claim(actor(inputs[0])), 'YIDA_DELIVERY_STATE')
    await rejected(second.store.claim(actor(inputs[1])), 'YIDA_DELIVERY_STATE')
    expect((await second.store.claim(actor(inputs[2]))).record.status).toBe('dispatching')
    expect((await rows(LEDGER)).map((row) => row.status).sort()).toEqual(['acknowledged', 'dispatching', 'outcome_unknown'])
  })

  it.each(['repeatable read', 'serializable'] as const)('pins READ COMMITTED before every production transaction on a %s session', async (isolation) => {
    const hostile = await openSession(isolation)
    await hostile.store.prepare(fixture())
    const claimed = await hostile.store.claim(actor())
    await hostile.store.markUnknown({ ...actor(), claimToken: claimed.claimToken, reason: 'receipt_invalid' })
    assertPinned(hostile)
  })

  it.each([
    { workspaceId: undefined }, { workspaceId: '' }, { tenantId: '' }, { ownerId: '' },
    { operationId: '' }, { rowKey: '' }, { targetRef: '' }, { credentialRef: '' },
    { targetRevision: 0 }, { planRevision: 0 }, { credentialGeneration: 0 },
    { payloadDigest: 'a'.repeat(63) }, { businessKeyDigest: 'not-a-digest' },
    { intent: 'create', instanceId: 'synthetic-instance-a' }, { intent: 'update' },
    { payload: { syntheticSecret: 'DO_NOT_PERSIST' } }, { systemToken: 'DO_NOT_PERSIST' },
  ])('rejects invalid prepare input %# before storing raw data', async (overrides) => {
    await rejected(first.store.prepare(fixture(overrides)), 'YIDA_DELIVERY_INPUT')
    expect(await counts()).toEqual({ ledger: 0, audit: 0 })
  })

  it.each(['prepare', 'get', 'claim', 'recordAcknowledgement', 'markUnknown', 'cancelPrepared'] as const)(
    '%s rejects malformed scope and accessor/inherited inputs before issuing any database query',
    async (method) => {
      const valid = method === 'prepare' ? fixture()
        : method === 'get' ? scope()
          : method === 'recordAcknowledgement' ? acknowledgement('f'.repeat(64))
            : method === 'markUnknown' ? { ...actor(), claimToken: 'f'.repeat(64), reason: 'transport_unknown' }
              : actor()
      const missingWorkspace = { ...valid }
      delete missingWorkspace.workspaceId
      let getterCalls = 0
      const accessor = Object.defineProperty({ ...valid }, 'ownerId', {
        get() { getterCalls += 1; return 'synthetic-owner-a' },
      })
      const inherited = Object.assign(Object.create({ tenantId: 'synthetic-tenant-a' }), valid) as Input
      const invalid: Input[] = [
        missingWorkspace, { ...valid, workspaceId: undefined }, { ...valid, workspaceId: '' },
        { ...valid, tenantId: ' synthetic-tenant-a' }, { ...valid, ownerId: 'x'.repeat(129) },
        { ...valid, rowKey: 'synthetic\nrow' }, { ...valid, unexpected: 'DO_NOT_PERSIST' },
        accessor, inherited,
      ]
      for (const input of invalid) await rejected(first.store[method](input), 'YIDA_DELIVERY_INPUT')
      expect(getterCalls).toBe(0)
      expect(first.statements).toEqual([])
      expect(await counts()).toEqual({ ledger: 0, audit: 0 })
    },
  )

  it.each([
    { tenant_id: '' }, { workspace_id: '' }, { owner_id: '' }, { operation_id: '' }, { row_key: '' },
    { target_ref: '' }, { target_revision: '' }, { plan_revision: '' }, { credential_ref: '' },
    { payload_digest: 'a'.repeat(63) }, { business_key_digest: 'not-a-digest' }, { credential_generation: 0 },
    { intent: 'delete' }, { intent: 'create', instance_id: 'synthetic-instance-a' }, { intent: 'update', instance_id: null },
    { status: 'success' }, { status: 'dispatching' }, { status: 'outcome_unknown' }, { status: 'acknowledged' },
    { claim_token: 'f'.repeat(64) }, { claim_actor_id: 'synthetic-actor-a' },
    { ack_status_code: 200 }, { ack_instance_id: 'synthetic-instance-a' },
    { status: 'dispatching', claim_token: 'bad-token', claim_actor_id: 'synthetic-actor-a' },
    { status: 'acknowledged', claim_token: 'f'.repeat(64), claim_actor_id: 'synthetic-actor-a', ack_status_code: 300, ack_instance_id: 'synthetic-instance-a' },
    { intent: 'update', instance_id: 'synthetic-instance-a', status: 'acknowledged', claim_token: 'f'.repeat(64), claim_actor_id: 'synthetic-actor-a', ack_status_code: 200, ack_instance_id: 'synthetic-instance-b' },
  ])('actual PostgreSQL CHECKs reject malformed ledger row %# independently of the store', async (overrides) => {
    await first.store.prepare(fixture())
    const original = (await rows(LEDGER))[0]
    await rejected(insertRow(LEDGER, { ...original, id: randomUUID(), row_key: 'synthetic-other-row', ...overrides }), '23514')
    expect(await counts()).toEqual({ ledger: 1, audit: 1 })
  })

  it.each([null, 'synthetic-workspace-a'])('database unique scope identity excludes owner for workspace %s', async (workspaceId) => {
    await first.store.prepare(fixture({ workspaceId }))
    const original = (await rows(LEDGER))[0]
    await rejected(insertRow(LEDGER, { ...original, id: randomUUID(), owner_id: 'synthetic-owner-b' }), '23505')
    expect(await counts()).toEqual({ ledger: 1, audit: 1 })
  })

  it.each([
    'tenant_id', 'workspace_id', 'operation_id', 'row_key', 'owner_id', 'target_ref',
    'target_revision', 'plan_revision', 'payload_digest', 'business_key_digest', 'credential_ref',
    'credential_generation', 'intent', 'instance_id',
  ])('database guard refuses rewriting frozen %s even alongside an otherwise valid claim', async (column) => {
    await first.store.prepare(fixture())
    const replacement = column === 'credential_generation' ? 2
      : column === 'intent' ? 'update'
        : column.endsWith('_digest') ? 'c'.repeat(64)
          : 'synthetic-replacement'
    await rejected(owner.query(
      `UPDATE ${ident(LEDGER)} SET ${ident(column)} = $1, status = 'dispatching', claim_token = $2, claim_actor_id = $3`,
      [replacement, 'f'.repeat(64), 'synthetic-actor-a'],
    ), 'P0001')
    expect((await first.store.get(scope()))?.status).toBe('prepared')
    expect(await counts()).toEqual({ ledger: 1, audit: 1 })
  })

  it('database guards preserve dispatch markers, private claim identity, and terminal rows', async () => {
    await first.store.prepare(fixture())
    const claimed = await first.store.claim(actor())
    await rejected(owner.query(`UPDATE ${ident(LEDGER)} SET status = 'prepared', claim_token = NULL, claim_actor_id = NULL`), 'P0001')
    await rejected(owner.query(`UPDATE ${ident(LEDGER)} SET status = 'outcome_unknown', claim_token = $1`, ['f'.repeat(64)]), 'P0001')
    await rejected(owner.query(`UPDATE ${ident(LEDGER)} SET status = 'outcome_unknown', claim_actor_id = $1`, ['synthetic-other-actor']), 'P0001')
    await first.store.markUnknown({ ...actor(), claimToken: claimed.claimToken, reason: 'transport_unknown' })
    await rejected(owner.query(`UPDATE ${ident(LEDGER)} SET status = 'dispatching'`), 'P0001')
    expect((await first.store.get(scope()))?.status).toBe('outcome_unknown')
  })

  it('database guards refuse ledger removal and any audit rewrite, deletion, or truncate', async () => {
    await first.store.prepare(fixture())
    for (const sql of [
      `DELETE FROM ${ident(LEDGER)}`, `TRUNCATE TABLE ${ident(LEDGER)} CASCADE`,
      `UPDATE ${ident(AUDIT)} SET event = 'cancel', status = 'not_sent'`,
      `DELETE FROM ${ident(AUDIT)}`, `TRUNCATE TABLE ${ident(AUDIT)}`,
    ]) await rejected(owner.query(sql), 'P0001')
    expect(await counts()).toEqual({ ledger: 1, audit: 1 })
  })

  it.each([
    { event: 'acknowledgement', status: 'prepared' },
    { event: 'unknown', status: 'outcome_unknown', reason: null },
    { event: 'unknown', status: 'outcome_unknown', reason: 'DO_NOT_PERSIST' },
    { event: 'claim', status: 'dispatching', reason: 'transport_unknown' },
  ])('database audit CHECKs reject invalid event/status/reason shape %#', async (overrides) => {
    const prepared = await first.store.prepare(fixture())
    await rejected(insertRow(AUDIT, {
      id: randomUUID(), ledger_id: prepared.record.id, reason: null, ...overrides,
    }), '23514')
    expect(await counts()).toEqual({ ledger: 1, audit: 1 })
  })

  it('audit references an existing ledger and contains only fixed event/state/reason metadata', async () => {
    const prepared = await first.store.prepare(fixture())
    const claimed = await first.store.claim(actor())
    await first.store.markUnknown({ ...actor(), claimToken: claimed.claimToken, reason: 'receipt_invalid' })
    await rejected(insertRow(AUDIT, {
      id: randomUUID(), ledger_id: 'synthetic-missing-ledger', event: 'prepare', status: 'prepared', reason: null,
    }), '23503')
    const audit = await rows(AUDIT)
    expect(audit).toHaveLength(3)
    expect(audit.map((row) => row.event).sort()).toEqual(['claim', 'prepare', 'unknown'])
    for (const row of audit) {
      expect(Object.keys(row).sort()).toEqual(['created_at', 'event', 'id', 'ledger_id', 'reason', 'status'])
      expect(row.ledger_id).toBe(prepared.record.id)
      expect(JSON.stringify(row)).not.toMatch(/synthetic-tenant|synthetic-owner|synthetic-credential|synthetic-target|synthetic-instance/)
      expect(JSON.stringify(row)).not.toContain(claimed.claimToken)
    }
  })
})
