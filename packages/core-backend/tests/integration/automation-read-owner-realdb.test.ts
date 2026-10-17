/** Owner history in an owned PostgreSQL schema. Actor/admin and original
 * Connection observation are REAL, including revision/incarnation triggers.
 * Historical grants/requests are seeded directly; execution is deliberately
 * unavailable. No source reader, profile/runtime fake or customer IO is used. */
import { randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { up as addSource } from '../../src/db/migrations/zzzz20261001120001_stock_prep_validation_source_revisions'
import { up as addLedger } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { up as addRecordActivation } from '../../src/db/migrations/zzzz20261001135000_automation_read_record_activation'
import { up, down } from '../../src/db/migrations/zzzz20261001132000_automation_read_owner_controls'
import { createAutomationReadLedger } from '../../src/integration/automation-read-ledger'
import { lockAutomationReadSourceObservation } from '../../src/integration/automation-read-source-observation'
import { AutomationReadLedgerError, type AutomationReadLedgerDependencies, type ReadGrantDetail,
  type ReadPageInput, type ReadRequestPageInput, type ReadRequestStatus } from '../../src/integration/automation-read-contracts'
import type { AutomationIntegrationActor } from '../../src/integration/automation-live-authority'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'
import { resetAutomationReadRecordActivations } from '../utils/automation-read-execution-schema'

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECT_DB must actually provide a database for owner controls', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
const owner = { actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null } as const
const foreignOwner = { ...owner, actorId: 'synthetic-other-owner' }
const foreignTenant = { ...owner, tenantId: 'synthetic-other-tenant' }
const selector = { ruleId: 'synthetic-rule', actionId: 'synthetic-action', systemId: 'synthetic-system', targetId: 'synthetic-target' }
const budget = { maxRows: 100, maxPages: 5, maxReadCount: 8, timeoutMs: 60000 }
const preview = { status: 'ready', counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false }
const denied = { code: 'AUTOMATION_READ_DENIED' }
const invalid = { code: 'AUTOMATION_READ_INPUT_INVALID' }

describeDatabase('Automation owner history: real actor, original source and owner-scoped keyset pages', () => {
  const schema = `automation_read_owner_${randomBytes(8).toString('hex')}`
  let pool: Pool, admin: PoolClient, db: Kysely<unknown>, created = false
  let ledger: ReturnType<typeof createAutomationReadLedger>
  const execute = vi.fn(async () => { throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED') })
  const queries: string[] = []
  async function transaction<T>(work: (trx: TransactionalQueryable) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const result = await work({ isTransaction: true, query(text, params) { queries.push(text); return client.query(text, params) } })
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  function history(tx: AutomationReadLedgerDependencies['transaction'] = transaction) {
    return createAutomationReadLedger({ transaction: tx, manifest: { version: 4, routes: {} },
      authority: { lockExecution: execute, lockObservation: lockAutomationReadSourceObservation } })
  }
  async function actor(principal: AutomationIntegrationActor) {
    await admin.query(`INSERT INTO users VALUES ($1,'user','[]',true,'activated') ON CONFLICT DO NOTHING`, [principal.actorId])
    await admin.query("INSERT INTO user_roles VALUES ($1,'integration_admin') ON CONFLICT DO NOTHING", [principal.actorId])
    await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true) ON CONFLICT DO NOTHING', [principal.actorId, principal.tenantId])
    await admin.query("INSERT INTO user_namespace_admissions VALUES ($1,'integration',true) ON CONFLICT DO NOTHING", [principal.actorId])
  }
  async function source(principal: AutomationIntegrationActor = owner, id = 'synthetic-private-connection') {
    await admin.query(`INSERT INTO data_sources(id,type,owner_id,tenant_id,scope_kind,is_active,config)
      VALUES ($1,'postgresql',$2,$3,'private',true,'{"password":"synthetic-secret"}')`, [id, principal.actorId, principal.tenantId])
    return id
  }
  async function seed(options: { actor?: AutomationIntegrationActor; source?: string; status?: ReadRequestStatus; createdAt?: string } = {}) {
    const principal = options.actor ?? owner, connectionId = options.source ?? 'synthetic-private-connection'
    const grantId = randomUUID(), requestId = randomUUID(), status = options.status ?? 'queued'
    const incarnation = (await admin.query('SELECT connection_incarnation FROM data_sources WHERE id=$1', [connectionId])).rows[0].connection_incarnation
    await admin.query(`INSERT INTO integration_automation_read_grants
      (id,tenant_id,owner_id,selector,source_reference,authority_key,projects,triggers,budget,expires_at,max_executions,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,ARRAY['SYN-PROJECT'],ARRAY['manual'],$7,'2099-01-01',3,COALESCE($8::timestamptz,clock_timestamp()))`,
    [grantId, principal.tenantId, principal.actorId, JSON.stringify(selector),
      JSON.stringify({ connectionId, connectionIncarnation: incarnation }), 'a'.repeat(64), JSON.stringify(budget), options.createdAt ?? null])
    await admin.query(`INSERT INTO integration_automation_read_requests
      (id,grant_id,tenant_id,owner_id,invocation_id,project_no,trigger_type,status,fence,lease_expires_at,started_at,finished_at,result,outbox_id,created_at)
      VALUES ($1,$2,$3,$4,$5,'SYN-PROJECT','manual',$6,$7,clock_timestamp()-interval '1 second',
        CASE WHEN $6='running' THEN clock_timestamp() ELSE NULL END,
        CASE WHEN $6 IN ('queued','running') THEN NULL ELSE clock_timestamp() END,$8,'synthetic-private-outbox',
        COALESCE($9::timestamptz,clock_timestamp()))`,
    [requestId, grantId, principal.tenantId, principal.actorId, 'synthetic-private-invocation-' + randomUUID(), status,
      randomUUID(), status === 'succeeded' ? JSON.stringify(preview) : null, options.createdAt ?? null])
    return { grantId, requestId, connectionId }
  }
  beforeAll(async () => {
    if (!/^automation_read_owner_[a-f0-9]{16}$/u.test(schema)) throw new Error('Invalid owned schema')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5,
      options: `-c search_path=${schema} -c statement_timeout=8000` })
    admin = await pool.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    created = true
    await admin.query(`
      CREATE TABLE users(id text PRIMARY KEY,role text,permissions jsonb,is_active boolean,activation_status text);
      CREATE TABLE user_roles(user_id text,role_id text,PRIMARY KEY(user_id,role_id));
      CREATE TABLE role_permissions(role_id text,permission_code text,PRIMARY KEY(role_id,permission_code));
      CREATE TABLE user_permissions(user_id text,permission_code text);
      CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean,PRIMARY KEY(user_id,org_id));
      CREATE TABLE user_namespace_admissions(user_id text,namespace text,enabled boolean,PRIMARY KEY(user_id,namespace));
      CREATE TABLE data_sources(id text PRIMARY KEY,config jsonb NOT NULL DEFAULT '{}',type text NOT NULL,
        owner_id text NOT NULL,tenant_id text,workspace_id text,scope_kind text NOT NULL,is_active boolean NOT NULL,deleted_at timestamptz);
      CREATE TABLE integration_external_systems(id text PRIMARY KEY,kind text,role text,status text,
        connection_id text,config jsonb,credentials_encrypted text,tenant_id text,workspace_id text);
    `)
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL,
      max: 1, options: `-c search_path=${schema} -c statement_timeout=8000` }) }) })
    for (const migration of [addSource, addLedger, up, addRecordActivation]) await db.transaction().execute(migration)
    ledger = history()
  })
  beforeEach(async () => {
    execute.mockClear(); queries.length = 0
    await resetAutomationReadRecordActivations(admin, async () => {
      await admin.query(`TRUNCATE integration_automation_read_record_activations,integration_automation_read_requests,integration_automation_read_grants,data_sources,
      integration_data_source_validation_revisions,integration_external_systems,users,user_roles,role_permissions,
      user_permissions,user_orgs,user_namespace_admissions`)
    })
    await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
    for (const principal of [owner, foreignOwner, foreignTenant]) await actor(principal)
    await source()
  })
  afterAll(async () => {
    await db?.destroy()
    if (admin) {
      await admin.query('ROLLBACK').catch(() => {})
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      admin.release()
    }
    await pool?.end()
  })

  it('grant detail is a detached whitelist; history works with no executor, profiles or source pointer', async () => {
    const item = await seed({ status: 'succeeded' })
    const detail = await ledger.grantDetail(owner, item.grantId)
    expect(Object.keys(detail).sort()).toEqual(['grantId','purpose','status','selector','projects','triggers','budget','expiresAt',
      'maxExecutions','usedExecutions','createdAt','updatedAt'].sort())
    expect(detail).toMatchObject({ grantId: item.grantId, purpose: 'standalone', status: 'active', selector, projects: ['SYN-PROJECT'], triggers: ['manual'], budget, maxExecutions: 3, usedExecutions: 0 })
    detail.projects.push('mutated'); detail.selector.ruleId = 'mutated'; detail.budget.maxRows = 1
    expect(await ledger.grantDetail(owner, item.grantId)).toMatchObject({ selector, projects: ['SYN-PROJECT'], budget })
    const requests = await ledger.listRequests(owner)
    expect(Object.keys(requests.items[0]).sort()).toEqual(['requestId','grantId','status','projectNo','trigger','createdAt','startedAt','finishedAt'].sort())
    expect(requests.items[0]).not.toHaveProperty('result')
    expect(JSON.stringify([detail, requests])).not.toMatch(/source_reference|authority_key|sourceReference|authorityKey|fence|outbox|invocation|synthetic-secret|synthetic-private-connection/u)
    expect(await ledger.observe(owner, item.requestId)).toMatchObject({ status: 'succeeded', result: preview })
    expect(execute).not.toHaveBeenCalled()
  })
  it('expired and revoked grants retain authorized detail without granting execution', async () => {
    const item = await seed()
    await admin.query("UPDATE integration_automation_read_grants SET status='revoked',expires_at='2020-01-01' WHERE id=$1", [item.grantId])
    expect(await ledger.grantDetail(owner, item.grantId)).toMatchObject({ status: 'revoked', expiresAt: '2020-01-01T00:00:00.000Z' })
    expect((await ledger.listGrants(owner)).items.map(row => row.grantId)).toEqual([item.grantId])
    expect(execute).not.toHaveBeenCalled()
  })
  it('lists only the original owner and tenant even when other principals have real administrator permission', async () => {
    const own = await seed()
    await source(foreignOwner, 'other-owner-source'); await seed({ actor: foreignOwner, source: 'other-owner-source' })
    await source(foreignTenant, 'other-tenant-source'); await seed({ actor: foreignTenant, source: 'other-tenant-source' })
    expect((await ledger.listGrants(owner)).items.map(row => row.grantId)).toEqual([own.grantId])
    expect((await ledger.listRequests(owner)).items.map(row => row.requestId)).toEqual([own.requestId])
    for (const principal of [foreignOwner, foreignTenant]) {
      await expect(ledger.grantDetail(principal, own.grantId)).rejects.toMatchObject(denied)
      await expect(ledger.listGrants(principal, { after: own.grantId })).rejects.toMatchObject(denied)
      await expect(ledger.listRequests(principal, { after: own.requestId })).rejects.toMatchObject(denied)
      await expect(ledger.listRequests(principal, { grantId: own.grantId })).rejects.toMatchObject(denied)
    }
  })
  it('default20/max50 keyset pages return only their last authorized item as cursor and no total', async () => {
    for (let index = 0; index < 52; index++) await seed()
    const first = await ledger.listGrants(owner)
    expect(first.items).toHaveLength(20)
    expect(first.nextCursor).toBe(first.items[19].grantId)
    expect(Object.keys(first)).toEqual(['items', 'nextCursor'])
    const second = await ledger.listGrants(owner, { after: first.nextCursor!, limit: 50 })
    expect(second.items).toHaveLength(32); expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map(row => row.grantId)).size).toBe(52)
    const requests = await ledger.listRequests(owner, { limit: 50 })
    expect(requests.items).toHaveLength(50)
    expect(requests.nextCursor).toBe(requests.items[49].requestId)
    expect((await ledger.listRequests(owner, { after: requests.nextCursor! })).items).toHaveLength(2)
  })
  it('DB anchor comparison retains microseconds and stable UUID tie-breaking despite millisecond DTO timestamps', async () => {
    const rows = []
    for (const fraction of ['000001', '000002', '000003']) rows.push(await seed({ createdAt: `2026-10-01T00:00:00.${fraction}Z` }))
    for (const family of ['grants', 'requests'] as const) {
      const ids: string[] = []
      let after: string | undefined
      do {
        if (family === 'grants') {
          const page = await ledger.listGrants(owner, { limit: 1, ...(after ? { after } : {}) })
          ids.push(...page.items.map(row => row.grantId)); after = page.nextCursor ?? undefined
        } else {
          const page = await ledger.listRequests(owner, { limit: 1, ...(after ? { after } : {}) })
          ids.push(...page.items.map(row => row.requestId)); after = page.nextCursor ?? undefined
        }
      } while (after)
      expect(ids).toEqual(rows.reverse().map(row => family === 'grants' ? row.grantId : row.requestId))
      rows.reverse()
    }
    await admin.query("UPDATE integration_automation_read_grants SET created_at='2026-10-01'; UPDATE integration_automation_read_requests SET created_at='2026-10-01'")
    const ordered = rows.map(row => row.grantId).sort().reverse()
    const first = await ledger.listGrants(owner, { limit: 1 })
    expect(first.items[0].grantId).toBe(ordered[0])
    expect((await ledger.listGrants(owner, { limit: 1, after: first.nextCursor! })).items[0].grantId).toBe(ordered[1])
  })
  it('request grant filter and its anchor must describe the same readable grant', async () => {
    const first = await seed(), second = await seed()
    expect((await ledger.listRequests(owner, { grantId: first.grantId })).items.map(row => row.requestId)).toEqual([first.requestId])
    await expect(ledger.listRequests(owner, { grantId: first.grantId, after: second.requestId })).rejects.toMatchObject(denied)
    expect(await ledger.listRequests(owner, { grantId: first.grantId, after: first.requestId })).toEqual({ items: [], nextCursor: null })
  })
  for (const input of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: '20' }, { after: '' }, { after: randomUUID().toUpperCase() },
    { tenantId: owner.tenantId }, { ownerId: owner.actorId }, { workspaceId: null }, { limit: 1, surprise: true }]) {
    it(`rejects closed-page input ${JSON.stringify(input)} before transaction entry`, async () => {
      const tx = vi.fn(), strict = history(tx)
      await expect(strict.listGrants(owner, input as ReadPageInput)).rejects.toMatchObject(invalid)
      await expect(strict.listRequests(owner, input as ReadRequestPageInput)).rejects.toMatchObject(invalid)
      expect(tx).not.toHaveBeenCalled()
    })
  }
  it('page descriptors cannot invoke getters, inherit fields or hide extra symbols', async () => {
    const getter = vi.fn(() => 20)
    for (const input of [Object.defineProperty({}, 'limit', { enumerable: true, get: getter }),
      Object.create({ limit: 20 }), { [Symbol('scope')]: owner }]) {
      await expect(ledger.listGrants(owner, input)).rejects.toMatchObject(invalid)
    }
    expect(getter).not.toHaveBeenCalled()
  })
  for (const change of ["UPDATE users SET is_active=false", 'DELETE FROM role_permissions',
    'UPDATE user_orgs SET is_active=false', 'UPDATE user_namespace_admissions SET enabled=false']) {
    it(`real current actor gate rejects ${change.split(' ')[1]} for detail and even empty lists`, async () => {
      const item = await seed()
      await admin.query(change)
      await expect(ledger.grantDetail(owner, item.grantId)).rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_AUTHORITY_DENIED' })
      await admin.query('DELETE FROM integration_automation_read_requests; DELETE FROM integration_automation_read_grants')
      for (const work of [() => ledger.listGrants(owner), () => ledger.listRequests(owner)]) {
        await expect(work()).rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_AUTHORITY_DENIED' })
      }
    })
  }
  for (const change of ["owner_id='synthetic-other-owner'", "tenant_id='synthetic-other-tenant'", "scope_kind='shared'",
    'is_active=false', 'deleted_at=clock_timestamp()', "workspace_id='synthetic-workspace'"]) {
    it(`current original Connection ${change.split('=')[0]} hides rows and refuses detail/cursors`, async () => {
      const item = await seed()
      await admin.query(`UPDATE data_sources SET ${change}`)
      expect(await ledger.listGrants(owner)).toEqual({ items: [], nextCursor: null })
      expect(await ledger.listRequests(owner)).toEqual({ items: [], nextCursor: null })
      await expect(ledger.grantDetail(owner, item.grantId)).rejects.toMatchObject(denied)
      await expect(ledger.listGrants(owner, { after: item.grantId })).rejects.toMatchObject(denied)
      await expect(ledger.listRequests(owner, { after: item.requestId })).rejects.toMatchObject(denied)
    })
  }
  it('rotation preserves history; delete/recreate of the same Connection ID cannot inherit it', async () => {
    const item = await seed()
    await admin.query("UPDATE data_sources SET config='{}'")
    expect((await ledger.listGrants(owner)).items).toHaveLength(1)
    await admin.query('DELETE FROM data_sources')
    await source()
    expect(await ledger.listGrants(owner)).toEqual({ items: [], nextCursor: null })
    expect(await ledger.listRequests(owner)).toEqual({ items: [], nextCursor: null })
    await expect(ledger.grantDetail(owner, item.grantId)).rejects.toMatchObject(denied)
  })
  it('an inaccessible leading candidate cannot consume page capacity or become a cursor', async () => {
    const readable = await seed()
    await source(owner, 'synthetic-second-source')
    const hidden = await seed({ source: 'synthetic-second-source' })
    await admin.query("UPDATE data_sources SET owner_id=$2 WHERE id=$1", [hidden.connectionId, foreignOwner.actorId])
    expect(await ledger.listGrants(owner, { limit: 1 })).toMatchObject({ items: [{ grantId: readable.grantId }], nextCursor: null })
    expect(await ledger.listRequests(owner, { limit: 1 })).toMatchObject({ items: [{ requestId: readable.requestId }], nextCursor: null })
  })
  it('a source changing after candidate SELECT, including the limit+1 probe, fails the entire page closed', async () => {
    await source(owner, 'synthetic-probe-source')
    await seed({ source: 'synthetic-probe-source' }); await seed()
    let changed = false
    const raced = history(work => transaction(trx => work({ isTransaction: true, async query(text, params) {
      const result = await trx.query(text, params)
      if (!changed && text.includes('SELECT g.id FROM integration_automation_read_grants g')) {
        changed = true
        await admin.query("UPDATE data_sources SET owner_id=$2 WHERE id=$1", ['synthetic-probe-source', foreignOwner.actorId])
      }
      return result
    } })))
    await expect(raced.listGrants(owner, { limit: 1 })).rejects.toMatchObject(denied)
    expect(changed).toBe(true)
  })
  it('NOWAIT grant contention fails closed instead of returning partial cross-Connection pages', async () => {
    await source(owner, 'synthetic-second-source')
    const item = await seed({ source: 'synthetic-second-source' }); await seed()
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM integration_automation_read_grants WHERE id=$1 FOR UPDATE', [item.grantId])
      await expect(ledger.listGrants(owner)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
      expect(queries.some(text => /integration_automation_read_grants WHERE id = \$1 FOR UPDATE NOWAIT/u.test(text))).toBe(true)
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    expect((await ledger.listGrants(owner)).items).toHaveLength(2)
  })
  it('list requests does not publish counts or reconcile running expiry; detail still safely does', async () => {
    const item = await seed({ status: 'running' })
    expect((await ledger.listRequests(owner)).items[0]).toMatchObject({ status: 'running', finishedAt: null })
    expect((await admin.query('SELECT status FROM integration_automation_read_requests WHERE id=$1', [item.requestId])).rows[0].status).toBe('running')
    expect(await ledger.observe(owner, item.requestId)).toEqual({ requestId: item.requestId, status: 'outcome_unknown', result: null })
  })
  it('owner index up/down leaves retained private history untouched and indexes the keyset scopes', async () => {
    const item = await seed()
    const indexes = (await admin.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname IN
      ('idx_automation_read_grant_owner_page','idx_automation_read_request_owner_page','idx_automation_read_request_grant_page')`, [schema])).rows
    expect(indexes).toHaveLength(3)
    expect(indexes.every(row => /tenant_id, owner_id/u.test(row.indexdef) && /created_at DESC, id DESC/u.test(row.indexdef)
      && /workspace_id IS NULL/u.test(row.indexdef))).toBe(true)
    await db.transaction().execute(down)
    const detail: ReadGrantDetail = await ledger.grantDetail(owner, item.grantId)
    expect(detail.grantId).toBe(item.grantId)
    await db.transaction().execute(up)
    expect((await ledger.listGrants(owner)).items).toHaveLength(1)
  })
})
