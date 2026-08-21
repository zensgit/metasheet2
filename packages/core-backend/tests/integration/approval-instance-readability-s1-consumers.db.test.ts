import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import net from 'net'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-10 (S1) — CONSUMER-level real-DB acceptance: every gate that needs a live HTTP route rather
 * than a direct `canReadApprovalInstance` call. Sibling to
 * `approval-instance-readability-s1.db.test.ts`, which covers the pure predicate (all five arms +
 * the org pin). Source: docs/development/approval-lock10-instance-readability-20260821.md plus the
 * six by-reference owner rulings (Lock-10 §5.1.1, `dd7fa8630248`, PR #5078).
 *
 * `vi.mock` below wraps `canReadApprovalInstance` with a call-counting spy that ALWAYS calls
 * through to the real implementation — every assertion in this file observes REAL admission
 * decisions; the wrapper exists solely so G-S1-4(i) can prove a `plm:` id never reaches it (a
 * spy/counter, not "no error thrown" — the gate's own explicit requirement).
 *
 * Gates covered: G-S1-4 (spy-zero for `plm:` ids + the `plm:source-owned` permission-code
 * exclusion on a PLATFORM instance), G-S1-5 (detail/history pairing, both directions, plus the
 * never-refreshed `plm:` mirror ordering trap), G-S1-7 (metrics ACL — the widen/narrow deltas vs.
 * the deleted C-2 inline ACL, all four directions named in the gate table).
 */
const readabilitySpyState = { calls: 0 }
vi.mock('../../src/services/approval-instance-readability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/approval-instance-readability')>()
  return {
    ...actual,
    canReadApprovalInstance: async (...args: Parameters<typeof actual.canReadApprovalInstance>) => {
      readabilitySpyState.calls += 1
      return actual.canReadApprovalInstance(...args)
    },
  }
})

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

async function authToken(baseUrl: string, userId: string, roles = 'admin', perms = '*:*'): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

describeIfDatabase('Lock-10 (S1) consumer adoption — detail/history/metrics, real DB', () => {
  // Imported AFTER the mock above is registered (vi.mock is hoisted by vitest regardless of
  // declaration order, so this dynamic shape is for clarity, not correctness).
  let MetaSheetServer: typeof import('../../src/index').MetaSheetServer
  let server: InstanceType<typeof MetaSheetServer> | undefined
  let baseUrl = ''
  const pool = () => poolManager.get()
  const createdInstanceIds: string[] = []
  const createdUserIds: string[] = []

  beforeAll(async () => {
    ;({ MetaSheetServer } = await import('../../src/index'))
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterEach(() => {
    readabilitySpyState.calls = 0
  })

  afterAll(async () => {
    try {
      if (createdInstanceIds.length > 0) {
        await pool().query(`DELETE FROM approval_records WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_metrics WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_instances WHERE id = ANY($1::text[])`, [createdInstanceIds])
      }
      if (createdUserIds.length > 0) {
        await pool().query(`DELETE FROM users WHERE id = ANY($1::text[])`, [createdUserIds])
      }
    } finally {
      await server?.stop()
    }
  })

  function freshId(prefix: string): string {
    return `${prefix}-${TS}-${Math.random().toString(36).slice(2, 8)}`
  }

  async function seedInstance(requesterId: string): Promise<string> {
    const id = freshId('s1c-inst')
    await pool().query(
      `INSERT INTO approval_instances (id, status, requester_snapshot) VALUES ($1, 'pending', $2::jsonb)`,
      [id, JSON.stringify({ id: requesterId })],
    )
    createdInstanceIds.push(id)
    return id
  }

  async function seedAssignment(instanceId: string, assigneeId: string, type: 'user' | 'role' | 'source_queue' = 'user'): Promise<void> {
    await pool().query(
      `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, is_active) VALUES ($1, $2, $3, TRUE)`,
      [instanceId, type, assigneeId],
    )
  }

  // ---------------------------------------------------------------------------------------------
  // G-S1-5 — detail/history pairing (OD-S1-13)
  // ---------------------------------------------------------------------------------------------
  describe('G-S1-5: detail/history pairing', () => {
    it('platform instance: participant gets 200 on BOTH doors; non-participant gets 404 on BOTH doors, asserted as a pair inside one test', async () => {
      const requesterId = freshId('s1c-requester')
      const instanceId = await seedInstance(requesterId)
      const requesterToken = await authToken(baseUrl, requesterId, 'user', 'approvals:read')

      const detailOk = await jsonRequest(baseUrl, `/api/approvals/${instanceId}`, requesterToken)
      const historyOk = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/history`, requesterToken)
      expect(detailOk.status, await detailOk.clone().text()).toBe(200)
      expect(historyOk.status, await historyOk.clone().text()).toBe(200)

      const outsiderId = freshId('s1c-outsider')
      const outsiderToken = await authToken(baseUrl, outsiderId, 'user', 'approvals:read')
      const detailDenied = await jsonRequest(baseUrl, `/api/approvals/${instanceId}`, outsiderToken)
      const historyDenied = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/history`, outsiderToken)
      expect(detailDenied.status).toBe(404)
      expect(historyDenied.status).toBe(404)
      // OD-S1-11: same values-free envelope on both denial doors — asserted as body equality, not
      // merely equal status (fixture precondition #7 in the S1 implementation brief: the history
      // route has no 404 shape of its own before this slice, so the denial body must be
      // byte-identical to the detail route's, not merely "also a 404").
      const detailBody = await detailDenied.json()
      const historyBody = await historyDenied.json()
      expect(historyBody).toEqual(detailBody)
      expect(detailBody).toEqual({ ok: false, error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval instance not found' } })
    })

    it('never-refreshed plm: mirror ordering trap: /history is called FIRST (no prior detail call), so upsertPlmMirror has never run for this id — the fixture does NOT pre-create the approval_instances row (fixture precondition #2)', async () => {
      const plmId = `plm:${freshId('s1c-mirror')}`
      const viewerToken = await authToken(baseUrl, freshId('s1c-plm-viewer'), 'user', 'approvals:read')

      const before = await pool().query(`SELECT 1 FROM approval_instances WHERE id = $1`, [plmId])
      expect(before.rows.length).toBe(0)

      // /history FIRST — routes/approval-history.ts's plm: branch calls getApprovalHistory ->
      // getPlmHistory, which NEVER touches approval_instances (confirmed at ApprovalBridgeService.ts
      // ~748-754). Whatever status this returns (the PLM adapter runs in its default MOCK mode with
      // no plm.url configured in this test environment), the property under test is materialization,
      // not the exact status.
      const historyResponse = await jsonRequest(baseUrl, `/api/approvals/${encodeURIComponent(plmId)}/history`, viewerToken)
      expect(historyResponse.status).not.toBe(500)

      const afterHistory = await pool().query(`SELECT 1 FROM approval_instances WHERE id = $1`, [plmId])
      expect(afterHistory.rows.length, 'history must NOT materialize the mirror').toBe(0)

      // canReadApprovalInstance is NEVER consulted for a plm: id on either door (OD-S1-18(a); the
      // spy proves it here, not just the predicate's own defensive branch — G-S1-4(i)).
      expect(readabilitySpyState.calls).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------------------------
  // G-S1-4 — plm: ids never subjected to S1; OD-S1-5's source_queue exclusion on a PLATFORM
  // instance, using the EXACT permission-code shape upsertPlmMirror writes.
  // ---------------------------------------------------------------------------------------------
  describe('G-S1-4: plm: ids bypass S1 (spy-zero) + source_queue exclusion', () => {
    it('(i) spy-zero: canReadApprovalInstance is invoked ZERO times for a plm: id across BOTH detail and history', async () => {
      const plmId = `plm:${freshId('s1c-spyzero')}`
      const viewerToken = await authToken(baseUrl, freshId('s1c-spy-viewer'), 'user', 'approvals:read')
      expect(readabilitySpyState.calls).toBe(0)
      await jsonRequest(baseUrl, `/api/approvals/${encodeURIComponent(plmId)}`, viewerToken)
      await jsonRequest(baseUrl, `/api/approvals/${encodeURIComponent(plmId)}/history`, viewerToken)
      expect(readabilitySpyState.calls).toBe(0)
      createdInstanceIds.push(plmId) // in case detail's refresh materialized a row — clean it up either way
    })

    it('(ii) a principal holding plm:source-owned AS A PERMISSION CODE and nothing else is denied on a PLATFORM instance (OD-S1-5 load-bearing per F-2) — detail and history BOTH deny', async () => {
      const requesterId = freshId('s1c-so-requester')
      const instanceId = await seedInstance(requesterId)
      // The EXACT shape upsertPlmMirror writes (ApprovalBridgeService.ts ~1178):
      // ('source_queue', 'plm:source-owned').
      await seedAssignment(instanceId, 'plm:source-owned', 'source_queue')
      const holderToken = await authToken(baseUrl, 'plm:source-owned', 'user', 'approvals:read')
      const detail = await jsonRequest(baseUrl, `/api/approvals/${instanceId}`, holderToken)
      const history = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/history`, holderToken)
      expect(detail.status).toBe(404)
      expect(history.status).toBe(404)
    })
  })

  // ---------------------------------------------------------------------------------------------
  // G-S1-7 — metrics ACL deltas (OD-S1-7/C-2). One gate, four directions.
  // ---------------------------------------------------------------------------------------------
  describe('G-S1-7: metrics route ACL — widen (CC) + narrow (DB admin, DB roles, org pin)', () => {
    async function seedMetrics(instanceId: string): Promise<void> {
      await pool().query(
        `INSERT INTO approval_metrics (instance_id, started_at) VALUES ($1, now())
         ON CONFLICT (instance_id) DO NOTHING`,
        [instanceId],
      )
    }

    it('WIDENING: a CC-only viewer, previously denied by the deleted C-2 inline ACL (no CC arm), now reads instance metrics', async () => {
      const requesterId = freshId('s1c-m-requester')
      const ccUserId = freshId('s1c-m-cc')
      const instanceId = await seedInstance(requesterId)
      await seedMetrics(instanceId)
      await pool().query(
        `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, to_status, to_version, metadata)
         VALUES ($1, 'cc', $2, 'Requester', 'pending', 1, $3::jsonb)`,
        [instanceId, requesterId, JSON.stringify({ targetType: 'user', targetId: ccUserId })],
      )
      const ccToken = await authToken(baseUrl, ccUserId, 'user', 'approvals:read')
      const response = await jsonRequest(baseUrl, `/api/approvals/metrics/instances/${instanceId}`, ccToken)
      expect(response.status, await response.clone().text()).toBe(200)
    })

    it('NARROWING (i): a JWT-only role:\'admin\' claim with NO matching users row is DENIED; the SAME principal WITH the users row is allowed — both inside one test', async () => {
      const instanceId = await seedInstance(freshId('s1c-m-requester2'))
      await seedMetrics(instanceId)
      const claimOnlyAdminId = freshId('s1c-m-jwt-admin')
      const claimOnlyToken = await authToken(baseUrl, claimOnlyAdminId, 'admin', 'approvals:read')
      const deniedResponse = await jsonRequest(baseUrl, `/api/approvals/metrics/instances/${instanceId}`, claimOnlyToken)
      expect(deniedResponse.status, await deniedResponse.clone().text()).toBe(403)

      createdUserIds.push(claimOnlyAdminId)
      await pool().query(
        `INSERT INTO users (id, email, name, password_hash, is_active, is_admin) VALUES ($1, $1||'@example.test', $1, 'x', TRUE, TRUE)`,
        [claimOnlyAdminId],
      )
      const allowedResponse = await jsonRequest(baseUrl, `/api/approvals/metrics/instances/${instanceId}`, claimOnlyToken)
      expect(allowedResponse.status, await allowedResponse.clone().text()).toBe(200)
    })

    it('NARROWING (ii): a role-typed seat matched ONLY by a JWT role claim (no user_roles/users.role row) is DENIED; the same principal with the DB row is allowed', async () => {
      const requesterId = freshId('s1c-m-requester3')
      const instanceId = await seedInstance(requesterId)
      await seedMetrics(instanceId)
      const roleName = `s1c-metrics-role-${TS}-${Math.random().toString(36).slice(2, 6)}`
      await seedAssignment(instanceId, roleName, 'role')
      const roleViewerId = freshId('s1c-m-role-viewer')
      const roleClaimToken = await authToken(baseUrl, roleViewerId, roleName, 'approvals:read')
      const deniedResponse = await jsonRequest(baseUrl, `/api/approvals/metrics/instances/${instanceId}`, roleClaimToken)
      expect(deniedResponse.status, await deniedResponse.clone().text()).toBe(403)

      createdUserIds.push(roleViewerId)
      await pool().query(
        `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
         VALUES ($1, $1||'@example.test', $1, 'x', $2, TRUE, FALSE)`,
        [roleViewerId, roleName],
      )
      const allowedResponse = await jsonRequest(baseUrl, `/api/approvals/metrics/instances/${instanceId}`, roleClaimToken)
      expect(allowedResponse.status, await allowedResponse.clone().text()).toBe(200)
    })

    it('403 CODE/SHAPE is UNCHANGED by the substitution (OD-S1-11): a non-participant gets the SAME FORBIDDEN envelope as before', async () => {
      const instanceId = await seedInstance(freshId('s1c-m-requester4'))
      await seedMetrics(instanceId)
      const outsiderToken = await authToken(baseUrl, freshId('s1c-m-outsider'), 'user', 'approvals:read')
      const response = await jsonRequest(baseUrl, `/api/approvals/metrics/instances/${instanceId}`, outsiderToken)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Not a participant of this approval' } })
    })
  })
})
