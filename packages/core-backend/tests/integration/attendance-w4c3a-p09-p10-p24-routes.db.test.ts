import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Pool } from 'pg'
import { fetch as undiciFetch } from 'undici'
import type { MetaSheetServer } from '../../src/index'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const fixturePrefix = `w4c3a-p09p10-p24-${randomUUID().slice(0, 8)}`
const workDate = '2026-07-20'
const dingTalkCorpId = `${fixturePrefix}-corp`
const setupFetch = globalThis.fetch
const require = createRequire(import.meta.url)

type AttendanceReportSyncHelpers = {
  syncAttendanceReportRecords(
    context: Record<string, unknown>,
    db: { query(sql: string, params?: unknown[]): Promise<unknown[]> },
    orgId: string,
    logger: { warn(): void },
    params: { from: string; to: string; userId: string },
  ): Promise<{ synced: number; created: number }>
  loadAttendanceReportRecordsSyncUserPage(
    db: { query(sql: string, params?: unknown[]): Promise<unknown[]> },
    orgId: string,
    from: string,
    to: string,
    options?: { page?: number; pageSize?: number },
  ): Promise<{ userIds: string[]; totalUsers: number; userSelection: string }>
  loadAttendancePeriodSummaryEmployeeInfo(
    db: { query(sql: string, params?: unknown[]): Promise<unknown[]> },
    orgId: string,
    userId: string,
    from: string,
    to: string,
  ): Promise<{ employeeName: string; department: string; attendanceGroup: string }>
}

type AttendanceVisibilityHelpers = {
  __attendanceMakeupPunchForTests: {
    deriveMakeupAnomalyFacts(
      db: { query(sql: string, params?: unknown[]): Promise<unknown[]> },
      input: { orgId: string; userId: string; workDate: string },
    ): Promise<string[]>
  }
  __attendanceWorkDateResolverForTests: {
    loadOpenRecordsForWorkDateResolver(
      db: { query(sql: string, params?: unknown[]): Promise<unknown[]> },
      input: { orgId: string; userId: string; workDates: string[] },
    ): Promise<Array<{ userId: string; workDate: string }>>
  }
  __attendanceOvertimeBankForTests: {
    snapshotCycleSettlementOnClose(
      db: { query(sql: string, params?: unknown[]): Promise<unknown[]> },
      cycle: { id: string; org_id: string; start_date: string; end_date: string },
    ): Promise<void>
  }
}

function getAttendanceReportSyncHelpers(): AttendanceReportSyncHelpers {
  const plugin = require('../../../../plugins/plugin-attendance/index.cjs') as {
    __attendanceReportFieldCatalogForTests?: AttendanceReportSyncHelpers
  }
  if (!plugin.__attendanceReportFieldCatalogForTests) {
    throw new Error('attendance report sync test seam unavailable')
  }
  return plugin.__attendanceReportFieldCatalogForTests
}

function getAttendanceVisibilityHelpers(): AttendanceVisibilityHelpers {
  return require('../../../../plugins/plugin-attendance/index.cjs') as AttendanceVisibilityHelpers
}

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
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
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
	let importUploadDir = ''
  const priorEnv = {
    databaseUrl: process.env.DATABASE_URL,
    rbacBypass: process.env.RBAC_BYPASS,
    skipPlugins: process.env.SKIP_PLUGINS,
    segmentCalculationEnabled: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
    allowedCorpIds: process.env.DINGTALK_ALLOWED_CORP_IDS,
	  importUploadDir: process.env.ATTENDANCE_IMPORT_UPLOAD_DIR,
  }

  async function requestJson(pathname: string, token: string, body: Record<string, unknown>): Promise<RouteResponse> {
    return requestHttp(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function uploadRaw(
    pathname: string,
    token: string,
    contentType: string,
    body: string | Buffer,
  ): Promise<RouteResponse> {
    return requestHttp(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body,
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

  async function seedActorAndRollout(state: 'legacy' | 'shadow' | 'authoritative'): Promise<{ orgId: string; actorId: string; token: string }> {
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
       VALUES ($1, 'legacy', 'w4c3a-route-acceptance', 'TEST_FIXTURE', $2, 1, NULL, 'synthetic_staging')`,
      [orgId, actorId],
    )
    if (state === 'shadow' || state === 'authoritative') {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'shadow', prior_state = 'legacy', version = 2
          WHERE org_id = $1`,
        [orgId],
      )
    }
    if (state === 'authoritative') {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'eligible', prior_state = 'shadow', version = 3
          WHERE org_id = $1`,
        [orgId],
      )
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'authoritative', prior_state = 'eligible', version = 4
          WHERE org_id = $1`,
        [orgId],
      )
    }
    return { orgId, actorId, token: await mintToken(actorId) }
  }

  async function seedTargetUsers(orgId: string, count: number): Promise<string[]> {
    const userIds = Array.from({ length: count }, () => randomUUID())
    const emails = userIds.map((userId) => `${fixturePrefix}-${userId}@example.test`)
    await pool.query(
      `INSERT INTO users
       (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       SELECT user_id, email, user_id, 'W4C-3a scale target', 'x', 'user', '[]'::jsonb, true, false, now(), now()
         FROM unnest($1::text[], $2::text[]) AS target(user_id, email)`,
      [userIds, emails],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       SELECT user_id, $2, true FROM unnest($1::text[]) AS target(user_id)`,
      [userIds, orgId],
    )
    return userIds
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

  async function seedVisibilityRecord(
    orgId: string,
    userId: string,
    recordWorkDate: string,
    visibilityState: 'active' | 'retired',
    fields: {
      status?: string
      meta?: Record<string, unknown>
      firstInAt?: string | null
      lastOutAt?: string | null
    } = {},
  ): Promise<string> {
    const recordId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_records
       (id, org_id, user_id, work_date, timezone, first_in_at, last_out_at,
        work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta,
        projection_owner, current_calculation_id, visibility_state, visibility_reason,
        created_at, updated_at)
       VALUES
       ($1, $2, $3, $4::date, 'UTC', $5::timestamptz, $6::timestamptz,
        480, 0, 0, $7, true, $8::jsonb,
        'legacy_untracked', NULL, $9, $10, now(), now())`,
      [
        recordId,
        orgId,
        userId,
        recordWorkDate,
        fields.firstInAt ?? null,
        fields.lastOutAt ?? null,
        fields.status ?? 'normal',
        JSON.stringify(fields.meta ?? {}),
        visibilityState,
        visibilityState === 'active' ? 'active' : 'review_placeholder',
      ],
    )
    return recordId
  }

  function pluginRowsDb(): { query(sql: string, params?: unknown[]): Promise<unknown[]> } {
    return {
      query: async (sql: string, params?: unknown[]) =>
        (await pool.query(sql, params as unknown[])).rows,
    }
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
	  importUploadDir = await mkdtemp(path.join(os.tmpdir(), 'ms2-w4c3a-route-'))
	  process.env.ATTENDANCE_IMPORT_UPLOAD_DIR = importUploadDir
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
      'attendance_current_records',
      'attendance_notification_deliveries',
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
	  if (importUploadDir) await rm(importUploadDir, { recursive: true, force: true })
    vi.stubGlobal('fetch', setupFetch)
    for (const [key, value] of Object.entries({
      DATABASE_URL: priorEnv.databaseUrl,
      RBAC_BYPASS: priorEnv.rbacBypass,
      SKIP_PLUGINS: priorEnv.skipPlugins,
      ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED: priorEnv.segmentCalculationEnabled,
      DINGTALK_ALLOWED_CORP_IDS: priorEnv.allowedCorpIds,
	    ATTENDANCE_IMPORT_UPLOAD_DIR: priorEnv.importUploadDir,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }, 60000)

  it('P06: real POST /api/attendance/import/commit reaches the synchronous canonical host', async () => {
    const fixture = await seedActorAndRollout('shadow')
    const response = await requestJson('/api/attendance/import/commit', fixture.token, {
      orgId: fixture.orgId,
      userId: fixture.actorId,
      rows: [{ userId: fixture.actorId, workDate, fields: { workMinutes: 480 } }],
    })
    expect(response.status, response.raw).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      success: true,
      data: {
        imported: 1,
        processedRows: 1,
        failedRows: 0,
        batchId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    })
    expect(await canonicalOperationCounts(fixture.orgId)).toEqual({ batches: 1, operations: 1 })
  })

  it('P06: shadow 5001 uses the operational-only compatibility branch with zero W4 DML', async () => {
    const fixture = await seedActorAndRollout('shadow')
    const targetUserIds = await seedTargetUsers(fixture.orgId, 5001)
    const rows = targetUserIds.map((userId) => ({
      userId,
      workDate,
      fields: { workMinutes: 480 },
    }))
    const response = await requestJson('/api/attendance/import/commit', fixture.token, {
      orgId: fixture.orgId,
      userId: fixture.actorId,
      rows,
      returnItems: false,
    })
    expect(response.status, response.raw).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      success: true,
      data: { imported: 5001, processedRows: 5001, failedRows: 0 },
    })
    expect(await canonicalOperationCounts(fixture.orgId)).toEqual({ batches: 0, operations: 0 })
  }, 120000)

  it('P06: authoritative 5001 fails at the real route before import or result DML', async () => {
    const fixture = await seedActorAndRollout('authoritative')
    const before = await businessCounts(fixture.orgId)
    const rows = Array.from({ length: 5001 }, (_, index) => ({
      userId: fixture.actorId,
      workDate: new Date(Date.UTC(2020, 0, index + 1))
        .toISOString()
        .slice(0, 10),
      fields: { workMinutes: 480 },
    }))
    expect(new Set(rows.map((row) => `${row.userId}:${row.workDate}`)).size).toBe(
      5001,
    )
    const response = await requestJson('/api/attendance/import/commit', fixture.token, {
      orgId: fixture.orgId,
      userId: fixture.actorId,
      rows,
      returnItems: false,
    })
    expect(response.status, response.raw).toBe(422)
    expect((response.body?.error as { code?: string } | undefined)?.code).toBe('W4_BATCH_LIMIT_EXCEEDED')
    expect(await businessCounts(fixture.orgId)).toEqual(before)
  }, 120000)

  it('P06: authoritative exactly 5000 commits atomically through the real route', async () => {
    const fixture = await seedActorAndRollout('authoritative')
    const targetUserIds = await seedTargetUsers(fixture.orgId, 5000)
    const response = await requestJson('/api/attendance/import/commit', fixture.token, {
      orgId: fixture.orgId,
      userId: fixture.actorId,
      rows: targetUserIds.map((userId) => ({
        userId,
        workDate,
        fields: { workMinutes: 480 },
      })),
      returnItems: false,
    })
    expect(response.status, response.raw).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      success: true,
      data: { imported: 5000, processedRows: 5000, failedRows: 0 },
    })
    expect(await canonicalOperationCounts(fixture.orgId)).toEqual({
      batches: 1,
      operations: 5000,
    })
  }, 180000)

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

  it('P09: client-converted XLSX binds distinct original-artifact and normalized-CSV hashes to canonical provenance', async () => {
    const fixture = await seedActorAndRollout('shadow')
    const xlsxBytes = Buffer.from('PK\u0003\u0004synthetic-xlsx-source')
    const csvText = `日期,工号,考勤组,上班1打卡时间,下班1打卡时间,考勤结果\n${workDate},A001,XLSX,09:00,18:00,正常\n`
    const artifactUpload = await uploadRaw(
      `/api/attendance/import/upload-artifact?orgId=${fixture.orgId}&filename=fixture.xlsx`,
      fixture.token,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xlsxBytes,
    )
    expect(artifactUpload.status, artifactUpload.raw).toBe(201)
    const artifactFileId = (artifactUpload.body?.data as { fileId?: string } | undefined)?.fileId
    expect(artifactFileId).toMatch(/^[0-9a-f-]{36}$/)

    const csvUpload = await uploadRaw(
      `/api/attendance/import/upload?orgId=${fixture.orgId}&filename=fixture.csv`,
      fixture.token,
      'text/csv',
      csvText,
    )
    expect(csvUpload.status, csvUpload.raw).toBe(201)
    const csvFileId = (csvUpload.body?.data as { fileId?: string } | undefined)?.fileId
    expect(csvFileId).toMatch(/^[0-9a-f-]{36}$/)

    const response = await requestJson('/api/attendance/import', fixture.token, {
      orgId: fixture.orgId,
      userId: fixture.actorId,
      csvFileId,
      convertedArtifactFileId: artifactFileId,
      convertedSheetName: '打卡日报',
      mapping: {
        columns: [
          { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
          { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
          { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
          { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
          { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
          { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
        ],
      },
      userMap: { A001: fixture.actorId },
      userMapKeyField: 'empNo',
      userMapSourceFields: ['empNo'],
    })
    expect(response.status, response.raw).toBe(200)

    const evidence = await pool.query<{ provenance: Record<string, unknown> }>(
      `SELECT normalized_business_input_snapshot -> 'provenance' AS provenance
         FROM attendance_result_operations
        WHERE org_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [fixture.orgId],
    )
    expect(evidence.rows).toHaveLength(1)
    expect(evidence.rows[0].provenance).toEqual({
      transport: 'xlsx_client_converted_csv',
      sourceRef: expect.stringContaining(':xlsx_client_converted_csv'),
      artifactSha256: createHash('sha256').update(xlsxBytes).digest('hex'),
      normalizedCsvSha256: createHash('sha256').update(csvText, 'utf8').digest('hex'),
      convertedSheetName: '打卡日报',
    })
	  await expect(
	    access(path.join(importUploadDir, fixture.orgId, `${artifactFileId}.artifact`)),
	  ).rejects.toThrow()
	  await expect(
	    access(path.join(importUploadDir, fixture.orgId, `${artifactFileId}.json`)),
	  ).rejects.toThrow()
  })

  it('P09: converted artifact fields are an inseparable pair', async () => {
    const fixture = await seedActorAndRollout('legacy')
    const response = await requestJson('/api/attendance/import', fixture.token, {
      orgId: fixture.orgId,
      userId: fixture.actorId,
      rows: [{ userId: fixture.actorId, workDate, fields: { workMinutes: 480 } }],
      convertedSheetName: 'Sheet1',
    })
    expect(response.status, response.raw).toBe(400)
    expect((response.body?.error as { code?: string } | undefined)?.code).toBe('VALIDATION_ERROR')
  })

  it('P09: converted artifact tampering fails before business or result DML', async () => {
    const fixture = await seedActorAndRollout('shadow')
    const artifactUpload = await uploadRaw(
      `/api/attendance/import/upload-artifact?orgId=${fixture.orgId}&filename=tamper.xlsx`,
      fixture.token,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.from('PK\u0003\u0004original'),
    )
    expect(artifactUpload.status, artifactUpload.raw).toBe(201)
    const artifactFileId = (artifactUpload.body?.data as { fileId?: string } | undefined)?.fileId
    expect(artifactFileId).toMatch(/^[0-9a-f-]{36}$/)
    await writeFile(
      path.join(importUploadDir, fixture.orgId, `${artifactFileId}.artifact`),
      Buffer.from('PK\u0003\u0004tampered'),
    )
    const before = await businessCounts(fixture.orgId)
    const response = await requestJson('/api/attendance/import', fixture.token, {
      orgId: fixture.orgId,
      userId: fixture.actorId,
      csvText: `日期,工号,考勤组,上班1打卡时间,下班1打卡时间,考勤结果\n${workDate},A001,XLSX,09:00,18:00,正常\n`,
      convertedArtifactFileId: artifactFileId,
      convertedSheetName: 'Sheet1',
      mapping: {
        columns: [
          { sourceField: '日期', targetField: 'workDate', dataType: 'date' },
          { sourceField: '工号', targetField: 'empNo', dataType: 'string' },
          { sourceField: '考勤组', targetField: 'attendance_group', dataType: 'string' },
          { sourceField: '上班1打卡时间', targetField: 'firstInAt', dataType: 'time' },
          { sourceField: '下班1打卡时间', targetField: 'lastOutAt', dataType: 'time' },
          { sourceField: '考勤结果', targetField: 'status', dataType: 'string' },
        ],
      },
      userMap: { A001: fixture.actorId },
      userMapKeyField: 'empNo',
      userMapSourceFields: ['empNo'],
    })
    expect(response.status, response.raw).toBe(409)
    expect((response.body?.error as { code?: string } | undefined)?.code).toBe(
      'ATTENDANCE_IMPORT_ARTIFACT_INTEGRITY_MISMATCH',
    )
    expect(await businessCounts(fixture.orgId)).toEqual(before)
  })

  it('P10: legacy integration sync preserves its public response and compatibility effects', async () => {
    const fixture = await seedActorAndRollout('legacy')
    const integrationId = await createIntegration(fixture.orgId, fixture.actorId, 'legacy')
    const response = await requestJson(
      `/api/attendance/integrations/${integrationId}/sync`,
      fixture.token,
      { orgId: fixture.orgId, from: workDate, to: workDate },
    )
    expect(response.status, response.raw).toBe(200)
    expect(response.body?.ok).toBe(true)
    expect(response.body?.data).toMatchObject({
      integrationId,
      imported: 1,
      skipped: [],
      batchId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      partialErrors: [],
      run: { status: 'success', message: 'Sync completed' },
    })
    expect(await canonicalOperationCounts(fixture.orgId)).toEqual({ batches: 0, operations: 0 })
    const persisted = await businessCounts(fixture.orgId)
    expect(persisted.importBatches).toBe(1)
    expect(persisted.importItems).toBe(1)
    const record = await pool.query<{ work_minutes: number }>(
      'SELECT work_minutes FROM attendance_records WHERE org_id = $1 AND user_id = $2 AND work_date = $3::date',
      [fixture.orgId, fixture.actorId, workDate],
    )
    expect(record.rows).toEqual([{ work_minutes: 17 }])
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

  it('P10: an exact imported metric conflict preserves compatibility data but cannot project a canonical result', async () => {
    const fixture = await seedActorAndRollout('shadow')
    const integrationId = await createIntegration(fixture.orgId, fixture.actorId, 'metric-conflict')
    const before = await businessCounts(fixture.orgId)

    const response = await requestJson(
      `/api/attendance/integrations/${integrationId}/sync`,
      fixture.token,
      { orgId: fixture.orgId, from: workDate, to: workDate },
    )

    expect(response.status, response.raw).toBe(200)
    const after = await businessCounts(fixture.orgId)
    expect(after).toEqual({
      records: before.records + 1,
      importBatches: before.importBatches + 1,
      importItems: before.importItems + 1,
      operationBatches: before.operationBatches + 1,
      operations: before.operations + 1,
      calculations: before.calculations + 1,
      outbox: before.outbox,
    })
    const review = await pool.query<{
      work_minutes: number
      imported_work: { present: boolean; value: number }
      projection_owner: string
      current_calculation_id: string | null
      outcome: string
      outcome_reason_code: string
      projection_effect: string
      segments: number
    }>(
      `SELECT r.work_minutes,
              o.normalized_business_input_snapshot -> 'metrics' -> 'workMinutes' AS imported_work,
              r.projection_owner,
              r.current_calculation_id,
              c.outcome,
              c.outcome_reason_code,
              c.projection_effect,
              (SELECT count(*)::int FROM attendance_record_segments s
                WHERE s.calculation_id = c.id) AS segments
         FROM attendance_records r
         JOIN attendance_result_operations o ON o.org_id = r.org_id
         JOIN attendance_record_calculations c ON c.attendance_record_id = r.id
        WHERE r.org_id = $1`,
      [fixture.orgId],
    )
    expect(review.rows).toEqual([{
      work_minutes: 17,
      imported_work: { present: true, value: 17 },
      projection_owner: 'legacy_untracked',
      current_calculation_id: null,
      outcome: 'review_required',
      outcome_reason_code: 'import_metric_conflict',
      projection_effect: 'none',
      segments: 0,
    }])
  })

  it('W4C-3a: ordinary record, summary, report-sync, reminder, anomaly, and export readers hide retired rows', async () => {
    const fixture = await seedActorAndRollout('legacy')
    const activeRecordId = randomUUID()
    const retiredRecordId = randomUUID()
    const activeWorkDate = '2026-07-21'
    const retiredWorkDate = '2026-07-22'
    await pool.query(
      `INSERT INTO attendance_records
       (id, org_id, user_id, work_date, timezone, first_in_at, last_out_at,
        work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta,
        projection_owner, current_calculation_id, visibility_state, visibility_reason,
        created_at, updated_at)
       VALUES
       ($1, $3, $4, $5::date, 'UTC', NULL, $7::timestamptz,
        480, 0, 0, 'partial', true, '{}'::jsonb,
        'legacy_untracked', NULL, 'active', 'active', now(), now()),
       ($2, $3, $4, $6::date, 'UTC', NULL, $8::timestamptz,
        480, 0, 0, 'partial', true, '{}'::jsonb,
        'legacy_untracked', NULL, 'retired', 'review_placeholder', now(), now())`,
      [
        activeRecordId,
        retiredRecordId,
        fixture.orgId,
        fixture.actorId,
        activeWorkDate,
        retiredWorkDate,
        `${activeWorkDate}T18:00:00.000Z`,
        `${retiredWorkDate}T18:00:00.000Z`,
      ],
    )

    const query = `orgId=${encodeURIComponent(fixture.orgId)}&from=${activeWorkDate}&to=${retiredWorkDate}`
    for (const pathname of ['/api/attendance/records', '/api/attendance/calendar']) {
      const response = await requestHttp(`${baseUrl}${pathname}?${query}`, {
        headers: { Authorization: `Bearer ${fixture.token}` },
      })
      expect(response.status, response.raw).toBe(200)
      const data = response.body?.data as { items?: Array<{ id?: string }>; total?: number } | undefined
      expect(data?.items?.map((item) => item.id)).toEqual([activeRecordId])
      expect(data?.total).toBe(1)
    }

    const summary = await requestHttp(`${baseUrl}/api/attendance/summary?${query}`, {
      headers: { Authorization: `Bearer ${fixture.token}` },
    })
    expect(summary.status, summary.raw).toBe(200)
    expect(summary.body?.data).toMatchObject({
      total_days: 1,
      total_minutes: 480,
      partial_days: 1,
    })

    const exported = await requestHttp(`${baseUrl}/api/attendance/export?${query}&format=json`, {
      headers: { Authorization: `Bearer ${fixture.token}` },
    })
    expect(exported.status, exported.raw).toBe(200)
    const exportData = exported.body?.data as {
      items?: Array<{ work_date?: string }>
      total?: number
    } | undefined
    expect(exportData?.items?.map((item) => item.work_date)).toEqual([activeWorkDate])
    expect(exportData?.total).toBe(1)

    const reportStore: Array<{ id: string; data: Record<string, unknown> }> = []
    const reportRecords = {
      queryRecords: async ({ filters }: { filters?: Record<string, unknown> }) => {
        const rowKey = filters?.fld_row_key
        return reportStore.filter((record) => record.data.fld_row_key === rowKey)
      },
      createRecord: async ({ data }: { data: Record<string, unknown> }) => {
        const record = { id: `report-${reportStore.length + 1}`, data: { ...data } }
        reportStore.push(record)
        return record
      },
      patchRecord: async () => undefined,
    }
    const reportProvisioning = {
      ensureObject: async () => ({ baseId: 'w4c3a-report-base', sheet: { id: 'w4c3a-report-sheet' } }),
      resolveFieldIds: async ({ fieldIds }: { fieldIds: string[] }) =>
        Object.fromEntries(fieldIds.map((fieldId) => [fieldId, `fld_${fieldId}`])),
    }
    const reportDb = {
      query: async (sql: string, params?: unknown[]) =>
        (await pool.query(sql, params as unknown[])).rows,
    }
    const reportSync = await getAttendanceReportSyncHelpers().syncAttendanceReportRecords(
      {
        api: {
          database: reportDb,
          multitable: { provisioning: reportProvisioning, records: reportRecords },
        },
      },
      reportDb,
      fixture.orgId,
      { warn() {} },
      { from: activeWorkDate, to: retiredWorkDate, userId: fixture.actorId },
    )
    expect(reportSync).toMatchObject({ synced: 1, created: 1 })
    expect(reportStore.map((record) => record.data.fld_row_key)).toEqual([
      `${fixture.orgId}:${fixture.actorId}:${activeWorkDate}`,
    ])

    const candidates = await requestHttp(
      `${baseUrl}/api/attendance/manual-missed-punch-reminders/candidates?${query}`,
      { headers: { Authorization: `Bearer ${fixture.token}` } },
    )
    expect(candidates.status, candidates.raw).toBe(200)
    const candidateData = candidates.body?.data as {
      items?: Array<{ recordId?: string }>
      total?: number
    } | undefined
    expect(candidateData?.items?.map((item) => item.recordId)).toEqual([activeRecordId])
    expect(candidateData?.total).toBe(1)

    const anomalies = await requestHttp(`${baseUrl}/api/attendance/anomalies?${query}`, {
      headers: { Authorization: `Bearer ${fixture.token}` },
    })
    expect(anomalies.status, anomalies.raw).toBe(200)
    const anomalyData = anomalies.body?.data as {
      items?: Array<{ recordId?: string }>
      total?: number
    } | undefined
    expect(anomalyData?.items?.map((item) => item.recordId)).toEqual([activeRecordId])
    expect(anomalyData?.total).toBe(1)

    const enqueue = await requestJson(
      `/api/attendance/manual-missed-punch-reminders/enqueue?orgId=${encodeURIComponent(fixture.orgId)}`,
      fixture.token,
      {
        recordIds: [retiredRecordId],
        message: 'Synthetic retired-record visibility check',
        idempotencyKey: `${fixturePrefix}-${retiredRecordId}`,
      },
    )
    expect(enqueue.status, enqueue.raw).toBe(409)
    expect(enqueue.body?.error).toMatchObject({ code: 'MISSED_PUNCH_REMINDER_CANDIDATE_STALE' })
    const deliveryResidue = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM attendance_notification_deliveries WHERE org_id = $1',
      [fixture.orgId],
    )
    expect(deliveryResidue.rows[0].count).toBe(0)
  })

  it('W4C-3a: report-sync schema fallback enumerates users from current records only', async () => {
    const fixture = await seedActorAndRollout('legacy')
    const [activeUserId, retiredUserId] = await seedTargetUsers(fixture.orgId, 2)
    await seedVisibilityRecord(fixture.orgId, activeUserId, '2026-07-23', 'active')
    await seedVisibilityRecord(fixture.orgId, retiredUserId, '2026-07-24', 'retired')
    const fallbackDb = {
      query: async (sql: string, params?: unknown[]) => {
        if (/FROM user_orgs/.test(sql)) {
          throw Object.assign(new Error('synthetic legacy schema'), { code: '42P01' })
        }
        return (await pool.query(sql, params as unknown[])).rows
      },
    }

    const page = await getAttendanceReportSyncHelpers().loadAttendanceReportRecordsSyncUserPage(
      fallbackDb,
      fixture.orgId,
      '2026-07-23',
      '2026-07-24',
      { page: 1, pageSize: 100 },
    )

    expect(page).toMatchObject({
      userIds: [activeUserId],
      totalUsers: 1,
      userSelection: 'attendanceRecordsFallback',
    })
  })

  it('W4C-3a: period report employee metadata ignores the newer retired record', async () => {
    const fixture = await seedActorAndRollout('legacy')
    await seedVisibilityRecord(fixture.orgId, fixture.actorId, '2026-07-23', 'active', {
      meta: { department: 'Visible department', attendanceGroup: 'Visible group' },
    })
    await seedVisibilityRecord(fixture.orgId, fixture.actorId, '2026-07-24', 'retired', {
      meta: { department: 'Retired department', attendanceGroup: 'Retired group' },
    })

    const employee = await getAttendanceReportSyncHelpers().loadAttendancePeriodSummaryEmployeeInfo(
      pluginRowsDb(),
      fixture.orgId,
      fixture.actorId,
      '2026-07-23',
      '2026-07-24',
    )

    expect(employee).toMatchObject({
      department: 'Visible department',
      attendanceGroup: 'Visible group',
    })
  })

  it('W4C-3a: makeup anomaly facts do not derive from a retired attendance record', async () => {
    const fixture = await seedActorAndRollout('legacy')
    const retiredWorkDate = '2026-07-19'
    await seedVisibilityRecord(fixture.orgId, fixture.actorId, retiredWorkDate, 'retired', {
      status: 'normal',
    })
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        if (/FROM attendance_current_records/.test(sql)) {
          return (await pool.query(sql, params as unknown[])).rows
        }
        throw Object.assign(new Error('synthetic unavailable context'), { code: '42P01' })
      },
    }

    const facts = await getAttendanceVisibilityHelpers()
      .__attendanceMakeupPunchForTests
      .deriveMakeupAnomalyFacts(db, {
        orgId: fixture.orgId,
        userId: fixture.actorId,
        workDate: retiredWorkDate,
      })

    expect(facts).toEqual([])
  })

  it('W4C-3a: open-record work-date attribution returns active rows only', async () => {
    const fixture = await seedActorAndRollout('legacy')
    const activeWorkDate = '2026-07-23'
    const retiredWorkDate = '2026-07-24'
    await seedVisibilityRecord(fixture.orgId, fixture.actorId, activeWorkDate, 'active', {
      status: 'partial',
      firstInAt: `${activeWorkDate}T09:00:00.000Z`,
    })
    await seedVisibilityRecord(fixture.orgId, fixture.actorId, retiredWorkDate, 'retired', {
      status: 'partial',
      firstInAt: `${retiredWorkDate}T09:00:00.000Z`,
    })

    const rows = await getAttendanceVisibilityHelpers()
      .__attendanceWorkDateResolverForTests
      .loadOpenRecordsForWorkDateResolver(pluginRowsDb(), {
        orgId: fixture.orgId,
        userId: fixture.actorId,
        workDates: [activeWorkDate, retiredWorkDate],
      })

    expect(rows.map((row) => row.workDate)).toEqual([activeWorkDate])
  })

  it('W4C-3a: payroll settlement population does not process a retired-only record user', async () => {
    const fixture = await seedActorAndRollout('legacy')
    const periodStart = '2026-07-01'
    const periodEnd = '2026-07-31'
    await seedVisibilityRecord(fixture.orgId, fixture.actorId, '2026-07-24', 'retired')
    const cycle = await pool.query<{
      id: string
      org_id: string
      start_date: string
      end_date: string
    }>(
      `INSERT INTO attendance_payroll_cycles (org_id, start_date, end_date, status)
       VALUES ($1, $2::date, $3::date, 'closed')
       RETURNING id, org_id, start_date::text, end_date::text`,
      [fixture.orgId, periodStart, periodEnd],
    )
    const sqlCalls: string[] = []
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        sqlCalls.push(sql)
        return (await pool.query(sql, params as unknown[])).rows
      },
    }

    await getAttendanceVisibilityHelpers()
      .__attendanceOvertimeBankForTests
      .snapshotCycleSettlementOnClose(db, cycle.rows[0])

    expect(sqlCalls.filter((sql) => /AS total_days/.test(sql))).toHaveLength(0)
    const settlements = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM attendance_payroll_cycle_settlements WHERE cycle_id = $1',
      [cycle.rows[0].id],
    )
    expect(settlements.rows[0].count).toBe(0)
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

})
