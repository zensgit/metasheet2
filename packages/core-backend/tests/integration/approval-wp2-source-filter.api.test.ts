import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { randomUUID } from 'node:crypto'
import { MetaSheetServer } from '../../src/index'
import { IPLMAdapter } from '../../src/di/identifiers'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

type UnifiedApprovalDTO = {
  id: string
  sourceSystem: string | null
  title: string | null
  status: string
}

type ListResponse = {
  data: UnifiedApprovalDTO[]
  total: number
}

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function authToken(baseUrl: string, userId: string): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  const payload = await response.json() as { token: string }
  return payload.token
}

async function getJson<T>(baseUrl: string, path: string, token: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

describeIfDatabase('Approval Wave 2 WP2 sourceSystem filter', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const suiteSuffix = randomUUID().slice(0, 8)
  const platformInstanceId = `apv_wp2_platform_${suiteSuffix}`
  const plmExternalId = `wp2_plm_${suiteSuffix}`
  const plmInstanceId = `plm:${plmExternalId}`
  const createdIds = [platformInstanceId, plmInstanceId]
  // Keep workflow keys stable but collision-free so the filter test is unaffected
  // by any rows other integration suites may have left behind.
  const platformWorkflowKey = `wp2-platform-${suiteSuffix}`
  const plmWorkflowKey = `wp2-plm-${suiteSuffix}`

  beforeAll(async () => {
    const canListen = await canListenOnEphemeralPort()
    expect(canListen).toBe(true)

    await ensureApprovalSchemaReady()

    const pool = poolManager.get()

    // Seed: one platform-owned approval.
    await pool.query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, created_at, updated_at)
       VALUES ($1, 'pending', 0, 'platform', $2, $3, $4,
               '{"id":"requester-platform","name":"平台发起人"}'::jsonb,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               0, 0, 'ok', now(), now())`,
      [platformInstanceId, platformWorkflowKey, `platform:wp2:${suiteSuffix}`, `WP2 platform approval ${suiteSuffix}`],
    )

    // Seed: one PLM-mirrored approval (matching the bridge's write shape).
    await pool.query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, external_approval_id, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, created_at, updated_at)
       VALUES ($1, 'pending', 0, 'plm', $2, $3, $4, $5,
               '{"id":"plm-requester","name":"PLM 发起人"}'::jsonb,
               '{"productNumber":"P-001","productName":"产品"}'::jsonb,
               '{"rejectCommentRequired":true,"sourceOfTruth":"plm"}'::jsonb,
               '{"source_type":"eco","source_stage":"review","source_version":0}'::jsonb,
               0, 0, 'ok', now(), now())`,
      [plmInstanceId, plmExternalId, plmWorkflowKey, `plm:wp2:${suiteSuffix}`, `WP2 PLM approval ${suiteSuffix}`],
    )

    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [],
    })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address.port}`

    // The route force-syncs PLM on `sourceSystem=plm`. No PLM URL is configured in
    // the test environment, so connect() puts the adapter in mock mode (returns
    // empty approvals) and the sync becomes a no-op that leaves our seeded row
    // untouched.
    const injector = (server as unknown as { injector?: { get: (id: unknown) => unknown } }).injector
    if (injector) {
      const plmAdapter = injector.get(IPLMAdapter) as { connect?: () => Promise<void> }
      if (typeof plmAdapter.connect === 'function') {
        await plmAdapter.connect()
      }
    }
  })

  afterAll(async () => {
    const pool = poolManager.get()
    try {
      await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [createdIds])
      await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [createdIds])
      await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdIds])
    } catch {
      // cleanup failures shouldn't mask the test result
    }

    if (server) {
      await server.stop()
    }
  })

  it('returns a unified feed when sourceSystem=all', async () => {
    const token = await authToken(baseUrl, `wp2-actor-${suiteSuffix}`)
    const payload = await getJson<ListResponse>(
      baseUrl,
      `/api/approvals?sourceSystem=all&workflowKey=${encodeURIComponent(platformWorkflowKey)}`,
      token,
    )
    const platformRow = payload.data.find((row) => row.id === platformInstanceId)
    expect(platformRow).toBeTruthy()
    expect(platformRow?.sourceSystem).toBe('platform')

    // The PLM row shares suiteSuffix via workflow_key; query again narrowing to that key.
    const plmPayload = await getJson<ListResponse>(
      baseUrl,
      `/api/approvals?sourceSystem=all&workflowKey=${encodeURIComponent(plmWorkflowKey)}`,
      token,
    )
    const plmRow = plmPayload.data.find((row) => row.id === plmInstanceId)
    expect(plmRow).toBeTruthy()
    expect(plmRow?.sourceSystem).toBe('plm')

    // Direct assertion: without workflow_key narrowing, the two rows tagged with our
    // suite-specific business keys must both appear when sourceSystem=all.
    const unified = await getJson<ListResponse>(baseUrl, '/api/approvals?sourceSystem=all&limit=200', token)
    const ourRows = unified.data.filter((row) => createdIds.includes(row.id))
    expect(ourRows).toHaveLength(2)
    expect(new Set(ourRows.map((row) => row.sourceSystem))).toEqual(new Set(['platform', 'plm']))
  })

  it('scopes the feed to platform rows when sourceSystem=platform', async () => {
    const token = await authToken(baseUrl, `wp2-actor-${suiteSuffix}`)
    const payload = await getJson<ListResponse>(
      baseUrl,
      `/api/approvals?sourceSystem=platform&workflowKey=${encodeURIComponent(platformWorkflowKey)}`,
      token,
    )
    expect(payload.total).toBe(1)
    expect(payload.data).toHaveLength(1)
    expect(payload.data[0]?.id).toBe(platformInstanceId)
    expect(payload.data[0]?.sourceSystem).toBe('platform')
  })

  it('scopes the feed to plm rows when sourceSystem=plm', async () => {
    const token = await authToken(baseUrl, `wp2-actor-${suiteSuffix}`)
    const payload = await getJson<ListResponse>(
      baseUrl,
      `/api/approvals?sourceSystem=plm&workflowKey=${encodeURIComponent(plmWorkflowKey)}`,
      token,
    )
    expect(payload.total).toBe(1)
    expect(payload.data).toHaveLength(1)
    expect(payload.data[0]?.id).toBe(plmInstanceId)
    expect(payload.data[0]?.sourceSystem).toBe('plm')
  })

  it('rejects unknown sourceSystem values with a 400', async () => {
    const token = await authToken(baseUrl, `wp2-actor-${suiteSuffix}`)
    const response = await fetch(`${baseUrl}/api/approvals?sourceSystem=bogus`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(400)
    const payload = await response.json() as { error?: { code?: string } }
    expect(payload.error?.code).toBe('APPROVAL_SOURCE_SYSTEM_INVALID')
  })
})
