import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor, ensureLocalUserRow } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { eventBus } from '../../src/integration/events/event-bus'

/**
 * Approval change-request design lock v5.9 §14.2 — real-DB acceptance for 判据 III (WI-13,
 * phase 1) and, appended by phase 2, the 判据 IV `expired` half (C-3's system-side close at the
 * new outlet #5′).
 *
 * SCOPE CORRECTION (phase 2, this branch). Phase 1's header said 判据 II and 判据 IV "are NOT
 * covered here … separate follow-up files". The 判据 IV half is now covered HERE rather than in a
 * new file — deliberately: a new `.db.test.ts` would have to be wired into `plugin-tests.yml`,
 * into `scripts/ops/ci-realdb-step-contract.mjs`'s hard-coded `FILES` array (a closed world that
 * stays green for a file it does not list) and would force an s6a provenance re-pin, none of
 * which buys coverage this file's already-wired fixture cannot give. What is STILL not covered:
 *   - 判据 II (the `redeem` branch runs C-1 through the W4 external transaction entry and writes
 *     `approval_rounds.outcome = 'applied'`) — not implemented yet; the `redeem` case below
 *     asserts what the branch does TODAY, including the round row it leaves `pending`.
 *   - 判据 IV's `blocked` half — it is produced by C-1's `business_refused` return, so it lands
 *     with 判据 II, not before it.
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

describeIfDatabase('cancel-round redemption (WI-13): 判据 III revoke/reject + 判据 IV expired close', () => {
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

  /**
   * Drives a genuinely `approved` original document and starts one pending cancel round on it.
   * `beforeRound` (phase 2) runs after the original is `approved` and BEFORE the cancel round is
   * created, which is where the 判据 IV cases move §2-G2's time anchor / the document's
   * `windowDays` — both must already be in place when `policy_snapshot_at_create` is written, or
   * the two snapshot time points would differ for a reason the fixture did not intend.
   */
  async function seedPendingCancelRound(
    suffix: string,
    beforeRound?: (documentId: string) => Promise<void>,
  ): Promise<{
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
    if (beforeRound) await beforeRound(documentId)

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
    '判据 III 正控 2 (§14.2, §6 "仅原 requester"): a non-original-requester actor cannot revoke ' +
      'the cancel-round instance (403 APPROVAL_REVOKE_FORBIDDEN — NOT the create-time ' +
      'CANCEL_ROUND_REQUESTER_ONLY, a different code on a different path, §14.1 note)',
    async () => {
      // Gate review P1-B row 1: this is the positive-evidence half of §6 "仅原 requester" for the
      // REVOKE branch (A4, `requesterSnapshot?.id !== actor.userId`) — distinct from WI-16's
      // create-time `CANCEL_ROUND_REQUESTER_ONLY` gate in `creation.db.test.ts`, which the lock
      // itself warns looks alike (§14.1: "两者混同正是…陷阱").
      //
      // Gate review P3-C item 1 mutation probe (verification MD Part E, §E1): this test's own
      // 403 assertion below is itself downstream of the seed's `allowRevoke` gate
      // (`ApprovalProductService.ts:10554`, checked BEFORE the requester-identity check this test
      // targets) — with `allowRevoke=false` the impostor would get 409 APPROVAL_REVOKE_DISABLED
      // here instead of 403. Not a defect (the seed's real value is `true`, and this is the shipped
      // chokepoint order), but worth knowing before "fixing" a future 409 here by touching identity
      // logic instead of checking `allowRevoke` first.
      const suffix = `revoke-forbidden-${TS}`
      const fixture = await seedPendingCancelRound(suffix)
      const impostorId = `wi13-impostor-${suffix}`
      const impostorToken = await authToken(baseUrl, impostorId)

      const revoke = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, impostorToken, {
        method: 'POST',
        body: { action: 'revoke' },
      })
      expect(revoke.status).toBe(403)
      const body = (await revoke.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('APPROVAL_REVOKE_FORBIDDEN')

      // The round must be untouched by the rejected attempt — still pending.
      const outcome = await roundOutcome(fixture.roundInstanceId)
      expect(outcome.outcome).toBe('pending')
      expect(outcome.ended_at).toBeNull()

      // POSITIVE CONTROL — the true original requester still succeeds against the SAME round,
      // proving the guard above isn't vacuously green because the round was broken some other way.
      const revokeByRequester = await jsonRequest(
        baseUrl,
        `/api/approvals/${fixture.roundInstanceId}/actions`,
        fixture.requesterToken,
        { method: 'POST', body: { action: 'revoke' } },
      )
      expect(revokeByRequester.status, await revokeByRequester.clone().text()).toBe(200)
      const outcomeAfter = await roundOutcome(fixture.roundInstanceId)
      expect(outcomeAfter.outcome).toBe('withdrawn')
    },
  )

  it(
    '§14.1 seed evidence: reject without a comment is rejected with the named error code ' +
      '(400 REJECT_COMMENT_REQUIRED, not a bare 400), proving the comment gate is present for ' +
      'the cancel-round node',
    async () => {
      // Gate review P1-B row 2: the "chain" test above always sends a comment on reject, so it
      // never exercises the comment gate's negative side — the seed's node policy resolves via
      // `effectiveCommentRequired` to `'reject_only'` (lock §14.1), which must actually 400 when
      // the request has no `comment`, not silently accept it.
      const suffix = `reject-comment-${TS}`
      const fixture = await seedPendingCancelRound(suffix)

      // EXPLICITNESS PIN (lock §14.1: "节点操作的评论要求 = 显式值 ... 不靠默认") — the 400 below is
      // reachable via TWO independent routes: the node's own explicit `commentRequired` OR (if that
      // key were ever dropped) `effectiveCommentRequired`'s fallback to the instance snapshot, which
      // ALSO resolves an absent value to `'reject_only'` (`approval-effective-node-operations.ts`).
      // A `cp`/raw-SQL mutation probe on `metasheet2_lock_c` confirmed the fallback alone keeps the
      // 400-below green (see the verification MD Part D's D2 update) — so the HTTP assertion by
      // itself does NOT discriminate "seed wrote it explicitly" from "seed omitted it and the
      // fallback covered". This assertion reads the seed's own published-definition row and pins the
      // explicit value directly, the same discipline as the CJS mirror-constant test elsewhere in
      // this lane.
      const publishedDefinition = await pool().query<{ runtime_graph: { nodes: Array<{ key: string; config?: { approvalMode?: string; nodeOperationPolicy?: { commentRequired?: string } } }> } }>(
        `SELECT pd.runtime_graph
           FROM approval_instances i
           JOIN approval_published_definitions pd ON pd.id = i.published_definition_id
          WHERE i.id = $1`,
        [fixture.roundInstanceId],
      )
      const cancelApprovalNode = publishedDefinition.rows[0]?.runtime_graph.nodes.find(
        (node) => node.key === 'cancel_approval',
      )
      expect(cancelApprovalNode?.config?.nodeOperationPolicy?.commentRequired).toBe('reject_only')
      // Gate review round 2, P2-1: lock §14.1's node-config sentence names TWO explicit-value
      // requirements in the same breath — `commentRequired` (pinned above) and `approvalMode`
      // ("会签 'all'", not `normalizeApprovalMode`'s undefined-fallback default). Only the first
      // half had a pin; this closes the other half against the same seeded row already fetched
      // above (not a test-local fixture — those all use `'single'` and would pin nothing).
      expect(cancelApprovalNode?.config?.approvalMode).toBe('all')

      const reject = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
        method: 'POST',
        body: { action: 'reject' },
      })
      expect(reject.status).toBe(400)
      const body = (await reject.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('REJECT_COMMENT_REQUIRED')

      // The round must be untouched by the rejected attempt — still pending.
      const outcome = await roundOutcome(fixture.roundInstanceId)
      expect(outcome.outcome).toBe('pending')
      expect(outcome.ended_at).toBeNull()

      // POSITIVE CONTROL — the same reject action WITH a comment succeeds and terminates the
      // round, proving the 400 above isn't vacuously green because reject itself was broken.
      const rejectWithComment = await jsonRequest(
        baseUrl,
        `/api/approvals/${fixture.roundInstanceId}/actions`,
        fixture.approverToken,
        { method: 'POST', body: { action: 'reject', comment: 'positive control for REJECT_COMMENT_REQUIRED' } },
      )
      expect(rejectWithComment.status, await rejectWithComment.clone().text()).toBe(200)
      const outcomeAfter = await roundOutcome(fixture.roundInstanceId)
      expect(outcomeAfter.outcome).toBe('rejected')
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

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // 判据 IV (§14.2) — C-3's system-side close at the NEW outlet #5′.
  //
  // The two cases below are an ISOLATED pair: identical fixture, identical action, ONE field
  // different (the original document's `windowDays`, 90 by default vs. 365). Everything else —
  // the §2-G2 anchor moved 200 days into the past, the seat, the approver, the route — is held
  // constant, so a difference in outcome can only be the window predicate. Without the second
  // case, "the round closed as expired" would also be satisfied by an implementation that closes
  // EVERY cancel-round approve, and the 「零完成事件」 assertion would have no evidence that the
  // channel it counts on can go non-zero at all.
  // ───────────────────────────────────────────────────────────────────────────────────────────────

  /** §2-G2 「时间锚固定为首次对应时间(撤销:初始轮 `approved_at`)」 — move the anchor, not the clock. */
  async function ageApprovedAnchor(documentId: string, days: number): Promise<void> {
    const aged = await pool().query(
      `UPDATE approval_records SET created_at = now() - make_interval(days => $2::int)
        WHERE instance_id = $1 AND to_status = 'approved'`,
      [documentId, days],
    )
    expect(aged.rowCount).toBe(1)
  }

  async function setDocumentWindowDays(documentId: string, windowDays: number): Promise<void> {
    const updated = await pool().query(
      `UPDATE approval_instances
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('windowDays', $2::int)
        WHERE id = $1`,
      [documentId, windowDays],
    )
    expect(updated.rowCount).toBe(1)
  }

  /**
   * Counts approval completion events for ONE instance on the live in-process channel
   * (`emitApprovalCompletionEvent` -> `eventBus`). This channel is the one that is ACTIVE with
   * durable delivery OFF, which is this lane's configuration — counting the durable outbox instead
   * would be vacuous here, since it is empty either way when the flag is off.
   */
  function captureCompletionEvents(instanceId: string): { seen: string[]; stop: () => void } {
    const seen: string[] = []
    const ids = (['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled'] as const).map(
      (type) =>
        eventBus.subscribe(type, (payload: unknown) => {
          const approval = (payload as { approval?: { instanceId?: unknown } } | null)?.approval
          if (approval && approval.instanceId === instanceId) seen.push(type)
        }),
    )
    return { seen, stop: () => ids.forEach((id) => eventBus.unsubscribe(id)) }
  }

  it(
    '判据 IV (§14.2, outlet #5′): the in-lock final evaluation finds the §2-G2 window closed ⇒ ' +
      'engine `rejected` by the system sentinel with reason `round_expired`, round `expired` + ' +
      '`ended_at` + decision snapshot, seats released, ZERO completion events, and the document ' +
      'is free for a new round (§5 I3)',
    async () => {
      const suffix = `ivexp-${TS}`
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        // 200 days > the `leave` suite's default 90-day window (lock:143) — no `windowDays`
        // override, so the ceiling in play is the one the production derivation picks.
        await ageApprovedAnchor(documentId, 200)
      })

      const capture = captureCompletionEvents(fixture.roundInstanceId)
      let approve: Response
      try {
        approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(approve.status, await approve.clone().text()).toBe(200)
      } finally {
        capture.stop()
      }

      // 「零完成事件」. Its discriminating power is the sibling case below, which sees exactly one.
      expect(capture.seen).toEqual([])

      // `return` 一个与 dispatchAction 自身底部 return 同形的 UnifiedApprovalDTO — a real DTO for
      // THIS instance, reporting the closed state, not the pre-close one.
      const dto = (await approve.json()) as { id?: string; status?: string }
      expect(dto.id).toBe(fixture.roundInstanceId)
      expect(dto.status).toBe('rejected')

      // 引擎 `status='rejected'` (C-3 「复用现有 rejected」, no new engine terminal state).
      const instanceRow = await pool().query<{ status: string; current_node_key: string | null }>(
        `SELECT status, current_node_key FROM approval_instances WHERE id = $1`,
        [fixture.roundInstanceId],
      )
      expect(instanceRow.rows[0]?.status).toBe('rejected')
      expect(instanceRow.rows[0]?.current_node_key).toBeNull()

      // actor = 系统终结身份, reason = `round_expired`, both 「历史记录必须能查出来」 — queried here
      // exactly as a later audit would, off `approval_records`.
      const records = await pool().query<{ actor_id: string; metadata: Record<string, unknown> }>(
        `SELECT actor_id, metadata FROM approval_records
          WHERE instance_id = $1 AND to_status = 'rejected'`,
        [fixture.roundInstanceId],
      )
      expect(records.rows.length).toBe(1)
      expect(records.rows[0].actor_id).toBe('system:approval-cancel-round')
      expect(records.rows[0].metadata.cancelRoundSystemClose).toBe(true)
      expect(records.rows[0].metadata.cancelRoundCloseReason).toBe('round_expired')
      expect(records.rows[0].metadata.cancelRoundOutcome).toBe('expired')
      // It must NOT be confusable with an approver's own reject: the only real-person reject on
      // this instance would carry the approver's id.
      expect(records.rows[0].actor_id).not.toBe(fixture.approverId)

      // 轮次 `expired` + `ended_at` + §4's decision-time snapshot, 同形 with the creation one.
      const round = await pool().query<{
        outcome: string
        ended_at: Date | null
        block_reason: string | null
        policy_snapshot_at_create: Record<string, unknown>
        policy_snapshot_at_decision: Record<string, unknown> | null
      }>(
        `SELECT outcome, ended_at, block_reason, policy_snapshot_at_create, policy_snapshot_at_decision
           FROM approval_rounds WHERE engine_instance_id = $1`,
        [fixture.roundInstanceId],
      )
      expect(round.rows.length).toBe(1)
      expect(round.rows[0].outcome).toBe('expired')
      expect(round.rows[0].ended_at).not.toBeNull()
      // `block_reason` belongs to the `blocked` cause only — an expired round must not borrow it.
      expect(round.rows[0].block_reason).toBeNull()
      expect(round.rows[0].policy_snapshot_at_decision).not.toBeNull()
      expect(Object.keys(round.rows[0].policy_snapshot_at_decision as Record<string, unknown>).sort()).toEqual(
        Object.keys(round.rows[0].policy_snapshot_at_create).sort(),
      )
      expect(
        (round.rows[0].policy_snapshot_at_decision as { roundPolicy?: Record<string, unknown> }).roundPolicy,
      ).toEqual({ windowDays: 90, suite: 'leave' })

      // 席位失效 — an END-STATE assertion. Mutation M-6 (delete the closure's own
      // `deactivateAllActiveAssignments`) leaves this GREEN: the acting seat is already
      // deactivated upstream by the approve mode (`ApprovalProductService.ts:11470` for `'all'`).
      // Recorded as a state check, NOT as evidence that the closure's call is load-bearing.
      const seats = await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`,
        [fixture.roundInstanceId],
      )
      expect(seats.rows[0].count).toBe('0')

      // §5 I3 「终结即释放」 — the partial unique index is `WHERE outcome = 'pending'`, so a closed
      // round frees the document. A new round starts immediately.
      const next = await new ApprovalProductService().createCancelRoundInstance(fixture.documentId, {
        userId: fixture.requesterId,
      })
      createdApprovalIds.add(next.id)
      const nextRound = await pool().query<{ id: string }>(
        `SELECT id FROM approval_rounds WHERE engine_instance_id = $1 AND outcome = 'pending'`,
        [next.id],
      )
      expect(nextRound.rows.length).toBe(1)
      createdRoundIds.add(nextRound.rows[0].id)
    },
  )

  it(
    '判据 IV fail-closed (implementer choice, flagged for owner registration): a document with no ' +
      '§2-G2 anchor is NOT closed as `expired` — the named code CANCEL_ROUND_WINDOW_ANCHOR_MISSING ' +
      '(409) rolls the whole transaction back, leaving the round `pending` and retryable',
    async () => {
      const fixture = await seedPendingCancelRound(`ivanchor-${TS}`, async (documentId) => {
        // Erase the anchor the window is measured from, WITHOUT changing the document's status —
        // the legacy/bridge shape the guard exists for: `approved` with no approved transition on
        // its own audit trail.
        const erased = await pool().query(
          `UPDATE approval_records SET to_status = 'pending'
            WHERE instance_id = $1 AND to_status = 'approved'`,
          [documentId],
        )
        expect(erased.rowCount).toBe(1)
      })

      const capture = captureCompletionEvents(fixture.roundInstanceId)
      let approve: Response
      try {
        approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
      } finally {
        capture.stop()
      }
      expect(approve.status).toBe(409)
      // The NAMED code, not a bare 409 — the instance-level 409s on this route
      // (`APPROVAL_RUNTIME_UNSUPPORTED`, `CANCEL_ROUND_OUTLET_FORBIDDEN`, …) must stay tellable
      // apart from this one.
      const body = (await approve.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('CANCEL_ROUND_WINDOW_ANCHOR_MISSING')
      expect(capture.seen).toEqual([])

      // C-3 row 5 (基础设施异常): the transaction rolled back, so the round keeps its seat and the
      // instance is untouched — retryable, not irreversibly closed.
      const round = await roundOutcome(fixture.roundInstanceId)
      expect(round.outcome).toBe('pending')
      expect(round.ended_at).toBeNull()
      const instanceRow = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [fixture.roundInstanceId],
      )
      expect(instanceRow.rows[0]?.status).toBe('pending')
      const seats = await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`,
        [fixture.roundInstanceId],
      )
      expect(seats.rows[0].count).toBe('1')
    },
  )

  it(
    '判据 IV 正控 / 隔离对照 (same fixture, only `windowDays` differs): an OPEN window is NOT ' +
      'closed by outlet #5′ — the instance goes `approved`, EXACTLY ONE completion event is ' +
      'emitted (so the sibling case’s zero is a measurement, not an inert channel), and the ' +
      'round row is left `pending` — the DISCLOSED 判据 II gap, asserted as it is today',
    async () => {
      const suffix = `ivopen-${TS}`
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 200)
        // The ONLY difference from the case above: 365 > 200, so the window is still open.
        await setDocumentWindowDays(documentId, 365)
      })

      const capture = captureCompletionEvents(fixture.roundInstanceId)
      let approve: Response
      try {
        approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(approve.status, await approve.clone().text()).toBe(200)
      } finally {
        capture.stop()
      }

      expect(capture.seen).toEqual(['approval.approved'])

      const instanceRow = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [fixture.roundInstanceId],
      )
      expect(instanceRow.rows[0]?.status).toBe('approved')

      // No system-sentinel record exists on this path.
      const sentinel = await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_records
          WHERE instance_id = $1 AND actor_id = 'system:approval-cancel-round'`,
        [fixture.roundInstanceId],
      )
      expect(sentinel.rows[0].count).toBe('0')

      // DISCLOSED GAP, not an endorsement: 判据 II is not implemented, so the redeemed round's row
      // is still `pending` after its engine instance reached a terminal state. When 判据 II lands,
      // this expectation must flip to `'applied'` — it is written this way so the change is
      // FORCED to be noticed rather than silently satisfied.
      const round = await roundOutcome(fixture.roundInstanceId)
      expect(round.outcome).toBe('pending')
      expect(round.ended_at).toBeNull()
    },
  )
})
