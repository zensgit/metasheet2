import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor, ensureLocalUserRow } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { isCancelRoundInstance } from '../../src/attendance/w4c3b-central-approval-hooks'

/**
 * Approval change-request design lock v5.9 §14.3 outlets #12/#13 (lock:373-374) — real-DB
 * acceptance for the two SEAT-WRITE chokepoints named in the sub-unit handoff's "outlet-guards /
 * seat-guards" split (`bulkReassignApprovals` and `applyApprovalDepartureTransfer` are the only
 * two mutators of `approval_assignments` outside the graph executor itself — see the lock's own
 * outlet table). Both guard sites share one mechanism (`rejectIfCancelRound`, thrown as
 * `CancelRoundOutletForbiddenError`, caught by a typed catch that records a per-instance skip
 * with reason `'cancel_round'` rather than falling into the method's own generic catch and
 * becoming an unnamed skip — lock:373-374, complaint P2-B in the 5th-round review).
 *
 * NOT covered by this file: #2/#3/#7/#7′/#8 (a separate "outlet-guards" file per the taskbook
 * split — those chokepoints sit on the decide/dispatch/legacy-route paths, not seat-writers);
 * attendance-parity and attendance-FK-migration (separate files); 判据 II/IV of redemption
 * (depend on WI-10/11/12, not on this branch).
 *
 * Fixture reuse: same harness as `approval-cancel-round-creation.db.test.ts` (real one-node
 * template, real create+approve through the running server, `createCancelRoundInstance` called
 * in-process — no HTTP route exists for it yet). Duplicated here rather than imported, matching
 * this corpus's own convention (each `.db.test.ts` file is self-contained — see
 * `approval-cancel-round-redemption.db.test.ts`'s identical note).
 */
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

/**
 * Lock §2-G3 fixture delta (Codex review 2026-09-19 finding 1). `GET /api/auth/dev-token` signs a
 * JWT and writes NO `users` row, so before this fix every cancel-round fixture's approver was a
 * person the directory had never heard of. The creation path now re-qualifies every seat against
 * the directory with the shared login gate, and — like the precedent it reuses,
 * `validateAndFreezeRequesterChoices`'s company-scope baseline — an id with no `users` row is not
 * in the eligible set and fails closed. Production approvers always have a row (they authenticated
 * to approve), so the fixtures are made production-shaped rather than the guard made fail-open.
 */
const mintedUserIds = new Set<string>()

async function authToken(baseUrl: string, userId: string): Promise<string> {
  await ensureLocalUserRow(userId)
  mintedUserIds.add(userId)
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { token: string }
  return payload.token
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

function buildFormSchema() {
  return { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] }
}

/** `start -> approval_a -> end`: a single approval node, one assignee, single approvalMode. */
function oneNodeGraph(approverId: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_a',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: [approverId], approvalMode: 'single' },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-end', source: 'approval_a', target: 'end' },
    ],
  }
}

describeIfDatabase('cancel-round seat guards (§14.3 #12/#13): a cancel-round seat is never reassigned', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const createdRoundIds = new Set<string>()
  const grantedUserIds = new Set<string>()
  const createdPlainUserIds = new Set<string>()

  const pool = () => poolManager.get()

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    try {
      const approvalIds = [...createdApprovalIds]
      const roundIds = [...createdRoundIds]
      const templateIds = [...createdTemplateIds]
      if (roundIds.length > 0) {
        await pool().query('DELETE FROM approval_rounds WHERE id = ANY($1::text[])', [roundIds])
      }
      if (approvalIds.length > 0) {
        await pool().query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_metrics WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds])
      }
      if (templateIds.length > 0) {
        await pool().query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
      if (createdPlainUserIds.size > 0) {
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [[...createdPlainUserIds]])
      }
      if (mintedUserIds.size > 0) {
        // Lock §2-G3 fixture delta — drop the `users` rows this file's `authToken` minted.
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [[...mintedUserIds]])
        mintedUserIds.clear()
      }
      if (grantedUserIds.size > 0) {
        await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[...grantedUserIds]])
      }
    } finally {
      await server?.stop()
    }
  })

  async function grantWrite(userId: string): Promise<void> {
    grantedUserIds.add(userId)
    await grantApprovalWriteForIntegrationActor(userId)
  }

  /** Bulk-reassign's `toUserId` and departure-transfer's `resolvedManagerId` are read from a real
   * `users` row (`is_active = TRUE`) — dev-token auth never inserts one. */
  async function insertPlainUser(userId: string): Promise<void> {
    createdPlainUserIds.add(userId)
    await pool().query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x') ON CONFLICT (id) DO NOTHING`, [
      userId,
      `${userId}@example.test`,
    ])
  }

  async function publishOneNodeTemplate(adminToken: string, approverId: string, label: string): Promise<string> {
    const templateKey = `wi-seat-guard-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'seat-guards cancel-round fixture',
        description: 'approval-cancel-round-seat-guards.db.test.ts',
        formSchema: buildFormSchema(),
        approvalGraph: oneNodeGraph(approverId),
      },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const template = (await create.json()) as { id: string }
    createdTemplateIds.add(template.id)
    const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publishResponse.status, await publishResponse.clone().text()).toBe(200)
    return template.id
  }

  async function createPendingInstance(
    requesterId: string,
    requesterToken: string,
    templateId: string,
  ): Promise<string> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string }
    createdApprovalIds.add(inst.id)
    return inst.id
  }

  async function approve(approverToken: string, instanceId: string): Promise<void> {
    const approveResponse = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, approverToken, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(approveResponse.status, await approveResponse.clone().text()).toBe(200)
    const row = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [instanceId])
    expect(row.rows[0]?.status).toBe('approved')
  }

  async function createCancelRound(requesterId: string, documentId: string): Promise<string> {
    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)
    const roundRow = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE engine_instance_id = $1`, [
      dto.id,
    ])
    if (roundRow.rows[0]) createdRoundIds.add(roundRow.rows[0].id)
    const instanceRow = await pool().query(`SELECT * FROM approval_instances WHERE id = $1`, [dto.id])
    expect(isCancelRoundInstance(instanceRow.rows[0])).toBe(true)
    return dto.id
  }

  it('#12 bulkReassignApprovals — a cancel-round instance is skipped `cancel_round`, its seat untouched, while a sibling pending instance on the SAME assignee reassigns normally', async () => {
    const suffix = `bulk-${TS}`
    const approverId = `wi-seat-apr-${suffix}` // shared seat holder across both instances
    const requesterId1 = `wi-seat-req1-${suffix}`
    const requesterId2 = `wi-seat-req2-${suffix}`
    const toUserId = `wi-seat-to-${suffix}`
    await grantWrite(requesterId1)
    await grantWrite(requesterId2)
    await insertPlainUser(toUserId)
    const adminToken = await authToken(baseUrl, `wi-seat-admin-${suffix}`)
    const requesterToken1 = await authToken(baseUrl, requesterId1)
    const requesterToken2 = await authToken(baseUrl, requesterId2)
    const approverToken = await authToken(baseUrl, approverId)

    // Instance A: original document approved, then a cancel round is opened against it — the
    // cancel-round instance's own seat holder is the SAME `approverId`.
    const templateA = await publishOneNodeTemplate(adminToken, approverId, 'a')
    const documentA = await createPendingInstance(requesterId1, requesterToken1, templateA)
    await approve(approverToken, documentA)
    const cancelRoundInstanceId = await createCancelRound(requesterId1, documentA)

    // Instance B: an ORDINARY pending instance on the same approver — the positive control proving
    // the guard is selective, not a global freeze of `approverId`'s seats.
    const templateB = await publishOneNodeTemplate(adminToken, approverId, 'b')
    const documentB = await createPendingInstance(requesterId2, requesterToken2, templateB)

    const versionBefore = await pool().query<{ version: number }>(
      `SELECT version FROM approval_instances WHERE id = $1`,
      [cancelRoundInstanceId],
    )

    const service = new ApprovalProductService()
    const result = await service.bulkReassignApprovals(
      { fromUserId: approverId, toUserId, instanceIds: [cancelRoundInstanceId, documentB], reason: 'seat-guard test' },
      { userId: `wi-seat-actor-${suffix}`, userName: 'seat guard actor' },
    )

    expect(result.skipped).toContainEqual({ id: cancelRoundInstanceId, reason: 'cancel_round' })
    expect(result.succeeded).toContain(documentB)
    expect(result.succeeded).not.toContain(cancelRoundInstanceId)

    // The cancel-round instance's seat is byte-identical to before the call: still `approverId`,
    // still active.
    const cancelRoundSeats = await pool().query<{ assignee_id: string; is_active: boolean }>(
      `SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1`,
      [cancelRoundInstanceId],
    )
    expect(cancelRoundSeats.rows).toEqual([{ assignee_id: approverId, is_active: true }])

    // The instance's own `version` is unchanged — the ROLLBACK genuinely left zero DML behind
    // (not merely a seat that happens to read the same after a write-then-revert).
    const versionAfter = await pool().query<{ version: number }>(
      `SELECT version FROM approval_instances WHERE id = $1`,
      [cancelRoundInstanceId],
    )
    expect(versionAfter.rows[0]?.version).toBe(versionBefore.rows[0]?.version)

    // Instance B's seat DID move — the positive control's own assertion, so a future regression
    // that makes the guard swallow ALL instances (not just cancel-round ones) shows up here too.
    const documentBSeats = await pool().query<{ assignee_id: string; is_active: boolean }>(
      `SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`,
      [documentB],
    )
    expect(documentBSeats.rows).toEqual([{ assignee_id: toUserId, is_active: true }])
  })

  it('#13 applyApprovalDepartureTransfer — a cancel-round instance is skipped `cancel_round`, its seat untouched, while a sibling pending instance on the SAME departed user transfers to the manager', async () => {
    const suffix = `departure-${TS}`
    const approverId = `wi-seat-dep-apr-${suffix}` // the departing user, shared seat holder
    const requesterId1 = `wi-seat-dep-req1-${suffix}`
    const requesterId2 = `wi-seat-dep-req2-${suffix}`
    const managerId = `wi-seat-dep-mgr-${suffix}`
    await grantWrite(requesterId1)
    await grantWrite(requesterId2)
    await insertPlainUser(managerId)
    const adminToken = await authToken(baseUrl, `wi-seat-dep-admin-${suffix}`)
    const requesterToken1 = await authToken(baseUrl, requesterId1)
    const requesterToken2 = await authToken(baseUrl, requesterId2)
    const approverToken = await authToken(baseUrl, approverId)

    const templateA = await publishOneNodeTemplate(adminToken, approverId, 'a')
    const documentA = await createPendingInstance(requesterId1, requesterToken1, templateA)
    await approve(approverToken, documentA)
    const cancelRoundInstanceId = await createCancelRound(requesterId1, documentA)

    const templateB = await publishOneNodeTemplate(adminToken, approverId, 'b')
    const documentB = await createPendingInstance(requesterId2, requesterToken2, templateB)

    const versionBefore = await pool().query<{ version: number }>(
      `SELECT version FROM approval_instances WHERE id = $1`,
      [cancelRoundInstanceId],
    )

    const service = new ApprovalProductService()
    const result = await service.applyApprovalDepartureTransfer(approverId, { resolvedManagerId: managerId })

    expect(result.skipped).toContainEqual({ id: cancelRoundInstanceId, reason: 'cancel_round' })
    expect(result.transferred).toContain(documentB)
    expect(result.transferred).not.toContain(cancelRoundInstanceId)

    const cancelRoundSeats = await pool().query<{ assignee_id: string; is_active: boolean }>(
      `SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1`,
      [cancelRoundInstanceId],
    )
    expect(cancelRoundSeats.rows).toEqual([{ assignee_id: approverId, is_active: true }])

    // Same evidence as #12 above: the ROLLBACK left zero DML behind, not just a coincidentally
    // unchanged seat.
    const versionAfter = await pool().query<{ version: number }>(
      `SELECT version FROM approval_instances WHERE id = $1`,
      [cancelRoundInstanceId],
    )
    expect(versionAfter.rows[0]?.version).toBe(versionBefore.rows[0]?.version)

    const documentBSeats = await pool().query<{ assignee_id: string; is_active: boolean }>(
      `SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`,
      [documentB],
    )
    expect(documentBSeats.rows).toEqual([{ assignee_id: managerId, is_active: true }])
  })
})
