/** Required CI (EXPECT_DB=1, including local integration runs): isolated synthetic database, original provider, no skip-green. */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Pool, Client } from 'pg'
import { Kysely, Migrator, PostgresDialect } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createEventTestMigrationProvider, futureMigrationName, migrationName, registerEventMigrationLoaders } from '../fixtures/security-events/migrations'
import { AUTHORIZATION_OPERATION_FENCE_TABLES, AUTHORIZATION_OPERATION_SCHEMA_QUERIES, inspectAuthorizationOperationSchema, isSupportedAuthorizationOperationSchema } from '../../src/admin/authorization-operation-fence'
import { EventConnections, W1Capacity, verifyEventReadScope, type EventSql } from '../../src/security-events/runtime'
import { SecurityEventRepository, readScopedEvent, readScopedDeliveries, estimateSteadyState } from '../../src/security-events/repository'
import { inspectEventSchema, assertEventSchema } from '../../src/security-events/schema'
import type { EventCandidate } from '../../src/security-events/validation'

// CI provides an explicitly armed, loopback-only synthetic service. Each run creates
// a new database; it never rewinds or drops the lane's migrated shared database.
const baseUrl = process.env.DATABASE_URL
if (!baseUrl || process.env.EXPECT_DB !== '1') throw new Error('E1A_EXPECT_DB_REQUIRED')
const parsed = new URL(baseUrl)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  || !['/metasheet_test', '/postgres'].includes(parsed.pathname)) throw new Error('E1A_SYNTHETIC_SERVICE_REQUIRED')
const expectedMajor = Number(process.env.E1A_PG_MAJOR ?? 14)
if (![14, 15, 16, 17].includes(expectedMajor)) throw new Error('E1A_PG_MAJOR_REQUIRED')
const databaseName = `e1a_${randomUUID().replaceAll('-', '')}_test`
const isolated = new URL(baseUrl)
isolated.pathname = `/${databaseName}`
const url = isolated.toString()
const evidenceDir = process.env.E1A_EVIDENCE_DIR ?? '../../artifacts/e1a-realdb'
let db: Kysely<unknown>, admin: Client, migrator: Migrator
let unregisterMigrationLoaders: ReturnType<typeof registerEventMigrationLoaders>
let baseline: Awaited<ReturnType<typeof inspectAuthorizationOperationSchema>>
let rawBaseline: unknown[]
let approval: Awaited<ReturnType<typeof inspectEventSchema>>
const report: Record<string, unknown> = {}
const rowsOwned: string[] = []
let readClient: Client
const connections = new EventConnections({ connectionString: url }, config => {
  const client = new Client(config)
  if (config.application_name === 'e1_query') readClient = client
  return client
})
const repo = new SecurityEventRepository(connections, new W1Capacity(20))
const sqlOf = (client: Client): EventSql => ({ query: (text, values) => client.query(text, values) })
const currentCatalog = async () => {
  const sections = []
  for (const statement of AUTHORIZATION_OPERATION_SCHEMA_QUERIES) sections.push((await admin.query(statement, statement.includes('$1') ? [[...AUTHORIZATION_OPERATION_FENCE_TABLES]] : undefined)).rows)
  return sections
}
// The fence inspects under the search_path it sets itself (acquireAuthorizationOperationFence, before every
// inspection), and the registered digests were taken that way; the session's default search_path yields another
// digest. Every inspection here runs alone in a transaction of its own with that search_path.
async function inspectFence() {
  await admin.query('BEGIN')
  try {
    await admin.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog,public,pg_temp', true)")
    return await inspectAuthorizationOperationSchema(admin.query.bind(admin))
  } finally { await admin.query('ROLLBACK') }
}
function event(): EventCandidate {
  return { id: randomUUID(), producer: 'directory', event_type: 'directory.sync_failed', source_kind: 'sync_run', source_id: randomUUID(), source_step: 'failed',
    actor_kind: 'system', actor_user_id: null, subject_user_id: null, target_kind: null, target_id: null, reason_code: 'sync_failed', record_origin: 'live', occurred_at: '2026-11-22T00:00:00.000000Z', facts: {} }
}
async function append(input = event(), orgId = 'e1a-org-A') {
  const result = await repo.appendCommitted(input, { kind: 'integration', orgId }, 'background')
  expect(result.recorded).toBe(true)
  if (!result.recorded) throw new Error('E1A_FIXTURE_APPEND_FAILED')
  rowsOwned.push(result.eventId)
  return result.eventId
}
async function rollbackProbe(work: () => Promise<void>) {
  await admin.query('BEGIN')
  try { await work() } finally { await admin.query('ROLLBACK') }
}

describe.sequential('E1-A PG14–17 migrated baseline, no producer wiring', () => {
  beforeAll(async () => {
    unregisterMigrationLoaders = registerEventMigrationLoaders()
    const provider = createEventTestMigrationProvider()
    // Load before connecting; the no-DB regression exercises this same native import path.
    const names = Object.keys(await provider.getMigrations()).sort()
    const index = names.indexOf(migrationName)
    expect(index).toBeGreaterThan(0)
    expect(names.indexOf(futureMigrationName)).toBeGreaterThan(index)
    const service = new Client({ connectionString: baseUrl, connectionTimeoutMillis: 3000 })
    await service.connect()
    try {
      expect(Number((await service.query("SELECT current_setting('server_version_num')::int / 10000 AS major")).rows[0].major)).toBe(expectedMajor)
      await service.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`)
    } finally { await service.end() }
    admin = new Client({ connectionString: url }); await admin.connect()
    await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 2 }) }) })
    // A later migration must neither be required nor executed by this acceptance suite.
    migrator = new Migrator({ db, provider })
    const available = await migrator.getMigrations()
    expect(available.map(item => item.name)).toEqual(names)
    const prepared = await migrator.migrateTo(available[index - 1].name)
    expect(prepared.error).toBeUndefined()
    expect((await admin.query("SELECT to_regclass('public.security_events') AS relation")).rows[0].relation).toBeNull()
    baseline = await inspectFence()
    expect(baseline.tableCount).toBe(AUTHORIZATION_OPERATION_FENCE_TABLES.length)
    expect(baseline.ordinary).toBe(true)
    expect(isSupportedAuthorizationOperationSchema(baseline)).toBe(true)
    rawBaseline = await currentCatalog()
    const migrations = await migrator.getMigrations()
    expect(migrations.find(item => item.name === migrationName)?.executedAt).toBeUndefined()
    expect(migrations.slice(0, index).every(item => item.executedAt !== undefined)).toBe(true)
    expect(migrations.slice(index).every(item => item.executedAt === undefined)).toBe(true)
    report.before = { baseline, rawBaseline }
  }, 120000)
  afterEach(() => { expect(expect.getState().assertionCalls).toBeGreaterThan(0) })
  afterAll(async () => {
    // Preserve test rows and schema on failure. Teardown only disconnects and writes values-free evidence.
    await mkdir(evidenceDir, { recursive: true })
    await writeFile(path.join(evidenceDir, `pg${expectedMajor}-e1a.json`), JSON.stringify(report, null, 2) + '\n')
    try { await admin?.end(); await db?.destroy() } finally { await unregisterMigrationLoaders?.() }
  })

  it('T32 real provider refuses busy maintenance gate without DDL or ledger; succeeds after release', async () => {
    await admin.query('BEGIN')
    await admin.query('SELECT pg_advisory_xact_lock_shared(20261106, 1)')
    try {
      const result = await migrator.migrateTo(migrationName)
      expect(result.error).toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY' })
      expect((await admin.query("SELECT to_regclass('public.security_events') AS relation")).rows[0].relation).toBeNull()
    } finally { await admin.query('ROLLBACK') }
    expect((await migrator.getMigrations()).find(item => item.name === migrationName)?.executedAt).toBeUndefined()
    const result = await migrator.migrateTo(migrationName)
    expect(result.error).toBeUndefined()
    expect(result.results).toEqual([expect.objectContaining({ migrationName, status: 'Success' })])
    const migrations = await migrator.getMigrations()
    const index = migrations.findIndex(item => item.name === migrationName)
    expect(migrations.slice(0, index + 1).every(item => item.executedAt !== undefined)).toBe(true)
    expect(migrations.slice(index + 1).every(item => item.executedAt === undefined)).toBe(true)
    expect(migrations.find(item => item.name === futureMigrationName)).toMatchObject({ executedAt: undefined })
    report.futureMigration = { present: true, executed: false, targetApplied: true }
  })
  it('T31 exact eight catalog sections and digest/baseDigest/ordinary remain identical with empty tables', async () => {
    const after = await inspectFence()
    expect(after).toEqual(baseline)
    expect(await currentCatalog()).toEqual(rawBaseline)
    report.afterEmpty = { after, sections: await currentCatalog() }
    approval = await inspectEventSchema(sqlOf(admin))
    expect(approval.sections[1]).toHaveLength(39)
    expect(approval.sections[2].filter(row => row.contype === 'f')).toHaveLength(1)
    expect(approval.sections[2].find(row => row.contype === 'f')?.target).toBe('security_events')
    report.reviewCandidateSchemaApproval = approval
    await assertEventSchema(sqlOf(admin), [approval])
  })
  it('T38 missing CHECK/column/index or changed enum/facts definitions invalidate the reviewed catalog', async () => {
    for (const statement of [
      'ALTER TABLE public.security_events DROP CONSTRAINT se_facts',
      'ALTER TABLE public.security_events DROP CONSTRAINT se_producer',
      'ALTER TABLE public.security_event_deliveries DROP CONSTRAINT sed_lease',
      'ALTER TABLE public.security_event_deliveries DROP CONSTRAINT sed_retry',
      'ALTER TABLE public.security_events ALTER COLUMN schema_version DROP NOT NULL',
      'DROP INDEX public.se_org_type_time',
    ]) await rollbackProbe(async () => {
      await admin.query(statement)
      await expect(assertEventSchema(sqlOf(admin), [approval])).rejects.toThrow('E1_SCHEMA_UNAVAILABLE')
    })
    await expect(assertEventSchema(sqlOf(admin), [approval])).resolves.toBeUndefined()
  })
  it('T02 direct SQL rejects generic facts violations, closed sets and state combinations', async () => {
    const id = await append()
    const facts = [[], null, { unknown: true }, { affected_count: {} }, { affected_count: true }, { affected_count: -1 }, { affected_count: 0.5 }, { affected_count: 2147483648 }, { duration_ms: 9007199254740992 }, { sampled: 1 }]
    for (const value of facts) await rollbackProbe(async () => {
      await expect(admin.query('UPDATE public.security_events SET facts=$1::jsonb WHERE id=$2', [JSON.stringify(value), id])).rejects.toBeDefined()
    })
    for (const [column, value] of Object.entries({ schema_version: 2, scope_kind: 'tenant', producer: 'arbitrary', severity: 'debug', outcome: 'pending', reason_code: 'exception_text', actor_kind: 'service', target_kind: 'session', source_kind: 'session', source_step: 'free text', record_origin: 'import', event_type: 'BAD.type' })) await rollbackProbe(async () => {
      await expect(admin.query(`UPDATE public.security_events SET ${column}=$1 WHERE id=$2`, [value, id])).rejects.toMatchObject({ code: '23514' })
    })
    await rollbackProbe(async () => {
      await admin.query("UPDATE public.security_events SET event_type='future.valid' WHERE id=$1", [id])
      expect((await admin.query('SELECT event_type FROM public.security_events WHERE id=$1', [id])).rows[0].event_type).toBe('future.valid')
    })
    expect(await repo.planSkipped(id, 'source_not_eligible')).toBe(true)
    for (const [column, value] of Object.entries({ channel: 'email', route_ref: 'https://invalid.example', status: 'delivered', result_code: 'raw_error', retry_safety: 'retry', attempt_no: 6, lease_id: randomUUID() })) await rollbackProbe(async () => {
      await expect(admin.query(`UPDATE public.security_event_deliveries SET ${column}=$1 WHERE event_id=$2`, [value, id])).rejects.toMatchObject({ code: '23514' })
    })
    await rollbackProbe(async () => {
      await expect(admin.query("UPDATE public.security_event_deliveries SET result_code='delivered' WHERE event_id=$1", [id])).rejects.toMatchObject({ code: '23514' })
    })
  })
  it('T03 worst-case legal UTF-8 source key fits the real unique B-tree index', async () => {
    const input = event()
    input.source_id = Array.from({ length: 512 }, (_, i) => String.fromCodePoint(0x10000 + i)).join('')
    // This synthetic value exercises the DB boundary independently of producer source encoders.
    const id = await append()
    await admin.query("UPDATE public.security_events SET source_id=$1,source_step=repeat('a',64),event_type=repeat('a',48)||'.'||repeat('b',47),producer='security_action',source_kind='admin_grant_command' WHERE id=$2", [input.source_id, id])
    expect((await admin.query('SELECT octet_length(source_id) AS bytes FROM public.security_events WHERE id=$1', [id])).rows[0].bytes).toBe(2048)
  })
  it('T04 concurrent duplicate facts converge, changed scope fails, and first expiry is frozen', async () => {
    const input = event()
    const results = await Promise.all([append(input), append({ ...input, id: randomUUID() })])
    expect(results[0]).toBe(results[1])
    const before = (await admin.query('SELECT recorded_at,expires_at FROM public.security_events WHERE id=$1', [results[0]])).rows[0]
    const otherPolicy = new SecurityEventRepository(connections, new W1Capacity(20), { eventDays: 180, deliveryDays: 30 })
    expect(await otherPolicy.appendCommitted({ ...input, record_origin: 'reconcile' }, { kind: 'integration', orgId: 'e1a-org-A' }, 'background')).toMatchObject({ recorded: true, eventId: results[0] })
    expect((await admin.query('SELECT recorded_at,expires_at FROM public.security_events WHERE id=$1', [results[0]])).rows[0]).toEqual(before)
    expect(await repo.appendCommitted(input, { kind: 'integration', orgId: 'e1a-org-B' }, 'background')).toMatchObject({ recorded: false, diagnostic: 'event_identity_conflict' })
  })
  it('T22 repository predicates isolate organization A/B and system before delivery joins', async () => {
    const id = await append()
    await repo.planSkipped(id, 'source_not_eligible')
    await append(event(), 'e1a-org-B')
    await connections.readTransaction(performance.now(), async snapshot => {
      const a = await verifyEventReadScope(snapshot, { scope_kind: 'organization', org_id: 'e1a-org-A' })
      const b = await verifyEventReadScope(snapshot, { scope_kind: 'organization', org_id: 'e1a-org-B' })
      const system = await verifyEventReadScope(snapshot, { scope_kind: 'system', org_id: null })
      expect(await readScopedEvent(snapshot, a, id)).toMatchObject({ id })
      expect(await readScopedEvent(snapshot, b, id)).toBeNull()
      expect(await readScopedEvent(snapshot, system, id)).toBeNull()
      expect(await readScopedDeliveries(snapshot, b, id)).toEqual([])
      const rows = await readScopedDeliveries(snapshot, a, id)
      expect(rows).toHaveLength(1); expect(rows[0]).not.toHaveProperty('lease_id')
    })
  })
  it('T20/T43 real server lock/statement budgets and pool identity do not touch the business pool', async () => {
    const identity = await connections.readTransaction(performance.now(), async () => (await readClient.query("SELECT current_setting('application_name') AS app,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS ro")).rows[0])
    expect(identity).toEqual({ app: 'e1_query', isolation: 'repeatable read', ro: 'on' })
    await connections.readTransaction(performance.now(), async snapshot => {
      await verifyEventReadScope(snapshot, { scope_kind: 'organization', org_id: 'e1a-org-A' })
      const settings = (await readClient.query("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement")).rows[0]
      const milliseconds = (value: string) => parseFloat(value) * (value.endsWith('ms') ? 1 : 1000)
      expect(milliseconds(settings.lock)).toBeGreaterThan(0)
      expect(milliseconds(settings.lock)).toBeLessThanOrEqual(2000)
      expect(milliseconds(settings.statement)).toBeGreaterThan(0)
      expect(milliseconds(settings.statement)).toBeLessThanOrEqual(2000)
    })
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const ready: Promise<void>[] = []
    const backendIds: number[] = []
    const pending = [0, 1, 2].map(() => {
      let entered!: () => void
      ready.push(new Promise<void>(resolve => { entered = resolve }))
      return connections.writeTransaction('background', async sql => {
        backendIds.push((await sql.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        entered()
        await hold
      })
    })
    try {
      await Promise.race([Promise.all(ready), Promise.all(pending)])
      expect(connections.active.write).toBe(3)
      await expect(connections.writeTransaction('background', async () => true)).rejects.toThrow('E1_WRITE_UNAVAILABLE')
      const reader = await connections.readTransaction(performance.now(), async snapshot => {
        expect(connections.active).toEqual({ write: 3, query: 1 })
        const scope = await verifyEventReadScope(snapshot, { scope_kind: 'organization', org_id: 'e1a-org-A' })
        expect(await readScopedEvent(snapshot, scope, rowsOwned[0])).toMatchObject({ id: rowsOwned[0] })
        return (await readClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      })
      const business = (await admin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      expect(new Set([...backendIds, reader, business]).size).toBe(5)
      report.sameInstancePoolIsolation = { writers: 3, readers: 1, distinctBackends: 5, scopedReadSucceeded: true }
    } finally { release(); await Promise.allSettled(pending) }
    const started = performance.now()
    await expect(connections.writeTransaction('foreground', sql => sql.query('SELECT pg_sleep(1)'))).rejects.toThrow('E1_WRITE_UNAVAILABLE')
    expect(performance.now() - started).toBeLessThan(500)
    await admin.query('BEGIN'); await admin.query('LOCK TABLE public.security_events IN ACCESS EXCLUSIVE MODE')
    try {
      const result = await repo.appendCommitted(event(), { kind: 'integration', orgId: 'e1a-org-A' })
      expect(result.recorded).toBe(false)
    } finally { await admin.query('ROLLBACK') }
    expect((await admin.query('SELECT 1 AS business')).rows[0].business).toBe(1)
  })
  it('T26 cleaner preserves active rows, planning tombstones and original evidence', async () => {
    const terminal = await append(), active = await append()
    await repo.planSkipped(terminal, 'source_not_eligible')
    const tombstone = (await admin.query('SELECT delivery_planned_at FROM public.security_events WHERE id=$1', [terminal])).rows[0].delivery_planned_at
    await admin.query("UPDATE public.security_event_deliveries SET created_at=now()-interval '100 days',due_at=now()-interval '100 days',finished_at=now()-interval '100 days',expires_at=now()-interval '1 day' WHERE event_id=$1", [terminal])
    await admin.query("INSERT INTO public.security_event_deliveries (id,event_id,channel,route_ref,attempt_no,status,created_at,due_at,retry_safety,expires_at) VALUES ($1,$2,'group_extension','synthetic.route',1,'queued',now()-interval '400 days',now()-interval '400 days','not_started',now()-interval '1 day')", [randomUUID(), active])
    await admin.query("UPDATE public.security_events SET recorded_at=now()-interval '400 days',expires_at=now()-interval '1 day' WHERE id=$1", [active])
    const result = await repo.cleanup(true, 1000)
    expect(result.activeExpired).toBe(true)
    expect((await admin.query('SELECT id FROM public.security_events WHERE id=$1', [active])).rows).toHaveLength(1)
    expect((await admin.query('SELECT status FROM public.security_event_deliveries WHERE event_id=$1', [active])).rows[0].status).toBe('queued')
    expect((await admin.query('SELECT delivery_planned_at FROM public.security_events WHERE id=$1', [terminal])).rows[0].delivery_planned_at).toEqual(tombstone)
    expect(await repo.planSkipped(terminal, 'source_not_eligible')).toBe(false)
    expect((await admin.query('SELECT id FROM public.security_event_deliveries WHERE event_id=$1', [terminal])).rows).toHaveLength(0)
  })
  it('T35 estimates steady-state storage for N=20000 at 365/90 and 90/90 from measured sample sizes', async () => {
    const ids = Array.from({ length: 1000 }, () => randomUUID())
    rowsOwned.push(...ids)
    await admin.query(`INSERT INTO public.security_events
      (id,scope_kind,org_id,producer,event_type,severity,outcome,actor_kind,source_kind,source_id,source_step,record_origin,occurred_at,expires_at)
      SELECT id,'organization','e1a-org-capacity','directory','directory.projection_observed','info','observed','system','runtime_probe',id::text,'membership_active','live',now(),now()+interval '365 days'
      FROM unnest($1::uuid[]) AS ids(id)`, [ids])
    await admin.query(`INSERT INTO public.security_event_deliveries
      (id,event_id,channel,route_ref,attempt_no,status,result_code,due_at,finished_at,retry_safety,expires_at)
      SELECT gen_random_uuid(),id,'none','none',0,'skipped','source_not_eligible',now(),now(),'not_applicable',now()+interval '90 days'
      FROM unnest($1::uuid[]) AS ids(id)`, [ids])
    const sizes = (await admin.query(`SELECT
      (SELECT avg(pg_column_size(e)) FROM public.security_events e WHERE id=ANY($1::uuid[]))::float AS event_row_bytes,
      (SELECT avg(pg_column_size(d)) FROM public.security_event_deliveries d WHERE event_id=ANY($1::uuid[]))::float AS delivery_row_bytes,
      pg_indexes_size('public.security_events')::float AS event_indexes_bytes,
      pg_indexes_size('public.security_event_deliveries')::float AS delivery_indexes_bytes`, [ids])).rows[0]
    expect(sizes.event_row_bytes).toBeGreaterThan(0)
    expect(sizes.event_indexes_bytes).toBeGreaterThan(0)
    const estimates = [365, 90].map(days => {
      const counts = estimateSteadyState(20000, days, 90, 0)
      return { eventDays: days, deliveryDays: 90, ...counts,
        estimatedRowBytes: counts.events * sizes.event_row_bytes + counts.deliveries * sizes.delivery_row_bytes,
        estimatedIndexBytes: counts.events * sizes.event_indexes_bytes / 1000 + counts.deliveries * sizes.delivery_indexes_bytes / 1000 }
    })
    expect(estimates.map(item => item.total)).toEqual([18200000, 7200000])
    report.capacity = { sampleRows: 1000, sizes, estimates, limitations: 'Sample extrapolation only; page fill, bloat, steady-state p95 and actual sync budget remain unverified.' }
  })
  it('T31/T34 nonempty schema has identical fence and down preserves every row and ledger', async () => {
    const after = await inspectFence()
    expect(after).toEqual(baseline); expect(await currentCatalog()).toEqual(rawBaseline)
    report.afterNonempty = { after, sections: await currentCatalog() }
    const before = (await admin.query('SELECT id,source_id,expires_at,delivery_planned_at FROM public.security_events ORDER BY id')).rows
    const history = (await migrator.getMigrations()).map(item => [item.name, item.executedAt])
    const down = await migrator.migrateDown()
    expect(down.error).toMatchObject({ message: expect.stringContaining('E1_DOWN_BLOCKED') })
    expect((await admin.query('SELECT id,source_id,expires_at,delivery_planned_at FROM public.security_events ORDER BY id')).rows).toEqual(before)
    expect((await migrator.getMigrations()).map(item => [item.name, item.executedAt])).toEqual(history)
  })
  it('T34 only an explicitly emptied synthetic fixture can down; baseline catalog remains exact', async () => {
    await admin.query('DELETE FROM public.security_event_deliveries WHERE event_id=ANY($1::uuid[])', [rowsOwned])
    await admin.query('DELETE FROM public.security_events WHERE id=ANY($1::uuid[])', [rowsOwned])
    expect((await admin.query('SELECT count(*)::int AS n FROM public.security_events')).rows[0].n).toBe(0)
    const result = await migrator.migrateDown()
    expect(result.error).toBeUndefined()
    expect(result.results).toEqual([expect.objectContaining({ migrationName, status: 'Success', direction: 'Down' })])
    expect(await inspectFence()).toEqual(baseline)
    expect(await currentCatalog()).toEqual(rawBaseline)
    report.completed = true
  })
})
