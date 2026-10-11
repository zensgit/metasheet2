/** SA06AS: real PostgreSQL date metadata/permissions, private proof factory,
 * consent/receipt constraints, ledger, audit and outbox. Source authority here
 * is explicitly synthetic and revision-bound, NOT an HTTP/native source proof.
 * No fake clock: all producer admission uses PostgreSQL clock_timestamp(). */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { up as addOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { up as addRuleRevision } from '../../src/db/migrations/zzzz20261001122000_automation_rule_authority_revision'
import { up as addLedger } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { up as addMaterial } from '../../src/db/migrations/zzzz20261001130000_automation_read_material_epochs'
import { up as addAudit } from '../../src/db/migrations/zzzz20261001134000_automation_read_execution_audit'
import { up as addRecordActivation } from '../../src/db/migrations/zzzz20261001135000_automation_read_record_activation'
import { up as addScheduleActivation } from '../../src/db/migrations/zzzz20261001136000_automation_read_schedule_activation'
import { up as addUpdatedRecordActivation } from '../../src/db/migrations/zzzz20261001137000_automation_read_record_updated_activation'
import { up as addRecordConditions } from '../../src/db/migrations/zzzz20261001140000_automation_read_record_conditions'
import { up as addIntervalSchedule } from '../../src/db/migrations/zzzz20261001141000_automation_read_interval_schedule_activation'
import { up as addRetry } from '../../src/db/migrations/zzzz20261002142000_automation_read_linked_retry'
import { up as addDateSchedule, down as removeDateSchedule } from '../../src/db/migrations/zzzz20261002143000_automation_read_date_schedule_activation'
import { up as addDateRetry, down as removeDateRetry } from '../../src/db/migrations/zzzz20261002144000_automation_read_date_linked_retry'
import { createAutomationReadLedger } from '../../src/integration/automation-read-ledger'
import { AUTOMATION_READ_OPERATION } from '../../src/integration/automation-read-operation-policy'
import { AUTOMATION_READ_CONSUMER, AUTOMATION_READ_EVENT, AutomationReadLedgerError,
  type AutomationReadAuthorityPort, type ReadScheduleOccurrence } from '../../src/integration/automation-read-contracts'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'
import { createAutomationReadExecutionLogSchema, resetAutomationReadExecutionLinks } from '../utils/automation-read-execution-schema'

const describeDb = process.env.DATABASE_URL ? describe : describe.skip
const expectDb = process.env.EXPECT_DB === '1' ? it : it.skip
expectDb('EXPECT_DB supplies a database for private date schedule receipts', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
const actor = { actorId: 'synthetic-date-owner', tenantId: 'synthetic-date-tenant', workspaceId: null }
const selector = { ruleId: 'synthetic-date-rule', actionId: 'synthetic-date-action', systemId: 'synthetic-date-system', targetId: 'synthetic-date-target' }
const sheetId = 'synthetic-date-sheet', baseId = 'synthetic-date-base', fieldId = 'synthetic-date-field'
const projectNo = 'SYN-DATE-PROJECT'
const sourceReference = { connectionId: 'synthetic-date-source', connectionIncarnation: randomUUID() }
const budget = { maxRows: 20, maxPages: 2, maxReadCount: 30, timeoutMs: 60000 }
const config = { dateFieldId: fieldId, offsetDays: 0, direction: 'after', timeOfDay: '09:00', timezone: 'UTC' } as const
const manifest = { version: 2003, routes: { [AUTOMATION_READ_EVENT]: [AUTOMATION_READ_CONSUMER] } }
  const signal = () => new AbortController().signal

describeDb('SA06AS date schedule: private occurrence ledger and real field gates', () => {
  const schema = 'automation_read_date_' + randomBytes(8).toString('hex')
  let pool: Pool, admin: PoolClient, db: Kysely<unknown>, created = false
  let ledger: ReturnType<typeof createAutomationReadLedger>
  let beforeQuery: ((statement: string, params?: unknown[]) => Promise<void>) | undefined
  let afterQuery: ((statement: string, params?: unknown[]) => Promise<void>) | undefined
  let projections: Array<{ statement: string; params?: unknown[] }> = []
  let sourceRevision = 'synthetic-date-source-one'
  // SQL/ledger rollback compatibility only; this synthetic switch does not
  // prove the real owner's allowManual boundary or authorize source IO.
  let syntheticManualAuthority = false
  async function requireOwnedSchema() {
    if (!/^automation_read_date_[a-f0-9]{16}$/u.test(schema)
      || (await admin.query('SELECT current_schema() AS owned_schema')).rows[0]?.owned_schema !== schema) {
      throw new Error('UNOWNED_DATE_SCHEDULE_SCHEMA')
    }
  }
  async function transaction<T>(work: (trx: TransactionalQueryable) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const result = await work({ isTransaction: true, async query(statement, params) {
        if (statement.includes('AS date_value')) projections.push({ statement, params })
        await beforeQuery?.(statement, params)
        const result = await client.query(statement, params)
        // Call-through observation only: retain the actual PG receipt. A test
        // can cancel at an already-completed SQL boundary, never fabricate rows.
        await afterQuery?.(statement, params)
        return result
      } })
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  const authority: AutomationReadAuthorityPort = {
    async lockExecution(trx, principal, selected) {
      const rule = (await trx.query('SELECT * FROM automation_rules WHERE id=$1 FOR SHARE NOWAIT', [selected.ruleId])).rows[0]
      if (!rule || rule.created_by !== principal.actorId || principal.tenantId !== actor.tenantId
        || JSON.stringify(selected) !== JSON.stringify(selector) || rule.enabled !== true) {
        throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
      }
      return { ...principal, key: createHash('sha256').update(JSON.stringify([rule.integration_authority_revision, sourceRevision])).digest('hex'),
        budget, sourceReference, allowedTriggers: syntheticManualAuthority ? ['manual'] : ['schedule'] }
    },
    async lockObservation(_trx, principal, reference) {
      if (principal.actorId !== actor.actorId || principal.tenantId !== actor.tenantId
        || reference.connectionId !== sourceReference.connectionId || reference.connectionIncarnation !== sourceReference.connectionIncarnation) {
        throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED')
      }
      return { ...principal, sourceReference: reference }
    },
  }
  const makeLedger = () => createAutomationReadLedger({ transaction, authority, manifest })
  async function input(activationKey = randomUUID()) {
    const revision = (await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [selector.ruleId])).rows[0].integration_authority_revision
    const epoch = (await admin.query("SELECT revision FROM automation_read_material_epochs WHERE kind='sheet' AND scope=$1::jsonb", [JSON.stringify({ id: sheetId })])).rows[0].revision
    return { activationKey, expectedRuleRevision: String(revision), selector, projectNo, budget,
      expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 500,
      expectedDateField: { fieldId, fieldType: 'date' as const, schemaRevision: String(epoch) } }
  }
  const activate = async () => ledger.activateSchedule(actor, await input(), signal())
  async function wake(): Promise<ReadScheduleOccurrence> {
    const scheduledAtMs = Math.floor(Number((await admin.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS ms')).rows[0].ms))
    return { ruleId: selector.ruleId, triggerType: 'schedule.date_field', scheduledAtMs }
  }
  async function dateFacts() {
    const row = (await admin.query(`SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date-1,'YYYY-MM-DD') AS day`)).rows[0]
    return { day: String(row.day), due: String(row.day) + 'T09:00:00.000Z' }
  }
  async function addRecord(recordId = 'synthetic-date-record', day?: string) {
    await admin.query('INSERT INTO meta_records(id,sheet_id,data,version) VALUES ($1,$2,$3::jsonb,1)',
      [recordId, sheetId, JSON.stringify({ [fieldId]: day ?? (await dateFacts()).day, unmapped: 'SYN-PRIVATE-UNMAPPED' })])
  }
  /** Fixture arrangement ONLY: permit a due reminder without a day-long wait.
   * Exact owned row and trigger posture are checked; no runtime clock, source,
   * metadata/ACL, receipt/admission or outbox guard is mocked or disabled. */
  async function elapsed(activationId: string, floor?: string) {
    await requireOwnedSchema()
    const at = floor ?? new Date(Date.parse((await dateFacts()).due) - 1).toISOString()
    await admin.query('ALTER TABLE integration_automation_read_schedule_activations DISABLE TRIGGER automation_read_schedule_activation_immutable')
    try {
      expect((await admin.query('UPDATE integration_automation_read_schedule_activations SET activated_at=$1::timestamptz WHERE id=$2', [at, activationId])).rowCount).toBe(1)
    } finally { await admin.query('ALTER TABLE integration_automation_read_schedule_activations ENABLE TRIGGER automation_read_schedule_activation_immutable') }
    expect((await admin.query(`SELECT tgenabled FROM pg_trigger WHERE tgrelid='integration_automation_read_schedule_activations'::regclass
      AND tgname='automation_read_schedule_activation_immutable'`)).rows).toEqual([{ tgenabled: 'O' }])
  }
  async function counts() {
    return (await admin.query(`SELECT
      (SELECT count(*)::int FROM integration_automation_read_grants) grants,
      (SELECT count(*)::int FROM integration_automation_read_schedule_activations) activations,
      (SELECT count(*)::int FROM integration_automation_read_date_occurrences) receipts,
      (SELECT count(*)::int FROM integration_automation_read_requests) requests,
      (SELECT count(*)::int FROM integration_automation_read_executions) links,
      (SELECT count(*)::int FROM multitable_automation_executions) executions,
      (SELECT count(*)::int FROM meta_automation_outbox) events,
      (SELECT count(*)::int FROM meta_automation_outbox_consumer) deliveries`)).rows[0]
  }
  const empty = { grants: 0, activations: 0, receipts: 0, requests: 0, links: 0, executions: 0, events: 0, deliveries: 0 }
  const consent = { ...empty, grants: 1, activations: 1 }
  const admitted = { ...consent, receipts: 1, requests: 1, links: 1, executions: 1, events: 1, deliveries: 1 }
  async function queued() {
    const pair = await activate(); await elapsed(pair.activationId); await addRecord()
    expect(await ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())).toEqual({ nextCursor: null, scanned: 1, budgetExhausted: false })
    const request = (await admin.query('SELECT id FROM integration_automation_read_requests')).rows[0]
    return { ...pair, requestId: String(request.id) }
  }

  beforeAll(async () => {
    if (!/^automation_read_date_[a-f0-9]{16}$/u.test(schema)) throw new Error('UNOWNED_DATE_SCHEDULE_SCHEMA')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10,
      options: '-c search_path=' + schema + ' -c statement_timeout=8000' })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    admin = await pool.connect()
    await admin.query('CREATE SCHEMA "' + schema + '"'); created = true
    await requireOwnedSchema()
    await admin.query(`CREATE TABLE users(id text PRIMARY KEY,role text,permissions jsonb,is_active boolean,activation_status text);
      CREATE TABLE user_roles(user_id text,role_id text); CREATE TABLE role_permissions(role_id text,permission_code text);
      CREATE TABLE user_permissions(user_id text,permission_code text); CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean);
      CREATE TABLE user_namespace_admissions(user_id text,namespace text,enabled boolean);
      CREATE TABLE platform_member_group_members(user_id text,group_id uuid);
      CREATE TABLE spreadsheet_permissions(sheet_id text,subject_type text,subject_id text,perm_code text);
      CREATE TABLE field_permissions(sheet_id text,field_id text,subject_type text,subject_id text,visible boolean,read_only boolean);
      CREATE TABLE record_permissions(sheet_id text,record_id text,subject_type text,subject_id text,access_level text);
      CREATE TABLE meta_bases(id text PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE meta_sheets(id text PRIMARY KEY,base_id text,deleted_at timestamptz,row_level_read_permissions_enabled boolean NOT NULL DEFAULT false);
      CREATE TABLE meta_fields(id text PRIMARY KEY,sheet_id text,type text,property jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE meta_records(id text PRIMARY KEY,sheet_id text,data jsonb NOT NULL,version int NOT NULL);
      CREATE TABLE plugin_multitable_object_registry(sheet_id text PRIMARY KEY,project_id text,object_id text,plugin_name text);
      CREATE TABLE integration_stock_prep_pack_installs(id text PRIMARY KEY,tenant_id text,project_id text,object_id text);
      CREATE TABLE automation_rules(id text PRIMARY KEY,sheet_id text NOT NULL,name text NOT NULL DEFAULT 'Synthetic date rule',
        created_by text,enabled boolean NOT NULL,trigger_type text NOT NULL,trigger_config jsonb,conditions jsonb,
        action_type text NOT NULL,action_config jsonb NOT NULL,actions jsonb,execution_mode text NOT NULL DEFAULT 'legacy',
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());`)
    await createAutomationReadExecutionLogSchema(admin)
    for (const migration of [addOutbox, addRuleRevision, addLedger, addMaterial, addAudit, addRecordActivation,
      addScheduleActivation, addUpdatedRecordActivation, addRecordConditions, addIntervalSchedule, addRetry, addDateSchedule, addDateRetry]) {
      await db.transaction().execute(migration)
    }
  })
  afterAll(async () => {
    if (admin) {
      await admin.query('ROLLBACK').catch(() => {})
      if (created) { await requireOwnedSchema(); await admin.query('DROP SCHEMA "' + schema + '" CASCADE') }
      admin.release()
    }
    if (db) await db.destroy(); else await pool?.end()
  })
  afterEach(() => { beforeQuery = undefined; afterQuery = undefined })
  beforeEach(async () => {
    beforeQuery = undefined; afterQuery = undefined; projections = []; sourceRevision = 'synthetic-date-source-one'
    syntheticManualAuthority = false
    await requireOwnedSchema()
    const protectedTables = ['integration_automation_read_schedule_activations', 'integration_automation_read_date_occurrences',
      'integration_automation_read_retries']
    const disabled: string[] = []
    try {
      for (const table of protectedTables) { await admin.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER'); disabled.push(table) }
      await resetAutomationReadExecutionLinks(admin, async () => {
        await admin.query(`TRUNCATE integration_automation_read_retries,integration_automation_read_date_occurrences,integration_automation_read_schedule_activations,
          integration_automation_read_record_activations,integration_automation_read_executions,multitable_automation_executions,
          integration_automation_read_requests,integration_automation_read_grants,meta_automation_outbox_consumer,meta_automation_outbox,
          automation_rules,users,user_roles,role_permissions,user_permissions,user_orgs,user_namespace_admissions,
          platform_member_group_members,spreadsheet_permissions,field_permissions,record_permissions,
          meta_records,meta_fields,meta_sheets,meta_bases,plugin_multitable_object_registry,integration_stock_prep_pack_installs`)
      })
    } finally { for (const table of disabled.reverse()) await admin.query('ALTER TABLE ' + table + ' ENABLE TRIGGER USER') }
    await admin.query("INSERT INTO users VALUES ($1,'user','[]',true,'activated')", [actor.actorId])
    await admin.query("INSERT INTO user_roles VALUES ($1,'integration_admin')", [actor.actorId])
    await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
    await admin.query("INSERT INTO user_permissions VALUES ($1,'multitable:read')", [actor.actorId])
    await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', [actor.actorId, actor.tenantId])
    await admin.query("INSERT INTO user_namespace_admissions VALUES ($1,'integration',true)", [actor.actorId])
    await admin.query('INSERT INTO meta_bases(id) VALUES ($1)', [baseId])
    await admin.query('INSERT INTO meta_sheets(id,base_id) VALUES ($1,$2)', [sheetId, baseId])
    await admin.query("INSERT INTO meta_fields(id,sheet_id,type) VALUES ($1,$2,'date')", [fieldId, sheetId])
    await admin.query(`INSERT INTO automation_rules(id,sheet_id,created_by,enabled,trigger_type,trigger_config,conditions,action_type,action_config,created_at)
      VALUES ($1,$2,$3,true,'schedule.date_field',$4::jsonb,NULL,'integration_read_preview',$5::jsonb,clock_timestamp()-interval '3 days')`,
    [selector.ruleId, sheetId, actor.actorId, JSON.stringify(config), JSON.stringify({ operation: AUTOMATION_READ_OPERATION, allowManual: false })])
    ledger = makeLedger()
  })

  const retryCommand = () => ({ retryKey: randomUUID(), budget, expiresAt: '2099-01-01T00:00:00.000Z', acknowledgeNewRead: true as const })
  const preview = { status: 'ready' as const, counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false as const }
  async function retryParent() {
    const pair = await queued()
    await ledger.cancel(actor, pair.requestId)
    return pair
  }
  async function originSnapshot(pair: { grantId: string; requestId: string; activationId: string }) {
    return (await admin.query(`SELECT
      (SELECT to_jsonb(g) FROM integration_automation_read_grants g WHERE id=$1) AS grant,
      (SELECT to_jsonb(q) FROM integration_automation_read_requests q WHERE id=$2) AS request,
      (SELECT to_jsonb(a) FROM integration_automation_read_schedule_activations a WHERE id=$3) AS activation,
      (SELECT to_jsonb(d) FROM integration_automation_read_date_occurrences d WHERE request_id=$2) AS receipt`,
    [pair.grantId, pair.requestId, pair.activationId])).rows[0]
  }
  async function assertSqlGuardsEnabled() {
    expect((await admin.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'O'
      AND tgrelid IN ('integration_automation_read_grants'::regclass,'integration_automation_read_requests'::regclass,
        'integration_automation_read_schedule_activations'::regclass,'integration_automation_read_date_occurrences'::regclass,
        'integration_automation_read_retries'::regclass)`)).rows).toEqual([])
  }
  /** Structural SQL fixture only, not a scheduler/date-value calculation proof.
   * Use the real cutover and a later real PG instant; never call elapsed(), edit
   * captured identities, disable triggers, or bypass receipt admission. */
  async function sqlDateRequest(pair: { activationId: string; grantId: string }) {
    await assertSqlGuardsEnabled()
    await admin.query('SELECT pg_sleep(0.003)')
    const occurrence = String((await admin.query(`SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurrence`)).rows[0].occurrence)
    const requestId = randomUUID(), recordId = 'synthetic-sql-date-' + randomUUID()
    const invocationId = 'date-schedule-read:' + createHash('sha256').update(JSON.stringify([pair.activationId, recordId, occurrence])).digest('hex')
    await transaction(async trx => {
      await trx.query(`INSERT INTO integration_automation_read_requests(id,grant_id,tenant_id,owner_id,invocation_id,project_no,trigger_type)
        VALUES ($1,$2,$3,$4,$5,$6,'schedule')`, [requestId, pair.grantId, actor.tenantId, actor.actorId, invocationId, projectNo])
      await trx.query(`INSERT INTO integration_automation_read_date_occurrences
        (request_id,activation_id,grant_id,tenant_id,owner_id,record_id,occurrence_at,occurrence_at_utc,invocation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7::text::timestamptz,$7::text,$8)`,
      [requestId, pair.activationId, pair.grantId, actor.tenantId, actor.actorId, recordId, occurrence, invocationId])
    })
    await ledger.cancel(actor, requestId)
    return requestId
  }
  async function sqlDateParent(expiresAt = '2099-01-01T00:00:00.000Z') {
    const pair = await ledger.activateSchedule(actor, { ...await input(), expiresAt }, signal())
    return { ...pair, requestId: await sqlDateRequest(pair) }
  }
  async function sqlRetryChild(trx: TransactionalQueryable, parentId: string) {
    const grantId = randomUUID(), requestId = randomUUID()
    expect((await trx.query(`INSERT INTO integration_automation_read_grants
      (id,tenant_id,owner_id,selector,source_reference,authority_key,projects,triggers,budget,expires_at,max_executions,purpose)
      SELECT $1,p.tenant_id,p.owner_id,g.selector,g.source_reference,g.authority_key,ARRAY[p.project_no],ARRAY['schedule'],
        g.budget,'2099-01-01T00:00:00.000Z'::timestamptz,1,'retry'
      FROM integration_automation_read_requests p JOIN integration_automation_read_grants g ON g.id=p.grant_id WHERE p.id=$2
      RETURNING id`, [grantId, parentId])).rows).toEqual([{ id: grantId }])
    expect((await trx.query(`INSERT INTO integration_automation_read_requests
      (id,grant_id,tenant_id,owner_id,invocation_id,project_no,trigger_type)
      SELECT $1,$2,tenant_id,owner_id,$3,project_no,'schedule' FROM integration_automation_read_requests WHERE id=$4 RETURNING id`,
    [requestId, grantId, 'retry-read:' + randomBytes(32).toString('hex'), parentId])).rows).toEqual([{ id: requestId }])
    return { grantId, requestId }
  }
  async function sqlRetryLink(trx: TransactionalQueryable, child: { requestId: string; grantId: string },
    parentId: string, dateParentId = parentId, tenantId = actor.tenantId) {
    return trx.query(`INSERT INTO integration_automation_read_retries
      (request_id,grant_id,parent_request_id,tenant_id,owner_id,retry_key,acknowledge_new_read,date_parent_request_id)
      VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING request_id`,
    [child.requestId, child.grantId, parentId, tenantId, actor.actorId, randomUUID(), dateParentId])
  }
  it('date retry preserves its original receipt and exhausted revoked grant while consuming only one new schedule budget', async () => {
    const pair = await queued()
    expect(await ledger.claim(pair.requestId)).toMatchObject({ status: 'running' })
    await ledger.cancel(actor, pair.requestId)
    // Synthetic prior-use fixture; no captured identity or receipt is edited.
    await admin.query('UPDATE integration_automation_read_grants SET used_executions=max_executions WHERE id=$1', [pair.grantId])
    await ledger.revoke(actor, pair.grantId)
    const before = await originSnapshot(pair), scans = projections.length
    await admin.query("UPDATE meta_records SET data=jsonb_build_object($1::text,'2098-01-01')", [fieldId])
    const business = (await admin.query('SELECT * FROM meta_records ORDER BY id')).rows
    const child = await ledger.retry(actor, pair.requestId, retryCommand(), signal())
    expect(child).toMatchObject({ parentRequestId: pair.requestId, status: 'queued' })
    expect(await ledger.grantDetail(actor, child.grantId)).toMatchObject({ purpose: 'retry', triggers: ['schedule'],
      projects: [projectNo], maxExecutions: 1, usedExecutions: 0 })
    expect(await ledger.retryContext(actor, child.requestId)).toMatchObject({ request: { trigger: 'schedule' },
      dateScheduleOrigin: { definition: { triggerType: 'schedule.date_field', config }, ruleRevision: expect.any(String) } })
    const atomic = (await admin.query(`SELECT g.xmin::text AS grant,q.xmin::text AS request,l.xmin::text AS link,
        e.xmin::text AS audit,o.xmin::text AS event
      FROM integration_automation_read_retries l JOIN integration_automation_read_grants g ON g.id=l.grant_id
      JOIN integration_automation_read_requests q ON q.id=l.request_id
      JOIN integration_automation_read_executions e ON e.request_id=q.id
      JOIN meta_automation_outbox o ON o.payload->>'requestId'=q.id::text WHERE l.request_id=$1`, [child.requestId])).rows
    expect(atomic).toHaveLength(1); expect(new Set(Object.values(atomic[0])).size).toBe(1)
    const claim = await ledger.claim(child.requestId)
    if (!('fence' in claim)) throw new Error('DATE_RETRY_CLAIM_MISSING')
    const execution = { requestId: child.requestId, fence: claim.fence }
    expect(await ledger.checkpoint(execution)).toMatchObject({ projectNo, authorityMode: 'execution' })
    expect(await ledger.complete({ ...execution, result: preview })).toMatchObject({ status: 'succeeded' })
    expect(await ledger.claim(child.requestId)).toMatchObject({ status: 'succeeded' })
    expect(await originSnapshot(pair)).toEqual(before)
    expect(await ledger.grantDetail(actor, child.grantId)).toMatchObject({ usedExecutions: 1 })
    expect(await counts()).toEqual({ ...admitted, grants: 2, requests: 2, links: 2, executions: 2, events: 2, deliveries: 2 })
    expect((await admin.query('SELECT * FROM meta_records ORDER BY id')).rows).toEqual(business)
    expect(projections).toHaveLength(scans)
  })
  it.each(['blocked', 'failed', 'cancelled', 'outcome_unknown'])('date retry accepts only a terminal %s parent with a real persisted date receipt', async status => {
    const pair = await retryParent()
    // Arrange terminal outcomes; this suite tests ledger admission, not the source worker producing them.
    await admin.query('UPDATE integration_automation_read_requests SET status=$2 WHERE id=$1', [pair.requestId, status])
    const before = await originSnapshot(pair)
    expect(await ledger.retry(actor, pair.requestId, retryCommand(), signal())).toMatchObject({ status: 'queued' })
    expect(await originSnapshot(pair)).toEqual(before)
  })
  it.each(['queued', 'running', 'succeeded'])('date retry refuses a %s parent without creating a budget', async status => {
    const pair = await queued()
    if (status !== 'queued') {
      const claim = await ledger.claim(pair.requestId)
      if (!('fence' in claim)) throw new Error('DATE_PARENT_CLAIM_MISSING')
      if (status === 'succeeded') await ledger.complete({ requestId: pair.requestId, fence: claim.fence, result: preview })
    }
    const before = await counts()
    await expect(ledger.retry(actor, pair.requestId, retryCommand(), signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    expect(await counts()).toEqual(before)
  })
  it('date retry restores only the same attempt after authority changes, forbids another key and does not extend a child', async () => {
    const pair = await retryParent(), command = retryCommand()
    const child = await ledger.retry(actor, pair.requestId, command, signal()), before = await counts()
    await expect(ledger.retry(actor, pair.requestId, retryCommand(), signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_IDEMPOTENCY_CONFLICT' })
    await expect(ledger.retry(actor, pair.requestId, { ...command, budget: { ...budget, maxRows: 1 } }, signal()))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_IDEMPOTENCY_CONFLICT' })
    await ledger.cancel(actor, child.requestId)
    await expect(ledger.retry(actor, child.requestId, retryCommand(), signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    await expect(ledger.submit(actor, { grantId: child.grantId, invocationId: 'synthetic-extra', projectNo, trigger: 'schedule' }))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    sourceRevision = 'synthetic-date-source-changed'
    expect(await ledger.retry(actor, pair.requestId, command, signal())).toEqual({ ...child, status: 'cancelled' })
    expect(await counts()).toEqual(before)
  })
  const drifts = ['source', 'rule', 'schema', 'field', 'permission', 'owner'] as const
  for (const boundary of ['admission', 'claim', 'checkpoint', 'publication'] as const) {
    it.each(drifts)(`date retry rechecks %s at ${boundary} without rescanning date values`, async drift => {
      const pair = await retryParent(), command = retryCommand()
      const child = boundary === 'admission' ? null : await ledger.retry(actor, pair.requestId, command, signal())
      const claim = child && (boundary === 'checkpoint' || boundary === 'publication') ? await ledger.claim(child.requestId) : null
      const scans = projections.length, before = await counts()
      if (drift === 'source') sourceRevision = 'synthetic-date-source-changed'
      if (drift === 'rule') await admin.query("UPDATE automation_rules SET trigger_config=trigger_config||'{\"offsetDays\":1}'::jsonb WHERE id=$1", [selector.ruleId])
      if (drift === 'schema') await admin.query("UPDATE meta_fields SET property='{\"synthetic\":true}'::jsonb WHERE id=$1", [fieldId])
      if (drift === 'field') await admin.query("UPDATE meta_fields SET type='dateTime' WHERE id=$1", [fieldId])
      if (drift === 'permission') await admin.query('DELETE FROM user_roles WHERE user_id=$1', [actor.actorId])
      if (drift === 'owner') await admin.query('UPDATE automation_rules SET created_by=$1 WHERE id=$2', ['synthetic-other', selector.ruleId])
      const work = () => {
        if (boundary === 'admission') return ledger.retry(actor, pair.requestId, command, signal())
        if (!child) throw new Error('DATE_RETRY_CHILD_MISSING')
        if (boundary === 'claim') return ledger.claim(child.requestId)
        if (!claim || !('fence' in claim) || typeof claim.fence !== 'string') throw new Error('DATE_RETRY_FENCE_MISSING')
        const execution = { requestId: child.requestId, fence: claim.fence }
        return boundary === 'checkpoint' ? ledger.checkpoint(execution) : ledger.complete({ ...execution, result: preview })
      }
      if (drift === 'permission') await expect(work()).rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_AUTHORITY_DENIED' })
      else await expect(work()).rejects.toBeInstanceOf(AutomationReadLedgerError)
      expect(await counts()).toEqual(before); expect(projections).toHaveLength(scans)
      if (child) expect((await admin.query('SELECT status FROM integration_automation_read_requests WHERE id=$1', [child.requestId])).rows[0].status)
        .toBe(boundary === 'claim' ? 'queued' : 'running')
    })
  }
  it('date retry history prevents down and SQL rewriting of its scope/receipt identity', async () => {
    const pair = await retryParent(), child = await ledger.retry(actor, pair.requestId, retryCommand(), signal())
    await expect(admin.query('UPDATE integration_automation_read_retries SET date_parent_request_id=NULL WHERE request_id=$1', [child.requestId]))
      .rejects.toMatchObject({ code: '55000' })
    await expect(admin.query('UPDATE integration_automation_read_grants SET triggers=ARRAY[\'manual\'] WHERE id=$1', [child.grantId]))
      .rejects.toMatchObject({ code: '55000' })
    await expect(db.transaction().execute(removeDateRetry)).rejects.toMatchObject({ code: '55000' })
    expect((await admin.query('SELECT date_parent_request_id FROM integration_automation_read_retries WHERE request_id=$1', [child.requestId])).rows)
      .toEqual([{ date_parent_request_id: pair.requestId }])
  })
  it('date retry worker validates immutable ancestors without acquiring their UPDATE locks', async () => {
    const pair = await retryParent(), child = await ledger.retry(actor, pair.requestId, retryCommand(), signal())
    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM integration_automation_read_grants WHERE id=$1 FOR UPDATE', [pair.grantId])
      await holder.query('SELECT id FROM integration_automation_read_requests WHERE id=$1 FOR UPDATE', [pair.requestId])
      const claim = await ledger.claim(child.requestId)
      if (!('fence' in claim)) throw new Error('DATE_RETRY_CLAIM_MISSING')
      const execution = { requestId: child.requestId, fence: claim.fence }
      await ledger.checkpoint(execution)
      expect(await ledger.complete({ ...execution, result: preview })).toMatchObject({ status: 'succeeded' })
    } finally { await holder.query('ROLLBACK'); holder.release() }
  })
  it('date retry cancellation and pre-aborted consent do not replenish quota or leave partial admission', async () => {
    const pair = await retryParent(), before = await counts(), controller = new AbortController()
    controller.abort()
    await expect(ledger.retry(actor, pair.requestId, retryCommand(), controller.signal)).rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    expect(await counts()).toEqual(before)
    const child = await ledger.retry(actor, pair.requestId, retryCommand(), signal()), claim = await ledger.claim(child.requestId)
    if (!('fence' in claim)) throw new Error('DATE_RETRY_CLAIM_MISSING')
    await ledger.cancel(actor, child.requestId)
    const execution = { requestId: child.requestId, fence: claim.fence }
    await expect(ledger.checkpoint(execution)).rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    await expect(ledger.complete({ ...execution, result: preview })).rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    expect(await ledger.grantDetail(actor, child.grantId)).toMatchObject({ usedExecutions: 1 })
  })

  it('SQL date retry admission positive control commits with every receipt and association guard enabled', async () => {
    const pair = await sqlDateParent(), before = await counts(), origin = await originSnapshot(pair)
    const child = await transaction(async trx => {
      const created = await sqlRetryChild(trx, pair.requestId)
      expect((await sqlRetryLink(trx, created, pair.requestId)).rows).toEqual([{ request_id: created.requestId }])
      return created
    })
    expect((await admin.query('SELECT date_parent_request_id FROM integration_automation_read_retries WHERE request_id=$1',
      [child.requestId])).rows).toEqual([{ date_parent_request_id: pair.requestId }])
    expect(await counts()).toEqual({ ...before, grants: before.grants + 1, requests: before.requests + 1 })
    expect(await originSnapshot(pair)).toEqual(origin)
    await assertSqlGuardsEnabled()
  })

  it.each(['wrong-pointer', 'wrong-scope', 'missing-receipt'] as const)(
    'SQL date retry admission rejects %s before COMMIT without disabling any guard', async invalid => {
      const pair = await sqlDateParent()
      const otherReceipt = invalid === 'wrong-pointer' ? await sqlDateRequest(pair) : pair.requestId
      const before = await counts(), origin = await originSnapshot(pair)
      let reachedLink = false, linkAccepted = false
      await expect(transaction(async trx => {
        let parentId = pair.requestId
        if (invalid === 'missing-receipt') {
          // A pending automatic-date parent lacking its receipt must already
          // fail link admission, not merely the later 143000 COMMIT guard.
          parentId = randomUUID()
          await trx.query(`INSERT INTO integration_automation_read_requests
            (id,grant_id,tenant_id,owner_id,invocation_id,project_no,trigger_type,status,finished_at)
            VALUES ($1,$2,$3,$4,$5,$6,'schedule','cancelled',clock_timestamp())`,
          [parentId, pair.grantId, actor.tenantId, actor.actorId, 'date-schedule-read:' + randomBytes(32).toString('hex'), projectNo])
        }
        const child = await sqlRetryChild(trx, parentId)
        reachedLink = true
        await sqlRetryLink(trx, child, parentId, invalid === 'wrong-pointer' ? otherReceipt : parentId,
          invalid === 'wrong-scope' ? 'synthetic-date-other-tenant' : actor.tenantId)
        linkAccepted = true
      })).rejects.toMatchObject({ code: '23514', message: 'AUTOMATION_READ_RETRY_LINK_DENIED' })
      expect(reachedLink).toBe(true); expect(linkAccepted).toBe(false)
      expect(await counts()).toEqual(before); expect(await originSnapshot(pair)).toEqual(origin)
      expect((await admin.query('SELECT request_id FROM integration_automation_read_retries')).rows).toEqual([])
      await assertSqlGuardsEnabled()
    },
  )

  it('an extra unlinked SQL request under a date retry grant is rejected at COMMIT', async () => {
    const pair = await sqlDateParent(), child = await ledger.retry(actor, pair.requestId, retryCommand(), signal())
    const before = await counts(), extraId = randomUUID()
    let inserted = false
    await expect(transaction(async trx => {
      expect((await trx.query(`INSERT INTO integration_automation_read_requests
        (id,grant_id,tenant_id,owner_id,invocation_id,project_no,trigger_type)
        SELECT $1,grant_id,tenant_id,owner_id,$2,project_no,trigger_type FROM integration_automation_read_requests WHERE id=$3 RETURNING id`,
      [extraId, 'retry-read:' + randomBytes(32).toString('hex'), child.requestId])).rows).toEqual([{ id: extraId }])
      inserted = true
    })).rejects.toMatchObject({ code: '23514', message: 'AUTOMATION_READ_RETRY_LINK_REQUIRED' })
    expect(inserted).toBe(true)
    expect(await counts()).toEqual(before)
    expect((await admin.query('SELECT id FROM integration_automation_read_requests WHERE id=$1', [extraId])).rows).toEqual([])
    expect(await ledger.observe(actor, child.requestId)).toMatchObject({ status: 'queued' })
    await assertSqlGuardsEnabled()
  })

  it('144000 rollback retains manual retry history and the restored ledger can create and consume its next single attempt', async () => {
    // Explicit synthetic authority only: this is SQL/ledger compatibility, not
    // proof that a real allowManual=false rule permits a manual owner action.
    syntheticManualAuthority = true
    const original = await ledger.grant(actor, { selector, projects: [projectNo], triggers: ['manual'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 1 })
    const parent = await ledger.submit(actor, { grantId: original.grantId, invocationId: 'synthetic-manual-parent', projectNo, trigger: 'manual' })
    await ledger.cancel(actor, parent.requestId)
    const child = await ledger.retry(actor, parent.requestId, retryCommand(), signal())
    await ledger.cancel(actor, child.requestId)
    const history = async () => (await admin.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM integration_automation_read_grants g WHERE id=ANY($1::uuid[])) AS grants,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM integration_automation_read_requests r WHERE id=ANY($2::uuid[])) AS requests,
      (SELECT to_jsonb(l)-'date_parent_request_id' FROM integration_automation_read_retries l WHERE request_id=$3) AS link`,
    [[original.grantId, child.grantId], [parent.requestId, child.requestId], child.requestId])).rows[0]
    const before = await history(), baseline = await counts(), command = retryCommand()
    await db.transaction().execute(removeDateRetry)
    try {
      expect((await admin.query(`SELECT attname FROM pg_attribute WHERE attrelid='integration_automation_read_retries'::regclass
        AND attname='date_parent_request_id' AND NOT attisdropped`)).rows).toEqual([])
      expect(await history()).toEqual(before)
      const next = await ledger.retry(actor, child.requestId, command, signal())
      expect(await ledger.grantDetail(actor, next.grantId)).toMatchObject({ purpose: 'retry', triggers: ['manual'], maxExecutions: 1, usedExecutions: 0 })
      const claim = await ledger.claim(next.requestId)
      if (!('fence' in claim)) throw new Error('MANUAL_ROLLBACK_CLAIM_MISSING')
      const execution = { requestId: next.requestId, fence: claim.fence }
      await ledger.checkpoint(execution)
      expect(await ledger.complete({ ...execution, result: preview })).toMatchObject({ status: 'succeeded' })
      expect(await ledger.claim(next.requestId)).toMatchObject({ status: 'succeeded' })
      expect(await ledger.grantDetail(actor, next.grantId)).toMatchObject({ usedExecutions: 1 })
      expect(await history()).toEqual(before)
      expect(await counts()).toEqual({ ...baseline, grants: baseline.grants + 1, requests: baseline.requests + 1,
        links: baseline.links + 1, executions: baseline.executions + 1, events: baseline.events + 1, deliveries: baseline.deliveries + 1 })
    } finally { await db.transaction().execute(addDateRetry) }
    expect(await history()).toEqual(before)
    expect((await admin.query('SELECT date_parent_request_id FROM integration_automation_read_retries')).rows)
      .toEqual([{ date_parent_request_id: null }, { date_parent_request_id: null }])
    expect(await ledger.retry(actor, child.requestId, command, signal())).toMatchObject({ status: 'succeeded' })
    await assertSqlGuardsEnabled()
  })

  it('a date parent grant expires on the real DB clock without preventing a separate new retry budget', async () => {
    const expiresAt = new Date((await admin.query("SELECT clock_timestamp()+interval '2 seconds' AS expires_at")).rows[0].expires_at).toISOString()
    const pair = await sqlDateParent(expiresAt), before = await originSnapshot(pair)
    await admin.query(`SELECT pg_sleep(GREATEST(0,extract(epoch FROM expires_at-clock_timestamp()))+0.01)
      FROM integration_automation_read_grants WHERE id=$1`, [pair.grantId])
    expect((await admin.query(`SELECT status,expires_at<=clock_timestamp() AS expired,used_executions
      FROM integration_automation_read_grants WHERE id=$1`, [pair.grantId])).rows).toEqual([{ status: 'active', expired: true, used_executions: 0 }])
    const child = await ledger.retry(actor, pair.requestId, retryCommand(), signal())
    const claim = await ledger.claim(child.requestId)
    if (!('fence' in claim)) throw new Error('EXPIRED_PARENT_RETRY_CLAIM_MISSING')
    await ledger.checkpoint({ requestId: child.requestId, fence: claim.fence })
    expect(await ledger.grantDetail(actor, child.grantId)).toMatchObject({ triggers: ['schedule'], usedExecutions: 1 })
    expect(await originSnapshot(pair)).toEqual(before)
    expect(projections).toEqual([])
    await assertSqlGuardsEnabled()
  })

  it('requires explicit exact date confirmation and exact replay preserves the DB minted consent', async () => {
    const original = await input()
    const missing = { activationKey: original.activationKey, expectedRuleRevision: original.expectedRuleRevision,
      selector: original.selector, projectNo: original.projectNo, budget: original.budget,
      expiresAt: original.expiresAt, maxExecutions: original.maxExecutions }
    await expect(ledger.activateSchedule(actor, missing, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    await expect(ledger.activateSchedule(actor, { ...original, expectedDateField: { ...original.expectedDateField, schemaRevision: randomUUID() } }, signal()))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    expect(await counts()).toEqual(empty)
    const pair = await ledger.activateSchedule(actor, original, signal())
    const stored = (await admin.query('SELECT * FROM integration_automation_read_schedule_activations')).rows[0]
    expect(stored.date_field_confirmation).toEqual(original.expectedDateField)
    expect(stored.interval_anchor_ms).toBeNull()
    expect(await makeLedger().activateSchedule(actor, original, signal())).toEqual(pair)
    expect((await admin.query('SELECT * FROM integration_automation_read_schedule_activations')).rows[0]).toEqual(stored)
    await expect(ledger.activateSchedule(actor, { ...original, expectedDateField: { ...original.expectedDateField, fieldType: 'dateTime' } }, signal()))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_IDEMPOTENCY_CONFLICT' })
    expect(await counts()).toEqual(consent)
  })

  it('admits one UTC due receipt atomically with request/audit/outbox and new wakes reuse the business identity', async () => {
    const pair = await queued(), due = (await dateFacts()).due
    const rows = (await admin.query(`SELECT o.*,r.xmin::text AS request_xid,o.xmin::text AS receipt_xid,
      e.xmin::text AS link_xid,a.xmin::text AS execution_xid,b.xmin::text AS event_xid,c.xmin::text AS delivery_xid,b.payload
      FROM integration_automation_read_date_occurrences o JOIN integration_automation_read_requests r ON r.id=o.request_id
      JOIN integration_automation_read_executions e ON e.request_id=r.id JOIN multitable_automation_executions a ON a.id=e.execution_id
      JOIN meta_automation_outbox b ON b.id=r.outbox_id JOIN meta_automation_outbox_consumer c ON c.outbox_id=b.id`)).rows
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.record_id).toBe('synthetic-date-record'); expect(row.activation_id).toBe(pair.activationId)
    expect(row.occurrence_at_utc).toBe(due); expect(new Date(row.occurrence_at).toISOString()).toBe(due)
    expect(row.invocation_id).toBe('date-schedule-read:' + createHash('sha256').update(JSON.stringify([pair.activationId, row.record_id, due])).digest('hex'))
    expect(row.payload).toEqual({ requestId: pair.requestId })
    expect(new Set([row.request_xid, row.receipt_xid, row.link_xid, row.execution_xid, row.event_xid, row.delivery_xid]).size).toBe(1)
    expect(await makeLedger().submitDateSchedulePage(pair.activationId, await wake(), {}, signal())).toEqual({ nextCursor: null, scanned: 1, budgetExhausted: false })
    expect(await counts()).toEqual(admitted)
    expect((await admin.query('SELECT xmin::text AS xid FROM integration_automation_read_date_occurrences')).rows[0].xid).toBe(row.receipt_xid)
  })

  it('queued execution rechecks current metadata but never rereads or reinterprets a changed record date', async () => {
    const pair = await queued()
    await admin.query('UPDATE meta_records SET data=$1::jsonb,version=version+1', [JSON.stringify({ [fieldId]: 'not-a-date' })])
    projections = []
    const claim = await makeLedger().claim(pair.requestId)
    expect(claim.status).toBe('running')
    if (!('fence' in claim)) throw new Error('SYNTHETIC_DATE_CLAIM_MISSING')
    expect((await ledger.checkpoint({ requestId: pair.requestId, fence: claim.fence })).projectNo).toBe(projectNo)
    expect(projections).toEqual([])
    expect((await admin.query('SELECT occurrence_at_utc FROM integration_automation_read_date_occurrences')).rows).toEqual([{ occurrence_at_utc: (await dateFacts()).due }])
  })

  it('native dateTime requires explicit offsets and same-civil-day edits retain the UTC due identity', async () => {
    await admin.query("UPDATE meta_fields SET type='dateTime' WHERE id=$1", [fieldId])
    const original = await input()
    const pair = await ledger.activateSchedule(actor, { ...original,
      expectedDateField: { ...original.expectedDateField, fieldType: 'dateTime' } }, signal())
    await elapsed(pair.activationId)
    const { day, due } = await dateFacts()
    await addRecord('synthetic-date-valid', day + 'T12:30:00+02:00')
    await addRecord('synthetic-date-bare', day)
    await addRecord('synthetic-date-local', day + 'T12:30:00')
    expect(await ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal()))
      .toEqual({ nextCursor: null, scanned: 3, budgetExhausted: false })
    expect((await admin.query('SELECT record_id,occurrence_at_utc FROM integration_automation_read_date_occurrences')).rows)
      .toEqual([{ record_id: 'synthetic-date-valid', occurrence_at_utc: due }])
    await admin.query('UPDATE meta_records SET data=$1::jsonb,version=version+1 WHERE id=$2',
      [JSON.stringify({ [fieldId]: day + 'T18:59:00Z' }), 'synthetic-date-valid'])
    await ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())
    expect(await counts()).toEqual(admitted)
  })

  it('real hidden-field and full-read restrictions reject before projecting a date, including queued claim', async () => {
    const pair = await queued()
    await admin.query("INSERT INTO field_permissions VALUES ($1,$2,'user',$3,false,false)", [sheetId, fieldId, actor.actorId])
    projections = []
    await expect(ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    await expect(ledger.claim(pair.requestId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_DENIED' })
    expect(projections).toEqual([]); expect(await counts()).toEqual(admitted)
    await admin.query('DELETE FROM field_permissions')
    await admin.query('UPDATE meta_sheets SET row_level_read_permissions_enabled=true')
    await expect(ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())).rejects.toBeDefined()
    expect(projections).toEqual([])
  })

  it('type/schema ABA and source authority changes reject without a date projection or new receipt', async () => {
    const original = await input(), pair = await ledger.activateSchedule(actor, original, signal())
    await elapsed(pair.activationId); await addRecord()
    sourceRevision = 'synthetic-date-source-two'
    await expect(ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    sourceRevision = 'synthetic-date-source-one'
    await admin.query("UPDATE meta_fields SET type='text' WHERE id=$1", [fieldId])
    await admin.query("UPDATE meta_fields SET type='date' WHERE id=$1", [fieldId])
    await expect(ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
    expect(projections).toEqual([]); expect(await counts()).toEqual(consent)
    // Historical observation is not upgraded to the current schema nor execution.
    expect(await ledger.activateSchedule(actor, original, signal())).toEqual(pair)
    await expect(ledger.activateSchedule(actor, { ...original, activationKey: randomUUID() }, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_SCOPE_CHANGED' })
  })

  it('real row NOWAIT conflict fails closed and releases all effects for the page', async () => {
    const pair = await activate(); await elapsed(pair.activationId); await addRecord()
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM meta_records WHERE sheet_id=$1 FOR UPDATE', [sheetId])
      await expect(ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
      expect(await counts()).toEqual(consent)
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    expect(await ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())).toEqual({ nextCursor: null, scanned: 1, budgetExhausted: false })
    expect(await counts()).toEqual(admitted)
  })

  it('100-value keyset page plus ID-only lookahead admits 101 records in two independent transactions', async () => {
    const pair = await activate(); await elapsed(pair.activationId)
    const day = (await dateFacts()).day
    await admin.query(`INSERT INTO meta_records(id,sheet_id,data,version)
      SELECT 'synthetic-date-record-'||lpad(n::text,3,'0'),$1,jsonb_build_object($2::text,$3::text),1 FROM generate_series(0,100) n`, [sheetId, fieldId, day])
    const originalWake = await wake()
    expect(await ledger.submitDateSchedulePage(pair.activationId, originalWake, {}, signal())).toEqual({ nextCursor: 'synthetic-date-record-099', scanned: 100, budgetExhausted: false })
    expect((await counts()).receipts).toBe(100)
    expect(await ledger.submitDateSchedulePage(pair.activationId, originalWake, { afterId: 'synthetic-date-record-099' }, signal())).toEqual({ nextCursor: null, scanned: 1, budgetExhausted: false })
    expect((await counts()).receipts).toBe(101)
    expect(projections).toHaveLength(2)
    expect(projections.every(row => row.params?.[5] === 100 && !row.statement.includes('SELECT *'))).toBe(true)
    expect((await admin.query('SELECT count(DISTINCT xmin::text)::int AS pages FROM integration_automation_read_date_occurrences')).rows).toEqual([{ pages: 2 }])
  }, 60000)

  it('receipt storage failure rolls back request, both audit writes, event and delivery together', async () => {
    const pair = await activate(); await elapsed(pair.activationId); await addRecord()
    beforeQuery = async statement => { if (statement.includes('INSERT INTO integration_automation_read_date_occurrences')) throw new Error('SYNTHETIC_DATE_RECEIPT_FAILURE') }
    await expect(ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(await counts()).toEqual(consent)
    beforeQuery = undefined
    expect(await ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())).toEqual({ nextCursor: null, scanned: 1, budgetExhausted: false })
  })

  it('concurrent same activation and wake produce one request/receipt/outbox and replay preserves that receipt', async () => {
    const pair = await activate(); await elapsed(pair.activationId); await addRecord()
    const originalWake = await wake()
    const results = await Promise.allSettled(Array.from({ length: 3 }, () =>
      makeLedger().submitDateSchedulePage(pair.activationId, originalWake, {}, signal())))
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    expect(fulfilled.length).toBeGreaterThan(0)
    for (const result of results) {
      if (result.status === 'fulfilled') expect(result.value).toEqual({ nextCursor: null, scanned: 1, budgetExhausted: false })
      else {
        expect(result.reason).toBeInstanceOf(AutomationReadLedgerError)
        expect(result.reason).toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
      }
    }
    expect(await counts()).toEqual(admitted)
    const originalReceipt = (await admin.query('SELECT *,xmin::text AS receipt_xid FROM integration_automation_read_date_occurrences')).rows
    expect(originalReceipt).toHaveLength(1)
    expect(await makeLedger().submitDateSchedulePage(pair.activationId, originalWake, {}, signal()))
      .toEqual({ nextCursor: null, scanned: 1, budgetExhausted: false })
    expect(await counts()).toEqual(admitted)
    expect((await admin.query('SELECT *,xmin::text AS receipt_xid FROM integration_automation_read_date_occurrences')).rows).toEqual(originalReceipt)
  })

  it('signal abort after an actual first receipt rolls back the whole page and stops subsequent SQL/date reads', async () => {
    const pair = await activate(); await elapsed(pair.activationId)
    await addRecord('synthetic-date-record-a'); await addRecord('synthetic-date-record-b')
    const controller = new AbortController(), completedSql: string[] = []
    let abortedAfterActualReceipt = false, completedAtAbort = 0
    afterQuery = async statement => {
      completedSql.push(statement)
      if (statement.includes('INSERT INTO integration_automation_read_date_occurrences')) {
        // The original client.query has resolved: this receipt and its earlier
        // request/audit/outbox effects are real, still uncommitted PG writes.
        abortedAfterActualReceipt = true
        completedAtAbort = completedSql.length
        controller.abort()
      }
    }
    await expect(ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, controller.signal))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    expect(abortedAfterActualReceipt).toBe(true)
    for (const table of ['integration_automation_read_requests', 'integration_automation_read_executions',
      'multitable_automation_executions', 'meta_automation_outbox', 'meta_automation_outbox_consumer',
      'integration_automation_read_date_occurrences']) {
      expect(completedSql.filter(statement => new RegExp('INSERT INTO ' + table + '\\b').test(statement))).toHaveLength(1)
    }
    expect(completedSql).toHaveLength(completedAtAbort)
    expect(projections).toHaveLength(1)
    expect(await counts()).toEqual(consent)
    const readsAtAbort = projections.length
    await expect(ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, controller.signal))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    expect(projections).toHaveLength(readsAtAbort)
    expect(completedSql).toHaveLength(completedAtAbort)
    afterQuery = undefined
    expect(await ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal()))
      .toEqual({ nextCursor: null, scanned: 2, budgetExhausted: false })
    expect(await counts()).toEqual({ ...consent, receipts: 2, requests: 2, links: 2, executions: 2, events: 2, deliveries: 2 })
  })

  it('deferred date request association, immutable identities and migration history guard are enforced by PG', async () => {
    const pair = await activate()
    await expect(transaction(async trx => {
      await trx.query(`INSERT INTO integration_automation_read_requests(id,grant_id,tenant_id,workspace_id,owner_id,invocation_id,project_no,trigger_type)
        VALUES ($1,$2,$3,NULL,$4,$5,$6,'schedule')`, [randomUUID(), pair.grantId, actor.tenantId, actor.actorId, 'date-schedule-read:' + 'a'.repeat(64), projectNo])
    })).rejects.toMatchObject({ code: '23514', message: 'AUTOMATION_READ_DATE_OCCURRENCE_REQUIRED' })
    expect(await counts()).toEqual(consent)
    await elapsed(pair.activationId); await addRecord()
    await ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())
    for (const statement of [
      'UPDATE integration_automation_read_date_occurrences SET record_id=record_id',
      'DELETE FROM integration_automation_read_date_occurrences',
      'TRUNCATE integration_automation_read_date_occurrences,integration_automation_read_retries',
      "UPDATE integration_automation_read_requests SET invocation_id='date-schedule-read:'||repeat('b',64)",
      "UPDATE integration_automation_read_grants SET projects=ARRAY['SYN-OTHER-PROJECT']",
    ]) await expect(admin.query(statement)).rejects.toMatchObject({ code: '55000' })
    await expect(db.transaction().execute(removeDateSchedule)).rejects.toMatchObject({ code: '55000', message: 'AUTOMATION_READ_DATE_SCHEDULE_HAS_HISTORY' })
    expect(await counts()).toEqual(admitted)
  })

  it('untouched DB cutover excludes earlier due and ordinary schedule submission cannot treat a wake as date occurrence', async () => {
    const pair = await activate(); await addRecord()
    expect(await ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())).toEqual({ nextCursor: null, scanned: 1, budgetExhausted: false })
    await expect(ledger.submitSchedule(pair.activationId, await wake(), signal())).rejects.toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID' })
    const due = (await dateFacts()).due
    await elapsed(pair.activationId)
    expect(await ledger.submitDateSchedulePage(pair.activationId,
      { ruleId: selector.ruleId, triggerType: 'schedule.date_field', scheduledAtMs: Date.parse(due) - 1 }, {}, signal()))
      .toEqual({ nextCursor: null, scanned: 1, budgetExhausted: false })
    expect(await counts()).toEqual(consent) // Stable wake upper bound, despite later real DB now.
    await elapsed(pair.activationId, due.slice(0, -1) + '001Z') // due + one microsecond, not driver rounding.
    expect(await ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())).toEqual({ nextCursor: null, scanned: 1, budgetExhausted: false })
    expect(await counts()).toEqual(consent)
    await elapsed(pair.activationId)
    await ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal())
    expect(await counts()).toEqual(admitted)
  })

  it('two due records with quota one preserve the first request and explicitly stop on budget exhaustion', async () => {
    const pair = await ledger.activateSchedule(actor, { ...await input(), maxExecutions: 1 }, signal())
    await elapsed(pair.activationId); await addRecord('synthetic-date-record-a'); await addRecord('synthetic-date-record-b')
    expect(await ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal()))
      .toEqual({ nextCursor: null, scanned: 2, budgetExhausted: true })
    expect(await counts()).toEqual(admitted)
    expect((await admin.query('SELECT record_id FROM integration_automation_read_date_occurrences')).rows).toEqual([{ record_id: 'synthetic-date-record-a' }])
    expect(await ledger.submitDateSchedulePage(pair.activationId, await wake(), {}, signal()))
      .toEqual({ nextCursor: null, scanned: 2, budgetExhausted: true })
    expect(await counts()).toEqual(admitted)
  })

  it('installed freshness guard uses the same xid8-to-xmin32 modulus as audit admission', async () => {
    const definition = String((await admin.query("SELECT pg_get_functiondef('automation_read_date_occurrence_admit()'::regprocedure) AS definition")).rows[0].definition)
    expect(definition).toContain('pg_catalog.pg_current_xact_id()::text::numeric %% 4294967296')
    // Arithmetic proof only: this test does not claim the owned cluster ran at epoch > 0.
    expect((await admin.query('SELECT (4294967301::numeric % 4294967296)::text AS wrapped')).rows).toEqual([{ wrapped: '5' }])
  })
})
