import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { type ApprovalActionRequest } from '../../src/types/approval-product'
import { eventBus } from '../../src/integration/events/event-bus'
import {
  deriveCancelRoundW4OperationIdV1,
  getAttendanceCancellationExecutionPort,
  registerAttendanceCancellationExecutionProvider,
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
 *     PERSISTED by the W4 seal (non-zero, measured); only the user-facing SURFACE is still open,
 *     and both cases assert its absence as a negative.
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
      'C-1 is invoked through the W4 external transaction entry with the round id as its ' +
      'operation id, the round row goes `applied` + `ended_at`, the instance goes `approved`, and ' +
      'EXACTLY ONE completion event is emitted (so 判据 IV/R2 zeros are measurements, not an ' +
      'inert channel)',
    async () => {
      const suffix = `iiok-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 200)
        // 365 > 200 — the window is OPEN, so the in-lock evaluation answers `redeem`.
        await setDocumentWindowDays(documentId, 365)
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
        await ageApprovedAnchor(documentId, 200)
        // 365 > 200 — the window is OPEN, so the in-lock evaluation answers `redeem` and the
        // `approve` half below reaches the redemption rather than the #5′ system close.
        await setDocumentWindowDays(documentId, 365)
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
        // ⚠️ This is the line that carries the mutation (phase-2 MD §3.17, M-25). Its failure
        // message prints the body, so a red NAMES the door that refused — under M-25 it reads
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
      'FIRST post-redeem statement, which is what makes the clause carry its own mutation (M-26) ' +
      'instead of dying behind 判据 II\'s end-state check',
    async () => {
      const suffix = `i3c2-${TS}`
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 200)
        // 365 > 200 — the window is OPEN, so the in-lock evaluation answers `redeem`.
        await setDocumentWindowDays(documentId, 365)
        await attachAttendanceRequest(documentId, `wi13-req-${suffix}`)
      })

      const portStub = bindCancellationPort(async () => ({ kind: 'executed', response: { ok: true } }))
      try {
        const approve = await jsonRequest(baseUrl, `/api/approvals/${fixture.roundInstanceId}/actions`, fixture.approverToken, {
          method: 'POST',
          body: { action: 'approve' },
        })
        expect(approve.status, await approve.clone().text()).toBe(200)
      } finally {
        portStub.stop()
      }
      expect(portStub.calls.length).toBe(1)

      // ── THE I3 CLAUSE, FIRST. Under M-26 the round row stays `pending`, this line throws
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
        await ageApprovedAnchor(documentId, 200)
        await setDocumentWindowDays(documentId, 365)
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
        await ageApprovedAnchor(documentId, 200)
        await setDocumentWindowDays(documentId, 365)
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
        await ageApprovedAnchor(documentId, 200)
        await setDocumentWindowDays(documentId, 365)
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
        await ageApprovedAnchor(documentId, 200)
        await setDocumentWindowDays(documentId, 365)
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
   *   (b) **the approval side's RETURN VALUE has no channel for it.** `redeemCancelRoundInTxn`
   *       receives `{ kind: 'executed', response }` from the entry and returns `{ kind: 'applied' }`
   *       — the W4 response payload, `reversal` and all, is DISCARDED on that path.
   *       ⛔ The stronger form of this sentence — 「the approval side has no channel to present it
   *       on AT ALL」 — is RETRACTED: the W4 seal writes the same object into
   *       `attendance_result_operations.response_snapshot` on the caller's own transaction client,
   *       so it IS persisted and queryable. What is still open is only which USER-FACING surface
   *       renders it, which is why the DTO negative at the bottom of this case stands.
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
        await ageApprovedAnchor(documentId, 200)
        await setDocumentWindowDays(documentId, 365)
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
      await ageApprovedAnchor(documentB, 200)
      await setDocumentWindowDays(documentB, 365)
      const attachedB = await attachAttendanceRequest(documentB, requesterB)
      await seedDirectoryIdentity(requesterB, attachedB.orgId)

      // Both fixtures must sit in the SAME org, or every org-scoped column below would diverge for
      // a reason the twin construction did not intend. Asserted rather than assumed.
      expect(attachedA!.orgId).toBe(attachedB.orgId)

      // ── Drive A: approve the cancel round. ──────────────────────────────────────────────────
      const approveA = await jsonRequest(baseUrl, `/api/approvals/${a.roundInstanceId}/actions`, a.approverToken, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(approveA.status, await approveA.clone().text()).toBe(200)

      // ── Drive B: the existing W4 path, as a user walks it. ──────────────────────────────────
      const cancelB = await jsonRequest(baseUrl, `/api/attendance/requests/${attachedB.requestId}/cancel`, requesterTokenB, {
        method: 'POST',
        body: {},
      })
      expect(cancelB.status, await cancelB.clone().text()).toBe(200)

      // ── The W4 RESULT PAYLOAD, pinned. This is 「完整取消结果」 as the existing path returns it.
      //    `redeemCancelRoundInTxn` returns `{ kind: 'applied' }` and drops
      //    `{ kind: 'executed', response }`, so the redemption path has no RETURN-VALUE counterpart
      //    to compare against. ⚠️ It does have a PERSISTED one — the W4 seal writes the same object
      //    into `attendance_result_operations.response_snapshot` — which is what the LAST case in
      //    this file measures, and which narrows finding (b) of the doc comment above.
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

      // ── The 呈现 GAP, ASSERTED. The approval side exposes no field carrying the W4 result
      //    payload: the redeemed round's DTO is an ordinary `UnifiedApprovalDTO`. Measured as a
      //    negative so that the day a channel IS added, this line goes red and the MD's OPEN item
      //    must be revisited rather than quietly staying open.
      const dtoA = (await approveA.json()) as Record<string, unknown>
      expect(Object.keys(dtoA)).not.toContain('reversal')
      expect(Object.keys(dtoA)).not.toContain('cancellationResult')
      expect(JSON.stringify(dtoA)).not.toContain('unrecoverableExpired')
    },
  )

  /**
   * ── `unrecoverableExpired` 呈现 (lock:86) — the half that IS closable, and a CLAIM RETRACTED ──
   *
   * lock:86 states C-1's step ⑥ as 「`reverseLeaveBalanceDeduction`(返回 `unrecoverableExpired`,
   * **必须呈现**)」. The 账侧 parity case above asserts the approval-side DTO carries NO channel
   * for it and phase-2 MD §3.15.6 called the whole item a CONTRACT GAP on the ground that
   * 「the approval side has no channel to present it on **at all**」.
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
   * make, still asserted as a negative at the end of this case.
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
   *   - 呈现 on a user-facing surface. Registered as an owner decision (phase-2 MD §3.15.6);
   *     the negative at the bottom of this case goes red the day one is added.
   *   - The LIVE-lot reversal half (`reversed > 0`, a `reverse` event, `remaining_minutes`
   *     restored). That is a different branch of the same helper and is not what lock:86's
   *     「必须呈现」 names; it is left to the attendance line's own `reverseLeaveBalanceDeduction`
   *     unit tests (`tests/unit/attendance-leave-cancellation-reversal.test.ts`), which cover it.
   */
  it(
    'unrecoverableExpired 呈现 (lock:86): an EXPIRED lot makes the counter NON-ZERO on the ' +
      'redemption path and the W4 seal persists it in `attendance_result_operations.' +
      'response_snapshot` — while the approval DTO still carries no channel for it',
    async () => {
      const suffix = `uexp-${TS}`
      let attached: { requestId: string; orgId: string } | undefined
      const fixture = await seedPendingCancelRound(suffix, async (documentId) => {
        await ageApprovedAnchor(documentId, 200)
        await setDocumentWindowDays(documentId, 365)
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

      // ── The 呈现 SURFACE is still open, asserted as a negative (same shape as the 账侧 case).
      //    This is the ONLY half of lock:86 this branch leaves open, and it is an owner decision:
      //    the payload exists and is persisted; where a human reads it is not this file's call.
      const dto = (await approve.json()) as Record<string, unknown>
      expect(JSON.stringify(dto)).not.toContain('unrecoverableExpired')
      expect(JSON.stringify(dto)).not.toContain('reversal')
    },
  )
})
