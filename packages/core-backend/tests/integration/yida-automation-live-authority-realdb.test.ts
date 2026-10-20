// Live actor/rule prerequisites + actual encrypted YiDa private primitives on PG.
// Host-provided installation binding is synthetic. No JWT route or sender yet.
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PluginRuntimeSecurityService } from '../../src/security/plugin-runtime-security-service'
import { createYidaAutomationLiveAuthority } from '../../src/integration/yida-automation-live-authority'
import { createYidaAutomationAuthorizationService } from '../../src/integration/yida-automation-authorization-service'
import type { YidaSendAuthorityPrimitives } from '../../src/integration/yida-send-approval-service'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import { up as migrateSharedOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { CURRENT_ROUTING_MANIFEST, SUPPORTED_MANIFEST_VERSIONS } from '../../src/multitable/automation-routing-manifest'
import { YIDA_AUTOMATION_EVENT, YIDA_AUTOMATION_CONSUMER, YIDA_AUTOMATION_ROUTING_CANDIDATE } from '../../src/integration/yida-automation-outbox'
import { enqueueOutboxEvent } from '../../src/multitable/automation-outbox-enqueue'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const requireCjs = createRequire(import.meta.url)
const nativeImport = requireCjs('../utils/yida-native-module-import.cjs')
const scope = { tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner' } as const
const actor = { tenantId: scope.tenantId, workspaceId: null, actorId: scope.ownerId } as const
const binding = { baseId: 'synthetic-base', sheetId: 'synthetic-sheet', projectField: 'projectNo' }
const revision = '11111111-1111-4111-8111-111111111111'
type Row = Record<string, unknown>
type Authority = ReturnType<typeof createYidaAutomationLiveAuthority>
type Draft = { operationId: string; rows: Array<{ rowKey: string }> }
type Material = { credentialRef: string; credentialGeneration: number }

it('sentinel: live YiDa authority requires explicitly provided disposable PG', () => {
  expect(process.env.EXPECT_DB).toBe('1'); expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})

describe('SA06D live prerequisites, rule and private material — real PG', () => {
  let admin: Pool, pool: Pool, schema: string, security: PluginRuntimeSecurityService
  let authority: Authority, draft: Draft, material: Material, primitives: YidaSendAuthorityPrimitives
  let materialStore: { rotate(input: unknown): Promise<unknown>; revoke(input: unknown): Promise<unknown> }
  let native: Record<string, unknown>, oldEnv: Array<[string, string | undefined]>
  let management: ReturnType<typeof createYidaAutomationAuthorizationService>, managementQueries: string[], managementTransactions = 0
  let loseManagementCommit = false
  let managementMonotonic = 1000, advanceManagementClockAfterLink = false
  const lib = path.join(root, 'plugins/plugin-integration-core/lib')
  const moduleFile = (name: string) => pathToFileURL(path.join(lib, name)).href
  function input() { return { confirmationId: 'confirmation', ruleId: 'synthetic-rule', expectedRuleRevision: revision,
    actionId: 'synthetic-slot', projectNo: 'DEMO-P1', operationId: draft.operationId,
    rowKeys: [draft.rows[0].rowKey], allowedTriggers: ['manual', 'schedule.interval'], maxExecutions: 1, ttlMs: 900000 } }
  async function transaction<T>(work: (trx: Queryable) => Promise<T>) {
    const client = await pool.connect()
    try { await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); const result = await work(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  async function measure(which = authority, patch: Row = {}) {
    return transaction(async trx => which.takeInTransaction(trx, await which.lockForApprovalInTransaction(trx, { ...input(), ...patch })))
  }
  const denied = (pending: Promise<unknown>) => expect(pending).rejects.toThrow('YIDA_AUTOMATION_AUTHORITY_DENIED')
  beforeAll(async () => {
    if (process.env.EXPECT_DB !== '1' || !process.env.DATABASE_URL) throw new Error('SA06D_OWNED_DB_REQUIRED')
    const endpoint = new URL(process.env.DATABASE_URL)
    if (endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/plm_full_app_synthetic') throw new Error('SA06D_OWNED_DB_REQUIRED')
    oldEnv = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'].map(key => [key, process.env[key]])
    process.env.NODE_ENV = 'production'
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex')
    process.env.ENCRYPTION_SALT = randomBytes(32).toString('hex')
    security = new PluginRuntimeSecurityService()
    native = {
      draft: (await nativeImport(moduleFile('yida-draft-plan-store.mjs'))).createYidaDraftPlanStore,
      target: (await nativeImport(moduleFile('yida-approved-target-store.mjs'))).createYidaApprovedTargetStore,
      primitives: (await nativeImport(moduleFile('yida-send-authority-primitives.mjs'))).createYidaSendAuthorityPrimitives,
    }
    admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  })
  beforeEach(async () => {
    schema = 'sa06dlive_' + randomUUID().replaceAll('-', '')
    await admin.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6,
      options: `-c search_path=${schema} -c statement_timeout=5000` })
    // Run the actual shared outbox migration, not a permissive SQL fake.
    await migrateSharedOutbox(new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }))
    for (const name of ['090_create_integration_yida_delivery_ledger.sql', '091_create_integration_yida_create_fence.sql',
      '092_create_integration_yida_credential_materials.sql', '093_create_integration_yida_draft_plans.sql',
      '094_create_integration_yida_approved_target.sql', '097_create_integration_yida_automation_authorizations.sql',
      'zzzz20261019121000_link_integration_yida_automation_outbox.sql']) {
      await pool.query(readFileSync(path.join(root, 'packages/core-backend/migrations', name), 'utf8'))
    }
    // Exact columns consumed by existing live helpers; not evidence of the full
    // user/base migrations, or of host-installed binding provenance/JWT routing.
    await pool.query(`
      CREATE TABLE users(id text PRIMARY KEY,role text,permissions jsonb,is_active boolean,activation_status text);
      CREATE TABLE user_roles(user_id text,role_id text,PRIMARY KEY(user_id,role_id));
      CREATE TABLE role_permissions(role_id text,permission_code text,PRIMARY KEY(role_id,permission_code));
      CREATE TABLE user_permissions(user_id text,permission_code text,PRIMARY KEY(user_id,permission_code));
      CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean,PRIMARY KEY(user_id,org_id));
      CREATE TABLE user_namespace_admissions(user_id text,namespace text,enabled boolean,UNIQUE(user_id,namespace));
      INSERT INTO users VALUES ('synthetic-owner','user','[]',true,'activated'),('other-admin','admin','[]',true,'activated');
      INSERT INTO user_roles VALUES ('synthetic-owner','integration_admin'),('other-admin','admin');
      INSERT INTO user_permissions VALUES ('synthetic-owner','integration:admin');
      INSERT INTO user_orgs VALUES ('synthetic-owner','synthetic-tenant',true),('other-admin','synthetic-tenant',true);
      INSERT INTO user_namespace_admissions VALUES ('synthetic-owner','integration',true);
      CREATE TABLE meta_bases(id text PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE meta_sheets(id text PRIMARY KEY,base_id text,deleted_at timestamptz);
      CREATE TABLE automation_rules(id text PRIMARY KEY,sheet_id text,name text,trigger_type text,trigger_config jsonb,
        action_type text,action_config jsonb,enabled boolean,created_at timestamptz,updated_at timestamptz,
        created_by text,conditions jsonb,actions jsonb,execution_mode text,integration_authority_revision text);
      INSERT INTO meta_bases VALUES ('synthetic-base',NULL);
      INSERT INTO meta_sheets VALUES ('synthetic-sheet','synthetic-base',NULL);
      INSERT INTO automation_rules VALUES ('synthetic-rule','synthetic-sheet','Synthetic rule','schedule.interval',
        '{"intervalMs":60000}','integration_yida_send_authorized','{"authorizationSlot":"synthetic-slot"}',true,
        clock_timestamp(),clock_timestamp(),'synthetic-owner',NULL,'[]','legacy','${revision}');
    `)
    const query = async (sql: string, values?: unknown[]) => (await pool.query(sql, values)).rows
    const database = { query, transaction: <T>(callback: (trx: { query: typeof query }) => Promise<T>) => transaction(trx =>
      callback({ query: async (sql, values) => (await trx.query(sql, values)).rows })) }
    const db = requireCjs(path.join(lib, 'db.cjs')).createDb({ database })
    const options = { db, security, context: scope }
    // Native factories with real crypto/SQL/compiler; no selection/authority stub.
    const createDraft = native.draft as (options: unknown) => { createDraft(input: unknown): Promise<Draft> }
    const createTarget = native.target as (options: unknown) => { register(input: unknown): Promise<unknown> }
    const createPrimitives = native.primitives as (options: unknown) => YidaSendAuthorityPrimitives
    const store = requireCjs(path.join(lib, 'yida-credential-material-store.cjs')).createYidaCredentialMaterialStore(options)
    materialStore = store
    draft = await createDraft(options).createDraft({
      config: { version: 2, kind: 'yida-form-protocol-static', intent: 'create',
        target: { appType: 'synthetic_app', formUuid: 'synthetic_form' },
        businessKey: ['projectNo', 'lineId'], emptyKeyFields: [],
        fieldCatalog: [{ id: 'project', control: 'text', required: true }, { id: 'line', control: 'text', required: true }],
        fieldMap: [{ source: 'projectNo', target: 'project', type: 'string', required: true },
          { source: 'lineId', target: 'line', type: 'string', required: true }] },
      rowsText: JSON.stringify([{ projectNo: 'DEMO-P1', lineId: 'L1' }]), allocation: { mode: 'original' },
    })
    material = await store.create({ material: { appKey: 'synthetic-app', appSecret: 'synthetic-secret', systemToken: 'synthetic-system', userId: 'synthetic-executor' } })
    await createTarget(options).register({ operationId: draft.operationId,
      credentialRef: material.credentialRef, credentialGeneration: material.credentialGeneration,
      attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-review', organizationId: 'synthetic-org', executionIdentity: 'synthetic-executor' } })
    primitives = createPrimitives({ security, context: scope })
    authority = createYidaAutomationLiveAuthority({ grantor: actor, binding, primitives })
    managementQueries = []; managementTransactions = 0; loseManagementCommit = false
    managementMonotonic = 1000; advanceManagementClockAfterLink = false
    management = createYidaAutomationAuthorizationService({ grantor: actor, binding, primitives,
      activationId: '22222222-2222-4222-8222-222222222222',
      monotonicNow: () => managementMonotonic,
      database: { transaction: async work => {
        managementTransactions++
        const result = await transaction(trx => work({ query: async (sql, values) => {
          managementQueries.push(sql) // Shapes only; actual query results are not replaced.
          const rows = await trx.query(sql, values)
          if (advanceManagementClockAfterLink && sql.includes('INSERT INTO integration_yida_auto_outbox_links')) {
            advanceManagementClockAfterLink = false; managementMonotonic += 900000
          }
          return rows
        } }))
        if (loseManagementCommit) { loseManagementCommit = false; throw new Error('SA06D_TEST_COMMIT_RESPONSE_LOST') }
        return result
      } },
    })
  }, 15000)
  afterEach(async () => {
    authority?.close()
    management?.close()
    await pool?.end()
    if (!/^sa06dlive_[0-9a-f]{32}$/u.test(schema)) throw new Error('SA06D_SCHEMA_NOT_OWNED')
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
  })
  afterAll(async () => {
    await admin?.end()
    for (const [key, value] of oldEnv ?? []) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  })

  it('locks actual live actor/rule/material and returns an opaque single-use transaction proof', async () => {
    await transaction(async trx => {
      const proof = await authority.lockForApprovalInTransaction(trx, input())
      expect(Object.keys(proof)).toEqual([])
      expect(JSON.stringify(proof)).toBe('{}')
      const measured = await authority.takeInTransaction(trx, proof)
      expect(measured.materialRevision).toMatch(/^[0-9a-f]{64}$/)
      expect(measured.grantor).toEqual(actor)
      expect(measured.selections.length).toBe(1)
      expect(measured.selections[0].ownerId).toBe(scope.ownerId)
      await denied(authority.takeInTransaction(trx, proof))
    })
  })
  it('recomputes stable material evidence and requires the exact expected revision', async () => {
    const first = await measure(), second = await measure()
    expect(second.materialRevision).toBe(first.materialRevision)
    await transaction(async trx => {
      await denied(authority.lockForExecutionInTransaction(trx, input(), '0'.repeat(64)))
      await denied(authority.lockForExecutionInTransaction(trx, { ...input(), maxExecutions: 2 }, first.materialRevision))
      await denied(authority.lockForExecutionInTransaction(trx, { ...input(), ttlMs: 1000 }, first.materialRevision))
      await denied(authority.lockForExecutionInTransaction(trx, { ...input(), confirmationId: 'other' }, first.materialRevision))
    })
    await transaction(async trx => {
      const proof = await authority.lockForExecutionInTransaction(trx, input(), first.materialRevision)
      expect((await authority.takeInTransaction(trx, proof)).materialRevision).toBe(first.materialRevision)
    })
  })
  it('supports the actual identical single-action modern list without admitting a second action', async () => {
    await pool.query(`UPDATE automation_rules SET actions='[{"type":"integration_yida_send_authorized","config":{"authorizationSlot":"synthetic-slot"}}]'`)
    await measure()
    await pool.query(`UPDATE automation_rules SET actions=actions||'[{"type":"send_webhook","config":{}}]'::jsonb`)
    await denied(measure())
  })
  it('rejects workflow execution rather than inventing a new global mode', async () => {
    await measure()
    await pool.query("UPDATE automation_rules SET execution_mode='workflow_job_v1'")
    await denied(measure())
  })
  it.each(['membership', 'permission', 'user', 'namespace'])('live %s revocation refuses fresh evidence', async kind => {
    await measure() // Positive path with the SAME material before mutation.
    const statement = { membership: "UPDATE user_orgs SET is_active=false WHERE user_id='synthetic-owner'",
      permission: "DELETE FROM user_permissions WHERE user_id='synthetic-owner'",
      user: "UPDATE users SET is_active=false WHERE id='synthetic-owner'",
      namespace: "UPDATE user_namespace_admissions SET enabled=false WHERE user_id='synthetic-owner'" }[kind]!
    await pool.query(statement)
    await denied(measure())
  })
  it.each(['owner', 'revision', 'enabled', 'slot', 'trigger', 'actions', 'conditions'])('rule %s changes refuse fresh evidence', async kind => {
    await measure()
    const statement = { owner: "UPDATE automation_rules SET created_by='other-admin'",
      revision: "UPDATE automation_rules SET integration_authority_revision='44444444-4444-4444-8444-444444444444'",
      enabled: 'UPDATE automation_rules SET enabled=false',
      slot: 'UPDATE automation_rules SET action_config=\'{"authorizationSlot":"other"}\'',
      trigger: "UPDATE automation_rules SET trigger_type='webhook.received'",
      actions: 'UPDATE automation_rules SET actions=\'[{"type":"send_webhook"}]\'',
      conditions: 'UPDATE automation_rules SET conditions=\'[{"field":"unapproved"}]\'' }[kind]!
    await pool.query(statement)
    await denied(measure())
  })
  it('another same-tenant administrator cannot adopt the target owner', async () => {
    await measure()
    await pool.query("UPDATE automation_rules SET created_by='other-admin'")
    const other = createYidaAutomationLiveAuthority({ grantor: { ...actor, actorId: 'other-admin' }, binding,
      primitives: (native.primitives as (options: unknown) => YidaSendAuthorityPrimitives)({ security, context: { ...scope, ownerId: 'other-admin' } }) })
    await denied(measure(other))
  })
  it('the project value is resolved from the actual selected row, not a caller attestation', async () => {
    await measure()
    await denied(measure(authority, { projectNo: 'DEMO-P2' }))
    await denied(measure(authority, { materialRevision: '0'.repeat(64) }))
  })
  it.each(['revoke', 'rotate'])('actual credential %s invalidates the original material', async action => {
    await measure()
    const ref = { credentialRef: material.credentialRef, expectedGeneration: material.credentialGeneration }
    if (action === 'revoke') await materialStore.revoke(ref)
    else await materialStore.rotate({ ...ref, material: { appKey: 'synthetic-new', appSecret: 'synthetic-new-secret', systemToken: 'synthetic-new-system', userId: 'synthetic-executor' } })
    await denied(measure())
  })
  it('closed activation and copied JSON cannot carry a material proof', async () => {
    await transaction(async trx => {
      const proof = await authority.lockForApprovalInTransaction(trx, input())
      await denied(authority.takeInTransaction(trx, JSON.parse(JSON.stringify(proof))))
      authority.close()
      await denied(authority.takeInTransaction(trx, proof))
      await denied(authority.lockForApprovalInTransaction(trx, input()))
    })
  })
  it('a proof cannot survive COMMIT even when the same physical client is reused', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const proof = await authority.lockForApprovalInTransaction(client, input())
      await client.query('COMMIT')
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await denied(authority.takeInTransaction(client, proof))
      await client.query('ROLLBACK')
    } finally { client.release() }
  })

  it('management composes actual live checks and persistent consent in one real transaction', async () => {
    const created = await management.create(input())
    expect(created).toMatchObject({ reused: false, usedExecutions: 0, maxExecutions: 1,
      status: 'recorded', canSend: false, externalWriteAttempted: false, liveEligibilityChecked: false })
    expect(managementTransactions).toBe(1)
    expect(managementQueries[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    for (const table of ['user_permissions', 'automation_rules', 'integration_yida_credential_materials', 'integration_yida_auto_grants']) {
      expect(managementQueries.some(sql => sql.includes(table))).toBe(true)
    }
    const reserved = await management.reserveManual(created.grantId, { requestKey: 'manual-request' })
    expect(reserved).toMatchObject({ rowOrdinal: 0, reused: false, deliveryQueued: false, canSend: false })
    expect(await management.reserveManual(created.grantId, { requestKey: 'manual-request' })).toEqual({ ...reserved, reused: true })
    expect((await pool.query('SELECT used_executions FROM integration_yida_auto_grants')).rows).toEqual([{ used_executions: 0 }])
    expect((await pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_admissions')).rows[0].n).toBe(0)
  })
  it('concurrent confirmations compose to exactly one persistent authorization', async () => {
    const result = await Promise.all([management.create(input()), management.create(input())])
    expect(new Set(result.map(row => row.grantId)).size).toBe(1)
    expect(result.map(row => row.reused).sort()).toEqual([false, true])
    expect((await pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_grants')).rows[0].n).toBe(1)
  })
  it('management input cannot supply scope or payload and is refused before DB work', async () => {
    for (const key of ['actorId', 'tenantId', 'ownerId', 'payload', 'materialRevision']) {
      await expect(management.create({ ...input(), [key]: 'untrusted' })).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_INPUT')
    }
    expect(managementTransactions).toBe(0)
  })
  it('storage failure rolls back a real measured authorization without a half row', async () => {
    await pool.query(`CREATE FUNCTION fail_auto_grant() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'SA06D_TEST_STORAGE_FAILURE'; END; $$;
      CREATE TRIGGER fail_auto_grant BEFORE INSERT ON integration_yida_auto_grants
      FOR EACH ROW EXECUTE FUNCTION fail_auto_grant();`)
    await expect(management.create(input())).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect((await pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_grants')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_requests')).rows[0].n).toBe(0)
  })
  it('history after material revocation does not refresh eligibility or reread secret material', async () => {
    const created = await management.create(input())
    const reserved = await management.reserveManual(created.grantId, { requestKey: 'request' })
    await materialStore.revoke({ credentialRef: material.credentialRef, expectedGeneration: material.credentialGeneration })
    managementQueries.length = 0
    expect(await management.create(input())).toEqual({ ...created, reused: true })
    expect(await management.reserveManual(created.grantId, { requestKey: 'request' })).toEqual({ ...reserved, reused: true })
    expect(managementQueries.some(sql => sql.includes('integration_yida_credential_materials'))).toBe(false)
    await expect(management.reserveManual(created.grantId, { requestKey: 'fresh-request' })).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    await expect(management.create({ ...input(), confirmationId: 'new-confirmation' })).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    await expect(management.create({ ...input(), ttlMs: 1000 })).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_CONFLICT')
    expect((await pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_grants')).rows[0].n).toBe(1)
  })
  it('live grantor authority is required even for history, inspection and revoke', async () => {
    const created = await management.create(input())
    await pool.query("DELETE FROM user_permissions WHERE user_id='synthetic-owner'")
    await Promise.all([management.create(input()), management.inspect(created.grantId), management.revoke(created.grantId)]
      .map(pending => expect(pending).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')))
    expect((await pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_revocations')).rows[0].n).toBe(0)
  })
  it('rule fingerprint drift blocks a new reservation without adding a row', async () => {
    const created = await management.create(input())
    await pool.query("UPDATE automation_rules SET name='changed-after-grant'")
    await expect(management.reserveManual(created.grantId, { requestKey: 'new' })).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect((await pool.query('SELECT count(*)::int AS n FROM integration_yida_auto_requests')).rows[0].n).toBe(0)
  })
  it('closed activation refuses new work but still permits owner revocation and history', async () => {
    const created = await management.create(input())
    management.close()
    await expect(management.create({ ...input(), confirmationId: 'new' })).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_CLOSED')
    await expect(management.reserveManual(created.grantId, { requestKey: 'new' })).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_CLOSED')
    expect((await management.revoke(created.grantId)).revoked).toBe(true)
    expect((await management.inspect(created.grantId)).status).toBe('revoked')
  })

  const queueCounts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM integration_yida_auto_requests) AS requests,
    (SELECT count(*)::int FROM meta_automation_outbox) AS events,
    (SELECT count(*)::int FROM meta_automation_outbox_consumer) AS consumers,
    (SELECT count(*)::int FROM integration_yida_auto_outbox_links) AS links,
    (SELECT sum(used_executions)::int FROM integration_yida_auto_grants) AS used`)).rows[0]

  it('manual acceptance uses the actual shared producer and commits reference-only outbox plus source', async () => {
    const created = await management.create(input())
    const accepted = await management.requestManual(created.grantId, { requestKey: 'queued' })
    expect(accepted).toMatchObject({ reused: false, deliveryQueued: true, canSend: false, externalWriteAttempted: false })
    expect(await queueCounts()).toEqual({ requests: 1, events: 1, consumers: 1, links: 1, used: 0 })
    const event = (await pool.query('SELECT event_type,event_id,payload,automation_depth,manifest_version FROM meta_automation_outbox')).rows[0]
    expect(event).toEqual({ event_type: YIDA_AUTOMATION_EVENT, event_id: 'yida-automation:' + accepted.requestId,
      payload: { requestId: accepted.requestId }, automation_depth: 0, manifest_version: 5 })
    expect((await pool.query('SELECT consumer_key,status,fence,attempts FROM meta_automation_outbox_consumer')).rows)
      .toEqual([{ consumer_key: YIDA_AUTOMATION_CONSUMER, status: 'pending', fence: '0', attempts: 0 }])
    // Producer candidate is intentionally not globally activated before worker wiring.
    expect(CURRENT_ROUTING_MANIFEST.version).toBe(4)
    expect(CURRENT_ROUTING_MANIFEST.routes[YIDA_AUTOMATION_EVENT]).toBeUndefined()
    expect(SUPPORTED_MANIFEST_VERSIONS.has(5)).toBe(false)
  })
  it('concurrent manual occurrences with the same key enqueue exactly once', async () => {
    const created = await management.create(input())
    const results = await Promise.all([management.requestManual(created.grantId, { requestKey: 'same' }),
      management.requestManual(created.grantId, { requestKey: 'same' })])
    expect(new Set(results.map(row => row.requestId)).size).toBe(1)
    expect(results.map(row => row.reused).sort()).toEqual([false, true])
    expect(await queueCounts()).toEqual({ requests: 1, events: 1, consumers: 1, links: 1, used: 0 })
  })
  it.each(['consumer', 'link'])('actual %s insert failure rolls back the source and entire fanout', async which => {
    const created = await management.create(input())
    const table = which === 'consumer' ? 'meta_automation_outbox_consumer' : 'integration_yida_auto_outbox_links'
    await pool.query(`CREATE FUNCTION fail_yida_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'SA06D_TEST_ENQUEUE_FAILURE'; END; $$;
      CREATE TRIGGER fail_yida_enqueue BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_yida_enqueue();`)
    await expect(management.requestManual(created.grantId, { requestKey: 'rollback' })).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect(await queueCounts()).toEqual({ requests: 0, events: 0, consumers: 0, links: 0, used: 0 })
  })
  it('lost COMMIT response preserves durable request history and never enqueues a second occurrence', async () => {
    const created = await management.create(input())
    loseManagementCommit = true
    await expect(management.requestManual(created.grantId, { requestKey: 'lost' })).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect(await queueCounts()).toEqual({ requests: 1, events: 1, consumers: 1, links: 1, used: 0 })
    expect(await management.requestManual(created.grantId, { requestKey: 'lost' }))
      .toMatchObject({ reused: true, deliveryQueued: true, canSend: false })
    expect(await queueCounts()).toEqual({ requests: 1, events: 1, consumers: 1, links: 1, used: 0 })
  })
  it('queued replay remains history after revocation and cannot allocate fresh work', async () => {
    const created = await management.create(input())
    const accepted = await management.requestManual(created.grantId, { requestKey: 'before-revoke' })
    await management.revoke(created.grantId)
    expect(await management.requestManual(created.grantId, { requestKey: 'before-revoke' })).toEqual({ ...accepted, reused: true })
    await expect(management.requestManual(created.grantId, { requestKey: 'after-revoke' })).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect(await queueCounts()).toEqual({ requests: 1, events: 1, consumers: 1, links: 1, used: 0 })
  })
  it('an old unlinked internal reservation cannot be upgraded into delivery on replay', async () => {
    const created = await management.create(input())
    await management.reserveManual(created.grantId, { requestKey: 'unlinked' })
    await expect(management.requestManual(created.grantId, { requestKey: 'unlinked' })).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect(await queueCounts()).toEqual({ requests: 1, events: 0, consumers: 0, links: 0, used: 0 })
  })
  it('request input cannot supply an outbox, consumer, actor or payload', async () => {
    const created = await management.create(input())
    managementTransactions = 0
    for (const key of ['outboxId', 'consumerKey', 'actorId', 'payload', 'grantId']) {
      await expect(management.requestManual(created.grantId, { requestKey: 'injected', [key]: 'forged' }))
        .rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_INPUT')
    }
    expect(managementTransactions).toBe(0)
  })
  it('link facts resist deletion, truncation and outbox cleanup, and migration replay preserves them', async () => {
    const created = await management.create(input())
    await management.requestManual(created.grantId, { requestKey: 'retained' })
    await expect(pool.query('DELETE FROM integration_yida_auto_outbox_links')).rejects.toThrow('YIDA_AUTO_IMMUTABLE')
    await expect(pool.query('TRUNCATE integration_yida_auto_outbox_links')).rejects.toThrow('YIDA_AUTO_IMMUTABLE')
    await expect(pool.query('DELETE FROM meta_automation_outbox')).rejects.toThrow()
    await pool.query(readFileSync(path.join(root, 'packages/core-backend/migrations/zzzz20261019121000_link_integration_yida_automation_outbox.sql'), 'utf8'))
    expect(await queueCounts()).toEqual({ requests: 1, events: 1, consumers: 1, links: 1, used: 0 })
  })
  it('actual SQL link identity independently rejects all five producer mismatches', async () => {
    const created = await management.create(input())
    const reserved = await management.reserveManual(created.grantId, { requestKey: 'identity' })
    // Each negative has its own actual transaction/rollback; reusing the SAME
    // unchanged fixture avoids five complete schema builds, not any assertion.
    for (const wrong of ['eventType', 'eventId', 'payload', 'depth', 'version']) {
      await expect(transaction(async trx => {
        const outbox = await enqueueOutboxEvent(trx as TransactionalQueryable, {
          eventType: wrong === 'eventType' ? 'approval.approved' : YIDA_AUTOMATION_EVENT,
          eventId: wrong === 'eventId' ? 'unbound-event' : 'yida-automation:' + reserved.requestId,
          payload: wrong === 'payload' ? { requestId: reserved.requestId, ownerId: 'forged' } : { requestId: reserved.requestId },
          automationDepth: wrong === 'depth' ? 1 : 0,
        }, wrong === 'version' ? { ...YIDA_AUTOMATION_ROUTING_CANDIDATE, version: 4 } : YIDA_AUTOMATION_ROUTING_CANDIDATE)
        await trx.query(`INSERT INTO integration_yida_auto_outbox_links(grant_id,request_id,outbox_id,consumer_key)
          VALUES ($1,$2,$3,$4)`, [created.grantId, reserved.requestId, outbox.outboxId, YIDA_AUTOMATION_CONSUMER])
      })).rejects.toThrow('YIDA_AUTO_OUTBOX_IDENTITY')
      expect(await queueCounts()).toEqual({ requests: 1, events: 0, consumers: 0, links: 0, used: 0 })
    }
  })
  it('expiry after the actual link insert rolls back the entire new enqueue', async () => {
    const created = await management.create(input())
    advanceManagementClockAfterLink = true
    await expect(management.requestManual(created.grantId, { requestKey: 'late-enqueue' })).rejects.toThrow('YIDA_AUTOMATION_MANAGEMENT_DENIED')
    expect(await queueCounts()).toEqual({ requests: 0, events: 0, consumers: 0, links: 0, used: 0 })
  })
})
