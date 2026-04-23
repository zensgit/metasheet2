/**
 * Wave 2 WP3 slice 1 — 催办 (remind action) integration tests.
 *
 * Validates:
 *  - Happy path: requester with narrow perms → 200, approval_records row created.
 *  - Rate limit: a second remind by the same user within an hour → 429.
 *  - Authorization: non-requester without `approvals:act` → 403.
 *  - Missing target: unknown instance id → 404.
 *  - PLM source: remind records locally with bridged=false, no upstream hit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { randomUUID } from 'node:crypto'
import { MetaSheetServer } from '../../src/index'
import { IPLMAdapter } from '../../src/di/identifiers'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function devToken(
  baseUrl: string,
  userId: string,
  options: { roles?: string; perms?: string } = {},
): Promise<string> {
  const params = new URLSearchParams({
    userId,
    roles: options.roles ?? 'admin',
    perms: options.perms ?? '*:*',
  })
  const response = await fetch(`${baseUrl}/api/auth/dev-token?${params.toString()}`)
  expect(response.status).toBe(200)
  const payload = await response.json() as { token: string }
  return payload.token
}

describeIfDatabase('Approval Wave 2 WP3 slice 1 — remind', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const suiteSuffix = randomUUID().slice(0, 8)
  const requesterId = `wp3-remind-requester-${suiteSuffix}`
  const strangerId = `wp3-remind-stranger-${suiteSuffix}`
  const reviewerId = `wp3-remind-reviewer-${suiteSuffix}`
  const platformInstanceId = `apv_wp3_remind_${suiteSuffix}`
  const plmExternalId = `wp3_remind_plm_${suiteSuffix}`
  const plmInstanceId = `plm:${plmExternalId}`
  const completedInstanceId = `apv_wp3_remind_done_${suiteSuffix}`
  const createdIds = [platformInstanceId, plmInstanceId, completedInstanceId]

  beforeAll(async () => {
    const canListen = await canListenOnEphemeralPort()
    expect(canListen).toBe(true)

    await ensureApprovalSchemaReady()

    const pool = poolManager.get()

    await pool.query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, created_at, updated_at)
       VALUES ($1, 'pending', 0, 'platform', $2, $3, $4,
               $5::jsonb,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               0, 0, 'ok', now(), now())`,
      [
        platformInstanceId,
        `wp3-remind-${suiteSuffix}`,
        `wp3:remind:${suiteSuffix}`,
        `WP3 remind approval ${suiteSuffix}`,
        JSON.stringify({ id: requesterId, name: '催办发起人' }),
      ],
    )

    await pool.query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, external_approval_id, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, created_at, updated_at)
       VALUES ($1, 'pending', 0, 'plm', $2, $3, $4, $5,
               $6::jsonb,
               '{"productNumber":"P-WP3","productName":"产品"}'::jsonb,
               '{"rejectCommentRequired":true,"sourceOfTruth":"plm"}'::jsonb,
               '{"source_type":"eco","source_stage":"review","source_version":0}'::jsonb,
               0, 0, 'ok', now(), now())`,
      [
        plmInstanceId,
        plmExternalId,
        `wp3-remind-plm-${suiteSuffix}`,
        `wp3:remind:plm:${suiteSuffix}`,
        `WP3 PLM remind approval ${suiteSuffix}`,
        JSON.stringify({ id: requesterId, name: '催办 PLM 发起人' }),
      ],
    )

    await pool.query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, created_at, updated_at)
       VALUES ($1, 'approved', 1, 'platform', $2, $3, $4,
               $5::jsonb,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               0, 0, 'ok', now(), now())`,
      [
        completedInstanceId,
        `wp3-remind-done-${suiteSuffix}`,
        `wp3:remind:done:${suiteSuffix}`,
        `WP3 remind completed ${suiteSuffix}`,
        JSON.stringify({ id: requesterId, name: '催办发起人' }),
      ],
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

    // The PLM adapter is mock-mode in integration; remind must not hit it
    // (bridged=false), so even without connect() the suite stays hermetic.
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
      await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [createdIds])
      await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [createdIds])
      await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdIds])
    } catch {
      // cleanup failures shouldn't mask the test result
    }

    if (server) {
      await server.stop()
    }
  })

  it('records a remind event when the requester nudges their pending approval', async () => {
    const token = await devToken(baseUrl, requesterId, { roles: 'user', perms: 'approvals:read' })
    const response = await fetch(`${baseUrl}/api/approvals/${platformInstanceId}/remind`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { ok: boolean; data: { action: string; bridged: boolean; sourceSystem: string } }
    expect(payload.ok).toBe(true)
    expect(payload.data.action).toBe('remind')
    expect(payload.data.bridged).toBe(false)
    expect(payload.data.sourceSystem).toBe('platform')

    const pool = poolManager.get()
    const result = await pool.query<{
      action: string
      actor_id: string | null
      metadata: Record<string, unknown>
    }>(
      `SELECT action, actor_id, metadata FROM approval_records
       WHERE instance_id = $1 AND action = 'remind' AND actor_id = $2`,
      [platformInstanceId, requesterId],
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].metadata.remindedBy).toBe(requesterId)
    expect(typeof result.rows[0].metadata.remindedAt).toBe('string')
    expect(result.rows[0].metadata.bridged).toBe(false)
  })

  it('throttles a second remind by the same user within an hour', async () => {
    const token = await devToken(baseUrl, requesterId, { roles: 'user', perms: 'approvals:read' })
    const response = await fetch(`${baseUrl}/api/approvals/${platformInstanceId}/remind`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(429)
    const payload = await response.json() as {
      ok: boolean
      error: { code: string; lastRemindedAt?: string; retryAfterSeconds?: number }
    }
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('APPROVAL_REMIND_THROTTLED')
    expect(typeof payload.error.lastRemindedAt).toBe('string')
    expect(payload.error.retryAfterSeconds).toBe(3600)

    // Sanity: a second record must not have been inserted.
    const pool = poolManager.get()
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM approval_records
       WHERE instance_id = $1 AND action = 'remind' AND actor_id = $2`,
      [platformInstanceId, requesterId],
    )
    expect(parseInt(countResult.rows[0].count, 10)).toBe(1)
  })

  it('rejects a non-requester without approvals:act perm with 403', async () => {
    const token = await devToken(baseUrl, strangerId, { roles: 'user', perms: 'approvals:read' })
    const response = await fetch(`${baseUrl}/api/approvals/${platformInstanceId}/remind`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(403)
    const payload = await response.json() as { error: { code: string } }
    expect(payload.error.code).toBe('APPROVAL_REMIND_FORBIDDEN')
  })

  it('allows a non-requester reviewer who has approvals:act', async () => {
    const token = await devToken(baseUrl, reviewerId, { roles: 'user', perms: 'approvals:read,approvals:act' })
    // Reviewer targets a fresh row to avoid hitting the 1-hour throttle on the
    // platform instance that the happy-path test already reminded.
    const response = await fetch(`${baseUrl}/api/approvals/${plmInstanceId}/remind`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { ok: boolean; data: { bridged: boolean; sourceSystem: string } }
    expect(payload.ok).toBe(true)
    expect(payload.data.bridged).toBe(false)
    expect(payload.data.sourceSystem).toBe('plm')
  })

  it('returns 404 for an unknown approval id', async () => {
    const token = await devToken(baseUrl, requesterId, { roles: 'user', perms: 'approvals:read' })
    const response = await fetch(`${baseUrl}/api/approvals/apv_does_not_exist_${suiteSuffix}/remind`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(404)
    const payload = await response.json() as { error: { code: string } }
    expect(payload.error.code).toBe('APPROVAL_NOT_FOUND')
  })

  it('rejects remind on a non-pending instance', async () => {
    const token = await devToken(baseUrl, requesterId, { roles: 'user', perms: 'approvals:read' })
    const response = await fetch(`${baseUrl}/api/approvals/${completedInstanceId}/remind`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const payload = await response.json() as { error: { code: string } }
    expect(payload.error.code).toBe('APPROVAL_REMIND_STATUS_INVALID')
  })
})
