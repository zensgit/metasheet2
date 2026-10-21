/** SA-06V: real activation/ledger/audit/outbox transactions and DB guards.
 * Source authority is deliberately synthetic; rule identity and actor RBAC are
 * read from this owned PG schema. The companion authority suite proves the
 * production JWT/source/dispatcher path. This suite never reads a source DB.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { up as addOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { up as addRuleRevision } from '../../src/db/migrations/zzzz20261001122000_automation_rule_authority_revision'
import { up as addLedger } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { up as addAudit } from '../../src/db/migrations/zzzz20261001134000_automation_read_execution_audit'
import { up as addActivation, down as removeActivation } from '../../src/db/migrations/zzzz20261001135000_automation_read_record_activation'
import { up as addUpdatedActivation, down as removeUpdatedActivation } from '../../src/db/migrations/zzzz20261001137000_automation_read_record_updated_activation'
import { up as addMaterialEpochs } from '../../src/db/migrations/zzzz20261001130000_automation_read_material_epochs'
import { up as addRecordConditions, down as removeRecordConditions } from '../../src/db/migrations/zzzz20261001140000_automation_read_record_conditions'
import { createAutomationReadLedger } from '../../src/integration/automation-read-ledger'
import { AUTOMATION_READ_OPERATION } from '../../src/integration/automation-read-operation-policy'
import { AUTOMATION_READ_CONSUMER, AUTOMATION_READ_EVENT, AutomationReadLedgerError,
  type AutomationReadAuthorityPort, type ReadPreview } from '../../src/integration/automation-read-contracts'
import { enqueueOutboxEvent } from '../../src/multitable/automation-outbox-enqueue'
import { claimDueConsumers } from '../../src/multitable/automation-durable-dispatcher'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'
import { createAutomationReadExecutionLogSchema, resetAutomationReadExecutionLinks } from '../utils/automation-read-execution-schema'

const describeDb = process.env.DATABASE_URL ? describe : describe.skip
const expectDb = process.env.EXPECT_DB === '1' ? it : it.skip
expectDb('EXPECT_DB supplies a database for atomic record activation', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
const actor = { actorId: 'synthetic-record-owner', tenantId: 'synthetic-record-tenant', workspaceId: null }
const selector = { ruleId: 'synthetic-record-rule', actionId: 'synthetic-record-action', systemId: 'synthetic-record-system', targetId: 'synthetic-record-target' }
const sourceReference = { connectionId: 'synthetic-record-source', connectionIncarnation: randomUUID() }
const budget = { maxRows: 20, maxPages: 2, maxReadCount: 30, timeoutMs: 60000 }
const preview: ReadPreview = { status: 'ready', counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false }
const recordEvent = 'multitable.record.created', recordConsumer = 'automation-record-trigger'
const manifest = { version: 1902, routes: { [AUTOMATION_READ_EVENT]: [AUTOMATION_READ_CONSUMER],
  [recordEvent]: [recordConsumer], 'multitable.record.updated': [recordConsumer] } }
const signal = () => new AbortController().signal

describeDb('Record activation: owner consent, durable identity and automatic-only enforcement', () => {
  const schema = 'automation_read_record_' + randomBytes(8).toString('hex')
  let pool: Pool, admin: PoolClient, db: Kysely<unknown>, created = false
  let ledger: ReturnType<typeof createAutomationReadLedger>
  let ruleRevision: string
  let beforeQuery: ((statement: string, params?: unknown[]) => Promise<void>) | undefined
  async function transaction<T>(work: (trx: TransactionalQueryable) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const result = await work({ isTransaction: true, async query(statement, params) {
        await beforeQuery?.(statement, params)
        return client.query(statement, params)
      } })
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  const authority: AutomationReadAuthorityPort = {
    async lockExecution(trx, principal, selected) {
      const rule = (await trx.query('SELECT * FROM automation_rules WHERE id=$1 FOR SHARE', [selected.ruleId])).rows[0]
      if (!rule || rule.created_by !== principal.actorId || rule.enabled !== true) {
        throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
      }
      return { ...principal, key: createHash('sha256').update(String(rule.integration_authority_revision)).digest('hex'),
        budget, sourceReference, allowedTriggers: ['manual', 'record'] }
    },
    // Synthetic source capability only. These callbacks do NOT prove condition evaluation or ACLs;
    // the companion authority suite uses the actual host module and private after-image evidence.
    async lockRecordExecution(trx, principal, selected) { return authority.lockExecution(trx, principal, selected) },
    recordConditionFor() { return { mode: 'unconditional' } },
    async evaluateRecordConditions() { return { kind: 'match' } },
    async lockObservation(_trx, principal, reference) { return { ...principal, sourceReference: reference } },
  }
  const makeLedger = () => createAutomationReadLedger({ transaction, authority, manifest })
  const activationInput = (activationKey = randomUUID()) => ({ activationKey, expectedRuleRevision: ruleRevision,
    expectedRecordCondition: { mode: 'unconditional' as const },
    selector, projectNo: 'SYN-RECORD-PROJECT',
    budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 3 })
  const activate = (input = activationInput(), port = ledger) => port.activateRecord(actor, input)
  async function setRecordTrigger(trigger: 'record.created' | 'record.updated') {
    const result = await admin.query(`UPDATE automation_rules SET trigger_type=$2 WHERE id=$1
      RETURNING integration_authority_revision::text AS revision`, [selector.ruleId, trigger])
    ruleRevision = String(result.rows[0].revision)
  }
  async function delivery(options: { eventId?: string; eventType?: string; payload?: unknown; depth?: number } = {}) {
    const queued = await transaction(trx => enqueueOutboxEvent(trx, { eventType: options.eventType ?? recordEvent,
      eventId: options.eventId ?? randomUUID(), payload: options.payload ?? { sheetId: 'synthetic-record-sheet', recordId: 'synthetic-record' },
      automationDepth: options.depth ?? 0 }, manifest))
    const claimed = await claimDueConsumers(admin, { consumerKeys: [recordConsumer], batchSize: 100, leaseMs: 60000 })
    const found = claimed.find(row => row.outboxId === queued.outboxId)
    if (!found) throw new Error('SYNTHETIC_RECORD_DELIVERY_MISSING')
    return { outboxId: found.outboxId, eventId: found.eventId, fence: found.fence, attempts: found.attempts }
  }
  async function submitted() {
    const pair = await activate(), event = await delivery()
    const request = await ledger.submitRecord(pair.activationId, event, signal())
    if (!request) throw new Error('SYNTHETIC_RECORD_REQUEST_MISSING')
    return { ...pair, event, ...request }
  }
  async function counts() {
    return (await admin.query(`SELECT
      (SELECT count(*)::int FROM integration_automation_read_grants) grants,
      (SELECT count(*)::int FROM integration_automation_read_record_activations) activations,
      (SELECT count(*)::int FROM integration_automation_read_requests) requests,
      (SELECT count(*)::int FROM integration_automation_read_executions) links,
      (SELECT count(*)::int FROM multitable_automation_executions) executions,
      (SELECT count(*)::int FROM meta_automation_outbox WHERE event_type=$1) read_events`, [AUTOMATION_READ_EVENT])).rows[0]
  }
  const empty = { grants: 0, activations: 0, requests: 0, links: 0, executions: 0, read_events: 0 }
  const activated = { ...empty, grants: 1, activations: 1 }
  const queued = { grants: 1, activations: 1, requests: 1, links: 1, executions: 1, read_events: 1 }
  async function sheetRevision() {
    return String((await admin.query("SELECT revision::text FROM automation_read_material_epochs WHERE kind='sheet' AND scope=jsonb_build_object('id','synthetic-record-sheet')")).rows[0].revision)
  }
  async function savedCondition() {
    return { mode: 'saved_conditions', schemaRevision: await sheetRevision(), businessTimeZone: 'Asia/Shanghai' }
  }
  async function directActivation(confirmation: unknown, options: { omitConfirmation?: boolean; revision?: string; activatedAt?: string } = {}) {
    const standalone = await ledger.grant(actor, { selector, projects: ['SYN-RECORD-PROJECT'], triggers: ['record'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 1 })
    return transaction(async trx => {
      const fresh = randomUUID()
      await trx.query(`INSERT INTO integration_automation_read_grants
        (id,tenant_id,owner_id,selector,authority_key,source_reference,projects,triggers,budget,expires_at,max_executions,purpose)
        SELECT $2,tenant_id,owner_id,selector,authority_key,source_reference,projects,triggers,budget,expires_at,max_executions,'automatic'
        FROM integration_automation_read_grants WHERE id=$1`, [standalone.grantId, fresh])
      const params: unknown[] = [randomUUID(), randomUUID(), fresh, actor.tenantId, 'SYN-RECORD-PROJECT', selector.ruleId,
        options.revision ?? ruleRevision, options.activatedAt ?? '2020-01-01T00:00:00.000Z']
      if (!options.omitConfirmation) params.push(JSON.stringify(confirmation))
      const row = (await trx.query(`INSERT INTO integration_automation_read_record_activations
        (id,activation_key,grant_id,tenant_id,owner_id,rule_id,rule_revision,sheet_id,project_no,activated_at${options.omitConfirmation ? '' : ',condition_confirmation'})
        SELECT $1,$2,$3,$4,created_by,id,$7::uuid,sheet_id,$5,$8::timestamptz${options.omitConfirmation ? '' : ',$9::jsonb'}
        FROM automation_rules WHERE id=$6 RETURNING id,grant_id,activated_at${options.omitConfirmation ? '' : ',condition_confirmation'}`, params)).rows[0]
      if (typeof row?.id !== 'string' || typeof row.grant_id !== 'string') throw new Error('SYNTHETIC_DIRECT_ACTIVATION_RECEIPT_MISSING')
      return { id: row.id, grant_id: row.grant_id, activated_at: row.activated_at, condition_confirmation: row.condition_confirmation }
    })
  }
  async function claimed(requestId: string) {
    const result = await ledger.claim(requestId)
    expect(result.status).toBe('running')
    if (!('fence' in result)) throw new Error('SYNTHETIC_RECORD_CLAIM_MISSING')
    return result.fence
  }
  beforeAll(async () => {
    if (!/^automation_read_record_[a-f0-9]{16}$/u.test(schema)) throw new Error('UNOWNED_RECORD_SCHEMA')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10,
      options: '-c search_path=' + schema + ' -c statement_timeout=8000' })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    admin = await pool.connect()
    await admin.query('CREATE SCHEMA "' + schema + '"'); created = true
    await admin.query(`CREATE TABLE users(id text PRIMARY KEY,role text,permissions jsonb,is_active boolean,activation_status text);
      CREATE TABLE user_roles(user_id text,role_id text);
      CREATE TABLE role_permissions(role_id text,permission_code text);
      CREATE TABLE user_permissions(user_id text,permission_code text);
      CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean);
      CREATE TABLE user_namespace_admissions(user_id text,namespace text,enabled boolean);
      CREATE TABLE automation_rules(id text PRIMARY KEY,sheet_id text NOT NULL,created_by text,enabled boolean NOT NULL,
        trigger_type text NOT NULL,trigger_config jsonb,conditions jsonb,action_type text NOT NULL,action_config jsonb NOT NULL,actions jsonb,
        execution_mode text NOT NULL DEFAULT 'legacy',name text NOT NULL DEFAULT 'Synthetic record rule',
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE meta_bases(id text PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE meta_sheets(id text PRIMARY KEY,base_id text,deleted_at timestamptz);
      CREATE TABLE meta_fields(id text PRIMARY KEY,sheet_id text NOT NULL,type text,property jsonb);
      CREATE TABLE plugin_multitable_object_registry(id text PRIMARY KEY,sheet_id text NOT NULL);
      CREATE TABLE integration_stock_prep_pack_installs(tenant_id text,project_id text,object_id text);`)
    await createAutomationReadExecutionLogSchema(admin)
    for (const migration of [addOutbox, addRuleRevision, addMaterialEpochs, addLedger, addAudit, addActivation, addUpdatedActivation, addRecordConditions]) await db.transaction().execute(migration)
  })
  afterAll(async () => {
    if (admin) { await admin.query('ROLLBACK').catch(() => {}); if (created) await admin.query('DROP SCHEMA "' + schema + '" CASCADE'); admin.release() }
    if (db) await db.destroy(); else await pool?.end()
  })
  afterEach(() => { beforeQuery = undefined })
  beforeEach(async () => {
    await resetAutomationReadExecutionLinks(admin, async () => {
      await admin.query(`TRUNCATE integration_automation_read_record_activations,integration_automation_read_executions,
        multitable_automation_executions,integration_automation_read_requests,integration_automation_read_grants,
        meta_automation_outbox_consumer,meta_automation_outbox,automation_rules,
        users,user_roles,role_permissions,user_permissions,user_orgs,user_namespace_admissions,
        meta_bases,meta_sheets,meta_fields,plugin_multitable_object_registry,integration_stock_prep_pack_installs`)
    })
    await admin.query("INSERT INTO users VALUES ($1,'user','[]',true,'activated')", [actor.actorId])
    await admin.query("INSERT INTO user_roles VALUES ($1,'integration_admin')", [actor.actorId])
    await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
    await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', [actor.actorId, actor.tenantId])
    await admin.query("INSERT INTO user_namespace_admissions VALUES ($1,'integration',true)", [actor.actorId])
    await admin.query("INSERT INTO meta_bases VALUES ('synthetic-record-base',NULL)")
    await admin.query("INSERT INTO meta_sheets VALUES ('synthetic-record-sheet','synthetic-record-base',NULL)")
    await admin.query("INSERT INTO meta_fields VALUES ('synthetic-record-field','synthetic-record-sheet','string','{}')")
    await admin.query(`INSERT INTO automation_rules(id,sheet_id,created_by,enabled,trigger_type,trigger_config,conditions,action_type,action_config)
      VALUES ($1,'synthetic-record-sheet',$2,true,'record.created','{}',NULL,'integration_read_preview',$3::jsonb)`,
    [selector.ruleId, actor.actorId, JSON.stringify({ operation: AUTOMATION_READ_OPERATION, allowManual: true })])
    ruleRevision = String((await admin.query('SELECT integration_authority_revision::text AS revision FROM automation_rules WHERE id=$1', [selector.ruleId])).rows[0].revision)
    ledger = makeLedger()
  })

  it.each(['record.created', 'record.updated'] as const)('%s binds the exact current type and rejects the opposite event without spending or enqueueing', async trigger => {
    await setRecordTrigger(trigger)
    const pair = await activate(), eventId = randomUUID()
    const opposite = trigger === 'record.created' ? 'multitable.record.updated' : 'multitable.record.created'
    const wrong = await delivery({ eventId, eventType: opposite })
    expect(await ledger.recordActivationCandidates(wrong, signal())).toEqual([])
    expect(await ledger.submitRecord(pair.activationId, wrong, signal())).toBeNull()
    expect(await counts()).toEqual(activated)
    const right = await delivery({ eventId, eventType: `multitable.${trigger}` })
    expect(await ledger.recordActivationCandidates(right, signal())).toEqual([pair.activationId])
    const request = await ledger.submitRecord(pair.activationId, right, signal())
    expect(request?.status).toBe('queued')
    expect((await admin.query('SELECT invocation_id FROM integration_automation_read_requests WHERE id=$1', [request!.requestId])).rows)
      .toEqual([{ invocation_id: `record-read:${createHash('sha256').update(JSON.stringify([pair.activationId, `multitable.${trigger}`, eventId])).digest('hex')}` }])
    expect(await ledger.submitRecord(pair.activationId, await delivery({ eventId, eventType: `multitable.${trigger}` }), signal())).toEqual(request)
    expect(await counts()).toEqual(queued)
    expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [pair.grantId])).rows[0].used_executions).toBe(0)
    const fence = await claimed(request!.requestId)
    expect(await ledger.checkpoint({ requestId: request!.requestId, fence })).toMatchObject({ actor, selector })
    expect((await ledger.complete({ requestId: request!.requestId, fence, result: preview })).status).toBe('succeeded')
  })

  it('created and updated rules on one sheet route a shared event id into only their separately authorized budgets', async () => {
    const createdPair = await activate(), updatedSelector = { ...selector, ruleId: 'synthetic-updated-rule' }
    const added = await admin.query(`INSERT INTO automation_rules(id,sheet_id,created_by,enabled,trigger_type,trigger_config,conditions,action_type,action_config)
      SELECT $2,sheet_id,created_by,enabled,'record.updated',trigger_config,conditions,action_type,action_config
      FROM automation_rules WHERE id=$1 RETURNING integration_authority_revision::text AS revision`, [selector.ruleId, updatedSelector.ruleId])
    const updatedPair = await activate({ ...activationInput(), selector: updatedSelector, expectedRuleRevision: String(added.rows[0].revision) })
    const eventId = randomUUID()
    const created = await delivery({ eventId }), updated = await delivery({ eventId, eventType: 'multitable.record.updated' })
    expect(await ledger.recordActivationCandidates(created, signal())).toEqual([createdPair.activationId])
    expect(await ledger.recordActivationCandidates(updated, signal())).toEqual([updatedPair.activationId])
    expect(await ledger.submitRecord(createdPair.activationId, updated, signal())).toBeNull()
    expect(await ledger.submitRecord(updatedPair.activationId, created, signal())).toBeNull()
    const first = await ledger.submitRecord(createdPair.activationId, created, signal())
    const second = await ledger.submitRecord(updatedPair.activationId, updated, signal())
    expect(first?.status).toBe('queued'); expect(second?.status).toBe('queued'); expect(second?.requestId).not.toBe(first?.requestId)
    expect(await counts()).toEqual({ grants: 2, activations: 2, requests: 2, links: 2, executions: 2, read_events: 2 })
  })

  it.each([undefined, null, '', 'not-a-uuid', 123, {}])('record activation requires a closed UUID expected revision before IO %#', async expectedRuleRevision => {
    const input = { ...activationInput(), expectedRuleRevision }
    if (expectedRuleRevision === undefined) Reflect.deleteProperty(input, 'expectedRuleRevision')
    let queries = 0; beforeQuery = async () => { queries++ }
    await expect(activate(input as never)).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(queries).toBe(0)
    expect(await counts()).toEqual(empty)
  })

  it('a stale confirmed revision and type ABA never grant, while a fresh explicit consent can', async () => {
    const confirmed = activationInput()
    await setRecordTrigger('record.updated')
    await expect(activate(confirmed)).rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    expect(await counts()).toEqual(empty)
    await setRecordTrigger('record.created')
    expect(ruleRevision).not.toBe(confirmed.expectedRuleRevision)
    await expect(activate(confirmed)).rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    expect(await counts()).toEqual(empty)
    await activate(); expect(await counts()).toEqual(activated)
  })

  it('same-key recovery binds its original confirmed revision after a type edit, without granting or reviving it', async () => {
    const original = activationInput(), pair = await activate(original)
    await setRecordTrigger('record.updated')
    await expect(activate({ ...original, expectedRuleRevision: ruleRevision }))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_IDEMPOTENCY_CONFLICT' })
    expect(await activate(original)).toEqual(pair)
    const updated = await delivery({ eventType: 'multitable.record.updated' })
    expect(await ledger.recordActivationCandidates(updated, signal())).toEqual([])
    await expect(ledger.submitRecord(pair.activationId, updated, signal())).rejects.toBeDefined()
    await setRecordTrigger('record.created')
    expect(await activate(original)).toEqual(pair)
    const created = await delivery()
    expect(await ledger.recordActivationCandidates(created, signal())).toEqual([])
    await expect(ledger.submitRecord(pair.activationId, created, signal())).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it('without migration 137 its actual created-only trigger rejects updated consent, not a missing-140-column accident', async () => {
    await db.transaction().execute(removeRecordConditions)
    await db.transaction().execute(removeUpdatedActivation)
    try {
      await setRecordTrigger('record.updated')
      const standalone = await ledger.grant(actor, { selector, projects: ['SYN-RECORD-PROJECT'], triggers: ['record'],
        budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 1 })
      let reached = false
      await expect(transaction(async trx => {
        const fresh = randomUUID()
        await trx.query(`INSERT INTO integration_automation_read_grants
          (id,tenant_id,owner_id,selector,authority_key,source_reference,projects,triggers,budget,expires_at,max_executions,purpose)
          SELECT $2,tenant_id,owner_id,selector,authority_key,source_reference,projects,triggers,budget,expires_at,max_executions,'automatic'
          FROM integration_automation_read_grants WHERE id=$1`, [standalone.grantId, fresh])
        reached = true
        await trx.query(`INSERT INTO integration_automation_read_record_activations
          (id,activation_key,grant_id,tenant_id,owner_id,rule_id,rule_revision,sheet_id,project_no)
          SELECT $1,$2,$3,$4,created_by,id,integration_authority_revision,sheet_id,$5
          FROM automation_rules WHERE id=$6`, [randomUUID(), randomUUID(), fresh, actor.tenantId, 'SYN-RECORD-PROJECT', selector.ruleId])
      })).rejects.toMatchObject({ code: '23514', message: 'AUTOMATION_READ_RECORD_ACTIVATION_DENIED' })
      expect(reached).toBe(true); expect(await counts()).toEqual({ ...empty, grants: 1 })
    } finally {
      await db.transaction().execute(addUpdatedActivation)
      await db.transaction().execute(addRecordConditions)
    }
    await activate(); expect(await counts()).toEqual({ ...activated, grants: 2 })
  })

  it.each(['record.created', 'record.updated'] as const)('migration 137 down preserves and refuses retained %s consent', async trigger => {
    await setRecordTrigger(trigger)
    const pair = await activate(); await ledger.revoke(actor, pair.grantId)
    await expect(db.transaction().execute(removeUpdatedActivation)).rejects.toMatchObject({ code: '55000' })
    expect(await counts()).toEqual(activated)
  })

  it.each(['conditions', 'trigger_config', 'trigger_type'] as const)('updated activation still refuses unsupported %s before creating a budget', async changed => {
    await setRecordTrigger('record.updated')
    const value = changed === 'conditions' ? '{"all":[]}' : changed === 'trigger_config' ? '{"fieldId":"synthetic-field"}' : 'record.deleted'
    await admin.query('UPDATE automation_rules SET ' + changed + '=$1 WHERE id=$2', [value, selector.ruleId])
    await expect(activate()).rejects.toBeDefined()
    expect(await counts()).toEqual(empty)
  })

  it.each(['conditions', 'trigger_config', 'trigger_type'] as const)('migration 137 independently rejects unsupported %s in the actual activation insert trigger', async changed => {
    await db.transaction().execute(removeRecordConditions)
    try {
    await setRecordTrigger('record.updated')
    const value = changed === 'conditions' ? '{"all":[]}' : changed === 'trigger_config' ? '{"fieldId":"synthetic-field"}' : 'record.deleted'
    await admin.query('UPDATE automation_rules SET ' + changed + '=$1 WHERE id=$2', [value, selector.ruleId])
    const standalone = await ledger.grant(actor, { selector, projects: ['SYN-RECORD-PROJECT'], triggers: ['record'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 1 })
    let reached = false
    await expect(transaction(async trx => {
      const fresh = randomUUID()
      await trx.query(`INSERT INTO integration_automation_read_grants
        (id,tenant_id,owner_id,selector,authority_key,source_reference,projects,triggers,budget,expires_at,max_executions,purpose)
        SELECT $2,tenant_id,owner_id,selector,authority_key,source_reference,projects,triggers,budget,expires_at,max_executions,'automatic'
        FROM integration_automation_read_grants WHERE id=$1`, [standalone.grantId, fresh])
      reached = true
      await trx.query(`INSERT INTO integration_automation_read_record_activations
        (id,activation_key,grant_id,tenant_id,owner_id,rule_id,rule_revision,sheet_id,project_no)
        SELECT $1,$2,$3,$4,created_by,id,integration_authority_revision,sheet_id,$5
        FROM automation_rules WHERE id=$6`, [randomUUID(), randomUUID(), fresh, actor.tenantId, 'SYN-RECORD-PROJECT', selector.ruleId])
    })).rejects.toMatchObject({ code: '23514', message: 'AUTOMATION_READ_RECORD_ACTIVATION_DENIED' })
    expect(reached).toBe(true)
    expect(await counts()).toEqual({ ...empty, grants: 1 })
    } finally { await db.transaction().execute(addRecordConditions) }
  })

  it('new code without 140 rejects its actual confirmation INSERT and rolls the earlier grant back', async () => {
    await db.transaction().execute(removeRecordConditions)
    let grantReached = 0, activationReached = 0
    try {
      beforeQuery = async statement => {
        if (/INSERT\s+INTO\s+integration_automation_read_grants\s*\(/iu.test(statement)) grantReached++
        if (/INSERT\s+INTO\s+integration_automation_read_record_activations\s*\(/iu.test(statement)) {
          activationReached++; expect(statement).toContain('condition_confirmation')
        }
      }
      await expect(activate()).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
      expect(grantReached).toBe(1); expect(activationReached).toBe(1); expect(await counts()).toEqual(empty)
    } finally { beforeQuery = undefined; await db.transaction().execute(addRecordConditions) }
    await activate(); expect(await counts()).toEqual(activated)
  })

  it('140 gives historical NULL-only consent its unconditional default even after the current rule acquired conditions', async () => {
    await db.transaction().execute(removeRecordConditions)
    let pair: { id: string } | undefined
    try {
      pair = await directActivation(undefined, { omitConfirmation: true })
      await admin.query("UPDATE automation_rules SET conditions='{\"conjunction\":\"AND\",\"conditions\":[]}' WHERE id=$1", [selector.ruleId])
    } finally { await db.transaction().execute(addRecordConditions) }
    expect((await admin.query('SELECT condition_confirmation FROM integration_automation_read_record_activations WHERE id=$1', [pair!.id])).rows)
      .toEqual([{ condition_confirmation: { mode: 'unconditional' } }])
    expect(await counts()).toEqual({ ...activated, grants: 2 })
  })

  it('140 repeated up preserves an immutable pair and its exact confirmation', async () => {
    const input = activationInput(), pair = await activate(input)
    await db.transaction().execute(addRecordConditions)
    await db.transaction().execute(addRecordConditions)
    expect(await activate(input)).toEqual(pair)
    expect((await admin.query('SELECT condition_confirmation FROM integration_automation_read_record_activations WHERE id=$1', [pair.activationId])).rows)
      .toEqual([{ condition_confirmation: { mode: 'unconditional' } }])
    expect(await counts()).toEqual(activated)
  })

  it.each([null, {}, { mode: 'unknown' }, { mode: 'unconditional', extra: true },
    { mode: 'saved_conditions' }, { mode: 'saved_conditions', schemaRevision: null, businessTimeZone: 'UTC' },
    { mode: 'saved_conditions', schemaRevision: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', businessTimeZone: 'UTC' },
    { mode: 'saved_conditions', schemaRevision: '11111111-1111-4111-8111-111111111111', businessTimeZone: true },
  ])('140 direct SQL rejects malformed confirmation %# without a half automatic grant', async confirmation => {
    await expect(directActivation(confirmation)).rejects.toMatchObject({ code: '23514', message: 'AUTOMATION_READ_RECORD_ACTIVATION_DENIED' })
    expect(await counts()).toEqual({ ...empty, grants: 1 })
  })

  it.each(['null-with-saved', 'conditions-with-unconditional', 'scalar-conditions', 'oversized-conditions',
    'bad-timezone', 'stale-epoch', 'metadata-ABA', 'deleted-sheet', 'RLS', 'missing-table', 'rule-revision'] as const)('140 direct SQL rejects condition/schema mismatch %s', async kind => {
    if (kind !== 'null-with-saved') {
      const conditions = kind === 'scalar-conditions' ? '[]' : kind === 'oversized-conditions'
        ? JSON.stringify({ text: 'x'.repeat(65537) }) : '{"conjunction":"AND","conditions":[]}'
      await admin.query('UPDATE automation_rules SET conditions=$2::jsonb WHERE id=$1 RETURNING integration_authority_revision', [selector.ruleId, conditions])
      ruleRevision = String((await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [selector.ruleId])).rows[0].integration_authority_revision)
    }
    const confirmation = await savedCondition()
    if (kind === 'bad-timezone') confirmation.businessTimeZone = 'invalid/timezone'
    if (kind === 'stale-epoch') confirmation.schemaRevision = randomUUID()
    if (kind === 'metadata-ABA') {
      await admin.query("UPDATE meta_fields SET type='number' WHERE id='synthetic-record-field'")
      await admin.query("UPDATE meta_fields SET type='string' WHERE id='synthetic-record-field'")
      expect(await sheetRevision()).not.toBe(confirmation.schemaRevision)
    }
    if (kind === 'deleted-sheet') {
      await admin.query("UPDATE meta_sheets SET deleted_at=clock_timestamp() WHERE id='synthetic-record-sheet'")
      confirmation.schemaRevision = await sheetRevision()
    }
    if (kind === 'RLS') await admin.query('ALTER TABLE meta_fields ENABLE ROW LEVEL SECURITY')
    if (kind === 'missing-table') await admin.query('ALTER TABLE automation_read_material_epochs RENAME TO synthetic_hidden_epochs')
    try {
      await expect(directActivation(kind === 'conditions-with-unconditional' ? { mode: 'unconditional' } : confirmation,
        { revision: kind === 'rule-revision' ? randomUUID() : ruleRevision }))
        .rejects.toMatchObject({ code: '23514', message: 'AUTOMATION_READ_RECORD_ACTIVATION_DENIED' })
      expect(await counts()).toEqual({ ...empty, grants: 1 })
    } finally {
      if (kind === 'RLS') await admin.query('ALTER TABLE meta_fields DISABLE ROW LEVEL SECURITY')
      if (kind === 'missing-table') await admin.query('ALTER TABLE synthetic_hidden_epochs RENAME TO automation_read_material_epochs')
    }
  })

  it('140 direct SQL admits the exact saved descriptor and DB-mints cutover, never trusting a caller future timestamp', async () => {
    const changed = await admin.query("UPDATE automation_rules SET conditions='{\"conjunction\":\"AND\",\"conditions\":[]}' WHERE id=$1 RETURNING integration_authority_revision", [selector.ruleId])
    ruleRevision = String(changed.rows[0].integration_authority_revision)
    const confirmation = await savedCondition(), pair = await directActivation(confirmation, { activatedAt: '2099-01-01T00:00:00.000Z' })
    expect(pair.condition_confirmation).toEqual(confirmation)
    expect((await admin.query('SELECT activated_at<=clock_timestamp() AND activated_at>clock_timestamp()-interval \'10 seconds\' AS minted FROM integration_automation_read_record_activations WHERE id=$1', [pair.id])).rows)
      .toEqual([{ minted: true }])
    expect(await counts()).toEqual({ ...activated, grants: 2 })
  })

  it('140 down refuses retained record history before changing confirmation or restoring the old admission', async () => {
    const pair = await activate()
    await expect(db.transaction().execute(removeRecordConditions)).rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_READ_RECORD_CONDITIONS_HAS_HISTORY' })
    expect((await admin.query('SELECT condition_confirmation FROM integration_automation_read_record_activations WHERE id=$1', [pair.activationId])).rows)
      .toEqual([{ condition_confirmation: { mode: 'unconditional' } }])
    expect(await counts()).toEqual(activated)
  })

  it.each(['before-submit', 'before-claim', 'before-checkpoint', 'before-publish'] as const)('updated consent rechecks current owner permission %s', async stage => {
    await setRecordTrigger('record.updated')
    const pair = await activate(), event = await delivery({ eventType: 'multitable.record.updated' })
    const request = stage === 'before-submit' ? null : await ledger.submitRecord(pair.activationId, event, signal())
    const fence = request && ['before-checkpoint', 'before-publish'].includes(stage) ? await claimed(request.requestId) : null
    await admin.query("DELETE FROM role_permissions WHERE permission_code='integration:admin'")
    if (stage === 'before-submit') await expect(ledger.submitRecord(pair.activationId, event, signal())).rejects.toBeDefined()
    else if (stage === 'before-claim') await expect(ledger.claim(request!.requestId)).rejects.toBeDefined()
    else if (stage === 'before-checkpoint') await expect(ledger.checkpoint({ requestId: request!.requestId, fence: fence! })).rejects.toBeDefined()
    else await expect(ledger.complete({ requestId: request!.requestId, fence: fence!, result: preview })).rejects.toBeDefined()
    expect((await admin.query("SELECT count(*)::int n FROM integration_automation_read_requests WHERE status='succeeded'")).rows[0].n).toBe(0)
  })

  it('one explicit consent creates a fresh automatic-only pair atomically; concurrent exact replay does not enqueue', async () => {
    const input = activationInput()
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => activate(input, makeLedger())))
    const values = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : [])
    expect(values.length).toBeGreaterThan(0)
    // Production deliberately uses NOWAIT: losing concurrent transactions may
    // report unavailable, but must never manufacture another pair or retry.
    for (const outcome of outcomes) if (outcome.status === 'rejected') {
      expect(outcome.reason).toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    }
    expect(values.every(value => value.activationId === values[0].activationId && value.grantId === values[0].grantId)).toBe(true)
    expect(await activate(input, makeLedger())).toEqual(values[0])
    expect(await counts()).toEqual(activated)
    expect((await admin.query('SELECT purpose,triggers,projects,used_executions FROM integration_automation_read_grants')).rows)
      .toEqual([{ purpose: 'automatic', triggers: ['record'], projects: [input.projectNo], used_executions: 0 }])
    expect(Object.keys(values[0]).sort()).toEqual(['activationId', 'grantId'])
  })

  it.each(['projectNo', 'maxExecutions', 'expiresAt', 'budget'] as const)('an activation key cannot be reused with changed %s', async changed => {
    const input = activationInput(); await activate(input)
    const other = { ...input, ...(changed === 'projectNo' ? { projectNo: 'SYN-OTHER-PROJECT' }
      : changed === 'maxExecutions' ? { maxExecutions: 2 }
        : changed === 'expiresAt' ? { expiresAt: '2098-01-01T00:00:00.000Z' }
          : { budget: { ...budget, maxRows: 19 } }) }
    await expect(activate(other)).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it('a revoked pair stays revoked on replay and a new consent uses new identities', async () => {
    const input = activationInput(), first = await activate(input)
    await ledger.revoke(actor, first.grantId)
    expect(await activate(input)).toEqual(first)
    expect((await admin.query('SELECT status FROM integration_automation_read_grants WHERE id=$1', [first.grantId])).rows[0].status).toBe('revoked')
    const next = await activate()
    expect(next.grantId).not.toBe(first.grantId); expect(next.activationId).not.toBe(first.activationId)
    expect(await counts()).toEqual({ ...activated, grants: 2, activations: 2 })
  })

  it('existing record-capable standalone grants never become automatic candidates', async () => {
    const { grantId } = await ledger.grant(actor, { selector, projects: ['SYN-RECORD-PROJECT'], triggers: ['record'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 3 })
    const event = await delivery()
    expect(await ledger.recordActivationCandidates(event, signal())).toEqual([])
    expect((await admin.query('SELECT purpose FROM integration_automation_read_grants WHERE id=$1', [grantId])).rows[0].purpose).toBe('standalone')
    expect(await counts()).toEqual({ ...empty, grants: 1 })
  })

  it.each(['other-owner', 'other-tenant', 'revoked-role'] as const)('fresh activation rejects %s under the actual actor/owner checks', async mismatch => {
    await admin.query("INSERT INTO users VALUES ('synthetic-other-owner','user','[]',true,'activated')")
    await admin.query("INSERT INTO user_roles VALUES ('synthetic-other-owner','integration_admin')")
    await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', ['synthetic-other-owner', actor.tenantId])
    await admin.query("INSERT INTO user_namespace_admissions VALUES ('synthetic-other-owner','integration',true)")
    if (mismatch === 'revoked-role') await admin.query("DELETE FROM role_permissions WHERE permission_code='integration:admin'")
    const principal = { ...actor, ...(mismatch === 'other-owner' ? { actorId: 'synthetic-other-owner' }
      : mismatch === 'other-tenant' ? { tenantId: 'synthetic-other-tenant' } : {}) }
    await expect(ledger.activateRecord(principal, activationInput())).rejects.toBeDefined()
    expect(await counts()).toEqual(empty)
  })

  it('finite automatic budget counts queued reservations and execution; a duplicate event consumes neither again', async () => {
    const pair = await activate({ ...activationInput(), maxExecutions: 1 }), event = await delivery()
    const first = await ledger.submitRecord(pair.activationId, event, signal())
    if (!first) throw new Error('SYNTHETIC_RECORD_REQUEST_MISSING')
    const other = await delivery()
    await expect(ledger.submitRecord(pair.activationId, other, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_BUDGET_EXHAUSTED' })
    expect((await ledger.submitRecord(pair.activationId, event, signal()))?.requestId).toBe(first.requestId)
    const fence = await claimed(first.requestId)
    await ledger.complete({ requestId: first.requestId, fence, result: preview })
    await expect(ledger.submitRecord(pair.activationId, other, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_BUDGET_EXHAUSTED' })
    expect((await ledger.submitRecord(pair.activationId, event, signal()))?.requestId).toBe(first.requestId)
    expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants')).rows).toEqual([{ used_executions: 1 }])
    expect(await counts()).toEqual(queued)
  })

  it.each(['manual', 'record', 'schedule'] as const)('ordinary submit cannot consume an automatic grant through %s', async trigger => {
    const { grantId } = await activate()
    await expect(ledger.submit(actor, { grantId, invocationId: randomUUID(), projectNo: 'SYN-RECORD-PROJECT', trigger })).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it.each(['integration_automation_read_grants', 'integration_automation_read_record_activations'])('activation insert failure at %s rolls the entire pair back', async table => {
    let reached = 0
    beforeQuery = async statement => { if (new RegExp('INSERT\\s+INTO\\s+' + table + '\\s*\\(', 'iu').test(statement)) {
      reached++; throw new Error('SYNTHETIC_ACTIVATION_INSERT_FAILURE')
    } }
    await expect(activate()).rejects.toBeDefined()
    expect(reached).toBe(1); expect(await counts()).toEqual(empty)
  })

  it('a real persisted and claimed record event queues one audited private request without source IO', async () => {
    const pair = await activate(), event = await delivery()
    expect(await ledger.recordActivationCandidates(event, signal())).toEqual([pair.activationId])
    const request = await ledger.submitRecord(pair.activationId, event, signal())
    expect(request?.status).toBe('queued')
    expect(await counts()).toEqual(queued)
    expect((await admin.query('SELECT project_no,trigger_type FROM integration_automation_read_requests')).rows)
      .toEqual([{ project_no: 'SYN-RECORD-PROJECT', trigger_type: 'record' }])
    const publicRow = (await admin.query('SELECT integration_read,trigger_event,rule_snapshot,steps FROM multitable_automation_executions')).rows[0]
    expect(publicRow).toEqual({ integration_read: { requestId: request?.requestId, status: 'queued' }, trigger_event: null, rule_snapshot: null, steps: [] })
  })

  it('same logical event across duplicate outboxes and reconstructed ledgers has one request and one audit', async () => {
    const pair = await activate(), eventId = randomUUID()
    const first = await delivery({ eventId }), second = await delivery({ eventId })
    expect(first.outboxId).not.toBe(second.outboxId)
    const outcomes = await Promise.allSettled([first, second, first, second].map(event => makeLedger().submitRecord(pair.activationId, event, signal())))
    const results = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : [])
    expect(results.length).toBeGreaterThan(0)
    for (const outcome of outcomes) if (outcome.status === 'rejected') {
      expect(outcome.reason).toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    }
    expect(results[0]?.requestId).toBeTruthy()
    expect(results.every(result => result?.requestId === results[0]?.requestId)).toBe(true)
    expect((await makeLedger().submitRecord(pair.activationId, second, signal()))?.requestId).toBe(results[0]?.requestId)
    expect(await counts()).toEqual(queued)
  })

  it('cutover uses DB outbox time: an event persisted before consent cannot be consumed retrospectively', async () => {
    const old = await delivery(), pair = await activate(), fresh = await delivery()
    expect((await admin.query(`SELECT o.created_at<a.activated_at AS predates FROM meta_automation_outbox o
      CROSS JOIN integration_automation_read_record_activations a WHERE o.id=$1 AND a.id=$2`, [old.outboxId, pair.activationId])).rows[0].predates).toBe(true)
    expect(await ledger.recordActivationCandidates(old, signal())).toEqual([])
    expect(await ledger.submitRecord(pair.activationId, old, signal())).toBeNull()
    expect((await ledger.submitRecord(pair.activationId, fresh, signal()))?.status).toBe('queued')
  })

  it('the exact DB timestamp cutover boundary is excluded, not rounded through JavaScript dates', async () => {
    const pair = await activate(), event = await delivery()
    await admin.query(`UPDATE meta_automation_outbox SET created_at=(SELECT activated_at
      FROM integration_automation_read_record_activations WHERE id=$2) WHERE id=$1`, [event.outboxId, pair.activationId])
    expect(await ledger.recordActivationCandidates(event, signal())).toEqual([])
    expect(await ledger.submitRecord(pair.activationId, event, signal())).toBeNull()
    expect(await counts()).toEqual(activated)
  })

  it('a retained pre-consent event cannot become eligible by enqueueing the same identity again after consent', async () => {
    const eventId = randomUUID(), old = await delivery({ eventId })
    const pair = await activate(), copy = await delivery({ eventId })
    expect(copy.outboxId).not.toBe(old.outboxId)
    expect((await admin.query(`SELECT count(*)::int n FROM meta_automation_outbox WHERE event_type=$1 AND event_id=$2`,
      [recordEvent, eventId])).rows[0].n).toBe(2)
    // Actual enqueue remains legal: cutover is an admission rule, not a new
    // global uniqueness constraint on all existing outbox producers.
    expect(await ledger.recordActivationCandidates(copy, signal())).toEqual([])
    expect(await ledger.submitRecord(pair.activationId, copy, signal())).toBeNull()
    expect(await counts()).toEqual(activated)
    expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants')).rows)
      .toEqual([{ used_executions: 0 }])
    const fresh = await delivery()
    expect(await ledger.recordActivationCandidates(fresh, signal())).toEqual([pair.activationId])
    expect((await ledger.submitRecord(pair.activationId, fresh, signal()))?.status).toBe('queued')
  })

  it('retained history of another event type does not exclude a newly eligible created event with the same id', async () => {
    const eventId = randomUUID()
    await delivery({ eventId, eventType: 'multitable.record.updated' })
    const pair = await activate(), created = await delivery({ eventId })
    expect(await ledger.recordActivationCandidates(created, signal())).toEqual([pair.activationId])
    expect((await ledger.submitRecord(pair.activationId, created, signal()))?.status).toBe('queued')
    expect(await counts()).toEqual(queued)
  })

  it.each([
    ['wrong sheet', { sheetId: 'synthetic-foreign-sheet', recordId: 'synthetic-record' }, 0],
    ['missing record', { sheetId: 'synthetic-record-sheet' }, 0],
    ['missing sheet', { recordId: 'synthetic-record' }, 0],
    ['blank record', { sheetId: 'synthetic-record-sheet', recordId: ' ' }, 0],
    ['depth exhausted', { sheetId: 'synthetic-record-sheet', recordId: 'synthetic-record' }, 3],
  ])('inapplicable durable event %s never produces a request', async (_reason, payload, depth) => {
    const pair = await activate(), event = await delivery({ payload, depth: Number(depth) })
    expect(await ledger.recordActivationCandidates(event, signal())).toEqual([])
    expect(await ledger.submitRecord(pair.activationId, event, signal())).toBeNull()
    expect(await counts()).toEqual(activated)
  })

  it.each(['fence', 'attempts', 'eventId', 'outboxId', 'lease', 'status'] as const)('invalid durable proof %s cannot enqueue', async changed => {
    const pair = await activate(), event = await delivery()
    if (changed === 'lease') await admin.query("UPDATE meta_automation_outbox_consumer SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE outbox_id=$1", [event.outboxId])
    else if (changed === 'status') await admin.query("UPDATE meta_automation_outbox_consumer SET status='done',lease_expires_at=NULL WHERE outbox_id=$1", [event.outboxId])
    const supplied = { ...event, ...(changed === 'fence' ? { fence: String(BigInt(event.fence) + 1n) }
      : changed === 'attempts' ? { attempts: event.attempts + 1 } : changed === 'eventId' ? { eventId: randomUUID() }
        : changed === 'outboxId' ? { outboxId: 'obx_' + randomUUID() } : {}) }
    await expect(ledger.submitRecord(pair.activationId, supplied, signal())).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it('an already aborted delivery has no request/audit/outbox effects', async () => {
    const pair = await activate(), event = await delivery(), controller = new AbortController()
    controller.abort()
    await expect(ledger.submitRecord(pair.activationId, event, controller.signal)).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it('abort after the actual request INSERT rolls back the request instead of publishing an orphan audit', async () => {
    const pair = await activate(), event = await delivery(), controller = new AbortController(); let reached = 0
    beforeQuery = async statement => {
      if (/INSERT\s+INTO\s+integration_automation_read_requests\s*\(/iu.test(statement)) { reached++; controller.abort() }
    }
    await expect(ledger.submitRecord(pair.activationId, event, controller.signal)).rejects.toBeDefined()
    expect(reached).toBe(1); expect(await counts()).toEqual(activated)
  })

  it.each(['multitable_automation_executions', 'integration_automation_read_executions', 'meta_automation_outbox',
    'meta_automation_outbox_consumer'])('automatic admission rolls back request and all audit writes if %s fails', async table => {
    const pair = await activate(), event = await delivery(); let reached = 0
    beforeQuery = async statement => { if (new RegExp('INSERT\\s+INTO\\s+' + table + '\\s*\\(', 'iu').test(statement)) {
      reached++; throw new Error('SYNTHETIC_RECORD_INSERT_FAILURE')
    } }
    await expect(ledger.submitRecord(pair.activationId, event, signal())).rejects.toBeDefined()
    expect(reached).toBe(1); expect(await counts()).toEqual(activated)
    beforeQuery = undefined
    expect((await ledger.submitRecord(pair.activationId, event, signal()))?.status).toBe('queued')
    expect(await counts()).toEqual(queued)
  })

  it.each(['activation', 'submit'] as const)('a lost %s COMMIT receipt recovers the original identity without double work', async operation => {
    const uncertain = createAutomationReadLedger({ authority, manifest, async transaction(work) {
      await transaction(work); throw new Error('SYNTHETIC_COMMIT_RECEIPT_LOST')
    } })
    const input = activationInput()
    if (operation === 'activation') {
      await expect(activate(input, uncertain)).rejects.toBeDefined()
      const original = (await admin.query('SELECT id,grant_id FROM integration_automation_read_record_activations')).rows[0]
      expect(await activate(input, makeLedger())).toEqual({ activationId: original.id, grantId: original.grant_id })
      expect(await counts()).toEqual(activated)
    } else {
      const pair = await activate(input), event = await delivery()
      await expect(uncertain.submitRecord(pair.activationId, event, signal())).rejects.toBeDefined()
      const original = (await admin.query('SELECT id FROM integration_automation_read_requests')).rows[0]
      expect((await makeLedger().submitRecord(pair.activationId, event, signal()))?.requestId).toBe(original.id)
      expect(await counts()).toEqual(queued)
    }
  })

  it.each(['conditions', 'trigger_config', 'trigger_type', 'execution_mode'] as const)('activation rejects unsupported rule %s before granting', async changed => {
    const value = changed === 'conditions' ? '{"all":[]}' : changed === 'trigger_config' ? '{"fieldId":"synthetic-field"}'
      : changed === 'trigger_type' ? 'record.deleted' : 'job'
    await admin.query('UPDATE automation_rules SET ' + changed + '=$1 WHERE id=$2', [value, selector.ruleId])
    await expect(activate()).rejects.toBeDefined()
    expect(await counts()).toEqual(empty)
  })

  it.each(['before-submit', 'before-claim', 'before-checkpoint', 'before-publish'] as const)('owner revocation is rechecked %s', async stage => {
    const pair = await activate(), event = await delivery()
    const request = stage === 'before-submit' ? null : await ledger.submitRecord(pair.activationId, event, signal())
    const fence = request && ['before-checkpoint', 'before-publish'].includes(stage) ? await claimed(request.requestId) : null
    await admin.query("DELETE FROM role_permissions WHERE permission_code='integration:admin'")
    if (stage === 'before-submit') await expect(ledger.submitRecord(pair.activationId, event, signal())).rejects.toBeDefined()
    else if (stage === 'before-claim') await expect(ledger.claim(request!.requestId)).rejects.toBeDefined()
    else if (stage === 'before-checkpoint') await expect(ledger.checkpoint({ requestId: request!.requestId, fence: fence! })).rejects.toBeDefined()
    else await expect(ledger.complete({ requestId: request!.requestId, fence: fence!, result: preview })).rejects.toBeDefined()
    expect((await admin.query("SELECT count(*)::int n FROM integration_automation_read_requests WHERE status='succeeded'")).rows[0].n).toBe(0)
  })

  it.each(['queued', 'running'] as const)('revoking the automatic grant prevents later %s work/publication', async state => {
    const request = await submitted(), fence = state === 'running' ? await claimed(request.requestId) : null
    await ledger.revoke(actor, request.grantId)
    if (fence) {
      await expect(ledger.checkpoint({ requestId: request.requestId, fence })).rejects.toBeDefined()
      await expect(ledger.complete({ requestId: request.requestId, fence, result: preview })).rejects.toBeDefined()
    } else expect((await ledger.claim(request.requestId)).status).toBe('blocked')
    expect((await admin.query('SELECT status FROM integration_automation_read_requests WHERE id=$1', [request.requestId])).rows[0].status)
      .toBe(state === 'running' ? 'outcome_unknown' : 'blocked')
    expect(await ledger.recordActivationCandidates(await delivery(), signal())).toEqual([])
  })

  it('rule A→B→A edits do not revive an activation, even when the final semantic config is identical', async () => {
    const pair = await activate(), original = (await admin.query('SELECT integration_authority_revision FROM automation_rules')).rows[0]
    await admin.query("UPDATE automation_rules SET name='Changed rule' WHERE id=$1", [selector.ruleId])
    await admin.query("UPDATE automation_rules SET name='Synthetic record rule' WHERE id=$1", [selector.ruleId])
    expect((await admin.query('SELECT integration_authority_revision FROM automation_rules')).rows[0]).not.toEqual(original)
    await expect(ledger.submitRecord(pair.activationId, await delivery(), signal())).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it.each(['claim', 'checkpoint', 'publish'] as const)('a rule changed after admission cannot proceed at %s', async stage => {
    const request = await submitted(), fence = stage === 'claim' ? null : await claimed(request.requestId)
    await admin.query("UPDATE automation_rules SET name='Changed after admission' WHERE id=$1", [selector.ruleId])
    if (stage === 'claim') await expect(ledger.claim(request.requestId)).rejects.toBeDefined()
    else if (stage === 'checkpoint') await expect(ledger.checkpoint({ requestId: request.requestId, fence: fence! })).rejects.toBeDefined()
    else await expect(ledger.complete({ requestId: request.requestId, fence: fence!, result: preview })).rejects.toBeDefined()
    expect((await admin.query("SELECT count(*)::int n FROM integration_automation_read_requests WHERE status='succeeded'")).rows[0].n).toBe(0)
  })

  it.each(['claim', 'checkpoint', 'publish'] as const)('isolates the independent activation revision guard at %s from the general authority key guard', async stage => {
    const request = await submitted()
    const persisted = (await admin.query(`SELECT authority_key FROM integration_automation_read_grants WHERE id=$1`, [request.grantId])).rows[0]
    // Deliberate test-only isolation: freeze ONLY the synthetic authority key.
    // This is not production authority evidence. Actual actor checks, real rule
    // rows, the DB nonce trigger, activation comparison and all transaction/
    // request/audit guards remain active. Otherwise the earlier key comparison
    // kills the negative path and masks removal of the independent activation
    // rule-revision check we are specifically trying to prove here.
    const isolated = createAutomationReadLedger({ transaction, manifest, authority: { ...authority,
      async lockRecordExecution(trx, principal, selected) {
        return { ...await authority.lockRecordExecution!(trx, principal, selected), key: String(persisted.authority_key) }
      },
    } })
    const positive = await isolated.submitRecord(request.activationId, await delivery(), signal())
    if (!positive) throw new Error('SYNTHETIC_REVISION_POSITIVE_REQUEST_MISSING')
    const positiveClaim = await isolated.claim(positive.requestId)
    if (!('fence' in positiveClaim) || typeof positiveClaim.fence !== 'string') throw new Error('SYNTHETIC_REVISION_POSITIVE_CLAIM_MISSING')
    expect(positiveClaim.status).toBe('running')
    expect(await isolated.checkpoint({ requestId: positive.requestId, fence: positiveClaim.fence }))
      .toMatchObject({ actor, selector, projectNo: 'SYN-RECORD-PROJECT' })
    expect((await isolated.complete({ requestId: positive.requestId, fence: positiveClaim.fence, result: preview })).status)
      .toBe('succeeded')
    const targetClaim = stage === 'claim' ? null : await isolated.claim(request.requestId)
    const fence = targetClaim && 'fence' in targetClaim && typeof targetClaim.fence === 'string' ? targetClaim.fence : null
    if (stage !== 'claim') {
      expect(fence).toEqual(expect.any(String))
      await isolated.checkpoint({ requestId: request.requestId, fence: fence! })
    }
    const before = (await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [selector.ruleId])).rows[0]
    await admin.query("UPDATE automation_rules SET name='Changed with synthetic key frozen' WHERE id=$1", [selector.ruleId])
    expect((await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [selector.ruleId])).rows[0])
      .not.toEqual(before)
    if (stage === 'claim') await expect(isolated.claim(request.requestId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    else if (stage === 'checkpoint') await expect(isolated.checkpoint({ requestId: request.requestId, fence: fence! }))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    else await expect(isolated.complete({ requestId: request.requestId, fence: fence!, result: preview }))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    expect((await admin.query('SELECT status FROM integration_automation_read_requests WHERE id=$1', [request.requestId])).rows[0].status)
      .toBe(stage === 'claim' ? 'queued' : 'running')
  })

  it.each(['grant_id', 'owner_id', 'tenant_id', 'rule_revision', 'project_no', 'activated_at', 'condition_confirmation'] as const)('activation identity %s is immutable', async field => {
    const pair = await activate()
    const value = ['grant_id', 'rule_revision'].includes(field) ? randomUUID() : field === 'activated_at'
      ? '2020-01-01T00:00:00.000Z' : field === 'condition_confirmation' ? JSON.stringify(await savedCondition()) : 'synthetic-different-value'
    const changed = admin.query('UPDATE integration_automation_read_record_activations SET ' + field + '=$1 WHERE id=$2', [value, pair.activationId])
    if (field === 'condition_confirmation') await expect(changed).rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_READ_RECORD_ACTIVATION_IMMUTABLE' })
    else await expect(changed).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it.each(['DELETE FROM integration_automation_read_record_activations', 'TRUNCATE integration_automation_read_record_activations'])('activation history refuses %s', async statement => {
    await activate(); await expect(admin.query(statement)).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it('purpose cannot be upgraded in place and rollback refuses retained automatic consent', async () => {
    const standalone = await ledger.grant(actor, { selector, projects: ['SYN-RECORD-PROJECT'], triggers: ['record'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 3 })
    await expect(admin.query("UPDATE integration_automation_read_grants SET purpose='automatic' WHERE id=$1", [standalone.grantId])).rejects.toBeDefined()
    await activate()
    await expect(db.transaction().execute(removeActivation)).rejects.toBeDefined()
  })

  it('a standalone automatic-purpose grant cannot commit without a matching fresh activation', async () => {
    const original = await ledger.grant(actor, { selector, projects: ['SYN-RECORD-PROJECT'], triggers: ['record'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 3 })
    let inserted = false
    await expect(transaction(async trx => {
      await trx.query(`INSERT INTO integration_automation_read_grants
        (id,tenant_id,owner_id,selector,authority_key,source_reference,projects,triggers,budget,expires_at,max_executions,purpose)
        SELECT $2,tenant_id,owner_id,selector,authority_key,source_reference,projects,triggers,budget,expires_at,max_executions,'automatic'
        FROM integration_automation_read_grants WHERE id=$1`, [original.grantId, randomUUID()])
      inserted = true
    })).rejects.toBeDefined()
    expect(inserted).toBe(true)
    expect(await counts()).toEqual({ ...empty, grants: 1 })
  })

  it('upgrading an actual pre-purpose grant does not fabricate an activation or automatic permission', async () => {
    const original = await ledger.grant(actor, { selector, projects: ['SYN-RECORD-PROJECT'], triggers: ['record'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 3 })
    await db.transaction().execute(removeRecordConditions)
    await db.transaction().execute(removeUpdatedActivation)
    await db.transaction().execute(removeActivation)
    expect((await admin.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=$1
      AND table_name='integration_automation_read_grants' AND column_name='purpose'`, [schema])).rows).toEqual([])
    await db.transaction().execute(addActivation)
    await db.transaction().execute(addUpdatedActivation)
    await db.transaction().execute(addRecordConditions)
    expect((await admin.query('SELECT purpose FROM integration_automation_read_grants WHERE id=$1', [original.grantId])).rows)
      .toEqual([{ purpose: 'standalone' }])
    expect(await ledger.recordActivationCandidates(await delivery(), signal())).toEqual([])
    expect(await counts()).toEqual({ ...empty, grants: 1 })
  })
})
