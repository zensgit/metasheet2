// Synthetic real-PG/crypto/native composition. Not a host installation or JWT
// substitute. Only accepts the wrapper's newly created loopback disposable DB.
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { PluginRuntimeSecurityService } from '../../src/security/plugin-runtime-security-service'
import { createYidaAutomationAuthorizationService } from '../../src/integration/yida-automation-authorization-service'
import { createYidaAutomationExecutionAuthority, type YidaAutomationExecutionPrimitives } from '../../src/integration/yida-automation-execution-authority'
import { createYidaAutomationSendRuntime } from '../../src/integration/yida-automation-send-runtime'
import { claimDueConsumers, type Queryable } from '../../src/multitable/automation-durable-dispatcher'
import { YIDA_AUTOMATION_CONSUMER } from '../../src/integration/yida-automation-outbox'
import { up as migrateOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const requireCjs = createRequire(import.meta.url)
const importNative = requireCjs('./yida-native-module-import.cjs')
const lib = path.join(root, 'plugins/plugin-integration-core/lib')
export const executionFixtureScope = { tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner' } as const
const scope = executionFixtureScope
const actor = { actorId: scope.ownerId, tenantId: scope.tenantId, workspaceId: null } as const
const binding = { baseId: 'synthetic-base', sheetId: 'synthetic-sheet', projectField: 'projectNo' }
const activationId = '22222222-2222-4222-8222-222222222222'
const revision = '11111111-1111-4111-8111-111111111111'
type Draft = { operationId: string; rows: Array<{ rowKey: string }> }
type Material = { credentialRef: string; credentialGeneration: number }

export async function createYidaAutomationExecutionFixture(connectionString: string,
  fixtureOptions: { approvedSecondRow?: boolean } = {}) {
  if (process.env.EXPECT_DB !== '1') throw new Error('SA06D_OWNED_DB_REQUIRED')
  const endpoint = new URL(connectionString)
  if (endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/plm_full_app_synthetic') throw new Error('SA06D_OWNED_DB_REQUIRED')
  const oldEnv = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'].map(key => [key, process.env[key]] as const)
  process.env.NODE_ENV = 'production'; process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex')
  process.env.ENCRYPTION_SALT = randomBytes(32).toString('hex')
  const security = new PluginRuntimeSecurityService()
  const schema = 'sa06dexec_' + randomUUID().replaceAll('-', '')
  const admin = new Pool({ connectionString, max: 1 })
  const pool = new Pool({ connectionString, max: 6, options: `-c search_path=${schema} -c statement_timeout=5000` })
  const controls: { enabled: unknown; mono: number; loseCommitResponse: boolean; beforeCommitFailure: boolean;
    caseCode: 'UNLABELLED' | 'TERMINAL_COMMIT_LOSS' | 'CLOSE_PROVIDER';
    statementCount: number; afterStatement?: (count: number) => void | Promise<void>;
    beforeCommitGate?: { reached(): void; wait: Promise<void> } } = {
      enabled: 'true', mono: 1000, loseCommitResponse: false, beforeCommitFailure: false, statementCount: 0, caseCode: 'UNLABELLED' }
  const authorities: ReturnType<typeof createYidaAutomationExecutionAuthority>[] = []
  let management: ReturnType<typeof createYidaAutomationAuthorizationService> | undefined
  let phase: 'SETUP' | 'OWNER_CREATE' | 'OWNER_REQUEST' | 'READY' = 'SETUP'
  let highestDbClock: number | null = null, dbClockRegressions = 0, maxBackwardMs = 0
  let persistedDbWatermark: number | null = null, lastClockBelowWatermark: boolean | null = null
  let lastStatementKind: 'CLOCK' | 'OTHER' = 'OTHER'
  function diagnostics() {
    return Object.freeze({ caseCode: controls.caseCode, phase, statementCount: controls.statementCount,
      dbClockRegressed: highestDbClock === null ? null : dbClockRegressions > 0, dbClockRegressions, maxBackwardMs,
      lastStatementKind, lastClockBelowWatermark })
  }
  async function cleanup() {
    authorities.forEach(authority => authority.close()); management?.close()
    await pool.end()
    if (!/^sa06dexec_[0-9a-f]{32}$/u.test(schema)) throw new Error('SA06D_SCHEMA_NOT_OWNED')
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()
    for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    // Keep every original migration/seed, but prepare this new private schema
    // in one real transaction. No runtime transaction, key derivation, timeout
    // or test assertion is replaced; the fixture is exposed only after COMMIT.
    await new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }).transaction().execute(async setup => {
    await migrateOutbox(setup)
    for (const file of ['090_create_integration_yida_delivery_ledger.sql', '091_create_integration_yida_create_fence.sql',
      '092_create_integration_yida_credential_materials.sql', '093_create_integration_yida_draft_plans.sql',
      '094_create_integration_yida_approved_target.sql', '097_create_integration_yida_automation_authorizations.sql',
      'zzzz20261019121000_link_integration_yida_automation_outbox.sql', '099_create_integration_yida_automation_execution_snapshots.sql']) {
      await sql.raw(readFileSync(path.join(root, 'packages/core-backend/migrations', file), 'utf8')).execute(setup)
    }
    await sql.raw(`CREATE TABLE users(id text PRIMARY KEY,role text,permissions jsonb,is_active boolean,activation_status text);
      CREATE TABLE user_roles(user_id text,role_id text,PRIMARY KEY(user_id,role_id));
      CREATE TABLE role_permissions(role_id text,permission_code text,PRIMARY KEY(role_id,permission_code));
      CREATE TABLE user_permissions(user_id text,permission_code text,PRIMARY KEY(user_id,permission_code));
      CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean,PRIMARY KEY(user_id,org_id));
      CREATE TABLE user_namespace_admissions(user_id text,namespace text,enabled boolean,UNIQUE(user_id,namespace));
      INSERT INTO users VALUES ('synthetic-owner','user','[]',true,'activated');
      INSERT INTO user_roles VALUES ('synthetic-owner','integration_admin');
      INSERT INTO user_permissions VALUES ('synthetic-owner','integration:admin');
      INSERT INTO user_orgs VALUES ('synthetic-owner','synthetic-tenant',true);
      INSERT INTO user_namespace_admissions VALUES ('synthetic-owner','integration',true);
      CREATE TABLE meta_bases(id text PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE meta_sheets(id text PRIMARY KEY,base_id text,deleted_at timestamptz);
      CREATE TABLE automation_rules(id text PRIMARY KEY,sheet_id text,name text,trigger_type text,trigger_config jsonb,
        action_type text,action_config jsonb,enabled boolean,created_at timestamptz,updated_at timestamptz,
        created_by text,conditions jsonb,actions jsonb,execution_mode text,integration_authority_revision text);
      INSERT INTO meta_bases VALUES ('synthetic-base',NULL);
      INSERT INTO meta_sheets VALUES ('synthetic-sheet','synthetic-base',NULL);
      INSERT INTO automation_rules VALUES ('synthetic-rule','synthetic-sheet','Synthetic','schedule.interval',
        '{"intervalMs":60000}','integration_yida_send_authorized','{"authorizationSlot":"synthetic-slot"}',true,
        clock_timestamp(),clock_timestamp(),'synthetic-owner',NULL,'[]','legacy','${revision}');`).execute(setup)
    })
    async function transaction<T>(work: (trx: Queryable) => Promise<T>) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        const observed: Queryable = { async query(sql, values) {
          const result = await client.query(sql, values)
          controls.statementCount += 1
          lastStatementKind = 'OTHER'
          // Values-free local sensor from the actual PG query result, not a
          // replacement clock or a guessed cause from an upstream error code.
          for (const row of result.rows) {
            if (typeof row.last_db_ms === 'string' && /^[0-9]{1,16}$/u.test(row.last_db_ms)) {
              const watermark = Number(row.last_db_ms)
              if (Number.isSafeInteger(watermark)) persistedDbWatermark = watermark
            }
            if (typeof row.now_ms !== 'string' || !/^[0-9]{1,16}$/u.test(row.now_ms)) continue
            const sample = Number(row.now_ms)
            if (!Number.isSafeInteger(sample)) continue
            lastStatementKind = 'CLOCK'
            lastClockBelowWatermark = persistedDbWatermark === null ? null : sample < persistedDbWatermark
            if (highestDbClock !== null && sample < highestDbClock) {
              dbClockRegressions += 1; maxBackwardMs = Math.max(maxBackwardMs, highestDbClock - sample)
            }
            highestDbClock = Math.max(highestDbClock ?? sample, sample)
          }
          await controls.afterStatement?.(controls.statementCount)
          return result
        } }
        const result = await work(observed)
        if (controls.beforeCommitFailure) { controls.beforeCommitFailure = false; throw new Error('SA06D_TEST_PRE_COMMIT_FAILURE') }
        if (controls.beforeCommitGate) {
          const gate = controls.beforeCommitGate; controls.beforeCommitGate = undefined
          gate.reached(); await gate.wait
        }
        await client.query('COMMIT')
        if (controls.loseCommitResponse) { controls.loseCommitResponse = false; throw new Error('SA06D_TEST_COMMIT_RESPONSE_LOST') }
        return result
      } catch (error) {
        // Synthetic-only, closed diagnostics BEFORE the production service
        // masks internal failures. Never log SQL, parameters, messages or stack.
        const message = error instanceof Error ? error.message : ''
        const code = /^(?:YIDA|SA06D|AUTOMATION)_[A-Z0-9_]{1,96}$/u.test(message) ? message : 'UNCLASSIFIED'
        process.stderr.write('SA06D_EXECUTION_FIXTURE_FAILURE ' + JSON.stringify({ ...diagnostics(), code }) + '\n')
        await client.query('ROLLBACK'); throw error
      }
      finally { client.release() }
    }
    const database = { transaction }
    const query = async (sql: string, values?: unknown[]) => (await pool.query(sql, values)).rows
    const db = requireCjs(path.join(lib, 'db.cjs')).createDb({ database: { query,
      transaction: <T>(work: (trx: { query: typeof query }) => Promise<T>) => transaction(trx =>
        work({ query: async (sql, values) => (await trx.query(sql, values)).rows })) } })
    const options = { db, security, context: scope }
    const drafts = (await importNative(pathToFileURL(path.join(lib, 'yida-draft-plan-store.mjs')).href)).createYidaDraftPlanStore(options)
    const target = (await importNative(pathToFileURL(path.join(lib, 'yida-approved-target-store.mjs')).href)).createYidaApprovedTargetStore(options)
    const native = await importNative(pathToFileURL(path.join(lib, 'yida-send-authority-primitives.mjs')).href)
    const materials = requireCjs(path.join(lib, 'yida-credential-material-store.cjs')).createYidaCredentialMaterialStore(options)
    const draft: Draft = await drafts.createDraft({ config: { version: 2, kind: 'yida-form-protocol-static', intent: 'create',
      target: { appType: 'synthetic_app', formUuid: 'synthetic_form' }, businessKey: ['projectNo', 'lineId'], emptyKeyFields: [],
      fieldCatalog: [{ id: 'project', control: 'text', required: true }, { id: 'line', control: 'text', required: true }],
      fieldMap: [{ source: 'projectNo', target: 'project', type: 'string', required: true },
        { source: 'lineId', target: 'line', type: 'string', required: true }] },
    rowsText: JSON.stringify([{ projectNo: 'DEMO-P1', lineId: 'L1' },
      ...(fixtureOptions.approvedSecondRow ? [{ projectNo: 'DEMO-P1', lineId: 'L2' }] : []),
      { projectNo: 'DEMO-P2', lineId: 'NOT-AUTHORIZED' }]), allocation: { mode: 'original' } })
    const credential: Material = await materials.create({ material: { appKey: 'synthetic-app', appSecret: 'synthetic-secret',
      systemToken: 'synthetic-system', userId: 'synthetic-executor' } })
    await target.register({ operationId: draft.operationId, credentialRef: credential.credentialRef,
      credentialGeneration: credential.credentialGeneration,
      attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-review', organizationId: 'synthetic-org', executionIdentity: 'synthetic-executor' } })
    const consent = () => ({ confirmationId: 'confirmation', ruleId: 'synthetic-rule', expectedRuleRevision: revision,
      actionId: 'synthetic-slot', projectNo: 'DEMO-P1', operationId: draft.operationId,
      rowKeys: draft.rows.slice(0, fixtureOptions.approvedSecondRow ? 2 : 1).map(row => row.rowKey),
      allowedTriggers: ['manual', 'schedule.interval'], maxExecutions: fixtureOptions.approvedSecondRow ? 2 : 1, ttlMs: 900000 })
    const primitives = native.createYidaSendAuthorityPrimitives({ security, context: scope }) as YidaAutomationExecutionPrimitives
    management = createYidaAutomationAuthorizationService({ grantor: actor, binding, primitives, database,
      activationId, monotonicNow: () => controls.mono })
    function execution(overrides: Partial<Parameters<typeof createYidaAutomationExecutionAuthority>[0]> = {}) {
      const workerId = overrides.workerId ?? 'synthetic-worker'
      const delegated = native.createInternalYidaAutomationAuthorityPrimitives({ security, context: scope, workerId }) as YidaAutomationExecutionPrimitives
      const authority = createYidaAutomationExecutionAuthority({ grantor: actor, binding, primitives: delegated,
        database, security, activationId, workerId, monotonicNow: () => controls.mono,
        readEnablement: () => controls.enabled, ...overrides })
      authorities.push(authority)
      return authority
    }
    const managementPort = management
    async function ready() {
      phase = 'OWNER_CREATE'
      const grant = await managementPort.create(consent())
      phase = 'OWNER_REQUEST'
      await managementPort.requestManual(grant.grantId, { requestKey: 'synthetic-request' })
      const now = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
      const claims = await claimDueConsumers(pool, { consumerKeys: [YIDA_AUTOMATION_CONSUMER], leaseMs: 60000, now: () => now })
      if (claims.length !== 1) throw new Error('SA06D_TEST_CLAIM_REQUIRED')
      phase = 'READY'
      return { grantId: grant.grantId, claim: claims[0] }
    }
    async function counts() {
      return (await pool.query(`SELECT (SELECT count(*)::int FROM integration_yida_delivery_ledger) AS ledgers,
        (SELECT count(*)::int FROM integration_yida_auto_admissions) AS admissions,
        (SELECT count(*)::int FROM integration_yida_auto_execution_snapshots) AS snapshots,
        (SELECT sum(used_executions)::int FROM integration_yida_auto_grants) AS used`)).rows[0]
    }
    const runner = await importNative(pathToFileURL(path.join(lib, 'yida-delivery-runner.mjs')).href)
    function runtime(fetcher: typeof fetch, overrides: Partial<Parameters<typeof createYidaAutomationSendRuntime>[0]> = {}) {
      const workerId = overrides.workerId ?? 'synthetic-worker'
      const delegated = native.createInternalYidaAutomationAuthorityPrimitives({ security, context: scope, workerId }) as YidaAutomationExecutionPrimitives
      return createYidaAutomationSendRuntime({ grantor: actor, binding, database, security, activationId, workerId,
        primitives: delegated, monotonicNow: () => controls.mono, readEnablement: () => controls.enabled,
        fetch: fetcher, createAttempt: options => runner.createInternalYidaAutomationSendAttempt({ db, ...options }), ...overrides })
    }
    return { pool, security, transaction, controls, management: managementPort, execution, ready, db, runner, runtime,
      counts, consent, credential, materials, primitives, diagnostics, cleanup }
  } catch (error) { await cleanup(); throw error }
}
