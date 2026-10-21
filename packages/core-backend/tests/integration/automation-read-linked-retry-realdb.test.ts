/** Real isolated PG ledger/audit/observation. Execution authority is explicitly
 * synthetic: these tests prove atomic state/ownership, not actual PLM/target ACL. */
import { randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { up as ledgerUp } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { up as sourceUp } from '../../src/db/migrations/zzzz20261001120001_stock_prep_validation_source_revisions'
import { up as auditUp } from '../../src/db/migrations/zzzz20261001134000_automation_read_execution_audit'
import { up as purposeUp } from '../../src/db/migrations/zzzz20261001135000_automation_read_record_activation'
import { up as retryUp, down as retryDown } from '../../src/db/migrations/zzzz20261002142000_automation_read_linked_retry'
import { createAutomationReadExecutionLogSchema, resetAutomationReadExecutionLinks } from '../utils/automation-read-execution-schema'
import { createAutomationReadLedger } from '../../src/integration/automation-read-ledger'
import { lockAutomationReadSourceObservation } from '../../src/integration/automation-read-source-observation'
import { AUTOMATION_READ_EVENT, AUTOMATION_READ_CONSUMER, AutomationReadLedgerError,
  type AutomationReadAuthorityPort, type ReadRetryInput, type ReadBudget } from '../../src/integration/automation-read-contracts'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

const describeDb = process.env.DATABASE_URL ? describe : describe.skip
const actor = { actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null } as const
const selector = { ruleId: 'synthetic-rule', actionId: 'synthetic-action', systemId: 'synthetic-system', targetId: 'synthetic-target' }
const cap: ReadBudget = { maxRows: 100, maxPages: 20, maxReadCount: 100, timeoutMs: 60000 }
const manifest = { version: 1001, routes: { [AUTOMATION_READ_EVENT]: [AUTOMATION_READ_CONSUMER] } }
const signal = () => new AbortController().signal

describeDb('Automation linked retry: actual PG atomicity with synthetic execution proof', () => {
  const schema = 'automation_read_retry_' + randomBytes(8).toString('hex')
  let pool: Pool, admin: PoolClient, db: Kysely<unknown>
  let created = false
  let key = 'a'.repeat(64), permitted = true, sourceId = 'synthetic-connection'
  let ledger: ReturnType<typeof createAutomationReadLedger>
  async function transaction<T>(work: (trx: TransactionalQueryable) => Promise<T>, afterCommit?: () => void) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const result = await work({ isTransaction: true, query: (statement, params) => client.query(statement, params) })
      await client.query('COMMIT')
      afterCommit?.()
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  const authority: AutomationReadAuthorityPort = {
    async lockExecution(trx, owner) {
      if (!permitted) throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
      const row = (await trx.query('SELECT connection_incarnation::text FROM data_sources WHERE id=$1', [sourceId])).rows[0]
      if (!row) throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
      const proof = await lockAutomationReadSourceObservation(trx, owner,
        { connectionId: sourceId, connectionIncarnation: String(row.connection_incarnation) })
      return { ...proof, key, budget: cap, allowedTriggers: ['manual', 'record', 'schedule'] }
    }, lockObservation: lockAutomationReadSourceObservation,
  }
  const makeLedger = (run = transaction) => createAutomationReadLedger({ transaction: run, authority, manifest })
  async function input(): Promise<ReadRetryInput> {
    const expiry = (await admin.query("SELECT clock_timestamp()+interval '1 hour' AS expiry")).rows[0].expiry as Date
    return { retryKey: randomUUID(), budget: { ...cap }, expiresAt: expiry.toISOString(), acknowledgeNewRead: true }
  }
  async function parent(status = 'cancelled', trigger: 'manual' | 'record' | 'schedule' = 'manual') {
    const command = await input()
    const grant = await ledger.grant(actor, { selector, projects: ['synthetic-project'], triggers: [trigger],
      budget: { ...cap, maxRows: 10 }, expiresAt: command.expiresAt, maxExecutions: 2 })
    const request = await ledger.submit(actor, { grantId: grant.grantId, invocationId: randomUUID(),
      projectNo: 'synthetic-project', trigger })
    if (status === 'cancelled') await ledger.cancel(actor, request.requestId)
    else if (status !== 'queued') await admin.query(`UPDATE integration_automation_read_requests
      SET status=$2,finished_at=CASE WHEN $2='running' THEN NULL ELSE clock_timestamp() END,
        fence=CASE WHEN $2='running' THEN gen_random_uuid() ELSE NULL END,
        started_at=CASE WHEN $2='running' THEN clock_timestamp() ELSE NULL END,
        lease_expires_at=CASE WHEN $2='running' THEN clock_timestamp()+interval '1 minute' ELSE NULL END
      WHERE id=$1`, [request.requestId, status])
    return { ...request, grantId: grant.grantId, command }
  }
  async function counts() {
    return (await admin.query(`SELECT (SELECT count(*)::int FROM integration_automation_read_grants) AS grants,
      (SELECT count(*)::int FROM integration_automation_read_requests) AS requests,
      (SELECT count(*)::int FROM integration_automation_read_retries) AS retries,
      (SELECT count(*)::int FROM integration_automation_read_executions) AS audits,
      (SELECT count(*)::int FROM meta_automation_outbox) AS events`)).rows[0]
  }
  beforeAll(async () => {
    if (!/^automation_read_retry_[a-f0-9]{16}$/u.test(schema)) throw new Error('UNOWNED_RETRY_SCHEMA')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, options: '-c search_path=' + schema + ' -c statement_timeout=10000' })
    admin = await pool.connect()
    await admin.query('CREATE SCHEMA ' + schema); created = true
    await admin.query(`CREATE TABLE users(id text PRIMARY KEY,role text,permissions jsonb,is_active boolean,activation_status text);
      CREATE TABLE user_roles(user_id varchar(255),role_id varchar(255),PRIMARY KEY(user_id,role_id));
      CREATE TABLE role_permissions(role_id varchar(255),permission_code varchar(255),PRIMARY KEY(role_id,permission_code));
      CREATE TABLE user_permissions(user_id varchar(255),permission_code varchar(255),PRIMARY KEY(user_id,permission_code));
      CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean NOT NULL,PRIMARY KEY(user_id,org_id));
      CREATE TABLE user_namespace_admissions(user_id text,namespace text,enabled boolean NOT NULL DEFAULT false,UNIQUE(user_id,namespace));
      CREATE TABLE automation_rules(id text PRIMARY KEY,sheet_id text NOT NULL,created_by text NOT NULL,enabled boolean NOT NULL,action_type text NOT NULL,integration_authority_revision uuid NOT NULL);
      CREATE TABLE data_sources(id text PRIMARY KEY,config jsonb NOT NULL DEFAULT '{}',type text NOT NULL,owner_id text NOT NULL,tenant_id text,workspace_id text,scope_kind text NOT NULL,is_active boolean NOT NULL DEFAULT true,deleted_at timestamptz);
      CREATE TABLE integration_external_systems(id text PRIMARY KEY,tenant_id text NOT NULL,workspace_id text,kind text NOT NULL,role text NOT NULL,status text NOT NULL,connection_id text,config jsonb NOT NULL DEFAULT '{}',credentials_encrypted text);
      CREATE TABLE meta_automation_outbox(id text PRIMARY KEY,event_type text NOT NULL,payload jsonb NOT NULL,automation_depth integer NOT NULL,manifest_version integer NOT NULL,event_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE meta_automation_outbox_consumer(outbox_id text NOT NULL REFERENCES meta_automation_outbox(id) ON DELETE CASCADE,consumer_key text NOT NULL,status text NOT NULL DEFAULT 'pending',PRIMARY KEY(outbox_id,consumer_key));`)
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL,
      max: 1, options: '-c search_path=' + schema }) }) })
    await db.transaction().execute(sourceUp)
    await db.transaction().execute(ledgerUp)
    await createAutomationReadExecutionLogSchema(admin)
    await db.transaction().execute(auditUp)
    await db.transaction().execute(purposeUp)
    await db.transaction().execute(retryUp)
  })
  beforeEach(async () => {
    await admin.query('ALTER TABLE integration_automation_read_retries DISABLE TRIGGER automation_read_retry_link_no_truncate')
    try { await resetAutomationReadExecutionLinks(admin, () => admin.query(`TRUNCATE integration_automation_read_retries,
      integration_automation_read_record_activations,integration_automation_read_executions,multitable_automation_executions,
      integration_automation_read_requests,integration_automation_read_grants,automation_rules,
      meta_automation_outbox_consumer,meta_automation_outbox,integration_data_source_validation_revisions,
      integration_external_systems,data_sources,users,user_roles,role_permissions,user_permissions,user_orgs,user_namespace_admissions`).then(() => {})) }
    finally { await admin.query('ALTER TABLE integration_automation_read_retries ENABLE TRIGGER automation_read_retry_link_no_truncate') }
    key = 'a'.repeat(64); permitted = true; sourceId = 'synthetic-connection'; ledger = makeLedger()
    for (const owner of ['synthetic-owner', 'synthetic-other']) {
      await admin.query("INSERT INTO users VALUES($1,'user','[]',true,'activated')", [owner])
      await admin.query("INSERT INTO user_roles VALUES($1,'admin')", [owner])
      await admin.query('INSERT INTO user_orgs VALUES($1,$2,true),($1,$3,true)', [owner, actor.tenantId, 'synthetic-other-tenant'])
    }
    await admin.query("INSERT INTO automation_rules VALUES($1,'synthetic-sheet',$2,true,'integration_read_preview',$3)", [selector.ruleId, actor.actorId, randomUUID()])
    await admin.query("INSERT INTO data_sources(id,type,owner_id,tenant_id,scope_kind) VALUES($1,'postgresql',$2,$3,'private')", [sourceId, actor.actorId, actor.tenantId])
  })
  afterAll(async () => {
    await db?.destroy()
    if (admin) { await admin.query('ROLLBACK').catch(() => {}); if (created) await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); admin.release() }
    await pool?.end()
  })
  it.each(['blocked', 'failed', 'cancelled', 'outcome_unknown'])('atomically links a fresh single budget from %s without changing the parent', async status => {
    const p = await parent(status)
    const before = (await admin.query('SELECT * FROM integration_automation_read_requests WHERE id=$1', [p.requestId])).rows[0]
    const child = await ledger.retry(actor, p.requestId, p.command, signal())
    expect(child).toEqual({ parentRequestId: p.requestId, grantId: expect.any(String), requestId: expect.any(String), status: 'queued' })
    expect((await admin.query('SELECT * FROM integration_automation_read_requests WHERE id=$1', [p.requestId])).rows[0]).toEqual(before)
    expect(await ledger.grantDetail(actor, child.grantId)).toMatchObject({ purpose: 'retry', triggers: ['manual'], projects: ['synthetic-project'], maxExecutions: 1, usedExecutions: 0, budget: cap })
    expect(await counts()).toEqual({ grants: 2, requests: 2, retries: 1, audits: 2, events: 2 })
    expect(await ledger.retryContext(actor, p.requestId)).toMatchObject({ request: { requestId: p.requestId, status }, nextAttempt: { requestId: child.requestId, grantId: child.grantId } })
    expect(await ledger.claim(child.requestId)).toMatchObject({ status: 'running', fence: expect.any(String), budget: cap })
  })
  it.each(['queued', 'running', 'succeeded'])('rejects %s parents without reconciliation or new rows', async status => {
    const p = await parent(status), before = await counts()
    await expect(ledger.retry(actor, p.requestId, p.command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    expect(await counts()).toEqual(before)
  })
  it.each(['record', 'schedule'] as const)('does not silently implement %s retries', async trigger => {
    const p = await parent('cancelled', trigger)
    await expect(ledger.retry(actor, p.requestId, p.command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    expect((await counts()).retries).toBe(0)
  })
  it('recovers the same child after lost COMMIT receipt and changed execution authority', async () => {
    const p = await parent()
    const lost = makeLedger(work => transaction(work, () => { throw new Error('synthetic lost COMMIT response') }))
    await expect(lost.retry(actor, p.requestId, p.command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    const before = await counts(); permitted = false; key = 'b'.repeat(64)
    const recovered = await ledger.retry(actor, p.requestId, p.command, signal())
    expect(recovered).toMatchObject({ parentRequestId: p.requestId, status: 'queued' })
    expect(await counts()).toEqual(before)
    await ledger.revoke(actor, recovered.grantId)
    expect(await ledger.retry(actor, p.requestId, p.command, signal())).toMatchObject({ ...recovered, status: 'blocked' })
  })
  it('allows an inactive old grant but rejects current key/permission/incarnation drift for fresh attempts', async () => {
    const p = await parent()
    await ledger.revoke(actor, p.grantId)
    await expect(ledger.retry(actor, p.requestId, p.command, signal())).resolves.toMatchObject({ status: 'queued' })
    const q = await parent(); key = 'b'.repeat(64)
    await expect(ledger.retry(actor, q.requestId, q.command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    key = 'a'.repeat(64); permitted = false
    await expect(ledger.retry(actor, q.requestId, q.command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
  })
  it.each([{ actorId: 'synthetic-other' }, { tenantId: 'synthetic-other-tenant' }])('denies different live owner/tenant for create/context/recovery: %j', async scope => {
    const p = await parent(), child = await ledger.retry(actor, p.requestId, p.command, signal()), before = await counts()
    const other = { ...actor, ...scope }
    await expect(ledger.retry(other, p.requestId, p.command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    await expect(ledger.retryContext(other, p.requestId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    expect(child.requestId).not.toBe(p.requestId); expect(await counts()).toEqual(before)
  })
  it('rejects new keys for the same parent, changed consent and key reuse for another parent', async () => {
    const p = await parent(), child = await ledger.retry(actor, p.requestId, p.command, signal())
    for (const command of [{ ...p.command, retryKey: randomUUID() }, { ...p.command, budget: { ...cap, maxRows: 99 } }]) {
      await expect(ledger.retry(actor, p.requestId, command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_IDEMPOTENCY_CONFLICT' })
    }
    const q = await parent()
    await expect(ledger.retry(actor, q.requestId, p.command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_IDEMPOTENCY_CONFLICT' })
    await ledger.cancel(actor, child.requestId)
    await expect(ledger.submit(actor, { grantId: child.grantId, invocationId: randomUUID(), projectNo: 'synthetic-project', trigger: 'manual' })).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    const next = await ledger.retry(actor, child.requestId, await input(), signal())
    expect(next.parentRequestId).toBe(child.requestId)
  })
  it('concurrent distinct keys admit at most one child and do not deadlock', async () => {
    const p = await parent(), second = { ...p.command, retryKey: randomUUID() }
    const receipts = await Promise.allSettled([ledger.retry(actor, p.requestId, p.command, signal()), ledger.retry(actor, p.requestId, second, signal())])
    expect(receipts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = receipts.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: expect.stringMatching(/^AUTOMATION_READ_(?:UNAVAILABLE|IDEMPOTENCY_CONFLICT)$/u) } })
    expect((await counts()).retries).toBe(1)
  })
  it('concurrent same-key receipts recover one identical child without another budget', async () => {
    const p = await parent()
    const receipts = await Promise.allSettled([ledger.retry(actor, p.requestId, p.command, signal()), ledger.retry(actor, p.requestId, p.command, signal())])
    const successes = receipts.filter(result => result.status === 'fulfilled')
    expect(successes.length).toBeGreaterThanOrEqual(1)
    const recovered = await ledger.retry(actor, p.requestId, p.command, signal())
    for (const result of successes) if (result.status === 'fulfilled') expect(result.value).toEqual(recovered)
    for (const result of receipts) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect((await counts()).retries).toBe(1)
  })
  it('original Connection revival denies both recovery and fresh retry despite the same source id', async () => {
    const p = await parent(), q = await parent()
    await ledger.retry(actor, p.requestId, p.command, signal())
    await admin.query('UPDATE data_sources SET deleted_at=clock_timestamp() WHERE id=$1', [sourceId])
    await admin.query('UPDATE data_sources SET deleted_at=NULL WHERE id=$1', [sourceId])
    await expect(ledger.retry(actor, p.requestId, p.command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    await expect(ledger.retry(actor, q.requestId, q.command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
  })
  it('removal of current integration admin permission denies recovery and context', async () => {
    const p = await parent(); await ledger.retry(actor, p.requestId, p.command, signal())
    await admin.query('DELETE FROM user_roles WHERE user_id=$1', [actor.actorId])
    await expect(ledger.retry(actor, p.requestId, p.command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_AUTHORITY_DENIED' })
    await expect(ledger.retryContext(actor, p.requestId)).rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_AUTHORITY_DENIED' })
  })
  it('expired and exhausted original budget is not reset or reused by a fresh explicit budget', async () => {
    const p = await parent()
    await admin.query("UPDATE integration_automation_read_grants SET expires_at=clock_timestamp()-interval '1 second',used_executions=max_executions WHERE id=$1", [p.grantId])
    const before = (await admin.query('SELECT * FROM integration_automation_read_grants WHERE id=$1', [p.grantId])).rows[0]
    const child = await ledger.retry(actor, p.requestId, p.command, signal())
    expect((await admin.query('SELECT * FROM integration_automation_read_grants WHERE id=$1', [p.grantId])).rows[0]).toEqual(before)
    expect(await ledger.grantDetail(actor, child.grantId)).toMatchObject({ usedExecutions: 0, maxExecutions: 1, budget: cap })
  })
  it('rejects over-cap budget, past new expiry and malformed explicit consent without rows', async () => {
    const p = await parent(), before = await counts()
    const commands: unknown[] = [{ ...p.command, budget: { ...cap, maxRows: cap.maxRows + 1 } },
      { ...p.command, expiresAt: '2000-01-01T00:00:00.000Z' }, { ...p.command, acknowledgeNewRead: false },
      { ...p.command, extra: true }, { ...p.command, retryKey: p.command.retryKey.toUpperCase() },
      Object.defineProperty({ ...p.command }, 'budget', { enumerable: true, get() { throw new Error('Getter must not execute') } })]
    for (const command of commands) await expect(ledger.retry(actor, p.requestId, command as ReadRetryInput, signal())).rejects.toMatchObject({ code: expect.stringMatching(/^AUTOMATION_READ_(?:INPUT_INVALID|DENIED)$/u) })
    expect(await counts()).toEqual(before)
  })
  it('protects a genuine pre-audit parent identity and its original standalone grant after linking', async () => {
    const command = await input()
    const grant = await ledger.grant(actor, { selector, projects: ['synthetic-project'], triggers: ['manual'], budget: cap,
      expiresAt: command.expiresAt, maxExecutions: 1 })
    const parentId = randomUUID()
    await admin.query(`INSERT INTO integration_automation_read_requests(id,grant_id,tenant_id,owner_id,invocation_id,project_no,trigger_type,status,finished_at)
      VALUES($1,$2,$3,$4,$5,'synthetic-project','manual','cancelled',clock_timestamp())`, [parentId, grant.grantId, actor.tenantId, actor.actorId, randomUUID()])
    expect((await admin.query('SELECT count(*)::int AS n FROM integration_automation_read_executions WHERE request_id=$1', [parentId])).rows[0].n).toBe(0)
    await ledger.retry(actor, parentId, command, signal())
    await expect(admin.query("UPDATE integration_automation_read_requests SET project_no='changed' WHERE id=$1", [parentId])).rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_READ_RETRY_REQUEST_IDENTITY_IMMUTABLE' })
    await expect(admin.query("UPDATE integration_automation_read_grants SET selector=jsonb_set(selector,'{systemId}','\"changed\"') WHERE id=$1", [grant.grantId])).rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_READ_RETRY_GRANT_IDENTITY_IMMUTABLE' })
  })
  it('missing retry migration fails before any new grant and restoring it preserves old history', async () => {
    const p = await parent()
    await db.transaction().execute(retryDown)
    try {
      await expect(ledger.retry(actor, p.requestId, p.command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
      expect((await admin.query('SELECT count(*)::int AS n FROM integration_automation_read_grants')).rows[0].n).toBe(1)
      expect((await admin.query('SELECT count(*)::int AS n FROM integration_automation_read_requests')).rows[0].n).toBe(1)
    } finally { await db.transaction().execute(retryUp) }
    await expect(ledger.retry(actor, p.requestId, p.command, signal())).resolves.toMatchObject({ status: 'queued' })
  })
  it('a real outbox INSERT failure rolls back the new grant/request/audit/link', async () => {
    const p = await parent(), before = await counts()
    await admin.query(`CREATE FUNCTION synthetic_retry_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
      CREATE TRIGGER synthetic_retry_failure BEFORE INSERT ON meta_automation_outbox FOR EACH ROW EXECUTE FUNCTION synthetic_retry_failure()`)
    try { await expect(ledger.retry(actor, p.requestId, p.command, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' }); expect(await counts()).toEqual(before) }
    finally { await admin.query('DROP TRIGGER synthetic_retry_failure ON meta_automation_outbox; DROP FUNCTION synthetic_retry_failure()') }
  })
  it('abort during a real new-request receipt rolls back and same key remains usable', async () => {
    const p = await parent(), controller = new AbortController(), before = await counts()
    const aborted = makeLedger(work => transaction(trx => work({ isTransaction: true, async query(statement, params) {
      const receipt = await trx.query(statement, params)
      if (statement.startsWith('INSERT INTO integration_automation_read_requests')) controller.abort()
      return receipt
    } })))
    await expect(aborted.retry(actor, p.requestId, p.command, controller.signal)).rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    expect(await counts()).toEqual(before)
    await expect(ledger.retry(actor, p.requestId, p.command, signal())).resolves.toMatchObject({ status: 'queued' })
  })
  it('rejects orphan retry grants at COMMIT and retained-history down', async () => {
    const p = await parent(), before = await counts()
    await expect(transaction(trx => trx.query(`INSERT INTO integration_automation_read_grants
      (id,tenant_id,owner_id,selector,source_reference,authority_key,projects,triggers,budget,expires_at,max_executions,purpose)
      SELECT $2,tenant_id,owner_id,selector,source_reference,authority_key,ARRAY['synthetic-project'],ARRAY['manual'],budget,expires_at,1,'retry'
      FROM integration_automation_read_grants WHERE id=$1`, [p.grantId, randomUUID()]))).rejects.toMatchObject({ code: '23514' })
    expect(await counts()).toEqual(before)
    const child = await ledger.retry(actor, p.requestId, p.command, signal())
    await expect(db.transaction().execute(retryDown)).rejects.toMatchObject({ code: '55000' })
    await expect(admin.query('DELETE FROM integration_automation_read_retries WHERE request_id=$1', [child.requestId])).rejects.toMatchObject({ code: '55000' })
    await expect(admin.query("UPDATE integration_automation_read_requests SET invocation_id='changed' WHERE id=$1", [p.requestId])).rejects.toMatchObject({ code: '55000' })
    await expect(admin.query('DELETE FROM integration_automation_read_requests WHERE id=$1', [p.requestId])).rejects.toMatchObject({ code: '23503' })
  })
})
