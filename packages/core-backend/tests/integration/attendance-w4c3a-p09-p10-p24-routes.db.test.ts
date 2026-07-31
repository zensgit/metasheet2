import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { fetch as undiciFetch } from 'undici'
import type { MetaSheetServer } from '../../src/index'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const fixturePrefix = `w4c3a-p09p10-p24-${randomUUID().slice(0, 8)}`
const workDate = '2026-07-20'
const dingTalkCorpId = `${fixturePrefix}-corp`
const setupFetch = globalThis.fetch

type RouteResponse = { status: number; raw: string; body: Record<string, unknown> | null }
type BusinessCounts = {
  records: number
  importBatches: number
  importItems: number
  operationBatches: number
  operations: number
  calculations: number
  outbox: number
}

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('expected a loopback TCP address'))
    })
  })
}

async function canListen(): Promise<boolean> {
  const probe = net.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

function requestHttp(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RouteResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const request = http.request(
      {
        method: options.method ?? 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (response) => {
        let raw = ''
        response.on('data', (chunk) => { raw += String(chunk) })
        response.on('end', () => {
          let body: Record<string, unknown> | null = null
          try { body = raw ? JSON.parse(raw) as Record<string, unknown> : null } catch { body = null }
          resolve({ status: response.statusCode ?? 0, raw, body })
        })
      },
    )
    request.on('error', reject)
    if (options.body) request.write(options.body)
    request.end()
  })
}

describeIfDatabase('W4C-3a P09/P10/P24 route acceptance (real plugin routes, real PostgreSQL)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let baseUrl = ''
  let dingTalkBaseUrl = ''
  let dingTalkServer: http.Server
  let failDingTalkTokenRequest = false
  const priorEnv = {
    databaseUrl: process.env.DATABASE_URL,
    rbacBypass: process.env.RBAC_BYPASS,
    skipPlugins: process.env.SKIP_PLUGINS,
    segmentCalculationEnabled: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
    allowedCorpIds: process.env.DINGTALK_ALLOWED_CORP_IDS,
  }

  async function requestJson(pathname: string, token: string, body: Record<string, unknown>): Promise<RouteResponse> {
    return requestHttp(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function mintToken(userId: string): Promise<string> {
    const response = await requestHttp(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
    )
    const token = response.body?.token
    if (typeof token !== 'string' || !token) throw new Error(`failed to mint test token: ${response.raw}`)
    return token
  }

  async function seedActorAndRollout(state: 'legacy' | 'shadow'): Promise<{ orgId: string; actorId: string; token: string }> {
    const orgId = randomUUID()
    const actorId = randomUUID()
	    // The rollout resolver requires the exact org key; a truthy/wildcard
	    // value is deliberately insufficient proof of shadow eligibility.
	    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
    await pool.query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-3a route fixture', 'x', 'user', '[]'::jsonb, true, false, now(), now())`,
      [actorId, `${fixturePrefix}-${actorId}@example.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
      [actorId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
       (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, $2, 'w4c3a-route-acceptance', 'TEST_FIXTURE', $3, 1, NULL, 'synthetic_staging')`,
      [orgId, state, actorId],
    )
    return { orgId, actorId, token: await mintToken(actorId) }
  }

  async function seedLegacyRecord(orgId: string, userId: string): Promise<string> {
    const recordId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_records
       (id, org_id, user_id, work_date, timezone, work_minutes, late_minutes,
        early_leave_minutes, status, is_workday, meta, created_at, updated_at)
       VALUES ($1, $2, $3, $4::date, 'UTC', 0, 0, 0, 'normal', true, '{}'::jsonb, now(), now())`,
      [recordId, orgId, userId, workDate],
    )
    return recordId
  }

  async function createIntegration(orgId: string, sourceUserId: string, tag: string, lastSyncAt: string | null = null): Promise<string> {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO attendance_integrations
       (id, org_id, name, type, status, config, last_sync_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'dingtalk', 'active', $4::jsonb, $5::timestamptz, now(), now())`,
      [
        id,
        orgId,
        `${fixturePrefix}-${tag}`,
        JSON.stringify({
          appKey: `${fixturePrefix}-key-${tag}`,
          appSecret: `${fixturePrefix}-secret-${tag}`,
          corpId: dingTalkCorpId,
          baseUrl: dingTalkBaseUrl,
          userIds: [sourceUserId],
          columnIds: ['employee', 'in', 'out', 'work'],
          columns: [
            { id: 'employee', alias: 'sourceUserKey' },
            { id: 'in', alias: 'firstInAt' },
            { id: 'out', alias: 'lastOutAt' },
            { id: 'work', alias: 'workMinutes' },
          ],
          userMapKeyField: 'sourceUserKey',
          userMapSourceFields: ['sourceUserKey'],
          userMap: { [sourceUserId]: sourceUserId },
        }),
        lastSyncAt,
      ],
    )
    return id
  }

  async function businessCounts(orgId: string): Promise<BusinessCounts> {
    const result = await pool.query<BusinessCounts>(
      `SELECT
         (SELECT count(*)::int FROM attendance_records WHERE org_id = $1) AS "records",
         (SELECT count(*)::int FROM attendance_import_batches WHERE org_id = $1) AS "importBatches",
         (SELECT count(*)::int FROM attendance_import_items WHERE org_id = $1) AS "importItems",
         (SELECT count(*)::int FROM attendance_result_operation_batches WHERE org_id = $1) AS "operationBatches",
         (SELECT count(*)::int FROM attendance_result_operations WHERE org_id = $1) AS "operations",
         (SELECT count(*)::int FROM attendance_record_calculations WHERE org_id = $1) AS "calculations",
         (SELECT count(*)::int FROM attendance_result_event_outbox WHERE org_id = $1) AS "outbox"`,
      [orgId],
    )
    return result.rows[0]
  }

  async function canonicalOperationCounts(orgId: string): Promise<{ batches: number; operations: number }> {
    const result = await pool.query<{ batches: number; operations: number }>(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operation_batches WHERE org_id = $1) AS batches,
         (SELECT count(*)::int FROM attendance_result_operations WHERE org_id = $1) AS operations`,
      [orgId],
    )
    return result.rows[0]
  }

  beforeAll(async () => {
    if (!dbUrl || !(await canListen())) {
      throw new Error('W4C-3a route acceptance needs DATABASE_URL and a loopback port')
    }
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = '1'
    process.env.DINGTALK_ALLOWED_CORP_IDS = dingTalkCorpId
    vi.stubGlobal('fetch', undiciFetch)

    dingTalkServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'GET' && url.pathname === '/gettoken') {
        if (failDingTalkTokenRequest) {
          res.statusCode = 500
          res.end(JSON.stringify({ errcode: 500, errmsg: 'synthetic token failure' }))
          return
        }
        res.end(JSON.stringify({ access_token: `${fixturePrefix}-token`, expires_in: 7200 }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/topapi/attendance/getcolumnval') {
        let requestBody = ''
        req.on('data', (chunk) => { requestBody += String(chunk) })
        req.on('end', () => {
          const userId = JSON.parse(requestBody || '{}').userid
          res.end(JSON.stringify({
            result: {
              column_vals: [
                { column_vo: { id: 'employee' }, column_vals: [{ date: workDate, value: userId }] },
                { column_vo: { id: 'in' }, column_vals: [{ date: workDate, value: `${workDate} 09:00:00` }] },
                { column_vo: { id: 'out' }, column_vals: [{ date: workDate, value: `${workDate} 18:00:00` }] },
                { column_vo: { id: 'work' }, column_vals: [{ date: workDate, value: 17, userId }] },
              ],
            },
          }))
        })
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not found' }))
    })
    dingTalkBaseUrl = `http://127.0.0.1:${await listen(dingTalkServer)}`

    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('attendance server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })
    const requiredTables = [
      'attendance_calculation_rollout_state',
      'attendance_integrations',
      'attendance_integration_runs',
      'attendance_import_batches',
      'attendance_import_items',
      'attendance_records',
      'attendance_result_operation_batches',
      'attendance_result_operations',
      'attendance_record_calculations',
      'attendance_result_event_outbox',
    ]
    const availability = await pool.query<{ table_name: string; exists: boolean }>(
      `SELECT table_name, to_regclass(table_name) IS NOT NULL AS exists
         FROM unnest($1::text[]) AS table_name`,
      [requiredTables],
    )
    const missing = availability.rows.filter((row) => !row.exists).map((row) => row.table_name)
    if (missing.length) throw new Error(`W4C3A_ROUTE_TEST_SCHEMA_MISSING:${missing.join(',')}`)
  }, 120000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    await new Promise<void>((resolve) => dingTalkServer?.close(() => resolve()))
    if (server) await server.stop()
    vi.stubGlobal('fetch', setupFetch)
    for (const [key, value] of Object.entries({
      DATABASE_URL: priorEnv.databaseUrl,
      RBAC_BYPASS: priorEnv.rbacBypass,
      SKIP_PLUGINS: priorEnv.skipPlugins,
      ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED: priorEnv.segmentCalculationEnabled,
      DINGTALK_ALLOWED_CORP_IDS: priorEnv.allowedCorpIds,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }, 60000)

  it('P09: legacy_projection_only retains the frozen legacy POST /api/attendance/import response bytes', async () => {
    const { orgId, actorId, token } = await seedActorAndRollout('legacy')
    const recordId = await seedLegacyRecord(orgId, actorId)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const response = await requestJson('/api/attendance/import', token, {
        orgId,
        userId: actorId,
        returnItems: false,
        rows: [{ userId: actorId, workDate, fields: { workMinutes: 480 } }],
      })
      expect(response.status, response.raw).toBe(200)
      expect(response.raw).toBe(
        JSON.stringify({
          ok: true,
          data: {
            imported: 1,
            processedRows: 1,
            failedRows: 0,
            elapsedMs: 0,
            engine: 'standard',
            recordUpsertStrategy: 'unnest',
            batchId: null,
            idempotent: false,
            // The legacy handler always returns this item even when returnItems is false.
            items: [{ id: recordId, userId: actorId, workDate, engine: null }],
            itemsTruncated: false,
            skipped: [],
            csvWarnings: [],
            groupWarnings: [],
            meta: null,
          },
        }),
      )
      expect(await canonicalOperationCounts(orgId)).toEqual({ batches: 0, operations: 0 })
	    const persisted = await businessCounts(orgId)
	    expect(persisted.importBatches).toBe(1)
	    expect(persisted.importItems).toBe(1)
    } finally {
      now.mockRestore()
    }
  })

  it('P09: shadow legacy import seals a canonical prepared operation instead of its private row loop', async () => {
    const legacy = await seedActorAndRollout('shadow')
    const legacyResponse = await requestJson('/api/attendance/import', legacy.token, {
      orgId: legacy.orgId,
      userId: legacy.actorId,
      rows: [{ userId: legacy.actorId, workDate, fields: { workMinutes: 480 } }],
    })
    expect(legacyResponse.status, legacyResponse.raw).toBe(200)
    expect(await canonicalOperationCounts(legacy.orgId)).toEqual({ batches: 1, operations: 1 })
	  const persisted = await businessCounts(legacy.orgId)
	  expect(persisted.importBatches).toBe(1)
	  expect(persisted.importItems).toBe(1)
  })

  it('P10: shadow integration sync apply seals the same canonical prepared-operation boundary', async () => {
    const sync = await seedActorAndRollout('shadow')
    const integrationId = await createIntegration(sync.orgId, sync.actorId, 'canonical')
    const syncResponse = await requestJson(
      `/api/attendance/integrations/${integrationId}/sync`,
      sync.token,
      { orgId: sync.orgId, from: workDate, to: workDate },
    )
    expect(syncResponse.status, syncResponse.raw).toBe(200)
    expect(await canonicalOperationCounts(sync.orgId)).toEqual({ batches: 1, operations: 1 })
  })

  it('P10: exact imported metric presence that disagrees with the frozen canonical result returns import_metric_conflict before import/result DML', async () => {
    const fixture = await seedActorAndRollout('shadow')
    const integrationId = await createIntegration(fixture.orgId, fixture.actorId, 'metric-conflict')
    const before = await businessCounts(fixture.orgId)

    const response = await requestJson(
      `/api/attendance/integrations/${integrationId}/sync`,
      fixture.token,
      { orgId: fixture.orgId, from: workDate, to: workDate },
    )

    expect(response.status, response.raw).toBe(409)
    expect((response.body?.error as { code?: string } | undefined)?.code).toBe('import_metric_conflict')
    expect(await businessCounts(fixture.orgId)).toEqual(before)
  })

  it('P24: dryRun appends one integration audit attempt only, preserving every attendance business table and last_sync_at', async () => {
    const fixture = await seedActorAndRollout('shadow')
    const lastSyncAt = '2024-01-02T03:04:05.000Z'
    const integrationId = await createIntegration(fixture.orgId, fixture.actorId, 'dry-run', lastSyncAt)
    const beforeBusiness = await businessCounts(fixture.orgId)
    const beforeRuns = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM attendance_integration_runs WHERE integration_id = $1',
      [integrationId],
    )

    const response = await requestJson(
      `/api/attendance/integrations/${integrationId}/sync`,
      fixture.token,
      { orgId: fixture.orgId, from: workDate, to: workDate, dryRun: true },
    )

    expect(response.status, response.raw).toBe(200)
    expect(await businessCounts(fixture.orgId)).toEqual(beforeBusiness)
    const afterRuns = await pool.query<{ count: number; terminal: number }>(
      `SELECT count(*)::int AS count,
              count(*) FILTER (WHERE status IN ('success', 'partial', 'failed'))::int AS terminal
         FROM attendance_integration_runs
        WHERE integration_id = $1`,
      [integrationId],
    )
    expect(afterRuns.rows[0]).toEqual({ count: beforeRuns.rows[0].count + 1, terminal: 1 })
    const integration = await pool.query<{ unchanged: boolean }>(
      'SELECT last_sync_at = $2::timestamptz AS unchanged FROM attendance_integrations WHERE id = $1',
      [integrationId, lastSyncAt],
    )
    expect(integration.rows[0]).toEqual({ unchanged: true })
  })

  it('P24: failed dryRun appends one failed audit attempt without advancing last_sync_at or business state', async () => {
    const fixture = await seedActorAndRollout('shadow')
    const lastSyncAt = '2024-01-02T03:04:05.000Z'
    const integrationId = await createIntegration(fixture.orgId, fixture.actorId, 'dry-run-failure', lastSyncAt)
    const beforeBusiness = await businessCounts(fixture.orgId)
    const beforeRuns = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM attendance_integration_runs WHERE integration_id = $1',
      [integrationId],
    )

    failDingTalkTokenRequest = true
    try {
      const response = await requestJson(
        `/api/attendance/integrations/${integrationId}/sync`,
        fixture.token,
        { orgId: fixture.orgId, from: workDate, to: workDate, dryRun: true },
      )

      expect(response.status, response.raw).toBe(500)
      expect(await businessCounts(fixture.orgId)).toEqual(beforeBusiness)
      const afterRuns = await pool.query<{ count: number; failed: number; message: string | null }>(
        `SELECT count(*)::int AS count,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                max(message) FILTER (WHERE status = 'failed') AS message
           FROM attendance_integration_runs
          WHERE integration_id = $1`,
        [integrationId],
      )
      expect(afterRuns.rows[0]).toEqual({
        count: beforeRuns.rows[0].count + 1,
        failed: 1,
        message: 'synthetic token failure',
      })
      const integration = await pool.query<{ unchanged: boolean }>(
        'SELECT last_sync_at = $2::timestamptz AS unchanged FROM attendance_integrations WHERE id = $1',
        [integrationId, lastSyncAt],
      )
      expect(integration.rows[0]).toEqual({ unchanged: true })
    } finally {
      failDingTalkTokenRequest = false
    }
  })

  it.skip('P09/P10 scale 5000 accepted and 5001 rejected before DML: pending canonical route wiring; exercising 5001 against the current private per-row routes would itself perform the DML this leg must prove absent')
})
