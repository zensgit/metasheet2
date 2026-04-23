/**
 * Wave 2 WP3 slice 1 — GET /api/approvals/pending-count.
 *
 * Asserts that the badge endpoint returns the count of active assignments for
 * the current user, scoped by `sourceSystem`:
 *   - all       → every pending assignment
 *   - platform  → platform-owned pending only
 *   - plm       → PLM-mirrored pending only
 *
 * Uses a dedicated actor id + suite suffix so other integration suites that
 * seed assignments on shared tables cannot perturb the count.
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

async function devToken(baseUrl: string, userId: string): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  const payload = await response.json() as { token: string }
  return payload.token
}

async function fetchCount(baseUrl: string, token: string, sourceSystem: string): Promise<number> {
  const response = await fetch(
    `${baseUrl}/api/approvals/pending-count?sourceSystem=${encodeURIComponent(sourceSystem)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  expect(response.status).toBe(200)
  const payload = await response.json() as { count: number }
  return payload.count
}

describeIfDatabase('Approval Wave 2 WP3 slice 1 — pending-count endpoint', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const suiteSuffix = randomUUID().slice(0, 8)
  const actorId = `wp3-count-actor-${suiteSuffix}`
  const instances = [
    { id: `apv_wp3_count_platform_a_${suiteSuffix}`, sourceSystem: 'platform', workflowKey: `wp3-count-platform-a-${suiteSuffix}` },
    { id: `apv_wp3_count_platform_b_${suiteSuffix}`, sourceSystem: 'platform', workflowKey: `wp3-count-platform-b-${suiteSuffix}` },
    { id: `plm:wp3_count_plm_${suiteSuffix}`, sourceSystem: 'plm', workflowKey: `wp3-count-plm-${suiteSuffix}`, externalId: `wp3_count_plm_${suiteSuffix}` },
  ] as const

  beforeAll(async () => {
    const canListen = await canListenOnEphemeralPort()
    expect(canListen).toBe(true)

    await ensureApprovalSchemaReady()

    const pool = poolManager.get()

    // Seed 2 platform + 1 PLM pending approvals, each with an active
    // user-assignment targeting the actor. We also attach an inactive
    // assignment to confirm the `is_active = TRUE` filter.
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
          [instance.id, instance.workflowKey, `wp3:count:${instance.workflowKey}`, `WP3 count ${instance.workflowKey}`],
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
          [instance.id, instance.externalId, instance.workflowKey, `wp3:count:${instance.workflowKey}`, `WP3 count ${instance.workflowKey}`],
        )
      }

      await pool.query(
        `INSERT INTO approval_assignments
           (id, instance_id, assignment_type, assignee_id, source_step, node_key, is_active, metadata, created_at, updated_at)
         VALUES ($1, $2, 'user', $3, 0, $4, TRUE, '{}'::jsonb, now(), now())`,
        [randomUUID(), instance.id, actorId, `wp3_count_node_${instance.sourceSystem}`],
      )
    }

    // Seed an INACTIVE assignment on a different user — must not increment the
    // count. This guards against a regression where `is_active` is dropped
    // from the predicate.
    await pool.query(
      `INSERT INTO approval_assignments
         (id, instance_id, assignment_type, assignee_id, source_step, node_key, is_active, metadata, created_at, updated_at)
       VALUES ($1, $2, 'user', $3, 0, 'wp3_count_inactive', FALSE, '{}'::jsonb, now(), now())`,
      [randomUUID(), instances[0].id, actorId],
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

  it('returns the cross-source count when sourceSystem=all', async () => {
    const token = await devToken(baseUrl, actorId)
    const count = await fetchCount(baseUrl, token, 'all')
    expect(count).toBe(3)
  })

  it('returns only platform assignments when sourceSystem=platform', async () => {
    const token = await devToken(baseUrl, actorId)
    const count = await fetchCount(baseUrl, token, 'platform')
    expect(count).toBe(2)
  })

  it('returns only plm assignments when sourceSystem=plm', async () => {
    const token = await devToken(baseUrl, actorId)
    const count = await fetchCount(baseUrl, token, 'plm')
    expect(count).toBe(1)
  })

  it('treats the sourceSystem query as optional and defaults to all', async () => {
    const token = await devToken(baseUrl, actorId)
    const response = await fetch(`${baseUrl}/api/approvals/pending-count`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as { count: number }
    expect(payload.count).toBe(3)
  })

  it('rejects invalid sourceSystem values with 400', async () => {
    const token = await devToken(baseUrl, actorId)
    const response = await fetch(
      `${baseUrl}/api/approvals/pending-count?sourceSystem=bogus`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(response.status).toBe(400)
    const payload = await response.json() as { error: { code: string } }
    expect(payload.error.code).toBe('APPROVAL_SOURCE_SYSTEM_INVALID')
  })

  it('excludes inactive assignments from the count', async () => {
    // Isolation sanity: the actor has one inactive assignment; it must not
    // bleed into the platform or all counts.
    const token = await devToken(baseUrl, actorId)
    expect(await fetchCount(baseUrl, token, 'platform')).toBe(2)
  })
})
