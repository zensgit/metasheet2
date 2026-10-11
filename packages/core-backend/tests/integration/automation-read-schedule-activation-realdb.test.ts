/** SA-06X: actual PG activation/ledger/audit/outbox transactions and guards.
 * Source authority below is deliberately synthetic, not proof of production
 * connection/target authorization or source IO. Actor RBAC, rule rows/revision,
 * migrations, transaction boundaries and audit/outbox writes are real.
 * JS fake timers are NOT used: production admission reads the PostgreSQL clock.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { up as addOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { up as addRuleRevision } from '../../src/db/migrations/zzzz20261001122000_automation_rule_authority_revision'
import { up as addLedger } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { up as addAudit } from '../../src/db/migrations/zzzz20261001134000_automation_read_execution_audit'
import { up as addRecordActivation } from '../../src/db/migrations/zzzz20261001135000_automation_read_record_activation'
import { up as addScheduleActivation, down as removeScheduleActivation } from '../../src/db/migrations/zzzz20261001136000_automation_read_schedule_activation'
import { up as addUpdatedRecordActivation } from '../../src/db/migrations/zzzz20261001137000_automation_read_record_updated_activation'
import { up as addRecordConditions } from '../../src/db/migrations/zzzz20261001140000_automation_read_record_conditions'
import { up as addIntervalSchedule, down as removeIntervalSchedule } from '../../src/db/migrations/zzzz20261001141000_automation_read_interval_schedule_activation'
import { up as addDateSchedule, down as removeDateSchedule } from '../../src/db/migrations/zzzz20261002143000_automation_read_date_schedule_activation'
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
expectDb('EXPECT_DB supplies a database for atomic schedule activation', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
const actor = { actorId: 'synthetic-schedule-owner', tenantId: 'synthetic-schedule-tenant', workspaceId: null }
const selector = { ruleId: 'synthetic-schedule-rule', actionId: 'synthetic-schedule-action', systemId: 'synthetic-schedule-system', targetId: 'synthetic-schedule-target' }
const sourceReference = { connectionId: 'synthetic-schedule-source', connectionIncarnation: randomUUID() }
const budget = { maxRows: 20, maxPages: 2, maxReadCount: 30, timeoutMs: 60000 }
const preview: ReadPreview = { status: 'ready', counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false }
const recordEvent = 'multitable.record.created', recordConsumer = 'automation-record-trigger'
const manifest = { version: 1903, routes: { [AUTOMATION_READ_EVENT]: [AUTOMATION_READ_CONSUMER], [recordEvent]: [recordConsumer] } }
const signal = () => new AbortController().signal
const MINUTE = 60000

describeDb('Schedule activation: explicit consent, planned occurrence identity and real DB time', () => {
  const schema = 'automation_read_schedule_' + randomBytes(8).toString('hex')
  const table = '"' + schema + '".integration_automation_read_schedule_activations'
  const dateTable = '"' + schema + '".integration_automation_read_date_occurrences'
  let pool: Pool, admin: PoolClient, db: Kysely<unknown>, created = false
  let ledger: ReturnType<typeof createAutomationReadLedger>
  let beforeQuery: ((statement: string, params?: unknown[]) => Promise<void>) | undefined
  let syntheticSourceRevision = 'source-revision-one'
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
      if (!rule || rule.created_by !== principal.actorId || rule.enabled !== true) throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
      return { ...principal, key: createHash('sha256').update(JSON.stringify([rule.integration_authority_revision, syntheticSourceRevision])).digest('hex'),
        budget, sourceReference, allowedTriggers: ['manual', 'schedule', 'record'] }
    },
    async lockObservation(_trx, principal, reference) { return { ...principal, sourceReference: reference } },
    // Synthetic source capability only; these callbacks preserve the old
    // unconditional cross-family cases, not proof of condition preparation/ACL.
    async lockRecordExecution(trx, principal, selected) { return authority.lockExecution(trx, principal, selected) },
    recordConditionFor() { return { mode: 'unconditional' } },
    async evaluateRecordConditions() { return { kind: 'match' } },
  }
  const makeLedger = () => createAutomationReadLedger({ transaction, authority, manifest })
  const ruleRevision = async () => String((await admin.query(
    'SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [selector.ruleId])).rows[0].integration_authority_revision)
  const activationInput = async (activationKey = randomUUID()) => ({ activationKey, expectedRuleRevision: await ruleRevision(), selector, projectNo: 'SYN-SCHEDULE-PROJECT',
    budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 3 })
  const activate = async (input?: Awaited<ReturnType<typeof activationInput>>, port = ledger) => port.activateSchedule(actor, input ?? await activationInput(), signal())
  async function clockMs() {
    const value = Number((await admin.query('SELECT extract(epoch FROM pg_catalog.clock_timestamp()) * 1000 AS ms')).rows[0].ms)
    if (!Number.isFinite(value)) throw new Error('SYNTHETIC_SCHEDULE_DB_CLOCK_MISSING')
    return value
  }
  async function requireOwnedSchema() {
    const actual = (await admin.query('SELECT current_schema() AS owned_schema')).rows[0].owned_schema
    if (!/^automation_read_schedule_[a-f0-9]{16}$/u.test(schema) || actual !== schema) throw new Error('UNOWNED_SCHEDULE_SCHEMA')
  }
  /** Historical migration tests must first remove the dependent date layer,
   * then reinstall it after restoring the old layer. Never weaken its guards
   * to make a 136000/141000 down pass with dependent receipt objects present. */
  async function withoutDateSchedule(work: () => Promise<void>): Promise<void> {
    await requireOwnedSchema()
    await db.transaction().execute(removeDateSchedule)
    try { await work() } finally { await db.transaction().execute(addDateSchedule) }
  }
  /** BEFORE-ARRANGE ONLY, never a time/authority proof. Avoid a minute-long real
   * wait by moving only this owned fixture's activation floor. All admission,
   * rule, actor, grant, deferred, request, audit and outbox guards stay enabled.
   * A separate test below uses the untouched real DB-minted activation time.
   */
  async function arrangeElapsedActivation(activationId: string | readonly string[], plannedMs?: number, equalFloor = false) {
    await requireOwnedSchema()
    const ids = typeof activationId === 'string' ? [activationId] : [...activationId]
    const scheduledAtMs = plannedMs ?? Math.floor(await clockMs() / MINUTE) * MINUTE - 2 * MINUTE
    await admin.query('ALTER TABLE ' + table + ' DISABLE TRIGGER automation_read_schedule_activation_immutable')
    try {
      const updated = await admin.query('UPDATE ' + table + ' SET activated_at=$1::timestamptz WHERE id=ANY($2::uuid[])',
        [new Date(equalFloor ? scheduledAtMs : scheduledAtMs - MINUTE).toISOString(), ids])
      expect(updated.rowCount).toBe(ids.length)
    } finally { await admin.query('ALTER TABLE ' + table + ' ENABLE TRIGGER automation_read_schedule_activation_immutable') }
    expect((await admin.query(`SELECT tgenabled FROM pg_catalog.pg_trigger
      WHERE tgrelid=$1::regclass AND tgname='automation_read_schedule_activation_immutable'`, [table])).rows)
      .toEqual([{ tgenabled: 'O' }])
    return { ruleId: selector.ruleId, scheduledAtMs }
  }
  async function recordDelivery() {
    const queued = await transaction(trx => enqueueOutboxEvent(trx, { eventType: recordEvent, eventId: randomUUID(),
      payload: { sheetId: 'synthetic-schedule-sheet', recordId: 'synthetic-record' }, automationDepth: 0 }, manifest))
    const claimed = await claimDueConsumers(admin, { consumerKeys: [recordConsumer], batchSize: 100, leaseMs: 60000 })
    const found = claimed.find(row => row.outboxId === queued.outboxId)
    if (!found) throw new Error('SYNTHETIC_SCHEDULE_RECORD_DELIVERY_MISSING')
    return { outboxId: found.outboxId, eventId: found.eventId, fence: found.fence, attempts: found.attempts }
  }
  async function submitted() {
    const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId)
    const request = await ledger.submitSchedule(pair.activationId, occurrence, signal())
    if (!request) throw new Error('SYNTHETIC_SCHEDULE_REQUEST_MISSING')
    return { ...pair, occurrence, ...request }
  }
  async function claim(requestId: string, port = ledger): Promise<string> {
    const result = await port.claim(requestId)
    expect(result.status).toBe('running')
    if (!('fence' in result) || typeof result.fence !== 'string') throw new Error('SYNTHETIC_SCHEDULE_CLAIM_MISSING')
    return result.fence
  }
  async function counts() {
    return (await admin.query(`SELECT
      (SELECT count(*)::int FROM integration_automation_read_grants) grants,
      (SELECT count(*)::int FROM integration_automation_read_schedule_activations) activations,
      (SELECT count(*)::int FROM integration_automation_read_requests) requests,
      (SELECT count(*)::int FROM integration_automation_read_executions) links,
      (SELECT count(*)::int FROM multitable_automation_executions) executions,
      (SELECT count(*)::int FROM meta_automation_outbox WHERE event_type=$1) read_events,
      (SELECT count(*)::int FROM meta_automation_outbox_consumer) deliveries`, [AUTOMATION_READ_EVENT])).rows[0]
  }
  const empty = { grants: 0, activations: 0, requests: 0, links: 0, executions: 0, read_events: 0, deliveries: 0 }
  const activated = { ...empty, grants: 1, activations: 1 }
  const queued = { grants: 1, activations: 1, requests: 1, links: 1, executions: 1, read_events: 1, deliveries: 1 }

  beforeAll(async () => {
    if (!/^automation_read_schedule_[a-f0-9]{16}$/u.test(schema)) throw new Error('UNOWNED_SCHEDULE_SCHEMA')
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
      -- Empty metadata prerequisites for the date migration only. These old
      -- cron/interval fixtures make no claim of date schema or source authority.
      CREATE TABLE meta_sheets(id text PRIMARY KEY,base_id text,deleted_at timestamptz);
      CREATE TABLE meta_fields(id text PRIMARY KEY,sheet_id text,type text);
      CREATE TABLE plugin_multitable_object_registry(sheet_id text);
      CREATE TABLE automation_read_material_epochs(kind text,scope jsonb,revision uuid);
      CREATE TABLE automation_rules(id text PRIMARY KEY,sheet_id text NOT NULL,created_by text,enabled boolean NOT NULL,
        trigger_type text NOT NULL,trigger_config jsonb,conditions jsonb,action_type text NOT NULL,action_config jsonb NOT NULL,actions jsonb,
        execution_mode text NOT NULL DEFAULT 'legacy',name text NOT NULL DEFAULT 'Synthetic schedule rule',
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());`)
    await createAutomationReadExecutionLogSchema(admin)
    for (const migration of [addOutbox, addRuleRevision, addLedger, addAudit, addRecordActivation, addScheduleActivation,
      addUpdatedRecordActivation, addRecordConditions, addIntervalSchedule, addDateSchedule]) await db.transaction().execute(migration)
  })
  afterAll(async () => {
    if (admin) { await admin.query('ROLLBACK').catch(() => {}); if (created) await admin.query('DROP SCHEMA "' + schema + '" CASCADE'); admin.release() }
    if (db) await db.destroy(); else await pool?.end()
  })
  afterEach(() => { beforeQuery = undefined })
  beforeEach(async () => {
    beforeQuery = undefined; syntheticSourceRevision = 'source-revision-one'
    await requireOwnedSchema()
    await admin.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER')
    try {
      await admin.query('ALTER TABLE ' + dateTable + ' DISABLE TRIGGER automation_read_date_occurrence_immutable')
      try {
        await admin.query('ALTER TABLE ' + dateTable + ' DISABLE TRIGGER automation_read_date_occurrence_no_truncate')
        try {
          await resetAutomationReadExecutionLinks(admin, async () => {
            await admin.query(`TRUNCATE integration_automation_read_date_occurrences,
              integration_automation_read_schedule_activations,integration_automation_read_record_activations,
              integration_automation_read_executions,multitable_automation_executions,integration_automation_read_requests,
              integration_automation_read_grants,meta_automation_outbox_consumer,meta_automation_outbox,automation_rules,
              users,user_roles,role_permissions,user_permissions,user_orgs,user_namespace_admissions`)
          })
        } finally { await admin.query('ALTER TABLE ' + dateTable + ' ENABLE TRIGGER automation_read_date_occurrence_no_truncate') }
      } finally { await admin.query('ALTER TABLE ' + dateTable + ' ENABLE TRIGGER automation_read_date_occurrence_immutable') }
    } finally { await admin.query('ALTER TABLE ' + table + ' ENABLE TRIGGER USER') }
    expect((await admin.query(`SELECT tgname,tgenabled FROM pg_catalog.pg_trigger WHERE tgrelid=$1::regclass
      AND tgname IN ('automation_read_date_occurrence_immutable','automation_read_date_occurrence_no_truncate') ORDER BY tgname`, [dateTable])).rows)
      .toEqual([{ tgname: 'automation_read_date_occurrence_immutable', tgenabled: 'O' },
        { tgname: 'automation_read_date_occurrence_no_truncate', tgenabled: 'O' }])
    await admin.query("INSERT INTO users VALUES ($1,'user','[]',true,'activated')", [actor.actorId])
    await admin.query("INSERT INTO user_roles VALUES ($1,'integration_admin')", [actor.actorId])
    await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
    await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', [actor.actorId, actor.tenantId])
    await admin.query("INSERT INTO user_namespace_admissions VALUES ($1,'integration',true)", [actor.actorId])
    await admin.query(`INSERT INTO automation_rules(id,sheet_id,created_by,enabled,trigger_type,trigger_config,conditions,action_type,action_config)
      VALUES ($1,'synthetic-schedule-sheet',$2,true,'schedule.cron','{"expression":"* * * * *"}',NULL,'integration_read_preview',$3::jsonb)`,
    [selector.ruleId, actor.actorId, JSON.stringify({ operation: AUTOMATION_READ_OPERATION, allowManual: true })])
    ledger = makeLedger()
  })

  it('explicit consent atomically creates an automatic schedule-only pair; concurrent and reconstructed exact replay add no budget', async () => {
    const input = await activationInput()
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => activate(input, makeLedger())))
    const values = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    expect(values.length).toBeGreaterThan(0)
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(values.every(value => value.activationId === values[0].activationId && value.grantId === values[0].grantId)).toBe(true)
    expect(await activate(input, makeLedger())).toEqual(values[0])
    expect(Object.keys(values[0]).sort()).toEqual(['activationId', 'grantId'])
    expect(await counts()).toEqual(activated)
    expect((await admin.query('SELECT purpose,triggers,projects,used_executions FROM integration_automation_read_grants')).rows)
      .toEqual([{ purpose: 'automatic', triggers: ['schedule'], projects: [input.projectNo], used_executions: 0 }])
  })

  it('untouched activation time is DB minted between real clock reads; previous and future minutes are excluded', async () => {
    const before = await clockMs(), pair = await activate(), after = await clockMs()
    const at = Number((await admin.query('SELECT extract(epoch FROM activated_at)*1000 AS ms FROM ' + table + ' WHERE id=$1', [pair.activationId])).rows[0].ms)
    expect(at).toBeGreaterThanOrEqual(before); expect(at).toBeLessThanOrEqual(after)
    for (const scheduledAtMs of [Math.floor(before / MINUTE) * MINUTE - MINUTE, Math.ceil(after / MINUTE) * MINUTE + MINUTE]) {
      const occurrence = { ruleId: selector.ruleId, scheduledAtMs }
      expect(await ledger.scheduleActivationCandidates(occurrence, signal())).toEqual([])
      expect(await ledger.submitSchedule(pair.activationId, occurrence, signal())).toBeNull()
    }
    expect(await counts()).toEqual(activated)
  })

  it('the strict equal-floor predicate rejects an explicitly arranged exact minute without rounding', async () => {
    const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId, undefined, true)
    expect(await ledger.scheduleActivationCandidates(occurrence, signal())).toEqual([])
    expect(await ledger.submitSchedule(pair.activationId, occurrence, signal())).toBeNull()
    expect(await counts()).toEqual(activated)
    // Positive control differs only in the next planned minute, still before PG-now.
    const next = { ...occurrence, scheduledAtMs: occurrence.scheduledAtMs + MINUTE }
    expect(await ledger.scheduleActivationCandidates(next, signal())).toEqual([pair.activationId])
    expect((await ledger.submitSchedule(pair.activationId, next, signal()))?.status).toBe('queued')
  })

  it.each(['projectNo', 'maxExecutions', 'expiresAt', 'budget', 'selector'] as const)('same activation key with changed %s is not a new consent', async changed => {
    const input = await activationInput(); await activate(input)
    const other = { ...input, ...(changed === 'projectNo' ? { projectNo: 'SYN-OTHER-PROJECT' }
      : changed === 'maxExecutions' ? { maxExecutions: 2 } : changed === 'expiresAt' ? { expiresAt: '2098-01-01T00:00:00.000Z' }
        : changed === 'selector' ? { selector: { ...selector, targetId: 'synthetic-other-target' } }
          : { budget: { ...budget, maxRows: 19 } }) }
    await expect(activate(other)).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it('standalone schedule grants and absent activation never produce automatic requests or upgrade purpose', async () => {
    const old = await ledger.grant(actor, { selector, projects: ['SYN-SCHEDULE-PROJECT'], triggers: ['schedule'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 3 })
    const occurrence = { ruleId: selector.ruleId, scheduledAtMs: Math.floor(await clockMs() / MINUTE) * MINUTE - MINUTE }
    expect(await ledger.scheduleActivationCandidates(occurrence, signal())).toEqual([])
    expect(await ledger.submitSchedule(randomUUID(), occurrence, signal())).toBeNull()
    await expect(admin.query("UPDATE integration_automation_read_grants SET purpose='automatic' WHERE id=$1", [old.grantId])).rejects.toBeDefined()
    expect((await admin.query('SELECT purpose FROM integration_automation_read_grants')).rows).toEqual([{ purpose: 'standalone' }])
    expect(await counts()).toEqual({ ...empty, grants: 1 })
  })

  it.each(['other-owner', 'other-tenant', 'revoked-role'] as const)('fresh activation rejects %s using real actor membership and creator checks', async mismatch => {
    await admin.query("INSERT INTO users VALUES ('synthetic-other-owner','user','[]',true,'activated')")
    await admin.query("INSERT INTO user_roles VALUES ('synthetic-other-owner','integration_admin')")
    await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', ['synthetic-other-owner', actor.tenantId])
    await admin.query("INSERT INTO user_namespace_admissions VALUES ('synthetic-other-owner','integration',true)")
    if (mismatch === 'revoked-role') await admin.query("DELETE FROM role_permissions WHERE permission_code='integration:admin'")
    const principal = { ...actor, ...(mismatch === 'other-owner' ? { actorId: 'synthetic-other-owner' }
      : mismatch === 'other-tenant' ? { tenantId: 'synthetic-other-tenant' } : {}) }
    await expect(ledger.activateSchedule(principal, await activationInput(), signal())).rejects.toBeDefined()
    expect(await counts()).toEqual(empty)
  })

  it.each(['integration_automation_read_grants', 'integration_automation_read_schedule_activations'])('activation INSERT failure at %s rolls the whole consent back', async name => {
    let reached = 0
    beforeQuery = async statement => { if (new RegExp('INSERT\\s+INTO\\s+' + name + '\\s*\\(', 'iu').test(statement)) {
      reached++; throw new Error('SYNTHETIC_SCHEDULE_INSERT_FAILURE')
    } }
    await expect(activate()).rejects.toBeDefined()
    expect(reached).toBe(1); expect(await counts()).toEqual(empty)
  })

  it('due occurrence queues one private request plus real audit and outbox without source IO or public selector material', async () => {
    const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId)
    expect(await ledger.scheduleActivationCandidates(occurrence, signal())).toEqual([pair.activationId])
    const request = await ledger.submitSchedule(pair.activationId, occurrence, signal())
    expect(request?.status).toBe('queued'); expect(await counts()).toEqual(queued)
    expect((await admin.query('SELECT project_no,trigger_type FROM integration_automation_read_requests')).rows)
      .toEqual([{ project_no: 'SYN-SCHEDULE-PROJECT', trigger_type: 'schedule' }])
    expect((await admin.query('SELECT integration_read,trigger_event,rule_snapshot,steps FROM multitable_automation_executions')).rows)
      .toEqual([{ integration_read: { requestId: request?.requestId, status: 'queued' }, trigger_event: null, rule_snapshot: null, steps: [] }])
    expect((await admin.query('SELECT payload FROM meta_automation_outbox')).rows).toEqual([{ payload: { requestId: request?.requestId } }])
    expect((await admin.query('SELECT invocation_id FROM integration_automation_read_requests')).rows)
      .toEqual([{ invocation_id: 'schedule-read:' + createHash('sha256').update(JSON.stringify([
        pair.activationId, 'schedule.cron', new Date(occurrence.scheduledAtMs).toISOString(),
      ])).digest('hex') }])
  })

  it('same planned occurrence is stable across concurrent delivery and ledger reconstruction; next minute is independent', async () => {
    const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId)
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => makeLedger().submitSchedule(pair.activationId, occurrence, signal())))
    const values = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    expect(values.length).toBeGreaterThan(0); expect(values[0]?.requestId).toBeTruthy()
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(values.every(value => value?.requestId === values[0]?.requestId)).toBe(true)
    expect((await makeLedger().submitSchedule(pair.activationId, occurrence, signal()))?.requestId).toBe(values[0]?.requestId)
    expect(await counts()).toEqual(queued)
    const next = await makeLedger().submitSchedule(pair.activationId, { ...occurrence, scheduledAtMs: occurrence.scheduledAtMs + MINUTE }, signal())
    expect(next?.requestId).toBeTruthy(); expect(next?.requestId).not.toBe(values[0]?.requestId)
    expect(await counts()).toEqual({ ...queued, requests: 2, links: 2, executions: 2, read_events: 2, deliveries: 2 })
  })

  it('different explicit activations do not collapse the same planned minute into one budget', async () => {
    const one = await activate(), two = await activate()
    const occurrence = await arrangeElapsedActivation(one.activationId)
    await arrangeElapsedActivation(two.activationId, occurrence.scheduledAtMs)
    const first = await ledger.submitSchedule(one.activationId, occurrence, signal())
    const second = await ledger.submitSchedule(two.activationId, occurrence, signal())
    expect(first?.requestId).toBeTruthy(); expect(second?.requestId).toBeTruthy()
    expect(first?.requestId).not.toBe(second?.requestId)
    expect(await counts()).toEqual({ grants: 2, activations: 2, requests: 2, links: 2, executions: 2, read_events: 2, deliveries: 2 })
  })

  it('exactly 100 actual candidates are returned; 101 rejects the whole scan instead of truncating', async () => {
    const pairs: Array<{ activationId: string; grantId: string }> = []
    // Real consent transactions exercise both deferred guards; no candidate SQL
    // or returned rows are substituted. Only the owned time fixture is arranged.
    for (let index = 0; index < 100; index++) pairs.push(await activate())
    const ids = pairs.map(pair => pair.activationId).sort()
    const occurrence = await arrangeElapsedActivation(ids)
    expect(await ledger.scheduleActivationCandidates(occurrence, signal())).toEqual(ids)
    expect(await counts()).toEqual({ ...empty, grants: 100, activations: 100 })
    const extra = await activate()
    await arrangeElapsedActivation(extra.activationId, occurrence.scheduledAtMs)
    await expect(ledger.scheduleActivationCandidates(occurrence, signal()))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(await counts()).toEqual({ ...empty, grants: 101, activations: 101 })
    expect((await admin.query('SELECT sum(used_executions)::int n FROM integration_automation_read_grants')).rows[0].n).toBe(0)
    // Bringing only the eligible count back to the boundary makes the exact
    // same planned occurrence readable again, without deleting any history.
    await ledger.revoke(actor, extra.grantId)
    expect(await makeLedger().scheduleActivationCandidates(occurrence, signal())).toEqual(ids)
  }, 60000)

  it('standalone, record and schedule identities cannot borrow one another while both automatic families remain usable', async () => {
    const scheduled = await activate(), occurrence = await arrangeElapsedActivation(scheduled.activationId)
    const recordSelector = { ...selector, ruleId: 'synthetic-separate-record-rule' }
    await admin.query(`INSERT INTO automation_rules(id,sheet_id,created_by,enabled,trigger_type,trigger_config,conditions,action_type,action_config)
      SELECT $2,sheet_id,created_by,enabled,'record.created',NULL,NULL,action_type,action_config FROM automation_rules WHERE id=$1`,
    [selector.ruleId, recordSelector.ruleId])
    const recorded = await ledger.activateRecord(actor, { ...await activationInput(), selector: recordSelector,
      expectedRecordCondition: { mode: 'unconditional' },
      expectedRuleRevision: (await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [recordSelector.ruleId])).rows[0].integration_authority_revision as string })
    const standalone = await ledger.grant(actor, { selector, projects: ['SYN-SCHEDULE-PROJECT'], triggers: ['manual'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 3 })
    const delivery = await recordDelivery()
    expect(await ledger.scheduleActivationCandidates(occurrence, signal())).toEqual([scheduled.activationId])
    expect(await ledger.recordActivationCandidates(delivery, signal())).toEqual([recorded.activationId])
    for (const id of [recorded.activationId, recorded.grantId, standalone.grantId]) {
      expect(await ledger.submitSchedule(id, occurrence, signal())).toBeNull()
    }
    for (const id of [scheduled.activationId, scheduled.grantId, standalone.grantId]) {
      expect(await ledger.submitRecord(id, delivery, signal())).toBeNull()
    }
    await expect(ledger.submit(actor, { grantId: recorded.grantId, invocationId: randomUUID(),
      projectNo: 'SYN-SCHEDULE-PROJECT', trigger: 'manual' })).rejects.toBeDefined()
    await expect(admin.query("UPDATE integration_automation_read_grants SET triggers=ARRAY['schedule']::text[] WHERE id=$1", [recorded.grantId])).rejects.toBeDefined()
    await expect(admin.query("UPDATE integration_automation_read_grants SET triggers=ARRAY['record']::text[] WHERE id=$1", [scheduled.grantId])).rejects.toBeDefined()
    expect(await counts()).toEqual({ ...empty, grants: 3, activations: 1, deliveries: 1 })
    expect((await ledger.submitRecord(recorded.activationId, delivery, signal()))?.status).toBe('queued')
    expect((await ledger.submitSchedule(scheduled.activationId, occurrence, signal()))?.status).toBe('queued')
    expect((await ledger.submit(actor, { grantId: standalone.grantId, invocationId: randomUUID(),
      projectNo: 'SYN-SCHEDULE-PROJECT', trigger: 'manual' })).status).toBe('queued')
    expect((await admin.query('SELECT trigger_type FROM integration_automation_read_requests ORDER BY trigger_type')).rows)
      .toEqual([{ trigger_type: 'manual' }, { trigger_type: 'record' }, { trigger_type: 'schedule' }])
    expect(await counts()).toEqual({ grants: 3, activations: 1, requests: 3, links: 3, executions: 3, read_events: 3, deliveries: 4 })
  })

  it('finite reservations and executed budget count once per occurrence, never once per retry', async () => {
    const pair = await activate({ ...await activationInput(), maxExecutions: 1 }), occurrence = await arrangeElapsedActivation(pair.activationId)
    const first = await ledger.submitSchedule(pair.activationId, occurrence, signal())
    if (!first) throw new Error('SYNTHETIC_SCHEDULE_REQUEST_MISSING')
    const next = { ...occurrence, scheduledAtMs: occurrence.scheduledAtMs + MINUTE }
    await expect(ledger.submitSchedule(pair.activationId, next, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_BUDGET_EXHAUSTED' })
    const fence = await claim(first.requestId)
    await ledger.complete({ requestId: first.requestId, fence, result: preview })
    expect((await makeLedger().submitSchedule(pair.activationId, occurrence, signal()))?.requestId).toBe(first.requestId)
    await expect(ledger.submitSchedule(pair.activationId, next, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_BUDGET_EXHAUSTED' })
    expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants')).rows).toEqual([{ used_executions: 1 }])
    expect(await counts()).toEqual(queued)
  })

  it.each(['manual', 'record', 'schedule'] as const)('ordinary submit cannot consume automatic schedule consent via %s', async trigger => {
    const pair = await activate()
    await expect(ledger.submit(actor, { grantId: pair.grantId, invocationId: randomUUID(), projectNo: 'SYN-SCHEDULE-PROJECT', trigger })).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it.each(['other-rule', 'sub-minute', 'not-finite', 'negative'] as const)('wrong occurrence %s produces no request', async mismatch => {
    const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId)
    const bad = mismatch === 'other-rule' ? { ...occurrence, ruleId: 'synthetic-other-rule' }
      : { ...occurrence, scheduledAtMs: mismatch === 'sub-minute' ? occurrence.scheduledAtMs + 1 : mismatch === 'not-finite' ? NaN : -MINUTE }
    if (mismatch === 'other-rule') {
      expect(await ledger.scheduleActivationCandidates(bad, signal())).toEqual([])
      expect(await ledger.submitSchedule(pair.activationId, bad, signal())).toBeNull()
    } else {
      await expect(ledger.scheduleActivationCandidates(bad, signal())).rejects.toBeDefined()
      await expect(ledger.submitSchedule(pair.activationId, bad, signal())).rejects.toBeDefined()
    }
    expect(await counts()).toEqual(activated)
  })

  it('a due minute not matching the frozen cron cannot become an occurrence', async () => {
    const scheduledAtMs = Math.floor(await clockMs() / MINUTE) * MINUTE - 2 * MINUTE
    const wrongMinute = (new Date(scheduledAtMs).getUTCMinutes() + 1) % 60
    await admin.query('UPDATE automation_rules SET trigger_config=$1::jsonb WHERE id=$2', [JSON.stringify({ expression: `${wrongMinute} * * * *` }), selector.ruleId])
    const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId, scheduledAtMs)
    expect(await ledger.scheduleActivationCandidates(occurrence, signal())).toEqual([])
    expect(await ledger.submitSchedule(pair.activationId, occurrence, signal())).toBeNull()
    expect(await counts()).toEqual(activated)
  })

  it.each([
    ['conditions', '{"all":[]}'], ['conditions', '{}'], ['trigger_type', 'schedule.interval'], ['trigger_type', 'schedule.date_field'],
    ['execution_mode', 'job'], ['trigger_config', '{}'], ['trigger_config', '{"expression":"bad"}'],
    ['trigger_config', '{"expression":"* * * * *","cron":"* * * * *"}'],
    ['trigger_config', '{"expression":"* * * * *","timezone":"Invalid/Zone"}'],
    ['trigger_config', '{"expression":"* * * * *","extra":true}'],
  ])('unsupported rule %s=%s is rejected before consent', async (field, value) => {
    await admin.query('UPDATE automation_rules SET ' + field + '=$1 WHERE id=$2', [value, selector.ruleId])
    await expect(activate()).rejects.toBeDefined(); expect(await counts()).toEqual(empty)
  })

  it.each([{ expression: '* * * * *', timezone: 'Asia/Shanghai' }, { cron: '* * * * *', timezone: 'UTC' }])('valid closed cron configuration %j is frozen exactly and applicable', async config => {
    await admin.query("UPDATE automation_rules SET trigger_config=$1::jsonb,conditions='null'::jsonb WHERE id=$2", [JSON.stringify(config), selector.ruleId])
    const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId)
    expect((await admin.query('SELECT cron_config FROM ' + table)).rows).toEqual([{ cron_config: config }])
    expect((await ledger.submitSchedule(pair.activationId, occurrence, signal()))?.status).toBe('queued')
  })

  it.each(['activation', 'submit'] as const)('lost %s COMMIT receipt recovers persisted identities instead of repeating work', async stage => {
    const uncertain = createAutomationReadLedger({ authority, manifest, async transaction(work) {
      await transaction(work); throw new Error('SYNTHETIC_SCHEDULE_COMMIT_RECEIPT_LOST')
    } })
    const input = await activationInput()
    if (stage === 'activation') {
      await expect(activate(input, uncertain)).rejects.toBeDefined()
      const original = (await admin.query('SELECT id,grant_id FROM ' + table)).rows[0]
      expect(await activate(input, makeLedger())).toEqual({ activationId: original.id, grantId: original.grant_id })
      expect(await counts()).toEqual(activated)
    } else {
      const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId)
      await expect(uncertain.submitSchedule(pair.activationId, occurrence, signal())).rejects.toBeDefined()
      const original = (await admin.query('SELECT id FROM integration_automation_read_requests')).rows[0]
      expect((await makeLedger().submitSchedule(pair.activationId, occurrence, signal()))?.requestId).toBe(original.id)
      expect(await counts()).toEqual(queued)
    }
  })

  it.each(['multitable_automation_executions', 'integration_automation_read_executions', 'meta_automation_outbox', 'meta_automation_outbox_consumer'])('failure at %s rolls request/audit/outbox back together', async name => {
    const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId); let reached = 0
    beforeQuery = async statement => { if (new RegExp('INSERT\\s+INTO\\s+' + name + '\\s*\\(', 'iu').test(statement)) {
      reached++; throw new Error('SYNTHETIC_SCHEDULE_INSERT_FAILURE')
    } }
    await expect(ledger.submitSchedule(pair.activationId, occurrence, signal())).rejects.toBeDefined()
    expect(reached).toBe(1); expect(await counts()).toEqual(activated)
    beforeQuery = undefined
    expect((await ledger.submitSchedule(pair.activationId, occurrence, signal()))?.status).toBe('queued')
    expect(await counts()).toEqual(queued)
  })

  it.each(['activation', 'candidates', 'submit'] as const)('an already aborted %s creates no effects', async stage => {
    const controller = new AbortController(); controller.abort()
    if (stage === 'activation') {
      await expect(ledger.activateSchedule(actor, await activationInput(), controller.signal)).rejects.toBeDefined()
      expect(await counts()).toEqual(empty)
    } else {
      const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId)
      await expect(stage === 'candidates' ? ledger.scheduleActivationCandidates(occurrence, controller.signal)
        : ledger.submitSchedule(pair.activationId, occurrence, controller.signal)).rejects.toBeDefined()
      expect(await counts()).toEqual(activated)
    }
  })

  it('abort after the real request INSERT rolls the transaction back', async () => {
    const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId), controller = new AbortController(); let reached = 0
    beforeQuery = async statement => { if (/INSERT\s+INTO\s+integration_automation_read_requests\s*\(/iu.test(statement)) { reached++; controller.abort() } }
    await expect(ledger.submitSchedule(pair.activationId, occurrence, controller.signal)).rejects.toBeDefined()
    expect(reached).toBe(1); expect(await counts()).toEqual(activated)
  })

  it.each(['before-submit', 'before-claim', 'before-checkpoint', 'before-publish'] as const)('owner permission revocation is rechecked %s', async stage => {
    const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId)
    const request = stage === 'before-submit' ? null : await ledger.submitSchedule(pair.activationId, occurrence, signal())
    const fence = request && ['before-checkpoint', 'before-publish'].includes(stage) ? await claim(request.requestId) : null
    await admin.query("DELETE FROM role_permissions WHERE permission_code='integration:admin'")
    if (stage === 'before-submit') await expect(ledger.submitSchedule(pair.activationId, occurrence, signal())).rejects.toBeDefined()
    else if (stage === 'before-claim') await expect(ledger.claim(request!.requestId)).rejects.toBeDefined()
    else if (stage === 'before-checkpoint') await expect(ledger.checkpoint({ requestId: request!.requestId, fence: fence! })).rejects.toBeDefined()
    else await expect(ledger.complete({ requestId: request!.requestId, fence: fence!, result: preview })).rejects.toBeDefined()
    expect((await admin.query("SELECT count(*)::int n FROM integration_automation_read_requests WHERE status='succeeded'")).rows[0].n).toBe(0)
  })

  it.each(['claim', 'checkpoint', 'publish'] as const)('synthetic source-authority revision change is rechecked at %s without source IO', async stage => {
    const request = await submitted(), fence = stage === 'claim' ? null : await claim(request.requestId)
    syntheticSourceRevision = 'source-revision-two'
    if (stage === 'claim') await expect(ledger.claim(request.requestId)).rejects.toBeDefined()
    else if (stage === 'checkpoint') await expect(ledger.checkpoint({ requestId: request.requestId, fence: fence! })).rejects.toBeDefined()
    else await expect(ledger.complete({ requestId: request.requestId, fence: fence!, result: preview })).rejects.toBeDefined()
    expect((await admin.query("SELECT count(*)::int n FROM integration_automation_read_requests WHERE status='succeeded'")).rows[0].n).toBe(0)
  })

  it('rule A→B→A cannot revive consent despite an identical final cron', async () => {
    const pair = await activate(), occurrence = await arrangeElapsedActivation(pair.activationId)
    const original = (await admin.query('SELECT integration_authority_revision FROM automation_rules')).rows[0]
    await admin.query('UPDATE automation_rules SET trigger_config=$1::jsonb WHERE id=$2', [JSON.stringify({ expression: '*/2 * * * *' }), selector.ruleId])
    await admin.query('UPDATE automation_rules SET trigger_config=$1::jsonb WHERE id=$2', [JSON.stringify({ expression: '* * * * *' }), selector.ruleId])
    expect((await admin.query('SELECT integration_authority_revision FROM automation_rules')).rows[0]).not.toEqual(original)
    await expect(ledger.submitSchedule(pair.activationId, occurrence, signal())).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it.each(['claim', 'checkpoint', 'publish'] as const)('isolates activation rule revision enforcement at %s from the synthetic authority digest', async stage => {
    const request = await submitted()
    const persisted = (await admin.query('SELECT authority_key FROM integration_automation_read_grants WHERE id=$1', [request.grantId])).rows[0]
    // Deliberate independent-guard probe, NOT proof of production authority.
    // Keep actor/rule DB checks and the DB nonce trigger; only freeze our fake
    // source authority digest so it cannot mask the activation revision guard.
    const isolated = createAutomationReadLedger({ transaction, manifest, authority: { ...authority,
      async lockExecution(trx, principal, selected) {
        return { ...await authority.lockExecution(trx, principal, selected), key: String(persisted.authority_key) }
      },
    } })
    const positive = await isolated.submitSchedule(request.activationId,
      { ...request.occurrence, scheduledAtMs: request.occurrence.scheduledAtMs + MINUTE }, signal())
    if (!positive) throw new Error('SYNTHETIC_SCHEDULE_POSITIVE_REQUEST_MISSING')
    const positiveFence = await claim(positive.requestId, isolated)
    expect(await isolated.checkpoint({ requestId: positive.requestId, fence: positiveFence })).toMatchObject({ actor, selector, projectNo: 'SYN-SCHEDULE-PROJECT' })
    expect((await isolated.complete({ requestId: positive.requestId, fence: positiveFence, result: preview })).status).toBe('succeeded')
    const fence = stage === 'claim' ? null : await claim(request.requestId, isolated)
    await admin.query("UPDATE automation_rules SET name='Changed after admission' WHERE id=$1", [selector.ruleId])
    if (stage === 'claim') await expect(isolated.claim(request.requestId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    else if (stage === 'checkpoint') await expect(isolated.checkpoint({ requestId: request.requestId, fence: fence! })).rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    else await expect(isolated.complete({ requestId: request.requestId, fence: fence!, result: preview })).rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    expect((await admin.query('SELECT status FROM integration_automation_read_requests WHERE id=$1', [request.requestId])).rows[0].status)
      .toBe(stage === 'claim' ? 'queued' : 'running')
  })

  it.each(['queued', 'running'] as const)('revoked schedule grant blocks further %s work and never appears active on replay', async state => {
    const input = await activationInput(), pair = await activate(input), occurrence = await arrangeElapsedActivation(pair.activationId)
    const request = await ledger.submitSchedule(pair.activationId, occurrence, signal())
    if (!request) throw new Error('SYNTHETIC_SCHEDULE_REQUEST_MISSING')
    const fence = state === 'running' ? await claim(request.requestId) : null
    await ledger.revoke(actor, pair.grantId)
    if (fence) {
      await expect(ledger.checkpoint({ requestId: request.requestId, fence })).rejects.toBeDefined()
      await expect(ledger.complete({ requestId: request.requestId, fence, result: preview })).rejects.toBeDefined()
    } else expect((await ledger.claim(request.requestId)).status).toBe('blocked')
    expect(await ledger.scheduleActivationCandidates(occurrence, signal())).toEqual([])
    expect(await activate(input, makeLedger())).toEqual(pair)
    expect((await admin.query('SELECT status FROM integration_automation_read_grants')).rows).toEqual([{ status: 'revoked' }])
    expect((await admin.query('SELECT status FROM integration_automation_read_requests')).rows)
      .toEqual([{ status: state === 'running' ? 'outcome_unknown' : 'blocked' }])
  })

  it.each(['grant_id', 'owner_id', 'tenant_id', 'rule_id', 'rule_revision', 'project_no', 'cron_config', 'activated_at'] as const)('persisted activation %s is immutable after fixture arrangement ends', async field => {
    const pair = await activate()
    const value = ['grant_id', 'rule_revision'].includes(field) ? randomUUID() : field === 'activated_at' ? '2020-01-01T00:00:00.000Z'
      : field === 'cron_config' ? '{"expression":"*/2 * * * *"}' : 'synthetic-different-value'
    await expect(admin.query('UPDATE ' + table + ' SET ' + field + '=$1 WHERE id=$2', [value, pair.activationId])).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it.each(['DELETE FROM ', 'TRUNCATE '])('schedule history refuses %s', async prefix => {
    await activate(); await expect(admin.query(prefix + table)).rejects.toBeDefined()
    expect(await counts()).toEqual(activated)
  })

  it('deferred guard rejects an orphan automatic schedule grant at COMMIT, not just inside application code', async () => {
    const original = await ledger.grant(actor, { selector, projects: ['SYN-SCHEDULE-PROJECT'], triggers: ['schedule'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 3 })
    let inserted = false
    await expect(transaction(async trx => {
      await trx.query(`INSERT INTO integration_automation_read_grants
        (id,tenant_id,owner_id,selector,authority_key,source_reference,projects,triggers,budget,expires_at,max_executions,purpose)
        SELECT $2,tenant_id,owner_id,selector,authority_key,source_reference,projects,triggers,budget,expires_at,max_executions,'automatic'
        FROM integration_automation_read_grants WHERE id=$1`, [original.grantId, randomUUID()])
      inserted = true
    })).rejects.toBeDefined()
    expect(inserted).toBe(true); expect(await counts()).toEqual({ ...empty, grants: 1 })
  })

  it('rollback refuses retained schedule consent and leaves the real table/history intact', async () => {
    const pair = await activate()
    await withoutDateSchedule(async () => {
      await expect(db.transaction().execute(removeScheduleActivation))
        .rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_READ_SCHEDULE_ACTIVATION_HAS_HISTORY' })
    })
    expect((await admin.query('SELECT id,grant_id FROM ' + table)).rows).toEqual([{ id: pair.activationId, grant_id: pair.grantId }])
    expect(await counts()).toEqual(activated)
  })

  it('reapplying actual schedule migration does not auto-enable an existing standalone schedule grant', async () => {
    const original = await ledger.grant(actor, { selector, projects: ['SYN-SCHEDULE-PROJECT'], triggers: ['schedule'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 3 })
    await withoutDateSchedule(async () => {
      await db.transaction().execute(removeScheduleActivation)
      await db.transaction().execute(addScheduleActivation)
      await db.transaction().execute(addIntervalSchedule)
    })
    expect((await admin.query('SELECT id,purpose FROM integration_automation_read_grants')).rows).toEqual([{ id: original.grantId, purpose: 'standalone' }])
    expect(await ledger.scheduleActivationCandidates({ ruleId: selector.ruleId, scheduledAtMs: Math.floor(await clockMs() / MINUTE) * MINUTE - MINUTE }, signal())).toEqual([])
    expect(await counts()).toEqual({ ...empty, grants: 1 })
  })

  it('schedule down preserves real record consent and execution history, permits record consent, then up preserves both', async () => {
    await admin.query("UPDATE automation_rules SET trigger_type='record.created',trigger_config=NULL WHERE id=$1", [selector.ruleId])
    const input = { ...await activationInput(), expectedRecordCondition: { mode: 'unconditional' as const },
      expectedRuleRevision: (await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [selector.ruleId])).rows[0].integration_authority_revision as string }
    const pair = await ledger.activateRecord(actor, input)
    const delivery = await recordDelivery(), request = await ledger.submitRecord(pair.activationId, delivery, signal())
    if (!request) throw new Error('SYNTHETIC_SCHEDULE_RECORD_REQUEST_MISSING')
    const fence = await claim(request.requestId)
    await ledger.complete({ requestId: request.requestId, fence, result: preview })
    const snapshot = async () => ({
      activation: (await admin.query('SELECT * FROM integration_automation_read_record_activations WHERE id=$1', [pair.activationId])).rows,
      grant: (await admin.query('SELECT * FROM integration_automation_read_grants WHERE id=$1', [pair.grantId])).rows,
      request: (await admin.query('SELECT * FROM integration_automation_read_requests WHERE id=$1', [request.requestId])).rows,
      audit: (await admin.query('SELECT * FROM integration_automation_read_executions WHERE request_id=$1', [request.requestId])).rows,
      execution: (await admin.query('SELECT * FROM multitable_automation_executions WHERE integration_read->>\'requestId\'=$1', [request.requestId])).rows,
    })
    const before = await snapshot(), secondInput = { ...input, activationKey: randomUUID() }
    let second: { activationId: string; grantId: string } | undefined
    await withoutDateSchedule(async () => {
      await db.transaction().execute(removeScheduleActivation)
      try {
        expect((await admin.query('SELECT to_regclass($1) AS schedule_table', [table])).rows).toEqual([{ schedule_table: null }])
        expect(await snapshot()).toEqual(before)
        expect(await ledger.activateRecord(actor, input)).toEqual(pair)
        // New consent runs the restored record deferred function, not just reads
        // old rows. Any failed assertion still restores 136000 for later cases.
        second = await ledger.activateRecord(actor, secondInput)
        expect(second.activationId).not.toBe(pair.activationId)
        expect((await ledger.grantDetail(actor, pair.grantId)).purpose).toBe('automatic')
      } finally {
        await db.transaction().execute(addScheduleActivation)
        await db.transaction().execute(addIntervalSchedule)
      }
    })
    expect(await snapshot()).toEqual(before)
    expect(await ledger.activateRecord(actor, secondInput)).toEqual(second)
    expect((await admin.query('SELECT count(*)::int n FROM integration_automation_read_record_activations')).rows[0].n).toBe(2)
    expect(await counts()).toEqual({ grants: 2, activations: 0, requests: 1, links: 1, executions: 1, read_events: 1, deliveries: 2 })
  })

  describe('141000 migration: real DB family, phase, immutable history and rollback boundaries', () => {
    const microsecondCreatedAt = '2026-01-01T00:00:00.000999Z'
    const expectedAnchorMs = Date.parse('2026-01-01T00:00:00.000Z')
    async function intervalRule(config: unknown = { intervalMs: 1250 }, createdAt = microsecondCreatedAt) {
      await admin.query(`UPDATE automation_rules SET trigger_type='schedule.interval',trigger_config=$2::jsonb,created_at=$3::timestamptz WHERE id=$1`,
        [selector.ruleId, JSON.stringify(config), createdAt])
    }
    /** Direct SQL only isolates the real migration's guard. It deliberately does
     * not assert source authority, client consent, or actual scheduler dispatch. */
    async function directPair(options: { legacy?: boolean; triggerType?: string; config?: unknown; anchor?: number | string | null; revision?: string } = {}) {
      const rule = (await admin.query('SELECT * FROM automation_rules WHERE id=$1', [selector.ruleId])).rows[0]
      const activationId = randomUUID(), grantId = randomUUID()
      const config = Object.hasOwn(options, 'config') ? options.config : rule.trigger_config
      return transaction(async trx => {
        await trx.query(`INSERT INTO integration_automation_read_grants
          (id,tenant_id,owner_id,selector,source_reference,authority_key,projects,triggers,budget,expires_at,max_executions,purpose)
          VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,ARRAY['SYN-SCHEDULE-PROJECT'],ARRAY['schedule'],$7::jsonb,'2099-01-01',3,'automatic')`,
        [grantId, actor.tenantId, actor.actorId, JSON.stringify(selector), JSON.stringify(sourceReference), 'a'.repeat(64), JSON.stringify(budget)])
        const params: unknown[] = [activationId, randomUUID(), grantId, actor.tenantId, actor.actorId, selector.ruleId,
          options.revision ?? rule.integration_authority_revision, 'SYN-SCHEDULE-PROJECT', JSON.stringify(config)]
        if (!options.legacy) params.push(options.triggerType ?? rule.trigger_type, options.anchor ?? null)
        await trx.query(`INSERT INTO integration_automation_read_schedule_activations
          (id,activation_key,grant_id,tenant_id,owner_id,rule_id,rule_revision,project_no,cron_config,activated_at${options.legacy ? '' : ',trigger_type,interval_anchor_ms'})
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'2098-01-01'${options.legacy ? '' : ',$10,$11::bigint'})`, params)
        return { activationId, grantId }
      })
    }
    async function history() {
      return {
        activations: (await admin.query(`SELECT pg_catalog.to_jsonb(a)-ARRAY['trigger_type','interval_anchor_ms'] AS data
          FROM integration_automation_read_schedule_activations a ORDER BY id`)).rows,
        grants: (await admin.query('SELECT * FROM integration_automation_read_grants ORDER BY id')).rows,
      }
    }

    it('old cron history survives up, repeated up and down byte-equivalent in all preexisting columns', async () => {
      await withoutDateSchedule(async () => {
        await db.transaction().execute(removeIntervalSchedule)
        try {
          await directPair({ legacy: true })
          const original = await history()
          await db.transaction().execute(addIntervalSchedule)
          expect(await history()).toEqual(original)
          expect((await admin.query('SELECT trigger_type,interval_anchor_ms FROM ' + table)).rows)
            .toEqual([{ trigger_type: 'schedule.cron', interval_anchor_ms: null }])
          await db.transaction().execute(addIntervalSchedule)
          expect(await history()).toEqual(original)
          await db.transaction().execute(removeIntervalSchedule)
          expect(await history()).toEqual(original)
          // New consent after down executes the restored 136000 trigger.
          await directPair({ legacy: true })
          expect((await admin.query('SELECT count(*)::int n FROM ' + table)).rows[0].n).toBe(2)
        } finally { await db.transaction().execute(addIntervalSchedule) }
      })
    })

    it('pre-141 deployment fails closed at the real new-column INSERT and rolls its earlier grant back', async () => {
      await intervalRule()
      await withoutDateSchedule(async () => {
        await db.transaction().execute(removeIntervalSchedule)
        let reached = 0
        beforeQuery = async statement => {
          if (/INSERT\s+INTO\s+integration_automation_read_schedule_activations\s*\(/iu.test(statement)) {
            reached++
            expect(statement).toContain('interval_anchor_ms')
          }
        }
        try {
          await expect(activate()).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
          expect(reached).toBe(1)
          expect(await counts()).toEqual(empty)
        } finally { beforeQuery = undefined; await db.transaction().execute(addIntervalSchedule) }
      })
    })

    it('direct interval consent binds DB microseconds by floor, mints DB cutover, and repeat-up never rewrites it', async () => {
      await intervalRule()
      await withoutDateSchedule(async () => {
        const before = await clockMs(), pair = await directPair({ anchor: expectedAnchorMs }), after = await clockMs()
        expect((await admin.query(`SELECT interval_anchor_ms::text,trigger_type,cron_config,
          extract(epoch FROM activated_at)*1000 AS born FROM ${table} WHERE id=$1`, [pair.activationId])).rows[0])
          .toMatchObject({ interval_anchor_ms: String(expectedAnchorMs), trigger_type: 'schedule.interval', cron_config: { intervalMs: 1250 } })
        const born = Number((await admin.query('SELECT extract(epoch FROM activated_at)*1000 AS born FROM ' + table)).rows[0].born)
        expect(born).toBeGreaterThanOrEqual(before)
        expect(born).toBeLessThanOrEqual(after)
        expect((await admin.query('SELECT floor(extract(epoch FROM created_at)*1000)::text AS floor_ms,(extract(epoch FROM created_at)*1000)::bigint::text AS rounded_ms FROM automation_rules')).rows)
          .toEqual([{ floor_ms: String(expectedAnchorMs), rounded_ms: String(expectedAnchorMs + 1) }])
        const original = (await admin.query('SELECT * FROM ' + table)).rows
        await db.transaction().execute(addIntervalSchedule)
        expect((await admin.query('SELECT * FROM ' + table)).rows).toEqual(original)
        await expect(db.transaction().execute(removeIntervalSchedule))
          .rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_READ_INTERVAL_SCHEDULE_HAS_HISTORY' })
        expect((await admin.query('SELECT * FROM ' + table)).rows).toEqual(original)
        expect(await counts()).toEqual(activated)
      })
    })

    it.each([null, expectedAnchorMs + 1, expectedAnchorMs - 1, 0, -1, '8640000000000001'])('direct interval anchor %s cannot replace the actual positive DB phase', async anchor => {
      await intervalRule()
      await expect(directPair({ anchor })).rejects.toMatchObject({ code: '23514', message: 'AUTOMATION_READ_SCHEDULE_ACTIVATION_DENIED' })
      expect(await counts()).toEqual(empty)
    })

    it.each(['infinity', '-infinity', '1970-01-01T00:00:00Z', '1969-12-31T23:59:59.999Z', '280000-01-01'])('unrepresentable/nonpositive rule created_at %s cannot mint interval consent', async createdAt => {
      await intervalRule({ intervalMs: 1250 }, createdAt)
      await expect(directPair({ anchor: expectedAnchorMs })).rejects.toMatchObject({ code: '23514', message: 'AUTOMATION_READ_SCHEDULE_ACTIVATION_DENIED' })
      await expect(activate()).rejects.toBeDefined()
      expect(await counts()).toEqual(empty)
    })

    it.each([{}, null, [], { intervalMs: null }, { intervalMs: '1000' }, { intervalMs: 999 },
      { intervalMs: 1000.5 }, { intervalMs: 2147483648 }, { intervalMs: 1000, intervalMinutes: 1 },
      { intervalMs: 1000, expression: '* * * * *' }, { intervalMinutes: 1 }])('closed DB interval config rejects %j without a half grant', async config => {
      await intervalRule(config)
      await expect(directPair({ anchor: expectedAnchorMs })).rejects.toBeDefined()
      await expect(activate()).rejects.toBeDefined()
      expect(await counts()).toEqual(empty)
    })

    it.each([1000, 2147483647])('both DB and host accept the integral timer bound %i', async intervalMs => {
      await intervalRule({ intervalMs })
      const one = await directPair({ anchor: expectedAnchorMs }), two = await activate()
      expect(two.activationId).not.toBe(one.activationId)
      expect((await admin.query('SELECT cron_config,interval_anchor_ms::text FROM ' + table)).rows)
        .toEqual([{ cron_config: { intervalMs }, interval_anchor_ms: String(expectedAnchorMs) },
          { cron_config: { intervalMs }, interval_anchor_ms: String(expectedAnchorMs) }])
      expect(await counts()).toEqual({ ...empty, grants: 2, activations: 2 })
    })

    it.each(['cron-as-interval', 'interval-as-cron', 'cron-with-anchor', 'unknown-family', 'stale-revision', 'conditions'] as const)('direct SQL refuses %s against the actual rule', async mismatch => {
      if (mismatch === 'interval-as-cron') await intervalRule()
      if (mismatch === 'conditions') await admin.query("UPDATE automation_rules SET conditions='{}'::jsonb WHERE id=$1", [selector.ruleId])
      const options = mismatch === 'cron-as-interval' ? { triggerType: 'schedule.interval', config: { intervalMs: 1250 }, anchor: expectedAnchorMs }
        : mismatch === 'interval-as-cron' ? { triggerType: 'schedule.cron', config: { expression: '* * * * *' } }
          : mismatch === 'cron-with-anchor' ? { anchor: expectedAnchorMs }
            : mismatch === 'unknown-family' ? { triggerType: 'schedule.date_field' }
              : mismatch === 'stale-revision' ? { revision: randomUUID() } : {}
      await expect(directPair(options)).rejects.toMatchObject({ code: '23514', message: 'AUTOMATION_READ_SCHEDULE_ACTIVATION_DENIED' })
      expect(await counts()).toEqual(empty)
    })

    it('the CHECK independently rejects a NULL interval anchor even when only the owned admission trigger is isolated', async () => {
      await intervalRule()
      await requireOwnedSchema()
      await admin.query('ALTER TABLE ' + table + ' DISABLE TRIGGER automation_read_schedule_activation_admit')
      try {
        await expect(directPair({ anchor: null })).rejects.toMatchObject({ code: '23514', constraint: 'automation_read_schedule_config_shape' })
        expect(await counts()).toEqual(empty)
      } finally { await admin.query('ALTER TABLE ' + table + ' ENABLE TRIGGER automation_read_schedule_activation_admit') }
      expect((await admin.query(`SELECT tgenabled FROM pg_catalog.pg_trigger WHERE tgrelid=$1::regclass AND tgname='automation_read_schedule_activation_admit'`, [table])).rows)
        .toEqual([{ tgenabled: 'O' }])
      await directPair({ anchor: expectedAnchorMs })
      expect(await counts()).toEqual(activated)
    })

    it.each(['trigger_type', 'interval_anchor_ms'] as const)('new persisted %s is covered by the original whole-row immutable guard', async field => {
      await intervalRule()
      const pair = await directPair({ anchor: expectedAnchorMs })
      await expect(admin.query('UPDATE ' + table + ' SET ' + field + '=$1 WHERE id=$2',
        [field === 'trigger_type' ? 'schedule.cron' : expectedAnchorMs + 1, pair.activationId]))
        .rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_READ_SCHEDULE_ACTIVATION_IMMUTABLE' })
      expect(await counts()).toEqual(activated)
    })

    it('the real rule row NOWAIT lock rejects concurrent rule writers and atomically rolls back the grant', async () => {
      await intervalRule()
      const writer = await pool.connect()
      try {
        await writer.query('BEGIN')
        await writer.query('SELECT id FROM automation_rules WHERE id=$1 FOR UPDATE', [selector.ruleId])
        // The awaited FOR UPDATE is the barrier: no sleeps or query-result replacements.
        await expect(directPair({ anchor: expectedAnchorMs })).rejects.toMatchObject({ code: '55P03' })
        expect(await counts()).toEqual(empty)
      } finally { await writer.query('ROLLBACK'); writer.release() }
      await directPair({ anchor: expectedAnchorMs })
      expect(await counts()).toEqual(activated)
    })

    it('repeat-up fails closed on an incompatible existing phase-column contract without rewriting history', async () => {
      await withoutDateSchedule(async () => {
        await admin.query('ALTER TABLE ' + table + ' ALTER COLUMN interval_anchor_ms SET DEFAULT 1')
        try {
          await expect(db.transaction().execute(addIntervalSchedule))
            .rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_READ_INTERVAL_SCHEDULE_SCHEMA_INVALID' })
          expect(await counts()).toEqual(empty)
        } finally { await admin.query('ALTER TABLE ' + table + ' ALTER COLUMN interval_anchor_ms DROP DEFAULT') }
        await db.transaction().execute(addIntervalSchedule)
      })
    })
  })

  describe('interval ledger admission on the real PG schema (synthetic source authority)', () => {
    async function prepare(intervalMs = 1250) {
      // Synthetic fixture phase predates activation; it is not a scheduler/backfill proof.
      await admin.query(`UPDATE automation_rules SET trigger_type='schedule.interval',trigger_config=$2::jsonb,
        created_at='2026-01-01T00:00:00.000999Z'::timestamptz WHERE id=$1`, [selector.ruleId, JSON.stringify({ intervalMs })])
      const pair = await activate()
      const row = (await admin.query('SELECT interval_anchor_ms::text,cron_config,trigger_type FROM ' + table + ' WHERE id=$1', [pair.activationId])).rows[0]
      const anchorMs = Number(row.interval_anchor_ms)
      const scheduledAtMs = anchorMs + Math.floor((await clockMs() - 2 * MINUTE - anchorMs) / intervalMs) * intervalMs
      await arrangeElapsedActivation(pair.activationId, scheduledAtMs)
      return { pair, occurrence: { ruleId: selector.ruleId, triggerType: 'schedule.interval' as const, intervalMs, anchorMs, scheduledAtMs } }
    }

    it('one fixed-phase occurrence keeps its exact identity across replay/reconstruction; next phase is independent', async () => {
      const { pair, occurrence } = await prepare()
      expect(await ledger.scheduleActivationCandidates(occurrence, signal())).toEqual([pair.activationId])
      const first = await ledger.submitSchedule(pair.activationId, occurrence, signal())
      expect(first?.status).toBe('queued')
      expect((await makeLedger().submitSchedule(pair.activationId, occurrence, signal()))?.requestId).toBe(first?.requestId)
      expect((await admin.query('SELECT invocation_id FROM integration_automation_read_requests')).rows)
        .toEqual([{ invocation_id: 'schedule-read:' + createHash('sha256').update(JSON.stringify([
          pair.activationId, 'schedule.interval', new Date(occurrence.scheduledAtMs).toISOString(),
        ])).digest('hex') }])
      expect(await counts()).toEqual(queued)
      const next = await ledger.submitSchedule(pair.activationId, { ...occurrence, scheduledAtMs: occurrence.scheduledAtMs + occurrence.intervalMs }, signal())
      expect(next?.status).toBe('queued')
      expect(next?.requestId).not.toBe(first?.requestId)
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants')).rows).toEqual([{ used_executions: 0 }])
      expect(await counts()).toEqual({ ...queued, requests: 2, links: 2, executions: 2, read_events: 2, deliveries: 2 })
    })

    it('same-key interval recovery is immutable and requires the original revision even after rule family changes', async () => {
      await admin.query(`UPDATE automation_rules SET trigger_type='schedule.interval',trigger_config='{"intervalMs":1000}' WHERE id=$1`, [selector.ruleId])
      const input = await activationInput(), pair = await activate(input)
      await admin.query(`UPDATE automation_rules SET trigger_type='schedule.cron',trigger_config='{"expression":"* * * * *"}' WHERE id=$1`, [selector.ruleId])
      expect(await activate(input, makeLedger())).toEqual(pair)
      await expect(activate({ ...input, expectedRuleRevision: await ruleRevision() }))
        .rejects.toMatchObject({ code: 'AUTOMATION_READ_IDEMPOTENCY_CONFLICT' })
      expect((await admin.query('SELECT trigger_type,cron_config FROM ' + table)).rows)
        .toEqual([{ trigger_type: 'schedule.interval', cron_config: { intervalMs: 1000 } }])
      expect(await counts()).toEqual(activated)
    })

    it('pre-consent ABA rejects the displayed revision before creating either grant or activation', async () => {
      const input = await activationInput()
      await admin.query(`UPDATE automation_rules SET trigger_type='schedule.interval',trigger_config='{"intervalMs":1000}' WHERE id=$1`, [selector.ruleId])
      await admin.query(`UPDATE automation_rules SET trigger_type='schedule.cron',trigger_config='{"expression":"* * * * *"}' WHERE id=$1`, [selector.ruleId])
      await expect(activate(input)).rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
      expect(await counts()).toEqual(empty)
    })

    it.each(['interval-config', 'created-at', 'family'] as const)('post-consent %s ABA cannot revive an interval request or candidate', async changed => {
      const { pair, occurrence } = await prepare()
      if (changed === 'interval-config') {
        await admin.query(`UPDATE automation_rules SET trigger_config='{"intervalMs":1500}' WHERE id=$1`, [selector.ruleId])
        await admin.query(`UPDATE automation_rules SET trigger_config='{"intervalMs":1250}' WHERE id=$1`, [selector.ruleId])
      } else if (changed === 'created-at') {
        await admin.query("UPDATE automation_rules SET created_at=created_at+interval '1 millisecond' WHERE id=$1", [selector.ruleId])
        await admin.query("UPDATE automation_rules SET created_at=created_at-interval '1 millisecond' WHERE id=$1", [selector.ruleId])
      } else {
        await admin.query(`UPDATE automation_rules SET trigger_type='schedule.cron',trigger_config='{"expression":"* * * * *"}' WHERE id=$1`, [selector.ruleId])
        await admin.query(`UPDATE automation_rules SET trigger_type='schedule.interval',trigger_config='{"intervalMs":1250}' WHERE id=$1`, [selector.ruleId])
      }
      expect(await ledger.scheduleActivationCandidates(occurrence, signal())).toEqual([])
      await expect(ledger.submitSchedule(pair.activationId, occurrence, signal())).rejects.toBeDefined()
      expect(await counts()).toEqual(activated)
    })

    it('valid but different host interval plan cannot consume the retained phase; cron and interval do not cross families', async () => {
      const { pair, occurrence } = await prepare()
      const altered = { ...occurrence, intervalMs: occurrence.intervalMs * 2,
        scheduledAtMs: occurrence.anchorMs + Math.floor((occurrence.scheduledAtMs - occurrence.anchorMs) / (occurrence.intervalMs * 2)) * occurrence.intervalMs * 2 }
      const wrongAnchor = { ...occurrence, anchorMs: occurrence.anchorMs + occurrence.intervalMs }
      const cron = { ruleId: selector.ruleId, scheduledAtMs: Math.floor(occurrence.scheduledAtMs / MINUTE) * MINUTE }
      for (const other of [altered, wrongAnchor, cron]) {
        expect(await ledger.scheduleActivationCandidates(other, signal())).toEqual([])
        expect(await ledger.submitSchedule(pair.activationId, other, signal())).toBeNull()
      }
      expect(await counts()).toEqual(activated)
    })

    it('a cron activation cannot accept an otherwise valid interval plan on the same rule and due minute', async () => {
      const pair = await activate(), cron = await arrangeElapsedActivation(pair.activationId)
      const interval = { ...cron, triggerType: 'schedule.interval' as const, intervalMs: 1000, anchorMs: cron.scheduledAtMs - 1000 }
      expect(await ledger.scheduleActivationCandidates(interval, signal())).toEqual([])
      expect(await ledger.submitSchedule(pair.activationId, interval, signal())).toBeNull()
      expect(await counts()).toEqual(activated)
      expect((await ledger.submitSchedule(pair.activationId, cron, signal()))?.status).toBe('queued')
    })

    it('interval keeps DB cutover strict, rejects future phase and never reserves on a non-occurrence', async () => {
      const { pair, occurrence } = await prepare()
      await arrangeElapsedActivation(pair.activationId, occurrence.scheduledAtMs, true)
      expect(await ledger.scheduleActivationCandidates(occurrence, signal())).toEqual([])
      expect(await ledger.submitSchedule(pair.activationId, occurrence, signal())).toBeNull()
      const future = { ...occurrence, scheduledAtMs: occurrence.anchorMs
        + (Math.ceil((await clockMs() - occurrence.anchorMs) / occurrence.intervalMs) + 100) * occurrence.intervalMs }
      expect(await ledger.scheduleActivationCandidates(future, signal())).toEqual([])
      expect(await ledger.submitSchedule(pair.activationId, future, signal())).toBeNull()
      await expect(ledger.submitSchedule(pair.activationId, { ...occurrence, scheduledAtMs: occurrence.scheduledAtMs + 1 }, signal()))
        .rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
      expect(await counts()).toEqual(activated)
      expect((await ledger.submitSchedule(pair.activationId, { ...occurrence, scheduledAtMs: occurrence.scheduledAtMs + occurrence.intervalMs }, signal()))?.status).toBe('queued')
    })

    it('interval reserves once, cannot exceed the queued budget, and revalidates through worker completion', async () => {
      const { pair, occurrence } = await prepare()
      // Each explicit activation owns its own budget, never a global occurrence dedup.
      const one = await activate({ ...await activationInput(), maxExecutions: 1 })
      await arrangeElapsedActivation(one.activationId, occurrence.scheduledAtMs)
      const request = await ledger.submitSchedule(one.activationId, occurrence, signal())
      if (!request) throw new Error('SYNTHETIC_INTERVAL_REQUEST_MISSING')
      await expect(ledger.submitSchedule(one.activationId, { ...occurrence, scheduledAtMs: occurrence.scheduledAtMs + occurrence.intervalMs }, signal()))
        .rejects.toMatchObject({ code: 'AUTOMATION_READ_BUDGET_EXHAUSTED' })
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [one.grantId])).rows)
        .toEqual([{ used_executions: 0 }])
      const fence = await claim(request.requestId)
      expect(await ledger.checkpoint({ requestId: request.requestId, fence })).toMatchObject({ authorityMode: 'execution', selector })
      expect((await ledger.complete({ requestId: request.requestId, fence, result: preview })).status).toBe('succeeded')
      expect((await makeLedger().submitSchedule(one.activationId, occurrence, signal()))?.requestId).toBe(request.requestId)
      expect((await ledger.submitSchedule(pair.activationId, occurrence, signal()))?.status).toBe('queued')
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [one.grantId])).rows)
        .toEqual([{ used_executions: 1 }])
    })
  })
})
