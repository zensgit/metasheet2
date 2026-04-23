/**
 * Wave 2 WP3 slice 2 — 已读/未读 (approval_reads) integration tests.
 *
 * Validates:
 *  - POST /api/approvals/:id/mark-read inserts on first call and updates
 *    (idempotent) on the second.
 *  - POST /api/approvals/mark-all-read upserts for every active assignment of
 *    the current user and returns the bulk count.
 *  - GET  /api/approvals/pending-count returns the pre-existing `count` AND a
 *    new `unreadCount`, dropping for any instance that has been marked read.
 *  - The PLM edge case where `:id` references an unsynced external approval
 *    returns `{ ok: true, skipped: true }` without FK violation.
 *  - Non-assignees can mark-read for themselves without pollution of other
 *    users' unread counts.
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

interface PendingCountPayload {
  count: number
  unreadCount: number
}

async function fetchCount(
  baseUrl: string,
  token: string,
  sourceSystem: string = 'all',
): Promise<PendingCountPayload> {
  const response = await fetch(
    `${baseUrl}/api/approvals/pending-count?sourceSystem=${encodeURIComponent(sourceSystem)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  expect(response.status).toBe(200)
  return (await response.json()) as PendingCountPayload
}

describeIfDatabase('Approval Wave 2 WP3 slice 2 — approval_reads endpoints', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const suiteSuffix = randomUUID().slice(0, 8)
  const actorId = `wp3-reads-actor-${suiteSuffix}`
  const outsiderId = `wp3-reads-outsider-${suiteSuffix}`
  const instances = [
    {
      id: `apv_wp3_reads_a_${suiteSuffix}`,
      sourceSystem: 'platform' as const,
      workflowKey: `wp3-reads-a-${suiteSuffix}`,
    },
    {
      id: `apv_wp3_reads_b_${suiteSuffix}`,
      sourceSystem: 'platform' as const,
      workflowKey: `wp3-reads-b-${suiteSuffix}`,
    },
    {
      id: `plm:wp3_reads_plm_${suiteSuffix}`,
      sourceSystem: 'plm' as const,
      workflowKey: `wp3-reads-plm-${suiteSuffix}`,
      externalId: `wp3_reads_plm_${suiteSuffix}`,
    },
  ]
  // A synthetic instance id that is NEVER inserted into approval_instances;
  // the mark-read handler must accept this without raising the FK violation.
  const unsyncedPlmId = `plm:wp3_reads_never_synced_${suiteSuffix}`

  beforeAll(async () => {
    const canListen = await canListenOnEphemeralPort()
    expect(canListen).toBe(true)

    await ensureApprovalSchemaReady()

    const pool = poolManager.get()

    for (const instance of instances) {
      if (instance.sourceSystem === 'platform') {
        await pool.query(
          `INSERT INTO approval_instances
             (id, status, version, source_system, workflow_key, business_key, title,
              requester_snapshot, subject_snapshot, policy_snapshot, metadata,
              current_step, total_steps, sync_status, created_at, updated_at)
           VALUES ($1, 'pending', 0, 'platform', $2, $3, $4,
                   '{"id":"requester-platform","name":"平台发起人"}'::jsonb,
                   '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                   0, 0, 'ok', now(), now())`,
          [instance.id, instance.workflowKey, `wp3:reads:${instance.workflowKey}`, `WP3 reads ${instance.workflowKey}`],
        )
      } else {
        await pool.query(
          `INSERT INTO approval_instances
             (id, status, version, source_system, external_approval_id, workflow_key, business_key, title,
              requester_snapshot, subject_snapshot, policy_snapshot, metadata,
              current_step, total_steps, sync_status, created_at, updated_at)
           VALUES ($1, 'pending', 0, 'plm', $2, $3, $4, $5,
                   '{"id":"plm-requester","name":"PLM 发起人"}'::jsonb,
                   '{"productNumber":"P-WP3","productName":"产品"}'::jsonb,
                   '{"rejectCommentRequired":true,"sourceOfTruth":"plm"}'::jsonb,
                   '{"source_type":"eco","source_stage":"review","source_version":0}'::jsonb,
                   0, 0, 'ok', now(), now())`,
          [
            instance.id,
            (instance as { externalId?: string }).externalId,
            instance.workflowKey,
            `wp3:reads:${instance.workflowKey}`,
            `WP3 reads ${instance.workflowKey}`,
          ],
        )
      }

      await pool.query(
        `INSERT INTO approval_assignments
           (id, instance_id, assignment_type, assignee_id, source_step, node_key, is_active, metadata, created_at, updated_at)
         VALUES ($1, $2, 'user', $3, 0, $4, TRUE, '{}'::jsonb, now(), now())`,
        [randomUUID(), instance.id, actorId, `wp3_reads_node_${instance.sourceSystem}`],
      )
    }

    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [],
    })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address.port}`

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
    const ids = instances.map((instance) => instance.id)
    try {
      await pool.query('DELETE FROM approval_reads WHERE instance_id = ANY($1::text[])', [ids])
      await pool.query('DELETE FROM approval_reads WHERE user_id = ANY($1::text[])', [[actorId, outsiderId]])
      await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [ids])
      await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [ids])
      await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [ids])
    } catch {
      // cleanup failures shouldn't mask the test result
    }

    if (server) {
      await server.stop()
    }
  })

  it('pending-count returns both `count` and a matching `unreadCount` before any read', async () => {
    const token = await devToken(baseUrl, actorId)
    const payload = await fetchCount(baseUrl, token, 'all')
    expect(payload.count).toBe(3)
    expect(payload.unreadCount).toBe(3)
  })

  it('mark-read inserts a row and is idempotent on the second call', async () => {
    const token = await devToken(baseUrl, actorId)
    const target = instances[0].id

    const first = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(target)}/mark-read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true })

    const pool = poolManager.get()
    const firstRow = await pool.query<{ read_at: Date }>(
      `SELECT read_at FROM approval_reads WHERE user_id = $1 AND instance_id = $2`,
      [actorId, target],
    )
    expect(firstRow.rows).toHaveLength(1)
    const firstAt = firstRow.rows[0].read_at

    // Second call — must update `read_at` without raising a unique-violation.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(target)}/mark-read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(second.status).toBe(200)

    const secondRow = await pool.query<{ read_at: Date }>(
      `SELECT read_at FROM approval_reads WHERE user_id = $1 AND instance_id = $2`,
      [actorId, target],
    )
    expect(secondRow.rows).toHaveLength(1)
    expect(secondRow.rows[0].read_at.getTime()).toBeGreaterThanOrEqual(firstAt.getTime())
  })

  it('pending-count reflects the read: unreadCount drops for the marked instance', async () => {
    // The previous test marked instances[0] as read; unreadCount should now
    // be 2 while the total count remains 3.
    const token = await devToken(baseUrl, actorId)
    const payload = await fetchCount(baseUrl, token, 'all')
    expect(payload.count).toBe(3)
    expect(payload.unreadCount).toBe(2)
  })

  it('mark-all-read marks every remaining active assignment and reports the bulk count', async () => {
    const token = await devToken(baseUrl, actorId)

    const response = await fetch(`${baseUrl}/api/approvals/mark-all-read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { markedCount: number }
    // Only unread targets are processed; instance[0] was already marked read.
    expect(payload.markedCount).toBe(2)

    const counts = await fetchCount(baseUrl, token, 'all')
    expect(counts.count).toBe(3)
    expect(counts.unreadCount).toBe(0)
  })

  it('mark-all-read honours sourceSystem filter', async () => {
    const token = await devToken(baseUrl, actorId)

    // Reset by wiping reads and marking only platform.
    const pool = poolManager.get()
    await pool.query('DELETE FROM approval_reads WHERE user_id = $1', [actorId])

    const response = await fetch(`${baseUrl}/api/approvals/mark-all-read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSystem: 'platform' }),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { markedCount: number }
    expect(payload.markedCount).toBe(2)

    const counts = await fetchCount(baseUrl, token, 'all')
    expect(counts.count).toBe(3)
    expect(counts.unreadCount).toBe(1) // Only the PLM row is still unread

    const plmCounts = await fetchCount(baseUrl, token, 'plm')
    expect(plmCounts.unreadCount).toBe(1)
    const platformCounts = await fetchCount(baseUrl, token, 'platform')
    expect(platformCounts.unreadCount).toBe(0)
  })

  it('mark-read on an unsynced PLM instance id returns ok with skipped=true (no FK violation)', async () => {
    const token = await devToken(baseUrl, actorId)
    const response = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(unsyncedPlmId)}/mark-read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { ok: boolean; skipped?: boolean; reason?: string }
    expect(payload.ok).toBe(true)
    expect(payload.skipped).toBe(true)
    expect(payload.reason).toBe('instance_not_materialized')

    // Confirm no row was inserted.
    const pool = poolManager.get()
    const rows = await pool.query(
      `SELECT 1 FROM approval_reads WHERE user_id = $1 AND instance_id = $2`,
      [actorId, unsyncedPlmId],
    )
    expect(rows.rows).toHaveLength(0)
  })

  it('non-assignee can mark-read without polluting the assignee user unreadCount', async () => {
    const outsiderToken = await devToken(baseUrl, outsiderId)

    // Outsider marks platform instance A as read — permission is approvals:read
    // which the admin dev-token grants. This is a presence record on
    // (outsider, instance), NOT on (actor, instance), so actor's unreadCount
    // must be unaffected.
    const response = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(instances[0].id)}/mark-read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${outsiderToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(200)

    const pool = poolManager.get()
    const rows = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM approval_reads WHERE instance_id = $1 ORDER BY user_id`,
      [instances[0].id],
    )
    const userIds = rows.rows.map((row) => row.user_id)
    expect(userIds).toContain(outsiderId)

    // Outsider's own pending-count has no active assignments, so unreadCount
    // is 0 regardless. Assignee (actor) counts stay where the prior test left
    // them — platform filter was already read, PLM still unread.
    const outsiderCount = await fetchCount(baseUrl, outsiderToken, 'all')
    expect(outsiderCount.count).toBe(0)
    expect(outsiderCount.unreadCount).toBe(0)
  })
})
