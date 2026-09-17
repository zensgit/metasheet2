import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'

/**
 * Approval change-request design lock v5.9 §14.2 判据 III (WI-13) — real-DB acceptance, SCOPED TO
 * 判据 III ONLY. 判据 II (final approve exercises C-1's real attendance cancellation and writes
 * `approval_rounds.outcome='applied'`) and 判据 IV (C-3's system-side `expired`/`blocked` close)
 * are NOT covered here — both depend on WI-10/WI-11/WI-12 (the C-1/C-2 event hooks), which the
 * taskbook (`impl-taskbook-C-change-request-20260918.md` WI-10/11/12) marks "需人判断" and does
 * not exist on this branch (`git grep -n "review_required" packages/core-backend/src | grep -c
 * w4c3b-approved-leave-cancellation` unchanged from origin/main — no C-2 hook landed). This file
 * is the "redemption, 判据 III only" slice named in the sub-unit handoff; 判据 II/IV are separate
 * follow-up files once WI-10/11/12 land, not silently dropped.
 *
 * 判据 III (lock:passim, wired at `ApprovalProductService.ts` — see the in-code comments at the
 * revoke (A4) and reject (A7) branches, `git grep -n "判据 III"`): a cancel-round instance's own
 * revoke/reject terminates its OWN `approval_rounds` row (`engine_instance_id = <instance id>`,
 * NOT `document_id`) in the SAME transaction as the instance's terminal-status write — freeing
 * the document's pending slot (§5 I3, `uq_approval_rounds_pending_document`) so a NEW cancel round
 * can be started for the same document immediately, unlimited times (§5 I6, "撤销不限次" — no
 * `capPerDocument` key anywhere in `policy_snapshot_at_create.roundPolicy`, confirmed by the WI-4
 * creation test's own assertion that the key set is exactly `['suite','windowDays']`).
 *
 * Fixture reuse: same harness as `approval-cancel-round-creation.db.test.ts` (real one-node
 * template, real create+approve through the running server, `createCancelRoundInstance` called
 * in-process — no HTTP route exists for it yet). Duplicated here rather than imported because no
 * sibling file in this corpus shares harness code across `.db.test.ts` files (each is a
 * self-contained fixture, matching this repo's own convention, e.g.
 * `approval-revoke-terminal-guard.db.test.ts` / `approval-add-sign-honesty.db.test.ts`).
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

async function authToken(baseUrl: string, userId: string): Promise<string> {
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

describeIfDatabase('cancel-round redemption (WI-13, 判据 III only): revoke/reject terminate the round', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const createdRoundIds = new Set<string>()
  const grantedUserIds = new Set<string>()

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

  async function publishOneNodeTemplate(adminToken: string, approverId: string, label: string): Promise<string> {
    const templateKey = `wi13-redemption-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'WI-13 cancel-round redemption fixture',
        description: 'approval-cancel-round-redemption.db.test.ts',
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

  async function createApprovedOriginal(
    requesterId: string,
    requesterToken: string,
    approverToken: string,
    templateId: string,
  ): Promise<string> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string }
    createdApprovalIds.add(inst.id)

    const approve = await jsonRequest(baseUrl, `/api/approvals/${inst.id}/actions`, approverToken, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(approve.status, await approve.clone().text()).toBe(200)

    const row = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [inst.id])
    expect(row.rows[0]?.status).toBe('approved')
    return inst.id
  }

  /** Drives a genuinely `approved` original document and starts one pending cancel round on it. */
  async function seedPendingCancelRound(suffix: string): Promise<{
    documentId: string
    requesterId: string
    requesterToken: string
    approverId: string
    approverToken: string
    roundInstanceId: string
  }> {
    const requesterId = `wi13-req-${suffix}`
    const approverId = `wi13-apr-${suffix}`
    const adminId = `wi13-admin-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    const templateId = await publishOneNodeTemplate(adminToken, approverId, suffix)
    const documentId = await createApprovedOriginal(requesterId, requesterToken, approverToken, templateId)

    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)
    const roundRow = await pool().query<{ id: string }>(
      `SELECT id FROM approval_rounds WHERE engine_instance_id = $1 AND outcome = 'pending'`,
      [dto.id],
    )
    expect(roundRow.rows.length).toBe(1)
    createdRoundIds.add(roundRow.rows[0].id)

    return { documentId, requesterId, requesterToken, approverId, approverToken, roundInstanceId: dto.id }
  }

  async function roundOutcome(engineInstanceId: string): Promise<{ outcome: string; ended_at: Date | null }> {
    const row = await pool().query<{ outcome: string; ended_at: Date | null }>(
      `SELECT outcome, ended_at FROM approval_rounds WHERE engine_instance_id = $1`,
      [engineInstanceId],
    )
    expect(row.rows.length).toBe(1)
    return row.rows[0]
  }

  it(
    'chain (§5 I6, 撤销不限次): revoke terminates round 1 (withdrawn) -> a fresh round can start ' +
      'immediately -> reject terminates round 2 (rejected) -> a third round can start immediately',
    async () => {
      const suffix = `chain-${TS}`
      const fixture = await seedPendingCancelRound(suffix)

      // --- Round 1: revoke, by the ORIGINAL requester (A4's own authz — actor.userId must equal
      // the cancel-round instance's own requester_snapshot.id, which WI-4 pins to the original
      // document's requester). ---
      const revoke = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.requesterToken, {
        method: 'POST',
        body: { action: 'revoke' },
      })
      expect(revoke.status, await revoke.clone().text()).toBe(200)
      const afterRevoke = await roundOutcome(fixture.roundInstanceId)
      expect(afterRevoke.outcome).toBe('withdrawn')
      expect(afterRevoke.ended_at).not.toBeNull()
      const instanceAfterRevoke = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [fixture.roundInstanceId],
      )
      expect(instanceAfterRevoke.rows[0]?.status).toBe('revoked')

      // §5 I3's pending slot is now free (round 1 is terminal) — §5 I6 says this is not
      // count-limited: start a SECOND cancel round for the SAME document immediately.
      const service = new ApprovalProductService()
      const second = await service.createCancelRoundInstance(fixture.documentId, { userId: fixture.requesterId })
      createdApprovalIds.add(second.id)
      const secondRoundRow = await pool().query<{ id: string }>(
        `SELECT id FROM approval_rounds WHERE engine_instance_id = $1 AND outcome = 'pending'`,
        [second.id],
      )
      expect(secondRoundRow.rows.length).toBe(1)
      createdRoundIds.add(secondRoundRow.rows[0].id)

      // --- Round 2: reject, by the resolved SEAT (the original approver) — reject requires an
      // active assignee at the current node (`actorCanAct`), not the requester, and the seed's
      // `nodeOperationPolicy.commentRequired: 'reject_only'` demands a comment. ---
      const reject = await jsonRequest(baseUrl, `/api/approvals/${second.id}/actions`, fixture.approverToken, {
        method: 'POST',
        body: { action: 'reject', comment: 'redemption test round 2 reject' },
      })
      expect(reject.status, await reject.clone().text()).toBe(200)
      const afterReject = await roundOutcome(second.id)
      expect(afterReject.outcome).toBe('rejected')
      expect(afterReject.ended_at).not.toBeNull()
      const instanceAfterReject = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [second.id],
      )
      expect(instanceAfterReject.rows[0]?.status).toBe('rejected')

      // A THIRD cancel round on the SAME document succeeds immediately — no `capPerDocument`
      // anywhere (§5 I6). This is the count, not just the mechanism: two prior terminal rounds on
      // this one document did not consume any budget.
      const third = await service.createCancelRoundInstance(fixture.documentId, { userId: fixture.requesterId })
      createdApprovalIds.add(third.id)
      const thirdRoundRow = await pool().query<{ id: string; outcome: string }>(
        `SELECT id, outcome FROM approval_rounds WHERE engine_instance_id = $1`,
        [third.id],
      )
      expect(thirdRoundRow.rows.length).toBe(1)
      expect(thirdRoundRow.rows[0].outcome).toBe('pending')
      createdRoundIds.add(thirdRoundRow.rows[0].id)

      // Exactly THREE `approval_rounds` rows total for this document (1 withdrawn, 1 rejected, 1
      // pending) — the chain did not fork or drop a row anywhere.
      const allRounds = await pool().query<{ outcome: string }>(
        `SELECT outcome FROM approval_rounds WHERE document_id = $1 ORDER BY started_at`,
        [fixture.documentId],
      )
      expect(allRounds.rows.map((r) => r.outcome)).toEqual(['withdrawn', 'rejected', 'pending'])
    },
  )

  it(
    'DISCRIMINATING CONTROL: revoking one document\'s round does not touch a DIFFERENT ' +
      "document's own pending round (keyed on engine_instance_id, not \"any pending round\")",
    async () => {
      const fixtureA = await seedPendingCancelRound(`ctrl-a-${TS}`)
      const fixtureB = await seedPendingCancelRound(`ctrl-b-${TS}`)

      const revokeA = await jsonRequest(baseUrl, `/api/approvals/${fixtureA.roundInstanceId}/actions`, fixtureA.requesterToken, {
        method: 'POST',
        body: { action: 'revoke' },
      })
      expect(revokeA.status, await revokeA.clone().text()).toBe(200)

      const outcomeA = await roundOutcome(fixtureA.roundInstanceId)
      expect(outcomeA.outcome).toBe('withdrawn')

      // B's round must be COMPLETELY UNTOUCHED — still pending, `ended_at` still null. A query
      // keyed on `document_id` alone, or one that terminated "any pending round", would have
      // caught B here (B's engine_instance_id differs from A's; only a genuine per-instance key
      // discriminates them, since both were seeded from the same shared seed definition).
      const outcomeB = await roundOutcome(fixtureB.roundInstanceId)
      expect(outcomeB.outcome).toBe('pending')
      expect(outcomeB.ended_at).toBeNull()

      // POSITIVE CONTROL — B's own round still terminates correctly afterwards, proving the
      // guard above isn't vacuously green because B's round was already broken some other way.
      const revokeB = await jsonRequest(baseUrl, `/api/approvals/${fixtureB.roundInstanceId}/actions`, fixtureB.requesterToken, {
        method: 'POST',
        body: { action: 'revoke' },
      })
      expect(revokeB.status, await revokeB.clone().text()).toBe(200)
      const outcomeBAfter = await roundOutcome(fixtureB.roundInstanceId)
      expect(outcomeBAfter.outcome).toBe('withdrawn')
    },
  )

  it('erratum (not a lock quote — implementer choice, flagged for owner registration): a broken ' +
    'one-round-per-instance invariant fails closed with CANCEL_ROUND_INVARIANT_VIOLATION (409), ' +
    'not a silent commit of an orphaned pending round', async () => {
    const fixture = await seedPendingCancelRound(`invariant-${TS}`)

    // Manually break WI-4's own invariant: terminate the round OUT OF BAND (simulating a
    // duplicate/dangling row) so the revoke branch's own `rowCount !== 1` check fires.
    await pool().query(
      `UPDATE approval_rounds SET outcome = 'expired', ended_at = now() WHERE engine_instance_id = $1`,
      [fixture.roundInstanceId],
    )

    const revoke = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.requesterToken, {
      method: 'POST',
      body: { action: 'revoke' },
    })
    expect(revoke.status).toBe(409)
    const body = (await revoke.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('CANCEL_ROUND_INVARIANT_VIOLATION')

    // The whole transaction rolled back — the instance must NOT have been left `revoked` with no
    // matching round transition (that would be the "silent commit of an orphan" this check exists
    // to prevent).
    const instanceRow = await pool().query<{ status: string }>(
      `SELECT status FROM approval_instances WHERE id = $1`,
      [fixture.roundInstanceId],
    )
    expect(instanceRow.rows[0]?.status).toBe('pending')
  })
})
