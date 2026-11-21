/** The real capability writer/router and production notification precondition, in an owned PG schema. */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  escapedQuery: vi.fn(async (_text: string, _params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> => {
    throw new Error('notification precondition escaped its transaction')
  }),
  network: vi.fn(async () => { throw new Error('notification precondition attempted network access') }),
}))
vi.mock('../../src/db/pg', () => ({ pool: null, query: boundary.escapedQuery, transaction: boundary.escapedQuery }))
vi.mock('../../src/routes/admin-directory', () => ({ ensurePlatformAdmin: async () => 'synthetic-notification-admin' }))
vi.mock('../../src/auth/dingtalk-oauth', () => ({ getDingTalkRuntimeStatus: () => ({ available: false }) }))
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn() }))

import { up as upUsers } from '../../src/db/migrations/zzzz20260119100000_create_users_table'
import { up as upDirectory } from '../../src/db/migrations/zzzz20260324150000_create_directory_sync_tables'
import { up as upDirectoryParents } from '../../src/db/migrations/zzzz20260717120000_create_provider_org_transfers'
import { up as upCapabilities } from '../../src/db/migrations/zzzz20261106130000_create_directory_integration_capabilities'
import { up as upEndpoints } from '../../src/db/migrations/zzzz20261111093417_create_user_notification_endpoints_preferences'
import { up as upVerification } from '../../src/db/migrations/zzzz20261121130000_create_notification_verifications_test_sends'
import { createDirectoryIntegrationCapabilitiesService } from '../../src/integrations/directory-integration-capabilities-service'
import {
  PRODUCTION_CAPABILITY_ENABLE_GATES,
  createDirectoryIntegrationCapabilitiesWriteService,
  type CapabilityAuditEvent,
} from '../../src/integrations/directory-integration-capabilities-write-service'
import { isCapabilityImplementationAvailable } from '../../src/integrations/integration-capability-implementations'
import { resolveProviderCapabilityDescriptor, type CapabilityTransactionClient } from '../../src/integrations/provider-capability-registry'
import { createAdminDirectoryCapabilitiesRouter } from '../../src/routes/admin-directory-capabilities'
import { writeNotificationVerification } from '../../src/notifications/verification-evidence'
import { sha256Hex } from '../../src/notifications/witness'
import { usePinnedServer } from '../utils/pinned-server'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const SCHEMA = `n78_capability_${randomUUID().replaceAll('-', '')}`
const BASE = '/api/admin/directory/integration-capabilities'
const ACTOR = 'synthetic-notification-admin'
const TENANT = 'SyntheticNotificationTenant'
const APP = 'SyntheticNotificationApp'
const DEFAULT_CONFIG = {
  appKey: APP,
  appSecret: 'synthetic-notification-secret',
  workNotificationAgentId: '12345',
  baseUrl: 'https://oapi.dingtalk.com',
}
const fingerprintOf = (config = DEFAULT_CONFIG) => sha256Hex('mx.notif.tuple.v1', {
  provider: 'dingtalk', appKey: config.appKey, agentId: config.workNotificationAgentId,
  baseUrl: config.baseUrl.trim().replace(/\/+$/, ''), secret: config.appSecret,
})

describeIfDatabase('notification capability production precondition (real database)', () => {
  const pinned = usePinnedServer()
  let adminPool: Pool
  let pool: Pool
  let migrationDb: Kysely<unknown>
  let integrationId: string
  let injectBeforePrecondition: ((client: PoolClient) => Promise<void>) | undefined
  const statements: string[] = []
  const audits: CapabilityAuditEvent[] = []

  async function evidence(client: CapabilityTransactionClient = pool, config = DEFAULT_CONFIG) {
    await writeNotificationVerification(client, {
      connectionId: integrationId, provider: 'dingtalk', scope: { tenant: TENANT, appScope: config.appKey },
      tupleFingerprint: fingerprintOf(config), verifiedBy: ACTOR,
      report: { requestedLevel: 'token', reachedLevel: 'token', failure: null },
    })
  }

  function mountProductionConsumers() {
    const view = {
      resolveDescriptor: resolveProviderCapabilityDescriptor,
      isImplementationAvailable: isCapabilityImplementationAvailable,
      readLoginRuntime: () => ({ available: false, requireGrant: false, autoLinkEmail: false, autoProvision: false }),
      isIntegrationScopedCredentialsEnabled: () => true,
    }
    const service = createDirectoryIntegrationCapabilitiesService({
      ...view, isEnabled: () => true, executor: { query: (text, params) => pool.query(text, params) as never },
    })
    const writer = createDirectoryIntegrationCapabilitiesWriteService({
      ...view, isEnabled: () => true, capabilityGates: PRODUCTION_CAPABILITY_ENABLE_GATES,
      audit: async (event) => { audits.push(event) },
      transaction: async (work) => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const result = await work({
            query: async (text, params) => {
              statements.push(text)
              const result = await client.query(text, params)
              // The write owns both locks now. These fixture writes stay uncommitted until it finishes.
              if (injectBeforePrecondition && /FROM directory_integration_capabilities[\s\S]+FOR UPDATE/.test(text)) {
                const inject = injectBeforePrecondition
                injectBeforePrecondition = undefined
                await inject(client)
              }
              return result
            },
          })
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        } finally { client.release() }
      },
    })
    const app = express()
    app.use(express.json())
    app.use(BASE, createAdminDirectoryCapabilitiesRouter({ service, writer }))
    pinned.setApp(app)
  }

  const patch = (enabled = true, expectedRevision = 0) => request(pinned.url())
    .patch(`${BASE}/${integrationId}`)
    .send({ expectedRevision, capabilities: { notification: enabled } })

  async function expectRefused(reason: string) {
    const response = await patch()
    expect(response.status).toBe(409)
    expect(response.body.error).toMatchObject({
      code: 'CAPABILITY_PRECONDITION_FAILED', details: { capability: 'notification', reason },
    })
    expect((await pool.query('SELECT count(*)::integer AS n FROM directory_integration_capabilities WHERE integration_id=$1', [integrationId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::integer AS n FROM directory_integration_capability_history WHERE integration_id=$1', [integrationId])).rows[0].n).toBe(0)
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: dbUrl, max: 1 })
    expect((await adminPool.query("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto') AS installed")).rows[0].installed).toBe(true)
    await adminPool.query(`CREATE SCHEMA "${SCHEMA}"`)
    const options = `-c search_path=${SCHEMA},pg_catalog`
    pool = new Pool({ connectionString: dbUrl, options, max: 3 })
    migrationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl, options, max: 1 }) }) })
    await migrationDb.transaction().execute(async (trx) => {
      await upUsers(trx)
      await upDirectory(trx)
      await upDirectoryParents(trx)
      await upCapabilities(trx)
      await upEndpoints(trx)
      await upVerification(trx)
    })
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    boundary.escapedQuery.mockReset().mockRejectedValue(new Error('notification precondition escaped its transaction'))
    vi.stubGlobal('fetch', boundary.network)
    for (const name of [
      'DINGTALK_APP_KEY', 'DINGTALK_CLIENT_ID', 'DINGTALK_APP_SECRET', 'DINGTALK_CLIENT_SECRET',
      'DINGTALK_AGENT_ID', 'DINGTALK_NOTIFY_AGENT_ID', 'DINGTALK_BASE_URL',
    ]) vi.stubEnv(name, '')
    vi.stubEnv('DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED', 'true')
    vi.stubEnv('USER_NOTIFICATION_PREFERENCES_ENABLED', 'true')
    statements.length = 0
    audits.length = 0
    injectBeforePrecondition = undefined
    expect((await pool.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(SCHEMA)
    const row = await pool.query(`INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
      VALUES ($1, 'dingtalk', 'Synthetic notification connection', 'active', $2, $3::jsonb) RETURNING id::text AS id`,
    [`n78-production-${randomUUID()}`, TENANT, JSON.stringify(DEFAULT_CONFIG)])
    integrationId = row.rows[0].id as string
    mountProductionConsumers()
  })

  afterEach(() => {
    expect(boundary.escapedQuery).not.toHaveBeenCalled()
    expect(boundary.network).not.toHaveBeenCalled()
    for (const value of [TENANT, APP, DEFAULT_CONFIG.appSecret, fingerprintOf()]) {
      expect(JSON.stringify(audits)).not.toContain(value)
    }
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    await migrationDb?.destroy()
    await pool?.end()
    if (adminPool) {
      try { await adminPool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`) }
      finally { await adminPool.end() }
    }
  })

  it('the production descriptor refuses notification enablement without evidence', async () => {
    expect(resolveProviderCapabilityDescriptor('dingtalk')!.governance.notification).toBe('gated')
    expect(isCapabilityImplementationAvailable('dingtalk', 'notification')).toBe(true)
    await expectRefused('verification_missing')
  })

  it('token evidence enables the production capability and GET omits legacy notification details', async () => {
    await evidence()
    const response = await patch()
    expect(response.status).toBe(200)
    expect(response.body.data.capabilities.notification).toMatchObject({ enabled: true, governance: 'gated', effective: true })
    expect(response.body.data.capabilities.notification).not.toHaveProperty('legacy')
    expect((await pool.query('SELECT notification_enabled, revision::text FROM directory_integration_capabilities WHERE integration_id=$1', [integrationId])).rows[0])
      .toEqual({ notification_enabled: true, revision: '1' })
    expect((await pool.query('SELECT notification_enabled, actor_id FROM directory_integration_capability_history WHERE integration_id=$1', [integrationId])).rows)
      .toEqual([{ notification_enabled: true, actor_id: ACTOR }])
    const shown = await request(pinned.url()).get(`${BASE}/${integrationId}`)
    expect(shown.status).toBe(200)
    expect(shown.body.data.capabilities.notification).not.toHaveProperty('legacy')
    expect(shown.body.data.capabilities.directory).toHaveProperty('legacy')
    for (const value of [TENANT, APP, DEFAULT_CONFIG.appSecret, fingerprintOf()]) expect(JSON.stringify(shown.body)).not.toContain(value)
  })

  it.each([
    ['invalidated_at = now()', 'verification_invalidated'],
    ["verified_at = now() - interval '31 days'", 'verification_stale'],
    ["bound_app_scope = 'AnotherSyntheticApp'", 'verification_anchor_changed'],
  ])('persisted evidence refuses enablement after %s', async (assignment, reason) => {
    await evidence()
    await pool.query(`UPDATE notification_connection_verifications SET ${assignment} WHERE connection_id=$1`, [integrationId])
    await expectRefused(reason)
  })

  it.each([
    ['appSecret', 'synthetic-rotated-secret'],
    ['workNotificationAgentId', '54321'],
    ['baseUrl', 'https://api.dingtalk.com'],
  ])('a changed %s invalidates the actual tuple fingerprint', async (key, value) => {
    await evidence()
    await pool.query('UPDATE directory_integrations SET config=config || $2::jsonb WHERE id=$1', [integrationId, JSON.stringify({ [key]: value })])
    await expectRefused('verification_fingerprint_changed')
  })

  it('the production precondition reads both the tuple and evidence through the PATCH transaction', async () => {
    const changed = { ...DEFAULT_CONFIG, appSecret: 'synthetic-uncommitted-secret' }
    injectBeforePrecondition = async (client) => {
      await client.query('UPDATE directory_integrations SET config=$2::jsonb WHERE id=$1', [integrationId, JSON.stringify(changed)])
      await evidence(client, changed)
      // Another connection sees neither fixture write until the capability transaction commits.
      expect((await pool.query('SELECT config->>\'appSecret\' AS secret FROM directory_integrations WHERE id=$1', [integrationId])).rows[0].secret).toBe(DEFAULT_CONFIG.appSecret)
      expect((await pool.query('SELECT count(*)::integer AS n FROM notification_connection_verifications WHERE connection_id=$1', [integrationId])).rows[0].n).toBe(0)
    }
    const response = await patch()
    expect(response.status).toBe(200)
    expect(response.body.data.capabilities.notification.effective).toBe(true)
    const tupleRead = statements.findIndex((text) => /FROM directory_integrations/.test(text) && /LIMIT 1/.test(text))
    const evidenceRead = statements.findIndex((text) => /FROM notification_connection_verifications/.test(text))
    const capabilityWrite = statements.findIndex((text) => /INSERT INTO directory_integration_capabilities/.test(text))
    expect(tupleRead).toBeGreaterThan(-1)
    expect(evidenceRead).toBeGreaterThan(tupleRead)
    expect(capabilityWrite).toBeGreaterThan(evidenceRead)
    expect(statements[tupleRead]).not.toMatch(/FOR (?:SHARE|UPDATE)|LOCK TABLE/)
    expect(statements[evidenceRead]).not.toMatch(/FOR (?:SHARE|UPDATE)|LOCK TABLE/)
  })

  it('O-1 refuses committed evidence after a tuple change visible only to the write client', async () => {
    await evidence()
    // A broken no-client reader can really read the old committed tuple: the failure must be
    // the admission decision, rather than an artificial exception from the pool boundary.
    boundary.escapedQuery.mockImplementation((text, params) => pool.query(text, params))
    injectBeforePrecondition = async (client) => {
      await client.query("UPDATE directory_integrations SET config=jsonb_set(config,'{appSecret}',to_jsonb('synthetic-uncommitted-rotation'::text)) WHERE id=$1", [integrationId])
      expect((await pool.query("SELECT config->>'appSecret' AS secret FROM directory_integrations WHERE id=$1", [integrationId])).rows[0].secret)
        .toBe(DEFAULT_CONFIG.appSecret)
    }
    await expectRefused('verification_fingerprint_changed')
    // The injected fixture change commits, while the refused capability and history stay absent.
    expect((await pool.query("SELECT config->>'appSecret' AS secret FROM directory_integrations WHERE id=$1", [integrationId])).rows[0].secret)
      .toBe('synthetic-uncommitted-rotation')
  })

  it('O-1 refuses evidence invalidated only inside the capability write transaction', async () => {
    await evidence()
    boundary.escapedQuery.mockImplementation((text, params) => pool.query(text, params))
    injectBeforePrecondition = async (client) => {
      await client.query('UPDATE notification_connection_verifications SET invalidated_at=now() WHERE connection_id=$1', [integrationId])
      expect((await pool.query('SELECT invalidated_at FROM notification_connection_verifications WHERE connection_id=$1', [integrationId])).rows[0].invalidated_at)
        .toBeNull()
    }
    await expectRefused('verification_invalidated')
    expect((await pool.query('SELECT invalidated_at FROM notification_connection_verifications WHERE connection_id=$1', [integrationId])).rows[0].invalidated_at)
      .not.toBeNull()
  })

  it('disable remains available after verification evidence is invalidated', async () => {
    await evidence()
    expect((await patch()).status).toBe(200)
    await pool.query('UPDATE notification_connection_verifications SET invalidated_at=now() WHERE connection_id=$1', [integrationId])
    statements.length = 0
    const response = await patch(false, 1)
    expect(response.status).toBe(200)
    expect(response.body.data.capabilities.notification).toMatchObject({ enabled: false, effective: false })
    expect(statements.some((text) => /FROM notification_connection_verifications/.test(text))).toBe(false)
  })
})
