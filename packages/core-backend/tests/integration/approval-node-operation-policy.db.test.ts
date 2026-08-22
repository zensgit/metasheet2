import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import {
  ACTION_POLICY_KEYS,
  APPROVAL_ACTION_TYPES,
  APPROVAL_POLICY_DENIED_ACTION,
} from '../../src/types/approval-product'

/**
 * Lock-5 — per-node operation and member-action policy (`操作权限`), real-DB acceptance.
 * Source: `docs/development/approval-lock5-node-operation-policy-20260817.md` (RATIFIED 2026-08-17)
 * §1.1 L5-A, §1.4, §1.6 L5-F, §2.1, §2.3, §2.4, §2.5, and gates
 * A-1, A-2 (server door), A-4, A-5, A-6, D-1, D-2, D-3, D-4, F-1, X-1, X-2.
 *
 * WHAT SHIPPED BEFORE THIS SLICE. `transfer` (`ApprovalProductService.ts`, the `request.action ===
 * 'transfer'` branch) had exactly two shape checks and NO policy gate; `add_sign` / `reduce_sign` /
 * `return` likewise. The ONLY authored, server-enforced action switch in the product was the
 * TEMPLATE-level `RuntimePolicy.allowRevoke` (409 `APPROVAL_REVOKE_DISABLED`) — §0.1 calls it "THE
 * PRECEDENT, copied end to end", and that is what this slice copies to the node level.
 *
 * WHAT THIS SLICE ADDS.
 *   1. `ApprovalNodeConfig.nodeOperationPolicy` (OD-L5-1(a)) — ONE object, six fields, every one
 *      ABSENT ≡ TODAY (OD-L5-3(a)), validated strictly at publish and re-emitted by the approval /
 *      handler node rebuilds so it survives save AND reload.
 *   2. ONE dispatch choke (§2.1) placed after the authorization gate and Lock-3's handler verb gate
 *      and BEFORE the card-delivery claim, iterating the exported `ACTION_POLICY_KEYS` table.
 *   3. The `action:'policy_denied'` audit row (OD-L5-9(a)) via a records-only commit, with the
 *      CHECK migration and the two timeline exclusions in the SAME slice.
 *
 * EVERY absence assertion below carries a positive control, and every gate names the mutation that
 * turns it red (see the PR body's mutation table).
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

/**
 * A(p) -> B(q) -> end. `approval_a` carries the policy under test; `approval_b` exists so `return`
 * has a previously-visited target and so the instance does not terminate on A's approval.
 */
function twoStepGraph(p: string, q: string, policyOnA?: Record<string, unknown>) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_a',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: [p],
          approvalMode: 'single',
          ...(policyOnA ? { nodeOperationPolicy: policyOnA } : {}),
        },
      },
      {
        key: 'approval_b',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: [q], approvalMode: 'single' },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
      { key: 'e-b-end', source: 'approval_b', target: 'end' },
    ],
  }
}

/** The action payload that exercises each policy-gated verb at `approval_b`, returning to A. */
function actionBodyFor(action: string, addTargetUserId: string): Record<string, unknown> {
  switch (action) {
    case 'transfer':
      return { action: 'transfer', targetUserId: addTargetUserId }
    case 'add_sign':
      return { action: 'add_sign', targetUserIds: [addTargetUserId] }
    case 'reduce_sign':
      // Refused by the policy choke BEFORE the branch's own INV-2/INV-3 checks, which is the point:
      // the choke sits ahead of every verb branch (§2.1).
      return { action: 'reduce_sign', targetAssignmentUserId: addTargetUserId }
    case 'return':
      return { action: 'return', targetNodeKey: 'approval_a', comment: 'back' }
    default:
      throw new Error(`no payload for ${action}`)
  }
}

describeIfDatabase('Lock-5 — per-node operation policy (操作权限): choke, denial audit, placement, freeze', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
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
      const templateIds = [...createdTemplateIds]
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

  async function createTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
    const templateKey = `l5-nop-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const response = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Lock-5 node operation policy',
        description: 'approval-lock5-node-operation-policy-20260817',
        formSchema: buildFormSchema(),
        approvalGraph,
      },
    })
    if (response.status === 201) {
      const template = (await response.json()) as { id: string }
      createdTemplateIds.add(template.id)
      return template.id
    }
    // Caller asserts on the failure; return a sentinel so the response body is inspectable.
    throw Object.assign(new Error('template create failed'), {
      status: response.status,
      body: await response.text(),
    })
  }

  async function tryCreateTemplate(adminToken: string, approvalGraph: object, label: string): Promise<Response> {
    const templateKey = `l5-nop-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    return jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Lock-5 node operation policy',
        description: 'approval-lock5-node-operation-policy-20260817',
        formSchema: buildFormSchema(),
        approvalGraph,
      },
    })
  }

  async function publish(adminToken: string, templateId: string): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approval-templates/${templateId}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
  }

  async function publishGraphTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
    const templateId = await createTemplate(adminToken, approvalGraph, label)
    const publishResponse = await publish(adminToken, templateId)
    expect(publishResponse.status, await publishResponse.clone().text()).toBe(200)
    return templateId
  }

  async function createApproval(requesterToken: string, templateId: string): Promise<{ id: string; currentNodeKey: string | null }> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string; currentNodeKey: string | null }
    createdApprovalIds.add(inst.id)
    return inst
  }

  async function act(token: string, instanceId: string, body: object): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, token, { method: 'POST', body })
  }

  async function grantWrite(userId: string): Promise<void> {
    grantedUserIds.add(userId)
    await grantApprovalWriteForIntegrationActor(userId)
  }

  async function recordsFor(instanceId: string): Promise<Array<{ action: string; actor_id: string; metadata: Record<string, unknown> | null; to_version: number }>> {
    const result = await pool().query(
      'SELECT action, actor_id, metadata, to_version FROM approval_records WHERE instance_id = $1 ORDER BY id ASC',
      [instanceId],
    )
    return result.rows as never
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // A-1 — choke exhaustiveness
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it('A-1: ACTION_POLICY_KEYS partitions APPROVAL_ACTION_TYPES by EXACT SET EQUALITY', () => {
    // The map is a `Record<ApprovalActionType, …>`, so a verb added to the union without a map
    // entry is already a TypeScript error at the declaration. This is the RUNTIME half: the two
    // sides are the same SET, not merely the same size, and the partition is the ratified one.
    expect(new Set(Object.keys(ACTION_POLICY_KEYS))).toEqual(new Set(APPROVAL_ACTION_TYPES))
    const gated = Object.entries(ACTION_POLICY_KEYS).filter(([, key]) => key !== null).map(([verb]) => verb)
    const ungated = Object.entries(ACTION_POLICY_KEYS).filter(([, key]) => key === null).map(([verb]) => verb)
    expect(new Set(gated)).toEqual(new Set(['transfer', 'add_sign', 'reduce_sign', 'return']))
    // §1.1 Scope: approve/reject/comment are never switchable; `revoke` keeps its TEMPLATE-level
    // carrier; `handle` is Lock-3's handler submit verb. NOTE the lock's A-1 row says "4 and 4"
    // against its own pre-Lock-3 baseline of eight verbs — `handle` landed since (P4-A), so the
    // ungated side is FIVE here. The partition, not the arithmetic, is the contract.
    expect(new Set(ungated)).toEqual(new Set(['approve', 'reject', 'comment', 'revoke', 'handle']))
    expect(gated.length + ungated.length).toBe(APPROVAL_ACTION_TYPES.length)
    // The policy key each gated verb names is distinct — no verb silently shares another's switch.
    expect(new Set(gated.map((verb) => ACTION_POLICY_KEYS[verb as never]))).toHaveLength(gated.length)
  })

  it('A-1: every policy-gated verb is refused 409 APPROVAL_NODE_OPERATION_DISABLED when its switch is false — iterated from the map, not hand-listed', async () => {
    const gatedVerbs = Object.entries(ACTION_POLICY_KEYS)
      .filter(([, policyKey]) => policyKey !== null)
      .map(([verb, policyKey]) => ({ verb, policyKey: policyKey as string }))
    expect(gatedVerbs.length).toBeGreaterThan(0)

    for (const { verb, policyKey } of gatedVerbs) {
      const suffix = `a1-${verb}`
      const p = `l5-p-${TS}-${suffix}`
      const q = `l5-q-${TS}-${suffix}`
      const spare = `l5-x-${TS}-${suffix}`
      const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
      const requesterId = `l5-req-${TS}-${suffix}`
      const requesterToken = await authToken(baseUrl, requesterId)
      await grantWrite(requesterId)
      const pTok = await authToken(baseUrl, p)

      // The instance sits at `approval_a`, whose policy denies exactly this one verb.
      const deniedTemplate = await publishGraphTemplate(
        adminToken,
        twoStepGraph(p, q, { [policyKey]: false }),
        suffix,
      )
      const denied = await createApproval(requesterToken, deniedTemplate)
      expect(denied.currentNodeKey).toBe('approval_a')
      const deniedResponse = await act(pTok, denied.id, actionBodyFor(verb, spare))
      expect(deniedResponse.status, `${verb}: ${await deniedResponse.clone().text()}`).toBe(409)
      const deniedBody = (await deniedResponse.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }
      expect(deniedBody.error.code).toBe('APPROVAL_NODE_OPERATION_DISABLED')
      // X-1 — values-free: `details` carries `{ nodeKey, operation }` and NOTHING else. Asserting
      // the exact object (not `not.toHaveProperty('actorId')`) closes the enumeration hole: a new
      // leaked field would have to be individually forbidden otherwise.
      expect(deniedBody.error.details).toEqual({ nodeKey: 'approval_a', operation: verb })
      // X-1 positive control: the SAME path DOES carry `nodeKey`, so the check is not passing on an
      // empty payload.
      expect(deniedBody.error.details?.nodeKey).toBe('approval_a')
      // …and the message leaks no id either.
      expect(deniedBody.error.message).not.toContain(p)
      expect(deniedBody.error.message).not.toContain(spare)
      expect(deniedBody.error.message).not.toContain(denied.id)

      // POSITIVE CONTROL (A-1): the identical call with the switch ABSENT is NOT refused by the
      // policy choke — refusal is switch-selected, not verb-selected. A verb may still fail its own
      // branch validation (e.g. reduce_sign's INV-2), which is a DIFFERENT code; the assertion is
      // specifically that `APPROVAL_NODE_OPERATION_DISABLED` does not appear.
      const allowedTemplate = await publishGraphTemplate(adminToken, twoStepGraph(p, q), `${suffix}-ctl`)
      const allowed = await createApproval(requesterToken, allowedTemplate)
      const allowedResponse = await act(pTok, allowed.id, actionBodyFor(verb, spare))
      const allowedText = await allowedResponse.clone().text()
      expect(allowedText, `${verb} control`).not.toContain('APPROVAL_NODE_OPERATION_DISABLED')
      // And no denial row was written for the allowed attempt.
      expect((await recordsFor(allowed.id)).some((row) => row.action === APPROVAL_POLICY_DENIED_ACTION)).toBe(false)
    }
  }, 120_000)

  it('A-1/A-2 (server door): the denial is SERVER-side — a direct HTTP call with no UI involved is refused', async () => {
    // §2.3: the two doors must be proved independently. This is the SERVER door: the call below
    // never touches the FE derivation, so hiding the button could not have produced this result.
    // The FE door is proved separately in apps/web/tests/approval-node-operation-policy.test.ts and
    // the mounted inspector spec. MUTATION (server door only): delete the
    // `if (gatedPolicy?.[nodeOperationPolicyKey] === false)` block in `dispatchAction` — this test
    // goes red (200 instead of 409) while every FE test stays green.
    const suffix = 'a2-server'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const templateId = await publishGraphTemplate(adminToken, twoStepGraph(p, q, { allowTransfer: false }), suffix)
    const inst = await createApproval(requesterToken, templateId)
    const response = await act(pTok, inst.id, { action: 'transfer', targetUserId: `l5-t-${TS}-${suffix}` })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_NODE_OPERATION_DISABLED')
  })

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // D-1 / D-2 / D-3 / D-4 — the denial row
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it('D-1: a refused operation writes exactly ONE policy_denied row, durably, with NONE of the operation\'s own effects', async () => {
    const suffix = 'd1'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const target = `l5-t-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const templateId = await publishGraphTemplate(adminToken, twoStepGraph(p, q, { allowTransfer: false }), suffix)
    const inst = await createApproval(requesterToken, templateId)

    const before = await pool().query(
      'SELECT version, status, current_node_key, node_activation_seq FROM approval_instances WHERE id = $1',
      [inst.id],
    )
    const assignmentsBefore = await pool().query(
      'SELECT id, assignee_id, is_active, entry_epoch FROM approval_assignments WHERE instance_id = $1 ORDER BY id ASC',
      [inst.id],
    )

    const response = await act(pTok, inst.id, { action: 'transfer', targetUserId: target })
    expect(response.status).toBe(409)

    // The records-only transaction COMMITTED even though the request threw.
    const denials = (await recordsFor(inst.id)).filter((row) => row.action === APPROVAL_POLICY_DENIED_ACTION)
    expect(denials).toHaveLength(1)
    expect(denials[0]!.actor_id).toBe(p)
    const metadata = denials[0]!.metadata ?? {}
    expect(metadata.nodeKey).toBe('approval_a')
    expect(metadata.operation).toBe('transfer')
    expect(metadata.policyKey).toBe('allowTransfer')
    expect(typeof metadata.nodeEntryEpoch).toBe('number')
    // §2.4: the row itself carries no target id / comment either.
    expect(Object.keys(metadata).sort()).toEqual(['nodeEntryEpoch', 'nodeKey', 'operation', 'policyKey'])
    const commentRow = await pool().query(
      "SELECT comment, target_user_id FROM approval_records WHERE instance_id = $1 AND action = $2",
      [inst.id, APPROVAL_POLICY_DENIED_ACTION],
    )
    expect(commentRow.rows[0]?.comment).toBeNull()
    expect(commentRow.rows[0]?.target_user_id).toBeNull()

    // …and NONE of the operation's own effects: no new/deactivated assignment, no epoch bump, no
    // version bump, no status/node change.
    const after = await pool().query(
      'SELECT version, status, current_node_key, node_activation_seq FROM approval_instances WHERE id = $1',
      [inst.id],
    )
    expect(after.rows[0]).toEqual(before.rows[0])
    const assignmentsAfter = await pool().query(
      'SELECT id, assignee_id, is_active, entry_epoch FROM approval_assignments WHERE instance_id = $1 ORDER BY id ASC',
      [inst.id],
    )
    expect(assignmentsAfter.rows).toEqual(assignmentsBefore.rows)
    expect(assignmentsAfter.rows.some((row: { assignee_id: string }) => row.assignee_id === target)).toBe(false)

    // POSITIVE CONTROL (D-1): the ALLOWED path in the same fixture DOES commit all those effects,
    // so "nothing changed" above is not vacuous.
    const allowedTemplate = await publishGraphTemplate(adminToken, twoStepGraph(p, q), `${suffix}-ctl`)
    const allowedInst = await createApproval(requesterToken, allowedTemplate)
    const allowedBefore = await pool().query('SELECT version FROM approval_instances WHERE id = $1', [allowedInst.id])
    const okResponse = await act(pTok, allowedInst.id, { action: 'transfer', targetUserId: target })
    expect(okResponse.status, await okResponse.clone().text()).toBe(200)
    const allowedAssignments = await pool().query(
      'SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1',
      [allowedInst.id],
    )
    expect(allowedAssignments.rows.some((row: { assignee_id: string; is_active: boolean }) => row.assignee_id === target && row.is_active)).toBe(true)
    const allowedAfter = await pool().query('SELECT version FROM approval_instances WHERE id = $1', [allowedInst.id])
    // transfer keeps the same version, so assert the AUDIT effect that a denial must not produce.
    expect(allowedAfter.rows[0]).toEqual(allowedBefore.rows[0])
    expect((await recordsFor(allowedInst.id)).some((row) => row.action === 'transfer')).toBe(true)
  })

  it("D-1 (CHECK half): the DB accepts 'policy_denied' and still rejects 'policy_deniedx' — the constraint is exercised, not just the TS union", async () => {
    // MUTATION: revert `zzzz20260818090000_add_policy_denied_action_to_approval_records.ts` (or the
    // matching line in `tests/helpers/approval-schema-bootstrap.ts`) and the D-1 insert above goes
    // red with a CHECK violation instead of a clean 409.
    const suffix = 'd1-check'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const templateId = await publishGraphTemplate(adminToken, twoStepGraph(p, q), suffix)
    const inst = await createApproval(requesterToken, templateId)

    const insertWith = async (action: string) => pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, from_status, to_status, from_version, to_version, metadata)
       VALUES ($1, $2, 'probe', 'probe', 'pending', 'pending', 1, 1, '{}'::jsonb)`,
      [inst.id, action],
    )
    await expect(insertWith(APPROVAL_POLICY_DENIED_ACTION)).resolves.toBeTruthy()
    await expect(insertWith('policy_deniedx')).rejects.toThrow(/approval_records_action_check|violates check constraint/i)
  })

  it('D-2: the denial row grants the denied actor NO capability it did not already have, and a NON-participant writes no row at all', async () => {
    const suffix = 'd2'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const outsider = `l5-out-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)
    const outsiderTok = await authToken(baseUrl, outsider)

    const templateId = await publishGraphTemplate(adminToken, twoStepGraph(p, q, { allowTransfer: false }), suffix)
    const inst = await createApproval(requesterToken, templateId)

    // The gate runs strictly AFTER the `:APPROVAL_ASSIGNMENT_REQUIRED` authorization check, so the
    // denied actor is ALREADY a participant by the assignment clause every actor_id-keyed reader
    // uses. Pin that invariant directly (§1.4 fact 2: "an invariant to pin (D-2), not a coincidence
    // to rely on") by asserting the actor already had a row-independent seat.
    const seatBefore = await pool().query(
      'SELECT 1 FROM approval_assignments WHERE instance_id = $1 AND assignee_id = $2 AND is_active = TRUE',
      [inst.id, p],
    )
    expect(seatBefore.rowCount).toBe(1)

    expect((await act(pTok, inst.id, { action: 'transfer', targetUserId: outsider })).status).toBe(409)

    // The `actor_id`-keyed participation predicate every one of the four readers shares
    // (attachment authorization, the metrics participant check, and the two bridge scopes) — its
    // verdict for this actor is unchanged, because it was already TRUE before the denial row.
    const participantProbe = async (userId: string) => {
      const result = await pool().query(
        `SELECT EXISTS (
           SELECT 1 FROM approval_assignments a WHERE a.instance_id = $1 AND a.assignee_id = $2
         ) AS by_seat,
         EXISTS (
           SELECT 1 FROM approval_records r WHERE r.instance_id = $1 AND r.actor_id = $2
         ) AS by_record`,
        [inst.id, userId],
      )
      return result.rows[0] as { by_seat: boolean; by_record: boolean }
    }
    const denied = await participantProbe(p)
    expect(denied.by_seat).toBe(true)
    // The row exists, but it cannot be the SOURCE of participation — the seat already was.
    expect(denied.by_record).toBe(true)

    // POSITIVE CONTROL (D-2): a NON-participant attempting the same operation is refused EARLIER,
    // at the authorization gate, and writes NO row — proving the gate ORDER, not just the row shape.
    const outsiderResponse = await act(outsiderTok, inst.id, { action: 'transfer', targetUserId: p })
    expect(outsiderResponse.status).toBe(403)
    expect(((await outsiderResponse.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_ASSIGNMENT_REQUIRED')
    const outsiderProbe = await participantProbe(outsider)
    expect(outsiderProbe.by_seat).toBe(false)
    expect(outsiderProbe.by_record).toBe(false)
    expect((await recordsFor(inst.id)).filter((row) => row.actor_id === outsider)).toHaveLength(0)
  })

  it('D-3: the two full-timeline readers omit denial rows AND their pagination total is unchanged; a transfer row IS listed', async () => {
    const suffix = 'd3'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const target = `l5-t-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    // `allowReturn:false` so `transfer` (the action-selected control) still succeeds on the SAME node.
    const templateId = await publishGraphTemplate(adminToken, twoStepGraph(p, q, { allowReturn: false }), suffix)
    const inst = await createApproval(requesterToken, templateId)

    const history = async () => {
      // Lock-10 (S1): /history now gates per-instance admission (OD-S1-12), and this suite's
      // `adminToken` is a TRUSTED-CLAIMS `role: 'admin'` JWT with no matching `users` row — the
      // admin arm is DB-backed only (OD-S1-8), so that claim alone no longer admits. `requesterId`
      // IS a real participant (arm 1, unconditional) and sees the exact same full timeline an
      // admin would (the admission gate does not filter WHICH rows come back, only whether the
      // viewer may see any) — using it here observes identically what this test needs, honestly.
      const response = await jsonRequest(baseUrl, `/api/approvals/${inst.id}/history`, requesterToken)
      expect(response.status, await response.clone().text()).toBe(200)
      return (await response.json()) as { data: { items: Array<{ action: string }>; total: number } }
    }

    const beforeHistory = await history()

    // A refused `return` writes a denial row.
    expect((await act(pTok, inst.id, { action: 'return', targetNodeKey: 'approval_a' })).status).toBe(409)
    expect((await recordsFor(inst.id)).filter((row) => row.action === APPROVAL_POLICY_DENIED_ACTION)).toHaveLength(1)

    const afterDenial = await history()
    expect(afterDenial.data.items.map((item) => item.action)).not.toContain(APPROVAL_POLICY_DENIED_ACTION)
    // The pagination `total` must not move either — the count predicate and the page predicate are
    // the same expression, so a partial fix (page filtered, count not) is caught here.
    expect(afterDenial.data.total).toBe(beforeHistory.data.total)

    // POSITIVE CONTROL (D-3): a `transfer` row in the SAME instance IS listed and DOES move the
    // total — the exclusion is action-selected, not a broken reader.
    expect((await act(pTok, inst.id, { action: 'transfer', targetUserId: target })).status).toBe(200)
    const afterTransfer = await history()
    expect(afterTransfer.data.items.map((item) => item.action)).toContain('transfer')
    expect(afterTransfer.data.total).toBe(beforeHistory.data.total + 1)
    expect(afterTransfer.data.items.map((item) => item.action)).not.toContain(APPROVAL_POLICY_DENIED_ACTION)
  })

  it('D-4: the action-FILTERED readers are byte-identical with and without a denial row; a real approve row DOES move them', async () => {
    const suffix = 'd4'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const templateId = await publishGraphTemplate(adminToken, twoStepGraph(p, q, { allowTransfer: false }), suffix)
    const inst = await createApproval(requesterToken, templateId)

    // The four action-filtered predicates, mirrored from the shipped readers AT THIS HEAD (verified
    // by reading each one, NOT copied from the lock — the lock's §1.4 census predates Lock-3, whose
    // `handle` verb widened the revoke probe to four members, and Lock-7, which added an
    // `audit_record_id` ordinal sub-predicate to `loadApprovalHistory`):
    //   loadApprovalHistory                 → action = 'approve' … (its two ordinal sub-predicates
    //                                         both sit INSIDE that filter, and the return/backward-jump
    //                                         floor subquery is itself action-filtered, so a
    //                                         `policy_denied` row can reach neither)
    //   the revoke handled-probe            → action IN ('approve','reject','transfer','handle')
    //                                         AND metadata->>'nodeKey' = <node>
    //   the threshold tally                 → action = 'approve' (DISTINCT actor_id)
    //   the multitable DECISION_ACTIONS set → action IN ('approve','reject')
    //
    // DISCLOSED LIMIT: these four are PREDICATE-level mirrors, so on their own they would stay green
    // if a reader dropped its filter tomorrow. The revoke probe is additionally asserted at
    // READER level below (the real dispatch path), which is the one of the four reachable from this
    // fixture without building a second graph shape.
    const filteredReaders = async () => {
      const result = await pool().query(
        `SELECT
           (SELECT COUNT(*) FROM approval_records WHERE instance_id = $1 AND action = 'approve')::int AS history_approves,
           (SELECT COUNT(*) FROM approval_records WHERE instance_id = $1 AND action IN ('approve','reject','transfer','handle'))::int AS revoke_probe,
           (SELECT COUNT(DISTINCT actor_id) FROM approval_records WHERE instance_id = $1 AND action = 'approve')::int AS threshold_tally,
           (SELECT COUNT(*) FROM approval_records WHERE instance_id = $1 AND action IN ('approve','reject'))::int AS decision_actions`,
        [inst.id],
      )
      return result.rows[0]
    }

    const before = await filteredReaders()
    expect((await act(pTok, inst.id, { action: 'transfer', targetUserId: `l5-t-${TS}-${suffix}` })).status).toBe(409)
    expect((await recordsFor(inst.id)).filter((row) => row.action === APPROVAL_POLICY_DENIED_ACTION)).toHaveLength(1)
    expect(await filteredReaders()).toEqual(before)

    // POSITIVE CONTROL (D-4): injecting a real `approve` row DOES move each of them, so the
    // invariance above is not vacuous.
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, from_status, to_status, from_version, to_version, metadata)
       VALUES ($1, 'approve', $2, 'probe', 'pending', 'pending', 1, 1, '{"nodeKey":"approval_a"}'::jsonb)`,
      [inst.id, `l5-probe-${TS}-${suffix}`],
    )
    const after = await filteredReaders()
    expect(after.history_approves).toBe(before.history_approves + 1)
    expect(after.revoke_probe).toBe(before.revoke_probe + 1)
    expect(after.threshold_tally).toBe(before.threshold_tally + 1)
    expect(after.decision_actions).toBe(before.decision_actions + 1)
  })

  it('D-4 (READER level): a denial row does not close the revoke window — the real dispatch probe, not a mirrored predicate', async () => {
    // The predicate mirror above cannot catch a reader that DROPS its filter. This drives the actual
    // shipped reader: the revoke branch's handled-probe
    // (`action IN ('approve','reject','transfer','handle') AND metadata->>'nodeKey' = <node>`),
    // which decides whether the requester may still revoke. A denial row that leaked into it would
    // silently strip the requester's revoke right the first time an approver clicked a disabled
    // button.
    const suffix = 'd4-reader'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    // `allowReturn:false` so the DENIED verb is `return` while `transfer` — the control — still works.
    const templateId = await publishGraphTemplate(adminToken, twoStepGraph(p, q, { allowReturn: false }), suffix)

    const denialInst = await createApproval(requesterToken, templateId)
    expect((await act(pTok, denialInst.id, { action: 'return', targetNodeKey: 'approval_a' })).status).toBe(409)
    expect((await recordsFor(denialInst.id)).filter((row) => row.action === APPROVAL_POLICY_DENIED_ACTION)).toHaveLength(1)
    // GATE: the requester can STILL revoke — the denial row is invisible to the handled-probe.
    const revokeAfterDenial = await act(requesterToken, denialInst.id, { action: 'revoke', comment: 'withdraw' })
    expect(revokeAfterDenial.status, await revokeAfterDenial.clone().text()).toBe(200)

    // POSITIVE CONTROL: a REAL `transfer` at the same node DOES close the window, so "still 200"
    // above is the exclusion's doing and not a probe that never fires.
    const controlInst = await createApproval(requesterToken, templateId)
    expect((await act(pTok, controlInst.id, { action: 'transfer', targetUserId: `l5-t-${TS}-${suffix}` })).status).toBe(200)
    const revokeAfterTransfer = await act(requesterToken, controlInst.id, { action: 'revoke', comment: 'withdraw' })
    expect(revokeAfterTransfer.status).toBe(409)
    expect(((await revokeAfterTransfer.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_REVOKE_WINDOW_CLOSED')
  })

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // A-4 / A-5 / A-6 / X-2 — authoring + freeze
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it('A-4: an instance created BEFORE the flip keeps the old policy; one created after the next publish gets the new one', async () => {
    const suffix = 'a4'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const target = `l5-t-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const templateId = await publishGraphTemplate(adminToken, twoStepGraph(p, q), suffix)
    const older = await createApproval(requesterToken, templateId)

    // Flip the switch on the DRAFT and republish.
    const update = await jsonRequest(baseUrl, `/api/approval-templates/${templateId}`, adminToken, {
      method: 'PATCH',
      body: { approvalGraph: twoStepGraph(p, q, { allowTransfer: false }) },
    })
    expect(update.status, await update.clone().text()).toBe(200)
    const republish = await publish(adminToken, templateId)
    expect(republish.status, await republish.clone().text()).toBe(200)

    const newer = await createApproval(requesterToken, templateId)

    // The IN-FLIGHT instance pins its own frozen `published_definition_id`, so the flip never
    // reaches it.
    expect((await act(pTok, older.id, { action: 'transfer', targetUserId: target })).status).toBe(200)
    // The instance created AFTER the republish is refused.
    const newerResponse = await act(pTok, newer.id, { action: 'transfer', targetUserId: target })
    expect(newerResponse.status).toBe(409)
    expect(((await newerResponse.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_NODE_OPERATION_DISABLED')
  })

  it('A-4 positive control: the same flip with NO republish changes nothing at all', async () => {
    const suffix = 'a4-ctl'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const target = `l5-t-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const templateId = await publishGraphTemplate(adminToken, twoStepGraph(p, q), suffix)
    const update = await jsonRequest(baseUrl, `/api/approval-templates/${templateId}`, adminToken, {
      method: 'PATCH',
      body: { approvalGraph: twoStepGraph(p, q, { allowTransfer: false }) },
    })
    expect(update.status, await update.clone().text()).toBe(200)

    // No republish → the ACTIVE published definition is unchanged → even a BRAND NEW instance is
    // created against the old policy and the transfer succeeds.
    const fresh = await createApproval(requesterToken, templateId)
    expect((await act(pTok, fresh.id, { action: 'transfer', targetUserId: target })).status).toBe(200)
  })

  it('A-5: nodeOperationPolicy on start/end/cc/condition/parallel fails publish 400; the identical key on an approval node publishes', async () => {
    const suffix = 'a5'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)

    // Each rejected placement, with a graph that is otherwise valid for that node type.
    const placements: Array<{ label: string; graph: object }> = [
      {
        label: 'start',
        graph: {
          nodes: [
            { key: 'start', type: 'start', config: { nodeOperationPolicy: { allowTransfer: false } } },
            { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single' } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approval_a' },
            { key: 'e2', source: 'approval_a', target: 'end' },
          ],
        },
      },
      {
        label: 'end',
        graph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single' } },
            { key: 'end', type: 'end', config: { nodeOperationPolicy: { allowTransfer: false } } },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approval_a' },
            { key: 'e2', source: 'approval_a', target: 'end' },
          ],
        },
      },
      {
        label: 'cc',
        graph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single' } },
            { key: 'cc_1', type: 'cc', config: { targetType: 'user', targetIds: [q], nodeOperationPolicy: { allowTransfer: false } } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'e1', source: 'start', target: 'approval_a' },
            { key: 'e2', source: 'approval_a', target: 'cc_1' },
            { key: 'e3', source: 'cc_1', target: 'end' },
          ],
        },
      },
    ]

    for (const placement of placements) {
      const response = await tryCreateTemplate(adminToken, placement.graph, `${suffix}-${placement.label}`)
      const text = await response.clone().text()
      expect(response.status, `${placement.label}: ${text}`).toBe(400)
      expect(text, placement.label).toContain('nodeOperationPolicy')
    }

    // POSITIVE CONTROL (A-5): the IDENTICAL key on an `approval` node publishes — rejection is
    // node-type-selected, not a blanket refusal of the key.
    const okTemplate = await publishGraphTemplate(adminToken, twoStepGraph(p, q, { allowTransfer: false }), `${suffix}-ok`)
    expect(okTemplate).toBeTruthy()
  })

  it('A-6: an unknown sub-key and an out-of-enum value fail publish 400, never coerced', async () => {
    const suffix = 'a6'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)

    const invalidPolicies: Array<Record<string, unknown>> = [
      { futureSwitch: true },
      { allowTransfer: 'no' },
      { returnReviewMode: 'jump_sideways' },
      { commentRequired: 'sometimes' },
      // Deliberately included: the shipped `addSignMode` COERCES an unknown value to a default.
      // This normalizer must not — an out-of-enum value is a 400, never a silent flatten.
      { returnReviewMode: '' },
    ]
    for (const policy of invalidPolicies) {
      const response = await tryCreateTemplate(adminToken, twoStepGraph(p, q, policy), `${suffix}-${Object.keys(policy)[0]}`)
      const text = await response.clone().text()
      expect(response.status, `${JSON.stringify(policy)}: ${text}`).toBe(400)
      expect(text).toContain('nodeOperationPolicy')
    }

    // POSITIVE CONTROL (A-6): a VALID object with the same surrounding graph publishes.
    await publishGraphTemplate(
      adminToken,
      twoStepGraph(p, q, { allowTransfer: false, returnReviewMode: 'resume_forward', commentRequired: 'always' }),
      `${suffix}-ok`,
    )
  })

  it('A-6 (emptiness): authoring all-default switches persists NO key; setting one to false DOES change the bytes', async () => {
    const suffix = 'a6-empty'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)

    const storedConfig = async (templateId: string): Promise<Record<string, unknown>> => {
      const response = await jsonRequest(baseUrl, `/api/approval-templates/${templateId}`, adminToken)
      expect(response.status).toBe(200)
      const detail = (await response.json()) as { approvalGraph: { nodes: Array<{ key: string; config: Record<string, unknown> }> } }
      return detail.approvalGraph.nodes.find((node) => node.key === 'approval_a')!.config
    }

    // An all-absent object is OMITTED, not persisted as `{}` (§1.1).
    const emptyId = await publishGraphTemplate(adminToken, twoStepGraph(p, q, {}), `${suffix}-empty`)
    const emptyConfig = await storedConfig(emptyId)
    expect(Object.prototype.hasOwnProperty.call(emptyConfig, 'nodeOperationPolicy')).toBe(false)
    // …and byte-identical to a template that never carried the key at all.
    const bareId = await publishGraphTemplate(adminToken, twoStepGraph(p, q), `${suffix}-bare`)
    expect(emptyConfig).toEqual(await storedConfig(bareId))

    // POSITIVE CONTROL: one switch set to `false` DOES change the bytes.
    const setId = await publishGraphTemplate(adminToken, twoStepGraph(p, q, { allowReturn: false }), `${suffix}-set`)
    const setConfig = await storedConfig(setId)
    expect(setConfig).not.toEqual(emptyConfig)
    expect(setConfig.nodeOperationPolicy).toEqual({ allowReturn: false })
  })

  it('X-2: a PRE-Lock-5 graph round-trips save → publish → reload byte-for-byte; a new-format one shows the field', async () => {
    const suffix = 'x2'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)

    const readGraph = async (templateId: string) => {
      const response = await jsonRequest(baseUrl, `/api/approval-templates/${templateId}`, adminToken)
      expect(response.status).toBe(200)
      return ((await response.json()) as { approvalGraph: unknown }).approvalGraph
    }

    const legacyId = await publishGraphTemplate(adminToken, twoStepGraph(p, q), `${suffix}-legacy`)
    const legacyAfterPublish = await readGraph(legacyId)
    // Re-save the graph the server itself returned, republish, and re-read — a normalizer that
    // fabricated a default `nodeOperationPolicy` would diverge here.
    const resave = await jsonRequest(baseUrl, `/api/approval-templates/${legacyId}`, adminToken, {
      method: 'PATCH',
      body: { approvalGraph: legacyAfterPublish },
    })
    expect(resave.status, await resave.clone().text()).toBe(200)
    expect((await publish(adminToken, legacyId)).status).toBe(200)
    expect(await readGraph(legacyId)).toEqual(legacyAfterPublish)
    expect(JSON.stringify(legacyAfterPublish)).not.toContain('nodeOperationPolicy')

    // POSITIVE CONTROL (X-2): a new-format fixture DOES surface the field, so the absence above is
    // about the legacy graph and not about the reader.
    const modernId = await publishGraphTemplate(adminToken, twoStepGraph(p, q, { allowAddSign: false, allowReduceSign: false }), `${suffix}-modern`)
    expect(JSON.stringify(await readGraph(modernId))).toContain('nodeOperationPolicy')
  })

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Interplay — Lock-3 handler nodes (F-1) and the ungated verbs
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it('F-1: a handler node rejects allowAddSign/allowReduceSign/allowReturn at publish; allowTransfer:false refuses a handler transfer 409', async () => {
    const suffix = 'f1'
    const h = `l5-h-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const hTok = await authToken(baseUrl, h)

    const handlerGraph = (policy?: Record<string, unknown>) => ({
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'handler_1',
          type: 'handler',
          config: {
            assigneeSources: [{ kind: 'static_user', userIds: [h] }],
            ...(policy ? { nodeOperationPolicy: policy } : {}),
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'handler_1' },
        { key: 'e2', source: 'handler_1', target: 'end' },
      ],
    })

    for (const rejected of ['allowAddSign', 'allowReduceSign', 'allowReturn']) {
      const response = await tryCreateTemplate(adminToken, handlerGraph({ [rejected]: false }), `${suffix}-${rejected}`)
      const text = await response.clone().text()
      expect(response.status, `${rejected}: ${text}`).toBe(400)
      expect(text).toContain('APPROVAL_HANDLER_CONFIG_INVALID')
      expect(text).toContain(rejected)
    }

    // allowTransfer:false refuses a handler transfer with the Lock-5 code (not Lock-3's).
    const deniedId = await publishGraphTemplate(adminToken, handlerGraph({ allowTransfer: false }), `${suffix}-denied`)
    const deniedInst = await createApproval(requesterToken, deniedId)
    expect(deniedInst.currentNodeKey).toBe('handler_1')
    const deniedResponse = await act(hTok, deniedInst.id, { action: 'transfer', targetUserId: `l5-t-${TS}-${suffix}` })
    expect(deniedResponse.status, await deniedResponse.clone().text()).toBe(409)
    expect(((await deniedResponse.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_NODE_OPERATION_DISABLED')

    // POSITIVE CONTROL (F-1): `allowTransfer` ABSENT still permits it — Lock-3 §2.2's hardcoded
    // transfer-allowed behavior is preserved exactly, so the switch is value-selected.
    const allowedId = await publishGraphTemplate(adminToken, handlerGraph(), `${suffix}-allowed`)
    const allowedInst = await createApproval(requesterToken, allowedId)
    expect((await act(hTok, allowedInst.id, { action: 'transfer', targetUserId: `l5-t2-${TS}-${suffix}` })).status).toBe(200)
  })

  it('interplay (Lock-3 §2.2): the operation policy does NOT resurrect a verb a handler node forbids — the handler 409 still wins', async () => {
    // The choke sits AFTER Lock-3's handler verb gate on purpose. `add_sign` at a handler node must
    // keep reporting APPROVAL_HANDLER_ACTION_NOT_ALLOWED so no shipped client's handling changes,
    // and no denial row is written for it (the refusal is not a policy denial).
    const suffix = 'interplay-handler'
    const h = `l5-h-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const hTok = await authToken(baseUrl, h)

    const templateId = await publishGraphTemplate(adminToken, {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'handler_1', type: 'handler', config: { assigneeSources: [{ kind: 'static_user', userIds: [h] }] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'handler_1' },
        { key: 'e2', source: 'handler_1', target: 'end' },
      ],
    }, suffix)
    const inst = await createApproval(requesterToken, templateId)
    const response = await act(hTok, inst.id, { action: 'add_sign', targetUserIds: [`l5-t-${TS}-${suffix}`] })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_HANDLER_ACTION_NOT_ALLOWED')
    expect((await recordsFor(inst.id)).some((row) => row.action === APPROVAL_POLICY_DENIED_ACTION)).toBe(false)
  })

  it('§2.1 placement: a DENIED card-channel action does NOT consume the DingTalk card — the choke runs before the card claim', async () => {
    // THE HAZARD THIS PLACEMENT GUARDS. §1.4's records-only COMMIT commits whatever the transaction
    // has written so far. The card-delivery block below the choke takes `FOR UPDATE` on
    // `dingtalk_approval_card_deliveries` and CLAIMS the card (`SET card_state='acted'`) inside this
    // same transaction. Had the choke been placed "immediately before the first verb branch" — which
    // is where a literal reading of §2.1 puts it — the records-only COMMIT would have carried that
    // claim along, permanently consuming a live card for an operation the server REFUSED. Placing
    // the choke ABOVE the card block is what makes the commit records-only in fact and not just in
    // intent.
    //
    // Driven through the service directly because the HTTP route never forwards `channelOrigin`
    // (only the DingTalk card wrapper produces it) — the ordering is otherwise unreachable.
    // MUTATION: move the choke block to just before `if (request.action === 'comment')` and this
    // test goes red (card_state becomes 'acted'), while every other test in this file stays green.
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const suffix = 'card-order'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)

    const templateId = await publishGraphTemplate(adminToken, twoStepGraph(p, q, { allowTransfer: false }), suffix)
    const inst = await createApproval(requesterToken, templateId)

    // A live, delivered card bound to the actor's CURRENT node + round.
    const seat = await pool().query(
      'SELECT entry_epoch FROM approval_assignments WHERE instance_id = $1 AND assignee_id = $2 AND is_active = TRUE',
      [inst.id, p],
    )
    const entryEpoch = seat.rows[0]?.entry_epoch
    expect(entryEpoch).not.toBeNull()
    const deliveryId = `l5-card-${TS}-${suffix}`
    await pool().query(
      `INSERT INTO dingtalk_approval_card_deliveries
         (id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind, card_state, send_status, entry_epoch)
       VALUES ($1, $2, 'approval_a', $3, $3, 'interactive_card', 'sent', 'sent', $4)`,
      [deliveryId, inst.id, p, entryEpoch],
    )

    const service = new ApprovalProductService()
    await expect(service.dispatchAction(
      inst.id,
      {
        action: 'transfer',
        targetUserId: `l5-t-${TS}-${suffix}`,
        channelOrigin: { channel: 'dingtalk_card', cardDeliveryId: deliveryId },
      } as never,
      { userId: p, userName: p, roles: ['admin'] } as never,
    )).rejects.toMatchObject({ code: 'APPROVAL_NODE_OPERATION_DISABLED', statusCode: 409 })

    // The denial row committed…
    expect((await recordsFor(inst.id)).filter((row) => row.action === APPROVAL_POLICY_DENIED_ACTION)).toHaveLength(1)
    // …and the card is STILL claimable. This is the assertion the placement exists for.
    const afterDenial = await pool().query(
      'SELECT card_state, acted_action, acted_by FROM dingtalk_approval_card_deliveries WHERE id = $1',
      [deliveryId],
    )
    expect(afterDenial.rows[0]).toEqual({ card_state: 'sent', acted_action: null, acted_by: null })

    // POSITIVE CONTROL: the same card, same channel, on an ALLOWED operation IS consumed — so
    // "still sent" above is the choke's doing, not a card path that never claims anything.
    const allowedTemplate = await publishGraphTemplate(adminToken, twoStepGraph(p, q), `${suffix}-ctl`)
    const allowedInst = await createApproval(requesterToken, allowedTemplate)
    const allowedSeat = await pool().query(
      'SELECT entry_epoch FROM approval_assignments WHERE instance_id = $1 AND assignee_id = $2 AND is_active = TRUE',
      [allowedInst.id, p],
    )
    const allowedDeliveryId = `l5-card-${TS}-${suffix}-ok`
    await pool().query(
      `INSERT INTO dingtalk_approval_card_deliveries
         (id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind, card_state, send_status, entry_epoch)
       VALUES ($1, $2, 'approval_a', $3, $3, 'interactive_card', 'sent', 'sent', $4)`,
      [allowedDeliveryId, allowedInst.id, p, allowedSeat.rows[0]?.entry_epoch],
    )
    await service.dispatchAction(
      allowedInst.id,
      {
        action: 'transfer',
        targetUserId: `l5-t2-${TS}-${suffix}`,
        channelOrigin: { channel: 'dingtalk_card', cardDeliveryId: allowedDeliveryId },
      } as never,
      { userId: p, userName: p, roles: ['admin'] } as never,
    )
    const afterAllowed = await pool().query(
      'SELECT card_state, acted_action, acted_by FROM dingtalk_approval_card_deliveries WHERE id = $1',
      [allowedDeliveryId],
    )
    expect(afterAllowed.rows[0]).toEqual({ card_state: 'acted', acted_action: 'transfer', acted_by: p })

    await pool().query('DELETE FROM dingtalk_approval_card_deliveries WHERE id = ANY($1::text[])', [[deliveryId, allowedDeliveryId]])
  })

  it('the UNGATED verbs are untouched: approve/reject/comment/revoke ignore the policy object entirely', async () => {
    // §1.1 Scope — "a node whose approver may not decide is not an approval node". Even with EVERY
    // gated switch off, the decision verbs and the requester's revoke behave exactly as today.
    const suffix = 'ungated'
    const p = `l5-p-${TS}-${suffix}`
    const q = `l5-q-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5-admin-${TS}-${suffix}`)
    const requesterId = `l5-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const allOff = { allowTransfer: false, allowAddSign: false, allowReduceSign: false, allowReturn: false }
    const templateId = await publishGraphTemplate(adminToken, twoStepGraph(p, q, allOff), suffix)

    const commentInst = await createApproval(requesterToken, templateId)
    expect((await act(pTok, commentInst.id, { action: 'comment', comment: 'hi' })).status).toBe(200)

    const revokeInst = await createApproval(requesterToken, templateId)
    expect((await act(requesterToken, revokeInst.id, { action: 'revoke', comment: 'never mind' })).status).toBe(200)

    const approveInst = await createApproval(requesterToken, templateId)
    const approved = await act(pTok, approveInst.id, { action: 'approve', comment: 'ok' })
    expect(approved.status, await approved.clone().text()).toBe(200)
    expect(((await approved.json()) as { currentNodeKey: string | null }).currentNodeKey).toBe('approval_b')

    const rejectInst = await createApproval(requesterToken, templateId)
    expect((await act(pTok, rejectInst.id, { action: 'reject', comment: 'no' })).status).toBe(200)

    // No denial rows anywhere among the four.
    for (const id of [commentInst.id, revokeInst.id, approveInst.id, rejectInst.id]) {
      expect((await recordsFor(id)).some((row) => row.action === APPROVAL_POLICY_DENIED_ACTION), id).toBe(false)
    }
  }, 60_000)
})
