import { randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'
import { Kysely, Migrator, PostgresDialect } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createEventTestMigrationProvider, migrationName, registerEventMigrationLoaders } from '../fixtures/security-events/migrations'
import { EventConnections, W1Capacity, type EventSql } from '../../src/security-events/runtime'
import { AUTHORIZATION_OPERATION_FENCE_LOCK_SQL } from '../../src/admin/authorization-operation-fence'
import { SecurityEventRepository, type DirectoryRunObservation } from '../../src/security-events/repository'
import { EventRetryBuffer } from '../../src/security-events/retry-buffer'

const baseUrl = process.env.DATABASE_URL
if (!baseUrl || process.env.EXPECT_DB !== '1') throw new Error('E1_DIRECTORY_EXPECT_DB_REQUIRED')
const parsed = new URL(baseUrl)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  || !['/metasheet_test', '/postgres'].includes(parsed.pathname)) throw new Error('E1_DIRECTORY_SYNTHETIC_SERVICE_REQUIRED')
const isolated = new URL(baseUrl)
isolated.pathname = `/e1_directory_${randomUUID().replaceAll('-', '')}_test`
const url = isolated.toString()
let admin: Client, outer: Client, db: Kysely<unknown>
let unregister: ReturnType<typeof registerEventMigrationLoaders>
// Source-contract cases start with an established socket. Admission and SQL retain their real deadlines.
// Connection-budget behavior is exercised separately with the unprepared driver.
const preparedWriters: { connections: EventConnections; closeUnused(): Promise<void> }[] = []
function preparedWriter(beforeQuery?: (text: string, client: Client) => Promise<void>) {
  const ready: Client[] = []
  const config = { connectionString: url, connectionTimeoutMillis: 100, application_name: 'e1_write',
    options: '-c search_path=pg_catalog,public -c lock_timeout=100ms -c statement_timeout=100ms' }
  const connections = new EventConnections({ connectionString: url }, actual => {
    expect(actual).toEqual(config)
    const client = ready.shift()
    if (!client) throw new Error('E1_TEST_CONNECTED_CLIENT_REQUIRED')
    const query: EventSql['query'] = async (text, values) => {
      await beforeQuery?.(text, client)
      return client.query(text, values)
    }
    return { connect: async () => {}, end: () => client.end(), on: (event, handler) => client.on(event, handler), query }
  })
  const writer = { connections,
    async prepare() {
      const client = new Client({ ...config, connectionTimeoutMillis: 5000 })
      try { await client.connect(); ready.push(client) }
      catch (error) { await client.end(); throw error }
    },
    async closeUnused() { await Promise.all(ready.splice(0).map(client => client.end())) },
  }
  preparedWriters.push(writer)
  return writer
}
const writer = preparedWriter()
const connections = writer.connections
const repository = new SecurityEventRepository(connections, new W1Capacity(20))

async function seed(org = 'org-A', status = 'completed') {
  const integrationId = randomUUID(), runId = randomUUID()
  await admin.query(`INSERT INTO directory_integrations (id,org_id,name,corp_id,provider)
    VALUES ($1,$2,$3,'synthetic','dingtalk')`, [integrationId, org, `fixture-${integrationId}`])
  await admin.query(`INSERT INTO directory_sync_runs (id,integration_id,status,finished_at)
    VALUES ($1,$2,$3,CASE WHEN $3='completed' THEN clock_timestamp() ELSE NULL END)`, [runId, integrationId, status])
  return { integrationId, runId }
}
async function rows(runId: string) {
  return (await admin.query('SELECT * FROM security_events WHERE source_id=$1 ORDER BY recorded_at,id', [runId])).rows
}
async function observe(ids: { integrationId: string; runId: string }, kind: DirectoryRunObservation['kind'] = 'post_commit_failed') {
  await writer.prepare()
  return repository.appendDirectoryObservation({ kind, ...ids })
}
async function appendSnapshot(...args: Parameters<SecurityEventRepository['appendCommitted']>) {
  await writer.prepare()
  return repository.appendCommitted(...args)
}
async function releaseWrites() {
  for (let i = 0; i < 100 && connections.active.write > 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(connections.active.write).toBe(0)
}

describe.sequential('directory observations on migrated PostgreSQL', () => {
  beforeAll(async () => {
    unregister = registerEventMigrationLoaders()
    const service = new Client({ connectionString: baseUrl })
    await service.connect()
    try { await service.query(`CREATE DATABASE "${isolated.pathname.slice(1)}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`) }
    finally { await service.end() }
    admin = new Client({ connectionString: url }); await admin.connect()
    outer = new Client({ connectionString: url }); await outer.connect()
    await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 2 }) }) })
    const result = await new Migrator({ db, provider: createEventTestMigrationProvider() }).migrateTo(migrationName)
    expect(result.error).toBeUndefined()
    expect(result.results?.every(row => row.status === 'Success')).toBe(true)
  }, 120000)
  afterEach(async () => {
    await outer?.query('ROLLBACK')
    await releaseWrites()
    for (const prepared of preparedWriters) {
      await prepared.closeUnused()
      expect(prepared.connections.active.write).toBe(0)
    }
    expect(expect.getState().assertionCalls).toBeGreaterThan(0)
  })
  afterAll(async () => {
    try { await outer?.end(); await admin?.end(); await db?.destroy() }
    finally { await unregister?.() }
  })

  it.each(['schedule_invalid', 'refresh', 'diagnostic_failed', 'binding_sweep_failed', 'post_commit_failed'] as const)(
    'reports an unavailable store without a snapshot when %s cannot finish connecting within its budget', async kind => {
      const ids = await seed()
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      let queries = 0
      const cold = new EventConnections({ connectionString: url }, config => {
        const client = new Client(config)
        const query: EventSql['query'] = (text, values) => { queries++; return client.query(text, values) }
        return { connect: async () => { await client.connect(); await held },
          end: () => client.end(), on: (event, handler) => client.on(event, handler), query }
      })
      const tested = new SecurityEventRepository(cold, new W1Capacity(20))
      const input = kind === 'schedule_invalid' || kind === 'refresh' ? { kind, integrationId: ids.integrationId } : { kind, ...ids }
      try {
        expect(await tested.appendDirectoryObservation(input)).toEqual({ recorded: false, diagnostic: 'event_store_unavailable' })
        expect(queries).toBe(0)
        expect((await admin.query('SELECT id FROM security_events WHERE target_id=$1 OR target_id=$2', [ids.integrationId, ids.runId])).rows).toEqual([])
      } finally {
        release()
        for (let i = 0; i < 100 && cold.active.write > 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
        expect(cold.active.write).toBe(0)
      }
    },
  )

  it('resolves two organizations independently and rejects a mismatched run', async () => {
    const a = await seed(), b = await seed('org-B')
    expect(await observe(a)).toEqual({ recorded: true })
    expect(await observe(b)).toEqual({ recorded: true })
    expect((await rows(a.runId))[0]).toMatchObject({ org_id: 'org-A', target_id: a.runId })
    expect((await rows(b.runId))[0]).toMatchObject({ org_id: 'org-B', target_id: b.runId })
    expect(await observe({ integrationId: b.integrationId, runId: a.runId })).toEqual({ recorded: false, diagnostic: 'source_missing' })
    expect(await rows(a.runId)).toHaveLength(1)
  })
  describe.each(['binding_sweep_failed', 'post_commit_failed'] as const)('%s source transaction boundary', kind => {
    const step = kind === 'binding_sweep_failed' ? 'sweep' : 'post_commit_failed'
    it('does not write or retain the pending completion', async () => {
      const ids = await seed('org-A', 'running')
      await outer.query('BEGIN')
      await outer.query("UPDATE directory_sync_runs SET status='completed',finished_at=clock_timestamp() WHERE id=$1", [ids.runId])
      expect(await observe(ids, kind)).toEqual({ recorded: false, diagnostic: 'source_missing' })
      expect(await rows(ids.runId)).toHaveLength(0)
      await outer.query('ROLLBACK')
    })
    it('writes the matching type and step after confirmed completion', async () => {
      const ids = await seed('org-A', 'running')
      await outer.query('BEGIN')
      await outer.query("UPDATE directory_sync_runs SET status='completed',finished_at=clock_timestamp() WHERE id=$1", [ids.runId])
      await outer.query('COMMIT')
      expect(await observe(ids, kind)).toEqual({ recorded: true })
      expect(await rows(ids.runId)).toEqual([expect.objectContaining({ event_type: `directory.${kind}`, source_step: step, org_id: 'org-A' })])
    })
    it('leaves rolled back completion without an event or retained snapshot', async () => {
      const ids = await seed('org-A', 'running')
      await outer.query('BEGIN')
      await outer.query("UPDATE directory_sync_runs SET status='completed',finished_at=clock_timestamp() WHERE id=$1", [ids.runId])
      await outer.query('ROLLBACK')
      expect(await observe(ids, kind)).toEqual({ recorded: false, diagnostic: 'source_missing' })
      expect(await rows(ids.runId)).toHaveLength(0)
    })
  })
  it('deduplicates repeated source facts without changing their first scope or time', async () => {
    const ids = await seed()
    expect(await observe(ids)).toEqual({ recorded: true })
    const first = (await rows(ids.runId))[0]
    expect(await observe(ids)).toEqual({ recorded: true })
    expect(await rows(ids.runId)).toEqual([first])
  })
  it.each(['completed', 'failed', 'aborted'])('retains a running diagnostic observation when the run later becomes %s', async status => {
    const ids = await seed('org-A', 'running')
    expect(await observe(ids, 'diagnostic_failed')).toEqual({ recorded: true })
    const first = (await rows(ids.runId))[0]
    expect(first).toMatchObject({ event_type: 'directory.diagnostic_failed', source_kind: 'sync_run',
      source_step: 'diagnostic', source_id: ids.runId, org_id: 'org-A', facts: {} })
    expect(first.facts).toEqual({})
    await admin.query('UPDATE directory_sync_runs SET status=$2,finished_at=clock_timestamp() WHERE id=$1', [ids.runId, status])
    expect(await rows(ids.runId)).toEqual([first])
    expect(await observe(ids, 'diagnostic_failed')).toEqual({ recorded: true })
    expect(await observe(ids, 'diagnostic_failed')).toEqual({ recorded: true })
    expect(await rows(ids.runId)).toEqual([first])
  })
  it('records diagnostics during an uncommitted apply and preserves them after rollback', async () => {
    const ids = await seed('org-A', 'running')
    await outer.query('BEGIN')
    await outer.query("UPDATE directory_sync_runs SET status='completed',finished_at=clock_timestamp() WHERE id=$1", [ids.runId])
    expect(await observe(ids, 'diagnostic_failed')).toEqual({ recorded: true })
    const first = (await rows(ids.runId))[0]
    expect(first).toMatchObject({ event_type: 'directory.diagnostic_failed', facts: {} })
    expect(first.facts).toEqual({})
    await outer.query('ROLLBACK')
    expect((await admin.query('SELECT status FROM directory_sync_runs WHERE id=$1', [ids.runId])).rows[0].status).toBe('running')
    expect(await rows(ids.runId)).toEqual([first])
  })
  it('does not guess diagnostic scope when the integration or matching run is absent', async () => {
    const ids = await seed('org-A', 'running'), other = await seed('org-B', 'running')
    for (const candidate of [{ ...ids, integrationId: randomUUID() }, { ...ids, runId: randomUUID() },
      { ...ids, integrationId: other.integrationId }]) {
      expect(await observe(candidate, 'diagnostic_failed')).toEqual({ recorded: false, diagnostic: 'source_missing' })
    }
    expect(await rows(ids.runId)).toHaveLength(0)
    expect(await rows(other.runId)).toHaveLength(0)
  })
  it('retries a diagnostic snapshot once after the run fails without reading a new scope', async () => {
    const ids = await seed('org-A', 'running')
    await admin.query('ALTER TABLE security_events ADD CONSTRAINT directory_fixture_diagnostic CHECK (false) NOT VALID')
    let result: Awaited<ReturnType<typeof observe>>
    try { result = await observe(ids, 'diagnostic_failed') }
    finally { await releaseWrites(); await admin.query('ALTER TABLE security_events DROP CONSTRAINT directory_fixture_diagnostic') }
    expect(result!).toMatchObject({ recorded: false, diagnostic: 'event_store_unavailable' })
    expect(result!.retry).toBeDefined()
    const { input, authority } = result!.retry!
    let now = 30
    const buffer = new EventRetryBuffer(() => now)
    expect(buffer.offer(input, authority, 0).retained).toBe(true)
    await admin.query("UPDATE directory_sync_runs SET status='failed',finished_at=clock_timestamp() WHERE id=$1", [ids.runId])
    now = 59999
    expect(await buffer.retryOne((candidate, scope) => appendSnapshot(candidate, scope, 'background')))
      .toEqual({ attempted: true, count_unknown: false })
    expect(await buffer.retryOne((candidate, scope) => appendSnapshot(candidate, scope, 'background')))
      .toEqual({ attempted: false, count_unknown: true })
    const recorded = await rows(ids.runId)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ event_type: 'directory.diagnostic_failed', source_step: 'diagnostic', org_id: 'org-A', facts: {} })
    expect(recorded[0].facts).toEqual({})
    now = 60000
    expect(buffer.offer(input, authority, 0).retained).toBe(false)
  })
  it('keeps committed business state when an event constraint rejects insertion', async () => {
    const ids = await seed()
    await admin.query('ALTER TABLE security_events ADD CONSTRAINT directory_fixture_reject CHECK (false) NOT VALID')
    try {
      const result = await observe(ids)
      expect(result).toMatchObject({ recorded: false, diagnostic: 'event_store_unavailable' })
      expect(result.retry?.authority.orgId).toBe('org-A')
      expect((await admin.query('SELECT status FROM directory_sync_runs WHERE id=$1', [ids.runId])).rows[0].status).toBe('completed')
    } finally { await releaseWrites(); await admin.query('ALTER TABLE security_events DROP CONSTRAINT directory_fixture_reject') }
  })
  it('keeps committed business state when the event relation is absent', async () => {
    const ids = await seed()
    await admin.query('ALTER TABLE security_events RENAME TO security_events_fixture_unavailable')
    try {
      const result = await observe(ids)
      expect(result).toMatchObject({ recorded: false, diagnostic: 'event_store_unavailable' })
      expect(result.retry?.input.source_id).toBe(ids.runId)
      expect((await admin.query('SELECT status FROM directory_sync_runs WHERE id=$1', [ids.runId])).rows[0].status).toBe('completed')
    } finally { await releaseWrites(); await admin.query('ALTER TABLE security_events_fixture_unavailable RENAME TO security_events') }
  })
  it('bounds lock waiting without changing the completed source', async () => {
    const ids = await seed()
    await outer.query('BEGIN')
    await outer.query('LOCK TABLE security_events IN ACCESS EXCLUSIVE MODE')
    await writer.prepare()
    const started = performance.now()
    const result = await repository.appendDirectoryObservation({ kind: 'post_commit_failed', ...ids })
    expect(result).toMatchObject({ recorded: false, diagnostic: 'event_store_unavailable' })
    expect(performance.now() - started).toBeLessThan(1000)
    expect((await admin.query('SELECT status FROM directory_sync_runs WHERE id=$1', [ids.runId])).rows[0].status).toBe('completed')
    await outer.query('ROLLBACK')
    await releaseWrites()
    expect(await rows(ids.runId)).toHaveLength(0)
  })
  it.each(['foreground', 'background'] as const)('sets startup and per-statement server timeouts for %s writes', async mode => {
    const ids = await seed()
    const witnesses: { lock_timeout: string; statement_timeout: string }[] = []
    const defaults: string[] = []
    const prepared = preparedWriter(async (text, client) => {
      if (text === 'BEGIN') {
        defaults.push(...(await client.query("SELECT reset_val FROM pg_settings WHERE name IN ('lock_timeout','statement_timeout') ORDER BY name")).rows.map(row => row.reset_val))
      }
      if (text.includes('FROM public.directory_integrations') || text.startsWith('INSERT INTO public.security_events')) {
        witnesses.push((await client.query("SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout")).rows[0])
      }
    })
    const measured = prepared.connections
    await prepared.prepare()
    const tested = new SecurityEventRepository(measured, new W1Capacity(20))
    if (mode === 'foreground') expect(await tested.appendDirectoryObservation({ kind: 'post_commit_failed', ...ids })).toEqual({ recorded: true })
    else {
      await admin.query('ALTER TABLE security_events ADD CONSTRAINT directory_fixture_budget CHECK (false) NOT VALID')
      let result: Awaited<ReturnType<typeof observe>>
      try { result = await observe(ids) }
      finally { await releaseWrites(); await admin.query('ALTER TABLE security_events DROP CONSTRAINT directory_fixture_budget') }
      expect(result!).toMatchObject({ recorded: false, diagnostic: 'event_store_unavailable' })
      expect(result!.retry).toBeDefined()
      expect(await tested.appendCommitted(result!.retry!.input, result!.retry!.authority, mode)).toEqual({ recorded: true, eventId: expect.any(String) })
    }
    expect(defaults).toHaveLength(2)
    for (const value of defaults) {
      expect(Number(value)).toBeGreaterThan(0)
      expect(Number(value)).toBeLessThanOrEqual(mode === 'foreground' ? 100 : 2000)
    }
    expect(witnesses).toHaveLength(mode === 'foreground' ? 2 : 1)
    for (const witness of witnesses) for (const value of Object.values(witness)) {
      const millis = value.endsWith('ms') ? Number(value.slice(0, -2)) : value.endsWith('s') ? Number(value.slice(0, -1)) * 1000 : NaN
      expect(millis).toBeGreaterThan(mode === 'foreground' ? 0 : 1000)
      expect(millis).toBeLessThanOrEqual(mode === 'foreground' ? 100 : 2000)
    }
  })
  it.each(['schedule_invalid', 'diagnostic_failed', 'binding_sweep_failed', 'post_commit_failed'] as const)('keeps %s source reads compatible with the authorization fence', async kind => {
    const ids = await seed()
    const prepared = preparedWriter(async text => {
      if (text.startsWith('INSERT INTO public.security_events')) {
        await outer.query('BEGIN')
        try { await outer.query(AUTHORIZATION_OPERATION_FENCE_LOCK_SQL) }
        finally { await outer.query('ROLLBACK') }
      }
    })
    const measured = prepared.connections
    await prepared.prepare()
    const tested = new SecurityEventRepository(measured, new W1Capacity(20))
    const observation = kind === 'schedule_invalid' ? { kind, integrationId: ids.integrationId } : { kind, ...ids }
    expect(await tested.appendDirectoryObservation(observation)).toEqual({ recorded: true })
  })
  it('reserves only three write slots and never borrows the query slot', async () => {
    const ids = await seed()
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    for (let i = 0; i < 3; i++) await writer.prepare()
    const pending = [1, 2, 3].map(() => connections.writeTransaction('background', () => hold))
    try {
      expect(connections.active).toEqual({ write: 3, query: 0 })
      expect(await repository.appendDirectoryObservation({ kind: 'post_commit_failed', ...ids })).toEqual({ recorded: false, diagnostic: 'event_store_unavailable' })
      expect(connections.active).toEqual({ write: 3, query: 0 })
    } finally { release(); await Promise.all(pending) }
    expect(await rows(ids.runId)).toHaveLength(0)
  })
  it('retries a frozen fact once and arbitrates an uncertain commit by the same source key', async () => {
    const ids = await seed()
    await admin.query('ALTER TABLE security_events ADD CONSTRAINT directory_fixture_retry CHECK (false) NOT VALID')
    let result: Awaited<ReturnType<typeof observe>>
    try { result = await observe(ids) }
    finally { await releaseWrites(); await admin.query('ALTER TABLE security_events DROP CONSTRAINT directory_fixture_retry') }
    expect(result!).toMatchObject({ recorded: false, diagnostic: 'event_store_unavailable' })
    expect(result!.retry).toBeDefined()
    const { input, authority } = result!.retry!
    const buffer = new EventRetryBuffer()
    expect(buffer.offer(input, authority).retained).toBe(true)
    // The first insert is committed but its caller receives no usable acknowledgement.
    expect(await appendSnapshot(input, authority, 'background')).toEqual({ recorded: true, eventId: expect.any(String) })
    const result2 = await buffer.retryOne((candidate, scope) => appendSnapshot(candidate, scope, 'background'))
    expect(result2).toEqual({ attempted: true, count_unknown: false })
    expect(await buffer.retryOne((candidate, scope) => appendSnapshot(candidate, scope))).toEqual({ attempted: false, count_unknown: true })
    expect(await rows(ids.runId)).toHaveLength(1)
  })
})
