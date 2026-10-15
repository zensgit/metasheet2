// Internal persistence proof only: real 090+091 DDL, production db/store and
// distinct PostgreSQL sessions. No runner, sender, authority or external-service client.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const requireCjs = createRequire(import.meta.url)
const root = path.resolve(__dirname, '..', '..', '..', '..')
const LEDGER = 'integration_yida_delivery_ledger'
const AUDIT = 'integration_yida_delivery_audit'
const FENCE = 'uniq_integration_yida_delivery_create_business'
const SCOPE = 'uniq_integration_yida_delivery_scope_row'
const states = ['prepared', 'dispatching', 'outcome_unknown', 'acknowledged', 'not_sent'] as const
type Row = Record<string, unknown>
type Preparation = { record: Row & { id: string; status: string }; reused: boolean }
type Store = {
  prepare(input: Row): Promise<Preparation>
  claim(input: Row): Promise<{ record: Row; claimToken: string }>
  recordAcknowledgement(input: Row): Promise<Row>
  markUnknown(input: Row): Promise<Row>
  cancelPrepared(input: Row): Promise<Row>
}
type Database = {
  query(sql: string, params?: unknown[]): Promise<Row[]>
  transaction<T>(callback: (trx: Pick<Database, 'query'>) => Promise<T>): Promise<T>
}
type Gate = { reached: Promise<void>; release(): void }
type Session = {
  client: PoolClient; pid: number; store: Store; statements: string[]; uniqueErrors: string[]
  gateAudit(): Gate; release(): void; loseCommitResponse(): void
}

// Outside describe.skip: an unarmed whole-file invocation must be RED.
it('sentinel: CREATE fence proof requires EXPECT_DB=1 and a dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip

databaseSuite('SA05 inert CREATE tuple fence — real PostgreSQL without delivery', () => {
  let pool: Pool, owner: PoolClient, first: Session, second: Session
  let schema = '', ddl090 = '', ddl091 = ''
  let createDb: (input: { database: Database }) => unknown
  let createStore: (input: { db: unknown }) => Store
  const sessions: Session[] = []
  const ident = (value: string) => {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('SYNTHETIC_IDENTIFIER_REQUIRED')
    return `"${value}"`
  }
  const fixture = (patch: Row = {}): Row => ({
    tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner',
    operationId: 'synthetic-operation', rowKey: 'synthetic-row',
    targetRef: 'synthetic-target', targetRevision: 'synthetic-target-revision', planRevision: 'synthetic-plan-revision',
    payloadDigest: 'a'.repeat(64), businessKeyDigest: 'b'.repeat(64),
    credentialRef: 'synthetic-credential', credentialGeneration: 1, intent: 'create', ...patch,
  })
  const actor = (input = fixture()) => ({ ...Object.fromEntries(
    ['tenantId', 'workspaceId', 'operationId', 'rowKey', 'ownerId'].map(key => [key, input[key]])), actorId: 'synthetic-actor' })
  const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : 'NO_FIXED_CODE'
  const outcome = async <T>(promise: Promise<T>) => {
    try { return { ok: true as const, value: await promise } }
    catch (error) { return { ok: false as const, code: errorCode(error) } }
  }
  const rejectStore = async (promise: Promise<unknown>, code: string) => {
    let caught: unknown
    try { await promise } catch (error) { caught = error }
    expect(errorCode(caught)).toBe(code)
    expect((caught as Error)?.message).toBe(code)
    expect(Object.keys(caught as object).sort()).toEqual(['code', 'name'])
  }
  const rejectMigration = async (code: string, message: string) => {
    let caught: unknown
    try { await owner.query(ddl091) } catch (error) { caught = error }
    expect(errorCode(caught)).toBe(code)
    expect((caught as Error)?.message).toBe(message)
    expect((caught as { detail?: string })?.detail).toBeUndefined()
  }
  const rows = async (table: string) => (await owner.query(`SELECT * FROM ${ident(table)} ORDER BY id`)).rows as Row[]
  const evidence = async () => ({ ledger: await rows(LEDGER), audit: await rows(AUDIT) })
  const dropFence = () => owner.query(`DROP INDEX ${ident(schema)}.${ident(FENCE)}`)
  const directCopy = (row: Row, patch: Row) => {
    const value = { ...row, ...patch }, keys = Object.keys(value)
    return owner.query(`INSERT INTO ${ident(LEDGER)} (${keys.map(ident).join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')})`, keys.map(key => value[key]))
  }

  async function session(): Promise<Session> {
    const client = await pool.connect()
    await client.query(`SET search_path TO ${ident(schema)}`)
    await client.query("SET statement_timeout = '10s'")
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const statements: string[] = [], uniqueErrors: string[] = []
    let gate: (Gate & { enter(): void; open: Promise<void> }) | undefined
    let lostCommit = false
    const query = async (sql: string, params?: unknown[]): Promise<Row[]> => {
      statements.push(sql) // Shapes only; no parameters or driver exceptions.
      if (gate && sql.startsWith(`INSERT INTO "${AUDIT}"`)) {
        const waiting = gate
        waiting.enter()
        await waiting.open
        if (gate === waiting) gate = undefined
      }
      try { return (await client.query(sql, params)).rows as Row[] }
      catch (error) {
        const constraint = (error as { constraint?: string }).constraint
        if (errorCode(error) === '23505' && (constraint === FENCE || constraint === SCOPE)) uniqueErrors.push(constraint)
        throw error
      }
    }
    const database: Database = { query, async transaction(callback) {
      await query('BEGIN')
      try {
        const result = await callback({ query })
        await query('COMMIT')
        if (lostCommit) { lostCommit = false; throw new Error('SYNTHETIC_COMMIT_RESPONSE_LOST') }
        return result
      } catch (error) { await query('ROLLBACK'); throw error }
    } }
    const result: Session = { client, pid, statements, uniqueErrors, store: createStore({ db: createDb({ database }) }),
      gateAudit() {
        let enter!: () => void, release!: () => void
        const reached = new Promise<void>(resolve => { enter = resolve })
        const open = new Promise<void>(resolve => { release = resolve })
        gate = { reached, open, enter, release }
        return gate
      },
      release() { gate?.release() },
      loseCommitResponse() { lostCommit = true },
    }
    sessions.push(result)
    return result
  }
  async function reached(gate: Gate) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([gate.reached, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('SYNTHETIC_GATE_TIMEOUT')), 5000)
    })]) } finally { clearTimeout(timer) }
  }
  async function blocked(waiter: Session, holder: Session) {
    expect(waiter.pid).not.toBe(holder.pid)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const result = await owner.query("SELECT wait_event_type = 'Lock' AND $2::int = ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid = $1", [waiter.pid, holder.pid])
      if (result.rows[0]?.blocked === true) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('SYNTHETIC_PG_LOCK_NOT_OBSERVED')
  }
  async function setState(status: typeof states[number], input = fixture()) {
    await first.store.prepare(input)
    if (status === 'not_sent') await first.store.cancelPrepared(actor(input))
    else if (status !== 'prepared') {
      const { claimToken } = await first.store.claim(actor(input))
      if (status === 'outcome_unknown') await first.store.markUnknown({ ...actor(input), claimToken, reason: 'transport_unknown' })
      if (status === 'acknowledged') await first.store.recordAcknowledgement({ ...actor(input), claimToken,
        ack: { statusCode: 200, instanceId: 'synthetic-instance' } })
    }
  }

  beforeAll(async () => {
    const lib = path.join(root, 'plugins/plugin-integration-core/lib')
    createDb = requireCjs(path.join(lib, 'db.cjs')).createDb
    createStore = requireCjs(path.join(lib, 'yida-delivery-store.cjs')).createYidaDeliveryStore
    ddl090 = readFileSync(path.join(root, 'packages/core-backend/migrations/090_create_integration_yida_delivery_ledger.sql'), 'utf8')
    ddl091 = readFileSync(path.join(root, 'packages/core-backend/migrations/091_create_integration_yida_create_fence.sql'), 'utf8')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 7, connectionTimeoutMillis: 5000 })
    owner = await pool.connect()
    await owner.query("SET statement_timeout = '10s'")
  }, 30000)
  beforeEach(async () => {
    schema = 'yida_create_fence_' + randomUUID().replaceAll('-', '')
    await owner.query(`CREATE SCHEMA ${ident(schema)}`)
    await owner.query(`SET search_path TO ${ident(schema)}`)
    await owner.query(ddl090)
    await owner.query(ddl091)
    first = await session(); second = await session()
  }, 30000)
  afterEach(async () => {
    for (const entry of sessions) {
      entry.release()
      await entry.client.query('ROLLBACK').catch(() => {})
      entry.client.release()
    }
    sessions.length = 0
    if (schema) { await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); schema = '' }
  })
  afterAll(async () => {
    if (owner) { if (schema) await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`); owner.release() }
    await pool?.end()
  })

  it.each(states)('090+091 replay and restart preserve %s evidence and its CREATE reservation', async status => {
    await setState(status)
    const before = await evidence()
    await owner.query(ddl090); await owner.query(ddl091); await owner.query(ddl091)
    expect(await evidence()).toEqual(before)
    expect((await owner.query('SHOW search_path')).rows[0].search_path).toBe(schema)
    const restarted = await session()
    expect((await restarted.store.prepare(fixture())).reused).toBe(true)
    for (const change of [{ operationId: 'synthetic-other-operation' }, { rowKey: 'synthetic-other-row' },
      { operationId: 'synthetic-other-operation', rowKey: 'synthetic-other-row' }]) {
      await rejectStore(restarted.store.prepare(fixture(change)), 'YIDA_DELIVERY_BUSINESS_CONFLICT')
    }
    expect(await evidence()).toEqual(before)
    const duplicate = await outcome(directCopy(before.ledger[0], { id: randomUUID(), operation_id: 'synthetic-direct-other' }))
    expect(duplicate).toEqual({ ok: false, code: '23505' })
    expect(await evidence()).toEqual(before)
  })

  it.each([
    { ownerId: 'synthetic-other-owner' }, { credentialRef: 'synthetic-other-credential' }, { credentialGeneration: 2 },
    { targetRevision: 'synthetic-other-target-revision' }, { planRevision: 'synthetic-other-plan-revision' },
    { payloadDigest: 'c'.repeat(64) }, { rowKey: 'synthetic-other-row' },
  ])('nonidentity snapshot change %j cannot split the unknown CREATE tuple', async patch => {
    await setState('outcome_unknown')
    const before = await evidence()
    await rejectStore(second.store.prepare(fixture({ operationId: 'synthetic-other-operation', ...patch })), 'YIDA_DELIVERY_BUSINESS_CONFLICT')
    expect(await evidence()).toEqual(before)
  })

  it.each([false, true])('same-operation concurrent preparations retain original reuse (scope index recreated: %s)', async recreateScope => {
    if (recreateScope) {
      await owner.query(`DROP INDEX ${ident(schema)}.${ident(SCOPE)}`)
      await owner.query(`CREATE UNIQUE INDEX ${ident(SCOPE)} ON ${ident(LEDGER)} (tenant_id, COALESCE(workspace_id, ''), operation_id, row_key)`)
    }
    const gate = first.gateAudit(), left = outcome(first.store.prepare(fixture()))
    let right: ReturnType<typeof outcome<Preparation>> | undefined
    try { await reached(gate); right = outcome(second.store.prepare(fixture())); await blocked(second, first) }
    finally { gate.release() }
    const a = await left, b = await right!
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.value.reused).toBe(false); expect(b.value.reused).toBe(true)
      expect(a.value.record.id).toBe(b.value.record.id)
    }
    expect(second.uniqueErrors).toEqual([recreateScope ? FENCE : SCOPE])
    const rollback = second.statements.indexOf('ROLLBACK')
    expect(rollback).toBeGreaterThan(-1)
    expect(second.statements.slice(rollback + 1)).toContain('BEGIN')
    expect((await rows(LEDGER)).length).toBe(1); expect((await rows(AUDIT)).length).toBe(1)
  })

  it('different-operation sessions visibly wait on PG and only one reserves the CREATE tuple', async () => {
    const gate = first.gateAudit(), left = outcome(first.store.prepare(fixture()))
    let right: ReturnType<typeof outcome<Preparation>> | undefined
    try {
      await reached(gate)
      right = outcome(second.store.prepare(fixture({ operationId: 'synthetic-other-operation' })))
      await blocked(second, first)
    } finally { gate.release() }
    expect((await left).ok).toBe(true)
    expect(await right).toEqual({ ok: false, code: 'YIDA_DELIVERY_BUSINESS_CONFLICT' })
    expect(second.uniqueErrors).toEqual([FENCE])
    expect((await rows(LEDGER)).length).toBe(1); expect((await rows(AUDIT)).length).toBe(1)
  })

  it.each(['prepare', 'claim'])('lost %s COMMIT response cannot grant another operation a reservation', async phase => {
    if (phase === 'claim') await first.store.prepare(fixture())
    first.loseCommitResponse()
    await rejectStore(phase === 'prepare' ? first.store.prepare(fixture()) : first.store.claim(actor()), 'YIDA_DELIVERY_UNAVAILABLE')
    const before = await evidence(), restarted = await session()
    expect(before.ledger[0].status).toBe(phase === 'prepare' ? 'prepared' : 'dispatching')
    await rejectStore(restarted.store.prepare(fixture({ operationId: 'synthetic-other-operation' })), 'YIDA_DELIVERY_BUSINESS_CONFLICT')
    expect((await restarted.store.prepare(fixture())).reused).toBe(true)
    expect(await evidence()).toEqual(before)
  })

  it('prepare/audit rollback leaves no reservation; a new operation can prepare afterwards', async () => {
    await owner.query(`ALTER TABLE ${ident(AUDIT)} ADD CONSTRAINT synthetic_audit_failure CHECK (false) NOT VALID`)
    await rejectStore(first.store.prepare(fixture()), 'YIDA_DELIVERY_UNAVAILABLE')
    expect(await evidence()).toEqual({ ledger: [], audit: [] })
    await owner.query(`ALTER TABLE ${ident(AUDIT)} DROP CONSTRAINT synthetic_audit_failure`)
    expect((await second.store.prepare(fixture({ operationId: 'synthetic-other-operation' }))).reused).toBe(false)
  })

  it('tenant, null/named workspace, target and digest are separate namespaces, not a global identity claim', async () => {
    await first.store.prepare(fixture())
    const independent = [{ tenantId: 'synthetic-other-tenant' }, { workspaceId: 'synthetic-workspace' },
      { targetRef: 'synthetic-other-target' }, { businessKeyDigest: 'c'.repeat(64) }]
    for (const [i, patch] of independent.entries()) {
      expect((await second.store.prepare(fixture({ operationId: 'synthetic-independent-' + i, ...patch }))).reused).toBe(false)
    }
    expect((await rows(LEDGER)).length).toBe(5)
    await rejectStore(second.store.prepare(fixture({ workspaceId: '' })), 'YIDA_DELIVERY_INPUT')
  })

  it('CREATE reservation does not prohibit explicit UPDATE operations and never converts CREATE to UPDATE', async () => {
    await setState('acknowledged')
    for (const operationId of ['synthetic-update-a', 'synthetic-update-b']) {
      const input = fixture({ operationId, intent: 'update', instanceId: 'synthetic-instance' })
      expect((await second.store.prepare(input)).reused).toBe(false)
    }
    await rejectStore(second.store.prepare(fixture({ intent: 'update', instanceId: 'synthetic-instance' })), 'YIDA_DELIVERY_CONFLICT')
    expect((await rows(LEDGER)).map(row => row.intent).sort()).toEqual(['create', 'update', 'update'])
  })

  it.each(['tenant_id', 'workspace_id', 'target_ref', 'business_key_digest', 'intent'])('ordinary DML cannot rewrite reservation component %s', async column => {
    await first.store.prepare(fixture())
    const before = await evidence()
    const value = column === 'business_key_digest' ? 'c'.repeat(64) : column === 'intent' ? 'update' : 'synthetic-other'
    expect(await outcome(owner.query(`UPDATE ${ident(LEDGER)} SET ${ident(column)} = $1, status = 'dispatching', claim_token = $2, claim_actor_id = $3`,
      [value, 'a'.repeat(64), 'synthetic-actor']))).toEqual({ ok: false, code: 'P0001' })
    expect(await evidence()).toEqual(before)
  })
  it.each(['DELETE FROM', 'TRUNCATE'])('ordinary %s cannot remove a CREATE reservation', async command => {
    await setState('not_sent')
    const before = await evidence()
    // Include the referencing audit relation for TRUNCATE, so the ledger's own
    // trigger is reached instead of PostgreSQL's earlier FK restriction.
    const sql = `${command} ${ident(LEDGER)}${command === 'TRUNCATE' ? ' CASCADE' : ''}`
    await expect(owner.query(sql)).rejects.toMatchObject({ code: 'P0001', message: 'YIDA_DELIVERY_IMMUTABLE' })
    expect(await evidence()).toEqual(before)
  })

  const indexDefinitions = [
    `CREATE INDEX ${FENCE} ON ${LEDGER} (tenant_id, workspace_id, target_ref, business_key_digest)`,
    `CREATE UNIQUE INDEX ${FENCE} ON ${LEDGER} (tenant_id, workspace_id, target_ref, business_key_digest) WHERE intent = 'create'`,
    `CREATE UNIQUE INDEX ${FENCE} ON ${LEDGER} (tenant_id, COALESCE(workspace_id, ''), target_ref, business_key_digest)`,
    `CREATE UNIQUE INDEX ${FENCE} ON ${LEDGER} (tenant_id, COALESCE(workspace_id, ''), target_ref, business_key_digest) WHERE intent = 'update'`,
    `CREATE UNIQUE INDEX ${FENCE} ON ${LEDGER} (tenant_id, COALESCE(workspace_id, ''), target_ref, business_key_digest) WHERE intent = 'create' AND status <> 'not_sent'`,
    `CREATE UNIQUE INDEX ${FENCE} ON ${LEDGER} (tenant_id, COALESCE(workspace_id, ''), target_ref, business_key_digest, owner_id) WHERE intent = 'create'`,
    `CREATE UNIQUE INDEX ${FENCE} ON ${LEDGER} (tenant_id, COALESCE(workspace_id, ''), target_ref, business_key_digest) INCLUDE (operation_id) WHERE intent = 'create'`,
    `CREATE UNIQUE INDEX ${FENCE} ON ${LEDGER} (target_ref, COALESCE(workspace_id, ''), tenant_id, business_key_digest) WHERE intent = 'create'`,
    `CREATE UNIQUE INDEX ${FENCE} ON ${LEDGER} (tenant_id DESC, COALESCE(workspace_id, ''), target_ref, business_key_digest) WHERE intent = 'create'`,
    `CREATE UNIQUE INDEX ${FENCE} ON ${LEDGER} (tenant_id text_pattern_ops, COALESCE(workspace_id, ''), target_ref, business_key_digest) WHERE intent = 'create'`,
    `CREATE UNIQUE INDEX ${FENCE} ON ${LEDGER} (tenant_id COLLATE "C", COALESCE(workspace_id, ''), target_ref, business_key_digest) WHERE intent = 'create'`,
    `CREATE TABLE ${FENCE} (id text)`,
    `ALTER TABLE ${LEDGER} ADD CONSTRAINT ${FENCE} UNIQUE (id)`,
    `ALTER TABLE ${LEDGER} ADD CONSTRAINT ${FENCE} CHECK (true)`,
  ]
  it.each(indexDefinitions.map((sql, ordinal) => ({ sql, ordinal })))('migration rejects same-name wrong definition $ordinal without endorsing or replacing it', async ({ sql }) => {
    await first.store.prepare(fixture())
    const before = await evidence()
    await dropFence(); await owner.query(sql)
    await rejectMigration('P0001', 'YIDA_DELIVERY_CREATE_FENCE_INVALID')
    expect(await evidence()).toEqual(before)
  })

  it('historical cross-operation duplicates make 091 fail without deleting or choosing evidence', async () => {
    await dropFence()
    await first.store.prepare(fixture())
    await second.store.prepare(fixture({ operationId: 'synthetic-other-operation' }))
    const before = await evidence()
    expect(before.ledger.length).toBe(2)
    expect(new Set(before.ledger.map(row => row.business_key_digest)).size).toBe(1)
    await rejectMigration('23505', 'YIDA_DELIVERY_BUSINESS_CONFLICT')
    expect(await evidence()).toEqual(before)
    expect((await owner.query('SELECT 1 FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relname = $1', [FENCE])).rowCount).toBe(0)
  })

  it('a failed concurrent index build leaves a real invalid same-name index that replay must reject', async () => {
    await dropFence()
    await first.store.prepare(fixture())
    await second.store.prepare(fixture({ operationId: 'synthetic-other-operation' }))
    const before = await evidence()
    expect(await outcome(owner.query(`CREATE UNIQUE INDEX CONCURRENTLY ${FENCE} ON ${LEDGER} (tenant_id, COALESCE(workspace_id, ''), target_ref, business_key_digest) WHERE intent = 'create'`)))
      .toEqual({ ok: false, code: '23505' })
    const invalid = await owner.query('SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1', [FENCE])
    expect(invalid.rows).toEqual([{ indisvalid: false }])
    await rejectMigration('P0001', 'YIDA_DELIVERY_CREATE_FENCE_INVALID')
    expect(await evidence()).toEqual(before)
  })

  it('a same-name index on another table cannot satisfy the fence contract', async () => {
    await dropFence()
    await owner.query(`CREATE TABLE synthetic_other (LIKE ${LEDGER})`)
    await owner.query(`CREATE UNIQUE INDEX ${FENCE} ON synthetic_other (tenant_id, COALESCE(workspace_id, ''), target_ref, business_key_digest) WHERE intent = 'create'`)
    await rejectMigration('P0001', 'YIDA_DELIVERY_CREATE_FENCE_INVALID')
  })

  it('a missing current-schema ledger never falls through to a later search-path schema', async () => {
    const empty = schema + '_empty'
    await owner.query(`CREATE SCHEMA ${ident(empty)}`)
    try {
      await owner.query(`SET search_path TO ${ident(empty)}, ${ident(schema)}`)
      await rejectMigration('P0001', 'YIDA_DELIVERY_CREATE_FENCE_INVALID')
    } finally {
      await owner.query(`SET search_path TO ${ident(schema)}`)
      await owner.query(`DROP SCHEMA ${ident(empty)}`)
    }
  })
})
