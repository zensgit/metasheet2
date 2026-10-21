/** SA-06U: actual ledger + log service + migrations in an owned PG schema.
 * Source/rule execution authority is explicitly synthetic here; the complete
 * production authority/native-source/browser evidence lives in the companion
 * authority suite. No source IO or automatic schedule/record producer is claimed.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { up as addLedger } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { up as addRuleRevision } from '../../src/db/migrations/zzzz20261001122000_automation_rule_authority_revision'
import { up as addOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { up as addAudit, down as removeAudit } from '../../src/db/migrations/zzzz20261001134000_automation_read_execution_audit'
import { up as addRecordActivation } from '../../src/db/migrations/zzzz20261001135000_automation_read_record_activation'
import { createAutomationReadLedger } from '../../src/integration/automation-read-ledger'
import { createAutomationReadDelivery } from '../../src/integration/automation-read-delivery'
import { recoverDeadLetters } from '../../src/integration/automation-read-recovery'
import { recordAutomationReadExecution } from '../../src/integration/automation-read-execution-audit'
import { AUTOMATION_READ_OPERATION } from '../../src/integration/automation-read-operation-policy'
import { AUTOMATION_READ_CONSUMER, AUTOMATION_READ_EVENT, AutomationReadLedgerError,
  type AutomationReadAuthorityPort, type ReadPreview, type ReadRequestStatus } from '../../src/integration/automation-read-contracts'
import { AutomationLogService } from '../../src/multitable/automation-log-service'
import { claimDueConsumers } from '../../src/multitable/automation-durable-dispatcher'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'
import { createAutomationReadExecutionLogSchema, resetAutomationReadExecutionLinks } from '../utils/automation-read-execution-schema'

const describeDb = process.env.DATABASE_URL ? describe : describe.skip
const expectDb = process.env.EXPECT_DB === '1' ? it : it.skip
expectDb('EXPECT_DB supplies a database for execution audit atomicity', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
const actor = { actorId: 'synthetic-audit-owner', tenantId: 'synthetic-audit-tenant', workspaceId: null }
const selector = { ruleId: 'synthetic-audit-rule', actionId: 'synthetic-private-action', systemId: 'synthetic-private-system', targetId: 'synthetic-private-target' }
const sourceReference = { connectionId: 'synthetic-private-connection', connectionIncarnation: randomUUID() }
const budget = { maxRows: 20, maxPages: 2, maxReadCount: 30, timeoutMs: 60000 }
const preview: ReadPreview = { status: 'ready', counts: { add: 7, update: 2, skip: 3, inactive: 4, manual_confirm: 5 }, canApply: false }
const manifest = { version: 1901, routes: { [AUTOMATION_READ_EVENT]: [AUTOMATION_READ_CONSUMER] } }
const authority: AutomationReadAuthorityPort = {
  async lockExecution(_trx, principal) { return { ...principal, key: 'a'.repeat(64), budget,
    sourceReference, allowedTriggers: ['manual'] } },
  async lockObservation(_trx, principal, reference) { return { ...principal, sourceReference: reference } },
}

describeDb('Read execution audit: actual PG transaction and lifecycle projection', () => {
  const schema = 'automation_read_audit_' + randomBytes(8).toString('hex')
  let pool: Pool, admin: PoolClient, db: Kysely<unknown>, created = false
  let ledger: ReturnType<typeof createAutomationReadLedger>
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
  const makeLedger = () => createAutomationReadLedger({ transaction, authority, manifest })
  async function grant() {
    return ledger.grant(actor, { selector, projects: ['synthetic-private-project'], triggers: ['manual'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 20 })
  }
  function submit(grantId: string, invocationId = randomUUID(), port = ledger) {
    return port.submit(actor, { grantId, invocationId, projectNo: 'synthetic-private-project', trigger: 'manual' })
  }
  async function queued() { const { grantId } = await grant(); return { grantId, ...await submit(grantId) } }
  async function running(requestId: string) {
    const claim = await ledger.claim(requestId)
    expect(claim.status).toBe('running')
    if (!('fence' in claim)) throw new Error('SYNTHETIC_AUDIT_NO_CLAIM')
    return claim.fence
  }
  async function totals() {
    return (await admin.query(`SELECT
      (SELECT count(*)::int FROM integration_automation_read_requests) AS requests,
      (SELECT count(*)::int FROM integration_automation_read_executions) AS links,
      (SELECT count(*)::int FROM multitable_automation_executions) AS executions,
      (SELECT count(*)::int FROM meta_automation_outbox) AS outbox,
      (SELECT count(*)::int FROM meta_automation_outbox_consumer) AS consumers`)).rows[0]
  }
  async function audit(requestId: string) {
    const result = await admin.query(`SELECT e.*, l.request_id, l.rule_revision, l.step_index
      FROM integration_automation_read_executions l
      JOIN multitable_automation_executions e ON e.id=l.execution_id WHERE l.request_id=$1`, [requestId])
    expect(result.rows).toHaveLength(1)
    return result.rows[0]
  }
  async function projection(requestId: string, state: ReadRequestStatus) {
    const row = await audit(requestId)
    const legacy = state === 'succeeded' ? 'success' : ['blocked', 'cancelled'].includes(state) ? 'skipped'
      : ['failed', 'outcome_unknown'].includes(state) ? 'failed' : 'running'
    expect(row).toMatchObject({ status: legacy, integration_read: { requestId, status: state },
      trigger_event: null, rule_snapshot: null, step_index: 0, triggered_by: 'integration-read-owner' })
    expect(Object.keys(row.integration_read).sort()).toEqual(['requestId', 'status'])
    const reason = state === 'outcome_unknown' ? 'AUTOMATION_READ_OUTCOME_UNKNOWN'
      : state === 'failed' ? 'AUTOMATION_READ_FAILED' : null
    expect(row.error).toBe(reason)
    if (state === 'queued' || state === 'running') expect(row.steps).toEqual([])
    else {
      expect(row.steps).toEqual([{ actionType: 'integration_read_preview', status: legacy,
        output: { requestId, status: state }, ...(reason ? { error: reason } : {}) }])
      // Both the marker and step are closed projections, not arbitrary result or
      // authority snapshots. Do not depend solely on secret-shaped redaction.
      expect(row.steps[0].output).not.toHaveProperty('counts')
    }
    const publicJson = JSON.stringify({ marker: row.integration_read, steps: row.steps, error: row.error,
      event: row.trigger_event, snapshot: row.rule_snapshot })
    for (const value of ['synthetic-private-', sourceReference.connectionIncarnation, 'counts', 'selector', 'canApply']) {
      expect(publicJson).not.toContain(value)
    }
    return row
  }

  beforeAll(async () => {
    if (!/^automation_read_audit_[a-f0-9]{16}$/u.test(schema)) throw new Error('UNOWNED_AUDIT_SCHEMA')
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
        trigger_type text NOT NULL,action_type text NOT NULL,action_config jsonb NOT NULL,actions jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());`)
    await createAutomationReadExecutionLogSchema(admin)
    for (const migration of [addOutbox, addRuleRevision, addLedger, addAudit, addRecordActivation]) await db.transaction().execute(migration)
  })
  afterAll(async () => {
    if (admin) { await admin.query('ROLLBACK').catch(() => {}); if (created) await admin.query('DROP SCHEMA "' + schema + '" CASCADE'); admin.release() }
    if (db) await db.destroy(); else await pool?.end()
  })
  afterEach(() => { beforeQuery = undefined; vi.restoreAllMocks() })
  beforeEach(async () => {
    // Only reset this owned random test schema. All assertions run with every
    // production trigger reenabled, including private-history immutability.
    await resetAutomationReadExecutionLinks(admin, async () => {
      await admin.query(`TRUNCATE integration_automation_read_record_activations,integration_automation_read_executions,multitable_automation_executions,
      integration_automation_read_requests,integration_automation_read_grants,
      meta_automation_outbox_consumer,meta_automation_outbox,automation_rules,
      users,user_roles,role_permissions,user_permissions,user_orgs,user_namespace_admissions`)
    })
    await admin.query("INSERT INTO users VALUES ($1,'admin','[]',true,'activated')", [actor.actorId])
    await admin.query("INSERT INTO user_roles VALUES ($1,'admin')", [actor.actorId])
    await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', [actor.actorId, actor.tenantId])
    await admin.query(`INSERT INTO automation_rules(id,sheet_id,created_by,enabled,trigger_type,action_type,action_config)
      VALUES ($1,'synthetic-sheet',$2,true,'record.created','integration_read_preview',$3::jsonb)`,
    [selector.ruleId, actor.actorId, JSON.stringify({ operation: AUTOMATION_READ_OPERATION, allowManual: true })])
    ledger = makeLedger()
  })

  it('one real log-service insert joins request and outbox atomically; replay and new ledger retain identity', async () => {
    const recorded = vi.spyOn(AutomationLogService.prototype, 'recordWithQuery')
    const { grantId } = await grant(), invocation = randomUUID()
    const initial = await Promise.all(Array.from({ length: 6 }, () => submit(grantId, invocation, makeLedger())))
    const result = initial[0]
    expect(initial.every(row => row.requestId === result.requestId)).toBe(true)
    const first = await projection(result.requestId, 'queued')
    expect(recorded).toHaveBeenCalledTimes(1)
    const repeated = await Promise.all(Array.from({ length: 6 }, () => submit(grantId, invocation, makeLedger())))
    expect(repeated.every(row => row.requestId === result.requestId)).toBe(true)
    expect((await audit(result.requestId)).id).toBe(first.id)
    expect(recorded).toHaveBeenCalledTimes(1)
    expect(await totals()).toEqual({ requests: 1, links: 1, executions: 1, outbox: 1, consumers: 1 })
  })

  it.each(['multitable_automation_executions', 'integration_automation_read_executions', 'meta_automation_outbox',
    'meta_automation_outbox_consumer'])('real transaction rolls back every prior write when %s insert fails', async table => {
    const { grantId } = await grant()
    let reached = 0
    beforeQuery = async statement => {
      if (new RegExp('INSERT\\s+INTO\\s+' + table + '\\s*\\(', 'iu').test(statement)) {
        reached++; throw new Error('synthetic-private-driver-detail')
      }
    }
    await expect(submit(grantId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(reached).toBe(1)
    expect(await totals()).toEqual({ requests: 0, links: 0, executions: 0, outbox: 0, consumers: 0 })
  })

  it('new admission fails closed if the actual log service returns without creating its public shell', async () => {
    vi.spyOn(AutomationLogService.prototype, 'recordWithQuery').mockResolvedValue(undefined)
    const { grantId } = await grant()
    await expect(submit(grantId)).rejects.toBeInstanceOf(AutomationReadLedgerError)
    expect(await totals()).toEqual({ requests: 0, links: 0, executions: 0, outbox: 0, consumers: 0 })
  })

  it('a standalone read-marked shell cannot COMMIT without its exact private link', async () => {
    let inserted = false
    await expect(transaction(async trx => {
      await new AutomationLogService().recordWithQuery(trx.query.bind(trx), {
        id: 'axe_' + randomUUID(), ruleId: selector.ruleId, sheetId: 'synthetic-sheet',
        triggeredBy: 'integration-read-owner', triggeredAt: new Date().toISOString(), status: 'running', steps: [],
        integrationRead: { requestId: randomUUID(), status: 'queued' },
      })
      inserted = true
    })).rejects.toBeDefined()
    // The failure is the deferred COMMIT constraint, not an earlier validation
    // rejection that never exercised the shell/link consistency boundary.
    expect(inserted).toBe(true)
    expect(await totals()).toEqual({ requests: 0, links: 0, executions: 0, outbox: 0, consumers: 0 })
  })

  it('insert then delete of an uncommitted shell and ordinary unmarked logs remain legal', async () => {
    await transaction(async trx => {
      const executionId = 'axe_' + randomUUID()
      await new AutomationLogService().recordWithQuery(trx.query.bind(trx), {
        id: executionId, ruleId: selector.ruleId, sheetId: 'synthetic-sheet',
        triggeredBy: 'integration-read-owner', triggeredAt: new Date().toISOString(), status: 'running', steps: [],
        integrationRead: { requestId: randomUUID(), status: 'queued' },
      })
      await trx.query('DELETE FROM multitable_automation_executions WHERE id=$1', [executionId])
      await new AutomationLogService().recordWithQuery(trx.query.bind(trx), {
        id: 'axe_' + randomUUID(), ruleId: selector.ruleId, triggeredBy: 'event',
        triggeredAt: new Date().toISOString(), status: 'success', steps: [],
      })
    })
    expect(await totals()).toEqual({ requests: 0, links: 0, executions: 1, outbox: 0, consumers: 0 })
    expect((await admin.query('SELECT integration_read FROM multitable_automation_executions')).rows)
      .toEqual([{ integration_read: null }])
  })

  it('lost submit receipt after actual COMMIT recovers the same audit without another queue or quota use', async () => {
    const { grantId } = await grant(), invocation = randomUUID()
    const ambiguous = createAutomationReadLedger({ authority, manifest, async transaction(work) {
      await transaction(work)
      throw new Error('synthetic-private-commit-receipt')
    } })
    await expect(submit(grantId, invocation, ambiguous)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    const before = (await admin.query('SELECT execution_id,request_id FROM integration_automation_read_executions')).rows
    const result = await submit(grantId, invocation, makeLedger())
    expect(before).toEqual([{ request_id: result.requestId, execution_id: (await audit(result.requestId)).id }])
    expect(await totals()).toEqual({ requests: 1, links: 1, executions: 1, outbox: 1, consumers: 1 })
    expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants')).rows).toEqual([{ used_executions: 0 }])
  })

  it('actual claim, successful completion and a losing fence project once with no private preview values', async () => {
    const { requestId } = await queued()
    await projection(requestId, 'queued')
    const fence = await running(requestId)
    await projection(requestId, 'running')
    await ledger.complete({ requestId, fence, result: preview })
    const final = await projection(requestId, 'succeeded')
    await expect(ledger.complete({ requestId, fence: randomUUID(), result: preview }))
      .rejects.toMatchObject({ code: 'AUTOMATION_READ_FENCE_LOST' })
    expect(await audit(requestId)).toEqual(final)
  })

  it.each(['cancel', 'revoke', 'abandon', 'expired-observe', 'failed'] as const)('projects terminal state from %s', async operation => {
    const { requestId, grantId } = await queued()
    let status: ReadRequestStatus
    if (operation === 'cancel') { await ledger.cancel(actor, requestId); status = 'cancelled' }
    else if (operation === 'revoke') { await ledger.revoke(actor, grantId); status = 'blocked' }
    else if (operation === 'failed') {
      // There is intentionally no public fail action. Exercise the actual DB
      // projection for this reserved ledger state without claiming a producer.
      await admin.query("UPDATE integration_automation_read_requests SET status='failed',finished_at=clock_timestamp() WHERE id=$1", [requestId])
      status = 'failed'
    } else {
      const fence = await running(requestId)
      if (operation === 'abandon') await ledger.abandon({ requestId, fence })
      else {
        await admin.query("UPDATE integration_automation_read_requests SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [requestId])
        await ledger.observe(actor, requestId)
      }
      status = 'outcome_unknown'
    }
    await projection(requestId, status)
  })

  it('actual delivery denial and actual dead-letter recovery synchronize the public projection', async () => {
    const first = await queued()
    const event = (await claimDueConsumers(admin, { consumerKeys: [AUTOMATION_READ_CONSUMER], batchSize: 1 }))[0]
    const delivery = createAutomationReadDelivery({ transaction, async execute() { throw new AutomationReadLedgerError('AUTOMATION_READ_DENIED') } })
    expect(await delivery.handle(event, { signal: new AbortController().signal })).toEqual({ outcome: 'success' })
    await projection(first.requestId, 'blocked')
    const second = await queued()
    await running(second.requestId)
    await admin.query(`UPDATE meta_automation_outbox_consumer SET status='dead_letter',fence=1,attempts=1,lease_expires_at=NULL
      WHERE outbox_id=(SELECT outbox_id FROM integration_automation_read_requests WHERE id=$1)`, [second.requestId])
    await recoverDeadLetters({ transaction })
    await projection(second.requestId, 'outcome_unknown')
  })

  it('public retention can delete the shell; later terminal updates and replay do not resurrect it', async () => {
    const { grantId } = await grant(), invocation = randomUUID()
    const { requestId } = await submit(grantId, invocation)
    const execution = await audit(requestId)
    expect((await admin.query('DELETE FROM multitable_automation_executions WHERE id=$1', [execution.id])).rowCount).toBe(1)
    await ledger.cancel(actor, requestId)
    expect((await submit(grantId, invocation)).requestId).toBe(requestId)
    expect(await totals()).toEqual({ requests: 1, links: 1, executions: 0, outbox: 1, consumers: 1 })
    expect((await ledger.observe(actor, requestId)).status).toBe('cancelled')
    await expect(admin.query(`INSERT INTO multitable_automation_executions(id,rule_id,triggered_by)
      VALUES ($1,$2,'event')`, [execution.id, selector.ruleId])).rejects.toBeDefined()
  })

  it.each(['execution_id', 'rule_id', 'rule_revision', 'step_index', 'request_id'] as const)('private %s is immutable', async field => {
    const { requestId } = await queued()
    const values = { execution_id: 'axe_' + randomUUID(), rule_id: 'synthetic-wrong-rule', rule_revision: randomUUID(),
      step_index: 1, request_id: randomUUID() }
    await expect(admin.query('UPDATE integration_automation_read_executions SET ' + field + '=$1 WHERE request_id=$2',
      [values[field], requestId])).rejects.toBeDefined()
    await projection(requestId, 'queued')
  })

  it.each(['DELETE FROM integration_automation_read_executions', 'TRUNCATE integration_automation_read_executions'])('retained history rejects %s', async statement => {
    await queued()
    await expect(admin.query(statement)).rejects.toBeDefined()
    expect((await totals()).links).toBe(1)
  })

  it.each(['project_no', 'invocation_id', 'trigger_type', 'created_at'] as const)('linked request %s cannot be rewritten', async field => {
    const { requestId } = await queued(), original = await audit(requestId)
    const values = { project_no: 'synthetic-private-another-project', invocation_id: randomUUID(),
      trigger_type: 'record', created_at: '2025-01-01T00:00:00.000Z' }
    await expect(admin.query('UPDATE integration_automation_read_requests SET ' + field + '=$1 WHERE id=$2',
      [values[field], requestId])).rejects.toBeDefined()
    expect(await audit(requestId)).toEqual(original)
  })

  it.each(['grant', 'rule', 'owner', 'tenant'] as const)('linked request cannot move to a scope-consistent different %s grant', async changed => {
    const { requestId } = await queued(), original = await audit(requestId)
    const principal = { ...actor, ...(changed === 'owner' ? { actorId: 'synthetic-audit-other-owner' } : {}),
      ...(changed === 'tenant' ? { tenantId: 'synthetic-audit-other-tenant' } : {}) }
    if (changed === 'owner') {
      await admin.query("INSERT INTO users VALUES ($1,'admin','[]',true,'activated')", [principal.actorId])
      await admin.query("INSERT INTO user_roles VALUES ($1,'admin')", [principal.actorId])
    }
    if (changed === 'owner' || changed === 'tenant') await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', [principal.actorId, principal.tenantId])
    const selected = changed === 'rule' ? { ...selector, ruleId: 'synthetic-audit-other-rule' } : selector
    if (changed === 'rule') await admin.query(`INSERT INTO automation_rules
      (id,sheet_id,created_by,enabled,trigger_type,action_type,action_config)
      SELECT $1,sheet_id,created_by,enabled,trigger_type,action_type,action_config FROM automation_rules WHERE id=$2`,
    [selected.ruleId, selector.ruleId])
    const { grantId } = await ledger.grant(principal, { selector: selected, projects: ['synthetic-private-project'], triggers: ['manual'],
      budget, expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 20 })
    // Match the composite FK exactly so that FK rejection cannot impersonate
    // the new immutable-linked-request guard being tested.
    await expect(admin.query(`UPDATE integration_automation_read_requests
      SET grant_id=$2,owner_id=$3,tenant_id=$4 WHERE id=$1`, [requestId, grantId, principal.actorId, principal.tenantId]))
      .rejects.toBeDefined()
    expect(await audit(requestId)).toEqual(original)
  })

  it.each(['ruleId', 'actorId', 'tenantId'] as const)('recorder rejects a mismatched %s on a genuinely new unlinked request', async field => {
    const { grantId } = await grant(), requestId = randomUUID()
    await expect(transaction(async trx => {
      // Keep the same-transaction/new-row requirement positive so an old-row or
      // duplicate-link guard cannot mask a missing recorder scope predicate.
      await trx.query(`INSERT INTO integration_automation_read_requests
        (id,grant_id,tenant_id,owner_id,invocation_id,project_no,trigger_type)
        VALUES ($1,$2,$3,$4,$5,'synthetic-private-project','manual')`,
      [requestId, grantId, actor.tenantId, actor.actorId, randomUUID()])
      await recordAutomationReadExecution(trx, {
        requestId, ruleId: selector.ruleId, actorId: actor.actorId, tenantId: actor.tenantId,
        [field]: 'synthetic-wrong-scope',
      })
    })).rejects.toBeDefined()
    expect(await totals()).toEqual({ requests: 0, links: 0, executions: 0, outbox: 0, consumers: 0 })
  })

  it.each(['rule', 'nonce', 'shell'] as const)('new link admission rejects the wrong %s before any transaction is committed', async mismatch => {
    const { grantId } = await grant()
    let injected = 0
    beforeQuery = async (statement, params) => {
      if (/INSERT\s+INTO\s+integration_automation_read_executions\s*\(/iu.test(statement)) {
        if (!params) throw new Error('SYNTHETIC_LINK_PARAMS_MISSING')
        injected++
        // All earlier statements, including the real public-shell INSERT, have
        // run. Mutate only this submitted link, not the guard or its DB result.
        params[mismatch === 'rule' ? 2 : mismatch === 'nonce' ? 3 : 1] = mismatch === 'rule'
          ? 'synthetic-wrong-rule' : mismatch === 'nonce' ? randomUUID() : 'axe_' + randomUUID()
      }
    }
    await expect(submit(grantId)).rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
    expect(injected).toBe(1)
    expect(await totals()).toEqual({ requests: 0, links: 0, executions: 0, outbox: 0, consumers: 0 })
  })

  it.each(['extra-key', 'bad-status', 'wrong-request', 'preview-output', 'snapshot'] as const)('public projection rejects %s mutation', async mutation => {
    const { requestId } = await queued(), original = await audit(requestId)
    if (mutation === 'snapshot') {
      await expect(admin.query("UPDATE multitable_automation_executions SET rule_snapshot='{}' WHERE id=$1", [original.id])).rejects.toBeDefined()
    } else if (mutation === 'preview-output') {
      await expect(admin.query(`UPDATE multitable_automation_executions SET steps=$2::jsonb WHERE id=$1`,
        [original.id, JSON.stringify([{ actionType: 'integration_read_preview', status: 'success', output: preview }])])).rejects.toBeDefined()
    } else {
      const marker = mutation === 'extra-key' ? { requestId, status: 'queued', counts: preview.counts }
        : { requestId: mutation === 'wrong-request' ? randomUUID() : requestId, status: mutation === 'bad-status' ? 'ready' : 'queued' }
      await expect(admin.query('UPDATE multitable_automation_executions SET integration_read=$2::jsonb WHERE id=$1',
        [original.id, JSON.stringify(marker)])).rejects.toBeDefined()
    }
    expect(await audit(requestId)).toEqual(original)
  })

  it('migration does not fabricate executions for old requests', async () => {
    // Remove the new empty layer in its actual down migration, create historical
    // grant/request directly, then upgrade. This explicitly is migration input,
    // never evidence that a production submit bypasses its mandatory audit.
    await db.transaction().execute(removeAudit)
    const { grantId } = await grant(), requestId = randomUUID()
    await admin.query(`INSERT INTO integration_automation_read_requests
      (id,grant_id,tenant_id,owner_id,invocation_id,project_no,trigger_type)
      VALUES ($1,$2,$3,$4,$5,'synthetic-private-project','manual')`,
    [requestId, grantId, actor.tenantId, actor.actorId, randomUUID()])
    await db.transaction().execute(addAudit)
    expect(await totals()).toEqual({ requests: 1, links: 0, executions: 0, outbox: 0, consumers: 0 })
    await expect(transaction(trx => recordAutomationReadExecution(trx, {
      requestId, ruleId: selector.ruleId, actorId: actor.actorId, tenantId: actor.tenantId,
    }))).rejects.toBeDefined()
    await ledger.cancel(actor, requestId)
    expect((await totals()).executions).toBe(0)
  })

  it('rollback refuses to discard existing private execution history', async () => {
    await queued()
    await expect(db.transaction().execute(removeAudit)).rejects.toBeDefined()
    expect((await totals()).links).toBe(1)
  })
})
