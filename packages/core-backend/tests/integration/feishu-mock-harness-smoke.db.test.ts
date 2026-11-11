/**
 * Feasibility of the real-database x local-HTTP harness: one process holds a PostgreSQL connection
 * (inside an open transaction) while the Feishu transport talks to the local mock server, and no request
 * leaves the loopback. The later Feishu real-database suites use the same arrangement.
 *
 * DATABASE_URL-gated. Nothing is written: the transaction is rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { __feishuEndpointsForTests, FEISHU_ENDPOINTS, feishuEndpointUrl } from '../../src/integrations/feishu/endpoints'
import { createFeishuTenantTokenService } from '../../src/integrations/feishu/token'
import { requestFeishuJson } from '../../src/integrations/feishu/transport'
import {
  installNoExternalFetchGuard,
  startFeishuMockServer,
  type MockFeishuServer,
  type NoExternalFetchGuard,
} from '../helpers/feishu-mock-server'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip

// Module top level: it must run (and fail) when the gated describe below is skipped for want of a database.
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const MINT = 'POST /oauth/v3/token'
const TENANT_QUERY = 'GET /open-apis/tenant/v2/tenant/query'

describeIfDatabase('Feishu mock harness with a real database', () => {
  let pool: Pool
  let server: MockFeishuServer
  let guard: NoExternalFetchGuard

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    server = await startFeishuMockServer()
    __feishuEndpointsForTests.replace(server.origins())
    guard = installNoExternalFetchGuard()
  })

  afterAll(async () => {
    guard?.restore()
    __feishuEndpointsForTests.restore()
    await server?.close()
    await pool?.end()
  })

  it('serves the scripted Feishu answers while a database transaction stays open on the same process', async () => {
    server.script(MINT, [{ kind: 'json', body: { access_token: 't-fx-smoke-token-abcdefghij', expires_in: 7200, token_type: 'Bearer' } }])
    server.script(TENANT_QUERY, [{ kind: 'json', body: { code: 0, data: { tenant: { tenant_key: 'tk_fx_0001' } } } }])

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const before = await client.query('SELECT 1 AS one, pg_backend_pid() AS pid')
      expect(before.rows[0].one).toBe(1)

      // The transport call is made with the transaction (and its connection) still open.
      const tokens = createFeishuTenantTokenService({ transport: { sleep: async () => false, random: () => 0 } })
      const accessToken = await tokens.getToken({ connectionId: 'conn-fx-smoke', appId: 'cli_fx_0001', appSecret: 'fx-smoke-secret-not-real' })
      expect(accessToken).toBe('t-fx-smoke-token-abcdefghij')
      const answer = await requestFeishuJson({
        url: feishuEndpointUrl('feishu', FEISHU_ENDPOINTS.tenantQuery),
        init: { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } },
        kind: 'read',
        envelope: 'open_api',
      })
      expect(answer).toMatchObject({ code: 0, data: { tenant: { tenant_key: 'tk_fx_0001' } } })

      const after = await client.query('SELECT pg_backend_pid() AS pid')
      expect(after.rows[0].pid).toBe(before.rows[0].pid)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }

    expect(server.count(MINT)).toBe(1)
    expect(server.count(TENANT_QUERY)).toBe(1)
    expect(server.requests.map((request) => request.headers.authorization).filter(Boolean)).toEqual(['Bearer <token>'])
    expect(server.unscripted).toEqual([])
  })

  it('makes no outbound connection: nothing outside the loopback was reached, and the guard is armed', async () => {
    expect(guard.violations).toEqual([])
    await expect(fetch('https://example.invalid/outside')).rejects.toThrow()
    expect(guard.violations).toEqual(['example.invalid'])
  })
})
