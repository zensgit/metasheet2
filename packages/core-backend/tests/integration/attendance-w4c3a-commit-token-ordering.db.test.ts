import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = randomUUID().slice(0, 8)
const orgId = randomUUID()
const actorId = randomUUID()
const workDate = '2026-07-31'

type RouteResponse = {
  status: number
  raw: string
  body: Record<string, unknown> | null
}

type Footprint = {
  jobs: number
  plans: number
  chunks: number
  batches: number
  items: number
  records: number
  operations: number
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
          try {
            body = raw ? JSON.parse(raw) as Record<string, unknown> : null
          } catch {
            body = null
          }
          resolve({ status: response.statusCode ?? 0, raw, body })
        })
      },
    )
    request.on('error', reject)
    if (options.body) request.write(options.body)
    request.end()
  })
}

async function canListen(): Promise<boolean> {
  const probe = net.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

describeIfDatabase('W4C-3a M60 commit-token ordering (real routes, real PostgreSQL)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let baseUrl = ''
  let token = ''
  const priorEnv = {
    databaseUrl: process.env.DATABASE_URL,
    rbacBypass: process.env.RBAC_BYPASS,
    skipPlugins: process.env.SKIP_PLUGINS,
    asyncEnabled: process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED,
    requireToken: process.env.ATTENDANCE_IMPORT_REQUIRE_TOKEN,
    segmentCalculationEnabled:
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
  }

  async function requestJson(
    pathname: string,
    body: Record<string, unknown>,
  ): Promise<RouteResponse> {
    return requestHttp(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  }

  async function mintCommitToken(): Promise<string> {
    const response = await requestJson('/api/attendance/import/prepare', {
      orgId,
    })
    expect(response.status, response.raw).toBe(200)
    const value = (response.body?.data as { commitToken?: unknown } | undefined)
      ?.commitToken
    expect(value).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
    const commitToken = String(value)
    const persisted = await pool.query<{
      org_id: string
      user_id: string
      unexpired: boolean
    }>(
      `SELECT org_id, user_id, expires_at > now() AS unexpired
         FROM attendance_import_tokens
        WHERE token = $1`,
      [commitToken],
    )
    expect(persisted.rows).toEqual([
      { org_id: orgId, user_id: actorId, unexpired: true },
    ])
    return commitToken
  }

  async function footprint(): Promise<Footprint> {
    const result = await pool.query<Footprint>(
      `SELECT
         (SELECT count(*)::int FROM attendance_import_jobs WHERE org_id = $1) AS jobs,
         (SELECT count(*)::int
            FROM attendance_import_legacy_execution_plans p
            JOIN attendance_import_jobs j ON j.id = p.job_id
           WHERE j.org_id = $1) AS plans,
         (SELECT count(*)::int
            FROM attendance_import_legacy_execution_plan_chunks c
            JOIN attendance_import_jobs j ON j.id = c.job_id
           WHERE j.org_id = $1) AS chunks,
         (SELECT count(*)::int FROM attendance_import_batches WHERE org_id = $1) AS batches,
         (SELECT count(*)::int FROM attendance_import_items WHERE org_id = $1) AS items,
         (SELECT count(*)::int FROM attendance_records WHERE org_id = $1) AS records,
         (SELECT count(*)::int FROM attendance_result_operations WHERE org_id = $1) AS operations`,
      [orgId],
    )
    return result.rows[0]
  }

  beforeAll(async () => {
    if (!dbUrl || !(await canListen())) {
      throw new Error('W4C-3a token-order test needs DATABASE_URL and loopback')
    }
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    process.env.ATTENDANCE_IMPORT_ASYNC_ENABLED = 'true'
    process.env.ATTENDANCE_IMPORT_REQUIRE_TOKEN = '1'
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId

    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../..',
    )
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') {
      throw new Error('attendance server did not expose a TCP address')
    }
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })

    await pool.query(
      `INSERT INTO users
       (id, email, username, name, password_hash, role, permissions,
        is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-3a token actor', 'x', 'admin',
               '["attendance:admin","attendance:import"]'::jsonb,
               true, true, now(), now())`,
      [actorId, `w4c3a-token-${run}@example.test`],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, true)`,
      [actorId, orgId],
    )
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ($1, 'admin')`,
      [actorId],
    )
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
       (org_id, state, engine_version, reason_code, actor_id, version,
        prior_state, scope)
       VALUES ($1, 'legacy', 'w4c3a-token-order', 'TEST_FIXTURE', $2, 1,
               NULL, 'synthetic_staging')`,
      [orgId, actorId],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'shadow', prior_state = 'legacy', version = 2
        WHERE org_id = $1`,
      [orgId],
    )

    const auth = await requestHttp(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(actorId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
    )
    const authToken = auth.body?.token
    if (typeof authToken !== 'string' || !authToken) {
      throw new Error(`failed to mint test auth token: ${auth.raw}`)
    }
    token = authToken
  }, 120_000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    if (server) await server.stop()
    for (const [key, value] of Object.entries({
      DATABASE_URL: priorEnv.databaseUrl,
      RBAC_BYPASS: priorEnv.rbacBypass,
      SKIP_PLUGINS: priorEnv.skipPlugins,
      ATTENDANCE_IMPORT_ASYNC_ENABLED: priorEnv.asyncEnabled,
      ATTENDANCE_IMPORT_REQUIRE_TOKEN: priorEnv.requireToken,
      ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED:
        priorEnv.segmentCalculationEnabled,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }, 60_000)

  it('consumes only all-new tokens and binds idempotency to the exact request input', async () => {
    const idempotencyKey = `w4c3a-token-${run}`
    const requestBody = {
      orgId,
      userId: actorId,
      idempotencyKey,
      returnItems: false,
      rows: [
        {
          userId: actorId,
          workDate,
          fields: { workMinutes: 480 },
        },
      ],
    }
    const before = await footprint()

    const missing = await requestJson(
      '/api/attendance/import/commit-async',
      requestBody,
    )
    expect(missing.status, missing.raw).toBe(400)
    expect((missing.body?.error as { code?: string } | undefined)?.code).toBe(
      'COMMIT_TOKEN_REQUIRED',
    )
    expect(await footprint()).toEqual(before)

    const firstToken = await mintCommitToken()
    const first = await requestJson('/api/attendance/import/commit-async', {
      ...requestBody,
      commitToken: firstToken,
    })
    expect(first.status, first.raw).toBe(200)
    const firstJob = (first.body?.data as { job?: { id?: unknown } } | undefined)
      ?.job
    expect(firstJob?.id).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/))
    const jobId = String(firstJob?.id)
    const consumed = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_import_tokens WHERE token = $1',
      [firstToken],
    )
    expect(consumed.rows[0].n).toBe(0)

    const replayToken = await mintCommitToken()
    expect(replayToken).not.toBe(firstToken)
    const replayTokenBefore = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_import_tokens WHERE token = $1',
      [replayToken],
    )
    expect(replayTokenBefore.rows[0].n).toBe(1)
    const replay = await requestJson('/api/attendance/import/commit-async', {
      ...requestBody,
      commitToken: replayToken,
    })
    expect(replay.status, replay.raw).toBe(200)
    expect(replay.body?.data).toMatchObject({
      idempotent: true,
      job: { id: jobId },
    })
    const replayTokenStillPresent = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_import_tokens WHERE token = $1',
      [replayToken],
    )
    expect(replayTokenStillPresent.rows[0].n).toBe(1)

    const conflictToken = await mintCommitToken()
    expect(new Set([firstToken, replayToken, conflictToken]).size).toBe(3)
    const conflictTokenBefore = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_import_tokens WHERE token = $1',
      [conflictToken],
    )
    expect(conflictTokenBefore.rows[0].n).toBe(1)
    const conflict = await requestJson('/api/attendance/import/commit-async', {
      ...requestBody,
      commitToken: conflictToken,
      rows: [
        {
          userId: actorId,
          workDate,
          fields: { workMinutes: 481 },
        },
      ],
    })
    expect(conflict.status, conflict.raw).toBe(409)
    expect((conflict.body?.error as { code?: string } | undefined)?.code).toBe(
      'ATTENDANCE_IMPORT_IDEMPOTENCY_INPUT_CONFLICT',
    )
    const conflictTokenStillPresent = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_import_tokens WHERE token = $1',
      [conflictToken],
    )
    expect(conflictTokenStillPresent.rows[0].n).toBe(1)

    const durableText = await pool.query<{ body: string }>(
      `SELECT concat_ws(
                E'\n',
                j.payload::text,
                p.manifest::text,
                string_agg(c.chunk::text, E'\n' ORDER BY c.chunk_index)
              ) AS body
         FROM attendance_import_jobs j
         JOIN attendance_import_legacy_execution_plans p ON p.job_id = j.id
         JOIN attendance_import_legacy_execution_plan_chunks c ON c.job_id = j.id
        WHERE j.id = $1::uuid
        GROUP BY j.payload, p.manifest`,
      [jobId],
    )
    expect(durableText.rows).toHaveLength(1)
    for (const forbidden of [firstToken, replayToken, conflictToken]) {
      expect(durableText.rows[0].body).not.toContain(forbidden)
    }

    // Let the in-process worker release its DB connection before server
    // teardown; the token-order assertions above do not depend on its result.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await pool.query<{ status: string }>(
        'SELECT status FROM attendance_import_jobs WHERE id = $1::uuid',
        [jobId],
      )
      if (['completed', 'failed'].includes(state.rows[0]?.status)) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }, 120_000)
})
