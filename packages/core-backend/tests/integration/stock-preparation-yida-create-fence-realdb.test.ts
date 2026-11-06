// Internal persistence proof only: real 090+091 DDL, production db/store and
// distinct PostgreSQL sessions. No runner, sender, authority or external-service client.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const requireCjs = createRequire(import.meta.url)
const root = path.resolve(__dirname, '..', '..', '..', '..')
const LEDGER = 'integration_yida_delivery_ledger'
const AUDIT = 'integration_yida_delivery_audit'
const FENCE = 'uniq_integration_yida_delivery_create_business'
const SCOPE = 'uniq_integration_yida_delivery_scope_row'
// Creation-identity fence (design baseline v2.3 §3.3, D16; migration zzzz20261106110300).
const IDENTITY_FENCE = 'uniq_integration_yida_delivery_create_identity'
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
  let schema = '', ddl090 = '', ddl091 = '', ddlBinding = '', ddlBindingDown = '', bindingDownRefused = ''
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
        if (errorCode(error) === '23505' && (constraint === FENCE || constraint === SCOPE || constraint === IDENTITY_FENCE)) uniqueErrors.push(constraint)
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
    // Source binding (design baseline v2.3 §3.3): the ledger part of zzzz20261106110300, exactly what its up() executes.
    const bindingMigration = (await import(pathToFileURL(path.join(root,
      'packages/core-backend/src/db/migrations/zzzz20261106110300_add_integration_yida_source_binding.ts')).href)) as
      { YIDA_SOURCE_BINDING_LEDGER_UP_SQL: string; YIDA_SOURCE_BINDING_DOWN_SQL: string; YIDA_SOURCE_BINDING_DOWN_REFUSED_CODE: string }
    ddlBinding = bindingMigration.YIDA_SOURCE_BINDING_LEDGER_UP_SQL
    ddlBindingDown = bindingMigration.YIDA_SOURCE_BINDING_DOWN_SQL
    bindingDownRefused = bindingMigration.YIDA_SOURCE_BINDING_DOWN_REFUSED_CODE
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
    await owner.query(ddlBinding)
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
    await owner.query(ddl090); await owner.query(ddl091); await owner.query(ddl091); await owner.query(ddlBinding)
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

  // ---- Creation-identity fence (design baseline v2.3 §3.3, D16 a; migration zzzz20261106110300) ----
  // Bound rows carry the two digests. Business digest = the seven keys (K1 / K2); identity digest = key value + project.
  const identity = (patch: Row = {}): Row => fixture({ sourceRecordDigest: '1'.repeat(64), creationIdentityDigest: '2'.repeat(64), ...patch })
  const dropIdentityFence = () => owner.query(`DROP INDEX ${ident(schema)}.${ident(IDENTITY_FENCE)}`)

  it('CF1 (pinned residue): an unbound row with the same source line and a changed seven-key digest is a second reservation', async () => {
    // X: unbound (pasted), seven keys K1, acknowledged. X′: same sourceLineId in its payload, name corrected (K2).
    await setState('acknowledged')
    const second2 = await second.store.prepare(fixture({ operationId: 'synthetic-operation-x2', rowKey: 'synthetic-row-x2',
      businessKeyDigest: 'c'.repeat(64), payloadDigest: 'd'.repeat(64) }))
    expect(second2.reused).toBe(false)
    const ledger = await rows(LEDGER)
    expect(ledger.length).toBe(2)
    expect(ledger.every(row => row.source_record_digest === null && row.creation_identity_digest === null)).toBe(true)
  })

  it('CF2 (index): a new record, the same key and project, a changed seven-key digest hits the identity fence; the ACKed row and its audit stay', async () => {
    // X: bound to record R, seven keys K1, acknowledged with a synthetic receipt.
    await setState('acknowledged', identity())
    const before = await evidence()
    expect(before.ledger[0].creation_identity_digest).toBe('2'.repeat(64))
    // R deleted and re-created as R′ (new record id → new source record digest), name corrected (K2 → new business
    // digest), same key value and project (same identity digest). Another draft, another operation.
    const recreated = identity({ operationId: 'synthetic-operation-r2', rowKey: 'synthetic-row-r2',
      businessKeyDigest: 'c'.repeat(64), payloadDigest: 'd'.repeat(64), sourceRecordDigest: '3'.repeat(64) })
    await rejectStore(second.store.prepare(recreated), 'YIDA_DELIVERY_IDENTITY_CONFLICT')
    expect(second.uniqueErrors).toEqual([IDENTITY_FENCE])
    // The same identity moved to another registered sheet (another source record digest again): refused too.
    await rejectStore(second.store.prepare(identity({ operationId: 'synthetic-operation-s2', rowKey: 'synthetic-row-s2',
      businessKeyDigest: 'e'.repeat(64), sourceRecordDigest: '4'.repeat(64) })), 'YIDA_DELIVERY_IDENTITY_CONFLICT')
    expect(await evidence()).toEqual(before)
    // Another identity (another key value) under the same target is independent, as is the same identity under another target.
    expect((await second.store.prepare(identity({ operationId: 'synthetic-operation-k2', rowKey: 'synthetic-row-k2',
      businessKeyDigest: 'f'.repeat(64), creationIdentityDigest: '5'.repeat(64) }))).reused).toBe(false)
    expect((await second.store.prepare(identity({ operationId: 'synthetic-operation-t2', rowKey: 'synthetic-row-t2',
      targetRef: 'synthetic-other-target' }))).reused).toBe(false)
    // An unbound row with the same seven keys is still caught by the seven-key fence.
    await rejectStore(second.store.prepare(fixture({ operationId: 'synthetic-operation-u', rowKey: 'synthetic-row-u' })), 'YIDA_DELIVERY_BUSINESS_CONFLICT')
    expect((await rows(LEDGER)).length).toBe(3)
    // A direct SQL copy of X under another operation and business digest hits the same index.
    const duplicate = await outcome(directCopy(before.ledger[0], { id: randomUUID(), operation_id: 'synthetic-direct-other', business_key_digest: '9'.repeat(64) }))
    expect(duplicate).toEqual({ ok: false, code: '23505' })
    expect((await rows(LEDGER)).length).toBe(3)
  })

  it('CF2 (replay): the identical bound operation replays its own reservation after the identity race; a changed binding is CONFLICT', async () => {
    await first.store.prepare(identity())
    const replayed = await second.store.prepare(identity())
    expect(replayed.reused).toBe(true)
    await rejectStore(second.store.prepare(identity({ sourceRecordDigest: '3'.repeat(64) })), 'YIDA_DELIVERY_CONFLICT')
    // The identity digest alone is part of the compared snapshot too: the same operation with another identity is CONFLICT, not reuse.
    await rejectStore(second.store.prepare(identity({ creationIdentityDigest: '6'.repeat(64) })), 'YIDA_DELIVERY_CONFLICT')
    await rejectStore(second.store.prepare(fixture()), 'YIDA_DELIVERY_CONFLICT')
    expect((await rows(LEDGER)).length).toBe(1)
  })

  it('CF3 (concurrent admission): two drafts with the same identity on two connections; exactly one reserves, the other rolls back on the identity fence', async () => {
    const gate = first.gateAudit(), left = outcome(first.store.prepare(identity()))
    let right: ReturnType<typeof outcome<Preparation>> | undefined
    try {
      await reached(gate)
      // Another operation, another physical record, another seven-key digest: only the identity is shared.
      right = outcome(second.store.prepare(identity({ operationId: 'synthetic-other-operation', rowKey: 'synthetic-other-row',
        businessKeyDigest: 'c'.repeat(64), sourceRecordDigest: '3'.repeat(64) })))
      await blocked(second, first)
    } finally { gate.release() }
    expect((await left).ok).toBe(true)
    expect(await right).toEqual({ ok: false, code: 'YIDA_DELIVERY_IDENTITY_CONFLICT' })
    expect(second.uniqueErrors).toEqual([IDENTITY_FENCE])
    const rollback = second.statements.indexOf('ROLLBACK')
    expect(rollback).toBeGreaterThan(-1)
    expect((await rows(LEDGER)).length).toBe(1); expect((await rows(AUDIT)).length).toBe(1)
    expect((await rows(LEDGER))[0].operation_id).toBe('synthetic-operation')
  })

  it('without the identity fence the same identity under two records is two reservations (the index is the guarantee)', async () => {
    await dropIdentityFence()
    await first.store.prepare(identity())
    expect((await second.store.prepare(identity({ operationId: 'synthetic-other-operation', rowKey: 'synthetic-other-row',
      businessKeyDigest: 'c'.repeat(64), sourceRecordDigest: '3'.repeat(64) }))).reused).toBe(false)
    expect((await rows(LEDGER)).length).toBe(2)
    // Replaying the migration over the duplicates refuses, as 091 does, instead of choosing between them.
    await expect(owner.query(ddlBinding)).rejects.toMatchObject({ code: '23505', message: 'YIDA_DELIVERY_IDENTITY_CONFLICT' })
    expect((await owner.query('SELECT 1 FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relname = $1', [IDENTITY_FENCE])).rowCount).toBe(0)
  })

  it.each(['source_record_digest', 'creation_identity_digest'])('ordinary DML cannot rewrite the binding column %s of a reservation', async column => {
    await first.store.prepare(identity())
    const before = await evidence()
    expect(await outcome(owner.query(`UPDATE ${ident(LEDGER)} SET ${ident(column)} = $1, status = 'dispatching', claim_token = $2, claim_actor_id = $3`,
      ['7'.repeat(64), 'a'.repeat(64), 'synthetic-actor']))).toEqual({ ok: false, code: 'P0001' })
    expect(await outcome(owner.query(`UPDATE ${ident(LEDGER)} SET ${ident(column)} = NULL, status = 'dispatching', claim_token = $1, claim_actor_id = $2`,
      ['a'.repeat(64), 'synthetic-actor']))).toEqual({ ok: false, code: 'P0001' })
    expect(await evidence()).toEqual(before)
    // A malformed digest never enters the ledger.
    expect(await outcome(directCopy(before.ledger[0], { id: randomUUID(), operation_id: 'synthetic-bad', [column]: 'not-a-digest' }))).toEqual({ ok: false, code: '23514' })
  })
  // ---- R-71 ⑦.5 cut-over reconciliation (migration zzzz20261106110700; design baseline v2.3 §8) ----
  // Real 090 + 091 + 110300 + 110700 DDL, the production reconciliation store over db.cjs and the production
  // delivery store: a reconciled legacy record occupies the CREATE fence, evidence stays apart from sends, the
  // ledger guard keeps every binding clause, and down() refuses while evidence exists.
  const RECONCILE_MIGRATION = 'packages/core-backend/src/db/migrations/zzzz20261106110700_add_integration_yida_delivery_reconciled_existing.ts'
  const RECEIPT_MIGRATION = 'packages/core-backend/src/db/migrations/zzzz20261105033000_add_integration_yida_delivery_audit_receipt_unparsed.ts'
  type ReconcileModule = { YIDA_RECONCILED_EXISTING_UP_SQL: string; YIDA_RECONCILED_EXISTING_DOWN_SQL: string }
  // Migration order on a real deployment: 033000 (reason CHECK, five values) runs before 110300 and 110700.
  const reconcileModule = async () => {
    const receipt = (await import(pathToFileURL(path.join(root, RECEIPT_MIGRATION)).href)) as { YIDA_DELIVERY_AUDIT_RECEIPT_UNPARSED_UP_SQL: string }
    await owner.query(receipt.YIDA_DELIVERY_AUDIT_RECEIPT_UNPARSED_UP_SQL)
    return (await import(pathToFileURL(path.join(root, RECONCILE_MIGRATION)).href)) as ReconcileModule
  }
  const pgFailure = async (promise: Promise<unknown>) => {
    try { await promise; return { ok: true } } catch (error) {
      return { ok: false, code: errorCode(error), message: (error as Error).message }
    }
  }
  const guardDefinition = async () => String((await owner.query(
    "SELECT pg_get_functiondef('integration_yida_delivery_ledger_guard'::regproc) AS body")).rows[0].body)
  const schemaShape = async () => ({
    constraints: (await owner.query(`SELECT c.conrelid::regclass::text AS rel, c.conname, pg_get_constraintdef(c.oid, true) AS def
      FROM pg_constraint c WHERE c.connamespace = current_schema()::regnamespace ORDER BY 1, 2`)).rows,
    columns: (await owner.query(`SELECT attrelid::regclass::text AS rel, attname FROM pg_attribute WHERE attrelid IN
      ('integration_yida_delivery_ledger'::regclass, 'integration_yida_delivery_audit'::regclass) AND attnum > 0 AND NOT attisdropped ORDER BY 1, 2`)).rows,
    indexes: (await owner.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY 1`)).rows
      .map(row => ({ name: row.indexname, def: String(row.indexdef).replace(`${schema}.`, '') })),
    tables: (await owner.query(`SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r' ORDER BY 1`)).rows,
    guard: await guardDefinition(),
  })
  /** One reconciliation run (one page, completed) through the production store on its own connection. */
  async function reconcileOnce(entries: Array<[string, string]>, mode: 'count' | 'register' = 'register') {
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO ${ident(schema)}`)
      const query = async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows as Row[]
      const database: Database = { query, async transaction(callback) {
        await query('BEGIN')
        try { const result = await callback({ query }); await query('COMMIT'); return result }
        catch (error) { await query('ROLLBACK'); throw error }
      } }
      const db = createDb({ database }) as { transaction<T>(callback: (trx: unknown) => Promise<T>): Promise<T> }
      const { createYidaReconciliationStore } = requireCjs(path.join(root, 'plugins/plugin-integration-core/lib/yida-reconciliation-store.cjs')) as {
        createYidaReconciliationStore(input: unknown): {
          openRunInTransaction(trx: unknown, input: Row): Promise<Row & { id: string }>
          commitPage(input: Row): Promise<{ run: Row & { counts: Record<string, number>; status: string } }>
        } }
      const plan = await import(pathToFileURL(path.join(root, 'plugins/plugin-integration-core/lib/yida-reconciliation-plan.mjs')).href) as {
        classifyYidaReconcileRecord(input: Row): string; yidaReconcileCompletion(input: Row): Row; yidaReconcilePayloadDigest(input: Row): string }
      const store = createYidaReconciliationStore({ db, context: { tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner' } })
      const run = await db.transaction(trx => store.openRunInTransaction(trx, { commandId: randomUUID(), targetRef: 'synthetic-target',
        projectNo: 'DEMO-P1', projectKeyTarget: 'project', keyDefinitionDigest: 'd'.repeat(64), mode, pageSize: 50 }))
      return await store.commitPage({ runId: run.id, pageNumber: 1, totalCount: entries.length, responseDigest: 'e'.repeat(64),
        entries: entries.map(([instance, digest]) => ({ observedInstanceId: instance, kind: 'comparable', businessKeyDigest: digest })),
        evidence: { targetRef: 'synthetic-target', planRevision: 'synthetic-plan-revision', formUuid: 'synthetic-form',
          credentialRef: 'synthetic-credential', credentialGeneration: 1,
          payloadDigest: (input: Row) => plan.yidaReconcilePayloadDigest({ formUuid: 'synthetic-form', ...input }) },
        classify: (holder: unknown, observedInstanceId: string) => plan.classifyYidaReconcileRecord({ mode, holder, observedInstanceId }),
        completion: (input: Row) => plan.yidaReconcileCompletion({ ...input, pageSize: 50 }) })
    } finally { client.release() }
  }

  it('⑦.5 RC11: a reconciled_existing row occupies the CREATE fence; the send path cannot prepare the same seven keys', async () => {
    const { YIDA_RECONCILED_EXISTING_UP_SQL } = await reconcileModule()
    await owner.query(YIDA_RECONCILED_EXISTING_UP_SQL)
    await owner.query(YIDA_RECONCILED_EXISTING_UP_SQL) // replayable
    const page = await reconcileOnce([['FINST-legacy-1', 'b'.repeat(64)]])
    expect(page.run.status).toBe('completed')
    expect(page.run.counts.registered).toBe(1)
    const before = await evidence()
    expect(before.ledger).toHaveLength(1)
    expect(before.ledger[0]).toMatchObject({ status: 'reconciled_existing', intent: 'create', instance_id: null, business_key_digest: 'b'.repeat(64),
      observed_instance_id: 'FINST-legacy-1', ack_instance_id: null, ack_status_code: null, claim_token: null, claim_actor_id: null,
      source_record_digest: null, creation_identity_digest: null })
    expect(before.audit.map(row => [row.event, row.status, row.reason])).toEqual([['reconcile', 'reconciled_existing', 'legacy_readback']])
    // The send path: same (tenant, target, seven-key digest) => BUSINESS_CONFLICT, nothing written.
    await rejectStore(first.store.prepare(fixture()), 'YIDA_DELIVERY_BUSINESS_CONFLICT')
    await rejectStore(second.store.prepare(fixture({ operationId: 'synthetic-other-operation', rowKey: 'synthetic-other-row' })), 'YIDA_DELIVERY_BUSINESS_CONFLICT')
    expect(await evidence()).toEqual(before)
    expect(first.uniqueErrors).toEqual([FENCE])
    // The fence blocks no more than the seven keys: another digest prepares normally.
    expect((await first.store.prepare(fixture({ operationId: 'synthetic-other-operation', businessKeyDigest: 'c'.repeat(64) }))).record.status).toBe('prepared')
    // Separate evidence: no acknowledgement audit; the write-back selector (acknowledged + create + bound) never picks it.
    expect((await owner.query(`SELECT count(*)::int AS n FROM ${ident(AUDIT)} WHERE event = 'acknowledgement'`)).rows[0].n).toBe(0)
    expect((await owner.query(`SELECT count(*)::int AS n FROM ${ident(LEDGER)} WHERE status = 'acknowledged' AND intent = 'create'
      AND source_record_digest IS NOT NULL`)).rows[0].n).toBe(0)
    // Replaying the same legacy record (a new run) is already_reconciled; a count run inserts nothing.
    const replay = await reconcileOnce([['FINST-legacy-1', 'b'.repeat(64)]], 'count')
    expect(replay.run.counts.already_reconciled).toBe(1)
    expect((await rows(LEDGER)).length).toBe(2)
  })

  it('⑦.5 RC11: the shape CHECKs admit a reconciled row only in its exact form', async () => {
    const { YIDA_RECONCILED_EXISTING_UP_SQL } = await reconcileModule()
    await owner.query(YIDA_RECONCILED_EXISTING_UP_SQL)
    await reconcileOnce([['FINST-legacy-1', 'b'.repeat(64)]])
    const [row] = await rows(LEDGER)
    const copy = (patch: Row) => directCopy(row, { id: randomUUID(), operation_id: 'synthetic-copy', business_key_digest: 'f'.repeat(64),
      row_key: 'FINST-copy', observed_instance_id: 'FINST-copy', ...patch })
    expect(await outcome(copy({ observed_instance_id: null }))).toEqual({ ok: false, code: '23514' })
    expect(await outcome(copy({ ack_instance_id: 'FINST-copy', ack_status_code: 200 }))).toEqual({ ok: false, code: '23514' })
    expect(await outcome(copy({ claim_token: 'a'.repeat(64), claim_actor_id: 'synthetic-actor' }))).toEqual({ ok: false, code: '23514' })
    expect(await outcome(copy({ intent: 'update', instance_id: 'FINST-copy' }))).toEqual({ ok: false, code: '23514' })
    expect(await outcome(copy({ observed_instance_id: 'bad id' }))).toEqual({ ok: false, code: '23514' })
    // One reconciled row per observed instance and target.
    expect(await outcome(copy({ observed_instance_id: 'FINST-legacy-1' }))).toEqual({ ok: false, code: '23505' })
    const audit = (patch: Row) => owner.query(`INSERT INTO ${ident(AUDIT)} (id, ledger_id, event, status, reason) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), row.id, patch.event, patch.status, patch.reason])
    expect(await outcome(audit({ event: 'reconcile', status: 'reconciled_existing', reason: null }))).toEqual({ ok: false, code: '23514' })
    expect(await outcome(audit({ event: 'unknown', status: 'outcome_unknown', reason: 'legacy_readback' }))).toEqual({ ok: false, code: '23514' })
    expect(await outcome(audit({ event: 'acknowledgement', status: 'reconciled_existing', reason: null }))).toEqual({ ok: false, code: '23514' })
    // A send row can never carry an observed instance id.
    await first.store.prepare(fixture({ businessKeyDigest: 'c'.repeat(64) }))
    expect(await pgFailure(owner.query(`UPDATE ${ident(LEDGER)} SET observed_instance_id = 'FINST-x', status = 'dispatching',
      claim_token = $1, claim_actor_id = 'synthetic-actor' WHERE status = 'prepared'`, ['a'.repeat(64)]))).toEqual({ ok: false, code: 'P0001', message: 'YIDA_DELIVERY_IMMUTABLE' })
  })

  it('⑦.5 RC12: the ledger guard keeps every 110300 binding clause and freezes reconciled rows', async () => {
    const { YIDA_RECONCILED_EXISTING_UP_SQL } = await reconcileModule()
    await owner.query(YIDA_RECONCILED_EXISTING_UP_SQL)
    const guard = await guardDefinition()
    for (const column of ['source_record_digest', 'creation_identity_digest', 'observed_instance_id', 'business_key_digest', 'intent']) {
      expect(guard).toContain(`OLD.${column} IS DISTINCT FROM NEW.${column}`)
    }
    await reconcileOnce([['FINST-legacy-1', 'b'.repeat(64)]])
    const before = await evidence()
    const reconciled = `UPDATE ${ident(LEDGER)} SET %s WHERE status = 'reconciled_existing'`
    expect(await pgFailure(owner.query(reconciled.replace('%s', "status = 'acknowledged', claim_token = $1, claim_actor_id = 'a', ack_status_code = 200, ack_instance_id = 'FINST-legacy-1'"), ['a'.repeat(64)])))
      .toEqual({ ok: false, code: 'P0001', message: 'YIDA_DELIVERY_TRANSITION' })
    expect(await pgFailure(owner.query(reconciled.replace('%s', "observed_instance_id = 'FINST-other'"))))
      .toEqual({ ok: false, code: 'P0001', message: 'YIDA_DELIVERY_IMMUTABLE' })
    expect(await pgFailure(owner.query(reconciled.replace('%s', 'source_record_digest = $1'), ['7'.repeat(64)])))
      .toEqual({ ok: false, code: 'P0001', message: 'YIDA_DELIVERY_IMMUTABLE' })
    expect(await pgFailure(owner.query(`DELETE FROM ${ident(LEDGER)} WHERE status = 'reconciled_existing'`)))
      .toEqual({ ok: false, code: 'P0001', message: 'YIDA_DELIVERY_IMMUTABLE' })
    expect(await evidence()).toEqual(before)
    // The binding columns stay immutable on an ordinary send row after 110700 (a 090 guard body would let this through).
    await first.store.prepare(fixture({ businessKeyDigest: 'c'.repeat(64) }))
    for (const column of ['source_record_digest', 'creation_identity_digest']) {
      expect(await pgFailure(owner.query(`UPDATE ${ident(LEDGER)} SET ${ident(column)} = $1, status = 'dispatching', claim_token = $2,
        claim_actor_id = 'synthetic-actor' WHERE status = 'prepared'`, ['7'.repeat(64), 'a'.repeat(64)])))
        .toEqual({ ok: false, code: 'P0001', message: 'YIDA_DELIVERY_IMMUTABLE' })
    }
    // Reconciliation evidence tables are append-only.
    expect(await pgFailure(owner.query('DELETE FROM integration_yida_reconciliation_pages')))
      .toEqual({ ok: false, code: 'P0001', message: 'YIDA_RECONCILIATION_IMMUTABLE' })
    expect(await pgFailure(owner.query("UPDATE integration_yida_reconciliation_pages SET record_count = 0")))
      .toEqual({ ok: false, code: 'P0001', message: 'YIDA_RECONCILIATION_IMMUTABLE' })
    expect(await pgFailure(owner.query('DELETE FROM integration_yida_reconciliation_runs')))
      .toEqual({ ok: false, code: 'P0001', message: 'YIDA_RECONCILIATION_IMMUTABLE' })
    expect(await pgFailure(owner.query("UPDATE integration_yida_reconciliation_runs SET project_no = 'DEMO-P2'")))
      .toEqual({ ok: false, code: 'P0001', message: 'YIDA_RECONCILIATION_IMMUTABLE' })
    expect(await pgFailure(owner.query("UPDATE integration_yida_reconciliation_runs SET status = 'running', finished_at = NULL")))
      .toEqual({ ok: false, code: 'P0001', message: 'YIDA_RECONCILIATION_TRANSITION' })
    expect(await pgFailure(owner.query('TRUNCATE integration_yida_reconciliation_runs CASCADE')))
      .toMatchObject({ ok: false, code: 'P0001' })
  })

  it('⑦.5 RC11: down() refuses while evidence exists and otherwise restores the exact 110300 schema', async () => {
    const { YIDA_RECONCILED_EXISTING_UP_SQL, YIDA_RECONCILED_EXISTING_DOWN_SQL } = await reconcileModule()
    const original = await schemaShape()
    await owner.query(YIDA_RECONCILED_EXISTING_UP_SQL)
    const widened = await schemaShape()
    expect(widened).not.toEqual(original)
    await owner.query(YIDA_RECONCILED_EXISTING_DOWN_SQL)
    expect(await schemaShape()).toEqual(original)
    await owner.query(YIDA_RECONCILED_EXISTING_DOWN_SQL) // replayable
    expect(await schemaShape()).toEqual(original)
    await owner.query(YIDA_RECONCILED_EXISTING_UP_SQL)
    expect(await schemaShape()).toEqual(widened)
    // With evidence: refuse, change nothing.
    await reconcileOnce([['FINST-legacy-1', 'b'.repeat(64)]])
    const withRows = await evidence()
    expect(await pgFailure(owner.query(YIDA_RECONCILED_EXISTING_DOWN_SQL)))
      .toEqual({ ok: false, code: '55000', message: 'YIDA_DELIVERY_RECONCILED_EXISTING_PRESENT' })
    expect(await schemaShape()).toEqual(widened)
    expect(await evidence()).toEqual(withRows)
    // A count-only run (no ledger row) is evidence too.
    await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`)
    await owner.query(`CREATE SCHEMA ${ident(schema)}`)
    await owner.query(`SET search_path TO ${ident(schema)}`)
    await owner.query(ddl090); await owner.query(ddl091); await owner.query(ddlBinding); await owner.query(YIDA_RECONCILED_EXISTING_UP_SQL)
    await reconcileOnce([['FINST-legacy-1', 'b'.repeat(64)]], 'count')
    expect((await rows(LEDGER)).length).toBe(0)
    expect(await pgFailure(owner.query(YIDA_RECONCILED_EXISTING_DOWN_SQL)))
      .toEqual({ ok: false, code: '55000', message: 'YIDA_DELIVERY_RECONCILED_EXISTING_PRESENT' })
  })

  it('⑦.5 RC11: up() refuses (fail closed) when the 110300 binding columns are absent', async () => {
    const { YIDA_RECONCILED_EXISTING_UP_SQL } = await reconcileModule()
    await owner.query(`DROP SCHEMA ${ident(schema)} CASCADE`)
    await owner.query(`CREATE SCHEMA ${ident(schema)}`)
    await owner.query(`SET search_path TO ${ident(schema)}`)
    await owner.query(ddl090); await owner.query(ddl091)
    expect(await pgFailure(owner.query(YIDA_RECONCILED_EXISTING_UP_SQL)))
      .toEqual({ ok: false, code: '55000', message: 'YIDA_DELIVERY_RECONCILE_BINDING_MISSING' })
    expect((await owner.query("SELECT to_regclass('integration_yida_reconciliation_runs') AS rel")).rows[0].rel).toBeNull()
  })

  // Migration zzzz20261106110300 down(): bound rows are append-only evidence, so down refuses while any exists.
  const bindingColumns = async () => (await owner.query(
    "SELECT attname FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname IN ('source_record_digest', 'creation_identity_digest') AND NOT attisdropped ORDER BY attname",
    [LEDGER])).rows.map(row => String((row as Row).attname))
  const guardBody = async () => String((await owner.query(
    "SELECT pg_get_functiondef(to_regproc('integration_yida_delivery_ledger_guard')::oid) AS body")).rows[0].body)
  const identityFencePresent = async () => (await owner.query(
    'SELECT 1 FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relname = $1', [IDENTITY_FENCE])).rowCount

  it('zzzz20261106110300 down refuses while a bound reservation exists (append-only evidence); the fence and the guard stay in force', async () => {
    await first.store.prepare(identity())
    const before = await evidence()
    let refused: { code?: string; message?: string; detail?: string } | undefined
    try { await owner.query(ddlBindingDown) } catch (error) { refused = error as { code?: string; message?: string; detail?: string } }
    expect(refused?.code).toBe('55000')
    expect(refused?.message).toBe(bindingDownRefused)
    expect(refused?.detail).toBeUndefined()
    expect(await evidence()).toEqual(before)
    expect(await identityFencePresent()).toBe(1)
    expect(await bindingColumns()).toEqual(['creation_identity_digest', 'source_record_digest'])
    expect((await guardBody()).includes('creation_identity_digest')).toBe(true)
    // The identity fence still decides after the refused down: the same identity under another record is refused.
    await rejectStore(second.store.prepare(identity({ operationId: 'synthetic-other-operation', rowKey: 'synthetic-other-row',
      businessKeyDigest: 'c'.repeat(64), sourceRecordDigest: '3'.repeat(64) })), 'YIDA_DELIVERY_IDENTITY_CONFLICT')
    expect((await rows(LEDGER)).length).toBe(1)
  })

  it('zzzz20261106110300 down without bound rows restores the exact 090 guard and drops the fence and the columns; replaying up restores them', async () => {
    // An unbound reservation (NULL digests) is not bound evidence and does not block the down.
    await first.store.prepare(fixture())
    expect(await bindingColumns()).toEqual(['creation_identity_digest', 'source_record_digest'])
    await owner.query(ddlBindingDown)
    expect(await identityFencePresent()).toBe(0)
    expect(await bindingColumns()).toEqual([])
    const restored = await guardBody()
    expect(restored.includes('source_record_digest') || restored.includes('creation_identity_digest')).toBe(false)
    expect(restored.includes('YIDA_DELIVERY_IMMUTABLE') && restored.includes('YIDA_DELIVERY_TRANSITION') && restored.includes('YIDA_DELIVERY_CLAIM')).toBe(true)
    expect((await rows(LEDGER)).length).toBe(1)
    await owner.query(ddlBindingDown) // replay: already down, nothing to refuse or drop
    await owner.query(ddlBinding)
    expect(await identityFencePresent()).toBe(1)
    expect(await bindingColumns()).toEqual(['creation_identity_digest', 'source_record_digest'])
    expect((await guardBody()).includes('creation_identity_digest')).toBe(true)
    const bound = await second.store.prepare(identity({ operationId: 'synthetic-operation-b', rowKey: 'synthetic-row-b', businessKeyDigest: 'c'.repeat(64) }))
    expect(bound.reused).toBe(false)
    expect((await rows(LEDGER)).length).toBe(2)
  })
})
