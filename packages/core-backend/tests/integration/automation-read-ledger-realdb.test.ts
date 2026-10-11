/**
 * Host-private read ledger against PostgreSQL in one owned random schema.
 * Uses the real migration, live actor guard, transaction guard and outbox enqueue.
 * Rule/selector/target/budget execution authority remains SYNTHETIC. Connection
 * history uses the real source-observation helper + actual DB incarnation/mirror
 * triggers over minimal consumed DS/EXT columns. This is NOT full facade/PLM
 * receipt/target authorization, HTTP/JWT, a consumer or source IO.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { down, up } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { down as removeExecutionAudit, up as addExecutionAudit } from '../../src/db/migrations/zzzz20261001134000_automation_read_execution_audit'
import { down as removeRecordActivation, up as addRecordActivation } from '../../src/db/migrations/zzzz20261001135000_automation_read_record_activation'
import { createAutomationReadExecutionLogSchema, resetAutomationReadExecutionLinks } from '../utils/automation-read-execution-schema'
import { down as removeSourceRevisions, up as addSourceRevisions } from '../../src/db/migrations/zzzz20261001120001_stock_prep_validation_source_revisions'
import { createAutomationReadLedger } from '../../src/integration/automation-read-ledger'
import { lockAutomationReadSourceObservation } from '../../src/integration/automation-read-source-observation'
import { AUTOMATION_READ_ACTION_TYPE, AUTOMATION_READ_OPERATION, deriveAutomationReadOperationPolicy,
  type AutomationReadOperationPolicyInput } from '../../src/integration/automation-read-operation-policy'
import {
  AUTOMATION_READ_CONSUMER,
  AUTOMATION_READ_EVENT,
  AutomationReadLedgerError,
  type AutomationReadAuthorityPort,
  type ReadBudget,
  type ReadGrantInput,
  type ReadPreview,
  type ReadSelector,
  type ReadSourceReference,
  type ReadTrigger,
} from '../../src/integration/automation-read-contracts'
import type { AutomationIntegrationActor } from '../../src/integration/automation-live-authority'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'
import { ROUTING_MANIFEST_V3, type RoutingManifest } from '../../src/multitable/automation-routing-manifest'

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECT_DB must actually provide a database for the read ledger', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const owner: AutomationIntegrationActor = {
  actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null,
}
const otherOwner: AutomationIntegrationActor = { ...owner, actorId: 'synthetic-other-owner' }
const otherTenant: AutomationIntegrationActor = { ...owner, tenantId: 'synthetic-other-tenant' }
const selector: ReadSelector = {
  ruleId: 'synthetic-rule', actionId: 'synthetic-action', systemId: 'synthetic-source', targetId: 'synthetic-target',
}
const budget: ReadBudget = { maxRows: 100, maxPages: 5, maxReadCount: 8, timeoutMs: 60_000 }
const authorityKey = 'a'.repeat(64)
const fixtureConnectionId = (actor: AutomationIntegrationActor, suffix = 'a') => `${actor.tenantId}:${actor.actorId}:connection-${suffix}`
const preview: ReadPreview = {
  status: 'ready', counts: { add: 2, update: 1, skip: 3, inactive: 0, manual_confirm: 0 }, canApply: false,
}
const fixtureManifest: RoutingManifest = {
  version: 1001, routes: { [AUTOMATION_READ_EVENT]: [AUTOMATION_READ_CONSUMER] },
}
const denied = { code: 'AUTOMATION_READ_DENIED' }
const invalid = { code: 'AUTOMATION_READ_INPUT_INVALID' }
const scopeChanged = { code: 'AUTOMATION_READ_SCOPE_CHANGED' }
const exhausted = { code: 'AUTOMATION_READ_BUDGET_EXHAUSTED' }
const actorDenied = { code: 'AUTOMATION_ACTOR_AUTHORITY_DENIED' }

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describeDatabase('Automation read ledger: real transactions and explicitly synthetic authority', () => {
  const schema = `automation_read_ledger_${randomBytes(8).toString('hex')}`
  let pool: Pool
  let admin: PoolClient
  let db: Kysely<unknown>
  let schemaCreated = false
  let ledger: ReturnType<typeof createAutomationReadLedger>

  async function transaction<T>(
    work: (trx: TransactionalQueryable) => Promise<T>,
    onBegin?: (client: PoolClient) => Promise<void>,
    beforeCommit?: () => Promise<void>,
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await onBegin?.(client)
      const value = await work({ isTransaction: true, query: (sql, params) => client.query(sql, params) })
      await beforeCommit?.()
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async function lockedFixture(trx: Queryable, actor: AutomationIntegrationActor, selected: ReadSelector) {
    const result = await trx.query(`SELECT actor_id, tenant_id, authority_key, budget, can_execute, connection_id
      FROM synthetic_read_authority
      WHERE actor_id = $1 AND tenant_id = $2 AND rule_id = $3 AND action_id = $4 AND system_id = $5 AND target_id = $6
      FOR SHARE`, [actor.actorId, actor.tenantId, selected.ruleId, selected.actionId, selected.systemId, selected.targetId])
    if (result.rows.length !== 1) throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
    return result.rows[0]
  }

  async function sourceReference(trx: Queryable, connectionId: string): Promise<ReadSourceReference> {
    const row = (await trx.query('SELECT connection_incarnation FROM data_sources WHERE id = $1', [connectionId])).rows[0]
    if (!row) throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
    return { connectionId, connectionIncarnation: String(row.connection_incarnation) }
  }

  const authority: AutomationReadAuthorityPort = {
    async lockExecution(trx, actor, selected) {
      const row = await lockedFixture(trx, actor, selected)
      if (row.can_execute !== true) throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
      const original = await sourceReference(trx, String(row.connection_id))
      const observed = await lockAutomationReadSourceObservation(trx, actor, original)
      // Legacy state-machine fixtures deliberately approve all three categories;
      // dedicated policy cases below derive the narrower real rule policy.
      return { ...observed, key: String(row.authority_key), budget: row.budget as ReadBudget,
        allowedTriggers: ['manual', 'schedule', 'record'] }
    },
    lockObservation: lockAutomationReadSourceObservation,
  }

  function policyInput(triggerType = 'schedule.cron', allowManual = false): AutomationReadOperationPolicyInput {
    return { triggerType, actionType: AUTOMATION_READ_ACTION_TYPE,
      actionConfig: { operation: AUTOMATION_READ_OPERATION, allowManual }, actions: null, executionMode: null }
  }
  function policyLedger(current: () => AutomationReadOperationPolicyInput) {
    return createAutomationReadLedger({ transaction, manifest: fixtureManifest, authority: { ...authority,
      async lockExecution(trx, actor, selected) {
        const proof = await authority.lockExecution(trx, actor, selected)
        // The real pure operation policy narrows this otherwise synthetic
        // execution fixture. Deliberately keep key unchanged: a key mismatch
        // must not mask missing ledger trigger-subset enforcement.
        return { ...proof, allowedTriggers: deriveAutomationReadOperationPolicy(current()).allowedTriggers }
      },
    } })
  }
  function policyGrant(target: ReturnType<typeof createAutomationReadLedger>, triggers: ReadTrigger[]) {
    return target.grant(owner, { selector, projects: ['synthetic-project-a'], budget,
      triggers, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 3 })
  }

  async function migrate(direction: 'up' | 'down') {
    await db.transaction().execute(trx => (direction === 'up' ? up : down)(trx))
  }

  // Deliberately corrupt this owned fixture to keep the older ledger/FK guards
  // independently tested. New audit identity rejection has separate real-DB
  // evidence; it must not mask missing checkpoint/claim membership enforcement.
  async function corruptLegacyRequest(work: () => Promise<unknown>) {
    if (!/^automation_read_ledger_[a-f0-9]{16}$/.test(schema)) throw new Error('Unowned fixture')
    await admin.query(`ALTER TABLE "${schema}".integration_automation_read_requests DISABLE TRIGGER automation_read_execution_request_identity`)
    try { return await work() }
    finally { await admin.query(`ALTER TABLE "${schema}".integration_automation_read_requests ENABLE TRIGGER automation_read_execution_request_identity`) }
  }

  async function grant(overrides: Partial<ReadGrantInput> = {}) {
    const expiresAt = (await admin.query("SELECT clock_timestamp() + interval '1 hour' AS expires_at")).rows[0].expires_at as Date
    return ledger.grant(owner, { selector, projects: ['synthetic-project-a', 'synthetic-project-b'],
      triggers: ['manual', 'schedule', 'record'], budget, expiresAt: expiresAt.toISOString(), maxExecutions: 3, ...overrides })
  }

  function submit(grantId: string, invocationId = randomUUID(), projectNo = 'synthetic-project-a') {
    return ledger.submit(owner, { grantId, invocationId, projectNo, trigger: 'manual' })
  }

  async function claimExecution(requestId: string) {
    const claimed = await ledger.claim(requestId)
    expect(claimed).toMatchObject({ status: 'running', fence: expect.any(String) })
    if (!('fence' in claimed)) throw new Error('Expected one executable claim')
    return claimed
  }

  async function requestRow(requestId: string) {
    return (await admin.query('SELECT * FROM integration_automation_read_requests WHERE id = $1', [requestId])).rows[0]
  }

  async function grantRow(grantId: string) {
    return (await admin.query('SELECT * FROM integration_automation_read_grants WHERE id = $1', [grantId])).rows[0]
  }

  async function counts() {
    return (await admin.query(`SELECT
      (SELECT count(*)::int FROM integration_automation_read_grants) AS grants,
      (SELECT count(*)::int FROM integration_automation_read_requests) AS requests,
      (SELECT count(*)::int FROM meta_automation_outbox) AS outbox,
      (SELECT count(*)::int FROM meta_automation_outbox_consumer) AS consumers`)).rows[0]
  }

  async function expireLease(requestId: string) {
    await admin.query(`UPDATE integration_automation_read_requests
      SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [requestId])
  }

  async function completedRequest() {
    const { grantId } = await grant()
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    await ledger.complete({ requestId: request.requestId, fence: claimed.fence, result: preview })
    return { grantId, requestId: request.requestId,
      original: (await grantRow(grantId)).source_reference as ReadSourceReference }
  }

  async function addReplacementConnection() {
    const id = fixtureConnectionId(owner, 'b')
    await admin.query(`INSERT INTO data_sources (id,type,owner_id,tenant_id,scope_kind,is_active)
      VALUES ($1,'postgresql',$2,$3,'private',true)`, [id, owner.actorId, owner.tenantId])
    return sourceReference(admin, id)
  }

  async function mutateAuthority(update: string, params: unknown[] = []) {
    // Callers supply only fixed SQL fragments from this test, never source values.
    await admin.query(`UPDATE synthetic_read_authority SET ${update}
      WHERE actor_id = 'synthetic-owner' AND tenant_id = 'synthetic-tenant'`, params)
  }

  async function observeBlocked(waiter: number, blocker: number, done: () => boolean) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const row = (await admin.query(`SELECT wait_event_type = 'Lock' AS waiting,
        $2::int = ANY(pg_blocking_pids(pid)) AS ours FROM pg_stat_activity WHERE pid = $1`, [waiter, blocker])).rows[0]
      if (row?.waiting === true && row.ours === true) return
      expect(done(), 'competing transaction must wait for this test\'s locking session').toBe(false)
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    throw new Error('Expected owned PostgreSQL lock wait was not observed')
  }

  beforeAll(async () => {
    if (!/^automation_read_ledger_[a-f0-9]{16}$/.test(schema)) throw new Error('Invalid owned schema')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10,
      options: `-c search_path=${schema} -c statement_timeout=10000` })
    admin = await pool.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    await admin.query(`
      CREATE TABLE users (id text PRIMARY KEY, role text, permissions jsonb,
        is_active boolean, activation_status text, local_password_set boolean, is_admin boolean);
      CREATE TABLE user_roles (user_id varchar(255), role_id varchar(255), PRIMARY KEY(user_id, role_id));
      CREATE TABLE role_permissions (role_id varchar(255), permission_code varchar(255), PRIMARY KEY(role_id, permission_code));
      CREATE TABLE user_permissions (user_id varchar(255), permission_code varchar(255), PRIMARY KEY(user_id, permission_code));
      CREATE TABLE user_orgs (user_id text, org_id text, is_active boolean NOT NULL, PRIMARY KEY(user_id, org_id));
      CREATE TABLE user_namespace_admissions (user_id text, namespace text, enabled boolean NOT NULL DEFAULT false,
        UNIQUE(user_id, namespace));
      CREATE TABLE automation_rules (id text PRIMARY KEY, sheet_id text NOT NULL, created_by text NOT NULL,
        enabled boolean NOT NULL, action_type text NOT NULL, integration_authority_revision uuid NOT NULL);
      CREATE TABLE synthetic_read_authority (
        actor_id text NOT NULL, tenant_id text NOT NULL, rule_id text NOT NULL, action_id text NOT NULL,
        system_id text NOT NULL, target_id text NOT NULL, authority_key text NOT NULL, budget jsonb NOT NULL,
        can_execute boolean NOT NULL DEFAULT true, connection_id text NOT NULL,
        PRIMARY KEY(actor_id, tenant_id, rule_id, action_id, system_id, target_id));
      CREATE TABLE data_sources (
        id text PRIMARY KEY, config jsonb NOT NULL DEFAULT '{}', type text NOT NULL,
        owner_id text NOT NULL, tenant_id text, workspace_id text, scope_kind text NOT NULL,
        is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz);
      CREATE TABLE integration_external_systems (
        id text PRIMARY KEY, tenant_id text NOT NULL, workspace_id text, kind text NOT NULL,
        role text NOT NULL, status text NOT NULL, connection_id text, config jsonb NOT NULL DEFAULT '{}',
        credentials_encrypted text);
      CREATE TABLE meta_automation_outbox (
        id text PRIMARY KEY, event_type text NOT NULL, payload jsonb NOT NULL, automation_depth integer NOT NULL,
        manifest_version integer NOT NULL, event_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE meta_automation_outbox_consumer (
        outbox_id text NOT NULL REFERENCES meta_automation_outbox(id) ON DELETE CASCADE,
        consumer_key text NOT NULL, status text NOT NULL DEFAULT 'pending', PRIMARY KEY(outbox_id, consumer_key));
    `)
    const migrationPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1,
      options: `-c search_path=${schema} -c statement_timeout=10000` })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: migrationPool }) })
    await db.transaction().execute(addSourceRevisions)
    await migrate('up')
    await createAutomationReadExecutionLogSchema(admin)
    await db.transaction().execute(addExecutionAudit)
    await db.transaction().execute(addRecordActivation)
    ledger = createAutomationReadLedger({ transaction, authority, manifest: fixtureManifest })
  })

  afterAll(async () => {
    await db?.destroy()
    if (admin) {
      await admin.query('ROLLBACK').catch(() => {})
      // This exact random schema was created by this suite; never public or an existing schema.
      if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      admin.release()
    }
    await pool?.end()
  })

  beforeEach(async () => {
    await resetAutomationReadExecutionLinks(admin, async () => {
      await admin.query(`TRUNCATE integration_automation_read_record_activations, integration_automation_read_executions, multitable_automation_executions,
      integration_automation_read_requests, integration_automation_read_grants, automation_rules,
      meta_automation_outbox_consumer, meta_automation_outbox, synthetic_read_authority,
      integration_data_source_validation_revisions, integration_external_systems, data_sources,
      users, user_roles, role_permissions, user_permissions, user_orgs, user_namespace_admissions`)
    })
    await admin.query(`INSERT INTO automation_rules VALUES ($1,'synthetic-sheet',$2,true,'integration_read_preview',$3)`,
      [selector.ruleId, owner.actorId, randomUUID()])
    // All cross-scope subjects have positive admin/membership/port authority so a
    // missing owner/tenant predicate cannot hide behind absent fixture permissions.
    for (const actor of [owner, otherOwner]) {
      await admin.query("INSERT INTO users VALUES ($1, 'user', '[]', true, 'activated', false, false)", [actor.actorId])
      await admin.query("INSERT INTO user_roles VALUES ($1, 'admin')", [actor.actorId])
      await admin.query('INSERT INTO user_orgs VALUES ($1, $2, true), ($1, $3, true)',
        [actor.actorId, owner.tenantId, otherTenant.tenantId])
    }
    for (const actor of [owner, otherOwner, otherTenant]) {
      await admin.query(`INSERT INTO data_sources
        (id,type,owner_id,tenant_id,workspace_id,scope_kind,is_active,config)
        VALUES ($1,'postgresql',$2,$3,NULL,'private',true,'{"notForObservation":"synthetic-private-config"}')`,
      [fixtureConnectionId(actor), actor.actorId, actor.tenantId])
      await admin.query(`INSERT INTO synthetic_read_authority
        (actor_id, tenant_id, rule_id, action_id, system_id, target_id, authority_key, budget, connection_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [actor.actorId, actor.tenantId, selector.ruleId, selector.actionId, selector.systemId, selector.targetId,
        authorityKey, JSON.stringify(budget), fixtureConnectionId(actor)])
    }
  })

  it('snapshots the bounded grant and atomically queues only an opaque request identity', async () => {
    const { grantId } = await grant()
    const created = await submit(grantId)
    expect(created).toEqual({ requestId: expect.any(String), status: 'queued' })
    expect(await grantRow(grantId)).toMatchObject({ owner_id: owner.actorId, tenant_id: owner.tenantId,
      workspace_id: null, purpose: 'standalone', authority_key: authorityKey, selector, budget, used_executions: 0, status: 'active',
      source_reference: await sourceReference(admin, fixtureConnectionId(owner)) })
    expect(await ledger.grantDetail(owner, grantId)).toMatchObject({ grantId, purpose: 'standalone' })
    expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1, consumers: 1 })
    const request = await requestRow(created.requestId)
    const event = (await admin.query('SELECT * FROM meta_automation_outbox WHERE id = $1', [request.outbox_id])).rows[0]
    expect(event).toMatchObject({ event_type: AUTOMATION_READ_EVENT, manifest_version: fixtureManifest.version,
      automation_depth: 0, payload: { requestId: created.requestId } })
    expect(Object.keys(event.payload)).toEqual(['requestId'])
    expect((await admin.query('SELECT consumer_key, status FROM meta_automation_outbox_consumer')).rows)
      .toEqual([{ consumer_key: AUTOMATION_READ_CONSUMER, status: 'pending' }])
    expect(JSON.stringify(event)).not.toContain(authorityKey)
    expect(JSON.stringify(event)).not.toContain('synthetic-project')
    expect(JSON.stringify(event)).not.toContain('connectionIncarnation')
    expect(JSON.stringify(event)).not.toContain(fixtureConnectionId(owner))
  })

  it('rejects the current manifest without a read consumer and writes no request or queue rows', async () => {
    const { grantId } = await grant()
    const unrouted = createAutomationReadLedger({ transaction, authority, manifest: ROUTING_MANIFEST_V3 })
    await expect(unrouted.submit(owner, { grantId, invocationId: randomUUID(),
      projectNo: 'synthetic-project-a', trigger: 'manual' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_ROUTING_UNAVAILABLE' })
    expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0, consumers: 0 })
  })

  it('a PostgreSQL consumer INSERT failure rolls back request and outbox together', async () => {
    const { grantId } = await grant()
    await admin.query(`CREATE FUNCTION synthetic_reject_consumer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic consumer insert failure'; END $$;
      CREATE TRIGGER synthetic_reject_consumer BEFORE INSERT ON meta_automation_outbox_consumer
      FOR EACH ROW EXECUTE FUNCTION synthetic_reject_consumer()`)
    try {
      await expect(submit(grantId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE', message: 'AUTOMATION_READ_UNAVAILABLE' })
      expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0, consumers: 0 })
      expect((await grantRow(grantId)).used_executions).toBe(0)
    } finally {
      await admin.query('DROP TRIGGER synthetic_reject_consumer ON meta_automation_outbox_consumer; DROP FUNCTION synthetic_reject_consumer()')
    }
    await expect(submit(grantId)).resolves.toMatchObject({ status: 'queued' })
  })

  it('rejects invalid grant bounds and selectors before inserting durable history', async () => {
    const invalidGrants: Partial<ReadGrantInput>[] = [
      { projects: [] }, { projects: [' synthetic-project-a'] }, { triggers: [] },
      { maxExecutions: 0 }, { maxExecutions: 1.5 }, { expiresAt: 'invalid' },
      { budget: { ...budget, maxRows: 0 } }, { budget: { ...budget, maxPages: 1.5 } },
      { selector: { ...selector, systemId: '' } },
    ]
    for (const input of invalidGrants) await expect(grant(input)).rejects.toMatchObject(invalid)
    await expect(grant({ expiresAt: '2000-01-01T00:00:00.000Z' })).rejects.toMatchObject(denied)
    await expect(grant({ budget: { ...budget, maxRows: budget.maxRows + 1 } })).rejects.toThrow()
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0, consumers: 0 })
  })

  it('requires the real current actor guard as well as the locked synthetic authority port', async () => {
    await admin.query('DELETE FROM user_roles WHERE user_id = $1', [owner.actorId])
    await expect(grant()).rejects.toMatchObject(actorDenied)
    await admin.query("INSERT INTO user_roles VALUES ($1, 'admin')", [owner.actorId])
    await mutateAuthority('can_execute = false')
    await expect(grant()).rejects.toMatchObject(denied)
    expect((await counts()).grants).toBe(0)
  })

  it.each([
    ['schedule.cron', 'schedule'], ['schedule.interval', 'schedule'], ['schedule.date_field', 'schedule'],
    ['record.created', 'record'], ['record.updated', 'record'], ['record.deleted', 'record'], ['field.value_changed', 'record'],
  ] as const)('real policy permits %s only through its approved %s grant category', async (triggerType, trigger) => {
    const controlled = policyLedger(() => policyInput(triggerType))
    const { grantId } = await policyGrant(controlled, [trigger])
    const submitted = await controlled.submit(owner, { grantId, invocationId: randomUUID(), projectNo: 'synthetic-project-a', trigger })
    const claimed = await controlled.claim(submitted.requestId)
    expect(claimed).toMatchObject({ status: 'running', fence: expect.any(String) })
    if (!('fence' in claimed)) throw new Error('Expected executable policy fixture')
    expect(await controlled.complete({ requestId: submitted.requestId, fence: claimed.fence, result: preview }))
      .toEqual({ requestId: submitted.requestId, status: 'succeeded' })
    expect((await grantRow(grantId)).triggers).toEqual([trigger])
    expect((await grantRow(grantId)).used_executions).toBe(1)
  })

  it.each([
    ['schedule.cron', 'record'], ['record.created', 'schedule'],
    ['schedule.cron', 'manual'], ['record.created', 'manual'],
  ] as const)('real %s policy refuses an unauthorized %s grant before any durable write', async (triggerType, trigger) => {
    const controlled = policyLedger(() => policyInput(triggerType))
    await expect(policyGrant(controlled, [trigger])).rejects.toMatchObject(denied)
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0, consumers: 0 })
  })

  it('manual requires both real policy allowManual and explicit grant opt-in', async () => {
    const controlled = policyLedger(() => policyInput('schedule.cron', true))
    const scheduleOnly = await policyGrant(controlled, ['schedule'])
    await expect(controlled.submit(owner, { grantId: scheduleOnly.grantId, invocationId: randomUUID(),
      projectNo: 'synthetic-project-a', trigger: 'manual' })).rejects.toMatchObject(denied)
    const manual = await policyGrant(controlled, ['manual'])
    await expect(controlled.submit(owner, { grantId: manual.grantId, invocationId: randomUUID(),
      projectNo: 'synthetic-project-a', trigger: 'manual' })).resolves.toMatchObject({ status: 'queued' })
    expect(await counts()).toEqual({ grants: 2, requests: 1, outbox: 1, consumers: 1 })
  })

  it.each(['submit', 'claim', 'complete'] as const)('rechecks the entire persisted grant against current real policy before %s', async stage => {
    let current = policyInput('schedule.cron', true)
    const controlled = policyLedger(() => current)
    const { grantId } = await policyGrant(controlled, ['manual', 'schedule'])
    const submitSchedule = () => controlled.submit(owner, { grantId, invocationId: randomUUID(),
      projectNo: 'synthetic-project-a', trigger: 'schedule' })
    const submitted = stage === 'submit' ? null : await submitSchedule()
    const claimed = stage === 'complete' && submitted ? await controlled.claim(submitted.requestId) : null
    // The particular request remains an approved schedule request. Only the
    // grant's OTHER category loses authority; test the whole persisted subset.
    current = policyInput('schedule.cron', false)
    if (stage === 'submit') await expect(submitSchedule()).rejects.toMatchObject(denied)
    if (stage === 'claim' && submitted) {
      await expect(controlled.claim(submitted.requestId)).rejects.toMatchObject(denied)
      expect(await requestRow(submitted.requestId)).toMatchObject({ status: 'queued', fence: null, result: null })
    }
    if (stage === 'complete' && submitted && claimed && 'fence' in claimed) {
      if (typeof claimed.fence !== 'string') throw new Error('Expected claimed fence')
      await expect(controlled.complete({ requestId: submitted.requestId, fence: claimed.fence, result: preview })).rejects.toMatchObject(denied)
      expect(await requestRow(submitted.requestId)).toMatchObject({ status: 'running', fence: claimed.fence, result: null })
    } else if (stage === 'complete') throw new Error('Expected executable policy fixture')
    expect((await grantRow(grantId)).used_executions).toBe(stage === 'complete' ? 1 : 0)
    expect(await counts()).toEqual({ grants: 1, requests: stage === 'submit' ? 0 : 1,
      outbox: stage === 'submit' ? 0 : 1, consumers: stage === 'submit' ? 0 : 1 })
  })

  it('trigger-policy withdrawal does not replace original Connection history authorization', async () => {
    let current = policyInput('record.created', true)
    const controlled = policyLedger(() => current)
    const { grantId } = await policyGrant(controlled, ['manual'])
    const submitted = await controlled.submit(owner, { grantId, invocationId: randomUUID(), projectNo: 'synthetic-project-a', trigger: 'manual' })
    current = policyInput('record.created', false)
    await expect(controlled.claim(submitted.requestId)).rejects.toMatchObject(denied)
    expect(await controlled.observe(owner, submitted.requestId)).toEqual({ requestId: submitted.requestId, status: 'queued', result: null })
    expect(await controlled.cancel(owner, submitted.requestId)).toEqual({ requestId: submitted.requestId, status: 'cancelled' })
  })

  it.each(['actorId', 'tenantId', 'workspaceId'] as const)('does not accept a port returning another %s scope', async (field) => {
    const wrongAuthority: AutomationReadAuthorityPort = {
      ...authority,
      async lockExecution(trx, actor, selected) {
        const result = await authority.lockExecution(trx, actor, selected)
        return { ...result, [field]: 'synthetic-foreign-scope' } as typeof result
      },
    }
    const wrong = createAutomationReadLedger({ transaction, authority: wrongAuthority, manifest: fixtureManifest })
    const expiresAt = (await admin.query("SELECT clock_timestamp() + interval '1 hour' AS expiry")).rows[0].expiry as Date
    await expect(wrong.grant(owner, { selector, projects: ['synthetic-project-a'], triggers: ['manual'], budget,
      expiresAt: expiresAt.toISOString(), maxExecutions: 1 })).rejects.toThrow()
    expect((await counts()).grants).toBe(0)
  })

  it('rejects a forged transaction marker over an autocommit client before any write', async () => {
    const bad = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: work => work({ isTransaction: true, query: (sql, params) => admin.query(sql, params) }) })
    await expect(bad.grant(owner, { selector, projects: ['synthetic-project-a'], triggers: ['manual'], budget,
      expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 1 })).rejects.toMatchObject({ code: 'AUTOMATION_READ_TRANSACTION_REQUIRED' })
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0, consumers: 0 })
  })

  it('concurrent duplicate submissions create one request and one queue delivery, with immutable parameters', async () => {
    const { grantId } = await grant({ maxExecutions: 1 })
    const invocationId = randomUUID()
    const submissions = await Promise.all(Array.from({ length: 6 }, () => submit(grantId, invocationId)))
    expect(new Set(submissions.map(row => row.requestId)).size).toBe(1)
    expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1, consumers: 1 })
    expect((await grantRow(grantId)).used_executions).toBe(0)
    await expect(submit(grantId, invocationId, 'synthetic-project-b')).rejects.toMatchObject({ code: 'AUTOMATION_READ_IDEMPOTENCY_CONFLICT' })
    await expect(ledger.submit(owner, { grantId, invocationId, projectNo: 'synthetic-project-a', trigger: 'record' }))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_IDEMPOTENCY_CONFLICT' })
  })

  it('recovers a committed submit whose response was lost by the same invocation without another queue delivery', async () => {
    const { grantId } = await grant({ maxExecutions: 1 })
    const invocationId = randomUUID()
    let commits = 0
    const lostResponse = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: async work => {
        const result = await transaction(work)
        // The real COMMIT completed before this synthetic transport failure.
        commits += 1
        if (commits === 1) throw new Error('synthetic committed response lost')
        return result
      } })
    await expect(lostResponse.submit(owner, { grantId, invocationId,
      projectNo: 'synthetic-project-a', trigger: 'manual' }))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(commits).toBe(1)
    const persisted = (await admin.query(`SELECT id, status FROM integration_automation_read_requests
      WHERE grant_id = $1 AND invocation_id = $2`, [grantId, invocationId])).rows
    expect(persisted).toEqual([{ id: expect.any(String), status: 'queued' }])
    expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1, consumers: 1 })
    expect(await submit(grantId, invocationId)).toEqual({ requestId: persisted[0].id, status: 'queued' })
    expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1, consumers: 1 })
    expect((await grantRow(grantId)).used_executions).toBe(0)
  })

  it('serializes concurrent quota admission without consuming attempts until claim', async () => {
    const { grantId } = await grant({ maxExecutions: 2 })
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => submit(grantId)))
    expect(attempts.filter(row => row.status === 'fulfilled')).toHaveLength(2)
    for (const result of attempts) if (result.status === 'rejected') expect(result.reason).toMatchObject(exhausted)
    expect(await counts()).toEqual({ grants: 1, requests: 2, outbox: 2, consumers: 2 })
    expect((await grantRow(grantId)).used_executions).toBe(0)
  })

  it('rejects otherwise-valid projects and triggers absent from the grant', async () => {
    const { grantId } = await grant({ projects: ['synthetic-project-a'], triggers: ['manual'] })
    await expect(submit(grantId, randomUUID(), 'synthetic-project-b')).rejects.toMatchObject(denied)
    await expect(ledger.submit(owner, { grantId, invocationId: randomUUID(), projectNo: 'synthetic-project-a', trigger: 'schedule' }))
      .rejects.toMatchObject(denied)
    expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0, consumers: 0 })
  })

  it.each([
    ['project', "project_no = 'synthetic-project-b'"],
    ['trigger', "trigger_type = 'record'"],
  ])('does not execute a persisted request whose %s no longer belongs to the grant', async (_label, mutation) => {
    const { grantId } = await grant({ projects: ['synthetic-project-a'], triggers: ['manual'] })
    const request = await submit(grantId)
    await corruptLegacyRequest(() => admin.query(`UPDATE integration_automation_read_requests SET ${mutation} WHERE id = $1`, [request.requestId]))
    expect(await ledger.claim(request.requestId)).toEqual({ requestId: request.requestId, status: 'blocked' })
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'blocked', fence: null, result: null })
    expect((await grantRow(grantId)).used_executions).toBe(0)
  })

  it('concurrent claims reserve exactly one attempt and never reissue an active fence', async () => {
    // Spare quota isolates the request claim guard: exhaustion must not be the
    // reason a second fence cannot be issued for the SAME request.
    const { grantId } = await grant({ maxExecutions: 3 })
    const request = await submit(grantId)
    const claims = await Promise.all(Array.from({ length: 6 }, () => ledger.claim(request.requestId)))
    const executable = claims.filter(row => 'fence' in row)
    expect(executable).toHaveLength(1)
    expect(executable[0]).toMatchObject({ requestId: request.requestId, status: 'running', fence: expect.any(String),
      selector, projectNo: 'synthetic-project-a', budget })
    expect(claims.filter(row => !('fence' in row))).toEqual(Array.from({ length: 5 }, () => ({ requestId: request.requestId, status: 'running' })))
    expect((await grantRow(grantId)).used_executions).toBe(1)
    const row = await requestRow(request.requestId)
    expect(Number(row.lease_expires_at) - Number(row.started_at)).toBeLessThanOrEqual(budget.timeoutMs + 10)
    expect(Number(row.lease_expires_at) - Number(row.started_at)).toBeGreaterThan(budget.timeoutMs - 1000)
  })

  it('a committed claim whose response was lost never reissues its fence or consumes a second attempt', async () => {
    const { grantId } = await grant({ maxExecutions: 3 })
    const request = await submit(grantId)
    let commits = 0
    const lostResponse = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: async work => {
        const result = await transaction(work)
        commits += 1
        if (commits === 1) throw new Error('synthetic committed response lost')
        return result
      } })
    const failedClaim = lostResponse.claim(request.requestId)
    await expect(failedClaim).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    await expect(failedClaim).rejects.not.toHaveProperty('fence')
    expect(commits).toBe(1)
    // Only the fixture inspects storage; the failed caller receives no fence.
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'running', fence: expect.any(String), result: null })
    expect((await grantRow(grantId)).used_executions).toBe(1)
    expect(await ledger.claim(request.requestId)).toEqual({ requestId: request.requestId, status: 'running' })
    expect((await grantRow(grantId)).used_executions).toBe(1)
    await expireLease(request.requestId)
    expect(await ledger.claim(request.requestId)).toEqual({ requestId: request.requestId, status: 'outcome_unknown' })
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'outcome_unknown', result: null })
    expect((await grantRow(grantId)).used_executions).toBe(1)
    expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1, consumers: 1 })
  })

  it('stores only the bounded preview and returns duplicate invocation status without executing again', async () => {
    const { grantId } = await grant({ maxExecutions: 1 })
    const invocationId = randomUUID()
    const request = await submit(grantId, invocationId)
    const claimed = await claimExecution(request.requestId)
    expect(claimed.fence).toEqual(expect.any(String))
    expect(await ledger.complete({ requestId: request.requestId, fence: claimed.fence!, result: preview }))
      .toEqual({ requestId: request.requestId, status: 'succeeded' })
    expect(await ledger.observe(owner, request.requestId)).toEqual({ requestId: request.requestId, status: 'succeeded', result: preview })
    expect(await submit(grantId, invocationId)).toEqual({ requestId: request.requestId, status: 'succeeded' })
    expect(await ledger.claim(request.requestId)).toEqual({ requestId: request.requestId, status: 'succeeded' })
    expect((await grantRow(grantId)).used_executions).toBe(1)
    expect((await requestRow(request.requestId)).result).toEqual(preview)
    expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1, consumers: 1 })
  })

  it('rejects malformed, write-capable and private-bearing preview payloads without committing a result', async () => {
    const { grantId } = await grant()
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    const malformed = [
      { ...preview, canApply: true }, { ...preview, status: 'applied' },
      { ...preview, privateSourcePayload: 'synthetic-private-body' },
      { ...preview, counts: { ...preview.counts, add: -1 } },
      { ...preview, counts: { ...preview.counts, add: 1.5 } },
      { ...preview, counts: { ...preview.counts, add: Number.MAX_SAFE_INTEGER + 1 } },
      { ...preview, counts: { ...preview.counts, privateRecord: 'synthetic-private-record' } },
    ]
    for (const result of malformed) {
      await expect(ledger.complete({ requestId: request.requestId, fence: claimed.fence!, result: result as ReadPreview }))
        .rejects.toMatchObject(invalid)
    }
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'running', result: null })
    await ledger.complete({ requestId: request.requestId, fence: claimed.fence!, result: preview })
  })

  it('a foreign fence cannot complete or abandon the running attempt', async () => {
    const { grantId } = await grant()
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    await Promise.all([
      expect(ledger.complete({ requestId: request.requestId, fence: randomUUID(), result: preview }))
        .rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' }),
      expect(ledger.abandon({ requestId: request.requestId, fence: randomUUID() }))
        .rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' }),
    ])
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'running', fence: claimed.fence, result: null })
  })

  it('checkpoint returns detached frozen private context and reauthorizes every time without renewing or consuming quota', async () => {
    const { grantId } = await grant({ maxExecutions: 1 })
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    const before = await requestRow(request.requestId)
    let calls = 0
    const capturedRows: Record<string, unknown>[] = []
    const checking = createAutomationReadLedger({ manifest: fixtureManifest, authority: { ...authority,
      async lockExecution(trx, actor, selected) {
        calls += 1
        expect(actor).toEqual(owner)
        expect(selected).toEqual(selector)
        return authority.lockExecution(trx, actor, selected)
      },
    }, transaction: work => transaction(trx => work({ isTransaction: true, async query(sql, params) {
      const result = await trx.query(sql, params)
      if (sql.includes('FROM integration_automation_read_grants')) capturedRows.push(result.rows[0])
      return result
    } })) })
    const context = await checking.checkpoint({ requestId: request.requestId, fence: claimed.fence })
    expect(Object.keys(context).sort()).toEqual(['actor', 'authorityKey', 'authorityMode', 'budget', 'projectNo', 'remainingMs', 'selector', 'sourceReference'])
    expect(context).toMatchObject({ actor: owner, selector, projectNo: 'synthetic-project-a', budget,
      authorityKey, authorityMode: 'execution', sourceReference: await sourceReference(admin, fixtureConnectionId(owner)) })
    expect(Number.isSafeInteger(context.remainingMs)).toBe(true)
    expect(context.remainingMs).toBeGreaterThan(0)
    expect(context.remainingMs).toBeLessThanOrEqual(budget.timeoutMs)
    for (const value of [context, context.actor, context.selector, context.budget, context.sourceReference]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
    for (const row of capturedRows) {
      expect(context.budget).not.toBe(row.budget)
      expect(context.selector).not.toBe(row.selector)
      expect(context.sourceReference).not.toBe(row.source_reference)
      ;(row.budget as ReadBudget).maxRows = 999
      ;(row.selector as ReadSelector).systemId = 'synthetic-mutated-reference'
    }
    expect(context.budget).toEqual(budget)
    expect(context.selector).toEqual(selector)
    expect(JSON.stringify(context)).not.toContain('synthetic-private-config')
    const next = await checking.checkpoint({ requestId: request.requestId, fence: claimed.fence })
    expect(next.remainingMs).toBeLessThanOrEqual(context.remainingMs)
    expect(calls).toBe(2)
    expect(await requestRow(request.requestId)).toEqual(before)
    expect((await grantRow(grantId)).used_executions).toBe(1)
    expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1, consumers: 1 })
  })

  it.each(['requestId', 'fence'] as const)('checkpoint rejects malformed %s before any authority lookup', async field => {
    let calls = 0
    const checking = createAutomationReadLedger({ transaction, manifest: fixtureManifest, authority: { ...authority,
      async lockExecution(trx, actor, selected) { calls += 1; return authority.lockExecution(trx, actor, selected) },
    } })
    await expect(checking.checkpoint({ requestId: randomUUID(), fence: randomUUID(), [field]: 'not-a-uuid' }))
      .rejects.toMatchObject(invalid)
    expect(calls).toBe(0)
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0, consumers: 0 })
  })

  it.each(['queued', 'succeeded', 'blocked', 'failed', 'cancelled', 'outcome_unknown', 'wrong-fence'] as const)(
    'checkpoint refuses %s and never changes request state or reissues a fence', async state => {
      const { grantId } = await grant({ maxExecutions: 1 })
      const request = await submit(grantId)
      const claimed = await claimExecution(request.requestId)
      if (state !== 'wrong-fence') {
        await admin.query(`UPDATE integration_automation_read_requests SET status=$2,
          finished_at=CASE WHEN $2='queued' THEN NULL ELSE clock_timestamp() END WHERE id=$1`, [request.requestId, state])
      }
      const before = await requestRow(request.requestId)
      await expect(ledger.checkpoint({ requestId: request.requestId, fence: state === 'wrong-fence' ? randomUUID() : claimed.fence }))
        .rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
      expect(await requestRow(request.requestId)).toEqual(before)
      expect((await grantRow(grantId)).used_executions).toBe(1)
    },
  )

  it.each(['lease', 'grant-expiry', 'grant-revoked', 'cancel', 'revoke'] as const)(
    'checkpoint refuses %s after claim without extending the lease or publishing results', async mode => {
      const { grantId } = await grant({ maxExecutions: 1 })
      const request = await submit(grantId)
      const claimed = await claimExecution(request.requestId)
      if (mode === 'lease') await expireLease(request.requestId)
      if (mode === 'grant-expiry') await admin.query(`UPDATE integration_automation_read_grants
        SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [grantId])
      if (mode === 'grant-revoked') await admin.query("UPDATE integration_automation_read_grants SET status='revoked' WHERE id=$1", [grantId])
      if (mode === 'cancel') await ledger.cancel(owner, request.requestId)
      if (mode === 'revoke') await ledger.revoke(owner, grantId)
      const before = await requestRow(request.requestId)
      await expect(ledger.checkpoint({ requestId: request.requestId, fence: claimed.fence }))
        .rejects.toMatchObject(mode === 'cancel' || mode === 'revoke' ? { code: 'AUTOMATION_READ_FENCE_LOST' } : denied)
      expect(await requestRow(request.requestId)).toEqual(before)
      expect(before.result).toBeNull()
      expect((await grantRow(grantId)).used_executions).toBe(1)
    },
  )

  it.each(['key', 'actor', 'owner', 'source', 'port'] as const)('checkpoint rechecks changed %s authority on the same transaction', async mode => {
    const { grantId } = await grant()
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    if (mode === 'key') await mutateAuthority('authority_key=$1', ['b'.repeat(64)])
    if (mode === 'actor') await admin.query('UPDATE users SET is_active=false WHERE id=$1', [owner.actorId])
    if (mode === 'owner') await admin.query('UPDATE data_sources SET owner_id=$2 WHERE id=$1', [fixtureConnectionId(owner), otherOwner.actorId])
    if (mode === 'source') {
      const replacement = await addReplacementConnection()
      await mutateAuthority('connection_id=$1', [replacement.connectionId])
    }
    if (mode === 'port') await mutateAuthority('can_execute=false')
    await expect(ledger.checkpoint({ requestId: request.requestId, fence: claimed.fence }))
      .rejects.toMatchObject(mode === 'actor' ? actorDenied : mode === 'key' || mode === 'source' ? scopeChanged : denied)
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'running', fence: claimed.fence, result: null })
    expect((await grantRow(grantId)).used_executions).toBe(1)
  })

  it.each(['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs'] as const)('checkpoint refuses a narrowed current %s budget even with unchanged key', async field => {
    const { grantId } = await grant()
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    await mutateAuthority('budget=$1::jsonb', [JSON.stringify({ ...budget, [field]: budget[field] - 1 })])
    await expect(ledger.checkpoint({ requestId: request.requestId, fence: claimed.fence })).rejects.toMatchObject(denied)
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'running', result: null })
  })

  it.each(['grant-project', 'request-project', 'grant-trigger', 'request-trigger'] as const)(
    'checkpoint rechecks its exact project and trigger membership after %s changes', async mode => {
      const { grantId } = await grant({ projects: ['synthetic-project-a'], triggers: ['manual'] })
      const request = await submit(grantId)
      const claimed = await claimExecution(request.requestId)
      if (mode === 'grant-project') await admin.query('UPDATE integration_automation_read_grants SET projects=$2::text[] WHERE id=$1',
        [grantId, ['synthetic-project-b']])
      if (mode === 'request-project') await corruptLegacyRequest(() => admin.query('UPDATE integration_automation_read_requests SET project_no=$2 WHERE id=$1',
        [request.requestId, 'synthetic-project-b']))
      if (mode === 'grant-trigger') await admin.query('UPDATE integration_automation_read_grants SET triggers=$2::text[] WHERE id=$1',
        [grantId, ['schedule']])
      if (mode === 'request-trigger') await corruptLegacyRequest(() => admin.query('UPDATE integration_automation_read_requests SET trigger_type=$2 WHERE id=$1',
        [request.requestId, 'schedule']))
      await expect(ledger.checkpoint({ requestId: request.requestId, fence: claimed.fence })).rejects.toMatchObject(denied)
      expect(await requestRow(request.requestId)).toMatchObject({ status: 'running', result: null })
    },
  )

  it('checkpoint rechecks the whole grant trigger subset even when the current request remains approved', async () => {
    let current = policyInput('schedule.cron', true)
    const checking = policyLedger(() => current)
    const { grantId } = await policyGrant(checking, ['manual', 'schedule'])
    const request = await checking.submit(owner, { grantId, invocationId: randomUUID(), projectNo: 'synthetic-project-a', trigger: 'schedule' })
    const claimed = await checking.claim(request.requestId)
    if (!('fence' in claimed)) throw new Error('Expected executable policy fixture')
    current = policyInput('schedule.cron', false)
    await expect(checking.checkpoint({ requestId: request.requestId, fence: claimed.fence })).rejects.toMatchObject(denied)
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'running', result: null })
  })

  it('checkpoint rejects a synthetic authority generation after its original budget values return', async () => {
    const { grantId } = await grant()
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    await expect(ledger.checkpoint({ requestId: request.requestId, fence: claimed.fence })).resolves.toMatchObject({ authorityKey })
    // Explicit authority fake: generation advancement is supplied here, not
    // proof of real rule/source/target ABA triggers or a complete PLM execution.
    await mutateAuthority('budget=$1::jsonb, authority_key=$2', [JSON.stringify({ ...budget, maxRows: 99 }), 'b'.repeat(64)])
    await mutateAuthority('budget=$1::jsonb, authority_key=$2', [JSON.stringify(budget), 'c'.repeat(64)])
    await expect(ledger.checkpoint({ requestId: request.requestId, fence: claimed.fence })).rejects.toMatchObject(scopeChanged)
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'running', result: null })
  })

  it.each(['lease', 'grant'] as const)('checkpoint uses a final DB clock after locks when the %s expires during the transaction', async mode => {
    const { grantId } = await grant()
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    let delayed = false
    const checking = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: work => transaction(trx => work({ isTransaction: true, async query(sql, params) {
        const result = await trx.query(sql, params)
        if (sql.includes('FROM integration_automation_read_requests') && sql.includes('FOR UPDATE')) {
          // Inject only a consumed expiry in this owned test transaction. The
          // actual database clock advances after the locked row is captured.
          const deadline = (await trx.query("SELECT clock_timestamp()+interval '100 milliseconds' AS deadline")).rows[0].deadline
          if (mode === 'lease') result.rows[0].lease_expires_at = deadline
          else {
            // The locked grant object is retained by authorize; the wrapper
            // below records that same object rather than changing production.
            if (!lockedGrant) throw new Error('Expected grant lock before request lock')
            lockedGrant.expires_at = deadline
          }
          await trx.query('SELECT pg_sleep(0.2)')
          delayed = true
        }
        if (sql.includes('FROM integration_automation_read_grants') && sql.includes('FOR UPDATE')) lockedGrant = result.rows[0]
        return result
      } })) })
    let lockedGrant: Record<string, unknown> | undefined
    await expect(checking.checkpoint({ requestId: request.requestId, fence: claimed.fence })).rejects.toMatchObject(denied)
    expect(delayed).toBe(true)
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'running', result: null })
  })

  it.each(['checkpoint', 'cancel'] as const)('%s first holds its grant/request locks until commit and the next checkpoint sees cancellation', async first => {
    const { grantId } = await grant()
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    const held = signal(), release = signal(), followerReady = signal()
    let leaderPid = 0, followerPid = 0, followerDone = false
    const leader = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: work => transaction(work,
        async client => { leaderPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid) },
        async () => { held.resolve(); await release.promise }) })
    const follower = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: work => transaction(work, async client => {
        followerPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        followerReady.resolve()
      }) })
    const checking = { requestId: request.requestId, fence: claimed.fence }
    const leading = first === 'checkpoint' ? leader.checkpoint(checking) : leader.cancel(owner, request.requestId)
    void leading.catch(() => held.resolve())
    let following: Promise<unknown> | undefined
    try {
      await held.promise
      following = (first === 'checkpoint' ? follower.cancel(owner, request.requestId) : follower.checkpoint(checking))
        .finally(() => { followerDone = true })
      void following.catch(() => {})
      await followerReady.promise
      await observeBlocked(followerPid, leaderPid, () => followerDone)
      release.resolve()
      if (first === 'checkpoint') {
        await expect(leading).resolves.toMatchObject({ authorityKey, remainingMs: expect.any(Number) })
        await expect(following).resolves.toEqual({ requestId: request.requestId, status: 'outcome_unknown' })
      } else {
        await expect(leading).resolves.toEqual({ requestId: request.requestId, status: 'outcome_unknown' })
        await expect(following).rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
      }
      await expect(ledger.checkpoint(checking)).rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
      expect(await requestRow(request.requestId)).toMatchObject({ status: 'outcome_unknown', result: null })
      expect((await grantRow(grantId)).used_executions).toBe(1)
    } finally {
      release.resolve()
      await Promise.allSettled([leading, ...(following ? [following] : [])])
    }
  })

  it.each(['before', 'during-update'] as const)('cooperative publication abort %s never commits counts', async when => {
    const { grantId } = await grant()
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    const controller = new AbortController()
    let updates = 0
    const cancellable = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: work => transaction(trx => work({ isTransaction: true, async query(statement, params) {
        const result = await trx.query(statement, params)
        if (/UPDATE integration_automation_read_requests SET status/u.test(statement) && params?.[1] === 'succeeded') {
          updates += 1
          if (when === 'during-update') controller.abort()
        }
        return result
      } })) })
    if (when === 'before') controller.abort()
    await expect(cancellable.complete({ requestId: request.requestId, fence: claimed.fence!, result: preview,
      signal: controller.signal })).rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    expect(updates).toBe(when === 'before' ? 0 : 1)
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'running', result: null })
    expect(await ledger.abandon({ requestId: request.requestId, fence: claimed.fence! }))
      .toEqual({ requestId: request.requestId, status: 'outcome_unknown' })
    expect((await grantRow(grantId)).used_executions).toBe(1)
  })

  it('terminal COMMIT handoff may win cancellation, but an abandon waits for the true durable result and never reclaims', async () => {
    const { grantId } = await grant()
    const request = await submit(grantId), claimed = await claimExecution(request.requestId)
    const held = signal(), release = signal(), followerReady = signal()
    const controller = new AbortController()
    let leaderPid = 0, followerPid = 0, followerDone = false
    const leader = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: work => transaction(work,
        async client => { leaderPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid) },
        async () => { held.resolve(); await release.promise }) })
    const follower = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: work => transaction(work, async client => {
        followerPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        followerReady.resolve()
      }) })
    const completing = leader.complete({ requestId: request.requestId, fence: claimed.fence!, result: preview, signal: controller.signal })
    let abandoning: Promise<unknown> | undefined
    try {
      await held.promise
      controller.abort()
      abandoning = follower.abandon({ requestId: request.requestId, fence: claimed.fence! }).finally(() => { followerDone = true })
      await followerReady.promise
      await observeBlocked(followerPid, leaderPid, () => followerDone)
      release.resolve()
      const expected = { requestId: request.requestId, status: 'succeeded' }
      expect(await completing).toEqual(expected)
      expect(await abandoning).toEqual(expected)
      expect(await ledger.claim(request.requestId)).toEqual(expected)
      expect((await grantRow(grantId)).used_executions).toBe(1)
    } finally {
      release.resolve()
      await Promise.allSettled([completing, ...(abandoning ? [abandoning] : [])])
    }
  })

  it('lost terminal COMMIT receipt is reconciled without repeating completion or minting another fence', async () => {
    const { grantId } = await grant()
    const request = await submit(grantId), claimed = await claimExecution(request.requestId)
    let commits = 0
    const lostReceipt = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: async work => {
        await transaction(work); commits += 1
        throw new Error('synthetic terminal receipt lost')
      } })
    await expect(lostReceipt.complete({ requestId: request.requestId, fence: claimed.fence!, result: preview }))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(commits).toBe(1)
    expect(await ledger.abandon({ requestId: request.requestId, fence: claimed.fence! }))
      .toEqual({ requestId: request.requestId, status: 'succeeded' })
    expect(await ledger.claim(request.requestId)).toEqual({ requestId: request.requestId, status: 'succeeded' })
    expect((await grantRow(grantId)).used_executions).toBe(1)
  })

  it.each(['claim', 'complete'] as const)('expired lease at %s becomes unknown without result, retry or quota refund', async (operation) => {
    const { grantId } = await grant({ maxExecutions: 1 })
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    await expireLease(request.requestId)
    const outcome = operation === 'claim' ? await ledger.claim(request.requestId)
      : await ledger.complete({ requestId: request.requestId, fence: claimed.fence!, result: preview })
    expect(outcome).toEqual({ requestId: request.requestId, status: 'outcome_unknown' })
    expect(await ledger.claim(request.requestId)).toEqual(outcome)
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'outcome_unknown', result: null, finished_at: expect.any(Date) })
    expect((await grantRow(grantId)).used_executions).toBe(1)
    await expect(submit(grantId)).rejects.toMatchObject(exhausted)
  })

  it('abandon consumes the attempt and permanently records unknown outcome', async () => {
    const { grantId } = await grant({ maxExecutions: 1 })
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    expect(await ledger.abandon({ requestId: request.requestId, fence: claimed.fence! }))
      .toEqual({ requestId: request.requestId, status: 'outcome_unknown' })
    expect(await ledger.claim(request.requestId)).toEqual({ requestId: request.requestId, status: 'outcome_unknown' })
    expect((await grantRow(grantId)).used_executions).toBe(1)
  })

  it('queued cancellation releases admission capacity; concurrent cancellation and claim never leave runnable work', async () => {
    const { grantId } = await grant({ maxExecutions: 1 })
    const first = await submit(grantId)
    expect(await ledger.cancel(owner, first.requestId)).toEqual({ requestId: first.requestId, status: 'cancelled' })
    expect((await grantRow(grantId)).used_executions).toBe(0)
    const next = await submit(grantId)
    await Promise.all([ledger.claim(next.requestId), ledger.cancel(owner, next.requestId)])
    const final = await requestRow(next.requestId)
    expect(['cancelled', 'outcome_unknown']).toContain(final.status)
    expect(final.result).toBeNull()
    expect((await grantRow(grantId)).used_executions).toBe(final.status === 'cancelled' ? 0 : 1)
    expect(await ledger.claim(next.requestId)).toEqual({ requestId: next.requestId, status: final.status })
  })

  it('revocation blocks queued work, fences running work and retains succeeded history', async () => {
    const { grantId } = await grant()
    const completed = await submit(grantId)
    const running = await submit(grantId)
    const queued = await submit(grantId)
    const completedClaim = await claimExecution(completed.requestId)
    await ledger.complete({ requestId: completed.requestId, fence: completedClaim.fence!, result: preview })
    const runningClaim = await claimExecution(running.requestId)
    expect(await ledger.revoke(owner, grantId)).toEqual({ grantId, status: 'revoked' })
    expect(await ledger.claim(queued.requestId)).toEqual({ requestId: queued.requestId, status: 'blocked' })
    await expect(ledger.complete({ requestId: running.requestId, fence: runningClaim.fence!, result: preview }))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    expect(await ledger.observe(owner, completed.requestId)).toEqual({ requestId: completed.requestId, status: 'succeeded', result: preview })
    expect(await requestRow(running.requestId)).toMatchObject({ status: 'outcome_unknown', result: null })
    expect((await grantRow(grantId)).used_executions).toBe(2)
    expect((await counts()).requests).toBe(3)
  })

  it('database-clock grant expiry rejects submit, blocks queued claim and makes a running completion unknown', async () => {
    const { grantId } = await grant()
    const running = await submit(grantId)
    const queued = await submit(grantId)
    const claimed = await claimExecution(running.requestId)
    await admin.query("UPDATE integration_automation_read_grants SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [grantId])
    await expect(submit(grantId)).rejects.toThrow()
    expect(await ledger.claim(queued.requestId)).toEqual({ requestId: queued.requestId, status: 'blocked' })
    expect(await ledger.complete({ requestId: running.requestId, fence: claimed.fence!, result: preview }))
      .toEqual({ requestId: running.requestId, status: 'outcome_unknown' })
    expect((await grantRow(grantId)).used_executions).toBe(1)
  })

  it('changed authority invalidates submit, claim and completion, but does not deny history observation', async () => {
    const { grantId } = await grant()
    const running = await submit(grantId)
    const queued = await submit(grantId)
    const claimed = await claimExecution(running.requestId)
    await mutateAuthority('authority_key = $1', ['b'.repeat(64)])
    await expect(submit(grantId)).rejects.toMatchObject(scopeChanged)
    await expect(ledger.claim(queued.requestId)).rejects.toMatchObject(scopeChanged)
    await expect(ledger.complete({ requestId: running.requestId, fence: claimed.fence!, result: preview })).rejects.toMatchObject(scopeChanged)
    expect(await ledger.observe(owner, running.requestId)).toEqual({ requestId: running.requestId, status: 'running', result: null })
    expect((await grantRow(grantId)).used_executions).toBe(1)
    await expireLease(running.requestId)
    expect(await ledger.observe(owner, running.requestId)).toEqual({ requestId: running.requestId, status: 'outcome_unknown', result: null })
  })

  it('checks the current port budget and denial on every execution boundary', async () => {
    const { grantId } = await grant()
    const queued = await submit(grantId)
    await mutateAuthority('budget = $1::jsonb', [JSON.stringify({ ...budget, maxRows: 1 })])
    await expect(submit(grantId)).rejects.toThrow()
    await expect(ledger.claim(queued.requestId)).rejects.toThrow()
    await mutateAuthority('budget = $1::jsonb, can_execute = false', [JSON.stringify(budget)])
    await expect(ledger.claim(queued.requestId)).rejects.toMatchObject(denied)
    expect((await grantRow(grantId)).used_executions).toBe(0)
    expect((await requestRow(queued.requestId)).status).toBe('queued')
  })

  it('claim uses the persisted owner and current actor authority; revocation prevents execution and observation', async () => {
    const { grantId } = await grant()
    const queued = await submit(grantId)
    await admin.query('DELETE FROM user_roles WHERE user_id = $1', [owner.actorId])
    await expect(ledger.claim(queued.requestId)).rejects.toMatchObject(actorDenied)
    await expect(ledger.observe(owner, queued.requestId)).rejects.toMatchObject(actorDenied)
    expect((await grantRow(grantId)).used_executions).toBe(0)
    expect((await requestRow(queued.requestId)).status).toBe('queued')
  })

  it.each(['actor', 'port'] as const)('revoking %s authority after claim prevents result publication, while fenced abandon stays safe', async (mode) => {
    const { grantId } = await grant({ maxExecutions: 1 })
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    if (mode === 'actor') await admin.query('UPDATE users SET is_active = false WHERE id = $1', [owner.actorId])
    else await mutateAuthority('can_execute = false')
    await expect(ledger.complete({ requestId: request.requestId, fence: claimed.fence, result: preview }))
      .rejects.toMatchObject(mode === 'actor' ? actorDenied : denied)
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'running', result: null })
    expect(await ledger.abandon({ requestId: request.requestId, fence: claimed.fence }))
      .toEqual({ requestId: request.requestId, status: 'outcome_unknown' })
    expect((await grantRow(grantId)).used_executions).toBe(1)
  })

  it.each([otherOwner, otherTenant])('never borrows positive authority from another owner or tenant ($actorId / $tenantId)', async (foreign) => {
    const { grantId } = await grant()
    const request = await submit(grantId)
    await expect(ledger.submit(foreign, { grantId, invocationId: randomUUID(), projectNo: 'synthetic-project-a', trigger: 'manual' })).rejects.toMatchObject(denied)
    await expect(ledger.observe(foreign, request.requestId)).rejects.toMatchObject(denied)
    await expect(ledger.cancel(foreign, request.requestId)).rejects.toMatchObject(denied)
    await expect(ledger.revoke(foreign, grantId)).rejects.toMatchObject(denied)
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'queued', result: null })
    expect((await grantRow(grantId)).status).toBe('active')
  })

  it('history observation requires current connection ownership independently of version drift', async () => {
    const { grantId } = await grant()
    const request = await submit(grantId)
    const claimed = await claimExecution(request.requestId)
    await ledger.complete({ requestId: request.requestId, fence: claimed.fence!, result: preview })
    await mutateAuthority('authority_key = $1, can_execute = false', ['c'.repeat(64)])
    await expect(ledger.observe(owner, request.requestId)).resolves.toMatchObject({ status: 'succeeded', result: preview })
    await admin.query('UPDATE data_sources SET owner_id = $2 WHERE id = $1', [fixtureConnectionId(owner), otherOwner.actorId])
    await expect(ledger.observe(owner, request.requestId)).rejects.toMatchObject(denied)
  })

  it('binds history to the original connection instead of the current system pointer', async () => {
    const { requestId, grantId, original } = await completedRequest()
    const replacement = await addReplacementConnection()
    await mutateAuthority('connection_id = $1', [replacement.connectionId])
    // Both positive and negative checks hit the same old request. A profile
    // pointer move alone must neither retarget history nor deny its real owner.
    await expect(ledger.observe(owner, requestId)).resolves.toEqual({ requestId, status: 'succeeded', result: preview })
    await admin.query('UPDATE data_sources SET owner_id = $2 WHERE id = $1', [original.connectionId, otherOwner.actorId])
    await expect(ledger.observe(owner, requestId)).rejects.toMatchObject(denied)
    await expect(ledger.cancel(owner, requestId)).rejects.toMatchObject(denied)
    await expect(ledger.revoke(owner, grantId)).rejects.toMatchObject(denied)
    // The new source owner has positive platform authority, but cannot inherit
    // another creator's private request even though it now owns the old source.
    await expect(ledger.observe(otherOwner, requestId)).rejects.toMatchObject(denied)
    expect((await grantRow(grantId)).source_reference).toEqual(original)
    expect((await requestRow(requestId)).result).toEqual(preview)
  })

  it('keeps original-owner history after selector deletion, config rotation and owner transfer back', async () => {
    const { requestId, original } = await completedRequest()
    const previous = (await admin.query('SELECT validation_revision FROM data_sources WHERE id=$1', [original.connectionId])).rows[0]
    await admin.query('DELETE FROM synthetic_read_authority')
    await admin.query(`UPDATE data_sources SET config=config || '{"rotated":true}' WHERE id=$1`, [original.connectionId])
    const afterRotation = (await admin.query('SELECT validation_revision,connection_incarnation FROM data_sources WHERE id=$1', [original.connectionId])).rows[0]
    expect(afterRotation.validation_revision).not.toBe(previous.validation_revision)
    expect(afterRotation.connection_incarnation).toBe(original.connectionIncarnation)
    await expect(ledger.observe(owner, requestId)).resolves.toMatchObject({ result: preview })
    await admin.query('UPDATE data_sources SET owner_id=$2 WHERE id=$1', [original.connectionId, otherOwner.actorId])
    await expect(ledger.observe(owner, requestId)).rejects.toMatchObject(denied)
    await admin.query('UPDATE data_sources SET owner_id=$2 WHERE id=$1', [original.connectionId, owner.actorId])
    expect(await sourceReference(admin, original.connectionId)).toEqual(original)
    await expect(ledger.observe(owner, requestId)).resolves.toMatchObject({ result: preview })
  })

  it.each(['hard', 'soft'] as const)('same-ID %s delete and recreation never adopts historical authority', async mode => {
    const { requestId, grantId, original } = await completedRequest()
    if (mode === 'hard') {
      await admin.query('DELETE FROM data_sources WHERE id=$1', [original.connectionId])
    } else {
      await admin.query('UPDATE data_sources SET is_active=false,deleted_at=clock_timestamp() WHERE id=$1', [original.connectionId])
    }
    const tombstone = (await admin.query(`SELECT connection_incarnation,deleted_at
      FROM integration_data_source_validation_revisions WHERE data_source_id=$1`, [original.connectionId])).rows[0]
    expect(tombstone.connection_incarnation).toBe(original.connectionIncarnation)
    expect(tombstone.deleted_at).not.toBeNull()
    await expect(ledger.observe(owner, requestId)).rejects.toMatchObject(denied)
    // Actual INSERT ... ON CONFLICT shape also exercises the current POST
    // recreate path. A supplied old nonce is not authority.
    await admin.query(`INSERT INTO data_sources (id,type,owner_id,tenant_id,scope_kind,is_active,connection_incarnation)
      VALUES ($1,'postgresql',$2,$3,'private',true,$4::uuid)
      ON CONFLICT (id) DO UPDATE SET owner_id=EXCLUDED.owner_id,config=EXCLUDED.config,
      is_active=true,deleted_at=NULL,connection_incarnation=EXCLUDED.connection_incarnation`,
    [original.connectionId, owner.actorId, owner.tenantId, original.connectionIncarnation])
    const replacement = await sourceReference(admin, original.connectionId)
    expect(replacement.connectionIncarnation).not.toBe(original.connectionIncarnation)
    await expect(ledger.observe(owner, requestId)).rejects.toMatchObject(denied)
    await expect(ledger.cancel(owner, requestId)).rejects.toMatchObject(denied)
    await expect(ledger.revoke(owner, grantId)).rejects.toMatchObject(denied)
    expect((await requestRow(requestId)).result).toEqual(preview)
    expect((await grantRow(grantId)).source_reference).toEqual(original)
  })

  it('ignores caller-supplied incarnation on live updates and preserves no-op identity', async () => {
    const { requestId, original } = await completedRequest()
    const revision = (await admin.query('SELECT validation_revision FROM data_sources WHERE id=$1', [original.connectionId])).rows[0].validation_revision
    await admin.query('UPDATE data_sources SET connection_incarnation=$2::uuid WHERE id=$1', [original.connectionId, randomUUID()])
    expect(await sourceReference(admin, original.connectionId)).toEqual(original)
    expect((await admin.query('SELECT validation_revision FROM data_sources WHERE id=$1', [original.connectionId])).rows[0].validation_revision).toBe(revision)
    await expect(ledger.observe(owner, requestId)).resolves.toMatchObject({ result: preview })
  })

  it('independently matches the stored reference even when the execution key is unchanged', async () => {
    const { grantId } = await grant()
    const running = await submit(grantId), queued = await submit(grantId)
    const claimed = await claimExecution(running.requestId)
    const replacement = await addReplacementConnection()
    await mutateAuthority('connection_id=$1', [replacement.connectionId])
    expect((await grantRow(grantId)).authority_key).toBe(authorityKey)
    await expect(submit(grantId)).rejects.toMatchObject(scopeChanged)
    await expect(ledger.claim(queued.requestId)).rejects.toMatchObject(scopeChanged)
    await expect(ledger.complete({ requestId: running.requestId, fence: claimed.fence, result: preview })).rejects.toMatchObject(scopeChanged)
    expect((await grantRow(grantId)).used_executions).toBe(1)
    expect((await requestRow(running.requestId)).result).toBeNull()
  })

  it.each([
    ['missing mirror', 'DELETE FROM integration_data_source_validation_revisions WHERE data_source_id=$1'],
    ['different mirror owner', "UPDATE integration_data_source_validation_revisions SET owner_id='different-owner' WHERE data_source_id=$1"],
    ['different mirror tenant', "UPDATE integration_data_source_validation_revisions SET tenant_id='different-tenant' WHERE data_source_id=$1"],
    ['different mirror incarnation', 'UPDATE integration_data_source_validation_revisions SET connection_incarnation=gen_random_uuid() WHERE data_source_id=$1'],
    ['different mirror revision', 'UPDATE integration_data_source_validation_revisions SET validation_revision=gen_random_uuid() WHERE data_source_id=$1'],
    ['workspace source', "UPDATE data_sources SET workspace_id='different-workspace' WHERE id=$1"],
    ['shared source', "UPDATE data_sources SET scope_kind='workspace' WHERE id=$1"],
    ['disabled source', 'UPDATE data_sources SET is_active=false WHERE id=$1'],
  ])('history rejects %s without exposing a private result', async (_name, sql) => {
    const { requestId, original } = await completedRequest()
    await admin.query(sql, [original.connectionId])
    await expect(ledger.observe(owner, requestId)).rejects.toMatchObject(denied)
    expect((await requestRow(requestId)).result).toEqual(preview)
  })

  it.each(['missing', 'owner', 'incarnation'] as const)('stale live-looking mirror cannot hide an actual source %s change', async mode => {
    const { requestId, original } = await completedRequest()
    await admin.query('ALTER TABLE data_sources DISABLE TRIGGER USER')
    try {
      if (mode === 'missing') await admin.query('DELETE FROM data_sources WHERE id=$1', [original.connectionId])
      else if (mode === 'owner') await admin.query('UPDATE data_sources SET owner_id=$2 WHERE id=$1', [original.connectionId, otherOwner.actorId])
      else await admin.query('UPDATE data_sources SET connection_incarnation=gen_random_uuid() WHERE id=$1', [original.connectionId])
      await expect(ledger.observe(owner, requestId)).rejects.toMatchObject(denied)
    } finally { await admin.query('ALTER TABLE data_sources ENABLE TRIGGER USER') }
  })

  it('observation reads only identity metadata, never config, credentials or the current selector', async () => {
    const { requestId, original } = await completedRequest()
    const observed: string[] = []
    let passedReference: ReadSourceReference | undefined
    const traced = createAutomationReadLedger({ transaction, manifest: fixtureManifest, authority: { ...authority,
      async lockObservation(trx, actor, reference) {
        passedReference = reference
        return lockAutomationReadSourceObservation({ query(sql, params) {
          observed.push(sql)
          return trx.query(sql, params)
        } }, actor, reference)
      },
    } })
    const result = await traced.observe(owner, requestId)
    expect(result).toEqual({ requestId, status: 'succeeded', result: preview })
    expect(passedReference).toEqual(original)
    expect(Object.isFrozen(passedReference)).toBe(true)
    expect(observed.some(sql => /\b(?:config|credentials_encrypted|synthetic_read_authority|integration_external_systems)\b/iu.test(sql))).toBe(false)
    expect(observed.filter(sql => /FROM data_sources\b/iu.test(sql))).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain(original.connectionId)
    expect(JSON.stringify(result)).not.toContain(original.connectionIncarnation)
  })

  it('source identity migration rollback refuses retained grants and preserves history', async () => {
    const { requestId, original } = await completedRequest()
    await expect(db.transaction().execute(removeSourceRevisions)).rejects.toMatchObject({ code: '55000' })
    expect(await sourceReference(admin, original.connectionId)).toEqual(original)
    await expect(ledger.observe(owner, requestId)).resolves.toMatchObject({ result: preview })
  })

  it('source identity migration replay preserves both live and tombstoned lifetimes', async () => {
    const { requestId, original } = await completedRequest()
    const removed = await addReplacementConnection()
    await admin.query('DELETE FROM data_sources WHERE id=$1', [removed.connectionId])
    await db.transaction().execute(addSourceRevisions)
    expect(await sourceReference(admin, original.connectionId)).toEqual(original)
    expect((await admin.query(`SELECT connection_incarnation FROM integration_data_source_validation_revisions
      WHERE data_source_id=$1`, [removed.connectionId])).rows[0].connection_incarnation).toBe(removed.connectionIncarnation)
    await expect(ledger.observe(owner, requestId)).resolves.toMatchObject({ result: preview })
  })

  it('source rollback ignores same-named decoy relations and anchors history plus DDL to the DS schema', async () => {
    const { requestId, original } = await completedRequest()
    const decoySchema = `${schema}_decoy`
    // Both exact names derive from this suite's validated random owned schema.
    await admin.query(`CREATE SCHEMA "${decoySchema}"`)
    try {
      await admin.query(`CREATE TABLE "${decoySchema}".integration_automation_read_grants (id uuid);
        CREATE TABLE "${decoySchema}".integration_data_source_validation_revisions (marker text);
        INSERT INTO "${decoySchema}".integration_data_source_validation_revisions VALUES ('synthetic-decoy');
        CREATE TABLE "${decoySchema}".integration_external_systems (validation_revision uuid)`)
      const decoyDown = () => db.transaction().execute(async trx => {
        await sql.raw(`SET LOCAL search_path = "${decoySchema}", "${schema}"`).execute(trx)
        await removeSourceRevisions(trx)
      })
      await expect(decoyDown()).rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_READ_HISTORY_ROLLBACK_FORBIDDEN' })
      expect(await sourceReference(admin, original.connectionId)).toEqual(original)
      await expect(ledger.observe(owner, requestId)).resolves.toMatchObject({ result: preview })
      await resetAutomationReadExecutionLinks(admin, async () => {
        await admin.query('TRUNCATE integration_automation_read_record_activations, integration_automation_read_executions, multitable_automation_executions, integration_automation_read_requests, integration_automation_read_grants')
      })
      await decoyDown()
      expect((await admin.query(`SELECT marker FROM "${decoySchema}".integration_data_source_validation_revisions`)).rows)
        .toEqual([{ marker: 'synthetic-decoy' }])
      expect((await admin.query(`SELECT validation_revision FROM "${decoySchema}".integration_external_systems`)).rows).toEqual([])
      expect((await admin.query("SELECT to_regclass('integration_data_source_validation_revisions') AS mirror")).rows[0].mirror).toBeNull()
    } finally {
      await db.transaction().execute(addSourceRevisions)
      await admin.query(`DROP SCHEMA "${decoySchema}" CASCADE`)
    }
  })

  it('source identity rollback refuses a competing source writer without waiting, then succeeds with empty history', async () => {
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query('UPDATE data_sources SET config=config WHERE id=$1', [fixtureConnectionId(owner)])
      await expect(db.transaction().execute(removeSourceRevisions)).rejects.toMatchObject({
        code: '55P03', message: 'AUTOMATION_READ_MIGRATION_ROLLBACK_BUSY',
      })
    } finally { await writer.query('ROLLBACK'); writer.release() }
    await db.transaction().execute(removeSourceRevisions)
    expect((await admin.query("SELECT to_regclass('integration_data_source_validation_revisions') AS mirror")).rows[0].mirror).toBeNull()
    await db.transaction().execute(addSourceRevisions)
    await expect(grant()).resolves.toMatchObject({ grantId: expect.any(String) })
  })

  it('DDL validates exact source-reference shape and JS-compatible canonical IDs', async () => {
    const { grantId } = await grant()
    const original = (await grantRow(grantId)).source_reference as ReadSourceReference
    const malformed: unknown[] = [null, [], {}, { ...original, extra: true },
      { connectionId: original.connectionId }, { ...original, connectionIncarnation: null },
      { ...original, connectionIncarnation: original.connectionIncarnation.toUpperCase() },
      { ...original, connectionIncarnation: original.connectionIncarnation + '\n' },
      ...['', ' x', 'x\u00a0', '\ufeffx', 'x\t', 'x\u007fy', 'x'.repeat(256), '😀'.repeat(128)]
        .map(connectionId => ({ ...original, connectionId })),
    ]
    for (const value of malformed) {
      await expect(admin.query('UPDATE integration_automation_read_grants SET source_reference=$2::jsonb WHERE id=$1',
        [grantId, JSON.stringify(value)])).rejects.toMatchObject({ code: '23514' })
    }
    for (const connectionId of ['x'.repeat(255), '😀'.repeat(127) + 'x', 'x\u00a0y']) {
      await admin.query('UPDATE integration_automation_read_grants SET source_reference=$2::jsonb WHERE id=$1',
        [grantId, JSON.stringify({ ...original, connectionId })])
    }
    await admin.query('UPDATE integration_automation_read_grants SET source_reference=$2::jsonb WHERE id=$1',
      [grantId, JSON.stringify(original)])
  })

  it('captured grant reference cannot be swapped during observation authority lookup', async () => {
    const { requestId, grantId, original } = await completedRequest()
    const replacement = await addReplacementConnection()
    let visits = 0
    const swapped = createAutomationReadLedger({ transaction, manifest: fixtureManifest, authority: { ...authority,
      async lockObservation(trx, actor, reference) {
        visits++
        expect(reference).toEqual(original)
        const proof = await lockAutomationReadSourceObservation(trx, actor, reference)
        // Separate committed connection: the ledger has read its hint, but has
        // not acquired its grant row lock yet. The authority remains valid.
        await admin.query('UPDATE integration_automation_read_grants SET source_reference=$2::jsonb WHERE id=$1',
          [grantId, JSON.stringify(replacement)])
        return proof
      },
    } })
    await expect(swapped.observe(owner, requestId)).rejects.toMatchObject(scopeChanged)
    expect(visits).toBe(1)
    expect((await requestRow(requestId)).result).toEqual(preview)
  })

  it.each(['reference', 'actor', 'getter', 'serializer'] as const)('refuses malformed observation provider %s without evaluating code', async mode => {
    const { requestId } = await completedRequest()
    let sideEffects = 0
    const malformed = createAutomationReadLedger({ transaction, manifest: fixtureManifest, authority: { ...authority,
      async lockObservation(trx, actor, reference) {
        const proof = { ...await lockAutomationReadSourceObservation(trx, actor, reference) }
        if (mode === 'reference') proof.sourceReference = { ...reference, connectionIncarnation: randomUUID() }
        if (mode === 'actor') proof.actorId = otherOwner.actorId
        if (mode === 'getter') Object.defineProperty(proof, 'sourceReference', { enumerable: true,
          get() { sideEffects++; return reference } })
        if (mode === 'serializer') Object.defineProperty(proof, 'toJSON', { value() { sideEffects++; return proof } })
        return proof
      },
    } })
    await expect(malformed.observe(owner, requestId)).rejects.toMatchObject(denied)
    expect(sideEffects).toBe(0)
  })

  it('grant persists a detached source reference even if the provider mutates it during the next await', async () => {
    const reference = await sourceReference(admin, fixtureConnectionId(owner))
    const mutable = { ...reference }
    const captured = createAutomationReadLedger({ manifest: fixtureManifest, authority: { ...authority,
      async lockExecution(trx, actor, selected) {
        return { ...await authority.lockExecution(trx, actor, selected), sourceReference: mutable }
      },
    }, transaction: work => transaction(trx => work({ isTransaction: true, query(sql, params) {
      if (sql.includes('extract(epoch FROM clock_timestamp())')) mutable.connectionIncarnation = randomUUID()
      return trx.query(sql, params)
    } })) })
    const result = await captured.grant(owner, { selector, budget, projects: ['synthetic-project-a'],
      triggers: ['manual'], maxExecutions: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    expect(mutable).not.toEqual(reference)
    expect((await grantRow(result.grantId)).source_reference).toEqual(reference)
  })

  it.each(['missing', 'incarnation', 'getter', 'serializer'] as const)('grant rejects a malformed execution provider %s before persistence', async mode => {
    let sideEffects = 0
    const malformed = createAutomationReadLedger({ transaction, manifest: fixtureManifest, authority: { ...authority,
      async lockExecution(trx, actor, selected) {
        const proof = { ...await authority.lockExecution(trx, actor, selected) }
        if (mode === 'missing') Reflect.deleteProperty(proof, 'sourceReference')
        if (mode === 'incarnation') proof.sourceReference = { ...proof.sourceReference, connectionIncarnation: 'caller-selected' }
        if (mode === 'getter') Object.defineProperty(proof, 'sourceReference', { enumerable: true,
          get() { sideEffects++; return proof.sourceReference } })
        if (mode === 'serializer') Object.defineProperty(proof, 'toJSON', { value() { sideEffects++; return proof } })
        return proof
      },
    } })
    await expect(malformed.grant(owner, { selector, budget, projects: ['synthetic-project-a'],
      triggers: ['manual'], maxExecutions: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toMatchObject(denied)
    expect(sideEffects).toBe(0)
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0, consumers: 0 })
  })

  it.each(['missing', 'empty', 'duplicate', 'unknown', 'top-getter', 'index-getter', 'hidden', 'serializer', 'prototype'] as const)(
    'grant requires a detached closed provider allowedTriggers set: %s', async mode => {
      let sideEffects = 0
      const malformed = createAutomationReadLedger({ transaction, manifest: fixtureManifest, authority: { ...authority,
        async lockExecution(trx, actor, selected) {
          const proof = { ...await authority.lockExecution(trx, actor, selected) }
          if (mode === 'missing') Reflect.deleteProperty(proof, 'allowedTriggers')
          if (mode === 'empty') proof.allowedTriggers = []
          if (mode === 'duplicate') proof.allowedTriggers = ['manual', 'manual']
          if (mode === 'unknown') proof.allowedTriggers = ['webhook' as ReadTrigger]
          if (mode === 'top-getter') Object.defineProperty(proof, 'allowedTriggers', { enumerable: true,
            get() { sideEffects += 1; return ['manual'] } })
          if (mode === 'index-getter') Object.defineProperty(proof.allowedTriggers, '0', { enumerable: true,
            get() { sideEffects += 1; return 'manual' } })
          if (mode === 'hidden') Object.defineProperty(proof.allowedTriggers, 'extra', { value: true })
          if (mode === 'serializer') Object.defineProperty(proof.allowedTriggers, 'toJSON', { value() {
            sideEffects += 1; return ['manual']
          } })
          if (mode === 'prototype') Object.setPrototypeOf(proof.allowedTriggers, { toJSON() {
            sideEffects += 1; return ['manual']
          } })
          return proof
        },
      } })
      await expect(policyGrant(malformed, ['manual'])).rejects.toMatchObject(denied)
      expect(sideEffects).toBe(0)
      expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0, consumers: 0 })
    },
  )

  it('captures requested trigger data before an await and never invokes request hooks', async () => {
    const requested: ReadTrigger[] = ['manual']
    const controlled = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: work => transaction(async trx => {
        requested[0] = 'record'
        return work(trx)
      }) })
    const { grantId } = await policyGrant(controlled, requested)
    expect((await grantRow(grantId)).triggers).toEqual(['manual'])
    let sideEffects = 0
    const accessor: ReadTrigger[] = ['manual']
    Object.defineProperty(accessor, '0', { enumerable: true, get() { sideEffects += 1; return 'manual' } })
    await expect(policyGrant(controlled, accessor)).rejects.toMatchObject(invalid)
    expect(sideEffects).toBe(0)
    expect((await counts()).grants).toBe(1)
  })

  it('observation prerequisite itself refuses autocommit and non-RC transactions', async () => {
    const original = await sourceReference(admin, fixtureConnectionId(owner))
    await expect(lockAutomationReadSourceObservation(admin, owner, original)).rejects.toMatchObject({ code: 'AUTOMATION_READ_TRANSACTION_REQUIRED' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await expect(lockAutomationReadSourceObservation(client, owner, original)).rejects.toMatchObject({ code: 'AUTOMATION_READ_TRANSACTION_REQUIRED' })
    } finally { await client.query('ROLLBACK'); client.release() }
  })

  it('real history mirror lock holds a concurrent owner transfer until observation commits', async () => {
    const { requestId, original } = await completedRequest()
    const locked = signal(), release = signal()
    let readerPid = 0, done = false
    const reader = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: work => transaction(trx => work({ isTransaction: true, async query(sql, params) {
        if (sql.includes('FROM data_sources WHERE id = $1')) {
          locked.resolve()
          await release.promise
        }
        return trx.query(sql, params)
      } }), async client => { readerPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid) }) })
    const observing = reader.observe(owner, requestId)
    void observing.catch(() => locked.resolve())
    const writer = await pool.connect()
    let updating: Promise<unknown> | undefined
    try {
      await locked.promise
      const writerPid = Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      updating = writer.query('UPDATE data_sources SET owner_id=$2 WHERE id=$1', [original.connectionId, otherOwner.actorId])
        .finally(() => { done = true })
      void updating.catch(() => {})
      await observeBlocked(writerPid, readerPid, () => done)
      release.resolve()
      await expect(observing).resolves.toMatchObject({ result: preview })
      await updating
      await expect(ledger.observe(owner, requestId)).rejects.toMatchObject(denied)
    } finally {
      release.resolve()
      await Promise.allSettled([observing, ...(updating ? [updating] : [])])
      writer.release()
    }
  })

  it('writer-first source transfer makes observation fail closed without blocking behind the source row', async () => {
    const { requestId, original } = await completedRequest()
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query('UPDATE data_sources SET owner_id=$2 WHERE id=$1', [original.connectionId, otherOwner.actorId])
      await expect(ledger.observe(owner, requestId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
      await writer.query('COMMIT')
      await expect(ledger.observe(owner, requestId)).rejects.toMatchObject(denied)
    } finally { await writer.query('ROLLBACK'); writer.release() }
  })

  it('a revoke already holding the grant row blocks a competing claim, which observes the revocation after commit', async () => {
    const { grantId } = await grant({ maxExecutions: 1 })
    const request = await submit(grantId)
    const revocationReady = signal()
    const releaseRevocation = signal()
    const claimantReady = signal()
    let revokerPid = 0
    let claimantPid = 0
    let claimDone = false
    const revoker = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: work => transaction(work,
        async client => { revokerPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid) },
        async () => { revocationReady.resolve(); await releaseRevocation.promise }) })
    const claimant = createAutomationReadLedger({ authority, manifest: fixtureManifest,
      transaction: work => transaction(work, async client => {
        claimantPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        claimantReady.resolve()
      }) })
    const revoking = revoker.revoke(owner, grantId)
    void revoking.catch(() => { revocationReady.resolve() })
    let claiming: ReturnType<typeof ledger.claim> | undefined
    try {
      await revocationReady.promise
      claiming = claimant.claim(request.requestId).finally(() => { claimDone = true })
      void claiming.catch(() => {})
      await claimantReady.promise
      await observeBlocked(claimantPid, revokerPid, () => claimDone)
      releaseRevocation.resolve()
      const [, result] = await Promise.all([revoking, claiming])
      expect(result).toEqual({ requestId: request.requestId, status: 'blocked' })
      expect((await grantRow(grantId)).used_executions).toBe(0)
    } finally {
      releaseRevocation.resolve()
      await Promise.allSettled([revoking, ...(claiming ? [claiming] : [])])
    }
  })

  it('migration constraints reject cross-scope references and invalid terminal or running states', async () => {
    const { grantId } = await grant()
    const request = await submit(grantId)
    const rejectedUpdates = [
      ['UPDATE integration_automation_read_grants SET workspace_id = $2 WHERE id = $1', 'synthetic-workspace'],
      ['UPDATE integration_automation_read_grants SET used_executions = $2 WHERE id = $1', 4],
      ['UPDATE integration_automation_read_grants SET projects = $2::text[] WHERE id = $1', []],
      ['UPDATE integration_automation_read_grants SET triggers = $2::text[] WHERE id = $1', ['write']],
      ['UPDATE integration_automation_read_grants SET authority_key = $2 WHERE id = $1', 'caller-version'],
    ] as const
    for (const [sql, value] of rejectedUpdates) await expect(admin.query(sql, [grantId, value])).rejects.toMatchObject({ code: '23514' })
    await expect(corruptLegacyRequest(() => admin.query('UPDATE integration_automation_read_requests SET tenant_id = $2 WHERE id = $1',
      [request.requestId, otherTenant.tenantId]))).rejects.toMatchObject({ code: '23503' })
    await expect(admin.query("UPDATE integration_automation_read_requests SET status = 'running' WHERE id = $1", [request.requestId]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(admin.query("UPDATE integration_automation_read_requests SET status = 'cancelled' WHERE id = $1", [request.requestId]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(admin.query("UPDATE integration_automation_read_requests SET result = '{}'::jsonb WHERE id = $1", [request.requestId]))
      .rejects.toMatchObject({ code: '23514' })
  })

  it('migration down refuses retained history; empty rollback and reapply succeed', async () => {
    const { grantId } = await grant()
    const request = await submit(grantId)
    await ledger.cancel(owner, request.requestId)
    await expect(migrate('down')).rejects.toMatchObject({ code: '55000' })
    expect(await requestRow(request.requestId)).toMatchObject({ status: 'cancelled' })
    await resetAutomationReadExecutionLinks(admin, async () => {
      await admin.query('TRUNCATE integration_automation_read_record_activations, integration_automation_read_executions, multitable_automation_executions, integration_automation_read_requests, integration_automation_read_grants')
    })
    await db.transaction().execute(removeRecordActivation)
    await db.transaction().execute(removeExecutionAudit)
    await migrate('down')
    expect((await admin.query(`SELECT to_regclass('integration_automation_read_grants') AS grants,
      to_regclass('integration_automation_read_requests') AS requests`)).rows[0]).toEqual({ grants: null, requests: null })
    await migrate('up')
    await db.transaction().execute(addExecutionAudit)
    await db.transaction().execute(addRecordActivation)
    expect((await counts()).grants).toBe(0)
  })
})
