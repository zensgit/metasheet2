import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor, ensureLocalUserRow } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { ApprovalMetricsService } from '../../src/services/ApprovalMetricsService'
import { isCancelRoundInstance } from '../../src/attendance/w4c3b-central-approval-hooks'

/**
 * Approval change-request design lock v5.9 §14.3 outlet #3 (`applyNodeTimeoutEffect`, `:9244`
 * area; taskbook names this the ONE outlet deliberately split into its own slice from
 * `approval-cancel-round-outlet-guards.db.test.ts`, whose own docblock says so explicitly) —
 * real-DB acceptance.
 *
 * Outlet #3 is the ODD ONE OUT among the §14.3 census: every other chokepoint shares
 * `rejectIfCancelRound` and THROWS `CancelRoundOutletForbiddenError`. #3 shares only the identity
 * predicate `isCancelRoundInstance` — its contract is a RETURNED scanner outcome, not a rejected
 * promise, because the node-timeout scanner (`ApprovalSlaScheduler` → `ApprovalMetricsService
 * .scanNodeTimeouts`) is a background loop with no caller to reject to.
 *
 * Lock text, verbatim on the two-part oracle (lock §14.3 row #3): "在 :9244 前对 cancel 轮返回
 * outcome `skipped_cancel_round` … 且用既有 `consumeAndSkip`（`:9202-9209`，写
 * `current_node_deadline_at = NULL`；扫描器 `ApprovalMetricsService.ts:484-486` 只选
 * `IS NOT NULL`）消费 deadline —— 这是判据不是括号：负控 = 只 `return 'skipped_cancel_round'`
 * 不消费 deadline ⇒ 该实例在下一轮扫描再次被拾起（断言扫描两轮命中同一实例），红".
 *
 * So every cancel-round assertion below checks BOTH halves — never one alone:
 *   (a) the outcome literal is `'skipped_cancel_round'`, AND
 *   (b) `approval_metrics.current_node_deadline_at` / `current_node_timeout_effect` are actually
 *       NULLed (the SAME consumption the ordinary transfer/jump path uses), proven by re-running
 *       the REAL production scan predicate (`ApprovalMetricsService.scanNodeTimeouts`, not a
 *       hand-rolled reimplementation of its WHERE clause) and observing the instance drop OUT of
 *       the due-set on the second round — the literal "两轮扫描命中同一实例" negative-control
 *       shape the lock names, constructed for real rather than argued as "cannot be constructed".
 *
 * A separate real source-mutation pass (cp backup → patch the branch below to skip WITHOUT
 * consuming → rerun this file → restore, evidenced in the verification MD) proves the negative
 * control actually goes red under the lock's own named regression.
 *
 * The lock's negative-control CELL for this row also names a second construction: "开旗标
 * （`:731-733` 调用时读 env）+ 去 skip ⇒ 写 approved，红". That construction is
 * UNCONSTRUCTIBLE against a real cancel-round instance, recorded here rather than silently
 * substituted: the round's own seed graph carries NO node `timeout` config at all —
 * `grep -n "timeout" src/db/seeds/approval-cancel-round-published-definition.ts` → 0 hits — so
 * `nodeTimeoutForKey(runtimeGraph, currentNodeKey)` can never match, and a de-skipped
 * cancel-round instance would fall through to `skipped_invalid_config`/`skipped_stale`, never
 * `approved`, with or without the flag. The "env flag inert" test below flips
 * `APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS` ON and re-asserts `skipped_cancel_round` — this shows
 * only that the OUTCOME is unaffected by the flag's state, NOT that `isCancelRoundInstance`
 * wins BECAUSE it is checked first: the terminal-effects branch is unreached here for the
 * unrelated reason above (no timeout config to match), so the test cannot discriminate "checked
 * before the gate" from "the gate is never reached in this graph shape". Do not read it as
 * discharging that lock cell.
 *
 * Not covered here (covered in `approval-cancel-round-outlet-guards.db.test.ts`): outlets
 * #2/#4/#6/#7/#7′/#8, which all throw the shared `CancelRoundOutletForbiddenError`.
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

/**
 * Ordinary single-node graph carrying a `transfer` timeout config — the SAME-METHOD positive
 * control this corpus's convention requires alongside every cancel-round negative construct (see
 * `approval-cancel-round-outlet-guards.db.test.ts`'s own docblock on this).
 */
function oneNodeGraphWithTransferTimeout(approverId: string, transferToUserId: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_a',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: [approverId],
          approvalMode: 'single',
          timeout: { afterMinutes: 60, effect: 'transfer', transferToUserId },
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-end', source: 'approval_a', target: 'end' },
    ],
  }
}

describeIfDatabase('cancel-round outlet guard §14.3 #3 (applyNodeTimeoutEffect): a cancel-round instance is never advanced by the node-timeout scanner, and the armed deadline is truly consumed (not merely skipped)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const createdRoundIds = new Set<string>()
  const grantedUserIds = new Set<string>()

  const pool = () => poolManager.get()

  function rawQuery<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> {
    return pool().query<T>(sql, params) as unknown as Promise<{ rows: T[] }>
  }

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

  async function publishTemplate(adminToken: string, graph: unknown, label: string): Promise<string> {
    const templateKey = `wi-nte-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'node-timeout-effect cancel-round fixture',
        description: 'approval-cancel-round-node-timeout-effect.db.test.ts',
        formSchema: buildFormSchema(),
        approvalGraph: graph,
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

  async function createPendingInstance(requesterToken: string, templateId: string): Promise<string> {
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

  /**
   * Arm an overdue node-timeout deadline directly on `approval_metrics` — mirrors the sibling
   * `approval-node-timeout-effects.test.ts`'s own `forceDeadlineOverdue` (same race the comment
   * there documents: the decision/activation metrics writes are two concurrent unawaited
   * best-effort calls, so this waits for the row to settle before stamping it overdue).
   */
  async function forceDeadlineOverdue(instanceId: string, effect: 'transfer' | 'jump'): Promise<void> {
    let prev = ''
    let stable = 0
    for (let attempt = 0; attempt < 60 && stable < 3; attempt++) {
      const row = await rawQuery<{ current_node_deadline_at: unknown; current_node_timeout_effect: string | null }>(
        `SELECT current_node_deadline_at, current_node_timeout_effect FROM approval_metrics WHERE instance_id = $1`,
        [instanceId],
      )
      const sig = `${row.rows[0]?.current_node_timeout_effect ?? 'null'}|${row.rows[0]?.current_node_deadline_at ? 'set' : 'null'}`
      stable = sig === prev ? stable + 1 : 0
      prev = sig
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(stable).toBeGreaterThanOrEqual(3)
    const updated = await rawQuery(
      `UPDATE approval_metrics
         SET current_node_deadline_at = now() - INTERVAL '1 minute',
             current_node_timeout_effect = $2
       WHERE instance_id = $1
       RETURNING instance_id`,
      [instanceId, effect],
    )
    expect(updated.rows).toHaveLength(1)
  }

  /**
   * `createCancelRoundInstance` never inserts an `approval_metrics` row for the round: read the
   * FULL method body start (`:8308`-area) to its `return approval` (past `COMMIT`,
   * `projectApprovalOnCreate`, `emitApprovalTaskCreatedEventsPostCommit`, `getApproval`) — zero
   * hits for `recordInstanceStart`/`approval_metrics` inside it
   * (`grep -n "recordInstanceStart\|approval_metrics" src/services/ApprovalProductService.ts`
   * finds them only inside `createApproval`, the ORDINARY path, and inside
   * `applyNodeTimeoutEffect` itself — never between `createCancelRoundInstance`'s own `BEGIN`
   * and its post-commit calls). The cancel round's own seed graph also carries no node `timeout`
   * config (`grep -n "timeout" src/db/seeds/approval-cancel-round-published-definition.ts` → 0
   * hits). So in production the scanner's `WHERE current_node_deadline_at IS NOT NULL` predicate
   * can never even SELECT a cancel-round instance; outlet #3's `isCancelRoundInstance` branch is
   * pure defense-in-depth against a future seed/activation-logic change, not a reachable-today
   * path. (The three readers the lock names as needing byte-identical behavior — detail GET,
   * pending-count projection, `canDecideCurrentNode` — are unaffected: none of them read
   * `approval_metrics`, per the same grep. The instance IS invisible to the separate
   * SLA-breach/node-timeout-reminder dashboards that DO read `approval_metrics`
   * (`ApprovalSlaScheduler.ts`, `ApprovalBreachNotifier.ts`) — not a lock-named reader, flagged
   * here rather than silently absorbed.) Arming it for this test therefore has to CREATE the row
   * (via the real production `recordInstanceStart`, `ON CONFLICT (instance_id) DO NOTHING` —
   * ordinary `UPDATE` finds zero rows here, unlike `forceDeadlineOverdue` above for a real
   * graph-driven instance).
   */
  async function armCancelRoundDeadline(instanceId: string, effect: 'transfer' | 'jump'): Promise<void> {
    const metrics = new ApprovalMetricsService(rawQuery)
    await metrics.recordInstanceStart({
      instanceId,
      templateId: null,
      startedAt: new Date(),
      timeoutDeadline: new Date(Date.now() - 60_000),
      timeoutEffect: effect,
    })
    const row = await rawQuery<{ current_node_deadline_at: unknown; current_node_timeout_effect: string | null }>(
      `SELECT current_node_deadline_at, current_node_timeout_effect FROM approval_metrics WHERE instance_id = $1`,
      [instanceId],
    )
    expect(row.rows[0]?.current_node_deadline_at).not.toBeNull()
    expect(row.rows[0]?.current_node_timeout_effect).toBe(effect)
  }

  it('positive control (same method, ordinary instance): an armed transfer timeout on a NON-cancel-round instance is actually applied — outlet #3 is not a blanket disable', async () => {
    const suffix = `pos-${TS}`
    const approverId = `wi-nte-pos-apr-${suffix}`
    const requesterId = `wi-nte-pos-req-${suffix}`
    const transferTargetId = `wi-nte-pos-target-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, `wi-nte-pos-admin-${suffix}`)
    const requesterToken = await authToken(baseUrl, requesterId)

    const templateId = await publishTemplate(adminToken, oneNodeGraphWithTransferTimeout(approverId, transferTargetId), 'pos')
    const instanceId = await createPendingInstance(requesterToken, templateId)
    await forceDeadlineOverdue(instanceId, 'transfer')

    const service = new ApprovalProductService()
    const outcome = await service.applyNodeTimeoutEffect(instanceId, 'transfer')
    expect(outcome).toBe('applied')

    const assignees = await pool().query<{ assignee_id: string; is_active: boolean }>(
      `SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1`,
      [instanceId],
    )
    expect(assignees.rows.filter((r) => r.is_active).map((r) => r.assignee_id)).toEqual([transferTargetId])
  })

  it('#3 two-part oracle (transfer): outcome literal skipped_cancel_round AND deadline actually consumed — proven by the REAL scanner predicate dropping the instance on round 2', async () => {
    const suffix = `t-${TS}`
    const approverId = `wi-nte-apr-${suffix}`
    const requesterId = `wi-nte-req-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, `wi-nte-admin-${suffix}`)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    const templateId = await publishTemplate(adminToken, oneNodeGraph(approverId), 't')
    const documentId = await createPendingInstance(requesterToken, templateId)
    await approve(approverToken, documentId)
    const cancelRoundId = await createCancelRound(requesterId, documentId)

    // The cancel round's own definition carries no node timeout config — arm the deadline
    // directly, exactly as the scanner would find it if some future change ever attached one.
    await armCancelRoundDeadline(cancelRoundId, 'transfer')

    const metrics = new ApprovalMetricsService(rawQuery)
    // ROUND 1 of the REAL production scan predicate: the instance IS due before the effect runs.
    const dueBefore = await metrics.scanNodeTimeouts(new Date())
    expect(dueBefore.some((r) => r.instanceId === cancelRoundId)).toBe(true)

    const service = new ApprovalProductService()
    const outcome = await service.applyNodeTimeoutEffect(cancelRoundId, 'transfer')
    expect(outcome).toBe('skipped_cancel_round')

    // Half (a): the outcome literal.
    // Half (b): the SAME consumption the ordinary transfer/jump path uses — both columns NULLed.
    const armed = await pool().query<{ current_node_deadline_at: unknown; current_node_timeout_effect: string | null }>(
      `SELECT current_node_deadline_at, current_node_timeout_effect FROM approval_metrics WHERE instance_id = $1`,
      [cancelRoundId],
    )
    expect(armed.rows[0]?.current_node_deadline_at).toBeNull()
    expect(armed.rows[0]?.current_node_timeout_effect).toBeNull()

    // ROUND 2 of the REAL production scan predicate: the negative control the lock names
    // verbatim ("负控 = 只 return … 不消费 deadline ⇒ 该实例在下一轮扫描再次被拾起（断言扫描
    // 两轮命中同一实例），红") — constructed for real: the SAME instance must have dropped OUT
    // of the due-set, not merely be asserted absent by construction.
    const dueAfter = await metrics.scanNodeTimeouts(new Date())
    expect(dueAfter.some((r) => r.instanceId === cancelRoundId)).toBe(false)

    // Single-shot from the effect method's own point of view too: a second call finds nothing
    // armed to skip — it must NOT repeat 'skipped_cancel_round' (that would mean round 1 never
    // truly consumed anything).
    const secondOutcome = await service.applyNodeTimeoutEffect(cancelRoundId, 'transfer')
    expect(secondOutcome).toBe('skipped_stale')

    // Zero state mutation throughout: still pending, no transfer/jump record ever written.
    const instanceRow = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      cancelRoundId,
    ])
    expect(instanceRow.rows[0]?.status).toBe('pending')
    const records = await pool().query<{ action: string }>(
      `SELECT action FROM approval_records WHERE instance_id = $1 AND action IN ('transfer', 'jump')`,
      [cancelRoundId],
    )
    expect(records.rows).toHaveLength(0)
  })

  it('#3 two-part oracle (jump): the same outcome+consumption pair holds for the OTHER scanned effect', async () => {
    const suffix = `j-${TS}`
    const approverId = `wi-nte-japr-${suffix}`
    const requesterId = `wi-nte-jreq-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, `wi-nte-jadmin-${suffix}`)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    const templateId = await publishTemplate(adminToken, oneNodeGraph(approverId), 'j')
    const documentId = await createPendingInstance(requesterToken, templateId)
    await approve(approverToken, documentId)
    const cancelRoundId = await createCancelRound(requesterId, documentId)

    await armCancelRoundDeadline(cancelRoundId, 'jump')

    const service = new ApprovalProductService()
    const outcome = await service.applyNodeTimeoutEffect(cancelRoundId, 'jump')
    expect(outcome).toBe('skipped_cancel_round')

    const armed = await pool().query<{ current_node_deadline_at: unknown; current_node_timeout_effect: string | null }>(
      `SELECT current_node_deadline_at, current_node_timeout_effect FROM approval_metrics WHERE instance_id = $1`,
      [cancelRoundId],
    )
    expect(armed.rows[0]?.current_node_deadline_at).toBeNull()
    expect(armed.rows[0]?.current_node_timeout_effect).toBeNull()

    const secondOutcome = await service.applyNodeTimeoutEffect(cancelRoundId, 'jump')
    expect(secondOutcome).toBe('skipped_stale')
  })

  it('env flag inert: with APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS flipped ON, the outcome for a cancel-round instance is unchanged — NOT proof isCancelRoundInstance is checked before the terminal-effects gate (see file header: the gate is unreached here for an unrelated reason — the round graph has no timeout config)', async () => {
    const suffix = `env-${TS}`
    const approverId = `wi-nte-envapr-${suffix}`
    const requesterId = `wi-nte-envreq-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, `wi-nte-envadmin-${suffix}`)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    const templateId = await publishTemplate(adminToken, oneNodeGraph(approverId), 'env')
    const documentId = await createPendingInstance(requesterToken, templateId)
    await approve(approverToken, documentId)
    const cancelRoundId = await createCancelRound(requesterId, documentId)

    await armCancelRoundDeadline(cancelRoundId, 'jump')

    const originalFlag = process.env.APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS
    process.env.APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS = 'true'
    try {
      const service = new ApprovalProductService()
      const outcome = await service.applyNodeTimeoutEffect(cancelRoundId, 'jump')
      expect(outcome).toBe('skipped_cancel_round')

      const instanceRow = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
        cancelRoundId,
      ])
      expect(instanceRow.rows[0]?.status).toBe('pending')
    } finally {
      if (originalFlag === undefined) delete process.env.APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS
      else process.env.APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS = originalFlag
    }
  })
})
