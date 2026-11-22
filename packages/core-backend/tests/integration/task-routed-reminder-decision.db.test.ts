/** Real routing SQL and resolvers in an owned schema; adapters never send or access the network. */
import '../helpers/assert-rbac-optional-off'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Pool } from 'pg'
import express from 'express'
import request from 'supertest'
import { createAdminDirectoryNotificationRouter } from '../../src/routes/admin-directory-notification'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { up as upDirectory } from '../../src/db/migrations/zzzz20260324150000_create_directory_sync_tables'
import { up as upDirectoryKeys } from '../../src/db/migrations/zzzz20260717120000_create_provider_org_transfers'
import { up as upCapabilities } from '../../src/db/migrations/zzzz20261106130000_create_directory_integration_capabilities'
import { up as upEndpoints } from '../../src/db/migrations/zzzz20261111093417_create_user_notification_endpoints_preferences'
import { up as upVerification } from '../../src/db/migrations/zzzz20261121130000_create_notification_verifications_test_sends'
import * as policyMigration from '../../src/db/migrations/zzzz20261122151000_create_notification_topic_policies'
import * as decisionMigration from '../../src/db/migrations/zzzz20261122151100_create_task_notification_decisions'
import { resolveEffectiveNotificationCapabilityForBackground } from '../../src/integrations/integration-capability-resolve-background'
import { resolveEffectiveIntegrationCapability } from '../../src/integrations/integration-capability-resolve'
import { DingTalkWorkNotificationAdapter } from '../../src/notifications/adapters/dingtalk-work-notification-adapter'
import { __notificationAdapterRegistryForTests } from '../../src/notifications/adapters/notification-adapter'
import { insertRoutedReminderDeliveries, ROUTED_BRANCH_MAX_STATEMENTS_BETWEEN_HEARTBEATS, type RoutingTransaction } from '../../src/services/task-routed-reminders'
import { runTaskReminderScan, type TaskSchedulerJobContext } from '../../src/services/task-scheduler'
import { createTopicPolicyService } from '../../src/notifications/topic-policy-service'
import { createRecipientResolver } from '../../src/notifications/recipient-resolver'
import { checkNotificationVerification } from '../../src/notifications/verification-evidence'
import { findActiveOrgMembers } from '../../src/services/task-org-members'
import { createTopicTakeoverReader } from '../../src/services/task-notification-takeover'

const topicFixture = vi.hoisted(() => ({ integrated: true }))
// Exercise first-takeover prerequisites with the future integration marker, without enabling it in production.
vi.mock('../../src/notifications/topic-registry', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/notifications/topic-registry')>()
  return { ...original, resolveNotificationTopic: (topic: string) => {
    const descriptor = original.resolveNotificationTopic(topic)
    return descriptor && topicFixture.integrated ? { ...descriptor, integrated: true } : descriptor
  } }
})

if (process.env.EXPECT_DB !== '1' || !process.env.DATABASE_URL) throw new Error('task routed decision tests require EXPECT_DB=1 and DATABASE_URL')
const SCHEMA = `n78_routing_${randomUUID().replaceAll('-', '')}`
const CONTRACT_SCHEMA = `${SCHEMA}_contract`
const ORG = 'fixture-routing-org'
const NOW = new Date('2040-01-01T12:00:00Z')
const FLAGS = { TASKS_SCHEDULER_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true',
  TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true', USER_NOTIFICATION_PREFERENCES_ENABLED: 'true', EXTERNAL_NOTIFICATION_DELIVERY_ENABLED: 'true' }
const CLONED = ['user_orgs', 'user_roles', 'tasks', 'task_assignees', 'task_events', 'task_notification_deliveries']
let admin: Pool, pool: Pool, migrations: Kysely<unknown>, connectionId: string
let outboxBefore: unknown[]
const expectedCatalog = new Map<string, unknown[]>()
const statements: string[] = []
const db = { query: async (text: string, params?: unknown[]) => { statements.push(text); return pool.query(text, params) } }
const transaction: RoutingTransaction = async fn => {
  const client = await pool.connect()
  try {
    statements.push('BEGIN ISOLATION LEVEL READ COMMITTED'); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const result = await fn({ query: (text, params) => { statements.push(text); return client.query(text, params) } })
    await client.query('COMMIT'); statements.push('COMMIT'); return result
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
const context = (): TaskSchedulerJobContext => ({ now: () => NOW, stopping: () => false, leaderLost: () => false,
  leaderHeartbeat: async () => { statements.push('HEARTBEAT') } })
async function scan(env = FLAGS) {
  const reader = createTopicTakeoverReader()
  return runTaskReminderScan(context(), { env, query: db.query, transaction, takeover: org => reader(db, org), logger: { warn: vi.fn(), info: vi.fn() } })
}
async function seed(count = 2, orgId = ORG, takenOver = true, orderPrefix = '') {
  const key = orderPrefix + randomUUID().replaceAll('-', '')
  const user = (index: number) => `${key}-user-${index}`
  const task = (index: number) => `${key}-task-${index}`
  const integration = await pool.query(`INSERT INTO directory_integrations(org_id, provider, name, status, corp_id, config)
    VALUES ($1, 'dingtalk', 'Synthetic routing', 'active', 'FixtureTenant', '{"appKey":"FixtureApplication"}') RETURNING id`, [orgId])
  connectionId = integration.rows[0].id
  await pool.query(`INSERT INTO directory_integration_capabilities(integration_id,bound_provider,bound_org_id,
    notification_enabled,notification_bound_tenant,notification_bound_app_scope,created_by,updated_by)
    VALUES ($1,'dingtalk',$2,true,'FixtureTenant','FixtureApplication','fixture-admin','fixture-admin')`, [connectionId, orgId])
  await pool.query(`INSERT INTO notification_connection_verifications(connection_id,provider,reached_level,tuple_fingerprint,
    bound_tenant,bound_app_scope,verified_by,verified_at)
    VALUES ($1,'dingtalk','token',$2,'FixtureTenant','FixtureApplication','fixture-admin',$3)`, [connectionId, 'f'.repeat(64), NOW])
  await pool.query(`INSERT INTO users(id,email,password_hash,role,is_active,activation_status)
    SELECT $1 || '-user-' || n,$1 || '-user-' || n || '@fixture.invalid','x','user',true,'activated' FROM generate_series(0,$2::integer-1) n`, [key, count])
  await pool.query(`INSERT INTO user_orgs(user_id,org_id,is_active) SELECT $1 || '-user-' || n,$2,true FROM generate_series(0,$3::integer-1) n`, [key, orgId, count])
  await pool.query(`WITH a AS (INSERT INTO directory_accounts(integration_id,provider,corp_id,external_user_id,external_key,name,is_active)
    SELECT $1,'dingtalk','FixtureTenant',$2 || '-address-' || n,$2 || '-external-' || n,'Synthetic account',true FROM generate_series(0,$3::integer-1) n
    RETURNING id,external_user_id)
    INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status)
    SELECT id, replace(external_user_id,'-address-','-user-'),'linked' FROM a`, [connectionId, key, count])
  const taskCount = Math.ceil(count / 2)
  await pool.query(`INSERT INTO tasks(id,org_id,title,created_by,remind_at)
    SELECT $1 || '-task-' || n,$2,'Synthetic reminder',$1 || '-user-0',$3 FROM generate_series(0,$4::integer-1) n`, [key, orgId, NOW, taskCount])
  await pool.query(`INSERT INTO task_assignees(task_id,user_id) SELECT $1 || '-task-' || (n / 2),$1 || '-user-' || n FROM generate_series(0,$2::integer-1) n`, [key, count])
  await pool.query(`INSERT INTO task_events(id,task_id,actor_id,event_type,occurred_at)
    SELECT $1 || '-event-' || n,$1 || '-task-' || n,$1 || '-user-0','created',$2 FROM generate_series(0,$3::integer-1) n`, [key, new Date(NOW.getTime() - 1000), taskCount])
  if (takenOver) await pool.query(`INSERT INTO org_notification_topic_policies(org_id,topic,state,default_connection_id,created_by,updated_by)
    VALUES ($1,'task_reminder','active',$2,'fixture-admin','fixture-admin')`, [orgId, connectionId])
  return { user, task, connectionId, orgId }
}
const resolver = createRecipientResolver({ isActiveOrgMembers: findActiveOrgMembers })
function policyService(policyTransaction = transaction) {
  return createTopicPolicyService({ db, transaction: policyTransaction, resolver, isActiveOrgMembers: findActiveOrgMembers,
    audit: async () => {}, deliveryEnabled: () => true,
    verification: (db, input) => checkNotificationVerification(db, { ...input,
      scope: { tenant: 'FixtureTenant', appScope: 'FixtureApplication' }, tupleFingerprint: 'f'.repeat(64), now: NOW }),
  })
}
async function explicitEndpoint(orgId: string, userId: string, integrationId: string) {
  const result = await resolver.deriveDefaultTarget(pool, { orgId, userId, connectionId: integrationId })
  if (result.ok === false) throw new Error(result.code)
  const t = result.target
  const endpoint = (await pool.query(`INSERT INTO user_notification_endpoints
    (org_id,user_id,connection_id,provider,address_kind,proof_kind,proof_id,proof_witness,address_witness,tenant_address_witness,bound_tenant,bound_app_scope)
    VALUES ($1,$2,$3,'dingtalk','dingtalk_userid','directory_link',$4,$5,$6,$7,$8,$9) RETURNING id`,
  [orgId,userId,integrationId,t.proofId,t.proofWitness,t.addressWitness,t.tenantAddressWitness,t.boundTenant,t.boundAppScope])).rows[0].id
  await pool.query(`INSERT INTO user_notification_preferences(org_id,user_id,topic,primary_endpoint_id,updated_by)
    VALUES ($1,$2,'task_reminder',$3,$2)`, [orgId,userId,endpoint])
  return endpoint
}
const counts = async () => (await pool.query(`SELECT (SELECT count(*)::integer FROM task_notification_deliveries) AS outbox,
  (SELECT count(*)::integer FROM task_notification_delivery_decisions) AS decisions`)).rows[0]
const catalog = async (table: string, schema = SCHEMA) => (await pool.query(`SELECT conname AS name, pg_get_constraintdef(oid,true) AS definition
  FROM pg_constraint WHERE conrelid=to_regclass($1)
  UNION ALL SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$2 AND tablename=$3 ORDER BY name,definition`,
[`${schema}.${table}`, schema, table])).rows.map(row => ({ ...row, definition: row.definition.replaceAll(`${schema}.`, '') }))

beforeAll(async () => {
  admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  // The full lane has already installed extensions; never install one into the scratch schema.
  expect((await admin.query("SELECT 1 FROM pg_extension WHERE extname='pgcrypto'")).rows).toHaveLength(1)
  await admin.query(`CREATE SCHEMA "${SCHEMA}"`)
  await admin.query(`CREATE SCHEMA "${CONTRACT_SCHEMA}"`)
  const options = `-c search_path=${SCHEMA},pg_catalog`
  pool = new Pool({ connectionString: process.env.DATABASE_URL, options, max: 8 })
  migrations = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL, options, max: 1 }) }) })
  await migrations.transaction().execute(async trx => {
    await sql`CREATE TABLE users (LIKE public.users INCLUDING ALL)`.execute(trx)
    await upDirectory(trx); await upDirectoryKeys(trx); await upCapabilities(trx)
    await upEndpoints(trx); await upVerification(trx)
    // Current migrated task shapes are isolated without their pre-existing cross-table triggers/FKs.
    // The two new migrations are applied unchanged and their real FKs remain enabled throughout.
    for (const table of CLONED) await sql.raw(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`).execute(trx)
  })
  const reference = await pool.connect()
  try {
    await reference.query('BEGIN')
    await reference.query(`SET LOCAL search_path="${CONTRACT_SCHEMA}",pg_catalog`)
    await reference.query('CREATE TABLE directory_integrations (id uuid,org_id text,UNIQUE(id,org_id)); CREATE TABLE task_notification_deliveries (id uuid PRIMARY KEY)')
    await reference.query(readFileSync(path.resolve(__dirname, '../fixtures/notification-routing-schema-contract.sql'), 'utf8'))
    await reference.query('COMMIT')
  } catch (error) { await reference.query('ROLLBACK'); throw error } finally { reference.release() }
  for (const table of ['org_notification_topic_policies', 'task_notification_delivery_decisions']) expectedCatalog.set(table, await catalog(table, CONTRACT_SCHEMA))
  outboxBefore = await catalog('task_notification_deliveries')
  await migrations.transaction().execute(async trx => { await policyMigration.up(trx); await decisionMigration.up(trx) })
}, 120_000)
beforeEach(() => {
  topicFixture.integrated = true
  vi.stubEnv('DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED', 'true')
  __notificationAdapterRegistryForTests.replace(new Map([['dingtalk', { provider: 'dingtalk', transport: 'work_notification',
    fingerprint: async () => ({ ok: true as const, value: 'f'.repeat(64) }), prepare: async () => { throw new Error('scan must never send') } }]]))
  statements.length = 0
})
afterEach(async () => {
  __notificationAdapterRegistryForTests.restore(); vi.unstubAllEnvs()
  await pool.query(`TRUNCATE task_notification_deliveries,task_notification_delivery_decisions,org_notification_topic_policies,
    task_events,task_assignees,tasks,user_orgs,user_roles,notification_connection_verifications,notification_test_sends,
    user_notification_preferences,user_notification_endpoints,directory_integration_capabilities,directory_integration_capability_history,
    directory_account_links,directory_accounts,directory_integrations,users CASCADE`)
})
afterAll(async () => {
  await migrations?.destroy(); await pool?.end()
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`); await admin.query(`DROP SCHEMA IF EXISTS "${CONTRACT_SCHEMA}" CASCADE`); await admin.end() }
})

describe('N78 routed reminder decisions (real PostgreSQL)', () => {
  it('A-D01 enforces policy revision CAS, state transitions and same-org default FK', async () => {
    const f = await seed()
    expect((await pool.query("UPDATE org_notification_topic_policies SET state='paused',revision=revision+1 WHERE org_id=$1 AND revision=1 RETURNING revision", [ORG])).rows).toHaveLength(1)
    expect((await pool.query("UPDATE org_notification_topic_policies SET state='active' WHERE org_id=$1 AND revision=1 RETURNING revision", [ORG])).rows).toHaveLength(0)
    await expect(pool.query("INSERT INTO org_notification_topic_policies(org_id,topic,state,default_connection_id,created_by,updated_by) VALUES ('foreign','task_reminder','active',$1,'actor','actor')", [f.connectionId])).rejects.toMatchObject({ code: '23503' })
    await expect(migrations.transaction().execute(policyMigration.down)).rejects.toThrow('NOTIFICATION_ROUTING_DOWN_BLOCKED')
  })
  it('A-D02 persists one decision per recipient under repeated and concurrent scans', async () => {
    await seed(); await Promise.all([scan(), scan()]); expect(await counts()).toEqual({ outbox: 2, decisions: 2 })
    await scan(); expect(await counts()).toEqual({ outbox: 2, decisions: 2 })
    expect((await pool.query('SELECT DISTINCT channel,status FROM task_notification_deliveries')).rows).toEqual([{ channel: 'routed_dingtalk_work_notification', status: 'pending' }])
  })
  it('A-D02 opt-out is terminal for this event even after the preference changes', async () => {
    const f = await seed(1)
    await pool.query("INSERT INTO user_notification_preferences(org_id,user_id,topic,enabled,updated_by) VALUES ($1,$2,'task_reminder',false,$2)", [ORG, f.user(0)])
    await scan()
    expect((await pool.query('SELECT reason FROM task_notification_delivery_decisions')).rows).toEqual([{ reason: 'user_opted_out' }])
    await pool.query('UPDATE user_notification_preferences SET enabled=true'); await scan()
    expect(await counts()).toEqual({ outbox: 1, decisions: 1 })
  })
  it.each(['paused', 'switch_off'])('A-D02 %s pauses without legacy fallback', async mode => {
    await seed()
    if (mode === 'paused') await pool.query("UPDATE org_notification_topic_policies SET state='paused'")
    await scan(mode === 'switch_off' ? { ...FLAGS, EXTERNAL_NOTIFICATION_DELIVERY_ENABLED: 'false' } : FLAGS)
    expect(await counts()).toEqual({ outbox: 0, decisions: 0 })
  })
  it.each(['no_route', 'quiet_hours', 'recipient_not_permitted'])('A-D02 persists the terminal %s business decision', async reason => {
    const f = await seed(1)
    if (reason === 'no_route') await pool.query('UPDATE org_notification_topic_policies SET default_connection_id=NULL')
    if (reason === 'recipient_not_permitted') await pool.query('UPDATE users SET is_active=false')
    if (reason === 'quiet_hours') await pool.query(`INSERT INTO user_notification_preferences(org_id,user_id,topic,quiet_start,quiet_end,quiet_timezone,updated_by)
      VALUES ($1,$2,'task_reminder','11:00','13:00','UTC',$2)`, [ORG,f.user(0)])
    await scan()
    expect((await pool.query('SELECT reason FROM task_notification_delivery_decisions')).rows).toEqual([{ reason }])
    expect((await pool.query('SELECT channel,status,last_error FROM task_notification_deliveries')).rows)
      .toEqual([{ channel: 'routed_decision', status: 'skipped', last_error: reason }])
  })
  it('A-D02 an unreadable capability writes nothing and the next enabled tick decides', async () => {
    await seed(1); vi.stubEnv('DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED','false')
    await scan(); expect(await counts()).toEqual({ outbox: 0, decisions: 0 })
    vi.stubEnv('DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED','true')
    await scan(); expect(await counts()).toEqual({ outbox: 1, decisions: 1 })
  })
  it('A-D03 legacy source-key ownership prevents a routed decision regardless of payload text', async () => {
    const f = await seed(1)
    const source = `task_reminder:${f.task(0)}:${NOW.toISOString()}:recipient:${f.user(0)}:channel:dingtalk_work_notification`
    await pool.query(`INSERT INTO task_notification_deliveries(org_id,source_type,source_id,source_key,recipient_user_id,recipient_role,channel,payload)
      VALUES ($1,'task_reminder',$2,$3,$4,'assignee','dingtalk_work_notification','{"remindAt":"different representation"}')`, [ORG, f.task(0), source, f.user(0)])
    await scan(); expect(await counts()).toEqual({ outbox: 1, decisions: 0 })
  })
  it('A-D04 and A-D16 persist address-free background witnesses and distinguish authenticated witnesses', async () => {
    const f = await seed(1); await scan()
    const row = (await pool.query('SELECT * FROM task_notification_delivery_decisions')).rows[0]
    const pair = await transaction(async client => {
      await client.query("SET LOCAL lock_timeout='2s'"); await client.query("SET LOCAL statement_timeout='5s'")
      const queryable = { query: async (text: string, params?: unknown[]) => { const result = await client.query(text, params); return { rows: result.rows, rowCount: result.rows.length } } }
      return [await resolveEffectiveNotificationCapabilityForBackground(queryable, { integrationId: f.connectionId, eventOrgId: ORG }),
        await resolveEffectiveIntegrationCapability(queryable, { integrationId: f.connectionId, capability: 'notification', expectedOrgId: ORG })]
    })
    expect(pair[0]).toMatchObject({ effective: true, orgSource: 'background_event_row', witness: row.capability_witness })
    expect(pair[1]).toMatchObject({ effective: true, orgSource: 'authenticated_tenant' })
    expect(pair[1].effective && pair[1].witness).not.toBe(row.capability_witness)
    const independentWitness = (parts: string[]) => {
      const hash = createHash('sha256')
      for (const part of parts) {
        const bytes = Buffer.from(part, 'utf8'); const size = Buffer.alloc(4)
        size.writeUInt32BE(bytes.length); hash.update(size); hash.update(bytes)
      }
      return hash.digest('hex')
    }
    const version = 'metasheet.directory-integration-capability-witness.v1'
    expect(independentWitness([version, 'background_event_row', '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      'org-alpha', 'dingtalk', 'active', 'notification', '17', 'CorpOne', 'AppOne']))
      .toBe('cfd57e6fd6992de1c6ed9d15df41f047e6872af0a1d14070e449f37359c2f722')
    expect(row.capability_witness).toBe(independentWitness([version, 'background_event_row', f.connectionId,
      ORG, 'dingtalk', 'active', 'notification', String(row.capability_revision), 'FixtureTenant', 'FixtureApplication']))
    const addresses = await pool.query('SELECT external_user_id FROM directory_accounts')
    for (const address of addresses.rows) expect(JSON.stringify(row)).not.toContain(address.external_user_id)
  })
  it('A-D05 deleting outbox rows cascades decisions and rejects nonempty down', async () => {
    await seed(); await scan()
    await expect(migrations.transaction().execute(decisionMigration.down)).rejects.toThrow('NOTIFICATION_ROUTING_DOWN_BLOCKED')
    await pool.query('DELETE FROM task_notification_deliveries'); expect(await counts()).toEqual({ outbox: 0, decisions: 0 })
  })
  it('A-D06 missing policy relation reproduces byte-identical legacy writes', async () => {
    const f = await seed(1, ORG, false)
    await pool.query('ALTER TABLE org_notification_topic_policies RENAME TO hidden_policy')
    try {
      statements.length = 0; await scan()
      expect(await counts()).toEqual({ outbox: 1, decisions: 0 })
      expect(statements.filter(text => /(?:FROM|JOIN|INSERT INTO|UPDATE) (?:org_notification|task_notification_delivery_decisions|user_notification)/.test(text))).toEqual([])
      const row = (await pool.query('SELECT * FROM task_notification_deliveries')).rows[0]
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(row.created_at).toBeInstanceOf(Date)
      expect(row.updated_at).toEqual(row.created_at); expect(row.next_attempt_at).toEqual(row.created_at)
      const { id, created_at, updated_at, next_attempt_at, ...stable } = row
      expect(stable).toEqual({ org_id: ORG, source_type: 'task_reminder', source_id: f.task(0),
        source_key: `task_reminder:${f.task(0)}:${NOW.toISOString()}:recipient:${f.user(0)}:channel:dingtalk_work_notification`,
        recipient_user_id: f.user(0), recipient_role: 'assignee', channel: 'dingtalk_work_notification', status: 'pending',
        attempt_count: 0, last_attempt_at: null, claimed_at: null, claim_expires_at: null, claim_worker_id: null,
        delivered_at: null, last_error: null, redelivery_safe: false,
        payload: { kind: 'task_reminder', taskId: f.task(0), remindAt: NOW.toISOString() },
      })
    } finally { await pool.query('ALTER TABLE hidden_policy RENAME TO org_notification_topic_policies') }
  })
  it('A-D08 one routed CTE FK failure leaves no half-pair and other organizations still progress', async () => {
    const f = await seed(1, ORG, true, '00-')
    await pool.query("INSERT INTO user_notification_preferences(org_id,user_id,topic,enabled,updated_by) VALUES ($1,$2,'task_reminder',false,$2)", [ORG, f.user(0)])
    const data = { recipient: { orgId: ORG, userId: f.user(0), taskId: f.task(0), remindAt: NOW.toISOString(), role: 'assignee',
      eventKey: `task_reminder:${f.task(0)}:${NOW.toISOString()}`, legacySourceKey: 'absent' },
      decision: { kind: 'skip' as const, code: 'user_opted_out' as const, excluded: [], policyRevision: 1, preferenceRevision: 1 } }
    await insertRoutedReminderDeliveries(pool, [data], NOW)
    // An outbox-only source-key collision: the new decision's generated id has no parent on conflict.
    await pool.query('DELETE FROM task_notification_delivery_decisions')
    await expect(insertRoutedReminderDeliveries(pool, [data], NOW)).rejects.toMatchObject({ code: '23503' })
    expect(await counts()).toEqual({ outbox: 1, decisions: 0 })
    await seed(1, 'fixture-independent', true, '10-'); await seed(1, 'fixture-legacy', false, '20-')
    expect((await pool.query('SELECT org_id FROM tasks ORDER BY remind_at,id')).rows.map(row => row.org_id))
      .toEqual([ORG, 'fixture-independent', 'fixture-legacy'])
    const reader = createTopicTakeoverReader(); const warn = vi.fn()
    expect((await runTaskReminderScan(context(), { env: FLAGS, query: db.query, transaction,
      takeover: org => reader(db, org), logger: { warn, info: vi.fn() } })).written).toBe(2)
    expect(warn).toHaveBeenCalledWith('routed_branch_error')
    expect((await pool.query('SELECT org_id FROM task_notification_delivery_decisions')).rows).toEqual([{ org_id: 'fixture-independent' }])
    expect((await pool.query("SELECT channel FROM task_notification_deliveries WHERE org_id='fixture-legacy'")).rows).toEqual([{ channel: 'dingtalk_work_notification' }])
  })
  it('A-D09 separate organization and recipient columns do not collide on delimiters', async () => {
    const records = [['a|b', 'c'], ['a', 'b|c']].map(([orgId, userId]) => ({ recipient: { orgId, userId, taskId: 'fixture', role: 'assignee', eventKey: 'same-event', remindAt: NOW.toISOString(), legacySourceKey: 'legacy' },
      decision: { kind: 'skip' as const, code: 'no_route' as const, excluded: [], policyRevision: 1, preferenceRevision: null } }))
    for (const record of records) await insertRoutedReminderDeliveries(pool, [record], NOW)
    expect(await counts()).toEqual({ outbox: 2, decisions: 2 })
  })
  it('A-D07 unreadable takeover pauses both organizations and emits exactly one warning per tick', async () => {
    await seed(1); await seed(1, 'fixture-second', false)
    const warn = vi.fn()
    const reader = createTopicTakeoverReader()
    const unreadable = { query: async (text: string, params?: unknown[]) => {
      if (!text.includes('FROM org_notification_topic_policies')) return db.query(text, params)
      const client = await pool.connect()
      try {
        await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='1ms'")
        return await client.query(`WITH delay AS MATERIALIZED (SELECT pg_sleep(0.05)) SELECT p.* FROM delay LEFT JOIN LATERAL (${text}) p ON true`, params)
      } finally { await client.query('ROLLBACK'); client.release() }
    } }
    await runTaskReminderScan(context(), { env: FLAGS, query: db.query, transaction,
      takeover: org => reader(unreadable, org), logger: { warn, info: vi.fn() } })
    expect(await counts()).toEqual({ outbox: 0, decisions: 0 })
    expect(warn.mock.calls).toEqual([['notification_takeover_unreadable']])
  })
  it.each(['task_notification_delivery_decisions', 'org_notification_topic_policies'])('A-D10 a real SELECT timeout on %s aborts first takeover', async table => {
    const f = await seed(1, 'default', false)
    const timed: RoutingTransaction = fn => transaction(client => fn({ query: async (text, params) => {
      if (text.includes(`FROM ${table}`)) {
        await client.query("SET LOCAL statement_timeout='1ms'")
        return client.query(`WITH delay AS MATERIALIZED (SELECT pg_sleep(0.05)) SELECT p.* FROM delay LEFT JOIN LATERAL (${text}) p ON true`, params)
      }
      return client.query(text, params)
    } }))
    await expect(policyService(timed).put({ actorId: f.user(0), authenticatedTenantId: 'default' }, 'task_reminder',
      { expectedRevision: 0, state: 'active', defaultConnectionId: null, confirmNoDefaultConnection: true })).rejects.toMatchObject({ code: '57014' })
    expect((await pool.query('SELECT * FROM org_notification_topic_policies')).rows).toEqual([])
  })
  it('A-D10 first takeover checks four tables, explicit confirmation, CAS and active membership', async () => {
    const f = await seed(1, 'default', false); const service = policyService()
    const actor = { actorId: f.user(0), authenticatedTenantId: 'default' }
    await expect(service.put(actor, 'task_reminder', { expectedRevision: 0, state: 'active', defaultConnectionId: null })).rejects.toMatchObject({ code: 'DEFAULT_CONNECTION_CONFIRM_REQUIRED' })
    for (const table of ['org_notification_topic_policies', 'task_notification_delivery_decisions', 'user_notification_endpoints', 'user_notification_preferences']) {
      await pool.query(`ALTER TABLE ${table} RENAME TO hidden_relation`)
      try { await expect(service.put(actor, 'task_reminder', { expectedRevision: 0, state: 'active', defaultConnectionId: null, confirmNoDefaultConnection: true })).rejects.toMatchObject({ code: 'NOTIFICATION_SCHEMA_UNAVAILABLE' }) }
      finally { await pool.query(`ALTER TABLE hidden_relation RENAME TO ${table}`) }
    }
    expect(await service.put(actor, 'task_reminder', { expectedRevision: 0, state: 'active', defaultConnectionId: null, confirmNoDefaultConnection: true })).toMatchObject({ revision: 1, defaultConnectionId: null })
    expect(await service.put(actor, 'task_reminder', { expectedRevision: 1, state: 'paused' })).toMatchObject({ revision: 2, state: 'paused' })
    await expect(service.put(actor, 'task_reminder', { expectedRevision: 1, state: 'active' })).rejects.toMatchObject({ code: 'POLICY_STALE' })
    await pool.query('UPDATE users SET is_active=false')
    await expect(service.put(actor, 'task_reminder', { expectedRevision: 2, state: 'active', defaultConnectionId: f.connectionId })).rejects.toMatchObject({ code: 'ORG_MISMATCH' })
  })
  it('A-D10 preview batches 1200 members, detects changed explicit proofs and never writes', async () => {
    const f = await seed(1200, 'default', false)
    await explicitEndpoint('default', f.user(0), f.connectionId)
    await pool.query("UPDATE directory_accounts SET union_id='changed-proof' WHERE external_user_id LIKE '%-address-0'")
    const service = policyService(); statements.length = 0
    const preview = await service.preview({ actorId: f.user(0), authenticatedTenantId: 'default' }, 'task_reminder', null)
    expect(preview).toMatchObject({ member_count: 1200, truncated: false, no_route_count: 1199, no_valid_target_count: 1, proof_changed_endpoint_count: 1 })
    expect(statements.filter(text => text.includes('FROM user_notification_preferences'))).toHaveLength(3)
    expect(statements.some(text => /INSERT|UPDATE|DELETE/.test(text))).toBe(false)
    statements.length = 0
    expect(JSON.stringify(await service.list())).not.toContain('proof_changed_endpoint_count')
    expect(statements.some(text => text.includes('user_notification_endpoints'))).toBe(false)
  }, 120_000)
  it('A-D11 a locked middle connection defers only its recipient and keeps endpoint ownership aligned', async () => {
    const f = await seed(3)
    const other = await pool.query(`INSERT INTO directory_integrations(org_id,provider,name,status,corp_id,config)
      VALUES ($1,'dingtalk','Synthetic other','active','OtherTenant','{"appKey":"OtherApplication"}') RETURNING id`, [ORG])
    const second = other.rows[0].id
    await pool.query(`INSERT INTO directory_integration_capabilities(integration_id,bound_provider,bound_org_id,
      notification_enabled,notification_bound_tenant,notification_bound_app_scope,created_by,updated_by)
      VALUES ($1,'dingtalk',$2,true,'OtherTenant','OtherApplication','actor','actor')`, [second,ORG])
    await pool.query(`WITH a AS (INSERT INTO directory_accounts(integration_id,provider,corp_id,external_user_id,external_key,name,is_active)
      VALUES ($1,'dingtalk','OtherTenant','other-address','other-external','Synthetic other',true) RETURNING id)
      INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status) SELECT id,$2,'linked' FROM a`, [second,f.user(1)])
    const endpoints = [await explicitEndpoint(ORG,f.user(0),f.connectionId), await explicitEndpoint(ORG,f.user(1),second), await explicitEndpoint(ORG,f.user(2),f.connectionId)]
    const locker = await pool.connect()
    try {
      await locker.query('BEGIN'); await locker.query('SELECT id FROM directory_integrations WHERE id=$1 FOR UPDATE', [second])
      expect((await scan()).written).toBe(2)
      const rows = (await pool.query(`SELECT o.recipient_user_id,d.recipient_user_id AS decision_user,d.endpoint_id
        FROM task_notification_deliveries o JOIN task_notification_delivery_decisions d ON d.delivery_id=o.id ORDER BY o.recipient_user_id`)).rows
      expect(rows).toEqual([
        { recipient_user_id: f.user(0), decision_user: f.user(0), endpoint_id: endpoints[0] },
        { recipient_user_id: f.user(2), decision_user: f.user(2), endpoint_id: endpoints[2] },
      ])
    } finally { await locker.query('ROLLBACK'); locker.release() }
  }, 15_000)
  it('A-D17 foreign integration is refused by both the real policy FK and background authority', async () => {
    const a = await seed(1); const b = await seed(1, 'fixture-foreign')
    await expect(pool.query('UPDATE org_notification_topic_policies SET default_connection_id=$1 WHERE org_id=$2', [b.connectionId,a.orgId])).rejects.toMatchObject({ code: '23503' })
    const decision = await transaction(async client => {
      await client.query("SET LOCAL lock_timeout='2s'"); await client.query("SET LOCAL statement_timeout='5s'")
      return resolveEffectiveNotificationCapabilityForBackground({ query: async (text, params) => { const result = await client.query(text,params); return { rows: result.rows,rowCount: result.rows.length } } }, { integrationId: b.connectionId,eventOrgId: a.orgId })
    })
    expect(decision).toEqual({ effective: false, reason: 'integration_missing' })
  })
  it('A-D12 drains 500 tasks and 1000 recipients in one tick, then performs no resolver reads or inserts', async () => {
    await seed(1000); statements.length = 0
    expect((await scan()).written).toBe(1000)
    let n = 0
    for (const statement of [...statements, 'HEARTBEAT']) {
      if (statement === 'HEARTBEAT') { expect(n).toBeLessThanOrEqual(ROUTED_BRANCH_MAX_STATEMENTS_BETWEEN_HEARTBEATS); n = 0 } else n++
    }
    statements.length = 0; await scan()
    expect(statements.some(text => /FROM user_notification|FROM directory_account|INSERT INTO/.test(text))).toBe(false)
    expect(await counts()).toEqual({ outbox: 1000, decisions: 1000 })
  }, 120_000)
  it('A-D13 up and down restore nondefault migration timeouts within the same transaction', async () => {
    await migrations.transaction().execute(async trx => {
      await sql`SET LOCAL lock_timeout='7s'`.execute(trx); await sql`SET LOCAL statement_timeout='42s'`.execute(trx)
      await decisionMigration.down(trx); await policyMigration.down(trx)
      await policyMigration.up(trx); await decisionMigration.up(trx)
      expect((await sql`SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout`.execute(trx)).rows)
        .toEqual([{ lock_timeout: '7s', statement_timeout: '42s' }])
    })
  })
  it.each([
    ["route_source='other'"], ["verification_level='other'"], ["excluded='{}'::jsonb"], ["fallback='[]'::jsonb"],
    ["endpoint_revision=1"], ["bound_app_scope=repeat('x',257)"], ["capability_witness='not-a-witness'"], ["rank=1,depends_on_delivery_id=delivery_id,fallback='{}'::jsonb"],
  ])('A-D14 refuses invalid decision metadata: %s', async assignment => {
    await seed(1); await scan()
    await expect(pool.query(`UPDATE task_notification_delivery_decisions SET ${assignment}`)).rejects.toMatchObject({ code: '23514' })
  })
  it('A-D14 skip rows cannot retain a target witness', async () => {
    await insertRoutedReminderDeliveries(pool, [{ recipient: { orgId: ORG, userId: 'fixture', taskId: 'fixture', remindAt: NOW.toISOString(), role: 'creator', eventKey: 'event', legacySourceKey: 'legacy' },
      decision: { kind: 'skip', code: 'no_route', excluded: [], policyRevision: 1, preferenceRevision: null } }], NOW)
    await expect(pool.query("UPDATE task_notification_delivery_decisions SET address_witness=repeat('a',64)")).rejects.toMatchObject({ code: '23514' })
  })
  it('A-D15 compares every constraint and index against the frozen independent DDL contract', async () => {
    expect(await catalog('task_notification_deliveries')).toEqual(outboxBefore)
    for (const table of ['org_notification_topic_policies', 'task_notification_delivery_decisions']) {
      expect(await catalog(table)).toEqual(expectedCatalog.get(table))
    }
  })
})

it('A-D10 production topic marker refuses first takeover without a policy write', async () => {
  const f = await seed(1, 'default', false); topicFixture.integrated = false
  await expect(policyService().put({ actorId: f.user(0), authenticatedTenantId: 'default' }, 'task_reminder',
    { expectedRevision: 0, state: 'active', defaultConnectionId: null, confirmNoDefaultConnection: true }))
    .rejects.toMatchObject({ status: 409, code: 'TOPIC_NOT_INTEGRATED' })
  expect((await pool.query('SELECT * FROM org_notification_topic_policies')).rows).toEqual([])
  expect(await counts()).toEqual({ outbox: 0, decisions: 0 })
})
it('A-D04 org_default witnesses remain bound to each of two recipients', async () => {
  const f = await seed(2); await scan()
  const rows = (await pool.query('SELECT * FROM task_notification_delivery_decisions ORDER BY recipient_user_id')).rows
  expect(rows).toHaveLength(2)
  const proofs = new Set<string>()
  for (const row of rows) {
    const resolved = await resolver.deriveDefaultTarget(pool, { orgId: ORG, userId: row.recipient_user_id, connectionId: f.connectionId })
    expect(resolved.ok).toBe(true)
    if (resolved.ok === false) throw new Error(resolved.code)
    expect(row).toMatchObject({ route_source: 'org_default', connection_id: f.connectionId, proof_witness: resolved.target.proofWitness, address_witness: resolved.target.addressWitness })
    proofs.add(row.proof_witness)
  }
  expect(proofs.size).toBe(2)
})
it('A-D19 real tuple SELECT 57014 defers, then a healthy tick persists the decision', async () => {
  await seed(1)
  let failRead = false
  const adapter = new DingTalkWorkNotificationAdapter({ normalizeBaseUrl: value => String(value),
    classifySendError: () => { throw new Error('must not send') },
    readTuple: async () => {
      if (failRead) await transaction(async client => {
        await client.query("SET LOCAL statement_timeout='1ms'")
        await client.query('SELECT pg_sleep(0.05)')
      })
      return { config: { appKey: 'fixture', appSecret: 'synthetic', agentId: '1', baseUrl: 'https://oapi.dingtalk.com' } } as never
    },
  })
  const fingerprint = await adapter.fingerprint(connectionId)
  if (!fingerprint.ok) throw new Error('healthy tuple required')
  await pool.query('UPDATE notification_connection_verifications SET tuple_fingerprint=$1', [fingerprint.value])
  __notificationAdapterRegistryForTests.replace(new Map([['dingtalk', adapter]]))
  failRead = true; await scan(); expect(await counts()).toEqual({ outbox: 0, decisions: 0 })
  failRead = false; await scan(); expect(await counts()).toEqual({ outbox: 1, decisions: 1 })
  expect((await pool.query('SELECT status FROM task_notification_deliveries')).rows).toEqual([{ status: 'pending' }])
})

it('A-D20 missing and foreign connections have identical PUT and preview HTTP responses', async () => {
  const own = await seed(1, 'default', false)
  const foreign = await seed(1, 'foreign-preview-org', false)
  const missing = randomUUID()
  expect((await pool.query('SELECT id,org_id FROM directory_integrations WHERE id = ANY($1::uuid[])', [[missing, foreign.connectionId]])).rows)
    .toEqual([{ id: foreign.connectionId, org_id: 'foreign-preview-org' }])
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [own.user(0)])
  const app = express(); app.use(express.json())
  // HTTP transport starts at the already-authenticated admin boundary; SQL, R-1 and resolver are real.
  app.use((req, _res, next) => {
    req.user = { id: own.user(0), role: 'admin' } as never
    req.authenticatedTenantId = 'default'
    next()
  })
  app.use('/api/admin/directory', createAdminDirectoryNotificationRouter({ service: policyService(), isEnabled: () => true }))
  const base = '/api/admin/directory/notification-topic-policies/task_reminder'
  const put = async (id: string) => request(app).put(base).send({ expectedRevision: 0, state: 'active', defaultConnectionId: id })
  const missingPut = await put(missing), foreignPut = await put(foreign.connectionId)
  expect(missingPut.status).toBe(409)
  expect(missingPut.body).toEqual({ error: { code: 'DEFAULT_CONNECTION_NOT_READY' } })
  expect(foreignPut.status).toBe(missingPut.status)
  expect(foreignPut.text).toBe(missingPut.text)
  const preview = async (id: string) => request(app).get(`${base}/takeover-preview`).query({ defaultConnectionId: id })
  const missingPreview = await preview(missing), foreignPreview = await preview(foreign.connectionId)
  expect(missingPreview.status).toBe(200)
  expect(missingPreview.body).toMatchObject({ counts: { connection_not_found: 1 }, warnings: ['default_connection_not_ready'] })
  expect(foreignPreview.status).toBe(missingPreview.status)
  expect(foreignPreview.text).toBe(missingPreview.text)
  expect((await pool.query('SELECT * FROM org_notification_topic_policies')).rows).toEqual([])
  expect(await counts()).toEqual({ outbox: 0, decisions: 0 })
})
