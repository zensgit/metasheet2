import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor, ensureLocalUserRow } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { isCancelRoundInstance, APPROVAL_CANCEL_ROUND_WORKFLOW_KEY } from '../../src/attendance/w4c3b-central-approval-hooks'

/**
 * Approval change-request design lock v5.9 §14.1 (WI-4) — `createCancelRoundInstance` real-DB
 * acceptance, FIRST SLICE (creation only — outlet guards, seat guards, redemption and the
 * attendance-parity/FK-migration slices are separate files per the taskbook's own split).
 *
 * Builds a genuinely `approved` original document the same way `approval-revoke-terminal-guard
 * .db.test.ts` does — a real one-node template, a real create, a real approve through the running
 * server — so the original instance's `requester_snapshot`, `org_id`, and `approval_records
 * (action='approve')` row are all production-shaped, not hand-inserted. `createCancelRoundInstance`
 * itself is called IN-PROCESS (no HTTP route exists for it yet — that is a later work item), which
 * is the correct boundary for WI-4: this file's job is the service method, not its transport.
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
 * `start -> approval_a -> end` with TWO assignees and `approvalMode: 'all'` (会签).
 *
 * Gate round 6, G6-3 — corrected wording. This comment used to call the P1 positive control below
 * "the anti-filter oracle", i.e. claim that turning the block into a filter (mutation M2) would be
 * caught by P1's `seat count === approver count` assertion. MEASURED, that is false: under M2 P1
 * stays GREEN, because both of P1's approvers are eligible and a filter is the identity map on
 * them. What actually goes red under M2 is 负控 N1/N2 — their zero-row assertions. P1's exact-count
 * assertion is DEFENCE IN DEPTH (it would catch a filter that dropped an ELIGIBLE id, which no
 * current mutation produces), not the oracle for M2. The verification MD's L4 already carried this
 * correction; the code comment did not, so the same criterion read as "oracle" here and as
 * "defence in depth" there.
 *
 * Two approvers are still required here, for a reason that does hold: with a single approver, a
 * blocked creation and a filtered-to-empty creation are not distinguishable at the seat table.
 */
function twoApproverNodeGraph(approverA: string, approverB: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_a',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: [approverA, approverB], approvalMode: 'all' },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-end', source: 'approval_a', target: 'end' },
    ],
  }
}

describeIfDatabase('createCancelRoundInstance (WI-4): creation', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const createdRoundIds = new Set<string>()
  const grantedUserIds = new Set<string>()
  // Lock §2-G3 第三句 fixtures — `approval_delegations` config rows inserted by this file.
  const createdDelegationIds = new Set<string>()

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
      // Lock §2-G3 第三句 fixtures — these are 'all'-scope delegation rows; left behind they would
      // substitute assignees for EVERY later suite that happens to name the same delegator id, so
      // this cleanup runs FIRST and not last.
      //
      // MEASURED 2026-09-20, not assumed: with this block at the END of the chain below, a run in
      // which any test leaves an UNREGISTERED cancel round behind (a mutation run where a 负控 stops
      // throwing, say) aborts `DELETE FROM approval_instances` on
      // `approval_rounds_document_id_fkey` (23503) — and every statement after it, this one included,
      // is skipped: two such runs left 26 delegation rows on the private DB. `approval_delegations`
      // has no foreign key to anything here, so running it first is both safe and the only ordering
      // that does not make the new fixture's hygiene hostage to the pre-existing delete chain.
      // (That chain's own fragility is pre-existing and is recorded in the verification MD §N, not
      // rewritten from here.)
      if (createdDelegationIds.size > 0) {
        await pool().query('DELETE FROM approval_delegations WHERE id = ANY($1::text[])', [[...createdDelegationIds]])
        createdDelegationIds.clear()
      }
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

  async function publishOneNodeTemplate(
    adminToken: string,
    approverId: string,
    label: string,
    // P3-D (gate impl-gate-C-slice1-round1-20260918.md): defaults to `true` for every existing
    // caller. The ONE caller that needs the original document's own policy to DIFFER from the
    // cancel round's own runtime policy (`allowRevoke: true`, `buildCancelRoundRuntimeGraph`)
    // passes `false` explicitly, so a `definitionPolicy` deep-equal in that test can actually
    // distinguish "froze the original's policy_snapshot" from "froze the round's own" — with both
    // values equal, as they are for every other caller here, the two are indistinguishable and the
    // assertion would pass by construction regardless of which one the source actually froze.
    allowRevoke = true,
  ): Promise<string> {
    const templateKey = `wi4-creation-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'WI-4 cancel-round creation fixture',
        description: 'approval-cancel-round-creation.db.test.ts',
        formSchema: buildFormSchema(),
        approvalGraph: oneNodeGraph(approverId),
      },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const template = (await create.json()) as { id: string }
    createdTemplateIds.add(template.id)
    const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke } },
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

    const row = await pool().query<{ status: string }>(
      `SELECT status FROM approval_instances WHERE id = $1`,
      [inst.id],
    )
    expect(row.rows[0]?.status).toBe('approved')
    return inst.id
  }

  it('writes the dedicated instance, one pending round row, and an active seat for the original approver', async () => {
    const suffix = `create-${TS}`
    const requesterId = `wi4-req-${suffix}`
    const approverId = `wi4-apr-${suffix}`
    const adminId = `wi4-admin-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    // allowRevoke=false: deliberately DIFFERENT from the cancel round's own runtime policy
    // (`allowRevoke: true`, `buildCancelRoundRuntimeGraph`) — see `publishOneNodeTemplate`'s doc
    // comment. Only affects the ORIGINAL document's own template; the cancel round's dedicated
    // published definition (a separate, fixed seed row) is untouched.
    const templateId = await publishOneNodeTemplate(adminToken, approverId, 'ok', false)
    const documentId = await createApprovedOriginal(requesterId, requesterToken, approverToken, templateId)

    // Judgment I (两向), REVERSE direction (lock §14.1: "经公开 createApproval ⇒ 谓词假") — the
    // ORIGINAL document, created through the public `createApproval` path, must NOT satisfy the
    // cancel-round predicate. Gate review impl-gate-C-slice1-round1-20260918.md P1-B row 3: this
    // direction had no assertion anywhere in the corpus (only the forward "专用路径 ⇒ 谓词真"
    // direction was covered, by the `isCancelRoundInstance(instance!)).toBe(true)` assertion below
    // for the DEDICATED instance). Discriminating power confirmed by a source mutation probe (cp
    // backup -> edit ApprovalProductService.ts's public-path `workflow_key` literal to the
    // dedicated value -> rerun -> restore -> cmp identical; recorded in the verification MD).
    const originalInstanceRow = await pool().query<{
      workflow_key: string | null
      policy_snapshot: Record<string, unknown>
    }>(
      `SELECT workflow_key, policy_snapshot FROM approval_instances WHERE id = $1`,
      [documentId],
    )
    expect(isCancelRoundInstance(originalInstanceRow.rows[0]!)).toBe(false)

    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)

    // Judgment I (lock §14.1): the new instance carries the dedicated workflow_key.
    const instanceRow = await pool().query<{
      workflow_key: string | null
      source_system: string
      external_approval_id: string | null
      published_definition_id: string | null
      status: string
      org_id: string | null
      requester_snapshot: Record<string, unknown>
    }>(
      `SELECT workflow_key, source_system, external_approval_id, published_definition_id, status, org_id, requester_snapshot
         FROM approval_instances WHERE id = $1`,
      [dto.id],
    )
    const instance = instanceRow.rows[0]
    expect(instance).toBeTruthy()
    expect(instance!.workflow_key).toBe(APPROVAL_CANCEL_ROUND_WORKFLOW_KEY)
    expect(isCancelRoundInstance(instance!)).toBe(true)
    expect(instance!.source_system).toBe('platform')
    expect(instance!.external_approval_id).toBeNull()
    expect(instance!.published_definition_id).toBe('00000000-0000-4000-8000-000000000003')
    expect(instance!.status).toBe('pending')
    // §14.1: `requester_snapshot->>'id'` must byte-equal the ORIGINAL requester — this is exactly
    // the key the revoke gate (`requesterSnapshot?.id`) reads.
    expect(instance!.requester_snapshot?.id).toBe(requesterId)

    // I″ (post-commit only, per lock — `isTemplateRuntimeInstance` queries the pool, not the txn).
    expect(await service.isTemplateRuntimeInstance(dto.id)).toBe(true)

    // Exactly one active seat, and it is the original document's approver.
    const seatRows = await pool().query<{ assignee_id: string; is_active: boolean; node_key: string }>(
      `SELECT assignee_id, is_active, node_key FROM approval_assignments WHERE instance_id = $1`,
      [dto.id],
    )
    expect(seatRows.rows.length).toBe(1)
    expect(seatRows.rows[0].assignee_id).toBe(approverId)
    expect(seatRows.rows[0].is_active).toBe(true)

    // Exactly one `approval_rounds` row: kind='cancel', engine_instance_id = the new instance,
    // document_id = the ORIGINAL instance, outcome='pending'.
    const roundRows = await pool().query<{
      id: string
      document_id: string
      kind: string
      engine_instance_id: string | null
      outcome: string
      requested_by: string
      policy_snapshot_at_create: Record<string, unknown>
    }>(
      `SELECT id, document_id, kind, engine_instance_id, outcome, requested_by, policy_snapshot_at_create
         FROM approval_rounds WHERE document_id = $1`,
      [documentId],
    )
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)
    expect(roundRows.rows[0].kind).toBe('cancel')
    expect(roundRows.rows[0].engine_instance_id).toBe(dto.id)
    expect(roundRows.rows[0].outcome).toBe('pending')
    expect(roundRows.rows[0].requested_by).toBe(requesterId)
    const roundPolicy = roundRows.rows[0].policy_snapshot_at_create.roundPolicy as { windowDays: number; suite: string }
    // No `capPerDocument` key — lock §4/§5 I6: cancel rounds are NOT count-limited (v5.5 correction).
    expect(Object.keys(roundRows.rows[0].policy_snapshot_at_create.roundPolicy as object).sort()).toEqual(['suite', 'windowDays'])
    expect(roundPolicy.suite).toBe('leave')
    expect(roundPolicy.windowDays).toBe(90)
    // Gate review impl-gate-C-slice1-round1-20260918.md P3-D: `policy_snapshot_at_create` (lock §4,
    // v5.4) is `{ definitionPolicy: <原样>, roundPolicy: {...} }` — only the `roundPolicy` half had
    // an assertion anywhere in the corpus. `definitionPolicy` must freeze the ORIGINAL document's
    // OWN `policy_snapshot` column value VERBATIM (`ApprovalProductService.ts:8505`,
    // `definitionPolicy: original.policy_snapshot`) — a deep-equal against the row read directly off
    // the original instance BEFORE `createCancelRoundInstance` ran, not a re-derived/hardcoded shape,
    // so this assertion cannot pass by construction if the freeze point ever moves or the value is
    // re-serialized. Discriminating power confirmed by a source mutation probe (cp backup -> replace
    // `definitionPolicy: original.policy_snapshot` with `definitionPolicy: {}` -> rerun -> restore ->
    // cmp identical; recorded in the verification MD).
    expect(roundRows.rows[0].policy_snapshot_at_create.definitionPolicy).toEqual(
      originalInstanceRow.rows[0]!.policy_snapshot,
    )
  })

  it('§5 I3 — a second cancel round cannot be started while one is pending (uq_approval_rounds_pending_document)', async () => {
    const suffix = `pending-${TS}`
    const requesterId = `wi4-req-${suffix}`
    const approverId = `wi4-apr-${suffix}`
    const adminId = `wi4-admin-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    const templateId = await publishOneNodeTemplate(adminToken, approverId, 'pending')
    const documentId = await createApprovedOriginal(requesterId, requesterToken, approverToken, templateId)

    const service = new ApprovalProductService()
    const first = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(first.id)

    await expect(service.createCancelRoundInstance(documentId, { userId: requesterId })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CANCEL_ROUND_ALREADY_PENDING',
    })

    const roundRows = await pool().query<{ id: string }>(
      `SELECT id FROM approval_rounds WHERE document_id = $1 AND outcome = 'pending'`,
      [documentId],
    )
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)
  })

  it(
    '§4 / §5 I3 / §14.2 判据 III 负控 — the partial unique index itself is load-bearing, ' +
      'independent of the app-layer precheck (bypass createCancelRoundInstance and INSERT a ' +
      'second pending round directly ⇒ 23505)',
    async () => {
      // Gate review P1-B row 4: the existing "§5 I3" test above (and `createCancelRoundInstance`'s
      // own APS:8377 pre-check) never exercises `uq_approval_rounds_pending_document` itself —
      // deleting the index outright would leave that test green, because the pre-check's own
      // `SELECT ... WHERE outcome='pending'` already turns a second call into 409
      // CANCEL_ROUND_ALREADY_PENDING before any INSERT is attempted. This test bypasses the
      // service (and its pre-check) entirely with a raw INSERT from the test's own connection, so
      // only the index itself can reject it.
      const suffix = `index-${TS}`
      const requesterId = `wi4-req-${suffix}`
      const approverId = `wi4-apr-${suffix}`
      const adminId = `wi4-admin-${suffix}`
      await grantWrite(requesterId)
      const adminToken = await authToken(baseUrl, adminId)
      const requesterToken = await authToken(baseUrl, requesterId)
      const approverToken = await authToken(baseUrl, approverId)

      const templateId = await publishOneNodeTemplate(adminToken, approverId, 'index')
      const documentId = await createApprovedOriginal(requesterId, requesterToken, approverToken, templateId)

      const service = new ApprovalProductService()
      const first = await service.createCancelRoundInstance(documentId, { userId: requesterId })
      createdApprovalIds.add(first.id)
      const firstRoundRow = await pool().query<{ id: string }>(
        `SELECT id FROM approval_rounds WHERE document_id = $1 AND outcome = 'pending'`,
        [documentId],
      )
      expect(firstRoundRow.rows.length).toBe(1)
      createdRoundIds.add(firstRoundRow.rows[0].id)

      const bypassRoundId = `apr_bypass_${TS}_${Math.floor(Math.random() * 1e6)}`
      let bypassError: { code?: string; constraint?: string } | undefined
      try {
        await pool().query(
          `INSERT INTO approval_rounds
             (id, document_id, kind, engine_instance_id, requested_by, reason, outcome, policy_snapshot_at_create)
           VALUES ($1, $2, 'cancel', NULL, $3, NULL, 'pending', '{}'::jsonb)`,
          [bypassRoundId, documentId, requesterId],
        )
      } catch (error) {
        bypassError = error as { code?: string; constraint?: string }
      }
      expect(bypassError?.code).toBe('23505')
      expect(bypassError?.constraint).toBe('uq_approval_rounds_pending_document')

      // The failed raw INSERT left no row behind, and the original pending round is untouched.
      const roundsAfter = await pool().query<{ id: string; outcome: string }>(
        `SELECT id, outcome FROM approval_rounds WHERE document_id = $1`,
        [documentId],
      )
      expect(roundsAfter.rows.length).toBe(1)
      expect(roundsAfter.rows[0].id).toBe(firstRoundRow.rows[0].id)
      expect(roundsAfter.rows[0].outcome).toBe('pending')
    },
  )

  it('WI-16 — only the original requester may start a cancel round (403 CANCEL_ROUND_REQUESTER_ONLY)', async () => {
    const suffix = `authz-${TS}`
    const requesterId = `wi4-req-${suffix}`
    const approverId = `wi4-apr-${suffix}`
    const adminId = `wi4-admin-${suffix}`
    const impostorId = `wi4-impostor-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    const templateId = await publishOneNodeTemplate(adminToken, approverId, 'authz')
    const documentId = await createApprovedOriginal(requesterId, requesterToken, approverToken, templateId)

    const service = new ApprovalProductService()
    await expect(service.createCancelRoundInstance(documentId, { userId: impostorId })).rejects.toMatchObject({
      statusCode: 403,
      code: 'CANCEL_ROUND_REQUESTER_ONLY',
    })

    const roundRows = await pool().query<{ id: string }>(
      `SELECT id FROM approval_rounds WHERE document_id = $1`,
      [documentId],
    )
    expect(roundRows.rows.length).toBe(0)

    // POSITIVE CONTROL — the true original requester succeeds against the SAME document.
    const ok = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(ok.id)
    const okRoundRows = await pool().query<{ id: string }>(
      `SELECT id FROM approval_rounds WHERE document_id = $1`,
      [documentId],
    )
    expect(okRoundRows.rows.length).toBe(1)
    createdRoundIds.add(okRoundRows.rows[0].id)
  })

  it('§14.3 #14 (WI-6) — suite="forbidden" is rejected before any write (CancelRoundSuiteForbiddenError 409)', async () => {
    const suffix = `suite-${TS}`
    const requesterId = `wi4-req-${suffix}`
    const approverId = `wi4-apr-${suffix}`
    const adminId = `wi4-admin-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    const templateId = await publishOneNodeTemplate(adminToken, approverId, 'suite')
    const documentId = await createApprovedOriginal(requesterId, requesterToken, approverToken, templateId)

    // The forbidden-suite tag lives on the ORIGINAL instance's own `metadata` (phase-1 fixture
    // convention, lock:143's "seed/夹具直接给出" — no production template→suite table exists yet).
    await pool().query(
      `UPDATE approval_instances SET metadata = metadata || '{"suite":"forbidden"}'::jsonb WHERE id = $1`,
      [documentId],
    )

    const service = new ApprovalProductService()
    await expect(service.createCancelRoundInstance(documentId, { userId: requesterId })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CANCEL_ROUND_SUITE_FORBIDDEN',
    })

    // Zero rows written — no round, no dedicated instance.
    const roundRows = await pool().query<{ id: string }>(
      `SELECT id FROM approval_rounds WHERE document_id = $1`,
      [documentId],
    )
    expect(roundRows.rows.length).toBe(0)
    const dedicatedRows = await pool().query<{ id: string }>(
      `SELECT id FROM approval_instances WHERE workflow_key = $1 AND business_key = $2`,
      [APPROVAL_CANCEL_ROUND_WORKFLOW_KEY, documentId],
    )
    expect(dedicatedRows.rows.length).toBe(0)
  })

  // ===========================================================================================
  // Codex review 2026-09-19 — finding 1 (lock §2-G3 seat re-qualification) and finding 2
  // (lock:143 suite/window domains). Both defects were born in this slice (C-1).
  // ===========================================================================================

  /** Publishes a co-sign (`approvalMode: 'all'`) template with two named approvers. */
  async function publishTwoApproverTemplate(
    adminToken: string,
    approverA: string,
    approverB: string,
    label: string,
  ): Promise<string> {
    const templateKey = `wi4-creation-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'WI-4 cancel-round creation fixture (co-sign)',
        description: 'approval-cancel-round-creation.db.test.ts',
        formSchema: buildFormSchema(),
        approvalGraph: twoApproverNodeGraph(approverA, approverB),
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

  /** Real create + BOTH real approvals, so `approval_records(action='approve')` carries two rows. */
  async function createApprovedOriginalCoSign(
    requesterToken: string,
    approverTokenA: string,
    approverTokenB: string,
    templateId: string,
  ): Promise<string> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string }
    createdApprovalIds.add(inst.id)

    for (const token of [approverTokenA, approverTokenB]) {
      const approve = await jsonRequest(baseUrl, `/api/approvals/${inst.id}/actions`, token, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(approve.status, await approve.clone().text()).toBe(200)
    }

    const row = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [inst.id])
    expect(row.rows[0]?.status).toBe('approved')

    // The seat set the cancel round will replay: BOTH approvers, from the audit trail itself.
    const approvers = await pool().query<{ actor_id: string }>(
      `SELECT DISTINCT actor_id FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY actor_id`,
      [inst.id],
    )
    expect(approvers.rows.length).toBe(2)
    return inst.id
  }

  /**
   * The zero-row oracle every creation-time rejection owes (lock §14.3's own "零行" requirement):
   * no `approval_rounds` row, no dedicated `approval_instances` row, and no seat on one.
   */
  async function expectZeroCancelRoundRows(documentId: string): Promise<void> {
    const roundRows = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE document_id = $1`, [
      documentId,
    ])
    expect(roundRows.rows.length).toBe(0)
    const dedicatedRows = await pool().query<{ id: string }>(
      `SELECT id FROM approval_instances WHERE workflow_key = $1 AND business_key = $2`,
      [APPROVAL_CANCEL_ROUND_WORKFLOW_KEY, documentId],
    )
    expect(dedicatedRows.rows.length).toBe(0)
    const seatRows = await pool().query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM approval_assignments a
         JOIN approval_instances i ON i.id = a.instance_id
        WHERE i.workflow_key = $1 AND i.business_key = $2`,
      [APPROVAL_CANCEL_ROUND_WORKFLOW_KEY, documentId],
    )
    expect(seatRows.rows[0].n).toBe(0)
  }

  /** Builds an approved, co-signed original and returns everything the seat tests need. */
  async function coSignFixture(label: string): Promise<{
    documentId: string
    requesterId: string
    approverA: string
    approverB: string
  }> {
    const suffix = `${label}-${TS}`
    const requesterId = `wi4-req-${suffix}`
    const approverA = `wi4-aprA-${suffix}`
    const approverB = `wi4-aprB-${suffix}`
    const adminId = `wi4-admin-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    const tokenA = await authToken(baseUrl, approverA)
    const tokenB = await authToken(baseUrl, approverB)
    const templateId = await publishTwoApproverTemplate(adminToken, approverA, approverB, label)
    const documentId = await createApprovedOriginalCoSign(requesterToken, tokenA, tokenB, templateId)
    return { documentId, requesterId, approverA, approverB }
  }

  it('§2-G3 正控 P1 — every original approver is still eligible ⇒ the round is created with ONE SEAT PER APPROVER (defence in depth; M2 is caught by N1/N2, not here)', async () => {
    const { documentId, requesterId, approverA, approverB } = await coSignFixture('g3pos')

    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)

    // Seat COUNT equals approver count, not merely ">= 1", and the SET is exact. Gate round 6,
    // G6-3: this is defence in depth, NOT the M2 oracle — both approvers here are eligible, so a
    // filter is the identity map on them and M2 leaves this test green (measured). It would catch a
    // filter that dropped an ELIGIBLE id, which is why the exact set is asserted and not just the
    // count. The mutation that IS caught here is the gate round 6 sentinel probe: remove the
    // `isSystemSentinelActor` drop and 正控 P3 below goes red, this one does not.
    const seatRows = await pool().query<{ assignee_id: string; is_active: boolean; node_key: string }>(
      `SELECT assignee_id, is_active, node_key FROM approval_assignments WHERE instance_id = $1 ORDER BY assignee_id`,
      [dto.id],
    )
    expect(seatRows.rows.length).toBe(2)
    expect(seatRows.rows.map((row) => row.assignee_id)).toEqual([approverA, approverB].sort())
    expect(seatRows.rows.every((row) => row.is_active)).toBe(true)

    const roundRows = await pool().query<{ id: string; outcome: string }>(
      `SELECT id, outcome FROM approval_rounds WHERE document_id = $1`,
      [documentId],
    )
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)
    expect(roundRows.rows[0].outcome).toBe('pending')
  })

  it('§2-G3 正控 P2 — an original whose org_id IS NULL is NOT refused (the org half of G3 is OPEN, not silently shipped)', async () => {
    const { documentId, requesterId } = await coSignFixture('g3null')

    // `approval_instances.org_id` is nullable with no default (zzzz20260821100000). Half B of G3
    // (「仍在该组织单元」) is an owner call and is NOT implemented in this slice; this control pins
    // that the shipped half does not refuse the NULL-org corpus, so a later org predicate cannot
    // land without deciding NULL semantics first.
    await pool().query(`UPDATE approval_instances SET org_id = NULL WHERE id = $1`, [documentId])

    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)

    const instanceRow = await pool().query<{ org_id: string | null }>(
      `SELECT org_id FROM approval_instances WHERE id = $1`,
      [dto.id],
    )
    expect(instanceRow.rows[0].org_id).toBeNull()
    const roundRows = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE document_id = $1`, [
      documentId,
    ])
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)
  })

  it('§2-G3 负控 N1 — a DEACTIVATED original approver blocks creation (409 CANCEL_ROUND_SEAT_INELIGIBLE, zero rows, values-free details)', async () => {
    const { documentId, requesterId, approverA } = await coSignFixture('g3inact')

    const deactivated = await pool().query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [approverA])
    expect(deactivated.rowCount).toBe(1)

    const service = new ApprovalProductService()
    let thrown: unknown
    try {
      await service.createCancelRoundInstance(documentId, { userId: requesterId })
    } catch (error) {
      thrown = error
    }
    // Positive assertion on the OUTCOME, not `notEqual(201)`: the named code, the status, and the
    // machine-checkable detail shape.
    expect(thrown).toBeTruthy()
    const failure = thrown as { statusCode?: number; code?: string; message?: string; details?: Record<string, unknown> }
    expect(failure.statusCode).toBe(409)
    expect(failure.code).toBe('CANCEL_ROUND_SEAT_INELIGIBLE')
    expect(failure.details).toEqual({ ineligibleCount: 1, reasons: ['inactive'] })

    // M4's oracle — values-free: neither the details object nor the message may carry a person id
    // (the discipline `validateAndFreezeRequesterChoices`'s own 422s already follow).
    expect(Object.keys(failure.details ?? {}).sort()).toEqual(['ineligibleCount', 'reasons'])
    expect(JSON.stringify(failure.details)).not.toContain(approverA)
    expect(String(failure.message)).not.toContain(approverA)

    await expectZeroCancelRoundRows(documentId)
  })

  it('§2-G3 负控 N2 — the seat gate is the SHARED LOGIN gate, not a narrower is_active lookalike (pending_activation / role=disabled / no directory row)', async () => {
    const { documentId, requesterId, approverA } = await coSignFixture('g3gate')
    const service = new ApprovalProductService()

    // Each leg leaves the account eligible again before the next, so exactly ONE predicate differs
    // per attempt (a confounded mutation would otherwise make the reasons unattributable).
    const legs: Array<{ label: string; apply: string; reason: string }> = [
      {
        label: 'pending_activation (is_active still TRUE)',
        apply: `UPDATE users SET activation_status = 'pending_activation' WHERE id = $1`,
        reason: 'pending_activation',
      },
      {
        label: "role = 'disabled' (is_active still TRUE)",
        apply: `UPDATE users SET role = 'disabled' WHERE id = $1`,
        reason: 'inactive',
      },
    ]
    for (const leg of legs) {
      const applied = await pool().query(leg.apply, [approverA])
      expect(applied.rowCount, leg.label).toBe(1)
      await expect(
        service.createCancelRoundInstance(documentId, { userId: requesterId }),
        leg.label,
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CANCEL_ROUND_SEAT_INELIGIBLE',
        details: { ineligibleCount: 1, reasons: [leg.reason] },
      })
      await expectZeroCancelRoundRows(documentId)
      await pool().query(`UPDATE users SET activation_status = 'activated', role = 'user', is_active = TRUE WHERE id = $1`, [
        approverA,
      ])
    }

    // Absence fails closed, exactly as it does in the precedent this gate reuses: an id with no
    // `users` row is not in the eligible set.
    await pool().query(`DELETE FROM users WHERE id = $1`, [approverA])
    await expect(service.createCancelRoundInstance(documentId, { userId: requesterId })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CANCEL_ROUND_SEAT_INELIGIBLE',
      details: { ineligibleCount: 1, reasons: ['not_found'] },
    })
    await expectZeroCancelRoundRows(documentId)

    // DISCRIMINATING CONTROL on the same document: restore the row and the SAME call succeeds, so
    // the four rejections above were caused by the seat predicate and by nothing else about this
    // fixture.
    await ensureLocalUserRow(approverA)
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)
    const roundRows = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE document_id = $1`, [
      documentId,
    ])
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)
  })

  // ===========================================================================================
  // Gate round 6 (impl-gate-C-slice1-round6-20260919.md) — G6-1 (P1) and G6-4 (P3).
  //
  // G6-1: `system:auto-approval` is written into `approval_records(action='approve')` by
  // `insertAutoApprovalEvents`, so it lands in the cancel round's seat query. Before this round the
  // seat gate counted it as a person with no `users` row and answered 409 SEAT_INELIGIBLE /
  // `not_found` — permanently, with a hint telling the administrator to restore an account that
  // cannot exist. The existing 13 cases had ZERO discriminative power over this (the gate's own
  // G-M8 mutation, "add the sentinel filter", left all 13 green), so the three cases below are the
  // coverage that branch never had.
  // ===========================================================================================

  /**
   * A template whose FIRST approval node auto-approves at create time (`mergeWithRequester: true`
   * with the requester as its only assignee — the one switch the shipped authoring UI owns) and
   * whose SECOND node holds a real human. Creating an instance therefore writes a synthetic
   * `approve` row (`actor_id = 'system:auto-approval'`) with no `actorMode`, i.e. the default
   * `'system'` — exactly the production shape G6-1 describes.
   *
   * When `humanId` is null the template is ONE auto-approving node only, so the instance reaches
   * `approved` at create with NO human `approve` row at all.
   */
  async function publishAutoApprovalTemplate(
    adminToken: string,
    requesterId: string,
    humanId: string | null,
    label: string,
  ): Promise<string> {
    const autoNode = {
      key: 'approval_auto',
      type: 'approval',
      config: {
        assigneeType: 'user',
        assigneeIds: [requesterId],
        approvalMode: 'single',
        autoApprovalPolicy: { mergeWithRequester: true },
      },
    }
    const humanNode = humanId
      ? [{ key: 'approval_human', type: 'approval', config: { assigneeType: 'user', assigneeIds: [humanId], approvalMode: 'single' } }]
      : []
    const nodes = [
      { key: 'start', type: 'start', config: {} },
      autoNode,
      ...humanNode,
      { key: 'end', type: 'end', config: {} },
    ]
    const edges = humanId
      ? [
          { key: 'e-s-auto', source: 'start', target: 'approval_auto' },
          { key: 'e-auto-human', source: 'approval_auto', target: 'approval_human' },
          { key: 'e-human-end', source: 'approval_human', target: 'end' },
        ]
      : [
          { key: 'e-s-auto', source: 'start', target: 'approval_auto' },
          { key: 'e-auto-end', source: 'approval_auto', target: 'end' },
        ]

    const templateKey = `wi4-creation-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'WI-4 cancel-round creation fixture (auto-approval)',
        description: 'approval-cancel-round-creation.db.test.ts',
        formSchema: buildFormSchema(),
        approvalGraph: { nodes, edges },
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

  /**
   * Builds an approved original that went through auto-approval. Returns the seat set the cancel
   * round will read, ASSERTED to contain the sentinel — so a future change that stops producing
   * sentinels turns these tests into obvious no-ops rather than silently vacuous greens.
   */
  async function autoApprovedFixture(
    label: string,
    withHuman: boolean,
  ): Promise<{ documentId: string; requesterId: string; humanId: string | null }> {
    const suffix = `${label}-${TS}`
    const requesterId = `wi4-req-${suffix}`
    const humanId = withHuman ? `wi4-hum-${suffix}` : null
    const adminId = `wi4-admin-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    const humanToken = humanId ? await authToken(baseUrl, humanId) : null
    const templateId = await publishAutoApprovalTemplate(adminToken, requesterId, humanId, label)

    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string }
    createdApprovalIds.add(inst.id)

    if (humanToken) {
      const approve = await jsonRequest(baseUrl, `/api/approvals/${inst.id}/actions`, humanToken, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(approve.status, await approve.clone().text()).toBe(200)
    }

    const statusRow = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      inst.id,
    ])
    expect(statusRow.rows[0]?.status).toBe('approved')

    // The seat set the cancel round reads, verbatim. The sentinel MUST be in it — that is the
    // precondition of everything below, and asserting it here is what stops these cases from
    // degrading into vacuous greens if auto-approval ever stops writing `action='approve'`.
    const seatQuery = await pool().query<{ actor_id: string }>(
      `SELECT DISTINCT actor_id FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY actor_id`,
      [inst.id],
    )
    const actorIds = seatQuery.rows.map((row) => row.actor_id)
    expect(actorIds).toContain('system:auto-approval')
    expect(actorIds).toEqual(humanId ? ['system:auto-approval', humanId].sort() : ['system:auto-approval'])

    return { documentId: inst.id, requesterId, humanId }
  }

  it('§2-G3 正控 P3 (G6-1) — an auto-approved document with one eligible human approver IS cancellable, and the seat set is exactly that human (the sentinel is dropped, not seated, not counted as a missing person)', async () => {
    const { documentId, requesterId, humanId } = await autoApprovedFixture('g6sent', true)

    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)

    // Seat count = number of HUMAN approvers (1), not the number of `approve` rows (2). This is the
    // assertion that goes red if the `isSystemSentinelActor` drop is removed: without it the call
    // throws 409 SEAT_INELIGIBLE / `not_found` and never reaches here.
    const seatRows = await pool().query<{ assignee_id: string; is_active: boolean }>(
      `SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1 ORDER BY assignee_id`,
      [dto.id],
    )
    expect(seatRows.rows.length).toBe(1)
    expect(seatRows.rows[0].assignee_id).toBe(humanId)
    expect(seatRows.rows[0].is_active).toBe(true)
    // No sentinel anywhere on the round — not as a seat, not as a requester-choice replay.
    expect(seatRows.rows.map((row) => row.assignee_id)).not.toContain('system:auto-approval')
    const snapshot = await pool().query<{ requester_snapshot: Record<string, unknown> }>(
      `SELECT requester_snapshot FROM approval_instances WHERE id = $1`,
      [dto.id],
    )
    expect(JSON.stringify(snapshot.rows[0].requester_snapshot)).not.toContain('system:auto-approval')

    const roundRows = await pool().query<{ id: string; outcome: string }>(
      `SELECT id, outcome FROM approval_rounds WHERE document_id = $1`,
      [documentId],
    )
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)
    expect(roundRows.rows[0].outcome).toBe('pending')
  })

  it('§2-G3 负控 N3 (G6-1) — a document approved ENTIRELY by automation has no human seat: 409 CANCEL_ROUND_NO_ELIGIBLE_APPROVER (reason no_human_approver), never SEAT_INELIGIBLE/not_found, zero rows', async () => {
    const { documentId, requesterId } = await autoApprovedFixture('g6allauto', false)

    const service = new ApprovalProductService()
    let thrown: unknown
    try {
      await service.createCancelRoundInstance(documentId, { userId: requesterId })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeTruthy()
    const failure = thrown as { statusCode?: number; code?: string; message?: string; details?: Record<string, unknown> }
    // Lock §14.1 (lock:335 席位 = 原单的原审批人, N ≥ 1; lock:337 I″ 至少一个活动席位) — the
    // contract answer for "no seat can be resolved", reusing the code that already exists for it.
    expect(failure.statusCode).toBe(409)
    expect(failure.code).toBe('CANCEL_ROUND_NO_ELIGIBLE_APPROVER')
    expect(failure.details).toEqual({ reason: 'no_human_approver' })
    // Positively NOT the old answer: nobody is being asked to restore a non-existent account.
    expect(failure.code).not.toBe('CANCEL_ROUND_SEAT_INELIGIBLE')
    expect(String(failure.message)).not.toContain('restore')
    // And positively NOT the executor's generic 400 — this is the probe that proves the explicit
    // pre-check, not `APPROVAL_ASSIGNEE_EMPTY`, produced the answer (remove the pre-check and this
    // becomes 400 / APPROVAL_ASSIGNEE_EMPTY).
    expect(failure.statusCode).not.toBe(400)
    expect(failure.code).not.toBe('APPROVAL_ASSIGNEE_EMPTY')
    // Values-free: categories only, no person id, no sentinel id echoed back.
    expect(Object.keys(failure.details ?? {})).toEqual(['reason'])
    expect(JSON.stringify(failure.details)).not.toContain('system:')

    await expectZeroCancelRoundRows(documentId)
  })

  it('§2-G3 负控 N4 (G6-1) — dropping the sentinel must NOT drop humans with it: auto-approval + one DEACTIVATED human still blocks with SEAT_INELIGIBLE/inactive (not not_found, not a success)', async () => {
    const { documentId, requesterId, humanId } = await autoApprovedFixture('g6humkept', true)

    const deactivated = await pool().query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [humanId])
    expect(deactivated.rowCount).toBe(1)

    const service = new ApprovalProductService()
    // If the filter were widened from `system:`-namespace to "anything the directory dislikes", or
    // if it dropped every auto-approved node's approvers, this fixture would resolve to zero seats
    // and answer NO_ELIGIBLE_APPROVER — or worse, succeed with a partial 会签 roster. It must do
    // neither: the human is still a seat, and that seat is still re-qualified.
    await expect(service.createCancelRoundInstance(documentId, { userId: requesterId })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CANCEL_ROUND_SEAT_INELIGIBLE',
      details: { ineligibleCount: 1, reasons: ['inactive'] },
    })
    await expectZeroCancelRoundRows(documentId)

    // DISCRIMINATING CONTROL on the SAME document: reactivate and the identical call succeeds with
    // exactly one seat — so the rejection above was the seat predicate, not the sentinel drop
    // having eaten the roster.
    await pool().query(`UPDATE users SET is_active = TRUE WHERE id = $1`, [humanId])
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)
    const seatRows = await pool().query<{ assignee_id: string }>(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1`,
      [dto.id],
    )
    expect(seatRows.rows.map((row) => row.assignee_id)).toEqual([humanId])
    const roundRows = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE document_id = $1`, [
      documentId,
    ])
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)
  })

  it('§2-G3 (G6-4) — `activation_invalid` is unreachable BY CONSTRAINT, asserted against the live schema rather than claimed in a comment', async () => {
    // Gate round 6, G6-4: `CANCEL_ROUND_SEAT_INELIGIBILITY_REASONS` carries `activation_invalid`,
    // which `evaluateUserAuthenticationGate` only produces when `parseUserActivationStatus` rejects
    // the stored value. No test could construct it, and the exemption ("the CHECK constraint blocks
    // it") lived only in prose — the rotting-exemption shape this repo requires be turned into data.
    // So: read the constraint and the nullability LIVE. If either is relaxed, THIS goes red at
    // exactly the place where `activation_invalid` would start being reachable, and whoever relaxes
    // it has to decide what the seat gate should answer.
    const check = await pool().query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
        WHERE c.conrelid = 'users'::regclass
          AND c.conname = 'users_activation_status_check'`,
    )
    expect(check.rows.length, 'users_activation_status_check must exist').toBe(1)
    const definition = check.rows[0].definition
    // Value set pinned member-wise: a widened CHECK (a third value, or a `trim()`-tolerant one)
    // fails here instead of silently making a fourth reason category live.
    for (const allowed of ['pending_activation', 'activated']) {
      expect(definition, `CHECK must still allow ${allowed}`).toContain(allowed)
    }
    expect(
      definition.match(/'[^']+'::text/g)?.sort(),
      'CHECK must allow EXACTLY these two values',
    ).toEqual([`'activated'::text`, `'pending_activation'::text`])

    // NOT NULL is the other half: the seat gate reads `activation_status: string | null`, so a
    // nullable column would make `activation_invalid` reachable through NULL without touching the
    // CHECK at all.
    const nullable = await pool().query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'activation_status'`,
    )
    expect(nullable.rows.length).toBe(1)
    expect(nullable.rows[0].is_nullable).toBe('NO')

    // Behavioural closure of the two legs the CHECK is claimed to stop, run against the live DB
    // rather than reasoned from the migration source: a value outside the set, and a value that
    // `parseUserActivationStatus` would `trim()` into a legal one but the CHECK does not trim.
    const probeId = `wi4-g64-${TS}`
    await ensureLocalUserRow(probeId)
    mintedUserIds.add(probeId)
    for (const bogus of ['bogus', '', ' activated ']) {
      await expect(
        pool().query(`UPDATE users SET activation_status = $2 WHERE id = $1`, [probeId, bogus]),
        `activation_status = ${JSON.stringify(bogus)} must be refused by the CHECK`,
      ).rejects.toMatchObject({ code: '23514' })
    }
    await expect(
      pool().query(`UPDATE users SET activation_status = NULL WHERE id = $1`, [probeId]),
    ).rejects.toMatchObject({ code: '23502' })
    const survived = await pool().query<{ activation_status: string }>(
      `SELECT activation_status FROM users WHERE id = $1`,
      [probeId],
    )
    expect(survived.rows[0].activation_status).toBe('activated')
  })

  it('lock:143 负控 A — windowDays outside [0, suite ceiling] blocks creation (409 CANCEL_ROUND_WINDOW_OUT_OF_RANGE, zero rows); the SAME document at windowDays=0 succeeds', async () => {
    const { documentId, requesterId } = await coSignFixture('winrange')
    const service = new ApprovalProductService()

    // `leave`'s ceiling is 90 (lock:143). Each leg is a different way of being outside the domain.
    const outOfDomain = ['91', '-1', '90.5', '"90"']
    for (const literal of outOfDomain) {
      await pool().query(
        `UPDATE approval_instances SET metadata = metadata || ('{"windowDays":' || $2::text || '}')::jsonb WHERE id = $1`,
        [documentId, literal],
      )
      await expect(
        service.createCancelRoundInstance(documentId, { userId: requesterId }),
        `windowDays=${literal}`,
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CANCEL_ROUND_WINDOW_OUT_OF_RANGE',
        details: { suite: 'leave', ceiling: 90 },
      })
      await expectZeroCancelRoundRows(documentId)
    }

    // DISCRIMINATING CONTROL — same document, same call, only the number changes: the lower bound
    // of the domain is accepted. Without this the four rejections above could be caused by
    // anything about this fixture rather than by the range predicate.
    await pool().query(`UPDATE approval_instances SET metadata = metadata || '{"windowDays":0}'::jsonb WHERE id = $1`, [
      documentId,
    ])
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)
    const roundRows = await pool().query<{ id: string; policy_snapshot_at_create: Record<string, unknown> }>(
      `SELECT id, policy_snapshot_at_create FROM approval_rounds WHERE document_id = $1`,
      [documentId],
    )
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)
    expect(roundRows.rows[0].policy_snapshot_at_create.roundPolicy).toEqual({ suite: 'leave', windowDays: 0 })
  })

  it('lock:143 正控 B — windowDays = 90 (the leave ceiling, inclusive) is accepted and frozen verbatim into policy_snapshot_at_create', async () => {
    const { documentId, requesterId } = await coSignFixture('winceil')

    await pool().query(`UPDATE approval_instances SET metadata = metadata || '{"windowDays":90}'::jsonb WHERE id = $1`, [
      documentId,
    ])

    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)

    const roundRows = await pool().query<{ id: string; policy_snapshot_at_create: Record<string, unknown> }>(
      `SELECT id, policy_snapshot_at_create FROM approval_rounds WHERE document_id = $1`,
      [documentId],
    )
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)
    expect(roundRows.rows[0].policy_snapshot_at_create.roundPolicy).toEqual({ suite: 'leave', windowDays: 90 })
  })

  it('lock:143 正控 C — an out-of-domain suite tag ("Forbidden") is rejected (409 CANCEL_ROUND_SUITE_UNKNOWN, zero rows), not silently defaulted past the §14.3 #14 gate', async () => {
    const { documentId, requesterId } = await coSignFixture('suiteenum')

    // Verified reachable on the pre-fix code: capitalised `Forbidden` walked through the literal
    // `suite === 'forbidden'` comparison, created the round, and landed verbatim in
    // `policy_snapshot_at_create` (independent verification report, 2026-09-19, finding 2 §6).
    await pool().query(
      `UPDATE approval_instances SET metadata = metadata || '{"suite":"Forbidden","windowDays":36500}'::jsonb WHERE id = $1`,
      [documentId],
    )

    const service = new ApprovalProductService()
    await expect(service.createCancelRoundInstance(documentId, { userId: requesterId })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CANCEL_ROUND_SUITE_UNKNOWN',
      details: { allowedSuites: ['attendance', 'leave', 'other', 'forbidden'] },
    })
    await expectZeroCancelRoundRows(documentId)
  })

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Lock §2-G3 THIRD sentence (lock:74) 「历史委托不自动成为当前授权」 — READING (b): the delegatee D
  // keeps the seat ONLY IF that delegation is STILL live when the cancel round opens; otherwise the
  // seat returns to the delegator A.
  //
  // Independent verification 2026-09-19 (`verify-c1-lock-g3-delegation-20260919.md`) measured, on a
  // real DB, that before this change 有效 / 已撤销 / 已过期 / 已删除 produce a BYTE-IDENTICAL seat set
  // (`[D]`, 201) — today's seat derivation never reads the delegation at all. That "identical" IS the
  // defect, so a single 有效-delegation case would have ZERO discriminating power: all four states are
  // required, written as separate `it()`s so a partial regression names itself.
  //
  // The leg that separates (b) from reading (a) 「席位一律给 A」 is P4 below — (b) answers `[D]`, (a)
  // answers `[A]`. The leg that separates (b) from (a′) 「还原到 A 后再按今天的委托重解析」 is P9 —
  // (b) answers `[A]`, (a′) would answer `[E]`.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  type DelegationLegState = 'valid' | 'revoked' | 'expired' | 'scope_mismatch' | 'scope_match' | 'redelegated'

  /**
   * An approved original whose single approval node names A, but whose seat was substituted to D by
   * an active 'all'-scope delegation at create time — the ONLY way `metadata.delegatedFrom` is ever
   * written (`ApprovalAssigneeResolver.pushResolved`).
   *
   * 正控 §7-1 is inside this helper, not in the individual tests: delegation substitutes ONLY
   * `assignmentType === 'user'` seats, so a mis-shaped fixture would seat A directly and every
   * assertion in this group would then pass for the wrong reason (vacuously). The helper therefore
   * asserts the substitution REALLY happened — seat = D with `delegatedFrom = A` — and that the approve
   * record names D and never A, which is precisely why the seat query needs the assignments join.
   */
  async function delegatedApprovedOriginal(label: string): Promise<{
    documentId: string
    requesterId: string
    delegatorA: string
    delegateeD: string
    delegationId: string
    templateId: string
  }> {
    const suffix = `${label}-${TS}`
    const requesterId = `wi4-dreq-${suffix}`
    const delegatorA = `wi4-delA-${suffix}`
    const delegateeD = `wi4-delD-${suffix}`
    const adminId = `wi4-dadm-${suffix}`
    const delegationId = `wi4-deleg-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    // A never acts in this fixture, but MUST have a directory row: the seat gate (G3 first sentence)
    // reads `users` and an absent row is `not_found`, which would mask the seat-identity assertion
    // behind a 409 for an unrelated reason.
    await authToken(baseUrl, delegatorA)
    const tokenD = await authToken(baseUrl, delegateeD)

    // Active, in-window, 'all'-scope A → D at CREATE time. `createApproval` freezes the map into
    // `requester_snapshot.delegations` before the executor resolves the initial state.
    createdDelegationIds.add(delegationId)
    await pool().query(
      `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, start_at, end_at, active)
       VALUES ($1, $2, $3, 'all', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE)`,
      [delegationId, delegatorA, delegateeD],
    )

    // The NODE names A. Only the delegation turns the seat into D.
    const templateId = await publishOneNodeTemplate(adminToken, delegatorA, label)
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)

    const seatBefore = await pool().query<{
      assignee_id: string
      node_key: string | null
      delegated_from: string | null
    }>(
      `SELECT assignee_id, node_key, metadata->>'delegatedFrom' AS delegated_from
         FROM approval_assignments WHERE instance_id = $1`,
      [documentId],
    )
    expect(seatBefore.rows).toEqual([{ assignee_id: delegateeD, node_key: 'approval_a', delegated_from: delegatorA }])

    const approveResponse = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(approveResponse.status, await approveResponse.clone().text()).toBe(200)

    // The audit trail the seat query reads names D, and A appears in it nowhere — the provenance the
    // re-check depends on lives ONLY in `approval_assignments`.
    const records = await pool().query<{ actor_id: string; node_key: string | null }>(
      `SELECT actor_id, metadata->>'nodeKey' AS node_key
         FROM approval_records WHERE instance_id = $1 AND action = 'approve'`,
      [documentId],
    )
    expect(records.rows).toEqual([{ actor_id: delegateeD, node_key: 'approval_a' }])
    const allRecords = await pool().query<{ actor_id: string }>(
      `SELECT actor_id FROM approval_records WHERE instance_id = $1`,
      [documentId],
    )
    expect(allRecords.rows.some((row) => row.actor_id === delegatorA)).toBe(false)

    const status = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      documentId,
    ])
    expect(status.rows[0]?.status).toBe('approved')
    return { documentId, requesterId, delegatorA, delegateeD, delegationId, templateId }
  }

  /**
   * Moves the (already-used) delegation into the state the leg names. Exactly ONE predicate differs
   * per leg — a confounded mutation would make the resulting seat set unattributable.
   *
   * 跨组织 substitution, disclosed: `approval_delegations` has NO org dimension (`scope ∈ {all,
   * template}`); a per-org seat predicate is exactly half B of G3 (「仍在该组织单元」), which is OPEN
   * and owner-gated. The fourth leg is therefore SCOPE MISMATCH — a `scope='template'` row pointing at
   * a different template, i.e. the templateId-scope trap the verification report named — and not an
   * invented `user_orgs` fixture.
   */
  async function applyDelegationLeg(
    delegationId: string,
    leg: DelegationLegState,
    options: { redelegateTo?: string; scopeTemplateId?: string } = {},
  ): Promise<void> {
    if (leg === 'valid') return
    if (leg === 'scope_match') {
      // The DISCRIMINATING half of the scope pair: a `scope='template'` row pointing at the
      // ORIGINAL document's own template. `resolveActiveDelegationMap` matches it only when it is
      // given THAT template id, so this leg is the one that can tell a correct
      // `original.template_id` from any wrong-but-non-matching value (the cancel round's own
      // dedicated definition id, `''`, a typo) — all of which look identical on the mismatch leg.
      const scopeTemplateId = options.scopeTemplateId
      expect(scopeTemplateId, 'the scope_match leg needs the original template id').toBeTruthy()
      const matched = await pool().query(
        `UPDATE approval_delegations SET scope = 'template', scope_template_id = $2 WHERE id = $1`,
        [delegationId, scopeTemplateId],
      )
      expect(matched.rowCount, leg).toBe(1)
      return
    }
    if (leg === 'redelegated') {
      const target = options.redelegateTo
      expect(target, 'the redelegated leg needs a third person').toBeTruthy()
      const applied = await pool().query(
        `UPDATE approval_delegations SET delegatee_user_id = $2 WHERE id = $1`,
        [delegationId, target],
      )
      expect(applied.rowCount, leg).toBe(1)
      return
    }
    const statements: Record<'revoked' | 'expired' | 'scope_mismatch', { sql: string; params: unknown[] }> = {
      revoked: { sql: `UPDATE approval_delegations SET active = FALSE WHERE id = $1`, params: [delegationId] },
      expired: {
        sql: `UPDATE approval_delegations SET start_at = NOW() - INTERVAL '2 days', end_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
        params: [delegationId],
      },
      scope_mismatch: {
        // `chk_approval_delegations_scope_target`: scope='template' REQUIRES a target. The target is a
        // template this document was never created from, so `resolveActiveDelegationMap(templateId =
        // 原单模板)` cannot match it while the row stays `active` and in-window.
        sql: `UPDATE approval_delegations SET scope = 'template', scope_template_id = $2 WHERE id = $1`,
        params: [delegationId, '00000000-0000-4000-8000-0000000000aa'],
      },
    }
    const statement = statements[leg]
    const applied = await pool().query(statement.sql, statement.params)
    expect(applied.rowCount, leg).toBe(1)
  }

  /** Opens the cancel round for a delegated original in the named delegation state, returns its seats. */
  async function cancelRoundSeatsForLeg(
    label: string,
    leg: DelegationLegState,
    options: { redelegateTo?: string; scopeTemplateId?: string } = {},
  ): Promise<{
    seats: string[]
    delegatorA: string
    delegateeD: string
    documentId: string
    requesterId: string
    delegationId: string
    templateId: string
  }> {
    const fixture = await delegatedApprovedOriginal(label)
    await applyDelegationLeg(fixture.delegationId, leg, { scopeTemplateId: fixture.templateId, ...options })
    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(fixture.documentId, { userId: fixture.requesterId })
    createdApprovalIds.add(dto.id)
    const roundRows = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE document_id = $1`, [
      fixture.documentId,
    ])
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)
    const seatRows = await pool().query<{ assignee_id: string; is_active: boolean }>(
      `SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1 ORDER BY assignee_id`,
      [dto.id],
    )
    expect(seatRows.rows.every((row) => row.is_active)).toBe(true)
    return { seats: seatRows.rows.map((row) => row.assignee_id), ...fixture }
  }

  it('§2-G3 第三句 正控 P4(b) — 委托今天仍然有效:席位仍是被委托人 D(「不自动」读作「要重新核」,不是「一律不给」);这是与读法 (a) 唯一分歧的一腿', async () => {
    const { seats, delegateeD, delegatorA } = await cancelRoundSeatsForLeg('g3dlg-valid', 'valid')
    expect(seats).toEqual([delegateeD])
    expect(seats).not.toContain(delegatorA)
  })

  it('§2-G3 第三句 正控 P5(b) — 委托已撤销(active = FALSE):席位回到原审批人 A', async () => {
    const { seats, delegatorA, delegateeD } = await cancelRoundSeatsForLeg('g3dlg-revoked', 'revoked')
    expect(seats).toEqual([delegatorA])
    expect(seats).not.toContain(delegateeD)
  })

  it('§2-G3 第三句 正控 P6(b) — 委托窗口已过期(end_at 在过去):席位回到 A', async () => {
    const { seats, delegatorA, delegateeD } = await cancelRoundSeatsForLeg('g3dlg-expired', 'expired')
    expect(seats).toEqual([delegatorA])
    expect(seats).not.toContain(delegateeD)
  })

  it('§2-G3 第三句 正控 P7(b) — 委托作用域不覆盖本单模板(scope=template 指向别的模板;跨组织腿的替代物,见 applyDelegationLeg 文档):席位回到 A', async () => {
    const { seats, delegatorA, delegateeD } = await cancelRoundSeatsForLeg('g3dlg-scope', 'scope_mismatch')
    expect(seats).toEqual([delegatorA])
    expect(seats).not.toContain(delegateeD)
  })

  it('§2-G3 第三句 正控 P11(b) — 委托作用域正好覆盖本单模板(scope=template 指向原单自己的模板)且仍有效:席位是 D;这一腿是 templateId 作用域唯一有判别力的正控', async () => {
    // P7(b) 的绿对「传错了哪个 templateId」零判别力:任何不匹配的值都同样给出「回 A」。
    // 只有本腿能区分「传的是原单模板」与「传的是撤销轮自己的已发布定义 / 空串 / 打错的 id」——
    // 传错时本腿会变成 `[A]` 而红。
    const { seats, delegateeD, delegatorA } = await cancelRoundSeatsForLeg('g3dlg-scopehit', 'scope_match')
    expect(seats).toEqual([delegateeD])
    expect(seats).not.toContain(delegatorA)
  })

  it('§2-G3 第三句 正控 P9(b) — A 今天改委托给第三人 E:席位回到 A,既不是 D 也不是 E(判据是 map[A] === D,不是 map[A] 存在)', async () => {
    const thirdPersonE = `wi4-delE-g3dlg-third-${TS}`
    await authToken(baseUrl, thirdPersonE)
    const { seats, delegatorA, delegateeD } = await cancelRoundSeatsForLeg('g3dlg-third', 'redelegated', {
      redelegateTo: thirdPersonE,
    })
    expect(seats).toEqual([delegatorA])
    expect(seats).not.toContain(delegateeD)
    // The (a′) reading — restore, then re-resolve against today's map — would seat E here. This is the
    // assertion that keeps the two apart.
    expect(seats).not.toContain(thirdPersonE)
  })

  it('§2-G3 第三句 负控 N5(b) — 委托仍有效 ⇒ 席位是 D ⇒ 停权 D 阻断(409 SEAT_INELIGIBLE,零行);与今天同向,这一腿不是行为变化', async () => {
    const fixture = await delegatedApprovedOriginal('g3dlg-gateD')
    const deactivated = await pool().query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [fixture.delegateeD])
    expect(deactivated.rowCount).toBe(1)

    const service = new ApprovalProductService()
    let thrown: unknown
    try {
      await service.createCancelRoundInstance(fixture.documentId, { userId: fixture.requesterId })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeTruthy()
    const failure = thrown as { statusCode?: number; code?: string; message?: string; details?: Record<string, unknown> }
    expect(failure.statusCode).toBe(409)
    expect(failure.code).toBe('CANCEL_ROUND_SEAT_INELIGIBLE')
    expect(failure.details).toEqual({ ineligibleCount: 1, reasons: ['inactive'] })
    expect(JSON.stringify(failure.details)).not.toContain(fixture.delegateeD)
    expect(String(failure.message)).not.toContain(fixture.delegateeD)
    await expectZeroCancelRoundRows(fixture.documentId)
  })

  it('§2-G3 第三句 负控 N6(b) — 委托已撤销 ⇒ 席位是 A ⇒ 停权 A 阻断(409 SEAT_INELIGIBLE,零行);实测今天不阻断,资格闸人口跟着席位走', async () => {
    const fixture = await delegatedApprovedOriginal('g3dlg-gateAlapsed')
    await applyDelegationLeg(fixture.delegationId, 'revoked')
    const deactivated = await pool().query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [fixture.delegatorA])
    expect(deactivated.rowCount).toBe(1)

    const service = new ApprovalProductService()
    let thrown: unknown
    try {
      await service.createCancelRoundInstance(fixture.documentId, { userId: fixture.requesterId })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeTruthy()
    const failure = thrown as { statusCode?: number; code?: string; details?: Record<string, unknown> }
    expect(failure.statusCode).toBe(409)
    expect(failure.code).toBe('CANCEL_ROUND_SEAT_INELIGIBLE')
    expect(failure.details).toEqual({ ineligibleCount: 1, reasons: ['inactive'] })
    await expectZeroCancelRoundRows(fixture.documentId)
  })

  it('§2-G3 第三句 正控 P10(b) — 委托已撤销 + 停权 D:不再阻断,席位是 A(今天为 409;这一对与 N6(b) 一起钉住人口翻转的两个方向)', async () => {
    const fixture = await delegatedApprovedOriginal('g3dlg-lapsedD')
    await applyDelegationLeg(fixture.delegationId, 'revoked')
    const deactivated = await pool().query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [fixture.delegateeD])
    expect(deactivated.rowCount).toBe(1)

    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(fixture.documentId, { userId: fixture.requesterId })
    createdApprovalIds.add(dto.id)
    const roundRows = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE document_id = $1`, [
      fixture.documentId,
    ])
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)
    const seatRows = await pool().query<{ assignee_id: string }>(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1`,
      [dto.id],
    )
    expect(seatRows.rows.map((row) => row.assignee_id)).toEqual([fixture.delegatorA])
  })

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Lock §2-G3 第三句 —— 本轮(2026-09-20,读法 (b) 候选落地跑)在真库上补齐的四腿。
  //
  // 上一组(P4…P10)覆盖的是委托状态本身(有效/撤销/过期/作用域不匹配/作用域正好命中/改委托第三人)。
  // 本组补的是**候选补丁 README §6.2 点名、但补丁自己没写**的四条:哨兵 × 委托、零席位出口、
  // JOIN 的 node_key 合取(G-3)、以及 legacy 无 nodeKey 的已披露缺口(G-4)。
  // 每条的判别力(能不能区分「席位 = A」与「席位 = D」)在各自用例名里写明,零判别力的那条明说。
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /** `start -> approval_a -> approval_b -> end`:两个**顺序**审批节点,各一个受理人,single 模式。 */
  function sequentialTwoNodeGraph(firstApprover: string, secondApprover: string) {
    return {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'approval_a',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: [firstApprover], approvalMode: 'single' },
        },
        {
          key: 'approval_b',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: [secondApprover], approvalMode: 'single' },
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

  async function publishSequentialTwoNodeTemplate(
    adminToken: string,
    firstApprover: string,
    secondApprover: string,
    label: string,
  ): Promise<string> {
    const templateKey = `wi4-creation-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'WI-4 cancel-round creation fixture (two sequential nodes)',
        description: 'approval-cancel-round-creation.db.test.ts',
        formSchema: buildFormSchema(),
        approvalGraph: sequentialTwoNodeGraph(firstApprover, secondApprover),
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

  /** 插一条今天有效的 'all' 作用域 A → D 委托配置行,并登记进 afterAll 清理集合。 */
  async function insertActiveDelegation(delegationId: string, delegatorA: string, delegateeD: string): Promise<void> {
    createdDelegationIds.add(delegationId)
    await pool().query(
      `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, start_at, end_at, active)
       VALUES ($1, $2, $3, 'all', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE)`,
      [delegationId, delegatorA, delegateeD],
    )
  }

  it('§2-G3 第三句 正控 P12(b) — 哨兵 × 委托合成:自动审批哨兵行 + 被委托人 D 的人工审批行,委托已撤销 ⇒ 席位恰好 [A],哨兵既不入席也没把 A 一起丢掉(判别力:能区分 A 与 D,也能区分「哨兵被还原成人」)', async () => {
    const suffix = `g3dlg-sent-${TS}`
    const requesterId = `wi4-dsreq-${suffix}`
    const delegatorA = `wi4-dsdelA-${suffix}`
    const delegateeD = `wi4-dsdelD-${suffix}`
    const adminId = `wi4-dsadm-${suffix}`
    const delegationId = `wi4-dsdeleg-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    await authToken(baseUrl, delegatorA)
    const tokenD = await authToken(baseUrl, delegateeD)
    await insertActiveDelegation(delegationId, delegatorA, delegateeD)

    // 第一个节点由发起人自己自动审批(mergeWithRequester,写 `system:auto-approval` 的 approve 行),
    // 第二个节点点名 A —— 只有委托会把它换成 D。
    const templateId = await publishAutoApprovalTemplate(adminToken, requesterId, delegatorA, 'g3dlgsent')
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)

    // 正控先行:替换真的发生过(人工节点的席位是 D,provenance 是 A)。
    const seatBefore = await pool().query<{ assignee_id: string; node_key: string | null; delegated_from: string | null }>(
      `SELECT assignee_id, node_key, metadata->>'delegatedFrom' AS delegated_from
         FROM approval_assignments WHERE instance_id = $1 ORDER BY node_key`,
      [documentId],
    )
    expect(seatBefore.rows).toEqual([
      { assignee_id: delegateeD, node_key: 'approval_human', delegated_from: delegatorA },
    ])

    const approveResponse = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(approveResponse.status, await approveResponse.clone().text()).toBe(200)

    // 审计轨迹:哨兵 + D,A 一次不出现。
    const actors = await pool().query<{ actor_id: string }>(
      `SELECT DISTINCT actor_id FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY actor_id`,
      [documentId],
    )
    expect(actors.rows.map((row) => row.actor_id)).toEqual(['system:auto-approval', delegateeD].sort())

    await applyDelegationLeg(delegationId, 'revoked')

    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)
    const roundRows = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE document_id = $1`, [
      documentId,
    ])
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)

    const seatRows = await pool().query<{ assignee_id: string }>(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 ORDER BY assignee_id`,
      [dto.id],
    )
    const seats = seatRows.rows.map((row) => row.assignee_id)
    expect(seats).toEqual([delegatorA])
    expect(seats).not.toContain(delegateeD)
    expect(seats).not.toContain('system:auto-approval')
    const snapshot = await pool().query<{ requester_snapshot: Record<string, unknown> }>(
      `SELECT requester_snapshot FROM approval_instances WHERE id = $1`,
      [dto.id],
    )
    expect(JSON.stringify(snapshot.rows[0].requester_snapshot)).not.toContain('system:auto-approval')
  })

  it('§2-G3 第三句 负控 N7(b) — 零席位出口不被新增的委托 map 读改变:整单自动审批完成 + 配置表里有一条今天有效的 A→D 委托 ⇒ 仍是 409 CANCEL_ROUND_NO_ELIGIBLE_APPROVER / no_human_approver / 零行(判别力披露:本腿对席位谓词零判别力 —— 整单没有任何带 provenance 的 approve 行,`delegationMapNow` 的结果从不被消费;它钉的是「这条非 best-effort 的新读不得把零席位出口变成 500、也不得凭空造出席位」。席位侧的 oracle 是既有的 负控 N3)', async () => {
    const { documentId, requesterId } = await autoApprovedFixture('g3dlgzero', false)
    const delegationId = `wi4-dzdeleg-g3dlgzero-${TS}`
    await insertActiveDelegation(delegationId, `wi4-dzA-g3dlgzero-${TS}`, `wi4-dzD-g3dlgzero-${TS}`)

    const service = new ApprovalProductService()
    let thrown: unknown
    try {
      await service.createCancelRoundInstance(documentId, { userId: requesterId })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeTruthy()
    const failure = thrown as { statusCode?: number; code?: string; details?: Record<string, unknown> }
    expect(failure.statusCode).toBe(409)
    expect(failure.code).toBe('CANCEL_ROUND_NO_ELIGIBLE_APPROVER')
    expect(failure.details).toEqual({ reason: 'no_human_approver' })
    // 正控:不是 500,也不是 map 读炸出来的原生错误。
    expect(failure.statusCode).not.toBe(500)
    await expectZeroCancelRoundRows(documentId)
  })

  it('§2-G3 第三句 正控 P14(b) / 候选 README 门审 G-3 —— JOIN 的 node_key 合取(该合取在 2026-09-19 的独立验证里未被覆盖):D 在节点 1 是 A 的代理、在节点 2 有**自己的**席位,委托已撤销 ⇒ 席位 = {A, D} 两人。去掉 `a.node_key = r.metadata->>nodeKey` 这条合取,两行 approve 都会匹配到节点 1 那条 provenance,DISTINCT 后塌成 {A} 一人而红', async () => {
    const suffix = `g3dlg-sib-${TS}`
    const requesterId = `wi4-dbreq-${suffix}`
    const delegatorA = `wi4-dbdelA-${suffix}`
    const delegateeD = `wi4-dbdelD-${suffix}`
    const adminId = `wi4-dbadm-${suffix}`
    const delegationId = `wi4-dbdeleg-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    await authToken(baseUrl, delegatorA)
    const tokenD = await authToken(baseUrl, delegateeD)
    await insertActiveDelegation(delegationId, delegatorA, delegateeD)

    // 节点 1 点名 A(委托把它换成 D),节点 2 直接点名 D(委托 map 里没有 D 这个键,不替换)。
    const templateId = await publishSequentialTwoNodeTemplate(adminToken, delegatorA, delegateeD, 'g3dlgsib')
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)

    for (const nodeKey of ['approval_a', 'approval_b']) {
      const approveResponse = await jsonRequest(baseUrl, `/api/approvals/${documentId}/actions`, tokenD, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(approveResponse.status, `${nodeKey}: ${await approveResponse.clone().text()}`).toBe(200)
    }

    // 夹具形状正控(建议 3):两条 approve 行都由 D 写、nodeKey 互不相同,且**只有**节点 1 那条
    // assignment 带 delegatedFrom —— 否则本腿会因为别的原因红/绿,归因不了 node_key 合取。
    const records = await pool().query<{ actor_id: string; node_key: string | null }>(
      `SELECT actor_id, metadata->>'nodeKey' AS node_key
         FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY node_key`,
      [documentId],
    )
    expect(records.rows).toEqual([
      { actor_id: delegateeD, node_key: 'approval_a' },
      { actor_id: delegateeD, node_key: 'approval_b' },
    ])
    const assignments = await pool().query<{ node_key: string | null; assignee_id: string; delegated_from: string | null }>(
      `SELECT node_key, assignee_id, metadata->>'delegatedFrom' AS delegated_from
         FROM approval_assignments WHERE instance_id = $1 ORDER BY node_key`,
      [documentId],
    )
    expect(assignments.rows).toEqual([
      { node_key: 'approval_a', assignee_id: delegateeD, delegated_from: delegatorA },
      { node_key: 'approval_b', assignee_id: delegateeD, delegated_from: null },
    ])
    const status = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      documentId,
    ])
    expect(status.rows[0]?.status).toBe('approved')

    await applyDelegationLeg(delegationId, 'revoked')

    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)
    const roundRows = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE document_id = $1`, [
      documentId,
    ])
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)

    const seatRows = await pool().query<{ assignee_id: string }>(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 ORDER BY assignee_id`,
      [dto.id],
    )
    // D 自己那份席位必须留给 D;只有节点 1 那份代理席位回到 A。
    expect(seatRows.rows.map((row) => row.assignee_id)).toEqual([delegatorA, delegateeD].sort())
  })

  it('§2-G3 第三句 正控 P15(b) / 候选 README 门审 G-4 —— 已披露缺口写成数据:legacy `POST /api/approvals/:id/approve` 把请求体的 metadata 逐字落库,写出的 approve 行没有 nodeKey ⇒ LEFT JOIN 落空 ⇒ 没有 provenance ⇒ actor D 保住席位**不被重核**,即使委托今天已撤销。这是本候选**没有解决**的那条腿(失败方向 = 今天的行为,不是更宽的席位),不是注释里的声明', async () => {
    const suffix = `g3dlg-legacy-${TS}`
    const requesterId = `wi4-dlreq-${suffix}`
    const delegatorA = `wi4-dldelA-${suffix}`
    const delegateeD = `wi4-dldelD-${suffix}`
    const adminId = `wi4-dladm-${suffix}`
    const delegationId = `wi4-dldeleg-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    await authToken(baseUrl, delegatorA)
    const tokenD = await authToken(baseUrl, delegateeD)
    await insertActiveDelegation(delegationId, delegatorA, delegateeD)

    const templateId = await publishOneNodeTemplate(adminToken, delegatorA, 'g3dlglegacy')
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const documentId = ((await create.json()) as { id: string }).id
    createdApprovalIds.add(documentId)

    const seatBefore = await pool().query<{ assignee_id: string; node_key: string | null; delegated_from: string | null }>(
      `SELECT assignee_id, node_key, metadata->>'delegatedFrom' AS delegated_from
         FROM approval_assignments WHERE instance_id = $1`,
      [documentId],
    )
    expect(seatBefore.rows).toEqual([{ assignee_id: delegateeD, node_key: 'approval_a', delegated_from: delegatorA }])

    // **真的**走 legacy 端点,不是手工 UPDATE 一行 metadata —— 缺口的来源必须是生产写入方本身。
    const versionRow = await pool().query<{ version: number }>(
      `SELECT version FROM approval_instances WHERE id = $1`,
      [documentId],
    )
    const legacyApprove = await jsonRequest(baseUrl, `/api/approvals/${documentId}/approve`, tokenD, {
      method: 'POST',
      body: { version: versionRow.rows[0].version },
    })
    expect(legacyApprove.status, await legacyApprove.clone().text()).toBe(200)

    // 这一行就是缺口的载体:actor = D,metadata 里没有 nodeKey。
    const records = await pool().query<{ actor_id: string; node_key: string | null }>(
      `SELECT actor_id, metadata->>'nodeKey' AS node_key
         FROM approval_records WHERE instance_id = $1 AND action = 'approve'`,
      [documentId],
    )
    expect(records.rows).toEqual([{ actor_id: delegateeD, node_key: null }])
    const status = await pool().query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [
      documentId,
    ])
    expect(status.rows[0]?.status).toBe('approved')

    await applyDelegationLeg(delegationId, 'revoked')

    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)
    const roundRows = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE document_id = $1`, [
      documentId,
    ])
    expect(roundRows.rows.length).toBe(1)
    createdRoundIds.add(roundRows.rows[0].id)

    const seatRows = await pool().query<{ assignee_id: string }>(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 ORDER BY assignee_id`,
      [dto.id],
    )
    // 实测值。委托已撤销,P5(b) 在同样的委托状态下给 [A];本腿给 [D],差别只在这条 approve 行
    // 的 metadata 有没有 nodeKey —— 缺口的边界就是这一格。
    expect(seatRows.rows.map((row) => row.assignee_id)).toEqual([delegateeD])
  })
})
