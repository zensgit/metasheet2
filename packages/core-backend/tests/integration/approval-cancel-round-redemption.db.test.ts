import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor, ensureLocalUserRow } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { type ApprovalActionRequest } from '../../src/types/approval-product'
import { eventBus } from '../../src/integration/events/event-bus'
import {
  deriveCancelRoundW4OperationIdV1,
  getAttendanceCancellationExecutionPort,
  getCancelRoundCancelledEventDelivery,
  registerAttendanceCancellationExecutionProvider,
  registerCancelRoundCancelledEventDelivery,
  unregisterCancelRoundCancelledEventDelivery,
  unregisterAttendanceCancellationExecutionProvider,
  type AttendanceCancellationExecutionPort,
} from '../../src/core/attendance-cancellation-execution-port'
import type {
  AttendanceRequestOperationExternalTransactionInputV1,
  AttendanceRequestOperationExternalTransactionResultV1,
} from '../../src/attendance/w4c3b-request-operation-boundary'

/**
 * Approval change-request design lock v5.9 §14.2 — real-DB acceptance for 判据 III (WI-13,
 * phase 1) and, appended by phase 2, the 判据 IV `expired` half (C-3's system-side close at the
 * new outlet #5′).
 *
 * SCOPE CORRECTION (phase 2, this branch). Phase 1's header said 判据 II and 判据 IV "are NOT
 * covered here … separate follow-up files". The 判据 IV half is now covered HERE rather than in a
 * new file — deliberately: a new `.db.test.ts` would have to be wired into `plugin-tests.yml` and
 * would force an s6a provenance re-pin, neither of which buys coverage this file's already-wired
 * fixture cannot give. (⚠️ CORRECTED, phase-2 MD §0 R-6: this comment used to also name a
 * 「hard-coded `FILES` array」 in `scripts/ops/ci-realdb-step-contract.mjs`. There is none —
 * `:99-102` is a frozen map of two STEP IDS, and that script derives its file population from the
 * parsed workflow step itself, so it owes nothing for a new file.) The 判据 II cases and 判据 IV's
 * `blocked` half were appended by the same reasoning once the redemption hook landed.
 *
 * What is STILL not covered here, stated so no green below is read for more than it is:
 *   - The REAL W4 protocol. The 判据 II cases bind a test double through the production registry,
 *     so they prove the APPROVAL side's half of the contract — 「C-1 was called through the
 *     external-transaction entry with these inputs, and the round/instance/event writes followed
 *     from its answer」 — and nothing about prepare/prepareIdentity, the isolation assert, the
 *     rollout-lock `pg_locks` assert, posture resolution, replay preflight or the seal/outbox.
 *   - 账侧完整取消结果逐字节等价 (lock §8 期 1) — the twin-fixture compare, second-to-last case.
 *     `unrecoverableExpired` 呈现 (lock:86) is the LAST case: the counter is computed and
 *     PERSISTED by the W4 seal (non-zero, measured), AND a `dto.cancellationOutcome` channel now
 *     exists on the approve response and the approve audit row's `metadata` (⚠️ P3-hygiene,
 *     2026-09-19: the two cases below assert this POSITIVELY — the twin-fixture case pins the
 *     CLEAN token `cancelled` on its zero-lot fixture, the last case pins
 *     `cancelled_with_unrecoverable_expired` on its seeded-expired-lot fixture — this is no longer
 *     a negative-only channel-absence assertion). Which USER-FACING surface a human reads it from
 *     is still an owner default, not a gap in the DTO/audit-row plumbing itself.
 *   - R2 (锁内最终评估失败 ⇒ 零业务取消) — now COVERED here, by the last case in this file,
 *     against the REAL boundary. ⚠️ Read its doc comment before trusting it: R2's three
 *     literal clauses have NO discriminating power against the mutation the lock names for
 *     R2, and the assertion that does carry it is an implementer addition.
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
  // 判据 II fixtures attach a real `attendance_requests` row to the original document; cleaned up
  // alongside the approval rows so a shared DB is left as it was found.
  const createdRequestIds = new Set<string>()
  // The END-TO-END case (bottom of this file) needs a REAL directory identity: the W4 preflight's
  // `recheckAttendanceActorLivenessInTransactionV1` requires an active `users` row AND an active
  // `user_orgs` membership for the acting id. A dev token is not a directory row, so the double-
  // backed cases never needed these.
  const createdDirectoryUserIds = new Set<string>()
  // The `unrecoverableExpired` case (bottom of this file) seeds a leave-balance GRANT LOT plus its
  // `deduct` event. `attendance_leave_balance_events.balance_id` is `ON DELETE CASCADE`, so
  // deleting the lot takes its events with it.
  const createdLeaveBalanceIds = new Set<string>()

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
      if (createdRequestIds.size > 0) {
        await pool().query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [[...createdRequestIds]])
      }
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
      if (createdDirectoryUserIds.size > 0) {
        await pool().query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [[...createdDirectoryUserIds]])
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [[...createdDirectoryUserIds]])
      }
      if (createdLeaveBalanceIds.size > 0) {
        await pool().query('DELETE FROM attendance_leave_balances WHERE id = ANY($1::uuid[])', [[...createdLeaveBalanceIds]])
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
    templateId: string
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

    return { documentId, requesterId, requesterToken, approverId, approverToken, roundInstanceId: dto.id, templateId }
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
  // different — the §2-G2 anchor's age (30 days vs. 200). Everything else, INCLUDING the window
  // itself (90 days, the `leave` suite ceiling, in both halves), plus the seat, the approver and
  // the route, is held constant, so a difference in outcome can only be the window predicate.
  //
  // WHICH FIELD IS HELD CONSTANT WAS INVERTED by the rebase onto C-1 @`ba8a0133d`. Until then the
  // pair held the anchor at 200 days and widened the OPEN half's window to 365. C-1 (Codex review
  // 2026-09-19 finding 2) made lock:143's `windowDays ∈ [0, 上限]` an ENFORCED domain —— `leave`'s
  // ceiling is 90, so 365 is no longer a configuration this system accepts and creation now
  // refuses it with 409 `CANCEL_ROUND_WINDOW_OUT_OF_RANGE` (C-1's own 负控 A,
  // `approval-cancel-round-creation.db.test.ts:782`). The isolation argument is unchanged; only
  // which of the two fields carries it moved, and BOTH halves now sit at the production ceiling
  // rather than at a value no administrator could have set. Without the second
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
  /**
   * 判据 II needs the original document to be an ATTENDANCE document with a request behind it —
   * that is what `resolveCancelRoundRolloutLockRequirementV1` walks (instance → round →
   * original instance → `attendance_requests`) to answer `{ kind: 'required', orgId, requestId }`,
   * and without it `dispatchAction` takes no rollout lock and the redemption refuses with
   * `CANCEL_ROUND_BUSINESS_TARGET_MISSING`. Run BEFORE the cancel round is created so the round's
   * creation sees the same shape the decision will.
   *
   * `org_id` is left at the table default `'default'` (a canonical rollout org key); the business
   * key is the SAME `attendance-request:<uuid>` shape `parseAttendanceRequestIdFromBusinessKey`
   * parses, so the classifier binds by business key and not merely by the reverse join.
   */
  async function attachAttendanceRequest(
    documentId: string,
    userId: string,
  ): Promise<{ requestId: string; orgId: string }> {
    // ORDER MATTERS, and the DB says so: `attendance_requests_instance_workflow_fkey` is a
    // COMPOSITE foreign key `(approval_instance_id, approval_workflow_key)` →
    // `approval_instances (id, workflow_key)` (lock §14.3 #10's Q1c package). Inserting the request
    // first fails 23503, so the instance is re-keyed as an attendance document BEFORE the request
    // row exists, and the business key — which needs the generated request id — is written after.
    const rekeyed = await pool().query(
      `UPDATE approval_instances SET workflow_key = 'attendance.request' WHERE id = $1`,
      [documentId],
    )
    expect(rekeyed.rowCount).toBe(1)
    const inserted = await pool().query<{ id: string; org_id: string }>(
      `INSERT INTO attendance_requests
         (user_id, work_date, request_type, status, approval_instance_id, approval_workflow_key)
       VALUES ($1, CURRENT_DATE, 'leave', 'approved', $2, 'attendance.request')
       RETURNING id::text AS id, org_id`,
      [userId, documentId],
    )
    const requestId = inserted.rows[0].id
    createdRequestIds.add(requestId)
    const updated = await pool().query(
      `UPDATE approval_instances SET business_key = $2 WHERE id = $1`,
      [documentId, `attendance-request:${requestId}`],
    )
    expect(updated.rowCount).toBe(1)
    return { requestId, orgId: inserted.rows[0].org_id }
  }

  /**
   * The acting identity as a REAL directory row. `attendanceResultOperationPreflightV1` calls
   * `recheckAttendanceActorLivenessInTransactionV1`, which requires an active `users` row for the
   * actor AND an active `user_orgs` membership in the operation's org — a witness minted for an
   * identity that has since been deprovisioned must not be honoured. The dev token this harness
   * mints is not a directory row, so only the END-TO-END case (which runs the real preflight)
   * needs this; every double-backed case above short-circuits before it.
   */
  async function seedDirectoryIdentity(userId: string, orgId: string): Promise<void> {
    createdDirectoryUserIds.add(userId)
    await pool().query(
      `INSERT INTO users
         (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $2, $1, 'cancel-round e2e actor', 'x', 'user', '[]'::jsonb, TRUE, FALSE, 'activated')
       ON CONFLICT (id) DO NOTHING`,
      [userId, `wi13-e2e-${userId}@example.test`],
    )
    await pool().query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
       ON CONFLICT DO NOTHING`,
      [userId, orgId],
    )
  }

  /**
   * A test double for the C-1 PROVIDER, bound through the production registry
   * (`registerAttendanceCancellationExecutionProvider`) so the code under test resolves it exactly
   * as it resolves the attendance plugin's real boundary.
   *
   * ⚠️ What this does NOT prove, stated here rather than in a summary: the real W4 protocol. The
   * plugin's boundary would additionally run prepare/prepareIdentity, the isolation assert, the
   * rollout-lock `pg_locks` assert, posture resolution, authorization, replay preflight and the
   * seal/outbox. This double stands in for all of it and answers the approval side's contract
   * only: 「C-1 was called with these inputs, and it answered X」. The end-to-end run against the
   * real boundary (and therefore 账侧 byte-equivalence) is NOT covered by this suite — see the
   * phase-2 verification MD §4.
   */
  function bindCancellationPort(
    respond: (
      input: AttendanceRequestOperationExternalTransactionInputV1,
    ) => Promise<AttendanceRequestOperationExternalTransactionResultV1>,
  ): { calls: AttendanceRequestOperationExternalTransactionInputV1[]; stop: () => void } {
    const calls: AttendanceRequestOperationExternalTransactionInputV1[] = []
    const port: AttendanceCancellationExecutionPort = {
      execute: async () => {
        throw new Error('the HTTP entry must not be reached from the approval side')
      },
      executeInExternalTransaction: async (input) => {
        calls.push(input)
        return respond(input)
      },
    }
    // SAVE AND RESTORE, not bind-then-unbind. The registry is process-wide and this harness DOES
    // already have a provider bound when these cases run (the console warning
    // 'AttendanceCancellationExecutionPort provider is being replaced' is how that was found — it
    // was not assumed). Unbinding on teardown would therefore leave later cases running against a
    // registry this helper emptied, which is a state no production process is ever in.
    const previous = getAttendanceCancellationExecutionPort()
    registerAttendanceCancellationExecutionProvider(port)
    return {
      calls,
      stop: () => {
        if (previous) registerAttendanceCancellationExecutionProvider(previous)
        else unregisterAttendanceCancellationExecutionProvider()
      },
    }
  }

  /**
   * Codex 审阅第 3 条修复 (2026-09-19) — the REAL send site, observed.
   *
   * ⚠️ WHY THE BUS AND NOT THE OUTBOX. The finding this closes was invisible for exactly one
   * reason: the only assertion in this file that named 「C-1 step ⑦ (发 attendance.request.cancelled)」
   * counted rows in `attendance_result_event_outbox`, and under the `legacy` / `legacy_compat`
   * postures — which is what every org in this fixture runs — NEITHER path writes that table. The
   * HTTP path announces the cancellation on the in-process bus instead, so `0 === 0` compared two
   * numbers that are structurally zero while the real send counts were 0 and 1. These assertions
   * subscribe to the bus singleton the plugin's `emitEvent` actually publishes to
   * (`index.cjs` → `context.api.events.emit` → `plugin-manager.ts:586-593` → `index.ts:1242` →
   * `eventBus.emit`), which is the send site itself and not a proxy for it.
   */
  function captureCancelledEvents(): {
    payloads: { requestId?: string; status?: string; orgId?: string; userId?: string }[]
    forRequest: (requestId: string) => { requestId?: string }[]
    stop: () => void
  } {
    const payloads: { requestId?: string; status?: string; orgId?: string; userId?: string }[] = []
    const id = eventBus.subscribe('attendance.request.cancelled', (payload: unknown) => {
      payloads.push((payload ?? {}) as { requestId?: string })
    })
    return {
      payloads,
      forRequest: (requestId: string) => payloads.filter((e) => e.requestId === requestId),
      stop: () => eventBus.unsubscribe(id),
    }
  }

  /**
   * The POSITIVE CONTROL every zero-expecting assertion below needs, factored out so none of them
   * can quietly skip it. A count of 0 is what you get when the send is correctly withheld — and it
   * is ALSO what you get when the attendance plugin never bound a delivery in this process, in
   * which case the case proves nothing and its mutation stays green. Asserting the binding turns
   * 「it did not send」 into 「it could have sent and did not」.
   */
  function expectCancelledEventDeliveryBound(): void {
    expect(
      getCancelRoundCancelledEventDelivery(),
      'no attendance.request.cancelled delivery is bound — every zero-send assertion in this file '
        + 'would pass vacuously',
    ).toBeDefined()
  }

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
      expectCancelledEventDeliveryBound()
      const cancelledEvents = captureCancelledEvents()
      let approve: Response
      try {
        approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(approve.status, await approve.clone().text()).toBe(200)
      } finally {
        capture.stop()
        cancelledEvents.stop()
      }

      // 「零完成事件」. Its discriminating power is the sibling case below, which sees exactly one.
      expect(capture.seen).toEqual([])
      // Codex 审阅第 3 条修复 (2026-09-19) — and ZERO cancellation announcements. C-3's closure
      // `return`s before the post-commit region ever runs, and nothing was cancelled to announce.
      // Discriminating because the delivery IS bound (asserted above) and because the mutation
      // 「announce unconditionally」 makes this line red.
      expect(cancelledEvents.payloads).toEqual([])

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

  /**
   * §5 I3 「终结即释放」, as its OWN case rather than as the tail of the 判据 IV one.
   *
   * WHY A SEPARATE CASE, and it is not tidiness. The mutation the lock's I3 names is 「the C-3
   * closure does not write the round's terminal `outcome`」 — instance `rejected` while the round
   * stays `pending`, which is the exact shape lock:368's outlet-7′ row describes
   * (「实例 `rejected` 而轮次仍 `pending`、同单据再发起被唯一索引拒,红」). Under that mutation the
   * 判据 IV case above dies at its `expect(round.rows[0].outcome).toBe('expired')` line, which sits
   * BEFORE its I3 block — so the I3 clause there is never evaluated and carries no mutation. That
   * is the phase-2 MD's own §0 R-5 trap (an argument presented as a measurement), recurring two
   * units later. Here the `createCancelRoundInstance` call is the FIRST statement after the close,
   * so the mutation's red lands on the I3 clause itself. The block above is KEPT (an end-state
   * check that costs nothing); M-21 therefore reddens two cases, and the discriminating one is
   * this one.
   *
   * WHICH DOOR ACTUALLY REFUSES THE SECOND ROUND, measured rather than recalled. Lock:149 says I3
   * is 「由索引 + C-3 共同保证」, and the phase-2 MD's §4 predicted a 23505 from
   * `uq_approval_rounds_pending_document`. In the SEQUENTIAL shape this case drives, the index is
   * never reached: `createCancelRoundInstance`'s own pre-check
   * (`ApprovalProductService.ts:8558-8568`, `SELECT id FROM approval_rounds WHERE document_id = $1
   * AND outcome = 'pending'`) fires first and throws the named `CANCEL_ROUND_ALREADY_PENDING`
   * (409) — measured, the M-21 stack frame is `ApprovalProductService.ts:8563:15`. The 23505
   * backstop (`:8697-8705`, which maps the raw constraint violation onto the SAME named error)
   * belongs to the CONCURRENT-insert race only. So what this case proves is: C-3's outcome write
   * is what releases the slot, and the pre-check is what guards it. It proves nothing about the
   * partial unique index itself, which would need a constructed race.
   */
  it(
    '§5 I3 「终结即释放」 (the C-3 half): after the #5′ system close the document has NO pending ' +
      'round, so a new cancel round starts immediately — asserted as the FIRST post-close ' +
      'statement, which is what makes the I3 clause carry its own mutation (M-21)',
    async () => {
      const suffix = `i3rel-${TS}`
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        // Same closure cause as the 判据 IV case: 200 days > the `leave` suite's 90-day window.
        await ageApprovedAnchor(documentId, 200)
      })

      const approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(approve.status, await approve.clone().text()).toBe(200)

      // ── THE I3 CLAUSE, FIRST. Under M-21 this line throws `CANCEL_ROUND_ALREADY_PENDING` and
      // nothing below it is evaluated, which is the point of the ordering.
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

      // The released round is a DIFFERENT row that reached a terminal outcome — not the same row
      // re-opened, and not a second `pending` row that the pre-check happened to miss.
      const closed = await pool().query<{ id: string; outcome: string }>(
        `SELECT id, outcome FROM approval_rounds WHERE engine_instance_id = $1`,
        [fixture.roundInstanceId],
      )
      expect(closed.rows.length).toBe(1)
      expect(closed.rows[0].outcome).toBe('expired')
      expect(closed.rows[0].id).not.toBe(nextRound.rows[0].id)

      // 「同一单据至多一轮在途」 read off the document, which is the column the partial unique index
      // is declared on — exactly one pending round, and it is the new one.
      const pendingForDocument = await pool().query<{ id: string; engine_instance_id: string }>(
        `SELECT id, engine_instance_id FROM approval_rounds WHERE document_id = $1 AND outcome = 'pending'`,
        [fixture.documentId],
      )
      expect(pendingForDocument.rows.length).toBe(1)
      expect(pendingForDocument.rows[0].engine_instance_id).toBe(next.id)
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
    '判据 II (§14.2, outlet #5): an attendance-backed cancel round whose window is OPEN redeems — ' +
      'C-1 is invoked through the W4 external transaction entry with a UUIDv5 operation id ' +
      'derived from the round id (`deriveCancelRoundW4OperationIdV1`), the round row goes ' +
      '`applied` + `ended_at`, the instance goes `approved`, and ' +
      'EXACTLY ONE completion event is emitted (so 判据 IV/R2 zeros are measurements, not an ' +
      'inert channel)',
    async () => {
      const suffix = `iiok-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        // 90 (the `leave` ceiling, lock:143) > 30 — the window is OPEN, so the in-lock evaluation
        // answers `redeem`.
        await setDocumentWindowDays(documentId, 90)
        attached = await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      expect(attached).toBeTruthy()
      const roundIdRow = await pool().query<{ id: string }>(
        `SELECT id FROM approval_rounds WHERE engine_instance_id = $1`,
        [fixture.roundInstanceId],
      )
      const roundId = roundIdRow.rows[0].id

      const portStub = bindCancellationPort(async () => ({ kind: 'executed', response: { ok: true } }))
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
        portStub.stop()
      }

      // 「恰一个完成事件」 — the positive control that pairs with 判据 IV's zero.
      expect(capture.seen).toEqual(['approval.approved'])

      // C-1 was reached, exactly once, through the EXTERNAL-TRANSACTION entry (the double throws
      // if the HTTP `execute` entry is touched), and with the inputs the lock fixes.
      expect(portStub.calls.length).toBe(1)
      const call = portStub.calls[0]
      expect(call.kind).toBe('request_cancel')
      expect(call.routeVariant).toBeNull()
      // The replay key is DERIVED from the round's own id — deterministic, so a retry replays
      // rather than minting a second operation, and UUID-shaped, which the round id is not (it is
      // `text`, minted `apr_<uuid>`; passing it raw made the REAL boundary 500 on
      // `W4C3B_REQUEST_BOUNDARY_INPUT_INVALID` — see the end-to-end case at the bottom of this
      // file, which found it). Asserted against the production derivation AND against its two
      // properties, so a future change of namespace cannot pass by re-deriving both sides.
      expect(call.operationId).toBe(deriveCancelRoundW4OperationIdV1(roundId))
      expect(call.operationId).not.toBe(roundId)
      expect(call.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      const routeInput = call.routeInput as Record<string, unknown>
      // Pinned to the SAME row the rollout lock was taken for (both id and org are passed, so the
      // entry's own lookup cannot drift to another row).
      expect(routeInput.requestId).toBe(attached!.requestId)
      expect(routeInput.orgId).toBe(attached!.orgId)
      // The acting identity is the cancel round's requester, and the boundary's own
      // `tokenSubjectUserId === actorId` precondition is satisfied.
      expect(routeInput.actorId).toBe(fixture.requesterId)
      expect(routeInput.tokenSubjectUserId).toBe(fixture.requesterId)

      const instanceRow = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [fixture.roundInstanceId],
      )
      expect(instanceRow.rows[0]?.status).toBe('approved')

      // No system-sentinel record on the redeemed path — this is an ordinary approver decision.
      const sentinel = await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_records
          WHERE instance_id = $1 AND actor_id = 'system:approval-cancel-round'`,
        [fixture.roundInstanceId],
      )
      expect(sentinel.rows[0].count).toBe('0')

      // 轮次 `applied` (lock §3 C-2 step ⑤) + I3 「终结即释放」. This expectation is the one phase 1
      // deliberately left asserting `'pending'` so 判据 II could not land silently.
      const round = await roundOutcome(fixture.roundInstanceId)
      expect(round.outcome).toBe('applied')
      expect(round.ended_at).not.toBeNull()
    },
  )

  /**
   * Gate round-5 P3-1 (`impl-gate-C-slice1-round5-20260918.md` §3 P3-1 / R5-M7, §4 table) — the
   * ratified §9-9 allow-set `{approve, reject, revoke, comment}` has a MEMBER half and a COMPLEMENT
   * half, and only the complement half was pinned in C-1.
   *
   * The complement half lives at `approval-cancel-round-outlet-guards.db.test.ts:401` (§9-9
   * allow-set MEMBER pin), which enumerates `APPROVAL_ACTION_TYPES` mechanically and asserts every
   * NON-member is refused. The gate's round-5 sweep then measured the four members one cell at a
   * time — removing `reject` ⇒ 2 red, `revoke` ⇒ 4 red, `comment` ⇒ 1 red, and removing `approve`
   * ⇒ **48/48 GREEN**, because C-1's reachable surface never redeems. That is the zero-discriminating
   * cell this case closes, and the lock itself put it here: `approve` IS outlet #5 (lock §14.3), and
   * outlet #5 IS 判据 II, which the lock assigns to C-2.
   *
   * WHY THIS CASE EXISTS WHEN 判据 II ABOVE ALREADY GOES RED. Measured on this branch (phase-2 MD
   * §3.17): removing `'approve'` from `CANCEL_ROUND_ALLOWED_ACTIONS` now turns **11 of 17** cases in
   * this file red. So the cell is no longer empty. But every one of those 11 reds is a CONSEQUENCE
   * red — `expected 409 to be 200`, or a named code assertion reading `CANCEL_ROUND_OUTLET_FORBIDDEN`
   * where it wanted its own code. A consequence red cannot tell 「the action-judgment gate refused
   * it」 from 「the redemption broke somewhere downstream」, and it evaporates the day those
   * assertions are refactored. This case makes the MEMBERSHIP itself load-bearing by measuring both
   * sides of the same gate, on the SAME instance, in the same run:
   *
   *   1. a NON-member (`handle`, outlet #4) is refused 409 `CANCEL_ROUND_OUTLET_FORBIDDEN` and the
   *      row is unchanged — so the gate is demonstrably LIVE on this very instance, which is what
   *      stops step 2's success from reading as 「there is no gate here」
   *      (`feedback_positive_control_not_failclosed`);
   *   2. `approve` on that same instance is LET THROUGH and redeems, asserted POSITIVELY (200,
   *      round `applied` + `ended_at`, instance `approved`) rather than as 「not
   *      CANCEL_ROUND_OUTLET_FORBIDDEN」 — an absence-of-one-error assertion cannot tell success
   *      from failure-for-another-reason (`feedback_not_this_error_is_not_an_outcome_assertion`).
   *
   * The allow-set literal below is an independent local copy, NOT an import of the production
   * `CANCEL_ROUND_ALLOWED_ACTIONS` — importing it would make this test tautological against exactly
   * the narrowing regression it exists to catch (same reasoning as the complement-half pin).
   */
  it(
    '§9-9 允许集 MEMBER pin (approve) — gate round-5 P3-1: on ONE cancel-round instance the ' +
      'action-judgment gate refuses a non-member (`handle` ⇒ 409 CANCEL_ROUND_OUTLET_FORBIDDEN, ' +
      'row unchanged) and LETS `approve` THROUGH to redeem (200, round `applied`), so removing ' +
      '`approve` from the ratified allow-set is red on the MEMBERSHIP, not on a downstream ' +
      'consequence',
    async () => {
      const suffix = `m7pin-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        // 90 (the `leave` ceiling) > 30 — the window is OPEN, so the in-lock evaluation answers `redeem` and the
        // `approve` half below reaches the redemption rather than the #5′ system close.
        await setDocumentWindowDays(documentId, 90)
        attached = await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      expect(attached).toBeTruthy()

      // The RATIFIED literal (lock §9-9 ratify header, verbatim): {approve, reject, revoke, comment}.
      const RATIFIED_CANCEL_ROUND_ALLOWED_ACTIONS = new Set<string>(['approve', 'reject', 'revoke', 'comment'])
      // Vacuity guards on this case's own premises — if either of these ever stops holding, the two
      // halves below stop being 「member」 and 「non-member」 and the case would assert nothing about
      // membership at all.
      expect(RATIFIED_CANCEL_ROUND_ALLOWED_ACTIONS.has('approve')).toBe(true)
      expect(RATIFIED_CANCEL_ROUND_ALLOWED_ACTIONS.has('handle')).toBe(false)

      // ── HALF 1, the in-case positive control: the gate IS live on THIS instance.
      const before = await pool().query<{ version: number; status: string }>(
        `SELECT version, status FROM approval_instances WHERE id = $1`,
        [fixture.roundInstanceId],
      )
      expect(before.rows[0]?.status).toBe('pending')
      await expect(
        new ApprovalProductService().dispatchAction(
          fixture.roundInstanceId,
          { action: 'handle' } as ApprovalActionRequest,
          { userId: fixture.approverId, userName: 'member-pin control actor', roles: [] },
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CANCEL_ROUND_OUTLET_FORBIDDEN' })
      const afterControl = await pool().query<{ version: number; status: string }>(
        `SELECT version, status FROM approval_instances WHERE id = $1`,
        [fixture.roundInstanceId],
      )
      expect(afterControl.rows[0]).toEqual(before.rows[0])
      // The refused non-member left the round's seat exactly as it found it, so half 2 starts from
      // the same state half 1 did.
      expect((await roundOutcome(fixture.roundInstanceId)).outcome).toBe('pending')

      // ── HALF 2, the member itself: `approve` is LET THROUGH the same gate and redeems.
      const portStub = bindCancellationPort(async () => ({ kind: 'executed', response: { ok: true } }))
      let approve: Response
      try {
        approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        // ⚠️ This is the line that carries the mutation (phase-2 MD §3.19, M-29). Its failure
        // message prints the body, so a red NAMES the door that refused — under M-29 it reads
        // `CANCEL_ROUND_OUTLET_FORBIDDEN`, which is the membership claim, not a downstream one.
        expect(approve.status, await approve.clone().text()).toBe(200)
      } finally {
        portStub.stop()
      }

      // Positive outcome, load-bearing: the member was not merely 「not refused」, it redeemed.
      expect(portStub.calls.length).toBe(1)
      const instanceRow = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [fixture.roundInstanceId],
      )
      expect(instanceRow.rows[0]?.status).toBe('approved')
      const round = await roundOutcome(fixture.roundInstanceId)
      expect(round.outcome).toBe('applied')
      expect(round.ended_at).not.toBeNull()
    },
  )

  /**
   * §5 I3 「终结即释放」, the C-2 half — the SECOND of the two terminal `approval_rounds.outcome`
   * writers. Phase-2 MD §3.14.5 enumerated the population repo-wide and both-syntax and found four
   * write statements, of which two belong to this slice: the C-3 system close (`:8947`, outcome
   * `expired`/`blocked`) and this one, the C-2 success (`:9108`, outcome `applied`). §3.14 built
   * M-21 for the first; the second was commented as I3 in this file but had NO probe, and §3.14.5's
   * own table says so. This case builds it.
   *
   * SHAPE, and it is §3.14.1's lesson applied rather than quoted: the 判据 II case above already
   * ends with `round.outcome === 'applied'`, but that is an end-state check — run the I3 mutation
   * against it and it dies on that very assertion, never reaching any release clause. So the
   * release gets its own case in which `createCancelRoundInstance` is the FIRST statement after the
   * redemption returns, which is what makes the I3 clause itself carry the mutation.
   *
   * ⚠️ FIXTURE PREMISE, MEASURED RATHER THAN ASSUMED. In production a successful redemption runs
   * C-1, which writes the ORIGINAL document `approved → cancelled` — and `createCancelRoundInstance`
   * is premised on an `approved` document, so a second round would be refused for a reason that has
   * nothing to do with the slot. Here the cancellation port is a test double that writes nothing, so
   * the original stays `approved` and the ONLY thing standing between the redemption and a second
   * round is the round row's own outcome. That is exactly the isolation this probe needs, and the
   * case ASSERTS the premise (the original is still `approved`) instead of relying on it silently.
   * What that costs is stated in the MD: this case measures the SLOT release, not the end-to-end
   * product behaviour of cancelling twice, which is not a thing the lock asks for.
   */
  it(
    '§5 I3 「终结即释放」 (the C-2 half, outlet #5): after a SUCCESSFUL redemption the round is ' +
      '`applied` and the document\'s pending SLOT is released — measured as slot state, with the ' +
      'ORIGINAL document asserted still `approved` because the cancellation port is a double (in ' +
      'production C-1 would cancel it and no second round would be possible). The create is the ' +
      'FIRST post-redeem statement, which is what makes the clause carry its own mutation (M-30) ' +
      'instead of dying behind 判据 II\'s end-state check',
    async () => {
      const suffix = `i3c2-${TS}`
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        // 90 (the `leave` ceiling, lock:143) > 30 — the window is OPEN, so the in-lock evaluation
        // answers `redeem`.
        await setDocumentWindowDays(documentId, 90)
        await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })

      const portStub = bindCancellationPort(async () => ({ kind: 'executed', response: { ok: true } }))
      // Codex 审阅第 3 条修复 (2026-09-19) — free coverage of the `executed` half of the emit gate,
      // because this case already drives that kind. On `executed` the boundary DID enqueue
      // `attendance_result_event_outbox` and the W4C-2 dispatcher announces it on drain, so an
      // in-process announcement here would be a SECOND delivery of one cancellation. The mutation
      // 「announce unconditionally」 makes this line red.
      expectCancelledEventDeliveryBound()
      const cancelledEvents = captureCancelledEvents()
      try {
        const approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(approve.status, await approve.clone().text()).toBe(200)
      } finally {
        portStub.stop()
        cancelledEvents.stop()
      }
      expect(portStub.calls.length).toBe(1)
      expect(cancelledEvents.payloads).toEqual([])

      // ── THE I3 CLAUSE, FIRST. Under M-30 the round row stays `pending`, this line throws
      // `CANCEL_ROUND_ALREADY_PENDING` (409) from `createCancelRoundInstance`'s own pre-check, and
      // nothing below is evaluated — which is the whole point of the ordering.
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

      // The released round is a DIFFERENT row that reached a TERMINAL outcome — and the terminal
      // outcome on THIS path is `applied`, which is what distinguishes this probe from M-21's
      // (`expired`/`blocked` on the C-3 writer at `:8947`).
      const closed = await pool().query<{ id: string; outcome: string; ended_at: Date | null }>(
        `SELECT id, outcome, ended_at FROM approval_rounds WHERE engine_instance_id = $1`,
        [fixture.roundInstanceId],
      )
      expect(closed.rows.length).toBe(1)
      expect(closed.rows[0].outcome).toBe('applied')
      expect(closed.rows[0].ended_at).not.toBeNull()
      expect(closed.rows[0].id).not.toBe(nextRound.rows[0].id)

      // 「同一单据至多一轮在途」 read off `document_id`, the column the partial unique index is
      // declared on — exactly one pending round, and it is the new one.
      const pendingForDocument = await pool().query<{ id: string; engine_instance_id: string }>(
        `SELECT id, engine_instance_id FROM approval_rounds WHERE document_id = $1 AND outcome = 'pending'`,
        [fixture.documentId],
      )
      expect(pendingForDocument.rows.length).toBe(1)
      expect(pendingForDocument.rows[0].engine_instance_id).toBe(next.id)

      // THE FIXTURE PREMISE, MEASURED (see the doc comment): the double wrote nothing, so the
      // ORIGINAL document is still `approved` and could not have refused the second round for a
      // status reason. Without this line the case would silently depend on it.
      const originalRow = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [fixture.documentId],
      )
      expect(originalRow.rows[0]?.status).toBe('approved')
    },
  )

  it(
    '判据 IV `blocked` half + C-3 row 4 (业务不可逆): C-1 RETURNS a business refusal instead of ' +
      'throwing it, so the same transaction still persists the close — engine `rejected` by the ' +
      'system sentinel with reason `business_blocked:<code>`, round `blocked` + `block_reason`, ' +
      'ZERO completion events',
    async () => {
      const suffix = `iiblk-${TS}`
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })

      const portStub = bindCancellationPort(async () => ({
        kind: 'business_refused',
        code: 'ATTENDANCE_CANCELLATION_REVIEW_REQUIRED',
        detail: 'frozen parent calculation missing',
      }))
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
        portStub.stop()
      }

      // 零完成事件 — measured on the channel the sibling case above proves live.
      expect(capture.seen).toEqual([])

      const instanceRow = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [fixture.roundInstanceId],
      )
      expect(instanceRow.rows[0]?.status).toBe('rejected')

      // 系统终结身份 + the bounded reason token, with the fine cause BESIDE it, never concatenated
      // into it.
      const sentinel = await pool().query<{ metadata: Record<string, unknown> | null }>(
        `SELECT metadata FROM approval_records
          WHERE instance_id = $1 AND actor_id = 'system:approval-cancel-round'`,
        [fixture.roundInstanceId],
      )
      expect(sentinel.rows.length).toBe(1)
      expect(sentinel.rows[0].metadata?.cancelRoundCloseReason)
        .toBe('business_blocked:ATTENDANCE_CANCELLATION_REVIEW_REQUIRED')
      expect(sentinel.rows[0].metadata?.cancelRoundOutcome).toBe('blocked')
      expect(sentinel.rows[0].metadata?.cancelRoundBlockDetail).toBe('frozen parent calculation missing')

      const round = await pool().query<{ outcome: string; ended_at: Date | null; block_reason: string | null }>(
        `SELECT outcome, ended_at, block_reason FROM approval_rounds WHERE engine_instance_id = $1`,
        [fixture.roundInstanceId],
      )
      expect(round.rows[0].outcome).toBe('blocked')
      expect(round.rows[0].ended_at).not.toBeNull()
      expect(round.rows[0].block_reason).toBe('business_blocked:ATTENDANCE_CANCELLATION_REVIEW_REQUIRED')
    },
  )

  it(
    '判据 II fail-closed (C-3 row 5): with NO cancellation provider bound, the redemption must ' +
      'NOT mark the round `applied` — it throws CANCEL_ROUND_EXECUTION_PORT_UNAVAILABLE (409), ' +
      'the transaction rolls back, and the round keeps its seat',
    async () => {
      const suffix = `iinoport-${TS}`
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })

      // Deliberately NOT bound. The provider is cleared for the duration of this case only, and
      // restored in `finally` — this harness has one bound by default (see `bindCancellationPort`),
      // and leaving it cleared would silently change what every later case runs against.
      const previousPort = getAttendanceCancellationExecutionPort()
      unregisterAttendanceCancellationExecutionProvider()
      expect(getAttendanceCancellationExecutionPort()).toBeUndefined()
      const capture = captureCompletionEvents(fixture.roundInstanceId)
      let approve: Response
      try {
        approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
      } finally {
        capture.stop()
        if (previousPort) registerAttendanceCancellationExecutionProvider(previousPort)
      }
      expect(approve.status).toBe(409)
      const body = (await approve.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('CANCEL_ROUND_EXECUTION_PORT_UNAVAILABLE')
      expect(capture.seen).toEqual([])

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
    '判据 II scope fail-closed (lock §8 期 1 = 请假撤销): a cancel round whose ORIGINAL document ' +
      'has no attendance request behind it has no C-1 to run — it is refused with ' +
      'CANCEL_ROUND_BUSINESS_TARGET_MISSING (409), never redeemed as `applied`',
    async () => {
      const suffix = `iinoatt-${TS}`
      // The SAME fixture shape as the redeeming case above, minus `attachAttendanceRequest` — the
      // isolated variant that makes the attendance backing the only difference.
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
      })

      const portStub = bindCancellationPort(async () => {
        throw new Error('C-1 must not be reached for a non-attendance original')
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
        portStub.stop()
      }
      expect(approve.status).toBe(409)
      const body = (await approve.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('CANCEL_ROUND_BUSINESS_TARGET_MISSING')
      expect(portStub.calls.length).toBe(0)
      expect(capture.seen).toEqual([])

      const round = await roundOutcome(fixture.roundInstanceId)
      expect(round.outcome).toBe('pending')
      expect(round.ended_at).toBeNull()
    },
  )

  /**
   * 判据 II END-TO-END, against the plugin's REAL W4 request-operation boundary — the one case in
   * this file that binds NO double.
   *
   * Why this is possible here at all, and how it was established rather than assumed: the server
   * is constructed with `pluginDirs: []`, which does NOT mean 「no plugins」. `PluginLoader`'s
   * constructor only adopts `options.pluginDirs` when `length` is truthy, so an EMPTY array leaves
   * `basePath = './plugins'`, which makes `allowFallback` true, which makes `discover()` scan
   * `cwd/plugins`, `cwd/../plugins` and `cwd/../../plugins` — and vitest runs with
   * `cwd = packages/core-backend`, so the third root IS the repo's `plugins/`. plugin-attendance
   * therefore activates in this process and `registerCancelRoundExecutionBoundary` binds the real
   * boundary (`src/index.ts:2758-2759`). That binding is also the source of the
   * 'AttendanceCancellationExecutionPort provider is being replaced' warning the sibling cases'
   * save/restore helper exists for.
   *
   * What this case adds over the four double-backed cases above — each of these is a MEASUREMENT
   * that a double cannot make, and together they are why §3.11.3's org-key CONSTRUCTION argument
   * stops being an argument:
   *   - `assertExternalTransactionIsolationV1` passed: the caller's transaction really is an open,
   *     non-aborted block at SERIALIZABLE (`dispatchAction`'s `BEGIN ISOLATION LEVEL SERIALIZABLE`
   *     branch), and the probe savepoint it takes and releases did not disturb it.
   *   - `assertExternalTransactionRolloutLockHeldV1` passed: the class-`00` rollout advisory key
   *     built from the org `prepareIdentity` read off the `attendance_requests` row is HELD by
   *     this backend — i.e. it is the same key `dispatchAction` locked before its row locks.
   *   - The connection handed over is the one that issued `BEGIN` and took the locks (it is
   *     `pool.connect()`'s client, `ApprovalProductService.ts` dispatchAction), not the pool: a
   *     pool would have put the savepoint and the `pg_backend_pid()` predicate on arbitrary
   *     backends and both asserts would have failed.
   *   - The two inputs the double could not refuse (phase-2 MD §4): the replay preflight accepts an
   *     `operationId` it has never registered (the round id), and `requestBody: {}` — whose
   *     `expectedSnapshotVersion`/`expectedSnapshotHash` defaults `loadLatestRequestSnapshotToken`
   *     sees — is tolerated.
   *
   * POSITIVE CONTROL that this really ran against the real boundary rather than a leftover double:
   * the assertions below are on rows only the real adapter writes — the ORIGINAL document going
   * `approved → cancelled` with its `revoke` audit row carrying `w4ActorPosture`, and
   * `attendance_requests.status = 'cancelled'` with `resolved_by`/`resolved_at`. Every double in
   * this file returns `{ kind: 'executed' }` and writes nothing at all, so none of them can make
   * these green.
   *
   * What this case does NOT prove, so no green here is read for more than it is:
   *   - 账侧完整取消结果逐字节等价 (lock §8 期 1). This is DB END-STATE parity with what the W4
   *     path writes; byte equivalence needs the HTTP `POST /api/attendance/requests/:id/cancel`
   *     path run on a twin fixture and a field-by-field compare of both results. Still open.
   *   - `unrecoverableExpired` presentation: THIS fixture seeds no leave-balance lots, so
   *     `reverseLeaveBalanceDeduction` finds no `deduct` events and writes nothing. Covered by the
   *     LAST case in this file, which seeds an expired lot and pins the sealed counter at 120.
   *   - The P14 approved-leave cancellation CALCULATION. The org resolves to a legacy write
   *     posture here, and the adapter's P14 branch is `approvedLeave && acceptedWritePosture !==
   *     'legacy_projection_only'` — so the calculation append is SKIPPED on this fixture. That is
   *     asserted below (zero `approval_reversal` calculations) rather than left ambiguous.
   */
  it(
    '判据 II END-TO-END (no double): the redemption runs the REAL W4 external-transaction entry — ' +
      'its isolation and rollout-lock preconditions pass by MEASUREMENT, and the original ' +
      'document + attendance request are really cancelled inside the approver\'s transaction',
    async () => {
      const suffix = `iie2e-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        attached = await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      expect(attached).toBeTruthy()
      await seedDirectoryIdentity(fixture.requesterId, attached!.orgId)

      // The provider under test is the plugin's, bound at activate. Asserted before the action so
      // a future harness change that stops loading the plugin fails HERE, naming the reason,
      // instead of failing on a redemption assertion that would read as a regression in the code
      // under test.
      expect(getAttendanceCancellationExecutionPort()).toBeDefined()

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

      // 恰一个完成事件 (判据 II), on the channel 判据 IV's zeros are measured on.
      expect(capture.seen).toEqual(['approval.approved'])

      // 轮次 applied + the cancel round's own instance approved — same as the double-backed case,
      // but now downstream of a real C-1.
      const round = await roundOutcome(fixture.roundInstanceId)
      expect(round.outcome).toBe('applied')
      expect(round.ended_at).not.toBeNull()
      const roundInstance = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [fixture.roundInstanceId],
      )
      expect(roundInstance.rows[0]?.status).toBe('approved')

      // ── The positive control, and the 账侧 END-STATE. Only the real adapter writes these. ──
      const original = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [fixture.documentId],
      )
      expect(original.rows[0]?.status).toBe('cancelled')

      const revoke = await pool().query<{
        actor_id: string
        from_status: string
        to_status: string
        metadata: Record<string, unknown>
      }>(
        `SELECT actor_id, from_status, to_status, metadata FROM approval_records
          WHERE instance_id = $1 AND action = 'revoke'`,
        [fixture.documentId],
      )
      expect(revoke.rows.length).toBe(1)
      expect(revoke.rows[0].from_status).toBe('approved')
      expect(revoke.rows[0].to_status).toBe('cancelled')
      // The acting identity the hook chose (flagged for owner registration, phase-2 MD §3.11.4):
      // the cancel round's requester, NOT the approver who pressed approve.
      expect(revoke.rows[0].actor_id).toBe(fixture.requesterId)
      expect(revoke.rows[0].actor_id).not.toBe(fixture.approverId)
      // Written only by the real adapter, from the posture IT resolved inside the transaction —
      // lock §3 C-1 「运行模式与授权凭据由边界在锁内解析，不得由普通请求参数指定」.
      expect(revoke.rows[0].metadata.w4ActorPosture).toBe('self')

      const request = await pool().query<{ status: string; resolved_by: string | null; resolved_at: Date | null }>(
        `SELECT status, resolved_by, resolved_at FROM attendance_requests WHERE id = $1::uuid`,
        [attached!.requestId],
      )
      expect(request.rows.length).toBe(1)
      expect(request.rows[0].status).toBe('cancelled')
      expect(request.rows[0].resolved_by).toBe(fixture.requesterId)
      expect(request.rows[0].resolved_at).not.toBeNull()

      // The original document's seats are deactivated by the adapter as well — stated as an end
      // state, not as evidence that its own call is load-bearing.
      const originalSeats = await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`,
        [fixture.documentId],
      )
      expect(originalSeats.rows[0].count).toBe('0')

      // The P14 branch is NOT taken on this fixture (see the doc comment): zero
      // `approval_reversal` calculations for this operation id. Asserted so a later posture change
      // that starts exercising P14 here cannot pass unnoticed.
      const roundIdRow = await pool().query<{ id: string }>(
        `SELECT id FROM approval_rounds WHERE engine_instance_id = $1`,
        [fixture.roundInstanceId],
      )
      const calculations = await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM attendance_record_calculations
          WHERE entrypoint = 'approval_reversal' AND operation_id = $1::uuid`,
        [deriveCancelRoundW4OperationIdV1(roundIdRow.rows[0].id)],
      )
      expect(calculations.rows[0].count).toBe('0')
    },
  )

  /**
   * ── R2 (lock §8 期 1 的第二条承重反例) ────────────────────────────────────────────────────────
   *
   * 「最终业务评估失败 ⇒ 零业务取消、零 `approved` 完成事件,但 C-3 关闭结果已持久化
   * (mutation:把评估挪到入队之后 ⇒ R2 必红)」(lock:169).
   *
   * WHAT 入队 MEANS HERE, stated rather than left to inference. The lock's own C-2 step list
   * (lock:105-107) is: ① 锁轮次行 → ② 锁原单据实例 → ③ 锁内最终评估 → 分支决定 → 通过:④ 经 C-1
   * 的 W4 外部事务入口 → ⑤ 写轮次 `applied` → ⑥ **才写 `approved` 审计与入队完成事件** → `COMMIT`.
   * 入队 is step ⑥. On the shipped code the statement after `evaluateCancelRoundFinalInLock` is the
   * C-1 call, not an enqueue, so 「把评估挪到入队之后」 maps to: move the whole
   * `resolution.status === 'approved' && isCancelRoundInstance(instance)` hook block from its
   * anchor (immediately before the `UPDATE approval_instances SET status = $2` terminal write) to
   * immediately after `enqueueApprovalEventIfDurable(approvalTxnHandle(client), completionEvent)`
   * — i.e. past the terminal status write, past the `approve` audit row, past the enqueue. That is
   * the mutation this case is measured against (phase-2 MD §3.13.3, M-20).
   *
   * ⚠️ WHICH ASSERTION CARRIES THE MUTATION — and it is NOT one of R2's three literal clauses.
   * Under that mutant all three stay GREEN, for reasons that are §11-③'s trap recurring at this
   * branch:
   *   - 「零完成事件」 measured on the in-process channel stays green because the C-3 branch's own
   *     `return` sits before the post-commit `emitApprovalCompletionEvent`, so the built event is
   *     never emitted no matter where the hook sits;
   *   - 「零业务取消」 stays green because the evaluation still answers `expired` and still skips
   *     C-1, just later;
   *   - 「C-3 收口已持久化」 stays green because the closure still runs and still overwrites the
   *     status back to `rejected`.
   * The discriminating assertion is the PERSISTED `approved` half of step ⑥: the `approve` audit
   * row on the cancel round's own instance, which the mutant writes and the shipped order does
   * not. It is an IMPLEMENTER ADDITION to R2's clause set, recorded as such so no reader takes
   * 「R2 built, its mutation red」 to mean the lock's three literal clauses were gated.
   *
   * WHY THE REAL PORT AND AN ATTENDANCE-BACKED FIXTURE. Over a double 「零业务取消」 could only be
   * `calls.length === 0` — a statement about a stub. Here the plugin's REAL boundary is bound
   * (asserted), the original document really is an attendance document with an `approved`
   * request behind it (asserted as rows BEFORE the action, so the zero is not the trivially-true
   * zero of a fixture with no target), and the positive control that the same fixture shape DOES
   * get cancelled when the evaluation passes is the END-TO-END case above.
   *
   * Two further notes, so a later reader does not "fix" them:
   *   - `seedDirectoryIdentity` is deliberately NOT called. C-1 never runs on this path, so the
   *     directory rows are not needed; and if the evaluation ever accidentally answered `redeem`,
   *     the real adapter's actor-liveness recheck would fail the transaction, the round would stay
   *     `pending`, and 「C-3 收口已持久化」 would go RED. The omission makes an accidental redeem
   *     fail loudly instead of silently.
   *   - With an attendance request attached, `resolveCancelRoundRolloutLockRequirementV1` answers
   *     `{ kind: 'required' }`, so this dispatch runs under `BEGIN ISOLATION LEVEL SERIALIZABLE`
   *     holding the rollout advisory lock (§3.9). This is therefore the FIRST case to drive the
   *     C-3 `expired` close under that posture — the `ivexp` case above runs the `not_required`
   *     one. (A construction argument from the pre-read's predicate + the fixture rows asserted
   *     below, not a `pg_locks` measurement; census Q-F is where that is measured.)
   */
  it(
    'R2 (lock §8 期 1 反例二): the in-lock final evaluation fails with the REAL W4 boundary bound ' +
      'and a live attendance target ⇒ ZERO business cancellation, ZERO `approved` audit row and ' +
      'ZERO completion events, while the C-3 close is durably persisted',
    async () => {
      const suffix = `r2-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        // 200 days > the `leave` suite's default 90-day window and NO `windowDays` override ⇒ the
        // in-lock final evaluation answers `expired`. Same knob the `ivexp` case uses; the
        // difference here is that a real cancellable target exists behind the document.
        await ageApprovedAnchor(documentId, 200)
        attached = await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      expect(attached).toBeTruthy()

      // ── PRECONDITIONS AS ROWS. 「零业务取消」 is fail-open-shaped: it is also green when there
      // was nothing to cancel. These assertions make the target demonstrably reachable, so the
      // zeros below are a statement about a refusal and not about an empty fixture.
      expect(getAttendanceCancellationExecutionPort()).toBeDefined()
      const before = await pool().query<{
        status: string
        workflow_key: string | null
        business_key: string | null
      }>(
        `SELECT status, workflow_key, business_key FROM approval_instances WHERE id = $1`,
        [fixture.documentId],
      )
      expect(before.rows[0]?.status).toBe('approved')
      expect(before.rows[0]?.workflow_key).toBe('attendance.request')
      expect(before.rows[0]?.business_key).toBe(`attendance-request:${attached!.requestId}`)
      const requestBefore = await pool().query<{ status: string }>(
        `SELECT status FROM attendance_requests WHERE id = $1::uuid`,
        [attached!.requestId],
      )
      expect(requestBefore.rows.length).toBe(1)
      expect(requestBefore.rows[0].status).toBe('approved')

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

      // ── R2 clause 2: 零 `approved` 完成事件 (in-process channel — the live one in this lane).
      expect(capture.seen).toEqual([])


      // ── R2 clause 1: 零业务取消. Every row the real adapter would have written, absent.
      const original = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [fixture.documentId],
      )
      expect(original.rows[0]?.status).toBe('approved')
      const revokes = await pool().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_records
          WHERE instance_id = $1 AND action = 'revoke'`,
        [fixture.documentId],
      )
      expect(revokes.rows[0].count).toBe('0')
      const requestAfter = await pool().query<{
        status: string
        resolved_by: string | null
        resolved_at: Date | null
      }>(
        `SELECT status, resolved_by, resolved_at FROM attendance_requests WHERE id = $1::uuid`,
        [attached!.requestId],
      )
      expect(requestAfter.rows[0].status).toBe('approved')
      expect(requestAfter.rows[0].resolved_by).toBeNull()
      expect(requestAfter.rows[0].resolved_at).toBeNull()

      // ── R2 clause 3: C-3 收口已持久化 (and committed — every read here is on a fresh pool
      // connection, after the HTTP response returned).
      const round = await pool().query<{ outcome: string; ended_at: Date | null; block_reason: string | null }>(
        `SELECT outcome, ended_at, block_reason FROM approval_rounds WHERE engine_instance_id = $1`,
        [fixture.roundInstanceId],
      )
      expect(round.rows[0]?.outcome).toBe('expired')
      expect(round.rows[0]?.ended_at).not.toBeNull()
      expect(round.rows[0]?.block_reason).toBeNull()
      const roundInstance = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [fixture.roundInstanceId],
      )
      expect(roundInstance.rows[0]?.status).toBe('rejected')
      const closeRecord = await pool().query<{ actor_id: string; metadata: Record<string, unknown> }>(
        `SELECT actor_id, metadata FROM approval_records
          WHERE instance_id = $1 AND to_status = 'rejected'`,
        [fixture.roundInstanceId],
      )
      expect(closeRecord.rows.length).toBe(1)
      expect(closeRecord.rows[0].actor_id).toBe('system:approval-cancel-round')
      expect(closeRecord.rows[0].metadata.cancelRoundCloseReason).toBe('round_expired')
      const dto = (await approve.json()) as { status?: string }
      expect(dto.status).toBe('rejected')

      // ── LAST ON PURPOSE. This is R2's MUTATION-CARRYING assertion and it is an IMPLEMENTER
      // ADDITION, not one of the lock's three R2 clauses (see the doc comment). It is ordered
      // after all three so that ONE run of mutation M-20 evaluates the literal clauses first —
      // otherwise a red here short-circuits them and 「they stayed green」 would be an argument
      // wearing a measurement's label. The persisted `approved` half of step ⑥ never happened
      // on the round's own instance.
      const roundRecords = await pool().query<{ approve_rows: string; approved_rows: string }>(
        `SELECT
           count(*) FILTER (WHERE action = 'approve')::text AS approve_rows,
           count(*) FILTER (WHERE to_status = 'approved')::text AS approved_rows
         FROM approval_records WHERE instance_id = $1`,
        [fixture.roundInstanceId],
      )
      expect(roundRecords.rows[0].approve_rows).toBe('0')
      expect(roundRecords.rows[0].approved_rows).toBe('0')
    },
  )

  /**
   * ── 账侧验收 (lock §8 期 1 的第二条验收线) ───────────────────────────────────────────────────
   *
   * 「账侧(完整取消结果**逐字节等价于现有 W4 路径** + `unrecoverableExpired` 呈现)」(lock:169),
   * and lock §3 C-1 的执行内容 = 「**现有 `requestCancelAdapter.execute` 的全部步骤**(§10-⑦),
   * 不是其中一个 helper」(lock:81-86).
   *
   * WHAT 「现有 W4 路径」 IS, AS A RUNNING THING. The ordinary way an approved leave gets cancelled
   * today is `POST /api/attendance/requests/:id/cancel` — route registered at
   * `plugins/plugin-attendance/index.cjs:38634`, which runs the W4 operation protocol over a
   * boundary-owned connection. The redemption path runs the SAME protocol over the APPROVER's
   * transaction (`executeInExternalTransaction`). This case runs both, on TWIN fixtures, and
   * compares the rows they leave behind.
   *
   * WHY TWO FIXTURES AND NOT ONE. A single request can only be cancelled once, so parity cannot be
   * a before/after on one row; it has to be two structurally identical fixtures differing ONLY in
   * which channel cancels them. The twin is built from the SAME helpers in the SAME order
   * (`publishOneNodeTemplate` → `createApprovedOriginal` → `attachAttendanceRequest` →
   * `seedDirectoryIdentity`), and the ONE deliberate difference is disclosed: fixture B has **no
   * cancel round**, because 「现有 W4 路径」 means the path as a user walks it today, and that user
   * has no round. A round on B would make B a non-representative twin, not a better one.
   *
   * HOW 「逐字节」 IS MADE MEASURABLE. Byte equality cannot hold literally — the two fixtures have
   * different primary keys, different users and different clocks. So the comparison NORMALISES
   * rather than excludes wherever it honestly can: every A-side identifier is substituted with its
   * B-side counterpart (`IDENTITY_SUBSTITUTIONS` below) before the compare, so an identifier that
   * survives normalisation and still differs is a REAL divergence. Only what cannot be normalised
   * is excluded, and each exclusion is DATA (`DECLARED_DIVERGENCES`) with a machine-checkable
   * `column` and a written `reason` — not a sentence in a comment that rots.
   *
   * ⚠️ THIS CASE'S GREEN IS CONDITIONAL ON AN OPEN OWNER DECISION. §3.11.4 flagged the C-1 audit
   * row's acting identity as an implementer choice: the redemption hook acts as the cancel round's
   * REQUESTER, not the approver. Parity with the W4 path is precisely the argument that choice was
   * made on (lock §8 期 1 「逐字节等价于现有 W4 路径」), so this case is that argument's
   * MEASUREMENT — and if the owner rules that the audit row must carry the approver (or a system
   * sentinel), `approval_records.actor_id` stops normalising onto B's and this case goes RED BY
   * DESIGN. It is not swallowing the dispute; it is the dispute's oracle. Stated here so nobody
   * later "fixes" the red by adding `actor_id` to the exclusion table.
   *
   * ⚠️ WHAT THIS DOES **NOT** ESTABLISH: `unrecoverableExpired` 呈现 IS NOT CLOSED BY THIS CASE,
   * for two reasons this case measures rather than argues — and the SECOND of them has since been
   * narrowed by the LAST case in this file (phase-2 MD §3.16, §0 R-8):
   *   (a) **no leave-balance lots are seeded**, so `reverseLeaveBalanceDeduction` has nothing to
   *       reverse and BOTH paths produce `reversal.reversed = 0`. Parity of a zero is parity; it
   *       is not the `unrecoverableExpired > 0` presentation lock:86 demands. CLOSED by the last
   *       case, which seeds an EXPIRED lot and gets 120.
   *   (b) **the approval side's RETURN VALUE DOES carry a channel for it.** `redeemCancelRoundInTxn`
   *       receives `{ kind: 'executed', response }` from the entry, derives
   *       `outcome = classifyCancelRoundCancellationOutcomeV1(result.response)` from that SAME
   *       payload, and returns `{ kind: 'applied', outcome }` — nothing is discarded on this path.
   *       ⛔ CORRECTED (P3 hygiene pass, 2026-09-19): this bullet previously claimed "no channel
   *       for it" / payload "DISCARDED"; checked against the production return type
   *       (`ApprovalProductService.ts:9015-9017`, `:9141`) and found FALSE, not merely overstated.
   *       The W4 seal separately persists the same payload into
   *       `attendance_result_operations.response_snapshot`, so a persisted channel exists too. What
   *       remains open is only which USER-FACING surface renders `outcome`, and whether it must
   *       survive a cross-reload read — not whether a return-value channel exists. (The DTO
   *       assertion at the bottom of THIS case, `outcomeA` below, is already POSITIVE — there is no
   *       "DTO negative" standing here.)
   * The narrower open item is registered in the phase-2 verification MD. This case closes the
   * ROW-LEVEL half of the 账侧 line (the end state the two paths leave in the database).
   */
  it(
    '账侧 (lock §8 期 1): the redeemed cancel round leaves the SAME rows as the existing ' +
      '`POST /api/attendance/requests/:id/cancel` path on a twin fixture — every column equal ' +
      'after identity normalisation except the ones declared as data, with a reason each',
    async () => {
      // ── Columns that cannot be normalised onto the twin's, each with its reason. This table IS
      //    the contract: the compare below asserts the ACTUAL divergence set is a subset of it,
      //    so a new unexplained divergence goes red, and `reason` is carried as a field rather
      //    than a comment so it can be read back in the failure message.
      const DECLARED_DIVERGENCES: readonly { readonly table: string; readonly column: string; readonly reason: string }[] = [
        { table: 'attendance_requests', column: 'created_at', reason: 'wall clock — the two fixtures are seeded in sequence, not simultaneously' },
        { table: 'attendance_requests', column: 'updated_at', reason: 'wall clock — set by each path\'s own `now()` inside its own transaction' },
        { table: 'attendance_requests', column: 'resolved_at', reason: 'wall clock — the cancellation instant, necessarily different per fixture' },
        { table: 'approval_instances', column: 'created_at', reason: 'wall clock — fixture seeding order' },
        { table: 'approval_instances', column: 'updated_at', reason: 'wall clock — each path\'s own cancellation instant' },
        { table: 'approval_instances', column: 'submitted_at', reason: 'wall clock — fixture seeding order' },
        { table: 'approval_instances', column: 'completed_at', reason: 'wall clock — set when the ORIGINAL document was approved, per fixture' },
        { table: 'approval_records', column: 'created_at', reason: 'wall clock — the revoke audit row is written at each path\'s own cancellation instant' },
        { table: 'approval_instances', column: 'request_no', reason: 'per-document sequence number minted at create from a global counter — no fixture-side source to normalise onto, and no bearing on the 账侧 outcome' },
        { table: 'approval_records', column: 'id', reason: 'bigint identity of the audit row itself — a global sequence, no fixture-side source' },
        { table: 'approval_records', column: 'occurred_at', reason: 'wall clock — the cancellation instant' },
        // ⚠️ THE TWO SUBSTANTIVE ONES. These are NOT clock or key artefacts: the two paths record
        // genuinely different request provenance, and the values are asserted exactly below rather
        // than waved through by this table. Registered for owner sign-off in the phase-2 MD.
        { table: 'approval_records', column: 'ip_address', reason: 'SUBSTANTIVE — measured A=null, B=127.0.0.1: the redemption carries no HTTP request of its own to attribute, and fabricating one would be an invented audit value' },
        { table: 'approval_records', column: 'user_agent', reason: 'SUBSTANTIVE — measured A=null, B=node: same cause as ip_address' },
      ]
      const declaredFor = (table: string): ReadonlySet<string> =>
        new Set(DECLARED_DIVERGENCES.filter((d) => d.table === table).map((d) => d.column))

      // ── Fixture A: cancelled THROUGH the cancel round (outlet #5 → C-2 → C-1). ──────────────
      const suffixA = `parity-a-${TS}`
      let attachedA: { requestId: string; orgId: string } | undefined
      const a = await seedPendingCancelRound(suffixA, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        attachedA = await attachAttendanceRequest(documentId, `wi13-req-${suffixA}`)
      })
      expect(attachedA).toBeTruthy()
      await seedDirectoryIdentity(a.requesterId, attachedA!.orgId)
      expect(getAttendanceCancellationExecutionPort()).toBeDefined()

      // ── Fixture B: the TWIN, cancelled through the EXISTING W4 HTTP route. Same helpers, same
      //    order, no cancel round (see the doc comment's disclosure). ───────────────────────────
      const suffixB = `parity-b-${TS}`
      const requesterB = `wi13-req-${suffixB}`
      const approverB = `wi13-apr-${suffixB}`
      const adminB = `wi13-admin-${suffixB}`
      await grantWrite(requesterB)
      const adminTokenB = await authToken(baseUrl, adminB)
      const requesterTokenB = await authToken(baseUrl, requesterB)
      const approverTokenB = await authToken(baseUrl, approverB)
      const templateB = await publishOneNodeTemplate(adminTokenB, approverB, suffixB)
      const documentB = await createApprovedOriginal(requesterB, requesterTokenB, approverTokenB, templateB)
      await ageApprovedAnchor(documentB, 30)
      await setDocumentWindowDays(documentB, 90)
      const attachedB = await attachAttendanceRequest(documentB, requesterB)
      await seedDirectoryIdentity(requesterB, attachedB.orgId)

      // Both fixtures must sit in the SAME org, or every org-scoped column below would diverge for
      // a reason the twin construction did not intend. Asserted rather than assumed.
      expect(attachedA!.orgId).toBe(attachedB.orgId)

      // ── Codex 审阅第 3 条修复 (2026-09-19). Subscribed BEFORE either path is driven, so A's
      //    count is a real zero-or-one rather than a listener that attached too late. This is the
      //    probe from `verify-codex-cancel-finding3-20260919.md` §3.3 turned into a standing
      //    assertion: it read `{sendsAfterA: 0, sendsAfterB: 1}` at `4a08a576e`. ────────────────
      expectCancelledEventDeliveryBound()
      const cancelledEvents = captureCancelledEvents()
      let approveA: Response
      let cancelB: Response
      try {
        // ── Drive A: approve the cancel round. ────────────────────────────────────────────────
        approveA = await jsonRequest(baseUrl, `/api/approvals/${a.roundInstanceId}/actions`, a.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(approveA.status, await approveA.clone().text()).toBe(200)
        const sendsAfterA = cancelledEvents.payloads.length

        // ── Drive B: the existing W4 path, as a user walks it. ────────────────────────────────
        cancelB = await jsonRequest(baseUrl, `/api/attendance/requests/${attachedB.requestId}/cancel`, requesterTokenB, {
          method: 'POST',
          body: {},
        })
        expect(cancelB.status, await cancelB.clone().text()).toBe(200)

        // THE PARITY, counted at the send site. Read as an ORDERED pair, not two independent
        // numbers: B's 1 is what proves the subscription was live for A's window, so A's 1 is a
        // measured send and not an unattached listener.
        expect({ sendsAfterA, sendsAfterB: cancelledEvents.payloads.length - sendsAfterA })
          .toEqual({ sendsAfterA: 1, sendsAfterB: 1 })
      } finally {
        cancelledEvents.stop()
      }

      // ── The W4 RESULT PAYLOAD, pinned. This is 「完整取消结果」 as the existing path returns it.
      //    `redeemCancelRoundInTxn` derives `outcome` from that SAME entry response
      //    (`classifyCancelRoundCancellationOutcomeV1(result.response)`) and returns
      //    `{ kind: 'applied', outcome }` — the redemption path DOES have a RETURN-VALUE
      //    counterpart to compare against. ⛔ CORRECTED (P3 hygiene pass, 2026-09-19): this
      //    comment previously said the payload was dropped and there was "no RETURN-VALUE
      //    counterpart"; checked against the production return type and found FALSE. It ALSO has
      //    a PERSISTED copy — the W4 seal writes the same object into
      //    `attendance_result_operations.response_snapshot` — which is what the LAST case in this
      //    file measures, narrowing finding (b) of the doc comment above to just the
      //    presentation-surface question.
      const payloadB = (await cancelB.json()) as {
        ok?: boolean
        data?: { requestId?: string; status?: string; orgId?: string; userId?: string; reversal?: unknown }
      }
      expect(payloadB.ok).toBe(true)
      expect(payloadB.data?.status).toBe('cancelled')
      expect(payloadB.data?.requestId).toBe(attachedB.requestId)
      expect(payloadB.data?.userId).toBe(requesterB)
      // `reversal` is the field carrying `unrecoverableExpired` (index.cjs:19392-19445). It is
      // PRESENT on this path — the property lock:86 calls 呈现 — and this fixture seeds no leave
      // lots, so its counters are zeros. Asserted as a shape so a later fixture that DOES seed
      // lots has a named place to strengthen.
      expect(Object.prototype.hasOwnProperty.call(payloadB.data ?? {}, 'reversal')).toBe(true)

      // ── Identity normalisation map: A-side value → B-side counterpart. Anything that survives
      //    this and still differs is a real divergence, not a fixture artefact. ─────────────────
      const oneRow = async (sql: string, params: unknown[]): Promise<Record<string, unknown>> => {
        const result = await pool().query<Record<string, unknown>>(sql, params)
        expect(result.rows.length, `${sql} :: ${JSON.stringify(params)}`).toBe(1)
        return result.rows[0]
      }

      // Every pair below is a FIXTURE-CONSTRUCTION fact — an identifier this test chose, or one
      // minted by the template publication it drove — and is looked up from the TEMPLATE tables,
      // never read off the rows being compared. That distinction is the whole integrity of the
      // method: a pair sourced from the compared rows themselves would not normalise the column,
      // it would silently EXCLUDE it (and could mask a real divergence anywhere else the same
      // value appears). `request_no` is the one identity that has no fixture-side source, so it is
      // declared as a divergence below instead of being substituted.
      const templateIdentity = async (templateId: string) => {
        const key = await oneRow(`SELECT key FROM approval_templates WHERE id = $1::uuid`, [templateId])
        const version = await oneRow(
          `SELECT id::text AS id FROM approval_template_versions WHERE template_id = $1::uuid ORDER BY version DESC LIMIT 1`,
          [templateId],
        )
        const published = await oneRow(
          `SELECT id::text AS id FROM approval_published_definitions WHERE template_id = $1::uuid`,
          [templateId],
        )
        return { key: key.key as string, versionId: version.id as string, publishedId: published.id as string }
      }
      const identityA = await templateIdentity(a.templateId)
      const identityB = await templateIdentity(templateB)
      const IDENTITY_SUBSTITUTIONS: readonly (readonly [string, string])[] = [
        [a.documentId, documentB],
        [attachedA!.requestId, attachedB.requestId],
        [a.requesterId, requesterB],
        [a.approverId, approverB],
        [a.templateId, templateB],
        [identityA.key, identityB.key],
        [identityA.versionId, identityB.versionId],
        [identityA.publishedId, identityB.publishedId],
      ]
      // Every substitution must be a real, non-empty, DISTINCT pair — otherwise a silently empty
      // map would normalise nothing and the compare would pass by doing no work.
      for (const [from, to] of IDENTITY_SUBSTITUTIONS) {
        expect(typeof from).toBe('string')
        expect(from.length).toBeGreaterThan(0)
        expect(from).not.toBe(to)
      }
      const normalise = (value: unknown): string => {
        let text = JSON.stringify(value ?? null)
        for (const [from, to] of IDENTITY_SUBSTITUTIONS) text = text.split(from).join(to)
        return text
      }

      // ── Codex 审阅第 3 条修复 (2026-09-19) — the ANNOUNCEMENT, compared the same way the rows
      //    below are: one payload each, normalised through the SAME substitution map, then
      //    required to be byte-equal. This is the 「完整取消结果逐字节等价于现有 W4 路径」 clause
      //    (lock §8 期 1) applied to the event, which until this commit the redemption path did
      //    not emit at all. Asserting equality rather than shape is what makes a future divergence
      //    in `requestId` / `status` / `orgId` / `userId` go red instead of passing a shape check.
      const eventA = cancelledEvents.forRequest(attachedA!.requestId)
      const eventB = cancelledEvents.forRequest(attachedB.requestId)
      expect({ a: eventA.length, b: eventB.length }).toEqual({ a: 1, b: 1 })
      expect(normalise(eventA[0])).toBe(normalise(eventB[0]))
      // …and pinned as VALUES too, so a normalisation that silently collapsed both to `null`
      // could not carry the assertion above.
      expect(eventB[0]).toEqual({
        requestId: attachedB.requestId,
        status: 'cancelled',
        orgId: attachedB.orgId,
        userId: requesterB,
      })

      // ── The comparator. Returns the set of columns whose NORMALISED values differ. ───────────
      const divergentColumns = (rowA: Record<string, unknown>, rowB: Record<string, unknown>): string[] => {
        const columns = [...new Set([...Object.keys(rowA), ...Object.keys(rowB)])].sort()
        return columns.filter((c) => normalise(rowA[c]) !== normalise(rowB[c]))
      }

      // ── Compare 1: the attendance request row — the 账侧 row proper. ─────────────────────────
      const reqA = await oneRow(`SELECT * FROM attendance_requests WHERE id = $1::uuid`, [attachedA!.requestId])
      const reqB = await oneRow(`SELECT * FROM attendance_requests WHERE id = $1::uuid`, [attachedB.requestId])
      expect(reqA.status).toBe('cancelled')
      expect(reqB.status).toBe('cancelled')
      const reqDiff = divergentColumns(reqA, reqB)
      expect(
        reqDiff.filter((c) => !declaredFor('attendance_requests').has(c)),
        `undeclared attendance_requests divergence — declared: ${[...declaredFor('attendance_requests')].join(', ')}`,
      ).toEqual([])

      // POSITIVE CONTROL for the comparator itself. If `normalise`/`divergentColumns` silently
      // compared nothing (an empty substitution map, a thrown-away key set), every assertion above
      // would pass vacuously. A column deliberately perturbed on a COPY must be reported.
      expect(divergentColumns({ ...reqA, status: 'not-cancelled' }, reqB)).toContain('status')
      // …and the identity columns must NOT be reported, which is what proves normalisation ran
      // rather than that the rows happened to match.
      expect(reqDiff).not.toContain('id')
      expect(reqDiff).not.toContain('user_id')
      expect(reqDiff).not.toContain('approval_instance_id')
      expect(reqDiff).not.toContain('resolved_by')

      // ── Compare 2: the ORIGINAL approval instance — `approved → cancelled`, written by C-1. ──
      const instA = await oneRow(`SELECT * FROM approval_instances WHERE id = $1`, [a.documentId])
      const instB = await oneRow(`SELECT * FROM approval_instances WHERE id = $1`, [documentB])
      expect(instA.status).toBe('cancelled')
      expect(instB.status).toBe('cancelled')
      const instDiff = divergentColumns(instA, instB)
      expect(
        instDiff.filter((c) => !declaredFor('approval_instances').has(c)),
        `undeclared approval_instances divergence — declared: ${[...declaredFor('approval_instances')].join(', ')}`,
      ).toEqual([])
      expect(instDiff).not.toContain('id')
      expect(instDiff).not.toContain('business_key')
      expect(instDiff).not.toContain('requester_snapshot')

      // ── Compare 3: the revoke audit row — lock §3 C-1's named shape. ─────────────────────────
      const recA = await oneRow(
        `SELECT * FROM approval_records WHERE instance_id = $1 AND action = 'revoke'`,
        [a.documentId],
      )
      const recB = await oneRow(
        `SELECT * FROM approval_records WHERE instance_id = $1 AND action = 'revoke'`,
        [documentB],
      )
      expect(recA.from_status).toBe('approved')
      expect(recA.to_status).toBe('cancelled')
      const recDiff = divergentColumns(recA, recB)
      expect(
        recDiff.filter((c) => !declaredFor('approval_records').has(c)),
        `undeclared approval_records divergence — declared: ${[...declaredFor('approval_records')].join(', ')}`,
      ).toEqual([])
      // THE CONDITIONAL GREEN, asserted rather than left to the comment: the redemption path's
      // audit row normalises onto the W4 path's because BOTH act as the requester. If the owner
      // rules otherwise (§3.11.4), this line is the one that goes red.
      expect(recDiff).not.toContain('actor_id')
      expect(recA.actor_id).toBe(a.requesterId)
      expect(recB.actor_id).toBe(requesterB)
      // The posture the BOUNDARY resolved in-lock, on both paths — lock §3 C-1 「运行模式与授权
      // 凭据由边界在锁内解析」. Equal, and equal to the value the HTTP path resolves for a
      // self-cancellation.
      expect((recA.metadata as Record<string, unknown>).w4ActorPosture).toBe('self')
      expect((recB.metadata as Record<string, unknown>).w4ActorPosture).toBe('self')

      // ── ⚠️ THE ONE SUBSTANTIVE DIVERGENCE THIS CASE FOUND, asserted as VALUES so it cannot
      //    quietly change. 「逐字节等价」 does NOT hold for the revoke row's request provenance:
      //    the W4 HTTP path attributes the cancellation to the caller's connection, and the
      //    redemption path has no connection of its own to attribute — the only HTTP request in
      //    play is the APPROVER's, against a DIFFERENT instance, so carrying its address here
      //    would attribute the requester's cancellation to the approver's browser. `null` is the
      //    honest value, not a gap to be filled.
      //
      //    FLAGGED FOR OWNER REGISTRATION (phase-2 MD): whether 账侧 parity is satisfied by this,
      //    or whether the audit row must carry a synthetic provenance marker (e.g. an
      //    `approval-cancel-round` sentinel) so the two paths are distinguishable in the audit
      //    trail by intent rather than by an absence. Nothing on this branch depends on which way
      //    it is settled; this case pins today's behaviour either way.
      expect(recA.ip_address).toBeNull()
      expect(recA.user_agent).toBeNull()
      expect(recB.ip_address).not.toBeNull()
      expect(recB.user_agent).not.toBeNull()

      // ── C-1 STEPS ③ AND ⑦, MEASURED — the two the three row compares above CANNOT see. ──────
      //
      // Lock:86 lists C-1's execution as seven steps. The compares above cover ④ (原审批实例
      // approved → cancelled + `approval_records`) and ⑤ (请求 cancelled). Step ③
      // 「按运行模式追加取消计算」 writes `attendance_record_calculations`, and step ⑦
      // 「发 `attendance.request.cancelled`」 enqueues `attendance_result_event_outbox` — NEITHER
      // table is in the three compared above, so a divergence there would have gone unseen behind
      // a green. They are measured here instead.
      //
      // WHY THEY ARE EXPECTED TO BE EQUAL, and why that is a NARROWING rather than a closure. Both
      // are gated on the ORG's accepted write posture, resolved by the boundary from the rollout
      // registry (`w4c0-operation-registry.ts:640`, `:877`): under `legacy_projection_only` the
      // adapter skips the P14 calculation (`index.cjs:35169`) and the boundary skips the outbox
      // enqueue (`w4c3b-request-operation-boundary.ts:903-916`). The twins are asserted to share an
      // org above, and posture is an ORG property, so both paths take the SAME branch by
      // construction — which means these two assertions confirm parity WITHOUT exercising the
      // non-legacy branch on either path. §3.12.3 records the same posture for the end-to-end case.
      // The `authoritative` / `shadow` postures remain UNEXERCISED on both sides; that is an OPEN
      // item in the phase-2 MD, not something this green covers.
      const calcCount = async (userId: string): Promise<string> =>
        (
          await pool().query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM attendance_record_calculations c
               JOIN attendance_records r ON r.id = c.attendance_record_id
              WHERE r.user_id = $1`,
            [userId],
          )
        ).rows[0].count
      const calcA = await calcCount(a.requesterId)
      const calcB = await calcCount(requesterB)
      expect(calcA, 'C-1 step ③ (按运行模式追加取消计算) must not diverge between the twins').toBe(calcB)

      const outboxCount = async (requestId: string): Promise<string> =>
        (
          await pool().query<{ count: string }>(
            `SELECT count(*)::text AS count FROM attendance_result_event_outbox
              WHERE event_kind = 'attendance.request.cancelled'
                AND payload->>'requestId' = $1`,
            [requestId],
          )
        ).rows[0].count
      const outboxA = await outboxCount(attachedA!.requestId)
      const outboxB = await outboxCount(attachedB.requestId)
      expect(outboxA, 'C-1 step ⑦ (发 attendance.request.cancelled) must not diverge between the twins').toBe(outboxB)
      // Pinned as VALUES, not just as equality: `0 === 0` is also what a broken attribution
      // predicate returns. If either becomes non-zero the posture assumption above changed and this
      // case's reasoning must be re-read, so it goes red rather than silently widening.
      expect({ calcA, calcB, outboxA, outboxB }).toEqual({ calcA: '0', calcB: '0', outboxA: '0', outboxB: '0' })

      // ── C-1 STEP ⑥, MEASURED — and it is a DIVERGENCE, not a parity. ────────────────────────
      //
      // Lock:86 makes `reverseLeaveBalanceDeduction`'s `unrecoverableExpired` 「必须呈现」. The
      // value is CARRIED on both paths, but by two different artefacts, so there is no row to put
      // side by side. Measured here with ONE predicate run against TWO inputs — same SQL, same
      // column — so that B's zero is discriminating rather than an uncontrolled miss.
      //
      // THE MECHANISM (read at this head, not inherited). The seal
      // (`w4c0-operation-registry.ts:764-789`, `UPDATE attendance_result_operations … SET state =
      // 'completed', response_snapshot = …`) sits at the END of the boundary's transaction
      // (`w4c3b-request-operation-boundary.ts:918-921`). It is NOT gated on `operationId`; the only
      // early return that skips it on a non-refused run is `preflight.kind ===
      // 'legacy_no_operation'` (`:897`), which the registry returns only when the org's posture is
      // `legacy_projection_only` AND the command carried no stable identity
      // (`w4c0-operation-registry.ts:641-648`, 「Null-ID legacy commands create no operation row」).
      // That makes it a 2×2 over (posture, operationId):
      //   · legacy + null      ⇒ legacy_no_operation ⇒ NO seal   ← path B, MEASURED here (0 rows)
      //   · legacy + non-null  ⇒ seals, returns `legacy_compat`  ← path A, MEASURED here (1 row)
      //   · non-legacy + null  ⇒ `fail('W4C0_OPERATION_ID_REQUIRED')` (`:650-653`)   NOT MEASURED
      //   · non-legacy + non-null ⇒ seals, returns `executed`                        NOT MEASURED
      // The two unmeasured cells are read off source only and are labelled as such; the link
      // 「operationId === null ⇒ plan.legacyNullIdCount > 0」 is NOT read, so the third cell is a
      // source-text claim, not a behaviour claim.
      //
      // WHY B CARRIES NO IDENTITY, AND WHY THAT IS THE REPRESENTATIVE CASE — not a fixture choice.
      // `resolveRequestOperationId` (`index.cjs:33304-33311`) reads `operationId`/`operation_id`
      // out of the REQUEST BODY and nothing else. The published contract for this endpoint
      // (`packages/openapi/src/paths/attendance.yml:758-765`) declares exactly two body properties,
      // `comment` and `metadata` — there is NO field a client could put an operation id in. The one
      // production client in the repo sends `JSON.stringify({})`
      // (`apps/web/src/views/AttendanceView.vue:23128-23131`); this fixture's `body: {}` above is a
      // copy of it, not a simplification. Census (excludes node_modules, docs, tests):
      //   $ grep -rn "attendance/requests/" . | grep -v node_modules | grep -i cancel
      //   ⇒ 1 production client (AttendanceView.vue:23128), 1 route registration
      //     (index.cjs:38634) + its DELETE alias (`:38638-38642`, same `cancelRequest` handler),
      //     1 spec (attendance.yml:748), 1 SDK type, 1 entrypoint constant; the rest are tests.
      // So making B seal would require sending a field the contract does not offer and no client
      // sends — it would buy a comparable row by making B stop being a twin of production.
      const sealCount = async (requestId: string): Promise<string> =>
        (
          await pool().query<{ count: string }>(
            `SELECT count(*)::text AS count FROM attendance_result_operations
              WHERE resolved_request_id = $1::uuid`,
            [requestId],
          )
        ).rows[0].count
      const sealA = await sealCount(attachedA!.requestId)
      const sealB = await sealCount(attachedB.requestId)
      // A is the IN-CASE POSITIVE CONTROL for B's zero: identical SQL, identical column, the only
      // difference is which request id goes in. A non-zero A proves the table exists, the predicate
      // matches, and the column is populated — so B's 0 is a measured ABSENCE of a seal, not a
      // broken query. Pinned as VALUES for the §3.14.1 reason.
      expect({ sealA, sealB }).toEqual({ sealA: '1', sealB: '0' })

      // The 呈现 the lock asks for, on A: persisted in the sealed snapshot. Asserted as a KEY
      // (this fixture seeds no leave lots, so the counter is 0 — §3.16 is where a seeded EXPIRED
      // lot drives it to 120), so the assertion survives the value changing but dies if the
      // carrier is dropped.
      const sealRowA = await oneRow(
        `SELECT entrypoint, state, response_snapshot FROM attendance_result_operations
          WHERE resolved_request_id = $1::uuid`,
        [attachedA!.requestId],
      )
      expect(sealRowA.entrypoint).toBe('request_cancel')
      expect(sealRowA.state).toBe('completed')
      const reversalA = ((sealRowA.response_snapshot as { data?: { reversal?: unknown } })?.data ?? {}).reversal
      expect(reversalA, 'C-1 step ⑥ — the sealed snapshot must still carry `reversal`').toBeDefined()
      expect(Object.keys(reversalA as Record<string, unknown>)).toContain('unrecoverableExpired')

      // The SAME value on B lives in the HTTP RESPONSE BODY and in no sealed row at all. The
      // earlier `hasOwnProperty` line only pins that the `reversal` KEY is there; the divergence
      // table in §3.22.4 claims the two carriers hold the SAME inner field, so the inner key is
      // asserted here too — otherwise B's half of that table would be weaker than A's.
      expect(
        Object.keys((payloadB.data as { reversal?: Record<string, unknown> }).reversal ?? {}),
        'C-1 step ⑥ — B carries `unrecoverableExpired` in its RESPONSE BODY, where A carries it in the seal',
      ).toContain('unrecoverableExpired')
      // That asymmetry IS the finding: ⑥'s 账侧 parity half is
      // NOT a writable byte-compare on a representative twin, because the two paths present the
      // value through different artefacts — A through `response_snapshot`, B through its response.
      // Recorded as a DECLARED DIVERGENCE with a mechanism (the 2×2 above), not as an open TODO.

      // ── The 呈现 channel — and THIS case is its DISCRIMINATING CONTROL. ──
      //
      // ⛔ THE TRIPWIRE FIRED, AS DESIGNED (see the sibling note in the `unrecoverableExpired`
      // case at the bottom of this file). These lines asserted the absence of a channel; a channel
      // now exists, so they are rewritten as positives rather than deleted.
      //
      // WHY THIS CASE MATTERS MORE THAN THE POSITIVE ONE: this fixture seeds NO leave-balance
      // lots, so the very same production code path yields `unrecoverableExpired: 0` here and
      // `120` there. Asserting the CLEAN token on THIS fixture is what proves the expired token is
      // computed from the payload rather than hardcoded for every redemption — a positive-only
      // assertion on one fixture would pass against a path that always says
      // `cancelled_with_unrecoverable_expired`.
      const dtoA = (await approveA.json()) as Record<string, unknown>
      const outcomeA = dtoA.cancellationOutcome as { status?: string; reversal?: Record<string, unknown> } | undefined
      expect(outcomeA?.status).toBe('cancelled')
      expect(outcomeA?.status).not.toBe('cancelled_with_unrecoverable_expired')
      // Reported-and-zero, NOT absent: §3.16.1's lesson applied to the wire shape — an absent
      // summary would make 「nothing to reverse」 and 「the channel is not wired」 byte-identical.
      expect(outcomeA?.reversal).toEqual({
        reversed: 0,
        lots: 0,
        unrecoverableExpired: 0,
        alreadyReversed: false,
      })
    },
  )

  /**
   * ── `unrecoverableExpired` 呈现 (lock:86) — the half that IS closable, and a CLAIM RETRACTED ──
   *
   * lock:86 states C-1's step ⑥ as 「`reverseLeaveBalanceDeduction`(返回 `unrecoverableExpired`,
   * **必须呈现**)」. Phase-2 MD §3.15.6 called the whole item a CONTRACT GAP on the ground that
   * 「the approval side has no channel to present it on **at all**」.
   * ⚠️ P3-hygiene (2026-09-19): a channel exists now (§3.18) — the 账侧 parity case above asserts
   * it POSITIVELY, pinning the CLEAN token (`dto.cancellationOutcome.status === 'cancelled'`,
   * every counter zero) on its zero-lot fixture, precisely so it can discriminate from what THIS
   * case pins below on a seeded-expired-lot fixture.
   *
   * ⛔ THAT SECOND HALF IS RETRACTED BY THIS CASE, and the retraction is a measurement, not a
   * re-reading. The redemption path supplies a NON-NULL `operationId`
   * (`deriveCancelRoundW4OperationIdV1`), so it takes the boundary's identity+preflight+**seal**
   * branch, and the seal is `sealAttendanceResultOperationV1(trx, identity, { responseSnapshot:
   * jsonValue(result.response) })` (`w4c3b-request-operation-boundary.ts:918-921`), which writes
   * `attendance_result_operations.response_snapshot` — the adapter's WHOLE response object,
   * `data.reversal` included (`w4c0-operation-registry.ts:756-790`). That write is issued on the
   * caller's transaction client, so it commits with the approve. The counter is therefore
   * COMPUTED, and PERSISTED, and QUERYABLE per operation, on the redemption path. What remains
   * open is only WHICH USER-FACING SURFACE renders it — an owner decision this branch does not
   * make. ⚠️ P3-hygiene (2026-09-19): that surface HAS since been added (§3.18, a default the
   * owner still needs to ratify) — the end of this case now asserts the channel POSITIVELY
   * (`cancelled_with_unrecoverable_expired`), not as a negative; see the case's own inline comment
   * at the tripwire for what changed and why the two lines were rewritten rather than deleted.
   *
   * The other half of §3.15.6's finding stands and is what this case closes as a TEST gap: 「no
   * fixture seeds leave-balance lots, so both paths produce zero counters」. A zero counter cannot
   * distinguish 「computed and zero」 from 「never computed」 — `0 === 0` is also what a path that
   * never called `reverseLeaveBalanceDeduction` produces. This fixture seeds an EXPIRED lot with a
   * live `deduct` event for the request, so the expected value is 120, not 0.
   *
   * WHY AN *EXPIRED* LOT AND NOT A LIVE ONE. §3a of `reverseLeaveBalanceDeduction`
   * (`index.cjs:19415-19424`): an expired lot is NOT resurrected — the portion is counted into
   * `unrecoverableExpired` and **no `reverse` event is written and no `remaining_minutes` is
   * touched**. So this case gets a non-zero counter whose correctness is checkable from two
   * directions at once: the counter's value, and the absence of the writes a non-expired lot
   * would have made. Both are asserted.
   *
   * NON-VACUITY, asserted BEFORE the action rather than argued: the lot is read back through the
   * SAME predicate production uses (`expires_at IS NOT NULL AND expires_at <= now()`), and the
   * `deduct` event is counted. Without those two rows the assertion below would be
   * `unrecoverableExpired === 0` and would pass against a path that does nothing.
   *
   * WHAT THIS CASE DOES NOT ESTABLISH:
   *   - WHICH surface a human reads 呈现 from, or whether the field must survive a reload on the
   *     DTO. The channel's EXISTENCE is no longer open (§3.18 added it, and the case's own
   *     assertions below are positive); the status tokens and the two carriers (action-response
   *     DTO, approve audit-row `metadata`) are implementer defaults, registered for owner
   *     ratification in phase-2 MD §3.18.7, not a gap this case leaves silently open.
   *   - The LIVE-lot reversal half (`reversed > 0`, a `reverse` event, `remaining_minutes`
   *     restored). That is a different branch of the same helper and is not what lock:86's
   *     「必须呈现」 names; it is left to the attendance line's own `reverseLeaveBalanceDeduction`
   *     unit tests (`tests/unit/attendance-leave-cancellation-reversal.test.ts`), which cover it.
   */
  it(
    'unrecoverableExpired 呈现 (lock:86): an EXPIRED lot makes the counter NON-ZERO on the ' +
      'redemption path, the W4 seal persists it in `attendance_result_operations.' +
      'response_snapshot`, and the approve DTO + audit-row metadata now carry the ' +
      '`cancelled_with_unrecoverable_expired` status token for it',
    async () => {
      const suffix = `uexp-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        attached = await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      expect(attached).toBeTruthy()
      await seedDirectoryIdentity(fixture.requesterId, attached!.orgId)
      // The REAL boundary, as in the END-TO-END case: a double returns `{ kind: 'executed' }` and
      // seals nothing, so every assertion below would be red against one.
      expect(getAttendanceCancellationExecutionPort()).toBeDefined()

      // ── The lot. `attachAttendanceRequest` writes `user_id = 'wi13-req-<suffix>'`, which IS
      //    `fixture.requesterId`, and the helper reverses on `requestRow.user_id` — so the lot must
      //    be granted to that same id or the deduct scan finds nothing.
      const lot = await pool().query<{ id: string }>(
        `INSERT INTO attendance_leave_balances
           (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes,
            source_type, source_key, granted_at, expires_at, status)
         VALUES ($1, $2, 'annual', 480, 360, 'grant', $3,
                 now() - interval '400 days', now() - interval '1 day', 'expired')
         RETURNING id::text AS id`,
        [attached!.orgId, fixture.requesterId, `wi13-uexp-${suffix}`],
      )
      const lotId = lot.rows[0].id
      createdLeaveBalanceIds.add(lotId)
      await pool().query(
        `INSERT INTO attendance_leave_balance_events
           (org_id, user_id, balance_id, event_type, delta_minutes, source_type, source_id)
         VALUES ($1, $2, $3::uuid, 'deduct', -120, 'leave_request', $4)`,
        [attached!.orgId, fixture.requesterId, lotId, attached!.requestId],
      )

      // ── NON-VACUITY, measured through production's own predicate. ───────────────────────────
      const pre = await pool().query<{ expired: boolean; remaining_minutes: number; deducts: string }>(
        `SELECT (b.expires_at IS NOT NULL AND b.expires_at <= now()) AS expired,
                b.remaining_minutes,
                (SELECT count(*)::text FROM attendance_leave_balance_events e
                  WHERE e.balance_id = b.id AND e.event_type = 'deduct' AND e.source_id = $2) AS deducts
           FROM attendance_leave_balances b WHERE b.id = $1::uuid`,
        [lotId, attached!.requestId],
      )
      expect(pre.rows[0].expired).toBe(true)
      expect(Number(pre.rows[0].remaining_minutes)).toBe(360)
      expect(pre.rows[0].deducts).toBe('1')

      const approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(approve.status, await approve.clone().text()).toBe(200)

      // The redemption really happened — otherwise the seal below could be absent for the boring
      // reason rather than the interesting one.
      expect((await roundOutcome(fixture.roundInstanceId)).outcome).toBe('applied')
      const cancelledRequest = await pool().query<{ status: string }>(
        `SELECT status FROM attendance_requests WHERE id = $1::uuid`,
        [attached!.requestId],
      )
      expect(cancelledRequest.rows[0]?.status).toBe('cancelled')

      // ── THE CHANNEL, measured. `response_snapshot` is the adapter's whole response object. ──
      const roundIdRow = await pool().query<{ id: string }>(
        `SELECT id FROM approval_rounds WHERE engine_instance_id = $1`,
        [fixture.roundInstanceId],
      )
      const operationId = deriveCancelRoundW4OperationIdV1(roundIdRow.rows[0].id)
      const sealed = await pool().query<{ state: string; response_snapshot: unknown }>(
        `SELECT state, response_snapshot FROM attendance_result_operations
          WHERE org_id = $1 AND operation_id = $2::uuid`,
        [attached!.orgId, operationId],
      )
      expect(sealed.rows.length).toBe(1)
      expect(sealed.rows[0].state).toBe('completed')
      const snapshot = sealed.rows[0].response_snapshot as {
        data?: { reversal?: Record<string, unknown> }
      }
      // Pinned as the WHOLE object, not just the one counter: `unrecoverableExpired: 120` alongside
      // `reversed: 0` / `lots: 0` is what says the expired portion was counted INSTEAD of restored.
      expect(snapshot.data?.reversal).toEqual({
        reversed: 0,
        lots: 0,
        unrecoverableExpired: 120,
        alreadyReversed: false,
      })

      // ── §3a: the expired lot is NOT resurrected. Zero `reverse` events, untouched remaining. ──
      const events = await pool().query<{ event_type: string; count: string }>(
        `SELECT event_type, count(*)::text AS count FROM attendance_leave_balance_events
          WHERE balance_id = $1::uuid GROUP BY event_type ORDER BY event_type`,
        [lotId],
      )
      expect(events.rows).toEqual([{ event_type: 'deduct', count: '1' }])
      const post = await pool().query<{ remaining_minutes: number; status: string }>(
        `SELECT remaining_minutes, status FROM attendance_leave_balances WHERE id = $1::uuid`,
        [lotId],
      )
      expect(Number(post.rows[0].remaining_minutes)).toBe(360)
      expect(post.rows[0].status).toBe('expired')

      // ── The 呈现 SURFACE, CLOSED with the DEFAULT contract (⚠️ owner 待裁, 按默认值). ──
      //
      // ⛔ THE TRIPWIRE FIRED, AS DESIGNED. Until this commit these two lines asserted the DTO
      // carried NO such channel, and the MD said 「the day a channel IS added, the line goes red
      // and this OPEN item must be revisited rather than quietly staying open」. A channel was
      // added, they went red, and they are REWRITTEN as positives rather than deleted — deleting
      // them is the move §3.15.7 names ("nobody later 'fixes' the red by adding it to the
      // exclusion table"). What is still open is narrower and is recorded in the MD: which surface
      // a HUMAN reads, and whether the field must survive a reload on the DTO.
      const dto = (await approve.json()) as Record<string, unknown>
      const outcome = dto.cancellationOutcome as { status?: string; reversal?: Record<string, unknown> } | undefined

      // THE LOAD-BEARING ASSERTION is the STATUS TOKEN, not the number — §3.16 already owns 120.
      // This is what the named mutation 「把该状态折叠成一般失败」 has to break: collapse this
      // status into `cancelled` (plain success) or into any failure shape and this line goes red.
      expect(outcome?.status).toBe('cancelled_with_unrecoverable_expired')
      // ...and it is NOT 同形 with either neighbour, asserted rather than argued:
      expect(outcome?.status).not.toBe('cancelled')
      expect(outcome?.status).not.toBe('cancelled_reversal_unreported')
      // The counters ride along, pinned as the whole object exactly as the seal above is.
      expect(outcome?.reversal).toEqual({
        reversed: 0,
        lots: 0,
        unrecoverableExpired: 120,
        alreadyReversed: false,
      })

      // ── THE DURABLE HALF. The action response is transient; the approve audit row is not, and
      //    it commits in the SAME transaction as the cancellation. Without this a reload loses the
      //    presentation entirely, which is the failure mode an in-memory-only field would have.
      const auditRow = await pool().query<{ metadata: { cancellationOutcome?: { status?: string } } }>(
        `SELECT metadata FROM approval_records
          WHERE instance_id = $1 AND action = 'approve' ORDER BY created_at DESC LIMIT 1`,
        [fixture.roundInstanceId],
      )
      expect(auditRow.rows[0]?.metadata?.cancellationOutcome?.status).toBe(
        'cancelled_with_unrecoverable_expired',
      )
    },
  )
  /**
   * ══ Codex 审阅第 3 条修复 (2026-09-19) — the three controls for the post-commit announcement ══
   *
   * THE DEFECT. Under `legacy` / `legacy_compat` — the only postures any org runs at this head —
   * the boundary writes no outbox row, and the HTTP cancel route compensates by emitting
   * `attendance.request.cancelled` in process. The redemption path never passes through that route
   * (`cancelRequest`'s only two callers are the two HTTP routes), so it announced nothing. Measured
   * `{sendsAfterA: 0, sendsAfterB: 1}`; see `verify-codex-cancel-finding3-20260919.md`.
   *
   * WHY THESE CASES BIND A DOUBLE FOR THE PORT BUT NOT FOR THE DELIVERY. The double is what lets a
   * case choose the W4 `kind` it wants to exercise — `replay` in particular is otherwise
   * unreachable (below). The DELIVERY is the real one the attendance plugin bound at activate, so
   * what these cases observe is the production send site, not a stand-in for it. Every
   * zero-expecting assertion asserts that binding first (`expectCancelledEventDeliveryBound`),
   * because 0 is also what an unbound delivery produces.
   */
  it(
    'Codex 3 / 判据 II + lock §8 期 1: a redeemed cancel round announces `attendance.request.cancelled` ' +
      'EXACTLY ONCE on the real bus, with the same payload the HTTP path builds — the send the ' +
      'redemption path did not make before this commit (M-C3-1: delete the post-commit delivery ⇒ red)',
    async () => {
      const suffix = `c3one-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        attached = await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      expect(attached).toBeTruthy()

      // `legacy_compat` is the kind the REAL boundary returned for this fixture's org in the
      // verification probe (`accepted_write_posture = legacy_projection_only`, operation row
      // `state = completed`). Driving it through the double keeps the case pinned to that kind
      // while the end-to-end parity is carried by the 账侧 twin case against the real boundary.
      const portStub = bindCancellationPort(async () => ({
        kind: 'legacy_compat',
        response: {
          ok: true,
          data: {
            requestId: attached!.requestId,
            status: 'cancelled',
            orgId: attached!.orgId,
            userId: fixture.requesterId,
            reversal: { reversed: 0, lots: 0, unrecoverableExpired: 0, alreadyReversed: false },
          },
        },
      }))
      expectCancelledEventDeliveryBound()
      const cancelledEvents = captureCancelledEvents()
      try {
        const approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(approve.status, await approve.clone().text()).toBe(200)
      } finally {
        portStub.stop()
        cancelledEvents.stop()
      }

      // The redemption ran — without this, a zero-or-one count below could not tell a correct
      // send from a dispatch that never reached the redemption at all.
      expect(portStub.calls.length).toBe(1)
      expect(await roundOutcome(fixture.roundInstanceId)).toMatchObject({ outcome: 'applied' })

      // EXACTLY ONCE, and the whole payload pinned as a value — the same four fields, built by the
      // same function the HTTP route calls (`emitRequestCancelledEventForOutcomeV1`). A shape
      // check would survive a second construction drifting away from the first; this does not.
      expect(cancelledEvents.forRequest(attached!.requestId).length).toBe(1)
      expect(cancelledEvents.payloads).toEqual([
        {
          requestId: attached!.requestId,
          status: 'cancelled',
          orgId: attached!.orgId,
          userId: fixture.requesterId,
        },
      ])
    },
  )

  it(
    'Codex 3 / 持久化转换不得挂网络调用: when the dispatch transaction ROLLS BACK after a successful ' +
      'redemption, the announcement is NOT made — the send sits after `COMMIT`, so nothing is ' +
      'announced that is not durable (M-C3-2: move the delivery inside the transaction ⇒ red)',
    async () => {
      const suffix = `c3rb-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        attached = await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      expect(attached).toBeTruthy()

      // ── THE LEVER, and why it is this one. The failure has to land STRICTLY BETWEEN the
      //    redemption returning `applied` (which is what schedules the announcement) and the
      //    `COMMIT` (which is what releases it). A failure before the redemption would prove
      //    nothing — zero sends is trivially true when nothing was cancelled.
      //
      //    So the double, using the transaction client it is handed, arms a trigger that raises on
      //    the NEXT `approval_records` INSERT. In the redeem branch that insert is
      //    `insertApprovalRecord`, several statements after the redemption and several before the
      //    COMMIT. Both the function and the trigger are created INSIDE the caller's transaction,
      //    so PostgreSQL's transactional DDL rolls them away with everything else — verified
      //    directly: after the ROLLBACK, `pg_proc` and `pg_trigger` both hold zero rows for these
      //    names. Nothing leaks into the next case.
      const probeName = `c2_evt_rollback_probe_${TS}`
      const portStub = bindCancellationPort(async (input) => {
        await input.client.query(
          `CREATE FUNCTION public.${probeName}() RETURNS trigger LANGUAGE plpgsql AS `
            + `$fn$ BEGIN RAISE EXCEPTION 'C2_EVT_FORCED_ROLLBACK'; END $fn$`,
        )
        await input.client.query(
          `CREATE TRIGGER ${probeName}_trg BEFORE INSERT ON approval_records `
            + `FOR EACH ROW EXECUTE FUNCTION public.${probeName}()`,
        )
        return {
          kind: 'legacy_compat',
          response: {
            ok: true,
            data: {
              requestId: attached!.requestId,
              status: 'cancelled',
              orgId: attached!.orgId,
              userId: fixture.requesterId,
              reversal: { reversed: 0, lots: 0, unrecoverableExpired: 0, alreadyReversed: false },
            },
          },
        }
      })
      expectCancelledEventDeliveryBound()
      const cancelledEvents = captureCancelledEvents()
      let approve: Response
      let approveBody: string
      try {
        approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        approveBody = await approve.clone().text()
      } finally {
        portStub.stop()
        cancelledEvents.stop()
      }

      // ── POSITIVE CONTROL 1: the redemption REALLY ran, and really succeeded. Without it, the
      //    zero below is indistinguishable from a dispatch that failed before reaching C-1.
      expect(portStub.calls.length).toBe(1)
      // ── POSITIVE CONTROL 2: the transaction really rolled back. The raise is `P0001`, which is
      //    not in `isRetryableSqlState`, so it surfaces as a 500 rather than the 503 contention
      //    mapping.
      expect(approve!.status, approveBody!).toBe(500)
      // ── POSITIVE CONTROL 3: rolled back as DATA, not merely as a status code. The round keeps
      //    its seat and stays `pending` — C-3 row 5's shape, the retryable one.
      const round = await roundOutcome(fixture.roundInstanceId)
      expect(round.outcome).toBe('pending')
      expect(round.ended_at).toBeNull()
      const instanceRow = await pool().query<{ status: string }>(
        `SELECT status FROM approval_instances WHERE id = $1`,
        [fixture.roundInstanceId],
      )
      expect(instanceRow.rows[0]?.status).toBe('pending')

      // THE ASSERTION. A cancellation that did not commit was not announced.
      expect(cancelledEvents.payloads).toEqual([])

      // The probe left nothing behind — asserted, not assumed, because a leaked BEFORE INSERT
      // trigger on `approval_records` would poison every later case in this file.
      const leftovers = await pool().query<{ count: string }>(
        `SELECT (SELECT count(*) FROM pg_proc WHERE proname = $1)
              + (SELECT count(*) FROM pg_trigger WHERE tgname = $2) AS count`,
        [probeName, `${probeName}_trg`],
      )
      expect(leftovers.rows[0].count).toBe('0')
    },
  )

  /**
   * ⚠️ REACHABILITY, STATED RATHER THAN IMPLIED (the report asked for a REAL replay; this is the
   * honest answer instead of a weaker substitute).
   *
   * A `replay` answer is UNREACHABLE through the redemption path at this head, by this mechanism:
   * the W4 seal that would make a later call a replay runs on the CALLER's client
   * (`w4c3b-request-operation-boundary.ts:918-921`), so a rolled-back attempt leaves no operation
   * row to replay against; and a committed one cannot re-enter, because the round is `applied` and
   * `redeemCancelRoundInTxn`'s `WHERE outcome = 'pending'` plus the partial unique index let a
   * round pass outlet #5 at most once. So the gate is DEFENSIVE — and it is gated anyway, because
   * 「unreachable at this head」 is a property of today's code that a future change can remove
   * silently. The double is not standing in for a reachable case here; it is the only way to
   * exercise a branch that exists precisely so the path stays correct if it ever becomes reachable.
   *
   * THE IDEMPOTENCY IS THE EXISTING W4 REPLAY PREFLIGHT, not a new key or table: the boundary
   * returns `replay` at `:870-874`, BEFORE its outbox enqueue, so the original run already
   * announced and a re-run must not announce again.
   */
  it(
    'Codex 3 / 幂等: a `replay` answer announces NOTHING — re-running one redemption does not ' +
      'deliver a second `attendance.request.cancelled` (M-C3-3: drop the kind gate ⇒ red)',
    async () => {
      const suffix = `c3rep-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        attached = await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      expect(attached).toBeTruthy()

      // The response a real replay carries: the FIRST run's sealed snapshot, replayed verbatim.
      // Identical in every field to the success case's payload — which is the point. If the gate
      // read the payload instead of the kind, this case and the success case would be
      // indistinguishable, and dropping the gate would still look green.
      const portStub = bindCancellationPort(async () => ({
        kind: 'replay',
        response: {
          ok: true,
          data: {
            requestId: attached!.requestId,
            status: 'cancelled',
            orgId: attached!.orgId,
            userId: fixture.requesterId,
            reversal: { reversed: 0, lots: 0, unrecoverableExpired: 0, alreadyReversed: false },
          },
        },
      }))
      expectCancelledEventDeliveryBound()
      const cancelledEvents = captureCancelledEvents()
      try {
        const approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(approve.status, await approve.clone().text()).toBe(200)
      } finally {
        portStub.stop()
        cancelledEvents.stop()
      }

      // The redemption ran AND committed — so this zero is a withheld send, not an absent one.
      expect(portStub.calls.length).toBe(1)
      expect(await roundOutcome(fixture.roundInstanceId)).toMatchObject({ outcome: 'applied' })
      expect(cancelledEvents.payloads).toEqual([])
    },
  )
  /**
   * The FAIL-OPEN half, which until this case was an assertion in a doc comment and nothing else
   * (`feedback_asserted_invariant_is_a_bug`: 注释断言不测 = 藏 bug). The delivery registry
   * deliberately fails OPEN where the EXECUTION port fails CLOSED, and the asymmetry is load
   * bearing — by the time the delivery is read, the business cancellation is already COMMITTED, so
   * throwing could not undo it and would only turn a durable success into a 500.
   *
   * This is also the ONLY consumer of `unregisterCancelRoundCancelledEventDelivery`. That is
   * deliberate rather than incidental: an exported unbind with no caller is indistinguishable from
   * a leak path nobody exercises.
   */
  it(
    'Codex 3 / fail-OPEN: with the delivery UNBOUND, a redemption still commits — the round is ' +
      '`applied` and the approve returns 200 (an unbound announcer must never fail a cancellation ' +
      'that is already durable), and nothing is announced',
    async () => {
      const suffix = `c3open-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        attached = await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      expect(attached).toBeTruthy()

      const portStub = bindCancellationPort(async () => ({
        kind: 'legacy_compat',
        response: {
          ok: true,
          data: {
            requestId: attached!.requestId,
            status: 'cancelled',
            orgId: attached!.orgId,
            userId: fixture.requesterId,
            reversal: { reversed: 0, lots: 0, unrecoverableExpired: 0, alreadyReversed: false },
          },
        },
      }))
      // SAVE AND RESTORE, same discipline as `bindCancellationPort`: the registry is process-wide
      // and the attendance plugin bound the real delivery at activate. Clearing it for good would
      // leave every later case asserting against a registry this one emptied — a state no
      // production process is ever in, and one that would make the other cases' zeros vacuous.
      const previousDelivery = getCancelRoundCancelledEventDelivery()
      expect(previousDelivery, 'nothing to restore ⇒ this case is not testing what it claims').toBeDefined()
      unregisterCancelRoundCancelledEventDelivery()
      expect(getCancelRoundCancelledEventDelivery()).toBeUndefined()
      const cancelledEvents = captureCancelledEvents()
      try {
        const approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        // THE ASSERTION: 200, not 500. A throw from the unbound branch would surface here.
        expect(approve.status, await approve.clone().text()).toBe(200)
      } finally {
        portStub.stop()
        cancelledEvents.stop()
        if (previousDelivery) registerCancelRoundCancelledEventDelivery(previousDelivery)
      }

      // The cancellation is DURABLE despite the announcement being impossible.
      expect(portStub.calls.length).toBe(1)
      expect(await roundOutcome(fixture.roundInstanceId)).toMatchObject({ outcome: 'applied' })
      expect(cancelledEvents.payloads).toEqual([])
      // And the registry is back, or every later case in this file silently loses its control.
      expect(getCancelRoundCancelledEventDelivery()).toBeDefined()
    },
  )
  /**
   * REBASE onto C-1 @`ba8a0133d` — §2-G4 「双时点按当前策略评估」 meets lock:143's now-ENFORCED domain.
   *
   * WHY THIS CASE EXISTS AT ALL. C-1 (Codex review 2026-09-19 finding 2) replaced the silently
   * defaulting `deriveCancelRoundRoundPolicy` with one that REFUSES an out-of-domain `suite` /
   * `windowDays` (409 `CANCEL_ROUND_SUITE_UNKNOWN` / `CANCEL_ROUND_WINDOW_OUT_OF_RANGE`), and this
   * slice's own weaker copy of that function was deleted in the rebase rather than renamed. C-1's
   * doc comment prescribes THIS consumer's handling verbatim — 「the final in-transaction evaluation
   * must call THIS function and treat a throw as `blocked` + the thrown code — never as a silent
   * `expired`」 — so the rebase created a NEW production branch inside
   * `evaluateCancelRoundFinalInLock`. A new branch that only a comment describes is a latent defect
   * in this repo's discipline, so it is gated here.
   *
   * WHY IT IS REACHABLE, not a theoretical cell. §2-G4 is explicitly a TWO-TIME-POINT evaluation:
   * the decision re-derives from the original document's CURRENT metadata, so a template/seed whose
   * policy was legal at creation and was re-tagged afterwards lands here. That is exactly what
   * fixture B does — one `UPDATE` between creation and decision, nothing else.
   *
   * THE ISOLATION. A and B are seeded identically (same anchor age, same legal 90-day window, same
   * attendance target, same port double, same action) and differ in ONE field: B's `windowDays` is
   * pushed out of `leave`'s ceiling AFTER its round exists. A is therefore the in-case positive
   * control for every zero B asserts — without it, `blocked` would also be what a fixture that
   * never redeems in the first place produces.
   *
   * WHAT THIS CASE DOES NOT PROVE, stated rather than implied: the `catch` matches the two
   * derivation codes BY CODE rather than by `instanceof ServiceError`, which is defensive against a
   * future statement moving inside the `try` (`CANCEL_ROUND_INVARIANT_VIOLATION` and
   * `CANCEL_ROUND_WINDOW_ANCHOR_MISSING` must stay rollback-and-retry, never an irreversible
   * `blocked`). TODAY the `try` contains only the derivation call, so no other error can arise
   * inside it and that narrowing has NO oracle here. It is disclosed as a guard without a gate, not
   * claimed as tested.
   */
  it(
    '判据 IV / §2-G4 (rebase onto C-1): a `windowDays` that became OUT-OF-DOMAIN between creation ' +
      'and decision closes the round `blocked` with the derivation\'s own code — never a silent ' +
      '`expired`, never a redemption, zero completion events and zero announcements — while the ' +
      'twin whose policy stayed legal redeems and announces once',
    async () => {
      const suffixA = `g4ok-${TS}`
      const suffixB = `g4blk-${TS}`
      let attachedA: { requestId: string; orgId: string } | undefined
      let attachedB: { requestId: string; orgId: string } | undefined
      const fixtureA = await seedPendingCancelRound(suffixA, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        attachedA = await attachAttendanceRequest(documentId, `wi13-req-${suffixA}`)
      })
      const fixtureB = await seedPendingCancelRound(suffixB, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        attachedB = await attachAttendanceRequest(documentId, `wi13-req-${suffixB}`)
      })
      expect(attachedA).toBeTruthy()
      expect(attachedB).toBeTruthy()

      // B's round was created under a LEGAL policy — pinned as a value, so the block below cannot
      // be confused with a creation that was refused (C-1's 负控 A covers the creation-time half).
      const createSnapshotB = await pool().query<{ policy_snapshot_at_create: Record<string, unknown> }>(
        `SELECT policy_snapshot_at_create FROM approval_rounds WHERE engine_instance_id = $1`,
        [fixtureB.roundInstanceId],
      )
      expect(createSnapshotB.rows[0].policy_snapshot_at_create.roundPolicy).toEqual({
        suite: 'leave',
        windowDays: 90,
      })

      // ── THE ONE FIELD. 365 > `leave`'s ceiling of 90, applied AFTER the round exists, so only the
      //    DECISION-time derivation sees it.
      await setDocumentWindowDays(fixtureB.documentId, 365)

      const portStub = bindCancellationPort(async (input) => ({
        kind: 'legacy_compat',
        response: {
          ok: true,
          data: {
            requestId: input.routeInput.requestId,
            status: 'cancelled',
            orgId: input.routeInput.orgId,
            userId: input.routeInput.actorId,
            reversal: { reversed: 0, lots: 0, unrecoverableExpired: 0, alreadyReversed: false },
          },
        },
      }))
      expectCancelledEventDeliveryBound()
      const cancelledEvents = captureCancelledEvents()
      const captureA = captureCompletionEvents(fixtureA.roundInstanceId)
      const captureB = captureCompletionEvents(fixtureB.roundInstanceId)
      let approveB: Response
      try {
        const approveA = await jsonRequest(
          baseUrl,
          `/api/approvals/${fixtureA.roundInstanceId}/actions`,
          fixtureA.approverToken,
          { method: 'POST', body: { action: 'approve' } },
        )
        expect(approveA.status, await approveA.clone().text()).toBe(200)
        approveB = await jsonRequest(
          baseUrl,
          `/api/approvals/${fixtureB.roundInstanceId}/actions`,
          fixtureB.approverToken,
          { method: 'POST', body: { action: 'approve' } },
        )
        // 200, not a 409 rethrow: the derivation's refusal is CONVERTED into a durable C-3 close,
        // which is what 「never as a silent expired」 and 「never a 500」 both come down to.
        expect(approveB.status, await approveB.clone().text()).toBe(200)
      } finally {
        captureA.stop()
        captureB.stop()
        portStub.stop()
        cancelledEvents.stop()
      }

      // ── THE CONTROL (A): the identical fixture whose policy stayed legal redeemed and announced.
      expect(captureA.seen).toEqual(['approval.approved'])
      expect(await roundOutcome(fixtureA.roundInstanceId)).toMatchObject({ outcome: 'applied' })
      expect(cancelledEvents.forRequest(attachedA!.requestId).length).toBe(1)

      // ── THE SUBJECT (B). C-1 was NOT invoked for B — the port saw exactly the ONE call A made,
      //    so 「零业务取消」 is a measured absence and not an empty fixture.
      expect(portStub.calls.length).toBe(1)
      expect(portStub.calls[0].routeInput.requestId).toBe(attachedA!.requestId)
      expect(cancelledEvents.forRequest(attachedB!.requestId).length).toBe(0)
      expect(captureB.seen).toEqual([])

      const dtoB = (await approveB.json()) as { id?: string; status?: string }
      expect(dtoB.id).toBe(fixtureB.roundInstanceId)
      expect(dtoB.status).toBe('rejected')

      // `blocked`, NOT `expired` — the distinction C-1's prescription is about. `block_reason`
      // carries the derivation's own code through the bounded `business_blocked:<code>` token.
      const roundB = await pool().query<{
        outcome: string
        ended_at: Date | null
        block_reason: string | null
        policy_snapshot_at_decision: Record<string, unknown> | null
      }>(
        `SELECT outcome, ended_at, block_reason, policy_snapshot_at_decision
           FROM approval_rounds WHERE engine_instance_id = $1`,
        [fixtureB.roundInstanceId],
      )
      expect(roundB.rows.length).toBe(1)
      expect(roundB.rows[0].outcome).toBe('blocked')
      expect(roundB.rows[0].outcome).not.toBe('expired')
      expect(roundB.rows[0].ended_at).not.toBeNull()
      expect(roundB.rows[0].block_reason).toBe('business_blocked:CANCEL_ROUND_WINDOW_OUT_OF_RANGE')

      // The decision snapshot says 「the policy could not be evaluated, and here is why」 rather than
      // fabricating a suite/window pair — the implementer choice registered in the design MD.
      expect(roundB.rows[0].policy_snapshot_at_decision).not.toBeNull()
      const decisionB = roundB.rows[0].policy_snapshot_at_decision as Record<string, unknown>
      expect(decisionB.roundPolicy).toBeNull()
      expect(decisionB.roundPolicyError).toBe('CANCEL_ROUND_WINDOW_OUT_OF_RANGE')

      // The system sentinel closed it, and the audit row names the same code — 「历史记录必须能查出来」.
      const recordsB = await pool().query<{ actor_id: string; metadata: Record<string, unknown> }>(
        `SELECT actor_id, metadata FROM approval_records
          WHERE instance_id = $1 AND to_status = 'rejected'`,
        [fixtureB.roundInstanceId],
      )
      expect(recordsB.rows.length).toBe(1)
      expect(recordsB.rows[0].actor_id).toBe('system:approval-cancel-round')
      expect(recordsB.rows[0].metadata.cancelRoundOutcome).toBe('blocked')
      expect(recordsB.rows[0].metadata.cancelRoundCloseReason).toBe(
        'business_blocked:CANCEL_ROUND_WINDOW_OUT_OF_RANGE',
      )
    },
  )
  /**
   * ═══ POST-COMMIT EXCEPTION ISOLATION + THE REVERSAL HELPER'S OWN IDEMPOTENCY LATCH ═══
   *
   * owner directive, 2026-09-19, on the four-point focus gate
   * (`impl-gate-C-slice2-focus4-20260919.md` §7 P3-1 / P3-2):
   *
   *   「post-commit 异常隔离:最终闸补定向故障注入。若通知抛错能让已提交的取消返回失败,会诱发重试,
   *     不能只作披露。应证明异常不会改写已提交结果,且重试不重复兑现。
   *     内层 alreadyReversed:按声明范围处理。当前证据只能写外层重放不重复退款。若要声称余额冲销自身
   *     幂等,须让调用真正进入内层,补重复冲销场景及对应 mutation。」
   *
   * ── WHY THESE THREE CASES RUN AGAINST THE REAL BOUNDARY, NOT `bindCancellationPort`. ─────────
   * A double returns a CANNED `reversal` object and writes no balance rows at all, so owner's
   * assertion (b) 「余额已返还」 would be structurally unmeasurable against one — the numbers would
   * be whatever the double was told to say, and the mutations below would stay green
   * (`feedback_positive_control_not_failclosed`). These three therefore follow the
   * `unrecoverableExpired` case's pattern: real port, real `seedDirectoryIdentity`, real W4
   * preflight/seal — with a LIVE grant lot instead of an expired one, because an expired lot makes
   * the whole reversal path an identity and would hide every difference these cases exist to see.
   *
   * ── THE SYNCHRONY CENSUS THAT MAKES A SYNCHRONOUS `throw` THE FAITHFUL INJECTION SHAPE. ──────
   * A sync `try`/`catch` around an ASYNC callee catches nothing, so 「the delivery is isolated」
   * would be a claim about a shape production never produces unless the whole chain is sync
   * (`feedback_fixture_shape_must_match_named_scenario`). It is, read end to end and closed-world:
   *   - the contract:      `CancelRoundCancelledEventDeliveryV1` is `(…) => void`
   *                        (`attendance-cancellation-execution-port.ts:306-309`) — not `Promise<void>`.
   *   - the ONLY binder:   `plugins/plugin-attendance/index.cjs:35862-35866` binds the non-async
   *                        arrow `emitRequestCancelledEventForOutcomeV1` (`:25057-25067`). Census,
   *                        repo-wide and closed-world (`grep -rn` over packages/plugins/apps/scripts,
   *                        minus node_modules and tests) ⇒ 5 hits: the registry definition
   *                        (`…execution-port.ts:314`), the unregister definition (`:324`, a substring
   *                        match), the plugin-API interface declaration (`types/plugin.ts:1588`), the
   *                        host's pass-through (`index.ts:2769`), and EXACTLY ONE site that supplies
   *                        a delivery function — the plugin line above.
   *   - the emit chain:    `emitEvent` → `plugin-manager.ts:588-592` → `index.ts:1245`
   *                        → `EventBus.emit` (`event-bus.ts:70-72`) → `dispatch` (`:27-38`) — every
   *                        hop returns `void`, and each subscriber is additionally wrapped in the
   *                        bus's own `try`/`catch` (`:46-50`).
   * ⇒ a throw FROM THE DELIVERY HOP ITSELF surfaces at
   *   `deliverCancelRoundCancelledEventPostCommit`'s `try` as a SYNCHRONOUS throw, which is exactly
   *   what the first case injects.
   *
   * ── ⚠️ CORRECTION (2026-09-19, round-3 full gate P2-1 + P3-5) — comment only, no assertion moved. ──
   * The line above used to read 「a LISTENER bug surfaces at … `:13406`'s `try`」. Both halves were wrong:
   *   - the line number: the delivery's `try` is at `ApprovalProductService.ts:13479` (`catch` `:13481`,
   *     block ends `:13486`). `:13406` belongs to a DIFFERENT method, `enqueueApprovalTaskCreatedEventsInTxn`.
   *   - the mechanism (the part that matters): a listener bug CANNOT reach that `try` at all.
   *     `event-bus.ts`'s `subscribe()` wraps EVERY handler in the bus's OWN `try`/`catch`
   *     (`:46-50`, the `catch` only `logger.error`s) and registers that WRAPPER — not the handler —
   *     via `this.emitter.on(pattern, wrapper)` (`:56`). A subscriber's exception is swallowed by
   *     the bus and never propagates back up the emit chain.
   *   The census rows just above already stated this fact correctly; it was the CONCLUSION that
   *   mis-attributed it. Nothing about these cases is weakened: the injected shape (the delivery
   *   function itself throwing synchronously) is still the faithful model of 「this hop throws」,
   *   and M-PC1 (delete the `:13479-13486` try/catch ⇒ case (a) goes `expected 500 to be 200`)
   *   proves that try/catch is load-bearing. What changes is only WHAT it defends against: a throw
   *   from the delivery hop itself, not 「a listener has a bug」 — listeners are independently
   *   isolated by the bus, so this try/catch is defence in depth for them, not their only guard.
   *
   * ── ⚠️ THE RAW `file:line` REFS IN THIS BLOCK ARE PINNED TO `4ded8c2bb` (POST-REBASE). ───────
   * The hazard this warning was written for ALREADY FIRED, mid-task: the merge train
   * `rebase --onto`'d C-2 onto the new C-1 while this slice was being written, and every number
   * moved (`deliver…` :12688 → :12761, the latch :19398 → :19425, and so on). All 79 refs in this
   * block and in the MD were re-anchored and then machine-verified line by line (35/35 anchors
   * assert the expected token is on the stated line). The refs pinned to the PRE-rebase
   * `c9cad2514` are RETRACTED — do not use that commit's numbers.
   *
   * ⚠️ FAILED-CLAIM MARKER (2026-09-19, round-3 full gate P2-1) — it voids the two universal
   * quantifiers in the sentence above, and nothing else in this block.
   * The 79/35-35 sentence is THAT pass's own self-report, not a verified fact at this head. A
   * repo-wide census run at the delivery head `92d7bade24`
   * (`grep -rn "13406\|13413" --include="*.md" --include="*.ts" --include="*.cjs" --include="*.mjs" .`,
   * node_modules excluded) returns EXACTLY 2 hits, both in the verification MD — the same construct
   * this very comment got wrong, which that pass fixed in the design MD (§D1 → `:13479-13486`) and
   * missed here and there. So 「ALL 79 re-anchored」 and 「machine-verified 35/35」 do not hold: if
   * those 2 were inside the 35 the reading was false, and if they were outside, the denominator was
   * quietly shrunk. Both MD hits and this block's own bad ref are corrected in the same round; see
   * the verification MD's 「第 3 轮记录修正(2026-09-19)」 for the commands and their raw output.
   * The rest of that pass's re-anchoring is NOT voided by this marker — the refs independently
   * re-derived this round (`:11011`, `:11656`, `:13479-13486`, `event-bus.ts:46-50`) are recorded there.
   *
   * It will fire again on the next rebase. This branch litigated the same thing once before
   * (`acfab57e7`, 「convert stale ApprovalProductService.ts line refs to symbol anchors」), so the
   * anchors are named here as well and a re-gate should follow the SYMBOL, not the number:
   *   `deliverCancelRoundCancelledEventPostCommit` (the delivery + its try/catch) ·
   *   `supersedeCardDeliveriesPostCommit` / `emitApprovalTaskCreatedEventsPostCommit` (the two
   *   upstream post-commit steps) · the `actorCanAct` authorization throw · the
   *   `instance.status !== 'pending'` terminal guard · `reverseLeaveBalanceDeduction`'s `already`
   *   latch. The MD's mutation ledger names its sites by line too, and carries the same warning.
   *
   * ── WHAT THESE CASES DELIBERATELY DO NOT DO: change production. ──────────────────────────────
   * owner's remedial clause is conditional — 「若通知抛错能让已提交的取消返回失败 … 这是缺陷」. It does
   * NOT fire at this head: the delivery is already wrapped at `ApprovalProductService.ts:13479-13486`
   * and the first case MEASURES that (200, not 500). What was missing was the evidence, which is
   * what this block adds. The residual exposure the gate found — an UPSTREAM post-commit step
   * escaping into the shared outer `catch`, which skips the delivery and 500s an already-committed
   * cancellation — is measured by the second case and its remedy is registered for owner in the
   * phase-2 MD rather than applied here (moving the delivery to sit immediately after `COMMIT`
   * changes post-commit ordering the focus gate blessed at the current order, and this slice is
   * rebased onto C-1 by the merge train).
   */
  async function seedLiveAnnualLotWithLedger(
    orgId: string,
    userId: string,
    key: string,
    ledger: {
      amountMinutes: number
      remainingMinutes: number
      deductMinutes: number
      requestId: string
      priorReverseMinutes?: number
    },
  ): Promise<string> {
    // A LIVE lot: `status='active'` and an `expires_at` in the FUTURE, so production's own expiry
    // predicate — `(expires_at IS NOT NULL AND expires_at <= now())`, the one
    // `reverseLeaveBalanceDeduction` reads at `index.cjs:19430` — answers false and the §3a
    // non-resurrection branch is NOT the branch under test here.
    const lot = await pool().query<{ id: string }>(
      `INSERT INTO attendance_leave_balances
         (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes,
          source_type, source_key, granted_at, expires_at, status)
       VALUES ($1, $2, 'annual', $4, $5, 'grant', $3,
               now() - interval '10 days', now() + interval '300 days', 'active')
       RETURNING id::text AS id`,
      [orgId, userId, key, ledger.amountMinutes, ledger.remainingMinutes],
    )
    const lotId = lot.rows[0].id
    createdLeaveBalanceIds.add(lotId)
    await pool().query(
      `INSERT INTO attendance_leave_balance_events
         (org_id, user_id, balance_id, event_type, delta_minutes, source_type, source_id)
       VALUES ($1, $2, $3::uuid, 'deduct', $4, 'leave_request', $5)`,
      [orgId, userId, lotId, -ledger.deductMinutes, ledger.requestId],
    )
    if (ledger.priorReverseMinutes !== undefined) {
      await pool().query(
        `INSERT INTO attendance_leave_balance_events
           (org_id, user_id, balance_id, event_type, delta_minutes, source_type, source_id)
         VALUES ($1, $2, $3::uuid, 'reverse', $4, 'leave_request', $5)`,
        [orgId, userId, lotId, ledger.priorReverseMinutes, ledger.requestId],
      )
    }
    // NON-VACUITY, through production's own predicate rather than through the literals just
    // inserted: if the lot were expired (or the deduct missing) every downstream number below
    // would be produced by the boring reason instead of the interesting one.
    const pre = await pool().query<{ expired: boolean; remaining_minutes: number; status: string }>(
      `SELECT (b.expires_at IS NOT NULL AND b.expires_at <= now()) AS expired,
              b.remaining_minutes, b.status
         FROM attendance_leave_balances b WHERE b.id = $1::uuid`,
      [lotId],
    )
    expect(pre.rows[0].expired).toBe(false)
    expect(pre.rows[0].status).toBe('active')
    expect(Number(pre.rows[0].remaining_minutes)).toBe(ledger.remainingMinutes)
    return lotId
  }

  /**
   * The COMMITTED-RESULT population, as ONE object so 「已提交结果不变」 can be asserted as a byte
   * comparison (`expect(after).toEqual(before)`) instead of as a handful of individually chosen
   * fields that a future narrowing could quietly shrink (the focus gate's §5.2 discipline).
   * Covers every row the redemption writes: the original document, the business request row, the
   * round row, the revoke audit row, the balance lot, the balance ledger, and the W4 seal.
   */
  async function committedCancellationSnapshot(
    engineInstanceId: string,
    documentId: string,
    requestId: string,
    orgId: string,
    lotId: string,
  ): Promise<Record<string, unknown>> {
    const original = await pool().query<{ status: string; version: number }>(
      `SELECT status, version FROM approval_instances WHERE id = $1`,
      [documentId],
    )
    const request = await pool().query<{ status: string; resolved_by: string | null; resolved: boolean }>(
      `SELECT status, resolved_by, (resolved_at IS NOT NULL) AS resolved
         FROM attendance_requests WHERE id = $1::uuid`,
      [requestId],
    )
    const round = await pool().query<{ outcome: string; ended: boolean }>(
      `SELECT outcome, (ended_at IS NOT NULL) AS ended
         FROM approval_rounds WHERE engine_instance_id = $1`,
      [engineInstanceId],
    )
    const revokes = await pool().query<{ action: string; from_status: string; to_status: string; actor_id: string }>(
      `SELECT action, from_status, to_status, actor_id FROM approval_records
        WHERE instance_id = $1 AND action = 'revoke' ORDER BY created_at`,
      [documentId],
    )
    const lot = await pool().query<{ remaining_minutes: number; status: string }>(
      `SELECT remaining_minutes, status FROM attendance_leave_balances WHERE id = $1::uuid`,
      [lotId],
    )
    const events = await pool().query<{ event_type: string; delta_minutes: number }>(
      `SELECT event_type, delta_minutes FROM attendance_leave_balance_events
        WHERE balance_id = $1::uuid ORDER BY event_type, delta_minutes`,
      [lotId],
    )
    const roundIdRow = await pool().query<{ id: string }>(
      `SELECT id FROM approval_rounds WHERE engine_instance_id = $1`,
      [engineInstanceId],
    )
    const seal = await pool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM attendance_result_operations
        WHERE org_id = $1 AND operation_id = $2::uuid`,
      [orgId, deriveCancelRoundW4OperationIdV1(roundIdRow.rows[0].id)],
    )
    return {
      original: original.rows[0],
      request: request.rows[0],
      round: round.rows[0],
      revokes: revokes.rows,
      lot: lot.rows[0],
      events: events.rows,
      sealRows: seal.rows[0].n,
    }
  }

  /**
   * P3-1 (a)(b)(c) — the NOTIFICATION itself throws.
   *
   * THE INJECTION POINT is the production registry, not a test-only seam added for this case: the
   * bound delivery is replaced (save-and-restore, the convention `c3open` established in this file)
   * with one that throws SYNCHRONOUSLY — the shape a throw FROM THE DELIVERY HOP ITSELF takes,
   * which is what the census in the block comment above establishes.
   *
   * ⚠️ CORRECTION (2026-09-19, round-3b gate P2-1) — comment only, no assertion moved. This
   * sentence used to read 「the shape a real listener bug takes」, which contradicted the very
   * block it cites as authority: that block's own CORRECTION note records that a listener bug
   * CANNOT reach the delivery's try at all, because `event-bus.ts`'s `subscribe()` registers a
   * WRAPPER holding the bus's own try/catch (`:46-50`) rather than the handler (`:56`), so a
   * subscriber's exception never propagates back up the emit chain. Nothing about this case
   * changes: the injected shape (the bound delivery itself throwing synchronously) was already
   * the faithful model of 「this hop throws」; only the ATTRIBUTION was wrong.
   *
   * No production line changes to make this case runnable.
   *
   * THE THREE ASSERTIONS owner named:
   *   (a) the approve still returns 200 — the committed cancellation is NOT reported as a failure,
   *       so nothing induces the client to retry at all.
   *   (b) every committed row is exactly what it was — the exception rewrote nothing.
   *   (c) retrying the same redemption does not redeem, refund or announce a second time.
   *
   * ⚠️ SCOPE OF (c), stated rather than implied (`feedback_verified_one_link_generalised_to_the_chain`;
   * the focus gate's §4.2 caught exactly this over-read once already), and CORRECTED against what
   * the run actually measured rather than against what was predicted. The retry below is refused
   * with **403 `APPROVAL_ASSIGNMENT_REQUIRED`** at `dispatchAction`'s AUTHORIZATION gate
   * (`ApprovalProductService.ts:11011-11013`) — NOT with 409 at the terminal-status guard
   * (`:11656-11662`), which was the predicted answer and is wrong: the redemption's terminal advance
   * deactivates the round instance's seats, so `actorCanAct` is already false by the time the status
   * guard would be reached. The seat state is asserted below so that ordering is a measured fact
   * and not a story. The two guards stand in series, and M-PC2/M-PC3 below walk the ladder.
   *
   * So what is proven here is ENGINE-LEVEL retry safety. It does NOT exercise the W4 operation-id
   * replay preflight — that layer is covered by the `replay` case above and by the focus gate's
   * §4.2. The seal-row and ledger counts below are asserted anyway so both layers' answers are
   * visible rather than inferred.
   */
  it(
    'P3-1 (a)(b)(c): a post-commit notification that THROWS does not fail the committed cancellation ' +
      '(200, not 500), rewrites none of the committed rows, and a retry redeems/refunds/announces ' +
      'nothing a second time (M-PC1: drop the delivery try/catch ⇒ (a) red; M-PC2: neuter the ' +
      'authorization gate ⇒ (c) red)',
    async () => {
      const suffix = `pcthrow-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        attached = await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      expect(attached).toBeTruthy()
      await seedDirectoryIdentity(fixture.requesterId, attached!.orgId)
      expect(getAttendanceCancellationExecutionPort()).toBeDefined()

      const lotId = await seedLiveAnnualLotWithLedger(attached!.orgId, fixture.requesterId, `wi13-pcthrow-${suffix}`, {
        amountMinutes: 480,
        remainingMinutes: 360,
        deductMinutes: 120,
        requestId: attached!.requestId,
      })

      // ── THE INJECTION. Save-and-restore: the registry is process-wide and the attendance plugin
      //    bound the real delivery at activate, so leaving a throwing one behind would poison every
      //    later case in this file.
      const previousDelivery = getCancelRoundCancelledEventDelivery()
      expect(
        previousDelivery,
        'no real delivery was bound ⇒ this case would inject into a registry production is never in',
      ).toBeDefined()
      let deliveryCalls = 0
      registerCancelRoundCancelledEventDelivery(() => {
        deliveryCalls += 1
        throw new Error('PC-THROW-INJECTED: a post-commit delivery blew up')
      })

      let approve: Response
      let retry: Response
      try {
        approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })

        // ── (a) THE ASSERTION owner named. 200, not 500: a throw from the already-post-COMMIT
        //    delivery hop must not be reported to the caller as a failed cancellation, because a
        //    reported failure is what induces the retry this case then has to defend against.
        expect(approve.status, await approve.clone().text()).toBe(200)
        // NON-VACUITY: the injected delivery really ran and really threw. Without this, (a) would
        // also be green if the delivery had simply never been reached.
        expect(deliveryCalls).toBe(1)

        // ── (b) THE COMMITTED RESULT, pinned as a whole object before the retry touches anything.
        const committed = await committedCancellationSnapshot(
          fixture.roundInstanceId, fixture.documentId, attached!.requestId, attached!.orgId, lotId,
        )
        expect(committed).toEqual({
          original: { status: 'cancelled', version: 2 },
          request: { status: 'cancelled', resolved_by: fixture.requesterId, resolved: true },
          round: { outcome: 'applied', ended: true },
          revokes: [{
            action: 'revoke', from_status: 'approved', to_status: 'cancelled', actor_id: fixture.requesterId,
          }],
          // 480, i.e. the deducted 120 really came back — the assertion a canned double could not carry.
          lot: { remaining_minutes: 480, status: 'active' },
          events: [{ event_type: 'deduct', delta_minutes: -120 }, { event_type: 'reverse', delta_minutes: 120 }],
          sealRows: '1',
        })

        // ── (c) THE RETRY. Same round, same actor, same action — the shape a client that saw a
        //    failure would send.
        retry = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        // The MEASURED semantics, asserted as a value rather than as `not.toBe(200)` — a
        // `notEqual` family assertion cannot tell 「refused because the round is already spent」
        // from 「failed for some other reason」 (`feedback_not_this_error_is_not_an_outcome_assertion`).
        expect(retry.status, await retry.clone().text()).toBe(403)
        const retryBody = (await retry.json()) as { error?: { code?: string } | string; code?: string }
        const retryCode = typeof retryBody.error === 'object' ? retryBody.error?.code : retryBody.code
        expect(retryCode).toBe('APPROVAL_ASSIGNMENT_REQUIRED')
        // WHY THAT GATE AND NOT THE TERMINAL-STATUS ONE — measured, because the prediction was
        // wrong and a corrected prose claim would be unfalsifiable: the redemption's terminal
        // advance left the round instance with no ACTIVE seat, so the authorization gate answers
        // first and the terminal-status gate `instance.status !== 'pending'`
        // (`ApprovalProductService.ts:11656`) is never reached. Asserted as the whole grouped
        // population, so a future change that leaves a seat active goes red here instead of
        // silently re-routing (c) to a different guard.
        // ⚠️ 2026-09-19 (round-3 full gate P3-2): this comment used to name `:11583`, which is
        //   `await client.query(` — an `UPDATE approval_assignments` inside the revoke branch, not
        //   the terminal gate. Comment-only correction; the assertions below are untouched.
        const seats = await pool().query<{ is_active: boolean; n: string }>(
          `SELECT is_active, count(*)::text AS n FROM approval_assignments
            WHERE instance_id = $1 GROUP BY is_active ORDER BY is_active`,
          [fixture.roundInstanceId],
        )
        expect(seats.rows).toEqual([{ is_active: false, n: '1' }])

        // Nothing moved: not the rows, not the seal, not the ledger.
        expect(
          await committedCancellationSnapshot(
            fixture.roundInstanceId, fixture.documentId, attached!.requestId, attached!.orgId, lotId,
          ),
        ).toEqual(committed)
        // And the announcement was not attempted a second time either.
        expect(deliveryCalls).toBe(1)
      } finally {
        if (previousDelivery) registerCancelRoundCancelledEventDelivery(previousDelivery)
        else unregisterCancelRoundCancelledEventDelivery()
      }
      // The registry is back, or every later case in this file silently loses its control.
      expect(getCancelRoundCancelledEventDelivery()).toBe(previousDelivery)
    },
  )

  /**
   * P3-1, the RESIDUAL half the gate could only disclose: an UPSTREAM post-commit step escapes.
   *
   * THE MECHANISM. `dispatchAction`'s post-commit region is
   * `:12740 COMMIT` → `:12741 emitApprovalTaskCreatedEventsPostCommit` → `:12754 supersedeCardDeliveriesPostCommit`
   * → `:12761 deliverCancelRoundCancelledEventPostCommit`, and the whole region shares the method's
   * ONE outer `catch` (`:12772`). Both upstream calls swallow their own errors today
   * (`:13374-13375` / `:13359-13360`), so 「the announcement happens」 rests on a property of two unrelated
   * methods rather than on anything local. The gate measured the consequence with a confounded
   * probe and recorded it as P3, disclosure only. This case converts it into an executed,
   * instance-scoped assertion.
   *
   * WHY THE INJECTION IS NOT CONFOUNDED (unlike the gate's M6, which it names as such). The
   * prototype override below throws ONLY for this fixture's round instance; every other dispatch in
   * the process — including this fixture's own three setup approvals — passes straight through to
   * the real implementation. So the reds this case can produce are reds about the redemption, not
   * about fixture construction (`feedback_confounded_mutation_needs_isolated_variant_grid`).
   *
   * ⚠️ TWO OF THE ASSERTIONS BELOW ARE TRIPWIRES, NOT ENDORSEMENTS. `expect(approve.status).toBe(500)`
   * and `expect(cancelledEvents.payloads.length).toBe(0)` pin TODAY'S EXPOSURE: a committed,
   * refunded cancellation that is reported as a failure and is never announced. They are here so the
   * exposure is a measured fact instead of prose. If the post-commit region is ever isolated, or the
   * delivery hoisted to sit immediately after `COMMIT` (the remedy registered for owner in the
   * phase-2 MD), these two lines go RED and must be REWRITTEN to the improved values — never
   * deleted (`feedback_tests_freeze_change_not_approve_it`; the same tripwire discipline the
   * `unrecoverableExpired` case above already fired once).
   *
   * WHAT IS NOT A TRIPWIRE, and is the reason owner asked for this injection: the committed rows are
   * unchanged, and the retry that the 500 induces does not redeem, refund or announce twice. Those
   * two hold under either remedy and are the load-bearing half of this case.
   */
  it(
    'P3-1 residual: an UPSTREAM post-commit step escaping into the shared outer catch leaves every ' +
      'committed row byte-identical and keeps the induced retry from redeeming/refunding twice — ' +
      'while pinning today\'s exposure (the caller sees 500 and the cancellation is never announced)',
    async () => {
      const suffix = `pcesc-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        attached = await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      expect(attached).toBeTruthy()
      await seedDirectoryIdentity(fixture.requesterId, attached!.orgId)
      expect(getAttendanceCancellationExecutionPort()).toBeDefined()

      const lotId = await seedLiveAnnualLotWithLedger(attached!.orgId, fixture.requesterId, `wi13-pcesc-${suffix}`, {
        amountMinutes: 480,
        remainingMinutes: 360,
        deductMinutes: 120,
        requestId: attached!.requestId,
      })

      // ── THE INJECTION: the real production method, overridden on the prototype and scoped to ONE
      //    instance id. `supersedeCardDeliveriesPostCommit` is `private` in TypeScript only; at
      //    runtime it is an ordinary prototype member, which is what makes an instance-scoped
      //    override possible without a production test hook.
      const prototype = ApprovalProductService.prototype as unknown as Record<string, unknown>
      const originalSupersede = prototype.supersedeCardDeliveriesPostCommit as
        (this: unknown, instanceId: string, excludeId?: string) => Promise<void>
      expect(
        typeof originalSupersede,
        'the post-commit step this case injects into no longer exists under that name',
      ).toBe('function')
      let escapes = 0
      prototype.supersedeCardDeliveriesPostCommit = async function (
        this: unknown, instanceId: string, excludeId?: string,
      ): Promise<void> {
        if (instanceId === fixture.roundInstanceId) {
          escapes += 1
          throw new Error('PC-ESCAPE-INJECTED: an upstream post-commit step blew up')
        }
        return originalSupersede.call(this, instanceId, excludeId)
      }

      expectCancelledEventDeliveryBound()
      const cancelledEvents = captureCancelledEvents()
      let approve: Response
      let retry: Response
      try {
        approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        // ⚠️ TRIPWIRE (see the doc comment): today a post-COMMIT escape is reported to the caller as
        //    a failed action even though the cancellation is durable.
        expect(approve.status, await approve.clone().text()).toBe(500)
        // NON-VACUITY: the escape really happened, exactly once, on this instance.
        expect(escapes).toBe(1)

        // ── THE LOAD-BEARING HALF (b). Every committed row is what a SUCCESSFUL redemption writes:
        //    `rollbackQuietly` on an already-committed transaction undoes nothing, and must not.
        const committed = await committedCancellationSnapshot(
          fixture.roundInstanceId, fixture.documentId, attached!.requestId, attached!.orgId, lotId,
        )
        expect(committed).toEqual({
          original: { status: 'cancelled', version: 2 },
          request: { status: 'cancelled', resolved_by: fixture.requesterId, resolved: true },
          round: { outcome: 'applied', ended: true },
          revokes: [{
            action: 'revoke', from_status: 'approved', to_status: 'cancelled', actor_id: fixture.requesterId,
          }],
          lot: { remaining_minutes: 480, status: 'active' },
          events: [{ event_type: 'deduct', delta_minutes: -120 }, { event_type: 'reverse', delta_minutes: 120 }],
          sealRows: '1',
        })
        // ⚠️ TRIPWIRE: the announcement was SKIPPED — `:12761` sits after the step that escaped.
        expect(cancelledEvents.forRequest(attached!.requestId).length).toBe(0)

        // ── THE LOAD-BEARING HALF (c). The 500 above is precisely what induces a client retry.
        retry = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        // Same measured refusal as the case above (403 at the authorization gate, not 409 at the
        // terminal-status guard) — and this is the retry that TODAY'S 500 actively induces, which
        // is the whole reason owner asked for this injection.
        expect(retry.status, await retry.clone().text()).toBe(403)
        // The retry did not even reach the injected step, so the escape count is still 1 — and
        // nothing in the committed population moved.
        expect(escapes).toBe(1)
        expect(
          await committedCancellationSnapshot(
            fixture.roundInstanceId, fixture.documentId, attached!.requestId, attached!.orgId, lotId,
          ),
        ).toEqual(committed)
        expect(cancelledEvents.forRequest(attached!.requestId).length).toBe(0)
      } finally {
        prototype.supersedeCardDeliveriesPostCommit = originalSupersede
        cancelledEvents.stop()
      }
      // Restored by identity, not by shape — a later case running against the override would be
      // testing this case's injection instead of production.
      expect(prototype.supersedeCardDeliveriesPostCommit).toBe(originalSupersede)
    },
  )

  /**
   * P3-2 — `reverseLeaveBalanceDeduction`'s OWN `alreadyReversed` latch, EXECUTED.
   *
   * WHAT THE FOCUS GATE COULD AND COULD NOT SAY (§4.2, quoted so this case is not read for more
   * than it adds): its replay scenario measured `kind='replay'`, which means the boundary's
   * `attendanceResultOperationPreflightV1` short-circuited at
   * `w4c3b-request-operation-boundary.ts:870-874` BEFORE the adapter ran. So the evidence covered
   * the OUTER preflight gate; the inner latch at `plugins/plugin-attendance/index.cjs:19394-19425`
   * had ZERO executions. owner: 「若要声称余额冲销自身幂等,须让调用真正进入内层」.
   *
   * HOW THIS CASE GETS INSIDE. Not by calling the helper directly. The request is redeemed through
   * the ordinary production path — HTTP approve → `dispatchAction` → `executeInExternalTransaction`
   * → the real adapter → `:35334` `if (approvedLeave)` → `reverseLeaveBalanceDeduction` — on a
   * round whose operation id has never been sealed, so the outer preflight does NOT short-circuit
   * and the adapter really runs. What is arranged instead is the LEDGER: a `reverse` row for this
   * `source_id` already exists when the helper's first statement reads it (`:19420-19424`).
   *
   * ⚠️ THE DECLARED SCOPE, precisely (owner: 「按声明范围处理」). What today's SINGLE call site
   * cannot produce is not the partial reverse — the helper itself writes one whenever
   * `headroom < deducted` (`:19454-19457`) — it is *a `reverse` row for source_id X while request X
   * is still `approved`*, because `:35319-35327` flips the request to `cancelled` in the SAME transaction
   * as `:35334`'s refund, and `grep -n "'reverse'" plugins/plugin-attendance/index.cjs` returns
   * exactly three lines — the doc comment at `:19415`, the latch's own read at `:19422`, and the
   * helper's single `INSERT` at `:19466` — i.e. ONE writer, which is this helper itself. So this case proves: THE LATCH IS EXECUTED THROUGH THE
   * PRODUCTION CALL PATH AND IS LOAD-BEARING FOR THE LEDGER STATE IT SEES. It does NOT claim that
   * state arises in production today — the outer preflight is what stands between production and
   * this line, and that is the honest reading of 「余额冲销自身幂等」 at this head.
   *
   * WHY THE FIXTURE HAS HEADROOM, and why that is the whole point. amount 480 / remaining 420 with
   * a prior `reverse +60` leaves 60 minutes of headroom against a `deduct −120`. Without the latch
   * the scan at `:19427-19436` finds that deduct row, computes `restore = min(120, 60) = 60`, and
   * refunds a SECOND time. A fixture with no headroom (remaining already back at `amount_minutes`)
   * would make `restore <= 0` and `continue` — the case would pass with the latch DELETED, i.e. it
   * would be a test with no discriminating power (`feedback_ineffective_mutation_looks_like_a_useless_test`).
   */
  it(
    'P3-2 / 内层幂等 (index.cjs:19394-19425): with a `reverse` already on the ledger for this ' +
      'source_id, the redemption enters `reverseLeaveBalanceDeduction` through the real adapter and ' +
      'the latch refunds NOTHING a second time — zero balance change, no second ledger row, and ' +
      '`alreadyReversed: true` on both carriers (M-INNER: delete the latch ⇒ a second +60 ⇒ red)',
    async () => {
      const suffix = `innerrev-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        attached = await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      expect(attached).toBeTruthy()
      await seedDirectoryIdentity(fixture.requesterId, attached!.orgId)
      expect(getAttendanceCancellationExecutionPort()).toBeDefined()

      const lotId = await seedLiveAnnualLotWithLedger(attached!.orgId, fixture.requesterId, `wi13-inner-${suffix}`, {
        amountMinutes: 480,
        remainingMinutes: 420,
        deductMinutes: 120,
        requestId: attached!.requestId,
        priorReverseMinutes: 60,
      })

      // THE PRE-STATE the latch must see, measured rather than assumed: exactly one deduct and
      // exactly one prior reverse on this source_id, and 60 minutes of headroom on the lot.
      const preEvents = await pool().query<{ event_type: string; delta_minutes: number }>(
        `SELECT event_type, delta_minutes FROM attendance_leave_balance_events
          WHERE balance_id = $1::uuid AND source_id = $2 ORDER BY event_type`,
        [lotId, attached!.requestId],
      )
      expect(preEvents.rows).toEqual([
        { event_type: 'deduct', delta_minutes: -120 },
        { event_type: 'reverse', delta_minutes: 60 },
      ])

      const approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(approve.status, await approve.clone().text()).toBe(200)

      // The redemption REALLY RAN — otherwise every zero below would be the boring zero of a
      // cancellation that never happened, and the mutation would stay green.
      expect(await roundOutcome(fixture.roundInstanceId)).toMatchObject({ outcome: 'applied' })
      const cancelledRequest = await pool().query<{ status: string }>(
        `SELECT status FROM attendance_requests WHERE id = $1::uuid`,
        [attached!.requestId],
      )
      expect(cancelledRequest.rows[0]?.status).toBe('cancelled')

      // ── THE LATCH. Zero balance change and no second ledger row: the whole table for this lot is
      //    still the two rows seeded above.
      const post = await pool().query<{ remaining_minutes: number; status: string }>(
        `SELECT remaining_minutes, status FROM attendance_leave_balances WHERE id = $1::uuid`,
        [lotId],
      )
      expect(Number(post.rows[0].remaining_minutes)).toBe(420)
      expect(post.rows[0].status).toBe('active')
      const postEvents = await pool().query<{ event_type: string; delta_minutes: number }>(
        `SELECT event_type, delta_minutes FROM attendance_leave_balance_events
          WHERE balance_id = $1::uuid ORDER BY event_type`,
        [lotId],
      )
      expect(postEvents.rows).toEqual([
        { event_type: 'deduct', delta_minutes: -120 },
        { event_type: 'reverse', delta_minutes: 60 },
      ])

      // ── THE LATCH'S OWN ANSWER, on both carriers, pinned as whole objects. `alreadyReversed: true`
      //    is the value ONLY `:19425` can produce — the scan branch at `:19472` always answers
      //    `alreadyReversed: false` — so this is the field that says the inner gate, not the outer
      //    preflight, is what produced these zeros.
      const roundIdRow = await pool().query<{ id: string }>(
        `SELECT id FROM approval_rounds WHERE engine_instance_id = $1`,
        [fixture.roundInstanceId],
      )
      const sealed = await pool().query<{ state: string; response_snapshot: { data?: { reversal?: unknown } } }>(
        `SELECT state, response_snapshot FROM attendance_result_operations
          WHERE org_id = $1 AND operation_id = $2::uuid`,
        [attached!.orgId, deriveCancelRoundW4OperationIdV1(roundIdRow.rows[0].id)],
      )
      expect(sealed.rows.length).toBe(1)
      expect(sealed.rows[0].state).toBe('completed')
      expect(sealed.rows[0].response_snapshot.data?.reversal).toEqual({
        reversed: 0, lots: 0, unrecoverableExpired: 0, alreadyReversed: true,
      })

      const dto = (await approve.json()) as {
        cancellationOutcome?: { status?: string; reversal?: Record<string, unknown> }
      }
      expect(dto.cancellationOutcome?.reversal).toEqual({
        reversed: 0, lots: 0, unrecoverableExpired: 0, alreadyReversed: true,
      })
      // `unrecoverableExpired` is 0 here, so the classifier's token is the plain one — asserted so
      // a future classifier change cannot silently start reporting an already-reversed cancellation
      // as the expired-loss variant.
      expect(dto.cancellationOutcome?.status).toBe('cancelled')
    },
  )

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // OWNER RULING 2026-09-20 — the DURABLE READ half, as a PER-KEY-PATH WHITELIST.
  //
  //   「呈现默认值不能替代持久读取能力;修复应白名单投影业务字段,不能直接暴露整个 metadata。」
  //
  // WHAT THESE CASES ARE FOR, and why they are not redundant with the 呈现 cases above. The cases
  // above assert the IMMEDIATE half (the one action response) and the DB row. An independent
  // verification (`verify-c2-history-dto-cancellation-outcome-20260920.md`, real DB + real HTTP)
  // then measured that the durable row, though committed, was UNREADABLE for platform instances:
  //   - F-5: the requester's `GET /api/approvals/:id/history` returned the approve row with the
  //     `metadata` key ABSENT ENTIRELY (`"cancellationOutcome"` substring count: 0), because the
  //     DTO that carries `metadata` verbatim is only built inside the route's `plm:` branch and a
  //     cancel-round id is a bare UUID.
  //   - F-4: `expired` and `blocked` system closures were byte-identical on the wire — the two
  //     responses differed only in `id` and `occurred_at`.
  // Both halves are now closed by a WHITELIST, and these cases gate the whitelist's two duties at
  // once: the named business fields ARRIVE, and everything else in the same stored blob does NOT.
  //
  // POSITIVE CONTROL DISCIPLINE. Every 「key X must not appear」 assertion below is paired with a
  // DB read proving X IS in that row's stored `metadata` at the moment of the HTTP read. Without
  // it, an absence assertion would also pass against a row that never had the key — the
  // `0 === 0` shape this corpus keeps re-learning.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════

  /** The internal keys that live in the SAME `metadata` blob and must never cross to a client. */
  const FORBIDDEN_ON_THE_WIRE = [
    'secretKey',
    'MUST-NOT-APPEAR',
    'aggregateComplete',
    'nodeEntryEpoch',
  ] as const

  function expectNoForbiddenKeys(bodyText: string, where: string): void {
    for (const token of FORBIDDEN_ON_THE_WIRE) {
      expect(bodyText.includes(token), `${where}: forbidden token ${token} reached the wire`).toBe(false)
    }
  }

  /** The stored blob, read back so the absence assertions above are about a key that EXISTS. */
  async function readStoredMetadata(instanceId: string, action: string): Promise<Record<string, unknown>> {
    const row = await pool().query<{ metadata: Record<string, unknown> | null }>(
      `SELECT metadata FROM approval_records
        WHERE instance_id = $1 AND action = $2
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [instanceId, action],
    )
    expect(row.rows.length).toBe(1)
    return (row.rows[0].metadata ?? {}) as Record<string, unknown>
  }

  async function historyItems(instanceId: string, token: string): Promise<{
    text: string
    items: { action?: string; metadata?: Record<string, unknown> }[]
  }> {
    const response = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/history`, token)
    expect(response.status, await response.clone().text()).toBe(200)
    const text = await response.text()
    const parsed = JSON.parse(text) as { data?: { items?: { action?: string; metadata?: Record<string, unknown> }[] } }
    return { text, items: parsed.data?.items ?? [] }
  }

  async function detailDto(instanceId: string, token: string): Promise<{
    text: string
    dto: Record<string, unknown>
  }> {
    const response = await jsonRequest(baseUrl, `/api/approvals/${instanceId}`, token)
    expect(response.status, await response.clone().text()).toBe(200)
    const text = await response.text()
    return { text, dto: JSON.parse(text) as Record<string, unknown> }
  }

  it(
    'owner ruling 2026-09-20 (F-5): the REQUESTER reads the redeemed round\'s `cancellationOutcome` ' +
      'back from BOTH durable surfaces (`/history` and `GET /api/approvals/:id`) — whitelisted key ' +
      'paths only, with three planted non-whitelisted keys (top-level, nested in the outcome, and ' +
      'nested in `reversal`) proven present in the stored row and absent from both responses',
    async () => {
      const suffix = `projwl-${TS}`
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })

      const portStub = bindCancellationPort(async () => ({
        kind: 'executed',
        response: {
          ok: true,
          data: { reversal: { reversed: 360, lots: 1, unrecoverableExpired: 120, alreadyReversed: false } },
        },
      }))
      try {
        const approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(approve.status, await approve.clone().text()).toBe(200)
      } finally {
        portStub.stop()
      }

      // ── PLANT the non-whitelisted keys in three positions the SELECT list alone cannot all
      //    exclude: a bare `metadata->'cancellationOutcome'` projection would carry the two nested
      //    ones straight through. This is what makes the whitelist a REBUILD, not a key-path pick.
      const planted = await pool().query(
        `UPDATE approval_records
            SET metadata = jsonb_set(
                  jsonb_set(
                    metadata || jsonb_build_object('secretKey', 'MUST-NOT-APPEAR-TOP'),
                    '{cancellationOutcome,secretKey}', '"MUST-NOT-APPEAR-NESTED"'::jsonb, true),
                  '{cancellationOutcome,reversal,secretKey}', '"MUST-NOT-APPEAR-DEEP"'::jsonb, true)
          WHERE instance_id = $1 AND action = 'approve'`,
        [fixture.roundInstanceId],
      )
      expect(planted.rowCount).toBe(1)

      // 正控: the four forbidden tokens are genuinely IN the row right now.
      const stored = await readStoredMetadata(fixture.roundInstanceId, 'approve')
      expect(stored.secretKey).toBe('MUST-NOT-APPEAR-TOP')
      expect(stored.aggregateComplete).toBe(true)
      expect(stored.nodeEntryEpoch).toBe(1)
      const storedOutcome = stored.cancellationOutcome as Record<string, unknown>
      expect(storedOutcome.secretKey).toBe('MUST-NOT-APPEAR-NESTED')
      expect((storedOutcome.reversal as Record<string, unknown>).secretKey).toBe('MUST-NOT-APPEAR-DEEP')

      const expectedOutcome = {
        status: 'cancelled_with_unrecoverable_expired',
        reversal: { reversed: 360, lots: 1, unrecoverableExpired: 120, alreadyReversed: false },
      }
      // The byte form, pinned: key ORDER is the projector's construction order, not the stored
      // object's, so a future re-ordering of either is a visible change.
      const expectedBytes = '"cancellationOutcome":{"status":"cancelled_with_unrecoverable_expired",'
        + '"reversal":{"reversed":360,"lots":1,"unrecoverableExpired":120,"alreadyReversed":false}}'

      // ── SURFACE 1: `/history` as the REQUESTER (the person F-5 measured could not read this).
      const history = await historyItems(fixture.roundInstanceId, fixture.requesterToken)
      const approveItem = history.items.find((item) => item.action === 'approve')
      expect(approveItem, 'the approve audit row must still be in the timeline').toBeTruthy()
      // The WHOLE metadata object, not just its cancellationOutcome key — this is the assertion a
      // bare-`metadata` projection fails, because the row also holds nodeKey/approvalMode/…
      expect(approveItem!.metadata).toEqual({ cancellationOutcome: expectedOutcome })
      expect(history.text).toContain(expectedBytes)
      expectNoForbiddenKeys(history.text, 'history')
      // `nodeKey` exists on BOTH audit rows of this instance and appears nowhere in this response.
      expect(history.text.includes('"nodeKey"')).toBe(false)
      expect(history.text.includes('cancelRoundDocumentId')).toBe(false)

      // ── SURFACE 2: the REFRESH path. F-5's key-set measurement listed 23 keys, none of them this.
      const detail = await detailDto(fixture.roundInstanceId, fixture.requesterToken)
      expect(detail.dto.cancellationOutcome).toEqual(expectedOutcome)
      expect(detail.text).toContain(expectedBytes)
      expectNoForbiddenKeys(detail.text, 'detail')
      // A redeemed round has no system closure — the sibling whitelisted key must stay ABSENT
      // rather than arrive as null/empty.
      expect(Object.prototype.hasOwnProperty.call(detail.dto, 'cancelRoundCloseReason')).toBe(false)
    },
  )

  it(
    'owner ruling 2026-09-20 (F-5, attachment flag independence): the cancel-round whitelist is NOT ' +
      'gated on `APPROVAL_ATTACHMENTS_ENABLED` — with the SAME row carrying BOTH `attachmentIds` ' +
      'and `cancellationOutcome`, flag ON emits both keys and flag OFF emits only the outcome',
    async () => {
      const suffix = `projflag-${TS}`
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })

      const portStub = bindCancellationPort(async () => ({
        kind: 'executed',
        response: {
          ok: true,
          data: { reversal: { reversed: 5, lots: 2, unrecoverableExpired: 0, alreadyReversed: false } },
        },
      }))
      try {
        const approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(approve.status, await approve.clone().text()).toBe(200)
      } finally {
        portStub.stop()
      }

      // ⚠️ THE DISCRIMINATING SETUP (this is the lesson §3.2(v) of the verification MD paid for):
      // a fixture row with NO `attachmentIds` takes the same branch flag-ON and flag-OFF, so the
      // flag pair proves nothing. Both keys go on the SAME row so the two runs differ in ONE thing.
      const seeded = await pool().query(
        `UPDATE approval_records
            SET metadata = metadata || jsonb_build_object('attachmentIds', jsonb_build_array('proj-att-1'))
          WHERE instance_id = $1 AND action = 'approve'`,
        [fixture.roundInstanceId],
      )
      expect(seeded.rowCount).toBe(1)
      const stored = await readStoredMetadata(fixture.roundInstanceId, 'approve')
      expect(stored.attachmentIds).toEqual(['proj-att-1'])
      expect(stored.cancellationOutcome).toBeTruthy()

      const expectedOutcome = {
        status: 'cancelled',
        reversal: { reversed: 5, lots: 2, unrecoverableExpired: 0, alreadyReversed: false },
      }
      const previousFlag = process.env.APPROVAL_ATTACHMENTS_ENABLED
      try {
        process.env.APPROVAL_ATTACHMENTS_ENABLED = 'true'
        const on = await historyItems(fixture.roundInstanceId, fixture.requesterToken)
        const onItem = on.items.find((item) => item.action === 'approve')
        expect(onItem!.metadata).toEqual({
          cancellationOutcome: expectedOutcome,
          attachmentIds: ['proj-att-1'],
        })

        process.env.APPROVAL_ATTACHMENTS_ENABLED = 'false'
        const off = await historyItems(fixture.roundInstanceId, fixture.requesterToken)
        const offItem = off.items.find((item) => item.action === 'approve')
        expect(offItem!.metadata).toEqual({ cancellationOutcome: expectedOutcome })
        expect(off.text.includes('proj-att-1')).toBe(false)
      } finally {
        if (previousFlag === undefined) delete process.env.APPROVAL_ATTACHMENTS_ENABLED
        else process.env.APPROVAL_ATTACHMENTS_ENABLED = previousFlag
      }
    },
  )

  it(
    'owner ruling 2026-09-20 (F-4): `expired` and `blocked` system closures are DISTINGUISHABLE on ' +
      'the wire via the whitelisted `cancelRoundCloseReason`, on both surfaces — while the free-text ' +
      '`cancelRoundBlockDetail` beside it (proven present in the row) never crosses',
    async () => {
      // ── (a) window closed ⇒ `round_expired`
      const expiredSuffix = `projexp-${TS}`
      const expiredFixture = await seedPendingCancelRound(expiredSuffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 200)
      })
      const expiredApprove = await jsonRequest(
        baseUrl, `/api/approvals/${expiredFixture.roundInstanceId}/actions`, expiredFixture.approverToken,
        { method: 'POST', body: { action: 'approve' } },
      )
      expect(expiredApprove.status, await expiredApprove.clone().text()).toBe(200)

      // ── (b) business refusal ⇒ `business_blocked:<code>`
      const blockedSuffix = `projblk-${TS}`
      const blockedFixture = await seedPendingCancelRound(blockedSuffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        await attachAttendanceRequest(documentId, `wi13-req-${blockedSuffix}`)
      })
      const blockedStub = bindCancellationPort(async () => ({
        kind: 'business_refused',
        code: 'ATTENDANCE_CANCELLATION_REVIEW_REQUIRED',
        detail: 'frozen parent calculation missing',
      }))
      try {
        const blockedApprove = await jsonRequest(
          baseUrl, `/api/approvals/${blockedFixture.roundInstanceId}/actions`, blockedFixture.approverToken,
          { method: 'POST', body: { action: 'approve' } },
        )
        expect(blockedApprove.status, await blockedApprove.clone().text()).toBe(200)
      } finally {
        blockedStub.stop()
      }

      // 正控: the free text really is in the blocked row, beside the bounded token.
      const blockedStored = await readStoredMetadata(blockedFixture.roundInstanceId, 'reject')
      expect(blockedStored.cancelRoundBlockDetail).toBe('frozen parent calculation missing')
      expect(blockedStored.cancelRoundCloseReason).toBe('business_blocked:ATTENDANCE_CANCELLATION_REVIEW_REQUIRED')

      const expiredHistory = await historyItems(expiredFixture.roundInstanceId, expiredFixture.requesterToken)
      const blockedHistory = await historyItems(blockedFixture.roundInstanceId, blockedFixture.requesterToken)
      const expiredItem = expiredHistory.items.find((item) => item.action === 'reject')
      const blockedItem = blockedHistory.items.find((item) => item.action === 'reject')
      expect(expiredItem!.metadata).toEqual({ cancelRoundCloseReason: 'round_expired' })
      expect(blockedItem!.metadata).toEqual({
        cancelRoundCloseReason: 'business_blocked:ATTENDANCE_CANCELLATION_REVIEW_REQUIRED',
      })

      // THE F-4 ASSERTION ITSELF: each token appears on exactly one of the two, so the two
      // responses are no longer byte-identical modulo id/timestamp.
      expect(expiredHistory.text.includes('"cancelRoundCloseReason":"round_expired"')).toBe(true)
      expect(expiredHistory.text.includes('business_blocked')).toBe(false)
      expect(blockedHistory.text.includes('business_blocked:ATTENDANCE_CANCELLATION_REVIEW_REQUIRED')).toBe(true)
      expect(blockedHistory.text.includes('round_expired')).toBe(false)
      // The free-text cause stays behind on BOTH.
      expect(blockedHistory.text.includes('frozen parent calculation missing')).toBe(false)
      expect(blockedHistory.text.includes('cancelRoundBlockDetail')).toBe(false)
      expect(blockedHistory.text.includes('cancelRoundOutcome')).toBe(false)

      // Same two, on the REFRESH path.
      const expiredDetail = await detailDto(expiredFixture.roundInstanceId, expiredFixture.requesterToken)
      const blockedDetail = await detailDto(blockedFixture.roundInstanceId, blockedFixture.requesterToken)
      expect(expiredDetail.dto.cancelRoundCloseReason).toBe('round_expired')
      expect(blockedDetail.dto.cancelRoundCloseReason)
        .toBe('business_blocked:ATTENDANCE_CANCELLATION_REVIEW_REQUIRED')
      expect(blockedDetail.text.includes('frozen parent calculation missing')).toBe(false)
      // Neither closure redeemed anything, so the sibling key stays absent on both.
      expect(Object.prototype.hasOwnProperty.call(expiredDetail.dto, 'cancellationOutcome')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(blockedDetail.dto, 'cancellationOutcome')).toBe(false)
    },
  )

  it(
    'owner ruling 2026-09-20 (fence unchanged): a NON-PARTICIPANT still gets the values-free 404 on ' +
      'both surfaces — the new whitelist widened WHAT a participant reads, never WHO reads it',
    async () => {
      const suffix = `projfence-${TS}`
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 30)
        await setDocumentWindowDays(documentId, 90)
        await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })
      const portStub = bindCancellationPort(async () => ({
        kind: 'executed',
        response: {
          ok: true,
          data: { reversal: { reversed: 7, lots: 1, unrecoverableExpired: 3, alreadyReversed: false } },
        },
      }))
      try {
        const approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(approve.status, await approve.clone().text()).toBe(200)
      } finally {
        portStub.stop()
      }

      // 正控 (otherwise a 404 for a bad id would pass this case): the SAME instance, read by a
      // participant, does carry the values.
      const participant = await detailDto(fixture.roundInstanceId, fixture.requesterToken)
      expect((participant.dto.cancellationOutcome as { reversal?: { unrecoverableExpired?: number } })?.reversal?.unrecoverableExpired)
        .toBe(3)

      // A stranger: `users` row exists (so this is not an identity failure) but no requester seat,
      // no assignment, no audit row, no cc, `role = 'user'` — none of `canReadApprovalInstance`'s
      // five arms. RBAC_BYPASS is on in this harness, so the ONLY thing denying here is S1.
      const strangerToken = await authToken(baseUrl, `wi13-stranger-${suffix}`)
      const strangerHistory = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/history`, strangerToken)
      expect(strangerHistory.status).toBe(404)
      const strangerHistoryText = await strangerHistory.text()
      expect(JSON.parse(strangerHistoryText)).toEqual({
        ok: false,
        error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval instance not found' },
      })
      expect(strangerHistoryText.includes('cancellationOutcome')).toBe(false)
      expect(strangerHistoryText.includes('unrecoverableExpired')).toBe(false)

      const strangerDetail = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}`, strangerToken)
      expect(strangerDetail.status).toBe(404)
      const strangerDetailText = await strangerDetail.text()
      expect(strangerDetailText.includes('cancellationOutcome')).toBe(false)
      expect(strangerDetailText.includes('unrecoverableExpired')).toBe(false)
    },
  )

  it(
    'owner ruling 2026-09-20 (counterexample — the whitelist reports, it does not fabricate): a ' +
      'cancel round a HUMAN approver rejected carries NEITHER whitelisted key on either surface, ' +
      'while the system-closed sibling in the same run carries `cancelRoundCloseReason`',
    async () => {
      // WHY THIS CASE EXISTS. Every other case here asserts that a value ARRIVES. A projection that
      // emitted `round_expired` for any terminal cancel round would satisfy all of them — and would
      // be a fabricated answer on the one closure the lock says must stay distinguishable from a
      // system close (「系统终结身份(非真人 actor)与专用 reason 是区分『审批人驳回』的唯一依据」).
      // The two fixtures below run in the same file, on the same code path, differing ONLY in who
      // ended the round.
      const humanSuffix = `projhuman-${TS}`
      const human = await seedPendingCancelRound(humanSuffix)
      const humanReject = await jsonRequest(
        baseUrl, `/api/approvals/${human.roundInstanceId}/actions`, human.approverToken,
        { method: 'POST', body: { action: 'reject', comment: '不同意撤销' } },
      )
      expect(humanReject.status, await humanReject.clone().text()).toBe(200)

      // 正控: the round really is terminal and really is `rejected` — this is not an un-decided
      // round whose keys are absent because nothing happened yet.
      const humanRound = await roundOutcome(human.roundInstanceId)
      expect(humanRound.outcome).toBe('rejected')
      expect(humanRound.ended_at).not.toBeNull()
      // 正控 2: the human's reject row exists and carries NO close-reason key at all.
      const humanStored = await readStoredMetadata(human.roundInstanceId, 'reject')
      expect(Object.prototype.hasOwnProperty.call(humanStored, 'cancelRoundCloseReason')).toBe(false)

      const humanHistory = await historyItems(human.roundInstanceId, human.requesterToken)
      const humanRejectItem = humanHistory.items.find((item) => item.action === 'reject')
      expect(humanRejectItem, 'the human reject row must be in the timeline').toBeTruthy()
      expect(Object.prototype.hasOwnProperty.call(humanRejectItem!, 'metadata')).toBe(false)
      expect(humanHistory.text.includes('cancelRoundCloseReason')).toBe(false)
      expect(humanHistory.text.includes('round_expired')).toBe(false)

      const humanDetail = await detailDto(human.roundInstanceId, human.requesterToken)
      expect(Object.prototype.hasOwnProperty.call(humanDetail.dto, 'cancelRoundCloseReason')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(humanDetail.dto, 'cancellationOutcome')).toBe(false)

      // The discriminating half: a SYSTEM close in the same run does carry it, so the absence above
      // is a property of the human path and not of this file's plumbing.
      const systemSuffix = `projsys-${TS}`
      const system = await seedPendingCancelRound(systemSuffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 200)
      })
      const systemApprove = await jsonRequest(
        baseUrl, `/api/approvals/${system.roundInstanceId}/actions`, system.approverToken,
        { method: 'POST', body: { action: 'approve' } },
      )
      expect(systemApprove.status, await systemApprove.clone().text()).toBe(200)
      const systemDetail = await detailDto(system.roundInstanceId, system.requesterToken)
      expect(systemDetail.dto.cancelRoundCloseReason).toBe('round_expired')
    },
  )
})
